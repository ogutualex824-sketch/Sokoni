#!/usr/bin/env node
/* takedown-index-reconcile.js — canonical products ↔ Algolia ↔ Typesense visibility reconciliation (spec §20)
 *
 * READ-ONLY. DRY-RUN BY DEFAULT. PRINTS COUNTS ONLY — never a product id, a product field, a key or a host.
 *
 *   node scripts/takedown-index-reconcile.js                 # PLAN: prints what it would read; no network, no credentials
 *   node scripts/takedown-index-reconcile.js --self-test     # the classifier on an in-memory fixture (no network; asserts
 *                                                            # the real firebase-admin is NOT loaded)
 *   node scripts/takedown-index-reconcile.js --read --project <id> --i-understand-this-reads-production
 *                                                            # OWNER-RUN ONLY: read-only counts against a live project
 *
 * There is NO write mode. Repair is never automatic: a HIDDEN_CANONICAL_INDEXED record is removed by the index path
 * itself (re-save the product, or run the existing reindex — the enqueue guard turns an upsert of a hidden product
 * into a delete). Blind deletes from an index are not offered here (spec §20: "never blind deletes").
 *
 * --read sources (all read-only):
 *   canonical  Firestore products, paged by document id, fields isVisible/visible/status/moderationHold/deleted/isDeleted
 *              (application-default credentials; the project id is REQUIRED on the command line — never inferred)
 *   Algolia    POST /1/indexes/sokoni_products/browse  attributesToRetrieve=[objectID]  (env ALGOLIA_APP_ID, ALGOLIA_BROWSE_KEY)
 *   Typesense  GET  /collections/sokoni_products/documents/export?include_fields=id  (env TYPESENSE_URL, TYPESENSE_READ_KEY)
 *
 * CLASSES (per engine):
 *   VISIBLE_CANONICAL_INDEXED       canonical public, in the index                       → MATCHED
 *   HIDDEN_CANONICAL_NOT_INDEXED    canonical not public, not in the index               → MATCHED
 *   HIDDEN_CANONICAL_INDEXED        canonical not public (taken down / hidden), in index  → VIOLATION (served only if a
 *                                   surface skips the server re-check; the server search/recommend gates drop it)
 *   MISSING                         canonical public, not in the index                    → under-indexed
 *   STALE                           in the index, no products document (deleted product OR a foods/deals/inventory
 *                                   record sharing sokoni_products — not separable by id alone)
 */
'use strict';
const path = require('path');

function classify(canonical, indexIds) {
  /* canonical: Map id → { public: boolean }   indexIds: Set of ids */
  const c = { VISIBLE_CANONICAL_INDEXED: 0, HIDDEN_CANONICAL_NOT_INDEXED: 0, HIDDEN_CANONICAL_INDEXED: 0, MISSING: 0, STALE: 0, MATCHED: 0 };
  for (const [id, v] of canonical) {
    const inIdx = indexIds.has(id);
    if (v.public && inIdx) { c.VISIBLE_CANONICAL_INDEXED++; c.MATCHED++; }
    else if (v.public && !inIdx) c.MISSING++;
    else if (!v.public && inIdx) c.HIDDEN_CANONICAL_INDEXED++;
    else { c.HIDDEN_CANONICAL_NOT_INDEXED++; c.MATCHED++; }
  }
  for (const id of indexIds) if (!canonical.has(id)) c.STALE++;
  return c;
}
function report(label, counts) {
  console.log(`  ${label}`);
  for (const [k, v] of Object.entries(counts)) console.log(`    ${k.padEnd(30)} ${v}`);
}

