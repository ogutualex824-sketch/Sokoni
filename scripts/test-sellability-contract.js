/* ============================================================================
   ONE product, ONE sellability decision, EVERY surface agrees.

   Run:  node scripts/test-sellability-contract.js      (no emulator, no network)

   WHY THIS EXISTS
   The Slice 3 audit found FIVE independent definitions of "is this product
   sellable/visible":

     /api/catalogue          HIDDEN = deleted|removed|hidden|draft|archived|
                             banned|suspended|paused|inactive|rejected + isVisible
     listenProducts          NO status filter at all
     availability-enforce    isVisible===false, status==='archived'  ← only these
     darajaSTKPush           status && status !== 'active'
     admin.html              removed|unpublished|deleted

   Two of those were supposed to be the SAME authority. `/api/catalogue` hid a
   `status:'removed'` product; the Firestore listener returned it. Since 20dfcd2
   an authoritative response can REMOVE products, so the same document appeared or
   vanished depending on which authority answered first. And because checkout
   blocked only `archived`, a removed / rejected / unpublished product was still
   purchasable.

   WHAT THIS TEST IS FOR
   Not "does today's code work" — that is the easy half, and it would still pass
   after someone reintroduced a local rule. This test fails when a surface starts
   deciding sellability for ITSELF again:

     * a re-derived `Number(x.stock) === 0`     (reads NEGATIVE stock as in-stock)
     * a local `status === 'archived'` gate     (ignores removed/rejected/hidden)
     * a local hidden-status list               (drifts from the canonical one)
     * the two copies of the module diverging
     * a surface that stops loading the module

   That is the durable value: the contract, not the implementation.
============================================================================ */
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/* Comments deliberately QUOTE the old expressions to explain what was removed, so
   an absence assertion must run against executable code only. */
const code = (rel) => read(rel)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const A = require(path.join(ROOT, 'functions', 'shared', 'sellability'));

/* ── 1. The cross-surface matrix ──────────────────────────────────────────────
   Every surface resolves through this module, so agreement is proven by the
   decision itself. Wiring assertions below prove each surface actually asks it. */
console.log('\nThe same product produces the same answer everywhere');
const MATRIX = [
  ['removed',   { status: 'removed',     stock: 9 }, false],
  ['archived',  { status: 'archived',    stock: 9 }, false],
  ['hidden',    { isVisible: false,      stock: 9 }, false],
  ['rejected',  { status: 'rejected',    stock: 9 }, false],
  ['deleted',   { status: 'deleted',     stock: 9 }, false],
  ['unpublish', { status: 'unpublished', stock: 9 }, false],
  ['negative',  { stock: -2 },                       false],
  ['stock = 0', { stock: 0 },                        false],
  ['stock = 3', { stock: 3 },                        true ],
];
for (const [label, product, sellable] of MATRIX) {
  const r = A.availabilityOf(product, undefined);
  ck(('"' + label + '" → sellable=' + sellable).padEnd(34), r.sellable === sellable,
     r.state + (r.reason ? '/' + r.reason : ''));
}

console.log('\nNegative stock is never available (the `=== 0` defect)');
ck('stock -1 is not sellable',  A.availabilityOf({ stock: -1 }).sellable === false);
ck('stock -99 is not sellable', A.availabilityOf({ stock: -99 }).sellable === false);
ck('negative reports out_of_stock, not in_stock',
   A.availabilityOf({ stock: -5 }).state === 'out_of_stock');

console.log('\nLegacy unmetered behaviour is preserved');
ck('no stock field → sellable (untracked, NOT zero)', A.availabilityOf({}).sellable === true);
ck('no stock field → in_stock', A.availabilityOf({}).state === 'in_stock');
ck('no stock field → available is null, never 0',  A.availabilityOf({}).available === null);
ck('unmetered has no order ceiling', A.maxOrderableQty({}) === null);
ck('absent status is listable (must not regress to status===active)',
   A.isPubliclyListed({}) === true);
ck('legacy pending/approved stay listable',
   A.isPubliclyListed({ status: 'pending' }) && A.isPubliclyListed({ status: 'approved' }));

