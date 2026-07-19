/* ══════════════════════════════════════════════════════════════════════════
   SOKONI — Canonical fulfilment lifecycle

   THE PROBLEM THIS SOLVES
   Fulfilment state was expressed in at least four vocabularies that did not
   agree with each other:

     firestore.rules:99   rider_assigned, rider_en_route, picked_up, in_transit
     dispatch.js          open, offered, driver_assigned, driver_accepted,
                          delivered, exhausted, suspended
     admin-os.js:450      picking_up, in_transit
     fulfilment-scan.js   assigned, accepted, picking_up, in_transit

   That is not cosmetic. dispatch.js writes `driver_assigned`; fulfilment-scan
   tested for `assigned`; so a rider on a genuinely active delivery was judged
   INACTIVE and refused the customer's address. The scan authorisation boundary
   was reading a vocabulary nobody writes. Found by auditing the values rather
   than trusting either side.

   THE APPROACH — normalise, do not rewrite
   No migration of stored data. Existing documents keep whatever value they
   already carry, and every consumer normalises on read. That means:
     - no backfill, so no window where half the orders are migrated
     - dispatch.js keeps writing what it writes; nothing needs redeploying in
       lockstep
     - a value nobody anticipated degrades to UNKNOWN rather than being
       silently treated as a terminal or active state

   New writes should use CANONICAL. Old values keep resolving through ALIASES
   until they age out, at which point the alias table can shrink.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';

/* The canonical lifecycle, in order. */
const CANONICAL = [
  'pending',           /* order placed, not yet acknowledged by the merchant */
  'accepted',          /* merchant acknowledged                              */
  'packing',           /* being picked and packed                            */
  'ready_for_pickup',  /* packed, awaiting a rider or collection             */
  'assigned',          /* a rider has the job                                */
  'picked_up',         /* rider has the package                              */
  'in_transit',        /* on the way to the customer                         */
  'delivered',         /* handed over, verification captured                 */
  'completed',         /* settled and closed                                 */
  'returned',          /* came back to the merchant                          */
];

const ORDER = CANONICAL.reduce((m, s, i) => (m[s] = i, m), {});

/* Every value observed anywhere in the codebase, mapped to canonical.
   Keep additions here rather than teaching consumers new spellings. */
const ALIASES = {
  /* pending */
  pending: 'pending', open: 'pending', pending_payment: 'pending',
  awaiting_confirmation: 'pending', order_placed: 'pending', queued: 'pending',
  /* accepted */
  accepted: 'accepted', confirmed: 'accepted', paid: 'accepted',
  processing: 'accepted', driver_accepted: 'assigned',
  /* packing */
  packing: 'packing', picking: 'packing', being_packed: 'packing',
  /* ready */
  ready_for_pickup: 'ready_for_pickup', ready: 'ready_for_pickup',
  awaiting_pickup: 'ready_for_pickup', offered: 'ready_for_pickup',
  /* assigned — dispatch.js writes driver_assigned; rules say rider_assigned */
  assigned: 'assigned', driver_assigned: 'assigned', rider_assigned: 'assigned',
  /* picked up */
  picked_up: 'picked_up', picking_up: 'picked_up', collected: 'picked_up',
  /* in transit */
  in_transit: 'in_transit', out_for_delivery: 'in_transit', shipped: 'in_transit',
  rider_en_route: 'in_transit', arriving: 'in_transit', en_route: 'in_transit',
  /* delivered */
  delivered: 'delivered',
  /* completed */
  completed: 'completed', complete: 'completed', settled: 'completed',
  /* returned / terminal-negative */
  returned: 'returned', return_initiated: 'returned', refunded: 'returned',
  cancelled: 'returned', canceled: 'returned', failed: 'returned',
  exhausted: 'returned', suspended: 'returned',
};

const UNKNOWN = 'unknown';

/* Normalise any observed value to canonical. Unrecognised input returns
   UNKNOWN — never a guess, and never silently 'pending'. */
function normalize(value) {
  if (!value) return UNKNOWN;
  const k = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return ALIASES[k] || UNKNOWN;
}

/* A rider legitimately needs the customer's address only between taking the job
   and completing it. Outside this window fulfilment-scan withholds the address.

   Derived from the canonical order rather than hand-listed, so adding a stage
   between `assigned` and `delivered` cannot accidentally drop out of the active
   window — the failure mode that caused the original defect. */
function isRiderActive(value) {
  const s = normalize(value);
  if (s === UNKNOWN) return false;                 /* fail closed */
  const i = ORDER[s];
  return i >= ORDER.assigned && i < ORDER.delivered;
}

/* Terminal states accept no further progression. */
function isTerminal(value) {
  const s = normalize(value);
  return s === 'completed' || s === 'returned';
}

/* Guard against out-of-order writes (in_transit -> packing). Equal is allowed
   so a repeated write is idempotent rather than an error. */
function canAdvance(from, to) {
  const a = normalize(from), b = normalize(to);
  if (b === UNKNOWN) return false;
  if (a === UNKNOWN) return true;                  /* unknown legacy -> allow */
  if (b === 'returned') return !isTerminal(a);     /* returns can interrupt */
  return ORDER[b] >= ORDER[a];
}

/* Merchant-facing labels for the seller board. */
const LABELS = {
  pending: 'New order', accepted: 'Accepted', packing: 'Packing',
  ready_for_pickup: 'Ready for pickup', assigned: 'Rider assigned',
  picked_up: 'Picked up', in_transit: 'In transit', delivered: 'Delivered',
  completed: 'Completed', returned: 'Returned', unknown: 'Unknown',
};

module.exports = {
  CANONICAL, ALIASES, LABELS, UNKNOWN,
  normalize, isRiderActive, isTerminal, canAdvance,
  index: (v) => ORDER[normalize(v)],
};
