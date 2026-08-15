/* Authoritative catalogue apply — the rule behind category.js::_catMergeFirestore.

   Run:  node scripts/test-catalogue-authority.js      (no emulator, no network)

   THE INVARIANT
   A product absent from the authoritative catalogue must never be resurrected
   into the buyer-facing Shop/Marketplace grid from localStorage.

   WHAT WAS WRONG
       if (!fsProducts || !fsProducts.length) return;            // (1)
       const localOnly = allProducts.filter(p => !fsIds.has(p.id));
       allProducts = [...fsProducts, ...localOnly];              // (2)

   (1) An authoritative EMPTY catalogue was treated as "nothing happened", so a
       seller who unpublished their last product left buyers looking at items that
       no longer exist.
   (2) Anything the server did not return was reclassified "local-only, not yet
       synced" and KEPT -- then persisted back to localStorage, so a deleted or
       unpublished product survived every future session. No deletion path existed.

   SUCCESS vs FAILURE -- AND WHY INVOCATION IS NOT SUCCESS
   The first cut assumed listenProducts() only calls back on an authoritative
   success, so being called was the success signal. A browser run disproved it:
   with App Check rejected, onSnapshot delivers a zero-doc snapshot from a cold
   local cache (fromCache:true), and listenProducts delivered it once its single
   retry was exhausted -- emptying the grid, persisting [] over the cache, and
   landing ~1s AFTER the good /api/catalogue fallback so it clobbered real data.

   Authority is therefore STATED, not inferred. listenProducts passes
   meta.authoritative, true only for a server-confirmed snapshot (fromCache:false)
   or the Admin-SDK /api/catalogue response, and no longer delivers an unconfirmed
   empty at all. REMOVALS and PERSISTENCE require authority; an unconfirmed
   delivery is additive/refresh-only. A failed read still never calls back.

   SCOPE
   The listener is category-scoped when the page is, so the authoritative answer
   speaks only for that category. Removing everything absent from the response
   would wipe every OTHER category from the cache. Out-of-scope products are
   preserved; only in-scope absences are removals.
*/
'use strict';

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

const DEMO_IDS = ['D1', 'D2'];

/* Mirrors category.js::_catMergeFirestore. `fsProducts === null` models a FAILED
   read, which in production means the callback never fires at all. `meta` defaults
   to authoritative so the existing scenarios read unchanged; the unconfirmed cases
   pass it explicitly. Returns { list, persisted } -- persistence is part of the
   contract, since an unconfirmed write bakes a transient failure into next load. */
function applyCatalogue(cached, fsProducts, scope, meta) {
  if (!Array.isArray(fsProducts)) return { list: cached.slice(), persisted: false };
  const authoritative = meta === undefined ? true : !!(meta && meta.authoritative);
  const inScope = (p) => scope === 'all' || String((p && p.category) || '').toLowerCase() === scope;
  const fsIds = new Set(fsProducts.map(p => String(p.id)));
  const dropDemo = authoritative || fsProducts.length > 0;
  const preserved = cached.filter(p =>
    !fsIds.has(String(p.id))
    && (authoritative ? !inScope(p) : true)
    && !(dropDemo && DEMO_IDS.includes(String(p.id))));
  return { list: [...fsProducts, ...preserved], persisted: authoritative };
}
const apply = (...a) => applyCatalogue(...a).list;
const ids = (a) => a.map(p => String(p.id)).sort().join(',');

const A = { id: 'A', category: 'electronics', price: 100 };
const B = { id: 'B', category: 'electronics', price: 200 };
const C = { id: 'C', category: 'electronics', price: 300 };

console.log('\nTHE defect scenario: cache [A,B,C], server [A,C]');
{
  const out = apply([A, B, C], [A, C], 'all');
  ck('B disappears', ids(out) === 'A,C', ids(out));
  ck('B is NOT resurrected as "local-only, not yet synced"', !out.some(p => p.id === 'B'));
}

