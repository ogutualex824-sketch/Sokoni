#!/usr/bin/env node
/* Track 2.4 — the checkout boundary.
 *
 *   firebase emulators:exec --only firestore --project sokoni-cart-checkout-test \
 *     "node scripts/test-cart-checkout.js"
 *
 * Checkout is a money path, so the assertions are about SHAPE and TIMING, not about the
 * migration being tidy. Block B replays the service's output through the REAL
 * verifyIntasendPayment price cross-check against a real emulator catalogue: if the array
 * that reaches the server changed in any way that matters, the amount it demands changes
 * with it and this fails.
 *
 * Block D is the defect this slice found: post-order clearing used
 * localStorage.removeItem('cart'), which provider-wiring.js's setItem bridge cannot see —
 * so the sokoniCart mirror kept the ordered items and the next page load pushed them back
 * into the cart. Reproduced against the shipped bridge, both ways.
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-cart-checkout-test';

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
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 92) + ']' : ''));
  ok ? pass++ : fail++;
  if (R[g] !== 'FAIL') R[g] = ok ? 'PASS' : 'FAIL';
}
const read = (f) => fs.readFileSync(path.resolve(ROOT, f), 'utf8');
const execOf = (f) => stripComments(f.endsWith('.html')
  ? keepOnly(read(f), htmlScriptRegions(read(f))) : read(f));
const CHECKOUT = execOf('checkout.html');

function sandbox(opts) {
  opts = opts || {};
  const store = Object.assign({}, opts.seed || {});
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
    location: { pathname: '/checkout.html', href: '', search: '', reload() { g.reloaded = true; } },
  };
  g.window = g; g.store = store;
  /* provider-wiring.js wires DOM listeners at load; the bridge under test lives in the
     same file, so the sandbox needs a document for it to evaluate at all. */
  g.document = {
    addEventListener: () => {}, removeEventListener: () => {},
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {} }),
    body: { appendChild() {} }, head: { appendChild() {} }, readyState: 'complete',
  };
  vm.createContext(g);
  if (!opts.withoutService) vm.runInContext(read('sokoni-cart.js'), g);
  if (opts.withBridge) vm.runInContext(read('provider-wiring.js'), g);
  return g;
}

/* Fixtures in the shapes the migrated writers now produce. */
const CART = [
  { id: 'ck1', name: 'Unga 2kg', price: 250, image: 'u.png', category: 'Food',
    sellerUid: 'seller-A', sellerId: 'seller-A', sellerName: 'Duka A',
    sellerLat: -1.2921, sellerLng: 36.8219, qty: 2 },
  { id: 'ck2', name: 'Sukari 1kg', price: 180, image: 's.png', sellerUid: 'seller-A' },
];

