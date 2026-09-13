'use strict';
/* ════════════════════════════════════════════════════════════════════════════════════════
   DELIVERY QUOTE ENDPOINT — the browser's only route to a delivery price.

   Gate C. The census proved the checkout path never reached the Step 4 authority: the browser
   computed a fee (`sokoni-delivery-pricing.js`, 0.82 share), assigned it at checkout.html:3742,
   and `createCheckoutSession` accepted it from `request.data` behind nothing but a
   `clamp(0…5000)`. Any value in that range was charged verbatim.

   This module gives the browser a way to ASK and takes away its ability to TELL.

   THE QUOTE IS PERSISTED, AND THAT IS THE POINT.
   A returned-but-unstored quote cannot be verified later: a forged `quoteId` would be
   indistinguishable from a real one, and checkout would be trusting the client again by a longer
   route. Every issued quote is written to `deliveryQuotes/{quoteId}` by the server, and checkout
   resolves the STORED figures — never the ones the browser sends back.

   BOUND TO THE BUYER AND SINGLE-USE AT CHECKOUT. A quote is an offer to one account for one
   order; without binding, a cheap quote could be harvested and replayed against a different,
   dearer cart.

   This module consumes Step 4. It does not re-price, re-derive, or adjust anything.
   ════════════════════════════════════════════════════════════════════════════════════════ */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const logger = require('firebase-functions/logger');

const dqa = require('./delivery-quote-authority');
const vsa = require('./vehicle-selection-authority');

const REGION = 'us-central1';
const QUOTES = 'deliveryQuotes';

/* A quote is an offer with a shelf life. Economics move — fuel, demand, policy — and an
   indefinitely valid quote is a standing promise nobody agreed to make. */
const QUOTE_TTL_MS = 30 * 60 * 1000;

const db = () => admin.firestore();
const now = () => admin.firestore.FieldValue.serverTimestamp();

/* ── Issue ─────────────────────────────────────────────────────────────────────────────── */
exports.requestDeliveryQuote = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '256MiB', cors: true },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in to get a delivery quote');

    const input = request.data || {};

    /* The browser may describe the TRIP. It may not state the PRICE. This refuses a payload
       carrying deliveryFee / riderEarning / platformCut / quoteId / pricingVersion and so on,
       rather than quietly ignoring them — a silently dropped field teaches a caller that sending
       it is harmless. */
    try { dqa.assertNoClientPricing(input); }
    catch (e) { throw new HttpsError('invalid-argument', 'Pricing fields cannot be supplied: ' + (e.detail || e.reason)); }

    const policy = await dqa.loadPolicy(db());
    if (!policy) {
      /* Absent, unapproved, malformed, or not yet in force. Identical outcome by design: no price. */
      throw new HttpsError('failed-precondition',
        'Delivery pricing is not available right now.');
    }

    /* Vehicle comes from the SELECTION AUTHORITY, not from the caller. A requested class is
       validated against the shipment; it is never simply honoured. */
    const shipment = input.shipment || {};
    let selection;
    try {
      selection = input.vehicleType
        ? vsa.assertVehicleSuitable(input.vehicleType, shipment, policy)
        : vsa.selectVehicle(shipment, policy);
    } catch (e) {
      throw new HttpsError('failed-precondition', e.reason || 'vehicle_selection_failed', { reason: e.reason });
    }

    let quote;
    try {
      quote = dqa.quote({
        vehicleType: selection.vehicleClass,
        distanceKm: input.distanceKm,
        estimatedMinutes: input.estimatedMinutes,
        demandIndex: 1,                       /* v1 policy has demandWeight 0; inert by construction */
        packageCount: selection.shipment.packageCount,
        shopCount: selection.shipment.pickupCount,
        fragile: selection.shipment.fragile === true,
      }, policy);
    } catch (e) {
      throw new HttpsError('failed-precondition', e.reason || 'quote_refused', { reason: e.reason });
    }

    /* Persist BEFORE returning. If the write fails the caller gets no quote, rather than a
       quoteId that checkout will later be unable to resolve. */
    const record = {
      quoteId: quote.quoteId,
      pricingVersion: quote.pricingVersion,
      policyVersion: quote.pricingInputs.policy.policyVersion,
      buyerUid: uid,
      vehicleClass: quote.vehicleType,
      vehicleSelectionReason: selection.vehicleSelectionReason,
      capacityBasis: selection.capacityBasis,
      customerChargeMinor: quote.customerCharge.minorUnits,
      riderEarningMinor: quote.riderEarning.minorUnits,
      sokoniCommissionMinor: quote.sokoniCommission.minorUnits,
      sokoniSharePct: quote.sokoniSharePct,
      distanceKm: quote.distanceKm,
      estimatedMinutes: quote.estimatedMinutes,
      pricingInputs: JSON.parse(JSON.stringify(quote.pricingInputs)),
      status: 'issued',
      issuedAt: now(),
      expiresAtMs: Date.now() + QUOTE_TTL_MS,
    };
    await db().collection(QUOTES).doc(quote.quoteId).create(record);

    /* What the browser gets back is for DISPLAY. None of it is trusted on the way in again:
       checkout resolves the stored record by id. */
    return {
      quoteId: quote.quoteId,
      pricingVersion: quote.pricingVersion,
      policyVersion: record.policyVersion,
      vehicleClass: quote.vehicleType,
      vehicleSelectionReason: selection.vehicleSelectionReason,
      customerChargeKES: quote.customerCharge.minorUnits / 100,
      customerChargeMinor: quote.customerCharge.minorUnits,
      riderEarningKES: quote.riderEarning.minorUnits / 100,
      sokoniSharePct: quote.sokoniSharePct,
      expiresAtMs: record.expiresAtMs,
    };
  }
);

