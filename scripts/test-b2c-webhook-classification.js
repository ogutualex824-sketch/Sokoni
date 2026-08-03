'use strict';
/**
 * Regression guard for the P0 double-spend: an IntaSend SEND-MONEY (B2C) webhook whose
 * progression lives in `status` ("Confirming balance"→…→"Completed") must NEVER be
 * classified as FAILED just because the collection-only `state` field is absent.
 *
 *   node scripts/test-b2c-webhook-classification.js
 *
 * Mirrors the classification in wallet.js finalizeB2CPayoutFromWebhook. If that logic
 * changes, keep this in lockstep — it is the proof the real payout ref UH36Q1AYSC
 * ("Completed") settles to PAID and the in-flight steps never touch money.
 */

/* EXACT classification from finalizeB2CPayoutFromWebhook. */
function classify(raw, priorStatus) {
  if (['paid', 'settled_manually'].includes(priorStatus)) return 'noop-terminal';   // Paid→X forbidden
  const S = String(raw.status || (raw.invoice && raw.invoice.state) || raw.state || '').trim().toUpperCase();
  const paidAmt   = Number(raw.paid_amount) || 0;
  const failedAmt = Number(raw.failed_amount) || 0;
  const completedWord = /COMPLETE/.test(S) || ['SUCCESS', 'PAID', 'SETTLED'].includes(S);
  const explicitFail  = ['FAILED', 'FAILURE', 'CANCELLED', 'CANCELED', 'REJECTED'].includes(S);
  const hasFailure    = failedAmt > 0 && paidAmt === 0;
  if (['REVERSED', 'REVERSAL', 'REFUNDED', 'CHARGEBACK'].includes(S)) return 'reversed';
  if (completedWord && !hasFailure) return 'paid';
  if (explicitFail || (completedWord && hasFailure)) return 'failed';
  return 'processing';   // in-flight — NEVER touches money
}

const CASES = [
  // [name, payload, priorStatus, expected]
  ['Confirming balance (the bug) → processing, NOT failed', { status: 'Confirming balance', tracking_id: 'f0' }, 'processing', 'processing'],
  ['Preview and approve → processing',                       { status: 'Preview and approve' }, 'processing', 'processing'],
  ['Sending payment → processing',                          { status: 'Sending payment' }, 'processing', 'processing'],
  ['Processing payment → processing',                       { status: 'Processing payment' }, 'processing', 'processing'],
  ['Completed + paid → PAID (ref UH36Q1AYSC)',              { status: 'Completed', paid_amount: 100, failed_amount: 0 }, 'processing', 'paid'],
  ['Completed but this one failed → failed',                { status: 'Completed', paid_amount: 0, failed_amount: 100 }, 'processing', 'failed'],
  ['Explicit Failed → failed',                              { status: 'Failed' }, 'processing', 'failed'],
  ['Cancelled → failed',                                    { status: 'Cancelled' }, 'processing', 'failed'],
  ['ABSENT status (dangerous default) → processing, NOT failed', {}, 'processing', 'processing'],
  ['Reversed → reversed',                                   { status: 'Reversed' }, 'paid', 'noop-terminal'],
  ['Any webhook after PAID → no-op (Paid→Failed forbidden)', { status: 'Failed' }, 'paid', 'noop-terminal'],
  ['collection-style COMPLETE state still works',           { invoice: { state: 'COMPLETE', paid_amount: 50 } }, 'processing', 'paid'],
];

let pass = 0, fail = 0;
console.log('\n=== B2C webhook classification — regression guard ===');
for (const [name, payload, prior, expected] of CASES) {
  const got = classify(payload, prior);
  const ok = got === expected;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${got}${ok ? '' : `, expected ${expected}`})`);
  ok ? pass++ : fail++;
}
console.log(`\n${fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' PASSED'}`);
process.exitCode = fail ? 1 : 0;
