/* ================================================================
   SOKONI — Financial OS Automation Engine  (finos-automation.js)
   7 Gen2 Cloud Functions

   1. fosAutoSettlement       onSchedule  — auto-release held escrow
   2. fosAutoRefund           onDocUpd    — policy-based refund on cancel
   3. fosReconcile            onCall      — IntaSend reconciliation
   4. fosGetForecast          onCall      — AI revenue forecasting
   5. fosGetSettlementConfig  onCall      — read per-hub settlement rules
   6. fosSetSettlementConfig  onCall      — write per-hub settlement rules
   7. fosGetAuditTrail        onCall      — filtered ledger query
================================================================ */
'use strict';

const { onSchedule }         = require('firebase-functions/v2/scheduler');
const { onDocumentUpdated }  = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');
const admin                  = require('firebase-admin');
const logger                 = require('firebase-functions/logger');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const INTASEND_API_KEY  = defineSecret('INTASEND_API_KEY');

/* ── Shared helpers ──────────────────────────────────────────── */
const _db  = () => admin.firestore();
const _ts  = () => admin.firestore.FieldValue.serverTimestamp();
const _inc = (n) => admin.firestore.FieldValue.increment(n);

function _assertAdmin(req) {
  const t = req.auth?.token ?? {};
  if (!t.admin && !t.superAdmin)
    throw new HttpsError('permission-denied', 'Admin access required.');
  return req.auth.uid;
}

const _cfg = { enforceAppCheck: true, region: 'us-central1' };

/* ── Default settlement config (fallback when Firestore doc absent) */
const DEFAULT_CONFIG = {
  defaultSettlementDays: 7,
  hubs: {
    marketplace: { settlementDays: 7,  autoRelease: true  },
    food:        { settlementDays: 2,  autoRelease: true  },
    property:    { settlementDays: 30, autoRelease: false },
    vehicle:     { settlementDays: 14, autoRelease: false },
    events:      { settlementDays: 3,  autoRelease: true  },
    healthcare:  { settlementDays: 7,  autoRelease: true  },
    legal:       { settlementDays: 14, autoRelease: false },
    logistics:   { settlementDays: 3,  autoRelease: true  },
    hotel:       { settlementDays: 3,  autoRelease: true  },
    digital:     { settlementDays: 0,  autoRelease: true  },
    services:    { settlementDays: 7,  autoRelease: true  },
    pharmacy:    { settlementDays: 7,  autoRelease: true  },
    insurance:   { settlementDays: 14, autoRelease: false },
    freelancers: { settlementDays: 7,  autoRelease: true  },
    jobs:        { settlementDays: 3,  autoRelease: true  },
    ai:          { settlementDays: 0,  autoRelease: true  },
    pos:         { settlementDays: 1,  autoRelease: true  },
    subscription:{ settlementDays: 0,  autoRelease: true  },
  },
  refundPolicy: {
    cancellationWindowHours: 24,
    autoRefundThresholdCents: 50000,   // KES 500
  },
};

async function _loadConfig() {
  const snap = await _db().doc('finosConfig/settlementRules').get();
  return snap.exists ? snap.data() : DEFAULT_CONFIG;
}

