/* ================================================================
   SOKONI Payment Reconciliation Engine  v1.0  (6 Cloud Functions)
   ────────────────────────────────────────────────────────────────
   End-of-day reconciliation between payment gateways and the
   Firestore orders collection.

   Functions exported:
     runDailyReconciliation        — scheduled 1:30AM UTC (4:30AM EAT)
     getReconciliationReport       — admin: fetch report(s) by date
     flagUnmatchedPayment          — admin: flag a payment for review
     resolveUnmatchedPayment       — admin: resolve a flagged payment
     getMpesaReconciliationSummary — admin: M-Pesa summary for a date
     triggerManualReconciliation   — admin: run reconciliation on demand

   Collections:
     orders/{orderId}              — source of truth for orders
     reconciliationReports/{date}  — daily reports (keyed YYYY-MM-DD)
     unmatchedPayments/{paymentRef}— flagged discrepancies
     adminAlerts/{id}              — ops alerts

   All monetary values in KES integer cents.
   All timestamps via F.serverTimestamp().
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const admin                  = require('firebase-admin');
const { defineSecret }       = require('firebase-functions/params');

/* ── Secrets ────────────────────────────────────────────────
   INTASEND_API_KEY: used for future direct gateway queries.
   PAYMENT_HMAC_SECRET: matches the state-machine file.
   Both must exist in Secret Manager before deploying.
──────────────────────────────────────────────────────────────*/
const INTASEND_KEY        = defineSecret('INTASEND_API_KEY');
const PAYMENT_HMAC_SECRET = defineSecret('PAYMENT_HMAC_SECRET');

/* ── Admin SDK ─────────────────────────────────────────────── */
const db = admin.firestore();
const F  = admin.firestore.FieldValue;

/* ── Runtime config ────────────────────────────────────────── */
const REGION = 'us-central1';
const OPT    = { region: REGION, enforceAppCheck: true };

/* ── Order statuses considered "settled" for reconciliation ── */
const SETTLED_STATUSES = new Set(['completed', 'confirmed']);

/* ── Subscription entitlement reconciliation window ──────────────
   A COMPLETE subscription payment should become an active
   subscription within seconds via one of THREE real-time paths:
     1. intasendWebhook            (index.js — reads paymentIntents)
     2. subAutoActivateOnPayment   (sub-engine — payments onUpdate)
     3. activateSubscription       (onCall — client-invoked)
   Each has a distinct blind spot (webhook rejected, payment created
   already-COMPLETE so no onUpdate fires, tab closed before onCall).
   This backstop assumes ALL THREE can fail and sweeps for the
   residue. GRACE = don't touch a payment younger than this; the
   real-time paths deserve their moment first. LOOKBACK caps how far
   back a single run scans (older stragglers need a manual recovery
   run — they are historical, not an active-incident concern). */
const SUB_RECON_GRACE_MS    = 2  * 60 * 1000;        // 2 minutes
const SUB_RECON_LOOKBACK_MS = 24 * 60 * 60 * 1000;   // 24 hours
const SUB_PLAN_DAYS         = 30;                     // canonical entitlement length

/* ── M-Pesa payment method identifiers ─────────────────────── */
const MPESA_METHODS = new Set(['mpesa']);

/* ── Valid resolution outcomes ──────────────────────────────── */
const VALID_RESOLUTIONS = new Set(['matched', 'refunded', 'written_off']);

/* ================================================================
   HELPERS
================================================================ */

/**
 * Structured JSON logger scoped to a single invocation.
 * Every line shares a requestId for Cloud Logging correlation.
 */
