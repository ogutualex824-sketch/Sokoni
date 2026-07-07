'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');
const logger                 = require('firebase-functions/logger');
const admin                  = require('firebase-admin');

const REGION     = 'us-central1';
const db         = () => admin.firestore();
const now        = () => admin.firestore.FieldValue.serverTimestamp();
const FieldValue = admin.firestore.FieldValue;

const VALID_PROVIDERS = [
  'intasend', 'mpesa_direct', 'stripe',
  'bank_transfer', 'airtel_money', 'equity_eazzy',
];

const PROVIDER_DEFAULTS = [
  { providerId: 'intasend',      name: 'IntaSend',      enabled: true,  sandbox: false },
  { providerId: 'mpesa_direct',  name: 'M-Pesa Direct', enabled: false, sandbox: true  },
  { providerId: 'stripe',        name: 'Stripe',        enabled: false, sandbox: true  },
  { providerId: 'bank_transfer', name: 'Bank Transfer', enabled: true,  sandbox: false },
];

function assertAdmin(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
  if (!req.auth.token?.admin && !req.auth.token?.superAdmin)
    throw new HttpsError('permission-denied', 'Admin access required');
}

/** Converts Firestore Timestamps to milliseconds; leaves everything else unchanged. */
function serializeDoc(snap) {
  const raw = typeof snap.data === 'function' ? snap.data() : snap;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = v && typeof v.toMillis === 'function' ? v.toMillis() : v;
  }
  return out;
}

/** Write a standard audit entry to subscriptionAuditLog. */
async function audit(action, payload) {
  await db().collection('subscriptionAuditLog').add({
    action,
    ...payload,
    createdAt: now(),
  });
}

/* ────────────────────────────────────────────────────────
   1. fosGetProviderConfig
   Returns all payment provider configs; seeds defaults when
   the collection is empty.
──────────────────────────────────────────────────────── */
exports.fosGetProviderConfig = onCall({ region: REGION }, async (req) => {
  assertAdmin(req);

  const snap = await db().collection('providerConfig').get();
  if (snap.empty) {
    return { providers: PROVIDER_DEFAULTS.map(p => ({
      ...p,
      webhookUrl: '',
      lastHealthCheck: null,
      lastHealthStatus: null,
      updatedAt: null,
    })) };
  }

  const providers = snap.docs.map(d => ({ providerId: d.id, ...serializeDoc(d) }));
  return { providers };
});

/* ────────────────────────────────────────────────────────
   2. fosConfigureProvider
   Upserts a provider config. Prevents disabling every provider.
──────────────────────────────────────────────────────── */
exports.fosConfigureProvider = onCall({ region: REGION }, async (req) => {
  assertAdmin(req);

  const { providerId, enabled, sandbox, webhookUrl, notes } = req.data ?? {};

  if (!providerId || !VALID_PROVIDERS.includes(providerId)) {
    throw new HttpsError(
      'invalid-argument',
      `providerId must be one of: ${VALID_PROVIDERS.join(', ')}`
    );
  }

  // Guard: must keep at least 1 provider enabled after this change.
  if (enabled === false) {
    const allSnap = await db().collection('providerConfig').get();

    // Build a map of current enabled states, starting from defaults.
    const enabledMap = Object.fromEntries(
      PROVIDER_DEFAULTS.map(p => [p.providerId, p.enabled])
    );
    for (const d of allSnap.docs) {
      enabledMap[d.id] = d.data().enabled ?? false;
    }
    enabledMap[providerId] = false; // apply proposed change

    if (!Object.values(enabledMap).some(Boolean)) {
      throw new HttpsError(
        'failed-precondition',
        'Cannot disable all providers. At least one must remain enabled.'
      );
    }
  }

  const update = { updatedAt: now() };
  if (typeof enabled    === 'boolean') update.enabled    = enabled;
  if (typeof sandbox    === 'boolean') update.sandbox    = sandbox;
  if (typeof webhookUrl === 'string')  update.webhookUrl = webhookUrl;
  if (notes)                           update.notes      = notes;

  await db().collection('providerConfig').doc(providerId).set(update, { merge: true });

  await audit('provider_config_changed', {
    who: req.auth.uid,
    providerId,
    changes: { enabled, sandbox, webhookUrl },
  });

  logger.info('Provider config updated', { providerId, uid: req.auth.uid });
  return { success: true, providerId };
});

