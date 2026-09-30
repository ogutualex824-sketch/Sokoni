'use strict';
/**
 * SOKONI STORE — the OPERATOR authority
 * functions/first-party-store-operator.js
 *
 * ONE question, answered server-side for every SOKONI Store operation:
 *
 *     is THIS signed-in account the store's named operator?
 *
 * ── OWNER DECISIONS THIS ENCODES (2026-10-01, binding) ───────────────────────────────────
 *   1. The SOKONI Store stays OWNED by its company account (Bravilex International Co.
 *      Limited). Ownership is read from the shop document; nothing here writes it.
 *   2. ONE personal account is the store's OPERATOR. Every other account — including every
 *      admin and superAdmin — is refused with the stable reason `not-store-operator`.
 *      Being an administrator is NOT what grants store access; being the named operator is.
 *
 * ── WHERE THE OPERATOR IS RECORDED, AND WHY THERE ────────────────────────────────────────
 *   firstPartyStoreOperators/{storeId} = { storeId, businessId, ownerUid, operatorUids[] }
 *
 *   · NOT a field on shops/{storeId}. That document is `allow read: if true` — the operator's
 *     uid would be public — and `allow update: if isAdmin()`, so any admin could add
 *     themselves from a browser console.
 *   · NOT a custom claim. A claim is a person-wide credential; the store is one shop.
 *   · NOT `shops.operatorEmail`. Proven audit-only (non-authoritative) — it is a label.
 *   · NOT anything the client sends. The request carries no operator field that is read.
 *
 *   The collection has no rules match block and firestore.rules has no top-level wildcard,
 *   so clients are default-DENIED both reads and writes; only the Admin SDK (this module and
 *   scripts/infra/set-first-party-store-operator.js) can touch it.
 *
 * ── THE RECORD MUST AGREE WITH THE LIVE CHAIN ────────────────────────────────────────────
 *   The operator record names the store, the business and the owner it was written for. If
 *   the designated store, its owner or the owner's one business later changes, the record
 *   is STALE and grants nothing until it is re-issued. A grant written for one chain never
 *   silently transfers to another.
 *
 * ── THE CHAIN (fail closed at every link) ────────────────────────────────────────────────
 *   shops where firstParty == true   → exactly ONE (none / several = refuse)
 *   shop.ownerId                     → required; shop.sellerUid must be ABSENT (the certified
 *                                      identity: a sellerUid would make kasshop._ownedShop hand
 *                                      the store to that account as "their" shop)
 *   tenant-identity.resolveMerchantIdForOwner(ownerId) → exactly ONE active business
 *   business.businessType === 'SOKONI_FIRST_PARTY_STORE' → the label must AGREE with the chain;
 *                                      the label alone is never a credential.
 *
 * Related docs: docs/SOKONI_STORE_OPERATOR_CENSUS.md
 */

const { HttpsError } = require('firebase-functions/v2/https');

const OPERATORS = 'firstPartyStoreOperators';
const FIRST_PARTY_TYPE = 'SOKONI_FIRST_PARTY_STORE';

/** Stable, reportable reasons. Clients branch on `details.reason`, never on message text. */
const REASON = Object.freeze({
  UNAUTHENTICATED:   'unauthenticated',
  NOT_OPERATOR:      'not-store-operator',
  NOT_DESIGNATED:    'store-not-designated',
  AMBIGUOUS:         'store-designation-ambiguous',
  SHOP_NO_OWNER:     'store-has-no-owner',
  SHOP_HAS_SELLER:   'store-carries-sellerUid',
  BUSINESS_UNLINKED: 'store-owner-has-no-business',
  BUSINESS_AMBIGUOUS:'store-owner-has-multiple-businesses',
  BUSINESS_INVALID:  'store-business-invalid',
  LABEL_MISSING:     'store-business-not-first-party',
});

function _db() {
  /* Resolved lazily so the module loads without an initialised app (the syntax gate and
     the require-closure gate both load it cold). */
  const admin = require('firebase-admin');
  if (!admin.apps.length) admin.initializeApp();
  return admin.firestore();
}

/**
 * Resolve the SOKONI Store chain from DATA. Never throws for a data problem — returns
 * `{ ok:false, reason }` so callers can refuse with a precise, stable reason.
 *
 * @param {FirebaseFirestore.Firestore} [dbOverride]
 * @returns {Promise<{ok:true, storeId:string, businessId:string, ownerUid:string, shop:object, business:object}
 *                  | {ok:false, reason:string, detail?:any}>}
 */
