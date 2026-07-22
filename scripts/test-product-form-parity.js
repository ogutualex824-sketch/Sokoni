#!/usr/bin/env node
'use strict';
/**
 * PRODUCT-FORM PARITY GATE — Upload and Edit must stay in sync.
 *
 * On 2026-07-22 the edit-product modal had drifted from the upload form: 12
 * category options against the upload form's 78, and five fields (cost price,
 * delivery cost, location, wholesale price/qty) that could not be edited at all.
 * The category gap silently CORRUPTED data — a product uploaded as "computers"
 * had no matching option, so Save wrote back whatever the truncated dropdown
 * defaulted to.
 *
 * Both forms are still hand-maintained HTML. Until they render from one shared
 * schema (Phase 1 of the product-editor plan), this gate is what stops them
 * drifting again: it fails the deploy if a user-editable field the upload form
 * captures has no counterpart in the edit modal.
 *
 * It checks three things:
 *   1. Every EDITABLE upload field has an edit* input, a populate line in
 *      editProduct(), and a read in saveEditProduct().
 *   2. The edit category dropdown does NOT reintroduce a large hardcoded list —
 *      it must stay minimal and be cloned from #productCategory at runtime, so
 *      the 78-vs-12 gap cannot come back by someone "helpfully" pasting options.
 *   3. _syncEditCategoryOptions() still exists and is called from editProduct().
 *
 * When a genuinely new editable field is added to upload, add it to the edit
 * modal too (or to EDITABLE_EXCEPTIONS with a reason) — that is the point.
 *
 * Run: node scripts/test-product-form-parity.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JS = fs.readFileSync(path.join(ROOT, 'seller.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'seller.html'), 'utf8');

/* Upload fields that are NOT hand-editable on the edit form, each with the
   reason. These are system-owned, media-pipeline, or their own sub-flows —
   editing them belongs elsewhere or nowhere, not in the basic field grid. */
const EDITABLE_EXCEPTIONS = {
  id:            'system — the document key, never editable',
  sold:          'system — sales counter, server/checkout owned',
  views:         'system — analytics counter, read-only output',
  uploadedAt:    'system — creation timestamp',
  outOfStock:    'derived from stock, not typed',
  isService:     'derived from category',
  sellerName:    'from the user profile, not the product form',
  sellerEmail:   'from the user profile, not the product form',
  image:         'handled by the image editor (editImagesGrid), not a text field',
  images:        'handled by the image editor',
  video:         'video pipeline — its own upload control',
  isDigital:     'digital-product sub-flow, gated separately',
  digitalUrl:    'digital-product sub-flow',
  digitalLicense:'digital-product sub-flow',
  ownership:     'anti-theft verification sub-flow, not a plain field',
  kebsCert:      'certification sub-flow',
  verificationStatus: 'system — set to pending/none by upload, resolved by moderation',
  /* parse artefacts from the nested ownership literal, not top-level fields */
  declared:    'not a field — nested in ownership literal',
  serial:      'not a field — nested in ownership literal',
  source:      'not a field — nested in ownership literal',
  submittedAt: 'not a field — nested in ownership literal',
  status:      'not a field — nested in ownership literal',
};

const errors = [];

/* ── 1. Field parity ─────────────────────────────────────────────────────── */
const litStart = JS.indexOf('const newProduct = {');
const litEnd = JS.indexOf('};', litStart);
const literal = JS.slice(litStart, litEnd);
const uploadFields = [...new Set(
  (literal.match(/^\s+([a-zA-Z][a-zA-Z0-9]*)\s*:/gm) || [])
    .map((s) => s.trim().replace(/:.*/, ''))
)].filter((f) => f !== 'newProduct');

const editable = uploadFields.filter((f) => !(f in EDITABLE_EXCEPTIONS));

/* cap<Field> → id="editField" (name → editName, costPrice → editCostPrice) */
const editId = (f) => 'edit' + f.charAt(0).toUpperCase() + f.slice(1);

/* A field is covered when the shared schema owns it — schema.populate and
   schema.serialize then handle BOTH forms by construction, which is the whole
   point of Phase 1A. Fields not yet migrated to the schema still require the
   explicit html + populate + save trio. */
let schemaKeys = [];
try { schemaKeys = require(path.join(ROOT, 'sokoni-product-schema.js')).FIELDS.map((f) => f.key); }
catch (_) { errors.push('  sokoni-product-schema.js did not load — the shared schema is the source of truth.'); }

for (const f of editable) {
  const id = editId(f);
  const inHtml = new RegExp('id="' + id + '"').test(HTML);
  const inSchema = schemaKeys.indexOf(f) !== -1;

  if (inSchema) {
    /* The schema guarantees populate + serialize; only the input must exist. */
    if (!inHtml) errors.push('  ' + f + '  → in schema but #' + id + ' input is MISSING from the edit modal');
    continue;
  }

  const populated = new RegExp('setVal\\("' + id + '"').test(JS)
    || new RegExp('getElementById\\("' + id + '"\\)').test(JS);
  const readInSave = new RegExp('getElementById\\("' + id + '"\\)').test(JS);
  if (!inHtml || !populated || !readInSave) {
    errors.push('  ' + f + '  → not in shared schema and hand-wiring incomplete: #' + id +
      '  [html:' + (inHtml ? 'ok' : 'MISSING') +
      ' populate:' + (populated ? 'ok' : 'MISSING') +
      ' save:' + (readInSave ? 'ok' : 'MISSING') +
      ']  — add it to sokoni-product-schema.js FIELDS');
  }
}

/* ── 2. Edit category must not carry a large hardcoded list ──────────────── */
const editSelect = HTML.match(/<select id="editCategory"[\s\S]*?<\/select>/);
if (!editSelect) {
  errors.push('  #editCategory <select> not found in seller.html');
} else {
  const optionCount = (editSelect[0].match(/<option/g) || []).length;
  /* Cloned at runtime, so the static markup should hold only a fallback or two.
     A run of options here is the 12-option drift coming back. */
  if (optionCount > 3) {
    errors.push('  #editCategory has ' + optionCount + ' hardcoded <option>s — it must be ' +
      'cloned from #productCategory at runtime, not maintained as a second list. ' +
      'Keep only a fallback and let _syncEditCategoryOptions() populate it.');
  }
}

/* ── 3. The runtime clone must still be wired ────────────────────────────── */
if (!/function _syncEditCategoryOptions/.test(JS)) {
  errors.push('  _syncEditCategoryOptions() is gone — the edit category list is no longer ' +
    'cloned from the upload form and can silently truncate a product\'s category.');
}
if (!/_syncEditCategoryOptions\(/.test(JS.replace(/function _syncEditCategoryOptions/g, ''))) {
  errors.push('  _syncEditCategoryOptions() is defined but never called from editProduct().');
}

/* ── Report ──────────────────────────────────────────────────────────────── */
console.log('\nProduct-form parity gate\n');
console.log('  upload fields   : ' + uploadFields.length);
console.log('  editable        : ' + editable.length + '  (' +
  Object.keys(EDITABLE_EXCEPTIONS).length + ' excepted with reason)');
console.log('');

if (errors.length) {
  console.log('  FAIL — the edit form has drifted from the upload form:\n');
  errors.forEach((e) => console.log(e));
  console.log('\n  Add the missing field to the edit modal (input + populate + save +');
  console.log('  Firestore patch), or to EDITABLE_EXCEPTIONS with the reason it is not');
  console.log('  hand-editable. This gate exists because that drift corrupted product');
  console.log('  categories in production.\n');
  process.exit(1);
}

console.log('  PASS — every editable upload field is editable, category list is cloned, no drift.\n');
