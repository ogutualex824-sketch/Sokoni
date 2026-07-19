/* ══════════════════════════════════════════════════════════════════════════
   SOKONI — Canonical fulfilment lifecycle (client)

   The browser mirror of functions/fulfilment-lifecycle.js.

   WHY A MIRROR RATHER THAN A FETCH
   The seller board, order timeline and notification labels all need to resolve a
   stage before first paint. A round trip to read the vocabulary would put a
   network hop in front of rendering, and would fail offline — where SmartPOS is
   expected to keep working.

   WHY THIS IS NOT A SECOND VOCABULARY
   Duplication is only safe if drift is impossible to ship. scripts/test-lifecycle-parity.js
   asserts this file and the server module agree EXACTLY on stages, aliases and
   labels, and fails the build otherwise. Add an alias on one side only and the
   gate goes red. The parity test is what makes this a mirror instead of a fork.

   If these ever need to diverge, that is a design change to make deliberately —
   not something to discover in production because a rider was refused an address.
   ══════════════════════════════════════════════════════════════════════════ */
window.SokoniLifecycle = (() => {
  'use strict';

  const CANONICAL = [
    'pending', 'accepted', 'packing', 'ready_for_pickup', 'assigned',
    'picked_up', 'in_transit', 'delivered', 'completed', 'returned',
  ];

  const ORDER = CANONICAL.reduce((m, s, i) => (m[s] = i, m), {});

  const ALIASES = {
    pending: 'pending', open: 'pending', pending_payment: 'pending',
    awaiting_confirmation: 'pending', order_placed: 'pending', queued: 'pending',
    accepted: 'accepted', confirmed: 'accepted', paid: 'accepted',
    processing: 'accepted', driver_accepted: 'assigned',
    packing: 'packing', picking: 'packing', being_packed: 'packing',
    ready_for_pickup: 'ready_for_pickup', ready: 'ready_for_pickup',
    awaiting_pickup: 'ready_for_pickup', offered: 'ready_for_pickup',
    assigned: 'assigned', driver_assigned: 'assigned', rider_assigned: 'assigned',
    picked_up: 'picked_up', picking_up: 'picked_up', collected: 'picked_up',
    in_transit: 'in_transit', out_for_delivery: 'in_transit', shipped: 'in_transit',
    rider_en_route: 'in_transit', arriving: 'in_transit', en_route: 'in_transit',
    delivered: 'delivered',
    completed: 'completed', complete: 'completed', settled: 'completed',
    returned: 'returned', return_initiated: 'returned', refunded: 'returned',
    cancelled: 'returned', canceled: 'returned', failed: 'returned',
    exhausted: 'returned', suspended: 'returned',
    /* notify.js ORDER_TIMELINE keys (notify.js:622) — written to timelineStage
       by advanceOrder, not to status. See the server module for why. */
    received: 'pending', preparing: 'packing', ready: 'ready_for_pickup',
    halfway: 'in_transit', near: 'in_transit',
  };

  const LABELS = {
    pending: 'New order', accepted: 'Accepted', packing: 'Packing',
    ready_for_pickup: 'Ready for pickup', assigned: 'Rider assigned',
    picked_up: 'Picked up', in_transit: 'In transit', delivered: 'Delivered',
    completed: 'Completed', returned: 'Returned', unknown: 'Unknown',
  };

  const UNKNOWN = 'unknown';

  function normalize(value) {
    if (!value) return UNKNOWN;
    const k = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
    return ALIASES[k] || UNKNOWN;
  }

  function isRiderActive(value) {
    const s = normalize(value);
    if (s === UNKNOWN) return false;
    const i = ORDER[s];
    return i >= ORDER.assigned && i < ORDER.delivered;
  }

  function isTerminal(value) {
    const s = normalize(value);
    return s === 'completed' || s === 'returned';
  }

  function canAdvance(from, to) {
    const a = normalize(from), b = normalize(to);
    if (b === UNKNOWN) return false;
    if (a === UNKNOWN) return true;
    if (b === 'returned') return !isTerminal(a);
    return ORDER[b] >= ORDER[a];
  }

  /* Resolve an order's true stage. timelineStage (orderAdvance), deliveryStatus
     (dispatch) and status can disagree; take whichever is FURTHEST along so a
     lagging field cannot drag an order backwards into the wrong column. */
  function resolveStage(order) {
    if (!order) return UNKNOWN;
    const c = [order.timelineStage, order.deliveryStatus, order.status]
      .map(normalize).filter(s => s !== UNKNOWN);
    if (!c.length) return UNKNOWN;
    return c.reduce((best, s) => (ORDER[s] > ORDER[best] ? s : best), c[0]);
  }

  /* ── UI-only helpers. These do NOT exist server-side and are excluded from
     the parity gate, because presentation is not vocabulary. ─────────────── */

  /* The merchant never sees a raw legacy value. label() is the ONLY way a stage
     should reach the DOM — that is what keeps 'driver_assigned' off the screen. */
  function label(value) {
    return LABELS[normalize(value)] || LABELS.unknown;
  }

  /* Board columns, in lifecycle order. `returned` is separated because it is an
     exception queue, not a step merchants work through. */
  function boardColumns() {
    return CANONICAL.filter(s => s !== 'returned').map(s => ({ stage: s, label: LABELS[s] }));
  }

  /* Which stages a merchant may move an order to from here. Derived from
     canAdvance so the UI cannot offer a transition the server would reject —
     the board never shows a button that fails. */
  function allowedTransitions(from) {
    const cur = normalize(from);
    if (cur === UNKNOWN) return [];
    return CANONICAL
      .filter(s => s !== cur && canAdvance(cur, s))
      .map(s => ({ stage: s, label: LABELS[s] }));
  }

  /* Stages a merchant drives directly. Beyond ready_for_pickup the rider and
     the dispatch engine own progression, so the board must not let a seller
     mark an order 'delivered' by hand. */
  const SELLER_ACTIONABLE = ['accepted', 'packing', 'ready_for_pickup'];

  function sellerActions(from) {
    return allowedTransitions(from).filter(t => SELLER_ACTIONABLE.includes(t.stage));
  }

  /* An order sitting in a stage longer than this needs attention. Used by the
     board's aging/stalled view rather than a separate threshold table. */
  const STALL_MINUTES = {
    pending: 30, accepted: 60, packing: 120, ready_for_pickup: 90,
    assigned: 45, picked_up: 30, in_transit: 180,
  };

  function isStalled(value, sinceMs) {
    const s = normalize(value);
    const limit = STALL_MINUTES[s];
    if (!limit || !sinceMs) return false;
    return (Date.now() - sinceMs) > limit * 60 * 1000;
  }

  return {
    CANONICAL, ALIASES, LABELS, UNKNOWN, SELLER_ACTIONABLE, STALL_MINUTES,
    normalize, isRiderActive, isTerminal, canAdvance, resolveStage,
    label, boardColumns, allowedTransitions, sellerActions, isStalled,
    index: (v) => ORDER[normalize(v)],
  };
})();