console.log('\nAuthoritative EMPTY is not the same as a failed read');
ck('successful empty catalogue -> grid genuinely empties',
   ids(apply([A, B, C], [], 'all')) === '');
ck('FAILED read -> cached products remain',
   ids(apply([A, B, C], null, 'all')) === 'A,B,C');
ck('failed read never empties the grid',
   apply([A, B, C], null, 'all').length === 3);
ck('failed read is not confused with an empty catalogue',
   ids(apply([A, B, C], null, 'all')) !== ids(apply([A, B, C], [], 'all')));

console.log('\nScope: a category-scoped answer must not wipe other categories');
{
  const fashion = { id: 'F1', category: 'fashion', price: 50 };
  const cached  = [A, B, fashion];
  const out = apply(cached, [A], 'electronics');   /* server: only A in electronics */
  ck('in-scope absentee B is removed', !out.some(p => p.id === 'B'));
  ck('out-of-scope F1 (fashion) is preserved', out.some(p => p.id === 'F1'));
  ck('in-scope survivor A is present', out.some(p => p.id === 'A'));
}

console.log('\nCanonical data wins; ids are preserved exactly');
{
  const stale = { id: 'A', category: 'electronics', price: 100, stock: 5 };
  const fresh = { id: 'A', category: 'electronics', price: 175, stock: 0 };
  const out = apply([stale], [fresh], 'all');
  ck('price change propagates', out[0].price === 175);
  ck('stock change propagates', out[0].stock === 0);
  ck('exactly one row for the id (no duplicate)', out.filter(p => p.id === 'A').length === 1);
  ck('id preserved exactly, never matched by name', String(out[0].id) === 'A');
}

console.log('\nDemo stubs never survive an authoritative answer');
{
  const demo = { id: 'D1', category: 'electronics', price: 1 };
  const out = apply([demo, A], [A], 'all');
  ck('demo stub dropped once real data arrives', !out.some(p => p.id === 'D1'));
  const out2 = apply([{ id: 'D2', category: 'fashion' }, A], [A], 'electronics');
  ck('demo stub dropped even when out of scope', !out2.some(p => p.id === 'D2'));
}

/* ── THE REGRESSION THIS SECTION EXISTS FOR ────────────────────────────────────
   Measured, not theorised. Local run, App Check rejected:
     snapshot attempt 1  docs:0 fromCache:true  -> retry-empty-cache
     snapshot attempt 2  docs:0 fromCache:true  -> DELIVERED as authoritative
     _catMergeFirestore([]) -> cards 0, catCount "0 products found", cache []
   An unconfirmed read must not be able to do that. */
console.log('\nAn UNCONFIRMED read is not authority');
{
  const UNC = { source: 'firestore', fromCache: true, authoritative: false };

  const wipe = applyCatalogue([A, B, C], [], 'all', UNC);
  ck('unconfirmed empty does NOT empty the grid', ids(wipe.list) === 'A,B,C', ids(wipe.list));
  ck('unconfirmed empty is NOT persisted over the cache', wipe.persisted === false);

  const demo = { id: 'D1', category: 'electronics', price: 1 };
  ck('unconfirmed empty does not blank a demo-seeded grid',
     applyCatalogue([demo], [], 'all', UNC).list.length === 1);

  /* The production ordering: /api/catalogue lands first with real products, then a
     stale cached snapshot arrives. It must not clobber the confirmed answer. */
  const good = applyCatalogue([], [A, B, C], 'all', { source: 'http', authoritative: true });
  ck('confirmed fallback result is persisted', good.persisted === true);
  const after = applyCatalogue(good.list, [], 'all', UNC);
  ck('a later unconfirmed empty does not clobber it', ids(after.list) === 'A,B,C', ids(after.list));

  /* Still useful, just not destructive: fresher field values apply, new rows add. */
  const refreshed = applyCatalogue([{ id:'A', category:'electronics', price:100 }, B],
                                   [{ id:'A', category:'electronics', price:175 }], 'all', UNC);
  ck('unconfirmed delivery still refreshes fields', refreshed.list.find(p => p.id === 'A').price === 175);
  ck('unconfirmed delivery still keeps unmentioned rows', refreshed.list.some(p => p.id === 'B'));
  ck('unconfirmed delivery removes nothing', ids(refreshed.list) === 'A,B');
  ck('unconfirmed refresh is not persisted', refreshed.persisted === false);

  /* Absent meta = a caller that cannot vouch for the read. Fail safe, not open. */
  ck('missing meta is treated as unconfirmed, not authoritative',
     ids(applyCatalogue([A, B, C], [], 'all', null).list) === 'A,B,C');

  /* And authority must still WORK — the invariant is not weakened. */
  const AUTH = { source: 'firestore', fromCache: false, authoritative: true };
  ck('confirmed empty still empties the grid', ids(applyCatalogue([A, B, C], [], 'all', AUTH).list) === '');
  ck('confirmed answer still removes an in-scope absentee',
     !applyCatalogue([A, B, C], [A, C], 'all', AUTH).list.some(p => p.id === 'B'));
}

