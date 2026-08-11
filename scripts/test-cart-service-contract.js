#!/usr/bin/env node
/* Track 2.2A — SokoniCart service contract. No emulator needed; no writer migrated.
 *
 *   node scripts/test-cart-service-contract.js
 *
 * The service is only useful if it is a DROP-IN for what the pages already do. So this
 * suite does not check that the API "works" — it checks that the service produces carts
 * the EXISTING consumers still accept, using fixtures in the exact shapes the current
 * writers emit:
 *
 *   product.js      whole product object, quantity by DUPLICATE ROWS, no qty field
 *   market-actions  _norm() shape: id/name/price/image/category/sellerName/source
 *   flashsale.html  {...product, price: salePrice}
 *   food (cart.js)  cartId + restaurantId + qty
 *
 * and then replays them through the real consumer logic:
 *
 *   checkout.html   line total, cartForSession mapping, pickupCoords, orderItems payload
 *   cart.js         totals and food grouping
 *   server          verifyIntasendPayment's price cross-check arithmetic
 *
 * The most important assertions are the ones that prove the service does NOT tidy
 * anything: field preservation, duplicate-row quantities, and both count models.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');

const R = {};
let pass = 0, fail = 0;
function ck(g, l, ok, d) {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 95) + ']' : ''));
  ok ? pass++ : fail++;
  if (R[g] !== 'FAIL') R[g] = ok ? 'PASS' : 'FAIL';
}

/* ── browser shim + the SHIPPED service ── */
const store = {};
const listeners = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
global.window = {
  addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
  removeEventListener: (t, f) => {
    if (listeners[t]) listeners[t] = listeners[t].filter(x => x !== f);
  },
  dispatchEvent: (e) => { (listeners[e.type] || []).forEach(f => { try { f(e); } catch (_) {} }); return true; },
};
global.CustomEvent = function (t, o) { this.type = t; this.detail = o && o.detail; };
const Cart = require(path.join(ROOT, 'sokoni-cart.js'));
const reset = () => { delete store.cart; Object.keys(store).forEach(k => { if (/^cart_corrupt_/.test(k)) delete store[k]; }); };

/* ── fixtures in the shapes the CURRENT writers emit ── */
const P_PRODUCT = {                      /* product.js — whole product object */
  id: 'p1', name: 'Unga 2kg', price: 250, image: 'u.png', category: 'Food',
  sellerUid: 'seller-A', sellerId: 'seller-A', sellerName: 'Duka A',
  sellerLat: -1.2921, sellerLng: 36.8219, stock: 20, isDigital: false,
  selectedSize: '2kg', selectedColor: null, selectedVariants: { pack: 'single' },
};
const P_MARKET = {                       /* market-actions _norm() */
  id: 'p2', name: 'Thermos', price: 1500, image: 't.png', category: 'Home',
  sellerName: 'Duka B', sourceUrl: '', source: 'marketplace', addedAt: 1,
};
const P_FLASH = { id: 'p3', name: 'Kettle', price: 900, image: 'k.png', category: 'Home', salePrice: 900 };
const P_FOOD = {                         /* cart.js food row */
  cartId: 'f-1', id: 'dish-1', restaurantId: 'r1', restaurantName: 'Mama Oliech',
  name: 'Fish', price: 800, qty: 2, note: 'extra ugali',
};

/* ── the REAL consumer logic, transcribed from the shipped files ── */

/* checkout.html:1655 — per-line total */
const coQty = (item) => Math.max(1, Math.round(Number(item.qty) || Number(item.quantity) || 1));
const coLineTotal = (item) => Number(item.price || 0) * coQty(item);
/* checkout.html:2241 — session payload */
const coSession = (cart) => cart.map(i => ({
  productId: String(i.id || i.productId || ''),
  qty: Math.max(1, Math.round(Number(i.qty) || Number(i.quantity) || 1)),
})).filter(i => i.productId);
/* checkout.html:2440 — pickup coordinates */
const coPickup = (cart) => { const c = cart[0] || {}; return (c.sellerLat && c.sellerLng) ? { lat: c.sellerLat, lng: c.sellerLng } : null; };
/* checkout.html:1723 — seller resolution */
const coSeller = (cart) => (cart[0] || {}).sellerUid || (cart[0] || {}).sellerId || null;
/* functions/index.js:2761 — server price cross-check */
const svTotal = (cart, priceMap) => cart.reduce((s, item) => {
  const pid = String(item.id || item.productId || '');
  if (!pid || !priceMap[pid]) return s;
  const p = priceMap[pid];
  return s + Number(p.salePrice || p.price || 0) * Math.max(1, Number(item.qty) || Number(item.quantity) || 1);
}, 0);
/* shared-header.js:1250 vs market-actions.js:71 — the two badge models */
const badgeHeader = (cart) => cart.reduce((s, i) => s + (i.qty || 1), 0);
const badgeCards  = (cart) => cart.length;

