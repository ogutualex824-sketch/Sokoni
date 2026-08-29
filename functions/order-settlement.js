'use strict';
/* ============================================================================
   SOKONI — Product order settlement  functions/order-settlement.js
   Product Settlement Convergence (mirrors the provider-booking held-model).

   THE GAP THIS CLOSES: a checkout product order is created `paid` with
   `escrow.held = full, released:0`, but NO fulfillment event ever released funds
   to the seller — the canonical settlement engine was dormant. This wires it in.

   Single financial authority (NO second settlement/commission/wallet system):
     • commission + breakdown  → settlement-engine.computeSettlement (calculateCommission)
     • withdrawable credit      → wallets/{uid}.balance SHILLINGS (the one canonical rail;
                                  the cents availableBalance rail was retired — commission.js:608)
     • audit                    → settlements/{orderId} + walletTransactions + balanced ledger,
                                  all correlated by orderId. Exactly-once.

   SETTLEMENT STATE MACHINE on the order (`settlementStatus`):
     UNSETTLED → HELD → ELIGIBLE_FOR_SETTLEMENT → SETTLING → SETTLED
     (REFUNDED instead of SETTLED if a refund lands before settlement)
   ========================================================================== */
const admin = require('firebase-admin');
const SE = require('./settlement-engine');

const STATES = { UNSETTLED: 'UNSETTLED', HELD: 'HELD', ELIGIBLE: 'ELIGIBLE_FOR_SETTLEMENT', SETTLING: 'SETTLING', SETTLED: 'SETTLED', REFUNDED: 'REFUNDED', REVERSED: 'REVERSED' };
const DEFAULT_AUTOCONFIRM_DAYS = 3;

/* Auto-confirm window is CONFIG, not a constant (D2): _systemConfig/settlement.autoConfirmDays. */
async function _autoConfirmDays(db) {
  try {
    const c = await db.collection('_systemConfig').doc('settlement').get();
    const d = c.exists ? Number(c.data().autoConfirmDays) : NaN;
    return Number.isFinite(d) && d >= 0 ? d : DEFAULT_AUTOCONFIRM_DAYS;
  } catch (_) { return DEFAULT_AUTOCONFIRM_DAYS; }
}

/* Seller product gross = order total MINUS delivery fee (delivery is split separately in
   onOrderStatusChange → deliveryFees). Cents, server-authoritative from the order snapshot. */
function _grossCents(order) {
  const total = Number(order.orderTotal != null ? order.orderTotal : order.total) || 0;
  const delivery = Number(order.deliveryFee || 0);
  return Math.max(0, Math.round((total - delivery) * 100));
}

/* The PLATFORM-funded slice of an order's discount, in cents.

   Funding model:
     loyalty redemption  ALWAYS platform-funded — SOKONI issued the points, so
                         redeeming them must not reduce what the merchant earns.
     promo code          the promo record's own `fundedBy`, captured onto the order
                         at checkout from validatePromoCode.

   Anything unrecognised is treated as platform-funded, never seller-funded: a
   missing or malformed funder must not quietly move money off a merchant.

   Orders placed before this shipped carry no discount block and yield 0, which is
   exactly right — they settle as they always did. */
function _platformFundedDiscountCents(order) {
  const d = order && order.discount;
  if (!d || typeof d !== 'object') return 0;
  const loyalty = Math.max(0, Math.round(Number(d.loyaltyCents) || 0));
  const promo   = Math.max(0, Math.round(Number(d.promoCents) || 0));
  const promoIsSellerFunded = d.promoFundedBy === 'seller';
  return loyalty + (promoIsSellerFunded ? 0 : promo);
}

/* Settle ONE fulfilled product order exactly once. Reuses the canonical engine for the
   breakdown, credits the seller's withdrawable wallet, writes settlement + wallet txn +
   balanced ledger, and advances the state machine. Idempotent + replay-safe. */
