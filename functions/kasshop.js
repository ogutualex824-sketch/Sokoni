/* ================================================================
   SOKONI KassShop — the canonical seller/shop boundary
   Firebase Cloud Functions — Gen 2, Node 22

     getShopProfile        — the caller's own shop, for KassShop Management
     saveShopProfile       — create-or-update the canonical shop  (onCall)
     setShopAvailability   — live state: accepting orders / online / delivery / pickup
     getShopAvailability   — the EFFECTIVE state (live + schedule + override)

   WHY THIS EXISTS AS A SERVER BOUNDARY
   ------------------------------------
   `firestore.rules` authorises `/shops/{uid}` by DOCUMENT ID:

       allow create: if isAdmin();
       allow update: if isAdmin() || (isAuthed() && request.auth.uid == uid && …hasOnly([…]))

   so a client can only ever write `shops/{its-own-uid}`, can never create a shop, and cannot
   write the availability fields at all — they are not in the permitted key list. A seller whose
   canonical shop is `shops/shop-A` with `sellerUid: A` therefore could not write to their own
   shop from the browser.

   That is why Shop Setup ended up writing `sellers/{uid}` + `businesses/{uid}` and reading
   `localStorage.sokoniStore`, and why the storefront drifted away from it: the canonical
   document was never writable. Rather than widen the rules, ownership is enforced here, the
   same way every other money- and identity-critical path in SOKONI already does it:

       Auth → sellerUid ownership assertion → canonical shops/{shopId}

   Ownership is ALWAYS `shops/{shopId}.sellerUid === request.auth.uid`. Never `shopId === uid`.

   AVAILABILITY IS TWO CONCEPTS, DELIBERATELY NOT MERGED
   -----------------------------------------------------
     live state  shops/{shopId}            acceptingOrders / online / delivery / pickup
     schedule    providerAvailability/{uid} opening hours, closures, date overrides

   A seller who flips "offline" means it right now, whatever the timetable says. A timetable
   says what happens when nobody is flipping switches. Collapsing them loses one or the other,
   so both are kept and an EFFECTIVE state is derived:

       effective = live AND schedule, with a same-day override winning outright

   The public storefront reads the effective result, so flipping the shop offline is visible to
   buyers immediately.
================================================================ */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const logger = require('firebase-functions/logger');

const REGION = 'us-central1';
const _db = () => getFirestore();

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function _requireAuth(request) {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Login required.');
  return request.auth.uid;
}

/** Strip tags, trim, truncate. Non-strings become ''. */
function _san(s, max = 500) {
  if (typeof s !== 'string') return '';
  return s.replace(/<[^>]*>/g, '').trim().slice(0, max);
}

/**
 * The one ownership question: which shop does this uid own?
 * Returns { id, data } or null. Never consults a document id, a cached shop, or a handle.
 * Legacy owner fields are accepted only because older shop documents predate `sellerUid` —
 * each is still scoped BY UID, so none of them can return another seller's shop.
 */
async function _ownedShop(uid) {
  const db = _db();
  for (const field of ['sellerUid', 'ownerUid', 'ownerId']) {
    const snap = await db.collection('shops').where(field, '==', uid).limit(2).get();
    if (snap.empty) continue;
    if (snap.size > 1) {
      logger.warn('KassShop: uid owns multiple shops', { field, count: snap.size });
    }
    /* Deterministic when several match — never "whichever came back first". */
    const docs = snap.docs.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { id: docs[0].id, data: docs[0].data() || {} };
  }
  return null;
}

/* Profile fields a seller may set. Anything not listed here cannot be written through this
   boundary — status, verification, commission, ratings and counters are all owned elsewhere. */
