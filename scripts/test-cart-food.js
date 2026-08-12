#!/usr/bin/env node
/* Track 2.5 — the food cart and the sokoniCart bridge.
 *
 *   node scripts/test-cart-food.js
 *
 * sokoni-food.js was a complete parallel cart implementation on the SAME key, reached
 * through `const SHARED_CART_KEY = 'cart'` — the indirection that hid it from the
 * literal-only scanner for three slices.
 *
 * Its three peculiarities are the point of this suite, because normalising any of them
 * would be a behaviour change wearing a migration's clothes:
 *
 *   saveCart()   whole-array replace, non-food first then all food. Observable: checkout
 *                reads cart[0] for pickupCoords and the seller id.
 *   addToCart()  merges on itemId + restaurantId — not id, not cartId.
 *   clearCart()  empties FOOD rows only; the shopper's products survive.
 *
 * Block E is the one that matters most: a food mutation must never delete product rows,
 * and an unreadable cart must never be rebuilt from an assumed-empty read.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const { stripComments } = require('./scan-legacy-wishlist.js');
const SCAN = require('./scan-cart-writers.js');
const STATE = require('./cart-migration-state.js');

const R = {};
let pass = 0, fail = 0;
function ck(g, l, ok, d) {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 92) + ']' : ''));
  ok ? pass++ : fail++;
  if (R[g] !== 'FAIL') R[g] = ok ? 'PASS' : 'FAIL';
}
const read = (f) => fs.readFileSync(path.resolve(ROOT, f), 'utf8');

function sandbox(opts) {
  opts = opts || {};
  const store = Object.assign({}, opts.seed || {});
  const badges = [];
  const g = {
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { if (opts.failWrite) throw new Error('QuotaExceededError'); store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => true,
    CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
    setTimeout, clearTimeout, console,
    JSON, Date, Math, String, Number, Object, Array, Promise, Error, Set, RegExp,
    isNaN, parseInt, parseFloat, encodeURIComponent,
    location: { pathname: '/food.html', href: '', search: '' },
  };
  g.window = g; g.store = store; g.badges = badges;
  g.document = {
    addEventListener: () => {}, removeEventListener: () => {},
    getElementById: () => null, querySelector: () => null,
    querySelectorAll: (sel) => {
      if (/cart-badge|cart-pip/.test(sel)) {
        if (!badges.length) badges.push({ textContent: '', style: {} });
        return badges;
      }
      return [];
    },
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {} }),
    body: { appendChild() {} }, head: { appendChild() {} }, readyState: 'complete',
  };
  vm.createContext(g);
  if (!opts.withoutService) vm.runInContext(read('sokoni-cart.js'), g);
  vm.runInContext(read('sokoni-food.js'), g);
  const F = g.SokoniFood || g.FoodEngine || g.SokoniFoodEngine;
  return { g, F, store };
}

const PRODUCT = (id) => ({ id: id, name: 'Product ' + id, price: 100, sellerUid: 'seller-A',
  sellerLat: -1.29, sellerLng: 36.82 });
const DISH = { id: 'dish-1', name: 'Fish', price: 800 };

/* Discover the exported name once, so a rename fails loudly here rather than silently
   skipping every block. */
const probe = sandbox();
console.log('\nTRACK 2.5 — FOOD CART + sokoniCart BRIDGE\n' + '='.repeat(70));
console.log('\n0. The food engine is reachable');
ck('0', 'sokoni-food.js exports a cart API',
   !!(probe.F && typeof probe.F.addToCart === 'function'),
   probe.F ? Object.keys(probe.F).slice(0, 8).join(',') : 'no export found: ' +
     Object.keys(probe.g).filter(k => /food/i.test(k)).join(','));

const F = probe.F;
if (!F) {
  console.log('\n  ABORTING — cannot exercise the food cart without its export.');
  console.log('\n  TOTAL: ' + (pass + fail) + '  PASSED: ' + pass + '  FAILED: ' + fail);
  process.exit(1);
}

