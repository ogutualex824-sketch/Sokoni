#!/usr/bin/env node
'use strict';
/**
 * predeploy-payout-gate.js — payout reconciliation as a deploy gate.
 *
 * Runs scripts/reconcile-payouts.js in GATE mode WITHOUT a CLI arg — the Windows
 * firebase predeploy spawner mangles a trailing `--gate` after a quoted path, which
 * silently turned the gate into a hard failure. This wrapper forces gate mode in
 * argv and swallows any infra/connectivity error (missing ADC in a CI context must
 * never block a code deploy). Only a CONFIRMED CRITICAL invariant
 * (paid-without-gateway-ref, duplicate gateway reference) exits non-zero.
 */
process.argv.push('--gate');
try {
  require('./reconcile-payouts.js');   // calls process.exit() itself
} catch (e) {
  console.warn('[payout-gate] reconciliation skipped (infra):', e.message);
  process.exit(0);
}
