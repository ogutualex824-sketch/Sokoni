/* ================================================================
   SOKONI — Settlement Validation Harness (pre-activation gate)
   functions/settlement-validation.js

   Runs the mandatory safety checks a payment path must pass BEFORE its
   settlement routing is switched from legacy → mor. Read-only + synthetic
   data only; it never moves money. Checks that genuinely require a live
   Firestore emulator with seeded traffic (webhook replay under load, retry
   under concurrency) are reported as status 'manual' with the exact harness
   to run — they are NOT faked as 'pass'.

   Verdict: a path is 'ready' only when every automatable check passes and the
   manual checks are acknowledged.
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin                  = require('firebase-admin');

const U   = require('./finos-utils');
const SE  = require('./settlement-engine');
const SR  = require('./settlement-routing');

const REGION = 'us-central1';

function _db() { return admin.firestore(); }
function _assertAdmin(req) {
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Admin access required');
}
const pass   = (id, detail) => ({ check: id, status: 'pass', detail });
const fail   = (id, detail) => ({ check: id, status: 'fail', detail });
const manual = (id, detail) => ({ check: id, status: 'manual', detail });

/* 1 ── Accounting balance: engine ledger plan must be net-zero. */
async function checkAccountingBalance(db) {
  const b = await SE.computeSettlement(db, {
    grossCents: 250000, category: 'marketplace', sellerId: 'validate-seller',
    gatewayFeeCents: 7500, deliveryFeeCents: 30000, riderId: 'validate-rider',
  });
  try { SE.assertBalanced(b.ledgerPlan); } catch (e) { return fail('accounting_balance', e.message); }
  const dr = {}, cr = {};
  b.ledgerPlan.forEach((e) => { dr[e.debitAccount] = (dr[e.debitAccount] || 0) + e.amountCents; cr[e.creditAccount] = (cr[e.creditAccount] || 0) + e.amountCents; });
  const sum = (o) => Object.values(o).reduce((a, c) => a + c, 0);
  return sum(dr) === sum(cr)
    ? pass('accounting_balance', `ΣDR=ΣCR=${sum(dr)}¢ across ${b.ledgerPlan.length} postings`)
    : fail('accounting_balance', `ΣDR=${sum(dr)} ≠ ΣCR=${sum(cr)}`);
}

/* 2 ── Payout calculation: net must equal gross − commission; WHT + rider correct. */
async function checkPayoutCalculation(db) {
  const gross = 100000, expComm = 10000 /*10%*/, expNet = 90000, expWht = 4500, expRider = 17600;
  const b = await SE.computeSettlement(db, {
    grossCents: gross, category: 'marketplace', sellerId: 'validate-seller',
    deliveryFeeCents: 20000, riderId: 'r',
  });
  const errs = [];
  if (b.commission.cents !== expComm)      errs.push(`commission ${b.commission.cents}≠${expComm}`);
  if (b.sellerNetCents !== expNet)         errs.push(`net ${b.sellerNetCents}≠${expNet}`);
  if (b.tax.whtCents !== expWht)           errs.push(`wht ${b.tax.whtCents}≠${expWht}`);
  if (b.sellerAfterWhtCents !== expNet - expWht) errs.push(`afterWht ${b.sellerAfterWhtCents}≠${expNet - expWht}`);
  if (b.delivery.riderNetCents !== expRider) errs.push(`rider ${b.delivery.riderNetCents}≠${expRider}`);
  return errs.length ? fail('payout_calculation', errs.join('; '))
                     : pass('payout_calculation', `gross ${gross} → net ${expNet} → afterWHT ${expNet - expWht}, rider ${expRider}`);
}

/* 3 ── Idempotency: keys deterministic for same input, distinct for different. */
function checkIdempotency() {
  const a1 = U.generateIdempotencyKey(['settle', 'order123', 'seller9']);
  const a2 = U.generateIdempotencyKey(['settle', 'order123', 'seller9']);
  const b1 = U.generateIdempotencyKey(['settle', 'order124', 'seller9']);
  if (a1 !== a2) return fail('idempotency', 'same input produced different keys');
  if (a1 === b1) return fail('idempotency', 'different input produced same key');
  return pass('idempotency', `deterministic SHA-256 keys (same→same, diff→diff): ${a1.slice(0, 12)}…`);
}