function createLogger(context = {}) {
  const id = context.requestId ||
    (Date.now().toString(36) + Math.random().toString(36).slice(2, 7)).toUpperCase();
  const base = { requestId: id, service: 'payment-reconciliation', ...context };
  return {
    id,
    info:  (msg, extra = {}) => console.log(JSON.stringify({ severity: 'INFO',    message: msg, ...base, ...extra })),
    warn:  (msg, extra = {}) => console.warn(JSON.stringify({ severity: 'WARNING', message: msg, ...base, ...extra })),
    error: (msg, extra = {}) => console.error(JSON.stringify({ severity: 'ERROR',  message: msg, ...base, ...extra })),
    audit: (msg, extra = {}) => console.log(JSON.stringify({ severity: 'NOTICE',  message: msg, ...base, ...extra, audit: true })),
  };
}

/** Assert caller is authenticated. */
function assertAuth(req) {
  if (!req.auth?.uid) throw new HttpsError('unauthenticated', 'Authentication required.');
}

/** Assert caller has the admin custom claim. */
function assertAdmin(req) {
  assertAuth(req);
  if (!req.auth.token?.admin && !req.auth.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Admin access required.');
}

/**
 * Parse a date string 'YYYY-MM-DD' into start-of-day and end-of-day
 * UTC-offset Firestore Timestamps.
 * Returns { start: Timestamp, end: Timestamp, label: 'YYYY-MM-DD' }
 */
function parseDateRange(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr))
    throw new HttpsError('invalid-argument', `date must be in YYYY-MM-DD format, got: "${dateStr}".`);

  const [year, month, day] = dateStr.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31)
    throw new HttpsError('invalid-argument', `Invalid date: "${dateStr}".`);

  const start = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  const end   = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));

  return {
    start: admin.firestore.Timestamp.fromDate(start),
    end:   admin.firestore.Timestamp.fromDate(end),
    label: dateStr,
  };
}

/**
 * Return { start, end, label } for "yesterday" in UTC.
 */
function yesterdayRange() {
  const now       = new Date();
  const yesterday = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - 1,
    0, 0, 0, 0
  ));
  const label = yesterday.toISOString().slice(0, 10);
  return parseDateRange(label);
}

/**
 * Core reconciliation logic.
 * Queries all settled orders within [start, end] and checks:
 *   - paymentRef is present (for non-cash orders)
 *   - amountCents matches order total
 * Returns a reconciliation summary object.
 */
async function runReconciliationForRange(start, end, label, log) {
  log.info('Running reconciliation', { date: label, start: start.toDate().toISOString(), end: end.toDate().toISOString() });

  let totalOrders     = 0;
  let totalAmount     = 0;   // KES cents
  let matched         = 0;
  let unmatched       = 0;
  let amountVariance  = 0;   // KES cents (absolute sum of discrepancies)
  const unmatchedList = [];

  /* Page through settled orders for the day */
  let lastDoc = null;
  const baseQuery = db.collection('orders')
    .where('createdAt', '>=', start)
    .where('createdAt', '<=', end)
    .orderBy('createdAt', 'asc')
    .limit(200);

  /* eslint-disable no-await-in-loop */
  do {
    const snap = lastDoc
      ? await baseQuery.startAfter(lastDoc).get()
      : await baseQuery.get();

    if (snap.empty) break;

    for (const doc of snap.docs) {
      const order = doc.data();

      /* Only reconcile settled orders */
      if (!SETTLED_STATUSES.has(order.status)) continue;

      totalOrders++;
      const expectedAmount = order.amountCents || order.totalCents || 0;
      totalAmount += expectedAmount;

      /* ── Check paymentRef presence (for non-cash methods) ─── */
      const isCash = order.paymentMethod === 'cash';
      if (!isCash && !order.paymentRef) {
        unmatched++;
        amountVariance += expectedAmount;
        unmatchedList.push({
          orderId:       doc.id,
          paymentRef:    null,
          expectedCents: expectedAmount,
          actualCents:   0,
          variance:      expectedAmount,
          reason:        'missing_payment_ref',
          paymentMethod: order.paymentMethod || 'unknown',
          merchantId:    order.merchantId || null,
        });
        continue;
      }

      /* ── For M-Pesa orders: verify amount matches ────────── */
      if (MPESA_METHODS.has(order.paymentMethod)) {
        const recordedAmount = order.paidAmountCents || order.amountCents || 0;
        const variance       = Math.abs(expectedAmount - recordedAmount);

        if (variance > 0) {
          unmatched++;
          amountVariance += variance;
          unmatchedList.push({
            orderId:       doc.id,
            paymentRef:    order.paymentRef,
            expectedCents: expectedAmount,
            actualCents:   recordedAmount,
            variance,
            reason:        'amount_mismatch',
            paymentMethod: order.paymentMethod,
            merchantId:    order.merchantId || null,
          });
        } else {
          matched++;
        }
        continue;
      }

      /* ── All other methods: presence of paymentRef is sufficient */
      matched++;
    }

    lastDoc = snap.docs[snap.docs.length - 1];
  } while (lastDoc);
  /* eslint-enable no-await-in-loop */

  return {
    date:           label,
    totalOrders,
    totalAmount,
    matched,
    unmatched,
    amountVariance,
    unmatchedList:  unmatchedList.slice(0, 50), // cap payload
    generatedAt:    new Date().toISOString(),
  };
}