(async () => {
console.log('\nTRACK 2.4 — CHECKOUT BOUNDARY\n' + '='.repeat(70));
await db.collection('products').doc('ck1').set({ name: 'Unga 2kg', price: 250 });
await db.collection('products').doc('ck2').set({ name: 'Sukari 1kg', price: 180 });

/* ══ A. the payload SHAPE is byte-identical to the legacy read ══ */
console.log('\nA. orderItems is the same array the legacy read produced');
{
  const legacy = JSON.parse(JSON.stringify(CART));            /* what JSON.parse(getItem) gave */
  const g = sandbox({ seed: { cart: JSON.stringify(CART) } });
  const viaService = g.SokoniCart.list();
  ck('A', 'deep-equal to the legacy parse', JSON.stringify(viaService) === JSON.stringify(legacy),
     JSON.stringify(viaService).slice(0, 80));
  ck('A', 'same key order, field for field',
     JSON.stringify(Object.keys(viaService[0])) === JSON.stringify(Object.keys(legacy[0])),
     JSON.stringify(Object.keys(viaService[0])));
  ck('A', 'sellerLat/sellerLng survive for pickupCoords',
     viaService[0].sellerLat === -1.2921 && viaService[0].sellerLng === 36.8219);
  ck('A', 'qty survives for the server cross-check', viaService[0].qty === 2, viaService[0].qty);
  ck('A', 'the service adds nothing', Object.keys(viaService[0]).length === Object.keys(legacy[0]).length);
}

/* ══ B. THE MONEY CONTRACT — replayed through the real server arithmetic ══ */
console.log('\nB. verifyIntasendPayment demands the same amount as before');
{
  /* Transcribed from functions/index.js:2745-2768 — the fallback catalogue cross-check. */
  async function serverTotal(orderItems) {
    const ids = [...new Set(orderItems.map(i => String(i.id || i.productId || '')).filter(Boolean))];
    const priceMap = {};
    for (let ci = 0; ci < ids.length; ci += 10) {
      const snap = await db.collection('products')
        .where(admin.firestore.FieldPath.documentId(), 'in', ids.slice(ci, ci + 10)).get();
      snap.forEach(d => { priceMap[d.id] = d.data(); });
    }
    let total = 0;
    for (const item of orderItems) {
      const pid = String(item.id || item.productId || '');
      if (!pid || !priceMap[pid]) continue;
      const p = priceMap[pid];
      total += Number(p.salePrice || p.price || 0) *
               Math.max(1, Number(item.qty) || Number(item.quantity) || 1);
    }
    return total;
  }
  const legacyTotal = await serverTotal(JSON.parse(JSON.stringify(CART)));
  const g = sandbox({ seed: { cart: JSON.stringify(CART) } });
  const serviceTotal = await serverTotal(g.SokoniCart.list());
  ck('B', 'the server prices the service payload identically',
     serviceTotal === legacyTotal, serviceTotal + ' vs ' + legacyTotal);
  ck('B', 'and that total is right (250x2 + 180)', serviceTotal === 680, serviceTotal);
  /* cartForSession, the other server-facing mapping */
  const session = g.SokoniCart.list().map(i => ({
    productId: String(i.id || i.productId || ''),
    qty: Math.max(1, Math.round(Number(i.qty) || Number(i.quantity) || 1)),
  })).filter(i => i.productId);
  ck('B', 'cartForSession maps to the same pairs',
     JSON.stringify(session) === JSON.stringify([{ productId: 'ck1', qty: 2 }, { productId: 'ck2', qty: 1 }]),
     JSON.stringify(session));
}

/* ══ C. TIMING — the snapshot is still a snapshot ══ */
console.log('\nC. The parse-time snapshot did not become a live read');
{
  ck('C', 'cart is captured once, into a const', /const cart = _ckCart \? _ckCart\.list\(\) : null/.test(CHECKOUT));
  ck('C', 'orderItems still sends that snapshot verbatim', /orderItems: cart/.test(CHECKOUT));
  /* The two reads that were deliberately FRESH must still be fresh. */
  ck('C', 'the M-Pesa seller lookup still reads at send time',
     /currentCart2 = \(window\.SokoniCart \? window\.SokoniCart\.list\(\) : \[\]\)/.test(CHECKOUT));
  ck('C', 'pickupCoords still reads at payload-build time',
     /pickupCoords[\s\S]{0,120}SokoniCart[\s\S]{0,40}list\(\)/.test(CHECKOUT));
  ck('C', 'saveAndRedirect still reads fresh, after seller-wiring has snapshotted',
     /function saveAndRedirect\([\s\S]{0,400}window\.SokoniCart \? window\.SokoniCart\.list\(\)/.test(CHECKOUT));
}

/* ══ D. THE DEFECT — post-order clearing now clears the mirror too ══ */
console.log('\nD. Ordered items no longer reappear after checkout');
{
  function orderThenReload(clearWith) {
    const g = sandbox({ withBridge: true });
    g.localStorage.setItem('cart', JSON.stringify(CART));      /* shopping, via the bridge */
    const mirrored = g.store.sokoniCart;
    if (clearWith === 'removeItem') g.localStorage.removeItem('cart');
    else g.SokoniCart.clear();
    /* next page load: provider-wiring re-runs and calls _mergeCarts() */
    const g2 = sandbox({ withBridge: true, seed: g.store });
    return { mirrored: mirrored, afterReload: g2.store.cart };
  }
  /* RETIRED by 2.6. Two CONTROLs here demonstrated the defect live: that the bridge
     mirrored every cart write, and that clearing with removeItem therefore left the items
     to be restored on the next load. 2.6 deleted the bridge, so the MECHANISM no longer
     exists and neither control can run — which is the correct outcome, not a regression.
     The fix itself is still asserted below, and the reproduction is preserved in the 2.4
     commit message and in docs/CART_PERSISTENCE_AUDIT.md. */
  ck('D', 'the bridge that caused it is gone — nothing mirrors cart writes now',
     !orderThenReload('removeItem').mirrored,
     String(orderThenReload('removeItem').mirrored));
  ck('D', 'so removeItem can no longer resurrect anything either',
     JSON.parse(orderThenReload('removeItem').afterReload || '[]').length === 0);
  const good = orderThenReload('clear');
  ck('D', 'SokoniCart.clear() leaves nothing to restore',
     JSON.parse(good.afterReload || '[]').length === 0, good.afterReload);
  ck('D', 'all three checkout clears use the service', !/removeItem\(['"]cart['"]\)/.test(CHECKOUT));
  ck('D', 'there are still exactly three of them',
     (CHECKOUT.match(/SokoniCart\.clear\(\)/g) || []).length === 3,
     (CHECKOUT.match(/SokoniCart\.clear\(\)/g) || []).length);
}

/* ══ E. unknown is not empty, on the money path ══ */
console.log('\nE. A cart it cannot read is not rendered as an empty cart');
{
  ck('E', 'the null branch exists before the empty-cart guard',
     CHECKOUT.indexOf('cart === null') > -1 &&
     CHECKOUT.indexOf('cart === null') < CHECKOUT.indexOf('cart.length === 0'));
  ck('E', 'it does NOT say the cart is empty', (function () {
    const i = CHECKOUT.indexOf('cart === null');
    return !/Your cart is empty/.test(CHECKOUT.slice(i, i + 900));
  })());
  ck('E', 'it disables Place Order by its real selector', /co-place-btn/.test(CHECKOUT));
  ck('E', 'the Place Order button really carries that class',
     /class="co-place-btn"[^>]*onclick="placeOrder\(\)"/.test(read('checkout.html')));
  /* Scoped to the guard block rather than a fixed-width window: the innerHTML string
     inside it runs to ~1150 characters, so a 900-char window was measuring the markup
     and not the control flow. */
  {
    const i = CHECKOUT.indexOf('cart === null');
    const block = CHECKOUT.slice(i, i + 2500);
    ck('E', 'and it throws rather than letting the rest of the page run',
       /throw new Error/.test(block) &&
       block.indexOf('throw new Error') < block.indexOf('cart.length === 0'),
       'throw@' + block.indexOf('throw new Error') + ' emptyGuard@' + block.indexOf('cart.length === 0'));
  }
}

/* ══ F. seller stock decrement ══ */
console.log('\nF. Stock decrement: unknown cart must not read as empty');
{
  const sw = stripComments(read('seller-wiring.js'));
  /* This block used to assert the INTERNALS of _patchCheckout's wrapper: that it snapshotted
     the cart before saveAndRedirect cleared it, that a missing service produced null rather
     than [], and that the decrement only ran on a real cart. Every one of those was a careful
     guard around a client-side stock write.

     0e13db2 and 6daec0b retired that write. The client is no longer an inventory writer, so
     the wrapper has nothing to snapshot FOR — seller-wiring.js removes it rather than emptying
     it, precisely so it cannot be refilled. Asserting the old internals here made the suite
     fail for having got what it wanted, which is the most misleading way a test can fail.

     What is worth guarding now is the ABSENCE. The positive property — that no client-side
     inventory writer returns — is owned by scripts/gate-inventory-writers.js (with its own
     meta-test, scripts/test-gate-inventory-writers.js); this block asserts only the local
     shape, so the two cannot drift into disagreeing about who checks what. */
  {
    const fnStart = sw.indexOf('function _patchCheckout');
    ck('F', '_patchCheckout still exists as a call target', fnStart > -1);
    /* Brace-matched, NOT a fixed-width window. The old code took 1400 characters because the
       wrapper was long; now that the body is a single no-op line, any fixed window overruns
       into the NEXT patch — and seller-wiring.js has five orig.apply call sites, so the
       overrun found one and reported the wrapper as still present. The window has to follow
       the function, not a guess about its length. */
    const open = sw.indexOf('{', fnStart);
    let depth = 0, end = -1;
    for (let i = open; i < sw.length; i++) {
      if (sw[i] === '{') depth++;
      else if (sw[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    ck('F', '...and its body is locatable', end > -1);
    const patch = sw.slice(fnStart, end);
    ck('F', '...but it no longer wraps the original',
       patch.indexOf('orig.apply(this, a)') === -1,
       'orig@' + patch.indexOf('orig.apply(this, a)'));
    ck('F', '...and it no longer snapshots the cart for a stock write',
       patch.indexOf('cartItems = C.list()') === -1,
       'snapshot@' + patch.indexOf('cartItems = C.list()'));
  }
  ck('F', 'no client-side stock decrement remains in seller-wiring.js',
     !/stock was NOT decremented/i.test(sw) && !/_decrementStock\s*\(/.test(sw));
  ck('F', 'no localStorage cart read remains',
     !/localStorage\s*(?:\.\s*getItem\s*\(\s*|\[\s*)["']cart["']/.test(sw));
  ck('F', 'checkout.html loads the service this path depends on',
     /src="sokoni-cart\.js"/.test(read('checkout.html')));
}

/* ══ G. load order ══ */
console.log('\nG. The service loads before every consumer on the page');
{
  const html = read('checkout.html');
  const svc = html.indexOf('src="sokoni-cart.js"');
  ck('G', 'the tag exists', svc > -1);
  ck('G', 'it is NOT deferred',
     !/<script[^>]*src="sokoni-cart\.js"[^>]*\bdefer\b/.test(html));
  ck('G', 'it precedes the inline block that snapshots the cart',
     svc > -1 && svc < html.indexOf('const cart = _ckCart'));
  ck('G', 'it precedes checkout.js', svc < html.indexOf('src="checkout.js"'));
  ck('G', 'it precedes the payment SDK wiring', svc < html.indexOf('function saveAndRedirect'));
}

/* ══ H. removeCartItem ══ */
console.log('\nH. Removing a checkout line');
{
  const g = sandbox({ seed: { cart: JSON.stringify([...CART, { id: 'ck1', price: 250 }]) } });
  vm.runInContext(stripComments(read('checkout.html'))
    .match(/window\.removeCartItem = function[\s\S]*?\n\};/)[0], g);
  g.removeCartItem(0);
  const left = JSON.parse(g.store.cart);
  ck('H', 'exactly one row removed', left.length === 2, left.length);
  ck('H', 'the duplicate of that product survives — row, not product',
     left.filter(i => i.id === 'ck1').length === 1, JSON.stringify(left.map(i => i.id)));
  ck('H', 'it reloads only after the removal landed', g.reloaded === true);
  const g2 = sandbox({ seed: { cart: JSON.stringify(CART) } });
  vm.runInContext(stripComments(read('checkout.html'))
    .match(/window\.removeCartItem = function[\s\S]*?\n\};/)[0], g2);
  g2.removeCartItem(99);
  ck('H', 'an out-of-range index does not reload', g2.reloaded !== true);
  ck('H', 'and changes nothing', JSON.parse(g2.store.cart).length === 2);
}

/* ══ I. perimeter — provider-wiring is 2.6, nothing else moved ══ */
console.log('\nI. Perimeter');
{
  const changed = cp.execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean);
  /* These asserted the 2.5 and 2.6 boundaries had not been crossed yet. Both slices have
     since run, so they are inverted: what must hold now is that the CART interceptor is
     gone while the unrelated provider/booking watchers are not. */
  ck('I', 'the cart interceptor is gone from provider-wiring.js',
     !/["'](cart|sokoniCart)["']/.test(execOf('provider-wiring.js')));
  ck('I', 'its two unrelated setItem watchers survive',
     (execOf('provider-wiring.js').match(/localStorage\.setItem\s*=/g) || []).length === 2);
  ck('I', 'shared-header.js is migrated',
     !/localStorage\s*\.\s*getItem\s*\(\s*['"]cart['"]/.test(execOf('shared-header.js')));
  ck('I', 'nothing dirty the migration state does not explain',
     STATE.unexpected(changed).length === 0, STATE.unexpected(changed).join(', '));
  /* Repo-wide: checkout and seller-wiring should no longer be survivors. */
  const hits = SCAN.scan().filter(h => h.key === 'cart');
  const files = [...new Set(hits.map(h => h.file))];
  ck('I', 'checkout.html no longer touches the cart directly', !files.includes('checkout.html'),
     files.join(', '));
  ck('I', 'seller-wiring.js no longer touches the cart directly', !files.includes('seller-wiring.js'));
  /* Was "exactly the 2.5/2.6 set". Those phases have run; nothing is left but the
     service and the classified harness. */
  ck('I', 'nothing but the service and the harness touches the cart',
     files.filter(f => f !== 'sokoni-cart.js' && !STATE.TEST_HARNESS.includes(f)).length === 0,
     files.join(', '));
}

console.log('\n' + '='.repeat(70));
console.log('Track 2.4 acceptance\n');
['A','B','C','D','E','F','G','H','I'].forEach(k => console.log('  ' + k + ': ' + (R[k] || 'MISSING')));
console.log('\n  TOTAL:   ' + (pass + fail) + '\n  PASSED:  ' + pass + '\n  FAILED:  ' + fail);
process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR:', e); process.exit(2); });
