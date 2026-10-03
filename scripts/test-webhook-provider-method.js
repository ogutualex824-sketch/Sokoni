#!/usr/bin/env node
/* RECEIPTS (2f request, 2026-10-03) — webhookIntasend records the payment METHOD IntaSend reports, raw, never guessed.
 *   node scripts/test-webhook-provider-method.js        BASE=e6ce50a node scripts/test-webhook-provider-method.js (must FAIL)
 * Part A EVALUATES the handler's own providerMethod expression (extracted from webhookIntasend and run in a vm) on every
 * payload shape. Part B checks, by source, that the value is written on the claim AND the review park, mirrored to the
 * intent merge-only, and that the legacy intasendWebhook is untouched. The handler run itself is LAYER B of
 * test-p0-payment-integrity (memory-gated: UNPROVEN below 512 MB). */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f, rev) => ((rev || process.env.BASE) ? execSync('git show ' + (rev || process.env.BASE) + ':' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }) : fs.readFileSync(path.join(ROOT, f), 'utf8'));
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 200) + ']')); ok ? pass++ : fail++; };
console.log('\nwebhookIntasend provider method   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
const IDX = read('functions/index.js').replace(/\r\n/g, '\n');
const at = IDX.indexOf('exports.webhookIntasend = onRequest(');
const WH = at < 0 ? '' : IDX.slice(at);
const legacyEnd = at < 0 ? IDX.length : at;
const LEGACY = IDX.slice(IDX.indexOf('exports.intasendWebhook = onRequest('), legacyEnd);

/* A: the expression itself */
const m = WH.match(/const providerMethod = (\(\(\) => \{[\s\S]*?\n {4}\}\)\(\));/);
const evalFor = (body) => { if (!m) return '__absent__'; const invoice = (body && body.invoice) || {}; return vm.runInNewContext(m[1], { invoice, req: { body }, String }); };
ck('A-0', !!m, 'webhookIntasend computes providerMethod');
ck('A-1', evalFor({ provider: 'M-PESA', state: 'COMPLETE' }) === 'M-PESA', 'the documented top-level `provider` (M-PESA) is recorded as sent');
ck('A-2', evalFor({ provider: 'CARD-PAYMENT' }) === 'CARD-PAYMENT' && evalFor({ provider: 'APPLE-PAY' }) === 'APPLE-PAY', 'card / Apple Pay are recorded raw (no mapping to "M-PESA")');
ck('A-3', evalFor({ invoice: { provider: 'PESALINK' }, provider: 'M-PESA' }) === 'PESALINK', 'a nested invoice.provider (the handler\'s fallback shape) wins, consistent with every other invoice field');
ck('A-4', evalFor({ state: 'COMPLETE' }) === null && evalFor({ provider: null }) === null && evalFor({ provider: '   ' }) === null, 'ABSENT IS NULL — never a guessed default');
const longV = evalFor({ provider: 'X'.repeat(500) });
ck('A-5', typeof longV === 'string' && longV.length === 40, 'capped at 40 characters', longV && longV.length);
ck('A-6', evalFor({ provider: 'M-PESA\u0000\n<script>' }) === 'M-PESA<script>', 'control characters stripped (the value is data for receipts, escaped where rendered)');
ck('A-7', evalFor({ provider: 42 }) === '42', 'a non-string is stringified, never dropped silently');

/* B: wiring */
const claim = WH.slice(WH.indexOf('let claimed = false;'), WH.indexOf('if (!claimed)'));
ck('B-1', /txn\.update\(payRef, \{[\s\S]*?providerMethod,/.test(claim), 'the COMPLETE/PENDING/FAILED claim writes payments/{ref}.providerMethod in the same transaction');
const park = WH.slice(WH.indexOf('const _park = async'), WH.indexOf('let _gSnap'));
ck('B-2', /status:\s+"REVIEW"[\s\S]*providerMethod,/.test(park), 'a payment parked for REVIEW keeps its method too (the reviewer sees what was used)');
ck('B-3', /collection\("paymentIntents"\)\.doc\(String\(existing\.intentRef\)\)\.set\(\{ providerMethod \}, \{ merge: true \}\)/.test(WH) && /if \(providerMethod && existing\.intentRef\)/.test(WH),
  'mirrored to the intent MERGE-ONLY (never its status) and only when a method was reported');
ck('B-4', !/providerMethod/.test(LEGACY), 'the legacy intasendWebhook (own P0-4 gate) is untouched');
ck('B-5', !/providerMethod\s*[=:]\s*["']M-PESA["']/.test(WH), 'nothing in the handler defaults the method to "M-PESA"');

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
