'use strict';

/**
 * SOKONI RIDER SHARE AUTHORITY
 * ────────────────────────────────────────────────────────────────────────────
 * What a rider earns from a delivery, and the one place any path may ask.
 *
 * ── THERE IS NO PERCENTAGE IN THIS FILE ──────────────────────────────────────
 * That is the point, and it is asserted in certification rather than promised here.
 *
 * The old model multiplied a delivery fee by a fixed share — 0.88 in three places, 0.84
 * in a fourth, 0.80 in the packageRequests writers. Three opinions about one number, and
 * a rider's pay depended on which code path happened to run.
 *
 * The delivery quote authority replaced that with a calculation that runs the other way:
 *
 *     product → package → route → vehicle → real operating economics
 *                                                  ↓
 *                                            RIDER GROSS
 *                                                  ↓
 *                                 dynamic SOKONI share, 16–25%
 *                                                  ↓
 *                                      CUSTOMER DELIVERY FEE
 *
 * The rider's number is built BOTTOM-UP from what the job actually costs to perform, and
 * the customer fee is derived so SOKONI's share lands inside a commercial band. The band
 * is a guardrail, not a formula: a percentage of a fee deciding what a rider deserves is
 * how a long, heavy, expensive job ends up paying the same as a short one.
 *
 * So this module does not compute a share. It READS the one that was pinned to the job
 * when the delivery was raised — or it refuses.
 *
 * ── REFUSING IS THE WHOLE VALUE ──────────────────────────────────────────────
 * A path that cannot find a pinned quote must not fall back to a percentage. Falling back
 * is what made the old number authoritative in practice while everybody believed the
 * quote was. An unquoted delivery leaves the rider's portion UNALLOCATED and says so;
 * holding money and naming why is recoverable, and paying the wrong figure is not.
 */

/* THE LIST OF RETIRED SHARES LIVES IN THE CERTIFICATION, not here.

   An assertion input does not belong in a money module, and naming the old numbers in
   this file — even only to forbid them — would put them back inside the one file whose
   entire claim is that it applies no share at all. */

const REASON = Object.freeze({
  NO_PINNED_QUOTE: 'NO_PINNED_QUOTE',
  QUOTE_DOES_NOT_RECONCILE: 'QUOTE_DOES_NOT_RECONCILE',
  NON_POSITIVE_RIDER_EARNING: 'NON_POSITIVE_RIDER_EARNING',
  NO_PRICING_VERSION: 'NO_PRICING_VERSION',
});

function refuse(reason, detail) {
  return { ok: false, reason, detail: detail == null ? null : detail };
}
function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Shillings to integer cents. A float that will not land on a cent is refused upstream. */
function toCents(kes) {
  const n = Number(kes);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/**
 * THE AUTHORITATIVE ALLOCATION, read from the quote pinned to the delivery job.
 *
 * Both halves are taken from the quote rather than one being derived from the other: a
 * derived remainder hides a tampered figure, because whatever the stored numbers say, the
 * two will always appear to add up.
 */
function fromPinnedQuote(quote) {
  const q = isPlainObject(quote) ? quote : null;
  if (!q) return refuse(REASON.NO_PINNED_QUOTE);

  if (!q.pricingVersion) return refuse(REASON.NO_PRICING_VERSION);

  const riderMinor = toCents(q.riderGross);
  const customerMinor = toCents(q.customerDeliveryFee);
  const commissionMinor = toCents(q.sokoniCommission);

  if (riderMinor == null || customerMinor == null || commissionMinor == null) {
    return refuse(REASON.NO_PINNED_QUOTE, 'the quote is missing a figure');
  }
  if (!(riderMinor > 0)) return refuse(REASON.NON_POSITIVE_RIDER_EARNING, String(q.riderGross));

  /* THE PINNED FIGURES MUST STILL RECONCILE — the same check the certified delivery
     settlement makes, for the same reason: a stored quote whose halves no longer sum to
     the customer fee has been tampered with, and is not settled from whichever number
     looks right. */
  if (customerMinor - riderMinor !== commissionMinor) {
    return refuse(REASON.QUOTE_DOES_NOT_RECONCILE,
      q.customerDeliveryFee + ' - ' + q.riderGross + ' != ' + q.sokoniCommission);
  }

  return {
    ok: true,
    riderMinor,
    commissionMinor,
    customerMinor,
    /* Carried for the record, never used to recompute anything. */
    sharePct: q.sokoniSharePct != null ? Number(q.sokoniSharePct) : null,
    pricingVersion: String(q.pricingVersion),
    source: 'pinned_quote',
  };
}

/**
 * WHAT A PATH WITH NO QUOTE MUST DO.
 *
 * Returns an allocation of NOTHING to the rider, with the delivery amount recorded as
 * unallocated and a reason attached. Deliberately shaped like a successful allocation so
 * a caller cannot ignore it by forgetting to check `ok` — the numbers are simply zero and
 * the reason is present.
 */
function unallocated(deliveryMinor, reason) {
  const minor = Number.isInteger(deliveryMinor) ? deliveryMinor : 0;
  return {
    ok: true,
    riderMinor: 0,
    commissionMinor: 0,
    /* The money is not lost and not split — it is held, and named. */
    unallocatedMinor: minor,
    unallocatedReason: reason || REASON.NO_PINNED_QUOTE,
    sharePct: null,
    pricingVersion: null,
    source: 'unallocated',
  };
}

/**
 * The single entry point for every settlement path.
 *
 * Give it the pinned quote if the caller could resolve one, and the delivery amount it
 * was otherwise about to split. It never splits.
 */
function allocate(input) {
  const i = isPlainObject(input) ? input : {};

  if (i.pinnedQuote) {
    const r = fromPinnedQuote(i.pinnedQuote);
    if (r.ok) return r;
    /* A quote that exists but does not hold up is WORSE than none — it means something
       wrote a figure nobody can stand behind. Held, with the specific failure named. */
    return unallocated(Number.isInteger(i.deliveryMinor) ? i.deliveryMinor : 0, r.reason);
  }

  return unallocated(Number.isInteger(i.deliveryMinor) ? i.deliveryMinor : 0, REASON.NO_PINNED_QUOTE);
}

module.exports = { REASON, toCents, fromPinnedQuote, unallocated, allocate };
