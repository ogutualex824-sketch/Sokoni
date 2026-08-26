/* Products is a NATIVE merchant-v2 module, not the legacy shell in an iframe.
 *
 *   node scripts/test-merchant-products-native.js
 *
 * WHAT THIS IS ABOUT
 * The Products module (sokoni-merchant-products.js) has existed since 124ba67, gained
 * create/edit/delete at 217bc64 and media at 911ec98 — and no merchant ever saw it. The
 * route stayed kind:'seller', so every click mounted seller.html in an iframe: a second
 * merchant application inside the first, with its own auth boot, its own product query
 * and its own idea of stock. The module was built, wired on one branch, and never routed
 * to. This suite asserts the last mile, because that is the part that kept not happening.
 *
 * THE AUTHORITY RULE IS THE POINT
 * POS, Sell and Products must read ONE shop-scoped product authority. If Products grew its
 * own query, the till and the catalogue would disagree about stock — and the disagreement
 * would be invisible until a customer was told an item was in stock that was not.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const R = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ok = (c, label, detail) => {
  if (c) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
};

/* ── 1. ROUTE ─────────────────────────────────────────────────────────────── */
console.log('\n1. The route is native, and the legacy address still resolves');
const API = require(path.join(ROOT, 'sokoni-merchant-routes.js'));
const products = API.get('products');

ok(!!products, 'CONTROL: the products route exists in the contract');
ok(products.kind === 'native',
   'products is kind:native (was kind:seller -> seller.html in an iframe)',
   'kind is "' + products.kind + '"');

/* sec is GONE from this native route, and the paragraph that used to defend it was wrong.

   TWO DIFFERENT THINGS SHARE THE NAME:
     URL PARAMETER  ?sec=products   read by seller.html's redirect, which carries NO map and
                                    forwards the raw key as a hash
     ROUTE FIELD    sec:'products'  a property on the declaration

   seller.html never reads the field. resolve() never reads it either — it matches by route id,
   then ALIASES. The only runtime reader is merchant-v2's mount branch, gated on
   kind === 'seller'. Inbound compatibility is carried by THIS ROUTE'S ID, which is asserted
   below by executing the resolver instead of trusting the field's presence. */
ok(products.sec === undefined, 'the stale sec field is gone from the native route');
ok(API.resolve('products') === 'products',
   'and ?sec=products -> #products still lands here, by ID');
ok(API.SELLER_SECTIONS.indexOf('products') >= 0,
   'products stays in SELLER_SECTIONS, so the gate keeps validating it');
ok(API.resolve('products') === 'products',
   'the legacy section key still resolves to the route');

/* ── 2. THE SHELL MOUNTS IT ───────────────────────────────────────────────── */
console.log('\n2. merchant-v2 can actually mount the module');
const v2 = R('merchant-v2.html');

ok(/<script src="sokoni-merchant-products\.js"><\/script>/.test(v2),
   'the module script is loaded');
ok(/<script src="sokoni-merchant-media\.js"><\/script>/.test(v2),
   'its media dependency is loaded');
/* Order matters: the editor composes through media at mount time. */
ok(v2.indexOf('sokoni-merchant-media.js') < v2.indexOf('sokoni-merchant-products.js'),
   'media loads BEFORE products');

const modEntry = (function () {
  /* Brace-matched. The 900-char window stopped short once the module ctx gained the
     inventory adapter, so canPublish fell outside and the test reported it missing. */
  const i = v2.indexOf('products:   { global:');
  if (i < 0) return '';
  let d = 0, end = -1;
  for (let j = v2.indexOf('{', i); j < v2.length; j++) {
    if (v2[j] === '{') d++; else if (v2[j] === '}') { d--; if (!d) { end = j + 1; break; } }
  }
  return v2.slice(i, end);
})();
ok(modEntry.length > 200, 'CONTROL: the MODULES entry was located (' + modEntry.length + ' chars)');
ok(/global:\s*'SokoniMerchantProducts'/.test(modEntry),
   'MODULES.products names the module global');
ok(/scope:\s*_scope\(\)/.test(modEntry),
   'scope comes from the resolved shop, not the URL and not localStorage');
ok(/SokoniAuthority/.test(modEntry),
   'entitlement comes from SokoniAuthority, never from the page');
ok(/canPublish:\s*_callable\(/.test(modEntry),
   'publish permission is a SERVER callable, not a client decision');

/* renderNative must reach MODULES — otherwise a native route renders the
   "not yet ported" placeholder and the module is still unreachable. */
ok(/if \(MODULES\[id\]\) return renderModule\(id, p\);/.test(v2),
   'renderNative dispatches native routes that have a module');

/* ── 3. ONE PRODUCT AUTHORITY ─────────────────────────────────────────────── */
console.log('\n3. One product authority — the same one POS and Sell read');
const mod = R('sokoni-merchant-products.js');

ok(/listProducts\(/.test(mod),
   'the module reads through SokoniMerchantData.listProducts()');

/* It must NOT hold a query of its own. A second product query is how the till and the
   catalogue come to disagree about stock. */
ok(!/from\s+['"]https:\/\/www\.gstatic\.com\/firebasejs/.test(mod) &&
   !/import\(['"]https:\/\/www\.gstatic\.com/.test(mod),
   'the module imports no Firestore SDK of its own — ctx.db is its only storage path');
ok(!/\/api\/catalogue/.test(mod),
   'merchant products never come from /api/catalogue');

/* Positive control: the shared authority really is shared. If these three stopped
   agreeing, this assertion is what notices. */
const sell = R('sokoni-merchant-sell.js');
const inv = R('sokoni-merchant-inventory-ui.js');
ok(/listProducts\(/.test(sell) && /listProducts\(/.test(inv),
   'CONTROL: Sell and Inventory read the SAME listProducts authority');

/* ── 4. LEGACY SHELL NO LONGER SERVES PRODUCTS ────────────────────────────── */
console.log('\n4. Nothing routes Products back into the legacy shell');
/* go() iframes seller.html for kind:'seller'. With products native, that branch must not
   be reachable for this route. Asserted through the CONTRACT rather than by reading go(),
   because the contract is what decides. */
const stillLegacy = API.SELLER_SECTIONS
  .map((s) => API.get(API.resolve(s)))
  .filter((r) => r && r.kind === 'seller')
  .map((r) => r.id);
ok(stillLegacy.indexOf('products') === -1,
   'products is NOT among the routes still rendered by seller.html');
/* The converse, so this cannot pass by the list simply being empty. */
ok(stillLegacy.length > 0,
   'CONTROL: other routes ARE still legacy (' + stillLegacy.join(', ') + ') — ' +
   'so the check above is discriminating, not vacuous');

/* ── 5. THE FINANCIAL GUARD IS UNDISTURBED ────────────────────────────────── */
console.log('\n5. Products did not wake the Dashboard financial KPIs');
ok(/var\s+POS_SALES_READABLE\s*=\s*false/.test(v2),
   'POS_SALES_READABLE is still false — Dashboard money stays dark');
ok(!/SokoniOrderService/.test(v2),
   'the PENDING-SLICE MARKER still holds: merchant-v2 has no POS order source yet');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
