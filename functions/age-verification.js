/* ══════════════════════════════════════════════════════════════════════════
   SOKONI / KASS Vapes — Server-enforced age verification

   WHY THIS EXISTS
   adult-gate.js performs a self-declared date-of-birth check and a Kenya ID
   FORMAT check, then writes sessionStorage.sokoniAgeVerified = "true". There is
   no server record of any kind. Two consequences:

     1. It stops nobody. `localStorage.setItem('sokoniAgeVerified','true')` in the
        console defeats it entirely.
     2. There is no evidence. Asked to demonstrate that a customer's age was
        checked before a nicotine sale, we could produce nothing.

   For SOKONI, where adult categories are incidental, a client-side speed bump was
   defensible. For KASS Vapes — a dedicated nicotine retailer under Kenya's
   Tobacco Control Act 2007 — it is not. The decision and its evidence must live
   server-side, and the check that matters must run where the customer cannot
   reach it.

   PRIVACY BY DESIGN (ODPC standing requirement)
   We record the DECISION, not the raw identity data. Date of birth is never
   stored: it is used to compute an age, the age produces a boolean, and the
   boolean is stored. The national ID is reduced to a salted hash plus its last
   four characters — enough to answer "is this the same person" and to support an
   investigation, without holding a national ID number in Firestore.

   Storing less is not a shortcut here; it is the point. A breach of this
   collection should not expose a customer's identity document.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { defineSecret } = require('firebase-functions/params');
const crypto = require('crypto');
const logger = require('firebase-functions/logger');
const { checkRateLimit } = require('./redis-rate-limiter');

/* Salt for the ID hash. Without a secret salt a national ID number is trivially
   brute-forced from its hash — the ID space is small and structured. */
const AGE_ID_SALT = defineSecret('AGE_ID_SALT');

const MIN_AGE = 18;                     /* Kenya: 18+ for tobacco/nicotine */
const RECHECK_AFTER_DAYS = 365;         /* re-affirm annually */

function _hashId(idNumber, salt) {
  return crypto.createHmac('sha256', salt)
    .update(String(idNumber).trim().toUpperCase())
    .digest('hex');
}

/* Age from a YYYY-MM-DD string, computed server-side. Rejects anything that is
   not a real, past, plausible date — a client cannot submit a malformed value
   and have it read as an adult. */
function _ageFrom(dobStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dobStr || ''))) return null;
  const dob = new Date(dobStr + 'T00:00:00Z');
  if (isNaN(dob.getTime())) return null;
  const now = new Date();
  if (dob > now) return null;
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  if (age > 120) return null;
  return age;
}

/* ── ageVerifySubmit ─────────────────────────────────────────────────────── */
exports.ageVerifySubmit = onCall(
  { cors: true, enforceAppCheck: true, region: 'us-central1', secrets: [AGE_ID_SALT] },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in to continue.');

    /* 'auth' is a security action, so this falls back to a Firestore check
       rather than failing open — age verification is exactly the endpoint an
       attacker would brute-force DOBs against. */
    await checkRateLimit(request, 'auth', { maxRequests: 5, windowSeconds: 300 });

    const { dob, idNumber } = request.data || {};

    const age = _ageFrom(dob);
    if (age === null) throw new HttpsError('invalid-argument', 'Enter your date of birth as YYYY-MM-DD.');

    /* Kenya national ID: 7-8 digits. Format only — we cannot validate against
       the registry, and this is recorded honestly as `format_check` rather than
       implying an identity was confirmed. */
    const id = String(idNumber || '').trim();
    if (!/^\d{7,8}$/.test(id)) throw new HttpsError('invalid-argument', 'Enter a valid Kenyan National ID number.');

    const db = getFirestore();
    const passed = age >= MIN_AGE;

    /* The audit record. Written whether or not the check passed — a refused
       attempt is exactly what an investigation needs to see. */
    await db.collection('ageVerifications').add({
      uid,
      result:     passed ? 'passed' : 'refused',
      minAge:     MIN_AGE,
      ageAtCheck: age,                                     /* an integer, not a birth date */
      idHash:     _hashId(id, AGE_ID_SALT.value()),
      idLast4:    id.slice(-4),
      method:     'self_declared_dob+id_format_check',     /* named honestly */
      brand:      String((request.data || {}).brand || 'sokoni').slice(0, 40),
      createdAt:  FieldValue.serverTimestamp(),
    });

    if (!passed) {
      logger.warn('[age] refused', { uid, ageAtCheck: age });
      /* Deliberately does not say "you are 3 years too young" — that just tells
         someone which date to type next. */
      throw new HttpsError('permission-denied', 'You must be 18 or over to purchase this product.');
    }

    /* The flag the server checks later. On the user document so it travels with
       the account, and CF-written so a client cannot set it. */
    await db.collection('users').doc(uid).set({
      ageVerified:     true,
      ageVerifiedAt:   FieldValue.serverTimestamp(),
      ageVerifiedMethod: 'self_declared_dob+id_format_check',
      /* NO dob, NO idNumber. The decision is retained; the identity data is not. */
    }, { merge: true });

    logger.info('[age] verified', { uid });
    return { verified: true, minAge: MIN_AGE };
  });

/* ── ageVerifyStatus ─────────────────────────────────────────────────────── */
exports.ageVerifyStatus = onCall(
  { cors: true, enforceAppCheck: true, region: 'us-central1' },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in to continue.');
    return await _status(uid);
  });

async function _status(uid) {
  const snap = await getFirestore().collection('users').doc(uid).get();
  const d = snap.exists ? (snap.data() || {}) : {};
  if (d.ageVerified !== true) return { verified: false, reason: 'not_verified' };

  const at = d.ageVerifiedAt && d.ageVerifiedAt.toMillis ? d.ageVerifiedAt.toMillis() : 0;
  if (at && (Date.now() - at) > RECHECK_AFTER_DAYS * 86400000) {
    return { verified: false, reason: 'expired' };
  }
  return { verified: true, verifiedAt: at || null };
}

/* ── assertAgeVerified ───────────────────────────────────────────────────────
   THE ENFORCEMENT POINT. Any checkout, payment or fulfilment path selling a
   restricted product must call this. It is exported as a plain function, not a
   callable, precisely so it runs inside those flows rather than being something
   a client is trusted to have called first.

   The client-side gate may stay as UX — it just stops being the control. */
exports.assertAgeVerified = async function assertAgeVerified(uid) {
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in to continue.');
  const s = await _status(uid);
  if (!s.verified) {
    throw new HttpsError('failed-precondition',
      s.reason === 'expired'
        ? 'Please confirm your age again to continue.'
        : 'Age verification is required for this purchase.');
  }
  return true;
};

/* Categories that require verification before sale. adult-gate.js:8 already
   lists these client-side; this is the server's copy of the same policy, and the
   one that decides. */
exports.RESTRICTED_CATEGORIES = Object.freeze(['vape', 'alcohol', 'tobacco', 'adult', 'nicotine']);

exports.isRestrictedCategory = (cat) =>
  exports.RESTRICTED_CATEGORIES.includes(String(cat || '').toLowerCase());
