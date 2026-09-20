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
 * Resolve and AUTHORIZE the merchant a caller may act for, AND say HOW.
 *
 * This is the one place the four granting arms are evaluated. It previously
 * returned a bare merchantId from every arm, which discarded the distinction
 * between owning an organization and merely having access to it — the reason a
 * narrower, owner-only question could not be asked of it (ADR-035 §2).
 *
 * The arms, their order, their reads and their throws are UNCHANGED. The only
 * difference is that the provenance is now returned instead of thrown away.
 *
 *   platform  token.admin | token.superAdmin       0 reads
 *   self      merchantId === uid                   0 reads
 *   owner     businesses/{merchantId}.ownerId      1 read
 *   admin     businesses/{merchantId}.adminUids[]  1 read
 *
 * @param {object} auth        request.auth  (uid + token)
 * @param {string} [requested] caller-supplied merchantId; defaults to auth.uid
 * @returns {Promise<{merchantId: string, via: 'owner'|'admin'|'self'|'platform'}>}
 * @throws  {HttpsError}       unauthenticated | invalid-argument | permission-denied
 */
async function resolveMerchantAccess(auth, requested) {
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
  if (t.admin === true || t.superAdmin === true) return { merchantId, via: 'platform' };

  /* Acting for yourself. NOTE: this returns WITHOUT reading anything, so it
     cannot confirm the organization exists. That is correct for access — it is
     what keeps merchants operating under their own uid working — and it is why
     `self` is never employment ownership (ADR-035 §2). */
  if (merchantId === uid) return { merchantId, via: 'self' };

  /* Otherwise the authoritative document must say so. */
  const snap = await admin.firestore().collection(AUTHORITY).doc(merchantId).get();
  if (!snap.exists) {
    /* FAIL CLOSED. An unknown merchant is not an open one. */
    throw new HttpsError('permission-denied', 'Not authorised for this merchant.');
  }
  const d = snap.data() || {};

  if (d.ownerId === uid) return { merchantId, via: 'owner' };

  /* Multi-admin, when the authority document declares it. Written as an explicit
     array test: `d.adminUids && !d.adminUids.includes(uid)` is the shape that
     produced the fail-open being replaced here. */
  if (Array.isArray(d.adminUids) && d.adminUids.includes(uid)) return { merchantId, via: 'admin' };

  throw new HttpsError('permission-denied', 'Not authorised for this merchant.');
}

/**
 * Resolve and AUTHORIZE the merchant a caller may act for.
 *
 * UNCHANGED CONTRACT. Same signature, same string return, same throws, same
 * reads in the same order — it is the resolver with the provenance dropped.
 * Every existing caller observes exactly what it observed before.
 *
 * @param {object} auth        request.auth  (uid + token)
 * @param {string} [requested] caller-supplied merchantId; defaults to auth.uid
 * @returns {Promise<string>}  the authorized merchantId
 * @throws  {HttpsError}       unauthenticated | invalid-argument | permission-denied
 */
async function assertMerchantAccess(auth, requested) {
  return (await resolveMerchantAccess(auth, requested)).merchantId;
}

/**
 * Assert the caller may act on the EMPLOYMENT RELATIONSHIP for this merchant —
 * establish, rebind uid, suspend, terminate, reinstate (ADR-035 §2).
 *
 * A strictly narrower question than access:
 *
 *   owner     allow
 *   platform  allow — but the organization must EXIST; see below
 *   admin     DENY   — organization access is not employment authority
 *   self      DENY   — merchantId === uid proves nothing was ever created
 *
 * PLATFORM AUTHORIZATION IS NOT BUSINESS EXISTENCE. A platform administrator is
 * authorized to perform the act; that authority does not bring an organization
 * into being. The `platform` arm returns from the resolver having read nothing,
 * so this function performs the existence read ITSELF on that arm alone.
 *
 * The read is deliberately NOT moved into the resolver: doing so would make
 * `assertMerchantAccess` more expensive and would make the `self` arm fail for a
 * merchant whose business document does not exist — silently tightening an
 * established compatibility path.
 *
 *   owner     allow, 1 read (the resolver's)
 *   admin     deny,  1 read (the resolver's)
 *   self      deny,  0 reads
 *   platform  1 extra read — the only added cost in this module
 *
 * @param {object} auth        request.auth  (uid + token)
 * @param {string} [requested] caller-supplied merchantId; defaults to auth.uid
 * @returns {Promise<string>}  the authorized merchantId
 * @throws  {HttpsError}       unauthenticated | invalid-argument | permission-denied
 */
async function assertMerchantOwner(auth, requested) {
  const { merchantId, via } = await resolveMerchantAccess(auth, requested);

  if (via === 'owner') return merchantId;

  if (via === 'platform') {
    /* The organizational anchor must exist. One denial message for every
       refusal here, so a caller cannot probe which organizations exist. */
    const snap = await admin.firestore().collection(AUTHORITY).doc(merchantId).get();
    if (snap.exists) return merchantId;
  }

  /* `admin` and `self` fall through, and so does a platform caller naming an
     organization that was never created. */
  throw new HttpsError('permission-denied',
    'Not authorised to manage employment for this merchant.');
}

/** Non-throwing variant for paths that must degrade rather than fail. */
async function canAccessMerchant(auth, requested) {
  try { await assertMerchantAccess(auth, requested); return true; }
  catch (_) { return false; }
}

/* Additive only. Four procurement slice suites delete this module from the
   require cache and re-require it under a stubbed firebase-admin, so the export
   shape is load-bearing for tests that never import it directly. */
module.exports = {
  resolveMerchantAccess,
  assertMerchantAccess,
  assertMerchantOwner,
  canAccessMerchant,
  isValidMerchantId,
  AUTHORITY,
};
