/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI AVAILABILITY MODEL — one implementation, mirroring the server exactly.
   ══════════════════════════════════════════════════════════════════════════════
   THE CANONICAL SHAPE, read by functions/kasshop.js effectiveForShop():

     providerAvailability/{ownerUid}
       hours:     { sun|mon|tue|wed|thu|fri|sat:
                    { closed: bool, periods: [{ open:'HH:MM', close:'HH:MM' }] } }
       overrides: { 'YYYY-MM-DD': { closed: true|false } }

   `overrides` is a MAP FIELD on the document. It is NOT the overrides/{date}
   subcollection — availability-manager.html wrote that subcollection, the resolver
   never read it, and so every holiday a seller set was silently ignored by the
   storefront. Anything writing overrides must write THIS field.

   WHY A CLIENT COPY OF THE SERVER RULE EXISTS AT ALL

   It does not decide anything a shopper is shown. The SERVER's decision
   (getMinishopPublic -> availability) is the authority, and where it is present it
   wins. This computes only what the server does not send:

     · the editor's live preview, so a merchant sees the effect of a schedule
       BEFORE saving it — there is no server answer for unsaved input
     · "next opening", which the payload does not carry

   So the rule is duplicated deliberately and kept identical to kasshop.js. If they
   ever disagree, the SERVER is right — every consumer here treats a supplied
   server verdict as final and uses this only to fill gaps.

   Timezone: EAT (+180), the same constant effectiveForShop passes.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SokoniAvailabilityModel = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  var LABEL = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday',
                thu: 'Thursday', fri: 'Friday', sat: 'Saturday' };
  var TZ_MIN = 180;                       /* EAT — the evaluator's default zone (Africa/Nairobi) */
  var LABEL_KEYS = DAYS.map(function (d) { return LABEL[d]; });

  function toMin (hhmm) {
    var p = String(hhmm || '').split(':');
    var h = parseInt(p[0], 10), m = parseInt(p[1], 10);
    return (isFinite(h) && isFinite(m)) ? h * 60 + m : null;
  }
  function pad2 (n) { return (n < 10 ? '0' : '') + n; }
  function fromMin (m) { return pad2(Math.floor(m / 60) % 24) + ':' + pad2(m % 60); }

  /* Local (shop-timezone) view of an instant. */
  function localOf (atMs, tzMin) {
    return new Date((atMs || Date.now()) + ((tzMin == null ? TZ_MIN : tzMin) * 60000));
  }
  function ymdOf (d) { return d.toISOString().slice(0, 10); }

  /* ── THE DECISION IS NOT MADE HERE (2026-09-29) ──────────────────────────────
     computeEffective / nextOpening / closesAt are ADAPTERS over the ONE evaluator,
     functions/shared/shop-hours.js, served byte-identically as /sokoni-shop-hours.js
     (window.SokoniShopHours). They used to be a hand-kept copy of the server rule that
     drifted: no breaks, no special-hours times, midnight tails dropped. A page that
     loads this file must load /sokoni-shop-hours.js first. */
  function H () {
    var h = (typeof globalThis !== 'undefined' ? globalThis : this).SokoniShopHours;
    if (!h && typeof require === 'function') { try { h = require('./sokoni-shop-hours.js'); } catch (_) { h = null; } }
    if (!h) throw new Error('SokoniShopHours (sokoni-shop-hours.js) must load before sokoni-availability-model.js');
    return h;
  }
  function _eval (hours, overrides, atMs) {
    return H().evaluate({ hours: hours || null, overrides: overrides || null }, atMs || Date.now());
  }

  /* The server's decision — the same evaluator. Returns {open, reason, source, status, …}. */
  function computeEffective (hours, overrides, atMs, tzMin) {   // eslint-disable-line no-unused-vars
    return _eval(hours, overrides, atMs);
  }

  function periodsFor (hours, overrides, atMs, tzMin) {   // eslint-disable-line no-unused-vars
    return (_eval(hours, overrides, atMs).today || []).slice();
  }

  /* The next moment the shop opens. null = UNKNOWN (nothing within the horizon), never "closed for ever". */
  function nextOpening (hours, overrides, atMs, tzMin, horizonDays) {   // eslint-disable-line no-unused-vars
    if (!hours) return null;
    var now = atMs || Date.now();
    var v = _eval(hours, overrides, now);
    if (v.open && v.closesAt) v = _eval(hours, overrides, now + (v.closesAt.minutesAway + 1) * 60000);
    var o = v.opensAt;
    if (!o) return null;
    var dayKey = DAYS[LABEL_KEYS.indexOf(o.dayLabel)] || null;
    return { day: dayKey, dayLabel: o.dayLabel, date: o.ymd, time: o.time, inDays: o.inDays };
  }

  /* When does the CURRENT open stretch end? null when not open or open all day. */
  function closesAt (hours, overrides, atMs, tzMin) {   // eslint-disable-line no-unused-vars
    var v = _eval(hours, overrides, atMs);
    return v.open && v.closesAt ? v.closesAt.time : null;
  }

  /* The next dated closure a shopper or merchant should be warned about. */
  function upcomingClosure (overrides, atMs, tzMin, horizonDays) {
    var days = horizonDays || 30;
    var local = localOf(atMs, tzMin);
    for (var d = 0; d <= days; d++) {
      var ymd = ymdOf(new Date(local.getTime() + d * 86400000));
      var ov = (overrides || {})[ymd];
      if (ov && ov.closed === true) return { date: ymd, inDays: d };
    }
    return null;
  }

  /* Validation, so a merchant cannot save a timetable the resolver would read as
     nonsense. Returns [] when clean. */
  function validate (hours) {
    var errs = [];
    if (!hours) return errs;
    DAYS.forEach(function (k) {
      var cfg = hours[k];
      if (!cfg || cfg.closed) return;
      var ps = Array.isArray(cfg.periods) ? cfg.periods : [];
      if (!ps.length) { errs.push(LABEL[k] + ' is open with no hours set.'); return; }
      ps.forEach(function (p, i) {
        var a = toMin(p && p.open), b = toMin(p && p.close);
        if (a === null || b === null) { errs.push(LABEL[k] + ' period ' + (i + 1) + ' needs both a start and an end.'); return; }
        if (a === b) errs.push(LABEL[k] + ' period ' + (i + 1) + ' starts and ends at the same time.');
      });
    });
    return errs;
  }

  /* The shop record carries a HUMAN-READABLE copy of the timetable — the resolver falls
     back to shops/{uid}.openingHours when no structured schedule exists, and other
     surfaces show it as text. Deriving it from the same object that was just saved keeps
     the two in step; letting a merchant type it separately is how they drift. */
  function formatWeek (hours) {
    if (!hours) return '';
    var order = ['mon','tue','wed','thu','fri','sat','sun'];
    var out = [];
    order.forEach(function (k) {
      var cfg = hours[k];
      var short = LABEL[k].slice(0, 3);
      if (!cfg || cfg.closed || !Array.isArray(cfg.periods) || !cfg.periods.length) {
        out.push(short + ' closed');
        return;
      }
      out.push(short + ' ' + cfg.periods.map(function (p) {
        return (p.open || '?') + '–' + (p.close || '?');
      }).join(', '));
    });
    return out.join(' · ');
  }

  function emptyWeek () {
    var h = {};
    DAYS.forEach(function (k) { h[k] = { closed: false, periods: [{ open: '08:00', close: '18:00' }] }; });
    h.sun.closed = true; h.sun.periods = [];
    return h;
  }

  return {
    DAYS: DAYS, LABEL: LABEL, TZ_MIN: TZ_MIN,
    computeEffective: computeEffective,
    periodsFor: periodsFor,
    nextOpening: nextOpening,
    closesAt: closesAt,
    upcomingClosure: upcomingClosure,
    validate: validate,
    formatWeek: formatWeek,
    emptyWeek: emptyWeek,
    toMin: toMin, fromMin: fromMin, ymdOf: ymdOf, localOf: localOf,
  };
}));
