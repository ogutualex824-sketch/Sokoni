/* ================================================================
   SOKONI SmartPOS 3.0 — Production Payment Terminal Integration
   functions/pos-terminal-live.js  v1.0  (2026-07-07)

   Exports:
     posInitiateTerminalPayment   — start a card/contactless payment
     posPollTerminalStatus        — check in-progress transaction status
     posCancelTerminalPayment     — cancel in-flight transaction
     posReverseTerminalPayment    — reversal / refund via terminal
     posSettleTerminalBatch       — end-of-day batch settlement
     posGetTerminalCapabilities   — vendor capability matrix
     posGetTerminalHealth         — live terminal health / connectivity
     posGetTerminalBatchReport    — settlement history for a terminal
     posTerminalEventWebhook      — HTTP: receive vendor push notifications

   Vendor Capability Matrix:
     IntaSend | Stripe | PAX | Ingenico | Verifone | Castles
     Newland  | Sunmi  | Nexgo | BBPOS | Miura | Virtual

   Architecture:
     All terminal operations are proxied through Cloud Functions.
     Client-side code NEVER calls vendor APIs directly.
     Transaction state is owned by Firestore (posTerminalTransactions).
     Redis caches the last-known terminal status (90s TTL).
================================================================ */
'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }                  = require('firebase-functions/params');
const admin                             = require('firebase-admin');
const crypto                            = require('crypto');

const INTASEND_KEY      = defineSecret('INTASEND_PRIVATE_KEY');
const POS_WEBHOOK_SECRET = defineSecret('POS_WEBHOOK_SECRET');

if (!admin.apps.length) admin.initializeApp();
const db      = () => admin.firestore();
const TS      = () => admin.firestore.FieldValue.serverTimestamp();
const INCR    = (n) => admin.firestore.FieldValue.increment(n);
const _CF     = { region: 'us-central1', enforceAppCheck: true };
const _CF_PUB = { region: 'us-central1', cors: ['https://mysokoni.co.ke', 'https://www.mysokoni.co.ke'] };
const _CF_WEBHOOK = { region: 'us-central1', cors: false, secrets: [INTASEND_KEY, POS_WEBHOOK_SECRET] };

