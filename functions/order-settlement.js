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
/* WHERE a settlement may go, and whether it may go at all. Never inferred here. */
const SD = require('./settlement-destination');
/* The business wallet's own arithmetic and document ids — used so this file moves that
   wallet inside its transaction WITHOUT keeping a second copy of how a balance is computed. */
const BW = require('./business-wallet');

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

/* ── THE DELIVERY PROOF GATE ────────────────────────────────────────────────────────────
   Money does not move on an unproven delivery.

   The buyer's PIN is issued WITH the order and entered at the door; delivery-complete.js
   records the result as `deliveryAuthorizedBy` — `rider_pin` when the rider submitted the
   buyer's PIN, `buyer_confirmation` when the buyer confirmed directly. One event, two
   witnesses. Without one of them the delivery is a claim, not a fact, and settling on a
   claim pays the seller for goods nobody can show were handed over.

   THE HOLD IS NOT TERMINAL. An unproven delivery order goes to HELD with
   `settlementNote: 'awaiting_delivery_proof'` and settles the moment proof arrives — the
   sweep and the status trigger both re-enter here. A permanent refusal would strand real
   money belonging to a seller who did nothing wrong.

   NON-DELIVERY ORDERS STILL SETTLE, recording `deliveryProof: 'not_required'` rather than
   being silently exempt — so "how much settled without proof, and why" is a query an
   auditor can run instead of an assumption they have to accept. */
const PROOF_METHODS = ['rider_pin', 'buyer_confirmation'];

/* Deliberately INCLUSIVE: anything carrying a rider, a delivery reference, a fee or an
   address is a delivery. Guessing "not a delivery" is the failure that releases money
   early, so the ambiguous case resolves towards requiring proof. */
function _isDeliveryOrder(o) {
  if (!o) return false;
  if (o.fulfilmentType === 'pickup' || o.fulfillmentType === 'pickup') return false;
  return !!(o.assignedDriverUid || o.riderId || o.assignedRiderId || o.deliveryRef ||
            Number(o.deliveryFee || 0) > 0 || o.deliveryAddress);
}

/* Only the two witnessed methods count — a truthy string of any other shape is not a proof,
   and accepting one would let a future writer invent an authority. */
