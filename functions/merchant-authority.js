/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT AUTHORITY — the single primitive that decides whether a caller may
   act for a merchant.
   ══════════════════════════════════════════════════════════════════════════════
   WHY THIS EXISTS

   An audit on 2026-08-28 found eight-plus callables across four modules taking a
   caller-supplied `merchantId` and using it to select or mutate tenant data:

     pos-peripherals        trusted `users/{uid}.merchantId` — a field the OWNER
                            CAN WRITE. Firestore rules guard uid, role,
                            registeredAs and provider on that document; they do
                            not guard merchantId, and `profileEditWithinLimit`
                            passes whenever the edit counter is unchanged. So a
                            seller could point that field at another merchant and
                            read, write or delete their POS peripherals.
     pos-zero-friction      posGetQueueMetrics had NO binding — `_assertAuth`
                            only checks that a uid exists.
     business-health-score  three callables with NO binding.
     procurement            manager/admin claim only — role, never tenant.

   Three CORRECT implementations already existed, each against a DIFFERENT
   authority: shops.ownerUid (sfos-engine), merchants.ownerId (crm),
   businesses.ownerId (ownsBiz, in the rules). That is the real defect — no
   shared primitive, so every author invented one and two forgot entirely.

   CANONICAL AUTHORITY: `businesses/{merchantId}.ownerId`.
   `shops` and `merchants` remain useful operationally but must NOT independently
   establish authorization; they are representations that have to agree.

   FAIL CLOSED. A missing businesses document denies. The bug this replaces did
   the opposite: `crm.js` read

       if (data.ownerId !== uid && data.adminUids && !data.adminUids.includes(uid))

   which, when `adminUids` was ABSENT, evaluated the middle conjunct to undefined,
   made the whole condition false, and GRANTED access to a non-owner. Latent only
   because every existing merchant happens to carry the field.

   Shape taken from sfos-engine, the safest implementation in the repo: default to
   the caller, bypass on unforgeable token claims, verify against an authoritative
   document, deny when it is missing.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const AUTHORITY = 'businesses';

/** Merchant ids are document ids. A caller-supplied one must never address
    another path or blow up `.doc()`. */
function isValidMerchantId(id) {
  return typeof id === 'string'
      && id.length > 0
      && id.length <= 200
      && !id.includes('/');
}

/**
 * Resolve and AUTHORIZE the merchant a caller may act for.
 *
 * @param {object} auth        request.auth  (uid + token)
 * @param {string} [requested] caller-supplied merchantId; defaults to auth.uid
 * @returns {Promise<string>}  the authorized merchantId
 * @throws  {HttpsError}       unauthenticated | invalid-argument | permission-denied
 */
async function assertMerchantAccess(auth, requested) {
  if (!auth || !auth.uid) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  const uid = String(auth.uid);

  /* Default to the caller. A merchant asking about itself needs no lookup, and
     this is what keeps merchants that operate under their own uid as merchantId
     working — that form is real and in use. */
  const merchantId = (requested === undefined || requested === null || requested === '')
    ? uid
    : String(requested);

  if (!isValidMerchantId(merchantId)) {
    throw new HttpsError('invalid-argument', 'A valid merchantId is required.');
  }

  /* Platform admins. Token claims are set server-side and cannot be forged by
     the holder — unlike any user-document field. */
  const t = (auth.token || {});
  if (t.admin === true || t.superAdmin === true) return merchantId;

  /* Acting for yourself. */
  if (merchantId === uid) return merchantId;

  /* Otherwise the authoritative document must say so. */
  const snap = await admin.firestore().collection(AUTHORITY).doc(merchantId).get();
  if (!snap.exists) {
    /* FAIL CLOSED. An unknown merchant is not an open one. */
    throw new HttpsError('permission-denied', 'Not authorised for this merchant.');
  }
  const d = snap.data() || {};

  if (d.ownerId === uid) return merchantId;

  /* Multi-admin, when the authority document declares it. Written as an explicit
     array test: `d.adminUids && !d.adminUids.includes(uid)` is the shape that
     produced the fail-open being replaced here. */
  if (Array.isArray(d.adminUids) && d.adminUids.includes(uid)) return merchantId;

  throw new HttpsError('permission-denied', 'Not authorised for this merchant.');
}

/** Non-throwing variant for paths that must degrade rather than fail. */
async function canAccessMerchant(auth, requested) {
  try { await assertMerchantAccess(auth, requested); return true; }
  catch (_) { return false; }
}

module.exports = { assertMerchantAccess, canAccessMerchant, isValidMerchantId, AUTHORITY };
