'use strict';

const { onCall } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getApps, initializeApp } = require('firebase-admin/app');

if (!getApps().length) initializeApp();
const db = getFirestore();

const REGION = 'us-central1';

const VALID_REASONS   = new Set(['defective','wrong_item','changed_mind','not_as_described','damaged_in_transit','other']);
const VALID_RESOLUTIONS = new Set(['refund','exchange','store_credit']);
const VALID_STATUSES  = new Set(['submitted','under_review','approved','rejected','processed']);

function _auth(req) {
  if (!req.auth) throw new Error('UNAUTHENTICATED');
}
function _admin(req) {
  if (!req.auth || (!req.auth.token.admin && !req.auth.token.superAdmin)) {
    throw new Error('PERMISSION_DENIED: admin required');
  }
}
function _adminOrSeller(req) {
  if (!req.auth) throw new Error('UNAUTHENTICATED');
  if (!req.auth.token.admin && !req.auth.token.superAdmin && !req.auth.token.seller) {
    throw new Error('PERMISSION_DENIED: seller or admin required');
  }
}

// ── 1. submitReturn ──────────────────────────────────────────────────────────
exports.submitReturn = onCall({ region: REGION, timeoutSeconds: 30 }, async (req) => {
  _auth(req);
  const { orderId, items, reason, description = '', resolution } = req.data || {};

  if (!orderId) throw new Error('INVALID_ARGUMENT: orderId required');
  if (!Array.isArray(items) || !items.length) throw new Error('INVALID_ARGUMENT: items required');
  if (!VALID_REASONS.has(reason)) throw new Error(`INVALID_ARGUMENT: reason must be one of ${[...VALID_REASONS].join(', ')}`);
  if (!VALID_RESOLUTIONS.has(resolution)) throw new Error(`INVALID_ARGUMENT: resolution must be one of ${[...VALID_RESOLUTIONS].join(', ')}`);

  const uid = req.auth.uid;

  // Verify order belongs to this buyer
  const orderSnap = await db.collection('orders').doc(orderId).get();
  if (!orderSnap.exists) throw new Error('NOT_FOUND: order not found');
  const order = orderSnap.data();
  if (order.buyerId !== uid && order.userId !== uid) {
    throw new Error('PERMISSION_DENIED: order does not belong to you');
  }

  // Deterministic doc ID prevents concurrent duplicates; check + create are atomic
  const returnRef = db.collection('returns').doc('ret_' + orderId + '_' + uid);
  const now = Timestamp.now();
  let isReplay = false;

  await db.runTransaction(async (txn) => {
    const snap = await txn.get(returnRef);
    if (snap.exists) { isReplay = true; return; }

    txn.set(returnRef, {
      returnId:    returnRef.id,
      orderId,
      buyerId:     uid,
      sellerId:    order.sellerId || order.vendorId || null,
      items:       items.map(it => ({
        productId: it.productId || null,
        name:      String(it.name || '').slice(0, 200),
        qty:       Math.max(1, Number(it.qty) || 1),
        price:     Number(it.price) || 0,
      })),
      reason,
      description: String(description).slice(0, 1000),
      resolution,
      status:      'submitted',
      refundAmount: null,
      submittedAt: now,
      reviewedAt:  null,
      reviewedBy:  null,
      rejectionReason: null,
      timeline:    [{ ts: now, event: 'submitted', by: uid }],
      createdAt:   now,
    });
  });

  if (isReplay) throw new Error('ALREADY_EXISTS: an open return already exists for this order');

  return { returnId: returnRef.id, status: 'submitted' };
});

// ── 2. getMyReturns ──────────────────────────────────────────────────────────
exports.getMyReturns = onCall({ region: REGION, timeoutSeconds: 30 }, async (req) => {
  _auth(req);
  const uid = req.auth.uid;
  const snap = await db.collection('returns')
    .where('buyerId', '==', uid)
    .orderBy('submittedAt', 'desc')
    .limit(50).get();
  return snap.docs.map(d => d.data());
});

