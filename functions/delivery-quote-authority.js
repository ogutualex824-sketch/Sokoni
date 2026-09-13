'use strict';
/* ════════════════════════════════════════════════════════════════════════════════════════
   DELIVERY QUOTE AUTHORITY — the ONLY executable delivery pricing authority.

   WHAT THIS REPLACES, AND WHY
   Production's rider payouts were computed in a BROWSER. `sokoni-delivery-pricing.js`
   (shareTarget 0.82) is loaded by checkout.html and is absent from functions/ entirely — no Cloud
   Function can require it. `delivery-hub.js` carries a second, disagreeing table (DRIVER_SHARE
   0.88, van 2500+110/km against the other's 450+58/km). The server had no pricing formula at all:
   `index.js:8562` recovered a fee as `amount - subtotal`, a RESIDUAL OF WHAT THE CUSTOMER PAID,
   then paid the rider `fee * 0.8`.

   Measured on the live records: stored driverNet 180 on a fee of 220, and 194 on 237. 220*0.82 =
   180.4 and 237*0.82 = 194.34 — the browser's number, not the server's 0.8 (which gives 176/190).
   A client editing its own table changed what SOKONI paid a rider.

   THE INVERSION THIS MODULE MAKES
   Pricing does not start from a fee and split it. It starts from what the trip COSTS the rider:

       operating economics  ->  rider gross  ->  dynamic SOKONI share  ->  customer charge

   The rider's earning is derived first and is never a percentage of a number a client chose.
   SOKONI's share is what is left over, constrained to a commercial guardrail — it is NOT the
   rider-pay formula.

   REFUSAL IS A FEATURE. If the economics needed to price honestly are absent, this refuses. It
   never falls back to a default rate: a fallback is how an arbitrary number becomes a rider's pay.

   ALL ARITHMETIC IS INTEGER MINOR UNITS via ./money-authority, which itself refuses non-integers.
   No floating-point money.
   ════════════════════════════════════════════════════════════════════════════════════════ */

const crypto = require('crypto');
const money = require('./money-authority');
const vehicleClasses = require('./vehicle-classes');

/* Bump ONLY with a deliberate commercial change. A quote records the version that priced it, so a
   delivery is forever tied to the formula in force when it was created. */
const PRICING_VERSION = 'dq-1.0.0';

/* The commercial guardrail, owner-set. A band, deliberately: a single fixed percentage is exactly
   the legacy defect (0.82 / 0.88 / 0.80) being reintroduced under a new name. */
const SHARE_MIN_PCT = 16;
const SHARE_MAX_PCT = 25;

class QuoteRefused extends Error {
  constructor(reason, detail) {
    super('delivery quote refused: ' + reason + (detail ? ' (' + detail + ')' : ''));
    this.name = 'QuoteRefused';
    this.reason = reason;
    this.detail = detail || null;
  }
}

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isPositiveNumber = (v) => isFiniteNumber(v) && v > 0;
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* ── Required economics ────────────────────────────────────────────────────────────────────
   Every one of these must be supplied by the caller and must be a real number. `undefined` is
   NOT zero — `Number(undefined)` is NaN and NaN comparisons are false, which is precisely how an
   absent input silently becomes a permissive default. Each is checked explicitly. */
const REQUIRED_ECONOMICS = [
  ['energyUnitCostMinor', isNonNegInt, 'cost of one energy unit (litre of fuel / kWh) in minor units'],
  ['energyUnitsPerKm', isPositiveNumber, 'energy units consumed per km by this vehicle'],
  ['maintenanceCostPerKmMinor', isNonNegInt, 'wear/maintenance provision per km, minor units'],
  ['riderMinuteRateMinor', isNonNegInt, 'what a rider must earn per minute of their time, minor units'],
  ['demandIndex', isPositiveNumber, 'demand/supply ratio; 1.0 = balanced'],
];

const REQUIRED_ROUTE = [
  ['distanceKm', isPositiveNumber, 'route distance'],
  ['estimatedMinutes', isPositiveNumber, 'estimated trip duration'],
];

function assertRequired(input, spec, bag) {
  for (const [key, ok, meaning] of spec) {
    const v = input[key];
    if (v === undefined || v === null) throw new QuoteRefused('missing_economics', key + ' — ' + meaning);
    if (!ok(v)) throw new QuoteRefused('invalid_economics', key + '=' + JSON.stringify(v) + ' — ' + meaning);
    bag[key] = v;
  }
}

/* ── The SOKONI share, derived — never fixed ───────────────────────────────────────────────
   A trip that is longer, or running into scarce supply, can carry more commission without
   starving the rider; a short trip in a balanced market cannot. The share therefore MOVES with
   the economics and lands inside the guardrail by construction.

   Deliberately NOT a constant: the whole defect being removed is a universal split. */
