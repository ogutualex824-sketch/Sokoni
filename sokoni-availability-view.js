/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — AVAILABILITY VIEW. One availability framework, read across every listing type.
   sokoni-availability-view.js

   THE PROBLEM
   "In stock" is the wrong sentence for most of what SOKONI lists. A dish is available until
   the kitchen closes; a hotel room is available on dates; a service has appointments; a
   rental becomes available on a day. Left to each surface, that becomes six availability
   implementations that disagree — and the one that matters, whether a customer can actually
   have this thing now, gets answered differently in two places.

   WHAT THIS IS
   A reader and a renderer over data that already exists. It computes NOTHING about opening
   hours itself: sokoni-availability-model.js owns that maths and is consulted when a
   listing carries a schedule. This adds the per-listing reading — state, schedule, and how
   many — in the vocabulary of the listing's own type.

   THE RULE IT EXISTS TO HOLD
   ABSENT IS UNMETERED, NEVER EXHAUSTED. This is the platform's standing stock invariant:
   a listing with no stock field is not a listing with none left. So an absent count says
   nothing about quantity, and "Out of stock" is said ONLY when a real zero was recorded.
   Rendering scarcity from a missing number turns a sale away from something that is on the
   shelf, which is worse than saying nothing at all.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  function esc (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function LT () { return root.SokoniListingTypes || null; }
  function AM () { return root.SokoniAvailabilityModel || null; }

  function typeOf (listing) {
    var T = LT();
    if (T && typeof T.typeOf === 'function') return T.typeOf(listing || {});
    return { id: 'product', availabilityNoun: 'in stock' };
  }

  /* An attribute, wherever it currently lives — the form's flat `lf.` namespace while the
     merchant types, `attributes` once saved, or top level on a legacy record. */
  function attr (listing, key) {
    var l = listing || {};
    if (l['lf.' + key] !== undefined && l['lf.' + key] !== '') return l['lf.' + key];
    if (l.attributes && l.attributes[key] !== undefined && l.attributes[key] !== '') return l.attributes[key];
    return l[key];
  }

  function countOf (listing) {
    var raw = (listing || {}).stock;
    if (raw === undefined || raw === null || raw === '') raw = attr(listing, 'stock');
    if (raw === undefined || raw === null || raw === '') return null;   /* UNMETERED */
    var n = Number(raw);
    return isFinite(n) ? Math.max(0, Math.floor(n)) : null;
  }

  /**
   * READ THE AVAILABILITY. Returns:
   *   { state, label, count, countLabel, schedule, from, noun }
   *   state — 'open' | 'closed' | 'out' | 'unmetered'
   *
   * `count === null` means UNMETERED and is the common case, not an error.
   */
  function read (listing, at) {
    var l = listing || {}, t = typeOf(l);
    var count = countOf(l);
    var out = { typeId: t.id, count: count, noun: t.availabilityNoun || 'available',
                schedule: null, from: null, state: 'unmetered', label: '', countLabel: null };

    /* A recorded zero is a real answer, and the only thing that may say "out". */
    if (count === 0) {
      out.state = 'out';
      out.label = t.id === 'room' ? 'Fully booked'
                : (t.id === 'event' ? 'Sold out' : 'Out of stock');
      return out;
    }

    /* OPENING HOURS come from the availability model, never from arithmetic here. Where a
       listing carries no schedule, there is nothing to be closed by. */
    var A = AM(), hours = l.hours || l.availability || null;
    if (A && hours && typeof A.computeEffective === 'function') {
      var eff = null;
      try {
        eff = A.computeEffective(hours, l.availabilityOverrides || null,
                                 at instanceof Date ? at.getTime() : Date.now(), undefined);
      } catch (_) { eff = null; }
      if (eff && typeof eff.open === 'boolean') {
        out.state = eff.open ? 'open' : 'closed';
        out.label = eff.open ? 'Available now' : 'Closed right now';
      }
      /* PER-DAY ROWS, built from the model's OWN day keys and labels.
         formatWeek() returns a single display STRING ("Mon 08:00–18:00 · Tue …"), which is
         right for a one-line summary and wrong for the table the page wants — and calling
         .map() on it throws. Splitting that string back apart would be parsing a display
         format, so the rows are assembled from the same `hours` the model reads. No maths
         is duplicated: there is none here, only formatting. */
      var DAYS = A.DAYS, LABEL = A.LABEL;
      if (Array.isArray(DAYS) && LABEL) {
        var order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
        var rows = order.map(function (k) {
          var cfg = hours[k];
          var closed = !cfg || cfg.closed || !Array.isArray(cfg.periods) || !cfg.periods.length;
          return {
            day: String(LABEL[k] || k).slice(0, 3),
            text: closed ? 'Closed' : cfg.periods.map(function (p) {
              return (p.open || '?') + '–' + (p.close || '?');
            }).join(', '),
            closed: closed,
          };
        });
        /* A week that is closed every day is not a schedule worth printing — it is almost
           certainly an empty object, and seven "Closed" rows would read as a decision. */
        out.schedule = rows.some(function (r) { return !r.closed; }) ? rows : null;
      }
    }

    /* A rental becomes available on a date rather than being open or closed. */
    var from = attr(l, 'availableFrom');
    if (from) { out.from = String(from); if (!out.label) out.label = 'Available from ' + out.from; }

    if (!out.label) {
      out.state = 'open';
      out.label = t.id === 'service' ? 'Appointments available'
                : (t.id === 'property' ? 'Viewings available' : 'Available');
    }

    /* HOW MANY, in the type's own words — and only when a number was actually recorded. */
    if (count !== null) {
      out.countLabel =
        t.id === 'room'    ? count + (count === 1 ? ' room available' : ' rooms available')
      : t.id === 'event'   ? count + (count === 1 ? ' ticket left' : ' tickets left')
      : t.id === 'food' || t.id === 'drink'
                           ? count + (count === 1 ? ' portion left' : ' portions left')
      :                      count + (count === 1 ? ' in stock' : ' in stock');
    }
    return out;
  }

  /* ── THE PANEL ──────────────────────────────────────────────────────────────────────────
     Rendered into the listing page, in the page's own section shape. Each block is omitted
     when its data is absent, so a listing that says only "Available" gets one line rather
     than three empty headings. */
  function panelHtml (listing, at) {
    var a = read(listing, at);
    var rows = '';

    if (Array.isArray(a.schedule) && a.schedule.length) {
      rows += '<div class="prd-avl-block"><h4>Opening hours</h4><table class="prd-avl-table">' +
        a.schedule.map(function (d) {
          return '<tr' + (d.closed ? ' class="is-closed"' : '') + '>' +
                 '<td>' + esc(d.day) + '</td><td>' + esc(d.text) + '</td></tr>';
        }).join('') + '</table></div>';
    }
    if (a.from) {
      rows += '<div class="prd-avl-block"><h4>Available from</h4><p>' + esc(a.from) + '</p></div>';
    }
    /* NOTHING IS SAID ABOUT QUANTITY when none was recorded. No "0", no "limited", no
       "check with the seller" — an absent count is simply not a fact about this listing. */
    if (a.countLabel) {
      rows += '<div class="prd-avl-block"><h4>How many</h4><p>' + esc(a.countLabel) + '</p></div>';
    }

    return '<div class="prd-avl-section" id="prdAvailability">' +
      '<div class="prd-avl-head">' +
        '<span class="prd-avl-dot prd-avl-dot--' + esc(a.state) + '"></span>' +
        '<span class="prd-avl-label">' + esc(a.label) + '</span>' +
      '</div>' + rows + '</div>';
  }

  /* One line, for the merchant's Studio. Same reading, so the two can never disagree. */
  function lineHtml (listing, at) {
    var a = read(listing, at);
    return '<span class="ls-avl ls-avl--' + esc(a.state) + '">' + esc(a.label) +
           (a.countLabel ? ' · ' + esc(a.countLabel) : '') + '</span>';
  }

  var api = { read: read, panelHtml: panelHtml, lineHtml: lineHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SokoniAvailabilityView = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
