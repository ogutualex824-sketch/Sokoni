'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — RIDER MARKETPLACE PROJECTION
   functions/rider-marketplace.js

   Merchant V2 shows riders the way the platform shows products: a LIST, not a map.
   No tiles, no continuous GPS rendering, no map library on a page a seller opens
   dozens of times a day. Distance and ETA are numbers on a card, which is all the
   selection decision actually needs.

   THE ONE RULE THIS MODULE EXISTS TO ENFORCE

       Merchant V2 does not calculate rider pay, vehicle cost, or the customer fee.

   The rider earning on every card is COPIED from the pinned deliveryQuote. It is never
   recomputed here, never re-derived from a percentage, and never adjusted per rider. A
   card that computed its own figure would be a fourth opinion about a number this
   platform has already had three of.

   RANKING IS NOT DONE HERE EITHER. Eligibility and scoring belong to sokoni-dispatch,
   which already gates on capacity BEFORE distance — so an EBEE is not offered a job it
   cannot carry merely because it is close. This module projects what that authority
   decided into something a seller can read, and explains WHY.

   PURE. No Firestore, no network. Callers supply riders and the quote; this shapes them.
   ══════════════════════════════════════════════════════════════════════════════ */

const AVAILABILITY = { AVAILABLE: 'AVAILABLE', BUSY: 'BUSY', OFFLINE: 'OFFLINE' };

/* What a MERCHANT may see about a rider before dispatch.

   The phone number is deliberately absent. A seller who needs to reach a rider does so
   through the job-scoped dispatch channel, which is attached to this delivery and
   auditable. Handing out a personal number to every merchant who browses the list is a
   different thing entirely, and it cannot be withdrawn once shown. */
const MERCHANT_SAFE = [
  'riderId', 'displayName', 'avatarUrl', 'vehicleType', 'vehicleClass', 'vehicleModel',
  'numberPlate', 'distanceKm', 'etaMinutes', 'rating', 'rated', 'ratedDeliveryCount',
  'completedDeliveries', 'onTimePct', 'acceptancePct', 'cancellationPct',
  'availability', 'activeJobs', 'capacityKg', 'sizeRank', 'badges', 'matchScore',
  'riderEarningKES', 'matchReasons', 'bestMatch',
];

function _pct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? Math.round(n * 1000) / 10 : Math.round(n * 10) / 10;
}

function availabilityOf(rider, maxConcurrent) {
  if (!rider) return AVAILABILITY.OFFLINE;
  const online = rider.isOnline === true || rider.online === true;
  if (!online || String(rider.status || '').toLowerCase() === 'break') return AVAILABILITY.OFFLINE;
  const active = Number(rider.activeDeliveries || 0);
  if (active >= (Number(maxConcurrent) || 3)) return AVAILABILITY.BUSY;
  return AVAILABILITY.AVAILABLE;
}

/* Why this rider suits THIS job. Stated as checked facts rather than adjectives, so a
   seller can disagree with a specific line instead of distrusting the whole ranking. */
function matchReasons(scored, rider, job) {
  const out = [];
  const cap = Number(rider.capacityKg || 0);
  if (cap && Number(job.weightKg) >= 0) {
    out.push({ ok: cap >= Number(job.weightKg),
               text: 'Suitable for ' + job.weightKg + ' kg package (carries ' + cap + ' kg)' });
  }
  if (rider.vehicleType && job.recommendedVehicle) {
    out.push({ ok: rider.vehicleType === job.recommendedVehicle,
               text: rider.vehicleType === job.recommendedVehicle
                 ? 'Matches the recommended ' + job.recommendedVehicle
                 : 'Different vehicle from the recommended ' + job.recommendedVehicle });
  }
  if (scored && Number.isFinite(scored.etaMin)) {
    out.push({ ok: true, text: 'About ' + Math.round(scored.etaMin) + ' min to pickup' });
  }
  const onTime = _pct(rider.onTimeRate);
  if (onTime !== null) out.push({ ok: onTime >= 90, text: onTime + '% on-time' });

  /* An unrated rider is stated as such. Showing a borrowed number would be worse than
     showing none: the seller cannot tell a default from an earned record. */
  if (!rider.ratedDeliveryCount) {
    out.push({ ok: true, text: 'New rider — no verified deliveries yet' });
  }
  return out;
}

/**
 * Project ranked riders into merchant-facing cards.
 *
 * `quote` is the PINNED deliveryQuote. Its riderGross is copied onto every card
 * unchanged — the earning is a property of the JOB, not of which rider takes it.
 */
