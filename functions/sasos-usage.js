/* ================================================================
   SOKONI UNIVERSAL AI SUBSCRIPTION OPERATING SYSTEM
   sasos-usage.js — Usage Metering Engine v1.0.0  |  2026-06-21

   Real-time usage tracking, quota enforcement, AI credit management,
   storage allocation, and automated monthly usage reset.

   Design principles:
     • All usage increments are atomic (Firestore transactions).
     • Quotas are enforced server-side before incrementing.
     • Usage counters are stored per uid + product + period (YYYY-MM).
     • AI credits are a separate ledger from usage quotas.
     • Storage allocation is tracked in bytes, reported in GB.
     • Monthly reset zeroes counters but preserves the credit balance.

   Exports:
     sasosRecordUsage      — atomic: record a usage event
     sasosGetUsage         — get usage for uid + product + period
     sasosCheckQuota       — pre-check: will this usage be allowed?
     sasosDeductCredits    — atomic: deduct AI credits
     sasosAllocateCredits  — admin: credit AI credits to user
     sasosGetCredits       — get credit balance
     sasosResetMonthlyUsage — scheduled monthly: reset all usage counters

   Collections:
     sasosUsage/{uid}_{product}_{period}  — usage counters
     sasosCreditLedger/{txnId}            — immutable credit transactions
     sasosStorageUsage/{uid}              — storage quota per product
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { logger }             = require('firebase-functions');
const admin                  = require('firebase-admin');
const FieldValue             = admin.firestore.FieldValue;
const { _resolvePlan, _getActivePlanId, SASOS_PRODUCTS } = require('./sasos-core');

const { assertAuth, assertAdmin, sanitize } = require('./shared/errors');
const { currentPeriod } = require('./shared/constants');

const db     = () => admin.firestore();
const san    = (s, n = 200) => sanitize(s, n);
const period = () => currentPeriod();

/* ── Usage document ID ───────────────────────────────────── */
const usageId = (uid, product, p) => `${uid}_${product}_${p || period()}`;

/* ── Bytes to GB ─────────────────────────────────────────── */
const bytesToGB = b => Math.round((b / (1024 ** 3)) * 1000) / 1000;
const GBtoBytes = g => Math.round(g * (1024 ** 3));