/* ────────────────────────────────────────────────────────
   3. fosGetFraudQueue
   Paginated read of fraudAlerts by status.
──────────────────────────────────────────────────────── */
exports.fosGetFraudQueue = onCall({ region: REGION }, async (req) => {
  assertAdmin(req);

  const { status = 'open', pageSize = 20, cursor } = req.data ?? {};

  if (!['open', 'reviewed', 'actioned'].includes(status)) {
    throw new HttpsError('invalid-argument', "status must be 'open', 'reviewed', or 'actioned'");
  }

  const limit = Math.min(Math.max(1, Number(pageSize) || 20), 50);

  let q = db().collection('fraudAlerts')
    .where('status', '==', status)
    .orderBy('createdAt', 'desc')
    .limit(limit + 1); // fetch one extra to detect next page

  if (cursor) {
    const cursorSnap = await db().collection('fraudAlerts').doc(cursor).get();
    if (cursorSnap.exists) q = q.startAfter(cursorSnap);
  }

  const [pageSnap, countSnap] = await Promise.all([
    q.get(),
    db().collection('fraudAlerts').where('status', '==', status).count().get(),
  ]);

  const hasMore = pageSnap.docs.length > limit;
  const page    = hasMore ? pageSnap.docs.slice(0, limit) : pageSnap.docs;

  return {
    alerts:     page.map(d => ({ id: d.id, ...serializeDoc(d) })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
    total:      countSnap.data().count,
  };
});

/* ────────────────────────────────────────────────────────
   4. fosReviewFraudAlert
   Marks a fraud alert as reviewed / actioned / dismissed.
   Sends a notification to the affected user when actioned.
──────────────────────────────────────────────────────── */
exports.fosReviewFraudAlert = onCall({ region: REGION }, async (req) => {
  assertAdmin(req);

  const { alertId, action, notes } = req.data ?? {};

  if (!alertId) throw new HttpsError('invalid-argument', 'alertId is required');
  if (!['reviewed', 'actioned', 'dismissed'].includes(action)) {
    throw new HttpsError('invalid-argument', "action must be 'reviewed', 'actioned', or 'dismissed'");
  }

  const alertRef = db().collection('fraudAlerts').doc(alertId);
  const alertDoc = await alertRef.get();
  if (!alertDoc.exists) throw new HttpsError('not-found', 'Fraud alert not found');

  const alert  = alertDoc.data();
  const update = { status: action, reviewedBy: req.auth.uid, reviewedAt: now() };
  if (notes) update.notes = notes;

  await alertRef.update(update);

  const writes = [
    audit('fraud_alert_reviewed', { alertId, who: req.auth.uid, outcome: action }),
  ];

  if (action === 'actioned' && alert.uid) {
    writes.push(
      db().collection('notifications').add({
        uid:       alert.uid,
        type:      'fraud_action',
        title:     'Account Security Notice',
        body:      'A security review has been completed on your account. Contact support if you have questions.',
        read:      false,
        createdAt: now(),
      })
    );
  }

  await Promise.all(writes);

  logger.info('Fraud alert reviewed', { alertId, action, uid: req.auth.uid });
  return { success: true, alertId, action };
});

/* ────────────────────────────────────────────────────────
   5. fosGetRevenueComparison
   Aggregates ledgerEntries for current period and (optionally)
   the preceding equivalent period, returning delta percentages.
──────────────────────────────────────────────────────── */
exports.fosGetRevenueComparison = onCall({ region: REGION }, async (req) => {
  assertAdmin(req);

  const { period = 'month', comparison = false } = req.data ?? {};

  const PERIOD_MS = {
    day: 86_400_000, week: 604_800_000, month: 2_592_000_000,
    quarter: 7_776_000_000, year: 31_536_000_000,
  };
  if (!PERIOD_MS[period]) {
    throw new HttpsError('invalid-argument', "period must be day, week, month, quarter, or year");
  }

  const durMs    = PERIOD_MS[period];
  const nowMs    = Date.now();
  const curStart = new Date(nowMs - durMs);
  const curEnd   = new Date(nowMs);
  const preStart = new Date(nowMs - 2 * durMs);
  const preEnd   = new Date(nowMs - durMs);

  async function aggregate(start, end) {
    const snap = await db().collection('ledgerEntries')
      .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(start))
      .where('createdAt', '<',  admin.firestore.Timestamp.fromDate(end))
      .get();

    let totalRevenueCents = 0, commissionCents = 0, refundsCents = 0;
    const byHub = {}, byType = {};

    for (const d of snap.docs) {
      const e   = d.data();
      const amt = Number(e.amountCents) || 0;
      const hub = e.hub  || 'other';
      const typ = e.type || 'unknown';

      if (typ === 'refund') {
        refundsCents += amt;
      } else {
        totalRevenueCents += amt;
        if (typ === 'commission') commissionCents += amt;
      }
      byHub[hub] = (byHub[hub] || 0) + amt;
      byType[typ] = (byType[typ] || 0) + amt;
    }

    return {
      totalRevenueCents,
      commissionCents,
      refundsCents,
      netCents: totalRevenueCents - refundsCents,
      byHub,
      byType,
      periodStart: start.getTime(),
      periodEnd:   end.getTime(),
    };
  }

  const delta = (a, b) =>
    b === 0 ? null : Math.round(((a - b) / b) * 10_000) / 100;

  const current = await aggregate(curStart, curEnd);
  const result  = { period, current };

  if (comparison) {
    const previous  = await aggregate(preStart, preEnd);
    result.previous = previous;
    result.delta    = {
      totalRevenuePct:  delta(current.totalRevenueCents, previous.totalRevenueCents),
      commissionPct:    delta(current.commissionCents,   previous.commissionCents),
      refundsPct:       delta(current.refundsCents,      previous.refundsCents),
      netPct:           delta(current.netCents,          previous.netCents),
    };
  }

  return result;
});

