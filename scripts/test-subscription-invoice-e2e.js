#!/usr/bin/env node
'use strict';
/* ============================================================================
   SUBSCRIPTION PAYMENT → ACTIVATION → INVOICE → ENTITLEMENT — end to end, with a duplicate callback
   ----------------------------------------------------------------------------
   Runs the REAL trigger handler (sub-engine.subAutoActivateOnPayment) and the REAL intent
   reconciler (subscription-pay-methods.reconcilePaidIntent) against the Firestore EMULATOR,
   with exactly ONE boundary stubbed: etims._issuePlatformInvoice (KRA + platform secrets).
   The stub records every call so "one invoice per payment" is a counted fact.

     firebase emulators:exec --only firestore --project sokoni-e2e "node scripts/test-subscription-invoice-e2e.js"

   Proves:
     A  payment COMPLETE → subscription active, entitlement visible, ONE invoice, back-refs written
     B  the SAME callback delivered again → nothing moves: 1 activation claim, 1 invoice, 0 engine calls
     C  VAT policy unset → activation still happens, invoice DEFERRED (never gated), then the sweep
        issues it once the policy is written — and a second sweep issues nothing
     D  the intent rail (reconcilePaidIntent) → same claim, same key, one invoice; replay is a no-op
     E  two writers racing on one reference (subActivate-style hook + trigger) → one invoice
   ============================================================================ */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.FIRESTORE_EMULATOR_HOST = HOST;
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-e2e';
process.env.FUNCTIONS_EMULATOR = 'true';

const admin = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin'));
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

/* ── the ONE stub: the fiscal engine boundary ──────────────────────────────────────────── */
const engineCalls = [];
const etimsPath = require.resolve(path.join(ROOT, 'functions', 'etims.js'));
require.cache[etimsPath] = {
  id: etimsPath, filename: etimsPath, loaded: true, exports: {
    _issuePlatformInvoice: async (args) => {
      engineCalls.push(args);
      if (args.feeType !== 'subscription') throw new Error('stub: wrong feeType ' + args.feeType);
      if (typeof args.vatInclusive !== 'boolean') throw new Error('stub: vatInclusive must be boolean');
      /* mirror the engine's deterministic key: a repeat reference returns the first invoice */
      const key = `platform-${args.feeType}-${args.reference}`;
      const dup = engineCalls.filter((c) => `platform-${c.feeType}-${c.reference}` === key);
      return dup.length > 1 ? { invoiceId: 'inv_' + args.reference, duplicate: true }
                            : { success: true, invoiceId: 'inv_' + args.reference, status: 'accepted' };
    },
  },
};

const SI  = require(path.join(ROOT, 'functions', 'subscription-invoice'));
const SE  = require(path.join(ROOT, 'functions', 'sub-engine'));
const SPM = require(path.join(ROOT, 'functions', 'subscription-pay-methods'));
const EA  = require(path.join(ROOT, 'functions', 'entitlement-authority'));

let pass = 0, fail = 0;
const ck = (label, ok, detail) => { if (ok) { pass++; console.log(`  PASS  ${label}`); } else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); } };
const snapOf = (data) => ({ data: () => data, exists: !!data });

async function wipe() {
  for (const c of ['payments', 'paymentIntents', 'subscriptions', 'finosIdempotency', 'billingHistory', 'users', 'revenueConfig', 'etimsInvoices', 'productCounters']) {
    const s = await db.collection(c).limit(500).get();
    await Promise.all(s.docs.map((d) => d.ref.delete()));
  }
  engineCalls.length = 0;
}
const count = async (c, f) => { let q = db.collection(c); if (f) q = q.where(...f); return (await q.get()).size; };
const claim = (ref) => db.collection('finosIdempotency').doc(SI._internal._claimId(ref)).get().then((s) => s.exists ? s.data() : null);
const armVat = () => db.collection('revenueConfig').doc('subscription_vat').set({ enabled: true, inclusive: true, decidedBy: 'e2e-fixture', decidedAt: new Date().toISOString() });

/* Deliver the payments/{ref} COMPLETE transition to the real trigger handler. */
async function deliverPaymentComplete(ref, before, after) {
  return SE.subAutoActivateOnPayment.run({ data: { before: snapOf(before), after: snapOf(after) }, params: { paymentRef: ref } });
}

