/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — DELIVERY SETTLEMENT AUTHORITY
   functions/delivery-settlement.js

   What money moves when a delivery completes, and to whom. It decides the amounts and the
   destinations; the caller applies them atomically. It never verifies a PIN and never
   advances a lifecycle — those are two other modules, and the separation is the whole
   defence: a compromised UI that can drive a PIN interaction must not thereby be able to
   move money.

   ── THE CHAIN IS VERIFIED, NOT ASSUMED ────────────────────────────────────────
   A confirmation is not a settlement trigger. Before a shilling moves, this module
   requires the WHOLE chain to be present on the job:

       an order  →  a delivery job  →  a pinned quote  →  an assigned rider
                 →  shop departure authorisation  →  buyer receipt confirmation
                 →  DELIVERED

   Any missing link is a named refusal. "The buyer entered a PIN" is evidence of one link,
   and settling on it alone would pay out a delivery that never left the shop.

   ── THE AMOUNTS ARE THE PINNED ONES, AND NOTHING ELSE ─────────────────────────
   Every figure comes from `job.pinnedQuote`, written when the delivery was raised and
   frozen since. No caller supplies an earning, a share or a net. There is no parameter
   here for one, which is stronger than validating one: a field that does not exist cannot
   be trusted by mistake.

   This is also what retires the three rider-pay rules that disagreed with each other —
   `deliveryFee * 0.8` on the legacy dispatch record, `* 0.88` on the rider's own screen,
   and `deliveryFee - platformFee` in the personal-wallet credit. The dynamic 16–25% band
   the pricing authority selected is the only one that survives, because it is the only one
   the rider actually agreed to.

   ── RIDER EARNINGS GO TO A BUSINESS WALLET, OR NOWHERE ────────────────────────
   `businessWallets/{businessId}` is where trading proceeds belong: they carry obligations
   — commission, refunds, a reconciliation somebody can be asked to produce — and mixing
   them into a personal wallet makes "what does this rider's business owe?" unanswerable.
   A rider with no business identity is REFUSED, explicitly and by name. Falling back to
   `wallets/{riderUid}` would be the exact defect this replaces, and it would look like it
   was working.

   PURE. No Firestore, no admin SDK. The caller resolves the destinations and applies the
   plan inside one transaction.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const HANDOFF = require('./delivery-handoff');

/** Everything that must be true before money moves. Order is the chain's own order. */
const LINK = {
  ORDER: 'ORDER',
  JOB: 'JOB',
  PINNED_QUOTE: 'PINNED_QUOTE',
  ASSIGNED_RIDER: 'ASSIGNED_RIDER',
  DEPARTURE: 'DEPARTURE_AUTHORISED',
  RECEIPT: 'RECEIPT_CONFIRMED',
  DELIVERED: 'DELIVERED',
};

function refuse(reason, detail) { return { ok: false, reason, detail: detail || null }; }

/** KES (whole shillings, as the quote states them) → cents, which is the wallet's unit. */
function toCents(kes) {
  const n = Number(kes);
  if (!Number.isFinite(n)) return null;
  /* The quote rounds to whole shillings before pinning, so this is exact rather than a
     float conversion that could land a cent either side. */
  return Math.round(n) * 100;
}

/* ── 1. THE CHAIN ───────────────────────────────────────────────────────────── */

/**
 * Verify every link, in order, and report the FIRST that is missing.
 *
 * Reported as a list as well as a refusal, because "why has this delivery not paid out?"
 * is a question somebody asks about a real rider waiting for real money, and "settlement
 * failed" is not an answer they can act on.
 */
function verifyChain(job) {
  const links = [];
  const add = (link, ok, detail) => { links.push({ link, ok, detail: detail || null }); return ok; };

  if (!job || !job.deliveryId) return { ok: false, reason: 'NO_JOB', links };

  add(LINK.JOB, true, job.deliveryId);

  /* The ORDER matters even though the money comes from the quote: a delivery job with no
     order behind it is not a delivery anybody placed. */
  const hasOrder = !!job.orderId;
  add(LINK.ORDER, hasOrder, job.orderId || 'the job names no order');

  const q = job.pinnedQuote || null;
  const hasQuote = !!(q && Number.isFinite(Number(q.riderGross)) &&
                      Number.isFinite(Number(q.customerDeliveryFee)) && q.pricingVersion);
  add(LINK.PINNED_QUOTE, hasQuote, hasQuote ? q.pricingVersion : 'no pinned quote to pay from');

  const hasRider = !!job.assignedRiderUid;
  add(LINK.ASSIGNED_RIDER, hasRider, job.assignedRiderUid || 'nobody carried this delivery');

  const dep = HANDOFF.evidenceFor(job, 'PICKED_UP');
  add(LINK.DEPARTURE, dep.ok === true, dep.ok ? String(job.departureConfirmedAt) : dep.detail);

  const rec = HANDOFF.evidenceFor(job, 'DELIVERED');
  add(LINK.RECEIPT, rec.ok === true, rec.ok ? String(job.receiptConfirmedAt) : rec.detail);

  const delivered = String(job.state) === 'DELIVERED';
  add(LINK.DELIVERED, delivered, job.state);

  const broken = links.filter((l) => !l.ok);
  if (broken.length) {
    return { ok: false, reason: 'CHAIN_INCOMPLETE', missing: broken.map((l) => l.link), links,
             detail: broken[0].link + ': ' + broken[0].detail };
  }
  return { ok: true, links };
}

