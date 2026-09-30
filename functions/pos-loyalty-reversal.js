/* ══════════════════════════════════════════════════════════════════════════════════════
   POINTS REVERSAL — a refund returns what that sale consumed, and nothing else.
   ══════════════════════════════════════════════════════════════════════════════════════
   THE RULE THIS FILE EXISTS FOR:

       A reversal reverses only the points ACTUALLY CONSUMED by its referenced redemption
       event. It never recomputes, reconstructs, or reasons about the customer's current
       balance.

   Why that distinction is the whole design. Consider:

       balance 1,000  ->  Sale A consumes 100   ->  balance 900
                          customer later earns 500  ->  balance 1,400
                          refund Sale A         ->  balance 1,500

   An implementation that asked "what should the balance have been?" would try to unwind to
   1,000 and destroy the 500 the customer earned in between. One that asked "what is the
   balance now, and what was it then?" would compute a 500 difference out of two unrelated
   facts. Only "what did THIS event consume" — 100 — is correct, and it is correct no matter
   what happened afterwards, in what order, or concurrently.

   So the original ledger event is the only input that decides the amount. The balance is
   read solely to record where the credit landed, never to derive how large it should be.

   ── THE HISTORICAL EVENT IS NEVER MUTATED ────────────────────────────────────────────
   A reversal is a NEW compensating event that references the original. Editing the original
   would destroy the record of what actually happened at the till, and a ledger that can be
   rewritten is not a ledger. It also makes cumulative reversal checkable: the sum of
   reversals against an event is a query, not a field somebody has to remember to update.

   ── RATE INDEPENDENCE ────────────────────────────────────────────────────────────────
   The reversal values points at the rate RECORDED ON THE ORIGINAL EVENT, never at today's.
   A merchant who changes their programme between the sale and the return must not thereby
   change what the customer gets back — the customer spent points that were worth a
   particular amount on the day, and that is the amount being unwound.

   ── WHAT THIS MODULE DOES NOT DO ─────────────────────────────────────────────────────
   It moves no money. Points and tender are separate components of one refund: reversing
   points must never cause an IntaSend refund, a cash payout, or a wallet credit, and this
   module has no path to any of them. It is pure — no reads, no writes, no clock of its own
   — so it can run inside the refund transaction the same way the redemption authority runs
   inside the sale.
   ══════════════════════════════════════════════════════════════════════════════════════ */
'use strict';

/* Compensating events live in the SAME ledger as the redemptions they reverse, so the
   history of a customer's points is one ordered story rather than two collections that
   have to be joined to be believed. */
const LEDGER = 'posLoyaltyLedger';

const TYPE = {
  REDEEM:  'redeem',
  REVERSE: 'reverse',
};

const REASON = {
  NOT_FOUND:        'original-redemption-not-found',
  NOT_A_REDEMPTION: 'referenced-event-is-not-a-redemption',
  NOTHING_CONSUMED: 'that-sale-consumed-no-points',
  FULLY_REVERSED:   'this-redemption-has-already-been-fully-reversed',
  NOT_POSITIVE:     'points-to-reverse-must-be-positive',
  EXCEEDS_ORIGINAL: 'cannot-reverse-more-points-than-the-sale-consumed',
  WRONG_CUSTOMER:   'that-redemption-belongs-to-another-customer',
  WRONG_MERCHANT:   'that-redemption-belongs-to-another-shop',
};

function _int(v) { const n = Number(v); return Number.isFinite(n) ? Math.floor(n) : NaN; }
function _round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/**
 * How many points a redemption event consumed. Stored NEGATIVE on the event (a debit), so
 * the magnitude is what a reversal can return. Reading it through one function means no
 * caller has to remember the sign convention, which is the kind of detail that produces a
 * reversal of minus one hundred points.
 */
function consumedPoints(eventData) {
  const p = Number((eventData || {}).points);
  return Number.isFinite(p) ? Math.abs(p) : 0;
}

/**
 * Decide what a reversal may return. PURE — no reads, no writes, no clock.
 *
 * @param original      the ORIGINAL redemption event's data (not a snapshot)
 * @param priorReversals array of prior reversal event data against this same event
 * @param requestedPoints how many points to return; omit for a FULL reversal
 * @param customerId / merchantId  the refund's own subject, checked against the event
 *
 * @returns { ok, points, valueKES, pointValue, alreadyReversed, remaining, reason }
 *
 * The current balance is not a parameter. It cannot be consulted because it is not here.
 */
