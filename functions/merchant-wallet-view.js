/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — MERCHANT WALLET VIEW
   functions/merchant-wallet-view.js

   What a business earned, broken down by where it came from, plus the transactions behind
   it. Read-only: this module moves no money and cannot.

   ── WHY THIS IS NOT businessWalletSummary ─────────────────────────────────────
   That callable already owns the BALANCE figures — balance, reserved, available,
   withdrawable, outstanding commission — and it computes the commission reserve from the
   POS obligation ledger. Re-deriving any of those here would give a merchant two places to
   read the same number from, and the first time they disagreed the merchant would believe
   whichever one was larger.

   So the split is by ownership, not by convenience: the summary owns what the wallet HOLDS,
   and this owns where it CAME FROM. A surface renders both, and neither restates the other.

   ── EVERY FIGURE IS SUMMED FROM THE LEDGER THAT PRODUCED THE BALANCE ──────────
   Delivery earnings and sales proceeds are not separate pots and not separate wallets: they
   are the same entries, classified by the reason each was written with. A breakdown derived
   from anything else — an order query, a delivery count, a multiplier — would drift from the
   balance the moment one of them missed a record, and a merchant reconciling the two would
   find a gap nobody could explain.

   ── A FAILED READ IS ABSENT, NEVER ZERO ───────────────────────────────────────
   "You have earned nothing from deliveries" is a claim. A read that did not complete is not
   evidence for it, so an unavailable figure comes back null and the surface shows a neutral
   state rather than a confident zero.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');

const BW = require('./business-wallet');
const SD = require('./settlement-destination');

const REGION = 'us-central1';
const db = () => getFirestore();

/* How each ledger entry is attributed. The reason a movement was written with is the only
   thing that decides which stream it belongs to — never its size, and never the collection
   somebody guessed it came from. */
const STREAM = {
  RIDER_DELIVERY_EARNING: 'delivery',
  DELIVERY_EARNING: 'delivery',
  ORDER_SETTLEMENT: 'sales',
  POS_SALE: 'sales',
  TILL_SALE: 'sales',
  COMMISSION: 'commission',
  POS_COMMISSION: 'commission',
};

/** Anything not recognised is counted as OTHER rather than folded into a stream it may not
    belong to. A merchant reading a breakdown that silently absorbs unknown movements cannot
    tell a new revenue source from a bug. */
function streamOf(entry) {
  const r = String((entry && entry.reason) || '').toUpperCase();
  if (STREAM[r]) return STREAM[r];
  if (String((entry && entry.source) || '').toLowerCase() === 'delivery') return 'delivery';
  return 'other';
}

exports.merchantWalletView = onCall(
  { region: REGION, timeoutSeconds: 20, cors: true },
  async (request) => {
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError('unauthenticated', 'Sign in to continue.');
    }
    const uid = request.auth.uid;

    /* THE CALLER NEVER NAMES THE WALLET. The business is resolved from the authenticated
       identity through the same chain settlement uses, so "Merchant A cannot read Merchant
       B" is a property of the resolution rather than of a check somebody remembered. */
    const dest = await SD.resolveSettlementDestination(db(), { sellerUid: uid, paymentVerified: true });
    if (!dest.ok) {
      /* A NAMED ABSENCE, not an error. A rider or merchant still onboarding has no business
         account yet, and a card that says so is more useful than one showing a zero balance
         that is technically true and completely misleading. */
      return { ok: false, reason: dest.reason, remedy: dest.remedy || null };
    }

    const limit = Math.min(Math.max(Number(request.data && request.data.limit) || 50, 1), 200);

    let rows = null;
    try { rows = await BW.entries(dest.businessId, Math.max(limit, 200)); } catch (_) { rows = null; }
    if (rows === null) {
      return { ok: true, businessId: dest.businessId, currency: 'KES',
               breakdown: null, transactions: null,
               note: 'The ledger could not be read just now.' };
    }

    const totals = { delivery: 0, sales: 0, commission: 0, other: 0 };
    rows.forEach((e) => {
      const minor = Number(e.amountMinor || 0);
      if (!Number.isFinite(minor)) return;
      /* Credits add, debits subtract. A breakdown that ignored direction would report a
         commission sweep as income. */
      const signed = String(e.direction || 'credit') === 'debit' ? -minor : minor;
      totals[streamOf(e)] += signed;
    });

    return {
      ok: true,
      businessId: dest.businessId,
      storeId: dest.storeId || null,
      currency: 'KES',
      breakdown: {
        deliveryEarningsMinor: totals.delivery,
        salesProceedsMinor: totals.sales,
        commissionMinor: totals.commission,
        otherMinor: totals.other,
        /* How far back the breakdown looked. Stated, because a lifetime total and a
           last-200-movements total are different facts and a card that shows one while
           implying the other is lying quietly. */
        fromEntries: rows.length,
        truncated: rows.length >= 200,
      },
      transactions: rows.slice(0, limit).map((e) => ({
        id: e.id,
        at: e.createdAt || null,
        direction: e.direction || 'credit',
        amountMinor: Number(e.amountMinor || 0),
        balanceAfterMinor: e.balanceAfterMinor != null ? Number(e.balanceAfterMinor) : null,
        reason: e.reason || null,
        stream: streamOf(e),
        deliveryId: e.deliveryId || null,
        orderId: e.orderId || null,
        /* Deliberately NOT the beneficiary uid or any counterparty identity: a transaction
           list is a record of money, and a merchant does not need a rider's account id to
           reconcile their own ledger. */
      })),
    };
  }
);

module.exports.streamOf = streamOf;
module.exports.STREAM = STREAM;
