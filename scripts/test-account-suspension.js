#!/usr/bin/env node
'use strict';
/* ONE SUSPENSION CONTRACT (owner 2026-10-04) — deliberate breaks against the REAL handlers
     S1  AdminOS path (suspendUser, source adminos): status suspended + Auth disabled + sessions revoked + history + audit
     S2  Super Admin path (suspendUser, source super_admin): IDENTICAL outcome — no behavioural difference between surfaces
     S3  ORDINARY ADMIN calls suspendUser directly (button manually enabled) → permission-denied, nothing changes
     S4  self-suspension → refused server-side (also for a super admin)
     S5  duplicate suspension → ONE effective suspension: second call changes nothing, NO second history/audit record
     S6  tsBanUser (the old status-only path) now delegates: ban → the SAME canonical state (Auth disabled), restore re-enables
     S7  unsuspend only through the authorized action: sign-in re-enabled, prior status restored, one history + audit record
     S8  CONTRACT: the exact payload each UI sends ({uid, suspend, reason, source}) passes the server schema; the OLD AdminOS
         field name ({userId}) and a missing reason are refused with explicit codes (no silent no-op)
     S9  a super admin account cannot be suspended; an unknown uid → not-found
     S14 ban never downgraded/lifted by a suspension call; suspended→ban escalates · S15 14-day server-fixed, original end kept, cleared on reinstate
     S16 client duration refused · S17 reason mandatory (lock + lift) · S18 audit visibility (one eventId across auditLog/adminAudit/trustSafetyAudit/history)
     S19 legacy 'banned' record · S20 lift claim failure fails closed before Auth · S21 half-applied completion keeps the original end date · S22 tsReviewReport banUser routes through the contract
     S10-S13 existing-session window: a suspended actor (still-valid token) is refused by suspendUser, every AdminOS op and setUserRole; unreadable → fails closed
   node scripts/test-account-suspension.js */
require('./lib/net-firewall').install();
const path = require('path'), fs = require('fs'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 280) + ']')); ok ? pass++ : fail++; };
/* fake Firestore + Auth */
const DOCS = new Map(); let AUTO = 0;
const emptyQ = () => ({ where: () => emptyQ(), orderBy: () => emptyQ(), limit: () => emptyQ(), startAfter: () => emptyQ(), select: () => emptyQ(),
  count: () => ({ get: async () => ({ data: () => ({ count: 0 }) }) }), get: async () => ({ size: 0, empty: true, docs: [] }) });