/** Write an admin alert to the ops dashboard. */
async function writeAdminAlert(type, data, log) {
  try {
    await db.collection('adminAlerts').add({
      type,
      source:    'payment-reconciliation',
      data,
      createdAt: F.serverTimestamp(),
      resolved:  false,
    });
  } catch (err) {
    log.error('Failed to write admin alert', { alertType: type, error: err.message });
  }
}

/* ================================================================
   1. runDailyReconciliation  (scheduled)
   ────────────────────────────────────────────────────────────────
   Runs every night at 1:30AM UTC (4:30AM EAT).
   Reconciles all settled orders from yesterday and persists
   the report to reconciliationReports/{YYYY-MM-DD}.
   Raises an admin alert if unmatched > 0 or amountVariance > 0.
================================================================ */
exports.runDailyReconciliation = onSchedule(
  {
    schedule:       '30 1 * * *',
    region:         REGION,
    timeoutSeconds: 540,
    secrets:        [INTASEND_KEY, PAYMENT_HMAC_SECRET],
  },
  async () => {
    const log  = createLogger({ fn: 'runDailyReconciliation' });
    const { start, end, label } = yesterdayRange();

    log.info('Starting scheduled daily reconciliation', { date: label });

    const summary = await runReconciliationForRange(start, end, label, log);

    /* ── Persist report ──────────────────────────────────────── */
    await db.collection('reconciliationReports').doc(label).set({
      ...summary,
      type:      'daily_scheduled',
      createdAt: F.serverTimestamp(),
    }, { merge: true });

    /* ── Alert on discrepancies ──────────────────────────────── */
    if (summary.unmatched > 0 || summary.amountVariance > 0) {
      await writeAdminAlert('reconciliation_variance', {
        date:           label,
        totalOrders:    summary.totalOrders,
        matched:        summary.matched,
        unmatched:      summary.unmatched,
        amountVariance: summary.amountVariance,
        topUnmatched:   summary.unmatchedList.slice(0, 5),
      }, log);

      log.warn('Reconciliation variance detected', {
        date:           label,
        unmatched:      summary.unmatched,
        amountVariance: summary.amountVariance,
      });
    }

    log.audit('Daily reconciliation complete', {
      date:        label,
      totalOrders: summary.totalOrders,
      matched:     summary.matched,
      unmatched:   summary.unmatched,
    });
  }
);