function cards(input) {
  const { ranked, riders, quote, job, maxConcurrent } = input || {};
  if (!Array.isArray(ranked)) return { ok: false, reason: 'NO_RANKED_INPUT' };
  if (!quote || !Number.isFinite(Number(quote.riderGross))) {
    /* Without a pinned quote there is no authoritative earning to show, and inventing
       one per card is precisely the divergence this module exists to prevent. */
    return { ok: false, reason: 'NO_PINNED_QUOTE' };
  }
  const byId = {};
  (riders || []).forEach((r) => { if (r && r.riderId) byId[r.riderId] = r; });

  const J = job || {};
  const list = ranked.map((s, i) => {
    const r = byId[s.riderId] || {};
    const card = {
      riderId: s.riderId,
      displayName: r.displayName || s.riderName || 'SOKONI Rider',
      avatarUrl: r.avatarUrl || null,
      vehicleType: r.vehicleType || s.vehicleType || null,
      vehicleClass: r.vehicleClass || null,
      vehicleModel: r.vehicleModel || null,
      numberPlate: r.numberPlate || null,
      distanceKm: Number.isFinite(Number(s.distKm)) ? Math.round(Number(s.distKm) * 10) / 10 : null,
      etaMinutes: Number.isFinite(Number(s.etaMin)) ? Math.round(Number(s.etaMin)) : null,

      /* RATING PROVENANCE. `rated` says whether any verified delivery produced this
         figure; ratedDeliveryCount says how many. A rating with no basis is reported as
         unrated rather than as a number. */
      rating: s.rated ? (r.rating != null ? Number(r.rating) : null) : null,
      rated: s.rated === true,
      ratedDeliveryCount: Number(s.ratingBasis || r.ratedDeliveryCount || 0),

      completedDeliveries: Number(r.completedDeliveries || 0),
      onTimePct: _pct(r.onTimeRate),
      acceptancePct: _pct(r.acceptanceRate),
      cancellationPct: _pct(r.cancellationRate),
      availability: availabilityOf(r, maxConcurrent),
      activeJobs: Number(r.activeDeliveries || 0),
      capacityKg: Number(r.capacityKg || 0) || null,
      sizeRank: r.sizeRank != null ? Number(r.sizeRank) : null,
      badges: Array.isArray(r.badges) ? r.badges.slice(0, 6) : [],
      matchScore: Number.isFinite(Number(s.score)) ? Math.round(Number(s.score) * 1000) / 1000 : null,

      /* COPIED, NOT COMPUTED. */
      riderEarningKES: Math.round(Number(quote.riderGross)),

      matchReasons: matchReasons(s, r, J),
      bestMatch: i === 0,
    };
    /* Nothing outside the merchant-safe projection may travel, whatever the source
       record happened to carry. */
    const safe = {};
    MERCHANT_SAFE.forEach((k) => { if (card[k] !== undefined) safe[k] = card[k]; });
    return safe;
  });

  return {
    ok: true,
    quotePinned: {
      pricingVersion: quote.pricingVersion || null,
      riderEarningKES: Math.round(Number(quote.riderGross)),
      customerDeliveryFeeKES: Number.isFinite(Number(quote.customerDeliveryFee))
        ? Math.round(Number(quote.customerDeliveryFee)) : null,
      sokoniCommissionKES: Number.isFinite(Number(quote.sokoniCommission))
        ? Math.round(Number(quote.sokoniCommission)) : null,
      recommendedVehicle: J.recommendedVehicle || quote.vehicleType || null,
    },
    cards: list,
    count: list.length,
  };
}

/* Sort orders the seller may pick. Ranking still comes from the dispatch authority;
   these only REORDER what it already judged eligible, so no sort can surface a rider
   the capacity gate excluded. */
const SORTS = {
  best: (a, b) => (b.matchScore || 0) - (a.matchScore || 0),
  nearest: (a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9),
  fastest: (a, b) => (a.etaMinutes ?? 1e9) - (b.etaMinutes ?? 1e9),
  rated: (a, b) => (b.rating || 0) - (a.rating || 0),
};

function sortCards(list, order) {
  const fn = SORTS[String(order || 'best')] || SORTS.best;
  return list.slice().sort(fn);
}

module.exports = { cards, sortCards, availabilityOf, matchReasons, MERCHANT_SAFE, AVAILABILITY, SORTS };
