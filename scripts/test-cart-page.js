#!/usr/bin/env node
/* Track 2.3 surface 6 — cart.js, the cart page itself. The last write surface.
 *
 *   node scripts/test-cart-page.js
 *
 * cart.js owned _readCart and _saveCartState — the last of the thirteen copies of that
 * read/modify/write cycle, and the one the others were modelled on. Its quarantine logic
 * is the ancestor of the service's.
 *
 * The assertions that matter here are about REMOVAL SEMANTICS. This page deletes a ROW:
 * a shopper with three duplicate rows who taps ✖ on one expects two to remain. The
 * marketplace card's "remove from cart" means the whole product. Collapsing those two
 * into one method would be invisible in a diff and wrong for one of them.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const { stripComments } = require('./scan-legacy-wishlist.js');
const SCAN = require('./scan-cart-writers.js');

const R = {};
let pass = 0, fail = 0;
function ck(g, l, ok, d) {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 92) + ']' : ''));
  ok ? pass++ : fail++;
  if (R[g] !== 'FAIL') R[g] = ok ? 'PASS' : 'FAIL';
}
const read = (f) => fs.readFileSync(path.resolve(ROOT, f), 'utf8');
const SRC = read('cart.js');

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
  g.window = g; g.store = store; g.notifs = [];
  const container = { innerHTML: '' };
  g.container = container;
  const mk = () => ({ innerHTML: '', textContent: '', innerText: '', style: {},
    classList: { add() {}, remove() {} }, appendChild(c) { return c; }, remove() {} });
  g.document = {
    getElementById: (id) => (id === 'cartContainer' ? container : mk()),
    createElement: mk, body: mk(), head: mk(),
    querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {},
  };
  vm.createContext(g);
  if (!opts.withoutService) vm.runInContext(read('sokoni-cart.js'), g);
  vm.runInContext(SRC, g);
  /* showNotif is declared by cart.js — override AFTER, or the shim is clobbered. */
  g.showNotif = (m, t) => g.notifs.push({ msg: m, type: t });
  g.getCart = () => vm.runInContext('cart', g);
  return g;
}
const stored = (g) => JSON.parse(g.store.cart || '[]');
const said = (g, re) => g.notifs.some(n => re.test(n.msg));

const P = (id, extra) => Object.assign({ id: id, name: 'Item ' + id, price: 100 }, extra || {});
const FOOD = (cartId, extra) => Object.assign({
  type: 'food', cartId: cartId, itemId: 'dish', restaurantId: 'r1', restaurantName: 'Mama',
  name: 'Fish', price: 800, qty: 1 }, extra || {});

console.log('\nTRACK 2.3 · surface 6 — cart.js (the cart page)\n' + '='.repeat(66));

/* ══ A. the projection reflects the service ══ */
console.log('\nA. The page renders what is stored, not a stale copy');
{
  const g = page({ seed: { cart: JSON.stringify([P('a'), P('b')]) } });
  g.renderCart();
  ck('A', 'projection has both rows', g.getCart().length === 2, g.getCart().length);
  /* A change made elsewhere, then a re-render. */
  g.SokoniCart.add(P('c'));
  g.renderCart();
  ck('A', 'a change made by another surface appears on re-render',
     g.getCart().length === 3, g.getCart().length);
  ck('A', 'no module-level snapshot survives', !/let\s+cart\s*=\s*_readCart/.test(stripComments(SRC)));
}

/* ══ B. row removal, NOT product removal ══ */
console.log('\nB. ✖ on a row removes ONE row, not every row of that product');
{
  const g = page({ seed: { cart: JSON.stringify([P('d'), P('d'), P('d'), P('keep')]) } });
  g.removeFromCart(0);
  const c = stored(g);
  ck('B', 'three rows remain', c.length === 3, c.length);
  ck('B', 'two of the duplicate product survive',
     c.filter(i => i.id === 'd').length === 2, JSON.stringify(c.map(i => i.id)));
  ck('B', 'the unrelated row is untouched', c.some(i => i.id === 'keep'));
  ck('B', 'the shopper is told', said(g, /Item removed from cart/), JSON.stringify(g.notifs));
  ck('B', 'cart.js does NOT use removeAllById — that is the card toggle\'s intent',
     !/removeAllById/.test(stripComments(SRC)));
}

/* ══ C. food rows are keyed by cartId ══ */
console.log('\nC. Food rows are removed by cartId, so notes stay distinct');
{
  const g = page({ seed: { cart: JSON.stringify([
    FOOD('CI1', { note: 'extra ugali' }), FOOD('CI2', { note: 'no ugali' }), P('p1'),
  ]) } });
  g.removeFoodItem('CI1');
  const c = stored(g);
  ck('C', 'two rows remain', c.length === 2, c.length);
  ck('C', 'the OTHER food line survived with its note',
     c[0].cartId === 'CI2' && c[0].note === 'no ugali', JSON.stringify(c[0]));
  ck('C', 'the product row is untouched', c[1].id === 'p1');
}

