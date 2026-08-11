#!/usr/bin/env node
/* Track 2.3 surface 3 — script.js (marketplace / home) on SokoniCart.
 *
 *   node scripts/test-cart-marketplace.js
 *
 * script.js held the cart as a MODULE-LEVEL SNAPSHOT — `let cart = JSON.parse(...)` read
 * once at load. That is the defect this surface is really about: the homepage became its
 * own cart authority, so anything added elsewhere was invisible until reload and the next
 * mutation here wrote the stale array back over it. Block C is the one that proves it.
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
const SRC = read('script.js');

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
const FNS = [
  'function _cartSvc(', 'function _syncCart(',
  'async function buyProduct(', 'async function buyNow(',
  'function updateCart(', 'function removeFromCart(', 'function checkAbandonedCart(',
].map(s => sliceFn(SRC, s)).join('\n');

const P = { id: 's1', name: 'Sufuria', price: 800, image: 's.png', category: 'Home',
  sellerUid: 'seller-C', sellerName: 'Duka C', stock: 5 };

function mkEl() {
  return { innerText: '', innerHTML: '', textContent: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} }, offsetWidth: 0,
    addEventListener() {}, appendChild(c) { return c; }, setAttribute() {},
    getAttribute() { return null; }, remove() {}, querySelector: () => null,
    querySelectorAll: () => [] };
}

function home(opts) {
  opts = opts || {};
  const store = Object.assign({}, opts.seed || {});
  const listeners = {};
  const els = {};
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
  g.els = els;
  g.notifs = [];
  g.location = { href: 'index.html' };
  g.document = {
    getElementById: (id) => {
      if (opts.noCartDom && (id === 'cartItems')) return null;
      if (!els[id]) els[id] = mkEl();
      return els[id];
    },
    createElement: mkEl, body: mkEl(), head: mkEl(),
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
  };
  g.showNotification = (m, t) => { g.notifs.push({ msg: m, type: t }); };
  g.showPushToast = () => {};
  /* Deep-cloned per page. buyProduct increments selectedProduct.views AFTER adding, and
     `products` holds the very object the assertions compare against — a shared fixture
     would be mutated by the code under test and the comparison would drift. */
  g.products = [JSON.parse(JSON.stringify(opts.product || P))];
  g.filteredProducts = g.products;
  g.displayProducts = () => {};
  g.flyToCart = () => {};
  g.saveHomeScroll = () => {};
  g.isAdultCategory = () => false;
  g.sokoniTrackAddToCart = () => {};
  vm.createContext(g);
  if (!opts.withoutService) vm.runInContext(read('sokoni-cart.js'), g);
  vm.runInContext(FNS, g);
  return g;
}
const cartOf = (g) => JSON.parse(g.store.cart || '[]');
const said = (g, re) => g.notifs.some(n => re.test(n.msg));

