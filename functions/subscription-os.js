/* ================================================================
   SOKONI — Subscription OS Cloud Functions  v1.0.0

   The server-side brain of the Universal Subscription Platform.
   All subscription permissions are authoritative here.
   The client is never trusted.

   Exports:
     generateEntitlementToken   — signed HMAC token per user session
     verifyEntitlement          — zero-trust feature gate (every AI op)
     processSubscriptionChange  — upgrade / downgrade / cancel
     detectFraud                — multi-signal risk scoring
     proposeFinancialChange     — submit pricing/plan change for approval
     approveFinancialChange     — dual-admin cryptographic approval
     forecastRevenue            — admin: MRR/ARR projection
     selfHealSubscriptions      — scheduler: auto-repair every 15 min
     sendBillingReminders       — scheduler: daily 09:00 EAT
     runSubscriptionBrain       — CF + scheduler: churn / upgrade scores
     reconcileBilling           — scheduler: daily 02:00 EAT integrity check

   Security model:
     All monetary / plan decisions go through this file.
     Financial changes require dual-admin approval.
     Payment idempotency enforced via aiPaymentRefs collection.
     HMAC tokens signed with SUB_OS_SIGNING_SECRET (Firebase Secret Manager).

   Firebase Functions v2 calling convention: handler receives a single
   CallableRequest object (req) — req.data contains the payload,
   req.auth contains authentication info.
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { defineSecret }       = require('firebase-functions/params');
const { logger }             = require('firebase-functions');
const admin                  = require('firebase-admin');
const crypto                 = require('crypto');

/* admin already initialised in index.js */
const db = () => admin.firestore();

/* ── Signing secret (stored in Firebase Secret Manager) ──────── */
const SIGNING_SECRET = defineSecret('SUB_OS_SIGNING_SECRET');

const { assertAuth, assertAdmin, assertSuperAdmin, sanitize } = require('./shared/errors');
const { currentPeriod } = require('./shared/constants');

const san     = sanitize;
const _period = () => currentPeriod();

/* ── Server-authoritative plan registry ──────────────────────── */
const AI_PLANS = {
  ai_free:       { price: 0,    annualPrice: 0,     storageGB: 0.5,  credits: 0,    quotas: { removeBackground: 10, enhanceProduct: 20, smartCrop: -1, generateBanner: 0, generatePoster: 0, createStory: 2, productTitles: 5, productDescriptions: 5, bulkUploadFiles: 5, seoOptimization: 0, marketingCopy: 0, apiCalls: 0 } },
  ai_starter:    { price: 499,  annualPrice: 4990,  storageGB: 5,    credits: 50,   quotas: { removeBackground: 100, enhanceProduct: 200, smartCrop: -1, generateBanner: 10, generatePoster: 10, createStory: 20, productTitles: -1, productDescriptions: 50, bulkUploadFiles: 50, seoOptimization: 30, marketingCopy: 0, apiCalls: 0 } },
  ai_pro:        { price: 1499, annualPrice: 14990, storageGB: 50,   credits: 200,  quotas: { removeBackground: -1, enhanceProduct: -1, smartCrop: -1, generateBanner: 50, generatePoster: 50, createStory: 100, productTitles: -1, productDescriptions: -1, bulkUploadFiles: 500, seoOptimization: -1, marketingCopy: 100, apiCalls: 0 } },
  ai_enterprise: { price: 9999, annualPrice: 99990, storageGB: 500,  credits: 1000, quotas: { removeBackground: -1, enhanceProduct: -1, smartCrop: -1, generateBanner: -1, generatePoster: -1, createStory: -1, productTitles: -1, productDescriptions: -1, bulkUploadFiles: -1, seoOptimization: -1, marketingCopy: -1, apiCalls: 50000 } },
};
const MKT_PLANS = {
  free:     { price: 0,    listings: 3,   commissionPct: 15, leads: 5   },
  starter:  { price: 499,  listings: 20,  commissionPct: 10, leads: 30  },
  pro:      { price: 1499, listings: 999, commissionPct: 7,  leads: 999 },
  business: { price: 4999, listings: 999, commissionPct: 4,  leads: 999 },
};

