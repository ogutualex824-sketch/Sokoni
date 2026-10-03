#!/usr/bin/env node
/* test-bnb-no-unpaid-confirmation.js — a BnB stay is never confirmed without a payment
 *
 *   node scripts/test-bnb-no-unpaid-confirmation.js
 *
 * Until a server-priced IntaSend purpose exists for stays, the booking flow must refuse honestly: no
 * _finalise() call (which writes status "confirmed", an invoice, a commission and a host message), no timer
 * that announces a payment, and no Daraja attempt. Each check is also run against a sabotaged copy.
 */
'use strict';
const fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'bnb.html'), 'utf8');
const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const CHECKS = [
  ['B1  nothing calls _finalise() (the writer of a "confirmed" booking)', (c) => !/_finalise\(/.test(c.replace(/async function _finalise\(/, ''))],
  ['B2  no timer announces a confirmed payment', (c) => !/setTimeout\([\s\S]{0,300}Payment confirmed/.test(c)],
  ['B3  no Daraja engine call', (c) => !/SokoniMpesa\.pay\(/.test(c)],
  ['B4  the buyer is told plainly that nothing was booked or charged', (c) => /Your booking was not made and you have not been charged\./.test(c)],
];
const SABOTAGE = {
  B1: (s) => s.replace('    return;\n  }\n', '    _finalise(null);\n    return;\n  }\n'),
  B2: (s) => s.replace('    return;\n  }\n', '    setTimeout(()=>{ st.innerHTML = "Payment confirmed!"; }, 4000);\n    return;\n  }\n'),
  B3: (s) => s.replace('    return;\n  }\n', '    SokoniMpesa.pay({});\n    return;\n  }\n'),
  B4: (s) => s.replace('Your booking was not made and you have not been charged.', 'Booked!'),
};

let pass = 0, fail = 0, caught = 0;
console.log('\nBNB — NO PAYMENT, NO CONFIRMATION\n');
for (const [label, fn] of CHECKS) { const ok = fn(strip(SRC)); console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label); ok ? pass++ : fail++; }
console.log('\n  [sabotage]');
for (const [label, fn] of CHECKS) {
  const k = label.split(' ')[0];
  const broken = SABOTAGE[k](SRC.split('\r\n').join('\n'));
  if (broken === SRC.split('\r\n').join('\n')) { console.log('  FAIL  ' + k + ' sabotage anchor missing'); fail++; continue; }
  const red = !fn(strip(broken));
  console.log('  ' + (red ? 'CAUGHT' : 'MISSED') + '  ' + k);
  red ? caught++ : fail++;
}
console.log('\n  ' + pass + ' passed, ' + fail + ' failed, ' + caught + '/' + CHECKS.length + ' sabotages caught\n');
process.exit(fail ? 1 : 0);