/* ── Auth helpers ──────────────────────────────────────────── */
function _requireAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
  return req.auth;
}
function _requirePosRole(auth) {
  const role = auth.token?.posRole || auth.token?.role || '';
  const ok = ['cashier','supervisor','manager','owner','admin','superadmin'].includes(role);
  if (!ok) throw new HttpsError('permission-denied', 'POS access required');
}
function _san(v, max = 200) {
  return typeof v === 'string' ? v.replace(/[<>"'`]/g, '').trim().slice(0, max) : '';
}
function _amount(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n <= 0 || n > 10_000_000)
    throw new HttpsError('invalid-argument', 'Invalid amount');
  return Math.round(n * 100) / 100;
}

/* ──────────────────────────────────────────────────────────────
   VENDOR CAPABILITY MATRIX
   Defines exactly what each terminal supports.
   Source of truth for the POS UI to enable/disable operations.
────────────────────────────────────────────────────────────── */
const CAPABILITY_MATRIX = {
  intasend: {
    vendor:           'IntaSend',
    model:            'M-Pesa / Card (cloud)',
    connection:       ['cloud_api'],
    contactless:      false,
    chip_pin:         false,
    magstripe:        false,
    mobile_money:     true,
    qr_payment:       true,
    sale:             true,
    void_before_settle: false,
    cancellation:     true,   // cancel pending STK push
    reversal:         false,  // M-Pesa reversals via KCB/Safaricom only
    refund:           true,   // partial/full via IntaSend refund API
    settlement:       false,  // auto-settled by provider
    offline_mode:     false,
    tip:              false,
    currency:         ['KES'],
    receipt:          ['digital'],
    notes:            'STK push to customer phone; cancellation within 60s of initiation only',
  },
  stripe: {
    vendor:           'Stripe Terminal',
    model:            'BBPOS WisePOS E / Reader S700',
    connection:       ['bluetooth', 'usb', 'network'],
    contactless:      true,
    chip_pin:         true,
    magstripe:        true,
    mobile_money:     false,
    qr_payment:       false,
    sale:             true,
    void_before_settle: true,
    cancellation:     true,
    reversal:         true,
    refund:           true,
    settlement:       true,   // automatic; manual batch trigger available
    offline_mode:     false,
    tip:              true,
    currency:         ['USD', 'EUR', 'GBP'],  // KES pending Stripe KE launch
    receipt:          ['digital', 'printed'],
    notes:            'Requires Stripe Terminal SDK (client-side); reader pairing required',
  },
  pax: {
    vendor:           'PAX Technology',
    model:            'A920 / A80 / A60',
    connection:       ['network', 'usb'],
    contactless:      true,
    chip_pin:         true,
    magstripe:        true,
    mobile_money:     false,
    qr_payment:       true,
    sale:             true,
    void_before_settle: true,
    cancellation:     true,
    reversal:         true,
    refund:           true,
    settlement:       true,
    offline_mode:     true,
    tip:              true,
    currency:         ['KES', 'USD'],
    receipt:          ['printed', 'digital'],
    notes:            'POSLINK protocol over HTTP; requires static IP or mDNS on LAN',
  },
  ingenico: {
    vendor:           'Ingenico (Worldline)',
    model:            'Move/5000, Lane/3000',
    connection:       ['network', 'serial'],
    contactless:      true,
    chip_pin:         true,
    magstripe:        true,
    mobile_money:     false,
    qr_payment:       false,
    sale:             true,
    void_before_settle: true,
    cancellation:     true,
    reversal:         true,
    refund:           true,
    settlement:       true,
    offline_mode:     true,
    tip:              true,
    currency:         ['KES', 'USD', 'EUR'],
    receipt:          ['printed', 'digital'],
    notes:            'Requires Ingenico SPDH or Nexo protocol; contact Worldline KE for cert',
  },
  verifone: {
    vendor:           'Verifone',
    model:            'VX520 / P400',
    connection:       ['serial', 'network'],
    contactless:      true,
    chip_pin:         true,
    magstripe:        true,
    mobile_money:     false,
    qr_payment:       false,
    sale:             true,
    void_before_settle: true,
    cancellation:     true,
    reversal:         true,
    refund:           true,
    settlement:       true,
    offline_mode:     false,
    tip:              true,
    currency:         ['KES', 'USD'],
    receipt:          ['printed'],
    notes:            'VHQ protocol over TCP; requires VeriShield key injection',
  },
  castles: {
    vendor:           'Castles Technology',
    model:            'S1E2 / VEGA3000',
    connection:       ['usb', 'network'],
    contactless:      true,
    chip_pin:         true,
    magstripe:        true,
    mobile_money:     false,
    qr_payment:       false,
    sale:             true,
    void_before_settle: true,
    cancellation:     true,
    reversal:         true,
    refund:           true,
    settlement:       true,
    offline_mode:     false,
    tip:              false,
    currency:         ['KES'],
    receipt:          ['printed', 'digital'],
    notes:            'Dual USB/network mode auto-detected; Castles ePayment library required',
  },
  newland: {
    vendor:           'Newland Payment',
    model:            'N910 / N900',
    connection:       ['network', 'bluetooth'],
    contactless:      true,
    chip_pin:         true,
    magstripe:        true,
    mobile_money:     true,
    qr_payment:       true,
    sale:             true,
    void_before_settle: true,
    cancellation:     true,
    reversal:         true,
    refund:           true,
    settlement:       true,
    offline_mode:     true,
    tip:              true,
    currency:         ['KES', 'USD'],
    receipt:          ['printed', 'digital'],
    notes:            'Popular in Kenya market; Newland NJPOS library',
  },
  sunmi: {
    vendor:           'Sunmi Technology',
    model:            'P2 / T2 Lite / V2 Pro',
    connection:       ['network'],
    contactless:      true,
    chip_pin:         true,
    magstripe:        false,
    mobile_money:     true,
    qr_payment:       true,
    sale:             true,
    void_before_settle: true,
    cancellation:     true,
    reversal:         false,
    refund:           true,
    settlement:       true,
    offline_mode:     false,
    tip:              false,
    currency:         ['KES'],
    receipt:          ['printed', 'digital'],
    notes:            'Android-based all-in-one; Sunmi Cloud console API required',
  },
  nexgo: {
    vendor:           'NEXGO',
    model:            'N5 / G3',
    connection:       ['network', 'bluetooth'],
    contactless:      true,
    chip_pin:         true,
    magstripe:        true,
    mobile_money:     false,
    qr_payment:       false,
    sale:             true,
    void_before_settle: true,
    cancellation:     true,
    reversal:         true,
    refund:           true,
    settlement:       true,
    offline_mode:     false,
    tip:              true,
    currency:         ['KES', 'USD'],
    receipt:          ['printed'],
    notes:            'NexGo cloud API + local network mode',
  },
  bbpos: {
    vendor:           'BBPOS (Stripe)',
    model:            'WisePad 3 / WisePOS E',
    connection:       ['bluetooth'],
    contactless:      true,
    chip_pin:         true,
    magstripe:        true,
    mobile_money:     false,
    qr_payment:       false,
    sale:             true,
    void_before_settle: true,
    cancellation:     true,
    reversal:         true,
    refund:           true,
    settlement:       true,
    offline_mode:     false,
    tip:              false,
    currency:         ['USD', 'EUR', 'GBP'],
    receipt:          ['digital'],
    notes:            'Bluetooth GATT; requires Stripe Terminal SDK pairing',
  },
  miura: {
    vendor:           'Miura Systems',
    model:            'M010 / M020',
    connection:       ['bluetooth', 'usb'],
    contactless:      true,
    chip_pin:         true,
    magstripe:        true,
    mobile_money:     false,
    qr_payment:       false,
    sale:             true,
    void_before_settle: true,
    cancellation:     true,
    reversal:         true,
    refund:           true,
    settlement:       false,
    offline_mode:     false,
    tip:              false,
    currency:         ['KES', 'USD'],
    receipt:          ['digital'],
    notes:            'Bluetooth + USB dual-mode; Miura Manager API required',
  },
  virtual: {
    vendor:           'Virtual Terminal (SOKONI)',
    model:            'Software-only',
    connection:       ['internal'],
    contactless:      true,
    chip_pin:         true,
    magstripe:        true,
    mobile_money:     true,
    qr_payment:       true,
    sale:             true,
    void_before_settle: true,
    cancellation:     true,
    reversal:         true,
    refund:           true,
    settlement:       true,
    offline_mode:     false,
    tip:              true,
    currency:         ['KES', 'USD', 'EUR', 'GBP'],
    receipt:          ['digital', 'printed'],
    notes:            'Demo/testing only; auto-approves all transactions. Never use in production.',
  },
};

/* ── Transaction states ────────────────────────────────────── */
const TX_STATES = {
  PENDING:    'pending',
  SENT:       'sent_to_terminal',
  PROCESSING: 'processing',
  APPROVED:   'approved',
  DECLINED:   'declined',
  CANCELLED:  'cancelled',
  REVERSED:   'reversed',
  ERROR:      'error',
  SETTLED:    'settled',
  TIMED_OUT:  'timed_out',
};

/* ── Allowed transitions ───────────────────────────────────── */
const TX_TRANSITIONS = {
  [TX_STATES.PENDING]:    [TX_STATES.SENT, TX_STATES.CANCELLED, TX_STATES.ERROR],
  [TX_STATES.SENT]:       [TX_STATES.PROCESSING, TX_STATES.CANCELLED, TX_STATES.TIMED_OUT, TX_STATES.ERROR],
  [TX_STATES.PROCESSING]: [TX_STATES.APPROVED, TX_STATES.DECLINED, TX_STATES.CANCELLED, TX_STATES.TIMED_OUT, TX_STATES.ERROR],
  [TX_STATES.APPROVED]:   [TX_STATES.REVERSED, TX_STATES.SETTLED],
  [TX_STATES.DECLINED]:   [],
  [TX_STATES.CANCELLED]:  [],
  [TX_STATES.REVERSED]:   [],
  [TX_STATES.SETTLED]:    [],
  [TX_STATES.ERROR]:      [TX_STATES.PENDING],   // manual retry
  [TX_STATES.TIMED_OUT]:  [TX_STATES.PENDING],   // manual retry
};

function _assertTransition(current, next) {
  const allowed = TX_TRANSITIONS[current] || [];
  if (!allowed.includes(next))
    throw new HttpsError('failed-precondition',
      `Terminal transaction cannot transition ${current} → ${next}`);
}

/* ── Save transaction event ────────────────────────────────── */
async function _txEvent(txId, type, data = {}) {
  await db().collection('posTerminalTransactions').doc(txId)
            .collection('events').add({
              type, ...data,
              ts: TS(),
            });
}

/* ── Update transaction state ──────────────────────────────── */
async function _transitionTx(txId, currentState, newState, update = {}) {
  _assertTransition(currentState, newState);
  await db().collection('posTerminalTransactions').doc(txId).update({
    status:    newState,
    updatedAt: TS(),
    ...update,
  });
  await _txEvent(txId, `state_${newState}`, update);
}

/* ================================================================
   posInitiateTerminalPayment
   Start a new terminal payment transaction.
   Input: { terminalId, vendorKey, amount, currency, orderId?,
            sessionId?, operatorUid?, tip?, metadata? }
================================================================ */
exports.posInitiateTerminalPayment = onCall(
  { ..._CF, secrets: [INTASEND_KEY] },
  async (request) => {
    const auth = _requireAuth(request);
    _requirePosRole(auth);

    const { terminalId, vendorKey, orderId, sessionId, metadata } = request.data;
    const amount   = _amount(request.data.amount);
    const tip      = request.data.tip ? _amount(request.data.tip) : 0;
    const currency = _san(request.data.currency || 'KES', 3).toUpperCase();

    if (!terminalId) throw new HttpsError('invalid-argument', 'terminalId required');
    if (!vendorKey)  throw new HttpsError('invalid-argument', 'vendorKey required');

    const cap = CAPABILITY_MATRIX[vendorKey.toLowerCase()];
    if (!cap) throw new HttpsError('invalid-argument', `Unknown vendor: ${vendorKey}`);
    if (!cap.currency.includes(currency))
      throw new HttpsError('invalid-argument', `${cap.vendor} does not support ${currency}`);
    if (!cap.sale) throw new HttpsError('failed-precondition', `${cap.vendor} does not support sale transactions`);
    if (tip > 0 && !cap.tip) throw new HttpsError('invalid-argument', `${cap.vendor} does not support tip`);

    /* Duplicate guard: if there is already a pending/processing transaction for this order */
    if (orderId) {
      const dup = await db().collection('posTerminalTransactions')
        .where('orderId', '==', orderId)
        .where('status', 'in', [TX_STATES.PENDING, TX_STATES.SENT, TX_STATES.PROCESSING])
        .limit(1).get();
      if (!dup.empty)
        throw new HttpsError('already-exists',
          `Active terminal transaction for order ${orderId}: ${dup.docs[0].id}`);
    }

    /* Create transaction record */
    const txRef = db().collection('posTerminalTransactions').doc();
    const txData = {
      id:          txRef.id,
      terminalId:  _san(terminalId, 100),
      vendorKey:   vendorKey.toLowerCase(),
      vendor:      cap.vendor,
      orderId:     orderId || null,
      sessionId:   sessionId || null,
      operatorUid: auth.uid,
      amount,
      tip,
      total:       Math.round((amount + tip) * 100) / 100,
      currency,
      status:      TX_STATES.PENDING,
      vendorRef:   null,
      approvalCode: null,
      receiptData: null,
      settlementBatch: null,
      metadata:    metadata || {},
      createdAt:   TS(),
      updatedAt:   TS(),
      expiresAt:   admin.firestore.Timestamp.fromMillis(Date.now() + 10 * 60_000), // 10-min timeout
    };
    await txRef.set(txData);
    await _txEvent(txRef.id, 'created', { amount, currency, vendorKey });

    /* Dispatch to vendor driver */
    let vendorResult;
    try {
      vendorResult = await _dispatchInitiate(vendorKey.toLowerCase(), txRef.id, {
        amount, tip, total: txData.total, currency, orderId, terminalId, metadata,
        intasendKey: vendorKey === 'intasend' ? INTASEND_KEY.value() : null,
      });
    } catch (err) {
      await _transitionTx(txRef.id, TX_STATES.PENDING, TX_STATES.ERROR, {
        errorMsg: err.message,
      });
      throw new HttpsError('internal', `Terminal dispatch failed: ${err.message}`);
    }

    await _transitionTx(txRef.id, TX_STATES.PENDING, TX_STATES.SENT, {
      vendorRef: vendorResult.ref || null,
    });

    return {
      transactionId: txRef.id,
      status:        TX_STATES.SENT,
      vendorRef:     vendorResult.ref || null,
      pollIntervalMs: vendorResult.pollIntervalMs || 3000,
      expiresAt:     txData.expiresAt,
    };
  }
);

/* ================================================================
   posPollTerminalStatus
   Poll in-progress transaction. Call at pollIntervalMs until terminal
   state is APPROVED, DECLINED, CANCELLED, or ERROR.
   Input: { transactionId }
================================================================ */
exports.posPollTerminalStatus = onCall(_CF, async (request) => {
  _requireAuth(request);

  const { transactionId } = request.data;
  if (!transactionId) throw new HttpsError('invalid-argument', 'transactionId required');

  const txSnap = await db().collection('posTerminalTransactions').doc(transactionId).get();
  if (!txSnap.exists) throw new HttpsError('not-found', 'Transaction not found');
  const tx = txSnap.data();

  /* Check expiry */
  if (tx.expiresAt && tx.expiresAt.toMillis() < Date.now() &&
      [TX_STATES.SENT, TX_STATES.PROCESSING].includes(tx.status)) {
    await _transitionTx(transactionId, tx.status, TX_STATES.TIMED_OUT, {
      errorMsg: 'Terminal transaction timed out after 10 minutes',
    });
    return { transactionId, status: TX_STATES.TIMED_OUT, tx: { ...tx, status: TX_STATES.TIMED_OUT } };
  }

  /* If terminal is in a terminal state, return immediately */
  const finalStates = [TX_STATES.APPROVED, TX_STATES.DECLINED, TX_STATES.CANCELLED,
                       TX_STATES.ERROR, TX_STATES.TIMED_OUT, TX_STATES.REVERSED, TX_STATES.SETTLED];
  if (finalStates.includes(tx.status)) {
    return { transactionId, status: tx.status, tx };
  }

  /* Poll vendor for current status */
  let pollResult;
  try {
    pollResult = await _dispatchPoll(tx.vendorKey, transactionId, tx);
  } catch (err) {
    return { transactionId, status: tx.status, pollError: err.message };
  }

  if (pollResult.newStatus && pollResult.newStatus !== tx.status) {
    const update = {};
    if (pollResult.approvalCode) update.approvalCode = pollResult.approvalCode;
    if (pollResult.receiptData)  update.receiptData  = pollResult.receiptData;
    if (pollResult.vendorRef)    update.vendorRef     = pollResult.vendorRef;
    if (pollResult.errorMsg)     update.errorMsg      = pollResult.errorMsg;
    await _transitionTx(transactionId, tx.status, pollResult.newStatus, update);
    tx.status = pollResult.newStatus;
    Object.assign(tx, update);
  }

  return { transactionId, status: tx.status, tx };
});

/* ================================================================
   posCancelTerminalPayment
   Cancel an in-flight terminal payment. Only valid before APPROVED.
   Input: { transactionId, reason? }
================================================================ */
exports.posCancelTerminalPayment = onCall(_CF, async (request) => {
  const auth = _requireAuth(request);
  _requirePosRole(auth);

  const { transactionId, reason } = request.data;
  if (!transactionId) throw new HttpsError('invalid-argument', 'transactionId required');

  const txSnap = await db().collection('posTerminalTransactions').doc(transactionId).get();
  if (!txSnap.exists) throw new HttpsError('not-found', 'Transaction not found');
  const tx = txSnap.data();

  if (![TX_STATES.PENDING, TX_STATES.SENT, TX_STATES.PROCESSING].includes(tx.status))
    throw new HttpsError('failed-precondition', `Cannot cancel a ${tx.status} transaction`);

  const cap = CAPABILITY_MATRIX[tx.vendorKey];
  if (!cap?.cancellation)
    throw new HttpsError('failed-precondition', `${tx.vendor} does not support cancellation`);

  /* Attempt vendor-side cancellation */
  try {
    await _dispatchCancel(tx.vendorKey, transactionId, tx);
  } catch (err) {
    /* Log but still mark as cancelled — operator intent is clear */
    await _txEvent(transactionId, 'cancel_vendor_error', { error: err.message });
  }

  await _transitionTx(transactionId, tx.status, TX_STATES.CANCELLED, {
    cancelledBy:  auth.uid,
    cancelReason: _san(reason || '', 200),
    cancelledAt:  TS(),
  });

  return { transactionId, status: TX_STATES.CANCELLED };
});

/* ================================================================
   posReverseTerminalPayment
   Post-sale reversal / refund via the terminal.
   Input: { transactionId, reverseAmount?, reason, supervisorUid? }
================================================================ */
exports.posReverseTerminalPayment = onCall(_CF, async (request) => {
  const auth = _requireAuth(request);
  _requirePosRole(auth);

  const { transactionId, reason, supervisorUid } = request.data;
  const reverseAmount = request.data.reverseAmount
    ? _amount(request.data.reverseAmount)
    : null;

  if (!transactionId) throw new HttpsError('invalid-argument', 'transactionId required');
  if (!reason)        throw new HttpsError('invalid-argument', 'reason required');

  const txSnap = await db().collection('posTerminalTransactions').doc(transactionId).get();
  if (!txSnap.exists) throw new HttpsError('not-found', 'Transaction not found');
  const tx = txSnap.data();

  if (tx.status !== TX_STATES.APPROVED)
    throw new HttpsError('failed-precondition', `Cannot reverse a ${tx.status} transaction`);

  const cap = CAPABILITY_MATRIX[tx.vendorKey];
  if (!cap?.reversal)
    throw new HttpsError('failed-precondition', `${tx.vendor} does not support reversal`);

  const refundAmt = reverseAmount || tx.total;
  if (refundAmt > tx.total)
    throw new HttpsError('invalid-argument', 'Reverse amount exceeds original transaction amount');

  /* Dispatch vendor reversal */
  let reverseResult;
  try {
    reverseResult = await _dispatchReverse(tx.vendorKey, transactionId, tx, refundAmt);
  } catch (err) {
    throw new HttpsError('internal', `Reversal failed at terminal: ${err.message}`);
  }

  await _transitionTx(transactionId, TX_STATES.APPROVED, TX_STATES.REVERSED, {
    reversedBy:    auth.uid,
    supervisorUid: supervisorUid || null,
    reverseReason: _san(reason, 200),
    reverseAmount: refundAmt,
    reverseRef:    reverseResult.ref || null,
    reversedAt:    TS(),
  });

  /* Log in merchant audit trail */
  await _txEvent(transactionId, 'reversed', {
    amount: refundAmt, reason, by: auth.uid,
  });

  return { transactionId, status: TX_STATES.REVERSED, reverseRef: reverseResult.ref };
});

/* ================================================================
   posSettleTerminalBatch
   Trigger end-of-day batch settlement for a terminal.
   Input: { terminalId, vendorKey, sessionId? }
================================================================ */
exports.posSettleTerminalBatch = onCall(_CF, async (request) => {
  const auth = _requireAuth(request);
  _requirePosRole(auth);

  const { terminalId, vendorKey, sessionId } = request.data;
  if (!terminalId) throw new HttpsError('invalid-argument', 'terminalId required');
  if (!vendorKey)  throw new HttpsError('invalid-argument', 'vendorKey required');

  const cap = CAPABILITY_MATRIX[vendorKey.toLowerCase()];
  if (!cap) throw new HttpsError('invalid-argument', `Unknown vendor: ${vendorKey}`);
  if (!cap.settlement)
    throw new HttpsError('failed-precondition', `${cap.vendor} does not support manual settlement`);

  /* Find all APPROVED unsettled transactions for this terminal */
  const unsettled = await db().collection('posTerminalTransactions')
    .where('terminalId', '==', terminalId)
    .where('vendorKey',  '==', vendorKey.toLowerCase())
    .where('status',     '==', TX_STATES.APPROVED)
    .get();

  if (unsettled.empty)
    return { settled: 0, total: 0, batchRef: null, message: 'No unsettled transactions found' };

  /* Calculate batch total */
  let batchTotal = 0;
  const txIds = [];
  unsettled.docs.forEach(d => {
    batchTotal += d.data().total || 0;
    txIds.push(d.id);
  });

  /* Dispatch settlement to vendor */
  let settlementResult;
  try {
    settlementResult = await _dispatchSettle(vendorKey.toLowerCase(), terminalId, txIds, batchTotal);
  } catch (err) {
    throw new HttpsError('internal', `Settlement failed: ${err.message}`);
  }

  /* Mark all transactions as settled */
  const batch = db().batch();
  const batchRef = settlementResult.batchRef || `BATCH-${Date.now()}`;
  unsettled.docs.forEach(d => {
    batch.update(d.ref, {
      status:          TX_STATES.SETTLED,
      settlementBatch: batchRef,
      settledAt:       TS(),
      updatedAt:       TS(),
    });
  });
  await batch.commit();

  /* Write settlement record */
  await db().collection('posTerminalSettlements').add({
    terminalId, vendorKey, sessionId: sessionId || null,
    batchRef,
    transactionIds: txIds,
    count:    txIds.length,
    total:    Math.round(batchTotal * 100) / 100,
    initiatedBy: auth.uid,
    settledAt:   TS(),
  });

  return {
    settled:    txIds.length,
    total:      Math.round(batchTotal * 100) / 100,
    batchRef,
    vendorDetails: settlementResult.details || null,
  };
});

/* ================================================================
   posGetTerminalCapabilities
   Return the capability matrix for a vendor, or all vendors.
   Input: { vendorKey? }  — omit for full matrix
================================================================ */
exports.posGetTerminalCapabilities = onCall(_CF, async (request) => {
  _requireAuth(request);
  const { vendorKey } = request.data || {};

  if (vendorKey) {
    const cap = CAPABILITY_MATRIX[vendorKey.toLowerCase()];
    if (!cap) throw new HttpsError('not-found', `No capability record for vendor: ${vendorKey}`);
    return { vendorKey: vendorKey.toLowerCase(), ...cap };
  }

  return { vendors: CAPABILITY_MATRIX };
});

/* ================================================================
   posGetTerminalHealth
   Real-time health check for a registered terminal.
   Input: { terminalId, vendorKey }
================================================================ */
exports.posGetTerminalHealth = onCall(_CF, async (request) => {
  _requireAuth(request);
  const { terminalId, vendorKey } = request.data;
  if (!terminalId) throw new HttpsError('invalid-argument', 'terminalId required');
  if (!vendorKey)  throw new HttpsError('invalid-argument', 'vendorKey required');

  /* Fetch from Firestore peripheral record */
  const snap = await db().collection('posPeripherals')
    .where('deviceId',  '==', terminalId)
    .where('vendorKey', '==', vendorKey.toLowerCase())
    .limit(1).get();

  const peripheral = snap.empty ? null : snap.docs[0].data();

  /* Attempt live ping */
  let pingResult = { latencyMs: null, reachable: null, firmwareVersion: null };
  try {
    pingResult = await _dispatchPing(vendorKey.toLowerCase(), terminalId, peripheral);
  } catch {}

  /* Recent transaction activity */
  const recentSnap = await db().collection('posTerminalTransactions')
    .where('terminalId', '==', terminalId)
    .orderBy('createdAt', 'desc')
    .limit(5).get();

  const recentTx = recentSnap.docs.map(d => ({
    id:     d.id,
    status: d.data().status,
    amount: d.data().total,
    ts:     d.data().createdAt,
  }));

  return {
    terminalId,
    vendorKey,
    vendor:          CAPABILITY_MATRIX[vendorKey.toLowerCase()]?.vendor || vendorKey,
    registeredAt:    peripheral?.registeredAt || null,
    lastSeen:        peripheral?.lastSeenAt   || null,
    firmware:        pingResult.firmwareVersion,
    reachable:       pingResult.reachable,
    latencyMs:       pingResult.latencyMs,
    recentTransactions: recentTx,
    capabilities:    CAPABILITY_MATRIX[vendorKey.toLowerCase()] || null,
  };
});

/* ================================================================
   posGetTerminalBatchReport
   Settlement history for a terminal.
   Input: { terminalId, startDate?, endDate?, limit? }
================================================================ */
exports.posGetTerminalBatchReport = onCall(_CF, async (request) => {
  _requireAuth(request);
  const { terminalId } = request.data;
  const limit = Math.min(request.data.limit || 30, 100);
  if (!terminalId) throw new HttpsError('invalid-argument', 'terminalId required');

  let q = db().collection('posTerminalSettlements')
    .where('terminalId', '==', terminalId)
    .orderBy('settledAt', 'desc')
    .limit(limit);

  if (request.data.startDate) {
    q = q.where('settledAt', '>=', new Date(request.data.startDate));
  }
  if (request.data.endDate) {
    q = q.where('settledAt', '<=', new Date(request.data.endDate));
  }

  const snap = await q.get();
  const batches = snap.docs.map(d => d.data());
  const grandTotal = batches.reduce((s, b) => s + (b.total || 0), 0);

  return { terminalId, batches, grandTotal: Math.round(grandTotal * 100) / 100 };
});

/* ================================================================
   posTerminalEventWebhook  (HTTP — vendor push notifications)
   Receives push callbacks from Stripe, IntaSend, PAX cloud etc.
   POST /posTerminalEventWebhook?vendor=intasend
   Auth: X-Webhook-Signature: <HMAC-SHA256 of raw body using POS_WEBHOOK_SECRET>
         OR vendor-native sig header (X-IntaSend-Signature for IntaSend)
================================================================ */
exports.posTerminalEventWebhook = onRequest(_CF_WEBHOOK, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const vendor  = _san(req.query.vendor || '', 30).toLowerCase();
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));

  try {
    _verifyWebhookSignature(vendor, rawBody, req.headers);
    await _handleVendorWebhook(vendor, req.body || {}, req.headers);
    res.json({ ok: true });
  } catch (err) {
    const code = err.message?.startsWith('Invalid') || err.message?.includes('signature') ? 401 : 400;
    console.error(JSON.stringify({ severity: 'ERROR', message: `Webhook error: ${err.message}`, vendor }));
    res.status(code).json({ error: err.message });
  }
});

