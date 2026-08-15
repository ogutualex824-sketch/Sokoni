/* Canonical product revalidation — the decision table behind product.js.

   Run:  node scripts/test-product-revalidation.js      (no emulator, no network)

   WHY THIS EXISTS
   product.js rendered a FROZEN SNAPSHOT of the product taken at click time and
   handed over through localStorage['selectedProduct']. It consulted Firestore only
   when the cached copy MISMATCHED the ?id= in the URL — so in the normal case
   (tap a card, cache matches) it never revalidated at all. Two consequences:

     * a price or stock change since the snapshot was invisible;
     * a product DELETED or unpublished server-side was resurrected from
       localStorage and shown as live and purchasable.

   The fix renders the cache first (fast paint) and then revalidates against the
   canonical document. The three outcomes are NOT interchangeable, and conflating
   the last two is what would make an outage look like a deleted catalogue:

     canonical MISSING   -> drop cache, show unavailable   (server says it is gone)
     canonical DIFFERS   -> refresh cache, re-render once  (server has newer truth)
     canonical SAME      -> do nothing
     read FAILED         -> KEEP the cached render         (we do not know)

   The live "missing" path cannot be exercised where Firestore is unreachable —
   an App Check denial throws, which is the read-FAILED branch, not the missing
   branch. So the decision itself is pinned here, and the browser test covers the
   URL identity and the safe-fallback rendering.
*/
'use strict';

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

/* Mirrors product.js. `snap` is {exists, data} or null when the read threw. */
const MATERIAL = ['price','stock','outOfStock','name','status','isVisible','ageRestricted','deliveryCost'];

function revalidationDecision(cached, snap){
  if (!snap) return 'KEEP_CACHE';                 /* read failed — we do not know */
  if (!snap.exists) return 'CLEAR_AND_UNAVAILABLE';
  const fresh = snap.data || {};
  const changed = MATERIAL.some(k =>
    JSON.stringify(fresh[k] === undefined ? null : fresh[k]) !==
    JSON.stringify(cached[k] === undefined ? null : cached[k]));
  return changed ? 'REFRESH_AND_RELOAD' : 'NOOP';
}

const cached = { id:'SP63', name:'Resistance Bands Set', price:1200, stock:5, outOfStock:false };

console.log('\nRevalidation decision table');
ck('canonical MISSING -> clear cache and show unavailable',
   revalidationDecision(cached, { exists:false }) === 'CLEAR_AND_UNAVAILABLE');
ck('a deleted product is NOT resurrected from cache',
   revalidationDecision(cached, { exists:false }) !== 'NOOP');
ck('read FAILED -> keep the cached render (offline must not blank the page)',
   revalidationDecision(cached, null) === 'KEEP_CACHE');
ck('read FAILED is NOT treated as deleted',
   revalidationDecision(cached, null) !== 'CLEAR_AND_UNAVAILABLE');
ck('identical canonical -> no reload',
   revalidationDecision(cached, { exists:true, data:{ ...cached } }) === 'NOOP');

console.log('\nMaterial-field changes force a refresh');
[['price', 1500], ['stock', 0], ['outOfStock', true], ['name', 'Renamed'],
 ['status', 'unpublished'], ['isVisible', false], ['ageRestricted', true], ['deliveryCost', 250]
].forEach(([k, v]) => {
  const snap = { exists:true, data:{ ...cached, [k]: v } };
  ck('changed ' + k + ' -> refresh', revalidationDecision(cached, snap) === 'REFRESH_AND_RELOAD');
});

console.log('\nNon-material differences must NOT cause a reload loop');
/* The cached copy comes from the catalogue API and the fresh copy from the
   Firestore document, so their shapes differ. A whole-object comparison would
   reload on every single visit. */
ck('extra/absent non-material fields -> no reload',
   revalidationDecision(cached, { exists:true, data:{ ...cached, views:99, searchableTerms:['a'], updatedAt:'x' } }) === 'NOOP');
ck('missing non-material field -> no reload',
   revalidationDecision({ ...cached, views: 3 }, { exists:true, data:{ ...cached } }) === 'NOOP');

console.log('\nWiring: the Shop link carries canonical identity');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const cat = fs.readFileSync(path.join(ROOT, 'category.js'), 'utf8');
const prd = fs.readFileSync(path.join(ROOT, 'product.js'), 'utf8');
ck('openProductCat navigates with ?id=', /product\.html\?id=/.test(cat));
ck('the id is URL-encoded', /encodeURIComponent\(String\(id\)\)/.test(cat));
ck('openProductCat no longer navigates to a bare product.html',
   !/window\.location\.href\s*=\s*["']product\.html["']/.test(cat));
ck('product.js revalidates when the cache MATCHES the url id',
   /String\(product\.id\)\s*===\s*String\(_urlId\)/.test(prd));
ck('product.js clears the cache when the canonical doc is absent',
   /removeItem\('selectedProduct'\)/.test(prd));
ck('a reload guard exists (no revalidation loop)', /sokoniPrdRevalidated/.test(prd));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
