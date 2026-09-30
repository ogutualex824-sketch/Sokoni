'use strict';

const { onCall } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getApps, initializeApp } = require('firebase-admin/app');

if (!getApps().length) initializeApp();
const db = getFirestore();

const REGION = 'us-central1';

const VALID_CATEGORIES = new Set(['plumbing','electrical','structural','appliance','security','hvac','pest','other']);
const VALID_PRIORITIES = new Set(['urgent','high','normal','low']);
const VALID_STATUSES   = new Set(['submitted','acknowledged','in_progress','pending_parts','resolved','closed','cancelled']);

function _auth(req) {
  if (!req.auth) throw new Error('UNAUTHENTICATED');
}
function _admin(req) {
  if (!req.auth || (!req.auth.token.admin && !req.auth.token.superAdmin)) {
    throw new Error('PERMISSION_DENIED: admin required');
  }
}

// ── 1. submitMaintenanceRequest ──────────────────────────────────────────────
exports.submitMaintenanceRequest = onCall({ region: REGION, timeoutSeconds: 30 }, async (req) => {
  _auth(req);
  const { unitId, propertyId, category, priority, title, description, photos = [] } = req.data || {};

  if (!category || !VALID_CATEGORIES.has(category)) {
    throw new Error(`INVALID_ARGUMENT: category must be one of ${[...VALID_CATEGORIES].join(', ')}`);
  }
  if (!priority || !VALID_PRIORITIES.has(priority)) {
    throw new Error(`INVALID_ARGUMENT: priority must be one of ${[...VALID_PRIORITIES].join(', ')}`);
  }
  if (!title || typeof title !== 'string') throw new Error('INVALID_ARGUMENT: title required');
  if (!description) throw new Error('INVALID_ARGUMENT: description required');

  const uid = req.auth.uid;
  const ref = db.collection('maintenanceRequests').doc();
  const now = Timestamp.now();

  await ref.set({
    requestId:   ref.id,
    tenantId:    uid,
    unitId:      unitId || null,
    propertyId:  propertyId || null,
    category,
    priority,
    title:       String(title).slice(0, 200),
    description: String(description).slice(0, 2000),
    photos:      (photos || []).slice(0, 5),
    status:      'submitted',
    landlordResponse: null,
    assignedTo:  null,
    resolvedAt:  null,
    estimatedCost: null,
    actualCost:  null,
    timeline:    [{ ts: now, event: 'submitted', by: uid, note: '' }],
    createdAt:   now,
    updatedAt:   now,
  });

  return { requestId: ref.id, status: 'submitted' };
});