/* ────────────────────────────────────────────────────────
   6. fosAdminSettleEscrow
   Admin-initiated escrow release with seller wallet credit
   and full double-entry ledger record. Runs atomically.
──────────────────────────────────────────────────────── */
exports.fosAdminSettleEscrow = onCall({ region: REGION }, async (req) => {
  assertAdmin(req);

  const { escrowId, reason, forceRelease = false } = req.data ?? {};

  if (!escrowId) throw new HttpsError('invalid-argument', 'escrowId is required');
  if (!reason || typeof reason !== 'string' || !reason.trim()) {
    throw new HttpsError('invalid-argument', 'reason must be a non-empty string');
  }

  const escrowRef = db().collection('escrows').doc(escrowId);
  const escrowDoc = await escrowRef.get();
  if (!escrowDoc.exists) throw new HttpsError('not-found', 'Escrow not found');

  const escrow = escrowDoc.data();
  if (!['held', 'disputed'].includes(escrow.status)) {
    throw new HttpsError(
      'failed-precondition',
      `Escrow status '${escrow.status}' cannot be settled. Must be 'held' or 'disputed'.`
    );
  }

  const walletRef  = db().collection('wallets').doc(escrow.sellerId);
  const ledgerRef  = db().collection('ledgerEntries').doc();

  await db().runTransaction(async (tx) => {
    const walletSnap = await tx.get(walletRef);

    tx.update(escrowRef, {
      status:       'released',
      settledBy:    req.auth.uid,
      settledAt:    now(),
      settleReason: reason,
      forceRelease,
    });

    if (walletSnap.exists) {
      tx.update(walletRef, {
        availableBalance: FieldValue.increment(escrow.amountCents),
        lifetimeEarnings: FieldValue.increment(escrow.amountCents),
        updatedAt: now(),
      });
    } else {
      // Bootstrap wallet if seller has none yet.
      tx.set(walletRef, {
        sellerId:         escrow.sellerId,
        availableBalance: escrow.amountCents,
        lifetimeEarnings: escrow.amountCents,
        createdAt:        now(),
        updatedAt:        now(),
      });
    }

    tx.set(ledgerRef, {
      type:        'escrow_release',
      escrowId,
      sellerId:    escrow.sellerId,
      amountCents: escrow.amountCents,
      settledBy:   req.auth.uid,
      reason,
      forceRelease,
      createdAt:   now(),
    });
  });

  await audit('escrow_admin_settled', {
    escrowId,
    sellerId:    escrow.sellerId,
    amountCents: escrow.amountCents,
    who:         req.auth.uid,
    reason,
  });

  logger.info('Admin settled escrow', {
    escrowId, uid: req.auth.uid, amountCents: escrow.amountCents,
  });
  return { success: true, escrowId, amountCents: escrow.amountCents };
});
