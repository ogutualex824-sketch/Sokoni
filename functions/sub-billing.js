/* ================================================================
   SOKONI Automated Subscription & Billing Engine  v1.0
   15 Cloud Functions (Gen2):
     subGetPlans              — public: list plans per hub type
     subGetStatus             — authenticated: active subscriptions + features
     subActivate              — authenticated: activate after payment
     subCancel                — authenticated: cancel at period-end or immediately
     subReactivate            — authenticated: un-cancel a pending-cancellation
     subGetBillingHistory     — authenticated: user's payment history
     adminSubCreatePlan       — admin: create a custom plan
     adminSubUpdatePlan       — admin: override built-in or edit custom plan
     adminSubListSubscriptions— admin: search / list all subscriptions
     adminSubGetAnalytics     — admin: MRR, churn, counts
     adminSubManualAction     — admin: activate / expire / extend / trial
     adminSubProcessRefund    — admin: refund a billing record
     adminSubExportBilling    — admin: CSV-friendly export
     subProcessExpirations    — scheduled hourly: expire + downgrade
     subSendRenewalReminders  — scheduled daily 8am: 7-day warnings
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const logger                 = require('firebase-functions/logger');
const admin                  = require('firebase-admin');

const REGION = 'us-central1';
const db     = () => admin.firestore();
const now    = () => admin.firestore.FieldValue.serverTimestamp();
const ts     = (d) => admin.firestore.Timestamp.fromDate(new Date(d));

function assertAuth(req)  { if (!req.auth) throw new HttpsError('unauthenticated', 'Login required'); }
function assertAdmin(req) {
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Admin access required');
}

/* ── Status enum ── */
const S = { TRIALING:'trialing', ACTIVE:'active', PAST_DUE:'past_due',
            GRACE:'grace', EXPIRED:'expired', CANCELLED:'cancelled' };