console.log('\nWiring assertions');
{
  const fs = require('fs'), path = require('path');
  const raw = fs.readFileSync(path.join(__dirname, '..', 'category.js'), 'utf8');
  /* Strip block and line comments before asserting an absence. The commit that
     removed the old guard also QUOTES it in an explanatory comment, so a naive
     search finds the documentation and reports the code as unchanged. */
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('empty array is no longer an early return (executable code, comments stripped)',
     !/if \(!fsProducts \|\| !fsProducts\.length\) return;/.test(src));
  ck('only a malformed call is ignored', /if \(!Array\.isArray\(fsProducts\)\) return;/.test(src));
  ck('the "local-only" resurrection path is gone', !/Keep local-only products/.test(src));
  ck('scope is derived from the same cat param the listener uses',
     /const scope\s*=\s*\(new URLSearchParams\(location\.search\)\.get\('cat'\)/.test(src));
  ck('the authoritative snapshot is persisted', /localStorage\.setItem\('sellerProducts'/.test(src));
  ck('authority is read from meta, not inferred from invocation',
     /const authoritative = !!\(meta && meta\.authoritative\)/.test(src));
  ck('removals are gated on authority', /authoritative \? !inScope\(p\) : true/.test(src));
  ck('persistence is gated on authority',
     /if \(authoritative\) \{[\s\S]{0,200}?localStorage\.setItem\('sellerProducts'/.test(src));

  /* The source of truth: listenProducts must not present an unconfirmed empty as
     a real one, and must state authority when it does call back. */
  const dbRaw = fs.readFileSync(path.join(__dirname, '..', 'sokoni-db.js'), 'utf8');
  const dbSrc = dbRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('listenProducts never delivers an empty cached snapshot',
     /if \(snap\.size === 0 && snap\.metadata\.fromCache\) \{/.test(dbSrc));
  ck('the old "retry once then deliver anyway" guard is gone',
     !/snap\.size === 0 && snap\.metadata\.fromCache && attempt < 2/.test(dbSrc));
  ck('an undeliverable empty leaves the HTTP fallback armed (_delivered stays false)',
     /drop-unconfirmed-empty/.test(dbSrc));
  ck('snapshot deliveries state their authority',
     /authoritative: !snap\.metadata\.fromCache/.test(dbSrc));
  ck('the Admin-SDK fallback is marked authoritative',
     /source: 'http', fromCache: false, authoritative: true/.test(dbSrc));

  /* The bridge between them. Dropping `meta` here would make every delivery look
     unconfirmed and silently disable the deletion path — the invariant would
     regress with all unit tests still green. */
  const html = fs.readFileSync(path.join(__dirname, '..', 'category.html'), 'utf8');
  ck('category.html forwards meta to _catMergeFirestore',
     /listenProducts\(_opts, function\(fsProducts, meta\)[\s\S]{0,240}?_catMergeFirestore\(fsProducts, meta\)/.test(html));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
