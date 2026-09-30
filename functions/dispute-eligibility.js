'use strict';

/**
 * SOKONI DISPUTE ELIGIBILITY AUTHORITY
 * ────────────────────────────────────────────────────────────────────────────
 * Answers one question: MAY THIS PERSON OPEN THIS DISPUTE, AND UNTIL WHEN?
 *
 * It is deliberately not the dispute itself. Opening, evidence, the seller's response and
 * the moderator's decision all live in the existing dispute rail; this module only guards
 * the door, so that the guard can be reasoned about — and tested — without a database.
 *
 * WHAT IT NEVER DOES
 * ────────────────────────────────────────────────────────────────────────────
 * It never names an amount, never attributes fault, never decides a remedy and never
 * moves money. A dispute is a request for a human decision, not a payment instruction.
 * The refund rail already exists and is the only thing that may pay; a dispute that could
 * pay would be a second money authority with none of the first one's checks.
 *
 * THE WINDOW COMES FROM THE SELLER'S OWN PROMISE
 * ────────────────────────────────────────────────────────────────────────────
 * For anything that can only be judged after the goods arrive — wrong item, damaged,
 * counterfeit — the deadline is the warranty PINNED to the order at purchase. Not a
 * platform constant, and not the policy currently on the listing: the seller may have
 * edited or deleted that since, and a promise that can be edited after the sale is not a
 * promise. Pinning is what makes it binding, and this module reads the pin.
 *
 * Some complaints cannot wait for a delivery that never came. "It never arrived" and "I
 * was charged wrong" are judged against the ORDER, because the goods are the thing in
 * question. Those use the platform's dispute term (see PLATFORM_TERM).
 */

const FAULT = require('./warranty-policy').FAULT;

/* ── WHAT A DISPUTE CAN BE ABOUT ─────────────────────────────────────────────
   The same reason keys the live dispute rail already accepts — extending that vocabulary
   here rather than replacing it, so existing disputes stay readable.

   `needsDelivery` splits them: TRUE means the complaint is about goods in the buyer's
   hands, so the pinned warranty governs it. FALSE means the complaint is about the order
   itself and is judged whether or not anything ever arrived. */
const DISPUTE_REASON = Object.freeze({
  not_received: Object.freeze({ key: 'not_received', label: 'Item never arrived', needsDelivery: false }),
  overcharged: Object.freeze({ key: 'overcharged', label: 'Charged the wrong amount', needsDelivery: false }),
  wrong_item: Object.freeze({ key: 'wrong_item', label: 'Wrong item sent', needsDelivery: true }),
  not_as_described: Object.freeze({ key: 'not_as_described', label: 'Not as described', needsDelivery: true }),
  counterfeit: Object.freeze({ key: 'counterfeit', label: 'Counterfeit', needsDelivery: true }),
  damaged: Object.freeze({ key: 'damaged', label: 'Arrived damaged', needsDelivery: true }),
  defective: Object.freeze({ key: 'defective', label: 'Faulty or not working', needsDelivery: true }),
  other: Object.freeze({ key: 'other', label: 'Something else', needsDelivery: false }),
});

const DISPUTE_REASON_KEYS = Object.freeze(Object.keys(DISPUTE_REASON));

const DAY_MS = 86400000;

/**
 * THE PLATFORM DISPUTE TERM — for complaints the warranty cannot answer.
 *
 * 30 days is NOT a new choice. It is the term the live dispute rail already enforces
 * (functions/disputes.js has measured it from delivery-or-creation since it shipped), and
 * it is carried forward here unchanged so that making the term configurable does not
 * silently move every existing buyer's deadline.
 *
 * It is now RESOLVED rather than hardcoded, so the platform can set it deliberately —
 * `resolveTerm` prefers configuration and falls back to the incumbent. The fallback is
 * reported in `source` so a caller can always tell which one it got, and so nobody has to
 * guess whether a deadline came from a decision or from a default.
 */
const PLATFORM_TERM = Object.freeze({ days: 30, source: 'INCUMBENT' });

