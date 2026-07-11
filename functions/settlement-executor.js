/* ================================================================
   SOKONI — Settlement Executor (split vs collect-then-payout)
   functions/settlement-executor.js

   Given a computed settlement breakdown and the payment provider, decides HOW
   the money is settled and records the ACTUAL method used:

     • split               — provider distributes the single customer charge
                             directly: platform commission → Bravilex collection
                             account, seller net → seller's registered payout
                             account. Used only when the provider supports it,
                             it is enabled in config, and the seller has a
                             registered payout account.
     • collect_then_payout — SOKONI collects 100% into the Bravilex account, the
                             Settlement Engine credits the seller wallet, and the
                             existing payout queue disburses. Always available.

   Every settlement/ledger/audit record carries settlementMethod so accounting,
   reconciliation, and audit reflect what actually happened. The full Bravilex
   account number is used only to build the gateway instruction server-side and
   is NEVER placed in a stored record (records carry the masked form).

   All monetary values are KES integer cents.
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin                  = require('firebase-admin');

const U   = require('./finos-utils');
const SE  = require('./settlement-engine');
const SA  = require('./settlement-account');
const SP  = require('./settlement-providers');

const REGION = 'us-central1';

function _db()  { return admin.firestore(); }
function _assertAdmin(req) {
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Admin access required');
}
const _kes = (cents) => Math.round(cents) / 100;

/* Decide the settlement method for a payment. Never throws; on any doubt it
   returns collect_then_payout (the always-safe path). */
async function resolveSettlementMethod(db, { provider, breakdown, sellerPayoutAccount }) {
  const cap = await SP.getProviderSettlement(db, provider);
  const hasAccount = !!(sellerPayoutAccount && sellerPayoutAccount.type && sellerPayoutAccount.value);
  const accountConfigured = SA.getSettlementAccount().configured;

  if (cap.canSplit && hasAccount && accountConfigured) {
    return { method: 'split', reason: 'native split enabled + seller payout account present', provider, capability: cap };
  }
  const reason = !cap.canSplit ? cap.reason
    : !hasAccount ? 'seller has no registered payout account'
    : 'collection account not configured';
  return { method: 'collect_then_payout', reason, provider, capability: cap };
}

/* Build the split instructions the gateway will execute. Platform share →
   Bravilex collection account (full number, server-side only); seller net →
   seller payout account. Returns { instructions, masked } — `masked` is safe
   to persist; `instructions` (with the full platform account) is for the
   adapter call only and must NOT be stored. */
function buildSplitInstructions(breakdown, { sellerPayoutAccount }) {
  const sellerNet = breakdown.sellerNetCents;
  const platformShare = breakdown.gross - sellerNet; // commission (+ any bundled platform portion)
  const acct = SA.getSettlementAccount();

  const instructions = [
    { role: 'seller',   account: { type: sellerPayoutAccount.type, value: sellerPayoutAccount.value }, amountKES: _kes(sellerNet) },
    { role: 'platform', account: { type: 'settlement', value: acct.number, name: SA.ACCOUNT_NAME }, amountKES: _kes(platformShare) },
  ];
  const masked = [
    { role: 'seller',   account: { type: sellerPayoutAccount.type, value: _maskTail(sellerPayoutAccount.value) }, amountCents: sellerNet },
    { role: 'platform', account: { type: 'settlement', value: acct.numberMasked, name: SA.ACCOUNT_NAME }, amountCents: platformShare },
  ];
  return { instructions, masked, sellerNetCents: sellerNet, platformShareCents: platformShare };
}

function _maskTail(v) {
  v = String(v || '');
  return v.length <= 4 ? v : '••••' + v.slice(-4);
}

/* Method-specific balanced ledger plan. In split mode funds are distributed at
   collection (no clearing hold, no separate payout entry); in fallback mode we
   reuse the engine's clearing-based plan. Both are net-zero (ΣDR=ΣCR). */
function buildLedgerPlan(breakdown, method, { sellerId, riderId } = {}) {
  const A = U.ACCOUNTS;
  if (method !== 'split') return breakdown.ledgerPlan; // collect-then-payout (engine plan)

  const plan = [];
  const add = (type, dr, cr, amt) => { if (amt > 0) plan.push({ type, debitAccount: dr, creditAccount: cr, amountCents: amt, settlementMethod: 'split' }); };
  /* Gateway distributes the collected charge directly at settlement time: */
  add('split_seller_direct',     A.EXTERNAL_GATEWAY, A.seller(sellerId || 'unknown'), breakdown.sellerNetCents);
  add('split_commission_direct', A.EXTERNAL_GATEWAY, A.PLATFORM_REVENUE,              breakdown.commission.cents);
  if (breakdown.delivery.riderNetCents > 0)
    add('split_delivery_direct', A.EXTERNAL_GATEWAY, A.rider(riderId || 'unknown'),   breakdown.delivery.riderNetCents);
  if (breakdown.delivery.platformCents > 0)
    add('split_platform_delivery', A.EXTERNAL_GATEWAY, A.PLATFORM_REVENUE,            breakdown.delivery.platformCents);
  return plan;
}

/* Build the persisted settlement record (audit + reconciliation). Carries the
   ACTUAL settlementMethod and masked account details only. */
