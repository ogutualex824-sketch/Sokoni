/* test-refund-exactly-once.js — the canonical refund rail, proven by EXECUTION.
 *
 * Runs the REAL fosSubmitRefund / fosApproveRefund / fosResolveRefund
 * (scripts/lib/refund-harness.js — fake gateway, transactional fake Firestore,
 * no network) on BASE (a38b31a) and on this BRANCH.
 *
 * WHAT THESE PROVE
 *   request → approval → ONE provider call → authoritative outcome → ONE local
 *   settlement, under: success, transient Firestore failure after the gateway,
 *   provider 5xx / 429 / dropped connection (OUTCOME UNKNOWN), definitive 400,
 *   a concurrent second approval, and an admin re-approving whatever is left.
 *   POSITIVE CONTROLS: base sends 2–3 refunds for one request — the harness can
 *   see a double refund, so "1" on the branch is evidence.
 *
 *   node scripts/test-refund-exactly-once.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const BASE = process.env.CREATOR_BASE_TREE || 'C:/temp/sok-creator-base2';
const H = path.join(__dirname, 'lib', 'refund-harness.js');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 130) + ']' : '')); ok ? pass++ : fail++; };
function run(tree, scenario, gateway = 'ok', failAfter = false) {
  const r = spawnSync(process.execPath, [H, tree, scenario], { encoding: 'utf8', timeout: 120000, env: { ...process.env, GATEWAY: gateway, FAIL_TXN_AFTER_GATEWAY: failAfter ? '1' : '0' } });
  try { return JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch (_) { return { crashed: (r.stderr || r.stdout || '').slice(-300) }; }
}
const st = (x) => (x && x.ok ? x.ok.status : x && x.err);

const baseOk = fs.existsSync(path.join(BASE, 'functions', 'financial-os.js')) && fs.existsSync(path.join(BASE, 'functions', 'node_modules'));
ck(`BASE tree present (${BASE})`, baseOk);
if (!baseOk) { console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n'); process.exit(2); }

console.log('\n── POSITIVE CONTROLS: base sends more than one refund ──');
for (const [sc, gw, fa, why] of [
  ['submit', 'ok', false, 'admin refund of an STK payment, NOTHING fails'],
  ['submit', 'throw', false, 'dropped connection'],
  ['submitRace', 'ok', false, 'submit racing a second approval'],
  ['approve', 'http503', false, 'provider 503 retried blind'],
]) {
  const b = run(BASE, sc, gw, fa);
  ck(`BASE ${sc}/${gw}: ${why} → ${b.gatewayCalls} refunds`, !b.crashed && b.gatewayCalls >= 2, b.crashed);
}

console.log('\n── BRANCH: exactly one provider call per request ──');
const matrix = [
  ['approve', 'ok', false, 'processed', 'processed'],
  ['approve', 'ok', true, 'provider_succeeded', 'processed'],
  ['approve', 'http503', false, 'outcome_unknown', 'processed'],
  ['approve', 'http429', false, 'outcome_unknown', 'processed'],
  ['approve', 'throw', false, 'outcome_unknown', 'processed'],
  ['submit', 'ok', false, 'processed', 'processed'],
  ['submit', 'ok', true, 'provider_succeeded', 'processed'],
  ['submit', 'throw', false, 'outcome_unknown', 'processed'],
  ['submitRace', 'ok', false, 'processed', 'processed'],
  ['approveRace', 'ok', false, 'processed', 'processed'],
];
for (const [sc, gw, fa, afterFirst, finalAfterResolve] of matrix) {
  const tag = `${sc}/${gw}${fa ? '+txnfail' : ''}`;
  const r = run(ROOT, sc, gw, fa);
  if (r.crashed) { ck(`${tag}: ran`, false, r.crashed); continue; }
  ck(`${tag}: ONE provider call`, r.gatewayCalls === 1, r.gatewayCalls);
  ck(`${tag}: left in ${afterFirst}`, r.steps.afterFirst === afterFirst, r.steps.afterFirst);
  ck(`${tag}: re-approval REFUSED (no second refund)`, st(r.steps.reapprove) === 'failed-precondition', JSON.stringify(r.steps.reapprove));
  ck(`${tag}: plain admin cannot resolve`, st(r.steps.resolveAsAdmin) === 'permission-denied');
  ck(`${tag}: after resolution → ${finalAfterResolve}, still ONE provider call`, r.final === finalAfterResolve && r.gatewayCalls === 1);
  ck(`${tag}: resolving again is refused (idempotent)`, st(r.steps.resolveAgain) === 'failed-precondition');
  if (sc === 'approve' || sc === 'approveRace') ck(`${tag}: seller debited EXACTLY once (10000c)`, r.sellerRefundedCents === 10000, r.sellerRefundedCents);
  if (sc.startsWith('submit')) ck(`${tag}: buyer's wallet NEVER debited`, r.buyerWallet === null, JSON.stringify(r.buyerWallet));
  if (sc === 'submitRace' || sc === 'approveRace') ck(`${tag}: the racing approval lost`, [st(r.steps.first), st(r.steps.second)].filter((x) => x === 'failed-precondition').length === 1, [st(r.steps.first), st(r.steps.second)].join('/'));
}

console.log('\n── BRANCH: a definitive rejection is retryable, and only that ──');
{
  const r = run(ROOT, 'approve', 'http400', false);
  ck('400 → failed (provider said no; nothing refunded)', r.steps.afterFirst === 'failed');
  ck('400 → re-approval allowed and re-executes (2 calls, both rejected)', r.gatewayCalls === 2 && st(r.steps.reapprove) === 'internal');
  ck('400 → nothing to resolve', st(r.steps.resolve) === 'failed-precondition');
  ck('400 → seller never debited', r.sellerRefundedCents === 0);
}

console.log('\n── BRANCH: payRef refunds attribute the SELLER from the intent ──');
{
  const r = run(ROOT, 'submitMarketplace', 'ok', false);
  ck('marketplace payRef refund: ONE call, processed', r.gatewayCalls === 1 && r.final === 'processed');
  ck('seller (from intent) debited, not the buyer', r.sellerRefundedCents === 10000 && r.buyerWallet === null, JSON.stringify(r.buyerWallet));
}

console.log('\n── pure classification ──');
{
  const { _refundInternals: I } = require(path.join(ROOT, 'functions', 'financial-os.js'));
  for (const [code, want] of [[400, true], [401, true], [404, true], [422, true], [408, false], [409, false], [425, false], [429, false], [500, false], [503, false], [504, false], [null, false], [undefined, false], ['400', true]]) {
    ck(`HTTP ${code} definitive rejection = ${want}`, I._isDefinitiveRejection(code) === want);
  }
  ck('executable states are exactly pending / approved / failed', JSON.stringify([...I.REFUND_EXECUTABLE].sort()) === '["approved","failed","pending"]');
}

console.log('\n── wiring ──');
{
  const fos = fs.readFileSync(path.join(ROOT, 'functions', 'financial-os.js'), 'utf8');
  ck('ONE provider call site in the refund rail', (fos.match(/adapter\.initiateRefund\(/g) || []).length === 1);
  ck('both entry points use _executeRefund', /return _executeRefund\(refundRef\.id/.test(fos) && /await _executeRefund\(refundId/.test(fos));
  ck("no path resets a refund to 'approved' after a gateway call", !/status:\s*'approved',\s*gatewayError/.test(fos));
  ck('fosResolveRefund exported by index.js', /exports\.fosResolveRefund\s*=/.test(fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8')));
  ck('adapter reports httpStatus', /httpStatus:\s*res\.status/.test(fs.readFileSync(path.join(ROOT, 'functions', 'payment-adapters.js'), 'utf8')));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