let UNREADABLE = false; let CREATE_FAIL = false;
const coll = (c) => Object.assign(emptyQ(), {
  doc: (id0) => { const id = id0 === undefined ? 'a' + (++AUTO) : id0; return { id, get: async () => { if (UNREADABLE && c === 'users') throw new Error('UNAVAILABLE'); return { exists: DOCS.has(c + '/' + id), data: () => DOCS.get(c + '/' + id) && { ...DOCS.get(c + '/' + id) } }; },
    set: async (v, o) => { DOCS.set(c + '/' + id, o && o.merge ? Object.assign({}, DOCS.get(c + '/' + id) || {}, v) : { ...v }); },
    update: async (v) => { DOCS.set(c + '/' + id, Object.assign({}, DOCS.get(c + '/' + id) || {}, v)); },
    create: async (v) => { if (CREATE_FAIL) throw Object.assign(new Error('DEADLINE_EXCEEDED'), { code: 4 });
      if (DOCS.has(c + '/' + id)) throw Object.assign(new Error('6 ALREADY_EXISTS: Document already exists'), { code: 6 }); DOCS.set(c + '/' + id, { ...v }); } }; },
  add: async (v) => { DOCS.set(c + '/a' + (++AUTO), { ...v }); return { id: 'a' + AUTO }; },
});
const db = { collection: coll };
const AUTHS = new Map();
const auth = {
  getUser: async (uid) => { if (!AUTHS.has(uid)) throw new Error('no user'); return { ...AUTHS.get(uid) }; },
  updateUser: async (uid, p) => { AUTHS.set(uid, Object.assign({}, AUTHS.get(uid), p)); },
  revokeRefreshTokens: async (uid) => { const a = AUTHS.get(uid); a.revokedCount = (a.revokedCount || 0) + 1; },
};
class HttpsError extends Error { constructor (c, m) { super(m); this.code = c; } }
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: { serverTimestamp: () => 'TS', increment: (n) => n }, Timestamp: { fromMillis: (m) => ({ _ms: m }) } };
  if (id === 'firebase-admin/auth') return { getAuth: () => auth };
  if (id === 'firebase-functions/v2/https') return { onCall: (o, h) => (h || o), HttpsError };
  if (id === './redis-rate-limiter') return { checkRateLimit: async () => {} };
  if (id === './pos-audit') return { writeAudit: async () => {} };
  return orig.apply(this, arguments);
};
const SA = require(path.join(FN, 'super-admin.js'));
const AOD = require(path.join(FN, 'admin-os-dispatch.js'));
const TS = require(path.join(FN, 'trust-safety.js'));
const call = async (fn, uid, token, data) => { try { return { ok: true, r: await fn({ auth: uid ? { uid, token } : null, data }) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
const SUPER = { superAdmin: true }, ADMIN = { admin: true };
const seed = () => { DOCS.clear(); AUTHS.clear(); AUTO = 0;
  for (const u of ['t1', 't2', 'boss', 'mod']) { DOCS.set('users/' + u, { status: 'active', role: 'buyer' }); AUTHS.set(u, { uid: u, disabled: false, customClaims: {} }); }
  AUTHS.get('boss').customClaims = { superAdmin: true }; };
const recs = (c) => [...DOCS.entries()].filter(([k]) => k.startsWith(c + '/')).map(([, v]) => v);
const count = (c) => [...DOCS.keys()].filter((k) => k.startsWith(c + '/')).length;
const state = (u) => ({ status: (DOCS.get('users/' + u) || {}).status, suspended: (DOCS.get('users/' + u) || {}).suspended, disabled: AUTHS.get(u).disabled, revoked: AUTHS.get(u).revokedCount || 0 });

(async () => {
  /* the exact payloads the two UIs send (read from the source, not re-typed) */
  const aos = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8'), sah = fs.readFileSync(path.join(ROOT, 'super-admin.html'), 'utf8');
  const aosPayload = /suspend: \{ fn: "suspendUser", payload: \(uid, x\) => \(\{ uid, suspend: true, reason: x\.reason, source: "adminos" \}\) \}/.test(aos);
  const saPayload = /suspend:\{fn:'suspendUser',\s+payload:\(uid,x\)=>\(\{uid,suspend:true,reason:x\.reason,source:'super_admin'\}\)\}/.test(sah);

  seed(); const a = await call(SA.suspendUser, 'mod1', SUPER, { uid: 't1', suspend: true, reason: 'fraud report', source: 'adminos' });
  const s1 = state('t1');
  ck('S1', aosPayload && a.ok && a.r.changed && s1.status === 'suspended' && s1.suspended === true && s1.disabled === true && s1.revoked === 1 && count('accountSuspensions') === 1 && count('adminAudit') === 1
    && count('auditLog') === 1 && count('trustSafetyAudit') === 1 && a.r.success === true,
    'AdminOS → suspendUser: status suspended, Auth disabled, sessions revoked, 1 history + 1 adminAudit + 1 auditLog + 1 trustSafetyAudit', { a, s1 });
  const b = await call(SA.suspendUser, 'mod1', SUPER, { uid: 't2', suspend: true, reason: 'fraud report', source: 'super_admin' });
  const s2 = state('t2');
  ck('S2', saPayload && b.ok && JSON.stringify(s2) === JSON.stringify(s1), 'Super Admin → suspendUser: the identical security outcome', { s1, s2 });
  seed(); const c = await call(SA.suspendUser, 'mod', ADMIN, { uid: 't1', suspend: true, reason: 'manual button' });
  ck('S3', !c.ok && c.code === 'permission-denied' && state('t1').disabled === false && count('adminAudit') === 0, 'ordinary admin calling directly → permission-denied, nothing changes', c);
  const d = await call(SA.suspendUser, 'boss', SUPER, { uid: 'boss', suspend: true, reason: 'self' });
  ck('S4', !d.ok && d.code === 'failed-precondition' && state('boss').disabled === false, 'self-suspension refused server-side', d);
  seed(); await call(SA.suspendUser, 'mod1', SUPER, { uid: 't1', suspend: true, reason: 'abuse', source: 'adminos' });
  const e2 = await call(SA.suspendUser, 'mod1', SUPER, { uid: 't1', suspend: true, reason: 'abuse again', source: 'super_admin' });
  ck('S5', e2.ok && e2.r.changed === false && count('accountSuspensions') === 1 && count('adminAudit') === 1 && state('t1').revoked === 1,
    'duplicate suspension: second call changes nothing, no second history/audit/revocation', { e2: e2.r, hist: count('accountSuspensions') });
  seed(); const f = await call(TS.tsBanUser, 'mod1', SUPER, { uid: 't1', action: 'ban', reason: 'spam ring' });
  const fs1 = state('t1');
  const fdoc = { ...DOCS.get('users/t1') };
  const f2 = await call(TS.tsBanUser, 'mod1', SUPER, { uid: 't1', action: 'restore', reason: 'appeal' });
  const f3 = await call(TS.tsBanUser, 'mod1', SUPER, { uid: 't1', action: 'unban', reason: 'appeal upheld' });
  ck('S6', f.ok && fs1.disabled === true && fs1.status === 'banned' && fdoc.banReason === 'spam ring' && fdoc.bannedBy === 'mod1' && fdoc.suspendedUntil === null
    && !f2.ok && f2.code === 'failed-precondition'
    && f3.ok && state('t1').disabled === false && state('t1').status === 'active' && (DOCS.get('users/t1') || {}).banReason === null,
    'tsBanUser ban = status banned + banReason/bannedBy, SAME Auth lockout, never timed; "restore" cannot lift a ban; "unban" does', { fs1, f2: f2.code, f3: f3.code, after: state('t1') });
  seed(); DOCS.set('users/t1', { status: 'pending', role: 'seller' });
  await call(SA.suspendUser, 'mod1', SUPER, { uid: 't1', suspend: true, reason: 'kyc fraud' });
  const g = await call(SA.suspendUser, 'mod1', SUPER, { uid: 't1', suspend: false, reason: 'cleared' });
  ck('S7', g.ok && g.r.changed && state('t1').disabled === false && state('t1').status === 'pending' && count('accountSuspensions') === 2 && count('adminAudit') === 2,
    'unsuspend: sign-in re-enabled, PRIOR status (pending) restored, one more history + audit record', state('t1'));
  seed(); const h1 = await call(SA.suspendUser, 'mod1', SUPER, { userId: 't1', suspend: true, reason: 'old field name' });
  const h2 = await call(SA.suspendUser, 'mod1', SUPER, { uid: 't1', suspend: true });
  const h3 = await call(SA.suspendUser, 'mod1', SUPER, { uid: 't1', suspend: 'yes', reason: 'string flag' });
  const h4 = await call(TS.tsBanUser, 'mod1', SUPER, { userId: 't1', action: 'ban', reason: 'old aos payload' });
  ck('S8', h1.code === 'invalid-argument' && h2.code === 'invalid-argument' && h3.code === 'invalid-argument' && !h4.ok && state('t1').disabled === false,
    'contract: the old {userId} field, a missing reason and a non-boolean flag are refused with explicit codes; nothing applied', [h1.code, h2.code, h3.code, h4.code]);
  const i1 = await call(SA.suspendUser, 'mod1', SUPER, { uid: 'boss', suspend: true, reason: 'nope' });
  const i2 = await call(SA.suspendUser, 'mod1', SUPER, { uid: 'ghost', suspend: true, reason: 'nope' });
  ck('S9', i1.code === 'permission-denied' && i2.code === 'not-found' && state('boss').disabled === false, 'a super admin cannot be suspended; unknown uid → not-found', [i1.code, i2.code]);
  /* EXISTING-SESSION WINDOW (owner 2026-10-04): a suspended actor's still-valid token cannot act */
  seed(); DOCS.set('users/sa2', { status: 'suspended', suspended: true }); AUTHS.set('sa2', { uid: 'sa2', disabled: true, customClaims: { superAdmin: true } });
  const j1 = await call(SA.suspendUser, 'sa2', SUPER, { uid: 't1', suspend: true, reason: 'from a revoked session' });
  ck('S10', !j1.ok && j1.code === 'permission-denied' && state('t1').disabled === false, 'a SUSPENDED super admin (token still valid) cannot suspend anyone', j1);
  DOCS.set('users/adm', { status: 'suspended' });
  const j2 = await call(AOD.adminOsDispatch, 'adm', ADMIN, { op: 'adminSearchUsers', pageSize: 10 });
  const j2b = await call(AOD.adminOsDispatch, 'mod', ADMIN, { op: 'adminSearchUsers', pageSize: 10 });
  ck('S11', !j2.ok && j2.code === 'permission-denied' && j2b.ok, 'every AdminOS op re-checks the caller: a suspended admin is refused, an active admin passes', [j2.code, j2b.ok]);
  const j3 = await call(SA.setUserRole, 'sa2', SUPER, { uid: 't1', role: 'seller' });
  ck('S12', !j3.ok && j3.code === 'permission-denied', 'a suspended super admin cannot change roles (setUserRole)', j3);
  UNREADABLE = true; const j4 = await call(AOD.adminOsDispatch, 'mod', ADMIN, { op: 'adminSearchUsers', pageSize: 10 }); UNREADABLE = false;
  ck('S13', !j4.ok && j4.code === 'unavailable', 'an unreadable account record FAILS CLOSED for admin operations', j4);
  /* ── owner rulings 2026-10-04: ban distinct · 14-day suspensions · mandatory reason · audit visibility · legacy bans ── */
  seed(); await call(TS.tsBanUser, 'mod1', SUPER, { uid: 't1', action: 'ban', reason: 'fraud ring' });
  const jb1 = await call(SA.suspendUser, 'mod1', SUPER, { uid: 't1', suspend: true, reason: 'downgrade attempt' });
  const jb2 = await call(SA.suspendUser, 'mod1', SUPER, { uid: 't1', suspend: false, reason: 'lift via suspension path' });
  seed(); await call(SA.suspendUser, 'mod1', SUPER, { uid: 't2', suspend: true, reason: 'abuse' });
  const jb3 = await call(TS.tsBanUser, 'mod1', SUPER, { uid: 't2', action: 'ban', reason: 'escalated' });
  ck('S14', !jb1.ok && jb1.code === 'failed-precondition' && !jb2.ok && jb2.code === 'failed-precondition'
    && jb3.ok && state('t2').status === 'banned' && (DOCS.get('users/t2') || {}).suspendedUntil === null,
    'a ban is never downgraded or lifted by a suspension call; banning a suspended account escalates it (permanent)', [jb1.code, jb2.code, state('t2')]);

  seed(); const t0 = Date.now(); await call(SA.suspendUser, 'mod1', SUPER, { uid: 't1', suspend: true, reason: 'abuse' });
  const u1 = (DOCS.get('users/t1') || {}).suspendedUntil;
  const DAYS14 = 14 * 86400000;
  const fresh = u1 instanceof Date && Math.abs(u1.getTime() - (t0 + DAYS14)) < 60000;
  await call(SA.suspendUser, 'mod1', SUPER, { uid: 't1', suspend: true, reason: 'again' });
  const kept = (DOCS.get('users/t1') || {}).suspendedUntil === u1;
  await call(SA.suspendUser, 'mod1', SUPER, { uid: 't1', suspend: false, reason: 'early reinstate' });
  const cleared = (DOCS.get('users/t1') || {}).suspendedUntil === null;
  ck('S15', fresh && kept && cleared, 'suspension = server-fixed 14 days; re-suspending keeps the ORIGINAL end date; an early reinstate clears it', { u1, kept, cleared });

  seed(); const k1 = await call(SA.suspendUser, 'mod1', SUPER, { uid: 't1', suspend: true, reason: 'abuse', durationDays: 3 });
  const k2 = await call(TS.tsBanUser, 'mod1', SUPER, { uid: 't1', action: 'suspend', reason: 'abuse', durationDays: 3 });
  ck('S16', k1.code === 'invalid-argument' && k2.code === 'invalid-argument' && state('t1').disabled === false && count('adminAudit') === 0,
    'a client-chosen suspension length is refused by BOTH callables; nothing applied', [k1.code, k2.code]);

  seed(); await call(SA.suspendUser, 'mod1', SUPER, { uid: 't1', suspend: true, reason: 'abuse' });
  const l1 = await call(SA.suspendUser, 'mod1', SUPER, { uid: 't1', suspend: false });
  const l2 = await call(TS.tsBanUser, 'mod1', SUPER, { uid: 't1', action: 'restore' });
  const l3 = await call(TS.tsBanUser, 'mod1', SUPER, { uid: 't2', action: 'ban', reason: '   ' });
  ck('S17', l1.code === 'invalid-argument' && l2.code === 'invalid-argument' && l3.code === 'invalid-argument' && state('t1').disabled === true && state('t2').disabled === false,
    'REASON MANDATORY server-side for lock AND lift (omitted / blank → rejected, nothing changes)', [l1.code, l2.code, l3.code]);

  seed(); const m = await call(SA.suspendUser, 'mod1', SUPER, { uid: 't1', suspend: true, reason: 'chargeback abuse', source: 'adminos' });
  const ev = m.r && m.r.eventId; const al = recs('auditLog')[0] || {}; const ad = recs('adminAudit')[0] || {}; const tsa = recs('trustSafetyAudit')[0] || {}; const hi = recs('accountSuspensions')[0] || {};
  ck('S18', !!ev && al.eventId === undefined && al.details && al.details.eventId === ev && al.severity === 'high' && al.actor === 'mod1' && al.resource === 'users/t1'
    && al.action === 'suspendUser' && al.details.reason === 'chargeback abuse' && al.details.resultingState.status === 'suspended' && al.createdAt
    && ad.eventId === ev && ad.resultingState.signInEnabled === false && tsa.eventId === ev && tsa.action === 'user_suspend' && tsa.reason === 'chargeback abuse' && hi.eventId === ev,
    'audit visibility: auditLog (severity high, read by Super Admin) + adminAudit + trustSafetyAudit + history share ONE eventId with actor, target, action, time, reason, resulting state', { ev, al, tsa: tsa.action });

  seed(); DOCS.set('users/t1', { status: 'banned', role: 'seller', banReason: 'legacy' });   /* old tsBanUser: status only, Auth still enabled */
  const AS = require(path.join(FN, 'shared/account-state.js'));
  let n0 = null; try { await AS.assertAccountActive(db, 't1'); n0 = 'allowed'; } catch (e) { n0 = e.code; }
  const n1 = await call(SA.suspendUser, 'mod1', SUPER, { uid: 't1', suspend: false, reason: 'try lift as suspension' });
  const n2 = await call(TS.tsBanUser, 'mod1', SUPER, { uid: 't1', action: 'ban', reason: 'complete legacy lockout' });
  const lockedNow = state('t1').disabled === true && state('t1').status === 'banned';
  const n3 = await call(TS.tsBanUser, 'mod1', SUPER, { uid: 't1', action: 'unban', reason: 'legacy ban reviewed' });
  ck('S19', n0 === 'permission-denied' && n1.code === 'failed-precondition' && n2.ok && n2.r.changed && lockedNow && n3.ok && state('t1').status === 'active' && state('t1').disabled === false,
    'LEGACY banned record: server denies it; a suspension call cannot lift it; re-ban completes the Auth lockout; an explicit unban restores', [n0, n1.code, lockedNow, state('t1')]);

  seed(); await call(SA.suspendUser, 'mod1', SUPER, { uid: 't1', suspend: true, reason: 'abuse' });
  CREATE_FAIL = true; const o1 = await call(SA.suspendUser, 'mod1', SUPER, { uid: 't1', suspend: false, reason: 'reinstate' }); CREATE_FAIL = false;
  ck('S20', !o1.ok && o1.code === 'unavailable' && state('t1').disabled === true && state('t1').status === 'suspended' && count('adminAudit') === 1,
    'a lift whose exactly-once claim cannot be written FAILS before Auth is touched (never half-lifted, never silently skipped)', [o1.code, state('t1')]);
  seed(); const U = new Date(Date.now() + 3 * 86400000);
  DOCS.set('users/t1', { status: 'suspended', suspended: true, suspendedUntil: U, suspensionPriorStatus: 'active' });   /* half-applied: Auth still enabled */
  const q1 = await call(SA.suspendUser, 'mod1', SUPER, { uid: 't1', suspend: true, reason: 'complete the lockout' });
  ck('S21', q1.ok && q1.r.changed && state('t1').disabled === true && (DOCS.get('users/t1') || {}).suspendedUntil === U,
    'completing a HALF-APPLIED suspension locks Auth and keeps the ORIGINAL end date (no fresh 14 days)', [state('t1'), (DOCS.get('users/t1') || {}).suspendedUntil]);
  /* tsReviewReport banUser: LIVE wrote status:'banned' directly (no Auth lockout) — now the ONE contract, before the report closes */
  seed(); DOCS.set('reports/r1', { entityType: 'user', entityId: 't1', reason: 'scam listings', status: 'open' });
  const v1 = await call(TS.tsReviewReport, 'mod1', SUPER, { reportId: 'r1', action: 'approve', resolution: 'confirmed scam ring', banUser: true });
  const vd = DOCS.get('users/t1') || {};
  DOCS.set('reports/r2', { entityType: 'user', entityId: 'boss', reason: 'x', status: 'open' });
  const v2 = await call(TS.tsReviewReport, 'mod1', SUPER, { reportId: 'r2', action: 'approve', resolution: 'try to ban a super admin', banUser: true });
  ck('S22', v1.ok && vd.status === 'banned' && vd.banReason === 'confirmed scam ring' && state('t1').disabled === true && state('t1').revoked === 1
    && recs('trustSafetyAudit').some((e) => e.action === 'user_ban' && e.source === 'trust_safety_report') && recs('auditLog').some((e) => e.action === 'banUser')
    && !v2.ok && v2.code === 'permission-denied' && (DOCS.get('reports/r2') || {}).status === 'open',
    'report-driven ban = the SAME contract (Auth lockout + records); a refused ban leaves the report OPEN', { vd, v2: v2.code, r2: (DOCS.get('reports/r2') || {}).status });
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
