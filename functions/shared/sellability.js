/* ============================================================================
   SOKONI — Sellability (canonical)
   ============================================================================
   ONE answer to two questions every product surface asks:

     1. May this product appear in a public catalogue at all?   isPubliclyListed()
     2. Can it be bought right now, and how do we say so?       availabilityOf()

   ── NOT TO BE CONFUSED WITH sokoni-availability.js ─────────────────────────
   `sokoni-availability.js` / `window.AvailabilityService` is the MERCHANT-side
   shop/product availability authority: it reads shops/{sellerUid}, derives its own
   states ('available' | 'low' | 'out' | 'unavailable') against `minStockLevel`, and
   WRITES shop state through the server. merchant.html is its consumer.

   This module is the BUYER/CHECKOUT-side sellability decision. It is pure, writes
   nothing, and uses `lowStockThreshold`. The two are deliberately separate files with
   separate globals so neither can shadow the other. Converging them is real work —
   they disagree on the threshold field and on the state vocabulary — and is
   explicitly OUT of Slice 3's locked scope. Recorded here so it is not forgotten.

   ── Why this exists ────────────────────────────────────────────────────────
   The audit for Slice 3 found FIVE competing definitions of "is this product
   sellable/visible" on the buyer/checkout path, each written independently (a SIXTH,
   AvailabilityService above, sits on the merchant path):

     /api/catalogue (index.js)      HIDDEN = deleted|removed|hidden|draft|archived|
                                    banned|suspended|paused|inactive|rejected
                                    + isDeleted|deleted + visible|isVisible===false
     listenProducts (sokoni-db.js)  NO status filter at all — returns everything
     availability-enforce.js        isVisible===false, status==='archived' only
     darajaSTKPush (index.js)       status && status !== 'active'
     admin.html                     removed|unpublished|deleted

   Two of those are supposed to be the SAME authority. `/api/catalogue` hides a
   `status:'removed'` product; the Firestore listener returns it. Since 20dfcd2
   made an authoritative response able to REMOVE products, the grid now contains
   or omits that product depending on which authority happened to answer first —
   two "authoritative" sources contradicting each other on the same document.

   Worse, checkout blocked only `archived`, so a product the merchant had
   `removed`, `rejected` or `unpublished` was still purchasable.

   This is the same defect class as two inventories or four delivery prices:
   five implementations of a predicate is five answers to one question.

   ── What this module is ────────────────────────────────────────────────────
   PURE. No Firestore, no network, no writes, no clock. Callable identically in
   a browser and in a Cloud Function, testable without an emulator, and
   impossible to fork accidentally.

   It introduces NO new inventory mechanism. It reads the fields the platform
   already writes — `stock`, `reservedStock`, `outOfStock`, `status`, `isVisible`,
   `lowStockThreshold` — and the shop state `availability-enforce.js` already
   defined. Reservation semantics (`available = max(stock - reserved, 0)`) and the
   low-stock default of 5 are taken from the existing POS convention (pos-hq.js,
   pos-db.js, pos-scanner.js, pos.js), not invented here.

   ── Canonical model ────────────────────────────────────────────────────────
     shop = shops/{sellerUid} { acceptingOrders, online, delivery, pickup }  ABSENT = open
     prod = products/{id}     { status, isVisible, stock, reservedStock,
                                outOfStock, lowStockThreshold, price }

     available = max(stock - reserved, 0)

   UNMETERED PRODUCTS. A product with no numeric `stock` field is not "zero", it
   is untracked — most legacy SOKONI products have no stock field at all, and
   treating absent as 0 would take the entire legacy catalogue off sale. Absent
   stock therefore means unmetered and always purchasable, which is exactly what
   the pre-charge guard in darajaSTKPush already does.

   STATE PRECEDENCE. Listing beats shop state beats stock: a hidden product in an
   open shop is `unavailable`, not `out_of_stock`, because restocking it would not
   make it buyable. Each state carries the reason, so a surface can explain itself
   instead of showing one generic string.
   ============================================================================ */
