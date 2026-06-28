'use strict';
/**
 * SOKONI Buyer Dispute Portal — Cloud Functions v1.0
 * 7 functions covering full dispute lifecycle for buyers, sellers, and admins.
 * Disputes written to `disputes` collection trigger ADE adeOnDisputeCreated automatically.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const db         = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const VALID_REASONS = [
  'not_received',     // Item never delivered
  'wrong_item',       // Wrong item sent
  'not_as_described', // Significantly different from listing
  'counterfeit',      // Fake/counterfeit product
  'damaged',          // Arrived damaged
  'defective',        // Not working/defective
  'overcharged',      // Charged wrong amount
  'other',
];
const OPEN_STATUSES = ['open', 'investigating', 'seller_responded'];

function _requireAuth(auth) {
  if (!auth) throw new HttpsError('unauthenticated', 'Login required');
}
function _san(v, max) {
  if (typeof v !== 'string') return v;
  return v.replace(/[<>"'&]/g, c => ({'<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#x27;','&':'&amp;'}[c])).slice(0, max || 2000);
}

// ─── createDispute — buyer raises a dispute against an order ─────────────────
exports.createDispute = onCall({ enforceAppCheck: false }, async request => {
  _requireAuth(request.auth);
  const uid = request.auth.uid;
  const { orderId, reason, description } = request.data;

  if (!orderId || !reason || !description)
    throw new HttpsError('invalid-argument', 'orderId, reason, description required');
  if (!VALID_REASONS.includes(reason))
    throw new HttpsError('invalid-argument', 'Invalid reason');
  if (String(description).trim().length < 10)
    throw new HttpsError('invalid-argument', 'Please provide a more detailed description');

  // Verify order ownership
  const orderDoc = await db.collection('orders').doc(orderId).get();
  if (!orderDoc.exists) throw new HttpsError('not-found', 'Order not found');
  const order = orderDoc.data();
  const isBuyer = order.buyerId === uid || order.userId === uid || order.customerId === uid;
  if (!isBuyer) throw new HttpsError('permission-denied', 'This is not your order');

  // 30-day window from delivery (or creation if undelivered)
  const refTs = order.deliveredAt || order.createdAt;
  if (refTs) {
    const refDate = refTs.toDate ? refTs.toDate() : new Date(refTs);
    if ((Date.now() - refDate.getTime()) > 30 * 86400000)
      throw new HttpsError('failed-precondition', 'Dispute window has closed (30 days)');
  }

  // No duplicate open dispute
  const existing = await db.collection('disputes').where('orderId', '==', orderId).get();
  const hasDup = existing.docs.some(d => OPEN_STATUSES.includes(d.data().status));
  if (hasDup) throw new HttpsError('already-exists', 'An open dispute already exists for this order');

  const ref = await db.collection('disputes').add({
    orderId,
    buyerId:  uid,
    sellerId: order.sellerId || order.vendorId || null,
    reason,
    description: _san(description.trim()),
    amount:   order.total || order.amount || 0,
    status:   'open',
    resolution:       null,
    resolutionAmount: null,
    evidence:         [],
    timeline:         [{ event: 'opened', actor: uid, actorRole: 'buyer', note: 'Dispute opened by buyer', ts: new Date().toISOString() }],
    sellerResponse:   null,
    sellerRespondedAt:null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    resolvedAt:  null,
    resolvedBy:  null,
    adminNotes:  null,
    orderSnapshot: {
      status:         order.status,
      deliveryStatus: order.deliveryStatus,
      amount:         order.total || order.amount,
      itemCount:      (order.items || []).length,
    },
  });

  return { disputeId: ref.id };
});

// ─── getMyDisputes — buyer's full dispute history ────────────────────────────
exports.getMyDisputes = onCall({ enforceAppCheck: false }, async request => {
  _requireAuth(request.auth);
  const snap = await db.collection('disputes').where('buyerId', '==', request.auth.uid).get();
  const items = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  return { disputes: items };
});

// ─── getDisputeDetail — buyer, seller, or admin ──────────────────────────────
exports.getDisputeDetail = onCall({ enforceAppCheck: false }, async request => {
  _requireAuth(request.auth);
  const uid = request.auth.uid;
  const { disputeId } = request.data;
  if (!disputeId) throw new HttpsError('invalid-argument', 'disputeId required');

  const snap = await db.collection('disputes').doc(disputeId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Dispute not found');
  const data = snap.data();

  const t     = request.auth.token;
  const admin = t.isAdmin || t.isSuperAdmin || t.isSupport;
  if (data.buyerId !== uid && data.sellerId !== uid && !admin)
    throw new HttpsError('permission-denied', 'Not authorised');

  return { dispute: { id: snap.id, ...data } };
});

// ─── addDisputeEvidence — buyer or seller adds evidence ──────────────────────
exports.addDisputeEvidence = onCall({ enforceAppCheck: false }, async request => {
  _requireAuth(request.auth);
  const uid = request.auth.uid;
  const { disputeId, evidenceType, description, fileUrl } = request.data;
  if (!disputeId || !evidenceType || !description)
    throw new HttpsError('invalid-argument', 'disputeId, evidenceType, description required');

  const snap = await db.collection('disputes').doc(disputeId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Dispute not found');
  const data = snap.data();
  if (data.buyerId !== uid && data.sellerId !== uid)
    throw new HttpsError('permission-denied', 'Not a party to this dispute');
  if (!OPEN_STATUSES.includes(data.status))
    throw new HttpsError('failed-precondition', 'Dispute is no longer open');

  const role = data.buyerId === uid ? 'buyer' : 'seller';
  const item = {
    type:        _san(evidenceType, 60),
    description: _san(description, 1000),
    fileUrl:     fileUrl ? _san(fileUrl, 2000) : null,
    addedBy:     uid,
    addedByRole: role,
    addedAt:     new Date().toISOString(),
  };
  const tlEntry = { event: 'evidence_added', actor: uid, actorRole: role, note: `${role} added ${evidenceType} evidence`, ts: new Date().toISOString() };

  await snap.ref.update({
    evidence:  FieldValue.arrayUnion(item),
    timeline:  FieldValue.arrayUnion(tlEntry),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { success: true };
});

// ─── sellerRespondToDispute — seller submits their response ──────────────────
exports.sellerRespondToDispute = onCall({ enforceAppCheck: false }, async request => {
  _requireAuth(request.auth);
  const uid = request.auth.uid;
  const { disputeId, response } = request.data;
  if (!disputeId || !response) throw new HttpsError('invalid-argument', 'disputeId, response required');

  const snap = await db.collection('disputes').doc(disputeId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Dispute not found');
  const data = snap.data();
  if (data.sellerId !== uid) throw new HttpsError('permission-denied', 'Not the seller');
  if (!OPEN_STATUSES.includes(data.status))
    throw new HttpsError('failed-precondition', 'Dispute is no longer open');

  const tlEntry = { event: 'seller_responded', actor: uid, actorRole: 'seller', note: 'Seller submitted response', ts: new Date().toISOString() };
  await snap.ref.update({
    sellerResponse:    _san(response, 2000),
    sellerRespondedAt: FieldValue.serverTimestamp(),
    status:            'seller_responded',
    timeline:          FieldValue.arrayUnion(tlEntry),
    updatedAt:         FieldValue.serverTimestamp(),
  });
  return { success: true };
});

// ─── cancelDispute — buyer withdraws their dispute ───────────────────────────
exports.cancelDispute = onCall({ enforceAppCheck: false }, async request => {
  _requireAuth(request.auth);
  const uid = request.auth.uid;
  const { disputeId } = request.data;
  if (!disputeId) throw new HttpsError('invalid-argument', 'disputeId required');

  const snap = await db.collection('disputes').doc(disputeId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Dispute not found');
  const data = snap.data();
  if (data.buyerId !== uid) throw new HttpsError('permission-denied', 'Not your dispute');
  if (!OPEN_STATUSES.includes(data.status))
    throw new HttpsError('failed-precondition', 'Cannot cancel a resolved dispute');

  const tlEntry = { event: 'buyer_cancelled', actor: uid, actorRole: 'buyer', note: 'Dispute withdrawn by buyer', ts: new Date().toISOString() };
  await snap.ref.update({
    status:     'closed',
    resolution: 'buyer_cancelled',
    resolvedAt: FieldValue.serverTimestamp(),
    resolvedBy: uid,
    timeline:   FieldValue.arrayUnion(tlEntry),
    updatedAt:  FieldValue.serverTimestamp(),
  });
  return { success: true };
});

// ─── getSellerDisputes — seller sees disputes raised against them ─────────────
exports.getSellerDisputes = onCall({ enforceAppCheck: false }, async request => {
  _requireAuth(request.auth);
  const snap = await db.collection('disputes').where('sellerId', '==', request.auth.uid).get();
  const items = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  return { disputes: items };
});

// ─── adminGetAllDisputes — admin/superAdmin lists all disputes ────────────────
exports.adminGetAllDisputes = onCall({ enforceAppCheck: false }, async request => {
  _requireAuth(request.auth);
  const t = request.auth.token;
  if (!t.admin && !t.superAdmin && !t.isAdmin && !t.isSuperAdmin)
    throw new HttpsError('permission-denied', 'Admin access required');

  const { status, limit } = request.data || {};
  let q = db.collection('disputes').orderBy('createdAt', 'desc');
  if (status) q = q.where('status', '==', status);
  q = q.limit(Math.min(Number(limit) || 100, 500));

  const snap = await q.get();
  const disputes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return { disputes };
});

// ─── adminResolveDispute — admin resolves or updates a dispute status ─────────
exports.adminResolveDispute = onCall({ enforceAppCheck: false }, async request => {
  _requireAuth(request.auth);
  const t = request.auth.token;
  if (!t.admin && !t.superAdmin && !t.isAdmin && !t.isSuperAdmin)
    throw new HttpsError('permission-denied', 'Admin access required');

  const uid = request.auth.uid;
  const { disputeId, action, resolution } = request.data || {};
  if (!disputeId) throw new HttpsError('invalid-argument', 'disputeId required');
  if (!action)    throw new HttpsError('invalid-argument', 'action required');

  const VALID_ACTIONS = ['open', 'investigating', 'resolved', 'closed'];
  if (!VALID_ACTIONS.includes(action))
    throw new HttpsError('invalid-argument', 'Invalid action. Must be one of: ' + VALID_ACTIONS.join(', '));

  const snap = await db.collection('disputes').doc(disputeId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Dispute not found');

  if (action === 'resolved' && (!resolution || String(resolution).trim().length < 2))
    throw new HttpsError('invalid-argument', 'A resolution note is required when resolving a dispute');

  const tlEntry = {
    event:     'admin_action',
    actor:     uid,
    actorRole: 'admin',
    note:      `Status changed to ${action}${resolution ? ': ' + _san(resolution, 500) : ''}`,
    ts:        new Date().toISOString(),
  };

  const update = {
    status:    action,
    updatedAt: FieldValue.serverTimestamp(),
    timeline:  FieldValue.arrayUnion(tlEntry),
    adminNotes: _san(resolution || '', 1000),
  };

  if (action === 'resolved' || action === 'closed') {
    update.resolution  = _san(resolution || '', 1000);
    update.resolvedAt  = FieldValue.serverTimestamp();
    update.resolvedBy  = uid;
  }

  await snap.ref.update(update);

  // Sync the linked order's dispute status when fully resolved
  if (action === 'resolved' || action === 'closed') {
    const orderId = snap.data().orderId;
    if (orderId) {
      await db.collection('orders').doc(orderId).update({
        disputeStatus: action,
        disputeResolvedAt: FieldValue.serverTimestamp(),
      }).catch(() => { /* order may not exist — safe to ignore */ });
    }
  }

  return { success: true, disputeId, action };
});