/* ================================================================
   PLAN CATALOG  — single source of truth for all SOKONI hub types
   All prices in KES cents. -1 = unlimited.
   To override a built-in plan, use adminSubUpdatePlan (saves to
   subscriptionPlans/{id} in Firestore; takes priority at runtime).
================================================================ */
const PLANS = {

  /* ── SELLERS ── */
  seller_free:       { id:'seller_free',       hubType:'seller',       tier:'free',       name:'Seller Free',       price:{monthly:0,       annual:0        }, trial:{days:0},  grace:{days:0},  isActive:true,
    features:{ listings_limit:10,   photos_per_listing:3,  featured_listings:0, analytics:false, bulk_import:false, priority_support:false, ai_assistant:false, team_members:1, storage_gb:1,  commission_discount_pct:0,  badge_verified:false }},
  seller_basic:      { id:'seller_basic',      hubType:'seller',       tier:'basic',      name:'Seller Basic',      price:{monthly:99900,   annual:999000   }, trial:{days:14}, grace:{days:3},  isActive:true,
    features:{ listings_limit:100,  photos_per_listing:6,  featured_listings:2, analytics:true,  bulk_import:false, priority_support:false, ai_assistant:false, team_members:2, storage_gb:5,  commission_discount_pct:2,  badge_verified:true  }},
  seller_pro:        { id:'seller_pro',        hubType:'seller',       tier:'pro',        name:'Seller Pro',        price:{monthly:249900,  annual:2499000  }, trial:{days:14}, grace:{days:5},  isActive:true,
    features:{ listings_limit:500,  photos_per_listing:10, featured_listings:5, analytics:true,  bulk_import:true,  priority_support:true,  ai_assistant:true,  team_members:5, storage_gb:20, commission_discount_pct:5,  badge_verified:true, api_access:true }},
  seller_enterprise: { id:'seller_enterprise', hubType:'seller',       tier:'enterprise', name:'Seller Enterprise', price:{monthly:749900,  annual:7499000  }, trial:{days:30}, grace:{days:7},  isActive:true,
    features:{ listings_limit:-1,   photos_per_listing:20, featured_listings:-1,analytics:true,  bulk_import:true,  priority_support:true,  ai_assistant:true,  team_members:-1,storage_gb:100,commission_discount_pct:10, badge_verified:true, api_access:true, custom_domain:true, dedicated_account_manager:true }},

  /* ── SERVICE PROVIDERS ── */
  provider_free:     { id:'provider_free',     hubType:'service_provider', tier:'free',  name:'Provider Free',     price:{monthly:0,       annual:0        }, trial:{days:0},  grace:{days:0},  isActive:true,
    features:{ services_limit:3,    calendar:false, online_booking:true,  analytics:false, priority_listing:false, team_members:1, ai_assistant:false }},
  provider_basic:    { id:'provider_basic',    hubType:'service_provider', tier:'basic', name:'Provider Basic',    price:{monthly:99900,   annual:999000   }, trial:{days:14}, grace:{days:3},  isActive:true,
    features:{ services_limit:20,   calendar:true,  online_booking:true,  analytics:true,  priority_listing:false, team_members:3, ai_assistant:false }},
  provider_pro:      { id:'provider_pro',      hubType:'service_provider', tier:'pro',   name:'Provider Pro',      price:{monthly:249900,  annual:2499000  }, trial:{days:14}, grace:{days:5},  isActive:true,
    features:{ services_limit:-1,   calendar:true,  online_booking:true,  analytics:true,  priority_listing:true,  team_members:10,ai_assistant:true,  bulk_import:true }},

  /* ── RESTAURANTS ── */
  restaurant_free:   { id:'restaurant_free',   hubType:'restaurant',   tier:'free',       name:'Restaurant Free',   price:{monthly:0,       annual:0        }, trial:{days:0},  grace:{days:0},  isActive:true,
    features:{ menu_items:20,       online_ordering:false, delivery_zones:1,    table_reservations:false, analytics:false, team_members:1  }},
  restaurant_basic:  { id:'restaurant_basic',  hubType:'restaurant',   tier:'basic',      name:'Restaurant Basic',  price:{monthly:149900,  annual:1499000  }, trial:{days:14}, grace:{days:3},  isActive:true,
    features:{ menu_items:100,      online_ordering:true,  delivery_zones:3,    table_reservations:false, analytics:true,  team_members:5,  ai_assistant:false }},
  restaurant_pro:    { id:'restaurant_pro',    hubType:'restaurant',   tier:'pro',        name:'Restaurant Pro',    price:{monthly:299900,  annual:2999000  }, trial:{days:14}, grace:{days:5},  isActive:true,
    features:{ menu_items:-1,       online_ordering:true,  delivery_zones:-1,   table_reservations:true,  analytics:true,  team_members:20, ai_assistant:true, kds_integration:true, pos_integration:true }},

  /* ── HOTELS ── */
  hotel_free:        { id:'hotel_free',        hubType:'hotel',        tier:'free',       name:'Hotel Free',        price:{monthly:0,       annual:0        }, trial:{days:0},  grace:{days:0},  isActive:true,
    features:{ room_types:2,        booking_calendar:true, channel_manager:false, analytics:false, team_members:1 }},
  hotel_pro:         { id:'hotel_pro',         hubType:'hotel',        tier:'pro',        name:'Hotel Pro',         price:{monthly:299900,  annual:2999000  }, trial:{days:14}, grace:{days:5},  isActive:true,
    features:{ room_types:-1,       booking_calendar:true, channel_manager:true,  analytics:true,  team_members:20, ai_assistant:true, pos_integration:true }},
  hotel_enterprise:  { id:'hotel_enterprise',  hubType:'hotel',        tier:'enterprise', name:'Hotel Enterprise',  price:{monthly:599900,  annual:5999000  }, trial:{days:30}, grace:{days:7},  isActive:true,
    features:{ room_types:-1,       booking_calendar:true, channel_manager:true,  analytics:true,  team_members:-1, ai_assistant:true, pos_integration:true, custom_domain:true, multi_branch:true }},

  /* ── PHARMACIES ── */
  pharmacy_free:     { id:'pharmacy_free',     hubType:'pharmacy',     tier:'free',       name:'Pharmacy Free',     price:{monthly:0,       annual:0        }, trial:{days:0},  grace:{days:0},  isActive:true,
    features:{ products_limit:50,   prescription_upload:false, delivery:false,   analytics:false, team_members:2  }},
  pharmacy_pro:      { id:'pharmacy_pro',      hubType:'pharmacy',     tier:'pro',        name:'Pharmacy Pro',      price:{monthly:149900,  annual:1499000  }, trial:{days:14}, grace:{days:5},  isActive:true,
    features:{ products_limit:-1,   prescription_upload:true,  delivery:true,    analytics:true,  team_members:10, ai_assistant:true, etims:true }},

  /* ── DRIVERS ── */
  driver_free:       { id:'driver_free',       hubType:'driver',       tier:'free',       name:'Driver Free',       price:{monthly:0,       annual:0        }, trial:{days:0},  grace:{days:0},  isActive:true,
    features:{ priority_dispatch:false, earnings_analytics:false, bonus_multiplier:1 }},
  driver_pro:        { id:'driver_pro',        hubType:'driver',       tier:'pro',        name:'Driver Pro',        price:{monthly:49900,   annual:499000   }, trial:{days:7},  grace:{days:3},  isActive:true,
    features:{ priority_dispatch:true,  earnings_analytics:true,  bonus_multiplier:1.2 }},

  /* ── PROPERTY AGENTS ── */
  property_free:     { id:'property_free',     hubType:'property_agent',tier:'free',      name:'Property Free',     price:{monthly:0,       annual:0        }, trial:{days:0},  grace:{days:0},  isActive:true,
    features:{ listings_limit:5,    photos_per_listing:4, featured_listings:0, analytics:false }},
  property_pro:      { id:'property_pro',      hubType:'property_agent',tier:'pro',       name:'Property Pro',      price:{monthly:299900,  annual:2999000  }, trial:{days:14}, grace:{days:5},  isActive:true,
    features:{ listings_limit:-1,   photos_per_listing:20,featured_listings:10,analytics:true,  virtual_tours:true, team_members:5, ai_assistant:true }},

  /* ── CAR DEALERS ── */
  car_dealer_free:   { id:'car_dealer_free',   hubType:'car_dealer',   tier:'free',       name:'Car Dealer Free',   price:{monthly:0,       annual:0        }, trial:{days:0},  grace:{days:0},  isActive:true,
    features:{ listings_limit:5,    photos_per_listing:5, featured_listings:0, analytics:false }},
  car_dealer_pro:    { id:'car_dealer_pro',    hubType:'car_dealer',   tier:'pro',        name:'Car Dealer Pro',    price:{monthly:249900,  annual:2499000  }, trial:{days:14}, grace:{days:5},  isActive:true,
    features:{ listings_limit:-1,   photos_per_listing:20,featured_listings:5, analytics:true,  team_members:5, ai_assistant:true, vehicle_history:true }},

  /* ── FREELANCERS ── */
  freelancer_free:   { id:'freelancer_free',   hubType:'freelancer',   tier:'free',       name:'Freelancer Free',   price:{monthly:0,       annual:0        }, trial:{days:0},  grace:{days:0},  isActive:true,
    features:{ services_limit:3,    portfolio_items:5,  featured_listing:false, analytics:false }},
  freelancer_pro:    { id:'freelancer_pro',    hubType:'freelancer',   tier:'pro',        name:'Freelancer Pro',    price:{monthly:99900,   annual:999000   }, trial:{days:14}, grace:{days:3},  isActive:true,
    features:{ services_limit:-1,   portfolio_items:-1, featured_listing:true,  analytics:true, commission_discount_pct:3, ai_assistant:true }},

  /* ── RECRUITERS ── */
  recruiter_free:    { id:'recruiter_free',    hubType:'recruiter',    tier:'free',       name:'Recruiter Free',    price:{monthly:0,       annual:0        }, trial:{days:0},  grace:{days:0},  isActive:true,
    features:{ job_posts:3,         cv_database_access:false, analytics:false }},
  recruiter_pro:     { id:'recruiter_pro',     hubType:'recruiter',    tier:'pro',        name:'Recruiter Pro',     price:{monthly:199900,  annual:1999000  }, trial:{days:14}, grace:{days:3},  isActive:true,
    features:{ job_posts:-1,        cv_database_access:true,  analytics:true, featured_posts:5, ai_screening:true, team_members:5 }},

  /* ── PREMIUM BUYERS ── */
  buyer_free:        { id:'buyer_free',        hubType:'buyer',        tier:'free',       name:'Buyer Free',        price:{monthly:0,       annual:0        }, trial:{days:0},  grace:{days:0},  isActive:true,
    features:{ early_access:false, exclusive_deals:false, priority_support:false, wishlist_limit:50 }},
  buyer_premium:     { id:'buyer_premium',     hubType:'buyer',        tier:'premium',    name:'Buyer Premium',     price:{monthly:29900,   annual:299000   }, trial:{days:7},  grace:{days:2},  isActive:true,
    features:{ early_access:true,  exclusive_deals:true,  priority_support:true,  wishlist_limit:-1, cashback_pct:2, free_delivery:true }},

  /* ── ENTERPRISE ── */
  enterprise:        { id:'enterprise',        hubType:'enterprise',   tier:'enterprise', name:'Enterprise',        price:{monthly:999900,  annual:9999000  }, trial:{days:30}, grace:{days:14}, isActive:true,
    features:{ listings_limit:-1, team_members:-1, storage_gb:500, api_access:true, custom_domain:true, sla:'99.9%', dedicated_account_manager:true, white_label:true, analytics:true, ai_assistant:true, priority_support:true, commission_discount_pct:15 }},
};

