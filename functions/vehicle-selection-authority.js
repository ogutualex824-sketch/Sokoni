'use strict';
/* ════════════════════════════════════════════════════════════════════════════════════════
   VEHICLE SELECTION AUTHORITY — what should carry this shipment?

   Answers "which vehicle is appropriate?" BEFORE `delivery-quote-authority` answers "what should
   this cost?". It never prices anything and never bypasses the quote authority: it returns a
   vehicle class and the reasoning behind it, and pricing proceeds from there.

   WHY IT EXISTS
   A customer picking `vehicleType` directly picks the price with it — truck economics on a parcel
   that fits a boda. The server must decide, or at minimum validate, what is actually suitable.

   DETERMINISTIC AND EXPLAINABLE, DELIBERATELY. No model, no scoring heuristic, no learned
   weights. Every decision is a rule over declared capacities, so it can be reproduced, audited
   and argued with. A financial decision nobody can explain is not acceptable, and vehicle choice
   IS a financial decision because it selects the economics.

   SMALLEST SUITABLE, NOT LARGEST AVAILABLE. Classes are ordered by declared capacity and the
   first that fits wins, so a 30 km small parcel stays on a motorcycle.

   REFUSAL IS A FEATURE. Where the data needed to choose safely is absent, this returns
   `vehicle_selection_insufficient_data` rather than guessing. Guessing small risks a rider taking
   a load they cannot carry; guessing large silently charges truck rates for a letter.
   ════════════════════════════════════════════════════════════════════════════════════════ */

const vehicleClasses = require('./vehicle-classes');

class SelectionRefused extends Error {
  constructor(reason, detail) {
    super('vehicle selection refused: ' + reason + (detail ? ' (' + detail + ')' : ''));
    this.name = 'SelectionRefused';
    this.reason = reason;
    this.detail = detail || null;
  }
}

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isPositiveNumber = (v) => isFiniteNumber(v) && v > 0;
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;

/* Candidate classes, ordered smallest-capacity first. Derived from the canonical vocabulary, not
   listed here: a class added to `vehicle-classes` is picked up automatically, and one that loses
   its capacity declaration drops out rather than being silently treated as unlimited. */
function orderedCandidates(policy) {
  let list = Object.keys(vehicleClasses.CLASSES)
    .filter((c) => vehicleClasses.isDispatchEligibleClass(c))
    .map((c) => ({ cls: c, cap: vehicleClasses.capacityOf(c) }))
    .filter((x) => x.cap && isPositiveNumber(x.cap.maxWeightKg))
    .sort((a, b) => a.cap.maxWeightKg - b.cap.maxWeightKg);

  /* A class that cannot be PRICED is not a candidate, however well it fits.
     `bicycle` is the live case: it has a declared 8 kg capacity but no approved economics, so
     selecting it on capacity alone would hand `delivery-quote-authority` a class it must refuse —
     turning a perfectly deliverable 2 kg parcel into a failed quote. Filtered here, with the
     reason recorded, rather than discovered one layer later. */
  if (policy && policy.economics && policy.economics.vehicleClasses) {
    const priced = policy.economics.vehicleClasses;
    const hasEcon = (cls) => Object.keys(priced)
      .some((k) => vehicleClasses.canonicalise(k) === cls);
    list = list.map((x) => Object.assign({}, x, { uneconomised: !hasEcon(x.cls) }));
  }
  return list;
}

/* ── Aggregate the shipment ────────────────────────────────────────────────────────────────
   Several parcels travel together, so the VEHICLE must carry their combined load. Parcel COUNT
   alone is never the criterion when real weights exist: fifteen envelopes are not a van. */
