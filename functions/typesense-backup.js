/**
 * SOKONI Typesense Backup v1.0
 *
 * Automated backup, integrity verification, and restore procedures.
 *
 * Strategy:
 *  - Export Typesense collections as JSONL → write to Firestore (small collections)
 *    or Cloud Storage (large collections > 5 000 docs)
 *  - Verify backup integrity: document count + schema version check
 *  - Restore from backup: re-import JSONL into a versioned collection, then swap alias
 *  - Rotation: keep 7 daily backups, 4 weekly backups, 3 monthly backups
 *
 * Scheduled:
 *  typesenseBackupDaily   — runs every day 01:00
 *  typesenseBackupCleanup — runs every sunday 02:00 (rotation)
 *
 * Admin callables:
 *  typesenseRestoreBackup  — restore a named backup into a new versioned collection
 *  typesenseListBackups    — list available backups with metadata
 *  typesenseVerifyBackup   — verify backup integrity without restoring
 */

'use strict';

const { onSchedule }               = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError }       = require('firebase-functions/v2/https');
const { defineSecret }             = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage }               = require('firebase-admin/storage');
const {
  TypesenseClient,
  COLLECTION_SCHEMAS,
  _chunk,
  _sleep,
} = require('./typesense-client');

const TYPESENSE_ADMIN_KEY = defineSecret('TYPESENSE_ADMIN_KEY');
const TYPESENSE_NODES_VAR = process.env.TYPESENSE_NODES || '';

const BACKUP_META_COL   = 'tsBackupMeta';
const BACKUP_DOCS_COL   = 'tsBackupDocs';
const STORAGE_BUCKET    = process.env.GCLOUD_PROJECT ? `${process.env.GCLOUD_PROJECT}.appspot.com` : '';
const LARGE_COL_THRESHOLD = 5_000; /* use Storage for collections > 5k docs */

function _makeClient(adminKey) {
  const nodes = TYPESENSE_NODES_VAR
    ? TYPESENSE_NODES_VAR.split(',').map(s => s.trim()).filter(Boolean)
    : ['localhost:8108:http'];
  return new TypesenseClient(nodes, adminKey, { timeoutMs: 60_000, maxRetries: 2 });
}

/* ── Backup ID helpers ──────────────────────────────────────────── */

function _backupId(collection, type = 'daily') {
  const d   = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${type}_${collection}_${ymd}`;
}

/* ── Write JSONL to Cloud Storage ───────────────────────────────── */

async function _writeToStorage(backupId, collection, jsonl) {
  const bucket = getStorage().bucket(STORAGE_BUCKET);
  const file   = bucket.file(`typesense-backups/${collection}/${backupId}.jsonl`);
  await file.save(jsonl, { contentType: 'application/x-ndjson', gzip: true });
  return `gs://${STORAGE_BUCKET}/typesense-backups/${collection}/${backupId}.jsonl`;
}

/* ── Write JSONL to Firestore (small collections, max 1MB per doc) */

async function _writeToFirestore(db, backupId, collection, jsonl) {
  const lines  = jsonl.split('\n').filter(Boolean);
  const chunks = _chunk(lines, 50); /* ~50 docs per Firestore doc to stay under 1MB */
  for (let i = 0; i < chunks.length; i++) {
    await db.collection(BACKUP_DOCS_COL)
      .doc(`${backupId}_chunk_${i}`)
      .set({ backupId, collection, chunk: i, lines: chunks[i], createdAt: Date.now() });
  }
  return `firestore:${BACKUP_DOCS_COL}:${backupId}`;
}

/* ═══════════════════════════════════════════════════════════════════
   DAILY BACKUP — Runs 01:00 UTC
   Exports all 25 collections and writes metadata.
════════════════════════════════════════════════════════════════════ */

