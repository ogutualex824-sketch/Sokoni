'use strict';
/**
 * Properties data source — does a canonical Firestore collection exist?
 *
 *   node functions/scripts/probe-properties-source.js
 *
 * The admin Properties pane reads D.bnbListings / D.bnbBookings / D.landlordProps
 * from localStorage. Before proposing a migration, establish whether there is
 * anything in Firestore to migrate TO — and whether it already holds real data.
 *
 * Read-only.
 */

const admin = require('firebase-admin');
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'sokoni-aeb26' });
const db = admin.firestore();

/* Every plausible home for this data. Guessing one and reporting "absent" would
   be worse than useless, so all of them are checked. */
const CANDIDATES = [
  'bnbListings', 'bnbs', 'bnb', 'bnbBookings', 'bnbBooking',
  'properties', 'propertyListings', 'landlordProperties', 'landlordProps',
  'realEstate', 'rentals', 'listings', 'venues', 'venueBookings',
  'accommodation', 'stays',
];

(async () => {
  console.log('\nPROPERTIES — candidate Firestore collections');
  console.log('='.repeat(66));

  const found = [];
  for (const name of CANDIDATES) {
    try {
      const snap = await db.collection(name).limit(3).get();
      const label = name.padEnd(22);
      if (snap.empty) { console.log('  ' + label + '0 documents'); continue; }
      found.push({ name, size: snap.size, sample: snap.docs[0].data() });
      console.log('  ' + label + snap.size + '+ documents   <-- EXISTS');
    } catch (e) {
      console.log('  ' + name.padEnd(22) + 'ERROR ' + (e.code || e.message));
    }
  }

  /* Root collections actually present, so nothing is missed by guessing names. */
  console.log('\nALL ROOT COLLECTIONS IN THE PROJECT');
  console.log('='.repeat(66));
  const all = await db.listCollections();
  const names = all.map(c => c.id).sort();
  console.log('  total: ' + names.length);
  const relevant = names.filter(n => /bnb|propert|landlord|rent|stay|accommod|venue|listing/i.test(n));
  console.log('  property-related: ' + (relevant.length ? relevant.join(', ') : '(none)'));

  for (const f of found) {
    console.log('\nSAMPLE — ' + f.name);
    console.log('-'.repeat(66));
    const keys = Object.keys(f.sample);
    console.log('  fields: ' + keys.join(', '));
  }

  /* Counts for whatever was found, so "exists" is not confused with "populated". */
  if (found.length) {
    console.log('\nDOCUMENT COUNTS');
    console.log('-'.repeat(66));
    for (const f of found) {
      const c = await db.collection(f.name).count().get();
      console.log('  ' + f.name.padEnd(22) + c.data().count);
    }
  }

  console.log('');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.code || '', e.message); process.exit(1); });
