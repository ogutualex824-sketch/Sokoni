/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — COURIER PRICING AUTHORITY
   functions/courier-pricing.js
   ══════════════════════════════════════════════════════════════════════════════
   WHAT THIS REPLACES

   The courier hub priced itself in the browser. delivery-hub.js held the entire
   commercial model — VEHICLES (base/perKm/maxKm), WEIGHT_SURCHARGE, URGENCY_MULT,
   DRIVER_SHARE 0.88 and PLATFORM_SHARE 0.12 — computed the fee AND the revenue split,
   and wrote all three into Firestore itself. It called no Cloud Function at all.

   THE CATALOGUE IS VERSIONED, AND ITS VALUES ARE NOT YET POLICY

   The figures below are carried over VERBATIM from the browser so the migration changes
   the architecture without silently changing anyone's price. That is the only claim made
   about them. They are recorded as `approved: false` because no business decision
   approving them has been evidenced anywhere in this repository, and a number that has
   only ever existed in a browser constant is not policy just because it was migrated.

       approved: false   → a quote may still be CALCULATED and shown, carrying its
                           version and its unapproved status honestly
                         → a PAYMENT may not be taken against it

   That split is deliberate. It lets the whole mechanism be built and certified now, and
   leaves exactly one thing outstanding: a person approving the commercial values. To
   approve, add a catalogue whose `approved` is true — do not flip this one, because the
   version that priced a historical delivery must keep meaning what it meant.

   THE PAYOUT DESTINATION IS DECLARED, NOT INVENTED

   A courier booking has no seller and no rider — dispatch happens afterwards — so there
   is no payee to derive from the job. `platformConfig/courier.platformPayoutUid` is the
   declared source, and it is UNSET by default. Absent it, a quote still calculates and a
   payment is refused. The old `window.SOKONI_CONFIG.platformSellerUid` is not carried
   forward: it appeared exactly once in the whole tree, in the browser, and had no
   server-side existence to carry.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { HttpsError } = require('firebase-functions/v2/https');
/* ADR-012: logistics MAY consume the merchant delivery engine; the merchant engine must
   never consume logistics. The overlap is `base + perKm x distance` and it is COMPOSED
   here, not restated — the browser did the same before this migration. */
const engine = require('./shared/delivery-engine');

/* ── The catalogue ─────────────────────────────────────────────────────────────
   Each version is frozen. A delivery records the version it was priced under, so a
   later change can never restate what a past job cost. */
/* The migrated rate tables, carried from delivery-hub.js VERBATIM and still unapproved.
   Both versions below reference THIS object, so "only the split changed between them" is
   a structural fact rather than a claim: there is one table, and no edit can silently
   move one copy of it. */
const RATES_2026_09 = Object.freeze({
  vehicles: Object.freeze({
    boda:    { base: 150,  perKm: 35,  maxKm: 25  },
    bicycle: { base: 100,  perKm: 20,  maxKm: 10  },
    car:     { base: 400,  perKm: 60,  maxKm: 80  },
    pickup:  { base: 1500, perKm: 90,  maxKm: 200 },
    van:     { base: 2500, perKm: 110, maxKm: 300 },
    truck:   { base: 5000, perKm: 150, maxKm: 500 },
    ref:     { base: 3000, perKm: 130, maxKm: 300 },
    flatbed: { base: 6000, perKm: 170, maxKm: 500 },
  }),
  weightSurcharge: Object.freeze({ light: 0, medium: 0.1, heavy: 0.25, bulk: 0.4 }),
  urgencyMultiplier: Object.freeze({ standard: 1, express: 1.3, urgent: 1.6 }),
});

const CATALOGUES = Object.freeze({
  /* SUPERSEDED, and kept. Deliveries priced under this version recorded it; rewriting
     its shares would restate what a past job cost. It is never selected for a NEW quote
     because ACTIVE_VERSION names the one below. */
  'legacy-browser-2026-09': Object.freeze({
    version: 'legacy-browser-2026-09',
    approved: false,
    approvedBy: null,
    approvedAt: null,
    source: 'delivery-hub.js VEHICLES/WEIGHT_SURCHARGE/URGENCY_MULT, verbatim',
    currency: 'KES',
    vehicles: RATES_2026_09.vehicles,
    weightSurcharge: RATES_2026_09.weightSurcharge,
    urgencyMultiplier: RATES_2026_09.urgencyMultiplier,
    /* The split the browser applied. Superseded by founder direction — see below. */
    riderShare: 0.88,
    platformShare: 0.12,
  }),

  /* ACTIVE. The SPLIT is founder-directed (2026-09-07): the platform courier share is
     16%, the rider keeps 84%. That is a stated commercial intent and it is recorded here
     as the reason the number changed — not inferred from anything in the code.

     `approved` REMAINS FALSE. The split is directed; the RATE TABLE is not. It is still
     the browser's figures, which nobody has signed off, and payment stays refused until a
     catalogue is approved outright and a payout account is named. A directed split does
     not approve the prices it is a share OF. */
  'platform-split-2026-09': Object.freeze({
    version: 'platform-split-2026-09',
    approved: false,
    approvedBy: null,
    approvedAt: null,
    source: 'rates: legacy-browser-2026-09, unchanged and unapproved; split: founder direction 2026-09-07, 84/16',
    currency: 'KES',
    vehicles: RATES_2026_09.vehicles,
    weightSurcharge: RATES_2026_09.weightSurcharge,
    urgencyMultiplier: RATES_2026_09.urgencyMultiplier,
    riderShare: 0.84,
    platformShare: 0.16,
  }),
});

