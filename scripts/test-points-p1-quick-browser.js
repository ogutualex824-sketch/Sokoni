/* test-points-p1-quick-browser.js — SOKONI Points P1 (2026-09-29): QUICK CHARGE identifies the buyer; the PAID sale earns.
 * The REAL Quick Charge module (sokoni-merchant-till.js, Chromium) with the REAL tillBuyerLookup / tillCreateBuyer and the
 * REAL Quick Charge pricer (sokoni-qr-authority.priceTillSale) behind page.exposeFunction; the webhook's earn on PAID is
 * the REAL earnForSale with the intent's own metadata. Auth stubbed; SMS queued only.
 *
 * PROVES
 *   PQ1 a known buyer: ⭐ Check shows only a masked identity; the intent's server metadata carries the normalised phone;
 *       on PAID the buyer earns 50 points for KES 500 (issued by this shop), once
 *   PQ2 an unknown number: the cashier is ASKED for consent; declining creates nothing and sends no phone; accepting
 *       creates the unclaimed account and the phone travels with the intent
 *   PQ3 a phone typed but never checked (or changed after the check) is NOT sent, and the cashier is told why
 *   PQ4 no horizontal overflow at 390 px; no page errors
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-points-quick';
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
  if (id === './shop-employees') return { resolveShopAccess: async () => ({ role: 'cashier' }), capabilitiesForRole: () => ['sell'] };
  return origReq.apply(this, arguments);
};
let LP, QA; try { LP = require(Path.join(FN, 'loyalty-points.js')); QA = require(Path.join(FN, 'sokoni-qr-authority.js')); } catch (e) { LP = LP || { __err: e.message }; QA = QA || { __err: e.message }; }
const A = 'shopA';
const TILL = { exists: true, sokoniTillId: 'T1', shopId: A, branchId: 'main', merchantUid: A, status: 'ACTIVE', currency: 'KES' };
const INTENTS = [];
const wrap = (fn) => async (payload) => { try { return { data: await fn(payload) }; } catch (e) { return { err: e.message, code: e.code }; } };
const serverLookup = wrap((p) => LP.lookup(db, { uid: 'cash1', data: p }));
const serverCreate = wrap((p) => LP.createBuyer(db, { uid: 'cash1', data: p }));
/* createPaymentIntent's pos_till_sale branch prices with priceTillSale — the metadata it stores is what the webhook reads */
const serverIntent = wrap(async (p) => { const pr = QA.priceTillSale({ till: TILL, callerUid: A, data: p }); const ref = 'I' + (INTENTS.length + 1); INTENTS.push({ ref, amount: pr.amountCents / 100, metadata: pr.metadata, sent: p }); return { ref }; });

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;background:#050505;color:#f4f4f4;font:14px system-ui}</style></head>
<body><div id="till"></div><script src="/sokoni-merchant-till.js"></script>
<script>
  function via(fn) { return function (payload) { return fn(payload).then(function (r) { if (r.err) { var e = new Error(r.err); e.code = r.code; throw e; } return { data: r.data }; }); }; }
  window.__mount = function () {
    var h = document.getElementById('till'); h.innerHTML = '';
    window.__t = SokoniMerchantTill.mount(h, { scope: { ok: true, shopId: 'shopA' }, shopName: 'Mama Duka',
      callMyTill: function () { return Promise.resolve({ data: ${JSON.stringify(TILL)} }); },
      callActivity: function () { return Promise.resolve({ data: { items: [] } }); },
      callCreateIntent: via(window.__serverIntent),
      callMintDynamicQR: function (p) { return Promise.resolve({ data: { qrUrl: 'https://mysokoni.co.ke/pay-q?r=' + p.ref, amount: 500, currency: 'KES' } }); },
      callBuyerLookup: via(window.__serverLookup), callCreateBuyer: via(window.__serverCreate) });
  };
