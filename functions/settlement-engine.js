/* ================================================================
   SOKONI — Enterprise Settlement Engine (canonical layer)
   functions/settlement-engine.js

   THE single, canonical definition of the marketplace money-flow:

     Buyer → Gateway → [ Bravilex Collection Account (MoR) ]
           → Settlement Engine → deductions waterfall → Seller net

   This module is a UNIFYING LAYER, not a rewrite. It:
     • Reuses the existing canonical math in finos-utils.js (commission,
       VAT, WHT, promo) so NO payout amount changes when a caller adopts it.
     • Reuses the existing ACCOUNTS namespace + createLedgerEntry primitive,
       so posted entries stay balanced and pass finos.js reconcileLedger.
     • Stamps the canonical Bravilex collection account (Merchant-of-Record,
       from settlement-account.js / Secret Manager) onto every settlement
       result and audit record — the account NUMBER never leaves the server.

   Adoption is phased: payment entry points call computeSettlement() to get
   one canonical breakdown + balanced ledgerPlan, instead of each re-deriving
   its own split. Existing engines (finos.js, finos-router.js) keep running
   until migrated — see docs/ENTERPRISE_SETTLEMENT_ARCHITECTURE.md.

   All monetary values are KES integer cents.
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger                 = require('firebase-functions/logger');
const admin                  = require('firebase-admin');

const U   = require('./finos-utils');
const SA  = require('./settlement-account');

const REGION        = 'us-central1';
const ENGINE_VERSION = '1.0.0';

function _db()  { return admin.firestore(); }
function _now() { return admin.firestore.FieldValue.serverTimestamp(); }
function _assertAuth(req) { if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Login required'); }
function _assertAdmin(req) {
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Admin access required');
}
const _int = (v) => Math.max(0, Math.round(Number(v) || 0));

/* Default rider share of the delivery fee — mirrors finos.js (0.88). */
const DEFAULT_RIDER_PCT = 0.88;

