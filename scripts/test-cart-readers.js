#!/usr/bin/env node
/* Track 2.3 surface 7 — cart READERS.
 *
 *   node scripts/test-cart-readers.js
 *
 * Migrated here: cart.html's two inline readers, food.html's pip, and profile.js's dead
 * count. Two were NOT migrated, deliberately, and this suite asserts they were left alone
 * for the stated reason rather than forgotten:
 *
 *   shared-header.js  loaded on 311 pages, of which only a handful load sokoni-cart.js.
 *                     Migrating it would hide the cart badge on the rest.
 *   seller-wiring.js  its cart read only ever executes on checkout.html, which is FROZEN
 *                     and therefore cannot load the service. Migrating it would silently
 *                     stop post-order stock decrements.
 *
 * The general rule under test: a reader that cannot read must say "unknown", never 0.
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
  const els = {};
  const g = {
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => true,
    CustomEvent: function (t, o) { this.type = t; this.detail = o && o.detail; },
    setTimeout, clearTimeout, console,
    JSON, Date, Math, String, Number, Object, Array, Promise, Error, Set, RegExp, isNaN, parseInt, parseFloat,
  };
  g.window = g; g.store = store; g.els = els;
  g.document = {
    getElementById: (id) => (els[id] = els[id] || { textContent: '', innerText: '', style: {} }),
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }),
    querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {},
    body: { appendChild() {} }, head: { appendChild() {} },
  };
  vm.createContext(g);
  if (!opts.withoutService) vm.runInContext(read('sokoni-cart.js'), g);
  return g;
}

const SEED = JSON.stringify([
  { id: 'a', name: 'A', price: 100, qty: 3 },
  { id: 'b', name: 'B', price: 50 },
]);
/* units = 3 + 1 = 4 ; lines = 2 ; subtotal = 300 + 50 = 350 */

console.log('\nTRACK 2.3 · surface 7 — cart readers\n' + '='.repeat(66));

/* ══ A. cart.html hero count ══ */
console.log('\nA. cart.html hero count reports UNITS');
{
  const g = sandbox({ seed: { cart: SEED } });
  vm.runInContext(sliceFn(read('cart.html'), 'function _updateHeroCount('), g);
  const fn = g._updateHeroCount;
  ck('A', 'the hero-count function was found in the page', typeof fn === 'function');
  if (typeof fn === 'function') {
    fn();
    ck('A', 'renders 4 items — units, not the 2 lines', /4 items/.test(g.els.cartHeroCount.textContent),
       g.els.cartHeroCount.textContent);
    const off = sandbox({ withoutService: true, seed: { cart: SEED } });
    vm.runInContext(sliceFn(read('cart.html'), 'function _updateHeroCount('), off);
    off._updateHeroCount();
    ck('A', 'without the service it says loading, never "0 items"',
       !/0 item/.test(off.els.cartHeroCount.textContent) && /Loading/i.test(off.els.cartHeroCount.textContent),
       off.els.cartHeroCount.textContent);
  }
}

/* ══ B. cart.html subtotal — money, and null when unknown ══ */
console.log('\nB. cart.html _cartSubtotal returns null rather than a fabricated 0');
{
  const g = sandbox({ seed: { cart: SEED } });
  vm.runInContext(sliceFn(read('cart.html'), 'function _cartSubtotal('), g);
  ck('B', 'subtotal is price x qty summed', g._cartSubtotal() === 350, g._cartSubtotal());
  const off = sandbox({ withoutService: true, seed: { cart: SEED } });
  vm.runInContext(sliceFn(read('cart.html'), 'function _cartSubtotal('), off);
  ck('B', 'null when the cart cannot be read', off._cartSubtotal() === null, String(off._cartSubtotal()));
  /* And the consumer must not paint invented KES figures from it. */
  /* Assert on the CONSUMER's own body rather than on a character-distance window in the
     whole file — the first version matched across the function boundary and depended on
     how much comment text sat between the two functions. */
  const promo = stripComments(sliceFn(read('cart.html'), 'function _applyPromoToSummary('));
  const guardAt = promo.search(/sub\s*===\s*null/);
  const firstUse = promo.search(/sub\s*[*.\-)]|sub\.toLocaleString|Math\.round\(\s*sub/);
  ck('B', '_applyPromoToSummary guards on null', guardAt > -1, promo.slice(0, 90));
  ck('B', 'and the guard comes BEFORE any use of the value',
     guardAt > -1 && (firstUse === -1 || guardAt < firstUse), 'guard@' + guardAt + ' use@' + firstUse);
  ck('B', 'it returns rather than falling through',
     /sub\s*===\s*null\s*\)\s*return/.test(promo));
  ck('B', 'the money arithmetic stays on the page, not in the service',
     !/subtotal/.test(stripComments(read('sokoni-cart.js'))));
}

