/* sokoni-pos-tender.js — the POS multi-tender engine.

   WHAT THESE PROVE

   The engine decides how much of a sale each payment method takes, and how
   much change the customer gets back. Every assertion here is about a NUMBER
   that moves money, not about whether a function returned something.

   The two rules that matter most, and both are tested in both directions:

     1. ONLY CASH GIVES CHANGE. An external rail cannot hand notes back, so it
        may never exceed the balance. Tested by refusal AND by the cash case
        succeeding, so a "refuses everything" regression cannot pass.
     2. THE TILL NEVER DECIDES A SALE IS PAID. An external tender leaves the
        sale awaiting server confirmation. Tested by asserting the field is
        populated, and by asserting a cash-only sale leaves it EMPTY — an
        inverting control, so a field that was always populated would fail.
*/
'use strict';
const path = require('path');
const T = require(path.join(__dirname, '..', 'sokoni-pos-tender.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 80) + ']' : ''));
  ok ? pass++ : fail++;
};

/* A till with cash, Till code, M-PESA and card enabled. */
const FULL = T.methodsFor({ enabled: ['M-PESA', 'CARD-PAYMENT'] });
const mk = (shillings, methods) => T.createSheet(T.fromShillings(shillings), methods || FULL);

console.log('\n── Money conversion happens once, at the boundary ──');
ck('4850 shillings -> 485000 cents', T.fromShillings(4850) === 485000, T.fromShillings(4850));
ck('2500.10 keeps its cents', T.fromShillings(2500.10) === 250010, T.fromShillings(2500.10));
ck('0.05 survives', T.fromShillings(0.05) === 5, T.fromShillings(0.05));
/* The bug this codebase shipped once: rounding BEFORE the multiply. */
ck('it is NOT round(x)*100', T.fromShillings(2500.10) !== 250000);
ck('garbage is 0, not NaN', T.fromShillings('abc') === 0);

console.log('\n── Capability: UNKNOWN is not AVAILABLE ──');
{
  const none = T.methodsFor(null);
  ck('no capability still gives cash', none.some((m) => m.id === 'cash'));
  ck('no capability still gives M-PESA Till', none.some((m) => m.id === 'mpesa_till'));
  ck('no capability gives NO card', !none.some((m) => m.id === 'card'));
  ck('no capability gives NO M-PESA STK', !none.some((m) => m.id === 'mpesa'));
  /* Inverting control: prove the list CAN grow, so the absences above are
     meaningful rather than the function always returning two items. */
  ck('an enabled card DOES appear', FULL.some((m) => m.id === 'card'));
  ck('an unrecognised code is skipped, not rendered raw',
     !T.methodsFor({ enabled: ['QUANTUM_PAY'] }).some((m) => m.id === 'QUANTUM_PAY'));
  ck('an empty enabled list is the same as none',
     T.methodsFor({ enabled: [] }).length === T.methodsFor(null).length);
}

console.log('\n── Auto-fill: the whole balance lands on the tapped method ──');
{
  let s = mk(4850);
  ck('a fresh sheet owes the full total', T.balanceCents(s) === 485000, T.balanceCents(s));
  const r = T.autoFill(s, 'cash');
  ck('auto-fill succeeds', r.ok, r.error);
  s = r.sheet;
  ck('cash now covers it', T.cashCents(s) === 485000, T.cashCents(s));
  ck('nothing is owed', T.balanceCents(s) === 0);
  ck('no change is due on an exact tender', T.changeDueCents(s) === 0);
  ck('the sale is settled', T.isSettled(s));
}

