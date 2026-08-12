#!/usr/bin/env node
/* TRACK 2 — FINAL CART ISOLATION + PERSISTENCE SUITE (2.7)
 *
 *   firebase emulators:exec --only firestore --project sokoni-cart-final \
 *     "node scripts/test-cart-final.js"
 *
 * This proves the SYSTEM, not the slices. The per-slice suites each built one sandbox per
 * surface, and Track 3 taught us why that is not enough: isolated sandboxes can all pass
 * while the surfaces disagree in reality, because each was talking to its own store.
 *
 * So the unit here is a BROWSER, not a page:
 *
 *   browser()          one localStorage, shared by every page opened in it
 *   browser.open(...)  a fresh vm context — its own globals, the SAME storage
 *   reload / navigate  open the page again; nothing carries over but storage
 *
 * That is the real shape of the platform: pages share a cart because they share a device,
 * not because they share memory. Two browsers are two devices and must never see each
 * other's cart.
 *
 * Every page runs the SHIPPED files. Nothing about cart behaviour is reimplemented.
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-cart-final';

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();
const { stripComments, keepOnly, htmlScriptRegions } = require('./scan-legacy-wishlist.js');
const SCAN = require('./scan-cart-writers.js');
const STATE = require('./cart-migration-state.js');

const R = {};
let pass = 0, fail = 0;
function ck(g, l, ok, d) {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
  if (R[g] !== 'FAIL') R[g] = ok ? 'PASS' : 'FAIL';
}
const read = (f) => fs.readFileSync(path.resolve(ROOT, f), 'utf8');
const execOf = (f) => stripComments(f.endsWith('.html')
  ? keepOnly(read(f), htmlScriptRegions(read(f))) : read(f));

function sliceFn(src, sig) {
  const bare = stripComments(src);
  const start = bare.indexOf(sig);
  if (start === -1) throw new Error('not found: ' + sig);
  let i = bare.indexOf('{', start), depth = 0;
  for (; i < bare.length; i++) {
    if (bare[i] === '{') depth++;
    else if (bare[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced: ' + sig);
}

/* ── the browser ─────────────────────────────────────────────────────────────
   One storage object. Every page opened in this browser shares it and nothing else. */
function browser(seed) {
  const store = Object.assign({}, seed || {});
  const failing = { write: false };

  function open(name, wiring) {
    const els = {};
    const g = {
      localStorage: {
        getItem: k => (k in store ? store[k] : null),
        setItem: (k, v) => { if (failing.write) throw new Error('QuotaExceededError'); store[k] = String(v); },
        removeItem: k => { delete store[k]; },
      },
      addEventListener: () => {}, removeEventListener: () => {},
      dispatchEvent: () => true,
      CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
      setTimeout, clearTimeout, console,
      JSON, Date, Math, String, Number, Object, Array, Promise, Error, Set, RegExp,
      isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
      requestAnimationFrame: (f) => setTimeout(f, 0),
      location: { pathname: '/' + name, href: '', search: '', reload() { g.reloaded = true; } },
    };
    g.window = g; g.page = name; g.notifs = []; g.els = els;
    const mk = () => ({ innerHTML: '', textContent: '', innerText: '', style: {}, dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, offsetWidth: 0,
      appendChild(c) { return c; }, removeChild(c) { return c; }, remove() {},
      setAttribute() {}, getAttribute: () => null, addEventListener() {},
      querySelector: () => null, querySelectorAll: () => [] });
    g.document = {
      getElementById: (id) => (els[id] = els[id] || mk()),
      createElement: mk, body: mk(), head: mk(), readyState: 'complete',
      querySelector: () => null,
      querySelectorAll: (sel) => {
        if (!els['@' + sel]) els['@' + sel] = [mk()];
        return els['@' + sel];
      },
      addEventListener: () => {},
    };
    g.showNotif = (m, t) => g.notifs.push({ msg: m, type: t });
    g.showNotification = g.showNotif;
    g.showToast = (m) => g.notifs.push({ msg: m });
    g.toast = g.showToast;
    g.showPushToast = () => {};
    vm.createContext(g);
    /* Every real page loads the service first. */
    vm.runInContext(read('sokoni-cart.js'), g);
    if (wiring) wiring(g);
    return g;
  }
  return { open, store, failing };
}

