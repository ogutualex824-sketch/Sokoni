#!/usr/bin/env node
/* test-account-shop-discovery.js — account lifecycle × the ONE shop discovery gate (owner 2026-10-04).
 *   freeze / suspend → shop HELD (invisible everywhere) → account reactivated → evaluator → released ONLY if every
 *   condition passes (decision record, freeze lifted, active, visible, C1 category, owner, seller, business).
 *   Reactivation never publishes a shop itself. Pre-hold (legacy) shops keep their compatibility behaviour.
 * REAL account-status + application-lifecycle.projectSeller + shop-discovery-release + business-category +
 * discovery-eligibility on the transactional fake store.   node scripts/test-account-shop-discovery.js
 */
'use strict';
const fs = require('fs'), path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const ck = (n, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 260) : '')); } };

const CLAIMS = { admin_1: { admin: true } };
let ENV = null;
const AUTH = () => ({ getUser: async (u) => ({ uid: u, customClaims: CLAIMS[u] || {} }), setCustomUserClaims: async (u, c) => { CLAIMS[u] = c; }, revokeRefreshTokens: async () => {} });
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin') return { apps: [1], initializeApp() {}, firestore: Object.assign(() => ENV.db, { FieldValue: ENV.FieldValue }), auth: AUTH };
  if (id === 'firebase-admin/firestore') return { getFirestore: () => ENV.db, FieldValue: ENV.FieldValue };
  if (id === 'firebase-admin/auth') return { getAuth: AUTH };
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, debug() {}, error() {} };
  if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h, onDocumentCreated: (_o, h) => h, onDocumentUpdated: (_o, h) => h, onDocumentDeleted: (_o, h) => h };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => ({ run: h }), onRequest: (_o, h) => h, HttpsError: class extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } } };
  if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => 'x' }), defineString: () => ({ value: () => '' }) };
  if (id === './notify' || id === './search-terms') return { notify: async () => {}, buildSearchTerms: () => [], searchTerms: () => [] };
  return origReq.apply(this, arguments);
};
console.info = console.error = () => {};
const newEnv = () => { const F = makeFakeFirestore({}); ENV = { db: F.db, FieldValue: F.FieldValue }; };
newEnv();
const BCAT = require(path.join(FN, 'business-category.js'));
const DE = require(path.join(FN, 'discovery-eligibility.js'));
const LC = require(path.join(FN, 'application-lifecycle.js'))._internal;
const AS = require(path.join(FN, 'account-status.js'));
const get = async (p) => { const s = await ENV.db.doc(p).get(); return s.exists ? s.data() : null; };
const call = async (fn, uid, data, token) => { try { return await AS[fn].run({ auth: uid ? { uid, token: token || {} } : null, data: data || {} }); } catch (e) { return { err: e.code, reason: e.details && e.details.reason }; } };
const released = (d) => !!d && d.discovery === 'ELIGIBLE' && d._noIndex === false && d.searchable === true;
const heldDoc = (d) => !!d && d.discovery === 'HELD' && d._noIndex === true && d.searchable !== true;
const visible = async (uid) => BCAT.shopEligibility(await get('shops/' + uid)).eligible && !!(await DE.prepareForIndex(ENV.db, 'sellers', uid, await get('sellers/' + uid), {}));

/* ONE store for the whole run: account-status binds admin.firestore() at module load (as in production) */
async function approvedShop(uid) {
  await ENV.db.doc('users/' + uid).set({ uid });
  await ENV.db.doc('applications/APP_' + uid).set({ uid, status: 'approved', decidedBy: 'admin_1' });
  await ENV.db.doc('applicationDecisions/APP_' + uid).set({ applicationId: 'APP_' + uid, status: 'approved', decidedBy: 'admin_1', applicantUid: uid });
  await LC.projectSeller(ENV.db, { applicationId: 'APP_' + uid, name: 'Shop ' + uid, category: 'Shoes' }, uid, true, { decidedBy: 'admin_1' });
}