function planReversal({ original, priorReversals, requestedPoints, customerId, merchantId }) {
  const none = (reason) => ({
    ok: false, points: 0, valueKES: 0, pointValue: null,
    alreadyReversed: 0, remaining: 0, reason,
  });

  if (!original || typeof original !== 'object') return none(REASON.NOT_FOUND);
  if (String(original.type || '') !== TYPE.REDEEM) return none(REASON.NOT_A_REDEMPTION);

  /* The refund must be for the same subject as the redemption. A reversal that credited a
     different customer would be a transfer, and one crossing shops would let a refund at
     one merchant return points another merchant funded. */
  if (customerId && String(original.customerId || '') !== String(customerId)) return none(REASON.WRONG_CUSTOMER);
  if (merchantId && String(original.merchantId || '') !== String(merchantId)) return none(REASON.WRONG_MERCHANT);

  const consumed = consumedPoints(original);
  if (!(consumed > 0)) return none(REASON.NOTHING_CONSUMED);

  /* CUMULATIVE, from the events themselves. Summing the prior reversals rather than
     trusting a counter on the original is what makes "cannot reverse more than was
     consumed" hold across retries, partial refunds and concurrent attempts alike — there
     is no field to forget to increment. */
  const alreadyReversed = (priorReversals || []).reduce((sum, r) => {
    const p = Number((r || {}).points);
    return sum + (Number.isFinite(p) ? Math.abs(p) : 0);
  }, 0);

  const remaining = consumed - alreadyReversed;
  if (!(remaining > 0)) {
    return Object.assign(none(REASON.FULLY_REVERSED), { alreadyReversed, remaining: 0 });
  }

  /* A full reversal is the default: omitting the amount returns what is left, which is the
     ordinary case and the one hardest to get wrong by hand. */
  let want = (requestedPoints === undefined || requestedPoints === null)
    ? remaining : _int(requestedPoints);
  if (!Number.isFinite(want) || want <= 0) {
    return Object.assign(none(REASON.NOT_POSITIVE), { alreadyReversed, remaining });
  }
  /* REFUSED, not silently clamped. A caller asking to return more points than the sale
     consumed has computed something wrong, and quietly giving them less would hide the
     defect behind a plausible-looking refund. */
  if (want > remaining) {
    return Object.assign(none(REASON.EXCEEDS_ORIGINAL), { alreadyReversed, remaining });
  }

  /* THE ORIGINAL EVENT'S RATE, NOT TODAY'S. A programme change between the sale and the
     return must not change what the customer gets back. */
  const pointValue = Number(original.pointValue);
  const rate = Number.isFinite(pointValue) && pointValue > 0 ? pointValue : null;

  return {
    ok: true,
    points: want,
    /* What that many points were worth ON THE DAY. Null rather than a guess when the
       original carried no rate — a reversal can still return the POINTS correctly without
       inventing the cash figure they represented. */
    valueKES: rate === null ? null : _round2(want * rate),
    pointValue: rate,
    alreadyReversed,
    remaining,
    reason: null,
  };
}

/**
 * The compensating ledger event. Returned, never written — the caller writes it inside the
 * refund transaction, so the credit and the refund commit together or not at all.
 *
 * Keyed on the REFUND, so a retried refund writes the same document id rather than a second
 * credit. That is what makes repetition converge instead of accumulating.
 */
function reversalEntry({ refundId, originalId, original, plan, balanceBefore, actor, reason, at }) {
  const before = _int(balanceBefore);
  const credited = plan.points;
  return {
    id: String(refundId),
    doc: {
      type: TYPE.REVERSE,
      /* WHAT IT UNWINDS — the specific event, by id, plus the sale it belonged to. An
         audit that can only say "some points came back" is not an audit. */
      reversesEventId: String(originalId),
      saleId:     original.saleId || null,
      refundId:   String(refundId),
      merchantId: original.merchantId || null,
      customerId: original.customerId || null,

      /* POSITIVE — a credit, mirroring the negative debit it reverses. */
      points:     credited,
      valueKES:   plan.valueKES,
      /* Carried from the ORIGINAL, so the rate this was valued at is legible on the
         reversal itself and does not have to be inferred from a date. */
      pointValue: plan.pointValue,

      /* Where the credit actually landed. Recorded, never used to size the reversal. */
      balanceBefore: Number.isFinite(before) ? before : null,
      balanceAfter:  Number.isFinite(before) ? before + credited : null,

      actor:  actor ? String(actor) : null,
      reason: reason ? String(reason).slice(0, 200) : null,
      createdAt: at || null,
    },
  };
}

module.exports = {
  LEDGER, TYPE, REASON,
  consumedPoints, planReversal, reversalEntry,
};
