/**
 * scripts/test-firestore-search.js
 *
 * Offline test for sokoni-firestore-search.js — the fallback that answers a
 * buyer's query when Algolia is missing, degraded or unindexed.
 *
 * It stubs the Firestore modular SDK, so it needs no project, no credentials
 * and no network. The stub deliberately reproduces the two behaviours that made
 * the real thing fail silently in production:
 *
 *   1. A list query is DENIED when the collection's rule gates reads on
 *      `status` and the query does not carry a matching where() clause. This is
 *      what firestore.rules does, and it is why the old search.html — which
 *      queried services/properties/vehicles/digitalJobs with no constraints at
 *      all — returned nothing from those collections.
 *   2. Documents carry no searchableTerms unless the indexProductCreate trigger
 *      wrote them, so a product listed while the indexer was down is reachable
 *      only through the bounded scan.
 *
 * Run: npm run test:search
 */

'use strict';

const assert = require('assert');
const path   = require('path');
const url    = require('url');

/* ── Fixture data — mirrors the reported failure: Kass Vapes / Cool Mint ──── */
const DATA = {
  products: [
    {
      _id: 'p_coolmint',
      name: 'Cool Mint 50mg',
      category: 'Vapes',
      description: 'Refreshing cool mint pod, 50mg nicotine salt',
      sellerName: 'Kass Vapes',
      price: 1500,
      image: 'https://cdn/x.jpg',
      /* Listed while the indexer was down: no searchableTerms, no nameLower. */
    },
    {
      _id: 'p_indexed',
      name: 'Passion Fruit Kiwi Guava',
      category: 'Vapes',
      price: 1800,
      searchableTerms: ['passion', 'pa', 'pas', 'pass', 'passi', 'passio', 'fruit', 'fr', 'fru', 'frui', 'kiwi', 'ki', 'kiw', 'guava', 'gu', 'gua', 'guav'],
      nameLower: 'passion fruit kiwi guava',
    },
    {
      _id: 'p_archived',
      name: 'Cool Mint Legacy',
      category: 'Vapes',
      price: 900,
      status: 'archived',
      isVisible: false,
    },
    {
      _id: 'p_active_status',
      name: 'Mango Ice 30mg',
      category: 'Vapes',
      price: 1200,
      status: 'active',
    },
  ],
  sellers: [
    { _id: 's_kass', name: 'Kass Vapes', category: 'Vape Store', address: 'Nairobi CBD' },
    { _id: 's_other', name: 'Mama Mboga Fresh', category: 'Groceries' },
  ],
  services: [
    { _id: 'sv_ok',      name: 'Vape Coil Replacement', status: 'active', category: 'Repair' },
    { _id: 'sv_pending', name: 'Vape Cleaning',         status: 'pending', category: 'Repair' },
  ],
  vehicles: [
    { _id: 'v_axio', name: 'Toyota Axio 2015', make: 'Toyota', model: 'Axio', status: 'active', price: 1200000 },
  ],
  lawyers: [
    { _id: 'l_tmm', name: 'T.M.M Advocates', specialty: 'Conveyancing' },
  ],
};

/* Collections whose firestore.rules read gate gets evaluated per document —
   a list query missing the matching where() clause is rejected wholesale. */
const RULE_STATUS_GATE = {
  services:         ['active', 'published'],
  properties:       ['active', 'published'],
  propertyListings: ['active'],
  vehicles:         ['active', 'published'],
  digitalJobs:      ['active', 'published'],
  healthProviders:  ['active'],
  providers:        ['active', 'approved'],
};

let readCount = 0;

/* ── Stub of the Firestore modular SDK ────────────────────────────────────── */
const where = (field, op, value) => ({ _t: 'where', field, op, value });
const limit = (n)                => ({ _t: 'limit', n });

const sdk = {
  where,
  limit,
  collection: (_db, name) => ({ _col: name }),
  query: (col, ...constraints) => ({ _col: col._col, constraints }),
  getDocs: async (q) => {
    const gate = RULE_STATUS_GATE[q._col];
    if (gate) {
      const guard = q.constraints.find(c => c._t === 'where' && c.field === 'status');
      const ok = guard && (guard.op === '=='
        ? gate.includes(guard.value)
        : (guard.value || []).every(v => gate.includes(v)));
      if (!ok) {
        const err = new Error('Missing or insufficient permissions.');
        err.code = 'permission-denied';
        throw err;
      }
    }

    let rows = (DATA[q._col] || []).slice();
    for (const c of q.constraints) {
      if (c._t !== 'where') continue;
      if (c.op === 'array-contains') {
        rows = rows.filter(r => Array.isArray(r[c.field]) && r[c.field].includes(c.value));
      } else if (c.op === '==') {
        rows = rows.filter(r => r[c.field] === c.value);
      } else if (c.op === 'in') {
        rows = rows.filter(r => c.value.includes(r[c.field]));
      } else if (c.op === '>=') {
        rows = rows.filter(r => r[c.field] !== undefined && r[c.field] >= c.value);
      } else if (c.op === '<' || c.op === '<=') {
        rows = rows.filter(r => r[c.field] !== undefined && r[c.field] < c.value);
      }
    }
    const lim = q.constraints.find(c => c._t === 'limit');
    if (lim) rows = rows.slice(0, lim.n);
    readCount += rows.length;

    return {
      forEach: (fn) => rows.forEach(r => {
        const { _id, ...rest } = r;
        fn({ id: _id, data: () => rest });
      }),
    };
  },
};

