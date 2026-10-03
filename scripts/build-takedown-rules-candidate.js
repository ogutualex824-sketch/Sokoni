#!/usr/bin/env node
/* build-takedown-rules-candidate.js — the TAKEDOWN rules candidate, built from the SERVED ruleset text (2026-10-02).
 *
 *   node scripts/build-takedown-rules-candidate.js <served-ruleset-file> [--check]
 *
 * INPUT  : the source of the ruleset that serves production, fetched read-only from the Rules API
 *          (releases/cloud.firestore → rulesetName → source). Its sha256 is PINNED below: a different input is refused,
 *          so the candidate can never be built from a stale local file (spec §28).
 * OUTPUT : firestore.rules.takedown-candidate = that exact text + ONLY these hunks:
 *   T1 products (create)  a seller can never write moderationHold / moderationReleased
 *   T2 products (update)  moderationHold / moderationReleased are server-only for EVERY client (admin included — the
 *                         authorised restore is the audited tsReviewReport callable, Admin SDK); and while the product
 *                         carries a moderationHold, no client may change the enforcement fields (isVisible, visible,
 *                         hidden, status, active, isActive, published, moderationStatus, deleted, isDeleted). Ordinary
 *                         commerce fields (name, price, stock, description, images …) stay editable by the seller.
 *                         With NO hold, the seller's availability switch (isVisible / status) works exactly as served.
 *                         A seller cannot DELETE a held product either: delete + re-create under the same id would
 *                         otherwise bring the listing back at the same URL with no hold (a self-restore).
 *   T5 products (get)     a single-document read of a product under a moderationHold is refused to everyone except
 *                         its seller (sellerUid) and admins, so a direct link / product page can never render a
 *                         taken-down listing from Firestore. `list` (queries) is unchanged — rules are not filters,
 *                         and gating list on the hold would refuse every public product query; list surfaces are
 *                         covered by the indexes + server gates + SokoniSellability (recorded as the residual).
 *   T3 reports            client write → false (every write is a callable: tsReportContent / tsReviewReport)
 *   T4 fraudAlerts        the two same-depth match blocks collapse to ONE: create false (server writers only),
 *                         read/update moderator, delete admin
 * Each hunk must apply EXACTLY once or the build fails (fail closed). `--check` builds in memory and prints the
 * measurement without writing.
 */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const SERVED_ID = 'f259c0b5-0a9e-49c5-8578-a628a40d946c';
const SERVED_SHA = '78d938fd9785ab8fcd310f7a926f98f9aafab0231142a3f7cac8346ec301d447';
const OUT = path.join(ROOT, 'firestore.rules.takedown-candidate');

const src = process.argv[2];
if (!src) { console.error('usage: build-takedown-rules-candidate.js <served-ruleset-file> [--check]'); process.exit(2); }
const served = fs.readFileSync(src, 'utf8');
const sha = crypto.createHash('sha256').update(served).digest('hex');
if (sha !== SERVED_SHA) { console.error(`REFUSED: input sha256 ${sha} is not the served ruleset ${SERVED_ID} (${SERVED_SHA})`); process.exit(3); }

