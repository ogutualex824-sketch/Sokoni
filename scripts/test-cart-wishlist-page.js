#!/usr/bin/env node
/* Track 2.3 surface 5 — wishlist.html's CART half on SokoniCart.
 *
 *   node scripts/test-cart-wishlist-page.js
 *
 * The wishlist half of this page was made canonical in Track 3; this is the cart half.
 * It is the surface where a failed cart write could DESTROY something: moveToCart wrote
 * the cart inside `try { … } catch(e){}`, swallowed any failure, then removed the item
 * from the wishlist and reported "Moved to cart 🛒". On a full quota the item was gone
 * from the wishlist, never in the cart, and the shopper was told it had moved.
 *
 * Block D is that case. It is the reason this surface got its own slice.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const { stripComments, keepOnly, htmlScriptRegions } = require('./scan-legacy-wishlist.js');
const SCAN = require('./scan-cart-writers.js');

const R = {};
let pass = 0, fail = 0;
function ck(g, l, ok, d) {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 92) + ']' : ''));
  ok ? pass++ : fail++;
  if (R[g] !== 'FAIL') R[g] = ok ? 'PASS' : 'FAIL';
}
const read = (f) => fs.readFileSync(path.resolve(ROOT, f), 'utf8');
const SRC = read('wishlist.html');
const EXEC = stripComments(keepOnly(SRC, htmlScriptRegions(SRC)));

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
const FNS = ['function updateCartBadge(', 'function moveToCart(', 'function buyNowWish(']
  .map(s => sliceFn(SRC, s)).join('\n');

const ITEM = { productId: 'w1', id: 'w1', name: 'Kiondo basket', price: 1800,
  image: 'k.png', shopId: 'shopA', category: 'Home' };

function page(opts) {
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
  g.window = g; g.store = store; g.els = els; g.notifs = [];
  g.location = { href: 'wishlist.html' };
  g.document = {
    getElementById: (id) => (els[id] = els[id] || { textContent: '', innerHTML: '', style: {} }),
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, remove() {} }),
    querySelector: () => null, querySelectorAll: () => [],
    body: { appendChild() {} }, head: { appendChild() {} }, addEventListener: () => {},
  };
  g.showNotif = (m, t) => g.notifs.push({ msg: m, type: t });
  g._wishData = [opts.item || JSON.parse(JSON.stringify(ITEM))];
  g._wishRender = () => { g.rendered = true; };
  g.removed = [];
  g.SokoniWishlist = opts.noWishlist ? null : {
    remove: (pid) => {
      g.removed.push(pid);
      return opts.failWishlistRemove ? Promise.reject(new Error('permission-denied'))
                                     : Promise.resolve(true);
    },
  };
  vm.createContext(g);
  if (!opts.withoutService) vm.runInContext(read('sokoni-cart.js'), g);
  vm.runInContext(FNS, g);
  return g;
}
const cartOf = (g) => JSON.parse(g.store.cart || '[]');
const said = (g, re) => g.notifs.some(n => re.test(n.msg));
const tick = () => new Promise(r => setTimeout(r, 20));

(async () => {
console.log('\nTRACK 2.3 · surface 5 — wishlist.html cart half\n' + '='.repeat(66));

/* ══ A. move to cart stores the item unchanged ══ */
console.log('\nA. Move to Cart stores the wishlist item, shape intact');
{
  const g = page();
  g.moveToCart(0);
  await tick();
  const c = cartOf(g);
  ck('A', 'one row', c.length === 1, c.length);
  Object.keys(ITEM).forEach(f => ck('A', 'preserves ' + f,
    JSON.stringify(c[0][f]) === JSON.stringify(ITEM[f]), JSON.stringify(c[0][f])));
  ck('A', 'no qty field invented — quantity model untouched', c[0].qty === undefined);
  ck('A', 'success only after the write', said(g, /Moved to cart/), JSON.stringify(g.notifs));
}

/* ══ B. and removes from the wishlist, in that order ══ */
console.log('\nB. The wishlist entry is cleared only after the cart write');
{
  const g = page();
  g.moveToCart(0);
  await tick();
  ck('B', 'the wishlist removal was requested', g.removed.length === 1 && g.removed[0] === 'w1',
     JSON.stringify(g.removed));
  ck('B', 'the list re-rendered', g.rendered === true);
}

