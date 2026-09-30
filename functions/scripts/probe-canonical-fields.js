'use strict';
/**
 * Canonical field probe — how is each concept ACTUALLY represented?
 *
 *   node functions/scripts/probe-canonical-fields.js
 *
 * The canonical model document has to say what is true, not what the code
 * intends. Every duplicated field found so far (role/roles, phone/phoneNumber,
 * joined/createdAt) was discovered by measuring rather than by reading, and each
 * one had a coverage split that changed the recommendation.
 *
 * Read-only.
 */

const admin = require('firebase-admin');
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'sokoni-aeb26' });
const db = admin.firestore();

/* Concepts that appear under more than one field name across the platform. */
const VARIANTS = {
  'identity':   ['uid', 'ownerUid', 'hostUid', 'tenantUid', 'sellerId', 'providerId', 'userId', 'customerId'],
  'role':       ['role', 'roles', 'type', 'accountType', 'registeredAs'],
  'phone':      ['phone', 'phoneNumber', 'contact', 'tel'],
  'created':    ['createdAt', 'joined', 'submittedAt', 'ts', 'timestamp', 'dateCreated'],
  'updated':    ['updatedAt', 'modifiedAt', 'lastUpdated'],
  'status':     ['status', 'state', 'approvalStatus', 'projectionStatus'],
  'verified':   ['verified', 'isVerified', 'verificationStatus'],
  'location':   ['city', 'location', 'area', 'county', 'address'],
  'name':       ['name', 'displayName', 'title', 'businessName', 'fullName'],
};

const COLLECTIONS = [
  'users', 'applications', 'providers', 'orders', 'bookings', 'bnbListings',
  'bnbBookings', 'products', 'sellers', 'platformEmployees', 'invitations',
  'payments', 'posPayments', 'commissions', 'auditLogs', 'notifications',
];

(async () => {
  console.log('\nCANONICAL FIELD PROBE');
  console.log('='.repeat(88));

  const statusVocab = {};

  for (const col of COLLECTIONS) {
    let snap;
    try { snap = await db.collection(col).limit(300).get(); }
    catch (e) { console.log('\n' + col + ' — ERROR ' + (e.code || e.message)); continue; }

    if (snap.empty) { console.log('\n' + col.padEnd(22) + '0 documents'); continue; }

    const present = {};
    snap.forEach(d => Object.keys(d.data()).forEach(k => { present[k] = (present[k] || 0) + 1; }));

    console.log('\n' + col + '  (' + snap.size + ' sampled)');
    console.log('-'.repeat(88));
    for (const [concept, names] of Object.entries(VARIANTS)) {
      const hits = names.filter(n => present[n]).map(n =>
        n + ' ' + Math.round(present[n] / snap.size * 100) + '%');
      if (hits.length > 1) {
        console.log('  ' + concept.padEnd(12) + 'SPLIT -> ' + hits.join('  |  '));
      } else if (hits.length === 1) {
        console.log('  ' + concept.padEnd(12) + hits[0]);
      }
    }

    /* Status vocabulary per collection — the values, not just the field. */
    const vals = new Set();
    snap.forEach(d => { const s = d.data().status; if (typeof s === 'string') vals.add(s); });
    if (vals.size) {
      statusVocab[col] = [...vals].sort();
      console.log('  status values: ' + [...vals].sort().join(', '));
    }
  }

  console.log('\n\nSTATUS VOCABULARIES SIDE BY SIDE');
  console.log('='.repeat(88));
  Object.entries(statusVocab).forEach(([c, v]) =>
    console.log('  ' + c.padEnd(20) + v.join(', ')));

  console.log('');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.code || '', e.message); process.exit(1); });
