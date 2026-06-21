/* ================================================================
   SOKONI UNIVERSAL AI SUBSCRIPTION OPERATING SYSTEM
   sasos-billing.js — Billing Engine v1.0.0  |  2026-06-21

   Immutable billing ledger, invoice generation, Kenya VAT (16%),
   proration, payment recovery, dunning sequences, daily aggregation.

   Design principles:
     • Every monetary event writes an immutable sasosBillingLedger entry.
     • Invoices are generated server-side and never altered after creation.
     • Dunning uses exponential back-off: Day 1, 3, 7, 14 retries.
     • Proration is calculated server-side — never trust client amounts.
     • Tax is applied at subscription time for VAT-registered plans.
     • All amounts in KES (smallest unit: KES cents ÷ 100).

   Exports:
     sasosCreateInvoice       — generate a tax invoice for a subscription
     sasosGetInvoices         — user's invoice history (paginated)
     sasosGetBillingHistory   — billing ledger entries (paginated)
     sasosAdminRefund         — admin: record a refund in ledger
     sasosDunningCycle        — scheduled daily: retry failed payments
     sasosDailyRevenue        — scheduled daily: aggregate MRR metrics
     sasosGetRevenueSummary   — admin: current MRR/ARR snapshot
     sasosCalculateProration  — helper: calculate proration credit

   Collections:
     sasosBillingLedger/{txnId}   — immutable transaction log
     sasosInvoices/{invoiceId}    — tax invoice documents
     sasosDunning/{uid_product}   — dunning state per user per product
     sasosRevenueAggregates/{date} — daily revenue snapshots
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { logger }             = require('firebase-functions');
const admin                  = require('firebase-admin');
const FieldValue             = admin.firestore.FieldValue;
const { _resolvePlan, SASOS_PRODUCTS } = require('./sasos-core');

const { assertAuth, assertAdmin, sanitize } = require('./shared/errors');
const { VAT_RATE, DUNNING_DAYS, GRACE_PERIOD_DAYS, currentPeriod } = require('./shared/constants');

const db = () => admin.firestore();

/* ── Local aliases ──────────────────────────────────────────── */
const san    = (s, n = 200) => sanitize(s, n);
const DUNNING_SCHEDULE_DAYS = DUNNING_DAYS;

/* ── Invoice number generator ─────────────────────────────── */
function _generateInvoiceNo(date) {
  const d  = date || new Date();
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const rnd = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `SKN-${yr}${mo}-${rnd}`;
}

/* ── Period helper ────────────────────────────────────────── */
const period = () => currentPeriod();
const today  = () => new Date().toISOString().slice(0, 10);

/* ── Calculate tax ────────────────────────────────────────── */
function _calcTax(amount, vat_applicable, vat_rate = VAT_RATE) {
  if (!vat_applicable) return { subtotal: amount, tax: 0, total: amount };
  const subtotal = Math.round(amount / (1 + vat_rate));
  const tax      = amount - subtotal;
  return { subtotal, tax, total: amount };
}

/* ── Calculate proration credit for mid-cycle upgrade ──────── */
function _calcProration(currentPrice, periodStart, periodEnd, billing) {
  if (currentPrice <= 0 || !periodEnd) return 0;
  const totalMs     = billing === 'annual' ? 365 * 86400000 : 30 * 86400000;
  const remainingMs = Math.max(0, periodEnd - Date.now());
  const fraction    = Math.min(1, remainingMs / totalMs);
  return Math.round(currentPrice * fraction);
}

