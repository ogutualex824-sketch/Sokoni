/**
 * SOKONI Search Sync — Master Collection Registry & Unified Sync Orchestrator
 *
 * This module is the single source of truth for every searchable collection
 * on the platform. It:
 *
 *  1. Exports COLLECTION_REGISTRY — authoritative metadata for all collections
 *     across both Algolia and Typesense engines.
 *
 *  2. Exports syncDocument() — parallel fan-out to both engines via their
 *     respective queues. Either engine failure is isolated; the other proceeds.
 *
 *  3. Registers Firestore onCreate / onUpdate / onDelete triggers for the SIX
 *     NEW collections that have no existing triggers:
 *       deals, auctions, vendors, companies, inventory_products, orders
 *
 *     All other collections (products, sellers, providers, services, events,
 *     properties, propertyListings, cars, digitalJobs, digitalGigs, jobs,
 *     users, categories, brands, collections, coupons, foods, bnbListings,
 *     fitness_clubs, fitness_classes, education, lawyers, reviews,
 *     digitalReviews, legalReviews, hotels) are already handled by either
 *     algolia-sync.js or typesense-sync.js. Adding triggers here for those
 *     collections would cause duplicate writes.
 *
 *  4. Exports helper predicates (_shouldSkip, _updateDecision) re-used by
 *     other search-*.js modules.
 *
 * Priority scale (matches typesense-queue.js PRIORITY constants):
 *   1 → HIGH:   price / stock / status changes; flagship inventory
 *   2 → NORMAL: metadata edits, descriptions, new admin-visible listings
 *   3 → LOW:    catalogue reference data, admin-only records
 *
 * Security note:
 *   adminOnly: true collections are enqueued for both engines but MUST NOT
 *   be exposed via client-scoped API keys. Enforcement lives in
 *   algolia-secured-keys.js and typesense-secured-keys.js.
 */

'use strict';

const { onDocumentCreated, onDocumentUpdated, onDocumentDeleted } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();

const { enqueue: algoliaEnqueue } = require('./algolia-queue');
const { enqueue: typesenseEnqueue, PRIORITY } = require('./typesense-queue');

/* ═══════════════════════════════════════════════════════════════════════════
   COLLECTION REGISTRY
   Single source of truth for every searchable collection on the platform.
   Consumers should treat this as read-only.
════════════════════════════════════════════════════════════════════════════ */

/**
 * @typedef {Object} CollectionEntry
 * @property {string}   algoliaIndex          - Algolia index name
 * @property {string}   typesenseCollection   - Typesense collection name
 * @property {number}   priority              - 1=HIGH, 2=NORMAL, 3=LOW
 * @property {boolean}  adminOnly             - true = restricted to admin searches
 * @property {string}   firestoreCollection   - Actual Firestore collection name
 * @property {string[]} searchableFields      - Primary text fields for search
 * @property {string[]} facetFields           - Filterable / facet fields
 * @property {boolean}  [hasTrigger]          - true = this module owns the trigger
 * @property {string}   [engine]              - 'both' | 'algolia' | 'typesense'
 */

