/* test-smart-customer-sell-browser.js — Smart Customer Search on the merchant-v2 Sell screen (real Chromium, 2026-09-30).
 * REAL Sell screen; REAL posCustomerSearch / posCustomerSave / posCustomerCard, SOKONI points lookup and posCompleteCheckout
 * over the fake Firestore. Nothing is simulated but the transport.
 *
 * PROVES
 *   CB1 a partial number offers the shop's matching customers as CHOICES — nothing is suggested, nothing attached
 *   CB2 the full number → "Customer found ✓" with one highlighted row, still NOT attached until the cashier taps it;
 *       the tap shows her card (masked phone, purchases, spend, last purchase, ⭐ SOKONI points) and hands the number to
 *       the points box, which finds her SOKONI account
 *   CB3 the cash sale carries WHICH customer; the server names her from the shop's own record and counts the purchase
 *   CB4 an unknown number offers "New customer on 0799 ••• •456?" → name → Save: saved to THIS shop, attached, and the
 *       next sale carries it
 *   CB5 a name search lists matches "by name — choose one" (never a found badge)
 *   CB6 the full number never appears on the screen (masked everywhere)
 *   CB7 laid out for every device: no sideways scroll at 390px or 1280px with the card showing; rows are ≥44px tap targets
 *   CB8 no page errors
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-smart-customer-sell';
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
      callCustomerSearch: via(window.__csearch), callCustomerSave: via(window.__csave), callCustomerCard: via(window.__ccard) });
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
  if (typeof ZF.posCustomerSearch !== 'function' || !SC || typeof SC.saveOwned !== 'function') { ck('CB0 the smart customer authority loads', false, ZF.__err || 'missing'); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  await db.doc('products/stove').set({ name: 'Stove', price: 1000, stock: 50, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  await db.doc('shops/' + A).set({ name: 'Mama Duka', sellerUid: A }); await db.doc('users/' + A).set({ displayName: 'Owner A' });
  await db.doc('users/jane').set({ phoneNumber: '+254722376801', displayName: 'Jane Wanjiru' }); AUTH.users.jane = { uid: 'jane', phoneNumber: '+254722376801' };
  await db.doc('loyaltyAccounts/jane').set({ uid: 'jane', balance: 1240, status: 'active' });
  const jane = await SC.saveOwned(db, A, { phone: '0722376801', name: 'Jane Wanjiru', by: A });
  await SC.saveOwned(db, A, { phone: '0722376999', name: 'John Kamau', by: A });

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
    for (const [n, fn] of [['__serverSale', serverSale], ['__lookup', serverLookup], ['__csearch', serverCSearch], ['__csave', serverCSave], ['__ccard', serverCCard]]) await P.exposeFunction(n, fn);
    await P.goto(BASE + '/sell.html');
    const ring = async () => {
      await P.evaluate(() => window.__mount()); await P.waitForSelector('.msl-card', T);
      await P.click('.msl-card', T); await P.click('[data-act="charge"]', T);
      await P.waitForFunction(() => /Amount due/.test(document.body.innerText) && !/Checking the shop/.test(document.body.innerText), null, T);
      await P.waitForSelector('#msl-cq', T);
    };
    const settle = () => P.waitForFunction(() => !/Looking…/.test((document.getElementById('msl-csug') || {}).innerText || '') && (document.getElementById('msl-csug') || {}).innerHTML !== '', null, T);

    /* CB1 */
    let cb1 = {};
    await act('partial number', async () => {
      await ring();
      await P.type('#msl-cq', '0722 37', { delay: 30 });
      await settle();
      cb1 = await P.evaluate(() => ({ rows: [...document.querySelectorAll('.msl-crow')].map((b) => b.innerText.split('\n')[0]), found: /Customer found/.test(document.body.innerText), sug: document.querySelectorAll('.msl-crow.sug').length, card: !!document.querySelector('.msl-ccard'), note: (document.getElementById('msl-csug') || {}).innerText }));
    });
    ck('CB1 a partial number offers BOTH of the shop\'s matching customers as choices — nothing suggested, nothing attached',
      cb1.rows && cb1.rows.length === 2 && !cb1.found && cb1.sug === 0 && !cb1.card && /2 matches by phone/.test(cb1.note || ''), cb1);

    /* CB2 */
    let cb2 = {};
    await act('full number, then the tap', async () => {
      await P.fill('#msl-cq', ''); await P.type('#msl-cq', '0722376801', { delay: 20 });
      await P.waitForFunction(() => /Customer found/.test(document.body.innerText), null, T);
      cb2.before = await P.evaluate(() => ({ rows: document.querySelectorAll('.msl-crow').length, sug: document.querySelectorAll('.msl-crow.sug').length, card: !!document.querySelector('.msl-ccard') }));
      await P.click('.msl-crow.sug', T);
      await P.waitForFunction(() => { const c = document.querySelector('.msl-ccard'); return c && /1,240/.test(c.innerText); }, null, T);
      await P.waitForFunction(() => /Available: 1,240 points/.test(document.body.innerText), null, T);
      cb2.card = await P.evaluate(() => document.querySelector('.msl-ccard').innerText);
      cb2.pts = await P.evaluate(() => (document.querySelector('.msl-buyer') || {}).innerText || '');
    });
    ck('CB2 the full number → "Customer found ✓", one highlighted row, NOT attached until tapped; the tap shows her card (masked, purchases, spend, last purchase, ⭐ 1,240) and finds her SOKONI points',
      cb2.before && cb2.before.rows === 1 && cb2.before.sug === 1 && !cb2.before.card && /Jane Wanjiru/.test(cb2.card || '') && /0722 ••• •801/.test(cb2.card || '')
      && /Purchases\s*0/.test(cb2.card || '') && /Last purchase\s*None yet/.test(cb2.card || '') && /SOKONI points\s*1,240/.test(cb2.card || '') && /1,240 points/.test(cb2.pts || ''), cb2);

    /* CB6 — the screen, with the card showing */
    const text = await P.evaluate(() => document.body.innerText + [...document.querySelectorAll('input')].map((i) => i.id === 'msl-cq' || i.id === 'msl-bphone' ? '' : i.value).join('|'));
    ck('CB6 the stored number never appears on the screen — every customer phone is masked', !/722376801|376 801|722376999/.test(text.replace(/0722376801/g, '')), '');

    /* CB7 at 390 */
    const lay = async () => P.evaluate(() => ({ over: document.scrollingElement.scrollWidth - window.innerWidth, card: (document.querySelector('.msl-ccard') || { getBoundingClientRect: () => ({}) }).getBoundingClientRect().width }));
    const l390 = await lay();

    /* CB3 */
    let cb3 = {};
    await act('cash sale with the customer', async () => {
      await P.click('[data-act="tender"][data-v="exact"]', T);
      await P.click('[data-act="complete"]', T);
      await P.waitForFunction(() => /Sale complete/.test(document.body.innerText), null, { timeout: 15000 });
      cb3.call = await P.evaluate(() => window.__calls.filter((c) => !c.dryRun).pop() || null);
    });
    const s3 = (await all('posRetailSales'))[0] || {};
    const j3 = await get('posCustomers/' + jane.id);
    ck('CB3 the sale carries WHICH customer; the server names her from its own record and counts the purchase',
      cb3.call && cb3.call.customer && cb3.call.customer.id === jane.id && s3.customer && s3.customer.id === jane.id && s3.customer.name === 'Jane Wanjiru'
      && j3.purchaseCount === 1 && j3.totalSpent === 1000, { sent: cb3.call && cb3.call.customer, rec: s3.customer, n: j3.purchaseCount });

    /* CB4 */
    let cb4 = {};
    await act('new customer', async () => {
      await P.click('[data-act="new-sale"]', T);
      await ring();
      await P.type('#msl-cq', '0799 123 456', { delay: 20 });
      await P.waitForSelector('#msl-cname', T);
      cb4.offer = await P.evaluate(() => document.getElementById('msl-csug').innerText);
      await P.fill('#msl-cname', 'Akinyi Otieno');
      await P.click('[data-act="cust-save"]', T);
      await P.waitForFunction(() => { const c = document.querySelector('.msl-ccard'); return c && /saved to your customers/.test(c.innerText) && !/…/.test(c.innerText); }, null, T);
      cb4.card = await P.evaluate(() => document.querySelector('.msl-ccard').innerText);
      await P.setViewportSize({ width: 1280, height: 900 }); await P.waitForTimeout(150);
      cb4.l1280 = await lay();
      cb4.rowH = null;
      await P.click('[data-act="tender"][data-v="exact"]', T);
      await P.click('[data-act="complete"]', T);
      await P.waitForFunction(() => /Sale complete/.test(document.body.innerText), null, { timeout: 15000 });
    });
    const ak = (await all('posCustomers')).find((c) => c.name === 'Akinyi Otieno');
    const s4 = (await all('posRetailSales')).find((x) => x.customer && x.customer.name === 'Akinyi Otieno');
    ck('CB4 an unknown number offers "New customer on 0799 ••• •456?" → Save: saved to THIS shop, attached, carried by the sale',
      /New customer on 0799 ••• •456\?/.test(cb4.offer || '') && ak && ak.sellerId === A && ak.phoneKey === '254799123456' && /Akinyi Otieno/.test(cb4.card || '') && /No account/.test(cb4.card || '')
      && s4 && s4.customer.id === ak.id && ak.purchaseCount === 1, { offer: cb4.offer, card: cb4.card, saved: !!ak, sale: s4 && s4.customer });

    /* CB5 + row height (back at phone width) */
    await P.setViewportSize({ width: 390, height: 900 });
    let cb5 = {};
    await act('name search', async () => {
      await P.click('[data-act="new-sale"]', T);
      await ring();
      await P.type('#msl-cq', 'Wanj', { delay: 20 });
      await settle();
      cb5 = await P.evaluate(() => ({ note: document.getElementById('msl-csug').innerText, found: /Customer found/.test(document.body.innerText), rows: [...document.querySelectorAll('.msl-crow')].map((b) => ({ t: b.innerText.split('\n')[0], h: b.getBoundingClientRect().height })) }));
    });
    ck('CB5 a name search lists the match "by name — choose one", never a found badge', cb5.rows && cb5.rows.length === 1 && cb5.rows[0].t === 'Jane Wanjiru' && /1 match by name — choose one/.test(cb5.note || '') && !cb5.found, cb5);

    ck('CB7 laid out for every device: no sideways scroll at 390px or 1280px with the customer card showing; rows are ≥44px tap targets',
      l390.over <= 0 && l390.card > 0 && cb4.l1280 && cb4.l1280.over <= 0 && cb5.rows && cb5.rows.every((r) => r.h >= 44), { l390, l1280: cb4.l1280, rows: cb5.rows });

    ck('CB8 no page errors', errors.length === 0, errors.slice(0, 3));
  } finally { await browser.close().catch(() => {}); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
