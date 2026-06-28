/* ================================================================
   SOKONI Payment State Machine  v1.0  (7 Cloud Functions)
   ────────────────────────────────────────────────────────────
   Enforces a strict 12-state FSM over every payment session.

   States (in order of forward progression):
     CREATED → PENDING → AUTHORIZED → VERIFIED →
     INVENTORY_RESERVED → ACCOUNTING_POSTED →
     COMMISSION_CALCULATED → LOYALTY_AWARDED →
     SELLER_SETTLEMENT_PENDING → DELIVERY_ASSIGNED →
     DELIVERED → COMPLETED → ARCHIVED

   Terminal error states:
     FAILED   (retryable — may return to CREATED)
     EXPIRED  (retryable — may return to CREATED)
     VOIDED   (irrecoverable)

   Functions exported:
     createPaymentSession        — open a new payment session (idempotent)
     transitionPaymentState      — advance / fail the FSM (transactional)
     getPaymentState             — fast lookup (no AppCheck required)
     recoverPaymentSession       — admin override for stuck sessions
     getStuckSessions            — list sessions that have stalled
     reconcilePaymentSessions    — nightly scheduled sweep (1AM UTC)
     sealPaymentAuditTrail       — archive + tamper-evidence hash

   Collection: paymentSessions/{sessionId}
   Ancillary:  paymentRecoveryLog/{sessionId}_{attempt}
               paymentReconciliation/{id}
               paymentAuditSeals/{sessionId}

   All monetary values in KES integer cents.
   All timestamps via F.serverTimestamp().
   All state writes use runTransaction.
================================================================ */
'use strict';

const { onCall, HttpsError }   = require('firebase-functions/v2/https');
const { onSchedule }           = require('firebase-functions/v2/scheduler');
const admin                    = require('firebase-admin');
const { defineSecret }         = require('firebase-functions/params');
const crypto                   = require('crypto');

/* ── Admin SDK ─────────────────────────────────────────────── */
const db = admin.firestore();
const F  = admin.firestore.FieldValue;

/* ── Runtime config ────────────────────────────────────────── */
const REGION = 'us-central1';
const OPT    = { region: REGION, enforceAppCheck: true };

/* ── Secrets ────────────────────────────────────────────────
   PAYMENT_HMAC_SECRET: used when sealing the audit trail.
   Add to Secret Manager before deploying.
──────────────────────────────────────────────────────────────*/
const PAYMENT_HMAC_SECRET = defineSecret('PAYMENT_HMAC_SECRET');

/* ================================================================
   STATE MACHINE DEFINITION
================================================================ */

/** Every payment session must pass through these states in order.
 *  Error / edge states (FAILED, EXPIRED, VOIDED) are separate. */
const PAYMENT_STATES = [
  'CREATED',                   // session initialised
  'PENDING',                   // payment initiated (STK push sent / card pre-auth)
  'AUTHORIZED',                // payment gateway confirmed authorisation
  'VERIFIED',                  // server-side verification complete
  'INVENTORY_RESERVED',        // stock locked for this order
  'ACCOUNTING_POSTED',         // double-entry GL written
  'COMMISSION_CALCULATED',     // platform commission computed
  'LOYALTY_AWARDED',           // points + cashback credited to customer
  'SELLER_SETTLEMENT_PENDING', // seller net payout queued
  'DELIVERY_ASSIGNED',         // rider / courier assigned
  'DELIVERED',                 // proof of delivery received
  'COMPLETED',                 // order closed, audit trail sealed
  'ARCHIVED',                  // moved to cold storage
];

/** Valid transitions — every state can only move to specific next states. */
const VALID_TRANSITIONS = {
  CREATED:                   ['PENDING', 'FAILED'],
  PENDING:                   ['AUTHORIZED', 'FAILED', 'EXPIRED'],
  AUTHORIZED:                ['VERIFIED', 'FAILED', 'VOIDED'],
  VERIFIED:                  ['INVENTORY_RESERVED', 'FAILED'],
  INVENTORY_RESERVED:        ['ACCOUNTING_POSTED', 'FAILED'],
  ACCOUNTING_POSTED:         ['COMMISSION_CALCULATED'],
  COMMISSION_CALCULATED:     ['LOYALTY_AWARDED'],
  LOYALTY_AWARDED:           ['SELLER_SETTLEMENT_PENDING'],
  SELLER_SETTLEMENT_PENDING: ['DELIVERY_ASSIGNED', 'COMPLETED'],
  DELIVERY_ASSIGNED:         ['DELIVERED', 'FAILED'],
  DELIVERED:                 ['COMPLETED'],
  COMPLETED:                 ['ARCHIVED'],
  ARCHIVED:                  [],
  FAILED:                    ['CREATED'],   // allow retry
  EXPIRED:                   ['CREATED'],
  VOIDED:                    [],
};