(async () => {
  console.log(`subscription payment → activation → invoice → entitlement (emulator ${HOST})\n`);
  const uid = 'uid_e2e_merchant';
  const subId = 'sub_e2e_1';
  const planId = 'seller_basic';

  /* ── A ─────────────────────────────────────────────────────────────────────────────── */
  console.log('A. one COMPLETE payment');
  await wipe(); await armVat();
  await db.collection('users').doc(uid).set({ uid, email: 'e2e@example.test' });
  await db.collection('subscriptions').doc(subId).set({ uid, planId, plan: planId, planName: 'Seller Basic', hubType: 'seller', tier: 'basic', status: 'past_due', billingCycle: 'monthly' });
  const refA = 'PAY_E2E_A';
  const before = { status: 'PENDING', amount: 999, uid, meta: { purpose: 'subscription', subscriptionId: subId, planId, hubType: 'seller', billingCycle: 'monthly', uid } };
  const after  = { ...before, status: 'COMPLETE' };
  await db.collection('payments').doc(refA).set(after);
  await deliverPaymentComplete(refA, before, after);

  const subA = (await db.collection('subscriptions').doc(subId).get()).data();
  ck('A1 subscription is active with a period end in the future', subA.status === 'active' && subA.currentPeriodEnd && subA.currentPeriodEnd.toMillis() > Date.now(), subA.status);
  ck('A2 exactly ONE activation claim (finosIdempotency sub_autoact_*)', (await count('finosIdempotency', ['subscriptionId', '==', subId])) === 1);
  ck('A3 exactly ONE engine call, feeType subscription, amount = the payment amount (999), reference = ref',
     engineCalls.length === 1 && engineCalls[0].feeType === 'subscription' && engineCalls[0].amount === 999 && engineCalls[0].reference === refA && engineCalls[0].sellerUid === uid, engineCalls);
  const cA = await claim(refA);
  ck('A4 invoice claim is issued with the invoice id and the VAT decision recorded', cA && cA.status === 'issued' && cA.invoiceId === 'inv_' + refA && cA.vatInclusive === true && cA.vatDecidedBy === 'e2e-fixture' && cA.subInvoicePending === undefined, cA);
  const payA = (await db.collection('payments').doc(refA).get()).data();
  ck('A5 back-reference on the finalized payment', payA.platformInvoiceId === 'inv_' + refA, payA.platformInvoiceId);
  const bhA = await db.collection('billingHistory').where('paymentRef', '==', refA).get();
  ck('A6 ONE billingHistory row, carrying the invoice id', bhA.size === 1 && bhA.docs[0].data().platformInvoiceId === 'inv_' + refA, bhA.size);
  const entA = await EA.resolveEffective(uid).catch((e) => ({ err: e.message }));
  ck('A7 entitlement authority resolves the paid package (PROFESSIONAL = seller_basic) as ACTIVE for the uid', entA && !entA.err && entA.plan === 'PROFESSIONAL' && entA.subscriptionStatus === 'ACTIVE', entA && (entA.err || { plan: entA.plan, status: entA.subscriptionStatus }));

  /* ── B ─────────────────────────────────────────────────────────────────────────────── */
  console.log('\nB. the SAME callback again (duplicate delivery)');
  const periodEndBefore = subA.currentPeriodEnd.toMillis();
  await deliverPaymentComplete(refA, before, after);
  const subB = (await db.collection('subscriptions').doc(subId).get()).data();
  ck('B1 period end unchanged (no second extension)', subB.currentPeriodEnd.toMillis() === periodEndBefore);
  ck('B2 still ONE activation claim', (await count('finosIdempotency', ['subscriptionId', '==', subId])) === 1);
  ck('B3 still ONE engine call', engineCalls.length === 1, engineCalls.length);
  ck('B4 still ONE billingHistory row', (await count('billingHistory', ['paymentRef', '==', refA])) === 1);
  /* the invoice authority called directly with the same reference is a recorded no-op */
  const again = await SI.issueForSubscriptionPayment(refA, { actor: 'e2e-replay' });
  ck('B5 direct re-issue is idempotent: ok, already_issued, same invoice id, no engine call', again.ok === true && again.reason === 'already_issued' && again.invoiceId === 'inv_' + refA && engineCalls.length === 1, again);

  /* ── C ─────────────────────────────────────────────────────────────────────────────── */
  console.log('\nC. VAT policy UNSET: activation proceeds, invoice defers, sweep issues once armed');
  await wipe();   /* no revenueConfig/subscription_vat */
  await db.collection('users').doc(uid).set({ uid });
  await db.collection('subscriptions').doc(subId).set({ uid, planId, plan: planId, hubType: 'seller', tier: 'basic', status: 'past_due' });
  const refC = 'PAY_E2E_C';
  const afterC = { ...after };
  await db.collection('payments').doc(refC).set(afterC);
  await deliverPaymentComplete(refC, before, afterC);
  const subC = (await db.collection('subscriptions').doc(subId).get()).data();
  ck('C1 subscription is active even though no invoice could issue', subC.status === 'active');
  const cC = await claim(refC);
  ck('C2 claim is DEFERRED with reason vat_policy_unset and stays pending', cC && cC.status === 'deferred' && cC.reason === 'vat_policy_unset' && cC.subInvoicePending === true, cC);
  ck('C3 zero engine calls while the policy is unset', engineCalls.length === 0);
  const sweep0 = await SI.sweepPending({ actor: 'e2e-sweep-unarmed' });
  ck('C4 sweep while unarmed: scanned 1, issued 0, deferred 1, engine still not called', sweep0.scanned === 1 && sweep0.issued === 0 && sweep0.deferred === 1 && engineCalls.length === 0, sweep0);
  await armVat();
  const sweep1 = await SI.sweepPending({ actor: 'e2e-sweep-armed' });
  const cC2 = await claim(refC);
  ck('C5 sweep once armed: issued 1, claim issued, ONE engine call', sweep1.issued === 1 && cC2.status === 'issued' && engineCalls.length === 1, { sweep1, status: cC2.status, calls: engineCalls.length });
  const sweep2 = await SI.sweepPending({ actor: 'e2e-sweep-again' });
  ck('C6 a second sweep finds nothing pending and calls nothing', sweep2.scanned === 0 && engineCalls.length === 1, sweep2);

  /* ── D ─────────────────────────────────────────────────────────────────────────────── */
  console.log('\nD. the intent rail: paymentIntents/{ref} paid → reconcilePaidIntent');
  await wipe(); await armVat();
  const refD = 'INT_E2E_D';
  await db.collection('paymentIntents').doc(refD).set({ uid, purpose: 'subscription', planId, planName: 'Seller Basic', hubType: 'seller', billingCycle: 'monthly', amount: 999, amountCents: 99900, status: 'paid', method: 'mpesa', trialDays: 0 });
  const r1 = await SPM._internal.reconcilePaidIntent(refD);
  ck('D1 reconciled: subscription active, paymentStatus paid', r1.ok === true && !r1.replayed && (await db.collection('subscriptions').doc(uid).get()).data().paymentStatus === 'paid', r1);
  const cD = await claim(refD);
  ck('D2 ONE invoice from the intent amount (999), source paymentIntents', engineCalls.length === 1 && engineCalls[0].amount === 999 && cD && cD.status === 'issued' && cD.source === 'paymentIntents', { calls: engineCalls.length, cD });
  ck('D3 back-reference on the intent', (await db.collection('paymentIntents').doc(refD).get()).data().platformInvoiceId === 'inv_' + refD);
  const r2 = await SPM._internal.reconcilePaidIntent(refD);
  ck('D4 replayed reconciliation is a no-op: replayed=true, still ONE engine call', r2.ok === true && r2.replayed === true && engineCalls.length === 1, { r2, calls: engineCalls.length });

  /* ── E ─────────────────────────────────────────────────────────────────────────────── */
  console.log('\nE. two writers racing on one reference');
  await wipe(); await armVat();
  const refE = 'PAY_E2E_E';
  await db.collection('payments').doc(refE).set({ ...after, meta: { ...after.meta, subscriptionId: 'sub_e2e_E' } });
  await db.collection('subscriptions').doc('sub_e2e_E').set({ uid, planId, hubType: 'seller', tier: 'basic', status: 'past_due' });
  const [ra, rb] = await Promise.all([
    SI.recordAfterActivation(refE, { actor: 'subActivate', uid }),
    SI.recordAfterActivation(refE, { actor: 'subAutoActivateOnPayment', uid }),
  ]);
  const okCount = [ra, rb].filter((r) => r.ok && !r.idempotent).length;
  const cE = await claim(refE);
  ck('E1 exactly one writer issued; the other saw in_flight or already_issued; ONE engine call',
     okCount === 1 && engineCalls.length === 1 && cE.status === 'issued' && [ra, rb].some((r) => r.idempotent || r.reason === 'in_flight'), { ra, rb, calls: engineCalls.length });

  /* ── negative control: the harness can fail ────────────────────────────────────────── */
  console.log('\nNC. negative control (must FAIL)');
  const nc = engineCalls.length === 999;
  console.log(`  ${nc ? 'PASS' : 'FAIL'}  NC deliberately false assertion — expected FAIL`);

  console.log(`\n${pass} passed, ${fail} failed (negative control excluded)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