/* 4 ── Rollback: killSwitch must force every method back to legacy. */
async function checkRollback() {
  /* Simulate a config with mor fully enabled + killSwitch on. */
  const fakeDb = {
    doc: () => ({ get: async () => ({ exists: true, data: () => ({
      killSwitch: true,
      methods: { intasend: { mode: 'mor', rolloutPct: 100, allowlist: [] } },
      version: 99,
    }) }) }),
  };
  const r = await SR.resolveRoute(fakeDb, 'intasend', { sellerId: 'any-seller' });
  return (!r.useMoR && r.mode === 'legacy')
    ? pass('rollback', 'killSwitch forces mor→legacy (useMoR=false)')
    : fail('rollback', `killSwitch did not force legacy: ${JSON.stringify(r)}`);
}

/* 5 ── Reconciliation: recent ledger sample must net to zero (debits==credits). */
async function checkReconciliation(db) {
  try {
    const snap = await db.collection('ledger').where('status', '==', 'settled')
      .orderBy('createdAt', 'desc').limit(200).get();
    if (snap.empty) return manual('reconciliation', 'no recent ledger entries to sample — run reconcileLedger on a seeded emulator');
    const bal = {};
    snap.forEach((d) => { const x = d.data(); if (x.debitAccount) bal[x.debitAccount] = (bal[x.debitAccount] || 0) - (x.amountCents || 0); if (x.creditAccount) bal[x.creditAccount] = (bal[x.creditAccount] || 0) + (x.amountCents || 0); });
    const net = Object.values(bal).reduce((a, c) => a + c, 0);
    return net === 0
      ? pass('reconciliation', `${snap.size} recent ledger entries net to zero`)
      : fail('reconciliation', `recent ledger sample nets to ${net}¢ (single-sided writers?) — see reconcileLedger`);
  } catch (e) {
    return manual('reconciliation', `could not sample ledger (${e.message}) — run reconcileLedger`);
  }
}

/* 6 ── Retry behaviour: structural — the live payout processor owns retry. */
function checkRetry() {
  return manual('retry',
    'Automatable only on emulator: seed payouts with retryAt/attempts and run processPendingPayouts '
    + '(finos.js:405) — assert stuck>10min reset, retry backoff [0,15,30]min, max 3 attempts, no double B2C.');
}

/* 7 ── Webhook replay: structural — requires replaying signed webhook bodies. */
function checkWebhookReplay(method) {
  return manual('webhook_replay',
    `Automatable only on emulator: POST the same signed ${method} webhook body twice to its callback `
    + '(e.g. finos.webhookPaymentCallback / financial-os.fosSecureWebhook) and assert the second is a no-op '
    + '(financialProcessed flag / finosIdempotency.create). Verify HMAC/IP rejection of tampered bodies.');
}

/* Aggregate into a readiness report for one method. */
async function runValidation(db, method) {
  const results = [
    await checkAccountingBalance(db),
    await checkPayoutCalculation(db),
    checkIdempotency(),
    await checkRollback(),
    await checkReconciliation(db),
    checkRetry(),
    checkWebhookReplay(method || 'the'),
  ];
  const failed = results.filter((r) => r.status === 'fail');
  const manualN = results.filter((r) => r.status === 'manual');
  const verdict = failed.length ? 'blocked'
    : manualN.length ? 'ready_pending_manual'
    : 'ready';
  return {
    method: method || null,
    verdict,
    summary: `${results.filter((r) => r.status === 'pass').length} pass / ${failed.length} fail / ${manualN.length} manual`,
    results,
    note: verdict === 'ready_pending_manual'
      ? 'Automatable checks pass. Run the manual emulator checks and acknowledge before switching this method to mor.'
      : verdict === 'blocked' ? 'One or more automatable checks FAILED — do not activate.' : 'All checks pass.',
  };
}

exports.settlementValidatePath = onCall(
  { region: REGION, enforceAppCheck: true, timeoutSeconds: 60 },
  async (req) => {
    _assertAdmin(req);
    const method = (req.data || {}).method || null;
    if (method && !SR.METHODS.includes(method))
      throw new HttpsError('invalid-argument', `method must be one of: ${SR.METHODS.join(', ')}`);
    return runValidation(_db(), method);
  },
);

module.exports.runValidation = runValidation;
module.exports.checkIdempotency = checkIdempotency;
module.exports.checkRollback = checkRollback;
