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
/* Cost economics are NOT listed here any more: they come from approved policy, per vehicle class.
   Only the live trip description and market signal come from the caller. */
const REQUIRED_ROUTE = [
  ['demandIndex', isPositiveNumber, 'live demand/supply ratio; 1.0 = balanced (a market signal, not a cost)'],
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

/* ── POLICY IS NOT ENGINEERING ──────────────────────────────────────────────────────────────
   The shape of the share curve — how much weight distance carries against demand, and where each
   saturates — is a COMMERCIAL decision about how SOKONI treats riders and customers. It is not a
   default an engineer may pick.

   An earlier draft of this module hard-coded distance 0.6 / demand 0.4 saturating at 20 km. Those
   numbers were invented to make the arithmetic demonstrable, and leaving them in place would have
   made a plausible-looking guess into SOKONI policy the first time a live quote issued. The curve
   is therefore INJECTED, and a quote without one REFUSES.

   Same reasoning as the economics themselves: this module already refuses without a fuel price
   because inventing one sets a rider's pay. Inventing the curve sets it just as surely. */
/* EVERY FIELD NAMES ITS UNIT. `fuelCost`, `rate` and `consumption` are forbidden shapes: a number
   whose unit lives only in someone's head is how a per-litre price gets read as per-km, or a
   major-unit figure lands in a minor-unit field. The unit is part of the name. */
const POLICY_CONTRACT = Object.freeze({
  policyVersion: 'identifier of this approved policy, e.g. "P17" — pinned onto every quote it prices',
  status: 'must be exactly "approved"; anything else refuses',
  effectiveFrom: 'ISO date from which these values apply',
  approvedBy: 'who approved these commercial values — a non-empty string',
  shareCurve: 'object: distanceWeight, demandWeight (must sum to 1), saturationKm, demandSaturationIndex',
  economics: 'object: vehicleClasses{<canonicalClass>:{...}} and demandIndex{source}',
});

/* Per-vehicle-class economics. Declared PER CLASS deliberately: a boda and a van do not share a
   fuel burn, and one blended figure would silently subsidise one class out of the other's riders. */
const CLASS_ECONOMICS_CONTRACT = Object.freeze({
  energyUnitLabel: 'the unit energy is priced in — "litre" or "kWh". Stated, never inferred.',
  energyCostKESPerUnit: 'KES per litre / per kWh (major units, max 2dp)',
  efficiencyKmPerUnit: 'km travelled per litre / per kWh (> 0)',
  maintenanceKESPerKm: 'wear + servicing provision, KES per km (major units, max 2dp)',
  riderTimeKESPerMinute: 'what a rider must earn per minute of their time, KES (major units, max 2dp)',
});

const ENERGY_UNITS = ['litre', 'kWh'];

/* KES major -> integer minor, refusing anything that is not a clean 2-decimal money value.
   `19.995` is not a price; accepting it would silently round a rider's cost basis. */
function kesMajorToMinor(v, label) {
  if (!isFiniteNumber(v) || v < 0) throw new QuoteRefused('pricing_policy_invalid', label + ' must be a non-negative number');
  const scaled = v * 100;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-6) {
    throw new QuoteRefused('pricing_policy_invalid', label + '=' + v + ' has sub-cent precision');
  }
  return rounded;
}