/* ── 2. THE PLAN ────────────────────────────────────────────────────────────── */

/**
 * What moves, in cents, and where.
 *
 * `riderDestination` and `sellerDestination` are `{ ok, businessId, ... }` as the
 * settlement-destination resolver returns them. They are REQUIRED rather than resolved
 * here, because resolving reads Firestore and this module does not.
 *
 * The seller's product proceeds are deliberately NOT part of this plan. `settleOrder`
 * already owns them, with its own escrow rules, commission ladder, reversal handling and
 * exactly-once guard; re-implementing that here would give the platform two settlement
 * engines for one order, and the first divergence would be silent. What DELIVERED does for
 * the seller is release that existing settlement — the caller triggers it — and what this
 * module owns is the delivery earning, which nothing else pays correctly.
 */
function plan(input) {
  const { job, riderDestination } = input || {};

  const chain = verifyChain(job);
  if (!chain.ok) return Object.assign(refuse(chain.reason, chain.detail), { links: chain.links, missing: chain.missing });

  if (job.deliverySettledAt) {
    /* Not an error: a retry after a network failure, or a re-fired trigger. The caller
       returns the existing outcome rather than paying twice. */
    return refuse('ALREADY_SETTLED', String(job.deliverySettledAt));
  }

  const q = job.pinnedQuote;
  const riderCents = toCents(q.riderGross);
  const customerCents = toCents(q.customerDeliveryFee);
  const commissionCents = toCents(q.sokoniCommission);

  if (!(riderCents > 0)) return refuse('NON_POSITIVE_RIDER_EARNING', String(q.riderGross));

  /* THE PINNED FIGURES MUST STILL RECONCILE. A job whose stored quote has been tampered
     with — customer fee no longer the sum of the two halves — is not settled from
     "whichever number looks right"; it is refused and looked at by a person. */
  if (customerCents - riderCents !== commissionCents) {
    return refuse('PINNED_QUOTE_DOES_NOT_RECONCILE',
      q.customerDeliveryFee + ' - ' + q.riderGross + ' != ' + q.sokoniCommission);
  }

  if (!riderDestination || riderDestination.ok !== true || !riderDestination.businessId) {
    /* NAMED, and never softened into a personal-wallet fallback. A rider who cannot be
       paid to a business wallet is a rider whose business identity does not exist yet, and
       that is an onboarding gap to fix — not a reason to mix trading proceeds into
       somebody's personal balance. */
    return refuse('NO_RIDER_BUSINESS_WALLET',
      (riderDestination && riderDestination.reason) || 'the rider has no business identity');
  }

  return {
    ok: true,
    deliveryId: job.deliveryId,
    orderId: job.orderId,
    pricingVersion: q.pricingVersion,
    movements: [
      {
        /* THE ONLY MOVEMENT THIS MODULE OWNS. */
        kind: 'RIDER_DELIVERY_EARNING',
        direction: +1,
        businessId: String(riderDestination.businessId),
        amountMinor: riderCents,
        /* Deterministic, so the wallet's own entry-id idempotency covers a replay across
           both entry points rather than only within one transaction. */
        ref: 'deliveryearn_' + job.deliveryId,
        beneficiaryUid: String(job.assignedRiderUid),
      },
    ],
    /* Recorded, not moved: SOKONI's share is the remainder of a fee the platform collected
       from the buyer, so there is no transfer to make — but the figure belongs on the
       settlement record or the delivery's economics cannot be reconciled later. */
    platform: { kind: 'SOKONI_DELIVERY_COMMISSION', amountMinor: commissionCents,
                sharePct: q.sokoniSharePct != null ? Number(q.sokoniSharePct) : null },
    customerPaidMinor: customerCents,
    /* The seller's product proceeds are settleOrder's, and DELIVERED is what releases
       them. Named here so a reader knows it was decided rather than forgotten. */
    sellerProceeds: { owner: 'order-settlement.settleOrder', releasedBy: 'DELIVERED', handled: 'by the caller' },
    chain: chain.links,
  };
}

/* ── 3. WHAT THE RECORD SAYS ────────────────────────────────────────────────── */

/**
 * The settlement record, built from the plan. Written by the caller alongside the wallet
 * movements so that "why was this rider paid this?" has one document to answer it, naming
 * the pricing version, the chain that was verified and the figure that was pinned.
 */
function record(planned, at) {
  if (!planned || planned.ok !== true) return null;
  const m = planned.movements[0];
  return {
    deliveryId: planned.deliveryId,
    orderId: planned.orderId || null,
    pricingVersion: planned.pricingVersion,
    riderUid: m.beneficiaryUid,
    riderBusinessId: m.businessId,
    riderEarningMinor: m.amountMinor,
    sokoniCommissionMinor: planned.platform.amountMinor,
    sokoniSharePct: planned.platform.sharePct,
    customerDeliveryFeeMinor: planned.customerPaidMinor,
    currency: 'KES',
    chainVerified: planned.chain.map((l) => l.link),
    settledAt: at || new Date().toISOString(),
  };
}

module.exports = { LINK, verifyChain, plan, record, toCents };
