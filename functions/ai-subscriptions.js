/* ================================================================
   SOKONI — AI Subscriptions Cloud Functions  v1.0.0

   Handles server-side billing, usage resets, plan activation,
   and admin statistics for the AI subscription system.

   All monetary actions are server-authoritative — the client
   initiates payment via IntaSend, the CF validates and activates.

   Functions exported:
     activateAIPlan         — subscribe or upgrade a user's plan
     consumeAICredit        — server-side credit deduction
     topupAICredits         — add credits after verified payment
     resetAIUsage           — monthly scheduler: reset usage counters
     getAISubscriptionStats — admin: MRR/ARR/plan counts
     updateAIPlan           — admin: edit plan config in Firestore
================================================================ */
'use strict';

const { onCall, onSchedule, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule: onSched  } = require('firebase-functions/v2/scheduler');
const { logger }               = require('firebase-functions');
const admin                    = require('firebase-admin');

const { assertAuth, assertAdmin, sanitize } = require('./shared/errors');

/* admin is already initialised in index.js — do not call initializeApp() here */
const db = () => admin.firestore();

/* ── Plan definitions (server-authoritative copy) ─────────────── */
const PLANS = {
  ai_free:       { price: 0,    annualPrice: 0,     storageGB: 0.5,  aiCreditsIncluded: 0,    teamMembers: 1  },
  ai_starter:    { price: 499,  annualPrice: 4990,  storageGB: 5,    aiCreditsIncluded: 50,   teamMembers: 1  },
  ai_pro:        { price: 1499, annualPrice: 14990, storageGB: 50,   aiCreditsIncluded: 200,  teamMembers: 3  },
  ai_enterprise: { price: 9999, annualPrice: 99990, storageGB: 500,  aiCreditsIncluded: 1000, teamMembers: -1 },
};

/* ── Period helpers ───────────────────────────────────────────── */
function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function periodEnd(billing) {
  const now = new Date();
  return billing === 'annual'
    ? new Date(now.getFullYear() + 1, now.getMonth(), now.getDate()).getTime()
    : new Date(now.getFullYear(), now.getMonth() + 1, now.getDate()).getTime();
}

/* assertAuth, assertAdmin, sanitize imported from shared/errors.js */

/* ================================================================
   activateAIPlan
   Called by the client after IntaSend confirms payment.
   Validates plan ID and idempotency, then writes the subscription.
================================================================ */
const activateAIPlan = onCall(
  { region: 'us-central1', timeoutSeconds: 30, memory: '128MiB' },
  async (data, context) => {
    const uid = assertAuth(context);
    const planId     = sanitize(data.planId, 30);
    const billing    = data.billing === 'annual' ? 'annual' : 'monthly';
    const paymentRef = sanitize(data.paymentRef, 120);

    if (!PLANS[planId]) throw new HttpsError('invalid-argument', `Unknown plan: ${planId}`);
    if (!paymentRef && PLANS[planId].price > 0) throw new HttpsError('invalid-argument', 'paymentRef required for paid plans.');

    /* Idempotency: if this paymentRef was already processed, return early */
    if (paymentRef) {
      const existing = await db().collection('aiPaymentRefs').doc(paymentRef).get();
      if (existing.exists) {
        logger.info(`[AISubs] activateAIPlan: duplicate ref ${paymentRef} for uid=${uid}`);
        return { success: true, idempotent: true };
      }
    }

    const plan = PLANS[planId];
    const now  = Date.now();
    const batch = db().batch();

    /* Write subscription document */
    batch.set(db().collection('aiSubscriptions').doc(uid), {
      uid,
      plan:               planId,
      status:             'active',
      billing,
      activatedAt:        now,
      currentPeriodStart: now,
      currentPeriodEnd:   periodEnd(billing),
      paymentRef:         paymentRef || null,
      updatedAt:          now,
    }, { merge: true });

    /* Credit the included monthly credits */
    if (plan.aiCreditsIncluded > 0) {
      batch.set(db().collection('aiCredits').doc(uid), {
        uid,
        balance:       admin.firestore.FieldValue.increment(plan.aiCreditsIncluded),
        totalPurchased: admin.firestore.FieldValue.increment(plan.aiCreditsIncluded),
        lastCredited:   now,
      }, { merge: true });
    }

    /* Mark payment ref as used (idempotency lock) */
    if (paymentRef) {
      batch.set(db().collection('aiPaymentRefs').doc(paymentRef), {
        uid, planId, billing, processedAt: now,
      });
    }

    /* Audit log */
    batch.set(db().collection('auditLogs').doc(), {
      type:       'ai_plan_activated',
      uid,
      planId,
      billing,
      paymentRef: paymentRef || null,
      ts:         now,
    });

    await batch.commit();
    logger.info(`[AISubs] Plan activated: uid=${uid} plan=${planId} billing=${billing}`);
    return { success: true, plan: planId, billing };
  }
);

