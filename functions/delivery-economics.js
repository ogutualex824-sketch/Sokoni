/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — DELIVERY ECONOMICS RESOLVER
   functions/delivery-economics.js

   delivery-quote.js knows how to price a delivery but is given every number. This
   module is where those numbers come from: it turns an ORDER and a SHOP into the exact
   input object that authority validates, drawing operating economics from one
   configuration document and the fuel price from the live EPRA feed.

   PURE. No Firestore, no network, no admin SDK — the caller loads the documents and
   passes them in, so every decision here is certifiable without an emulator.

   ── IT INVENTS NOTHING, AND THAT IS THE POINT ─────────────────────────────────
   Every figure that decides what a rider is paid is operator-configured, and a gap is
   refused BY NAME rather than filled with a plausible number. A delivery priced from an
   assumed maintenance rate looks exactly like one priced from a real one, and the
   difference only surfaces in what a rider takes home.

   Two inputs in particular are commercial decisions this platform has not yet made:
   the ELECTRICITY TARIFF (so electric jobs refuse rather than quote) and the
   ANTI-OVERPRICING BOUNDS (so a quote is marked unreviewed rather than falsely checked).
   `missingInputs()` reports them as a list, so the gap is something an operator reads
   once rather than something discovered one refused order at a time.

   ── WHAT IS ARITHMETIC AND WHAT IS POLICY ─────────────────────────────────────
   Haversine is arithmetic: the distance between two coordinates is not a matter of
   opinion. Turning that straight line into a BILLABLE road distance is policy — it
   changes what a rider is paid — so the factor is required configuration with no
   default. The same applies to average speed, which decides the time component.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const R2 = (n) => Math.round(n * 100) / 100;

function refuse(reason, detail) { return { ok: false, reason, detail: detail || null }; }

const num = (x) => Number.isFinite(Number(x)) && Number(x) > 0;

/* ── 1. GEOGRAPHY ───────────────────────────────────────────────────────────── */

const EARTH_KM = 6371.0088;
const rad = (d) => (d * Math.PI) / 180;

/**
 * Great-circle distance in km. Arithmetic, not policy.
 */
function straightLineKm(a, b) {
  if (!a || !b) return null;
  const lat1 = Number(a.lat), lng1 = Number(a.lng);
  const lat2 = Number(b.lat), lng2 = Number(b.lng);
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return null;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R2(2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s))));
}

/**
 * The billable route between two points.
 *
 * A measured route would be better and there is no server-side routing service on this
 * platform, so the honest form is a straight line scaled by a configured factor, with
 * the basis recorded on the quote — a caller that later supplies a real routed distance
 * passes it in and this estimate is not used at all.
 */
function routeFor(config, from, to, opts) {
  const o = opts || {};

  /* A real measured route always wins. */
  if (num(o.measuredDistanceKm)) {
    const km = R2(Number(o.measuredDistanceKm));
    const speed = Number(o.averageSpeedKmH);
    if (!num(speed)) return refuse('NO_AVERAGE_SPEED', 'a measured route still needs a speed to price time');
    return {
      ok: true,
      distanceKm: km,
      estimatedMinutes: Math.max(1, Math.round((km / speed) * 60)),
      basis: { method: 'measured', source: o.measuredSource || 'caller', averageSpeedKmH: speed },
    };
  }

  const line = straightLineKm(from, to);
  if (line == null) {
    /* Not a configuration gap — this delivery simply has no geography recorded, and
       pricing it from nothing would be the fabrication this module exists to prevent. */
    return refuse('NO_COORDINATES', 'the shop or the destination has no lat/lng');
  }
  if (line <= 0) return refuse('ZERO_DISTANCE', 'pickup and destination are the same point');

  const route = (config && config.route) || null;
  const factor = route && Number(route.roadDistanceFactor);
  if (!num(factor)) {
    return refuse('NO_ROAD_DISTANCE_FACTOR',
      'turning a straight line into a billable road distance changes what a rider is paid');
  }
  if (factor < 1) {
    return refuse('INVALID_ROAD_DISTANCE_FACTOR', 'a road is never shorter than the straight line');
  }

  const speed = Number(o.averageSpeedKmH);
  if (!num(speed)) return refuse('NO_AVERAGE_SPEED', 'the time component cannot be priced without one');

  const km = R2(line * factor);
  return {
    ok: true,
    distanceKm: km,
    estimatedMinutes: Math.max(1, Math.round((km / speed) * 60)),
    basis: {
      method: 'straight-line-scaled',
      straightLineKm: line,
      roadDistanceFactor: factor,
      averageSpeedKmH: speed,
      source: 'sysConfig/deliveryEconomics',
    },
  };
}