const TEXT_FIELDS = {
  name: 120, storeName: 120, tagline: 160, about: 2000, description: 2000, bio: 2000,
  phone: 32, email: 160, website: 200, address: 300, city: 80, mapsLink: 400,
  instagram: 120, tiktok: 120, facebook: 120, twitter: 120, youtube: 120, linkedin: 120,
  logo: 600, logoUrl: 600, banner: 600, bannerUrl: 600, themeColor: 32,
  category: 80, shopType: 24, delMethod: 40, delTime: 60,
  returnPolicy: 40, returnText: 1000, packagingNote: 500, freeDelivery: 60,
};
const AVAILABILITY_FIELDS = ['acceptingOrders', 'online', 'delivery', 'pickup'];

/** Whitelist + sanitise an incoming profile patch. Absent keys are left untouched. */
function _cleanProfile(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, max] of Object.entries(TEXT_FIELDS)) {
    if (key in raw) out[key] = _san(raw[key], max);
  }
  /* Opening hours: a plain map of day → { closed, periods[] }. Shape-checked, not trusted. */
  if (raw.openingHours && typeof raw.openingHours === 'object' && !Array.isArray(raw.openingHours)) {
    const hours = {};
    for (const day of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
      const cfg = raw.openingHours[day];
      if (!cfg || typeof cfg !== 'object') continue;
      const periods = Array.isArray(cfg.periods) ? cfg.periods.slice(0, 6).map((p) => ({
        open: _san(p && p.open, 5), close: _san(p && p.close, 5),
      })).filter((p) => p.open && p.close) : [];
      hours[day] = { closed: !!cfg.closed, periods };
    }
    if (Object.keys(hours).length) out.openingHours = hours;
  }
  if (Array.isArray(raw.zones)) out.zones = raw.zones.slice(0, 40).map((z) => _san(z, 80)).filter(Boolean);
  return out;
}

/* ================================================================
   1. getShopProfile — load KassShop Management from the canonical document
================================================================ */
exports.getShopProfile = onCall(
  { region: REGION, cors: true },
  async (request) => {
    const uid = _requireAuth(request);
    const owned = await _ownedShop(uid);

    /* "No shop" is a real, reportable answer — never an error, and never an empty form that
       looks identical to a slow read. The client distinguishes exists:false from a failure. */
    if (!owned) {
      return { exists: false, shopId: null, ownerUid: null, profile: null, availability: null, handle: null };
    }

    const db = _db();
    const [cfgSnap, schedSnap] = await Promise.all([
      db.collection('minishopConfig').doc(owned.id).get(),
      db.collection('providerAvailability').doc(uid).get(),
    ]);
    const cfg = cfgSnap.exists ? cfgSnap.data() : {};

    const profile = {};
    for (const key of Object.keys(TEXT_FIELDS)) {
      if (owned.data[key] !== undefined) profile[key] = owned.data[key];
    }
    if (owned.data.openingHours) profile.openingHours = owned.data.openingHours;
    if (owned.data.zones) profile.zones = owned.data.zones;

    const availability = {};
    for (const key of AVAILABILITY_FIELDS) {
      availability[key] = owned.data[key] !== undefined ? !!owned.data[key] : true;
    }

    return {
      exists: true,
      shopId: owned.id,
      ownerUid: uid,
      profile,
      availability,
      schedule: schedSnap.exists ? (schedSnap.data() || null) : null,
      handle: cfg.handle || owned.data.minishopHandle || null,
      storefrontUrl: cfg.handle ? `/shop/${encodeURIComponent(cfg.handle)}` : null,
    };
  }
);

