#!/usr/bin/env node
/* test-search-key-guest-scope.js — an anonymous Algolia search key never covers the users index.
 *
 *   node scripts/test-search-key-guest-scope.js                 # working tree — must PASS
 *   COUNTERPROOF=1 node scripts/test-search-key-guest-scope.js  # functions/algolia-secured-keys.js @ 4e9607b
 *
 * LIVE defect (production getalgoliasearchkey-00029-jus, docs/C4_C8_PRODUCTION_PRIVACY_AUTH_CENSUS.md #10): every
 * GUEST key's restrictIndices included `sokoni_users`, which the deployed users sync fills with every non-private
 * account (buyers included): display name, username, role, city, join date. Firestore `users` is owner/admin-only, so
 * the index was an anonymous way around that boundary. Owner rule: anonymous search keys must not expose sokoni_users.
 *
 * The REAL getAlgoliaSearchKey handler runs with its SDKs stubbed (onCall returns the handler; the rate limiter runs
 * on an in-memory transaction); each issued secured key is DECODED and its restrictions read back.
 *
 * PROVES
 *   G1  a guest key does NOT cover sokoni_users
 *   G2  a guest key still covers the catalogue indexes (products, shops, services, events, jobs) and the unified index
 *   G3  a signed-in key is unchanged (still covers sokoni_users — the People tab keeps working for members)
 *   G4  a driver key is unchanged (its narrow allowlist)
 *   G5  the guest visibility filter is still applied (control)
 */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const CPM = !!process.env.COUNTERPROOF;
let pass = 0, fail = 0;
const ck = (n, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 260) : '')); } };

let file = path.join(FN, 'algolia-secured-keys.js'), tmp = null;
if (CPM) { tmp = path.join(FN, '.cp-keys-' + process.pid + '.js'); fs.writeFileSync(tmp, cp.execFileSync('git', ['show', '4e9607b:functions/algolia-secured-keys.js'], { cwd: ROOT, encoding: 'utf8' })); file = tmp; }

const store = {};
const db = { collection: (c) => ({ doc: (id) => ({ _p: c + '/' + id }), add: async () => ({}) }),
  runTransaction: async (fn) => fn({ get: async (r) => ({ exists: !!store[r._p], data: () => store[r._p] }), set: (r, d) => { store[r._p] = d; } }) };
const stubs = {
  'firebase-functions/v2/https': { onCall: (opts, h) => h, HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } },
  'firebase-functions/v2/scheduler': { onSchedule: () => () => {} },
  'firebase-functions/params': { defineSecret: () => ({ value: () => 'search-only-key' }) },
  'firebase-admin': { apps: [{}], initializeApp() {}, firestore: Object.assign(() => db, { FieldValue: { serverTimestamp: () => 'ts', increment: (n) => n }, Timestamp: { fromMillis: (ms) => ({ ms }), now: () => ({ ms: Date.now() }) } }) },
};
const orig = Module._load;
Module._load = function (req) { if (stubs[req]) return stubs[req]; return orig.apply(this, arguments); };
let M;
try { M = require(file); } finally { Module._load = orig; if (tmp) fs.unlinkSync(tmp); }

const decode = (key) => {
  const raw = Buffer.from(key, 'base64').toString('utf8').slice(64);
  const out = {}; raw.split('&').forEach((kv) => { const [k, v] = kv.split('='); out[decodeURIComponent(k)] = decodeURIComponent(v || ''); });
  return out;
};
async function issue(auth) {
  const r = await M.getAlgoliaSearchKey({ auth, rawRequest: { ip: '10.0.0.' + Math.floor(Math.random() * 200) } });
  return decode(r.key);
}

(async () => {
  console.log('\nSOURCE: functions/algolia-secured-keys.js @ ' + (CPM ? '4e9607b (before) — failures below ARE the defect' : 'working tree (fix)'));
  const guest = await issue(null);
  const gi = (guest.restrictIndices || '').split(',');
  ck('G1  a guest key does NOT cover sokoni_users', gi.length > 5 && !gi.includes('sokoni_users'), gi.filter((i) => /user/.test(i)));
  ck('G2  a guest key still covers the catalogue + unified indexes', ['sokoni_products', 'sokoni_shops', 'sokoni_services', 'sokoni_events', 'sokoni_jobs', 'global_search'].every((i) => gi.includes(i)), gi);
  const user = await issue({ uid: 'u1', token: { role: 'buyer' } });
  ck('G3  a signed-in key is unchanged (still covers sokoni_users)', (user.restrictIndices || '').split(',').includes('sokoni_users'));
  const driver = await issue({ uid: 'd1', token: { role: 'driver' } });
  ck('G4  a driver key is unchanged (narrow allowlist, no users index)', driver.restrictIndices === 'sokoni_products,sokoni_shops,sokoni_services,sokoni_jobs,sokoni_products_price_asc,sokoni_products_popular', driver.restrictIndices);
  ck('G5  the guest visibility filter is still applied (control)', /NOT status:banned/.test(guest.filters || ''), guest.filters);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
