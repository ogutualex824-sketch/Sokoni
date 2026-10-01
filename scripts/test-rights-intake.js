#!/usr/bin/env node
'use strict';
/* ============================================================================
   Data-rights intake — open to non-account holders, but abuse-controlled (2026-10-01)
   ----------------------------------------------------------------------------
   Real handler (functions/facebook-data-deletion.js submitDataRightsRequest, run via .run) with
   firebase-admin replaced by the in-memory Firestore fake.
     A  valid request accepted; all six KDPA rights still map (enum fix preserved)
     B  no raw IP stored (pseudonymised ipKey); non-string phone/details refused (was a 500)
     C  per-client 5/hour and per-email 3/day limits → resource-exhausted; limiter failure → refused
     D  App Check enforced (source)
   node scripts/test-rights-intake.js
   ============================================================================ */
const path = require('path'), fs = require('fs'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 300) : '')); } };
const F = makeFakeFirestore();
const ff = () => F.db; ff.FieldValue = F.FieldValue; ff.Timestamp = F.Timestamp;
const fa = Module._resolveFilename('firebase-admin', { id: path.join(FN, 'x.js'), filename: path.join(FN, 'x.js'), paths: Module._nodeModulePaths(FN) });
require.cache[fa] = { id: fa, filename: fa, loaded: true, exports: { apps: [1], initializeApp() {}, firestore: ff, auth: () => ({}) } };
const M = require(path.join(FN, 'facebook-data-deletion.js'));
const run = (data, ip) => M.submitDataRightsRequest.run({ auth: null, data, rawRequest: { headers: { 'x-forwarded-for': 'spoof, ' + (ip || '41.1.1.1') }, ip: '10.0.0.1' } });
async function tryRun(d, ip) { try { return { ok: true, v: await run(d, ip) }; } catch (e) { return { ok: false, code: e.code, details: e.details }; } }
const rows = () => [...F.db._store.entries()].filter(([p]) => p.startsWith('dataRightsRequests/')).map(([, v]) => v.data);

(async () => {
  console.log('Data-rights intake\n');
  const rights = ['deletion', 'access', 'rectification', 'restriction', 'portability', 'objection'];
  const res = [];
  for (let i = 0; i < rights.length; i++) res.push(await tryRun({ name: 'A Person', email: `p${i}@example.com`, type: rights[i] }, '41.1.2.' + i));
  ck('A1 all six KDPA rights are accepted (enum alignment preserved)', res.every((r) => r.ok), res.filter((r) => !r.ok));
  const r0 = rows()[0];
  ck('B1 no raw IP stored — a pseudonymised ipKey instead', r0 && !('ip' in r0) && /^[0-9a-f]{32}$/.test(r0.ipKey) && !JSON.stringify(rows()).includes('41.1.2.'), r0);
  const bad = await tryRun({ name: 'A', email: 'x@example.com', type: 'access', phone: { $gt: '' } }, '41.1.3.1');
  ck('B2 a non-string phone is refused with invalid-argument (was a crash)', !bad.ok && bad.code === 'invalid-argument', bad);
  let last; for (let i = 0; i < 6; i++) last = await tryRun({ name: 'B', email: `c${i}@example.com`, type: 'access' }, '41.9.9.9');
  ck('C1 a 6th request from one client within the hour → resource-exhausted with retryAfterSeconds', !last.ok && last.code === 'resource-exhausted' && last.details && last.details.retryAfterSeconds > 0, last);
  let lastE; for (let i = 0; i < 4; i++) lastE = await tryRun({ name: 'C', email: 'same@example.com', type: 'access' }, '41.8.8.' + i);
  ck('C2 a 4th request for one email within a day → resource-exhausted', !lastE.ok && lastE.code === 'resource-exhausted', lastE);
  const orig = F.db.runTransaction; F.db.runTransaction = async () => { throw new Error('contention'); };
  const down = await tryRun({ name: 'D', email: 'd@example.com', type: 'access' }, '41.7.7.7');
  F.db.runTransaction = orig;
  ck('C3 limiter failure → refused (fail closed), nothing stored', !down.ok && down.code === 'unavailable' && !rows().some((r) => r.email === 'd@example.com'), down);
  const src = fs.readFileSync(path.join(FN, 'facebook-data-deletion.js'), 'utf8');
  ck('D1 App Check enforced on submitDataRightsRequest', /exports\.submitDataRightsRequest = onCall\(\s*\{ region: REGION, enforceAppCheck: true \}/.test(src));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
