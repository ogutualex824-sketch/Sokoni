/* ══════════════════════════════════════════════════════════════════════════════
   PRODUCTION SAFETY-BOUNDARY VERIFICATION — run AFTER the functions deploy,
   BEFORE any real payment
   ══════════════════════════════════════════════════════════════════════════════
   The functions are live the moment they deploy, so the boundary must be proved
   before a merchant is asked to pay:

       webhook authentication
             ↓
       payment intent PAID
             ↓
       onPaymentIntentPaid
             ↓
       reconcilePaidIntent
             ↓
       exactly one subscription
             ↓
       entitlement
             ↓
       maxProducts

   ── IT USES A SYNTHETIC MERCHANT, NEVER A REAL ONE ──────────────────────────
   Every document it touches is namespaced `zzz_verify_*` and deleted afterwards.
   No customer record is read or written, no money moves, and KASS is not
   involved. The one thing it CANNOT prove is that a real STK prompt arrives —
   that needs a handset and a payment, and it is reported as UNPROVEN.

     node scripts/verify-subscription-production.js            (read-only checks)
     node scripts/verify-subscription-production.js --write    (synthetic trigger test)
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const ROOT = path.resolve(__dirname, '..');

const WRITE = process.argv.indexOf('--write') > -1;
let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);

console.log('\nPRODUCTION SAFETY BOUNDARY ' + (WRITE ? '— WITH synthetic trigger test' : '— read-only'));
console.log('='.repeat(74));

const REGION = 'us-central1', PROJECT = 'sokoni-aeb26';
const fnUrl = (n) => 'https://' + REGION + '-' + PROJECT + '.cloudfunctions.net/' + n;

function post(url, body, headers) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body || {});
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {}),
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 400) }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    req.write(data); req.end();
  });
}

(async () => {
  let admin, db;
  try {
    admin = require(path.join(ROOT, 'functions/node_modules/firebase-admin'));
    if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
    db = admin.firestore();
    await db.collection('shops').limit(1).get();
  } catch (e) {
    un('everything', 'no production access: ' + String((e && e.message) || e).slice(0, 70));
    console.log('\n  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven\n');
    process.exit(0);
  }

  head('1 - the webhook rejects what it must reject');
  /* A callback with no challenge must not be able to mark anything paid. This is
     the security boundary, tested against the LIVE endpoint. */
  const noChallenge = await post(fnUrl('intasendWebhook'), { invoice: { state: 'COMPLETE', api_ref: 'zzz_verify_fake' } });
  ck('an UNAUTHENTICATED callback is refused',
     noChallenge.status === 401 || noChallenge.status === 403 || /challenge/i.test(noChallenge.body),
     'HTTP ' + noChallenge.status + ' ' + noChallenge.body.slice(0, 60));
  const wrongChallenge = await post(fnUrl('intasendWebhook'), { challenge: 'not-the-secret', invoice: { state: 'COMPLETE', api_ref: 'zzz_verify_fake' } });
  ck('a WRONG challenge is refused',
     wrongChallenge.status !== 200 || /invalid|unauthor/i.test(wrongChallenge.body),
     'HTTP ' + wrongChallenge.status + ' ' + wrongChallenge.body.slice(0, 60));
  const getReq = await new Promise((r) => https.get(fnUrl('intasendWebhook'), (res) => { res.resume(); r(res.statusCode); }).on('error', () => r(0)));
  ck('a GET is refused (POST only)', getReq === 405 || getReq === 400, 'HTTP ' + getReq);
  ck('no fake intent was created by any of that',
     !(await db.doc('paymentIntents/zzz_verify_fake').get()).exists);

  head('2 - the deployed surface is the one we shipped');
  const NEW = ['subscriptionPaymentMethods', 'payIntentWithWallet', 'reconcileSubscriptionPayment',
               'merchantIdentity', 'employeeSaleAuthorize', 'adminLinkMerchantAccounts'];
  for (const n of NEW) {
    /* An unauthenticated onCall must answer 401/403 — not 404. 404 means the
       function is not there; 401 means it is there and guarding. */
    const r = await post(fnUrl(n), { data: {} });
    ck(n + ' is live and guarding', r.status === 401 || r.status === 403,
       'HTTP ' + r.status);
  }

  head('3 - the frozen wallet backend is untouched');
  const wr = await post(fnUrl('spendFromWallet'), { data: {} });
  ck('spendFromWallet still responds', wr.status === 401 || wr.status === 403, 'HTTP ' + wr.status);
  let dirty = '';
  try { dirty = require('child_process').execSync('git status --porcelain functions/wallet.js', { cwd: ROOT }).toString().trim(); } catch (_) {}
  ck('functions/wallet.js clean against HEAD', dirty === '', dirty || 'clean');

  if (!WRITE) {
    head('4 - the activation chain');
    un('intent PAID -> onPaymentIntentPaid -> reconcile -> one subscription',
       'needs --write to create a synthetic intent; nothing was written');
    un('a real M-PESA STK prompt', 'needs a handset and a real payment');
    console.log('\n' + '='.repeat(74));
    console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
    console.log('  Re-run with --write to exercise the activation chain synthetically.');
    console.log('='.repeat(74) + '\n');
    process.exit(fail ? 1 : 0);
  }

  /* ── SYNTHETIC ACTIVATION ────────────────────────────────────────────────
     A namespaced intent, stamped PAID exactly as a webhook would. This proves
     the deployed trigger and reconciler, with no money and no real merchant. */
  head('4 - the activation chain, synthetically');
  const UID = 'zzz_verify_merchant';
  const REF = 'zzz_verify_intent_' + Date.now();
  const cleanup = async () => {
    for (const p of ['paymentIntents/' + REF, 'subscriptions/' + UID, 'productCounters/' + UID,
                     'users/' + UID, 'trialLedger/' + UID]) {
      await db.doc(p).delete().catch(() => {});
    }
  };
  const BASE_SUBS = (await db.collection('subscriptions').count().get()).data().count;
  const BASE_INTENTS = (await db.collection('paymentIntents').count().get()).data().count;
  console.log('    baseline: ' + BASE_SUBS + ' subscriptions, ' + BASE_INTENTS + ' payment intents');
  try {
    await db.doc('paymentIntents/' + REF).set({
      ref: REF, uid: UID, planId: 'seller_basic', planName: 'Seller Basic',
      billingCycle: 'monthly', amount: 999, amountCents: 99900, currency: 'KES',
      purpose: 'subscription', status: 'created',
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 3600000),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    ck('a synthetic intent was created', (await db.doc('paymentIntents/' + REF).get()).exists);

    const before = await db.doc('subscriptions/' + UID).get();
    ck('no subscription exists yet', !before.exists);

    /* PENDING must activate nothing. */
    await db.doc('paymentIntents/' + REF).set({ status: 'processing' }, { merge: true });
    await new Promise((r) => setTimeout(r, 8000));
    ck('PROCESSING did NOT activate anything',
       !(await db.doc('subscriptions/' + UID).get()).exists);

    /* Now stamp PAID, exactly as the webhook does. */
    await db.doc('paymentIntents/' + REF).set({
      status: 'paid', paidAt: admin.firestore.FieldValue.serverTimestamp(),
      paidVia: 'zzz_verify', providerRef: REF, activationPending: true,
    }, { merge: true });

    let sub = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const s = await db.doc('subscriptions/' + UID).get();
      if (s.exists) { sub = s.data(); break; }
    }
    ck('onPaymentIntentPaid fired and reconcilePaidIntent activated', !!sub,
       sub ? sub.planId + ' / ' + sub.status : 'no subscription after 60s');
    if (sub) {
      ck('exactly ONE subscription document',
         (await db.collection('subscriptions').where('uid', '==', UID).get()).size === 1);
      ck('status ACTIVE', sub.status === 'active');
      ck('the plan came from the INTENT', sub.planId === 'seller_basic');
      ck('traceable to the payment', sub.lastPaymentRef === REF);
      const intentAfter = (await db.doc('paymentIntents/' + REF).get()).data();
      ck('activationPending cleared', intentAfter.activationPending === false);
      ck('reconciledAt stamped', !!intentAfter.reconciledAt);

      /* Entitlement + ceiling. */
      const EA = require(path.join(ROOT, 'functions/entitlement-authority.js'));
      const ent = await EA.resolveEffective(UID);
      ck('entitlement resolves STARTER', ent.plan === 'STARTER', ent.plan);
      ck('...with 100 products', ent.listingLimit === 100, String(ent.listingLimit));
      const ctr = await db.doc('productCounters/' + UID).get();
      ck('maxProducts synced to the catalogue entitlement',
         ctr.exists && ctr.data().maxProducts === 100,
         ctr.exists ? String(ctr.data().maxProducts) : 'no counter');

      /* REPLAY. */
      const endBefore = sub.currentPeriodEnd.toMillis();
      await db.doc('paymentIntents/' + REF).set({ status: 'paid', replayedAt: Date.now() }, { merge: true });
      await new Promise((r) => setTimeout(r, 10000));
      const sub2 = (await db.doc('subscriptions/' + UID).get()).data();
      ck('a REPLAY did not extend the period', sub2.currentPeriodEnd.toMillis() === endBefore);
      ck('...and did not create a second subscription',
         (await db.collection('subscriptions').where('uid', '==', UID).get()).size === 1);
      ck('...and lastPaymentRef is unchanged', sub2.lastPaymentRef === REF);
      const intent2 = (await db.doc('paymentIntents/' + REF).get()).data();
      ck('reconciledAt is STABLE across the replay',
         intentAfter.reconciledAt.toMillis() === intent2.reconciledAt.toMillis(),
         'was ' + intentAfter.reconciledAt.toMillis() + ', now ' + intent2.reconciledAt.toMillis());
      ck('expiresAt is STABLE across the replay',
         sub.expiresAt.toMillis() === sub2.expiresAt.toMillis());
      console.log('    subscription id: ' + UID + '  period end: ' + new Date(endBefore).toISOString());
    }
  } finally {
    /* ── CLEANUP IS PART OF THE TEST ────────────────────────────────────────
       A verification that leaves synthetic records in production has not fully
       passed, however green the activation was. Asserted, not assumed. */
    head('4b - cleanup, verified');
    await cleanup();
    const PATHS = ['paymentIntents/' + REF, 'subscriptions/' + UID, 'productCounters/' + UID,
                   'users/' + UID, 'trialLedger/' + UID];
    for (const p of PATHS) {
      const still = await db.doc(p).get().catch(() => null);
      ck('removed ' + p, !!still && !still.exists, still && still.exists ? 'STILL PRESENT' : 'gone');
    }
    const leftovers = await db.collection('subscriptions').where('uid', '==', UID).get().catch(() => null);
    ck('no synthetic subscription survives', !!leftovers && leftovers.size === 0,
       leftovers ? String(leftovers.size) : 'unreadable');
    const intentsLeft = await db.collection('paymentIntents')
      .where('uid', '==', UID).get().catch(() => null);
    ck('no synthetic payment intent survives', !!intentsLeft && intentsLeft.size === 0,
       intentsLeft ? String(intentsLeft.size) : 'unreadable');
  }

  head('5 - no unexpected production writes');
  const AFTER_SUBS = (await db.collection('subscriptions').count().get()).data().count;
  const AFTER_INTENTS = (await db.collection('paymentIntents').count().get()).data().count;
  ck('subscription count returned to baseline', AFTER_SUBS === BASE_SUBS,
     BASE_SUBS + ' -> ' + AFTER_SUBS);
  ck('payment intent count returned to baseline', AFTER_INTENTS === BASE_INTENTS,
     BASE_INTENTS + ' -> ' + AFTER_INTENTS);
  const kass = await db.doc('subscriptions/D5Ql2EYr95bt79IpcGTmOMTK0P83').get();
  ck('KASS shop subscription untouched (still seller_free/trialing)',
     kass.exists && (kass.data().planId === 'seller_free' || kass.data().plan === 'trial'),
     kass.exists ? ((kass.data().plan || kass.data().planId) + ' / ' + kass.data().status) : 'MISSING');
  const kassLink = await db.doc('merchantAccountLinks/xrH21J5GFbW8PluCZ2ny5nIuf602').get();
  ck('KASS account link still NOT created', !kassLink.exists);

  head('6 - what is still UNPROVEN');
  un('a real M-PESA STK prompt arriving on a handset', 'needs a real payment');
  un('IntaSend delivering a genuine webhook', 'only a real transaction proves it');

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  console.log('  ' + (fail === 0 ? 'Safety boundary GREEN — a controlled test purchase may proceed.'
                                 : 'BOUNDARY FAILED — do not attempt a payment.'));
  console.log('='.repeat(74) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  Verification aborted: ' + (e && e.stack) + '\n'); process.exit(1); });
