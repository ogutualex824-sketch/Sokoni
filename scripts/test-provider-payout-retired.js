#!/usr/bin/env node
'use strict';
/* providerRequestPayout is RETIRED (owner 2026-10-03; 2f d4bccde, carried into the providerDispatch release on b2's request).
   The LIVE handler relabelled providerPayouts 'pending' → 'requested' and answered "success, reference PO-…" — a false
   success on a money surface (nothing disburses providerPayouts). Now it refuses unconditionally and marks nothing.
   W3 is 2f's row (scripts/test-withdrawals-off.js on commercial-fn), run here on the REAL provider-ops handler; W1/W2/W4
   test wallet.js / finos changes that ship in 2f's payout-gate unit, not in providerDispatch.
   BASE=c7e26b6 node scripts/test-provider-payout-retired.js → the live lineage (must FAIL W3). */
const path = require('path'), fs = require('fs'), os = require('os'), { execSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
let FN = path.join(ROOT, 'functions');
if (process.env.BASE) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ppr-'));
  execSync('git archive ' + process.env.BASE + ' functions | tar -x -C "' + d + '"', { cwd: ROOT, shell: 'bash' });
  FN = path.join(d, 'functions');
}
const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
const { call } = require('./lib/inmem-firestore');
const { DOCS } = H;
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
(async () => {
  const PO = require(path.join(FN, 'provider-ops.js'))._h;
  H.reset();
  DOCS.set('providerPayouts/x', { providerId: 'prov1', status: 'pending', net: 5000 });
  const r3 = await call(PO.providerRequestPayout, 'prov1', {});
  ck('W3', r3.det && r3.det.code === 'PAYOUT_ROUTE_RETIRED' && DOCS.get('providerPayouts/x').status === 'pending', 'providerRequestPayout refuses unconditionally and marks nothing (no false "success")', r3);
  const r4 = await call(PO.providerRequestPayout, null, {});
  ck('W3b', !!(r4 && (r4.code || r4.det)), 'an unauthenticated call is refused too', r4);
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
