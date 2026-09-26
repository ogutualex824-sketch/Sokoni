'use strict';
/**
 * SOKONI — REFUND AUTHORITY
 * functions/refund-authority.js
 *
 * ONE decision point for refunding a payment SOKONI collected and credited to a seller.
 * docs/REFUND_AFTER_WEBHOOK_CREDIT_INVESTIGATION.md is the record of why it exists.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────────────────
 * The IntaSend webhook credits the seller at payment time and marks the PAYMENT:
 *     payments/{apiRef}.walletCreditedAt / walletCreditCents / walletCreditedTo
 * No refund path read those markers. `refundToWallet` paid the buyer and never touched the
 * seller. `fosSubmitRefund`/`fosApproveRefund` fired an IntaSend chargeback and debited a
 * `sellerUid` a webhook payment does not carry (so: nobody), in a field nothing pays out from.
 * Nothing stopped a wallet refund AND a chargeback for the same payment.
 *
 * ── WHAT THIS MODULE GUARANTEES ─────────────────────────────────────────────────────────
 *
 *   1. ONE OUTCOME PER PAYMENT. `refundAuthority/{paymentRef}` is claimed with create() inside
 *      a transaction. The first rail to claim it — wallet or chargeback — owns the refund; every
 *      later attempt, from EITHER rail, is refused before any money moves. SOKONI enforces this
 *      itself: it never relies on IntaSend rejecting a duplicate chargeback.
 *
 *   2. ANCHORED ON EVIDENCE, NEVER ON A GUESS. A refund proceeds only when the payment carries
 *      all three credit markers AND the ledger row the credit actually wrote can be found and
 *      agrees with them. That row also says WHICH field family was credited:
 *        FINOS_CENTS        marketplace / till: wallets.{availableBalance, withdrawableBalance,
 *                           lifetimeEarnings} (cents), ledger wallets/{uid}/transactions type 'sale'
 *        BALANCE_SHILLINGS  legacy booking: wallets.balance (shillings), ledger
 *                           walletTransactions/{uid}_{apiRef}_booking
 *      Missing, ambiguous or disagreeing evidence is a refusal with a named reason. The seller is
 *      NEVER inferred from anything else.
 *
 *   3. THE SELLER'S NET CREDIT IS REVERSED WHERE THE MONEY NOW IS. sweepEarningsToWallet MOVES
 *      whole shillings from the FinOS cents fields into `balance`, so by refund time a credit may
 *      sit in either or both. The reversal takes from the FinOS fields first, then from the swept
 *      `balance` — cent-exact, returning any sub-shilling change to FinOS — and anything the seller
 *      has already withdrawn becomes `refundRecoveryDebt`: the SAME ratified policy
 *      order-settlement.reverseSettledOrder already runs. Balance is floored at zero, never negative.
 *
 *   4. EVIDENCE IS PRESERVED, THE REFUND IS A SUBSEQUENT EVENT. `settlementStatus`, and the
 *      payment's credit markers, are never overwritten. The refund is recorded as new fields
 *      (refundStatus, refundRail, refundAuthorityId, refundedAt) and ledger rows with
 *      deterministic ids.
 *
 * ── RAILS ───────────────────────────────────────────────────────────────────────────────
 *   wallet      refundToBuyerWallet(): claim + buyer credit + seller reversal + evidence, in ONE
 *               transaction. It either all happens once or none of it happens.
 *   chargeback  claimChargeback() (no money) -> gateway call OUTSIDE any transaction ->
 *               completeChargeback() (seller reversal + evidence; replay-safe) or failChargeback().
 *               A failed chargeback stays CLAIMED as CHARGEBACK_FAILED: whether the gateway acted is
 *               not something this code can know, so reopening it would risk a second outcome. Any
 *               release is a reviewed human decision, not an automatic retry.
 *
 * Full refunds only. A partial refund is refused (PARTIAL_NOT_SUPPORTED) rather than approximated.
 * Out of scope and untouched: the business wallet (businessWallets), commissionLedger.
 */

