/* ════════════════════════════════════════════════════════════════════════
   Availability enforcement — PURE decision logic shared by createCheckoutSession
   and its automated acceptance test. No I/O, so the exact server behavior can be
   proven deterministically (replacing the device-only Layer 5 checks).

   Canonical model (never a second one):
     shop  = shops/{sellerUid} { acceptingOrders, online, delivery, pickup }  (ABSENT = true)
     prod  = products/{id}      { status, isVisible, ... }

   INVARIANT: this is CREATION-time gating only. It decides whether a NEW checkout
   session may include an item / use a channel. It never sees or mutates existing
   orders — "unavailable for new orders" must never invalidate an existing order.
   ════════════════════════════════════════════════════════════════════════ */
'use strict';

/* Apply safe defaults: an absent field means open, so un-migrated shops behave
   exactly as before this feature existed. */
function normalizeShop(raw) {
  raw = raw || {};
  return {
    acceptingOrders: raw.acceptingOrders !== false,
    online:          raw.online          !== false,
    delivery:        raw.delivery        !== false,
    pickup:          raw.pickup          !== false,
  };
}

/* Can this product be added to a NEW checkout on availability grounds?
   (Stock/price/qty are handled separately by the caller.)
   Returns { available:boolean, reason:null|'hidden'|'archived'|'shop-closed'|'online-off' }. */
function itemAvailability(prod, shopRaw) {
  prod = prod || {};
  if (prod.isVisible === false) return { available: false, reason: 'hidden' };
  if (prod.status === 'archived') return { available: false, reason: 'archived' };
  const sh = normalizeShop(shopRaw);
  if (!sh.acceptingOrders) return { available: false, reason: 'shop-closed' };
  if (!sh.online)          return { available: false, reason: 'online-off' };
  return { available: true, reason: null };
}

/* Is the chosen fulfillment channel enabled by this shop?
   fulfillmentType: 'delivery' | 'pickup'. Returns { ok:boolean, reason:null|'delivery-off'|'pickup-off' }. */
function fulfillmentAllowed(fulfillmentType, shopRaw) {
  const sh = normalizeShop(shopRaw);
  const type = (String(fulfillmentType || 'delivery') === 'pickup') ? 'pickup' : 'delivery';
  if (type === 'delivery' && !sh.delivery) return { ok: false, reason: 'delivery-off' };
  if (type === 'pickup'   && !sh.pickup)   return { ok: false, reason: 'pickup-off' };
  return { ok: true, reason: null };
}

module.exports = { normalizeShop, itemAvailability, fulfillmentAllowed };
