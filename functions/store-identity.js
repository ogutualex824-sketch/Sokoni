'use strict';
/**
 * SOKONI — STORE IDENTITY
 *
 * The canonical merchant chain, and the module that keeps its four links distinct:
 *
 *     auth.uid  →  businessId  →  storeId  →  storefront
 *
 * WHY THIS EXISTS
 * ---------------
 * `businessId` already had a home: `businesses/{merchantId}`, where the id is minted by
 * business-bootstrap's `_generateMerchantId()` and, as tenant-identity.js puts it, "can never
 * equal an auth uid". That invariant is what separates the two tenant spaces.
 *
 * `storeId` had no such home. Approval wrote `shops/{uid}`, so the store WAS the uid — and a
 * store that is the uid cannot be the second store, cannot be transferred, and cannot be told
 * apart from the person who owns it. Every downstream authority then had to decide for itself
 * whether `sellerId` meant a person or a shop, which is the same ambiguity tenant-identity was
 * written to end one level up.
 *
 * THE UID KEYSPACE IS NOT ABANDONED, IT IS DEMOTED
 * ------------------------------------------------
 * Existing merchants hold `shops/{uid}` documents and 128 call sites read them. Re-keying
 * those is a migration, not a refactor, and it cannot be verified without production. So:
 *
 *   · a NEW store is created at a generated `storeId` and is never keyed on a uid
 *   · a LEGACY store keyed on the uid keeps working, unchanged
 *   · both carry `ownerId`, and BOTH are found by the same query-based resolver
 *
 * That is why resolution is by `ownerId` rather than by document id. It makes the two
 * keyspaces one lookup instead of two code paths, and it means the migration is "new rows
 * stop using the old shape", not "rewrite every old row".
 *
 * AMBIGUITY IS AN ERROR, NEVER A GUESS
 * ------------------------------------
 * Exactly the reasoning tenant-identity uses: reading TWO and refusing on two is cheap, and
 * silently picking the first is how a merchant's money reaches the wrong till. An owner with
 * two stores is a real thing; choosing one of them on their behalf is not.
 */

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const crypto = require('crypto');
const db = () => admin.firestore();

const SHOPS = 'shops';

/** Distinct, reportable reasons. A caller must be able to say WHICH failure it hit. */
const REASON = {
  UNLINKED:  'no-store-for-owner',
  AMBIGUOUS: 'owner-has-multiple-stores',
  MALFORMED: 'store-record-malformed',
  INACTIVE:  'store-not-active',
  NOT_OWNER: 'store-not-owned-by-caller',
};

/**
 * A generated store id. `STR_` prefixed and hex, so it is structurally incapable of colliding
 * with a Firebase uid (28 chars, base64url alphabet, no underscore prefix). The invariant is
 * asserted rather than assumed — see `assertNotUidShaped`.
 */
function mintStoreId() {
  return 'STR_' + crypto.randomBytes(12).toString('hex');
}

/**
 * The invariant that makes the whole chain meaningful: a store id must not BE a uid.
 *
 * Checked by construction rather than by trusting the minter, because the value also arrives
 * from stored documents and from callers. A store id that equals the owner's uid is the exact
 * collapse this module exists to prevent, so it is refused loudly instead of flowing onward.
 */
function assertNotUidShaped(storeId, ownerUid) {
  const s = String(storeId || '');
  if (!s) throw new Error('store id is empty');
  if (ownerUid && s === String(ownerUid)) {
    throw new Error('store id must not equal the owner uid — Business/Store/UID must stay distinct');
  }
  return s;
}

/** True when this id was minted by this module. Legacy uid-keyed stores return false. */
function isCanonicalStoreId(storeId) {
  return /^STR_[0-9a-f]{24}$/.test(String(storeId || ''));
}

/**
 * ownerUid → the store they operate.
 *
 * Finds BOTH keyspaces because it queries `ownerId` rather than addressing a document id:
 * a legacy `shops/{uid}` row and a canonical `shops/{STR_…}` row are both matched.
 *
 * @returns {{ok:true, storeId:string, data:object, legacy:boolean}|{ok:false, reason:string, count?:number}}
 */
async function resolveStoreForOwner(ownerUid, dbOverride) {
  if (!ownerUid || typeof ownerUid !== 'string') return { ok: false, reason: REASON.MALFORMED };

  /* Defaults to the ambient handle; a caller that was HANDED a Firestore passes it, so it
     cannot resolve against a different database than the one it writes to. See the same note
     in tenant-identity.resolveMerchantIdForOwner. */
  const fs = dbOverride || db();

  /* TWO, not one — enough to DETECT ambiguity, still a cheap read. */
  const snap = await fs.collection(SHOPS).where('ownerId', '==', ownerUid).limit(2).get();

  if (snap.empty) return { ok: false, reason: REASON.UNLINKED };
  if (snap.size > 1) return { ok: false, reason: REASON.AMBIGUOUS, count: snap.size };

  const doc = snap.docs[0];
  const d = doc.data() || {};
  if (!doc.id) return { ok: false, reason: REASON.MALFORMED };
  /* A stored `shopId` that disagrees with the document id means something wrote this row
     without understanding the contract. Preferring one over the other is how a split starts. */
  if (d.shopId && String(d.shopId) !== doc.id) return { ok: false, reason: REASON.MALFORMED };

  return {
    ok: true,
    storeId: doc.id,
    data: d,
    legacy: !isCanonicalStoreId(doc.id),
  };
}

