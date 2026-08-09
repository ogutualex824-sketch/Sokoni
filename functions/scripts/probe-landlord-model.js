'use strict';
/**
 * landlordData model probe — measure before recommending.
 *
 *   node functions/scripts/probe-landlord-model.js
 *
 * Option A (landlordData/{uid} with a properties array) vs Option B (a
 * landlordProperties collection) vs Option C (fold into bnbListings) cannot be
 * chosen from first principles: the answer depends on how many landlords exist,
 * how many properties each holds, and how large the documents actually are.
 *
 * Read-only.
 */

const admin = require('firebase-admin');
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'sokoni-aeb26' });
const db = admin.firestore();

const MAX_DOC_BYTES = 1048576;   /* Firestore hard limit, 1 MiB */

(async () => {
  console.log('\nlandlordData — production measurement');
  console.log('='.repeat(70));

  const snap = await db.collection('landlordData').get();
  console.log('documents (landlords): ' + snap.size);

  if (snap.empty) {
    console.log('\nCollection is EMPTY in production.');
  }

  let totalProps = 0, maxProps = 0, maxBytes = 0, docsWithArray = 0;
  const fields = {};
  snap.forEach(d => {
    const x = d.data();
    Object.keys(x).forEach(k => { fields[k] = (fields[k] || 0) + 1; });
    const props = Array.isArray(x.properties) ? x.properties : null;
    if (props) {
      docsWithArray++;
      totalProps += props.length;
      if (props.length > maxProps) maxProps = props.length;
    }
    const bytes = Buffer.byteLength(JSON.stringify(x), 'utf8');
    if (bytes > maxBytes) maxBytes = bytes;
  });

  console.log('docs carrying a properties[] : ' + docsWithArray);
  console.log('total properties across all  : ' + totalProps);
  console.log('largest properties[]         : ' + maxProps);
  console.log('largest document             : ' + maxBytes + ' bytes ('
    + (maxBytes / MAX_DOC_BYTES * 100).toFixed(3) + '% of the 1 MiB limit)');
  if (maxProps > 0) {
    const perProp = Math.round(maxBytes / Math.max(1, maxProps));
    console.log('approx bytes per property    : ' + perProp);
    console.log('properties before 1 MiB      : ~' + Math.floor(MAX_DOC_BYTES / Math.max(1, perProp)));
  }
  if (Object.keys(fields).length) {
    console.log('\nfields present:');
    Object.entries(fields).sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => console.log('  ' + k.padEnd(22) + v + '/' + snap.size));
  }

  /* The alternatives, for comparison. */
  console.log('\nComparison collections');
  console.log('-'.repeat(70));
  for (const name of ['landlordProperties', 'bnbListings', 'properties', 'propertyListings']) {
    const s = await db.collection(name).limit(1).get();
    const c = s.empty ? 0 : (await db.collection(name).count().get()).data().count;
    console.log('  ' + name.padEnd(24) + c + ' documents');
  }

  /* Does any index or rule already anticipate Option B? */
  console.log('\nDeclared Firestore indexes touching these');
  console.log('-'.repeat(70));
  const idx = require('../../firestore.indexes.json');
  const rel = (idx.indexes || []).filter(i =>
    /landlord|bnb|propert/i.test(i.collectionGroup));
  if (!rel.length) console.log('  (none)');
  rel.forEach(i => console.log('  ' + i.collectionGroup.padEnd(22)
    + i.fields.map(f => f.fieldPath + ':' + (f.order || f.arrayConfig)).join(', ')));

  console.log('');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.code || '', e.message); process.exit(1); });