/* ── 2. THE VEHICLE ─────────────────────────────────────────────────────────── */

/**
 * The operating economics of ONE vehicle type, as configured.
 *
 * Returned as-is for delivery-quote.js to validate — that authority already refuses a
 * missing maintenance rate, time rate, base or consumption rate by name, and duplicating
 * those checks here would give the platform two places to disagree about completeness.
 */
function vehicleFor(config, vehicleType) {
  if (!config || typeof config !== 'object') {
    return refuse('NO_ECONOMICS_CONFIG', 'sysConfig/deliveryEconomics has not been configured');
  }
  const key = String(vehicleType || '').toLowerCase();
  if (!key) return refuse('NO_VEHICLE_TYPE');

  const table = config.vehicles || null;
  if (!table || typeof table !== 'object') {
    return refuse('NO_VEHICLE_TABLE', 'the configuration carries no vehicle economics at all');
  }
  const profile = table[key];
  if (!profile || typeof profile !== 'object') {
    return refuse('NO_VEHICLE_PROFILE', key);
  }
  return { ok: true, vehicle: Object.assign({ vehicleType: key }, profile) };
}

/* ── 3. THE ENERGY BASIS ────────────────────────────────────────────────────── */

/**
 * What one unit of energy costs, and where the figure came from.
 *
 * FUEL is live: sysConfig/fuelPrices is scraped from EPRA every four hours. ELECTRICITY
 * has no feed on this platform, so it is operator-configured or absent — and when it is
 * absent this returns null, which makes delivery-quote.js refuse the electric job with
 * NO_ELECTRICITY_TARIFF. Returning null rather than refusing here keeps ONE module
 * deciding what a complete energy basis is.
 *
 * A STALE PRICE IS QUOTED WITH ITS STALENESS, not silently and not by refusing:
 * refusing outright would stop deliveries platform-wide over a scraper outage.
 * Staleness is only asserted when a threshold is configured — an age is a fact, but
 * "too old" is a judgement, and this module does not make judgements it was not given.
 */
function energyFor(config, vehicleClassEnergy, fuelDoc, opts) {
  const o = opts || {};
  const type = String(vehicleClassEnergy || '').toUpperCase();

  if (type === 'NONE') return { ok: true, energy: null };

  if (type === 'ELECTRICITY') {
    const tariff = config && Number(config.electricityTariffKESPerKWh);
    if (!num(tariff)) return { ok: true, energy: null, missing: 'NO_ELECTRICITY_TARIFF' };
    return {
      ok: true,
      energy: {
        priceKES: tariff,
        unit: 'kWh',
        source: 'sysConfig/deliveryEconomics.electricityTariffKESPerKWh',
        fetchedAt: (config && config.electricityTariffSetAt) || null,
        stale: false,
      },
    };
  }

  /* FUEL. The price is live, and sysConfig/fuelPrices stores it as
     current.<grade>.<city> — EPRA publishes per city, and Mombasa is not Nairobi. The
     city is therefore part of the price, not a detail: reading a Nairobi figure for a
     Mombasa shop would misprice every delivery there in the same direction. */
  if (!fuelDoc || typeof fuelDoc !== 'object') return { ok: true, energy: null, missing: 'NO_FUEL_PRICE' };
  const table = fuelDoc.current || null;
  if (!table || typeof table !== 'object') {
    return { ok: true, energy: null, missing: 'NO_FUEL_PRICE', detail: 'the feed has never populated' };
  }

  const grade = String(o.fuelGrade || 'super_petrol').toLowerCase();
  const byCity = table[grade];
  if (!byCity || typeof byCity !== 'object') {
    return { ok: true, energy: null, missing: 'NO_FUEL_PRICE', detail: 'grade ' + grade };
  }

  const city = String(o.city || '').toLowerCase();
  if (!city) {
    /* Not defaulted to Nairobi. A shop whose city is unrecorded is a shop this module
       cannot price honestly, and picking the capital would be a silent guess that
       happens to be right most of the time — the worst kind. */
    return { ok: true, energy: null, missing: 'NO_FUEL_PRICE_CITY',
             detail: 'EPRA publishes per city and the shop has none recorded' };
  }
  const price = Number(byCity[city]);
  if (!num(price)) {
    return { ok: true, energy: null, missing: 'NO_FUEL_PRICE', detail: grade + ' in ' + city };
  }

  const fetchedAt = fuelDoc.updatedAt || fuelDoc.scraperLastSuccess || null;
  const ageHours = ageInHours(fetchedAt, o.now);
  const maxAge = config && Number(config.maxFuelAgeHours);
  const stale = num(maxAge) && ageHours != null ? ageHours > maxAge : false;

  return {
    ok: true,
    energy: {
      priceKES: price,
      unit: 'litre',
      source: (fuelDoc.source || 'EPRA') + ' via sysConfig/fuelPrices (' + grade + ', ' + city + ')',
      fetchedAt: fetchedAt || null,
      ageHours,
      stale,
      scraperStatus: fuelDoc.scraperStatus || null,
    },
  };
}
function ageInHours(at, now) {
  if (!at) return null;
  const t = typeof at === 'string' ? Date.parse(at)
          : (at && typeof at.toMillis === 'function') ? at.toMillis()
          : (at && at._seconds) ? at._seconds * 1000
          : Number(at);
  if (!Number.isFinite(t)) return null;
  const ref = now ? (typeof now === 'number' ? now : Date.parse(now)) : Date.now();
  if (!Number.isFinite(ref)) return null;
  return R2(Math.max(0, (ref - t) / 3600000));
}

