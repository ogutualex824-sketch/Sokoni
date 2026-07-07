/* ================================================================
   SOKONI Installments / BNPL v1.0
   Buy Now Pay Later — flexible payment plan engine

   Cloud Functions (6):
     installmentCreatePlan      — create a BNPL plan for an order
     installmentRecordPayment   — record a payment against a plan
     installmentGetMyPlans      — buyer: list own plans (latest 20)
     installmentGetSellerPlans  — seller/admin: list plans by seller
     installmentMarkOverdue     — scheduled daily 01:00 UTC
     installmentCancelPlan      — buyer/admin: cancel a plan

   Collection layout:
     installmentPlans/{planId}
       .installmentPayments/{paymentId}   ← subcollection

   Amounts: KES, stored as float rounded to 2 decimal places.
================================================================ */
'use strict';

const { onCall, HttpsError }     = require('firebase-functions/v2/https');
const { onSchedule }             = require('firebase-functions/v2/scheduler');
const logger                     = require('firebase-functions/logger');
const admin                      = require('firebase-admin');
const { getApps, initializeApp } = require('firebase-admin/app');

/* ── Single-init guard ───────────────────────────────────────── */
if (!getApps().length) initializeApp();

const REGION = 'us-central1';
const OPT    = { region: REGION, enforceAppCheck: true, timeoutSeconds: 30, memory: '256MiB' };

/* Lazy accessors — avoids holding a stale db reference at module load */
const db   = () => admin.firestore();
const now  = () => admin.firestore.FieldValue.serverTimestamp();
const TS   = (d) => admin.firestore.Timestamp.fromDate(d instanceof Date ? d : new Date(d));

/* ── Plan configuration ──────────────────────────────────────── */
const PLAN_MONTHS    = { '3_month': 3, '6_month': 6, '12_month': 12 };
const UPFRONT_RATIO  = 0.30;   // 30 % of total paid upfront
const VALID_STATUSES = new Set(['active', 'completed', 'defaulted', 'cancelled']);
const VALID_CURRENCIES = new Set(['KES']);

/* ── Auth helpers ───────────────────────────────────────────── */
function _requireAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required.');
  return req.auth;
}

function _requireSellerOrAdmin(req) {
  const auth = _requireAuth(req);
  if (
    !req.auth.token?.seller    &&
    !req.auth.token?.admin     &&
    !req.auth.token?.superAdmin
  ) {
    throw new HttpsError('permission-denied', 'Seller or admin access required.');
  }
  return auth;
}

function _isAdmin(req) {
  return !!(req.auth?.token?.admin || req.auth?.token?.superAdmin);
}

/* ── Input sanitiser ────────────────────────────────────────── */
function _str(val, field, maxLen = 128) {
  if (typeof val !== 'string' || !val.trim())
    throw new HttpsError('invalid-argument', `${field} must be a non-empty string.`);
  if (val.length > maxLen)
    throw new HttpsError('invalid-argument', `${field} exceeds maximum length of ${maxLen}.`);
  return val.trim();
}

function _posNum(val, field) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0)
    throw new HttpsError('invalid-argument', `${field} must be a positive number.`);
  return Math.round(n * 100) / 100;
}

/* ── Audit writer ───────────────────────────────────────────── */
async function _audit(action, actorUid, data = {}) {
  try {
    await db().collection('installmentAudit').add({
      action, actorUid, ...data, timestamp: now(),
    });
  } catch (err) {
    logger.warn('Audit write failed', { action, err: err.message });
  }
}

/* ── Notification helper ─────────────────────────────────────── */
async function _notify(uid, type, payload) {
  try {
    await db().collection('notifications').add({
      uid, type, ...payload, read: false, createdAt: now(),
    });
  } catch (_) { /* non-fatal */ }
}

