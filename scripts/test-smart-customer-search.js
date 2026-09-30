/* test-smart-customer-search.js — Smart Customer Search (2026-09-30): the till RECOGNISES the shop's customers.
 *
 * Owner: "you just type number it guess correctly or maybe giving options"; "Type → recognize → suggest → select → save if
 * new → attach to sale"; "customer resolution, ownership, duplicate prevention, canonical phone normalization, and sale
 * attachment should all remain server-authoritative"; masked display; never select silently.
 *
 * REAL pos-customer-scope (the one customer authority: posCustomers), REAL pos-zero-friction callables
 * (posCustomerSearch / posCustomerSave / posCustomerCard) and posCompleteCheckout, REAL loyalty-points + wallet-engine
 * resolver, over the transactional fake Firestore. Firebase Auth is stubbed.
 *
 * PROVES
 *   SC1  every phone form is ONE key: 0722376801 · 0722 376 801 · +254722376801 · 254722376801 · 722376801
 *   SC2  save: this shop's cashier saves Jane → one record, owned by the shop, keyed OPAQUELY by (shop, number); saving the same
 *        number in another form finds her — no duplicate, no rename
 *   SC3  a customer saved BEFORE search existed (+254 form, no search keys) is found by the full number and by save —
 *        never duplicated — and is indexed on first touch
 *   SC4  recognise: a partial number offers choices and suggests NOTHING; the full number suggests exactly her; two
 *        customers sharing a prefix are both offered
 *   SC5  search by name, partial name and customer code — each result says what matched
 *   SC6  masked: no full phone number leaves the server (0722 ••• •801) — not even inside the record id
 *   SC7  shop-scoped: another shop sees none of these customers, cannot search as this shop, cannot open her card; the
 *        same number at another shop is that shop's own separate customer
 *   SC8  refused: signed out · not staff · a bad phone · no name
 *   SC9  concurrent saves of one new number create ONE customer
 *   SC10 attach: the sale names the customer from the shop's OWN record (not what the caller typed) and her card then
 *        shows 1 purchase, KES 1,000 lifetime spend, a last purchase, and her SOKONI points from the canonical account.
 *        Since Quick Charge Step 2 (2026-09-30) the ATTACHED customer earns on the sale (1 pt / KES 10, from the phone on
 *        the shop's own record): 1,240 before + 100 from this sale's ONE earn row = 1,340.
 *   SC10b a customer with no SOKONI account is 'none' with NO points figure (the till shows —, never 0)
 *   SC11 another shop cannot attach this shop's customer to its sale
 *
 *   node scripts/test-smart-customer-search.js
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-smart-customer';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 360) + ']' : '')); ok ? pass++ : fail++; };
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
const AUTH = { users: {} };
const authApi = {
  createUser: async () => { throw new Error('not in this suite'); },
  getUserByPhoneNumber: async (p) => { const u = Object.values(AUTH.users).find((x) => x.phoneNumber === p); if (!u) { const e = new Error('nf'); e.code = 'auth/user-not-found'; throw e; } return u; },
  getUser: async (uid) => AUTH.users[uid] || { customClaims: {} },
};
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => authApi, messaging: () => ({ send: async () => ({}) }) };
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-admin/auth') return { getAuth: () => authApi };
  if (id === 'firebase-admin') return ADMIN;
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h, onDocumentCreated: (_o, h) => h, onDocumentUpdated: (_o, h) => h };
  if (id === 'firebase-functions/logger' || id === 'firebase-functions') return { logger: { info() {}, warn() {}, error() {} }, info() {}, warn() {}, error() {}, debug() {} };
  if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => 'test-secret' }), defineString: () => ({ value: () => '' }), defineInt: () => ({ value: () => 0 }) };
  if (id === './pos-audit') return { writeAudit: () => {} };
  if (id === './workforce-identity') return { _assertBusinessPermission: async () => { throw new HttpsError('permission-denied', 'no'); } };
  if (id === './tenant-identity') return { resolveMerchantIdForOwner: async () => ({ ok: false }) };
  if (id === './shop-employees') return { resolveShopAccess: async (uid, shopId) => {
    const r = { 'shopA|shopA': 'owner', 'cashA|shopA': 'cashier', 'shopB|shopB': 'owner', 'cashB|shopB': 'cashier' }[uid + '|' + shopId];
    if (!r) throw new HttpsError('permission-denied', 'no access'); return { role: r }; }, capabilitiesForRole: () => ['sell'] };
  return origReq.apply(this, arguments);
};
const load = (p) => { try { return require(p); } catch (e) { return { __err: e.message }; } };
const SC = load(path.join(FN, 'pos-customer-scope.js'));
const ZF = load(path.join(FN, 'pos-zero-friction.js'));
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const all = async (c) => (await db.collection(c).get()).docs.map((d) => Object.assign({ id: d.id }, d.data()));
const codeOf = async (p) => { try { await p; return null; } catch (e) { return e.code || e.message; } };
const A = 'shopA', B = 'shopB';
const JID = SC.customerDocId ? SC.customerDocId('shopA', '254722376801') : 'x';
const call = (fn, uid, data) => ZF[fn]({ data, auth: uid ? { uid, token: {} } : null });
const search = (uid, shopId, q) => call('posCustomerSearch', uid, { shopId, q });
const save = (uid, shopId, phone, name) => call('posCustomerSave', uid, { shopId, phone, name });

(async () => {
  if (typeof ZF.posCustomerSearch !== 'function' || typeof SC.searchOwned !== 'function') { ck('SC0 the smart customer callables exist', false, ZF.__err || SC.__err || 'missing'); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  await db.doc('shops/' + A).set({ name: 'Mama Duka', sellerUid: A }); await db.doc('shops/' + B).set({ name: 'Duka B', sellerUid: B });
  await db.doc('users/' + A).set({ displayName: 'Owner A' }); await db.doc('users/' + B).set({ displayName: 'Owner B' });
  await db.doc('products/soap').set({ name: 'Soap', price: 250, stock: 100, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  await db.doc('products/soapB').set({ name: 'Soap', price: 250, stock: 100, sellerUid: B, shopId: B, status: 'active', isVisible: true });
  /* Jane is also a SOKONI buyer with points */
  await db.doc('users/jane').set({ phoneNumber: '+254722376801', displayName: 'Jane Wanjiru' }); AUTH.users.jane = { uid: 'jane', phoneNumber: '+254722376801' };
  await db.doc('loyaltyAccounts/jane').set({ uid: 'jane', balance: 1240, status: 'active' });

  /* SC1 */
  const forms = ['0722376801', '0722 376 801', '+254722376801', '254722376801', '722376801'].map(SC.phoneKey);
  ck('SC1 every phone form is ONE key (2547…); junk is none', forms.every((k) => k === '254722376801') && SC.phoneKey('12345') === null && SC.phoneKey('') === null, forms);

  /* SC2 */
  const s1 = await save('cashA', A, '0722 376 801', 'Jane Wanjiru');
  const s2 = await save('cashA', A, '+254722376801', 'Somebody Else');
  const recs = (await all('posCustomers')).filter((c) => c.sellerId === A);
  ck('SC2 save: one record per (shop, number), owned by the shop; another form finds her — no duplicate, no rename',
    s1.created === true && s1.id === JID && s2.created === false && s2.id === s1.id && recs.length === 1 && recs[0].name === 'Jane Wanjiru' && recs[0].phoneKey === '254722376801', { s1, s2, n: recs.length });

  /* SC3 legacy */
  await db.doc('posCustomers/pc_legacy').set({ sellerId: A, name: 'Peter Otieno', phone: '+254733000111', purchaseCount: 7, totalSpent: 4200 });
  const l1 = await search('cashA', A, '0733 000 111');
  const l2 = await save('cashA', A, '733000111', 'Peter O');
  const legacy = await get('posCustomers/pc_legacy');
  ck('SC3 a pre-search customer (+254 form) is found by the full number and by save — never duplicated — and indexed on first touch',
    l1.results.length === 1 && l1.results[0].id === 'pc_legacy' && l1.suggested === 'pc_legacy' && l2.id === 'pc_legacy' && l2.created === false
    && !(await get('posCustomers/' + SC.customerDocId(A, '254733000111'))) && Array.isArray(legacy.searchKeys) && legacy.searchKeys.includes('n:pe') && legacy.name === 'Peter Otieno', { l1, l2 });

  /* SC4 */
  await save('cashA', A, '0722376999', 'John Kamau');
  const p1 = await search('cashA', A, '0722 37');
  const p2 = await search('cashA', A, '722376801');
  const p3 = await search('shopA', A, '+254 722 376 801');
  ck('SC4 recognise: a partial number offers BOTH choices and suggests nothing; the full number (any form) suggests exactly her',
    p1.results.length === 2 && p1.suggested === null && p1.results.every((r) => r.matchedBy === 'phone')
    && p2.suggested === JID && p2.results.length === 1 && p3.suggested === JID, { p1: p1.results.map((r) => r.name), p2: p2.suggested, p3: p3.suggested });

  /* SC5 */
  await db.doc('posCustomers/shopA_card').set({ sellerId: A, name: 'Mary Achieng', phone: '254711222333', memberCardCode: 'SKC-10492', searchKeys: SC.searchKeysFor({ phone: '254711222333', name: 'Mary Achieng', code: 'SKC-10492' }) });
  const n1 = await search('cashA', A, 'jan'), n2 = await search('cashA', A, 'Wanj'), n3 = await search('cashA', A, 'skc-10492'), n4 = await search('cashA', A, 'j');
  ck('SC5 by name, partial name (any word) and customer code — each says what matched; one letter searches nothing',
    n1.results.length === 1 && n1.results[0].name === 'Jane Wanjiru' && n1.results[0].matchedBy === 'name' && n1.suggested === null
    && n2.results.length === 1 && n2.results[0].id === JID && n3.results.length === 1 && n3.results[0].matchedBy === 'code' && n3.results[0].code === 'SKC-10492'
    && n4.results.length === 0, { n1: n1.results, n3: n3.results });

  /* SC6 */
  const blob = JSON.stringify([p1, p2, n1, n3, s1]);   /* l1 = a legacy record; its own id is whatever the legacy writer chose */
  ck('SC6 masked: no full phone number leaves the server (0722 ••• •801)', p2.results[0].maskedPhone === '0722 ••• •801' && !/722376801|254722|733000111|711222333/.test(blob), p2.results[0].maskedPhone);

  /* SC7 */
  const x1 = await search('cashB', B, '0722376801');
  const x2 = await codeOf(search('cashB', A, '0722376801'));
  const x3 = await codeOf(call('posCustomerCard', 'cashB', { shopId: B, customerId: JID }));
  const xb = await save('cashB', B, '0722376801', 'Jane W');
  ck('SC7 shop-scoped: shop B sees none of A\'s customers, cannot search as A, cannot open her card; the same number at B is B\'s own customer',
    x1.results.length === 0 && x1.suggested === null && x2 === 'permission-denied' && x3 === 'not-found' && xb.created === true && xb.id === SC.customerDocId(B, '254722376801') && xb.id !== JID
    && (await get('posCustomers/' + JID)).name === 'Jane Wanjiru', { x1: x1.results.length, x2, x3, xb: xb.id });

  /* SC8 */
  const r1 = await codeOf(search(null, A, '0722')), r2 = await codeOf(search('stranger', A, '0722')), r3 = await codeOf(save('cashA', A, '12345', 'Bad Phone')), r4 = await codeOf(save('cashA', A, '0799000000', ' '));
  ck('SC8 refused: signed out · not this shop\'s staff · a bad phone · no name', r1 === 'unauthenticated' && r2 === 'permission-denied' && r3 === 'invalid-argument' && r4 === 'invalid-argument', { r1, r2, r3, r4 });

  /* SC9 */
  const cc = await Promise.all([save('cashA', A, '0700111222', 'Twin One'), save('shopA', A, '+254700111222', 'Twin Two'), save('cashA', A, '700111222', 'Twin Three')]);
  const twins = (await all('posCustomers')).filter((c) => c.sellerId === A && c.phoneKey === '254700111222');
  ck('SC9 concurrent saves of one new number create ONE customer', twins.length === 1 && cc.filter((c) => c.created).length === 1 && new Set(cc.map((c) => c.id)).size === 1, { n: twins.length, created: cc.map((c) => c.created) });

  /* SC10 */
  const sale = await ZF.posCompleteCheckout({ data: { idempotencyKey: 'SALE-SC-1', merchantId: A, items: [{ productId: 'soap', qty: 4, unitPrice: 250 }], subtotal: 1000, grandTotal: 1000, discountTotal: 0, taxTotal: 0,
    payments: [{ method: 'cash', amount: 1000 }], customer: { id: JID, name: 'Forged Name', phone: '0799999999' } }, auth: { uid: A, token: { posRole: 'cashier' } } }).catch((e) => ({ err: e.message }));
  const rec = (await all('posRetailSales')).find((x) => x.id === 'SALE-SC-1' || x.idempotencyKey === 'SALE-SC-1') || (await all('posRetailSales'))[0];
  const card = await call('posCustomerCard', 'cashA', { shopId: A, customerId: JID });
  ck('SC10 attach: the sale names her from the shop\'s OWN record; her card shows 1 purchase, KES 1,000, a last purchase and 1,340 SOKONI points (1,240 + the 100 she earned on THIS sale, one earn row)',
    !sale.err && rec && rec.customer && rec.customer.id === JID && rec.customer.name === 'Jane Wanjiru' && rec.customer.phone === '254722376801'
    && card.purchaseCount === 1 && card.totalSpent === 1000 && card.lastPurchaseAt != null && card.sokoniPoints === 1340 && (await all('loyaltyLedger')).filter((l) => l.type === 'earn' && l.uid === 'jane' && l.points === 100 && String(l.orderId || '').indexOf(rec.id) !== -1).length === 1 && card.sokoni === 'member' && card.maskedPhone === '0722 ••• •801',
    { err: sale.err, cust: rec && rec.customer, card, earn: (await all('loyaltyLedger')).filter((l) => l.uid === 'jane').map((l) => [l.type, l.points, l.orderId]) });

  /* SC10b: no SOKONI account on the number is said as such — not 0 */
  const cardJ = await call('posCustomerCard', 'cashA', { shopId: A, customerId: SC.customerDocId(A, '254722376999') });
  ck('SC10b a customer with no SOKONI account is "none" with NO points figure — never an invented 0', cardJ.sokoni === 'none' && cardJ.sokoniPoints === null && cardJ.name === 'John Kamau', cardJ);

  /* SC11 */
  const before = (await all('posRetailSales')).length;
  const bad = await codeOf(ZF.posCompleteCheckout({ data: { idempotencyKey: 'SALE-SC-2', merchantId: B, items: [{ productId: 'soapB', qty: 4, unitPrice: 250 }], subtotal: 1000, grandTotal: 1000, discountTotal: 0, taxTotal: 0,
    payments: [{ method: 'cash', amount: 1000 }], customer: { id: JID } }, auth: { uid: B, token: { posRole: 'cashier' } } }));
  ck('SC11 another shop cannot attach this shop\'s customer to its sale', bad && (await all('posRetailSales')).length === before && (await get('posCustomers/' + JID)).purchaseCount === 1, bad);

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(1); });
