/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — Email verification challenge  (Auth Slice 1: model only)
   ------------------------------------------------------------------------------
   Collection:  authEmailChallenges/{uid}      CF-ONLY — no Firestore rule, ever.

   WHAT THIS IS
   The server-side half of "password alone is not enough to finish logging in".
   It issues a short-lived, single-use numeric code bound to one uid and one email
   address, and verifies it. Nothing here talks to the client, sends mail, or grants a
   session — those are later slices. This module is the truth about whether a code is
   valid, and it is the ONLY thing that knows.

   WHAT IT DELIBERATELY IS NOT
   It never returns the code from verify(), never logs it, and never stores it. The
   document holds a SALTED HASH; the plaintext exists only in the return value of
   issue(), long enough for the caller to put it in an email, and nowhere else. A
   challenge that could be read back is not a challenge.

   WHY THE DOCUMENT ID IS THE UID
   One active challenge per account, so "account A cannot use account B's code" is
   structural rather than a check somebody has to remember to write, and a resend
   supersedes the previous code by construction instead of leaving two valid codes
   alive. The cost is that a user cannot have two challenges at once, which is the
   behaviour we want anyway.

   NO FIRESTORE RULE — ON PURPOSE
   firestore.rules has no `match /authEmailChallenges/...` and must not gain one.
   Unlisted collections are denied to every client, including admins (there is no
   `/{document=**}` catch-all in this ruleset — verified, not assumed). The Admin SDK
   bypasses rules, so Cloud Functions reach it and browsers cannot. That is the same
   boundary wishlistItems uses, and it means this slice needs NO rules change — the
   ruleset stays frozen at ca9e8924.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const crypto = require('crypto');
const admin = require('firebase-admin');

const COLLECTION = 'authEmailChallenges';

/* Tunables. Deliberately conservative: a 6-digit code has a 1-in-a-million guess rate,
   so 5 attempts inside 10 minutes is a ~1-in-200,000 chance of a blind hit even before
   the resend cooldown is counted. */
const CODE_LENGTH      = 6;
const TTL_MS           = 10 * 60 * 1000;      /* 10 minutes */
const MAX_ATTEMPTS     = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;         /* 60s between sends */
const MAX_SENDS        = 5;                   /* per challenge lifetime */

/* Reasons are returned as stable machine-readable codes. The CALLER decides what a
   shopper is told; a module that hands back prose invites a UI that leaks whether an
   account exists. */
const REASON = {
  OK:              'ok',
  NO_CHALLENGE:    'no-challenge',
  EXPIRED:         'expired',
  ALREADY_USED:    'already-used',
  TOO_MANY:        'too-many-attempts',
  WRONG_CODE:      'wrong-code',
  EMAIL_MISMATCH:  'email-mismatch',
  COOLDOWN:        'cooldown',
  SEND_LIMIT:      'send-limit',
  BAD_INPUT:       'bad-input',
};

function _db() { return admin.firestore(); }
function _ref(uid) { return _db().collection(COLLECTION).doc(String(uid)); }

/* ── code + hashing ───────────────────────────────────────────────────────────
   randomInt is the CSPRNG. Math.random() would be predictable enough to matter for a
   six-digit space, and this is an authentication factor. */
function _generateCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += String(crypto.randomInt(0, 10));
  return out;
}

/* Per-challenge salt, so two users with the same code do not share a hash and a leaked
   document cannot be replayed against another. */
function _hash(code, salt) {
  return crypto.createHash('sha256').update(String(salt) + ':' + String(code)).digest('hex');
}

/* Constant-time compare. A plain === leaks, through timing, how many leading digits were
   right — which turns a 1-in-a-million guess into six 1-in-10 guesses. */
function _safeEqual(a, b) {
  const A = Buffer.from(String(a), 'utf8');
  const B = Buffer.from(String(b), 'utf8');
  if (A.length !== B.length) return false;
  try { return crypto.timingSafeEqual(A, B); } catch (e) { return false; }
}

const _normEmail = (e) => String(e || '').trim().toLowerCase();

/* ── issue ────────────────────────────────────────────────────────────────────
   Creates or REPLACES the challenge for this uid. Replacement is the supersede path: the
   previous hash is gone, so the old code stops working the moment a new one is issued.

   Returns { ok, code, expiresAt, ... }. `code` is the ONLY place the plaintext appears —
   the caller hands it to the mailer and must not persist or log it. */