const { FieldValue, Timestamp } = require('firebase-admin/firestore');

const AUTHORITY = 'refundAuthority';

const STATUS = Object.freeze({
  COMPLETED:          'COMPLETED',
  CHARGEBACK_PENDING: 'CHARGEBACK_PENDING',
  CHARGEBACK_FAILED:  'CHARGEBACK_FAILED',
});
const RAIL = Object.freeze({ WALLET: 'wallet', CHARGEBACK: 'chargeback' });
const FAMILY = Object.freeze({ FINOS: 'FINOS_CENTS', BALANCE: 'BALANCE_SHILLINGS' });

const REASON = Object.freeze({
  ALREADY_CLAIMED:          'refund-already-claimed-for-this-payment',
  NO_PAYMENT:               'no-payment-record',
  AMBIGUOUS_PAYMENT:        'order-maps-to-more-than-one-payment',
  ORDER_WITHOUT_PAYMENT:    'order-has-no-payment-record',
  NOT_COMPLETE:             'payment-not-complete',
  NO_CREDIT_MARKER:         'payment-carries-no-seller-credit-marker',
  BAD_AMOUNT:               'payment-amount-unusable',
  CREDIT_EVIDENCE_MISSING:  'credit-ledger-row-not-found',
  CREDIT_EVIDENCE_AMBIGUOUS:'credit-ledger-evidence-ambiguous',
  SELLER_MISMATCH:          'order-seller-disagrees-with-credited-seller',
  SELLER_WALLET_MISSING:    'credited-seller-wallet-missing',
  WALLET_UNREADABLE:        'wallet-balance-unreadable',
  BUYER_UNKNOWN:            'payment-names-no-buyer',
  BUYER_MISMATCH:           'requested-recipient-is-not-the-payer',
  AMOUNT_MISMATCH:          'requested-amount-is-not-the-payment-amount',
  PARTIAL_NOT_SUPPORTED:    'partial-refunds-are-not-supported',
  BAD_STATE:                'refund-authority-in-unexpected-state',
});

class RefundAuthorityError extends Error {
  constructor(reason, message, details) {
    super(message || reason);
    this.name = 'RefundAuthorityError';
    this.reason = reason;
    if (details) this.details = details;
  }
}
const refuse = (reason, message, details) => { throw new RefundAuthorityError(reason, message, details); };

const _int = (v) => typeof v === 'number' && Number.isFinite(v) && Math.floor(v) === v;
const _num = (v) => (v === undefined || v === null ? 0 : Number(v));
const _safeId = (s) => String(s || '').replace(/[^A-Za-z0-9_:.-]/g, '_').slice(0, 180);

/* ══ Anchor resolution (outside any transaction; the transaction re-reads everything) ══ */

/**
 * Which payment, if any, a refund request refers to.
 *   { kind: 'payment', paymentRef }            a payments doc exists -> the authority governs
 *   { kind: 'none' }                           nothing SOKONI collected is referenced
 * Refuses (throws) when the reference points at something but cannot be tied to exactly one
 * payment: an explicit paymentRef with no record, an order with no payment, several payments.
 */
async function resolveRefundAnchor(db, { paymentRef, orderId } = {}) {
  if (paymentRef) {
    const p = await db.collection('payments').doc(_safeId(paymentRef)).get();
    if (!p.exists) refuse(REASON.NO_PAYMENT, `No payment record ${paymentRef}.`);
    return { kind: 'payment', paymentRef: p.id };
  }
  if (!orderId) return { kind: 'none' };
  const direct = await db.collection('payments').doc(_safeId(orderId)).get();
  if (direct.exists) return { kind: 'payment', paymentRef: direct.id };
  const q = await db.collection('payments').where('meta.orderId', '==', String(orderId)).limit(3).get();
  if (q.size > 1) refuse(REASON.AMBIGUOUS_PAYMENT, `Order ${orderId} maps to ${q.size} payments; a human must say which is refunded.`);
  if (q.size === 1) return { kind: 'payment', paymentRef: q.docs[0].id };
  const order = await db.collection('orders').doc(_safeId(orderId)).get();
  if (order.exists) refuse(REASON.ORDER_WITHOUT_PAYMENT, `Order ${orderId} exists but no payment record anchors it; refusing to refund against a guess.`);
  return { kind: 'none' };
}

