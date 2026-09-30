'use strict';
/**
 * SOKONI — SETTLEMENT DESTINATION
 *
 * The one question this module answers, for one paid order:
 *
 *     may this order settle, and into WHICH wallet?
 *
 * and the one thing it never does: guess.
 *
 * ── WHY THIS IS NOT A LOOKUP ──────────────────────────────────────────────────────────────
 * `order-settlement.js` used to answer it in a single line:
 *
 *     const sellerId = order.sellerUid || order.sellerId;
 *     ... db.collection('wallets').doc(sellerId)
 *
 * Two separate defects lived in that line.
 *
 * 1. THE WRONG WALLET. `wallets/{uid}` is a PERSON's wallet — top-ups, payouts, money its
 *    owner may spend on anything. Shop takings are not that. They carry obligations: the
 *    marketplace commission, refunds owed to customers, a reconciliation the merchant can be
 *    asked to produce. Settling them into the owner's personal wallet mixes business money
 *    with private money, and makes "what does this shop owe?" permanently unanswerable —
 *    the balance has already been blended with money that was never the shop's.
 *
 *    The POS/Till lane already got this right (pos-zero-friction.js credits
 *    `businessWallets/{businessId}`). The marketplace lane did not. One business, two lanes,
 *    two different wallets is not a naming inconsistency — it is two different answers to
 *    "how much has this business earned".
 *
 * 2. NO PROOF SOKONI EVER HELD THE MONEY. `settleOrder` checked the order's state machine and
 *    its delivery proof, but never that the payment had been COLLECTED. A wallet credit is
 *    SOKONI paying out of its own collection account; doing that for an order SOKONI never
 *    collected creates money. See `custody` below.
 *
 * ── THE CHAIN, RESOLVED SERVER-SIDE ───────────────────────────────────────────────────────
 *
 *     auth.uid  →  businessId  →  storeId  →  businessWallets/{businessId}
 *
 * Resolved through the canonical resolvers (tenant-identity, store-identity), never from a
 * field on the order. An order document may name a seller; it may not name a WALLET. The
 * difference matters because the wallet is where the money lands, and the id that addresses
 * it must be one the server derived.
 *
 * The chain is also why `businessId` is checked against the owner uid at the door: a
 * `businesses/{uid}` row is the retired identity shortcut, and using it as a wallet key would
 * silently re-collapse Business/Store/UID into one string — the exact thing store-identity.js
 * and tenant-identity.js exist to prevent — while looking like a successful resolution.
 *
 * ── FAIL CLOSED, ALWAYS ───────────────────────────────────────────────────────────────────
 * Every unresolved case returns `{ ok: false, reason }`. None falls back to the personal
 * wallet, and none defaults to a "probably this one". A settlement that cannot name its
 * destination authoritatively is left pending and reconciliable — money waiting is a support
 * ticket, money in the wrong account is a loss and a dispute.
 *
 * The reasons are distinct and reportable because they need DIFFERENT remedies: an
 * unprovisioned merchant needs onboarding finished, an ambiguous one needs a human to say
 * which business trades, and an uncollected payment needs the payment investigated. Collapsing
 * them into "failed" would tell an operator nothing about what to do next.
 */

const REASON = {
  NO_SELLER:        'order-names-no-seller',
  NOT_COLLECTED:    'payment-not-collected-by-sokoni',
  BUSINESS_UNLINKED:  'no-business-for-seller',
  BUSINESS_AMBIGUOUS: 'seller-has-multiple-businesses',
  BUSINESS_INACTIVE:  'business-not-active',
  BUSINESS_MALFORMED: 'business-record-malformed',
  CHAIN_COLLAPSED:  'business-id-equals-the-owner-uid',
};

/** Human-facing remedy for each reason. An operator reading a held order needs the NEXT STEP. */
const REMEDY = {
  [REASON.NO_SELLER]:
    'The order carries no seller. It cannot be attributed; investigate how it was created.',
  [REASON.NOT_COLLECTED]:
    'SOKONI has no record of collecting this payment. Confirm the IntaSend payment before ' +
    'any wallet is credited — a credit here would pay out money SOKONI never received.',
  [REASON.BUSINESS_UNLINKED]:
    'This seller has no business record. Complete merchant provisioning (approval creates the ' +
    'business, the store and the wallet), then release the hold.',
  [REASON.BUSINESS_AMBIGUOUS]:
    'This seller owns more than one business. A human must say which one trades on this ' +
    'storefront — choosing one on their behalf is how a merchant is paid into the wrong book.',
  [REASON.BUSINESS_INACTIVE]:
    'The business is not active. Settle only after its status is resolved.',
  [REASON.BUSINESS_MALFORMED]:
    'The business record disagrees with itself (stored merchantId != document id). Repair the ' +
    'record; do not pick one of the two values.',
  [REASON.CHAIN_COLLAPSED]:
    'The business id equals the owner uid — the retired businesses/{uid} shortcut. This record ' +
    'must be migrated to a generated business id before its money can be kept separately.',
};