/* ══ A. food rows keep their shape ══ */
console.log('\nA. A food row keeps every field it had');
{
  const s = sandbox();
  s.F.addToCart('r1', 'Mama Oliech', '🐟', DISH, 2, 'extra ugali');
  const all = JSON.parse(s.store.cart);
  ck('A', 'one row', all.length === 1, all.length);
  const row = all[0];
  ['type', 'cartId', 'restaurantId', 'restaurantName', 'restaurantEmoji', 'itemId', 'name', 'price', 'qty', 'note']
    .forEach(f => ck('A', 'has ' + f, f in row, JSON.stringify(Object.keys(row))));
  ck('A', 'type is food', row.type === 'food');
  ck('A', 'cartId is generated', /^CI/.test(row.cartId), row.cartId);
  ck('A', 'qty carried through', row.qty === 2, row.qty);
  ck('A', 'note carried through', row.note === 'extra ugali', row.note);
  ck('A', 'itemId is the dish, not an id field', row.itemId === 'dish-1' && row.id === undefined);
}

/* ══ B. merge is by itemId + restaurantId, its OWN rule ══ */
console.log('\nB. Repeat add merges on itemId + restaurantId');
{
  const s = sandbox();
  s.F.addToCart('r1', 'Mama', '🐟', DISH, 1, '');
  s.F.addToCart('r1', 'Mama', '🐟', DISH, 2, '');
  let all = JSON.parse(s.store.cart);
  ck('B', 'one row at qty 3', all.length === 1 && all[0].qty === 3, JSON.stringify(all.map(i => i.qty)));
  /* Same dish, DIFFERENT restaurant — must NOT merge. */
  s.F.addToCart('r2', 'Other', '🍲', DISH, 1, '');
  all = JSON.parse(s.store.cart);
  ck('B', 'the same dish at another restaurant is a separate row', all.length === 2,
     JSON.stringify(all.map(i => i.restaurantId)));
  ck('B', 'and the first row is unchanged', all.find(i => i.restaurantId === 'r1').qty === 3);
}

/* ══ C. food rows never collapse into product rows ══ */
console.log('\nC. Food and product rows cannot collapse into one another');
{
  const s = sandbox({ seed: { cart: JSON.stringify([Object.assign(PRODUCT('dish-1'), { qty: 1 })]) } });
  /* A product whose id equals the dish's itemId — the collision that would matter. */
  s.F.addToCart('r1', 'Mama', '🐟', DISH, 1, '');
  const all = JSON.parse(s.store.cart);
  ck('C', 'two rows, not a merge', all.length === 2, JSON.stringify(all.map(i => i.type || 'product')));
  ck('C', 'the product row is untouched',
     all.find(i => !i.type).id === 'dish-1' && all.find(i => !i.type).price === 100,
     JSON.stringify(all.find(i => !i.type)));
  ck('C', 'the food row has its own identity', !!all.find(i => i.type === 'food').cartId);
  /* And the SERVICE must not merge them either, from the product side. */
  const c = s.g.SokoniCart;
  c.add(PRODUCT('dish-1'), { merge: true });
  const after = c.list();
  ck('C', 'a product merge does not land on the food row',
     after.filter(i => i.type === 'food').length === 1 &&
     after.find(i => i.type === 'food').qty === 1,
     JSON.stringify(after.map(i => (i.type || 'product') + ':' + (i.qty === undefined ? '-' : i.qty))));
}