async function issue(uid, email, opts) {
  opts = opts || {};
  if (!uid || !_normEmail(email)) return { ok: false, reason: REASON.BAD_INPUT };

  const now = opts.now || Date.now();
  const ref = _ref(uid);

  /* Cooldown and send-ceiling are read from the EXISTING challenge, so a caller cannot
     bypass them by asking for a fresh one. */
  const prev = await ref.get();
  if (prev.exists) {
    const d = prev.data() || {};
    const sends = Number(d.sendCount || 0);
    if (d.lastSentAt && (now - Number(d.lastSentAt)) < RESEND_COOLDOWN_MS) {
      return { ok: false, reason: REASON.COOLDOWN,
               retryAfterMs: RESEND_COOLDOWN_MS - (now - Number(d.lastSentAt)) };
    }
    /* The ceiling applies to a LIVE challenge. Once it has expired the user starts over,
       otherwise a single bad day locks the account out of its own login. */
    const stillLive = d.expiresAt && now < Number(d.expiresAt);
    if (stillLive && sends >= MAX_SENDS) return { ok: false, reason: REASON.SEND_LIMIT };
  }

  const code = _generateCode();
  const salt = crypto.randomBytes(16).toString('hex');
  const carriedSends = (prev.exists && prev.data().expiresAt && now < Number(prev.data().expiresAt))
    ? Number(prev.data().sendCount || 0) : 0;

  const doc = {
    uid: String(uid),
    email: _normEmail(email),        /* binds the challenge to the address it was sent to */
    codeHash: _hash(code, salt),
    salt,
    createdAt: now,
    expiresAt: now + TTL_MS,
    attempts: 0,
    sendCount: carriedSends + 1,
    lastSentAt: now,
    consumedAt: null,
    /* Server clock, for audit. The numeric fields above drive the logic so that a clock
       skew between instances cannot silently extend a challenge. */
    serverCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await ref.set(doc);

  return { ok: true, code, expiresAt: doc.expiresAt, sendCount: doc.sendCount,
           cooldownMs: RESEND_COOLDOWN_MS };
}

/* ── verify ───────────────────────────────────────────────────────────────────
   Single-use is enforced inside a TRANSACTION. Two tabs submitting the same correct code
   at once must not both succeed: whichever commits first sets consumedAt, and the other
   re-reads it and is refused. A read-then-write outside a transaction would let both
   through, which is exactly the shape of bug that makes a "single-use" code reusable.

   A failed attempt increments the counter in the same transaction, so a caller cannot
   burn unlimited guesses by racing. */
async function verify(uid, code, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  if (!uid || !/^\d+$/.test(String(code || ''))) {
    return { ok: false, reason: REASON.BAD_INPUT };
  }
  const ref = _ref(uid);

  return _db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, reason: REASON.NO_CHALLENGE };
    const d = snap.data() || {};

    if (d.consumedAt) return { ok: false, reason: REASON.ALREADY_USED };
    if (!d.expiresAt || now >= Number(d.expiresAt)) return { ok: false, reason: REASON.EXPIRED };
    if (Number(d.attempts || 0) >= MAX_ATTEMPTS) return { ok: false, reason: REASON.TOO_MANY };

    /* The email the challenge was issued for must still be the one being verified. An
       account that changed address mid-flow does not get to complete on the old one. */
    if (opts.email && _normEmail(opts.email) !== _normEmail(d.email)) {
      tx.update(ref, { attempts: Number(d.attempts || 0) + 1 });
      return { ok: false, reason: REASON.EMAIL_MISMATCH };
    }

    if (!_safeEqual(_hash(code, d.salt), d.codeHash)) {
      const attempts = Number(d.attempts || 0) + 1;
      tx.update(ref, { attempts });
      return { ok: false, reason: REASON.WRONG_CODE,
               attemptsRemaining: Math.max(0, MAX_ATTEMPTS - attempts) };
    }

    tx.update(ref, { consumedAt: now, attempts: Number(d.attempts || 0) + 1 });
    return { ok: true, reason: REASON.OK, email: d.email };
  });
}

/* Read-only status for a UI that needs to know whether to show the screen. Deliberately
   returns no hash, no salt and no code — only whether a live challenge exists and when
   the caller may resend. */
async function status(uid, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const snap = await _ref(uid).get();
  if (!snap.exists) return { exists: false };
  const d = snap.data() || {};
  return {
    exists: true,
    email: d.email,
    expiresAt: Number(d.expiresAt || 0),
    expired: !d.expiresAt || now >= Number(d.expiresAt),
    consumed: !!d.consumedAt,
    attemptsRemaining: Math.max(0, MAX_ATTEMPTS - Number(d.attempts || 0)),
    canResendAt: Number(d.lastSentAt || 0) + RESEND_COOLDOWN_MS,
    sendCount: Number(d.sendCount || 0),
  };
}

/* Used when a verification completes, or an account is abandoned. Not called by verify()
   itself: keeping the consumed document briefly is what lets a replay be answered with
   "already used" rather than the indistinguishable "no challenge". */
async function clear(uid) {
  await _ref(uid).delete();
  return { ok: true };
}

module.exports = {
  issue, verify, status, clear,
  COLLECTION, REASON,
  LIMITS: { CODE_LENGTH, TTL_MS, MAX_ATTEMPTS, RESEND_COOLDOWN_MS, MAX_SENDS },
  /* exported for tests only — never call from product code */
  _internal: { _hash, _generateCode, _safeEqual },
};
