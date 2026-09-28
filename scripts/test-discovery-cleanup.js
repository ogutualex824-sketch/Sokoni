/* test-discovery-cleanup.js — the existing-index discovery cleanup (CHANGELOG 246, convergence C3b-2).
 * Transactional fake Firestore + the REAL functions/discovery-cleanup.js, discovery-eligibility.js (the C3a-1 gate),
 * algolia-queue.enqueue (the gated queue) and the engines' REAL collection→index maps (algolia-indexer
 * COLLECTION_INDEX_MAP, typesense-client COLLECTION_MAP). No network.
 *
 * !! EVIDENCE BOUNDARY: every "index" below is an IN-MEMORY FIXTURE — a list of ids this suite invented. No Algolia or
 * !! Typesense instance was contacted. These results prove the cleanup's DECISIONS and GUARANTEES; they prove NOTHING
 * !! about what production indexes contain. The engine reader adapters are exercised against FAKE clients only.
 *
 * PROVES
 *   shop          a shop / merchant record (sokoni_shops) is OUT OF SCOPE → RETAINED, with no Firestore read
 *   stale         a provider that was indexed and now fails the C3a-1 gate → REMOVED (through the gated queue)
 *   orphan        a record with no source, in an index written ONLY by in-scope collections → REMOVED
 *   eligible      a record with an eligible in-scope source → RETAINED — including when a sibling source with the
 *                 SAME raw id is stale (providers/{id} suspended, providerServices/{id} eligible)
 *   shared        an id that also exists in an out-of-scope collection of a mixed index → RETAINED
 *   uncertain     no source in a MIXED index, or an id that cannot be a doc id → RETAINED
 *   global        a {collection}_{docId} copy follows its PRIMARY verdict: stale primary → removed; eligible primary
 *                 → retained (a queued delete would also remove the eligible sibling); out-of-scope / unparseable → kept
 *   dry run       the default; zero Firestore writes and zero enqueue calls, and it reports wouldRemove
 *   live          removal ONLY via the existing gated queue as `delete` entries; no provider / source data changes;
 *                 no direct engine delete exists in the module
 *   errors        a read or enqueue failure → failed AND retained; the run continues
 *   bounded       pages per run and removals per run stop the walk and hand back a cursor
 *   resumable     resuming from the cursor reaches the same totals as one full walk
 *   idempotent    a second live run over the cleaned index removes nothing; queue entries are keyed
 *   engines       Typesense: its own map (sokoni_services = providers+services, sokoni_hotels mixed, sokoni_shops out)
 *   CLI           dry-run default; --project required; --apply refused without authorization and on production
 *
 *   node scripts/test-discovery-cleanup.js
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-discovery-cleanup';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.K_SERVICE; delete process.env.FUNCTION_TARGET;
const fs = require('fs');
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() });
const realDb = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('firebase-admin/firestore', { getFirestore: () => realDb, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => realDb, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({}) });
stub('firebase-functions/v2/https', { onCall: (_o, h) => h, HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } });
stub('firebase-functions/params', { defineSecret: (n) => ({ name: n, value: () => 'test-key' }), defineString: (n) => ({ name: n, value: () => '' }) });

const DC = require(Path.join(FN, 'discovery-cleanup.js'));
const AMAP = require(Path.join(FN, 'algolia-indexer.js')).COLLECTION_INDEX_MAP;
const TMAP = require(Path.join(FN, 'typesense-client.js')).COLLECTION_MAP;
const AQ = require(Path.join(FN, 'algolia-queue.js'));
const CLI = require(Path.join(ROOT, 'scripts', 'discovery-cleanup.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 220) + ']' : '')); ok ? pass++ : fail++; };

/* A db spy: counts reads per collection and every write, and can be told to fail a read. Queue writes are counted too. */
function spyDb(opts) {
  const o = Object.assign({ failRead: null }, opts || {});
  const st = { reads: {}, writes: [] };
  const wrapDoc = (ref, col) => ({
    id: ref.id, path: ref.path, _path: ref._path,
    get: async () => { st.reads[col] = (st.reads[col] || 0) + 1; if (o.failRead && o.failRead(col, ref.id)) throw new Error('read failed'); return ref.get(); },
    set: async (d, x) => { st.writes.push(ref.path); return ref.set(d, x); },
    update: async (d) => { st.writes.push(ref.path); return ref.update(d); },
    create: async (d) => { st.writes.push(ref.path); return ref.create(d); },
    delete: async () => { st.writes.push(ref.path); return ref.delete(); },
    collection: (c) => wrapCol(ref.collection(c), c),
  });
  const wrapCol = (cref, col) => Object.assign(Object.create(cref), { doc: (id) => wrapDoc(cref.doc(id), col), where: (...a) => cref.where(...a) });
  return { db: { collection: (c) => wrapCol(realDb.collection(c), c), doc: (p) => wrapDoc(realDb.doc(p), p.split('/')[0]) }, st };
}
/* A FIXTURE index (NOT a live engine): a fixed list of ids, cursor = offset. */
/* Every call goes through rec(): a THROW becomes a failed check (THREW + an empty report), never a suite crash —
   a crash is not a verdict. The one check that EXPECTS a rejection calls DC.reconcileIndex directly. */