/* ══ C. append semantics — existing cart untouched ══ */
console.log('\nC. Existing cart contents survive');
{
  const g = page({ seed: { cart: JSON.stringify([
    { id: 'other', name: 'Chai', price: 90, qty: 3 },
    { id: 'dup', price: 5 }, { id: 'dup', price: 5 },
  ]) } });
  g.moveToCart(0);
  await tick();
  const c = cartOf(g);
  ck('C', 'four rows', c.length === 4, c.length);
  ck('C', 'the qty-3 row is untouched', c[0].qty === 3, JSON.stringify(c[0]));
  ck('C', 'the duplicate pair is untouched', c[1].id === 'dup' && c[2].id === 'dup');
  ck('C', 'units counts 3+1+1+1', g.SokoniCart.units() === 6, g.SokoniCart.units());
}

/* ══ D. THE DESTRUCTION CASE ══
   Old behaviour: cart write inside `catch(e){}`, then remove from wishlist, then
   "Moved to cart 🛒". A quota failure lost the item entirely. */
console.log('\nD. A failed cart write must NOT destroy the wishlist item');
{
  const g = page({ failWrite: true });
  g.moveToCart(0);
  await tick();
  ck('D', 'nothing was written to the cart', !g.store.cart, String(g.store.cart));
  ck('D', 'the wishlist removal was NEVER requested — the item survives',
     g.removed.length === 0, JSON.stringify(g.removed));
  ck('D', 'no "Moved to cart" claim', !said(g, /Moved to cart/), JSON.stringify(g.notifs));
  ck('D', 'the shopper is told the item is still saved',
     said(g, /still in your wishlist/), JSON.stringify(g.notifs));
  ck('D', 'the list was not re-rendered as if something changed', g.rendered !== true);
}

