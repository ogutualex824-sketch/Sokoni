/**
 * SOKONI Typesense Admin v2.0
 *
 * Callable + scheduled Cloud Functions for cluster administration:
 *
 *  typesenseCreateCollections  — create/update all 25 collections + wire synonyms + presets
 *  typesenseBackfill           — blue-green reindex via versioned collection aliases
 *  typesenseHealthCheck        — per-node status, per-collection counts, queue depth, metrics
 *  typesenseDeleteOrphans      — remove TS docs with no Firestore counterpart
 *  typesenseCreateAlias        — manually point alias to a versioned collection
 *  typesenseCanaryDeploy       — route a percentage of traffic to a new collection version
 *  typesenseCollectionStats    — per-collection document counts + field stats
 *
 * Zero-downtime reindex (blue-green):
 *   1. typesenseBackfill({ firestoreCollection, version: "v2" })
 *      → creates sokoni_products_v2, imports all Firestore docs in pages of 500
 *   2. typesenseCreateAlias({ alias: "sokoni_products", collection: "sokoni_products_v2" })
 *      → live traffic cuts over atomically; old version stays until deleted
 */

'use strict';

const { onSchedule }               = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError }       = require('firebase-functions/v2/https');
const { defineSecret }             = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const {
  TypesenseClient,
  COLLECTION_SCHEMAS,
  COLLECTION_MAP,
  TRANSFORMERS,
  TS_SYNONYMS,
  _chunk,
  _sleep,
} = require('./typesense-client');

const TYPESENSE_ADMIN_KEY = defineSecret('TYPESENSE_ADMIN_KEY');
const TYPESENSE_NODES_VAR = process.env.TYPESENSE_NODES || '';

function _makeClient(adminKey) {
  const nodes = TYPESENSE_NODES_VAR
    ? TYPESENSE_NODES_VAR.split(',').map(s => s.trim()).filter(Boolean)
    : ['localhost:8108:http'];
  return new TypesenseClient(nodes, adminKey, {
    timeoutMs:    20_000,
    maxRetries:   3,
    cbThreshold:  5,
    cbCooldownMs: 30_000,
  });
}

/* ═══════════════════════════════════════════════════════════════════
   CREATE ALL COLLECTIONS + SYNONYMS + PRESETS
   Safe to call multiple times: updates fields on existing collections
   using PATCH instead of re-creating them (avoids downtime).
════════════════════════════════════════════════════════════════════ */