async function readCanonical(admin, project) {
  const vis = require(path.join(__dirname, '..', 'functions', 'product-visibility.js'));
  const db = admin.firestore();
  const out = new Map(); let last = null;
  for (;;) {
    let q = db.collection('products').orderBy('__name__').select('isVisible', 'visible', 'status', 'moderationHold', 'deleted', 'isDeleted').limit(500);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const d of snap.docs) out.set(d.id, { public: vis.isPubliclyVisible(d.data() || {}) });
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < 500) break;
  }
  return out;
}
async function readAlgolia() {
  const app = process.env.ALGOLIA_APP_ID, key = process.env.ALGOLIA_BROWSE_KEY;
  if (!app || !key) return null;
  const ids = new Set(); let cursor = null;
  do {
    const r = await fetch(`https://${app}-dsn.algolia.net/1/indexes/sokoni_products/browse`, { method: 'POST',
      headers: { 'X-Algolia-Application-Id': app, 'X-Algolia-API-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(cursor ? { cursor } : { attributesToRetrieve: ['objectID'], hitsPerPage: 1000 }) });
    if (!r.ok) throw new Error('algolia browse HTTP ' + r.status);
    const b = await r.json();
    (b.hits || []).forEach((h) => ids.add(String(h.objectID)));
    cursor = b.cursor || null;
  } while (cursor);
  return ids;
}
async function readTypesense() {
  const url = process.env.TYPESENSE_URL, key = process.env.TYPESENSE_READ_KEY;
  if (!url || !key) return null;
  const r = await fetch(`${url.replace(/\/$/, '')}/collections/sokoni_products/documents/export?include_fields=id`, { headers: { 'X-TYPESENSE-API-KEY': key } });
  if (!r.ok) throw new Error('typesense export HTTP ' + r.status);
  const ids = new Set();
  (await r.text()).split('\n').forEach((l) => { if (l.trim()) { try { ids.add(String(JSON.parse(l).id)); } catch (_) {} } });
  return ids;
}

(async () => {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) {
    /* fixture: 6 products; 2 hidden (one held); engine A has a stale held record + an orphan; engine B is missing one */
    const Module = require('module'); const orig = Module.prototype.require;
    Module.prototype.require = function (id) { if (id === 'firebase-admin' || id.startsWith('firebase-admin/')) throw new Error('TRIPWIRE: firebase-admin in self-test'); return orig.apply(this, arguments); };
    const vis = require(path.join(__dirname, '..', 'functions', 'product-visibility.js'));
    const docs = { a: {}, b: { status: 'active' }, c: { isVisible: false }, d: { isVisible: false, moderationHold: { ref: 'x' } }, e: {}, f: { status: 'archived' } };
    const canon = new Map(Object.entries(docs).map(([k, v]) => [k, { public: vis.isPubliclyVisible(v) }]));
    const A = classify(canon, new Set(['a', 'b', 'd', 'e', 'zz']));
    const B = classify(canon, new Set(['a', 'b']));
    const ok = A.VISIBLE_CANONICAL_INDEXED === 3 && A.HIDDEN_CANONICAL_INDEXED === 1 && A.STALE === 1 && A.MISSING === 0 && A.MATCHED === 5
      && B.MISSING === 1 && B.HIDDEN_CANONICAL_INDEXED === 0 && B.MATCHED === 5;
    let tripped = false; try { require('firebase-admin'); } catch (e) { tripped = /TRIPWIRE/.test(e.message); }
    report('self-test engine A', A); report('self-test engine B', B);
    console.log(`  firebase-admin unloadable in self-test: ${tripped ? 'YES' : 'NO'}`);
    console.log(ok && tripped ? '\nSELF-TEST PASS' : '\nSELF-TEST FAIL');
    process.exit(ok && tripped ? 0 : 1);
  }
  if (!argv.includes('--read')) {
    console.log('PLAN (dry run — nothing read, nothing written):');
    console.log('  1. read products (ids + visibility fields only), paged 500, via application-default credentials');
    console.log('  2. browse Algolia sokoni_products ids (ALGOLIA_APP_ID + ALGOLIA_BROWSE_KEY)');
    console.log('  3. export Typesense sokoni_products ids (TYPESENSE_URL + TYPESENSE_READ_KEY)');
    console.log('  4. print per-engine counts: VISIBLE_CANONICAL_INDEXED, HIDDEN_CANONICAL_NOT_INDEXED, HIDDEN_CANONICAL_INDEXED, MISSING, STALE, MATCHED');
    console.log('  No ids, fields, keys or hosts are printed. There is no write mode.');
    console.log('  To run (OWNER ONLY, read-only): --read --project <id> --i-understand-this-reads-production');
    process.exit(0);
  }
  const pi = argv.indexOf('--project'); const project = pi >= 0 ? argv[pi + 1] : null;
  if (!project || !argv.includes('--i-understand-this-reads-production')) {
    console.error('REFUSED: --read needs --project <id> and --i-understand-this-reads-production'); process.exit(2);
  }
  const admin = require('firebase-admin');
  admin.initializeApp({ projectId: project });
  const canon = await readCanonical(admin, project);
  console.log(`canonical products: ${canon.size} (public ${[...canon.values()].filter((v) => v.public).length})`);
  const [alg, ts] = await Promise.all([readAlgolia(), readTypesense()]);
  if (alg) report('Algolia sokoni_products', classify(canon, alg)); else console.log('  Algolia: NOT READ (credentials absent) — unknown, not zero');
  if (ts) report('Typesense sokoni_products', classify(canon, ts)); else console.log('  Typesense: NOT READ (credentials absent) — unknown, not zero');
  process.exit(0);
})().catch((e) => { console.error('reconcile failed:', e && e.message); process.exit(1); });

module.exports = { classify };
