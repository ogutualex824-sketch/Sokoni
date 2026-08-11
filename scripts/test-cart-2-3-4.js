#!/usr/bin/env node
/* Track 2.3 surface 4 — flashsale.html, business.html, ministore.html on SokoniCart.
 *
 *   node scripts/test-cart-2-3-4.js
 *
 * Three surfaces in one slice because they are three variants of the same small pattern,
 * and the point is that each keeps its OWN semantics:
 *
 *   flashsale   append, and a Buy Now that navigates      (3rd copy of that defect)
 *   business    merge by id with a qty bump
 *   ministore   merge by id, guarded against food rows
 *
 * A migration that quietly unified those three would be the failure mode, so the suite
 * asserts the differences as hard as it asserts the fixes.
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

function sandbox(opts) {
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
  g.window = g; g.store = store; g.toasts = [];
  g.location = { href: 'page.html' };
  const els = {}; g.els = els;
  g.document = {
    getElementById: (id) => (els[id] = els[id] || { textContent: '', innerText: '', style: {} }),
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, remove() {} }),
    querySelector: () => null, querySelectorAll: () => [],
    body: { appendChild() {} }, head: { appendChild() {} },
    addEventListener: () => {},
  };
  vm.createContext(g);
  if (!opts.withoutService) vm.runInContext(read('sokoni-cart.js'), g);
  return g;
}
const cartOf = (g) => JSON.parse(g.store.cart || '[]');
const said = (g, re) => g.toasts.some(t => re.test(t));

/* ── flashsale ── */
function flash(opts) {
  const g = sandbox(opts);
  const src = read('flashsale.html');
  g.showToast = (m) => g.toasts.push(m);
  g.allProducts = [{ id: 'f1', name: 'Kettle', price: 1200, image: 'k.png' }];
  g.flashProducts = g.allProducts;
  g.DEMO_FLASH = [];
  vm.runInContext(['function _findProduct(id){ return allProducts.find(p=>p.id===id)||null; }',
    sliceFn(src, 'function _fsCart('), sliceFn(src, 'function fsAddCart('),
    sliceFn(src, 'function fsBuyNow('), sliceFn(src, 'function updateCartPips(')].join('\n'), g);
  return g;
}
/* ── business ── */
function biz(opts) {
  const g = sandbox(opts);
  g.showToast = (m) => g.toasts.push(m);
  g.BIZ_ID = 'biz-1';
  g.skNavRefresh = () => {};
  vm.runInContext(sliceFn(read('business.html'), 'window.bizAddToCart ='), g);
  return g;
}
/* ── ministore ── */
function mini(opts) {
  const g = sandbox(opts);
  g.toast = (m) => g.toasts.push(m);
  g.getProds = () => [{ id: 'm1', name: 'Kanga cloth', price: 700, image: 'm.png' }];
  vm.runInContext(sliceFn(read('ministore.html'), 'function addToCartFromStore('), g);
  return g;
}

console.log('\nTRACK 2.3 · surface 4 — flashsale / business / ministore\n' + '='.repeat(66));

/* ══ A. flashsale keeps APPEND semantics ══ */
console.log('\nA. flashsale appends, and carries the flash price');
{
  const g = flash();
  g.fsAddCart('f1', 899);
  g.fsAddCart('f1', 899);
  const c = cartOf(g);
  ck('A', 'two rows — append, not merge', c.length === 2, c.length);
  ck('A', 'the FLASH price is stored, not the catalogue price', c[0].price === 899, c[0].price);
  ck('A', 'the rest of the product is intact', c[0].name === 'Kettle' && c[0].image === 'k.png');
  ck('A', 'success toast', said(g, /Added to cart/), JSON.stringify(g.toasts));
}

