'use strict';
/**
 * SOKONI — existing-index discovery cleanup  (CHANGELOG 246, convergence C3b-2)
 * ============================================================================================
 * A RECONCILIATION tool, not a discovery authority. It walks records ALREADY in a search index and asks the SAME
 * C3a-1 gate (discovery-eligibility.prepareForIndex) whether each may stay:
 *
 *     index record → resolve its Firestore source(s) → C3a-1 gate → eligible: RETAIN · refused: REMOVE
 *
 * WHY RESOLUTION, NOT A TAG: an index record does not say which collection wrote it. Algolia `sokoni_services` is written
 * by providers, providerProfiles, providerServices, services, mechanics, healthProviders and lawyers, each keyed by
 * its raw doc id (providers/{uid} and providerProfiles/{uid} even share one objectID); Typesense uses raw ids too;
 * `sokoni_properties` mixes bnbListings with out-of-scope property collections. So a record is resolved against EVERY
 * collection that can write its index — ownership is NEVER inferred from an id alone — and removed ONLY when
 * attribution is certain:
 *
 *   OUT_OF_SCOPE         no collection writing this index is C3 provider discovery (shops, products, …) → RETAIN,
 *                        with no Firestore read. Shop / merchant discovery is never touched.
 *   SHARED_OUT_OF_SCOPE  a doc with this id exists in an out-of-scope collection of the index → RETAIN
 *   ELIGIBLE             an in-scope source passes the gate → RETAIN
 *   STALE                in-scope source(s) exist and the gate refuses every one → REMOVE
 *   ORPHAN               no source exists anywhere AND every collection writing the index is in scope → REMOVE
 *   UNATTRIBUTABLE       no source exists anywhere in a MIXED index, or the id cannot be a doc id → RETAIN
 *   PRIMARY_RETAINED     (global copies only) the primary record would be retained → RETAIN — a queued delete also
 *                        removes the primary record, so a global copy is SUBORDINATE to its primary's verdict
 *
 * GUARANTEES
 *   dry run (the default)  zero engine deletes and zero Firestore writes — it only reads
 *   live                   removal ONLY through the engine's EXISTING gated queue, as `delete` entries — never a direct
 *                          Algolia / Typesense call, never Firestore / provider data, never an approval or a publish
 *   error                  → failed AND retained (fail closed, per record; the run continues)
 *   bounded                page size · pages per run · removals per run (defaults far under the queue's 10,000/run)
 *   resumable              the report's `nextCursor` resumes the walk
 *   idempotent             a removed record no longer appears; queue entries are keyed collection_docId
 * NOT deployed: this module is not exported as a Cloud Function, and nothing schedules it.
 */
const DE = require('./discovery-eligibility');

/** The collections whose public discoverability C3 governs — exactly those the C3a-1 gate can refuse. */
/* 2026-09-28 (owner decision: shops are discoverable only through the ONE server gate): the gate now also governs the
   shop rows (DE.SHOP_SCOPED — sellers / businesses) and de-indexes the shop registries with no authority (stores,
   vendors, companies, restaurants), so `sokoni_shops` is in scope and its records are reconciled like any other —
   an approved, classified shop is RETAINED, a suspended / unclassified / unauthorised one REMOVED. The "shop / merchant
   discovery is never touched" rule below applied before shops had a gate; it is superseded. */
const SCOPE = Object.freeze([...DE.PROVIDER_SCOPED, ...(DE.SHOP_SCOPED || []), ...DE.DEINDEXED, 'bnbListings']);
const inScope = (c) => SCOPE.includes(c);
const ID_RE = /^[^/]{1,1500}$/;

const DEFAULTS = Object.freeze({ dryRun: true, pageSize: 500, maxPages: 10, maxRemovals: 1000 });

/** The Firestore collections that write `index`, from an engine's own map ({ col: { [indexKey]: name } }). */
function writersOf(engineMap, index, indexKey) {
  return Object.keys(engineMap).filter((c) => engineMap[c] && engineMap[c][indexKey] === index);
}

