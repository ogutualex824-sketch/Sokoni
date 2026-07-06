/* ================================================================
   SOKONI Subscription Engine v2.0 — Automated Billing Layer
   3 Cloud Functions closing the gaps in the existing sub-billing.js:

     subScheduleRenewals       — scheduled daily: server-side M-PESA STK
                                 push for subscriptions expiring within 24h
     subAutoActivateOnPayment  — Firestore trigger: auto-activates a
                                 subscription the moment IntaSend marks a
                                 subscription payment COMPLETE (no client
                                 action required)
     subUpgradeWithProration   — onCall: calculate prorated charge, optionally
                                 initiate STK push, and activate upgrade

   All monetary values in KES cents (integer).
================================================================ */
'use strict';

const { onCall, HttpsError }     = require('firebase-functions/v2/https');
const { onDocumentUpdated }      = require('firebase-functions/v2/firestore');
const { onSchedule }             = require('firebase-functions/v2/scheduler');
const { defineSecret }           = require('firebase-functions/params');
const logger                     = require('firebase-functions/logger');
const admin                      = require('firebase-admin');
const https                      = require('https');
const crypto                     = require('crypto');

const REGION              = 'us-central1';
const INTASEND_PRIVATE_KEY = defineSecret('INTASEND_PRIVATE_KEY');

const db  = () => admin.firestore();
const now = () => admin.firestore.FieldValue.serverTimestamp();
const ts  = (d) => admin.firestore.Timestamp.fromDate(new Date(d));

/* ── Active statuses (subscription has access) ── */
const ACTIVE_STATUSES = new Set(['trialing', 'active', 'grace']);

/* ── Helper: add N days to a date ── */
function _addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