/* ── HMAC token sign / verify ────────────────────────────────── */
function _sign(payload, secret) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function _verify(token, secret) {
  const dot  = token.lastIndexOf('.');
  if (dot < 0) throw new Error('Malformed token');
  const data = token.slice(0, dot);
  const sig  = token.slice(dot + 1);
  const exp  = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  /* Constant-time comparison prevents timing attacks */
  if (!crypto.timingSafeEqual(
    Buffer.from(sig.padEnd(64, '0'), 'base64url'),
    Buffer.from(exp.padEnd(64, '0'), 'base64url')
  )) throw new Error('Invalid token signature');
  const parsed = JSON.parse(Buffer.from(data, 'base64url').toString());
  if (parsed.exp < Date.now()) throw new Error('Token expired');
  return parsed;
}

/* ── Aggregate entitlement state from all product DBs ─────────── */
async function _loadEntitlements(uid) {
  const [aiSnap, mktSnap] = await Promise.all([
    db().collection('aiSubscriptions').doc(uid).get(),
    db().collection('subscriptions').doc(uid).get(),
  ]);
  const ai  = aiSnap.exists  ? aiSnap.data()  : { plan: 'ai_free',  status: 'active' };
  let   mkt = mktSnap.exists ? mktSnap.data() : null;
  if (!mkt) {
    /* A marketplace plan onboarded via sub-engine (subscriptions/{autoId}) or the
       UEOE (accountSubscriptions) won't exist at subscriptions/{uid}. Resolve it
       through the canonical seam so those users aren't wrongly defaulted to free.
       Additive — subscriptions/{uid} stays authoritative when present. AI path
       untouched. */
    try {
      const subCore = require('./subscription-core');
      const c = await subCore.resolveSubscription(uid, { role: 'merchant', hubType: 'merchant' });
      if (c.found) mkt = { plan: c.tier, status: c.status, currentPeriodEnd: c.expiryAt || 0 };
    } catch (_) { /* seam unavailable → free default */ }
  }
  mkt = mkt || { plan: 'free', status: 'active' };
  return {
    uid,
    products: {
      ai:          { plan: ai.plan  || 'ai_free', status: ai.status  || 'active', periodEnd: ai.currentPeriodEnd  || 0 },
      marketplace: { plan: mkt.plan || 'free',    status: mkt.status || 'active', periodEnd: mkt.currentPeriodEnd || 0 },
    },
    aiPlan:  AI_PLANS[ai.plan]   || AI_PLANS.ai_free,
    mktPlan: MKT_PLANS[mkt.plan] || MKT_PLANS.free,
  };
}

async function _loadUsage(uid) {
  const snap = await db().collection('aiUsage').doc(`${uid}_${_period()}`).get();
  return snap.exists ? (snap.data().counters || {}) : {};
}

/* ================================================================
   generateEntitlementToken
   Issues a server-signed HMAC token encoding the user's full
   entitlement state across all Sokoni products.
   Client caches for 13 minutes; server TTL is 15 minutes.
================================================================ */
const generateEntitlementToken = onCall(
  { region: 'us-central1', timeoutSeconds: 20, memory: '256MiB', secrets: [SIGNING_SECRET] },
  async (req) => {
    const uid    = assertAuth(req);
    const secret = SIGNING_SECRET.value();

    const [ent, usage, credSnap, riskSnap] = await Promise.all([
      _loadEntitlements(uid),
      _loadUsage(uid),
      db().collection('aiCredits').doc(uid).get(),
      db().collection('entitlements').doc(uid).get(),
    ]);

    const credits   = credSnap.exists  ? (credSnap.data().balance  || 0) : 0;
    const riskScore = riskSnap.exists  ? (riskSnap.data().riskScore || 0) : 0;
    const now       = Date.now();

    /* Block token issuance if risk score is critical */
    if (riskScore >= 90) {
      logger.warn(`[SubOS] High-risk user blocked token: uid=${uid} risk=${riskScore}`);
      throw new HttpsError('permission-denied', 'Account under review. Contact support.');
    }

    const claims = {
      uid,
      jti:      crypto.randomBytes(10).toString('base64url'),
      iat:      now,
      exp:      now + 15 * 60 * 1000,
      products: ent.products,
      usage,
      credits,
    };

    /* Process fraud signals from the client silently */
    const signals = Array.isArray(req.data.signals) ? req.data.signals.slice(0, 10) : [];
    if (signals.length) _processFraudSignals(uid, signals).catch(() => {});

    /* Update unified entitlement document */
    db().collection('entitlements').doc(uid).set(
      { uid, products: ent.products, credits, updatedAt: now },
      { merge: true }
    ).catch(() => {});

    return { token: _sign(claims, secret), claims, exp: claims.exp };
  }
);