/* ══ D. whole-array separation and ordering ══ */
console.log('\nD. saveCart keeps non-food first, then all food');
{
  const s = sandbox({ seed: { cart: JSON.stringify([PRODUCT('p1'), PRODUCT('p2')]) } });
  s.F.addToCart('r1', 'Mama', '🐟', DISH, 1, '');
  const all = JSON.parse(s.store.cart);
  ck('D', 'three rows', all.length === 3, all.length);
  ck('D', 'products come first, in order',
     all[0].id === 'p1' && all[1].id === 'p2', JSON.stringify(all.map(i => i.id || i.cartId)));
  ck('D', 'the food row is last', all[2].type === 'food');
  ck('D', 'cart[0] is still a product — checkout reads it for pickupCoords',
     all[0].sellerLat === -1.29, JSON.stringify(all[0].sellerLat));
  /* One write per mutation, not clear-then-fill. */
  const s2 = sandbox({ seed: { cart: JSON.stringify([PRODUCT('p1')]) } });
  const seen = [];
  const real = s2.g.localStorage.setItem;
  s2.g.localStorage.setItem = function (k, v) { if (k === 'cart') seen.push(JSON.parse(v).length); return real.call(this, k, v); };
  s2.F.addToCart('r1', 'Mama', '🐟', DISH, 1, '');
  s2.g.localStorage.setItem = real;
  ck('D', 'exactly one cart write', seen.length === 1, JSON.stringify(seen));
  ck('D', 'no intermediate state without the product', !seen.includes(0), JSON.stringify(seen));
}

/* ══ E. THE ONE THAT MATTERS — food operations must not delete products ══ */
console.log('\nE. Food mutations never take the shopper\'s products with them');
{
  const s = sandbox({ seed: { cart: JSON.stringify([PRODUCT('p1'), PRODUCT('p2')]) } });
  s.F.addToCart('r1', 'Mama', '🐟', DISH, 1, '');
  s.F.clearCart();
  const all = JSON.parse(s.store.cart);
  ck('E', 'clearCart removed the food row', !all.some(i => i.type === 'food'),
     JSON.stringify(all.map(i => i.type || 'product')));
  ck('E', 'and BOTH products survive', all.length === 2 && all[0].id === 'p1' && all[1].id === 'p2',
     JSON.stringify(all.map(i => i.id)));
  ck('E', 'clearCart is not SokoniCart.clear()',
     !/function clearCart[\s\S]{0,120}SokoniCart\s*\.\s*clear/.test(stripComments(read('sokoni-food.js'))));

  /* An unreadable cart must not be rebuilt from an assumed-empty read — that would wipe
     the products by treating "unknown" as "no non-food rows". */
  const off = sandbox({ withoutService: true, seed: { cart: JSON.stringify([PRODUCT('p1')]) } });
  const okAdd = off.F.addToCart('r1', 'Mama', '🐟', DISH, 1, '');
  ck('E', 'without the service, addToCart refuses', okAdd === false || okAdd === undefined || okAdd === 0,
     String(okAdd));
  ck('E', 'and the stored cart is untouched — products NOT deleted',
     JSON.parse(off.store.cart).length === 1 && JSON.parse(off.store.cart)[0].id === 'p1',
     off.store.cart);
  ck('E', 'clearCart also refuses rather than wiping', (function () {
    off.F.clearCart();
    return JSON.parse(off.store.cart).length === 1;
  })(), off.store.cart);
}

/* ══ F. quantity + removal by cartId ══ */
console.log('\nF. Quantity and removal are keyed by cartId');
{
  const s = sandbox();
  s.F.addToCart('r1', 'Mama', '🐟', DISH, 1, 'extra ugali');
  s.F.addToCart('r1', 'Mama', '🐟', { id: 'dish-2', name: 'Ugali', price: 100 }, 1, '');
  let all = JSON.parse(s.store.cart);
  const id1 = all[0].cartId;
  s.F.updateQty(id1, 5);
  all = JSON.parse(s.store.cart);
  ck('F', 'the addressed row changed', all.find(i => i.cartId === id1).qty === 5);
  ck('F', 'the other row did not', all.find(i => i.cartId !== id1).qty === 1);
  ck('F', 'qty 0 removes that row', (function () {
    s.F.updateQty(id1, 0);
    return JSON.parse(s.store.cart).length === 1;
  })());
  ck('F', 'and it is the right row that went',
     JSON.parse(s.store.cart)[0].itemId === 'dish-2', s.store.cart);
  ck('F', 'removeFromCart takes one cartId', (function () {
    const s2 = sandbox();
    s2.F.addToCart('r1', 'M', '🐟', DISH, 1, 'a');
    s2.F.addToCart('r1', 'M', '🐟', { id: 'd2', name: 'X', price: 1 }, 1, '');
    const rows = JSON.parse(s2.store.cart);
    s2.F.removeFromCart(rows[0].cartId);
    const left = JSON.parse(s2.store.cart);
    return left.length === 1 && left[0].cartId === rows[1].cartId;
  })());
}

