/* test-points-p1.js — SOKONI Points P1 (2026-09-29): EARNING. One SOKONI-wide balance; 1 point per KES 10 of a completed
 * sale, credited by the SERVER from the authoritative amount; the till only IDENTIFIES the buyer (by phone), and — with
 * consent — creates an account the buyer claims themselves.
 *
 * Owner: "pos checkout, till cart and quick charge have a place to put a number to credit points … those with no account,
 * the cashier creates for them, SOKONI does all in the backend and sends the SMS … even those with no smartphone".
 *
 * REAL functions/loyalty-points.js, loyalty.js internals, wallet-engine's phone resolver, sms-service (the QUEUE — nothing
 * is sent; SMS is live in .env), pos-zero-friction.posCompleteCheckout and sokoni-qr-authority.priceTillSale, over the
 * fake Firestore. Firebase Auth is stubbed (createUser / getUserByPhoneNumber) — no real account is ever created.
 *
 * PROVES
 *   PT1 the rate: 1 point per KES 10 (KES 1,999 → 199; KES 9 → 0); 10 points = KES 1
 *   PT2 lookup: this shop's staff only; an unknown number is { found:false }; a known one answers a MASKED name / phone
 *       and the balance — never the full number, never a uid
 *   PT3 create: needs consent; an EXISTING number is found, never re-created or modified; a new number becomes an Auth
 *       user + users doc (createdVia 'till', claimed:false) + a loyalty account in the canonical shape (SKN- id, signed
 *       QR, welcome points issued by 'sokoni'); a till_welcome SMS is QUEUED; the cashier receives no credential; a
 *       per-shop daily ceiling stops mass registration
 *   PT4 earn: points from the amount, one ledger row per sale recording the ISSUING shop (pointsRemaining for P2);
 *       balance and tier move; a replay earns nothing more; a points_earned SMS is queued; no account → no write;
 *       a blocked account is not credited
 *   PT5 the till: posCompleteCheckout with buyerPhone completes the sale and credits points from ITS total (a
 *       client-sent pointsEarned is ignored); an unknown number still completes the sale, with the reason on the receipt
 *   PT6 Quick Charge + online wiring: the intent carries a normalised buyerPhone (garbage → null); the webhook earns on
 *       PAID from the confirmed amount; online (webhook finaliser) and card (verifyIntasendPayment) earn once per order
 *   PT7 one order earns once per issuing shop, whichever payment path (webhook finaliser / verifyIntasendPayment)
 *       confirms it — the two paths share one ledger key per (order, shop)
 *   PT8 the card-QR signing key is missing: no account is opened (never signed with a placeholder); an existing account
 *       still earns; posCompleteCheckout, verifyIntasendPayment and webhookIntasend all bind LOYALTY_HMAC_SECRET
 *
 *   node scripts/test-points-p1.js
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-points-p1';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const fs = require('fs'), path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 330) + ']' : '')); ok ? pass++ : fail++; };
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
/* Firebase Auth, stubbed: a phone map; createUser is recorded */
const AUTH = { users: {}, created: [], attempts: [] };
const authApi = {
  createUser: async ({ phoneNumber, displayName }) => { AUTH.attempts.push(phoneNumber); if (Object.values(AUTH.users).some((u) => u.phoneNumber === phoneNumber)) { const e = new Error('exists'); e.code = 'auth/phone-number-already-exists'; throw e; }
    const uid = 'u_' + phoneNumber.slice(-4); AUTH.users[uid] = { uid, phoneNumber, displayName }; AUTH.created.push(phoneNumber); return AUTH.users[uid]; },
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
  if (id === './shop-employees') return { resolveShopAccess: async (uid, shopId) => { const t = { 'shopA|shopA': 'owner', 'cash1|shopA': 'cashier', 'view1|shopA': 'viewer' }[uid + '|' + shopId]; if (!t) throw new HttpsError('permission-denied', 'no access'); return { role: t }; }, capabilitiesForRole: () => ['sell'] };
  return origReq.apply(this, arguments);
};
const load = (p) => { try { return require(p); } catch (e) { return { __err: e.message }; } };
const LP = load(path.join(FN, 'loyalty-points.js'));
const ZF = load(path.join(FN, 'pos-zero-friction.js'));
const QA = load(path.join(FN, 'sokoni-qr-authority.js'));
const src = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const all = async (c) => (await db.collection(c).get()).docs.map((d) => Object.assign({ id: d.id }, d.data()));
const codeOf = async (p) => { try { await p; return null; } catch (e) { return e.code || e.message; } };
const A = 'shopA';