/* ═══════════════════════════════════════════════════════════════
   1. fosAutoSettlement
   Runs every 6 hours. Scans escrow where status='held' and
   createdAt is older than the hub's configured settlement window.
   Atomically releases to seller wallet and writes ledger entry.
═══════════════════════════════════════════════════════════════ */
exports.fosAutoSettlement = onSchedule(
  { schedule: '0 */6 * * *', region: 'us-central1', timeZone: 'Africa/Nairobi' },
  async () => {
    const db     = _db();
    const config = await _loadConfig();
    const now    = Date.now();

    // Build a cutoff per hub; use max(settlementDays) as the conservative
    // bound for the index query, then filter per-hub inside the loop.
    const maxDays = Math.max(
      config.defaultSettlementDays ?? 7,
      ...Object.values(config.hubs ?? {}).map(h => h.settlementDays ?? 0)
    );
    const oldestCutoff = admin.firestore.Timestamp.fromMillis(now - maxDays * 86_400_000);

    const snap = await db.collection('escrows')
      .where('status', '==', 'held')
      .where('createdAt', '<=', oldestCutoff)
      .limit(100)
      .get();

    if (snap.empty) { logger.info('[fosAutoSettlement] Nothing to release.'); return; }

    let released = 0, skipped = 0;

    for (const doc of snap.docs) {
      const e = doc.data();
      const hubRules = config.hubs?.[e.hubType] ?? {};
      const settDays = hubRules.settlementDays ?? config.defaultSettlementDays ?? 7;

      // Per-hub cutoff check
      const hubCutoffMs = now - settDays * 86_400_000;
      const createdMs   = e.createdAt?.toMillis?.() ?? 0;
      if (createdMs > hubCutoffMs) { skipped++; continue; }

      // Skip hubs configured for manual-only release
      if (hubRules.autoRelease === false) { skipped++; continue; }

      const netCents = e.netCents ?? 0;
      if (netCents <= 0) { skipped++; continue; }

      try {
        await db.runTransaction(async tx => {
          const fresh = await tx.get(doc.ref);
          if (!fresh.exists || fresh.data().status !== 'held') return;

          const walRef = db.collection('wallets').doc(e.sellerId);
          const walSnap = await tx.get(walRef);

          if (walSnap.exists) {
            tx.update(walRef, {
              availableBalance:    _inc(netCents),
              withdrawableBalance: _inc(netCents),
              pendingBalance:      _inc(-netCents),
              updatedAt:           _ts(),
            });
          } else {
            tx.set(walRef, {
              sellerId: e.sellerId, availableBalance: netCents,
              withdrawableBalance: netCents, pendingBalance: 0,
              heldBalance: 0, lifetimeEarnings: netCents,
              lifetimeWithdrawals: 0, lifetimeRefunds: 0,
              createdAt: _ts(), updatedAt: _ts(),
            });
          }

          tx.update(doc.ref, {
            status: 'released', releasedAt: _ts(), releaseMethod: 'auto',
          });

          tx.set(db.collection('ledger').doc(), {
            type: 'escrow_auto_release', escrowId: doc.id,
            sellerId: e.sellerId, hubType: e.hubType,
            transactionId: e.transactionId, amountCents: netCents,
            createdAt: _ts(),
          });
        });
        released++;
      } catch (err) {
        logger.error('[fosAutoSettlement] Error', { id: doc.id, err: err.message });
      }
    }

    logger.info('[fosAutoSettlement] Done', { released, skipped, total: snap.size });
  }
);

