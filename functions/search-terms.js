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
function buildSearchTerms(doc) {
  const terms = new Set();
  const fields = ['name', 'title', 'category', 'description', 'tags', 'brand', 'location', 'county'];
  fields.forEach(function (f) {
    const val = doc[f];
    if (!val) return;
    const str = Array.isArray(val) ? val.join(' ') : String(val);
    str.toLowerCase().split(/\s+/).forEach(function (word) {
      if (word.length >= 2) {
        terms.add(word);
        for (let i = 2; i <= Math.min(word.length, 6); i++) {
          terms.add(word.slice(0, i));
        }
      }
    });
  });
  return Array.from(terms);
}

module.exports = { buildSearchTerms };
