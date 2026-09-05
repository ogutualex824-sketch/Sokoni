/* ================================================================
   SOKONI — Manual-Till order lifecycle

   Implements MANUAL_TILL_ORDER_CONTRACT. Creates NOTHING new beyond one order
   state: no payment rail, no commission calculator, no wallet, no settlement
   engine. A manual-Till order is an ADDITIONAL way to enter the EXISTING order
   lifecycle.

       customer pays the merchant Till directly (SOKONI never sees it)
              ↓
       customer submits the reference
              ↓
       orders/{id}  status: awaiting_payment_attestation      ← the only new state
              ↓
       merchant verifies against their own Till and attests via POS
              ↓
       orders/{id}  status: paid                              ← rejoins the existing path
              ↓
       awaiting_confirmation → confirmed → … → completed
              ↓
       §6a commission receivable — UNCHANGED, no special handling

   THE INVARIANT THIS FILE EXISTS TO PROTECT (contract §0)

     A payment reference is evidence supplied by the CUSTOMER.
     Merchant POS confirmation is MERCHANT ATTESTATION.
     Neither independently establishes SOKONI-observed payment.

   So this file must NEVER write `paymentVerified: true`, and must never treat a
   submitted reference as payment. Only §5 attestation advances the state.

   ⚠️ STATE COLLISION — contract F1
   `awaiting_confirmation` already exists (index.js:2260) and means "the seller must
   ACCEPT this order for fulfilment". It sits AFTER payment. This state sits BEFORE
   it. They are different merchant actions and must never be merged: one says "I
   received your money", the other says "I accept your order".

   ⚠️ STOCK IS NOT TOUCHED HERE — contract §4.2, OPEN
   Whether stock is reserved during the attestation window is an unratified
   commercial decision. This module moves no stock in either direction, and the
   policy gate refuses to run at all until §4.1-4.3 are decided. Deciding it here by
   omission would be exactly the failure the contract was written to prevent.
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const { loadManualTillPolicy, UNSET_REASON } = require('./manual-till-policy');

const db     = getFirestore();
const REGION = 'us-central1';
const cfg    = { region: REGION, enforceAppCheck: true, memory: '256MiB', timeoutSeconds: 60 };

/* The one new state. Deliberately NOT `awaiting_confirmation` — see F1. */
const AWAITING_ATTESTATION = 'awaiting_payment_attestation';
/* CANONICAL for new manual-payment records. 'mpesa_till_manual' remains a LEGACY
   compatibility value for POS records already written and deployed; no historical
   rewrite is performed. The destination stays authoritative for the distinction:
   mpesa_manual + TILL, or mpesa_manual + PAYBILL. */
const METHOD               = 'mpesa_manual';
const METHOD_LEGACY_POS    = 'mpesa_till_manual';

/* Safaricom confirmation codes: 10 alphanumeric characters. Same rule the POS uses. */
const REF_RE = /^[A-Z0-9]{10}$/;
const normaliseRef = (raw) => String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/* ── Customer submits a reference → order awaiting merchant attestation ─────
   The caller supplies WHAT they are buying and the reference they were given.
   It does NOT supply the amount — that is derived server-side from product
   documents, exactly as createPaymentIntent does, so a client cannot state what
   it owes. */