/** @type {Object.<string, CollectionEntry>} */
const COLLECTION_REGISTRY = {

  /* ── Core Commerce (Algolia + Typesense, existing triggers) ─────────── */

  products: {
    algoliaIndex:        'sokoni_products',
    typesenseCollection: 'sokoni_products',
    priority:            PRIORITY.HIGH,
    adminOnly:           false,
    firestoreCollection: 'products',
    searchableFields:    ['name', 'brand', 'category', 'description', 'sku', 'barcode'],
    facetFields:         ['category', 'brand', 'condition', 'inStock', 'hub', 'sellerId', 'isOnSale'],
    engine:              'both',
    hasTrigger:          false,
  },

  sellers: {
    algoliaIndex:        'sokoni_shops',
    typesenseCollection: 'sokoni_shops',
    priority:            PRIORITY.HIGH,
    adminOnly:           false,
    firestoreCollection: 'sellers',
    searchableFields:    ['name', 'description', 'category'],
    facetFields:         ['category', 'verified', 'deliveryOptions'],
    engine:              'both',
    hasTrigger:          false,
  },

  providers: {
    algoliaIndex:        'sokoni_services',
    typesenseCollection: 'sokoni_services',
    priority:            PRIORITY.HIGH,
    adminOnly:           false,
    firestoreCollection: 'providers',
    searchableFields:    ['name', 'description', 'category'],
    facetFields:         ['category', 'priceType', 'remote', 'hub'],
    engine:              'both',
    hasTrigger:          false,
  },

  services: {
    algoliaIndex:        'sokoni_services',
    typesenseCollection: 'sokoni_services',
    priority:            PRIORITY.HIGH,
    adminOnly:           false,
    firestoreCollection: 'services',
    searchableFields:    ['name', 'description', 'category'],
    facetFields:         ['category', 'priceType', 'remote', 'hub'],
    engine:              'both',
    hasTrigger:          false,
  },

  events: {
    algoliaIndex:        'sokoni_events',
    typesenseCollection: 'sokoni_events',
    priority:            PRIORITY.HIGH,
    adminOnly:           false,
    firestoreCollection: 'events',
    searchableFields:    ['title', 'description', 'category', 'venue'],
    facetFields:         ['category', 'isFree', 'isOnline'],
    engine:              'both',
    hasTrigger:          false,
  },

  properties: {
    algoliaIndex:        'sokoni_properties',
    typesenseCollection: 'sokoni_properties',
    priority:            PRIORITY.NORMAL,
    adminOnly:           false,
    firestoreCollection: 'properties',
    searchableFields:    ['title', 'description', 'type'],
    facetFields:         ['type', 'listingType', 'bedrooms', 'furnished'],
    engine:              'both',
    hasTrigger:          false,
  },

  propertyListings: {
    algoliaIndex:        'sokoni_properties',
    typesenseCollection: 'sokoni_properties',
    priority:            PRIORITY.NORMAL,
    adminOnly:           false,
    firestoreCollection: 'propertyListings',
    searchableFields:    ['title', 'description', 'type'],
    facetFields:         ['type', 'listingType', 'bedrooms', 'furnished'],
    engine:              'typesense',
    hasTrigger:          false,
  },

  cars: {
    algoliaIndex:        'sokoni_vehicles',
    typesenseCollection: 'sokoni_vehicles',
    priority:            PRIORITY.HIGH,
    adminOnly:           false,
    firestoreCollection: 'cars',
    searchableFields:    ['title', 'make', 'model', 'year', 'bodyType'],
    facetFields:         ['make', 'bodyType', 'listingType', 'fuelType', 'transmission', 'condition'],
    engine:              'both',
    hasTrigger:          false,
  },

  digitalJobs: {
    algoliaIndex:        'sokoni_jobs',
    typesenseCollection: 'sokoni_jobs',
    priority:            PRIORITY.NORMAL,
    adminOnly:           false,
    firestoreCollection: 'digitalJobs',
    searchableFields:    ['title', 'company', 'description', 'skills'],
    facetFields:         ['category', 'jobType', 'remote', 'experience'],
    engine:              'both',
    hasTrigger:          false,
  },

  digitalGigs: {
    algoliaIndex:        'sokoni_jobs',
    typesenseCollection: 'sokoni_jobs',
    priority:            PRIORITY.NORMAL,
    adminOnly:           false,
    firestoreCollection: 'digitalGigs',
    searchableFields:    ['title', 'company', 'description', 'skills'],
    facetFields:         ['category', 'jobType', 'remote'],
    engine:              'typesense',
    hasTrigger:          false,
  },

  jobs: {
    algoliaIndex:        'sokoni_jobs',
    typesenseCollection: 'sokoni_jobs',
    priority:            PRIORITY.NORMAL,
    adminOnly:           false,
    firestoreCollection: 'jobs',
    searchableFields:    ['title', 'company', 'description', 'skills'],
    facetFields:         ['category', 'jobType', 'remote', 'experience'],
    engine:              'both',
    hasTrigger:          false,
  },

  users: {
    algoliaIndex:        'sokoni_users',
    typesenseCollection: 'sokoni_users',
    priority:            PRIORITY.NORMAL,
    adminOnly:           false,
    firestoreCollection: 'users',
    searchableFields:    ['displayName', 'username', 'bio', 'skills'],
    facetFields:         ['role', 'verified', 'sellerVerified'],
    engine:              'both',
    hasTrigger:          false,
  },

  categories: {
    algoliaIndex:        'sokoni_categories',
    typesenseCollection: 'sokoni_categories',
    priority:            PRIORITY.LOW,
    adminOnly:           false,
    firestoreCollection: 'categories',
    searchableFields:    ['name', 'description'],
    facetFields:         ['hub', 'level', 'active'],
    engine:              'both',
    hasTrigger:          false,
  },

  brands: {
    algoliaIndex:        'sokoni_brands',
    typesenseCollection: 'sokoni_brands',
    priority:            PRIORITY.LOW,
    adminOnly:           false,
    firestoreCollection: 'brands',
    searchableFields:    ['name', 'description', 'category'],
    facetFields:         ['category', 'country', 'official', 'popular'],
    engine:              'both',
    hasTrigger:          false,
  },

  collections: {
    algoliaIndex:        'sokoni_collections',
    typesenseCollection: 'sokoni_collections',
    priority:            PRIORITY.LOW,
    adminOnly:           false,
    firestoreCollection: 'collections',
    searchableFields:    ['name', 'description'],
    facetFields:         ['hub', 'official'],
    engine:              'both',
    hasTrigger:          false,
  },

  coupons: {
    algoliaIndex:        'sokoni_coupons',
    typesenseCollection: 'sokoni_coupons',
    priority:            PRIORITY.NORMAL,
    adminOnly:           false,
    firestoreCollection: 'coupons',
    searchableFields:    ['code', 'name', 'description'],
    facetFields:         ['discountType', 'applicableTo', 'active', 'freeShipping'],
    engine:              'both',
    hasTrigger:          false,
  },

  foods: {
    algoliaIndex:        'sokoni_products',
    typesenseCollection: 'sokoni_products',
    priority:            PRIORITY.HIGH,
    adminOnly:           false,
    firestoreCollection: 'foods',
    searchableFields:    ['name', 'description', 'category'],
    facetFields:         ['category', 'inStock'],
    engine:              'both',
    hasTrigger:          false,
  },

  /* ── Typesense-only collections (existing triggers in typesense-sync.js) */

  bnbListings: {
    algoliaIndex:        null,
    typesenseCollection: 'sokoni_hotels',
    priority:            PRIORITY.NORMAL,
    adminOnly:           false,
    firestoreCollection: 'bnbListings',
    searchableFields:    ['name', 'description', 'type'],
    facetFields:         ['type', 'amenities', 'instantBook', 'petFriendly'],
    engine:              'typesense',
    hasTrigger:          false,
  },

  hotels: {
    algoliaIndex:        null,
    typesenseCollection: 'sokoni_hotels',
    priority:            PRIORITY.NORMAL,
    adminOnly:           false,
    firestoreCollection: 'hotels',
    searchableFields:    ['name', 'description', 'type'],
    facetFields:         ['type', 'amenities', 'instantBook'],
    engine:              'typesense',
    hasTrigger:          false,
  },

  fitness_clubs: {
    algoliaIndex:        null,
    typesenseCollection: 'sokoni_sports',
    priority:            PRIORITY.NORMAL,
    adminOnly:           false,
    firestoreCollection: 'fitness_clubs',
    searchableFields:    ['name', 'description', 'sport'],
    facetFields:         ['sport', 'facilities', 'ageGroup'],
    engine:              'typesense',
    hasTrigger:          false,
  },

  fitness_classes: {
    algoliaIndex:        null,
    typesenseCollection: 'sokoni_sports',
    priority:            PRIORITY.NORMAL,
    adminOnly:           false,
    firestoreCollection: 'fitness_classes',
    searchableFields:    ['name', 'description', 'sport'],
    facetFields:         ['sport', 'ageGroup', 'gender'],
    engine:              'typesense',
    hasTrigger:          false,
  },

  education: {
    algoliaIndex:        null,
    typesenseCollection: 'sokoni_education',
    priority:            PRIORITY.NORMAL,
    adminOnly:           false,
    firestoreCollection: 'education',
    searchableFields:    ['title', 'description', 'provider', 'subject'],
    facetFields:         ['type', 'subject', 'level', 'format', 'isFree', 'isOnline', 'certificate'],
    engine:              'typesense',
    hasTrigger:          false,
  },

  lawyers: {
    algoliaIndex:        null,
    typesenseCollection: 'sokoni_professionals',
    priority:            PRIORITY.NORMAL,
    adminOnly:           false,
    firestoreCollection: 'lawyers',
    searchableFields:    ['name', 'description', 'specialty'],
    facetFields:         ['profession', 'specialty', 'languages', 'isOnline'],
    engine:              'typesense',
    hasTrigger:          false,
  },

  reviews: {
    algoliaIndex:        null,
    typesenseCollection: 'sokoni_reviews',
    priority:            PRIORITY.LOW,
    adminOnly:           false,
    firestoreCollection: 'reviews',
    searchableFields:    ['content', 'targetName', 'reviewerName'],
    facetFields:         ['targetType', 'rating', 'hub'],
    engine:              'typesense',
    hasTrigger:          false,
  },

  digitalReviews: {
    algoliaIndex:        null,
    typesenseCollection: 'sokoni_reviews',
    priority:            PRIORITY.LOW,
    adminOnly:           false,
    firestoreCollection: 'digitalReviews',
    searchableFields:    ['content', 'targetName'],
    facetFields:         ['targetType', 'rating'],
    engine:              'typesense',
    hasTrigger:          false,
  },

  legalReviews: {
    algoliaIndex:        null,
    typesenseCollection: 'sokoni_reviews',
    priority:            PRIORITY.LOW,
    adminOnly:           false,
    firestoreCollection: 'legalReviews',
    searchableFields:    ['content', 'targetName'],
    facetFields:         ['targetType', 'rating'],
    engine:              'typesense',
    hasTrigger:          false,
  },

  /* ── NEW collections — triggers registered in this file ──────────────── */

  deals: {
    algoliaIndex:        'sokoni_products',
    typesenseCollection: 'sokoni_products',
    priority:            PRIORITY.HIGH,
    adminOnly:           false,
    firestoreCollection: 'deals',
    searchableFields:    ['name', 'description', 'category', 'brand'],
    facetFields:         ['category', 'brand', 'discountPercent', 'inStock', 'hub'],
    engine:              'both',
    hasTrigger:          true,
  },

  auctions: {
    algoliaIndex:        'sokoni_products',
    typesenseCollection: 'sokoni_products',
    priority:            PRIORITY.HIGH,
    adminOnly:           false,
    firestoreCollection: 'auctions',
    searchableFields:    ['name', 'description', 'category', 'brand'],
    facetFields:         ['category', 'brand', 'condition', 'status'],
    engine:              'both',
    hasTrigger:          true,
  },

  vendors: {
    algoliaIndex:        'sokoni_shops',
    typesenseCollection: 'sokoni_shops',
    priority:            PRIORITY.NORMAL,
    adminOnly:           false,
    firestoreCollection: 'vendors',
    searchableFields:    ['name', 'description', 'category'],
    facetFields:         ['category', 'verified', 'deliveryOptions'],
    engine:              'both',
    hasTrigger:          true,
  },

  companies: {
    algoliaIndex:        'sokoni_shops',
    typesenseCollection: 'sokoni_shops',
    priority:            PRIORITY.NORMAL,
    adminOnly:           false,
    firestoreCollection: 'companies',
    searchableFields:    ['name', 'description', 'category'],
    facetFields:         ['category', 'verified'],
    engine:              'both',
    hasTrigger:          true,
  },

  inventory_products: {
    algoliaIndex:        'sokoni_products',
    typesenseCollection: 'sokoni_products',
    priority:            PRIORITY.HIGH,
    adminOnly:           false,
    firestoreCollection: 'inventory_products',
    searchableFields:    ['name', 'brand', 'category', 'description', 'sku', 'barcode'],
    facetFields:         ['category', 'brand', 'inStock', 'condition'],
    engine:              'both',
    hasTrigger:          true,
  },

  orders: {
    algoliaIndex:        null,
    typesenseCollection: null,
    priority:            PRIORITY.LOW,
    adminOnly:           true,
    firestoreCollection: 'orders',
    searchableFields:    ['orderId', 'buyerName', 'sellerName', 'status'],
    facetFields:         ['status', 'paymentMethod', 'hub'],
    engine:              'none',
    hasTrigger:          true,
  },

};

