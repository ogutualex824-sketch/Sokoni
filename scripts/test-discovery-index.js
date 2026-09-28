/* test-discovery-index.js — ONE public-discovery gate for every search index (CHANGELOG 243, convergence C3a).
 * Transactional fake Firestore + the REAL functions/discovery-eligibility.js, algolia-queue.js, typesense-queue.js
 * (their enqueue — the choke point every trigger / reconciler / repair job / backfill goes through) and the REAL
 * search-service.searchQuery handler (onCall + secrets stubbed). No network.
 *
 * PROVES
 *   eligible     an approved, active, CLASSIFIED provider is indexed under the SERVER's category (C1): the free-text
 *                category / serviceType / subcategory / hub never reach a facet; the provider's words survive only as
 *                the non-facet displayCategory
 *   ineligible   unclassified (incl. legacy pre-C1), pending, suspended (status or flag), not-searchable, or missing
 *                → NOT indexed
 *   dependents   a provider's services and profile follow the OWNER's eligibility and category; a paused / removed
 *                service is not indexed
 *   de-indexed   the legacy registries (mechanics, lawyers, healthProviders, homeServiceProviders, services) never
 *                reach an index; a pending BnB listing never does; other collections pass unchanged
 *   choke point  algolia-queue.enqueue AND typesense-queue.enqueue turn an ineligible UPSERT into a DELETE (so no
 *                reconciler or backfill can re-add it) and index the eligible one with the C1 category (a partial
 *                update becomes a full upsert, so the facet is replaced)
 *   reindex      the Typesense admin reindex (which bypasses the queue) applies the same gate
 *   search       searchQuery refuses an unknown category on the services index; a server category is accepted; the
 *                client can no longer choose `status`
 *
 *   node scripts/test-discovery-index.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-discovery-index';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const fs = require('fs');
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.debug = () => {};
const resolveIn = (m) => require.resolve(m, { paths: [FN] });
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : resolveIn(m); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({}) });
stub('firebase-functions/v2/https', { onCall: (_o, h) => h, HttpsError: class extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } } });
stub('firebase-functions/params', { defineSecret: (n) => ({ name: n, value: () => 'test-key' }), defineString: (n) => ({ name: n, value: () => '' }) });

const D = require(Path.join(FN, 'discovery-eligibility.js'));
const AQ = require(Path.join(FN, 'algolia-queue.js'));
const TQ = require(Path.join(FN, 'typesense-queue.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 180) + ']' : '')); ok ? pass++ : fail++; };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const biz = (category, extra) => Object.assign({ status: 'active', name: 'Biz', business: { category, source: 'application', lane: { hub: 'provider', entClass: null } } }, extra || {});

(async () => {
  const P = (uid, doc) => db.doc('providers/' + uid).set(doc);
  await P('plumber', biz('trades', { category: 'hotel', serviceType: 'Luxury hotel', subcategory: 'Five star', hub: 'bnb' }));   /* free text LIES */
  await P('legacy1', { status: 'active', name: 'Old', category: 'Plumbing' });                         /* approved before C1: no stamp */
  await P('unc1', biz(null));
  await P('pend1', biz('trades', { status: 'pending' }));
  await P('susp1', biz('trades', { status: 'suspended' }));
  await P('suspFlag', biz('trades', { suspended: true }));
  await P('hidden', biz('trades', { searchable: false }));
  const prep = (col, id, data) => D.prepareForIndex(db, col, id, data);

  say('\n── providers: the server\'s category, only when eligible ──');
  const pd = await prep('providers', 'plumber', await get('providers/plumber'));
  ck('an eligible provider is indexed under the C1 category (trades), NOT its free-text "hotel"', pd && pd.category === 'trades' && pd.categories.join() === 'trades' && pd.categoryLabel && pd.hub === 'services', pd && { c: pd.category, hub: pd.hub });
  ck('…the editable serviceType / subcategory never reach a facet; the provider\'s words survive as displayCategory only', pd.serviceType === null && pd.subcategory === null && pd.displayCategory === 'hotel');
  for (const [uid, why] of [['legacy1', 'legacy (approved before C1, no stamp)'], ['unc1', 'unclassified'], ['pend1', 'pending'], ['susp1', 'suspended (status)'], ['suspFlag', 'suspended (flag)'], ['hidden', 'searchable:false']]) {
    ck(`${why} → NOT indexed`, (await prep('providers', uid, await get('providers/' + uid))) === null);
  }

  say('\n── dependents follow the OWNER ──');
  const svc = await prep('providerServices', 's1', { providerId: 'plumber', name: 'Burst pipe repair', category: 'Hotel stays', active: true });
  ck('a service of an eligible provider is indexed under the OWNER\'s C1 category', svc && svc.category === 'trades' && svc.displayCategory === 'Hotel stays');
  ck('a service of an ineligible (unclassified / legacy / pending) provider is NOT indexed',
    (await Promise.all(['unc1', 'legacy1', 'pend1'].map((u) => prep('providerServices', 's_' + u, { providerId: u, name: 'x', active: true })))).every((x) => x === null));
  ck('a paused or removed service is NOT indexed', (await prep('providerServices', 's2', { providerId: 'plumber', name: 'x', active: false })) === null && (await prep('providerServices', 's3', { providerId: 'plumber', name: 'x', removedAt: 1 })) === null);
  ck('a service with no owner is NOT indexed', (await prep('providerServices', 's4', { name: 'orphan', active: true })) === null);
  ck('a profile follows its owner (uid = doc id)', (await prep('providerProfiles', 'plumber', { status: 'active', category: 'x' })).category === 'trades' && (await prep('providerProfiles', 'unc1', { status: 'active' })) === null);

  say('\n── de-indexed and unchanged collections ──');
  ck('the legacy registries never reach an index', (await Promise.all(D.DEINDEXED.map((c) => prep(c, 'x', { name: 'x', status: 'active' })))).every((x) => x === null) && D.DEINDEXED.slice().sort().join() === 'healthProviders,homeServiceProviders,lawyers,mechanics,services');
  ck('a pending BnB listing is not indexed; an active one is', (await prep('bnbListings', 'b1', { status: 'pending' })) === null && (await prep('bnbListings', 'b2', { status: 'active', name: 'Stay' })).name === 'Stay');
  const prod = { name: 'Rice', category: 'food', status: 'active' };
  ck('other collections (products, sellers, businesses) pass UNCHANGED — shop discovery is out of this slice', (await prep('products', 'p1', prod)) === prod && (await prep('businesses', 'b', { name: 'Shop' })).name === 'Shop');

  say('\n── the choke point: both queues ──');
  await AQ.enqueue({ collection: 'providers', docId: 'unc1', operation: 'upsert', data: await get('providers/unc1') });
  const aqU = await get('algoliaQueue/providers_unc1');
  ck('Algolia: an ineligible UPSERT is turned into a DELETE (no data sent) — no reconciler can re-add it', aqU && aqU.operation === 'delete' && !aqU.data, aqU && aqU.operation);
  await AQ.enqueue({ collection: 'providers', docId: 'plumber', operation: 'partial', data: await get('providers/plumber'), beforeData: { name: 'old' } });
  const aqP = await get('algoliaQueue/providers_plumber');
  ck('Algolia: an eligible PARTIAL becomes a full UPSERT carrying the C1 category', aqP && aqP.operation === 'upsert' && aqP.data && aqP.data.category === 'trades' && !aqP.beforeData, aqP && { op: aqP.operation, c: aqP.data && aqP.data.category });
  await AQ.enqueue({ collection: 'mechanics', docId: 'm1', operation: 'upsert', data: { name: 'Garage', status: 'active' } });
  const aqM = await get('algoliaQueue/mechanics_m1');
  ck('Algolia: a legacy registry upsert becomes a delete', !aqM || aqM.operation === 'delete', aqM && aqM.operation);
  await TQ.enqueue({ collection: 'providers', docId: 'pend1', operation: 'upsert', data: await get('providers/pend1') });
  const tqU = (await db.collection('typesenseQueue').get()).docs.map((d) => d.data()).find((x) => (x.docId || '') === 'pend1' || /pend1/.test(JSON.stringify(x)));
  ck('Typesense: an ineligible UPSERT is turned into a DELETE', tqU && tqU.operation === 'delete' && !tqU.data, tqU && tqU.operation);
  await TQ.enqueue({ collection: 'providers', docId: 'plumber', operation: 'upsert', data: await get('providers/plumber') });
  const tqP = (await db.collection('typesenseQueue').get()).docs.map((d) => d.data()).find((x) => /plumber/.test(String(x.docId || '')));
  ck('Typesense: an eligible upsert carries the C1 category', tqP && tqP.operation === 'upsert' && tqP.data && tqP.data.category === 'trades', tqP && tqP.data && tqP.data.category);

  say('\n── the Typesense admin reindex bypasses the queue — same gate ──');
  const adm = fs.readFileSync(Path.join(FN, 'typesense-admin.js'), 'utf8');
  ck('typesense-admin reindex prepares every document through discovery-eligibility BEFORE transforming it', /const prepared = await require\('\.\/discovery-eligibility'\)\.prepareForIndex\(db, firestoreCollection, doc\.id, doc\.data\(\), provCache\);\s*\n\s*if \(!prepared\) continue;\s*\n\s*const transformed = transformer\(doc\.id, prepared\);/.test(adm));

  say('\n── searchQuery: the client asks, the server decides ──');
  const SS = require(Path.join(FN, 'search-service.js'));
  const q = async (data) => { try { await SS.searchQuery({ auth: { uid: 'buyer1', token: {} }, data, rawRequest: { headers: {} } }); return null; } catch (e) { return (e.details && e.details.code) || e.code || e.message; } };
  ck('an unknown category on the services index is REFUSED (never silently widened)', await q({ index: 'services', query: 'plumber', filters: { category: 'Luxury hotel' } }) === 'UNKNOWN_CATEGORY');
  const okc = await q({ index: 'services', query: 'plumber', filters: { category: 'trades' } });
  ck('a server category (trades) is accepted (whatever else happens next, it is not refused as unknown)', okc !== 'UNKNOWN_CATEGORY', okc);
  const ssrc = fs.readFileSync(Path.join(FN, 'search-service.js'), 'utf8');
  ck('the client can no longer choose `status` in the Algolia filter builder', !/filters\.status/.test(ssrc));

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
