/* Backfill `status: "active"` onto product documents that predate the fix.
 *
 *   node functions/scripts/backfill-product-status.js            # dry run
 *   node functions/scripts/backfill-product-status.js --apply    # write
 *
 * WHY THIS IS NEEDED
 * seller.js now writes a top-level `status` on upload, but that only helps
 * products created from here on. Every product uploaded BEFORE that change has
 * no `status` field, and every retrieval path filters
 * where('status','==','active') — which never matches an absent field. Those
 * products are in Firestore and invisible to search until this runs.
 *
 * SAFETY
 *  - Dry run by default; prints what it would change and writes nothing.
 *  - Only ADDS the field. Never overwrites an existing status, so a product
 *    deliberately set to draft/deleted/archived is left alone.
 *  - Batched at 400 (under the 500 limit) and resumable — re-running is
 *    harmless because documents that already have a status are skipped.
 *
 * AFTER THIS, RUN THE ALGOLIA BACKFILL. Fixing the field does not re-index
 * anything; products written to the old `products_index` stay there and stay
 * unreachable until algoliaBackfill (functions/index.js) repopulates
 * sokoni_products.
 */
'use strict';

const admin = require('firebase-admin');
const APPLY = process.argv.includes('--apply');
const COLLECTIONS = ['products', 'foods'];
const BATCH = 400;

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

async function backfillCollection(name) {
  const snap = await db.collection(name).get();
  let missing = 0, present = 0, written = 0;
  let batch = db.batch(), inBatch = 0;

  for (const doc of snap.docs) {
    const d = doc.data() || {};
    if (typeof d.status === 'string' && d.status.trim()) { present++; continue; }
    missing++;
    if (!APPLY) {
      if (missing <= 10) console.log('    would set status=active  ' + name + '/' + doc.id +
        '   "' + String(d.name || d.title || '(untitled)').slice(0, 40) + '"');
      continue;
    }
    batch.update(doc.ref, { status: 'active', statusBackfilledAt: admin.firestore.FieldValue.serverTimestamp() });
    if (++inBatch >= BATCH) { await batch.commit(); written += inBatch; batch = db.batch(); inBatch = 0; }
  }
  if (APPLY && inBatch) { await batch.commit(); written += inBatch; }

  console.log('  ' + name + ': ' + snap.size + ' docs, ' + present + ' already had status, ' +
    missing + ' missing' + (APPLY ? ', ' + written + ' updated' : ''));
  return { missing, written };
}

(async () => {
  console.log(APPLY ? 'APPLYING changes\n' : 'DRY RUN — nothing will be written. Re-run with --apply.\n');
  let totalMissing = 0, totalWritten = 0;
  for (const c of COLLECTIONS) {
    try {
      const r = await backfillCollection(c);
      totalMissing += r.missing; totalWritten += r.written;
    } catch (e) {
      console.error('  ' + c + ': FAILED — ' + e.message);
    }
  }
  console.log('\n' + totalMissing + ' document(s) missing status' + (APPLY ? '; ' + totalWritten + ' updated' : ''));
  if (!APPLY && totalMissing) console.log('Re-run with --apply to write, then run algoliaBackfill to re-index.');
  process.exit(0);
})();
