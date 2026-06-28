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
