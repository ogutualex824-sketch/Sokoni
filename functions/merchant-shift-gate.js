'use strict';
/* ================================================================
   SOKONI — Merchant V2 shift access policy
   functions/merchant-shift-gate.js

   WHY THIS IS NOT INSIDE resolveActor()
   resolveActor is the shared merchant IDENTITY primitive. It is called by the
   merchantIdentity callable, employeeSaleAuthorize, merchant-inventory's
   transactional writes, pos-retail-engine and pos-zero-friction's sale path.
   Putting a temporal gate inside it would make every POS sale and inventory
   write shift-bound: a cashier one minute past their shift end would not merely
   lose the Merchant V2 shell, the till would refuse to finish a sale with a
   customer standing there. That is the precise outcome the 30-minute closeout
   exists to prevent, and it is a money-path change nobody asked for.

   So this is an ACCESS POLICY, applied only at the Merchant V2 entry point, on
   top of an identity that has already been resolved. Identity answers "who are
   you here"; this answers "may you work right now". They are different
   questions and they stay in different files.

   OPT-IN, AND FAIL-OPEN FOR THE FEATURE. Enforcement requires BOTH an explicit
   boolean true and a timezone the runtime can actually resolve. A missing flag,
   a truthy-but-not-true value, a missing or unresolvable timezone — every one of
   those means today's behaviour, unchanged. A half-configured shop must not
   discover its configuration by locking its staff out.
================================================================ */

const admin = require('firebase-admin');
/* `admin.apps` is always an array in a real runtime, but the certification harness stubs
   firebase-admin and its stub has none — so `.length` threw here at MODULE LOAD, before
   this file finished being required. Anything pulling in merchant-identity.js died with
   it, which took out test-sale-authority (34/0 at 2a23cdb) and test-pos-financial-trace
   (20/0) — the two suites that would catch a settlement regression. A load-time crash is
   the worst kind: it is reported as a harness fault rather than as a failing check, so it
   reads like broken tooling instead of untested money code. */
/* Wrapped rather than removed. merchant-identity.js — which loads fine under the harness —
   requires admin and never initialises at load, relying on its db() accessor being lazy;
   this file's db() is lazy too, so the call is belt-and-braces in production and absent
   entirely under a stub. Deleting it outright would change production initialisation order
   in someone else's module, so the call is kept and its failure made non-fatal: in a real
   runtime nothing here throws, and under the harness the module now finishes loading. */
if (!admin.apps || !admin.apps.length) {
  try { admin.initializeApp(); } catch (_) { /* stubbed admin: db() initialises lazily */ }
}
const db = () => admin.firestore();

/* The time authority lives in the scheduler and is not duplicated here. */
const { isValidTimezone, isShiftActive, localDateKey } = require('./pos-shift-scheduler')._internal;

const ROSTERS = 'posRosters';

/** Is shift enforcement actually active for this shop? Both conditions or neither. */
function enforcementActive (shop) {
  const s = shop || {};
  /* Exact boolean. 'true' and 1 are configuration mistakes, not consent. */
  if (s.shiftEnforcement !== true) return { active: false, reason: 'flag-off' };
  if (!isValidTimezone(s.timezone)) return { active: false, reason: 'no-valid-timezone' };
  return { active: true, timezone: s.timezone };
}