/* ══ G. counts ══ */
console.log('\nG. Counts: food-only vs the shared badge');
{
  const s = sandbox({ seed: { cart: JSON.stringify([Object.assign(PRODUCT('p1'), { qty: 3 })]) } });
  s.F.addToCart('r1', 'Mama', '🐟', DISH, 2, '');
  ck('G', 'getCartCount counts FOOD units only', s.F.getCartCount() === 2, s.F.getCartCount());
  ck('G', 'the shared badge counts everything — units()',
     Number(s.g.badges[0].textContent) === s.g.SokoniCart.units(),
     s.g.badges[0].textContent + ' vs ' + s.g.SokoniCart.units());
  ck('G', 'and that is 3 + 2', Number(s.g.badges[0].textContent) === 5, s.g.badges[0].textContent);
  const off = sandbox({ withoutService: true });
  off.F.getCartCount();
  ck('G', 'with no service the badge is blank, never 0',
     off.g.badges.length === 0 || off.g.badges[0].textContent === '',
     JSON.stringify(off.g.badges[0] && off.g.badges[0].textContent));
}

/* ══ H. vendor grouping unchanged ══ */
console.log('\nH. Vendor grouping still works off the food rows');
{
  const s = sandbox({ seed: { cart: JSON.stringify([PRODUCT('p1')]) } });
  s.F.addToCart('r1', 'Mama', '🐟', DISH, 2, '');
  s.F.addToCart('r2', 'Other', '🍲', { id: 'd9', name: 'Pilau', price: 300 }, 1, '');
  const v = s.F.getCartByVendor();
  ck('H', 'two vendors', v.length === 2, v.length);
  ck('H', 'subtotals are per vendor', v.find(x => x.restaurantId === 'r1').subtotal === 1600,
     v.find(x => x.restaurantId === 'r1').subtotal);
  ck('H', 'the product row is not in any vendor group',
     !v.some(x => x.items.some(i => i.id === 'p1')));
}

