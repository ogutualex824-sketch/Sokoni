/* test-creator-search.js — Creator films in platform search, executed.
 *
 * Runs the REAL sokoni-firestore-search.js (the Firestore path search.html uses,
 * and the ONE search authority for Creator films) against a rules-faithful stub
 * SDK: an anonymous LIST of entertainmentListings is refused unless the query
 * carries status == 'active', exactly as firestore.rules does.
 *
 * The defect this closes: search.html rendered Algolia's hits and returned —
 * Creator films are not in the Algolia index, so any query Algolia answered
 * hid every film. mergeCreatorFilms folds Firestore's films into the primary
 * answer; nothing else is merged, so marketplace results are unchanged.
 *
 *   node scripts/test-creator-search.js
 */
'use strict';
const path = require('path');
const url = require('url');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

const DATA = {
  entertainmentListings: [
    { _id: 'film_pub', creatorHub: true, status: 'active', pubState: 'PUBLISHED', title: 'Nairobi Nights', genre: 'Drama', subcategory: 'movies', creatorName: 'Kibera Films', priceCents: 50000, posterUrl: 'https://x/p.jpg', runtimeMinutes: 96 },
    { _id: 'film_pub2', creatorHub: true, status: 'active', pubState: 'PUBLISHED', title: 'Rift Valley Runner', genre: 'Documentary', creatorName: 'Wanjiku Studios', priceCents: 30000 },
    { _id: 'film_draft', creatorHub: true, status: 'draft', pubState: 'DRAFT', title: 'Nairobi Secret Draft', creatorName: 'Kibera Films', priceCents: 50000 },
    { _id: 'film_submitted', creatorHub: true, status: 'draft', pubState: 'SUBMITTED', title: 'Nairobi Submitted', creatorName: 'Kibera Films' },
    { _id: 'film_review', creatorHub: true, status: 'draft', pubState: 'UNDER_REVIEW', title: 'Nairobi Under Review', creatorName: 'Kibera Films' },
    { _id: 'film_approved', creatorHub: true, status: 'draft', pubState: 'APPROVED', title: 'Nairobi Approved Unpublished', creatorName: 'Kibera Films' },
    { _id: 'film_suspended', creatorHub: true, status: 'suspended', pubState: 'SUSPENDED', title: 'Nairobi Suspended', creatorName: 'Kibera Films' },
    { _id: 'legacy_ent', status: 'active', title: 'Nairobi Legacy Comedy Special', category: 'comedy_show' },
    /* film_deleted: the document is gone — deletion is absence */
  ],
  products: [{ _id: 'p1', name: 'Nairobi Coffee', category: 'food', price: 900 }],
};
const where = (field, op, value) => ({ _t: 'where', field, op, value });
const limit = (n) => ({ _t: 'limit', n });
const sdk = {
  where, limit,
  collection: (_db, name) => ({ _col: name }),
  query: (col, ...constraints) => ({ _col: col._col, constraints }),
  getDocs: async (q) => {
    if (q._col === 'entertainmentListings' && !q.constraints.some((c) => c._t === 'where' && c.field === 'status' && c.op === '==' && c.value === 'active')) {
      const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e;
    }
    let rows = (DATA[q._col] || []).slice();
    for (const c of q.constraints) {
      if (c._t !== 'where') continue;
      if (c.op === '==') rows = rows.filter((r) => r[c.field] === c.value);
      else if (c.op === 'in') rows = rows.filter((r) => c.value.includes(r[c.field]));
      else if (c.op === 'array-contains') rows = rows.filter((r) => Array.isArray(r[c.field]) && r[c.field].includes(c.value));
      else if (c.op === '>=') rows = rows.filter((r) => r[c.field] !== undefined && r[c.field] >= c.value);
      else if (c.op === '<') rows = rows.filter((r) => r[c.field] !== undefined && r[c.field] < c.value);
    }
    const lim = q.constraints.find((c) => c._t === 'limit'); if (lim) rows = rows.slice(0, lim.n);
    return { forEach: (fn) => rows.forEach((r) => { const { _id, ...rest } = r; fn({ id: _id, data: () => rest }); }) };
  },
};

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 150) + ']' : '')); ok ? pass++ : fail++; };

