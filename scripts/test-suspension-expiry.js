#!/usr/bin/env node
'use strict';
/**
 * SUSPENSION AUTO-EXPIRY — 14-day suspensions lifted through the ONE contract; bans never (owner rulings 2026-10-04).
 *   E1 a due suspension is lifted exactly once — two CONCURRENT job runs → one lift, one history, one audit set
 *   E2 a BAN is never lifted (job and direct system call)
 *   E3 a not-yet-due suspension is untouched (job and direct system call)
 *   E4 the system actor can only lift an expired suspension: it cannot suspend, ban, lift a ban or act for another source
 *   E5 an early manual reinstate, then the job → no-op (no second history / audit)
 *   E6 a missing / unreadable suspendedUntil is NEVER lifted (fail closed) and the daily scan flags it
 *   E7 a fresh suspension after a reinstate starts a new 14 days and is lifted again when due (new episode claim)
 *   E8 a job lift writes the SAME records as a manual reinstate: Auth re-enabled, prior status restored, history +
 *      adminAudit + auditLog (severity high) + trustSafetyAudit, one eventId, actor system:auto_expiry
 *   E9 bounded: pageSize × maxPages per run; the remainder is lifted by the next run
 * Offline: in-memory Firestore + Auth fakes; no network.
 */
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
require(path.join(ROOT, 'scripts/lib/net-firewall.js')).install();

const DOCS = new Map(); let AUTO = 0;
const tick = () => new Promise((r) => setImmediate(r));   // force interleaving so concurrent runs really race
const ms = (v) => (v instanceof Date ? v.getTime() : null);
function query(c, filters = [], lim = 1e9, after = null) {
  return {
    where: (f, op, v) => query(c, filters.concat([[f, op, v]]), lim, after),
    orderBy: () => query(c, filters, lim, after),
    limit: (n) => query(c, filters, n, after),
    startAfter: (d) => query(c, filters, lim, d),
    get: async () => {
      await tick();
      let rows = [...DOCS.entries()].filter(([k]) => k.startsWith(c + '/') && k.split('/').length === 2)
        .map(([k, v]) => ({ id: k.split('/')[1], v }));
      for (const [f, op, val] of filters) {
        rows = rows.filter(({ v }) => op === '==' ? v[f] === val : (op === '<=' ? (ms(v[f]) !== null && ms(v[f]) <= ms(val)) : true));
      }
      if (filters.some(([f]) => f === 'suspendedUntil')) rows.sort((a, b) => ms(a.v.suspendedUntil) - ms(b.v.suspendedUntil));
      if (after) { const i = rows.findIndex((r) => r.id === after.id); rows = rows.slice(i + 1); }
      rows = rows.slice(0, lim);
      return { size: rows.length, empty: !rows.length, docs: rows.map((r) => ({ id: r.id, data: () => ({ ...r.v }) })) };
    },
  };
}
const coll = (c) => Object.assign(query(c), {
  doc: (id0) => { const id = id0 === undefined ? 'a' + (++AUTO) : id0; const k = c + '/' + id; return { id,
    get: async () => { await tick(); return { exists: DOCS.has(k), data: () => DOCS.get(k) && { ...DOCS.get(k) } }; },
    set: async (v, o) => { await tick(); DOCS.set(k, o && o.merge ? Object.assign({}, DOCS.get(k) || {}, v) : { ...v }); },
    create: async (v) => { await tick(); if (DOCS.has(k)) throw Object.assign(new Error('6 ALREADY_EXISTS'), { code: 6 }); DOCS.set(k, { ...v }); } }; },
  add: async (v) => { await tick(); DOCS.set(c + '/a' + (++AUTO), { ...v }); return { id: 'a' + AUTO }; },
});
const db = { collection: coll };
const AUTHS = new Map();
const auth = {
  getUser: async (uid) => { await tick(); if (!AUTHS.has(uid)) throw new Error('no user'); return { ...AUTHS.get(uid) }; },
  updateUser: async (uid, p) => { await tick(); AUTHS.set(uid, Object.assign({}, AUTHS.get(uid), p)); },
  revokeRefreshTokens: async () => {},
};
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (o, h) => h };
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: { serverTimestamp: () => 'TS' }, Timestamp: { fromMillis: (m) => new Date(m) } };
  if (id === 'firebase-admin/auth') return { getAuth: () => auth };
  return orig.apply(this, arguments);
};
const JOB = require(path.join(FN, 'account-suspension-expiry.js'));
const { setSuspension } = require(path.join(FN, 'shared/account-suspension.js'));
const DAY = 86400000;
const T0 = Date.UTC(2026, 9, 4, 12, 0, 0);
const run = (now, extra) => JOB._runSuspensionExpiry(Object.assign({ db, auth, now, serverTs: () => 'TS', toTs: (m) => new Date(m) }, extra || {}));
const recs = (c, uid) => [...DOCS.entries()].filter(([k]) => k.startsWith(c + '/')).map(([, v]) => v)
  .filter((v) => !uid || v.uid === uid || v.targetUid === uid || v.entityId === uid || v.resource === 'users/' + uid);
