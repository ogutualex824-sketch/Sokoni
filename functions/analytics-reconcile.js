'use strict';

/* ============================================================================
   SOKONI — Analytics Reconciliation (R1.x Phase 5, the analytics release gate)

   Computes canonical GROUND TRUTH from the authoritative source collections and
   compares it to the live analytics aggregate. Any mismatch beyond threshold is
   written to reconciliationAlerts. This is the parity proof that lets dashboards
   trust `analytics/global`.

   Ground-truth sources (the same exactly-once records the money path writes):
     settledOrders / platformRevenue / sellerEarnings ← `settlements/*` (one doc
        per settled order: status='settled', commissionCents, netShillingsCredited)
     deliveries / riderEarnings                       ← `deliveryFees` (status='credited', riderFeeKES)
     paidOrders                                       ← `orders` where _apPaidCounted==true

   Read-only by default (safe against the frozen money engine). `backfillAnalytics`
   is an EXPLICIT admin action that recomputes analytics/global from truth — run it
   at a quiet moment (it sets absolute values, which races live increments).
============================================================================ */

const admin = require('firebase-admin');

const SCAN_CAP = 50000; // soft cap; log if exceeded (pre-launch volumes are well under this)

async function _sumCollection(db, coll, whereField, whereVal, reducer) {
  let q = db.collection(coll);
  if (whereField) q = q.where(whereField, '==', whereVal);
  const snap = await q.limit(SCAN_CAP).get();
  const capped = snap.size >= SCAN_CAP;
  const acc = {};
  snap.forEach((d) => reducer(acc, d.data() || {}));
  return { acc, count: snap.size, capped };
}

/** Compute canonical truth and diff it against analytics/global. Returns the report;
 *  writes analytics/reconciliation (latest) + a reconciliationAlerts doc on drift. */
async function computeReconciliation(db) {
  const FV = admin.firestore.FieldValue;

  /* settlements → settledOrders, platformRevenue (commission), sellerEarnings */
  const settle = await _sumCollection(db, 'settlements', 'status', 'settled', (a, s) => {
    a.count = (a.count || 0) + 1;
    a.commissionCents = (a.commissionCents || 0) + Number(s.commissionCents || 0);
    a.netShillings = (a.netShillings || 0) + Number(s.netShillingsCredited || 0);
  });

  /* deliveryFees credited → deliveries, riderEarnings */
  const del = await _sumCollection(db, 'deliveryFees', 'status', 'credited', (a, d) => {
    a.count = (a.count || 0) + 1;
    a.rider = (a.rider || 0) + Math.round(Number(d.riderFeeKES || 0));
  });

  /* paidOrders (marker) — count() aggregation; tolerate a missing index */
  let paidOrders = null;
  try {
    const c = await db.collection('orders').where('_apPaidCounted', '==', true).count().get();
    paidOrders = c.data().count;
  } catch (_) { paidOrders = null; /* needs a single-field index on _apPaidCounted */ }

  const truth = {
    settledOrders:            settle.acc.count || 0,
    platformRevenueShillings: Math.round((settle.acc.commissionCents || 0) / 100),
    sellerEarningsShillings:  settle.acc.netShillings || 0,
    deliveries:               del.acc.count || 0,
    riderEarningsShillings:   del.acc.rider || 0,
  };
  if (paidOrders !== null) truth.paidOrders = paidOrders;

  const g = (await db.doc('analytics/global').get()).data() || {};
  const live = {}, drift = {}; const mismatches = []; let maxDriftPct = 0;
  for (const k of Object.keys(truth)) {
    const t = Number(truth[k]);
    const l = Number(g[k] || 0);
    live[k] = l;
    const diff = l - t;
    drift[k] = { truth: t, live: l, diff };
    if (diff !== 0) {
      mismatches.push(k);
      const pct = t ? Math.abs(diff) / t * 100 : (l ? 100 : 0);
      if (pct > maxDriftPct) maxDriftPct = pct;
    }
  }

  const capped = settle.capped || del.capped;
  const report = {
    truth, live, drift, mismatches,
    maxDriftPct: Math.round(maxDriftPct * 100) / 100,
    ok: mismatches.length === 0,
    capped, note: capped ? `SCAN CAPPED at ${SCAN_CAP} — totals are a LOWER BOUND` : null,
    at: FV.serverTimestamp(),
  };
  await db.doc('analytics/reconciliation').set(report, { merge: true });

  /* Alert on drift beyond 1% (or any capped scan). Deterministic-ish id by day so a daily run
     overwrites rather than spamming. */
  if (mismatches.length && maxDriftPct > 1) {
    const day = new Date().toISOString().slice(0, 10);
    await db.collection('reconciliationAlerts').doc(`analytics_${day}`).set({
      ...report, severity: maxDriftPct > 10 ? 'high' : 'medium',
    }, { merge: true }).catch(() => {});
  }
  return report;
}

/** ADMIN-ONLY, EXPLICIT: recompute analytics/global from canonical truth. Sets absolute values,
 *  so run at a quiet moment (it can race live increments). Use to seed history or repair drift. */
async function backfillAnalytics(db) {
  const r = await computeReconciliation(db);
  const FV = admin.firestore.FieldValue;
  await db.doc('analytics/global').set(
    Object.assign({}, r.truth, { backfilledAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() }),
    { merge: true }
  );
  return { seeded: r.truth, priorDrift: r.drift };
}

module.exports = { computeReconciliation, backfillAnalytics };