/* ══ D. quantity ══ */
console.log('\nD. Quantity changes target the right line');
{
  const g = page({ seed: { cart: JSON.stringify([FOOD('CI1'), FOOD('CI2'), P('p1')]) } });
  g.foodQty('CI2', 5);
  let c = stored(g);
  ck('D', 'the addressed food line changed', c[1].qty === 5, JSON.stringify(c[1]));
  ck('D', 'the other food line did not', c[0].qty === 1, JSON.stringify(c[0]));

  const g2 = page({ seed: { cart: JSON.stringify([P('x'), P('x'), P('y')]) } });
  g2.productQty(1, 4);
  c = stored(g2);
  ck('D', 'a numeric ref is an array index — row 1 only', c[1].qty === 4, JSON.stringify(c.map(i => i.qty)));
  ck('D', 'the duplicate sibling is unaffected', c[0].qty === undefined, JSON.stringify(c[0]));
  ck('D', 'units reflects the change', g2.SokoniCart.units() === 1 + 4 + 1, g2.SokoniCart.units());
}

/* ══ E. qty <= 0 removes the row — existing behaviour ══ */
console.log('\nE. Setting a quantity to zero removes that row (unchanged behaviour)');
{
  const g = page({ seed: { cart: JSON.stringify([P('x'), P('y')]) } });
  g.productQty(0, 0);
  ck('E', 'the row was removed', stored(g).length === 1 && stored(g)[0].id === 'y',
     JSON.stringify(stored(g).map(i => i.id)));
  ck('E', 'and the removal toast fired', said(g, /Item removed from cart/), JSON.stringify(g.notifs));

  const gf = page({ seed: { cart: JSON.stringify([FOOD('CI1'), FOOD('CI2')]) } });
  gf.foodQty('CI1', 0);
  ck('E', 'food: the row was removed by cartId',
     stored(gf).length === 1 && stored(gf)[0].cartId === 'CI2', JSON.stringify(stored(gf)));
}

/* ══ F. clear ══ */
console.log('\nF. Clear Cart');
{
  const g = page({ seed: { cart: JSON.stringify([P('a'), P('b')]) } });
  g.clearCart();
  ck('F', 'the cart is empty', stored(g).length === 0, JSON.stringify(stored(g)));
  ck('F', 'the shopper is told', said(g, /Cart cleared/), JSON.stringify(g.notifs));
  const empty = page({ seed: { cart: '[]' } });
  empty.clearCart();
  ck('F', 'clearing an empty cart says nothing', empty.notifs.length === 0, JSON.stringify(empty.notifs));
}

