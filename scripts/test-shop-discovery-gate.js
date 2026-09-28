#!/usr/bin/env node
/* test-shop-discovery-gate.js — seller shops get a SERVER C1 category at approval, and public shop discovery goes
 * through ONE eligibility gate (owner decision 2026-09-28: "approved seller ≠ discoverable shop").
 *
 *   node scripts/test-shop-discovery-gate.js                 # working tree — must PASS
 *   COUNTERPROOF=1 node scripts/test-shop-discovery-gate.js  # functions @ 4e9607b — failures ARE the defects
 *
 * Census (2026-09-28): no shop carried a C1 category — approval stamped the applicant's free text; search indexed every
 * sellers / businesses / stores / vendors / companies / restaurants row with no gate (a driver's businesses/SOK-*
 * record was indexed as a shop; a suspended shop stayed indexed); owners can write status on their own sellers /
 * businesses rows.
 *
 * REAL code, on the transactional fake Firestore: business-category.shopEligibility, application-lifecycle.projectSeller
 * (approve / re-approve / suspend) and discovery-eligibility.prepareForIndex (the choke point both search queues use).
 *
 * PROVES
 *   E1  an approved, server-classified, active shop is eligible — with its C1 category
 *   E2  a shop with only free-text `category` (no server stamp) is NOT eligible (UNCLASSIFIED)
 *   E3  a classification whose source is not the server (application | admin) is NOT honoured
 *   E4  suspended / not searchable / not public / invisible / deactivated / locked shops are each NOT eligible
 *   A1  approval stamps business.{category (C1), source:'application'} + searchable/isPublic on shops, sellers, businesses
 *   A2  a seller with no exact category match is classified `retail_store` (the C1 seller default) — never free text
 *   A3  re-approval never overwrites an AdminOS classification (source:'admin' kept)
 *   A4  a provider opting into a shop is classified with the provider's SERVER category (__serverCategory)
 *   A5  suspension writes searchable:false / isPublic:false on all three, and the shop becomes ineligible
 *   I1  sellers/{uid} is indexed only when the owner's shop is eligible — under the SERVER category (free text kept as
 *       displayCategory, not a facet)
 *   I2  sellers/{uid} of an approved-before-C1 (unstamped) shop is NOT indexed
 *   I3  a driver / POS businesses/SOK-* record is NOT indexed as a shop
 *   I4  owner-forged fields on sellers/{uid} (status active + business.source 'admin') do not make it discoverable
 *   I5  stores / vendors / companies / restaurants (no server authority) are NOT indexed
 *   I6  a businesses row whose uid is not its own id (a claim on someone else's shop) is NOT indexed
 *   I7  a suspended shop's rows are removed from search
 *   C1  control: an eligible provider is still indexed by the provider gate (unchanged)
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const CPM = !!process.env.COUNTERPROOF;
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const ck = (n, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 260) : '')); } };

/* load modules: working tree, or 4e9607b copies (their other requires resolve to the working tree) */
let tmp = null;
function load(rel) {
  if (!CPM) return require(path.join(FN, rel));
  tmp = tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'shopgate-'));
  const out = path.join(tmp, rel.replace(/\//g, '__'));
  fs.writeFileSync(out, cp.execFileSync('git', ['show', '4e9607b:functions/' + rel], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 }));
  return require(out);
}
const origReq = Module.prototype.require;
let ENV = null;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => ENV.db, FieldValue: ENV.FieldValue };
  if (id === 'firebase-admin/auth') return { getAuth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }), setCustomUserClaims: async () => {} }) };
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, debug() {}, error() {} };
  if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h, onDocumentCreated: (_o, h) => h, onDocumentUpdated: (_o, h) => h };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, onRequest: (_o, h) => h, HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } };
  if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => 'x' }), defineString: (n) => ({ value: () => '' }) };
  if (id === './notify' || id === './search-terms') return { notify: async () => {}, buildSearchTerms: () => [], searchTerms: () => [] };
  if (tmp && this.filename && this.filename.startsWith(tmp) && id.startsWith('./')) return origReq.call(this, path.join(FN, id));
  return origReq.apply(this, arguments);
};
const newEnv = () => { const F = makeFakeFirestore({}); ENV = { db: F.db, FieldValue: F.FieldValue }; return F; };

