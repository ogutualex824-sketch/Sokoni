'use strict';
/* Payment-method surfaces show IntaSend's methods with real logos; only what the SOKONI IntaSend account has proven is
   usable (owner, 2026-09-30; invoices show only M-PESA COMPLETE). Covers checkout.html, pay.html and payments.html.
     node scripts/test-payment-methods-intasend.js              (this tree)
     BASE=<rev> node scripts/test-payment-methods-intasend.js   (baseline; live 72dca56 must FAIL the change rows) */
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }) : fs.readFileSync(path.join(ROOT, f), 'utf8');
const has = (f) => { try { process.env.BASE ? execSync('git cat-file -e ' + process.env.BASE + ':' + decodeURIComponent(f), { cwd: ROOT, stdio: 'ignore' }) : fs.accessSync(path.join(ROOT, decodeURIComponent(f))); return true; } catch (_) { return false; } };
const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [' + String(got).slice(0, 150) + ']')); ok ? pass++ : fail++; };
const NOT_INTASEND = /Airtel|T-Kash|Equity|MTN|EcoCash|Chipper|PayPal|RTGS|Pesapal|Flutterwave/;
console.log('\nIntaSend payment methods   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');

/* checkout.html */
const co = strip(read('checkout.html'));
const coBlock = (co.match(/<div class="payment-methods">([\s\S]*?)<!-- Fulfillment|<div class="payment-methods">([\s\S]*?)Fulfillment/) || [])[0] || co.slice(co.indexOf('<div class="payment-methods">'), co.indexOf('Fulfillment: Pickup'));
const tiles = [...coBlock.matchAll(/<div class="pay-method-card([^"]*)" id="([^"]+)" onclick="selectPayment\('([a-z]+)'\)"/g)].map((m) => ({ cls: m[1], id: m[2], m: m[3] }));
ck('CO-1', !NOT_INTASEND.test(coBlock), 'checkout lists no method IntaSend does not provide (Airtel, T-Kash, Equity, MTN, EcoCash, Chipper, PayPal, Bank RTGS)', (coBlock.match(NOT_INTASEND) || [])[0]);
ck('CO-2', ['mpesa', 'card', 'pesalink', 'googlepay', 'applepay', 'bitcoin'].every((m) => tiles.some((t) => t.m === m)), 'checkout shows M-Pesa, Card, PesaLink, Google Pay, Apple Pay, Bitcoin', tiles.map((t) => t.m).join(','));
const usable = tiles.filter((t) => !/pay-soon/.test(t.cls)).map((t) => t.m);
ck('CO-3', usable.length === 1 && usable[0] === 'mpesa', 'only M-Pesa is usable; the rest are marked Soon', usable.join(','));
const unint = ((co.match(/const UNINTEGRATED_PAYMENTS = \[([^\]]*)\]/) || [])[1] || '');
ck('CO-4', ['card', 'pesalink', 'googlepay', 'applepay', 'bitcoin', 'paypal', 'bank'].every((m) => unint.includes('"' + m + '"')) && !unint.includes('"mpesa"'), 'selectPayment() refuses every non-proven method (incl. legacy paypal/bank)', unint);
const imgs = [...coBlock.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]);
ck('CO-5', imgs.length >= 7 && imgs.every(has), 'every checkout method tile uses a real logo file that exists', imgs.filter((i) => !has(i)).join(','));

/* pay.html */
const pay = read('pay.html');
ck('PY-1', !/Â/.test(pay), 'pay.html has no mojibake ("Visa Â· Mastercard")');
ck('PY-2', /pay-method-icon mpesa"[^>]*><img src="assets\/mpesa\.PNG"/.test(pay) && /pay-method-icon card"[^>]*><img src="assets\/visa\.PNG"/.test(pay), 'pay.html method icons are real logos, not emoji circles');
ck('PY-3', /const CARD_LIVE = false;/.test(pay) && /if \(!CARD_LIVE\) \{ btn\.disabled = true; return; \}/.test(pay) && /id="btnPayCard"[^>]*disabled/.test(pay), 'pay.html card cannot start the non-existent checkout (button disabled, payCard refuses)');

/* payments.html */
const pm = strip(read('payments.html'));
const grid = (pm.match(/<div class="pmt-provider-grid">([\s\S]*?)<div class="pmt-info">/) || [])[1] || '';
ck('PM-1', /id="prov-intasend" onclick="wizChooseProvider\('intasend'\)"/.test(grid) && !/coming-soon[^>]*>\s*<div class="pmt-provider-logo">[^<]*<\/div>\s*<div class="pmt-provider-name">IntaSend/.test(grid), 'IntaSend is the active provider (not "Coming Soon")');
ck('PM-2', !/wizChooseProvider\('mpesa'\)/.test(grid) && /Retired/.test(grid), 'M-Pesa Direct (Daraja) is marked retired and cannot be chosen');
ck('PM-3', !/Pesapal|Flutterwave/.test(grid), 'Pesapal / Flutterwave (not SOKONI providers) removed');
const pmImgs = [...grid.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]);
ck('PM-4', pmImgs.length >= 8 && pmImgs.every(has), 'provider grid uses real logo files that exist (' + pmImgs.length + ')', pmImgs.filter((i) => !has(i)).join(','));
ck('PM-5', !/_goToStep\(3\)/.test((pm.match(/function wizChooseProvider[\s\S]*?\n\}/) || [''])[0]), 'choosing a provider never leads into the retired Daraja credential steps');

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