/* ================================================================
   verifyEntitlement
   Zero-trust feature gate called by the client on every AI operation.
   1. Validates Firebase Auth (uid is authenticated)
   2. Validates HMAC token signature + expiry
   3. Confirms uid in token === authenticated uid (prevents token theft)
   4. Loads FRESH subscription from Firestore (server-authoritative)
   5. Checks feature quota and usage counter
   6. Returns { allowed, remaining, plan, ... } or { allowed: false, ... }
================================================================ */
const verifyEntitlement = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '256MiB', secrets: [SIGNING_SECRET] },
  async (req) => {
    const uid     = assertAuth(req);
    const product = san(req.data.product, 30);
    const feature = san(req.data.feature, 60);
    const rawTok  = typeof req.data.token === 'string' ? req.data.token : '';

    /* Validate and parse the token */
    let tokenClaims = null;
    try {
      tokenClaims = _verify(rawTok, SIGNING_SECRET.value());
    } catch {
      /* Expired or invalid token — still proceed; use fresh Firestore data */
      tokenClaims = null;
    }

    /* UID binding check — the token's uid must match the authenticated user */
    if (tokenClaims?.uid && tokenClaims.uid !== uid) {
      _logFraud(uid, 'token_uid_mismatch', { tokenUid: tokenClaims.uid }).catch(() => {});
      return { allowed: false, reason: 'Identity mismatch. Please sign in again.', reauth: true };
    }

    /* Session fingerprint consistency check */
    if (tokenClaims?.sessionFp && req.data.sessionFp && tokenClaims.sessionFp !== req.data.sessionFp) {
      _logFraud(uid, 'session_fp_mismatch', {}).catch(() => {});
      /* Don't block — log and monitor; fingerprint can change on device update */
    }

    /* Load fresh subscription (never rely solely on client token) */
    const [ent, usage] = await Promise.all([
      _loadEntitlements(uid),
      _loadUsage(uid),
    ]);

    const prodEnt = ent.products[product];
    if (!prodEnt) return { allowed: false, reason: `Unknown product: ${product}` };
    if (prodEnt.status === 'cancelled')  return { allowed: false, reason: 'Subscription cancelled.', upgradeUrl: '/subscriptions.html' };
    if (prodEnt.status === 'suspended')  return { allowed: false, reason: 'Account suspended. Contact support.', suspended: true };

    /* ── AI product feature check ── */
    if (product === 'ai') {
      const plan    = AI_PLANS[prodEnt.plan] || AI_PLANS.ai_free;
      const quota   = plan.quotas[feature];

      if (quota === undefined)  return { allowed: true,  remaining: -1,  plan: prodEnt.plan, source: 'unmetered', product, feature };
      if (quota === 0)          return { allowed: false, remaining: 0,   plan: prodEnt.plan, reason: `${feature} is not available on the ${prodEnt.plan} plan.`, upgradeUrl: '/ai-subscriptions.html', product, feature };
      if (quota === -1)         return { allowed: true,  remaining: -1,  plan: prodEnt.plan, source: 'unlimited', product, feature };

      const used      = usage[feature] || 0;
      const remaining = Math.max(0, quota - used);
      if (remaining <= 0) {
        return {
          allowed: false, remaining: 0, plan: prodEnt.plan, used, limit: quota,
          reason:    `Monthly ${feature} limit of ${quota} reached.`,
          upgradeUrl: '/ai-subscriptions.html',
          creditCost: 2,
          product, feature,
        };
      }

      /* Warn at 80% */
      const warn = remaining <= Math.ceil(quota * 0.2);
      return { allowed: true, remaining, plan: prodEnt.plan, used, limit: quota, warn, product, feature };
    }

    /* ── Generic product: plan-active check ── */
    return { allowed: true, plan: prodEnt.plan, product, feature, source: 'plan-active' };
  }
);

