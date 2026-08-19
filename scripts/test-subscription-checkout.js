/* ══════════════════════════════════════════════════════════════════════════════
   SUBSCRIPTION CHECKOUT — certification
   ══════════════════════════════════════════════════════════════════════════════
   The discipline this suite enforces: NOTHING APPEARS USABLE UNLESS ITS BACKEND
   PATH IS WIRED. Airtel has no provider adapter, so it must render visible and
   unpressable — never as a button that takes a merchant's money nowhere.

   And: the screen may never declare a payment successful. created / pending /
   processing are shown as exactly what they are.

   Run: node scripts/test-subscription-checkout.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const C = require(path.join(ROOT, 'sokoni-subscription-checkout.js'));
/* Limits come from the CANONICAL catalogue, never a number typed here. A
   fixture with its own plan table is an eleventh catalogue, and it would also
   keep passing if the real allowance changed. */
const CAT = require(path.join(ROOT, 'functions/subscription-catalog.js'));
const STARTER_LIMIT = CAT.PLANS.STARTER.listingLimit;
const UNLIMITED = CAT.PLANS.GROWTH.listingLimit;

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);

console.log('\nSUBSCRIPTION CHECKOUT');
console.log('='.repeat(74));

/* Exactly what subscriptionPaymentMethods returns. */
const SERVER = [
  { id: 'SOKONI_WALLET', label: 'SOKONI Business Wallet', instant: true, balance: 1240, available: true, reason: null },
  { id: 'MPESA', label: 'M-PESA', instant: false, available: true, reason: null },
  { id: 'AIRTEL_MONEY', label: 'Airtel Money', instant: false, available: false, reason: 'provider-not-available' },
];

head('1 - the plan summary reads from the resolved entitlement');
const sum = C.planSummary({ label: 'Seller Basic', priceKES: 999, listingLimit: STARTER_LIMIT, billingCycle: 'monthly' });
ck('name and price', sum.name === 'Seller Basic' && sum.price === 'KES 999', sum.price);
ck('cycle label', sum.cycleLabel === 'per month');
ck('100 products', sum.products === STARTER_LIMIT + ' products', sum.products);
ck('unlimited renders as words, not -1',
   C.planSummary({ listingLimit: UNLIMITED }).products === 'Unlimited products');
ck('an unknown limit is OMITTED, not shown as 0',
   C.planSummary({}).products === null);
ck('capabilities are listed', sum.includes.length === 5 && sum.includes.every((i) => i.on));

