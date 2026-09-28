#!/usr/bin/env node
/* test-shop-writer-authority.js — stage 2 of the shop discovery authority (owner decision 2026-09-28): a seller can
 * never approve, activate, publish or classify its own shop; SOKONI assigns the category (at approval, or in AdminOS).
 *
 *   node scripts/test-shop-writer-authority.js                 # working tree — must PASS
 *   COUNTERPROOF=1 node scripts/test-shop-writer-authority.js  # functions @ dca1049 (stage 1) — failures ARE the defects
 *
 * REAL code on the transactional fake Firestore: kasshop.saveShopProfile, application-lifecycle.projectSeller /
 * resolveRole, ade.adeOnSellerApplied / adeResolveException, business-category(+admin), business-workspace.
 *
 * PROVES
 *   W1  a signed-in, UNAPPROVED caller's first saveShopProfile creates a PENDING shop (never active / visible) —
 *       and it is not discoverable
 *   W2  saveShopProfile refuses the authority fields (category, business, status, searchable, isPublic, featured,
 *       verified, discoveryEligible …) on an approved shop — and reports them as `ignored`
 *   W3  storefront content (about, opening hours, zones, delivery) is still saved
 *   W4  approval (projectSeller) activates and classifies the shop the wizard created → discoverable
 *   O1  an application naming ANOTHER merchant's shop cannot take it over on approval (SHOP_OWNED_BY_ANOTHER_ACCOUNT)
 *   O2  …nor suspend it on a suspension
 *   O3  control: an application naming the applicant's OWN (or a new) shop still projects
 *   A1  ADE: an auto_approve rule on a seller application does NOT approve — the seller row is unchanged and the
 *       application is escalated to the exception queue
 *   A2  ADE: an administrator resolving that exception with "approve" is refused BEFORE the exception is marked resolved
 *   C1  the seller categories exist and route to merchant-v2 on the merchant plan catalogue
 *   C2  hub-register ids map EXACTLY (supermarket, wholesale/wholesaler/importer, hardware, electronics, boutique→fashion,
 *       farm/dairy/agri-input→agriculture); retail-shop / manufacturer stay retail_store
 *   C3  a supermarket application resolves to SELLER by its own category, and approval stamps `supermarket`
 *   K1  AdminOS shop classification: admin only; category must run on a shop; a reason is required
 *   K2  a PENDING shop cannot be classified (decide the application first)
 *   K3  a shop with NO approval record needs the administrator's attestation — then it is classified and the
 *       attestation is audited
 *   K4  classifying an approved shop stamps shops.business (source admin), mirrors it to the owner's sellers /
 *       businesses rows, audits it, and the shop becomes discoverable
 *   K5  classifying a SUSPENDED shop never un-suspends it (still not discoverable)
 *   K6  bizAdminShops' unclassified queue lists approved-but-unclassified shops, never pending ones
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const CPM = !!process.env.COUNTERPROOF;
const BASE = 'dca1049';
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const say = console.log;
console.log = console.info = console.warn = console.debug = () => {};
const ck = (n, ok, d) => { if (ok) { pass++; say('  PASS  ' + n); } else { fail++; say('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 260) : '')); } };

let tmp = null;
function load(rel) {
  if (!CPM) return require(path.join(FN, rel));
  tmp = tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'shopwriter-'));
  const out = path.join(tmp, rel.replace(/\//g, '__'));
  fs.writeFileSync(out, cp.execFileSync('git', ['show', BASE + ':functions/' + rel], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 }));
  return require(out);
}
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
const ADMIN_STUB = { apps: [{}], initializeApp: () => ({}), app: () => ({}),
  firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }),
  auth: () => ({ setCustomUserClaims: async () => {}, getUser: async (u) => ({ uid: u, customClaims: {} }) }) };
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin') return ADMIN_STUB;
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-admin/auth') return { getAuth: () => ADMIN_STUB.auth() };
  if (id === 'firebase-functions/logger' || id === 'firebase-functions/v2' && false) return { info() {}, warn() {}, debug() {}, error() {}, log() {} };
  if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h, onDocumentCreated: (_o, h) => h, onDocumentUpdated: (_o, h) => h, onDocumentDeleted: (_o, h) => h };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => 'x' }), defineString: () => ({ value: () => '' }) };
  if (id === './notify' || id === './search-terms') return { notify: async () => {}, buildSearchTerms: () => [], searchTerms: () => [] };
  if (tmp && this.filename && this.filename.startsWith(tmp) && id.startsWith('./')) return origReq.call(this, path.join(FN, id));
  return origReq.apply(this, arguments);
};
/* a call that throws becomes a value, so a broken path is a named FAIL, never a crash (harness fails closed) */
const tryCall = async (p) => { try { return await p; } catch (e) { return { error: (e.details && e.details.code) || e.code || e.message }; } };
const codeOf = async (p) => { try { await p; return null; } catch (e) { return (e.details && e.details.code) || e.code || e.message; } };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const ADMIN = { auth: { uid: 'admin1', token: { admin: true } } };
const USER = (uid) => ({ auth: { uid, token: {} } });

