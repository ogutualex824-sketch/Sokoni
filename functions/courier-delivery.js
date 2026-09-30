/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — COURIER QUOTE + SERVER-AUTHORED DELIVERY
   functions/courier-delivery.js
   ══════════════════════════════════════════════════════════════════════════════
       facts ─▶ getCourierQuote ─▶ courierQuotes/{quoteId}
                                        │  priced by courier-pricing, version-stamped
                                        ▼
                createCourierDelivery ─▶ deliveries/{ref}      financials from the QUOTE
                                     └─▶ deliveryFees/{…}      status 'no-rider'
                                        │
                                        ▼
                          courier_delivery payment intent
                                        ▼
                             IntaSend ─▶ webhook ─▶ settlement

   THE CLIENT SUPPLIES FACTS, NOT FIGURES. vehicleType, distanceKm, weight and urgency
   are inputs to a calculation the server performs; deliveryFee, riderFeeKES,
   platformFeeKES, driverNet, platformCut and platformSellerUid are never read from a
   request anywhere in this file.

   THE DELIVERY IS PRICED FROM THE QUOTE, NOT RE-PRICED. createCourierDelivery re-reads
   courierQuotes/{quoteId} and copies its figures. Re-running the pricer would let a
   catalogue change between quote and booking silently move the price after the customer
   agreed to it.

   NO RIDER IS INVENTED AT BOOKING. Dispatch assigns a rider afterwards, so the ledger row
   is created with riderUid null and status 'no-rider' — the exact vocabulary the existing
   order-delivery ledger already uses (onOrderStatusChange writes 'credited' | 'pending' |
   'no-rider'). Converging on that rather than inventing a second split model.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const CP = require('./courier-pricing');

const QUOTES = 'courierQuotes';
const DELIVERIES = 'deliveries';
const FEES = 'deliveryFees';

const _db = () => admin.firestore();
const _ts = () => admin.firestore.FieldValue.serverTimestamp();
const _cfg = { region: 'us-central1', enforceAppCheck: true, memory: '256MiB', timeoutSeconds: 30 };

function _requireAuth(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  return String(request.auth.uid);
}

/* ── 1. THE QUOTE ──────────────────────────────────────────────────────────── */
exports.getCourierQuote = onCall(_cfg, async (request) => {
  const uid = _requireAuth(request);
  const d = request.data || {};

  /* Only these four reach the pricer. Anything else in the request is ignored — not
     rejected, ignored, which is stronger: there is no validation branch to get wrong. */
  const q = CP.quote({
    vehicleType: d.vehicleType,
    distanceKm:  d.distanceKm,
    weight:      d.weight,
    urgency:     d.urgency,
  });

  const db = _db();
  const now = Date.now();
  const ref = db.collection(QUOTES).doc();
  const payload = {
    quoteId:        ref.id,
    uid,                                   /* who may spend this quote */
    ...q,                                  /* fee, split, version, facts */
    expiresAtMs:    now + CP.QUOTE_TTL_MS,
    createdAt:      _ts(),
    consumedBy:     null,                  /* set once, by createCourierDelivery */
  };
  await ref.set(payload);

  /* Payability is reported, never silently assumed. A quote can be shown while the
     commercial values await approval; a payment cannot be taken against it. */
  const problems = await CP.payabilityProblems(db, q.pricingVersion);

  return {
    quoteId:        ref.id,
    pricingVersion: q.pricingVersion,
    pricingApproved: q.pricingApproved,
    currency:       q.currency,
    deliveryFee:    q.deliveryFee,
    riderFeeKES:    q.riderFeeKES,
    platformFeeKES: q.platformFeeKES,
    distanceKm:     q.distanceKm,
    expiresAtMs:    payload.expiresAtMs,
    payable:        problems.length === 0,
    blockers:       problems,
  };
});