console.log('\nTRACK 2.2A — SokoniCart service contract\n' + '='.repeat(66));

/* ══ A. field preservation — the service must not tidy anything ══ */
console.log('\nA. Every field survives a round trip, byte for byte');
reset();
Cart.add(P_PRODUCT);
{
  const got = Cart.list()[0];
  ck('A', 'round trip is deep-equal to what was written',
     JSON.stringify(got) === JSON.stringify(P_PRODUCT), JSON.stringify(got).slice(0, 80));
  ['sellerLat', 'sellerLng', 'sellerUid', 'sellerId', 'selectedSize', 'selectedVariants',
   'isDigital', 'stock', 'category', 'image'].forEach(f => {
    ck('A', 'preserves ' + f, JSON.stringify(got[f]) === JSON.stringify(P_PRODUCT[f]),
       JSON.stringify(got[f]));
  });
  ck('A', 'adds no fields of its own',
     Object.keys(got).length === Object.keys(P_PRODUCT).length,
     Object.keys(got).filter(k => !(k in P_PRODUCT)).join(','));
}

/* ══ B. duplicate-row quantities are preserved, not merged ══ */
console.log('\nB. product.js duplicate-row quantity is NOT converted to a qty field');
reset();
Cart.add(P_PRODUCT, { times: 3 });
{
  const c = Cart.raw();
  ck('B', 'three separate rows', c.length === 3, c.length);
  ck('B', 'no qty field was invented', c.every(i => i.qty === undefined), JSON.stringify(c[0].qty));
  ck('B', 'server total is unchanged by the service', svTotal(c, { p1: { price: 250 } }) === 750,
     svTotal(c, { p1: { price: 250 } }));
  ck('B', 'checkout session payload has 3 entries of qty 1',
     JSON.stringify(coSession(c)) === JSON.stringify([{ productId: 'p1', qty: 1 },
       { productId: 'p1', qty: 1 }, { productId: 'p1', qty: 1 }]), JSON.stringify(coSession(c)));
  /* Rows must be independent copies — product.js pushes the same reference N times, so
     editing one line edits all three. */
  Cart.setQty(0, 5);
  const after = Cart.raw();
  ck('B', 'editing one row does not mutate its siblings',
     after[1].qty === undefined && after[2].qty === undefined,
     JSON.stringify(after.map(i => i.qty)));
}

/* ══ C. both count models, and they still disagree exactly as today ══ */
console.log('\nC. lines() and units() reproduce the two live badge implementations');
reset();
Cart.add(P_PRODUCT, { times: 3 });
{
  const c = Cart.raw();
  ck('C', 'units() == shared-header badge', Cart.units() === badgeHeader(c), Cart.units() + ' vs ' + badgeHeader(c));
  ck('C', 'lines() == market-actions badge', Cart.lines() === badgeCards(c), Cart.lines() + ' vs ' + badgeCards(c));
  ck('C', 'for duplicate rows the two agree (3/3)', Cart.units() === 3 && Cart.lines() === 3);
}
reset();
Cart.add(Object.assign({}, P_PRODUCT, { qty: 3 }));
{
  const c = Cart.raw();
  ck('C', 'for a qty field they DISAGREE — preserved, not papered over',
     Cart.units() === 3 && Cart.lines() === 1, Cart.units() + ' units / ' + Cart.lines() + ' lines');
  ck('C', 'and both still match the shipped implementations',
     Cart.units() === badgeHeader(c) && Cart.lines() === badgeCards(c));
}