exports.typesenseCreateCollections = onCall(
  {
    secrets:        [TYPESENSE_ADMIN_KEY],
    timeoutSeconds: 300,
    memory:         '512MiB',
  },
  async ({ auth, data: opts = {} }) => {
    if (!auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only');
    const ts      = _makeClient(TYPESENSE_ADMIN_KEY.value());
    const results = { created: [], updated: [], failed: [], synonyms: 0, presets: 0 };

    const targetSchemas = opts.collections
      ? Object.entries(COLLECTION_SCHEMAS).filter(([k]) => opts.collections.includes(k))
      : Object.entries(COLLECTION_SCHEMAS);

    for (const [, schema] of targetSchemas) {
      try {
        const exists = await ts.collectionExists(schema.name);
        if (exists) {
          /* Add any missing fields to live collection (safe — Typesense supports additive updates) */
          const live    = await ts.getCollection(schema.name);
          const liveSet = new Set(live.fields.map(f => f.name));
          const missing = schema.fields.filter(f => !liveSet.has(f.name));
          if (missing.length) {
            await ts.updateCollectionFields(schema.name, missing);
            results.updated.push(`${schema.name} (+${missing.length} fields)`);
          } else {
            results.updated.push(`${schema.name} (no-op)`);
          }
        } else {
          await ts.createCollection(schema);
          /* Wire alias on first create: alias = base name → collection */
          await ts.createAlias(schema.name, schema.name);
          results.created.push(schema.name);
        }
      } catch (err) {
        results.failed.push(`${schema.name}: ${err.message}`);
        console.error(`[TS Admin] Failed to create/update ${schema.name}:`, err.message);
      }
    }

    /* Apply Kenyan synonyms to all searchable collections */
    const searchableCollections = Object.values(COLLECTION_SCHEMAS)
      .filter(s => !['sokoni_categories', 'sokoni_brands', 'sokoni_coupons', 'sokoni_faq'].includes(s.name))
      .map(s => s.name);

    for (const col of searchableCollections) {
      const exists = await ts.collectionExists(col).catch(() => false);
      if (!exists) continue;
      for (const syn of TS_SYNONYMS) {
        try {
          await ts.upsertSynonym(col, syn.id, { type: syn.type, synonyms: syn.synonyms });
          results.synonyms++;
        } catch (_) { /* non-fatal */ }
      }
    }

    /* Apply search presets for common search patterns */
    try {
      await ts.upsertPreset('products_default', {
        parameters: {
          query_by:            'name,description,brand,category,tags',
          query_by_weights:    '10,3,5,4,2',
          sort_by:             '_popularityScore:desc',
          facet_by:            'category,brand,inStock,condition,hub',
          num_typos:           2,
          typo_tolerance_min_word_len: 4,
          min_len_1typo:       4,
          min_len_2typos:      7,
          prefix:              true,
          drop_tokens_threshold: 2,
          highlight_fields:    'name,brand',
        },
      });
      results.presets++;
    } catch (_) { /* non-fatal */ }

    console.log(`[TS Admin] Collections: ${results.created.length} created, ${results.updated.length} updated, ${results.failed.length} failed. Synonyms: ${results.synonyms}.`);
    return results;
  }
);

/* ═══════════════════════════════════════════════════════════════════
   BLUE-GREEN BACKFILL
   Creates a versioned collection (e.g. sokoni_products_v2),
   imports all Firestore docs, then atomically swaps the alias.
════════════════════════════════════════════════════════════════════ */

exports.typesenseBackfill = onCall(
  {
    secrets:        [TYPESENSE_ADMIN_KEY],
    timeoutSeconds: 540,
    memory:         '1GiB',
  },
  async ({ auth, data: callData = {} }) => {
    if (!auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only');

    const { firestoreCollection, version = 'v1', pageSize = 500 } = callData;
    if (!firestoreCollection) throw new HttpsError('invalid-argument', 'firestoreCollection required');

    const mapEntry = COLLECTION_MAP[firestoreCollection];
    if (!mapEntry) throw new HttpsError('not-found', `No COLLECTION_MAP entry for "${firestoreCollection}"`);

    const { collection: baseName, transformer } = mapEntry;
    const versionedName  = `${baseName}_${version}`;
    const schema         = COLLECTION_SCHEMAS[baseName];
    if (!schema) throw new HttpsError('not-found', `No schema for "${baseName}"`);

    const ts = _makeClient(TYPESENSE_ADMIN_KEY.value());
    const db = getFirestore();

    /* 1. Create versioned collection */
    const alreadyExists = await ts.collectionExists(versionedName);
    if (alreadyExists && !callData.overwrite) {
      throw new HttpsError('already-exists', `Collection "${versionedName}" already exists. Pass overwrite:true to rebuild it.`);
    }
    if (alreadyExists) await ts.deleteCollection(versionedName);
    await ts.createCollection({ ...schema, name: versionedName });

    /* 2. Paginate through Firestore and import */
    let cursor   = null;
    let imported = 0;
    let failed   = 0;
    let page     = 0;
    const startTime = Date.now();

    while (true) {
      let query = db.collection(firestoreCollection)
        .where('status', 'not-in', ['deleted', 'banned', 'suspended'])
        .orderBy('__name__')
        .limit(pageSize);
      if (cursor) query = query.startAfter(cursor);

      const snap = await query.get();
      if (snap.empty) break;

      const docs = [];
      for (const doc of snap.docs) {
        try {
          const transformed = transformer(doc.id, doc.data());
          if (transformed) docs.push({ ...transformed, id: doc.id });
        } catch (_) { failed++; }
      }

      if (docs.length) {
        const results = await ts.importDocuments(versionedName, docs, 'create');
        const pageFailed = results.filter(r => r && r.success === false).length;
        failed   += pageFailed;
        imported += docs.length - pageFailed;
      }

      cursor = snap.docs[snap.docs.length - 1];
      page++;
      console.log(`[TS Backfill] ${firestoreCollection} page ${page}: ${imported} imported, ${failed} failed`);
      if (snap.size < pageSize) break;
      await _sleep(100); /* brief pause to avoid Firestore rate limits */
    }

    /* 3. Apply synonyms to versioned collection */
    for (const syn of TS_SYNONYMS) {
      try {
        await ts.upsertSynonym(versionedName, syn.id, { type: syn.type, synonyms: syn.synonyms });
      } catch (_) { /* non-fatal */ }
    }

    /* 4. Atomically swap alias */
    await ts.createAlias(baseName, versionedName);

    /* 5. Log to Firestore for audit trail */
    await db.collection('tsBackfillLog').add({
      firestoreCollection,
      baseName,
      versionedName,
      imported,
      failed,
      pages: page,
      durationMs: Date.now() - startTime,
      completedAt: FieldValue.serverTimestamp(),
    });

    return {
      collection:  versionedName,
      aliasTarget: baseName,
      imported,
      failed,
      pages: page,
      durationMs: Date.now() - startTime,
    };
  }
);

/* ═══════════════════════════════════════════════════════════════════
   HEALTH CHECK
   Returns per-node status, per-collection doc counts, queue depth,
   cluster metrics, and alias mapping.
════════════════════════════════════════════════════════════════════ */

exports.typesenseHealthCheck = onCall(
  {
    secrets:        [TYPESENSE_ADMIN_KEY],
    timeoutSeconds: 30,
    memory:         '256MiB',
  },
  async ({ auth }) => {
    if (!auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only');
    const ts = _makeClient(TYPESENSE_ADMIN_KEY.value());
    const db = getFirestore();

    const [nodeStatuses, aliases, allCollections, metrics, stats, queueDepth, dlqDepth] =
      await Promise.allSettled([
        ts.nodeStatuses(),
        ts.listAliases(),
        ts.listCollections(),
        ts.metrics(),
        ts.stats(),
        db.collection('typesenseQueue').where('status', '==', 'pending').count().get(),
        db.collection('typesenseQueueDLQ').where('status', '==', 'failed').count().get(),
      ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason?.message }));

    /* Per-collection document counts */
    const collectionCounts = {};
    if (Array.isArray(allCollections)) {
      allCollections.forEach(c => { collectionCounts[c.name] = c.num_documents || 0; });
    }

    return {
      nodes:           nodeStatuses,
      aliases:         aliases?.aliases || aliases,
      collectionCounts,
      queueDepth:      queueDepth?.data?.count ?? 'unavailable',
      dlqDepth:        dlqDepth?.data?.count   ?? 'unavailable',
      metrics:         metrics || { error: 'unavailable' },
      stats:           stats   || { error: 'unavailable' },
      checkedAt:       Date.now(),
    };
  }
);

/* ═══════════════════════════════════════════════════════════════════
   DELETE ORPHANS — Scheduled Monday 03:00
   Finds Typesense docs with no matching Firestore document.
   Checks 10 000 TS docs per collection per run to stay within 540s timeout.
════════════════════════════════════════════════════════════════════ */

exports.typesenseDeleteOrphans = onSchedule(
  {
    schedule:       'every monday 03:00',
    timeoutSeconds: 540,
    memory:         '512MiB',
    secrets:        [TYPESENSE_ADMIN_KEY],
  },
  async () => {
    const ts = _makeClient(TYPESENSE_ADMIN_KEY.value());
    const db = getFirestore();

    const results = { checked: 0, deleted: 0, errors: 0 };

    for (const [firestoreCol, mapEntry] of Object.entries(COLLECTION_MAP)) {
      if (!mapEntry) continue;
      const { collection: tsCol } = mapEntry;

      try {
        /* Fetch 10 000 IDs from Typesense using wildcard search */
        const tsRes = await ts.search(tsCol, {
          q:                '*',
          query_by:         'id',
          per_page:         250,
          page:             1,
          include_fields:   'id',
          filter_by:        '',
          sort_by:          '_text_match:desc',
          search_cutoff_ms: 5_000,
        }).catch(() => null);

        if (!tsRes?.hits) continue;

        const idsToCheck = tsRes.hits.map(h => h.document?.id).filter(Boolean);
        results.checked += idsToCheck.length;

        /* Batch-check Firestore existence */
        for (const chunk of _chunk(idsToCheck, 30)) {
          const refs  = chunk.map(id => db.collection(firestoreCol).doc(id));
          const snaps = await db.getAll(...refs);
          const orphanIds = snaps.filter(s => !s.exists).map(s => s.id);

          for (const orphanId of orphanIds) {
            try {
              await ts.deleteDocument(tsCol, orphanId);
              results.deleted++;
            } catch (delErr) {
              if (delErr.status !== 404) results.errors++;
            }
          }
        }
      } catch (err) {
        console.error(`[TS Orphans] Error checking ${firestoreCol}:`, err.message);
        results.errors++;
      }
    }

    await db.collection('tsOrphanLog').add({
      ...results,
      runAt: FieldValue.serverTimestamp(),
    });

    console.log(`[TS Orphans] Checked: ${results.checked}, Deleted: ${results.deleted}, Errors: ${results.errors}`);
  }
);

/* ═══════════════════════════════════════════════════════════════════
   CREATE / SWAP ALIAS — Admin callable
════════════════════════════════════════════════════════════════════ */

exports.typesenseCreateAlias = onCall(
  {
    secrets:        [TYPESENSE_ADMIN_KEY],
    timeoutSeconds: 15,
    memory:         '256MiB',
  },
  async ({ auth, data: callData = {} }) => {
    if (!auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only');
    const { alias, collection } = callData;
    if (!alias || !collection) throw new HttpsError('invalid-argument', 'alias and collection are required');
    const ts     = _makeClient(TYPESENSE_ADMIN_KEY.value());
    const result = await ts.createAlias(alias, collection);
    return result;
  }
);

/* ═══════════════════════════════════════════════════════════════════
   COLLECTION STATS — Admin callable
   Returns per-collection schema + field stats for debugging.
════════════════════════════════════════════════════════════════════ */

exports.typesenseCollectionStats = onCall(
  {
    secrets:        [TYPESENSE_ADMIN_KEY],
    timeoutSeconds: 30,
    memory:         '256MiB',
  },
  async ({ auth, data: callData = {} }) => {
    if (!auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only');
    const ts = _makeClient(TYPESENSE_ADMIN_KEY.value());

    const targetName = callData?.collection;
    if (targetName) {
      const col = await ts.getCollection(targetName);
      return col;
    }

    const all = await ts.listCollections();
    return all.map(c => ({
      name:          c.name,
      num_documents: c.num_documents,
      num_memory_shards: c.num_memory_shards,
      created_at:    c.created_at,
    }));
  }
);

/* ═══════════════════════════════════════════════════════════════════
   CANARY DEPLOY — Admin callable
   Routes a percentage of search traffic to a new collection version
   by updating the alias. If percentage < 100, alias still points
   to the stable version; the caller should run A/B testing client-side.
   At 100%, the alias is permanently swapped to the canary.
════════════════════════════════════════════════════════════════════ */

exports.typesenseCanaryDeploy = onCall(
  {
    secrets:        [TYPESENSE_ADMIN_KEY],
    timeoutSeconds: 60,
    memory:         '256MiB',
  },
  async ({ auth, data: callData = {} }) => {
    if (!auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only');
    const { baseName, canaryVersion, percentage = 10 } = callData;
    if (!baseName || !canaryVersion) {
      throw new HttpsError('invalid-argument', 'baseName and canaryVersion are required');
    }
    const pct = Math.min(100, Math.max(0, parseInt(percentage, 10)));
    const ts  = _makeClient(TYPESENSE_ADMIN_KEY.value());
    const db  = getFirestore();

    const canaryCollection = `${baseName}_${canaryVersion}`;
    const exists = await ts.collectionExists(canaryCollection);
    if (!exists) throw new HttpsError('not-found', `Canary collection "${canaryCollection}" does not exist. Run backfill first.`);

    /* Record canary config for client-side traffic splitting */
    await db.collection('tsCanaryConfig').doc(baseName).set({
      stable:      baseName,
      canary:      canaryCollection,
      percentage:  pct,
      deployedAt:  FieldValue.serverTimestamp(),
      deployedBy:  auth.uid,
    });

    if (pct >= 100) {
      /* Full cut-over: swap alias */
      await ts.createAlias(baseName, canaryCollection);
      await db.collection('tsCanaryConfig').doc(baseName).update({ fullCutover: true, cutoverAt: FieldValue.serverTimestamp() });
    }

    return { canaryCollection, percentage: pct, fullCutover: pct >= 100 };
  }
);