/* ================================================================
   sasosRecordUsage
   Atomically records a usage event for a product+feature.
   Enforces the plan quota before incrementing:
   • Returns { allowed: false } if quota exceeded (no increment).
   • Returns { allowed: true, remaining } on success.

   The delta parameter supports batch events (e.g., uploading 5 files
   at once counts as delta=5 against the quota).
================================================================ */
const sasosRecordUsage = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '256MiB' },
  async (req) => {
    const uid      = assertAuth(req);
    const product  = san(req.data.product, 30);
    const feature  = san(req.data.feature, 60);
    const delta    = Math.max(1, Math.min(Number(req.data.delta) || 1, 1000));

    if (!SASOS_PRODUCTS.includes(product))
      throw new HttpsError('invalid-argument', `Unknown product: ${product}`);

    const planId = await _getActivePlanId(uid, product);
    const plan   = await _resolvePlan(planId);
    if (!plan) throw new HttpsError('not-found', 'Plan not found.');

    const p         = period();
    const usageRef  = db().collection('sasosUsage').doc(usageId(uid, product));

    /* Determine quota from plan */
    let quota = -1;  /* -1 = unlimited by default */
    if (product === 'ai' && plan.quotas) {
      quota = plan.quotas[feature] ?? -1;
    } else if (plan.limits) {
      const lim = plan.limits[feature];
      if (typeof lim === 'number') quota = lim;
    }

    if (quota === 0)  return { allowed: false, remaining: 0, reason: `${feature} not available on ${plan.name}.` };
    if (quota === -1) {
      /* Unlimited: record usage for analytics but don't gate */
      await usageRef.set({
        uid, product, period: p,
        [`counters.${feature}`]: FieldValue.increment(delta),
        [`totals.${feature}`]:   FieldValue.increment(delta),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return { allowed: true, remaining: -1, source: 'unlimited' };
    }

    /* Quota-enforced: transactional increment with gate */
    const result = await db().runTransaction(async txn => {
      const usageSnap = await txn.get(usageRef);
      const used      = usageSnap.exists ? (usageSnap.data().counters?.[feature] || 0) : 0;
      const remaining = Math.max(0, quota - used);

      if (remaining < delta) {
        return { allowed: false, remaining, used, limit: quota, reason: `${feature} quota exhausted.` };
      }

      txn.set(usageRef, {
        uid, product, period: p,
        [`counters.${feature}`]: FieldValue.increment(delta),
        [`totals.${feature}`]:   FieldValue.increment(delta),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      const newRemaining = remaining - delta;
      return { allowed: true, remaining: newRemaining, used: used + delta, limit: quota, warn: newRemaining <= Math.ceil(quota * 0.2) };
    });

    if (result.allowed) logger.debug(`[SASOS-Usage] record: uid=${uid} product=${product} feature=${feature} delta=${delta}`);
    return result;
  }
);

/* ================================================================
   sasosGetUsage
   Returns usage counters for uid + product, current period.
   Includes quota totals from the active plan.
================================================================ */
const sasosGetUsage = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    const uid     = assertAuth(req);
    const product = san(req.data.product || '', 30);
    const p       = san(req.data.period  || period(), 7);

    const products = product ? [product] : SASOS_PRODUCTS;
    const results  = {};

    await Promise.all(products.map(async prod => {
      const [usageSnap, planId] = await Promise.all([
        db().collection('sasosUsage').doc(usageId(uid, prod, p)).get(),
        _getActivePlanId(uid, prod),
      ]);
      const plan     = await _resolvePlan(planId);
      const counters = usageSnap.exists ? (usageSnap.data().counters || {}) : {};
      const totals   = usageSnap.exists ? (usageSnap.data().totals   || {}) : {};
      const limits   = plan?.limits  || {};
      const quotas   = plan?.quotas  || {};

      /* Merge usage against limits for a rich usage report */
      const merged = {};
      const allKeys = new Set([...Object.keys(counters), ...Object.keys(limits), ...Object.keys(quotas)]);
      allKeys.forEach(key => {
        const used  = counters[key] || 0;
        const limit = limits[key] ?? quotas[key] ?? -1;
        merged[key] = { used, limit, remaining: limit === -1 ? -1 : Math.max(0, limit - used), pct: limit > 0 ? Math.round((used / limit) * 100) : 0 };
      });

      results[prod] = { period: p, planId, tier: plan?.tier, counters, totals, usage: merged };
    }));

    return product ? results[product] : results;
  }
);

/* ================================================================
   sasosCheckQuota
   Non-mutating pre-check: will the next usage event be allowed?
   Useful for UI pre-validation before triggering expensive ops.
================================================================ */
const sasosCheckQuota = onCall(
  { region: 'us-central1', timeoutSeconds: 10, memory: '128MiB' },
  async (req) => {
    const uid     = assertAuth(req);
    const product = san(req.data.product, 30);
    const feature = san(req.data.feature, 60);
    const delta   = Math.max(1, Number(req.data.delta) || 1);

    const planId = await _getActivePlanId(uid, product);
    const plan   = await _resolvePlan(planId);
    if (!plan) return { allowed: false, reason: 'Plan not found.' };

    let quota = -1;
    if (product === 'ai' && plan.quotas) quota = plan.quotas[feature] ?? -1;
    else if (plan.limits) { const lim = plan.limits[feature]; if (typeof lim === 'number') quota = lim; }

    if (quota === 0)  return { allowed: false, remaining: 0, reason: `${feature} not available on ${plan.name}.`, planId };
    if (quota === -1) return { allowed: true, remaining: -1, source: 'unlimited', planId };

    const usageSnap = await db().collection('sasosUsage').doc(usageId(uid, product)).get();
    const used      = usageSnap.exists ? (usageSnap.data().counters?.[feature] || 0) : 0;
    const remaining = Math.max(0, quota - used);
    const allowed   = remaining >= delta;

    return { allowed, remaining, used, limit: quota, planId, tier: plan.tier, warn: allowed && remaining <= Math.ceil(quota * 0.2) };
  }
);

/* ================================================================
   sasosDeductCredits
   Atomically deducts AI credits from a user's balance.
   Credits never go below 0. Returns { success, balance }.
================================================================ */
const sasosDeductCredits = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    const uid    = assertAuth(req);
    const amount = Math.max(1, Number(req.data.amount) || 1);
    const reason = san(req.data.reason || 'feature_use', 100);

    const credRef = db().collection('aiCredits').doc(uid);

    const result = await db().runTransaction(async txn => {
      const snap    = await txn.get(credRef);
      const balance = snap.exists ? (snap.data().balance || 0) : 0;

      if (balance < amount)
        return { success: false, balance, required: amount, reason: 'Insufficient credits.' };

      txn.set(credRef, {
        uid,
        balance:       FieldValue.increment(-amount),
        totalSpent:    FieldValue.increment(amount),
        lastDeducted:  Date.now(),
      }, { merge: true });

      return { success: true, balance: balance - amount, deducted: amount };
    });

    if (result.success) {
      /* Async audit — don't block the response */
      db().collection('sasosCreditLedger').add({
        type: 'deduction', uid, amount: -amount, reason,
        balanceAfter: result.balance,
        ts: admin.firestore.FieldValue.serverTimestamp(), immutable: true,
      }).catch(() => {});
    }

    return result;
  }
);

