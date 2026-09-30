/* test-quick-charge-sell-browser.js — Step 2 (2026-09-30): QUICK CHARGE on the till (merchant-v2 Sell), real Chromium.
 * REAL Sell screen; REAL posCompleteCheckout (the quick_charge lane), Smart Customer callables, SOKONI points and the
 * real Quick Charge pricer over the fake Firestore. Only the verified webhook's effect (intent PAID) is simulated.
 *
 * PROVES
 *   QB1 "＋ Quick charge" from an empty till → description + amount → the cart shows it as a quick charge (no stock)
 *   QB2 a customer found by Smart Customer Search is attached; the cash sale completes as ONE canonical sale: the quick
 *       line (priceSource quick_charge, no product), the customer from the shop's own record, the receipt — and SOKONI
 *       points for THAT customer (150 on KES 1,500) with no phone typed into the points box
 *   QB3 a quick charge paid by M-PESA: the payment is created SALE-BOUND for exactly the amount, completes the sale once
 *       PAID with the payment as its proof; no stock is taken
 *   QB4 an empty description is refused on screen — nothing added
 *   QB5 no page errors
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-quick-charge-sell';
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
  if (id === './workforce-identity') return { _assertBusinessPermission: async () => { throw new HttpsError('permission-denied', 'no membership'); } };
  if (id === './tenant-identity') return { resolveMerchantIdForOwner: async () => ({ ok: false }) };
  if (id === './shop-employees') return { resolveShopAccess: async (uid, shopId) => { if (uid !== shopId) throw new HttpsError('permission-denied', 'no access'); return { role: 'owner' }; }, capabilitiesForRole: () => ['sell', 'discount'] };
  return origReq.apply(this, arguments);
};
let ZF, LP, SC; try { ZF = require(Path.join(FN, 'pos-zero-friction.js')); LP = require(Path.join(FN, 'loyalty-points.js')); SC = require(Path.join(FN, 'pos-customer-scope.js')); } catch (e) { ZF = ZF || { __err: e.message }; }
const A = 'shopA';
const wrap = (fn) => async (payload) => { try { return { data: await fn(payload) }; } catch (e) { return { err: e.message, code: e.code }; } };
const au = { uid: A, token: { posRole: 'cashier' } };
const serverSale = wrap((p) => ZF.posCompleteCheckout({ data: p, auth: au }));
const serverLookup = wrap((p) => LP.lookup(db, { uid: A, data: p }));
const serverCSearch = wrap((p) => ZF.posCustomerSearch({ data: p, auth: au }));
const serverCSave = wrap((p) => ZF.posCustomerSave({ data: p, auth: au }));
const serverCCard = wrap((p) => ZF.posCustomerCard({ data: p, auth: au }));
const PPX = require(Path.join(FN, 'payment-purposes.js'));
const TILL = { sokoniTillId: 'TILLA', shopId: A, branchId: 'main', merchantUid: A, status: 'ACTIVE', currency: 'KES' };
const INTENT_CALLS = [], STK = [];
const serverIntent = wrap(async (p) => {
  INTENT_CALLS.push(JSON.parse(JSON.stringify(p)));
  const q = await PPX.PURPOSES.pos_till_sale.price(A, p);
  const ref = q.preferredRef || ('INT' + Date.now());
  await db.doc('paymentIntents/' + ref).set({ ref, uid: A, purpose: 'pos_till_sale', amount: q.amountCents / 100, amountCents: q.amountCents, metadata: q.metadata, status: 'created' });
  return { ref, amount: q.amountCents / 100 };
});
const serverMyTill = wrap(async () => Object.assign({ exists: true }, TILL));
const serverStk = wrap(async (p) => { STK.push(p); return { ok: true }; });
const serverMint = wrap(async (p) => ({ qrUrl: 'https://mysokoni.co.ke/pay-q?r=' + p.ref }));
const serverRead = async (ref) => { const s = await db.doc('paymentIntents/' + ref).get(); return s.exists ? s.data() : null; };
const markPaid = async () => { for (const d of (await db.collection('paymentIntents').get()).docs) if (d.data().status === 'created') await d.ref.update({ status: 'paid', paymentRef: 'IS-' + d.id }); };
const all = async (c) => (await db.collection(c).get()).docs.map((d) => Object.assign({ id: d.id }, d.data()));
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{--txt:#f4f4f4;--txt2:#a8a8a8;--txt3:#6d6d6d;--acc:#71ff00;--line:rgba(255,255,255,.09);--panel:#0d0d0d;--card:#141414}body{margin:0;background:#050505;color:#f4f4f4;font:14px system-ui}#native-sell{height:100vh}</style></head>
<body><div id="native-sell"></div>
<script src="/sokoni-merchant-data.js"></script><script src="/sokoni-merchant-stock.js"></script><script src="/sokoni-merchant-sell.js"></script>
<script>
  window.__calls = [];
  var CATALOGUE = [{ id: 'stove', name: 'Stove', price: 1000, stock: 50, shopId: 'shopA', status: 'active' }];
  var db = { queryProducts: function () { return Promise.resolve(CATALOGUE.map(function (p) { return Object.assign({}, p); })); }, queryMovements: function () { return Promise.resolve([]); } };
  function via(fn, tag) { return function (payload) { if (tag) window.__calls.push(JSON.parse(JSON.stringify(payload)));
    return fn(payload).then(function (r) { if (r.err) { var e = new Error(r.err); e.code = r.code; throw e; } return { data: r.data }; }); }; }
  window.__mount = function () {
    if (window.__sell) { try { window.__sell.destroy(); } catch (e) {} }
    var h = document.getElementById('native-sell'); h.innerHTML = ''; window.__calls = [];
    window.__sell = SokoniMerchantSell.mount(h, { scope: SokoniMerchantData.resolveScope({ uid: 'shopA', activeShopId: 'shopA' }), db: db, shopName: 'Mama Duka',
      callSale: via(window.__serverSale, true), callAdjust: function () { return Promise.reject(new Error('no')); }, onToast: function () {},
      callBuyerLookup: via(window.__lookup), callCreateBuyer: function () { return Promise.reject(new Error('no')); },
      callCustomerSearch: via(window.__csearch), callCustomerSave: via(window.__csave), callCustomerCard: via(window.__ccard),
      callMyTill: via(window.__myTill), callCreateIntent: via(window.__intent), callStkPush: via(window.__stk), callMintQR: via(window.__mint),
      readIntent: function (ref) { return window.__read(ref); } });
  };
</script></body></html>`;
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      if (u === '/sell.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
      const f = Path.join(ROOT, u.replace(/^\/+/, ''));
      if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(''); }
      res.writeHead(200, { 'content-type': 'application/javascript' }); res.end(fs.readFileSync(f));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  if (typeof ZF.posCompleteCheckout !== 'function') { ck('QB0 the sale authority loads', false, ZF.__err); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  await db.doc('products/stove').set({ name: 'Stove', price: 1000, stock: 50, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  await db.doc('shops/' + A).set({ name: 'Mama Duka', sellerUid: A }); await db.doc('users/' + A).set({ displayName: 'Owner A' });
  await db.doc('sokoniTills/TILLA').set(TILL);
  await db.doc('users/jane').set({ phoneNumber: '+254722376801', displayName: 'Jane Wanjiru' }); AUTH.users.jane = { uid: 'jane', phoneNumber: '+254722376801' };
  await db.doc('loyaltyAccounts/jane').set({ uid: 'jane', loyaltyId: 'SKN-J', balance: 0, status: 'active' });
  const jane = await SC.saveOwned(db, A, { phone: '0722376801', name: 'Jane Wanjiru', by: A });

  const srv = await serve();
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const T = { timeout: 12000 };
  const errors = [];
  const act = async (label, fn) => { try { await fn(); return true; } catch (e) { ck('flow: ' + label, false, String(e && e.message).slice(0, 200)); return false; } };
  try {
    const P = await browser.newPage({ viewport: { width: 390, height: 900 } });
    P.on('pageerror', (e) => errors.push(e.message));
    for (const [n, fn] of [['__serverSale', serverSale], ['__lookup', serverLookup], ['__csearch', serverCSearch], ['__csave', serverCSave], ['__ccard', serverCCard],
      ['__myTill', serverMyTill], ['__intent', serverIntent], ['__stk', serverStk], ['__mint', serverMint], ['__read', serverRead]]) await P.exposeFunction(n, fn);
    await P.goto(BASE + '/sell.html');
    const stock0 = (await get('products/stove')).stock;

    /* QB4 first: an empty description */
    let qb4 = {};
    await act('empty description', async () => {
      await P.evaluate(() => window.__mount()); await P.waitForSelector('[data-act="quick-open"]', T);
      await P.click('[data-act="quick-open"]', T); await P.waitForSelector('#msl-qdesc', T);
      await P.fill('#msl-qamt', '500'); await P.click('[data-act="quick-add"]', T);
      await P.waitForTimeout(200);
      qb4.err = await P.evaluate(() => (document.querySelector('.msl-sh-b [role="alert"]') || {}).innerText || '');
      qb4.cart = await P.evaluate(() => document.querySelectorAll('.msl-line').length);
      await P.click('[data-act="quick-cancel"]', T);
    });
    ck('QB4 an empty description is refused on screen — nothing is added', /Describe the charge/.test(qb4.err || '') && qb4.cart === 0, qb4);

    /* QB1 + QB2 */
    let qb = {};
    await act('quick charge + customer + cash', async () => {
      await P.evaluate(() => window.__mount()); await P.waitForSelector('[data-act="quick-open"]', T);
      await P.click('[data-act="quick-open"]', T); await P.waitForSelector('#msl-qdesc', T);
      await P.fill('#msl-qdesc', 'Screen repair'); await P.fill('#msl-qamt', '1500');
      await P.click('[data-act="quick-add"]', T);
      await P.waitForSelector('.msl-line', T);
      qb.line = await P.evaluate(() => document.querySelector('.msl-line').innerText);
      await P.click('.msl-sheet [data-act="charge"]', T);
      await P.waitForFunction(() => /Amount due/.test(document.body.innerText) && !/Checking the shop/.test(document.body.innerText), null, T);
      await P.type('#msl-cq', '0722376801', { delay: 20 });
      await P.waitForSelector('.msl-crow.sug', T); await P.click('.msl-crow.sug', T);
      await P.waitForSelector('.msl-ccard', T);
      await P.click('[data-act="tender"][data-v="exact"]', T);
      await P.click('[data-act="complete"]', T);
      await P.waitForFunction(() => /Sale complete/.test(document.body.innerText), null, { timeout: 15000 });
      qb.call = await P.evaluate(() => window.__calls.filter((c) => !c.dryRun).pop() || null);
    });
    const s1 = (await all('posRetailSales'))[0] || {};
    const l1 = (s1.items || [])[0] || {};
    ck('QB1 "＋ Quick charge" → description + amount → the cart shows it as a quick charge (no stock figure)', /Screen repair/.test(qb.line || '') && /Quick charge/.test(qb.line || '') && !/in stock/.test(qb.line || ''), qb.line);
    ck('QB2 attached customer + cash → ONE canonical sale: the quick line (no product), the customer from the record, a receipt, and 150 SOKONI points for THAT customer (no phone typed)',
      qb.call && (qb.call.items || [])[0] && qb.call.items[0].quickCharge === true && !qb.call.items[0].productId && qb.call.customer && qb.call.customer.id === jane.id
      && l1.priceSource === 'quick_charge' && l1.productId === null && s1.grandTotal === 1500 && s1.customer && s1.customer.name === 'Jane Wanjiru'
      && !!(await get('posReceipts/' + s1.id)) && (await get('loyaltyAccounts/jane')).balance === 150 && (await get('products/stove')).stock === stock0,
      { sent: qb.call && qb.call.items, line: l1, cust: s1.customer, pts: (await get('loyaltyAccounts/jane')).balance });

    /* QB3 — M-PESA */
    let q3 = {};
    await act('quick charge by M-PESA', async () => {
      await P.evaluate(() => window.__mount()); await P.waitForSelector('[data-act="quick-open"]', T);
      await P.click('[data-act="quick-open"]', T); await P.waitForSelector('#msl-qdesc', T);
      await P.fill('#msl-qdesc', 'Delivery to Kilimani'); await P.fill('#msl-qamt', '350');
      await P.click('[data-act="quick-add"]', T);
      await P.click('.msl-sheet [data-act="charge"]', T);
      await P.waitForFunction(() => /Amount due/.test(document.body.innerText) && !/Checking the shop/.test(document.body.innerText), null, T);
      await P.click('[data-act="method"][data-m="mpesa"]', T);
      await P.fill('#msl-mphone', '0712 345 678');
      await P.click('[data-act="pay-request"]', T);
      await P.waitForFunction(() => /Waiting for the customer to pay/.test(document.body.innerText), null, T);
      await markPaid();
      await P.waitForFunction(() => /Sale complete/.test(document.body.innerText), null, { timeout: 15000 });
    });
    const s3 = (await all('posRetailSales')).find((x) => x.grandTotal === 350) || {};
    const ic = INTENT_CALLS[INTENT_CALLS.length - 1] || {};
    const pay = (s3.payments || [])[0] || {};
    ck('QB3 by M-PESA: the payment is created SALE-BOUND for exactly KES 350 and completes the quick-charge sale once PAID, with the payment as proof; no stock taken',
      ic.saleBound === true && STK.length === 1 && STK[0].amount === 350 && pay.method === 'mpesa' && pay.confirmed === true && !!pay.intentRef
      && (s3.items || []).some((i) => i.priceSource === 'quick_charge' && i.name === 'Delivery to Kilimani') && (await get('products/stove')).stock === stock0,
      { intent: ic, pay, items: s3.items });

    ck('QB5 no page errors', errors.length === 0, errors.slice(0, 3));
  } finally { await browser.close().catch(() => {}); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
