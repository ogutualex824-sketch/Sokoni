/* test-payment-labels.js — till payment labels (convergence slice 13, 2026-09-29): every label is a real payment path with
 * its own evidence, or it is refused. REAL posCompleteCheckout over the transactional fake. docs/PAYMENT_LABEL_AUTHORITY.md
 *
 * PROVES
 *   PL1 unknown labels (voucher, bank, qr, split, loyalty_full, cheque, credit) are refused, nothing written
 *   PL2 cash completes (control)
 *   PL3 M-PESA only on a PAID IntaSend payment for this shop + sale + amount, claimed once (7 refusals)
 *   PL4 card on the same proof; no proof → refused
 *   PL5 gift card from ONE store, debited with the sale (6 refusals); not counted as money arriving
 *   PL5b two sales racing one card: one paid, never negative
 *   PL6 manual M-PESA (merchant's own Till) is REFUSED — all electronic money through IntaSend (owner 2026-09-29)
 *   PL7 ALL PAYMENTS = INTASEND: a completed Daraja record and the mpesa_daraja label settle NOTHING (owner 2026-09-29)
 *   PL8 a split proves every component
 *   PL9 end to end with the REAL Quick Charge pricer: its payment names the sale and settles only that sale
 *   PL10 one spelling per tender: "Wallet"/"WALLET"/" CASH "/"MPESA" behave exactly like their lowercase forms (2026-09-30)
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-payment-labels';
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
const PS = load(path.join(FN, 'loyalty-points-spend.js'));
const ZF = load(path.join(FN, 'pos-zero-friction.js'));
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const all = async (c) => (await db.collection(c).get()).docs.map((d) => Object.assign({ id: d.id }, d.data()));
const codeOf = async (p) => { try { await p; return null; } catch (e) { return e.code || e.message; } };
const msgOf = async (p) => { try { await p; return null; } catch (e) { return String(e.message || ''); } };
const A = 'shopA', B = 'shopB', JANE = '+254712345678';
const queued = async () => (await all('smsQueue')).concat(await all('sms_queue')).concat(await all('smsOutbox'));
const codeFor = async (rid) => { const m = (await queued()).find((x) => x.template === 'points_redeem_code' && String(x.dedupeKey || x.id || '').includes(rid)); const t = m && (m.body || m.text || ''); const x = /Code (\d{6})/.exec(t); return x ? x[1] : null; };
async function reset(balance) {
  for (const c of ['tillRedemptions', 'tillRedeemCodes', 'pointsHolds', 'loyaltyLedger', 'posRetailSales', 'posReceipts', 'posIdempotency', 'posTransactions', 'smsQueue', 'sms_queue', 'smsOutbox']) {
    for (const d of (await db.collection(c).get()).docs) await d.ref.delete();
  }
  await db.doc('loyaltyAccounts/jane').set({ uid: 'jane', loyaltyId: 'SKN-J', balance: balance == null ? 1000 : balance, status: 'active' });
}
const start = (who, shop, extra) => PS.tillStart(db, { uid: who, data: Object.assign({ shopId: shop, phone: '0712 345 678', saleKey: 'SALE-0001', saleTotalKES: 1000, points: 500 }, extra || {}) });
const confirm = (who, shop, rid, code) => PS.tillConfirm(db, { uid: who, data: { shopId: shop, redemptionId: rid, code } });
const sale = (key, shop, pays, extra) => ZF.posCompleteCheckout({ data: Object.assign({ idempotencyKey: key, merchantId: shop, items: [{ productId: 'soap' + (shop === B ? 'B' : ''), qty: 4, unitPrice: 250 }],
  subtotal: 1000, grandTotal: 1000, discountTotal: 0, taxTotal: 0, payments: pays }, extra || {}), auth: { uid: shop, token: { posRole: 'cashier' } } });

const K = (n) => 'SALE-PL-' + n;
const sale4 = (key, pays, extra) => ZF.posCompleteCheckout({ data: Object.assign({ idempotencyKey: key, merchantId: A, items: [{ productId: 'soap', qty: 4, unitPrice: 250 }],
  subtotal: 1000, grandTotal: 1000, discountTotal: 0, taxTotal: 0, payments: pays }, extra || {}), auth: { uid: A, token: { posRole: 'cashier' } } });
const stock = async () => ((await get('products/soap')) || {}).stock;
const sales = async () => (await all('posRetailSales')).length;
const intent = (ref, o) => db.doc('paymentIntents/' + ref).set(Object.assign({ purpose: 'pos_till_sale', status: 'paid', amount: 1000, paymentRef: 'INV-' + ref,
  metadata: { shopId: A, saleId: 'X', sokoniTillId: 'TILLA' } }, o || {}));
const card = (code, o) => db.doc('giftCards/' + code.match(/.{1,4}/g).join('-')).set(Object.assign({ code, shopId: A, balance: 1500, initialBalance: 1500, status: 'active', pin: '1234',
  expiryDate: F.Timestamp.fromMillis(Date.now() + 864e5) }, o || {}));

(async () => {
  if (typeof ZF.posCompleteCheckout !== 'function') { ck('PL0 the till sale authority loads', false, ZF.__err); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  await db.doc('shops/' + A).set({ name: 'Mama Duka', sellerUid: A }); await db.doc('users/' + A).set({ displayName: 'Owner A' });
  await db.doc('products/soap').set({ name: 'Soap', price: 250, stock: 1000, sellerUid: A, shopId: A, status: 'active', isVisible: true });

  /* PL1 — unknown labels */
  const before1 = { s: await sales(), st: await stock() };
  const refused = {};
  for (const m of ['voucher', 'bank', 'qr', 'split', 'loyalty_full', 'cheque', 'credit', 'VOUCHER']) refused[m] = await msgOf(sale4(K('1' + m), [{ method: m, amount: 1000 }]));
  ck('PL1 every label that is not a real payment path is refused before anything is written (voucher, bank, qr, split, loyalty_full, cheque, credit)',
    Object.values(refused).every((x) => /not a payment SOKONI can confirm|separate payments/.test(x || '')) && (await sales()) === before1.s && (await stock()) === before1.st,
    refused);

  /* PL2 — cash control */
  let c2 = null; try { c2 = await sale4(K('2'), [{ method: 'cash', amount: 1000 }]); } catch (e) { c2 = { err: e.message }; }
  ck('PL2 cash still completes (control)', c2 && c2.saleId, c2 && (c2.err || 'ok'));

  /* PL3 — M-PESA by a PAID IntaSend payment */
  const r3 = {};
  await intent('INT-OK', { metadata: { shopId: A, saleId: K('3') } });
  try { r3.ok = await sale4(K('3'), [{ method: 'mpesa', amount: 1000, intentRef: 'INT-OK' }]); } catch (e) { r3.ok = { err: e.message }; }
  r3.sale = r3.ok && r3.ok.saleId ? await get('posRetailSales/' + r3.ok.saleId) : null;
  r3.claim = await get('posPaymentClaims/INT-OK');
  r3.reuse = await msgOf(sale4(K('3b'), [{ method: 'mpesa', amount: 1000, intentRef: 'INT-OK' }]));
  await intent('INT-UNPAID', { status: 'created', metadata: { shopId: A, saleId: K('3c') } });
  r3.unpaid = await msgOf(sale4(K('3c'), [{ method: 'mpesa', amount: 1000, intentRef: 'INT-UNPAID' }]));
  await intent('INT-SHOPB', { metadata: { shopId: B, saleId: K('3d') } });
  r3.otherShop = await msgOf(sale4(K('3d'), [{ method: 'mpesa', amount: 1000, intentRef: 'INT-SHOPB' }]));
  await intent('INT-OTHERSALE', { metadata: { shopId: A, saleId: 'SOMETHING-ELSE' } });
  r3.otherSale = await msgOf(sale4(K('3e'), [{ method: 'mpesa', amount: 1000, intentRef: 'INT-OTHERSALE' }]));
  await intent('INT-SHORT', { amount: 500, metadata: { shopId: A, saleId: K('3f') } });
  r3.short = await msgOf(sale4(K('3f'), [{ method: 'mpesa', amount: 1000, intentRef: 'INT-SHORT' }]));
  await intent('INT-ORDER', { purpose: 'product_order', metadata: { shopId: A, saleId: K('3g') } });
  r3.purpose = await msgOf(sale4(K('3g'), [{ method: 'mpesa', amount: 1000, intentRef: 'INT-ORDER' }]));
  r3.noRef = await msgOf(sale4(K('3h'), [{ method: 'mpesa', amount: 1000 }]));
  const pay3 = r3.sale && (r3.sale.payments || [])[0];
  ck('PL3 M-PESA completes ONLY on a PAID IntaSend payment for this shop, this sale and this amount — claimed once; refused when unpaid, another shop\'s, another sale\'s, short, not a till payment, reused, or with no reference',
    r3.ok && r3.ok.saleId && pay3 && pay3.confirmed === true && pay3.intentRef === 'INT-OK' && r3.claim && r3.claim.idempotencyKey === K('3')
    && /another sale|different sale/.test(r3.reuse || '')   /* bound to its sale: a second sale is stopped before the claim */ && /not completed this payment/.test(r3.unpaid || '') && /different shop/.test(r3.otherShop || '') && /different sale/.test(r3.otherSale || '')
    && /confirmed payment is 500/.test(r3.short || '') && /not made for a till sale/.test(r3.purpose || '') && /no IntaSend payment reference/.test(r3.noRef || ''),
    { ok: r3.ok && (r3.ok.saleId || r3.ok.err), reuse: r3.reuse, unpaid: r3.unpaid, otherShop: r3.otherShop, otherSale: r3.otherSale, short: r3.short, purpose: r3.purpose, noRef: r3.noRef });

  /* PL4 — card: the same proof */
  await intent('INT-CARD', { metadata: { shopId: A, saleId: K('4') } });
  let c4 = null; try { c4 = await sale4(K('4'), [{ method: 'card', amount: 1000, intentRef: 'INT-CARD' }]); } catch (e) { c4 = { err: e.message }; }
  const noProofCard = await msgOf(sale4(K('4b'), [{ method: 'card', amount: 1000 }]));
  ck('PL4 card completes on the SAME paid IntaSend proof, and is refused without one (no simulator)', c4 && c4.saleId && /no IntaSend payment reference/.test(noProofCard || ''), { c4: c4 && (c4.saleId || c4.err), noProofCard });

  /* PL5 — gift card, one store, debited with the sale */
  await card('GIFTAAAA0001'); await card('GIFTBBBB0002', { shopId: B }); await card('GIFTCCCC0003', { balance: 300 }); await card('GIFTDDDD0004', { expiryDate: F.Timestamp.fromMillis(Date.now() - 1000) });
  let g5 = null; try { g5 = await sale4(K('5'), [{ method: 'gift_card', amount: 1000, code: 'GIFT-AAAA-0001', pin: '1234' }]); } catch (e) { g5 = { err: e.message }; }
  const bal5 = (await get('giftCards/GIFT-AAAA-0001')).balance;
  const r5 = {
    pin: await msgOf(sale4(K('5b'), [{ method: 'gift_card', amount: 400, code: 'GIFTAAAA0001', pin: '9999' }, { method: 'cash', amount: 600 }])),
    shop: await msgOf(sale4(K('5c'), [{ method: 'gift_card', amount: 1000, code: 'GIFTBBBB0002', pin: '1234' }])),
    low: await msgOf(sale4(K('5d'), [{ method: 'gift_card', amount: 1000, code: 'GIFTCCCC0003', pin: '1234' }])),
    expired: await msgOf(sale4(K('5e'), [{ method: 'gift_card', amount: 1000, code: 'GIFTDDDD0004', pin: '1234' }])),
    twice: await msgOf(sale4(K('5f'), [{ method: 'gift_card', amount: 250, code: 'GIFTAAAA0001', pin: '1234' }, { method: 'gift_card', amount: 250, code: 'GIFTAAAA0001', pin: '1234' }, { method: 'cash', amount: 500 }])),
    none: await msgOf(sale4(K('5g'), [{ method: 'gift_card', amount: 1000, code: 'GIFTZZZZ9999' }])),
  };
  const pos5 = g5 && g5.saleId ? (await get('posRetailSales/' + g5.saleId)).position : null;
  ck('PL5 a gift card pays from the ONE store, debited with the sale (1,500 → 500); refused for a wrong PIN, another shop\'s card, too little balance, expired, the same card twice, or an unknown card; gift-card value is not counted as money arriving',
    g5 && g5.saleId && bal5 === 500 && /Wrong gift card PIN/.test(r5.pin || '') && /another shop/.test(r5.shop || '') && /only KES 300/.test(r5.low || '') && /expired/.test(r5.expired || '')
    && /cannot pay twice/.test(r5.twice || '') && /does not exist/.test(r5.none || '') && pos5 && pos5.giftCardCents === 100000 && pos5.electronicCents === 0,
    { g5: g5 && (g5.saleId || g5.err), bal5, r5, pos5 });

  /* PL5b — two sales racing one card */
  await card('GIFTEEEE0005', { balance: 1500 });
  const race = await Promise.allSettled([
    sale4(K('5h'), [{ method: 'gift_card', amount: 1000, code: 'GIFTEEEE0005', pin: '1234' }]),
    sale4(K('5i'), [{ method: 'gift_card', amount: 1000, code: 'GIFTEEEE0005', pin: '1234' }]),
  ]);
  const bal5b = (await get('giftCards/GIFT-EEEE-0005')).balance;
  ck('PL5b two sales racing one KES 1,500 card for 1,000 each: exactly one is paid, the card ends at 500, never negative',
    race.filter((x) => x.status === 'fulfilled').length === 1 && bal5b === 500, { race: race.map((x) => x.status === 'fulfilled' ? 'ok' : String(x.reason && x.reason.message).slice(0, 60)), bal5b });

  /* PL6 — manual M-PESA to the merchant's own Till: REFUSED (owner 2026-09-29: all electronic money through IntaSend) */
  const salesBefore6 = await sales();
  const r6 = { code: await msgOf(sale4(K('6'), [{ method: 'mpesa_till_manual', amount: 1000, ref: 'QWE1234567' }])),
    mixed: await msgOf(sale4(K('6b'), [{ method: 'cash', amount: 500 }, { method: 'mpesa_till_manual', amount: 500, ref: 'QWE1234568' }])) };
  ck('PL6 manual M-PESA to the merchant own Till is refused, alone or mixed with cash — all electronic money goes through IntaSend; nothing written',
    /not a payment SOKONI can confirm/.test(r6.code || '') && /not a payment SOKONI can confirm/.test(r6.mixed || '') && (await sales()) === salesBefore6, r6);

  /* PL7 — ALL PAYMENTS = INTASEND (owner 2026-09-29: "no daraja everything intasend") */
  await db.doc('posPayments/DARAJA-1').set({ status: 'completed', sellerUid: A, paidAmount: 1000, mpesaCode: 'ABC' });
  const salesBefore7 = await sales();
  const l7 = await msgOf(sale4(K('7'), [{ method: 'mpesa', amount: 1000, ref: 'DARAJA-1' }]));
  const l7b = await msgOf(sale4(K('7b'), [{ method: 'mpesa_daraja', amount: 1000, ref: 'DARAJA-1' }]));
  ck('PL7 ALL PAYMENTS = INTASEND: a completed Daraja record no longer settles a sale, and the mpesa_daraja label is refused; nothing is written',
    /no IntaSend payment reference/.test(l7 || '') && /not a payment SOKONI can confirm/.test(l7b || '') && (await sales()) === salesBefore7, { l7, l7b });

  /* PL8 — a real split: every component proves itself */
  await intent('INT-SPLIT', { amount: 600, metadata: { shopId: A, saleId: K('8') } });
  let s8 = null; try { s8 = await sale4(K('8'), [{ method: 'cash', amount: 400 }, { method: 'mpesa', amount: 600, intentRef: 'INT-SPLIT' }]); } catch (e) { s8 = { err: e.message }; }
  const s8b = await msgOf(sale4(K('8b'), [{ method: 'cash', amount: 400 }, { method: 'mpesa', amount: 600 }]));
  ck('PL8 a split of KES 400 cash + 600 M-PESA completes when the M-PESA part is proven, and is refused when it is not',
    s8 && s8.saleId && /no IntaSend payment reference/.test(s8b || ''), { s8: s8 && (s8.saleId || s8.err), s8b });

  /* PL9 — end to end with the REAL Quick Charge pricer (not a hand-built intent): it must name the sale */
  let p9 = {};
  try {
    const PPx = require(path.join(FN, 'payment-purposes.js'));
    await db.doc('sokoniTills/TILLA').set({ sokoniTillId: 'TILLA', shopId: A, branchId: 'main', merchantUid: A, status: 'ACTIVE', currency: 'KES' });
    const q = await PPx.PURPOSES.pos_till_sale.price(A, { sokoniTillId: 'TILLA', saleId: K('9'), items: [{ name: 'Till sale', price: 1000, qty: 1 }] });
    p9.saleId = q.metadata.saleId;
    await db.doc('paymentIntents/' + q.preferredRef).set({ purpose: 'pos_till_sale', status: 'paid', amount: q.amountCents / 100, metadata: q.metadata });
    p9.sale = await sale4(K('9'), [{ method: 'mpesa', amount: 1000, intentRef: q.preferredRef }]);
    p9.other = await msgOf(sale4(K('9b'), [{ method: 'mpesa', amount: 1000, intentRef: q.preferredRef }]));
  } catch (e) { p9.err = e.message; }
  ck('PL9 the REAL Quick Charge pricer binds its payment to the sale (metadata.saleId); that payment settles THAT sale and no other',
    p9.saleId === K('9') && p9.sale && p9.sale.saleId && /different sale/.test(p9.other || ''), { saleId: p9.saleId, sale: p9.sale && p9.sale.saleId, other: p9.other, err: p9.err });

  /* PL10 — ONE spelling of every tender (2026-09-30). The allow-list and the M-PESA/card check lower-cased the label,
     but the wallet debit matched 'wallet' EXACTLY — so "Wallet" completed a sale with no money (proven). */
  const p10 = {};
  try {
    const st0 = await stock(), n0 = await sales();
    p10.a = await sale4(K('10a'), [{ method: 'Wallet', amount: 1000 }], { customer: { id: 'wcEmpty' } }).then(() => 'COMPLETED', (e) => e.message);
    p10.aStock = await stock(); p10.aSales = await sales();
    await db.doc('posWallets/wcFull').set({ balance: 1000 });
    p10.b = await sale4(K('10b'), [{ method: 'WALLET', amount: 1000 }], { customer: { id: 'wcFull' } }).then((r) => r && r.saleId, (e) => 'ERR ' + e.message);
    p10.bal = ((await get('posWallets/wcFull')) || {}).balance;
    p10.wtx = !!(await get('posWalletTransactions/' + K('10b') + '_wallet'));
    p10.c = await sale4(K('10c'), [{ method: ' CASH ', amount: 1200 }]).then((r) => r && r.saleId, (e) => 'ERR ' + e.message);
    p10.d = await sale4(K('10d'), [{ method: 'MPESA', amount: 1000 }]).then(() => 'COMPLETED', (e) => e.message);
    p10.st0 = st0; p10.n0 = n0;
  } catch (e) { p10.err = e.message; }
  ck('PL10 a tender label is ONE spelling whatever its case: "Wallet" with an empty wallet is refused and nothing moves; "WALLET" with KES 1,000 IS debited (1,000 → 0, wallet transaction written — positive control); " CASH " still gives change; "MPESA" with no proof is refused',
    /Insufficient wallet balance/.test(p10.a || '') && p10.aStock === p10.st0 && p10.aSales === p10.n0
    && typeof p10.b === 'string' && !/^ERR/.test(p10.b) && p10.bal === 0 && p10.wtx
    && typeof p10.c === 'string' && !/^ERR/.test(p10.c) && /no IntaSend payment reference/.test(p10.d || ''),
    p10);

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
