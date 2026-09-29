/* test-cart-product-offers-browser.js — universal catalogue U7c2 (2026-09-29): the CART and the PRODUCT PAGE show the
 * shop's offer exactly as the server charges it — and no longer show discounts nobody charges.
 *
 * The SHIPPED display code, run in Chromium: cart.html's inline promo/offer script and product.js's offer block, both
 * extracted from the files verbatim. Their `shopOfferQuote` call goes through a stub firebase-functions module (served
 * by page.route) to the REAL server quote (functions/shop-offers.js quoteForCaller) running in Node over the fake
 * Firestore — so the figure on screen is the server's.
 *
 * PROVES
 *   CP1 cart: a live flash sale shows "-KES 7,500 · Weekend Flash Sale" and a total of 67,500 (the server's figure)
 *   CP2 cart: a promo code is REMEMBERED, never priced — no discount appears, only {code} is stored, and no hard-coded
 *       code list exists any more
 *   CP3 cart: when the quote cannot be had, the row says "Checked at checkout" and the total is NOT reduced
 *   CP4 product page: the listed 75,000 is struck through beside 67,500 with the offer's name; with no live offer the
 *       listed price stands untouched; the admin `offers` badge (a discount no checkout charged) is gone
 *   CP5 no page errors
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-cart-offers';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const Path = require('path'), http = require('http'), fs = require('fs'), Module = require('module');
const ROOT = Path.resolve(__dirname, '..'), FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 300) + ']' : '')); ok ? pass++ : fail++; };
class HttpsError extends Error { constructor(c, m) { super(m); this.code = c; } }
const ADMIN = { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }) };
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-admin') return ADMIN;
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), HttpsError };
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {} };
  if (id === './shop-employees') return { resolveShopAccess: async () => ({ role: 'owner' }), capabilitiesForRole: () => [] };
  return origReq.apply(this, arguments);
};
let SO; try { SO = require(Path.join(FN, 'shop-offers.js')); } catch (e) { SO = { __err: e.message }; }
const src = (f) => { try { return fs.readFileSync(Path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
const A = 'shopA';
const FLASH = { shopId: A, sellerUid: A, type: 'percentage', template: 'flashSale', status: 'live', name: 'Weekend Flash Sale', percent: 10,
  qualifyingListingIds: ['laptop'], endsAt: new Date(Date.now() + 2 * 864e5).toISOString() };
let QUOTE_DOWN = false;
async function reset(withOffer) {
  for (const d of (await db.collection('shopOffers').get()).docs) await d.ref.delete();
  await db.doc('products/laptop').set({ name: 'Laptop', price: 75000, stock: 5, sellerUid: A, shopId: A, status: 'active', isVisible: true });
  if (withOffer) await db.doc('shopOffers/f1').set(FLASH);
}
async function serverQuote(name, data) {
  if (name !== 'shopOfferQuote') return { err: 'unknown callable ' + name };
  if (QUOTE_DOWN) return { err: 'internal' };
  try { return { data: await SO.quoteForCaller(db, { uid: null, data }) }; } catch (e) { return { err: e.message }; }
}

/* the shipped code, extracted verbatim */
const cartHtml = src('cart.html');
const inline = [...cartHtml.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const CART_SCRIPT = inline.find((s) => s.indexOf('function applyCartPromo') > -1) || '';
const prodSrc = src('product.js');
const pi = prodSrc.indexOf("/* ── THE SHOP'S LIVE OFFER ON THIS PRODUCT");
const pj = pi > -1 ? prodSrc.indexOf('})();', pi) + 5 : -1;
const PRODUCT_BLOCK = pi > -1 ? prodSrc.slice(pi, pj) : '';

const STUB_FUNCTIONS = `export function getFunctions(){ return {}; }
export function httpsCallable(_f, name){ return function(data){ return window.__callable(name, data).then(function(r){ if (r.err) throw new Error(r.err); return { data: r.data }; }); }; }`;
const CART_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="summarySubtotal">KES 0</div><div id="summaryDiscount">—</div><div id="summaryTotal">KES 0</div>
<input id="cartPromoInput"><div id="cartPromoMsg"></div><div id="heroCount"></div>
<script>
  window.firebaseApp = {};
  window._esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, ''); };
  window._updateHeroCount = function () {};
  window.__lines = [{ productId: 'laptop', qty: 1, price: 75000 }];
  window.SokoniCart = { list: function () { return window.__lines.slice(); } };
  window.updateSummary = function () { document.getElementById('summaryTotal').textContent = 'KES ' + (window.__lines.reduce(function (s, l) { return s + l.price * l.qty; }, 0)).toLocaleString(); };
  window.updateSummary();