/* ================================================================
   2. getReconciliationReport  (admin)
   ────────────────────────────────────────────────────────────────
   Fetch a single report by date, or a list of reports by date range.
   Input: { date: 'YYYY-MM-DD' }
       OR { startDate: 'YYYY-MM-DD', endDate: 'YYYY-MM-DD' }
================================================================ */
exports.getReconciliationReport = onCall(
  OPT,
  async (req) => {
    const log = createLogger({ fn: 'getReconciliationReport', uid: req.auth?.uid });
    assertAdmin(req);

    const { date, startDate, endDate } = req.data;

    if (!date && (!startDate || !endDate))
      throw new HttpsError('invalid-argument',
        'Provide date (YYYY-MM-DD) or both startDate and endDate.');

    /* ── Single date ─────────────────────────────────────────── */
    if (date) {
      const { label } = parseDateRange(date); // validates format
      const snap = await db.collection('reconciliationReports').doc(label).get();

      if (!snap.exists)
        throw new HttpsError('not-found', `No reconciliation report found for date "${label}".`);

      log.info('Report retrieved', { date: label });
      return { reports: [snap.data()] };
    }

    /* ── Date range ──────────────────────────────────────────── */
    const { label: fromLabel } = parseDateRange(startDate);
    const { label: toLabel }   = parseDateRange(endDate);

    if (fromLabel > toLabel)
      throw new HttpsError('invalid-argument', 'startDate must be on or before endDate.');

    /* Date strings sort lexicographically — Firestore string range works */
    const snap = await db.collection('reconciliationReports')
      .where(admin.firestore.FieldPath.documentId(), '>=', fromLabel)
      .where(admin.firestore.FieldPath.documentId(), '<=', toLabel)
      .orderBy(admin.firestore.FieldPath.documentId(), 'asc')
      .limit(90)
      .get();

    const reports = snap.docs.map(d => d.data());
    log.info('Reports retrieved', { startDate, endDate, count: reports.length });

    return { reports };
  }
);

/* ================================================================
   3. flagUnmatchedPayment  (admin)
   ────────────────────────────────────────────────────────────────
   Flags a payment for manual review.
   Writes to unmatchedPayments/{paymentRef}.
================================================================ */
exports.flagUnmatchedPayment = onCall(
  OPT,
  async (req) => {
    const log = createLogger({ fn: 'flagUnmatchedPayment', uid: req.auth?.uid });
    assertAdmin(req);

    const { paymentRef, orderId, reason } = req.data;

    /* ── Input validation ────────────────────────────────────── */
    if (!paymentRef || typeof paymentRef !== 'string' || !paymentRef.trim())
      throw new HttpsError('invalid-argument', 'paymentRef is required.');
    if (!orderId || typeof orderId !== 'string' || !orderId.trim())
      throw new HttpsError('invalid-argument', 'orderId is required.');
    if (!reason || typeof reason !== 'string' || reason.trim().length < 5)
      throw new HttpsError('invalid-argument', 'reason must be at least 5 characters.');

    const ref     = paymentRef.trim();
    const docRef  = db.collection('unmatchedPayments').doc(ref);

    /* Prevent duplicate flags */
    const existing = await docRef.get();
    if (existing.exists && existing.data().status === 'pending_review') {
      log.info('Payment already flagged', { paymentRef: ref });
      return {
        paymentRef: ref,
        alreadyFlagged: true,
        status: existing.data().status,
      };
    }

    await docRef.set({
      paymentRef:  ref,
      orderId:     orderId.trim(),
      reason:      reason.trim().slice(0, 500),
      flaggedAt:   F.serverTimestamp(),
      flaggedBy:   req.auth.uid,
      status:      'pending_review',
      resolution:  null,
      resolvedAt:  null,
      resolvedBy:  null,
      notes:       null,
    });

    log.audit('Payment flagged for review', { paymentRef: ref, orderId, flaggedBy: req.auth.uid });

    return {
      paymentRef:     ref,
      orderId:        orderId.trim(),
      status:         'pending_review',
      flaggedAt:      new Date().toISOString(),
      alreadyFlagged: false,
    };
  }
);