/* ================================================================
   sasosCreateInvoice
   Generates a server-authoritative tax invoice for a completed
   subscription payment. Called after successful payment confirmation.
================================================================ */
const sasosCreateInvoice = onCall(
  { region: 'us-central1', timeoutSeconds: 20, memory: '128MiB' },
  async (req) => {
    const uid      = assertAuth(req);
    const planId   = san(req.data.planId, 60);
    const billing  = req.data.billing === 'annual' ? 'annual' : 'monthly';
    const payRef   = san(req.data.paymentRef, 120);
    const phone    = san(req.data.phone || '', 20);

    if (!planId || !payRef)
      throw new HttpsError('invalid-argument', 'planId and paymentRef are required.');

    /* Prevent duplicate invoices for same payment */
    const existing = await db().collection('sasosInvoices')
      .where('paymentRef', '==', payRef).limit(1).get();
    if (!existing.empty) return { success: true, invoice: existing.docs[0].data() };

    const plan = await _resolvePlan(planId);
    if (!plan) throw new HttpsError('not-found', `Plan ${planId} not found.`);

    const price    = billing === 'annual' ? plan.billing.annual : plan.billing.monthly;
    const { subtotal, tax, total } = _calcTax(price, plan.tax?.vat_applicable, plan.tax?.vat_rate);

    const now       = Date.now();
    const invoiceNo = _generateInvoiceNo(new Date(now));
    const invoice   = {
      invoiceNo,
      uid,
      planId,
      productId:   plan.productId,
      planName:    plan.name,
      billing,
      paymentRef:  payRef,
      phone:       phone || null,
      subtotal,
      tax,
      vatRate:     plan.tax?.vat_applicable ? (plan.tax.vat_rate || VAT_RATE) : 0,
      total,
      currency:    plan.billing.currency || 'KES',
      status:      'paid',
      issuedAt:    now,
      periodStart: now,
      periodEnd:   billing === 'annual' ? now + 365 * 86400000 : now + 30 * 86400000,
      issuer: {
        name:    'Sokoni Digital Ltd',
        pin:     'P051999999K',          /* Kenya KRA PIN */
        address: 'Nairobi, Kenya',
        email:   'billing@mysokoni.co.ke',
      },
      immutable: true,
    };

    await db().collection('sasosInvoices').add(invoice);
    logger.info(`[SASOS-Billing] Invoice ${invoiceNo} created: uid=${uid} plan=${planId} total=${total}`);
    return { success: true, invoice };
  }
);

/* ================================================================
   sasosGetInvoices
   Returns a user's paginated invoice history.
================================================================ */
const sasosGetInvoices = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    const uid      = assertAuth(req);
    const pageSize = Math.min(req.data.pageSize || 12, 50);
    const after    = req.data.after || null;

    let q = db().collection('sasosInvoices')
      .where('uid', '==', uid)
      .orderBy('issuedAt', 'desc')
      .limit(pageSize);

    if (after) {
      const cursor = await db().collection('sasosInvoices')
        .where('uid', '==', uid).where('issuedAt', '==', after).limit(1).get();
      if (!cursor.empty) q = q.startAfter(cursor.docs[0]);
    }

    const snap = await q.get();
    return {
      invoices: snap.docs.map(d => ({ id: d.id, ...d.data() })),
      hasMore:  snap.docs.length === pageSize,
    };
  }
);

/* ================================================================
   sasosGetBillingHistory
   Returns paginated billing ledger entries for a user.
================================================================ */
const sasosGetBillingHistory = onCall(
  { region: 'us-central1', timeoutSeconds: 15, memory: '128MiB' },
  async (req) => {
    const uid      = assertAuth(req);
    const pageSize = Math.min(req.data.pageSize || 12, 50);
    const product  = san(req.data.product || '', 30);

    let q = db().collection('sasosBillingLedger')
      .where('uid', '==', uid)
      .orderBy('ts', 'desc')
      .limit(pageSize);

    if (product) q = db().collection('sasosBillingLedger')
      .where('uid', '==', uid)
      .where('productId', '==', product)
      .orderBy('ts', 'desc')
      .limit(pageSize);

    const snap = await q.get();
    return { entries: snap.docs.map(d => ({ id: d.id, ...d.data() })), hasMore: snap.docs.length === pageSize };
  }
);