/* ── helpers ── */
function _getPlan(planId) {
  const p = PLANS[planId];
  if (!p) throw new HttpsError('not-found', `Plan not found: ${planId}`);
  return p;
}
function _addMonths(d, n) { const r = new Date(d); r.setMonth(r.getMonth() + n); return r; }
function _addDays(d, n)   { const r = new Date(d); r.setDate(r.getDate() + n);   return r; }
function _periodEnd(start, cycle) { return cycle === 'annual' ? _addMonths(start, 12) : _addMonths(start, 1); }
function _centsToKES(c)   { return Math.round((c || 0) / 100); }

function _buildSubDoc(uid, plan, cycle, status) {
  const start    = new Date();
  const isTrialing = status === S.TRIALING;
  const end      = isTrialing ? _addDays(start, plan.trial.days) : _periodEnd(start, cycle);
  const graceEnd = _addDays(end, plan.grace.days);
  return {
    uid, planId: plan.id, hubType: plan.hubType, tier: plan.tier,
    planName: plan.name, status, billingCycle: cycle,
    currentPeriodStart: ts(start), currentPeriodEnd: ts(end), graceEnd: ts(graceEnd),
    nextBillingDate: ts(end),
    features: { ...plan.features },
    priceMonthly: plan.price.monthly, priceAnnual: plan.price.annual,
    cancelAtPeriodEnd: false, failedAttempts: 0,
    lastPaymentAt: null, lastPaymentRef: null, lastPaymentAmountCents: null,
    updatedAt: now(),
  };
}

async function _notify(uid, type, data) {
  try { await db().collection('notifications').add({ uid, type, ...data, read: false, createdAt: now() }); }
  catch(e) { logger.warn('[sub] notify failed', { uid, type }); }
}
async function _audit(action, uid, data) {
  await db().collection('subscriptionAuditLog').add({ action, uid, ...data, timestamp: now() });
}
function _serialize(d) {
  if (!d) return d;
  const out = { ...d };
  ['currentPeriodStart','currentPeriodEnd','graceEnd','nextBillingDate',
   'lastPaymentAt','updatedAt','createdAt','timestamp'].forEach(k => {
    if (out[k]?.toMillis) out[k] = out[k].toMillis();
  });
  return out;
}

/* ── Merge built-in plan with any Firestore override ── */
async function _resolvePlan(planId) {
  const base = PLANS[planId];
  const snap = await db().collection('subscriptionPlans').doc(planId).get();
  if (snap.exists) return { ...(base || {}), ...snap.data(), id: planId };
  if (base) return base;
  throw new HttpsError('not-found', `Plan not found: ${planId}`);
}

/* ════════════════════════════════════════════════════════
   1. subGetPlans — public: list available plans
════════════════════════════════════════════════════════ */
exports.subGetPlans = onCall(
  { region: REGION, timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    const { hubType } = req.data || {};

    const [customSnap, builtIn] = await Promise.all([
      db().collection('subscriptionPlans').where('isActive', '==', true).get(),
      Promise.resolve(PLANS),
    ]);

    const merged = { ...builtIn };
    customSnap.docs.forEach(d => { merged[d.id] = { ...merged[d.id], ...d.data(), id: d.id }; });

    let plans = Object.values(merged).filter(p => p.isActive !== false);
    if (hubType) plans = plans.filter(p => p.hubType === hubType || p.hubType === 'enterprise');
    plans.sort((a, b) => (a.price?.monthly || 0) - (b.price?.monthly || 0));

    return { plans };
  }
);