/* ── Helper: next period end ── */
function _periodEnd(start, cycle) {
  const d = new Date(start);
  if (cycle === 'annual') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

/* ── Notification writer ── */
async function _notify(uid, type, data) {
  try {
    await db().collection('notifications').add({ uid, type, ...data, read: false, createdAt: now() });
  } catch (e) {
    logger.warn('[sub-engine] notify failed', { uid, type, err: e.message });
  }
}

/* ── Audit log writer ── */
async function _audit(action, uid, data) {
  try {
    await db().collection('subscriptionAuditLog').add({ action, uid, ...data, timestamp: now() });
  } catch (e) {
    logger.warn('[sub-engine] audit failed', { action, uid });
  }
}

/* ── IntaSend STK Push ── */
async function _stkPush(privateKey, { phone, amountKES, ref, narrative }) {
  const isSandbox = process.env.INTASEND_SANDBOX === 'true';
  const host      = isSandbox ? 'sandbox.intasend.com' : 'payment.intasend.com';
  const payload   = JSON.stringify({
    phone_number: String(phone).replace(/\D/g, '').replace(/^0/, '254'),
    amount:       String(Math.round(amountKES)),
    currency:     'KES',
    narrative:    narrative || `SOKONI Subscription: ${ref}`,
    api_ref:      ref,
  });

  return new Promise((resolve, reject) => {
    const opts = {
      hostname: host,
      path:     '/api/v1/payment/mpesa-stk-push/',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Authorization':  `Token ${privateKey}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (_) { reject(new Error('Invalid IntaSend response')); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/* ── Resolve plan (merges Firestore override over built-in) ── */
async function _resolvePlan(planId) {
  const snap = await db().collection('subscriptionPlans').doc(planId).get();
  if (snap.exists) return { id: planId, ...snap.data() };
  /* Fall back to PLANS catalog from sub-billing — re-require to avoid circular dep */
  throw new HttpsError('not-found', `Plan not found: ${planId}`);
}

/* ── Calculate proration credit ── */
function _calculateProration(currentSub, newPlanPriceCents, cycle) {
  const now          = Date.now();
  const periodEnd    = currentSub.currentPeriodEnd?.toMillis?.() || now;
  const periodStart  = currentSub.currentPeriodStart?.toMillis?.() || now;
  const totalMs      = periodEnd - periodStart;
  if (totalMs <= 0) return { creditCents: 0, chargeCents: newPlanPriceCents, remainingDays: 0 };

  const remainingMs  = Math.max(0, periodEnd - now);
  const remainingPct = remainingMs / totalMs;
  const oldPrice     = cycle === 'annual' ? currentSub.priceAnnual : currentSub.priceMonthly;
  const creditCents  = Math.round((oldPrice || 0) * remainingPct);
  const chargeCents  = Math.max(0, newPlanPriceCents - creditCents);
  const remainingDays = Math.ceil(remainingMs / 86400000);

  return { creditCents, chargeCents, remainingPct, remainingDays, oldPrice };
}

/* ════════════════════════════════════════════════════════════
   CF 1. subScheduleRenewals
   Scheduled daily at 06:00 EAT (03:00 UTC).
   Finds subscriptions expiring within 24 h, initiates M-PESA
   STK push so renewal happens server-side with zero manual steps.
   Dunning schedule: Day -1 (today), Day -3, Day -7 before expiry.
════════════════════════════════════════════════════════════ */
exports.subScheduleRenewals = onSchedule(
  {
    schedule:       'every day 03:00',
    timeZone:       'UTC',
    region:         REGION,
    timeoutSeconds: 540,
    memory:         '512MiB',
    secrets:        [INTASEND_PRIVATE_KEY],
  },
  async () => {
    const fsdb = db();
    const nowMs = Date.now();

    /* Find subscriptions expiring within 25 hours and still in an active or grace state */
    const window25h = ts(new Date(nowMs + 25 * 3600000));
    const renewSnap = await fsdb.collection('subscriptions')
      .where('status', 'in', ['active', 'grace', 'trialing'])
      .where('currentPeriodEnd', '<=', window25h)
      .where('cancelAtPeriodEnd', '==', false)
      .limit(200)
      .get();

    if (renewSnap.empty) {
      logger.info('[sub-engine/renewals] No subscriptions due for renewal');
      return;
    }

    const privateKey = INTASEND_PRIVATE_KEY.value();
    if (!privateKey || privateKey === 'YOUR_INTASEND_PRIVATE_KEY') {
      logger.error('[sub-engine/renewals] IntaSend key not configured — skipping');
      return;
    }

    let attempted = 0, succeeded = 0, skipped = 0;

    for (const doc of renewSnap.docs) {
      const sub = { id: doc.id, ...doc.data() };

      /* Skip free plans */
      const monthlyPrice = sub.priceMonthly || 0;
      if (monthlyPrice === 0) { skipped++; continue; }

      /* Idempotency: skip if a renewal payment was already initiated in the last 23h */
      if (sub.renewalRef && sub.renewalInitiatedAt) {
        const initiatedMs = sub.renewalInitiatedAt?.toMillis?.() || 0;
        if (nowMs - initiatedMs < 23 * 3600000) { skipped++; continue; }
      }

      /* Read user phone number */
      const userSnap = await fsdb.collection('users').doc(sub.uid).get().catch(() => null);
      const user     = userSnap?.data() || {};
      const phone    = (user.phoneNumber || user.phone || '').replace(/\D/g, '').replace(/^0/, '254');
      if (!/^254[17]\d{8}$/.test(phone)) {
        logger.warn('[sub-engine/renewals] No valid phone for user', { uid: sub.uid });
        skipped++;
        continue;
      }

      const amountKES = Math.round(
        sub.billingCycle === 'annual' ? (sub.priceAnnual || 0) / 100 : monthlyPrice / 100
      );
      if (!amountKES) { skipped++; continue; }

      const payRef  = `sub_renewal_${sub.id}_${Date.now()}`;
      const narrative = `SOKONI ${sub.planName || 'Subscription'} renewal`;

      attempted++;
      try {
        const stkRes = await _stkPush(privateKey, { phone, amountKES, ref: payRef, narrative });

        if (stkRes.status !== 200 && stkRes.status !== 201) {
          logger.warn('[sub-engine/renewals] STK push failed', { uid: sub.uid, status: stkRes.status });

          /* Increment failed attempts */
          await doc.ref.update({
            failedAttempts: admin.firestore.FieldValue.increment(1),
            updatedAt:      now(),
          });

          /* After 3 failures, notify user their renewal is at risk */
          if ((sub.failedAttempts || 0) >= 2) {
            await _notify(sub.uid, 'renewal_payment_failed', {
              title:    'Subscription renewal failed',
              body:     `We could not charge your M-PESA for ${sub.planName}. Please fund your line.`,
              planName: sub.planName,
              hubType:  sub.hubType,
            });
          }
          continue;
        }

        const checkoutId = stkRes.data?.checkout_id || stkRes.data?.id;

        /* Create payment record */
        await fsdb.collection('payments').doc(payRef).set({
          ref:        payRef,
          checkoutId: checkoutId || null,
          phone,
          amount:     amountKES,
          currency:   'KES',
          status:     'PENDING',
          uid:        sub.uid,
          meta: {
            purpose:        'subscription',
            subscriptionId: sub.id,
            planId:         sub.planId,
            hubType:        sub.hubType,
            billingCycle:   sub.billingCycle,
            planName:       sub.planName,
          },
          createdAt: now(),
          updatedAt: now(),
        });

        /* Mark subscription as renewal-pending */
        await doc.ref.update({
          renewalRef:         payRef,
          renewalStatus:      'pending',
          renewalInitiatedAt: now(),
          failedAttempts:     0,
          updatedAt:          now(),
        });

        await _audit('renewal_payment_initiated', sub.uid, {
          subscriptionId: sub.id,
          planId:         sub.planId,
          amountKES,
          payRef,
        });

        succeeded++;
        logger.info('[sub-engine/renewals] STK initiated', { uid: sub.uid, planId: sub.planId, payRef });

      } catch (err) {
        logger.error('[sub-engine/renewals] Error for subscription', { subId: sub.id, err: err.message });
      }
    }

    logger.info('[sub-engine/renewals] Cycle complete', { attempted, succeeded, skipped });
  }
);

/* ════════════════════════════════════════════════════════════
   CF 2. subAutoActivateOnPayment
   Firestore trigger: fires when a payment document transitions
   to status=COMPLETE. If meta.purpose === 'subscription',
   automatically extends the subscription — no client action needed.
════════════════════════════════════════════════════════════ */
exports.subAutoActivateOnPayment = onDocumentUpdated(
  {
    document:       'payments/{paymentRef}',
    region:         REGION,
    timeoutSeconds: 60,
    memory:         '256MiB',
  },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();

    /* Only fire on COMPLETE transition */
    if (before.status === 'COMPLETE') return;
    if (after.status !== 'COMPLETE') return;

    const meta = after.meta || {};
    if (meta.purpose !== 'subscription') return;

    const { subscriptionId, planId, hubType, billingCycle = 'monthly', uid } = meta;
    const effectiveUid = uid || after.uid;

    if (!subscriptionId || !planId || !effectiveUid) {
      logger.error('[sub-engine/autoActivate] Missing meta fields', { meta });
      return;
    }

    const fsdb   = db();
    const subRef = fsdb.collection('subscriptions').doc(subscriptionId);
    const subSnap = await subRef.get();

    if (!subSnap.exists) {
      logger.error('[sub-engine/autoActivate] Subscription not found', { subscriptionId });
      return;
    }

    const sub = subSnap.data();

    /* Idempotency: skip if already active with a more recent start date */
    const idKey   = `sub_autoact_${subscriptionId}_${event.params.paymentRef}`;
    const idSnap  = await fsdb.collection('finosIdempotency').doc(idKey).get();
    if (idSnap.exists) {
      logger.info('[sub-engine/autoActivate] Duplicate — skipping', { idKey });
      return;
    }

    const amountCents = Math.round((after.amount || 0) * 100);
    const now_dt      = new Date();
    const periodEnd   = _periodEnd(now_dt, billingCycle);
    const graceDays   = sub.tier === 'enterprise' ? 14 : sub.tier === 'pro' ? 7 : sub.tier === 'basic' ? 5 : 3;
    const graceEnd    = _addDays(periodEnd, graceDays);

    await fsdb.runTransaction(async (txn) => {
      /* Extend subscription period */
      txn.update(subRef, {
        status:                'active',
        currentPeriodStart:    ts(now_dt),
        currentPeriodEnd:      ts(periodEnd),
        graceEnd:              ts(graceEnd),
        nextBillingDate:       ts(periodEnd),
        lastPaymentAt:         now(),
        lastPaymentRef:        event.params.paymentRef,
        lastPaymentAmountCents: amountCents,
        failedAttempts:        0,
        renewalStatus:         'completed',
        cancelAtPeriodEnd:     false,
        updatedAt:             now(),
      });

      /* Update fast-read mirror on user profile */
      txn.update(fsdb.collection('users').doc(effectiveUid), {
        [`subscription.${hubType}.status`]:    'active',
        [`subscription.${hubType}.expiresAt`]: ts(periodEnd).toMillis(),
        [`subscription.${hubType}.updatedAt`]: now(),
      });

      /* Idempotency record */
      txn.set(fsdb.collection('finosIdempotency').doc(idKey), {
        idKey, subscriptionId, paymentRef: event.params.paymentRef, createdAt: now(),
      });
    });

    /* Billing history */
    await fsdb.collection('billingHistory').add({
      uid:            effectiveUid,
      subscriptionId,
      planId,
      hubType,
      event:          'renewal_auto',
      amountCents,
      billingCycle,
      paymentRef:     event.params.paymentRef,
      periodEnd:      ts(periodEnd),
      source:         'intasend_webhook_trigger',
      createdAt:      now(),
    });

    /* Notification */
    await _notify(effectiveUid, 'subscription_renewed', {
      title:    'Subscription renewed ✓',
      body:     `Your ${sub.planName || planId} has been renewed. Access continues uninterrupted.`,
      planId,
      hubType,
      expiresAtMs: periodEnd.getTime(),
    });

    await _audit('subscription_auto_renewed', effectiveUid, {
      subscriptionId,
      planId,
      hubType,
      amountCents,
      paymentRef: event.params.paymentRef,
    });

    logger.info('[sub-engine/autoActivate] Subscription auto-renewed', { subscriptionId, planId, effectiveUid });
  }
);

/* ════════════════════════════════════════════════════════════
   CF 3. subUpgradeWithProration
   onCall: calculate and optionally initiate an upgrade.
   Phase 1 (preview=true): returns chargeCents for client to confirm.
   Phase 2 (preview=false + paymentRef): verifies payment, applies
   upgrade immediately, records prorated credit in billing history.
════════════════════════════════════════════════════════════ */
exports.subUpgradeWithProration = onCall(
  {
    region:         REGION,
    timeoutSeconds: 60,
    memory:         '256MiB',
    secrets:        [INTASEND_PRIVATE_KEY],
  },
  async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
    const uid = req.auth.uid;

    const {
      newPlanId,
      billingCycle = 'monthly',
      paymentRef,        /* provided in phase 2 after client pays */
      preview = false,   /* true = return proration only, do not upgrade */
    } = req.data || {};

    if (!newPlanId) throw new HttpsError('invalid-argument', 'newPlanId required');

    const fsdb = db();

    /* Resolve new plan — must exist in subscriptionPlans or sub-billing PLANS */
    const planSnap = await fsdb.collection('subscriptionPlans').doc(newPlanId).get();
    if (!planSnap.exists) throw new HttpsError('not-found', `Plan not found: ${newPlanId}`);
    const newPlan = { id: newPlanId, ...planSnap.data() };
    if (!newPlan.isActive) throw new HttpsError('failed-precondition', 'Plan is not available');
    if (!newPlan.hubType) throw new HttpsError('internal', 'Plan is missing hubType');

    const newPrice = billingCycle === 'annual' ? newPlan.priceAnnual : newPlan.priceMonthly;
    if (newPrice === undefined) throw new HttpsError('internal', 'Plan missing price for billing cycle');

    /* Find current subscription for the same hubType */
    const currentSnap = await fsdb.collection('subscriptions')
      .where('uid', '==', uid)
      .where('hubType', '==', newPlan.hubType)
      .orderBy('updatedAt', 'desc')
      .limit(1)
      .get();

    const currentSub   = currentSnap.empty ? null : { id: currentSnap.docs[0].id, ...currentSnap.docs[0].data() };
    const isActive     = currentSub && ACTIVE_STATUSES.has(currentSub.status);

    /* Compute proration */
    let proration = { creditCents: 0, chargeCents: newPrice, remainingDays: 0 };
    if (isActive && currentSub.planId !== newPlanId) {
      proration = _calculateProration(currentSub, newPrice, billingCycle);
    }

    const chargeKES = Math.round(proration.chargeCents / 100);

    /* Preview mode — return numbers without changing anything */
    if (preview) {
      return {
        newPlanId,
        newPlanName:    newPlan.name || newPlanId,
        billingCycle,
        fullPriceKES:   Math.round(newPrice / 100),
        creditKES:      Math.round(proration.creditCents / 100),
        chargeKES,
        remainingDays:  proration.remainingDays,
        currentPlanId:  currentSub?.planId || null,
      };
    }

    /* Phase 2 — Apply upgrade after payment */
    if (!paymentRef) throw new HttpsError('invalid-argument', 'paymentRef required to apply upgrade');

    /* Idempotency */
    const idKey   = `subupg_${uid}_${newPlanId}_${paymentRef}`;
    const idSnap  = await fsdb.collection('finosIdempotency').doc(idKey).get();
    if (idSnap.exists) {
      const existing = idSnap.data();
      return { subscriptionId: existing.subscriptionId, status: 'active', duplicate: true };
    }

    /* Verify payment */
    const paySnap = await fsdb.collection('payments').doc(paymentRef).get();
    if (!paySnap.exists) {
      /* Also check by trackingId in orders */
      const orderSnap = await fsdb.collection('orders')
        .where('trackingId', '==', paymentRef).where('status', '==', 'paid').limit(1).get();
      if (orderSnap.empty) throw new HttpsError('not-found', 'Payment not found or not completed');
    } else {
      const payData = paySnap.data();
      if (payData.status !== 'COMPLETE' && payData.status !== 'PAID')
        throw new HttpsError('failed-precondition', 'Payment not yet confirmed');
      if (payData.uid !== uid)
        throw new HttpsError('permission-denied', 'Payment does not belong to this user');
    }

    /* Build new subscription period */
    const now_dt    = new Date();
    const periodEnd = _periodEnd(now_dt, billingCycle);
    const graceDays = newPlan.tier === 'enterprise' ? 14 : newPlan.tier === 'pro' ? 7 : 5;
    const graceEnd  = _addDays(periodEnd, graceDays);

    const newSubDoc = {
      uid,
      planId:                newPlanId,
      hubType:               newPlan.hubType,
      tier:                  newPlan.tier || 'basic',
      planName:              newPlan.name || newPlanId,
      status:                'active',
      billingCycle,
      currentPeriodStart:    ts(now_dt),
      currentPeriodEnd:      ts(periodEnd),
      graceEnd:              ts(graceEnd),
      nextBillingDate:       ts(periodEnd),
      features:              { ...(newPlan.features || {}) },
      priceMonthly:          newPlan.priceMonthly || 0,
      priceAnnual:           newPlan.priceAnnual  || 0,
      cancelAtPeriodEnd:     false,
      failedAttempts:        0,
      lastPaymentAt:         now(),
      lastPaymentRef:        paymentRef,
      lastPaymentAmountCents: proration.chargeCents,
      previousPlanId:        currentSub?.planId || null,
      upgradedAt:            now(),
      updatedAt:             now(),
    };

    /* Upsert subscription */
    const subRef = currentSub
      ? fsdb.collection('subscriptions').doc(currentSub.id)
      : fsdb.collection('subscriptions').doc();

    if (!currentSub) newSubDoc.createdAt = now();

    await fsdb.runTransaction(async (txn) => {
      if (currentSub) txn.update(subRef, newSubDoc);
      else            txn.set(subRef, newSubDoc);

      /* Fast-read mirror */
      txn.update(fsdb.collection('users').doc(uid), {
        [`subscription.${newPlan.hubType}.planId`]:    newPlanId,
        [`subscription.${newPlan.hubType}.tier`]:      newPlan.tier,
        [`subscription.${newPlan.hubType}.status`]:    'active',
        [`subscription.${newPlan.hubType}.features`]:  newPlan.features || {},
        [`subscription.${newPlan.hubType}.expiresAt`]: ts(periodEnd).toMillis(),
        [`subscription.${newPlan.hubType}.updatedAt`]: now(),
      });

      /* Idempotency */
      txn.set(fsdb.collection('finosIdempotency').doc(idKey), {
        idKey, uid, newPlanId, paymentRef, subscriptionId: subRef.id, createdAt: now(),
      });
    });

    /* Billing history */
    await fsdb.collection('billingHistory').add({
      uid, subscriptionId: subRef.id, planId: newPlanId,
      hubType:       newPlan.hubType,
      event:         'upgrade',
      amountCents:   proration.chargeCents,
      fullPriceCents: newPrice,
      creditCents:   proration.creditCents,
      billingCycle,
      paymentRef,
      previousPlanId: currentSub?.planId || null,
      createdAt:      now(),
    });

    /* Notification */
    await _notify(uid, 'subscription_upgraded', {
      title:   `Upgraded to ${newPlan.name || newPlanId} ✓`,
      body:    `Your new plan is active. All features unlocked immediately.`,
      planId:  newPlanId,
      hubType: newPlan.hubType,
      expiresAtMs: periodEnd.getTime(),
    });

    await _audit('subscription_upgraded', uid, {
      subscriptionId: subRef.id,
      newPlanId,
      previousPlanId: currentSub?.planId || null,
      chargeCents:    proration.chargeCents,
      creditCents:    proration.creditCents,
      paymentRef,
    });

    logger.info('[sub-engine/upgrade] Plan upgraded', {
      uid, newPlanId, subscriptionId: subRef.id,
      chargeKES,
      creditKES: Math.round(proration.creditCents / 100),
    });

    return {
      subscriptionId: subRef.id,
      planId:         newPlanId,
      status:         'active',
      chargeKES,
      creditKES:      Math.round(proration.creditCents / 100),
      expiresAtMs:    periodEnd.getTime(),
      features:       newPlan.features || {},
    };
  }
);
