/* ══════════════════════════════════════════════════════════════════════════════
   GATE M — WHAT THE MEDIA PIPELINE ACTUALLY SUPPORTS
   ──────────────────────────────────────────────────────────────────────────────
     npx firebase emulators:exec --only storage \
       "node scripts/test-media-capability.mjs"

   Gate M's instruction was to establish the real media contract BEFORE deciding whether
   Video / 360° / Documents lanes can exist. This suite establishes it against the deployed
   ruleset rather than against the client module's opinion of it — the client can only ever
   tell you what it INTENDS to send.

   The question it answers is not "does the UI have a lane" but "would the bytes land".
   Those are different questions, and this repo already contains a place where they
   disagree.
   ══════════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { ref, uploadBytes, getBytes } from 'firebase/storage';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!process.env.FIREBASE_STORAGE_EMULATOR_HOST && !process.env.STORAGE_EMULATOR_HOST) {
  console.log('\n  ENV — the Storage emulator is not running. Run through:');
  console.log('    npx firebase emulators:exec --only storage "node scripts/test-media-capability.mjs"\n');
  process.exit(2);
}

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const head = t => console.log('\n' + t);

const host = process.env.FIREBASE_STORAGE_EMULATOR_HOST || process.env.STORAGE_EMULATOR_HOST;
const [h, p] = String(host).split(':');

const env = await initializeTestEnvironment({
  projectId: 'sokoni-media-gate',
  storage: { rules: fs.readFileSync(path.join(ROOT, 'storage.rules'), 'utf8'),
             host: h, port: Number(p) },
});
await env.clearStorage();

const UID = 'merchant_1';
const authed = env.authenticatedContext(UID).storage();
const other = env.authenticatedContext('someone_else').storage();
const anon = env.unauthenticatedContext().storage();

const bytes = (n = 64) => new Uint8Array(n);
const put = (ctx, p, type, size = 64) =>
  uploadBytes(ref(ctx, p), bytes(size), { contentType: type });

console.log('══════════════════════════════════════════════════════════════════');
console.log('  GATE M — the media contract, measured against storage.rules');
console.log('══════════════════════════════════════════════════════════════════');

/* ── 1. WHAT THE LISTING PIPELINE ACTUALLY ACCEPTS ──────────────────────────── */
head('1 - product-images: the listing media pipeline');
{
  const base = `product-images/${UID}/prod1`;
  for (const t of ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']) {
    await assertSucceeds(put(authed, `${base}/${t.replace('/', '_')}.jpg`, t));
    ck('accepts ' + t, true);
  }
  await assertFails(put(authed, `${base}/v.mp4`, 'video/mp4'));
  ck('REFUSES video/mp4', true, 'safeImageOnly()');
  await assertFails(put(authed, `${base}/d.pdf`, 'application/pdf'));
  ck('REFUSES application/pdf', true);
  await assertFails(put(authed, `${base}/big.jpg`, 'image/jpeg', 15 * 1024 * 1024));
  ck('REFUSES a file of exactly 15 MB', true, 'the rule is strictly <');
  await assertFails(put(other, `${base}/theirs.jpg`, 'image/jpeg'));
  ck('REFUSES another merchant writing to this uid', true);
  /* Listing images are PUBLICLY readable — that is what makes a listing page work
     for a signed-out visitor. */
  await assertSucceeds(getBytes(ref(anon, `${base}/image_jpeg.jpg`)));
  ck('a SIGNED-OUT visitor can read a listing image', true, 'read: if true');
}