async function settleOrder(db, adminSdk, orderId) {
  const FV = adminSdk.firestore.FieldValue;
  const orderRef = db.collection('orders').doc(orderId);
  const preSnap = await orderRef.get();
  if (!preSnap.exists) return { outcome: 'no-order' };
  const order = preSnap.data();

  const sellerId = order.sellerUid || order.sellerId || null;
  const grossCents = _grossCents(order);
  /* Compute OUTSIDE the txn (reads commission rules from Firestore); the txn re-guards state. */
  let breakdown = null;
  if (sellerId && grossCents > 0) {
    /* Discount funding. `grossCents` is the cash collected, i.e. AFTER the discount,
       so without these the seller absorbed every discount — including loyalty points
       SOKONI itself issued. Only the PLATFORM-funded portion is passed: a
       seller-funded discount is already reflected in the reduced gross and needs no
       adjustment. Absent on orders placed before this shipped, which is correct —
       the fix is forward-only and settled orders are never recalculated. */
    breakdown = await SE.computeSettlement(db, {
      grossCents, category: 'marketplace', sellerId, hubId: 'marketplace',
      discountCents:    _platformFundedDiscountCents(order),
      discountFundedBy: 'platform',
    });
  }

  const settleRef = db.collection('settlements').doc(orderId);   /* deterministic → exactly-once */

  const res = await db.runTransaction(async (t) => {
    const s = await t.get(orderRef);
    if (!s.exists) return { outcome: 'no-order' };
    const o = s.data();
    /* ── TERMINAL STATES, IN EITHER VOCABULARY ────────────────────────────────
       TWO writers, two spellings. order-settlement writes 'SETTLED';
       index.js:8173 and settlement-executor.js:114 write 'settled'. And
       index.js:4000 states the intent outright — "passes
       settlementStatus:'settled' so no settlement sweep double-credits" — but
       this guard compared against the UPPERCASE constant, so it never recognised
       that marker. An order another path had already paid out could therefore be
       settled a SECOND time. The protection index.js believed it was applying
       did not exist.

       Found by auditing production: order SKN084IE2Z carries
       settlementStatus:'settled' with no settlements/ record and no settledAt.

       Normalised rather than renamed: rewriting the other writers' vocabulary
       would be a migration across live money paths, while accepting both costs
       nothing and closes the hole today. */
    const st = String(o.settlementStatus || '').toUpperCase();
    if (st === STATES.SETTLED)  return { outcome: 'already-settled' };   /* replay no-op */
    if (st === STATES.REFUNDED) return { outcome: 'refunded-skip' };     /* refunded before settlement */
    /* Only a held/eligible, non-cancelled/refunded order settles. */
    if (['cancelled', 'refunded'].includes(o.status)) return { outcome: 'terminal-skip' };
    /* ══ PROOF OF DELIVERY GATE ═══════════════════════════════════════════════
       Money is released on PROOF, never on a status field.

       Before this, settlement fired when an order reached `completed`, which is
       reached from `delivered` — and `delivered` is a FIELD. Any path that set
       it (a stale client write, an operational correction, the auto-confirm
       sweep after the window) released real funds with nothing attesting that
       anything was handed to a customer.

       The proof already existed and was simply not consulted:
       delivery-complete.js verifies the buyer's PIN against a keyed HMAC —
       checking the assigned rider BEFORE the PIN so the endpoint cannot be used
       as an oracle, limiting attempts, failing closed on a missing key — and
       stamps `deliveryAuthorizedBy` on the order. delivery-pin.js says in its
       own header that it "DOES NOT gate delivery completion or any payout".
       This is the wire that was missing.

       TWO ATTESTATIONS COUNT, because they are the same event differently
       witnessed: the rider entering the buyer's PIN, and the buyer confirming
       receipt themselves.

       AN ORDER WITH NO DELIVERY IS NOT BLOCKED. A pickup order, a till sale or
       an order predating the PIN system has no delivery to prove and never
       will; stranding those would be a worse defect than the one being fixed.
       They settle, and the settlement RECORDS that it carried no delivery
       proof, so the exposure is measurable rather than assumed.

       THE HOLD IS NOT TERMINAL. It sets HELD, not SETTLED, so the same order
       settles normally the moment proof arrives — a late PIN, a buyer
       confirming the next morning. A permanent block would strand real money. */
    const _isDelivery = !!(o.assignedDriverUid || o.riderId || o.assignedRiderId ||
      o.deliveryStatus ||
      /^delivery$/i.test(String(o.fulfilmentType || o.fulfillmentType || '')));
    const _proof = o.deliveryAuthorizedBy || null;
    if (_isDelivery && !_proof) {
      t.update(orderRef, {
        settlementStatus: STATES.HELD,
        settlementNote: 'awaiting_delivery_proof',
        settlementHeldReason:
          'This order is marked delivered but no delivery PIN was verified and the buyer has ' +
          'not confirmed receipt, so no money has been released. It settles automatically once ' +
          'either happens.',
        settlementHeldAt: FV.serverTimestamp(),
        updatedAt: FV.serverTimestamp(),
      });
      return { outcome: 'awaiting-delivery-proof', orderId };
    }
    const _deliveryProof = _isDelivery ? String(_proof) : 'not_required';

    if (!sellerId) { t.update(orderRef, { settlementStatus: STATES.SETTLED, settlementNote: 'no-seller', settledAt: FV.serverTimestamp() }); return { outcome: 'no-seller' }; }
    if (!breakdown || grossCents <= 0) { t.update(orderRef, { settlementStatus: STATES.SETTLED, settlementNote: 'zero-gross', settledAt: FV.serverTimestamp() }); return { outcome: 'zero-gross' }; }

    const netCents = Number(breakdown.sellerNetCents) || 0;
    /* engine returns commission nested: { commission: { cents, rate } }. */
    const commissionCents = Number(breakdown.commission && breakdown.commission.cents) || 0;
    const netShillings = Math.floor(netCents / 100);

    /* 1 — credit the ONE canonical withdrawable wallet (shillings). set-merge auto-creates.
       AUTO-RECOVERY (ratified policy): pay down any outstanding refundRecoveryDebt FIRST; only the
       remainder becomes withdrawable balance. (wallet read is before any write in this txn.) */
    let appliedToDebt = 0, withdrawable = netShillings;
    if (netShillings >= 1) {
      const wRef = db.collection('wallets').doc(sellerId);
      const wSnap = await t.get(wRef);
      const debt = wSnap.exists ? Math.max(0, Number(wSnap.data().refundRecoveryDebt) || 0) : 0;
      appliedToDebt = Math.min(debt, netShillings);
      withdrawable = netShillings - appliedToDebt;
      t.set(wRef, {
        balance: FV.increment(withdrawable),
        refundRecoveryDebt: FV.increment(-appliedToDebt),
        updatedAt: FV.serverTimestamp(),
      }, { merge: true });
      /* 2 — wallet transaction (deterministic id → no double-credit). */
      t.set(db.collection('walletTransactions').doc(`${sellerId}_${orderId}_ordersettle`), {
        uid: sellerId, type: 'order_settlement', amount: withdrawable, appliedToDebt, grossCredit: netShillings,
        currency: 'KES', orderId, sourceType: 'order', sourceId: orderId,
        grossCents, commissionCents, netCents, createdAt: FV.serverTimestamp(),
      });
    }
    /* 3 — settlement record (canonical, deterministic). */
    t.set(settleRef, {
      orderId, sellerId, grossCents, commissionCents, sellerNetCents: netCents,
      netShillingsCredited: netShillings, category: 'marketplace',
      ledgerPlan: breakdown.ledgerPlan || [],   /* immutable snapshot → post-settlement reversal swaps it */
      /* WHAT AUTHORISED THIS RELEASE: 'rider_pin', 'buyer_confirmation', or
         'not_required' for an order with no delivery. Recorded on the settlement
         itself so an audit can answer "why was this paid out" from one document,
         and so the volume settling without proof is a number rather than a
         guess. */
      deliveryProof: _deliveryProof,
      engineVersion: 'settlement-engine', status: 'settled', createdAt: FV.serverTimestamp(),
    });
    /* 4 — balanced double-entry ledger (from the engine's ledgerPlan), orderId-correlated. */
    (breakdown.ledgerPlan || []).forEach((e, i) => {
      t.set(db.collection('ledger').doc(`${orderId}_${e.type || i}`), {
        orderId, entryType: e.type, debitAccount: e.debitAccount, creditAccount: e.creditAccount,
        amountCents: e.amountCents, sourceType: 'order', sourceId: orderId, createdAt: FV.serverTimestamp(),
      });
    });
    /* 5 — advance the state machine + release the held escrow. */
    t.update(orderRef, {
      settlementStatus: STATES.SETTLED,
      escrow: Object.assign({}, o.escrow || {}, { released: netCents, settledAt: Date.now() }),
      settledAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(),
    });
    return { outcome: 'settled', sellerId, netShillings, commissionCents };
  });

  if (res.outcome === 'settled') {
    console.log(`[order-settlement] SETTLED ${orderId} → seller ${res.sellerId} +${res.netShillings} KES (commission ${res.commissionCents}c)`);
  }
  return res;
}

