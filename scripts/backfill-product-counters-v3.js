#!/usr/bin/env node
'use strict';
/**
 * FREE-50 rollout — productCounters ceilings onto catalogue v3 (owner ruling 2026-09-08, c1d8ea1:
 * FREE 50 / PROFESSIONAL 100 / BUSINESS & ENTERPRISE unlimited).
 *
 *   DRY RUN (default)   reads only; prints the plan and writes an evidence file
 *   --apply             performs the minimum writes, ONLY with --authorized-by "<name>"
 *   --rollback <file>   restores every counter to the `before` values recorded in an evidence file
 *
 * RULES (owner brief 2026-09-30)
 *   • identify every affected merchant: every productCounters document PLUS every uid that owns
 *     products but has no counter (they resolve canonically already; listed for completeness)
 *   • actual listing count is measured from `products` (sellerUid, and shopId as a cross-check),
 *     never from the counter — the counter's `count` is reported, and drift is flagged, not fixed
 *   • never reduce an entitlement: target = max(catalogue ceiling, current maxProducts);
 *     a merchant already above the catalogue ceiling gets grandfatheredFloor = actual count
 *   • never manufacture listings: `count` is never written by this script
 *   • idempotent: a counter already carrying migrationVersion === VERSION with equal values is skipped
 *   • every write records migrationVersion, migratedAt, migratedBy, and the before values
 *   • evidence: docs/backups/free50-<mode>-<timestamp>.json (before/after per uid)
 *
 * The ceiling itself comes from product-limit.resolveMaxProducts — the same resolution
 * canPublishProduct uses — so this script holds no number of its own.
 */
const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const admin = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin'));

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const ROLLBACK = ARGS.includes('--rollback') ? ARGS[ARGS.indexOf('--rollback') + 1] : null;
const AUTH = ARGS.includes('--authorized-by') ? ARGS[ARGS.indexOf('--authorized-by') + 1] : null;
const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
const VERSION = 'catalog-v3-free50-2026-09-30';

if (APPLY && !AUTH) { console.error('  --apply requires --authorized-by "<owner name>"; refusing.'); process.exit(2); }
if (APPLY && ROLLBACK) { console.error('  --apply and --rollback are exclusive.'); process.exit(2); }

admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
const { resolveMaxProducts } = require(path.join(ROOT, 'functions', 'product-limit'))._internal;
const catalog = require(path.join(ROOT, 'functions', 'subscription-catalog'));
const fmt = (n) => (n === -1 ? 'unlimited' : n == null ? '—' : String(n));

async function actualCounts(uid) {
  const [a, b] = await Promise.all([
    db.collection('products').where('sellerUid', '==', uid).count().get().catch(() => null),
    db.collection('products').where('shopId', '==', uid).count().get().catch(() => null),
  ]);
  return { bySellerUid: a ? a.data().count : null, byShopId: b ? b.data().count : null };
}

