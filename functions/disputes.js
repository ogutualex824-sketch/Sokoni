'use strict';
const _ac = require('./admin-claim');
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
/* 'under_review' is LEGACY: automation-engine's autoOnDisputeCreate wrote it onto every new dispute until 2026-09-29,
   which locked the dispute for everyone (it was in no open list). It is honoured as open — "SOKONI is reviewing" —
   so those disputes work again without a data migration. Nothing writes it any more. */
const OPEN_STATUSES = ['open', 'investigating', 'seller_responded', 'under_review'];
const FINAL_STATUSES = ['resolved', 'closed'];

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

  return _adminList(request.data || {});
});

/* ── The admin list, shared by trust-safety.html (adminGetAllDisputes), AdminOS and super admin
   (adminOsDispatch → adminGetDisputes). 2026-09-29.
   status: 'active' (default — every open status, incl. legacy under_review) | 'final' | 'all' | one status.
   Queries by status only and sorts in memory, so no composite index is needed; a query failure is an ERROR, never an
   empty list ("No open disputes" while the query had failed was the old AdminOS behaviour).
   Each row carries buyerName / sellerName from users/{uid} — disputes never stored names, so AdminOS showed "—". */
function _ts(v) { return v && typeof v.toMillis === 'function' ? v.toMillis() : (v && v.seconds ? v.seconds * 1000 : (typeof v === 'string' ? Date.parse(v) || 0 : 0)); }
function _iso(v) { const ms = _ts(v); return ms ? new Date(ms).toISOString() : null; }
async function _names(uids) {
  const ids = [...new Set(uids.filter((u) => typeof u === 'string' && u && !u.includes('/')))].slice(0, 300);
  const out = {};
  if (!ids.length) return out;
  const snaps = await db.getAll(...ids.map((u) => db.collection('users').doc(u)));
  snaps.forEach((s) => {
    const u = s.exists ? (s.data() || {}) : {};
    out[s.id] = String(u.businessName || u.displayName || u.name || u.fullName || '').slice(0, 80) || null;
  });
  return out;
}
function _row(id, d, names) {
  return {
    id, orderId: d.orderId || null, buyerId: d.buyerId || null, sellerId: d.sellerId || null,
    buyerName: names[d.buyerId] || null, sellerName: names[d.sellerId] || null,
    reason: d.reason || null, description: d.description || null, amount: typeof d.amount === 'number' ? d.amount : null,
    status: d.status || null, open: OPEN_STATUSES.includes(d.status),
    sellerResponse: d.sellerResponse || null, sellerRespondedAt: _iso(d.sellerRespondedAt),
    evidenceCount: Array.isArray(d.evidence) ? d.evidence.length : 0,
    resolution: d.resolution || null, favorBuyer: typeof d.favorBuyer === 'boolean' ? d.favorBuyer : null,
    createdAt: _iso(d.createdAt), updatedAt: _iso(d.updatedAt), resolvedAt: _iso(d.resolvedAt),
  };
}
async function _adminList(data) {
  const status = String(data.status || 'active');
  const lim = Math.min(Math.max(Number(data.limit) || 100, 1), 300);
  let q = db.collection('disputes');
  if (status === 'active') q = q.where('status', 'in', OPEN_STATUSES);
  else if (status === 'final') q = q.where('status', 'in', FINAL_STATUSES);
  else if (status !== 'all') {
    if (![...OPEN_STATUSES, ...FINAL_STATUSES].includes(status)) throw new HttpsError('invalid-argument', 'Unknown status filter.');
    q = q.where('status', '==', status);
  }
  const snap = await (status === 'all' ? q.orderBy('createdAt', 'desc').limit(lim) : q.limit(lim)).get();
  const docs = snap.docs.map((d) => ({ id: d.id, d: d.data() || {} }));
  const names = await _names(docs.flatMap((x) => [x.d.buyerId, x.d.sellerId]));
  const disputes = docs.map((x) => _row(x.id, x.d, names)).sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  return { disputes, items: disputes, count: disputes.length, status };
}

// ─── adminResolveDispute — admin resolves or updates a dispute status ─────────
const _adminResolve = async request => {
  _requireAuth(request.auth);
  const t = request.auth.token;
  if (!_ac.isAdmin(t))
    throw new HttpsError('permission-denied', 'Admin access required');

  const uid = request.auth.uid;
  const { disputeId, action, resolution } = request.data || {};
  /* who the decision favours — recorded when resolving (AdminOS asks); never inferred */
  const favorBuyer = typeof (request.data || {}).favorBuyer === 'boolean' ? request.data.favorBuyer : null;
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
    note:      `Status changed to ${action}${action === 'resolved' && favorBuyer !== null ? (favorBuyer ? ' in the buyer\'s favour' : ' in the seller\'s favour') : ''}${resolution ? ': ' + _san(resolution, 500) : ''}`,
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
    if (action === 'resolved' && favorBuyer !== null) update.favorBuyer = favorBuyer;
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

  await db.collection('adminAudit').add({ action: 'dispute_' + action, disputeId, favorBuyer, performedBy: uid,
    createdAt: FieldValue.serverTimestamp() }).catch(() => {});
  return { success: true, disputeId, action };
};
exports.adminResolveDispute = onCall({ enforceAppCheck: true }, _adminResolve);

/* Admin detail: the whole record (timeline, evidence, seller response, order snapshot) plus the parties' names. */
const _adminDetail = async request => {
  _requireAuth(request.auth);
  if (!_ac.isAdmin(request.auth.token)) throw new HttpsError('permission-denied', 'Admin access required');
  const disputeId = String((request.data || {}).disputeId || '');
  if (!disputeId || disputeId.includes('/')) throw new HttpsError('invalid-argument', 'disputeId required');
  const snap = await db.collection('disputes').doc(disputeId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Dispute not found');
  const d = snap.data() || {};
  const names = await _names([d.buyerId, d.sellerId]);
  return { dispute: Object.assign(_row(snap.id, d, names), {
    timeline: Array.isArray(d.timeline) ? d.timeline.slice(-100) : [],
    evidence: Array.isArray(d.evidence) ? d.evidence.slice(-50) : [],
    orderSnapshot: d.orderSnapshot || null, adminNotes: d.adminNotes || null,
  }) };
};

/* Admin ops for adminOsDispatch (admin-os.js delegates here) — ONE dispute authority for AdminOS, super admin and
   trust-safety.html. */
exports._adminH = {
  adminGetDisputes: async (req) => {
    _requireAuth(req.auth);
    if (!_ac.isAdmin(req.auth.token)) throw new HttpsError('permission-denied', 'Admin access required');
    return _adminList(req.data || {});
  },
  adminGetDisputeDetail: _adminDetail,
  aosResolveDispute: _adminResolve,
};
exports.OPEN_STATUSES = OPEN_STATUSES;