function _deliveryProofOf(o) {
  const m = o && o.deliveryAuthorizedBy;
  return (typeof m === 'string' && PROOF_METHODS.indexOf(m) !== -1) ? m : null;
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

  /* ── WHERE THIS SETTLES, DECIDED BEFORE ANY MONEY MOVES ─────────────────────────────────
     Resolved outside the transaction because it reads the business and store records. The
     two facts that can change underneath it — the order's payment proof and its settlement
     state — are BOTH re-checked against the in-transaction snapshot below, so a stale read
     here cannot authorise a credit.

     `dest` is consulted, never trusted from the order: see settlement-destination.js. */
  const dest = sellerId ? await SD.resolveSettlementDestination(db, order) : { ok: false, reason: SD.REASON.NO_SELLER };

  const res = await db.runTransaction(async (t) => {
    const s = await t.get(orderRef);
    if (!s.exists) return { outcome: 'no-order' };
    const o = s.data();
    const st = o.settlementStatus;
    if (st === STATES.SETTLED)  return { outcome: 'already-settled' };   /* replay no-op */
    if (st === STATES.REFUNDED) return { outcome: 'refunded-skip' };     /* refunded before settlement */
    /* Only a held/eligible, non-cancelled/refunded order settles. */
    if (['cancelled', 'refunded'].includes(o.status)) return { outcome: 'terminal-skip' };
    if (!sellerId) { t.update(orderRef, { settlementStatus: STATES.SETTLED, settlementNote: 'no-seller', settledAt: FV.serverTimestamp() }); return { outcome: 'no-seller' }; }

    /* Read the IN-TRANSACTION snapshot, not the pre-read above: proof can arrive between
       the two, and a gate reading a stale snapshot would hold an order that is already
       proven. HELD is a wait, not a refusal — the next pass settles it. */
    const isDelivery = _isDeliveryOrder(o);
    const proof = _deliveryProofOf(o);
    if (isDelivery && !proof) {
      t.update(orderRef, {
        settlementStatus: STATES.HELD,
        settlementNote: 'awaiting_delivery_proof',
        updatedAt: FV.serverTimestamp(),
      });
      return { outcome: 'awaiting-delivery-proof', sellerId, grossCents };
    }
    if (!breakdown || grossCents <= 0) { t.update(orderRef, { settlementStatus: STATES.SETTLED, settlementNote: 'zero-gross', settledAt: FV.serverTimestamp() }); return { outcome: 'zero-gross' }; }

    /* ── FAIL CLOSED ON THE DESTINATION ──────────────────────────────────────────────────
       Two questions, both answered before a cent moves: did SOKONI actually COLLECT this
       money, and which business wallet does it belong to?

       `sokoniCollected` is re-evaluated on the IN-TRANSACTION snapshot, not on the pre-read
       used above — the same reason the delivery-proof gate re-reads. It is the check that
       was missing entirely: the state machine proved an order had progressed, never that it
       had been paid. A seller may move their own order to `completed` under the Firestore
       rules, which fires this settlement; without this gate that alone credited a wallet.

       HELD, NOT FAILED, NOT SETTLED. The order keeps its money claim and stays visible for
       reconciliation with a reason and a remedy. Marking it SETTLED would discharge a debt
       nobody paid; marking it failed would lose the buyer's payment. */
    if (!SD.sokoniCollected(o) || !dest.ok) {
      const reason = !SD.sokoniCollected(o) ? SD.REASON.NOT_COLLECTED : dest.reason;
      t.update(orderRef, {
        settlementStatus: STATES.HELD,
        settlementNote: 'destination_unresolved',
        settlementHoldReason: reason,
        updatedAt: FV.serverTimestamp(),
      });
      /* Deterministic id → one hold record per order, updated in place as attempts repeat. */
      t.set(db.collection('settlementHolds').doc(orderId), {
        orderId, sellerId,
        reason,
        remedy: SD.REMEDY[reason] || null,
        detail: dest.detail === undefined ? null : dest.detail,
        grossCents,
        paymentVerified: o.paymentVerified === true,
        status: 'held',
        lastAttemptAt: FV.serverTimestamp(),
      }, { merge: true });
      return { outcome: 'destination-unresolved', reason, sellerId, grossCents };
    }

    const netCents = Number(breakdown.sellerNetCents) || 0;
    /* engine returns commission nested: { commission: { cents, rate } }. */
    const commissionCents = Number(breakdown.commission && breakdown.commission.cents) || 0;
    const netShillings = Math.floor(netCents / 100);

    /* 1 — credit the BUSINESS wallet, in CENTS, in this same transaction.
       ────────────────────────────────────────────────────────────────────────────────────
       WHICH WALLET, AND WHY IT CHANGED
       This used to credit `wallets/{sellerId}` — the seller's PERSONAL wallet, the account
       that funds their top-ups and personal spending. Shop takings are not personal money:
       they carry the marketplace commission, refunds owed to customers, and a reconciliation
       the merchant can be asked to produce. Once blended into a personal balance, "what does
       this shop owe?" has no answer, because the number has already been mixed with money
       that was never the shop's.

       `businessWallets/{businessId}` is where the POS/Till lane has always settled
       (pos-zero-friction.js). One business earning through two channels must not have two
       different answers to how much it has earned.

       THE UNIT CHANGED TOO, AND THAT FIXES A LEAK
       The personal wallet holds whole KES, so this credited `Math.floor(netCents / 100)` and
       silently dropped up to 99 cents on EVERY order — money that left the buyer, was
       recorded in the ledger as `sellerNetCents`, and was then credited to nobody. The
       business wallet is integer cents, so the credit is now exactly `netCents` and
       gross = commission + merchantNet holds to the cent.

       IN THIS TRANSACTION, DELIBERATELY
       The wallet moves in the same atomic step that marks the order settled. A credit that
       could fail on its own would leave an order recorded as settled with the merchant
       unpaid — and `settlementStatus` would say the debt was discharged. The arithmetic is
       business-wallet.js's own `planMove`, not a second copy of it, and the ledger entry is
       written at the same deterministic id `_move` uses, so replay is idempotent across both
       entry points rather than only within one. */
    let appliedToDebtMinor = 0, creditedMinor = 0, walletBalanceMinor = null;
    if (netCents >= 1) {
      const bwRef = db.collection(BW.WALLETS).doc(String(dest.businessId));
      const beRef = db.collection(BW.ENTRIES)
        .doc(BW.entryDocId(dest.businessId, BW.assertRef(`ordersettle_${orderId}`)));
      const [bwSnap, beSnap] = await Promise.all([t.get(bwRef), t.get(beRef)]);

      if (beSnap.exists) {
        /* Already credited by an earlier attempt. The settlement record below is written at a
           deterministic id too, so this branch only runs on a partial replay; it must change
           no balance. */
        creditedMinor = Number((beSnap.data() || {}).amountMinor || 0);
        walletBalanceMinor = Number((bwSnap.exists ? bwSnap.data().balanceMinor : 0) || 0);
      } else {
        const before = Number((bwSnap.exists ? bwSnap.data().balanceMinor : 0) || 0);
        const debtBefore = Number((bwSnap.exists ? bwSnap.data().recoveryDebtMinor : 0) || 0);
        /* AUTO-RECOVERY (ratified policy, unchanged in substance): an outstanding reversal
           debt is paid down FIRST; only the remainder becomes spendable balance. */
        const plan = BW.planMove(+1, {
          amountMinor: netCents, recovery: true,
          balanceBeforeMinor: before, recoveryDebtBeforeMinor: debtBefore,
        });
        appliedToDebtMinor = plan.appliedToDebtMinor;
        /* FROM THE PLAN, never assigned alongside it. `creditedMinor` is what the settlement
           RECORD says was paid; taking it from a second expression let the record and the
           balance disagree — a sabotage that floored the credit to whole shillings changed the
           record and left the money right, which no assertion could see. One value, one
           source. */
        creditedMinor = plan.amountMinor;
        walletBalanceMinor = plan.balanceAfterMinor;

        if (!bwSnap.exists) {
          t.set(bwRef, {
            businessId: dest.businessId, ownerId: dest.ownerUid || null,
            storeId: dest.storeId || null, currency: 'KES',
            balanceMinor: 0, recoveryDebtMinor: 0,
            createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(),
          });
        }
        t.set(beRef, {
          ref: `ordersettle_${orderId}`,
          businessId: dest.businessId,
          storeId: dest.storeId || null,
          direction: 'credit',
          amountMinor: netCents,
          balanceBeforeMinor: plan.balanceBeforeMinor,
          balanceAfterMinor: plan.balanceAfterMinor,
          appliedToDebtMinor: plan.appliedToDebtMinor,
          shortfallMinor: plan.shortfallMinor,
          recoveryDebtBeforeMinor: plan.recoveryDebtBeforeMinor,
          recoveryDebtAfterMinor: plan.recoveryDebtAfterMinor,
          currency: 'KES',
          kind: 'marketplace_settlement',
          sourceUid: null,
          /* WHERE IT CAME FROM AND WHAT IT WAS WORTH — the ONLINE stream of the one wallet
             ledger. Gross and commission are stored beside the net that moved, so "online
             commission this month" is a read of this ledger rather than a join back to
             orders, which would be a second source of truth to disagree with. */
          source: {
            channel: 'ONLINE',
            businessId: dest.businessId,
            shopId: dest.storeId || null,
            orderId: orderId,
            paymentRef: o.paymentRef || o.mpesaCode || null,
            grossMinor: grossCents,
            commissionMinor: commissionCents,
            netMinor: netCents,
            currency: 'KES',
          },
          metadata: { orderId, grossCents, commissionCents },
          createdAt: FV.serverTimestamp(),
        });
        t.update(bwRef, {
          balanceMinor: plan.balanceAfterMinor,
          recoveryDebtMinor: plan.recoveryDebtAfterMinor,
          updatedAt: FV.serverTimestamp(),
        });
      }
    }
    /* 3 — settlement record (canonical, deterministic). */
    t.set(settleRef, {
      orderId, sellerId, grossCents, commissionCents, sellerNetCents: netCents,
      netShillingsCredited: netShillings, category: 'marketplace',

      /* ── WHERE THE MONEY WENT, RECORDED ON THE SETTLEMENT ITSELF ──────────────────────
         A reversal must debit the wallet this settlement actually credited, and it must
         learn that from the RECORD rather than by re-deriving it. Re-deriving would ask
         today's chain about yesterday's payment: a merchant who has since been re-provisioned
         onto a different business id would have the reversal taken from a wallet that never
         received the money, while the one that did keeps it.

         `settlementDestination` is therefore the authority for reverseSettledOrder(). */
      settlementDestination: 'business_wallet',
      businessId: dest.businessId,
      storeId: dest.storeId || null,
      ownerUid: dest.ownerUid || null,
      legacyStore: !!dest.legacyStore,
      creditedMinor,
      appliedToDebtMinor,
      walletBalanceMinorAfter: walletBalanceMinor,

      /* ── WHAT PRICED IT ──────────────────────────────────────────────────────────────
         The plan, the rate and the authority that set it, kept with the settlement so the
         split can be explained years later without re-deriving it from a catalogue that has
         since moved. Nulls are honest: they say the engine did not report a plan, which is
         different from saying the seller had none. */
      commissionRate: (breakdown.commission && breakdown.commission.rate) ?? null,
      commissionPlanId: (breakdown.commission && breakdown.commission.planId) ?? null,
      commissionLane: (breakdown.commission && breakdown.commission.lane) ?? null,
      pricingSource: (breakdown.commission && breakdown.commission.pricingSource) ?? null,
      commissionRuleId: (breakdown.commission && breakdown.commission.ruleId) ?? null,
      /* WHAT AUTHORISED THIS RELEASE. 'not_required' is recorded rather than omitted so an
         auditor can query how much settled without delivery proof, and why. */
      deliveryProof: isDelivery ? proof : 'not_required',
      deliveryProvenAt: isDelivery ? (o.deliveredAt || null) : null,
      ledgerPlan: breakdown.ledgerPlan || [],   /* immutable snapshot → post-settlement reversal swaps it */
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
    return { outcome: 'settled', sellerId, netShillings, commissionCents,
             /* The lane and the exact cents, so a caller never has to infer either. */
             destination: 'business_wallet', businessId: dest.businessId,
             storeId: dest.storeId || null,
             creditedMinor, appliedToDebtMinor, netCents };
  });

  if (res.outcome === 'settled') {
    console.log(`[order-settlement] SETTLED ${orderId} → business ${res.businessId} `
      + `+${res.creditedMinor}c (commission ${res.commissionCents}c`
      + (res.appliedToDebtMinor ? `, ${res.appliedToDebtMinor}c cleared prior reversal debt` : '')
      + ')');
  } else if (res.outcome === 'destination-unresolved') {
    /* Loud, and NAMED. A held settlement is money SOKONI is holding for a merchant who is
       not being paid; it must never be a quiet no-op in the logs. */
    console.error(`[order-settlement] HELD ${orderId} — ${res.reason} `
      + `(seller ${res.sellerId}, ${res.grossCents}c) — see settlementHolds/${orderId}`);
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

    /* ── THE REVERSAL FOLLOWS THE RECORDED LANE ──────────────────────────────────────────
       `settlementDestination` is read from the SETTLEMENT, never re-derived from the seller.
       Re-deriving would ask today's identity chain about yesterday's payment: a merchant
       re-provisioned onto a different business id since the sale would have the money taken
       from a wallet that never received it, while the wallet that did keeps it.

       Settlements written before this change carry no `settlementDestination`. They credited
       the personal wallet, so they are reversed there — the legacy branch below is not a
       fallback for an unresolved case, it is the correct treatment for a payment that
       genuinely went to that account. Absent is read as 'personal_wallet' deliberately, and
       ONLY here, where the historical fact is unambiguous. */
    const lane = s.settlementDestination === 'business_wallet' ? 'business_wallet' : 'personal_wallet';

    let shortfall = 0, recoveredFromBalance = 0;
    let reversedMinor = 0, shortfallMinor = 0, recoveredMinor = 0;

    if (lane === 'business_wallet' && s.businessId && netCents > 0) {
      /* CENTS, matching what was credited. Reversing a rounded shilling figure against a
         cents balance would leave a residue on every reversal. */
      const bwRef = db.collection(BW.WALLETS).doc(String(s.businessId));
      const beRef = db.collection(BW.ENTRIES)
        .doc(BW.entryDocId(s.businessId, BW.assertRef(`ordersettle_reversal_${orderId}`)));
      const [bwSnap, beSnap] = await Promise.all([t.get(bwRef), t.get(beRef)]);

      if (!beSnap.exists) {
        const before = Number((bwSnap.exists ? bwSnap.data().balanceMinor : 0) || 0);
        const debtBefore = Number((bwSnap.exists ? bwSnap.data().recoveryDebtMinor : 0) || 0);
        /* EXPLICIT DEBT (the same ratified policy the personal lane runs): the balance is
           floored at zero and whatever the merchant already moved out becomes a recoverable
           debt that future settlements clear first. */
        const plan = BW.planMove(-1, {
          amountMinor: netCents, recovery: true,
          balanceBeforeMinor: before, recoveryDebtBeforeMinor: debtBefore,
        });
        reversedMinor = netCents;
        recoveredMinor = netCents - plan.shortfallMinor;
        shortfallMinor = plan.shortfallMinor;

        t.set(beRef, {
          ref: `ordersettle_reversal_${orderId}`,
          businessId: String(s.businessId),
          storeId: s.storeId || null,
          direction: 'debit',
          amountMinor: netCents,
          balanceBeforeMinor: plan.balanceBeforeMinor,
          balanceAfterMinor: plan.balanceAfterMinor,
          appliedToDebtMinor: plan.appliedToDebtMinor,
          shortfallMinor: plan.shortfallMinor,
          recoveryDebtBeforeMinor: plan.recoveryDebtBeforeMinor,
          recoveryDebtAfterMinor: plan.recoveryDebtAfterMinor,
          currency: 'KES',
          kind: 'marketplace_settlement_reversal',
          sourceUid: null,
          /* THE SAME STREAM IT CAME FROM. A refunded order is not a sale that happened and
             then a separate negative event — it is a sale that stopped counting, so it has to
             leave the channel it entered. Carrying the channel here is what lets the
             breakdown subtract rather than accumulate a phantom online total. */
          source: {
            channel: 'ONLINE',
            businessId: String(s.businessId),
            shopId: s.storeId || null,
            orderId: orderId,
            paymentRef: null,
            grossMinor: Number(s.grossCents) || 0,
            commissionMinor: Number(s.commissionCents) || 0,
            netMinor: netCents,
            currency: 'KES',
          },
          metadata: { orderId, reason: opts.reason || 'post-settlement-refund' },
          createdAt: FV.serverTimestamp(),
        });
        t.set(bwRef, {
          balanceMinor: plan.balanceAfterMinor,
          recoveryDebtMinor: plan.recoveryDebtAfterMinor,
          updatedAt: FV.serverTimestamp(),
        }, { merge: true });
      }
      /* Reported in shillings too, so the reversal record and its readers keep one shape
         across both lanes. */
      recoveredFromBalance = Math.floor(recoveredMinor / 100);
      shortfall = Math.floor(shortfallMinor / 100);

    } else if (sellerId && netShillings > 0) {
      /* LEGACY LANE — a settlement written before the destination moved. Unchanged. */
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
      /* The lane, and the exact cents. Which wallet was debited is the first thing a
         reconciliation asks, and it must not have to guess from an era. */
      settlementDestination: lane,
      businessId: s.businessId || null,
      reversedMinor, recoveredMinor, shortfallMinor,
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
