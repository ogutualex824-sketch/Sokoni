/* ══════════════════════════════════════════════════════════════════════════════
   DIGITAL PURCHASE IDEMPOTENCY — D1
   ══════════════════════════════════════════════════════════════════════════════
   purchaseDigitalProduct claimed its idempotency key by READING it outside the
   transaction and WRITING it inside — and the transaction never read it back.
   Two concurrent requests with the same key both found it absent, both
   committed, and `totalRevenue` was incremented twice for one purchase.

   audit-financial-safety did not catch this and STILL would not: its V3 rule
   uses a 7-line sliding window, and the read and write are 56 lines apart. That
   blind spot is the reason this file exists — without it a regression would be
   silent, and the green audit would say nothing.

   Run: node scripts/test-digital-purchase-idempotency.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);

console.log('\nDIGITAL PURCHASE IDEMPOTENCY (D1)');
console.log('='.repeat(74));

const src = fs.readFileSync(path.join(ROOT, 'functions/digital-hub.js'), 'utf8');

/* Isolate the function so a match elsewhere cannot stand in for it. */
const fn = (() => {
  const i = src.indexOf('exports.purchaseDigitalProduct');
  const j = src.indexOf('exports.getMyDigitalPurchases', i);
  return src.slice(i, j > i ? j : i + 6000);
})();

/* Comments stripped for any ORDERING claim. The explanatory comment above the
   function names t.create(idemRef) in prose, and matching that put the "claim"
   400 characters before the transaction that contains it — the assertion failed
   against correct code. A position test must read code, never commentary. */
const code = fn.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

head('1 - the claim is atomic');
ck('purchaseDigitalProduct is present to inspect', fn.length > 500, fn.length + ' chars');
ck('the idempotency key is claimed with create()', /t\.create\(idemRef/.test(code));
ck('REGRESSION: it is NOT claimed with set()', !/t\.set\(idemRef/.test(code),
   /t\.set\(idemRef/.test(code) ? 'the original defect is back' : 'gone');
ck('the claim happens INSIDE the transaction',
   code.indexOf('runTransaction') > -1 &&
   code.indexOf('t.create(idemRef') > code.indexOf('runTransaction'),
   'create at ' + code.indexOf('t.create(idemRef') + ', runTransaction at ' + code.indexOf('runTransaction'));

head('2 - a losing race is reported honestly');
ck('ALREADY_EXISTS is handled', /ALREADY_EXISTS/.test(code));
ck('...and the WINNER\'s purchaseId is returned, not this attempt\'s',
   /winner\.data\(\)\.purchaseId/.test(fn),
   'returning an uncommitted purchaseRef would be a dangling reference');
ck('any other error is rethrown', /throw e;/.test(code),
   'a real failure must never be reported as a successful replay');

head('3 - the revenue increment is inside the same transaction');
ck('totalRevenue is incremented in the transaction',
   /t\.update\([\s\S]{0,200}totalRevenue: FieldValue\.increment/.test(fn),
   'so a rejected claim takes the increment with it');

head('4 - NEGATIVE CONTROL: this suite can fail');
const mutant = code.replace('t.create(idemRef', 't.set(idemRef');
const detects = (s) => /t\.create\(idemRef/.test(s) && !/t\.set\(idemRef/.test(s);
ck('the detector PASSES on the fixed code', detects(code) === true);
ck('...and FAILS on the original defect', detects(mutant) === false,
   'a detector that cannot fail is not a detector');

head('5 - why this file exists');
un('a true concurrency race against the emulator',
   'static proof only; the transaction semantics are Firestore\'s, not ours');
console.log('  NOTE  audit-financial-safety CANNOT catch this defect — its V3 window');
console.log('        is 7 lines and the read/write pair is 56 apart. A green audit is');
console.log('        not evidence for this property; this suite is.');

console.log('\n' + '='.repeat(74));
console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
console.log('='.repeat(74) + '\n');
process.exit(fail ? 1 : 0);
