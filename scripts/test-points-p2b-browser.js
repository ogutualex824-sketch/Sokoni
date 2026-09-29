/* test-points-p2b-browser.js — SOKONI Points P2b (2026-09-29): PAY WITH POINTS on the merchant-v2 Sell screen (real Chromium),
 * wired to the REAL tillPointsStart / tillPointsConfirm / tillPointsCancel (functions/loyalty-points-spend.js) and the REAL
 * posCompleteCheckout over the fake Firestore. The code is read out of the QUEUED text, as the buyer would read it out.
 *
 *   Stove KES 1,000 · Jane with 1,000 SOKONI points
 *
 * PROVES
 *   PW1 the till shows the server's figures (Available / Value); the code goes to the customer, never the screen; a wrong
 *       code counts down; Complete waits while a code is pending
 *   PW2 mixed payment: 1,000 points (KES 100) + KES 900 cash; the receipt shows both; the ledger funds it from the shop
 *   PW3 Remove gives the held points back
 *   PW4 going back to the cart releases them (the confirmation is bound to this exact cart)
 *   PW5 no horizontal overflow at 390 px; no page errors
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-points-p2b-browser';
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
async function reset(balance) {
  for (const c of ['posRetailSales', 'posReceipts', 'posIdempotency', 'posTransactions', 'loyaltyLedger', 'pointsHolds', 'tillRedemptions', 'tillRedeemCodes', 'smsQueue', 'sms_queue', 'smsOutbox']) for (const d of (await db.collection(c).get()).docs) await d.ref.delete();
  await db.doc('products/stove').set({ name: 'Stove', price: 1000, stock: 50, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  await db.doc('shops/' + A).set({ name: 'Mama Duka', sellerUid: A }); await db.doc('users/' + A).set({ displayName: 'Owner A' });
  await db.doc('loyaltyAccounts/jane').set({ uid: 'jane', loyaltyId: 'SKN-J', balance: balance == null ? 1000 : balance, status: 'active' });
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
      callBuyerLookup: via(window.__serverLookup), callCreateBuyer: via(window.__serverCreate),
      callPointsStart: via(window.__pStart), callPointsConfirm: via(window.__pConfirm), callPointsCancel: via(window.__pCancel) });
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
  if (typeof ZF.posCompleteCheckout !== 'function' || typeof PS.tillStart !== 'function') { ck('PW0 the till and pay-with-points load', false, ZF.__err || PS.__err || 'tillStart missing'); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
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
    for (const [n, fn] of [['__serverSale', serverSale], ['__serverLookup', serverLookup], ['__serverCreate', serverCreate], ['__pStart', serverPStart], ['__pConfirm', serverPConfirm], ['__pCancel', serverPCancel]]) await P.exposeFunction(n, fn);
    await P.goto(BASE + '/sell.html');
    const due = () => P.evaluate(() => { const m = /Amount due\s*KES ([\d,]+)/.exec(document.body.innerText); return m ? Number(m[1].replace(/,/g, '')) : null; });
    const ringAndFind = async () => {
      await P.evaluate(() => window.__mount()); await P.waitForSelector('.msl-card', T);
      await P.click('.msl-card', T); await P.click('[data-act="charge"]', T);
      await P.waitForFunction(() => /Amount due/.test(document.body.innerText) && !/Checking the shop/.test(document.body.innerText), null, T);
      await P.fill('#msl-bphone', '0712 345 678'); await P.click('[data-act="buyer-look"]', T);
      await P.waitForFunction(() => /Available/.test((document.querySelector('.msl-buyer') || {}).innerText || ''), null, T);
    };
    const startPoints = async () => { await P.click('[data-act="pts-start"]', T); await P.waitForSelector('#msl-pcode', T); };
    const typeCode = async (c) => { await P.fill('#msl-pcode', c); await P.click('[data-act="pts-confirm"]', T); };

    /* PW1 + PW2 */
    await reset();
    let shown = '', codeNote = '', due0 = null, due1 = null, wrongMsg = '', disabledWhilePending = null, done = '', held = '';
    await act('pay 1,000 points toward a KES 1,000 sale', async () => {
      await ringAndFind(); shown = await P.evaluate(() => document.querySelector('.msl-buyer').innerText);
      due0 = await due();
      await startPoints(); codeNote = await P.evaluate(() => (document.querySelector('.msl-pts') || {}).innerText || '');
      disabledWhilePending = await P.$eval('[data-act="complete"]', (b) => b.disabled);
      await typeCode('000000'); await P.waitForFunction(() => /Wrong code/.test(document.body.innerText), null, T);
      wrongMsg = await P.evaluate(() => (document.body.innerText.match(/Wrong code[^\n]*/) || [''])[0]);
      await typeCode(await lastCode());
      await P.waitForFunction(() => /paid with points/.test(document.body.innerText), null, T);
      held = await P.evaluate(() => (document.querySelector('.msl-pts') || {}).innerText || '');
      due1 = await due();
      await P.click('[data-act="tender"][data-v="exact"]', T); await P.click('[data-act="complete"]', T);
      await P.waitForFunction(() => /Sale complete/.test(document.body.innerText), null, T);
      done = await P.evaluate(() => document.body.innerText);
    });
    const acc = await get('loyaltyAccounts/jane');
    const reds = (await all('loyaltyLedger')).filter((l) => l.type === 'redeem');
    const saleCall = await P.evaluate(() => window.__calls.filter((c) => !c.dryRun).pop() || null);
    ck('PW1 the till shows the SERVER\'s figures: Available 1,000 points · Value KES 100.00; the code goes to the customer (the screen never shows it); a wrong code counts down; Complete waits for the code',
      /Available: 1,000 points/.test(shown) && /Value: KES 100\.00/.test(shown) && /texted to the customer/.test(codeNote) && /1,000 points = KES 100\.00/.test(codeNote)
      && /Wrong code \(4 tries left\)/.test(wrongMsg) && disabledWhilePending === true, { shown, codeNote: codeNote.slice(0, 120), wrongMsg, disabledWhilePending });
    ck('PW2 mixed payment: KES 1,000 − 1,000 points (KES 100) = 900 due in cash; the sale completes; the receipt shows points and money; the ledger funds it from shop A; the buyer keeps what they earned on the 900',
      due0 === 1000 && due1 === 900 && /1,000 points = KES 100\.00 paid with points/.test(held) && /1,000 points paid KES 100/.test(done) && /money paid KES 900/.test(done)
      && saleCall && saleCall.payments.length === 2 && saleCall.payments[0].method === 'points' && saleCall.payments[0].amount === 100 && saleCall.payments[1].amount === 900
      && saleCall.grandTotal === 1000 && reds.length === 1 && reds[0].fundingShopId === A && acc.balance === 90 && acc.heldPoints === 0,   /* 1,000 spent, 90 earned on the 900 paid in money */
      { due0, due1, held, pays: saleCall && saleCall.payments, bal: acc.balance, red: reds.map((r) => r.fundingShopId) });

    /* PW3 — cancel gives the points back */
    await reset();
    let due3a = null, due3b = null;
    await act('confirm, then remove the points', async () => {
      await ringAndFind(); await startPoints(); await typeCode(await lastCode());
      await P.waitForFunction(() => /paid with points/.test(document.body.innerText), null, T);
      due3a = await due();
      await P.click('[data-act="pts-cancel"]', T);
      await P.waitForFunction(() => /Pay with points/.test(document.body.innerText), null, T);
      await P.waitForTimeout(300);
      due3b = await due();
    });
    const acc3 = await get('loyaltyAccounts/jane');
    ck('PW3 Remove gives the held points back: due 900 → 1,000, balance 1,000, nothing held', due3a === 900 && due3b === 1000 && acc3.balance === 1000 && acc3.heldPoints === 0, { due3a, due3b, bal: acc3.balance, held: acc3.heldPoints });

    /* PW4 — leaving the pay sheet releases them (the confirmation is bound to THIS cart) */
    await reset();
    await act('confirm, then go back to the cart', async () => {
      await ringAndFind(); await startPoints(); await typeCode(await lastCode());
      await P.waitForFunction(() => /paid with points/.test(document.body.innerText), null, T);
      await P.click('.msl-sh-f [data-act="close-sheet"]', T);
      await P.waitForTimeout(500);
    });
    const acc4 = await get('loyaltyAccounts/jane');
    ck('PW4 going back to the cart releases the held points (the confirmation is bound to this exact cart)', acc4.balance === 1000 && acc4.heldPoints === 0, { bal: acc4.balance, held: acc4.heldPoints });

    const over = await P.evaluate(() => document.documentElement.scrollWidth - window.innerWidth <= 1).catch(() => false);
    ck('PW5 no horizontal overflow at 390 px; no page errors', over && errors.length === 0, { over, errors: errors.slice(0, 3) });
  } finally { await browser.close().catch(() => {}); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
