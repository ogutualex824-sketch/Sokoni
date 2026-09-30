/* test-quick-charge-poscheckout-browser.js — Step 2 (2026-09-30): QUICK CHARGE on pos-checkout.html (real Chromium).
 * REAL page; REAL posCompleteCheckout (quick_charge lane), Smart Customer callables, SOKONI points and the Quick Charge
 * pricer over the fake Firestore. window.firebase only signs in the shop owner and routes callables.
 *
 * PROVES
 *   QP1 "＋ Quick charge" → description + amount → the cart row says "Quick charge · not a product"
 *   QP2 the shop-offer quote is never asked about the quick line (it is not a product; no offer is computed on it)
 *   QP3 an attached customer + cash → ONE canonical sale with the quick line (no product), the customer from the shop's
 *       record, and SOKONI points for THAT customer — 1 per KES 10 of the sale the server recorded
 *   QP4 M-PESA: the IntaSend payment is created SALE-BOUND for this sale
 *   QP9 no page error from the quick-charge code
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-quick-charge-pc';
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
const SC = require(Path.join(FN, 'pos-customer-scope.js'));
const ROUTES = {
  posCustomerSearch: (p) => ZF.posCustomerSearch({ data: p, auth: { uid: A, token: {} } }),
  posCustomerSave: (p) => ZF.posCustomerSave({ data: p, auth: { uid: A, token: {} } }),
  posCustomerCard: (p) => ZF.posCustomerCard({ data: p, auth: { uid: A, token: {} } }),
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

    /* the site's one-time privacy notice overlays the till on first visit; a cashier dismisses it once */
    await P.evaluate(() => { const b = document.getElementById('_sokoniPrivacyBanner'); if (b) b.remove(); });
    const jane = await SC.saveOwned(db, A, { phone: '0712345678', name: 'Jane Wanjiru', by: A });
    await db.doc('sokoniTills/TILLA').set(TILL);
    const salesN = async () => (await all('posRetailSales')).length;

    /* QP1 + QP2 */
    let qp = {};
    await act('add a quick charge', async () => {
      await P.evaluate(() => Checkout.addItem({ id: 'stove', name: 'Stove', price: 1000 }));   /* a MIXED cart: the offer quote really runs */
      await P.waitForTimeout(700);
      await P.evaluate(() => Checkout.quickChargeOpen());
      await P.fill('#qc-desc', 'Screen repair'); await P.fill('#qc-amt', '1500');
      await P.evaluate(() => Checkout.quickChargeAdd());
      await P.waitForFunction(() => /Screen repair/.test((document.getElementById('cart-rows') || {}).innerText || ''), null, T);
      qp.row = await P.evaluate(() => document.getElementById('cart-rows').innerText);
      await P.waitForTimeout(600);
    });
    ck('QP1 "＋ Quick charge" → the cart row says "Quick charge · not a product"', /Screen repair/.test(qp.row || '') && /Quick charge · not a product/i.test(qp.row || ''), qp.row);
    const offerCalls = CALLS.filter((c) => c.name === 'shopOfferQuote');
    ck('QP2 the shop-offer quote (asked for the mixed cart) is never asked about the quick line', offerCalls.length > 0 && offerCalls.every((c) => !(c.payload.items || []).some((i) => /^qc_/.test(String(i.productId)))), offerCalls.map((c) => c.payload.items));

    /* QP3: attach Jane, pay cash */
    let q3 = {};
    await act('customer + cash', async () => {
      await P.evaluate(() => { const b = document.getElementById('_sokoniPrivacyBanner'); if (b) b.remove(); });
      await P.type('#cust-input', '0712 345 678', { delay: 20 });
      await P.waitForSelector('.cs-found', T);
      await P.press('#cust-input', 'Enter');
      await P.waitForFunction(() => document.getElementById('customer-card').classList.contains('visible'), null, T);
      await P.evaluate(() => Checkout.pay('cash'));
      await P.evaluate(() => { Checkout.cashExact(); Checkout.confirmCash(); });
      for (let i = 0; i < 40 && !(await salesN()); i++) await P.waitForTimeout(250);
      q3.call = (CALLS.filter((c) => c.name === 'posCompleteCheckout').pop() || {}).payload;
    });
    const s3 = (await all('posRetailSales'))[0] || {};
    const pts = (await get('loyaltyAccounts/jane') || {}).balance;
    ck('QP3 attached customer + cash → ONE canonical sale: the quick line (no product), the customer from the record, SOKONI points for THAT customer (1 per KES 10 of the recorded sale)',
      q3.call && (q3.call.items || []).some((i) => i.quickCharge === true && !i.productId) && (s3.items || []).some((i) => i.priceSource === 'quick_charge' && i.productId === null)
      && s3.customer && s3.customer.id === jane.id && s3.customer.name === 'Jane Wanjiru' && pts - 1000 === Math.floor((Number(s3.grandTotal) || 0) / 10) && pts > 1000   /* Jane starts with 1,000 */,
      { items: s3.items, cust: s3.customer, total: s3.grandTotal, pts });

    /* QP4: M-PESA is sale-bound */
    let q4 = {};
    await act('M-PESA sale-bound', async () => {
      await P.waitForTimeout(2600);   /* the page resets after a completed sale */
      await P.evaluate(() => Checkout.quickChargeOpen());
      await P.fill('#qc-desc', 'Delivery'); await P.fill('#qc-amt', '300');
      await P.evaluate(() => Checkout.quickChargeAdd());
      await P.evaluate(() => Checkout.pay('mpesa'));
      await P.fill('#mpesa-phone', '0712 345 678');
      await P.evaluate(() => Checkout.sendMpesa());
      for (let i = 0; i < 40 && !CALLS.some((c) => c.name === 'createPaymentIntent'); i++) await P.waitForTimeout(200);
      q4.intent = (CALLS.filter((c) => c.name === 'createPaymentIntent').pop() || {}).payload;
    });
    ck('QP4 M-PESA: the IntaSend payment is created SALE-BOUND for this sale', q4.intent && q4.intent.saleBound === true && !!q4.intent.saleId, q4.intent);
    const pe = errors.filter((m) => /quickCharge|qc-|cs-found|_escH|pickCustomer/i.test(m));
    ck('QP9 no page error from the quick-charge code', pe.length === 0, { errs: pe.slice(0, 3), other: errors.length });
    await ctx.close();
  } finally { await browser.close().catch(() => {}); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
