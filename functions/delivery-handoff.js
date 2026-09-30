/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — DELIVERY HANDOFF AUTHORITY
   functions/delivery-handoff.js

   Two physical moments in a delivery need a witness, and only one party is present at
   each: the SHOP authorises a rider leaving with goods, and the BUYER confirms that the
   goods arrived. This module decides whether a submitted PIN is evidence of the moment it
   claims to be evidence of. It decides nothing else.

   ── A PIN IS EVIDENCE, NEVER AN AUTHORITY ─────────────────────────────────────
   Three layers, deliberately separate:

       delivery-handoff.js     did this physical event happen, and can it be proven?
       delivery-dispatch-job   is this lifecycle transition legal?
       delivery-settlement.js  what money moves, and to whom?

   A compromised UI that can drive a PIN interaction must not thereby be able to move
   money. It can, at most, assert that a handoff occurred — and the lifecycle authority
   still has to accept the transition, and the settlement authority still reads its amounts
   from the pinned quote rather than from anything a caller sent.

   ── WHAT THE PIN IS BOUND TO, AND WHY EACH BINDING EARNS ITS PLACE ────────────
   The hash is an HMAC over the PIN and a canonical binding string. Change any element and
   the same six digits stop verifying:

       deliveryId   a PIN from another delivery cannot release this one
       purpose      a departure code cannot be replayed as a receipt confirmation
       shopId       a code issued at one shop cannot authorise another shop's handoff
       riderUid     re-offering the job to a different rider invalidates the old code
       buyerUid     a receipt code belongs to the person who ordered

   A generic shop PIN — one code that authorises any departure — is the failure this
   binding exists to make impossible. It would be shared, written on a wall, and used to
   release goods to whoever asked.

   ── SIX DIGITS ARE ONLY SAFE BECAUSE THE KEY IS SECRET ────────────────────────
   The stored value is an HMAC, so the document can be read without the code being
   recoverable — but a 6-digit space is trivially enumerable to anyone holding the key.
   The key is a Secret Manager value; the fallback constant exists so that a missing
   secret degrades to "verification impossible", never to "verification passes".

   PURE. No Firestore, no network, no admin SDK — the caller loads the job and persists the
   result. Certifiable without an emulator.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const crypto = require('crypto');

/** The two moments. Nothing else may be confirmed with a PIN. */
const PURPOSE = {
  /* The shop hands goods to the rider. Authorised by the merchant or a cashier on duty. */
  DEPARTURE: 'DEPARTURE',
  /* The buyer receives the goods. This is what permits DELIVERED, and therefore money. */
  RECEIPT: 'RECEIPT',
};

/* Which lifecycle state each confirmation belongs in. A departure code presented before a
   rider has even been dispatched is not early — it is evidence of nothing. */
const PURPOSE_STATES = {
  [PURPOSE.DEPARTURE]: ['DISPATCHED'],
  [PURPOSE.RECEIPT]: ['IN_TRANSIT'],
};

/* Where each confirmation is recorded on the job. Also the replay guard: a confirmation
   that is already present is not re-applied. */
const PURPOSE_FIELD = {
  [PURPOSE.DEPARTURE]: 'departureConfirmedAt',
  [PURPOSE.RECEIPT]: 'receiptConfirmedAt',
};

const PURPOSE_HASH_FIELD = {
  [PURPOSE.DEPARTURE]: 'departurePinHash',
  [PURPOSE.RECEIPT]: 'receiptPinHash',
};

const MAX_ATTEMPTS = 5;

function refuse(reason, detail) { return { ok: false, reason, detail: detail || null }; }

/* ── 1. THE BINDING ─────────────────────────────────────────────────────────── */

/**
 * The canonical string a PIN is bound to. Order and separator are fixed: a binding built
 * by concatenating fields in a different order would verify against a different hash, and
 * the two ends of this would silently stop agreeing.
 *
 * Fields are `|`-separated and each is coerced to a string, so a null rider and the
 * literal string "null" cannot produce the same binding as one another by accident — the
 * empty marker is explicit.
 */
function binding(o) {
  const p = String((o && o.purpose) || '').toUpperCase();
  const f = (v) => (v === null || v === undefined || v === '' ? '∅' : String(v));
  return [
    'sokoni-delivery-handoff-v1',
    f(o && o.deliveryId),
    p,
    f(o && o.shopId),
    f(o && o.riderUid),
    f(o && o.buyerUid),
  ].join('|');
}

