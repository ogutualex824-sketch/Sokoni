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
      /* posCompleteCheckout destructures a fixed field list and spreads `metadata`
         into the sale document; `sellerUid` and `channel` are NOT in that list, so
         at top level they are read by nobody and recorded nowhere. Mirroring them
         here is what actually makes the stored sale say which workspace rang it up.
         (The server also records the caller's uid as `cashierId` from auth, so the
         seller is never taken on the client's word.) */
      metadata: {
        channel: 'merchant_pos',
        sellerUid: scope.sellerUid,
        shopId: scope.shopId,
        checkoutStartedAt: (typeof o.checkoutStartedAt === 'number') ? o.checkoutStartedAt : null,
      },
    };
  }

  /**
   * The SAME payload, flagged for the server's side-effect-free validation path.
   * posCompleteCheckout honours `dryRun:true` by pricing the cart against canonical
   * `products` and computing the stock deltas WITHOUT claiming an idempotency key,
   * writing an order, moving stock, or taking payment.
   *
   * This is how oversell is guarded BEFORE charging rather than after: a cart the
   * server would refuse is refused while the customer still has their money.
   */
  function buildPreview(o) {
    var sale = buildSale(o);
    sale.dryRun = true;
    return sale;
  }

  /**
   * Run the pre-charge check. Returns:
   *   { ok:true,  preview }                    — server would accept this cart
   *   { ok:false, preview, differences }       — price/stock disagreement, itemised
   *   { ok:false, error }                      — the check itself could not run
   *
   * A check that cannot RUN is never reported as a pass. The caller decides whether
   * to proceed; it must never silently treat an unavailable check as approval.
   */
  async function previewSale(o) {
    var payload = buildPreview(o);
    if (typeof o.callable !== 'function') throw new Error('merchant data: callable is required');
    try {
      var res = await o.callable(payload);
      var d = (res && res.data) ? res.data : res;
      if (!d || d.dryRun !== true) {
        return { ok: false, error: 'The pre-sale check did not run.', ran: false, payload: payload };
      }
      return {
        ok: d.ok === true,
        ran: true,
        preview: d,
        differences: d.differences || [],
        stockDeltas: d.stockDeltas || [],
        serverSubtotal: (typeof d.serverSubtotal === 'number') ? d.serverSubtotal : null,
      };
    } catch (e) {
      return { ok: false, ran: false, error: (e && e.message) || 'The pre-sale check could not run.' };
    }
  }

  /* ── Cart (pure, immutable) ───────────────────────────────────────────────
     Every operation returns a NEW cart. The Sell surface holds one cart in
     memory and nothing else; there is no cart document, no reservation and no
     stock effect until the server completes a sale. */

  function _qty(n) {
    var q = Math.floor(Number(n));
    return (isFinite(q) && q > 0) ? q : 0;
  }

  /** Add `qty` of a product, merging into an existing line. Refuses another shop's product. */
  function addToCart(cart, product, qty, scope) {
    if (scope) assertInScope(scope, product);
    var q = _qty(qty == null ? 1 : qty);
    if (!q) return (cart || []).slice();
    var out = (cart || []).map(function (l) { return Object.assign({}, l); });
    var hit = null;
    for (var i = 0; i < out.length; i++) if (out[i].productId === String(product.id)) { hit = out[i]; break; }
    if (hit) { hit.qty += q; return out; }
    out.push({
      productId: String(product.id),
      name: product.name || '',
      price: (typeof product.price === 'number') ? product.price : 0,
      qty: q,
      /* carried for the on-screen stock warning only — the server re-reads canonical stock */
      knownStock: (typeof product.stock === 'number') ? product.stock : null,
    });
    return out;
  }

  /** Set an exact quantity. Zero (or less) removes the line — no ghost zero-qty lines. */
  function setLineQty(cart, productId, qty) {
    var q = _qty(qty);
    if (!q) return removeLine(cart, productId);
    return (cart || []).map(function (l) {
      return l.productId === String(productId) ? Object.assign({}, l, { qty: q }) : Object.assign({}, l);
    });
  }

  function removeLine(cart, productId) {
    return (cart || []).filter(function (l) { return l.productId !== String(productId); })
      .map(function (l) { return Object.assign({}, l); });
  }

  /**
   * Lines whose quantity exceeds the stock this client last saw. ADVISORY — the
   * server re-reads canonical stock inside its transaction and is the authority.
   * A product with unknown stock produces no warning: unknown is not "zero".
   */
  function cartWarnings(cart) {
    return (cart || []).reduce(function (acc, l) {
      if (typeof l.knownStock === 'number' && l.qty > l.knownStock) {
        acc.push({ productId: l.productId, name: l.name, kind: 'over_stock', wanted: l.qty, available: l.knownStock });
      }
      return acc;
    }, []);
  }

  /* ── Search ───────────────────────────────────────────────────────────────
     Ranked so a scanned barcode lands on exactly one product: an exact
     sku/barcode match first, then name-start, then anything containing the term.
     An empty term returns the catalogue unchanged (the grid IS the default). */
  function searchProducts(products, term) {
    var t = String(term == null ? '' : term).trim().toLowerCase();
    if (!t) return (products || []).slice();
    var scored = [];
    (products || []).forEach(function (p) {
      var name = String(p.name || '').toLowerCase();
      var sku = String(p.sku || '').toLowerCase();
      var rank = -1;
      if (sku && sku === t) rank = 0;
      else if (name.indexOf(t) === 0) rank = 1;
      else if (sku && sku.indexOf(t) === 0) rank = 2;
      else if (name.indexOf(t) !== -1) rank = 3;
      if (rank >= 0) scored.push({ p: p, rank: rank });
    });
    scored.sort(function (a, b) { return a.rank - b.rank; });
    return scored.map(function (s) { return s.p; });
  }

  /** The single product a scan resolves to, or null. Never guesses between two. */
  function findByCode(products, code) {
    var t = String(code == null ? '' : code).trim().toLowerCase();
    if (!t) return null;
    var hits = (products || []).filter(function (p) { return String(p.sku || '').toLowerCase() === t; });
    return hits.length === 1 ? hits[0] : null;
  }

  /* ── Money ────────────────────────────────────────────────────────────────
     Unknown renders as an em dash, never as 0. (CLAUDE.md, UI Data Integrity.) */
  function formatKES(n) {
    if (n == null || (typeof n === 'number' && !isFinite(n))) return '—';
    var v = Number(n);
    if (!isFinite(v)) return '—';
    return 'KES ' + v.toLocaleString('en-KE', { maximumFractionDigits: 0 });
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
    buildPreview: buildPreview,
    previewSale: previewSale,
    addToCart: addToCart,
    setLineQty: setLineQty,
    removeLine: removeLine,
    cartWarnings: cartWarnings,
    searchProducts: searchProducts,
    findByCode: findByCode,
    formatKES: formatKES,
  };
}));