/* ── Resolve at checkout ───────────────────────────────────────────────────────────────────
   Returns the STORED delivery charge in minor units, or throws. Never accepts a figure from the
   caller; the only thing the caller supplies is an id. */
async function resolveQuoteForCheckout(quoteId, buyerUid, _db) {
  /* `_db` is a declared test seam, not a back door: production never passes it, and it carries no
     ability to alter a figure — it only supplies where the stored quote is read from, so the
     refusal paths below can be exercised without manufacturing production data. */
  const store = _db || db();
  if (!quoteId || typeof quoteId !== 'string') {
    throw new HttpsError('invalid-argument', 'A delivery quoteId is required');
  }
  const snap = await store.collection(QUOTES).doc(quoteId).get();
  /* A forged or unknown id resolves to nothing. This is the check that makes persistence
     worthwhile — without it, any string would pass. */
  if (!snap.exists) throw new HttpsError('failed-precondition', 'delivery_quote_not_found');

  const q = snap.data();
  if (q.buyerUid !== buyerUid) throw new HttpsError('permission-denied', 'delivery_quote_not_yours');
  if (q.status !== 'issued') throw new HttpsError('failed-precondition', 'delivery_quote_already_used');
  if (Number(q.expiresAtMs) < Date.now()) throw new HttpsError('failed-precondition', 'delivery_quote_expired');

  /* The schema version must still match, and the commercial policy must still be the one that
     priced it. Both are Step 4 contracts, re-checked here rather than assumed. */
  if (q.pricingVersion !== dqa.PRICING_VERSION) {
    throw new HttpsError('failed-precondition', 'delivery_quote_pricing_version_stale');
  }
  const policy = await dqa.loadPolicy(store);
  if (!policy) throw new HttpsError('failed-precondition', 'delivery_pricing_unavailable');
  if (String(policy.policyVersion) !== String(q.policyVersion)) {
    throw new HttpsError('failed-precondition', 'delivery_quote_policy_changed');
  }

  /* Re-assert the money contract on the STORED figures: conservation and the commercial band.
     A record tampered with directly cannot be settled into a charge. */
  try {
    dqa.assertSettleable({
      quoteId: q.quoteId,
      pricingVersion: q.pricingVersion,
      sokoniSharePct: q.sokoniSharePct,
      customerCharge: { currency: 'KES', minorUnits: q.customerChargeMinor },
      riderEarning: { currency: 'KES', minorUnits: q.riderEarningMinor },
      sokoniCommission: { currency: 'KES', minorUnits: q.sokoniCommissionMinor },
      pricingInputs: q.pricingInputs,
    }, null, { currentPolicy: policy });
  } catch (e) {
    logger.error('[deliveryQuote] stored quote failed revalidation', { quoteId, reason: e.reason });
    throw new HttpsError('failed-precondition', 'delivery_quote_invalid');
  }

  return {
    quoteId: q.quoteId,
    pricingVersion: q.pricingVersion,
    policyVersion: q.policyVersion,
    vehicleClass: q.vehicleClass,
    customerChargeMinor: q.customerChargeMinor,
    riderEarningMinor: q.riderEarningMinor,
    sokoniCommissionMinor: q.sokoniCommissionMinor,
    /* RES-1 — the SETTLEMENT-SHAPED pin. `dispatch.js` calls `assertSettleable(delivery.deliveryQuote)`
       and that contract wants nested money objects and `pricingInputs.policy`, not the flat
       `...Minor` fields the store keeps. Building it here, from the record just validated, is what
       lets the SAME figures the buyer was charged travel to the rider — rather than a second quote
       being minted downstream from a different trip description. */
    pinned: pinnedFromStored(q),
  };
}

