#!/usr/bin/env node
'use strict';

/**
 * Tests for the SOKONI Product Validation Contract.
 *
 * Also enforces the ANTI-DRIFT invariant: the client copy
 * (sokoni-product-validator.js) and the functions copy
 * (functions/product-validator.js) must be byte-identical, so the single source of
 * truth cannot silently fork. If you change one, run this test — it fails until
 * both match.
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + name); } }

/* ── Anti-drift: the two copies are byte-identical ── */
const clientSrc = fs.readFileSync(path.join(ROOT, 'sokoni-product-validator.js'), 'utf8');
const fnSrc     = fs.readFileSync(path.join(ROOT, 'functions', 'product-validator.js'), 'utf8');
ok('client and functions copies are byte-identical', clientSrc === fnSrc);

const V = require(path.join(ROOT, 'functions', 'product-validator.js'));

/* ── Result shape ── */
(() => {
  const r = V.validateProductImages({ image: 'https://s/x.webp' });
  ok('result shape { valid, errors[], warnings[] }',
    typeof r.valid === 'boolean' && Array.isArray(r.errors) && Array.isArray(r.warnings));
})();

/* ── Images ── */
ok('base64 data: URI in image is rejected (IMAGE_DATA_URI)',
  V.validateProductImages({ image: 'data:image/webp;base64,AAAA' })
    .errors.some(e => e.code === V.CODES.IMAGE_DATA_URI));
ok('base64 in images[] array is rejected',
  V.validateProductImages({ images: ['data:image/png;base64,BBBB'] })
    .errors.some(e => e.code === V.CODES.IMAGE_DATA_URI));
ok('base64 in images[{url}] object is rejected',
  V.validateProductImages({ images: [{ url: 'data:image/png;base64,CCC' }] })
    .errors.some(e => e.code === V.CODES.IMAGE_DATA_URI));
ok('good https Storage URL passes',
  V.validateProductImages({ image: 'https://firebasestorage.googleapis.com/x.webp', images: ['https://s/y.webp'] }).valid);
ok('non-http reference rejected (IMAGE_NOT_STORAGE)',
  V.validateProductImages({ image: 'ftp://x/y.png' }).errors.some(e => e.code === V.CODES.IMAGE_NOT_STORAGE));
ok('empty / missing image fields are fine',
  V.validateProductImages({ image: '', images: [] }).valid);
ok('error carries a stable code + field',
  (() => { const e = V.validateProductImages({ image: 'data:x' }).errors[0]; return e.code === 'IMAGE_DATA_URI' && e.field === 'image'; })());

/* ── Pricing ── */
ok('missing price rejected (PRICE_MISSING)',
  V.validateProductPricing({}).errors.some(e => e.code === V.CODES.PRICE_MISSING));
ok('non-numeric price rejected (PRICE_NOT_NUMERIC)',
  V.validateProductPricing({ price: 'abc' }).errors.some(e => e.code === V.CODES.PRICE_NOT_NUMERIC));
ok('negative price rejected (PRICE_NEGATIVE)',
  V.validateProductPricing({ price: -5 }).errors.some(e => e.code === V.CODES.PRICE_NEGATIVE));
ok('numeric price passes',
  V.validateProductPricing({ price: 250 }).valid);
ok('numeric STRING price passes but warns',
  (() => { const r = V.validateProductPricing({ price: '250' }); return r.valid && r.warnings.some(w => w.code === V.CODES.PRICE_STORED_AS_STRING); })());

/* ── Category ── */
ok('unknown category rejected only when an allow-list is given',
  V.validateProductCategory({ category: 'zzz' }, ['food', 'tech']).errors.some(e => e.code === V.CODES.CATEGORY_INVALID));
ok('category with no allow-list is a no-op',
  V.validateProductCategory({ category: 'anything' }).valid);
ok('valid category passes',
  V.validateProductCategory({ category: 'food' }, ['food', 'tech']).valid);

/* ── Metadata ── */
ok('missing name AND title rejected (MISSING_REQUIRED_FIELD)',
  V.validateProductMetadata({ sellerUid: 'u1' }).errors.some(e => e.code === V.CODES.MISSING_REQUIRED_FIELD && e.field === 'name'));
ok('name satisfies the requirement', V.validateProductMetadata({ name: 'X', sellerUid: 'u1' }).valid);
ok('title satisfies the requirement', V.validateProductMetadata({ title: 'X', sellerUid: 'u1' }).valid);
ok('missing sellerUid rejected',
  V.validateProductMetadata({ name: 'X' }).errors.some(e => e.field === 'sellerUid'));

/* ── Index consumer ── */
ok('index: empty objectID rejected (OBJECT_ID_INVALID)',
  V.validateProductForIndex({ objectID: '', title: 'x' }).errors.some(e => e.code === V.CODES.OBJECT_ID_INVALID));
ok('index: oversized record rejected (RECORD_TOO_LARGE)',
  V.validateProductForIndex({ objectID: 'p1', blob: 'x'.repeat(9500) }).errors.some(e => e.code === V.CODES.RECORD_TOO_LARGE));
ok('index: clean small record passes',
  V.validateProductForIndex({ objectID: 'p1', title: 'Mango', image: 'https://s/x.webp' }).valid);
ok('index: base64 image rejected even if small',
  V.validateProductForIndex({ objectID: 'p1', image: 'data:image/png;base64,AAAA' }).errors.some(e => e.code === V.CODES.IMAGE_DATA_URI));

/* ── Write consumer (composite) ── */
ok('write: fully valid product passes',
  V.validateProductWrite({ name: 'Mango', sellerUid: 'u1', price: 250, image: 'https://s/x.webp' }).valid);
ok('write: base64 + negative price + missing name all reported together',
  (() => {
    const r = V.validateProductWrite({ sellerUid: 'u1', price: -1, image: 'data:x' });
    const codes = r.errors.map(e => e.code);
    return !r.valid
      && codes.includes(V.CODES.IMAGE_DATA_URI)
      && codes.includes(V.CODES.PRICE_NEGATIVE)
      && codes.includes(V.CODES.MISSING_REQUIRED_FIELD);
  })());

/* ── Versioning surfaced ── */
ok('SCHEMA_VERSION is a number', typeof V.SCHEMA_VERSION === 'number');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
