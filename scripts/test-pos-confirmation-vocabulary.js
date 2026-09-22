/* posCompleteCheckout — non-cash confirmation now delegates to the certified
   authority (Amendment A.1.5).

   WHAT THIS SLICE ACTUALLY IS

   My first attempt patched the predicate inline: `completed` -> `paid`, and
   dropped `mpesa_daraja`. That was a DUPLICATE of a module that already
   existed — `functions/shared/pos-payment-ownership.js`, certified by
   scripts/certify-pos-payment-ownership.js, whose W7-1..W7-4 assert exactly
   the wiring this file now tests. The baseline run of that certification is
   what caught it.

   The inline patch also left a second defect in place, which the module names
   and I had not seen: the ownership check was guarded
   `if (pay.sellerUid && …)`, and a QR document carries `sellerId`, NOT
   `sellerUid` — so the condition was false and THE WHOLE SHOP CHECK WAS
   SKIPPED. Any shop could confirm against another shop's payment.

   So the contract under test is delegation, not a predicate:

     assertConfirmable decides rail, ownership and status.
     posCompleteCheckout decides sufficiency, because only it knows the sale.

   Source-contract assertions, comment-stripped: this file discusses the old
   vocabulary at length and a naive scan would read its own prose as the code.
*/
'use strict';
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..');
const FN = path.join(root, 'functions');
const src = fs.readFileSync(path.join(FN, 'pos-zero-friction.js'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 74) + ']' : ''));
  ok ? pass++ : fail++;
};

const gateStart = code.indexOf('const CONFIRMABLE');
const gateEnd   = code.indexOf('posPaymentClaims');
const gate = gateStart > -1 && gateEnd > gateStart ? code.slice(gateStart, gateEnd) : '';

console.log('\n── The decision is DELEGATED, not re-implemented ──');
ck('the gate block was located', gate.length > 200, gate.length + ' chars');
ck('it requires the certified module',
   /require\('\.\/shared\/pos-payment-ownership'\)/.test(gate));
ck('…and calls assertConfirmable', /assertConfirmable\(pay, \{ merchantId, cashierId \}\)/.test(gate));
ck('a refusal stops the sale', /if \(!_confirm\.ok\)/.test(gate));

