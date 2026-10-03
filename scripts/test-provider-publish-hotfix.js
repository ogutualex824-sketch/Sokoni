/* test-provider-publish-hotfix.js — the providerDispatch self-grant hotfix (OB-1 + paid-plan refusal).
 *
 * Runs the REAL functions/provider-onboarding.js handlers (providerPublish, providerActivateSubscription) over a
 * minimal in-memory Firestore, with the SDK and side modules stubbed. No network, no emulator, no production.
 *
 *   node scripts/test-provider-publish-hotfix.js                 # the hotfix (working tree) — must PASS
 *   COUNTERPROOF=1 node scripts/test-provider-publish-hotfix.js  # the DEPLOYED-identical source (de6888b, byte-equal
 *                                                                  to production archive md5 6f155e8b) — its FAILURES
 *                                                                  are the defects this hotfix removes
 *
 * PROVES
 *   publish   a first publish creates providers/{uid} CLOSED (pending_approval, not searchable / public / bookable /
 *             available) and mints NO provider claim; the onboarding projection is not self-marked searchable;
 *             re-publishing a pending or deactivated provider changes no state and mints nothing; an APPROVED provider
 *             stays active and keeps its claim (positive control); a SUSPENDED one is still refused (unchanged);
 *             content is still published
 *   plans     free_trial activates (self-serve, no payment); a PRICED plan with a client paymentRef is REFUSED and
 *             writes no subscription — monthly and yearly
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const COUNTERPROOF = !!process.env.COUNTERPROOF;
const DEPLOYED_BASE = 'de6888b';

/* ── a minimal in-memory Firestore (merge-set, get, batch) ── */
const DEL = { __delete: true };
function makeDb() {
  const data = {};
  const merge = (cur, patch) => {
    const out = Object.assign({}, cur || {});
    for (const [k, v] of Object.entries(patch)) { if (v && v.__delete) delete out[k]; else out[k] = v; }
    return out;
  };
  const ref = (p) => ({
    __path: p, id: p.split('/').pop(),
    get: async () => ({ exists: p in data, id: p.split('/').pop(), data: () => (p in data ? Object.assign({}, data[p]) : undefined) }),
    set: async (v, o) => { data[p] = o && o.merge ? merge(data[p], v) : merge({}, v); },
    update: async (v) => { if (!(p in data)) throw new Error('NOT_FOUND ' + p); data[p] = merge(data[p], v); },
    collection: (c) => col(p + '/' + c),
  });
  const col = (c) => ({
    doc: (id) => ref(c + '/' + (id || ('auto' + Math.random().toString(36).slice(2, 8)))),
    where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }), get: async () => ({ empty: true, docs: [] }) }),
  });
  const db = {
    collection: col, doc: ref,
    batch: () => { const ops = []; return { set: (r, v, o) => ops.push([r, v, o]), update: (r, v) => ops.push([r, v, { merge: true }]), commit: async () => { for (const [r, v, o] of ops) await r.set(v, o); } }; },
  };
  return { db, data };
}

const claims = {};
const CLAIM_LOG = [];
let ENV = makeDb();
const FieldValue = { serverTimestamp: () => 'TS', delete: () => DEL, increment: (n) => n, arrayUnion: (...a) => a };

/* ── load the source under test with stubbed dependencies ── */
function load() {
  let file = path.join(FN, 'provider-onboarding.js');
  if (COUNTERPROOF) {
    const src = cp.execFileSync('git', ['show', `${DEPLOYED_BASE}:functions/provider-onboarding.js`], { cwd: ROOT, encoding: 'utf8' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubfix-'));
    file = path.join(dir, 'provider-onboarding.js');
    fs.writeFileSync(file, src);
  }
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'firebase-admin/firestore') return { getFirestore: () => ENV.db, FieldValue };
    if (id === 'firebase-admin/auth') return { getAuth: () => ({ getUser: async (u) => ({ uid: u, customClaims: claims[u] || {} }), setCustomUserClaims: async (u, c) => { CLAIM_LOG.push([u, c]); claims[u] = c; } }) };
    if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {} };
    if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } };
    if (id === './search-terms') return { buildSearchTerms: () => [] };
    if (id === './legal-agreements') return { assertLegalCompliance: async () => ({ enforced: false, compliant: true }) };
    if (id === './availability') return { normalizeAvailabilityConfig: (_c, uid) => ({ uid }) };
    return orig.apply(this, arguments);
  };
  return require(file)._h;
}
const H = load();

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 160) + ']' : '')); ok ? pass++ : fail++; };
const req = (uid, data) => ({ auth: { uid, token: {} }, data: data || {}, rawRequest: { headers: {} } });
const code = async (p) => { try { await p; return null; } catch (e) { return e.code || e.message; } };
const seedDraft = (uid, extra) => ENV.db.doc('providerProfiles/' + uid).set(Object.assign({
  uid, plan: 'free_trial',
  draft: { profile: { name: 'Paul Plumbing', category: 'plumbing', bio: 'Pipes' }, coverage: { city: 'Nairobi' } },
}, extra || {}));
const prov = (uid) => ENV.data['providers/' + uid];
const minted = (uid) => CLAIM_LOG.filter(([u]) => u === uid).length;

