/* ══════════════════════════════════════════════════════════════════════════
   SOKONI — Role-based fulfilment QR resolution

   One package carries ONE QR code. What it reveals depends entirely on who
   scans it. This is the authorisation boundary for the whole paperless
   fulfilment flow, so it is deliberately small, explicit, and fails closed.

   WHY A SEPARATE RESOLVER, NOT AN EXTENSION OF verifyQRCode
   verifyQRCode (qr.js:88) marks one-time tokens as USED inside its transaction.
   A package QR is scanned repeatedly and by different people — seller when
   packing, rider at pickup and again at the door, customer on delivery — so
   consuming it would break fulfilment on the second scan. This reads the same
   qrTokens document and applies the same expiry rule, but never mutates it.
   It does not reimplement the token model; it reuses it read-only.

   PRIVACY MODEL — each role receives a hand-written projection, never the raw
   order document. Adding a field to `orders` therefore cannot silently widen
   what a rider or customer can see; someone has to add it to a projection here.

     seller    fulfilment data — what to pack, where it goes. No settlement.
     rider     delivery data, and ONLY while the assignment is active. Once the
               delivery is completed or reassigned the address and phone stop
               being returned: a rider retains no standing access to a
               customer's home address after the job ends.
     customer  their own order status and receipt. Never merchant internals —
               no commission, no settlement, no margin.
     admin     full record, for audit.

   Anyone with no relationship to the order is refused, even holding a valid
   token. Possession of a QR is not authorisation.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const logger = require('firebase-functions/logger');

/* Ownership fields mirror the canonical definition already in
   firestore.rules:265-270. Not a new vocabulary. */
const BUYER_FIELDS  = ['uid', 'userId', 'buyerId', 'buyerUid'];
const SELLER_FIELDS = ['sellerUid', 'sellerId', 'merchantId'];
const RIDER_FIELDS  = ['assignedDriverUid', 'riderId', 'driverId'];

/* Delivery states in which a rider legitimately needs the customer's address.

   DEFECT FIXED 2026-07-19: this was a hand-written Set containing 'assigned' and
   'accepted'. dispatch.js actually writes 'driver_assigned' and
   'driver_accepted' (dispatch.js status vocabulary), and firestore.rules:99 uses
   'rider_assigned'. None of those matched, so a rider on a genuinely ACTIVE
   delivery was judged inactive and refused the customer's address — the
   authorisation boundary was reading a vocabulary nobody writes.

   Now delegated to the canonical lifecycle, which normalises every observed
   spelling and derives the active window from stage ORDER rather than a list.
   Adding a stage between assigned and delivered can no longer silently fall out
   of the window. Unknown values fail closed. */
const LIFECYCLE = require('./fulfilment-lifecycle');

const _any = (obj, fields, uid) => fields.some((f) => obj && obj[f] && obj[f] === uid);

function _resolveRole(order, delivery, uid, token) {
  if (token.admin === true) return 'admin';
  if (_any(order, SELLER_FIELDS, uid) || _any(delivery, SELLER_FIELDS, uid)) return 'seller';
  if (_any(order, RIDER_FIELDS, uid)  || _any(delivery, RIDER_FIELDS, uid))  return 'rider';
  if (_any(order, BUYER_FIELDS, uid)) return 'customer';
  return null;
}

/* ── Projections ─────────────────────────────────────────────────────────── */

function _sellerView(order, delivery) {
  return {
    orderNo:      order.orderNo || order.id || null,
    status:       order.status || null,
    fulfilment:   order.fulfilment || order.deliveryMethod || null,
    items:        (order.items || []).map((i) => ({
      name: i.name || i.title || null,
      qty:  i.qty || i.quantity || 1,
      sku:  i.sku || null,
      packed: i.packed === true,
    })),
    packageCount: order.packageCount || 1,
    /* Fulfilment-necessary customer data only — enough to label a parcel. */
    recipientName:  order.recipientName || order.customerName || null,
    recipientPhone: order.recipientPhone || order.customerPhone || null,
    deliveryArea:   (order.address && (order.address.area || order.address.town)) || null,
    deliveryNotes:  order.deliveryNotes || null,
    /* Deliberately absent: commission, settlement, buyer's other orders. */
  };
}

function _riderView(order, delivery, active) {
  const base = {
    orderNo:      order.orderNo || order.id || null,
    packageCount: order.packageCount || 1,
    codAmount:    order.cod === true ? (Number(order.total) || 0) : 0,
    status:       (delivery && delivery.status) || order.deliveryStatus || null,
    active,
  };
  if (!active) {
    /* Assignment over. The rider keeps no standing access to where a customer
       lives. This is the single most important line in the file. */
    return { ...base, message: 'This delivery is not currently assigned to you.' };
  }
  const a = order.address || {};
  return {
    ...base,
    recipientName:  order.recipientName || order.customerName || null,
    recipientPhone: order.recipientPhone || order.customerPhone || null,
    altPhone:       order.altPhone || null,
    address:        typeof a === 'string' ? a : {
      county: a.county || null, town: a.town || null, area: a.area || null,
      street: a.street || null, building: a.building || null,
      house: a.house || null, floor: a.floor || null, landmark: a.landmark || null,
    },
    geo:            order.deliveryGeo || (delivery && delivery.dropoffGeo) || null,
    deliveryNotes:  order.deliveryNotes || null,
    otpRequired:    order.deliveryOtpRequired === true,
    /* The OTP itself is NEVER returned. The rider types what the customer reads
       out; returning it here would let a rider self-confirm a delivery. */
  };
}