/* ================================================================
   2. saveShopProfile — create on first setup, update thereafter
================================================================ */
exports.saveShopProfile = onCall(
  { region: REGION, cors: true },
  async (request) => {
    const uid = _requireAuth(request);
    const patch = _cleanProfile((request.data || {}).profile);

    if (!Object.keys(patch).length) {
      throw new HttpsError('invalid-argument', 'Nothing to save.');
    }
    /* A shop needs a name to exist. Enforced here rather than in the form, because the form is
       not the authority on what a valid shop is. */
    const owned = await _ownedShop(uid);
    const name = patch.name || patch.storeName || (owned && (owned.data.name || owned.data.storeName));
    if (!name) throw new HttpsError('invalid-argument', 'A shop name is required.');

    const db = _db();
    const now = FieldValue.serverTimestamp();

    if (owned) {
      /* UPDATE. _ownedShop already proved ownership; re-assert inside the write so a shop that
         changed hands between the read and the write cannot be overwritten. */
      const ref = db.collection('shops').doc(owned.id);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw new HttpsError('not-found', 'Shop not found.');
        const d = snap.data() || {};
        if (!(d.sellerUid === uid || d.ownerUid === uid || d.ownerId === uid)) {
          throw new HttpsError('permission-denied', 'You do not own this shop.');
        }
        /* Backfill the canonical owner field on a legacy document, so the next read resolves
           through sellerUid like everything else. */
        const write = Object.assign({}, patch, { sellerUid: uid, updatedAt: now });
        tx.set(ref, write, { merge: true });
      });
      logger.info('KassShop profile updated', { shopId: owned.id, fields: Object.keys(patch).length });
      return { success: true, created: false, shopId: owned.id, ownerUid: uid };
    }

    /* CREATE — first-time setup. Exactly one shop per seller: the ownership query above found
       none, and the transaction re-checks before committing so two concurrent first saves
       cannot mint two shops. */
    const ref = db.collection('shops').doc();
    await db.runTransaction(async (tx) => {
      const dupe = await tx.get(db.collection('shops').where('sellerUid', '==', uid).limit(1));
      if (!dupe.empty) {
        /* Someone else's request created it first — fold into that shop rather than adding one. */
        const existing = dupe.docs[0];
        tx.set(existing.ref, Object.assign({}, patch, { sellerUid: uid, updatedAt: now }), { merge: true });
        return;
      }
      tx.set(ref, Object.assign({}, patch, {
        sellerUid: uid,
        name: name,
        status: 'active',
        isVisible: true,
        createdAt: now,
        updatedAt: now,
      }));
    });

    /* Re-resolve rather than assume: if the transaction folded into a concurrently-created
       shop, `ref.id` is not the seller's shop and returning it would be a lie. */
    const settled = await _ownedShop(uid);
    logger.info('KassShop created', { shopId: settled ? settled.id : ref.id });
    return { success: true, created: true, shopId: settled ? settled.id : ref.id, ownerUid: uid };
  }
);

/* ================================================================
   3. setShopAvailability — the LIVE state
================================================================ */
exports.setShopAvailability = onCall(
  { region: REGION, cors: true },
  async (request) => {
    const uid = _requireAuth(request);
    const raw = (request.data || {}).availability || request.data || {};

    const patch = {};
    for (const key of AVAILABILITY_FIELDS) {
      if (key in raw) patch[key] = !!raw[key];
    }
    if (!Object.keys(patch).length) {
      throw new HttpsError('invalid-argument', 'No availability fields supplied.');
    }

    const owned = await _ownedShop(uid);
    /* Refuse rather than invent. A toggle with nothing to toggle is an error; creating a shop
       as a side effect of flipping a switch is how stray documents appear. */
    if (!owned) throw new HttpsError('not-found', 'No shop found for your account.');

    await _db().collection('shops').doc(owned.id)
      .set(Object.assign({}, patch, { sellerUid: uid, updatedAt: FieldValue.serverTimestamp() }), { merge: true });

    logger.info('KassShop availability set', { shopId: owned.id });
    return { success: true, shopId: owned.id, availability: patch };
  }
);

/* ================================================================
   4. Effective availability — live + schedule + override
================================================================ */

