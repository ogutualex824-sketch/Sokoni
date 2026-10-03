#!/usr/bin/env node
'use strict';
/**
 * ONE ROLE AUTHORITY — setUserRole = the LIVE AdminOS Authority Core (05df4c9) carried line-for-line; adminUpdateUserRole
 * (AdminOS) delegates to it (owner 2026-10-04: "existing permissions → resolve role → derive role permissions → PRESERVE
 * unrelated permissions → atomic write → audit → idempotent retry. NEVER permissions = rolePermissions").
 *   R1 unrelated claims are PRESERVED (merchantId, posId, custom flags); stale governed roles cleared; users/{uid}.role mirrored
 *   R2 the same request (same requestId) twice → ONE Auth mutation, ONE audit; the retry returns idempotent:true
 *   R3 the role change is audited: auditLog severity high — actor, target, action, newRole, claims, eventId, reason
 *   R4 unauthorized callers are denied (no auth · admin without superAdmin · forged adminPermissions) — nothing mutates
 *   R5 malformed roles are denied (unknown, empty, object, case/space variants, 'provider') — nothing mutates
 *   R6 browser-supplied permissions cannot be granted (claims / permissions / customClaims / additionalClaims in the payload)
 *   R7 Role A + independent permission X → Role B keeps X (superAdmin ⇒ admin; permsVersion never downgrades)
 *   R8 the same request twice CONCURRENTLY → one effective change, no duplicated security side effect
 *   R10 the AdminOS Audit Logs feed (adminAudit role_updated) records each role change once, same eventId as auditLog
 *   R9 AdminOS adminUpdateUserRole delegates to the same core: claims preserved (LIVE overwrote them); additionalClaims refused
 * Offline: in-memory Firestore (serialized transactions) + Auth fakes; no network.
 */
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 320) + ']')); ok ? pass++ : fail++; };
require(path.join(ROOT, 'scripts/lib/net-firewall.js')).install();

const DOCS = new Map(); let AUTO = 0;
const tick = () => new Promise((r) => setImmediate(r));
const TS = () => { const m = Date.now(); return { toMillis: () => m, _ts: true }; };
let txChain = Promise.resolve();
const ref = (c, id) => { const k = c + '/' + id; return { id, _k: k,
  get: async () => { await tick(); return { exists: DOCS.has(k), data: () => DOCS.get(k) && { ...DOCS.get(k) } }; },
  set: async (v, o) => { await tick(); DOCS.set(k, o && o.merge ? Object.assign({}, DOCS.get(k) || {}, v) : { ...v }); },
  update: async (v) => { await tick(); if (!DOCS.has(k)) throw new Error('NOT_FOUND'); DOCS.set(k, Object.assign({}, DOCS.get(k), v)); } }; };