(async () => {
  console.log('\nSOURCE: ' + (CPM ? 'functions @ 4e9607b (before) — failures below ARE the defects' : 'working tree (fix)'));
  newEnv();
  const BCAT = load('business-category.js');
  const DE = load('discovery-eligibility.js');
  const LC = load('application-lifecycle.js')._internal;
  const SE = typeof BCAT.shopEligibility === 'function' ? BCAT.shopEligibility : null;

  /* ── E: the predicate ── */
  const good = { status: 'active', business: { category: 'retail_store', source: 'application' }, searchable: true, isPublic: true };
  ck('E1  an approved, server-classified, active shop is eligible (with its C1 category)', !!SE && SE(good).eligible && SE(good).category === 'retail_store', SE && SE(good));
  ck('E2  free-text category only (no server stamp) is NOT eligible', !!SE && !SE({ status: 'active', category: 'Shoes' }).eligible);
  ck('E3  a classification not set by the server (source "owner") is NOT honoured', !!SE && !SE({ ...good, business: { category: 'retail_store', source: 'owner' } }).eligible);
  const withdrawals = { suspended: { status: 'suspended' }, notSearchable: { searchable: false }, notPublic: { isPublic: false }, invisible: { isVisible: false }, deactivated: { deactivated: true }, locked: { locked: true } };
  const leaked = SE ? Object.entries(withdrawals).filter(([, w]) => SE({ ...good, ...w }).eligible).map(([k]) => k) : ['no predicate'];
  ck('E4  suspended / not searchable / not public / invisible / deactivated / locked are each NOT eligible', leaked.length === 0, leaked);

  /* ── A: approval stamps the classification ── */
  const F = newEnv();
  const app = { applicationId: 'APP1', name: 'Mama Pendo Supplies', category: 'Shoes & more', phone: '0712000000', location: 'Nairobi' };
  await LC.projectSeller(F.db, app, 'U1', true);
  const shop = (await F.db.collection('shops').doc('U1').get()).data() || {};
  const seller = (await F.db.collection('sellers').doc('U1').get()).data() || {};
  const biz = (await F.db.collection('businesses').doc('U1').get()).data() || {};
  const stamped = (d) => !!d.business && BCAT.isCategory(d.business.category) && d.business.source === 'application' && d.searchable === true && d.isPublic === true;
  ck('A1  approval stamps business.{C1 category, source:application} + searchable/isPublic on shops, sellers, businesses', stamped(shop) && stamped(seller) && stamped(biz), { shop: shop.business, seller: seller.business, biz: biz.business });
  ck('A2  no exact category match → retail_store (the C1 seller default), never the free text', !!shop.business && shop.business.category === 'retail_store' && shop.category === 'Shoes & more', shop.business);

  const F2 = newEnv();
  await F2.db.collection('shops').doc('U2').set({ sellerUid: 'U2', status: 'active', business: { category: 'restaurant', source: 'admin', classifiedBy: 'ADM' } });
  await LC.projectSeller(F2.db, { applicationId: 'APP2', name: 'Big Mart', category: 'retail' }, 'U2', true);
  const s2 = (await F2.db.collection('shops').doc('U2').get()).data() || {};
  ck('A3  re-approval keeps an AdminOS classification (source admin, category restaurant)', !!s2.business && s2.business.source === 'admin' && s2.business.category === 'restaurant' && s2.business.classifiedBy === 'ADM', s2.business);

  const F3 = newEnv();
  await LC.projectSeller(F3.db, { name: 'Clinic Shop', category: 'free words', __serverCategory: 'pharmacy' }, 'U3', true);
  const s3 = (await F3.db.collection('shops').doc('U3').get()).data() || {};
  ck('A4  a provider shop is classified with the provider\'s SERVER category', !!s3.business && s3.business.category === 'pharmacy', s3.business);

  await LC.projectSeller(F.db, app, 'U1', false);
  const sus = (await F.db.collection('shops').doc('U1').get()).data() || {};
  const susSeller = (await F.db.collection('sellers').doc('U1').get()).data() || {};
  const susBiz = (await F.db.collection('businesses').doc('U1').get()).data() || {};
  ck('A5  suspension writes searchable/isPublic false on all three, and the shop is ineligible',
    [sus, susSeller, susBiz].every((d) => d.searchable === false && d.isPublic === false) && !!SE && !SE(sus).eligible, { shop: [sus.searchable, sus.isPublic], seller: [susSeller.searchable, susSeller.isPublic] });

  /* ── I: the index gate ── */
  const G = newEnv();
  await G.db.collection('shops').doc('OK').set({ sellerUid: 'OK', ownerId: 'OK', status: 'active', business: { category: 'retail_store', source: 'application' }, searchable: true, isPublic: true });
  await G.db.collection('shops').doc('OLD').set({ sellerUid: 'OLD', status: 'active', category: 'Shoes' });
  await G.db.collection('shops').doc('SUS').set({ sellerUid: 'SUS', status: 'suspended', business: { category: 'retail_store', source: 'application' }, searchable: false, isPublic: false });
  const P = (c, id, d) => DE.prepareForIndex(G.db, c, id, d, {});
  const i1 = await P('sellers', 'OK', { uid: 'OK', name: 'OK Shop', category: 'Shoes', status: 'active' });
  ck('I1  sellers/{uid} indexed only via its eligible shop, under the SERVER category (free text → displayCategory)', !!i1 && i1.category === 'retail_store' && i1.displayCategory === 'Shoes', i1 && { category: i1.category, displayCategory: i1.displayCategory });
  ck('I2  an unstamped (pre-C1) shop\'s row is NOT indexed', (await P('sellers', 'OLD', { uid: 'OLD', name: 'Old', status: 'active' })) === null);
  ck('I3  a driver / POS businesses/SOK-* record is NOT indexed as a shop', (await P('businesses', 'SOK-ABC123', { name: 'Rider Co', category: 'delivery', status: 'active', ownerId: 'OK' })) === null);
  ck('I4  owner-forged fields on sellers/{uid} (active + business.source admin) do not make it discoverable',
    (await P('sellers', 'OLD', { uid: 'OLD', status: 'active', business: { category: 'retail_store', source: 'admin' }, searchable: true })) === null);
  const legacy = [];
  for (const c of ['stores', 'vendors', 'companies', 'restaurants']) if ((await P(c, 'OK', { ownerId: 'OK', name: 'x', status: 'active' })) !== null) legacy.push(c);
  ck('I5  stores / vendors / companies / restaurants are NOT indexed', legacy.length === 0, legacy);
  ck('I6  a businesses row claiming another owner\'s shop (uid ≠ id) is NOT indexed', (await P('businesses', 'ATTACKER', { uid: 'OK', name: 'Fake', status: 'active' })) === null);
  ck('I7  a suspended shop\'s rows are removed from search', (await P('businesses', 'SUS', { uid: 'SUS', name: 'Sus', status: 'active' })) === null);

  const pr = await P('providers', 'PV1', { status: 'active', business: { category: 'salon', source: 'application' }, name: 'Glow' });
  ck('C1  control: an eligible provider is still indexed by the provider gate', !!pr && pr.category === 'salon');

  Module.prototype.require = origReq;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { Module.prototype.require = origReq; if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