/* ================================================================
   processSubscriptionChange
   Server-authoritative upgrade / downgrade / cancel handler.
   Upgrades: immediate (requires paymentRef).
   Downgrades: scheduled at period end (no immediate charge change).
================================================================ */
const processSubscriptionChange = onCall(
  { region: 'us-central1', timeoutSeconds: 30, memory: '256MiB' },
  async (req) => {
    const uid     = assertAuth(req);
    const action  = san(req.data.action, 20);
    const product = san(req.data.product, 30);
    const newPlan = san(req.data.newPlan, 40);
    const billing = req.data.billing === 'annual' ? 'annual' : 'monthly';
    const payRef  = san(req.data.paymentRef, 120);

    if (!['upgrade', 'downgrade', 'cancel'].includes(action))
      throw new HttpsError('invalid-argument', 'Invalid action.');

    const col   = product === 'ai' ? 'aiSubscriptions' : 'subscriptions';
    const ref   = db().collection(col).doc(uid);
    const snap  = await ref.get();
    const curr  = snap.exists ? snap.data() : {};
    const now   = Date.now();
    const batch = db().batch();

    if (action === 'cancel') {
      batch.update(ref, { status: 'cancelled', cancelledAt: now });

    } else if (action === 'downgrade') {
      batch.set(ref, {
        pendingPlan:    newPlan,
        pendingBilling: billing,
        pendingAt:      curr.currentPeriodEnd || now,
      }, { merge: true });

    } else { /* upgrade */
      if (!payRef) throw new HttpsError('invalid-argument', 'paymentRef required for upgrade.');
      /* FAST PATH ONLY — not the guard.
         This read used to BE the idempotency guard: get() -> if(exists) return,
         with the claim written later by set(). Two concurrent deliveries of the
         same payRef both saw the document absent, both proceeded, and both ran
         `increment(planDef.credits)` below — granting the plan's credits twice.
         set() cannot fail on an existing document, so nothing stopped the second.

         The real claim is now batch.create() below, which is atomic. This read is
         kept only to avoid doing pointless work on an obvious replay. */
      const idem = await db().collection('aiPaymentRefs').doc(payRef).get();
      if (idem.exists) return { success: true, idempotent: true };

      const planDef = AI_PLANS[newPlan];
      if (!planDef) throw new HttpsError('invalid-argument', `Unknown plan: ${newPlan}`);

      batch.set(ref, {
        plan: newPlan, billing, status: 'active',
        activatedAt: now, currentPeriodStart: now,
        currentPeriodEnd: now + (billing === 'annual' ? 365 : 30) * 86400000,
        previousPlan: curr.plan || 'ai_free',
        paymentRef: payRef,
        updatedAt: now,
      }, { merge: true });

      /* create(), NOT set(). This is the atomic idempotency claim: if another
         delivery of the same payRef has already claimed it, the whole batch —
         including the credit increment above — fails with ALREADY_EXISTS and is
         discarded. set() would silently overwrite and let both grant credits. */
      batch.create(db().collection('aiPaymentRefs').doc(payRef), { uid, newPlan, billing, processedAt: now });

      /* Credit included monthly credits on upgrade */
      if (planDef.credits > 0) {
        batch.set(db().collection('aiCredits').doc(uid), {
          uid,
          balance:        admin.firestore.FieldValue.increment(planDef.credits),
          totalPurchased: admin.firestore.FieldValue.increment(planDef.credits),
          lastCredited:   now,
        }, { merge: true });
      }
    }

    batch.set(db().collection('auditLogs').doc(), {
      type: `sub_${action}`, uid, product, newPlan, billing, payRef: payRef || null, ts: now,
    });

    /* Invalidate unified entitlement cache */
    batch.set(db().collection('entitlements').doc(uid), { updatedAt: now, needsRefresh: true }, { merge: true });

    try {
      await batch.commit();
    } catch (e) {
      /* The upgrade path claims its payRef with create(). A concurrent delivery
         of the same reference already holds it, so this batch is rejected whole
         — the credit increment included. Reporting success/idempotent is correct:
         the work was done once, by the delivery that won the claim. */
      const already = e && (e.code === 6 || /ALREADY_EXISTS/i.test(String(e.message || '')));
      if (already) {
        logger.info(`[SubOS] duplicate delivery rejected by idempotency claim: payRef=${payRef}`);
        return { success: true, idempotent: true };
      }
      throw e;
    }
    logger.info(`[SubOS] ${action}: uid=${uid} product=${product} plan=${newPlan}`);
    return { success: true, action, newPlan };
  }
);

/* ================================================================
   Fraud Detection Engine
================================================================ */
const FRAUD_WEIGHTS = {
  devtools_open:         5,
  storage_write:        18,
  token_uid_mismatch:   65,
  session_fp_mismatch:  20,
  session_resumed_idle:  3,
  quota_tamper:         75,
  proto_pollution:      50,
  rapid_plan_cycle:     40,
  multi_country_login:  35,
  usage_spike:          28,
  concurrent_ips:       45,
  coupon_stacking:      30,
  refund_abuse:         40,
  fake_referral:        35,
  bot_pattern:          30,
};

