'use strict';
/**
 * SOKONI — RECEIPT NUMBER AUTHORITY (pure core)
 * functions/receipt-number-authority.js
 *
 * STATUS: **NOT INTEGRATED.** Nothing calls this. `posCompleteCheckout` keeps its own
 * derivation; this changes no sale path.
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────────────────
 *   Every COMMITTED sale has exactly one receipt number.
 *   It is DERIVED from the committed sale, never from the clock.
 *   A replayed sale request yields the SAME number.
 *   A refused sale yields NO number.
 *
 * ── WHAT THE LIVE PATH ALREADY DOES RIGHT ───────────────────────────────────────────
 * `posCompleteCheckout` builds `receiptNo: saleId.slice(-8).toUpperCase()` and persists it
 * to `posReceipts/{saleId}`. Because it is DERIVED from the sale id rather than generated,
 * a replay returns the same number — and the idempotency cache at line 321 returns the
 * stored receipt verbatim on a retry. That property is correct and this module keeps it.
 *
 * ── THE TWO GAPS THIS ADDRESSES ─────────────────────────────────────────────────────
 * 1. TRUNCATION. `saleId` is a Firestore auto-id — 20 characters, ~119 bits. Taking the
 *    last 8 leaves ~47.6 bits. By the birthday bound that is roughly a 20% chance of at
 *    least one collision by 10 million receipts, and ~0.2% by 1 million. For a platform
 *    aiming at millions of users that is not a comfortable margin, and a collided receipt
 *    number is discovered during a dispute — the worst possible moment.
 *
 * 2. TRANSCRIPTION. A receipt number is read aloud, typed into a support form, and copied
 *    off a thermal print that may be smudged. `slice(-8)` of a base62 id contains `0/O`,
 *    `1/I/l` and mixed case, and carries no way to detect a mistyped character.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────────────
 * It does not touch Firestore, does not decide when a sale is committed, and is not a money
 * authority. The receipt CARRIES accounting facts so the 07:00 gate has an audit trail; it
 * never becomes a second place those facts are computed.
 */

const crypto = require('crypto');

/* Crockford base32: no I, L, O or U. Removes the 0/O and 1/I/L confusions entirely, and
   drops U so the alphabet cannot spell the obvious unfortunate words. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DATA_CHARS = 13;                 /* 13 x 5 bits = 65 bits */
const PREFIX = 'SK';

class ReceiptError extends Error {
  constructor (code, message, detail) { super(message); this.code = code; this.detail = detail || null; }
}

/* Crockford's own confusable folding, so a human who types O for 0 or I for 1 still lands
   on the right receipt instead of a "not found". */
function normalizeChar (c) {
  const u = c.toUpperCase();
  if (u === 'O') return '0';
  if (u === 'I' || u === 'L') return '1';
  return u;
}

function encode (buf, chars) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
      if (out.length === chars) return out;
    }
  }
  while (out.length < chars) out += ALPHABET[0];
  return out;
}

/* Crockford's check-symbol alphabet: the 32 data symbols plus five that never appear in
   data, so a check character is visually distinct from the body it protects. */
const CHECK_ALPHABET = ALPHABET + '*~$=U';        /* 37 symbols */

/**
 * Check character, mod 37.
 *
 * THE MODULUS MUST BE PRIME, and this is why: a first version used `sum % 32`. Since
 * 32 = 2^5, any position weight sharing a factor of two with the modulus collapses part of
 * the delta space — `delta * weight ≡ 0 (mod 32)` has non-trivial solutions. That left
 * exactly **17 blind spots**, and the suite caught exactly 17 single-character typos
 * slipping through. The count matching the arithmetic is what identified the cause.
 *
 * With a prime modulus no weight can be a zero divisor, so every single-character
 * substitution and every adjacent transposition changes the checksum.
 */
function checkChar (data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = ALPHABET.indexOf(data[i]);
    sum += v * (i + 1);                  /* position-weighted: catches transpositions */
  }
  return CHECK_ALPHABET[sum % 37];
}

/**
 * Derive the receipt number for a COMMITTED sale.
 *
 * DETERMINISTIC. The same `saleId` always yields the same number — that is what makes a
 * replay safe and a reprint correct. There is no clock, no counter and no randomness here;
 * a time-seeded receipt number would produce a second number for the same sale, which is
 * exactly the defect found in three of the five payout surfaces
 * (`generateIdempotencyKey([... String(Date.now())])`).
 *
 * @param {{saleId: string}} p
 * @returns {{receiptNumber, display, saleId, algorithm, bits}}
 */
