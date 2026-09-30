/* ══════════════════════════════════════════════════════════════════════════════════════
   POS REDEMPTION CHALLENGE — the cashier starts it; only the customer can authorise it.
   ══════════════════════════════════════════════════════════════════════════════════════
   THE FRAUD THIS EXISTS TO STOP. Points are money. Without a second party, a dishonest
   cashier can spend a customer's balance against a sale the customer never agreed to, and
   nothing in the sale record would look wrong: the totals reconcile, the ledger balances,
   the receipt prints. The only thing missing is the customer's consent, and consent is not
   something a total can encode.

   So the two halves are split. The till may CREATE a redemption; it may not COMPLETE one.

       cashier rings up the sale
              ↓
       server prices the redemption          <- points and KES decided here, never sent
              ↓
       server mints a one-time challenge
              ↓
       till shows QR + 6-digit code
              ↓
       CUSTOMER confirms                     <- the second factor
              ↓
       sale transaction: burn + ledger + challenge consumed, atomically

   POS-INITIATED, DELIBERATELY. A customer-initiated flow would need a signed-in customer to
   locate their own POS balance, and posCustomers/{sellerId}_{phone} carries no uid — there
   is no link between a SOKONI account and a till's customer record. Building one would mean
   deciding that a verified phone number grants access to a points balance, which is a
   security decision with a migration attached. The till already knows WHICH posCustomer the
   sale is for, so the challenge references that record internally and the customer confirms
   a transaction rather than proving an identity. No phone number is handed to a cashier.

   ── WHAT AN HONEST READING OF THE SECOND FACTOR IS ───────────────────────────────────
   This defeats the cashier who spends a balance with no customer present. It does NOT, on
   a single-screen till, defeat a cashier who scans the customer-facing QR themselves — the
   code is visible to whoever can see the screen. Bounded on a customer-facing display or
   the customer's own phone; on a shared screen it is a meaningful obstacle rather than a
   proof. That limit is stated here because a control described as stronger than it is gets
   trusted for things it cannot carry.
   ══════════════════════════════════════════════════════════════════════════════════════ */
'use strict';

const crypto = require('crypto');

const COLLECTION = 'posRedemptionChallenges';

/* Two minutes. Long enough for a customer to take out a phone, short enough that a code
   left on a screen is worthless by the time anyone else reaches the till. */
const TTL_MS = 120 * 1000;

const STATUS = {
  PENDING:   'pending',      /* minted, awaiting the customer */
  CONFIRMED: 'confirmed',    /* the customer authorised it; the sale may now spend it */
  CONSUMED:  'consumed',     /* spent by a COMMITTED sale — terminal */
};

const REASON = {
  NOT_FOUND:   'challenge-not-found',
  EXPIRED:     'challenge-expired',
  ALREADY_USED:'challenge-already-used',
  BAD_CODE:    'code-does-not-match',
  WRONG_SALE:  'challenge-was-issued-for-a-different-sale',
  WRONG_SHOP:  'challenge-was-issued-for-a-different-shop',
  WRONG_AMOUNT:'challenge-was-issued-for-a-different-amount',
  NOT_CONFIRMED:'customer-has-not-confirmed-this-redemption',
  NO_SECRET:   'redemption-signing-key-unavailable',
  SELF_CONFIRM:'the-cashier-who-started-this-cannot-also-confirm-it',
  WEAK_CONFIRM:'this-redemption-needs-customer-device-confirmation',
};

/* ── the code ─────────────────────────────────────────────────────────────────
   Same primitives delivery-pin.js uses, and for the same reasons: crypto.randomInt is
   unbiased where Math.random is both biased and predictable, and only a keyed hash of the
   code is ever stored, so a database reader cannot recover it.

   THE ONE DELIBERATE DIFFERENCE. delivery-pin.js falls back to a constant key when the
   secret is unavailable, because its shadow telemetry must never crash. That trade is
   correct there and wrong here: a six-digit code hashed under a key that is written in the
   source is brute-forceable in a thousand guesses, so a redemption challenge signed that
   way is not signed at all. This FAILS CLOSED instead — no key, no challenge. */
function gen6() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/**
 * The binding. Everything that must not be swappable goes INTO the hash, so a code minted
 * for one sale cannot be replayed against another: change any element and the digest no
 * longer matches, without needing a separate equality check per field.
 */
function bindingRef(b) {
  return [
    'posredeem/v1',
    String(b.merchantId || ''),
    String(b.storeId || ''),
    String(b.customerId || ''),
    String(b.saleKey || ''),
    String(b.points || 0),
    String(b.valueKES || 0),
    /* WHO MINTED IT is part of the signature, not merely a stored field. The separation
       rule below refuses a confirmation from the minting principal, and a rule enforced
       against a mutable column is only as strong as the column — putting the cashier
       inside the digest means a challenge cannot be re-attributed to someone else in
       order to let the real cashier confirm it. */
    String(b.mintedBy || ''),
    String(b.nonce || ''),
  ].join('|');
}

function hashCode(secret, binding, code) {
  const key = String(secret || '');
  if (!key) { const e = new Error(REASON.NO_SECRET); e.reason = REASON.NO_SECRET; throw e; }
  return crypto.createHmac('sha256', key)
    .update(bindingRef(binding) + '|' + String(code))
    .digest('hex');
}

/** Constant-time comparison. A byte-by-byte compare leaks the correct prefix through
    timing, which for a six-digit code is the difference between a million guesses and
    sixty. Length is checked first because timingSafeEqual throws on a mismatch. */
function codeMatches(secret, binding, code, storedHash) {
  let got;
  try { got = hashCode(secret, binding, code); } catch (_) { return false; }
  const a = Buffer.from(got);
  const b = Buffer.from(String(storedHash || ''));
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch (_) { return false; }
}