function _customerView(order, delivery) {
  return {
    orderNo:     order.orderNo || order.id || null,
    status:      order.status || null,
    deliveryStatus: (delivery && delivery.status) || order.deliveryStatus || null,
    placedAt:    order.createdAt || null,
    eta:         (delivery && delivery.eta) || order.eta || null,
    items:       (order.items || []).map((i) => ({
      name: i.name || i.title || null, qty: i.qty || i.quantity || 1,
    })),
    total:       Number(order.total) || 0,
    paymentMethod: order.paymentMethod || null,
    receiptNo:   order.receiptNo || null,
    receiptUrl:  order.receiptNo
      ? `https://mysokoni.co.ke/payment-receipt.html?ref=${encodeURIComponent(order.receiptNo)}`
      : null,
    /* Rider identity only once assigned, and only name + phone — never their
       live location or other jobs. */
    rider: (delivery && delivery.riderName)
      ? { name: delivery.riderName, phone: delivery.riderPhone || null }
      : null,
    /* Deliberately absent: commission, settlement, merchant margin, cost price. */
  };
}

function _adminView(order, delivery) {
  return {
    order,
    delivery: delivery || null,
    note: 'Full record — admin audit view',
  };
}

/* ── fulfilmentScan ──────────────────────────────────────────────────────── */

exports.fulfilmentScan = onCall({ cors: true, enforceAppCheck: true, region: 'us-central1' },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in to scan.');

    const { tokenId } = request.data || {};
    if (!tokenId || typeof tokenId !== 'string' || tokenId.length > 100) {
      throw new HttpsError('invalid-argument', 'A valid scan token is required.');
    }

    const db = getFirestore();

    /* 1. Resolve the token. Read-only — see the header note on one-time tokens. */
    const tSnap = await db.collection('qrTokens').doc(tokenId).get();
    if (!tSnap.exists) throw new HttpsError('not-found', 'QR code not recognised.');
    const t = tSnap.data() || {};
    if (t.exp && Date.now() > t.exp) throw new HttpsError('failed-precondition', 'This QR code has expired.');
    if (!t.id) throw new HttpsError('failed-precondition', 'QR code is not linked to an order.');

    /* 2. Load the order, and its delivery record if one exists. */
    const oSnap = await db.collection('orders').doc(String(t.id)).get();
    if (!oSnap.exists) throw new HttpsError('not-found', 'Order not found.');
    const order = Object.assign({ id: oSnap.id }, oSnap.data());

    let delivery = null;
    const dSnap = await db.collection('deliveries').doc(String(t.id)).get().catch(() => null);
    if (dSnap && dSnap.exists) delivery = dSnap.data();

    /* 3. Determine the caller's relationship. Claims are server-issued. */
    const claims = request.auth.token || {};
    const role = _resolveRole(order, delivery, uid, {
      admin: claims.admin === true || claims.superAdmin === true,
    });

    if (!role) {
      /* Possession of a valid QR is not authorisation. Log it — a stranger
         scanning a package is exactly the signal a fraud review wants. */
      logger.warn('[fulfilmentScan] unrelated party scanned a package', {
        uid, orderId: order.id, tokenId,
      });
      throw new HttpsError('permission-denied', 'You do not have access to this order.');
    }

    /* 4. Project. Each role gets its own hand-written view. */
    let payload;
    if (role === 'admin')         payload = _adminView(order, delivery);
    else if (role === 'seller')   payload = _sellerView(order, delivery);
    else if (role === 'customer') payload = _customerView(order, delivery);
    else {
      const state  = (delivery && delivery.status) || order.deliveryStatus || order.status;
      payload = _riderView(order, delivery, LIFECYCLE.isRiderActive(state));
    }

    /* 5. Audit every scan. Who looked at what, and as whom. */
    db.collection('fulfilmentScans').add({
      tokenId, orderId: order.id, uid, role,
      scannedAt: FieldValue.serverTimestamp(),
    }).catch(() => {});

    return { role, orderId: order.id, data: payload };
  });

/* Pure helpers exposed for the privacy regression gate
   (scripts/test-fulfilment-scan.js). Same pattern as loyalty-enterprise.js
   exports._h. Not part of the public callable surface. */
exports._h = {
  resolveRole:  _resolveRole,
  sellerView:   _sellerView,
  riderView:    _riderView,
  customerView: _customerView,
  adminView:    _adminView,
  isRiderActive: LIFECYCLE.isRiderActive,
};