/* ═══════════════════════════════════════════════════════════════════════════
   SKIP PREDICATES  — exported for re-use by other search-*.js modules
════════════════════════════════════════════════════════════════════════════ */

/** Statuses that mean "remove from / never add to the search index" */
const _SKIP_STATUSES = new Set([
  'draft', 'deleted', 'banned', 'spam', 'suspended', 'archived', 'inactive',
]);

/**
 * Returns true if this document should be excluded from both search engines.
 *
 * @param {object|null}  data        - Firestore document data
 * @param {string}       collection  - Firestore collection name
 * @returns {boolean}
 */
function _shouldSkip(data, collection) {
  if (!data) return true;
  if (data._noIndex === true) return true;
  if (_SKIP_STATUSES.has(data.status)) return true;
  if (collection === 'users' && data.private === true) return true;
  return false;
}

/**
 * Determines the correct indexing action after an onUpdate event.
 *
 * @param {object} before     - Document data before the update
 * @param {object} after      - Document data after the update
 * @param {string} collection - Firestore collection name
 * @returns {'upsert'|'delete'|'ignore'}
 */
function _updateDecision(before, after, collection) {
  const wasSkipped = _shouldSkip(before, collection);
  const isSkipped  = _shouldSkip(after,  collection);
  if (isSkipped && !wasSkipped) return 'delete';   // became non-indexable
  if (isSkipped &&  wasSkipped) return 'ignore';   // was and remains excluded
  return 'upsert';
}