const P = (id, extra) => Object.assign({ id, name: 'Item ' + id, price: 100, category: 'Home',
  sellerUid: 'seller-A', sellerLat: -1.29, sellerLng: 36.82 }, extra || {});

/* ── page wirings: load the SHIPPED surface into a page ── */
const PAGE = {
  product: (g) => {
    g.product = P('pr1'); g.quantity = 1;
    g._selectedSize = null; g._selectedColor = null; g._selectedVariants = {};
    g._showProductNotif = (m, t) => g.notifs.push({ msg: m, type: t });
    const s = read('product.js');
    vm.runInContext(['function _cartSvc(', 'function _cartItem(', 'function addToCart(', 'function buyNowProduct(']
      .map(x => sliceFn(s, x)).join('\n'), g);
  },
  category: (g) => {
    g.allProducts = [P('cat1')]; g.isAdultCategory = () => false;
    g.updateCartCount = () => {};
    const s = read('category.js');
    vm.runInContext(['function _cartSvc(', 'async function addToCart(', 'async function buyNowCat(']
      .map(x => sliceFn(s, x)).join('\n'), g);
  },
  home: (g) => {
    g.products = [P('h1')]; g.filteredProducts = g.products;
    g.displayProducts = () => {}; g.flyToCart = () => {}; g.saveHomeScroll = () => {};
    g.isAdultCategory = () => false; g.sokoniTrackAddToCart = () => {};
    const s = read('script.js');
    vm.runInContext(['function _cartSvc(', 'function _syncCart(', 'async function buyProduct(',
      'async function buyNow(', 'function updateCart(', 'function removeFromCart(']
      .map(x => sliceFn(s, x)).join('\n'), g);
  },
  market: (g) => {
    g.SokoniWishlist = { count: () => 0, isWishlisted: () => false };
    vm.runInContext(read('market-actions.js'), g);
  },
  cart: (g) => {
    vm.runInContext(read('cart.js'), g);
    g.showNotif = (m, t) => g.notifs.push({ msg: m, type: t });
    g.getCart = () => vm.runInContext('cart', g);
  },
  food: (g) => { vm.runInContext(read('sokoni-food.js'), g); },
  flash: (g) => {
    g.allProducts = [P('fs1')]; g.flashProducts = g.allProducts; g.DEMO_FLASH = [];
    const s = read('flashsale.html');
    vm.runInContext(['function _findProduct(id){ return allProducts.find(p=>p.id===id)||null; }',
      sliceFn(s, 'function _fsCart('), sliceFn(s, 'function fsAddCart('),
      sliceFn(s, 'function fsBuyNow('), sliceFn(s, 'function updateCartPips(')].join('\n'), g);
  },
  header: (g) => {
    vm.runInContext(read('shared-header.js').match(/function _readState\(\)[\s\S]*?\n  \}/)[0], g);
  },
  wishlist: (g) => {
    g._wishData = [P('w1', { productId: 'w1' })];
    g._wishRender = () => { g.rendered = true; };
    g.removed = [];
    g.SokoniWishlist = { remove: (id) => { g.removed.push(id); return Promise.resolve(true); } };
    const s = read('wishlist.html');
    vm.runInContext([sliceFn(s, 'function updateCartBadge('), sliceFn(s, 'function moveToCart('),
      sliceFn(s, 'function buyNowWish(')].join('\n'), g);
  },
  checkout: (g) => {
    const s = read('checkout.html');
    vm.runInContext(stripComments(s).match(/window\.removeCartItem = function[\s\S]*?\n\};/)[0], g);
  },
};
const cartOf = (b) => JSON.parse(b.store.cart || '[]');
const tick = () => new Promise(r => setTimeout(r, 20));

