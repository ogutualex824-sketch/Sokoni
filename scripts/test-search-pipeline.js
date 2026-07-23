/* Search pipeline contract.

   Two defects made every uploaded product undiscoverable, and neither produced
   an error anywhere. They are the same shape: one half of the platform agreed
   on a name, the other half used a different one, and nothing compared them.

     1. functions/algolia-indexer.js wrote products to `products_index`.
        The live search UI reads `sokoni_products`. The record existed and no
        query could reach it.

     2. seller.js never wrote a top-level `status`. Every retrieval path filters
        `where('status','==','active')`, and a Firestore equality filter does
        not match a document where the field is ABSENT — so the product was not
        ranked low, it was excluded entirely.

   These assertions compare the two halves directly, so the next rename fails
   here instead of silently emptying search. */
'use strict';
const fs = require('fs');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};

const indexer  = fs.readFileSync('functions/algolia-indexer.js', 'utf8');
const syncReg  = fs.readFileSync('functions/search-sync.js', 'utf8');
const engine   = fs.readFileSync('sokoni-search-engine.js', 'utf8');
const service  = fs.readFileSync('functions/search-service.js', 'utf8');
const sellerJs = fs.readFileSync('seller.js', 'utf8');

/* ── the index name must agree across write and read ──────────────────────── */
console.log('\n── Write target matches read target ──');

const writeIdx = (indexer.match(/products:\s*\{\s*index:\s*'([^']+)'/) || [])[1];
const regIdx   = (syncReg.match(/algoliaIndex:\s*'([^']+)'/) || [])[1];
const engineHasIdx = new RegExp('\\b' + (writeIdx || 'x') + '\\b').test(engine);

ck('indexer declares a products index', !!writeIdx, writeIdx || 'not found');
ck('SEARCH_SYNC registry declares one', !!regIdx, regIdx || 'not found');
ck('indexer target === registry target', writeIdx === regIdx, writeIdx + ' vs ' + regIdx);
ck('live search engine queries that index', engineHasIdx === true, writeIdx);

/* foods share the products transformer and must share its index */
const foodsIdx = (indexer.match(/foods:\s*\{\s*index:\s*'([^']+)'/) || [])[1];
ck('foods indexed alongside products', foodsIdx === writeIdx, foodsIdx + ' vs ' + writeIdx);

/* ── every retrieval path filters on status, so uploads must set it ───────── */
console.log('\n── Products are written with the field search filters on ──');

/* The CLIENT fallback is asserted differently from the server paths, and the
   difference is deliberate.

   This used to require a literal where('status','==','active') in
   sokoni-search-engine.js. That assertion encoded a contract the data does not
   honour: most live products carry no `status` field at all, and a Firestore
   equality filter EXCLUDES documents missing the field — so the filter it was
   demanding made the client fallback incapable of returning a hit under any
   circumstance. Satisfying this test as written would break search.

   The real contract (docs: status + isVisible, ABSENT = visible; soft-delete is
   an archive) now lives in sokoni-firestore-search.js::isVisibleDoc, which the
   engine delegates to. Assert THAT: the engine must route through the module,
   and the module must reject the hidden states. */
const fsSearch = fs.readFileSync('sokoni-firestore-search.js', 'utf8');

ck('client fallback delegates to sokoni-firestore-search',
   /import\(\s*['"]\.\/sokoni-firestore-search\.js['"]\s*\)/.test(engine) === true);
ck('shared module enforces the visibility contract',
   /function\s+isVisibleDoc/.test(fsSearch) === true &&
   /if\s*\(!isVisibleDoc\(/.test(fsSearch) === true);
ck('hidden states are excluded (archived/deleted/hidden/removed/banned)',
   ['archived', 'deleted', 'hidden', 'removed', 'banned']
     .every(s => new RegExp(s + '\\s*:\\s*1').test(fsSearch)));
ck('an absent status stays visible (no equality filter on status)',
   /where\(\s*'status'\s*,\s*'=='\s*,\s*'active'\s*\)/.test(engine) === false);

/* The server paths hold a genuine index-backed filter and are unchanged. */
const filtersOnStatus = [
  ["server fallback (search-service.js)",       /where\(\s*'status'\s*,\s*'=='\s*,\s*'active'\s*\)/.test(service)],
  ["typesense filter (search-service.js)",      /status:=active/.test(service)],
];
filtersOnStatus.forEach(([label, present]) => ck(label + ' filters on status', present === true));

/* The upload payload must carry a TOP-LEVEL status. ownership.status and
   verificationStatus are different fields with different meanings — matching
   them here would let the real gap reappear. */
const uploadBlock = sellerJs.slice(sellerJs.indexOf('const newProduct'), sellerJs.indexOf('let sellerProducts'));
const hasTopLevelStatus = /\n\s{8,}status:\s*["']active["']/.test(uploadBlock);
ck('upload sets top-level status:"active"', hasTopLevelStatus === true);
ck('not satisfied by ownership.status alone',
   hasTopLevelStatus === true && /ownership:/.test(uploadBlock));

/* ── the filter must actually exclude a doc without the field ─────────────── */
console.log('\n── The failure mode itself ──');
/* Firestore equality never matches an absent field. Modelled here so the reason
   the product vanished is asserted, not just asserted around. */
const docs = [
  { id: 'peach-grape-no-status', name: 'Peach Grape' },
  { id: 'peach-grape-active', name: 'Peach Grape', status: 'active' },
];
const whereStatusActive = (rows) => rows.filter((r) => r.status === 'active');
ck('a product with no status is excluded', whereStatusActive([docs[0]]).length === 0);
ck('the same product with status is returned', whereStatusActive([docs[1]]).length === 1);

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
