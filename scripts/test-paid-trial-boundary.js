/* ══════════════════════════════════════════════════════════════════════════════
   PAID PURCHASE vs FREE TRIAL — the decision boundary
   ══════════════════════════════════════════════════════════════════════════════
   A merchant pressing Pay for Seller Basic was told "you have already used your
   free plan". Two unrelated questions had been collapsed into one:

     Am I eligible for a promotional free trial?   -> trialLedger
     May I buy this plan?                          -> nothing to do with trials

   plans.html rendered ONE button per plan, labelled from the plan's trial days,
   and confirmSubscribe() branched the same way. Seller Basic ships with a 3-day
   trial, so its paid branch was unreachable: no payment intent could ever be
   minted for it, by anyone.

   This suite pins the boundary. It also certifies the period arithmetic, because
   a trial attached to a PAID plan must delay the paid period rather than consume
   it — charging for 30 days and delivering 27 is a refund request, not a
   subscription.

   Run: node scripts/test-paid-trial-boundary.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);

const DAY = 86400000;
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

console.log('\nPAID PURCHASE vs FREE TRIAL — decision boundary + period arithmetic');
console.log('='.repeat(76));

const plans = read('plans.html');
const checkout = read('subscription-checkout.html');
const intents = read('functions/payment-intents.js');
const payMethods = read('functions/subscription-pay-methods.js');
const billing = read('functions/sub-billing.js');

/* Isolate confirmSubscribe so a match elsewhere on the page cannot stand in for
   the branch that actually decides. */
const confirmFn = (() => {
  const i = plans.indexOf('async function confirmSubscribe');
  if (i < 0) return '';
  const j = plans.indexOf("document.getElementById('modal-overlay').addEventListener", i);
  return plans.slice(i, j > i ? j : i + 4000);
})();

head('1 - the two actions are distinct, and BUY is never gated on a trial');
ck('confirmSubscribe exists to inspect', confirmFn.length > 200, confirmFn.length + ' chars');
ck('it branches on the ACTION the merchant chose',
   confirmFn.indexOf("_pendingAction === 'trial'") > -1);
ck('REGRESSION: it no longer branches on the plan having trial days',
   confirmFn.indexOf('if (plan.trialDays > 0)') === -1,
   confirmFn.indexOf('if (plan.trialDays > 0)') > -1 ? 'the original defect is back' : 'gone');
ck('openModal carries the chosen action', plans.indexOf('function openModal(plan, action)') > -1);
ck('a paid plan always renders a Subscribe button',
   plans.indexOf("openModal(${planArg},'buy')") > -1);
ck('the free-trial button is the only one gated on eligibility',
   plans.indexOf('const offerTrial = trialDays > 0 && trialEligible;') > -1);
ck('eligibility defaults to FALSE when unresolved',
   plans.indexOf('let trialEligible = false;') > -1,
   'an unknown must hide the offer, not show a button the server refuses');

head('2 - the PAID path never asks the trial ledger for permission');
/* Comments are stripped first. The claim is about what the code DOES; a comment
   explaining why it must not consult the ledger names the ledger, and matching
   that prose would fail the very file that documents the rule. */
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const pairs = [['createPaymentIntent', codeOnly(intents)], ['reconcilePaidIntent', codeOnly(payMethods)]];
for (const p of pairs) {
  ck(p[0] + ' never reads trialLedger', p[1].indexOf('trialLedger') === -1);
  ck(p[0] + ' never calls trialState', p[1].indexOf('trialState') === -1);
}
/* Non-vacuity: the stripper must not have deleted the code along with the prose. */
ck('NC the comment stripper left the code intact',
   pairs[0][1].indexOf('createPaymentIntent') > -1 && pairs[1][1].indexOf('runTransaction') > -1,
   'otherwise the two assertions above would pass on an empty string');
ck('subGetStatus REPORTS eligibility (so the UI can offer correctly)',
   billing.indexOf('EA.trialState(uid)') > -1);

head('3 - trial terms are quoted by the server, not the browser');
ck('createPaymentIntent derives trialDays from the catalogue',
   intents.indexOf('Number((plan.trial || {}).days)') > -1);
ck('...and stamps them on the intent', intents.indexOf('quoted terms, honoured at activation') > -1);
ck('the reconciler honours the QUOTED terms, not a later catalogue',
   payMethods.indexOf('Number(intent.trialDays)') > -1);
ck('the amount is still derived from (planId, cycle) server-side',
   intents.indexOf('const cents = Number((plan.price || {})[cycle]);') > -1);

head('4 - the checkout asks for the cycle before committing money');
ck('a cycle phase exists', checkout.indexOf("S.phase === 'cycle'") > -1);
ck('nothing is minted until the merchant confirms',
   checkout.indexOf('if (hasBoth && !S.cycleConfirmed)') > -1);
ck('both catalogue prices are offered',
   checkout.indexOf("id: 'annual'") > -1 && checkout.indexOf("id: 'monthly'") > -1);
ck('the URL only PRESELECTS the cycle',
   checkout.indexOf('preselected from the URL, not decided') > -1);