(async () => {
  /* ── R: the round trip ── */
  await approvedShop('U1');
  ck('R0  precondition: an approved shop is released and visible', released(await get('shops/U1')) && await visible('U1'));
  await call('accountDeactivate', 'U1', { confirm: true });
  ck('R1  self-deactivation RE-HOLDS the shop and its search row (invisible everywhere)', heldDoc(await get('shops/U1')) && heldDoc(await get('sellers/U1')) && !(await visible('U1')), await get('shops/U1'));
  const rr = await call('accountReactivate', 'U1');
  ck('R2  reactivation → the evaluator RELEASES it again (every check passes)', !rr.err && released(await get('shops/U1')) && await visible('U1'), [rr, (await get('shops/U1')).discoveryHeldReasons]);

  /* ── B: reactivation cannot bypass any check ── */
  const bypass = async (label, uid, breakIt) => {
    await approvedShop(uid);
    await call('accountDeactivate', uid, { confirm: true });
    await breakIt(uid);
    const r = await call('accountReactivate', uid);
    ck(label, !r.err && heldDoc(await get('shops/' + uid)) && !(await visible(uid)), { r, reasons: (await get('shops/' + uid)).discoveryHeldReasons });
  };
  await bypass('B1  revoked approval (decision no longer approved) → reactivation leaves the shop HELD', 'U2', (u) => ENV.db.doc('applicationDecisions/APP_' + u).set({ status: 'rejected' }, { merge: true }));
  await bypass('B2  decision record missing → HELD', 'U3', (u) => ENV.db.doc('applicationDecisions/APP_' + u).delete());
  await bypass('B3  category removed → HELD', 'U4', (u) => ENV.db.doc('shops/' + u).set({ business: { category: null, source: 'application', applicationId: 'APP_' + u } }, { merge: true }));
  await bypass('B4  seller no longer active → HELD', 'U5', (u) => ENV.db.doc('sellers/' + u).set({ status: 'suspended', active: false }, { merge: true }));
  await bypass('B5  business record gone → HELD', 'U6', (u) => ENV.db.doc('businesses/' + u).delete());
  await bypass('B6  owner mismatch (the shop names another owner) → HELD', 'U7', async (u) => { await ENV.db.doc('shops/' + u).set({ sellerUid: 'SOMEONE', ownerId: 'SOMEONE' }, { merge: true });
    await ENV.db.doc('sellers/SOMEONE').set({ uid: 'SOMEONE', status: 'active', active: true, approvedAt: 1 }); });   /* a fully valid seller — ONLY the owner check can refuse */
  await bypass('B7  decided by a non-admin → HELD', 'U8', (u) => ENV.db.doc('applicationDecisions/APP_' + u).set({ decidedBy: 'not_an_admin' }, { merge: true }));
  await bypass('B8  a shop moderation-hidden before the freeze (isVisible false) stays HELD', 'U9', async (u) => {
    const s = await get('shops/' + u); await ENV.db.doc('shops/' + u).set({ preDeactivationVisible: false }, { merge: true }); void s; });

  /* ── A: admin freeze ── */
  await approvedShop('UA');
  await call('adminSetAccountActive', 'admin_1', { uid: 'UA', active: false }, { admin: true });
  const self = await call('accountReactivate', 'UA');
  ck('A1  admin freeze → shop HELD, and the owner cannot self-reactivate it', self.err === 'failed-precondition' && self.reason === 'ADMIN_FROZEN' && heldDoc(await get('shops/UA')), self);
  await call('adminSetAccountActive', 'admin_1', { uid: 'UA', active: true }, { admin: true });
  ck('A2  admin restore → the evaluator releases it (every check passes)', released(await get('shops/UA')) && await visible('UA'));
  await approvedShop('UF');
  await ENV.db.doc('accountFreezes/UF').set({ active: true, by: 'admin' });
  const ef = await require(path.join(FN, 'shop-discovery-release.js')).evaluateShopDiscovery(ENV.db, 'UF', { FieldValue: ENV.FieldValue, getUser: AUTH().getUser });
  ck('A3  an ACTIVE account freeze alone (shop not otherwise touched) re-holds it', ef.action === 'reheld' && heldDoc(await get('shops/UF')), ef);

  /* ── L: legacy compatibility ── */
  await ENV.db.doc('users/UL').set({ uid: 'UL' });
  await ENV.db.doc('shops/UL').set({ sellerUid: 'UL', status: 'active', isVisible: true, searchable: true, business: { category: 'retail_store', source: 'admin' } });
  await call('accountDeactivate', 'UL', { confirm: true });
  const midL = await get('shops/UL');
  await call('accountReactivate', 'UL');
  const endL = await get('shops/UL');
  ck('L1  a pre-hold (legacy) shop keeps its compatibility round trip — hidden while frozen, restored after, never given discovery fields',
    midL.isVisible === false && midL.deactivated === true && endL.isVisible === true && endL.deactivated === false && !('discovery' in endL), [midL, endL]);

  /* ── S: reactivation never publishes a shop itself ── */
  const src = fs.readFileSync(path.join(FN, 'account-status.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  ck('S1  account-status writes no discovery / _noIndex / searchable:true on a shop — the evaluator is the only publisher',
    !/discovery\s*:/.test(src) && !/_noIndex\s*:/.test(src) && !/searchable\s*:\s*true/.test(src) && (src.match(/await _evaluateShop\(uid\)/g) || []).length === 2);

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