/* ══ I. no direct persistence left, and the pages load the service ══ */
console.log('\nI. sokoni-food.js no longer owns a cart');
{
  const src = stripComments(read('sokoni-food.js'));
  ck('I', 'the SHARED_CART_KEY constant is gone', !/SHARED_CART_KEY/.test(src));
  ck('I', 'no localStorage cart access of any form',
     !/localStorage\s*(?:\.\s*(?:get|set|remove)Item\s*\(\s*|\[\s*)["']cart["']/.test(src));
  ck('I', 'it reaches the cart through the service', /window\.SokoniCart/.test(src));
  const pages = ['food.html', 'food-menu.html', 'food-order.html', 'food-dashboard.html', 'food-rider.html'];
  const missing = pages.filter(p => !/src="sokoni-cart\.js"/.test(read(p)));
  ck('I', 'all five food pages load the service', missing.length === 0, missing.join(', '));
  const badOrder = pages.filter(p => {
    const s = read(p);
    return s.search(/<script[^>]*src="sokoni-cart\.js"/) > s.search(/<script[^>]*src="[^"]*sokoni-food\.js"/);
  });
  ck('I', 'and load it BEFORE sokoni-food.js', badOrder.length === 0, badOrder.join(', '));
  const mixed = pages.filter(p => {
    const s = read(p);
    return (s.match(/\r\n/g) || []).length > 0 && (s.match(/(?<!\r)\n/g) || []).length > 0;
  });
  ck('I', 'no page gained mixed line endings', mixed.length === 0, mixed.join(', '));
}

/* ══ J. the sokoniCart mirror has no product consumer left ══ */
console.log('\nJ. sokoniCart is now touched only by the bridge itself');
{
  const hits = SCAN.scan().filter(h => h.key === 'sokoniCart');
  const nonBridge = hits.filter(h => h.file !== 'provider-wiring.js');
  ck('J', 'inspiq.js no longer reads the mirror',
     !nonBridge.some(h => h.file === 'inspiq.js'), nonBridge.map(h => h.file).join(', '));
  ck('J', 'nothing outside provider-wiring.js touches sokoniCart',
     nonBridge.length === 0, nonBridge.map(h => h.file + ':' + h.line).join(', '));
  /* Was "the bridge itself still does — that is 2.6's to remove". 2.6 removed it, so
     nothing anywhere touches sokoniCart now. */
  ck('J', 'and the bridge is gone too — 2.6 removed it',
     !hits.some(h => h.file === 'provider-wiring.js'),
     hits.map(h => h.file + ':' + h.line).join(', '));
  ck('J', 'inspiq.js now scores off the canonical cart', /SokoniCart/.test(stripComments(read('inspiq.js'))));
  ck('J', 'and inspiq.html loads the service', /src="sokoni-cart\.js"/.test(read('inspiq.html')));
}

/* ══ K. perimeter ══ */
console.log('\nK. Perimeter — 2.6 has not started');
{
  const changed = cp.execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean);
  /* These four asserted that 2.6 had not started. It has. Inverted rather than deleted,
     so the block still fails if the interceptor or the header regresses. */
  ck('K', 'the cart interceptor is gone from provider-wiring.js',
     !/["'](cart|sokoniCart)["']/.test(stripComments(read('provider-wiring.js'))));
  ck('K', 'its unrelated provider/booking setItem watchers remain',
     (stripComments(read('provider-wiring.js')).match(/localStorage\.setItem\s*=/g) || []).length === 2);
  ck('K', 'shared-header.js is migrated', !STATE.BLOCKED_FILES.includes('shared-header.js'));
  ck('K', 'no survivors remain declared at all',
     STATE.BLOCKED_FILES.length === 0 && STATE.FROZEN_FILES.length === 0 &&
     STATE.DEFERRED_FILES.length === 0);
  ck('K', 'nothing dirty the migration state does not explain',
     STATE.unexpected(changed).length === 0, STATE.unexpected(changed).join(', '));
  /* RETIRED at the release pass. This asserted the saveAndRedirect fallback still summed
     price WITHOUT quantity — correct while that defect was deliberately carried, and now
     false by authorisation: the release explicitly cleared it as a money-path blocker.

     Replaced by the constraints that outlive the fix: the fallback is quantity-aware, it
     shares ONE line-total with the displayed subtotal rather than carrying a second copy,
     and the charge is still the server's. scripts/test-checkout-fallback-total.js proves
     the arithmetic; these keep the cart suites honest about it. */
  ck('K', 'the saveAndRedirect fallback is quantity-aware',
     /currentCart\.reduce\(\(s, p\) => s \+ _ckLineTotal\(p\), 0\)/.test(read('checkout.html')));
  ck('K', 'the qty-blind sum is gone',
     !/reduce\(\(s,p\) => s \+ Number\(p\.price\|\|0\), 0\)/.test(read('checkout.html')));
  ck('K', 'the line total has exactly ONE definition',
     (read('checkout.html').match(/function _ckLineTotal/g) || []).length === 1);
  ck('K', 'the charge is still server-authoritative',
     /amount:\s*stkAmount \?\? _serverTotalOverride \?\? orderTotal/.test(read('checkout.html')));
}

console.log('\n' + '='.repeat(70));
console.log('Track 2.5 acceptance\n');
['0','A','B','C','D','E','F','G','H','I','J','K'].forEach(k => console.log('  ' + k + ': ' + (R[k] || 'MISSING')));
console.log('\n  TOTAL:   ' + (pass + fail) + '\n  PASSED:  ' + pass + '\n  FAILED:  ' + fail);
process.exit(fail ? 1 : 0);
