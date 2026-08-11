#!/usr/bin/env node
/* Track 2.3 surface 2 — category.js on SokoniCart.
 *
 *   node scripts/test-cart-category.js
 *
 * Slices the shipped cart functions out of category.js and runs them against the real
 * service. Blocks E–H are the ones this slice exists for: category.js contained a SECOND
 * copy of the product.js Buy Now defect, plus one of its own — addToCart threw away the
 * save result and reported success regardless.
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
const SRC = read('category.js');

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
const FNS = ['function _cartSvc(', 'async function addToCart(', 'async function buyNowCat(']
  .map(s => sliceFn(SRC, s)).join('\n');

const PRODUCT = { id: 'c1', name: 'Kikoi', price: 1200, image: 'k.png', category: 'Fashion',
  sellerUid: 'seller-B', sellerName: 'Duka B', sellerLat: -1.3, sellerLng: 36.8, stock: 12 };

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
  g.location = { href: 'category.html?cat=fashion' };
  g.showNotif = (m, t) => { g.notifs.push({ msg: m, type: t }); };
  g.allProducts = [opts.product || PRODUCT];
  g.updateCartCount = () => {};
  g.isAdultCategory = () => false;
  vm.createContext(g);
  if (!opts.withoutService) vm.runInContext(read('sokoni-cart.js'), g);
  vm.runInContext(FNS, g);
  return g;
}
const cartOf = (g) => JSON.parse(g.store.cart || '[]');
const said = (g, re) => g.notifs.some(n => re.test(n.msg));

(async () => {
console.log('\nTRACK 2.3 · surface 2 — category.js on SokoniCart\n' + '='.repeat(66));

/* ══ A. item shape preserved ══ */
console.log('\nA. The stored item is the product object, unchanged');
{
  const g = page();
  await g.addToCart('c1');
  const c = cartOf(g);
  ck('A', 'one row', c.length === 1, c.length);
  Object.keys(PRODUCT).forEach(f => ck('A', 'preserves ' + f,
    JSON.stringify(c[0][f]) === JSON.stringify(PRODUCT[f]), JSON.stringify(c[0][f])));
  ck('A', 'no qty field invented', c[0].qty === undefined);
  ck('A', 'success toast shown', said(g, /Added to cart/), JSON.stringify(g.notifs));
}

/* ══ B. duplicate add stays a no-op ══ */
console.log('\nB. Adding the same product twice is still a no-op');
{
  const g = page();
  await g.addToCart('c1');
  await g.addToCart('c1');
  ck('B', 'still one row — category semantics preserved', cartOf(g).length === 1, cartOf(g).length);
  ck('B', 'told it is already in the cart', said(g, /Already in cart/), JSON.stringify(g.notifs));
}

/* ══ C. appends alongside other items and other quantity models ══ */
console.log('\nC. Existing cart contents are untouched');
{
  const g = page({ seed: { cart: JSON.stringify([
    { id: 'other', name: 'Chai', price: 90, qty: 3 },
    { id: 'dup', name: 'Sukari', price: 50 }, { id: 'dup', name: 'Sukari', price: 50 },
  ]) } });
  await g.addToCart('c1');
  const c = cartOf(g);
  ck('C', 'four rows', c.length === 4, c.length);
  ck('C', 'the qty-3 row is untouched', c[0].qty === 3, JSON.stringify(c[0]));
  ck('C', 'the duplicate-row pair is untouched', c[1].id === 'dup' && c[2].id === 'dup');
  ck('C', 'units counts 3 + 1 + 1 + 1', g.SokoniCart.units() === 6, g.SokoniCart.units());
}

/* ══ D. Buy Now replaces ══ */
console.log('\nD. Buy Now replaces the cart, then navigates');
{
  const g = page({ seed: { cart: JSON.stringify([{ id: 'stale', name: 'Old', price: 999 }]) } });
  await g.buyNowCat('c1');
  const c = cartOf(g);
  ck('D', 'stale item gone', !c.some(i => i.id === 'stale'), JSON.stringify(c.map(i => i.id)));
  ck('D', 'only this product', c.length === 1 && c[0].id === 'c1', JSON.stringify(c.map(i => i.id)));
  ck('D', 'navigated to checkout', g.location.href === 'checkout.html', g.location.href);
}

/* ══ E. one write, never an intermediate empty cart ══ */
console.log('\nE. Buy Now is a single write');
{
  const g = page({ seed: { cart: JSON.stringify([{ id: 'stale', name: 'Old', price: 999 }]) } });
  const seen = [];
  const real = g.localStorage.setItem;
  g.localStorage.setItem = function (k, v) { if (k === 'cart') seen.push(JSON.parse(v).length); return real.call(this, k, v); };
  await g.buyNowCat('c1');
  g.localStorage.setItem = real;
  ck('E', 'exactly one cart write', seen.length === 1, JSON.stringify(seen));
  ck('E', 'no empty state persisted', !seen.includes(0), JSON.stringify(seen));
}