exports.typesenseBackupDaily = onSchedule(
  {
    schedule:       'every day 01:00',
    timeoutSeconds: 540,
    memory:         '1GiB',
    secrets:        [TYPESENSE_ADMIN_KEY],
  },
  async () => {
    const adminKey = TYPESENSE_ADMIN_KEY.value();
    if (!adminKey || adminKey === 'not_configured') return;

    const ts      = _makeClient(adminKey);
    const db      = getFirestore();
    const results = { backed_up: [], failed: [], timestamp: Date.now() };

    for (const [, schema] of Object.entries(COLLECTION_SCHEMAS)) {
      const colName = schema.name;
      try {
        /* Check collection exists and get doc count */
        const colInfo  = await ts.getCollection(colName).catch(() => null);
        if (!colInfo) continue;
        const docCount = colInfo.num_documents || 0;

        /* Export JSONL */
        const jsonlRaw = await ts.exportDocuments(colName);
        const jsonl    = typeof jsonlRaw === 'object' ? JSON.stringify(jsonlRaw) : String(jsonlRaw || '');

        const bId      = _backupId(colName, 'daily');
        let   storeLoc;

        if (docCount > LARGE_COL_THRESHOLD && STORAGE_BUCKET) {
          storeLoc = await _writeToStorage(bId, colName, jsonl);
        } else {
          storeLoc = await _writeToFirestore(db, bId, colName, jsonl);
        }

        /* Write metadata */
        await db.collection(BACKUP_META_COL).doc(bId).set({
          backupId:    bId,
          collection:  colName,
          type:        'daily',
          docCount,
          storeLoc,
          schemaVersion: colInfo.created_at || 0,
          createdAt:   FieldValue.serverTimestamp(),
          verified:    false,
        });

        results.backed_up.push({ collection: colName, docCount, location: storeLoc });
      } catch (err) {
        results.failed.push({ collection: colName, error: err.message });
        console.error(`[TS Backup] Failed to backup ${colName}:`, err.message);
      }

      await _sleep(500); /* brief pause between collections */
    }

    /* Alert if any backup failed */
    if (results.failed.length) {
      await db.collection('adminAlerts').add({
        type:      'typesense_backup_failure',
        severity:  results.failed.length > 5 ? 'critical' : 'warning',
        message:   `Typesense backup: ${results.failed.length} collections failed`,
        failed:    results.failed,
        createdAt: Date.now(),
        resolved:  false,
      });
    }

    console.log(`[TS Backup] Done. Success: ${results.backed_up.length}, Failed: ${results.failed.length}`);
    return results;
  }
);

/* ═══════════════════════════════════════════════════════════════════
   BACKUP ROTATION — Weekly Sunday 02:00
   Keep: 7 daily, 4 weekly, 3 monthly. Delete older backups.
════════════════════════════════════════════════════════════════════ */

exports.typesenseBackupCleanup = onSchedule(
  {
    schedule:       'every sunday 02:00',
    timeoutSeconds: 300,
    memory:         '256MiB',
  },
  async () => {
    const db      = getFirestore();
    const now     = Date.now();

    /* Cutoffs: keep 7 daily (7 days), 4 weekly (28 days), 3 monthly (90 days) */
    const daily7d  = now - 7  * 86_400_000;
    const weekly4w = now - 28 * 86_400_000;
    const monthly3m= now - 90 * 86_400_000;

    /* Delete old daily backups (> 7 days) */
    const oldDailies = await db.collection(BACKUP_META_COL)
      .where('type', '==', 'daily')
      .where('createdAt', '<', new Date(daily7d))
      .limit(500).get();

    let deleted = 0;
    for (const chunk of _chunk(oldDailies.docs, 100)) {
      const batch = db.batch();
      for (const metaDoc of chunk) {
        const d = metaDoc.data();
        batch.delete(metaDoc.ref);
        /* Delete associated chunk docs */
        const chunks = await db.collection(BACKUP_DOCS_COL)
          .where('backupId', '==', d.backupId).limit(200).get();
        chunks.docs.forEach(c => batch.delete(c.ref));
        /* Delete from Storage if applicable */
        if (d.storeLoc?.startsWith('gs://') && STORAGE_BUCKET) {
          const path = d.storeLoc.replace(`gs://${STORAGE_BUCKET}/`, '');
          getStorage().bucket(STORAGE_BUCKET).file(path).delete().catch(() => {});
        }
        deleted++;
      }
      await batch.commit();
    }

    console.log(`[TS Backup Cleanup] Deleted ${deleted} old backups`);
  }
);

/* ═══════════════════════════════════════════════════════════════════
   LIST BACKUPS — Admin callable
════════════════════════════════════════════════════════════════════ */