/* ================================================================
   4. resolveUnmatchedPayment  (admin)
   ────────────────────────────────────────────────────────────────
   Resolves a previously flagged unmatched payment.
   Input: { paymentRef, resolution: 'matched'|'refunded'|'written_off', notes }
================================================================ */
exports.resolveUnmatchedPayment = onCall(
  OPT,
  async (req) => {
    const log = createLogger({ fn: 'resolveUnmatchedPayment', uid: req.auth?.uid });
    assertAdmin(req);

    const { paymentRef, resolution, notes = '' } = req.data;

    /* ── Input validation ────────────────────────────────────── */
    if (!paymentRef || typeof paymentRef !== 'string' || !paymentRef.trim())
      throw new HttpsError('invalid-argument', 'paymentRef is required.');
    if (!resolution || !VALID_RESOLUTIONS.has(resolution))
      throw new HttpsError('invalid-argument',
        `resolution must be one of: ${[...VALID_RESOLUTIONS].join(', ')}.`);
    if (typeof notes !== 'string')
      throw new HttpsError('invalid-argument', 'notes must be a string.');

    const ref    = paymentRef.trim();
    const docRef = db.collection('unmatchedPayments').doc(ref);
    const snap   = await docRef.get();

    if (!snap.exists)
      throw new HttpsError('not-found', `No unmatched payment record found for paymentRef "${ref}".`);

    const record = snap.data();

    if (record.status !== 'pending_review')
      throw new HttpsError('failed-precondition',
        `Payment "${ref}" is not pending review (current status: ${record.status}).`);

    await docRef.update({
      resolution,
      resolvedAt: F.serverTimestamp(),
      resolvedBy: req.auth.uid,
      notes:      notes.trim().slice(0, 1000),
      status:     `resolved_${resolution}`,
    });

    log.audit('Unmatched payment resolved', {
      paymentRef: ref,
      resolution,
      resolvedBy: req.auth.uid,
    });

    return {
      paymentRef:  ref,
      resolution,
      resolvedAt:  new Date().toISOString(),
      resolvedBy:  req.auth.uid,
    };
  }
);

/* ================================================================
   5. getMpesaReconciliationSummary  (admin)
   ────────────────────────────────────────────────────────────────
   Aggregates all M-Pesa orders for a given date, grouped by status.
   Useful for EOD treasury reporting.
================================================================ */
exports.getMpesaReconciliationSummary = onCall(
  OPT,
  async (req) => {
    const log = createLogger({ fn: 'getMpesaReconciliationSummary', uid: req.auth?.uid });
    assertAdmin(req);

    const { date } = req.data;

    if (!date || typeof date !== 'string')
      throw new HttpsError('invalid-argument', 'date (YYYY-MM-DD) is required.');

    const { start, end, label } = parseDateRange(date);

    log.info('Computing M-Pesa reconciliation summary', { date: label });

    /* ── Query all M-Pesa orders for the day ─────────────────── */
    const snap = await db.collection('orders')
      .where('paymentMethod', 'in', [...MPESA_METHODS])
      .where('createdAt',     '>=', start)
      .where('createdAt',     '<=', end)
      .orderBy('createdAt',   'asc')
      .limit(1000)
      .get();

    /* Aggregate by status */
    const groups = {};
    let grandTotalCents  = 0;
    let grandTotalOrders = 0;

    for (const doc of snap.docs) {
      const order  = doc.data();
      const status = order.status || 'unknown';
      const cents  = order.amountCents || order.totalCents || 0;

      if (!groups[status]) {
        groups[status] = { status, orderCount: 0, totalCents: 0, orders: [] };
      }

      groups[status].orderCount++;
      groups[status].totalCents += cents;
      grandTotalCents           += cents;
      grandTotalOrders++;

      /* Attach limited order detail for audit trail */
      if (groups[status].orders.length < 10) {
        groups[status].orders.push({
          orderId:    doc.id,
          paymentRef: order.paymentRef || null,
          cents,
          createdAt:  order.createdAt,
        });
      }
    }

    const summary = {
      date:            label,
      paymentMethod:   'mpesa',
      totalOrders:     grandTotalOrders,
      totalCents:      grandTotalCents,
      totalKES:        (grandTotalCents / 100).toFixed(2),
      byStatus:        Object.values(groups).map(g => ({
        status:     g.status,
        orderCount: g.orderCount,
        totalCents: g.totalCents,
        totalKES:   (g.totalCents / 100).toFixed(2),
        sample:     g.orders,
      })),
      generatedAt:     new Date().toISOString(),
    };

    log.info('M-Pesa summary complete', {
      date: label, totalOrders: grandTotalOrders, totalCents: grandTotalCents,
    });

    return summary;
  }
);