/* ════════════════════════════════════════════════════════
   2. subGetStatus — authenticated: all subscriptions + features
════════════════════════════════════════════════════════ */
exports.subGetStatus = onCall(
  { region: REGION, timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    assertAuth(req);
    const uid = req.auth.uid;

    const snap = await db().collection('subscriptions')
      .where('uid', '==', uid)
      .orderBy('updatedAt', 'desc')
      .limit(20)
      .get();

    const all = snap.docs.map(d => _serialize({ id: d.id, ...d.data() }));

    /* Best active sub per hub type */
    const byHub = {};
    const PRIORITY = { [S.ACTIVE]:5, [S.TRIALING]:4, [S.GRACE]:3, [S.PAST_DUE]:2, [S.EXPIRED]:1, [S.CANCELLED]:0 };
    all.forEach(s => {
      const cur = byHub[s.hubType];
      if (!cur || (PRIORITY[s.status] || 0) > (PRIORITY[cur.status] || 0)) byHub[s.hubType] = s;
    });

    return { subscriptions: byHub, all };
  }
);

/* ════════════════════════════════════════════════════════
   3. subActivate — called after payment succeeds
   Verifies the payment against the payments collection,
   then activates / upgrades the subscription.
════════════════════════════════════════════════════════ */
exports.subActivate = onCall(
  { region: REGION, timeoutSeconds: 60, memory: '256MiB' },
  async (req) => {
    assertAuth(req);
    const { planId, billingCycle, paymentRef, isTrial } = req.data || {};
    if (!planId) throw new HttpsError('invalid-argument', 'planId required');

    const cycle = billingCycle === 'annual' ? 'annual' : 'monthly';
    const uid   = req.auth.uid;
    const plan  = await _resolvePlan(planId);
    const amountDue = plan.price[cycle];
    const fsdb  = db();

    /* Idempotency — same payment ref can't activate twice */
    if (paymentRef && amountDue > 0) {
      const idKey  = `subact_${uid}_${paymentRef}`;
      const idem   = await fsdb.collection('finosIdempotency').doc(idKey).get();
      if (idem.exists) return { status: 'already_active', subscriptionId: idem.data().subscriptionId };
    }

    /* Verify payment for paid plans (skip for free / trial) */
    if (amountDue > 0 && !isTrial) {
      if (!paymentRef) throw new HttpsError('invalid-argument', 'paymentRef required for paid plans');

      const paySnap = await fsdb.collection('payments').doc(paymentRef).get();
      if (!paySnap.exists || paySnap.data().status !== 'completed') {
        /* Also check orders collection (verifyIntasendPayment path) */
        const ordSnap = await fsdb.collection('orders')
          .where('trackingId', '==', paymentRef)
          .where('status', '==', 'paid')
          .limit(1).get();
        if (ordSnap.empty) throw new HttpsError('failed-precondition', 'Payment not confirmed. Complete payment first.');
      }
    }

    const status = (isTrial && plan.trial.days > 0) ? S.TRIALING
                 : amountDue === 0                  ? S.ACTIVE
                                                    : S.ACTIVE;

    /* Find any existing active sub for this hub type */
    const existSnap = await fsdb.collection('subscriptions')
      .where('uid', '==', uid)
      .where('hubType', '==', plan.hubType)
      .where('status', 'in', [S.ACTIVE, S.TRIALING, S.GRACE, S.PAST_DUE, S.EXPIRED])
      .limit(1).get();

    const existing  = existSnap.empty ? null : existSnap.docs[0];
    const subDoc    = _buildSubDoc(uid, plan, cycle, status);
    if (paymentRef && amountDue > 0) {
      subDoc.lastPaymentAt          = now();
      subDoc.lastPaymentRef         = paymentRef;
      subDoc.lastPaymentAmountCents = amountDue;
    }

    let subId;
    await fsdb.runTransaction(async (txn) => {
      let subRef;
      if (existing) {
        subRef = existing.ref;
        subDoc.createdAt      = existing.data().createdAt; /* preserve signup date */
        subDoc.previousPlanId = existing.data().planId;
        subDoc.upgradedAt     = now();
        txn.set(subRef, subDoc);
      } else {
        subRef       = fsdb.collection('subscriptions').doc();
        subDoc.createdAt = now();
        txn.set(subRef, subDoc);
      }
      subId = subRef.id;

      /* Idempotency record */
      if (paymentRef && amountDue > 0) {
        txn.set(fsdb.collection('finosIdempotency').doc(`subact_${uid}_${paymentRef}`), {
          uid, paymentRef, subscriptionId: subRef.id, planId, createdAt: now(),
        });
      }

      /* Mirror key fields onto user profile for fast client reads */
      txn.set(fsdb.collection('users').doc(uid), {
        [`subscription.${plan.hubType}`]: {
          planId, tier: plan.tier, status,
          features: plan.features,
          expiresAt: subDoc.currentPeriodEnd,
          updatedAt: now(),
        },
        updatedAt: now(),
      }, { merge: true });
    });

    /* Billing history */
    if (amountDue > 0 && paymentRef) {
      await fsdb.collection('billingHistory').add({
        uid, subscriptionId: subId, planId, hubType: plan.hubType,
        amountCents: amountDue, currency: 'KES',
        paymentRef, billingCycle: cycle,
        event: existing ? 'upgrade' : 'subscribe',
        refunded: false, createdAt: now(),
      });
    }

    await Promise.all([
      _audit(existing ? 'subscription_upgraded' : 'subscription_created', uid, {
        subscriptionId: subId, planId, cycle, amountDue,
        previousPlanId: existing?.data()?.planId || null,
      }),
      _notify(uid, 'subscription_activated', {
        title: `${plan.name} activated`,
        body: `Your ${plan.name} subscription is now active. All features unlocked.`,
        planId, subscriptionId: subId,
      }),
    ]);

    logger.info('[sub] Activated', { uid, planId, cycle, status, subId });
    return { subscriptionId: subId, planId, status, features: plan.features,
             currentPeriodEnd: subDoc.currentPeriodEnd };
  }
);