</script>
<script>${CART_SCRIPT.replace(/<\/script>/g, '')}</script>
</body></html>`;
const PRODUCT_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<h2 id="productPriceEl">KES 75,000</h2>
<script>
  window.firebaseApp = {};
  function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, ''); }
  var product = { id: 'laptop', price: 75000 };
  history.replaceState(null, '', '?id=laptop');
  ${PRODUCT_BLOCK}
</script></body></html>`;

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      if (u === '/cart.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(CART_PAGE); }
      if (u === '/product.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PRODUCT_PAGE); }
      res.writeHead(404); res.end('');
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  if (typeof SO.quoteForCaller !== 'function' || !CART_SCRIPT || !PRODUCT_BLOCK) {
    ck('CP0 the shipped cart/product offer code and the server quote exist', false, { quote: typeof SO.quoteForCaller, cart: !!CART_SCRIPT, product: !!PRODUCT_BLOCK });
    say(`\n${pass} passed, ${fail} failed`); process.exit(1);
  }
  const srv = await serve();
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const errors = [];
  try {
    const ctx = await browser.newContext();
    await ctx.route('**/firebasejs/**/firebase-functions.js', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: STUB_FUNCTIONS }));
    await ctx.exposeFunction('__callable', serverQuote);
    const P = await ctx.newPage();
    P.on('pageerror', (e) => errors.push(e.message));
    const disc = () => P.$eval('#summaryDiscount', (e) => e.textContent);
    const total = () => P.$eval('#summaryTotal', (e) => e.textContent);

    /* CP1 */
    await reset(true);
    await P.goto(BASE + '/cart.html');
    await P.waitForFunction(() => /KES|Checked/.test(document.getElementById('summaryDiscount').textContent), null, { timeout: 10000 }).catch(() => {});
    const d1 = await disc(), t1 = await total();
    ck('CP1 cart: the server\'s offer — "-KES 7,500 · Weekend Flash Sale" and a total of 67,500', /-KES 7,500/.test(d1) && /Weekend Flash Sale/.test(d1) && /67,500/.test(t1), { d1, t1 });

    /* CP2 */
    await reset(false);
    await P.goto(BASE + '/cart.html');
    await P.evaluate(() => { localStorage.clear(); });
    await P.fill('#cartPromoInput', 'SAVE10'); await P.evaluate(() => applyCartPromo());
    const msg = await P.$eval('#cartPromoMsg', (e) => e.textContent);
    const stored = await P.evaluate(() => localStorage.getItem('sokoniAppliedPromo'));
    const d2 = await disc(), t2 = await total();
    ck('CP2 cart: a promo code is remembered, never priced — no discount shown, only {code} stored, no hard-coded code list',
      /checked and applied at checkout/.test(msg) && stored === '{"code":"SAVE10"}' && !/KES/.test(d2) && /75,000/.test(t2)
      && !/BUILT_IN_CODES|SAVE10:10|MEGA20/.test(cartHtml.replace(/\/\*[\s\S]*?\*\//g, '')), { msg, stored, d2, t2 });

    /* CP3 */
    await reset(true); QUOTE_DOWN = true;
    await P.goto(BASE + '/cart.html');
    await P.waitForFunction(() => /Checked at checkout/.test(document.getElementById('summaryDiscount').textContent), null, { timeout: 10000 }).catch(() => {});
    const d3 = await disc(), t3 = await total(); QUOTE_DOWN = false;
    ck('CP3 cart: no quote → "Checked at checkout", and the total is NOT reduced', /Checked at checkout/.test(d3) && /75,000/.test(t3), { d3, t3 });

    /* CP4 */
    await reset(true);
    await P.goto(BASE + '/product.html');
    await P.waitForFunction(() => /67,500/.test(document.getElementById('productPriceEl').textContent), null, { timeout: 10000 }).catch(() => {});
    const onOffer = await P.$eval('#productPriceEl', (e) => ({ text: e.textContent, struck: !!e.querySelector('.prd-offer-was') }));
    await reset(false);
    await P.goto(BASE + '/product.html'); await P.waitForTimeout(1500);
    const noOffer = await P.$eval('#productPriceEl', (e) => e.textContent);
    ck('CP4 product page: 75,000 struck through beside 67,500 with the offer name; no offer → the listed price stands; the admin badge is gone',
      onOffer.struck && /75,000/.test(onOffer.text) && /67,500/.test(onOffer.text) && /Weekend Flash Sale/.test(onOffer.text) && noOffer === 'KES 75,000'
      && !/SokoniOffers\.applyBadge\(/.test(prodSrc), { onOffer, noOffer });

    ck('CP5 no page errors', errors.length === 0, errors.slice(0, 3));
  } finally { await browser.close().catch(() => {}); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