async function _processFraudSignals(uid, signals) {
  let addedScore = 0;
  const types = signals.map(s => s.type || s);
  types.forEach(t => { addedScore += FRAUD_WEIGHTS[t] || 0; });
  if (addedScore > 0) await _logFraud(uid, 'client_signals', { types, addedScore });
}

async function _logFraud(uid, type, data) {
  const now = Date.now();
  await db().collection('fraudEvents').add({ uid, type, data, ts: now, resolved: false });
  const weight = FRAUD_WEIGHTS[type] || 10;
  await db().collection('entitlements').doc(uid).set({
    riskScore:       admin.firestore.FieldValue.increment(weight),
    lastFraudEvent:  now,
    lastFraudType:   type,
  }, { merge: true });
}

const detectFraud = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    assertAdmin(req);
    const targetUid = san(req.data.uid, 128);
    const [evSnap, entSnap] = await Promise.all([
      db().collection('fraudEvents').where('uid', '==', targetUid).orderBy('ts', 'desc').limit(20).get(),
      db().collection('entitlements').doc(targetUid).get(),
    ]);
    const events    = evSnap.docs.map(d => d.data());
    const riskScore = entSnap.exists ? (entSnap.data().riskScore || 0) : 0;
    return { uid: targetUid, riskScore: Math.min(100, riskScore), recentEvents: events };
  }
);

/* ================================================================
   Financial Change Approval — Dual-Admin Cryptographic Layer

   Required for:
     pricing_change · commission_change · plan_creation · plan_deletion
     enterprise_contract · revenue_share_modification
     tax_configuration · payment_routing_change

   Flow:
     Admin A → proposeFinancialChange → stored as 'pending_approval'
     Admin B → approveFinancialChange → second admin signs; change applied

   Critical changes (pricing, commission, revenue_share) require
   approver !== proposer. Prevents single-admin self-approval.
================================================================ */
const FINANCIAL_TYPES = new Set([
  'pricing_change', 'commission_change', 'plan_creation', 'plan_deletion',
  'enterprise_contract', 'revenue_share_modification',
  'tax_configuration', 'payment_routing_change',
]);
/* These ALWAYS require a different second admin */
const REQUIRES_SECOND_ADMIN = new Set([
  'pricing_change', 'commission_change', 'plan_deletion', 'revenue_share_modification', 'payment_routing_change',
]);

const proposeFinancialChange = onCall(
  { region: 'us-central1', timeoutSeconds: 20, memory: '128MiB' },
  async (req) => {
    const proposerUid = assertAdmin(req);
    const type    = san(req.data.type, 60);
    const payload = req.data.payload || {};
    const summary = san(req.data.summary, 400);

    if (!FINANCIAL_TYPES.has(type))
      throw new HttpsError('invalid-argument', `Unknown financial change type: "${type}"`);

    const now = Date.now();
    const changeHash = crypto.createHash('sha256')
      .update(JSON.stringify({ type, payload, ts: now, proposerUid }))
      .digest('hex');

    const docRef = db().collection('financialProposals').doc();
    await docRef.set({
      type, payload, summary, changeHash,
      proposerUid, proposedAt: now,
      status: 'pending_approval',
      approvals:         [],
      requiredApprovals: REQUIRES_SECOND_ADMIN.has(type) ? 2 : 1,
    });

    await db().collection('auditLogs').add({
      type: 'financial_change_proposed', changeType: type,
      changeHash, proposalId: docRef.id, proposerUid, summary, ts: now,
    });

    logger.info(`[SubOS] Financial change proposed: type=${type} id=${docRef.id}`);
    return { proposalId: docRef.id, changeHash, status: 'pending_approval', required: REQUIRES_SECOND_ADMIN.has(type) ? 2 : 1 };
  }
);

