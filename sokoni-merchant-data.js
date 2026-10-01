/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Merchant Data — the canonical layer under Sell and Inventory (2D-1)

   merchant.html's Sell and Inventory surfaces read and write through here, and
   through nothing else. The point of the module is what it CANNOT do:

     • it writes no stock into the product document — not one field. Product metadata and
       shelf counts are different authorities. Inventory movement is the server's:
       posCompleteCheckout deducts canonical `products.stock` inside a transaction with
       `inventoryVersion`, and merchantAdjustStock is the correction path.

       createProduct DOES accept an `openingStock`, and routes it through merchantAdjustStock
       as the product's first movement — so it is transactional, floored, versioned and filed
       in stockMovements like every other change. It is never a field in the metadata write.
       updateProduct REFUSES a stock patch outright rather than dropping it silently, and
       (owner decision 2026-10-01) it refuses a per-variant quantity too: a variants patch
       may rename, reprice or re-SKU rows, but each stored row keeps the quantity it had.

       This paragraph previously claimed the module had "no stock-writing function at all —
       not one", while `_productFields` allowlisted `stock` and the specs path added it again
       from variant totals. The prose was wrong and the code was authoritative. Corrected only
       after the behaviour was fixed and executed against — never the other way round.
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
    return mapProducts(rows);
  }

  /* THE ONE ROW MAPPING, shared by the one-shot read (listProducts) and the live read
     (subscribeProducts). Extracted 2026-10-01: the live line's subscribeProducts called
     `mapProducts`, a name that was never defined anywhere — a ReferenceError waiting for the
     first adapter that implemented subscribeProducts. Defining it HERE, as the mapping
     listProducts already used, means both reads yield identical rows by construction. */
  function mapProducts(rows) {
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
        /* buyer price offers are opt-in per product (owner rule, T2b 2026-09-29) */
        acceptOffers: p.acceptOffers === true,

        /* ── FROM 4f67b4b (ported verbatim 2026-09-29, universal catalogue U4) — carried for display and for EDIT ──
           These were dropped, and silently: the Products surface filters on `status`, searches `category`, and
           renders `image` — none of which survived this mapping, so the status filter matched nothing, the category
           search found nothing, and every card fell back to the 📦 placeholder. Each of those failures looks exactly
           like a merchant with no drafts, no categories and no photos, which is why none of them announced itself.
           `image` is carried READ-ONLY; attaching media is attachProductImages. */
        category: p.category || null,
        description: p.description || '',
        status: p.status || null,
        costPrice: (typeof p.costPrice === 'number') ? p.costPrice : null,
        lowStockThreshold: (typeof p.lowStockThreshold === 'number') ? p.lowStockThreshold : null,
        image: p.image || (Array.isArray(p.images) ? p.images[0] : null) || null,
        /* The whole gallery, because slot POSITION is the Storage path and the media surface has to know how many
           slots are already taken. */
        images: Array.isArray(p.images) ? p.images.filter(Boolean) : [],
        sellerUid: p.sellerUid || null,

        /* ── U4 additions (2026-09-29): what THIS branch's newer editor (Listing Studio, d0443b8's allowlist, the
           99-category sections) reads when a merchant opens an existing listing. Without them an edit opened blank —
           the KEBS number, the food licence, the variants and the listing type all looked unset. Passed as stored;
           the writer's allowlist still decides what may be written back. The lifecycle fields let the list separate
           live, draft and archived. */
        isVisible: p.isVisible !== false,
        statusBeforeArchive: p.statusBeforeArchive || null,
        listingType: p.listingType || null,
        title: p.title || null,
        specs: p.specs || null, attributes: p.attributes || null, variants: Array.isArray(p.variants) ? p.variants : null,
        stockUnit: p.stockUnit || null, tags: Array.isArray(p.tags) ? p.tags : null,
        barcode: p.barcode || null, brand: p.brand || null, condition: p.condition || null, location: p.location || null,
        kebsCert: p.kebsCert || null, foodLicence: p.foodLicence || null, ownership: p.ownership || null,
        verificationStatus: p.verificationStatus || null, warranty: p.warranty || null,
        /* Price tiers (2026-10-01): Online = price, Shelf = shopPrice, Wholesale = wholesalePrice. An absent tier
           maps to null ("not sold at this price"), never 0 — the editor shows it empty and never writes it back.
           The SHELF price is PRIVATE (owner, 2026-10-01): it is never read from the public products/{id} doc —
           withShelf() fills it from the merchant-only posProducts record (listShelfPrices). */
        shopPrice: null,
        wholesalePrice: (typeof p.wholesalePrice === 'number') ? p.wholesalePrice : null,
        minWholesaleQty: (typeof p.minWholesaleQty === 'number') ? p.minWholesaleQty : null,
        deliveryCost: (typeof p.deliveryCost === 'number') ? p.deliveryCost : null,
        digitalUrl: p.digitalUrl || null, digitalLicense: p.digitalLicense || null, video: p.video || null,
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
    /* FROM 4f67b4b (ported 2026-09-29, U1): stock is DELIBERATELY ABSENT from product metadata. It is inventory
       authority, and it moves only through merchantAdjustStock — a server transaction that floors at zero and
       writes stock + updatedAt + inventoryVersion together. Allowing it here let the Products form write an
       untransacted shelf count with no movement record. Opening stock at CREATE is still supported, routed
       through that same server authority — see openingStockOf() and createProduct's opening stock. */
    if (p.sku !== undefined)   out.sku = p.sku ? String(p.sku).trim().slice(0, 64) : null;
    if (p.category !== undefined) out.category = p.category ? String(p.category).slice(0, 64) : null;
    if (p.description !== undefined) out.description = String(p.description || '').slice(0, 4000);
    if (p.status !== undefined) out.status = String(p.status || 'active');
    if (p.lowStockThreshold !== undefined) out.lowStockThreshold = Number(p.lowStockThreshold);

    /* ── THE EIGHTEEN FIELDS THE FORM COLLECTED AND THIS WRITER DISCARDED ─────
       Measured 2026-09-22: the editor's FORM_KEYS plus its nested groups produce
       twenty-seven fields; this whitelist carried nine. The other eighteen were
       captured, normalised, assembled into `out` by fieldsFromForm — and dropped here
       without a word. A control that renders, validates and then evaporates is worse
       than an absent one: the merchant believes the KEBS number is on the product.

       IT WAS ALSO A REGRESSION. seller.js:813-815 writes `kebsCert`, `location` and
       `deliveryCost` straight into the product document. Merchant V2's Products route
       moved onto this writer, so those three stopped persisting for anyone using it —
       a live loss of compliance data, not a cosmetic gap.

       NORMALISATION FOLLOWS THE RULES ALREADY SET ABOVE, not new ones:
         · empty string is ABSENT for money, never 0 — a blank delivery cost must not
           become free delivery, the same reason a blank costPrice must not become a
           100% margin;
         · strings are trimmed and bounded, like name/sku/description;
         · objects are passed whole, because the parts of a policy travel together —
           sending a warranty's duration without its remedies is the defect the editor
           already fixed on its side;
         · an explicitly emptied object is passed through as-is rather than skipped, so
           a merchant can REMOVE a record they entered by mistake. The editor's comment
           states that contract; honouring it is this writer's half. */

    /* Bounded free text. */
    ['brand', 'condition', 'location', 'kebsCert', 'digitalUrl', 'digitalLicense', 'listingType']
      .forEach(function (k) {
        if (p[k] !== undefined) out[k] = p[k] ? String(p[k]).trim().slice(0, 300) : null;
      });
    /* Tags: an array or a comma string, normalised to a bounded array of non-empty tags. */
    if (p.tags !== undefined) {
      var t = Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(',');
      out.tags = t.map(function (x) { return String(x || '').trim().slice(0, 40); })
                  .filter(Boolean).slice(0, 30);
    }
    /* Money and counts. Empty is ABSENT — never zero. `shopPrice` (the in-store tier, 2026-10-01) joins
       `wholesalePrice` here: an empty tier means "not sold at this price" and is never stored as 0. Removing a
       stored tier on an edit is NOT expressed through this allowlist — updateProduct turns an explicit
       null / '' into a field delete (see clearedTiers). */
    ['deliveryCost', 'shopPrice', 'wholesalePrice', 'minWholesaleQty'].forEach(function (k) {
      if (p[k] === undefined) return;
      if (p[k] === '' || p[k] === null) return;
      out[k] = Number(p[k]);
    });
    /* Structured records, passed whole. `specs`, `stockUnit` and `variants` are NOT in this
       list: they go through SokoniProductSpecs.build() below (owner decision 2026-10-01 —
       the live line's validation is kept; c4 had passed them whole and unvalidated). */
    ['attributes', 'ownership', 'foodLicence', 'warranty']
      .forEach(function (k) {
        if (p[k] !== undefined) out[k] = p[k];
      });

    /* ── SPECIFICATIONS, UNITS AND VARIANTS (restored from the live line, 6d524dd) ──────
       SokoniProductSpecs owns the shape — one canonical model for groceries, vehicles,
       electronics and everything else, rather than a schema per category. It returns an
       ADDITIVE patch: it never writes name, price, category or the plural colors/sizes/
       weights arrays that live documents already carry. It REFUSES duplicate variant
       combinations, an unnamed variant, and a unit it does not recognise — a refusal here
       fails the whole save with the model's own words, rather than storing a malformed record.

       Absent module = specs simply not stored. It is optional data, so a missing script
       must not stop a merchant saving a product; price, stock and name are unaffected. It is
       also never stored UNVALIDATED: no model, no specs/variants/stockUnit write. */
    var SP = (typeof window !== 'undefined' && window.SokoniProductSpecs) ||
             (typeof globalThis !== 'undefined' && globalThis.SokoniProductSpecs) || null;
    if (SP && (p.specs !== undefined || p.variants !== undefined || p.stockUnit !== undefined)) {
      var built = SP.build({ specs: p.specs, variants: p.variants, stockUnit: p.stockUnit, stock: out.stock });
      if (!built.ok) { var se = new Error(built.problems[0]); se.validation = built.problems; throw se; }
      /* built.patch carries `stock` when variants are present (totalStock over the variant rows).
         That is a SECOND way stock reached the metadata write, and removing it from the
         allowlist above would not have closed it. Variant totals are still a shelf count, so
         they take the same route as any other opening quantity. */
      Object.keys(built.patch).forEach(function (k) { if (k !== 'stock') out[k] = built.patch[k]; });
    }

    /* ── FROM 4f67b4b (the 99-category upload form), ported 2026-09-29 (universal catalogue U1) ─────────────
       Layered ON this writer (d0443b8's allowlist stays the structure); these are the parts 4f67b4b had that
       this branch did not: */
    var TX = (typeof window !== 'undefined' && window.SokoniProductTaxonomy) ||
             (typeof globalThis !== 'undefined' && globalThis.SokoniProductTaxonomy) || null;
    var _str = function (v, n) { return v === null ? null : String(v || '').trim().slice(0, n); };
    /* DIGITAL / SERVICE are DERIVED from the category, never taken from the caller — the taxonomy owns that
       answer (a listing flagged digital in a physical category is one the checkout would try to deliver). */
    if (p.category !== undefined && TX && out.category) {
      var kind = TX.kindOf(out.category);
      out.isDigital = kind === 'digital';
      out.isService = kind === 'service';
    }
    /* FOOD HANDLING — the six legacy keys, normalised; an all-empty record is REMOVED (null). */
    var FOOD_KEYS = ['permit', 'kebs', 'kmc', 'halal', 'storage', 'slaughter'];
    if (p.foodLicence !== undefined) {
      var fl = p.foodLicence || {}, fout = {}, anyFood = false;
      FOOD_KEYS.forEach(function (k) { var v = _str(fl[k], 120); fout[k] = v || null; if (v) anyFood = true; });
      out.foodLicence = anyFood ? fout : null;
    }
    /* OWNERSHIP — a merchant may DECLARE; only a reviewer may approve. `status` and `verificationStatus` are
       CLAMPED to pending: verificationStatus === 'approved' is what puts "✅ Verified Owner" on a card, and passing
       the object whole (as above) let a crafted write self-issue that badge. */
    if (p.ownership !== undefined) {
      var ow = p.ownership || {};
      var serial = _str(ow.serial, 120), source = _str(ow.source, 64);
      out.ownership = (!serial && !source) ? null
        : { serial: serial, source: source, declared: ow.declared === true, submittedAt: Date.now(), status: 'pending' };
      out.verificationStatus = out.ownership ? 'pending' : 'none';
    }

    return out;
  }

  /* FROM 4f67b4b (ported verbatim 2026-09-29, U1).
     The opening quantity a create is asking for, from either a plain stock figure or the sum of
     variant rows. Returns null when none was asked for — null, never 0: an unknown shelf count
     rendered as zero is a fabricated fact, and "no opening stock given" is not "there are none".
     Whole numbers only, non-negative, and bounded by the server's own MAX_DELTA so a value the
     authority will refuse is rejected here rather than after the product already exists. */
  var MAX_OPENING = 1000000;
  function openingStockOf(input) {
    var p = input || {};
    var raw = p.stock;
    var SPm = (typeof window !== 'undefined' && window.SokoniProductSpecs) ||
              (typeof globalThis !== 'undefined' && globalThis.SokoniProductSpecs) || null;
    if (SPm && Array.isArray(p.variants) && p.variants.length && typeof SPm.totalStock === 'function') {
      raw = SPm.totalStock(p.variants, p.stock);
    }
    if (raw === undefined || raw === null || raw === '') return null;
    var n = Number(raw);
    if (!isFinite(n)) throw new Error('Opening stock must be a number.');
    if (!Number.isInteger(n)) throw new Error('Opening stock must be a whole number.');
    if (n < 0) throw new Error('Opening stock cannot be negative.');
    if (n > MAX_OPENING) throw new Error('Opening stock is implausibly large.');
    return n;
  }

  /* Universal catalogue U3 (2026-09-29): an EXPLICIT listing type must be one this kind of business may list
     (sokoni-catalogue-capabilities.js, keyed on the shop's C1 category). Enforced only when the caller states the
     business category (`businessCategory` present — null means unclassified, goods only); inferred types are never
     refused, so an unclassified shop's ordinary listings keep working exactly as today. CLIENT-side: the server-side
     equivalent belongs to the product rules (stage 3).
     BROWSER-ENFORCED ONLY (owner decision 2026-10-01): no function and no Firestore rule checks these limits, so a
     forged client write bypasses them. This is a guide for honest clients, NOT an enforcement boundary. The server
     check is queued as its own functions unit; do not describe this as enforcement until that unit is deployed. */
  function _assertCatalogueType(o, fields) {
    if (!o || !Object.prototype.hasOwnProperty.call(o, 'businessCategory')) return;
    if (!fields || !fields.listingType) return;
    var CCm = (typeof window !== 'undefined' && window.SokoniCatalogueCapabilities) ||
              (typeof globalThis !== 'undefined' && globalThis.SokoniCatalogueCapabilities) || null;
    if (!CCm) return;
    var TXc = (typeof window !== 'undefined' && window.SokoniProductTaxonomy) ||
              (typeof globalThis !== 'undefined' && globalThis.SokoniProductTaxonomy) || null;
    var v = CCm.check(o.businessCategory || null, { listingType: fields.listingType, category: fields.category }, TXc);
    if (!v.ok) {
      var e = new Error(v.errors[0].message);
      e.code = v.errors[0].code; e.validation = v.errors.map(function (x) { return x.message; });
      throw e;
    }
  }

  /* ── PRICE TIERS (2026-10-01) ─────────────────────────────────────────────────────────────────────────
     There was no upper bound on a product price anywhere on this line (the rule's validPrice is `> 0` only).
     MAX_PRICE is introduced with the tiers so a mistyped extra zero is caught here, not at a till. It is
     generous on purpose: property and vehicles are listed through this same writer. */
  var MAX_PRICE = 1000000000;                      /* KES 1,000,000,000 */
  var TIER_LABELS = [{ key: 'shopPrice', label: 'Shop' }, { key: 'wholesalePrice', label: 'Wholesale' }];
  var PRICE_TIER_KEYS = ['price', 'shopPrice', 'wholesalePrice'];
  /* What an EDIT may remove with a field delete. `price` is not here: the Online price is required, and an
     emptied one is refused by _validate rather than deleted. */
  var CLEARABLE_FIELDS = ['shopPrice', 'wholesalePrice', 'minWholesaleQty'];
  /* The tiers the till mirrors carry beyond `price` (absent stays absent). */
  var MIRRORED_TIERS = ['shopPrice', 'wholesalePrice'];

  /* The optional fields a patch asks to REMOVE: present in the patch as null or ''. On create the same values
     simply mean "absent" (the allowlist drops them); only an edit turns them into a delete. */
  function clearedFields(patch) {
    var p = patch || {};
    return CLEARABLE_FIELDS.filter(function (k) {
      return Object.prototype.hasOwnProperty.call(p, k) && (p[k] === null || p[k] === '');
    });
  }

  /* The tiers as they will stand after an edit: stored, overridden by the patch, minus what is cleared. */
  function effectiveTiers(existing, fields, cleared) {
    var out = {};
    PRICE_TIER_KEYS.forEach(function (k) {
      if (existing && typeof existing[k] === 'number') out[k] = existing[k];
      if (fields && fields[k] !== undefined) out[k] = fields[k];
      if (cleared && cleared.indexOf(k) > -1) delete out[k];
    });
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
    /* THE NEWLY CARRIED MONEY FIELDS GET THE SAME TREATMENT AS costPrice, because
       carrying a field without validating it is only half of not discarding it. A
       negative delivery cost or wholesale price would otherwise reach the document and
       be discovered by whatever arithmetic consumes it. */
    if (fields.deliveryCost !== undefined && (!isFinite(fields.deliveryCost) || fields.deliveryCost < 0)) {
      errs.push('Delivery cost cannot be negative.');
    }
    if (fields.minWholesaleQty !== undefined &&
        (!isFinite(fields.minWholesaleQty) || fields.minWholesaleQty < 0)) {
      errs.push('Minimum wholesale quantity cannot be negative.');
    }

    /* ── PRICE TIERS (owner model, 2026-10-01) ───────────────────────────────────────────────────────
       Three independent prices on one product, no new pricing object:
         ONLINE    = price           marketplace, cart and checkout read it (required, unchanged)
         SHOP      = shopPrice       the in-store price (optional)
         WHOLESALE = wholesalePrice  the bulk price (optional)
       An absent tier is NOT AVAILABLE and is stored absent — never 0. Each SET tier is a finite number,
       > 0 and <= MAX_PRICE. Ordering: wholesale < online (strict), shop <= online, and when both are set
       wholesale <= shop — so wholesale <= shop <= online.

       `opts.tiers` is the EFFECTIVE set (on an edit: the stored tiers, overridden by the patch, minus any tier
       being cleared); ordering is checked over it so an edit to one tier cannot leave the others out of order.
       Without it the fields themselves are the effective set (create).

       minWholesaleQty is informational and NO LONGER required with a wholesale price — the old "both or
       neither" coupling is dropped (owner decision 2026-10-01). It is still refused when negative or not a
       whole number of 2 or more ("bulk, minimum one" is the ordinary price wearing a badge). */
    if (fields.price !== undefined && isFinite(fields.price) && fields.price > MAX_PRICE) {
      errs.push('The Online price is too large (KES ' + MAX_PRICE.toLocaleString('en-KE') + ' at most).');
    }
    TIER_LABELS.forEach(function (t) {
      var v = fields[t.key];
      if (v === undefined || v === null) return;
      if (!isFinite(v) || v <= 0) errs.push('The ' + t.label + ' price must be above zero.');
      else if (v > MAX_PRICE) errs.push('The ' + t.label + ' price is too large (KES ' + MAX_PRICE.toLocaleString('en-KE') + ' at most).');
    });
    var tiers = (opts && opts.tiers) || fields;
    var okTier = function (v) { return typeof v === 'number' && isFinite(v) && v > 0; };
    var on = tiers.price, sh = tiers.shopPrice, wh = tiers.wholesalePrice;
    if (okTier(wh) && okTier(on) && !(wh < on)) {
      errs.push('The Wholesale price must be lower than the Online price — otherwise it is not a bulk deal.');
    }
    if (okTier(sh) && okTier(on) && sh > on) {
      errs.push('The Shop price cannot be higher than the Online price.');
    }
    if (okTier(wh) && okTier(sh) && wh > sh) {
      errs.push('The Wholesale price cannot be higher than the Shop price.');
    }

    /* ── FROM 4f67b4b, ported 2026-09-29 (U1): the deal / download / permit rules ──────────────────────── */
    var hasWq = fields.minWholesaleQty !== undefined && fields.minWholesaleQty !== null;
    if (hasWq && isFinite(fields.minWholesaleQty) && fields.minWholesaleQty >= 0
        && (!Number.isInteger(Number(fields.minWholesaleQty)) || fields.minWholesaleQty < 2)) {
      errs.push('The minimum bulk quantity must be a whole number of 2 or more.');
    }
    /* DIGITAL: a download that is not an https link cannot be fetched from an https page. */
    if (fields.isDigital === true && fields.digitalUrl !== undefined) {
      if (!fields.digitalUrl) errs.push('A digital product needs a download link.');
      else if (!/^https:\/\//i.test(fields.digitalUrl)) errs.push('The download link must start with https://');
    }
    /* FOOD: the county permit is the one food record legally required to trade — asked only of food categories. */
    var TXv = (typeof window !== 'undefined' && window.SokoniProductTaxonomy) ||
              (typeof globalThis !== 'undefined' && globalThis.SokoniProductTaxonomy) || null;
    if (TXv && fields.category && TXv.needsFoodLicence(fields.category)) {
      if (!fields.foodLicence || !fields.foodLicence.permit) {
        errs.push('Food and agricultural products need a county food business permit number.');
      }
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

  /* FROM 4f67b4b (ported 2026-09-29, U1): THE SHELF COUNT THE PROJECTIONS CARRY. doc.stock no longer exists
     (stock left the metadata write), so the mirrors take `established` — what the authority actually put on the
     shelf: the opening quantity when the adjustment succeeded, 0 when there was none or it failed. */
  function productProjections(doc, scope, established) {
    /* FROM 4f67b4b / 911ec98 (ported 2026-09-29, U1): the mirrors carry the product's real photo — never an inline
       data: URL — so the till and the Inventory Manager show what the storefront shows. */
    var img = (typeof doc.image === 'string' && doc.image.indexOf('data:') !== 0) ? doc.image : '';
    var sku = doc.sku || ('SKU-' + String(doc.id).slice(-8).toUpperCase());
    var wh  = doc.warehouseId || scope.shopId || 'main';
    var price = Number(doc.price) || 0;
    var cost  = Number(doc.costPrice) || 0;
    var stock = (established !== undefined && established !== null)
      ? Number(established) || 0
      : Number(doc.stock) || 0;
    var proj = {
      inventory: {
        path: ['tenants', scope.sellerUid, 'inventory_products', doc.id],
        data: {
          id: doc.id, name: doc.name || '', sellingPrice: price, buyingPrice: cost,
          category: doc.category || '', stockLevel: stock,
          reorderPoint: (doc.lowStockThreshold != null ? Number(doc.lowStockThreshold) : 10),
          unit: 'pcs', imageUrl: img, description: doc.description || '',
          sku: sku, warehouseId: wh, active: doc.status !== 'archived', tenantId: scope.sellerUid,
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
          /* U4 (2026-09-29): the till copy FOLLOWS the lifecycle — an archived product is not sellable at the POS */
          sellerId: scope.sellerUid, status: doc.status === 'archived' ? 'archived' : 'active', tenantId: scope.sellerUid,
        },
      },
    };
    /* PRICE TIERS (2026-10-01): the till and the Inventory Manager carry the Shop and Wholesale prices under the
       SAME field names as the product. Absent stays ABSENT — a tier the product does not have is omitted, never
       written as 0 or null, so a reader cannot mistake "not sold at this price" for "free". Which tier the till
       charges is the POS session's slice; this only makes the figures available there. */
    MIRRORED_TIERS.forEach(function (k) {
      var v = doc[k];
      if (typeof v === 'number' && isFinite(v) && v > 0) { proj.inventory.data[k] = v; proj.pos.data[k] = v; }
    });
    return proj;
  }

  /* The mirror patch an EDIT writes when it sets or clears a Shop / Wholesale tier: only those fields, as an
     UPDATE of the existing mirror documents (never a create — a missing mirror stays missing and is reported),
     with a field delete for each cleared tier. The Online price is deliberately not part of it: an edit to
     `price` did not reach the mirrors before this change and still does not (unchanged, stated in CHANGELOG). */
  function tierMirrorPatch(fields, cleared) {
    var data = {}, del = [];
    MIRRORED_TIERS.forEach(function (k) {
      if (cleared && cleared.indexOf(k) > -1) del.push(k);
      else if (fields && typeof fields[k] === 'number') data[k] = fields[k];
    });
    return (Object.keys(data).length || del.length) ? { data: data, deleteFields: del } : null;
  }

  /* Never throws, like _writeMirrors. */
  async function _writeTierMirrors(db, id, scope, tp) {
    var paths = { inventory: ['tenants', scope.sellerUid, 'inventory_products', id], pos: ['posProducts', id] };
    var out = {};
    for (var i = 0; i < PRODUCT_MIRRORS.length; i++) {
      var key = PRODUCT_MIRRORS[i];
      if (!db || typeof db.writeMirror !== 'function') { out[key] = { state: 'unavailable' }; continue; }
      if (tp.deleteFields.length && db.supportsFieldDelete !== true) {
        out[key] = { state: 'failed', reason: 'field-delete-unsupported' }; continue;
      }
      try {
        var req = { path: paths[key], data: tp.data, merge: true, mode: 'update' };
        if (tp.deleteFields.length) req.deleteFields = tp.deleteFields.slice();
        await db.writeMirror(req);
        out[key] = { state: 'written' };
      } catch (e) {
        out[key] = { state: 'failed', reason: (e && e.message) || 'unknown' };
      }
    }
    return out;
  }

  /* Never throws. A mirror is a projection of a record that already exists; its
     failure is reported, not raised, and never rolls back the canonical write. */
  async function _writeMirrors(db, doc, scope, established) {
    var out = {};
    var proj = productProjections(doc, scope, established);
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
   * createProduct({ scope, db, draftToken, product, canPublish, adjustStock })
   *
   * `adjustStock` is the caller's invoker for merchantAdjustStock. Opening stock is NOT written
   * into the product document — it is the product's first inventory movement, so it goes through
   * the same server authority every later movement uses.
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

    /* FROM 4f67b4b (U1): computed BEFORE anything is written, so an invalid opening quantity refuses the whole
       create rather than leaving a product behind that nobody asked for. */
    var opening = openingStockOf(o.product);

    var fields = _productFields(o.product);
    _assertCatalogueType(o, fields);
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

    /* ── FROM 4f67b4b (ported verbatim 2026-09-29, U1): OPENING STOCK — through the server authority ──────
       The product document is created WITHOUT a stock field, so until this lands the shelf count is unknown
       rather than zero. merchantAdjustStock is the only path that floors at zero, bumps inventoryVersion and
       files a stockMovements row, so an opening quantity is simply the first movement.
       adjustmentId is DETERMINISTIC on the product id: a retried create claims the same adjustment id and the
       server's idempotency returns the original outcome instead of stacking a second opening quantity.
       A failure here does NOT fail the create — the caller is told exactly that (openingStock.ok === false). */
    var stockResult = null;
    if (opening !== null && opening > 0) {
      if (typeof o.adjustStock !== 'function') {
        stockResult = { ok: false, reason: 'no-inventory-adapter', opening: opening };
      } else {
        try {
          await o.adjustStock({
            productId: id, shopId: scope.shopId,
            adjustmentId: 'open_' + id,
            delta: opening, reason: 'restock',
            note: 'Opening stock at product creation',
          });
          stockResult = { ok: true, opening: opening };
        } catch (err) {
          stockResult = { ok: false, opening: opening,
                          reason: (err && (err.message || err.code)) || 'adjust-failed' };
        }
      }
    } else if (opening === 0) {
      /* An explicit zero is a real statement about the shelf, but merchantAdjustStock refuses
         a zero delta by design. Nothing to move, and nothing to invent. */
      stockResult = { ok: true, opening: 0, noop: true };
    }

    /* Mirrors run on a replay too. They are merge-writes keyed by the same id, so
       repeating one changes nothing — and a replay is exactly how a mirror that
       failed the first time gets repaired. They run AFTER the opening adjustment and carry what it established. */
    var mirrors = await _writeMirrors(o.db, doc, scope,
      (stockResult && stockResult.ok) ? stockResult.opening : 0);

    return {
      id: id, product: doc, replayed: !!(res && res.replayed),
      mirrors: mirrors, complete: mirrorsComplete(mirrors),
      openingStock: stockResult,
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

    /* REFUSED, not dropped. Silently ignoring a stock edit is worse than rejecting it: the
       merchant types a figure, sees "Changes saved.", and the shelf count never moves. A
       fabricated success is the one outcome this module must never produce. */
    if (o.patch && o.patch.stock !== undefined) {
      var sErr = new Error('Stock is changed in Inventory, not here.');
      sErr.code = 'stock-not-editable';
      throw sErr;
    }

    /* ── VARIANT QUANTITIES: Inventory is the only stock writer (owner decision 2026-10-01) ──
       The live line refused ANY variants patch; c4 refused none and merged per-variant
       quantities through a plain setDoc(merge) — no transaction, no version, no movement row.
       The owner kept live's RULE and scoped it to what it protects: a variants patch may change
       a row's options, price, SKU or barcode, but it may not carry a quantity. Each stored row
       keeps the quantity it had (matched by its id); a row added by an edit starts at 0, which
       is a true statement — nothing has been received for it yet. Rows without an id get a
       fresh one here, never a positional one, so a new row can never inherit another row's
       quantity by landing on its index. */
    var variantPatch = null;
    if (o.patch && Array.isArray(o.patch.variants) && o.patch.variants.length) {
      var carriesQty = o.patch.variants.some(function (v) {
        return v && v.stock !== undefined && v.stock !== null && v.stock !== '';
      });
      if (carriesQty) {
        var vErr = new Error('Variant quantities are changed in Inventory, not here.');
        vErr.code = 'stock-not-editable';          /* the live code: the UI already routes it to Inventory */
        vErr.reason = 'variant-quantity';
        throw vErr;
      }
      if (!existing) {
        var uErr = new Error('merchant data: the stored product is needed to keep its variant quantities.');
        uErr.code = 'variant-stock-unverifiable';
        throw uErr;
      }
      var storedQty = {};
      (Array.isArray(existing.variants) ? existing.variants : []).forEach(function (v, i) {
        if (!v) return;
        var sid = (v.id != null && String(v.id).trim()) ? String(v.id).trim() : ('v' + (i + 1));
        storedQty[sid] = Math.max(0, Number(v.stock) || 0);
      });
      var used = {}, seq = 0;
      Object.keys(storedQty).forEach(function (k) { used[k] = 1; });
      var claimed = {};
      var rows = o.patch.variants.map(function (v) {
        var row = Object.assign({}, v || {});
        var rid = (row.id != null && String(row.id).trim()) ? String(row.id).trim() : '';
        /* an id is honoured only for a stored row, and only once */
        if (!rid || !Object.prototype.hasOwnProperty.call(storedQty, rid) || claimed[rid]) {
          do { seq++; rid = 'v' + (Object.keys(storedQty).length + seq); } while (used[rid]);
        }
        claimed[rid] = 1; used[rid] = 1;
        row.id = rid;
        return row;
      });
      variantPatch = Object.assign({}, o.patch, { variants: rows });
    }

    var fields = _productFields(variantPatch || o.patch);
    if (Array.isArray(fields.variants)) {
      var keep = {};
      (Array.isArray(existing && existing.variants) ? existing.variants : []).forEach(function (v, i) {
        if (!v) return;
        var sid = (v.id != null && String(v.id).trim()) ? String(v.id).trim() : ('v' + (i + 1));
        keep[sid] = Math.max(0, Number(v.stock) || 0);
      });
      fields.variants = fields.variants.map(function (v) {
        return Object.assign({}, v, { stock: Object.prototype.hasOwnProperty.call(keep, v.id) ? keep[v.id] : 0 });
      });
    }
    /* PRICE TIERS (2026-10-01): an optional tier sent as null / '' on an EDIT is a REMOVAL ("not sold at this
       price any more"), written as a field delete — never as 0 and never as a stored null. A tier the patch does
       not mention is not touched at all. */
    var cleared = clearedFields(o.patch);
    cleared.forEach(function (k) { delete fields[k]; });
    if (!Object.keys(fields).length && !cleared.length) throw new Error('merchant data: nothing to update');
    _assertCatalogueType(o, fields);
    /* Ordering is checked over the tiers as they will STAND, so raising the Wholesale price above a stored
       Online price (or lowering Online below a stored Shop price) is refused. Only when the edit touches a
       tier: a legacy record already out of order must not block an unrelated edit such as a typo in the name. */
    var touchesTier = PRICE_TIER_KEYS.some(function (k) { return fields[k] !== undefined || cleared.indexOf(k) > -1; });
    var errs = _validate(fields, { creating: false,
      tiers: touchesTier ? effectiveTiers(existing, fields, cleared) : {} });
    if (errs.length) { var e = new Error(errs[0]); e.validation = errs; throw e; }

    /* shopId and sellerUid are never patchable — a product cannot be moved to
       another shop by an edit. */
    delete fields.shopId; delete fields.sellerUid;

    /* A delete the adapter cannot express would be a removal that silently did not happen — refused instead. */
    if (cleared.length && o.db.supportsFieldDelete !== true) {
      var dErr = new Error('This price cannot be removed just now — please try again.');
      dErr.code = 'field-delete-unsupported';
      throw dErr;
    }
    var req = { id: o.id, data: fields, mode: 'update' };
    if (cleared.length) req.deleteFields = cleared.slice();
    await o.db.writeProduct(req);

    var out = { id: o.id, patch: fields };
    if (cleared.length) out.cleared = cleared.slice();
    /* The till and the Inventory Manager follow a Shop / Wholesale change. Reported, never raised. */
    var tp = tierMirrorPatch(fields, cleared);
    if (tp) {
      out.mirrors = await _writeTierMirrors(o.db, o.id, scope, tp);
      out.complete = mirrorsComplete(out.mirrors);
    }
    return out;
  }

  /* ══ LIFECYCLE: ARCHIVE / RESTORE (universal catalogue U4, 2026-09-29) ═════════════════════════════════════
     "Remove" used to HARD-DELETE products/{id} through the adapter's deleteDoc and leave the Inventory and POS
     mirrors behind — a till could still sell a product the shop no longer had, and every review, rating and order
     line lost its referent. Owner invariant (B9.17): product existence is changed ONLY by an explicit lifecycle act,
     and that act TOMBSTONES — the canonical shape is sokoni-sellability.js's tombstonePatch() (ported from 332d458):
     { status:'archived', isVisible:false }. availability-enforce already refuses 'archived' at checkout.

     Archived products leave the shop, the till (the POS mirror follows) and discovery, stay in the merchant's catalogue
     (the Archived filter) with their history, and can be RESTORED to the status they had. */
  function _tombstone() {
    var SL = (typeof window !== 'undefined' && window.SokoniSellability) ||
             (typeof globalThis !== 'undefined' && globalThis.SokoniSellability) || null;
    return SL && typeof SL.tombstonePatch === 'function' ? SL.tombstonePatch() : { status: 'archived', isVisible: false };
  }

  async function _ownedExisting(o) {
    var scope = o.scope;
    if (!scope || !scope.ok) throw new Error('merchant data: a resolved shop scope is required');
    _requireWriter(o.db);
    if (!o.id) throw new Error('merchant data: product id required');
    /* the STORED record, and it must exist — an unknown id is refused, never silently "archived" */
    var existing = o.existing || (o.db.getProduct ? await o.db.getProduct(o.id) : null);
    if (!existing) { var nf = new Error('merchant data: that product no longer exists.'); nf.code = 'not-found'; throw nf; }
    assertInScope(scope, Object.assign({ id: o.id }, existing));
    return existing;
  }

  /** archiveProduct({ scope, db, id }) — delist: off sale, off the till, out of discovery; history kept. */
  async function archiveProduct(o) {
    var existing = await _ownedExisting(o);
    if (existing.status === 'archived') return { id: o.id, archived: true, already: true };
    var patch = Object.assign(_tombstone(), {
      /* restore returns it to what it was (a draft stays a draft) */
      statusBeforeArchive: existing.status && existing.status !== 'archived' ? existing.status : 'active',
      archivedAt: o.now || Date.now(),
    });
    await o.db.writeProduct({ id: o.id, data: patch, mode: 'update' });
    var doc = Object.assign({}, existing, patch, { id: o.id });
    var mirrors = await _writeMirrors(o.db, doc, o.scope);
    return { id: o.id, archived: true, mirrors: mirrors, complete: mirrorsComplete(mirrors) };
  }

  /** restoreProduct({ scope, db, id }) — back to the status it had before it was archived. */
  async function restoreProduct(o) {
    var existing = await _ownedExisting(o);
    if (existing.status !== 'archived') return { id: o.id, restored: false, reason: 'not-archived' };
    var back = existing.statusBeforeArchive && existing.statusBeforeArchive !== 'archived' ? existing.statusBeforeArchive : 'active';
    var patch = { status: back, isVisible: back === 'active', archivedAt: null, statusBeforeArchive: null };
    await o.db.writeProduct({ id: o.id, data: patch, mode: 'update' });
    var doc = Object.assign({}, existing, patch, { id: o.id });
    var mirrors = await _writeMirrors(o.db, doc, o.scope);
    return { id: o.id, restored: true, status: back, mirrors: mirrors, complete: mirrorsComplete(mirrors) };
  }

  /**
   * deleteProduct({ scope, db, id }) — KEPT so any caller gets the safe behaviour: it ARCHIVES. Merchant-v2 never
   * physically deletes a product (owner invariant; 332d458). A permanent removal, where an authority permits one,
   * belongs to the server, not to a client writer.
   */
  async function deleteProduct(o) {
    var r = await archiveProduct(o);
    return Object.assign({ deleted: false, method: 'tombstone' }, r);
  }

  /* ── FROM 4f67b4b (911ec98 / 511836c lineage), ported VERBATIM 2026-09-29 (universal catalogue U1). The
     products module (:1530) calls it; this branch had the media module, the putImage adapter and every helper
     below, but not this function — so adding a photo threw. ── */
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
    /* The PRICE TIER is part of the sale (2026-10-01): 2 × Coffee at SHELF is not the sale 2 × Coffee at ONLINE, so a
       retry after a tier change must not resolve to the earlier attempt. Appended only for a non-online tier, so every
       online-only cart keeps exactly the key it had before (an attempt persisted across a deploy still resumes). */
    var lines = cart.map(function (l) {
      var t = (l.priceTier && l.priceTier !== 'online') ? '@' + String(l.priceTier) : '';
      return String(l.productId) + 'x' + Number(l.qty || 0) + t;
    }).sort().join('|');
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
          /* the server resolves this tier's price from products/{id}; unitPrice must match within 1 KES */
          priceTier: l.priceTier || 'online',
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

  /* ── The PRIVATE shelf price (owner, 2026-10-01: "make it truly private") ──────────────────────
     products/{id} is public (`read: if true`), so the shelf price lives ONLY on posProducts/{id}, whose rules
     allow read to `resource.data.sellerId == auth.uid` or an admin. The OWNER's device reads it here; a staff
     device is refused by the rules, so it gets { readable:false } and asks the SERVER per line instead
     (previewShelfPrice — the dry run, which proves the cashier for this shop first). Never a public read. */
  var SHELF_COLLECTION = 'posProducts';
  function shelfQuery(scope) {
    if (!scope || !scope.ok || !scope.sellerUid) throw new Error('merchant data: a resolved shop scope is required');
    return { collection: SHELF_COLLECTION, where: [['sellerId', '==', String(scope.sellerUid)]] };
  }
  /** @returns {Promise<{readable:true, map:Object<string,number>} | {readable:false}>} — never throws */
  async function listShelfPrices(o) {
    try {
      var rows = await o.db.queryProducts(shelfQuery(o.scope));
      var map = {};
      (rows || []).forEach(function (r) {
        if (r && r.id && String(r.sellerId || '') === String(o.scope.sellerUid) && _tierNum(r.shopPrice) !== null) map[String(r.id)] = r.shopPrice;
      });
      return { readable: true, map: map };
    } catch (_) {
      return { readable: false };   /* staff: the rules refuse the owner's private record — ask the server per line */
    }
  }
  /** Product rows with the shelf price from the PRIVATE map. Unknown (staff) → shopPrice null + shelfPending. */
  function withShelf(rows, shelf) {
    var known = !!(shelf && shelf.readable);
    return (rows || []).map(function (r) {
      var v = known && shelf.map ? shelf.map[String(r.id)] : undefined;
      return Object.assign({}, r, { shopPrice: (typeof v === 'number') ? v : null, shelfPending: !known });
    });
  }
  /** Ask the server for one product's shelf price (dry run; the cashier is proven for this shop first).
   *  @returns {Promise<number|null>} null = this product has no shelf price (or the check could not run). */
  async function previewShelfPrice(o) {
    var line = { productId: String(o.productId), name: o.name || '', qty: 1, price: 1, priceTier: 'shop' };
    var r = await previewSale({ scope: o.scope, cart: [line], payments: [], saleToken: 'shelf_' + line.productId, callable: o.callable });
    var it = r && r.ran && r.preview && Array.isArray(r.preview.items) ? r.preview.items[0] : null;
    return (it && it.priceTier === 'shop' && _tierNum(it.unitPrice) !== null) ? it.unitPrice : null;
  }
  /** Record a server-previewed shelf price on a line (null = not available). Does NOT change the selected tier. */
  function setLineShelf(cart, productId, price) {
    return (cart || []).map(function (l) {
      if (l.productId !== String(productId)) return Object.assign({}, l);
      var tiers = Object.assign({}, l.tiers || {}, { shop: _tierNum(price) });
      /* the server already applied the ordering rule; re-check so the screen never shows what it would refuse */
      if (tiers.shop !== null && !(tiers.shop <= tiers.online)) tiers.shop = null;
      if (tiers.shop !== null && tiers.wholesale != null && !(tiers.wholesale <= tiers.shop)) tiers.shop = null;
      return Object.assign({}, l, { tiers: tiers, shelfPending: false });
    });
  }

  /* ── Price tiers (owner, 2026-10-01) ──────────────────────────────────
     The seller sets up to three prices at upload: ONLINE (`price`), SHELF (`shopPrice`, PRIVATE — see above), WHOLESALE
     (`wholesalePrice`). The cashier picks a CONFIGURED tier per line. This client copy mirrors the server rule
     (functions/shared/pos-price-tier.js) ONLY so the screen never offers a tier the server would refuse: the
     server re-resolves every price from products/{id} and is the authority. An absent or out-of-order tier is
     NOT AVAILABLE — never 0, never "free", never silently another tier. */
  var TIER_MAX = 1000000000;
  var TIER_LABEL = { online: 'Online', shop: 'Shelf', wholesale: 'Wholesale' };
  var TIER_SHORT = { online: 'ONL', shop: 'SHELF', wholesale: 'WHOLE' };
  function _tierNum(v) { return (typeof v === 'number' && isFinite(v) && v > 0 && v <= TIER_MAX) ? v : null; }
  function tierPrices(product) {
    var p = product || {};
    var online = Number(p.salePrice || p.price || 0);
    if (!isFinite(online) || online < 0) online = 0;
    var shop = _tierNum(p.shopPrice), wholesale = _tierNum(p.wholesalePrice);
    if (shop !== null && !(shop <= online)) shop = null;
    if (wholesale !== null && !(wholesale < online)) wholesale = null;
    if (wholesale !== null && shop !== null && !(wholesale <= shop)) { shop = null; wholesale = null; }
    return { online: online, shop: shop, wholesale: wholesale };
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
    var tiers = tierPrices(product);
    out.push({
      productId: String(product.id),
      name: product.name || '',
      /* the line starts on ONLINE (the price it always used); `tiers` is for the on-screen picker only */
      price: tiers.online,
      priceTier: 'online',
      tiers: tiers,
      qty: q,
      /* carried for the on-screen stock warning only — the server re-reads canonical stock */
      knownStock: (typeof product.stock === 'number') ? product.stock : null,
      /* staff device: the shelf price is private — the server is asked when the cashier taps SHELF */
      shelfPending: product.shelfPending === true,
    });
    return out;
  }

  /** Switch a line to another CONFIGURED tier. An unknown or unavailable tier throws — it is never priced. */
  function setLineTier(cart, productId, tier) {
    var t = String(tier || '');
    if (!TIER_LABEL[t]) throw new Error('merchant data: "' + t + '" is not a price tier');
    return (cart || []).map(function (l) {
      if (l.productId !== String(productId)) return Object.assign({}, l);
      var price = l.tiers ? l.tiers[t] : (t === 'online' ? l.price : null);
      if (price === null || price === undefined) throw new Error('merchant data: this product has no ' + TIER_LABEL[t].toLowerCase() + ' price');
      return Object.assign({}, l, { priceTier: t, price: price });
    });
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
    archiveProduct: archiveProduct,
    restoreProduct: restoreProduct,
    attachProductImages: attachProductImages,
    assertInScope: assertInScope,
    productProjections: productProjections,
    /* Price tiers (2026-10-01): Online = price, Shop = shopPrice, Wholesale = wholesalePrice. */
    MAX_PRICE: MAX_PRICE,
    PRICE_TIER_KEYS: PRICE_TIER_KEYS,
    clearedFields: clearedFields,
    effectiveTiers: effectiveTiers,
    tierMirrorPatch: tierMirrorPatch,
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
    setLineTier: setLineTier,
    setLineShelf: setLineShelf,
    tierPrices: tierPrices,
    shelfQuery: shelfQuery,
    listShelfPrices: listShelfPrices,
    withShelf: withShelf,
    previewShelfPrice: previewShelfPrice,
    TIER_LABEL: TIER_LABEL,
    TIER_SHORT: TIER_SHORT,
    removeLine: removeLine,
    cartWarnings: cartWarnings,
    searchProducts: searchProducts,
    findByCode: findByCode,
    formatKES: formatKES,
  };
}));
