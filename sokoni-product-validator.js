/* ═══════════════════════════════════════════════════════════════════════════
   SOKONI PRODUCT VALIDATION CONTRACT
   Single source of truth for product-data validation, shared by EVERY JavaScript
   path that produces or consumes product records: the seller write path, admin
   edits, import/repair scripts, the Algolia queue + sanitizer, and future APIs.

   WHY THIS EXISTS
   ---------------
   Validation was correct but SCATTERED — the client base64 guard (seller.js), the
   Firestore rule (noBase64Image), and the Algolia sanitizer each enforced
   overlapping-but-separate things, free to drift apart over time. A single
   malformed product has already had outsized downstream effects (the "PEACH MANGO
   ICE" incident poisoned Algolia batches). This module is the canonical spec every
   path derives from so those layers stay aligned.

   Firestore Rules cannot import JavaScript, so they mirror these policies rather
   than import them (noBase64Image ≡ IMAGE_DATA_URI, validPrice ≡ PRICE_*). Treat
   this file as the specification the rules must match.

   ISOMORPHIC (UMD): loads as `window.SokoniProductValidator` in the browser and via
   `require('./product-validator')` in Cloud Functions. `functions/product-validator.js`
   is a byte-identical copy; scripts/test-product-validator.js asserts they match so
   the two can never diverge.

   RESULT SHAPE — every policy returns:
     { valid: boolean, errors: [{code, field, message}], warnings: [{code, field, message}] }
═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SokoniProductValidator = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Bump when the validation SPEC changes. Stored on each validated product as
     `validationVersion` so a later migration can find records written under older
     logic and selectively re-validate them. */
  var SCHEMA_VERSION = 1;

  /* Headroom under Algolia's hard 10,000-byte per-record limit. */
  var MAX_RECORD_BYTES = 9000;

  /* Stable, machine-readable error codes — never free-form strings, so dashboards,
     repair tools and analytics can group and act on them. */
  var CODES = {
    IMAGE_DATA_URI:         'IMAGE_DATA_URI',
    IMAGE_NOT_STORAGE:      'IMAGE_NOT_STORAGE',
    IMAGE_URL_TOO_LONG:     'IMAGE_URL_TOO_LONG',
    PRICE_MISSING:          'PRICE_MISSING',
    PRICE_NOT_NUMERIC:      'PRICE_NOT_NUMERIC',
    PRICE_NEGATIVE:         'PRICE_NEGATIVE',
    PRICE_STORED_AS_STRING: 'PRICE_STORED_AS_STRING',
    CATEGORY_INVALID:       'CATEGORY_INVALID',
    OBJECT_ID_INVALID:      'OBJECT_ID_INVALID',
    RECORD_TOO_LARGE:       'RECORD_TOO_LARGE',
    MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD'
  };

  function _err(code, field, message) { return { code: code, field: field, message: message }; }
  function _result(errors, warnings) {
    return { valid: errors.length === 0, errors: errors, warnings: warnings || [] };
  }
  function _merge() {
    var errors = [], warnings = [];
    for (var i = 0; i < arguments.length; i++) {
      errors = errors.concat(arguments[i].errors);
      warnings = warnings.concat(arguments[i].warnings);
    }
    return _result(errors, warnings);
  }

  function isDataUri(v) {
    return typeof v === 'string' && v.slice(0, 5).toLowerCase() === 'data:';
  }
  function isHttpUrl(v) {
    return typeof v === 'string' && /^https?:\/\//i.test(v);
  }

  /* Approximate the serialized byte size in both runtimes. Buffer in Node, Blob in
     the browser, string length as a last resort. */
  function recordBytes(rec) {
    var json;
    try { json = JSON.stringify(rec); } catch (e) { return Infinity; }
    if (json == null) return 0;
    if (typeof Buffer !== 'undefined' && Buffer.byteLength) return Buffer.byteLength(json, 'utf8');
    try { return new Blob([json]).size; } catch (e2) { return json.length; }
  }

  /* ── POLICY: images ──────────────────────────────────────────────────────
     No base64 data: URIs (the incident), no non-http references. Covers both the
     single-string fields and the images[] array (string or {url}). */
  function validateProductImages(p) {
    var errors = [], warnings = [];
    ['image', 'imageUrl', 'thumbnail', 'thumbnailUrl', 'coverImage', 'logo'].forEach(function (k) {
      var v = p ? p[k] : null;
      if (typeof v !== 'string' || v === '') return;
      if (isDataUri(v)) {
        errors.push(_err(CODES.IMAGE_DATA_URI, k, 'Image must reference Cloud Storage, not a base64 data: URI.'));
      } else if (!isHttpUrl(v)) {
        errors.push(_err(CODES.IMAGE_NOT_STORAGE, k, 'Image must be an http(s) Cloud Storage URL.'));
      } else if (v.length > 500) {
        warnings.push(_err(CODES.IMAGE_URL_TOO_LONG, k, 'Image URL is unusually long (' + v.length + ' chars).'));
      }
    });
    if (p && Array.isArray(p.images)) {
      p.images.forEach(function (img, i) {
        var url = (img && typeof img === 'object') ? img.url : img;
        if (url == null || url === '') return;
        if (isDataUri(url)) {
          errors.push(_err(CODES.IMAGE_DATA_URI, 'images[' + i + ']', 'Image must reference Cloud Storage, not a base64 data: URI.'));
        } else if (!isHttpUrl(url)) {
          errors.push(_err(CODES.IMAGE_NOT_STORAGE, 'images[' + i + ']', 'Image must be an http(s) Cloud Storage URL.'));
        }
      });
    }
    return _result(errors, warnings);
  }

  /* ── POLICY: pricing ─────────────────────────────────────────────────────
     Present, numeric, non-negative. A numeric string is allowed but warned — it
     should be stored as a number (matches the catalogue-repair concern). */
  function validateProductPricing(p) {
    var errors = [], warnings = [];
    var v = p ? p.price : undefined;
    if (v == null || v === '') {
      errors.push(_err(CODES.PRICE_MISSING, 'price', 'Price is required.'));
      return _result(errors, warnings);
    }
    var n = typeof v === 'number' ? v : Number(v);
    if (!isFinite(n)) {
      errors.push(_err(CODES.PRICE_NOT_NUMERIC, 'price', 'Price must be a number.'));
    } else {
      if (n < 0) errors.push(_err(CODES.PRICE_NEGATIVE, 'price', 'Price cannot be negative.'));
      if (typeof v === 'string') warnings.push(_err(CODES.PRICE_STORED_AS_STRING, 'price', 'Price is stored as a string; store it as a number.'));
    }
    return _result(errors, warnings);
  }

  /* ── POLICY: category ────────────────────────────────────────────────────
     Only enforced when an allow-list is supplied; otherwise a no-op (categories
     evolve, so an unknown one is a caller-provided decision). */
  function validateProductCategory(p, allowedCategories) {
    var errors = [];
    var c = p ? p.category : undefined;
    if (c != null && c !== '' && Array.isArray(allowedCategories) && allowedCategories.length &&
        allowedCategories.indexOf(c) === -1) {
      errors.push(_err(CODES.CATEGORY_INVALID, 'category', 'Unknown category: ' + c));
    }
    return _result(errors);
  }

  /* ── POLICY: metadata / required fields ──────────────────────────────────
     `name` OR `title` satisfies the display-name requirement (the catalogue uses
     both across its history); sellerUid is always required for ownership. */
  function validateProductMetadata(p) {
    var errors = [];
    var hasName = p && (p.name || p.title);
    if (!hasName) errors.push(_err(CODES.MISSING_REQUIRED_FIELD, 'name', 'A product name (name or title) is required.'));
    if (!p || p.sellerUid == null || p.sellerUid === '') {
      errors.push(_err(CODES.MISSING_REQUIRED_FIELD, 'sellerUid', 'sellerUid is required.'));
    }
    return _result(errors);
  }

  /* ── CONSUMER: a product about to be WRITTEN to Firestore ─────────────────
     The strictest gate — every producer path (seller app, admin, imports) should
     pass here before the write. */
  function validateProductWrite(p, opts) {
    opts = opts || {};
    return _merge(
      validateProductMetadata(p),
      validateProductImages(p),
      validateProductPricing(p),
      validateProductCategory(p, opts.allowedCategories)
    );
  }

  /* ── CONSUMER: a record about to be INDEXED in Algolia ────────────────────
     Focuses on what actually breaks indexing: a data: URI, an invalid objectID,
     and the record byte size. Structural checks (price/category) are a producer
     concern, not an index concern, so they are intentionally not repeated here. */
  function validateProductForIndex(rec, max) {
    var limit = max || MAX_RECORD_BYTES;
    var errors = [];
    if (rec && Object.prototype.hasOwnProperty.call(rec, 'objectID') &&
        (typeof rec.objectID !== 'string' || rec.objectID === '')) {
      errors.push(_err(CODES.OBJECT_ID_INVALID, 'objectID', 'objectID must be a non-empty string.'));
    }
    var imgs = validateProductImages(rec);
    imgs.errors.forEach(function (e) { if (e.code === CODES.IMAGE_DATA_URI) errors.push(e); });
    var bytes = recordBytes(rec);
    if (bytes > limit) {
      errors.push(_err(CODES.RECORD_TOO_LARGE, '(record)', 'Record is ' + bytes + ' bytes after mapping (limit ' + limit + ').'));
    }
    return _result(errors, imgs.warnings);
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    MAX_RECORD_BYTES: MAX_RECORD_BYTES,
    CODES: CODES,
    isDataUri: isDataUri,
    isHttpUrl: isHttpUrl,
    recordBytes: recordBytes,
    validateProductImages: validateProductImages,
    validateProductPricing: validateProductPricing,
    validateProductCategory: validateProductCategory,
    validateProductMetadata: validateProductMetadata,
    validateProductWrite: validateProductWrite,
    validateProductForIndex: validateProductForIndex
  };
}));