/* ═══════════════════════════════════════════════════════════════
   2. fosAutoRefund
   Triggered when an order's status changes to cancelled/rejected.
   Checks refund policy; auto-refunds if within window + threshold,
   otherwise flags for admin review in pendingRefunds collection.
═══════════════════════════════════════════════════════════════ */
exports.fosAutoRefund = onDocumentUpdated(
  { document: 'orders/{orderId}', region: 'us-central1' },
  async event => {
    const before  = event.data.before.data();
    const after   = event.data.after.data();
    const orderId = event.params.orderId;

    const REFUND_TRIGGERS = new Set(['cancelled', 'rejected', 'failed']);
    if (!REFUND_TRIGGERS.has(after.status) || before.status === after.status) return;
    if (!after.paymentRef && !after.transactionId) return;

    const db     = _db();
    const config = await _loadConfig();
    const policy = config.refundPolicy ?? DEFAULT_CONFIG.refundPolicy;

    const autoWindowHours    = policy.cancellationWindowHours    ?? 24;
    const autoThresholdCents = policy.autoRefundThresholdCents   ?? 50000;

    // Locate the completed FinOS transaction for this order
    const txQuery = await db.collection('finosTransactions')
      .where('orderId', '==', orderId)
      .where('status', '==', 'completed')
      .limit(1).get();
    if (txQuery.empty) return;

    const txDoc      = txQuery.docs[0];
    const txData     = txDoc.data();
    const amountCents = txData.amountCents ?? 0;
    const ageHours    = (Date.now() - (txData.createdAt?.toMillis?.() ?? 0)) / 3_600_000;
    const withinWindow    = ageHours <= autoWindowHours;
    const withinThreshold = amountCents <= autoThresholdCents;

    if (withinWindow && withinThreshold) {
      /* ── Auto-approve refund ──────────────────────────────── */
      try {
        await db.runTransaction(async tx => {
          const refRef = db.collection('refunds').doc();
          tx.set(refRef, {
            orderId, transactionId: txDoc.id,
            buyerId:  txData.buyerId  ?? after.buyerId,
            sellerId: txData.sellerId ?? after.sellerId,
            amountCents, type: 'full', status: 'approved',
            reason: `Auto-refund: order ${after.status}`,
            autoRefund: true,
            createdAt: _ts(), processedAt: _ts(),
          });

          tx.update(txDoc.ref, { status: 'refunded', refundId: refRef.id, updatedAt: _ts() });

          // Reverse escrow if held
          if (txData.escrowId) {
            tx.update(db.collection('escrows').doc(txData.escrowId), {
              status: 'refunded', refundId: refRef.id, updatedAt: _ts(),
            });
          }

          tx.set(db.collection('ledger').doc(), {
            type: 'auto_refund', orderId, refundId: refRef.id,
            amountCents, buyerId: txData.buyerId,
            sellerId: txData.sellerId, hubType: txData.hubType,
            createdAt: _ts(),
          });

          tx.set(db.collection('notifications').doc(), {
            userId: txData.buyerId ?? after.buyerId,
            title: 'Refund Processed',
            body: `Your refund of KES ${(amountCents / 100).toFixed(2)} has been processed automatically.`,
            type: 'refund', category: 'payment', status: 'unread',
            createdAt: _ts(),
          });
        });
        logger.info('[fosAutoRefund] Auto-refunded', { orderId, amountCents });
      } catch (err) {
        logger.error('[fosAutoRefund] Failed', { orderId, err: err.message });
      }
    } else {
      /* ── Flag for admin review ───────────────────────────── */
      await db.collection('pendingRefunds').doc(orderId).set({
        orderId, transactionId: txDoc.id, amountCents,
        buyerId: txData.buyerId, sellerId: txData.sellerId,
        hubType: txData.hubType, status: 'pending_review',
        reason: !withinWindow
          ? `Outside ${autoWindowHours}h auto-refund window (${Math.round(ageHours)}h elapsed)`
          : `Amount KES ${(amountCents / 100).toFixed(2)} exceeds auto-threshold KES ${(autoThresholdCents / 100).toFixed(2)}`,
        requiresAdminReview: true, orderStatus: after.status,
        createdAt: _ts(),
      }, { merge: true });
      logger.info('[fosAutoRefund] Flagged for review', { orderId, amountCents, ageHours });
    }
  }
);

