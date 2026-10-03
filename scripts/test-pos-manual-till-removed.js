#!/usr/bin/env node
/* Manual M-PESA Till payment — REMOVED (owner 2026-10-03).
 *
 * The till used to let the cashier type the customer's M-PESA confirmation code and record the sale as paid with no
 * confirmation from Safaricom or IntaSend. Owner ruling: a typed code is not a payment; the till takes cash or a
 * confirmed M-PESA / card payment. This replaces test-pos-manual-till-payment.js, which asserted the feature existed.
 *
 *   node scripts/test-pos-manual-till-removed.js          BASE=72dca56 node scripts/test-pos-manual-till-removed.js (must FAIL)
 */
'use strict';
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }) : fs.readFileSync(path.join(ROOT, f), 'utf8');
const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
let pass = 0, fail = 0;
const ck = (id, ok, m) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m); ok ? pass++ : fail++; };
console.log('\nManual Till removed   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
const H = strip(read('pos.html')), J = strip(read('pos.js'));
ck('MT-1', !/data-method="mpesa_till"/.test(H) && !/SPos\.payment\.setMethod\('mpesa_till'\)/.test(H), 'the till has no "M-PESA Till" payment button');
ck('MT-2', !/id="mpesa-till-modal"/.test(H) && !/SPos\.mpesaTill\./.test(H), 'the code-entry screen is gone');
ck('MT-3', !/method:\s*'mpesa_till_manual'/.test(J), 'pos.js can no longer complete a sale as mpesa_till_manual');
ck('MT-4', !/const mpesaTill = \{/.test(J) && !/\bmpesaTill,/.test(J), 'the mpesaTill controller and its SPos export are gone');
ck('MT-5', /if \(method === 'mpesa_till' \|\| method === 'mpesa_till_manual'\) \{\s*toast\('Manual M-PESA Till codes are no longer accepted/.test(J),
  'a till still holding the old method (cached state) is told plainly — it does not fall through to another tender');
ck('MT-6', !/paymentAttestedBy: 'operator'/.test(J), 'no sale is recorded as operator-attested any more');
const P = read('sokoni-pos-print-service.js');
ck('MT-7', /mpesa_till_manual:'M-Pesa Till'/.test(P), 'CONTROL: receipts for PAST manual-Till sales still print their real method');
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