console.log('\n── Three tenders on one sale: cash + M-PESA + card ──');
{
  let s = mk(4850);
  s = T.allocate(s, 'cash',  T.fromShillings(1000)).sheet;
  ck('after 1000 cash, 3850 remains', T.balanceCents(s) === 385000, T.balanceCents(s));
  s = T.allocate(s, 'mpesa', T.fromShillings(2000)).sheet;
  ck('after 2000 M-PESA, 1850 remains', T.balanceCents(s) === 185000, T.balanceCents(s));
  const r = T.autoFill(s, 'card');
  ck('card auto-fills the remainder', r.ok, r.error);
  s = r.sheet;
  ck('card took exactly 1850', T.allocatedCents(s) - 300000 === 185000);
  ck('three tenders are recorded', s.allocations.length === 3, s.allocations.length);
  ck('the sale is settled', T.isSettled(s));
  ck('no change on an exact three-way split', T.changeDueCents(s) === 0);

  const out = T.toPayload(s);
  ck('the payload builds', out.ok, out.problems.join(' '));
  ck('primaryMethod is "mixed"', out.payload.primaryMethod === 'mixed', out.payload.primaryMethod);
  ck('tenders is an ARRAY of three', Array.isArray(out.payload.tenders) && out.payload.tenders.length === 3);
  ck('both external tenders await confirmation',
     out.payload.awaitingConfirmation.sort().join(',') === 'card,mpesa',
     out.payload.awaitingConfirmation.join(','));
}

console.log('\n── ONLY CASH GIVES CHANGE ──');
{
  let s = mk(150);
  const r = T.allocate(s, 'cash', T.fromShillings(1000));
  ck('cash MAY exceed the bill', r.ok, r.error);
  s = r.sheet;
  ck('change is 850', T.changeDueCents(s) === 85000, T.changeDueCents(s));
  ck('balance is 0, never negative', T.balanceCents(s) === 0);
  ck('settled', T.isSettled(s));
}
{
  const s = mk(150);
  const r = T.allocate(s, 'card', T.fromShillings(1000));
  ck('card may NOT exceed the bill', !r.ok, r.error);
  ck('the refusal explains why', /change/i.test(r.error || ''), r.error);
  ck('the sheet is unchanged by a refusal', s.allocations.length === 0);
}
{
  const r = T.allocate(mk(150), 'mpesa', T.fromShillings(1000));
  ck('M-PESA may NOT exceed the bill either', !r.ok);
  /* Inverting control: the same rail AT the bill must succeed, so the refusal
     above is about the ceiling and not about the method being blocked. */
  ck('M-PESA AT the bill is accepted', T.allocate(mk(150), 'mpesa', T.fromShillings(150)).ok);
}

console.log('\n── Editing a tender down and back up is not blocked by itself ──');
{
  let s = mk(1000);
  s = T.allocate(s, 'mpesa', T.fromShillings(1000)).sheet;
  ck('M-PESA holds the whole bill', T.balanceCents(s) === 0);
  const r = T.allocate(s, 'mpesa', T.fromShillings(400));
  ck('reducing it succeeds', r.ok, r.error);
  s = r.sheet;
  ck('600 is owed again', T.balanceCents(s) === 60000, T.balanceCents(s));
  const r2 = T.allocate(s, 'mpesa', T.fromShillings(1000));
  ck('raising it back to the full bill succeeds', r2.ok, r2.error);
}

console.log('\n── Allocation is SET, not ADD — a numpad cannot stack tenders ──');
{
  let s = mk(1000);
  s = T.allocate(s, 'cash', T.fromShillings(1)).sheet;
  s = T.allocate(s, 'cash', T.fromShillings(12)).sheet;
  s = T.allocate(s, 'cash', T.fromShillings(123)).sheet;
  ck('one cash tender, not three', s.allocations.length === 1, s.allocations.length);
  ck('it holds the LAST value', T.cashCents(s) === 12300, T.cashCents(s));
}

console.log('\n── Zero clears a tender rather than recording a zero ──');
{
  let s = mk(1000);
  s = T.allocate(s, 'cash', T.fromShillings(400)).sheet;
  s = T.allocate(s, 'cash', 0).sheet;
  ck('a zero allocation removes the tender', s.allocations.length === 0);
  ck('the full bill is owed again', T.balanceCents(s) === 100000);
}

console.log('\n── Refusals ──');
{
  ck('a negative amount is refused', !T.allocate(mk(1000), 'cash', -500).ok);
  ck('an unavailable method is refused',
     !T.allocate(mk(1000), 'card', 100, null, null).ok === false
       ? !T.allocate(T.createSheet(100000, T.methodsFor(null)), 'card', 100).ok
       : true);
  const r = T.allocate(T.createSheet(100000, T.methodsFor(null)), 'card', 100);
  ck('…and says the till does not offer it', !r.ok && /not available/i.test(r.error), r.error);
}

