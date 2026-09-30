'use strict';
const _ac = require('./admin-claim');
/**
 * SOKONI Buyer Dispute Portal — Cloud Functions v1.0
 * 7 functions covering full dispute lifecycle for buyers, sellers, and admins.
 * Disputes written to `disputes` collection trigger ADE adeOnDisputeCreated automatically.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

/* THE ELIGIBILITY AUTHORITY. Who may open a dispute, and until when, is decided in a
   pure module so it can be reasoned about and tested without a database. */
const ELIG = require('./dispute-eligibility');
const PIN  = require('./warranty-pin');
/* Reusing the warranty rail's own delivery reader rather than writing a second one:
   two functions answering "was this delivered" is two answers waiting to disagree. */
const { deliveryFacts } = require('./warranty-returns')._internal;

const db         = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

/* ONE VOCABULARY. Derived from the eligibility authority rather than restated here —
   a reason this rail accepts but that authority has never heard of would be a dispute
   with no window, and a reason the authority knows that this rail rejects would be a
   complaint a buyer cannot make. */
const VALID_REASONS = ELIG.DISPUTE_REASON_KEYS;
const OPEN_STATUSES = ['open', 'investigating', 'seller_responded'];

function _requireAuth(auth) {
  if (!auth) throw new HttpsError('unauthenticated', 'Login required');
}
function _san(v, max) {
  if (typeof v !== 'string') return v;
  return v.replace(/[<>"'&]/g, c => ({'<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#x27;','&':'&amp;'}[c])).slice(0, max || 2000);
}

// ─── createDispute — buyer raises a dispute against an order ─────────────────
exports.createDispute = onCall({ enforceAppCheck: true }, async request => {
  _requireAuth(request.auth);
  const uid = request.auth.uid;
  const { orderId, reason, description } = request.data;

  if (!orderId || !reason || !description)
    throw new HttpsError('invalid-argument', 'orderId, reason, description required');
  if (!VALID_REASONS.includes(reason))
    throw new HttpsError('invalid-argument', 'Invalid reason');
  if (String(description).trim().length < 10)
    throw new HttpsError('invalid-argument', 'Please provide a more detailed description');

  const orderDoc = await db.collection('orders').doc(orderId).get();
  if (!orderDoc.exists) throw new HttpsError('not-found', 'Order not found');
  const order = Object.assign({ id: orderId }, orderDoc.data());

  /* ── WAS IT ACTUALLY DELIVERED ───────────────────────────────────────────
     From the delivery job's own confirmed receipt where there is one — the moment a
     rider and a buyer jointly confirmed with a PIN — and only then from the order's
     status, which other paths can advance without anything reaching a doorstep. */
  const delivery = await deliveryFacts(order).catch(() => ({ delivered: false, deliveredAt: null }));

  /* ── THE SELLER'S OWN PROMISE, AS PINNED AT PURCHASE ─────────────────────
     Not the policy currently on the listing: a seller may have shortened or deleted
     that since the sale, and a promise that can be edited afterwards is not a promise.
     `lineIndex` names which item is being disputed; without one the complaint is about
     the order as a whole and falls to the platform term. */
  const view = PIN.warrantyView(order, { deliveredAt: delivery.deliveredAt });
  const lineIndex = (request.data && request.data.lineIndex);
  const line = (view && view.ok && Array.isArray(view.lines) && lineIndex != null && lineIndex !== '')
    ? view.lines.find(l => String(l.line) === String(lineIndex)) || null
    : null;

  /* An open dispute already on this order — read here so the authority can name it
     rather than the buyer meeting a bare refusal. */
  const priorSnap = await db.collection('disputes').doc('dp_' + orderId).get();
  const prior = priorSnap.exists ? priorSnap.data() : null;
  const priorOpen = prior && OPEN_STATUSES.includes(prior.status) ? priorSnap.id : null;

  /* ── THE DECISION ────────────────────────────────────────────────────────
     Ownership, payment, receipt and the deadline, all answered by the authority. This
     rail previously measured a flat 30 days from delivery-or-creation for every
     complaint, which ignored the warranty the buyer actually purchased: a seller
     offering 6 months and a seller offering none were enforced identically. */
  const verdict = ELIG.eligibility({
    order, uid, reason, line,
    delivery,
    purchasedAt: order.createdAt || null,
    existingOpenDisputeId: priorOpen,
  });

  if (!verdict.ok) {
    const HUMAN = {
      NOT_YOUR_ORDER:   ['permission-denied',   'This is not your order'],
      ORDER_NOT_PAID:   ['failed-precondition', 'This order has not been paid for yet'],
      ORDER_HAS_NO_BUYER:['failed-precondition','This order has no buyer on record'],
      NOT_DELIVERED_YET:['failed-precondition', verdict.detail ||
        'This can be raised once the item reaches you.'],
      WINDOW_CLOSED:    ['failed-precondition', 'The window for raising this has closed'],
      ALREADY_OPEN:     ['already-exists',      'An open dispute already exists for this order'],
      UNKNOWN_REASON:   ['invalid-argument',    'Invalid reason'],
      NO_ANCHOR_DATE:   ['failed-precondition', 'This order has no date we can measure from'],
    }[verdict.reason] || ['failed-precondition', 'This dispute cannot be opened'];
    throw new HttpsError(HUMAN[0], HUMAN[1]);
  }

  // Deterministic doc ID prevents concurrent duplicates; check + create are atomic
  const disputeRef = db.collection('disputes').doc('dp_' + orderId);
  let isReplay = false;
  let replayData = null;

  await db.runTransaction(async (txn) => {
    const snap = await txn.get(disputeRef);
    if (snap.exists) { isReplay = true; replayData = snap.data(); return; }

    txn.set(disputeRef, {
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

      /* WHAT GOVERNED THIS DISPUTE, recorded at the moment it opened. Months later
         the question "why was this still in time" has to be answerable from the
         document itself — recomputing it against today's policy would answer a
         different question. */
      lineIndex:     (lineIndex == null || lineIndex === '') ? null : Number(lineIndex),
      productId:     line ? (line.productId || null) : null,
      governedBy:    verdict.governedBy,
      policyVersion: (verdict.window && verdict.window.policyVersion) || null,
      windowExpiresAt: (verdict.window && verdict.window.expiresAt) || null,
      deliveredAt:   delivery.deliveredAt || null,

      /* NOT AN OUTCOME. Recorded so nothing downstream can mistake the absence of a
         decision for a decision of "no fault". */
      fault:         verdict.fault,
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
  });

  if (isReplay) {
    if (OPEN_STATUSES.includes(replayData.status))
      throw new HttpsError('already-exists', 'An open dispute already exists for this order');
    return { disputeId: disputeRef.id, idempotent: true };
  }

  return { disputeId: disputeRef.id };
});

// ─── getMyDisputes — buyer's full dispute history ────────────────────────────
exports.getMyDisputes = onCall({ enforceAppCheck: true }, async request => {
  _requireAuth(request.auth);
  const snap = await db.collection('disputes').where('buyerId', '==', request.auth.uid).get();
  const items = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  return { disputes: items };
});

// ─── getDisputeDetail — buyer, seller, or admin ──────────────────────────────
exports.getDisputeDetail = onCall({ enforceAppCheck: true }, async request => {
  _requireAuth(request.auth);
  const uid = request.auth.uid;
  const { disputeId } = request.data;
  if (!disputeId) throw new HttpsError('invalid-argument', 'disputeId required');

  const snap = await db.collection('disputes').doc(disputeId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Dispute not found');
  const data = snap.data();

  const t     = request.auth.token;
  const admin = _ac.isSupport(t);
  if (data.buyerId !== uid && data.sellerId !== uid && !admin)
    throw new HttpsError('permission-denied', 'Not authorised');

  return { dispute: { id: snap.id, ...data } };
});

// ─── addDisputeEvidence — buyer or seller adds evidence ──────────────────────
exports.addDisputeEvidence = onCall({ enforceAppCheck: true }, async request => {
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
exports.sellerRespondToDispute = onCall({ enforceAppCheck: true }, async request => {
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
exports.cancelDispute = onCall({ enforceAppCheck: true }, async request => {
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
exports.getSellerDisputes = onCall({ enforceAppCheck: true }, async request => {
  _requireAuth(request.auth);
  const snap = await db.collection('disputes').where('sellerId', '==', request.auth.uid).get();
  const items = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
  return { disputes: items };
});

// ─── adminGetAllDisputes — admin/superAdmin lists all disputes ────────────────
exports.adminGetAllDisputes = onCall({ enforceAppCheck: true }, async request => {
  _requireAuth(request.auth);
  const t = request.auth.token;
  if (!_ac.isAdmin(t))
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
exports.adminResolveDispute = onCall({ enforceAppCheck: true }, async request => {
  _requireAuth(request.auth);
  const t = request.auth.token;
  if (!_ac.isAdmin(t))
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
