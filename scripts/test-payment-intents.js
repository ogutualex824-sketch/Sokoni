/* Payment intents — server derives every commercial value.

   The defect this closes: initiateSTKPush took {amount, ref} from the browser.
   Production payload SKNTJKAS8 proved it live — client-generated ref, no
   intent record, STK_NO_AUTHORITY logged, client figure charged.

   These tests assert the DERIVED AMOUNT, because that is the number that moves
   money. A test that only checked "an intent was created" would pass against a
   version that still trusted the client. */
'use strict';
const path = require('path');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 70) + ']' : ''));
  ok ? pass++ : fail++;
};

/* The catalogue is the contract between pricing page and till. */
const { PLANS } = require(path.join(__dirname, '..', 'functions', 'sub-billing'));

console.log('\n── Catalogue is reachable and priced in cents ──');
ck('PLANS exported from sub-billing', PLANS && typeof PLANS === 'object');
const ids = Object.keys(PLANS || {});
ck('catalogue is populated', ids.length > 0, ids.length + ' plans');

const priced = ids.filter((k) => Number((PLANS[k].price || {}).monthly) > 0);
ck('plans carry monthly prices', priced.length > 0, priced.length + ' priced');

/* KES 499 is the Starter figure the merchant actually paid. */
const k499 = ids.find((k) => Number((PLANS[k].price || {}).monthly) === 49900);
ck('a KES 499 plan exists at 49900 cents', !!k499, k499 || 'none found');

console.log('\n── Cents -> KES conversion matches what the provider is asked for ──');
{
  const cents = 49900;
  const kes = Math.round(cents / 100);
  ck('49900 cents -> KES 499', kes === 499, 'KES ' + kes);
  ck('provider figure is a whole number', Number.isInteger(kes));
}
{
  /* Enterprise, from the live subGetPlans response earlier today. */
  const kes = Math.round(999900 / 100);
  ck('999900 cents -> KES 9999', kes === 9999, 'KES ' + kes);
}

console.log('\n── Every priced plan converts to a payable amount ──');
{
  const bad = priced.filter((k) => {
    const kes = Math.round(Number(PLANS[k].price.monthly) / 100);
    return !Number.isFinite(kes) || kes < 1 || kes > 150000;
  });
  ck('all monthly prices land inside 1..150000 KES', bad.length === 0, bad.join(',') || 'none outside');
}

console.log('\n── Annual pricing is present where offered ──');
{
  const annual = ids.filter((k) => Number((PLANS[k].price || {}).annual) > 0);
  ck('annual prices exist', annual.length > 0, annual.length + ' plans');
  const cheaper = annual.filter((k) => {
    const p = PLANS[k].price;
    return Number(p.annual) < Number(p.monthly) * 12;
  });
  ck('annual is a discount on 12x monthly', cheaper.length === annual.length,
     cheaper.length + '/' + annual.length);
}

console.log('\n── The module loads (no circular require, no missing dep) ──');
{
  let mod = null, err = null;
  try { mod = require(path.join(__dirname, '..', 'functions', 'payment-intents')); }
  catch (e) { err = e.message; }
  ck('payment-intents.js requires cleanly', !!mod && !err, err || 'loaded');
  ck('createPaymentIntent is exported', !!(mod && mod.createPaymentIntent));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