/* ══ D. checkout contract ══ */
console.log('\nD. checkout.html still gets everything it reads');
reset();
Cart.add(P_PRODUCT);
Cart.add(P_MARKET, { times: 2 });
{
  const c = Cart.raw();
  ck('D', 'pickupCoords resolves from cart[0]',
     JSON.stringify(coPickup(c)) === JSON.stringify({ lat: -1.2921, lng: 36.8219 }), JSON.stringify(coPickup(c)));
  ck('D', 'seller resolves from cart[0]', coSeller(c) === 'seller-A', coSeller(c));
  ck('D', 'session payload maps every line', coSession(c).length === 3, JSON.stringify(coSession(c)));
  ck('D', 'every session entry has a productId', coSession(c).every(i => i.productId));
  ck('D', 'orderItems payload is the array itself, unwrapped',
     Array.isArray(Cart.raw()) && JSON.stringify(Cart.raw()) === store.cart);
  /* The service deliberately exposes no money helper. A subtotal on a shared service is
     an invitation for a call site to render it as the authoritative amount; the server
     decides that in verifyIntasendPayment. Pages compute display totals where they
     display them. This guards against it being added back. */
  ck('D', 'the service exposes NO money helper',
     Cart.subtotal === undefined && Cart.total === undefined,
     Object.keys(Cart).filter(k => /total|subtotal|amount|price/i.test(k)).join(','));
  ck('D', 'checkout can still compute its own subtotal from the service output',
     c.reduce((s, i) => s + coLineTotal(i), 0) === 3250,
     c.reduce((s, i) => s + coLineTotal(i), 0));
}

/* ══ E. food rows ══ */
console.log('\nE. Food rows keep cartId / restaurantId / note');
reset();
Cart.add(P_FOOD);
Cart.add(Object.assign({}, P_FOOD, { cartId: 'f-2', note: 'no ugali' }));
{
  const c = Cart.raw();
  ck('E', 'both rows kept despite sharing an id', c.length === 2, c.length);
  ck('E', 'cartId preserved', c[0].cartId === 'f-1' && c[1].cartId === 'f-2');
  ck('E', 'restaurantId preserved', c.every(i => i.restaurantId === 'r1'));
  ck('E', 'per-row note preserved', c[0].note === 'extra ugali' && c[1].note === 'no ugali');
  ck('E', 'removeByCartId removes only that row', Cart.removeByCartId('f-1') && Cart.lines() === 1);
  ck('E', 'the surviving row is the right one', Cart.raw()[0].cartId === 'f-2', Cart.raw()[0].cartId);
  ck('E', 'food qty counts as units', Cart.units() === 2, Cart.units());
}

/* ══ F. removal never takes more than asked ══ */
console.log('\nF. Removing one line leaves the shopper\'s other units alone');
reset();
Cart.add(P_PRODUCT, { times: 3 });
Cart.removeById('p1');
ck('F', 'two rows remain', Cart.lines() === 2, Cart.lines());
ck('F', 'they are still the same product', Cart.raw().every(i => i.id === 'p1'));
ck('F', 'removeAt out of range is refused', Cart.removeAt(99) === false && Cart.lines() === 2);
ck('F', 'removeById for an absent id is refused', Cart.removeById('nope') === false && Cart.lines() === 2);

/* ══ G. corruption is quarantined, never overwritten ══ */
console.log('\nG. An unreadable cart is preserved, not silently emptied');
reset();
store.cart = '{"not":"an array"}';
{
  const got = Cart.list();
  ck('G', 'reads as empty rather than throwing', Array.isArray(got) && got.length === 0);
  const q = Object.keys(store).filter(k => /^cart_corrupt_/.test(k));
  ck('G', 'the raw value was quarantined', q.length === 1, q.join(','));
  ck('G', 'the quarantined copy is the original text', store[q[0]] === '{"not":"an array"}');
  ck('G', 'the live key was NOT overwritten by the read', store.cart === '{"not":"an array"}',
     store.cart);
}
reset();
store.cart = 'not json at all';
ck('G', 'invalid JSON also quarantines',
   Cart.list().length === 0 && Object.keys(store).some(k => /^cart_corrupt_/.test(k)));

