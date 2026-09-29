/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — PROMOTION MODEL. One promotion vocabulary, one deterministic resolver.
   sokoni-promotion-model.js

   WHAT THIS IS, AND WHAT IT IS NOT
   It is the commercial-rules layer: what an offer IS, when it APPLIES, and — given a basket —
   which offers win and what each one takes off, with a line-by-line explanation.

   IT IS NOT A PRICING AUTHORITY. It computes a QUOTE for display so the customer is never
   shown a mysterious total. THE SERVER REMAINS AUTHORITATIVE ON WHAT IS CHARGED. A browser
   that could decide its own discount is a browser that could decide its own price, and this
   estate's standing rule is that payment is never trusted from the client. Anything this
   returns is a prediction to render, never a figure to charge.

   IT DOES NOT DUPLICATE sokoni-offers.js. That module is a per-product PRICE OVERRIDE with
   CRUD and a badge helper — one offerPrice on one product. It stays exactly as it is, and
   legacy offers are readable here through fromLegacy(). This adds the layer it never had:
   bundles, buy-X-get-Y, happy hours, spend-and-save, conditions, stacking and priority.

   IT WRITES NOTHING. No Firestore, no inventory, no order. It is a pure function over data
   the caller already holds, which is what makes it testable without a network.

   ── THE RESOLUTION ORDER IS FIXED, AND THAT IS THE POINT ────────────────────
        1  ELIGIBILITY      is the offer live, scheduled, and within its limits
        2  QUALIFICATION    does this basket actually contain what the offer requires
        3  STACKING         exclusive offers remove all others; the rest may combine
        4  PRIORITY         higher priority resolves first, ties broken by larger saving
        5  CALCULATION      each offer's discount computed against the CURRENT running total
        6  CAPS             per-offer maximum discount, then the basket floor
        7  EXPLANATION      every applied line named, so a total can always be accounted for

   Deterministic because the same basket and the same offers must always produce the same
   total. "Best guess" pricing is how two customers see two prices for one cart.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  /* ── OFFER TYPES ──────────────────────────────────────────────────────────
     Each names how a discount is DERIVED. Presentation (flash sale, happy hour,
     meal deal) is a TEMPLATE over these, not a separate maths path — otherwise every
     new marketing idea needs new arithmetic and a new way to be wrong. */
  var TYPES = {
    percentage:   { id:'percentage',   label:'Percentage off',  needs:['percent'] },
    fixed:        { id:'fixed',        label:'Amount off',      needs:['amount'] },
    bundle:       { id:'bundle',       label:'Bundle price',    needs:['items','bundlePrice'] },
    buyXgetY:     { id:'buyXgetY',     label:'Buy X get Y',     needs:['buyQty','getQty'] },
    spendAndSave: { id:'spendAndSave', label:'Spend and save',  needs:['minSpend','amount'] },
    freeDelivery: { id:'freeDelivery', label:'Free delivery',   needs:[] },
    freeItem:     { id:'freeItem',     label:'Free item',       needs:['freeItemId'] },
  };

  /* Marketing templates. They CONFIGURE a type; they do not add arithmetic. */
  var TEMPLATES = {
    mealDeal:    { type:'bundle',       label:'Meal deal',    icon:'🍕' },
    package:     { type:'bundle',       label:'Package',      icon:'📦' },
    flashSale:   { type:'percentage',   label:'Flash sale',   icon:'🔥' },
    happyHour:   { type:'percentage',   label:'Happy hour',   icon:'⏰' },
    percentOff:  { type:'percentage',   label:'Percentage off', icon:'💰' },
    coupon:      { type:'fixed',        label:'Coupon',       icon:'🏷️' },
    bxgy:        { type:'buyXgetY',     label:'Buy X get Y',  icon:'🎁' },
    freeDelivery:{ type:'freeDelivery', label:'Free delivery',icon:'🚚' },
    stayPackage: { type:'bundle',       label:'Stay package', icon:'🏨' },
    servicePack: { type:'bundle',       label:'Service package', icon:'💇' },
    spendSave:   { type:'spendAndSave', label:'Spend and save', icon:'💸' },
    /* U7c1 (2026-09-29): the freeItem TYPE existed with no template, so no merchant could make one. */
    freeGift:    { type:'freeItem',     label:'Free gift',    icon:'🎀' },
  };

  var DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  function n(v, d) { var x = Number(v); return Number.isFinite(x) ? x : (d || 0); }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function minutesOf(hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    return m ? (Number(m[1]) * 60 + Number(m[2])) : null;
  }

  /**
   * Is the offer live at this instant? Schedule is days + a daily window, not merely a
   * date range — a happy hour is 17:00–19:00 on weekdays, which a start/end date cannot say.
   * UNKNOWN IS NOT ELIGIBLE: a malformed schedule fails closed rather than running forever.
   */
  function isLive(offer, at) {
    var o = offer || {}, now = at instanceof Date ? at : new Date();
    if (o.status && o.status !== 'live' && o.status !== 'active') return false;
    if (o.startsAt && now < new Date(o.startsAt)) return false;
    if (o.endsAt && now > new Date(o.endsAt)) return false;
    var s = o.schedule;
    if (!s) return true;                                  /* no schedule = always, once dated */
    var days = arr(s.days).map(function (d) { return String(d).slice(0, 3).toLowerCase(); });
    if (days.length && days.indexOf(DAYS[now.getDay()]) === -1) return false;
    if (s.from || s.to) {
      var f = minutesOf(s.from), t = minutesOf(s.to);
      if (f === null || t === null) return false;         /* fail closed on a broken window */
      var cur = now.getHours() * 60 + now.getMinutes();
      /* A window may cross midnight (22:00–02:00); treating that as empty would silently
         disable every late-night offer. */
      if (f <= t ? (cur < f || cur > t) : (cur < f && cur > t)) return false;
    }
    return true;
  }

  /** Redemption limits. Absent counters mean UNMETERED, never exhausted. */
  function withinLimits(offer, usage) {
    var o = offer || {}, u = usage || {};
    if (o.totalRedemptionLimit != null && n(u.totalRedemptions) >= n(o.totalRedemptionLimit)) return false;
    if (o.perCustomerLimit != null && n(u.customerRedemptions) >= n(o.perCustomerLimit)) return false;
    /* Inventory-aware: a bundle cannot outlive the stock it is assembled from. */
    if (o.inventoryLimit != null && n(u.inventorySold) >= n(o.inventoryLimit)) return false;
    return true;
  }

  /** Does this basket contain what the offer requires? */
  function qualifies(offer, basket) {
    var o = offer || {}, b = basket || {}, lines = arr(b.lines);
    var subtotal = n(b.subtotal, lines.reduce(function (s, l) { return s + n(l.price) * n(l.qty, 1); }, 0));
    if (o.minSpend != null && subtotal < n(o.minSpend)) return false;
    if (o.fulfilment && b.fulfilment && o.fulfilment !== b.fulfilment) return false;
    var ids = arr(o.qualifyingListingIds);
    if (ids.length && !lines.some(function (l) { return ids.indexOf(l.listingId) > -1; })) return false;
    if (o.type === 'buyXgetY') {
      var qty = lines.filter(function (l) { return !ids.length || ids.indexOf(l.listingId) > -1; })
                     .reduce(function (s, l) { return s + n(l.qty, 1); }, 0);
      if (qty < n(o.buyQty, 1)) return false;
    }
    if (o.type === 'bundle' && arr(o.items).length) {
      var ok = arr(o.items).every(function (it) {
        return lines.some(function (l) { return l.listingId === it.listingId && n(l.qty, 1) >= n(it.qty, 1); });
      });
      if (!ok) return false;
    }
    return true;
  }

  /** What this offer takes off, against the CURRENT running total. */
  function discountOf(offer, basket, runningTotal) {
    var o = offer || {}, b = basket || {}, lines = arr(b.lines);
    var base = n(runningTotal, n(b.subtotal));
    var ids = arr(o.qualifyingListingIds);
    var scoped = ids.length
      ? lines.filter(function (l) { return ids.indexOf(l.listingId) > -1; })
             .reduce(function (s, l) { return s + n(l.price) * n(l.qty, 1); }, 0)
      : base;

    switch (o.type) {
      case 'percentage':   return Math.round(scoped * (n(o.percent) / 100));
      case 'fixed':        return Math.min(n(o.amount), base);
      case 'spendAndSave': return Math.min(n(o.amount), base);
      case 'bundle': {
        var worth = arr(o.items).reduce(function (s, it) {
          var l = lines.filter(function (x) { return x.listingId === it.listingId; })[0];
          return s + (l ? n(l.price) * n(it.qty, 1) : 0);
        }, 0);
        return Math.max(0, worth - n(o.bundlePrice));
      }
      case 'buyXgetY': {
        var elig = lines.filter(function (l) { return !ids.length || ids.indexOf(l.listingId) > -1; })
                        .slice().sort(function (a, c) { return n(a.price) - n(c.price); });
        var need = n(o.buyQty, 1) + n(o.getQty, 1), free = 0, unit = elig.length ? n(elig[0].price) : 0;
        var total = elig.reduce(function (s, l) { return s + n(l.qty, 1); }, 0);
        free = Math.floor(total / need) * n(o.getQty, 1);
        if (o.maxFreeItems != null) free = Math.min(free, n(o.maxFreeItems));
        return free * unit;                    /* cheapest qualifying item is the free one */
      }
      case 'freeDelivery': return Math.min(n(b.deliveryFee), n(b.deliveryFee));
      case 'freeItem': {
        var fl = lines.filter(function (l) { return l.listingId === o.freeItemId; })[0];
        return fl ? n(fl.price) : 0;
      }
      default: return 0;
    }
  }

  /**
   * THE RESOLVER. Returns { subtotal, lines[], discount, deliveryFee, total, applied[], rejected[] }.
   * Every applied offer carries its own line so a total can always be accounted for.
   */
  function resolve(basket, offers, context) {
    var b = basket || {}, ctx = context || {}, at = ctx.at instanceof Date ? ctx.at : new Date();
    var lines = arr(b.lines);
    var subtotal = n(b.subtotal, lines.reduce(function (s, l) { return s + n(l.price) * n(l.qty, 1); }, 0));
    var deliveryFee = n(b.deliveryFee);
    var applied = [], rejected = [];

    /* 1-2 ELIGIBILITY and QUALIFICATION, each rejection given a reason the merchant can act on. */
    var candidates = arr(offers).filter(function (o) {
      if (!o || !TYPES[o.type]) { rejected.push({ offer: o && o.id, why: 'unknown offer type' }); return false; }
      if (!isLive(o, at))       { rejected.push({ offer: o.id, why: 'not live now' }); return false; }
      if (!withinLimits(o, (ctx.usage || {})[o.id])) { rejected.push({ offer: o.id, why: 'redemption limit reached' }); return false; }
      if (!qualifies(o, b))     { rejected.push({ offer: o.id, why: 'basket does not qualify' }); return false; }
      return true;
    });

    /* 3 STACKING. One exclusive offer silences the rest — the best one, so the customer is
       never quietly given the weaker of two offers they qualified for. */
    var exclusives = candidates.filter(function (o) { return o.stacking === 'exclusive'; });
    if (exclusives.length) {
      var best = exclusives.slice().sort(function (a, c) {
        return discountOf(c, b, subtotal) - discountOf(a, b, subtotal);
      })[0];
      candidates.forEach(function (o) { if (o !== best) rejected.push({ offer: o.id, why: 'excluded by ' + best.id }); });
      candidates = [best];
    }

    /* 4 PRIORITY, then larger saving. Deterministic: no reliance on array order. */
    candidates.sort(function (a, c) {
      var p = n(c.priority) - n(a.priority);
      if (p) return p;
      return discountOf(c, b, subtotal) - discountOf(a, b, subtotal);
    });

    /* 5-6 CALCULATION and CAPS, against the running total so stacked percentages compound
       the way a human would read them rather than all billing off the original. */
    var running = subtotal;
    candidates.forEach(function (o) {
      var d = discountOf(o, b, running);
      if (o.maxDiscount != null) d = Math.min(d, n(o.maxDiscount));
      if (o.type === 'freeDelivery') {
        if (deliveryFee <= 0) { rejected.push({ offer: o.id, why: 'no delivery fee to waive' }); return; }
        applied.push({ id:o.id, label:o.name || TYPES[o.type].label, type:o.type, amount:deliveryFee, kind:'delivery' });
        deliveryFee = 0; return;
      }
      d = Math.max(0, Math.min(d, running));        /* never below zero, never past the total */
      if (d <= 0) { rejected.push({ offer: o.id, why: 'no discount produced' }); return; }
      running -= d;
      applied.push({ id:o.id, label:o.name || TYPES[o.type].label, type:o.type, amount:d, kind:'discount' });
    });

    var discount = subtotal - running;
    return {
      subtotal: subtotal,
      discount: discount,
      deliveryFee: deliveryFee,
      total: Math.max(0, running + deliveryFee),
      applied: applied,
      rejected: rejected,
      /* 7 EXPLANATION — the checkout renders these verbatim. */
      explain: [{ label:'Subtotal', amount:subtotal }]
        .concat(applied.map(function (a) { return { label:a.label, amount:-a.amount }; }))
        .concat([{ label:'Delivery', amount:deliveryFee }, { label:'Total', amount:Math.max(0, running + deliveryFee) }]),
      /* NOT AN AUTHORITY. Stated in the payload so no caller can mistake it for one. */
      advisory: 'display quote — the server decides what is charged',
    };
  }

  /** Read a legacy single-product offer from sokoni-offers.js as a percentage offer. */
  function fromLegacy(legacy, listingId) {
    var l = legacy || {};
    if (!l.offerPrice || !l.originalPrice) return null;
    return {
      id: l.id || ('legacy-' + (listingId || '')),
      name: l.badgeText || 'Offer',
      type: 'percentage',
      percent: n(l.discountPercent, Math.round((1 - n(l.offerPrice) / n(l.originalPrice)) * 100)),
      qualifyingListingIds: listingId ? [listingId] : [],
      stacking: 'exclusive',
      status: 'live',
    };
  }

  var api = { TYPES:TYPES, TEMPLATES:TEMPLATES, isLive:isLive, withinLimits:withinLimits,
              qualifies:qualifies, discountOf:discountOf, resolve:resolve, fromLegacy:fromLegacy };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SokoniPromotionModel = api;
/* THE TRUE GLOBAL. `this` at CommonJS module scope is module.exports, NOT the global —
   so a sibling module attached to the global was invisible here and every listing silently
   fell back to 'product'. It worked in a browser and degraded quietly under Node, which is
   the worst combination: green in the place you test least. */
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
