#!/usr/bin/env node
'use strict';

/**
 * wallet-freeze-gate.js — the single gate that must pass BEFORE the wallet backend is frozen.
 *
 *   node scripts/wallet-freeze-gate.js
 *
 * The freeze is only safe if NO test leaves any of these behind:
 *   · a stuck reservation        (wallet.pendingPayout ≠ sum of in-flight payouts)
 *   · an orphan ledger entry     (a payout ledger row with no live payout doc)
 *   · an inconsistent balance    (a paid/refunded payout that didn't move the wallet)
 *   · a payout without evidence  (status paid|completed but no gateway reference/confirmation)
 *
 * It composes three layers:
 *   1. reconcile-payouts.js            — live DB invariants (read-only, no gateway key)
 *   2. test-b2c-webhook-classification — the P0 double-spend regression (12 cases)
 *   3. wallet-money-path-proofs.json   — real-money E2E proofs that must be confirmed by a human
 *
 * Exits NON-ZERO on any failure. A green run = the four freeze invariants hold AND every
 * money path has a recorded live proof. Never freeze on a red gate.
 */
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;

function step(label, script, args) {
  process.stdout.write(`\n▶ ${label}\n`);
  try {
    const out = execFileSync(NODE, [path.join('scripts', script), ...(args || [])], { cwd: ROOT, encoding: 'utf8' });
    process.stdout.write(out);
    return true;
  } catch (e) {
    if (e.stdout) process.stdout.write(e.stdout);
    if (e.stderr) process.stderr.write(e.stderr);
    return false;
  }
}

const results = [];

/* 1) Live DB reconciliation — the four freeze invariants live here. Full run (no --gate)
      so ANY mismatch, not only CRITICAL, blocks the freeze. */
results.push(['payout reconciliation (stuck / orphan / balance / evidence)', step('Reconciliation', 'reconcile-payouts.js')]);

/* 2) Classification regression — proves the double-spend can never re-open. */
results.push(['B2C webhook classification regression (12 cases)', step('Webhook classification', 'test-b2c-webhook-classification.js')]);

/* 2b) Claimable-transfer money invariants — exactly-once claim/refund, conservation. */
results.push(['Claimable Transfers money invariants (16 cases)', step('Claimable invariants', 'test-claimable-transfers.js')]);

/* 3) Real-money E2E proofs — a human confirms each live money path in the manifest. */
process.stdout.write('\n▶ Money-path proofs (real-money E2E)\n');
let proofsOk = true;
try {
  const proofs = require('./wallet-money-path-proofs.json');
  for (const [k, v] of Object.entries(proofs)) {
    if (k.startsWith('_')) continue;
    const ok = !!(v && v.confirmed);
    if (!ok) proofsOk = false;
    process.stdout.write(`  ${ok ? '✅' : '⛔'} ${k}\n     ${(v && v.evidence) || '(no evidence recorded)'}\n`);
  }
} catch (e) {
  process.stdout.write(`  ⛔ could not read wallet-money-path-proofs.json: ${e.message}\n`);
  proofsOk = false;
}
results.push(['money-path proofs all confirmed', proofsOk]);

/* Verdict. */
process.stdout.write('\n=== WALLET FREEZE GATE ===\n');
let allOk = true;
for (const [label, ok] of results) {
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${label}\n`);
  if (!ok) allOk = false;
}
if (allOk) {
  process.stdout.write('\n✅ GATE GREEN — freeze is safe. No stuck reservation, orphan ledger, inconsistent balance, or unproven money path.\n');
  process.exit(0);
} else {
  process.stdout.write('\n⛔ GATE RED — DO NOT FREEZE. Resolve every FAIL above first.\n');
  process.exit(1);
}