const ENFORCEMENT = "['isVisible','visible','hidden','status','active','isActive','published','moderationStatus','deleted','isDeleted']";
const HUNKS = [
  { id: 'T0 helper', from:
`  function noBase64Image() {`, to:
`  function noModerationWrite() {
  return resource == null
  ? !request.resource.data.keys().hasAny(['moderationHold','moderationReleased'])
  : (!request.resource.data.diff(resource.data).affectedKeys().hasAny(['moderationHold','moderationReleased'])
  && (resource.data.get('moderationHold', null) == null
  || !request.resource.data.diff(resource.data).affectedKeys().hasAny(${ENFORCEMENT})));
  }
  function noBase64Image() {` },
  { id: 'T5 products read (get gated on the hold; list unchanged)', from:
`  match /products/{productId} {
  allow read:   if true;`, to:
`  match /products/{productId} {
  allow list:   if true;
  allow get:    if resource == null
  || resource.data.get('moderationHold', null) == null
  || isAdmin()
  || (isAuthed() && resource.data.get('sellerUid', '') == request.auth.uid);` },
  { id: 'T1 products create', from:
`  && validPrice('price')
  && noAdminFields()
  && noBase64Image()
  && withinProductLimit();`, to:
`  && validPrice('price')
  && noAdminFields()
  && noModerationWrite()
  && noBase64Image()
  && withinProductLimit();` },
  { id: 'T2 products update', from:
`  allow update: if isAdmin()
  || (isAuthed() && isSeller()
  && resource.data.sellerUid == request.auth.uid
  && !request.resource.data.diff(resource.data)
  .affectedKeys()
  .hasAny(['sellerUid'])
  && noAdminFields()
  && noBase64Image());
  allow delete: if isAdmin()
  || (isAuthed() && isSeller() && resource.data.sellerUid == request.auth.uid);
  }
  match /listings/{listingId} {`, to:
`  allow update: if noModerationWrite() && (isAdmin()
  || (isAuthed() && isSeller()
  && resource.data.sellerUid == request.auth.uid
  && !request.resource.data.diff(resource.data)
  .affectedKeys()
  .hasAny(['sellerUid'])
  && noAdminFields()
  && noBase64Image()));
  allow delete: if isAdmin()
  || (isAuthed() && isSeller() && resource.data.sellerUid == request.auth.uid
  && resource.data.get('moderationHold', null) == null);
  }
  match /listings/{listingId} {` },
  { id: 'T3 reports', from:
`  match /reports/{reportId} {
  allow read:  if isAdmin();
  allow create: if false;
  allow write:  if isAdmin();
  }`, to:
`  match /reports/{reportId} {
  allow read:  if isAdmin();
  allow write: if false;
  }` },
  { id: 'T4a fraudAlerts (first block → the one rule)', from:
`  match /fraudAlerts/{alertId} {
  allow create: if isAuthed()
  && request.resource.data.flaggedBy == request.auth.uid
  && request.resource.data.keys().hasAll(['targetId','reason','flaggedBy']);
  allow read:   if isModerator();
  allow update: if isModerator();
  allow delete: if isAdmin();
  }`, to:
`  match /fraudAlerts/{alertId} {
  allow create: if false;
  allow read:   if isModerator();
  allow update: if isModerator();
  allow delete: if isAdmin();
  }` },
  { id: 'T4b fraudAlerts (second block removed)', from:
`  match /fraudAlerts/{alertId} {
  allow read:   if isAdmin();
  allow update: if isAdmin();
  }
`, to: `` },
];

let out = served;
for (const h of HUNKS) {
  const n = out.split(h.from).length - 1;
  if (n !== 1) { console.error(`FAILED: hunk "${h.id}" matched ${n} times (must be exactly 1)`); process.exit(4); }
  out = out.replace(h.from, () => h.to);
}
/* every touched collection must end with exactly ONE match block */
for (const coll of ['products', 'reports', 'fraudAlerts']) {
  const n = (out.match(new RegExp(`match /${coll}/\\{`, 'g')) || []).length;
  if (n !== 1) { console.error(`FAILED: ${coll} has ${n} match blocks`); process.exit(5); }
}
const bytes = Buffer.byteLength(out, 'utf8'), sbytes = Buffer.byteLength(served, 'utf8');
console.log(`served ${SERVED_ID}: ${sbytes} B (sha ${SERVED_SHA.slice(0, 12)})`);
console.log(`candidate: ${bytes} B (+${bytes - sbytes}) sha ${crypto.createHash('sha256').update(out).digest('hex').slice(0, 12)}`);
console.log(`hunks applied: ${HUNKS.map((h) => h.id).join(' · ')}`);
if (!process.argv.includes('--check')) { fs.writeFileSync(OUT, out); console.log('wrote ' + path.relative(ROOT, OUT)); }
