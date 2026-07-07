'use strict';

/**
 * SOKONI Platform Hub Engine v1.0
 *
 * Fills the gaps between platform-core.js and the spec:
 *   - WAP delay processor (scheduler) — makes delay steps execute without a browser
 *   - WAP instance inspector + retry for admin
 *   - Per-hub feature flags (scoped to individual hub, not global)
 *   - Hub details API (status + integrations + metrics in one call)
 *   - Cross-hub 24-hour health snapshot
 *   - Generic transaction-change notification (so new hubs don't need a custom CF trigger)
 *   - Hub lifecycle: activate / deactivate with platform event emission
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const admin                  = require('firebase-admin');
const { FieldValue }         = require('firebase-admin/firestore');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

/* ── helpers ──────────────────────────────────────────────────────────────── */
const _isAdmin = ctx => ctx.auth?.token?.admin === true || ctx.auth?.token?.role === 'admin';
const _uid     = ctx => ctx.auth?.uid;
const _now     = ()  => FieldValue.serverTimestamp();
const _tsNow   = ()  => admin.firestore.Timestamp.now();
const _err     = (code, msg) => { throw new HttpsError(code, msg); };

const HUB_IDS = [
  'marketplace','food','events','property','vehicles','healthcare','legal',
  'jobs','hotels','pharmacy','drivers','logistics','freelancer','education',
  'entertainment','digital_products','smartpos','insurance','financial_services',
];

function _defaultHubFlags() {
  return {
    enabled:               true,
    chat_enabled:          true,
    search_indexed:        true,
    ai_assistant:          true,
    notifications_enabled: true,
    reviews_enabled:       true,
    analytics_enabled:     true,
    escrow_enabled:        true,
    etims_enabled:         false,
  };
}

/* ── WAP: server-side DAG advance after delay step completes ──────────────── */
async function _completeStepsAndAdvance(instanceId, stepIds) {
  const instRef = db.collection('workflowInstances').doc(instanceId);

  await db.runTransaction(async tx => {
    const snap = await tx.get(instRef);
    if (!snap.exists) return;
    const inst = snap.data();
    if (!['running', 'pending'].includes(inst.status)) return;

    const defRef = db.collection('workflowDefinitions').doc(inst.definitionId);
    const defSnap = await tx.get(defRef);
    if (!defSnap.exists) return;
    const def = defSnap.data();

    /* Build merged steps map */
    const steps = { ...(inst.steps || {}) };
    const updates = { updatedAt: _now() };

    stepIds.forEach(id => {
      steps[id] = { ...(steps[id] || {}), status: 'completed', completedAt: _tsNow() };
      updates[`steps.${id}.status`]      = 'completed';
      updates[`steps.${id}.completedAt`] = _now();
    });

    /* Check if all steps in definition are terminal */
    const allDone = (def.steps || []).every(s =>
      ['completed', 'skipped', 'failed'].includes((steps[s.id] || {}).status)
    );
    if (allDone) {
      updates.status      = 'completed';
      updates.completedAt = _now();
    }

    tx.update(instRef, updates);
  });
}

/* ── 1. WAP: Process Delay Steps ─────────────────────────────────────────── */
exports.wapProcessDelays = onSchedule({
  schedule:  'every 5 minutes',
  region:    'us-central1',
  timeZone:  'Africa/Nairobi',
  memory:    '256MiB',
}, async () => {
  const snap = await db.collection('workflowSchedule')
    .where('runAt',    '<=', _tsNow())
    .where('processed', '==', false)
    .limit(50)
    .get();

  if (snap.empty) return;

  /* Group by instanceId so we batch step completions per instance */
  const byInstance = new Map();
  const batch = db.batch();

  for (const doc of snap.docs) {
    const { instanceId, stepId } = doc.data();
    batch.update(doc.ref, { processed: true, processedAt: _now() });
    if (!byInstance.has(instanceId)) byInstance.set(instanceId, []);
    byInstance.get(instanceId).push(stepId);
  }

  await batch.commit();

  /* Advance each instance — errors are isolated so one bad instance doesn't block others */
  const results = await Promise.allSettled(
    [...byInstance.entries()].map(([iid, sids]) => _completeStepsAndAdvance(iid, sids))
  );

  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length) {
    console.error(`wapProcessDelays: ${failed.length} instance(s) failed to advance`,
      failed.map(r => r.reason?.message));
  }

  console.log(`wapProcessDelays: processed ${snap.size} delay(s) across ${byInstance.size} instance(s)`);
});

