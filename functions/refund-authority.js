/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — REFUND AUTHORITY
   functions/refund-authority.js

   What a refund is worth, whether it may be paid, and what state it is in. It decides;
   the caller talks to IntaSend and writes the records.

   ── THE AMOUNT IS THE ORDER'S, AND THERE IS NOWHERE TO SEND ANOTHER ───────────
   Every figure comes from the authoritative order and payment record. There is no
   parameter for a caller-supplied amount — which is stronger than validating one, because
   a field that does not exist cannot be trusted by mistake. A browser that could name a
   refund figure is a browser that can empty a merchant.

   ── MINOR UNITS, ALWAYS ───────────────────────────────────────────────────────
   Money is {currency, minor} integers throughout. The moment a refund is computed in
   floating-point shillings, 0.1 + 0.2 decides what somebody is owed and the error is
   invisible until a reconciliation months later.

   ── THE PROVIDER IS THE AUTHORITY ON WHETHER MONEY MOVED ──────────────────────
   A refund is REFUNDED when IntaSend says the money left, and at no earlier point. Pressing
   a button, passing eligibility and sending the request are three things that are not a
   refund. The lifecycle keeps them apart precisely so that no one of them can be mistaken
   for the last one:

       REQUESTED → ELIGIBLE → PROCESSING → PROVIDER_CONFIRMED → REFUNDED
                 ↘ REFUSED               ↘ FAILED (retryable)

   PURE. No Firestore, no network. Certifiable without an emulator.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const WP = require('./warranty-policy');

const STATE = {
  REQUESTED: 'REQUESTED',
  ELIGIBLE: 'ELIGIBLE',
  REFUSED: 'REFUSED',
  PROCESSING: 'PROCESSING',
  PROVIDER_CONFIRMED: 'PROVIDER_CONFIRMED',
  REFUNDED: 'REFUNDED',
  FAILED: 'FAILED',
};

/* Which moves are legal. FAILED returns to ELIGIBLE so a provider outage can be retried
   without re-opening eligibility — and REFUNDED is terminal, because a refund that can be
   re-entered is a refund that can be paid twice. */
const ALLOWED = {
  [STATE.REQUESTED]: [STATE.ELIGIBLE, STATE.REFUSED],
  [STATE.ELIGIBLE]: [STATE.PROCESSING, STATE.REFUSED],
  [STATE.PROCESSING]: [STATE.PROVIDER_CONFIRMED, STATE.FAILED],
  [STATE.PROVIDER_CONFIRMED]: [STATE.REFUNDED],
  [STATE.FAILED]: [STATE.ELIGIBLE],
  [STATE.REFUSED]: [],
  [STATE.REFUNDED]: [],
};

/** Only these remedies move money. A repair or a replacement is a logistics obligation. */
const MONETARY = ['refund'];

function refuse(reason, detail) { return { ok: false, reason, detail: detail || null }; }

/* ── 1. WHAT THE ORDER SAYS IT IS WORTH ─────────────────────────────────────── */

/**
 * The refundable value of one order line, in minor units, from the ORDER.
 *
 * Never from the product's current price: a seller who raises a price after a sale must not
 * thereby owe more, and one who cuts it must not owe less. What the buyer paid is what the
 * buyer gets back.
 */
function lineValueMinor(order, lineIndex) {
  if (!order) return refuse('NO_ORDER');
  const items = Array.isArray(order.items) ? order.items : [];
  const it = items[lineIndex];
  if (!it) return refuse('NO_SUCH_LINE', String(lineIndex));

  /* Minor units if the order already carries them; otherwise the shilling figure the
     order recorded, converted ONCE here rather than at every reader. */
  let minor = null;
  if (Number.isInteger(it.priceMinor)) minor = it.priceMinor;
  else if (Number.isFinite(Number(it.price))) minor = Math.round(Number(it.price) * 100);
  if (minor === null) return refuse('LINE_HAS_NO_PRICE', String(lineIndex));

  const qty = Math.max(1, Math.round(Number(it.qty || it.quantity) || 1));
  const value = minor * qty;
  if (!(value > 0)) return refuse('NON_POSITIVE_LINE_VALUE', String(value));
  return { ok: true, minor: value, qty, unitMinor: minor };
}

/**
 * What may be refunded for this request, in minor units.
 *
 * DELIVERY IS NOT AUTOMATICALLY REFUNDED, and that is the seller-fault rule expressed in
 * money: when the goods were wrong the buyer should not be out of pocket for having them
 * brought, so the delivery fee comes back too. When they simply changed their mind, the
 * delivery happened exactly as agreed and was worth what it cost.
 */
function refundableMinor(input) {
  const { order, lineIndex, fault } = input || {};
  const line = lineValueMinor(order, lineIndex);
  if (!line.ok) return line;

  const currency = String((order && (order.currency || order.paymentCurrency)) || 'KES').toUpperCase();

  let deliveryMinor = 0;
  if (fault === WP.FAULT.SELLER) {
    const d = order.deliveryFeeMinor;
    if (Number.isInteger(d)) deliveryMinor = d;
    else if (Number.isFinite(Number(order.deliveryFee))) deliveryMinor = Math.round(Number(order.deliveryFee) * 100);
  }

  return {
    ok: true,
    currency,
    goodsMinor: line.minor,
    deliveryMinor,
    totalMinor: line.minor + deliveryMinor,
    qty: line.qty,
    /* Stated rather than implied, because "why is my refund larger than the item?" is a
       question a support agent must be able to answer from the record. */
    deliveryRefunded: deliveryMinor > 0,
    deliveryReason: fault === WP.FAULT.SELLER
      ? 'the buyer did not cause the return'
      : 'the delivery happened as agreed',
  };
}

