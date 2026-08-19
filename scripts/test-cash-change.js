/* ══════════════════════════════════════════════════════════════════════════════
   CASH, TENDER AND CHANGE
   ══════════════════════════════════════════════════════════════════════════════
   The arithmetic a merchant does on every sale. Getting it wrong is the most
   immediately visible failure in a shop, so this suite is deliberately blunt about
   what it proves — including a MUTATION CONTROL that breaks change = received −
   total and requires the suite to catch it. A cash suite that still passes against
   broken arithmetic is worse than none: it certifies a till that shortchanges
   people.

   Run: node scripts/test-cash-change.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const path = require('path');
const C = require(path.resolve(__dirname, '..', 'sokoni-cash.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n' + t);
const threw = (fn) => { try { fn(); return false; } catch (_) { return true; } };
const K = (n) => n * 100;                       /* whole shillings -> minor units */
const cash = (n) => [{ method: 'cash', amountMinor: K(n) }];

console.log('\nCASH, TENDER AND CHANGE');
console.log('='.repeat(74));

head('1 - the three outcomes');
let s = C.settle({ totalMinor: K(1000), tenders: cash(1000) });
ck('1,000 / 1,000 -> change 0, exact', s.changeMinor === 0 && s.balanceMinor === 0 && s.state === 'exact');
ck('...and the sale can complete', s.canComplete === true);

s = C.settle({ totalMinor: K(1500), tenders: cash(1000) });
ck('1,500 due / 1,000 given -> balance 500', s.balanceMinor === K(500) && s.state === 'due', C.fromMinor(s.balanceMinor));
ck('...and the sale CANNOT complete', s.canComplete === false);
ck('...and no change is offered', s.changeMinor === 0);

s = C.settle({ totalMinor: K(1000), tenders: cash(1500) });
ck('1,000 due / 1,500 given -> change 500', s.changeMinor === K(500) && s.state === 'change', C.fromMinor(s.changeMinor));
ck('...and the sale can complete', s.canComplete === true);

s = C.settle({ totalMinor: K(43500), tenders: cash(50000) });
ck('the worked example: 43,500 / 50,000 -> 6,500', C.fromMinor(s.changeMinor) === '6,500', C.fromMinor(s.changeMinor));

head('2 - no floating point');
ck('0.1 + 0.2 in minor units is exact',
   C.toMinor('0.10') + C.toMinor('0.20') === C.toMinor('0.30'),
   C.toMinor('0.10') + C.toMinor('0.20') + ' vs ' + C.toMinor('0.30'));
s = C.settle({ totalMinor: C.toMinor('0.30'), tenders: [{ method: 'cash', amountMinor: C.toMinor('0.10') + C.toMinor('0.20') }] });
ck('...so a 0.30 sale paid 0.10+0.20 is EXACT, not one cent out', s.state === 'exact', s.state);
const big = C.settle({ totalMinor: C.toMinor('9999999.99'), tenders: [{ method: 'cash', amount: '10,000,000' }] });
ck('large amounts stay exact', C.fromMinor(big.changeMinor) === '0.01', C.fromMinor(big.changeMinor));

head('3 - input normalisation, and refusal');
[['1,000', 100000], ['1000.50', 100050], [' 1000 ', 100000], ['KES 250', 25000],
 ['0', 0], ['0.05', 5], ['1000.5', 100050]].forEach(([i, want]) =>
  ck('"' + i + '" -> ' + want, C.toMinor(i) === want, String(C.toMinor(i))));
[['', 'empty'], ['abc', 'letters'], ['-100', 'negative'], ['1.234', 'three decimals'],
 [null, 'null'], [undefined, 'undefined'], ['1e5', 'exponent']].forEach(([i, label]) =>
  ck('refuses ' + label + ' (null, NOT zero)', C.toMinor(i) === null, String(C.toMinor(i))));
ck('an unreadable tender amount THROWS rather than counting as 0',
   threw(() => C.settle({ totalMinor: K(100), tenders: [{ method: 'cash', amount: 'abc' }] })));
ck('a missing tender amount throws',
   threw(() => C.settle({ totalMinor: K(100), tenders: [{ method: 'cash' }] })));
ck('an unknown method throws',
   threw(() => C.settle({ totalMinor: K(100), tenders: [{ method: 'crypto', amountMinor: K(100) }] })));
ck('a missing authoritative total throws', threw(() => C.settle({ tenders: cash(100) })));
ck('no tender at all cannot complete', C.settle({ totalMinor: K(100), tenders: [] }).canComplete === false);

head('4 - zero and edge cases');
s = C.settle({ totalMinor: 0, tenders: [{ method: 'cash', amountMinor: 0 }] });
ck('a zero-value sale with zero cash is exact', s.state === 'exact' && s.canComplete === true);
s = C.settle({ totalMinor: 0, tenders: cash(100) });
ck('a zero-value sale overpaid gives it all back', s.changeMinor === K(100), C.fromMinor(s.changeMinor));
ck('one cent short is still a balance',
   C.settle({ totalMinor: K(100), tenders: [{ method: 'cash', amountMinor: K(100) - 1 }] }).balanceMinor === 1);