/* ══ C. food.html pip ══ */
console.log('\nC. food.html pip reports units, blank when unknown');
{
  const src = execOf('food.html');
  ck('C', 'no localStorage cart read remains',
     !/localStorage\s*(?:\.\s*getItem\s*\(\s*|\[\s*)["']cart["']/.test(src));
  ck('C', 'reads units()', /SokoniCart[\s\S]{0,40}units\(\)/.test(src));
  ck('C', 'renders blank rather than 0 when the service is absent',
     /n==null\|\|!n\)\?''/.test(src.replace(/\s/g, '')) || /n==null/.test(src));
  ck('C', 'food.html loads the service', /src="sokoni-cart\.js"/.test(read('food.html')));
}

/* ══ D. profile.js dead reader removed ══ */
console.log('\nD. profile.js dead cart count removed, not rerouted');
{
  const src = stripComments(read('profile.js'));
  ck('D', 'no localStorage cart read',
     !/localStorage\s*(?:\.\s*getItem\s*\(\s*|\[\s*)["']cart["']/.test(src));
  ck('D', 'the #cartItemsCount render is gone', !/cartItemsCount/.test(src));
  ck('D', 'profile.html really has no such element', !/cartItemsCount/.test(read('profile.html')));
  ck('D', 'profile.js does NOT now depend on the cart service', !/SokoniCart/.test(src));
  ck('D', 'the reasoning is recorded for whoever adds a count back',
     /SokoniCart\.units\(\)/.test(read('profile.js')));
}

/* ══ E. shared-header.js DELIBERATELY NOT MIGRATED ══ */
console.log('\nE. shared-header.js left on its direct read — and why');
{
  const src = stripComments(read('shared-header.js'));
  ck('E', 'it still reads the cart directly',
     /localStorage\s*\.\s*getItem\s*\(\s*['"]cart['"]/.test(src));
  ck('E', 'it still counts units — the formula everything converged on',
     /reduce\(\(s,\s*i\)\s*=>\s*s\s*\+\s*\(i\.qty\s*\|\|\s*1\)/.test(src.replace(/\s+/g, ' ')) ||
     /i\.qty\s*\|\|\s*1/.test(src));
  /* The blocking fact, measured rather than asserted from memory. */
  const pages = cp.execSync('git grep -l "src=\\"shared-header.js\\"" -- "*.html" || true',
    { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const withSvc = pages.filter(p => /src="sokoni-cart\.js"/.test(read(p)));
  ck('E', 'it is loaded on far more pages than load the service',
     pages.length > 100 && withSvc.length < pages.length / 2,
     withSvc.length + ' of ' + pages.length + ' pages load sokoni-cart.js');
  ck('E', 'so migrating it would hide the badge on most of the platform',
     pages.length - withSvc.length > 100, (pages.length - withSvc.length) + ' pages would lose it');
}

/* ══ F. seller-wiring.js DELIBERATELY NOT MIGRATED ══ */
/* ── RETIRED by Track 2.4 ──────────────────────────────────────────────────────
   This block asserted that seller-wiring.js was BLOCKED: that it still read the cart
   directly, and that checkout.html was frozen and did not load the service. Every one of
   those was true and load-bearing at the close of 2.3 — and 2.4 was authorised precisely
   to change them. Unfreezing checkout is what unblocked this file.

   The assertions are replaced rather than deleted, so the block still fails if the
   migration regresses. What it now asserts is the state 2.4 established.
   ───────────────────────────────────────────────────────────────────────────── */
console.log('\nF. seller-wiring.js was unblocked by 2.4 and is now migrated');
{
  const src = stripComments(read('seller-wiring.js'));
  ck('F', 'no direct cart read remains',
     !/localStorage\s*\.\s*getItem\s*\(\s*['"]cart['"]/.test(src));
  ck('F', 'it reaches the cart through the service', /window\.SokoniCart/.test(src));
  ck('F', 'the read still feeds post-order stock decrements', /_decrementStock/.test(src));
  ck('F', 'it still only runs by patching saveAndRedirect', /saveAndRedirect/.test(src));
  ck('F', 'saveAndRedirect is still defined on checkout.html',
     /function saveAndRedirect|saveAndRedirect\s*=/.test(read('checkout.html')));
  ck('F', 'checkout.html now loads the service — the change 2.4 authorised',
     /src="sokoni-cart\.js"/.test(read('checkout.html')));
  const STATE = require('./cart-migration-state.js');
  ck('F', 'and neither file is a survivor any more',
     !STATE.FROZEN_FILES.includes('checkout.html') &&
     !STATE.BLOCKED_FILES.includes('seller-wiring.js'));
}

/* ══ G. no new persistence path anywhere in this slice ══ */
console.log('\nG. No reader gained a write path');
{
  ['cart.html', 'food.html', 'profile.js'].forEach(f => {
    const src = execOf(f);
    ck('G', f + ': no localStorage cart WRITE',
       !/localStorage\s*\.\s*setItem\s*\(\s*["']cart["']/.test(src));
    ck('G', f + ': no fallback to another cart store',
       !/localStorage\s*(?:\.\s*\w+Item\s*\(\s*|\[\s*)["'](sokoniCart|retrievedCart)["']/.test(src));
  });
}

/* ══ H. repo-wide state ══ */
console.log('\nH. Repo-wide picture through the constant-aware scanner');
{
  const STATE = require('./cart-migration-state.js');
  const hits = SCAN.scan().filter(h => h.key === 'cart');
  const unaccounted = [...new Set(hits.map(h => h.file))].filter(f =>
    f !== 'sokoni-cart.js' && !STATE.FROZEN_FILES.includes(f) && !STATE.DEFERRED_FILES.includes(f) &&
    !STATE.TEST_HARNESS.includes(f) && !STATE.PENDING.includes(f));
  ck('H', 'every remaining direct cart access is classified', unaccounted.length === 0,
     unaccounted.join(', '));
  ck('H', 'no unmigrated WRITER remains',
     hits.filter(h => h.kind === 'WRITE' && h.file !== 'sokoni-cart.js' &&
       !STATE.FROZEN_FILES.includes(h.file) && !STATE.DEFERRED_FILES.includes(h.file) &&
       !STATE.TEST_HARNESS.includes(h.file)).length === 0);
  /* Was "the TWO blocked readers". 2.4 unblocked seller-wiring.js, leaving one. Asserted
     as "every blocked entry is genuinely still unmigrated" rather than as a count, which
     is the property that actually matters and does not expire each slice. */
  ck('H', 'every BLOCKED entry still touches the cart directly',
     STATE.BLOCKED_FILES.every(f => [...new Set(hits.map(h => h.file))].includes(f)),
     STATE.BLOCKED_FILES.join(', '));
  ck('H', 'seller-wiring.js is no longer among them — 2.4 unblocked it',
     !STATE.BLOCKED_FILES.includes('seller-wiring.js'), STATE.BLOCKED_FILES.join(', '));
}

/* ══ I. perimeter ══ */
console.log('\nI. Frozen and deferred surfaces');
{
  const changed = cp.execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean);
  const STATE = require('./cart-migration-state.js');
  ck('I', 'nothing dirty the migration state does not explain',
     STATE.unexpected(changed).length === 0, STATE.unexpected(changed).join(', '));
  STATE.FROZEN_FILES.forEach(f => ck('I', f + ' FROZEN', !changed.includes(f)));
  STATE.DEFERRED_FILES.forEach(f => ck('I', f + ' DEFERRED to 2.5', !changed.includes(f)));
  ck('I', 'shared-header.js was reverted, not left half-migrated',
     !changed.includes('shared-header.js'), changed.join(', '));
  /* Was "seller-wiring.js untouched" — true while it was blocked, and 2.4 was authorised
     to change it. shared-header.js is the one that must still be untouched, and it is
     asserted above via STATE. */
  ck('I', 'seller-wiring.js is migrated, not blocked',
     !require('./cart-migration-state.js').BLOCKED_FILES.includes('seller-wiring.js'));
}

console.log('\n' + '='.repeat(66));
console.log('Track 2.3 surface 7 acceptance\n');
['A','B','C','D','E','F','G','H','I'].forEach(k => console.log('  ' + k + ': ' + (R[k] || 'MISSING')));
console.log('\n  TOTAL:   ' + (pass + fail) + '\n  PASSED:  ' + pass + '\n  FAILED:  ' + fail);
process.exit(fail ? 1 : 0);