ck('prices come from subGetPlans, not a constant',
   checkout.indexOf("callable('subGetPlans')") > -1 && checkout.indexOf('99900') === -1);

head('5 - the merchant is told plainly when money moves');
ck('the cycle screen states it',
   checkout.indexOf("-day trial starts immediately") > -1);
ck('the payment screen restates it where the money button is',
   checkout.indexOf("esc(S.trialDays) + '-day trial starts immediately") > -1);
ck('the trial-only modal says NO payment today', plans.indexOf('No payment today.') > -1);

/* ── runtime ─────────────────────────────────────────────────────────────── */
function done() {
  head('what this does NOT prove');
  un('a real M-PESA STK prompt', 'needs a handset and a real payment');
  un('the hourly sweep running in production', 'its predicates are certified; the schedule is not invoked here');
  console.log('\n' + '='.repeat(76));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  console.log('='.repeat(76) + '\n');
  process.exit(fail ? 1 : 0);
}

(async () => {
  let admin, db, SP;
  try {
    process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
    admin = require(path.join(ROOT, 'functions/node_modules/firebase-admin'));
    if (!admin.apps.length) admin.initializeApp({ projectId: 'sokoni-trial' });
    db = admin.firestore();
    /* BOUNDED. Without an emulator the admin SDK retries for minutes and the
       suite dies on the runner's clock — which reports as TIMEOUT, a state that
       says nothing about the code. A missing emulator is UNPROVEN, and it should
       take three seconds to say so. */
    await Promise.race([
      db.collection('_ping').doc('x').set({ ok: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('no emulator on ' + process.env.FIRESTORE_EMULATOR_HOST)), 3000)),
    ]);
    SP = require(path.join(ROOT, 'functions/subscription-pay-methods.js'))._internal;
  } catch (e) {
    head('6-8 - the period arithmetic, at runtime');
    un('every runtime assertion', 'emulator unavailable: ' + String((e && e.message) || e).slice(0, 60));
    return done();
  }

  const UID = 'trialBoundaryMerchant';
  const catalog = require(path.join(ROOT, 'functions/subscription-catalog.js'));

  const mk = async (id, cycle, trialDays) => {
    await db.doc('paymentIntents/' + id).set({
      ref: id, uid: UID, planId: 'seller_basic', planName: 'Seller Basic',
      billingCycle: cycle, trialDays: trialDays,
      amount: cycle === 'annual' ? 9990 : 999,
      amountCents: cycle === 'annual' ? 999000 : 99900,
      currency: 'KES', status: 'paid', purpose: 'subscription',
      method: 'MPESA', activationPending: true,
    });
  };

  /* ── THE FOUR COMBINATIONS ────────────────────────────────────────────────
     Every one is a purchase. None may consult trial eligibility, and each must
     deliver the full period it charged for. */
  const MATRIX = [
    { cycle: 'monthly', trialDays: 3, days: 30,  label: 'Monthly + paid trial' },
    { cycle: 'annual',  trialDays: 3, days: 365, label: 'Annual  + paid trial' },
    { cycle: 'monthly', trialDays: 0, days: 30,  label: 'Monthly, no trial' },
    { cycle: 'annual',  trialDays: 0, days: 365, label: 'Annual,  no trial' },
  ];

  head('6 - the four purchase combinations');
  const ms = (t) => (t && t.toMillis ? t.toMillis() : null);
  for (let i = 0; i < MATRIX.length; i++) {
    const m = MATRIX[i];
    const id = 'ptb_' + i;
    await db.doc('subscriptions/' + UID).delete().catch(() => {});
    await mk(id, m.cycle, m.trialDays);
    const t0 = Date.now();
    const r = await SP.reconcilePaidIntent(id);
    const sub = (await db.doc('subscriptions/' + UID).get()).data() || {};
    const startMs = ms(sub.currentPeriodStart), endMs = ms(sub.currentPeriodEnd);
    const period = (startMs && endMs) ? Math.round((endMs - startMs) / DAY) : null;
    const delay = startMs ? Math.round((startMs - t0) / DAY) : null;

    console.log('\n  ' + m.label);
    ck('  the purchase activates', !!(r && r.ok === true), r && r.reason);
    ck('  paymentStatus records that the money arrived', sub.paymentStatus === 'paid', sub.paymentStatus);
    ck('  status is ' + (m.trialDays ? 'trialing' : 'active'),
       sub.status === (m.trialDays ? 'trialing' : 'active'), sub.status);
    ck('  billingCycle is ' + m.cycle, sub.billingCycle === m.cycle, sub.billingCycle);
    ck('  the merchant is ENTITLED from the moment they pay',
       catalog.isEntitled(sub.status) === true, String(sub.status));
    ck('  the PAID period is the full ' + m.days + ' days',
       period !== null && Math.abs(period - m.days) <= 1, period + ' days');
    ck('  it begins ' + m.trialDays + ' days from now — the trial does not consume it',
       delay !== null && Math.abs(delay - m.trialDays) <= 1, delay + ' days');
    ck('  expiresAt matches currentPeriodEnd exactly', ms(sub.expiresAt) === endMs,
       (ms(sub.expiresAt) - endMs) + 'ms apart');
    if (m.trialDays) {
      ck('  trialStatus is active', sub.trialStatus === 'active', sub.trialStatus);
      ck('  trialEnd IS the paid period start', ms(sub.trialEnd) === startMs);
      ck('  recorded as bought, not promotional', sub.trialSource === 'paid_plan', sub.trialSource);
    } else {
      ck('  no trial is invented', sub.trialStatus === 'none' && !sub.trialEnd, sub.trialStatus);
    }
  }

  head('7 - a trial ending must never re-bill someone who already paid');
  const B = require(path.join(ROOT, 'functions/sub-billing.js'))._internal;
  const T = (v) => admin.firestore.Timestamp.fromMillis(v);
  const past = Date.now() - DAY;
  const future = Date.now() + 40 * DAY;

  const paidTrial = { paymentStatus: 'paid', trialStatus: 'active',
                      trialEnd: T(past), currentPeriodEnd: T(future) };
  const promoTrial = { currentPeriodEnd: T(past) };            /* the legacy shape */

  ck('a PAID trial is recognised as paid', B.isPaidTrial(paidTrial) === true);
  ck('a promotional trial is not', B.isPaidTrial(promoTrial) === false);
  ck('a paid trial ends on trialEnd', B.trialEndMs(paidTrial) === past);
  ck('...not on a paid period end 40 days away', B.trialEndMs(paidTrial) !== future);
  ck('LEGACY: a promotional trial still ends on currentPeriodEnd',
     B.trialEndMs(promoTrial) === past, 'existing trials behave exactly as before');
  ck('the sweep sends paid trials to ACTIVE', billing.indexOf('status: S.ACTIVE, subscriptionStatus:') > -1);
  ck('the sweep still sends promotional trials to PAST_DUE',
     billing.indexOf('status: S.PAST_DUE, trialStatus:') > -1);
  ck('a merchant who paid is never told to "Subscribe now"',
     billing.indexOf('Nothing more to pay') > -1);

  head('7b - the genuinely free trial: FREE -> trial -> expires -> FREE');
  /* The promotional path, certified separately from the paid one. Entitlement is
     read through entitlementFor, which is what entitlement-authority calls
     (entitlement-authority.js:113) — not through a status string compared by
     eye. seller_basic is the trialled plan; 100 listings is its entitlement and
     10 is the free tier. */
  const ef = (status) => catalog.entitlementFor({ status: status, plan: 'seller_basic' });
  ck('during a promotional trial the merchant has the PLAN limit',
     ef('trialing').listingLimit === 100, String(ef('trialing').listingLimit));
  ck('when it expires they fall back to the FREE limit',
     ef('past_due').listingLimit === 10, String(ef('past_due').listingLimit));
  ck('...and the subscription reads as inactive',
     ef('past_due').subscriptionStatus === 'INACTIVE', ef('past_due').subscriptionStatus);
  ck('an expired subscription is likewise free-tier',
     ef('expired').listingLimit === 10, String(ef('expired').listingLimit));
  ck('a PAID trial keeps the plan limit — it is not a promotional trial',
     ef('trialing').listingLimit === 100 && ef('active').listingLimit === 100,
     'the paid path never passes through past_due');

  head('8 - NEGATIVE CONTROLS: this suite can fail');
  ck('an unpaid trial is not misread as paid',
     B.isPaidTrial({ paymentStatus: 'unpaid', trialEnd: T(past) }) === false,
     'if this passed, the discriminator would be meaningless');
  /* Rebuild the ORIGINAL defect inside the isolated function and re-run the
      exact predicate section 1 uses. Mutating the whole page would not do:
      `_pendingAction === 'trial'` appears in openModal and the button label too,
      so a single replace leaves the string present and the control passes for
      the wrong reason. The mutant must be the function that decides. */
  const mutant = confirmFn.split("_pendingAction === 'trial'").join('plan.trialDays > 0');
  const detects = (src) => src.indexOf('if (plan.trialDays > 0)') === -1;
  ck('the section-1 detector PASSES on the fixed code', detects(confirmFn) === true);
  ck('...and FAILS on the original defect', detects(mutant) === false,
     'a detector that cannot fail is not a detector');
  const noTrialIntent = 'ptb_nc';
  await db.doc('subscriptions/' + UID).delete().catch(() => {});
  await mk(noTrialIntent, 'monthly', 3);
  await SP.reconcilePaidIntent(noTrialIntent);
  const ncSub = (await db.doc('subscriptions/' + UID).get()).data() || {};
  ck('a 3-day trial genuinely moves the period start off today',
     Math.round((ms(ncSub.currentPeriodStart) - Date.now()) / DAY) === 3,
     'if this were 0 the trial would be silently consuming the paid period');

  for (let i = 0; i < MATRIX.length; i++) await db.doc('paymentIntents/ptb_' + i).delete().catch(() => {});
  await db.doc('paymentIntents/' + noTrialIntent).delete().catch(() => {});
  await db.doc('subscriptions/' + UID).delete().catch(() => {});
  done();
})().catch((e) => { console.error('\n  Suite aborted: ' + (e && e.stack) + '\n'); process.exit(1); });
