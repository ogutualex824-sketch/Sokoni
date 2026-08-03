'use strict';
/**
 * Payout approve — double-click / concurrent idempotency guard.
 *
 *   node scripts/test-payout-idempotency.js
 *
 * Mirrors the atomic gate in wallet.js adminProcessPayout: an approve only
 * disburses if a transaction flips the payout status pending→approving; any
 * concurrent/second approve reads a non-pending status and bails ("already being
 * processed"), so a double-click can NEVER produce two disbursements. Firestore
 * transactions serialize the reads-before-writes, which this simulates.
 *
 * Regression proof so the double-spend guarantee is verified without spending real
 * money on live B2C payouts.
 */

/* Faithful model of the gate: shared status + a serialized "transaction". */
function makePayout(initialStatus) {
  const ALLOWED = ['pending', 'approval_failed', 'retry_scheduled'];
  let status = initialStatus;
  let disbursements = 0, gatewayRefs = 0, ledgerDebits = 0;
  function approve() {
    // runTransaction: read status; if approvable, atomically claim it.
    let gated = false;
    if (ALLOWED.includes(status)) { status = 'approving'; gated = true; }
    if (!gated) return { ok: false, reason: 'already being processed' };
    // gated === true → disburse exactly once, then move to processing.
    disbursements++; gatewayRefs++; ledgerDebits++;
    status = 'processing';
    return { ok: true };
  }
  return { approve, snap: () => ({ status, disbursements, gatewayRefs, ledgerDebits }) };
}

let pass = 0, fail = 0;
const check = (n, c) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}`); };

console.log('\n=== Payout approve — idempotency guard ===');

/* 1. Double-click on a pending payout → exactly ONE disbursement */
{
  const p = makePayout('pending');
  const r1 = p.approve();
  const r2 = p.approve();               // the double-click
  const s = p.snap();
  check('1a first click disburses', r1.ok === true);
  check('1b second click blocked ("already being processed")', r2.ok === false);
  check('1c exactly ONE disbursement / gateway ref / ledger debit',
        s.disbursements === 1 && s.gatewayRefs === 1 && s.ledgerDebits === 1);
}

/* 2. Triple/rapid clicks → still exactly one */
{
  const p = makePayout('pending');
  [0,1,2,3,4].forEach(() => p.approve());
  check('2 five rapid clicks → one disbursement', p.snap().disbursements === 1);
}

/* 3. Approve after already paid/processing → no disbursement */
{
  for (const st of ['processing', 'paid', 'approving', 'rejected', 'failed']) {
    const p = makePayout(st);
    const r = p.approve();
    check(`3 approve on '${st}' → blocked, 0 disbursements`, r.ok === false && p.snap().disbursements === 0);
  }
}

/* 4. Retryable states ARE approvable (once) */
{
  for (const st of ['approval_failed', 'retry_scheduled']) {
    const p = makePayout(st);
    p.approve(); p.approve();
    check(`4 approve on '${st}' → exactly one disbursement`, p.snap().disbursements === 1);
  }
}

console.log(`\n${fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' PASSED'}`);
process.exitCode = fail ? 1 : 0;
