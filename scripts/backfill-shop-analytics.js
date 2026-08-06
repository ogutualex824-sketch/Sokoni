#!/usr/bin/env node
'use strict';
/**
 * Per-shop analytics backfill — populate shops/{uid}/analytics/summary from canonical orders.
 *
 * WHY THIS EXISTS
 * The Analytics Engine maintains shops/{uid}/analytics/summary going FORWARD via atomic
 * increments (functions/analytics-aggregator.js bumpAnalytics) on each paid/settled order.
 * The reconciliation path (functions/analytics-reconcile.js) only recomputes the PLATFORM
 * aggregate analytics/global — it never (re)builds the per-shop summaries. So a shop whose
 * orders predate the engine (or any gap) has no per-shop summary, and the seller dashboard
 * (which reads shops/{uid}/analytics/summary) shows zero even when orders exist.
 *
 * This script closes that gap: it recomputes each shop's headline aggregates from the orders
 * collection and SETS them (absolute, merge) so the values are idempotent under re-run. It
 * writes ONLY the two order-truth fields (paidOrders, gmvShillings) plus provenance markers —
 * it does NOT invent commission/settlement figures (those are maintained by the settlement
 * path going forward). Live increments compose correctly on top of the SET baseline because
 * historical orders never transition again.
 *
 * CANONICAL DEFINITIONS (mirror the live engine)
 *   paid order  : reached PAID or any downstream state (confirmed/rider_assigned/…/delivered/
 *                 completed). Excludes pending_payment / cancelled / refunded / failed.
 *   gmvShillings: Σ max(0, round((orderTotal ?? total) - deliveryFee))  — merchandise only.
 *
 * USAGE
 *   node scripts/backfill-shop-analytics.js                 # DRY-RUN, all shops (no writes)
 *   node scripts/backfill-shop-analytics.js --shop=<uid>    # DRY-RUN, one shop
 *   node scripts/backfill-shop-analytics.js --commit        # WRITE all shops
 *   node scripts/backfill-shop-analytics.js --shop=<uid> --commit   # WRITE one shop
 *
 * Auth: Application Default Credentials (same as the other repo admin/backfill scripts).
 */
const admin = require('firebase-admin');
try { admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'sokoni-aeb26' }); } catch (_) {}
const db = admin.firestore();
const FV = admin.firestore.FieldValue;

const args    = process.argv.slice(2);
const COMMIT  = args.includes('--commit');
const shopArg = (args.find(a => a.startsWith('--shop=')) || '').split('=')[1] || null;

const NOT_PAID = new Set(['pending_payment', 'pending', 'awaiting_payment', 'cancelled', 'refunded', 'failed', 'expired']);
const isPaid = (o) => o._apPaidCounted === true || !NOT_PAID.has(String(o.status || ''));
const gross  = (o) => Math.max(0, Math.round(Number(o.orderTotal ?? o.total ?? 0) - Number(o.deliveryFee ?? 0)));

(async () => {
  const snap = await db.collection('orders').get();
  const byShop = new Map();
  let noSeller = 0;
  snap.forEach((d) => {
    const o = d.data();
    const uid = o.sellerUid || o.sellerId || null;
    if (!uid) { noSeller++; return; }
    if (shopArg && uid !== shopArg) return;
    const rec = byShop.get(uid) || { paidOrders: 0, gmvShillings: 0, orders: 0 };
    rec.orders++;
    if (isPaid(o)) { rec.paidOrders++; rec.gmvShillings += gross(o); }
    byShop.set(uid, rec);
  });

  console.log(`\nScanned ${snap.size} orders · ${byShop.size} shop(s)${shopArg ? ' (filtered)' : ''} · ${noSeller} w/o sellerUid`);
  console.log(`Mode: ${COMMIT ? 'COMMIT (writing)' : 'DRY-RUN (no writes)'}\n`);

  let written = 0;
  for (const [uid, r] of byShop) {
    console.log(`  ${uid}  ->  paidOrders=${r.paidOrders}  gmvShillings=KES ${r.gmvShillings.toLocaleString()}  (of ${r.orders} orders)`);
    if (COMMIT) {
      await db.doc(`shops/${uid}/analytics/summary`).set({
        shopId: uid,
        paidOrders: r.paidOrders,
        gmvShillings: r.gmvShillings,
        _backfilledAt: FV.serverTimestamp(),
        _backfillSource: 'orders',
        updatedAt: FV.serverTimestamp(),
      }, { merge: true });
      written++;
    }
  }

  console.log(`\n${COMMIT ? `✅ Wrote ${written} shop summary doc(s).` : 'ℹ️  Dry-run only — re-run with --commit to write.'}`);
  process.exit(0);
})().catch((e) => { console.error('BACKFILL ERROR:', e.message); process.exit(1); });
