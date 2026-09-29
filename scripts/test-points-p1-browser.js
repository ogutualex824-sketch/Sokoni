/* test-points-p1-browser.js — SOKONI Points P1 (2026-09-29): the till IDENTIFIES the buyer, the server CREDITS them.
 * The REAL merchant-v2 Sell screen (Chromium) wired through page.exposeFunction to the REAL tillBuyerLookup /
 * tillCreateBuyer (functions/loyalty-points.js) and the REAL posCompleteCheckout (Node, fake Firestore). Firebase Auth
 * is stubbed (no real account), SMS goes to the queue only (nothing is sent).
 *
 *   Soap KES 1,250 → 125 points
 *
 * PROVES
 *   PB1 a known buyer: the cashier types the phone, Look up shows ONLY a masked name/phone and the balance; the sale
 *       completes, the done screen says 125 points credited and the ledger holds 125 from the sale's own total; the
 *       sale payload carried the PHONE and no points figure
 *   PB2 an unknown number: Create is disabled until the consent box is ticked; after it, the account exists (unclaimed,
 *       created at the till), the welcome text is QUEUED, the screen shows a masked identity — and the sale credits it
 *   PB3 no phone typed: the sale completes as before, with no points line and no buyerPhone (control)
 *   PB4 a phone typed but never looked up is NOT sent — only a buyer the server has identified is credited
 *   PB5 no horizontal overflow at 390 px; no page errors
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-points-browser';
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
async function reset() {
  for (const c of ['posRetailSales', 'posReceipts', 'posIdempotency', 'posTransactions', 'loyaltyLedger']) for (const d of (await db.collection(c).get()).docs) await d.ref.delete();
  await db.doc('products/soap').set({ name: 'Soap', price: 1250, stock: 50, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  await db.doc('shops/' + A).set({ name: 'Mama Duka', sellerUid: A }); await db.doc('users/' + A).set({ displayName: 'Owner A' });
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{--txt:#f4f4f4;--txt2:#a8a8a8;--txt3:#6d6d6d;--acc:#71ff00;--line:rgba(255,255,255,.09);--panel:#0d0d0d;--card:#141414}body{margin:0;background:#050505;color:#f4f4f4;font:14px system-ui}#native-sell{height:100vh}</style></head>
<body><div id="native-sell"></div>
<script src="/sokoni-merchant-data.js"></script><script src="/sokoni-merchant-stock.js"></script><script src="/sokoni-merchant-sell.js"></script>
<script>
  window.__calls = [];
  var CATALOGUE = [{ id: 'soap', name: 'Soap', price: 1250, stock: 50, shopId: 'shopA', status: 'active' }];
  var db = { queryProducts: function () { return Promise.resolve(CATALOGUE.map(function (p) { return Object.assign({}, p); })); }, queryMovements: function () { return Promise.resolve([]); } };
  function via(fn, tag) { return function (payload) { if (tag) window.__calls.push(JSON.parse(JSON.stringify(payload)));
    return fn(payload).then(function (r) { if (r.err) { var e = new Error(r.err); e.code = r.code; throw e; } return { data: r.data }; }); }; }
  window.__mount = function () {
    if (window.__sell) { try { window.__sell.destroy(); } catch (e) {} }
    var h = document.getElementById('native-sell'); h.innerHTML = ''; window.__calls = [];
    window.__sell = SokoniMerchantSell.mount(h, { scope: SokoniMerchantData.resolveScope({ uid: 'shopA', activeShopId: 'shopA' }), db: db, shopName: 'Mama Duka',
      callSale: via(window.__serverSale, true), callAdjust: function () { return Promise.reject(new Error('no')); }, onToast: function () {},
      callBuyerLookup: via(window.__serverLookup), callCreateBuyer: via(window.__serverCreate) });
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

(async () => {
  if (typeof ZF.posCompleteCheckout !== 'function' || typeof LP.lookup !== 'function') { ck('PB0 the till and the points module load', false, ZF.__err || LP.__err); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  await db.doc('users/jane').set({ phoneNumber: '+254712345678', displayName: 'Jane Wanjiru' });
  AUTH.users.jane = { uid: 'jane', phoneNumber: '+254712345678' };
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
    await P.exposeFunction('__serverLookup', serverLookup);
    await P.exposeFunction('__serverCreate', serverCreate);
    await P.goto(BASE + '/sell.html');
    const ring = async () => {
      await P.evaluate(() => window.__mount()); await P.waitForSelector('.msl-card', T);
      await P.click('.msl-card', T); await P.click('[data-act="charge"]', T);
      await P.waitForFunction(() => /Amount due/.test(document.body.innerText) && !/Checking the shop/.test(document.body.innerText), null, T);
    };
    const completeCash = async () => { await P.click('[data-act="tender"][data-v="exact"]', T); await P.click('[data-act="complete"]', T); await P.waitForFunction(() => /Sale complete/.test(document.body.innerText), null, T); };
    const text = () => P.evaluate(() => document.body.innerText);
    const lastSale = () => P.evaluate(() => window.__calls.filter((c) => !c.dryRun).pop() || null);

    /* PB1 — a known buyer */
    await reset();
    const bal0 = ((await get('loyaltyAccounts/jane')) || {}).balance || 0;
    let shown = '', done = '';
    await act('look up a known buyer and sell', async () => {
      await ring(); await P.fill('#msl-bphone', '0712 345 678'); await P.click('[data-act="buyer-look"]', T);
      await P.waitForFunction(() => /points/.test((document.querySelector('.msl-buyer') || {}).innerText || ''), null, T);
      shown = await P.evaluate(() => document.querySelector('.msl-buyer').innerText);
      await completeCash(); done = await text();
    });
    const s1 = await lastSale(); const led1 = (await all('loyaltyLedger')).filter((l) => l.type !== 'welcome');
    const bal1 = ((await get('loyaltyAccounts/jane')) || {}).balance || 0;
    ck('PB1 a known buyer: only a masked identity is shown; the sale credits 125 points from its own total; the payload carried a phone, no points figure',
      /J\. W\./.test(shown) && /••••678/.test(shown) && !/712345678|Wanjiru/.test(shown) && /125 SOKONI points credited/.test(done)
      && s1 && s1.buyerPhone === '0712 345 678' && !('pointsEarned' in s1) && !('points' in s1)
      && led1.length === 1 && led1[0].points === 125 && led1[0].issuerShopId === A && bal1 - (bal0 || 0) === 125 + (bal0 ? 0 : 125),
      { shown: shown.slice(0, 80), done: /points credited/.test(done), phone: s1 && s1.buyerPhone, led: led1.map((l) => l.points), bal0, bal1 });

    /* PB2 — an unknown number, created with consent */
    await reset();
    let disabledBefore = null, disabledAfter = null, shown2 = '', done2 = '';
    await act('create an account for an unknown number and sell', async () => {
      await ring(); await P.fill('#msl-bphone', '0799000111'); await P.click('[data-act="buyer-look"]', T);
      await P.waitForSelector('[data-act="buyer-create"]', T);
      disabledBefore = await P.$eval('[data-act="buyer-create"]', (b) => b.disabled);
      await P.fill('#msl-bname', 'Otieno Brian'); await P.check('#msl-bconsent');
      await P.waitForFunction(() => { const b = document.querySelector('[data-act="buyer-create"]'); return b && !b.disabled; }, null, T);
      disabledAfter = await P.$eval('[data-act="buyer-create"]', (b) => b.disabled);
      await P.click('[data-act="buyer-create"]', T);
      await P.waitForFunction(() => /account created/.test((document.querySelector('.msl-buyer') || {}).innerText || ''), null, T);
      shown2 = await P.evaluate(() => document.querySelector('.msl-buyer').innerText);
      await completeCash(); done2 = await text();
    });
    const nu = await get('users/u_0111'), na = await get('loyaltyAccounts/u_0111');
    const sms = (await all('smsQueue')).concat(await all('sms_queue')).concat(await all('smsOutbox'));
    ck('PB2 an unknown number: Create waits for consent; the account is created unclaimed at the till, the welcome text is queued, and the sale credits it',
      disabledBefore === true && disabledAfter === false && /O\. B\./.test(shown2) && /••••111/.test(shown2) && !/0799000111|Otieno/.test(shown2)
      && nu && nu.createdVia === 'till' && nu.claimed === false && na && na.balance === 125 + 125
      && sms.some((m) => m.template === 'till_welcome' && m.to === '+254799000111') && /125 SOKONI points credited/.test(done2),
      { disabledBefore, disabledAfter, shown2: shown2.slice(0, 80), claimed: nu && nu.claimed, bal: na && na.balance, sms: sms.map((m) => m.template) });

    /* PB3 — control */
    await reset();
    let done3 = '';
    await act('sell with no phone', async () => { await ring(); await completeCash(); done3 = await text(); });
    const s3 = await lastSale();
    ck('PB3 no phone: the sale completes as before, no points line, no buyerPhone',
      s3 && !s3.buyerPhone && !/points credited|No points this time/.test(done3) && (await all('posRetailSales')).length === 1 && (await all('loyaltyLedger')).length === 0,
      { phone: s3 && s3.buyerPhone });

    /* PB4 — typed, never looked up */
    await reset();
    await act('type a phone but never look it up', async () => { await ring(); await P.fill('#msl-bphone', '0712345678'); await completeCash(); });
    const s4 = await lastSale();
    ck('PB4 a phone typed but not looked up is not sent; nobody is credited', s4 && !s4.buyerPhone && (await all('loyaltyLedger')).length === 0, { phone: s4 && s4.buyerPhone });

    const over = await P.evaluate(() => document.documentElement.scrollWidth - window.innerWidth <= 1).catch(() => false);
    ck('PB5 no horizontal overflow at 390 px; no page errors', over && errors.length === 0, { over, errors: errors.slice(0, 3) });
  } finally { await browser.close().catch(() => {}); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