exports.createManualTillOrder = onCall(cfg, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const buyerUid = request.auth.uid;

  const policy = await loadManualTillPolicy(db);
  if (!policy) throw new HttpsError('failed-precondition', UNSET_REASON);

  const { sellerUid, items, reference, buyerName, buyerPhone, address, fulfillmentType } =
    request.data || {};

  const ref = normaliseRef(reference);
  if (!REF_RE.test(ref)) {
    throw new HttpsError('invalid-argument',
      'Enter the 10-character M-PESA confirmation code from your payment.');
  }
  if (!sellerUid) throw new HttpsError('invalid-argument', 'sellerUid required.');
  if (!Array.isArray(items) || !items.length) {
    throw new HttpsError('invalid-argument', 'No items supplied.');
  }

  /* ── The shop must actually be in manual_till mode ────────────────────────
     Derived from resolveActiveDestination, which is the ONE authority on a
     shop's payment capability. checkoutPaymentMode is a projection of it, never
     a second source of truth (MULTISHOP_CHECKOUT_AUDIT §N1). */
  const { resolveActiveDestination } = require('./payment-destinations');
  const dest = await resolveActiveDestination(sellerUid);
  if (!dest) {
    throw new HttpsError('failed-precondition',
      'This shop has no verified payment destination and cannot accept orders.');
  }
  if (dest.blocked !== 'production_not_authorized') {
    /* blocked === null means the shop is STK-authorised — it must use that path.
       Allowing manual Till here would let a merchant bypass an observable rail in
       favour of a self-attested one. */
    throw new HttpsError('failed-precondition',
      'This shop is authorised for STK payment; use the standard checkout.');
  }

  /* ── Amount derived from product documents, never from the caller ─────────
     Same rule as the Single-Shop Checkout Invariant: a client may say WHAT it is
     buying, never what it costs, and never who the seller is. */
  const pids = [...new Set(items.map((i) => i && String(i.productId || i.id)).filter(Boolean))];
  if (!pids.length) throw new HttpsError('invalid-argument', 'No product ids supplied.');

  const snaps = await Promise.all(pids.map((p) => db.collection('products').doc(p).get()));
  const byId = {};
  const sellers = new Set();
  snaps.forEach((s) => {
    if (!s.exists) return;
    const d = s.data() || {};
    byId[s.id] = d;
    const su = d.sellerUid || d.sellerId;
    if (su) sellers.add(String(su));
  });
  if (Object.keys(byId).length !== pids.length) {
    throw new HttpsError('failed-precondition', 'One or more products no longer exist.');
  }

  /* Single-Shop Checkout Invariant — one payment, one shop. */
  if (sellers.size > 1) {
    throw new HttpsError('failed-precondition',
      'Order lines span multiple shops; check out one shop at a time.');
  }
  if (sellers.size === 1 && !sellers.has(String(sellerUid))) {
    throw new HttpsError('failed-precondition', 'Items do not belong to the named shop.');
  }

  let amount = 0;
  const lines = items.map((i) => {
    const pid = String(i.productId || i.id);
    const p   = byId[pid] || {};
    const qty = Math.max(1, Math.round(Number(i.qty) || 1));
    const unit = Number(p.price) || 0;
    amount += unit * qty;
    return {
      productId: pid, name: p.name || null, qty,
      price: unit, sellerUid: String(sellerUid),
    };
  });
  if (!(amount > 0)) throw new HttpsError('failed-precondition', 'Order total must be positive.');

  /* ── Reference uniqueness — the EXISTING mechanism, not a new one ─────────
     Deterministic, transactional, and a duplicate FLAGS rather than voids: the
     customer has already paid, so refusing the order would destroy the record of
     a real payment. */
  const orderId = db.collection('orders').doc().id;
  let refClaim = { ok: false, reason: 'not_attempted' };
  try {
    const claims = require('./pos-mpesa-refs');
    refClaim = await claims._claimReference({
      merchantId: sellerUid, saleId: orderId, reference: ref, amountKES: amount,
    });
  } catch (e) {
    refClaim = { ok: false, reason: 'claim_error', error: e.message };
  }

  const ts = FieldValue.serverTimestamp();
  await db.collection('orders').doc(orderId).set({
    id:        orderId,
    uid:       buyerUid,
    buyerUid,
    buyerName:  buyerName  || null,
    buyerPhone: buyerPhone || null,
    sellerUid: String(sellerUid),
    items:     lines,
    amount, total: amount, orderTotal: amount,
    currency:  'KES',
    hub:       'marketplace',
    channel:   'online',
    fulfillmentType: fulfillmentType || 'delivery',
    deliveryAddress: address || null,
    address:         address || null,

    /* ── THE STATE. Not paid. Not verified. Not claimed as observed. ──────── */
    status:            AWAITING_ATTESTATION,
    paymentStatus:     AWAITING_ATTESTATION,
    paymentMethod:     METHOD,
    /* The destination carries the TILL/PAYBILL distinction — the method name does not.
       Recorded on the order so a later reader knows what the customer was actually
       told to do, without re-reading a destination that may since have changed. */
    destinationType:      dest.destination.destinationType || null,
    destinationNumber:    dest.destination.destinationNumber || null,
    destinationAccountRef: dest.destination.accountReference ?? null,
    paymentVerified:   false,               /* NEVER true on this path */
    paymentReference:  ref,
    referenceSource:   'customer',          /* contract F2 — weaker than 'operator' */
    paymentAttestedBy: null,                /* set only by attestation (§5) */
    referenceClaim:    refClaim.ok ? 'claimed' : (refClaim.reason || 'unclaimed'),

    /* Recorded so a later reader knows which policy governed this order. */
    attestationWindowHours: policy.attestationWindowHours,
    policyDecidedBy:        policy.decidedBy,

    /* NO inventoryApplied — stock is untouched pending §4.2. */
    source:    'manual_till_checkout',
    createdAt: ts,
    updatedAt: ts,
  });

  console.log(`[manual-till] order=${orderId} seller=${sellerUid} amount=${amount} ` +
              `ref=${ref} claim=${refClaim.ok ? 'claimed' : refClaim.reason}`);

  return {
    orderId, status: AWAITING_ATTESTATION, amount,
    referenceClaimed: refClaim.ok,
    /* Told plainly, so no surface can imply SOKONI confirmed the payment. */
    message: 'Your reference has been recorded. The shop will confirm receipt of payment.',
  };
});