const rec = (o) => DC.reconcileIndex(o).catch((e) => ({ THREW: String((e && e.message) || e), byVerdict: {}, examined: 0, eligible: 0, removed: 0, wouldRemove: 0, retained: 0, failed: 0, failures: [], pages: 0, done: false, nextCursor: null }));
const fixtureIndex = (ids) => async (cursor, size) => { const f = Number(cursor) || 0; return { ids: ids.slice(f, f + size), next: f + size < ids.length ? f + size : null }; };
const A_WRITERS = (index) => DC.writersOf(AMAP, index, 'index');
const T_WRITERS = (index) => DC.writersOf(TMAP, index, 'collection');
/* derived by the MODULE (the CLI uses the same function): globalSearch primaries ∪ gs__ keys */
const GLOBAL_WRITERS = DC.globalWritersOf(AMAP);
const primaryWritersOf = (col) => A_WRITERS(AMAP[col] && AMAP[col].index);
const biz = (category, extra) => Object.assign({ status: 'active', name: 'Biz', business: { category, source: 'application', lane: { hub: 'provider', entClass: null } } }, extra || {});
const snapshotSources = async () => {
  const out = {};
  for (const c of ['providers', 'providerProfiles', 'providerServices', 'services', 'bnbListings', 'properties', 'businesses', 'sellers']) {
    out[c] = JSON.stringify((await realDb.collection(c).get()).docs.map((d) => [d.id, d.data()]));
  }
  return out;
};

