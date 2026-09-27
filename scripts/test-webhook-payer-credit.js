/* test-webhook-payer-credit.js — C1 (CHANGELOG 214): the REAL webhookIntasend never credits the PAYER with their own
 * payment. Runs scripts/lib/webhook-harness.js (the real functions/index.js on the transactional fake, callback +
 * replay) per scenario. No network, no production.
 *
 * PROVES
 *   a buyer-initiated payment with NO earner in its attribution (a boost; a 'booking' deposit with no provider) is
 *   HELD — settlementStatus UNATTRIBUTED_HOLD, one commissionReviewQueue entry (also after the replay) — and NO
 *   wallet is credited (before: the buyer's own wallet, the booking one into the WITHDRAWABLE balance)
 *   unchanged: a merchant-initiated POS charge still credits the merchant; a booking naming its provider credits
 *   the provider; a product order credits its seller; a subscription credits nobody
 *
 *   node scripts/test-webhook-payer-credit.js
 */
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
function scenario(name) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'lib', 'webhook-harness.js'), ROOT, name], { encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 });
  const line = String(r.stdout || '').trim().split('\n').pop();
  try { return JSON.parse(line); } catch (_) { return { crashed: 'no JSON: ' + String(r.stderr || '').slice(0, 300) }; }
}
const walletsOf = (st) => Object.keys(st).filter((k) => /^wallets\/[^/]+$/.test(k));
const queueOf = (st) => Object.keys(st).filter((k) => /^commissionReviewQueue\//.test(k));

console.log('\n── buyer-initiated payments with no earner are HELD, never credited to the payer ──');
for (const sc of ['unattributedBoost', 'unattributedBooking']) {
  const j = scenario(sc);
  if (j.crashed) { ck(`${sc}: harness ran`, false, j.crashed); continue; }
  const st = j.store; const p = st['payments/' + j.ref] || {};
  ck(`${sc}: the callback and its replay are accepted (200, 200)`, JSON.stringify(j.calls) === '[200,200]', j.calls);
  ck(`${sc}: NO wallet is credited — not the payer's (buyer1), not anyone's`, walletsOf(st).length === 0 && !p.walletCreditedTo, walletsOf(st));
  ck(`${sc}: the payment is HELD (UNATTRIBUTED_HOLD) with exactly ONE review entry after the replay`, p.settlementStatus === 'UNATTRIBUTED_HOLD' && queueOf(st).length === 1, { settle: p.settlementStatus, q: queueOf(st) });
  ck(`${sc}: the payment itself is COMPLETE (the money is captured; only its settlement is held)`, p.status === 'COMPLETE', p.status);
}

console.log('\n── unchanged: every flow that HAS an earner ──');
const pos = scenario('posLegacy');
ck('a merchant-initiated POS charge still credits the merchant (the initiator IS the merchant)', !pos.crashed && (pos.store['payments/' + pos.ref] || {}).walletCreditedTo === 'merchant1' && walletsOf(pos.store).join() === 'wallets/merchant1', pos.crashed || walletsOf(pos.store));
const bk = scenario('bookingWithProvider');
ck('a booking naming its provider credits the PROVIDER\'s withdrawable balance, never the payer', !bk.crashed && (bk.store['payments/' + bk.ref] || {}).walletCreditedTo === 'prov1' && !bk.store['wallets/buyer1'] && bk.store['wallets/prov1'].balance > 0, bk.crashed || walletsOf(bk.store));
const mk = scenario('marketplace');
ck('a product order credits its SELLER', !mk.crashed && (mk.store['payments/' + mk.ref] || {}).walletCreditedTo === 'seller1' && !mk.store['wallets/buyer1'], mk.crashed || walletsOf(mk.store));
const tp = scenario('pos');
ck('a Till sale (intent with merchantUid) credits the Till\'s merchant', !tp.crashed && (tp.store['payments/' + tp.ref] || {}).walletCreditedTo === 'merchant1' && !tp.store['wallets/buyer1'], tp.crashed || walletsOf(tp.store));
const sb = scenario('subscription');
ck('a subscription credits nobody (entitlement only)', !sb.crashed && !(sb.store['payments/' + sb.ref] || {}).walletCreditedTo && queueOf(sb.store).length === 0, sb.crashed || queueOf(sb.store));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