/** Keyed hash of a PIN against its binding. */
function hash(bindingStr, pin, key) {
  return crypto.createHmac('sha256', String(key || ''))
    .update(String(bindingStr) + '|' + String(pin))
    .digest('hex');
}

/** Cryptographically-random, unbiased 6-digit code. */
function generatePin() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/* ── 2. ISSUING ─────────────────────────────────────────────────────────────── */

/**
 * Mint a PIN for one purpose on one job.
 *
 * Returns BOTH the plaintext and the hash. The caller stores the hash on the job — which
 * its parties can read — and delivers the plaintext only to the party it belongs to,
 * through a path that proves who they are. Storing the plaintext where a party to the job
 * can read it defeats the whole mechanism, and has done before on this platform.
 */
function issue(input) {
  const { job, purpose, key } = input || {};
  if (!job || !job.deliveryId) return refuse('NO_JOB');
  const p = String(purpose || '').toUpperCase();
  if (!PURPOSE[p]) return refuse('UNKNOWN_PURPOSE', String(purpose || ''));
  if (!key) return refuse('NO_SIGNING_KEY', 'a PIN that cannot be signed cannot be verified');

  if (p === PURPOSE.DEPARTURE && !job.assignedRiderUid) {
    return refuse('NO_ASSIGNED_RIDER', 'a departure code is bound to the rider it authorises');
  }
  if (p === PURPOSE.RECEIPT && !job.customerUid) {
    /* A counter collection has no buyer, and a receipt code with nobody to give it to
       would be a code the rider both holds and verifies. */
    return refuse('NO_BUYER', 'a receipt code belongs to the person who ordered');
  }

  const pin = (input.pin != null) ? String(input.pin) : generatePin();
  if (!/^\d{6}$/.test(pin)) return refuse('MALFORMED_PIN', pin.length + ' characters');

  const b = binding({
    deliveryId: job.deliveryId, purpose: p,
    shopId: job.merchantUid, riderUid: job.assignedRiderUid, buyerUid: job.customerUid,
  });

  return { ok: true, purpose: p, pin, hash: hash(b, pin, key), binding: b, field: PURPOSE_FIELD[p] };
}

/* ── 3. WHO MAY CONFIRM ─────────────────────────────────────────────────────── */

/**
 * The parties who may SUBMIT a confirmation of each kind.
 *
 * The rider may submit the RECEIPT code, and that is not a loophole: the buyer reads the
 * code aloud at the door and the rider types it, which is what makes it evidence the rider
 * was physically there with the buyer. What the rider cannot do is produce the code
 * without the buyer, and cannot reach DELIVERED without it at all.
 *
 * The buyer may also confirm in their own app, for a doorstep where reading a code out is
 * awkward. Either way the same code, bound to the same buyer, is what verifies.
 */
function mayConfirm(job, uid, purpose) {
  if (!job || !uid) return refuse('NO_JOB_OR_UID');
  const p = String(purpose || '').toUpperCase();
  if (!PURPOSE[p]) return refuse('UNKNOWN_PURPOSE', String(purpose || ''));
  const u = String(uid);

  if (p === PURPOSE.DEPARTURE) {
    /* THE SHOP AUTHORISES ITS OWN GOODS LEAVING. The rider may not authorise their own
       departure with a code they were handed — that would make the code a formality the
       rider completes alone. */
    if (u !== String(job.merchantUid)) {
      return refuse('ONLY_THE_SHOP_AUTHORISES_DEPARTURE',
        u === String(job.assignedRiderUid) ? 'a rider cannot authorise their own departure' : 'not this shop');
    }
    return { ok: true, role: 'merchant' };
  }

  /* RECEIPT */
  const isBuyer = job.customerUid && u === String(job.customerUid);
  const isRider = job.assignedRiderUid && u === String(job.assignedRiderUid);
  if (!isBuyer && !isRider) {
    return refuse('NOT_A_PARTY_TO_THIS_HANDOFF');
  }
  if (u === String(job.merchantUid) && !isBuyer && !isRider) {
    return refuse('A_SHOP_CANNOT_CONFIRM_ITS_OWN_DELIVERY');
  }
  return { ok: true, role: isBuyer ? 'customer' : 'rider' };
}

/* ── 4. VERIFYING ───────────────────────────────────────────────────────────── */

/**
 * Is this submitted PIN evidence of this handoff?
 *
 * Every refusal is named, and the ORDER of the checks matters: state and authority are
 * decided before the PIN is compared, so a caller who is not entitled to confirm learns
 * that rather than learning whether their guess was right. An endpoint that compared the
 * PIN first would be a six-digit oracle for anyone who could reach it.
 */