/* ================================================================
   sasosAllocateCredits
   Admin-only. Credits AI credits to a user (plan allocation,
   promotion, compensation, etc.). Creates an immutable ledger entry.
================================================================ */
const sasosAllocateCredits = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    const adminUid  = assertAdmin(req);
    const targetUid = san(req.data.uid, 128);
    const amount    = Math.max(1, Number(req.data.amount) || 0);
    const reason    = san(req.data.reason || 'admin_allocation', 100);

    if (!targetUid || amount <= 0)
      throw new HttpsError('invalid-argument', 'uid and amount required.');

    const now     = Date.now();
    const batch   = db().batch();
    const credRef = db().collection('aiCredits').doc(targetUid);

    /* ── THE ATOMIC CLAIM ───────────────────────────────────────────────────
       This granted credits with no idempotency key of any kind: an admin
       double-click, or a retry after a dropped response, ran
       `increment(amount)` twice and there is no way to un-grant credits.

       sasos-admin.html now mints one allocationId per intended allocation and
       reuses it across retries. A caller that does not supply one (an older
       cached client) still works exactly as before — its generated key is
       unique per call — so this is backward compatible while the shipped client
       is genuinely protected. */
    const allocationId = san(req.data.allocationId || '', 128) ||
      ('srv_' + adminUid + '_' + now + '_' + Math.random().toString(36).slice(2, 10));
    batch.create(db().collection('sasosAllocationClaims').doc(allocationId), {
      allocationId, uid: targetUid, adminUid, amount, reason, claimedAt: now,
    });

    batch.set(credRef, {
      uid: targetUid,
      balance:        FieldValue.increment(amount),
      totalPurchased: FieldValue.increment(amount),
      lastCredited:   now,
    }, { merge: true });

    batch.set(db().collection('sasosCreditLedger').doc(), {
      type: 'allocation', uid: targetUid, adminUid, amount, reason,
      ts: FieldValue.serverTimestamp(), immutable: true,
    });

    batch.set(db().collection('sasosAuditLog').doc(), {
      type: 'credit_allocation', uid: targetUid, adminUid, amount, reason,
      ts: FieldValue.serverTimestamp(), server: true,
    });

    try {
      await batch.commit();
    } catch (e) {
      /* The claim did its job — this allocationId was already granted, so the
         whole batch including the increments was rejected. */
      if (e && (e.code === 6 || String(e.message || '').indexOf('ALREADY_EXISTS') > -1)) {
        logger.info(`[SASOS-Usage] Duplicate allocation refused: ${allocationId}`);
        return { success: true, allocated: amount, duplicate: true };
      }
      throw e;
    }
    logger.info(`[SASOS-Usage] Credits allocated: uid=${targetUid} amount=${amount} by=${adminUid}`);
    return { success: true, allocated: amount };
  }
);

