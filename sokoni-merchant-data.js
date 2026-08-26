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

        /* ── Carried for display and for EDIT ────────────────────────────────
           These were dropped, and silently: the Products surface filters on
           `status`, searches `category`, and renders `image` — none of which
           survived this mapping, so the status filter matched nothing, the
           category search found nothing, and every card fell back to the 📦
           placeholder. Each of those failures looks exactly like a merchant
           with no drafts, no categories and no photos, which is why none of
           them announced itself.

           `image` is carried READ-ONLY. Attaching or replacing media is 2c;
           nothing here uploads, and the editor does not expose it. */
        category: p.category || null,
        description: p.description || '',
        status: p.status || null,
        costPrice: (typeof p.costPrice === 'number') ? p.costPrice : null,
        lowStockThreshold: (typeof p.lowStockThreshold === 'number') ? p.lowStockThreshold : null,
        image: p.image || (Array.isArray(p.images) ? p.images[0] : null) || null,
        /* The whole gallery, because slot POSITION is the Storage path and the
           media surface has to know how many slots are already taken. */
        images: Array.isArray(p.images) ? p.images.filter(Boolean) : [],
        sellerUid: p.sellerUid || null,
      };
    });
  }

  /* ══════════════════════════════════════════════════════════════════════════
     PRODUCT WRITER — the ONE place a product record is mutated
     ══════════════════════════════════════════════════════════════════════════
     Added because Products was about to gain a second write path. seller.js
     writes products by importing the Firestore SDK inline and writing the
     document itself; a native module doing the same would leave TWO writers for
     one collection, which is the pattern this whole conversion is removing.

     Both shells now call these. When seller.js is eventually retired, the write
     path does not have to be reinvented — it is already here.

     ── SCOPE ─────────────────────────────────────────────────────────────────
     Every mutation is bound to a resolved shop scope. A product carrying
     another shop's id is refused, not silently rewritten to this one.

     ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────
     · NO media. The old implementation bundled image upload into creation, so
       a product could not exist without pictures having already uploaded. That
       entanglement is why creating and uploading are separate slices; the
       writer creates the RECORD and returns, and media attaches afterwards.
     · NO productCounters write. That counter is known to drift (one shop reads
       -23 against 103 real products) and repairing it here would hide the
       defect inside an unrelated change.
     · NO subscription rules. Publication capacity is decided by the server's
       canPublishProduct, which is CONSULTED, never reimplemented.
     · NO cache authority. Firestore is the truth. A caller may cache what a
       write returned; the writer never reads a cache to decide anything.

     `db` is the injected adapter and must supply writeProduct / deleteProduct.
     Passing a read-only adapter fails loudly rather than appearing to succeed. */

  /* Deterministic per (shop, attempt). A double tap, or a retry after a dropped
     response, computes the SAME id and therefore claims the same document — so
     a repeat cannot create a second product. Mirrors idempotencyKey()'s shape
     for sales, which exists for exactly this reason. */
  function productDraftId(o) {
    var scope = o.scope, token = o.draftToken;
    if (!scope || !scope.ok) throw new Error('merchant data: a resolved shop scope is required');
    if (!token) throw new Error('merchant data: draftToken is required (one per create attempt)');
    var basis = scope.shopId + '::' + token;
    var h = 5381;
    for (var i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0;
    return 'prd_' + scope.shopId + '_' + h.toString(36);
  }

  function _requireWriter(db) {
    if (!db || typeof db.writeProduct !== 'function') {
      throw new Error('merchant data: this db adapter cannot write products');
    }
    return db;
  }

  /* The fields a product record owns. Anything else a caller passes is dropped:
     a writer that forwards arbitrary keys lets a UI invent schema. */
  function _productFields(input) {
    var p = input || {};
    var out = {};
    if (p.name !== undefined)  out.name = String(p.name || '').trim().slice(0, 200);
    if (p.price !== undefined) out.price = Number(p.price);
    /* Carried because the Inventory projection maps it to buyingPrice; without it
       every mirrored product would report a 0 cost and therefore a 100% margin. */
    if (p.costPrice !== undefined) out.costPrice = Number(p.costPrice);
    if (p.stock !== undefined) out.stock = Number(p.stock);
    if (p.sku !== undefined)   out.sku = p.sku ? String(p.sku).trim().slice(0, 64) : null;
    if (p.category !== undefined) out.category = p.category ? String(p.category).slice(0, 64) : null;
    if (p.description !== undefined) out.description = String(p.description || '').slice(0, 4000);
    if (p.status !== undefined) out.status = String(p.status || 'active');
    if (p.lowStockThreshold !== undefined) out.lowStockThreshold = Number(p.lowStockThreshold);

    /* ── SPECIFICATIONS, UNITS AND VARIANTS ───────────────────────────────
       This whitelist DROPS anything it does not name, which is why it is the right
       place for these: without an entry here, specs and variants would be silently
       discarded and the editor would appear to save them.

       SokoniProductSpecs owns the shape — one canonical model for groceries, vehicles,
       electronics and everything else, rather than a schema per category. It returns an
       ADDITIVE patch: it never writes name, price, category or the plural colors/sizes/
       weights arrays that live documents already carry.

       `stock` is the exception, and deliberately. Where a product has variants the
       product-level figure is their SUM, recomputed there rather than taken from input —
       POS reads products.stock, and two places to change one number is how a till and a
       catalogue come to disagree about a shelf.

       Absent module = specs simply not stored. It is optional data, so a missing script
       must not stop a merchant saving a product; price, stock and name are unaffected. */
    var SP = (typeof window !== 'undefined' && window.SokoniProductSpecs) ||
             (typeof globalThis !== 'undefined' && globalThis.SokoniProductSpecs) || null;
    if (SP && (p.specs !== undefined || p.variants !== undefined || p.stockUnit !== undefined)) {
      var built = SP.build({ specs: p.specs, variants: p.variants, stockUnit: p.stockUnit, stock: out.stock });
      if (!built.ok) { var se = new Error(built.problems[0]); se.validation = built.problems; throw se; }
      Object.keys(built.patch).forEach(function (k) { out[k] = built.patch[k]; });
    }
    return out;
  }

  function _validate(fields, opts) {
    var errs = [];
    var creating = !!(opts && opts.creating);
    if (creating || fields.name !== undefined) {
      if (!fields.name) errs.push('A product name is required.');
    }
    if (creating || fields.price !== undefined) {
      /* STRICTLY positive, because the live rule is strictly positive:
           validPrice(field) -> request.resource.data[field] is number && > 0
         Accepting 0 here would let the form say "saved" and then have Firestore
         refuse the write — the exact false-success shape this writer exists to
         prevent. A giveaway is modelled as a discount, not as a zero price. */
      if (!isFinite(fields.price) || fields.price <= 0) {
        errs.push('A price above zero is required.');
      }
    }
    if (fields.stock !== undefined && (!isFinite(fields.stock) || fields.stock < 0)) {
      errs.push('Stock cannot be negative.');
    }
    /* Cost may be 0 (unknown), but never negative. */
    if (fields.costPrice !== undefined && (!isFinite(fields.costPrice) || fields.costPrice < 0)) {
      errs.push('Cost price cannot be negative.');
    }
    return errs;
  }

  /* ══ PROJECTIONS ═══════════════════════════════════════════════════════════
     Creating a product is NOT one write. seller.js:1008-1071 writes the canonical
     `products/{id}` and then mirrors it into two further places:

       tenants/{uid}/inventory_products/{id}   the back-office Inventory Manager
       posProducts/{id}                        the POS checkout catalogue

     Those mirrors are why an uploaded product is sellable at the till at all. A
     native writer that wrote only the canonical record would create products that
     are invisible at POS and absent from Inventory — a silent regression against
     seller.html that no test of the canonical write would ever catch.

     Two deliberate departures from the code being replaced:

       · The projections are PURE functions, so the field mapping is certifiable
         on its own. The mapping is where mirror divergence defects live — the
         same class of defect as posRetailSales, where writer and reader disagreed
         about field names and POS sales silently vanished from reporting.
       · The old mirrors are fire-and-forget with `.catch(function(){})`. That
         turns a failed mirror into a reported success. Here each mirror's outcome
         is RETURNED, so the caller can say "created, but not yet at the till"
         instead of an unqualified success. A mirror failure still never fails the
         create — the canonical record is the merchant's revenue path and is
         already committed — but it is never hidden either. */
  var PRODUCT_MIRRORS = ['inventory', 'pos'];

  function productProjections(doc, scope) {
    /* The image the product actually has. Empty at creation — a product is valid
       without pictures — and filled once attachProductImages has real Storage
       addresses. Never a data: URI: the canonical rule rejects those outright,
       and one 195KB base64 image in a product record poisoned every search index
       batch it shipped in. */
    var img = (typeof doc.image === 'string' && doc.image.indexOf('data:') !== 0) ? doc.image : '';
    var sku = doc.sku || ('SKU-' + String(doc.id).slice(-8).toUpperCase());
    var wh  = doc.warehouseId || scope.shopId || 'main';
    var price = Number(doc.price) || 0;
    var cost  = Number(doc.costPrice) || 0;
    var stock = Number(doc.stock) || 0;
    return {
      inventory: {
        path: ['tenants', scope.sellerUid, 'inventory_products', doc.id],
        data: {
          id: doc.id, name: doc.name || '', sellingPrice: price, buyingPrice: cost,
          category: doc.category || '', stockLevel: stock,
          reorderPoint: (doc.lowStockThreshold != null ? Number(doc.lowStockThreshold) : 10),
          unit: 'pcs', imageUrl: img, description: doc.description || '',
          sku: sku, warehouseId: wh, active: true, tenantId: scope.sellerUid,
          sourceProductId: doc.id,          /* the link back to the storefront */
        },
      },
      pos: {
        path: ['posProducts', doc.id],
        data: {
          name: doc.name || '', price: price, cost: cost,
          category: doc.category || '', sku: sku, unit: 'pcs', stockLevel: stock,
          reorderPoint: (doc.lowStockThreshold != null ? Number(doc.lowStockThreshold) : 10),
          imageUrl: img, description: doc.description || '',
          sellerId: scope.sellerUid, status: 'active', tenantId: scope.sellerUid,
        },
      },
    };
  }

  /* Never throws. A mirror is a projection of a record that already exists; its
     failure is reported, not raised, and never rolls back the canonical write. */
  async function _writeMirrors(db, doc, scope) {
    var out = {};
    var proj = productProjections(doc, scope);
    for (var i = 0; i < PRODUCT_MIRRORS.length; i++) {
      var key = PRODUCT_MIRRORS[i];
      if (!db || typeof db.writeMirror !== 'function') { out[key] = { state: 'unavailable' }; continue; }
      try {
        await db.writeMirror({ path: proj[key].path, data: proj[key].data, merge: true });
        out[key] = { state: 'written' };
      } catch (e) {
        out[key] = { state: 'failed', reason: (e && e.message) || 'unknown' };
      }
    }
    return out;
  }

  /* True only when every mirror landed. The UI uses this to choose between an
     unqualified success and a qualified one — never to claim success on a guess. */
  function mirrorsComplete(mirrors) {
    if (!mirrors) return false;
    return PRODUCT_MIRRORS.every(function (k) {
      return mirrors[k] && mirrors[k].state === 'written';
    });
  }

  /**
   * createProduct({ scope, db, draftToken, product, canPublish })
   *
   * `canPublish` is the caller's invoker for the server's canPublishProduct.
   * It is CONSULTED — and a refusal means NOTHING is written. The check happens
   * strictly before the write, so a denied publish cannot leave a half-created
   * record behind.
   */
  async function createProduct(o) {
    var scope = o.scope;
    if (!scope || !scope.ok) throw new Error('merchant data: a resolved shop scope is required');
    _requireWriter(o.db);

    var fields = _productFields(o.product);
    var errs = _validate(fields, { creating: true });
    if (errs.length) { var e = new Error(errs[0]); e.validation = errs; throw e; }

    /* ── THE GATE, BEFORE ANY WRITE ────────────────────────────────────────
       Asked first, so a refusal is a refusal rather than a rollback. */
    if (typeof o.canPublish === 'function') {
      var verdict = await o.canPublish();
      var d = (verdict && verdict.data) || verdict || {};
      if (d.allowed === false) {
        var err = new Error((d.upgrade && d.upgrade.message) || 'Your plan does not allow another product.');
        err.code = 'publish-refused';
        err.upgrade = d.upgrade || null;
        err.wrote = false;                 /* asserted by the certification */
        throw err;
      }
    }

    var id = productDraftId({ scope: scope, draftToken: o.draftToken });
    var doc = Object.assign({}, fields, {
      id: id,
      shopId: scope.shopId,                /* ownership, from the scope only */
      sellerUid: scope.sellerUid,
      /* Media is NOT set here. A product exists without pictures; 2c attaches
         them afterwards and the record is valid in the meantime. */
      createdAt: (o.now || null),
    });
    if (doc.status === undefined) doc.status = 'active';

    /* create semantics: the same draftToken twice claims the same id, so a
       replay returns the existing record rather than adding a second one. */
    var res = await o.db.writeProduct({ id: id, data: doc, mode: 'create' });

    /* Mirrors run on a replay too. They are merge-writes keyed by the same id, so
       repeating one changes nothing — and a replay is exactly how a mirror that
       failed the first time gets repaired. */
    var mirrors = await _writeMirrors(o.db, doc, scope);

    return {
      id: id, product: doc, replayed: !!(res && res.replayed),
      mirrors: mirrors, complete: mirrorsComplete(mirrors),
    };
  }

  /**
   * updateProduct({ scope, db, id, patch })
   *
   * No publication gate: editing a product the merchant already holds does not
   * consume capacity. Asking canPublishProduct here would block a merchant AT
   * their limit from fixing a typo.
   */
  async function updateProduct(o) {
    var scope = o.scope;
    if (!scope || !scope.ok) throw new Error('merchant data: a resolved shop scope is required');
    _requireWriter(o.db);
    if (!o.id) throw new Error('merchant data: product id required');

    /* Ownership is verified against the STORED record, not the caller's claim. */
    var existing = o.existing || (o.db.getProduct ? await o.db.getProduct(o.id) : null);
    if (existing) assertInScope(scope, Object.assign({ id: o.id }, existing));

    var fields = _productFields(o.patch);
    if (!Object.keys(fields).length) throw new Error('merchant data: nothing to update');
    var errs = _validate(fields, { creating: false });
    if (errs.length) { var e = new Error(errs[0]); e.validation = errs; throw e; }

    /* shopId and sellerUid are never patchable — a product cannot be moved to
       another shop by an edit. */
    delete fields.shopId; delete fields.sellerUid;

    await o.db.writeProduct({ id: o.id, data: fields, mode: 'update' });
    return { id: o.id, patch: fields };
  }

  /**
   * attachProductImages({ scope, db, media, storage, id, files, existing, onProgress })
   *
   * The ONE way a product gains photographs. The order is the whole point:
   *
   *   1. ownership, against the STORED record
   *   2. upload to Storage
   *   3. only then, the canonical product record
   *   4. then the projections
   *
   * Nothing is written to the product until Storage has returned real addresses
   * for every file. A failed upload therefore cannot leave a product claiming an
   * image it does not have — the failure mode that matters most here, because a
   * merchant who is told the photo is up will not try again, and their listing
   * shows a broken image to buyers.
   *
   * Media is uploaded to a path derived from the SCOPE's sellerUid, which is
   * also what the Storage rule checks against request.auth.uid. A product the
   * merchant does not own is refused before a single byte is sent.
   */
  async function attachProductImages(o) {
    var scope = o.scope;
    if (!scope || !scope.ok) throw new Error('merchant data: a resolved shop scope is required');
    _requireWriter(o.db);
    if (!o.id) throw new Error('merchant data: product id required');
    var media = o.media;
    if (!media || typeof media.upload !== 'function') {
      throw new Error('merchant data: the media module is not loaded — photos cannot be added just now.');
    }

    /* ── 1. OWNERSHIP, before anything is uploaded ──────────────────────── */
    var existing = o.existing || (o.db.getProduct ? await o.db.getProduct(o.id) : null);
    if (!existing) throw new Error('merchant data: that product no longer exists.');
    assertInScope(scope, Object.assign({ id: o.id }, existing));

    /* ── 2. VALIDATE, then UPLOAD ───────────────────────────────────────── */
    var check = media.validateAll(o.files);
    if (!check.ok) {
      var ve = new Error((check.rejected[0] && check.rejected[0].reason) || check.reason ||
                         'That file cannot be used as a photo.');
      ve.rejected = check.rejected; ve.wrote = false;
      throw ve;
    }

    /* Appended after what the product already has, so slot indices — and
       therefore Storage paths — stay stable. Replacing slot i overwrites
       exactly one object; it never orphans another. */
    var prior = Array.isArray(existing.images) ? existing.images.slice() : [];
    var startIndex = (typeof o.replaceAt === 'number') ? o.replaceAt : prior.length;

    var result;
    try {
      result = await media.upload({
        storage: o.storage, sellerUid: scope.sellerUid, productId: o.id,
        files: check.accepted, startIndex: startIndex, onProgress: o.onProgress,
      });
    } catch (err) {
      /* NOTHING has been written to the product. Say so explicitly: the caller
         asserts on this rather than inferring it. */
      err.wrote = false;
      throw err;
    }

    /* ── 3. THE CANONICAL RECORD, with addresses that demonstrably exist ── */
    var images = prior.slice();
    result.urls.forEach(function (u, i) { images[startIndex + i] = u; });
    images = images.filter(function (u) { return !!u; });

    var patch = {
      image: images[0] || '',
      images: images,
      /* seller.js writes this third field too; keeping it means the two
         implementations describe the same product the same way. */
      imageStorageUrls: images,
    };
    await o.db.writeProduct({ id: o.id, data: patch, mode: 'update' });

    /* ── 4. THE PROJECTIONS ─────────────────────────────────────────────── */
    var doc = Object.assign({}, existing, patch, { id: o.id });
    var mirrors = await _writeMirrors(o.db, doc, scope);

    return {
      id: o.id, urls: result.urls, images: images,
      rejected: check.rejected,
      mirrors: mirrors, complete: mirrorsComplete(mirrors),
    };
  }

  /**
   * deleteProduct({ scope, db, id })
   * Ownership verified against the stored record before anything is removed.
   */
  async function deleteProduct(o) {
    var scope = o.scope;
    if (!scope || !scope.ok) throw new Error('merchant data: a resolved shop scope is required');
    if (!o.db || typeof o.db.deleteProduct !== 'function') {
      throw new Error('merchant data: this db adapter cannot delete products');
    }
    if (!o.id) throw new Error('merchant data: product id required');

    var existing = o.existing || (o.db.getProduct ? await o.db.getProduct(o.id) : null);
    if (existing) assertInScope(scope, Object.assign({ id: o.id }, existing));

    await o.db.deleteProduct({ id: o.id });
    return { id: o.id, deleted: true };
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

  /* ── LIVE PRODUCT ROWS ────────────────────────────────────────────────────
     Restored when this file gained the product writers. The lineage that added them had
     ALSO dropped this, together with the Sell surface that called it — a coherent pair.
     This branch still carries the Sell that subscribes (sokoni-merchant-sell.js live()),
     so taking the writers without this would have silently ended live product updates at
     the till: the cart would price against rows that had stopped refreshing, with no
     error anywhere. Additive, and it delegates to the db adapter exactly as before —
     no second query, no second authority. */
  function subscribeProducts(o) {
    if (!o || !o.db || typeof o.db.subscribeProducts !== 'function') return null;
    return o.db.subscribeProducts(
      productQuery(o.scope),
      function (rows) { o.onProducts(mapProducts(rows)); },
      o.onError || function () {}
    );
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
    subscribeProducts: subscribeProducts,
    /* The ONE product write path — see the block above createProduct. */
    productDraftId: productDraftId,
    createProduct: createProduct,
    updateProduct: updateProduct,
    deleteProduct: deleteProduct,
    attachProductImages: attachProductImages,
    assertInScope: assertInScope,
    productProjections: productProjections,
    mirrorsComplete: mirrorsComplete,
    PRODUCT_MIRRORS: PRODUCT_MIRRORS,
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
