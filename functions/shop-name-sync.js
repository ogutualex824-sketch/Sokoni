/**
 * SOKONI — Shop-name fan-out
 *
 * The shop/seller display name is denormalised onto every product document as
 * `sellerName`, and the search record (algolia-indexer.js) copies it into
 * `seller.name`. That denormalisation is what makes product cards and search
 * results render instantly without a per-card shop lookup — but it also means a
 * shop RENAME leaves the old name stranded on every existing product, in
 * Firestore and in both search indexes, until each product is re-saved by hand.
 *
 * This trigger closes that gap. When a shop's effective name changes on either
 * `shops/{uid}` or `sellers/{uid}` (the two collections store.html reads, in that
 * order), it fans the new name out to every product owned by that shop
 * (`products where sellerUid == uid`). Each product write then rides the existing
 * `algoliaSync_products_update` / typesense triggers, so the search indexes are
 * corrected automatically — no separate reindex path to keep in sync.
 *
 * Safety:
 *  - Fires only when the effective name actually changed (name || storeName),
 *    so unrelated shop-doc edits (hours, logo, till) don't fan out.
 *  - Never propagates an empty name — a cleared field must not wipe product labels.
 *  - Writes only to `products`, never back to the shop doc, so there is no
 *    trigger loop.
 *  - Paginated + chunked into ≤400-doc batches so a shop with thousands of
 *    products still completes within Firestore's 500-writes-per-batch limit.
 */

'use strict';

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');

const db = admin.firestore;

/* Chunk under Firestore's hard 500-writes-per-batch limit, with headroom. */
const BATCH_SIZE = 400;

/** Effective display name for a shop/seller doc — mirrors store.html's read. */
function _effectiveName(data) {
  if (!data) return '';
  const n = data.name || data.storeName || '';
  return typeof n === 'string' ? n.trim() : '';
}

/**
 * Fan a renamed shop's new name out across all of its products.
 * @param {string} shopUid  the shop/seller document id (== product.sellerUid)
 * @param {string} newName  the new, non-empty effective name
 * @returns {Promise<number>} number of product docs updated
 */
async function _fanOutName(shopUid, newName) {
  const firestore = db();
  const products  = firestore.collection('products');
  let updated = 0;
  let last    = null;

  /* Paginate by document id so the pass is stable even while products change.
     Equality on sellerUid + orderBy(documentId) needs only the automatic
     single-field index — no composite index to provision. */
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let q = products
      .where('sellerUid', '==', shopUid)
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(BATCH_SIZE);
    if (last) q = q.startAfter(last);

    const snap = await q.get();
    if (snap.empty) break;

    const batch = firestore.batch();
    let ops = 0;
    snap.forEach((doc) => {
      /* Skip products already carrying the new name — avoids needless writes
         and needless reindex enqueues on a re-run. */
      if ((doc.get('sellerName') || '') === newName) return;
      batch.update(doc.ref, {
        sellerName:         newName,
        sellerNameSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      ops += 1;
    });
    /* Commit only when the page produced writes — an all-skipped page (e.g. a
       re-run) yields an empty batch, which is a needless round-trip at best. */
    if (ops > 0) {
      await batch.commit();
      updated += ops;
    }

    last = snap.docs[snap.docs.length - 1];
    if (snap.size < BATCH_SIZE) break;
  }

  return updated;
}

/** Build an onDocumentUpdated trigger for a shop/seller collection. */
function _makeShopNameTrigger(col) {
  return onDocumentUpdated(
    { document: `${col}/{shopUid}`, timeoutSeconds: 300 },
    async (event) => {
      const before  = event.data?.before?.data() || {};
      const after   = event.data?.after?.data()  || {};
      const shopUid = event.params.shopUid;

      const oldName = _effectiveName(before);
      const newName = _effectiveName(after);

      /* Only a real, non-empty rename fans out. */
      if (!newName || newName === oldName) return;

      try {
        const n = await _fanOutName(shopUid, newName);
        console.log(`[shopNameSync:${col}] ${shopUid}: "${oldName}" → "${newName}" — ${n} product(s) updated`);
      } catch (e) {
        /* A fan-out failure must be visible but must not crash the shop write. */
        console.error(`[shopNameSync:${col}] ${shopUid} fan-out failed:`, e.message || e);
      }
    }
  );
}

module.exports = {
  shopNameSync_shops:   _makeShopNameTrigger('shops'),
  shopNameSync_sellers: _makeShopNameTrigger('sellers'),
  /* exported for unit testing */
  _effectiveName,
  _fanOutName,
};