/* ── Runner ───────────────────────────────────────────────────────────────── */
const results = [];
function check(name, fn) {
  try { fn(); results.push([true, name]); }
  catch (err) { results.push([false, name + ' — ' + err.message]); }
}

(async () => {
  const modPath = url.pathToFileURL(
    path.join(__dirname, '..', 'sokoni-firestore-search.js')
  ).href;
  const mod = await import(modPath);
  const db  = {};
  const run = (q, opts) =>
    mod.firestoreSearch(db, q, Object.assign({ sdk }, opts || {}));

  const titles = rows => rows.map(r => r.title);

  /* 1 — the exact reported failure */
  mod.invalidateScanCache();
  const coolMint = await run('cool mint');
  check('finds an unindexed product by name ("cool mint")', () => {
    assert.ok(titles(coolMint).includes('Cool Mint 50mg'), 'got ' + JSON.stringify(titles(coolMint)));
  });
  check('soft-deleted product stays hidden', () => {
    assert.ok(!titles(coolMint).includes('Cool Mint Legacy'));
  });
  check('product result links to its product page', () => {
    const row = coolMint.find(r => r.id === 'p_coolmint');
    assert.strictEqual(row.link, 'product.html?id=p_coolmint');
    assert.strictEqual(row.tab, 'products');
  });

  /* 2 — the store itself must be findable */
  const kass = await run('kass vapes');
  check('finds the store by name ("kass vapes")', () => {
    const row = kass.find(r => r.id === 's_kass');
    assert.ok(row, 'store missing from ' + JSON.stringify(titles(kass)));
    assert.strictEqual(row.link, 'store.html?id=s_kass');
    assert.strictEqual(row.tab, 'businesses');
  });
  check('store query also surfaces that store\'s products', () => {
    assert.ok(kass.some(r => r.id === 'p_coolmint'));
  });

  /* 3 — relaxed pass: a generic second word must not zero out the result */
  const kassShop = await run('kass shop');
  check('"kass shop" still finds Kass Vapes (relaxed pass)', () => {
    assert.ok(kassShop.some(r => r.id === 's_kass'), 'got ' + JSON.stringify(titles(kassShop)));
  });

  /* 4 — AND semantics hold when a strict match exists */
  const mangoMint = await run('mango mint');
  check('"mango mint" does not return every mint product', () => {
    assert.ok(!mangoMint.some(r => r.id === 'p_coolmint' && r._matched === 2));
  });

  /* 5 — indexed path (searchableTerms) still works */
  const passion = await run('passion fruit');
  check('finds a trigger-indexed product via searchableTerms', () => {
    assert.ok(passion.some(r => r.id === 'p_indexed'));
  });

  /* 6 — rule-gated collections are queried in a way rules permit */
  const coil = await run('vape coil');
  check('rule-gated collection (services) returns its active rows', () => {
    assert.ok(coil.some(r => r.id === 'sv_ok'), 'services denied or empty');
  });
  check('rule-gated collection excludes non-active rows', () => {
    assert.ok(!coil.some(r => r.id === 'sv_pending'));
  });
  const axio = await run('toyota axio');
  check('rule-gated collection (vehicles) is searchable', () => {
    assert.ok(axio.some(r => r.id === 'v_axio'));
  });

  /* 7 — tab scoping */
  const businessesOnly = await run('kass', { tab: 'businesses' });
  check('tab scoping restricts results to that tab', () => {
    assert.ok(businessesOnly.length > 0);
    assert.ok(businessesOnly.every(r => r.tab === 'businesses'));
  });

  /* 8 — scan cache: a second identical query costs no further reads */
  const before = readCount;
  await run('cool mint');
  check('session scan cache prevents repeat reads', () => {
    assert.strictEqual(readCount, before, readCount - before + ' extra reads');
  });

  /* 9 — empty query is a no-op, not a full catalogue dump */
  check('empty query returns nothing', async () => {
    assert.deepStrictEqual(await run('   '), []);
  });

  /* 10 — typo tolerance: a single wrong character still finds the product */
  const typo = await run('cool mnit');
  check('single-character typo still matches ("cool mnit")', () => {
    assert.ok(typo.some(r => r.id === 'p_coolmint'), 'got ' + JSON.stringify(titles(typo)));
  });
  const typo2 = await run('vapes');
  check('plural/suffix difference still matches ("vapes" → Vape)', () => {
    assert.ok(typo2.length > 0);
  });

  /* 11 — typo tolerance must not fire on short tokens.
     "pud" is one edit from "pod", which appears in the Cool Mint description.
     At three characters that tolerance is noise (pod/pot/pop/cod all collapse
     together), so the strict pass must reject it. The relaxed pass may still
     surface something — this asserts the strict behaviour, which is what
     governs a query that would otherwise have matched. */
  const shortTok = await run('pud');
  check('short tokens are matched exactly, not fuzzily', () => {
    const strictHit = shortTok.find(r => r.id === 'p_coolmint' && r._matched === 1 && r._score > 12);
    assert.ok(!strictHit, 'a 3-letter token fuzzed into a match');
  });

  /* 12 — bilingual expansion: a Swahili query finds English catalogue text */
  DATA.products.push({
    _id: 'p_simu', name: 'Samsung Galaxy A55 Phone', category: 'Electronics', price: 45000,
  });
  mod.invalidateScanCache();
  const swahili = await run('simu');
  check('Swahili query finds English listing ("simu" → Phone)', () => {
    assert.ok(swahili.some(r => r.id === 'p_simu'), 'got ' + JSON.stringify(titles(swahili)));
  });

  /* 13 — exact matches outrank fuzzy ones */
  const ranked = await run('mint');
  check('exact match ranks above fuzzy match', () => {
    assert.ok(/mint/i.test(ranked[0].title), 'top hit was ' + ranked[0].title);
  });

  /* 14 — suggest() serves instantly from cache and never hits the network */
  const sugg = mod.suggest('cool', 5);
  check('suggest() returns cached prefix matches synchronously', () => {
    assert.ok(Array.isArray(sugg) && sugg.some(s => /cool mint/i.test(s.title)),
      'got ' + JSON.stringify(sugg.map(s => s.title)));
  });
  check('suggest() ignores a one-character prefix', () => {
    assert.deepStrictEqual(mod.suggest('c', 5), []);
  });

  /* 15 — when the catalogue outgrows the scan window, the indexed path must
     still find a product sitting beyond it. This is the case the scan-first
     optimisation must not break: below the cap the scan is the whole
     collection, above it the searchableTerms lookup is the only way in. */
  const filler = Array.from({ length: 420 }, (_, i) => ({
    _id: 'p_filler_' + i, name: 'Filler Item ' + i, category: 'Misc', price: 100,
  }));
  const beyond = {
    _id: 'p_beyond_window',
    name: 'Rare Tangerine Blast',
    category: 'Vapes',
    price: 2100,
    searchableTerms: ['rare', 'ra', 'rar', 'tangerine', 'ta', 'tan', 'tang', 'tange', 'blast', 'bl', 'bla', 'blas'],
    nameLower: 'rare tangerine blast',
  };
  DATA.products = filler.concat([beyond]);       /* target is past the 400 cap */
  mod.invalidateScanCache();
  const deep = await run('tangerine');
  check('indexed lookup still reaches past the scan window', () => {
    assert.ok(deep.some(r => r.id === 'p_beyond_window'),
      'got ' + JSON.stringify(titles(deep).slice(0, 3)));
  });

  /* 16 — a FAILED read must never be cached as "empty".
     warm() starts as the module loads, which can be before App Check has a
     token; those first reads are denied. Caching that denial made the entire
     catalogue disappear for the rest of the session. This asserts the retry:
     the first attempt fails, the second succeeds, and the search finds the
     product rather than an empty cache. */
  DATA.products = [{
    _id: 'p_retry', name: 'Retry Widget', category: 'Misc', price: 10,
  }];
  mod.invalidateScanCache();
  let firstCall = true;
  const flakySdk = Object.assign({}, sdk, {
    getDocs: async (q) => {
      if (firstCall && q._col === 'products') {
        firstCall = false;
        const err = new Error('Missing or insufficient permissions.');
        err.code = 'permission-denied';
        throw err;
      }
      return sdk.getDocs(q);
    },
  });
  const attempt1 = await mod.firestoreSearch(db, 'retry widget', { sdk: flakySdk, tab: 'products' });
  const attempt2 = await mod.firestoreSearch(db, 'retry widget', { sdk: flakySdk, tab: 'products' });
  check('a denied read self-heals within the same search, and is never cached as empty', () => {
    assert.ok(attempt1.some(r => r.id === 'p_retry'),
      'the search that hit the denial should have retried and found the product');
    assert.ok(attempt2.some(r => r.id === 'p_retry'),
      'a later search served a poisoned empty cache');
  });

  const failed = results.filter(([ok]) => !ok);
  console.log('\n  Firestore search — ' + (results.length - failed.length) + '/' + results.length + ' passed\n');
  results.forEach(([ok, name]) => console.log('   ' + (ok ? 'PASS' : 'FAIL') + '  ' + name));
  console.log('');
  process.exit(failed.length ? 1 : 0);
})().catch(err => {
  console.error('  harness error:', err);
  process.exit(1);
});
