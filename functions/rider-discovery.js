'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — BOUNDED RIDER DISCOVERY
   functions/rider-discovery.js

   Find the riders near THIS shop. Not every rider in Kenya, and not every rider loaded
   into a browser to be filtered there.

   THE RULE THIS MODULE EXISTS TO ENFORCE

       The browser never subscribes to the riders collection.

   A client-side filter over "all riders" is a correct-looking implementation that costs a
   read per rider per merchant per page-open, holds every rider in memory, and ships every
   rider's position to every shop that opens a dispatch panel. The bound has to be in the
   QUERY, which is why this module's first job is to produce the query bounds rather than
   to filter a result.

   2 km IS A DISCOVERY RADIUS, NOT A DELIVERY LIMIT

   It bounds how far from the SHOP a rider may be to appear on the initial board. It says
   nothing about how far the delivery itself travels: a rider 800 m from the shop may
   accept an 18 km job, and routinely will. Conflating the two would quietly refuse every
   long delivery, which is the opposite of what a discovery bound is for.

   EMPTY IS NOT AN ANSWER — expansion is CONTROLLED

   When nobody suitable is within 2 km the radius widens in steps, each one a fresh
   bounded query, until a suitable candidate is found or the ceiling is reached. It never
   degrades into "load everything and sort": each round is bounded, the number of rounds
   is bounded, and the result set is capped.

   ELIGIBILITY IS NOT DECIDED HERE. Vehicle suitability, capacity, workload and approval
   belong to the matching authority (sokoni-dispatch), which already gates capacity before
   distance. This module decides WHO TO ASK ABOUT, and hands them to that authority.

   PURE. No Firestore, no network. It produces bounds and decides expansion; callers query.
   ══════════════════════════════════════════════════════════════════════════════ */

const INITIAL_RADIUS_KM = 2;
/* Each step is a fresh bounded query, not a widening of one unbounded scan. */
const EXPANSION_STEPS_KM = [2, 4, 8, 15];
const MAX_RADIUS_KM = 15;
/* A dispatch board is a decision aid, not a directory. Beyond this many cards a seller is
   choosing at random, and every extra row is a read nobody looked at. */
const MAX_CARDS = 20;
/* How many riders a single bounded query may return before the caller should stop. Larger
   than MAX_CARDS because eligibility will reject some of them. */
const QUERY_LIMIT = 60;

const EARTH_KM_PER_DEG_LAT = 110.574;

function refuse(reason, detail) { return { ok: false, reason, detail: detail || null }; }

/**
 * The lat/lng box for a radius around a point.
 *
 * A box, not a circle: Firestore ranges are rectangular, so the query fetches a superset
 * and `withinRadius` trims the corners afterwards. Longitude degrees narrow with latitude,
 * so the box is computed with cos(lat) rather than a fixed degree-per-km — a fixed one is
 * roughly right in Nairobi and increasingly wrong elsewhere, which is the kind of error
 * that only shows up in another city.
 */
function boundsFor(lat, lng, radiusKm) {
  const la = Number(lat), ln = Number(lng), r = Number(radiusKm);
  if (!Number.isFinite(la) || la < -90 || la > 90) return refuse('BAD_LATITUDE', String(lat));
  if (!Number.isFinite(ln) || ln < -180 || ln > 180) return refuse('BAD_LONGITUDE', String(lng));
  if (!Number.isFinite(r) || r <= 0) return refuse('BAD_RADIUS', String(radiusKm));

  const dLat = r / EARTH_KM_PER_DEG_LAT;
  const kmPerDegLng = EARTH_KM_PER_DEG_LAT * Math.cos((la * Math.PI) / 180);
  /* Near a pole the longitude span degenerates; clamp rather than divide by ~0. */
  const dLng = kmPerDegLng > 0.0001 ? r / kmPerDegLng : 180;

  return {
    ok: true,
    bounds: {
      minLat: Math.max(-90, la - dLat), maxLat: Math.min(90, la + dLat),
      minLng: Math.max(-180, ln - dLng), maxLng: Math.min(180, ln + dLng),
      radiusKm: r, centreLat: la, centreLng: ln,
      /* The caller MUST apply this. An unbounded query is the defect this module exists
         to prevent, and a limit the caller forgets is an unbounded query. */
      limit: QUERY_LIMIT,
    },
  };
}