/**
 * The SOURCE collections whose global copies (`{collection}_{docId}`) can exist: every primary collection flagged
 * `globalSearch` (algolia-queue writes a shadow for each) UNION every `gs__` key. The map alone is not enough — it has
 * no gs__providerServices / gs__providerProfiles, yet the queue writes shadows for both — and it names the global index
 * `sokoni_global` while the queue writes `global_search`; so this is independent of the index name (the operator names
 * the index explicitly).
 */
function globalWritersOf(engineMap) {
  const s = new Set();
  for (const [c, m] of Object.entries(engineMap)) {
    if (c.startsWith('gs__')) s.add(c.slice(4));
    else if (m && m.globalSearch) s.add(c);
  }
  return [...s];
}

async function _source(db, col, id) {
  const s = await db.collection(col).doc(id).get();
  return s.exists ? s.data() : null;
}

/**
 * Classify ONE primary-index record id against the collections that write its index.
 * @returns {Promise<{verdict:string, collection:string|null}>}
 */
async function classifyPrimary(db, id, writers, cache) {
  const scoped = writers.filter(inScope);
  if (!scoped.length) return { verdict: 'OUT_OF_SCOPE', collection: null };
  if (!ID_RE.test(String(id))) return { verdict: 'UNATTRIBUTABLE', collection: null };
  for (const c of writers.filter((w) => !inScope(w))) {
    if (await _source(db, c, String(id))) return { verdict: 'SHARED_OUT_OF_SCOPE', collection: c };
  }
  let stale = null;
  for (const c of scoped) {
    const data = await _source(db, c, String(id));
    if (!data) continue;
    if (await DE.prepareForIndex(db, c, String(id), data, cache)) return { verdict: 'ELIGIBLE', collection: c };
    stale = stale || c;
  }
  if (stale) return { verdict: 'STALE', collection: stale };
  return scoped.length === writers.length ? { verdict: 'ORPHAN', collection: scoped[0] } : { verdict: 'UNATTRIBUTABLE', collection: null };
}

/**
 * Classify ONE global-index record (`{collection}_{docId}`). `globalWriters` are the SOURCE collections (gs__ stripped);
 * `primaryWritersOf(col)` gives the collections writing that source's PRIMARY index. The global verdict is SUBORDINATE
 * to the primary verdict: removed only when the primary record would be removed too.
 */
async function classifyGlobal(db, objectID, globalWriters, primaryWritersOf, cache) {
  const col = globalWriters.slice().sort((a, b) => b.length - a.length).find((c) => String(objectID).startsWith(c + '_'));
  if (!col) return { verdict: 'UNATTRIBUTABLE', collection: null, docId: null };
  const docId = String(objectID).slice(col.length + 1);
  if (!inScope(col)) return { verdict: 'OUT_OF_SCOPE', collection: col, docId };
  const primary = await classifyPrimary(db, docId, primaryWritersOf(col), cache);
  if (primary.verdict === 'STALE' || primary.verdict === 'ORPHAN') return { verdict: primary.verdict, collection: col, docId };
  return { verdict: primary.verdict === 'ELIGIBLE' ? 'ELIGIBLE' : 'PRIMARY_RETAINED', collection: col, docId };
}

const REMOVE = Object.freeze(['STALE', 'ORPHAN']);

/**
 * Reconcile one index, bounded and resumable.
 *
 * @param {object} o
 * @param {FirebaseFirestore.Firestore} o.db
 * @param {string}   o.engine        'algolia' | 'typesense' (reporting only)
 * @param {string}   o.index         the index / collection name
 * @param {string[]} o.writers       Firestore collections writing this index (primary) — or, with o.global, the source
 *                                   collections of the global copies
 * @param {boolean} [o.global]       records are `{collection}_{docId}` global copies
 * @param {Function} [o.primaryWritersOf]  (global only) col → collections writing that col's primary index
 * @param {Function} o.readPage      async (cursor, pageSize) → { ids: string[], next: cursor|null }
 * @param {Function} [o.enqueueDelete] async ({ collection, docId }) → void — the engine's EXISTING gated queue.
 *                                   Required only when dryRun is false; NEVER called in a dry run.
 * @param {boolean} [o.dryRun=true]
 * @param {*}       [o.cursor]       resume point from a previous report's nextCursor
 * @returns {Promise<object>} report
 */