/* Exactly one active version, named explicitly. */
const ACTIVE_VERSION = 'platform-split-2026-09';

const QUOTE_TTL_MS = 15 * 60 * 1000;   /* a quote is a price held open, not forever */
const MAX_DISTANCE_KM = 500;           /* beyond any vehicle's maxKm; a sanity bound */

function activeCatalogue() {
  const c = CATALOGUES[ACTIVE_VERSION];
  if (!c) throw new HttpsError('internal', 'No active courier rate catalogue.');
  return c;
}
function catalogueFor(version) {
  return CATALOGUES[String(version || '')] || null;
}

/**
 * Price a courier job. PURE — no I/O, no request data beyond the declared facts, and it
 * never reads a fee, a split or a destination from anywhere but the catalogue.
 *
 * Returns { deliveryFee, riderFeeKES, platformFeeKES, ... } or throws HttpsError.
 */
function quote({ vehicleType, distanceKm, weight, urgency }, version) {
  const cat = version ? catalogueFor(version) : activeCatalogue();
  if (!cat) throw new HttpsError('failed-precondition', 'Unknown pricing version.');

  const v = cat.vehicles[String(vehicleType || '')];
  if (!v) {
    throw new HttpsError('invalid-argument',
      'Unknown vehicle type. Valid: ' + Object.keys(cat.vehicles).join(', ') + '.');
  }

  const km = Number(distanceKm);
  if (!Number.isFinite(km) || km <= 0) {
    throw new HttpsError('invalid-argument', 'distanceKm must be a positive number.');
  }
  if (km > MAX_DISTANCE_KM) {
    throw new HttpsError('invalid-argument', 'That distance is beyond any courier service.');
  }
  /* maxKm is declared per vehicle in the table and was enforced NOWHERE — the browser
     showed it as a capacity note. A boda cannot take a 400 km job. */
  if (km > v.maxKm) {
    throw new HttpsError('failed-precondition',
      'That distance exceeds the ' + vehicleType + ' limit of ' + v.maxKm + ' km. Choose a larger vehicle.');
  }

  const wKey = String(weight || '');
  if (!Object.prototype.hasOwnProperty.call(cat.weightSurcharge, wKey)) {
    throw new HttpsError('invalid-argument',
      'Unknown weight class. Valid: ' + Object.keys(cat.weightSurcharge).join(', ') + '.');
  }
  const uKey = String(urgency || '');
  if (!Object.prototype.hasOwnProperty.call(cat.urgencyMultiplier, uKey)) {
    throw new HttpsError('invalid-argument',
      'Unknown urgency. Valid: ' + Object.keys(cat.urgencyMultiplier).join(', ') + '.');
  }

  /* The leg is the SHARED engine's distance mode, exactly as delivery-hub.js called it.
     The courier surcharges are then applied on top: weight, then urgency. Composing
     rather than restating is why a change to the base formula cannot leave the courier
     hub quoting a stale one. */
  const legQuote = engine.calculateDelivery(
    { enabled: true, mode: 'distance', baseFee: v.base, perKm: v.perKm },
    { distanceKm: km });
  if (!legQuote.deliverable) {
    /* Refuse rather than fall back to a second formula. */
    throw new HttpsError('failed-precondition',
      'This job could not be priced (' + legQuote.reason + ').');
  }
  const leg = legQuote.fee;
  const withWeight = leg + Math.round(leg * cat.weightSurcharge[wKey]);
  const deliveryFee = Math.round(withWeight * cat.urgencyMultiplier[uKey]);
  if (!(deliveryFee > 0)) {
    throw new HttpsError('failed-precondition', 'This job has no payable fee.');
  }

  /* The split is the catalogue's, never the caller's. Rider is computed and the platform
     takes the remainder, so the two always reconstruct the total exactly — deriving both
     independently is how a rounding gap becomes missing money. */
  const riderFeeKES = Math.round(deliveryFee * cat.riderShare);
  const platformFeeKES = deliveryFee - riderFeeKES;

  return {
    pricingVersion: cat.version,
    pricingApproved: cat.approved === true,
    currency: cat.currency,
    vehicleType: String(vehicleType),
    distanceKm: km,
    weight: wKey,
    urgency: uKey,
    deliveryFee,
    riderFeeKES,
    platformFeeKES,
  };
}

/**
 * The declared platform payout destination, or null.
 *
 * Read from platformConfig/courier — a server document — and never from the request or
 * from window.SOKONI_CONFIG. Null is a legitimate answer and callers must fail closed on
 * it rather than substituting anything.
 */
async function platformPayoutUid(db) {
  const snap = await db.collection('platformConfig').doc('courier').get().catch(() => null);
  if (!snap || !snap.exists) return null;
  const uid = (snap.data() || {}).platformPayoutUid;
  return uid ? String(uid).trim() || null : null;
}

/**
 * May a payment be taken for this quote? Both conditions are commercial, not technical.
 */
async function payabilityProblems(db, version) {
  const cat = catalogueFor(version || ACTIVE_VERSION);
  const problems = [];
  if (!cat) problems.push('unknown_pricing_version');
  else if (cat.approved !== true) problems.push('pricing_version_not_approved');
  if (!(await platformPayoutUid(db))) problems.push('platform_payout_destination_unset');
  return problems;
}

module.exports = {
  CATALOGUES,
  ACTIVE_VERSION,
  QUOTE_TTL_MS,
  MAX_DISTANCE_KM,
  activeCatalogue,
  catalogueFor,
  quote,
  platformPayoutUid,
  payabilityProblems,
};
