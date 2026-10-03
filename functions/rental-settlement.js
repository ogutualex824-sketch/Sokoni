'use strict';
/**
 * Rental settlement — releases a HELD rental payment at completion (owner 2026-10-03; contract 5b ↔ f3 ↔ 2f).
 *
 * ONE settlement, called by f3's rentalComplete INSIDE its transaction (returned → completed). Two phases:
 *
 *   1. quoteRentalSettlement(db, { booking })            — OUTSIDE the txn (the commission engine reads config).
 *      Prices commission from the SERVER intent (paymentIntents/{booking.intentRef}.metadata.commissionBaseCents,
 *      commissionCategory) through finos-utils.calculateCommission — never from booking fields. The category must have an
 *      EXPLICIT commission-config row: an unconfigured category would silently fall to the 5% default, so it is refused.
 *
 *   2. settleRentalBooking(txn, db, { bookingId, booking, ownerUid, actorUid, quote })  — INSIDE the txn, reads only.
 *      Returns { ok:true, apply(t) } or { ok:false, reason, apply(t) } — the caller does its own reads, then calls apply()
 *      after writing status (reads-before-writes holds). ok:false applies ONLY a review row: no money moves.
 *
 * Money (owner decisions 2026-10-03, relayed by f3):
 *   • rent − commission → the SHOP's BUSINESS wallet, businessWallets/{businessId}, in integer CENTS — exactly netCents, so
 *     rent = commission + net to the cent (no floor, no dropped remainder). It uses the ONE business-wallet authority the
 *     marketplace settlement uses: settlement-destination.resolveSettlementDestination (owner → business, uid-shaped ids
 *     refused) and business-wallet.planMove + its deterministic entry id (kind 'rental_settlement', recovery policy as
 *     order settlement). NEVER the owner's personal wallets/{uid} (Financial Core: personal and business never mix).
 *     Those modules are INJECTED (deps.BW, deps.SD) by the deploy tree that carries them; absent → refused
 *     'no_business_wallet', never a fallback.
 *   • the deposit → a B2C refund REQUEST: rentalDepositRefunds/{bookingId}, create() on a deterministic id, state REQUESTED.
 *     Never an inline payout, never a wallet credit, never refundRequests (it auto-credits a wallet). The IntaSend B2C
 *     refund executor picks it up (idempotent, outcome-unknown aware) — EKOQ6P0 is never re-POSTed.
 *   • runs only when paymentStatus 'held' AND returnPinVerified === true AND heldAmountCents === rent + deposit.
 */

const ID_SUFFIX = 'rentalsettle';

async function quoteRentalSettlement(db, { booking, deps }) {
  const b = booking || {};
  const intentRef = typeof b.intentRef === 'string' ? b.intentRef : '';
  if (!intentRef || /[/]/.test(intentRef)) return { ok: false, reason: 'no_intent_ref' };
  let intent;
  try { const s = await db.collection('paymentIntents').doc(intentRef).get(); intent = s.exists ? (s.data() || {}) : null; }
  catch (_) { return { ok: false, reason: 'intent_unreadable' }; }
  if (!intent || intent.resourceType !== 'rentalBooking') return { ok: false, reason: 'no_rental_intent' };
  const m = intent.metadata || {};
  const rentCents = m.commissionBaseCents, depositCents = m.depositCents == null ? 0 : m.depositCents;
  if (!Number.isInteger(rentCents) || rentCents <= 0 || !Number.isInteger(depositCents) || depositCents < 0) return { ok: false, reason: 'intent_amounts_invalid' };
  if (!Number.isInteger(intent.amountCents) || intent.amountCents !== rentCents + depositCents) return { ok: false, reason: 'intent_amounts_inconsistent' };
  const category = String(m.commissionCategory || '');
  const CFG = require('./commission-config');
  if (!category || !CFG.listCategories().includes(category)) return { ok: false, reason: 'commission_unpriced', category: category || null };
  let comm;
  try {
    comm = await require('./finos-utils').calculateCommission(db, { orderAmountCents: rentCents, category, sellerId: m.sellerUid || null, hubId: 'rentals' });
  } catch (e) { return { ok: false, reason: 'commission_refused', detail: String(e && e.message || e).slice(0, 120) }; }
  if (!comm || !Number.isInteger(comm.commissionCents) || comm.commissionCents < 0 || comm.commissionCents > rentCents) return { ok: false, reason: 'commission_invalid' };
  const D = deps || {};
  if (!D.BW || typeof D.BW.planMove !== 'function' || !D.SD || typeof D.SD.resolveSettlementDestination !== 'function') return { ok: false, reason: 'no_business_wallet' };
  const sellerUid = m.sellerUid || null;
  if (!sellerUid) return { ok: false, reason: 'no_owner' };
  let dest;
  try { dest = await D.SD.resolveSettlementDestination(db, { sellerUid, paymentVerified: true }); } catch (_) { dest = { ok: false, reason: 'destination_unreadable' }; }
  if (!dest || dest.ok !== true || !dest.businessId) return { ok: false, reason: 'no_business_wallet', detail: (dest && dest.reason) || null };
  return { ok: true, intentRef, rentCents, depositCents, commissionCents: comm.commissionCents, netCents: rentCents - comm.commissionCents,
    dest: { businessId: String(dest.businessId), ownerUid: dest.ownerUid || sellerUid, storeId: dest.storeId || null }, BW: D.BW,
    commission: { effectiveRate: comm.effectiveRate, pricingSource: comm.pricingSource, ruleId: comm.ruleId, category: comm.category || category, engineVersion: comm.engineVersion || null },
    paymentRef: intent.paymentRef || null };
}

