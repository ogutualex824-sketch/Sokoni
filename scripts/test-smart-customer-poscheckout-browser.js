/* test-smart-customer-poscheckout-browser.js — Smart Customer Search on pos-checkout.html (real Chromium, 2026-09-30).
 * REAL page; REAL posCustomerSearch / posCustomerSave / posCustomerCard, SOKONI points lookup and posCompleteCheckout over
 * the fake Firestore. window.firebase only signs in the shop owner and routes callables.
 *
 * PROVES
 *   CP1 typing a partial number offers this shop's customers as choices — nothing attached
 *   CP2 the full number → "Customer found ✓"; Enter takes that ONE suggestion; the card shows her masked number,
 *       purchases, lifetime spend and ⭐ SOKONI points, and the SOKONI points box is filled and finds her
 *   CP3 a cash sale carries WHICH customer; the server names her from its own record and counts the purchase
 *   CP4 an unknown number → Save a new customer (name + phone) → attached; saved to THIS shop
 *   CP5 no full phone number on the screen; no sideways scroll at 390px with the card showing
 *   CP9 no page error from the customer code
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-smart-customer-pc';
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
const PPX = require(Path.join(FN, 'payment-purposes.js'));
const TILL = { sokoniTillId: 'TILLA', shopId: A, branchId: 'main', merchantUid: A, status: 'ACTIVE', currency: 'KES' };
const STK = [];
const readDoc = async (col, id) => { const d = await db.doc(col + '/' + id).get(); return d.exists ? d.data() : null; };
const markPaid = async () => { for (const d of (await db.collection('paymentIntents').get()).docs) if (d.data().status === 'created') await d.ref.update({ status: 'paid', paymentRef: 'IS-' + d.id }); };
const SC = require(Path.join(FN, 'pos-customer-scope.js'));
const ROUTES = {
  posCustomerSearch: (p) => ZF.posCustomerSearch({ data: p, auth: { uid: A, token: {} } }),
  posCustomerSave: (p) => ZF.posCustomerSave({ data: p, auth: { uid: A, token: {} } }),
  posCustomerCard: (p) => ZF.posCustomerCard({ data: p, auth: { uid: A, token: {} } }),
  posCompleteCheckout: (p) => ZF.posCompleteCheckout({ data: p, auth: { uid: A, token: { posRole: 'cashier' } } }),
  tillBuyerLookup: (p) => LP.lookup(db, { uid: A, data: p }),
  tillPointsStart: (p) => PS.tillStart(db, { uid: A, data: p }),
  tillPointsConfirm: (p) => PS.tillConfirm(db, { uid: A, data: p }),
  tillPointsCancel: (p) => PS.tillCancel(db, { uid: A, data: p }),
  shopOfferQuote: (p) => SO.quoteForCaller(db, { uid: A, data: p }),
  getMySokoniTill: async () => Object.assign({ exists: true }, TILL),
  createPaymentIntent: async (p) => { const q = await PPX.PURPOSES.pos_till_sale.price(A, p); const ref = q.preferredRef;
    await db.doc('paymentIntents/' + ref).set({ ref, uid: A, purpose: 'pos_till_sale', amount: q.amountCents / 100, metadata: q.metadata, status: 'created' }); return { ref, amount: q.amountCents / 100 }; },
  initiateSTKPush: async (p) => { STK.push(p); return { ok: true }; },
  mintDynamicSokoniQR: async (p) => ({ qrUrl: 'https://mysokoni.co.ke/pay-q?r=' + p.ref }),
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
    firestore: function () { return { collection: function (c) { return { doc: function (id) { return { get: function () {
      return window.__read(c, id).then(function (d) { return { exists: !!d, data: function () { return d; } }; }); } }; } }; } }; },
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
  if (typeof ZF.posCompleteCheckout !== 'function' || false) { ck('PC0 the till and pay-with-points load', false, ZF.__err || PS.__err || 'tillStart missing'); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
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
    await P.exposeFunction('__read', readDoc);
    await P.goto(BASE + '/pos-checkout.html', { waitUntil: 'domcontentloaded' });
    await P.waitForFunction(() => typeof Checkout !== 'undefined' && typeof Checkout.pointsPayStart === 'function', null, T);
    await P.waitForTimeout(1200);   /* init: settings, auth callback */

    /* the site's one-time privacy notice overlays the till on first visit; a cashier dismisses it once */
    await P.evaluate(() => { const b = document.getElementById('_sokoniPrivacyBanner'); if (b) b.remove(); });
    const jane = await SC.saveOwned(db, A, { phone: '0712345678', name: 'Jane Wanjiru', by: A });
    await SC.saveOwned(db, A, { phone: '0712345999', name: 'John Kamau', by: A });
    const settle = () => P.waitForFunction(() => { const e = document.getElementById('cust-suggest'); return e && e.innerHTML !== '' && !/Looking…/.test(e.innerText); }, null, T);

    /* CP1 */
    let cp1 = {};
    await act('partial number', async () => {
      await P.evaluate(() => Checkout.addItem({ id: 'stove', name: 'Stove', price: 1000 }));
      await P.type('#cust-input', '0712 34', { delay: 30 });
      await settle();
      cp1 = await P.evaluate(() => ({ rows: [...document.querySelectorAll('.cs-row')].map((b) => b.querySelector('.nm').textContent), found: !!document.querySelector('.cs-found'), card: document.getElementById('customer-card').classList.contains('visible') }));
    });
    ck('CP1 a partial number offers this shop\'s customers as choices — nothing attached', cp1.rows && cp1.rows.length === 2 && !cp1.found && !cp1.card, cp1);

    /* CP2 */
    let cp2 = {};
    await act('full number + Enter', async () => {
      await P.fill('#cust-input', ''); await P.type('#cust-input', '+254 712 345 678', { delay: 20 });
      await P.waitForSelector('.cs-found', T);
      cp2.attachedBefore = await P.evaluate(() => document.getElementById('customer-card').classList.contains('visible'));
      await P.press('#cust-input', 'Enter');
      await P.waitForFunction(() => /SOKONIpoints1,000/.test(document.getElementById('cust-points').innerText.replace(/\s+/g, '')), null, T);
      await P.waitForFunction(() => /Available: 1,000 points/.test((document.getElementById('skp-status') || {}).innerText || ''), null, T);
      cp2.card = await P.evaluate(() => document.getElementById('customer-card').innerText);
      cp2.skp = await P.evaluate(() => document.getElementById('skp-status').innerText);
    });
    cp2.dbg = cp2.card ? null : await P.evaluate(() => ({ pts: document.getElementById("cust-points").innerText, skp: document.getElementById("skp-status").innerText, vis: document.getElementById("customer-card").className }));
    ck('CP2 the full number (+254 form) → "Customer found ✓", NOT attached until Enter; her card shows the masked number, purchases, spend, ⭐ 1,000 and the points box finds her',
      cp2.attachedBefore === false && /Jane Wanjiru/.test(cp2.card || '') && /0712 ••• •678/.test(cp2.card || '') && /Purchases\s*0/.test(cp2.card || '') && /Lifetime spend\s*KES 0/.test(cp2.card || '') && /1,000 points/.test(cp2.skp || ''), cp2);

    /* CP5a — the screen, with the card showing, at phone width */
    await P.setViewportSize({ width: 390, height: 900 }); await P.waitForTimeout(150);
    const over = await P.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
    const text = await P.evaluate(() => document.getElementById('customer-card').innerText + document.getElementById('cust-suggest').innerText);
    await P.setViewportSize({ width: 1280, height: 900 });

    /* CP3 */
    let cp3 = {};
    await act('cash sale', async () => {
      await P.evaluate(() => Checkout.pay('cash'));
      await P.evaluate(() => { Checkout.cashExact(); Checkout.confirmCash(); });
      for (let i = 0; i < 40 && !(await all('posRetailSales')).length; i++) await P.waitForTimeout(250);
      cp3.call = (CALLS.filter((c) => c.name === 'posCompleteCheckout').pop() || {}).payload;
    });
    const s3 = (await all('posRetailSales'))[0] || {};
    const j3 = await get('posCustomers/' + jane.id);
    ck('CP3 the cash sale carries WHICH customer; the server names her from its own record and counts the purchase',
      cp3.call && cp3.call.customer && cp3.call.customer.id === jane.id && s3.customer && s3.customer.name === 'Jane Wanjiru' && j3.purchaseCount === 1, { sent: cp3.call && cp3.call.customer, rec: s3.customer, n: j3.purchaseCount });

    /* CP4 */
    let cp4 = {};
    await act('new customer', async () => {
      await P.waitForTimeout(2600);   /* the page resets after a completed sale */
      await P.evaluate(() => Checkout.clearCustomer());
      await P.type('#cust-input', '0799 123 456', { delay: 20 });
      await P.waitForSelector('#cust-new-name', T);
      cp4.offer = await P.evaluate(() => document.getElementById('cust-suggest').innerText);
      await P.evaluate(() => { const b = document.getElementById('_sokoniPrivacyBanner'); if (b) b.remove(); });   /* as certify-admin-navigation does */
      await P.fill('#cust-new-name', 'Akinyi Otieno');
      cp4.hit = await P.evaluate(() => { const b = document.getElementById('cust-new-save').getBoundingClientRect(); const t = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return { b: [b.x, b.y, b.width, b.height], top: t && (t.id || t.className) }; });
      await P.click('#cust-new-save', T);
      await P.waitForFunction(() => /saved to your customers/.test(document.getElementById('cust-points').innerText) && !/…/.test(document.getElementById('cust-points').innerText), null, T);
      cp4.card = await P.evaluate(() => document.getElementById('customer-card').innerText);
    });
    const ak = (await all('posCustomers')).find((c) => c.name === 'Akinyi Otieno');
    ck('CP4 an unknown number → Save a new customer → attached; saved to THIS shop; no SOKONI account is said as such',
      /New customer on 0799 ••• •456\?/.test(cp4.offer || '') && ak && ak.sellerId === A && ak.phoneKey === '254799123456' && /Akinyi Otieno/.test(cp4.card || '') && /No account/.test(cp4.card || ''), { offer: cp4.offer, card: cp4.card, hit: cp4.hit });

    ck('CP5 no full phone number on the screen; no sideways scroll at 390px with the customer card showing', !/712345678|345 678/.test(text) && over <= 0, { over });
    const pe = errors.filter((m) => /cust|_attachSmartCustomer|_paintCustSuggest|pickCustomer|saveNewCustomer|_escH|_kePhone/i.test(m));
    ck('CP9 no page error from the customer code', pe.length === 0, { errs: pe.slice(0, 3), other: errors.length });
    await ctx.close();
  } finally { await browser.close().catch(() => {}); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
