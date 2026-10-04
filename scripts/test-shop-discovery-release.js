#!/usr/bin/env node
/* test-shop-discovery-release.js — THE GATE DECIDES (owner 2026-10-04).
 * Approval HOLDS a new shop; the ONE gate (business-category.shopEligibility) refuses it everywhere until the gate's
 * SERVER evaluator (shop-discovery-release.evaluateShopDiscovery) releases it — once it is approved (decision record),
 * active, not suspended, C1-categorised, with a valid owner + business. Products are NOT required. Suspension, revocation
 * and inactivation re-hold it; the index follows. Executes the REAL modules on the transactional fake store.
 *
 *   node scripts/test-shop-discovery-release.js
 */
'use strict';
const fs = require('fs'), path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const ck = (n, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 260) : '')); } };

const CLAIMS = { admin_1: { admin: true } };
const origReq = Module.prototype.require;
let ENV = null;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => ENV.db, FieldValue: ENV.FieldValue };
  if (id === 'firebase-admin') return { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => ENV.db, { FieldValue: ENV.FieldValue }), auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: CLAIMS[u] || {} }) }) };
  if (id === 'firebase-admin/auth') return { getAuth: () => ({ getUser: async (u) => ({ uid: u, customClaims: CLAIMS[u] || {} }), setCustomUserClaims: async () => {} }) };
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, debug() {}, error() {} };
  if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h, onDocumentCreated: (_o, h) => h, onDocumentUpdated: (_o, h) => h, onDocumentDeleted: (_o, h) => h };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, onRequest: (_o, h) => h, HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } };
  if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => 'x' }), defineString: () => ({ value: () => '' }) };
  if (id === './notify' || id === './search-terms') return { notify: async () => {}, buildSearchTerms: () => [], searchTerms: () => [] };
  return origReq.apply(this, arguments);
};
const newEnv = () => { const F = makeFakeFirestore({}); ENV = { db: F.db, FieldValue: F.FieldValue }; return F; };
const get = async (p) => { const s = await ENV.db.doc(p).get(); return s.exists ? s.data() : null; };
const getUser = async (u) => ({ uid: u, customClaims: CLAIMS[u] || {} });