/* ══ B. THE THIRD BUY-NOW COPY ══ */
console.log('\nB. flashsale Buy Now — the third navigate-on-failure copy');
{
  const ok = flash({ seed: { cart: JSON.stringify([{ id: 'old', price: 1 }]) } });
  ok.fsBuyNow('f1', 899);
  ck('B', 'appends rather than replacing (this surface never replaced)',
     cartOf(ok).length === 2 && cartOf(ok).some(i => i.id === 'old'),
     JSON.stringify(cartOf(ok).map(i => i.id)));
  ck('B', 'navigates on success', ok.location.href === 'checkout.html', ok.location.href);

  const bad = flash({ seed: { cart: JSON.stringify([{ id: 'old', price: 1 }]) }, failWrite: true });
  const before = bad.location.href;
  bad.fsBuyNow('f1', 899);
  ck('B', 'a failed write does NOT navigate', bad.location.href === before, bad.location.href);
  ck('B', 'the previous cart is intact', cartOf(bad).length === 1 && cartOf(bad)[0].id === 'old',
     JSON.stringify(cartOf(bad)));
  ck('B', 'the shopper is told', said(bad, /Couldn't start checkout/), JSON.stringify(bad.toasts));
}

/* ══ C. flashsale add failure ══ */
console.log('\nC. flashsale add reports failure instead of claiming success');
{
  const g = flash({ failWrite: true });
  g.fsAddCart('f1', 899);
  ck('C', 'nothing stored', !g.store.cart, String(g.store.cart));
  ck('C', 'no success toast', !said(g, /Added to cart/), JSON.stringify(g.toasts));
  ck('C', 'failure surfaced', said(g, /Couldn't add to cart/), JSON.stringify(g.toasts));
}

/* ══ D. flashsale pips — already units, unchanged ══ */
console.log('\nD. flashsale pips still count units (this badge number does not move)');
{
  const g = flash({ seed: { cart: JSON.stringify([{ id: 'x', price: 5, qty: 4 }]) } });
  g.updateCartPips();
  const headerFormula = cartOf(g).reduce((s, i) => s + (i.qty || 1), 0);
  ck('D', 'pip shows units', Number(g.els.bnavCartPip.textContent) === headerFormula,
     g.els.bnavCartPip.textContent + ' vs ' + headerFormula);
  const off = flash({ withoutService: true, seed: { cart: JSON.stringify([{ id: 'x', price: 5 }]) } });
  off.updateCartPips();
  ck('D', 'with no service the pip is blank, never 0', off.els.bnavCartPip.textContent === '',
     JSON.stringify(off.els.bnavCartPip.textContent));
  ck('D', 'and hidden rather than asserting an empty cart',
     off.els.bnavCartPip.style.display === 'none', off.els.bnavCartPip.style.display);
}

/* ══ E. business — merge by id, qty bump ══ */
console.log('\nE. business.html merges by id and bumps qty');
{
  const g = biz();
  g.bizAddToCart('b1', 'Chai', 120, 'c.png');
  g.bizAddToCart('b1', 'Chai', 120, 'c.png');
  g.bizAddToCart('b2', 'Sukari', 90, 's.png');
  const c = cartOf(g);
  ck('E', 'two rows, not three', c.length === 2, c.length);
  ck('E', 'the repeated item is qty 2', c[0].qty === 2, JSON.stringify(c[0]));
  ck('E', 'businessId preserved', c[0].businessId === 'biz-1', c[0].businessId);
  ck('E', 'price coerced to a number as before', typeof c[0].price === 'number', typeof c[0].price);
  ck('E', 'the merged row still charges for two units',
     c[0].price * c[0].qty === 240, c[0].price * c[0].qty);
  ck('E', 'success toast', said(g, /Added to cart/), JSON.stringify(g.toasts));
}

/* ══ F. business failure ══ */
console.log('\nF. business.html reports a failed write');
{
  const g = biz({ failWrite: true });
  const r = g.bizAddToCart('b1', 'Chai', 120, 'c.png');
  ck('F', 'returns false', r === false, String(r));
  ck('F', 'nothing stored', !g.store.cart, String(g.store.cart));
  ck('F', 'no success toast', !said(g, /Added to cart!/), JSON.stringify(g.toasts));
  ck('F', 'failure surfaced', said(g, /Could not add to cart/), JSON.stringify(g.toasts));
}

/* ══ G. ministore — merge by id, must not touch food rows ══ */
console.log('\nG. ministore.html merges by id and leaves food rows alone');
{
  const g = mini();
  g.addToCartFromStore('m1');
  g.addToCartFromStore('m1');
  ck('G', 'one row at qty 2', cartOf(g).length === 1 && cartOf(g)[0].qty === 2,
     JSON.stringify(cartOf(g)));

  /* A food row that shares nothing but shape — it keys on itemId and carries a cartId. */
  const withFood = mini({ seed: { cart: JSON.stringify([
    { type: 'food', cartId: 'CI1', itemId: 'm1', name: 'Fish', price: 800, qty: 2, note: 'extra' },
  ]) } });
  withFood.addToCartFromStore('m1');
  const c = withFood.raw ? withFood.raw() : cartOf(withFood);
  ck('G', 'the food row was NOT merged into', c.length === 2, JSON.stringify(c.map(i => i.type || 'product')));
  ck('G', 'the food row keeps its qty and note',
     c[0].qty === 2 && c[0].note === 'extra', JSON.stringify(c[0]));
  ck('G', 'the store product is its own row', c[1].id === 'm1' && !c[1].cartId, JSON.stringify(c[1]));
}

/* ══ H. ministore failure — previously swallowed entirely ══
   The bare setItem threw before toast() ran, so the shopper saw NOTHING: no confirmation
   and no error. */
console.log('\nH. ministore.html no longer swallows the failure silently');
{
  const g = mini({ failWrite: true });
  const r = g.addToCartFromStore('m1');
  ck('H', 'returns false', r === false, String(r));
  ck('H', 'nothing stored', !g.store.cart, String(g.store.cart));
  ck('H', 'no success toast', !said(g, /added to cart/), JSON.stringify(g.toasts));
  ck('H', 'the shopper is now told something', g.toasts.length > 0 && said(g, /Could not add/),
     JSON.stringify(g.toasts));
}

/* ══ I. all three fail closed with no service ══ */
console.log('\nI. All three fail closed, with no legacy fallback');
{
  const seed = { cart: JSON.stringify([{ id: 'keep', price: 1 }]) };
  const f = flash({ withoutService: true, seed }), b = biz({ withoutService: true, seed }),
        m = mini({ withoutService: true, seed });
  f.fsAddCart('f1', 1); f.fsBuyNow('f1', 1);
  b.bizAddToCart('b1', 'X', 1, 'x.png');
  m.addToCartFromStore('m1');
  [['flashsale', f], ['business', b], ['ministore', m]].forEach(([n, g]) => {
    ck('I', n + ': did not write legacy storage',
       cartOf(g).length === 1 && cartOf(g)[0].id === 'keep', JSON.stringify(cartOf(g)));
    ck('I', n + ': told the shopper the cart is loading',
       said(g, /still loading/i), JSON.stringify(g.toasts));
  });
  ck('I', 'flashsale did not navigate', f.location.href !== 'checkout.html', f.location.href);
}

/* ══ J. no legacy persistence, page scope clean ══ */
console.log('\nJ. No direct cart persistence left on any of the three');
{
  ['flashsale.html', 'business.html', 'ministore.html'].forEach(f => {
    const code = execOf(f);
    ck('J', f + ': no localStorage cart access',
       !/localStorage\s*(?:\.\s*(?:get|set|remove)Item\s*\(\s*|\[\s*)["']cart["']/.test(code));
    ck('J', f + ': loads the service', /src="sokoni-cart\.js"/.test(read(f)));
    /* Page scope, resolved through the constant-aware scanner. */
    const { hits } = SCAN.pageScope(f);
    const writers = hits.filter(h => h.key === 'cart' && h.kind === 'WRITE' && h.file !== 'sokoni-cart.js');
    ck('J', f + ': page scope has no other cart writer', writers.length === 0,
       writers.map(h => h.file + ':' + h.line).join(', '));
  });
}

/* ══ K. perimeter ══ */
console.log('\nK. Frozen perimeter, deferred surface, unmigrated surfaces');
{
  const changed = cp.execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean);
  const STATE = require('./cart-migration-state.js');
  ck('K', 'nothing dirty the migration state does not explain',
     STATE.unexpected(changed).length === 0, STATE.unexpected(changed).join(', '));
  STATE.FROZEN.forEach(f => ck('K', f + ' FROZEN', !changed.includes(f), changed.join(', ')));
  STATE.DEFERRED.forEach(f => ck('K', f + ' DEFERRED to 2.5 — untouched',
    !changed.includes(f), changed.join(', ')));
  STATE.PENDING.forEach(f => ck('K', f + ' not migrated yet', !changed.includes(f), changed.join(', ')));
}

console.log('\n' + '='.repeat(66));
console.log('Track 2.3 surface 4 acceptance\n');
['A','B','C','D','E','F','G','H','I','J','K'].forEach(k => console.log('  ' + k + ': ' + (R[k] || 'MISSING')));
console.log('\n  TOTAL:   ' + (pass + fail) + '\n  PASSED:  ' + pass + '\n  FAILED:  ' + fail);
process.exit(fail ? 1 : 0);