/* ================================================================
   SUBSCRIPTION ENTITLEMENT RECONCILIATION  (backstop)
   ────────────────────────────────────────────────────────────────
   Closes the silent-failure class: a COMPLETE subscription payment
   that never became an active subscription because all three
   real-time activation paths missed it.

   Default posture is ALERT-ONLY (detect + raise a P1 adminAlert).
   Auto-heal is opt-in via a feature flag so an operator stages the
   rollout: deploy → watch the alerts prove the detector correct →
   enable auto-heal only once the alerts are trusted. When auto-heal
   IS on, the write is byte-identical to the canonical activation
   (activateSubscription, index.js): exactly the same 7 fields on
   subscriptions/{uid}, provenance recorded only on the audit log.
================================================================ */

/**
 * Read the auto-heal feature flag. Default OFF (alert-only).
 * Lives in _systemConfig/reconciliation.subscriptionAutoHeal — the
 * same admin/IAM-gated config space firestore.rules already locks,
 * so a client can never flip the platform into auto-writing
 * entitlements.
 */
async function isSubscriptionAutoHealEnabled() {
  try {
    const snap = await db.collection('_systemConfig').doc('reconciliation').get();
    return snap.exists && snap.data().subscriptionAutoHeal === true;
  } catch (_) {
    return false; // fail CLOSED — never auto-write on a config read error
  }
}

/**
 * Does the DASHBOARD-authoritative entitlement exist for this uid?
 * getProviderPlan (client) and the canonical activation path both key
 * on subscriptions/{uid} by document id, so that doc is the single
 * source the merchant's banner actually resolves. A record living
 * only under some other id is a divergence problem, not this
 * backstop's concern — and healing the canonical location is exactly
 * what activateSubscription would have done.
 */
async function subscriptionEntitlementExists(uid) {
  const snap = await db.collection('subscriptions').doc(uid).get();
  if (!snap.exists) return false;
  const d = snap.data();
  if (d.status && d.status !== 'active' && d.status !== 'trialing' && d.status !== 'grace') return false;
  return true;
}

/**
 * Auto-heal one entitlement gap. Re-validates the payment against
 * Firestore (COMPLETE + ownership) exactly as the canonical path
 * does, then writes the canonical 7-field subscription create-only
 * (never overwrites) plus one audit record tagged as an operational
 * recovery. Idempotent: a concurrent real-time path that wins the
 * race leaves subscriptions/{uid} present, and create() no-ops here.
 */
async function healSubscriptionEntitlement(intent, ref, log) {
  const uid = intent.uid;
  /* Canonical pre-write validation — mirror of activateSubscription. */
  const paySnap = await db.collection('payments').doc(ref).get();
  if (!paySnap.exists)                     return { healed: false, reason: 'payment_missing' };
  const pay = paySnap.data();
  if (pay.status !== 'COMPLETE')           return { healed: false, reason: 'payment_not_complete' };
  if (pay.uid && pay.uid !== uid)          return { healed: false, reason: 'ownership_mismatch' };

  const subRef    = db.collection('subscriptions').doc(uid);
  const expiresAt = new Date(Date.now() + SUB_PLAN_DAYS * 86400000);

  /* Transaction: re-check absence and create atomically so a
     real-time path that lands mid-run cannot be clobbered. */
  const wrote = await db.runTransaction(async (txn) => {
    const existing = await txn.get(subRef);
    if (existing.exists) return false; // someone activated it first — done
    txn.set(subRef, {
      uid,
      plan:        intent.planId,
      status:      'active',
      paymentRef:  ref,
      activatedAt: F.serverTimestamp(),
      expiresAt:   admin.firestore.Timestamp.fromDate(expiresAt),
      updatedAt:   F.serverTimestamp(),
    });
    return true;
  });

  if (!wrote) return { healed: false, reason: 'already_active' };

  /* Provenance goes on the audit log ONLY — the subscription doc
     stays indistinguishable from a normally-activated one. */
  await db.collection('subscriptionAuditLog').add({
    uid, plan: intent.planId, paymentRef: ref,
    action:    'ACTIVATED',
    source:    'reconciliation_backstop',
    note:      'Operational Recovery — auto-healed by reconcileSubscriptionEntitlements',
    expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
    timestamp: F.serverTimestamp(),
  }).catch((e) => log.error('Heal audit write failed', { ref, error: e.message }));

  log.audit('Subscription entitlement auto-healed', { uid, ref, plan: intent.planId });
  return { healed: true };
}

