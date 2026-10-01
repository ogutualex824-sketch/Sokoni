/* ============================================================================
   SOKONI — seller payout readiness is an ADMIN decision (owner, 2026-10-01)
   ----------------------------------------------------------------------------
   `sellerPayoutReady` used to be set automatically — by captureProofOfDelivery at proof of
   delivery, by the buyer/sender's "I received it" (client writes to packageRequests and
   deliveries), and by sokoni-orders.buyerConfirm. Owner decision: it must be approved by an
   administrator. These two callables are the ONLY writers of the approval:

     adminListPendingSellerPayouts({ collection?, limit? })
        completed/delivered items in packageRequests · deliveries · orders whose payout is not
        yet approved (bounded; newest first by the collection's own query, filtered here).
     adminApproveSellerPayout({ collection, id, note? })
        one transaction: the item exists, is in a completed state, is not already approved,
        and the approver is not its seller (separation of duties) →
        sellerPayoutReady:true · sellerPayoutApproval:'approved' · sellerPayoutApprovedBy ·
        sellerPayoutApprovedAt, plus an adminAudit row. Repeating it is a no-op.

   Clients (and captureProofOfDelivery) no longer write the flag; Firestore rules (sokoni-32's
   combined release) refuse client writes of it. Admin-only, App Check enforced.
   ============================================================================ */
'use strict';
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = () => admin.firestore();

/* Which states mean "the service was delivered" in each collection. */
const COMPLETED = {
  packageRequests: ['delivered', 'buyer_confirmed', 'completed'],
  deliveries: ['delivered', 'completed'],
  orders: ['delivered', 'completed'],
};
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function _admin(req) {
  const t = (req.auth && req.auth.token) || {};
  if (!req.auth || !(t.admin === true || t.role === 'admin' || t.role === 'super_admin')) {
    throw new HttpsError('permission-denied', 'Administrator access required.');
  }
  return req.auth.uid;
}
const _ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : (typeof v === 'number' ? v : null));
function _row(collection, d) {
  const x = d.data() || {};
  const at = _ms(x.completedAt) || _ms(x.buyerConfirmedAt) || _ms(x.deliveredAt) || _ms(x.updatedAt);
  return {
    collection, id: d.id, status: x.status || null,
    sellerUid: x.sellerUid || null, buyerUid: x.buyerUid || x.uid || null,
    amountKES: typeof x.sellerNet === 'number' ? x.sellerNet : (typeof x.orderTotal === 'number' ? x.orderTotal : (typeof x.total === 'number' ? x.total : null)),
    completedAt: at ? new Date(at).toISOString() : null,
  };
}

async function listPending(data) {
  const lim = Math.min(Math.max(Math.floor(Number(data && data.limit) || 100), 1), 200);
  const only = data && data.collection;
  if (only && !COMPLETED[only]) throw new HttpsError('invalid-argument', 'Unknown collection.');
  const out = []; const unreadable = [];
  for (const c of (only ? [only] : Object.keys(COMPLETED))) {
    try {
      const snap = await db().collection(c).where('status', 'in', COMPLETED[c]).limit(lim).get();
      snap.docs.forEach((d) => { if ((d.data() || {}).sellerPayoutReady !== true) out.push(_row(c, d)); });
    } catch (e) {
      logger.error('[payout-approval] list failed', { collection: c, error: e.message });
      unreadable.push(c);   /* reported, never shown as "nothing pending" */
    }
  }
  out.sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')));
  return { pending: out.slice(0, lim), count: Math.min(out.length, lim), truncated: out.length > lim, unreadable };
}

async function approve(adminUid, data) {
  const collection = data && data.collection, id = data && data.id;
  if (!COMPLETED[collection]) throw new HttpsError('invalid-argument', 'Unknown collection.');
  if (!ID_RE.test(String(id || ''))) throw new HttpsError('invalid-argument', 'Invalid id.');
  const note = data && typeof data.note === 'string' ? data.note.slice(0, 300) : null;
  const ref = db().collection(collection).doc(id);
  const result = await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Item not found.');
    const x = snap.data() || {};
    if (!COMPLETED[collection].includes(x.status)) throw new HttpsError('failed-precondition', 'Only a delivered or completed item can be approved for payout.');
    if (x.sellerUid && x.sellerUid === adminUid) throw new HttpsError('permission-denied', 'You cannot approve a payout to yourself.');
    if (x.sellerPayoutReady === true && x.sellerPayoutApproval === 'approved') return { already: true };
    tx.update(ref, {
      sellerPayoutReady: true, sellerPayoutApproval: 'approved',
      sellerPayoutApprovedBy: adminUid, sellerPayoutApprovedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(note ? { sellerPayoutApprovalNote: note } : {}),
    });
    tx.set(db().collection('adminAudit').doc(), {
      action: 'seller_payout_approved', collection, docId: id, sellerUid: x.sellerUid || null,
      by: adminUid, note, at: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { already: false };
  });
  logger.info('[payout-approval] approved', { collection, id, by: adminUid, already: result.already });
  return { ok: true, already: result.already };
}

const OPTS = { region: 'us-central1', enforceAppCheck: true, maxInstances: 5, memory: '256MiB', timeoutSeconds: 30 };
exports.adminListPendingSellerPayouts = onCall(OPTS, async (req) => { _admin(req); return listPending(req.data || {}); });
exports.adminApproveSellerPayout = onCall(OPTS, async (req) => approve(_admin(req), req.data || {}));
exports._internal = { listPending, approve, _admin, COMPLETED };
