/* ============================================================================
   SOKONI — Merchant category templates
   ============================================================================
   A merchant who finishes onboarding should land on a configured store, not an
   empty one. This is the declaration of what "configured" means per category.

   ── What this file is, and deliberately is not ────────────────────────────
   It is DATA. It declares which existing platform capabilities a category turns
   on and which products it starts with. It contains no POS logic, no inventory
   logic, no delivery logic and no pricing logic, because all of that already
   exists: 141 POS/till/inventory Cloud Functions are deployed, and
   posSyncToMarketplace / posMarketplaceOrderSync already keep one inventory in
   step across POS and marketplace in both directions.

   A category template that carried its own logic would be a second POS. The
   whole point is that a Water Supplier is an ordinary SOKONI merchant with a
   particular starting configuration — not a special kind of merchant.

   ── Adding a category ─────────────────────────────────────────────────────
   Add an entry here and a matching row in hub-register.js CATS. Nothing else
   should need changing. If a new category needs new CODE, that is a signal the
   capability belongs in the platform, not in this file.
   ========================================================================= */

(function (root) {
  'use strict';

  /* Capability keys map to platform modules that already exist. Turning one on
     is configuration; there is no branch anywhere that says "if water supplier". */
  var TEMPLATES = {

    'water-supplier': {
      label: 'Water Supplier / Refill Station',
      hub: 'shopping',

      /* Modules provisioned on approval. Each is an existing subsystem. */
      capabilities: [
        'storefront',        /* marketplace listing                       */
        'pos',               /* SmartPOS                                  */
        'multi-till',        /* several tills, one inventory              */
        'inventory',         /* inventory engine                          */
        'shared-inventory',  /* posSyncToMarketplace + posMarketplaceOrderSync */
        'delivery',          /* dispatch + zones + driver assignment      */
        'staff',             /* pos-staff-ops roles                       */
        'customers',         /* customer profiles, reorder, history       */
        'reports',           /* daily/weekly/monthly, stock valuation     */
        'barcode',           /* scanner + label printing                  */
        'wholesale-pricing', /* retail / wholesale / corporate tiers      */
        'credit-accounts',   /* invoiced customers, statements            */
        'returnable-units',  /* bottle deposits and exchanges — see below */
      ],

      /* ── Returnable units ───────────────────────────────────────────────
         A water business does not only sell water; it lends containers. A 20L
         bottle can be sold outright, refilled, exchanged, returned for a
         deposit refund, or written off as damaged.

         These are inventory SUBTYPES on the existing inventory engine, not a
         second inventory. Modelling them separately would recreate exactly the
         split this platform has spent the last two days removing: one number in
         the POS, a different number online, and no way to tell which is true.

         Declared here; the engine work to honour `subtype` is a separate,
         tracked change and is NOT implied by this file existing. */
      returnableUnits: {
        enabled: true,
        depositCurrency: 'KES',
        subtypes: ['filled', 'empty', 'on-loan', 'damaged'],
        /* A refill decrements `filled` and increments `empty` on return, so the
           two must always be reconciled against the same product. */
        reconcileAgainst: 'product',
      },

      /* Merchants choose one; none is hardcoded. */
      deliveryModes: ['free', 'flat-rate', 'zone', 'distance', 'pickup-only'],
      defaultDeliveryMode: 'flat-rate',

      /* ── Product presets ───────────────────────────────────────────────
         A starting catalogue, not a fixed one. Prices are deliberately null:
         inventing a price for a merchant would put a number in front of a
         customer that the merchant never agreed to. SKUs are generated from the
         merchant id at provisioning so two merchants cannot collide, and
         barcodes are left empty because a real barcode belongs to the product,
         not to us. */
      products: [
        { name: '20L Refill',      unit: 'refill', volumeMl: 20000, returnable: true,  price: null, taxCode: 'VAT_16' },
        { name: '20L New Bottle',  unit: 'bottle', volumeMl: 20000, returnable: true,  price: null, taxCode: 'VAT_16' },
        { name: '10L Bottle',      unit: 'bottle', volumeMl: 10000, returnable: true,  price: null, taxCode: 'VAT_16' },
        { name: '5L Bottle',       unit: 'bottle', volumeMl: 5000,  returnable: false, price: null, taxCode: 'VAT_16' },
        { name: '1.5L Bottle',     unit: 'bottle', volumeMl: 1500,  returnable: false, price: null, taxCode: 'VAT_16' },
        { name: '500ml Bottle',    unit: 'bottle', volumeMl: 500,   returnable: false, price: null, taxCode: 'VAT_16' },
      ],

      /* Every preset supports these because the inventory engine already does.
         Listed so a provisioning step can assert them rather than assume. */
      productFields: ['sku', 'barcode', 'price', 'wholesalePrice', 'stock',
                      'minStock', 'batchNumber', 'expiryDate', 'taxCode'],

      /* Tiles the merchant dashboard shows first. Every one is an existing
         report or query — none is a new metric. */
      dashboard: ['todays-revenue', 'active-deliveries', 'pending-dispatch',
                  'inventory-level', 'low-stock', 'returnable-balance',
                  'cash-vs-mpesa', 'outstanding-credit', 'top-customers'],
    },

  };

  var API = {
    /** All template ids. */
    list: function () { return Object.keys(TEMPLATES); },

    /** Template for a category id, or null. Never throws — an unknown category
        is an ordinary merchant with no preset, which is a valid outcome. */
    get: function (categoryId) {
      return Object.prototype.hasOwnProperty.call(TEMPLATES, categoryId)
        ? JSON.parse(JSON.stringify(TEMPLATES[categoryId]))
        : null;
    },

    /** Does this category turn on a capability? */
    has: function (categoryId, capability) {
      var t = TEMPLATES[categoryId];
      return !!(t && t.capabilities && t.capabilities.indexOf(capability) !== -1);
    },

    /** Product presets with SKUs bound to a merchant, ready to write.
        Prices stay null: the merchant sets them before anything is listed. */
    productsFor: function (categoryId, merchantId) {
      var t = TEMPLATES[categoryId];
      if (!t || !t.products) return [];
      var prefix = String(merchantId || 'MERCHANT').toUpperCase().slice(0, 6);
      return t.products.map(function (p, i) {
        return {
          name: p.name,
          sku: prefix + '-' + String(i + 1).padStart(3, '0'),
          barcode: '',
          unit: p.unit,
          volumeMl: p.volumeMl,
          returnable: !!p.returnable,
          price: null,
          wholesalePrice: null,
          stock: 0,
          minStock: 0,
          batchNumber: null,
          expiryDate: null,
          taxCode: p.taxCode,
          status: 'draft',      /* nothing is listed until the merchant prices it */
        };
      });
    },
  };

  root.SokoniMerchantTemplates = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;

})(typeof window !== 'undefined' ? window : globalThis);
