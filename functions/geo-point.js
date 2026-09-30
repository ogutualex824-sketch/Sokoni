'use strict';
/**
 * geo-point.js — THE rule for "is this a usable position?" (F1 port, 2026-09-30).
 *
 * Moved here verbatim from rider-presence.js so that pickup-location.js can depend on it from any
 * functions lineage — including the payment lineage (webhookIntasend), which does not carry the
 * rider-presence module chain. rider-presence re-exports it; there is still exactly one rule.
 *
 * Leaf module: no requires. Keep it that way — it must load in every lineage.
 *
 * A point is usable only when both coordinates are finite numbers in range and it is not 0°,0°
 * (the classic "unset" value, which would otherwise read as a real place in the Gulf of Guinea).
 * Anything else is UNKNOWN: null, never a guess.
 */
function validLocation(data) {
  const lat = Number(data && data.lat), lng = Number(data && data.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180 || (lat === 0 && lng === 0)) return null;
  return { lat, lng };
}

module.exports = { validLocation };
