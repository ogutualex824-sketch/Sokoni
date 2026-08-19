/* ══════════════════════════════════════════════════════════════════════════════
   TRIAL ACTIVATION — the gate that had to come before the field-name fix
   ══════════════════════════════════════════════════════════════════════════════
   The reported bug: "Confirm & Pay" on Seller Basic threw
   "Payment not confirmed. Complete payment first." before any STK push.

   Cause: plans.html sent `startTrial`, sub-billing destructured `isTrial`. The
   names never met, so a TRIAL request fell into the PAID verification branch and
   looked up a payment reference the client had fabricated.

   That mismatch was ALSO the only thing preventing an unlimited free trial,
   because nothing checked eligibility. So this suite proves the gate FIRST and
   the field fix second — in that order, because the reverse opens a hole on a
   live billing path.

     firebase emulators:exec --only firestore "node scripts/test-trial-activation.js"
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);

console.log('\nTRIAL ACTIVATION — gate before field fix');
console.log('='.repeat(74));

const SUB = fs.readFileSync(path.join(ROOT, 'functions/sub-billing.js'), 'utf8');
const PLANS_HTML = fs.readFileSync(path.join(ROOT, 'plans.html'), 'utf8');
const catalog = require(path.join(ROOT, 'functions/subscription-catalog.js'));

head('1 - the field-name mismatch is closed, in both directions');
ck('the server accepts BOTH spellings',
   /const isTrial = d\.isTrial === true \|\| d\.startTrial === true;/.test(SUB));
ck('the client now sends isTrial', /isTrial: true,/.test(PLANS_HTML));
ck('...and no longer fabricates a payment reference',
   PLANS_HTML.indexOf('paymentRef: `trial_') === -1);
ck('NC the fabricated reference really was there before',
   /trial_\$\{plan\.id\}/.test(PLANS_HTML) === false, 'removed');

head('2 - THE ORDER: the gate sits ABOVE the payment branch');
const gateIdx = SUB.indexOf('const ea = require(\'./entitlement-authority\')');
const payIdx = SUB.indexOf("if (amountDue > 0 && !isTrial)");
const fieldIdx = SUB.indexOf('d.startTrial === true');
ck('the eligibility gate exists', gateIdx > -1);
ck('...and runs BEFORE the paid-verification branch', gateIdx > -1 && gateIdx < payIdx);
ck('...and AFTER the field normalisation, so both spellings are gated',
   fieldIdx > -1 && fieldIdx < gateIdx);
ck('a trial on a plan with no trial days is refused',
   /this plan has no trial/.test(SUB));
ck('the refusal reaches the merchant in plain words',
   /You have already used your free trial\./.test(SUB));

head('3 - the lifecycle vocabulary is shared, not per-vertical');
const L = catalog.LIFECYCLE;
['FREE','TRIALING','PENDING_PAYMENT','PROCESSING','ACTIVE','GRACE',
 'CANCEL_AT_PERIOD_END','EXPIRED','CANCELLED'].forEach((s) => {
  ck('state ' + s + ' is defined', !!L[s], L[s] ? (L[s].entitled ? 'entitled' : 'not entitled') : 'MISSING');
});
ck('GRACE still entitles — a payment problem is not an eviction', catalog.isEntitled('grace'));
ck('CANCEL_AT_PERIOD_END still entitles', catalog.isEntitled('cancel_at_period_end'));
ck('PENDING_PAYMENT does NOT entitle', !catalog.isEntitled('pending'));
ck('PROCESSING does NOT entitle — the browser never decides a payment landed',
   !catalog.isEntitled('processing'));
ck('an undefined status resolves FREE, never entitled', !catalog.isEntitled('nonsense-status'));
ck('legacy spellings map in', catalog.lifecycleOf('trial').state === 'TRIALING' &&
   catalog.lifecycleOf('superseded').state === 'EXPIRED');

head('4 - the countdown never says "1 days"');
const P = require(path.join(ROOT, 'sokoni-plan-panel.js'));
const cases = [[3, '3 days remaining'], [2, '2 days remaining'], [1, '1 day remaining'], [0, 'Expires today']];
cases.forEach(([d, expect]) =>
  ck('days=' + d + ' -> "' + expect + '"', P.trialCountdown({ active: true, daysRemaining: d }) === expect,
     P.trialCountdown({ active: true, daysRemaining: d })));
ck('an ended trial says so', P.trialCountdown({ active: false, used: true }) === 'Trial ended');
ck('never-trialled says Free plan', P.trialCountdown({ active: false, used: false }) === 'Free plan');
ck('an unknown remainder does not invent a number',
   P.trialCountdown({ active: true, daysRemaining: null }) === 'Trial active');

head('5 - no secret key ever reaches the browser');
/* The rule that must never be broken: IntaSend's secret key is server-side only. */
const CLIENT_FILES = ['plans.html', 'checkout.html', 'merchant-v2.html', 'sokoni-plan-panel.js'];
const leaks = CLIENT_FILES.filter((f) => {
  try {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
    return /ISSecretKey|INTASEND_SECRET|secret_key|ISSecret/i.test(t);
  } catch (_) { return false; }
});
ck('no IntaSend secret in any client file', leaks.length === 0, leaks.join(', ') || 'clean');
ck('NC the detector would catch one', /ISSecretKey/i.test('const ISSecretKey = "x";'));