/* ────────────────────────────────────────────────────────────────
   computeSettlement — the ONE canonical deductions waterfall.

   Pure-ish (async only because commission rules live in Firestore).
   Faithfully reproduces the existing finos math; every currently-missing
   line (gatewayFee, referral, affiliate, serviceCharge) is surfaced as an
   explicit field defaulting to 0, so it is auditable and can be phased in
   without changing today's payout amounts.

   input = {
     grossCents,               // customer payment (100% collected to Bravilex first)
     category, sellerId, hubId,
     gatewayFeeCents,          // PSP fee (platform-borne expense; default 0)
     deliveryFeeCents, riderId, riderPct,
     discountCents, discountFundedBy ('platform'|'seller'),
     referralBonusCents, affiliateCommissionCents, serviceChargeCents,
   }
   returns a full, immutable breakdown + a BALANCED ledgerPlan.
──────────────────────────────────────────────────────────────── */
async function computeSettlement(db, input = {}) {
  const grossCents = _int(input.grossCents);
  if (!grossCents) throw new Error('computeSettlement: grossCents required');

  const category = input.category || 'marketplace';
  const sellerId = input.sellerId || null;

  /* 1 ── Platform commission (canonical rule engine) */
  const comm = await U.calculateCommission(db, {
    orderAmountCents: grossCents, category, sellerId, hubId: input.hubId,
  });
  const commissionCents = _int(comm.commissionCents);
  const effectiveRate   = comm.effectiveRate;

  /* 2 ── Payment processing / gateway fee (platform expense, does NOT reduce seller net) */
  const gatewayFeeCents = _int(input.gatewayFeeCents);

  /* 3 ── Taxes: VAT on commission (platform), WHT withheld at payout */
  const vatCents = _int(U.calculateVAT(commissionCents, category).taxCents);

  /* 4 ── Seller gross earning (faithful to finos: gross − commission) */
  const sellerNetCents = _int(grossCents - commissionCents);

  /* 5 ── WHT applied when the seller cashes out (surfaced here, deducted at payout) */
  const whtCents           = _int(U.calculateWHT(sellerNetCents).whtCents);
  const sellerAfterWhtCents = _int(sellerNetCents - whtCents);

  /* 6 ── Delivery / rider allocation */
  const deliveryFeeCents = _int(input.deliveryFeeCents);
  const riderPct         = typeof input.riderPct === 'number' ? input.riderPct : DEFAULT_RIDER_PCT;
  const riderNetCents    = _int(deliveryFeeCents * riderPct);
  const platformDelivCents = _int(deliveryFeeCents - riderNetCents);

  /* 7 ── Discounts / promos, rewards, referral, affiliate, service charge (surfaced) */
  const discountCents          = _int(input.discountCents);
  const discountFundedBy       = input.discountFundedBy === 'seller' ? 'seller' : 'platform';
  const referralBonusCents     = _int(input.referralBonusCents);
  const affiliateCommissionCents = _int(input.affiliateCommissionCents);
  const serviceChargeCents     = _int(input.serviceChargeCents);

  /* 8 ── Platform net earnings (what Bravilex retains) */
  const platformGrossCents = _int(commissionCents + platformDelivCents);
  const platformNetCents   = _int(
    platformGrossCents - gatewayFeeCents - referralBonusCents - affiliateCommissionCents
    - (discountFundedBy === 'platform' ? discountCents : 0),
  );

  /* 9 ── Balanced ledger plan (each pair: 1 debit acct, 1 credit acct, equal amount).
          Mirrors finos.js recordPayment so reconcileLedger stays net-zero. */
  const A = U.ACCOUNTS;
  const ledgerPlan = [];
  const add = (type, debitAccount, creditAccount, amountCents) => {
    if (amountCents > 0) ledgerPlan.push({ type, debitAccount, creditAccount, amountCents });
  };
  add('payment_received', A.EXTERNAL_GATEWAY, A.PLATFORM_CLEARING, grossCents);
  if (sellerId) add('seller_earning', A.PLATFORM_CLEARING, A.seller(sellerId), sellerNetCents);
  add('commission', A.PLATFORM_CLEARING, A.PLATFORM_REVENUE, commissionCents);
  add('tax_vat', A.PLATFORM_REVENUE, A.PLATFORM_TAX, vatCents);
  add('gateway_fee', A.PLATFORM_EXPENSES, A.EXTERNAL_GATEWAY, gatewayFeeCents);
  if (input.riderId) add('delivery_fee', A.PLATFORM_CLEARING, A.rider(input.riderId), riderNetCents);
  if (discountCents && discountFundedBy === 'platform')
    add('promotion', A.PLATFORM_PROMOS, A.PLATFORM_CLEARING, discountCents);

  return Object.freeze({
    engineVersion: ENGINE_VERSION,
    merchantOfRecord: SA.ACCOUNT_NAME,
    collectionAccount: SA.getSettlementAccountMasked(),   // masked — never the full number
    currency: 'KES',
    gross: grossCents,
    commission: { cents: commissionCents, rate: effectiveRate },
    gatewayFee: gatewayFeeCents,
    tax: { vatCents, whtCents },
    discount: { cents: discountCents, fundedBy: discountFundedBy },
    delivery: { feeCents: deliveryFeeCents, riderNetCents, platformCents: platformDelivCents },
    referralBonusCents, affiliateCommissionCents, serviceChargeCents,
    sellerNetCents,                 // credited to seller wallet at settlement
    sellerAfterWhtCents,            // paid out after WHT at cash-out
    platformGrossCents, platformNetCents,
    netPayable: sellerNetCents,     // canonical "Net Payable" to the seller
    ledgerPlan,
  });
}

/* Assert the plan balances (ΣDR == ΣCR) — every pair is 1:1, so this always
   holds, but we verify defensively before any caller posts it. */
function assertBalanced(ledgerPlan) {
  const debit = {}, credit = {};
  for (const e of ledgerPlan) {
    debit[e.debitAccount]   = (debit[e.debitAccount]   || 0) + e.amountCents;
    credit[e.creditAccount] = (credit[e.creditAccount] || 0) + e.amountCents;
  }
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  if (sum(debit) !== sum(credit))
    throw new Error(`Settlement ledger plan not balanced: ΣDR=${sum(debit)} ΣCR=${sum(credit)}`);
  return true;
}

/* Canonical settlement context for entry points / dashboard (masked account only). */
function getSettlementContext() {
  return {
    engineVersion: ENGINE_VERSION,
    merchantOfRecord: SA.ACCOUNT_NAME,
    collectionAccount: SA.getSettlementAccountMasked(),
    model: 'MERCHANT_OF_RECORD',
    note: '100% of every customer payment is collected into the Bravilex account first; '
        + 'the engine calculates deductions and settles the seller net.',
  };
}

/* ──────────────────────────────────────────────────────────────
   Cloud Functions (admin-gated, additive — do not alter existing flows)
──────────────────────────────────────────────────────────────── */