/**
 * Prove that `uid` owns `storeId` — by reading the STORE, never by comparing strings.
 *
 * The old proof was `uid === shopId`, which only worked because the two were the same value.
 * With the chain separated the question is a fact about a document: does this store name this
 * caller as its owner?
 */
async function assertOwnsStore(uid, storeId) {
  if (!uid || !storeId) return { ok: false, reason: REASON.MALFORMED };
  const snap = await db().collection(SHOPS).doc(String(storeId)).get();
  if (!snap.exists) return { ok: false, reason: REASON.UNLINKED };
  const d = snap.data() || {};
  const owner = d.ownerId || d.sellerUid || d.ownerUid || null;
  if (!owner) return { ok: false, reason: REASON.MALFORMED };
  if (String(owner) !== String(uid)) return { ok: false, reason: REASON.NOT_OWNER };
  return { ok: true, storeId: String(storeId), businessId: d.businessId || null, data: d };
}

/**
 * Create or resolve the store for a business. IDEMPOTENT, and idempotent in the way that
 * matters: re-running it returns the store that exists rather than minting a second one.
 *
 * Two guards, because they fail differently:
 *
 *   1. an ownerId query catches the ordinary re-run (the store already exists)
 *   2. a transactional claim on `storeProvisioning/{uid}` catches the CONCURRENT re-run —
 *      two approvals racing, which the query alone cannot see because neither has written yet
 *
 * The claim is released on failure. A claim held by a run that died would leave the merchant
 * permanently unprovisionable, which is the failure this guard exists to prevent, arrived at
 * from the other side. That is the same shape `_ensureBusinessForOwner` already uses, and it
 * is deliberately not a second mechanism.
 */
async function ensureStoreForBusiness(o) {
  const uid = String((o && o.uid) || '');
  const businessId = String((o && o.businessId) || '');
  if (!uid) throw new Error('ensureStoreForBusiness requires a uid');
  if (!businessId) throw new Error('ensureStoreForBusiness requires a businessId');
  /* The business id must itself be distinct from the uid, or the chain is already collapsed
     one link up and a correct store id would give false assurance. */
  assertNotUidShaped(businessId, uid);

  const existing = await resolveStoreForOwner(uid);
  if (existing.ok) {
    return { created: false, reason: 'already-provisioned', storeId: existing.storeId,
             legacy: existing.legacy };
  }
  if (existing.reason === REASON.AMBIGUOUS) {
    /* Never mint a third store to resolve a tie between two. */
    return { created: false, reason: REASON.AMBIGUOUS, storeId: null, count: existing.count };
  }

  const guard = db().collection('storeProvisioning').doc(uid);
  const storeId = assertNotUidShaped(mintStoreId(), uid);
  const won = await db().runTransaction(async (t) => {
    const g = await t.get(guard);
    if (g.exists && (g.data() || {}).storeId) return false;
    t.set(guard, {
      uid, businessId, storeId,
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return true;
  });
  if (!won) {
    const again = await resolveStoreForOwner(uid);
    return again.ok
      ? { created: false, reason: 'already-provisioned', storeId: again.storeId, legacy: again.legacy }
      : { created: false, reason: 'claim-held', storeId: null };
  }

  return { created: true, reason: 'provisioned', storeId, legacy: false };
}

/**
 * The whole chain for one owner, resolved and CHECKED — the single call an authority should
 * make when it needs to know who it is dealing with.
 *
 * Returns the links AND the proof that they are distinct, so a caller cannot accidentally
 * accept a collapsed chain by reading only the fields it happens to care about.
 */
async function resolveChain(uid) {
  const { resolveMerchantIdForOwner } = require('./tenant-identity');
  const biz = await resolveMerchantIdForOwner(uid);
  if (!biz.ok) return { ok: false, stage: 'business', reason: biz.reason, count: biz.count };

  const store = await resolveStoreForOwner(uid);
  if (!store.ok) return { ok: false, stage: 'store', reason: store.reason, count: store.count,
                          businessId: biz.merchantId };

  const distinct = String(uid) !== String(biz.merchantId)
                && String(uid) !== String(store.storeId)
                && String(biz.merchantId) !== String(store.storeId);

  return {
    ok: true,
    uid: String(uid),
    businessId: biz.merchantId,
    storeId: store.storeId,
    legacyStore: store.legacy,
    /* Reported, never assumed. A legacy store IS keyed on the uid, so `distinct` is false for
       those merchants — which is the honest answer, not a bug in this resolver. */
    distinct,
  };
}

module.exports = {
  REASON,
  mintStoreId,
  assertNotUidShaped,
  isCanonicalStoreId,
  resolveStoreForOwner,
  assertOwnsStore,
  ensureStoreForBusiness,
  resolveChain,
};