(async () => {
  const mod = await import(url.pathToFileURL(path.join(ROOT, 'sokoni-firestore-search.js')).href);
  const search = async (q, tab = 'all') => { mod.invalidateScanCache && mod.invalidateScanCache(); return mod.firestoreSearch({}, q, { sdk, tab, limit: 60 }); };
  const films = (rows) => rows.filter((r) => r.tab === 'films');

  console.log('\n── the Firestore authority: what is findable ──');
  const t = await search('nairobi');
  const ids = films(t).map((r) => r.id);
  ck('published film found by title', ids.includes('film_pub'), ids);
  ck('only PUBLISHED films (draft/submitted/review/approved-unpublished/suspended absent)', ids.length === 1 && ids[0] === 'film_pub', ids);
  ck('a deleted film (document gone) cannot appear', !t.some((r) => r.id === 'film_deleted'));
  ck('a legacy non-Creator entertainment row is not a film', !ids.includes('legacy_ent'));
  const byCreator = films(await search('wanjiku'));
  ck('found by creator name', byCreator.some((r) => r.id === 'film_pub2'), byCreator.map((r) => r.id));
  const tab = await search('nairobi', 'films');
  ck('Films tab returns the film', tab.some((r) => r.id === 'film_pub' && r.tab === 'films'));
  const row = films(t)[0];
  ck('result links to the purchase page', row.link === 'creator.html?film=film_pub', row.link);
  ck('result carries price and poster, never a media location', row.price && /500/.test(row.price) && row.thumbnail === 'https://x/p.jpg' && !/creator-masters|creator-previews/.test(JSON.stringify(row)), row);

  console.log('\n── mergeCreatorFilms (Algolia answered) ──');
  const algolia = [{ id: 'p1', tab: 'products', title: 'Nairobi Coffee' }, { id: 'svc9', tab: 'services', title: 'Nairobi Plumbing' }];
  const merged = mod.mergeCreatorFilms(algolia, t);
  ck('films are no longer hidden when Algolia has hits', merged.some((r) => r.id === 'film_pub'));
  ck('Algolia rows keep their order and content (marketplace unchanged)', JSON.stringify(merged.slice(0, 2)) === JSON.stringify(algolia));
  ck('only films are merged — no other Firestore row joins the Algolia answer', merged.slice(2).every((r) => r.tab === 'films') && !merged.some((r) => r.tab === 'products' && r.id !== 'p1'));
  ck('no duplicates if Algolia already returned the film', mod.mergeCreatorFilms([{ id: 'film_pub', tab: 'films' }], t).filter((r) => r.id === 'film_pub').length === 1);
  ck('no films → the primary array itself is returned (nothing re-rendered)', mod.mergeCreatorFilms(algolia, [{ id: 'p1', tab: 'products' }]) === algolia);
  ck('deterministic (same input → same output)', JSON.stringify(mod.mergeCreatorFilms(algolia, t)) === JSON.stringify(merged));
  ck('empty / bad input is safe', mod.mergeCreatorFilms(null, null).length === 0 && mod.mergeCreatorFilms(algolia, undefined) === algolia);

  console.log('\n── search.html wiring ──');
  const page = fs.readFileSync(path.join(ROOT, 'search.html'), 'utf8');
  ck('search.html imports mergeCreatorFilms from the Firestore module (one authority)', /import \{[^}]*mergeCreatorFilms[^}]*\} from "\.\/sokoni-firestore-search\.js"/.test(page));
  ck('Algolia path merges films after rendering, guarded against a stale query', /mergeCreatorFilms\(allResults, fsRowsLate\)/.test(page) && /if \(lastQuery !== _qAt\) return;/.test(page));
  ck('no second search index was added for films', !/sokoni_films|films_index/.test(page));

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('HARNESS CRASHED', e && e.stack); process.exit(2); });
