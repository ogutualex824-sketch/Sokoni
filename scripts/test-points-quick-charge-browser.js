/* test-points-quick-charge-browser.js — Quick Charge × SOKONI points in real Chromium (2026-09-29).
 * The REAL Quick Charge module (sokoni-merchant-till.js) wired to the REAL lookup, the REAL till redemption authority
 * (tillPointsStart / Confirm / Cancel) and the REAL Quick Charge pricer (payment-purposes pos_till_sale). The code is
 * read out of the QUEUED text, as the customer would read it out.
 *
 * PROVES
 *   QB1 buyer found → "Pay part with points" → the code goes to the customer → Confirm holds 1,000 points (KES 100)
 *   QB2 the QR asks for KES 900 — the SERVER's figure — and the page says KES 100.00 was paid with points; the intent
 *       carries only the confirmation + the charge's sale id (no points figure)
 *   QB3 changing the amount before the QR gives the held points back
 *   QB4 no page errors
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-points-qc-browser';
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
let PP, PS; try { PP = require(Path.join(FN, 'payment-purposes.js')); PS = require(Path.join(FN, 'loyalty-points-spend.js')); } catch (e) { PP = PP || { __err: e.message }; PS = PS || { __err: e.message }; }
let LP, QA; try { LP = require(Path.join(FN, 'loyalty-points.js')); QA = require(Path.join(FN, 'sokoni-qr-authority.js')); } catch (e) { LP = LP || { __err: e.message }; QA = QA || { __err: e.message }; }
const A = 'shopA';
const TILL = { exists: true, sokoniTillId: 'T1', shopId: A, branchId: 'main', merchantUid: A, status: 'ACTIVE', currency: 'KES' };
const INTENTS = [];
const wrap = (fn) => async (payload) => { try { return { data: await fn(payload) }; } catch (e) { return { err: e.message, code: e.code }; } };
const serverLookup = wrap((p) => LP.lookup(db, { uid: 'cash1', data: p }));
const serverCreate = wrap((p) => LP.createBuyer(db, { uid: 'cash1', data: p }));
/* createPaymentIntent's pos_till_sale branch prices with priceTillSale — the metadata it stores is what the webhook reads */
const serverIntent = wrap(async (p) => { const pr = await PP.PURPOSES.pos_till_sale.price(A, p); const ref = pr.preferredRef || ('I' + (INTENTS.length + 1)); INTENTS.push({ ref, amount: pr.amountCents / 100, metadata: pr.metadata, sent: p }); return { ref, amount: pr.amountCents / 100 }; });
const serverMint = wrap(async (p) => { const it = INTENTS.find((x) => x.ref === p.ref); return { qrUrl: 'https://mysokoni.co.ke/pay-q?r=' + p.ref, amount: it ? it.amount : null, currency: 'KES' }; });
const pStart = wrap((p) => PS.tillStart(db, { uid: 'cash1', data: p }));
const pConfirm = wrap((p) => PS.tillConfirm(db, { uid: 'cash1', data: p }));
const pCancel = wrap((p) => PS.tillCancel(db, { uid: 'cash1', data: p }));

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
      callCreateIntent: via(window.__serverIntent), callMintDynamicQR: via(window.__mint),
      callBuyerLookup: via(window.__serverLookup), callCreateBuyer: via(window.__serverCreate),
      callPointsStart: via(window.__pStart), callPointsConfirm: via(window.__pConfirm), callPointsCancel: via(window.__pCancel) });
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


const all = async (c) => (await db.collection(c).get()).docs.map((d) => Object.assign({ id: d.id }, d.data()));
const lastCode = async () => { const q = (await all('smsQueue')).concat(await all('sms_queue')).concat(await all('smsOutbox')).filter((m) => m.template === 'points_redeem_code');
  const m = q[q.length - 1]; const x = m && /Code (\d{6})/.exec(m.body || m.text || ''); return x ? x[1] : null; };
