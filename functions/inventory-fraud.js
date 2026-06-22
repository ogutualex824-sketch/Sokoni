/* ═══════════════════════════════════════════════════════════════════
   SOKONI INVENTORY V2 — Fraud & Loss Prevention Engine
   Real-time fraud scoring, anomaly detection, forensic reporting.
   Detects: theft, ghost inventory, duplicate returns, bulk adjustments,
   off-hours movements, employee collusion patterns.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated }  = require('firebase-functions/v2/firestore');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const { assertAuth } = require('./shared/errors');

const CF_OPTS = { region: 'us-central1', memory: '512MiB', timeoutSeconds: 120 };

const FRAUD_RULES = [
  { id: 'large_adjustment',  test: (m, ctx) => m.type === 'adjustment' && Math.abs(m.qty) > (ctx.avgAdj || 10) * 4, score: 35, reason: 'Adjustment quantity 4× above average' },
  { id: 'off_hours',         test: (m)      => { const h = new Date(m.ts?.toMillis?.() || m.ts).getHours(); return h >= 22 || h <= 5; }, score: 20, reason: 'Transaction recorded outside business hours' },
  { id: 'no_reason',         test: (m)      => !m.reason || m.reason.trim().length < 5, score: 15, reason: 'Missing or insufficient reason provided' },
  { id: 'bulk_return',       test: (m)      => m.type === 'return_in' && Math.abs(m.qty) > 15, score: 25, reason: 'Unusually large return quantity' },
  { id: 'bulk_damage',       test: (m)      => (m.type === 'damage' || m.type === 'write_off') && Math.abs(m.qty) > 20, score: 30, reason: 'Large damage or write-off event' },
  { id: 'rapid_movements',   test: (m, ctx) => ctx.recentMovements > 20, score: 20, reason: 'Excessive movement volume in short time window' },
  { id: 'theft_pattern',     test: (m)      => m.type === 'theft', score: 50, reason: 'Recorded theft event' },
  { id: 'negative_stock',    test: (m, ctx) => (ctx.stockAfter || 0) < 0, score: 40, reason: 'Movement resulted in negative stock' },
  { id: 'duplicate_adjust',  test: (m, ctx) => ctx.sameUserSameProduct > 3, score: 25, reason: 'Multiple adjustments for same product by same user' },
  { id: 'supervisor_bypass', test: (m)      => m.type === 'adjustment' && m.supervisorOverride === true, score: 15, reason: 'Supervisor override used for adjustment' },
];

async function _computeFraudScore(movement, tenantId) {
  const productId = movement.productId;
  const userId    = movement.userId;
  const ts        = movement.ts?.toMillis?.() || Date.now();
  const window1h  = new Date(ts - 3_600_000);

  /* Build context */
  const [adjSnap, recentSnap, userSnap, levelSnap] = await Promise.all([
    db.collection(`tenants/${tenantId}/inventory_movements`)
      .where('productId', '==', productId)
      .where('type', '==', 'adjustment')
      .orderBy('ts', 'desc').limit(20).get(),
    db.collection(`tenants/${tenantId}/inventory_movements`)
      .where('productId', '==', productId)
      .where('ts', '>=', window1h).limit(50).get(),
    db.collection(`tenants/${tenantId}/inventory_movements`)
      .where('userId', '==', userId)
      .where('productId', '==', productId)
      .where('ts', '>=', new Date(ts - 86_400_000)).limit(10).get(),
    db.collection(`tenants/${tenantId}/inventory_levels`).where('productId', '==', productId).limit(5).get(),
  ]);

  const adjVals = adjSnap.docs.map(d => Math.abs(d.data().qty || 0));
  const avgAdj  = adjVals.length ? adjVals.reduce((a, b) => a + b, 0) / adjVals.length : 10;
  const totalAfterMove = levelSnap.docs.reduce((s, d) => s + (d.data().available || 0), 0);

  const ctx = {
    avgAdj,
    recentMovements      : recentSnap.size,
    sameUserSameProduct  : userSnap.size,
    stockAfter           : totalAfterMove,
  };

  let totalScore = 0;
  const triggeredRules = [];

  for (const rule of FRAUD_RULES) {
    if (rule.test(movement, ctx)) {
      totalScore += rule.score;
      triggeredRules.push({ id: rule.id, score: rule.score, reason: rule.reason });
    }
  }

  const level = totalScore >= 60 ? 'HIGH' : totalScore >= 30 ? 'MEDIUM' : 'LOW';
  return { score: Math.min(100, totalScore), level, triggeredRules, context: ctx };
}