/* ═══════════════════════════════════════════════════════════════
   SCHEDULE BUILDER
   Returns the full installment schedule and key amounts.

   Layout for N-month plan:
     index 0   → upfront = 30% of total, due today
     index 1…N-1 → (total – upfront) split equally, monthly
   The final installment absorbs any rounding remainder so the
   sum of all amounts equals totalAmount exactly.
═══════════════════════════════════════════════════════════════ */
function _buildSchedule(totalAmount, planType) {
  const months   = PLAN_MONTHS[planType];
  const upfront  = Math.round(totalAmount * UPFRONT_RATIO * 100) / 100;
  const balance  = Math.round((totalAmount - upfront) * 100) / 100;
  const monthlyN = months - 1; // number of monthly payments after upfront
  const baseAmt  = monthlyN > 0
    ? Math.round((balance / monthlyN) * 100) / 100
    : 0;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const schedule = [];

  /* Installment 0 — upfront, due today */
  schedule.push({
    dueDate: TS(today),
    amount:  upfront,
    status:  'pending',
    paidAt:  null,
  });

  /* Installments 1…N-1 — monthly, equal (last absorbs rounding) */
  let allocated = 0;
  for (let i = 1; i < months; i++) {
    const due = new Date(today);
    due.setMonth(due.getMonth() + i);

    const isLast = i === months - 1;
    const amt    = isLast
      ? Math.round((balance - allocated) * 100) / 100
      : baseAmt;

    if (!isLast) allocated = Math.round((allocated + baseAmt) * 100) / 100;

    schedule.push({
      dueDate: TS(due),
      amount:  amt,
      status:  'pending',
      paidAt:  null,
    });
  }

  return { schedule, upfrontAmount: upfront, installmentAmount: baseAmt };
}

/* ═══════════════════════════════════════════════════════════════
   CF 1 — installmentCreatePlan
   Auth: required (buyer)

   Creates a BNPL installment plan for an existing order.
   Validates order ownership and ensures no duplicate active plan.
═══════════════════════════════════════════════════════════════ */
exports.installmentCreatePlan = onCall(
  OPT,
  async (req) => {
    const auth = _requireAuth(req);
    const uid  = auth.uid;

    /* ── Input validation ── */
    const orderId  = _str(req.data?.orderId,     'orderId');
    const rawTotal = req.data?.totalAmount;
    const planType = _str(req.data?.planType,    'planType', 32);
    const currency = (req.data?.currency ?? 'KES').toString().trim().toUpperCase();

    if (!PLAN_MONTHS[planType])
      throw new HttpsError('invalid-argument',
        `planType must be one of: ${Object.keys(PLAN_MONTHS).join(', ')}.`);
    if (!VALID_CURRENCIES.has(currency))
      throw new HttpsError('invalid-argument', `Unsupported currency: ${currency}.`);

    const totalAmount = _posNum(rawTotal, 'totalAmount');
    if (totalAmount < 100)
      throw new HttpsError('invalid-argument', 'totalAmount must be at least KES 100.');

    const firestore = db();

    /* ── Verify order exists and belongs to caller ── */
    const orderRef  = firestore.collection('orders').doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists)
      throw new HttpsError('not-found', `Order ${orderId} not found.`);

    const order = orderSnap.data();
    const isOwner = order.buyerId === uid || order.userId === uid;
    if (!isOwner)
      throw new HttpsError('permission-denied', 'You do not own this order.');

    /* ── Check no existing active plan for this order ── */
    const existing = await firestore
      .collection('installmentPlans')
      .where('orderId', '==', orderId)
      .where('status', 'in', ['active'])
      .limit(1)
      .get();

    if (!existing.empty)
      throw new HttpsError('already-exists',
        'An active installment plan already exists for this order.');

    /* ── Build schedule ── */
    const { schedule, upfrontAmount, installmentAmount } = _buildSchedule(totalAmount, planType);
    const remainingBalance = totalAmount; // nothing paid yet

    /* ── Persist plan ── */
    const planRef = firestore.collection('installmentPlans').doc();
    const planId  = planRef.id;

    const planData = {
      planId,
      orderId,
      buyerId:           uid,
      sellerId:          order.sellerId  ?? order.vendorId ?? null,
      totalAmount,
      currency,
      planType,
      upfrontAmount,
      installmentAmount,
      remainingBalance,
      status:            'active',
      schedule,
      cancellationReason: null,
      cancellationBy:     null,
      cancelledAt:        null,
      createdAt:         now(),
      updatedAt:         now(),
    };

    await planRef.set(planData);

    await _audit('installmentCreatePlan', uid, {
      planId, orderId, totalAmount, planType, currency,
    });

    logger.info('Installment plan created', { planId, orderId, buyerId: uid, planType });

    return { planId, schedule, upfrontAmount };
  }
);