function assertPolicy(policy) {
  if (!policy || typeof policy !== 'object') {
    throw new QuoteRefused('pricing_policy_required',
      'no SOKONI pricing policy supplied — required: ' + Object.keys(POLICY_CONTRACT).join(', '));
  }
  for (const key of Object.keys(POLICY_CONTRACT)) {
    const v = policy[key];
    if (v === undefined || v === null || v === '') {
      throw new QuoteRefused('pricing_policy_incomplete', key + ' — ' + POLICY_CONTRACT[key]);
    }
  }
  /* APPROVAL IS EXPLICIT. A draft policy sitting in the config document must not price anything
     just because every field happens to be filled in. */
  if (String(policy.status) !== 'approved') {
    throw new QuoteRefused('pricing_policy_unapproved', 'status="' + policy.status + '", expected "approved"');
  }
  if (typeof policy.approvedBy !== 'string' || !policy.approvedBy.trim()) {
    throw new QuoteRefused('pricing_policy_unapproved', 'approvedBy must name who approved these values');
  }
  if (typeof policy.policyVersion !== 'string' || !policy.policyVersion.trim()) {
    throw new QuoteRefused('pricing_policy_incomplete', 'policyVersion must be a non-empty identifier');
  }

  const curve = policy.shareCurve;
  if (!curve || typeof curve !== 'object') throw new QuoteRefused('pricing_policy_incomplete', 'shareCurve');
  const { distanceWeight: dw, demandWeight: mw, saturationKm: sk, demandSaturationIndex: dsi } = curve;
  if (!isFiniteNumber(dw) || dw < 0 || dw > 1) throw new QuoteRefused('pricing_policy_invalid', 'shareCurve.distanceWeight');
  if (!isFiniteNumber(mw) || mw < 0 || mw > 1) throw new QuoteRefused('pricing_policy_invalid', 'shareCurve.demandWeight');
  /* Weights must partition the curve. If they do not sum to 1 the blend silently scales the whole
     band, which would move every rider's pay without anyone changing the band. */
  if (Math.abs((dw + mw) - 1) > 1e-9) {
    throw new QuoteRefused('pricing_policy_invalid',
      'shareCurve.distanceWeight + demandWeight must equal 1, got ' + (dw + mw));
  }
  if (!isPositiveNumber(sk)) throw new QuoteRefused('pricing_policy_invalid', 'shareCurve.saturationKm');
  if (!isFiniteNumber(dsi) || dsi <= 1) {
    throw new QuoteRefused('pricing_policy_invalid', 'shareCurve.demandSaturationIndex must be > 1');
  }

  const econ = policy.economics;
  if (!econ || typeof econ !== 'object') throw new QuoteRefused('pricing_policy_incomplete', 'economics');
  if (!econ.demandIndex || !String(econ.demandIndex.source || '').trim()) {
    throw new QuoteRefused('pricing_policy_incomplete',
      'economics.demandIndex.source — where the demand/supply figure comes from');
  }
  const classes = econ.vehicleClasses;
  if (!classes || typeof classes !== 'object' || !Object.keys(classes).length) {
    throw new QuoteRefused('pricing_policy_incomplete', 'economics.vehicleClasses');
  }
  /* Validate EVERY declared class up front. A class whose economics are malformed must refuse at
     load, not on the first delivery that happens to use it. */
  for (const cls of Object.keys(classes)) {
    const canon = vehicleClasses.canonicalise(cls);
    if (!canon) throw new QuoteRefused('pricing_policy_invalid', 'economics.vehicleClasses."' + cls + '" is not a canonical class');
    const c = classes[cls] || {};
    for (const key of Object.keys(CLASS_ECONOMICS_CONTRACT)) {
      if (c[key] === undefined || c[key] === null || c[key] === '') {
        throw new QuoteRefused('pricing_policy_incomplete',
          'economics.vehicleClasses.' + cls + '.' + key + ' — ' + CLASS_ECONOMICS_CONTRACT[key]);
      }
    }
    if (ENERGY_UNITS.indexOf(String(c.energyUnitLabel)) === -1) {
      throw new QuoteRefused('pricing_policy_invalid',
        'economics.vehicleClasses.' + cls + '.energyUnitLabel must be one of ' + ENERGY_UNITS.join('/'));
    }
    if (!isPositiveNumber(c.efficiencyKmPerUnit)) {
      throw new QuoteRefused('pricing_policy_invalid', 'economics.vehicleClasses.' + cls + '.efficiencyKmPerUnit');
    }
    kesMajorToMinor(c.energyCostKESPerUnit, 'economics.vehicleClasses.' + cls + '.energyCostKESPerUnit');
    kesMajorToMinor(c.maintenanceKESPerKm, 'economics.vehicleClasses.' + cls + '.maintenanceKESPerKm');
    kesMajorToMinor(c.riderTimeKESPerMinute, 'economics.vehicleClasses.' + cls + '.riderTimeKESPerMinute');
  }
  return policy;
}

/* Resolve the per-class economics into the flat, integer-minor-unit form the arithmetic uses.
   A class with no declared economics REFUSES — "every supported vehicle must have explicit
   economics; unsupported vehicles refuse". */