/* ══ The credit anchor, read INSIDE a transaction ══ */

async function _loadAnchor(t, db, paymentRef) {
  const payRef = db.collection('payments').doc(_safeId(paymentRef));
  const pSnap = await t.get(payRef);
  if (!pSnap.exists) refuse(REASON.NO_PAYMENT, `No payment record ${paymentRef}.`);
  const p = pSnap.data() || {};

  if (!/^(COMPLETE|COMPLETED)$/i.test(String(p.status || '').trim())) {
    refuse(REASON.NOT_COMPLETE, `Payment ${paymentRef} is ${p.status || 'without status'}, not COMPLETE.`);
  }
  const sellerUid = typeof p.walletCreditedTo === 'string' && p.walletCreditedTo ? p.walletCreditedTo : null;
  const netCents = p.walletCreditCents;
  if (!p.walletCreditedAt || !sellerUid || !_int(netCents) || netCents <= 0) {
    refuse(REASON.NO_CREDIT_MARKER,
      `Payment ${paymentRef} carries no complete seller-credit marker (walletCreditedAt / walletCreditCents / walletCreditedTo). ` +
      'Refusing: without it there is no evidence of whose credit to reverse.');
  }
  const grossKES = Number(p.amount);
  if (!Number.isFinite(grossKES) || grossKES <= 0) refuse(REASON.BAD_AMOUNT, `Payment ${paymentRef} has no usable amount.`);

  /* WHICH FIELD FAMILY WAS CREDITED — from the ledger row the credit wrote, nothing else. */
  const bookingRef = db.collection('walletTransactions').doc(`${sellerUid}_${pSnap.id}_booking`);
  const [bookingSnap, finosQ] = await Promise.all([
    t.get(bookingRef),
    t.get(db.collection('wallets').doc(sellerUid).collection('transactions').where('orderId', '==', pSnap.id).limit(5)),
  ]);
  const finosCredits = finosQ.docs.map((d) => d.data() || {}).filter((d) => d.direction === 'credit' && d.type === 'sale');
  const bookingOk = bookingSnap.exists && _int(_num(bookingSnap.data().amount)) && _num(bookingSnap.data().amount) * 100 === netCents;
  const finosOk = finosCredits.length === 1 && finosCredits[0].amountCents === netCents;
  if (bookingSnap.exists && finosCredits.length) {
    refuse(REASON.CREDIT_EVIDENCE_AMBIGUOUS, `Payment ${paymentRef} has BOTH a booking and a FinOS credit row; refusing to choose.`);
  }
  if (finosCredits.length > 1) {
    refuse(REASON.CREDIT_EVIDENCE_AMBIGUOUS, `Payment ${paymentRef} has ${finosCredits.length} FinOS sale credits; refusing to choose.`);
  }
  let family = null;
  if (bookingOk) family = FAMILY.BALANCE;
  else if (finosOk) family = FAMILY.FINOS;
  else {
    refuse(REASON.CREDIT_EVIDENCE_MISSING,
      `Payment ${paymentRef} is marked credited (${netCents}c to ${sellerUid}) but no ledger row agrees with that credit.`,
      { bookingRow: bookingSnap.exists, finosRows: finosCredits.length });
  }

  const orderId = (p.meta && p.meta.orderId) ? String(p.meta.orderId) : null;
  let orderRef = null, order = null;
  if (orderId) {
    orderRef = db.collection('orders').doc(_safeId(orderId));
    const oSnap = await t.get(orderRef);
    if (oSnap.exists) {
      order = oSnap.data() || {};
      const orderSeller = order.sellerUid || order.sellerId || null;
      if (orderSeller && String(orderSeller) !== sellerUid && family === FAMILY.FINOS) {
        refuse(REASON.SELLER_MISMATCH, `Order ${orderId} names seller ${orderSeller} but the credit went to ${sellerUid}.`);
      }
    } else { orderRef = null; }
  }

  const walletRef = db.collection('wallets').doc(sellerUid);
  const wSnap = await t.get(walletRef);
  if (!wSnap.exists) refuse(REASON.SELLER_WALLET_MISSING, `Seller wallet ${sellerUid} does not exist.`);

  return { payRef, payment: p, paymentRef: pSnap.id, sellerUid, netCents, grossKES, family,
    buyerUid: typeof p.uid === 'string' && p.uid ? p.uid : null,
    orderId, orderRef, order, walletRef, wallet: wSnap.data() || {} };
}

