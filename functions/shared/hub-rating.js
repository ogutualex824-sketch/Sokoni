/* shared/hub-rating.js — the ONE arithmetic for hub rating aggregates (healthcare, legal, digital products).
 *
 * A hub rating callable decides WHO may rate WHAT from its own canonical record (an appointment, a
 * consultation, a paid purchase). This module only does the part they all got wrong:
 *   · a rating is an INTEGER 1–5 — a string "5" passed `rating < 1 || rating > 5` and then string-concatenated
 *     into the average; 4.5 or 1e9 are refused too;
 *   · the aggregate is a SUM and a COUNT (never a rounded running average that drifts with every rating), with
 *     missing counts treated as 0 (they were NaN → a corrupted rating);
 *   · a legacy doc with only { rating, ratingCount } is carried over once.
 */
'use strict';
const { HttpsError } = require('firebase-functions/v2/https');

/** The client's rating, or a refusal. Only an integer 1..5 (number or numeric-looking value) is accepted. */
function intRating(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*[1-5]\s*$/.test(v) ? Number(v) : NaN);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new HttpsError('invalid-argument', 'Rating must be a whole number from 1 to 5.');
  return n;
}

/** The new aggregate after adding `rating` to the entity doc data `d`. */
function addRating(d, rating) {
  const prevCount = Number.isFinite(Number(d && d.ratingCount)) ? Math.max(0, Math.floor(Number(d.ratingCount))) : 0;
  const prevSum = Number.isFinite(Number(d && d.ratingSum)) ? Number(d.ratingSum)
    : (prevCount && Number.isFinite(Number(d.rating)) ? Number(d.rating) * prevCount : 0);
  const ratingCount = prevCount + 1;
  const ratingSum = prevSum + rating;
  return { rating: Math.round((ratingSum / ratingCount) * 100) / 100, ratingCount, ratingSum };
}

module.exports = { intRating, addRating };
