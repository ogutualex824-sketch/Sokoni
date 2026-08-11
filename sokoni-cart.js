/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — Cart service  (Track 2.2A)
   ------------------------------------------------------------------------------
   Persistence:  localStorage['cart']   — UNCHANGED, deliberately
   Item shape:   whatever the writers already produce — PRESERVED, not reinterpreted

   WHAT THIS IS
   One access path to the cart. Seventeen writers and twenty-seven readers across
   thirteen files each own a copy of the read/modify/write dance, and they disagree in
   ways nobody chose. This module is where that logic lives from now on.

   WHAT THIS IS DELIBERATELY NOT
   It is not a new cart model, and it does not normalise anything. That restraint is the
   whole design. `orderItems: cart` in checkout.html sends the raw array to
   verifyIntasendPayment, which resolves `item.id || item.productId` against the product
   catalogue and `item.qty || item.quantity` for the amount check — so the item shape is a
   SERVER-FACING PAYMENT CONTRACT, not merely a UI convention. A field this service
   "tidied" would change what lands in an order.

   It is also not uid-scoped, and must not become so. Unlike the wishlist, a cart is
   filled by shoppers who have not signed in yet; stamping it with an owner would empty
   the cart of every anonymous visitor. Authenticated persistence is a separate capability
   for a later slice, added BEHIND this service rather than beside it.

   ── TWO QUANTITY MODELS, BOTH LIVE ────────────────────────────────────────────
   The cart array encodes quantity in two incompatible ways at once:

     product.js   pushes N DUPLICATE objects, no qty field   (for (i<quantity) cart.push)
     cart.js      reads a qty field on a single entry        (item.qty || 1)

   Both produce the correct MONEY — the server multiplies unit price by qty and sums, so
   three rows of qty-1 and one row of qty-3 charge the same. They differ in what a COUNT
   means, and the platform already disagrees with itself about that:

     shared-header.js:1250   cart.reduce((s,i) => s + (i.qty||1), 0)   → units
     market-actions.js:71    _loadCart().length                        → lines

   For one product added three times via product.js both read 3; via a qty field the
   header reads 3 and the card badges read 1. Picking a winner here would silently change
   badge numbers on live pages, so this service exposes BOTH — `lines()` and `units()` —
   and every migrated call site has to say which it meant. Converging them is a decision
   for a later slice, made once, in the open.

   ── THE INTERCEPTOR ───────────────────────────────────────────────────────────
   provider-wiring.js wraps localStorage.setItem to mirror cart ↔ sokoniCart, and
   security.js injects it on 288 pages. This service writes through the ordinary
   localStorage.setItem ON PURPOSE, so that bridge keeps working. Bypassing it would
   desynchronise the food hub. The interceptor comes out in 2.6, after every legitimate
   dependency on it is gone.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var KEY = 'cart';

  /* ── read ──────────────────────────────────────────────────────────────────
     Never returns [] for an unreadable cart without first preserving the raw value.
     `catch { cart = [] }` looks harmless and is not: the next mutation persists that
     empty array over the shopper's real data, deleting the cart by the act of looking
     at it. Quarantine first, so support can restore it and the bug leaves evidence.
     (This behaviour is lifted from cart.js's _readCart, which already got it right.) */
  function _read() {
    var raw;
    try { raw = localStorage.getItem(KEY); } catch (e) { return []; }
    if (raw == null || raw === '') return [];
    try {
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      throw new Error('cart was ' + typeof parsed + ', expected an array');
    } catch (e) {
      try { localStorage.setItem('cart_corrupt_' + Date.now(), raw); } catch (_) {}
      try { console.error('[SOKONI] Cart unreadable — quarantined, not overwritten: ' + e.message); } catch (_) {}
      return [];
    }
  }

  /* ── write ─────────────────────────────────────────────────────────────────
     The single persist point. Every mutation goes through here so the stored value and
     the announcement can never disagree — the failure that let a header badge show a
     count the cart page contradicted. */
  function _write(arr) {
    try {
      localStorage.setItem(KEY, JSON.stringify(arr));
    } catch (e) {
      try { console.error('[SOKONI] Could not save cart: ' + e.message); } catch (_) {}
      return false;
    }
    _emit(arr);
    return true;
  }

  function _emit(arr) {
    try {
      root.dispatchEvent(new CustomEvent('sokoni:cart-changed', {
        detail: { count: arr.length, units: units(arr) },
      }));
    } catch (e) {}
  }

  /* ── identity ──────────────────────────────────────────────────────────────
     `id || productId` is the server's own resolution order in verifyIntasendPayment;
     matching it here means the client and the payment check agree on what an item IS.
     Food rows carry an additional per-line cartId, because the same dish can legitimately
     appear twice with different notes. */
  function idOf(item)     { return String((item && (item.id || item.productId)) || ''); }
  function cartIdOf(item) { return String((item && item.cartId) || ''); }

  function qtyOf(item) {
    var q = Number(item && (item.qty != null ? item.qty : item.quantity));
    if (!isFinite(q) || q < 1) return 1;
    return Math.max(1, Math.round(q));
  }

  /* ── counts — BOTH, deliberately (see header) ── */
  function lines(arr) { return (arr || _read()).length; }
  function units(arr) {
    return (arr || _read()).reduce(function (s, i) { return s + qtyOf(i); }, 0);
  }

  /* ── no money helper, deliberately ────────────────────────────────────────
     An earlier draft exposed subtotal(). It was removed before any page adopted the
     service. The figure was honest — real cart data, and the server re-prices every line
     in verifyIntasendPayment and rejects an underpayment — but a money total on a SHARED
     service is an invitation for some call site to render it as the authoritative amount.
     Pages that need a displayed subtotal compute it where they display it, next to the
     caveat that the server decides. Do not add subtotal() back here. */

  /* ── queries ── */
  function list()  { return _read().slice(); }
  function raw()   { return _read(); }          /* the exact array checkout sends as orderItems */
  function has(id) {
    var want = String(id || '');
    return !!want && _read().some(function (i) { return idOf(i) === want; });
  }
  function find(id) {
    var want = String(id || '');
    return _read().filter(function (i) { return idOf(i) === want; });
  }

  /* ── mutations ─────────────────────────────────────────────────────────────
     add() APPENDS. It does not merge a repeat add into a qty bump, because that would
     convert one quantity model into the other and change every count that reads lines().
     A caller that wants merge semantics asks for them explicitly via {merge:true}. */
  function add(item, opts) {
    if (!item || typeof item !== 'object') return false;
    opts = opts || {};
    var times = Math.max(1, Math.round(Number(opts.times) || 1));
    var arr = _read();

    /* merge keys on cartId when the item has one, and NEVER lets a product merge land on
       a food row. Two food lines can legitimately share an id and differ only by note
       ("extra ugali" / "no ugali"); collapsing them by id would silently discard one
       shopper instruction and charge for a dish they did not order that way. cartId is
       what makes a food line unique, so it is what merge has to match on. */
    if (opts.merge) {
      var at = -1;
      var cid = cartIdOf(item);
      if (cid) {
        at = arr.findIndex(function (i) { return cartIdOf(i) === cid; });
      } else {
        var id = idOf(item);
        at = id ? arr.findIndex(function (i) { return idOf(i) === id && !cartIdOf(i); }) : -1;
      }
      if (at > -1) {
        /* Add `times × the item's own qty`, NOT `times`. Appending this item would have
           contributed exactly that many units, and merge must not change the total —
           otherwise merging a food row carrying qty:2 adds a single unit and the shopper
           is charged for one dish instead of two. Asserted as an invariant: merge and
           append produce identical unit counts. */
        arr[at] = Object.assign({}, arr[at], { qty: qtyOf(arr[at]) + (times * qtyOf(item)) });
        return _write(arr);
      }
    }

    for (var n = 0; n < times; n++) {
      /* A copy per push: product.js pushes the SAME object reference N times today, so a
         later edit to one line silently edits all of them. Copying is the conservative
         change — it cannot alter totals, and it stops one row's note or qty leaking
         into its siblings. */
      arr.push(Object.assign({}, item));
    }
    return _write(arr);
  }

  function setQty(ref, qty) {
    var arr = _read();
    var at = _indexOf(arr, ref);
    if (at < 0) return false;
    var q = Math.round(Number(qty));
    if (!isFinite(q) || q < 1) return removeAt(at);
    arr[at] = Object.assign({}, arr[at], { qty: q });
    return _write(arr);
  }

  function removeAt(index) {
    var arr = _read();
    var at = Number(index);
    if (!isFinite(at) || at < 0 || at >= arr.length) return false;
    arr.splice(at, 1);
    return _write(arr);
  }

  /* Removes ONE line, not every line sharing the id — with duplicate-row quantities,
     removing all of them would silently drop the shopper's other units. */
  function removeById(id) {
    var arr = _read();
    var want = String(id || '');
    var at = arr.findIndex(function (i) { return idOf(i) === want; });
    if (at < 0) return false;
    arr.splice(at, 1);
    return _write(arr);
  }

  function removeByCartId(cartId) {
    var arr = _read();
    var want = String(cartId || '');
    var at = arr.findIndex(function (i) { return cartIdOf(i) === want; });
    if (at < 0) return false;
    arr.splice(at, 1);
    return _write(arr);
  }

  /* Resolve a reference that may be an index, an id, or a cartId. */
  function _indexOf(arr, ref) {
    if (typeof ref === 'number') return (ref >= 0 && ref < arr.length) ? ref : -1;
    var want = String(ref || '');
    if (!want) return -1;
    var byCart = arr.findIndex(function (i) { return cartIdOf(i) === want; });
    if (byCart > -1) return byCart;
    return arr.findIndex(function (i) { return idOf(i) === want; });
  }

  /* clear() exists so the eventual checkout migration has somewhere to land. It is NOT
     called from anywhere yet: checkout.html owns cart clearing as part of the order
     lifecycle and stays closed until its own verified slice. */
  function clear() { return _write([]); }

  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    var h = function (e) { fn(e && e.detail); };
    try { root.addEventListener('sokoni:cart-changed', h); } catch (e) {}
    return function () { try { root.removeEventListener('sokoni:cart-changed', h); } catch (e) {} };
  }

  root.SokoniCart = {
    /* read */
    list: list, raw: raw, has: has, find: find,
    lines: lines, units: units,        /* no subtotal — see the note above */
    /* write */
    add: add, setQty: setQty,
    removeAt: removeAt, removeById: removeById, removeByCartId: removeByCartId,
    clear: clear,
    /* helpers a migrated call site needs to keep behaving identically */
    idOf: idOf, cartIdOf: cartIdOf, qtyOf: qtyOf,
    subscribe: subscribe,
    STORAGE_KEY: KEY,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.SokoniCart;
})(typeof window !== 'undefined' ? window : globalThis);
