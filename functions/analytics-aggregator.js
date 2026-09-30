'use strict';

/* ============================================================================
   SOKONI — Canonical Analytics Aggregator (single source of truth)

   ONE place that maintains the canonical analytics documents every dashboard
   reads, so Admin / Seller / Finance / POS / Rider / Buyer / KASS all show the
   SAME numbers. Instead of each page scanning thousands of orders, the platform's
   authoritative, exactly-once event points (order paid, settled, delivered) apply
   atomic increments here.

   Canonical documents (all shillings, KES):
     analytics/global                      — lifetime, platform-wide
     analytics/daily_YYYY-MM-DD            — per-day bucket, platform-wide
     shops/{shopId}/analytics/summary      — lifetime, per shop
     shops/{shopId}/analytics/daily_YYYY-MM-DD — per-day bucket, per shop

   Design rules (learned from the money-path work this session):
     • FieldValue.increment is contention-free (no read) → no transaction needed,
       and a hot analytics/global doc never blocks under load.
     • Callers MUST invoke bumpAnalytics ONLY from exactly-once event points
       (settleOrder 'settled', the guarded rider credit) or via claimPaidCount,
       so a retried/duplicate event can never double-count.
     • Platform fee/revenue is ALWAYS the canonical commission from the settlement
       engine — never a hardcoded percentage on a dashboard.
     • Fire-and-forget: an analytics hiccup must never block the money path.
============================================================================ */

const admin = require('firebase-admin');

/** Apply atomic increments to the canonical analytics aggregates: global lifetime +
 *  today's global bucket, and (when shopId is given) the shop-scoped equivalents.
 *  @param {FirebaseFirestore.Firestore} db
 *  @param {{shopId?:string, incr:Object<string,number>}} opts */
async function bumpAnalytics(db, { shopId, branchId, incr } = {}) {
  if (!incr || !Object.keys(incr).length) return;
  const FV  = admin.firestore.FieldValue;
  const now = FV.serverTimestamp();
  const day = new Date().toISOString().slice(0, 10); // server time in a CF — fine
  const payload = (extra) => {
    const o = {};
    for (const k of Object.keys(incr)) {
      const v = Number(incr[k]);
      if (Number.isFinite(v) && v !== 0) o[k] = FV.increment(v);
    }
    return Object.assign(o, { updatedAt: now }, extra || {});
  };
  const tasks = [
    db.doc('analytics/global').set(payload(), { merge: true }),
    db.doc(`analytics/daily_${day}`).set(payload({ date: day, scope: 'global' }), { merge: true }),
  ];
  if (shopId) {
    tasks.push(db.doc(`shops/${shopId}/analytics/summary`).set(payload({ shopId }), { merge: true }));
    tasks.push(db.doc(`shops/${shopId}/analytics/daily_${day}`).set(payload({ shopId, date: day }), { merge: true }));
  }
  /* Enterprise: per-branch analytics for multi-location merchants (populated when an order carries a
     branchId — POS / click-and-collect). Consolidated view = the shop summary above; per-branch = here. */
  if (branchId) {
    tasks.push(db.doc(`branches/${branchId}/analytics/summary`).set(payload({ branchId, shopId: shopId || null }), { merge: true }));
    tasks.push(db.doc(`branches/${branchId}/analytics/daily_${day}`).set(payload({ branchId, date: day }), { merge: true }));
  }
  await Promise.allSettled(tasks);
}

/** Exactly-once claim that an order's paid-count has not been tallied yet. Handles BOTH
 *  order-creation-at-paid (onNewOrderCreated) and a later pending→paid transition
 *  (onOrderStatusChange) via a persistent marker on the order, so the two triggers can
 *  never both count the same order. Returns the order data on the FIRST claim, null after.
 *  @returns {Promise<Object|null>} */
async function claimPaidCount(db, orderId) {
  const ref = db.doc(`orders/${orderId}`);
  return db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (!s.exists) return null;
    const d = s.data() || {};
    if (d._apPaidCounted === true) return null;               // already tallied
    if (d.status !== 'paid' && d.paymentVerified !== true) return null; // not paid yet
    t.update(ref, { _apPaidCounted: true });
    return d;
  }).catch(() => null);
}

/** Gross-merchandise shillings for an order = total − delivery fee (delivery is the rider's,
 *  not merchandise). Mirrors order-settlement's _grossCents so GMV and settled revenue agree. */
function grossShillings(order) {
  const total = Number(order.orderTotal ?? order.total ?? 0);
  const delivery = Number(order.deliveryFee ?? 0);
  return Math.max(0, Math.round(total - delivery));
}

/* ── R1.x Phase 4b: dimensional aggregation ──
   On a PAID order (called from the marker-guarded paid hook, so exactly-once), fan the order out
   across the dimensions dashboards need: peak sales hour, per-customer (CLV/repeat), per-product
   (top products) and per-category (best categories). Increment-only, contention-free.

   Docs (top-level so the path stays valid; admin-read rules mirror analytics/*):
     analytics/hourly_sales               { hHH_orders, hHH_gmv }   (UTC hour buckets)
     users/{buyerUid}/analytics/summary   { orders, spendShillings, lastOrderAt }
     productAnalytics/{productId}         { unitsSold, revenueShillings, name }
     categoryAnalytics/{catKey}           { unitsSold, revenueShillings, category } */
async function bumpOrderDimensions(db, order) {
  if (!order) return;
  const FV = admin.firestore.FieldValue;
  const now = FV.serverTimestamp();
  const hour = new Date().getUTCHours();            // server (UTC); EAT = +3
  const gross = grossShillings(order);
  const tasks = [];

  tasks.push(db.doc('analytics/hourly_sales').set(
    { [`h${hour}_orders`]: FV.increment(1), [`h${hour}_gmv`]: FV.increment(gross), updatedAt: now },
    { merge: true }));

  const buyer = order.buyerUid || order.uid || null;
  if (buyer) tasks.push(db.doc(`users/${buyer}/analytics/summary`).set(
    { orders: FV.increment(1), spendShillings: FV.increment(gross), lastOrderAt: now, updatedAt: now },
    { merge: true }));

  const items = Array.isArray(order.items) ? order.items : [];
  for (const it of items) {
    const pid = it.productId || it.id;
    if (!pid) continue;
    const qty = Math.max(1, Number(it.qty ?? it.quantity ?? 1));
    const rev = Math.round((Number(it.price) || 0) * qty);
    tasks.push(db.doc(`productAnalytics/${String(pid)}`).set(
      { productId: String(pid), name: it.name || null, unitsSold: FV.increment(qty), revenueShillings: FV.increment(rev), updatedAt: now },
      { merge: true }));
    const cat = it.category || order.category;
    if (cat) {
      const key = String(cat).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60) || 'uncategorised';
      tasks.push(db.doc(`categoryAnalytics/${key}`).set(
        { category: String(cat), unitsSold: FV.increment(qty), revenueShillings: FV.increment(rev), updatedAt: now },
        { merge: true }));
    }
  }
  await Promise.allSettled(tasks);
}

/** Peak delivery hour bucket — called from the (exactly-once) delivered credit. */
async function bumpDeliveryHour(db) {
  const FV = admin.firestore.FieldValue;
  const hour = new Date().getUTCHours();
  await db.doc('analytics/hourly_delivery').set(
    { [`h${hour}_deliveries`]: FV.increment(1), updatedAt: FV.serverTimestamp() },
    { merge: true }
  ).catch(() => {});
}

module.exports = { bumpAnalytics, claimPaidCount, grossShillings, bumpOrderDimensions, bumpDeliveryHour };