/**
 * Mint a challenge document. PURE — returns what to write; the caller writes it. The points
 * and KES are the SERVER's authorised figures, passed in by a caller that has already run
 * the redemption authority; nothing here takes a value from a request.
 */
function mint({ secret, merchantId, storeId, customerId, saleKey, points, valueKES, mintedBy, now }) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const code  = gen6();
  const at    = Number(now) || Date.now();
  const binding = { merchantId, storeId, customerId, saleKey, points, valueKES, mintedBy, nonce };

  return {
    /* Returned to the till for display, and NEVER stored. */
    code,
    id: nonce,
    doc: {
      status:     STATUS.PENDING,
      merchantId: merchantId ? String(merchantId) : null,
      storeId:    storeId ? String(storeId) : null,
      customerId: customerId ? String(customerId) : null,
      saleKey:    saleKey ? String(saleKey) : null,
      mintedBy:   mintedBy ? String(mintedBy) : null,
      points:     Number(points) || 0,
      valueKES:   Number(valueKES) || 0,
      nonce,
      codeHash:   hashCode(secret, binding, code),
      createdAt:  at,
      expiresAt:  at + TTL_MS,
      confirmedAt: null,
      confirmedBy: null,
      confirmMethod: null,
      consumedAt:  null,
    },
  };
}

/**
 * Can this challenge be confirmed by the customer right now?
 * PURE. Returns { ok, reason }.
 */
function checkConfirmable({ secret, snap, code, confirmedBy, now }) {
  if (!snap || !snap.exists) return { ok: false, reason: REASON.NOT_FOUND };
  const d = snap.data() || {};
  const at = Number(now) || Date.now();

  /* ── SEPARATION OF PRINCIPALS ──────────────────────────────────────────────
     The cashier who minted the challenge may not confirm it. Without this the whole
     control collapses: the code is displayed on the till, so the person who created the
     redemption already knows it, and "the customer confirmed" would mean nothing more
     than "somebody typed the number on the screen".

     This is what makes the flow impossible to COMPLETE merely because a cashier knows
     the code. It does not defeat collusion, and it does not turn the shared-screen code
     into strong customer authentication — a second device in the same hands still works.
     It removes the solo case, which is the one that happens. */
  if (d.mintedBy && confirmedBy && String(d.mintedBy) === String(confirmedBy)) {
    return { ok: false, reason: REASON.SELF_CONFIRM };
  }

  /* Terminal states first: a consumed challenge must never be re-openable, and reporting
     "expired" for something already spent would hide a replay attempt behind a benign
     message. */
  if (d.status === STATUS.CONSUMED)  return { ok: false, reason: REASON.ALREADY_USED };
  if (Number(d.expiresAt) && at > Number(d.expiresAt)) return { ok: false, reason: REASON.EXPIRED };

  const binding = {
    merchantId: d.merchantId, storeId: d.storeId, customerId: d.customerId,
    saleKey: d.saleKey, points: d.points, valueKES: d.valueKES,
    mintedBy: d.mintedBy, nonce: d.nonce,
  };
  if (!codeMatches(secret, binding, code, d.codeHash)) return { ok: false, reason: REASON.BAD_CODE };
  return { ok: true, reason: null };
}

/**
 * May a SALE spend this challenge? PURE, and called inside the sale transaction.
 *
 * Every binding element is re-checked against what the sale actually is, so a challenge
 * minted for KES 100 on sale A cannot settle KES 500 on sale B even with a valid code.
 */
function checkSpendable({ snap, merchantId, customerId, saleKey, points, valueKES, now }) {
  if (!snap || !snap.exists) return { ok: false, reason: REASON.NOT_FOUND };
  const d = snap.data() || {};
  const at = Number(now) || Date.now();

  if (d.status === STATUS.CONSUMED) return { ok: false, reason: REASON.ALREADY_USED };
  if (d.status !== STATUS.CONFIRMED) return { ok: false, reason: REASON.NOT_CONFIRMED };
  /* Re-checked at SPEND time, not merely at confirm time. A status column can be written
     by any path that reaches the document; the sale must satisfy itself that the recorded
     confirmation actually came from someone other than the cashier ringing it up. */
  if (d.mintedBy && d.confirmedBy && String(d.mintedBy) === String(d.confirmedBy)) {
    return { ok: false, reason: REASON.SELF_CONFIRM };
  }
  if (!d.confirmedBy) return { ok: false, reason: REASON.NOT_CONFIRMED };
  if (Number(d.expiresAt) && at > Number(d.expiresAt)) return { ok: false, reason: REASON.EXPIRED };

  if (String(d.merchantId || '') !== String(merchantId || '')) return { ok: false, reason: REASON.WRONG_SHOP };
  if (String(d.customerId || '') !== String(customerId || '')) return { ok: false, reason: REASON.WRONG_SHOP };
  if (String(d.saleKey || '')    !== String(saleKey || ''))    return { ok: false, reason: REASON.WRONG_SALE };
  if (Number(d.points)   !== Number(points))   return { ok: false, reason: REASON.WRONG_AMOUNT };
  if (Number(d.valueKES) !== Number(valueKES)) return { ok: false, reason: REASON.WRONG_AMOUNT };

  return { ok: true, reason: null };
}

/** The consumption patch. Written INSIDE the sale transaction, so a sale that fails leaves
    the challenge unconsumed and the customer keeps their points. */
function consumePatch(at) {
  return { status: STATUS.CONSUMED, consumedAt: Number(at) || Date.now() };
}

module.exports = {
  COLLECTION, TTL_MS, STATUS, REASON,
  gen6, bindingRef, hashCode, codeMatches,
  mint, checkConfirmable, checkSpendable, consumePatch,
};