/* ═══════════════════════════════════════════════════════════════
   3. fosReconcile
   Compares finosTransactions against the payment provider's records
   for a date range. Returns missing, mismatched, and orphaned txs.
═══════════════════════════════════════════════════════════════ */
exports.fosReconcile = onCall(
  { ..._cfg, secrets: [INTASEND_API_KEY] },
  async req => {
    _assertAdmin(req);
    const { dateFrom, dateTo } = req.data;
    if (!dateFrom || !dateTo)
      throw new HttpsError('invalid-argument', 'dateFrom and dateTo required (ISO 8601).');

    const from = new Date(dateFrom);
    const to   = new Date(dateTo);
    if (isNaN(from) || isNaN(to))
      throw new HttpsError('invalid-argument', 'Invalid date format.');
    if (to - from > 32 * 86_400_000)
      throw new HttpsError('invalid-argument', 'Date range must be ≤ 32 days.');

    const db = _db();

    // Our records
    const snap = await db.collection('finosTransactions')
      .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(from))
      .where('createdAt', '<=', admin.firestore.Timestamp.fromDate(to))
      .where('status', 'in', ['completed', 'failed'])
      .limit(500)
      .get();

    const finosMap = {};
    snap.docs.forEach(d => {
      const data = d.data();
      if (data.paymentRef) finosMap[data.paymentRef] = { ...data, _id: d.id };
    });

    // Provider records (IntaSend)
    let providerTxs = [];
    let providerError = null;
    try {
      const key = INTASEND_API_KEY.value();
      const url = `https://api.intasend.com/api/v1/payment/collection/?` +
        `created_after=${encodeURIComponent(from.toISOString())}&` +
        `created_before=${encodeURIComponent(to.toISOString())}&page_size=500`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      });
      if (resp.ok) { const b = await resp.json(); providerTxs = b.results ?? []; }
      else { providerError = `IntaSend HTTP ${resp.status}`; }
    } catch (e) {
      providerError = e.message;
      logger.warn('[fosReconcile] Provider fetch failed', { err: e.message });
    }

    const missing  = [];
    const mismatch = [];
    const orphaned = [];
    const providerRefs = new Set();

    for (const pt of providerTxs) {
      const ref = pt.api_ref ?? pt.invoice?.invoice_id ?? String(pt.id ?? '');
      if (!ref) continue;
      providerRefs.add(ref);
      const local = finosMap[ref];
      if (!local) {
        missing.push({ ref, amount: pt.value, currency: pt.currency ?? 'KES', providerStatus: pt.state });
      } else {
        const localKes  = (local.amountCents ?? 0) / 100;
        const pKes      = parseFloat(pt.value ?? 0);
        const statusOk  = (pt.state === 'COMPLETE' && local.status === 'completed') ||
                          (pt.state === 'FAILED'   && local.status === 'failed');
        if (Math.abs(localKes - pKes) > 0.5 || !statusOk) {
          mismatch.push({
            ref,
            local:    { amount: localKes, status: local.status, transactionId: local._id },
            provider: { amount: pKes,     status: pt.state },
          });
        }
      }
    }

    for (const [ref, local] of Object.entries(finosMap)) {
      if (!providerRefs.has(ref) && (local.provider === 'intasend' || local.provider === 'mpesa')) {
        orphaned.push({ ref, amount: (local.amountCents ?? 0) / 100, status: local.status, transactionId: local._id });
      }
    }

    logger.info('[fosReconcile]', { finosCount: snap.size, providerCount: providerTxs.length, missing: missing.length, mismatch: mismatch.length, orphaned: orphaned.length });
    return {
      dateFrom, dateTo,
      finosCount: snap.size, providerCount: providerTxs.length,
      providerError,
      summary: { missing: missing.length, mismatch: mismatch.length, orphaned: orphaned.length },
      missing, mismatch, orphaned,
    };
  }
);

