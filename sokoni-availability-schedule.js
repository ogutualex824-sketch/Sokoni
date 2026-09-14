/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — availability schedule shape adapter
   ------------------------------------------------------------------------------
   ONE in-memory model, TWO stored representations. Nothing here decides whether a
   shop is open; that is publicShopState()/effectiveForShop() server-side and stays
   the only resolver.

   WHY THIS EXISTS
   The seller's timetable was written in a shape the buyer-facing resolver does not
   read, so opening hours and closed dates set in availability-manager.html produced
   NO buyer-visible effect at all:

     what the seller wrote                    what effectiveForShop() reads
     ────────────────────────────────────     ─────────────────────────────────────
     providerAvailability/{uid}
       .schedule.monday{closed,periods[]}       .hours[mon] / .openingHours[mon]
       /overrides/{YYYY-MM-DD}  (subcoll)       .overrides[YYYY-MM-DD]  (doc field)

   Three mismatches at once: field name, day-key format (monday vs mon), and storage
   kind (subcollection vs document map). effectiveForShop() therefore fell through to
   reason:'no_schedule' → open:true, and a shop marked closed still read as open.

   WHY BOTH REPRESENTATIONS ARE KEPT
   functions/availability.js — the appointment/slot engine — consumes `.schedule` and
   the `/overrides` subcollection. Rewriting that is a different, larger change. So the
   legacy shape stays authoritative for slots, and the canonical shape is generated
   ALONGSIDE it for the storefront. Both come from the same normalized model here, so
   they cannot drift: there is no path that edits one without the other.

   The per-day period structure is already identical in both — {closed, periods:[{open,
   close}], breaks:[]} — so this is a key/þname translation, not a data migration.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  /* Long keys are what availability-manager.html stores; short keys are what
     kasshop.js indexes with _DAYS[new Date().getUTCDay()]. Index 0 = Sunday in
     both lists, so position is the translation. */
  var DAY_LONG  = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  var DAY_SHORT = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  function _period(p) {
    var open = String((p && p.open) || '').trim();
    var close = String((p && p.close) || '').trim();
    /* A period the resolver cannot compare is worse than no period — it would read as
       a silent "closed" rather than an obvious error. Drop malformed entries. */
    if (!/^\d{2}:\d{2}$/.test(open) || !/^\d{2}:\d{2}$/.test(close)) return null;
    return { open: open, close: close };
  }

  function _day(cfg) {
    if (!cfg || typeof cfg !== 'object') return { closed: true, periods: [] };
    var periods = Array.isArray(cfg.periods)
      ? cfg.periods.map(_period).filter(Boolean)
      : [];
    /* Explicitly closed, or open with nothing to be open for — same thing to a buyer. */
    var closed = cfg.closed === true || periods.length === 0;
    return { closed: closed, periods: periods };
  }

  /** Legacy `schedule` (long day keys) → canonical `hours` (short day keys). */
  function toCanonicalHours(schedule) {
    var out = {};
    if (!schedule || typeof schedule !== 'object') return out;
    for (var i = 0; i < DAY_LONG.length; i++) {
      var src = schedule[DAY_LONG[i]] || schedule[DAY_SHORT[i]];
      if (src === undefined) continue;
      out[DAY_SHORT[i]] = _day(src);
    }
    return out;
  }

  /**
   * Override documents → canonical `overrides` map keyed YYYY-MM-DD.
   * Accepts either the subcollection docs ([{date, closed, periods}]) or an existing map.
   */
  function toCanonicalOverrides(list) {
    var out = {};
    var arr = Array.isArray(list)
      ? list
      : Object.keys(list || {}).map(function (k) {
          return Object.assign({ date: k }, list[k]);
        });
    arr.forEach(function (o) {
      var date = String((o && o.date) || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      var periods = Array.isArray(o.periods) ? o.periods.map(_period).filter(Boolean) : [];
      /* computeEffectiveAvailability treats closed===true as a hard close and
         closed===false as special hours. Anything else is ignored by it, so be
         explicit rather than leaving it undefined. */
      var closed = o.closed === true || (o.closed !== false && periods.length === 0);
      var entry = { closed: closed };
      if (!closed && periods.length) entry.periods = periods;
      if (o.label) entry.label = String(o.label).slice(0, 80);
      out[date] = entry;
    });
    return out;
  }

  /** Stable compare so a repair only writes when the stored shape is genuinely stale. */
  function sameShape(a, b) {
    var norm = function (v) {
      return JSON.stringify(v, Object.keys(v || {}).sort());
    };
    try { return norm(a) === norm(b); } catch (e) { return false; }
  }

  /**
   * Build the canonical projection from whatever the document currently holds.
   * `doc`      — providerAvailability/{uid} data
   * `overrides`— the /overrides subcollection docs (array)
   *
   * Returns { hours, overrides, needsRepair } where needsRepair means the stored
   * buyer-facing shape is missing or disagrees with the seller-managed source.
   */
  function project(doc, overrides) {
    doc = doc || {};
    var hours = toCanonicalHours(doc.schedule || doc.hours || doc.openingHours);
    var ovr = toCanonicalOverrides(
      (overrides && overrides.length) ? overrides : (doc.overrides || {})
    );
    var needsRepair =
      !sameShape(doc.hours, hours) || !sameShape(doc.overrides || {}, ovr);
    return { hours: hours, overrides: ovr, needsRepair: needsRepair };
  }

  root.SokoniAvailabilitySchedule = {
    DAY_LONG: DAY_LONG,
    DAY_SHORT: DAY_SHORT,
    toCanonicalHours: toCanonicalHours,
    toCanonicalOverrides: toCanonicalOverrides,
    sameShape: sameShape,
    project: project,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.SokoniAvailabilitySchedule;
  }
})(typeof window !== 'undefined' ? window : globalThis);
