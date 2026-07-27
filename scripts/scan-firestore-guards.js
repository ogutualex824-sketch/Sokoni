/**
 * scripts/scan-firestore-guards.js
 *
 * Finds client list queries on rule-gated collections that carry no matching
 * where() clause. Firestore refuses to run a query it cannot prove is safe, so
 * such a query is denied outright — and because callers swallow the denial in a
 * catch, the failure shows up as an empty screen rather than an error. That is
 * how the search page, the business page's services and reviews, the provider
 * directory and several hub listeners all came to display nothing.
 *
 * Admin-only screens will appear here and are usually fine: isAdmin() in the
 * rule makes the query provably safe for an admin and correctly denies everyone
 * else. Judge each hit against the rule it belongs to.
 *
 * Run: node scripts/scan-firestore-guards.js
 */

/* Find client list queries on rule-gated collections that carry no matching where(). */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GATED = {
  services: ['status'], providers: ['status'], properties: ['status'],
  propertyListings: ['status'], vehicles: ['status'], digitalJobs: ['status'],
  healthProviders: ['status'], reviews: ['status'], venues: ['status'],
  orders: ['uid', 'userId', 'buyerId', 'buyerUid', 'sellerUid', 'sellerId', 'assignedDriverUid'],
  bookings: ['customerId', 'buyerId', 'userId', 'providerId', 'sellerUid'],
  packageRequests: ['uid', 'buyerUid', 'sellerUid', 'assignedDriverId'],
  applications: ['uid', 'ownerUid'], disputes: ['uid', 'buyerUid', 'sellerUid'],
  healthAppointments: ['patientUid', 'providerId'],
};

const files = fs.readdirSync(ROOT).filter(f => /\.(html|js)$/.test(f));
const hits = [];

for (const f of files) {
  const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = line.match(/collection\(\s*(?:_?db|window\.firebaseDB|firestore)\s*,\s*['"]([A-Za-z_]+)['"]/);
    if (!m || !GATED[m[1]]) return;
    const ctx = lines.slice(Math.max(0, i - 2), i + 8).join(' ');
    if (!/getDocs|onSnapshot/.test(ctx)) return;                 // not a list query
    if (/getCountFromServer/.test(ctx)) return;
    const win = lines.slice(i, i + 6).join(' ');
    const ok = GATED[m[1]].some(field => win.includes("'" + field + "'") || win.includes('"' + field + '"'));
    if (!ok) hits.push(`${f}:${i + 1}  ${m[1]}  ->  ${line.trim().slice(0, 90)}`);
  });
}

console.log('guard-less list queries on rule-gated collections:\n');
hits.forEach(h => console.log('  ' + h));
console.log('\ntotal: ' + hits.length);
