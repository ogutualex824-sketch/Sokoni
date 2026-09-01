'use strict';
/* AdminOS Authority Core — control-events + canonical claim helpers.
 * Implements the binding build-scope contract (design/adminos-authority-core 05df4c9):
 *   C1  governed-role allowlist + preserve non-role claims
 *   C2/C6 permsVersion = max(existing, CURRENT)  (monotonic, never downgrade)
 *   C3  controlEvents intent is a PRECONDITION (fail-closed) before the Auth mutation
 *   C7  deterministic event identity (retry idempotency)
 *   C8  atomic ownership claim — exactly one execution reaches the Auth mutation
 *   C9  abandoned-`mutating` recovery (fail-closed; never re-mutates)
 *   C10 owner fencing (monotonic fenceToken; stale owner cannot finalize/overwrite)
 * NOTE: subordinate authority — this never establishes admin identity; boolean custom
 *       claims remain THE authority (C3 single-authority).
 */
const crypto = require('crypto');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');

/* ── Contract constants ─────────────────────────────────────────────────────── */
const GOVERNED_ROLE_KEYS  = ['admin', 'superAdmin', 'seller', 'driver', 'moderator', 'buyer']; // C1
const CURRENT_PERMS_VERSION = 1;                                                                // C2
const STALE_MS = 120000;                                                                        // C9 (>= fn timeout + margin)
const CE = 'controlEvents';

/* ── C1/C2/C6 — canonical merged claims: preserve non-role, normalize the six governed
      roles (never delete a non-governed key), monotonic permsVersion ──────────────── */
function computeMergedClaims(currentClaims, electedRole) {
  const merged = { ...(currentClaims || {}) };          // C1: preserve ALL non-role claims
  merged.admin      = electedRole === 'admin' || electedRole === 'superAdmin'; // superAdmin ⇒ admin
  merged.superAdmin = electedRole === 'superAdmin';
  merged.seller     = electedRole === 'seller';
  merged.driver     = electedRole === 'driver';
  merged.moderator  = electedRole === 'moderator';
  merged.buyer      = electedRole === 'buyer';
  const existingPV  = Number(currentClaims && currentClaims.permsVersion) || 0;
  merged.permsVersion = Math.max(existingPV, CURRENT_PERMS_VERSION);   // C2/C6: never downgrade
  return merged;
}

/* C9 literal reconciliation predicate — `current Auth claims == intended claims`, FULL deep
   equality (key-order-independent). Anything short of exact equality (including a differing
   preserved non-role claim) is "completion not establishable" → fail-closed recovery. */
function _canon(o) {
  if (o === null || typeof o !== 'object') return o;
  if (Array.isArray(o)) return o.map(_canon);
  return Object.keys(o).sort().reduce((a, k) => { a[k] = _canon(o[k]); return a; }, {});
}
function claimsEqual(current, intended) {
  return JSON.stringify(_canon(current || {})) === JSON.stringify(_canon(intended || {}));
}

/* ── C7 — deterministic event id from the mutation identity + client requestId ──── */
function deterministicEventId({ targetUid, callerUid, intendedClaims, requestId }) {
  const gov = {};
  for (const k of GOVERNED_ROLE_KEYS) gov[k] = !!intendedClaims[k];
  gov.permsVersion = intendedClaims.permsVersion;
  const material = JSON.stringify({ t: targetUid, c: callerUid, g: gov, r: requestId || null });
  return 'ce_' + crypto.createHash('sha256').update(material).digest('hex');
}

function _isStale(mutatingAt, nowMs) {
  if (!mutatingAt) return false;
  const ms = (mutatingAt.toMillis ? mutatingAt.toMillis() : Number(mutatingAt)) || 0;
  return (nowMs - ms) > STALE_MS;
}

/* ── C8 + C10 — atomic ownership claim. Exactly one execution wins the right to mutate.
   Returns one of: {won,fenceToken} | {alreadyCommitted,result} | {inProgress} | {stale} | {recovery} */
async function claimEvent(db, eventId, meta, owner, nowMs = Date.now()) {
  const ref = db.collection(CE).doc(eventId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      const fenceToken = 1;
      tx.set(ref, {
        id: eventId, type: meta.type, targetUid: meta.targetUid, callerUid: meta.callerUid,
        requestId: meta.requestId || null, intendedClaims: meta.intendedClaims,
        status: 'mutating', owner, fenceToken,
        intentAt: FieldValue.serverTimestamp(), mutatingAt: FieldValue.serverTimestamp(),
      });
      return { won: true, fenceToken };                       // this execution WINS
    }
    const d = snap.data();
    if (d.status === 'committed') return { alreadyCommitted: true, result: d.outcome || { ok: true } };
    if (d.status === 'recovery')  return { recovery: true };
    // status === 'mutating'
    if (_isStale(d.mutatingAt, nowMs)) return { stale: true }; // C9: caller reconciles
    return { inProgress: true };                               // C8: active winner elsewhere → do NOT mutate
  });
}

