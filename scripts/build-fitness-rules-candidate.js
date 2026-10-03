#!/usr/bin/env node
/* build-fitness-rules-candidate.js — the FITNESS rules candidate, built from the SERVED Firestore ruleset (2026-10-03).
 *
 *   node scripts/build-fitness-rules-candidate.js firestore.rules.served-f259c0b5 [--check]
 *   node scripts/build-fitness-rules-candidate.js <other-ruleset> --onto --out <file>    (merge onto another line)
 *
 * INPUT  : the source of the ruleset that serves production, fetched read-only from the Rules API
 *          (releases/cloud.firestore → rulesetName → source) on 2026-10-03. Its sha256 is PINNED: a different input is
 *          refused, so the candidate can never be built from a stale local file. `--onto` lifts the pin ONLY to apply the
 *          same hunks onto another rules line (e.g. f3's rules/capability-decisions-on-f20be7d, the combined candidate);
 *          every hunk must still match exactly once there, or the build fails closed.
 * OUTPUT : firestore.rules.fitness-candidate = served text + ONLY these hunks:
 *   FB  fitness_bookings         read → admin; client write → false   (D-3: the client minted status:'confirmed')
 *   FG  fitness_gyms             owner keeps profile edits; rating / ratingCount / reviewCount / members / memberCount /
 *                                verified / status / moderation* / hidden / isVisible are owner-immutable (create + update)
 *   FC  fitness_classes          read → admin; client write → false   (D-5 unmoderated public listings)
 *   FL  fitness_clubs            read → admin; client write → false   (D-5)
 *   FP  fitness_community_posts  read → admin; client write → false
 *   FE  fitness_equipment        read → admin; client write → false   (D-10 second catalogue)
 *   FR  fitness_requests         read → admin; client write → false   (D-14 phones exposed to every signed-in user)
 *   FH  fitness_challenges       read → admin; client write → false   (D-14 forgeable pts)
 *   FK  fitness_checkins         read → admin; client write → false   (D-14 member names; attendance truth = providerMemberships)
 *   FM  providerMemberships/{id} (+ attendance / events / releases) and fitnessMembershipClaims — NEW, server-written only
 * Reads of the eight legacy collections go to admin because NO client reader survives F0 (hosting/fitness-containment-on-
 * 72dca56 keeps only fitness_progress); on live 72dca56 the only reader is fitness-hub.html (classes, clubs, bookings).
 * => this candidate must ship AFTER the F0 hosting deploy (see docs/rules/FITNESS_RULES_DIFF.md).
 * fitness_progress, providers, providerPayouts: UNCHANGED (verified owner-only / f3 owns providers.business /
 * payouts already provider-own + admin read, no client write).
 */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const SERVED_ID = 'f259c0b5-0a9e-49c5-8578-a628a40d946c';
const SERVED_SHA = '78d938fd9785ab8fcd310f7a926f98f9aafab0231142a3f7cac8346ec301d447';

const args = process.argv.slice(2);
const src = args[0];
const onto = args.includes('--onto');
const outIdx = args.indexOf('--out');
const OUT = outIdx > -1 ? path.resolve(args[outIdx + 1]) : path.join(ROOT, 'firestore.rules.fitness-candidate');
if (!src) { console.error('usage: build-fitness-rules-candidate.js <served-ruleset-file> [--check] [--onto --out <file>]'); process.exit(2); }
const served = fs.readFileSync(src, 'utf8');
const sha = crypto.createHash('sha256').update(served).digest('hex');
if (!onto && sha !== SERVED_SHA) { console.error(`REFUSED: input sha256 ${sha} is not the served ruleset ${SERVED_ID} (${SERVED_SHA})`); process.exit(3); }

const CLOSED = (coll, id) => `  match /${coll}/{${id}} {
  allow read:   if isAdmin();
  allow write:  if false;
  }`;
const GYM_LOCKED = "['rating','ratingCount','reviewCount','members','memberCount','verified','status','moderationHold','moderationStatus','moderationReleased','hidden','isVisible']";
const PARENT = 'get(/databases/$(database)/documents/providerMemberships/$(membershipId)).data';