console.log('\nReservations use the existing field and threshold');
{
  const r = A.availabilityOf({ stock: 10, reservedStock: 8 });
  ck('stock 10 / reservedStock 8 → low_stock', r.state === 'low_stock', r.state);
  ck('available = max(stock - reserved, 0) = 2', r.available === 2);
  ck('threshold is the existing default of 5', r.threshold === 5);
  ck('stock 10 / reservedStock 10 → out_of_stock',
     A.availabilityOf({ stock: 10, reservedStock: 10 }).state === 'out_of_stock');
  ck('reserved never pushes available negative',
     A.availabilityOf({ stock: 2, reservedStock: 9 }).available === 0);
  ck('per-product lowStockThreshold overrides the default',
     A.availabilityOf({ stock: 8, lowStockThreshold: 10 }).state === 'low_stock');
}

console.log('\nProduct availability and shop availability stay distinct');
{
  const closed = A.availabilityOf({ stock: 9 }, { acceptingOrders: false });
  ck('shop-closed is reported as shop-closed, not out_of_stock', closed.reason === 'shop-closed');
  ck('shop-closed is unavailable', closed.state === 'unavailable');
  ck('a delisted product outranks shop state (restocking would not help)',
     A.availabilityOf({ status: 'removed' }, { acceptingOrders: false }).reason === 'status:removed');
  ck('absent shop state defaults OPEN (un-migrated shops unaffected)',
     A.availabilityOf({ stock: 9 }, undefined).sellable === true);
}

console.log('\nQuantity clamping — the server wins');
ck('request 5 against 3 available → 3', A.clampQty(5, { stock: 3 }).qty === 3);
ck('the adjustment is reported, not silent', A.clampQty(5, { stock: 3 }).adjusted === true);
ck('request 2 against 3 available → 2 unadjusted', A.clampQty(2, { stock: 3 }).adjusted === false);
ck('unmetered is not clamped', A.clampQty(5, {}).qty === 5);
ck('a delisted product can order 0', A.maxOrderableQty({ status: 'removed', stock: 9 }) === 0);

/* ── 2. ANTI-DRIFT ────────────────────────────────────────────────────────────
   The half that matters. Each surface must ASK the module, and must not grow its
   own rule back. */
console.log('\nAnti-drift: no surface may re-derive sellability');

const SURFACES = [
  ['category.js',  'Shop grid'],
  ['product.js',   'Product detail'],
  ['script.js',    'Home'],
];

