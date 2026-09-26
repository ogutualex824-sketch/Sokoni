'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
/* ONE buyer / seller identity (Repair 2) and the published return policy, decided on the server. */
const DI = require('./dispute-identity');
const RE = require('./returns-eligibility');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getApps, initializeApp } = require('firebase-admin/app');

if (!getApps().length) initializeApp();
const db = getFirestore();

const REGION = 'us-central1';

/* Reasons come from the ONE reason authority (functions/refund-reasons.js). Which reasons a return
   accepts is unchanged; changed_mind / damaged_in_transit are stored as buyer_request / damaged. */
const RR = require('./refund-reasons');
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
  /* ── THE SERVER DECIDES THE REQUEST (Repair 4) ────────────────────────────────────────
     The browser sends only: orderId, reason, description, requested outcome, an optional note and
     optionally WHICH of the order's items. Everything else is established here: the buyer (ONE uid by
     precedence — dispute-identity.js), ownership, the reason (the ONE reason authority), payment,
     delivery, the published 7-day window and evidence requirement (returns-eligibility.js), and the
     items with the ORDER's names and prices. No client price or amount is accepted. This creates a
     REQUEST: it moves no money and decides no refund, fee or liability (H2). */
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in to request a return.');
  const uid = req.auth.uid;
  const { orderId, reason, description = '', resolution, productIds, itemNote = '' } = req.data || {};
  if (!orderId) throw new HttpsError('invalid-argument', 'orderId is required.');
  const _reason = RR.resolve('return', reason);
  if (!_reason.ok) throw new HttpsError('invalid-argument', `reason must be one of ${RR.allowedFor('return').join(', ')}.`);
  if (!VALID_RESOLUTIONS.has(resolution)) throw new HttpsError('invalid-argument', `resolution must be one of ${[...VALID_RESOLUTIONS].join(', ')}.`);

  const orderRef = db.collection('orders').doc(String(orderId));
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) throw new HttpsError('not-found', 'Order not found.');
  const order = orderSnap.data();
  if (!DI.isOrderBuyer(order, uid)) throw new HttpsError('permission-denied', 'This is not your order.');

  const elig = RE.evaluate(order, Date.now());
  if (!elig.ok) throw new HttpsError('failed-precondition', elig.message, { reason: elig.reason });
  const items = RE.deriveItems(order, productIds);
  if (!items.ok) throw new HttpsError('invalid-argument', items.message, { reason: items.reason });

  // Deterministic doc ID prevents concurrent duplicates; check + create are atomic
  const returnRef = db.collection('returns').doc('ret_' + orderId + '_' + uid);
  const now = Timestamp.now();
  let isReplay = false;
  await db.runTransaction(async (txn) => {
    const snap = await txn.get(returnRef);
    if (snap.exists) { isReplay = true; return; }
    txn.set(returnRef, {
      returnId:    returnRef.id,
      orderId:     String(orderId),
      buyerUid:    uid,
      sellerUid:   DI.orderSellerUid(order),
      shopId:      order.shopId || null,
      items:       items.items,                      /* from the ORDER — never the client */
      itemNote:    String(itemNote).slice(0, 200) || null,
      reason:      _reason.code,                      /* canonical code, never an alias */
      description: String(description).slice(0, 1000),
      resolution,                                     /* the outcome the BUYER requested — not a decision */
      policyId:    RE.RETURNS_POLICY.id,
      deliveredAt: Timestamp.fromMillis(elig.deliveredMs),
      windowEndsAt: Timestamp.fromMillis(elig.windowEndsMs),
      evidenceRequired: RE.evidenceRequired(_reason.code),
      evidence:    [],
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
  if (isReplay) throw new HttpsError('already-exists', 'A return has already been requested for this order.');
  return { returnId: returnRef.id, status: 'submitted', evidenceRequired: RE.evidenceRequired(_reason.code),
    windowEndsAt: new Date(elig.windowEndsMs).toISOString() };
});

// ── 2. getMyReturns ──────────────────────────────────────────────────────────
exports.getMyReturns = onCall({ region: REGION, timeoutSeconds: 30 }, async (req) => {
  _auth(req);
  const uid = req.auth.uid;
  const snap = await db.collection('returns')
    .where('buyerUid', '==', uid)
    .orderBy('submittedAt', 'desc')
    .limit(50).get();
  return snap.docs.map(d => d.data());
});

// ── 3. getSellerReturns ──────────────────────────────────────────────────────
exports.getSellerReturns = onCall({ region: REGION, timeoutSeconds: 30 }, async (req) => {
  /* Scoped by DATA (sellerUid == caller), not by a seller claim: SOKONI identifies sellers by their
     orders, and the claim is not minted for every merchant. An account that sells nothing sees nothing. */
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const uid = req.auth.uid;
  const { status } = req.data || {};

  let q = db.collection('returns');

  if (!req.auth.token.admin && !req.auth.token.superAdmin) {
    // Sellers only see their own
    q = q.where('sellerUid', '==', uid);
  }
  if (status) q = q.where('status', '==', status);
  q = q.orderBy('submittedAt', 'desc').limit(100);

  const snap = await q.get();
  return snap.docs.map(d => {
    const r = d.data();
    // Mask buyer name for seller (not needed for admin)
    /* Every non-admin caller is a seller here (the list is scoped to sellerUid == caller), claim or not —
       so the buyer's name is masked for all of them, not only for accounts holding the seller claim. */
    if (!req.auth.token.admin && !req.auth.token.superAdmin) {
      r.buyerName = r.buyerName ? r.buyerName.slice(0, 1) + '***' : 'Buyer';
    }
    return r;
  });
});

// ── 4. reviewReturn ──────────────────────────────────────────────────────────
exports.reviewReturn = onCall({ region: REGION, timeoutSeconds: 60 }, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');   /* ownership checked below, by data */
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
    const _isAdmin = !!(req.auth.token.admin || req.auth.token.superAdmin);
    if (!_isAdmin && ret.sellerUid !== uid) {
      throw new HttpsError('permission-denied', 'Only this return\'s seller or an admin can review it.');
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