async function settleRentalBooking(txn, db, { bookingId, booking, ownerUid, actorUid, quote, FieldValue }) {
  const FV = FieldValue;
  const b = booking || {};
  const reviewRef = db.collection('commissionReviewQueue').doc(`rental_settle_${bookingId}`);
  const refuse = (reason, extra) => ({ ok: false, reason,
    apply: (t) => t.set(reviewRef, Object.assign({ kind: 'rental_settlement', reason, bookingId, ownerUid: ownerUid || null, actorUid: actorUid || null,
      status: 'open', createdAt: FV.serverTimestamp() }, extra || {}), { merge: true }) });

  if (!bookingId || /[/]/.test(String(bookingId))) return refuse('bad_booking_id');
  if (b.paymentStatus !== 'held') return { ok: false, reason: 'not_held', apply: () => {} };          /* unpaid legacy / refund_due: no money, no noise */
  if (b.returnPinVerified !== true) return refuse('pin_not_verified');
  if (!ownerUid || /[/]/.test(String(ownerUid))) return refuse('no_owner');
  if (!quote || quote.ok !== true) return refuse((quote && quote.reason) || 'no_quote', { quoteDetail: quote && quote.detail || null });
  if (String(quote.dest.ownerUid) !== String(ownerUid)) return refuse('owner_mismatch');   /* the shop owner the caller resolved must own the business credited */
  if (!Number.isInteger(b.heldAmountCents) || b.heldAmountCents !== quote.rentCents + quote.depositCents) {
    return refuse('held_amount_mismatch', { heldAmountCents: Number.isInteger(b.heldAmountCents) ? b.heldAmountCents : null, expectedCents: quote.rentCents + quote.depositCents });
  }
  if (b.intentRef !== quote.intentRef) return refuse('intent_mismatch');

  const BW = quote.BW, businessId = quote.dest.businessId;
  const ref = BW.assertRef(`${ID_SUFFIX}_${bookingId}`);
  const bwRef = db.collection(BW.WALLETS).doc(businessId);
  const beRef = db.collection(BW.ENTRIES).doc(BW.entryDocId(businessId, ref));
  const depositRef  = db.collection('rentalDepositRefunds').doc(String(bookingId));
  const [bwSnap, beSnap, dep] = await Promise.all([txn.get(bwRef), txn.get(beRef), txn.get(depositRef)]);     /* READS — before any caller write */
  if (beSnap.exists || dep.exists) return { ok: false, reason: 'already_settled', apply: () => {} };
  const w = bwSnap.exists ? (bwSnap.data() || {}) : {};
  const plan = quote.netCents >= 1 ? BW.planMove(+1, { amountMinor: quote.netCents, recovery: true,
    balanceBeforeMinor: Number(w.balanceMinor || 0), recoveryDebtBeforeMinor: Number(w.recoveryDebtMinor || 0) }) : null;
  const bRef = db.collection('rentalBookings').doc(String(bookingId));
  const apply = (t) => {
    t.update(bRef, { paymentStatus: 'released', releasedAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(),
      settlement: { rentCents: quote.rentCents, commissionCents: quote.commissionCents, netCents: quote.netCents,
        creditedMinor: plan ? plan.amountMinor : 0, businessId, walletEntryRef: ref,
        depositCents: quote.depositCents, depositRefund: quote.depositCents > 0 ? 'requested' : 'none', commission: quote.commission, by: actorUid || null } });
    if (plan) {
      if (!bwSnap.exists) t.set(bwRef, { businessId, ownerId: quote.dest.ownerUid || null, storeId: quote.dest.storeId, currency: 'KES',
        balanceMinor: 0, recoveryDebtMinor: 0, createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() });
      t.create(beRef, { ref, businessId, storeId: quote.dest.storeId, direction: 'credit', amountMinor: plan.amountMinor,
        balanceBeforeMinor: plan.balanceBeforeMinor, balanceAfterMinor: plan.balanceAfterMinor, appliedToDebtMinor: plan.appliedToDebtMinor,
        shortfallMinor: plan.shortfallMinor, recoveryDebtBeforeMinor: plan.recoveryDebtBeforeMinor, recoveryDebtAfterMinor: plan.recoveryDebtAfterMinor,
        currency: 'KES', kind: 'rental_settlement', sourceUid: actorUid || null,
        source: { channel: 'ONLINE', businessId, method: null, grossMinor: quote.rentCents, commissionMinor: quote.commissionCents, bookingId },
        metadata: { bookingId, intentRef: quote.intentRef }, createdAt: FV.serverTimestamp() });
      t.set(bwRef, { balanceMinor: plan.balanceAfterMinor, recoveryDebtMinor: plan.recoveryDebtAfterMinor, updatedAt: FV.serverTimestamp() }, { merge: true });
    }
    if (quote.depositCents > 0) {
      t.create(depositRef, { bookingId, state: 'REQUESTED', rail: 'intasend_b2c_refund', amountCents: quote.depositCents, renterUid: b.buyerId || null,
        paymentRef: b.paymentRef || quote.paymentRef || null, intentRef: quote.intentRef, reason: 'rental_deposit_return', createdBy: actorUid || null,
        createdAt: FV.serverTimestamp() });
    }
  };
  const receipt = { kind: 'rental_settlement', bookingId, ownerUid, businessId, renterUid: b.buyerId || null, rentCents: quote.rentCents, commissionCents: quote.commissionCents,
    netCents: quote.netCents, depositCents: quote.depositCents };
  return { ok: true, apply, receipt };
}

module.exports = { quoteRentalSettlement, settleRentalBooking };