(async () => {
console.log('\nTRACK 2.3 · surface 3 — script.js on SokoniCart\n' + '='.repeat(66));

/* ══ A. add persists the product object unchanged ══ */
console.log('\nA. buyProduct stores the product object, unchanged');
{
  const g = home();
  await g.buyProduct('s1');
  const c = cartOf(g);
  ck('A', 'one row', c.length === 1, c.length);
  Object.keys(P).forEach(f => ck('A', 'preserves ' + f,
    JSON.stringify(c[0][f]) === JSON.stringify(P[f]), JSON.stringify(c[0][f])));
  ck('A', 'success toast shown', said(g, /Added To Cart/), JSON.stringify(g.notifs));
}

/* ══ B. duplicate adds append — homepage semantics, unchanged ══ */
console.log('\nB. Repeat add appends (this surface has never de-duplicated)');
{
  const g = home();
  await g.buyProduct('s1');
  await g.buyProduct('s1');
  ck('B', 'two rows', cartOf(g).length === 2, cartOf(g).length);
  ck('B', 'no qty field invented', cartOf(g).every(i => i.qty === undefined));
}

/* ══ C. THE SNAPSHOT DEFECT — a write made elsewhere is no longer clobbered ══
   `let cart = JSON.parse(localStorage.getItem("cart"))` ran once at load. An item added
   by another surface after that point was invisible here, and the next add wrote this
   page's stale array straight over it. */
console.log('\nC. A cart change made elsewhere is neither missed nor overwritten');
{
  const g = home();
  await g.buyProduct('s1');                              /* homepage adds one */
  g.SokoniCart.add({ id: 'elsewhere', name: 'Chai', price: 90 });   /* another surface adds */
  await g.buyProduct('s1');                              /* homepage adds again */
  const c = cartOf(g);
  ck('C', 'the other surface\'s item survived', c.some(i => i.id === 'elsewhere'),
     JSON.stringify(c.map(i => i.id)));
  ck('C', 'three rows total — nothing was clobbered', c.length === 3, c.length);
  g.updateCart();
  ck('C', 'the render projection sees all three', g.els.cartCount.innerText === 3,
     g.els.cartCount.innerText);
}

/* ══ D. badges count units ══ */
console.log('\nD. Both indicators count units, matching the header pip');
{
  const g = home({ seed: { cart: JSON.stringify([{ id: 'q', name: 'S', price: 10, qty: 4 }]) } });
  g.updateCart();
  const headerFormula = cartOf(g).reduce((s, i) => s + (i.qty || 1), 0);
  ck('D', '#cartCount shows units', g.els.cartCount.innerText === headerFormula,
     g.els.cartCount.innerText + ' vs ' + headerFormula);
  ck('D', '#cartCountBadge shows units', g.els.cartCountBadge.innerText === headerFormula,
     g.els.cartCountBadge.innerText);
  ck('D', 'that is 4, not the 1 array length would have given', g.els.cartCount.innerText === 4,
     g.els.cartCount.innerText);
}

/* ══ E. remove takes exactly one row ══ */
console.log('\nE. removeFromCart drops one line, not the whole product');
{
  const g = home({ seed: { cart: JSON.stringify([
    { id: 'd', name: 'X', price: 5 }, { id: 'd', name: 'X', price: 5 }, { id: 'k', name: 'Keep', price: 7 },
  ]) } });
  g.removeFromCart(0);
  const c = cartOf(g);
  ck('E', 'two rows left', c.length === 2, c.length);
  ck('E', 'one duplicate survives — units were not wiped', c.filter(i => i.id === 'd').length === 1,
     JSON.stringify(c.map(i => i.id)));
  ck('E', 'the unrelated row is untouched', c.some(i => i.id === 'k'));
}

/* ══ F. persistence no longer depends on the DOM ══
   updateCart() used to save on its LAST line, below an early return taken when #cartItems
   is absent. Deleting a hidden <ul> would have silently stopped every add persisting. */
console.log('\nF. A missing #cartItems no longer stops the cart persisting');
{
  const g = home({ noCartDom: true });
  await g.buyProduct('s1');
  ck('F', 'the item persisted even with no cart DOM', cartOf(g).length === 1, cartOf(g).length);
  ck('F', 'and the success toast is truthful', said(g, /Added To Cart/), JSON.stringify(g.notifs));
}

/* ══ G. failure paths ══ */
console.log('\nG. A failed write is reported and nothing is claimed');
{
  const g = home({ failWrite: true });
  await g.buyProduct('s1');
  ck('G', 'nothing stored', !g.store.cart, String(g.store.cart));
  ck('G', 'NO "Added To Cart" toast', !said(g, /Added To Cart/), JSON.stringify(g.notifs));
  ck('G', 'the failure was surfaced', said(g, /Couldn't add to cart/), JSON.stringify(g.notifs));
}

/* ══ H. buyNow must not navigate on a failed write ══ */
console.log('\nH. buyNow does not send the shopper to checkout without the item');
{
  const g = home({ seed: { cart: JSON.stringify([{ id: 'old', price: 1 }]) }, failWrite: true });
  const before = g.location.href;
  await g.buyNow('s1');
  ck('H', 'did NOT navigate', g.location.href === before, g.location.href);
  ck('H', 'no "Proceeding To Checkout" toast', !said(g, /Proceeding To Checkout/),
     JSON.stringify(g.notifs));
  ck('H', 'the existing cart is intact', cartOf(g).length === 1 && cartOf(g)[0].id === 'old',
     JSON.stringify(cartOf(g)));
  ck('H', 'the shopper was told', said(g, /Couldn't start checkout/), JSON.stringify(g.notifs));
}

/* ══ I. buyNow still APPENDS — this surface never replaced ══ */
console.log('\nI. buyNow appends and navigates (unlike Product Detail / Category)');
{
  const g = home({ seed: { cart: JSON.stringify([{ id: 'old', name: 'Old', price: 1 }]) } });
  await g.buyNow('s1');
  const c = cartOf(g);
  ck('I', 'the existing item is still there — no replace', c.some(i => i.id === 'old'),
     JSON.stringify(c.map(i => i.id)));
  ck('I', 'the new item was appended', c.some(i => i.id === 's1'), JSON.stringify(c.map(i => i.id)));
  ck('I', 'navigated to checkout', g.location.href === 'checkout.html', g.location.href);
}

/* ══ J. no service → fail closed ══ */
console.log('\nJ. Without SokoniCart every path fails closed');
{
  const g = home({ withoutService: true, seed: { cart: JSON.stringify([{ id: 'keep', price: 1 }]) } });
  await g.buyProduct('s1');
  await g.buyNow('s1');
  g.removeFromCart(0);
  ck('J', 'no legacy write happened', cartOf(g).length === 1 && cartOf(g)[0].id === 'keep',
     JSON.stringify(cartOf(g)));
  ck('J', 'no navigation', g.location.href !== 'checkout.html', g.location.href);
  ck('J', 'no success toast', !said(g, /Added To Cart|Proceeding To Checkout/), JSON.stringify(g.notifs));
  g.updateCart();
  ck('J', 'the badge shows an em dash, not 0', g.els.cartCount.innerText === '—',
     String(g.els.cartCount.innerText));
  ck('J', 'the abandoned-cart reminder makes no claim', (function () {
    g.checkAbandonedCart(); return true;    /* must simply return, never throw or assert */
  })());
}

/* ══ K. no legacy persistence left, and page scope is clean ══ */
console.log('\nK. script.js and index.html leave no second persistence path');
{
  const code = stripComments(SRC);
  ck('K', 'no localStorage cart access in script.js',
     !/localStorage\s*(?:\.\s*(?:get|set|remove)Item\s*\(\s*|\[\s*)["']cart["']/.test(code));
  ck('K', 'the module-level snapshot is gone',
     !/let\s+cart\s*=\s*JSON\.parse/.test(code));
  ck('K', '_persistCart / _emitCartChanged removed',
     !/function\s+_persistCart|function\s+_emitCartChanged/.test(code));
  ck('K', 'no fallback to sokoniCart',
     !/localStorage\s*(?:\.\s*\w+Item\s*\(\s*|\[\s*)["'](sokoniCart|retrievedCart)["']/.test(code));
  ck('K', 'index.html loads the service before script.js', (function () {
    const h = read('index.html');
    return h.indexOf('sokoni-cart.js') > -1 && h.indexOf('sokoni-cart.js') < h.indexOf('src="script.js"');
  })());
  /* Page scope: of everything index.html statically loads, which still touches the cart
     directly? shared-header.js is a READER, scheduled for 2.3.7. There must be no other
     WRITER — provider-wiring.js is injected dynamically and is frozen until 2.6. */
  const html = read('index.html');
  const srcs = [...html.matchAll(/src="([a-z0-9-]+\.js)"/g)].map(m => m[1]);
  const writers = srcs.filter(f => {
    if (!fs.existsSync(path.resolve(ROOT, f))) return false;
    const s = stripComments(read(f));
    return /localStorage\s*\.\s*setItem\s*\(\s*["'](cart|sokoniCart)["']/.test(s);
  });
  ck('K', 'no statically-loaded script on index.html still WRITES the cart',
     writers.length === 0, writers.join(', '));
  const readers = srcs.filter(f => {
    if (!fs.existsSync(path.resolve(ROOT, f))) return false;
    const s = stripComments(read(f));
    return /localStorage\s*(?:\.\s*getItem\s*\(\s*|\[\s*)["'](cart|sokoniCart)["']/.test(s);
  });
  /* Was "the only remaining direct reader is shared-header.js". 2.6 migrated it, so the
     page now has no direct cart reader at all besides the service. */
  ck('K', 'no direct cart reader remains on this page', readers.length === 0, readers.join(', '));
}

/* ══ L. perimeter ══ */
console.log('\nL. Frozen perimeter and unmigrated surfaces');
{
  const changed = cp.execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean);
  const STATE = require('./cart-migration-state.js');
  ck('L', 'nothing dirty the migration state does not explain',
     STATE.unexpected(changed).length === 0, STATE.unexpected(changed).join(', '));
  STATE.FROZEN_FILES.concat(STATE.PENDING)
    .forEach(f => ck('L', f + ' untouched', !changed.includes(f), changed.join(', ')));
}

console.log('\n' + '='.repeat(66));
console.log('Track 2.3 surface 3 acceptance\n');
['A','B','C','D','E','F','G','H','I','J','K','L'].forEach(k => console.log('  ' + k + ': ' + (R[k] || 'MISSING')));
console.log('\n  TOTAL:   ' + (pass + fail) + '\n  PASSED:  ' + pass + '\n  FAILED:  ' + fail);
process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR:', e); process.exit(2); });
