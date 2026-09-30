'use strict';
/* C0 card quarantine, pos-checkout.html half (owner, 2026-09-30). test-0a-card-fabrication.js covers pos.js and
   pos-terminals.js; this covers the second till page, which finalised a card sale with no provider reference.
     node scripts/test-c0-pos-checkout-card.js              (this tree)
     BASE=<rev> node scripts/test-c0-pos-checkout-card.js   (baseline, e.g. BASE=72dca56 must FAIL C0-1/C0-2) */
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const src = process.env.BASE
  ? execSync('git show ' + process.env.BASE + ':pos-checkout.html', { encoding: 'utf8', maxBuffer: 64 << 20 })
  : fs.readFileSync(path.join(__dirname, '..', 'pos-checkout.html'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
let pass = 0, fail = 0;
const ck = (id, ok, m) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m); ok ? pass++ : fail++; };
console.log('\nC0 pos-checkout card quarantine   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
ck('C0-1', !/_finalize\(\s*['"]card['"]/.test(code), 'no card sale is finalised on the cashier\'s word (no _finalize(\'card\', …))');
const split = (code.match(/function confirmSplit\(\)\s*\{[\s\S]*?_finalize\('split'/) || [''])[0];
ck('C0-2', /some\(\s*m\s*=>\s*m\.method\s*===\s*'card'\s*\)[\s\S]*?return;/.test(split), 'a split carrying a card amount is refused before _finalize');
ck('C0-3', /Card unavailable — use M-Pesa or cash\./.test(code), 'the cashier is told what to use instead (same message as pos.js)');
ck('C0-4', /onclick="Checkout\.pay\('card'\)"/.test(src), 'the Card button stays visible (capability kept; C3 re-enables it via IntaSend)');
ck('C0-5', /if \(method === 'cash'\)/.test(code) && /if \(method === 'wallet'\)/.test(code), 'cash and wallet paths are untouched');
/* every classic inline script still parses */
const re = /<script(?![^>]*src=)([^>]*)>([\s\S]*?)<\/script>/g; let m, bad = 0, n = 0;
while ((m = re.exec(src))) { if (/type=["']module/.test(m[1]) || /application\/(ld\+)?json/.test(m[1])) continue; n++; try { new Function(m[2]); } catch (e) { bad++; } }
ck('C0-6', bad === 0, 'all ' + n + ' inline scripts parse');
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