function resolveEconomics(policy, canonicalClass) {
  const classes = policy.economics.vehicleClasses;
  let entry = null;
  for (const cls of Object.keys(classes)) {
    if (vehicleClasses.canonicalise(cls) === canonicalClass) { entry = classes[cls]; break; }
  }
  if (!entry) {
    throw new QuoteRefused('vehicle_class_uneconomised',
      canonicalClass + ' has no declared economics in policy ' + policy.policyVersion);
  }
  const costPerUnitMinor = kesMajorToMinor(entry.energyCostKESPerUnit, 'energyCostKESPerUnit');
  return {
    energyUnitCostMinor: costPerUnitMinor,
    energyUnitsPerKm: 1 / entry.efficiencyKmPerUnit,
    maintenanceCostPerKmMinor: kesMajorToMinor(entry.maintenanceKESPerKm, 'maintenanceKESPerKm'),
    riderMinuteRateMinor: kesMajorToMinor(entry.riderTimeKESPerMinute, 'riderTimeKESPerMinute'),
    energyUnitLabel: String(entry.energyUnitLabel),
  };
}

/* ── The SOKONI share, derived — never fixed ───────────────────────────────────────────────
   A trip that is longer, or running into scarce supply, can carry more commission without
   starving the rider; a short trip in a balanced market cannot. The share MOVES with the
   economics and lands inside the guardrail by construction.

   Deliberately NOT a constant: the whole defect being removed is a universal split. */
function deriveSharePct(distanceKm, demandIndex, policy) {
  assertPolicy(policy);
  const span = SHARE_MAX_PCT - SHARE_MIN_PCT;
  const distanceFactor = clamp01(distanceKm / policy.shareCurve.saturationKm);
  const demandFactor = clamp01((demandIndex - 1) / (policy.shareCurve.demandSaturationIndex - 1));
  const blended = (distanceFactor * policy.shareCurve.distanceWeight) + (demandFactor * policy.shareCurve.demandWeight);
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
function quote(input, policy) {
  if (!input || typeof input !== 'object') throw new QuoteRefused('no_input');
  /* Refuse BEFORE any arithmetic. A quote computed and then rejected still leaks a number into
     logs and callers; refusing first means an unapproved policy produces no figure at all. */
  assertPolicy(policy);

  /* 1. Vehicle must be a canonical, PRICED class. An unknown token or an unpriced class refuses;
        it must never fall back to a motorcycle, which is the old vehicle defect. */
  const vclass = vehicleClasses.canonicalise(input.vehicleType);
  if (!vclass) throw new QuoteRefused('vehicle_class_unknown', String(input.vehicleType));
  if (!vehicleClasses.isDispatchEligibleClass(vclass)) {
    throw new QuoteRefused('vehicle_class_unpriced', vclass);
  }

  /* 2. Route and live market signal come from the CALLER; cost economics come from APPROVED
        POLICY, per vehicle class. Splitting them this way is the point: a caller can describe the
        trip but cannot state what it costs, so no request can move a rider's pay. */
  const e = {};
  assertRequired(input, REQUIRED_ROUTE, e);
  const classEcon = resolveEconomics(policy, vclass);
  e.energyUnitCostMinor = classEcon.energyUnitCostMinor;
  e.energyUnitsPerKm = classEcon.energyUnitsPerKm;
  e.maintenanceCostPerKmMinor = classEcon.maintenanceCostPerKmMinor;
  e.riderMinuteRateMinor = classEcon.riderMinuteRateMinor;

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
  const sokoniSharePct = deriveSharePct(e.distanceKm, e.demandIndex, policy);

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
      /* WHICH commercial values priced this delivery. Without this a later reader can see the
         figures but cannot tell a quote issued under approved policy from one issued under a
         since-revised curve — which is exactly what the renegotiation guard must detect. */
      policy: Object.freeze({
        policyVersion: String(policy.policyVersion),
        effectiveFrom: String(policy.effectiveFrom),
        approvedBy: String(policy.approvedBy),
        distanceWeight: policy.shareCurve.distanceWeight,
        demandWeight: policy.shareCurve.demandWeight,
        saturationKm: policy.shareCurve.saturationKm,
        demandSaturationIndex: policy.shareCurve.demandSaturationIndex,
        energyUnitLabel: classEcon.energyUnitLabel,
      }),
    }),
    createdAt: new Date().toISOString(),
  });
}

/* ── Settlement boundary ───────────────────────────────────────────────────────────────────
   Settlement must pay the PINNED figure and nothing else. This verifies a stored quote against
   the figures a caller believes it is settling, so a tampered `riderEarning` on the delivery
   document cannot become a payout. Tampering REFUSES; it does not silently re-derive. */