const HUNKS = [
  { id: 'FB fitness_bookings', from:
`  match /fitness_bookings/{bookingId} {
  allow read:   if isAdmin() || (isAuthed() && resource.data.uid == request.auth.uid);
  allow create: if claimsOwner()
  && request.resource.data.keys().hasAll(['type','provider','ref','uid','status','ts'])
  && request.resource.data.status == 'confirmed';
  allow update: if isAdmin();
  allow delete: if isAdmin();
  }`, to: CLOSED('fitness_bookings', 'bookingId') },
  { id: 'FG fitness_gyms', from:
`  match /fitness_gyms/{gymId} {
  allow read:   if true;
  allow create: if isAuthed() && request.auth.uid == gymId && noAdminFields();
  allow update: if isAuthed() && request.auth.uid == gymId && uidUnchanged() && noAdminFields();
  allow delete: if isAdmin();
  }`, to:
`  match /fitness_gyms/{gymId} {
  function noGymLockedFields() {
  return resource == null
  ? !request.resource.data.keys().hasAny(${GYM_LOCKED})
  : !request.resource.data.diff(resource.data).affectedKeys().hasAny(${GYM_LOCKED});
  }
  allow read:   if true;
  allow create: if isAuthed() && request.auth.uid == gymId && noAdminFields() && noGymLockedFields();
  allow update: if isAuthed() && request.auth.uid == gymId && uidUnchanged() && noAdminFields() && noGymLockedFields();
  allow delete: if isAdmin();
  }` },
  { id: 'FC fitness_classes', from:
`  match /fitness_classes/{classId} {
  allow read:   if true;
  allow create: if claimsOwner()
  && noAdminFields()
  && request.resource.data.keys().hasAll(['name','type','instructor','phone','uid','ts']);
  allow update: if isAdmin()
  || (isAuthed() && resource.data.uid == request.auth.uid
  && request.resource.data.diff(resource.data)
  .affectedKeys().hasOnly(['name','loc','time','fee','slots','desc','type','updatedAt'])
  && uidUnchanged());
  allow delete: if isAdmin() || (isAuthed() && resource.data.uid == request.auth.uid);
  }`, to: CLOSED('fitness_classes', 'classId') },
  { id: 'FL fitness_clubs', from:
`  match /fitness_clubs/{clubId} {
  allow read:   if true;
  allow create: if claimsOwner()
  && noAdminFields()
  && request.resource.data.keys().hasAll(['name','type','uid','ts']);
  allow update: if isAdmin()
  || (isAuthed() && resource.data.uid == request.auth.uid
  && request.resource.data.diff(resource.data)
  .affectedKeys().hasOnly(['name','desc','meet','members','updatedAt'])
  && uidUnchanged());
  allow delete: if isAdmin() || (isAuthed() && resource.data.uid == request.auth.uid);
  }`, to: CLOSED('fitness_clubs', 'clubId') },
  { id: 'FP fitness_community_posts', from:
`  match /fitness_community_posts/{postId} {
  allow read:   if true;
  allow create: if claimsOwner()
  && noAdminFields()
  && request.resource.data.keys().hasAll(['uid','ts'])
  && (request.resource.data.text == null || request.resource.data.text.size() <= 2000);
  allow update: if isAdmin()
  || (isAuthed() && resource.data.uid == request.auth.uid
  && request.resource.data.diff(resource.data)
  .affectedKeys().hasOnly(['text','likes','updatedAt'])
  && uidUnchanged());
  allow delete: if isAdmin() || (isAuthed() && resource.data.uid == request.auth.uid);
  }`, to: CLOSED('fitness_community_posts', 'postId') },
  { id: 'FE fitness_equipment', from:
`  match /fitness_equipment/{itemId} {
  allow read:   if true;
  allow create: if claimsOwner()
  && noAdminFields()
  && request.resource.data.keys().hasAll(['uid','ts']);
  allow update: if isAdmin()
  || (isAuthed() && resource.data.uid == request.auth.uid
  && request.resource.data.diff(resource.data)
  .affectedKeys().hasOnly(['price','desc','sold','updatedAt'])
  && uidUnchanged());
  allow delete: if isAdmin() || (isAuthed() && resource.data.uid == request.auth.uid);
  }`, to: CLOSED('fitness_equipment', 'itemId') },
  { id: 'FR fitness_requests', from:
`  match /fitness_requests/{requestId} {
  allow read:   if request.auth != null;
  allow create: if claimsOwner()
  && noAdminFields()
  && request.resource.data.keys().hasAll(['text','uid','ts'])
  && request.resource.data.text.size() <= 1000;
  allow update: if isAdmin()
  || (isAuthed() && resource.data.uid == request.auth.uid
  && request.resource.data.diff(resource.data)
  .affectedKeys().hasOnly(['text','phone','updatedAt'])
  && uidUnchanged());
  allow delete: if isAdmin() || (isAuthed() && resource.data.uid == request.auth.uid);
  }`, to: CLOSED('fitness_requests', 'requestId') },
  { id: 'FH fitness_challenges', from:
`  match /fitness_challenges/{entryId} {
  allow read:   if true;
  allow create: if isAuthed() && request.resource.data.uid == request.auth.uid && noAdminFields();
  allow update: if isAuthed() && resource.data.uid == request.auth.uid && uidUnchanged();
  allow delete: if isAdmin() || (isAuthed() && resource.data.uid == request.auth.uid);
  }`, to: CLOSED('fitness_challenges', 'entryId') },
  { id: 'FK fitness_checkins + FM providerMemberships / fitnessMembershipClaims (new, inserted after)', from:
`  match /fitness_checkins/{checkinId} {
  allow read:   if isAdmin() || (isAuthed() && resource.data.gymUid == request.auth.uid);
  allow create: if isAuthed()
  && request.resource.data.gymUid == request.auth.uid
  && request.resource.data.keys().hasAll(['memberName','gymUid','ts']);
  allow update: if isAdmin();
  allow delete: if isAdmin();
  }`, to: CLOSED('fitness_checkins', 'checkinId') + `
  match /providerMemberships/{membershipId} {
  allow read:   if isAuthed()
  && (resource.data.buyerUid == request.auth.uid
  || resource.data.providerId == request.auth.uid
  || isAdmin());
  allow create, update, delete: if false;
  match /attendance/{attendanceId} {
  allow read:   if isAuthed()
  && (${PARENT}.buyerUid == request.auth.uid
  || ${PARENT}.providerId == request.auth.uid
  || isAdmin());
  allow write:  if false;
  }
  match /events/{eventId} {
  allow read:   if isAuthed()
  && (${PARENT}.providerId == request.auth.uid
  || isAdmin());
  allow write:  if false;
  }
  match /releases/{releaseId} {
  allow read:   if isAuthed()
  && (${PARENT}.providerId == request.auth.uid
  || isAdmin());
  allow write:  if false;
  }
  }
  match /fitnessMembershipClaims/{claimHash} {
  allow read, write: if false;
  }` },
];