/* ── 2. WAP: Get Instances (admin) ───────────────────────────────────────── */
exports.wapGetInstances = onCall({ enforceAppCheck: true, region: 'us-central1' }, async req => {
  if (!_isAdmin(req)) _err('permission-denied', 'Admin only');
  const { status, definitionId, cursor, limit: lim = 20 } = req.data;
  const pageSize = Math.min(Number(lim) || 20, 50);

  let q = db.collection('workflowInstances').orderBy('createdAt', 'desc');
  if (status)       q = q.where('status', '==', status);
  if (definitionId) q = q.where('definitionId', '==', definitionId);
  if (cursor) {
    const cDoc = await db.collection('workflowInstances').doc(cursor).get();
    if (cDoc.exists) q = q.startAfter(cDoc);
  }
  q = q.limit(pageSize + 1);

  const snap   = await q.get();
  const hasMore = snap.size > pageSize;
  const docs   = snap.docs.slice(0, pageSize).map(d => {
    const data = d.data();
    return {
      id:           d.id,
      definitionId: data.definitionId,
      status:       data.status,
      variables:    data.variables,
      stepCount:    Object.keys(data.steps || {}).length,
      failedSteps:  Object.values(data.steps || {}).filter(s => s.status === 'failed').length,
      createdAt:    data.createdAt?.toDate()?.toISOString() || null,
      updatedAt:    data.updatedAt?.toDate()?.toISOString() || null,
      completedAt:  data.completedAt?.toDate()?.toISOString() || null,
    };
  });

  return { instances: docs, hasMore, cursor: hasMore ? docs[docs.length - 1]?.id : null };
});

/* ── 3. WAP: Retry Failed Step (admin) ──────────────────────────────────── */
exports.wapRetryStep = onCall({ enforceAppCheck: true, region: 'us-central1' }, async req => {
  if (!_isAdmin(req)) _err('permission-denied', 'Admin only');
  const { instanceId, stepId } = req.data;
  if (!instanceId || !stepId) _err('invalid-argument', 'instanceId and stepId required');

  const instRef = db.collection('workflowInstances').doc(instanceId);

  await db.runTransaction(async tx => {
    const snap = await tx.get(instRef);
    if (!snap.exists) _err('not-found', 'Workflow instance not found');
    const step = (snap.data().steps || {})[stepId];
    if (!step)               _err('not-found', 'Step not found in instance');
    if (step.status !== 'failed') _err('failed-precondition', 'Only failed steps can be retried');

    tx.update(instRef, {
      [`steps.${stepId}.status`]:     'pending',
      [`steps.${stepId}.error`]:      null,
      [`steps.${stepId}.retryCount`]: (step.retryCount || 0) + 1,
      status:    'running',
      updatedAt: _now(),
    });
  });

  await db.collection('adminAuditLog').add({
    action:     'wap_retry_step',
    instanceId, stepId,
    adminUid:   _uid(req),
    at:         _now(),
  });

  return { ok: true };
});

/* ── 4. Per-Hub Feature Flags — Read ────────────────────────────────────── */
exports.pcGetPerHubFlags = onCall({ enforceAppCheck: true, region: 'us-central1' }, async req => {
  if (!_isAdmin(req)) _err('permission-denied', 'Admin only');
  const { hubId } = req.data;
  if (!HUB_IDS.includes(hubId)) _err('invalid-argument', `Unknown hubId: ${hubId}`);

  const snap = await db.collection('platformConfig').doc('hubFlags').get();
  const all  = snap.exists ? snap.data() : {};
  const flags = { ..._defaultHubFlags(), ...(all[hubId] || {}) };

  return { hubId, flags };
});