/* ═══════════════════════════════════════════════════════════════════════════
   UNIFIED SYNC FUNCTION
════════════════════════════════════════════════════════════════════════════ */

/**
 * Routes a document change to both Algolia and Typesense queues in parallel.
 * A failure in one engine does not block the other — both attempts run to
 * completion regardless, and the result surfaces which engine(s) succeeded.
 *
 * @param {string}            collection - Firestore collection name
 * @param {string}            docId      - Firestore document ID
 * @param {object|null}       data       - Current document data (null for deletes)
 * @param {'upsert'|'partial'|'delete'} op - Indexing operation
 * @param {object}            [opts]     - Optional overrides
 * @param {object|null}       [opts.beforeData] - Previous snapshot (for Algolia partial)
 * @param {number}            [opts.priority]   - Override priority (Typesense)
 * @returns {Promise<{algolia: boolean, typesense: boolean, errors: string[]}>}
 */
async function syncDocument(collection, docId, data, op, opts = {}) {
  const entry = COLLECTION_REGISTRY[collection];
  if (!entry) {
    return { algolia: false, typesense: false, errors: [`Collection "${collection}" not in registry`] };
  }

  if (entry.engine === 'none') {
    /* Collection is registered for metadata purposes only (e.g. orders) */
    return { algolia: false, typesense: false, errors: [] };
  }

  const priority    = opts.priority  !== undefined ? opts.priority : entry.priority;
  const beforeData  = opts.beforeData || null;
  const errors      = [];

  const [algoliaResult, typesenseResult] = await Promise.allSettled([
    /* Algolia — only for collections with an index */
    entry.algoliaIndex && entry.engine !== 'typesense'
      ? algoliaEnqueue({
          collection,
          docId,
          operation:  op,
          data:       data || null,
          beforeData,
        })
      : Promise.resolve(null),

    /* Typesense — only for collections with a TS collection */
    entry.typesenseCollection && entry.engine !== 'algolia'
      ? typesenseEnqueue({
          collection,
          docId,
          operation:  op === 'partial' ? 'upsert' : op, /* TS uses upsert, not partial */
          data:       data || null,
          beforeData,
          priority,
        })
      : Promise.resolve(null),
  ]);

  const algoliaOk   = algoliaResult.status === 'fulfilled';
  const typesenseOk = typesenseResult.status === 'fulfilled';

  if (!algoliaOk && entry.algoliaIndex && entry.engine !== 'typesense') {
    const msg = algoliaResult.reason?.message || String(algoliaResult.reason);
    errors.push(`[Algolia] ${collection}/${docId}: ${msg}`);
    admin.logger.error('[SearchSync] Algolia enqueue failure', { collection, docId, op, error: msg });
  }

  if (!typesenseOk && entry.typesenseCollection && entry.engine !== 'algolia') {
    const msg = typesenseResult.reason?.message || String(typesenseResult.reason);
    errors.push(`[Typesense] ${collection}/${docId}: ${msg}`);
    admin.logger.error('[SearchSync] Typesense enqueue failure', { collection, docId, op, error: msg });
  }

  return { algolia: algoliaOk, typesense: typesenseOk, errors };
}

