'use strict';
/**
 * SOKONI — RETURN REQUEST ELIGIBILITY (pure)
 * functions/returns-eligibility.js
 *
 * Decides, on the SERVER, whether a buyer may open a return request for an order, and what the
 * request contains. It creates a REQUEST only: it decides no refund, fee, liability, rider payment,
 * wallet credit or chargeback — those belong to the request -> approval -> execution authority (H2).
 *
 * Every rule below is the PUBLISHED returns policy (returns-policy.html), quoted — nothing invented:
 *
 *   window    "SOKONI gives you 7 calendar days from confirmed delivery to initiate a return for
 *              eligible items." / "The return window starts from the date shown as "Delivered" in your
 *              order tracker, or the date you confirm receipt — whichever is earlier."
 *              Buyer confirmation (delivery-complete.js) writes `deliveredAt` itself, so deliveredAt
 *              already records whichever came first.
 *   evidence  "For defective or wrong items ... photos of the defect or discrepancy are required."
 *              Recorded as a REQUIREMENT on the request; upload is not yet available (evidence vault
 *              is later work), so submission is not blocked on it.
 *
 * NOT IMPLEMENTED (stated so it is not assumed): the policy says "Sellers may set their own extended
 * return policies (beyond 7 days) in their seller settings." No such setting exists anywhere in the
 * code, so every request is held to the published 7 days.
 *
 * Items come from the ORDER, never from the client: the client may say WHICH of the order's items it
 * is returning (by productId); name, price and quantity are the order's own.
 */

const RETURNS_POLICY = Object.freeze({
  id: 'sokoni-returns-policy-2026-09-26',
  windowDays: 7,
  evidenceRequiredReasons: Object.freeze(['defective', 'wrong_item']),
});

const REFUSAL = Object.freeze({
  NOT_PAID: 'order-not-paid',
  NOT_DELIVERED: 'order-not-delivered',
  WINDOW_CLOSED: 'return-window-closed',
  NO_ITEMS: 'order-has-no-items',
  UNKNOWN_ITEM: 'item-not-on-this-order',
});

const _ms = (t) => (t && typeof t.toMillis === 'function') ? t.toMillis() : (typeof t === 'number' ? t : (t ? Date.parse(t) : NaN));

/** Is the order eligible for a return request right now? */
function evaluate(order, nowMs) {
  const o = order || {};
  if (!(o.paymentVerified === true || String(o.paymentStatus || '').toLowerCase() === 'paid')) {
    return { ok: false, reason: REFUSAL.NOT_PAID, message: 'This order has not been paid, so it cannot be returned.' };
  }
  const deliveredMs = _ms(o.deliveredAt);
  if (!Number.isFinite(deliveredMs)) {
    return { ok: false, reason: REFUSAL.NOT_DELIVERED, message: 'A return can be requested once the order has been delivered.' };
  }
  const windowEndsMs = deliveredMs + RETURNS_POLICY.windowDays * 86400000;
  if (nowMs > windowEndsMs) {
    return { ok: false, reason: REFUSAL.WINDOW_CLOSED,
      message: `The ${RETURNS_POLICY.windowDays}-day return window closed on ${new Date(windowEndsMs).toISOString().slice(0, 10)}.` };
  }
  return { ok: true, deliveredMs, windowEndsMs };
}

/** The returned items, from the order. `productIds` optionally narrows to a subset. */
function deriveItems(order, productIds) {
  const lines = Array.isArray((order || {}).items) ? order.items : [];
  if (!lines.length) return { ok: false, reason: REFUSAL.NO_ITEMS, message: 'This order has no items to return.' };
  const idOf = (it) => String(it.productId || it.id || '');
  let chosen = lines;
  if (Array.isArray(productIds) && productIds.length) {
    const want = productIds.map(String);
    const missing = want.filter((p) => !lines.some((it) => idOf(it) === p));
    if (missing.length) return { ok: false, reason: REFUSAL.UNKNOWN_ITEM, message: `Not on this order: ${missing.join(', ')}.` };
    chosen = lines.filter((it) => want.includes(idOf(it)));
  }
  return { ok: true, items: chosen.map((it) => ({
    productId: idOf(it) || null,
    name: String(it.name || '').slice(0, 200),
    qty: Math.max(1, Number(it.qty || it.quantity) || 1),
    price: Number.isFinite(Number(it.price)) ? Number(it.price) : null,     /* the ORDER's price */
  })) };
}

function evidenceRequired(reasonCode) { return RETURNS_POLICY.evidenceRequiredReasons.includes(reasonCode); }

module.exports = { RETURNS_POLICY, REFUSAL, evaluate, deriveItems, evidenceRequired };