/* ══ H. one announcement per mutation ══ */
console.log('\nH. Every mutation announces exactly once');
reset();
{
  let n = 0, last = null;
  const off = Cart.subscribe(d => { n++; last = d; });
  Cart.add(P_PRODUCT);
  ck('H', 'add fires once', n === 1, n);
  Cart.setQty(0, 4);
  ck('H', 'setQty fires once', n === 2, n);
  ck('H', 'detail carries both counts', last && last.count === 1 && last.units === 4, JSON.stringify(last));
  Cart.removeAt(0);
  ck('H', 'removeAt fires once', n === 3, n);
  Cart.removeAt(99);
  ck('H', 'a refused mutation does NOT fire', n === 3, n);
  off();
  Cart.add(P_MARKET);
  ck('H', 'unsubscribe stops delivery', n === 3, n);
}

/* ══ I. merge is opt-in only ══ */
console.log('\nI. Repeat add appends unless merge is asked for');
reset();
Cart.add(P_PRODUCT); Cart.add(P_PRODUCT);
ck('I', 'default is append — two lines', Cart.lines() === 2, Cart.lines());
reset();
Cart.add(P_PRODUCT); Cart.add(P_PRODUCT, { merge: true });
ck('I', 'merge:true bumps qty instead', Cart.lines() === 1 && Cart.raw()[0].qty === 2,
   JSON.stringify(Cart.raw()));
ck('I', 'merged row still charges for two units',
   svTotal(Cart.raw(), { p1: { price: 250 } }) === 500, svTotal(Cart.raw(), { p1: { price: 250 } }));

/* merge must key on cartId for food rows. Two lines of the same dish differing only by
   note are NOT the same line — collapsing them would discard a shopper instruction and
   charge for a dish they did not order that way. */
reset();
Cart.add(P_FOOD);                                              /* f-1, "extra ugali" */
Cart.add(Object.assign({}, P_FOOD, { cartId: 'f-2', note: 'no ugali' }), { merge: true });
{
  const c = Cart.raw();
  ck('I', 'merge does NOT collapse food rows that share an id',
     c.length === 2, JSON.stringify(c.map(i => i.cartId)));
  ck('I', 'both notes survive',
     c[0].note === 'extra ugali' && c[1].note === 'no ugali', JSON.stringify(c.map(i => i.note)));
}
Cart.add(Object.assign({}, P_FOOD, { cartId: 'f-1' }), { merge: true });
{
  const c = Cart.raw();
  ck('I', 'merge on a matching cartId bumps that row', c.length === 2 && c[0].qty === 4,
     JSON.stringify(c.map(i => ({ cartId: i.cartId, qty: i.qty }))));
  ck('I', 'and leaves the other food row alone', c[1].qty === 2, c[1].qty);
}
/* THE INVARIANT: merge and append must charge the same. An early version added `times`
   rather than `times × the item's own qty`, so merging a food row carrying qty:2 added one
   unit — the shopper paid for one dish instead of two. Only this assertion caught it. */
[['product, no qty', P_PRODUCT], ['food, qty 2', P_FOOD], ['qty 5', Object.assign({}, P_PRODUCT, { qty: 5 })]]
  .forEach(function (pair) {
    const label = pair[0], item = pair[1];
    reset(); Cart.add(item); Cart.add(item);                      /* append twice */
    const appended = Cart.units();
    reset(); Cart.add(item); Cart.add(item, { merge: true });      /* append then merge */
    const merged = Cart.units();
    ck('I', 'merge charges the same as append — ' + label,
       appended === merged, appended + ' appended vs ' + merged + ' merged');
  });
reset(); Cart.add(P_PRODUCT); Cart.add(P_PRODUCT, { merge: true, times: 3 });
ck('I', 'merge honours times as a multiplier', Cart.units() === 4, Cart.units());

/* A product merge must never land on a food row that happens to share the id. */
reset();
Cart.add(P_FOOD);                                              /* id dish-1, cartId f-1 */
Cart.add({ id: 'dish-1', name: 'Fish (retail)', price: 800 }, { merge: true });
{
  const c = Cart.raw();
  ck('I', 'a product merge does not absorb into a food row', c.length === 2, c.length);
  ck('I', 'the food row keeps its own qty and note',
     c[0].qty === 2 && c[0].note === 'extra ugali', JSON.stringify(c[0]));
  ck('I', 'the product row has no cartId', !c[1].cartId, JSON.stringify(c[1].cartId));
}