/* ── 4. THE ASSEMBLED INPUT ─────────────────────────────────────────────────── */

/** Which energy a vehicle class consumes. Mirrors delivery-quote.js CLASS_ENERGY. */
const CLASS_ENERGY = {
  PETROL_BIKE: 'FUEL', ELECTRIC_BIKE: 'ELECTRICITY', BICYCLE: 'NONE',
  CAR: 'FUEL', VAN: 'FUEL', TRUCK: 'FUEL',
};

/**
 * Build the complete input object delivery-quote.js expects.
 *
 * Returns { ok: true, input } or a NAMED refusal. It never returns a partially assembled
 * input with a guessed field: an incomplete quote is refused, because the whole reason
 * this layer exists is that a plausible number is indistinguishable from a real one once
 * it reaches a rider's earnings.
 */
function inputsFor(args) {
  /* `pickup` and `destination` are COORDINATES; `shop` supplies the city the fuel price
     is read for. They were one argument, which meant a caller passing the shop's city
     without its coordinates got NO_COORDINATES and no way to say where the shop is. */
  const { config, fuel, pickup, shop, destination, order } = args || {};
  const o = order || {};

  const vres = vehicleFor(config, args && args.vehicleType);
  if (!vres.ok) return vres;
  const vehicle = vres.vehicle;

  const cls = String(vehicle.vehicleClass || '').toUpperCase();
  const energyType = cls === 'SPECIAL'
    ? String(vehicle.energyType || '').toUpperCase()
    : CLASS_ENERGY[cls];

  const eres = energyFor(config, energyType, fuel, {
    fuelGrade: vehicle.fuelGrade,
    /* The SHOP's city, because that is where the rider buys fuel. */
    city: (shop && (shop.city || shop.town)) || (config && config.route && config.route.defaultFuelCity) || null,
    now: args && args.now,
  });
  /* A missing basis is passed through as null so ONE authority decides completeness —
     delivery-quote.js refuses it as NO_ELECTRICITY_TARIFF or NO_FUEL_PRICE. */
  const energy = eres.energy;

  const route = routeFor(config, pickup, destination, {
    averageSpeedKmH: vehicle.averageSpeedKmH,
    measuredDistanceKm: args && args.measuredDistanceKm,
    measuredSource: args && args.measuredSource,
  });
  if (!route.ok) return route;

  const handling = (config && config.handling) || null;
  if (!handling || typeof handling !== 'object') {
    return refuse('NO_HANDLING_RATES',
      'per-package, per-kg and per-stop rates decide what a heavier or multi-stop job pays');
  }

  return {
    ok: true,
    input: {
      vehicle,
      energy,
      job: {
        distanceKm: route.distanceKm,
        estimatedMinutes: route.estimatedMinutes,
        packageCount: Math.max(1, Number(o.packageCount) || 1),
        shopCount: Math.max(1, Number(o.shopCount) || 1),
        stopCount: Math.max(2, Number(o.stopCount) || (Number(o.shopCount) || 1) + 1),
        weightKg: Math.max(0, Number(o.weightKg) || 0),
        sizeClass: o.sizeClass || 'standard',
        fragile: o.fragile === true,
        specialHandling: o.specialHandling === true,
        zone: o.zone || null,
        /* Surge is not invented either: absent configuration means a multiplier of 1,
           which is the identity, not a guess. */
        demandIndex: Number((config && config.demandIndex)) || 1,
      },
      policy: (config && config.policy) || undefined,
      handling,
    },
    routeBasis: route.basis,
  };
}