/* ── Merchant attests: "I received this money" ─────────────────────────────
   This is the ONLY transition that advances the payment state, and it is
   deliberately distinct from `awaiting_confirmation` (fulfilment acceptance).

   A false attestation is possible and is NOT designed away: a merchant can claim
   money they did not receive. Detection means reconciling against their own Till,
   which SOKONI cannot see. §4.6 (capability demotion) is the lever, and it is
   still open. */
exports.attestManualTillPayment = onCall(cfg, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const actor = request.auth.uid;

  const policy = await loadManualTillPolicy(db);
  if (!policy) throw new HttpsError('failed-precondition', UNSET_REASON);

  const { orderId } = request.data || {};
  if (!orderId) throw new HttpsError('invalid-argument', 'orderId required.');

  const ref = db.collection('orders').doc(String(orderId));

  const result = await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) return { ok: false, reason: 'order_not_found' };
    const d = snap.data() || {};

    /* Only the seller on the order may attest. Not the buyer, not another
       merchant — attesting is a claim about one's OWN till. */
    const token = request.auth.token || {};
    const isSeller = String(d.sellerUid) === String(actor);
    const isAdmin  = token.admin === true || token.superAdmin === true;
    if (!isSeller && !isAdmin) return { ok: false, reason: 'not_your_order' };

    /* Accept the legacy POS value too: an order written before canonicalisation is
       still a manual-payment order and must remain attestable. */
    if (d.paymentMethod !== METHOD && d.paymentMethod !== METHOD_LEGACY_POS) {
      return { ok: false, reason: 'not_a_manual_payment_order' };
    }
    if (d.status !== AWAITING_ATTESTATION) {
      /* Idempotent: a repeat attestation on an already-attested order is a no-op,
         not a second transition. */
      return { ok: d.paymentStatus === 'paid', reason: 'already_attested', status: d.status };
    }

    txn.update(ref, {
      status:        'paid',
      paymentStatus: 'paid',
      /* paymentVerified stays FALSE. Merchant attestation is not SOKONI
         observation, and no amount of merchant confidence changes that. */
      paymentVerified:   false,
      paymentAttestedBy: isAdmin && !isSeller ? 'admin_on_behalf' : 'merchant',
      attestedByUid:     actor,
      attestedAt:        FieldValue.serverTimestamp(),
      paidAt:            FieldValue.serverTimestamp(),
      updatedAt:         FieldValue.serverTimestamp(),
      /* Still NO inventoryApplied — §4.2 governs stock and is unratified. */
    });
    return { ok: true, reason: 'attested' };
  });

  if (!result.ok && result.reason === 'not_your_order') {
    throw new HttpsError('permission-denied', 'This is not your order.');
  }
  console.log(`[manual-till] attest order=${orderId} actor=${actor} -> ${result.reason}`);
  return result;
});

module.exports.AWAITING_ATTESTATION = AWAITING_ATTESTATION;
module.exports.METHOD               = METHOD;
module.exports._normaliseRef        = normaliseRef;
module.exports._REF_RE              = REF_RE;