const approveFinancialChange = onCall(
  { region: 'us-central1', timeoutSeconds: 30, memory: '256MiB' },
  async (req) => {
    const approverUid = assertAdmin(req);
    const proposalId  = san(req.data.proposalId, 60);

    const ref  = db().collection('financialProposals').doc(proposalId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Proposal not found.');

    const p = snap.data();
    if (p.status !== 'pending_approval')
      throw new HttpsError('failed-precondition', `Proposal is already ${p.status}.`);
    if (REQUIRES_SECOND_ADMIN.has(p.type) && p.proposerUid === approverUid)
      throw new HttpsError('permission-denied', 'This change type requires a DIFFERENT admin to approve.');
    if (p.approvals.includes(approverUid))
      throw new HttpsError('already-exists', 'You have already approved this proposal.');

    const newApprovals  = [...p.approvals, approverUid];
    const fullyApproved = newApprovals.length >= p.requiredApprovals;
    const now           = Date.now();

    await db().runTransaction(async tx => {
      tx.update(ref, {
        approvals:    newApprovals,
        status:       fullyApproved ? 'approved' : 'pending_approval',
        ...(fullyApproved ? { approvedAt: now, lastApprover: approverUid } : {}),
      });
      if (fullyApproved) await _applyFinancialChange(tx, p);
      tx.set(db().collection('auditLogs').doc(), {
        type:        fullyApproved ? 'financial_change_applied' : 'financial_change_partial_approval',
        proposalId,  changeType: p.type,
        approverUid, proposalSummary: p.summary,
        ts:          now,
      });
    });

    logger.info(`[SubOS] Financial change ${fullyApproved ? 'APPLIED' : 'partial'}: id=${proposalId}`);
    return { proposalId, status: fullyApproved ? 'approved_and_applied' : 'partially_approved', approvals: newApprovals };
  }
);

async function _applyFinancialChange(tx, proposal) {
  const { type, payload } = proposal;
  const now = Date.now();
  if (type === 'pricing_change' || type === 'plan_creation') {
    tx.set(db().collection('aiPlanOverrides').doc(payload.planId || 'override'),
      { ...payload, appliedAt: now }, { merge: true });
  }
  if (type === 'commission_change') {
    tx.set(db().collection('commissionOverrides').doc(payload.planId || 'override'),
      { ...payload, appliedAt: now }, { merge: true });
  }
  if (type === 'tax_configuration') {
    tx.set(db().collection('taxConfig').doc('current'),
      { ...payload, appliedAt: now }, { merge: true });
  }
  logger.info(`[SubOS] _applyFinancialChange: type=${type}`);
}

/* ================================================================
   forecastRevenue — Admin: MRR/ARR projection with churn model
================================================================ */
const forecastRevenue = onCall(
  { region: 'us-central1', timeoutSeconds: 60, memory: '256MiB' },
  async (req) => {
    assertAdmin(req);
    const months = Math.min(24, Math.max(1, Number(req.data.months) || 6));

    const snap = await db().collection('aiSubscriptions').where('status', '==', 'active').get();
    let mrr = 0;
    const dist = {};
    snap.forEach(d => {
      const sub  = d.data();
      const plan = AI_PLANS[sub.plan];
      if (!plan) return;
      const mo = sub.billing === 'annual' ? Math.round(plan.annualPrice / 12) : plan.price;
      mrr += mo;
      dist[sub.plan] = (dist[sub.plan] || 0) + 1;
    });

    /* Simple cohort model: 5% monthly churn, 8% monthly new growth */
    const CHURN = 0.05, GROWTH = 0.08;
    let cur = mrr;
    const forecast = Array.from({ length: months }, (_, i) => {
      cur = cur * (1 - CHURN) * (1 + GROWTH);
      return { month: i + 1, mrr: Math.round(cur), arr: Math.round(cur * 12) };
    });

    return { currentMRR: mrr, currentARR: mrr * 12, planDistribution: dist, forecast };
  }
);

/* ================================================================
   runSubscriptionBrain
   Callable (user or admin) + background brain update.
   Updates subscriptionBrain/{uid} with churn risk and upgrade scores.
================================================================ */
const runSubscriptionBrain = onCall(
  { region: 'us-central1', timeoutSeconds: 60, memory: '512MiB' },
  async (req) => {
    const uid = assertAuth(req);

    const [subSnap, usageSnap, credSnap] = await Promise.all([
      db().collection('aiSubscriptions').doc(uid).get(),
      db().collection('aiUsage').doc(`${uid}_${_period()}`).get(),
      db().collection('aiCredits').doc(uid).get(),
    ]);

    const sub     = subSnap.exists  ? subSnap.data()  : { plan: 'ai_free' };
    const usage   = usageSnap.exists ? (usageSnap.data().counters || {}) : {};
    const credits = credSnap.exists  ? credSnap.data() : { balance: 0, totalConsumed: 0 };
    const plan    = AI_PLANS[sub.plan] || AI_PLANS.ai_free;

    /* Utilization */
    let totalQ = 0, totalU = 0;
    Object.entries(plan.quotas).forEach(([k, v]) => {
      if (v > 0 && v !== -1) { totalQ += v; totalU += (usage[k] || 0); }
    });
    const util = totalQ > 0 ? totalU / totalQ : 0;

    /* Churn risk */
    let churnRisk = 0;
    if (util < 0.05) churnRisk += 40;
    else if (util < 0.15) churnRisk += 25;
    else if (util < 0.30) churnRisk += 12;
    if (!sub.plan || sub.plan === 'ai_free') churnRisk += 18;
    if (credits.totalConsumed === 0 && sub.plan !== 'ai_free') churnRisk += 14;
    const ageMs = sub.activatedAt ? Date.now() - sub.activatedAt : 999 * 86400000;
    if (ageMs < 14 * 86400000) churnRisk += 10;
    churnRisk = Math.min(100, Math.round(churnRisk));

    /* Upgrade probability */
    let upgradeProb = 0;
    Object.entries(plan.quotas).forEach(([k, v]) => {
      if (v <= 0 || v === -1) return;
      const pct = (usage[k] || 0) / v;
      if (pct >= 1.0) upgradeProb += 20;
      else if (pct >= 0.85) upgradeProb += 10;
    });
    upgradeProb = Math.min(100, Math.round(upgradeProb));

    const churnTier     = churnRisk >= 70 ? 'critical' : churnRisk >= 45 ? 'at_risk' : churnRisk >= 20 ? 'monitor' : 'healthy';
    const retentionTier = churnTier;
    const ltv           = plan.price * 12;

    const result = {
      uid, plan: sub.plan, churnRisk, churnTier, upgradeProb,
      utilization: Math.round(util * 100), ltv, retentionTier,
      updatedAt: Date.now(),
    };

    await db().collection('subscriptionBrain').doc(uid).set(result, { merge: true });
    return result;
  }
);

/* ================================================================
   selfHealSubscriptions — Scheduler: every 15 minutes
   Automatically detects and repairs subscription inconsistencies:
   • Expired active subscriptions → mark past_due
   • Pending downgrades past their effective date → apply
   • Past-due → attempt retry notification queue entry
   • Stale entitlement caches → mark for refresh
================================================================ */
const selfHealSubscriptions = onSchedule(
  { schedule: 'every 15 minutes', timeZone: 'Africa/Nairobi', memory: '512MiB', timeoutSeconds: 540 },
  async () => {
    const now    = Date.now();
    const issues = [];

    /* 1. Active subscriptions past their period end */
    const expiredSnap = await db().collection('aiSubscriptions')
      .where('status', '==', 'active')
      .where('currentPeriodEnd', '<', now)
      .limit(100).get();

    const b1 = db().batch();
    expiredSnap.forEach(d => {
      const sub = d.data();
      if (sub.plan === 'ai_free') return;
      b1.update(d.ref, { status: 'past_due', pastDueAt: now });
      issues.push({ type: 'expired_to_past_due', uid: sub.uid, plan: sub.plan });
    });
    if (!expiredSnap.empty) await b1.commit();

    /* 2. Apply pending downgrades */
    const downSnap = await db().collection('aiSubscriptions')
      .where('pendingPlan', '!=', null)
      .where('pendingAt', '<', now)
      .limit(50).get();

    const b2 = db().batch();
    downSnap.forEach(d => {
      const s = d.data();
      b2.update(d.ref, {
        plan:               s.pendingPlan,
        billing:            s.pendingBilling || 'monthly',
        currentPeriodStart: now,
        currentPeriodEnd:   now + ((s.pendingBilling === 'annual' ? 365 : 30) * 86400000),
        pendingPlan:        admin.firestore.FieldValue.delete(),
        pendingBilling:     admin.firestore.FieldValue.delete(),
        pendingAt:          admin.firestore.FieldValue.delete(),
        status:             'active',
        updatedAt:          now,
      });
      issues.push({ type: 'downgrade_applied', uid: s.uid, newPlan: s.pendingPlan });
    });
    if (!downSnap.empty) await b2.commit();

    /* 3. Past-due accounts: queue payment retry notification */
    const pastDueSnap = await db().collection('aiSubscriptions')
      .where('status', '==', 'past_due')
      .where('pastDueAt', '>', now - 7 * 86400000)
      .limit(50).get();

    const b3 = db().batch();
    pastDueSnap.forEach(d => {
      const s = d.data();
      if (!s.retryQueued) {
        b3.set(db().collection('notificationQueue').doc(), {
          uid: s.uid, type: 'payment_retry', plan: s.plan,
          ts: now, channel: ['push', 'email'],
        });
        b3.update(d.ref, { retryQueued: true });
        issues.push({ type: 'payment_retry_queued', uid: s.uid });
      }
    });
    if (!pastDueSnap.empty) await b3.commit();

    /* 4. Refresh entitlement cache for affected users */
    const affectedUids = new Set([
      ...expiredSnap.docs.map(d => d.data().uid),
      ...downSnap.docs.map(d => d.data().uid),
    ].filter(Boolean));

    if (affectedUids.size > 0) {
      const b4 = db().batch();
      affectedUids.forEach(u => {
        b4.set(db().collection('entitlements').doc(u), { updatedAt: now, needsRefresh: true }, { merge: true });
      });
      await b4.commit();
    }

    /* 5. Write self-heal log */
    if (issues.length) {
      await db().collection('selfHealLog').add({ ts: now, issues, issueCount: issues.length });
      logger.info(`[SubOS] selfHeal: resolved ${issues.length} issues`);
    } else {
      logger.info('[SubOS] selfHeal: no issues found');
    }

    return null;
  }
);

/* ================================================================
   sendBillingReminders — Scheduler: daily 09:00 EAT
   Queues push + email reminders at 7, 3, and 1 day before renewal.
================================================================ */
const sendBillingReminders = onSchedule(
  { schedule: '0 9 * * *', timeZone: 'Africa/Nairobi', memory: '256MiB', timeoutSeconds: 300 },
  async () => {
    const now = Date.now();
    const WINDOWS = [7 * 86400000, 3 * 86400000, 86400000];

    for (const win of WINDOWS) {
      const lo = now + win - 3600000;
      const hi = now + win + 3600000;
      const snap = await db().collection('aiSubscriptions')
        .where('status', '==', 'active')
        .where('currentPeriodEnd', '>', lo)
        .where('currentPeriodEnd', '<', hi)
        .limit(200).get();

      const batch = db().batch();
      snap.forEach(d => {
        const s = d.data();
        if (!s.uid || s.plan === 'ai_free') return;
        const plan   = AI_PLANS[s.plan];
        const amount = s.billing === 'annual' ? (plan?.annualPrice || 0) : (plan?.price || 0);
        batch.set(db().collection('notificationQueue').doc(), {
          uid: s.uid, type: 'billing_reminder',
          daysUntilRenewal: Math.round(win / 86400000),
          plan: s.plan, amount, ts: now, channel: ['push', 'email'],
        });
      });
      if (!snap.empty) await batch.commit();
    }

    logger.info('[SubOS] sendBillingReminders: processed');
    return null;
  }
);

/* ================================================================
   reconcileBilling — Scheduler: daily 02:00 EAT
   Verifies all paid active subscriptions have matching payment records.
   Flags anomalies to billingReconciliation collection for admin review.
================================================================ */
const reconcileBilling = onSchedule(
  { schedule: '0 2 * * *', timeZone: 'Africa/Nairobi', memory: '512MiB', timeoutSeconds: 540 },
  async () => {
    const now    = Date.now();
    const issues = [];

    const snap = await db().collection('aiSubscriptions')
      .where('status', '==', 'active')
      .limit(500).get();

    snap.forEach(d => {
      const s = d.data();
      if (s.plan === 'ai_free') return;
      if (!s.paymentRef)                                  issues.push({ uid: s.uid, plan: s.plan, issue: 'no_payment_ref' });
      if (s.currentPeriodEnd && s.currentPeriodEnd < now) issues.push({ uid: s.uid, plan: s.plan, issue: 'period_expired' });
    });

    await db().collection('billingReconciliation').add({
      ts: now, issueCount: issues.length, issues: issues.slice(0, 50), resolved: issues.length === 0,
    });

    logger.info(`[SubOS] reconcileBilling: ${issues.length} anomalies`);
    return null;
  }
);

/* ── Exports ─────────────────────────────────────────────────── */
module.exports = {
  generateEntitlementToken,
  verifyEntitlement,
  processSubscriptionChange,
  detectFraud,
  proposeFinancialChange,
  approveFinancialChange,
  forecastRevenue,
  runSubscriptionBrain,
  selfHealSubscriptions,
  sendBillingReminders,
  reconcileBilling,
};
