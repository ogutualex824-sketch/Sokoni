#!/usr/bin/env node
'use strict';
/**
 * FREE-50 rollout — productCounters ceilings onto catalogue v3 (owner ruling 2026-09-08, c1d8ea1:
 * FREE 50 / PROFESSIONAL 100 / BUSINESS & ENTERPRISE unlimited).
 *
 *   DRY RUN (default)           reads only; prints the plan; writes an evidence file (no writes)
 *   --apply --authorized-by "<owner>"   performs the minimum writes, then READS EVERY COUNTER BACK and
 *                               records before/after/readback in the evidence file
 *   --verify <evidence.json>    read-only: compares the live counters with an evidence file's expected values
 *   --rollback <evidence.json>  restores every written counter to its recorded `before` values
 *   --uid <uid>                 restrict any mode to one counter
 *
 * RULES (owner brief 2026-09-30)
 *   • every affected merchant is enumerated: every productCounters document, plus every uid that owns
 *     products but has no counter (listed; never created here — canPublishProduct resolves them)
 *   • the actual listing count is measured from `products` (sellerUid, and shopId as a cross-check);
 *     the counter's `count` is reported and drift flagged, NEVER written (recount is a separate op)
 *   • never reduce an entitlement: target = max(catalogue ceiling, current maxProducts); a merchant
 *     already above the ceiling keeps everything: grandfatheredFloor = actual count (a FLOOR, not a cap)
 *   • never manufacture listings
 *   • idempotent: a counter already at migrationVersion === VERSION with equal values is skipped
 *   • every write records migrationVersion, migratedAt, migratedBy (--authorized-by) and migrationBefore
 *   • the ceiling comes from product-limit.resolveMaxProducts — the same resolution canPublishProduct
 *     uses — so this script holds no number of its own
 */
const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const admin = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin'));

const ARGS = process.argv.slice(2);
const flag = (n) => ARGS.includes(n);
const val  = (n) => (ARGS.includes(n) ? ARGS[ARGS.indexOf(n) + 1] : null);
const APPLY = flag('--apply'), ROLLBACK = val('--rollback'), VERIFY = val('--verify'), AUTH = val('--authorized-by'), ONE_UID = val('--uid');
const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
const VERSION = 'catalog-v3-free50-2026-09-30';
const EMULATED = !!process.env.FIRESTORE_EMULATOR_HOST;

if (APPLY && !AUTH) { console.error('  --apply requires --authorized-by "<owner name>"; refusing.'); process.exit(2); }
if ([APPLY, !!ROLLBACK, !!VERIFY].filter(Boolean).length > 1) { console.error('  --apply / --rollback / --verify are exclusive.'); process.exit(2); }

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
const F  = admin.firestore.FieldValue;
const { resolveMaxProducts } = require(path.join(ROOT, 'functions', 'product-limit'))._internal;
const catalog = require(path.join(ROOT, 'functions', 'subscription-catalog'));
const fmt = (n) => (n === -1 ? 'unlimited' : n == null ? '—' : String(n));
const ts  = () => new Date().toISOString();

async function countWhere(field, uid) {
  try { return (await db.collection('products').where(field, '==', uid).count().get()).data().count; }
  catch (_) { return (await db.collection('products').where(field, '==', uid).select().get()).size; }
}
async function actualCounts(uid) {
  const [bySellerUid, byShopId] = await Promise.all([countWhere('sellerUid', uid), countWhere('shopId', uid)]);
  return { bySellerUid, byShopId };
}
function evidencePath(kind) {
  const dir = path.join(ROOT, 'docs', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `free50-${kind}${EMULATED ? '-emulator' : ''}-${ts().replace(/[:.]/g, '-')}.json`);
}
async function readCounter(uid) {
  const s = await db.collection('productCounters').doc(uid).get();
  if (!s.exists) return null;
  const d = s.data();
  return { maxProducts: d.maxProducts ?? null, grandfatheredFloor: d.grandfatheredFloor ?? null, catalogVersion: d.catalogVersion ?? null,
           migrationVersion: d.migrationVersion ?? null, migratedBy: d.migratedBy ?? null, count: d.count ?? null };
}

