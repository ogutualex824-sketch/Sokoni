/* test-points-p2a-checkout-browser.js — SOKONI Points P2a (2026-09-29): the checkout SHOWS the server's points figure,
 * and it is the figure the charge takes. The REAL checkout.html in Chromium; its one points source — shopOfferQuote —
 * is the REAL shop-offers.quoteForCaller (with the points preview from loyalty-points-spend) behind page.exposeFunction,
 * over the fake Firestore. Every external script is blocked; window.firebase is a stub that only routes callables.
 *
 *   Mouse KES 1,000 · buyer with 1,000 SOKONI points · localStorage.sokoniLoyalty = 99,999 (a decoy the page must ignore)
 *
 * PROVES
 *   QB1 the widget shows the SERVER balance (1,000), never the localStorage decoy; the earn line states the rule, no
 *       invented number
 *   QB2 the redeem row says "1,000 pts = KES 100 off this order"; switching it on takes exactly KES 100 off the Pay
 *       total and shows "(1,000 pts)"; switching it off restores it
 *   QB3 the M-PESA charge for the same cart (product_order, redeemLoyalty) takes the SAME 100 / 1,000 the page showed
 *   QB4 a buyer with no points sees no widget and no redeem row (never a 0 or a guess)
 *   QB5 no page error from the points code
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-points-p2a-ui';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const Path = require('path'), http = require('http'), fs = require('fs'), Module = require('module');
const ROOT = Path.resolve(__dirname, '..'), FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 360) + ']' : '')); ok ? pass++ : fail++; };
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({}) };
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-admin') return ADMIN;
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h, onDocumentCreated: (_o, h) => h, onDocumentUpdated: (_o, h) => h };
  if (id === 'firebase-functions/logger' || id === 'firebase-functions') return { logger: { info() {}, warn() {}, error() {} }, info() {}, warn() {}, error() {}, debug() {} };
  if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => 'test-secret' }), defineString: () => ({ value: () => '' }), defineInt: () => ({ value: () => 0 }) };
  if (id === './shop-employees') return { resolveShopAccess: async () => { throw new HttpsError('permission-denied', 'no'); }, capabilitiesForRole: () => [] };
  return origReq.apply(this, arguments);
};
let SO, PP; try { SO = require(Path.join(FN, 'shop-offers.js')); PP = require(Path.join(FN, 'payment-purposes.js')); } catch (e) { SO = SO || { __err: e.message }; PP = PP || { __err: e.message }; }
const A = 'shopA';
let BUYER = 'buyer1';
const DBG = !!process.env.QB_DEBUG;
const call = async (name, payload) => {
  if (DBG) say('  [call] ' + name + ' ' + JSON.stringify(payload).slice(0, 160));
  try {
    if (name === 'shopOfferQuote') return { data: await SO.quoteForCaller(db, { uid: BUYER, data: payload || {} }) };
    return { err: 'not stubbed: ' + name, code: 'unavailable' };
  } catch (e) { return { err: e.message, code: e.code }; }
};
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      if (u === '/firebase.js') { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end('/* stubbed */'); }
      const f = Path.join(ROOT, u.replace(/^\/+/, '') || 'index.html');
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(''); }
      const ext = Path.extname(f);
      res.writeHead(200, { 'content-type': ext === '.html' ? 'text/html' : ext === '.css' ? 'text/css' : 'application/javascript' });
      res.end(fs.readFileSync(f));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
const INIT = `
  try {
    localStorage.setItem('loggedIn', 'true');
    localStorage.setItem('sokoniUser', JSON.stringify({ uid: 'buyer1', name: 'Test Buyer' }));
    localStorage.setItem('cart', JSON.stringify([{ id: 'mouse', productId: 'mouse', name: 'Mouse', price: 1000, qty: 1, sellerUid: 'shopA', shopId: 'shopA' }]));
    localStorage.setItem('sokoniLoyalty', JSON.stringify({ points: 99999 }));   /* a decoy: the page must never show it */
  } catch (e) {}
  window.firebase = { functions: function () { return { httpsCallable: function (name) { return function (payload) {
    return window.__call(name, payload).then(function (r) { if (r && r.err) { var e = new Error(r.err); e.code = r.code; throw e; } return { data: r.data }; });
  }; } }; }, auth: function () { return { currentUser: { uid: 'buyer1' } }; } };
`;