function assertSettleable(pinned, claimed, opts) {
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
  if (claimed !== undefined && claimed !== null) {
    const cl = minor(claimed);
    if (cl === null) throw new QuoteRefused('claimed_not_minor_units');
    if (cl !== r) throw new QuoteRefused('claimed_earning_mismatch', cl + ' != pinned ' + r);
  }

  /* ── RENEGOTIATION GUARD ─────────────────────────────────────────────────────────────────
     BUILT HERE, NOT REUSED. The directive referred to an existing `EARNING_RENEGOTIATED`
     protection; the census proved no such identifier exists anywhere in this codebase, so
     claiming reuse would have been false. This is the smallest contract that enforces the
     invariant:

         quote created -> persisted -> delivery completed -> settlement revalidates -> settle

     A delivery priced under one approved commercial policy must not settle under another. Without
     this, revising the share curve would silently re-price every delivery already in flight — the
     rider agreed to one number and would be paid another. Mismatch REFUSES; it never re-derives,
     because re-deriving is exactly the silent recalculation being prevented. */
  if (opts && opts.currentPolicy) {
    const cur = opts.currentPolicy;
    const pinnedPolicy = (pinned.pricingInputs && pinned.pricingInputs.policy) || null;
    if (!pinnedPolicy) {
      throw new QuoteRefused('earning_renegotiated', 'pinned quote records no pricing policy to compare');
    }
    /* VERSION FIRST. Bumping `policyVersion` is the declared way policy moves, so comparing it
       catches a revision even when the numbers coincide. The curve fields are compared as well,
       so an edit that changes values but FORGETS to bump the version is caught too — neither
       check alone is sufficient. */
    if (String(pinnedPolicy.policyVersion) !== String(cur.policyVersion)) {
      throw new QuoteRefused('earning_renegotiated',
        'quote priced under policy ' + pinnedPolicy.policyVersion + ', now ' + cur.policyVersion);
    }
    const curCurve = cur.shareCurve || {};
    const FIELDS = ['distanceWeight', 'demandWeight', 'saturationKm', 'demandSaturationIndex'];
    const drifted = FIELDS.filter((k) => Number(pinnedPolicy[k]) !== Number(curCurve[k]));
    if (drifted.length) {
      throw new QuoteRefused('earning_renegotiated',
        'pricing policy changed since the quote was pinned: ' + drifted.join(', '));
    }
  }

  /* The pinned figures must still be internally reproducible: the share the quote claims must be
     the share its own numbers actually realise. A tampered `sokoniSharePct` that leaves the
     amounts alone would otherwise pass every check above. */
  if (pinned.sokoniSharePct !== undefined && pinned.sokoniSharePct !== null) {
    const realisedTimes100 = s * 100;
    const lo = (pinned.sokoniSharePct - 1) * c, hi = (pinned.sokoniSharePct + 1) * c;
    if (realisedTimes100 < lo || realisedTimes100 > hi) {
      throw new QuoteRefused('declared_share_mismatch',
        'declares ' + pinned.sokoniSharePct + '% but realises ' + (s * 100 / c).toFixed(3) + '%');
    }
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

/* ── Where production policy comes from ────────────────────────────────────────────────────
   Firestore config, not code — so approving a commercial change is a deliberate act by whoever
   owns the commercial decision, not a code edit by whoever happens to be in the file.

   Returns null when unset. Callers must treat null as REFUSE, never as "use defaults": there are
   no defaults, by design. `platformConfig/deliveryPricing` does not exist in production today, so
   live quote issuance is BLOCKED until SOKONI supplies approved values. */
const POLICY_DOC = { collection: 'platformConfig', doc: 'deliveryPricing' };

async function loadPolicy(db) {
  if (!db) return null;
  let snap;
  try { snap = await db.collection(POLICY_DOC.collection).doc(POLICY_DOC.doc).get(); }
  catch (e) { return null; }
  if (!snap || !snap.exists) return null;
  const raw = snap.data() || {};
  /* Validate at the boundary. A malformed config must refuse exactly like an absent one, rather
     than reaching the arithmetic and producing a plausible-looking wrong number. */
  try { return assertPolicy(raw); } catch (e) { return null; }
}

module.exports = {
  quote,
  assertPolicy,
  loadPolicy,
  POLICY_CONTRACT,
  POLICY_DOC,
  assertSettleable,
  assertNoClientPricing,
  QuoteRefused,
  PRICING_VERSION,
  SHARE_MIN_PCT,
  SHARE_MAX_PCT,
  CLIENT_FORBIDDEN_FIELDS,
  _internal: { deriveSharePct, handlingMinutes },
};
