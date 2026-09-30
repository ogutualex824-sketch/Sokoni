'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — THE DELIVERY QUOTE AUTHORITY
   functions/delivery-quote.js

   ONE calculation produces both sides of the delivery equation:

       product → package → route → vehicle → operating economics
                                                    ↓
                                              RIDER GROSS
                                                    ↓
                                   dynamic SOKONI share, 16–25%
                                                    ↓
                                        CUSTOMER DELIVERY FEE

   WHY THIS EXISTS — measured, not assumed (traced 2026-09-10)

     courier-pricing.js        riderShare 0.88 / 0.84   platformShare 0.12 / 0.16
     packageRequests writers   driverNet = fee * 0.8    commissionPct: 5
     index.js:8055, pos-marketplace-sync.js:259

   Three opinions about one number, and the 5% is the MARKETPLACE commission sitting on
   a delivery document where a breakdown builder would read it as the delivery share —
   so a rider card built naively would show a confidently wrong figure to the person
   whose pay depends on it.

   THE DIRECTION OF THE CALCULATION IS THE POINT

   The rider's number is built BOTTOM-UP from what the job actually costs to perform.
   The customer fee is then derived so SOKONI's share lands inside the commercial band.
   The band is a GUARDRAIL, not a formula: a percentage of a fee deciding what a rider
   deserves is how a long, heavy, expensive job ends up paying the same as a short one.

   WHAT THIS MODULE REFUSES TO INVENT

   Vehicle operating economics (consumption, maintenance) and the energy price are
   CONFIGURATION. A quote for a vehicle whose economics are not configured, or whose
   energy basis is unavailable, is REFUSED — not estimated. An invented consumption
   figure would silently decide a rider's pay, and nothing downstream could tell it
   from a real one.

   PURE. No Firestore, no network, no admin SDK. It decides; callers supply and persist.
   ══════════════════════════════════════════════════════════════════════════════ */

const PRICING_VERSION = 'sokoni-delivery-v1';

/* ── Vehicle classes. EBEE is FIRST-CLASS, not a motorcycle with a footnote ──
   An electric bike is not a cheap motorcycle: its cost per km comes from a tariff and a
   consumption rate, and it can be dearer than petrol on a given day. The engine never
   assumes an e-bike is cheaper — it reads the numbers. */
const CLASS = {
  PETROL_BIKE: 'PETROL_BIKE',
  ELECTRIC_BIKE: 'ELECTRIC_BIKE',
  BICYCLE: 'BICYCLE',
  CAR: 'CAR',
  VAN: 'VAN',
  TRUCK: 'TRUCK',
  SPECIAL: 'SPECIAL',
};

const ENERGY = { FUEL: 'FUEL', ELECTRICITY: 'ELECTRICITY', NONE: 'NONE' };

/** Which energy basis a class consumes. */
const CLASS_ENERGY = {
  [CLASS.PETROL_BIKE]: ENERGY.FUEL,
  [CLASS.ELECTRIC_BIKE]: ENERGY.ELECTRICITY,
  [CLASS.BICYCLE]: ENERGY.NONE,
  [CLASS.CAR]: ENERGY.FUEL,
  [CLASS.VAN]: ENERGY.FUEL,
  [CLASS.TRUCK]: ENERGY.FUEL,
  [CLASS.SPECIAL]: null,          /* declared by the vehicle's own configuration */
};

const DEFAULT_POLICY = Object.freeze({
  minSokoniSharePct: 16,
  maxSokoniSharePct: 25,
});

const R2 = (n) => Math.round(n * 100) / 100;
const KES = (n) => Math.round(n);

function refuse(reason, detail) { return { ok: false, reason, detail: detail || null }; }

/* ── 1. VEHICLE ECONOMICS ────────────────────────────────────────────────────
   Every field here is operator-configured. The module validates completeness and
   refuses on a gap rather than substituting a plausible number. */
function validateVehicle(v) {
  if (!v || typeof v !== 'object') return refuse('NO_VEHICLE');
  const cls = String(v.vehicleClass || '').toUpperCase();
  if (!CLASS[cls]) return refuse('UNKNOWN_VEHICLE_CLASS', String(v.vehicleClass || ''));

  const energyType = cls === CLASS.SPECIAL
    ? String(v.energyType || '').toUpperCase()
    : CLASS_ENERGY[cls];
  if (!ENERGY[energyType]) return refuse('UNKNOWN_ENERGY_TYPE', String(v.energyType || ''));

  const num = (x) => Number.isFinite(Number(x)) && Number(x) >= 0;

  if (!num(v.maintenanceKESPerKm)) return refuse('NO_MAINTENANCE_RATE', v.vehicleType || cls);
  if (!num(v.riderTimeKESPerMinute)) return refuse('NO_TIME_RATE', v.vehicleType || cls);
  if (!num(v.baseKES)) return refuse('NO_BASE', v.vehicleType || cls);

  if (energyType === ENERGY.FUEL && !num(v.kmPerLitre)) return refuse('NO_CONSUMPTION_RATE', v.vehicleType || cls);
  if (energyType === ENERGY.FUEL && Number(v.kmPerLitre) === 0) return refuse('ZERO_CONSUMPTION_RATE', v.vehicleType || cls);
  if (energyType === ENERGY.ELECTRICITY && !num(v.kWhPerKm)) return refuse('NO_ENERGY_RATE', v.vehicleType || cls);

  return { ok: true, cls, energyType };
}

