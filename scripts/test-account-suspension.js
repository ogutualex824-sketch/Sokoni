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
   node scripts/test-account-suspension.js */
require('./lib/net-firewall').install();
const path = require('path'), fs = require('fs'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 280) + ']')); ok ? pass++ : fail++; };
/* fake Firestore + Auth */
const DOCS = new Map(); let AUTO = 0;
const coll = (c) => ({
  doc: (id) => ({ get: async () => ({ exists: DOCS.has(c + '/' + id), data: () => DOCS.get(c + '/' + id) && { ...DOCS.get(c + '/' + id) } }),
    set: async (v, o) => { DOCS.set(c + '/' + id, o && o.merge ? Object.assign({}, DOCS.get(c + '/' + id) || {}, v) : { ...v }); },
    update: async (v) => { DOCS.set(c + '/' + id, Object.assign({}, DOCS.get(c + '/' + id) || {}, v)); } }),
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
const TS = require(path.join(FN, 'trust-safety.js'));
const call = async (fn, uid, token, data) => { try { return { ok: true, r: await fn({ auth: uid ? { uid, token } : null, data }) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
const SUPER = { superAdmin: true }, ADMIN = { admin: true };
const seed = () => { DOCS.clear(); AUTHS.clear(); AUTO = 0;
  for (const u of ['t1', 't2', 'boss', 'mod']) { DOCS.set('users/' + u, { status: 'active', role: 'buyer' }); AUTHS.set(u, { uid: u, disabled: false, customClaims: {} }); }
  AUTHS.get('boss').customClaims = { superAdmin: true }; };
const count = (c) => [...DOCS.keys()].filter((k) => k.startsWith(c + '/')).length;
const state = (u) => ({ status: (DOCS.get('users/' + u) || {}).status, suspended: (DOCS.get('users/' + u) || {}).suspended, disabled: AUTHS.get(u).disabled, revoked: AUTHS.get(u).revokedCount || 0 });

(async () => {
  /* the exact payloads the two UIs send (read from the source, not re-typed) */
  const aos = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8'), sah = fs.readFileSync(path.join(ROOT, 'super-admin.html'), 'utf8');
  const aosPayload = /suspend: \{ fn: "suspendUser", payload: \(uid, x\) => \(\{ uid, suspend: true, reason: x\.reason, source: "adminos" \}\) \}/.test(aos);
  const saPayload = /suspend:\{fn:'suspendUser',\s+payload:\(uid,x\)=>\(\{uid,suspend:true,reason:x\.reason,source:'super_admin'\}\)\}/.test(sah);

  seed(); const a = await call(SA.suspendUser, 'mod1', SUPER, { uid: 't1', suspend: true, reason: 'fraud report', source: 'adminos' });
  const s1 = state('t1');
  ck('S1', aosPayload && a.ok && a.r.changed && s1.status === 'suspended' && s1.suspended === true && s1.disabled === true && s1.revoked === 1 && count('accountSuspensions') === 1 && count('adminAudit') === 1,
    'AdminOS → suspendUser: status suspended, Auth disabled, sessions revoked, 1 history + 1 audit', { a, s1 });
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
  const f2 = await call(TS.tsBanUser, 'mod1', SUPER, { uid: 't1', action: 'restore', reason: 'appeal' });
  ck('S6', f.ok && fs1.disabled === true && fs1.status === 'suspended' && f2.ok && state('t1').disabled === false && state('t1').status === 'active',
    'tsBanUser delegates: ban = the canonical suspended state (Auth disabled); restore re-enables', { fs1, after: state('t1') });
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
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