for (const [file, label] of SURFACES) {
  const src = code(file);
  ck(label + ': no local `stock === 0` sellability rule',
     !/Number\(\s*\w+(\.\w+)*\.stock\s*\)\s*===\s*0/.test(src), file);
  ck(label + ': no local hidden-status list',
     !/status\s*===\s*['"]archived['"]|status\s*!==\s*['"]archived['"]/.test(src), file);
  ck(label + ': asks the canonical module',
     /SokoniSellability/.test(src) && /availabilityOf\(/.test(src), file);
}

/* The server halves. */
{
  const idx = code('functions/index.js');
  ck('/api/catalogue: local HIDDEN set is gone',
     !/const HIDDEN = new Set\(\[/.test(idx));
  ck('/api/catalogue: uses the canonical predicate',
     /_availability\.isPubliclyListed\(p\)/.test(idx));
  ck('createCheckoutSession: uses the canonical decision',
     /_availability\.availabilityOf\(prod, shopState\[prod\.sellerUid\]\)/.test(idx));
  ck('createCheckoutSession: uses the canonical clamp',
     /_availability\.clampQty\(qty, prod, shopState\[prod\.sellerUid\]\)/.test(idx));
  ck('createCheckoutSession: no re-derived `stock <= 0` OOS rule',
     !/const isOos\s*=\s*prod\.outOfStock === true/.test(idx));
  ck('darajaSTKPush: canonical listability added (not replaced — still stricter)',
     /!_availability\.isPubliclyListed\(p\)/.test(idx) && /p\.status !== "active"/.test(idx));

  /* Safeguards that predate this slice and must survive it. */
  ck('checkout still discards the client amount', /discarded outright/.test(read('functions/index.js')));
  ck('checkout still rejects a cross-seller cart', /another seller/.test(idx));
  ck('checkout still enforces the fulfilment channel', /fulfillmentAllowed\(/.test(idx));
  ck('stock deduction is still floored at zero', /Math\.max\(0, cur - dec\)/.test(idx));
  ck('oversold shortfall is still recorded, not rejected', /oversoldAlerts/.test(idx));
}

/* availability-enforce must delegate, never hold a second copy of the logic. */
{
  const ae = code('functions/availability-enforce.js');
  ck('availability-enforce delegates to the shared module',
     /require\(['"]\.\/shared\/sellability['"]\)/.test(ae));
  ck('availability-enforce holds no decision logic of its own',
     !/status\s*===\s*['"]archived['"]/.test(ae));
}

/* ── 3. Parity between the two copies ─────────────────────────────────────── */
console.log('\nThe client and server copies cannot drift');
{
  const client = read('sokoni-sellability.js');
  const server = read('functions/shared/sellability.js');
  ck('sokoni-sellability.js === functions/shared/sellability.js', client === server,
     client.length + 'B vs ' + server.length + 'B');
  ck('the module is pure (no Firestore/network/clock)',
     !/require\(|firebase|fetch\(|Date\.now\(|Math\.random\(/.test(code('sokoni-sellability.js')));
}

/* ── 3b. The name collision this slice actually hit ────────────────────────────
   `sokoni-availability.js` / `window.AvailabilityService` is a PRE-EXISTING and
   unrelated module: the MERCHANT-side shop/product availability authority. It reads
   shops/{sellerUid}, derives its own vocabulary ('available'|'low'|'out'|
   'unavailable') against `minStockLevel`, and writes shop state. merchant.html is its
   consumer. It was overwritten during this slice by a same-named new file and had to
   be restored from git.

   These assertions make that unrecoverable-by-accident: the two modules must stay
   separate files with separate globals, and the merchant one must keep its API. */
console.log('\nThe merchant AvailabilityService is a DIFFERENT module and survives');
{
  const merchant = read('sokoni-availability.js');
  ck('sokoni-availability.js still exports AvailabilityService',
     /root\.AvailabilityService = \{/.test(merchant));
  ck('it keeps its own merchant API (deriveProduct/setShop/readShop)',
     /deriveProduct/.test(merchant) && /setShop/.test(merchant) && /readShop/.test(merchant));
  ck('it uses minStockLevel, not lowStockThreshold', /minStockLevel/.test(merchant));
  ck('the two modules are different files',
     read('sokoni-sellability.js') !== merchant);
  ck('the globals do not collide',
     !/SokoniSellability/.test(merchant) && !/AvailabilityService/.test(read('sokoni-sellability.js').replace(/\/\*[\s\S]*?\*\//g, '')));
  ck('merchant.html still consumes AvailabilityService',
     /AvailabilityService\./.test(read('merchant.html')));
}

/* ── 4. Wiring: a surface that stops loading the module fails here ─────────── */
console.log('\nEvery surface loads the module');
for (const page of ['category.html', 'product.html', 'index.html']) {
  ck(page + ' loads sokoni-sellability.js',
     /<script src="sokoni-sellability.js"><\/script>/.test(read(page)));
}
/* Non-deferred, so it is defined before the deferred surface scripts run. */
ck('the module is not deferred (must exist before the surface scripts execute)',
   !/<script[^>]*src="sokoni-sellability.js"[^>]*defer/.test(read('category.html')));

/* ── 5. Fail-open: a failed read is never an authoritative "unavailable" ───── */
console.log('\nA missing module fails OPEN, never closed');
for (const [file, label] of SURFACES) {
  const src = code(file);
  ck(label + ": module-missing fallback is sellable, not unavailable",
     /reason: 'module-missing', sellable: true/.test(src), file);
}

/* ── 6. Lists exclude delisted products; the detail page explains them ──────
   /api/catalogue filters delisted docs server-side but the Firestore listener has
   no status filter, so the SAME document could reach the grid from one authority
   and not the other. Lists must apply the same predicate. The detail page must NOT:
   someone on a direct link or bookmark deserves an explanation, not a blank page. */
console.log('\nLists exclude delisted products; detail explains them');
{
  const cat = code('category.js'), home = code('script.js');
  ck('Shop grid filters lists through the canonical predicate',
     /_catListable\(list\)/.test(cat) && /isPubliclyListed/.test(cat));
  ck('Home filters lists through the canonical predicate', /isPubliclyListed/.test(home));
  ck('list filtering fails OPEN (module missing shows everything)',
     /if \(!A \|\| typeof A\.isPubliclyListed !== 'function'\) return list;/.test(cat));
  ck('product detail does NOT filter — a direct link still explains itself',
     !/isPubliclyListed/.test(code('product.js')));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
