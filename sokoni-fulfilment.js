/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — FULFILMENT CONTRACT
   ══════════════════════════════════════════════════════════════════════════════
   One order, one financial truth. Fulfilment is a BRANCH of the order, never a
   second order and never a second accounting path:

     order
       items · customer · payment · totals · serverTimestamp
       fulfilment
         type                pickup | delivery
         destinationSnapshot  immutable copy, delivery only
         assignment
           method            shop | sokoni | external
           rider
           status

   ── PAYMENT AND DELIVERY ARE INDEPENDENT ────────────────────────────────────
   Changing the rider must not touch the money, and taking payment must not touch
   the delivery. `applyFulfilment` returns a NEW order object and is asserted never
   to alter items, payment or totals — so a merchant can move backwards and forwards
   through the flow without a second order appearing or a total quietly shifting.

   ── THE RECEIPT NEVER INVENTS ───────────────────────────────────────────────
   If no rider is assigned the receipt says "Not yet assigned". It does not name a
   shop's default rider, it does not say "SOKONI rider" because the method was
   sokoni, and it does not leave the line out so the gap goes unnoticed. Same rule
   as every other SOKONI surface: an unknown is stated, never filled in.

   ── WHAT THIS MODULE MUST NOT DO, YET ───────────────────────────────────────
   It produces a fulfilment BRANCH for an order object. It does NOT write
   deliveryAddress, dropoffLat/Lng or any other production destination field. The
   canonical migration is design-frozen but UNPROVEN (nine orders, one seller), and
   writing one now would create the twelfth spelling of an address in this codebase.
   `projection()` exists and deliberately returns nothing until that gate clears —
   see docs/CANONICAL_ORDER_DESTINATION.md.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var TYPES = ['pickup', 'delivery'];
  var METHODS = ['shop', 'sokoni', 'external'];
  var STATUS = ['unassigned', 'assigned', 'picked_up', 'delivered', 'failed'];

  var _s = function (v, n) { return String(v == null ? '' : v).slice(0, n || 120).trim(); };

  /* ── the fulfilment branch ─────────────────────────────────────────────── */
  function buildFulfilment (input) {
    var o = input || {};
    var type = TYPES.indexOf(o.type) > -1 ? o.type : null;
    if (!type) throw new Error('fulfilment type must be pickup or delivery');

    var f = { type: type };

    if (type === 'delivery') {
      /* A delivery with nowhere to go is not a delivery. Refuse it here rather than
         let a receipt print an empty address block. */
      if (!o.destinationSnapshot || typeof o.destinationSnapshot !== 'object') {
        throw new Error('a delivery needs a destination');
      }
      f.destinationSnapshot = o.destinationSnapshot;
      f.assignment = buildAssignment(o.assignment);
      if (o.note) f.note = _s(o.note, 300);
    } else {
      /* PICKUP CARRIES NO DESTINATION, even if one was passed. A pickup receipt that
         prints an address is telling the customer something untrue about their own
         order — and it is exactly how an invented destination gets into the system. */
      f.assignment = null;
    }
    return f;
  }

  function buildAssignment (a) {
    if (!a || !a.method) return { method: null, rider: null, status: 'unassigned' };
    if (METHODS.indexOf(a.method) === -1) throw new Error('unknown delivery method: ' + a.method);

    var out = { method: a.method, rider: null, status: 'unassigned' };

    if (a.method === 'external') {
      /* An external rider is only meaningful if we can identify and reach them.
         Half a rider is worse than none: it looks assigned and cannot be contacted. */
      var name = _s(a.rider && a.rider.name);
      var phone = _s(a.rider && a.rider.phone, 32);
      if (!name || !phone) throw new Error('an external rider needs a name and a phone number');
      out.rider = { name: name, phone: phone };
      var plate = _s(a.rider && a.rider.plate, 24);
      if (plate) out.rider.plate = plate;
      out.status = 'assigned';
    } else if (a.rider && (a.rider.uid || a.rider.name)) {
      out.rider = {};
      if (a.rider.uid) out.rider.uid = _s(a.rider.uid, 64);
      if (a.rider.name) out.rider.name = _s(a.rider.name);
      if (a.rider.phone) out.rider.phone = _s(a.rider.phone, 32);
      out.status = 'assigned';
    }
    /* method chosen but nobody picked yet — "assign later" is a real answer. */
    if (a.status && STATUS.indexOf(a.status) > -1) out.status = a.status;
    return out;
  }

  /* ── apply to an order without touching the money ──────────────────────── */
  function applyFulfilment (order, input) {
    var next = {};
    Object.keys(order || {}).forEach(function (k) { next[k] = order[k]; });
    next.fulfilment = buildFulfilment(input);
    return next;
  }

  /* ── receipt block ─────────────────────────────────────────────────────── */
  var RIDER_UNASSIGNED = 'Not yet assigned';

  /* ── THE RECEIPT BLOCK ──────────────────────────────────────────────────────
     Headed DELIVERY or PICKUP, because that is the word the customer is looking
     for. The address is broken into ONE COMPONENT PER LINE rather than joined with
     separators: on 32-column paper a joined address wraps at an arbitrary point
     and a rider reads a mangled street. Method and rider come last, together,
     because they answer the same question — who is bringing it. */
  var METHOD_LABEL = {
    sokoni: 'SOKONI Rider',
    external: 'External rider',
    shop: 'Shop delivery',
  };

  function receiptFulfilment (f) {
    if (!f || !f.type) return { heading: 'FULFILMENT', lines: ['Not recorded'] };

    if (f.type === 'pickup') {
      return { heading: 'PICKUP', lines: ['Collected at the shop'] };
    }

    var a = f.assignment || {};
    var lines = [];
    var d = f.destinationSnapshot || {};

    /* WHERE it is going, first — one component per line. */
    if (d.label) lines.push(_s(d.label, 40));
    if (d.recipientName) lines.push(_s(d.recipientName, 60));
    if (d.phone) lines.push(_s(d.phone, 32));
    var parts = [d.building, d.unit, d.street, d.area, d.town]
      .map(function (x) { return _s(x, 80); }).filter(Boolean);
    if (parts.length) parts.forEach(function (x) { lines.push(x); });
    else if (d.formatted) lines.push(_s(d.formatted, 160));
    if (d.instructions) lines.push('Note: ' + _s(d.instructions, 300));
    if (f.note) lines.push('Note: ' + _s(f.note, 300));

    /* WHO is bringing it, last. */
    if (a.rider && (a.rider.name || a.rider.uid)) {
      lines.push('Rider: ' + _s(a.rider.name || a.rider.uid, 60));
      if (a.rider.phone) lines.push(_s(a.rider.phone, 32));
      if (a.rider.plate) lines.push(_s(a.rider.plate, 32));
    } else {
      /* The whole point. No rider means the receipt SAYS no rider. */
      lines.push('Rider: ' + RIDER_UNASSIGNED);
    }
    if (a.method && METHOD_LABEL[a.method]) lines.push('Method: ' + METHOD_LABEL[a.method]);

    return { heading: 'DELIVERY', lines: lines };
  }

  /* ── the projection, deliberately inert ────────────────────────────────── */
  /* When the broader migration gate clears, THIS is where deliveryAddress and the
     coordinate pair get derived from destinationSnapshot — one writer owning both,
     so they cannot drift the way eleven spellings already did. Until then it returns
     nothing, and calling it cannot accidentally write a production field. */
  function projection () { return null; }

  global.SokoniFulfilment = {
    TYPES: TYPES, METHODS: METHODS, STATUS: STATUS, RIDER_UNASSIGNED: RIDER_UNASSIGNED,
    buildFulfilment: buildFulfilment, buildAssignment: buildAssignment,
    applyFulfilment: applyFulfilment, receiptFulfilment: receiptFulfilment,
    projection: projection,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).SokoniFulfilment;
}
