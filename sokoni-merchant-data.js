/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Merchant Data — the canonical layer under Sell and Inventory (2D-1)

   merchant.html's Sell and Inventory surfaces read and write through here, and
   through nothing else. The point of the module is what it CANNOT do:

     • it has no stock-writing function at all — not one. Inventory movement is
       the server's, via posCompleteCheckout, which deducts canonical
       `products.stock` inside a transaction with `inventoryVersion`.
     • it never reads business state from localStorage. seller.js keeps 28
       device-local keys; every figure here comes from `products` / `orders` /
       the POS callables, or it is reported as unknown.

   ── Why a module and not more page script ───────────────────────────────────
   The census (docs/MERCHANT_CAPABILITY_MAP.md) found the eleven borrowed
   seller screens are localStorage-backed, so consolidation is a REBUILD of the
   data layer, not a port of the UI. This is that data layer: one scope
   resolver, one product read, one sale submission — shared by Sell, Inventory
   and (later) Orders/Receipts so the three cannot drift into three models.

   ── Identity: two identifiers, never one ────────────────────────────────────
   `sellerUid` is the ACCOUNT. `shopId` is the SHOP. Products are scoped by
   `products.shopId` (the same field analytics-engine and merchant-success
   query), so a merchant with two shops sees two catalogues. `shopId` is NEVER
   defaulted to the uid: a shop id that is silently the account id makes the
   single-shop assumption permanent and quietly mixes two merchants' stock the
   day a second shop appears.

   ── The sale path ───────────────────────────────────────────────────────────
        cart (client, in memory)
            ↓  buildSale()          deterministic idempotencyKey
        posCompleteCheckout         server: transaction, canonical products.stock,
            ↓                       posIdempotency claim, payments, loyalty
        canonical result            → receipt, orders, analytics
   An abandoned cart touches nothing: no reservation, no decrement, no document.
   Stock moves only when the server says a sale completed.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantData = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var PRODUCTS = 'products';
  var SCOPE_FIELD = 'shopId';           /* canonical product scope */
  var SALE_CALLABLE = 'posCompleteCheckout';

  /* ── Scope ────────────────────────────────────────────────────────────────
     Resolve the merchant identity from authenticated state ONLY. `ok` is false
     when there is no shop yet — callers render "no shop yet", never a catalogue
     scoped to a guess. */
  function resolveScope(o) {
    o = o || {};
    var uid = o.uid || null;
    var shopId = o.activeShopId != null && o.activeShopId !== '' ? String(o.activeShopId) : null;
    if (!uid) return { ok: false, reason: 'not_signed_in', sellerUid: null, shopId: null };
    /* A branch placeholder is not a shop. Accepting 'main' here is what made a
       correctly-provisioned merchant look like a broken account. */
    if (shopId && isPlaceholderShopId(shopId)) {
      return { ok: false, reason: 'placeholder_shop_id', sellerUid: String(uid), shopId: null, rejected: shopId };
    }
    if (!shopId) {
      /* Deliberately NOT `shopId = uid`. See the header. */
      return { ok: false, reason: 'no_active_shop', sellerUid: String(uid), shopId: null };
    }
    return { ok: true, sellerUid: String(uid), shopId: shopId, source: o.source || 'active_shop' };
  }

  /* Shop ids that are not shop ids. `SokoniBranch.init()` synthesises
     `{id:'main'}` when its device-local branch list is empty, and merchant.html
     assigned that straight to `SokoniShell.activeShopId` — so on any fresh
     device the workspace asked for `products where shopId == 'main'` and
     `shops/main`, got nothing, and looked like a broken account. A branch
     placeholder must never be mistaken for a canonical shop. */
  var NOT_A_SHOP_ID = ['main', 'default', 'branch', 'null', 'undefined', ''];
  function isPlaceholderShopId(id) {
    return NOT_A_SHOP_ID.indexOf(String(id == null ? '' : id).trim().toLowerCase()) !== -1;
  }

  /* ── Canonical shop resolution ────────────────────────────────────────────
     The shop is a FACT IN FIRESTORE, not a device preference. Order:

       1. users/{uid}.activeShopId  — an explicit choice, verified to exist
       2. shops/{uid}               — the marketplace shop a merchant owns
       3. sellers/{uid}             — registry-only merchants (pre-shops)

     Every candidate is CONFIRMED by reading the document; a shop id is only
     returned when its document exists. That is why this is not "falling back to
     the uid": the uid is used to LOOK UP a shop, and the shop's own document id
     is what gets returned. If no document exists, the answer is null — the
     workspace then says "no shop yet" instead of querying a fiction.

     `db` adapter: { getDoc(collection, id) -> data|null }. */
  async function resolveShopId(o) {
    var uid = o && o.uid;
    var db = o && o.db;
    if (!uid) return { shopId: null, source: 'not_signed_in' };
    if (!db) throw new Error('merchant data: a db adapter is required to resolve the shop');

    var user = await db.getDoc('users', String(uid));
    var declared = user && user.activeShopId ? String(user.activeShopId) : null;
    if (declared && !isPlaceholderShopId(declared)) {
      var declaredShop = await db.getDoc('shops', declared);
      if (declaredShop) return { shopId: declared, source: 'users.activeShopId', shop: declaredShop };
    }

    var own = await db.getDoc('shops', String(uid));
    if (own) return { shopId: String(uid), source: 'shops/{uid}', shop: own };

    var seller = await db.getDoc('sellers', String(uid));
    if (seller) return { shopId: String(uid), source: 'sellers/{uid}', shop: seller };

    return { shopId: null, source: 'no_shop' };
  }

  /* ── Products ─────────────────────────────────────────────────────────────
     One query descriptor, so Sell and Inventory cannot diverge on what "this
     shop's products" means. `db` is an injected adapter: { queryProducts(spec) }. */
  function productQuery(scope) {
    if (!scope || !scope.ok) throw new Error('merchant data: a resolved shop scope is required');
    return { collection: PRODUCTS, where: [[SCOPE_FIELD, '==', scope.shopId]] };
  }

  async function listProducts(o) {
    var scope = o.scope;
    var rows = await o.db.queryProducts(productQuery(scope));
    return (rows || []).map(function (p) {
      var stock = (typeof p.stock === 'number') ? p.stock : null;
      return {
        id: p.id,
        name: p.name || p.title || '',
        price: (typeof p.price === 'number') ? p.price : null,
        /* null, never 0 — an unknown stock rendered as 0 is a fabricated
           figure, and 0 is a real, different answer. */
        stock: stock,
        sku: p.sku || p.barcode || null,
        shopId: p.shopId || null,
        lowStock: (stock != null && typeof p.lowStockThreshold === 'number')
          ? stock <= p.lowStockThreshold : (stock != null ? stock <= 5 : null),
        inventoryVersion: (typeof p.inventoryVersion === 'number') ? p.inventoryVersion : null,
      };
    });
  }

  /* Only products belonging to this shop may enter a cart. A cart line from
     another shop would be sold against this shop's till. */
  function assertInScope(scope, product) {
    if (!scope || !scope.ok) throw new Error('merchant data: no shop scope');
    if (!product || !product.id) throw new Error('merchant data: product required');
    if (product.shopId && String(product.shopId) !== scope.shopId) {
      throw new Error('merchant data: product ' + product.id + ' belongs to shop ' +
        product.shopId + ', not ' + scope.shopId);
    }
    return true;
  }

  /* ── Sale ─────────────────────────────────────────────────────────────────
     Deterministic idempotency key: the same cart submitted twice (a double tap,
     a retry after a dropped response) claims the same posIdempotency document
     and completes once. Derived from shop + cart contents + the caller's sale
     token, never from a clock, so a retry produces the SAME key. */
  function idempotencyKey(o) {
    var scope = o.scope, cart = o.cart || [], token = o.saleToken;
    if (!token) throw new Error('merchant data: saleToken is required (one per sale attempt)');
    var lines = cart.map(function (l) { return String(l.productId) + 'x' + Number(l.qty || 0); }).sort().join('|');
    var basis = scope.shopId + '::' + token + '::' + lines;
    /* Small, stable, dependency-free hash — this is a collision-resistant key
       for one shop's tills, not a security primitive. */
    var h = 5381;
    for (var i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0;
    return 'pos_' + scope.shopId + '_' + token + '_' + h.toString(36);
  }

  function cartTotals(cart) {
    var subtotal = 0, units = 0;
    (cart || []).forEach(function (l) {
      var qty = Number(l.qty) || 0, price = Number(l.price) || 0;
      subtotal += qty * price; units += qty;
    });
    return { subtotal: subtotal, units: units, lines: (cart || []).length };
  }

  /**
   * The exact payload posCompleteCheckout receives. PURE — asserting on it in a
   * test is asserting on what the server would be asked to do.
   */
  function buildSale(o) {
    var scope = o.scope;
    if (!scope || !scope.ok) throw new Error('merchant data: a resolved shop scope is required');
    var cart = o.cart || [];
    if (!cart.length) throw new Error('merchant data: cannot complete an empty sale');

    var totals = cartTotals(cart);
    var payments = (o.payments || []).map(function (p) {
      return { method: String(p.method || 'cash'), amount: Number(p.amount) || 0, ref: p.ref || null };
    });

    return {
      idempotencyKey: idempotencyKey({ scope: scope, cart: cart, saleToken: o.saleToken }),
      merchantId: scope.shopId,          /* the SHOP owns the till, not the account */
      branchId: o.branchId || 'default',
      shiftId: o.shiftId || null,
      sellerUid: scope.sellerUid,        /* who rang it up */
      items: cart.map(function (l) {
        return {
          productId: String(l.productId),
          qty: Number(l.qty) || 0,
          unitPrice: Number(l.price) || 0,
          name: l.name || '',
        };
      }),
      payments: payments,
      customer: o.customer || null,
      subtotal: totals.subtotal,
      discountTotal: Number(o.discountTotal) || 0,
      taxTotal: Number(o.taxTotal) || 0,
      grandTotal: totals.subtotal - (Number(o.discountTotal) || 0) + (Number(o.taxTotal) || 0),
      channel: 'merchant_pos',
    };
  }

  /**
   * Complete the sale through the SERVER authority. This module performs no
   * Firestore write of its own — the callable owns the transaction, the
   * idempotency claim and the canonical stock deduction.
   *
   * Returns { ok, sale } or { ok:false, error } — never a success shape over a
   * failed call, and never a local stock adjustment as a "fallback".
   */
  async function completeSale(o) {
    var payload = buildSale(o);
    if (typeof o.callable !== 'function') throw new Error('merchant data: callable is required');
    try {
      var res = await o.callable(payload);
      var data = (res && res.data) ? res.data : res;
      if (!data || data.ok === false) {
        return { ok: false, error: (data && data.error) || 'The sale was not completed.', payload: payload };
      }
      return { ok: true, sale: data, idempotencyKey: payload.idempotencyKey };
    } catch (e) {
      /* A failed sale leaves stock untouched precisely BECAUSE nothing local
         was written. The caller shows a retry; the same saleToken reproduces
         the same key, so a retry cannot double-sell. */
      return { ok: false, error: (e && e.message) || 'The sale could not be completed.', payload: payload };
    }
  }

  return {
    PRODUCTS: PRODUCTS,
    SCOPE_FIELD: SCOPE_FIELD,
    SALE_CALLABLE: SALE_CALLABLE,
    resolveScope: resolveScope,
    resolveShopId: resolveShopId,
    isPlaceholderShopId: isPlaceholderShopId,
    productQuery: productQuery,
    listProducts: listProducts,
    assertInScope: assertInScope,
    idempotencyKey: idempotencyKey,
    cartTotals: cartTotals,
    buildSale: buildSale,
    completeSale: completeSale,
  };
}));