// ── 3. getSellerReturns ──────────────────────────────────────────────────────
exports.getSellerReturns = onCall({ region: REGION, timeoutSeconds: 30 }, async (req) => {
  _adminOrSeller(req);
  const uid = req.auth.uid;
  const { status } = req.data || {};

  let q = db.collection('returns');

  if (!req.auth.token.admin && !req.auth.token.superAdmin) {
    // Sellers only see their own
    q = q.where('sellerId', '==', uid);
  }
  if (status) q = q.where('status', '==', status);
  q = q.orderBy('submittedAt', 'desc').limit(100);

  const snap = await q.get();
  return snap.docs.map(d => {
    const r = d.data();
    // Mask buyer name for seller (not needed for admin)
    if (req.auth.token.seller && !req.auth.token.admin) {
      r.buyerName = r.buyerName ? r.buyerName.slice(0, 1) + '***' : 'Buyer';
    }
    return r;
  });
});

// ── 4. reviewReturn ──────────────────────────────────────────────────────────
exports.reviewReturn = onCall({ region: REGION, timeoutSeconds: 60 }, async (req) => {
  _adminOrSeller(req);
  const { returnId, action, rejectionReason = '', refundAmount } = req.data || {};

  if (!returnId) throw new Error('INVALID_ARGUMENT: returnId required');
  if (!['approve', 'reject', 'request_info'].includes(action)) {
    throw new Error('INVALID_ARGUMENT: action must be approve|reject|request_info');
  }
  if (action === 'reject' && !rejectionReason) {
    throw new Error('INVALID_ARGUMENT: rejectionReason required when rejecting');
  }

  const uid      = req.auth.uid;
  const returnRef = db.collection('returns').doc(returnId);

  return db.runTransaction(async tx => {
    const snap = await tx.get(returnRef);
    if (!snap.exists) throw new Error('NOT_FOUND: return not found');
    const ret = snap.data();

    // Sellers can only manage their own
    if (req.auth.token.seller && !req.auth.token.admin && ret.sellerId !== uid) {
      throw new Error('PERMISSION_DENIED: not your return');
    }
    if (!['submitted', 'under_review'].includes(ret.status)) {
      throw new Error('FAILED_PRECONDITION: return cannot be reviewed in status ' + ret.status);
    }

    const now = Timestamp.now();
    let newStatus, update;

    if (action === 'approve') {
      newStatus = 'approved';
      update = {
        status: newStatus, reviewedAt: now, reviewedBy: uid,
        refundAmount: refundAmount || null,
        timeline: FieldValue.arrayUnion({ ts: now, event: 'approved', by: uid }),
      };
    } else if (action === 'reject') {
      newStatus = 'rejected';
      update = {
        status: newStatus, reviewedAt: now, reviewedBy: uid,
        rejectionReason: String(rejectionReason).slice(0, 500),
        timeline: FieldValue.arrayUnion({ ts: now, event: 'rejected', by: uid, reason: rejectionReason }),
      };
    } else {
      update = {
        status: 'under_review',
        timeline: FieldValue.arrayUnion({ ts: now, event: 'info_requested', by: uid }),
      };
      newStatus = 'under_review';
    }

    tx.update(returnRef, update);
    return { returnId, status: newStatus };
  });
});

// ── 5. adminForceReturn ──────────────────────────────────────────────────────
exports.adminForceReturn = onCall({ region: REGION, timeoutSeconds: 60 }, async (req) => {
  _admin(req);
  const { returnId, action, note = '' } = req.data || {};

  if (!returnId) throw new Error('INVALID_ARGUMENT: returnId required');
  if (!['force_approve', 'force_reject'].includes(action)) {
    throw new Error('INVALID_ARGUMENT: action must be force_approve|force_reject');
  }

  const uid  = req.auth.uid;
  const now  = Timestamp.now();
  const status = action === 'force_approve' ? 'approved' : 'rejected';

  await db.collection('returns').doc(returnId).update({
    status,
    reviewedAt:  now,
    reviewedBy:  uid,
    adminNote:   String(note).slice(0, 500),
    timeline:    FieldValue.arrayUnion({ ts: now, event: action, by: uid, note }),
  });

  return { returnId, status };
});

// ── 6. markReturnProcessed ───────────────────────────────────────────────────
exports.markReturnProcessed = onCall({ region: REGION, timeoutSeconds: 30 }, async (req) => {
  _adminOrSeller(req);
  const { returnId, note = '' } = req.data || {};
  if (!returnId) throw new Error('INVALID_ARGUMENT: returnId required');

  const uid = req.auth.uid;
  const now = Timestamp.now();

  await db.collection('returns').doc(returnId).update({
    status:      'processed',
    processedAt: now,
    processedBy: uid,
    timeline:    FieldValue.arrayUnion({ ts: now, event: 'processed', by: uid, note }),
  });

  return { returnId, status: 'processed' };
});