(async () => {
  if (typeof LP.earnForSale !== 'function') { ck('PT0 the points module loads', false, LP.__err); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }

  /* PT1 */
  ck('PT1 1 point per KES 10 (1,999 → 199; 9 → 0); 10 points = KES 1',
    LP.pointsForAmount(1999) === 199 && LP.pointsForAmount(9) === 0 && LP.pointsForAmount(-50) === 0 && LP.KES_PER_POINT_EARNED === 10 && LP.POINT_VALUE_KES === 0.1);

  /* seed: an existing SOKONI user with this phone */
  await db.doc('users/jane').set({ phoneNumber: '+254712345678', displayName: 'Jane Wanjiru' });
  AUTH.users.jane = { uid: 'jane', phoneNumber: '+254712345678' };
  await db.doc('shops/' + A).set({ name: 'Mama Duka', sellerUid: A });

  /* PT2 — lookup */
  const stranger = await codeOf(LP.lookup(db, { uid: 'mallory', data: { shopId: A, phone: '0712345678' } }));
  const viewer = await codeOf(LP.lookup(db, { uid: 'view1', data: { shopId: A, phone: '0712345678' } }));
  const unknown = await LP.lookup(db, { uid: 'cash1', data: { shopId: A, phone: '0799000111' } });
  const known = await LP.lookup(db, { uid: 'cash1', data: { shopId: A, phone: '0712 345 678' } });
  const badPhone = await codeOf(LP.lookup(db, { uid: 'cash1', data: { shopId: A, phone: 'hello' } }));
  ck('PT2 lookup: shop staff only; unknown → found:false; known → MASKED name/phone + balance, no uid, no full number',
    stranger === 'permission-denied' && viewer === 'permission-denied' && unknown.found === false && known.found === true && known.maskedName === 'J. W.' && known.maskedPhone === '••••678'
    && !/712345678|jane/.test(JSON.stringify(known)) && badPhone === 'invalid-argument', { stranger, viewer, unknown, known, badPhone });

  /* PT3 — create */
  const noConsent = await codeOf(LP.createBuyer(db, { uid: 'cash1', data: { shopId: A, phone: '0799000111' } }));
  const janeBefore = JSON.stringify(await get('users/jane'));
  const existing = await LP.createBuyer(db, { uid: 'cash1', data: { shopId: A, phone: '0712345678', name: 'Someone Else', consent: true } });
  const janeAfter = JSON.stringify(await get('users/jane'));
  const made = await LP.createBuyer(db, { uid: 'cash1', data: { shopId: A, phone: '0799000111', name: 'Otieno Brian', consent: true } });
  const newUid = 'u_0111';
  const nu = await get('users/' + newUid), na = await get('loyaltyAccounts/' + newUid), wl = await get('loyaltyLedger/welcome__' + newUid);
  const q = (await all('smsQueue')).concat(await all('sms_queue')).concat(await all('smsOutbox'));
  const welcomeSms = q.find((m) => m.template === 'till_welcome');
  await db.doc('tillBuyerCreates/' + A + '_' + new Date().toISOString().slice(0, 10)).set({ count: 100 });
  const capped = await codeOf(LP.createBuyer(db, { uid: 'cash1', data: { shopId: A, phone: '0799000222', consent: true } }));
  ck('PT3 create: consent required; an existing number is FOUND and untouched; a new one → Auth user + users doc (till, unclaimed) + canonical loyalty account + queued SMS; no credential returned; daily ceiling',
    noConsent === 'failed-precondition' && existing.found === true && existing.created === false && janeBefore === janeAfter && AUTH.attempts.join() === '+254799000111' && AUTH.created.join() === '+254799000111'
    && made.created === true && nu && nu.createdVia === 'till' && nu.claimed === false && nu.createdByShop === A
    && na && /^SKN-/.test(na.loyaltyId) && /^sokoni_loyalty:/.test(na.qrPayload) && na.balance === 125 && wl && wl.issuerShopId === 'sokoni'
    && welcomeSms && welcomeSms.to === '+254799000111' && /Mama Duka/.test(welcomeSms.body) && /code/.test(welcomeSms.body)
    && !/password|token|link|uid/i.test(Object.keys(made).join(',')) && capped === 'resource-exhausted',
    { noConsent, existing, made, nu: nu && { createdVia: nu.createdVia, claimed: nu.claimed }, bal: na && na.balance, sms: !!welcomeSms, capped });

  /* PT4 — earn */
  const e1 = await LP.earnForSale(db, { buyerPhone: '0712345678', issuerShopId: A, saleId: 'S1', amountKES: 1999, source: 'till' });
  const e2 = await LP.earnForSale(db, { buyerPhone: '0712345678', issuerShopId: A, saleId: 'S1', amountKES: 1999, source: 'till' });
  const jane = await get('loyaltyAccounts/jane'), led = await get('loyaltyLedger/earn__till__S1');
  const sms2 = (await all('smsQueue')).concat(await all('sms_queue')).concat(await all('smsOutbox')).filter((m) => m.template === 'points_earned');
  const none = await LP.earnForSale(db, { buyerPhone: '0700111222', issuerShopId: A, saleId: 'S2', amountKES: 500, source: 'till' });
  await db.doc('loyaltyAccounts/' + newUid).set({ status: 'blocked' }, { merge: true });
  const blockedBal = (await get('loyaltyAccounts/' + newUid)).balance;
  const blk = await LP.earnForSale(db, { buyerUid: newUid, issuerShopId: A, saleId: 'S3', amountKES: 500, source: 'till' });
  ck('PT4 earn: 199 points for KES 1,999 with the issuing shop recorded; replay earns nothing; SMS queued; no account → nothing; blocked → not credited',
    e1.ok && e1.points === 199 && jane.balance === 125 + 199 && led && led.issuerShopId === A && led.pointsRemaining === 199 && led.points === 199
    && e2.replay === true && (await get('loyaltyAccounts/jane')).balance === 324 && sms2.length === 1 && /199 points at Mama Duka/.test(sms2[0].body)
    && none.ok === false && none.reason === 'no-account' && !(await get('loyaltyLedger/earn__till__S2'))
    && blk.ok === false && blk.reason === 'account-blocked' && (await get('loyaltyAccounts/' + newUid)).balance === blockedBal,
    { e1, e2: e2.replay, bal: jane.balance, sms: sms2.length, none, blk });

  /* PT5 — the till */
  let pt5 = {};
  if (typeof ZF.posCompleteCheckout !== 'function') pt5.err = ZF.__err;
  else try {
    await db.doc('products/soap').set({ name: 'Soap', price: 250, stock: 50, sellerUid: A, shopId: A, status: 'active', isVisible: true });
    await db.doc('users/' + A).set({ displayName: 'Owner A' });
    const sale = (k, phone, extra) => ZF.posCompleteCheckout({ data: Object.assign({ idempotencyKey: k, merchantId: A, items: [{ productId: 'soap', qty: 4, unitPrice: 250 }],
      subtotal: 1000, grandTotal: 1000, discountTotal: 0, taxTotal: 0, payments: [{ method: 'cash', amount: 1000 }], buyerPhone: phone }, extra || {}),
      auth: { uid: A, token: { posRole: 'cashier' } } });
    const before = (await get('loyaltyAccounts/jane')).balance;
    pt5.r = await sale('T1', '+254712345678', { pointsEarned: { points: 99999 } });
    pt5.after = (await get('loyaltyAccounts/jane')).balance - before;
    pt5.receipt = await get('posReceipts/' + pt5.r.saleId);
    pt5.unknown = await sale('T2', '0700333444');
  } catch (e) { pt5.err = e.message; }
  ck('PT5 the till: the sale completes and the buyer earns 100 points from ITS total (a client-sent figure is ignored); an unknown number still completes, reason on the receipt',
    pt5.r && pt5.r.saleId && pt5.after === 100 && pt5.r.pointsEarned && pt5.r.pointsEarned.points === 100 && pt5.receipt && pt5.receipt.pointsEarned.points === 100
    && pt5.unknown && pt5.unknown.saleId && pt5.unknown.pointsEarned && pt5.unknown.pointsEarned.points === 0 && pt5.unknown.pointsEarned.reason === 'no-account',
    { r: pt5.r && pt5.r.pointsEarned, after: pt5.after, unknown: pt5.unknown && pt5.unknown.pointsEarned, err: pt5.err });

  /* PT6 — Quick Charge + online wiring */
  let md = {}, mdBad = {};
  try {
    const till = { sokoniTillId: 'T1', shopId: A, branchId: 'b', merchantUid: A, status: 'ACTIVE', currency: 'KES' };
    md = QA.priceTillSale({ till, callerUid: A, data: { items: [{ name: 'Service', price: 500, qty: 1 }], buyerPhone: '0712 345 678' } }).metadata;
    mdBad = QA.priceTillSale({ till, callerUid: A, data: { items: [{ name: 'Service', price: 500, qty: 1 }], buyerPhone: 'not-a-phone' } }).metadata;
  } catch (e) { md.err = e.message; }
  const ix = src('functions/index.js');
  ck('PT6 Quick Charge carries a normalised buyerPhone (garbage → null) and earns on PAID from the confirmed amount; online + card earn once per order',
    md.buyerPhone === '254712345678' && mdBad.buyerPhone === null
    && /earnForSale\(db, \{ buyerPhone: String\(_bp\), issuerShopId: String\(_md\.shopId \|\| _md\.merchantUid \|\| ""\),\s+saleId: _intentRef2, amountKES: amount, source: "quick" \}\)/.test(ix)
    && /earnForSale\(db, \{ buyerUid: String\(payData\.uid\), issuerShopId: String\(_pm\.offerShopId \|\| _pm\.sellerUid \|\| ""\),\s+saleId: String\(_pm\.orderId\), amountKES: Math\.max\(0, _subtotal - _offerDisc\), source: "online"/.test(ix)
    && /_LP\.earnForSale\(db, \{ buyerUid: String\(sessionDoc\.uid\), issuerShopId: k, saleId: orderId,/.test(ix)
    && /exports\.tillBuyerLookup\s+= _loyaltyPoints\.tillBuyerLookup;/.test(ix) && /exports\.tillCreateBuyer\s+= _loyaltyPoints\.tillCreateBuyer;/.test(ix),
    { md: md.buyerPhone, bad: mdBad.buyerPhone, err: md.err });

  /* PT7 — one order, two confirming paths */
  const o1 = await LP.earnForSale(db, { buyerUid: 'jane', issuerShopId: A, saleId: 'ORD9', amountKES: 500, source: 'online' });
  const o2 = await LP.earnForSale(db, { buyerUid: 'jane', issuerShopId: A, saleId: 'ORD9', amountKES: 500, source: 'card' });
  const o3 = await LP.earnForSale(db, { buyerUid: 'jane', issuerShopId: 'shopB', saleId: 'ORD9', amountKES: 300, source: 'card' });
  const ordRows = (await all('loyaltyLedger')).filter((l) => l.orderId === 'ORD9');
  ck('PT7 an order confirmed by BOTH the webhook and verifyIntasendPayment earns once per shop (50 + 30, never 100 + 30)',
    o1.points === 50 && o2.replay === true && o3.points === 30 && ordRows.length === 2 && ordRows.reduce((t, l) => t + l.points, 0) === 80,
    { o1, o2, o3, rows: ordRows.map((l) => l.id) });

  /* PT8 — the QR signing key is missing: fail closed */
  const HM = require(path.join(FN, 'loyalty.js'))._internal.LOYALTY_HMAC; const hv = HM.value;
  let p8 = {};
  try {
    HM.value = () => '';
    await db.doc('users/nosec').set({ phoneNumber: '+254711000999', displayName: 'No Sec' });
    p8.err = await codeOf(LP.earnForSale(db, { buyerUid: 'nosec', issuerShopId: A, saleId: 'S8', amountKES: 1000, source: 'till' }));
    p8.acc = await get('loyaltyAccounts/nosec');
    p8.jane = await LP.earnForSale(db, { buyerUid: 'jane', issuerShopId: A, saleId: 'S8b', amountKES: 1000, source: 'till' });
  } finally { HM.value = hv; }
  const zfSrc = src('functions/pos-zero-friction.js');
  ck('PT8 no signing key: no account is opened (a QR must never be signed with a placeholder); an existing account still earns; every earning function binds the secret',
    p8.err && /LOYALTY_HMAC/.test(p8.err) && p8.acc === null && p8.jane && p8.jane.ok && p8.jane.points === 100
    && /onCall\(\{ \.\.\.cfgHeavy, secrets: \[_LOYALTY_HMAC\] \}/.test(zfSrc) && /defineSecret\('LOYALTY_HMAC_SECRET'\)/.test(zfSrc)
    && /secrets:\s+\[INTASEND_PRIVATE_KEY, require\("\.\/loyalty"\)\._internal\.LOYALTY_HMAC\]/.test(ix)
    && /secrets: \[INTASEND_WEBHOOK_CHALLENGE, require\("\.\/loyalty"\)\._internal\.LOYALTY_HMAC\]/.test(ix), p8);

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