/* Mark an order eligible (customer confirmed / window elapsed) — a state-machine helper.
   The actual credit runs in settleOrder; kept separate so the trigger stays thin. */
async function markEligible(db, adminSdk, orderId) {
  const FV = adminSdk.firestore.FieldValue;
  await db.collection('orders').doc(orderId).set(
    { settlementStatus: STATES.ELIGIBLE, updatedAt: FV.serverTimestamp() }, { merge: true }
  ).catch(() => {});
}

/* Refund guard (D + state machine): a refund landing BEFORE settlement marks the order
   REFUNDED so settleOrder becomes a no-op. Returns false if already settled (caller must
   handle a post-settlement reversal separately). */
async function markRefundedIfUnsettled(db, adminSdk, orderId) {
  const FV = adminSdk.firestore.FieldValue;
  const ref = db.collection('orders').doc(orderId);
  return db.runTransaction(async (t) => {
    const s = await t.get(ref);
    if (!s.exists) return { outcome: 'no-order' };
    if (s.data().settlementStatus === STATES.SETTLED) return { outcome: 'already-settled' };   /* needs reversal, not this */
    t.update(ref, { settlementStatus: STATES.REFUNDED, updatedAt: FV.serverTimestamp() });
    return { outcome: 'marked-refunded' };
  });
}

