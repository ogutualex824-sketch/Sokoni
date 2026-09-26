'use strict';
/**
 * SOKONI Role Authority — the ONE primitive that grants or revokes an account
 * role, and the ONE writer of the Auth custom claim that mirrors it.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 * A role on this platform is TWO facts that must agree:
 *
 *   users/{uid}.roles[]        Firestore — what dashboards, analytics and the
 *                              server read.
 *   customClaims.<key>         Auth      — what firestore.rules and the client
 *                              role gate read. Since Role Authority Phases 1-5
 *                              the CLAIM is the only client-side authority.
 *
 * Write one without the other and the account is broken in a way that looks
 * healthy from every dashboard: `roles: ['seller']` is present, the admin sees
 * an approved merchant, and the merchant themself lands in the app as a buyer
 * because their token carries no `seller` claim.
 *
 * Two paths were granting the role without ever minting the claim
 * (`automation-engine.js` auto-approval, `wap.js` seller.activate), and the
 * canonical path (`application-lifecycle.js`) swallowed its own claim failure
 * with a `logger.warn`. All three now go through here.
 *
 * ── The contract: commit first, then mint, then report ──────────────────────
 * `setCustomUserClaims()` is an Auth call. It is NOT part of Firestore's
 * transactional model and MUST NOT be invoked inside `runTransaction` — a
 * transaction retry would re-issue it, and a rolled-back transaction would
 * leave the claim minted for a grant that never happened. So the shape is:
 *
 *     roleFieldPatch()  →  inside the caller's transaction / batch / set
 *              ↓
 *     COMMIT succeeds
 *              ↓
 *     syncRoleClaim()   →  after the commit, never inside it
 *              ↓
 *     { ok } → caller reports success   { ok: false } → caller reports PENDING
 *
 * ── Failure is observable, never silent ─────────────────────────────────────
 * A claim mint that fails after the Firestore commit leaves exactly the
 * divergence described above. `syncRoleClaim` therefore never throws and never
 * swallows: it records the divergence in `roleClaimReconcile/{uid}__{key}`
 * (server-only; the collection has no rules match, so clients cannot read it)
 * plus one deduplicated `adminAlerts` entry, and returns a result the caller is
 * expected to surface. A caller that ignores the result and reports success is
 * reintroducing the defect this module exists to remove.
 *
 * Reconciliation is REPORTING ONLY. Nothing here repairs a population; the
 * census classifies (CONSISTENT / CLAIM_MISSING / ROLE_MISSING / AMBIGUOUS)
 * and a repair is a separate, deliberate, human-triggered act.
 *
 * Exports (helper module — no Cloud Functions, nothing to re-export from
 * functions/index.js):
 *   ROLE_KEY / roleKeyFor   application role vocabulary → canonical role key
 *   roleFieldPatch          transaction-safe Firestore patch for users/{uid}
 *   claimsFor               the claim shape a role implies
 *   syncRoleClaim           post-commit claim mint + reconciliation record
 *   grantAccountRole        non-transactional convenience: patch + mint
 */

const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const logger = require('firebase-functions/logger');

/* Server-only reconciliation ledger. Deliberately absent from firestore.rules:
   with no match block the default deny applies, so no client can read a list of
   accounts whose privileges are mid-flight. */
const RECONCILE_COLLECTION = 'roleClaimReconcile';
const ALERTS_COLLECTION = 'adminAlerts';

/* Intake vocabulary → the canonical key used in BOTH `users.roles[]` and the
   custom claim. `health` and `legal` are provider variants here: they are their
   own registries but one provider role on the account.
   ─────────────────────────────────────────────────────────────────────────────
   MERGE HAZARD — this map is the PRE-Phase-2 vocabulary, which is what this
   branch runs. Roles Phase 2 (commit 2f7fd5d, on rc/combined and the identity
   branches — NOT an ancestor of this branch) replaced it with a 12-entry map
   that gives mechanic / landlord / tenant / health / legal their own keys and
   THROWS on an unmapped role instead of defaulting. Production rules already
   speak that vocabulary.

   When this branch meets that one, this map must be replaced by the Phase-2 map
   and the throw preserved — do not resolve the conflict by keeping this table,
   and do not let Phase 2's copy live inside grantAccountRole again: the map
   belongs here, with the rest of the role authority. Until then the fallback
   below is kept (changing the vocabulary ahead of the branch that owns it would
   grant `provider` where prod expects `legal`), but it is no longer silent. */
const ROLE_KEY = Object.freeze({
  provider: 'provider',
  driver: 'rider',
  seller: 'seller',
  health: 'provider',
  legal: 'provider',
  /* Entertainment › Events (shared/entertainment-registry.js). Granted ONLY by an admin decision
     on an application; event-hub's organizer gate reads users.roles for it. */
  event_organizer: 'event_organizer',
});

function roleKeyFor(role) {
  const key = ROLE_KEY[role];
  if (key) return key;
  /* A role that reaches here unmapped is a bug in the caller, not an applicant
     problem to smooth over. Behaviour is unchanged — but it is now visible. */
  logger.error('[roleAuthority] UNMAPPED role defaulted to "provider"', {
    role, known: Object.keys(ROLE_KEY).join(','),
  });
  return 'provider';
}

/**
 * The claim shape a role implies, merged onto the account's existing claims.
 * Existing claims are preserved — a seller who is also a rider must not lose
 * the rider claim because their seller application was decided.
 */
function claimsFor(role, approved, existing) {
  const claims = { ...(existing || {}) };
  if (role === 'provider' || role === 'health' || role === 'legal') claims.provider = !!approved;
  if (role === 'driver') { claims.driver = !!approved; claims.rider = !!approved; }
  if (role === 'seller') claims.seller = !!approved;
  if (role === 'event_organizer') claims.event_organizer = !!approved;
  return claims;
}