console.log('\n── M-PESA Till needs its confirmation code ──');
{
  let s = mk(500);
  s = T.autoFill(s, 'mpesa_till').sheet;
  let v = T.validate(s);
  ck('settled but NOT valid without a code', T.isSettled(s) && !v.ok, v.problems.join(' '));
  ck('the problem names the code', /code/i.test(v.problems.join(' ')));
  s = T.allocate(s, 'mpesa_till', T.fromShillings(500), { ref: 'SGH7X2K9QQ' }).sheet;
  v = T.validate(s);
  ck('valid once the code is present', v.ok, v.problems.join(' '));
  ck('the code reaches the payload', T.toPayload(s).payload.tenders[0].ref === 'SGH7X2K9QQ');
  ck('a recorded tender does NOT await our confirmation',
     T.toPayload(s).payload.awaitingConfirmation.length === 0);
}

console.log('\n── The till never decides a sale is PAID ──');
{
  let ext = mk(500);
  ext = T.autoFill(ext, 'mpesa').sheet;
  ck('an M-PESA sale awaits server confirmation',
     T.toPayload(ext).payload.awaitingConfirmation.join(',') === 'mpesa');
  ck('needsCustomerDevice is true', T.needsCustomerDevice(ext));

  /* INVERTING CONTROL — if awaitingConfirmation were always populated, the
     assertion above would pass for the wrong reason. */
  let csh = mk(500);
  csh = T.autoFill(csh, 'cash').sheet;
  ck('a CASH sale awaits nothing', T.toPayload(csh).payload.awaitingConfirmation.length === 0);
  ck('needsCustomerDevice is false for cash', !T.needsCustomerDevice(csh));
}

console.log('\n── An unsettled sale cannot produce a payload ──');
{
  let s = mk(4850);
  s = T.allocate(s, 'cash', T.fromShillings(1000)).sheet;
  const out = T.toPayload(s);
  ck('payload refused while 3850 is unallocated', !out.ok);
  ck('payload is null, not a partial object', out.payload === null);
  ck('the problem states the shortfall', /3,850/.test(out.problems.join(' ')), out.problems.join(' '));
}

console.log('\n── Awkward money: thirds of an odd bill leave no residue ──');
{
  let s = mk(100);                       /* 10000 cents */
  s = T.allocate(s, 'cash',  3333).sheet;
  s = T.allocate(s, 'mpesa', 3333).sheet;
  const r = T.autoFill(s, 'card');
  s = r.sheet;
  ck('auto-fill absorbs the residue exactly', T.balanceCents(s) === 0, T.balanceCents(s));
  ck('the third tender took 3334', T.allocatedCents(s) === 10000, T.allocatedCents(s));
  ck('no change is invented', T.changeDueCents(s) === 0);
}

console.log('\n── reset / remove ──');
{
  let s = mk(1000);
  s = T.allocate(s, 'cash', T.fromShillings(400)).sheet;
  s = T.allocate(s, 'mpesa', T.fromShillings(600)).sheet;
  ck('two tenders', s.allocations.length === 2);
  s = T.remove(s, 'mpesa');
  ck('remove drops one', s.allocations.length === 1);
  ck('balance reopens', T.balanceCents(s) === 60000);
  s = T.reset(s);
  ck('reset clears all', s.allocations.length === 0);
  ck('reset keeps the total', s.totalCents === 100000);
  ck('reset keeps the method list', s.methods.length === FULL.length);
}

console.log('\n── Purity: no DOM, no network, no clock ──');
{
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'sokoni-pos-tender.js'), 'utf8');
  /* Strip comments first — this file DISCUSSES the DOM at length, and a naive
     scan would read its own prose as a violation. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('no document.', !/\bdocument\./.test(code));
  ck('no fetch(', !/\bfetch\s*\(/.test(code));
  ck('no firebase', !/firebase/i.test(code));
  ck('no Date.now', !/Date\.now/.test(code));
  ck('no localStorage', !/localStorage/.test(code));
  /* Positive control: the stripper did not simply blank the file. */
  ck('…and the stripped source still contains real code',
     /function allocate/.test(code), code.length + ' chars');
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