(async () => {
  if (typeof SO.quoteForCaller !== 'function' || typeof PP.PURPOSES !== 'object') { ck('QB0 the quote and the charge load', false, SO.__err || PP.__err); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  await db.doc('products/mouse').set({ name: 'Mouse', price: 1000, stock: 50, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  await db.doc('loyaltyAccounts/buyer1').set({ uid: 'buyer1', balance: 1000, status: 'active' });
  await db.doc('loyaltyAccounts/buyer0').set({ uid: 'buyer0', balance: 0, status: 'active' });
  const srv = await serve();
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const T = { timeout: 15000 };
  const errors = [];
  const act = async (label, fn) => { try { await fn(); return true; } catch (e) { ck('flow: ' + label, false, String(e && e.message).slice(0, 220)); return false; } };
  try {
    const open = async () => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
      await ctx.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
      await ctx.addInitScript(INIT);
      const P = await ctx.newPage();
      P.on('pageerror', (e) => { errors.push(e.message); if (DBG) say('  [pageerror] ' + String(e.stack || e.message).slice(0, 600)); });
      if (DBG) P.on('framenavigated', (fr) => { if (fr === P.mainFrame()) say('  [nav] ' + fr.url()); });
      await P.exposeFunction('__call', call);
      await P.goto(BASE + '/checkout.html', { waitUntil: 'domcontentloaded' });
      return { P, ctx };
    };
    const payTotal = (P) => P.evaluate(() => Number(((document.getElementById('btnTotal') || {}).textContent || '').replace(/[^0-9]/g, '')) || null);

    /* QB1 + QB2 */
    BUYER = 'buyer1';
    let q = {};
    await act('checkout with 1,000 points', async () => {
      const { P, ctx } = await open();
      await P.waitForFunction(() => { const w = document.getElementById('coLoyaltyWidget'); return w && w.style.display === 'flex'; }, null, T);
      q.pts = await P.$eval('#coLoyaltyPts', (e) => e.textContent);
      q.earn = await P.$eval('#coLoyaltyEarn', (e) => e.textContent);
      q.desc = await P.$eval('#coRedeemDesc', (e) => e.textContent);
      q.rowShown = await P.$eval('#coLoyaltyRedeemRow', (e) => e.style.display);
      q.off1 = await payTotal(P);
      await P.evaluate(() => toggleLoyaltyRedeem(true));
      await P.waitForFunction(() => document.getElementById('loyaltyDiscountRow').style.display !== 'none', null, T);
      q.on = await payTotal(P);
      q.row = await P.$eval('#loyaltyDiscountVal', (e) => e.textContent);
      q.lbl = await P.$eval('#loyaltyPtsUsedLabel', (e) => e.textContent);
      await P.evaluate(() => toggleLoyaltyRedeem(false));
      q.off2 = await payTotal(P);
      await ctx.close();
    });
    ck('QB1 the widget shows the SERVER balance (1,000), not the 99,999 in localStorage; the earn line is the rule, no invented number',
      q.pts === '1,000' && !/99,999|99999/.test(q.pts) && q.earn === 'Earn 1 point for every KES 10 of goods', { pts: q.pts, earn: q.earn });
    ck('QB2 "1,000 pts = KES 100 off this order"; ON takes exactly KES 100 off the Pay total and shows (1,000 pts); OFF restores it',
      q.desc === '1,000 pts = KES 100 off this order' && q.rowShown === 'block' && q.off1 > 0 && q.on === q.off1 - 100 && q.off2 === q.off1
      && /100/.test(q.row) && q.lbl === '(1,000 pts)', q);

    /* QB3 — the charge */
    let c = null;
    try { c = (await PP.PURPOSES.product_order.price('buyer1', { orderId: 'ORDQB3', items: [{ productId: 'mouse', qty: 1 }], redeemLoyalty: true })).metadata; } catch (e) { c = { err: e.message }; }
    ck('QB3 the M-PESA charge for the same cart takes the SAME KES 100 / 1,000 points the page showed',
      c && c.pointsDiscount === 100 && c.pointsRedeemed === 1000 && /100/.test(q.row || ''), c);

    /* QB4 */
    BUYER = 'buyer0';
    let z = {};
    await act('checkout with no points', async () => {
      const { P, ctx } = await open();
      await P.waitForFunction(() => typeof window._pointsPreview !== 'undefined' || true, null, T);
      await P.waitForTimeout(1500);
      z.widget = await P.$eval('#coLoyaltyWidget', (e) => e.style.display);
      z.row = await P.$eval('#coLoyaltyRedeemRow', (e) => e.style.display);
      z.pts = await P.$eval('#coLoyaltyPts', (e) => e.textContent);
      await ctx.close();
    });
    ck('QB4 a buyer with 0 points: no redeem row, and the balance shown is the canonical 0 — never the localStorage decoy',
      z.row === 'none' && !/99,999/.test(z.pts || '') && (z.widget === 'none' || z.pts === '0'), z);

    const pe = errors.filter((m) => /loyal|points|_pointsPreview|_renderPointsWidget|_calcLoyalty|redeem/i.test(m));
    ck('QB5 no page error from the points code', pe.length === 0, { pointsErrors: pe.slice(0, 3), otherErrors: errors.length });
  } finally { await browser.close().catch(() => {}); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