function deriveSharePct(distanceKm, demandIndex) {
  const span = SHARE_MAX_PCT - SHARE_MIN_PCT;
  const distanceFactor = clamp01(distanceKm / 20);          /* saturates at 20 km */
  const demandFactor = clamp01((demandIndex - 1) / 2);      /* 1.0 balanced -> 0; 3.0+ -> 1 */
  const blended = (distanceFactor * 0.6) + (demandFactor * 0.4);
  const pct = SHARE_MIN_PCT + Math.round(span * blended);
  /* Structural, not decorative: if the derivation is ever changed carelessly, refuse rather than
     silently pay a share outside the commercial mandate. */
  if (!Number.isInteger(pct) || pct < SHARE_MIN_PCT || pct > SHARE_MAX_PCT) {
    throw new QuoteRefused('share_out_of_band', 'derived ' + pct + '%');
  }
  return pct;
}

/* ── Handling load ────────────────────────────────────────────────────────────────────────
   Packages, stops and fragile goods cost the rider TIME, which is already paid per minute — so
   they are expressed as additional minutes, not as a surcharge on a fee. Multi-shop pickups are
   priced here ONCE; downstream must never re-derive per-leg arithmetic. */
function handlingMinutes(input) {
  const packageCount = isNonNegInt(input.packageCount) ? input.packageCount : 1;
  const shopCount = isNonNegInt(input.shopCount) ? input.shopCount : 1;
  if (packageCount < 1) throw new QuoteRefused('invalid_economics', 'packageCount must be >= 1');
  if (shopCount < 1) throw new QuoteRefused('invalid_economics', 'shopCount must be >= 1');
  const extraPackages = Math.max(0, packageCount - 1) * 2;      /* 2 min per extra parcel */
  const extraStops = Math.max(0, shopCount - 1) * 5;            /* 5 min per extra pickup */
  const fragile = input.fragile === true ? 3 : 0;
  const pickupComplexity = isNonNegInt(input.pickupComplexityMinutes) ? input.pickupComplexityMinutes : 0;
  return { extraPackages, extraStops, fragile, pickupComplexity,
    total: extraPackages + extraStops + fragile + pickupComplexity, packageCount, shopCount };
}

/**
 * Produce an immutable, pinned delivery quote — or refuse.
 * Returns integer-minor-unit figures; never floats, never a fallback price.
 */
function quote(input) {
  if (!input || typeof input !== 'object') throw new QuoteRefused('no_input');

  /* 1. Vehicle must be a canonical, PRICED class. An unknown token or an unpriced class refuses;
        it must never fall back to a motorcycle, which is the old vehicle defect. */
  const vclass = vehicleClasses.canonicalise(input.vehicleType);
  if (!vclass) throw new QuoteRefused('vehicle_class_unknown', String(input.vehicleType));
  if (!vehicleClasses.isDispatchEligibleClass(vclass)) {
    throw new QuoteRefused('vehicle_class_unpriced', vclass);
  }

  /* 2. Economics and route — all mandatory, all explicitly present. */
  const e = {};
  assertRequired(input, REQUIRED_ECONOMICS, e);
  assertRequired(input, REQUIRED_ROUTE, e);

  /* 3. Operating cost the rider actually incurs. */
  const energyCostMinor = Math.ceil(e.distanceKm * e.energyUnitsPerKm * e.energyUnitCostMinor);
  const maintenanceMinor = Math.ceil(e.distanceKm * e.maintenanceCostPerKmMinor);
  const operatingCostMinor = energyCostMinor + maintenanceMinor;

  /* 4. The rider's time, including handling. */
  const handling = handlingMinutes(input);
  const totalMinutes = e.estimatedMinutes + handling.total;
  const timeValueMinor = Math.ceil(totalMinutes * e.riderMinuteRateMinor);

  /* 5. RIDER GROSS IS DERIVED FIRST — costs covered, time paid. It is never a share of a fee. */
  const riderEarningMinor = operatingCostMinor + timeValueMinor;
  if (riderEarningMinor <= 0) throw new QuoteRefused('non_positive_rider_earning');

  /* 6. SOKONI's share, derived from the same economics, inside the guardrail. */
  const sokoniSharePct = deriveSharePct(e.distanceKm, e.demandIndex);

  /* 7. The customer charge is what makes the rider whole AFTER commission:
           charge - (share% of charge) = riderEarning
        Integer ceiling keeps the rider whole; the remainder is SOKONI's, so
        charge == riderEarning + commission EXACTLY, by construction rather than by rounding. */
  const customerChargeMinor = Math.ceil((riderEarningMinor * 100) / (100 - sokoniSharePct));
  const sokoniCommissionMinor = customerChargeMinor - riderEarningMinor;

  /* 8. Conservation and band, asserted on the integers that will actually be settled. Integer
        ceiling can nudge the realised share; if that ever pushes it outside the mandate, REFUSE
        rather than settle a percentage nobody approved. */
  if (customerChargeMinor !== riderEarningMinor + sokoniCommissionMinor) {
    throw new QuoteRefused('conservation_violated');
  }
  if (sokoniCommissionMinor * 100 < SHARE_MIN_PCT * customerChargeMinor
      || sokoniCommissionMinor * 100 > SHARE_MAX_PCT * customerChargeMinor) {
    throw new QuoteRefused('realised_share_out_of_band',
      (sokoniCommissionMinor * 100 / customerChargeMinor).toFixed(3) + '%');
  }

  return Object.freeze({
    quoteId: 'DQ-' + crypto.randomBytes(12).toString('hex'),
    pricingVersion: PRICING_VERSION,

    customerCharge: money.fromMinor(customerChargeMinor),
    riderEarning: money.fromMinor(riderEarningMinor),
    sokoniCommission: money.fromMinor(sokoniCommissionMinor),
    sokoniSharePct,

    distanceKm: e.distanceKm,
    estimatedMinutes: e.estimatedMinutes,
    totalMinutes,
    packageCount: handling.packageCount,
    shopCount: handling.shopCount,
    vehicleType: vclass,

    operatingCost: money.fromMinor(operatingCostMinor),
    energyBasis: Object.freeze({
      energyUnitCostMinor: e.energyUnitCostMinor,
      energyUnitsPerKm: e.energyUnitsPerKm,
      energyCostMinor,
      maintenanceCostPerKmMinor: e.maintenanceCostPerKmMinor,
      maintenanceMinor,
    }),
    pricingInputs: Object.freeze({
      riderMinuteRateMinor: e.riderMinuteRateMinor,
      demandIndex: e.demandIndex,
      handling: Object.freeze(handling),
      timeValueMinor,
      shareBand: [SHARE_MIN_PCT, SHARE_MAX_PCT],
    }),
    createdAt: new Date().toISOString(),
  });
}