const _DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Combine the live state with the schedule.
 *
 *   · An explicit date override wins outright — it exists precisely to contradict the timetable.
 *   · Otherwise the shop is open only if the live state says so AND the timetable agrees.
 *
 * `at` is milliseconds; `tzOffsetMin` shifts UTC to the shop's local clock (Kenya = +180).
 * Returns the decision AND the reason, because "closed" with no reason is unactionable for the
 * seller and unexplainable to the buyer.
 */
function computeEffectiveAvailability(live, schedule, at, tzOffsetMin) {
  const state = {
    acceptingOrders: live && live.acceptingOrders !== undefined ? !!live.acceptingOrders : true,
    online: live && live.online !== undefined ? !!live.online : true,
    delivery: live && live.delivery !== undefined ? !!live.delivery : true,
    pickup: live && live.pickup !== undefined ? !!live.pickup : true,
  };

  if (!state.online || !state.acceptingOrders) {
    return { open: false, reason: 'offline', source: 'live', state };
  }

  const local = new Date((at || 0) + (tzOffsetMin || 0) * 60000);
  const ymd = local.toISOString().slice(0, 10);
  const overrides = (schedule && schedule.overrides) || {};
  const ov = overrides[ymd];
  if (ov) {
    if (ov.closed === true) return { open: false, reason: 'closed_today', source: 'override', state, date: ymd };
    if (ov.closed === false) return { open: true, reason: 'special_hours', source: 'override', state, date: ymd };
  }

  const hours = (schedule && (schedule.hours || schedule.openingHours)) || null;
  if (!hours) return { open: true, reason: 'no_schedule', source: 'live', state };

  const cfg = hours[_DAYS[local.getUTCDay()]];
  if (!cfg || cfg.closed || !Array.isArray(cfg.periods) || !cfg.periods.length) {
    return { open: false, reason: 'outside_hours', source: 'schedule', state };
  }

  const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
  const toMin = (hhmm) => {
    const parts = String(hhmm || '').split(':');
    const h = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
  };
  for (const p of cfg.periods) {
    const a = toMin(p && p.open), b = toMin(p && p.close);
    if (a === null || b === null) continue;
    /* A period that ends before it starts crosses midnight. */
    if (b >= a ? (mins >= a && mins < b) : (mins >= a || mins < b)) {
      return { open: true, reason: 'within_hours', source: 'schedule', state };
    }
  }
  return { open: false, reason: 'outside_hours', source: 'schedule', state };
}
exports.computeEffectiveAvailability = computeEffectiveAvailability;

/** Resolve the effective availability for any shop — used by the public storefront. */
async function effectiveForShop(shopId, atMs) {
  const db = _db();
  const shopSnap = await db.collection('shops').doc(String(shopId)).get();
  if (!shopSnap.exists) return null;
  const shop = shopSnap.data() || {};
  const ownerUid = shop.sellerUid || shop.ownerUid || shop.ownerId || null;

  let schedule = shop.openingHours ? { hours: shop.openingHours } : null;
  if (ownerUid) {
    const sched = await db.collection('providerAvailability').doc(ownerUid).get();
    if (sched.exists) {
      const d = sched.data() || {};
      /* The seller-managed timetable wins over the copy denormalised on the shop. */
      schedule = { hours: d.hours || d.openingHours || (schedule && schedule.hours) || null,
                   overrides: d.overrides || null };
    }
  }
  return computeEffectiveAvailability(shop, schedule, atMs || Date.now(), 180 /* EAT */);
}
exports.effectiveForShop = effectiveForShop;

exports.getShopAvailability = onCall(
  { region: REGION, cors: true },
  async (request) => {
    const shopId = (request.data || {}).shopId;
    /* Public by design — a buyer must be able to see whether a shop is open. Reads only. */
    if (typeof shopId !== 'string' || !shopId.trim()) {
      throw new HttpsError('invalid-argument', 'shopId is required.');
    }
    const eff = await effectiveForShop(shopId.trim(), Date.now());
    if (!eff) throw new HttpsError('not-found', 'Shop not found.');
    return eff;
  }
);
