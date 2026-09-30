/* ============================================================================
   SOKONI — Delivery engine
   ============================================================================
   ONE calculation of what delivery costs, shared by checkout, POS, marketplace,
   dispatch, reporting, customer order pages and the merchant dashboard.

   ── Why this exists ────────────────────────────────────────────────────────
   Delivery was being priced in at least four different places, each with its
   own rules:

     checkout.html:3158   Math.round(80 + zone.distanceKm * 15)   hardcoded
     delivery-hub.js:212  _calcFee(distance, vehicle, weight, urgency)
     food-menu.html:320   _rest.deliveryFee || 50                 hardcoded default
     functions/index.js:3303  clamps a CLIENT-SUPPLIED fee to 0..5000

   A merchant who sets "free delivery" in one place therefore has no way to be
   sure every surface agrees, and the last of those trusts a number the client
   sent. Four implementations of a price is four answers to "what does this
   cost?" — the same defect class as two inventories or two receipt numbers.

   ── What this module is ────────────────────────────────────────────────────
   PURE. No Firestore, no network, no writes. It takes a config and an order and
   returns a number and a reason. That makes it testable without an emulator,
   callable identically on the client and in a Cloud Function, and impossible to
   fork accidentally — the server can recompute exactly what the client showed
   and reject a mismatch rather than clamping a guess.
   ========================================================================= */

