'use strict';
/**
 * ACCOUNT LOCK — the ONE server contract for SUSPENSION and BAN (owner 2026-10-04). Every lock in SOKONI goes through here:
 * super-admin.js suspendUser (the canonical callable, used by BOTH AdminOS and Super Admin) and trust-safety.js tsBanUser
 * (delegates — it no longer has a status-only path of its own).
 *
 * Two KINDS, one lockout (owner ruling 2026-10-04: "keep ban distinct … on top of the SAME Auth lockout"):
 *   kind 'suspend' (default) → users/{uid} status:'suspended'
 *   kind 'ban'               → users/{uid} status:'banned' + banReason / bannedBy / bannedAt
 * The security boundary is the AUTH ACCOUNT, not a Firestore field. Locking (either kind):
 *   Firebase Auth disabled:true (no new sign-in) + refresh tokens revoked (no new ID tokens; an already-issued ID token is
 *   refused by Firestore rules and by shared/account-state.js for its remaining ≤1 h) + suspended:true (+ prior status kept)
 *   + ONE accountSuspensions history record + ONE adminAudit record + ONE auditLog (severity high) record.
 * Lifting: Auth disabled:false + status restored to the prior status (default 'active'), suspended:false + one of each record.
 *
 * DURATION (owner ruling 2026-10-04): a SUSPENSION lasts SUSPENSION_DAYS (14), server-fixed — suspendedUntil = server time +
 * 14 days, written here and nowhere else; a client-chosen length is refused by every caller. Re-suspending an already
 * suspended account keeps the ORIGINAL suspendedUntil; a new suspension after a reinstate starts a fresh 14 days.
 * A BAN is permanent (suspendedUntil null) and is NEVER auto-lifted. Admins may reinstate a suspension early.
 * AUTO-EXPIRY goes through THIS contract (account-suspension-expiry.js): actor { system:true } is accepted ONLY for
 * suspend:false + kind 'suspend' + source 'auto_expiry', and only when the RE-READ document is still a suspension whose
 * readable suspendedUntil is due. A missing / unreadable suspendedUntil is NEVER expired (fail closed). Each suspension
 * episode is lifted at most once: the lift claims suspensionLifts/{uid}_{untilMillis} with create() — a concurrent job run
 * or a simultaneous manual reinstate loses the claim and writes nothing.
 *
 * Lifting a BAN is a SEPARATE, explicit decision (owner): lifting with kind 'suspend' on a banned account is REFUSED, and
 * so is lifting with kind 'ban' on a merely suspended account. Suspending a banned account is refused too (it would silently
 * downgrade a ban); banning a suspended account escalates it. Legacy records (status 'banned' written by the old tsBanUser
 * WITHOUT an Auth lockout) are banned accounts here: re-banning completes the lockout, lifting the ban restores them.
 *
 * AUTHORIZATION (server-side only — a button state is never trusted): the actor must hold the superAdmin claim AND have an
 *   active account. Refused: a non-super-admin (incl. an ordinary admin calling the function directly) · self-action ·
 *   locking another super admin. A reason is REQUIRED to lock.
 *
 * IDEMPOTENT: when the account is already in the requested state (Auth flag AND document agree) the call changes nothing,
 * writes NO history and NO audit record, and returns { changed:false }. A half-applied state (e.g. Auth disabled but the
 * document not yet) is completed, and recorded once. No money is touched.
 */
const SUSPENDED = 'suspended';
const BANNED = 'banned';
const KIND_STATUS = { suspend: SUSPENDED, ban: BANNED };
const SUSPENSION_DAYS = 14;
const DAY_MS = 86400000;
const LIFT_CLAIM_STALE_MS = 10 * 60 * 1000;   // a claim whose writer died mid-lift may be taken over after 10 min

/* suspendedUntil → epoch ms, or null when missing / unreadable (callers treat null as NOT expired) */
function untilMs(v) {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v.toMillis === 'function') { try { const m = v.toMillis(); return Number.isFinite(m) ? m : null; } catch (_) { return null; } }
  return null;   // strings / numbers are not an authoritative server timestamp
}

class SuspensionError extends Error { constructor (code, message) { super(message); this.code = code; } }
const fail = (code, message) => { throw new SuspensionError(code, message); };
const clean = (v, n) => String(v == null ? '' : v).replace(/<[^>]*>/g, '').trim().slice(0, n);

/**
 * setSuspension({ db, auth, serverTs, actor: { uid, superAdmin }, uid, suspend, kind?, reason, source })
 *   → { ok:true, changed:boolean, uid, suspended:boolean, kind }
 */