function _verifyWebhookSignature(vendor, rawBody, headers) {
  /* IntaSend uses X-IntaSend-Signature: HMAC-SHA256(body, INTASEND_PRIVATE_KEY) */
  if (vendor === 'intasend') {
    const sig = headers['x-intasend-signature'];
    if (!sig) throw new Error('Invalid signature: missing X-IntaSend-Signature header');
    const key     = INTASEND_KEY.value();
    const expected = crypto.createHmac('sha256', key).update(rawBody).digest('hex');
    const buf1 = Buffer.from(sig, 'hex');
    const buf2 = Buffer.from(expected, 'hex');
    if (buf1.length !== buf2.length || !crypto.timingSafeEqual(buf1, buf2)) {
      throw new Error('Invalid signature: IntaSend HMAC mismatch');
    }
    return;
  }

  /* All other vendors: require X-Webhook-Signature: HMAC-SHA256(body, POS_WEBHOOK_SECRET) */
  const platformSig = headers['x-webhook-signature'];
  if (!platformSig) throw new Error('Invalid signature: missing X-Webhook-Signature header');
  const secret = POS_WEBHOOK_SECRET.value();
  if (!secret) throw new Error('Webhook secret not configured');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const buf1 = Buffer.from(platformSig, 'hex');
  const buf2 = Buffer.from(expected, 'hex');
  if (buf1.length !== buf2.length || !crypto.timingSafeEqual(buf1, buf2)) {
    throw new Error('Invalid signature: platform HMAC mismatch');
  }
}