// ── 2. getMyMaintenanceRequests ──────────────────────────────────────────────
exports.getMyMaintenanceRequests = onCall({ region: REGION, timeoutSeconds: 30 }, async (req) => {
  _auth(req);
  const uid = req.auth.uid;
  const snap = await db.collection('maintenanceRequests')
    .where('tenantId', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(50).get();
  return snap.docs.map(d => d.data());
});

// ── 3. getLandlordRequests ───────────────────────────────────────────────────
// Landlords see requests for their properties (where propertyId matches their owned properties)
exports.getLandlordRequests = onCall({ region: REGION, timeoutSeconds: 30 }, async (req) => {
  _auth(req);
  const uid = req.auth.uid;
  const { status, propertyId } = req.data || {};

  // Verify landlord owns the property if propertyId provided
  if (propertyId) {
    const propSnap = await db.collection('properties').doc(propertyId).get();
    if (!propSnap.exists) throw new Error('NOT_FOUND: property not found');
    if (propSnap.data().ownerId !== uid && !req.auth.token.admin) {
      throw new Error('PERMISSION_DENIED: not your property');
    }
  }

  let q = db.collection('maintenanceRequests');
  if (propertyId) {
    q = q.where('propertyId', '==', propertyId);
  } else {
    // Without propertyId we need to get all their properties first
    // Simplified: return a message for the landlord to filter
    q = q.where('propertyId', 'in', ['__placeholder__']); // client must pass propertyId
  }
  if (status) q = q.where('status', '==', status);
  q = q.orderBy('createdAt', 'desc').limit(100);

  const snap = await q.get();
  return snap.docs.map(d => d.data());
});

// ── 4. updateMaintenanceStatus ───────────────────────────────────────────────
exports.updateMaintenanceStatus = onCall({ region: REGION, timeoutSeconds: 30 }, async (req) => {
  _auth(req);
  const { requestId, status, note = '', assignedTo, estimatedCost, actualCost } = req.data || {};

  if (!requestId) throw new Error('INVALID_ARGUMENT: requestId required');
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`INVALID_ARGUMENT: status must be one of ${[...VALID_STATUSES].join(', ')}`);
  }

  const uid = req.auth.uid;
  const ref = db.collection('maintenanceRequests').doc(requestId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('NOT_FOUND: request not found');

  const req_ = snap.data();
  // Tenants can only cancel their own
  if (!req.auth.token.admin && !req.auth.token.superAdmin) {
    if (req_.tenantId !== uid && status !== 'cancelled') {
      throw new Error('PERMISSION_DENIED');
    }
    if (req_.tenantId === uid && !['cancelled'].includes(status)) {
      throw new Error('PERMISSION_DENIED: tenants may only cancel requests');
    }
  }

  const now    = Timestamp.now();
  const update = {
    status, updatedAt: now,
    timeline: FieldValue.arrayUnion({ ts: now, event: status, by: uid, note: String(note).slice(0, 500) }),
  };
  if (assignedTo)    update.assignedTo    = assignedTo;
  if (estimatedCost) update.estimatedCost = Number(estimatedCost);
  if (actualCost)    update.actualCost    = Number(actualCost);
  if (status === 'resolved') update.resolvedAt = now;

  await ref.update(update);
  return { requestId, status };
});

// ── 5. respondToRequest (landlord/admin) ─────────────────────────────────────
exports.respondToRequest = onCall({ region: REGION, timeoutSeconds: 30 }, async (req) => {
  _auth(req);
  const { requestId, response, scheduledDate } = req.data || {};

  if (!requestId) throw new Error('INVALID_ARGUMENT: requestId required');
  if (!response)  throw new Error('INVALID_ARGUMENT: response required');

  const uid = req.auth.uid;
  const now = Timestamp.now();

  await db.collection('maintenanceRequests').doc(requestId).update({
    landlordResponse: String(response).slice(0, 1000),
    scheduledDate:    scheduledDate ? Timestamp.fromMillis(scheduledDate) : null,
    updatedAt:        now,
    timeline: FieldValue.arrayUnion({ ts: now, event: 'responded', by: uid, note: response }),
  });

  return { requestId, responded: true };
});

// ── 6. getMaintenanceStats (admin/landlord dashboard) ────────────────────────
exports.getMaintenanceStats = onCall({ region: REGION, timeoutSeconds: 30 }, async (req) => {
  _auth(req);
  const { propertyId } = req.data || {};

  let q = db.collection('maintenanceRequests');
  if (propertyId) q = q.where('propertyId', '==', propertyId);
  const snap = await q.limit(500).get();

  const stats = { total: 0, byStatus: {}, byCategory: {}, byPriority: {}, avgResolutionDays: 0 };
  let totalResolutionMs = 0, resolvedCount = 0;

  snap.docs.forEach(d => {
    const r = d.data();
    stats.total++;
    stats.byStatus[r.status]     = (stats.byStatus[r.status] || 0) + 1;
    stats.byCategory[r.category] = (stats.byCategory[r.category] || 0) + 1;
    stats.byPriority[r.priority] = (stats.byPriority[r.priority] || 0) + 1;
    if (r.resolvedAt && r.createdAt) {
      totalResolutionMs += (r.resolvedAt.toMillis() - r.createdAt.toMillis());
      resolvedCount++;
    }
  });

  if (resolvedCount) {
    stats.avgResolutionDays = Math.round(totalResolutionMs / resolvedCount / 86400000 * 10) / 10;
  }

  return stats;
});