/* ── 2. THE SERVER-AUTHORED DELIVERY ───────────────────────────────────────── */
exports.createCourierDelivery = onCall(_cfg, async (request) => {
  const uid = _requireAuth(request);
  const d = request.data || {};
  const quoteId = String(d.quoteId || '').trim();
  if (!quoteId) throw new HttpsError('invalid-argument', 'quoteId is required.');

  const db = _db();
  const qRef = db.collection(QUOTES).doc(quoteId);
  const dRef = db.collection(DELIVERIES).doc();

  /* The quote is claimed inside a transaction, so two taps cannot both spend it. */
  const q = await db.runTransaction(async (txn) => {
    const snap = await txn.get(qRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Quote not found.');
    const qq = snap.data() || {};
    if (String(qq.uid) !== uid) throw new HttpsError('permission-denied', 'This quote is not yours.');
    if (qq.consumedBy) throw new HttpsError('already-exists', 'This quote has already been used.');
    if (!(Number(qq.expiresAtMs) > Date.now())) {
      throw new HttpsError('failed-precondition', 'This quote has expired. Please request a new one.');
    }
    txn.update(qRef, { consumedBy: dRef.id, consumedAt: _ts() });
    return qq;
  });

  /* Facts the customer supplies about the JOB. None of them touch money. */
  const facts = {
    senderName:      String(d.senderName || '').slice(0, 120),
    senderPhone:     String(d.senderPhone || '').slice(0, 24),
    recipientName:   String(d.recipientName || '').slice(0, 120),
    recipientPhone:  String(d.recipientPhone || '').slice(0, 24),
    pickupAddress:   String(d.pickupAddress || '').slice(0, 300),
    deliveryAddress: String(d.deliveryAddress || '').slice(0, 300),
    pickupCoords:    d.pickupCoords || null,
    deliveryCoords:  d.deliveryCoords || null,
    packageType:     String(d.packageType || 'parcel').slice(0, 40),
    notes:           String(d.notes || '').slice(0, 500),
    deliveryType:    String(d.deliveryType || 'instant').slice(0, 24),
    category:        String(d.category || 'general').slice(0, 40),
  };

  const deliveryRef = 'DLV' + dRef.id.slice(0, 8).toUpperCase();

  await dRef.set({
    ...facts,
    id:             dRef.id,
    deliveryRef,
    senderUid:      uid,
    /* ── authoritative financials, copied from the quote ── */
    deliveryFee:    q.deliveryFee,
    riderFeeKES:    q.riderFeeKES,
    platformCut:    q.platformFeeKES,
    pricingVersion: q.pricingVersion,
    quoteId,
    currency:       q.currency,
    /* ── the priced facts, so the record explains its own price ── */
    vehicleType:    q.vehicleType,
    distanceKm:     q.distanceKm,
    weight:         q.weight,
    urgency:        q.urgency,
    /* ── lifecycle ── */
    status:         'pending_payment',
    paymentStatus:  'unpaid',
    assignedRiderId: null,
    createdAt:      _ts(),
    createdBy:      'createCourierDelivery',
  });

  /* The ledger row, in the vocabulary the order-delivery ledger already uses. No rider
     exists yet, so none is named and nothing is credited. */
  await db.collection(FEES).add({
    deliveryId:     dRef.id,
    deliveryRef,
    orderId:        null,
    sellerUid:      null,          /* a courier job has no seller */
    riderUid:       null,          /* resolved at dispatch, never at booking */
    platformFeeKES: q.platformFeeKES,
    riderFeeKES:    q.riderFeeKES,
    totalFeeKES:    q.deliveryFee,
    pricingVersion: q.pricingVersion,
    source:         'courier',
    status:         'no-rider',
    creditedAt:     null,
    createdAt:      _ts(),
  });

  return {
    deliveryId:  dRef.id,
    deliveryRef,
    deliveryFee: q.deliveryFee,
    currency:    q.currency,
    pricingVersion: q.pricingVersion,
  };
});

module.exports.QUOTES = QUOTES;
module.exports.DELIVERIES = DELIVERIES;
module.exports.FEES = FEES;