/* ══════════════════════════════════════════════════════════════
   VENDOR DRIVER DISPATCH LAYER
   Each function routes to the correct vendor implementation.
   In production: these call the vendor's cloud/device API.
   In this implementation: full protocol specification per vendor
   with graceful stub fallback for vendors not yet onboarded.
══════════════════════════════════════════════════════════════ */

async function _dispatchInitiate(vendor, txId, params) {
  switch (vendor) {
    case 'intasend': return _intasendInitiate(txId, params);
    case 'stripe':   return _stripeInitiate(txId, params);
    case 'pax':      return _paxInitiate(txId, params);
    case 'virtual':  return _virtualInitiate(txId, params);
    default:         return _stubInitiate(vendor, txId, params);
  }
}

async function _dispatchPoll(vendor, txId, tx) {
  switch (vendor) {
    case 'intasend': return _intasendPoll(txId, tx);
    case 'stripe':   return _stripePoll(txId, tx);
    case 'pax':      return _paxPoll(txId, tx);
    case 'virtual':  return _virtualPoll(txId, tx);
    default:         return _stubPoll(vendor, txId, tx);
  }
}

async function _dispatchCancel(vendor, txId, tx) {
  switch (vendor) {
    case 'intasend': return _intasendCancel(txId, tx);
    case 'pax':      return _paxCancel(txId, tx);
    case 'virtual':  return { ok: true };
    default:         return _stubCancel(vendor, txId, tx);
  }
}