/* ── 2. MAY IT BE PAID AT ALL? ──────────────────────────────────────────────── */

/**
 * Eligibility, decided from the PINNED policy and the order — never from the request.
 *
 * The request supplies only what the buyer chose: which line, why, and what they would
 * like. Everything that decides money is read from documents the buyer cannot write.
 */
function assess(input) {
  const { order, pinnedLine, reason, remedies, delivered, deliveredAt, purchasedAt, now, lineIndex } = input || {};
  if (!order) return refuse('NO_ORDER');
  if (!pinnedLine || !pinnedLine.policy) {
    return refuse('NO_POLICY_ON_THIS_LINE',
      (pinnedLine && pinnedLine.noPolicyReason) || 'this purchase carries no warranty policy');
  }

  /* THE POLICY AUTHORITY DECIDES. Duplicating window or option rules here would give the
     platform two answers to one question. */
  const v = WP.validateRequest({
    pinned: pinnedLine.policy, reason, remedies,
    delivered, deliveredAt, purchasedAt, now,
  });
  if (!v.ok) return v;

  const asked = v.remedies;
  const monetary = asked.filter((r) => MONETARY.indexOf(r) > -1);

  /* A non-monetary remedy is eligible and moves no money. A replacement still has to be
     shipped and a repair still has to happen; treating them as refunds would pay a buyer
     AND owe them goods. */
  if (!monetary.length) {
    return {
      ok: true, state: STATE.ELIGIBLE, monetary: false,
      fault: v.fault, returnDelivery: v.returnDelivery,
      remedies: asked, reason: v.reason, window: v.window,
      money: null,
    };
  }

  const money = refundableMinor({ order, lineIndex: Number(lineIndex) || 0, fault: v.fault });
  if (!money.ok) return money;

  return {
    ok: true, state: STATE.ELIGIBLE, monetary: true,
    fault: v.fault, returnDelivery: v.returnDelivery,
    remedies: asked, reason: v.reason, reasonLabel: v.reasonLabel, window: v.window,
    money: {
      currency: money.currency,
      minor: money.totalMinor,
      goodsMinor: money.goodsMinor,
      deliveryMinor: money.deliveryMinor,
      deliveryRefunded: money.deliveryRefunded,
      deliveryReason: money.deliveryReason,
    },
    policyVersion: pinnedLine.policy.policyVersion,
  };
}

/* ── 3. THE LIFECYCLE ───────────────────────────────────────────────────────── */

function transition(current, next) {
  const from = String(current || STATE.REQUESTED).toUpperCase();
  const to = String(next || '').toUpperCase();
  if (!STATE[to]) return refuse('UNKNOWN_REFUND_STATE', to);
  const allowed = ALLOWED[from];
  if (!allowed) return refuse('UNKNOWN_CURRENT_STATE', from);
  if (allowed.indexOf(to) === -1) return refuse('ILLEGAL_REFUND_TRANSITION', from + ' -> ' + to);
  return { ok: true, from, to };
}

/**
 * Did the provider actually pay it?
 *
 * The one place a refund becomes REFUNDED. It requires the provider's own confirmation
 * carrying the same reference and the same amount in the same currency — a response that
 * merely arrived is not a response that agreed.
 */
function confirmFromProvider(input) {
  const { request, verified } = input || {};
  if (!request) return refuse('NO_REQUEST');
  if (!verified || verified.ok !== true) {
    return refuse('PROVIDER_DID_NOT_CONFIRM', (verified && verified.reason) || 'no verification');
  }
  const expect = request.money || {};
  if (!Number.isInteger(expect.minor)) return refuse('REQUEST_AMOUNT_NOT_MINOR_UNITS');
  if (verified.money.currency !== String(expect.currency || '').toUpperCase()) {
    return refuse('CURRENCY_MISMATCH', verified.money.currency + ' != ' + expect.currency);
  }
  if (verified.money.minor !== expect.minor) {
    return refuse('AMOUNT_MISMATCH', verified.money.minor + ' != ' + expect.minor);
  }
  return {
    ok: true,
    state: STATE.PROVIDER_CONFIRMED,
    providerRef: verified.ref || null,
    providerTrackingId: verified.providerTrackingId || null,
    money: { currency: verified.money.currency, minor: verified.money.minor },
  };
}

/* ── 4. IDEMPOTENCY ─────────────────────────────────────────────────────────── */

/**
 * The refund's own identity, derived from the order and the line.
 *
 * Derived and never generated: a generated key makes every retry a new refund, which is
 * the defect wearing a safety feature's clothes. One line of one order can have one open
 * refund, so a double tap, a re-fired trigger and a provider retry all address the same
 * document.
 */
function refundId(orderId, lineIndex) {
  const a = String(orderId || '').trim();
  if (!a) return refuse('NO_ORDER_ID');
  /* null and the empty string BOTH coerce to 0, so a request that named no line would
     have silently addressed line 0 — refunding the wrong item and taking its identity
     from a value nobody supplied. Rejected before coercion rather than after. */
  if (lineIndex === null || lineIndex === undefined || lineIndex === '') {
    return refuse('NO_LINE_INDEX');
  }
  const n = Number(lineIndex);
  if (!Number.isInteger(n) || n < 0) return refuse('NO_LINE_INDEX');
  return { ok: true, id: 'refund_' + a + '__' + n };
}

module.exports = {
  STATE, ALLOWED, MONETARY,
  lineValueMinor, refundableMinor, assess, transition, confirmFromProvider, refundId,
};