head('2 - AIRTEL renders visible and UNPRESSABLE');
const m = C.methods(SERVER);
const airtel = m.filter((x) => x.id === 'AIRTEL_MONEY')[0];
ck('Airtel is still shown — the roadmap stays honest', !!airtel);
ck('...but is NOT selectable', airtel.selectable === false);
ck('...labelled Coming soon', airtel.hint === 'Coming soon');
ck('...with the way out named',
   /isn't available yet\. Choose SOKONI Wallet or M-PESA\./.test(airtel.disabledReason), airtel.disabledReason);
ck('NC the wired rails ARE selectable',
   m.filter((x) => x.id === 'SOKONI_WALLET')[0].selectable === true &&
   m.filter((x) => x.id === 'MPESA')[0].selectable === true);

head('3 - the wallet shows its balance, and never a false zero');
ck('balance is shown', m[0].detail === 'Balance: KES 1,240', m[0].detail);
const unknownBal = C.methods([{ id: 'SOKONI_WALLET', available: false, balance: null, reason: 'balance-unavailable' }]);
ck('an unreadable balance is a dash, NOT KES 0', unknownBal[0].detail === 'Balance: —', unknownBal[0].detail);
ck('...and the rail is not selectable while unknown', unknownBal[0].selectable === false);

head('4 - insufficient balance cannot reach a fake confirmation');
const poor = [
  { id: 'SOKONI_WALLET', balance: 120, available: false, reason: 'insufficient-balance' },
  { id: 'MPESA', available: true, reason: null },
  { id: 'AIRTEL_MONEY', available: false, reason: 'provider-not-available' },
];
const pw = C.payability(poor, 'SOKONI_WALLET');
ck('paying is refused', pw.ok === false && pw.reason === 'method-unavailable');
ck('...with the merchant told why AND what to do',
   /Insufficient wallet balance\. Add funds or choose M-PESA\./.test(pw.message), pw.message);
ck('the default rail skips the unaffordable wallet', C.defaultMethod(poor) === 'MPESA', C.defaultMethod(poor));
ck('NC with funds, the wallet IS the default', C.defaultMethod(SERVER) === 'SOKONI_WALLET');
ck('when NOTHING is usable, no method is preselected',
   C.defaultMethod([{ id: 'AIRTEL_MONEY', available: false, reason: 'provider-not-available' }]) === null);

head('5 - M-PESA needs a real number before the prompt is sent');
ck('no phone -> refused', C.payability(SERVER, 'MPESA').reason === 'phone-required');
ck('...with a plain instruction',
   /Enter the M-PESA number/.test(C.payability(SERVER, 'MPESA').message));
ck('a valid number allows payment', C.payability(SERVER, 'MPESA', '0712345678').ok === true);
ck('the wallet needs no phone', C.payability(SERVER, 'SOKONI_WALLET').ok === true);
[['0712345678', '254712345678'], ['0112345678', '254112345678'],
 ['+254712345678', '254712345678'], ['254712345678', '254712345678'],
 ['712345678', '254712345678'], ['0712 345 678', '254712345678']].forEach(([raw, want]) =>
  ck('normalises ' + raw, C.normalisePhone(raw) === want, String(C.normalisePhone(raw))));
[['0812345678'], ['07123456789'], ['abc'], [''], ['0712345'], [null]].forEach(([raw]) =>
  ck('rejects ' + JSON.stringify(raw), C.normalisePhone(raw) === null));
ck('an unselected method is refused before anything else',
   C.payability(SERVER, null).reason === 'choose-a-method');

head('6 - the screen NEVER declares a payment successful');
['created', 'stk_sent', 'pending', 'processing', 'paid'].forEach((s) =>
  ck(s + ' is not "done"', C.paymentView(s).done === false, C.paymentView(s).title));
ck('only ACTIVE is done', C.paymentView('active').done === true);
ck('an UNKNOWN status is reported as unknown, never as success',
   C.paymentView('something-new').done === false && /Checking/.test(C.paymentView('something-new').title));
ck('stk_sent tells the merchant to enter their PIN',
   /Enter your M-PESA PIN/.test(C.paymentView('stk_sent').body));
ck('a failure states nothing was charged',
   /Nothing was charged/.test(C.paymentView('failed').body));
ck('paid says ACTIVATING, not activated — activation is the server\'s to confirm',
   /Activating/.test(C.paymentView('paid').body) && C.paymentView('paid').done === false);

head('7 - Merchant v2 shows the resolved lifecycle, never a local guess');
const states = ['FREE', 'TRIALING', 'PENDING_PAYMENT', 'PROCESSING', 'ACTIVE',
                'GRACE', 'CANCEL_AT_PERIOD_END', 'EXPIRED', 'CANCELLED'];
states.forEach((s) => {
  const v = C.subscriptionView(s, { trialLine: '2 days remaining' });
  ck(s + ' has a sentence and an action', !!v.line && !!v.action && !!v.action.label,
     v.line + ' / ' + v.action.label);
});
ck('ACTIVE offers Manage subscription', C.subscriptionView('ACTIVE').action.id === 'manage');
ck('EXPIRED offers Renew plan', C.subscriptionView('EXPIRED').action.id === 'renew');
ck('PENDING_PAYMENT offers Check payment status',
   C.subscriptionView('PENDING_PAYMENT').action.id === 'check');
ck('TRIALING shows the countdown it was given',
   C.subscriptionView('TRIALING', { trialLine: '2 days remaining' }).line === '2 days remaining');
ck('an unknown state says so and offers a retry',
   C.subscriptionView('MADE_UP').state === 'UNKNOWN' && C.subscriptionView('MADE_UP').action.id === 'retry');
/* The lifecycle here must be the SERVER's, not a second list. */
const catalog = require(path.join(ROOT, 'functions/subscription-catalog.js'));
const missing = Object.keys(catalog.LIFECYCLE).filter((s) => !C.SUBSCRIPTION_VIEW[s]);
ck('every server lifecycle state has a merchant-facing view', missing.length === 0, missing.join(', ') || 'all covered');

head('8 - the server agrees that Airtel is unavailable');
const PAY_SRC = fs.readFileSync(path.join(ROOT, 'functions/subscription-pay-methods.js'), 'utf8');
ck('subscriptionPaymentMethods reports Airtel unavailable',
   /METHODS\.AIRTEL_MONEY, available: false, reason: 'provider-not-available'/.test(PAY_SRC));
ck('...and M-PESA available', /METHODS\.MPESA, available: true/.test(PAY_SRC));
ck('this module computes no price of its own',
   !/\* *0\.\d|priceKES *=|amount *=/.test(fs.readFileSync(path.join(ROOT, 'sokoni-subscription-checkout.js'), 'utf8')
     .replace(/\/\*[\s\S]*?\*\//g, '')));

head('9 - what is NOT built');
un('the checkout screen itself', 'this is the presentation logic; no HTML surface yet');
un('a real M-PESA production purchase', 'not attempted');
un('the Airtel provider adapter', 'declared unavailable until one exists');

console.log('\n' + '='.repeat(74));
console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
console.log('='.repeat(74) + '\n');
process.exit(fail ? 1 : 0);