</script></body></html>`;
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      if (u === '/till.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
      const f = Path.join(ROOT, u.replace(/^\/+/, ''));
      if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(''); }
      res.writeHead(200, { 'content-type': 'application/javascript' }); res.end(fs.readFileSync(f));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
/* the webhook's PAID step, verbatim in intent: metadata.buyerPhone → earnForSale(source 'quick', confirmed amount) */
const paid = (it) => (it.metadata.buyerPhone ? LP.earnForSale(db, { buyerPhone: String(it.metadata.buyerPhone), issuerShopId: String(it.metadata.shopId || it.metadata.merchantUid || ''), saleId: it.ref, amountKES: it.amount, source: 'quick' }) : Promise.resolve(null));

(async () => {
  if (typeof LP.lookup !== 'function' || typeof QA.priceTillSale !== 'function') { ck('PQ0 the points module and the Quick Charge pricer load', false, LP.__err || QA.__err); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  await db.doc('users/jane').set({ phoneNumber: '+254712345678', displayName: 'Jane Wanjiru' });
  AUTH.users.jane = { uid: 'jane', phoneNumber: '+254712345678' };
  await db.doc('shops/' + A).set({ name: 'Mama Duka' });
  const srv = await serve();
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const T = { timeout: 10000 };
  const errors = [];
  let DIALOG = 'dismiss', dialogs = 0;
  const act = async (label, fn) => { try { await fn(); return true; } catch (e) { ck('flow: ' + label, false, String(e && e.message).slice(0, 200)); return false; } };
  try {
    const P = await browser.newPage({ viewport: { width: 390, height: 900 } });
    P.on('pageerror', (e) => errors.push(e.message));
    P.on('dialog', (d) => { dialogs++; DIALOG === 'accept' ? d.accept() : d.dismiss(); });
    await P.exposeFunction('__serverLookup', serverLookup);
    await P.exposeFunction('__serverCreate', serverCreate);
    await P.exposeFunction('__serverIntent', serverIntent);
    await P.goto(BASE + '/till.html');
    const open = async () => { await P.evaluate(() => window.__mount()); await P.waitForSelector('[data-act="gen-dynamic"]', T); await P.fill('[data-f="amount"]', '500'); };
    const check = async (re) => { await P.click('[data-act="buyer-check"]', T); await P.waitForFunction((r) => new RegExp(r).test((document.querySelector('[data-f="buyerMsg"]') || {}).textContent || ''), re, T); return P.$eval('[data-f="buyerMsg"]', (e) => e.textContent); };
    const generate = async () => { const n = INTENTS.length; await P.click('[data-act="gen-dynamic"]', T); await P.waitForFunction(() => /QR ready/.test((document.querySelector('[data-el="dynamic-msg"]') || {}).textContent || ''), null, T);
      return { it: INTENTS[n], msg: await P.$eval('[data-el="dynamic-msg"]', (e) => e.textContent) }; };

    /* PQ1 */
    let m1 = '', g1 = null, e1 = null, e1b = null;
    await act('check a known buyer, charge, PAID', async () => {
      await open(); await P.fill('[data-f="buyerPhone"]', '0712 345 678'); m1 = await check('points');
      g1 = await generate(); e1 = await paid(g1.it); e1b = await paid(g1.it);
    });
    const led1 = await get('loyaltyLedger/earn__quick__' + (g1 && g1.it && g1.it.ref));
    ck('PQ1 a known buyer: masked identity only; the intent metadata carries the normalised phone; PAID earns 50 points for KES 500 from this shop, once',
      /J\. W\./.test(m1) && /••••678/.test(m1) && !/712345678|Wanjiru/.test(m1) && g1 && g1.it.metadata.buyerPhone === '254712345678'
      && e1 && e1.points === 50 && e1b && e1b.replay === true && led1 && led1.issuerShopId === A && led1.points === 50,
      { m1, phone: g1 && g1.it.metadata.buyerPhone, e1, replay: e1b && e1b.replay });

    /* PQ2 */
    let m2a = '', g2a = null, m2b = '', g2b = null, accBefore = null;
    await act('unknown number: decline, then accept', async () => {
      await open(); await P.fill('[data-f="buyerPhone"]', '0799000111');
      DIALOG = 'dismiss'; m2a = await check('Nothing was created'); accBefore = await get('users/u_0111');
      g2a = await generate();
      DIALOG = 'accept'; m2b = await check('Account created'); g2b = await generate();
    });
    const nu = await get('users/u_0111');
    ck('PQ2 an unknown number: consent is asked; declining creates nothing and sends no phone; accepting creates the unclaimed account and the phone travels',
      dialogs >= 2 && accBefore === null && g2a && g2a.it.metadata.buyerPhone === null && /Nothing was created/.test(m2a)
      && /••••111/.test(m2b) && nu && nu.createdVia === 'till' && nu.claimed === false && g2b && g2b.it.metadata.buyerPhone === '254799000111',
      { dialogs, m2a, m2b, a: g2a && g2a.it.metadata.buyerPhone, b: g2b && g2b.it.metadata.buyerPhone });

    /* PQ3 */
    let g3a = null, g3b = null;
    await act('typed but never checked; changed after the check', async () => {
      await open(); await P.fill('[data-f="buyerPhone"]', '0712345678'); g3a = await generate();
      await P.fill('[data-f="buyerPhone"]', '0712345678'); await check('points'); await P.fill('[data-f="buyerPhone"]', '0712345679'); g3b = await generate();
    });
    ck('PQ3 a phone never checked, or changed after the check, is not sent — and the cashier is told',
      g3a && g3a.it.metadata.buyerPhone === null && g3a.it.sent.buyerPhone === undefined && /Check points first/.test(g3a.msg)
      && g3b && g3b.it.metadata.buyerPhone === null && /Check points first/.test(g3b.msg),
      { a: g3a && [g3a.it.sent.buyerPhone, g3a.msg], b: g3b && g3b.it.metadata.buyerPhone });

    const over = await P.evaluate(() => document.documentElement.scrollWidth - window.innerWidth <= 1).catch(() => false);
    ck('PQ4 no horizontal overflow at 390 px; no page errors', over && errors.length === 0, { over, errors: errors.slice(0, 3) });
  } finally { await browser.close().catch(() => {}); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