/* Reverse an ALREADY-SETTLED order when a refund lands after settlement (post-settlement
   reversal). Debits the seller's wallet by the net that was credited, posts a reversing
   double-entry (original ledgerPlan with debit/credit SWAPPED so the ledger nets to zero),
   flips the state SETTLED → REVERSED. Exactly-once (deterministic reversal ids + state guard).

   Negative-balance policy: the debit MAY take wallets.balance negative if the seller already
   withdrew — that negative is a recoverable debt that self-corrects against future earnings, and
   the withdrawal flow already blocks a payout while balance < amount. When it goes negative we
   ALSO stamp a `settlementReversalShortfall` marker so ops can see the un-recovered amount.
   Full reversal only (partial-refund-after-settlement is a documented follow-up). */
async function reverseSettledOrder(db, adminSdk, orderId, opts = {}) {
  const FV = adminSdk.firestore.FieldValue;
  const orderRef = db.collection('orders').doc(orderId);
  const settleRef = db.collection('settlements').doc(orderId);

  return db.runTransaction(async (t) => {
    const oSnap = await t.get(orderRef);
    if (!oSnap.exists) return { outcome: 'no-order' };
    const o = oSnap.data();
    if (o.settlementStatus === STATES.REVERSED) return { outcome: 'already-reversed' };   /* replay no-op */
    if (o.settlementStatus !== STATES.SETTLED) return { outcome: 'not-settled' };          /* caller uses markRefundedIfUnsettled */

    const sSnap = await t.get(settleRef);
    const s = sSnap.exists ? sSnap.data() : {};
    const netShillings = Number(s.netShillingsCredited) || 0;
    const netCents = Number(s.sellerNetCents) || 0;
    const sellerId = o.sellerUid || o.sellerId || s.sellerId || null;

    let shortfall = 0, recoveredFromBalance = 0;
    if (sellerId && netShillings > 0) {
      const wRef = db.collection('wallets').doc(sellerId);
      const wSnap = await t.get(wRef);
      const bal = wSnap.exists ? (Number(wSnap.data().balance) || 0) : 0;
      /* EXPLICIT DEBT (ratified policy): balance is floored at 0 — never a raw negative. Whatever
         the seller already withdrew becomes `refundRecoveryDebt`, recovered from future settlements. */
      recoveredFromBalance = Math.min(bal, netShillings);
      shortfall = netShillings - recoveredFromBalance;
      t.set(wRef, {
        balance: FV.increment(-recoveredFromBalance),                 /* floored at 0 */
        refundRecoveryDebt: FV.increment(shortfall),                  /* explicit recoverable debt */
        updatedAt: FV.serverTimestamp(),
      }, { merge: true });
      /* reversing wallet transaction (deterministic id). */
      t.set(db.collection('walletTransactions').doc(`${sellerId}_${orderId}_ordersettle_reversal`), {
        uid: sellerId, type: 'order_settlement_reversal', amount: -netShillings,
        recoveredFromBalance, debtAdded: shortfall, currency: 'KES',
        orderId, sourceType: 'order', sourceId: orderId, reason: opts.reason || 'post-settlement-refund',
        createdAt: FV.serverTimestamp(),
      });
    }
    /* Immutable Settlement → Reversal → Refund link (audit/support). */
    t.set(db.collection('settlementReversals').doc(orderId), {
      orderId, settlementId: orderId, refundId: opts.refundRef || null, reversalId: `${orderId}_reversal`,
      sellerId, netReversedShillings: netShillings, recoveredFromBalance, debtAdded: shortfall,
      reason: opts.reason || 'post-settlement-refund',
      recoveryStatus: shortfall > 0 ? 'recovering' : 'complete', createdAt: FV.serverTimestamp(),
    });
    /* reverse the balanced ledger: swap debit/credit of each original plan entry → nets to zero. */
    (Array.isArray(s.ledgerPlan) ? s.ledgerPlan : []).forEach((e, i) => {
      t.set(db.collection('ledger').doc(`${orderId}_${e.type || i}_reversal`), {
        orderId, entryType: (e.type || String(i)) + '_reversal', reversalOf: e.type || String(i),
        debitAccount: e.creditAccount, creditAccount: e.debitAccount,   /* SWAPPED */
        amountCents: e.amountCents, sourceType: 'order', sourceId: orderId, createdAt: FV.serverTimestamp(),
      });
    });
    /* settlement record + order state. */
    t.set(settleRef, { status: 'reversed', reversedAt: FV.serverTimestamp(), reversalReason: opts.reason || 'post-settlement-refund' }, { merge: true });
    t.update(orderRef, {
      settlementStatus: STATES.REVERSED,
      escrow: Object.assign({}, o.escrow || {}, { refunded: netCents, reversedAt: Date.now() }),
      settlementReversalShortfall: shortfall,    /* 0 unless the seller already withdrew */
      reversedAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(),
    });
    return { outcome: 'reversed', sellerId, netShillings, shortfall };
  });
}

