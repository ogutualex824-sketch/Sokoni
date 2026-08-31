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
  var TZ_MIN = 180;                       /* EAT — matches effectiveForShop */

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

  /* A period whose close is <= open crosses midnight — same rule as the server. */
  function withinPeriod (mins, p) {
    var a = toMin(p && p.open), b = toMin(p && p.close);
    if (a === null || b === null) return false;
    return b >= a ? (mins >= a && mins < b) : (mins >= a || mins < b);
  }

  /* The server's decision, reproduced. Returns the same {open, reason, source}. */
  function computeEffective (hours, overrides, atMs, tzMin) {
    var local = localOf(atMs, tzMin);
    var ymd = ymdOf(local);
    var ov = (overrides || {})[ymd];
    if (ov) {
      if (ov.closed === true)  return { open: false, reason: 'closed_today',  source: 'override', date: ymd };
      if (ov.closed === false) return { open: true,  reason: 'special_hours', source: 'override', date: ymd };
    }
    if (!hours) return { open: true, reason: 'no_schedule', source: 'live' };

    var cfg = hours[DAYS[local.getUTCDay()]];
    if (!cfg || cfg.closed || !Array.isArray(cfg.periods) || !cfg.periods.length) {
      return { open: false, reason: 'outside_hours', source: 'schedule' };
    }
    var mins = local.getUTCHours() * 60 + local.getUTCMinutes();
    for (var i = 0; i < cfg.periods.length; i++) {
      if (withinPeriod(mins, cfg.periods[i])) {
        return { open: true, reason: 'within_hours', source: 'schedule' };
      }
    }
    return { open: false, reason: 'outside_hours', source: 'schedule' };
  }

  function periodsFor (hours, overrides, atMs, tzMin) {
    var local = localOf(atMs, tzMin);
    var ov = (overrides || {})[ymdOf(local)];
    if (ov && ov.closed === true) return [];
    var cfg = (hours || {})[DAYS[local.getUTCDay()]];
    if (!cfg || cfg.closed || !Array.isArray(cfg.periods)) return [];
    return cfg.periods.slice();
  }

  /* The next moment the shop opens, searched forward day by day.
     Returns null when nothing is scheduled within the horizon — null means UNKNOWN
     and must be rendered as such, never as "closed for ever". */
  function nextOpening (hours, overrides, atMs, tzMin, horizonDays) {
    if (!hours) return null;
    var days = horizonDays || 14;
    var tz = (tzMin == null ? TZ_MIN : tzMin);
    var now = atMs || Date.now();
    var local = localOf(now, tz);
    var mins = local.getUTCHours() * 60 + local.getUTCMinutes();

    for (var d = 0; d <= days; d++) {
      var probe = new Date(local.getTime() + d * 86400000);
      var ymd = ymdOf(probe);
      var ov = (overrides || {})[ymd];
      if (ov && ov.closed === true) continue;              /* holiday — skip */
      var cfg = hours[DAYS[probe.getUTCDay()]];
      if (!cfg || cfg.closed || !Array.isArray(cfg.periods) || !cfg.periods.length) continue;

      var starts = cfg.periods
        .map(function (p) { return toMin(p && p.open); })
        .filter(function (v) { return v !== null; })
        .sort(function (a, b) { return a - b; });

      for (var i = 0; i < starts.length; i++) {
        if (d > 0 || starts[i] > mins) {
          return { day: DAYS[probe.getUTCDay()], dayLabel: LABEL[DAYS[probe.getUTCDay()]],
                   date: ymd, time: fromMin(starts[i]), inDays: d };
        }
      }
    }
    return null;
  }

  /* When does the CURRENT open period end? null when not open or not derivable. */
  function closesAt (hours, overrides, atMs, tzMin) {
    var eff = computeEffective(hours, overrides, atMs, tzMin);
    if (!eff.open || eff.source !== 'schedule') return null;
    var local = localOf(atMs, tzMin);
    var mins = local.getUTCHours() * 60 + local.getUTCMinutes();
    var cfg = (hours || {})[DAYS[local.getUTCDay()]];
    if (!cfg || !Array.isArray(cfg.periods)) return null;
    for (var i = 0; i < cfg.periods.length; i++) {
      if (withinPeriod(mins, cfg.periods[i])) return cfg.periods[i].close || null;
    }
    return null;
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