/**
 * Core sweep. Finds subscription payment intents whose payment is
 * COMPLETE but whose entitlement is absent, within the grace/lookback
 * window. Returns a summary; performs writes only when autoHeal.
 */
async function runSubscriptionReconciliation(log) {
  const autoHeal = await isSubscriptionAutoHealEnabled();
  const now      = Date.now();
  const floor    = admin.firestore.Timestamp.fromMillis(now - SUB_RECON_LOOKBACK_MS);
  const ceiling  = admin.firestore.Timestamp.fromMillis(now - SUB_RECON_GRACE_MS);

  log.info('Subscription reconciliation starting', {
    autoHeal, grace: '2m', lookback: '24h',
  });

  let scanned = 0, gaps = 0, healed = 0, alerted = 0, skipped = 0;
  const gapList = [];

  /* Subscription intents in the window. Two range bounds on one
     field (createdAt) + one equality (purpose) → one composite index
     (added to firestore.indexes.json). */
  const snap = await db.collection('paymentIntents')
    .where('purpose', '==', 'subscription')
    .where('createdAt', '>=', floor)
    .where('createdAt', '<=', ceiling)
    .orderBy('createdAt', 'asc')
    .limit(500)
    .get();

  /* eslint-disable no-await-in-loop */
  for (const doc of snap.docs) {
    const intent = doc.data();
    const ref    = doc.id;
    if (!intent.uid || !intent.planId) { skipped++; continue; }
    scanned++;

    /* Only intents whose payment actually COMPLETED can have a gap. */
    const paySnap = await db.collection('payments').doc(ref).get();
    if (!paySnap.exists || paySnap.data().status !== 'COMPLETE') continue;

    if (await subscriptionEntitlementExists(intent.uid)) continue; // already entitled

    gaps++;
    const entry = {
      paymentRef: ref, uid: intent.uid, plan: intent.planId,
      planName:   intent.planName || intent.planId,
      amount:     intent.amount || null,
      intentAt:   intent.createdAt ? intent.createdAt.toDate().toISOString() : null,
    };

    if (autoHeal) {
      const r = await healSubscriptionEntitlement(intent, ref, log);
      if (r.healed) { healed++; entry.action = 'auto_healed'; }
      else          { entry.action = 'heal_skipped'; entry.reason = r.reason; }
    } else {
      entry.action = 'alert_only';
    }
    if (gapList.length < 50) gapList.push(entry);

    /* Every gap raises a P1 alert regardless of heal outcome — an
       auto-heal that had to skip (ownership mismatch, payment not
       COMPLETE) is exactly what an operator must see immediately. */
    await writeAdminAlert('subscription_entitlement_gap', {
      priority: 'P1', ...entry, autoHeal,
    }, log);
    alerted++;
  }
  /* eslint-enable no-await-in-loop */

  const summary = {
    scanned, gaps, healed, alerted, skipped, autoHeal,
    gapList, generatedAt: new Date().toISOString(),
  };
  log[gaps > 0 ? 'warn' : 'info']('Subscription reconciliation complete', {
    scanned, gaps, healed, alerted, mode: autoHeal ? 'auto_heal' : 'alert_only',
  });
  return summary;
}

