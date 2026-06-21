/* ═══════════════════════════════════════════════════════════════════
   SOKONI INVENTORY V2 — Health Score Engine
   Calculates, stores, and alerts on Inventory Health Scores.
   Score components: turnover, stock-out rate, low-stock rate,
   shrinkage, forecast accuracy, supplier reliability.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, onSchedule, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated }  = require('firebase-functions/v2/firestore');
const { onSchedule: sched }  = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

const { assertAuth } = require('./shared/errors');

const CF_OPTS = { region: 'us-central1', memory: '512MiB', timeoutSeconds: 120 };

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

/* ── Calculate health score for a single tenant ─────────────────── */
async function _calcHealthScore(tenantId) {
  const [products, levelsSnap, movSnap, alertsSnap] = await Promise.all([
    db.collection(`tenants/${tenantId}/inventory_products`).where('active', '==', true).limit(500).get(),
    db.collection(`tenants/${tenantId}/inventory_levels`).limit(1000).get(),
    db.collection(`tenants/${tenantId}/inventory_movements`)
      .where('ts', '>=', new Date(Date.now() - 30 * 86_400_000))
      .limit(5000).get(),
    db.collection(`tenants/${tenantId}/inventory_alerts`).where('resolved', '==', false).limit(200).get(),
  ]);

  const prods   = products.docs.map(d => ({ id: d.id, ...d.data() }));
  const levels  = levelsSnap.docs.map(d => d.data());
  const moves   = movSnap.docs.map(d => d.data());
  const alerts  = alertsSnap.docs.map(d => d.data());

  const total   = prods.length || 1;
  const oos     = levels.filter(l => (l.available || 0) <= 0).length;
  const lowMap  = new Map(prods.map(p => [p.id, p.reorderPoint || 5]));
  const low     = levels.filter(l => {
    const rp = lowMap.get(l.productId) || 5;
    return l.available > 0 && l.available <= rp;
  }).length;

  const sales   = moves.filter(m => m.type === 'sale');
  const damage  = moves.filter(m => m.type === 'damage' || m.type === 'write_off' || m.type === 'theft');
  const adj     = moves.filter(m => m.type === 'adjustment' || m.type === 'count_adjust');

  const turnoverScore   = Math.min(100, (sales.length / total) * 8);
  const outstockScore   = Math.max(0, 100 - (oos / total) * 200);
  const lowstockScore   = Math.max(0, 100 - (low / total) * 150);
  const shrinkageScore  = Math.max(0, 100 - (damage.length / Math.max(sales.length + 1, 1)) * 400);
  const accuracyScore   = Math.max(0, 100 - (adj.length / Math.max(moves.length + 1, 1)) * 200);

  /* Supplier reliability from PO history */
  let supplierScore = 80;
  try {
    const pos = await db.collection(`tenants/${tenantId}/inventory_purchaseOrders`)
      .where('status', '==', 'received')
      .orderBy('receivedAt', 'desc')
      .limit(20).get();
    if (!pos.empty) {
      const lateCount = pos.docs.filter(d => {
        const po = d.data();
        return po.receivedAt?.toMillis?.() > (po.expectedAt?.toMillis?.() || 0);
      }).length;
      supplierScore = Math.max(0, 100 - (lateCount / pos.size) * 100);
    }
  } catch (_) {}

  const score = Math.round(
    turnoverScore   * 0.20 +
    outstockScore   * 0.25 +
    lowstockScore   * 0.20 +
    shrinkageScore  * 0.15 +
    accuracyScore   * 0.10 +
    supplierScore   * 0.10
  );

  const grade   = score >= 90 ? 'A+' : score >= 80 ? 'A' : score >= 70 ? 'B' : score >= 60 ? 'C' : score >= 50 ? 'D' : 'F';
  const color   = score >= 80 ? '#71ff00' : score >= 60 ? '#ffb800' : '#ff3b3b';
  const risks   = [];
  if (oos > total * 0.1)    risks.push(`${oos} products out of stock (${Math.round(oos/total*100)}%)`);
  if (low > total * 0.2)    risks.push(`${low} products below reorder point`);
  if (shrinkageScore < 60)  risks.push('High shrinkage rate — check damage/theft logs');
  if (supplierScore < 70)   risks.push('Supplier delivery reliability issues');

  const recommendations = [];
  if (oos > 0)              recommendations.push('Review and reorder out-of-stock products');
  if (low > 0)              recommendations.push(`Create purchase orders for ${low} low-stock products`);
  if (turnoverScore < 50)   recommendations.push('Slow inventory turnover — consider promotions');
  if (accuracyScore < 70)   recommendations.push('Frequent stock count adjustments suggest counting errors');

  return {
    tenantId, score, grade, color,
    breakdown: { turnoverScore, outstockScore, lowstockScore, shrinkageScore, accuracyScore, supplierScore },
    counts: { total, oos, low, sales: sales.length, damage: damage.length, alerts: alerts.length },
    risks, recommendations,
    calculatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

/* ── Cloud Functions ─────────────────────────────────────────────── */

exports.inventoryCalculateHealth = onCall(CF_OPTS, async req => {
  const { tenantId } = req.data;
  const uid = assertAuth(req);
  const resolvedTenant = tenantId || uid;

  const health = await _calcHealthScore(resolvedTenant);

  /* Store snapshot */
  const batch = db.batch();
  const docRef = db.doc(`tenants/${resolvedTenant}/inventory_health/current`);
  batch.set(docRef, health, { merge: true });
  const histRef = db.collection(`tenants/${resolvedTenant}/inventory_health_history`).doc();
  batch.set(histRef, health);
  await batch.commit();

  return health;
});

exports.inventoryGetHealthHistory = onCall(CF_OPTS, async req => {
  const { tenantId, days = 30 } = req.data;
  const uid = assertAuth(req);
  const resolvedTenant = tenantId || uid;
  const cutoff = new Date(Date.now() - days * 86_400_000);

  const snap = await db.collection(`tenants/${resolvedTenant}/inventory_health_history`)
    .where('calculatedAt', '>=', cutoff)
    .orderBy('calculatedAt', 'asc')
    .limit(100).get();

  return { history: snap.docs.map(d => d.data()), tenantId: resolvedTenant };
});

/* ── Scheduled: auto-calculate every 6 hours for all tenants ──── */
exports.inventoryHealthMonitor = sched({
  ...CF_OPTS,
  schedule: 'every 6 hours',
  timeZone: 'Africa/Nairobi',
}, async () => {
  const tenantsSnap = await db.collectionGroup('inventory_products').select([]).limit(200).get();
  const tenantIds   = [...new Set(tenantsSnap.docs.map(d => d.ref.path.split('/')[1]))];

  for (const tenantId of tenantIds) {
    try {
      const health = await _calcHealthScore(tenantId);
      await db.doc(`tenants/${tenantId}/inventory_health/current`).set(health);

      /* Alert if score drops significantly */
      const prev = await db.collection(`tenants/${tenantId}/inventory_health_history`)
        .orderBy('calculatedAt', 'desc').limit(2).get();

      if (prev.size >= 2) {
        const [latest, prior] = prev.docs.map(d => d.data());
        if (prior.score - latest.score > 10) {
          await db.collection(`tenants/${tenantId}/inventory_alerts`).add({
            type      : 'health_drop',
            severity  : 'HIGH',
            title     : `Inventory Health Score dropped ${prior.score - latest.score} points`,
            body      : `Score fell from ${prior.score} to ${latest.score} (${prior.grade} → ${latest.grade})`,
            risks     : latest.risks,
            resolved  : false,
            createdAt : admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }
    } catch (err) {
      console.error(`Health score failed for tenant ${tenantId}:`, err.message);
    }
  }
});