async function setSuspension(o) {
  const { db, auth, actor } = o;
  const serverTs = o.serverTs || (() => new Date());
  const now = typeof o.now === 'function' ? o.now() : Date.now();
  if (!actor || (!actor.uid && actor.system !== true)) fail('unauthenticated', 'Sign in required.');
  const isSystem = actor.system === true;
  /* the SYSTEM actor exists for one job only: lifting an expired suspension. It can never suspend, ban or lift a ban. */
  if (isSystem && (o.suspend !== false || (o.kind != null && o.kind !== 'suspend') || o.source !== 'auto_expiry')) {
    fail('permission-denied', 'The system actor may only lift an expired suspension.');
  }
  if (!isSystem && actor.superAdmin !== true) fail('permission-denied', 'Only a super admin can suspend, ban or reinstate an account.');
  const uid = clean(o.uid, 128);
  if (!uid) fail('invalid-argument', 'uid is required.');
  if (typeof o.suspend !== 'boolean') fail('invalid-argument', 'suspend must be true or false.');
  const kind = o.kind == null ? 'suspend' : o.kind;
  if (!KIND_STATUS[kind]) fail('invalid-argument', "kind must be 'suspend' or 'ban'.");
  const lockStatus = KIND_STATUS[kind];
  /* REASON IS MANDATORY for every human action — lock AND lift (owner 2026-10-04); the system actor's reason is fixed. */
  const reason = isSystem ? 'Suspension period (' + SUSPENSION_DAYS + ' days) ended' : clean(o.reason, 500);
  if (reason.length < 3) fail('invalid-argument', 'A reason is required to ' + (o.suspend ? kind : (kind === 'ban' ? 'lift a ban on' : 'reinstate')) + ' an account.');
  if (!isSystem) {
    if (o.durationDays != null) fail('invalid-argument', 'The suspension length is fixed by the platform (' + SUSPENSION_DAYS + ' days).');
    if (uid === actor.uid) fail('failed-precondition', 'You cannot suspend, ban or reinstate your own account.');
    /* the actor's OWN canonical account must be active — a suspended admin's still-valid token cannot act (owner 2026-10-04) */
    try { await require('./account-state').assertAccountActive(db, actor.uid); } catch (e) { fail(e.code || 'permission-denied', e.message); }
  }
  const actorId = isSystem ? 'system:auto_expiry' : actor.uid;
  const source = clean(o.source || 'unknown', 40);

  let target;
  try { target = await auth.getUser(uid); } catch (_) { fail('not-found', 'That account does not exist.'); }
  if (o.suspend && target.customClaims && target.customClaims.superAdmin === true) fail('permission-denied', 'A super admin account cannot be suspended or banned.');

  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  const doc = snap.exists ? (snap.data() || {}) : {};
  const isBanned = doc.status === BANNED;
  const docLocked = isBanned || doc.suspended === true || doc.status === SUSPENDED;
  const curUntil = untilMs(doc.suspendedUntil);

  /* auto-expiry decides on the RE-READ document: only a still-suspended (never banned) account whose readable
     suspendedUntil is due. Anything else is a no-op — a manual reinstate or a fresh suspension is never clobbered. */
  if (isSystem) {
    if (isBanned || doc.status !== SUSPENDED) return { ok: true, changed: false, uid, suspended: false, kind, skipped: 'not_suspended' };
    if (curUntil === null) return { ok: true, changed: false, uid, suspended: true, kind, skipped: 'until_unreadable' };
    if (curUntil > now) return { ok: true, changed: false, uid, suspended: true, kind, skipped: 'not_due' };
  }

  /* a ban is never downgraded or lifted by a suspension-kind call, and vice versa (owner: separate decisions) */
  if (o.suspend && kind === 'suspend' && isBanned) fail('failed-precondition', 'This account is banned. A ban is not replaced by a suspension.');
  if (!o.suspend && docLocked && kind === 'suspend' && isBanned) fail('failed-precondition', 'This account is banned. Lifting a ban is a separate decision.');
  if (!o.suspend && docLocked && kind === 'ban' && !isBanned) fail('failed-precondition', 'This account is suspended, not banned. Lift the suspension instead.');

  const inState = o.suspend ? (target.disabled === true && doc.suspended === true && doc.status === lockStatus)
                            : (target.disabled !== true && !docLocked);
  if (inState) return { ok: true, changed: false, uid, suspended: o.suspend, kind };

  /* Lifting a dated suspension: claim the episode exactly once BEFORE anything changes (create() — never get()+set()).
     Only ALREADY_EXISTS means another lift (a concurrent job run, a simultaneous manual reinstate) owns this episode;
     any other failure is thrown here, before Auth is touched. A claim whose writer died mid-lift is taken over after
     LIFT_CLAIM_STALE_MS so the account can never be stranded. */
  if (!o.suspend && !isBanned && curUntil !== null) {
    const claimRef = db.collection('suspensionLifts').doc(uid + '_' + curUntil);
    try {
      await claimRef.create({ uid, until: curUntil, by: actorId, source, at: serverTs(), atMs: now });
    } catch (e) {
      const exists = e && (e.code === 6 || e.code === 'already-exists' || e.code === 'ALREADY_EXISTS' || /already.?exists/i.test(String(e.message || '')));
      if (!exists) fail('unavailable', 'The reinstatement could not be recorded. Nothing was changed; try again.');
      const c = await claimRef.get();
      const cd = c.exists ? (c.data() || {}) : {};
      const stale = typeof cd.atMs === 'number' && now - cd.atMs > LIFT_CLAIM_STALE_MS;
      if (!stale) return { ok: true, changed: false, uid, suspended: false, kind, skipped: 'lift_claimed' };
      await claimRef.set({ uid, until: curUntil, by: actorId, source, at: serverTs(), atMs: now, takeover: true });
    }
  }

  /* Security first: on a LOCK the Auth account flips before any document write — a later failure leaves it LOCKED, never
     open. On a LIFT, Auth re-enables after the claim; a failure after that still leaves the document locked, which
     Firestore rules and account-state.js enforce. */
  await auth.updateUser(uid, { disabled: o.suspend });
  if (o.suspend) { try { await auth.revokeRefreshTokens(uid); } catch (_) { /* disabled already blocks refresh */ } }

  const priorStatus = (doc.status && doc.status !== SUSPENDED && doc.status !== BANNED) ? doc.status : (doc.suspensionPriorStatus || 'active');
  let patch;
  if (o.suspend) {
    /* keep the ORIGINAL end date when completing a half-applied suspension of the same episode; else a fresh 14 days */
    const keepUntil = kind === 'suspend' && doc.status === SUSPENDED && doc.suspended === true && curUntil !== null;
    patch = { status: lockStatus, suspended: true, suspensionPriorStatus: priorStatus, suspendedAt: serverTs(), suspendReason: reason,
      suspendedBy: actorId, suspensionSource: source, reinstatedAt: null, reinstatedBy: null,
      suspendedUntil: kind === 'ban' ? null : (keepUntil ? doc.suspendedUntil : new Date(now + SUSPENSION_DAYS * DAY_MS)) };
    if (kind === 'ban') Object.assign(patch, { bannedAt: serverTs(), bannedBy: actorId, banReason: reason });
  } else {
    patch = { status: doc.suspensionPriorStatus || 'active', suspended: false, suspendedAt: null, suspendReason: null, suspendedBy: null,
      suspensionSource: null, suspendedUntil: null, reinstatedAt: serverTs(), reinstatedBy: actorId };
    if (kind === 'ban') Object.assign(patch, { bannedAt: null, bannedBy: null, banReason: null });
  }
  await ref.set(patch, { merge: true });

  const verb = o.suspend ? (kind === 'ban' ? 'banned' : 'suspended') : (kind === 'ban' ? 'unbanned' : 'reinstated');
  /* ONE event id ties the history record to every audit record (owner: actor, target, action, timestamp, reason,
     resulting state, audit/event id — audit pages read these records; history is never reconstructed from status). */
  const evRef = db.collection('accountSuspensions').doc();
  const eventId = evRef.id;
  const resultingState = { status: patch.status, suspended: patch.suspended, signInEnabled: !o.suspend,
    suspendedUntilMs: untilMs(patch.suspendedUntil) };
  await evRef.set({ eventId, uid, action: verb, kind, actorUid: actorId, reason, source, resultingState,
    authDisabled: o.suspend, sessionsRevoked: o.suspend, at: serverTs() });
  await db.collection('adminAudit').add({ eventId, action: 'account_' + verb, targetUid: uid, kind,
    performedBy: actorId, reason, source, resultingState, createdAt: serverTs() });
  /* Trust & Safety trail (owner: every suspension or ban also writes trustSafetyAudit — the T&S console reads it) */
  await db.collection('trustSafetyAudit').add({ eventId, action: 'user_' + (o.suspend ? kind : (kind === 'ban' ? 'unban' : 'restore')),
    entityId: uid, entityType: 'user', reason, performedBy: actorId, source, resultingState, createdAt: serverTs() });
  /* LIVE behaviour kept (super-admin.js _auditLog): Super Admin's Audit Log page reads auditLog severity high+critical. */
  await db.collection('auditLog').add({ actor: actorId,
    action: o.suspend ? (kind === 'ban' ? 'banUser' : 'suspendUser') : (kind === 'ban' ? 'unbanUser' : 'reinstateUser'),
    resource: 'users/' + uid,
    details: { eventId, uid, email: target.email || null, reason, action: verb, kind, source, resultingState },
    severity: 'high', createdAt: serverTs() });
  return { ok: true, changed: true, uid, suspended: o.suspend, kind, eventId, resultingState };
}

module.exports = { setSuspension, SuspensionError, SUSPENDED, BANNED, SUSPENSION_DAYS, untilMs };
