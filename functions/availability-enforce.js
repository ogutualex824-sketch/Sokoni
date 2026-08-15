/* ════════════════════════════════════════════════════════════════════════
   Availability enforcement — createCheckoutSession's decision layer.

   This module used to CONTAIN the decision logic. It now DELEGATES to the
   canonical availability module (`functions/shared/availability.js`, byte-identical
   to the browser's `sokoni-availability.js`), so the server and every buyer surface
   answer "can this be bought?" from one implementation instead of five.

   Kept as a named module because createCheckoutSession, its acceptance test and
   the QA gate all import THIS path; re-pointing it here is a one-line change for
   them and preserves the exported names and return shapes exactly.

   ONE DELIBERATE BEHAVIOUR CHANGE (Slice 3). `itemAvailability` previously blocked
   `status === 'archived'` alone, so a product the merchant had removed, rejected
   or unpublished was still purchasable — while `/api/catalogue` hid it from the
   catalogue. It now rejects the whole canonical hidden-status vocabulary, which is
   the set `/api/catalogue` already used. Nothing that was buyable and correctly
   listed becomes unbuyable: an ABSENT status, `pending` and `approved` all remain
   available, because filtering on status==='active' once wrongly hid 92 of 103
   real products and must not be reintroduced.

   INVARIANT (unchanged): this is CREATION-time gating only. It decides whether a
   NEW checkout session may include an item / use a channel. It never sees or
   mutates existing orders — "unavailable for new orders" must never invalidate an
   order that already exists.
   ════════════════════════════════════════════════════════════════════════ */
'use strict';

const canonical = require('./shared/sellability');

module.exports = {
  normalizeShop:      canonical.normalizeShop,
  itemAvailability:   canonical.itemAvailability,
  fulfillmentAllowed: canonical.fulfillmentAllowed,
  /* Newly exposed so the checkout path can stop deriving stock itself. */
  availabilityOf:     canonical.availabilityOf,
  clampQty:           canonical.clampQty,
  isPubliclyListed:   canonical.isPubliclyListed,
};
