/* test-payment-labels-poscheckout-browser.js — slice 13 UI on pos-checkout.html (real Chromium, 2026-09-29).
 * REAL page; REAL posCompleteCheckout, Quick Charge pricer and gift-card rule over the fake Firestore. window.firebase only
 * signs in the shop owner and routes callables / the owner's own intent read. The verified webhook's effect (intent PAID)
 * is simulated.
 *
 * PROVES
 *   PG1 a gift card is paid by code + PIN through the SERVER: the ONE store is debited with the sale (1,500 → 340)
 *   PG2 a wrong PIN is refused by the server — no sale, no debit
 *   PM1 M-PESA: the request is an IntaSend Quick Charge payment for THIS sale's total (incl. VAT), pushed to the customer;
 *       the sale completes only once PAID, with that payment as proof — the legacy booking / Daraja calls are gone
 *   PC9 no page error from the payment code
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-labels-pc';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const Path = require('path'), http = require('http'), fs = require('fs'), Module = require('module');
const ROOT = Path.resolve(__dirname, '..'), FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 320) + ']' : '')); ok ? pass++ : fail++; };
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
const AUTH = { users: {} };
const authApi = {
  createUser: async ({ phoneNumber, displayName }) => { const uid = 'u_' + phoneNumber.slice(-4); AUTH.users[uid] = { uid, phoneNumber, displayName }; return AUTH.users[uid]; },
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
  if (id === './workforce-identity') return { _assertBusinessPermission: async () => { throw new HttpsError('permission-denied', 'no membership'); } };
  if (id === './tenant-identity') return { resolveMerchantIdForOwner: async () => ({ ok: false }) };
  if (id === './shop-employees') return { resolveShopAccess: async () => ({ role: 'owner' }), capabilitiesForRole: () => ['sell', 'discount'] };
  return origReq.apply(this, arguments);
};
let ZF, LP; try { ZF = require(Path.join(FN, 'pos-zero-friction.js')); LP = require(Path.join(FN, 'loyalty-points.js')); } catch (e) { ZF = ZF || { __err: e.message }; LP = LP || { __err: e.message }; }
const A = 'shopA';
const PS = (() => { try { return require(Path.join(FN, 'loyalty-points-spend.js')); } catch (e) { return { __err: e.message }; } })();
const SO = (() => { try { return require(Path.join(FN, 'shop-offers.js')); } catch (e) { return { __err: e.message }; } })();
const CALLS = [];
const PPX = require(Path.join(FN, 'payment-purposes.js'));
const TILL = { sokoniTillId: 'TILLA', shopId: A, branchId: 'main', merchantUid: A, status: 'ACTIVE', currency: 'KES' };
const STK = [];
const readDoc = async (col, id) => { const d = await db.doc(col + '/' + id).get(); return d.exists ? d.data() : null; };
const markPaid = async () => { for (const d of (await db.collection('paymentIntents').get()).docs) if (d.data().status === 'created') await d.ref.update({ status: 'paid', paymentRef: 'IS-' + d.id }); };
const ROUTES = {
  posCompleteCheckout: (p) => ZF.posCompleteCheckout({ data: p, auth: { uid: A, token: { posRole: 'cashier' } } }),
  tillBuyerLookup: (p) => LP.lookup(db, { uid: A, data: p }),
  tillPointsStart: (p) => PS.tillStart(db, { uid: A, data: p }),
  tillPointsConfirm: (p) => PS.tillConfirm(db, { uid: A, data: p }),
  tillPointsCancel: (p) => PS.tillCancel(db, { uid: A, data: p }),
  shopOfferQuote: (p) => SO.quoteForCaller(db, { uid: A, data: p }),
  getMySokoniTill: async () => Object.assign({ exists: true }, TILL),
  createPaymentIntent: async (p) => { const q = await PPX.PURPOSES.pos_till_sale.price(A, p); const ref = q.preferredRef;
    await db.doc('paymentIntents/' + ref).set({ ref, uid: A, purpose: 'pos_till_sale', amount: q.amountCents / 100, metadata: q.metadata, status: 'created' }); return { ref, amount: q.amountCents / 100 }; },
  initiateSTKPush: async (p) => { STK.push(p); return { ok: true }; },
  mintDynamicSokoniQR: async (p) => ({ qrUrl: 'https://mysokoni.co.ke/pay-q?r=' + p.ref }),
};
const call = async (name, payload) => {
  CALLS.push({ name, payload });
  const fn = ROUTES[name];
  if (!fn) return { err: 'not available in this test: ' + name, code: 'unimplemented' };
  try { return { data: await fn(payload || {}) }; } catch (e) { return { err: e.message, code: e.code }; }
};
async function reset() {
  for (const c of ['posRetailSales', 'posReceipts', 'posIdempotency', 'posTransactions', 'loyaltyLedger', 'pointsHolds', 'tillRedemptions', 'tillRedeemCodes', 'smsQueue', 'sms_queue', 'smsOutbox']) for (const d of (await db.collection(c).get()).docs) await d.ref.delete();
  await db.doc('products/stove').set({ name: 'Stove', price: 1000, stock: 50, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  await db.doc('shops/' + A).set({ name: 'Mama Duka', sellerUid: A }); await db.doc('users/' + A).set({ displayName: 'Owner A' });
  await db.doc('loyaltyAccounts/jane').set({ uid: 'jane', loyaltyId: 'SKN-J', balance: 1000, status: 'active' });
}
const INSHELL_STUB = "window.SokoniInShell = { inShell: false, merchantScope: function () { return { shopId: 'shopA', ok: true }; }, requireAuth: function () { return true; } };";
const INIT = `
  window.firebase = {
    auth: function () { return { currentUser: { uid: 'shopA', displayName: 'Owner A' }, onAuthStateChanged: function (cb) { setTimeout(function () { cb({ uid: 'shopA', displayName: 'Owner A' }); }, 0); return function () {}; } }; },
    functions: function () { return { httpsCallable: function (name) { return function (payload) {
      return window.__call(name, payload).then(function (r) { if (r && r.err) { var e = new Error(r.err); e.code = r.code; throw e; } return { data: r.data }; });
    }; } }; },
    firestore: function () { return { collection: function (c) { return { doc: function (id) { return { get: function () {
      return window.__read(c, id).then(function (d) { return { exists: !!d, data: function () { return d; } }; }); } }; } }; } }; },
  };
`;
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      if (u === '/firebase.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end('/* stubbed */'); }
      if (u === '/sokoni-inshell.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(INSHELL_STUB); }
      const f = Path.join(ROOT, u.replace(/^\/+/, '') || 'index.html');
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(''); }
      const ext = Path.extname(f);
      res.writeHead(200, { 'content-type': ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : 'application/javascript' });
      res.end(fs.readFileSync(f));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const all = async (c) => (await db.collection(c).get()).docs.map((d) => Object.assign({ id: d.id }, d.data()));