/* ════════════════════════════════════════════════════════
   4. subCancel
════════════════════════════════════════════════════════ */
exports.subCancel = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '128MiB' },
  async (req) => {
    assertAuth(req);
    const { subscriptionId, immediate } = req.data || {};
    if (!subscriptionId) throw new HttpsError('invalid-argument', 'subscriptionId required');

    const uid  = req.auth.uid;
    const fsdb = db();
    const ref  = fsdb.collection('subscriptions').doc(subscriptionId);
    const snap = await ref.get();
    if (!snap.exists)         throw new HttpsError('not-found', 'Subscription not found');
    const sub = snap.data();
    if (sub.uid !== uid)      throw new HttpsError('permission-denied', 'Not your subscription');

    const updates = { updatedAt: now(), cancelAtPeriodEnd: true };
    if (immediate) {
      updates.status           = S.CANCELLED;
      updates.cancelledAt      = now();
      updates.cancelAtPeriodEnd = false;
      const freePlan = PLANS[`${sub.hubType}_free`];
      updates.features = freePlan?.features || {};
      await fsdb.collection('users').doc(uid).set({
        [`subscription.${sub.hubType}`]: {
          planId: `${sub.hubType}_free`, tier: 'free', status: S.CANCELLED, features: updates.features,
        }, updatedAt: now(),
      }, { merge: true });
    }

    await ref.update(updates);
    await _audit('subscription_cancelled', uid, { subscriptionId, immediate, planId: sub.planId });
    await _notify(uid, 'subscription_cancelled', {
      title: 'Subscription cancelled',
      body: immediate
        ? 'Your subscription has been cancelled immediately.'
        : `Your plan will end on ${new Date(sub.currentPeriodEnd?.toMillis?.() || 0).toLocaleDateString('en-KE')} and will not renew.`,
      subscriptionId,
    });

    return { status: immediate ? S.CANCELLED : 'pending_cancellation' };
  }
);

/* ════════════════════════════════════════════════════════
   5. subReactivate — undo a cancelAtPeriodEnd
════════════════════════════════════════════════════════ */
exports.subReactivate = onCall(
  { region: REGION, timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    assertAuth(req);
    const { subscriptionId } = req.data || {};
    if (!subscriptionId) throw new HttpsError('invalid-argument', 'subscriptionId required');
    const uid  = req.auth.uid;
    const ref  = db().collection('subscriptions').doc(subscriptionId);
    const snap = await ref.get();
    if (!snap.exists || snap.data().uid !== uid)
      throw new HttpsError('not-found', 'Subscription not found or access denied');
    if (snap.data().status === S.ACTIVE && !snap.data().cancelAtPeriodEnd)
      return { status: S.ACTIVE, message: 'Already active' };
    await ref.update({ cancelAtPeriodEnd: false, updatedAt: now() });
    return { status: 'reactivated' };
  }
);

/* ════════════════════════════════════════════════════════
   6. subGetBillingHistory — authenticated
════════════════════════════════════════════════════════ */
exports.subGetBillingHistory = onCall(
  { region: REGION, timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    assertAuth(req);
    const { limit: lim = 20 } = req.data || {};
    const snap = await db().collection('billingHistory')
      .where('uid', '==', req.auth.uid)
      .orderBy('createdAt', 'desc')
      .limit(Math.min(lim, 50)).get();
    return { history: snap.docs.map(d => _serialize({ id: d.id, ...d.data() })) };
  }
);

/* ════════════════════════════════════════════════════════
   7. adminSubCreatePlan — admin: new custom plan
════════════════════════════════════════════════════════ */
exports.adminSubCreatePlan = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '128MiB' },
  async (req) => {
    assertAdmin(req);
    const { id, hubType, tier, name, price, features, trial, grace } = req.data || {};
    if (!id || !hubType || !tier || !name || !price || !features)
      throw new HttpsError('invalid-argument', 'id, hubType, tier, name, price, features required');
    if (PLANS[id]) throw new HttpsError('already-exists', 'ID conflicts with a built-in plan. Choose a unique ID.');

    const ref = db().collection('subscriptionPlans').doc(id);
    if ((await ref.get()).exists) throw new HttpsError('already-exists', 'Plan already exists');

    await ref.set({
      id, hubType, tier, name, price, features,
      trial: trial || { days: 0 }, grace: grace || { days: 3 },
      isActive: true, createdBy: req.auth.uid, createdAt: now(), updatedAt: now(),
    });
    await _audit('plan_created', req.auth.uid, { planId: id, name });
    return { planId: id, status: 'created' };
  }
);