/* ═══════════════════════════════════════════════════════════════════════════
   TRIGGER FACTORY
   Creates onCreate / onUpdate / onDelete triggers for a single collection.
   Used only for the NEW collections managed by this file.
════════════════════════════════════════════════════════════════════════════ */

/** Shared CF resource options — lightweight triggers, short timeout */
const _CF_OPTS = { memory: '256MiB', timeoutSeconds: 30 };

/**
 * Builds the three standard Firestore triggers for a collection.
 *
 * @param {string} firestoreCol - Firestore collection path (no wildcards)
 * @param {object} [overrides]  - Optional { priority } override
 * @returns {Object} Named trigger exports keyed as searchSync_<col>_onCreate etc.
 */
function _makeTriggers(firestoreCol, overrides = {}) {
  const safeKey  = firestoreCol.replace(/[^a-zA-Z0-9]/g, '_');
  const entry    = COLLECTION_REGISTRY[firestoreCol];
  const priority = overrides.priority !== undefined ? overrides.priority : (entry ? entry.priority : PRIORITY.NORMAL);

  const onCreate = onDocumentCreated(
    { document: `${firestoreCol}/{docId}`, ..._CF_OPTS },
    async event => {
      const data  = event.data?.data();
      const docId = event.params.docId;
      if (!data || _shouldSkip(data, firestoreCol)) return;
      await syncDocument(firestoreCol, docId, data, 'upsert', { priority });
    }
  );

  const onUpdate = onDocumentUpdated(
    { document: `${firestoreCol}/{docId}`, ..._CF_OPTS },
    async event => {
      const before = event.data?.before?.data();
      const after  = event.data?.after?.data();
      const docId  = event.params.docId;
      const op     = _updateDecision(before, after, firestoreCol);
      if (op === 'ignore') return;

      if (op === 'delete') {
        await syncDocument(firestoreCol, docId, null, 'delete', { priority });
        return;
      }

      await syncDocument(firestoreCol, docId, after, 'upsert', {
        priority,
        beforeData: before,
      });
    }
  );

  const onDelete = onDocumentDeleted(
    { document: `${firestoreCol}/{docId}`, ..._CF_OPTS },
    async event => {
      const docId = event.params.docId;
      await syncDocument(firestoreCol, docId, null, 'delete', { priority });
    }
  );

  return {
    [`searchSync_${safeKey}_onCreate`]: onCreate,
    [`searchSync_${safeKey}_onUpdate`]: onUpdate,
    [`searchSync_${safeKey}_onDelete`]: onDelete,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   FIRESTORE TRIGGERS — NEW COLLECTIONS ONLY
   Do NOT add triggers here for collections already covered by:
     algolia-sync.js  (products, sellers, providers, services, events,
                       properties, cars, digitalJobs, jobs, users,
                       categories, brands, collections, coupons, foods)
     typesense-sync.js (all of the above + propertyListings, digitalGigs,
                        bnbListings, fitness_clubs, fitness_classes,
                        education, lawyers, reviews, digitalReviews,
                        legalReviews, hotels)
════════════════════════════════════════════════════════════════════════════ */

const triggers = {

  /**
   * Deals — flash sales and time-limited promotions.
   * Maps to sokoni_products (same schema, high priority for real-time price visibility).
   */
  ..._makeTriggers('deals', { priority: PRIORITY.HIGH }),

  /**
   * Auctions — live auction listings.
   * Maps to sokoni_products; urgency level is HIGH as bid/end-time is time-sensitive.
   */
  ..._makeTriggers('auctions', { priority: PRIORITY.HIGH }),

  /**
   * Vendors — third-party B2B vendors distinct from consumer sellers.
   * Maps to sokoni_shops.
   */
  ..._makeTriggers('vendors', { priority: PRIORITY.NORMAL }),

  /**
   * Companies — registered business entities.
   * Maps to sokoni_shops; lower write frequency than vendors.
   */
  ..._makeTriggers('companies', { priority: PRIORITY.NORMAL }),

  /**
   * Inventory products — SmartPOS / warehouse stock items.
   * Maps to sokoni_products; HIGH priority because stock changes affect
   * the inStock facet that customers filter on.
   */
  ..._makeTriggers('inventory_products', { priority: PRIORITY.HIGH }),

  /**
   * Orders — admin-only, not publicly searchable.
   * engine: 'none' in the registry — syncDocument is a no-op.
   * Triggers are still registered so future admin-search can be enabled
   * by changing the registry entry without touching the trigger code.
   */
  ..._makeTriggers('orders', { priority: PRIORITY.LOW }),

};

/* ═══════════════════════════════════════════════════════════════════════════
   EXPORTS
════════════════════════════════════════════════════════════════════════════ */

module.exports = {
  /** Complete registry of all searchable collections on the platform. */
  COLLECTION_REGISTRY,

  /** Fan-out a document change to both search engines. */
  syncDocument,

  /** Skip predicate — re-used by algolia-sync.js, typesense-sync.js. */
  _shouldSkip,

  /** Update decision helper — 'upsert' | 'delete' | 'ignore'. */
  _updateDecision,

  /* Firestore trigger exports (consumed by functions/index.js) */
  ...triggers,
};