async function resolveStoreChain(dbOverride) {
  const db = dbOverride || _db();
  const snap = await db.collection('shops').where('firstParty', '==', true).limit(3).get();
  if (snap.empty) return { ok: false, reason: REASON.NOT_DESIGNATED };
  if (snap.size > 1) return { ok: false, reason: REASON.AMBIGUOUS, detail: snap.docs.map((d) => d.id) };

  const shopDoc = snap.docs[0];
  const shop = shopDoc.data() || {};
  const ownerUid = typeof shop.ownerId === 'string' ? shop.ownerId.trim() : '';
  if (!ownerUid) return { ok: false, reason: REASON.SHOP_NO_OWNER };
  if (shop.sellerUid != null && shop.sellerUid !== '') {
    return { ok: false, reason: REASON.SHOP_HAS_SELLER };
  }

  /* The CANONICAL owner → business resolver. Not a second implementation. */
  const ti = require('./tenant-identity');
  const biz = await ti.resolveMerchantIdForOwner(ownerUid);
  if (!biz || !biz.ok) {
    const r = biz && biz.reason;
    if (r === ti.REASON.AMBIGUOUS) return { ok: false, reason: REASON.BUSINESS_AMBIGUOUS };
    if (r === ti.REASON.UNLINKED)  return { ok: false, reason: REASON.BUSINESS_UNLINKED };
    return { ok: false, reason: REASON.BUSINESS_INVALID, detail: r || null };
  }

  const bSnap = await db.collection('businesses').doc(String(biz.merchantId)).get();
  const business = bSnap.exists ? (bSnap.data() || {}) : null;
  if (!business || String(business.ownerId || '') !== ownerUid) {
    return { ok: false, reason: REASON.BUSINESS_INVALID };
  }
  /* The label must AGREE with an unforgeable chain. Both, in that order. */
  if (business.businessType !== FIRST_PARTY_TYPE) {
    return { ok: false, reason: REASON.LABEL_MISSING, detail: business.businessType || null };
  }

  return { ok: true, storeId: shopDoc.id, businessId: String(biz.merchantId), ownerUid, shop, business };
}

/** Pure: does an operator record authorise `uid` for this exact chain? */
function recordAuthorises(record, chain, uid) {
  if (!record || !chain || !chain.ok || !uid) return false;
  if (String(record.storeId || '') !== chain.storeId) return false;
  if (String(record.businessId || '') !== chain.businessId) return false;
  if (String(record.ownerUid || '') !== chain.ownerUid) return false;
  if (!Array.isArray(record.operatorUids)) return false;
  return record.operatorUids.some((u) => typeof u === 'string' && u === uid);
}

function _deny(reason, message) {
  return new HttpsError('permission-denied',
    message || 'Access denied — the SOKONI Store is operated by its owner.',
    { reason });
}

/**
 * THE GATE. Every SOKONI Store callable calls this first and uses ONLY what it returns.
 *
 * Deliberately ignores `req.auth.token` beyond the uid: admin / superAdmin claims neither
 * grant nor shortcut anything here. Nothing from `req.data` is consulted.
 *
 * @returns {Promise<{uid:string, storeId:string, businessId:string, ownerUid:string, shop:object, business:object}>}
 */
async function assertStoreOperator(req, dbOverride) {
  const uid = req && req.auth && req.auth.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Sign in required.', { reason: REASON.UNAUTHENTICATED });
  }
  const db = dbOverride || _db();
  const chain = await resolveStoreChain(db);
  if (!chain.ok) {
    /* A broken chain is a refusal for EVERYONE, the operator included — a store whose
       identity cannot be proven must not be operable. The reason is logged, and returned
       only as a stable code (no document ids). */
    console.warn('[sokoniStore] chain unresolved', { reason: chain.reason });
    throw new HttpsError('failed-precondition',
      'The SOKONI Store is not available right now.', { reason: chain.reason });
  }
  const recSnap = await db.collection(OPERATORS).doc(chain.storeId).get();
  const record = recSnap.exists ? (recSnap.data() || {}) : null;
  if (!recordAuthorises(record, chain, uid)) {
    /* Security event: a signed-in account asked for the store and is not its operator. */
    console.warn('[sokoniStore] access refused', { reason: REASON.NOT_OPERATOR, uid });
    throw _deny(REASON.NOT_OPERATOR);
  }
  return {
    uid, storeId: chain.storeId, businessId: chain.businessId, ownerUid: chain.ownerUid,
    shop: chain.shop, business: chain.business,
  };
}

/**
 * Boolean form for shop-employees.resolveShopAccess: is `uid` the operator of `shopId`?
 * False on any failure (fail closed).
 */
async function isStoreOperatorFor(uid, shopId, dbOverride) {
  try {
    const db = dbOverride || _db();
    const chain = await resolveStoreChain(db);
    if (!chain.ok || chain.storeId !== String(shopId || '')) return false;
    const recSnap = await db.collection(OPERATORS).doc(chain.storeId).get();
    return recordAuthorises(recSnap.exists ? recSnap.data() : null, chain, uid);
  } catch (_) {
    return false;
  }
}

module.exports = {
  OPERATORS,
  FIRST_PARTY_TYPE,
  REASON,
  resolveStoreChain,
  recordAuthorises,
  assertStoreOperator,
  isStoreOperatorFor,
};
