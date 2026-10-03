'use strict';
/**
 * ACCOUNT SUSPENSION — the ONE server contract (owner 2026-10-04). Every suspension in SOKONI goes through here:
 * super-admin.js suspendUser (the canonical callable, used by BOTH AdminOS and Super Admin) and trust-safety.js tsBanUser
 * (delegates — it no longer has a status-only path of its own).
 *
 * The security boundary is the AUTH ACCOUNT, not a Firestore field:
 *   suspend   → Firebase Auth disabled:true (no new sign-in) + refresh tokens revoked (no new ID tokens; an already-issued
 *               ID token expires within its ≤1 h lifetime) + users/{uid} status:'suspended', suspended:true (+ prior status kept)
 *               + ONE accountSuspensions history record + ONE adminAudit record
 *   unsuspend → Auth disabled:false + users/{uid} status restored to the prior status (default 'active'), suspended:false
 *               + ONE history record + ONE audit record
 *
 * AUTHORIZATION (server-side only — a button state is never trusted): the actor must hold the superAdmin claim. Refused:
 *   a non-super-admin (incl. an ordinary admin calling the function directly) · self-suspension · suspending another
 *   super admin. A reason is REQUIRED to suspend.
 *
 * IDEMPOTENT: when the account is already in the requested state (Auth flag AND document agree) the call changes nothing,
 * writes NO history and NO audit record, and returns { changed:false }. A half-applied state (e.g. Auth disabled but the
 * document not yet) is completed, and recorded once. No money is touched by suspension.
 */
const SUSPENDED = 'suspended';

class SuspensionError extends Error { constructor (code, message) { super(message); this.code = code; } }
const fail = (code, message) => { throw new SuspensionError(code, message); };
const clean = (v, n) => String(v == null ? '' : v).replace(/<[^>]*>/g, '').trim().slice(0, n);

/**
 * setSuspension({ db, auth, serverTs, actor: { uid, superAdmin }, uid, suspend, reason, source })
 *   → { ok:true, changed:boolean, uid, suspended:boolean }
 */
async function setSuspension(o) {
  const { db, auth, actor } = o;
  const serverTs = o.serverTs || (() => new Date());
  if (!actor || !actor.uid) fail('unauthenticated', 'Sign in required.');
  if (actor.superAdmin !== true) fail('permission-denied', 'Only a super admin can suspend or reinstate an account.');
  const uid = clean(o.uid, 128);
  if (!uid) fail('invalid-argument', 'uid is required.');
  if (typeof o.suspend !== 'boolean') fail('invalid-argument', 'suspend must be true or false.');
  const reason = clean(o.reason, 500);
  if (o.suspend && reason.length < 3) fail('invalid-argument', 'A reason is required to suspend an account.');
  if (uid === actor.uid) fail('failed-precondition', 'You cannot suspend or reinstate your own account.');
  const source = clean(o.source || 'unknown', 40);

  let target;
  try { target = await auth.getUser(uid); } catch (_) { fail('not-found', 'That account does not exist.'); }
  if (o.suspend && target.customClaims && target.customClaims.superAdmin === true) fail('permission-denied', 'A super admin account cannot be suspended.');

  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  const doc = snap.exists ? (snap.data() || {}) : {};
  const docSuspended = doc.suspended === true || doc.status === SUSPENDED || doc.status === 'banned';
  const inState = o.suspend ? (target.disabled === true && doc.suspended === true && doc.status === SUSPENDED)
                            : (target.disabled !== true && !docSuspended);
  if (inState) return { ok: true, changed: false, uid, suspended: o.suspend };

  /* Security first: the Auth account flips before any document write — a later failure leaves it LOCKED, never open. */
  await auth.updateUser(uid, { disabled: o.suspend });
  if (o.suspend) { try { await auth.revokeRefreshTokens(uid); } catch (_) { /* disabled already blocks refresh */ } }

  const priorStatus = (doc.status && doc.status !== SUSPENDED && doc.status !== 'banned') ? doc.status : (doc.suspensionPriorStatus || 'active');
  const patch = o.suspend
    ? { status: SUSPENDED, suspended: true, suspensionPriorStatus: priorStatus, suspendedAt: serverTs(), suspendReason: reason, suspendedBy: actor.uid,
        suspensionSource: source, reinstatedAt: null, reinstatedBy: null }
    : { status: doc.suspensionPriorStatus || 'active', suspended: false, suspendedAt: null, suspendReason: null, suspendedBy: null,
        suspensionSource: null, reinstatedAt: serverTs(), reinstatedBy: actor.uid };
  await ref.set(patch, { merge: true });

  const event = { uid, action: o.suspend ? 'suspended' : 'reinstated', actorUid: actor.uid, reason: reason || null, source,
    authDisabled: o.suspend, sessionsRevoked: o.suspend, at: serverTs() };
  await db.collection('accountSuspensions').add(event);
  await db.collection('adminAudit').add({ action: o.suspend ? 'account_suspended' : 'account_reinstated', targetUid: uid,
    performedBy: actor.uid, reason: reason || null, source, createdAt: serverTs() });
  return { ok: true, changed: true, uid, suspended: o.suspend };
}

module.exports = { setSuspension, SuspensionError, SUSPENDED };