/* ── 2. ENERGY BASIS ─────────────────────────────────────────────────────────
   FUEL comes from the EPRA feed (sysConfig/fuelPrices, scraped every 4 hours).
   ELECTRICITY has no feed in this platform, so it MUST be operator-configured — the
   engine refuses an electric job rather than inventing a tariff.

   A stale price is quoted WITH its staleness recorded, not silently: refusing outright
   would stop deliveries platform-wide over a scraper outage, and quoting silently would
   hide that the basis is old. Both facts travel on the quote. */
function validateEnergy(energyType, energy) {
  if (energyType === ENERGY.NONE) {
    return { ok: true, basis: { type: ENERGY.NONE, priceKES: 0, unit: 'none', source: 'not-applicable' } };
  }
  if (!energy || typeof energy !== 'object') {
    return refuse(energyType === ENERGY.ELECTRICITY ? 'NO_ELECTRICITY_TARIFF' : 'NO_FUEL_PRICE');
  }
  const price = Number(energy.priceKES);
  if (!Number.isFinite(price) || price <= 0) {
    return refuse(energyType === ENERGY.ELECTRICITY ? 'NO_ELECTRICITY_TARIFF' : 'NO_FUEL_PRICE',
                  'a quote is refused rather than priced from an assumed rate');
  }
  if (!energy.source) return refuse('ENERGY_BASIS_HAS_NO_SOURCE', 'an unattributed price cannot be audited');
  return {
    ok: true,
    basis: {
      type: energyType,
      priceKES: price,
      unit: energy.unit || (energyType === ENERGY.ELECTRICITY ? 'kWh' : 'litre'),
      source: String(energy.source),
      fetchedAt: energy.fetchedAt || null,
      stale: energy.stale === true,
    },
  };
}

/* ── 3. THE JOB ──────────────────────────────────────────────────────────────
   Route and package characteristics. Multi-shop routes are measured as ONE route:
   paying per-leg would pay the rider twice for overlapping distance. */
function validateJob(j) {
  if (!j || typeof j !== 'object') return refuse('NO_JOB');
  const km = Number(j.distanceKm);
  const min = Number(j.estimatedMinutes);
  if (!Number.isFinite(km) || km <= 0) return refuse('NO_DISTANCE');
  if (!Number.isFinite(min) || min <= 0) return refuse('NO_ESTIMATED_TIME');
  return {
    ok: true,
    job: {
      distanceKm: R2(km),
      estimatedMinutes: Math.round(min),
      packageCount: Math.max(1, Math.round(Number(j.packageCount) || 1)),
      shopCount: Math.max(1, Math.round(Number(j.shopCount) || 1)),
      stopCount: Math.max(2, Math.round(Number(j.stopCount) || (Number(j.shopCount) || 1) + 1)),
      weightKg: Math.max(0, Number(j.weightKg) || 0),
      sizeClass: String(j.sizeClass || 'standard').toLowerCase(),
      fragile: j.fragile === true,
      specialHandling: j.specialHandling === true,
      zone: j.zone || null,
      demandIndex: Number.isFinite(Number(j.demandIndex)) ? Number(j.demandIndex) : 1,
    },
  };
}

/* ── 4. THE QUOTE ────────────────────────────────────────────────────────────
   Every component is named and retained. When a rider asks "why did I get this
   amount?", the answer is the object, not "the algorithm decided". */
