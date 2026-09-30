'use strict';

/**
 * SOKONI ORDER PAYMENT FACT
 * ────────────────────────────────────────────────────────────────────────────
 * "Has a provider actually paid for this order?" — answered from records the browser
 * cannot write, never from fields on the order itself.
 *
 * ── THIS IS A READER, NOT A SECOND PAYMENT AUTHORITY ─────────────────────────
 * It decides nothing about payment. The decision was already made — by
 * `verifyIntasendPayment` checking the invoice state against IntaSend, and by
 * `webhookIntasend` checking an HMAC challenge and the invoice state. Each of those wrote
 * a record. This module finds that record and reports what it says. Adding a rule here
 * that the paying paths do not apply would make this a second opinion about money, which
 * is the thing the platform has been removing.
 *
 * ── WHY A FIELD ON THE ORDER IS NOT EVIDENCE ─────────────────────────────────
 * `onNewOrderCreated` used to establish payment from `status === 'paid'` OR
 * `paymentVerified === true`. Both live on the order document, and the only thing stopping
 * a browser writing them is the Firestore rule `clientOrderInit()`. That rule is correct —
 * and it is one layer. Rules deployment is a standing blocker on this branch, a future
 * edit could loosen the rule, and a new server writer could set `status: 'paid'` at create
 * without ever taking a payment. Any of those makes a fabricated order look paid to every
 * downstream consumer.
 *
 * A confirmation record cannot be forged the same way: `paymentVerifications` is read-only
 * to clients and `paymentIntents` has no rule at all, so it is default-deny and writable
 * only by the Admin SDK. Whatever they say was authored by this platform's servers.
 *
 * ── THE TWO PATHS THAT CREATE A PAID ORDER ───────────────────────────────────
 *   verifyIntasendPayment      writes paymentVerifications/{ref} {orderId, amount} in the
 *                              SAME transaction as the order, so the evidence is committed
 *                              with the fact it evidences.
 *   webhookIntasend            creates through _finalizeMarketplacePayment, against the
 *                              server-minted intent it was paid for. The order carries that
 *                              intent's ref so the intent can be found again.
 *
 * POS QR orders are written `status: 'completed'` on a separate rail and never reach this.
 */

const REASON = Object.freeze({
  NO_ORDER:          'NO_ORDER',
  NO_REFERENCE:      'NO_REFERENCE',
  NO_CONFIRMATION:   'NO_CONFIRMATION',
  AMOUNT_SHORT:      'AMOUNT_SHORT',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  NOT_CONFIRMED:     'NOT_CONFIRMED',
  LOOKUP_FAILED:     'LOOKUP_FAILED',
});

/* Server-only by their Firestore rules: `paymentVerifications` grants read and no write;
   `paymentIntents` has no match block at all, so it is default-deny. */
const VERIFICATIONS = 'paymentVerifications';
const PAYMENTS = 'payments';
const INTENTS = 'paymentIntents';

/* The provider states that mean money arrived. An allowlist, so a state this platform
   has never seen reads as NOT paid; a blocklist would read a new one as paid. */
const CONFIRMED_STATES = Object.freeze(['COMPLETE', 'COMPLETED', 'PAID', 'SUCCESS', 'SUCCESSFUL']);

/**
 * FIELDS THAT ARE NOT EVIDENCE.
 *
 * Every one of these lives on the order document and says "this was paid". Not one of them
 * is checked by this module, because a claim written beside the thing it describes proves
 * nothing about it. Kept as data so the certification suite asserts against the same list
 * rather than a second copy that can drift.
 */
const NOT_EVIDENCE = Object.freeze([
  'status', 'paymentVerified', 'paymentStatus', 'paid',
  'paidAmount', 'paidAt', 'paidPhone', 'mpesaCode',
  'paymentMethod', 'settlementStatus', 'orderTotal', 'total',
]);

function refuse(reason, detail) {
  return { ok: false, reason, detail: detail == null ? null : detail };
}