(async () => {
  newEnv();
  const BCAT = require(path.join(FN, 'business-category.js'));
  const DE = require(path.join(FN, 'discovery-eligibility.js'));
  const LC = require(path.join(FN, 'application-lifecycle.js'))._internal;
  const SDR = require(path.join(FN, 'shop-discovery-release.js'));
  const evaluate = (id) => SDR.evaluateShopDiscovery(ENV.db, id, { FieldValue: ENV.FieldValue, getUser });
  /* the algolia-sync skip guard, extracted verbatim (that module registers triggers on load) */
  const SYNC = fs.readFileSync(path.join(FN, 'algolia-sync.js'), 'utf8');
  const grab = (h) => { const i = SYNC.indexOf(h); return SYNC.slice(i, SYNC.indexOf('\n}\n', i) + 2); };
  const syncAction = new Function(grab('function _shouldSkip(') + grab('function _shouldSkipAfterUpdate(') + 'return _shouldSkipAfterUpdate;')();

  /* An approved seller: the decision record the admin wrote, then the real projection. */
  async function approve(uid, app, decision) {
    const appId = app.applicationId;
    await ENV.db.doc('applications/' + appId).set(Object.assign({ uid, status: 'approved', decidedBy: 'admin_1' }, app));
    if (decision !== null) await ENV.db.doc('applicationDecisions/' + appId).set(Object.assign({ applicationId: appId, status: 'approved', decidedBy: 'admin_1', applicantUid: uid }, decision || {}));
    return LC.projectSeller(ENV.db, app, uid, true, { decidedBy: 'admin_1' });
  }
  const released = (d) => !!d && d.discovery === 'ELIGIBLE' && d._noIndex === false && d.searchable === true && d.isPublic === true;
  const heldDoc = (d) => !!d && d.discovery === 'HELD' && d._noIndex === true && d.searchable !== true && d.isPublic !== true;

  /* ── G: the gate refuses HELD everywhere ── */
  const base = { status: 'active', business: { category: 'retail_store', source: 'application' } };
  ck('G1  the ONE gate refuses a HELD shop (DISCOVERY_HELD) and admits the same shop once ELIGIBLE',
    !BCAT.shopEligibility({ ...base, discovery: 'HELD' }).eligible && BCAT.shopEligibility({ ...base, discovery: 'HELD' }).reasons.includes('DISCOVERY_HELD')
    && BCAT.shopEligibility({ ...base, discovery: 'ELIGIBLE' }).eligible);

  /* ── R: release with ZERO products ── */
  newEnv();
  const r1 = await approve('U1', { applicationId: 'APP1', name: 'Mama Pendo Supplies', category: 'Shoes & more' });
  const [s1, se1, b1] = [await get('shops/U1'), await get('sellers/U1'), await get('businesses/U1')];
  const products = (await ENV.db.collection('products').get()).docs.length;
  ck('R1  an approved, categorised shop with ZERO products is RELEASED by the gate evaluator (owner: no product requirement)',
    products === 0 && r1.discovery === 'ELIGIBLE' && released(s1) && released(se1) && released(b1), { r1: r1.discoveryEvaluation, shop: s1 && s1.discovery });
  ck('R2  …and the gate + the index gate now admit it (search row indexed under the server category)',
    BCAT.shopEligibility(s1).eligible && !!(await DE.prepareForIndex(ENV.db, 'sellers', 'U1', se1, {})) && syncAction({ _noIndex: true }, se1, 'sellers') === 'update');

  /* ── H: what keeps it held ── */
  newEnv();
  await approve('U2', { applicationId: 'APP2', name: 'No Record Co', category: 'Shoes' }, null);
  const s2 = await get('shops/U2');
  ck('H1  no decision record → stays HELD, refused by the gate and the index', heldDoc(s2) && !BCAT.shopEligibility(s2).eligible && !(await DE.prepareForIndex(ENV.db, 'sellers', 'U2', await get('sellers/U2'), {})), s2 && s2.discovery);
  newEnv();
  await approve('U3', { applicationId: 'APP3', name: 'Self Co', category: 'Shoes' }, { decidedBy: 'U3' });
  ck('H2  a SELF-decided record → stays HELD', heldDoc(await get('shops/U3')));
  newEnv();
  CLAIMS.fake_admin = {};
  await approve('U4', { applicationId: 'APP4', name: 'Forged Co', category: 'Shoes' }, { decidedBy: 'fake_admin' });
  ck('H3  a decider without the admin claim → stays HELD', heldDoc(await get('shops/U4')));
  newEnv();
  await approve('U5', { applicationId: 'APP5', name: 'Unclassified Co', category: 'Shoes' });
  await ENV.db.doc('shops/U5').set({ discovery: 'HELD', _noIndex: true, searchable: false, isPublic: false, business: { category: null, source: 'application', applicationId: 'APP5' } }, { merge: true });
  const e5 = await evaluate('U5');
  ck('H4  no C1 category → stays HELD (UNCLASSIFIED)', e5.action === 'unchanged' || e5.action === 'reheld', e5);
  ck('H4b …and a released shop that LOSES its category is re-held', (await get('shops/U5')).discovery === 'HELD');
  newEnv();
  await approve('U6', { applicationId: 'APP6', name: 'Inactive Seller', category: 'Shoes' });
  await ENV.db.doc('sellers/U6').set({ status: 'inactive', active: false }, { merge: true });
  const e6 = await evaluate('U6');
  ck('H5  an inactive seller → re-held (business records kept)', e6.action === 'reheld' && heldDoc(await get('shops/U6')) && !!(await get('businesses/U6')) && (await get('sellers/U6')).business, e6);
  /* H6: a shop that names ANOTHER account's genuinely approved application — the authority approves that application,
     so only the evaluator's owner check can refuse it. */
  newEnv();
  await ENV.db.doc('applications/APPX').set({ uid: 'OTHER', status: 'approved', decidedBy: 'admin_1' });
  await ENV.db.doc('applicationDecisions/APPX').set({ applicationId: 'APPX', status: 'approved', decidedBy: 'admin_1', applicantUid: 'OTHER' });
  await ENV.db.doc('shops/U7').set({ sellerUid: 'U7', ownerId: 'U7', status: 'active', discovery: 'HELD', _noIndex: true, business: { category: 'retail_store', source: 'application', applicationId: 'APPX' } });
  await ENV.db.doc('sellers/U7').set({ uid: 'U7', status: 'active', active: true, approvedAt: 1 });
  await ENV.db.doc('businesses/U7').set({ uid: 'U7', shopId: 'U7' });
  const e7 = await evaluate('U7');
  ck('H6  a shop naming ANOTHER account\'s approved application → stays HELD (OWNER_MISMATCH)', heldDoc(await get('shops/U7')) && e7.reasons.includes('OWNER_MISMATCH'), e7);

  /* ── S: suspension / revocation re-hold and de-index ── */
  newEnv();
  await approve('U8', { applicationId: 'APP8', name: 'Suspend Me', category: 'Shoes' });
  const before8 = await get('sellers/U8');
  await LC.projectSeller(ENV.db, { applicationId: 'APP8', name: 'Suspend Me' }, 'U8', false);
  const [s8, se8] = [await get('shops/U8'), await get('sellers/U8')];
  ck('S1  suspension RE-HOLDS the shop and its search rows', heldDoc(s8) && heldDoc(se8) && !BCAT.shopEligibility(s8).eligible, { shop: s8.discovery, seller: se8.discovery });
  ck('S2  …and the index sync DELETES the search row (de-index on re-hold)', syncAction(before8, se8, 'sellers') === 'delete');
  ck('S3  …while the business record is kept intact', !!(await get('businesses/U8')) && (await get('businesses/U8')).business.category === 'retail_store');
  await ENV.db.doc('applicationDecisions/APP8').set({ applicationId: 'APP8', status: 'approved', decidedBy: 'admin_1', applicantUid: 'U8' });
  const r8 = await LC.projectSeller(ENV.db, { applicationId: 'APP8', name: 'Suspend Me' }, 'U8', true, { decidedBy: 'admin_1' });
  ck('S4  re-approval (unsuspension) releases it again through the evaluator — not by restoring old flags', r8.discovery === 'ELIGIBLE' && released(await get('shops/U8')), r8.discoveryEvaluation);
  await ENV.db.doc('applicationDecisions/APP8').set({ status: 'rejected' }, { merge: true });
  const e8 = await evaluate('U8');
  ck('S5  a revoked decision (record no longer approved) re-holds a released shop', e8.action === 'reheld' && heldDoc(await get('shops/U8')), e8);
  await ENV.db.doc('applicationDecisions/APP8').set({ status: 'approved' }, { merge: true });
  await ENV.db.doc('accountFreezes/U8').set({ active: true, by: 'admin' });
  await evaluate('U8');
  ck('S6  an account freeze keeps it held', heldDoc(await get('shops/U8')));

  /* ── A: an AdminOS category stamp is a release event ── */
  newEnv();
  await approve('UA', { applicationId: 'APPA', name: 'Unstamped', category: 'Shoes' });
  await ENV.db.doc('shops/UA').set({ discovery: 'HELD', _noIndex: true, searchable: false, isPublic: false, business: { category: null, source: 'application', applicationId: 'APPA' } }, { merge: true });
  const BCA = require(path.join(FN, 'business-category-admin.js'))._adminH;
  const cr = await BCA.bizAdminClassifyShop({ auth: { uid: 'admin_1', token: { admin: true } }, data: { shopId: 'UA', category: 'retail_store', reason: 'Checked the storefront' } });
  ck('A1  AdminOS classifying a held, uncategorised shop RELEASES it through the evaluator (server write, after the commit)',
    cr && cr.discovery === 'released' && released(await get('shops/UA')) && BCAT.shopEligibility(await get('shops/UA')).eligible, cr && { discovery: cr.discovery, shop: (await get('shops/UA')).discovery });

  /* ── L: legacy shops are never touched ── */
  newEnv();
  await ENV.db.doc('shops/OLD').set({ sellerUid: 'OLD', status: 'active', searchable: true, isPublic: true, business: { category: 'retail_store', source: 'admin' } });
  const eOld = await evaluate('OLD');
  ck('L1  a pre-hold shop (no discovery field) is NOT participating — its visibility is untouched', eOld.action === 'not_participating' && (await get('shops/OLD')).searchable === true && !('discovery' in (await get('shops/OLD'))), eOld);

  /* ── C: a client cannot set the discovery fields ── */
  const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  const shopBlock = rules.slice(rules.indexOf('match /shops/{uid}'), rules.indexOf('allow delete', rules.indexOf('match /shops/{uid}')));
  const allow = (shopBlock.match(/hasOnly\(\[([\s\S]*?)\]\)/) || [])[1] || '';
  ck('C1  the shop owner\'s update allow-list excludes discovery / _noIndex / searchable / isPublic (create is admin-only)',
    !!allow && !/'(discovery|_noIndex|searchable|isPublic|discoveryReleasedAt)'/.test(allow) && /allow create: if isAdmin\(\);/.test(shopBlock), allow.slice(0, 80));
  newEnv();
  await approve('U9', { applicationId: 'APP9', name: 'Forger', category: 'Shoes' }, null);   /* held */
  await ENV.db.doc('sellers/U9').set({ discovery: 'ELIGIBLE', _noIndex: false, searchable: true, isPublic: true }, { merge: true });   /* owner-writable row */
  ck('C2  owner-forged release fields on sellers/{uid} do not index it while its SHOP is held', !(await DE.prepareForIndex(ENV.db, 'sellers', 'U9', await get('sellers/U9'), {})));

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
