#!/usr/bin/env node
/* build-media-hold-storage-candidate.js — the MEDIA HOLD Storage rules candidate, built from the SERVED Storage ruleset
 * text (owner decision 2026-10-03: a taken-down product's photos are PRIVATE while the takedown hold exists).
 *
 *   node scripts/build-media-hold-storage-candidate.js <served-storage-ruleset-file> [--check]
 *
 * INPUT  : the source of the ruleset serving bucket sokoni-aeb26.firebasestorage.app, fetched read-only from the Rules API
 *          (releases/firebase.storage/sokoni-aeb26.firebasestorage.app → rulesetName → source) on 2026-10-03:
 *          ruleset 182624f3-7088-49de-ad72-a4c4701cb9f2 (created 2026-07-27T20:03:49Z, released 2026-08-11T05:18:05Z),
 *          pinned below by sha256. Any other input is REFUSED, so the candidate can never be built from a stale file.
 *          (That text is byte-identical to the repo storage.rules on this branch — measured, not assumed.)
 * OUTPUT : storage.rules.media-hold-candidate = that exact text + ONLY these hunks:
 *   M0 helpers            notModerationHeld() — true unless the EXISTING object carries custom metadata moderationHold=='1'
 *                         (null-safe: no resource / no custom metadata → not held); isModerationAdmin() — admin or
 *                         superAdmin claim (the Firestore isAdmin() definition)
 *   M1 product-images     read → `list` unchanged (if true); `get` refused while the object is held, except admins.
 *                         `update` additionally requires the object NOT held: otherwise the seller could drop the flag
 *                         (or re-upload over the path) and re-open the photo — the read refusal would be a formality.
 *                         `create` and `delete` are unchanged. Every other match block is byte-identical.
 * Token URLs (?alt=media&token=) bypass rules: they are closed by the server stripping the token (functions
 * moderation-media.js). This candidate closes the PATH reads (SDK getDownloadURL / getBytes / getMetadata) that would
 * otherwise let a client mint or read a held photo.
 * Each hunk must apply EXACTLY once or the build fails (fail closed). `--check` builds in memory, prints the measurement.
 */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const SERVED_ID = '182624f3-7088-49de-ad72-a4c4701cb9f2';
const SERVED_SHA = 'a9f1d0d7cc367ed4f5d26464fad1a8537ad8b6e46f825d884efa5ef270b4ca5b';
const OUT = path.join(ROOT, 'storage.rules.media-hold-candidate');

const src = process.argv[2];
if (!src) { console.error('usage: build-media-hold-storage-candidate.js <served-storage-ruleset-file> [--check]'); process.exit(2); }
const served = fs.readFileSync(src, 'utf8');
const sha = crypto.createHash('sha256').update(served).digest('hex');
if (sha !== SERVED_SHA) { console.error(`REFUSED: input sha256 ${sha} is not the served storage ruleset ${SERVED_ID} (${SERVED_SHA})`); process.exit(3); }

const HUNKS = [
  { id: 'M0 helpers', from:
`    /* ── Helper: only allow explicitly safe image types ── */`, to:
`    /* ── Helpers: the MODERATION MEDIA HOLD (2026-10-03). The server (functions moderation-media.js) sets custom
       metadata moderationHold='1' on a taken-down product's photos and removes it on restore. Null-safe. ── */
    function notModerationHeld() {
      return resource == null
          || resource.metadata == null
          || !('moderationHold' in resource.metadata)
          || resource.metadata.moderationHold != '1';
    }
    function isModerationAdmin() {
      return request.auth != null
          && (request.auth.token.admin == true || request.auth.token.superAdmin == true);
    }

    /* ── Helper: only allow explicitly safe image types ── */` },
  { id: 'M1 product-images (get gated on the hold, update refused while held)', from:
`    match /product-images/{uid}/{allPaths=**} {
      allow read:          if true;
      allow create, update: if request.auth != null
                           && request.auth.uid == uid
                           && safeImageOnly()
                           && request.resource.size < 15 * 1024 * 1024;
      allow delete:        if request.auth != null && request.auth.uid == uid;
    }`, to:
`    match /product-images/{uid}/{allPaths=**} {
      allow list:          if true;
      allow get:           if notModerationHeld() || isModerationAdmin();
      allow create:        if request.auth != null
                           && request.auth.uid == uid
                           && safeImageOnly()
                           && request.resource.size < 15 * 1024 * 1024;
      allow update:        if request.auth != null
                           && request.auth.uid == uid
                           && safeImageOnly()
                           && request.resource.size < 15 * 1024 * 1024
                           && notModerationHeld();
      allow delete:        if request.auth != null && request.auth.uid == uid;
    }` },
];

let out = served;
for (const h of HUNKS) {
  const n = out.split(h.from).length - 1;
  if (n !== 1) { console.error(`FAILED: hunk "${h.id}" matched ${n} times (must be exactly 1)`); process.exit(4); }
  out = out.replace(h.from, () => h.to);
}
/* exactly ONE product-images match block, and every OTHER line of the served text survives in order */
const n = (out.match(/match \/product-images\/\{/g) || []).length;
if (n !== 1) { console.error(`FAILED: product-images has ${n} match blocks`); process.exit(5); }
const strip = (t) => HUNKS.reduce((acc, h) => acc.replace(h.to, () => h.from), t);
if (strip(out) !== served) { console.error('FAILED: reverse-applying the hunks does not give back the served text byte for byte'); process.exit(6); }
const bytes = Buffer.byteLength(out, 'utf8'), sbytes = Buffer.byteLength(served, 'utf8');
console.log(`served ${SERVED_ID}: ${sbytes} B (sha ${SERVED_SHA.slice(0, 12)})`);
console.log(`candidate: ${bytes} B (+${bytes - sbytes}) sha ${crypto.createHash('sha256').update(out).digest('hex').slice(0, 12)}`);
console.log(`hunks applied: ${HUNKS.map((h) => h.id).join(' · ')}`);
console.log('reverse check: candidate minus hunks == served, byte for byte');
if (!process.argv.includes('--check')) { fs.writeFileSync(OUT, out); console.log('wrote ' + path.relative(ROOT, OUT)); }