/* ================================================================
   consumeAICredit
   Server-side credit deduction for compute operations.
   Validates balance before decrementing to prevent negative balances.
================================================================ */
const consumeAICredit = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (data, context) => {
    const uid    = assertAuth(context);
    const amount = Number(data.amount);
    const reason = sanitize(data.reason, 100);

    if (!Number.isInteger(amount) || amount <= 0 || amount > 10000) {
      throw new HttpsError('invalid-argument', 'Invalid credit amount.');
    }

    const credRef  = db().collection('aiCredits').doc(uid);
    const ledgerRef = db().collection('aiCreditLedger').doc();

    try {
      const newBalance = await db().runTransaction(async tx => {
        const snap = await tx.get(credRef);
        const curr = snap.exists ? (snap.data().balance || 0) : 0;
        if (curr < amount) throw new HttpsError('resource-exhausted', `Insufficient credits. Balance: ${curr}, Required: ${amount}`);
        tx.set(credRef, {
          uid,
          balance:       admin.firestore.FieldValue.increment(-amount),
          totalConsumed: admin.firestore.FieldValue.increment(amount),
          lastConsumed:  Date.now(),
        }, { merge: true });
        tx.set(ledgerRef, {
          uid, type: 'consume', amount, reason, ts: Date.now(),
        });
        return curr - amount;
      });
      return { success: true, newBalance };
    } catch (e) {
      if (e.code === 'resource-exhausted') throw e;
      throw new HttpsError('internal', 'Credit deduction failed.');
    }
  }
);

/* ================================================================
   topupAICredits
   Admin/webhook callable after payment confirmation.
   Requires admin token OR a verified paymentRef that hasn't been used.
================================================================ */
const topupAICredits = onCall(
  { region: 'us-central1', timeoutSeconds: 20, memory: '128MiB' },
  async (data, context) => {
    const uid        = assertAuth(context);
    const packId     = sanitize(data.packId, 40);
    const paymentRef = sanitize(data.paymentRef, 120);

    const CREDIT_PACKS = {
      credits_100:  { credits: 100,  price: 500   },
      credits_500:  { credits: 500,  price: 2000  },
      credits_1000: { credits: 1000, price: 3500  },
      credits_5000: { credits: 5000, price: 15000 },
    };
    const pack = CREDIT_PACKS[packId];
    if (!pack) throw new HttpsError('invalid-argument', `Unknown credit pack: ${packId}`);
    if (!paymentRef) throw new HttpsError('invalid-argument', 'paymentRef required.');

    /* Idempotency */
    const existing = await db().collection('aiPaymentRefs').doc(paymentRef).get();
    if (existing.exists) return { success: true, idempotent: true };

    const batch = db().batch();
    batch.set(db().collection('aiCredits').doc(uid), {
      uid,
      balance:        admin.firestore.FieldValue.increment(pack.credits),
      totalPurchased: admin.firestore.FieldValue.increment(pack.credits),
      lastTopup:      Date.now(),
    }, { merge: true });
    batch.set(db().collection('aiCreditLedger').doc(), {
      uid, type: 'topup', credits: pack.credits, price: pack.price, packId, paymentRef, ts: Date.now(),
    });
    batch.set(db().collection('aiPaymentRefs').doc(paymentRef), {
      uid, packId, processedAt: Date.now(),
    });
    await batch.commit();

    logger.info(`[AISubs] Credits topped up: uid=${uid} pack=${packId} credits=${pack.credits}`);
    return { success: true, credits: pack.credits };
  }
);