/* ── 5. Per-Hub Feature Flags — Write ───────────────────────────────────── */
exports.pcSetPerHubFlag = onCall({ enforceAppCheck: true, region: 'us-central1' }, async req => {
  if (!_isAdmin(req)) _err('permission-denied', 'Admin only');
  const { hubId, flagKey, enabled } = req.data;
  if (!HUB_IDS.includes(hubId))           _err('invalid-argument', `Unknown hubId: ${hubId}`);
  if (typeof enabled !== 'boolean')       _err('invalid-argument', 'enabled must be boolean');
  if (!flagKey || typeof flagKey !== 'string') _err('invalid-argument', 'flagKey required');

  await db.collection('platformConfig').doc('hubFlags')
    .set({ [hubId]: { [flagKey]: enabled } }, { merge: true });

  await db.collection('adminAuditLog').add({
    action:  'set_hub_flag',
    hubId, flagKey, enabled,
    adminUid: _uid(req),
    at:       _now(),
  });

  return { ok: true };
});

/* ── 6. Hub Details (admin — full config + flags + metrics in one call) ── */
exports.pcGetHubDetails = onCall({ enforceAppCheck: true, region: 'us-central1' }, async req => {
  if (!_isAdmin(req)) _err('permission-denied', 'Admin only');
  const { hubId } = req.data;
  if (!hubId) _err('invalid-argument', 'hubId required');

  const [hubSnap, flagsSnap, countersSnap] = await Promise.all([
    db.collection('platformHubs').doc(hubId).get(),
    db.collection('platformConfig').doc('hubFlags').get(),
    db.collection('finosHubCounters').doc(hubId).get(),
  ]);

  if (!hubSnap.exists) _err('not-found', `Hub '${hubId}' not found in registry`);
  const hub      = hubSnap.data();
  const allFlags = flagsSnap.exists ? flagsSnap.data() : {};
  const counters = countersSnap.exists ? countersSnap.data() : {};

  return {
    hubId,
    ...hub,
    perHubFlags:      { ..._defaultHubFlags(), ...(allFlags[hubId] || {}) },
    lifetimeRevenue:  counters.totalRevenue  || 0,
    lifetimeOrders:   counters.totalOrders   || 0,
    lifetimeComm:     counters.totalComm     || 0,
  };
});

/* ── 7. Cross-Hub Health Snapshot (admin) ───────────────────────────────── */
exports.pcGetCrossHubHealth = onCall({ enforceAppCheck: true, region: 'us-central1' }, async req => {
  if (!_isAdmin(req)) _err('permission-denied', 'Admin only');

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const sinceTs = admin.firestore.Timestamp.fromDate(since);

  const [hubsSnap, recentOrdersSnap] = await Promise.all([
    db.collection('platformHubs').orderBy('name').get(),
    db.collection('orders').where('createdAt', '>=', sinceTs).get(),
  ]);

  /* Aggregate orders by hub type */
  const byHub = {};
  recentOrdersSnap.forEach(d => {
    const hub = d.data().hubType || 'marketplace';
    if (!byHub[hub]) byHub[hub] = { orders: 0, revenue: 0, failed: 0 };
    byHub[hub].orders++;
    if (['failed', 'cancelled'].includes(d.data().status)) byHub[hub].failed++;
    byHub[hub].revenue += d.data().amountKes || d.data().total || 0;
  });

  const hubs = hubsSnap.docs.map(d => {
    const data  = d.data();
    const stats = byHub[d.id] || { orders: 0, revenue: 0, failed: 0 };
    const errRate = stats.orders > 0 ? (stats.failed / stats.orders) * 100 : 0;
    return {
      hubId:      d.id,
      name:       data.name,
      icon:       data.icon || '📦',
      status:     data.status,
      cfCount:    data.cfCount || 0,
      orders24h:  stats.orders,
      revenue24h: Math.round(stats.revenue),
      errorRate:  Math.round(errRate * 10) / 10,
      health:     errRate > 20 ? 'degraded' : errRate > 5 ? 'warning' : 'healthy',
    };
  });

  return { hubs, asOf: new Date().toISOString() };
});

/* ── 8. Generic Transaction Change → Conversation System Message ─────────── */
/*
 * New hubs call this CF when their transaction status changes instead of
 * writing a new Firestore trigger per hub. The CF finds the linked
 * conversation (if any) and posts a system message.
 */
