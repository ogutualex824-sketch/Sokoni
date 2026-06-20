/**
 * SOKONI Typesense Sync v2.0 — Firestore triggers
 *
 * 75 triggers: 25 Firestore collections × (onCreate + onUpdate + onDelete)
 *
 * onCreate  → enqueue 'upsert' (full document)
 * onUpdate  → enqueue 'upsert' (full new doc) OR 'delete' if doc became non-indexable
 * onDelete  → enqueue 'delete'
 *
 * Skipped docs:
 *  - data._noIndex === true
 *  - data.status in { draft, deleted, banned, spam, suspended, archived }
 *  - users with data.private === true
 *
 * If a previously-active doc is updated to a skip status → enqueue delete instead.
 *
 * Collections covered (→ Typesense target):
 *  products        → sokoni_products
 *  sellers         → sokoni_shops
 *  providers       → sokoni_services
 *  events          → sokoni_events
 *  propertyListings→ sokoni_properties
 *  cars            → sokoni_vehicles
 *  digitalJobs     → sokoni_jobs
 *  digitalGigs     → sokoni_jobs
 *  bnbListings     → sokoni_hotels
 *  fitness_clubs   → sokoni_sports
 *  fitness_classes → sokoni_sports
 *  education       → sokoni_education
 *  lawyers         → sokoni_professionals
 *  reviews         → sokoni_reviews
 *  digitalReviews  → sokoni_reviews
 *  users           → sokoni_users
 *  categories      → sokoni_categories
 *  brands          → sokoni_brands
 *  collections     → sokoni_collections
 *  coupons         → sokoni_coupons
 *  foods           → sokoni_products
 *  legalReviews    → sokoni_reviews
 *  jobs            → sokoni_jobs
 *  hotels          → sokoni_hotels
 *  properties      → sokoni_properties
 */

'use strict';

const {
  onDocumentCreated,
  onDocumentUpdated,
  onDocumentDeleted,
} = require('firebase-functions/v2/firestore');

const { enqueue, PRIORITY } = require('./typesense-queue');

/* ── Skip predicates ─────────────────────────────────────────────── */

const SKIP_STATUSES = new Set(['draft', 'deleted', 'banned', 'spam', 'suspended', 'archived', 'inactive']);

function _shouldSkip(data, collection) {
  if (!data) return true;
  if (data._noIndex === true) return true;
  if (SKIP_STATUSES.has(data.status)) return true;
  if (collection === 'users' && data.private === true) return true;
  return false;
}

/* Returns 'delete' | 'upsert' | 'ignore' */
function _updateDecision(before, after, collection) {
  const wasSkipped = _shouldSkip(before, collection);
  const isSkipped  = _shouldSkip(after,  collection);
  if (isSkipped && !wasSkipped) return 'delete';  /* became non-indexable */
  if (isSkipped &&  wasSkipped) return 'ignore';  /* was and remains non-indexable */
  return 'upsert';
}

/* ── Trigger factory ─────────────────────────────────────────────── */

const _CF_OPTS = { memory: '256MiB', timeoutSeconds: 30 };

function _makeTriggers(firestoreCollection, opts = {}) {
  const col         = firestoreCollection;
  const safeKey     = col.replace(/-/g, '_');
  const region      = opts.region || 'us-central1';
  const priority    = opts.priority;

  const onCreate = onDocumentCreated(
    { document: `${col}/{docId}`, ..._CF_OPTS },
    async event => {
      const data = event.data?.data();
      if (!data || _shouldSkip(data, col)) return;
      await enqueue({ collection: col, docId: event.params.docId, operation: 'upsert', data, priority });
    }
  );

  const onUpdate = onDocumentUpdated(
    { document: `${col}/{docId}`, ..._CF_OPTS },
    async event => {
      const before = event.data?.before?.data();
      const after  = event.data?.after?.data();
      const decision = _updateDecision(before, after, col);
      if (decision === 'ignore') return;
      await enqueue({
        collection: col,
        docId:      event.params.docId,
        operation:  decision,
        data:       decision === 'delete' ? null : after,
        beforeData: before,
        priority,
      });
    }
  );

  const onDelete = onDocumentDeleted(
    { document: `${col}/{docId}`, ..._CF_OPTS },
    async event => {
      await enqueue({ collection: col, docId: event.params.docId, operation: 'delete', priority });
    }
  );

  return {
    [`ts_${safeKey}_onCreate`]: onCreate,
    [`ts_${safeKey}_onUpdate`]: onUpdate,
    [`ts_${safeKey}_onDelete`]: onDelete,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   25 COLLECTION TRIGGER SETS  (75 Cloud Functions total)
════════════════════════════════════════════════════════════════════ */

const triggers = {
  /* Core commerce — highest traffic */
  ..._makeTriggers('products'),
  ..._makeTriggers('sellers'),
  ..._makeTriggers('providers'),
  ..._makeTriggers('events'),
  ..._makeTriggers('propertyListings'),
  ..._makeTriggers('cars'),
  ..._makeTriggers('digitalJobs'),
  ..._makeTriggers('digitalGigs'),
  ..._makeTriggers('users'),

  /* Hospitality & Services */
  ..._makeTriggers('bnbListings'),
  ..._makeTriggers('fitness_clubs'),
  ..._makeTriggers('fitness_classes'),
  ..._makeTriggers('education'),
  ..._makeTriggers('lawyers'),

  /* Reviews — lower priority, high volume */
  ..._makeTriggers('reviews',       { priority: 3 /* LOW */ }),
  ..._makeTriggers('digitalReviews',{ priority: 3 }),
  ..._makeTriggers('legalReviews',  { priority: 3 }),

  /* Catalogue — updated infrequently, low priority */
  ..._makeTriggers('categories', { priority: 3 }),
  ..._makeTriggers('brands',     { priority: 3 }),
  ..._makeTriggers('collections',{ priority: 3 }),
  ..._makeTriggers('coupons',    { priority: 2 }),

  /* Alias collections (map to same TS targets) */
  ..._makeTriggers('foods',       { priority: 2 }),
  ..._makeTriggers('jobs',        { priority: 2 }),
  ..._makeTriggers('hotels',      { priority: 2 }),
  ..._makeTriggers('properties',  { priority: 2 }),
};

module.exports = triggers;