function kes(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The reference this order was paid under, taken only from fields a server writes.
 *
 * `checkoutId`/`paymentRef` are the intent ref; `invoiceId`/`trackingId` are IntaSend's own
 * identifiers, echoed onto the order by the path that confirmed it.
 */
function referenceFor(order) {
  const o = order || {};
  const r = o.paymentRef || o.checkoutId || o.invoiceId || o.trackingId || null;
  return r ? String(r).trim() : null;
}

/** What the order says it should have cost, in whole shillings. */
function expectedKes(order) {
  const o = order || {};
  const direct = kes(o.orderTotal) || kes(o.total);
  if (direct != null && direct > 0) return direct;
  const cents = kes(o.totalCents);
  return cents != null && cents > 0 ? Math.round(cents) / 100 : null;
}

/**
 * RECONCILIATION, USING THE PAYING PATH'S OWN RULE.
 *
 * `verifyIntasendPayment` treats a payment as short only when it is more than one shilling
 * below the expected total, and accepts an overpayment. That tolerance is the platform's
 * existing commercial decision about rounding on the provider's side. Applying a stricter
 * rule here would reject orders the payment path already accepted and paid for — a
 * fabricated failure, not a fix — so this asks the same question that path asked.
 */
function amountReconciles(confirmedKes, expected) {
  if (expected == null || !(expected > 0)) return true;   /* nothing to compare against */
  if (confirmedKes == null) return false;
  return confirmedKes >= expected - 1;
}

/**
 * THE FACT, or the reason there isn't one.
 *
 * @param {object} order  the orders/{id} document, including its id
 * @param {object} db     Firestore handle — passed, never ambient, so a caller inside a
 *                        transaction or a test reads the database it is actually using
 */
async function confirmedPaymentFor(order, db) {
  const o = order || null;
  if (!o || !(o.id || o.orderId)) return refuse(REASON.NO_ORDER);
  if (!db) return refuse(REASON.LOOKUP_FAILED, 'no firestore handle');

  const orderId = String(o.id || o.orderId);
  const expected = expectedKes(o);
  const wantCur = String(o.currency || 'KES').toUpperCase();

  /* ── Source 1: the verification written WITH the order ─────────────────────
     Queried by orderId rather than by reference, because this record is the one written in
     the same transaction as the order and is therefore the strongest evidence available:
     it cannot exist for an order that was not created by that path. */
  try {
    const vs = await db.collection(VERIFICATIONS).where('orderId', '==', orderId).limit(1).get();
    if (vs && !vs.empty) {
      const v = vs.docs[0].data() || {};
      const confirmed = kes(v.amount);
      if (!amountReconciles(confirmed, expected)) {
        return refuse(REASON.AMOUNT_SHORT, 'confirmed ' + confirmed + ' vs expected ' + expected);
      }
      const gotCur = String(v.currency || wantCur).toUpperCase();
      if (gotCur !== wantCur) return refuse(REASON.CURRENCY_MISMATCH, gotCur + ' != ' + wantCur);
      return { ok: true, source: VERIFICATIONS, ref: String(v.ref || vs.docs[0].id),
               confirmedKes: confirmed, currency: gotCur };
    }
  } catch (e) {
    return refuse(REASON.LOOKUP_FAILED, (e && e.message) || String(e));
  }

  /* ── Source 2: the provider's own answer, on a collection clients cannot write ──
     `payments/{ref}` is created PENDING when a charge starts and moved to COMPLETE only
     when the provider says so. Its rules are `allow write: if false`. */
  const ref = referenceFor(o);
  if (!ref) return refuse(REASON.NO_REFERENCE);

  try {
    const pSnap = await db.collection(PAYMENTS).doc(ref).get();
    if (pSnap && pSnap.exists) {
      const p = pSnap.data() || {};
      const st = String(p.status || p.state || '').toUpperCase();
      if (CONFIRMED_STATES.indexOf(st) === -1) {
        return refuse(REASON.NOT_CONFIRMED, ref + ' is ' + (st || 'unknown'));
      }
      const confirmed = kes(p.amount);
      if (!amountReconciles(confirmed, expected)) {
        return refuse(REASON.AMOUNT_SHORT, 'paid ' + confirmed + ' vs expected ' + expected);
      }
      const gotCur = String(p.currency || wantCur).toUpperCase();
      if (gotCur !== wantCur) return refuse(REASON.CURRENCY_MISMATCH, gotCur + ' != ' + wantCur);
      return { ok: true, source: PAYMENTS, ref, confirmedKes: confirmed, currency: gotCur };
    }
  } catch (e) {
    return refuse(REASON.LOOKUP_FAILED, (e && e.message) || String(e));
  }

  /* ── Source 3: an intent that something has STAMPED PAID ──────────────────
     Existence is not enough and never was: an intent means the platform asked for money,
     not that any arrived. Only a paid stamp — written by the Admin SDK, on a collection
     with no Firestore rule at all — counts. */
  try {
    const snap = await db.collection(INTENTS).doc(ref).get();
    if (!snap || !snap.exists) return refuse(REASON.NO_CONFIRMATION, ref);
    const intent = snap.data() || {};

    const st = String(intent.status || '').toUpperCase();
    if (CONFIRMED_STATES.indexOf(st) === -1) {
      return refuse(REASON.NOT_CONFIRMED, ref + ' intent is ' + (st || 'unstamped'));
    }

    const intentKes = kes(intent.amountPaidKES) != null ? kes(intent.amountPaidKES)
                    : (kes(intent.amount) != null ? kes(intent.amount)
                    : (kes(intent.amountCents) != null ? Math.round(kes(intent.amountCents)) / 100 : null));
    if (!amountReconciles(intentKes, expected)) {
      return refuse(REASON.AMOUNT_SHORT, 'intent ' + intentKes + ' vs expected ' + expected);
    }
    const gotCur = String(intent.currency || wantCur).toUpperCase();
    if (gotCur !== wantCur) return refuse(REASON.CURRENCY_MISMATCH, gotCur + ' != ' + wantCur);

    return { ok: true, source: INTENTS, ref, confirmedKes: intentKes, currency: gotCur };
  } catch (e) {
    return refuse(REASON.LOOKUP_FAILED, (e && e.message) || String(e));
  }
}
module.exports = {
  REASON, VERIFICATIONS, PAYMENTS, INTENTS, CONFIRMED_STATES, NOT_EVIDENCE,
  referenceFor, expectedKes, amountReconciles, confirmedPaymentFor,
};