function aggregate(shipment) {
  if (!shipment || typeof shipment !== 'object') throw new SelectionRefused('no_shipment');

  const parcels = Array.isArray(shipment.parcels) ? shipment.parcels : null;
  let totalWeightKg = null, anyDimensions = false, maxLongestCm = 0, totalVolumeLitres = 0;
  let packageCount = null;

  if (parcels && parcels.length) {
    packageCount = parcels.length;
    let sum = 0;
    for (const p of parcels) {
      const qty = isNonNegInt(p.quantity) && p.quantity > 0 ? p.quantity : 1;
      if (!isPositiveNumber(p.weightKg)) {
        throw new SelectionRefused('vehicle_selection_insufficient_data',
          'a parcel has no weightKg — weight decides which vehicle can carry the load');
      }
      sum += p.weightKg * qty;
      const dims = [p.lengthCm, p.widthCm, p.heightCm];
      if (dims.some((d) => d !== undefined && d !== null)) {
        if (!dims.every((d) => isPositiveNumber(d))) {
          throw new SelectionRefused('vehicle_selection_insufficient_data',
            'a parcel has partial dimensions — all three of lengthCm/widthCm/heightCm are needed, or none');
        }
        anyDimensions = true;
        maxLongestCm = Math.max(maxLongestCm, Math.max.apply(null, dims));
        totalVolumeLitres += (dims[0] * dims[1] * dims[2] / 1000) * qty;
      }
    }
    totalWeightKg = sum;
  } else if (isPositiveNumber(shipment.totalWeightKg)) {
    totalWeightKg = shipment.totalWeightKg;
    packageCount = isNonNegInt(shipment.packageCount) && shipment.packageCount > 0
      ? shipment.packageCount : 1;
  } else {
    throw new SelectionRefused('vehicle_selection_insufficient_data',
      'no parcel weights and no totalWeightKg — nothing to select against');
  }

  return {
    totalWeightKg,
    packageCount,
    anyDimensions,
    maxLongestCm: anyDimensions ? maxLongestCm : null,
    totalVolumeLitres: anyDimensions ? Math.round(totalVolumeLitres * 100) / 100 : null,
    fragile: shipment.fragile === true,
    hazardous: shipment.hazardous === true,
    pickupCount: isNonNegInt(shipment.pickupCount) && shipment.pickupCount > 0 ? shipment.pickupCount : 1,
    dropoffCount: isNonNegInt(shipment.dropoffCount) && shipment.dropoffCount > 0 ? shipment.dropoffCount : 1,
  };
}

/* ── Volume / bulk ─────────────────────────────────────────────────────────────────────────
   `vehicle-classes` declares maxWeightKg and a coarse sizeRank, but NO volume capacity. So when a
   caller supplies dimensions, this cannot honour them from existing data.

   Silently ignoring dimensions is the failure mode the whole layer exists to prevent — a 2 km
   bulky-but-light shipment would land on a motorcycle. So dimensions REFUSE unless SOKONI has
   declared volume capacities in policy. Weight-only shipments are unaffected. */
function volumeCapacityFor(cls, policy) {
  const caps = policy && policy.vehicleCapacities;
  if (!caps || !caps[cls]) return null;
  const v = caps[cls].maxVolumeLitres;
  const l = caps[cls].maxLongestSideCm;
  return {
    maxVolumeLitres: isPositiveNumber(v) ? v : null,
    maxLongestSideCm: isPositiveNumber(l) ? l : null,
  };
}

/**
 * Choose the smallest suitable vehicle for a shipment, or refuse.
 * `policy` is optional and supplies volume capacities when SOKONI has declared them.
 */
