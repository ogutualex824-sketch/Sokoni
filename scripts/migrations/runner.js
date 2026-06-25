#!/usr/bin/env node
/**
 * SOKONI Firestore Migration Runner — Expand → Migrate → Contract
 *
 * Zero-downtime Firestore schema migrations.
 * Migrations are idempotent; they can be re-run safely.
 *
 * Usage:
 *   node scripts/migrations/runner.js list
 *   node scripts/migrations/runner.js run <migration-id>
 *   node scripts/migrations/runner.js run all
 *   node scripts/migrations/runner.js verify <migration-id>
 *   node scripts/migrations/runner.js rollback <migration-id>
 *
 * Writing a migration:
 *   1. Create  scripts/migrations/versions/<id>_<description>.js
 *   2. Export: { id, description, phase, up(), verify(), down() }
 *   3. phase = 'expand' | 'migrate' | 'contract'
 *      • expand:   add new fields/collections (backward-compatible)
 *      • migrate:  backfill data to new schema
 *      • contract: remove old fields (only after all functions deployed)
 */
'use strict';

const admin = require('firebase-admin');
const path  = require('path');
const fs    = require('fs');

const PROJECT = process.env.FIREBASE_PROJECT || 'sokoni-aeb26';
admin.initializeApp({ projectId: PROJECT });

const db             = admin.firestore();
const VERSIONS_DIR   = path.join(__dirname, 'versions');
const MIGRATION_COLL = '_migrations';
const BATCH_SIZE     = 400;

/* ── Helpers ──────────────────────────────────────────────── */
async function getMigrationStatus(id) {
  const snap = await db.collection(MIGRATION_COLL).doc(id).get();
  return snap.exists ? snap.data() : null;
}

async function setMigrationStatus(id, status, extra = {}) {
  await db.collection(MIGRATION_COLL).doc(id).set({
    id, status, updatedAt: admin.firestore.FieldValue.serverTimestamp(), ...extra,
  }, { merge: true });
}

function loadMigrations() {
  if (!fs.existsSync(VERSIONS_DIR)) return [];
  return fs.readdirSync(VERSIONS_DIR)
    .filter(f => f.endsWith('.js'))
    .sort()
    .map(f => require(path.join(VERSIONS_DIR, f)));
}

/* Batch-process a Firestore query with a transform function */
async function batchProcess(query, transform, label) {
  let processed = 0;
  let lastDoc   = null;
  let pageNum   = 0;

  while (true) {
    let q = query.limit(BATCH_SIZE);
    if (lastDoc) q = q.startAfter(lastDoc);

    const snap = await q.get();
    if (snap.empty) break;

    pageNum++;
    const writes = db.batch();
    snap.docs.forEach(doc => transform(doc, writes));
    await writes.commit();

    processed += snap.docs.length;
    lastDoc    = snap.docs[snap.docs.length - 1];
    process.stdout.write(`\r   ${label}: ${processed} docs (page ${pageNum})...`);
  }

  console.log(`\r   ${label}: ${processed} docs ✓                    `);
  return processed;
}

/* ── Commands ─────────────────────────────────────────────── */
async function cmdList() {
  const migrations = loadMigrations();
  console.log(`\n${migrations.length} migrations found:\n`);

  for (const m of migrations) {
    const status = await getMigrationStatus(m.id);
    const badge  = status?.status === 'completed' ? '✅' :
                   status?.status === 'failed'    ? '❌' :
                   status?.status === 'running'   ? '⏳' : '⬜';
    console.log(`  ${badge}  [${m.phase}]  ${m.id}  —  ${m.description}`);
    if (status?.completedAt) {
      console.log(`        Completed: ${status.completedAt?.toDate?.()?.toISOString() || 'unknown'}`);
    }
  }
  console.log();
}

async function cmdRun(id) {
  const migrations = loadMigrations();
  const toRun      = id === 'all'
    ? migrations
    : migrations.filter(m => m.id === id);

  if (toRun.length === 0) {
    console.error(`Migration "${id}" not found.`);
    process.exit(1);
  }

  for (const m of toRun) {
    const existing = await getMigrationStatus(m.id);
    if (existing?.status === 'completed') {
      console.log(`  ⏭️  Skipping ${m.id} (already completed)`);
      continue;
    }
    if (existing?.status === 'running') {
      console.warn(`  ⚠️  ${m.id} is already running — concurrent run prevented`);
      continue;
    }

    console.log(`\n▶  Running [${m.phase}] ${m.id}`);
    console.log(`   ${m.description}`);
    await setMigrationStatus(m.id, 'running', { startedAt: admin.firestore.FieldValue.serverTimestamp() });

    const startMs = Date.now();
    try {
      const result = await m.up({ db, admin, batchProcess });
      const durationMs = Date.now() - startMs;
      await setMigrationStatus(m.id, 'completed', {
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        durationMs, result: result || null,
      });
      console.log(`   ✅  Completed in ${(durationMs / 1000).toFixed(1)}s`);
    } catch (err) {
      await setMigrationStatus(m.id, 'failed', {
        error: err.message, failedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.error(`   ❌  FAILED: ${err.message}`);
      throw err;
    }
  }
}

async function cmdVerify(id) {
  const m = loadMigrations().find(m => m.id === id);
  if (!m) { console.error(`Migration "${id}" not found.`); process.exit(1); }

  console.log(`\n🔍  Verifying ${m.id}...`);
  try {
    const ok = await m.verify({ db, admin });
    if (ok) { console.log('   ✅  Verification passed'); }
    else     { console.error('   ❌  Verification FAILED'); process.exit(1); }
  } catch (err) {
    console.error(`   ❌  Verification error: ${err.message}`); process.exit(1);
  }
}

async function cmdRollback(id) {
  const m = loadMigrations().find(m => m.id === id);
  if (!m) { console.error(`Migration "${id}" not found.`); process.exit(1); }
  if (!m.down) { console.error(`Migration "${id}" has no rollback (down) function.`); process.exit(1); }

  console.log(`\n🔄  Rolling back ${m.id}...`);
  await setMigrationStatus(m.id, 'rolling_back');
  try {
    await m.down({ db, admin, batchProcess });
    await setMigrationStatus(m.id, 'rolled_back');
    console.log('   ✅  Rollback complete');
  } catch (err) {
    await setMigrationStatus(m.id, 'rollback_failed', { error: err.message });
    console.error(`   ❌  Rollback FAILED: ${err.message}`);
    process.exit(1);
  }
}

/* ── CLI ─────────────────────────────────────────────────── */
const [, , cmd, arg] = process.argv;
const cmds = { list: cmdList, run: () => cmdRun(arg), verify: () => cmdVerify(arg), rollback: () => cmdRollback(arg) };

if (!cmds[cmd]) {
  console.error('Usage: runner.js <list|run|verify|rollback> [id]');
  process.exit(1);
}

cmds[cmd]()
  .then(() => process.exit(0))
  .catch(err => { console.error(err.message); process.exit(1); });