/* ================================================================
   sasosGetCredits
   Returns the user's current AI credit balance and ledger summary.
================================================================ */
const sasosGetCredits = onCall(
  { region: 'us-central1', timeoutSeconds: 10, memory: '128MiB' },
  async (req) => {
    const uid = assertAuth(req);

    const [credSnap, recentSnap] = await Promise.all([
      db().collection('aiCredits').doc(uid).get(),
      db().collection('sasosCreditLedger')
        .where('uid', '==', uid)
        .orderBy('ts', 'desc')
        .limit(10).get(),
    ]);

    const balance        = credSnap.exists ? (credSnap.data().balance        || 0) : 0;
    const totalPurchased = credSnap.exists ? (credSnap.data().totalPurchased  || 0) : 0;
    const totalSpent     = credSnap.exists ? (credSnap.data().totalSpent      || 0) : 0;
    const recent         = recentSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    return { balance, totalPurchased, totalSpent, recent };
  }
);

/* ================================================================
   sasosAllocateStorage
   Records and validates storage usage changes.
   Enforces plan storage limits before allowing uploads.
================================================================ */
const sasosAllocateStorage = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    const uid      = assertAuth(req);
    const product  = san(req.data.product, 30);
    const deltaBytes = Number(req.data.bytes) || 0;  /* + for allocate, - for free */

    if (!SASOS_PRODUCTS.includes(product))
      throw new HttpsError('invalid-argument', `Unknown product: ${product}`);

    const planId = await _getActivePlanId(uid, product);
    const plan   = await _resolvePlan(planId);
    const limitGB = plan?.limits?.storage_gb ?? 0.5;
    const limitBytes = GBtoBytes(limitGB);

    const storageRef = db().collection('sasosStorageUsage').doc(`${uid}_${product}`);

    const result = await db().runTransaction(async txn => {
      const snap  = await txn.get(storageRef);
      const usedBytes = snap.exists ? (snap.data().usedBytes || 0) : 0;
      const newBytes  = usedBytes + deltaBytes;

      if (limitGB !== -1 && deltaBytes > 0 && newBytes > limitBytes) {
        return {
          allowed:    false,
          usedGB:     bytesToGB(usedBytes),
          limitGB,
          deltaGB:    bytesToGB(deltaBytes),
          reason:     `Storage limit of ${limitGB} GB exceeded.`,
          upgradeRequired: true,
        };
      }

      txn.set(storageRef, {
        uid, product, planId,
        usedBytes:     FieldValue.increment(deltaBytes),
        limitBytes,
        limitGB,
        updatedAt:     FieldValue.serverTimestamp(),
      }, { merge: true });

      return {
        allowed:  true,
        usedBytes: Math.max(0, newBytes),
        usedGB:    bytesToGB(Math.max(0, newBytes)),
        limitGB,
        remainingGB: limitGB === -1 ? -1 : Math.max(0, limitGB - bytesToGB(Math.max(0, newBytes))),
      };
    });

    return result;
  }
);

/* ================================================================
   sasosGetStorageUsage
   Returns storage usage breakdown for a user across all products.
================================================================ */
const sasosGetStorageUsage = onCall(
  { region: 'us-central1', timeoutSeconds: 10, memory: '128MiB' },
  async (req) => {
    const uid = assertAuth(req);

    const snaps = await Promise.all(
      SASOS_PRODUCTS.map(p => db().collection('sasosStorageUsage').doc(`${uid}_${p}`).get())
    );

    const storage = {};
    let totalUsedBytes = 0;

    SASOS_PRODUCTS.forEach((prod, i) => {
      const snap = snaps[i];
      const used = snap.exists ? (snap.data().usedBytes || 0) : 0;
      const lim  = snap.exists ? (snap.data().limitGB   || 0.5) : 0.5;
      storage[prod] = { usedBytes: used, usedGB: bytesToGB(used), limitGB: lim };
      totalUsedBytes += used;
    });

    return { storage, totalUsedGB: bytesToGB(totalUsedBytes) };
  }
);