/* ══ The arithmetic of the seller reversal — pure, and the only copy ══ */

/**
 * Where to take `netCents` back from. Nothing is written here.
 * FINOS:   FinOS fields first (they move in lockstep; the sweep moves min(available, withdrawable)),
 *          then whole shillings from `balance`, returning sub-shilling change to FinOS so the total
 *          removed is EXACTLY netCents. What `balance` cannot cover becomes refundRecoveryDebt.
 * BALANCE: shillings from `balance`, the remainder to refundRecoveryDebt.
 */
function planSellerReversal(family, wallet, netCents) {
  if (!_int(netCents) || netCents <= 0) refuse(REASON.BAD_STATE, 'netCents must be a positive integer.');
  const w = wallet || {};
  const bal = _num(w.balance);
  if (!Number.isFinite(bal)) refuse(REASON.WALLET_UNREADABLE, 'Seller wallet balance is not a number.');
  const balanceAvailable = Math.max(0, Math.floor(bal));

  if (family === FAMILY.BALANCE) {
    if (netCents % 100 !== 0) refuse(REASON.BAD_STATE, 'A balance-family credit must be whole shillings.');
    const netShillings = netCents / 100;
    const fromBalanceShillings = Math.min(balanceAvailable, netShillings);
    return { family, netCents, finosDeltaCents: 0, fromFinosCents: 0, changeCents: 0,
      fromBalanceShillings, debtShillings: netShillings - fromBalanceShillings, lifetimeDeltaCents: 0 };
  }
  if (family !== FAMILY.FINOS) refuse(REASON.BAD_STATE, `Unknown credit family ${family}.`);

  const avail = _num(w.availableBalance), wd = _num(w.withdrawableBalance);
  if (!Number.isFinite(avail) || !Number.isFinite(wd)) refuse(REASON.WALLET_UNREADABLE, 'Seller FinOS fields are not numbers.');
  const finosAvailable = Math.max(0, Math.min(avail, wd));
  const fromFinosCents = Math.min(netCents, finosAvailable);
  const rest = netCents - fromFinosCents;
  const shillingsNeeded = Math.ceil(rest / 100);
  const changeCents = shillingsNeeded * 100 - rest;                  /* 0..99, handed back to FinOS */
  const fromBalanceShillings = Math.min(balanceAvailable, shillingsNeeded);
  return { family, netCents, fromFinosCents, changeCents,
    finosDeltaCents: -fromFinosCents + changeCents,
    fromBalanceShillings, debtShillings: shillingsNeeded - fromBalanceShillings,
    lifetimeDeltaCents: -netCents };
}

/* ══ Writes shared by both rails (inside the caller's transaction, after all reads) ══ */