(async () => {
  say('\nSOURCE: ' + (CPM ? `functions @ ${BASE} (stage 1) — failures below ARE the defects` : 'working tree (fix)'));
  const BCAT = load('business-category.js');
  const BW = load('business-workspace.js');
  const KS = load('kasshop.js');
  const LC = load('application-lifecycle.js')._internal;
  const ADE = load('ade.js');
  const BA = load('business-category-admin.js')._adminH;
  const SE = (s) => (typeof BCAT.shopEligibility === 'function' ? BCAT.shopEligibility(s || {}) : { eligible: false, reasons: ['NO_GATE'] });

  say('\n── W: the shop wizard (saveShopProfile) never activates, approves or classifies ──');
  const r1 = await KS.saveShopProfile({ auth: { uid: 'newbie' }, data: { profile: { name: 'Newbie Shop', about: 'hello' } } }).catch((e) => ({ err: e.code || e.message }));
  const s1 = await get('shops/newbie');
  ck('W1  an unapproved caller\'s first save creates a PENDING shop — never active, never visible', !!s1 && s1.status === 'pending' && s1.isVisible === undefined, { r1, status: s1 && s1.status, isVisible: s1 && s1.isVisible });
  ck('W1b …and that shop is not discoverable', !SE(s1).eligible, SE(s1).reasons);

  await db.doc('shops/appr').set({ sellerUid: 'appr', ownerId: 'appr', name: 'Approved', status: 'active', category: 'Mitumba', source: 'application_approval',
    business: { category: 'fashion', source: 'application' }, searchable: true, isPublic: true });
  const r2 = await KS.saveShopProfile({ auth: { uid: 'appr' }, data: { profile: { name: 'Approved', category: 'Electronics', status: 'verified',
    business: { category: 'electronics', source: 'admin' }, searchable: true, isPublic: true, featured: true, verified: true, discoveryEligible: true,
    about: 'We sell shoes', openingHours: { mon: { closed: false, periods: [{ open: '08:00', close: '18:00' }] } }, zones: ['Westlands'], delMethod: 'own', delTime: 'sameday' } } });   /* 2026-09-29: delivery fields accept only their codes (kasshop CHOICES) */
  const s2 = await get('shops/appr');
  ck('W2  authority fields are refused (category wording, SOKONI category, status, featured, verified, discoveryEligible unchanged)',
    s2.category === 'Mitumba' && s2.business.category === 'fashion' && s2.business.source === 'application' && s2.status === 'active'
    && s2.featured === undefined && s2.verified === undefined && s2.discoveryEligible === undefined, { category: s2.category, business: s2.business, status: s2.status, featured: s2.featured });
  ck('W2b …and reported back as `ignored` (not dropped silently)', Array.isArray(r2.ignored) && ['category', 'business', 'status', 'featured', 'verified', 'discoveryEligible'].every((k) => r2.ignored.includes(k)), r2.ignored);
  ck('W3  storefront content is still saved (about, opening hours, zones, delivery)', s2.about === 'We sell shoes' && s2.openingHours && s2.openingHours.mon && s2.zones[0] === 'Westlands' && s2.delMethod === 'own' && s2.delTime === 'sameday');

  await LC.projectSeller(db, { applicationId: 'appN', businessName: 'Newbie Shop', category: 'supermarket' }, 'newbie', true);
  const s1b = await get('shops/newbie');
  ck('W4  approval activates and classifies the shop the wizard created → discoverable', s1b.status === 'active' && SE(s1b).eligible && s1b.business.category === 'supermarket', { status: s1b.status, e: SE(s1b) });

  say('\n── O: an application never transfers a shop ──');
  await db.doc('shops/victimShop').set({ sellerUid: 'victim', ownerId: 'victim', name: 'Victim Store', status: 'active', business: { category: 'hardware', source: 'admin' } });
  const oc = await codeOf(LC.projectSeller(db, { applicationId: 'appX', businessName: 'Thief', shopId: 'victimShop' }, 'thief', true));
  const v1 = await get('shops/victimShop');
  ck('O1  approving an application that names another merchant\'s shop fails, and the shop keeps its owner', oc === 'SHOP_OWNED_BY_ANOTHER_ACCOUNT' && v1.sellerUid === 'victim' && v1.ownerId === 'victim' && v1.name === 'Victim Store', { oc, owner: v1.sellerUid, name: v1.name });
  const oc2 = await codeOf(LC.projectSeller(db, { applicationId: 'appX', businessName: 'Thief', shopId: 'victimShop' }, 'thief', false));
  const v2 = await get('shops/victimShop');
  ck('O2  …and a suspension of that application cannot suspend the victim\'s shop', oc2 === 'SHOP_OWNED_BY_ANOTHER_ACCOUNT' && v2.status === 'active', { oc2, status: v2.status });
  await db.doc('shops/ownBranch').set({ sellerUid: 'owner2', name: 'Own Branch', status: 'pending' });
  const oc3 = await codeOf(LC.projectSeller(db, { applicationId: 'appO', businessName: 'Own Branch', shopId: 'ownBranch' }, 'owner2', true));
  const oc4 = await codeOf(LC.projectSeller(db, { applicationId: 'appF', businessName: 'Fresh', shopId: 'freshShop' }, 'owner3', true));
  ck('O3  control: naming the applicant\'s OWN shop, or a new one, still projects', oc3 === null && oc4 === null && (await get('shops/ownBranch')).status === 'active' && (await get('shops/freshShop')).sellerUid === 'owner3', { oc3, oc4 });

  say('\n── A: ADE is not a second approval authority ──');
  await db.doc('ade_rules/r1').set({ name: 'Auto-approve complete seller applications', event_type: 'seller_application', conditions: [], action: 'auto_approve', action_params: { message: 'approved' }, confidence_threshold: 0, priority: 200, enabled: true });
  await db.doc('sellers/sellA').set({ status: 'pending', name: 'Self-applied' });
  const ev = { params: { sellerId: 'sellA' }, data: { before: { exists: false, data: () => ({}) }, after: { exists: true, data: () => ({ status: 'pending', name: 'Self-applied' }) } } };
  await ADE.adeOnSellerApplied(ev);
  const sa = await get('sellers/sellA');
  const exq = (await db.collection('ade_exception_queue').get()).docs.map((d) => d.data()).filter((x) => x.entity_id === 'sellA');
  ck('A1  an auto_approve rule does NOT approve a seller — the row stays pending and the application is escalated', sa.status === 'pending' && !sa.approvedBy && exq.length === 1, { status: sa.status, approvedBy: sa.approvedBy, queued: exq.length });
  await db.doc('ade_exception_queue/exS').set({ entity_type: 'seller', entity_id: 'sellA', status: 'open', event_type: 'seller_application' });
  const rc = await codeOf(ADE.adeResolveException({ auth: { uid: 'admin1', token: { admin: true } }, data: { exceptionId: 'exS', decision: 'approve', applyAction: true, reason: 'looks fine' } }));
  const exS = await get('ade_exception_queue/exS');
  ck('A2  resolving it with "approve" is refused BEFORE the exception is marked resolved; the seller stays pending',
    rc === 'APPROVAL_OWNED_BY_APPLICATIONS' && exS.status === 'open' && (await get('sellers/sellA')).status === 'pending', { rc, exc: exS.status, seller: (await get('sellers/sellA')).status });

  say('\n── C: the seller categories ──');
  const NEW = ['supermarket', 'wholesale', 'hardware', 'electronics', 'fashion', 'agriculture'];
  ck('C1  the six seller categories exist, route to merchant-v2', NEW.every((k) => BCAT.isCategory(k) && BW.ROUTE_OF[k] === 'merchant-v2.html'), NEW.map((k) => [k, BCAT.isCategory(k), BW.ROUTE_OF[k]]));
  const M = BCAT.FROM_BUSINESS_ID;
  ck('C2  hub-register ids map exactly; retail-shop / manufacturer stay retail_store',
    M.supermarket === 'supermarket' && M.wholesale === 'wholesale' && M.wholesaler === 'wholesale' && M.importer === 'wholesale' && M.hardware === 'hardware'
    && M.electronics === 'electronics' && M.boutique === 'fashion' && M.farm === 'agriculture' && M.dairy === 'agriculture' && M['agri-input'] === 'agriculture'
    && M['retail-shop'] === 'retail_store' && M.manufacturer === 'retail_store', { supermarket: M.supermarket, boutique: M.boutique, farm: M.farm, electronics: M.electronics });
  const rr = LC.resolveRole({ category: 'supermarket', businessName: 'Mini Mart' });
  const cat = BCAT.categoryFromApplication({ category: 'supermarket' }, 'seller').category;
  ck('C3  a supermarket application is a SELLER by its own category, and is classified `supermarket`', rr.role === 'seller' && /category:supermarket/.test(rr.by || '') && cat === 'supermarket', { rr, cat });

  say('\n── K: AdminOS seller-shop classification ──');
  if (typeof BA.bizAdminClassifyShop !== 'function') {
    ck('K1  bizAdminClassifyShop exists (AdminOS can classify a seller shop)', false, 'missing');
    ['K2', 'K3', 'K4', 'K5', 'K6'].forEach((k) => ck(k + ' (needs bizAdminClassifyShop / bizAdminShops)', false, 'missing'));
  } else {
    await db.doc('shops/legacy1').set({ sellerUid: 'leg1', name: 'Old Duka', status: 'active', category: 'duka' });
    await db.doc('sellers/leg1').set({ uid: 'leg1', shopId: 'legacy1', status: 'active' });
    await db.doc('businesses/leg1').set({ uid: 'leg1', shopId: 'legacy1', status: 'active' });
    await db.doc('shops/apprU').set({ sellerUid: 'apU', ownerId: 'apU', name: 'Approved Unclassified', status: 'active', source: 'application_approval', applicationId: 'a1' });
    await db.doc('sellers/apU').set({ uid: 'apU', shopId: 'apprU', status: 'active' });
    await db.doc('businesses/apU').set({ uid: 'apU', shopId: 'apprU', status: 'active' });
    await db.doc('shops/susp1').set({ sellerUid: 'su1', name: 'Suspended', status: 'suspended', source: 'application_approval', searchable: false, isPublic: false });
    const k1 = await Promise.all([
      codeOf(BA.bizAdminClassifyShop({ ...USER('apU'), data: { shopId: 'apprU', category: 'hardware', reason: 'my own shop' } })),
      codeOf(BA.bizAdminClassifyShop({ ...ADMIN, data: { shopId: 'apprU', category: 'trades', reason: 'a plumber shop' } })),
      codeOf(BA.bizAdminClassifyShop({ ...ADMIN, data: { shopId: 'apprU', category: 'hardware', reason: '' } })),
    ]);
    ck('K1  owner refused; a non-shop category refused; a reason required', k1[0] === 'permission-denied' && k1[1] === 'invalid-argument' && k1[2] === 'invalid-argument', k1);
    ck('K2  a PENDING shop (wizard-created, never approved) cannot be classified', await codeOf(BA.bizAdminClassifyShop({ ...ADMIN, data: { shopId: 'ownBranch_pending_check', category: 'hardware', reason: 'x y z' } })) === 'not-found'
      && await (async () => { await db.doc('shops/pend9').set({ sellerUid: 'p9', status: 'pending' }); return codeOf(BA.bizAdminClassifyShop({ ...ADMIN, data: { shopId: 'pend9', category: 'hardware', reason: 'shortcut' } })); })() === 'NOT_APPROVED');
    const noAttest = await codeOf(BA.bizAdminClassifyShop({ ...ADMIN, data: { shopId: 'legacy1', category: 'supermarket', reason: 'visited the duka' } }));
    const withAttest = await tryCall(BA.bizAdminClassifyShop({ ...ADMIN, data: { shopId: 'legacy1', category: 'supermarket', reason: 'visited the duka', attestApproval: true } }));
    const aud1 = (await db.collection('adminAudit').get()).docs.map((d) => d.data()).find((a) => a.targetShopId === 'legacy1');
    ck('K3  no approval record → refused without attestation; with it, classified and the attestation audited',
      noAttest === 'NO_APPROVAL_RECORD' && withAttest.category === 'supermarket' && !!aud1 && aud1.attested === true && aud1.performedBy === 'admin1' && ((await get('shops/legacy1')).business || {}).approvalAttestedBy === 'admin1', { noAttest, withAttest, aud1 });
    const k4 = await tryCall(BA.bizAdminClassifyShop({ ...ADMIN, data: { shopId: 'apprU', category: 'hardware', reason: 'Hardware store, confirmed by documents' } }));
    const sh = await get('shops/apprU'), sl = await get('sellers/apU'), bz = await get('businesses/apU');
    const cat = (d) => (d && d.business && d.business.category) || null;
    ck('K4  approved shop: stamped (admin), mirrored to sellers + businesses, audited, and now discoverable',
      cat(sh) === 'hardware' && sh.business.source === 'admin' && cat(sl) === 'hardware' && cat(bz) === 'hardware'
      && k4.eligible === true && SE(sh).eligible && sh.status === 'active', { k4, sh: sh.business, sl: cat(sl), bz: cat(bz) });
    const k5 = await tryCall(BA.bizAdminClassifyShop({ ...ADMIN, data: { shopId: 'susp1', category: 'fashion', reason: 'reclassify while suspended' } }));
    const s5 = await get('shops/susp1');
    ck('K5  classifying a SUSPENDED shop never un-suspends it', s5.status === 'suspended' && s5.searchable === false && !k5.error && k5.eligible === false && !SE(s5).eligible, { status: s5.status, k5 });
    await db.doc('shops/legacy2').set({ sellerUid: 'leg2', name: 'Another Old Duka', status: 'active' });
    const q = await BA.bizAdminShops({ ...ADMIN, data: { view: 'unclassified' } });
    const ids = (q.shops || []).map((s) => s.shopId);
    ck('K6  the unclassified queue lists approved-but-unclassified shops, never pending ones; categories are shop categories',
      ids.includes('legacy2') && !ids.includes('pend9') && !ids.includes('apprU') && (q.categories || []).every((c) => BW.ROUTE_OF[c.id] === 'merchant-v2.html'), { ids, cats: (q.categories || []).map((c) => c.id) });
  }

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
