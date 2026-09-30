'use strict';

/**
 * SOKONI RIDER EARNING DESTINATION
 * ────────────────────────────────────────────────────────────────────────────
 * Where a rider's money goes, and the only place any rail may ask.
 *
 * Delivery earnings are trading proceeds. They belong in the rider's BUSINESS wallet —
 * `businessWallets/{businessId}` — alongside every other trader's takings, and they reach
 * the rider's own pocket through `businessWalletDraw` into the personal wallet, where the
 * frozen B2C payout rail withdraws them. That last hop is untouched here.
 *
 * ── ONE DESTINATION, WHATEVER THE PROVENANCE ─────────────────────────────────
 * A delivery fee comes from the quote pinned to the job. A tip does not — it is added by
 * the buyer, outside the delivery economics, and the quote has no tip component to
 * manufacture. But the platform already counts both as rider earnings: finos aggregates
 * `riderEarningsCents` from ledger entries of type `delivery_fee` OR `tip`.
 *
 * Different provenance, same destination. Two destinations would mean two meanings of
 * "rider money" and a reconciliation nobody can close.
 *
 * ── HELD, NEVER REDIRECTED ───────────────────────────────────────────────────
 * A rider with no business identity cannot be paid. The money is NOT sent to their
 * personal wallet, NOT attached to an invented business, and NOT discarded: it is
 * recorded as a hold against the rider and the reference that produced it, and it settles
 * when the destination becomes valid.
 *
 * Falling back to a personal wallet is the specific failure this module exists to stop.
 * It is the reason `wallets/{uid}` and `businessWallets/{businessId}` drifted into
 * meaning the same thing.
 */

const admin = require('firebase-admin');
const BW = require('./business-wallet');

const HOLDS = 'riderEarningHolds';

const REASON = Object.freeze({
  NO_RIDER: 'NO_RIDER',
  NO_AMOUNT: 'NO_AMOUNT',
  NO_REFERENCE: 'NO_REFERENCE',
  NO_RIDER_BUSINESS: 'NO_RIDER_BUSINESS',
  UID_SHAPED_BUSINESS: 'UID_SHAPED_BUSINESS',
});

function refuse(reason, detail) {
  return { ok: false, reason, detail: detail == null ? null : detail };
}

/**
 * THE RIDER'S BUSINESS, RESOLVED FROM THEIR UID.
 *
 * Never from anything a caller sent. recordPayment is reachable from a browser, and a
 * caller who could name the destination could name somebody else's.
 */
async function resolveDestination(riderUid, db) {
  const uid = String(riderUid || '').trim();
  if (!uid) return refuse(REASON.NO_RIDER);

  let merchantId = null;
  try {
    const { resolveMerchantIdForOwner } = require('./tenant-identity');
    const r = await resolveMerchantIdForOwner(uid, db || admin.firestore());
    merchantId = r && r.ok ? r.merchantId : null;
    if (!merchantId) return refuse(REASON.NO_RIDER_BUSINESS, (r && r.reason) || 'no-business-for-owner');
  } catch (e) {
    return refuse(REASON.NO_RIDER_BUSINESS, (e && e.message) || 'resolution failed');
  }

  /* THE LAST LINE OF DEFENCE. `businesses` document ids can never equal an auth uid, and
     every POS authority depends on that to tell a person from a shop. If a resolution
     ever returned one, crediting it would put trading proceeds into a uid-keyed document
     and quietly undo the whole separation. */
  try {
    BW.assertNotUidShaped(merchantId, uid);
  } catch (_) {
    return refuse(REASON.UID_SHAPED_BUSINESS, String(merchantId));
  }

  return { ok: true, businessId: merchantId };
}

/** Deterministic, so a replay lands on the document it already wrote. */
function holdDocId(riderUid, ref) {
  return String(riderUid) + '__' + String(ref);
}

/**
 * Credit the rider's business wallet, or hold the money and say why.
 *
 * `ref` must be stable for the earning it represents — it is what makes both the credit
 * and the hold idempotent.
 */
async function creditOrHold(input) {
  const i = input || {};
  const db = i.db || admin.firestore();
  const riderUid = String(i.riderUid || '').trim();
  const amountMinor = Number(i.amountMinor);
  const ref = String(i.ref || '').trim();

  if (!riderUid) return refuse(REASON.NO_RIDER);
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) return refuse(REASON.NO_AMOUNT, String(i.amountMinor));
  if (!ref) return refuse(REASON.NO_REFERENCE);

  const dest = await resolveDestination(riderUid, db);

  if (!dest.ok) {
    /* HELD — attributable, idempotent, and settleable once the rider has a business.
       Deliberately NOT a balance: a hold is an obligation the platform has recorded, not
       money sitting in a second wallet nobody reconciles. */
    const hRef = db.collection(HOLDS).doc(holdDocId(riderUid, ref));
    await hRef.set({
      riderUid, ref,
      amountMinor,
      provenance: i.provenance || 'delivery_earning',
      orderId: i.orderId || null,
      reason: dest.reason,
      detail: dest.detail || null,
      settled: false,
      heldAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});

    return { ok: true, credited: false, held: true, amountMinor,
             reason: dest.reason, holdId: holdDocId(riderUid, ref) };
  }

  /* The wallet module owns the arithmetic, the reversal-debt policy and the deterministic
     entry id. Calling it rather than touching the two documents here is what keeps a
     replay through any entry point crediting exactly once. */
  let res;
  try {
    res = await BW.credit({
      businessId: dest.businessId,
      ownerUid: riderUid,
      amountMinor,
      ref,
      source: i.source || 'delivery',
      description: i.description || 'Delivery earning',
    });
  } catch (e) {
    /* A DESTINATION THAT REFUSED IS AN UNUSABLE DESTINATION. Letting the exception
       escape would abort the caller's whole money path over one rider; holding is the
       same answer given to every other rider who cannot be paid yet. */
    const hRef = db.collection(HOLDS).doc(holdDocId(riderUid, ref));
    await hRef.set({
      riderUid, ref, amountMinor,
      provenance: i.provenance || 'delivery_earning',
      orderId: i.orderId || null,
      reason: 'CREDIT_REFUSED',
      detail: (e && e.message) || String(e),
      settled: false,
      heldAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});
    return { ok: true, credited: false, held: true, amountMinor,
             reason: 'CREDIT_REFUSED', holdId: holdDocId(riderUid, ref) };
  }

  /* `applied` is the wallet module's own word for "this movement happened now";
     `idempotent` means it had already happened. Both are successes — neither is a hold. */
  return { ok: true, credited: true, held: false,
           applied: res ? res.applied === true : false,
           idempotent: res ? res.idempotent === true : false,
           businessId: dest.businessId, amountMinor, ref };
}

module.exports = { HOLDS, REASON, resolveDestination, holdDocId, creditOrHold };