/* Route a refund to the correct settlement-state action: reverse if already settled, else mark
   REFUNDED (blocking settlement). One entry point so initiateRefund never has to branch. */
async function handleOrderRefund(db, adminSdk, orderId, opts = {}) {
  const snap = await db.collection('orders').doc(orderId).get().catch(() => null);
  if (!snap || !snap.exists) return { outcome: 'no-order' };
  if (snap.data().settlementStatus === STATES.SETTLED) return reverseSettledOrder(db, adminSdk, orderId, opts);
  return markRefundedIfUnsettled(db, adminSdk, orderId);
}

/* Auto-confirm sweep: delivered orders past the config window with no open dispute become
   `completed` — which fires onOrderStatusChange → settleOrder. One settlement path.
   A PLAIN function invoked from an EXISTING scheduler (no new Cloud Run). */
async function autoConfirmDeliveredOrders(db, adminSdk) {
  const FV = adminSdk.firestore.FieldValue;
  const days = await _autoConfirmDays(db);
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const snap = await db.collection('orders')
    .where('status', '==', 'delivered').limit(200).get().catch(() => null);
  if (!snap || snap.empty) return 0;
  let confirmed = 0;
  for (const doc of snap.docs) {
    const o = doc.data();
    if (o.settlementStatus === STATES.SETTLED || o.settlementStatus === STATES.REFUNDED) continue;
    if (o.disputeOpen === true || o.hasDispute === true) continue;   /* dispute pauses auto-confirm */
    const deliveredMs = o.deliveredAt && o.deliveredAt.toMillis ? o.deliveredAt.toMillis()
      : (typeof o.deliveredAt === 'number' ? o.deliveredAt : 0);
    if (!deliveredMs || deliveredMs > cutoff) continue;              /* still inside the window */
    try {
      await doc.ref.update({ status: 'completed', autoConfirmed: true, autoConfirmedAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() });
      confirmed++;
    } catch (e) { console.error('[order-settlement] auto-confirm failed', doc.id, e.message); }
  }
  if (confirmed) console.log(`[order-settlement] auto-confirmed ${confirmed} delivered order(s) past ${days}d`);
  return confirmed;
}

module.exports = { STATES, settleOrder, markEligible, markRefundedIfUnsettled, reverseSettledOrder, handleOrderRefund, autoConfirmDeliveredOrders, _grossCents,
  /* Exposed so the funding resolver can be tested directly — it decides real money,
     and inferring it from a full settlement run would prove less. */
  _internal: { _platformFundedDiscountCents } };