/* ── C10 — fenced finalize. Accepted ONLY when the current (owner,fenceToken) matches;
   a stale owner's write is rejected as a no-op. ─────────────────────────────────── */
async function finalizeEvent(db, eventId, owner, fenceToken, outcome) {
  const ref = db.collection(CE).doc(eventId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { finalized: false, reason: 'missing' };
    const d = snap.data();
    if (d.owner !== owner || d.fenceToken !== fenceToken) return { finalized: false, reason: 'fenced' }; // C10
    if (d.status === 'committed') return { finalized: false, reason: 'already' };
    tx.update(ref, { status: 'committed', outcome, committedAt: FieldValue.serverTimestamp() });
    return { finalized: true };
  });
}

/* ── C9 + C10 — reconcile a stale `mutating` event WITHOUT repeating the Auth mutation.
   Transfers ownership (fenceToken++), then: current==intended → committed; else → recovery. */
async function reconcileStaleEvent(db, eventId, getAuth, nowMs = Date.now()) {
  const ref = db.collection(CE).doc(eventId);
  const taken = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, reason: 'missing' };
    const d = snap.data();
    if (d.status === 'committed') return { ok: false, already: true, result: d.outcome };
    if (d.status !== 'mutating' || !_isStale(d.mutatingAt, nowMs)) return { ok: false, notStale: true };
    const fenceToken = (d.fenceToken || 1) + 1;                 // C10: increment → invalidates prior owner
    const reconciler = 'recon_' + crypto.randomUUID();
    tx.update(ref, { owner: reconciler, fenceToken, mutatingAt: FieldValue.serverTimestamp(), status: 'mutating' });
    return { ok: true, reconciler, fenceToken, intendedClaims: d.intendedClaims, targetUid: d.targetUid };
  });
  if (!taken.ok) return taken;

  const targetUser = await getAuth().getUser(taken.targetUid);
  if (claimsEqual(targetUser.customClaims, taken.intendedClaims)) {   // C9: current == intended (full equality)
    await finalizeEvent(db, eventId, taken.reconciler, taken.fenceToken,
      { ok: true, reconciled: true, mutationCount: 0 });        // C9: NO re-mutation
    return { status: 'committed', reconciled: true };
  }
  // fail-closed: cannot safely establish completion → explicit recovery, never a 2nd mutation
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.data();
    if (d && d.owner === taken.reconciler && d.fenceToken === taken.fenceToken) {
      tx.update(ref, { status: 'recovery', recoveryReason: 'mutation completion not verifiable', recoveredAt: FieldValue.serverTimestamp() });
    }
  });
  return { status: 'recovery' };
}

/* ── C8 loser semantics — a concurrent (non-winning) execution does NOT mutate; it waits for the
   winner to reach `committed` and returns that result. Bounded + FAIL-CLOSED: if the winner
   abandons the event (it goes stale) the waiter reconciles it (C9); if neither committed nor
   recovery is reached within the bound, it returns `timeout` and the caller fails closed (retry).
   The waiter NEVER performs an Auth mutation on any path. ───────────────────────────────────── */
async function waitForCommit(db, eventId, getAuth, opts = {}) {
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 8000;   // < function timeout
  const pollMs    = opts.pollMs    != null ? opts.pollMs    : 100;
  const nowFn     = opts.nowFn || Date.now;
  const sleep     = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const ref = db.collection(CE).doc(eventId);
  const deadline = nowFn() + timeoutMs;
  for (;;) {
    const snap = await ref.get();
    if (!snap.exists) return { status: 'missing' };
    const d = snap.data();
    if (d.status === 'committed') return { status: 'committed', result: d.outcome || { ok: true } };
    if (d.status === 'recovery')  return { status: 'recovery' };
    // status === 'mutating'
    if (_isStale(d.mutatingAt, nowFn())) {                            // winner abandoned → C9 reconcile
      const rec = await reconcileStaleEvent(db, eventId, getAuth, nowFn());
      if (rec.status === 'committed') return { status: 'committed', result: ((await ref.get()).data() || {}).outcome || { ok: true } };
      return { status: rec.status || 'recovery' };
    }
    if (nowFn() >= deadline) return { status: 'timeout' };            // bounded → caller fails closed
    await sleep(pollMs);
  }
}

module.exports = {
  GOVERNED_ROLE_KEYS, CURRENT_PERMS_VERSION, STALE_MS,
  computeMergedClaims, claimsEqual, deterministicEventId,
  claimEvent, finalizeEvent, reconcileStaleEvent, waitForCommit, _isStale, Timestamp,
};