(async () => {
  const mode = ROLLBACK ? 'ROLLBACK' : VERIFY ? 'VERIFY' : APPLY ? 'APPLY' : 'DRY RUN';
  console.log(`\n  FREE-50 rollout — productCounters → catalogue ${catalog.PLANS.FREE.listingLimit}/${catalog.PLANS.PROFESSIONAL.listingLimit}/${fmt(catalog.PLANS.BUSINESS.listingLimit)}/${fmt(catalog.PLANS.ENTERPRISE.listingLimit)}`);
  console.log(`  project ${PROJECT}${EMULATED ? ' (EMULATOR ' + process.env.FIRESTORE_EMULATOR_HOST + ')' : ''} · mode ${mode} · migration ${VERSION}${ONE_UID ? ' · uid ' + ONE_UID : ''}\n`);

  /* ── VERIFY: live == expected ─────────────────────────────────────────────────────── */
  if (VERIFY) {
    const ev = JSON.parse(fs.readFileSync(VERIFY, 'utf8'));
    let ok = 0, bad = 0;
    for (const row of ev.rows) {
      if (ONE_UID && row.uid !== ONE_UID) continue;
      const live = await readCounter(row.uid);
      const expectMax = ev.mode === 'ROLLBACK' ? row.before.maxProducts : row.target;
      const good = live && live.maxProducts === expectMax
        && (ev.mode === 'ROLLBACK' || live.migrationVersion === VERSION)
        && (row.grandfatheredFloor == null || ev.mode === 'ROLLBACK' || live.grandfatheredFloor === row.grandfatheredFloor)
        && (live.maxProducts === -1 || row.before.maxProducts == null || row.before.maxProducts === -1 || live.maxProducts >= row.before.maxProducts);
      good ? ok++ : bad++;
      console.log(`  ${good ? 'OK  ' : 'DIFF'} ${row.uid.slice(0, 20).padEnd(20)} live max ${fmt(live && live.maxProducts)} floor ${fmt(live && live.grandfatheredFloor)} ver ${live && live.migrationVersion || '—'}  expected max ${fmt(expectMax)}`);
    }
    console.log(`\n  verify: ${ok} match, ${bad} differ`);
    process.exit(bad ? 1 : 0);
  }

  /* ── ROLLBACK: restore recorded before-values ─────────────────────────────────────── */
  if (ROLLBACK) {
    const ev = JSON.parse(fs.readFileSync(ROLLBACK, 'utf8'));
    if (ev.mode !== 'APPLY') { console.error('  rollback needs an APPLY evidence file (it holds the before-values that were actually overwritten).'); process.exit(2); }
    const rows = [];
    for (const row of ev.rows) {
      if (!row.written || (ONE_UID && row.uid !== ONE_UID)) continue;
      const b = row.before;
      await db.collection('productCounters').doc(row.uid).set({
        maxProducts: b.maxProducts, grandfatheredFloor: b.grandfatheredFloor == null ? F.delete() : b.grandfatheredFloor,
        catalogVersion: b.catalogVersion ?? null, catalogMax: F.delete(), migrationVersion: F.delete(), migratedBy: F.delete(), migratedAt: F.delete(), migrationBefore: F.delete(),
        rolledBackAt: F.serverTimestamp(), rolledBackFrom: VERSION, rolledBackBy: AUTH || null,
      }, { merge: true });
      rows.push({ uid: row.uid, before: row.before, target: row.target, written: true, readback: await readCounter(row.uid) });
    }
    const file = evidencePath('rollback');
    fs.writeFileSync(file, JSON.stringify({ version: VERSION, mode: 'ROLLBACK', from: path.basename(ROLLBACK), project: PROJECT, at: ts(), rows }, null, 2));
    console.log(`  rolled back ${rows.length} counter(s); readback recorded in ${path.relative(ROOT, file)}`);
    return;
  }

  /* ── DRY RUN / APPLY ──────────────────────────────────────────────────────────────── */
  let counters;
  if (ONE_UID) { const s = await db.collection('productCounters').doc(ONE_UID).get(); counters = s.exists ? [s] : []; }
  else counters = (await db.collection('productCounters').get()).docs;

  const rows = [];
  for (const d of counters) {
    const before = d.data() || {};
    const uid = d.id;
    const [res, actual] = await Promise.all([resolveMaxProducts(uid), actualCounts(uid)]);
    const catalogMax = res.max;
    const currentMax = typeof before.maxProducts === 'number' ? before.maxProducts : null;
    const actualN = Math.max(actual.bySellerUid || 0, actual.byShopId || 0);
    let target = catalogMax;
    if (currentMax === -1 || catalogMax === -1) target = -1;
    else if (currentMax != null && currentMax > catalogMax) target = currentMax;
    const floor = (target !== -1 && actualN > target) ? actualN : (typeof before.grandfatheredFloor === 'number' ? before.grandfatheredFloor : null);
    const effective = (target !== -1 && typeof floor === 'number' && floor > target) ? floor : target;
    const already = before.migrationVersion === VERSION && before.maxProducts === effective && (floor == null || before.grandfatheredFloor === floor);
    const reduces = currentMax != null && currentMax !== -1 && effective !== -1 && effective < currentMax;
    rows.push({
      uid, plan: res.status, source: res.source, catalogVersion: res.catalogVersion,
      before: { maxProducts: currentMax, grandfatheredFloor: before.grandfatheredFloor ?? null, catalogVersion: before.catalogVersion ?? null, count: before.count ?? null, migrationVersion: before.migrationVersion ?? null },
      actual, actualN, catalogMax, target: effective, grandfatheredFloor: floor,
      countDrift: typeof before.count === 'number' ? before.count - actualN : null,
      action: reduces ? 'REFUSE (would reduce)' : already ? 'skip (already migrated)' : 'write',
      written: false, readback: null,
    });
  }
  const sellers = new Set();
  const prodSnap = await db.collection('products').select('sellerUid', 'shopId').limit(5000).get();
  prodSnap.forEach((p) => { const x = p.data(); if (x.sellerUid) sellers.add(x.sellerUid); if (x.shopId) sellers.add(x.shopId); });
  const noCounter = [...sellers].filter((u) => !counters.some((c) => c.id === u));

  console.log('  uid                    plan/status  cat.max  current  actual(seller/shop)  count  drift  → target  floor  action');
  for (const r of rows) {
    console.log(`  ${r.uid.slice(0, 22).padEnd(22)} ${String(r.plan).slice(0, 12).padEnd(12)} ${fmt(r.catalogMax).padStart(7)}  ${fmt(r.before.maxProducts).padStart(7)}  ${String(r.actual.bySellerUid).padStart(6)}/${String(r.actual.byShopId).padEnd(11)} ${fmt(r.before.count).padStart(5)}  ${String(r.countDrift ?? '—').padStart(5)}  → ${fmt(r.target).padStart(6)}  ${fmt(r.grandfatheredFloor).padStart(5)}  ${r.action}`);
  }
  const toWrite = rows.filter((r) => r.action === 'write');
  console.log(`\n  counters: ${rows.length} · to write: ${toWrite.length} · skip: ${rows.filter((r) => r.action.startsWith('skip')).length} · refuse: ${rows.filter((r) => r.action.startsWith('REFUSE')).length}`);
  console.log(`  sellers with products but NO counter (canPublishProduct resolves them canonically; not created here): ${noCounter.length}`);
  const drift = rows.filter((r) => r.countDrift !== null && r.countDrift !== 0);
  if (drift.length) console.log(`  COUNT DRIFT on ${drift.length} counter(s) — the stored count disagrees with products; this script never writes count (see recount-product-counters.js).`);
  if (rows.some((r) => r.action.startsWith('REFUSE'))) { console.error('  a write would REDUCE a ceiling — refusing the whole run.'); process.exit(3); }

  if (APPLY) {
    for (const r of toWrite) {
      const patch = {
        maxProducts: r.target, catalogMax: r.catalogMax, catalogVersion: r.catalogVersion ?? null,
        migrationVersion: VERSION, migratedAt: F.serverTimestamp(), migratedBy: AUTH, migrationBefore: r.before,
      };
      if (typeof r.grandfatheredFloor === 'number') patch.grandfatheredFloor = r.grandfatheredFloor;
      await db.collection('productCounters').doc(r.uid).set(patch, { merge: true });
      r.written = true;
    }
    /* post-write readback of EVERY counter in scope, written or not */
    let readbackOk = 0, readbackBad = 0;
    for (const r of rows) {
      r.readback = await readCounter(r.uid);
      const good = r.readback && r.readback.maxProducts === r.target && (!r.written || r.readback.migrationVersion === VERSION)
        && (r.grandfatheredFloor == null || r.readback.grandfatheredFloor === r.grandfatheredFloor)
        && (r.before.maxProducts == null || r.target === -1 || r.readback.maxProducts >= r.before.maxProducts);
      good ? readbackOk++ : readbackBad++;
    }
    console.log(`  wrote ${toWrite.length} counter(s), authorized by ${AUTH} · readback: ${readbackOk} match, ${readbackBad} differ`);
  }

  const file = evidencePath(APPLY ? 'apply' : 'dryrun');
  fs.writeFileSync(file, JSON.stringify({ version: VERSION, mode, project: PROJECT, emulated: EMULATED, at: ts(), authorizedBy: AUTH,
    catalog: { FREE: catalog.PLANS.FREE.listingLimit, PROFESSIONAL: catalog.PLANS.PROFESSIONAL.listingLimit, BUSINESS: catalog.PLANS.BUSINESS.listingLimit, ENTERPRISE: catalog.PLANS.ENTERPRISE.listingLimit },
    identities: rows.map((r) => r.uid), rows, sellersWithoutCounter: noCounter.length }, null, 2));
  console.log(`  evidence: ${path.relative(ROOT, file)}${APPLY ? '' : '  (no writes were made)'}`);
  process.exit(0);
})().catch((e) => { console.error('  FAILED', e.message); process.exit(1); });