function refuse(reason, detail) {
  return { ok: false, reason, detail: detail || null };
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function parseTime(t) {
  if (t == null) return null;
  if (typeof t === 'number' && isFinite(t)) return t;
  if (typeof t === 'string') {
    const n = Date.parse(t);
    return isNaN(n) ? null : n;
  }
  /* Firestore Timestamp, and the plain {seconds} shape it degrades to once a document has
     been through JSON. */
  if (typeof t === 'object') {
    if (typeof t.toDate === 'function') {
      const d = t.toDate();
      return d instanceof Date && !isNaN(d.getTime()) ? d.getTime() : null;
    }
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    if (typeof t._seconds === 'number') return t._seconds * 1000;
  }
  return null;
}

function resolveTerm(config) {
  const c = isPlainObject(config) ? config : {};
  const d = Number(c.disputeTermDays);
  if (isFinite(d) && d > 0 && d <= 365) return { days: Math.floor(d), source: 'CONFIG' };
  return { days: PLATFORM_TERM.days, source: PLATFORM_TERM.source };
}

/* ── 1. IS THIS A VERIFIED BUYER? ────────────────────────────────────────────
 *
 * "Verified" means two separate things, and both must hold:
 *
 *   1. THEY OWN THE ORDER — established from the order document, never from the request.
 *   2. THE ORDER IS REAL — it was actually paid for. An abandoned basket is not a
 *      purchase, and a dispute rail open to unpaid orders is a way to attach a permanent
 *      complaint to a seller for free.
 *
 * Receipt is deliberately NOT part of being a verified buyer: "it never arrived" is the
 * one complaint a buyer cannot make if receipt is the price of entry. Receipt is checked
 * where it actually belongs — against the reason, in `eligibility` below.
 */
function verifiedBuyer(input) {
  const i = isPlainObject(input) ? input : {};
  const order = isPlainObject(i.order) ? i.order : null;
  const uid = typeof i.uid === 'string' ? i.uid.trim() : '';

  if (!order) return refuse('NO_ORDER');
  if (!uid) return refuse('NO_CALLER');

  /* Read from the ORDER, across every spelling this platform has used.

     THE UNION IS LOAD-BEARING. The warranty rail resolves a buyer as
     `buyerUid || uid || customerUid || userId`; the dispute rail resolves them as
     `buyerId || userId || customerId`. Those sets overlap but neither contains the
     other, so an order carrying only `buyerUid` is claimable under warranty and yet
     refuses its own buyer a dispute — the person who may demand a refund cannot ask a
     question about it. This module sits between the two rails and must recognise a
     buyer that EITHER of them would. */
  const owner = order.buyerId || order.buyerUid || order.userId ||
                order.customerId || order.customerUid || order.uid || null;
  if (!owner) return refuse('ORDER_HAS_NO_BUYER');
  if (owner !== uid) return refuse('NOT_YOUR_ORDER');

  const paid = order.paymentStatus || order.payment || null;
  const status = String(order.status || '').toLowerCase();
  const isPaid =
    order.paid === true ||
    String(paid || '').toLowerCase() === 'paid' ||
    /paid|completed|delivered|fulfilled|shipped|dispatched/.test(status);
  if (!isPaid) return refuse('ORDER_NOT_PAID');

  return { ok: true, uid, orderId: order.id || null, verified: true };
}

/* ── 2. DID THE GOODS ACTUALLY ARRIVE? ───────────────────────────────────────
   Taken from the delivery job's own confirmed receipt where there is one, because that is
   the moment the buyer physically had the item. `deliveryFacts` in the warranty rail
   already establishes this; the shape it returns is what this accepts, so the two rails
   cannot drift into disagreeing about whether the same parcel was delivered. */
function received(delivery) {
  const d = isPlainObject(delivery) ? delivery : {};
  const at = parseTime(d.deliveredAt);
  return { delivered: d.delivered === true, deliveredAt: at, source: d.source || null };
}

/* ── 3. THE DEADLINE ─────────────────────────────────────────────────────────
 *
 * For a post-delivery complaint the answer comes from the PINNED policy for the line
 * being disputed. That policy is the seller's own promise, frozen at purchase.
 *
 * A line with no pinned protection is NOT refused — it falls to the platform term. A
 * seller who offers no warranty has not thereby made their listing undisputable; the
 * warranty governs what a buyer may CLAIM, while a dispute is the right to be heard, and
 * those are different rights. This distinction is the reason the two rails stay separate.
 */
function disputeWindow(input) {
  const i = isPlainObject(input) ? input : {};
  const cls = DISPUTE_REASON[typeof i.reason === 'string' ? i.reason.trim() : ''];
  if (!cls) return refuse('UNKNOWN_REASON', String(i.reason || ''));

  const now = parseTime(i.now) != null ? parseTime(i.now) : Date.now();
  const term = resolveTerm(i.config);
  const line = isPlainObject(i.line) ? i.line : null;

  /* ── the warranty-governed path ───────────────────────────────────────── */
  if (cls.needsDelivery && line && line.protected && isPlainObject(line.window)) {
    const w = line.window;

    if (w.state === 'NOT_STARTED') {
      /* The clock has not begun because the goods have not arrived. That is not an
         expiry, and a buyer told "expired" here would be told something false. */
      return { ok: true, open: false, state: 'NOT_STARTED', reason: w.reason || 'NOT_DELIVERED_YET',
               governedBy: 'WARRANTY', policyVersion: line.policyVersion || null };
    }

    const expiresAt = parseTime(w.expiresAt);
    const open = w.state === 'ACTIVE' && (expiresAt == null || now <= expiresAt);
    return {
      ok: true,
      open,
      state: open ? 'ACTIVE' : 'EXPIRED',
      governedBy: 'WARRANTY',
      policyVersion: line.policyVersion || null,
      startedAt: w.startedAt || null,
      expiresAt: w.expiresAt || null,
      daysRemaining: open && expiresAt != null ? Math.ceil((expiresAt - now) / DAY_MS) : 0,
    };
  }

  /* ── the platform-term path ───────────────────────────────────────────── */
  const anchor = parseTime(i.deliveredAt) != null ? parseTime(i.deliveredAt) : parseTime(i.purchasedAt);
  if (anchor == null) {
    /* No date to measure from. REFUSED rather than defaulted to open or closed: an
       undated order is a data problem, and answering it either way would be a guess
       presented as a deadline. */
    return refuse('NO_ANCHOR_DATE');
  }

  const expiresAt = anchor + term.days * DAY_MS;
  const open = now <= expiresAt;
  return {
    ok: true,
    open,
    state: open ? 'ACTIVE' : 'EXPIRED',
    governedBy: 'PLATFORM_TERM',
    termDays: term.days,
    termSource: term.source,
    startedAt: new Date(anchor).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    daysRemaining: open ? Math.ceil((expiresAt - now) / DAY_MS) : 0,
  };
}

/* ── 4. THE WHOLE ANSWER ─────────────────────────────────────────────────────
   Composed from the parts above so that a refusal always names WHICH gate closed. A
   single boolean would tell a buyer "no" and leave them nothing to do about it. */
function eligibility(input) {
  const i = isPlainObject(input) ? input : {};

  const who = verifiedBuyer({ order: i.order, uid: i.uid });
  if (!who.ok) return who;

  const cls = DISPUTE_REASON[typeof i.reason === 'string' ? i.reason.trim() : ''];
  if (!cls) return refuse('UNKNOWN_REASON', String(i.reason || ''));

  const got = received(i.delivery);

  /* A complaint about the goods requires the goods. Raised BEFORE the window is
     computed, so a buyer whose parcel is still in transit is told "not yet" rather than
     "expired" — the same complaint will be perfectly valid on arrival. */
  if (cls.needsDelivery && !got.delivered) {
    return refuse('NOT_DELIVERED_YET',
      'This can be raised once the item reaches you. If it never arrives, choose "Item never arrived".');
  }

  const win = disputeWindow({
    reason: cls.key,
    line: i.line,
    deliveredAt: got.deliveredAt,
    purchasedAt: i.purchasedAt || (i.order && (i.order.createdAt || i.order.orderedAt)) || null,
    now: i.now,
    config: i.config,
  });
  if (!win.ok) return win;
  if (!win.open) {
    return { ok: false, reason: win.state === 'NOT_STARTED' ? 'NOT_DELIVERED_YET' : 'WINDOW_CLOSED',
             detail: null, window: win };
  }

  /* An open dispute already exists for this order. Told plainly, with the id, so the
     buyer is taken to the conversation they already started instead of being refused for
     reasons they cannot see. */
  if (i.existingOpenDisputeId) {
    return { ok: false, reason: 'ALREADY_OPEN', detail: String(i.existingOpenDisputeId), window: win };
  }

  return {
    ok: true,
    reason: cls.key,
    label: cls.label,
    window: win,
    governedBy: win.governedBy,
    /* NOT AN OUTCOME. Fault is what a moderator will decide after reading both sides;
       UNDETERMINED is recorded so that nothing downstream can mistake the absence of a
       decision for a decision of "no fault". */
    fault: FAULT.UNDETERMINED,
  };
}

/* ── 5. A DISPUTE MUST NOT MOVE MONEY ────────────────────────────────────────
 *
 * Named here, and asserted by the suite, because the pressure to "just credit the buyer
 * while we're resolving it" is exactly how a second payment path gets built. A dispute
 * records a decision; the refund rail — with its provider confirmation, its idempotency
 * and its minor units — is the only thing that pays.
 *
 * Any of these appearing on a dispute document means that line has been crossed.
 */
const MONEY_FIELDS = Object.freeze([
  'refundAmount', 'refundAmountMinor', 'amountMinor', 'creditMinor', 'payoutMinor',
  'walletId', 'balanceMinor', 'settledMinor', 'merchantNet', 'commissionMinor',
]);

function movesMoney(patch) {
  const p = isPlainObject(patch) ? patch : {};
  const hit = MONEY_FIELDS.filter((k) => Object.prototype.hasOwnProperty.call(p, k));
  return hit.length ? { moves: true, fields: hit } : { moves: false, fields: [] };
}

module.exports = {
  DISPUTE_REASON, DISPUTE_REASON_KEYS, PLATFORM_TERM, MONEY_FIELDS, DAY_MS,
  resolveTerm, verifiedBuyer, received, disputeWindow, eligibility, movesMoney,
};