function deriveReceiptNumber ({ saleId }) {
  if (typeof saleId !== 'string' || !saleId.trim()) {
    throw new ReceiptError('RECEIPT_NO_SALE_ID',
      'A receipt number can only be derived from a committed sale id. ' +
      'There is no receipt without a sale.');
  }
  const id = saleId.trim();
  /* the FULL id feeds the hash — no truncation of the source */
  const digest = crypto.createHash('sha256').update('sokoni:receipt:v1|' + id).digest();
  const data = encode(digest, DATA_CHARS);
  const body = data + checkChar(data);
  return {
    receiptNumber: PREFIX + body,                                   /* SK + 13 + check */
    display: PREFIX + '-' + body.slice(0, 5) + '-' + body.slice(5, 10) + '-' + body.slice(10),
    saleId: id,
    algorithm: 'sha256/crockford32/v1',
    bits: DATA_CHARS * 5
  };
}

/** Validate a receipt number a human typed, folding Crockford confusables first. */
function parseReceiptNumber (input) {
  if (typeof input !== 'string') return { valid: false, reason: 'not a string' };
  const raw = input.replace(/[\s-]/g, '').toUpperCase();
  if (raw.indexOf(PREFIX) !== 0) return { valid: false, reason: 'missing SK prefix' };
  const rest = raw.slice(PREFIX.length);
  if (rest.length !== DATA_CHARS + 1) return { valid: false, reason: 'wrong length' };
  /* fold confusables in the DATA only — the check symbol comes from a wider
     alphabet where U is meaningful, so normalising it would corrupt it. */
  const data = rest.slice(0, DATA_CHARS).split('').map(normalizeChar).join('');
  const given = rest[DATA_CHARS];
  const body = data + given;
  if (data.split('').some((c) => ALPHABET.indexOf(c) === -1)) {
    return { valid: false, reason: 'invalid character' };
  }
  if (checkChar(data) !== given) {
    return { valid: false, reason: 'check character failed — likely a typo' };
  }
  return { valid: true, receiptNumber: PREFIX + body };
}

/* The accounting facts a receipt CARRIES so the 07:00 gate has an audit trail. Carried,
   not computed — the receipt must never become a second place these are derived, or it
   becomes a competing money authority. */
const RECEIPT_FACTS = [
  'receiptNumber', 'saleId', 'settlementDay', 'grossAmountMinor', 'commissionMinor',
  'custody', 'currency', 'paymentMethod', 'merchantUid', 'shopId', 'soldAtMs'
];

/**
 * Assert the invariant for one committed sale.
 * Returns the receipt record, or throws. There is no partial outcome.
 */
function assertReceiptForSale ({ sale, committed }) {
  if (committed !== true) {
    throw new ReceiptError('RECEIPT_SALE_NOT_COMMITTED',
      'A receipt number may only be issued after the sale transaction commits. ' +
      'A refused, cancelled or failed sale gets no receipt number.');
  }
  if (!sale || typeof sale !== 'object') {
    throw new ReceiptError('RECEIPT_NO_SALE', 'sale is required');
  }
  const derived = deriveReceiptNumber({ saleId: sale.saleId });
  const missing = RECEIPT_FACTS.filter((f) =>
    f !== 'receiptNumber' && (sale[f] === undefined || sale[f] === null));
  if (missing.length) {
    throw new ReceiptError('RECEIPT_MISSING_FACTS',
      'The receipt cannot carry facts it was not given: ' + missing.join(', ') +
      '. It must never recompute them.', { missing });
  }
  const out = { receiptNumber: derived.receiptNumber, display: derived.display };
  RECEIPT_FACTS.forEach((f) => { if (f !== 'receiptNumber') out[f] = sale[f]; });
  return out;
}

/** Collision headroom, so the margin is stated rather than assumed. */
function collisionProbability (receipts) {
  const space = Math.pow(2, DATA_CHARS * 5);
  return 1 - Math.exp(-(receipts * receipts) / (2 * space));
}

module.exports = {
  ReceiptError, ALPHABET, CHECK_ALPHABET, DATA_CHARS, PREFIX, RECEIPT_FACTS,
  deriveReceiptNumber, parseReceiptNumber, assertReceiptForSale, collisionProbability
};
