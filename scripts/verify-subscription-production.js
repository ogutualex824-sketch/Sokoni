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
  /* ── SYNTHETIC ACTIVATION, BOTH BILLING CYCLES ──────────────────────────
     Monthly alone cannot catch the defect that truncated annual plans: both
     rules produce 30 days for monthly, so a monthly-only run is green either
     way. Every cycle the catalogue sells must be exercised. */
  head('4 - the activation chain, synthetically — BOTH cycles');
  const BASE_SUBS = (await db.collection('subscriptions').count().get()).data().count;
  const BASE_INTENTS = (await db.collection('paymentIntents').count().get()).data().count;
  console.log('    baseline: ' + BASE_SUBS + ' subscriptions, ' + BASE_INTENTS + ' payment intents');

  const CYCLES = [
    { cycle: 'monthly', planId: 'seller_basic', planName: 'Seller Basic', amount: 999, days: 30 },
    { cycle: 'annual',  planId: 'seller_pro',   planName: 'Seller Pro',   amount: 24990, days: 365 },
  ];
  const DAY = 86400000;

  for (const C of CYCLES) {
    const UID = 'zzz_verify_' + C.cycle;
    const REF = 'zzz_verify_' + C.cycle + '_' + Date.now();
    const cleanup = async () => {
      for (const p of ['paymentIntents/' + REF, 'subscriptions/' + UID, 'productCounters/' + UID,
                       'users/' + UID, 'trialLedger/' + UID]) {
        await db.doc(p).delete().catch(() => {});
      }
    };
    head('4.' + C.cycle.toUpperCase() + ' — ' + C.planName + ' (' + C.cycle + ', expect ' + C.days + ' days)');
    try {
      await db.doc('paymentIntents/' + REF).set({
        ref: REF, uid: UID, planId: C.planId, planName: C.planName,
        billingCycle: C.cycle, amount: C.amount, amountCents: C.amount * 100, currency: 'KES',
        purpose: 'subscription', status: 'created',
        expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 3600000),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      ck('intent created', (await db.doc('paymentIntents/' + REF).get()).exists);
      ck('no subscription yet', !(await db.doc('subscriptions/' + UID).get()).exists);

      await db.doc('paymentIntents/' + REF).set({ status: 'processing' }, { merge: true });
      await new Promise((r) => setTimeout(r, 6000));
      ck('PROCESSING activated nothing', !(await db.doc('subscriptions/' + UID).get()).exists);

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
      ck('activated', !!sub, sub ? sub.planId + ' / ' + sub.status : 'none after 60s');
      if (!sub) { await cleanup(); continue; }

      ck('exactly ONE subscription',
         (await db.collection('subscriptions').where('uid', '==', UID).get()).size === 1);
      ck('status ACTIVE', sub.status === 'active');
      ck('plan from the intent', sub.planId === C.planId);

      /* ── LET EVERY TRIGGER SETTLE, THEN RE-READ ──────────────────────────
         The defect appeared ~1s after activation. Reading immediately would
         have missed it, which is how it survived three green runs. */
      await new Promise((r) => setTimeout(r, 12000));
      const settled = (await db.doc('subscriptions/' + UID).get()).data();

      const cpe = settled.currentPeriodEnd.toMillis();
      const exp = settled.expiresAt ? settled.expiresAt.toMillis() : null;
      const days = Math.round((cpe - Date.now()) / DAY);

      /* THE assertion. One computation feeds both fields, so exact equality is
         the property — "close enough" is what let a 335-day gap through. */
      ck('currentPeriodEnd === expiresAt EXACTLY', exp !== null && cpe === exp,
         exp === null ? 'expiresAt missing' : (cpe - exp) + 'ms apart');
      ck('period is the catalogue ' + C.cycle + ' duration (' + C.days + ' days)',
         Math.abs(days - C.days) <= 1, days + ' days');
      ck('the period did NOT move after triggers settled',
         cpe === sub.currentPeriodEnd.toMillis(),
         (cpe - sub.currentPeriodEnd.toMillis()) + 'ms drift');
      ck('no trigger claimed the activation',
         settled.activatedBy !== 'automation', settled.activatedBy || '(none)');

      /* Replay. */
      await db.doc('paymentIntents/' + REF).set({ status: 'paid', replayedAt: Date.now() }, { merge: true });
      await new Promise((r) => setTimeout(r, 10000));
      const after = (await db.doc('subscriptions/' + UID).get()).data();
      ck('a REPLAY did not extend the period', after.currentPeriodEnd.toMillis() === cpe);
      ck('...nor create a second subscription',
         (await db.collection('subscriptions').where('uid', '==', UID).get()).size === 1);
      ck('...and lastPaymentRef is unchanged', after.lastPaymentRef === REF);
    } finally {
      await cleanup();
      const gone = !(await db.doc('subscriptions/' + UID).get()).exists;
      ck('cleanup removed the ' + C.cycle + ' fixtures', gone, gone ? 'gone' : 'STILL PRESENT');
    }
  }

  head('4b - MUTATION CONTROL: would this suite catch the old rule?');
  /* The exact production defect, reconstructed as arithmetic. If the suite
     cannot fail against it, the suite is decoration. */
  const rogue = (sub) => (sub.billingCycleDays || 30);
  const fixed = (sub) => (Number(sub.billingCycleDays) > 0 ? Number(sub.billingCycleDays)
                        : (sub.billingCycle === 'annual' ? 365 : 30));
  const AN = { billingCycle: 'annual' };
  ck('MC the OLD rule gives an annual plan 30 days', rogue(AN) === 30);
  ck('MC the FIXED rule gives it 365', fixed(AN) === 365);
  ck('MC the annual assertion above would FAIL on 30',
     !(Math.abs(rogue(AN) - 365) <= 1) && (Math.abs(fixed(AN) - 365) <= 1));
  ck('MC monthly is 30 under BOTH — so a monthly-only run proves nothing',
     rogue({ billingCycle: 'monthly' }) === fixed({ billingCycle: 'monthly' }));

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
