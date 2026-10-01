'use strict';
/* smsEnqueue is no longer an open relay (owner, 2026-10-01). Runs the REAL callable (functions/sms-service.js) with
   firebase-admin stubbed (in-memory Firestore + auth.getUser claims) and the shared limiter stubbed (counted).
     node scripts/test-sms-authority.js                 BASE=dda12d1 node scripts/test-sms-authority.js (must FAIL) */
const path = require('path'), fs = require('fs'), os = require('os'), Module = require('module'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const NM = process.env.SOKONI_NODE_MODULES || 'C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/node_modules';
process.env.NODE_PATH = NM; Module._initPaths(); process.env.GCLOUD_PROJECT = 'demo-sms'; process.env.FUNCTIONS_EMULATOR = 'true';
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 200) + ']')); ok ? pass++ : fail++; };

const DOCS = new Map(); let AUTO = 0;
const ref = (p) => ({ path: p, id: p.split('/').pop(), get: async () => ({ exists: DOCS.has(p), data: () => DOCS.get(p) }),
  set: async (d) => { DOCS.set(p, Object.assign({}, DOCS.get(p) || {}, d)); },
  create: async (d) => { if (DOCS.has(p)) throw Object.assign(new Error('already exists'), { code: 6 }); DOCS.set(p, d); } });
const fakeDb = { collection: (c) => ({ doc: (id) => ref(c + '/' + id), add: async (d) => { const p = c + '/a' + (++AUTO); DOCS.set(p, d); return ref(p); } }) };
const CLAIMS = { adminB: { admin: true }, plainUser: {} };
const adminStub = { apps: [1], initializeApp() {}, firestore: Object.assign(() => fakeDb, { FieldValue: { serverTimestamp: () => 'TS', increment: (n) => n } }),
  auth: () => ({ getUser: async (uid) => { if (!(uid in CLAIMS)) throw new Error('no user'); return { uid, customClaims: CLAIMS[uid] }; } }) };
const adminPath = require.resolve('firebase-admin', { paths: [NM] });
require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: adminStub };

let dir = path.join(ROOT, 'functions');
if (process.env.BASE) { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-'));
  for (const f of ['sms-service.js', 'sokoni-at.js']) fs.writeFileSync(path.join(dir, f), execSync('git show ' + process.env.BASE + ':functions/' + f, { cwd: ROOT, encoding: 'utf8' })); }
let LIMIT_CALLS = 0, LIMIT_MAX = 3;
const rlPath = path.join(dir, 'redis-rate-limiter.js');
if (process.env.BASE) fs.writeFileSync(rlPath, 'module.exports={}');
require.cache[rlPath] = { id: rlPath, filename: rlPath, loaded: true, exports: { checkRateLimit: async (req, action, o) => {
  LIMIT_CALLS++; if (LIMIT_CALLS > LIMIT_MAX) { const { HttpsError } = require('firebase-functions/v2/https'); throw new HttpsError('resource-exhausted', 'Too many'); } return { allowed: true }; } } };
const SMS = require(path.join(dir, 'sms-service.js'));
const call = async (uid, token, data) => { try { return { ok: true, r: await SMS.smsEnqueue.run({ auth: uid ? { uid, token: token || {} } : null, data, rawRequest: { headers: {} } }) }; }
  catch (e) { return { ok: false, code: e.code, reason: e.details && e.details.reason }; } };
const queued = () => [...DOCS.keys()].filter((k) => k.indexOf('smsQueue/') === 0);
DOCS.set('users/adminB', { phone: '254700000002' }); DOCS.set('users/plainUser', { phone: '254700000003' });
const ADM = { admin: true };