/* ══ E. cart succeeded, wishlist removal failed — honest partial ══ */
console.log('\nE. Cart write succeeds, wishlist removal fails');
{
  const g = page({ failWishlistRemove: true });
  g.moveToCart(0);
  await tick();
  ck('E', 'the item IS in the cart', cartOf(g).length === 1, cartOf(g).length);
  ck('E', 'and the message says exactly that',
     said(g, /Added to cart, but couldn't clear it from your wishlist/), JSON.stringify(g.notifs));
  ck('E', 'no bare "Moved to cart" claim', !said(g, /^Moved to cart/), JSON.stringify(g.notifs));
}

/* ══ F. Buy Now — the fourth navigate-on-failure copy ══ */
console.log('\nF. Buy Now appends, navigates only on success, keeps the wishlist item');
{
  const ok = page({ seed: { cart: JSON.stringify([{ id: 'old', price: 1 }]) } });
  ok.buyNowWish(0);
  ck('F', 'appends rather than replacing', cartOf(ok).length === 2, cartOf(ok).length);
  ck('F', 'navigates on success', ok.location.href === 'checkout.html', ok.location.href);
  ck('F', 'Buy Now does NOT remove from the wishlist', ok.removed.length === 0,
     JSON.stringify(ok.removed));

  const bad = page({ seed: { cart: JSON.stringify([{ id: 'old', price: 1 }]) }, failWrite: true });
  const before = bad.location.href;
  const r = bad.buyNowWish(0);
  ck('F', 'a failed write returns false', r === false, String(r));
  ck('F', 'and does NOT navigate', bad.location.href === before, bad.location.href);
  ck('F', 'the previous cart is intact', cartOf(bad).length === 1 && cartOf(bad)[0].id === 'old',
     JSON.stringify(cartOf(bad)));
  ck('F', 'the shopper is told', said(bad, /Couldn't start checkout/), JSON.stringify(bad.notifs));
}

/* ══ G. badge counts units ══ */
console.log('\nG. The cart badge counts units (it already did)');
{
  const g = page({ seed: { cart: JSON.stringify([{ id: 'x', price: 5, qty: 4 }]) } });
  g.updateCartBadge();
  const headerFormula = cartOf(g).reduce((s, i) => s + (i.qty || 1), 0);
  ck('G', 'badge shows units', Number(g.els.cartBadge.textContent) === headerFormula,
     g.els.cartBadge.textContent + ' vs ' + headerFormula);
  ck('G', 'that is 4, not 1', Number(g.els.cartBadge.textContent) === 4, g.els.cartBadge.textContent);
}

/* ══ H. renders safely without the service ══ */
console.log('\nH. The page is safe when SokoniCart is unavailable');
{
  const g = page({ withoutService: true, seed: { cart: JSON.stringify([{ id: 'keep', price: 1 }]) } });
  g.updateCartBadge();
  ck('H', 'badge shows an em dash, never 0', g.els.cartBadge.textContent === '—',
     JSON.stringify(g.els.cartBadge.textContent));
  g.moveToCart(0);
  await tick();
  ck('H', 'moveToCart writes nothing', cartOf(g).length === 1 && cartOf(g)[0].id === 'keep',
     JSON.stringify(cartOf(g)));
  ck('H', 'and does NOT remove from the wishlist', g.removed.length === 0, JSON.stringify(g.removed));
  ck('H', 'buyNowWish does not navigate', g.buyNowWish(0) === false && g.location.href !== 'checkout.html',
     g.location.href);
  ck('H', 'the shopper is told the cart is loading', said(g, /still loading/), JSON.stringify(g.notifs));
}

/* ══ I. no legacy persistence; page scope through the constant-aware scanner ══ */
console.log('\nI. No direct cart persistence remains on this page');
{
  ck('I', 'no localStorage cart access in the inline scripts',
     !/localStorage\s*(?:\.\s*(?:get|set|remove)Item\s*\(\s*|\[\s*)["']cart["']/.test(EXEC));
  ck('I', 'no swallowed cart write remains',
     !/try\s*\{\s*localStorage\.setItem\(\s*["']cart["'][\s\S]{0,40}catch\s*\(\s*e\s*\)\s*\{\s*\}/.test(EXEC));
  ck('I', 'the page loads the service', /src="sokoni-cart\.js"/.test(SRC));
  ck('I', 'the Track 3 wishlist half is untouched', /SokoniWishlist/.test(EXEC));
  const { hits, files } = SCAN.pageScope('wishlist.html');
  const writers = hits.filter(h => h.key === 'cart' && h.kind === 'WRITE' && h.file !== 'sokoni-cart.js');
  ck('I', 'page scope covers the page and its local scripts', files.length > 20, files.length);
  ck('I', 'no other cart writer in page scope', writers.length === 0,
     writers.map(h => h.file + ':' + h.line).join(', '));
  const readers = hits.filter(h => h.key === 'cart' && h.kind === 'READ' && h.file !== 'sokoni-cart.js');
  ck('I', 'the only remaining reader is shared-header.js (2.3.7)',
     readers.length === 1 && readers[0].file === 'shared-header.js',
     readers.map(h => h.file).join(', '));
}

/* ══ J. perimeter ══ */
console.log('\nJ. Frozen, deferred and pending surfaces');
{
  const changed = cp.execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean);
  const STATE = require('./cart-migration-state.js');
  ck('J', 'nothing dirty the migration state does not explain',
     STATE.unexpected(changed).length === 0, STATE.unexpected(changed).join(', '));
  STATE.FROZEN.forEach(f => ck('J', f + ' FROZEN', !changed.includes(f)));
  STATE.DEFERRED.forEach(f => ck('J', f + ' DEFERRED to 2.5 — untouched', !changed.includes(f)));
  STATE.PENDING.forEach(f => ck('J', f + ' not migrated yet', !changed.includes(f)));
}

console.log('\n' + '='.repeat(66));
console.log('Track 2.3 surface 5 acceptance\n');
['A','B','C','D','E','F','G','H','I','J'].forEach(k => console.log('  ' + k + ': ' + (R[k] || 'MISSING')));
console.log('\n  TOTAL:   ' + (pass + fail) + '\n  PASSED:  ' + pass + '\n  FAILED:  ' + fail);
process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR:', e); process.exit(2); });
