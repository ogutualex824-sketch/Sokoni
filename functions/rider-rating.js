'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — RIDER RATING AUTHORITY
   functions/rider-rating.js

   A rider's rating is the number a merchant reads when deciding who carries their goods,
   and the number a rider carries between jobs. It must therefore be impossible to
   manufacture — by the rider, by a merchant, or by anyone who never met either.

   THE RULE: A RATING IS A CONSEQUENCE OF A DELIVERY, NOT AN OPINION ABOUT ONE.

   Every rating must be redeemed against a specific delivery that:
     • actually reached DELIVERED — not cancelled, not failed, not abandoned;
     • named this rater as a party — the merchant who dispatched it, or the customer it
       was delivered to;
     • named this rider as the one who carried it;
     • has not already been rated by that party.

   No path exists to submit a rating without a delivery. That is the whole design: not a
   validation layered over a free-form review endpoint, but the absence of any other way
   in. A merchant cannot rate a rider they never dispatched to, a rider cannot rate
   themselves, and a completed job yields exactly one rating per party — ever.

   AGGREGATES ARE DERIVED, NEVER ACCUMULATED BY A CALLER.

   `recompute` takes the verified ratings and returns the average and the count. It does
   not increment a stored figure, because an incrementable rating is one a retry can
   inflate and a bug can drift. The count travels with the average for the same reason a
   ledger keeps its entries: a 4.9 from 3 deliveries and a 4.9 from 1,284 are different
   facts, and a consumer that sees only the average cannot tell them apart.

   PURE. No Firestore, no network. It decides; callers persist.
   ══════════════════════════════════════════════════════════════════════════════ */

const DELIVERED = 'DELIVERED';
const ROLE = { MERCHANT: 'merchant', CUSTOMER: 'customer' };

const MIN_STARS = 1;
const MAX_STARS = 5;

function refuse(reason, detail) { return { ok: false, reason, detail: detail || null }; }

/**
 * May `raterUid` rate the rider on `job`, and has it already happened?
 *
 * `existing` is the set of ratings already recorded FOR THIS DELIVERY — the caller reads
 * them; this decides. Passing the whole rider's history would work too, but the
 * one-per-delivery-per-party rule is about this delivery, and asking for less is what
 * keeps the check cheap enough to run on every submission.
 */
function canRate(job, raterUid, existing) {
  if (!job || !job.deliveryId) return refuse('NO_JOB');
  if (!raterUid) return refuse('NO_RATER');

  /* THE JOB MUST HAVE HAPPENED. A cancelled or failed delivery produced no service to
     rate, and allowing one would make "rate the rider" reachable by starting a job and
     abandoning it — the cheapest possible way to manufacture a score. */
  if (job.state !== DELIVERED) {
    return refuse('DELIVERY_NOT_COMPLETED', job.state || '(none)');
  }
  if (!job.assignedRiderUid) return refuse('NO_RIDER_ON_JOB');

  const uid = String(raterUid);

  /* A RIDER CANNOT RATE THEMSELVES, however they arrive at the endpoint. */
  if (uid === String(job.assignedRiderUid)) return refuse('SELF_RATING');

  let role = null;
  if (uid === String(job.merchantUid)) role = ROLE.MERCHANT;
  else if (job.customerUid && uid === String(job.customerUid)) role = ROLE.CUSTOMER;

  /* NOT A PARTY. Being a merchant, or having dispatched to this rider before, grants
     nothing here — this delivery is what confers the right to rate it. */
  if (!role) return refuse('NOT_A_PARTY_TO_THIS_DELIVERY');

  const already = (existing || []).some(
    (r) => r && String(r.deliveryId) === String(job.deliveryId) && String(r.raterUid) === uid);
  if (already) {
    /* ONE PER PARTY PER DELIVERY. A rater who could submit twice could submit a hundred
       times, and the average would be theirs rather than the platform's. */
    return refuse('ALREADY_RATED', job.deliveryId);
  }

  return { ok: true, role, riderUid: String(job.assignedRiderUid) };
}

/**
 * Build the rating record. Returns the document a caller should write — with an id
 * DERIVED from the delivery and the rater, so a retry overwrites one record instead of
 * creating a second vote.
 */
function submit(input) {
  const { job, raterUid, stars, comment, existing, at } = input || {};

  const gate = canRate(job, raterUid, existing);
  if (!gate.ok) return gate;

  const n = Number(stars);
  if (!Number.isInteger(n) || n < MIN_STARS || n > MAX_STARS) {
    return refuse('INVALID_STARS', String(stars));
  }

  const text = String(comment == null ? '' : comment).trim();
  if (text.length > 1000) return refuse('COMMENT_TOO_LONG', text.length + ' chars');

  return {
    ok: true,
    /* Derived id: one delivery, one rater, one vote. An at-least-once retry converges on
       the same document rather than adding a second. */
    ratingId: String(job.deliveryId) + '__' + String(raterUid),
    rating: {
      deliveryId: String(job.deliveryId),
      riderUid: gate.riderUid,
      raterUid: String(raterUid),
      raterRole: gate.role,
      stars: n,
      comment: text || null,
      /* The provenance that makes this rating admissible. Stored on the record so an
         audit can re-check the claim without re-reading the delivery. */
      verifiedBy: 'completed-delivery',
      deliveryState: DELIVERED,
      at: at || new Date().toISOString(),
    },
  };
}

/**
 * Derive the aggregate from verified ratings.
 *
 * Only records carrying the verification marker count. A row written by some other path —
 * a migration, an import, a hand-edit — does not silently become a vote.
 */
function recompute(ratings) {
  const verified = (ratings || []).filter(
    (r) => r && r.verifiedBy === 'completed-delivery' &&
           Number.isInteger(Number(r.stars)) &&
           Number(r.stars) >= MIN_STARS && Number(r.stars) <= MAX_STARS);

  if (!verified.length) {
    /* NO RATING, rather than a default one. A rider with no verified deliveries has not
       earned a number, and inventing a neutral score would rank them alongside someone
       who had. */
    return { ok: true, rated: false, rating: null, ratedDeliveryCount: 0 };
  }

  /* One vote per delivery per rater, enforced again here: a duplicated row cannot move
     the average even if one reached storage. */
  const seen = {};
  let sum = 0, count = 0;
  for (const r of verified) {
    const key = String(r.deliveryId) + '__' + String(r.raterUid);
    if (seen[key]) continue;
    seen[key] = true;
    sum += Number(r.stars);
    count += 1;
  }

  return {
    ok: true,
    rated: true,
    rating: Math.round((sum / count) * 100) / 100,
    ratedDeliveryCount: count,
  };
}

module.exports = { canRate, submit, recompute, ROLE, DELIVERED, MIN_STARS, MAX_STARS };