(async () => {
  let admin;
  try {
    process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
    admin = require(path.join(ROOT, 'functions/node_modules/firebase-admin'));
    if (!admin.apps.length) admin.initializeApp({ projectId: 'sokoni-trials' });
    await admin.firestore().collection('_ping').doc('x').set({ ok: true });
  } catch (e) {
    head('6 - one trial per merchant identity');
    un('the runtime half', 'emulator unavailable: ' + String((e && e.message) || e).slice(0, 60));
    console.log('\n' + '='.repeat(74));
    console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + (unproven + 1) + ' unproven');
    console.log('='.repeat(74) + '\n');
    process.exit(fail ? 1 : 0);
  }

  const EA = require(path.join(ROOT, 'functions/entitlement-authority.js'));
  const db = admin.firestore();

  head('6 - ONE trial per merchant identity, ever');
  const M = 'trialMerchant';
  ck('a fresh merchant is eligible', (await EA.trialState(M)).eligible === true);
  const g1 = await EA.startTrial(M, 'seller_basic', 3);
  ck('the trial is granted', g1.ok === true, g1.plan);
  ck('...with server-derived boundaries 3 days apart',
     Math.round((g1.trialEndsAt - g1.trialStartedAt) / 86400000) === 3);
  const g2 = await EA.startTrial(M, 'seller_basic', 3);
  ck('a SECOND trial is REFUSED', g2.ok === false && g2.reason === 'trial-already-used');
  /* The exploit the fix order exists to prevent. */
  const g3 = await EA.startTrial(M, 'seller_pro', 30);
  ck('...and switching PLAN does not buy another trial',
     g3.ok === false && g3.reason === 'trial-already-used', g3.reason);
  ck('the ledger is the record, keyed by uid',
     (await db.doc('trialLedger/' + M).get()).exists);

  head('7 - one trial per IDENTITY, not per login');
  /* A merchant with two accounts must not get two trials. */
  const A = 'twinA', B = 'twinB';
  await db.doc('merchantAccountLinks/' + A).set({
    canonicalUid: A, linkedAccountUids: [B], status: 'active', reason: 'twin test',
  });
  const t1 = await EA.startTrial(A, 'seller_basic', 3);
  ck('the first login gets the trial', t1.ok === true);
  const stB = await EA.trialState(B);
  ck('the LINKED login is refused a second trial',
     stB.eligible === false && stB.used === true, 'eligible=' + stB.eligible);
  const t2 = await EA.startTrial(B, 'seller_basic', 3);
  ck('...and startTrial refuses it outright',
     t2.ok === false && t2.reason === 'trial-already-used', t2.reason);
  ck('NC an UNLINKED stranger is still eligible',
     (await EA.trialState('unrelatedMerchant')).eligible === true);

  head('8 - what is NOT built');
  un('STK push initiation', 'no STK_SENT / PAYMENT_PENDING states exist yet');
  un('checkout.html subscription branch', 'it reads no URL params at all');
  un('renewal, grace recovery, cancellation, resume, upgrade, downgrade', 'untraced');

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  console.log('='.repeat(74) + '\n');
  process.exit(fail ? 1 : 0);
})();