function _applySellerReversal(t, db, a, plan, authorityId) {
  const upd = { updatedAt: FieldValue.serverTimestamp() };
  if (plan.finosDeltaCents) {
    upd.availableBalance = FieldValue.increment(plan.finosDeltaCents);
    upd.withdrawableBalance = FieldValue.increment(plan.finosDeltaCents);
  }
  if (plan.lifetimeDeltaCents) upd.lifetimeEarnings = FieldValue.increment(plan.lifetimeDeltaCents);
  if (plan.fromBalanceShillings) upd.balance = FieldValue.increment(-plan.fromBalanceShillings);
  if (plan.debtShillings) upd.refundRecoveryDebt = FieldValue.increment(plan.debtShillings);
  t.update(a.walletRef, upd);

  const breakdown = { fromFinosCents: plan.fromFinosCents, changeCents: plan.changeCents,
    fromBalanceShillings: plan.fromBalanceShillings, debtShillings: plan.debtShillings };
  if (a.family === FAMILY.FINOS) {
    /* The mirror of the credit row, in the SAME ledger, with a deterministic id. */
    t.create(a.walletRef.collection('transactions').doc(`refund_reversal_${_safeId(a.paymentRef)}`), {
      type: 'sale_reversal', direction: 'debit', amountCents: a.netCents, orderId: a.paymentRef,
      description: `Refund reversal of sale ${a.paymentRef}`, refundAuthorityId: authorityId, breakdown,
      createdAt: FieldValue.serverTimestamp(),
    });
  }
  t.create(db.collection('walletTransactions').doc(`${a.sellerUid}_${_safeId(a.paymentRef)}_refund_reversal`), {
    uid: a.sellerUid, type: 'refund_reversal', amount: -plan.fromBalanceShillings, currency: 'KES',
    reversedCreditCents: a.netCents, creditFamily: a.family, debtAddedShillings: plan.debtShillings,
    breakdown, paymentRef: a.paymentRef, orderId: a.orderId, refundAuthorityId: authorityId,
    status: 'completed', createdAt: FieldValue.serverTimestamp(),
  });
}

/* Additive evidence. settlementStatus and the credit markers are NOT touched. */
function _writeEvidence(t, a, rail, authorityId, status) {
  const ev = { refundStatus: status, refundRail: rail, refundAuthorityId: authorityId,
    updatedAt: FieldValue.serverTimestamp() };
  if (status === 'REFUNDED') ev.refundedAt = FieldValue.serverTimestamp();
  t.update(a.payRef, Object.assign({}, ev, status === 'REFUNDED'
    ? { sellerCreditReversedCents: a.netCents, sellerCreditReversedAt: FieldValue.serverTimestamp() } : {}));
  if (a.orderRef) t.update(a.orderRef, ev);
}

function _checkRequest(a, { expectAmountKES, expectBuyerUid }) {
  if (expectAmountKES !== undefined && expectAmountKES !== null && Number(expectAmountKES) !== a.grossKES) {
    refuse(Number(expectAmountKES) < a.grossKES ? REASON.PARTIAL_NOT_SUPPORTED : REASON.AMOUNT_MISMATCH,
      `Requested KES ${expectAmountKES}; payment ${a.paymentRef} was KES ${a.grossKES}. Only a full refund is supported.`);
  }
  if (expectBuyerUid && a.buyerUid && String(expectBuyerUid) !== a.buyerUid) {
    refuse(REASON.BUYER_MISMATCH, `Payment ${a.paymentRef} was paid by ${a.buyerUid}, not ${expectBuyerUid}.`);
  }
}

function _authorityDoc(a, rail, status, o) {
  return {
    paymentRef: a.paymentRef, orderId: a.orderId, rail, status,
    grossKES: a.grossKES, buyerUid: a.buyerUid,
    sellerUid: a.sellerUid, sellerNetCents: a.netCents, creditFamily: a.family,
    requestedBy: o.requestedBy || null, source: o.source || null, reason: o.reason || null,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  };
}

/* ══ Wallet rail — everything in ONE transaction ══ */