const lastCode = async () => { const q = (await all('smsQueue')).concat(await all('sms_queue')).concat(await all('smsOutbox')).filter((m) => m.template === 'points_redeem_code');
  const m = q[q.length - 1]; const x = m && /Code (\d{6})/.exec(m.body || m.text || ''); return x ? x[1] : null; };

(async () => {
  if (typeof ZF.posCompleteCheckout !== 'function' || false) { ck('PC0 the till and pay-with-points load', false, ZF.__err || PS.__err || 'tillStart missing'); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  await db.doc('users/jane').set({ phoneNumber: '+254712345678', displayName: 'Jane Wanjiru' });
  AUTH.users.jane = { uid: 'jane', phoneNumber: '+254712345678' };
  await reset();
  const srv = await serve();
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const T = { timeout: 15000 };
  const errors = [];
  const act = async (label, fn) => { try { await fn(); return true; } catch (e) { ck('flow: ' + label, false, String(e && e.message).slice(0, 220)); return false; } };
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
    await ctx.addInitScript(INIT);
    const P = await ctx.newPage();
    P.on('pageerror', (e) => errors.push(e.message));
    await P.exposeFunction('__call', call);
    await P.exposeFunction('__read', readDoc);
    await P.goto(BASE + '/pos-checkout.html', { waitUntil: 'domcontentloaded' });
    await P.waitForFunction(() => typeof Checkout !== 'undefined' && typeof Checkout.pointsPayStart === 'function', null, T);
    await P.waitForTimeout(1200);   /* init: settings, auth callback */

    await db.doc('sokoniTills/TILLA').set(TILL);
    await db.doc('giftCards/GIFT-AAAA-0001').set({ code: 'GIFTAAAA0001', shopId: A, balance: 1500, status: 'active', pin: '1234', expiryDate: F.Timestamp.fromMillis(Date.now() + 864e5) });
    const salesN = async () => (await all('posRetailSales')).length;

    /* PG2 first: a wrong PIN */
    let pg2 = {};
    await act('gift card with a wrong PIN', async () => {
      await P.evaluate(() => Checkout.addItem({ id: 'stove', name: 'Stove', price: 1000 }));
      pg2.before = await salesN();
      await P.evaluate(() => Checkout.pay('gift_card'));
      await P.fill('#gift-card-code', 'GIFT-AAAA-0001'); await P.fill('#gift-card-pin', '9999');
      await P.evaluate(() => Checkout.confirmGiftCard());
      for (let i = 0; i < 30; i++) { if (CALLS.some((c) => c.name === 'posCompleteCheckout')) break; await P.waitForTimeout(200); }
      await P.waitForTimeout(800);
      pg2.after = await salesN(); pg2.bal = (await readDoc('giftCards', 'GIFT-AAAA-0001')).balance;
    });
    ck('PG2 a wrong gift card PIN is refused by the SERVER — no sale, no debit', pg2.before === pg2.after && pg2.bal === 1500, pg2);

    /* PG1: the right PIN (the cart still holds the stove: KES 1,000 + 16% VAT = 1,160) */
    let pg1 = {};
    await act('gift card with the right PIN', async () => {
      await P.evaluate(() => Checkout.pay('gift_card'));
      await P.fill('#gift-card-code', 'GIFT-AAAA-0001'); await P.fill('#gift-card-pin', '1234');
      await P.evaluate(() => Checkout.confirmGiftCard());
      for (let i = 0; i < 40 && !(await salesN()); i++) await P.waitForTimeout(250);
      pg1.sale = (await all('posRetailSales'))[0] || null; pg1.bal = (await readDoc('giftCards', 'GIFT-AAAA-0001')).balance;
      pg1.call = (CALLS.filter((c) => c.name === 'posCompleteCheckout').pop() || {}).payload;
    });
    const gp = pg1.call && pg1.call.payments && pg1.call.payments[0];
    ck('PG1 a gift card pays by code + PIN through the SERVER: the one store is debited with the sale (1,500 → 340); no device-side decrement',
      pg1.sale && pg1.bal === 340 && gp && gp.method === 'gift_card' && gp.code === 'GIFT-AAAA-0001' && gp.pin === '1234', { bal: pg1.bal, pay: gp });

    /* PM1: M-PESA through IntaSend */
    let pm = {};
    await act('M-PESA through IntaSend', async () => {
      await P.waitForTimeout(2600);   /* the page resets after a completed sale */
      await P.evaluate(() => Checkout.addItem({ id: 'stove', name: 'Stove', price: 1000 }));
      await P.evaluate(() => Checkout.pay('mpesa'));
      await P.fill('#mpesa-phone', '0712 345 678');
      pm.salesBefore = await salesN();
      await P.evaluate(() => Checkout.sendMpesa());
      for (let i = 0; i < 40 && !STK.length; i++) await P.waitForTimeout(200);
      await P.waitForTimeout(3500);
      pm.beforePaid = await salesN();
      await markPaid();
      for (let i = 0; i < 60 && (await salesN()) === pm.beforePaid; i++) await P.waitForTimeout(250);
      pm.after = await salesN();
      pm.call = (CALLS.filter((c) => c.name === 'posCompleteCheckout').pop() || {}).payload;
    });
    const mp = pm.call && (pm.call.payments || []).find((x) => x.method === 'mpesa');
    const it = mp && (await readDoc('paymentIntents', mp.intentRef));
    ck('PM1 M-PESA: an IntaSend Quick Charge payment for THIS sale (KES 1,160 incl. VAT) pushed to the customer; nothing until PAID; then the sale completes with it as proof — no booking / Daraja calls',
      STK.length === 1 && STK[0].phone === '254712345678' && STK[0].amount === 1160 && pm.beforePaid === pm.salesBefore && pm.after === pm.salesBefore + 1
      && mp && it && it.metadata.saleId === pm.call.idempotencyKey && !CALLS.some((c) => /posSendMpesa|platformBook/.test(c.name)),
      { stk: STK, beforePaid: pm.beforePaid, after: pm.after, mp, intentSale: it && it.metadata.saleId, key: pm.call && pm.call.idempotencyKey });
    const pe = errors.filter((m) => /intasend|_intasendIntent|_watchIntent|gift|mpesa|saleKey/i.test(m));
    ck('PC9 no page error from the payment code', pe.length === 0, { pointsErrors: pe.slice(0, 3), other: errors.length });
    await ctx.close();
  } finally { await browser.close().catch(() => {}); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