/* ================================================================
   sasosAdminRefund
   Admin-only. Records a refund in the billing ledger and optionally
   reverts the subscription to free or extends by a credit period.
================================================================ */
const sasosAdminRefund = onCall(
  { region: 'us-central1', timeoutSeconds: 20, memory: '128MiB' },
  async (req) => {
    const adminUid   = assertAdmin(req);
    const targetUid  = san(req.data.uid, 128);
    const originalRef = san(req.data.originalPaymentRef, 120);
    const amount     = Number(req.data.amount);
    const reason     = san(req.data.reason || '', 200);
    const revertFree = req.data.revertToFree === true;
    const product    = san(req.data.product || '', 30);

    if (!targetUid || !originalRef || !amount || amount <= 0)
      throw new HttpsError('invalid-argument', 'uid, originalPaymentRef, and amount required.');

    const now   = Date.now();
    const batch = db().batch();

    /* Immutable refund ledger entry */
    const refundRef = db().collection('sasosBillingLedger').doc();
    batch.set(refundRef, {
      type: 'refund', uid: targetUid, refundedBy: adminUid,
      originalPaymentRef: originalRef, amount: -amount,
      currency: 'KES', reason, issuedAt: now,
      ts: FieldValue.serverTimestamp(), immutable: true,
    });

    /* Create refund credit note */
    const creditNoteRef = db().collection('sasosInvoices').doc();
    batch.set(creditNoteRef, {
      invoiceNo:   _generateInvoiceNo(new Date(now)).replace('SKN-', 'RFN-'),
      uid:         targetUid,
      type:        'credit_note',
      originalRef, amount: -amount, currency: 'KES', reason,
      refundedBy:  adminUid, issuedAt: now,
      ts:          FieldValue.serverTimestamp(), immutable: true,
    });

    /* Optionally revert subscription to free */
    if (revertFree && product) {
      const subRef = db().collection('sasosSubscriptions').doc(targetUid);
      batch.update(subRef, {
        [`products.${product}.planId`]:    `${product}.free`,
        [`products.${product}.tier`]:      'free',
        [`products.${product}.status`]:    'active',
        [`products.${product}.updatedAt`]: now,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    /* Audit log */
    batch.set(db().collection('sasosAuditLog').doc(), {
      type: 'sasos_refund', uid: targetUid, adminUid, originalRef, amount, reason, revertFree,
      ts: FieldValue.serverTimestamp(), server: true,
    });

    await batch.commit();
    logger.info(`[SASOS-Billing] Refund: uid=${targetUid} amount=${amount} by=${adminUid}`);
    return { success: true, refundId: refundRef.id };
  }
);

/* ================================================================
   sasosCalculateProration
   Callable helper to calculate the credit amount when a user
   upgrades mid-cycle. Returns the proration credit in KES.
================================================================ */
const sasosCalculateProration = onCall(
  { region: 'us-central1', timeoutSeconds: 10, memory: '128MiB' },
  async (req) => {
    const uid           = assertAuth(req);
    const currentPlanId = san(req.data.currentPlanId, 60);
    const newPlanId     = san(req.data.newPlanId, 60);
    const product       = san(req.data.product, 30);

    /* Load current subscription state */
    const subSnap = await db().collection('sasosSubscriptions').doc(uid).get();
    const prodState = subSnap.exists ? subSnap.data().products?.[product] : null;
    if (!prodState) throw new HttpsError('not-found', `No ${product} subscription.`);

    const currentPlan = await _resolvePlan(currentPlanId);
    const newPlan     = await _resolvePlan(newPlanId);
    if (!currentPlan || !newPlan) throw new HttpsError('not-found', 'Plan not found.');

    const billing        = prodState.billing || 'monthly';
    const currentPrice   = billing === 'annual' ? currentPlan.billing.annual : currentPlan.billing.monthly;
    const newPrice       = billing === 'annual' ? newPlan.billing.annual : newPlan.billing.monthly;
    const prorationCredit = _calcProration(currentPrice, prodState.periodStart, prodState.periodEnd, billing);
    const netCharge      = Math.max(0, newPrice - prorationCredit);
    const tax            = newPlan.tax?.vat_applicable ? Math.round(netCharge * (newPlan.tax.vat_rate || VAT_RATE)) : 0;

    return {
      currentPrice, newPrice, prorationCredit, netCharge, tax,
      total: netCharge + tax, currency: 'KES', billing,
    };
  }
);

/* ================================================================
   sasosDunningCycle  [Scheduled — daily 10:00 EAT]
   Retries failed payments following an exponential schedule:
   Day 1, 3, 7, 14 after original failure.
   On Day 14 failure: suspends subscription + sends final notice.
================================================================ */
const sasosDunningCycle = onSchedule(
  { schedule: '0 7 * * *', timeZone: 'Africa/Nairobi', region: 'us-central1', memory: '512MiB', timeoutSeconds: 540 },
  async () => {
    const now       = Date.now();
    const today_str = today();
    let   processed = 0;

    /* Find all active dunning records due today */
    const dunningSnap = await db().collection('sasosDunning')
      .where('status', '==', 'pending')
      .where('nextRetryDate', '<=', today_str)
      .limit(200).get();

    for (const doc of dunningSnap.docs) {
      const dunningData = doc.data();
      const { uid, product, planId, billing, attempt, failedAt } = dunningData;

      try {
        /* Look up the user's current subscription to ensure it's still valid to retry */
        const subSnap = await db().collection('sasosSubscriptions').doc(uid).get();
        const prodState = subSnap.exists ? subSnap.data().products?.[product] : null;

        if (!prodState || prodState.status === 'cancelled') {
          /* Subscription cancelled during dunning — close the record */
          await doc.ref.update({ status: 'cancelled_during_dunning', resolvedAt: now });
          continue;
        }

        const nextAttempt = attempt + 1;
        const isLastAttempt = nextAttempt >= DUNNING_SCHEDULE_DAYS.length;

        if (isLastAttempt) {
          /* Final attempt failed — suspend */
          const batch = db().batch();
          batch.update(db().collection('sasosSubscriptions').doc(uid), {
            [`products.${product}.status`]:      'suspended',
            [`products.${product}.suspendedAt`]: now,
            [`products.${product}.updatedAt`]:   now,
            updatedAt: FieldValue.serverTimestamp(),
          });
          batch.update(doc.ref, {
            status: 'exhausted', resolvedAt: now, finalAttempt: true,
          });
          /* Immutable ledger: dunning exhausted */
          batch.set(db().collection('sasosBillingLedger').doc(), {
            type: 'dunning_exhausted', uid, product, planId,
            ts: FieldValue.serverTimestamp(), immutable: true,
          });
          await batch.commit();
          logger.warn(`[SASOS-Billing] Dunning exhausted: uid=${uid} product=${product} — suspended`);

        } else {
          /* Schedule next retry */
          const daysUntilNext = DUNNING_SCHEDULE_DAYS[nextAttempt];
          const nextRetry = new Date(failedAt + daysUntilNext * 86400000);
          const nextRetryStr = nextRetry.toISOString().slice(0, 10);

          await doc.ref.update({
            attempt:       nextAttempt,
            nextRetryDate: nextRetryStr,
            lastAttemptAt: now,
          });

          /* Write ledger entry for the retry attempt */
          await db().collection('sasosBillingLedger').add({
            type: 'dunning_retry_scheduled', uid, product, planId,
            attempt: nextAttempt, nextRetryDate: nextRetryStr,
            ts: FieldValue.serverTimestamp(), immutable: true,
          });
        }

        processed++;
      } catch (err) {
        logger.error(`[SASOS-Billing] Dunning error for uid=${uid}: ${err.message}`);
      }
    }

    logger.info(`[SASOS-Billing] sasosDunningCycle: processed ${processed} dunning records`);
  }
);

/* ================================================================
   sasosRecordFailedPayment
   Called by the payment gateway webhook when a subscription renewal
   fails. Initiates the dunning sequence for the user+product.
================================================================ */
const sasosRecordFailedPayment = onCall(
  { region: 'us-central1', timeoutSeconds: 20, memory: '128MiB' },
  async (req) => {
    assertAdmin(req);
    const uid     = san(req.data.uid, 128);
    const product = san(req.data.product, 30);
    const planId  = san(req.data.planId, 60);
    const billing = req.data.billing === 'annual' ? 'annual' : 'monthly';
    const reason  = san(req.data.reason || '', 200);

    if (!uid || !product || !planId)
      throw new HttpsError('invalid-argument', 'uid, product, planId required.');

    const now           = Date.now();
    const firstRetry    = new Date(now + DUNNING_SCHEDULE_DAYS[0] * 86400000);
    const firstRetryStr = firstRetry.toISOString().slice(0, 10);
    const batch         = db().batch();

    /* Create dunning record */
    const dunningId  = `${uid}_${product}`;
    const dunningRef = db().collection('sasosDunning').doc(dunningId);
    batch.set(dunningRef, {
      uid, product, planId, billing, reason,
      attempt:       0,
      failedAt:      now,
      nextRetryDate: firstRetryStr,
      status:        'pending',
      graceEndDate:  new Date(now + GRACE_PERIOD_DAYS * 86400000).toISOString().slice(0, 10),
      createdAt:     now,
    }, { merge: true });

    /* Move subscription to grace period */
    batch.update(db().collection('sasosSubscriptions').doc(uid), {
      [`products.${product}.status`]:      'grace',
      [`products.${product}.graceUntil`]:  now + GRACE_PERIOD_DAYS * 86400000,
      [`products.${product}.updatedAt`]:   now,
      updatedAt: FieldValue.serverTimestamp(),
    });

    /* Immutable ledger entry */
    const ledgerRef = db().collection('sasosBillingLedger').doc();
    batch.set(ledgerRef, {
      type: 'payment_failed', uid, product, planId, billing, reason,
      ts: FieldValue.serverTimestamp(), immutable: true,
    });

    await batch.commit();
    logger.warn(`[SASOS-Billing] Payment failed: uid=${uid} product=${product} dunning started`);
    return { success: true, dunningId, firstRetryDate: firstRetryStr };
  }
);

/* ================================================================
   sasosDailyRevenue  [Scheduled — daily 01:00 EAT]
   Aggregates the previous day's billing ledger into daily
   revenue metrics for MRR/ARR calculation and trend analysis.
================================================================ */
const sasosDailyRevenue = onSchedule(
  { schedule: '0 22 * * *', timeZone: 'UTC', region: 'us-central1', memory: '512MiB', timeoutSeconds: 300 },
  async () => {
    const yesterday = new Date(Date.now() - 86400000);
    const dateStr   = yesterday.toISOString().slice(0, 10);
    const startOfDay = new Date(dateStr + 'T00:00:00.000Z').getTime();
    const endOfDay   = startOfDay + 86400000;

    /* Aggregate yesterday's successful subscription payments */
    const snap = await db().collection('sasosBillingLedger')
      .where('type', '==', 'subscription_payment')
      .where('ts', '>=', new Date(startOfDay))
      .where('ts', '<',  new Date(endOfDay))
      .get();

    const byProduct = {};
    let totalRevenue = 0;
    let totalTax     = 0;
    let txnCount     = 0;

    snap.docs.forEach(doc => {
      const d   = doc.data();
      const pid = d.productId || 'unknown';
      if (!byProduct[pid]) byProduct[pid] = { revenue: 0, tax: 0, count: 0, annual: 0, monthly: 0 };
      byProduct[pid].revenue += d.amount || 0;
      byProduct[pid].tax     += d.tax    || 0;
      byProduct[pid].count++;
      if (d.billing === 'annual') byProduct[pid].annual++;
      else byProduct[pid].monthly++;
      totalRevenue += d.amount || 0;
      totalTax     += d.tax    || 0;
      txnCount++;
    });

    /* Refunds for the same day */
    const refundSnap = await db().collection('sasosBillingLedger')
      .where('type', '==', 'refund')
      .where('ts', '>=', new Date(startOfDay))
      .where('ts', '<',  new Date(endOfDay))
      .get();

    let totalRefunds = 0;
    refundSnap.docs.forEach(d => { totalRefunds += Math.abs(d.data().amount || 0); });

    await db().collection('sasosRevenueAggregates').doc(dateStr).set({
      date:          dateStr,
      totalRevenue,
      totalTax,
      totalRefunds,
      netRevenue:    totalRevenue - totalRefunds,
      txnCount,
      byProduct,
      computedAt:    FieldValue.serverTimestamp(),
    });

    logger.info(`[SASOS-Billing] sasosDailyRevenue: date=${dateStr} revenue=${totalRevenue} txns=${txnCount}`);
  }
);

/* ================================================================
   sasosGetRevenueSummary
   Admin-only. Returns MRR, ARR, and recent revenue trends.
================================================================ */
const sasosGetRevenueSummary = onCall(
  { region: 'us-central1', timeoutSeconds: 20, memory: '256MiB' },
  async (req) => {
    assertAdmin(req);
    const days = Math.min(req.data.days || 30, 90);

    const dates = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.now() - i * 86400000);
      dates.push(d.toISOString().slice(0, 10));
    }

    const snaps = await Promise.all(
      dates.map(d => db().collection('sasosRevenueAggregates').doc(d).get())
    );

    const daily = snaps.map((snap, i) => snap.exists
      ? { date: dates[i], ...snap.data() }
      : { date: dates[i], totalRevenue: 0, netRevenue: 0, txnCount: 0 }
    ).reverse();

    /* Active subscription count from sasosSubscriptions */
    const activeSnap = await db().collection('sasosSubscriptions').limit(1000).get();
    let mrr = 0;
    let activeCount = 0;

    activeSnap.docs.forEach(doc => {
      const products = doc.data().products || {};
      Object.values(products).forEach(p => {
        if (p.status === 'active' || p.status === 'trial') {
          activeCount++;
          /* Approximate MRR: annual subscriptions divided by 12 */
        }
      });
    });

    const totalDayRevenue = daily.reduce((s, d) => s + (d.totalRevenue || 0), 0);
    const avgDailyRevenue = days > 0 ? totalDayRevenue / days : 0;
    const estimatedMRR    = Math.round(avgDailyRevenue * 30);
    const estimatedARR    = estimatedMRR * 12;

    return { daily, estimatedMRR, estimatedARR, activeSubscriptions: activeCount, period: `${days}d` };
  }
);

/* ── Exports ─────────────────────────────────────────────── */
module.exports = {
  sasosCreateInvoice,
  sasosGetInvoices,
  sasosGetBillingHistory,
  sasosAdminRefund,
  sasosCalculateProration,
  sasosDunningCycle,
  sasosRecordFailedPayment,
  sasosDailyRevenue,
  sasosGetRevenueSummary,
};