/**
 * Did SOKONI actually collect this money?
 *
 * `paymentVerified` is stamped by the payment authority alone. The Firestore rules make it
 * unwritable by any client: `clientOrderInit()` forbids it at create, and neither the buyer's
 * nor the seller's update allowlist contains it. So it is a SERVER fact, and it is the only
 * field on the order that is one.
 *
 * That is what makes it the right gate. A seller can move their own order to `completed`
 * (the rules permit a seller status update, and `completed` is a valid status) — which fires
 * the settlement trigger. Without this check, a seller could create an order as the buyer,
 * name themselves as the seller, complete it, and be credited for a sale that never happened.
 * The state machine alone never proved payment; it proved progress.
 *
 * Kept as its own function, and named for the QUESTION rather than the field, so that adding
 * a second collected-payment rail later means extending one predicate instead of hunting for
 * every place that happened to read `paymentVerified`.
 */
function sokoniCollected(order) {
  return !!order && order.paymentVerified === true;
}

/**
 * Resolve the settlement destination for one order.
 *
 * @returns {Promise<{ok:true, businessId:string, storeId:string|null, ownerUid:string,
 *                     legacyStore:boolean}
 *                  | {ok:false, reason:string, remedy:string, detail?:*}>}
 */
async function resolveSettlementDestination(db, order) {
  const fail = (reason, detail) => ({
    ok: false, reason, remedy: REMEDY[reason] || null,
    ...(detail === undefined ? {} : { detail }),
  });

  const sellerUid = (order && (order.sellerUid || order.sellerId)) || null;
  if (!sellerUid) return fail(REASON.NO_SELLER);

  if (!sokoniCollected(order)) return fail(REASON.NOT_COLLECTED, order && order.status);

  const ti = require('./tenant-identity');
  const si = require('./store-identity');

  /* TWO SHAPES, ONE PATH.
     `sellerUid` is normally an auth uid, but the POS lane already has to cope with an id that
     is ALREADY a business (pos-zero-friction.js does exactly this). Reading the document
     first and falling back to the ownerId query keeps one code path for both, and — unlike a
     format guess — it is decided by what is actually stored. */
  let businessId = null;
  let ownerUid = String(sellerUid);
  const direct = await db.collection('businesses').doc(String(sellerUid)).get().catch(() => null);
  if (direct && direct.exists) {
    const d = direct.data() || {};
    /* A businesses row addressed BY the uid is the retired shortcut. Accepting it would key a
       business wallet on a person — the one thing business-wallet.js refuses at every door —
       so it is refused here too, where the reason can still be explained. */
    if (d.ownerId && String(d.ownerId) === String(sellerUid)) {
      return fail(REASON.CHAIN_COLLAPSED, String(sellerUid));
    }
    if (d.status && d.status !== 'active') return fail(REASON.BUSINESS_INACTIVE, d.status);
    businessId = direct.id;
    ownerUid = String(d.ownerId || sellerUid);
  } else {
    const biz = await ti.resolveMerchantIdForOwner(String(sellerUid), db);
    if (!biz.ok) {
      const map = {
        [ti.REASON.UNLINKED]:  REASON.BUSINESS_UNLINKED,
        [ti.REASON.AMBIGUOUS]: REASON.BUSINESS_AMBIGUOUS,
        [ti.REASON.INACTIVE]:  REASON.BUSINESS_INACTIVE,
        [ti.REASON.MALFORMED]: REASON.BUSINESS_MALFORMED,
      };
      return fail(map[biz.reason] || REASON.BUSINESS_UNLINKED, biz.count);
    }
    businessId = biz.merchantId;
  }

  /* The invariant, asserted rather than assumed — the same call business-wallet.js makes
     before it will touch a balance. Checked HERE too so the refusal is a settlement hold with
     a remedy, instead of an exception thrown mid-transaction. */
  try {
    si.assertNotUidShaped(businessId, ownerUid);
  } catch (_) {
    return fail(REASON.CHAIN_COLLAPSED, businessId);
  }

  /* THE STORE IS PROVENANCE, NOT THE GATE.
     The wallet is keyed on the BUSINESS, so a missing or ambiguous store cannot change which
     wallet is credited — and holding a merchant's money over a fact that does not affect the
     destination would be a hold with no remedy that matters. It is resolved best-effort and
     recorded, so the lineage is on the settlement record even when it is incomplete. */
  let storeId = null, legacyStore = false;
  const store = await si.resolveStoreForOwner(ownerUid, db).catch(() => ({ ok: false }));
  if (store && store.ok) { storeId = store.storeId; legacyStore = !!store.legacy; }

  return { ok: true, businessId: String(businessId), storeId, ownerUid, legacyStore };
}

module.exports = {
  REASON, REMEDY,
  sokoniCollected,
  resolveSettlementDestination,
};
