/* test-sell-offers-browser.js — universal catalogue U7c2 (2026-09-29): the till SHOWS the shop's offer and CHARGES the
 * same figure — the REAL merchant-v2 Sell screen (Chromium) wired to the REAL posCompleteCheckout (Node, fake Firestore)
 * through page.exposeFunction. Nothing in between is a stub of the money path.
 *
 *   Laptop KES 75,000 · Weekend Flash Sale 10% on the laptop
 *
 * PROVES
 *   SO1 with a live flash sale, Charge shows "Amount due KES 67,500" and names the offer; the sale completes at
 *       67,500; the server's sale carries the 7,500 offer discount; ONE dry run then ONE sale, one idempotency key
 *   SO2 an offer published AFTER Charge was tapped: the sale is refused by the server (nothing written), and the retry
 *       re-checks, SHOWS the new 67,500 total and only then completes — never a figure the cashier was not shown
 *   SO3 no live offer: the amount due and the sale are 75,000 (control)
 *   SO4 the offer store cannot be read: nothing is charged, and the cashier is told why
 *   SO5 no horizontal overflow at 390 px; no page errors
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-sell-offers';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const Path = require('path'), http = require('http'), fs = require('fs'), Module = require('module');
const ROOT = Path.resolve(__dirname, '..'), FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 300) + ']' : '')); ok ? pass++ : fail++; };
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({}) };
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-admin') return ADMIN;
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h, onDocumentCreated: (_o, h) => h, onDocumentUpdated: (_o, h) => h };
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {} };
  if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => '0' }) };
  if (id === './pos-audit') return { writeAudit: () => {} };
  if (id === './workforce-identity') return { _assertBusinessPermission: async () => { throw new HttpsError('permission-denied', 'no membership'); } };
  if (id === './tenant-identity') return { resolveMerchantIdForOwner: async () => ({ ok: false }) };
  if (id === './shop-employees') return { resolveShopAccess: async () => ({ role: 'owner' }), capabilitiesForRole: () => ['sell', 'discount'] };
  return origReq.apply(this, arguments);
};
let ZF; try { ZF = require(Path.join(FN, 'pos-zero-friction.js')); } catch (e) { ZF = { __err: e.message }; }
const A = 'shopA';
const FLASH = { shopId: A, sellerUid: A, type: 'percentage', template: 'flashSale', status: 'live', name: 'Weekend Flash Sale', percent: 10,
  qualifyingListingIds: ['laptop'], endsAt: new Date(Date.now() + 2 * 864e5).toISOString() };
let STORE_DOWN = false;
async function reset(withOffer) {
  for (const c of ['shopOffers', 'shopOfferRedemptions', 'posRetailSales', 'posReceipts', 'posIdempotency', 'posTransactions']) {
    for (const d of (await db.collection(c).get()).docs) await d.ref.delete();
  }
  await db.doc('products/laptop').set({ name: 'Laptop', price: 75000, stock: 5, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  await db.doc('shops/' + A).set({ name: 'Tech Hub', sellerUid: A }); await db.doc('users/' + A).set({ displayName: 'Owner A' });
  if (withOffer) await db.doc('shopOffers/f1').set(FLASH);
}
/* the one real server call the page makes, with an optional offer-store outage */
async function serverSale(payload) {
  const origCol = db.collection.bind(db);
  if (STORE_DOWN) db.collection = (n) => (n === 'shopOffers' ? { where: () => ({ where: () => ({ limit: () => ({ get: async () => { throw new Error('down'); } }) }) }), doc: (id) => origCol(n).doc(id) } : origCol(n));
  try {
    const data = await ZF.posCompleteCheckout({ data: payload, auth: { uid: A, token: { posRole: 'cashier' } } });
    return { data };
  } catch (e) { return { err: e.message, code: e.code }; } finally { db.collection = origCol; }
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{--txt:#f4f4f4;--txt2:#a8a8a8;--txt3:#6d6d6d;--acc:#71ff00;--line:rgba(255,255,255,.09);--panel:#0d0d0d;--card:#141414}body{margin:0;background:#050505;color:#f4f4f4;font:14px system-ui}#native-sell{height:100vh}</style></head>
<body><div id="native-sell"></div>
<script src="/sokoni-merchant-data.js"></script><script src="/sokoni-merchant-stock.js"></script><script src="/sokoni-merchant-sell.js"></script>
<script>
  window.__calls = [];
  var CATALOGUE = [{ id: 'laptop', name: 'Laptop', price: 75000, stock: 5, shopId: 'shopA', status: 'active' }];
  var db = { queryProducts: function () { return Promise.resolve(CATALOGUE.map(function (p) { return Object.assign({}, p); })); }, queryMovements: function () { return Promise.resolve([]); } };
  function callSale(payload) {
    window.__calls.push(JSON.parse(JSON.stringify(payload)));
    return window.__serverSale(payload).then(function (r) { if (r.err) { var e = new Error(r.err); e.code = r.code; throw e; } return { data: r.data }; });
  }
  window.__mount = function () {
    if (window.__sell) { try { window.__sell.destroy(); } catch (e) {} }
    var h = document.getElementById('native-sell'); h.innerHTML = ''; window.__calls = [];
    window.__sell = SokoniMerchantSell.mount(h, { scope: SokoniMerchantData.resolveScope({ uid: 'shopA', activeShopId: 'shopA' }), db: db, shopName: 'Tech Hub',
      callSale: callSale, callAdjust: function () { return Promise.reject(new Error('no')); }, onToast: function () {} });
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
const salesOf = async () => (await db.collection('posRetailSales').get()).docs.map((d) => d.data());

(async () => {
  if (typeof ZF.posCompleteCheckout !== 'function') { ck('SO0 the till loads', false, ZF.__err); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
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
    await P.exposeFunction('__serverSale', serverSale);
    await P.goto(BASE + '/sell.html');
    const ring = async () => {
      await P.evaluate(() => window.__mount()); await P.waitForSelector('.msl-card', T);
      await P.click('.msl-card', T); await P.click('[data-act="charge"]', T);
      await P.waitForFunction(() => /Amount due/.test(document.body.innerText) && !/Checking the shop/.test(document.body.innerText), null, T);
    };
    const due = () => P.evaluate(() => { const m = /Amount due\s*KES ([\d,]+)/.exec(document.body.innerText); return m ? Number(m[1].replace(/,/g, '')) : null; });
    const completeCash = async () => { await P.click('[data-act="tender"][data-v="exact"]', T); await P.click('[data-act="complete"]', T); };

    /* SO1 */
    await reset(true);
    let d1 = null, named = false, paid = null;
    await act('ring the laptop with a live flash sale', async () => {
      await ring(); d1 = await due(); named = await P.evaluate(() => /Weekend Flash Sale/.test(document.body.innerText));
      await completeCash(); await P.waitForFunction(() => /Sale complete/.test(document.body.innerText), null, T);
      paid = await P.evaluate(() => { const m = /Paid\s*KES ([\d,]+)/.exec(document.body.innerText); return m ? Number(m[1].replace(/,/g, '')) : null; });
    });
    const s1 = await salesOf(); const c1 = await P.evaluate(() => window.__calls);
    ck('SO1 Charge shows 67,500 and names the offer; the sale completes at 67,500 with the 7,500 discount; 1 dry run + 1 sale, one key',
      d1 === 67500 && named && paid === 67500 && s1.length === 1 && s1[0].grandTotal === 67500 && s1[0].offerDiscount === 7500
      && c1.length === 2 && c1[0].dryRun === true && !c1[1].dryRun && c1[0].idempotencyKey === c1[1].idempotencyKey && c1[1].grandTotal === 67500,
      { due: d1, named, paid, sales: s1.map((s) => s.grandTotal), calls: c1.map((c) => (c.dryRun ? 'dry' : 'sale') + ':' + c.grandTotal) });

    /* SO2 — an offer published after Charge */
    await reset(false);
    let d2a = null, firstErr = '', d2b = null, msg = '', paid2 = null, writesAfterRefusal = null;
    await act('offer appears between Charge and Complete', async () => {
      await ring(); d2a = await due();
      await db.doc('shopOffers/f1').set(FLASH);                                     /* the owner publishes it now */
      await completeCash();
      await P.waitForFunction(() => /Try again|nothing was charged/i.test(document.body.innerText), null, T);
      firstErr = await P.evaluate(() => (document.querySelector('.msl-err') || {}).innerText || '');
      writesAfterRefusal = (await salesOf()).length;
      await P.click('[data-act="complete"]', T);                                  /* Try again → re-check */
      await P.waitForFunction(() => /offers changed this total/i.test(document.body.innerText), null, T);
      msg = await P.evaluate(() => [...document.querySelectorAll('.msl-warn')].map((e) => e.innerText).join(' '));
      d2b = await due();
      await completeCash(); await P.waitForFunction(() => /Sale complete/.test(document.body.innerText), null, T);
      paid2 = await P.evaluate(() => { const m = /Paid\s*KES ([\d,]+)/.exec(document.body.innerText); return m ? Number(m[1].replace(/,/g, '')) : null; });
    });
    const s2 = await salesOf();
    ck('SO2 an offer published after Charge: the first attempt is refused unwritten; the retry SHOWS 67,500 and completes at it',
      d2a === 75000 && /mismatch|Ring the sale up again/i.test(firstErr) && writesAfterRefusal === 0 && /67,500/.test(msg) && d2b === 67500
      && paid2 === 67500 && s2.length === 1 && s2[0].grandTotal === 67500, { d2a, firstErr: firstErr.slice(0, 80), writesAfterRefusal, msg: msg.slice(0, 90), d2b, paid2 });

    /* SO3 — control */
    await reset(false);
    let d3 = null;
    await act('ring the laptop with no offer', async () => { await ring(); d3 = await due(); await completeCash(); await P.waitForFunction(() => /Sale complete/.test(document.body.innerText), null, T); });
    const s3 = await salesOf();
    ck('SO3 no live offer: amount due and sale are 75,000', d3 === 75000 && s3.length === 1 && s3[0].grandTotal === 75000 && !s3[0].offerDiscount, { d3, sale: s3[0] && s3[0].grandTotal });

    /* SO4 — offer store down */
    await reset(true); STORE_DOWN = true;
    let warn4 = '';
    await act('the offer store cannot be read', async () => {
      await ring(); await completeCash();
      await P.waitForFunction(() => /could not be checked/i.test(document.body.innerText), null, T);
      warn4 = await P.evaluate(() => [...document.querySelectorAll('.msl-warn,.msl-err')].map((e) => e.innerText).join(' '));
    });
    STORE_DOWN = false;
    ck('SO4 an unreadable offer store: nothing charged, and the cashier is told why', /could not be checked/i.test(warn4) && (await salesOf()).length === 0, warn4.slice(0, 120));

    const over = await P.evaluate(() => document.documentElement.scrollWidth - window.innerWidth <= 1).catch(() => false);
    ck('SO5 no horizontal overflow at 390 px; no page errors', over && errors.length === 0, { over, errors: errors.slice(0, 3) });
  } finally { await browser.close().catch(() => {}); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