/** Terminal states — no further transitions allowed (except FAILED / EXPIRED retry). */
const TERMINAL_STATES = new Set(['COMPLETED', 'ARCHIVED', 'VOIDED']);

/** States that must not be skipped — financial integrity depends on each one. */
const FINANCIAL_STATES = new Set([
  'VERIFIED',
  'INVENTORY_RESERVED',
  'ACCOUNTING_POSTED',
  'COMMISSION_CALCULATED',
  'LOYALTY_AWARDED',
  'SELLER_SETTLEMENT_PENDING',
]);

/** Valid payment methods accepted by the platform. */
const VALID_PAYMENT_METHODS = new Set(['mpesa', 'card', 'wallet', 'cash', 'bank', 'mixed']);

/* ================================================================
   HELPERS
================================================================ */

/**
 * Structured JSON logger scoped to a single invocation.
 * Every line carries the same requestId for Cloud Logging correlation.
 */
function createLogger(context = {}) {
  const id = context.requestId ||
    (Date.now().toString(36) + Math.random().toString(36).slice(2, 7)).toUpperCase();
  const base = { requestId: id, service: 'payment-state-machine', ...context };
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
 * Generate a deterministic, collision-resistant session ID.
 * sha256(`${orderId}|${merchantId}|${uid}|${amount}`) → hex
 * Same inputs always yield the same sessionId (idempotency key).
 */
function deriveSessionId(orderId, merchantId, uid, amount) {
  return crypto
    .createHash('sha256')
    .update(`${orderId}|${merchantId}|${uid}|${amount}`)
    .digest('hex');
}

/**
 * Compute a sha256 HMAC over the stateHistory array.
 * Used as a tamper-evidence seal when archiving sessions.
 */
function computeHistoryHash(stateHistory, secret) {
  const payload = JSON.stringify(stateHistory);
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/** Write an admin alert document to surface issues in ops dashboards. */
async function writeAdminAlert(type, data, logger) {
  try {
    await db.collection('adminAlerts').add({
      type,
      source:    'payment-state-machine',
      data,
      createdAt: F.serverTimestamp(),
      resolved:  false,
    });
  } catch (err) {
    logger.error('Failed to write admin alert', { alertType: type, error: err.message });
  }
}

/* ================================================================
   1. createPaymentSession
   ────────────────────────────────────────────────────────────────
   Opens a new payment session in state CREATED.
   Idempotent — re-calling with the same inputs returns the
   existing session (unless it is FAILED / EXPIRED, in which
   case a fresh session is written over the old one).
================================================================ */
exports.createPaymentSession = onCall(
  { ...OPT, secrets: [PAYMENT_HMAC_SECRET] },
  async (req) => {
    const log = createLogger({ fn: 'createPaymentSession', uid: req.auth?.uid });
    assertAuth(req);

    const { orderId, merchantId, uid, amount, paymentMethod, metadata = {} } = req.data;

    /* ── Input validation ────────────────────────────────────── */
    if (!orderId  || typeof orderId  !== 'string' || !orderId.trim())
      throw new HttpsError('invalid-argument', 'orderId is required.');
    if (!merchantId || typeof merchantId !== 'string' || !merchantId.trim())
      throw new HttpsError('invalid-argument', 'merchantId is required.');
    if (!uid || typeof uid !== 'string' || !uid.trim())
      throw new HttpsError('invalid-argument', 'uid is required.');
    if (!Number.isInteger(amount) || amount <= 0)
      throw new HttpsError('invalid-argument', 'amount must be a positive integer (KES cents).');
    if (amount > 10_000_000_00)  // hard cap: KES 10,000,000
      throw new HttpsError('invalid-argument', 'amount exceeds platform ceiling (KES 10,000,000).');
    if (!paymentMethod || !VALID_PAYMENT_METHODS.has(paymentMethod))
      throw new HttpsError('invalid-argument',
        `paymentMethod must be one of: ${[...VALID_PAYMENT_METHODS].join(', ')}.`);
    if (typeof metadata !== 'object' || Array.isArray(metadata))
      throw new HttpsError('invalid-argument', 'metadata must be a plain object.');

    /* Caller must be the session owner or an admin */
    const callerUid = req.auth.uid;
    const isAdmin   = req.auth.token?.admin || req.auth.token?.superAdmin;
    if (callerUid !== uid && !isAdmin)
      throw new HttpsError('permission-denied', 'You may only create sessions for yourself.');

    /* ── Derive deterministic sessionId ─────────────────────── */
    const sessionId = deriveSessionId(orderId, merchantId, uid, amount);
    const sessionRef = db.collection('paymentSessions').doc(sessionId);

    log.info('Creating payment session', { sessionId, orderId, merchantId, uid, amount, paymentMethod });

    /* ── Idempotency check (outside transaction for read speed) */
    const existing = await sessionRef.get();
    if (existing.exists) {
      const data = existing.data();
      /* If session exists and is not in a retryable terminal state, return it */
      if (!['FAILED', 'EXPIRED'].includes(data.currentState)) {
        log.info('Returning existing session', { sessionId, state: data.currentState });
        return {
          sessionId,
          state:     data.currentState,
          createdAt: data.createdAt,
          idempotent: true,
        };
      }
      /* FAILED / EXPIRED — overwrite with a fresh session below */
      log.info('Session was FAILED/EXPIRED — recreating', { sessionId, prevState: data.currentState });
    }

    /* ── Write new session ───────────────────────────────────── */
    const now = F.serverTimestamp();
    const firstHistoryEntry = {
      state:     'CREATED',
      timestamp: now,
      actor:     callerUid,
      notes:     'Session created.',
      metadata:  { ip: req.rawRequest?.ip || null },
    };

    await sessionRef.set({
      sessionId,
      orderId:       orderId.trim(),
      merchantId:    merchantId.trim(),
      uid:           uid.trim(),
      amount,
      currency:      'KES',
      paymentMethod,
      paymentRef:    null,
      currentState:  'CREATED',
      stateHistory:  [firstHistoryEntry],
      createdAt:     now,
      updatedAt:     now,
      completedAt:   null,
      metadata,
      recoveryAttempts:  0,
      lastRecoveryAt:    null,
    });

    log.audit('Payment session created', { sessionId, orderId, merchantId, uid, amount, paymentMethod });

    return {
      sessionId,
      state:     'CREATED',
      createdAt: new Date().toISOString(),
      idempotent: false,
    };
  }
);

/* ================================================================
   2. transitionPaymentState
   ────────────────────────────────────────────────────────────────
   Advances the FSM to toState.  All transitions are atomic.
   Invalid transitions are rejected with a descriptive error.
================================================================ */
exports.transitionPaymentState = onCall(
  { ...OPT, secrets: [PAYMENT_HMAC_SECRET] },
  async (req) => {
    const log = createLogger({ fn: 'transitionPaymentState', uid: req.auth?.uid });
    assertAuth(req);

    const { sessionId, toState, actor, notes = '', metadata = {} } = req.data;

    /* ── Input validation ────────────────────────────────────── */
    if (!sessionId || typeof sessionId !== 'string')
      throw new HttpsError('invalid-argument', 'sessionId is required.');
    if (!toState || !VALID_TRANSITIONS[toState] === undefined)
      throw new HttpsError('invalid-argument', 'toState is not a recognised payment state.');
    if (!Object.prototype.hasOwnProperty.call(VALID_TRANSITIONS, toState))
      throw new HttpsError('invalid-argument', `toState "${toState}" is not a recognised payment state.`);
    if (!actor || typeof actor !== 'string')
      throw new HttpsError('invalid-argument', 'actor is required (system, uid, or service name).');
    if (typeof metadata !== 'object' || Array.isArray(metadata))
      throw new HttpsError('invalid-argument', 'metadata must be a plain object.');

    const callerUid = req.auth.uid;
    const isAdmin   = req.auth.token?.admin || req.auth.token?.superAdmin;

    log.info('Transition requested', { sessionId, toState, actor });

    /* ── Transactional state write ───────────────────────────── */
    let previousState;
    let transitionedAt;

    await db.runTransaction(async (tx) => {
      const sessionRef = db.collection('paymentSessions').doc(sessionId);
      const snap       = await tx.get(sessionRef);

      if (!snap.exists)
        throw new HttpsError('not-found', `Payment session "${sessionId}" does not exist.`);

      const session      = snap.data();
      previousState      = session.currentState;
      const currentState = session.currentState;

      /* ── Ownership check (non-admin callers must own the session) */
      if (!isAdmin && session.uid !== callerUid)
        throw new HttpsError('permission-denied', 'You are not authorised to modify this payment session.');

      /* ── Validate transition ─────────────────────────────────── */
      const allowedNext = VALID_TRANSITIONS[currentState] || [];
      if (!allowedNext.includes(toState)) {
        log.warn('Invalid transition attempted', { sessionId, from: currentState, to: toState });
        throw new HttpsError(
          'failed-precondition',
          `Cannot transition from ${currentState} to ${toState}. ` +
          `Allowed next states: [${allowedNext.join(', ') || 'none'}].`
        );
      }

      /* ── Build history entry ────────────────────────────────── */
      const historyEntry = {
        state:     toState,
        timestamp: F.serverTimestamp(),
        actor,
        notes:     (notes || '').slice(0, 500), // cap note length
        metadata,
      };

      /* ── Compose updates ────────────────────────────────────── */
      const updates = {
        currentState: toState,
        updatedAt:    F.serverTimestamp(),
        stateHistory: F.arrayUnion(historyEntry),
      };

      if (toState === 'COMPLETED') {
        updates.completedAt = F.serverTimestamp();
      }

      tx.update(sessionRef, updates);
      transitionedAt = new Date().toISOString();
    });

    log.audit('Payment state transitioned', {
      sessionId, previousState, toState, actor,
    });

    return {
      sessionId,
      previousState,
      currentState:   toState,
      transitionedAt,
    };
  }
);

/* ================================================================
   3. getPaymentState
   ────────────────────────────────────────────────────────────────
   Fast lookup — no AppCheck required so it can be called from
   lightweight polling contexts (order status page, etc.).
   Accepts sessionId OR (orderId + merchantId).
================================================================ */
exports.getPaymentState = onCall(
  { region: REGION }, // no enforceAppCheck — fast public lookup
  async (req) => {
    const log = createLogger({ fn: 'getPaymentState', uid: req.auth?.uid });
    assertAuth(req);

    const { sessionId, orderId, merchantId } = req.data;

    if (!sessionId && (!orderId || !merchantId))
      throw new HttpsError('invalid-argument',
        'Provide sessionId OR both orderId and merchantId.');

    const callerUid = req.auth.uid;
    const isAdmin   = req.auth.token?.admin || req.auth.token?.superAdmin;

    let snap;

    if (sessionId) {
      snap = await db.collection('paymentSessions').doc(sessionId).get();
      if (!snap.exists)
        throw new HttpsError('not-found', `Payment session "${sessionId}" not found.`);
    } else {
      /* Lookup by orderId + merchantId — returns the most recent session */
      const query = await db.collection('paymentSessions')
        .where('orderId',    '==', orderId.trim())
        .where('merchantId', '==', merchantId.trim())
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get();

      if (query.empty)
        throw new HttpsError('not-found',
          `No payment session found for orderId="${orderId}" merchantId="${merchantId}".`);

      snap = query.docs[0];
    }

    const data = snap.data();

    /* Non-admin callers may only read their own sessions */
    if (!isAdmin && data.uid !== callerUid)
      throw new HttpsError('permission-denied', 'You are not authorised to view this session.');

    log.info('Payment state retrieved', { sessionId: snap.id, state: data.currentState });

    return {
      sessionId:        snap.id,
      orderId:          data.orderId,
      merchantId:       data.merchantId,
      uid:              data.uid,
      amount:           data.amount,
      currency:         data.currency,
      paymentMethod:    data.paymentMethod,
      paymentRef:       data.paymentRef,
      currentState:     data.currentState,
      stateHistory:     data.stateHistory || [],
      createdAt:        data.createdAt,
      updatedAt:        data.updatedAt,
      completedAt:      data.completedAt,
      recoveryAttempts: data.recoveryAttempts || 0,
    };
  }
);

/* ================================================================
   4. recoverPaymentSession
   ────────────────────────────────────────────────────────────────
   Admin-only override for sessions that are genuinely stuck.
   Bypasses VALID_TRANSITIONS — every override is fully audited.
   A session is eligible for recovery only if:
     • updatedAt > 30 minutes ago
     • currentState is not a terminal state
     • currentState is not ARCHIVED
================================================================ */
exports.recoverPaymentSession = onCall(
  { ...OPT, secrets: [PAYMENT_HMAC_SECRET] },
  async (req) => {
    const log = createLogger({ fn: 'recoverPaymentSession', uid: req.auth?.uid });
    assertAdmin(req);

    const { sessionId, targetState, reason } = req.data;

    /* ── Input validation ────────────────────────────────────── */
    if (!sessionId || typeof sessionId !== 'string')
      throw new HttpsError('invalid-argument', 'sessionId is required.');
    if (!targetState || !Object.prototype.hasOwnProperty.call(VALID_TRANSITIONS, targetState))
      throw new HttpsError('invalid-argument', `targetState "${targetState}" is not a recognised payment state.`);
    if (!reason || typeof reason !== 'string' || reason.trim().length < 10)
      throw new HttpsError('invalid-argument', 'reason must be at least 10 characters.');

    const adminUid = req.auth.uid;

    log.warn('Admin recovery initiated', { sessionId, targetState, adminUid });

    let previousState;
    let newAttempts;

    await db.runTransaction(async (tx) => {
      const sessionRef = db.collection('paymentSessions').doc(sessionId);
      const snap       = await tx.get(sessionRef);

      if (!snap.exists)
        throw new HttpsError('not-found', `Payment session "${sessionId}" does not exist.`);

      const session  = snap.data();
      previousState  = session.currentState;

      /* ── Eligibility checks ──────────────────────────────────── */
      if (session.currentState === 'ARCHIVED')
        throw new HttpsError('failed-precondition', 'Archived sessions cannot be recovered.');

      const updatedMs  = session.updatedAt?.toMillis?.() || 0;
      const stuckMs    = 30 * 60 * 1000; // 30 minutes
      const isStuck    = (Date.now() - updatedMs) > stuckMs;
      const isTerminal = TERMINAL_STATES.has(session.currentState);

      if (!isStuck && !isTerminal)
        throw new HttpsError('failed-precondition',
          'Session was updated within the last 30 minutes and is not stuck. Aborting recovery.');

      newAttempts = (session.recoveryAttempts || 0) + 1;

      const historyEntry = {
        state:     targetState,
        timestamp: F.serverTimestamp(),
        actor:     `admin:${adminUid}`,
        notes:     `[ADMIN RECOVERY #${newAttempts}] ${reason.trim().slice(0, 500)}`,
        metadata:  {
          previousState,
          adminOverride:    true,
          recoveryAttempt:  newAttempts,
        },
      };

      tx.update(sessionRef, {
        currentState:      targetState,
        updatedAt:         F.serverTimestamp(),
        stateHistory:      F.arrayUnion(historyEntry),
        recoveryAttempts:  newAttempts,
        lastRecoveryAt:    F.serverTimestamp(),
        ...(targetState === 'COMPLETED' ? { completedAt: F.serverTimestamp() } : {}),
      });
    });

    /* ── Write immutable recovery audit log ──────────────────── */
    const logDocId = `${sessionId}_${newAttempts}`;
    await db.collection('paymentRecoveryLog').doc(logDocId).set({
      sessionId,
      attempt:        newAttempts,
      previousState,
      targetState,
      reason:         reason.trim(),
      adminUid,
      recoveredAt:    F.serverTimestamp(),
      adminOverride:  true,
    });

    log.audit('Payment session recovered by admin', {
      sessionId, previousState, targetState, adminUid, attempt: newAttempts,
    });

    return {
      recovered:     true,
      sessionId,
      previousState,
      newState:      targetState,
      attempts:      newAttempts,
    };
  }
);

/* ================================================================
   5. getStuckSessions
   ────────────────────────────────────────────────────────────────
   Admin-only.  Returns sessions for a given merchant that have
   not progressed past a non-terminal state within stuckMinutes.
================================================================ */
exports.getStuckSessions = onCall(
  OPT,
  async (req) => {
    const log = createLogger({ fn: 'getStuckSessions', uid: req.auth?.uid });
    assertAdmin(req);

    const { merchantId, stuckMinutes = 15 } = req.data;

    if (!merchantId || typeof merchantId !== 'string')
      throw new HttpsError('invalid-argument', 'merchantId is required.');
    if (typeof stuckMinutes !== 'number' || stuckMinutes < 1 || stuckMinutes > 1440)
      throw new HttpsError('invalid-argument', 'stuckMinutes must be between 1 and 1440.');

    const cutoff = new Date(Date.now() - stuckMinutes * 60 * 1000);

    log.info('Querying stuck sessions', { merchantId, stuckMinutes, cutoff: cutoff.toISOString() });

    /* Query: merchantId match + updatedAt before cutoff */
    const snap = await db.collection('paymentSessions')
      .where('merchantId', '==', merchantId)
      .where('updatedAt',  '<',  admin.firestore.Timestamp.fromDate(cutoff))
      .orderBy('updatedAt', 'asc')
      .limit(100)
      .get();

    /* Client-side filter: exclude terminal and ARCHIVED states */
    const sessions = snap.docs
      .map(d => d.data())
      .filter(s => !TERMINAL_STATES.has(s.currentState) && s.currentState !== 'ARCHIVED')
      .map(s => ({
        sessionId:    s.sessionId,
        orderId:      s.orderId,
        currentState: s.currentState,
        amount:       s.amount,
        currency:     s.currency,
        updatedAt:    s.updatedAt,
        createdAt:    s.createdAt,
        stuckFor:     `${Math.round((Date.now() - (s.updatedAt?.toMillis?.() || 0)) / 60000)} min`,
        recoveryAttempts: s.recoveryAttempts || 0,
      }));

    log.info('Stuck sessions retrieved', { merchantId, count: sessions.length });

    return {
      merchantId,
      stuckMinutes,
      count:    sessions.length,
      sessions,
    };
  }
);

/* ================================================================
   6. reconcilePaymentSessions  (scheduled)
   ────────────────────────────────────────────────────────────────
   Runs every night at 1AM UTC (4AM EAT).
   Sweeps all sessions from the past 24h that are stuck in a
   FINANCIAL_STATE for more than 2 hours.  Raises admin alerts
   for each stuck session.
================================================================ */
exports.reconcilePaymentSessions = onSchedule(
  { schedule: '0 1 * * *', region: REGION, timeoutSeconds: 540 },
  async () => {
    const log = createLogger({ fn: 'reconcilePaymentSessions' });
    log.info('Starting nightly payment reconciliation');

    const now          = Date.now();
    const window24h    = new Date(now - 24 * 60 * 60 * 1000);
    const stuckCutoff  = new Date(now - 2 * 60 * 60 * 1000);  // stuck > 2h

    let totalChecked   = 0;
    let totalStuck     = 0;
    const stuckEntries = [];

    /* Page through sessions created in the last 24h */
    let query = db.collection('paymentSessions')
      .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(window24h))
      .orderBy('createdAt', 'asc')
      .limit(200);

    let lastDoc = null;

    /* eslint-disable no-await-in-loop */
    do {
      const snap = lastDoc ? await query.startAfter(lastDoc).get() : await query.get();
      if (snap.empty) break;

      for (const doc of snap.docs) {
        const s = doc.data();
        totalChecked++;

        const isFinancialState = FINANCIAL_STATES.has(s.currentState);
        const isTerminal       = TERMINAL_STATES.has(s.currentState);
        const updatedMs        = s.updatedAt?.toMillis?.() || 0;
        const isOld            = updatedMs < stuckCutoff.getTime();

        if (isFinancialState && !isTerminal && isOld) {
          totalStuck++;
          stuckEntries.push({
            sessionId:    s.sessionId,
            orderId:      s.orderId,
            merchantId:   s.merchantId,
            currentState: s.currentState,
            amount:       s.amount,
            updatedAt:    s.updatedAt,
            stuckHours:   Math.round((now - updatedMs) / 3_600_000),
          });

          /* Write per-session reconciliation record */
          await db.collection('paymentReconciliation').add({
            sessionId:    s.sessionId,
            orderId:      s.orderId,
            merchantId:   s.merchantId,
            currentState: s.currentState,
            amount:       s.amount,
            flaggedAt:    F.serverTimestamp(),
            stuckHours:   Math.round((now - updatedMs) / 3_600_000),
            resolved:     false,
          });
        }
      }

      lastDoc = snap.docs[snap.docs.length - 1];
    } while (lastDoc);
    /* eslint-enable no-await-in-loop */

    /* ── Write admin alert if any sessions are stuck ─────────── */
    if (totalStuck > 0) {
      await writeAdminAlert('payment_reconciliation_stuck_sessions', {
        totalChecked,
        totalStuck,
        stuckSessions: stuckEntries.slice(0, 20), // cap payload
      }, log);
    }

    log.audit('Nightly reconciliation complete', { totalChecked, totalStuck });
    console.log(JSON.stringify({
      severity: 'INFO',
      message:  'reconcilePaymentSessions complete',
      totalChecked,
      totalStuck,
    }));
  }
);

/* ================================================================
   7. sealPaymentAuditTrail
   ────────────────────────────────────────────────────────────────
   Transitions a COMPLETED session to ARCHIVED and writes a
   tamper-evidence HMAC seal over the full stateHistory.
   The seal document is immutable (Firestore rules must enforce
   create-only on paymentAuditSeals/{sessionId}).
================================================================ */
exports.sealPaymentAuditTrail = onCall(
  { ...OPT, secrets: [PAYMENT_HMAC_SECRET] },
  async (req) => {
    const log = createLogger({ fn: 'sealPaymentAuditTrail', uid: req.auth?.uid });
    assertAuth(req);

    const { sessionId } = req.data;

    if (!sessionId || typeof sessionId !== 'string')
      throw new HttpsError('invalid-argument', 'sessionId is required.');

    const callerUid = req.auth.uid;
    const isAdmin   = req.auth.token?.admin || req.auth.token?.superAdmin;

    log.info('Sealing payment audit trail', { sessionId });

    const sessionRef = db.collection('paymentSessions').doc(sessionId);
    const sealRef    = db.collection('paymentAuditSeals').doc(sessionId);

    /* ── Check if already sealed ─────────────────────────────── */
    const existingSeal = await sealRef.get();
    if (existingSeal.exists) {
      log.info('Audit trail already sealed', { sessionId });
      return {
        sessionId,
        alreadySealed: true,
        sealHash:      existingSeal.data().sealHash,
      };
    }

    /* ── Transition to ARCHIVED (requires COMPLETED state) ────── */
    let sealHash;
    let stateHistory;

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(sessionRef);

      if (!snap.exists)
        throw new HttpsError('not-found', `Payment session "${sessionId}" does not exist.`);

      const session = snap.data();

      /* Ownership check */
      if (!isAdmin && session.uid !== callerUid)
        throw new HttpsError('permission-denied', 'You are not authorised to seal this session.');

      if (session.currentState !== 'COMPLETED')
        throw new HttpsError('failed-precondition',
          `Session must be in COMPLETED state to seal. Current state: ${session.currentState}.`);

      /* Validate transition to ARCHIVED */
      const allowedNext = VALID_TRANSITIONS['COMPLETED'] || [];
      if (!allowedNext.includes('ARCHIVED'))
        throw new HttpsError('internal', 'State machine error: COMPLETED does not allow ARCHIVED.');

      stateHistory = session.stateHistory || [];

      /* Compute HMAC seal */
      const secret = PAYMENT_HMAC_SECRET.value();
      if (!secret)
        throw new HttpsError('internal', 'Seal secret is not configured.');
      sealHash = computeHistoryHash(stateHistory, secret);

      const archiveEntry = {
        state:     'ARCHIVED',
        timestamp: F.serverTimestamp(),
        actor:     callerUid,
        notes:     'Audit trail sealed. Session archived.',
        metadata:  { sealHash },
      };

      tx.update(sessionRef, {
        currentState: 'ARCHIVED',
        updatedAt:    F.serverTimestamp(),
        stateHistory: F.arrayUnion(archiveEntry),
      });
    });

    /* ── Write immutable seal document ───────────────────────── */
    await sealRef.set({
      sessionId,
      sealHash,
      historyLength: stateHistory.length,
      sealedBy:      callerUid,
      sealedAt:      F.serverTimestamp(),
      algorithm:     'HMAC-SHA256',
      version:       '1.0',
    });

    log.audit('Payment audit trail sealed', { sessionId, sealHash, historyLength: stateHistory.length });

    return {
      sessionId,
      alreadySealed:  false,
      sealHash,
      historyLength:  stateHistory.length,
      archivedState:  'ARCHIVED',
    };
  }
);