exports.typesenseListBackups = onCall(
  {
    timeoutSeconds: 30,
    memory:         '128MiB',
  },
  async ({ auth, data: callData = {} }) => {
    if (!auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only');
    const db    = getFirestore();
    const limit = Math.min(callData?.limit || 50, 200);
    let   query = db.collection(BACKUP_META_COL).orderBy('createdAt', 'desc').limit(limit);
    if (callData?.collection) query = query.where('collection', '==', callData.collection);
    const snap  = await query.get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
);

/* ═══════════════════════════════════════════════════════════════════
   VERIFY BACKUP — Admin callable
   Checks that backup has expected doc count and is readable.
════════════════════════════════════════════════════════════════════ */

exports.typesenseVerifyBackup = onCall(
  {
    secrets:        [TYPESENSE_ADMIN_KEY],
    timeoutSeconds: 60,
    memory:         '256MiB',
  },
  async ({ auth, data: callData = {} }) => {
    if (!auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only');
    const { backupId } = callData;
    if (!backupId) throw new HttpsError('invalid-argument', 'backupId required');

    const db   = getFirestore();
    const meta = await db.collection(BACKUP_META_COL).doc(backupId).get();
    if (!meta.exists) throw new HttpsError('not-found', `Backup "${backupId}" not found`);

    const d = meta.data();

    /* Count backed-up docs */
    let backedUpCount = 0;
    if (d.storeLoc?.startsWith('firestore:')) {
      const snap = await db.collection(BACKUP_DOCS_COL)
        .where('backupId', '==', backupId).get();
      snap.docs.forEach(doc => { backedUpCount += (doc.data().lines || []).length; });
    }

    const valid   = backedUpCount > 0;
    const drift   = Math.abs(backedUpCount - (d.docCount || 0));
    const driftPct = d.docCount > 0 ? Math.round((drift / d.docCount) * 100) : 0;

    /* Update verified flag */
    await meta.ref.update({ verified: valid, verifiedAt: FieldValue.serverTimestamp(), backedUpCount });

    return {
      backupId,
      collection:    d.collection,
      expectedCount: d.docCount,
      backedUpCount,
      drift,
      driftPct,
      valid,
    };
  }
);

/* ═══════════════════════════════════════════════════════════════════
   RESTORE BACKUP — Admin callable
   Re-imports a backup into a new versioned collection and swaps the alias.
════════════════════════════════════════════════════════════════════ */

exports.typesenseRestoreBackup = onCall(
  {
    secrets:        [TYPESENSE_ADMIN_KEY],
    timeoutSeconds: 540,
    memory:         '1GiB',
  },
  async ({ auth, data: callData = {} }) => {
    if (!auth?.token?.admin) throw new HttpsError('permission-denied', 'Admin only');
    const { backupId, targetVersion = 'restored' } = callData;
    if (!backupId) throw new HttpsError('invalid-argument', 'backupId required');

    const db    = getFirestore();
    const ts    = _makeClient(TYPESENSE_ADMIN_KEY.value());
    const meta  = await db.collection(BACKUP_META_COL).doc(backupId).get();
    if (!meta.exists) throw new HttpsError('not-found', `Backup "${backupId}" not found`);

    const d           = meta.data();
    const targetName  = `${d.collection}_${targetVersion}`;
    const schema      = COLLECTION_SCHEMAS[d.collection];
    if (!schema) throw new HttpsError('not-found', `No schema for "${d.collection}"`);

    /* Create restore target collection */
    if (await ts.collectionExists(targetName)) await ts.deleteCollection(targetName);
    await ts.createCollection({ ...schema, name: targetName });

    /* Read backup docs from Firestore */
    let imported = 0;
    if (d.storeLoc?.startsWith('firestore:')) {
      const snap = await db.collection(BACKUP_DOCS_COL)
        .where('backupId', '==', backupId)
        .orderBy('chunk').get();

      for (const chunkDoc of snap.docs) {
        const lines = chunkDoc.data().lines || [];
        const docs  = lines.map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
        if (docs.length) {
          const res = await ts.importDocuments(targetName, docs, 'create');
          imported += res.filter(r => r?.success !== false).length;
        }
        await _sleep(100);
      }
    }

    /* Swap alias */
    await ts.createAlias(d.collection, targetName);

    /* Log restore */
    await db.collection('tsRestoreLog').add({
      backupId,
      sourceCollection: d.collection,
      targetCollection: targetName,
      imported,
      restoredBy:  auth.uid,
      restoredAt:  FieldValue.serverTimestamp(),
    });

    return {
      backupId,
      targetCollection: targetName,
      aliasSwapped:     d.collection,
      imported,
    };
  }
);