/* ══ G. failure must not report success ══ */
console.log('\nG. A failed write never produces a success message');
{
  const g = page({ seed: { cart: JSON.stringify([P('a'), P('b')]) }, failWrite: true });
  g.removeFromCart(0);
  ck('G', 'the cart is unchanged on disk', stored(g).length === 2, stored(g).length);
  ck('G', 'no "Item removed" claim', !said(g, /Item removed/), JSON.stringify(g.notifs));
  ck('G', 'the failure is reported', said(g, /Couldn't update your cart/), JSON.stringify(g.notifs));

  const g2 = page({ seed: { cart: JSON.stringify([P('a')]) }, failWrite: true });
  g2.clearCart();
  ck('G', 'a failed clear leaves the cart intact', stored(g2).length === 1, stored(g2).length);
  ck('G', 'and does not claim "Cart cleared"', !said(g2, /Cart cleared/), JSON.stringify(g2.notifs));

  const g3 = page({ seed: { cart: JSON.stringify([P('a')]) }, failWrite: true });
  g3.productQty(0, 3);
  ck('G', 'a failed quantity change is reported',
     said(g3, /Couldn't update the quantity/), JSON.stringify(g3.notifs));
  ck('G', 'and the stored quantity is unchanged', stored(g3)[0].qty === undefined,
     JSON.stringify(stored(g3)[0]));
}

/* ══ H. no service → fail closed, and no fabricated empty cart ══ */
console.log('\nH. Without SokoniCart the page fails closed');
{
  const g = page({ withoutService: true, seed: { cart: JSON.stringify([P('a')]) } });
  g.removeFromCart(0);
  g.clearCart();
  g.productQty(0, 5);
  ck('H', 'nothing was written to legacy storage', stored(g).length === 1, JSON.stringify(stored(g)));
  ck('H', 'no success toast of any kind',
     !said(g, /removed|cleared/i), JSON.stringify(g.notifs));
  ck('H', 'every control says the cart is loading', said(g, /still loading/), JSON.stringify(g.notifs));
}

/* ══ I. no legacy persistence; page scope ══ */
console.log('\nI. cart.js no longer persists, and cart.html loads the service');
{
  const code = stripComments(SRC);
  ck('I', 'no localStorage cart access',
     !/localStorage\s*(?:\.\s*(?:get|set|remove)Item\s*\(\s*|\[\s*)["']cart["']/.test(code));
  ck('I', '_readCart and _saveCartState are gone', !/_readCart|_saveCartState/.test(code));
  ck('I', 'no fallback to another cart store',
     !/localStorage\s*(?:\.\s*\w+Item\s*\(\s*|\[\s*)["'](sokoniCart|retrievedCart)["']/.test(code));
  ck('I', 'the wishlist half (Track 3) is untouched', /SokoniWishlist/.test(code));
  const html = read('cart.html');
  ck('I', 'cart.html loads sokoni-cart.js', /src="sokoni-cart\.js"/.test(html));
  ck('I', 'and loads it BEFORE cart.js',
     html.indexOf('sokoni-cart.js') < html.indexOf('src="cart.js"'));
  const { hits } = SCAN.pageScope('cart.html');
  const writers = hits.filter(h => h.key === 'cart' && h.kind === 'WRITE' && h.file !== 'sokoni-cart.js');
  ck('I', 'page scope: no other cart writer', writers.length === 0,
     writers.map(h => h.file + ':' + h.line).join(', '));
  const readers = hits.filter(h => h.key === 'cart' && h.kind === 'READ' && h.file !== 'sokoni-cart.js');
  ck('I', 'the remaining readers are cart.html inline + shared-header.js — both 2.3.7',
     readers.every(h => h.file === 'cart.html' || h.file === 'shared-header.js'),
     readers.map(h => h.file + ':' + h.line).join(', '));
}

/* ══ J. this was the LAST writer ══ */
console.log('\nJ. No unmigrated cart WRITER remains anywhere');
{
  const STATE = require('./cart-migration-state.js');
  const all = SCAN.scan().filter(h => h.key === 'cart' && h.kind === 'WRITE');
  const rogue = all.filter(h => h.file !== 'sokoni-cart.js' &&
    !STATE.FROZEN_FILES.includes(h.file) && !STATE.DEFERRED_FILES.includes(h.file) &&
    !STATE.TEST_HARNESS.includes(h.file));
  ck('J', 'every remaining cart writer is the service, frozen, deferred or a harness',
     rogue.length === 0, rogue.map(h => h.file + ':' + h.line).join(', '));
  /* Was "the frozen PAIR still write". 2.4 migrated checkout.html, so the pair is now a
     single file. Driven by the registry so it tracks whichever surfaces are frozen at the
     time, instead of encoding a count that a later slice invalidates. */
  ck('J', 'every still-frozen surface is still a writer (they are, by definition, unmigrated)',
     STATE.FROZEN_FILES.every(f => all.some(h => h.file === f)),
     STATE.FROZEN_FILES.join(', '));
  ck('J', 'sokoni-food.js still writes — deferred to 2.5, untouched',
     all.some(h => h.file === 'sokoni-food.js'));
}

/* ══ K. perimeter ══ */
console.log('\nK. Frozen, deferred and pending surfaces');
{
  const changed = cp.execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean);
  const STATE = require('./cart-migration-state.js');
  ck('K', 'nothing dirty the migration state does not explain',
     STATE.unexpected(changed).length === 0, STATE.unexpected(changed).join(', '));
  STATE.FROZEN_FILES.forEach(f => ck('K', f + ' FROZEN', !changed.includes(f)));
  STATE.DEFERRED_FILES.forEach(f => ck('K', f + ' DEFERRED to 2.5', !changed.includes(f)));
  /* Read from the shared state, never a list typed here. This assertion originally
     hardcoded four names and went stale the moment 2.3.7 migrated two of them — the
     fourth per-suite list to do so in this track, and written AFTER the shared registry
     existed. If a suite needs to know what is unmigrated, it asks. */
  STATE.PENDING.forEach(f => ck('K', f + ' still pending', !changed.includes(f)));
}

console.log('\n' + '='.repeat(66));
console.log('Track 2.3 surface 6 acceptance\n');
['A','B','C','D','E','F','G','H','I','J','K'].forEach(k => console.log('  ' + k + ': ' + (R[k] || 'MISSING')));
console.log('\n  TOTAL:   ' + (pass + fail) + '\n  PASSED:  ' + pass + '\n  FAILED:  ' + fail);
process.exit(fail ? 1 : 0);