/* Masked settlement account + rules. NEVER returns the full account number. */
exports._h = exports._h || {};   // handler registry consumed by settlementDispatch
exports.settlementGetContext = onCall(
  { region: REGION, secrets: [SA.SETTLEMENT_ACCOUNT_NUMBER], enforceAppCheck: true },
  exports._h.settlementGetContext = async (req) => {
    _assertAuth(req); _assertAdmin(req);
    let rules = {};
    try { rules = (await _db().doc('finosConfig/settlementRules').get()).data() || {}; } catch (_) {}
    return { ...getSettlementContext(), settlementRules: rules };
  },
);

/* Admin preview of the canonical waterfall for a hypothetical payment. */
exports.settlementPreview = onCall(
  { region: REGION, secrets: [SA.SETTLEMENT_ACCOUNT_NUMBER], enforceAppCheck: true },
  exports._h.settlementPreview = async (req) => {
    _assertAuth(req); _assertAdmin(req);
    const breakdown = await computeSettlement(_db(), req.data || {});
    assertBalanced(breakdown.ledgerPlan);
    return breakdown;
  },
);

/* Aggregated metrics for the Settlement Dashboard (reads existing collections). */
exports.settlementGetDashboard = onCall(
  { region: REGION, secrets: [SA.SETTLEMENT_ACCOUNT_NUMBER], enforceAppCheck: true, timeoutSeconds: 60 },
  exports._h.settlementGetDashboard = async (req) => {
    _assertAuth(req); _assertAdmin(req);
    const db = _db();

    const [snapSnap, payPending, payDone, payFailed, escrowHeld, settleDocs] = await Promise.all([
      db.collection('finosSnapshots').orderBy('createdAt', 'desc').limit(1).get().catch(() => null),
      db.collection('payouts').where('status', '==', 'pending').count().get().catch(() => null),
      db.collection('payouts').where('status', '==', 'completed').count().get().catch(() => null),
      db.collection('payouts').where('status', '==', 'failed').count().get().catch(() => null),
      db.collection('escrows').where('status', '==', 'held').count().get().catch(() => null),
      db.collection('settlements').orderBy('createdAt', 'desc').limit(20).get().catch(() => null),
    ]);

    const snap = snapSnap && !snapSnap.empty ? snapSnap.docs[0].data() : {};
    const cnt  = (c) => (c && typeof c.data === 'function' ? c.data().count : 0);

    return {
      context: getSettlementContext(),
      generatedAt: Date.now(),
      revenue: {
        grossRevenueCents:    snap.grossRevenueCents    || snap.totalGmvCents      || 0,
        platformRevenueCents: snap.commissionCents      || snap.platformRevenueCents || 0,
        taxCollectedCents:    snap.vatCents             || snap.taxCents           || 0,
        gatewayChargesCents:  snap.gatewayFeeCents      || 0,
        netProfitCents:       snap.netProfitCents       || 0,
      },
      queues: {
        pendingSettlements: cnt(payPending),
        completedSettlements: cnt(payDone),
        failedSettlements: cnt(payFailed),
        escrowHeld: cnt(escrowHeld),
      },
      recentSettlements: settleDocs ? settleDocs.docs.map((d) => {
        const x = d.data();
        const method = x.settlementMethod || 'collect_then_payout';
        return {
          id: d.id, sellerId: x.sellerId || null,
          amountCents: x.amountCents || x.sellerNetCents || x.netCents || 0,
          status: x.status || 'settled',
          /* Admin-only settlement diagnostics (not customer-facing). */
          settlementMethod: method,                                  // 'split' | 'collect_then_payout'
          provider:         x.provider || null,                      // e.g. 'intasend'
          settlementStatus: x.settlementStatus || x.status || 'settled',
          payoutStatus:     x.payoutStatus || (method === 'split' ? 'direct' : (x.payout?.status || 'via_queue')),
          settlementRef:    x.settlementRef || d.id,                 // our reference
          providerRef:      x.providerRef || (x.split && x.split.providerRef) || null, // gateway reference
          createdAt: x.createdAt?.toMillis?.() || null,
        };
      }) : [],
    };
  },
);

module.exports.computeSettlement    = computeSettlement;
module.exports.assertBalanced       = assertBalanced;
module.exports.getSettlementContext = getSettlementContext;
module.exports.ENGINE_VERSION       = ENGINE_VERSION;