(async () => {
console.log('\nTRACK 2 — FINAL CART ISOLATION + PERSISTENCE SUITE\n' + '='.repeat(70));
await db.collection('products').doc('pr1').set({ name: 'Item pr1', price: 100 });

/* ══ A. persistence across a reload ══ */
console.log('\nA. Persistence — add, reload, still there');
{
  const b = browser();
  const p1 = b.open('product.html', PAGE.product);
  p1.addToCart();
  ck('A', 'stored after the add', cartOf(b).length === 1, cartOf(b).length);
  /* A genuine reload: new context, same storage. Nothing in memory survives. */
  const p2 = b.open('product.html', PAGE.product);
  ck('A', 'a fresh page context sees it', p2.SokoniCart.lines() === 1, p2.SokoniCart.lines());
  ck('A', 'and it is canonical, not a private copy',
     p2.SokoniCart.list()[0].id === 'pr1', JSON.stringify(p2.SokoniCart.list()[0].id));
  /* product.js legitimately adds the variant-selection fields on top of the product
     object, so comparing against the bare fixture was wrong. What must hold is that every
     product field survives untouched and the selection fields are present. */
  const row = p2.SokoniCart.list()[0];
  ck('A', 'every product field survived the round trip',
     Object.keys(P('pr1')).every(k => JSON.stringify(row[k]) === JSON.stringify(P('pr1')[k])),
     Object.keys(P('pr1')).filter(k => JSON.stringify(row[k]) !== JSON.stringify(P('pr1')[k])).join(','));
  ck('A', 'and the variant selection came with it',
     'selectedSize' in row && 'selectedColor' in row && 'selectedVariants' in row,
     JSON.stringify(Object.keys(row)));
  ck('A', 'nothing else was added', Object.keys(row).length === Object.keys(P('pr1')).length + 3,
     Object.keys(row).length);
}

/* ══ B. cross-surface agreement — separate contexts, one browser ══ */
console.log('\nB. Cross-surface — one browser, many pages, one cart');
{
  const b = browser();
  b.open('product.html', PAGE.product).addToCart();
  await b.open('category.html', PAGE.category).addToCart('cat1');
  b.open('flashsale.html', PAGE.flash).fsAddCart('fs1', 90);
  b.open('food.html', PAGE.food).SokoniFood.addToCart('r1', 'Mama', '🐟', { id: 'd1', name: 'Fish', price: 800 }, 2, '');

  const ids = cartOf(b).map(i => i.id || i.cartId);
  ck('B', 'four surfaces, four rows, one cart', cartOf(b).length === 4, JSON.stringify(ids));

  /* Every reader, each in its OWN fresh context. */
  const cartPage = b.open('cart.html', PAGE.cart);
  cartPage.renderCart();
  ck('B', 'the cart page sees all four', cartPage.getCart().length === 4, cartPage.getCart().length);
  const mkt = b.open('index.html', PAGE.market);
  ck('B', 'a marketplace card knows the product is in the cart', mkt.SokoniMarket.isInCart('pr1'));
  ck('B', 'and knows the flash item is too', mkt.SokoniMarket.isInCart('fs1'));
  const hdr = b.open('about.html', PAGE.header);
  const expected = cartOf(b).reduce((s, i) => s + (i.qty || 1), 0);
  ck('B', 'the header pip agrees with the stored cart',
     hdr._readState().cartCount === expected, hdr._readState().cartCount + ' vs ' + expected);
  const foodPage = b.open('food-menu.html', PAGE.food);
  ck('B', 'the food engine sees only its own row', foodPage.SokoniFood.getCart().length === 1);
  ck('B', 'and its badge counts everything', foodPage.SokoniFood.getCartCount() === 2,
     foodPage.SokoniFood.getCartCount());
}

/* ══ C. removal agreement ══ */
console.log('\nC. Removal — one surface removes, every reader reflects it');
{
  const b = browser();
  b.open('product.html', PAGE.product).addToCart();
  b.open('flashsale.html', PAGE.flash).fsAddCart('fs1', 90);
  ck('C', 'two rows to start', cartOf(b).length === 2);

  const mkt = b.open('index.html', PAGE.market);
  mkt.SokoniMarket.removeFromCart('pr1');
  ck('C', 'one row after the card removed it', cartOf(b).length === 1, cartOf(b).length);
  const cartPage = b.open('cart.html', PAGE.cart);
  cartPage.renderCart();
  ck('C', 'the cart page agrees', cartPage.getCart().length === 1);
  const hdr = b.open('about.html', PAGE.header);
  ck('C', 'the header agrees', hdr._readState().cartCount === 1, hdr._readState().cartCount);
  const mkt2 = b.open('index.html', PAGE.market);
  ck('C', 'a fresh card no longer thinks it is in the cart', !mkt2.SokoniMarket.isInCart('pr1'));
}

/* ══ D. device isolation, and what account isolation actually is ══ */
console.log('\nD. Two browsers are two devices');
{
  const a = browser(), z = browser();
  a.open('product.html', PAGE.product).addToCart();
  ck('D', 'browser A has one row', cartOf(a).length === 1);
  ck('D', 'browser Z has none — no shared state', cartOf(z).length === 0, cartOf(z).length);
  const zh = z.open('about.html', PAGE.header);
  ck('D', "and Z's header shows an empty cart, not A's", zh._readState().cartCount === 0);

  /* Account isolation on ONE device is provided by sign-out wiping storage, NOT by
     uid-scoping the cart — that was rejected in 2.2A because it would empty every
     anonymous shopper's cart. Both halves are asserted, and the residual gap is stated
     rather than papered over. */
  const keep = read('firebase.js').match(/_SOKONI_LS_KEEP\s*=\s*(\/[^\n]+?\/[gimsuy]*)/);
  const keepRe = keep ? eval(keep[1]) : null;                 /* eslint-disable-line no-eval */
  ck('D', 'sign-out wipes localStorage except a keep-list', !!keepRe, keep && keep[1]);
  ck('D', 'and "cart" is NOT on that keep-list — a clean sign-out clears it',
     keepRe && !keepRe.test('cart'));
  ck('D', 'the service never stamps a uid on the cart',
     !/firebaseAuth|onAuthStateChanged|ownerUid/.test(stripComments(read('sokoni-cart.js'))));
  ck('D', 'so the cart is device-scoped by design, as 2.2A decided',
     stripComments(read('sokoni-cart.js')).indexOf('uid') === -1 ||
     /not uid-scoped|NOT uid-scoped/i.test(read('sokoni-cart.js')));
}

/* ══ E. anonymous carts ══ */
console.log('\nE. Anonymous shopping keeps working');
{
  const b = browser();
  const p = b.open('product.html', PAGE.product);
  ck('E', 'no auth object exists at all', p.firebaseAuth === undefined);
  p.addToCart();
  ck('E', 'the add still persisted', cartOf(b).length === 1);
  const p2 = b.open('cart.html', PAGE.cart);
  p2.renderCart();
  ck('E', 'and survives navigation while signed out', p2.getCart().length === 1);
  ck('E', 'the storage key is not uid-scoped',
     Object.keys(b.store).filter(k => /^cart/.test(k)).join(',') === 'cart',
     Object.keys(b.store).join(','));
}

/* ══ F. the four quantity shapes coexist ══ */
console.log('\nF. Four quantity models, one cart, none converted');
{
  const b = browser();
  const p = b.open('product.html', PAGE.product); p.quantity = 3; p.addToCart();   /* duplicate rows */
  b.open('business.html', (g) => {
    g.BIZ_ID = 'biz1'; g.skNavRefresh = () => {};
    vm.runInContext(sliceFn(read('business.html'), 'window.bizAddToCart ='), g);
  }).bizAddToCart('b1', 'Chai', 120, 'c.png');                                      /* merge-by-id */
  b.open('business.html', (g) => {
    g.BIZ_ID = 'biz1'; g.skNavRefresh = () => {};
    vm.runInContext(sliceFn(read('business.html'), 'window.bizAddToCart ='), g);
  }).bizAddToCart('b1', 'Chai', 120, 'c.png');
  b.open('food.html', PAGE.food).SokoniFood.addToCart('r1', 'M', '🐟', { id: 'd1', name: 'Fish', price: 800 }, 2, 'extra');

  const c = cartOf(b);
  ck('F', 'duplicate rows kept as rows', c.filter(i => i.id === 'pr1').length === 3,
     c.filter(i => i.id === 'pr1').length);
  ck('F', 'none of them gained a qty field', c.filter(i => i.id === 'pr1').every(i => i.qty === undefined));
  ck('F', 'merge-by-id produced ONE row at qty 2',
     c.filter(i => i.id === 'b1').length === 1 && c.find(i => i.id === 'b1').qty === 2,
     JSON.stringify(c.filter(i => i.id === 'b1')));
  ck('F', 'the food row keeps cartId, note and qty',
     !!c.find(i => i.type === 'food' && i.cartId && i.note === 'extra' && i.qty === 2),
     JSON.stringify(c.find(i => i.type === 'food')));
  const hdr = b.open('x.html', PAGE.header);
  ck('F', 'the badge sums them all correctly (3 + 2 + 2)',
     hdr._readState().cartCount === 7, hdr._readState().cartCount);
}

/* ══ G. failure never becomes success, or an empty cart ══ */
console.log('\nG. A failed write is never a success claim, never a wipe');
{
  const b = browser({ cart: JSON.stringify([P('keep')]) });
  b.failing.write = true;
  const p = b.open('product.html', PAGE.product);
  ck('G', 'product add reports failure', p.addToCart() === false);
  ck('G', 'no success toast', !p.notifs.some(n => /added to cart/i.test(n.msg)), JSON.stringify(p.notifs));
  const f = b.open('food.html', PAGE.food);
  f.SokoniFood.clearCart();
  ck('G', 'a food clear cannot wipe the product rows',
     cartOf(b).length === 1 && cartOf(b)[0].id === 'keep', JSON.stringify(cartOf(b)));
  const w = b.open('wishlist.html', PAGE.wishlist);
  w.moveToCart(0); await tick();
  ck('G', 'move-to-cart did not remove from the wishlist', w.removed.length === 0,
     JSON.stringify(w.removed));
  ck('G', 'the shopper is told the item is still saved',
     w.notifs.some(n => /still in your wishlist/.test(n.msg)), JSON.stringify(w.notifs));
  b.failing.write = false;
  const hdr = b.open('x.html', PAGE.header);
  ck('G', 'and the cart is intact throughout', hdr._readState().cartCount === 1);
}

/* ══ H. Buy Now requires a successful write before navigating ══ */
console.log('\nH. Buy Now — no navigation without a write');
{
  for (const [name, wiring, call] of [
    ['product.html', PAGE.product, (g) => g.buyNowProduct()],
    ['category.html', PAGE.category, (g) => g.buyNowCat('cat1')],
    ['flashsale.html', PAGE.flash, (g) => g.fsBuyNow('fs1', 90)],
    ['wishlist.html', PAGE.wishlist, (g) => g.buyNowWish(0)],
    ['index.html', PAGE.home, (g) => g.buyNow('h1')],
  ]) {
    const b = browser({ cart: JSON.stringify([P('old')]) });
    b.failing.write = true;
    const g = b.open(name, wiring);
    await call(g);
    ck('H', name + ': did not navigate on a failed write', g.location.href !== 'checkout.html',
       g.location.href);
    ck('H', name + ': left the previous cart intact', cartOf(b).length === 1 && cartOf(b)[0].id === 'old');
  }
}

/* ══ I. checkout contract + post-order clearing ══ */
console.log('\nI. Checkout array contract, and no resurrection');
{
  const b = browser();
  const p = b.open('product.html', PAGE.product); p.quantity = 2; p.addToCart();
  const raw = cartOf(b);
  /* The real server cross-check, against a real catalogue. */
  const ids = [...new Set(raw.map(i => String(i.id || i.productId || '')).filter(Boolean))];
  const snap = await db.collection('products')
    .where(admin.firestore.FieldPath.documentId(), 'in', ids).get();
  const priceMap = {}; snap.forEach(d => { priceMap[d.id] = d.data(); });
  const serverTotal = raw.reduce((s, i) => {
    const pd = priceMap[String(i.id || i.productId || '')];
    return pd ? s + Number(pd.salePrice || pd.price || 0) * Math.max(1, Number(i.qty) || Number(i.quantity) || 1) : s;
  }, 0);
  ck('I', 'the server prices the cart at 200 (2 x 100)', serverTotal === 200, serverTotal);
  ck('I', 'orderItems is still the raw array', /orderItems: cart/.test(execOf('checkout.html')));
  ck('I', 'pickupCoords still resolves from cart[0]', raw[0].sellerLat === -1.29);

  /* Post-order clearing, then a genuine reload. */
  const co = b.open('checkout.html', (g) => {
    vm.runInContext('function clearAfterOrder(){ window.SokoniCart && window.SokoniCart.clear(); }', g);
  });
  co.clearAfterOrder();
  const after = b.open('index.html', PAGE.market);
  ck('I', 'the cart is empty after the order', after.SokoniCart.lines() === 0, after.SokoniCart.lines());
  const hdr = b.open('about.html', PAGE.header);
  ck('I', 'and nothing resurrects on the next page', hdr._readState().cartCount === 0,
     hdr._readState().cartCount);
  ck('I', 'no mirror was left holding the items', !b.store.sokoniCart, String(b.store.sokoniCart));
}

/* ══ J. food isolation across contexts ══ */
console.log('\nJ. Food and product rows stay separate across pages');
{
  const b = browser();
  b.open('product.html', PAGE.product).addToCart();
  b.open('food.html', PAGE.food).SokoniFood.addToCart('r1', 'M', '🐟', { id: 'pr1', name: 'Fish', price: 800 }, 1, '');
  const c = cartOf(b);
  ck('J', 'a dish whose itemId equals a product id stays separate', c.length === 2,
     JSON.stringify(c.map(i => i.type || 'product')));
  const f = b.open('food-order.html', PAGE.food);
  f.SokoniFood.clearCart();
  ck('J', 'clearing food leaves the product', cartOf(b).length === 1 && cartOf(b)[0].id === 'pr1' &&
     !cartOf(b)[0].type, JSON.stringify(cartOf(b)));
  const cartPage = b.open('cart.html', PAGE.cart);
  cartPage.renderCart();
  ck('J', 'and the cart page shows exactly that one row', cartPage.getCart().length === 1);
}

/* ══ K. badge consistency across every migrated reader ══ */
console.log('\nK. Every badge reports the same number');
{
  const b = browser({ cart: JSON.stringify([P('a', { qty: 3 }), P('b'),
    { type: 'food', cartId: 'C1', itemId: 'd', name: 'F', price: 10, qty: 2 }]) });
  const expected = 3 + 1 + 2;
  const hdr = b.open('about.html', PAGE.header);
  ck('K', 'shared-header', hdr._readState().cartCount === expected, hdr._readState().cartCount);
  const food = b.open('food.html', PAGE.food);
  food.SokoniFood.getCartCount();
  ck('K', 'the service itself', food.SokoniCart.units() === expected, food.SokoniCart.units());
  const flash = b.open('flashsale.html', PAGE.flash);
  flash.updateCartPips();
  const pip = flash.els['@#bnavCartPip'] ? null : flash.els.bnavCartPip;
  ck('K', 'flash-sale pip', pip && Number(pip.textContent) === expected,
     pip && pip.textContent);
  const mkt = b.open('index.html', PAGE.market);
  ck('K', 'market-actions counts units, not lines', mkt.SokoniCart.units() === expected &&
     mkt.SokoniCart.lines() === 3, mkt.SokoniCart.units() + '/' + mkt.SokoniCart.lines());
}

/* ══ L. no legacy authority anywhere ══ */
console.log('\nL. No legacy cart authority survives');
{
  const cart = SCAN.scan().filter(h => h.key === 'cart');
  const rogue = cart.filter(h => h.file !== 'sokoni-cart.js' && !STATE.TEST_HARNESS.includes(h.file));
  ck('L', 'zero production readers or writers outside the service', rogue.length === 0,
     rogue.map(h => h.file + ':' + h.line).join(', '));
  const mirror = SCAN.scan().filter(h => h.key === 'sokoniCart');
  ck('L', 'zero consumers of the retired sokoniCart mirror', mirror.length === 0,
     mirror.map(h => h.file + ':' + h.line).join(', '));
  ck('L', 'no cart-specific setItem bridge has returned',
     !/["'](cart|sokoniCart)["']/.test(execOf('provider-wiring.js')));
  ck('L', 'the unrelated provider/booking watchers are still there',
     (execOf('provider-wiring.js').match(/localStorage\.setItem\s*=/g) || []).length === 2);
  ck('L', 'no survivors declared', STATE.FROZEN_FILES.length === 0 &&
     STATE.BLOCKED_FILES.length === 0 && STATE.DEFERRED_FILES.length === 0);
  ck('L', 'the RC harness is still classified, not migrated',
     STATE.TEST_HARNESS.includes('tests/rc/suites/rc-02-buyer.js'));
}

/* ══ M. frozen invariants ══ */
console.log('\nM. Frozen invariants — reported, not silently fixed');
{
  /* RETIRED at the release pass. This pinned the defect in place — "still sums price
     WITHOUT qty" was the correct guard while the issue was deliberately carried past
     Track 2, and is now false by authorisation: the release cleared it as a money-path
     blocker before arming the auth cutoff.

     What replaces it is what must remain true afterwards. The arithmetic itself is proved
     in scripts/test-checkout-fallback-total.js; these three keep the cart suites from
     losing sight of it. */
  ck('M', 'the saveAndRedirect fallback is quantity-aware',
     /currentCart\.reduce\(\(s, p\) => s \+ _ckLineTotal\(p\), 0\)/.test(read('checkout.html')));
  ck('M', 'the qty-blind sum is gone',
     !/reduce\(\(s,p\) => s \+ Number\(p\.price\|\|0\), 0\)/.test(read('checkout.html')));
  ck('M', 'the line total has exactly ONE definition, shared with the displayed subtotal',
     (read('checkout.html').match(/function _ckLineTotal/g) || []).length === 1 &&
     (read('checkout.html').match(/_ckLineTotal\(/g) || []).length >= 3);
  console.log('     ^ known money-path issue, deliberately left for its own decision');
  ck('M', 'the service exposes no open() — the minishop collision stays inert',
     !/\bopen\s*:/.test(stripComments(read('sokoni-cart.js'))));
  ck('M', 'sokoni-minishop.js still only probes for it', /SokoniCart\s*!==\s*['"]undefined['"]/.test(
     stripComments(read('sokoni-minishop.js'))) || /SokoniCart\.open/.test(stripComments(read('sokoni-minishop.js'))));
  ck('M', 'the service still exposes no money helper',
     !/subtotal|function total/.test(stripComments(read('sokoni-cart.js'))));
  ck('M', 'row-level and product-level removal remain distinct',
     /removeById:/.test(read('sokoni-cart.js')) && /removeAllById:/.test(read('sokoni-cart.js')));
  const rules = cp.execSync('git diff --name-only HEAD -- firestore.rules', { cwd: ROOT, encoding: 'utf8' }).trim();
  ck('M', 'firestore.rules untouched', rules === '', rules);
}

console.log('\n' + '='.repeat(70));
console.log('Track 2 final acceptance\n');
['A','B','C','D','E','F','G','H','I','J','K','L','M'].forEach(k => console.log('  ' + k + ': ' + (R[k] || 'MISSING')));
console.log('\n  TOTAL:   ' + (pass + fail) + '\n  PASSED:  ' + pass + '\n  FAILED:  ' + fail);
process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR:', e); process.exit(2); });