/** Great-circle distance, for trimming the box's corners to a circle. */
function distanceKm(aLat, aLng, bLat, bLng) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function withinRadius(centre, rider, radiusKm) {
  if (!rider || !Number.isFinite(Number(rider.lat)) || !Number.isFinite(Number(rider.lng))) return false;
  return distanceKm(centre.lat, centre.lng, Number(rider.lat), Number(rider.lng)) <= Number(radiusKm);
}

/**
 * Plan the next discovery round.
 *
 * `round` is 0-based. Returns the bounds to query, or a refusal when the ceiling is
 * reached — so a caller cannot loop for ever by asking for one more step.
 */
function planRound(shop, round) {
  const i = Math.max(0, Math.floor(Number(round) || 0));
  if (i >= EXPANSION_STEPS_KM.length) {
    return refuse('RADIUS_CEILING_REACHED', 'no eligible rider within ' + MAX_RADIUS_KM + ' km');
  }
  const radiusKm = EXPANSION_STEPS_KM[i];
  const b = boundsFor(shop && shop.lat, shop && shop.lng, radiusKm);
  if (!b.ok) return b;
  return {
    ok: true,
    round: i,
    radiusKm,
    isFinalRound: i === EXPANSION_STEPS_KM.length - 1,
    bounds: b.bounds,
  };
}

/**
 * Trim a bounded query's result to the circle, cap it, and report whether to expand.
 *
 * `eligible` is what the MATCHING AUTHORITY already accepted — this module does not judge
 * vehicles, capacity or workload, and deliberately has no opinion about them.
 */
function collect(input) {
  const { shop, radiusKm, eligible, round } = input || {};
  if (!shop || !Number.isFinite(Number(shop.lat)) || !Number.isFinite(Number(shop.lng))) {
    return refuse('NO_SHOP_LOCATION');
  }
  if (!Array.isArray(eligible)) return refuse('NO_CANDIDATES');

  const centre = { lat: Number(shop.lat), lng: Number(shop.lng) };
  const inCircle = eligible.filter((r) => withinRadius(centre, r, radiusKm));

  const withDistance = inCircle.map((r) => Object.assign({}, r, {
    distanceFromShopKm: Math.round(distanceKm(centre.lat, centre.lng, Number(r.lat), Number(r.lng)) * 10) / 10,
  })).sort((a, b) => a.distanceFromShopKm - b.distanceFromShopKm);

  const capped = withDistance.slice(0, MAX_CARDS);
  const i = Math.max(0, Math.floor(Number(round) || 0));

  return {
    ok: true,
    riders: capped,
    count: capped.length,
    radiusKm: Number(radiusKm),
    truncated: withDistance.length > capped.length,
    /* Expand only when this round found NOTHING. A short list is a real answer — widening
       because five riders felt too few would fetch strangers to sit below the ones the
       seller was already going to pick from. */
    shouldExpand: capped.length === 0 && i < EXPANSION_STEPS_KM.length - 1,
    nextRound: capped.length === 0 && i < EXPANSION_STEPS_KM.length - 1 ? i + 1 : null,
    exhausted: capped.length === 0 && i >= EXPANSION_STEPS_KM.length - 1,
  };
}

module.exports = {
  boundsFor, planRound, collect, withinRadius, distanceKm,
  INITIAL_RADIUS_KM, EXPANSION_STEPS_KM, MAX_RADIUS_KM, MAX_CARDS, QUERY_LIMIT,
};
