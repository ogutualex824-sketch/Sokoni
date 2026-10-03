#!/usr/bin/env node
/* SECURITY CONVERGENCE 2026-10-03 — webhookIntasend never credits the PAYER, and never credits platform revenue.
 *   node scripts/test-webhook-no-payer-credit.js        BASE=7428465 node scripts/test-webhook-no-payer-credit.js (must FAIL)
 * Part A EXECUTES the pure decision (payment-attribution.walletCreditDecision) for every flow class the census found
 * among the live initiateSTKPush callers. Part B checks, by source, that webhookIntasend takes its earner ONLY from that
 * decision (no `payData.uid` fallback). The webhook runtime itself is the emulator layer's (UNPROVEN until memory allows). */
'use strict';
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => (process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }) : fs.readFileSync(path.join(ROOT, f), 'utf8'));
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 200) + ']')); ok ? pass++ : fail++; };
console.log('\nwebhook: no payer credit, no platform-revenue credit   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
const tmp = path.join(ROOT, 'functions', '.pa-' + process.pid + '.js');
fs.writeFileSync(tmp, read('functions/payment-attribution.js'));
process.on('exit', () => { try { fs.unlinkSync(tmp); } catch (_) {} });
const PA = require(tmp);
const D = PA.walletCreditDecision;
if (typeof D !== 'function') { console.log('  FAIL LOAD no walletCreditDecision — the webhook decides inline, payer fallback included\n\nRESULT: 0 passed, 1 failed'); process.exit(1); }
const dec = (o) => D(Object.assign({ attribution: { source: 'legacy_meta' }, category: 'default' }, o));

/* ── A: every census flow class ── */
let r = dec({ category: 'fitness' });
ck('A-1', r.action === 'withhold' && r.earner === null && r.reason === 'no_earner', 'platformBook / gateway / waConnect (buyer-initiated, no seller): WITHHELD — never credited to the payer', r);
r = dec({ attribution: { type: 'booking' }, category: 'healthcare' });
ck('A-2', r.action === 'withhold' && r.earner === null, 'bookNow WITHOUT providerId: withheld (was a booking_earning to the PAYER\'s wallet)', r);
r = dec({ attribution: { type: 'booking', providerId: 'prov1' }, category: 'healthcare' });
ck('A-3', r.action === 'credit_booking' && r.earner === 'prov1', 'CONTROL: bookNow WITH providerId credits the provider', r);
r = dec({ attribution: { sellerUid: 'seller1' }, category: 'product' });
ck('A-4', r.action === 'credit_sale' && r.earner === 'seller1', 'CONTROL: an attributed seller is credited', r);
r = dec({ attribution: { merchantUid: 'till1' }, category: 'default' });
ck('A-5', r.action === 'credit_sale' && r.earner === 'till1', 'CONTROL: a Till QR (pos_till_sale) merchant is credited', r);
for (const [id, o, m] of [
  ['P-1', { intentPurpose: 'subscription', category: 'default' }, 'subscription-checkout (no category, intent purpose subscription)'],
  ['P-2', { metaPurpose: 'subscription' }, 'sub-engine renewals (meta.purpose subscription, no category)'],
  ['P-3', { intentPurpose: 'boost', category: 'boost', attribution: { sellerUid: 'seller1' } }, 'listing boost — even WITH a client-sent sellerUid'],
  ['P-4', { intentPurpose: 'marketing_boost', category: 'marketing' }, 'marketing boost'],
  ['P-5', { intentPurpose: 'hub_registration', category: 'default' }, 'hub registration fee (no category)'],
  ['P-6', { category: 'advertising', attribution: { type: 'booking' } }, 'bookNow used as an advertising fee'],
  ['P-7', { isSubscription: true }, 'the existing subscription category'],
]) { r = dec(o); ck(id, r.action === 'skip_platform' && r.earner === null, 'PLATFORM REVENUE is never credited: ' + m, r); }
r = dec({ intentUnreadable: true, attribution: { sellerUid: 'seller1' } });
ck('U-1', r.action === 'withhold' && r.reason === 'intent_unreadable', 'an unreadable intent fails CLOSED (no credit, queued)', r);
r = dec({ category: 'pos_checkout' });
ck('U-2', r.action === 'withhold', 'a client-claimed "pos_checkout" category earns nothing on its own (client labels never make the payer an earner)', r);

/* ── B: the webhook is wired to the decision and has no payer fallback ── */
const IDX = read('functions/index.js');
const i = IDX.indexOf('const _netCents = Math.round(Math.max(0, amount - sokoniCut) * 100);');
const blk = IDX.slice(Math.max(0, i - 4000), i + 200);
ck('B-1', /walletCreditDecision\(\{/.test(blk) && /const _sellerId  = _decision\.earner;/.test(blk), 'webhookIntasend takes its earner ONLY from walletCreditDecision');
ck('B-2', !/attribution\.merchantUid \|\| payData\.uid/.test(IDX), 'the `… || payData.uid` earner fallback is gone');
ck('B-3', /commissionReviewQueue"\)\.doc\(`no_earner_\$\{apiRef\}`\)/.test(IDX) && /walletCreditSkipped: "platform_revenue"/.test(IDX), 'a withheld payment is queued for review (idempotent id); platform revenue is marked, not credited');

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