exports.platformNotifyTransactionChange = onCall({ enforceAppCheck: true, region: 'us-central1' }, async req => {
  const uid = _uid(req);
  if (!uid) _err('unauthenticated', 'Authentication required');

  const { transactionId, transactionType, newStatus, actorRole, statusMessage } = req.data;
  if (!transactionId || !transactionType || !newStatus)
    _err('invalid-argument', 'transactionId, transactionType, and newStatus are required');

  const VALID_STATUSES = [
    'pending','confirmed','processing','ready','in_progress','completed',
    'cancelled','refunded','disputed','on_hold','delivered','failed','accepted','rejected',
    'awaiting_payment','shipped','out_for_delivery','returned',
  ];
  if (!VALID_STATUSES.includes(newStatus))
    _err('invalid-argument', `Invalid status: ${newStatus}`);

  /* Look up the conversation linked to this transaction */
  const convSnap = await db.collection('conversations')
    .where('transactionId',   '==', transactionId)
    .where('transactionType', '==', transactionType)
    .limit(1)
    .get();

  if (convSnap.empty) return { ok: true, noConversation: true };

  const convRef = convSnap.docs[0].ref;
  const msgRef  = convRef.collection('messages').doc();
  const now     = _tsNow();

  const label      = newStatus.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const systemText = statusMessage || `Status updated to: ${label}`;

  const batchW = db.batch();
  batchW.set(msgRef, {
    type:      'system',
    text:      systemText,
    status:    newStatus,
    actorRole: actorRole || 'system',
    senderId:  uid,
    createdAt: now,
    read:      false,
  });
  batchW.update(convRef, {
    lastMessage:       systemText,
    lastMessageAt:     now,
    lastSenderId:      'system',
    transactionStatus: newStatus,
    updatedAt:         now,
  });
  await batchW.commit();

  return { ok: true, conversationId: convSnap.docs[0].id };
});

/* ── 9. Hub Lifecycle: Activate ─────────────────────────────────────────── */
exports.pcActivateHub = onCall({ enforceAppCheck: true, region: 'us-central1' }, async req => {
  if (!_isAdmin(req)) _err('permission-denied', 'Admin only');
  const { hubId, reason } = req.data;
  if (!HUB_IDS.includes(hubId)) _err('invalid-argument', `Unknown hubId: ${hubId}`);

  const hubRef = db.collection('platformHubs').doc(hubId);
  if (!(await hubRef.get()).exists) _err('not-found', `Hub '${hubId}' not found`);

  await hubRef.update({
    status:      'live',
    activatedAt: _now(),
    activatedBy: _uid(req),
  });

  await Promise.all([
    db.collection('platformEvents').add({
      type:     'hub.activated',
      hubId,    reason: reason || null,
      actorUid: _uid(req),
      at:       _now(),
    }),
    db.collection('adminAuditLog').add({
      action:   'hub_activate',
      hubId,    reason: reason || null,
      adminUid: _uid(req),
      at:       _now(),
    }),
  ]);

  return { ok: true, hubId, status: 'live' };
});

/* ── 10. Hub Lifecycle: Deactivate ──────────────────────────────────────── */
exports.pcDeactivateHub = onCall({ enforceAppCheck: true, region: 'us-central1' }, async req => {
  if (!_isAdmin(req)) _err('permission-denied', 'Admin only');
  const { hubId, reason } = req.data;
  if (!HUB_IDS.includes(hubId)) _err('invalid-argument', `Unknown hubId: ${hubId}`);

  const hubRef = db.collection('platformHubs').doc(hubId);
  if (!(await hubRef.get()).exists) _err('not-found', `Hub '${hubId}' not found`);

  await hubRef.update({
    status:              'maintenance',
    deactivatedAt:       _now(),
    deactivatedBy:       _uid(req),
    maintenanceReason:   reason || null,
  });

  await Promise.all([
    db.collection('platformEvents').add({
      type:     'hub.deactivated',
      hubId,    reason: reason || null,
      actorUid: _uid(req),
      at:       _now(),
    }),
    db.collection('adminAuditLog').add({
      action:   'hub_deactivate',
      hubId,    reason: reason || null,
      adminUid: _uid(req),
      at:       _now(),
    }),
  ]);

  return { ok: true, hubId, status: 'maintenance' };
});