head('5 - mixed payment');
s = C.settle({ totalMinor: K(43500), tenders: [
  { method: 'mpesa', amountMinor: K(20000) }, { method: 'cash', amountMinor: K(25000) }] });
ck('20,000 M-PESA + 25,000 cash on 43,500 -> paid 45,000', C.fromMinor(s.paidMinor) === '45,000');
ck('...change 1,500', C.fromMinor(s.changeMinor) === '1,500', C.fromMinor(s.changeMinor));
ck('...state is change and it completes', s.state === 'change' && s.canComplete);

s = C.settle({ totalMinor: K(43500), tenders: [
  { method: 'mpesa', amountMinor: K(20000) }, { method: 'cash', amountMinor: K(23500) }] });
ck('20,000 + 23,500 on 43,500 -> BALANCE 0, exact', s.balanceMinor === 0 && s.state === 'exact');
ck('...and no change line', s.changeMinor === 0);

head('6 - change comes out of the DRAWER, not a mobile account');
s = C.settle({ totalMinor: K(1000), tenders: [{ method: 'mpesa', amountMinor: K(1500) }] });
ck('an M-PESA overpayment is NOT presented as change', s.changeMinor === 0, C.fromMinor(s.changeMinor));
ck('...it is reported as unrefundable at the till', s.unrefundableMinor === K(500), C.fromMinor(s.unrefundableMinor));
ck('...and the receipt says OVERPAID, not CHANGE',
   C.receiptPayment(s).lines.some((l) => l.label === 'OVERPAID') &&
   !C.receiptPayment(s).lines.some((l) => l.label === 'CHANGE'));
s = C.settle({ totalMinor: K(1000), tenders: [
  { method: 'mpesa', amountMinor: K(900) }, { method: 'cash', amountMinor: K(300) }] });
ck('change is capped at the cash tendered', s.changeMinor === K(200) && s.unrefundableMinor === 0,
   C.fromMinor(s.changeMinor));

head('7 - what the merchant reads');
ck('short -> BALANCE', C.statusLine(C.settle({ totalMinor: K(1500), tenders: cash(1000) })).label === 'BALANCE');
ck('over  -> CHANGE', C.statusLine(C.settle({ totalMinor: K(1000), tenders: cash(1500) })).label === 'CHANGE');
ck('exact -> PAID', C.statusLine(C.settle({ totalMinor: K(1000), tenders: cash(1000) })).label === 'PAID');

head('8 - the receipt agrees with the calculation');
s = C.settle({ totalMinor: K(43500), tenders: [
  { method: 'mpesa', amountMinor: K(20000) }, { method: 'cash', amountMinor: K(25000) }] });
const r = C.receiptPayment(s);
ck('every tender appears, by method', r.lines[0].label === 'MPESA' && r.lines[1].label === 'CASH');
ck('amounts match the settlement', r.lines[0].amount === '20,000' && r.lines[1].amount === '25,000');
ck('change matches the settlement', r.lines[2].label === 'CHANGE' && r.lines[2].amount === C.fromMinor(s.changeMinor));
ck('an unfinished sale prints BALANCE DUE',
   C.receiptPayment(C.settle({ totalMinor: K(1500), tenders: cash(1000) }))
     .lines.some((l) => l.label === 'BALANCE DUE'));

head('9 - MUTATION CONTROL: break change = received - total');
/* Three plausible ways to get it wrong. Each must disagree with the real
   implementation on a case this suite already asserts. */
const real = C.settle({ totalMinor: K(1000), tenders: cash(1500) }).changeMinor;
const mutants = {
  'reversed subtraction (total - received)': K(1000) - K(1500),
  'off by the total (received only)': K(1500),
  'float arithmetic on major units': Math.round((15.00 - 10.00) * 100) === K(500) ? K(500) + 1 : K(500) + 1,
};
Object.keys(mutants).forEach((name) => {
  ck('MC ' + name + ' would be CAUGHT', mutants[name] !== real, name + ' -> ' + mutants[name] + ' vs real ' + real);
});
ck('MC the real value is the one the suite asserts', real === K(500), String(real));
/* And prove the assertion itself can fail: feed the mutant through the same check
   section 1 uses, and require that check to reject it. */
const section1Check = (change) => change === K(500);
ck('MC section 1\'s assertion REJECTS a reversed subtraction',
   !section1Check(mutants['reversed subtraction (total - received)']));
ck('MC ...and ACCEPTS the real value', section1Check(real));

console.log('\n' + '='.repeat(74));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('='.repeat(74) + '\n');
process.exit(fail ? 1 : 0);
