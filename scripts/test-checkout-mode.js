#!/usr/bin/env node
/* Shop checkout mode — the projection that decides where a customer's money goes.
 *
 * The mapping is EXECUTED, not matched against source text. A source assertion
 * would still pass if the branches were swapped, and swapping them would route a
 * customer onto a self-attested rail at a shop with an observable one.
 *
 *   node scripts/test-checkout-mode.js
 */
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};
const ROOT  = path.join(__dirname, '..');
const read  = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SRC = strip(read('functions', 'checkout-mode.js'));

/* The pure projection is required directly — no firebase-admin needed for it. */
const { modeFromDestination, MODE } = (function () {
  const m = { exports: {} };
  /* Evaluate only the pure function, so the suite does not need an initialised app. */
  const body = read('functions', 'checkout-mode.js');
  const fnSrc = body.slice(body.indexOf('const MODE = {'), body.indexOf('async function resolveMode'));
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', fnSrc + '\nmodule.exports = { modeFromDestination, MODE };')(m, m.exports);
  return m.exports;
})();

/* ══ A. The mapping, executed ══════════════════════════════════════════════ */
console.log('\nA. resolveActiveDestination → checkout mode\n');
{
  ck('null destination → unavailable',
     modeFromDestination(null).mode === MODE.UNAVAILABLE);
  ck('  ...with a reason', modeFromDestination(null).reason === 'no_verified_destination');

  /* manual_payment is GATED to unavailable until its production order lifecycle
     (createManualTillOrder + attestManualTillPayment) is deployed and certified.
     A shop with no authorised STK rail must not be offered a self-attested "pay
     the Till directly" route the backend cannot yet record. */
  const blocked = { blocked: 'production_not_authorized', destination: { destinationType: 'TILL' } };
  ck('production_not_authorized → UNAVAILABLE (manual_payment GATED, not payable)',
     modeFromDestination(blocked).mode === MODE.UNAVAILABLE);
  ck('  ...with reason manual_payment_unavailable',
     modeFromDestination(blocked).reason === 'manual_payment_unavailable');

  const open = { blocked: null, destination: { destinationType: 'TILL' } };
  ck('blocked:null → DARAJA STK', modeFromDestination(open).mode === MODE.STK);

  /* An unrecognised block must never fall through to a payable mode. */
  const weird = { blocked: 'some_future_reason', destination: {} };
  ck('an UNKNOWN block → unavailable, never payable',
     modeFromDestination(weird).mode === MODE.UNAVAILABLE, modeFromDestination(weird).mode);
  ck('  ...and carries the reason through', modeFromDestination(weird).reason === 'some_future_reason');

  /* Gate invariant: while manual is gated, NO input may yield a manual mode. */
  ck('GATE invariant: modeFromDestination never yields manual_payment',
     [null, blocked, open, weird].every((d) => modeFromDestination(d).mode !== MODE.MANUAL));

  ck('negative control: the three modes are distinct',
     new Set([MODE.STK, MODE.MANUAL, MODE.UNAVAILABLE]).size === 3);
}

/* ══ B. The customer cannot choose ═════════════════════════════════════════ */
console.log('\nB. Mode is a shop capability, not a preference\n');
{
  ck('no caller-supplied mode is accepted',
     !/data\.mode|request\.data\.checkoutPaymentMode/.test(SRC));
  ck('mode is derived from resolveActiveDestination only',
     /resolveActiveDestination\(sellerUid\)/.test(SRC));
  ck('no second mode field is stored anywhere', !/set\([^)]*checkoutPaymentMode/.test(SRC));
  ck('an STK shop is never offered manual payment',
     /if \(dest\.blocked === 'production_not_authorized'\)/.test(SRC) &&
     !/mode === MODE\.STK[\s\S]{0,120}?MANUAL/.test(SRC));
}

/* ══ C. Exposure ═══════════════════════════════════════════════════════════ */
console.log('\nC. What is returned to the customer\n');
{
  ck('STK/unavailable return NO destination details',
     /if \(m\.mode !== MODE\.MANUAL\)[\s\S]{0,200}?destination: null/.test(SRC));
  ck('manual returns the number the customer must pay', /number:\s+d\.destinationNumber/.test(SRC));
  ck('  ...and the PayBill account reference', /accountReference: d\.destinationType === 'PAYBILL'/.test(SRC));
  ck('  ...null for a TILL, not an empty string', /\? \(d\.accountReference \?\? null\) : null/.test(SRC));
  ck('no credentials are ever returned',
     !/consumerKey|consumerSecret|passKey|passkey/i.test(SRC));
}

/* ══ D. Failure is never optimistic ════════════════════════════════════════ */
console.log('\nD. A failed lookup is not payable\n');
{
  ck('a per-shop lookup failure yields UNAVAILABLE',
     /catch\(\(\) => \(\{[\s\S]{0,140}?mode: MODE\.UNAVAILABLE, reason: 'lookup_failed'/.test(SRC));
  ck('  ...never a guessed payable mode', !/catch[\s\S]{0,140}?MODE\.(STK|MANUAL)/.test(SRC));
  ck('auth is required', /throw new HttpsError\('unauthenticated'/.test(SRC));
  ck('a batch is bounded', /list\.length > 20/.test(SRC));
  ck('duplicate shops are de-duplicated', /new Set\(list\.map/.test(SRC));
}

/* ══ E. Wiring ═════════════════════════════════════════════════════════════ */
console.log('\nE. Wiring\n');
{
  const IDX = strip(read('functions', 'index.js'));
  ck('re-exported by name from index.js',
     /exports\.getShopCheckoutMode\s*=\s*checkoutMode\.getShopCheckoutMode/.test(IDX));
  ck('no new collection is created', !/collection\(/.test(SRC));
  ck('the cart can partition a basket to feed it',
     /groupBySeller/.test(read('sokoni-cart.js')));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