(function (root) {
  'use strict';

  /* Bumped when the semantics change (state vocabulary, precedence, the
     available formula) so a rendered decision is reproducible. */
  var VERSION = '1.0.0';

  /* The ONE hidden-status vocabulary. This is `/api/catalogue`'s existing HIDDEN
     set plus `unpublished`, which admin.html already treats as removed and which
     a merchant expects to take a product off sale. Anything not listed here —
     including an ABSENT status and the legacy `pending`/`approved` — is listable,
     because filtering on status==='active' once wrongly hid 92 of 103 real
     products and must not be reintroduced. */
  var HIDDEN_STATUSES = [
    'deleted', 'removed', 'hidden', 'draft', 'archived',
    'banned', 'suspended', 'paused', 'inactive', 'rejected', 'unpublished',
  ];

  /* Matches pos-db.js, pos-scanner.js, pos.js and logistics-plus.js. */
  var DEFAULT_LOW_STOCK = 5;

  var STATES = ['in_stock', 'low_stock', 'out_of_stock', 'unavailable'];

  function norm(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

  function finiteNum(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  /* An absent field means OPEN, so un-migrated shops behave exactly as they did
     before shop state existed. Unchanged from availability-enforce.js. */
  function normalizeShop(raw) {
    raw = raw || {};
    return {
      acceptingOrders: raw.acceptingOrders !== false,
      online:          raw.online          !== false,
      delivery:        raw.delivery        !== false,
      pickup:          raw.pickup          !== false,
    };
  }

  /* May this product appear in a public catalogue? The single predicate that
     `/api/catalogue`, the realtime listener and every buyer surface must share,
     so the same document cannot be listed by one authority and hidden by another. */
  function isPubliclyListed(p) {
    p = p || {};
    if (HIDDEN_STATUSES.indexOf(norm(p.status)) !== -1) return false;
    if (p.isDeleted === true || p.deleted === true)     return false;
    if (p.visible === false || p.isVisible === false)   return false;
    return true;
  }

  /* Why a product is not listable — for logs and merchant-facing explanation.
     Returns null when it IS listable. */
  function listingBlockReason(p) {
    p = p || {};
    if (HIDDEN_STATUSES.indexOf(norm(p.status)) !== -1) return 'status:' + norm(p.status);
    if (p.isDeleted === true || p.deleted === true)     return 'deleted';
    if (p.visible === false || p.isVisible === false)   return 'hidden';
    return null;
  }

  /* Stock accounting. `reservedStock` is the field pos-hq.js already writes;
     `reserved` is accepted as an alias so a future canonical field needs no
     migration here. Neither is invented by this module. */
  function stockOf(p) {
    p = p || {};
    var stock    = finiteNum(p.stock);
    var reserved = finiteNum(p.reservedStock);
    if (reserved === null) reserved = finiteNum(p.reserved);
    if (reserved === null || reserved < 0) reserved = 0;

    if (stock === null) {
      /* Unmetered: untracked, not zero. */
      return { metered: false, stock: null, reserved: reserved, available: null };
    }
    return {
      metered:   true,
      stock:     stock,
      reserved:  reserved,
      available: Math.max(stock - reserved, 0),
    };
  }

  function lowStockThresholdOf(p) {
    var t = finiteNum((p || {}).lowStockThreshold);
    return (t === null || t < 0) ? DEFAULT_LOW_STOCK : t;
  }

  /* THE canonical availability decision.
     Returns { state, reason, metered, stock, reserved, available, threshold,
               listed, sellable, version }.

     `sellable` is the one boolean a checkout/cart guard should branch on;
     `state` is what a surface renders. They cannot disagree, because both come
     from here. */
  function availabilityOf(product, shopRaw) {
    var p  = product || {};
    var st = stockOf(p);
    var out = {
      version:   VERSION,
      metered:   st.metered,
      stock:     st.stock,
      reserved:  st.reserved,
      available: st.available,
      threshold: lowStockThresholdOf(p),
      listed:    true,
      sellable:  false,
      state:     'unavailable',
      reason:    null,
    };

    /* 1. Listing. A delisted product is unavailable regardless of stock —
          restocking it would not make it buyable. */
    var block = listingBlockReason(p);
    if (block) {
      out.listed = false;
      out.state  = 'unavailable';
      out.reason = block;
      return out;
    }

    /* 2. Shop state. The product is fine; the shop is not open for new orders. */
    var sh = normalizeShop(shopRaw);
    if (!sh.acceptingOrders) { out.state = 'unavailable'; out.reason = 'shop-closed'; return out; }
    if (!sh.online)          { out.state = 'unavailable'; out.reason = 'online-off';  return out; }

    /* 3. Stock. The explicit flag wins over the number: a merchant who marked an
          item out of stock has said so directly. */
    if (p.outOfStock === true) { out.state = 'out_of_stock'; out.reason = 'flagged'; return out; }
    if (st.metered && st.available <= 0) {
      out.state  = 'out_of_stock';
      out.reason = st.reserved > 0 ? 'all-reserved' : 'depleted';
      return out;
    }

    out.sellable = true;
    if (st.metered && st.available <= out.threshold) {
      out.state = 'low_stock'; out.reason = 'below-threshold';
    } else {
      out.state = 'in_stock';
    }
    return out;
  }

  /* How many units of this product may a NEW order actually take? null = unmetered
     (no ceiling). The server clamps against this; the UI uses it to cap a picker
     instead of letting a buyer choose a quantity that will be silently reduced. */
  function maxOrderableQty(product, shopRaw) {
    var a = availabilityOf(product, shopRaw);
    if (!a.sellable) return 0;
    return a.metered ? a.available : null;
  }

  /* Clamp a requested quantity to what is actually available.
     Returns { qty, adjusted, requested, available }. The SERVER WINS: a request
     for 5 against 3 available yields 3, flagged as adjusted so the buyer can be
     told before paying rather than after. */
  function clampQty(requested, product, shopRaw) {
    var req = Math.floor(Number(requested) || 0);
    if (req < 1) req = 1;
    var max = maxOrderableQty(product, shopRaw);
    if (max === null) return { qty: req, adjusted: false, requested: req, available: null };
    var qty = Math.max(0, Math.min(req, max));
    return { qty: qty, adjusted: qty !== req, requested: req, available: max };
  }

  /* ── Backward-compatible surface for functions/availability-enforce.js ──────
     Same names, same return shapes, so every existing caller and its acceptance
     tests keep working. The only behavioural change is deliberate and is the
     point of this slice: `itemAvailability` now rejects the whole hidden-status
     vocabulary instead of `archived` alone, closing the hole that let a removed,
     rejected or unpublished product be purchased. */
  function itemAvailability(prod, shopRaw) {
    var a = availabilityOf(prod, shopRaw);
    if (a.state !== 'unavailable') return { available: true, reason: null };
    /* Reason names preserved for existing log/test expectations. */
    var r = a.reason || 'hidden';
    if (r === 'shop-closed' || r === 'online-off') return { available: false, reason: r };
    if (r === 'status:archived')                   return { available: false, reason: 'archived' };
    if (r === 'hidden')                            return { available: false, reason: 'hidden' };
    return { available: false, reason: r };
  }

  function fulfillmentAllowed(fulfillmentType, shopRaw) {
    var sh = normalizeShop(shopRaw);
    var type = (String(fulfillmentType || 'delivery') === 'pickup') ? 'pickup' : 'delivery';
    if (type === 'delivery' && !sh.delivery) return { ok: false, reason: 'delivery-off' };
    if (type === 'pickup'   && !sh.pickup)   return { ok: false, reason: 'pickup-off' };
    return { ok: true, reason: null };
  }

  var API = {
    VERSION:            VERSION,
    STATES:             STATES,
    HIDDEN_STATUSES:    HIDDEN_STATUSES,
    DEFAULT_LOW_STOCK:  DEFAULT_LOW_STOCK,
    normalizeShop:      normalizeShop,
    isPubliclyListed:   isPubliclyListed,
    listingBlockReason: listingBlockReason,
    stockOf:            stockOf,
    lowStockThresholdOf: lowStockThresholdOf,
    availabilityOf:     availabilityOf,
    maxOrderableQty:    maxOrderableQty,
    clampQty:           clampQty,
    itemAvailability:   itemAvailability,
    fulfillmentAllowed: fulfillmentAllowed,
  };

  root.SokoniSellability = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;

})(typeof window !== 'undefined' ? window : globalThis);
