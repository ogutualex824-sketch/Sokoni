/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — OFFERS & PROMOTIONS STUDIO (Merchant V2 module, mounted inside MARKETING)
   sokoni-merchant-offers.js

   Contract: mount(host, ctx) -> { refresh, destroy, openTemplate }

   WHAT IT ADDS, AND WHAT IT REUSES
   It is the merchant surface for the promotion layer. The COMMERCIAL RULES live in
   sokoni-promotion-model.js (browser) and functions/shop-offers.js (server, the authority);
   the arithmetic is only ever performed there — this module renders, collects and previews.
   Two copies of discount maths is how two surfaces come to disagree about a price.

   U7c1 (2026-09-29) — WIRED TO THE ONE OFFER STORE, `shopOffers`
     · ctx.listOffers / ctx.saveOffer are the shopOfferList / shopOfferUpsert callables. The
       server derives ownership, enforces the `discount` capability and is idempotent on the
       draftToken this module mints once per new offer.
     · ONE WIZARD PER OFFER TYPE (WIZARDS below). A flash sale shows products, a sale price, a
       start and an end and a sales limit — never buy-X-get-Y quantities; a meal deal shows the
       meal's items from the shop's own catalogue — never a generic percentage.
     · Products come from ctx.listListings(), the shop's OWN canonical catalogue, with live price
       and stock. There is no second product list and no typed-in item.
     · Drafts persist and resume; offers can be published, scheduled, ended by date and archived.
     · Back works: the editor pushes a history entry, so the phone's Back returns to the list
       instead of leaving Marketing; a changed, unsaved offer asks to be kept as a draft.
     · Every value is collected BEFORE any re-render, so tapping a day chip never wipes a price.

   ── WHAT IT DOES NOT DO, DELIBERATELY ───────────────────────────────────────
   IT NEVER PERSISTS WITHOUT A STORE. With no ctx.saveOffer the merchant is told plainly that
   nothing is saved.
   IT SHOWS NO PERFORMANCE FIGURES IT HAS NOT BEEN GIVEN. Views, conversion and revenue are
   rendered only from ctx.offerStats. With no source they read "No data yet" — never a zero.
   IT NEVER INVENTS A PREVIEW. With no products chosen it asks for them instead of pricing a
   made-up sample basket.
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
  function PSK() { return (typeof globalThis !== 'undefined' ? globalThis : window).SokoniPackageStock || null; }
  function num(v) { if (v === '' || v == null) return null; var n = Number(v); return isFinite(n) ? n : null; }

  var DAYS = [['mon','Mon'],['tue','Tue'],['wed','Wed'],['thu','Thu'],['fri','Fri'],['sat','Sat'],['sun','Sun']];

  /* ══ THE WIZARDS ════════════════════════════════════════════════════════════
     One entry per template. `sections` is the ONLY list of controls that template renders,
     and the ONLY fields its payload carries — so switching from a flash sale to a meal deal can
     never leave a stale percentage riding along. `need` is what Publish requires. */
  var WIZARDS = {
    flashSale:   { blurb: 'A limited-time price on the products you pick. It stops by itself at the end time.',
                   namePh: 'Weekend Flash Sale', sections: ['products', 'flashprice', 'window', 'limit', 'terms'],
                   need: { products: 1, percent: 1, endsAt: 1 } },
    happyHour:   { blurb: 'A discount during set hours on the days you choose.',
                   namePh: 'Happy Hour 5–7pm', sections: ['percent', 'productsOpt', 'schedule', 'conditions', 'terms'],
                   need: { percent: 1, window: 1 } },
    percentOff:  { blurb: 'A percentage off everything, or off the products you choose.',
                   namePh: '10% off this week', sections: ['percent', 'productsOpt', 'dates', 'conditions', 'stacking', 'terms'],
                   need: { percent: 1 } },
    coupon:      { blurb: 'A fixed amount off an order.',
                   namePh: 'KES 200 off your order', sections: ['amount', 'dates', 'conditions', 'stacking', 'terms'],
                   need: { amount: 1 } },
    bxgy:        { blurb: 'Buy a number of the chosen products and get more free — the cheapest ones are free.',
                   namePh: 'Buy 2 get 1 free', sections: ['products', 'bxgy', 'dates', 'conditions', 'terms'],
                   need: { products: 1, bxgy: 1 } },
    mealDeal:    { blurb: 'Menu items sold together for one price.', itemsLabel: 'What’s in the meal',
                   namePh: 'Pizza Meal Deal', sections: ['items', 'bundleprice', 'schedule', 'dates', 'limit', 'fulfilment', 'terms'],
                   need: { items: 1, bundlePrice: 1 } },
    package:     { blurb: 'Products or services sold together for one price.', itemsLabel: 'What’s in the package',
                   namePh: 'Back-to-School Branding Package', sections: ['items', 'bundleprice', 'dates', 'limit', 'fulfilment', 'terms'],
                   need: { items: 1, bundlePrice: 1 } },
    stayPackage: { blurb: 'A room with its extras — breakfast, transfers — for one price.', itemsLabel: 'What’s included',
                   namePh: 'Weekend Getaway', sections: ['items', 'bundleprice', 'dates', 'limit', 'terms'],
                   need: { items: 1, bundlePrice: 1 } },
    servicePack: { blurb: 'A set of services for one price.', itemsLabel: 'Services included',
                   namePh: 'Full Service Package', sections: ['items', 'bundleprice', 'dates', 'limit', 'terms'],
                   need: { items: 1, bundlePrice: 1 } },
    freeDelivery:{ blurb: 'Free delivery on orders above an amount.',
                   namePh: 'Free delivery over KES 2,000', sections: ['minspend', 'dates', 'terms'],
                   need: {} },
    spendSave:   { blurb: 'Spend at least an amount and save a fixed amount.',
                   namePh: 'Spend 3,000 save 300', sections: ['spendsave', 'dates', 'conditions', 'stacking', 'terms'],
                   need: { minSpend: 1, amount: 1 } },
    freeGift:    { blurb: 'A chosen item is free when the order qualifies. The item must be in the order.',
                   namePh: 'Free soda with every pizza', sections: ['freeitem', 'minspend', 'dates', 'limit', 'terms'],
                   need: { freeItemId: 1 } },
  };
  var ORDER = ['flashSale', 'mealDeal', 'package', 'percentOff', 'bxgy', 'happyHour', 'coupon',
               'spendSave', 'freeDelivery', 'freeGift', 'stayPackage', 'servicePack'];

  /* The payload keys each section owns. A key not owned by one of the template's sections is
     never sent — the server stores exactly what this wizard showed. */
  var SECTION_KEYS = {
    percent: ['percent'], flashprice: ['percent'], amount: ['amount'], bundleprice: ['bundlePrice'],
    bxgy: ['buyQty', 'getQty', 'maxFreeItems'], spendsave: ['minSpend', 'amount'], minspend: ['minSpend'],
    limit: ['inventoryLimit', 'perCustomerLimit'],
    conditions: ['minSpend', 'maxDiscount', 'perCustomerLimit', 'totalRedemptionLimit'],
  };

  /* ══ STATUS — derived, the same way the resolver will judge it ══════════════ */
  function statusOf(o, at) {
    var P = PM(), now = at || new Date();
    if (!o) return 'draft';
    if (o.status === 'archived') return 'archived';
    if (o.status !== 'live' && o.status !== 'active') return 'draft';
    if (o.endsAt && now > new Date(o.endsAt)) return 'ended';
    if (o.startsAt && now < new Date(o.startsAt)) return 'scheduled';
    if (P && P.isLive(o, now)) return 'live';
    return 'paused';                     /* live, but outside its hours/days right now */
  }
  var STATUS_LABEL = { live: 'LIVE', scheduled: 'SCHEDULED', draft: 'DRAFT', ended: 'ENDED',
                       archived: 'ARCHIVED', paused: 'OUTSIDE HOURS' };

  /* datetime-local ⇄ ISO. The input speaks the device's local time; the store speaks ISO. */
  function toLocalInput(iso) {
    if (!iso) return '';
    var d = new Date(iso); if (isNaN(d)) return '';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function fromLocalInput(v) {
    if (!v) return null;
    var d = new Date(v); return isNaN(d) ? null : d.toISOString();
  }

  function mount(host, ctx) {
    if (!host) return { refresh: function () {}, destroy: function () {}, openTemplate: function () {} };
    ctx = ctx || {};
    var W = (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') ? window : null;
    var state = { offers: [], view: 'list', draft: null, loading: true, error: null, unsaved: 0,
                  filter: 'all', listings: null, listingsError: null, picker: null, dirty: false, pushed: false };

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

    /* The shop's own catalogue, read once per mount and on demand. */
    function loadListings() {
      if (typeof ctx.listListings !== 'function') { state.listings = []; state.listingsError = 'no-source'; return Promise.resolve(); }
      return Promise.resolve(ctx.listListings()).then(function (rows) {
        state.listings = (Array.isArray(rows) ? rows : []).filter(function (p) { return p && p.id && p.status !== 'archived'; });
        state.listingsError = null;
      }).catch(function (e) { state.listings = []; state.listingsError = (e && e.message) || 'Your products could not be loaded'; });
    }
    function listingById(id) { return (state.listings || []).filter(function (p) { return p.id === id; })[0] || null; }

    function blankDraft(templateKey) {
      var P = PM(), key = WIZARDS[templateKey] ? templateKey : 'percentOff';
      var tpl = P && P.TEMPLATES[key];
      return {
        id: null, draftToken: 'dt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10),
        name: '', status: 'draft', template: key, type: tpl ? tpl.type : 'percentage',
        percent: '', salePrice: '', amount: '', bundlePrice: '', buyQty: 2, getQty: 1, maxFreeItems: '',
        minSpend: '', maxDiscount: '', perCustomerLimit: '', totalRedemptionLimit: '', inventoryLimit: '',
        items: [], products: [], freeItemId: '', startsAt: '', endsAt: '', terms: '',
        schedule: { days: [], from: '', to: '' }, stacking: 'stackable', fulfilment: '',
      };
    }

    /* A stored offer, opened for editing (resume a draft, or change a live offer). */
    function draftFromOffer(o) {
      var d = blankDraft(o.template && WIZARDS[o.template] ? o.template : templateForType(o.type));
      d.id = o.id; d.draftToken = null;
      ['name', 'status', 'type', 'percent', 'amount', 'bundlePrice', 'buyQty', 'getQty', 'maxFreeItems', 'minSpend',
       'maxDiscount', 'perCustomerLimit', 'totalRedemptionLimit', 'inventoryLimit', 'freeItemId', 'stacking']
        .forEach(function (k) { if (o[k] != null) d[k] = o[k]; });
      d.terms = o.summary || '';
      d.fulfilment = typeof o.fulfilment === 'string' ? o.fulfilment : '';
      d.startsAt = toLocalInput(o.startsAt); d.endsAt = toLocalInput(o.endsAt);
      d.items = (o.items || []).map(function (it) { return { listingId: it.listingId, name: it.name, qty: it.qty || 1, price: it.price }; });
      d.products = (o.qualifyingListingIds || []).slice();
      d.schedule = { days: ((o.schedule && o.schedule.days) || []).slice(), from: (o.schedule && o.schedule.from) || '', to: (o.schedule && o.schedule.to) || '' };
      return d;
    }
    function templateForType(t) {
      var P = PM(); if (!P) return 'percentOff';
      var k = ORDER.filter(function (x) { return P.TEMPLATES[x] && P.TEMPLATES[x].type === t; })[0];
      return k || 'percentOff';
    }
    function wiz(d) { return WIZARDS[d.template] || WIZARDS.percentOff; }
    function has(d, section) { return wiz(d).sections.indexOf(section) > -1 || (section === 'products' && wiz(d).sections.indexOf('productsOpt') > -1); }

    /* ── BUNDLE ECONOMICS. Computed from the items the merchant chose, never typed in,
       so "you save" cannot drift from what the bundle actually contains. Prices are the
       CATALOGUE's, read live — an item's stored price is only a fallback label. */
    function itemPrice(it) { var l = listingById(it.listingId); return l && typeof l.price === 'number' ? l.price : (Number(it.price) || 0); }
    function economics(d) {
      var worth = (d.items || []).reduce(function (s, it) {
        return s + itemPrice(it) * (Number(it.qty) || 1);
      }, 0);
      var price = Number(d.bundlePrice) || 0;
      return { worth: worth, price: price, saving: Math.max(0, worth - price),
               pct: worth > 0 ? Math.round(((worth - price) / worth) * 100) : 0 };
    }

    /* ══ PAYLOAD — exactly what this wizard showed ═══════════════════════════ */
    function toPayload(d, status) {
      var w = wiz(d), out = { type: d.type, template: d.template, status: status || d.status || 'draft' };
      if (String(d.name || '').trim()) out.name = String(d.name).trim();
      if (String(d.terms || '').trim() && w.sections.indexOf('terms') > -1) out.summary = String(d.terms).trim();
      var keys = {};
      w.sections.forEach(function (s) { (SECTION_KEYS[s] || []).forEach(function (k) { keys[k] = 1; }); });
      Object.keys(keys).forEach(function (k) { var v = num(d[k]); if (v !== null) out[k] = v; });
      if (has(d, 'products') && d.products.length) out.qualifyingListingIds = d.products.slice(0, 200);
      if (w.sections.indexOf('items') > -1 && d.items.length) {
        out.items = d.items.map(function (it) {
          return { listingId: it.listingId, name: it.name, qty: Number(it.qty) || 1, price: itemPrice(it) };
        });
      }
      if (w.sections.indexOf('freeitem') > -1 && d.freeItemId) out.freeItemId = d.freeItemId;
      if (w.sections.indexOf('dates') > -1 || w.sections.indexOf('window') > -1) {
        var s = fromLocalInput(d.startsAt), e = fromLocalInput(d.endsAt);
        if (s) out.startsAt = s; if (e) out.endsAt = e;
      }
      if (w.sections.indexOf('schedule') > -1) {
        var sc = {};
        if (d.schedule.days.length) sc.days = d.schedule.days.slice();
        if (d.schedule.from) sc.from = d.schedule.from;
        if (d.schedule.to) sc.to = d.schedule.to;
        if (Object.keys(sc).length) out.schedule = sc;
      }
      if (w.sections.indexOf('stacking') > -1 && d.stacking) out.stacking = d.stacking;
      /* ONE channel or none. The server compares a single string against the basket's
         fulfilment; the old { delivery, pickup, dinein } object was stored as "[object Object]"
         and silently disqualified every basket. Blank = every channel. */
      if (w.sections.indexOf('fulfilment') > -1 && (d.fulfilment === 'delivery' || d.fulfilment === 'pickup')) out.fulfilment = d.fulfilment;
      return out;
    }

    /* What Publish needs. A draft may be saved incomplete — it can never price a basket. */
    function problems(d) {
      var w = wiz(d), n = w.need || {}, out = [];
      if (n.products && !d.products.length) out.push('Choose at least one product.');
      if (n.items && !d.items.length) out.push('Add what the offer contains.');
      if (n.percent) { var pc = num(d.percent); if (pc === null || pc <= 0 || pc > 100) out.push('Set a discount between 1 and 100%.'); }
      if (n.amount && !(num(d.amount) > 0)) out.push('Set the amount off.');
      if (n.bundlePrice && !(num(d.bundlePrice) > 0)) out.push('Set the price for the whole offer.');
      if (n.minSpend && !(num(d.minSpend) > 0)) out.push('Set the minimum spend.');
      if (n.bxgy && !(num(d.buyQty) >= 1 && num(d.getQty) >= 1)) out.push('Set how many to buy and how many are free.');
      if (n.freeItemId && !d.freeItemId) out.push('Choose the free item.');
      if (n.window && !(d.schedule.from && d.schedule.to)) out.push('Set the hours it runs.');
      if (n.endsAt) {
        if (!d.endsAt) out.push('Set when the sale ends.');
        else if (new Date(d.endsAt) <= new Date()) out.push('The end time has already passed.');
      }
      if (d.startsAt && d.endsAt && new Date(d.endsAt) <= new Date(d.startsAt)) out.push('The end must be after the start.');
      return out;
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
        return state.offers.filter(function (o) { return statusOf(o) === s; }).length;
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

    /* The template rail — horizontally SWIPEABLE on a phone (scroll-snap), a wrapped grid on a desk. */
    function templateRail(selected) {
      var P = PM(); if (!P) return '';
      return '<div class="mo-rail" role="tablist" aria-label="Offer types">' +
        ORDER.filter(function (k) { return P.TEMPLATES[k]; }).map(function (k) {
          var t = P.TEMPLATES[k], on = k === selected;
          return '<button class="mo-rail-card' + (on ? ' on' : '') + '" role="tab" aria-selected="' + on + '" data-act="' +
                 (selected ? 'switch' : 'tpl') + '" data-k="' + esc(k) + '">' +
                 '<span class="mo-tpl-ico">' + t.icon + '</span><b>' + esc(t.label) + '</b>' +
                 (selected ? '' : '<small>' + esc(WIZARDS[k].blurb) + '</small>') + '</button>';
        }).join('') + '</div>';
    }
    function templateGrid() {
      return '<div class="mo-section"><div class="mo-h2">Start a new offer — swipe to choose</div>' + templateRail(null) + '</div>';
    }

    function describe(o) {
      var bits = [];
      if (o.type === 'percentage' && o.percent != null) bits.push(o.percent + '% off');
      if (o.type === 'fixed' && o.amount != null) bits.push(kes(o.amount) + ' off');
      if (o.type === 'spendAndSave') bits.push('spend ' + kes(o.minSpend || 0) + ', save ' + kes(o.amount || 0));
      if (o.type === 'buyXgetY') bits.push('buy ' + (o.buyQty || 1) + ' get ' + (o.getQty || 1) + ' free');
      if (o.type === 'bundle' && o.bundlePrice != null) bits.push((o.items || []).length + ' items for ' + kes(o.bundlePrice));
      if (o.type === 'freeDelivery') bits.push('free delivery' + (o.minSpend ? ' over ' + kes(o.minSpend) : ''));
      if (o.type === 'freeItem') { var l = listingById(o.freeItemId); bits.push('free ' + (l ? l.name : 'item')); }
      var q = (o.qualifyingListingIds || []).length;
      if (q) bits.push(q + ' product' + (q === 1 ? '' : 's'));
      return bits.join(' · ');
    }

    function offerRow(o) {
      var st = statusOf(o);
      var when = o.schedule && (o.schedule.days || []).length
        ? (o.schedule.days.join(', ') + (o.schedule.from ? ' · ' + o.schedule.from + '–' + o.schedule.to : ''))
        : o.endsAt ? ((o.startsAt ? String(toLocalInput(o.startsAt)).replace('T', ' ') + ' → ' : 'until ') + String(toLocalInput(o.endsAt)).replace('T', ' '))
        : (o.startsAt ? 'from ' + esc(String(o.startsAt).slice(0, 10)) : 'Always');
      var stats = (ctx.offerStats && ctx.offerStats[o.id]) || null;
      var P = PM(), tpl = P && P.TEMPLATES[o.template];
      return '<div class="mo-card" data-offer="' + esc(o.id) + '">' +
        '<div class="mo-card-top">' +
          '<span class="mo-card-name">' + (tpl ? tpl.icon + ' ' : '') + esc(o.name || 'Untitled offer') + '</span>' +
          '<span class="mo-pill mo-pill--' + esc(st) + '">' + STATUS_LABEL[st] + '</span>' +
        '</div>' +
        '<div class="mo-card-meta">' + esc(describe(o)) + '</div>' +
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
        '<div class="mo-card-acts">' +
          '<button class="mo-btn" data-act="edit" data-id="' + esc(o.id) + '">' + (st === 'draft' ? 'Continue draft' : 'Edit') + '</button>' +
          (st === 'draft' ? '<button class="mo-btn mo-btn--primary" data-act="quickpublish" data-id="' + esc(o.id) + '">Publish</button>' : '') +
          (st !== 'archived' ? '<button class="mo-btn mo-btn--ghost" data-act="archive" data-id="' + esc(o.id) + '">' + (st === 'live' || st === 'paused' || st === 'scheduled' ? 'End offer' : 'Archive') + '</button>' : '') +
        '</div>' +
      '</div>';
    }

    var FILTERS = [['all', 'All'], ['live', 'Live'], ['scheduled', 'Scheduled'], ['draft', 'Drafts'], ['ended', 'Ended & archived']];
    function filterBar() {
      return '<div class="mo-filters">' + FILTERS.map(function (f) {
        return '<button class="mo-day' + (state.filter === f[0] ? ' on' : '') + '" data-act="filter" data-f="' + f[0] + '">' + f[1] + '</button>';
      }).join('') + '</div>';
    }
    function filtered() {
      return state.offers.filter(function (o) {
        var st = statusOf(o);
        if (state.filter === 'all') return st !== 'archived';
        if (state.filter === 'live') return st === 'live' || st === 'paused';
        if (state.filter === 'ended') return st === 'ended' || st === 'archived';
        return st === state.filter;
      });
    }

    function listView() {
      if (state.loading) return '<div class="mo-state">Loading offers…</div>';
      if (state.error) return '<div class="mo-state mo-state--err"><b>Offers unavailable</b>' +
        '<small>' + esc(state.error) + ' — this is not an empty list, nothing was read.</small></div>';
      /* NAMING THE BLOCKER, not just the absence. "No store connected" invites the obvious
         and wrong fix — pointing this at the existing `offers` collection, which is a
         platform-ADMIN price-drop tool that merchants cannot write to. Relaxing its rules to
         make Publish work would hand every merchant write access to something the storefront
         already reads, and reopen a closed admin boundary. Saying which decision is
         outstanding is what stops that being "fixed" by someone in a hurry.
         Full record: docs/OFFER_PERSISTENCE_DECISION.md */
      if (state.noSource) return templateGrid() +
        '<div class="mo-state"><b>No offer store connected</b>' +
        '<small>Offers can be composed, scheduled and previewed here, and the pricing is ' +
        'resolved by the real promotion engine — but nothing persists yet. SOKONI has no ' +
        'merchant-writable offer store: the existing <b>offers</b> and <b>promotions</b> ' +
        'collections are both platform-admin only. Where merchant offers live, and who may ' +
        'write them, is an owner decision — see docs/OFFER_PERSISTENCE_DECISION.md.</small></div>';
      if (!state.offers.length) return templateGrid() +
        '<div class="mo-state"><b>No offers yet</b><small>Pick a type above to build your first one.</small></div>';
      var rows = filtered();
      return templateGrid() + filterBar() + (rows.length
        ? '<div class="mo-list">' + rows.map(offerRow).join('') + '</div>'
        : '<div class="mo-state"><b>Nothing here</b><small>No offers match this filter.</small></div>');
    }

    /* ── EDITOR SECTIONS ─────────────────────────────────────────────────── */
    function input(label, key, type, ph, val, extra) {
      return '<label class="mo-f"><span>' + esc(label) + '</span>' +
        '<input class="mo-in" data-k="' + key + '" type="' + (type || 'text') + '" value="' + esc(val == null ? '' : val) +
        '" placeholder="' + esc(ph || '') + '"' + (extra || '') + '></label>';
    }
    function sec(title, body, hint) {
      return '<div class="mo-section"><div class="mo-h2">' + esc(title) + '</div>' + body +
        (hint ? '<div class="mo-hint">' + hint + '</div>' : '') + '</div>';
    }
    function stockText(p) {
      if (!p) return '';
      var PS = PSK();
      if (PS && PS.isComposite(p)) {
        var byId = {}; (state.listings || []).forEach(function (x) { byId[x.id] = x; });
        var u = PS.availableUnits(p, byId);
        return u === null ? 'Stock not tracked' : (u + ' set' + (u === 1 ? '' : 's') + ' available');
      }
      if (typeof p.stock !== 'number') return 'Stock not tracked';
      return p.stock <= 0 ? 'Out of stock' : p.stock + ' in stock';
    }
    function chosenList(ids, removeAct) {
      if (!ids.length) return '<div class="mo-nodata">None chosen yet.</div>';
      return '<div class="mo-items">' + ids.map(function (id) {
        var l = listingById(id);
        return '<div class="mo-item"><span>' + esc(l ? l.name : 'A product that is no longer in your catalogue') + '</span>' +
               '<span class="mo-item-q">' + esc(l ? stockText(l) : '') + '</span>' +
               '<span class="mo-item-p">' + (l && typeof l.price === 'number' ? kes(l.price) : '—') + '</span>' +
               '<button class="mo-x" data-act="' + removeAct + '" data-id="' + esc(id) + '" aria-label="Remove">×</button></div>';
      }).join('') + '</div>';
    }

    function sectionHTML(d, s) {
      var w = wiz(d);
      switch (s) {
        case 'products': case 'productsOpt':
          return sec(s === 'products' ? 'Products in this offer' : 'Only on these products (optional)',
            chosenList(d.products, 'rmprod') + '<button class="mo-btn" data-act="pick" data-mode="products">+ Choose from your catalogue</button>',
            s === 'productsOpt' ? 'Leave empty to apply to the whole order.' : '');
        case 'items': {
          var e = economics(d);
          return sec(w.itemsLabel || 'Items',
            '<div class="mo-items">' + (d.items.length ? d.items.map(function (it, i) {
                var l = listingById(it.listingId);
                return '<div class="mo-item"><span>' + esc(l ? l.name : (it.name || 'A product no longer in your catalogue')) +
                       '<small class="mo-sub">' + esc(stockText(l)) + '</small></span>' +
                       '<span class="mo-qty"><button class="mo-q" data-act="itemdec" data-i="' + i + '" aria-label="Fewer">−</button>' +
                       '<b>' + esc(it.qty || 1) + '</b><button class="mo-q" data-act="iteminc" data-i="' + i + '" aria-label="More">+</button></span>' +
                       '<span class="mo-item-p">' + kes(itemPrice(it) * (Number(it.qty) || 1)) + '</span>' +
                       '<button class="mo-x" data-act="rmitem" data-i="' + i + '" aria-label="Remove">×</button></div>';
              }).join('') : '<div class="mo-nodata">Nothing added yet — choose from your catalogue.</div>') + '</div>' +
            '<button class="mo-btn" data-act="pick" data-mode="items">+ Add from your catalogue</button>' +
            '<div class="mo-econ">' +
              '<div><span>Bought separately</span><b>' + kes(e.worth) + '</b></div>' +
              '<div><span>Offer price</span><b>' + kes(e.price) + '</b></div>' +
              '<div class="mo-econ-save"><span>Customer saves</span><b>' + kes(e.saving) + (e.pct ? ' (' + e.pct + '%)' : '') + '</b></div>' +
            '</div>' +
            /* The economics are DERIVED. If the merchant prices a package above its contents
               that is shown as zero saving, not hidden — the number must not flatter. */
            (e.price > e.worth && e.worth > 0 ? '<div class="mo-warn">This offer costs more than its items bought separately.</div>' : ''));
        }
        case 'bundleprice': return sec('Offer price', input('Price for everything (KES)', 'bundlePrice', 'number', '2999', d.bundlePrice, ' min="0" inputmode="decimal"'));
        case 'percent': return sec('Discount', input('Percent off', 'percent', 'number', '20', d.percent, ' min="1" max="100" inputmode="decimal"'));
        case 'flashprice': {
          var one = d.products.length === 1 ? listingById(d.products[0]) : null;
          return sec('Sale price',
            input('Percent off', 'percent', 'number', '10', d.percent, ' min="1" max="100" inputmode="decimal"') +
            (one && typeof one.price === 'number'
              ? input('…or the sale price for ' + one.name + ' (normal ' + kes(one.price) + ')', 'salePrice', 'number', 'e.g. 68000', d.salePrice, ' min="0" inputmode="decimal"')
              : ''),
            one ? 'Type either one — the other follows.' : 'With several products, the same percentage comes off each.');
        }
        case 'amount': return sec('Discount', input('Amount off the order (KES)', 'amount', 'number', '200', d.amount, ' min="0" inputmode="decimal"'));
        case 'spendsave': return sec('Spend and save', '<div class="mo-grid">' +
            input('Minimum spend (KES)', 'minSpend', 'number', '3000', d.minSpend, ' min="0"') +
            input('Amount off (KES)', 'amount', 'number', '300', d.amount, ' min="0"') + '</div>');
        case 'minspend': return sec('Qualifying order', input('Minimum order (KES)', 'minSpend', 'number', 'none', d.minSpend, ' min="0"'));
        case 'bxgy': return sec('Buy and get', '<div class="mo-grid">' +
            input('Customer buys', 'buyQty', 'number', '2', d.buyQty, ' min="1"') +
            input('Gets free', 'getQty', 'number', '1', d.getQty, ' min="1"') +
            input('Most free per order', 'maxFreeItems', 'number', 'no limit', d.maxFreeItems, ' min="1"') + '</div>',
            'The cheapest qualifying items are the free ones.');
        case 'freeitem': {
          var fi = listingById(d.freeItemId);
          return sec('The free item', (fi ? chosenList([fi.id], 'rmfree') : '<div class="mo-nodata">Not chosen yet.</div>') +
            '<button class="mo-btn" data-act="pick" data-mode="single">' + (fi ? 'Change' : '+ Choose') + ' the free item</button>');
        }
        case 'window': return sec('When the sale runs', '<div class="mo-grid">' +
            input('Starts', 'startsAt', 'datetime-local', '', d.startsAt) + input('Ends', 'endsAt', 'datetime-local', '', d.endsAt) + '</div>',
            'Leave the start empty to begin as soon as you publish. At the end time the sale price stops — online and at the till.');
        case 'dates': return sec('Dates (optional)', '<div class="mo-grid">' +
            input('Starts', 'startsAt', 'datetime-local', '', d.startsAt) + input('Ends', 'endsAt', 'datetime-local', '', d.endsAt) + '</div>',
            'Empty means it runs from publishing until you end it.');
        case 'schedule': return scheduleEditor(d) + calendarHTML(d);
        case 'limit': return sec('Limits', '<div class="mo-grid">' +
            input('Stop after this many sales', 'inventoryLimit', 'number', 'no limit', d.inventoryLimit, ' min="1"') +
            input('Per customer', 'perCustomerLimit', 'number', 'no limit', d.perCustomerLimit, ' min="1"') + '</div>',
            'Stock is still checked on every sale — an offer never sells what the shelf does not hold.');
        case 'conditions': return conditionsEditor(d);
        case 'stacking': return stackingEditor(d);
        case 'fulfilment': return sec('Where it applies', '<div class="mo-days">' +
            [['', 'Everywhere'], ['delivery', 'Delivery only'], ['pickup', 'Pickup only']].map(function (f) {
              return '<button class="mo-day' + ((d.fulfilment || '') === f[0] ? ' on' : '') + '" data-act="fulfil" data-v="' + f[0] + '">' + f[1] + '</button>';
            }).join('') + '</div>');
        case 'terms': return sec('Terms customers see (optional)',
            '<label class="mo-f"><textarea class="mo-in mo-ta" data-k="terms" rows="2" maxlength="300" placeholder="While stocks last. One per customer.">' + esc(d.terms) + '</textarea></label>');
      }
      return '';
    }

    function scheduleEditor(d) {
      return '<div class="mo-section"><div class="mo-h2">Days and hours</div>' +
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
               '" type="number" min="0" value="' + esc(d[key] == null ? '' : d[key]) + '" placeholder="' + esc(ph) + '"></label>';
      };
      return '<div class="mo-section"><div class="mo-h2">Conditions</div><div class="mo-grid">' +
        f('Minimum spend', 'minSpend', 'none') + f('Maximum discount', 'maxDiscount', 'none') +
        f('Per customer limit', 'perCustomerLimit', 'unlimited') +
        f('Total redemptions', 'totalRedemptionLimit', 'unlimited') +
        '</div></div>';
    }
    function stackingEditor(d) {
      return '<div class="mo-section"><div class="mo-h2">Combining with other offers</div><div class="mo-days">' +
        ['stackable', 'exclusive'].map(function (s) {
          return '<button class="mo-day' + (d.stacking === s ? ' on' : '') + '" data-act="stack" data-s="' + s + '">' +
                 (s === 'stackable' ? 'Can combine' : 'Cannot combine') + '</button>';
        }).join('') + '</div>' +
        '<div class="mo-hint">An offer that cannot combine silences the others — SOKONI applies the best one.</div>' +
      '</div>';
    }

    /* LIVE PREVIEW, computed by the promotion model itself so what the merchant sees is
       produced by the same resolver the customer's basket will use. The basket is built from
       the chosen CATALOGUE items at their CURRENT prices — and with nothing chosen there is no
       preview, never a made-up sample basket. */
    function preview(d) {
      var P = PM(); if (!P) return '';
      var lines = [];
      if (d.items.length) {
        lines = d.items.map(function (it) { return { listingId: it.listingId, price: itemPrice(it), qty: Number(it.qty) || 1 }; });
      } else if (d.products.length) {
        lines = d.products.map(function (id) {
          var l = listingById(id);
          return { listingId: id, price: l && typeof l.price === 'number' ? l.price : 0,
                   qty: d.type === 'buyXgetY' ? (Number(d.buyQty) || 1) + (Number(d.getQty) || 1) : 1 };
        });
      } else if (d.type === 'freeItem' && d.freeItemId) {
        var fl = listingById(d.freeItemId);
        lines = [{ listingId: d.freeItemId, price: fl && typeof fl.price === 'number' ? fl.price : 0, qty: 1 }];
      }
      if (!lines.length) {
        return '<div class="mo-section"><div class="mo-h2">Customer sees</div>' +
          '<div class="mo-state"><small>Choose products above to see exactly what a customer pays.</small></div></div>';
      }
      var offer = Object.assign(toPayload(d, 'live'), { id: 'preview', schedule: null, startsAt: null, endsAt: null });
      var r = P.resolve({ lines: lines, deliveryFee: d.type === 'freeDelivery' ? 150 : 0 }, [offer], {});
      return '<div class="mo-section"><div class="mo-h2">Customer sees</div><div class="mo-prev">' +
        r.explain.map(function (e) {
          return '<div class="mo-prev-row"><span>' + esc(e.label) + '</span><b>' +
                 (e.amount < 0 ? '-' : '') + kes(Math.abs(e.amount)) + '</b></div>';
        }).join('') +
        '</div><div class="mo-hint">' + esc(r.advisory) + '.' +
        (r.rejected.length ? ' Not applied: ' + esc(r.rejected.map(function (x) { return x.why; }).join('; ')) : '') +
        (d.type === 'freeDelivery' ? ' (A KES 150 delivery fee is used for this preview only.)' : '') +
        '</div></div>';
    }

    /* ── THE CATALOGUE PICKER — the shop's own products, live price and stock ─── */
    function pickerHTML() {
      var pk = state.picker; if (!pk) return '';
      var title = pk.mode === 'items' ? 'Add to the offer' : pk.mode === 'single' ? 'Choose the free item' : 'Choose products';
      var body;
      if (state.listings === null) body = '<div class="mo-state">Loading your products…</div>';
      else if (state.listingsError === 'no-source') body = '<div class="mo-state"><b>Your catalogue is not connected here</b><small>Products cannot be chosen in this view.</small></div>';
      else if (state.listingsError) body = '<div class="mo-state mo-state--err"><b>Products unavailable</b><small>' + esc(state.listingsError) + ' — nothing was read.</small></div>';
      else {
        var q = String(pk.q || '').toLowerCase();
        var rows = state.listings.filter(function (p) { return !q || String(p.name || '').toLowerCase().indexOf(q) > -1; });
        body = rows.length ? rows.map(function (p) {
          var chosen = pk.mode === 'items' ? state.draft.items.some(function (it) { return it.listingId === p.id; })
                     : pk.mode === 'single' ? state.draft.freeItemId === p.id : state.draft.products.indexOf(p.id) > -1;
          return '<button class="mo-pick' + (chosen ? ' on' : '') + '" data-act="pickone" data-id="' + esc(p.id) + '">' +
            '<span class="mo-pick-n">' + esc(p.name || 'Unnamed') + '<small>' + esc(stockText(p)) + '</small></span>' +
            '<b>' + (typeof p.price === 'number' ? kes(p.price) : '—') + '</b>' +
            '<i>' + (chosen ? '✓' : '+') + '</i></button>';
        }).join('') : '<div class="mo-state"><small>' + (q ? 'Nothing matches that search.' : 'Your catalogue has no products yet — add them in Products first.') + '</small></div>';
      }
      return '<div class="mo-scrim" data-act="pickclose"></div>' +
        '<div class="mo-sheet" role="dialog" aria-label="' + esc(title) + '">' +
          '<div class="mo-sheet-h"><b>' + esc(title) + '</b><button class="mo-x" data-act="pickclose" aria-label="Close">×</button></div>' +
          '<input class="mo-in mo-search" data-pick-q type="search" placeholder="Search your products" value="' + esc(pk.q || '') + '">' +
          '<div class="mo-sheet-b">' + body + '</div>' +
          '<div class="mo-sheet-f"><button class="mo-btn mo-btn--primary" data-act="pickclose">Done</button></div>' +
        '</div>';
    }

    function editView() {
      var d = state.draft, P = PM();
      var tpl = P && P.TEMPLATES[d.template], w = wiz(d);
      var readOnly = ctx.canWrite === false;
      var issues = state.showIssues ? problems(d) : [];
      return '<div class="mo-edit">' +
        '<div class="mo-edit-bar"><button class="mo-back" data-act="back">← All offers</button>' +
          '<span class="mo-edit-state">' + (d.id ? (STATUS_LABEL[statusOf(d)] || '') : 'NEW') + (state.dirty ? ' · unsaved changes' : '') + '</span></div>' +
        (d.id ? '' : templateRail(d.template)) +
        '<div class="mo-h1">' + (tpl ? tpl.icon + ' ' + esc(tpl.label) : 'New offer') + '</div>' +
        '<div class="mo-hint mo-blurb">' + esc(w.blurb) + '</div>' +
        (readOnly ? '<div class="mo-warn">Your role can see offers but not change them. Ask the owner or a manager.</div>' : '') +
        '<div class="mo-section">' + input('Offer name', 'name', 'text', w.namePh, d.name, ' maxlength="140"') + '</div>' +
        w.sections.map(function (s) { return sectionHTML(d, s); }).join('') +
        preview(d) + (d.id ? analyticsHTML(d) : '') +
        (issues.length ? '<div class="mo-warn"><b>Before publishing:</b><br>' + issues.map(esc).join('<br>') + '</div>' : '') +
        '<div class="mo-actions">' +
          '<button class="mo-btn" data-act="savedraft"' + (readOnly ? ' disabled' : '') + '>Save draft</button>' +
          '<button class="mo-btn mo-btn--primary" data-act="publish"' + (readOnly ? ' disabled' : '') + '>' +
            (d.startsAt && new Date(d.startsAt) > new Date() ? 'Schedule offer' : 'Publish offer') + '</button>' +
        '</div>' +
        (state.saveNote ? '<div class="mo-warn">' + esc(state.saveNote) + '</div>' : '') +
      '</div>';
    }

    function render() {
      host.innerHTML = '<div class="mo-wrap">' + (state.view === 'edit' && state.draft ? editView() : head() + listView()) + '</div>' +
        (state.view === 'edit' ? pickerHTML() : '');
    }

    /* ── NAVIGATION — Back returns to the list, on screen AND on the phone ──── */
    function enterEdit(d) {
      state.draft = d; state.view = 'edit'; state.saveNote = null; state.dirty = false; state.showIssues = false;
      state.calMonth = null; state.picker = null;
      if (W && W.history && typeof W.history.pushState === 'function' && !state.pushed) {
        try { W.history.pushState({ moEdit: true }, '', W.location.href); state.pushed = true; } catch (_) { state.pushed = false; }
      }
      if (state.listings === null) loadListings().then(render);
      render();
      try { host.scrollTop = 0; } catch (_) {}
    }
    function toList() {
      state.view = 'list'; state.draft = null; state.calMonth = null; state.picker = null; state.dirty = false; state.saveNote = null;
      render();
    }
    /* Leaving the editor. A changed offer that was never saved is offered as a draft rather
       than silently thrown away — the merchant built it, and losing it is the worst outcome. */
    function leaveEdit() {
      var d = state.draft;
      if (d && state.dirty && typeof ctx.saveOffer === 'function' && ctx.canWrite !== false) {
        var keep = true;
        try { keep = (W && typeof W.confirm === 'function') ? W.confirm('Keep this offer as a draft?') : true; } catch (_) { keep = true; }
        if (keep) { save(d, 'draft', true); return; }
      }
      toList();
    }
    function onPop() {
      state.pushed = false;
      if (state.view !== 'edit') return;
      collect(); leaveEdit();
    }
    function goBack() {
      /* Through history when we pushed an entry, so the phone's Back and this button agree. */
      if (state.pushed && W && W.history) { try { W.history.back(); return; } catch (_) {} }
      leaveEdit();
    }

    /* ── EVENTS ──────────────────────────────────────────────────────────── */
    function onClick(e) {
      var b = e.target.closest('[data-act]'); if (!b || !host.contains(b)) return;
      var a = b.dataset.act;
      /* COLLECT FIRST. Every re-render rebuilds the form; reading the inputs before any state
         change is what keeps a typed price from being wiped by a tap on a day chip. */
      if (state.view === 'edit') collect();
      var d = state.draft;
      if (a === 'new')      { return enterEdit(blankDraft(ctx.initialTemplate && WIZARDS[ctx.initialTemplate] ? ctx.initialTemplate : 'flashSale')); }
      if (a === 'tpl')      { return enterEdit(blankDraft(b.dataset.k)); }
      if (a === 'filter')   { state.filter = b.dataset.f; return render(); }
      if (a === 'edit')     { var o = byId(b.dataset.id); if (o) enterEdit(draftFromOffer(o)); return; }
      if (a === 'quickpublish') { var q = byId(b.dataset.id); if (q) { var qd = draftFromOffer(q); if (problems(qd).length) { enterEdit(qd); state.showIssues = true; return render(); } save(qd, 'live', true); } return; }
      if (a === 'archive')  { var ar = byId(b.dataset.id); if (ar) archive(ar); return; }
      if (a === 'back')     { return goBack(); }
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
      if (a === 'switch')   { switchTemplate(d, b.dataset.k); return render(); }
      if (a === 'day')      { var i = d.schedule.days.indexOf(b.dataset.d);
                              if (i > -1) d.schedule.days.splice(i, 1); else d.schedule.days.push(b.dataset.d);
                              state.dirty = true; return render(); }
      if (a === 'stack')    { d.stacking = b.dataset.s; state.dirty = true; return render(); }
      if (a === 'fulfil')   { d.fulfilment = b.dataset.v || ''; state.dirty = true; return render(); }
      if (a === 'rmitem')   { d.items.splice(Number(b.dataset.i), 1); state.dirty = true; return render(); }
      if (a === 'iteminc')  { var it1 = d.items[Number(b.dataset.i)]; if (it1) it1.qty = Math.min(99, (Number(it1.qty) || 1) + 1); state.dirty = true; return render(); }
      if (a === 'itemdec')  { var it2 = d.items[Number(b.dataset.i)]; if (it2) it2.qty = Math.max(1, (Number(it2.qty) || 1) - 1); state.dirty = true; return render(); }
      if (a === 'rmprod')   { d.products = d.products.filter(function (x) { return x !== b.dataset.id; }); state.dirty = true; return render(); }
      if (a === 'rmfree')   { d.freeItemId = ''; state.dirty = true; return render(); }
      if (a === 'pick')     { state.picker = { mode: b.dataset.mode, q: '' }; if (state.listings === null) loadListings().then(render); return render(); }
      if (a === 'pickclose'){ state.picker = null; return render(); }
      if (a === 'pickone')  { pickOne(d, b.dataset.id); return render(); }
      if (a === 'savedraft')return save(d, 'draft');
      if (a === 'publish')  return save(d, 'live');
    }
    function byId(id) { return state.offers.filter(function (o) { return o.id === id; })[0] || null; }

    function pickOne(d, id) {
      var pk = state.picker, l = listingById(id); if (!pk || !l) return;
      state.dirty = true;
      if (pk.mode === 'items') {
        var ex = d.items.filter(function (it) { return it.listingId === id; })[0];
        if (ex) ex.qty = Math.min(99, (Number(ex.qty) || 1) + 1);
        else d.items.push({ listingId: l.id, name: l.name, price: l.price, qty: 1 });
        return;
      }
      if (pk.mode === 'single') { d.freeItemId = id; state.picker = null; return; }
      var at = d.products.indexOf(id);
      if (at > -1) d.products.splice(at, 1); else d.products.push(id);
    }

    /* Switching type keeps what still applies — the name, the dates, the terms, the chosen
       products or items — and nothing else is sent, because the payload follows the NEW
       wizard's sections. */
    function switchTemplate(d, k) {
      var P = PM(); if (!WIZARDS[k] || !P || !P.TEMPLATES[k]) return;
      d.template = k; d.type = P.TEMPLATES[k].type; state.dirty = true; state.showIssues = false;
      if (wiz(d).sections.indexOf('items') > -1 && !d.items.length && d.products.length) {
        d.items = d.products.map(function (id) { var l = listingById(id); return { listingId: id, name: l && l.name, price: l && l.price, qty: 1 }; });
      }
      if (has(d, 'products') && !d.products.length && d.items.length) d.products = d.items.map(function (it) { return it.listingId; });
    }

    function collect() {
      var d = state.draft; if (!d || !host.querySelectorAll) return;
      host.querySelectorAll('.mo-in').forEach(function (el) {
        var k = el.dataset && el.dataset.k; if (!k) return;
        var v = el.value;
        if (k.indexOf('schedule.') === 0) d.schedule[k.split('.')[1]] = v;
        else d[k] = v;
      });
      /* A flash sale on ONE product may be priced by its sale price; the percentage follows.
         Kept to four decimals so the resolver lands on the price the merchant typed. */
      if (d.template === 'flashSale' && d.products.length === 1 && num(d.salePrice) !== null) {
        var one = listingById(d.products[0]);
        if (one && one.price > 0 && num(d.salePrice) < one.price) {
          d.percent = String(Math.round((1 - num(d.salePrice) / one.price) * 1000000) / 10000);
        }
      }
    }

    function save(d, status, fromList) {
      if (!fromList) collect();
      if (status === 'live') {
        var issues = problems(d);
        if (issues.length) { state.showIssues = true; state.saveNote = null; return render(); }
      }
      d.status = status;
      if (typeof ctx.saveOffer !== 'function') {
        /* HELD, AND SAID SO. Silence here would let a merchant build a campaign that
           evaporates on reload. */
        state.unsaved++;
        state.saveNote = 'Not saved — no offer store is connected to this view, so there is nowhere ' +
                         'for this to go. It is held in this session only and will be lost on reload.';
        return render();
      }
      state.saveNote = 'Saving…'; if (state.view === 'edit') render();
      Promise.resolve(ctx.saveOffer(toPayload(d, status), { draftToken: d.draftToken, offerId: d.id })).then(function (r) {
        var res = (r && r.data) || r || {};
        if (res.id) d.id = res.id;
        /* NO history.back() HERE. Popping is asynchronous: a merchant who reopened an offer at once was thrown
           out of it by the late popstate. The pushed entry stays and is REUSED by the next editor (enterEdit
           pushes only when none is held); at most one Back press later lands on the list it is already on. */
        toList();
        if (ctx.onToast) ctx.onToast(status === 'live' ? ((d.startsAt && new Date(d.startsAt) > new Date()) ? 'Offer scheduled' : 'Offer published') : 'Draft saved');
        load();
      }).catch(function (e) {
        state.saveNote = 'Not saved — ' + ((e && e.message) || 'the write was refused') + '.';
        if (state.view === 'edit') render(); else if (ctx.onToast) ctx.onToast(state.saveNote, 'error');
      });
    }

    function archive(o) {
      if (typeof ctx.saveOffer !== 'function' || ctx.canWrite === false) return;
      var ok = true;
      try { ok = (W && typeof W.confirm === 'function') ? W.confirm('End “' + (o.name || 'this offer') + '”? It stops applying immediately.') : true; } catch (_) {}
      if (!ok) return;
      Promise.resolve(ctx.saveOffer(Object.assign(toPayload(draftFromOffer(o), 'archived'), { status: 'archived' }), { offerId: o.id })).then(function () {
        if (ctx.onToast) ctx.onToast('Offer ended');
        load();
      }).catch(function (e) { if (ctx.onToast) ctx.onToast('Not changed — ' + ((e && e.message) || 'refused'), 'error'); });
    }

    function onInput(e) {
      var t = e.target;
      if (t && t.hasAttribute && t.hasAttribute('data-pick-q') && state.picker) {
        state.picker.q = t.value;
        var pos = t.selectionStart; render();
        var again = host.querySelector('[data-pick-q]'); if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (_) {} }
        return;
      }
      if (state.view === 'edit' && t && t.classList && t.classList.contains('mo-in')) state.dirty = true;
    }

    host.addEventListener('click', onClick);
    host.addEventListener('input', onInput);
    if (W) W.addEventListener('popstate', onPop);
    load();
    if (typeof ctx.listListings === 'function') loadListings().then(function () { if (state.view === 'edit' || state.offers.length) render(); });
    if (ctx.initialTemplate && WIZARDS[ctx.initialTemplate]) enterEdit(blankDraft(ctx.initialTemplate));

    return {
      refresh: function () { if (state.view !== 'edit') load(); },
      /* The Marketing shell's deep link (#flash-sale → a new flash sale). */
      openTemplate: function (k) { if (WIZARDS[k]) enterEdit(blankDraft(k)); },
      destroy: function () {
        host.removeEventListener('click', onClick); host.removeEventListener('input', onInput);
        if (W) W.removeEventListener('popstate', onPop);
        host.innerHTML = '';
      },
    };
  }

  return { mount: mount, WIZARDS: WIZARDS, ORDER: ORDER };
});