/* ═══════════════════════════════════════════════════════════════
   4. fosGetForecast
   Projects next N days of platform revenue using 90-day history
   + linear regression. Appends AI insight via Claude Haiku.
═══════════════════════════════════════════════════════════════ */
exports.fosGetForecast = onCall(
  { ..._cfg, secrets: [ANTHROPIC_API_KEY] },
  async req => {
    _assertAdmin(req);
    const { horizon = 30 } = req.data;
    if (![7, 14, 30, 60, 90].includes(horizon))
      throw new HttpsError('invalid-argument', 'horizon must be 7, 14, 30, 60, or 90.');

    const db   = _db();
    const now  = Date.now();
    const since = admin.firestore.Timestamp.fromMillis(now - 90 * 86_400_000);

    // Pull commission + subscription revenue from ledger (platform revenue only)
    const snap = await db.collection('ledger')
      .where('createdAt', '>=', since)
      .where('type', 'in', ['commission', 'subscription_payment', 'advertising', 'platform_fee'])
      .limit(3000)
      .get();

    // Aggregate by calendar day (EAT = UTC+3)
    const EAT_OFFSET = 3 * 3600_000;
    const daily = {};
    snap.docs.forEach(d => {
      const data = d.data();
      const ms   = data.createdAt?.toMillis?.() ?? 0;
      if (!ms) return;
      const day = new Date(ms + EAT_OFFSET).toISOString().slice(0, 10);
      daily[day] = (daily[day] ?? 0) + (data.amountCents ?? 0);
    });

    const series = Object.entries(daily).sort(([a], [b]) => a.localeCompare(b));
    const vals   = series.map(([, v]) => v);
    const n      = vals.length || 1;

    // Ordinary least-squares linear regression
    const sumX  = (n * (n - 1)) / 2;
    const sumY  = vals.reduce((s, v) => s + v, 0);
    const sumXY = vals.reduce((s, v, i) => s + i * v, 0);
    const sumX2 = vals.reduce((s, _, i) => s + i * i, 0);
    const denom = n * sumX2 - sumX * sumX;
    const slope = denom ? (n * sumXY - sumX * sumY) / denom : 0;
    const intercept = (sumY - slope * sumX) / n;

    // Standard error for 80% confidence band
    const residuals = vals.map((v, i) => v - (intercept + slope * i));
    const se = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / Math.max(n - 2, 1));
    const z80 = 1.28;

    const forecastPoints = [];
    for (let i = 0; i < horizon; i++) {
      const dayIdx   = n + i;
      const proj     = Math.max(0, Math.round(intercept + slope * dayIdx));
      const date     = new Date(now + i * 86_400_000).toISOString().slice(0, 10);
      const margin   = Math.round(z80 * se * Math.sqrt(1 + 1 / n + Math.pow(dayIdx - n / 2, 2) / Math.max(sumX2 - sumX * sumX / n, 1)));
      forecastPoints.push({ date, projectedCents: proj, lowCents: Math.max(0, proj - margin), highCents: proj + margin });
    }

    const avg90DailyCents     = Math.round(sumY / n);
    const totalForecastCents  = forecastPoints.reduce((s, p) => s + p.projectedCents, 0);
    const trendPct            = avg90DailyCents > 0 ? Math.round((slope / avg90DailyCents) * 100 * 100) / 100 : 0;

    // AI commentary
    let aiInsight = null;
    try {
      const key = ANTHROPIC_API_KEY.value();
      if (key) {
        const avgKES     = (avg90DailyCents / 100).toFixed(0);
        const forecastKES = (totalForecastCents / 100).toFixed(0);
        const prompt = `You are a financial analyst for SOKONI, Kenya's leading digital marketplace.\n\nData:\n- Last 90-day platform revenue data points: ${n}\n- Daily average revenue: KES ${avgKES}\n- Daily trend: ${trendPct > 0 ? '+' : ''}${trendPct}% per day\n- ${horizon}-day revenue forecast: KES ${forecastKES}\n\nProvide ONE insight (max 2 sentences) about this trend and ONE specific, actionable recommendation for the SOKONI team. Be concise and data-driven.`;
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001', max_tokens: 200,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        if (resp.ok) { const b = await resp.json(); aiInsight = b.content?.[0]?.text ?? null; }
      }
    } catch (e) { logger.warn('[fosGetForecast] AI failed', { err: e.message }); }

    return {
      horizon, dataPoints: n, avg90DailyCents, trendPct,
      totalForecastCents, forecastPoints, aiInsight,
    };
  }
);

/* ═══════════════════════════════════════════════════════════════
   5. fosGetSettlementConfig — Read per-hub settlement rules
═══════════════════════════════════════════════════════════════ */
exports.fosGetSettlementConfig = onCall(
  { ..._cfg, secrets: [] },
  async req => {
    _assertAdmin(req);
    return await _loadConfig();
  }
);

/* ═══════════════════════════════════════════════════════════════
   6. fosSetSettlementConfig — Write per-hub settlement rules
   Validates all hub names and day values before writing.
═══════════════════════════════════════════════════════════════ */
const ALLOWED_HUBS = new Set([
  'marketplace','food','property','vehicle','events','healthcare',
  'legal','logistics','hotel','digital','services','pharmacy',
  'insurance','freelancers','jobs','ai','pos','subscription',
]);

