'use strict';
/**
 * CANONICAL VEHICLE VOCABULARY — V-2.
 *
 * THREE vocabularies existed and one token meant two different things:
 *
 *     application-lifecycle VEHICLE_MAP ->  moto  bicycle ebike tuktuk  car van truck
 *     sokoni-dispatch VEHICLE_CAPACITY  ->  moto  bicycle ebike tuktuk  car van truck
 *     logistics-plus _VEHICLE_TYPES     ->  bike  bicycle  --   tuk_tuk car van truck
 *
 *     VEHICLE_MAP.bike = 'bicycle'   ->  8 kg
 *     logistics-plus    'bike'       ->  the motorbike class
 *
 * Owner ruling: `bike` means MOTORCYCLE. Checked against production before landing —
 * `drivers`/`rideDrivers` hold 'moto' (2), applications hold 'motorcycle' (3),
 * `trackedVehicles` holds 'motorbike' (1), `vehicles` is empty, and **no live record holds the
 * bare token 'bike'** — so the flip changes no existing document's meaning.
 *
 * TWO RULES MAKE THIS SAFE, AND BOTH MATTER:
 *
 *  1. UNKNOWN IS NOT A DEFAULT. `normVehicle` returned 'moto' for anything unmapped, so 'suv',
 *     'tractor' and 'trailer' silently became motorcycles. That was conservative only by luck —
 *     the default is a fixed class, so it is safe exactly as long as `moto` happens to be small.
 *     canonicalise() returns NULL for unknown input and the caller must refuse.
 *
 *  2. A RECOGNISED CLASS IS NOT AUTOMATICALLY A DISPATCHABLE ONE. The five new classes have no
 *     authoritative capacity, licence category or pricing band, and those are commercial facts,
 *     not engineering ones. They are recognised (so they stop being "unknown") but NOT dispatch
 *     eligible until someone with the authority to say so fills the table in. Inventing a
 *     payload for a tractor would be a fabricated number deciding what a rider is asked to carry.
 */

const { VEHICLE_CAPACITY } = require('./sokoni-dispatch');

/* Legacy capacity keys, kept as the SOURCE of the numbers rather than retyped here — a second
   capacity table that agrees by inspection is how the three vocabularies happened. */
const LEGACY_KEY = {
  motorcycle: 'moto',
  bicycle: 'bicycle',
  ebike: 'ebike',
  tuktuk: 'tuktuk',
  car: 'car',
  van: 'van',
  truck: 'truck',
};

/* The canonical set. `capacity: null` means RECOGNISED BUT NOT PRICED — see rule 2 above. */
const CLASSES = {
  motorcycle: { capacity: cap('motorcycle') },
  bicycle:    { capacity: cap('bicycle') },
  ebike:      { capacity: cap('ebike') },
  tuktuk:     { capacity: cap('tuktuk') },
  car:        { capacity: cap('car') },
  van:        { capacity: cap('van') },
  truck:      { capacity: cap('truck') },
  /* Owner ruling V-2: pickup is its OWN class, not an alias of van. */
  pickup:     { capacity: null },
  suv:        { capacity: null },
  /* `lorry` previously aliased to truck and borrowed its 1000 kg. As its own class it has no
     authoritative capacity of its own — the old number described a truck, not a lorry. */
  lorry:      { capacity: null },
  trailer:    { capacity: null },
  tractor:    { capacity: null },
};

function cap(canonical) {
  const k = LEGACY_KEY[canonical];
  const v = k && VEHICLE_CAPACITY[k];
  return v ? { maxWeightKg: v.maxWeightKg, sizeRank: v.sizeRank } : null;
}

/* Every alias is a DECISION recorded here, never a fallthrough. */
const ALIASES = {
  moto: 'motorcycle',
  motorbike: 'motorcycle',
  motorcycle: 'motorcycle',
  bike: 'motorcycle',          /* owner ruling — NOT bicycle */
  boda: 'motorcycle',
  bodaboda: 'motorcycle',
  bicycle: 'bicycle',
  cycle: 'bicycle',
  ebike: 'ebike',
  'e-bike': 'ebike',
  electricbike: 'ebike',
  tuktuk: 'tuktuk',
  'tuk-tuk': 'tuktuk',
  tuk_tuk: 'tuktuk',
  car: 'car',
  saloon: 'car',
  suv: 'suv',
  van: 'van',
  pickup: 'pickup',
  'pick-up': 'pickup',
  truck: 'truck',
  lorry: 'lorry',
  trailer: 'trailer',
  trailercombination: 'trailer',
  tractor: 'tractor',
};

/* A guard against the failure this module exists to remove: an alias that points at a class the
   canonical set does not define would reintroduce a silent mismatch. Thrown at require time, so
   it cannot ship. */
for (const [alias, target] of Object.entries(ALIASES)) {
  if (!CLASSES[target]) throw new Error('vehicle-classes: alias ' + alias + ' -> unknown class ' + target);
}
for (const c of Object.keys(CLASSES)) {
  if (ALIASES[c] !== c) throw new Error('vehicle-classes: class ' + c + ' must alias to itself');
}

/**
 * @returns canonical class name, or NULL for anything unrecognised. Never a default.
 */
function canonicalise(input) {
  const k = String(input == null ? '' : input).toLowerCase().replace(/[\s_-]+/g, '');
  /* Normalised lookup first, then the raw key, so 'tuk_tuk' and 'tuk-tuk' both land without
     needing a row each. */
  return ALIASES[k] || ALIASES[String(input || '').toLowerCase()] || null;
}

/** Recognised AND priced — the only thing dispatch may act on. */
function isDispatchEligibleClass(input) {
  const c = canonicalise(input);
  return !!(c && CLASSES[c] && CLASSES[c].capacity);
}

function capacityOf(input) {
  const c = canonicalise(input);
  return (c && CLASSES[c] && CLASSES[c].capacity) || null;
}

/**
 * The token `sokoni-dispatch.scoreRider` understands.
 *
 * scoreRider looks capacity up as `VEHICLE_CAPACITY[type] || VEHICLE_CAPACITY.moto` — so handing
 * it the canonical 'motorcycle' would MISS and silently fall back to moto. That fallback is
 * harmless for motorcycles and wrong for everything else, and it is the same defaulting this
 * module exists to remove. Translate explicitly at the boundary instead.
 *
 * @returns a legacy VEHICLE_CAPACITY key, or NULL if the class is unknown or unpriced.
 */
function dispatchKey(input) {
  const c = canonicalise(input);
  if (!c || !CLASSES[c] || !CLASSES[c].capacity) return null;
  return LEGACY_KEY[c] || null;
}

/** Classes recognised but awaiting a commercial capacity/licence ruling. */
function unpricedClasses() {
  return Object.keys(CLASSES).filter((c) => !CLASSES[c].capacity);
}

module.exports = { CLASSES, ALIASES, canonicalise, isDispatchEligibleClass, capacityOf, dispatchKey, unpricedClasses };