/* ── 5. WHAT IS MISSING ─────────────────────────────────────────────────────── */

/**
 * The configuration gaps, as a list an operator can act on.
 *
 * Deliberately reports rather than refuses: an operator should learn that the
 * electricity tariff is unset by reading one line, not by a rider discovering that
 * electric jobs never appear.
 *
 * `blocks` says what each gap actually stops, because these are not equal — a missing
 * tariff stops only electric vehicles, while a missing road factor stops every quote.
 */
function missingInputs(config) {
  const out = [];
  const c = config || null;

  if (!c) {
    return [{ key: 'sysConfig/deliveryEconomics', blocking: true, scope: 'all',
              blocks: 'every quote',
              why: 'no delivery economics are configured at all' }];
  }

  const route = c.route || {};
  if (!num(route.roadDistanceFactor)) {
    out.push({ key: 'route.roadDistanceFactor', blocking: true, scope: 'all',
               blocks: 'every quote without a measured route',
               why: 'turning a straight line into a billable road distance changes what a rider is paid' });
  }

  if (!route.defaultVehicleType) {
    /* Found by certification: without this the callable refuses NO_VEHICLE_TYPE, which
       is honest but names a gap the reporter never mentioned — so an operator could fix
       everything on the list and still get refusals. */
    out.push({ key: 'route.defaultVehicleType', blocking: true, scope: 'all',
               blocks: 'every quote',
               why: 'an order that does not name a vehicle has to fall back to one' });
  }

  const vehicles = c.vehicles || {};
  const types = Object.keys(vehicles);
  if (!types.length) {
    out.push({ key: 'vehicles', blocking: true, scope: 'all', blocks: 'every quote',
               why: 'no vehicle operating economics are configured' });
  }
  types.forEach((t) => {
    const v = vehicles[t] || {};
    if (!num(v.averageSpeedKmH)) {
      out.push({ key: 'vehicles.' + t + '.averageSpeedKmH', blocking: true, scope: t,
                 blocks: t + ' quotes',
                 why: 'the time component cannot be priced without a speed' });
    }
  });

  if (!c.handling || typeof c.handling !== 'object') {
    out.push({ key: 'handling', blocking: true, scope: 'all', blocks: 'every quote',
               why: 'per-package, per-kg and per-stop rates decide what a heavier job pays' });
  }

  const usesElectric = types.some((t) =>
    String((vehicles[t] || {}).vehicleClass || '').toUpperCase() === 'ELECTRIC_BIKE');
  if (usesElectric && !num(c.electricityTariffKESPerKWh)) {
    out.push({ key: 'electricityTariffKESPerKWh', blocking: true, scope: 'electric',
               blocks: 'electric vehicle quotes only',
               why: 'there is no tariff feed on this platform, and an EV quote is refused rather than assumed' });
  }

  const policy = c.policy || {};
  if (!num(policy.maxCustomerFeeKES) && !num(policy.maxKESPerKm)) {
    out.push({ key: 'policy.maxCustomerFeeKES / policy.maxKESPerKm',
               blocking: false, scope: 'none',
               blocks: 'nothing — but every quote is marked requiresPolicyReview',
               why: 'an unchecked price presented as checked is worse than one openly marked unreviewed' });
  }

  return out;
}

/**
 * True when the configuration can price at least ONE vehicle end to end.
 *
 * Deliberately not 'every gap is closed'. A rate card that prices petrol bikes but has
 * no electricity tariff is a working platform with one vehicle class unavailable, and
 * reporting it as unconfigured would hide the difference between 'nothing works' and
 * 'e-bikes do not'. Only a gap that blocks EVERY quote makes this false.
 */
function isConfigured(config) {
  /* Reads the STRUCTURAL flag, not the sentence. An earlier form matched /every quote/
     against the prose and was fooled by the bounds entry, whose text reads 'nothing —
     but every quote is marked requiresPolicyReview'. A detector that parses its own
     explanation will eventually be broken by an edit to the explanation. */
  return !missingInputs(config).some((m) => m.blocking === true && m.scope === 'all');
}

module.exports = {
  straightLineKm, routeFor, vehicleFor, energyFor, inputsFor,
  missingInputs, isConfigured, ageInHours,
  CLASS_ENERGY,
};
