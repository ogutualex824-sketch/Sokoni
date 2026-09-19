/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — OFFERS & PROMOTIONS STUDIO (Merchant V2 module)
   sokoni-merchant-offers.js

   Contract: mount(host, ctx) -> { refresh, destroy }   — the same contract every other
   Merchant V2 module is mounted under, so this is a panel in the existing shell, not a
   second merchant application.

   WHAT IT ADDS, AND WHAT IT REUSES
   It is the merchant surface for the promotion layer. The COMMERCIAL RULES live in
   sokoni-promotion-model.js and the arithmetic is only ever performed there — this module
   renders, collects and previews. Two copies of discount maths is how two surfaces come to
   disagree about a price.

   It does NOT replace sokoni-offers.js. That remains the per-product price override with
   its own CRUD; offers created here are the richer kind it cannot express — bundles,
   buy-X-get-Y, happy hours, spend-and-save.

   ── WHAT IT DOES NOT DO, DELIBERATELY ───────────────────────────────────────
   IT DOES NOT PERSIST. ctx.saveOffer is called when the shell provides one; where it does
   not, the offer is held in memory and the merchant is told plainly that it is unsaved. A
   studio that appeared to save while writing nowhere would be worse than one that admits it
   cannot, because the merchant would discover the loss only after building a campaign.

   IT SHOWS NO PERFORMANCE FIGURES IT HAS NOT BEEN GIVEN. Views, conversion and revenue are
   rendered only from ctx.offerStats. With no source they read "No data yet" — never a zero,
   and never an extrapolation, because an invented conversion rate is a business decision
   made on fiction.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantOffers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c];
    });
  }
  function kes(v) { return 'KES ' + Number(v || 0).toLocaleString(); }
  function PM() { return (typeof globalThis !== 'undefined' ? globalThis : window).SokoniPromotionModel || null; }

  var DAYS = [['mon','Mon'],['tue','Tue'],['wed','Wed'],['thu','Thu'],['fri','Fri'],['sat','Sat'],['sun','Sun']];

  function mount(host, ctx) {
    if (!host) return { refresh: function () {}, destroy: function () {} };
    ctx = ctx || {};
    var state = { offers: [], view: 'list', draft: null, loading: true, error: null, unsaved: 0 };

    /* ── DATA. Absent source is UNKNOWN, never an empty success. ───────────── */
    function load() {
      state.loading = true; render();
      if (typeof ctx.listOffers !== 'function') {
        state.loading = false; state.offers = [];
        state.error = null; state.noSource = true; render(); return;
      }
      Promise.resolve(ctx.listOffers()).then(function (rows) {
        state.offers = Array.isArray(rows) ? rows : [];
        state.loading = false; state.noSource = false; render();
      }).catch(function (e) {
        state.loading = false;
        state.error = (e && e.message) || 'Offers could not be loaded';
        render();
      });
    }

    function blankDraft(templateKey) {
      var P = PM(), tpl = P && P.TEMPLATES[templateKey];
      return {
        id: 'draft-' + Date.now(), name: '', status: 'draft',
        template: templateKey || 'percentOff',
        type: tpl ? tpl.type : 'percentage',
        percent: '', amount: '', bundlePrice: '', buyQty: 2, getQty: 1,
        minSpend: '', maxDiscount: '', perCustomerLimit: '', totalRedemptionLimit: '',
        items: [], qualifyingListingIds: [],
        schedule: { days: [], from: '', to: '' },
        stacking: 'stackable', priority: 0,
        fulfilment: { delivery: true, pickup: true, dinein: false },
      };
    }

    /* ── BUNDLE ECONOMICS. Computed from the items the merchant chose, never typed in,
       so "you save" cannot drift from what the bundle actually contains. */
    function economics(d) {
      var worth = (d.items || []).reduce(function (s, it) {
        return s + (Number(it.price) || 0) * (Number(it.qty) || 1);
      }, 0);
      var price = Number(d.bundlePrice) || 0;
      return { worth: worth, price: price, saving: Math.max(0, worth - price),
               pct: worth > 0 ? Math.round(((worth - price) / worth) * 100) : 0 };
    }

    /* ── RENDER ──────────────────────────────────────────────────────────── */
    function head() {
      /* AN UNKNOWN COUNT IS NOT ZERO. With no offer store connected, or after a read that
         failed, `state.offers` is empty because nothing was READ — not because the merchant
         has no offers. Printing "0 live" there tells them their offers have vanished, which
         is a different and far more alarming claim than "we could not look".

         A real zero from a real read is still shown as 0, because that IS the answer. */
      var known = !state.noSource && !state.error && !state.loading;
      var count = function (s) {
        if (!known) return '—';
        return state.offers.filter(function (o) { return o.status === s; }).length;
      };
      return '<div class="mo-head">' +
        '<div class="mo-title">Offers &amp; Promotions</div>' +
        '<div class="mo-stats"' + (known ? '' : ' title="Not counted — no offer store is connected"') + '>' +
          '<span><b>' + count('live') + '</b> live</span>' +
          '<span><b>' + count('scheduled') + '</b> scheduled</span>' +
          '<span><b>' + count('draft') + '</b> drafts</span>' +
        '</div>' +
        '<button class="mo-btn mo-btn--primary" data-act="new">+ Create Offer</button>' +
      '</div>';
    }

    function templateGrid() {
      var P = PM(); if (!P) return '';
      return '<div class="mo-section"><div class="mo-h2">Start with a template</div><div class="mo-tpl">' +
        Object.keys(P.TEMPLATES).map(function (k) {
          var t = P.TEMPLATES[k];
          return '<button class="mo-tpl-btn" data-act="tpl" data-k="' + esc(k) + '">' +
                 '<span class="mo-tpl-ico">' + t.icon + '</span>' + esc(t.label) + '</button>';
        }).join('') + '</div></div>';
    }

    function offerRow(o) {
      var P = PM();
      var liveNow = P ? P.isLive(o) : false;
      var when = o.schedule && (o.schedule.days || []).length
        ? (o.schedule.days.join(', ') + (o.schedule.from ? ' · ' + o.schedule.from + '–' + o.schedule.to : ''))
        : (o.startsAt ? 'from ' + esc(String(o.startsAt).slice(0, 10)) : 'Always');
      var stats = (ctx.offerStats && ctx.offerStats[o.id]) || null;
      return '<div class="mo-card">' +
        '<div class="mo-card-top">' +
          '<span class="mo-card-name">' + esc(o.name || 'Untitled offer') + '</span>' +
          '<span class="mo-pill mo-pill--' + (liveNow ? 'live' : esc(o.status || 'draft')) + '">' +
            (liveNow ? 'LIVE' : esc((o.status || 'draft').toUpperCase())) + '</span>' +
        '</div>' +
        (o.bundlePrice ? '<div class="mo-card-price">' + kes(o.bundlePrice) + '</div>' : '') +
        '<div class="mo-card-meta">' + esc(when) + '</div>' +
        '<div class="mo-card-stats">' + (stats
            ? ('<span>' + Number(stats.views || 0).toLocaleString() + ' views</span>' +
               '<span>' + Number(stats.orders || 0).toLocaleString() + ' orders</span>' +
               '<span>' + kes(stats.revenue || 0) + '</span>')
            /* NO DATA IS NOT ZERO. Rendering 0 views would tell the merchant the offer
               failed, when in truth nothing has been measured. */
            : '<span class="mo-nodata">No performance data yet</span>') +
        '</div>' +
      '</div>';
    }

    function listView() {
      if (state.loading) return '<div class="mo-state">Loading offers…</div>';
      if (state.error) return '<div class="mo-state mo-state--err"><b>Offers unavailable</b>' +
        '<small>' + esc(state.error) + ' — this is not an empty list, nothing was read.</small></div>';
      if (state.noSource) return templateGrid() +
        '<div class="mo-state"><b>No offer store connected</b>' +
        '<small>Offers can be composed and previewed here, but this shell provided no ' +
        'listOffers/saveOffer, so nothing will persist yet.</small></div>';
      if (!state.offers.length) return templateGrid() +
        '<div class="mo-state"><b>No offers yet</b><small>Pick a template above to build your first one.</small></div>';
      return templateGrid() + '<div class="mo-list">' + state.offers.map(offerRow).join('') + '</div>';
    }

    function fieldsFor(d) {
      var rows = [];
      var f = function (label, key, type, ph) {
        rows.push('<label class="mo-f"><span>' + esc(label) + '</span>' +
          '<input class="mo-in" data-k="' + key + '" type="' + (type || 'text') + '" value="' +
          esc(d[key] == null ? '' : d[key]) + '" placeholder="' + esc(ph || '') + '"></label>');
      };
      f('Offer name', 'name', 'text', 'Family Pizza Night');
      if (d.type === 'percentage')   f('Percent off', 'percent', 'number', '20');
      if (d.type === 'fixed')        f('Amount off (KES)', 'amount', 'number', '500');
      if (d.type === 'spendAndSave') { f('Minimum spend (KES)', 'minSpend', 'number', '3000');
                                       f('Amount off (KES)', 'amount', 'number', '500'); }
      if (d.type === 'bundle')       f('Package price (KES)', 'bundlePrice', 'number', '2999');
      if (d.type === 'buyXgetY')     { f('Buy quantity', 'buyQty', 'number', '2');
                                       f('Free quantity', 'getQty', 'number', '1'); }
      return rows.join('');
    }

    function bundleBuilder(d) {
      if (d.type !== 'bundle') return '';
      var e = economics(d);
      return '<div class="mo-section"><div class="mo-h2">Package items</div>' +
        '<div class="mo-items">' + (d.items.length
          ? d.items.map(function (it, i) {
              return '<div class="mo-item"><span>' + esc(it.name || it.listingId) + '</span>' +
                     '<span class="mo-item-q">× ' + esc(it.qty || 1) + '</span>' +
                     '<span class="mo-item-p">' + kes((it.price || 0) * (it.qty || 1)) + '</span>' +
                     '<button class="mo-x" data-act="rmitem" data-i="' + i + '">×</button></div>';
            }).join('')
          : '<div class="mo-nodata">No items yet — add what the package contains.</div>') +
        '</div>' +
        '<button class="mo-btn" data-act="additem">+ Add item</button>' +
        '<div class="mo-econ">' +
          '<div><span>Individual value</span><b>' + kes(e.worth) + '</b></div>' +
          '<div><span>Package price</span><b>' + kes(e.price) + '</b></div>' +
          '<div class="mo-econ-save"><span>Customer saves</span><b>' + kes(e.saving) +
            (e.pct ? ' (' + e.pct + '%)' : '') + '</b></div>' +
        '</div>' +
        /* The economics are DERIVED. If the merchant prices a package above its contents
           that is shown as zero saving, not hidden — the number must not flatter. */
        (e.price > e.worth && e.worth > 0
          ? '<div class="mo-warn">This package costs more than its items bought separately.</div>' : '') +
      '</div>';
    }

    function scheduleEditor(d) {
      return '<div class="mo-section"><div class="mo-h2">When it runs</div>' +
        '<div class="mo-days">' + DAYS.map(function (p) {
          var on = d.schedule.days.indexOf(p[0]) > -1;
          return '<button class="mo-day' + (on ? ' on' : '') + '" data-act="day" data-d="' + p[0] + '">' + p[1] + '</button>';
        }).join('') + '</div>' +
        '<div class="mo-times">' +
          '<label class="mo-f"><span>From</span><input class="mo-in" data-k="schedule.from" type="time" value="' + esc(d.schedule.from) + '"></label>' +
          '<label class="mo-f"><span>To</span><input class="mo-in" data-k="schedule.to" type="time" value="' + esc(d.schedule.to) + '"></label>' +
        '</div>' +
        '<div class="mo-hint">No days selected means every day. A time window may cross midnight.</div>' +
      '</div>';
    }

    /* ── THE SCHEDULING CALENDAR ─────────────────────────────────────────────
       A month, with every day the offer actually runs marked. It is NOT a second schedule
       editor — the day chips and the time window above remain the only way to change
       anything. This is a READING of that schedule, which is the thing a merchant cannot do
       in their head: "every Friday, 17:00–22:00, until 31 December" is easy to type and
       hard to picture, and a merchant who meant the first Friday of the month finds out by
       looking rather than by a customer telling them.

       EVERY MARK IS ASKED OF THE PROMOTION MODEL. The calendar calls isLive() once per day
       at a time inside the offer's own window, so what is highlighted is exactly what the
       basket will accept. A calendar that computed its own idea of "Fridays" would be a
       second schedule implementation, and the two would disagree the first time a rule
       changed. Where there is no model, there is no calendar — not an empty grid. */
    function calendarHTML(d) {
      var P = PM();
      if (!P || typeof P.isLive !== 'function') return '';
      var base = state.calMonth ? new Date(state.calMonth) : new Date();
      var y = base.getFullYear(), m = base.getMonth();
      var first = new Date(y, m, 1), days = new Date(y, m + 1, 0).getDate();
      /* Monday-first, as the spec's calendar is and as Kenya reads a week. */
      var lead = (first.getDay() + 6) % 7;

      /* The probe time must sit INSIDE the offer's window, or a 17:00–22:00 offer asked
         about at midnight reads as never running and the whole month comes back blank. */
      var probeH = 12, probeMin = 0;
      var from = d.schedule && d.schedule.from;
      if (from && /^\d{1,2}:\d{2}$/.test(from)) {
        var fp = from.split(':');
        probeH = Number(fp[0]); probeMin = Math.min(59, Number(fp[1]) + 1);
      }

      /* THE CALENDAR ANSWERS "WHEN WOULD THIS RUN", NOT "IS IT RUNNING".
         isLive() refuses any offer whose status is not live — correctly, since a draft must
         never price a basket. But the calendar is looked at while the schedule is being
         DESIGNED, and probing the draft as-is marked no day at all: the one moment it is
         needed is the one moment it was blank.

         So the probe asks about a copy with the status set aside, and the draft state is
         said in words underneath instead. The schedule being read is the merchant's own —
         nothing else is changed, and `d` itself is never touched. */
      var probe = {};
      Object.keys(d).forEach(function (k) { probe[k] = d[k]; });
      probe.status = 'live';
      var isDraft = d.status !== 'live' && d.status !== 'active';

      var cells = '';
      for (var i = 0; i < lead; i++) cells += '<span class="mo-cal-x"></span>';
      var runs = 0;
      for (var day = 1; day <= days; day++) {
        var at = new Date(y, m, day, probeH, probeMin, 0);
        var on = false;
        try { on = P.isLive(probe, at); } catch (_) { on = false; }
        if (on) runs++;
        var today = (new Date()).toDateString() === at.toDateString();
        cells += '<span class="mo-cal-d' + (on ? ' on' : '') + (today ? ' today' : '') + '">' +
          day + (on ? '<i>●</i>' : '') + '</span>';
      }

      var MONTHS = ['January','February','March','April','May','June','July','August',
                    'September','October','November','December'];
      return '<div class="mo-section"><div class="mo-h2">When it runs this month</div>' +
        '<div class="mo-cal">' +
          '<div class="mo-cal-head">' +
            '<button class="mo-cal-nav" data-act="calprev" aria-label="Previous month">‹</button>' +
            '<b>' + MONTHS[m] + ' ' + y + '</b>' +
            '<button class="mo-cal-nav" data-act="calnext" aria-label="Next month">›</button>' +
          '</div>' +
          '<div class="mo-cal-dow">' +
            ['M','T','W','T','F','S','S'].map(function (x) { return '<span>' + x + '</span>'; }).join('') +
          '</div>' +
          '<div class="mo-cal-grid">' + cells + '</div>' +
        '</div>' +
        /* The count is the honest summary, including the awkward answer. A schedule that
           runs on no day this month is almost always a mistake, and saying "0 days" is how
           the merchant finds out before a customer does. */
        '<div class="mo-hint">' +
          (runs ? 'This schedule covers <b>' + runs + '</b> day' + (runs === 1 ? '' : 's') +
                  ' this month.'
                : 'This schedule covers <b>no day</b> this month. Check the days and dates above.') +
          /* Said plainly, so a green month is never mistaken for an offer that is selling. */
          (isDraft ? ' It is a draft — nothing runs until you publish it.' : '') +
        '</div></div>';
    }

    /* ── OFFER PERFORMANCE ───────────────────────────────────────────────────
       Every figure here is read from the stats the shell supplies. NONE is computed from a
       price, a listing or a local counter.

       THIS IS THE PANEL MOST TEMPTING TO FAKE. Views, orders and revenue are exactly the
       numbers a merchant makes decisions with, and a plausible-looking zero would tell them
       an offer had failed when nothing had been measured at all. So with no stats source
       the panel says so in words and shows no figures — and a REAL zero, supplied by the
       backend, is shown as the real result it is.

       Conversion is derived rather than read, because it is arithmetic over two supplied
       figures — and it is omitted entirely when views are absent or zero, since a rate with
       no denominator is not a small number, it is not a number. */
    function analyticsHTML(o) {
      var stats = (ctx.offerStats && ctx.offerStats[o && o.id]) || null;
      if (!stats) {
        return '<div class="mo-section"><div class="mo-h2">Performance</div>' +
          '<div class="mo-state"><b>No performance data yet</b>' +
          '<small>Views, orders and revenue appear here once this offer has run and the ' +
          'figures have been measured. Nothing is estimated.</small></div></div>';
      }
      var rows = [];
      function stat(label, v, fmt) {
        if (v === undefined || v === null) return;      /* absent ≠ zero */
        rows.push('<div class="mo-stat"><b>' + esc(fmt ? fmt(v) : Number(v).toLocaleString()) +
                  '</b><span>' + esc(label) + '</span></div>');
      }
      stat('Views', stats.views);
      stat('Offer opens', stats.opens);
      stat('Added to order', stats.added);
      stat('Purchased', stats.orders);
      stat('Revenue', stats.revenue, kes);
      stat('Discount given', stats.discount, kes);
      var views = Number(stats.views), orders = Number(stats.orders);
      if (isFinite(views) && views > 0 && isFinite(orders)) {
        stat('Conversion', (orders / views * 100).toFixed(1) + '%', function (x) { return x; });
      }
      if (!rows.length) {
        return '<div class="mo-section"><div class="mo-h2">Performance</div>' +
          '<div class="mo-state"><b>No performance data yet</b>' +
          '<small>The figures for this offer have not been measured.</small></div></div>';
      }
      return '<div class="mo-section"><div class="mo-h2">Performance</div>' +
        '<div class="mo-stats-grid">' + rows.join('') + '</div></div>';
    }

    function conditionsEditor(d) {
      var f = function (label, key, ph) {
        return '<label class="mo-f"><span>' + esc(label) + '</span><input class="mo-in" data-k="' + key +
               '" type="number" value="' + esc(d[key] == null ? '' : d[key]) + '" placeholder="' + esc(ph) + '"></label>';
      };
      return '<div class="mo-section"><div class="mo-h2">Conditions</div><div class="mo-grid">' +
        f('Minimum spend', 'minSpend', 'none') + f('Maximum discount', 'maxDiscount', 'none') +
        f('Per customer limit', 'perCustomerLimit', 'unlimited') +
        f('Total redemptions', 'totalRedemptionLimit', 'unlimited') +
        '</div>' +
        '<div class="mo-h3">Combining with other offers</div>' +
        ['stackable', 'exclusive'].map(function (s) {
          return '<button class="mo-day' + (d.stacking === s ? ' on' : '') + '" data-act="stack" data-s="' + s + '">' +
                 (s === 'stackable' ? 'Can combine' : 'Cannot combine') + '</button>';
        }).join('') +
        '<div class="mo-hint">An offer that cannot combine silences the others — SOKONI applies the best one.</div>' +
      '</div>';
    }

    /* LIVE PREVIEW, computed by the promotion model itself so what the merchant sees is
       produced by the same resolver the customer's basket will use. */
    function preview(d) {
      var P = PM(); if (!P) return '';
      var lines = d.items.length ? d.items.map(function (it) {
        return { listingId: it.listingId, price: Number(it.price) || 0, qty: Number(it.qty) || 1 };
      }) : [{ listingId: 'sample', price: 1000, qty: 2 }];
      var r = P.resolve({ lines: lines, deliveryFee: 150 },
                        [Object.assign({}, d, { status: 'live', schedule: null })], {});
      return '<div class="mo-section"><div class="mo-h2">Customer sees</div><div class="mo-prev">' +
        r.explain.map(function (e) {
          return '<div class="mo-prev-row"><span>' + esc(e.label) + '</span><b>' +
                 (e.amount < 0 ? '-' : '') + kes(Math.abs(e.amount)) + '</b></div>';
        }).join('') +
        '</div><div class="mo-hint">' + esc(r.advisory) + '.' +
        (r.rejected.length ? ' Not applied: ' + esc(r.rejected.map(function (x) { return x.why; }).join('; ')) : '') +
        '</div></div>';
    }

    function editView() {
      var d = state.draft, P = PM();
      var tpl = P && P.TEMPLATES[d.template];
      return '<div class="mo-edit">' +
        '<button class="mo-back" data-act="back">← All offers</button>' +
        '<div class="mo-h1">' + (tpl ? tpl.icon + ' ' + esc(tpl.label) : 'New offer') + '</div>' +
        '<div class="mo-section">' + fieldsFor(d) + '</div>' +
        bundleBuilder(d) + scheduleEditor(d) + calendarHTML(d) +
        conditionsEditor(d) + preview(d) + analyticsHTML(d) +
        '<div class="mo-actions">' +
          '<button class="mo-btn" data-act="savedraft">Save draft</button>' +
          '<button class="mo-btn mo-btn--primary" data-act="publish">Publish offer</button>' +
        '</div>' +
        (state.saveNote ? '<div class="mo-warn">' + esc(state.saveNote) + '</div>' : '') +
      '</div>';
    }

    function render() {
      host.innerHTML = '<div class="mo-wrap">' + head() +
        (state.view === 'edit' && state.draft ? editView() : listView()) + '</div>';
    }

    /* ── EVENTS ──────────────────────────────────────────────────────────── */
    function onClick(e) {
      var b = e.target.closest('[data-act]'); if (!b || !host.contains(b)) return;
      var a = b.dataset.act, d = state.draft;
      if (a === 'new')      { state.draft = blankDraft('percentOff'); state.view = 'edit'; state.saveNote = null; return render(); }
      if (a === 'tpl')      { state.draft = blankDraft(b.dataset.k); state.view = 'edit'; state.saveNote = null; return render(); }
      if (a === 'back')     { state.view = 'list'; state.draft = null; state.calMonth = null; return render(); }
      /* Paging the calendar changes only which month is READ. It never edits the schedule —
         the day chips above remain the single way to change when an offer runs. */
      if (a === 'calprev' || a === 'calnext') {
        var cm = state.calMonth ? new Date(state.calMonth) : new Date();
        cm.setDate(1);
        cm.setMonth(cm.getMonth() + (a === 'calnext' ? 1 : -1));
        state.calMonth = cm.getTime();
        return render();
      }
      if (!d) return;
      if (a === 'day')      { var i = d.schedule.days.indexOf(b.dataset.d);
                              if (i > -1) d.schedule.days.splice(i, 1); else d.schedule.days.push(b.dataset.d);
                              return render(); }
      if (a === 'stack')    { d.stacking = b.dataset.s; return render(); }
      if (a === 'rmitem')   { d.items.splice(Number(b.dataset.i), 1); return render(); }
      if (a === 'additem')  { return addItem(d); }
      if (a === 'savedraft')return save(d, 'draft');
      if (a === 'publish')  return save(d, 'live');
    }

    function addItem(d) {
      /* The item picker asks the SHELL for the merchant's listings — this module keeps no
         product list of its own, so there is no second catalogue to drift. */
      if (typeof ctx.pickListing === 'function') {
        Promise.resolve(ctx.pickListing()).then(function (l) {
          if (!l) return;
          d.items.push({ listingId: l.id, name: l.name, price: Number(l.price) || 0, qty: 1 });
          render();
        });
        return;
      }
      var name = window.prompt('Item name'); if (!name) return;
      var price = Number(window.prompt('Item price (KES)')) || 0;
      var qty = Number(window.prompt('Quantity', '1')) || 1;
      d.items.push({ listingId: 'manual-' + Date.now(), name: name, price: price, qty: qty });
      render();
    }

    function collect() {
      var d = state.draft; if (!d) return;
      host.querySelectorAll('.mo-in').forEach(function (el) {
        var k = el.dataset.k; if (!k) return;
        if (k.indexOf('schedule.') === 0) d.schedule[k.split('.')[1]] = el.value;
        else d[k] = el.value;
      });
    }

    function save(d, status) {
      collect();
      d.status = status;
      if (typeof ctx.saveOffer !== 'function') {
        /* HELD, AND SAID SO. Silence here would let a merchant build a campaign that
           evaporates on reload. */
        state.unsaved++;
        state.saveNote = 'Not saved — this shell has no offer store connected yet. ' +
                         'The offer is held in this session only and will be lost on reload.';
        return render();
      }
      state.saveNote = 'Saving…'; render();
      Promise.resolve(ctx.saveOffer(d)).then(function () {
        state.view = 'list'; state.draft = null; state.saveNote = null;
        if (ctx.onToast) ctx.onToast(status === 'live' ? 'Offer published' : 'Draft saved');
        load();
      }).catch(function (e) {
        state.saveNote = 'Not saved — ' + ((e && e.message) || 'the write was refused') + '.';
        render();
      });
    }

    host.addEventListener('click', onClick);
    load();

    return {
      refresh: load,
      destroy: function () { host.removeEventListener('click', onClick); host.innerHTML = ''; },
    };
  }

  return { mount: mount };
});