/* ── Real-time trigger on every new movement ─────────────────────── */
exports.inventoryFraudOnMovement = onDocumentCreated(
  { document: 'tenants/{tenantId}/inventory_movements/{movId}', ...CF_OPTS },
  async event => {
    const movement = event.data?.data();
    if (!movement) return;
    const { tenantId, movId } = event.params;

    /* Only score high-risk movement types */
    const scorableTypes = ['adjustment', 'damage', 'write_off', 'theft', 'return_in', 'count_adjust'];
    if (!scorableTypes.includes(movement.type)) return;

    /* Idempotency: skip if this movement was already scored (CF retry guard) */
    const existingSnap = await db.collection(`tenants/${tenantId}/inventory_fraud_events`)
      .where('movementId', '==', movId).limit(1).get();
    if (!existingSnap.empty) return;

    try {
      const fraud = await _computeFraudScore(movement, tenantId);
      if (fraud.score < 15) return;

      await db.collection(`tenants/${tenantId}/inventory_fraud_events`).add({
        movementId   : movId,
        productId    : movement.productId,
        userId       : movement.userId,
        type         : movement.type,
        qty          : movement.qty,
        fraudScore   : fraud.score,
        fraudLevel   : fraud.level,
        triggeredRules: fraud.triggeredRules,
        status       : 'pending',
        createdAt    : admin.firestore.FieldValue.serverTimestamp(),
      });

      if (fraud.level === 'HIGH') {
        await db.collection(`tenants/${tenantId}/inventory_alerts`).add({
          type     : 'fraud_detected',
          severity : 'HIGH',
          title    : `Potential fraud detected — Score: ${fraud.score}/100`,
          body     : `Movement ${movId} triggered ${fraud.triggeredRules.length} fraud rule(s)`,
          movementId: movId,
          productId: movement.productId,
          rules    : fraud.triggeredRules.map(r => r.reason).join('; '),
          resolved : false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    } catch (err) {
      console.error('Fraud scoring failed:', err.message);
    }
  }
);

/* ── Scheduled: batch fraud scan for pattern detection ────────────── */
exports.inventoryFraudScan = onSchedule({
  ...CF_OPTS,
  schedule: 'every 6 hours',
  timeZone: 'Africa/Nairobi',
}, async () => {
  const cutoff  = new Date(Date.now() - 7_200_000);
  const movSnap = await db.collectionGroup('inventory_movements')
    .where('ts', '>=', cutoff).limit(1000).get();

  /* Group by tenant */
  const byTenant = {};
  movSnap.docs.forEach(d => {
    const tenantId = d.ref.path.split('/')[1];
    if (!byTenant[tenantId]) byTenant[tenantId] = [];
    byTenant[tenantId].push({ id: d.id, ...d.data() });
  });

  /* Check for collusion: multiple users doing large adjustments on same products */
  for (const [tenantId, movements] of Object.entries(byTenant)) {
    const adjByProduct = {};
    movements.filter(m => m.type === 'adjustment').forEach(m => {
      if (!adjByProduct[m.productId]) adjByProduct[m.productId] = new Set();
      adjByProduct[m.productId].add(m.userId);
    });
    for (const [productId, userSet] of Object.entries(adjByProduct)) {
      if (userSet.size >= 3) {
        await db.collection(`tenants/${tenantId}/inventory_alerts`).add({
          type     : 'collusion_pattern',
          severity : 'HIGH',
          title    : 'Possible collusion: 3+ users adjusting same product',
          body     : `Product ${productId} was adjusted by ${userSet.size} different users in 2 hours`,
          productId,
          resolved : false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
      }
    }
  }
});

/* ── API: Get fraud events ───────────────────────────────────────── */
exports.inventoryGetFraudEvents = onCall(CF_OPTS, async req => {
  const uid = assertAuth(req);
  const { tenantId, status = 'pending', limit = 50 } = req.data;
  const resolvedTenant = tenantId || uid;

  let q = db.collection(`tenants/${resolvedTenant}/inventory_fraud_events`)
    .orderBy('createdAt', 'desc').limit(limit);
  if (status !== 'all') q = q.where('status', '==', status);

  const snap = await q.get();
  return { events: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
});

/* ── API: Review fraud event ─────────────────────────────────────── */
exports.inventoryFraudReview = onCall(CF_OPTS, async req => {
  const uid = assertAuth(req);
  const { eventId, decision, notes } = req.data;

  const eventRef = (await db.collectionGroup('inventory_fraud_events')
    .where(admin.firestore.FieldPath.documentId(), '==', eventId).limit(1).get()).docs[0]?.ref;
  if (!eventRef) throw new HttpsError('not-found', 'Fraud event not found');

  await eventRef.update({
    status      : decision,
    reviewedBy  : uid,
    reviewNotes : notes || '',
    reviewedAt  : admin.firestore.FieldValue.serverTimestamp(),
  });

  return { eventId, decision };
});

/* ── API: Forensic report ────────────────────────────────────────── */
exports.inventoryFraudReport = onCall(CF_OPTS, async req => {
  const uid = assertAuth(req);
  const { tenantId, startDate, endDate } = req.data;
  const resolvedTenant = tenantId || uid;

  const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 86_400_000);
  const end   = endDate   ? new Date(endDate)   : new Date();

  const [eventsSnap, alertsSnap] = await Promise.all([
    db.collection(`tenants/${resolvedTenant}/inventory_fraud_events`)
      .where('createdAt', '>=', start).where('createdAt', '<=', end)
      .orderBy('createdAt', 'desc').limit(500).get(),
    db.collection(`tenants/${resolvedTenant}/inventory_alerts`)
      .where('type', 'in', ['fraud_detected', 'collusion_pattern'])
      .where('createdAt', '>=', start).orderBy('createdAt', 'desc').limit(100).get(),
  ]);

  const events  = eventsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const highRisk = events.filter(e => e.fraudLevel === 'HIGH');
  const pending  = events.filter(e => e.status === 'pending');

  return {
    period    : { start, end },
    summary   : { total: events.length, high: highRisk.length, pending: pending.length, resolved: events.filter(e => e.status === 'resolved').length },
    byType    : events.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {}),
    topRules  : _topRules(events),
    events    : events.slice(0, 100),
    alerts    : alertsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    generatedAt: new Date().toISOString(),
  };
});

function _topRules(events) {
  const counts = {};
  events.forEach(e => (e.triggeredRules || []).forEach(r => { counts[r.id] = (counts[r.id] || 0) + 1; }));
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, count]) => ({ id, count }));
}