function verify(input) {
  const { job, purpose, uid, pin, key } = input || {};
  if (!job || !job.deliveryId) return refuse('NO_JOB');
  const p = String(purpose || '').toUpperCase();
  if (!PURPOSE[p]) return refuse('UNKNOWN_PURPOSE', String(purpose || ''));
  if (!key) return refuse('NO_SIGNING_KEY', 'verification is impossible, and must not pass');

  /* WRONG STATE FIRST. */
  const states = PURPOSE_STATES[p];
  if (states.indexOf(String(job.state)) === -1) {
    return refuse('WRONG_STATE', job.state + ' — expected ' + states.join(' or '));
  }

  /* THEN AUTHORITY. */
  const who = mayConfirm(job, uid, p);
  if (!who.ok) return who;

  /* THEN REPLAY. A confirmation is one-time: the same code presented twice must not
     produce two departures, and — through the settlement chain it eventually unlocks —
     must not be able to produce two payments. */
  const field = PURPOSE_FIELD[p];
  if (job[field]) return refuse('ALREADY_CONFIRMED', String(job[field]));

  /* THEN THE ATTEMPT BUDGET. Six digits with unlimited guesses is a four-hour brute force;
     with five it is a 1-in-200,000 chance per delivery. Counted per purpose, so a rider
     exhausting departure attempts does not lock the buyer out of confirming receipt. */
  const attempts = Number((job.handoffAttempts || {})[p] || 0);
  if (attempts >= MAX_ATTEMPTS) {
    return refuse('TOO_MANY_ATTEMPTS', attempts + ' of ' + MAX_ATTEMPTS);
  }

  const stored = job[PURPOSE_HASH_FIELD[p]];
  if (!stored) return refuse('NO_PIN_ISSUED', 'nothing was ever minted for this handoff');

  const submitted = String(pin == null ? '' : pin).trim();
  if (!/^\d{6}$/.test(submitted)) {
    /* Counted as an attempt: a malformed guess is still a guess. */
    return Object.assign(refuse('MALFORMED_PIN'), { countsAsAttempt: true });
  }

  const b = binding({
    deliveryId: job.deliveryId, purpose: p,
    shopId: job.merchantUid, riderUid: job.assignedRiderUid, buyerUid: job.customerUid,
  });
  const computed = hash(b, submitted, key);

  if (!sameHash(computed, stored)) {
    /* The binding is why this is the only refusal a wrong-shop, wrong-rider or wrong-order
       code can produce: they all fail here, indistinguishably, which is the point. */
    return Object.assign(refuse('PIN_MISMATCH'), { countsAsAttempt: true });
  }

  return {
    ok: true,
    purpose: p,
    role: who.role,
    field,
    /* What the caller must persist. Returned rather than written, because this module does
       not touch Firestore and the caller is doing it inside the same transaction that
       advances the lifecycle. */
    confirmation: {
      by: String(uid),
      role: who.role,
      at: input.at || new Date().toISOString(),
    },
  };
}

/** Constant-time comparison. A timing oracle on a 6-digit code is a real one. */
function sameHash(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(x, y); } catch (_) { return false; }
}

/* ── 5. WHAT THE LIFECYCLE MAY DO WITH IT ───────────────────────────────────── */

/**
 * Has the handoff chain reached the point where `to` is permitted?
 *
 * The lifecycle authority owns which transitions are legal; this owns which of them
 * require physical evidence. Kept here rather than in the transition table because the
 * table describes shape, and this describes proof.
 */
const REQUIRES = {
  PICKED_UP: PURPOSE.DEPARTURE,   /* goods left the shop with the shop's authorisation */
  DELIVERED: PURPOSE.RECEIPT,     /* goods reached the buyer, and the buyer said so */
};

function evidenceFor(job, to) {
  const need = REQUIRES[String(to || '').toUpperCase()];
  if (!need) return { ok: true, required: null };
  const field = PURPOSE_FIELD[need];
  if (!job || !job[field]) {
    return refuse('HANDOFF_NOT_CONFIRMED',
      need === PURPOSE.RECEIPT
        ? 'a rider cannot mark their own delivery delivered without the buyer confirming it'
        : 'the shop has not authorised this rider to leave with the goods');
  }
  return { ok: true, required: need, confirmedAt: job[field] };
}

module.exports = {
  PURPOSE, PURPOSE_STATES, PURPOSE_FIELD, PURPOSE_HASH_FIELD, REQUIRES, MAX_ATTEMPTS,
  binding, hash, generatePin, issue, mayConfirm, verify, evidenceFor, sameHash,
};