async function refundToBuyerWallet(db, o) {
  const authRef = db.collection(AUTHORITY).doc(_safeId(o.paymentRef));
  return db.runTransaction(async (t) => {
    const existing = await t.get(authRef);
    if (existing.exists) {
      const e = existing.data() || {};
      refuse(REASON.ALREADY_CLAIMED, `Payment ${o.paymentRef} already has a ${e.rail} refund (${e.status}).`,
        { rail: e.rail, status: e.status });
    }
    const a = await _loadAnchor(t, db, o.paymentRef);
    _checkRequest(a, o);
    if (!a.buyerUid) refuse(REASON.BUYER_UNKNOWN, `Payment ${a.paymentRef} names no payer to refund.`);
    if (!_int(a.grossKES)) refuse(REASON.BAD_STATE, `Payment amount KES ${a.grossKES} is not whole shillings; the wallet holds shillings.`);
    if (a.buyerUid === a.sellerUid) {
      /* A seller who paid themself: crediting and reversing ONE document is ambiguous. Refused. */
      refuse(REASON.BAD_STATE, 'Payer and credited seller are the same account; refusing an ambiguous self-refund.');
    }
    const buyerWalletRef = db.collection('wallets').doc(a.buyerUid);
    const bw = await t.get(buyerWalletRef);
    const plan = planSellerReversal(a.family, a.wallet, a.netCents);

    /* ── writes ── */
    t.create(authRef, Object.assign(_authorityDoc(a, RAIL.WALLET, STATUS.COMPLETED, o),
      { reversal: plan, completedAt: FieldValue.serverTimestamp() }));
    if (bw.exists) t.update(buyerWalletRef, { balance: FieldValue.increment(a.grossKES), updatedAt: FieldValue.serverTimestamp() });
    else t.set(buyerWalletRef, { uid: a.buyerUid, balance: a.grossKES, currency: 'KES', createdAt: Timestamp.now() });
    t.create(db.collection('walletTransactions').doc(`${a.buyerUid}_${_safeId(a.paymentRef)}_refund`), {
      uid: a.buyerUid, type: 'refund', amount: a.grossKES, currency: 'KES', paymentRef: a.paymentRef,
      orderId: a.orderId, refundAuthorityId: authRef.id, refundedBy: o.requestedBy || null,
      description: o.reason || `Refund for payment ${a.paymentRef}`, status: 'completed',
      createdAt: Timestamp.now(),
    });
    _applySellerReversal(t, db, a, plan, authRef.id);
    _writeEvidence(t, a, RAIL.WALLET, authRef.id, 'REFUNDED');
    return { authorityId: authRef.id, rail: RAIL.WALLET, buyerUid: a.buyerUid, grossKES: a.grossKES,
      buyerBalance: (bw.exists ? _num(bw.data().balance) : 0) + a.grossKES,
      sellerUid: a.sellerUid, reversal: plan };
  });
}

/* ══ Chargeback rail ══ */

/** Claim the payment for a chargeback. No money moves here. Returns the facts the gateway needs. */
async function claimChargeback(db, o) {
  const authRef = db.collection(AUTHORITY).doc(_safeId(o.paymentRef));
  return db.runTransaction(async (t) => {
    const existing = await t.get(authRef);
    if (existing.exists) {
      const e = existing.data() || {};
      refuse(REASON.ALREADY_CLAIMED, `Payment ${o.paymentRef} already has a ${e.rail} refund (${e.status}).`,
        { rail: e.rail, status: e.status });
    }
    const a = await _loadAnchor(t, db, o.paymentRef);
    _checkRequest(a, o);
    planSellerReversal(a.family, a.wallet, a.netCents);          /* refuse NOW if unreadable, not after the gateway */
    t.create(authRef, _authorityDoc(a, RAIL.CHARGEBACK, STATUS.CHARGEBACK_PENDING, o));
    _writeEvidence(t, a, RAIL.CHARGEBACK, authRef.id, 'REFUND_PENDING');
    return { authorityId: authRef.id, paymentRef: a.paymentRef, grossKES: a.grossKES,
      buyerUid: a.buyerUid, sellerUid: a.sellerUid, sellerNetCents: a.netCents };
  });
}

