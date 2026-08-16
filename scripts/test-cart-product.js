#!/usr/bin/env node
/* Track 2.3 surface 1 — product.js on SokoniCart.
 *
 *   node scripts/test-cart-product.js
 *
 * product.js is not a module and expects page globals (product, quantity, DOM), so the
 * two cart functions are sliced out of the SHIPPED file and evaluated with the real
 * service. They are the real function bodies, not transcriptions — an edit to either one
 * changes what this suite runs.
 *
 * Buy Now is the reason this surface is first after market-actions: it REPLACES the cart
 * and then navigates to checkout. Both halves are correctness-critical.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const { stripComments } = require('./scan-legacy-wishlist.js');

const R = {};
let pass = 0, fail = 0;
function ck(g, l, ok, d) {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 95) + ']' : ''));
  ok ? pass++ : fail++;
  if (R[g] !== 'FAIL') R[g] = ok ? 'PASS' : 'FAIL';
}
const read = (f) => fs.readFileSync(path.resolve(ROOT, f), 'utf8');

/* ── slice the shipped functions ── */
function sliceFn(src, sig) {
  const bare = stripComments(src);
  const start = bare.indexOf(sig);
  if (start === -1) throw new Error('not found: ' + sig);
  /* Refuse a match that begins mid-declaration. `function addToCart(` matches inside
     `async function addToCart(`, and slicing from there drops the `async` — producing a
     function that parses differently from the one that ships. Fail loudly instead: the
     caller's signature is simply out of date and must say `async`. */
  if (!sig.startsWith('async ') && /\basync\s+$/.test(bare.slice(Math.max(0, start - 12), start))) {
    throw new Error('signature omits `async` for: ' + sig);
  }
  let i = bare.indexOf('{', start), depth = 0;
  for (; i < bare.length; i++) {
    if (bare[i] === '{') depth++;
    else if (bare[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced: ' + sig);
}
const SRC = read('product.js');
/* Two separate breakages, and the second is the dangerous one.

   1. f8c5b5a/17eef7a put _ageGuard (and _explicitlyAgeRestricted behind it) in front of the
      add path. Both must be in the bundle or the slice cannot resolve them.

   2. addToCart and buyNowProduct became `async function`. The old signatures said
      `function addToCart(`, which still MATCHES — as a substring starting six characters
      into `async function addToCart(`. sliceFn therefore began the slice after `async`,
      silently stripping the keyword, and `await _ageGuard()` inside the now-synchronous
      function was a SyntaxError. A slice that quietly changes what it extracted is worse
      than one that fails to find it; sliceFn now refuses that case outright. */
const FNS = ['function _cartSvc(', 'function _cartItem(',
             'function _explicitlyAgeRestricted(', 'async function _ageGuard(',
             'async function addToCart(', 'async function buyNowProduct(']
  .map(sig => sliceFn(SRC, sig)).join('\n');

const PRODUCT = {
  id: 'pr1', name: 'Unga 2kg', price: 250, image: 'u.png', category: 'Food',
  sellerUid: 'seller-A', sellerId: 'seller-A', sellerName: 'Duka A',
  sellerLat: -1.29, sellerLng: 36.82, stock: 40, isDigital: false,
};

function page(opts) {
  opts = opts || {};
  const store = Object.assign({}, opts.seed || {});
  const listeners = {};
  const g = {
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { if (opts.failWrite) throw new Error('QuotaExceededError'); store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener: () => {},
    dispatchEvent: e => { (listeners[e.type] || []).forEach(f => { try { f(e); } catch (_) {} }); return true; },
    CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
    setTimeout, clearTimeout, console,
    JSON, Date, Math, String, Number, Object, Array, Promise, Error, Set, RegExp, isNaN, parseInt, parseFloat,
  };
  g.window = g;
  g.store = store;
  g.notifs = [];
  g.location = { href: 'product.html?id=pr1' };
  g._showProductNotif = (m, t) => { g.notifs.push({ msg: m, type: t }); };
  g.product = opts.product || PRODUCT;
  g.quantity = opts.quantity == null ? 1 : opts.quantity;
  g._selectedSize = opts.size || null;
  g._selectedColor = opts.color || null;
  g._selectedVariants = opts.variants || {};
  vm.createContext(g);
  if (!opts.withoutService) vm.runInContext(read('sokoni-cart.js'), g);
  vm.runInContext(FNS, g);
  return g;
}
const cartOf = (g) => JSON.parse(g.store.cart || '[]');

console.log('\nTRACK 2.3 · surface 1 — product.js on SokoniCart\n' + '='.repeat(66));

/* The add/buy entry points are async since the canonical 18+ gate landed in front of them,
   so every call site below has to await. Left synchronous, the store was read one microtask
   too early and reported an empty cart — and `fn() === false` compared a Promise object
   against false, which is never true, so the fail-closed assertions would have PASSED for
   the wrong reason. That is the more dangerous half: a suite reporting green while asserting
   nothing. The body is therefore an async IIFE. */
;(async () => {

/* ══ A. add preserves the whole product object ══ */
console.log('\nA. The item shape is the product object, unchanged');
{
  const g = page({ size: '2kg', variants: { pack: 'single' } });
  await g.addToCart();
  const c = cartOf(g);
  ck('A', 'one row for quantity 1', c.length === 1, c.length);
  Object.keys(PRODUCT).forEach(f => ck('A', 'preserves ' + f,
    JSON.stringify(c[0][f]) === JSON.stringify(PRODUCT[f]), JSON.stringify(c[0][f])));
  ck('A', 'selectedSize captured', c[0].selectedSize === '2kg', c[0].selectedSize);
  ck('A', 'selectedVariants captured',
     JSON.stringify(c[0].selectedVariants) === JSON.stringify({ pack: 'single' }),
     JSON.stringify(c[0].selectedVariants));
  ck('A', 'no qty field invented', c[0].qty === undefined);
  ck('A', 'success notification shown', /added to cart/i.test((g.notifs[0] || {}).msg || ''),
     JSON.stringify(g.notifs));
}

/* ══ B. duplicate-row quantity preserved ══ */
console.log('\nB. Quantity is still N duplicate rows');
{
  const g = page({ quantity: 3 });
  await g.addToCart();
  const c = cartOf(g);
  ck('B', 'three rows', c.length === 3, c.length);
  ck('B', 'none carries a qty field', c.every(i => i.qty === undefined));
  ck('B', 'server price check totals 750',
     c.reduce((s, i) => s + 250 * Math.max(1, Number(i.qty) || 1), 0) === 750);
  ck('B', 'units() counts 3', g.SokoniCart.units() === 3, g.SokoniCart.units());
  /* The rows must be independent copies — this pushed one reference N times before. */
  g.SokoniCart.setQty(0, 9);
  const after = cartOf(g);
  ck('B', 'editing row 0 does not change rows 1 and 2',
     after[1].qty === undefined && after[2].qty === undefined,
     JSON.stringify(after.map(i => i.qty)));
}

/* ══ C. add APPENDS to an existing cart ══ */
console.log('\nC. Add to Cart appends, it does not replace');
{
  const g = page({ seed: { cart: JSON.stringify([{ id: 'old', name: 'Chai', price: 90 }]) }, quantity: 2 });
  await g.addToCart();
  const c = cartOf(g);
  ck('C', 'the existing item survives', c.some(i => i.id === 'old'), JSON.stringify(c.map(i => i.id)));
  ck('C', 'three rows total', c.length === 3, c.length);
}

/* ══ D. Buy Now REPLACES ══ */
console.log('\nD. Buy Now replaces the cart — express checkout for this item only');
{
  const g = page({ seed: { cart: JSON.stringify([{ id: 'stale', name: 'Old', price: 999 }]) }, quantity: 2 });
  await g.buyNowProduct();
  const c = cartOf(g);
  ck('D', 'the stale item is gone', !c.some(i => i.id === 'stale'), JSON.stringify(c.map(i => i.id)));
  ck('D', 'only this product remains', c.every(i => i.id === 'pr1'), JSON.stringify(c.map(i => i.id)));
  ck('D', 'quantity honoured — two rows', c.length === 2, c.length);
  ck('D', 'navigates to checkout', g.location.href === 'checkout.html', g.location.href);
}

/* ══ E. replace is ONE write — never empty-then-fill ══ */
console.log('\nE. Buy Now never leaves the cart momentarily empty');
{
  const g = page({ seed: { cart: JSON.stringify([{ id: 'stale', name: 'Old', price: 999 }]) } });
  const seen = [];
  const real = g.localStorage.setItem;
  g.localStorage.setItem = function (k, v) { if (k === 'cart') seen.push(JSON.parse(v).length); return real.call(this, k, v); };
  await g.buyNowProduct();
  g.localStorage.setItem = real;
  ck('E', 'exactly one cart write', seen.length === 1, JSON.stringify(seen));
  ck('E', 'no intermediate empty state was persisted', !seen.includes(0), JSON.stringify(seen));
}

/* ══ F. failure must not navigate ══
   The old code wrote and navigated unconditionally. A storage failure would have sent the
   shopper to checkout with the PREVIOUS cart still loaded — express-checkout for an item
   they did not choose, at a total they never saw. */
console.log('\nF. A failed write does not send the shopper to checkout');
{
  const g = page({ seed: { cart: JSON.stringify([{ id: 'stale', name: 'Old', price: 999 }]) }, failWrite: true });
  const before = g.location.href;
  const ok = await g.buyNowProduct();
  ck('F', 'buyNowProduct reports failure', ok === false, String(ok));
  ck('F', 'did NOT navigate', g.location.href === before, g.location.href);
  ck('F', 'the previous cart is untouched', cartOf(g)[0].id === 'stale', JSON.stringify(cartOf(g)));
  ck('F', 'the shopper was told', /Couldn't start checkout/.test((g.notifs[0] || {}).msg || ''),
     JSON.stringify(g.notifs));
}

/* ══ G. add failure is reported, not swallowed ══ */
console.log('\nG. A failed add is reported');
{
  const g = page({ failWrite: true });
  const ok = await g.addToCart();
  ck('G', 'addToCart reports failure', ok === false, String(ok));
  ck('G', 'nothing stored', !g.store.cart, String(g.store.cart));
  ck('G', 'no success notification', !g.notifs.some(n => /added to cart/i.test(n.msg)),
     JSON.stringify(g.notifs));
  ck('G', 'the failure was surfaced', /Couldn't add/.test((g.notifs[0] || {}).msg || ''),
     JSON.stringify(g.notifs));
}

/* ══ H. no service → fail closed, no legacy fallback ══ */
console.log('\nH. Without SokoniCart both buttons fail closed');
{
  const g = page({ withoutService: true });
  ck('H', 'addToCart returns false', await g.addToCart() === false);
  ck('H', 'buyNowProduct returns false', await g.buyNowProduct() === false);
  ck('H', 'nothing was written to localStorage', !g.store.cart, String(g.store.cart));
  ck('H', 'no navigation happened', g.location.href !== 'checkout.html', g.location.href);
  ck('H', 'the shopper was told the cart is loading',
     g.notifs.every(n => /still loading/i.test(n.msg)), JSON.stringify(g.notifs));
}

/* ══ I. no legacy persistence left in the file ══ */
console.log('\nI. product.js no longer persists the cart itself');
{
  const code = stripComments(SRC);
  ck('I', 'no localStorage cart access',
     !/localStorage\s*(?:\.\s*(?:get|set|remove)Item\s*\(\s*|\[\s*)["']cart["']/.test(code));
  ck('I', 'never falls back to sokoniCart or another store',
     !/localStorage\s*(?:\.\s*\w+Item\s*\(\s*|\[\s*)["'](sokoniCart|retrievedCart)["']/.test(code));
  ck('I', 'reaches the cart only through the service', /window\.SokoniCart/.test(code));
  ck('I', 'product.html loads the service before product.js', (function () {
    const h = read('product.html');
    return h.indexOf('sokoni-cart.js') > -1 && h.indexOf('sokoni-cart.js') < h.indexOf('src="product.js"');
  })());
}

/* ══ J. perimeter ══ */
console.log('\nJ. Frozen perimeter and unmigrated surfaces');
{
  const changed = cp.execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean);
  const STATE = require('./cart-migration-state.js');
  ck('J', 'nothing dirty that the migration state does not explain',
     STATE.unexpected(changed).length === 0, STATE.unexpected(changed).join(', '));
  STATE.FROZEN_FILES.concat(STATE.PENDING)
    .forEach(f => ck('J', f + ' untouched', !changed.includes(f), changed.join(', ')));
  ck('J', 'no page gained mixed line endings', (function () {
    const s = read('product.html');
    return !((s.match(/\r\n/g) || []).length > 0 && (s.match(/(?<!\r)\n/g) || []).length > 0);
  })());
}

})().then(() => {
console.log('\n' + '='.repeat(66));
console.log('Track 2.3 surface 1 acceptance\n');
['A','B','C','D','E','F','G','H','I','J'].forEach(k => console.log('  ' + k + ': ' + (R[k] || 'MISSING')));
console.log('\n  TOTAL:   ' + (pass + fail) + '\n  PASSED:  ' + pass + '\n  FAILED:  ' + fail);
process.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