/* ----------------------------------------------------------------
   7. reconcileSubscriptionEntitlements  (scheduled, every 10 min)
---------------------------------------------------------------- */
exports.reconcileSubscriptionEntitlements = onSchedule(
  { schedule: '*/10 * * * *', region: REGION, timeoutSeconds: 300 },
  async () => {
    const log = createLogger({ fn: 'reconcileSubscriptionEntitlements' });
    const summary = await runSubscriptionReconciliation(log);
    /* Persist a run record for observability / trend analysis. */
    await db.collection('subscriptionReconciliationRuns').add({
      ...summary, createdAt: F.serverTimestamp(),
    }).catch((e) => log.error('Run record write failed', { error: e.message }));
  }
);

/* ----------------------------------------------------------------
   8. triggerSubscriptionReconciliation  (admin, on-demand)
   ────────────────────────────────────────────────────────────────
   Manual/dry-run entry point. Admins can preview gaps without
   waiting for the schedule; the flag still governs whether it heals.
---------------------------------------------------------------- */
exports.triggerSubscriptionReconciliation = onCall(
  { ...OPT, timeoutSeconds: 300 },
  async (req) => {
    const log = createLogger({ fn: 'triggerSubscriptionReconciliation', uid: req.auth?.uid });
    assertAdmin(req);
    const summary = await runSubscriptionReconciliation(log);
    return summary;
  }
);

/* ================================================================
   6. triggerManualReconciliation  (admin)
   ────────────────────────────────────────────────────────────────
   Runs the same reconciliation logic as runDailyReconciliation
   but for a caller-specified date.  Overwrites existing report.
================================================================ */
exports.triggerManualReconciliation = onCall(
  { ...OPT, timeoutSeconds: 300, secrets: [INTASEND_KEY, PAYMENT_HMAC_SECRET] },
  async (req) => {
    const log = createLogger({ fn: 'triggerManualReconciliation', uid: req.auth?.uid });
    assertAdmin(req);

    const { date } = req.data;

    if (!date || typeof date !== 'string')
      throw new HttpsError('invalid-argument', 'date (YYYY-MM-DD) is required.');

    const { start, end, label } = parseDateRange(date);

    log.info('Manual reconciliation triggered', { date: label, triggeredBy: req.auth.uid });

    const summary = await runReconciliationForRange(start, end, label, log);

    /* ── Persist report (merge to preserve existing run metadata) */
    await db.collection('reconciliationReports').doc(label).set({
      ...summary,
      type:          'manual_triggered',
      triggeredBy:   req.auth.uid,
      triggeredAt:   F.serverTimestamp(),
      createdAt:     F.serverTimestamp(),
    }, { merge: true });

    /* ── Alert on discrepancies ──────────────────────────────── */
    if (summary.unmatched > 0 || summary.amountVariance > 0) {
      await writeAdminAlert('reconciliation_variance', {
        date:           label,
        triggeredBy:    req.auth.uid,
        totalOrders:    summary.totalOrders,
        matched:        summary.matched,
        unmatched:      summary.unmatched,
        amountVariance: summary.amountVariance,
        topUnmatched:   summary.unmatchedList.slice(0, 5),
      }, log);

      log.warn('Manual reconciliation found variances', {
        date:           label,
        unmatched:      summary.unmatched,
        amountVariance: summary.amountVariance,
      });
    }

    log.audit('Manual reconciliation complete', {
      date:        label,
      triggeredBy: req.auth.uid,
      totalOrders: summary.totalOrders,
      matched:     summary.matched,
      unmatched:   summary.unmatched,
    });

    return {
      date:           label,
      totalOrders:    summary.totalOrders,
      totalAmount:    summary.totalAmount,
      matched:        summary.matched,
      unmatched:      summary.unmatched,
      amountVariance: summary.amountVariance,
      unmatchedList:  summary.unmatchedList,
      generatedAt:    summary.generatedAt,
    };
  }
);