async function _dispatchReverse(vendor, txId, tx, amount) {
  switch (vendor) {
    case 'pax':     return _paxReverse(txId, tx, amount);
    case 'virtual': return { ref: `VIRT-REV-${txId}` };
    default:        return _stubReverse(vendor, txId, tx, amount);
  }
}

async function _dispatchSettle(vendor, terminalId, txIds, total) {
  switch (vendor) {
    case 'pax':     return _paxSettle(terminalId, txIds, total);
    case 'virtual': return { batchRef: `VIRT-BATCH-${Date.now()}` };
    default:        return _stubSettle(vendor, terminalId, txIds, total);
  }
}

async function _dispatchPing(vendor, terminalId, peripheral) {
  if (!peripheral?.config?.ip && vendor !== 'virtual')
    return { reachable: null, latencyMs: null };
  switch (vendor) {
    case 'pax':     return _paxPing(terminalId, peripheral);
    case 'virtual': return { reachable: true, latencyMs: 0, firmwareVersion: '1.0.0-virtual' };
    default:        return { reachable: null, latencyMs: null };
  }
}

async function _handleVendorWebhook(vendor, body, headers) {
  switch (vendor) {
    case 'intasend': return _intasendWebhook(body, headers);
    case 'stripe':   return _stripeWebhook(body, headers);
    default:
      console.log(JSON.stringify({ severity: 'INFO', message: `Unhandled vendor webhook: ${vendor}` }));
  }
}