exports.fosSetSettlementConfig = onCall(
  { ..._cfg, secrets: [] },
  async req => {
    const uid = _assertAdmin(req);
    const { defaultSettlementDays, hubs, refundPolicy } = req.data;

    if (typeof defaultSettlementDays !== 'number' ||
        defaultSettlementDays < 0 || defaultSettlementDays > 90)
      throw new HttpsError('invalid-argument', 'defaultSettlementDays must be 0–90.');

    if (hubs != null && typeof hubs === 'object') {
      for (const [hub, rules] of Object.entries(hubs)) {
        if (!ALLOWED_HUBS.has(hub))
          throw new HttpsError('invalid-argument', `Unknown hub: "${hub}".`);
        if (typeof rules.settlementDays !== 'number' ||
            rules.settlementDays < 0 || rules.settlementDays > 90)
          throw new HttpsError('invalid-argument', `settlementDays for "${hub}" must be 0–90.`);
        if (typeof rules.autoRelease !== 'boolean')
          throw new HttpsError('invalid-argument', `autoRelease for "${hub}" must be boolean.`);
      }
    }

    if (refundPolicy != null) {
      const rp = refundPolicy;
      if (typeof rp.cancellationWindowHours !== 'number' || rp.cancellationWindowHours < 0)
        throw new HttpsError('invalid-argument', 'cancellationWindowHours must be ≥ 0.');
      if (typeof rp.autoRefundThresholdCents !== 'number' || rp.autoRefundThresholdCents < 0)
        throw new HttpsError('invalid-argument', 'autoRefundThresholdCents must be ≥ 0.');
    }

    const db     = _db();
    const update = {
      defaultSettlementDays,
      updatedAt: _ts(),
      updatedBy: uid,
    };
    if (hubs) update.hubs = hubs;
    if (refundPolicy) update.refundPolicy = refundPolicy;

    await db.doc('finosConfig/settlementRules').set(update, { merge: true });

    await db.collection('adminAuditLog').add({
      action: 'fosSetSettlementConfig', uid,
      changes: { defaultSettlementDays, hubsUpdated: hubs ? Object.keys(hubs) : [], refundPolicy },
      timestamp: _ts(),
    });

    logger.info('[fosSetSettlementConfig] Updated', { uid, defaultSettlementDays });
    return { success: true };
  }
);

/* ═══════════════════════════════════════════════════════════════
   7. fosGetAuditTrail
   Paginated query over the immutable `ledger` collection.
   Supports filters: dateFrom, dateTo, hubType, type, userId.
═══════════════════════════════════════════════════════════════ */
const VALID_LEDGER_TYPES = new Set([
  'commission','subscription_payment','advertising','platform_fee',
  'seller_earning','withdrawal','refund','auto_refund','escrow_hold',
  'escrow_release','escrow_auto_release','adjustment','bonus',
]);

exports.fosGetAuditTrail = onCall(
  { ..._cfg, secrets: [] },
  async req => {
    _assertAdmin(req);
    const {
      dateFrom, dateTo, hubType, type, userId,
      pageSize = 50, cursor,
    } = req.data;

    if (type && !VALID_LEDGER_TYPES.has(type))
      throw new HttpsError('invalid-argument', `Unknown ledger type: "${type}".`);

    const db = _db();
    let q    = db.collection('ledger').orderBy('createdAt', 'desc');

    if (dateFrom) q = q.where('createdAt', '>=', admin.firestore.Timestamp.fromMillis(new Date(dateFrom).getTime()));
    if (dateTo)   q = q.where('createdAt', '<=', admin.firestore.Timestamp.fromMillis(new Date(dateTo).getTime()));
    if (hubType)  q = q.where('hubType', '==', hubType);
    if (type)     q = q.where('type', '==', type);
    if (userId)   q = q.where('sellerId', '==', userId);
    if (cursor)   q = q.startAfter(admin.firestore.Timestamp.fromMillis(Number(cursor)));

    const limit = Math.min(Math.max(pageSize, 1), 100);
    const snap  = await q.limit(limit).get();

    const entries = snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        type:          data.type,
        amountCents:   data.amountCents,
        hubType:       data.hubType,
        sellerId:      data.sellerId,
        buyerId:       data.buyerId,
        transactionId: data.transactionId,
        escrowId:      data.escrowId,
        refundId:      data.refundId,
        orderId:       data.orderId,
        createdAt:     data.createdAt?.toMillis?.() ?? null,
      };
    });

    const nextCursor = snap.docs.length === limit
      ? snap.docs[snap.docs.length - 1].data().createdAt?.toMillis?.() ?? null
      : null;

    return { entries, nextCursor, count: entries.length };
  }
);