/* ── Settlement boundary ───────────────────────────────────────────────────────────────────
   Settlement must pay the PINNED figure and nothing else. This verifies a stored quote against
   the figures a caller believes it is settling, so a tampered `riderEarning` on the delivery
   document cannot become a payout. Tampering REFUSES; it does not silently re-derive. */
function assertSettleable(pinned, claimed) {
  if (!pinned || typeof pinned !== 'object') throw new QuoteRefused('no_pinned_quote');
  for (const k of ['quoteId', 'pricingVersion']) {
    if (!pinned[k]) throw new QuoteRefused('pinned_quote_incomplete', k);
  }
  if (pinned.pricingVersion !== PRICING_VERSION) {
    throw new QuoteRefused('pricing_version_mismatch', pinned.pricingVersion + ' != ' + PRICING_VERSION);
  }
  const minor = (m) => (m && Number.isInteger(m.minorUnits) ? m.minorUnits
    : (Number.isInteger(m) ? m : null));
  const c = minor(pinned.customerCharge), r = minor(pinned.riderEarning), s = minor(pinned.sokoniCommission);
  if (c === null || r === null || s === null) throw new QuoteRefused('pinned_quote_not_minor_units');
  if (c !== r + s) throw new QuoteRefused('pinned_quote_conservation_violated', c + ' != ' + r + ' + ' + s);
  if (s * 100 < SHARE_MIN_PCT * c || s * 100 > SHARE_MAX_PCT * c) {
    throw new QuoteRefused('pinned_share_out_of_band', (s * 100 / c).toFixed(3) + '%');
  }
  if (claimed !== undefined) {
    const cl = minor(claimed);
    if (cl === null) throw new QuoteRefused('claimed_not_minor_units');
    if (cl !== r) throw new QuoteRefused('claimed_earning_mismatch', cl + ' != pinned ' + r);
  }
  return money.fromMinor(r);
}

/* Fields a client may NEVER supply as authoritative. Producers reject a payload carrying any of
   them: the browser asks for a quote, it does not state one. */
const CLIENT_FORBIDDEN_FIELDS = Object.freeze([
  'deliveryFee', 'driverNet', 'platformCut', 'riderEarning', 'riderFeeKES',
  'sokoniCommission', 'sokoniSharePct', 'customerCharge', 'pricingVersion', 'quoteId',
]);

function assertNoClientPricing(payload) {
  if (!payload || typeof payload !== 'object') return;
  const found = CLIENT_FORBIDDEN_FIELDS.filter((f) => payload[f] !== undefined);
  if (found.length) throw new QuoteRefused('client_supplied_pricing', found.join(', '));
}

module.exports = {
  quote,
  assertSettleable,
  assertNoClientPricing,
  QuoteRefused,
  PRICING_VERSION,
  SHARE_MIN_PCT,
  SHARE_MAX_PCT,
  CLIENT_FORBIDDEN_FIELDS,
  _internal: { deriveSharePct, handlingMinutes },
};
