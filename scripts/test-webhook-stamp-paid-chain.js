#!/usr/bin/env node
'use strict';
/* ============================================================================
   CONTAINMENT LINEAGE (68811e1) — valid callback → intent stamped PAID → canonical reconciler
   → subscription active, with idempotency. Firestore emulator; the production
   INTASEND_WEBHOOK_CHALLENGE is never read — a SYNTHETIC value is placed in this process only.
   FN_DIR points at C:/temp/sok-recovery/functions (the tree that built webhookintasend-00068-del).
   ============================================================================ */
const path = require('path');
const crypto = require('crypto');
const FN_DIR = process.env.FN_DIR || 'C:/temp/sok-recovery/functions';
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8091';
if (!/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST)) { console.error('refusing: not an emulator host'); process.exit(3); }
process.env.GCLOUD_PROJECT = 'sokoni-smoke-test'; process.env.GOOGLE_CLOUD_PROJECT = 'sokoni-smoke-test';
process.env.FUNCTIONS_EMULATOR = 'true'; process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: 'sokoni-smoke-test' });
const SYNTHETIC_CHALLENGE = 'emulator-stamp-' + crypto.randomBytes(8).toString('hex');
process.env.INTASEND_WEBHOOK_CHALLENGE = SYNTHETIC_CHALLENGE;

let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d) : '')); } };

(async () => {
  const mod = require(path.join(FN_DIR, 'index.js'));
  const admin = require(path.join(FN_DIR, 'node_modules', 'firebase-admin'));
  const db = admin.firestore();
  const SPM = require(path.join(FN_DIR, 'subscription-pay-methods.js'));
  ck('0 the containment tree exports webhookIntasend and onPaymentIntentPaid', typeof mod.webhookIntasend === 'function' && !!mod.onPaymentIntentPaid);

  const uid = 'uid_stamp_' + Date.now();
  const ref = 'sub_stamp_' + Date.now();
  await db.collection('paymentIntents').doc(ref).set({ uid, purpose: 'subscription', planId: 'seller_basic', planName: 'Seller Basic', hubType: 'seller', billingCycle: 'monthly', amount: 999, amountCents: 99900, status: 'created', createdAt: new Date() });
  await db.collection('payments').doc(ref).set({ uid, status: 'PENDING', amount: 999, intentRef: ref, meta: { purpose: 'subscription', planId: 'seller_basic' }, createdAt: new Date() });

  async function deliver() {
    const body = { challenge: SYNTHETIC_CHALLENGE, invoice: { api_ref: ref, state: 'COMPLETE', net_amount: 999, value: 999, currency: 'KES', id: 'inv_' + ref } };
    const req = { method: 'POST', body, headers: { 'content-type': 'application/json' }, get: (h) => req.headers[String(h).toLowerCase()], rawBody: Buffer.from(JSON.stringify(body)) };
    let done; const p = new Promise((r) => { done = r; });
    const res = { _status: null, status(c) { this._status = c; return this; }, set() { return this; }, setHeader() { return this; }, send() { done(); return this; }, json() { done(); return this; }, end() { done(); return this; } };
    try { await mod.webhookIntasend(req, res); } catch (e) { console.log('  invoke error', e.message); }
    await Promise.race([p, new Promise((r) => setTimeout(r, 20000))]);
    return res._status;
  }

  console.log('\nA. valid COMPLETE callback');
  const s1 = await deliver();
  const i1 = (await db.collection('paymentIntents').doc(ref).get()).data();
  const p1 = (await db.collection('payments').doc(ref).get()).data();
  ck('A1 webhook answered 200', s1 === 200, s1);
  ck('A2 payments/{ref} is COMPLETE', p1.status === 'COMPLETE', p1.status);
  ck('A3 intent stamped PAID by the webhook (paidVia, activationPending) — no subscription written by the webhook itself', i1.status === 'paid' && i1.activationPending === true && /webhook/i.test(i1.paidVia || ''), { status: i1.status, paidVia: i1.paidVia, pending: i1.activationPending });
  const subBefore = await db.collection('subscriptions').doc(uid).get();
  ck('A4 the webhook did NOT activate subscriptions/{uid} itself (the trigger owns that)', !subBefore.exists || !subBefore.data().reconciledAt);

  console.log('\nB. the canonical reconciler (what onPaymentIntentPaid runs)');
  const r1 = await SPM._internal.reconcilePaidIntent(ref);
  const sub1 = (await db.collection('subscriptions').doc(uid).get()).data();
  ck('B1 reconcilePaidIntent activates: ok, not replayed, subscriptions/{uid} active, paymentStatus paid, planId from the INTENT', r1.ok && !r1.replayed && sub1 && sub1.status === 'active' && sub1.paymentStatus === 'paid' && sub1.planId === 'seller_basic', { r1, sub: sub1 && { status: sub1.status, planId: sub1.planId } });
  const i2 = (await db.collection('paymentIntents').doc(ref).get()).data();
  ck('B2 intent records reconciledAt + subscriptionId, activationPending cleared', !!i2.reconciledAt && i2.subscriptionId === uid && i2.activationPending === false, { reconciledAt: !!i2.reconciledAt, subscriptionId: i2.subscriptionId, pending: i2.activationPending });

  console.log('\nC. idempotency');
  const periodEnd1 = sub1.currentPeriodEnd.toMillis();
  const s2 = await deliver();
  const i3 = (await db.collection('paymentIntents').doc(ref).get()).data();
  ck('C1 the SAME callback again: 200, intent still paid, reconciledAt unchanged (merge-set changes nothing)', s2 === 200 && i3.status === 'paid' && i3.reconciledAt && i3.reconciledAt.isEqual(i2.reconciledAt), { s2, status: i3.status });
  const r2 = await SPM._internal.reconcilePaidIntent(ref);
  const sub2 = (await db.collection('subscriptions').doc(uid).get()).data();
  ck('C2 reconcile again: replayed=true, period end unchanged, ONE subscription document', r2.ok && r2.replayed === true && sub2.currentPeriodEnd.toMillis() === periodEnd1, { r2 });
  const subsForUid = await db.collection('subscriptions').where('uid', '==', uid).get();
  ck('C3 exactly one subscription document exists for the uid', subsForUid.size === 1, subsForUid.size);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
