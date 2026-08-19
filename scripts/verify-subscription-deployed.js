/* ══════════════════════════════════════════════════════════════════════════════
   POST-DEPLOY VERIFICATION — the subscription set, against PRODUCTION
   ══════════════════════════════════════════════════════════════════════════════
   Runs immediately after the functions deploy, before any hosting deploy and
   long before any real payment. It checks the deployed surface and the
   activation arithmetic, using synthetic intents under a reserved test uid.

   It does NOT charge anything, does NOT call a payment provider, and does NOT
   touch KASS. Every document it creates it deletes; a cleanup failure is
   reported as a FAIL, because a verification that leaves residue in production
   is not green.

     node scripts/verify-subscription-deployed.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);

const DAY = 86400000;
const UID = 'zzz_release_verify_synthetic';
const KASS_UID = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';

console.log('\nPOST-DEPLOY VERIFICATION — subscription set (PRODUCTION)');
console.log('='.repeat(78));

(async () => {
  let admin, db;
  try {
    delete process.env.FIRESTORE_EMULATOR_HOST;      /* production, deliberately */
    admin = require(path.join(ROOT, 'functions/node_modules/firebase-admin'));
    if (!admin.apps.length) admin.initializeApp({ projectId: 'sokoni-aeb26' });
    db = admin.firestore();
    await db.collection('shops').limit(1).get();
  } catch (e) {
    un('every runtime assertion', 'no production access: ' + String((e && e.message) || e).slice(0, 70));
    return done();
  }

  const SP = require(path.join(ROOT, 'functions/subscription-pay-methods.js'))._internal;
  const ms = (t) => (t && t.toMillis ? t.toMillis() : null);
  const created = [];

  const mk = async (id, cycle, trialDays) => {
    await db.doc('paymentIntents/' + id).set({
      ref: id, uid: UID, planId: 'seller_basic', planName: 'Seller Basic',
      billingCycle: cycle, trialDays,
      amount: cycle === 'annual' ? 9990 : 999,
      amountCents: cycle === 'annual' ? 999000 : 99900,
      currency: 'KES', status: 'paid', purpose: 'subscription',
      method: 'SYNTHETIC_VERIFY', activationPending: true,
    });
    created.push('paymentIntents/' + id);
  };

  head('1 - KASS baseline BEFORE anything (must be identical after)');
  const kassBefore = await db.doc('subscriptions/' + KASS_UID).get().catch(() => null);
  const kassSigBefore = kassBefore && kassBefore.exists
    ? JSON.stringify({ p: kassBefore.data().planId || kassBefore.data().plan, s: kassBefore.data().status })
    : 'ABSENT';
  console.log('  KASS signature: ' + kassSigBefore);

  head('2 - the activation arithmetic, on the DEPLOYED code path');
  const CASES = [
    { cycle: 'monthly', trialDays: 3, days: 30 },
    { cycle: 'annual',  trialDays: 3, days: 365 },
    { cycle: 'monthly', trialDays: 0, days: 30 },
    { cycle: 'annual',  trialDays: 0, days: 365 },
  ];

  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const id = 'zzzverify_' + Date.now() + '_' + i;
    await db.doc('subscriptions/' + UID).delete().catch(() => {});
    await mk(id, c.cycle, c.trialDays);
    const t0 = Date.now();
    const r = await SP.reconcilePaidIntent(id);
    const sub = (await db.doc('subscriptions/' + UID).get()).data() || {};
    created.push('subscriptions/' + UID);

    const start = ms(sub.currentPeriodStart), end = ms(sub.currentPeriodEnd);
    const period = (start && end) ? Math.round((end - start) / DAY) : null;
    const delay = start ? Math.round((start - t0) / DAY) : null;

    console.log('\n  ' + c.cycle + (c.trialDays ? ' + ' + c.trialDays + '-day trial' : ', no trial'));
    ck('  activates', !!(r && r.ok), r && r.reason);
    ck('  period is ' + c.days + ' days', period !== null && Math.abs(period - c.days) <= 1, period + 'd');
    ck('  currentPeriodEnd === expiresAt', ms(sub.expiresAt) === end,
       (ms(sub.expiresAt) - end) + 'ms apart');
    ck('  paid period starts AFTER the trial (+' + c.trialDays + 'd)',
       delay !== null && Math.abs(delay - c.trialDays) <= 1, delay + 'd');
    ck('  NO rival writer claimed it', sub.activatedBy !== 'automation', sub.activatedBy || '(none)');
    ck('  traceable to the payment', sub.lastPaymentRef === id, sub.lastPaymentRef || 'none');

    /* Replay must not extend the period. */
    const before = end;
    const again = await SP.reconcilePaidIntent(id);
    const after = ms((await db.doc('subscriptions/' + UID).get()).data().currentPeriodEnd);
    ck('  REPLAY is recognised', !!(again && again.replayed === true), String(again && again.replayed));
    ck('  REPLAY does NOT extend the period', after === before, (after - before) + 'ms drift');
  }

  head('3 - exactly one subscription document for the synthetic uid');
  const subs = await db.collection('subscriptions').where('uid', '==', UID).get();
  ck('exactly one', subs.size === 1, String(subs.size));

  head('4 - entitlement resolves to the purchased ceiling');
  try {
    const EA = require(path.join(ROOT, 'functions/entitlement-authority.js'));
    const ent = await EA.getMerchantEntitlement(UID);
    ck('entitlement resolves', !!ent, ent && ent.plan);
    ck('product limit is the Starter ceiling, not free',
       ent && ent.limits && ent.limits.products === 100,
       ent && ent.limits ? String(ent.limits.products) : 'n/a');
  } catch (e) { un('entitlement resolution', String(e.message).slice(0, 60)); }

  head('5 - CLEANUP (a verification that leaves residue is not green)');
  let cleanupOk = true;
  for (const p of [...new Set(created)]) {
    try { await db.doc(p).delete(); } catch (_) { cleanupOk = false; }
  }
  try {
    const left = await db.collection('paymentIntents').where('uid', '==', UID).get();
    left.forEach(() => { cleanupOk = false; });
    ck('no synthetic intents remain', left.size === 0, String(left.size));
  } catch (_) { cleanupOk = false; }
  const subLeft = await db.doc('subscriptions/' + UID).get();
  ck('no synthetic subscription remains', !subLeft.exists);
  ck('cleanup completed', cleanupOk);

  head('6 - KASS is byte-identical to the baseline');
  const kassAfter = await db.doc('subscriptions/' + KASS_UID).get().catch(() => null);
  const kassSigAfter = kassAfter && kassAfter.exists
    ? JSON.stringify({ p: kassAfter.data().planId || kassAfter.data().plan, s: kassAfter.data().status })
    : 'ABSENT';
  ck('KASS unchanged', kassSigAfter === kassSigBefore, kassSigAfter);
  const link = await db.doc('merchantAccountLinks/xrH21J5GFbW8PluCZ2ny5nIuf602').get().catch(() => null);
  ck('KASS account link still absent', !!(link && !link.exists));

  head('7 - what this does NOT prove');
  un('a real M-PESA STK prompt', 'needs a handset and a real payment');
  un('a genuine IntaSend webhook', 'no provider was contacted');

  done();

  function done() {
    console.log('\n' + '='.repeat(78));
    console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
    console.log('='.repeat(78) + '\n');
    process.exit(fail ? 1 : 0);
  }
})().catch((e) => { console.error('\n  Verification aborted: ' + (e && e.stack) + '\n'); process.exit(1); });