function selectVehicle(shipment, policy) {
  const agg = aggregate(shipment);

  if (agg.hazardous) {
    /* No class in the canonical vocabulary declares a hazardous-goods permission, so there is no
       basis on which to allow one. Refusing is the only honest answer until SOKONI declares it. */
    throw new SelectionRefused('hazardous_goods_unsupported',
      'no vehicle class declares hazardous-goods capability');
  }

  const candidates = orderedCandidates(policy);
  if (!candidates.length) throw new SelectionRefused('no_candidate_classes');

  if (agg.anyDimensions) {
    const anyDeclared = candidates.some((c) => {
      const vc = volumeCapacityFor(c.cls, policy);
      return vc && (vc.maxVolumeLitres || vc.maxLongestSideCm);
    });
    if (!anyDeclared) {
      throw new SelectionRefused('vehicle_selection_insufficient_data',
        'dimensions supplied but no vehicle volume capacities are declared — a bulky light load '
        + 'cannot be routed on weight alone, and ignoring the dimensions would put it on a boda');
    }
  }

  const rejected = [];
  for (const { cls, cap, uneconomised } of candidates) {
    if (uneconomised) {
      rejected.push(cls + ': no approved economics — cannot be priced');
      continue;
    }
    if (agg.totalWeightKg > cap.maxWeightKg) {
      rejected.push(cls + ': weight ' + agg.totalWeightKg + 'kg > ' + cap.maxWeightKg + 'kg');
      continue;
    }
    if (agg.anyDimensions) {
      const vc = volumeCapacityFor(cls, policy);
      if (!vc || (!vc.maxVolumeLitres && !vc.maxLongestSideCm)) {
        rejected.push(cls + ': no declared volume capacity');
        continue;
      }
      if (vc.maxVolumeLitres && agg.totalVolumeLitres > vc.maxVolumeLitres) {
        rejected.push(cls + ': volume ' + agg.totalVolumeLitres + 'L > ' + vc.maxVolumeLitres + 'L');
        continue;
      }
      if (vc.maxLongestSideCm && agg.maxLongestCm > vc.maxLongestSideCm) {
        rejected.push(cls + ': longest side ' + agg.maxLongestCm + 'cm > ' + vc.maxLongestSideCm + 'cm');
        continue;
      }
    }

    const basis = ['weight'];
    if (agg.anyDimensions) basis.push('dimensions');
    return Object.freeze({
      vehicleClass: cls,
      vehicleSelectionReason: 'smallest class whose declared capacity fits the shipment ('
        + agg.totalWeightKg + 'kg'
        + (agg.anyDimensions ? ', ' + agg.totalVolumeLitres + 'L, longest ' + agg.maxLongestCm + 'cm' : '')
        + ' across ' + agg.packageCount + ' package(s))',
      capacityBasis: basis.join(' + '),
      shipment: Object.freeze(agg),
      consideredInOrder: Object.freeze(candidates.map((c) => c.cls)),
      rejectedBefore: Object.freeze(rejected),
    });
  }

  throw new SelectionRefused('shipment_exceeds_all_capacities',
    agg.totalWeightKg + 'kg exceeds every declared class capacity');
}

/**
 * Validate a CALLER-REQUESTED vehicle against the shipment.
 * A client may express a preference; it may not manufacture economics by asserting one.
 */
function assertVehicleSuitable(requested, shipment, policy) {
  const canon = vehicleClasses.canonicalise(requested);
  if (!canon) throw new SelectionRefused('vehicle_class_unknown', String(requested));
  if (!vehicleClasses.isDispatchEligibleClass(canon)) {
    throw new SelectionRefused('vehicle_class_unpriced', canon);
  }
  const chosen = selectVehicle(shipment, policy);

  const cap = vehicleClasses.capacityOf(canon);
  if (!cap || !isPositiveNumber(cap.maxWeightKg)) {
    throw new SelectionRefused('vehicle_class_uncapacitated', canon);
  }
  if (chosen.shipment.totalWeightKg > cap.maxWeightKg) {
    throw new SelectionRefused('requested_vehicle_too_small',
      canon + ' carries ' + cap.maxWeightKg + 'kg, shipment is ' + chosen.shipment.totalWeightKg + 'kg');
  }

  /* Upgrading beyond what the shipment needs is how a customer would buy truck economics for a
     parcel. It is refused, and the refusal names the class that actually fits. */
  const order = orderedCandidates(policy).map((c) => c.cls);
  if (order.indexOf(canon) > order.indexOf(chosen.vehicleClass)) {
    throw new SelectionRefused('requested_vehicle_oversized',
      canon + ' requested, but ' + chosen.vehicleClass + ' fits this shipment');
  }
  return chosen;
}

module.exports = {
  selectVehicle,
  assertVehicleSuitable,
  SelectionRefused,
  _internal: { aggregate, orderedCandidates, volumeCapacityFor },
};