const seed = () => { DOCS.clear(); AUTHS.clear(); AUTO = 0;
  for (const u of ['boss', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6']) { DOCS.set('users/' + u, { status: 'active' }); AUTHS.set(u, { uid: u, disabled: false, customClaims: {} }); }
  AUTHS.get('boss').customClaims = { superAdmin: true }; };
const BOSS = { uid: 'boss', superAdmin: true };
const manual = (uid, suspend, now, extra) => setSuspension(Object.assign({ db, auth, serverTs: () => 'TS', now: () => now, actor: BOSS, uid, suspend, reason: 'ops decision', source: 'adminos' }, extra || {}));
const sys = (uid, now, extra) => setSuspension(Object.assign({ db, auth, serverTs: () => 'TS', now: () => now, actor: { system: true }, uid, suspend: false, kind: 'suspend', source: 'auto_expiry' }, extra || {}))
  .then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e.code }));
const st = (uid) => ({ status: (DOCS.get('users/' + uid) || {}).status, disabled: AUTHS.get(uid).disabled });

(async () => {
  /* E1 */
  seed(); DOCS.set('users/u1', { status: 'pending' });
  await manual('u1', true, T0);
  const [r1, r2] = await Promise.all([run(T0 + 15 * DAY), run(T0 + 15 * DAY)]);
  ck('E1', r1.lifted + r2.lifted === 1 && st('u1').status === 'pending' && st('u1').disabled === false
    && recs('accountSuspensions', 'u1').filter((e) => e.action === 'reinstated').length === 1 && recs('auditLog', 'u1').filter((e) => e.action === 'reinstateUser').length === 1
    && recs('suspensionLifts').length === 1,
    'a due suspension is lifted EXACTLY ONCE even with two concurrent job runs', { r1, r2, st: st('u1') });

  /* E2 */
  seed(); await manual('u2', true, T0, { kind: 'ban' });
  DOCS.set('users/u2', Object.assign({}, DOCS.get('users/u2'), { suspendedUntil: new Date(T0 - DAY) }));   /* forged past date on a ban */
  const e2a = await run(T0 + 30 * DAY); const e2b = await sys('u2', T0 + 30 * DAY);
  ck('E2', e2a.lifted === 0 && e2b.ok && e2b.r.changed === false && st('u2').status === 'banned' && st('u2').disabled === true,
    'a BAN is never lifted — not by the job, not by a direct system call, even with a past date on it', { e2a, e2b, st: st('u2') });

  /* E3 */
  seed(); await manual('u3', true, T0);
  const e3a = await run(T0 + 13 * DAY); const e3b = await sys('u3', T0 + 13 * DAY);
  ck('E3', e3a.lifted === 0 && e3b.ok && e3b.r.skipped === 'not_due' && st('u3').status === 'suspended' && st('u3').disabled === true,
    'a not-yet-due suspension (day 13) is untouched', { e3a, e3b: e3b.r, st: st('u3') });

  /* E4 */
  seed(); await manual('u5', true, T0, { kind: 'ban' });
  const x1 = await sys('u4', T0, { suspend: true, reason: 'x' });
  const x2 = await sys('u4', T0, { suspend: true, kind: 'ban', reason: 'x' });
  const x3 = await sys('u5', T0 + 99 * DAY, { kind: 'ban' });
  const x4 = await sys('u4', T0, { source: 'adminos' });
  ck('E4', [x1, x2, x3, x4].every((x) => !x.ok && x.code === 'permission-denied') && st('u4').disabled === false && st('u5').status === 'banned',
    'the system actor can ONLY lift an expired suspension: suspend / ban / lift-ban / other source → permission-denied', [x1.code, x2.code, x3.code, x4.code]);

  /* E5 */
  seed(); await manual('u1', true, T0); await manual('u1', false, T0 + 2 * DAY);
  const before = recs('accountSuspensions', 'u1').length;
  const e5 = await run(T0 + 15 * DAY);
  ck('E5', e5.lifted === 0 && recs('accountSuspensions', 'u1').length === before && recs('auditLog', 'u1').length === 2,
    'early manual reinstate, then the job → no-op (no second history / audit)', { e5, before });

  /* E6 */
  seed(); DOCS.set('users/u6', { status: 'suspended', suspended: true, suspendedUntil: '2026-01-01' }); AUTHS.get('u6').disabled = true;
  DOCS.set('users/u4', { status: 'suspended', suspended: true }); AUTHS.get('u4').disabled = true;
  const e6 = await run(T0 + 400 * DAY, { flagScan: true }); const e6b = await sys('u6', T0 + 400 * DAY);
  ck('E6', e6.lifted === 0 && e6.flagged === 2 && e6b.ok && e6b.r.skipped === 'until_unreadable' && st('u6').disabled === true && st('u4').disabled === true
    && DOCS.has('suspensionExpiryFlags/u6') && DOCS.has('suspensionExpiryFlags/u4'),
    'missing / unreadable suspendedUntil is NEVER lifted (fail closed) and the daily scan flags both', { e6, e6b: e6b.r });

  /* E7 */
  seed(); await manual('u1', true, T0); await run(T0 + 15 * DAY);
  await manual('u1', true, T0 + 20 * DAY);
  const u2nd = ms((DOCS.get('users/u1') || {}).suspendedUntil);
  const e7a = await run(T0 + 30 * DAY); const e7b = await run(T0 + 35 * DAY);
  ck('E7', u2nd === T0 + 34 * DAY && e7a.lifted === 0 && e7b.lifted === 1 && recs('suspensionLifts').length === 2 && st('u1').disabled === false,
    'a fresh suspension after a reinstate starts a NEW 14 days and is lifted again when due (separate episode claim)', { u2nd, e7a, e7b });

  /* E8 */
  seed(); DOCS.set('users/u1', { status: 'pending' }); await manual('u1', true, T0); await run(T0 + 14 * DAY);
  const al = recs('auditLog', 'u1').find((e) => e.action === 'reinstateUser') || {};
  const tsa = recs('trustSafetyAudit', 'u1').find((e) => e.action === 'user_restore') || {};
  const ad = recs('adminAudit', 'u1').find((e) => e.action === 'account_reinstated') || {};
  const hi = recs('accountSuspensions', 'u1').find((e) => e.action === 'reinstated') || {};
  const ev = hi.eventId;
  ck('E8', st('u1').status === 'pending' && st('u1').disabled === false && al.severity === 'high' && al.actor === 'system:auto_expiry'
    && al.details && al.details.eventId === ev && tsa.eventId === ev && ad.eventId === ev && hi.source === 'auto_expiry' && /14 days/.test(hi.reason || '')
    && (DOCS.get('users/u1') || {}).suspendedUntil === null,
    'a job lift (exactly at day 14) = a manual reinstate: Auth on, prior status back, history + adminAudit + auditLog(high) + trustSafetyAudit share one eventId', { al, tsa: tsa.action, hi });

  /* E9 */
  seed(); for (const u of ['u1', 'u2', 'u3', 'u4', 'u5']) await manual(u, true, T0);
  const e9a = await run(T0 + 15 * DAY, { pageSize: 2, maxPages: 2 }); const e9b = await run(T0 + 15 * DAY, { pageSize: 2, maxPages: 2 });
  ck('E9', e9a.lifted === 4 && e9a.pages === 2 && e9b.lifted === 1 && ['u1', 'u2', 'u3', 'u4', 'u5'].every((u) => st(u).disabled === false),
    'bounded: pageSize × maxPages per run; the remainder is lifted by the next run', { e9a, e9b });

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