function quote(input) {
  const { vehicle, energy, job, policy: policyIn, handling } = input || {};

  const v = validateVehicle(vehicle);
  if (!v.ok) return v;

  const e = validateEnergy(v.energyType, energy);
  if (!e.ok) return e;

  const j = validateJob(job);
  if (!j.ok) return j;

  const J = j.job;
  const policy = Object.assign({}, DEFAULT_POLICY, policyIn || {});
  if (!(policy.minSokoniSharePct > 0) || !(policy.maxSokoniSharePct >= policy.minSokoniSharePct)) {
    return refuse('INVALID_SHARE_BAND');
  }

  /* ── ENERGY COST — the real cost of moving this vehicle this far ─────────── */
  let energyCost = 0;
  if (v.energyType === ENERGY.FUEL) {
    energyCost = (J.distanceKm / Number(vehicle.kmPerLitre)) * e.basis.priceKES;
  } else if (v.energyType === ENERGY.ELECTRICITY) {
    energyCost = J.distanceKm * Number(vehicle.kWhPerKm) * e.basis.priceKES;
  }

  const maintenanceCost = J.distanceKm * Number(vehicle.maintenanceKESPerKm);
  const timeCost = J.estimatedMinutes * Number(vehicle.riderTimeKESPerMinute);
  const baseCost = Number(vehicle.baseKES);

  /* ── WORKLOAD COMPONENTS — what makes this job harder than its distance ──── */
  const H = handling || {};
  const perPackage = Number(H.perExtraPackageKES) || 0;
  const perStop = Number(H.perExtraStopKES) || 0;
  const perKg = Number(H.perKgKES) || 0;
  const fragileKES = J.fragile ? (Number(H.fragileKES) || 0) : 0;
  const specialKES = J.specialHandling ? (Number(H.specialHandlingKES) || 0) : 0;

  const packageComponent = Math.max(0, J.packageCount - 1) * perPackage;
  /* Multi-shop is paid on STOPS, not on legs: the route is measured once, so a rider is
     never paid twice for distance two legs share. */
  const multiShopComponent = Math.max(0, J.stopCount - 2) * perStop;
  const weightComponent = J.weightKg * perKg;
  const handlingComponent = fragileKES + specialKES;

  const demandMultiplier = Math.min(
    Math.max(Number(J.demandIndex) || 1, Number(policy.minDemandMultiplier) || 1),
    Number(policy.maxDemandMultiplier) || 1);

  const operatingCost = {
    base: R2(baseCost),
    energy: R2(energyCost),
    maintenance: R2(maintenanceCost),
    time: R2(timeCost),
    packages: R2(packageComponent),
    multiShop: R2(multiShopComponent),
    weight: R2(weightComponent),
    handling: R2(handlingComponent),
  };

  const riderGrossRaw =
    baseCost + energyCost + maintenanceCost + timeCost +
    packageComponent + multiShopComponent + weightComponent + handlingComponent;

  const riderGross = KES(riderGrossRaw * demandMultiplier);
  if (!(riderGross > 0)) return refuse('NON_POSITIVE_RIDER_GROSS');

  /* ── THE COMMERCIAL BAND ─────────────────────────────────────────────────
     The customer fee is derived from the rider's number, not the other way round.
     Where inside the band the share lands is decided by the job's own economics: an
     expensive-to-operate vehicle on a demanding route sits nearer the floor, because
     taking a quarter of an already-large fee would price the buyer out of a delivery
     that is costly for real reasons. */
  const span = policy.maxSokoniSharePct - policy.minSokoniSharePct;
  const costWeight = Math.min(1, Math.max(0,
    (Number(vehicle.costIndex) || 0.5) * 0.5 +
    (Math.min(J.distanceKm, 30) / 30) * 0.3 +
    (J.stopCount > 2 ? 0.2 : 0)));
  /* costlier job -> share nearer the FLOOR */
  const sharePct = R2(policy.maxSokoniSharePct - span * costWeight);

  const customerFee = KES(riderGross / (1 - sharePct / 100));
  const sokoniCommission = customerFee - riderGross;
  if (sokoniCommission < 0) return refuse('NEGATIVE_COMMISSION');

  const actualSharePct = R2((sokoniCommission / customerFee) * 100);

  /* ── ANTI-OVERPRICING ────────────────────────────────────────────────────
     Bounds are POLICY. When none are configured the quote says so rather than
     pretending it was checked — an unchecked price presented as checked is worse
     than one openly marked unreviewed. */
  const guards = { configured: false, withinBounds: null, reason: 'anti-overpricing bounds not configured' };
  if (policy.maxCustomerFeeKES || policy.maxKESPerKm) {
    guards.configured = true;
    guards.reason = null;
    const overAbsolute = policy.maxCustomerFeeKES ? customerFee > Number(policy.maxCustomerFeeKES) : false;
    const overPerKm = policy.maxKESPerKm ? (customerFee / J.distanceKm) > Number(policy.maxKESPerKm) : false;
    guards.withinBounds = !overAbsolute && !overPerKm;
    guards.overAbsolute = overAbsolute;
    guards.overPerKm = overPerKm;
    if (!guards.withinBounds && policy.refuseOutOfBounds === true) {
      return refuse('CUSTOMER_FEE_OUT_OF_BOUNDS', customerFee + ' KES for ' + J.distanceKm + ' km');
    }
  }

  return {
    ok: true,
    quote: {
      pricingVersion: PRICING_VERSION,
      vehicleType: vehicle.vehicleType || null,
      vehicleClass: v.cls,
      energyBasis: e.basis,
      operatingCost,
      demandMultiplier,
      riderGross,
      sokoniSharePct: actualSharePct,
      sokoniCommission,
      customerDeliveryFee: customerFee,
      band: { minPct: policy.minSokoniSharePct, maxPct: policy.maxSokoniSharePct, selectedPct: sharePct },
      distanceKm: J.distanceKm,
      estimatedMinutes: J.estimatedMinutes,
      packageCount: J.packageCount,
      shopCount: J.shopCount,
      stopCount: J.stopCount,
      weightKg: J.weightKg,
      sizeClass: J.sizeClass,
      guards,
      /* A quote whose bounds were never checked must not be spent silently. */
      requiresPolicyReview: guards.configured === false,
    },
  };
}

module.exports = {
  quote, validateVehicle, validateEnergy, validateJob,
  CLASS, ENERGY, CLASS_ENERGY, DEFAULT_POLICY, PRICING_VERSION,
};