/* ── The pin that travels ───────────────────────────────────────────────────────────────────
   Derived from the STORED record only. It deliberately re-states nothing: every figure is copied,
   none is recomputed, because a pin that re-derives is not a pin. */
function pinnedFromStored(q) {
  return {
    quoteId: q.quoteId,
    pricingVersion: q.pricingVersion,
    sokoniSharePct: q.sokoniSharePct,
    customerCharge: { currency: 'KES', minorUnits: q.customerChargeMinor },
    riderEarning: { currency: 'KES', minorUnits: q.riderEarningMinor },
    sokoniCommission: { currency: 'KES', minorUnits: q.sokoniCommissionMinor },
    pricingInputs: q.pricingInputs,
    vehicleClass: q.vehicleClass,
    createdAt: q.createdAt || null,
  };
}

/* ── Consumption ────────────────────────────────────────────────────────────────────────────
   GATE C CLAIMED SINGLE USE AND DID NOT ENFORCE IT. `resolveQuoteForCheckout` refuses a quote
   whose `status !== 'issued'` — but nothing in the codebase ever moved a quote off `issued`, so
   the check guarded a state that could not occur and one quote could back any number of orders.
   The certification proved the CHECK worked (by writing the state itself) and never asked whether
   a WRITER existed. This is that writer.

   It runs inside the transaction that creates the order, not at session creation: an abandoned or
   retried checkout must not burn the buyer's quote, exactly as an abandoned checkout must not burn
   their loyalty points.

   Idempotent for the SAME order — a webhook replay re-binds harmlessly — and refused for any
   other, which is what makes a quote single-use rather than merely marked. */
function bindQuoteToOrderTx(tx, store, quoteId, orderId, buyerUid, existing) {
  if (!quoteId) return;
  if (!existing || !existing.exists) throw new HttpsError('failed-precondition', 'delivery_quote_not_found');
  const q = existing.data() || {};
  if (q.buyerUid !== buyerUid) throw new HttpsError('permission-denied', 'delivery_quote_not_yours');
  if (q.status === 'consumed' && String(q.orderId || '') !== String(orderId)) {
    throw new HttpsError('failed-precondition', 'delivery_quote_already_bound');
  }
  tx.update(store.collection(QUOTES).doc(quoteId), {
    status: 'consumed',
    orderId: String(orderId),
    consumedAt: now(),
  });
}

/* Fields a checkout payload may NEVER carry. `deliveryFee` is the one the census found being
   charged; the rest are named so a later caller cannot reach for a different spelling. */
const CHECKOUT_FORBIDDEN_PRICING = Object.freeze([
  'deliveryFee', 'driverNet', 'riderEarning', 'riderFeeKES', 'platformCut',
  'sokoniCommission', 'sokoniSharePct', 'customerCharge', 'pricingVersion',
]);

function assertNoCheckoutPricing(payload) {
  if (!payload || typeof payload !== 'object') return;
  const found = CHECKOUT_FORBIDDEN_PRICING.filter((f) => payload[f] !== undefined);
  if (found.length) {
    throw new HttpsError('invalid-argument',
      'Delivery pricing is server-authoritative; remove: ' + found.join(', '));
  }
}

module.exports.requestDeliveryQuote = exports.requestDeliveryQuote;
module.exports.resolveQuoteForCheckout = resolveQuoteForCheckout;
module.exports.pinnedFromStored = pinnedFromStored;
module.exports.bindQuoteToOrderTx = bindQuoteToOrderTx;
module.exports.assertNoCheckoutPricing = assertNoCheckoutPricing;
module.exports.CHECKOUT_FORBIDDEN_PRICING = CHECKOUT_FORBIDDEN_PRICING;
module.exports.QUOTES = QUOTES;
module.exports.QUOTE_TTL_MS = QUOTE_TTL_MS;