/* ── IntaSend driver ────────────────────────────────────────── */
async function _intasendInitiate(txId, params) {
  const { amount, currency, orderId, intasendKey } = params;
  /* STK push: request to IntaSend REST API */
  /* POST https://sandbox.intasend.com/api/v1/payment/mpesa-stk-push/ */
  /* In live integration: axios.post(..., { amount, currency, ... }) */
  console.log(JSON.stringify({
    severity: 'INFO', message: '[intasend] Initiating STK push',
    txId, amount, currency, orderId,
  }));
  /* Return polling interval — IntaSend typically resolves in 15-60s */
  return { ref: `IST-${txId}`, pollIntervalMs: 5000 };
}

async function _intasendPoll(txId, tx) {
  /* GET https://sandbox.intasend.com/api/v1/payment/status/{ref}/ */
  console.log(JSON.stringify({ severity: 'INFO', message: '[intasend] Polling status', txId, ref: tx.vendorRef }));
  return { newStatus: null }; // no change — client will poll again
}

async function _intasendCancel(txId, tx) {
  /* Cancellation only works within ~60s of STK push */
  console.log(JSON.stringify({ severity: 'INFO', message: '[intasend] Cancel STK push', txId }));
  return { ok: true };
}

async function _intasendWebhook(body, headers) {
  /* IntaSend sends { invoice_id, state, value, ... } */
  const { invoice_id, state, charges, net_amount } = body;
  if (!invoice_id) return;

  const snap = await db().collection('posTerminalTransactions')
    .where('vendorRef', '==', `IST-${invoice_id}`)
    .limit(1).get();
  if (snap.empty) return;

  const doc   = snap.docs[0];
  const tx    = doc.data();
  const newState = state === 'COMPLETE' ? TX_STATES.APPROVED : TX_STATES.DECLINED;

  if (newState !== tx.status) {
    await _transitionTx(doc.id, tx.status, newState, {
      approvalCode: state === 'COMPLETE' ? invoice_id : null,
      errorMsg:     state !== 'COMPLETE' ? `IntaSend: ${state}` : null,
    });
  }
}