/* ══ J. writes go through the ordinary setItem so the food bridge still fires ══ */
console.log('\nJ. Persistence path is unchanged (provider-wiring bridge intact)');
{
  reset();
  const real = global.localStorage.setItem;
  let sawCartWrite = false;
  global.localStorage.setItem = function (k, v) { if (k === 'cart') sawCartWrite = true; return real.call(this, k, v); };
  Cart.add(P_FLASH);
  global.localStorage.setItem = real;
  ck('J', 'writes via localStorage.setItem("cart", …) — interceptable', sawCartWrite);
  ck('J', 'storage key is unchanged', Cart.STORAGE_KEY === 'cart');
  ck('J', 'stored value is a plain JSON array', Array.isArray(JSON.parse(store.cart)));
}

/* ══ K. the service is NOT uid-scoped ══
   A cart is filled before sign-in. Stamping an owner would empty every anonymous
   shopper's cart — the opposite of the wishlist, where per-user scoping was the fix. */
console.log('\nK. Anonymous carts keep working (no owner stamping)');
{
  const src = fs.readFileSync(path.join(ROOT, 'sokoni-cart.js'), 'utf8');
  const { stripComments } = require('./scan-legacy-wishlist.js');
  const code = stripComments(src);
  ck('K', 'no firebaseAuth dependency', !/firebaseAuth/.test(code));
  ck('K', 'no uid in the storage key', !/ownerUid|_uid\(|uid\s*\+/.test(code));
  ck('K', 'no auth state listener', !/onAuthStateChanged/.test(code));
  reset();
  Cart.add(P_PRODUCT);
  ck('K', 'add works with no session at all', Cart.lines() === 1);
}

/* ══ L. no writer was migrated in this slice ══ */
console.log('\nL. 2.2A changed no page');
{
  const cp = require('child_process');
  const changed = cp.execSync('git diff --name-only HEAD', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map(s => s.trim()).filter(Boolean);
  /* Diffing against HEAD cannot tell this slice's changes from other tracks' — the tree
     also carries Track 1 (availability) and Track 4 (cart.html CSS) work that was dirty
     before 2.2A began. Two earlier versions of this assertion failed on exactly that and
     were patched to dodge it, which is how a guard turns into a rubber stamp. So the
     pre-existing set is named explicitly: anything dirty and NOT on this list is
     something 2.2A touched, and the assertion says so by name. */
  const PRE_EXISTING = [
    'availability-manager.html',        /* Track 1 — availability schedule projection */
    'cart.html',                        /* Track 4 — min-width:0 overflow fix */
    'version.json',                     /* predeploy artifacts, not authored here */
    'docs/release-gates/unknown.json',
  ];
  const MINE = ['sokoni-cart.js', 'scripts/test-cart-service-contract.js',
                'CHANGELOG.md', 'docs/CART_PERSISTENCE_AUDIT.md'];
  const unexpected = changed.filter(f => !PRE_EXISTING.includes(f) && !MINE.includes(f));
  ck('L', 'nothing outside this slice and the known pre-existing set is dirty',
     unexpected.length === 0, unexpected.join(', '));
  ck('L', 'no page anywhere references SokoniCart yet',
     !cp.execSync('git grep -l "SokoniCart" -- "*.html" || true', { cwd: ROOT, encoding: 'utf8' }).trim(),
     'a page references it');
  ck('L', 'checkout.html untouched', !changed.includes('checkout.html'), changed.join(', '));
  ck('L', 'cart.js untouched', !changed.includes('cart.js'), changed.join(', '));
  ck('L', 'no existing cart writer migrated',
     !changed.some(f => /^(product|category|script|market-actions|provider-wiring)\.js$/.test(f)),
     changed.join(', '));
  const loaders = cp.execSync('git grep -l "sokoni-cart.js" -- "*.html" || true',
    { cwd: ROOT, encoding: 'utf8' }).trim();
  ck('L', 'no page loads sokoni-cart.js yet — the service ships inert', !loaders, loaders);
}

/* ── summary ── */
console.log('\n' + '='.repeat(66));
console.log('Track 2.2A acceptance\n');
['A','B','C','D','E','F','G','H','I','J','K','L'].forEach(k => console.log('  ' + k + ': ' + (R[k] || 'MISSING')));
console.log('\n  TOTAL:   ' + (pass + fail) + '\n  PASSED:  ' + pass + '\n  FAILED:  ' + fail);
process.exit(fail ? 1 : 0);
