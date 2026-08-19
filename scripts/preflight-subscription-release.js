/* ══════════════════════════════════════════════════════════════════════════════
   SUBSCRIPTION RELEASE — PREFLIGHT
   ══════════════════════════════════════════════════════════════════════════════
   The money-path release is ONE atomic feature set. This refuses to call it
   ready unless every part of it is present, because a partial deploy has a
   specific and expensive failure:

     hosting only  -> the browser mints intents and takes payments against the
                      OLD webhook, which still activates subscriptions directly
                      and never stamps an intent PAID. The merchant pays, the
                      screen waits forever, and two authorities are live at once.

     functions only -> safe. The old checkout keeps working; the new surface is
                      simply not reachable yet. This is why functions go first.

   READ ONLY. It deploys nothing and writes nothing. It reads the repo, the
   exports and the suites, and prints a verdict.

     node scripts/preflight-subscription-release.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);

console.log('\nSUBSCRIPTION RELEASE — PREFLIGHT (read only)');
console.log('='.repeat(74));

const index = fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');

/* ── THE ATOMIC SET ─────────────────────────────────────────────────────────
   Every callable and trigger that must ship together. A name missing here is a
   name that will not deploy; a name here that is not exported is a deploy that
   half-lands. */
const FUNCTIONS = [
  ['createPaymentIntent',            'mints the server-priced intent'],
  ['subscriptionPaymentMethods',     'which rails this merchant can use'],
  ['payIntentWithWallet',            'the wallet rail'],
  ['onPaymentIntentPaid',            'fires activation when any rail stamps PAID'],
  ['reconcileSubscriptionPayment',   'the retry / poll path'],
  ['initiateSTKPush',                'the M-PESA rail'],
  ['intasendWebhook',                'stamps the intent PAID'],
  ['webhookIntasend',                'stamps the intent PAID'],
  ['subActivate',                    'trial activation, now gated'],
  ['subGetPlans',                    'the catalogue the UI lists'],
  ['getMerchantEntitlements',        'the entitlement authority'],
  ['onSubscriptionChangedSyncLimit', 'ceiling follows the subscription'],
  ['onAiSubscriptionChangedSyncLimit', 'ceiling follows the AI store too'],
  ['merchantIdentity',               'who the shop is / who is serving'],
  ['adminLinkMerchantAccounts',      'the auditable account link'],
];

head('1 - every function in the atomic set is exported by name');
/* A literal `exports.NAME =` is not the only way a function ships: index.js
   spreads product-limit with Object.assign. So this RESOLVES the deployed
   surface by loading it, and falls back to the text only if that fails. My
   first version used the regex alone and reported two functions missing that
   were in fact exported — a false alarm is as costly here as a miss. */
let SURFACE = null;
try { SURFACE = require(path.join(ROOT, 'functions/index.js')); }
catch (e) { console.log('    (could not load functions/index.js: ' + String(e.message).slice(0, 60) + ')'); }
FUNCTIONS.forEach(function (f) {
  const name = f[0];
  const live = SURFACE ? typeof SURFACE[name] !== 'undefined' : false;
  const text = new RegExp('exports\\.' + name + '\\s*=').test(index);
  ck(name, live || text, f[1] + (live ? '' : ' [text-only]'));
});

head('2 - the client files that must ship WITH them');
const CLIENT = [
  ['plans.html',                       'subscription-checkout.html?planId='],
  ['subscription-checkout.html',       'payIntentWithWallet'],
  ['sokoni-subscription-checkout.js',  'SokoniSubscriptionCheckout'],
  ['sokoni-plan-panel.js',             'SokoniPlanPanel'],
];
CLIENT.forEach(function (c) {
  let ok = false, why = 'missing';
  try { ok = fs.readFileSync(path.join(ROOT, c[0]), 'utf8').indexOf(c[1]) > -1; why = ok ? 'ok' : 'marker absent'; }
  catch (_) { ok = false; }
  ck(c[0], ok, why);
});

head('3 - HOSTING-ONLY IS THE DANGEROUS ORDER');
/* Stated as a check so the reason travels with the release, not just in a doc. */
ck('the checkout surface calls functions that must already exist',
   fs.readFileSync(path.join(ROOT, 'subscription-checkout.html'), 'utf8').indexOf('payIntentWithWallet') > -1);
ck('...so hosting must NEVER go first', true, 'functions first, then hosting');
ck('plans.html no longer routes to the dead-end checkout',
   fs.readFileSync(path.join(ROOT, 'plans.html'), 'utf8').indexOf('checkout.html?type=subscription') === -1);

head('4 - no rival activation authority survives');
ck('no webhook activates a subscription directly',
   (index.match(/subData\.paymentRef !== apiRef/g) || []).length === 0,
   String((index.match(/subData\.paymentRef !== apiRef/g) || []).length) + ' rival guards');
ck('both webhooks stamp the intent instead',
   (index.match(/intent stamped PAID/g) || []).length === 2);

head('5 - no secret reaches the browser');
const LEAKY = ['plans.html', 'subscription-checkout.html', 'sokoni-subscription-checkout.js'];
const leaks = LEAKY.filter(function (f) {
  try { return /ISSecretKey|INTASEND_SECRET|secret_key/i.test(fs.readFileSync(path.join(ROOT, f), 'utf8')); }
  catch (_) { return false; }
});
ck('no IntaSend secret in any shipped client file', leaks.length === 0, leaks.join(', ') || 'clean');

head('6 - everything parses');
['functions/index.js', 'functions/subscription-pay-methods.js', 'functions/entitlement-authority.js',
 'functions/merchant-identity.js', 'functions/subscription-catalog.js', 'functions/sub-billing.js',
 'functions/product-limit.js', 'sokoni-subscription-checkout.js', 'sokoni-plan-panel.js'].forEach(function (f) {
  let ok = true;
  try { execSync('node --check "' + path.join(ROOT, f) + '"', { stdio: 'pipe' }); }
  catch (_) { ok = false; }
  ck(f, ok);
});

head('7 - the frozen wallet backend is untouched');
let dirty = '';
try { dirty = execSync('git status --porcelain functions/wallet.js', { cwd: ROOT }).toString().trim(); } catch (_) {}
ck('functions/wallet.js is clean against HEAD', dirty === '', dirty || 'clean');

head('8 - the deploy order, stated');
console.log('    1  firebase deploy --only functions   (ALL of the set above)');
console.log('    2  verify production                  scripts/verify-subscription-production.js');
console.log('    3  firebase deploy --only hosting');
console.log('    4  the real Seller Basic purchase, on a TEST merchant — not KASS');

head('9 - what this preflight cannot tell you');
un('that the functions deploy will succeed', 'quota, IAM and orphan-function aborts are runtime facts');
un('that production behaves as the emulator did', 'only the live verification answers that');
un('that a real STK prompt arrives', 'needs a real handset and a real payment');

console.log('\n' + '='.repeat(74));
console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
console.log('  ' + (fail === 0 ? 'READY to deploy functions-first, on your authorisation.'
                               : 'NOT READY — the set is incomplete.'));
console.log('='.repeat(74) + '\n');
process.exit(fail ? 1 : 0);
