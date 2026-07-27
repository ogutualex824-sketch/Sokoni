#!/usr/bin/env node
'use strict';

/**
 * Tests for the Storage Integrity Auditor's pure logic — the URL→Storage-path
 * mapping and image-reference extraction. The scheduled scan itself needs live
 * Firestore/Storage and is exercised via the admin callable, not here.
 */

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { _internal } = require(path.join(ROOT, 'functions', 'integrity-audit.js'));
const { storagePathFromUrl, imageRefs, issueId } = _internal;

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('  ✗ ' + name); } }

/* ── storagePathFromUrl ── */
ok('firebasestorage download URL → decoded object path',
  storagePathFromUrl('https://firebasestorage.googleapis.com/v0/b/sokoni-aeb26.firebasestorage.app/o/product-images%2Fuid1%2Fp1%2Ffront.webp?alt=media&token=abc')
    === 'product-images/uid1/p1/front.webp');
ok('gcs storage.googleapis.com URL → path',
  storagePathFromUrl('https://storage.googleapis.com/sokoni-aeb26/product-images/uid1/p1/front.webp')
    === 'product-images/uid1/p1/front.webp');
ok('external CDN URL → null (skipped, not flagged)',
  storagePathFromUrl('https://images.unsplash.com/photo-123.jpg') === null);
ok('data: URI → null (handled by structure check, not storage check)',
  storagePathFromUrl('data:image/png;base64,AAAA') === null);
ok('non-string → null', storagePathFromUrl(null) === null);
ok('placeholder path → null', storagePathFromUrl('assets/default-product.png') === null);

/* ── imageRefs ── */
(() => {
  const refs = imageRefs({
    image: 'https://s/a.webp',
    thumbnail: 'https://s/t.webp',
    images: ['https://s/b.webp', { url: 'https://s/c.webp' }],
    imageUrl: '',            // empty — skipped
  });
  const fields = refs.map(r => r.field);
  ok('imageRefs collects single fields + array (string + {url})',
    fields.includes('image') && fields.includes('thumbnail') &&
    fields.includes('images[0]') && fields.includes('images[1]'));
  ok('imageRefs skips empty fields', !fields.includes('imageUrl'));
  ok('imageRefs carries the url', refs.find(r => r.field === 'images[1]').url === 'https://s/c.webp');
})();

/* ── issueId ── */
ok('issueId is deterministic + doc-id-safe',
  (() => {
    const a = issueId('products_123', 'MISSING_STORAGE_OBJECT', 'images[0]');
    const b = issueId('products_123', 'MISSING_STORAGE_OBJECT', 'images[0]');
    return a === b && /^[A-Za-z0-9_-]+$/.test(a);
  })());
ok('issueId separates by type + field',
  issueId('p1', 'MISSING_STORAGE_OBJECT', 'image') !== issueId('p1', 'STRUCTURAL_INVALID', 'image'));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