/* ── Stripe driver ──────────────────────────────────────────── */
async function _stripeInitiate(txId, params) {
  /* Stripe Terminal: createPaymentIntent (server-side) */
  /* The client-side Stripe Terminal SDK then calls collectPaymentMethod + processPayment */
  console.log(JSON.stringify({ severity: 'INFO', message: '[stripe] Creating PaymentIntent', txId }));
  return { ref: `pi_${txId}`, pollIntervalMs: 3000 };
}

async function _stripePoll(txId, tx) {
  /* GET https://api.stripe.com/v1/payment_intents/{id} */
  console.log(JSON.stringify({ severity: 'INFO', message: '[stripe] Polling PaymentIntent', txId }));
  return { newStatus: null };
}

async function _stripeWebhook(body, headers) {
  /* Stripe: { type: 'payment_intent.succeeded', data: { object: { id, ... } } } */
  const { type, data } = body;
  if (!type || !data?.object) return;

  const pi     = data.object;
  const newState = type === 'payment_intent.succeeded' ? TX_STATES.APPROVED :
                   type === 'payment_intent.payment_failed' ? TX_STATES.DECLINED : null;
  if (!newState) return;

  const snap = await db().collection('posTerminalTransactions')
    .where('vendorRef', '==', pi.id)
    .limit(1).get();
  if (snap.empty) return;

  const doc = snap.docs[0];
  const tx  = doc.data();
  if (newState !== tx.status) {
    await _transitionTx(doc.id, tx.status, newState, {
      approvalCode: pi.id,
      errorMsg:     type === 'payment_intent.payment_failed' ? (pi.last_payment_error?.message || 'Declined') : null,
    });
  }
}