/* ════════════════════════════════════════════════════════
   8. adminSubUpdatePlan — admin: edit price/features/status
   Built-in plans are overridden in Firestore (not mutated).
════════════════════════════════════════════════════════ */
exports.adminSubUpdatePlan = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '128MiB' },
  async (req) => {
    assertAdmin(req);
    const { planId, ...updates } = req.data || {};
    if (!planId) throw new HttpsError('invalid-argument', 'planId required');
    delete updates.id; delete updates.createdAt; delete updates.createdBy; /* protect immutable fields */

    const isBuiltIn = !!PLANS[planId];
    await db().collection('subscriptionPlans').doc(planId).set({
      ...(isBuiltIn ? PLANS[planId] : {}),
      ...updates, id: planId, updatedBy: req.auth.uid, updatedAt: now(),
    }, { merge: true });

    await _audit('plan_updated', req.auth.uid, { planId, updates });
    return { planId, status: 'updated', isBuiltIn };
  }
);

/* ════════════════════════════════════════════════════════
   9. adminSubListSubscriptions — admin search
════════════════════════════════════════════════════════ */
exports.adminSubListSubscriptions = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '256MiB' },
  async (req) => {
    assertAdmin(req);
    const { status, hubType, uid: targetUid, limit: lim = 50 } = req.data || {};
    const fsdb = db();
    let q = fsdb.collection('subscriptions');

    /* Use a single WHERE to stay within single-field index budget */
    if (targetUid)  q = q.where('uid', '==', targetUid);
    else if (status)q = q.where('status', '==', status);
    else if (hubType)q= q.where('hubType', '==', hubType);

    const snap = await q.orderBy('updatedAt', 'desc').limit(Math.min(lim, 200)).get();
    const subs = snap.docs.map(d => _serialize({ id: d.id, ...d.data() }));

    /* In-memory secondary filter when multiple filters requested */
    const filtered = subs.filter(s =>
      (!hubType  || s.hubType === hubType)  &&
      (!status   || s.status  === status)
    );

    return { subscriptions: filtered, total: filtered.length };
  }
);

/* ════════════════════════════════════════════════════════
   10. adminSubGetAnalytics — MRR, churn, breakdowns
════════════════════════════════════════════════════════ */
exports.adminSubGetAnalytics = onCall(
  { region: REGION, timeoutSeconds: 60, memory: '256MiB' },
  async (req) => {
    assertAdmin(req);
    const fsdb = db();

    const [activeSnap, trialSnap, pastDueSnap, cancelledSnap, expiredSnap, billingSnap] =
      await Promise.all([
        fsdb.collection('subscriptions').where('status', '==', S.ACTIVE).get(),
        fsdb.collection('subscriptions').where('status', '==', S.TRIALING).get(),
        fsdb.collection('subscriptions').where('status', '==', S.PAST_DUE).get(),
        fsdb.collection('subscriptions').where('status', '==', S.CANCELLED).get(),
        fsdb.collection('subscriptions').where('status', '==', S.EXPIRED).get(),
        fsdb.collection('billingHistory').orderBy('createdAt', 'desc').limit(500).get(),
      ]);

    /* MRR */
    let mrrCents = 0;
    activeSnap.docs.forEach(d => {
      const s = d.data();
      mrrCents += s.billingCycle === 'annual'
        ? Math.round((s.priceAnnual || 0) / 12)
        : (s.priceMonthly || 0);
    });

    /* Breakdowns */
    const byHub = {}, byTier = {};
    activeSnap.docs.forEach(d => {
      const { hubType, tier } = d.data();
      byHub[hubType]  = (byHub[hubType]  || 0) + 1;
      byTier[tier]    = (byTier[tier]    || 0) + 1;
    });

    /* Revenue this calendar month */
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
    const revenueMonth = billingSnap.docs
      .filter(d => (d.data().createdAt?.toMillis?.() || 0) >= monthStart.getTime() && !d.data().refunded)
      .reduce((s, d) => s + (d.data().amountCents || 0), 0);

    /* Churn this month (cancelled after monthStart) */
    const churnMonth = cancelledSnap.docs
      .filter(d => (d.data().cancelledAt?.toMillis?.() || 0) >= monthStart.getTime()).length;

    const totalPaid = activeSnap.size + pastDueSnap.size + expiredSnap.size + cancelledSnap.size;

    return {
      active: activeSnap.size, trialing: trialSnap.size,
      pastDue: pastDueSnap.size, cancelled: cancelledSnap.size, expired: expiredSnap.size,
      mrrCents, mrrKES: _centsToKES(mrrCents),
      arrCents: mrrCents * 12, arrKES: _centsToKES(mrrCents * 12),
      revenueMonthCents: revenueMonth, revenueMonthKES: _centsToKES(revenueMonth),
      churnThisMonth: churnMonth,
      churnRate: totalPaid > 0 ? Math.round(churnMonth / totalPaid * 1000) / 10 : 0,
      byHub, byTier,
    };
  }
);

