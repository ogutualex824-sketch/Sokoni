/* test-points-p2b-poscheckout-browser.js — SOKONI Points P2b (2026-09-29): PAY WITH POINTS on pos-checkout.html (real Chromium),
 * wired to the REAL tillBuyerLookup / tillPointsStart / tillPointsConfirm, shopOfferQuote and posCompleteCheckout over the
 * fake Firestore. window.firebase is a stub that only signs in the shop owner and routes callables; externals are blocked.
 *
 * PROVES
 *   PC1 the legacy shop-balance Redeem button is retired; the buyer shows Available / Value from the server; the code
 *       goes to the customer
 *   PC2 mixed payment: 1,000 points (KES 100) + the rest in cash; grandTotal is the full sale; spent once, shop-funded
 *   PC3 no page error from the points code
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-points-p2b-pc';
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
const ROUTES = {
  posCompleteCheckout: (p) => ZF.posCompleteCheckout({ data: p, auth: { uid: A, token: { posRole: 'cashier' } } }),
  tillBuyerLookup: (p) => LP.lookup(db, { uid: A, data: p }),
  tillPointsStart: (p) => PS.tillStart(db, { uid: A, data: p }),
  tillPointsConfirm: (p) => PS.tillConfirm(db, { uid: A, data: p }),
  tillPointsCancel: (p) => PS.tillCancel(db, { uid: A, data: p }),
  shopOfferQuote: (p) => SO.quoteForCaller(db, { uid: A, data: p }),
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
    firestore: function () { throw new Error('firestore not available in this test'); },
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
  if (typeof ZF.posCompleteCheckout !== 'function' || typeof PS.tillStart !== 'function') { ck('PC0 the till and pay-with-points load', false, ZF.__err || PS.__err || 'tillStart missing'); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
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
    await P.goto(BASE + '/pos-checkout.html', { waitUntil: 'domcontentloaded' });
    await P.waitForFunction(() => typeof Checkout !== 'undefined' && typeof Checkout.pointsPayStart === 'function', null, T);
    await P.waitForTimeout(1200);   /* init: settings, auth callback */

    let legacyHidden = null, shown = '', note = '', held = '', cashBtn = '', saleCall = null, sale = null;
    await act('ring a stove, find the buyer, pay part with points, the rest cash', async () => {
      legacyHidden = await P.$eval('#redeem-btn', (b) => getComputedStyle(b).display === 'none');
      await P.evaluate(() => Checkout.addItem({ id: 'stove', name: 'Stove', price: 1000 }));
      await P.fill('#skp-phone', '0712 345 678');
      await P.evaluate(() => Checkout.pointsLookup());
      await P.waitForFunction(() => /Available/.test((document.getElementById('skp-status') || {}).textContent || ''), null, T);
      shown = await P.$eval('#skp-status', (e) => e.textContent);
      await P.waitForFunction(() => document.getElementById('skp-pay').style.display !== 'none', null, T);
      await P.evaluate(() => Checkout.pointsPayStart());
      await P.waitForFunction(() => document.getElementById('skp-code-row').style.display !== 'none', null, T);
      note = await P.$eval('#skp-code-note', (e) => e.textContent);
      await P.fill('#skp-code', await lastCode());
      await P.evaluate(() => Checkout.pointsPayConfirm());
      await P.waitForFunction(() => document.getElementById('skp-held').style.display !== 'none', null, T);
      held = await P.$eval('#skp-held', (e) => e.textContent);
      cashBtn = await P.$eval('#total-cash', (e) => e.textContent);
      await P.evaluate(() => Checkout.pay('cash'));
      await P.waitForTimeout(400);
      await P.evaluate(() => { Checkout.cashExact && Checkout.cashExact(); });
      await P.evaluate(() => Checkout.confirmCash());
      await P.waitForFunction(() => true, null, T);
      for (let i = 0; i < 40 && !(await all('posRetailSales')).length; i++) await P.waitForTimeout(250);
    });
    saleCall = (CALLS.filter((c) => c.name === 'posCompleteCheckout').pop() || {}).payload || null;
    sale = (await all('posRetailSales'))[0] || null;
    const acc = await get('loyaltyAccounts/jane');
    ck('PC1 pos-checkout: the legacy shop-balance Redeem is retired; the buyer shows Available / Value from the server; the code goes to the customer',
      legacyHidden === true && /Available: 1,000 points/.test(shown) && /Value: KES 100\.00/.test(shown) && /texted to ••••678/.test(note) && /1,000 points = KES 100\.00/.test(note),
      { legacyHidden, shown, note });
    ck('PC2 mixed payment at pos-checkout: 1,000 points (KES 100) + the rest in cash; the sale total is the full sale; the points are spent once, funded by the shop',
      /paid with points/.test(held) && saleCall && saleCall.payments[0].method === 'points' && saleCall.payments[0].amount === 100
      && saleCall.payments[1].method === 'cash' && Math.abs(saleCall.payments[1].amount - (saleCall.grandTotal - 100)) < 0.01 && /KES/.test(cashBtn)
      && sale && sale.pointsRedeemed && sale.pointsRedeemed.kes === 100 && sale.pointsRedeemed.fundingShopId === A && acc.heldPoints === 0 && acc.totalRedeemed === 1000,
      { held, cashBtn, pays: saleCall && saleCall.payments, grand: saleCall && saleCall.grandTotal, sale: sale && sale.pointsRedeemed, acc: [acc.balance, acc.heldPoints, acc.totalRedeemed] });
    const pe = errors.filter((m) => /points|pointsPay|skp-|_pointsPayUI|pointsHold|saleKey/i.test(m));
    ck('PC3 no page error from the points code', pe.length === 0, { pointsErrors: pe.slice(0, 3), other: errors.length });
    await ctx.close();
  } finally { await browser.close().catch(() => {}); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