/* ================================================================
   sasosResetMonthlyUsage  [Scheduled — 1st of each month 00:30 EAT]
   Resets per-period usage counters for all users.
   Credit balances are NOT reset — only period counters.
   Monthly plan credits are re-allocated here.
================================================================ */
const sasosResetMonthlyUsage = onSchedule(
  { schedule: '30 21 28-31 * *', timeZone: 'UTC', region: 'us-central1', memory: '512MiB', timeoutSeconds: 540 },
  async () => {
    /* Only run on the last day of the month to prepare for the new period */
    const tomorrow = new Date(Date.now() + 86400000);
    if (tomorrow.getDate() !== 1) {
      logger.info('[SASOS-Usage] Not end of month — skipping reset.');
      return;
    }

    const newPeriod = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,'0')}`;
    logger.info(`[SASOS-Usage] Monthly reset: preparing period ${newPeriod}`);

    /* Re-allocate monthly AI credits for active subscriptions */
    const activeSnap = await db().collection('sasosSubscriptions').limit(1000).get();
    const batch      = db().batch();
    let   credited   = 0;

    for (const doc of activeSnap.docs) {
      const data  = doc.data();
      const uid   = doc.id;
      const aiSub = data.products?.ai;
      if (!aiSub || aiSub.status !== 'active') continue;

      const plan = await _resolvePlan(aiSub.planId);
      if (!plan || !plan.limits?.ai_credits || plan.limits.ai_credits <= 0) continue;

      /* Only re-credit at the start of each plan period */
      const periodStart = aiSub.periodStart || 0;
      const daysSinceStart = (Date.now() - periodStart) / 86400000;
      if (daysSinceStart < 25) continue;  /* Only for subscriptions > 25 days into the period */

      /* P0-6: scheduled runs are an AT-LEAST-ONCE source — Cloud Scheduler retries a
         failed run, and this loop commits INCREMENTALLY (every 499 docs). So a mid-run
         failure leaves some users already credited, and the retry would credit them
         AGAIN. `lastCredited` was written here but READ NOWHERE — the same
         written-but-never-read guard bug as P0-5.

         Fix: use the period as a REAL idempotency marker that is actually read. A retry
         skips users already credited for this period. FieldValue.increment() is atomic
         but NOT idempotent, so the guard — not the increment — is what protects us. */
      const creditRef  = db().collection('aiCredits').doc(uid);
      const creditSnap = await creditRef.get();
      if (creditSnap.exists && creditSnap.data().lastCreditedPeriod === newPeriod) {
        continue;   /* already credited for this period (retry / redelivery) */
      }

      /* @financial-safe: guarded by the lastCreditedPeriod marker READ immediately above
         (P0-6). A retry finds lastCreditedPeriod === newPeriod and skips this user, so
         the increment runs at most once per user per period. */
      batch.set(creditRef, {
        uid,
        balance:            FieldValue.increment(plan.limits.ai_credits),
        totalPurchased:     FieldValue.increment(plan.limits.ai_credits),
        lastCredited:       Date.now(),
        lastCreditedPeriod: newPeriod,   /* ← the marker, now actually READ above */
      }, { merge: true });

      credited++;
      if (credited % 499 === 0) { /* Firestore batch limit is 500 */ await batch.commit(); }
    }

    if (credited % 499 !== 0) await batch.commit();
    logger.info(`[SASOS-Usage] Monthly reset complete: credited ${credited} users for period ${newPeriod}`);
  }
);

/* ── Exports ─────────────────────────────────────────────── */
module.exports = {
  sasosRecordUsage,
  sasosGetUsage,
  sasosCheckQuota,
  sasosDeductCredits,
  sasosAllocateCredits,
  sasosGetCredits,
  sasosAllocateStorage,
  sasosGetStorageUsage,
  sasosResetMonthlyUsage,
};