async function reconcileIndex(o) {
  const opt = Object.assign({}, DEFAULTS, o);
  const dryRun = opt.dryRun !== false;                          /* only an explicit `false` applies */
  if (typeof opt.readPage !== 'function') throw new Error('readPage is required');
  if (!dryRun && typeof opt.enqueueDelete !== 'function') throw new Error('enqueueDelete is required to apply');
  if (opt.global && typeof opt.primaryWritersOf !== 'function') throw new Error('primaryWritersOf is required for global copies');
  const report = {
    engine: opt.engine || null, index: opt.index || null, dryRun, global: !!opt.global,
    examined: 0, eligible: 0, removed: 0, wouldRemove: 0, retained: 0, failed: 0,
    byVerdict: {}, failures: [], pages: 0, startCursor: opt.cursor == null ? null : opt.cursor, nextCursor: null, done: false,
  };
  const cache = {};
  let cursor = opt.cursor == null ? null : opt.cursor;
  const removalsLeft = () => opt.maxRemovals - (report.removed + report.wouldRemove);

  for (let p = 0; p < opt.maxPages; p++) {
    if (removalsLeft() <= 0) { report.nextCursor = cursor; return report; }   /* cap reached → resume from here */
    const page = await opt.readPage(cursor, opt.pageSize);
    report.pages++;
    const ids = (page && Array.isArray(page.ids)) ? page.ids : [];
    for (const id of ids) {
      report.examined++;
      let v;
      try {
        v = opt.global
          ? await classifyGlobal(opt.db, id, opt.writers, opt.primaryWritersOf, cache)
          : await classifyPrimary(opt.db, id, opt.writers, cache);
      } catch (e) {
        report.failed++; report.retained++;
        if (report.failures.length < 50) report.failures.push({ id: String(id), stage: 'classify', error: String((e && e.message) || e).slice(0, 200) });
        continue;
      }
      report.byVerdict[v.verdict] = (report.byVerdict[v.verdict] || 0) + 1;
      if (v.verdict === 'ELIGIBLE') report.eligible++;
      if (!REMOVE.includes(v.verdict)) { report.retained++; continue; }
      if (dryRun) { report.wouldRemove++; continue; }
      try {
        await opt.enqueueDelete({ collection: v.collection, docId: opt.global ? v.docId : String(id) });
        report.removed++;
      } catch (e) {
        report.failed++; report.retained++;
        if (report.failures.length < 50) report.failures.push({ id: String(id), stage: 'enqueue', error: String((e && e.message) || e).slice(0, 200) });
      }
    }
    cursor = page && page.next != null ? page.next : null;
    if (cursor == null) { report.done = true; report.nextCursor = null; return report; }
    if (removalsLeft() <= 0) { report.nextCursor = cursor; return report; }
  }
  report.nextCursor = cursor;
  return report;
}

/* ── Engine readers — thin, and NOT verified against a live engine in this programme. The core above is engine-
      agnostic and is what the tests prove; a test using a mocked reader proves NOTHING about live index contents. ── */

/** Algolia browse — objectIDs only, cursor-paged. `client` is algolia-indexer's AlgoliaClient (read hosts). */
function algoliaReader(client, index) {
  return async (cursor, pageSize) => {
    const body = cursor ? { cursor } : { hitsPerPage: Math.min(1000, pageSize), attributesToRetrieve: ['objectID'] };
    const r = await client._request('POST', `/1/indexes/${encodeURIComponent(index)}/browse`, body);
    return { ids: ((r && r.hits) || []).map((h) => h.objectID).filter(Boolean), next: (r && r.cursor) || null };
  };
}

/** Typesense — ids exported once (include_fields=id), then paged in memory by offset. */
function typesenseReader(client, collection) {
  let all = null;
  return async (cursor, pageSize) => {
    if (!all) {
      const raw = await client.exportDocuments(collection, { include_fields: 'id' });
      all = String(raw || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l).id; } catch (_) { return null; } }).filter(Boolean);
    }
    const from = Number(cursor) || 0;
    const to = from + pageSize;
    return { ids: all.slice(from, to), next: to < all.length ? to : null };
  };
}

module.exports = { SCOPE, DEFAULTS, REMOVE, writersOf, globalWritersOf, classifyPrimary, classifyGlobal, reconcileIndex, algoliaReader, typesenseReader };