/** The previous local calendar date, as YYYY-MM-DD. */
function previousDate (dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/**
 * May this caller use Merchant V2 right now?
 *
 * @param {object}  actor   the ALREADY-RESOLVED identity from resolveActor
 * @param {object}  shop    the shops/{shopId} document
 * @param {string}  uid     the authenticated uid
 * @param {number} [now]    explicit for tests; never an ambient clock in a decision
 * @returns {Promise<{allow:boolean, reason:string}>}
 */
async function evaluateShiftAccess ({ actor, shop, uid, now }) {
  const enf = enforcementActive(shop);

  /* FAST PATH. Enforcement off means no roster read at all — this gate sits on
     the Merchant V2 authority path and must cost nothing for the shops that have
     not opted in, which today is every shop. */
  if (!enf.active) return { allow: true, reason: 'enforcement-off:' + enf.reason };

  /* THE OWNER IS NOT AN EMPLOYEE. Their authority comes from owning the shop, so
     it cannot be scheduled away — and it is what stops a shop locking itself out
     entirely when a roster is missing. Resolved from the identity already
     established, never from a roster and never from a field the caller sent. */
  const OWNER_SOURCE = 'shop-owner';        /* resolveActor's own marker — verified, not guessed */
  if (actor && actor.source === OWNER_SOURCE) return { allow: true, reason: 'owner' };

  const tz = enf.timezone;
  const t = (typeof now === 'number') ? now : Date.now();
  const today = localDateKey(t, tz);
  const yesterday = previousDate(today);

  /* THE ROSTER TENANT IS THE SHOP'S OWN sellerUid, never a client-supplied id and
     never an assumption that shopId === sellerId. resolveActor already proved
     this caller belongs to this shop; the shop document names its seller. */
  const sellerId = String((shop && (shop.sellerUid || shop.ownerId || shop.ownerUid)) || '').trim();
  if (!sellerId) return { allow: false, reason: 'shop-has-no-seller-identity' };

  /* BOUNDED. The two most recent rosters at or before today — never a scan of a
     seller's history, and never "all rosters". Two is enough: a shift can only
     belong to today or, if it began before midnight, to yesterday. Ordering by
     weekStartDate rather than computing a week boundary avoids assuming which
     day a week starts on. */
  let snap;
  try {
    snap = await db().collection(ROSTERS)
      .where('sellerId', '==', sellerId)
      .where('weekStartDate', '<=', today)
      .orderBy('weekStartDate', 'desc')
      .limit(2)
      .get();
  } catch (e) {
    /* A failed read is not permission. Deny, and say why. */
    return { allow: false, reason: 'roster-lookup-failed' };
  }

  if (snap.empty) return { allow: false, reason: 'no-roster' };

  const relevant = [today, yesterday];
  for (const doc of snap.docs) {
    const r = doc.data() || {};
    /* Corroborate the tenant on the document itself. The query filtered on it,
       but reading it back costs nothing and means a mis-shaped index can never
       hand this caller another seller's roster. */
    if (String(r.sellerId || '') !== sellerId) continue;

    for (const slot of (r.slots || [])) {
      if (!slot || relevant.indexOf(String(slot.date)) === -1) continue;

      /* The slot must name THIS caller. Another employee being on shift is not
         authorization, and neither is the shop merely being open. */
      const mine = ((slot.assignedStaff) || []).some((a) => a && a.uid === uid);
      if (!mine) continue;

      const active = isShiftActive({
        shiftDate: slot.date,
        startTime: slot.startTime,
        endTime: slot.endTime,
        timezone: tz,
        now: t,
      });
      /* ANY assigned active slot is enough — a split shift is still a shift. */
      if (active.active) return { allow: true, reason: 'on-shift' };
    }
  }

  return { allow: false, reason: 'off-shift' };
}

/* ════════════════════════════════════════════════════════════════════════════
   IS THIS SHOP READY TO BE ENFORCED?

   The predicate lives HERE, beside the gate that consumes it, and reads the
   roster with the SAME query and the same window. That is the whole point: a
   readiness check written anywhere else would be a second opinion about what a
   usable roster is, and the two would drift. "Usable" is defined as exactly the
   conditions under which evaluateShiftAccess above can return allow for somebody
   who is not the owner.

   WHAT IT CANNOT PROMISE. This answers "would turning enforcement on right now
   lock out everybody who is not the owner". It is a point-in-time answer.
   Enabling on a Monday whose roster is staffed says nothing about Tuesday — a
   shop that stops publishing rosters will still lock its staff out, and no check
   at activation time can prevent that. Stated rather than implied, because a
   check that reads as a guarantee is worse than no check.
════════════════════════════════════════════════════════════════════════════ */
async function evaluateRosterReadiness ({ shop, now }) {
  const s = shop || {};
  /* Same two conditions enforcementActive requires — a shop with no resolvable
     timezone would take the flag and enforce nothing, which is a switch that
     lies rather than a switch that works. */
  if (!isValidTimezone(s.timezone)) return { ready: false, reason: 'no-valid-timezone' };

  const sellerId = String((s.sellerUid || s.ownerId || s.ownerUid) || '').trim();
  if (!sellerId) return { ready: false, reason: 'shop-has-no-seller-identity' };

  const tz = s.timezone;
  const t = (typeof now === 'number') ? now : Date.now();
  const today = localDateKey(t, tz);
  const yesterday = previousDate(today);

  let snap;
  try {
    snap = await db().collection(ROSTERS)
      .where('sellerId', '==', sellerId)
      .where('weekStartDate', '<=', today)
      .orderBy('weekStartDate', 'desc')
      .limit(2)
      .get();
  } catch (e) {
    /* A failed read is not readiness, exactly as it is not permission. */
    return { ready: false, reason: 'roster-lookup-failed' };
  }
  if (snap.empty) return { ready: false, reason: 'no-roster' };

  const relevant = [today, yesterday];
  let slots = 0, assigned = 0;
  for (const doc of snap.docs) {
    const r = doc.data() || {};
    if (String(r.sellerId || '') !== sellerId) continue;   /* corroborate, as the gate does */
    for (const slot of (r.slots || [])) {
      if (!slot || relevant.indexOf(String(slot.date)) === -1) continue;
      slots++;
      assigned += ((slot.assignedStaff) || []).filter((a) => a && a.uid).length;
    }
  }
  /* A roster that exists but covers no part of the current window denies every
     employee the moment enforcement starts. So does one whose slots are empty. */
  if (!slots) return { ready: false, reason: 'no-shift-in-the-current-window' };
  if (!assigned) return { ready: false, reason: 'no-one-assigned-in-the-current-window' };

  return { ready: true, reason: null, sellerId, today, slots, assigned };
}

/* ════════════════════════════════════════════════════════════════════════════
   setShiftEnforcement — the ONLY way this flag may change.

   A Firestore rule cannot answer "does a usable roster exist": that is a query
   across another collection, and rules cannot make it. So the check has to live
   in a callable — and a callable is only an authority if the rules stop clients
   writing the field directly. This is one half of a pair; without the rules lock
   it is a recommendation, not a control.

   OWNER OR ADMIN ONLY, and deliberately NOT a manager. A manager schedules; this
   changes whether the shop enforces schedules at all, for everybody, which is
   the same class of decision as removing somebody's access — and that is
   owner-only too. Disabling follows the same boundary.

   TURNING IT OFF IS ALWAYS ALLOWED. The readiness check guards the transition
   that can lock people out; making the escape from that state conditional on a
   roster would be exactly backwards.
════════════════════════════════════════════════════════════════════════════ */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { resolveShopAccess } = require('./shop-employees');

const setShiftEnforcement = onCall(
  { region: 'us-central1', maxInstances: 10, memory: '256MiB', timeoutSeconds: 20, enforceAppCheck: true },
  async (req) => {
    const uid = req.auth && req.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

    const d = req.data || {};
    const shopId = String(d.shopId || '').trim();
    if (!shopId) throw new HttpsError('invalid-argument', 'shopId is required.');
    /* Exact booleans, for the same reason enforcementActive demands one: a
       truthy value is a mistake, not consent. */
    if (d.enabled !== true && d.enabled !== false) {
      throw new HttpsError('invalid-argument', 'enabled must be true or false.');
    }
    const enabled = d.enabled;

    /* THE corroborated resolver. Note what is NOT read: any sellerId the caller
       sent. The tenant is whatever the shop document says it is. */
    const access = await resolveShopAccess(uid, shopId);
    if (access.via !== 'owner' && access.via !== 'admin') {
      throw new HttpsError('permission-denied', 'Only the shop owner can change shift enforcement.');
    }

    const ref = db().collection('shops').doc(shopId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Shop not found.');
    const shop = snap.data() || {};

    let readiness = null;
    if (enabled === true) {
      readiness = await evaluateRosterReadiness({ shop, now: d.now });
      if (!readiness.ready) {
        /* The reason is returned because the operator has to be able to fix it —
           "no-one-assigned-in-the-current-window" and "no-valid-timezone" need
           different actions, and a generic refusal would send them hunting. */
        throw new HttpsError('failed-precondition', 'shift-enforcement-not-ready:' + readiness.reason);
      }
    }

    await ref.set({
      shiftEnforcement: enabled,
      shiftEnforcementSetBy: uid,
      shiftEnforcementSetAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return { shopId, enabled, sellerId: access.shopOwnerId || null, readiness };
  }
);

/* module.exports is REBOUND here, so anything attached to `exports.` above this
   line would be orphaned — the defect that left three POS callables undeployed.
   Everything public goes in this object. */
module.exports = {
  evaluateShiftAccess,
  enforcementActive,
  evaluateRosterReadiness,
  setShiftEnforcement,
  _internal: { previousDate },
};