/* ══ F. THE DEFECT THIS SLICE FOUND — success was reported without a write ══
   _saveCatCart returned false on failure and addToCart discarded the answer, showing
   "Added to cart 🛒" regardless. A full quota told the shopper their item was saved when
   nothing had been written. */
console.log('\nF. A failed add is reported — no success toast without a write');
{
  const g = page({ failWrite: true });
  await g.addToCart('c1');
  ck('F', 'nothing was stored', !g.store.cart, String(g.store.cart));
  ck('F', 'NO "Added to cart" toast', !said(g, /Added to cart/), JSON.stringify(g.notifs));
  ck('F', 'the failure was surfaced', said(g, /Couldn't add to cart/), JSON.stringify(g.notifs));
}

/* ══ G. a failed Buy Now must not navigate or destroy the cart ══ */
console.log('\nG. A failed Buy Now keeps the shopper — and their cart — where they were');
{
  const g = page({ seed: { cart: JSON.stringify([{ id: 'stale', name: 'Old', price: 999 }]) }, failWrite: true });
  const before = g.location.href;
  await g.buyNowCat('c1');
  ck('G', 'did NOT navigate', g.location.href === before, g.location.href);
  ck('G', 'the existing cart is intact', cartOf(g).length === 1 && cartOf(g)[0].id === 'stale',
     JSON.stringify(cartOf(g)));
  ck('G', 'the shopper was told', said(g, /Couldn't start checkout/), JSON.stringify(g.notifs));
}

/* ══ H. no service → fail closed ══ */
console.log('\nH. Without SokoniCart both actions fail closed');
{
  const g = page({ withoutService: true, seed: { cart: JSON.stringify([{ id: 'keep', price: 1 }]) } });
  await g.addToCart('c1');
  await g.buyNowCat('c1');
  ck('H', 'no legacy write happened', cartOf(g).length === 1 && cartOf(g)[0].id === 'keep',
     JSON.stringify(cartOf(g)));
  ck('H', 'no navigation', g.location.href !== 'checkout.html', g.location.href);
  ck('H', 'no success toast', !said(g, /Added to cart/), JSON.stringify(g.notifs));
  ck('H', 'told the cart is loading', said(g, /still loading/), JSON.stringify(g.notifs));
}

/* ══ I. the pip counts units, and says nothing when it cannot count ══ */
console.log('\nI. #catCartCount counts units, never a guess');
{
  const code = stripComments(SRC);
  ck('I', 'reads units(), not array length', /SokoniCart[\s\S]{0,80}units\(\)/.test(code) || /c\.units\(\)/.test(code));
  ck('I', 'no array-length cart count remains', !/getItem\("cart"\)[\s\S]{0,120}\.length/.test(code));
  ck('I', 'renders an em dash rather than 0 when the service is absent', /"—"/.test(code));
  ck('I', 'subscribes to sokoni:cart-changed', /addEventListener\("sokoni:cart-changed"/.test(code));
}

/* ══ J. no legacy persistence left ══ */
console.log('\nJ. category.js no longer persists the cart itself');
{
  const code = stripComments(SRC);
  ck('J', 'no localStorage cart access',
     !/localStorage\s*(?:\.\s*(?:get|set|remove)Item\s*\(\s*|\[\s*)["']cart["']/.test(code));
  ck('J', 'the private _saveCatCart is gone', !/_saveCatCart/.test(code));
  ck('J', 'no fallback to sokoniCart or another store',
     !/localStorage\s*(?:\.\s*\w+Item\s*\(\s*|\[\s*)["'](sokoniCart|retrievedCart)["']/.test(code));
  ck('J', 'reaches the cart only through the service', /window\.SokoniCart/.test(code));
  ck('J', 'category.html loads the service before category.js', (function () {
    const h = read('category.html');
    return h.indexOf('sokoni-cart.js') > -1 && h.indexOf('sokoni-cart.js') < h.indexOf('src="category.js"');
  })());
}

/* ══ K. perimeter ══ */
console.log('\nK. Frozen perimeter and unmigrated surfaces');
{
  const changed = cp.execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean);
  const STATE = require('./cart-migration-state.js');
  ck('K', 'nothing dirty the migration state does not explain',
     STATE.unexpected(changed).length === 0, STATE.unexpected(changed).join(', '));
  STATE.FROZEN.concat(STATE.PENDING)
    .forEach(f => ck('K', f + ' untouched', !changed.includes(f), changed.join(', ')));
  ck('K', 'the RC harness is classified, not an unexplained survivor',
     STATE.TEST_HARNESS.includes('tests/rc/suites/rc-02-buyer.js'));
}

console.log('\n' + '='.repeat(66));
console.log('Track 2.3 surface 2 acceptance\n');
['A','B','C','D','E','F','G','H','I','J','K'].forEach(k => console.log('  ' + k + ': ' + (R[k] || 'MISSING')));
console.log('\n  TOTAL:   ' + (pass + fail) + '\n  PASSED:  ' + pass + '\n  FAILED:  ' + fail);
process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR:', e); process.exit(2); });