/* ── 2. THE VIDEO PATHS THAT EXIST ──────────────────────────────────────────── */
head('2 - bnb-videos / property-videos: real, but not on these terms');
{
  await assertSucceeds(put(authed, `bnb-videos/${UID}/clip.mp4`, 'video/mp4'));
  ck('video IS accepted at bnb-videos/{uid}/{file}', true, '< 150 MB');
  await assertSucceeds(put(authed, `property-videos/${UID}/clip.mp4`, 'video/mp4'));
  ck('and at property-videos/{uid}/{file}', true);
  await assertFails(put(other, `bnb-videos/${UID}/theirs.mp4`, 'video/mp4'));
  ck('another user cannot write to this uid', true);

  /* THE FINDING THAT DECIDES GATE M. Listing images are `read: if true`; these videos are
     `read: if request.auth != null`. A video attached to a public listing page would be
     invisible to every signed-out visitor — a media slot that renders for the merchant
     testing it and blank for the customers it was added for. */
  await assertSucceeds(getBytes(ref(authed, `bnb-videos/${UID}/clip.mp4`)));
  ck('a SIGNED-IN user can read the video', true);
  await assertFails(getBytes(ref(anon, `bnb-videos/${UID}/clip.mp4`)));
  ck('a SIGNED-OUT visitor CANNOT', true, 'read: if request.auth != null');
}

/* ── 3. THE PATH THE LIVE UPLOADERS ACTUALLY USE ────────────────────────────── */
head('3 - the two shipped video uploaders write a path no rule matches');
{
  /* bnb-manage.html:414   `bnb-videos/${Date.now()}_${file.name}`
     landlord.html:1463    `property-videos/${Date.now()}_${file.name}`

     Both are TWO segments. The rule is match /bnb-videos/{uid}/{filename} — three — so
     neither matches, and the ruleset's final `match /{allPaths=**} { allow read, write:
     if false }` denies them. Every video upload from those two surfaces is refused. */
  await assertFails(put(authed, `bnb-videos/1758000000000_clip.mp4`, 'video/mp4'));
  ck('the shipped bnb path is DENIED', true, 'no uid segment → falls to deny-all');
  await assertFails(put(authed, `property-videos/1758000000000_clip.mp4`, 'video/mp4'));
  ck('the shipped property path is DENIED', true);
  /* The control: the SAME file at the correct path succeeds, so the refusal is about the
     path shape and not about the bytes, the type or the caller. */
  await assertSucceeds(put(authed, `bnb-videos/${UID}/1758000000000_clip.mp4`, 'video/mp4'));
  ck('control — the same upload SUCCEEDS with a uid segment', true);
}

/* ── 4. DOCUMENTS ───────────────────────────────────────────────────────────── */
head('4 - documents: real, and deliberately private');
{
  await assertSucceeds(put(authed, `documents/${UID}/spec.pdf`, 'application/pdf'));
  ck('PDF is accepted at documents/{uid}/{file}', true, '< 20 MB');
  await assertFails(put(authed, `documents/${UID}/clip.mp4`, 'video/mp4'));
  ck('but video is not', true);
  await assertFails(getBytes(ref(anon, `documents/${UID}/spec.pdf`)));
  ck('a signed-out visitor cannot read a document', true);
  await assertFails(getBytes(ref(other, `documents/${UID}/spec.pdf`)));
  ck('and neither can another signed-in user', true, 'owner or admin only');
}

/* ── 5. 360° ────────────────────────────────────────────────────────────────── */
head('5 - 360°: nothing exists');
{
  const rules = fs.readFileSync(path.join(ROOT, 'storage.rules'), 'utf8');
  ck('no 360 path is defined in the ruleset', !/360|panorama|equirect/i.test(rules));
  await assertFails(put(authed, `product-360/${UID}/pano.jpg`, 'image/jpeg'));
  ck('and an invented 360 path is denied', true, 'deny-all catch-all');
  /* A 360 image is an ordinary JPEG with metadata, so it would physically FIT the existing
     product-images rule — which is exactly why this must be a decision rather than a
     discovery. Storing one is easy; a viewer, a projection type and a way to tell a flat
     photo from a spherical one are not. */
  await assertSucceeds(put(authed, `product-images/${UID}/prod1/pano.jpg`, 'image/jpeg'));
  ck('control — a 360 JPEG would physically fit product-images', true,
     'the gap is presentation and metadata, not storage');
}

console.log('\n  what this suite does NOT prove');
console.log('  UNPROVEN  production parity   [storage.rules here is the worktree copy; the ' +
            'deployed Storage ruleset was not re-fetched]');

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('══════════════════════════════════════════════════════════════════');
await env.cleanup();
process.exit(fail ? 1 : 0);