(function (root) {
  'use strict';

  var MODES = ['free', 'flat', 'distance', 'zones', 'own_fleet', 'pickup_only'];

  /* A merchant with no configuration must not silently get free delivery, and
     must not get a surprise charge either. Disabled means "not offered". */
  var DEFAULTS = {
    enabled: false,
    mode: 'pickup_only',
    defaultFee: 0,
    freeAbove: null,        /* order value at or above which delivery is free */
    perKm: 0,
    baseFee: 0,
    maxDistanceKm: null,
    allowEditingUntilDispatch: true,
    operatingHours: null,   /* { open: 'HH:MM', close: 'HH:MM' } | null = always */
    serviceZones: [],       /* [{ name, fee, etaMinutes }] */
  };

  function _cfg(config) {
    var c = Object.assign({}, DEFAULTS, config || {});
    if (MODES.indexOf(c.mode) === -1) c.mode = DEFAULTS.mode;
    return c;
  }

  function _round(n) { return Math.max(0, Math.round(Number(n) || 0)); }

  /* ── canDeliver ──────────────────────────────────────────────────────────
     Answers before pricing, because "we do not deliver there" is a different
     answer from "delivery costs 0". Conflating them is how a customer is shown
     free delivery to an address the merchant cannot reach. */
  function canDeliver(config, order) {
    var c = _cfg(config);
    var o = order || {};

    if (!c.enabled)             return { ok: false, reason: 'delivery_not_offered' };
    if (c.mode === 'pickup_only') return { ok: false, reason: 'pickup_only' };

    if (c.maxDistanceKm != null && o.distanceKm != null &&
        Number(o.distanceKm) > Number(c.maxDistanceKm)) {
      return { ok: false, reason: 'outside_delivery_radius' };
    }

    if (c.mode === 'zones') {
      var zone = _findZone(c, o.zone);
      if (!zone) return { ok: false, reason: 'zone_not_served' };
    }

    if (c.operatingHours && o.at) {
      if (!_withinHours(c.operatingHours, o.at)) {
        return { ok: false, reason: 'outside_operating_hours' };
      }
    }
    return { ok: true, reason: 'deliverable' };
  }

  function _findZone(c, zoneName) {
    if (!zoneName) return null;
    var want = String(zoneName).toLowerCase().trim();
    var zones = c.serviceZones || [];
    for (var i = 0; i < zones.length; i++) {
      if (String(zones[i].name || '').toLowerCase().trim() === want) return zones[i];
    }
    return null;
  }

  function _withinHours(hours, at) {
    try {
      var d = at instanceof Date ? at : new Date(at);
      var mins = d.getHours() * 60 + d.getMinutes();
      var open  = _hhmm(hours.open);
      var close = _hhmm(hours.close);
      if (open == null || close == null) return true;
      /* A window that crosses midnight is a real case for water deliveries. */
      return close >= open ? (mins >= open && mins <= close)
                           : (mins >= open || mins <= close);
    } catch (e) { return true; }
  }

  function _hhmm(s) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
    return m ? (Number(m[1]) * 60 + Number(m[2])) : null;
  }

  /* ── calculateDelivery ───────────────────────────────────────────────────
     Returns the fee AND why it is that number. The reason is not decoration:
     it is what lets a server recompute a client's figure and say precisely
     where they diverged, instead of clamping an unexplained value. */
  function calculateDelivery(config, order) {
    var c = _cfg(config);
    var o = order || {};

    var eligible = canDeliver(c, o);
    if (!eligible.ok) {
      return { fee: 0, deliverable: false, reason: eligible.reason, mode: c.mode, free: false };
    }

    /* Order-value threshold wins over every priced mode — a merchant who says
       "free above 2000" means it regardless of distance. */
    var subtotal = Number(o.subtotal || 0);
    if (c.freeAbove != null && subtotal >= Number(c.freeAbove)) {
      return { fee: 0, deliverable: true, reason: 'free_above_threshold', mode: c.mode, free: true };
    }

    switch (c.mode) {
      case 'free':
        return { fee: 0, deliverable: true, reason: 'free_delivery', mode: c.mode, free: true };

      case 'flat':
        return { fee: _round(c.defaultFee), deliverable: true, reason: 'flat_rate', mode: c.mode, free: false };

      case 'distance': {
        if (o.distanceKm == null) {
          /* Refuse rather than guess. A fee invented from a missing distance is
             a number the customer is charged for no reason. */
          return { fee: 0, deliverable: false, reason: 'distance_unknown', mode: c.mode, free: false };
        }
        var fee = Number(c.baseFee || 0) + Number(c.perKm || 0) * Number(o.distanceKm);
        return { fee: _round(fee), deliverable: true, reason: 'distance_based', mode: c.mode, free: false };
      }

      case 'zones': {
        var zone = _findZone(c, o.zone);
        return {
          fee: _round(zone.fee), deliverable: true, reason: 'zone_rate',
          mode: c.mode, free: _round(zone.fee) === 0, zone: zone.name,
          etaMinutes: zone.etaMinutes == null ? null : Number(zone.etaMinutes),
        };
      }

      case 'own_fleet':
        return { fee: _round(c.defaultFee), deliverable: true, reason: 'own_fleet', mode: c.mode, free: _round(c.defaultFee) === 0 };

      default:
        return { fee: 0, deliverable: false, reason: 'pickup_only', mode: c.mode, free: false };
    }
  }

  /* ── isEditable ──────────────────────────────────────────────────────────
     ADR-010. Financial fields are never editable after payment; fulfilment
     fields are editable until dispatch and frozen after it.

     This function answers only for FULFILMENT fields. It deliberately has no
     branch that returns true for a financial field, so it cannot be misused as
     a general "can I edit this order?" check. */
  var FULFILMENT_FIELDS = [
    'houseNumber', 'apartment', 'estate', 'landmark', 'deliveryNotes',
    'deliveryInstructions', 'recipientPhone', 'customerPhone',
    'assignedDriver', 'preferredWindow',
  ];

  var DISPATCHED_STATES = ['dispatched', 'out_for_delivery', 'delivered', 'cancelled', 'returned'];

  function isEditable(config, order, field) {
    var c = _cfg(config);
    var o = order || {};

    if (FULFILMENT_FIELDS.indexOf(field) === -1) {
      return { ok: false, reason: 'not_a_fulfilment_field' };
    }
    if (c.allowEditingUntilDispatch === false) {
      return { ok: false, reason: 'merchant_disallows_editing' };
    }
    var status = String(o.status || '').toLowerCase();
    if (DISPATCHED_STATES.indexOf(status) !== -1) {
      return { ok: false, reason: 'dispatched' };
    }
    return { ok: true, reason: 'editable_until_dispatch' };
  }

  /* ── deliverySummary ─────────────────────────────────────────────────────
     One human-readable line, so checkout, the receipt, the dashboard and the
     dispatch list cannot describe the same delivery differently. */
  function deliverySummary(config, order) {
    var r = calculateDelivery(config, order);
    if (!r.deliverable) {
      return {
        label: r.reason === 'pickup_only' ? 'Pickup only' : 'Delivery unavailable',
        detail: r.reason, fee: 0, free: false, deliverable: false,
      };
    }
    return {
      label: r.free ? 'FREE delivery' : 'Delivery KES ' + r.fee.toLocaleString(),
      detail: r.reason, fee: r.fee, free: r.free, deliverable: true,
      zone: r.zone || null, etaMinutes: r.etaMinutes == null ? null : r.etaMinutes,
    };
  }

  var API = {
    MODES: MODES,
    DEFAULTS: DEFAULTS,
    FULFILMENT_FIELDS: FULFILMENT_FIELDS,
    calculateDelivery: calculateDelivery,
    canDeliver: canDeliver,
    deliverySummary: deliverySummary,
    isEditable: isEditable,
  };

  root.SokoniDeliveryEngine = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;

})(typeof window !== 'undefined' ? window : globalThis);