(async () => {
  console.log('\nSOURCE: ' + (COUNTERPROOF ? `DEPLOYED-identical (${DEPLOYED_BASE}) — failures below ARE the defects` : 'hotfix (working tree)'));

  console.log('\nA. publish — a first publish is CLOSED');
  await seedDraft('new1');
  const e1 = await code(H.providerPublish(req('new1')));
  const p1 = prov('new1') || {};
  ck('A1  publish succeeds (content is still published)', e1 === null && p1.name === 'Paul Plumbing', e1);
  ck('A2  the registry row is NOT active — pending_approval', p1.status === 'pending_approval', p1.status);
  ck('A3  …not searchable, not public, not bookable, not available',
    p1.searchable === false && p1.isPublic === false && p1.acceptsBookings === false && p1.available === false,
    { s: p1.searchable, p: p1.isPublic, b: p1.acceptsBookings, a: p1.available });
  ck('A4  NO provider claim is minted', minted('new1') === 0, CLAIM_LOG.filter(([u]) => u === 'new1'));
  ck('A5  the onboarding projection is not self-marked searchable', ENV.data['providerProfiles/new1'].searchable === false, ENV.data['providerProfiles/new1'].searchable);

  console.log('\nB. re-publish never escalates');
  await code(H.providerPublish(req('new1')));
  ck('B1  a pending provider re-publishing stays pending, still no claim', prov('new1').status === 'pending_approval' && minted('new1') === 0, prov('new1').status);
  await seedDraft('deact1');
  await ENV.db.doc('providers/deact1').set({ uid: 'deact1', status: 'deactivated', searchable: false, isPublic: false });
  await code(H.providerPublish(req('deact1')));
  ck('B2  a DEACTIVATED provider is not restored by publishing, no claim', prov('deact1').status === 'deactivated' && prov('deact1').searchable === false && minted('deact1') === 0, prov('deact1').status);

  console.log('\nC. the approved provider is unaffected (positive control)');
  await seedDraft('ok1');
  await ENV.db.doc('providers/ok1').set({ uid: 'ok1', status: 'active', searchable: true, isPublic: true, acceptsBookings: true, available: true });
  const e3 = await code(H.providerPublish(req('ok1')));
  ck('C1  an approved provider publishes, stays active and public', e3 === null && prov('ok1').status === 'active' && prov('ok1').searchable === true, prov('ok1').status);
  ck('C2  …and its provider claim is (re)stamped', minted('ok1') === 1 && claims.ok1 && claims.ok1.provider === true, claims.ok1);
  ck('C3  …and the onboarding projection mirrors it as searchable', ENV.data['providerProfiles/ok1'].searchable === true);

  console.log('\nD. suspension (behaviour unchanged)');
  await seedDraft('sus1');
  await ENV.db.doc('providers/sus1').set({ uid: 'sus1', status: 'suspended' });
  ck('D1  a suspended provider is still refused', await code(H.providerPublish(req('sus1'))) === 'permission-denied' && prov('sus1').status === 'suspended' && minted('sus1') === 0);

  console.log('\nE. subscription — free trial self-serve, priced plans refused');
  const t = await code(H.providerActivateSubscription(req('new1', { plan: 'free_trial', billingCycle: 'monthly' })));
  ck('E1  free_trial activates (no payment to verify)', t === null && ENV.data['providerSubscriptions/new1'] && ENV.data['providerSubscriptions/new1'].plan === 'free_trial', t);
  for (const [plan, cycle] of [['starter', 'monthly'], ['enterprise', 'yearly'], ['professional', 'monthly']]) {
    const u = 'paid_' + plan;
    const r = await code(H.providerActivateSubscription(req(u, { plan, billingCycle: cycle, paymentRef: 'FAKE-REF-123' })));
    ck(`E2  ${plan}/${cycle} with a CLIENT paymentRef is REFUSED and writes no subscription`,
      r === 'failed-precondition' && !ENV.data['providerSubscriptions/' + u] && !(ENV.data['providerProfiles/' + u] || {}).plan, { r, sub: !!ENV.data['providerSubscriptions/' + u] });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (COUNTERPROOF) console.log('(counter-proof: failures here ARE the defects the hotfix removes)');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