(async () => {
  console.log('\nSMS callable authority   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
  let r = await call('mallory', {}, { to: '254711111111', template: 'otp', vars: { code: '123456' } });
  ck('S-1', !r.ok && r.code === 'permission-denied' && queued().length === 0, 'an ordinary user cannot send an OTP-style SMS to an arbitrary number', r);
  r = await call('mallory', {}, { to: '254711111111', template: 'payment_success', vars: { amount: '50000' } });
  ck('S-2', !r.ok && queued().length === 0, 'an ordinary user cannot forge a "payment received" SMS', r);
  r = await call('mallory', {}, { to: '254711111111', template: 'promotion', vars: { message: 'click evil.link' } });
  ck('S-3', !r.ok && queued().length === 0, 'an ordinary user cannot send promotions / free text', r);
  r = await call('adminA', ADM, { to: '254711111111', template: 'otp', vars: { code: '1' } });
  ck('S-4', !r.ok && r.reason === 'TEMPLATE_NOT_CALLABLE', 'even an ADMIN cannot send a server-only template (OTP) from the app', r);
  r = await call('adminA', ADM, { to: '254711111111', template: 'admin_alert', targetUid: 'plainUser', vars: { subject: 'x' } });
  ck('S-5', !r.ok && r.reason === 'RECIPIENT_NOT_ALLOWED' && queued().length === 0, 'an admin alert may go only to an ADMIN account (cross-user recipient refused)', r);
  r = await call('adminA', ADM, { to: '254711111111', template: 'admin_alert', targetUid: 'adminB', vars: { subject: 'Queue backlog', detail: '42 pending' } });
  const q = queued().map((k) => DOCS.get(k))[0] || {};
  ck('S-6', r.ok && r.r.status === 'QUEUED' && q.to === '254700000002' && q.to !== '254711111111', 'a permitted admin alert is QUEUED to the RESOLVED admin phone — the client "to" is ignored', { r, to: q.to });
  ck('S-7', r.ok && r.r.status !== 'SENT', 'the result says QUEUED (the worker sends later), never a false "sent"');
  r = await call('adminA', ADM, { template: 'admin_alert', targetUid: 'adminB', vars: { subject: 'x', evil: 'y' } });
  const r2 = await call('adminA', ADM, { template: 'admin_alert', targetUid: 'adminB', vars: { subject: 'x'.repeat(81) } });
  const r3 = await call('adminA', ADM, { template: 'admin_alert', targetUid: 'adminB', vars: { subject: 42 } });
  ck('S-8', [r, r2, r3].every((x) => !x.ok && x.reason === 'BAD_PARAMETERS'), 'unknown / over-long / non-string parameters are refused', [r.reason, r2.reason, r3.reason]);
  LIMIT_CALLS = 0; LIMIT_MAX = 2;
  const burst = []; for (let i = 0; i < 4; i++) burst.push(await call('adminA', ADM, { template: 'admin_alert', targetUid: 'adminB', vars: { subject: 'b' + i } }));
  ck('S-9', burst.filter((x) => !x.ok && x.code === 'resource-exhausted').length === 2, 'the shared limiter caps a caller (beyond the limit → resource-exhausted)', burst.map((x) => x.ok ? x.r.status : x.code));
  r = await call(null, {}, { template: 'admin_alert', targetUid: 'adminB' });
  ck('S-10', !r.ok && r.code === 'unauthenticated', 'unauthenticated is refused');
  r = await call('adminA', ADM, { template: 'nope', targetUid: 'adminB' });
  ck('S-11', !r.ok && r.code === 'invalid-argument', 'an unknown template is refused', r);
  const audits = [...DOCS.entries()].filter(([k]) => k.indexOf('smsSendAudit/') === 0).map(([, v]) => v);
  ck('S-12', audits.length >= 8 && audits.every((a) => a.actorUid && a.outcome && !('body' in a) && !('vars' in a) && !/254700000002|254711111111/.test(JSON.stringify(a))),
    'every request (allowed or refused) is audited — actor, template, outcome — with NO body, NO params and only a masked phone', audits.slice(0, 2));
  /* server path untouched */
  const s = SMS.enqueue ? await SMS.enqueue({ to: '254700000009', template: 'otp', vars: { code: '999999' }, uid: 'x', dedupeKey: 'server1' }) : null;
  ck('S-13', s && s.queued === true, 'SERVER code (notify.js, auth-dispatch…) still sends every template through enqueue() — unaffected', s);
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