(async () => {
  if (!PP.PURPOSES || typeof PS.tillStart !== 'function' || typeof PS.validateQuickChargeRedemption !== 'function') { ck('QB0 Quick Charge pricer + till redemption load', false, PP.__err || PS.__err || 'validateQuickChargeRedemption missing'); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  await db.doc('users/jane').set({ phoneNumber: '+254712345678', displayName: 'Jane Wanjiru' });
  AUTH.users.jane = { uid: 'jane', phoneNumber: '+254712345678' };
  await db.doc('loyaltyAccounts/jane').set({ uid: 'jane', balance: 1000, status: 'active' });
  await db.doc('shops/' + A).set({ name: 'Mama Duka' });
  await db.doc('sokoniTills/T1').set(TILL);
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
    for (const [n, f] of [['__serverLookup', serverLookup], ['__serverCreate', serverCreate], ['__serverIntent', serverIntent], ['__mint', serverMint], ['__pStart', pStart], ['__pConfirm', pConfirm], ['__pCancel', pCancel]]) await P.exposeFunction(n, f);
    await P.goto(BASE + '/till.html');
    const open = async () => { await P.evaluate(() => window.__mount()); await P.waitForSelector('[data-act="gen-dynamic"]', T); };
    const txt = (sel) => P.$eval(sel, (e) => e.textContent);

    /* QB1 + QB2 */
    let note = '', heldMsg = '', qrMsg = '', it = null;
    await act('Quick Charge 1,000 with 1,000 points', async () => {
      await open(); await P.fill('[data-f="amount"]', '1000'); await P.fill('[data-f="buyerPhone"]', '0712 345 678');
      await P.click('[data-act="buyer-check"]', T);
      await P.waitForFunction(() => { const p = document.querySelector('[data-el="pts"]'); return p && !p.hidden; }, null, T);
      await P.click('[data-act="pts-start"]', T);
      await P.waitForFunction(() => /Code texted/.test((document.querySelector('[data-f="ptsMsg"]') || {}).textContent || ''), null, T);
      note = await txt('[data-f="ptsMsg"]');
      await P.fill('[data-f="ptsCode"]', await lastCode()); await P.click('[data-act="pts-confirm"]', T);
      await P.waitForFunction(() => /paid with points/.test((document.querySelector('[data-f="ptsMsg"]') || {}).textContent || ''), null, T);
      heldMsg = await txt('[data-f="ptsMsg"]');
      await P.click('[data-act="gen-dynamic"]', T);
      await P.waitForFunction(() => /QR ready/.test((document.querySelector('[data-el="dynamic-msg"]') || {}).textContent || ''), null, T);
      qrMsg = await txt('[data-el="dynamic-msg"]');
      it = INTENTS[INTENTS.length - 1];
    });
    const acc = await get('loyaltyAccounts/jane');
    ck('QB1 the customer gets the code (the screen never shows it); Confirm holds 1,000 points = KES 100.00',
      /Code texted to ••••678: 1,000 points = KES 100\.00/.test(note) && /1,000 points = KES 100\.00 paid with points/.test(heldMsg) && acc.balance === 0 && acc.heldPoints === 1000,
      { note, heldMsg, bal: acc.balance, held: acc.heldPoints });
    ck('QB2 the QR asks for KES 900 — the server\'s figure — and says KES 100.00 was paid with points; the page sent only the confirmation and the charge id',
      /KES 900/.test(qrMsg) && /KES 100\.00 already paid with SOKONI points/.test(qrMsg) && it && it.amount === 900 && it.sent.pointsRedemptionId && /^qc/.test(it.sent.saleId || '')
      && it.sent.pointsDiscount === undefined && it.sent.points === undefined && it.metadata.pointsDiscount === 100,
      { qrMsg, amount: it && it.amount, sent: it && it.sent });

    /* QB3 */
    await db.doc('loyaltyAccounts/jane').set({ balance: 1000, heldPoints: 0 }, { merge: true });
    let bal3 = null;
    await act('confirm, then change the amount before the QR', async () => {
      await open(); await P.fill('[data-f="amount"]', '1000'); await P.fill('[data-f="buyerPhone"]', '0712 345 678');
      await P.click('[data-act="buyer-check"]', T);
      await P.waitForFunction(() => { const p = document.querySelector('[data-el="pts"]'); return p && !p.hidden; }, null, T);
      await P.click('[data-act="pts-start"]', T);
      await P.waitForFunction(() => /Code texted/.test((document.querySelector('[data-f="ptsMsg"]') || {}).textContent || ''), null, T);
      await P.fill('[data-f="ptsCode"]', await lastCode()); await P.click('[data-act="pts-confirm"]', T);
      await P.waitForFunction(() => /paid with points/.test((document.querySelector('[data-f="ptsMsg"]') || {}).textContent || ''), null, T);
      await P.fill('[data-f="amount"]', '1200');
      for (let i = 0; i < 20; i++) { bal3 = (await get('loyaltyAccounts/jane')).balance; if (bal3 === 1000) break; await P.waitForTimeout(150); }
    });
    ck('QB3 changing the amount before the QR gives the held points back (1,000 again)', bal3 === 1000, { bal3 });

    ck('QB4 no page errors', errors.length === 0, errors.slice(0, 3));
  } finally { await browser.close().catch(() => {}); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
