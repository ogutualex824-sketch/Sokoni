'use strict';
/**
 * SOKONI POS Customer Scope — who a `posCustomers` record belongs to.
 *
 * ── The defect this closes ──────────────────────────────────────────────────
 * `posLookupCustomer` and `getPOSCustomer` searched `posCustomers` by phone,
 * email, document id or member-card code with NO merchant filter of any kind,
 * and returned the customer's name, email, phone, loyalty points, tier, total
 * spent and purchase count. Any authenticated account could look up any customer
 * on the platform by phone number. A phone number is guessable, so this was
 * enumerable cross-tenant PII disclosure.
 *
 * `upsertPOSCustomer` had the write-side twin: it looked up an existing customer
 * by phone collection-wide, so a second merchant upserting the same phone number
 * UPDATED the first merchant's customer document — one record shared between two
 * businesses, with the later name and email overwriting the earlier.
 *
 * ── Why this is a data-model fix, not a query fix ───────────────────────────
 * The writers recorded no owner at all. Traced end to end:
 *
 *   pos-customers.js (client)   writes {id, name, phone, …} — no sellerId,
 *                               no merchantId. `firestore.rules` requires
 *                               `request.resource.data.sellerId == auth.uid` on
 *                               create, so those writes were silently REJECTED
 *                               (the caller does `.catch(() => {})`).
 *   upsertPOSCustomer (server)  Admin SDK, bypasses rules — writes {phone, name,
 *                               email, loyaltyPoints, …}, again with no owner.
 *   pos-crm-pro.js              encodes the owner in the DOCUMENT ID
 *                               (`{sellerId}_{phone}`) but merges bodies that
 *                               carry no owner field.
 *
 * Meanwhile `pos-bi.js` queries `where('sellerId','==',sid)` and
 * `posGetCustomerInsights` queries `where('merchantId','==',merchantId)` — two
 * filters over a collection whose documents carry neither. They match nothing.
 *
 * So there was no field to filter on. Adding one to the QUERY alone would have
 * returned nothing for every real customer and broken the till; picking the
 * composite document id would have covered only the subset pos-crm-pro created.
 * The owner has to be WRITTEN before it can be filtered, which is what this
 * module makes every path do.
 *
 * ── The owner, and where it comes from ──────────────────────────────────────
 * `sellerId` — the authenticated uid, resolved from `auth` and NEVER from the
 * request. That is the identifier `pos-crm-pro`'s composite document id already
 * encodes, and it is the only one available without trusting the caller.
 *
 * It is deliberately NOT read from `req.data.sellerId`. `_resolveSellerId` in
 * pos-crm-pro.js does exactly that when no `sellerId` claim is present — and no
 * `sellerId` claim is minted anywhere in the codebase — so any caller can name
 * any seller there. That is a separate open finding; this module does not
 * inherit it.
 *
 * ── Legacy records ──────────────────────────────────────────────────────────
 * A document with no owner belongs to nobody and is returned to nobody. It is
 * NOT migrated here and NOT guessed at: handing an unattributable customer
 * record to a caller is precisely the disclosure being closed. The next upsert
 * for that phone creates a correctly-owned record, so the path self-heals
 * forward without a backfill script — at the cost of the old record's history,
 * which is a data decision to be made separately rather than assumed here.
 */

const { HttpsError } = require('firebase-functions/v2/https');

const COLLECTION = 'posCustomers';
const OWNER_FIELD = 'sellerId';

/**
 * The caller's merchant identity, from AUTH ONLY.
 *
 * An admin may act for another seller, but must say so explicitly — and that is
 * the one case where a request-supplied seller is honoured, because the claim
 * has already established the caller may.
 */
function resolveOwner(auth, requestedSellerId) {
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const claims = auth.token || {};
  const isAdmin = claims.admin === true || claims.superAdmin === true ||
                  claims.role === 'admin' || claims.role === 'super_admin';
  if (isAdmin && requestedSellerId) return String(requestedSellerId);
  return auth.uid;
}

/**
 * Does this document belong to `ownerUid`?
 *
 * Two accepted shapes, both PROVEN in the existing data rather than assumed:
 *   · the body field `sellerId` — what every path writes from now on
 *   · the composite document id `{sellerId}_{phone}` — what pos-crm-pro created
 *
 * Anything else — including a document with no owner at all — belongs to nobody.
 */
function ownsCustomer(docId, data, ownerUid) {
  if (!ownerUid) return false;
  const d = data || {};
  if (d[OWNER_FIELD] && String(d[OWNER_FIELD]) === String(ownerUid)) return true;
  /* Composite id, matched from the LEFT so a uid containing an underscore
     cannot be spoofed by a crafted phone segment. */
  if (docId && String(docId).indexOf(String(ownerUid) + '_') === 0) return true;
  return false;
}

/**
 * The stamp every create must carry. Written from the resolved owner, so a
 * record can never be created without one again.
 */
function ownerStamp(ownerUid) {
  if (!ownerUid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const patch = {};
  patch[OWNER_FIELD] = String(ownerUid);
  return patch;
}

/**
 * Find one customer of THIS owner by a field, without ever reading another
 * merchant's row into memory. The owner filter is part of the query, not a
 * post-filter — a post-filter still fetches the document it then discards.
 */
async function findOwned(db, ownerUid, field, value, limit) {
  if (!ownerUid) throw new HttpsError('unauthenticated', 'Sign in required.');
  if (!value) return null;
  const snap = await db.collection(COLLECTION)
    .where(OWNER_FIELD, '==', String(ownerUid))
    .where(field, '==', value)
    .limit(limit || 1)
    .get();
  return snap.empty ? null : snap.docs[0];
}

/**
 * Fetch one customer by document id, but only if it belongs to the caller.
 * Returns null otherwise — never throws a distinguishable "exists but not
 * yours", because that is itself an existence disclosure.
 */
async function getOwned(db, ownerUid, customerId) {
  if (!ownerUid || !customerId) return null;
  const snap = await db.collection(COLLECTION).doc(String(customerId)).get();
  if (!snap.exists) return null;
  return ownsCustomer(snap.id, snap.data(), ownerUid) ? snap : null;
}

module.exports = {
  COLLECTION,
  OWNER_FIELD,
  resolveOwner,
  ownsCustomer,
  ownerStamp,
  findOwned,
  getOwned,
};