(async () => {
  const mode = ROLLBACK ? 'ROLLBACK' : APPLY ? 'APPLY' : 'DRY RUN';
  console.log(`\n  FREE-50 rollout — productCounters → catalogue ${catalog.PLANS.FREE.listingLimit}/${catalog.PLANS.PROFESSIONAL.listingLimit}/${fmt(catalog.PLANS.BUSINESS.listingLimit)}/${fmt(catalog.PLANS.ENTERPRISE.listingLimit)}`);
  console.log(`  project ${PROJECT} · mode ${mode} · migration ${VERSION}\n`);

  if (ROLLBACK) {
    const ev = JSON.parse(fs.readFileSync(ROLLBACK, 'utf8'));
    let n = 0;
    for (const row of ev.rows) {
      if (!row.written) continue;
      await db.collection('productCounters').doc(row.uid).set({
        maxProducts: row.before.maxProducts, grandfatheredFloor: row.before.grandfatheredFloor ?? admin.firestore.FieldValue.delete(),
        catalogVersion: row.before.catalogVersion ?? null, migrationVersion: admin.firestore.FieldValue.delete(),
        rolledBackAt: admin.firestore.FieldValue.serverTimestamp(), rolledBackFrom: VERSION,
      }, { merge: true });
      n++;
    }
    console.log(`  rolled back ${n} counter(s) from ${ROLLBACK}`);
    return;
  }

  const counters = (await db.collection('productCounters').get()).docs;
  const rows = [];
  for (const d of counters) {
    const before = d.data() || {};
    const uid = d.id;
    const [res, actual] = await Promise.all([resolveMaxProducts(uid), actualCounts(uid)]);
    const catalogMax = res.max;
    const currentMax = typeof before.maxProducts === 'number' ? before.maxProducts : null;
    const actualN = Math.max(actual.bySellerUid || 0, actual.byShopId || 0);
    /* never reduce; unlimited (-1) wins over any number */
    let target = catalogMax;
    if (currentMax === -1 || catalogMax === -1) target = -1;
    else if (currentMax != null && currentMax > catalogMax) target = currentMax;
    const floor = (target !== -1 && actualN > target) ? actualN : (before.grandfatheredFloor ?? null);
    const effective = (target !== -1 && typeof floor === 'number' && floor > target) ? floor : target;
    const already = before.migrationVersion === VERSION && before.maxProducts === effective;
    const change = currentMax !== effective || (floor != null && before.grandfatheredFloor !== floor);
    rows.push({
      uid, plan: res.status, source: res.source, catalogVersion: res.catalogVersion,
      before: { maxProducts: currentMax, grandfatheredFloor: before.grandfatheredFloor ?? null, catalogVersion: before.catalogVersion ?? null, count: before.count ?? null },
      actual, actualN, catalogMax, target: effective, grandfatheredFloor: floor,
      countDrift: typeof before.count === 'number' ? before.count - actualN : null,
      action: already ? 'skip (already migrated)' : change ? (currentMax != null && effective !== -1 && effective < currentMax ? 'REFUSE (would reduce)' : 'write') : 'no change (stamp version only)',
      written: false,
    });
  }
  /* sellers with products but no counter — resolve canonically already; listed, never created here */
  const sellers = new Set();
  const prodSnap = await db.collection('products').select('sellerUid', 'shopId').limit(2000).get();
  prodSnap.forEach((p) => { const x = p.data(); if (x.sellerUid) sellers.add(x.sellerUid); if (x.shopId) sellers.add(x.shopId); });
  const noCounter = [...sellers].filter((u) => !counters.some((c) => c.id === u));

  console.log('  uid            plan/status     cat.max  current  actual(seller/shop)  count  drift  → target  floor  action');
  for (const r of rows) {
    console.log(`  ${r.uid.slice(0, 14).padEnd(14)} ${String(r.plan).slice(0, 15).padEnd(15)} ${fmt(r.catalogMax).padStart(7)}  ${fmt(r.before.maxProducts).padStart(7)}  ${String(r.actual.bySellerUid).padStart(6)}/${String(r.actual.byShopId).padEnd(11)} ${fmt(r.before.count).padStart(5)}  ${String(r.countDrift ?? '—').padStart(5)}  → ${fmt(r.target).padStart(6)}  ${fmt(r.grandfatheredFloor).padStart(5)}  ${r.action}`);
  }
  console.log(`\n  counters: ${rows.length} · to write: ${rows.filter((r) => r.action === 'write').length} · skip: ${rows.filter((r) => r.action.startsWith('skip')).length} · refuse: ${rows.filter((r) => r.action.startsWith('REFUSE')).length}`);
  console.log(`  sellers with products but NO counter (resolve canonically via canPublishProduct; not created here): ${noCounter.length}`);
  const drift = rows.filter((r) => r.countDrift !== null && r.countDrift !== 0);
  if (drift.length) console.log(`  COUNT DRIFT on ${drift.length} counter(s) — the stored count disagrees with products; this script never writes count (see recount-product-counters.js).`);

  if (APPLY) {
    for (const r of rows) {
      if (r.action !== 'write' && r.action !== 'no change (stamp version only)') continue;
      const patch = {
        maxProducts: r.target, catalogMax: r.catalogMax, catalogVersion: r.catalogVersion ?? null,
        migrationVersion: VERSION, migratedAt: admin.firestore.FieldValue.serverTimestamp(), migratedBy: AUTH,
        migrationBefore: r.before,
      };
      if (typeof r.grandfatheredFloor === 'number') patch.grandfatheredFloor = r.grandfatheredFloor;
      await db.collection('productCounters').doc(r.uid).set(patch, { merge: true });
      r.written = true;
    }
    console.log(`  wrote ${rows.filter((r) => r.written).length} counter(s), authorized by ${AUTH}`);
  }

  const outDir = path.join(ROOT, 'docs', 'backups');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `free50-${APPLY ? 'apply' : 'dryrun'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ version: VERSION, mode, project: PROJECT, at: new Date().toISOString(), authorizedBy: AUTH, catalog: { FREE: catalog.PLANS.FREE.listingLimit, PROFESSIONAL: catalog.PLANS.PROFESSIONAL.listingLimit, BUSINESS: catalog.PLANS.BUSINESS.listingLimit, ENTERPRISE: catalog.PLANS.ENTERPRISE.listingLimit }, rows, sellersWithoutCounter: noCounter.length }, null, 2));
  console.log(`  evidence: ${path.relative(ROOT, file)}${APPLY ? '' : '  (no writes were made)'}`);
  process.exit(0);
})().catch((e) => { console.error('  FAILED', e.message); process.exit(1); });
