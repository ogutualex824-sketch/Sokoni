'use strict';

/**
 * Prefix-expanded search terms for Firestore text matching.
 *
 * Extracted verbatim from functions/index.js so the repair path and the
 * indexing triggers cannot drift. A repaired product must produce byte-identical
 * terms to one indexed by the trigger — otherwise the same query matches a
 * product before repair and misses it after, and the cause sits in a second
 * generator nobody remembers writing.
 *
 * The behaviour is unchanged from the original: words of two or more characters,
 * plus every prefix from length 2 up to 6. Six is the cut because the term array
 * is stored on the document and an unbounded expansion grows it without
 * improving matches a user would actually type.
 */
/**
 * Variant attribute fields, written by the seller forms via
 * sokoni-product-schema.js. Kept here rather than in a fourth place because
 * this module is already the canonical term generator; algolia-indexer imports
 * the same constant so an attribute added once becomes searchable everywhere.
 *
 * scripts/check-variant-parity.js asserts this list equals the client schema's
 * ALL_ATTR_KEYS — Cloud Functions bundle only functions/, so the browser module
 * cannot be required here and a test has to stand in for a shared import.
 */
const VARIANT_FIELDS = ['colors', 'sizes', 'storage', 'weights', 'volumes', 'materials'];

/* "256GB" → also "256" and "gb", so a shopper who types "256 gb" still matches.
   Only applies to a number-then-unit value, which is exactly the shape of the
   storage/weight/volume options. */
const NUM_UNIT = /^(\d+(?:\.\d+)?)([a-z]+)$/;

function buildSearchTerms(doc) {
  const terms = new Set();

  /* Prefixes from length 2 up to 6 — enough for what a shopper types, bounded
     so the stored array cannot grow without limit. */
  function addWord(word, minLen) {
    if (!word || word.length < minLen) return;
    terms.add(word);
    for (let i = 2; i <= Math.min(word.length, 6); i++) terms.add(word.slice(0, i));
  }

  /* `businessName`, `categories`, `skills`, `serviceType`, `city` are PROVIDER
     fields — added so this one generator also indexes providers/{uid} (the CF and
     the indexProvider* triggers share it). Products never carry these, so product
     terms stay byte-identical (the parity contract above is preserved). */
  const fields = ['name', 'businessName', 'title', 'category', 'categories', 'serviceType',
                  'skills', 'description', 'tags', 'brand', 'location', 'city', 'county'];
  fields.forEach(function (f) {
    const val = doc[f];
    if (!val) return;
    const str = Array.isArray(val) ? val.join(' ') : String(val);
    str.toLowerCase().split(/\s+/).forEach(function (word) { addWord(word, 2); });
  });

  /* Variant values are indexed whole and at minimum length 1: a clothing size
     is often a single character ("S", "M", "L"), and the 2-character floor the
     text fields use would silently drop them. */
  VARIANT_FIELDS.forEach(function (f) {
    const val = doc[f];
    if (!val) return;                                   /* missing / null */
    const list = Array.isArray(val) ? val : [val];      /* tolerate a scalar */
    list.forEach(function (raw) {
      if (raw === null || raw === undefined) return;
      String(raw).toLowerCase().split(/\s+/).forEach(function (word) {
        addWord(word, 1);
        const m = NUM_UNIT.exec(word);
        if (m) { addWord(m[1], 1); addWord(m[2], 1); }
      });
    });
  });

  return Array.from(terms);
}

/**
 * Variant attributes normalised for indexing: trimmed non-empty strings, always
 * an array for every key. A missing, null or empty attribute yields [] rather
 * than being dropped — Algolia cannot compute facet counts over a field that is
 * absent on some records, which is exactly what a product created before
 * variants existed would otherwise produce. Bounded so a malformed document
 * cannot inflate a record toward the 10KB limit.
 *
 * Lives here, beside the term generator, so the live trigger path and the
 * backfill script share one definition. A backfill over an unchanged dataset
 * must produce the same indexed representation as the live pipeline.
 */
function variantAttributes(doc) {
  const out = {};
  for (const f of VARIANT_FIELDS) {
    const raw = doc ? doc[f] : null;
    const list = Array.isArray(raw) ? raw : (raw === null || raw === undefined ? [] : [raw]);
    out[f] = list
      .map(v => (v === null || v === undefined ? '' : String(v).trim()))
      .filter(Boolean)
      .slice(0, 40);
  }
  return out;
}

module.exports = { buildSearchTerms, VARIANT_FIELDS, variantAttributes };