/* ═══════════════════════════════════════════════════════════════
   CF 2 — installmentRecordPayment
   Auth: required (buyer who owns the plan)

   Records a payment against a specific installment index.
   Uses runTransaction to prevent double-recording and to
   atomically update remainingBalance and plan status.
═══════════════════════════════════════════════════════════════ */
exports.installmentRecordPayment = onCall(
  OPT,
  async (req) => {
    const auth = _requireAuth(req);
    const uid  = auth.uid;

    /* ── Input validation ── */
    const planId           = _str(req.data?.planId,           'planId');
    const paymentReference = _str(req.data?.paymentReference, 'paymentReference', 256);
    const installmentIndex = req.data?.installmentIndex;

    if (
      !Number.isInteger(installmentIndex) ||
      installmentIndex < 0
    ) {
      throw new HttpsError('invalid-argument',
        'installmentIndex must be a non-negative integer.');
    }

    const firestore  = db();
    const planRef    = firestore.collection('installmentPlans').doc(planId);
    let finalBalance;
    let planStatus;

    await firestore.runTransaction(async (txn) => {
      const planSnap = await txn.get(planRef);
      if (!planSnap.exists)
        throw new HttpsError('not-found', `Plan ${planId} not found.`);

      const plan = planSnap.data();

      /* ── Ownership check ── */
      if (plan.buyerId !== uid)
        throw new HttpsError('permission-denied', 'You do not own this plan.');

      if (plan.status === 'cancelled')
        throw new HttpsError('failed-precondition', 'This plan has been cancelled.');
      if (plan.status === 'completed')
        throw new HttpsError('failed-precondition', 'This plan is already fully paid.');

      const schedule = [...plan.schedule];

      if (installmentIndex >= schedule.length)
        throw new HttpsError('out-of-range',
          `installmentIndex ${installmentIndex} exceeds schedule length ${schedule.length}.`);

      const item = schedule[installmentIndex];
      if (item.status === 'paid')
        throw new HttpsError('already-exists',
          `Installment ${installmentIndex} is already marked as paid.`);
      if (item.status !== 'pending' && item.status !== 'overdue')
        throw new HttpsError('failed-precondition',
          `Installment ${installmentIndex} has status '${item.status}' and cannot be paid.`);

      /* ── Mark installment as paid ── */
      const paidAt = admin.firestore.Timestamp.now();
      schedule[installmentIndex] = {
        ...item,
        status: 'paid',
        paidAt,
        paymentReference,
      };

      /* ── Update remaining balance ── */
      finalBalance = Math.round(
        (plan.remainingBalance - item.amount) * 100
      ) / 100;
      if (finalBalance < 0) finalBalance = 0;

      /* ── Check if all installments are paid → complete the plan ── */
      const allPaid = schedule.every((s) => s.status === 'paid');
      planStatus = allPaid ? 'completed' : plan.status;

      txn.update(planRef, {
        schedule,
        remainingBalance: finalBalance,
        status:           planStatus,
        updatedAt:        now(),
      });
    });

    /* ── Write payment record to subcollection (outside transaction, best-effort) ── */
    try {
      await planRef.collection('installmentPayments').doc(paymentReference).set({
        planId,
        installmentIndex,
        paymentReference,
        paidBy:    uid,
        amount:    null, // enriched from plan schedule if needed
        createdAt: now(),
      });
    } catch (err) {
      logger.warn('Payment subcollection write failed', {
        planId, installmentIndex, err: err.message,
      });
    }

    await _audit('installmentRecordPayment', uid, {
      planId, installmentIndex, paymentReference, remainingBalance: finalBalance, planStatus,
    });

    /* ── Notify buyer on plan completion ── */
    if (planStatus === 'completed') {
      await _notify(uid, 'installment_completed', {
        title:   'Installment plan fully paid!',
        message: `Your plan ${planId} has been paid in full. Thank you.`,
        planId,
      });
    }

    logger.info('Installment payment recorded', {
      planId, installmentIndex, paymentReference, planStatus,
    });

    return { planId, installmentIndex, remainingBalance: finalBalance, planStatus };
  }
);

