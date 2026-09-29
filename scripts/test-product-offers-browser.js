/* test-product-offers-browser.js — buyer price offers end to end in a REAL browser (T2b, 2026-09-29)
 *   REAL merchant-v2 inventory module (the opt-in switch), REAL product.html, REAL merchant-v2 Messages module, REAL
 *   messagesDispatch + product-offers.js, then the REAL server pricer (validateOrderLines) over the cart the page built.
 *
 * PROVES
 *   OB0 a product without the seller's opt-in shows no Offer button
 *   OB1 the seller turns "Accept price offers" on from merchant-v2 (server-verified)
 *   OB2 the buyer sends an offer from the product page (server record)
 *   OB3 the seller sees it in merchant-v2 › Messages and counters from the thread
 *   OB4 the buyer sees the counter on the product page and accepts it → "Agreed", 24 h hold
 *   OB5 "Buy at the agreed price" puts a line with the offerId (not a trusted price) into the cart
 *   OB6 the server prices that cart at the agreed price — and refuses the same cart for another buyer
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-product-offers-browser';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }),
  auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }) }), messaging: () => ({ send: async () => ({}) }) });
const run = (fn) => (req) => (typeof fn.run === 'function' ? fn.run(req) : fn(req));
const DISP = require(Path.join(FN, 'messages-dispatch.js'));
const KS = require(Path.join(FN, 'kasshop.js'));
const PP = require(Path.join(FN, 'payment-purposes.js'));
const { makePageHarness } = require('./lib/page-harness.js');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 240) + ']' : '')); ok ? pass++ : fail++; };
const codeOf = async (p) => { try { await p; return null; } catch (e) { return (e && e.details && e.details.code) || (e && (e.code || e.message)) || 'error'; } };

const SHELL = (body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{--txt:#f4f4f4;--txt2:#a8a8a8;--txt3:#6d6d6d;--acc:#71ff00;--line:rgba(255,255,255,.09);--panel:#0d0d0d;--card:#141414}body{margin:0;background:#050505;color:#f4f4f4;font:14px system-ui}</style></head>
<body>${body}</body></html>`;
const FS_ADAPTER = `
  import { getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
  import { getFirestore, collection, query, where, orderBy, limit, getDocs } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
  const app = getApps()[0] || initializeApp({ projectId: 'demo' });
  const fdb = getFirestore(app);
  window.__adapter = {
    queryMessages: async (spec) => { const parts = [collection(fdb, ...spec.path)]; if (spec.orderBy) parts.push(orderBy(spec.orderBy[0], spec.orderBy[1])); if (spec.limit) parts.push(limit(spec.limit));
      const s = await getDocs(query(...parts)); return s.docs.map((d) => Object.assign({ id: d.id }, d.data())); },
    queryProducts: async () => { const s = await getDocs(query(collection(fdb, 'products'), where('sellerUid', '==', 'selO'))); return s.docs.map((d) => Object.assign({ id: d.id }, d.data())); },
  };`;
const INV_PAGE = SHELL(`<div id="host" style="height:100vh;display:flex;flex-direction:column"></div>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
<script src="/sokoni-merchant-data.js"></script><script src="/sokoni-merchant-stock.js"></script><script src="/sokoni-merchant-inventory-ui.js"></script>
<script type="module">${FS_ADAPTER}
  function start() { const u = firebase.auth().currentUser; if (!u || !window.__adapter) return setTimeout(start, 50);
    window.__inv = SokoniMerchantInventoryUI.mount(document.getElementById('host'), { scope: { ok: true, sellerUid: u.uid, shopId: u.uid, uid: u.uid }, db: window.__adapter, shopName: 'Duka',
      callAdjust: () => Promise.reject(new Error('not used')), callMessages: (p) => firebase.functions().httpsCallable('messagesDispatch')(p), onToast: () => {} }); }
  start();
</script>`);
const MSG_PAGE = SHELL(`<div id="host" style="height:100vh"></div>
<script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
<script src="/sokoni-merchant-messages.js"></script><script src="/sokoni-merchant-messages-ui.js"></script>
<script type="module">${FS_ADAPTER}
  function start() { const u = firebase.auth().currentUser; if (!u || !window.__adapter) return setTimeout(start, 50);
    window.__ui = SokoniMerchantMessagesUI.mount(document.getElementById('host'), { scope: { sellerUid: u.uid }, db: window.__adapter,
      dispatch: (p) => firebase.functions().httpsCallable('messagesDispatch')(p), onToast: () => {} }); }
  start();
</script>`);

(async () => {
  for (const u of ['selO', 'buyO', 'buyX']) await db.doc('users/' + u).set({ name: u === 'selO' ? 'Duka la Mama' : u });
  await db.doc('shops/selO').set({ sellerUid: 'selO', name: 'Duka', status: 'active' });
  await db.doc('products/pO').set({ name: 'Kiondo Basket', price: 2000, sellerUid: 'selO', shopId: 'selO', sellerName: 'Duka', status: 'active', isVisible: true, stock: 10, images: [] });
  const H = makePageHarness({ db, root: ROOT, pages: { '/inv-test.html': INV_PAGE, '/mm-test.html': MSG_PAGE },
    callables: { messagesDispatch: run(DISP.messagesDispatch), getShopAvailability: run(KS.getShopAvailability) } });
  await H.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const T = { timeout: 8000 };
  const act = async (label, fn) => { try { await fn(); return true; } catch (e) { ck('flow: ' + label, false, String(e && e.message).slice(0, 160)); return false; } };
  const buyer = { uid: 'buyO', email: 'b@x.co', emailVerified: true };
  const seller = { uid: 'selO', email: 's@x.co', emailVerified: true };
  try {
    const B0 = await H.page(browser, { user: buyer, viewport: { width: 390, height: 900 } });
    await B0.goto(H.BASE + '/product.html?id=pO');
    await B0.waitForFunction(() => typeof window.openMakeOffer === 'function' && window.product, null, { timeout: 15000 }).catch(() => {});
    ck('OB0 without the seller\'s opt-in there is no Offer button', !(await B0.$('button[onclick="openMakeOffer()"]')));
    await B0.__ctx.close();

    const I = await H.page(browser, { user: seller, viewport: { width: 390, height: 860 } });
    await I.goto(H.BASE + '/inv-test.html');
    await act('seller turns offers on', async () => {
      await I.waitForSelector('.mnv-row', { timeout: 15000 }); await I.click('.mnv-row', T);
      await I.waitForSelector('[data-act="offers"]', T); await I.click('.mnv-offers', T);
      await I.waitForFunction(() => { const c = document.querySelector('[data-act="offers"]'); return c && c.checked && !c.disabled; }, null, T);
    });
    ck('OB1 the seller turned "Accept price offers" on (server-verified)', (await db.doc('products/pO').get()).data().acceptOffers === true);

    const B = await H.page(browser, { user: buyer, viewport: { width: 390, height: 900 } });
    await B.goto(H.BASE + '/product.html?id=pO');
    await act('buyer sends an offer', async () => {
      await B.waitForSelector('button[onclick="openMakeOffer()"]', { timeout: 15000 });
      await B.click('button[onclick="openMakeOffer()"]', T);
      await B.waitForSelector('#offerPrice', T);
      await B.fill('#offerPrice', '1500', T); await B.fill('#offerQty', '2', T);
      await B.click('[data-offer="send"]', T);
      await B.waitForFunction(() => /is with the seller/.test(document.getElementById('offerPanel').innerText), null, T);
    });
    const o1 = (await db.doc('productOffers/pO__buyO').get()).data();
    ck('OB2 the buyer\'s offer is a server record (KES 1,500 × 2, pending)', o1 && o1.state === 'pending' && o1.amount === 1500 && o1.qty === 2, o1 && { st: o1.state });

    const S = await H.page(browser, { user: seller, viewport: { width: 390, height: 860 } });
    await S.goto(H.BASE + '/mm-test.html');
    await act('seller counters in Messages', async () => {
      await S.waitForSelector('.mmg-row', { timeout: 15000 }); await S.click('.mmg-row', T);
      await S.waitForSelector('[data-act="offer"][data-v="counter"]', T);
      await S.fill('#mmg-draft', '1800', T);
      await S.click('[data-act="offer"][data-v="counter"]', T);
      await S.waitForFunction(() => /countered: KES 1,800/.test(document.body.innerText), null, T);
    });
    const o2 = (await db.doc('productOffers/pO__buyO').get()).data();
    ck('OB3 the seller saw the offer in merchant-v2 Messages and countered from the thread', o2.proposedBy === 'seller' && o2.amount === 1800 && !(await S.$('[data-act="offer"]')), { by: o2.proposedBy, amt: o2.amount });

    await act('buyer accepts the counter', async () => {
      await B.reload(); await B.waitForSelector('button[onclick="openMakeOffer()"]', { timeout: 15000 });
      await B.click('button[onclick="openMakeOffer()"]', T);
      await B.waitForSelector('[data-offer="accept"]', T);
      await B.click('[data-offer="accept"]', T);
      await B.waitForFunction(() => /Agreed:/.test(document.getElementById('offerPanel').innerText), null, T);
    });
    const o3 = (await db.doc('productOffers/pO__buyO').get()).data();
    const txt = await B.evaluate(() => document.getElementById('offerPanel').innerText);
    ck('OB4 the buyer accepted the counter → Agreed, holding ~24 h', o3.state === 'accepted' && /Agreed/.test(txt) && /2[34] h/.test(txt) && Math.abs(o3.expiresAt - Date.now() - 86400000) < 120000, txt.slice(0, 120));

    let cart = null, wentToCheckout = false;
    await act('buy at the agreed price', async () => {
      const nav = B.waitForURL(/checkout(\.html)?/, { timeout: 8000 }).then(() => { wentToCheckout = true; }).catch(() => {});
      await B.click('[data-offer="buy"]', T); await nav;
    });
    cart = await B.evaluate(() => (window.SokoniCart ? SokoniCart.list() : JSON.parse(localStorage.getItem('sokoniCart') || localStorage.getItem('cart') || '[]'))).catch(() => null);
    const line = Array.isArray(cart) && cart.find((i) => i && i.offerId);
    ck('OB5 the cart line carries the offerId (a reference) and the agreed qty', !!line && line.offerId === 'pO__buyO' && Number(line.qty) === 2 && wentToCheckout /* checkout's own auth guard may then redirect in the harness */, line && { offerId: line.offerId, qty: line.qty, wentToCheckout });

    const items = (cart || []).map((i) => Object.assign({ productId: i.id || i.productId, qty: Number(i.qty) || 1 }, i.offerId ? { offerId: i.offerId } : {}));
    let priced = null; try { priced = await PP.validateOrderLines('buyO', items); } catch (e) { priced = { err: e.message }; }
    const other = await codeOf(PP.validateOrderLines('buyX', items));
    ck('OB6 the server charges that cart KES 1,800 × 2 — and refuses it for another buyer', priced && priced.subtotal === 3600 && priced.lines[0].unitPrice === 1800 && other === 'OFFER_NOT_YOURS', { sub: priced && priced.subtotal, err: priced && priced.err, other });
  } finally { await browser.close().catch(() => {}); H.stop(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