/**
 * The gateway accepted the chargeback: reverse the seller and record the outcome. Replay-safe —
 * a second call finds COMPLETED and changes nothing. `alsoUpdate` lets the caller finalize its own
 * record (the FOS queue doc) in the SAME transaction.
 */
async function completeChargeback(db, o) {
  const authRef = db.collection(AUTHORITY).doc(_safeId(o.paymentRef));
  return db.runTransaction(async (t) => {
    const s = await t.get(authRef);
    if (!s.exists) refuse(REASON.BAD_STATE, `No refund authority for ${o.paymentRef}; a chargeback must be claimed first.`);
    const d = s.data() || {};
    if (d.rail !== RAIL.CHARGEBACK) refuse(REASON.ALREADY_CLAIMED, `Payment ${o.paymentRef} is owned by the ${d.rail} rail.`);
    if (d.status === STATUS.COMPLETED) return { idempotent: true, authorityId: authRef.id, reversal: d.reversal || null };
    if (d.status !== STATUS.CHARGEBACK_PENDING) refuse(REASON.BAD_STATE, `Refund authority for ${o.paymentRef} is ${d.status}.`);
    const a = await _loadAnchor(t, db, o.paymentRef);
    if (a.sellerUid !== d.sellerUid || a.netCents !== d.sellerNetCents) {
      refuse(REASON.BAD_STATE, 'The credit anchor changed between claim and completion; refusing to reverse.');
    }
    const plan = planSellerReversal(a.family, a.wallet, a.netCents);
    t.update(authRef, { status: STATUS.COMPLETED, reversal: plan, gatewayRefundId: o.gatewayRefundId || null,
      completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    _applySellerReversal(t, db, a, plan, authRef.id);
    _writeEvidence(t, a, RAIL.CHARGEBACK, authRef.id, 'REFUNDED');
    if (o.alsoUpdate && o.alsoUpdate.ref) t.update(o.alsoUpdate.ref, o.alsoUpdate.data);
    return { idempotent: false, authorityId: authRef.id, reversal: plan };
  });
}

/** The gateway failed or its result is unknown. The claim is KEPT: see the RAILS note. */
async function failChargeback(db, o) {
  const authRef = db.collection(AUTHORITY).doc(_safeId(o.paymentRef));
  return db.runTransaction(async (t) => {
    const s = await t.get(authRef);
    if (!s.exists) return { changed: false };
    const d = s.data() || {};
    if (d.status !== STATUS.CHARGEBACK_PENDING) return { changed: false, status: d.status };
    t.update(authRef, { status: STATUS.CHARGEBACK_FAILED, gatewayError: String(o.error || 'unknown').slice(0, 500),
      updatedAt: FieldValue.serverTimestamp() });
    if (o.alsoUpdate && o.alsoUpdate.ref) t.update(o.alsoUpdate.ref, o.alsoUpdate.data);
    return { changed: true };
  });
}

/** Map a refusal onto the callable error the caller should raise. */
function toHttpsError(e, HttpsError) {
  if (!(e instanceof RefundAuthorityError)) return e;
  const code = e.reason === REASON.ALREADY_CLAIMED ? 'already-exists'
    : (e.reason === REASON.NO_PAYMENT ? 'not-found' : 'failed-precondition');
  return new HttpsError(code, e.message, { reason: e.reason, details: e.details || null });
}

module.exports = {
  AUTHORITY, STATUS, RAIL, FAMILY, REASON, RefundAuthorityError,
  resolveRefundAnchor, planSellerReversal,
  refundToBuyerWallet, claimChargeback, completeChargeback, failChargeback,
  toHttpsError,
};