console.log('\n── The two inline defects are GONE ──');
ck("no inline 'completed' status check", !/pay\.status !== 'completed'/.test(gate));
ck('no inline vanishing-ownership guard',
   !/if \(pay\.sellerUid && pay\.sellerUid !== merchantId/.test(gate));
ck('no inline status predicate of any spelling', !/pay\.status !== /.test(gate));
ck('mpesa_daraja is not confirmable', !/mpesa_daraja/.test(gate));
ck('…and appears nowhere in the module', !/mpesa_daraja/.test(code));
/* Inverting controls: the list still confirms, the gate still refuses. */
ck('mpesa and card remain confirmable', /mpesa: 1/.test(gate) && /card: 1/.test(gate));
ck('cash remains exempt', !/cash: 1/.test(gate));

console.log('\n── Sufficiency stays with the caller, on the GATEWAY figure ──');
ck('the amount comes from the module', /Number\(_confirm\.amount\)/.test(gate));
ck('…not re-read from the document', !/pay\.paidAmount != null \? pay\.paidAmount/.test(gate));
ck('the sufficiency refusal survives', /is claiming/.test(gate));

console.log('\n── Error codes are preserved across the delegation ──');
ck('wrong shop -> permission-denied', /wrong_shop' \? 'permission-denied'/.test(gate));
ck('no document -> not-found', /no_document' \? 'not-found'/.test(gate));
ck('everything else -> failed-precondition', /'failed-precondition'/.test(gate));

console.log('\n── Single-spend and idempotency untouched ──');
ck('posPaymentClaims atomic create', /claimRef\.create\(/.test(code));
ck('…same sale may retry', /prior\.idempotencyKey !== idempotencyKey/.test(code));
ck('posIdempotency cached replay', /status === 'complete'\) return \{ saleId: prev\.saleId/.test(code));
ck('_consumed release on refusal', /_consumed/.test(code));

console.log('\n── The certified module behaves as the caller assumes ──');
{
  const M = require(path.join(FN, 'shared', 'pos-payment-ownership.js'));
  const QR   = (o) => Object.assign({ transactionId: 't1', sellerId: 'shop1', status: 'paid', total: 100 }, o);
  const ACT  = { merchantId: 'shop1', cashierId: 'cash1' };

  ck('a paid QR payment for this shop is confirmable', M.assertConfirmable(QR(), ACT).ok === true);
  ck("status 'completed' on a QR doc is REFUSED",
     M.assertConfirmable(QR({ status: 'completed' }), ACT).reason === 'not_paid');
  ck('a legacy DARAJA document is refused outright',
     M.assertConfirmable({ checkoutId: 'c1', status: 'completed', sellerUid: 'shop1' }, ACT).reason
       === 'legacy_daraja_document');
  ck('…even though it reads completed (the old gate would have taken it)',
     M.assertConfirmable({ checkoutId: 'c1', status: 'completed', sellerUid: 'shop1' }, ACT).ok === false);
  ck('another shop is refused', M.assertConfirmable(QR({ sellerId: 'shop2' }), ACT).reason === 'wrong_shop');
  ck('an unidentifiable owner is REFUSED, not skipped',
     M.assertConfirmable(QR({ sellerId: null }), ACT).reason === 'no_owner');
  ck('pending is refused', M.assertConfirmable(QR({ status: 'pending' }), ACT).reason === 'not_paid');
  ck('expired is refused', M.assertConfirmable(QR({ status: 'expired' }), ACT).reason === 'not_paid');
  ck('cancelled is refused', M.assertConfirmable(QR({ status: 'cancelled' }), ACT).reason === 'not_paid');
  ck('an unknown shape is refused', M.assertConfirmable({ status: 'paid' }, ACT).reason === 'unknown_shape');
  ck('a null document is refused', M.assertConfirmable(null, ACT).reason === 'no_document');
  ck('ownership is checked BEFORE status (no state leak to a stranger)',
     M.assertConfirmable(QR({ sellerId: 'shop2', status: 'pending' }), ACT).reason === 'wrong_shop');
  ck('the cashier uid also owns', M.assertConfirmable(QR({ sellerId: 'cash1' }), ACT).ok === true);
  ck('it never throws on garbage', (() => {
    try { M.assertConfirmable('nonsense', ACT); M.assertConfirmable(QR(), null); return true; }
    catch (_) { return false; }
  })());
}

console.log('\n── Scope: the authority is used, not re-implemented ──');
{
  /* This was a `git diff HEAD --name-only` check and it went vacuous the
     moment the slice committed — the SIXTH time that pattern has failed in
     this workstream, and the second time in a file that already carried a
     warning about it. Diff-based assertions are not durable here. Full stop.

     The durable property is structural: this module CONSUMES the authority
     and contains no copy of its logic. That stays true after any commit. */
  const mod = fs.readFileSync(path.join(FN, 'shared', 'pos-payment-ownership.js'), 'utf8');
  const modCode = mod.replace(/\/\*[\s\S]*?\*\//g, '');

  ck('the authority still owns rail classification', /function classifyRail/.test(modCode));
  ck('…and ownership resolution', /function ownerOf/.test(modCode));
  ck('…and the paid-state constant', /QR_PAID = 'paid'/.test(modCode));
  /* The consumer must hold none of it. */
  ck('the consumer re-implements no rail classification', !/classifyRail|checkoutId.*transactionId/.test(gate));
  ck('…no ownership resolution', !/sellerId \|\| pay\.sellerUid/.test(gate));
  ck('…and no paid-state literal of its own', !/'paid'/.test(gate));
  /* Positive control: the consumer does reference the authority, so the
     absences above are about delegation and not about an empty scan. */
  ck('…while it DOES call into the authority', /assertConfirmable\(/.test(gate));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
console.log('  NOT asserted (needs a live till + IntaSend): an end-to-end QR');
console.log('  payment confirming through /pos. Verify before deploy.\n');
process.exit(fail ? 1 : 0);