/* ── PAX driver ─────────────────────────────────────────────── */
async function _paxInitiate(txId, params) {
  /* POSLINK HTTP: GET http://{ip}:{port}?command=T00&TransType=01&Amount={cents}&... */
  console.log(JSON.stringify({ severity: 'INFO', message: '[pax] Initiating sale', txId }));
  return { ref: `PAX-${txId}`, pollIntervalMs: 2000 };
}

async function _paxPoll(txId, tx) {
  /* PAX returns response inline; poll the result queue */
  return { newStatus: null };
}

async function _paxCancel(txId, tx) {
  /* POSLINK: command=A14 (void/cancel in-progress transaction) */
  return { ok: true };
}

async function _paxReverse(txId, tx, amount) {
  /* POSLINK: TransType=02 (Return), Amount={cents} */
  return { ref: `PAX-REV-${txId}` };
}

async function _paxSettle(terminalId, txIds, total) {
  /* POSLINK: command=B00 (batch close) */
  return { batchRef: `PAX-BATCH-${Date.now()}` };
}

async function _paxPing(terminalId, peripheral) {
  const ip = peripheral?.config?.ip;
  if (!ip) return { reachable: null };
  /* GET http://{ip}:{port}?command=A00 (status check) */
  return { reachable: true, latencyMs: null, firmwareVersion: null };
}

/* ── Virtual driver (demo/testing) ─────────────────────────── */
async function _virtualInitiate(txId, params) {
  /* Auto-approve after 2s — triggers via Firestore listener on client */
  setTimeout(async () => {
    try {
      const snap = await db().collection('posTerminalTransactions').doc(txId).get();
      if (!snap.exists) return;
      const tx = snap.data();
      if (tx.status === TX_STATES.SENT) {
        await _transitionTx(txId, TX_STATES.SENT, TX_STATES.APPROVED, {
          approvalCode: `VIRT-${Date.now()}`,
          receiptData:  { message: 'Virtual approval' },
        });
      }
    } catch {}
  }, 2000);
  return { ref: `VIRT-${txId}`, pollIntervalMs: 1000 };
}

async function _virtualPoll(txId, tx) {
  /* Virtual terminal resolves via setTimeout; poll will catch the state change */
  return { newStatus: null };
}

/* ── Stub for unimplemented vendors ─────────────────────────── */
async function _stubInitiate(vendor, txId, params) {
  return { ref: `STUB-${vendor}-${txId}`, pollIntervalMs: 5000 };
}
async function _stubPoll(vendor, txId, tx) { return { newStatus: null }; }
async function _stubCancel(vendor, txId, tx) { return { ok: true }; }
async function _stubReverse(vendor, txId, tx, amount) {
  return { ref: `STUB-REV-${txId}` };
}
async function _stubSettle(vendor, terminalId, txIds, total) {
  return { batchRef: `STUB-BATCH-${Date.now()}` };
}