function buildSettlementRecord({ breakdown, decision, orderId, sellerId, provider, splitMasked }) {
  return {
    orderId: orderId || null,
    sellerId: sellerId || null,
    provider,
    settlementMethod: decision.method,          // 'split' | 'collect_then_payout'
    methodReason: decision.reason,
    settlementStatus: 'settled',
    /* Payout diagnostics: split settles directly at the gateway (never enters the
       B2C payout queue — see the duplicate-payout guard in finos.processPendingPayouts). */
    payoutStatus: decision.method === 'split' ? 'direct' : 'via_queue',
    settlementRef: orderId ? `STL-${orderId}` : null,
    providerRef: null,                          // set from the gateway response on split execution
    merchantOfRecord: SA.ACCOUNT_NAME,
    collectionAccount: SA.getSettlementAccountMasked(),
    grossCents: breakdown.gross,
    commissionCents: breakdown.commission.cents,
    sellerNetCents: breakdown.sellerNetCents,
    gatewayFeeCents: breakdown.gatewayFee,
    vatCents: breakdown.tax.vatCents,
    whtCents: breakdown.tax.whtCents,
    split: decision.method === 'split' ? (splitMasked || null) : null,
    engineVersion: breakdown.engineVersion,
    currency: 'KES',
  };
}

/* Execute settlement. For 'split' it calls the provider adapter's
   initiateSplitPayment; for 'collect_then_payout' it signals the caller to use
   the existing collect+payout workflow. MONEY-MOVING — only the real payment
   flow calls this, behind routing flags. `adapter` is injected (already secret-
   bound); this module never holds provider keys. Falls back to collect-then-
   payout if the split call fails, and records the method actually used. */
async function executeSettlement(db, { adapter, provider, breakdown, orderId, sellerId, sellerPayoutAccount, phone, ref }) {
  const decision = await resolveSettlementMethod(db, { provider, breakdown, sellerPayoutAccount });

  if (decision.method === 'split') {
    try {
      const { instructions, masked } = buildSplitInstructions(breakdown, { sellerPayoutAccount });
      const result = await adapter.initiateSplitPayment({
        phone, amountKES: _kes(breakdown.gross), ref, narrative: 'SOKONI', splits: instructions,
      });
      if (!result || !result.success) throw new Error(result?.error || 'split call failed');
      const rec = buildSettlementRecord({ breakdown, decision, orderId, sellerId, provider, splitMasked: masked });
      rec.providerRef = result.splitId || null;   // gateway settlement reference
      return {
        settlementMethod: 'split',
        record: rec,
        ledgerPlan: buildLedgerPlan(breakdown, 'split', { sellerId }),
        providerRef: result.splitId || null,
      };
    } catch (e) {
      /* Split failed → automatic fallback to collect-then-payout. */
      const fb = { method: 'collect_then_payout', reason: `split failed (${e.message}) → fallback`, provider, capability: decision.capability };
      return {
        settlementMethod: 'collect_then_payout',
        fellBackFrom: 'split',
        record: buildSettlementRecord({ breakdown, decision: fb, orderId, sellerId, provider }),
        ledgerPlan: buildLedgerPlan(breakdown, 'collect_then_payout'),
      };
    }
  }

  /* Collect-then-payout: caller uses the existing collect + payout queue. */
  return {
    settlementMethod: 'collect_then_payout',
    record: buildSettlementRecord({ breakdown, decision, orderId, sellerId, provider }),
    ledgerPlan: buildLedgerPlan(breakdown, 'collect_then_payout'),
  };
}

/* ── Admin preview CF (no money movement) ──────────────────────── */
exports._h = exports._h || {};   // handler registry consumed by settlementDispatch
exports.settlementPreviewMethod = onCall(
  { region: REGION, secrets: [SA.SETTLEMENT_ACCOUNT_NUMBER], enforceAppCheck: true },
  exports._h.settlementPreviewMethod = async (req) => {
    _assertAdmin(req);
    const { grossCents, category, sellerId, provider, sellerPayoutAccount, gatewayFeeCents, deliveryFeeCents, riderId } = req.data || {};
    if (!provider) throw new HttpsError('invalid-argument', 'provider required');
    const breakdown = await SE.computeSettlement(_db(), { grossCents, category, sellerId, gatewayFeeCents, deliveryFeeCents, riderId });
    const decision  = await resolveSettlementMethod(_db(), { provider, breakdown, sellerPayoutAccount });
    const ledgerPlan = buildLedgerPlan(breakdown, decision.method, { sellerId, riderId });
    let splitMasked = null;
    if (decision.method === 'split' && sellerPayoutAccount) splitMasked = buildSplitInstructions(breakdown, { sellerPayoutAccount }).masked;
    return {
      decision,
      breakdown,
      ledgerPlan,
      split: splitMasked,
      record: buildSettlementRecord({ breakdown, decision, sellerId, provider, splitMasked }),
    };
  },
);

module.exports.resolveSettlementMethod = resolveSettlementMethod;
module.exports.buildSplitInstructions  = buildSplitInstructions;
module.exports.buildLedgerPlan         = buildLedgerPlan;
module.exports.buildSettlementRecord   = buildSettlementRecord;
module.exports.executeSettlement       = executeSettlement;