(async () => {
  /* ── Firestore sources ── */
  const S = (p, d) => realDb.doc(p).set(d);
  await S('providers/elig', biz('trades', { name: 'Eligible' }));
  await S('providerProfiles/elig', { uid: 'elig', status: 'active' });                              /* SAME raw id */
  await S('providers/susp', biz('trades', { name: 'Suspended', status: 'suspended' }));
  await S('providerServices/svcS', { providerId: 'susp', name: 'Stale service', active: true });
  await S('providerServices/svcE', { providerId: 'elig', name: 'Live service', active: true });
  await S('services/legacy1', { name: 'Legacy registry', status: 'active' });                      /* DE-INDEXED */
  await S('providers/mix', biz('trades', { status: 'suspended' }));                                 /* stale … */
  await S('providerServices/mix', { providerId: 'elig', name: 'Same id, eligible', active: true });  /* … eligible sibling */
  await S('bnbListings/b1', { status: 'pending', name: 'Pending stay' });
  await S('properties/b1', { name: 'A property with the same id' });                                /* out of scope */
  await S('bnbListings/b2', { status: 'pending', name: 'Pending stay only' });
  await S('bnbListings/b3', { status: 'active', name: 'Approved stay' });
  await S('businesses/shop1', { name: 'Mama Pima Shop', status: 'suspended' });

  const W = A_WRITERS('sokoni_services');
  ck('the REAL Algolia map: sokoni_services is written by 7 collections, all in C3 scope; sokoni_shops by none in scope',
    W.slice().sort().join() === 'healthProviders,lawyers,mechanics,providerProfiles,providerServices,providers,services'
    && A_WRITERS('sokoni_shops').every((c) => !DC.SCOPE.includes(c)) && A_WRITERS('sokoni_properties').includes('bnbListings'), { services: W, shops: A_WRITERS('sokoni_shops') });

  say('\n── the two required cases ──');
  { const { db, st } = spyDb();
    const r = await rec({ db, engine: 'algolia', index: 'sokoni_shops', writers: A_WRITERS('sokoni_shops'), readPage: fixtureIndex(['shop1', 'ghostshop']) });
    ck('SHOP entry → the cleanup recognises it is outside provider discovery → RETAINED (both), with ZERO Firestore reads',
      r.retained === 2 && r.wouldRemove === 0 && r.byVerdict.OUT_OF_SCOPE === 2 && Object.keys(st.reads).length === 0, { r: r.byVerdict, reads: st.reads }); }
  { const { db } = spyDb();
    const r = await rec({ db, engine: 'algolia', index: 'sokoni_services', writers: W, readPage: fixtureIndex(['susp']) });
    ck('STALE provider (was indexed, now fails C3a-1) → removed', r.wouldRemove === 1 && r.byVerdict.STALE === 1, r.byVerdict); }

  say('\n── every verdict, primary index (dry run) ──');
  const IDS = ['elig', 'susp', 'svcS', 'svcE', 'legacy1', 'mix', 'ghost', 'a/b'];
  const { db: d1, st: s1 } = spyDb();
  const enqCalls = [];
  const dry = await rec({ db: d1, engine: 'algolia', index: 'sokoni_services', writers: W, readPage: fixtureIndex(IDS),
    enqueueDelete: async (x) => { enqCalls.push(x); } });
  ck('dry run is the DEFAULT (no dryRun passed)', dry.dryRun === true);
  ck('verdicts: elig, svcE, mix ELIGIBLE · susp, svcS, legacy1 STALE · ghost ORPHAN · a/b UNATTRIBUTABLE',
    dry.byVerdict.ELIGIBLE === 3 && dry.byVerdict.STALE === 3 && dry.byVerdict.ORPHAN === 1 && dry.byVerdict.UNATTRIBUTABLE === 1, dry.byVerdict);
  ck('the report: examined 8 · eligible 3 · would remove 4 · retained 4 · removed 0 · failed 0',
    dry.examined === 8 && dry.eligible === 3 && dry.wouldRemove === 4 && dry.retained === 4 && dry.removed === 0 && dry.failed === 0 && dry.done, dry);
  ck('the shared raw id `mix` (providers/mix suspended, providerServices/mix eligible) is RETAINED — ownership is never inferred from an id',
    (await DC.classifyPrimary(d1, 'mix', W)).verdict === 'ELIGIBLE');
  ck('DRY RUN: zero Firestore writes and zero enqueue calls', s1.writes.length === 0 && enqCalls.length === 0, { writes: s1.writes, enq: enqCalls.length });

  say('\n── mixed index: never delete what may not be ours ──');
  { const { db } = spyDb();
    const P = A_WRITERS('sokoni_properties');
    const r = await rec({ db, engine: 'algolia', index: 'sokoni_properties', writers: P, readPage: fixtureIndex(['b1', 'b2', 'b3', 'ghostp']) });
    ck('b1 (pending stay, BUT properties/b1 exists) → SHARED_OUT_OF_SCOPE retained · b2 (pending stay only) → STALE · b3 (approved) → ELIGIBLE · ghostp (no source, mixed index) → UNATTRIBUTABLE retained',
      r.byVerdict.SHARED_OUT_OF_SCOPE === 1 && r.byVerdict.STALE === 1 && r.byVerdict.ELIGIBLE === 1 && r.byVerdict.UNATTRIBUTABLE === 1 && r.wouldRemove === 1, r.byVerdict); }

  say('\n── global copies follow their PRIMARY ──');
  { const { db } = spyDb();
    const G = ['providers_susp', 'providers_elig', 'providerServices_mix', 'services_mix', 'products_p1', 'sellers_shop1', 'noprefixid'];
    const r = await rec({ db, engine: 'algolia', index: 'sokoni_global', global: true, writers: GLOBAL_WRITERS, primaryWritersOf, readPage: fixtureIndex(G) });
    const v = {}; for (const id of G) v[id] = (await DC.classifyGlobal(db, id, GLOBAL_WRITERS, primaryWritersOf)).verdict;
    ck('providers_susp → STALE (primary stale) · providers_elig → ELIGIBLE · services_mix → ELIGIBLE (primary `mix` has an eligible source: deleting it would take the sibling) · products_ / sellers_ → OUT_OF_SCOPE · unprefixed → UNATTRIBUTABLE',
      v.providers_susp === 'STALE' && v.providers_elig === 'ELIGIBLE' && v.services_mix === 'ELIGIBLE' && v.providerServices_mix === 'ELIGIBLE'
      && v.products_p1 === 'OUT_OF_SCOPE' && v.sellers_shop1 === 'OUT_OF_SCOPE' && v.noprefixid === 'UNATTRIBUTABLE' && r.wouldRemove === 1, v); }

  say('\n── live: only the existing gated queue ──');
  const before = await snapshotSources();
  const { db: d2, st: s2 } = spyDb();
  const live = await rec({ db: d2, engine: 'algolia', index: 'sokoni_services', writers: W, readPage: fixtureIndex(IDS), dryRun: false,
    enqueueDelete: ({ collection, docId }) => AQ.enqueue({ collection, docId, operation: 'delete' }) });
  const qd = (await realDb.collection('algoliaQueue').get()).docs.map((d) => d.data());
  const primary = qd.filter((x) => !String(x.collection).startsWith('gs__'));
  /* The property is "a DELETE of that objectID in that index": every in-scope writer of sokoni_services maps to the same
     index, so which writer carries an ORPHAN's delete is incidental — assert the objectID + index, not the choice. */
  ck('4 removed, each as a DELETE of that objectID in sokoni_services via the existing algoliaQueue (and its global shadow) — nothing else queued',
    live.removed === 4 && live.wouldRemove === 0 && primary.map((x) => x.docId).sort().join() === 'ghost,legacy1,susp,svcS'
    && primary.every((x) => x.operation === 'delete' && x.indexName === 'sokoni_services' && W.includes(x.collection))
    && primary.find((x) => x.docId === 'susp').collection === 'providers' && primary.find((x) => x.docId === 'svcS').collection === 'providerServices'
    && qd.every((x) => x.operation === 'delete'), primary.map((x) => x.collection + '/' + x.docId + ':' + x.operation));
  ck('…the global writer set includes the shadows the MAP omits (providerServices / providerProfiles) — derived by the module',
    GLOBAL_WRITERS.includes('providerServices') && GLOBAL_WRITERS.includes('providerProfiles') && GLOBAL_WRITERS.includes('providers'), GLOBAL_WRITERS.length);
  ck('the cleanup itself wrote NOTHING but queue entries (it never touches provider or source data)', s2.writes.length === 0 && JSON.stringify(await snapshotSources()) === JSON.stringify(before), s2.writes);
  const src = fs.readFileSync(Path.join(FN, 'discovery-cleanup.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ck('the module contains NO direct engine delete and no Firestore write (deleteObject / deleteDocument / deleteByFilter / clearIndex / .set / .update / .delete)',
    !/deleteObjects?\(|deleteDocument\(|deleteByFilter\(|clearIndex\(|\.set\(|\.update\(|\.delete\(|batch\(|runTransaction/.test(src));
  ck('applying without a queue is refused (never a silent fallback)', await DC.reconcileIndex({ db: d2, writers: W, readPage: fixtureIndex(IDS), dryRun: false }).then(() => false, (e) => /enqueueDelete is required/.test(e.message)));

  say('\n── errors fail closed ──');
  { const { db } = spyDb({ failRead: (col, id) => id === 'susp' && col === 'providers' });
    const r = await rec({ db, engine: 'algolia', index: 'sokoni_services', writers: W, readPage: fixtureIndex(['susp', 'ghost']), dryRun: false,
      enqueueDelete: async () => {} });
    ck('a Firestore read error → failed AND retained (not removed); the run continues to the next record',
      r.failed === 1 && r.retained === 1 && r.removed === 1 && r.failures[0].id === 'susp' && r.failures[0].stage === 'classify', r); }
  { const { db } = spyDb();
    const r = await rec({ db, engine: 'algolia', index: 'sokoni_services', writers: W, readPage: fixtureIndex(['susp', 'ghost']), dryRun: false,
      enqueueDelete: async ({ docId }) => { if (docId === 'susp') throw new Error('queue down'); } });
    ck('an enqueue error → failed AND retained; the other removal still happens', r.failed === 1 && r.retained === 1 && r.removed === 1 && r.failures[0].stage === 'enqueue', r); }

  say('\n── bounded · resumable · idempotent ──');
  const MANY = []; for (let i = 0; i < 12; i++) MANY.push('ghost' + i);          /* 12 orphans */
  const MIXED = ['elig', ...MANY.slice(0, 6), 'svcE', ...MANY.slice(6)];
  const { db: d3 } = spyDb();
  const r1 = await rec({ db: d3, writers: W, readPage: fixtureIndex(MIXED), pageSize: 3, maxRemovals: 5 });
  ck('the removal cap stops the walk and hands back a cursor', !r1.done && r1.nextCursor != null && r1.wouldRemove >= 5 && r1.wouldRemove <= 5 + 3, r1);
  const r1b = await rec({ db: d3, writers: W, readPage: fixtureIndex(MIXED), pageSize: 3, maxPages: 2 });
  ck('the page cap stops the walk and hands back a cursor', !r1b.done && r1b.pages === 2 && r1b.nextCursor === 6, r1b);
  let cur = null, tot = { examined: 0, wouldRemove: 0, retained: 0 }, runs = 0;
  do { const r = await rec({ db: d3, writers: W, readPage: fixtureIndex(MIXED), pageSize: 3, maxPages: 1, cursor: cur }); runs++;
    tot.examined += r.examined; tot.wouldRemove += r.wouldRemove; tot.retained += r.retained; cur = r.nextCursor; if (r.done) break; } while (runs < 20);
  const full = await rec({ db: d3, writers: W, readPage: fixtureIndex(MIXED), pageSize: 100 });
  ck('resuming page by page reaches EXACTLY the totals of one full walk', runs > 1 && tot.examined === full.examined && tot.wouldRemove === full.wouldRemove && tot.retained === full.retained, { resumed: tot, full: { e: full.examined, w: full.wouldRemove, r: full.retained }, runs });
  const cleaned = IDS.filter((id) => !['susp', 'svcS', 'legacy1', 'ghost'].includes(id));   /* the index after the queue processed run 1 */
  const again = await rec({ db: d3, writers: W, readPage: fixtureIndex(cleaned), dryRun: false, enqueueDelete: ({ collection, docId }) => AQ.enqueue({ collection, docId, operation: 'delete' }) });
  ck('idempotent: a second live run over the cleaned index removes NOTHING', again.removed === 0 && again.failed === 0, again.byVerdict);
  const n1 = (await realDb.collection('algoliaQueue').get()).size;
  await rec({ db: d3, writers: W, readPage: fixtureIndex(IDS), dryRun: false, enqueueDelete: ({ collection, docId }) => AQ.enqueue({ collection, docId, operation: 'delete' }) });
  ck('…and re-running the same removals adds no queue entries (keyed collection_docId)', (await realDb.collection('algoliaQueue').get()).size === n1, n1);

  say('\n── Typesense: its own map ──');
  { const TS = T_WRITERS('sokoni_services');
    const { db } = spyDb();
    const r = await rec({ db, engine: 'typesense', index: 'sokoni_services', writers: TS, readPage: fixtureIndex(['elig', 'susp', 'legacy1', 'ghost']) });
    ck('sokoni_services = providers + services: elig retained · susp / legacy1 stale · ghost orphan', TS.slice().sort().join() === 'providers,services' && r.wouldRemove === 3 && r.eligible === 1, { TS, v: r.byVerdict });
    const H = await rec({ db, engine: 'typesense', index: 'sokoni_hotels', writers: T_WRITERS('sokoni_hotels'), readPage: fixtureIndex(['b2', 'ghosth']) });
    ck('sokoni_hotels is MIXED (bnbListings + hotels): b2 stale → removed · ghosth (no source) → retained', H.byVerdict.STALE === 1 && H.byVerdict.UNATTRIBUTABLE === 1, H.byVerdict);
    const Sh = await rec({ db, engine: 'typesense', index: 'sokoni_shops', writers: T_WRITERS('sokoni_shops'), readPage: fixtureIndex(['shop1']) });
    ck('sokoni_shops → OUT_OF_SCOPE, retained', Sh.byVerdict.OUT_OF_SCOPE === 1 && Sh.wouldRemove === 0); }

  say('\n── reader adapters (FAKE clients — no live engine contacted) ──');
  { const calls = [];
    const fake = { _request: async (m, p, b) => { calls.push([m, p, JSON.stringify(b)]); return calls.length === 1 ? { hits: [{ objectID: 'a' }, { objectID: 'b' }], cursor: 'C2' } : { hits: [{ objectID: 'c' }] }; } };
    const read = DC.algoliaReader(fake, 'sokoni_services');
    const p1 = await read(null, 500); const p2 = await read(p1.next, 500);
    ck('algoliaReader: a READ (browse) request only, objectIDs only, cursor-paged', p1.ids.join() === 'a,b' && p1.next === 'C2' && p2.ids.join() === 'c' && p2.next === null
      && calls.every(([m, p]) => m === 'POST' && /\/browse$/.test(p)) && /attributesToRetrieve/.test(calls[0][2]) && /"cursor":"C2"/.test(calls[1][2]), calls); }
  { let exports = 0;
    const fake = { exportDocuments: async (c, o) => { exports++; return o && o.include_fields === 'id' ? '{"id":"x1"}\n{"id":"x2"}\n{"id":"x3"}\n' : ''; } };
    const read = DC.typesenseReader(fake, 'sokoni_services');
    const a = await read(null, 2); const b = await read(a.next, 2);
    ck('typesenseReader: ids only (include_fields=id), exported once, offset-paged', a.ids.join() === 'x1,x2' && a.next === 2 && b.ids.join() === 'x3' && b.next === null && exports === 1); }

  say('\n── CLI: dry run by default ──');
  const P = (argv, env) => CLI.parseArgs(argv, env || {});
  const base = ['--project=demo-x', '--engine=algolia', '--index=sokoni_services'];
  ck('no flags → a DRY RUN', P(base).dryRun === true && P(base).errors.length === 0);
  ck('--project is required (there is no default project)', P(['--engine=algolia', '--index=x']).errors.some((e) => /--project/.test(e)));
  ck('--apply WITHOUT authorization is refused', P(base.concat('--apply')).errors.some((e) => /SOKONI_C3B2_APPLY_AUTHORIZED/.test(e)));
  ck('--apply with authorization for a DIFFERENT project is refused', P(base.concat('--apply'), { SOKONI_C3B2_APPLY_AUTHORIZED: 'other' }).errors.length === 1);
  ck('--apply on PRODUCTION is refused even when "authorized"', P(['--project=sokoni-aeb26', '--engine=algolia', '--index=sokoni_services', '--apply'], { SOKONI_C3B2_APPLY_AUTHORIZED: 'sokoni-aeb26' }).errors.some((e) => /REFUSED on production/.test(e)));
  ck('--apply authorized for the same non-production project → allowed (the positive control)', P(base.concat('--apply'), { SOKONI_C3B2_APPLY_AUTHORIZED: 'demo-x' }).errors.length === 0 && P(base.concat('--apply'), { SOKONI_C3B2_APPLY_AUTHORIZED: 'demo-x' }).dryRun === false);
  ck('bounds are validated (a runaway --max-removals is refused)', P(base.concat('--max-removals=999999')).errors.some((e) => /max-removals/.test(e)));
  ck('the CLI refuses before touching anything (exit 2) on an invalid invocation', (await CLI.main(['--engine=algolia'], {})) === 2);

  say(`\n${pass} passed, ${fail} failed`);
  say('EVIDENCE BOUNDARY: fixture indexes and fake engine clients only — no live Algolia / Typesense content was inspected.');
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