/* ════════════════════════════════════════════════════════
   11. adminSubManualAction — activate / expire / extend / trial
════════════════════════════════════════════════════════ */
exports.adminSubManualAction = onCall(
  { region: REGION, timeoutSeconds: 30, memory: '128MiB' },
  async (req) => {
    assertAdmin(req);
    const { subscriptionId, action, daysExtend, reason } = req.data || {};
    if (!subscriptionId || !action) throw new HttpsError('invalid-argument', 'subscriptionId and action required');

    const fsdb = db();
    const ref  = fsdb.collection('subscriptions').doc(subscriptionId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Subscription not found');
    const sub  = snap.data();
    const plan = await _resolvePlan(sub.planId);
    let updates = { updatedAt: now() };

    if (action === 'activate') {
      const end  = _periodEnd(new Date(), sub.billingCycle || 'monthly');
      updates = { ...updates, status: S.ACTIVE, failedAttempts: 0, features: plan.features,
        currentPeriodStart: ts(new Date()), currentPeriodEnd: ts(end), graceEnd: ts(_addDays(end, plan.grace.days)), nextBillingDate: ts(end) };
    } else if (action === 'expire') {
      updates = { ...updates, status: S.EXPIRED, expiredAt: now(), features: PLANS[`${sub.hubType}_free`]?.features || {} };
    } else if (action === 'cancel') {
      updates = { ...updates, status: S.CANCELLED, cancelledAt: now(), cancelAtPeriodEnd: false };
    } else if (action === 'extend') {
      if (!daysExtend) throw new HttpsError('invalid-argument', 'daysExtend required');
      const newEnd = _addDays(sub.currentPeriodEnd?.toDate?.() || new Date(), daysExtend);
      updates = { ...updates, currentPeriodEnd: ts(newEnd), graceEnd: ts(_addDays(newEnd, plan.grace.days)), nextBillingDate: ts(newEnd) };
    } else if (action === 'set_trial') {
      const trialEnd = _addDays(new Date(), plan.trial.days || 14);
      updates = { ...updates, status: S.TRIALING, currentPeriodEnd: ts(trialEnd), graceEnd: ts(_addDays(trialEnd, plan.grace.days)) };
    } else {
      throw new HttpsError('invalid-argument', `Unknown action: ${action}`);
    }

    await ref.update(updates);

    if (updates.status) {
      await fsdb.collection('users').doc(sub.uid).set({
        [`subscription.${sub.hubType}`]: {
          planId: sub.planId, tier: sub.tier,
          status: updates.status, features: updates.features || sub.features,
        }, updatedAt: now(),
      }, { merge: true });
    }

    await _audit(`admin_${action}`, req.auth.uid, {
      subscriptionId, action, daysExtend, reason, targetUid: sub.uid, planId: sub.planId,
    });

    return { subscriptionId, action, status: 'done' };
  }
);

/* ════════════════════════════════════════════════════════
   12. adminSubProcessRefund
════════════════════════════════════════════════════════ */
exports.adminSubProcessRefund = onCall(
  { region: REGION, timeoutSeconds: 60, memory: '256MiB' },
  async (req) => {
    assertAdmin(req);
    const { billingHistoryId, subscriptionId, reason } = req.data || {};
    if (!billingHistoryId || !reason) throw new HttpsError('invalid-argument', 'billingHistoryId and reason required');

    const fsdb     = db();
    const billRef  = fsdb.collection('billingHistory').doc(billingHistoryId);
    const billSnap = await billRef.get();
    if (!billSnap.exists)       throw new HttpsError('not-found', 'Billing record not found');
    if (billSnap.data().refunded) throw new HttpsError('already-exists', 'Already refunded');

    const bill    = billSnap.data();
    const refundId = `ref_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;

    await fsdb.runTransaction(async txn => {
      txn.update(billRef, { refunded: true, refundId, refundedAt: now(), refundReason: reason, refundedBy: req.auth.uid });
      txn.set(fsdb.collection('refunds').doc(refundId), {
        billingHistoryId, subscriptionId, uid: bill.uid,
        amountCents: bill.amountCents, reason, status: 'processed',
        adminUid: req.auth.uid, createdAt: now(),
      });
    });

    /* Cancel the subscription on refund */
    if (subscriptionId) {
      const subRef = fsdb.collection('subscriptions').doc(subscriptionId);
      const subSnap = await subRef.get();
      if (subSnap.exists) {
        await subRef.update({ status: S.CANCELLED, cancelledAt: now(), cancelReason: 'refund', updatedAt: now() });
      }
    }

    await _audit('subscription_refunded', req.auth.uid, { billingHistoryId, subscriptionId, amountCents: bill.amountCents, reason });
    await _notify(bill.uid, 'refund_processed', {
      title: 'Refund processed',
      body: `Your refund of KES ${_centsToKES(bill.amountCents).toLocaleString()} has been processed.`,
    });

    return { refundId, status: 'processed', amountCents: bill.amountCents };
  }
);

/* ════════════════════════════════════════════════════════
   13. adminSubExportBilling — CSV-friendly billing export
════════════════════════════════════════════════════════ */
exports.adminSubExportBilling = onCall(
  { region: REGION, timeoutSeconds: 60, memory: '256MiB' },
  async (req) => {
    assertAdmin(req);
    const { startDate, endDate } = req.data || {};
    const fsdb = db();
    let q = fsdb.collection('billingHistory').orderBy('createdAt', 'desc').limit(2000);

    const snap = await q.get();
    let rows = snap.docs.map(d => {
      const r = d.data();
      return {
        id: d.id, uid: r.uid, planId: r.planId, hubType: r.hubType,
        event: r.event, amountKES: _centsToKES(r.amountCents),
        billingCycle: r.billingCycle, paymentRef: r.paymentRef,
        refunded: r.refunded || false,
        date: new Date(r.createdAt?.toMillis?.() || 0).toISOString().slice(0, 10),
      };
    });

    if (startDate) rows = rows.filter(r => r.date >= startDate);
    if (endDate)   rows = rows.filter(r => r.date <= endDate);

    const totalRevenue = rows.filter(r => !r.refunded).reduce((s, r) => s + r.amountKES, 0);
    return { rows, total: rows.length, totalRevenueKES: totalRevenue };
  }
);

/* ════════════════════════════════════════════════════════
   14. subProcessExpirations — scheduled every hour
   • Active past currentPeriodEnd → GRACE
   • In grace past graceEnd → EXPIRED (downgrade to free)
   • CancelAtPeriodEnd past currentPeriodEnd → CANCELLED
════════════════════════════════════════════════════════ */
exports.subProcessExpirations = onSchedule(
  { schedule: '0 * * * *', timeZone: 'Africa/Nairobi', timeoutSeconds: 540, memory: '512MiB', region: REGION },
  async () => {
    const fsdb   = db();
    const now_ts = admin.firestore.Timestamp.now();
    const now_ms = now_ts.toMillis();

    /* 1 — Active subs past period end → GRACE or CANCELLED if cancelAtPeriodEnd */
    const activeSnap = await fsdb.collection('subscriptions')
      .where('status', '==', S.ACTIVE).limit(500).get();

    const toGrace  = activeSnap.docs.filter(d => {
      const end = d.data().currentPeriodEnd?.toMillis?.();
      return end && end <= now_ms;
    });

    if (toGrace.length) {
      const b = fsdb.batch();
      toGrace.forEach(d => {
        const cancel = d.data().cancelAtPeriodEnd;
        b.update(d.ref, cancel
          ? { status: S.CANCELLED, cancelledAt: now_ts, updatedAt: now_ts }
          : { status: S.GRACE,     updatedAt: now_ts });
      });
      await b.commit();
      logger.info('[sub] Moved to grace/cancelled', { count: toGrace.length });
    }

    /* 2 — Grace subs past graceEnd → EXPIRED */
    const graceSnap = await fsdb.collection('subscriptions')
      .where('status', '==', S.GRACE).limit(500).get();

    const toExpire = graceSnap.docs.filter(d => {
      const ge = d.data().graceEnd?.toMillis?.();
      return ge && ge <= now_ms;
    });

    if (toExpire.length) {
      const b = fsdb.batch();
      for (const doc of toExpire) {
        const sub      = doc.data();
        const freePlan = PLANS[`${sub.hubType}_free`];
        b.update(doc.ref, {
          status: S.EXPIRED, expiredAt: now_ts, updatedAt: now_ts,
          features: freePlan?.features || {},
        });
        /* Downgrade user profile */
        b.set(fsdb.collection('users').doc(sub.uid), {
          [`subscription.${sub.hubType}`]: {
            planId: `${sub.hubType}_free`, tier: 'free',
            status: S.EXPIRED, features: freePlan?.features || {},
          }, updatedAt: now_ts,
        }, { merge: true });
      }
      await b.commit();

      /* Notify outside batch (no need for atomicity) */
      for (const doc of toExpire) {
        const sub = doc.data();
        await _notify(sub.uid, 'subscription_expired', {
          title: 'Subscription expired',
          body: `Your ${sub.planName} subscription has expired. Resubscribe anytime to restore access.`,
          subscriptionId: doc.id, planId: sub.planId,
        }).catch(() => {});
        await _audit('subscription_expired', sub.uid, {
          subscriptionId: doc.id, planId: sub.planId,
        }).catch(() => {});
      }

      logger.info('[sub] Expired', { count: toExpire.length });
    }

    /* 3 — Trialing past trialEnd → PAST_DUE (require payment) */
    const trialSnap = await fsdb.collection('subscriptions')
      .where('status', '==', S.TRIALING).limit(500).get();

    const trialExpired = trialSnap.docs.filter(d => {
      const end = d.data().currentPeriodEnd?.toMillis?.();
      return end && end <= now_ms;
    });

    if (trialExpired.length) {
      const b = fsdb.batch();
      trialExpired.forEach(d => b.update(d.ref, { status: S.PAST_DUE, updatedAt: now_ts }));
      await b.commit();
      for (const doc of trialExpired) {
        const sub = doc.data();
        await _notify(sub.uid, 'trial_ended', {
          title: 'Free trial ended',
          body: `Your ${sub.planName} trial has ended. Subscribe now to keep your features.`,
          subscriptionId: doc.id, planId: sub.planId,
        }).catch(() => {});
      }
      logger.info('[sub] Trial expired → PAST_DUE', { count: trialExpired.length });
    }
  }
);

/* ════════════════════════════════════════════════════════
   15. subSendRenewalReminders — daily at 8am
   Sends 7-day and 1-day advance notices
════════════════════════════════════════════════════════ */
exports.subSendRenewalReminders = onSchedule(
  { schedule: '0 8 * * *', timeZone: 'Africa/Nairobi', timeoutSeconds: 300, memory: '256MiB', region: REGION },
  async () => {
    const fsdb = db();
    const now_ms = Date.now();

    const snap = await fsdb.collection('subscriptions')
      .where('status', '==', S.ACTIVE).limit(1000).get();

    let seven = 0, one = 0;
    for (const doc of snap.docs) {
      const sub = doc.data();
      const end = sub.currentPeriodEnd?.toMillis?.() || 0;
      if (!end) continue;

      const daysLeft = Math.round((end - now_ms) / 86400000);

      if (daysLeft === 7) {
        await _notify(sub.uid, 'renewal_reminder_7d', {
          title: 'Subscription renews in 7 days',
          body: `Your ${sub.planName} plan renews in 7 days for KES ${_centsToKES(sub.billingCycle === 'annual' ? sub.priceAnnual : sub.priceMonthly).toLocaleString()}.`,
          subscriptionId: doc.id,
        }).catch(() => {});
        seven++;
      } else if (daysLeft === 1) {
        await _notify(sub.uid, 'renewal_reminder_1d', {
          title: 'Subscription renews tomorrow',
          body: `Your ${sub.planName} plan renews tomorrow. Make sure M-PESA is funded.`,
          subscriptionId: doc.id,
        }).catch(() => {});
        one++;
      }
    }

    logger.info('[sub] Renewal reminders sent', { seven, one });
  }
);