const coll = (c) => ({
  doc: (id) => ref(c, id === undefined ? 'a' + (++AUTO) : id),
  add: async (v) => { await tick(); DOCS.set(c + '/a' + (++AUTO), { ...v }); return { id: 'a' + AUTO }; },
  where: () => coll(c), limit: () => coll(c), get: async () => ({ empty: true, size: 0, docs: [] }),
});
const db = {
  collection: coll,
  /* serialized: one transaction at a time (Firestore's guarantee for conflicting docs) */
  runTransaction: (fn) => { const p = txChain.then(async () => {
    const writes = [];
    const tx = { get: (r) => r.get(), set: (r, v, o) => writes.push(() => r.set(v, o)), update: (r, v) => writes.push(() => r.update(v)) };
    const out = await fn(tx); for (const w of writes) await w(); return out; });
    txChain = p.catch(() => {}); return p; },
};
const AUTHS = new Map(); let MUTATIONS = [];
const auth = {
  getUser: async (uid) => { await tick(); if (!AUTHS.has(uid)) throw new Error('no user'); return JSON.parse(JSON.stringify(AUTHS.get(uid))); },
  setCustomUserClaims: async (uid, c) => { await tick(); MUTATIONS.push({ uid, claims: { ...c } }); AUTHS.get(uid).customClaims = { ...c }; },
  updateUser: async () => {}, revokeRefreshTokens: async () => {},
};
class HttpsError extends Error { constructor (c, m) { super(m); this.code = c; } }
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: { serverTimestamp: TS, increment: (n) => n }, Timestamp: { fromMillis: (m) => ({ toMillis: () => m }), now: TS } };
  if (id === 'firebase-admin/auth') return { getAuth: () => auth };
  if (id === 'firebase-functions/v2/https') return { onCall: (o, h) => (h || o), HttpsError };
  if (id === './redis-rate-limiter') return { checkRateLimit: async () => {} };
  if (id === './pos-audit') return { writeAudit: async () => {} };
  return orig.apply(this, arguments);
};
const SA = require(path.join(FN, 'super-admin.js'));
const AO = require(path.join(FN, 'admin-os.js'));
const call = async (fn, uid, token, data) => { try { return { ok: true, r: await fn({ auth: uid ? { uid, token } : null, data }) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
const BOSS = { superAdmin: true, admin: true };
const seed = () => { DOCS.clear(); AUTHS.clear(); AUTO = 0; MUTATIONS = []; txChain = Promise.resolve();
  DOCS.set('users/boss', { status: 'active' }); AUTHS.set('boss', { uid: 'boss', customClaims: BOSS });
  DOCS.set('users/t1', { status: 'active', role: 'seller' });
  AUTHS.set('t1', { uid: 't1', email: 't1@example.test', customClaims: { seller: true, merchantId: 'm_123', posId: 'till_7', featureX: true, permsVersion: 1 } }); };
const claims = (u) => AUTHS.get(u).customClaims;
const adminAudits = () => [...DOCS.entries()].filter(([k]) => k.startsWith('adminAudit/')).map(([, v]) => v).filter((v) => v.action === 'role_updated');
const audits = () => [...DOCS.entries()].filter(([k]) => k.startsWith('auditLog/')).map(([, v]) => v).filter((v) => v.action === 'setUserRole');

(async () => {
  /* R1 */
  seed(); const a = await call(SA.setUserRole, 'boss', BOSS, { uid: 't1', role: 'driver', requestId: 'r1' });
  const c1 = claims('t1');
  ck('R1', a.ok && c1.merchantId === 'm_123' && c1.posId === 'till_7' && c1.featureX === true && c1.driver === true && c1.seller === false
    && c1.admin === false && (DOCS.get('users/t1') || {}).role === 'driver',
    'unrelated claims PRESERVED; stale governed role cleared; users/{uid}.role mirrored', { a, c1 });

  /* R2 */
  seed(); const b1 = await call(SA.setUserRole, 'boss', BOSS, { uid: 't1', role: 'moderator', requestId: 'same-req' });
  const b2 = await call(SA.setUserRole, 'boss', BOSS, { uid: 't1', role: 'moderator', requestId: 'same-req' });
  ck('R2', b1.ok && b2.ok && b2.r.idempotent === true && MUTATIONS.length === 1 && audits().length === 1 && b1.r.eventId === b2.r.eventId,
    'same requestId twice → ONE Auth mutation, ONE audit; the retry returns idempotent:true', { b2: b2.r, muts: MUTATIONS.length, audits: audits().length });

  /* R3 */
  seed(); const g = await call(SA.setUserRole, 'boss', BOSS, { uid: 't1', role: 'admin', requestId: 'r3', reason: 'ops lead promotion' });
  const au = audits()[0] || {};
  ck('R3', g.ok && au.severity === 'high' && au.actor === 'boss' && au.resource === 'users/t1' && au.details && au.details.newRole === 'admin'
    && au.details.eventId === g.r.eventId && au.details.claims && au.details.claims.merchantId === 'm_123' && au.details.reason === 'ops lead promotion' && au.createdAt
    && (DOCS.get('controlEvents/' + g.r.eventId) || {}).status === 'committed',
    'role change audited (auditLog high: actor, target, action, newRole, resulting claims, eventId, reason) + controlEvents committed', au);

  /* R4 */
  seed();
  const d1 = await call(SA.setUserRole, null, null, { uid: 't1', role: 'admin' });
  const d2 = await call(SA.setUserRole, 'mod', { admin: true }, { uid: 't1', role: 'admin' });
  const d3 = await call(SA.setUserRole, 'mod', { admin: true, adminPermissions: { roles: { write: true } } }, { uid: 't1', role: 'superAdmin' });
  const d4 = await call(AO.adminUpdateUserRole, 'mod', { admin: true }, { uid: 't1', role: 'admin' });
  ck('R4', [d1, d2, d3, d4].every((x) => !x.ok) && MUTATIONS.length === 0 && claims('t1').seller === true,
    'unauthorized callers denied (no auth · admin only · forged adminPermissions · AdminOS path) — nothing mutates', [d1.msg, d2.msg, d3.msg, d4.msg].map((m) => String(m).slice(0, 40)));

  /* R5 */
  seed(); const bad = ['root', '', { admin: true }, 'SuperAdmin', 'admin ', 'provider', null];
  const r5 = []; for (const role of bad) r5.push(await call(SA.setUserRole, 'boss', BOSS, { uid: 't1', role }));
  ck('R5', r5.every((x) => !x.ok) && MUTATIONS.length === 0, 'malformed roles denied (unknown, empty, object, case/space variants, provider, null) — nothing mutates', r5.map((x) => x.ok));

  /* R6 */
  seed(); const f = await call(SA.setUserRole, 'boss', BOSS, { uid: 't1', role: 'seller', requestId: 'r6',
    claims: { superAdmin: true, admin: true }, permissions: { all: true }, customClaims: { admin: true }, additionalClaims: { superAdmin: true }, superAdmin: true, admin: true });
  const c6 = claims('t1');
  ck('R6', f.ok && c6.superAdmin === false && c6.admin === false && !('permissions' in c6) && !('claims' in c6) && !('customClaims' in c6) && !('additionalClaims' in c6) && c6.seller === true,
    'browser-supplied permissions cannot be granted (claims/permissions/customClaims/additionalClaims/top-level flags ignored)', c6);

  /* R7 */
  seed(); AUTHS.get('t1').customClaims = { admin: true, department: 'ops', teamId: 'T9', permsVersion: 7 };
  await call(SA.setUserRole, 'boss', BOSS, { uid: 't1', role: 'superAdmin', requestId: 'r7a' });
  const c7a = { ...claims('t1') };
  await call(SA.setUserRole, 'boss', BOSS, { uid: 't1', role: 'moderator', requestId: 'r7b' });
  const c7 = claims('t1');
  ck('R7', c7a.superAdmin === true && c7a.admin === true && c7.department === 'ops' && c7.teamId === 'T9' && c7.moderator === true && c7.admin === false && c7.superAdmin === false && c7.permsVersion === 7,
    'Role A + independent X → Role B keeps X; superAdmin ⇒ admin; permsVersion never downgrades', { c7a, c7 });

  /* R8 */
  seed(); const [h1, h2] = await Promise.all([
    call(SA.setUserRole, 'boss', BOSS, { uid: 't1', role: 'driver', requestId: 'dbl-click' }),
    call(SA.setUserRole, 'boss', BOSS, { uid: 't1', role: 'driver', requestId: 'dbl-click' })]);
  ck('R8', h1.ok && h2.ok && MUTATIONS.length === 1 && audits().length === 1 && [...DOCS.keys()].filter((k) => k.startsWith('controlEvents/')).length === 1,
    'the same request twice CONCURRENTLY → one Auth mutation, one audit, one control event', { h1: h1.r, h2: h2.r, muts: MUTATIONS.length });

  /* R9 */
  seed(); const i1 = await call(AO.adminUpdateUserRole, 'boss', BOSS, { uid: 't1', role: 'driver', requestId: 'aos-1' });
  const c9 = { ...claims('t1') };
  const i2 = await call(AO.adminUpdateUserRole, 'boss', BOSS, { uid: 't1', role: 'seller', additionalClaims: { department: 'x' } });
  ck('R9', i1.ok && c9.merchantId === 'm_123' && c9.posId === 'till_7' && c9.featureX === true && c9.permsVersion === 1 && c9.driver === true && audits().length === 1
    && !i2.ok && i2.code === 'invalid-argument' && MUTATIONS.length === 1,
    'AdminOS adminUpdateUserRole → the SAME core: claims preserved (LIVE overwrote them), audited once; additionalClaims refused', { c9, i2: i2.code });

  /* R10 — AdminOS Audit Logs feed (adminAudit) keeps role changes (LIVE adminUpdateUserRole wrote 'role_updated'), same eventId */
  seed(); const k1 = await call(AO.adminUpdateUserRole, 'boss', BOSS, { uid: 't1', role: 'moderator', requestId: 'aos-aa', reason: 'shift lead' });
  await call(AO.adminUpdateUserRole, 'boss', BOSS, { uid: 't1', role: 'moderator', requestId: 'aos-aa', reason: 'shift lead' });
  const aa = adminAudits();
  ck('R10', k1.ok && aa.length === 1 && aa[0].eventId === k1.r.eventId && aa[0].targetUid === 't1' && aa[0].previousRole === 'seller' && aa[0].newRole === 'moderator'
    && aa[0].performedBy === 'boss' && aa[0].reason === 'shift lead' && aa[0].resultingState.role === 'moderator' && aa[0].createdAt
    && audits().length === 1 && audits()[0].details.eventId === k1.r.eventId,
    'role change visible in the AdminOS feed: ONE adminAudit role_updated (actor, target, previous→new, reason, result, eventId) — retry adds none', aa);

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