let out = served;
for (const h of HUNKS) {
  const n = out.split(h.from).length - 1;
  if (n !== 1) { console.error(`FAILED: hunk "${h.id}" matched ${n} times (must be exactly 1)`); process.exit(4); }
  out = out.replace(h.from, () => h.to);
}
for (const coll of ['fitness_bookings', 'fitness_gyms', 'fitness_classes', 'fitness_clubs', 'fitness_community_posts',
  'fitness_equipment', 'fitness_requests', 'fitness_challenges', 'fitness_checkins', 'fitness_progress',
  'providerMemberships', 'fitnessMembershipClaims', 'providerPayouts', 'providers']) {
  const n = (out.match(new RegExp(`match /${coll}/\\{`, 'g')) || []).length;
  if (n !== 1) { console.error(`FAILED: ${coll} has ${n} match blocks`); process.exit(5); }
}
const bytes = Buffer.byteLength(out, 'utf8'), sbytes = Buffer.byteLength(served, 'utf8');
console.log(`input ${onto ? '(--onto, sha ' + sha.slice(0, 12) + ')' : SERVED_ID + ' (sha ' + SERVED_SHA.slice(0, 12) + ')'}: ${sbytes} B`);
console.log(`candidate: ${bytes} B (${bytes - sbytes >= 0 ? "+" : ""}${bytes - sbytes}) sha ${crypto.createHash('sha256').update(out).digest('hex').slice(0, 12)} · limit 262144 B (${(bytes / 262144 * 100).toFixed(1)}%)`);
console.log(`hunks applied: ${HUNKS.map((h) => h.id.split(' ')[0]).join(' · ')}`);
if (!args.includes('--check')) { fs.writeFileSync(OUT, out); console.log('wrote ' + path.relative(ROOT, OUT)); }
