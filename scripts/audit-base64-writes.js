#!/usr/bin/env node
/* ────────────────────────────────────────────────────────────────────────────
   audit-base64-writes.js — RATCHET on direct base64 image write paths.

   WHY
   The image READ path is converged: sokoni-image.js `pick()` reads nine field
   names and prefers a real URL. The WRITE path is not — 18 files call
   FileReader.readAsDataURL directly and produce a data URL, while only
   sokoni-upload.js routes to Firebase Storage.

   `pick()` is therefore ABSORBING a write-side defect rather than fixing one,
   which is the inversion the Publication Contract warns about: fix the write
   path, not the read path. Its tolerance is exactly what removes the pressure
   to converge.

   The concrete production risk is not stylistic:
     - Firestore's hard 1 MiB document limit. One photo can approach it, so the
       write fails at the moment a merchant adds their best product image.
     - The data URL is re-read on EVERY document read, including list queries
       that only display a thumbnail. A 200-item feed pays for 200 full images.
     - It cannot be resized, CDN-cached, served in a modern format, or deleted
       independently of the record.

   WHAT THIS DOES
   It does NOT migrate anything — rewriting live merchant records has no
   rollback. It stops the problem GROWING while conversion happens file by file.

   RATCHET: this number may fall. It never rises without explicit architectural
   justification. Not every occurrence is a defect — an avatar cropper, a legal
   signature pad and a barcode scanner may legitimately hold bytes in memory —
   so the baseline is lowered by conversion, not by exemption.
   ──────────────────────────────────────────────────────────────────────────── */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* The canonical uploader is where a data URL is ALLOWED to be produced, because
   it is the thing that then puts the bytes in Storage. */
const CANONICAL = ['sokoni-upload.js'];

const BASELINE = 32;   /* occurrences outside the canonical uploader */

/* `scripts` is excluded because guards and tooling legitimately NAME the pattern
   they look for — this file mentions readAsDataURL three times and counted
   ITSELF on the first run, reporting 35 against a baseline of 32. Build tooling
   is not a user-facing upload path. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'functions', 'scripts']);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), out);
    } else if (/\.(js|html)$/i.test(e.name) && !/\.min\./i.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const hits = [];
let total = 0;

for (const file of walk(ROOT, [])) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (CANONICAL.includes(rel)) continue;
  const src = fs.readFileSync(file, 'utf8');
  const n = (src.match(/readAsDataURL/g) || []).length;
  if (n) { hits.push({ rel, n }); total += n; }
}

hits.sort((a, b) => b.n - a.n || a.rel.localeCompare(b.rel));

console.log('[base64-writes] ' + total + ' direct readAsDataURL call(s) across ' +
  hits.length + ' file(s) — baseline ' + BASELINE);

if (total > BASELINE) {
  console.error('\nFAIL — a NEW base64 image write path was introduced.');
  console.error('  found ' + total + ', baseline ' + BASELINE + '\n');
  for (const h of hits) console.error('  ' + String(h.n).padStart(2) + '  ' + h.rel);
  console.error('\nRoute the upload through sokoni-upload.js (Firebase Storage) instead.');
  console.error('A data URL on a Firestore document risks the 1 MiB limit and is re-read');
  console.error('on every query that shows a thumbnail.');
  console.error('\nThis ratchet may FALL. It does not rise.');
  process.exit(1);
}

if (total < BASELINE) {
  console.log('\nRATCHET LOWERED: ' + total + ' < ' + BASELINE +
    '. Update BASELINE in ' + path.basename(__filename) + ' to ' + total + ' to lock the gain in.');
}

console.log('PASS — no new base64 image write paths.');
