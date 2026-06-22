/**
 * SOKONI Algolia Sync — Firestore Triggers
 *
 * All 13 indexed collections × 3 events (onCreate / onUpdate / onDelete)
 * Each trigger writes to the algoliaQueue (idempotent, deduped by doc ID).
 *
 * Strategy:
 *  onCreate  → full 'upsert'
 *  onUpdate  → 'partial' (diff only changed fields — reduces Algolia write units)
 *  onDelete  → 'delete'
 *
 * Collections indexed:
 *   products, sellers, providers/services, events, properties, cars,
 *   digitalJobs, users, categories, brands, collections, coupons, foods
 *
 * Skip conditions:
 *   - Draft / deleted documents (status === 'draft' | 'deleted')
 *   - Private user accounts
 *   - Documents explicitly flagged _noIndex: true
 */

'use strict';

const { onDocumentCreated, onDocumentUpdated, onDocumentDeleted } = require('firebase-functions/v2/firestore');
const { enqueue } = require('./algolia-queue');

/* ── Skip guard ─────────────────────────────────────────────────────── */

function _shouldSkip(data, collection) {
  if (!data) return true;
  if (data._noIndex === true) return true;
  if (data.status === 'draft' || data.status === 'deleted') return true;
  if (collection === 'users' && (data.private === true || data.status === 'banned')) return true;
  return false;
}

function _shouldSkipAfterUpdate(before, after) {
  /* If the document transitioned INTO a skip state, delete from index */
  const nowSkip    = _shouldSkip(after);
  const wasSkip    = _shouldSkip(before);
  if (nowSkip && !wasSkip) return 'delete';  // remove from index
  if (nowSkip && wasSkip)  return 'ignore';  // never was indexed
  return 'update';
}

/* ── Trigger factory ────────────────────────────────────────────────── */

/**
 * Creates onCreate, onUpdate, onDelete triggers for a Firestore collection.
 * @param {string} col   - Firestore collection name
 * @param {object} opts  - { skipDraft: bool }
 */
function _makeTriggers(col, { skipDraft = true } = {}) {
  return {

    [`algoliaSync_${col}_create`]: onDocumentCreated(
      { document: `${col}/{docId}`, timeoutSeconds: 60 },
      async (event) => {
        const data  = event.data?.data();
        const docId = event.params.docId;
        if (!data || (skipDraft && _shouldSkip(data, col))) return;
        await enqueue({ collection: col, docId, operation: 'upsert', data });
      }
    ),

    [`algoliaSync_${col}_update`]: onDocumentUpdated(
      { document: `${col}/{docId}`, timeoutSeconds: 60 },
      async (event) => {
        const before = event.data?.before?.data() || {};
        const after  = event.data?.after?.data()  || {};
        const docId  = event.params.docId;
        const action = _shouldSkipAfterUpdate(before, after);

        if (action === 'ignore') return;
        if (action === 'delete') {
          await enqueue({ collection: col, docId, operation: 'delete' });
          return;
        }

        await enqueue({
          collection:  col,
          docId,
          operation:   'partial',
          data:        after,
          beforeData:  before,
        });
      }
    ),

    [`algoliaSync_${col}_delete`]: onDocumentDeleted(
      { document: `${col}/{docId}`, timeoutSeconds: 60 },
      async (event) => {
        const docId = event.params.docId;
        await enqueue({ collection: col, docId, operation: 'delete' });
      }
    ),

  };
}

/* ═══════════════════════════════════════════════════════════════════════
   ALL COLLECTION TRIGGERS
════════════════════════════════════════════════════════════════════════ */

const triggers = {
  /* ── Core collections ── */
  ..._makeTriggers('products'),
  ..._makeTriggers('sellers'),
  ..._makeTriggers('providers'),
  ..._makeTriggers('services'),
  ..._makeTriggers('events'),
  ..._makeTriggers('properties'),
  ..._makeTriggers('cars'),
  ..._makeTriggers('digitalJobs'),
  ..._makeTriggers('jobs'),
  ..._makeTriggers('users'),
  ..._makeTriggers('categories', { skipDraft: false }),
  ..._makeTriggers('brands',     { skipDraft: false }),
  ..._makeTriggers('collections'),
  ..._makeTriggers('coupons'),
  ..._makeTriggers('foods'),

  /* ── Production aliases — Firestore collection names → Algolia index names ──
     Each also automatically fans out to global_search via enqueue() in queue.js.
     stores     → stores_index   (Firestore: 'stores', same data model as sellers)
     real_estate→ property_index (Firestore: 'real_estate', same as properties)
     vehicles   → vehicles_index (Firestore: 'vehicles', same as cars)
     vendors    — REMOVED: vendors is already handled by search-sync.js to avoid
                  duplicate triggers (each vendors write was firing 2× functions)
  ── */
  ..._makeTriggers('stores'),
  ..._makeTriggers('real_estate'),
  ..._makeTriggers('vehicles'),
};

module.exports = triggers;