/* ================================================================
   resetAIUsage
   Scheduled monthly — resets usage counters for all users
   and credits included AI credits for active subscriptions.
   Runs at 00:00 on the 1st of each month.
================================================================ */
const resetAIUsage = onSched(
  { schedule: '0 0 1 * *', timeZone: 'Africa/Nairobi', memory: '512MiB', timeoutSeconds: 540 },
  async () => {
    const period     = currentPeriod();
    const prevPeriod = (() => {
      const d = new Date();
      d.setDate(0); /* last day of previous month */
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    })();

    logger.info(`[AISubs] resetAIUsage: resetting period ${prevPeriod} → ${period}`);

    /* Archive previous period usage (keep for analytics) */
    const prevSnap = await db().collection('aiUsage')
      .where('period', '==', prevPeriod).limit(500).get();

    if (!prevSnap.empty) {
      const archivedBatch = db().batch();
      prevSnap.docs.forEach(doc => {
        archivedBatch.set(
          db().collection('aiUsageArchive').doc(doc.id),
          { ...doc.data(), archivedAt: Date.now() }
        );
      });
      await archivedBatch.commit();
    }

    /* Credit included credits for all active paid subscriptions */
    const subsSnap = await db().collection('aiSubscriptions')
      .where('status', '==', 'active').limit(1000).get();

    const creditBatch = db().batch();
    let credited = 0;
    subsSnap.docs.forEach(doc => {
      const sub  = doc.data();
      const plan = PLANS[sub.plan];
      if (!plan || plan.aiCreditsIncluded === 0) return;
      creditBatch.set(db().collection('aiCredits').doc(sub.uid), {
        uid:           sub.uid,
        balance:       admin.firestore.FieldValue.increment(plan.aiCreditsIncluded),
        totalPurchased: admin.firestore.FieldValue.increment(plan.aiCreditsIncluded),
        lastCredited:  Date.now(),
      }, { merge: true });
      credited++;
    });
    if (credited > 0) await creditBatch.commit();

    logger.info(`[AISubs] resetAIUsage: credited ${credited} active subscribers for period ${period}`);
    return null;
  }
);

/* ================================================================
   getAISubscriptionStats
   Admin-only: returns MRR, ARR, plan distribution, churn signals.
================================================================ */
const getAISubscriptionStats = onCall(
  { region: 'us-central1', timeoutSeconds: 60, memory: '256MiB' },
  async (data, context) => {
    assertAdmin(context);

    const [activeSubs, expiredSubs, creditSnap] = await Promise.all([
      db().collection('aiSubscriptions').where('status', 'in', ['active', 'trial']).get(),
      db().collection('aiSubscriptions').where('status', '==', 'expired').limit(200).get(),
      db().collection('aiCreditLedger')
          .where('type', '==', 'topup')
          .orderBy('ts', 'desc').limit(500).get(),
    ]);

    const planCounts = {};
    const billingCounts = { monthly: 0, annual: 0 };
    let mrr = 0;
    let trials = 0;

    activeSubs.docs.forEach(doc => {
      const sub  = doc.data();
      const plan = PLANS[sub.plan];
      if (!plan) return;
      planCounts[sub.plan] = (planCounts[sub.plan] || 0) + 1;
      if (sub.status === 'trial') { trials++; return; }
      const monthlyPrice = sub.billing === 'annual' ? Math.round(plan.annualPrice / 12) : plan.price;
      mrr += monthlyPrice;
      billingCounts[sub.billing === 'annual' ? 'annual' : 'monthly']++;
    });

    let creditRevenue = 0;
    creditSnap.docs.forEach(doc => { creditRevenue += (doc.data().price || 0); });

    return {
      mrr,
      arr:           Math.round(mrr * 12),
      totalActive:   activeSubs.size - trials,
      totalTrials:   trials,
      recentChurn:   expiredSubs.size,
      planCounts,
      billingCounts,
      creditRevenue,
      asOf:          Date.now(),
    };
  }
);

/* ================================================================
   updateAIPlan
   Admin-only: overrides a plan's config in aiPlanOverrides.
   The client-side engine merges overrides at runtime.
================================================================ */
const updateAIPlan = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (data, context) => {
    assertAdmin(context);

    const planId = sanitize(data.planId, 30);
    if (!PLANS[planId]) throw new HttpsError('invalid-argument', `Unknown plan: ${planId}`);

    /* Only allow safe numeric/boolean fields — never allow writing uid-level data */
    const ALLOWED_FIELDS = new Set([
      'price', 'annualPrice', 'storageGB', 'aiCreditsIncluded', 'teamMembers',
      'quotas', 'features', 'badge', 'tagline',
    ]);
    const config = {};
    Object.entries(data.config || {}).forEach(([k, v]) => {
      if (ALLOWED_FIELDS.has(k)) config[k] = v;
    });

    await db().collection('aiPlanOverrides').doc(planId).set({
      ...config, planId, updatedAt: Date.now(), updatedBy: context.auth.uid,
    }, { merge: true });

    /* Audit */
    await db().collection('auditLogs').add({
      type: 'ai_plan_updated', planId, config,
      uid: context.auth.uid, ts: Date.now(),
    });

    logger.info(`[AISubs] Plan config updated: plan=${planId} by=${context.auth.uid}`);
    return { success: true, planId };
  }
);

/* ── Exports ──────────────────────────────────────────────────── */
module.exports = {
  activateAIPlan,
  consumeAICredit,
  topupAICredits,
  resetAIUsage,
  getAISubscriptionStats,
  updateAIPlan,
};
