'use strict';

/**
 * SOKONI CREATOR EARNING DESTINATION
 * ────────────────────────────────────────────────────────────────────────────
 * Where a creator's money goes, and the only place any rail may ask.
 *
 * Content revenue — pay-per-view, a subscription share, a licensing fee — is a trading
 * receipt. It belongs in the creator's BUSINESS wallet, `businessWallets/{businessId}`,
 * and reaches the creator personally through `businessWalletDraw` into the personal
 * wallet, where the frozen B2C payout rail withdraws it. That hop is untouched here.
 *
 * ── HELD, NEVER REDIRECTED ───────────────────────────────────────────────────
 * A creator with no business identity cannot be paid. The money is NOT sent to their
 * personal wallet, NOT attached to an invented business, NOT credited to the platform and
 * NOT discarded: it is recorded as a hold against the creator and the reference that
 * produced it, and settles when the destination becomes valid.
 *
 * The personal-wallet fallback is the specific failure this module exists to stop. It is
 * how `wallets/{uid}` and `businessWallets/{businessId}` drifted into meaning the same
 * thing on the delivery side, and the creator side is being built with the answer already
 * in place rather than migrated to it later.
 *
 * ── A HOLD IS NOT A BALANCE ──────────────────────────────────────────────────
 * It is an obligation the platform has recorded — attributable, idempotent, settleable —
 * not money sitting in a second wallet nobody reconciles. Nothing reads a hold as
 * spendable, and a creator cannot draw against one.
 */

const admin = require('firebase-admin');
const BW = require('./business-wallet');
const CBI = require('./creator-business-identity');

const HOLDS = 'creatorEarningHolds';

const REASON = Object.freeze({
  NO_CREATOR:   'NO_CREATOR',
  NO_AMOUNT:    'NO_AMOUNT',
  NO_REFERENCE: 'NO_REFERENCE',
  NO_CREATOR_BUSINESS: 'NO_CREATOR_BUSINESS',
  UID_SHAPED_BUSINESS: 'UID_SHAPED_BUSINESS',
  CREDIT_REFUSED: 'CREDIT_REFUSED',
});

function refuse(reason, detail) {
  return { ok: false, reason, detail: detail == null ? null : detail };
}

/**
 * The creator's business, resolved server-side from their uid.
 *
 * Delegates rather than duplicating: one resolver, so a rule added there cannot be missing
 * here. `purchaseEntertainment` is reachable from a browser, and a caller who could name
 * the destination could name somebody else's.
 */
async function resolveDestination(creatorUid, db) {
  return CBI.resolveCreatorBusiness(creatorUid, db || admin.firestore());
}

/** Deterministic, so a replay lands on the document it already wrote. */
function holdDocId(creatorUid, ref) {
  return String(creatorUid) + '__' + String(ref);
}

/**
 * Credit the creator's business wallet, or hold the money and say why.
 *
 * `ref` must be stable for the earning it represents — it is what makes both the credit
 * and the hold idempotent, and it is what a reconciliation matches against the provider's
 * own record of the payment.
 */
async function creditOrHold(input) {
  const i = input || {};
  const db = i.db || admin.firestore();
  const creatorUid = String(i.creatorUid || '').trim();
  const amountMinor = Number(i.amountMinor);
  const ref = String(i.ref || '').trim();

  if (!creatorUid) return refuse(REASON.NO_CREATOR);
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) return refuse(REASON.NO_AMOUNT, String(i.amountMinor));
  if (!ref) return refuse(REASON.NO_REFERENCE);

  const dest = await resolveDestination(creatorUid, db);

  if (!dest.ok) {
    const hRef = db.collection(HOLDS).doc(holdDocId(creatorUid, ref));
    await hRef.set({
      creatorUid, ref,
      amountMinor,
      provenance: i.provenance || 'content_revenue',
      listingId: i.listingId || null,
      purchaseId: i.purchaseId || null,
      reason: dest.reason,
      detail: dest.detail || null,
      settled: false,
      heldAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});

    return { ok: true, credited: false, held: true, amountMinor,
             reason: dest.reason, holdId: holdDocId(creatorUid, ref) };
  }

  /* The wallet module owns the arithmetic, the reversal-debt policy and the deterministic
     entry id. Calling it rather than touching the two documents here is what keeps a
     replay through any entry point crediting exactly once. */
  let res;
  try {
    res = await BW.credit({
      businessId: dest.businessId,
      ownerUid: creatorUid,
      amountMinor,
      ref,
      source: Object.assign({ channel: 'ONLINE' }, i.source || {}),
      description: i.description || 'Content revenue',
    });
  } catch (e) {
    /* A DESTINATION THAT REFUSED IS AN UNUSABLE DESTINATION. Letting the exception escape
       would abort the caller's whole settlement over one creator; holding is the same
       answer given to every other creator who cannot be paid yet. */
    const hRef = db.collection(HOLDS).doc(holdDocId(creatorUid, ref));
    await hRef.set({
      creatorUid, ref, amountMinor,
      provenance: i.provenance || 'content_revenue',
      listingId: i.listingId || null,
      purchaseId: i.purchaseId || null,
      reason: REASON.CREDIT_REFUSED,
      detail: (e && e.message) || String(e),
      settled: false,
      heldAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});
    return { ok: true, credited: false, held: true, amountMinor,
             reason: REASON.CREDIT_REFUSED, holdId: holdDocId(creatorUid, ref) };
  }

  /* `applied` is the wallet module's own word for "this movement happened now";
     `idempotent` means it had already happened. Both are successes — neither is a hold. */
  return { ok: true, credited: true, held: false,
           applied: res ? res.applied === true : false,
           idempotent: res ? res.idempotent === true : false,
           businessId: dest.businessId, amountMinor, ref };
}

module.exports = { HOLDS, REASON, resolveDestination, holdDocId, creditOrHold };