/**
 * The Firestore half of a grant, as a plain patch object.
 *
 * Safe to hand to `tx.set(ref, patch, { merge: true })` inside a transaction,
 * to `batch.set(...)`, or to a bare `ref.set(...)` — it contains only field
 * values and sentinels, and performs no I/O of its own.
 *
 * `roles` is written as an ARRAY. An account carrying only `isProvider: true`
 * or a `role: 'seller'` string lands in the app as a buyer, because the role
 * gate and the analytics gate read `roles`.
 *
 * `registeredAs` is written as a NESTED map, not as a dotted key. `set()` does
 * not expand dot notation (only `update()` does, via fromUpdateMap) — a patch
 * of `{'registeredAs.seller': true}` creates a field literally NAMED
 * "registeredAs.seller" and leaves the real map untouched, which is how the
 * previous implementation silently never populated it.
 *
 * @param {string}  role      intake role vocabulary (provider|driver|seller|health|legal)
 * @param {boolean} approved  true grants, false revokes
 * @param {object}  [extra]   caller-owned fields merged into the same write
 */
function roleFieldPatch(role, approved, extra = {}) {
  const key = roleKeyFor(role);
  const patch = { updatedAt: FieldValue.serverTimestamp() };

  if (approved) {
    patch.roles = FieldValue.arrayUnion(key);
    patch.registeredAs = { [key]: true };
    patch.approved = true;
    patch.approvedAt = FieldValue.serverTimestamp();
    if (role === 'provider') patch.isProvider = true;
    if (role === 'driver') { patch.isDriver = true; patch.isRider = true; }
  } else {
    /* The role is removed; the account is otherwise untouched — a rejected
       provider is still a customer. */
    patch.roles = FieldValue.arrayRemove(key);
    patch.registeredAs = { [key]: false };
    if (role === 'provider') patch.isProvider = false;
    if (role === 'driver') { patch.isDriver = false; patch.isRider = false; }
  }

  /* Caller extras first: the canonical role fields always win, so no call site
     can accidentally (or deliberately) overwrite `roles` with a string. */
  return { ...extra, ...patch };
}

/**
 * Mint (or clear) the Auth custom claim for a role that has ALREADY been
 * committed to Firestore. Call this AFTER the commit, never inside it.
 *
 * Never throws. Returns the outcome so the caller can report it:
 *   { ok: true,  key, claim: 'minted' }
 *   { ok: false, key, claim: 'failed', reconcileId, error }
 *
 * @param {string}  uid
 * @param {string}  role
 * @param {boolean} approved
 * @param {object}  [ctx]   { source, entityId } — recorded on the divergence
 */
async function syncRoleClaim(uid, role, approved, ctx = {}) {
  const key = roleKeyFor(role);
  const db = getFirestore();
  const reconcileId = `${uid}__${key}`;

  try {
    const auth = getAuth();
    const user = await auth.getUser(uid);
    await auth.setCustomUserClaims(uid, claimsFor(role, approved, user.customClaims));

    /* Converged — retire any open divergence for this uid+role. Idempotent:
       deleting a document that does not exist is a no-op. */
    await db.collection(RECONCILE_COLLECTION).doc(reconcileId).delete().catch(() => {});
    return { ok: true, key, claim: 'minted', reconcileId: null };
  } catch (e) {
    const error = e && e.message ? e.message : String(e);

    /* The Firestore side is committed and the claim is not. Record it where a
       census and an operator can both find it, rather than warning into a log
       nobody queries. */
    const state = approved ? 'CLAIM_MISSING' : 'CLAIM_STALE';
    await db.collection(RECONCILE_COLLECTION).doc(reconcileId).set({
      uid,
      role,
      roleKey: key,
      desiredClaim: !!approved,
      state,
      source: ctx.source || 'unknown',
      entityId: ctx.entityId || null,
      lastError: error,
      attempts: FieldValue.increment(1),
      lastFailedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true }).catch((e2) => {
      logger.error('[roleAuthority] reconciliation record failed', { uid, role, error: e2.message });
    });

    /* Deterministic id: a retried grant updates the same alert instead of
       flooding the admin queue. */
    await db.collection(ALERTS_COLLECTION).doc(`role_claim_unminted__${reconcileId}`).set({
      kind: 'role_claim_unminted',
      severity: 'high',
      message: `Role "${key}" is granted in Firestore for ${uid} but the Auth claim was not minted — the account will behave as a buyer until this is reconciled.`,
      uid,
      role,
      roleKey: key,
      desiredClaim: !!approved,
      source: ctx.source || 'unknown',
      entityId: ctx.entityId || null,
      lastError: error,
      reconcileId,
      createdAt: FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});

    logger.error('[roleAuthority] claim mint FAILED after Firestore commit', {
      uid, role, roleKey: key, approved: !!approved, source: ctx.source || 'unknown', error,
    });

    return { ok: false, key, claim: 'failed', reconcileId, error };
  }
}

/**
 * Non-transactional convenience: write the role patch, then mint the claim.
 * Use only where the caller has no transaction of its own; a caller that
 * already runs a transaction must use `roleFieldPatch()` inside it and call
 * `syncRoleClaim()` after the commit.
 *
 * Returns the `syncRoleClaim` result (always carries `key`).
 */
async function grantAccountRole(db, uid, role, approved, ctx = {}) {
  await db.collection('users').doc(uid).set(roleFieldPatch(role, approved), { merge: true });
  return syncRoleClaim(uid, role, approved, ctx);
}

module.exports = {
  ROLE_KEY,
  RECONCILE_COLLECTION,
  roleKeyFor,
  claimsFor,
  roleFieldPatch,
  syncRoleClaim,
  grantAccountRole,
};