/* ═══════════════════════════════════════════════════════════════
   CF 3 — installmentGetMyPlans
   Auth: required (buyer)

   Returns the 20 most recent plans for the authenticated buyer.
═══════════════════════════════════════════════════════════════ */
exports.installmentGetMyPlans = onCall(
  OPT,
  async (req) => {
    const auth = _requireAuth(req);
    const uid  = auth.uid;

    const snap = await db()
      .collection('installmentPlans')
      .where('buyerId', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();

    const plans = snap.docs.map((d) => {
      const data = d.data();
      /* Serialise Timestamps to ISO strings for the client */
      return _serializePlan(data);
    });

    return { plans };
  }
);

/* ═══════════════════════════════════════════════════════════════
   CF 4 — installmentGetSellerPlans
   Auth: seller or admin

   Sellers see only their own plans; admins see all plans.
   Optional status filter. Limit 100.
═══════════════════════════════════════════════════════════════ */
exports.installmentGetSellerPlans = onCall(
  OPT,
  async (req) => {
    const auth = _requireSellerOrAdmin(req);
    const uid  = auth.uid;
    const isAdmin  = _isAdmin(req);
    const statusFilter = req.data?.status ?? null;

    if (statusFilter && !VALID_STATUSES.has(statusFilter))
      throw new HttpsError('invalid-argument',
        `status filter must be one of: ${[...VALID_STATUSES].join(', ')}.`);

    let query = db().collection('installmentPlans');

    /* Sellers are scoped to their own plans only */
    if (!isAdmin) query = query.where('sellerId', '==', uid);

    if (statusFilter) query = query.where('status', '==', statusFilter);

    query = query.orderBy('createdAt', 'desc').limit(100);

    const snap  = await query.get();
    const plans = snap.docs.map((d) => _serializePlan(d.data()));

    return { plans, count: plans.length };
  }
);

/* ═══════════════════════════════════════════════════════════════
   CF 5 — installmentMarkOverdue  (scheduled — 01:00 UTC daily)
   No user auth — triggered by Cloud Scheduler.

   Algorithm:
     1. Fetch up to 500 active plans.
     2. For each plan, find schedule items where dueDate < now
        AND status == 'pending'.
     3. Batch-update those items to 'overdue'.
     4. Also set plan-level hasOverdue flag.
     5. Log summary counts.

   Firestore limitation: array item conditions cannot be combined
   in a single query, so we fetch active plans and evaluate
   overdue items in memory — safe for ≤500 plans per run.
═══════════════════════════════════════════════════════════════ */
exports.installmentMarkOverdue = onSchedule(
  {
    schedule:       '0 1 * * *',
    timeZone:       'UTC',
    region:         REGION,
    timeoutSeconds: 540,
    memory:         '512MiB',
  },
  async (_event) => {
    const nowTs = admin.firestore.Timestamp.now();
    const firestore = db();

    /* Fetch active plans */
    const snap = await firestore
      .collection('installmentPlans')
      .where('status', '==', 'active')
      .limit(500)
      .get();

    if (snap.empty) {
      logger.info('installmentMarkOverdue: no active plans found.');
      return;
    }

    let plansUpdated    = 0;
    let itemsOverdue    = 0;
    const BATCH_LIMIT   = 499; // Firestore batch cap is 500 ops
    let batch           = firestore.batch();
    let batchOps        = 0;

    const flushBatch = async () => {
      if (batchOps > 0) {
        await batch.commit();
        batch    = firestore.batch();
        batchOps = 0;
      }
    };

    for (const doc of snap.docs) {
      const plan     = doc.data();
      const schedule = plan.schedule ? [...plan.schedule] : [];
      let   changed  = false;
      let   hasOverdue = false;

      for (let i = 0; i < schedule.length; i++) {
        const item = schedule[i];
        /* Only flip 'pending' items that are past their due date */
        if (
          item.status === 'pending' &&
          item.dueDate instanceof admin.firestore.Timestamp &&
          item.dueDate.toMillis() < nowTs.toMillis()
        ) {
          schedule[i] = { ...item, status: 'overdue' };
          changed = true;
          hasOverdue = true;
          itemsOverdue++;
        } else if (item.status === 'overdue') {
          hasOverdue = true;
        }
      }

      if (changed) {
        if (batchOps >= BATCH_LIMIT) await flushBatch();

        batch.update(doc.ref, {
          schedule,
          hasOverdue,
          updatedAt: now(),
        });

        batchOps++;
        plansUpdated++;
      }
    }

    await flushBatch();

    logger.info('installmentMarkOverdue completed', {
      totalActive: snap.size,
      plansUpdated,
      itemsOverdue,
      runAt: nowTs.toDate().toISOString(),
    });
  }
);

/* ═══════════════════════════════════════════════════════════════
   CF 6 — installmentCancelPlan
   Auth: required

   Rules:
     • Buyer can cancel if NO installments have been paid yet.
     • Admin can cancel any plan regardless of payment state.
     • If any installment has been paid → only admin can cancel.
═══════════════════════════════════════════════════════════════ */
exports.installmentCancelPlan = onCall(
  OPT,
  async (req) => {
    const auth   = _requireAuth(req);
    const uid    = auth.uid;
    const isAdmin = _isAdmin(req);

    /* ── Input validation ── */
    const planId = _str(req.data?.planId, 'planId');
    const reason = (req.data?.reason ?? '').toString().trim().slice(0, 500);

    const firestore = db();
    const planRef   = firestore.collection('installmentPlans').doc(planId);
    const planSnap  = await planRef.get();

    if (!planSnap.exists)
      throw new HttpsError('not-found', `Plan ${planId} not found.`);

    const plan = planSnap.data();

    /* ── Ownership: buyer can only cancel own plan; admin can cancel any ── */
    if (!isAdmin && plan.buyerId !== uid)
      throw new HttpsError('permission-denied', 'You do not own this plan.');

    /* ── State checks ── */
    if (plan.status === 'cancelled')
      throw new HttpsError('failed-precondition', 'This plan is already cancelled.');
    if (plan.status === 'completed')
      throw new HttpsError('failed-precondition', 'A completed plan cannot be cancelled.');

    /* ── Payment history check ── */
    const schedule    = plan.schedule ?? [];
    const paidCount   = schedule.filter((s) => s.status === 'paid').length;
    const anyPaid     = paidCount > 0;

    if (anyPaid && !isAdmin) {
      throw new HttpsError(
        'failed-precondition',
        `${paidCount} installment(s) have already been paid. Only an admin can cancel this plan.`
      );
    }

    /* ── Cancel ── */
    const cancelledAt = now();
    await planRef.update({
      status:             'cancelled',
      cancellationReason: reason || null,
      cancellationBy:     uid,
      cancelledAt,
      updatedAt:          cancelledAt,
    });

    await _audit('installmentCancelPlan', uid, {
      planId, reason, isAdmin, paidCount,
    });

    await _notify(plan.buyerId, 'installment_cancelled', {
      title:   'Installment plan cancelled',
      message: `Your installment plan ${planId} has been cancelled.${reason ? ` Reason: ${reason}` : ''}`,
      planId,
    });

    logger.info('Installment plan cancelled', { planId, cancelledBy: uid, isAdmin, paidCount });

    return {
      planId,
      status: 'cancelled',
      cancellationBy: uid,
      paidInstallments: paidCount,
    };
  }
);

/* ═══════════════════════════════════════════════════════════════
   SERIALISATION HELPER
   Converts Firestore Timestamps in a plan document to ISO strings
   so the data is safe to send over onCall (which JSON-encodes).
═══════════════════════════════════════════════════════════════ */
function _serializePlan(data) {
  const toISO = (v) =>
    v instanceof admin.firestore.Timestamp ? v.toDate().toISOString() : v;

  return {
    ...data,
    createdAt:   toISO(data.createdAt),
    updatedAt:   toISO(data.updatedAt),
    cancelledAt: toISO(data.cancelledAt),
    schedule: (data.schedule ?? []).map((item) => ({
      ...item,
      dueDate: toISO(item.dueDate),
      paidAt:  toISO(item.paidAt),
    })),
  };
}
