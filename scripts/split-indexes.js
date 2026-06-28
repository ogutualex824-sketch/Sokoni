#!/usr/bin/env node
/**
 * SOKONI Index Splitter
 * Splits firestore.indexes.json into primary (200) and sokoni-ops (26) databases.
 * Run: node scripts/split-indexes.js
 *
 * Primary database  → firestore.indexes.json          (≤200 indexes, default Firestore DB)
 * sokoni-ops DB     → firestore.indexes.sokoni-ops.json (remaining indexes, admin/monitoring DB)
 *
 * Deploy commands after running:
 *   firebase deploy --only firestore:indexes
 *   firebase deploy --only firestore:indexes --database sokoni-ops --config firestore.indexes.sokoni-ops.json
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Collections that belong in the sokoni-ops admin/monitoring database.
// These are queue tables, audit logs, monitoring snapshots, and ancillary
// pipeline collections that do not serve live customer traffic.
// ---------------------------------------------------------------------------
const SOKONI_OPS_COLLECTIONS = [
  // Security / audit
  'adminAlerts',
  'eccAuditLog',
  'eccIncidents',

  // eTIMS / KRA pipeline
  'etimsAlerts',
  'etimsQueue',

  // Delivery / logistics ops
  'deliveryLocations',
  'deliveryProofs',
  'hubInvoiceQueue',

  // Reporting & scheduling
  'reportSchedules',
  'operationsReports',
  'healthSnapshots',
  'certificationReports',

  // Search / indexing pipelines
  'algoliaQueue',
  'typesenseQueue',

  // Notification / email pipelines
  'notificationQueue',
  'emailLogs',
  'emailQueue',

  // Content moderation
  'contentFlags',
  'moderationQueue',

  // Miscellaneous ops & analytics queues
  'selfHealLog',
  'deviceAuditLog',
  'chaosTestReports',
  'bootstrapCache',

  // Ancillary tracking collections
  'bookingFees',
  'bookingHolds',
  'trending',
  'voucherRedemptions',
  'productPriceHistory',
];

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const ROOT        = path.resolve(__dirname, '..');
const PRIMARY_OUT = path.join(ROOT, 'firestore.indexes.json');
const OPS_OUT     = path.join(ROOT, 'firestore.indexes.sokoni-ops.json');

// ---------------------------------------------------------------------------
// Read source file
// ---------------------------------------------------------------------------
if (!fs.existsSync(PRIMARY_OUT)) {
  console.error('ERROR: firestore.indexes.json not found at', PRIMARY_OUT);
  process.exit(1);
}

let source;
try {
  source = JSON.parse(fs.readFileSync(PRIMARY_OUT, 'utf8'));
} catch (err) {
  console.error('ERROR: Failed to parse firestore.indexes.json:', err.message);
  process.exit(1);
}

const allIndexes     = source.indexes || [];
const fieldOverrides = source.fieldOverrides || [];

if (allIndexes.length === 0) {
  console.error('ERROR: No indexes found in firestore.indexes.json');
  process.exit(1);
}

console.log(`\nSOKONI Index Splitter`);
console.log(`${'─'.repeat(50)}`);
console.log(`Total indexes read: ${allIndexes.length}`);

// ---------------------------------------------------------------------------
// Split
// ---------------------------------------------------------------------------
const opsIndexes     = allIndexes.filter(i => SOKONI_OPS_COLLECTIONS.includes(i.collectionGroup));
const primaryIndexes = allIndexes.filter(i => !SOKONI_OPS_COLLECTIONS.includes(i.collectionGroup));

console.log(`Primary candidates: ${primaryIndexes.length}`);
console.log(`sokoni-ops candidates: ${opsIndexes.length}`);

// ---------------------------------------------------------------------------
// Safety check — primary must not exceed 200
// ---------------------------------------------------------------------------
if (primaryIndexes.length > 200) {
  console.error(`\nERROR: Primary database would have ${primaryIndexes.length} indexes (limit: 200).`);
  console.error(`Move ${primaryIndexes.length - 200} more collection(s) into SOKONI_OPS_COLLECTIONS.\n`);

  // Show the top collections by index count to help the engineer decide what to move
  const counts = {};
  primaryIndexes.forEach(i => {
    counts[i.collectionGroup] = (counts[i.collectionGroup] || 0) + 1;
  });
  const sorted = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);

  console.error('Top 20 collections in primary database by index count:');
  sorted.forEach(([col, cnt]) => {
    console.error(`  ${cnt.toString().padStart(3)}  ${col}`);
  });

  process.exit(1);
}

// ---------------------------------------------------------------------------
// Write outputs
// ---------------------------------------------------------------------------
const primaryDoc = {
  indexes: primaryIndexes,
  fieldOverrides: fieldOverrides,
};

const opsDoc = {
  indexes: opsIndexes,
  fieldOverrides: [],
};

fs.writeFileSync(PRIMARY_OUT, JSON.stringify(primaryDoc, null, 2) + '\n', 'utf8');
fs.writeFileSync(OPS_OUT,     JSON.stringify(opsDoc,     null, 2) + '\n', 'utf8');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${'─'.repeat(50)}`);
console.log(`✓ Primary database:  ${primaryIndexes.length.toString().padStart(3)} indexes  → firestore.indexes.json`);
console.log(`✓ sokoni-ops:        ${opsIndexes.length.toString().padStart(3)} indexes  → firestore.indexes.sokoni-ops.json`);
console.log(`\n${'─'.repeat(50)}`);
console.log(`\nDeploy commands:`);
console.log(`  firebase deploy --only firestore:indexes`);
console.log(`  firebase deploy --only firestore:indexes --database sokoni-ops --config firestore.indexes.sokoni-ops.json`);
console.log('');
