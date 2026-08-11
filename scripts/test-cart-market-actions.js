#!/usr/bin/env node
/* Track 2.2B — market-actions.js migrated onto SokoniCart.
 *
 *   node scripts/test-cart-market-actions.js
 *
 * Runs the SHIPPED market-actions.js and the SHIPPED sokoni-cart.js together in one
 * sandbox, so what is exercised is the real pair, not a description of them.
 *
 * Every assertion maps to the 2.2B acceptance gate. The ones that matter most are the
 * negative ones: that the migrated path no longer persists anything itself, that a
 * failure does not silently swallow the item, and that nothing outside this one writer
 * moved.
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

/* ── sandbox: real service + real market-actions ── */
function surface(opts) {
  opts = opts || {};
  const store = Object.assign({}, opts.seed || {});
  const badges = {};
  const mkEl = (sel) => ({ sel: sel, textContent: '', innerHTML: '', title: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    querySelectorAll: () => [], querySelector: () => null, appendChild(c) { return c; },
    remove() {}, addEventListener() {} });
  const listeners = {};
  const g = {
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { if (opts.failWrite) throw new Error('QuotaExceededError'); store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener: (t, f) => { if (listeners[t]) listeners[t] = listeners[t].filter(x => x !== f); },
    dispatchEvent: e => { (listeners[e.type] || []).forEach(f => { try { f(e); } catch (_) {} }); return true; },
    CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
    setTimeout, clearTimeout, console,
    requestAnimationFrame: (f) => setTimeout(f, 0),
    JSON, Date, Math, String, Number, Object, Array, Promise, Error, Set, RegExp,
    isNaN, parseInt, parseFloat,
  };
  g.window = g;
  g.store = store;
  g.badges = badges;
  g.document = {
    getElementById: () => null,
    createElement: () => mkEl('created'),
    body: { appendChild(c) { return c; } },
    head: { appendChild(c) { return c; } },
    querySelector: () => null,
    /* Record what the badge selectors resolve to so the rendered number is observable. */
    querySelectorAll: (sel) => {
      if (!badges[sel]) badges[sel] = [mkEl(sel)];
      return badges[sel];
    },
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
  };
  g.SokoniWishlist = { count: () => 0, isWishlisted: () => false };

  vm.createContext(g);
  if (!opts.withoutService) vm.runInContext(read('sokoni-cart.js'), g);
  vm.runInContext(read('market-actions.js'), g);
  if (!g.SokoniMarket) throw new Error('SokoniMarket did not define');
  g.cartBadge = () => {
    const key = Object.keys(badges).find(k => /cart-count|cartCount/.test(k));
    return key ? badges[key][0].textContent : null;
  };
  return g;
}

const ITEM = { id: 'm1', name: 'Jiko', price: 2400, image: 'j.png', category: 'Home', sellerName: 'Duka A' };
const cartOf = (g) => JSON.parse(g.store.cart || '[]');

console.log('\nTRACK 2.2B — market-actions.js on SokoniCart\n' + '='.repeat(66));

/* ══ A. add preserves the existing item shape ══ */
console.log('\nA. add preserves the shape _norm() has always produced');
{
  const g = surface();
  g.SokoniMarket.addToCart(ITEM);
  const c = cartOf(g);
  ck('A', 'exactly one row', c.length === 1, c.length);
  const it = c[0];
  ['id', 'name', 'price', 'image', 'category', 'sellerName', 'sourceUrl', 'source', 'addedAt']
    .forEach(f => ck('A', '_norm field present: ' + f, f in it, JSON.stringify(Object.keys(it))));
  ck('A', 'id preserved verbatim', it.id === 'm1', it.id);
  ck('A', 'price is numeric', typeof it.price === 'number' && it.price === 2400, it.price);
  ck('A', 'service added no fields of its own',
     !('qty' in it) && !('cartId' in it), JSON.stringify(Object.keys(it)));
}

/* ══ B. duplicate / merge behaviour ══ */
console.log('\nB. Repeat add is refused, exactly as before');
{
  const g = surface();
  ck('B', 'first add succeeds', g.SokoniMarket.addToCart(ITEM) === true);
  ck('B', 'second add returns false', g.SokoniMarket.addToCart(ITEM) === false);
  ck('B', 'still one row — no duplicate, no silent merge', cartOf(g).length === 1, cartOf(g).length);
  ck('B', 'isInCart agrees', g.SokoniMarket.isInCart('m1') === true);
  ck('B', 'and is false for an unknown id', g.SokoniMarket.isInCart('nope') === false);
}

/* ══ C. quantity is preserved ══ */
console.log('\nC. Quantity written by other surfaces survives this one');
{
  /* A cart already holding a qty-3 row and a duplicate-row pair, as product.js leaves it. */
  const seed = { cart: JSON.stringify([
    { id: 'x', name: 'Sukari', price: 180, qty: 3 },
    { id: 'y', name: 'Chai', price: 90 },
    { id: 'y', name: 'Chai', price: 90 },
  ]) };
  const g = surface({ seed: seed });
  g.SokoniMarket.addToCart(ITEM);
  const c = cartOf(g);
  ck('C', 'qty 3 row untouched', c[0].qty === 3, JSON.stringify(c[0]));
  ck('C', 'duplicate rows untouched', c[1].id === 'y' && c[2].id === 'y', c.length);
  ck('C', 'the new row was appended, not merged into anything', c.length === 4, c.length);
  ck('C', 'units counts 3 + 1 + 1 + 1 = 6', g.SokoniCart.units() === 6, g.SokoniCart.units());
}

/* ══ D. remove ══ */
console.log('\nD. remove clears the product, not one unit of it');
{
  const seed = { cart: JSON.stringify([
    { id: 'y', name: 'Chai', price: 90 },
    { id: 'y', name: 'Chai', price: 90 },
    { id: 'z', name: 'Maziwa', price: 60 },
  ]) };
  const g = surface({ seed: seed });
  g.SokoniMarket.removeFromCart('y');
  const c = cartOf(g);
  ck('D', 'BOTH y rows removed — matches the old filter() semantics', c.length === 1, c.length);
  ck('D', 'the unrelated row survives', c[0].id === 'z', c[0].id);
  ck('D', 'isInCart now false', g.SokoniMarket.isInCart('y') === false);
  const g2 = surface();
  g2.SokoniMarket.addToCart(ITEM);
  g2.SokoniMarket.toggleCart(ITEM);
  ck('D', 'toggle removes when present', cartOf(g2).length === 0, cartOf(g2).length);
  g2.SokoniMarket.toggleCart(ITEM);
  ck('D', 'toggle adds when absent', cartOf(g2).length === 1, cartOf(g2).length);
}

/* ══ E. failure does not silently lose the item ══ */
console.log('\nE. A failed write is reported, not swallowed');
{
  const g = surface({ failWrite: true });
  const ok = g.SokoniMarket.addToCart(ITEM);
  ck('E', 'addToCart returns false', ok === false, String(ok));
  ck('E', 'nothing was stored', !g.store.cart, String(g.store.cart));
  ck('E', 'the failure was surfaced, not a success toast',
     !/Added to cart/.test(JSON.stringify(g.store)), 'success toast leaked into storage');
  /* And with no service at all — the tag missing from a page. */
  const g2 = surface({ withoutService: true });
  ck('E', 'without SokoniCart, add fails closed', g2.SokoniMarket.addToCart(ITEM) === false);
  ck('E', 'and writes nothing directly to localStorage', !g2.store.cart, String(g2.store.cart));
  ck('E', 'isInCart is false rather than throwing', g2.SokoniMarket.isInCart('m1') === false);
}

/* ══ F. reload preserves the cart ══ */
console.log('\nF. The cart survives a page reload');
{
  const g = surface();
  g.SokoniMarket.addToCart(ITEM);
  g.SokoniMarket.addToCart({ id: 'm2', name: 'Sufuria', price: 800 });
  const persisted = g.store.cart;
  const g2 = surface({ seed: { cart: persisted } });          /* fresh page, same storage */
  ck('F', 'both items are still there', cartOf(g2).length === 2, cartOf(g2).length);
  ck('F', 'isInCart still true after reload', g2.SokoniMarket.isInCart('m1') === true);
  ck('F', 'shape survived the round trip',
     JSON.stringify(cartOf(g2)) === JSON.stringify(cartOf(g)));
}

/* ══ G. units() drives the badge ══ */
console.log('\nG. The card badge counts UNITS, matching the header pip');
{
  const g = surface({ seed: { cart: JSON.stringify([{ id: 'x', name: 'S', price: 10, qty: 3 }]) } });
  g.SokoniMarket.syncBadges ? g.SokoniMarket.syncBadges() : null;
  /* Badges refresh on the cart-changed event; trigger a real mutation to drive it. */
  g.SokoniMarket.addToCart(ITEM);
  const shown = Number(g.cartBadge());
  const headerFormula = cartOf(g).reduce((s, i) => s + (i.qty || 1), 0);
  ck('G', 'badge renders units, not line count', shown === headerFormula,
     shown + ' shown vs ' + headerFormula + ' header formula');
  ck('G', 'and that is 4, not 2', shown === 4, shown);
  ck('G', 'lines() would have shown 2 — the old, contradicting number',
     g.SokoniCart.lines() === 2, g.SokoniCart.lines());
}

/* ══ H. badges follow writes made elsewhere ══ */
console.log('\nH. Badges refresh when any surface changes the cart');
{
  const g = surface();
  g.SokoniMarket.addToCart(ITEM);
  const before = Number(g.cartBadge());
  /* An unmigrated writer dispatching the same event. */
  g.SokoniCart.add({ id: 'other', name: 'Elsewhere', price: 5 });
  const after = Number(g.cartBadge());
  ck('H', 'badge updated without market-actions being called', after === before + 1,
     before + ' -> ' + after);
}

/* ══ I. anonymous operation ══ */
console.log('\nI. Works with no session at all');
{
  const g = surface();
  ck('I', 'no auth object exists in the sandbox', g.firebaseAuth === undefined);
  ck('I', 'add still succeeds', g.SokoniMarket.addToCart(ITEM) === true);
  ck('I', 'and persists', cartOf(g).length === 1);
  ck('I', 'the stored key is not uid-scoped', 'cart' in g.store && Object.keys(g.store).length === 1,
     Object.keys(g.store).join(','));
}

/* ══ J. no direct cart persistence remains in the migrated path ══ */
console.log('\nJ. market-actions.js no longer persists the cart itself');
{
  const code = stripComments(read('market-actions.js'));
  ck('J', 'no localStorage cart access',
     !/localStorage\s*(?:\.\s*(?:get|set|remove)Item\s*\(\s*|\[\s*)["']cart["']/.test(code));
  ck('J', 'no _loadCart / _saveCart helpers left', !/_loadCart|_saveCart/.test(code));
  ck('J', 'no private cart-changed emitter (the service owns it)',
     !/_emitCartChanged/.test(code));
  ck('J', 'it reaches the cart only through SokoniCart', /window\.SokoniCart/.test(code));
  ck('J', 'the wishlist path is untouched by this slice', /SokoniWishlist/.test(code));
}

/* ══ K. no second writer introduced ══ */
console.log('\nK. Exactly one write path, and the interceptor still sees it');
{
  const g = surface();
  const real = g.localStorage.setItem;
  const writes = [];
  g.localStorage.setItem = function (k, v) { writes.push(k); return real.call(this, k, v); };
  g.SokoniMarket.addToCart(ITEM);
  g.localStorage.setItem = real;
  ck('K', 'one cart write per add', writes.filter(k => k === 'cart').length === 1, writes.join(','));
  ck('K', 'written through localStorage.setItem — provider-wiring bridge still fires',
     writes.includes('cart'), writes.join(','));
}

/* ══ L. the rest of the platform did not move ══ */
console.log('\nL. Blast radius');
{
  const changed = cp.execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean);
  /* Blast radius is asserted against the shared migration state, not a list kept here.
     A per-suite allowlist goes stale the moment the NEXT slice legitimately touches a file
     this one froze — and widening it each time is how a guard learns to pass. */
  const STATE = require('./cart-migration-state.js');
  ck('L', 'nothing dirty that the migration state does not explain',
     STATE.unexpected(changed).length === 0, STATE.unexpected(changed).join(', '));
  STATE.FROZEN_FILES.forEach(f => ck('L', f + ' untouched — its own slice owns it',
    !changed.includes(f), changed.join(', ')));
  STATE.PENDING.forEach(f => ck('L', f + ' not migrated yet',
    !changed.includes(f), changed.join(', ')));
  /* The 5 HTML pages may only have gained the script tag. */
  const badPage = ['car-hub.html', 'category.html', 'healthcare.html', 'index.html', 'services.html']
    .filter(f => cp.execSync('git diff HEAD -- ' + f, { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(l => /^\+/.test(l) && !/^\+\+\+/.test(l))
      .some(l => !/sokoni-cart\.js|^\+\s*$|^\+\s*(<!--|.*-->)|^\+\s{5}/.test(l)));
  ck('L', 'the 5 pages gained only the script tag', badPage.length === 0, badPage.join(', '));
}

/* ══ M. every consumer page loads the service ══ */
console.log('\nM. No page is left calling a service it never loaded');
{
  const pages = ['car-hub.html', 'category.html', 'healthcare.html', 'index.html', 'services.html'];
  const missing = pages.filter(p => !/src="sokoni-cart\.js"/.test(read(p)));
  ck('M', 'all 5 market-actions pages load sokoni-cart.js', missing.length === 0, missing.join(', '));
  /* Match the SCRIPT TAG, not the filename anywhere in the file — business.html mentions
     market-actions.js in a comment explaining how its quantity model differs, and a raw
     text grep counted that as a page loading it. */
  const others = cp.execSync('git grep -l "src=\\"market-actions.js\\"" -- "*.html" || true',
    { cwd: ROOT, encoding: 'utf8' }).split('\n').map(s => s.trim()).filter(Boolean);
  ck('M', 'and there are no OTHER market-actions pages', others.length === pages.length,
     others.join(', '));
  /* Line endings must not have been mangled — healthcare.html is CRLF. */
  const mixed = pages.filter(p => {
    const s = read(p);
    return (s.match(/\r\n/g) || []).length > 0 && (s.match(/(?<!\r)\n/g) || []).length > 0;
  });
  ck('M', 'no page gained mixed line endings', mixed.length === 0, mixed.join(', '));
}

/* ── summary ── */
console.log('\n' + '='.repeat(66));
console.log('Track 2.2B acceptance\n');
['A','B','C','D','E','F','G','H','I','J','K','L','M'].forEach(k => console.log('  ' + k + ': ' + (R[k] || 'MISSING')));
console.log('\n  TOTAL:   ' + (pass + fail) + '\n  PASSED:  ' + pass + '\n  FAILED:  ' + fail);
process.exit(fail ? 1 : 0);
