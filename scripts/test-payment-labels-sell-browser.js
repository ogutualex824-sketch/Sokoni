/* test-payment-labels-sell-browser.js — slice 13 UI (2026-09-29): M-PESA and card on the merchant-v2 Sell screen go through
 * IntaSend. REAL Sell screen (Chromium) + REAL Quick Charge pricer + REAL posCompleteCheckout over the fake Firestore; the
 * verified webhook's effect (the intent becoming PAID) is simulated by the test — nothing else.
 *
 * PROVES
 *   LS1 M-PESA: Complete stays locked until PAID; "Send M-PESA request" creates a Quick Charge payment bound to THIS sale
 *       for exactly the amount due and pushes the prompt to the customer's number
 *   LS2 when the payment becomes PAID the sale completes by itself, with that payment as its proof (confirmed, intentRef)
 *   LS3 card: "Show payment QR" → the same IntaSend proof → the sale completes as card
 *   LS4 no page errors
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-labels-sell';
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
const wrap = (fn) => async (payload) => { try { return { data: await fn(payload) }; } catch (e) { return { err: e.message, code: e.code }; } };
const serverSale = wrap((p) => ZF.posCompleteCheckout({ data: p, auth: { uid: A, token: { posRole: 'cashier' } } }));
const serverLookup = wrap((p) => LP.lookup(db, { uid: A, data: p }));
const serverCreate = wrap((p) => LP.createBuyer(db, { uid: A, data: p }));
const PS = (() => { try { return require(Path.join(FN, 'loyalty-points-spend.js')); } catch (e) { return { __err: e.message }; } })();
const serverPStart = wrap((p) => PS.tillStart(db, { uid: A, data: p }));
const serverPConfirm = wrap((p) => PS.tillConfirm(db, { uid: A, data: p }));
const serverPCancel = wrap((p) => PS.tillCancel(db, { uid: A, data: p }));

const PP = (() => { try { return require(Path.join(FN, 'payment-purposes.js')); } catch (e) { return { __err: e.message }; } })();
const TILL = { sokoniTillId: 'TILLA', shopId: A, branchId: 'main', merchantUid: A, status: 'ACTIVE', currency: 'KES' };
const STK = [];
/* createPaymentIntent's pos_till_sale branch: the REAL pricer, and the intent written as createPaymentIntent writes it */
const serverIntent = wrap(async (p) => {
  const q = await PP.PURPOSES.pos_till_sale.price(A, p);
  const ref = q.preferredRef || ('INT' + Date.now());
  await db.doc('paymentIntents/' + ref).set({ ref, uid: A, purpose: 'pos_till_sale', amount: q.amountCents / 100, amountCents: q.amountCents, metadata: q.metadata, status: 'created' });
  return { ref, amount: q.amountCents / 100 };
});
const serverMyTill = wrap(async () => Object.assign({ exists: true }, TILL));
const serverStk = wrap(async (p) => { STK.push(p); return { ok: true }; });
const serverMint = wrap(async (p) => ({ qrUrl: 'https://mysokoni.co.ke/pay-q?r=' + p.ref }));
const serverRead = async (ref) => { const s = await db.doc('paymentIntents/' + ref).get(); return s.exists ? s.data() : null; };
/* the verified webhook's only effect that matters here: the intent becomes PAID */
const markPaid = async () => { const all = (await db.collection('paymentIntents').get()).docs; for (const d of all) if (d.data().status === 'created') await d.ref.update({ status: 'paid', paymentRef: 'IS-' + d.id }); };
async function reset() {
  for (const c of ['posRetailSales', 'posReceipts', 'posIdempotency', 'posTransactions', 'paymentIntents', 'posPaymentClaims']) for (const d of (await db.collection(c).get()).docs) await d.ref.delete();
  await db.doc('products/stove').set({ name: 'Stove', price: 1000, stock: 50, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  await db.doc('shops/' + A).set({ name: 'Mama Duka', sellerUid: A }); await db.doc('users/' + A).set({ displayName: 'Owner A' });
  await db.doc('sokoniTills/TILLA').set(TILL);
  STK.length = 0;
}
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
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const all = async (c) => (await db.collection(c).get()).docs.map((d) => Object.assign({ id: d.id }, d.data()));
const lastCode = async () => { const q = (await all('smsQueue')).concat(await all('sms_queue')).concat(await all('smsOutbox')).filter((m) => m.template === 'points_redeem_code');
  const m = q[q.length - 1]; const x = m && /Code (\d{6})/.exec(m.body || m.text || ''); return x ? x[1] : null; };


(async () => {
  if (typeof ZF.posCompleteCheckout !== 'function' || !PP.PURPOSES) { ck('LS0 the till and the Quick Charge pricer load', false, ZF.__err || PP.__err); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  const srv = await serve();
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const T = { timeout: 10000 };
  const errors = [];
  const act = async (label, fn) => { try { await fn(); return true; } catch (e) { ck('flow: ' + label, false, String(e && e.message).slice(0, 200)); return false; } };
  try {
    const P = await browser.newPage({ viewport: { width: 390, height: 900 } });
    P.on('pageerror', (e) => errors.push(e.message));
    for (const [n, fn] of [['__serverSale', serverSale], ['__myTill', serverMyTill], ['__intent', serverIntent], ['__stk', serverStk], ['__mint', serverMint], ['__read', serverRead]]) await P.exposeFunction(n, fn);
    await P.goto(BASE + '/sell.html');
    const ring = async (method) => {
      await P.evaluate(() => window.__mount()); await P.waitForSelector('.msl-card', T);
      await P.click('.msl-card', T); await P.click('[data-act="charge"]', T);
      await P.waitForFunction(() => /Amount due/.test(document.body.innerText) && !/Checking the shop/.test(document.body.innerText), null, T);
      await P.click('[data-act="method"][data-m="' + method + '"]', T);
    };

    /* LS1 + LS2 */
    await reset();
    let lockedBefore = null, waiting = '', sale = null, it = null;
    await act('M-PESA through IntaSend', async () => {
      await ring('mpesa');
      lockedBefore = await P.$eval('[data-act="complete"]', (b) => b.disabled);
      await P.fill('#msl-mphone', '0712 345 678');
      await P.click('[data-act="pay-request"]', T);
      await P.waitForFunction(() => /Waiting for the customer to pay/.test(document.body.innerText), null, T);
      waiting = await P.evaluate(() => (document.querySelector('.msl-waiting') || {}).innerText || '');
      it = ((await db.collection('paymentIntents').get()).docs[0] || { data: () => null }).data();
      await markPaid();
      await P.waitForFunction(() => /Sale complete/.test(document.body.innerText), null, { timeout: 15000 });
    });
    sale = (await all('posRetailSales'))[0] || null;
    const saleCall = await P.evaluate(() => window.__calls.filter((c) => !c.dryRun).pop() || null);
    ck('LS1 M-PESA: Complete is locked until paid; the request is a Quick Charge payment for THIS sale (its key) for exactly KES 1,000, pushed to the customer\'s number',
      lockedBefore === true && /KES 1,000/.test(waiting) && it && it.metadata.saleId === (saleCall && saleCall.idempotencyKey) && it.amount === 1000
      && STK.length === 1 && STK[0].phone === '254712345678' && STK[0].ref === it.ref, { lockedBefore, waiting, saleId: it && it.metadata.saleId, key: saleCall && saleCall.idempotencyKey, stk: STK });
    const pay = sale && (sale.payments || [])[0];
    ck('LS2 once PAID the sale completes by itself, with the IntaSend payment as its confirmed proof',
      sale && pay && pay.method === 'mpesa' && pay.confirmed === true && pay.intentRef === (it && it.ref) && !!(await get('posPaymentClaims/' + (it && it.ref))), { pay });

    /* LS3 — card */
    await reset();
    let sale3 = null;
    await act('card through the IntaSend payment QR', async () => {
      await ring('card');
      await P.click('[data-act="pay-request"]', T);
      await P.waitForFunction(() => /scan the QR/.test(document.body.innerText), null, T);
      await markPaid();
      await P.waitForFunction(() => /Sale complete/.test(document.body.innerText), null, { timeout: 15000 });
    });
    sale3 = (await all('posRetailSales'))[0] || null;
    const pay3 = sale3 && (sale3.payments || [])[0];
    ck('LS3 card: the same IntaSend proof — the customer pays from the QR, the sale completes as card, confirmed', pay3 && pay3.method === 'card' && pay3.confirmed === true && !!pay3.intentRef, { pay3 });

    ck('LS4 no page errors', errors.length === 0, errors.slice(0, 3));
  } finally { await browser.close().catch(() => {}); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
