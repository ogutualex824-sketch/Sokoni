'use strict';

/**
 * SOKONI Wallet & Seller Payouts — Cloud Functions
 * Firebase Gen2 / Node.js 22
 *
 * Collections (single-field queries only, no composite indexes):
 *   wallets/{uid}
 *   walletTransactions/{txId}
 *   payoutRequests/{reqId}
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { defineSecret } = require('firebase-functions/params');
const { checkRateLimit } = require('./redis-rate-limiter');   /* HIGH-06 — existing limiter, not a new one */
const { intasendB2C } = require('./finos-utils');             /* reuse the existing B2C helper — no parallel path */

const INTASEND_KEY = defineSecret('INTASEND_PRIVATE_KEY');

/* ─── Automated payout (IntaSend B2C) — helpers ──────────────────────────────
   Controlled rollout: auto-B2C is OFF until config/payouts.autoB2C is set true
   AFTER sandbox reconciliation is proven. While OFF, admin approval is a no-op
   acknowledgement (manual disbursement, unchanged). Never moves real money by
   accident. */
async function _autoB2CEnabled(db) {
  try {
    const c = await db.collection('config').doc('payouts').get();
    return c.exists && c.data().autoB2C === true;
  } catch (_) { return false; }
}

/** Append an immutable status event to a payout request. */
function _payoutEvent(status, detail) {
  return { status, detail: detail || null, at: Timestamp.now() };
}

/** Record a daily payout metric counter (best-effort; never breaks the flow). */
async function _payoutMetric(db, field, incBy = 1, timingMs = null) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const ref = db.collection('payoutMetrics').doc(day);
    const upd = { [field]: FieldValue.increment(incBy), date: day, updatedAt: Timestamp.now() };
    if (timingMs != null) {
      upd.processingMsTotal = FieldValue.increment(timingMs);
      upd.processingSamples = FieldValue.increment(1);
    }
    await ref.set(upd, { merge: true });
  } catch (_) { /* metrics must never break payouts */ }
}

/**
 * Finalize a payout as PAID — release the reserved hold and write the seller's
 * completed payout transaction. Idempotent (deterministic tx id + status guard),
 * so both admin "paid" and the B2C completion webhook can call it safely.
 */
async function _settlePayoutPaid(db, rid, extra = {}) {
  const reqRef = db.collection('payoutRequests').doc(rid);
  /* finalStatus distinguishes the TWO financial events:
       'paid'             — confirmed by the IntaSend webhook (gateway evidence).
       'settled_manually' — an admin attests the money was sent OUT-OF-BAND.
     Both release the reserved hold and write the payout ledger row; they must NEVER
     be conflated in the UI or in reporting. */
  const finalStatus = extra.finalStatus || 'paid';
  let settled = null;   // set to the payout data only when THIS call performs the settlement
  await db.runTransaction(async (t) => {
    const reqSnap = await t.get(reqRef);
    if (!reqSnap.exists) return;
    const payout = reqSnap.data();
    if (['paid', 'settled_manually'].includes(payout.status)) return;   // idempotent
    const walletRef = db.collection('wallets').doc(payout.sellerUid);
    const txRef     = db.collection('walletTransactions').doc(`${payout.sellerUid}_${rid}_payout`);
    const txExisting = await t.get(txRef);
    if (!txExisting.exists) {
      /* Balance was reserved at request time — only release the pending hold. */
      t.update(walletRef, { pendingPayout: FieldValue.increment(-payout.amount) });
      t.set(txRef, {
        uid: payout.sellerUid, type: 'payout', amount: payout.amount,
        description: `Payout via ${finalStatus === 'settled_manually' ? 'MANUAL' : String(payout.method || 'mpesa').toUpperCase()} — ref ${rid}`,
        status: 'completed', settlementType: finalStatus === 'settled_manually' ? 'manual' : 'gateway', createdAt: Timestamp.now(),
      });
    }
    t.update(reqRef, {
      status: finalStatus, processedAt: Timestamp.now(), updatedAt: Timestamp.now(),
      paidAt: Timestamp.now(), confirmedAt: Timestamp.now(),
      settlementMethod: finalStatus === 'settled_manually' ? 'manual' : 'gateway',
      statusHistory: FieldValue.arrayUnion(_payoutEvent(finalStatus, extra.detail || (finalStatus === 'settled_manually' ? 'Settled manually by admin (attested)' : 'Payout confirmed by gateway'))),
      ...(extra.intasendRef ? { intasendRef: extra.intasendRef, gatewayReference: extra.intasendRef } : {}),
      ...(extra.webhookReceivedAt ? { webhookReceivedAt: extra.webhookReceivedAt } : {}),
      ...(extra.processedBy ? { processedBy: extra.processedBy } : {}),
      /* Manual-settlement immutable attestation fields. */
      ...(finalStatus === 'settled_manually' ? {
        settledBy: extra.processedBy || null, settledAt: Timestamp.now(),
        externalReference: extra.externalReference || null,
        attestation: extra.attestation || null,
      } : {}),
    });
    settled = { ...payout, status: finalStatus, intasendRef: extra.intasendRef || payout.intasendRef };
  });
  if (settled) {
    /* Record end-to-end processing latency (request → paid) for analytics. */
    const startMs = settled.createdAt?.toMillis ? settled.createdAt.toMillis() : null;
    if (startMs) await _payoutMetric(db, 'paid', 0, Date.now() - startMs);
    _notifyPayout('paid', settled, rid);
  }
}

/**
 * Refund a reserved (not-yet-disbursed) payout back to available balance and set a
 * terminal status ('rejected' or 'failed'). Idempotent. NEVER call this once B2C has
 * disbursed — money may already have left, so refunding would double-pay.
 */
async function _refundPayout(db, rid, newStatus, extra = {}) {
  const reqRef = db.collection('payoutRequests').doc(rid);
  let refunded = null;
  await db.runTransaction(async (t) => {
    const reqSnap = await t.get(reqRef);
    if (!reqSnap.exists) return;
    const payout = reqSnap.data();
    if (['paid', 'rejected', 'failed'].includes(payout.status)) return;   // terminal — idempotent
    const walletRef = db.collection('wallets').doc(payout.sellerUid);
    t.update(walletRef, {
      balance:       FieldValue.increment(payout.amount),
      pendingPayout: FieldValue.increment(-payout.amount),
    });
    t.update(reqRef, {
      status: newStatus, processedAt: Timestamp.now(), updatedAt: Timestamp.now(),
      statusHistory: FieldValue.arrayUnion(_payoutEvent(newStatus, extra.detail || 'Payout refunded')),
      ...(extra.note ? { note: extra.note } : {}),
      ...(extra.processedBy ? { processedBy: extra.processedBy } : {}),
    });
    refunded = payout;
  });
  /* Notify only when a provider FAILURE returned the funds (not an admin reject). */
  if (refunded && newStatus === 'failed') _notifyPayout('failed', refunded, rid);
}

/**
 * Reverse a payout after an IntaSend REVERSED/chargeback event. If it had settled
 * ('paid'), the money came back → credit balance. If still in-flight, release the
 * reserved hold. Idempotent.
 */
async function _reversePayout(db, rid, detail) {
  const reqRef = db.collection('payoutRequests').doc(rid);
  await db.runTransaction(async (t) => {
    const snap = await t.get(reqRef);
    if (!snap.exists) return;
    const p = snap.data();
    if (p.status === 'reversed') return;   // idempotent
    const walletRef = db.collection('wallets').doc(p.sellerUid);
    if (p.status === 'paid') {
      /* Completed then returned → credit the amount back to available balance. */
      t.update(walletRef, { balance: FieldValue.increment(p.amount) });
    } else {
      /* Not yet paid → release the reserved hold back to available balance. */
      t.update(walletRef, { balance: FieldValue.increment(p.amount), pendingPayout: FieldValue.increment(-p.amount) });
    }
    t.update(reqRef, {
      status: 'reversed', updatedAt: Timestamp.now(),
      statusHistory: FieldValue.arrayUnion(_payoutEvent('reversed', detail || 'Payout reversed')),
    });
  });
}

const crypto = require('crypto');
function _sha256(input) { return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex'); }

/* config/payouts — adjustable WITHOUT code changes. Safe defaults (system off). */
const PAYOUT_CONFIG_DEFAULTS = {
  enabled:            false,   // master switch for automated (instant) payouts
  autoB2C:            false,   // actually call IntaSend B2C
  instantLimit:       20000,   // KES — max amount eligible for instant
  requirePin:         true,    // instant requires a verified wallet PIN
  holdNewSellersDays: 7,       // accounts younger than this can't get instant
  dailyLimit:         50000,   // KES — max instant total per seller per day
  scheduledAbove:     0,       // KES — amounts >= this route to 'scheduled' (0 = off)
};

async function _getPayoutConfig(db) {
  try {
    const c = await db.collection('config').doc('payouts').get();
    return { ...PAYOUT_CONFIG_DEFAULTS, ...(c.exists ? c.data() : {}) };
  } catch (_) { return { ...PAYOUT_CONFIG_DEFAULTS }; }
}

/** Sum of today's non-refunded payout amounts for a seller. */
async function _todayPayoutTotal(db, uid) {
  try {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const snap = await db.collection('payoutRequests')
      .where('sellerUid', '==', uid)
      .where('createdAt', '>=', Timestamp.fromDate(start))
      .limit(50).get();
    let total = 0;
    snap.forEach((d) => { const p = d.data(); if (!['rejected', 'failed'].includes(p.status)) total += (p.amount || 0); });
    return total;
  } catch (_) { return 0; }
}

/** Is there already an in-flight (unsettled) payout for this seller? */
async function _hasActivePayout(db, uid) {
  try {
    const snap = await db.collection('payoutRequests').where('sellerUid', '==', uid).limit(50).get();
    return snap.docs.some((d) => ['pending', 'approving', 'approved', 'processing', 'approval_failed', 'scheduled'].includes(d.data().status));
  } catch (_) { return true; }   // fail safe → treat as active → not instant
}

/** Any OPEN dispute against this seller? */
async function _hasOpenDispute(db, uid) {
  try {
    const snap = await db.collection('disputes').where('sellerId', '==', uid).limit(20).get();
    return snap.docs.some((d) => String(d.data().status || '').toLowerCase() === 'open');
  } catch (_) { return false; }
}

/**
 * Risk engine — decide the payout MODE. Conservative by construction: any unmet
 * condition OR unavailable signal routes to 'review', never silently 'instant'.
 * Instant requires ALL of: system enabled, autoB2C on, M-Pesa, amount ≤ instantLimit,
 * (PIN verified if required), no fraud/freeze, active account, verified seller,
 * account older than the new-seller hold, daily limit not exceeded, no in-flight
 * payout, no open dispute.
 * @returns {{ mode:'instant'|'review'|'scheduled', reasons:string[], pinVerified:boolean }}
 */
async function _assessPayoutRisk(db, uid, amount, method, pin, cfg) {
  const reasons = [];

  const walletSnap = await db.collection('wallets').doc(uid).get();
  const w = walletSnap.exists ? walletSnap.data() : {};
  const pinVerified = !!(w.pinHash && pin && _sha256(`${pin}${uid}`) === w.pinHash);

  if (!cfg.enabled)                    reasons.push('system_disabled');
  if (!cfg.autoB2C)                    reasons.push('auto_off');
  if (method !== 'mpesa')              reasons.push('non_mpesa');
  if (amount > cfg.instantLimit)       reasons.push('above_instant_limit');
  if (cfg.requirePin && !pinVerified)  reasons.push('pin_required');
  if (w.frozen === true || w.fraudFlag === true || w.riskFlag === true) reasons.push('fraud_flag');

  const userSnap = await db.collection('users').doc(uid).get();
  const u = userSnap.exists ? userSnap.data() : {};
  const acctStatus = String(u.accountStatus || u.status || 'active').toLowerCase();
  if (['suspended', 'flagged', 'banned', 'frozen', 'restricted'].includes(acctStatus)) reasons.push('account_status');
  const verified = (u.payoutVerified === true) || (u.sellerVerified === true) || (u.emailVerified === true);
  if (!verified) reasons.push('unverified');
  const createdMs = u.createdAt?.toMillis ? u.createdAt.toMillis() : (u.createdAt?._seconds ? u.createdAt._seconds * 1000 : Date.now());
  if ((Date.now() - createdMs) / 86400000 < (cfg.holdNewSellersDays || 0)) reasons.push('new_seller_hold');

  if ((await _todayPayoutTotal(db, uid)) + amount > cfg.dailyLimit) reasons.push('daily_limit');
  if (await _hasActivePayout(db, uid)) reasons.push('pending_exists');
  if (await _hasOpenDispute(db, uid))  reasons.push('open_dispute');

  let mode;
  if (cfg.scheduledAbove > 0 && amount >= cfg.scheduledAbove) mode = 'scheduled';
  else if (reasons.length === 0)                             mode = 'instant';
  else                                                       mode = 'review';

  return { mode, reasons, pinVerified };
}

/**
 * Initiate an IntaSend B2C disbursement for a reserved payout and advance its status.
 * Shared by the instant path (requestSellerPayout) and admin approval. On success →
 * 'processing' + intasendRef (webhook later confirms 'paid'). On failure → parks at
 * 'approval_failed' WITHOUT refunding (an initiate error can be ambiguous). Returns
 * { ok, intasendRef?, error? }.
 */
async function _disburseB2C(db, rid, payout) {
  const reqRef = db.collection('payoutRequests').doc(rid);
  const ctx    = { ...payout, id: rid };
  const tries  = (payout.retryCount || 0) + 1;
  _plog('b2c_initiate', ctx, { attempt: tries });
  try {
    const resp = await intasendB2C(INTASEND_KEY.value(), {
      phone: payout.accountNumber, amountKES: String(payout.amount),
      reference: rid, remarks: 'SOKONI Earnings Payout',
    });
    const ref = resp?.tracking_id || resp?.invoice_id || resp?.file_id || null;
    await reqRef.update({
      status: 'processing', intasendRef: ref, b2cInitiatedAt: Timestamp.now(), updatedAt: Timestamp.now(),
      b2cResponse: _redact(resp),
      /* Immutable gateway evidence — the record that justifies eventually marking paid.
         confirmedAt/webhookReceivedAt are filled by the webhook on success. */
      gatewayName: 'IntaSend', gatewayReference: ref,
      gatewayStatus: String(resp?.status || resp?.state || 'accepted'),
      gatewayResponse: _redact(resp), submittedAt: Timestamp.now(),
      statusHistory: FieldValue.arrayUnion(_payoutEvent('processing', 'IntaSend B2C initiated' + (ref ? ' · ' + ref : ''))),
    });
    await _payoutMetric(db, 'b2cInitiated');
    _plog('b2c_ok', { ...ctx, intasendRef: ref, status: 'processing' });
    return { ok: true, intasendRef: ref };
  } catch (e) {
    const errMsg = String(e.message || e);
    const kind   = _classifyB2CError(errMsg);
    if (kind === 'retryable' && tries <= PAYOUT_RETRY_MAX) {
      const delay = Math.min(PAYOUT_RETRY_BASE_MS * Math.pow(2, tries - 1), PAYOUT_RETRY_MAX_MS);
      await reqRef.update({
        status: 'retry_scheduled', retryCount: tries, retryAt: Timestamp.fromMillis(Date.now() + delay),
        b2cError: errMsg.slice(0, 300), updatedAt: Timestamp.now(),
        statusHistory: FieldValue.arrayUnion(_payoutEvent('retry_scheduled', `Transient B2C error (try ${tries}/${PAYOUT_RETRY_MAX}) — retry in ${Math.round(delay / 60000)}m: ` + errMsg.slice(0, 120))),
      });
      await _payoutMetric(db, 'b2cRetries');
      _plog('b2c_retry', { ...ctx, status: 'retry_scheduled' }, { attempt: tries, delayMs: delay, error: errMsg.slice(0, 160) });
      return { ok: false, retry: true, error: errMsg };
    }
    /* Permanent, or retries exhausted → Failed immediately + refund the seller (the
       initiate was rejected, so money never left) for admin review. */
    await _refundPayout(db, rid, 'failed', { detail: (kind === 'permanent' ? 'Permanent B2C error: ' : 'Retries exhausted: ') + errMsg.slice(0, 150) });
    await _payoutMetric(db, 'b2cErrors');
    _plog('b2c_failed', { ...ctx, status: 'failed' }, { kind, attempt: tries, error: errMsg.slice(0, 160) });
    return { ok: false, error: errMsg };
  }
}

/** Mask an M-Pesa/account number for user-facing messages: 0712****678. */
function _maskAcct(acc) {
  const s = String(acc || '');
  if (s.length < 6) return s;
  const local = s.startsWith('254') ? '0' + s.slice(3) : s;
  return local.slice(0, 4) + '****' + local.slice(-3);
}

/** Fire an in-app + SMS + email notification about a payout (best-effort). */
function _notifyPayout(kind, payout, rid) {
  try {
    const notify = require('./notify').notify;
    const dest   = _maskAcct(payout.accountNumber);
    const amt    = payout.amount;
    const ref    = payout.intasendRef || rid;
    const map = {
      paid:   { type: 'payout_paid',   title: 'Payout sent ✅',   body: `KSh ${amt} sent to ${dest}. Ref ${ref}.` },
      failed: { type: 'payout_failed', title: 'Payout failed',    body: `Your KSh ${amt} withdrawal failed and the funds were returned to your wallet.` },
    }[kind];
    if (!map) return;
    notify({
      uid: payout.sellerUid, type: map.type, title: map.title, body: map.body,
      dedupeKey: `${map.type}_${rid}`,
      data: { requestId: rid, amount: amt, reference: ref, destination: dest, kind },
    }).catch(() => {});
  } catch (_) { /* notifications must never break payouts */ }
}

/**
 * Structured payout log — one line per stage carrying the full correlation set so a
 * single payout can be traced end-to-end (grep by correlationId or requestId).
 * @param {string} stage  e.g. 'requested','risk','reserved','b2c_initiated','paid'
 * @param {object} p      the payout record (or a partial with the ids)
 * @param {object} extra  extra fields to merge
 */
function _plog(stage, p = {}, extra = {}) {
  try {
    console.log('[payout] ' + JSON.stringify({
      stage,
      correlationId: p.correlationId || p.id || null,
      requestId:     p.id || p.requestId || null,
      payoutId:      p.id || p.requestId || null,
      intasendRef:   p.intasendRef || null,
      sellerId:      p.sellerUid || null,
      state:         p.status || null,
      amount:        p.amount ?? null,
      ts:            new Date().toISOString(),
      ...extra,
    }));
  } catch (_) { /* logging must never break payouts */ }
}

/** Strip sensitive keys before logging/storing a provider payload for audit. */
function _redact(obj) {
  try {
    if (!obj || typeof obj !== 'object') return obj ?? null;
    const out = Array.isArray(obj) ? [] : {};
    for (const k of Object.keys(obj)) {
      if (/key|secret|token|auth|password|challenge|signature|pin/i.test(k)) { out[k] = '[redacted]'; continue; }
      const v = obj[k];
      out[k] = (v && typeof v === 'object') ? _redact(v) : v;
    }
    return out;
  } catch (_) { return null; }
}

/* Retry policy for transient B2C failures. */
const PAYOUT_RETRY_MAX     = 4;
const PAYOUT_RETRY_BASE_MS = 2 * 60 * 1000;   // 2 min
const PAYOUT_RETRY_MAX_MS  = 30 * 60 * 1000;  // cap at 30 min

/**
 * Classify a B2C failure. 'retryable' = transient (network/timeout/5xx/429) → back off
 * and retry. 'permanent' = won't fix itself (invalid number, insufficient PROVIDER
 * funds, 4xx validation) → move to Failed immediately for review.
 */
function _classifyB2CError(msg) {
  const m = String(msg || '').toLowerCase();
  if (/timeout|econnreset|etimedout|econnrefused|network|socket|enotfound|eai_again|fetch failed/.test(m)) return 'retryable';
  const statusMatch = m.match(/\((\d{3})\)/);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  if (status >= 500 || status === 429) return 'retryable';
  if (/invalid.*(phone|number|msisdn|account)|unregistered|insufficient|not.*enough|balance/.test(m)) return 'permanent';
  if (status >= 400 && status < 500) return 'permanent';
  return 'retryable';   // unknown → retryable, but bounded by PAYOUT_RETRY_MAX
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function _requireAuth(ctx) {
  if (!ctx.auth) throw new HttpsError('unauthenticated', 'Login required');
}

function _requireAdmin(ctx) {
  if (!ctx.auth?.token?.admin && !ctx.auth?.token?.superAdmin) {
    throw new HttpsError('permission-denied', 'Admin access required');
  }
}

/** Sanitise a string: strip HTML tags, trim, truncate. */
function _san(s, max = 300) {
  return s == null ? '' : String(s).replace(/<[^>]*>/g, '').trim().slice(0, max);
}

/** Generate a short random ID suitable for Firestore doc IDs. */
function _genId(prefix = 'tx') {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}_${rand}`;
}

/**
 * Normalize Kenyan phone to 254XXXXXXXXX (10-digit local or +254/254 prefix).
 * Returns null if format is unrecognised.
 */
function _normalizePhone(raw) {
  const cleaned = String(raw).replace(/\s+/g, '');
  const match = cleaned.match(/^(?:254|\+254|0)([17]\d{8})$/);
  if (!match) return null;
  return `254${match[1]}`;
}

/**
 * Query IntaSend for an invoice's payment state via the authenticated status
 * endpoint.
 *
 * WHY THIS EXISTS: the intasend-node SDK's collection().status() sets
 * `this.secret_key = ''` (it targets the publishable-key checkout flow), and our
 * client is built with an empty publishable key — so the request went out with
 * NO Authorization header and IntaSend answered HTTP 401. That is why both
 * confirmWalletTopUp (the client poll) and sweepStaleWalletTopUps could never
 * observe a COMPLETE: a genuinely-paid top-up (money debited, IntaSend state
 * COMPLETE) stayed 'pending' in the wallet forever. Verified live: POST
 * /api/v1/payment/status/ with `Authorization: Bearer <secret>` returns the
 * invoice; the same raw Bearer transport the STK push already uses.
 *
 * Returns the UPPER-CASED state ('COMPLETE' | 'FAILED' | 'PENDING' | …) or null.
 */
function _intasendInvoiceState(invoiceId) {
  const https = require('https');
  const payload = JSON.stringify({ invoice_id: invoiceId });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'payment.intasend.com',
      path: '/api/v1/payment/status/',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${INTASEND_KEY.value()}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (r) => {
      let body = '';
      r.on('data', (c) => { body += c; });
      r.on('end', () => {
        try {
          const j = JSON.parse(body);
          const state = (j && j.invoice && j.invoice.state) || (j && j.state) || null;
          resolve(state ? String(state).toUpperCase() : null);
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** Ensure a wallet document exists; returns the doc reference. */
async function _ensureWallet(db, uid) {
  const ref = db.collection('wallets').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      uid,
      balance: 0,
      currency: 'KES',
      lastTopUp: null,
      pendingTopUp: null,
      createdAt: Timestamp.now(),
    });
  }
  return ref;
}

// ─── 1. getWalletBalance ───────────────────────────────────────────────────

exports.getWalletBalance = onCall({ cors: true, enforceAppCheck: true }, async (request) => {
  _requireAuth(request);

  const db = getFirestore();
  const callerUid = request.auth.uid;
  const { targetUid } = request.data || {};

  let uid = callerUid;
  if (targetUid && targetUid !== callerUid) {
    _requireAdmin(request);
    uid = _san(targetUid, 128);
  }

  const ref = await _ensureWallet(db, uid);
  const snap = await ref.get();
  const data = snap.data();

  return {
    uid,
    balance: data.balance ?? 0,
    currency: data.currency ?? 'KES',
    lastTopUp: data.lastTopUp ?? null,
    pendingTopUp: data.pendingTopUp ?? null,
  };
});

// ─── 2. initiateWalletTopUp ────────────────────────────────────────────────

exports.initiateWalletTopUp = onCall(
  { cors: true, enforceAppCheck: true, secrets: [INTASEND_KEY] },
  async (request) => {
    _requireAuth(request);
    /* HIGH-06: throttle a money/privilege endpoint. Throws resource-exhausted. */
    await checkRateLimit(request, 'payment');

    const db = getFirestore();
    const uid = request.auth.uid;
    const { amount, phone } = request.data || {};

    // Validate amount
    const amt = Number(amount);
    if (!Number.isInteger(amt) || amt < 10 || amt > 70000) {
      throw new HttpsError('invalid-argument', 'Amount must be a whole number between KSh 10 and KSh 70,000');
    }

    // Validate & normalize phone
    const normalizedPhone = _normalizePhone(phone);
    if (!normalizedPhone) {
      throw new HttpsError('invalid-argument', 'Phone must be a valid Kenyan number (07XX or 01XX, with or without country code)');
    }

    // Create pending transaction
    const txId = _genId('wtop');
    const txRef = db.collection('walletTransactions').doc(txId);
    await txRef.set({
      uid,
      type: 'pending',
      amount: amt,
      description: 'Wallet top-up via M-Pesa',
      status: 'pending',
      mpesaRef: null,
      invoiceId: null,
      createdAt: Timestamp.now(),
    });

    // Flag pending top-up on wallet (creates wallet doc if needed)
    const walletRef = db.collection('wallets').doc(uid);
    const walletSnap = await walletRef.get();
    if (!walletSnap.exists) {
      await walletRef.set({
        uid,
        balance: 0,
        currency: 'KES',
        lastTopUp: null,
        pendingTopUp: txId,
        createdAt: Timestamp.now(),
      });
    } else {
      await walletRef.update({ pendingTopUp: txId });
    }

    // Initiate IntaSend STK Push
    let invoiceId = null;
    try {
      const IntaSend = require('intasend-node');
      /* intasend-node takes THREE POSITIONAL args:
             IntaSend(publishable_key, secret_key, test_mode)
         This was called as IntaSend(key, { testMode }) — so the secret landed in
         the publishable slot and an OBJECT became secret_key. The client sends
         `Authorization: Bearer ${secret_key}`, i.e. "Bearer [object Object]",
         and IntaSend answered HTTP 500 on every STK push. test_mode was also
         left undefined. Matches the working call in payment-orchestrator.js. */
      const client = new IntaSend(
        '',                                        /* publishable key — unused for collection */
        INTASEND_KEY.value(),                      /* secret key */
        process.env.FUNCTIONS_EMULATOR === 'true'  /* test mode only under the emulator */
      );

      /* Use mpesaStkPush (→ /api/v1/payment/mpesa-stk-push/), the endpoint that
         actually pushes the M-Pesa PIN prompt to the phone — the same one the
         working subscription flow hits via initiateSTKPush.

         The previous call, collection().charge(), posts to /api/v1/checkout/
         (see node_modules/intasend-node/dist/collection.js): it mints a hosted-
         checkout invoice AND blanks the secret key, so it returns 200 with an
         invoice but never sends an STK. That is the exact divergence — the call
         "succeeded" server-side while no prompt reached the phone. method and
         currency are injected by the SDK; the checkout-only name/email/host
         fields are not part of the STK push. Response still carries
         invoice.invoice_id, so the invoiceId capture and the confirm/webhook/
         sweep paths below are unchanged. */
      const response = await client.collection().mpesaStkPush({
        amount:       amt,
        phone_number: normalizedPhone,
        api_ref:      txId,
        narrative:    'SOKONI wallet top-up',
      });

      invoiceId = response?.invoice?.invoice_id ?? response?.id ?? null;
      await txRef.update({ invoiceId });
    } catch (err) {
      // IntaSend failure — mark transaction failed and surface a clean error
      await txRef.update({ status: 'failed' });
      await walletRef.update({ pendingTopUp: null });
      /* err.message was `undefined` for IntaSend transport errors, so the real
         cause (HTTP 500 from a malformed Authorization header) never reached the
         logs — only a generic "contact support". Log whatever the error actually
         carries, without leaking the credential. */
      console.error('[wallet] IntaSend STK push error:', {
        message: err && err.message,
        status:  err && (err.status || err.statusCode),
        body:    (() => { try { return JSON.stringify(err).slice(0, 500); } catch (_) { return String(err); } })(),
      });
      throw new HttpsError('unavailable', 'Unable to initiate M-Pesa prompt. Please try again or contact support.');
    }

    return {
      txId,
      invoiceId,
      message: 'M-Pesa prompt sent to your phone. Enter your PIN to complete the top-up.',
    };
  }
);

// ─── 3. confirmWalletTopUp ─────────────────────────────────────────────────

exports.confirmWalletTopUp = onCall(
  { cors: true, secrets: [INTASEND_KEY], enforceAppCheck: true },
  async (request) => {
    _requireAuth(request);

    const db = getFirestore();
    const uid = request.auth.uid;
    const { txId } = request.data || {};

    if (!txId) throw new HttpsError('invalid-argument', 'txId is required');

    const txRef = db.collection('walletTransactions').doc(_san(txId, 128));
    const txSnap = await txRef.get();

    if (!txSnap.exists) throw new HttpsError('not-found', 'Transaction not found');

    const tx = txSnap.data();
    if (tx.uid !== uid) throw new HttpsError('permission-denied', 'This transaction does not belong to you');
    if (tx.status === 'completed') {
      return { status: 'completed', amount: tx.amount };
    }
    if (tx.status === 'failed') {
      return { status: 'failed' };
    }
    if (!tx.invoiceId) {
      return { status: 'pending' };
    }

    // Poll IntaSend for payment status
    let invoiceStatus = null;
    try {
      /* Authenticated status check. The SDK's collection().status() blanks the
         secret key and 401s (see _intasendInvoiceState); this hits the raw
         Bearer endpoint so the poll can actually observe COMPLETE. */
      invoiceStatus = await _intasendInvoiceState(tx.invoiceId);
    } catch (err) {
      console.error('[wallet] IntaSend status check error:', err && err.message);
      throw new HttpsError('unavailable', 'Unable to verify payment status. Please try again shortly.');
    }

    // Normalise IntaSend states
    const paid = invoiceStatus === 'COMPLETE';
    const failed = ['FAILED', 'CANCELLED', 'EXPIRED'].includes(invoiceStatus);

    if (paid) {
      const walletRef = db.collection('wallets').doc(uid);
      let newBalance = 0;

      await db.runTransaction(async (t) => {
        // Read BOTH wallet and txRef inside the transaction so Firestore detects
        // conflicts from a concurrent confirmWalletTopUp or sweep call
        const [walletSnap, txCheck] = await Promise.all([t.get(walletRef), t.get(txRef)]);

        // Already credited by a concurrent request — return idempotently
        if (txCheck.exists && txCheck.data().status === 'completed') {
          newBalance = walletSnap.exists ? (walletSnap.data().balance ?? 0) : 0;
          return;
        }

        const current = walletSnap.exists ? (walletSnap.data().balance ?? 0) : 0;
        newBalance = current + tx.amount;

        if (!walletSnap.exists) {
          t.set(walletRef, {
            uid,
            balance: newBalance,
            currency: 'KES',
            lastTopUp: Timestamp.now(),
            pendingTopUp: null,
            createdAt: Timestamp.now(),
          });
        } else {
          t.update(walletRef, {
            balance: newBalance,
            lastTopUp: Timestamp.now(),
            pendingTopUp: null,
          });
        }

        t.update(txRef, { status: 'completed', updatedAt: Timestamp.now() });
      });

      return { status: 'completed', amount: tx.amount, balance: newBalance };
    }

    if (failed) {
      await txRef.update({ status: 'failed', updatedAt: Timestamp.now() });
      await db.collection('wallets').doc(uid).update({ pendingTopUp: null });
      return { status: 'failed' };
    }

    return { status: 'pending' };
  }
);

// ─── 4. spendFromWallet ────────────────────────────────────────────────────

exports.spendFromWallet = onCall({ cors: true, enforceAppCheck: true }, async (request) => {
  _requireAuth(request);
  /* HIGH-06: throttle a money/privilege endpoint. Throws resource-exhausted. */
  await checkRateLimit(request, 'payment');

  const db = getFirestore();
  const uid = request.auth.uid;
  const { amount, orderId, description } = request.data || {};

  const amt = Number(amount);
  if (!Number.isInteger(amt) || amt <= 0) {
    throw new HttpsError('invalid-argument', 'Amount must be a positive whole number');
  }
  if (!orderId) throw new HttpsError('invalid-argument', 'orderId is required');

  const sanitizedOrderId = _san(orderId, 128);
  const desc = _san(description, 300) || `Payment for order ${sanitizedOrderId}`;

  // Idempotency: stable doc ID prevents double-spend
  const txId = `${uid}_${sanitizedOrderId}_spend`;
  const txRef = db.collection('walletTransactions').doc(txId);
  const walletRef = db.collection('wallets').doc(uid);

  let newBalance = 0;

  await db.runTransaction(async (t) => {
    const [txSnap, walletSnap] = await Promise.all([t.get(txRef), t.get(walletRef)]);

    // Already processed — return stored result
    if (txSnap.exists && txSnap.data().status === 'completed') {
      newBalance = walletSnap.exists ? walletSnap.data().balance ?? 0 : 0;
      return;
    }

    if (!walletSnap.exists) throw new HttpsError('not-found', 'Wallet does not exist');

    const current = walletSnap.data().balance ?? 0;
    if (current < amt) {
      throw new HttpsError('failed-precondition', 'Insufficient wallet balance');
    }

    newBalance = current - amt;
    t.update(walletRef, { balance: newBalance });
    t.set(txRef, {
      uid,
      type: 'debit',
      amount: amt,
      description: desc,
      orderId: sanitizedOrderId,
      status: 'completed',
      createdAt: Timestamp.now(),
    });
  });

  return { success: true, newBalance, txId };
});

// ─── 5. getWalletTransactions ──────────────────────────────────────────────

exports.getWalletTransactions = onCall({ cors: true, enforceAppCheck: true }, async (request) => {
  _requireAuth(request);

  const db = getFirestore();
  const uid = request.auth.uid;
  const page = Math.max(1, Number(request.data?.page) || 1);
  const PAGE_SIZE = 50;

  // Single-field query on uid (no composite index needed)
  const snap = await db
    .collection('walletTransactions')
    .where('uid', '==', uid)
    .limit(PAGE_SIZE + 1)
    .get();

  const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // Sort descending by createdAt in JS (avoids composite index)
  all.sort((a, b) => {
    const ta = a.createdAt?.toMillis?.() ?? 0;
    const tb = b.createdAt?.toMillis?.() ?? 0;
    return tb - ta;
  });

  // Manual pagination
  const offset = (page - 1) * PAGE_SIZE;
  const slice = all.slice(offset, offset + PAGE_SIZE);
  const hasMore = all.length > offset + PAGE_SIZE;

  return {
    transactions: slice.map((tx) => ({
      id: tx.id,
      type: tx.type,
      amount: tx.amount,
      description: tx.description,
      status: tx.status,
      orderId: tx.orderId ?? null,
      mpesaRef: tx.mpesaRef ?? null,
      createdAt: tx.createdAt,
    })),
    page,
    hasMore,
  };
});

// ─── 6. requestSellerPayout ────────────────────────────────────────────────

exports.requestSellerPayout = onCall({ cors: true, enforceAppCheck: true, secrets: [INTASEND_KEY] }, async (request) => {
  _requireAuth(request);
  /* HIGH-06: throttle a money/privilege endpoint. Throws resource-exhausted. */
  await checkRateLimit(request, 'payment');

  const db = getFirestore();
  const uid = request.auth.uid;
  const { amount, method, accountNumber, bankCode, bankName, idempotencyKey, pin } = request.data || {};

  const amt = Number(amount);
  if (!Number.isInteger(amt) || amt < 100) {
    throw new HttpsError('invalid-argument', 'Minimum payout amount is KSh 100');
  }

  const validMethods = ['mpesa', 'bank'];
  if (!validMethods.includes(method)) {
    throw new HttpsError('invalid-argument', 'method must be "mpesa" or "bank"');
  }

  const sanitizedAccount = _san(accountNumber, 30);
  if (!sanitizedAccount) {
    throw new HttpsError('invalid-argument', 'accountNumber is required');
  }

  if (method === 'mpesa') {
    const normalizedPhone = _normalizePhone(sanitizedAccount);
    if (!normalizedPhone) {
      throw new HttpsError('invalid-argument', 'M-Pesa account must be a valid Kenyan phone number');
    }
  }

  if (method === 'bank' && !bankCode) {
    throw new HttpsError('invalid-argument', 'bankCode is required for bank payouts');
  }

  /* ── Risk engine: decide instant vs review vs scheduled (before reserving) ── */
  const cfg  = await _getPayoutConfig(db);
  const risk = await _assessPayoutRisk(db, uid, amt, method, pin, cfg);
  _plog('risk', { sellerUid: uid, amount: amt }, { mode: risk.mode, reasons: risk.reasons });
  /* Initial status by mode: instant reserves as a transient 'approving' then fires
     B2C; review → 'pending'; scheduled → 'scheduled'. */
  const initialStatus = risk.mode === 'instant' ? 'approving'
                      : risk.mode === 'scheduled' ? 'scheduled'
                      : 'pending';

  /* Idempotency: a client-supplied key maps to a deterministic doc id, so a
     double-tap or a retry-after-timeout can't create two withdrawals. Falls back to
     a random id when no key is sent (older clients). */
  const safeKey = _san(idempotencyKey, 120).replace(/[^A-Za-z0-9_-]/g, '');
  const reqId   = safeKey ? `pout_${safeKey}` : _genId('pout');
  const walletRef   = db.collection('wallets').doc(uid);
  const reqRef      = db.collection('payoutRequests').doc(reqId);
  const velocityRef = db.collection('payoutVelocity').doc(uid);
  const today       = new Date().toISOString().slice(0, 10);

  /* Atomically dedupe + check velocity + balance, reserve amount, create request */
  let deduplicated = false;
  await db.runTransaction(async (t) => {
    const [walletSnap, velocitySnap, existingReq] = await Promise.all([
      t.get(walletRef), t.get(velocityRef), t.get(reqRef),
    ]);

    /* Already submitted with this key — return it without reserving again. */
    if (existingReq.exists) { deduplicated = true; return; }

    /* FRD-1: velocity gate — max 3 payout requests per seller per calendar day */
    const vel = velocitySnap.exists ? velocitySnap.data() : null;
    const todayCount = (vel && vel.date === today) ? (vel.count || 0) : 0;
    if (todayCount >= 3) {
      throw new HttpsError('resource-exhausted', 'Maximum 3 payout requests per day. Please try again tomorrow.');
    }

    const balance = walletSnap.exists ? (walletSnap.data().balance ?? 0) : 0;
    if (balance < amt) {
      throw new HttpsError('failed-precondition', 'Insufficient wallet balance for this payout');
    }

    t.set(velocityRef, { date: today, count: todayCount + 1, updatedAt: Timestamp.now() }, { merge: true });
    t.update(walletRef, { balance: balance - amt, pendingPayout: FieldValue.increment(amt) });
    t.set(reqRef, {
      sellerUid:     uid,
      correlationId: reqId,
      amount:        amt,
      fee:           0,
      netAmount:     amt,
      method,
      accountNumber: sanitizedAccount,
      bankCode:      method === 'bank' ? _san(bankCode, 20) : null,
      bankName:      method === 'bank' ? _san(bankName, 100) : null,
      mode:          risk.mode,
      riskReasons:   risk.reasons,
      status:        initialStatus,
      statusHistory: [_payoutEvent('requested', 'Request submitted'),
                      _payoutEvent(initialStatus, risk.mode === 'instant' ? 'Instant — auto-approved by risk engine'
                                                  : risk.mode === 'scheduled' ? 'Scheduled for later processing'
                                                  : 'Queued for admin review')],
      intasendRef:   null,
      note:          null,
      processedAt:   null,
      createdAt:     Timestamp.now(),
      updatedAt:     Timestamp.now(),
    });
  });

  if (deduplicated) {
    await _payoutMetric(db, 'duplicatesPrevented');
    return { success: true, requestId: reqId, deduplicated: true, mode: risk.mode, amount: amt,
             accountNumber: sanitizedAccount, message: 'Already submitted.' };
  }

  await _payoutMetric(db, 'requests');
  _plog('reserved', { id: reqId, correlationId: reqId, sellerUid: uid, amount: amt, status: initialStatus });

  /* ── Instant path: disburse via IntaSend B2C immediately (webhook confirms paid) ── */
  if (risk.mode === 'instant') {
    await _payoutMetric(db, 'instantAttempts');
    const payoutDoc = { sellerUid: uid, correlationId: reqId, amount: amt, accountNumber: sanitizedAccount, method, intasendRef: null };
    const res = await _disburseB2C(db, reqId, payoutDoc);
    if (res.ok) {
      return {
        success: true, requestId: reqId, mode: 'instant', status: 'processing',
        amount: amt, accountNumber: sanitizedAccount, reference: res.intasendRef,
        estimatedArrival: '1–3 minutes',
        message: 'Sending your money…',
      };
    }
    if (res.retry) {
      /* Transient provider error — funds reserved, auto-retry scheduled. */
      return {
        success: true, requestId: reqId, mode: 'instant', status: 'retry_scheduled',
        amount: amt, accountNumber: sanitizedAccount,
        estimatedArrival: 'A few minutes',
        message: 'Sending your money… completing shortly.',
      };
    }
    /* Permanent failure — funds were returned to the wallet. */
    return {
      success: true, requestId: reqId, mode: 'review', status: 'failed',
      amount: amt, accountNumber: sanitizedAccount,
      estimatedArrival: 'Returned to wallet',
      message: 'We couldn\'t send to that number and returned the funds to your wallet. Please check the number and try again.',
    };
  }

  const estimated = risk.mode === 'scheduled' ? 'Tomorrow' : 'Under review';
  return {
    success: true, requestId: reqId, mode: risk.mode, status: initialStatus,
    amount: amt, accountNumber: sanitizedAccount,
    estimatedArrival: estimated,
    message: risk.mode === 'scheduled'
      ? 'Scheduled — your payout will be processed within 24 hours.'
      : 'Submitted — under review. Funds arrive within 24 hours once approved.',
  };
});

// ─── 7. getPayoutHistory ───────────────────────────────────────────────────

exports.getPayoutHistory = onCall({ cors: true, enforceAppCheck: true }, async (request) => {
  _requireAuth(request);

  const db = getFirestore();
  const uid = request.auth.uid;

  // Single-field query on sellerUid
  const snap = await db
    .collection('payoutRequests')
    .where('sellerUid', '==', uid)
    .limit(20)
    .get();

  const payouts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // Sort descending by createdAt in JS
  payouts.sort((a, b) => {
    const ta = a.createdAt?.toMillis?.() ?? 0;
    const tb = b.createdAt?.toMillis?.() ?? 0;
    return tb - ta;
  });

  /* Mask the destination for display: 0712****678 */
  const _mask = (acc) => {
    const s = String(acc || '');
    if (s.length < 6) return s;
    const local = s.startsWith('254') ? '0' + s.slice(3) : s;
    return local.slice(0, 4) + '****' + local.slice(-3);
  };

  return {
    payouts: payouts.map((p) => ({
      id: p.id,
      amount: p.amount,
      fee: p.fee ?? 0,
      netAmount: p.netAmount ?? p.amount,
      method: p.method,
      destinationMasked: _mask(p.accountNumber),
      status: p.status,
      intasendRef: p.intasendRef ?? null,
      note: p.note ?? null,
      statusHistory: Array.isArray(p.statusHistory)
        ? p.statusHistory.map((e) => ({ status: e.status, detail: e.detail ?? null, at: e.at ?? null }))
        : [],
      createdAt: p.createdAt,
      updatedAt: p.updatedAt ?? p.processedAt ?? p.createdAt,
      processedAt: p.processedAt ?? null,
    })),
  };
});

// ─── 8. adminProcessPayout ─────────────────────────────────────────────────

/* invoker:'public' — REQUIRED for a browser-called callable. Cloud Run authenticates
   at the IAM layer BEFORE the function runs; a Firebase ID token is not a Google IAM
   token, so without allUsers as invoker the request is rejected with an HTML 403 and
   the Firebase SDK surfaces a bare "internal" (the code never runs). This function had
   lost the binding (a redeploy alone does not restore it on an update), so the Pay
   button failed. App Check + _requireAdmin remain the real auth — allUsers only lets
   the request REACH the code, exactly like adminOsDispatch. */
exports.adminProcessPayout = onCall({ cors: true, enforceAppCheck: true, invoker: 'public', secrets: [INTASEND_KEY] }, async (request) => {
  _requireAuth(request);
  _requireAdmin(request);

  const db = getFirestore();
  const { requestId, status, note } = request.data || {};

  if (!requestId) throw new HttpsError('invalid-argument', 'requestId is required');

  const validStatuses = ['approved', 'rejected', 'paid'];
  if (!validStatuses.includes(status)) {
    throw new HttpsError('invalid-argument', 'status must be "approved", "rejected", or "paid"');
  }

  const rid     = _san(requestId, 128);
  const reqRef  = db.collection('payoutRequests').doc(rid);
  const reqSnap = await reqRef.get();
  if (!reqSnap.exists) throw new HttpsError('not-found', 'Payout request not found');
  const payout = reqSnap.data();

  // ── PAID (manual mark, or fallback) ────────────────────────────────────────
  if (status === 'paid') {
    /* MANUAL settlement — the admin attests money was sent OUT-OF-BAND (not via the
       gateway). Recorded as 'settled_manually' (distinct from gateway 'paid') with an
       immutable attestation. Requires an external reference (e.g. the M-Pesa code) AND
       an attestation note, so an unconfirmed payout can never be marked settled. */
    const externalReference = _san(request.data.externalReference || request.data.mpesaCode || '', 120);
    const attestation = _san(request.data.attestation || note || '', 500);
    if (!externalReference || !attestation) {
      throw new HttpsError('failed-precondition', 'Manual settlement requires externalReference (e.g. M-Pesa code) + attestation that funds were sent.');
    }
    await _settlePayoutPaid(db, rid, {
      finalStatus: 'settled_manually', processedBy: request.auth.uid,
      externalReference, attestation, detail: 'Settled manually — ref ' + externalReference,
    });
    await _payoutMetric(db, 'settledManually');
    return { success: true, status: 'settled_manually', externalReference };
  }

  // ── REJECTED (refund reserved funds) — only pre-disbursement states ─────────
  if (status === 'rejected') {
    if (!['pending', 'approved', 'approval_failed', 'retry_scheduled'].includes(payout.status)) {
      throw new HttpsError('failed-precondition', `Cannot reject a payout that is "${payout.status}" — funds may already be disbursed.`);
    }
    await _refundPayout(db, rid, 'rejected', { processedBy: request.auth.uid, note: _san(note, 500) || null, detail: 'Rejected by admin' });
    await _payoutMetric(db, 'rejected');
    return { success: true, status: 'rejected' };
  }

  // ── APPROVED → (optionally) auto-disburse via IntaSend B2C ──────────────────
  if (!['pending', 'approval_failed', 'retry_scheduled'].includes(payout.status)) {
    throw new HttpsError('failed-precondition', `Cannot approve a payout that is "${payout.status}".`);
  }
  /* Atomic gate: flip to a transient 'approving' so a concurrent approve can't
     double-trigger the disbursement. */
  let gated = false;
  await db.runTransaction(async (t) => {
    const s  = await t.get(reqRef);
    const st = s.exists ? s.data().status : null;
    if (!['pending', 'approval_failed', 'retry_scheduled'].includes(st)) return;
    t.update(reqRef, {
      status: 'approving', approvedAt: Timestamp.now(), processedBy: request.auth.uid,
      note: _san(note, 500) || payout.note || null, updatedAt: Timestamp.now(),
      statusHistory: FieldValue.arrayUnion(_payoutEvent('approved', 'Admin approved')),
    });
    gated = true;
  });
  if (!gated) throw new HttpsError('failed-precondition', 'Payout is already being processed.');
  await _payoutMetric(db, 'approvals');

  const autoOn = await _autoB2CEnabled(db);
  /* Manual mode (flag off) or non-M-Pesa (B2C is M-Pesa only): leave approved for
     hand disbursement — unchanged behaviour, no real money moved automatically. */
  if (!autoOn || payout.method !== 'mpesa') {
    await reqRef.update({
      status: 'approved', updatedAt: Timestamp.now(),
      statusHistory: FieldValue.arrayUnion(_payoutEvent('approved', autoOn ? 'Bank payout — manual disbursement' : 'Approved — manual disbursement (auto-B2C off)')),
    });
    return { success: true, status: 'approved', autoB2C: false };
  }

  // Automated M-Pesa disbursement via the shared B2C helper (webhook confirms 'paid').
  const res = await _disburseB2C(db, rid, { ...payout, id: rid });
  if (res.ok)    return { success: true, status: 'processing', intasendRef: res.intasendRef };
  if (res.retry) return { success: true, status: 'retry_scheduled', message: 'Transient provider error — automatic retry scheduled.' };
  /* Structured gateway failure (NOT bare "internal") — the admin UI shows the real reason. */
  throw new HttpsError('failed-precondition',
    'PAYOUT_GATEWAY_FAILED — ' + (res.error || 'IntaSend B2C error') + ' · funds returned to the seller.',
    { code: 'PAYOUT_GATEWAY_FAILED', gateway: 'IntaSend', reason: res.error || null });
});

// ─── 9. adminGetPendingPayouts ─────────────────────────────────────────────

exports.adminGetPendingPayouts = onCall({ cors: true, enforceAppCheck: true }, async (request) => {
  _requireAuth(request);
  _requireAdmin(request);

  const db = getFirestore();

  // Single-field query on status
  const snap = await db
    .collection('payoutRequests')
    .where('status', '==', 'pending')
    .limit(50)
    .get();

  const payouts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // Sort oldest-first so admins process in FIFO order
  payouts.sort((a, b) => {
    const ta = a.createdAt?.toMillis?.() ?? 0;
    const tb = b.createdAt?.toMillis?.() ?? 0;
    return ta - tb;
  });

  return {
    payouts: payouts.map((p) => ({
      id: p.id,
      sellerUid: p.sellerUid,
      amount: p.amount,
      method: p.method,
      // Mask sensitive account details — admin UI should request full details separately
      accountNumberMasked: p.accountNumber
        ? `${'*'.repeat(Math.max(0, p.accountNumber.length - 4))}${p.accountNumber.slice(-4)}`
        : null,
      bankName: p.bankName ?? null,
      status: p.status,
      createdAt: p.createdAt,
    })),
  };
});

// ─── 10. refundToWallet ────────────────────────────────────────────────────

exports.refundToWallet = onCall({ cors: true, enforceAppCheck: true, invoker: 'public' }, async (request) => {   /* invoker:'public' — same missing-binding fix as adminProcessPayout (was HTML 403) */
  _requireAuth(request);
  // Refunds must always be admin-initiated to prevent self-enrichment.
  // User-facing return/dispute flows route through the disputes system for approval.
  _requireAdmin(request);

  const db = getFirestore();
  const callerUid = request.auth.uid;
  const { orderId, amount, reason, targetUid } = request.data || {};

  // Determine whose wallet to credit
  const recipientUid = (targetUid && _san(targetUid, 128)) || callerUid;

  const amt = Number(amount);
  if (!Number.isInteger(amt) || amt <= 0) {
    throw new HttpsError('invalid-argument', 'Refund amount must be a positive whole number');
  }
  if (!orderId) throw new HttpsError('invalid-argument', 'orderId is required');

  const sanitizedOrderId = _san(orderId, 128);
  const desc = _san(reason, 300) || `Refund for order ${sanitizedOrderId}`;

  // Idempotency: stable doc ID prevents duplicate refunds
  const txId = `${recipientUid}_${sanitizedOrderId}_refund`;
  const txRef = db.collection('walletTransactions').doc(txId);
  const walletRef = db.collection('wallets').doc(recipientUid);

  let newBalance = 0;

  await db.runTransaction(async (t) => {
    const [txSnap, walletSnap] = await Promise.all([t.get(txRef), t.get(walletRef)]);

    // Already refunded — idempotent return
    if (txSnap.exists && txSnap.data().status === 'completed') {
      newBalance = walletSnap.exists ? walletSnap.data().balance ?? 0 : 0;
      return;
    }

    const current = walletSnap.exists ? (walletSnap.data().balance ?? 0) : 0;
    newBalance = current + amt;

    if (!walletSnap.exists) {
      t.set(walletRef, {
        uid: recipientUid,
        balance: newBalance,
        currency: 'KES',
        lastTopUp: null,
        pendingTopUp: null,
        createdAt: Timestamp.now(),
      });
    } else {
      t.update(walletRef, { balance: newBalance });
    }

    t.set(txRef, {
      uid: recipientUid,
      type: 'refund',
      amount: amt,
      description: desc,
      orderId: sanitizedOrderId,
      refundedBy: callerUid,
      status: 'completed',
      createdAt: Timestamp.now(),
    });
  });

  return { success: true, newBalance };
});

// ─── Scheduled: clear stale pending wallet top-ups ─────────────────────────
// Q2 fix: pendingTopUp set during initiateWalletTopUp but never cleared if
// the user never calls confirmWalletTopUp (network loss, app kill, etc.)

const { onSchedule } = require('firebase-functions/v2/scheduler');

exports.sweepStaleWalletTopUps = onSchedule(
  { schedule: 'every 30 minutes', timeZone: 'Africa/Nairobi', secrets: [INTASEND_KEY] },
  async () => {
    const db      = getFirestore();
    const cutoff  = Timestamp.fromMillis(Date.now() - 30 * 60 * 1000); // 30 min ago
    const stale   = await db.collection('walletTransactions')
      .where('status', '==', 'pending')
      .where('createdAt', '<', cutoff)
      .limit(50)
      .get();

    if (stale.empty) return;

    let resolved = 0;
    for (const doc of stale.docs) {
      const tx = doc.data();
      let finalStatus = 'expired';

      /* Poll IntaSend if we have an invoiceId */
      if (tx.invoiceId) {
        try {
          const state = (await _intasendInvoiceState(tx.invoiceId)) || '';
          if (state === 'COMPLETE') {
            finalStatus = 'completed';
          } else if (['FAILED', 'CANCELLED', 'EXPIRED'].includes(state)) {
            finalStatus = 'failed';
          } else {
            continue; // still genuinely pending — skip
          }
        } catch (_) {
          /* IntaSend unreachable — leave it pending and retry on the next sweep.
             NEVER expire here: the old code fell through and marked a possibly-
             PAID top-up 'expired', losing the credit (exactly what stranded the
             KES 10 / KNG36GW top-up). */
          continue;
        }
      }

      await db.runTransaction(async t => {
        const walletRef  = db.collection('wallets').doc(tx.uid);
        // Read both wallet and the transaction doc so Firestore detects conflicts
        // from a concurrent confirmWalletTopUp that may have already credited the wallet
        const [walletSnap, txCheck] = await Promise.all([t.get(walletRef), t.get(doc.ref)]);

        // Already resolved by a concurrent call — skip to avoid double credit
        if (txCheck.exists && txCheck.data().status !== 'pending') return;

        t.update(doc.ref, { status: finalStatus, resolvedAt: Timestamp.now(), resolvedBy: 'sweepStaleWalletTopUps' });
        if (walletSnap.exists && walletSnap.data().pendingTopUp === doc.id) {
          t.update(walletRef, { pendingTopUp: null });
        }
        if (finalStatus === 'completed') {
          const amt = tx.amount || 0;
          t.update(walletRef, { balance: FieldValue.increment(amt), lastTopUp: Timestamp.now() });
        }
      }).catch(e => console.error('[sweepStaleWalletTopUps] txn error:', e.message));

      resolved++;
    }
    console.log(`[sweepStaleWalletTopUps] Resolved ${resolved}/${stale.size} stale top-ups`);
  }
);

// ─── 11. reconcilePayouts — safety net for stalled disbursements ─────────────
/**
 * Scheduled reconciliation. Finds payouts stuck mid-flight (a webhook was missed,
 * a CF crashed, or B2C initiate was ambiguous) and flags them for admin review so a
 * withdrawal can never silently orphan. It NEVER auto-refunds a 'processing' payout
 * (money may already have left) — it flags; a human resolves. Terminal states
 * (paid/rejected/failed) are ignored.
 *
 * NOTE: a provider status re-check (GET IntaSend transfer status) can be added once
 * the exact B2C status endpoint + payload are confirmed in sandbox; until then this
 * flags-for-review, which is the safe behaviour.
 */
exports.reconcilePayouts = onSchedule(
  { schedule: 'every 30 minutes', region: 'us-central1', timeoutSeconds: 120, memory: '256MiB' },
  async () => {
    const db     = getFirestore();
    const cutoff = Timestamp.fromMillis(Date.now() - 30 * 60 * 1000);   // stuck > 30 min
    const STUCK  = ['processing', 'approving', 'approval_failed'];

    let flagged = 0;
    for (const st of STUCK) {
      const snap = await db.collection('payoutRequests')
        .where('status', '==', st)
        .limit(100).get().catch(() => null);
      if (!snap || snap.empty) continue;

      for (const doc of snap.docs) {
        const p = doc.data();
        const updatedMs = p.updatedAt?.toMillis?.() ?? p.createdAt?.toMillis?.() ?? 0;
        if (updatedMs > cutoff.toMillis()) continue;          // not stale yet
        if (p.reconcileFlag === 'needs_review') continue;     // already flagged — idempotent

        await doc.ref.update({
          reconcileFlag: 'needs_review',
          reconcileFlaggedAt: Timestamp.now(),
          updatedAt: Timestamp.now(),
          statusHistory: FieldValue.arrayUnion(_payoutEvent('reconcile_review', `Stalled in "${st}" > 30 min — flagged for admin review`)),
        }).catch(() => {});
        flagged++;
      }
    }

    if (flagged > 0) {
      await _payoutMetric(db, 'reconcileExceptions', flagged);
      console.warn(`[reconcilePayouts] Flagged ${flagged} stalled payout(s) for review`);
    }
  }
);

// ─── 11b. processPayoutRetries — retry queue for transient B2C failures ──────
/**
 * Scheduled retry of payouts parked in 'retry_scheduled' whose backoff window has
 * elapsed. Re-runs _disburseB2C (which re-classifies: another transient error backs
 * off again up to PAYOUT_RETRY_MAX, then fails+refunds; a permanent error fails+
 * refunds immediately). Claims each atomically so a slow run can't double-fire.
 */
exports.processPayoutRetries = onSchedule(
  { schedule: 'every 5 minutes', region: 'us-central1', timeoutSeconds: 300, memory: '256MiB', secrets: [INTASEND_KEY] },
  async () => {
    const db  = getFirestore();
    const now = Date.now();
    const snap = await db.collection('payoutRequests')
      .where('status', '==', 'retry_scheduled').limit(50).get().catch(() => null);
    if (!snap || snap.empty) return;

    let ran = 0;
    for (const doc of snap.docs) {
      const p = doc.data();
      if (p.retryAt && p.retryAt.toMillis() > now) continue;   // backoff not elapsed
      /* Claim atomically: flip 'retry_scheduled' → 'approving' so a concurrent run
         can't disburse twice. */
      let claimed = false;
      await db.runTransaction(async (t) => {
        const s = await t.get(doc.ref);
        if (s.exists && s.data().status === 'retry_scheduled') {
          t.update(doc.ref, { status: 'approving', updatedAt: Timestamp.now() });
          claimed = true;
        }
      }).catch(() => {});
      if (!claimed) continue;
      _plog('retry_run', { ...p, id: doc.id }, { attempt: (p.retryCount || 0) + 1 });
      await _disburseB2C(db, doc.id, { ...p, id: doc.id });
      ran++;
    }
    if (ran) console.log(`[processPayoutRetries] ran ${ran} retr(y/ies)`);
  }
);

// ─── 12. getPayoutAnalytics — payout system health (admin) ───────────────────
/**
 * Aggregate the daily payoutMetrics counters over a window for an ops dashboard:
 * requests, approvals, successful (paid), failed, duplicates prevented, reconcile
 * exceptions, and average processing time.
 *
 * @param {{ days?: number }} data
 */
exports.getPayoutAnalytics = onCall({ cors: true, enforceAppCheck: true }, async (request) => {
  _requireAuth(request);
  _requireAdmin(request);

  const db   = getFirestore();
  const days = Math.min(Math.max(Number(request.data?.days) || 30, 1), 90);
  const ids  = [];
  for (let i = 0; i < days; i++) {
    ids.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  }

  const snaps = await db.getAll(...ids.map((d) => db.collection('payoutMetrics').doc(d)));
  const totals = {
    requests: 0, approvals: 0, paid: 0, rejected: 0, reversed: 0,
    instantAttempts: 0, b2cInitiated: 0, b2cErrors: 0, duplicatesPrevented: 0, reconcileExceptions: 0,
    processingMsTotal: 0, processingSamples: 0,
  };
  const daily = [];
  for (const s of snaps) {
    const d = s.exists ? s.data() : {};
    for (const k of Object.keys(totals)) totals[k] += Number(d[k] || 0);
    if (s.exists) {
      daily.push({
        date: d.date, requests: d.requests || 0, approvals: d.approvals || 0,
        paid: d.paid || 0, b2cErrors: d.b2cErrors || 0, reconcileExceptions: d.reconcileExceptions || 0,
      });
    }
  }
  daily.sort((a, b) => (a.date < b.date ? -1 : 1));

  const avgProcessingMs = totals.processingSamples > 0
    ? Math.round(totals.processingMsTotal / totals.processingSamples) : null;
  const successRate = totals.b2cInitiated > 0 ? +(totals.paid / totals.b2cInitiated * 100).toFixed(1) : null;
  const instantSuccessRate = totals.instantAttempts > 0
    ? +((totals.instantAttempts - totals.b2cErrors) / totals.instantAttempts * 100).toFixed(1) : null;

  return {
    windowDays: days,
    totals: {
      requests: totals.requests,
      approvals: totals.approvals,
      instantAttempts: totals.instantAttempts,
      successfulPayouts: totals.paid,
      rejected: totals.rejected,
      reversed: totals.reversed,
      failed: totals.b2cErrors,
      duplicatesPrevented: totals.duplicatesPrevented,
      reconciliationExceptions: totals.reconcileExceptions,
      avgPayoutSeconds: avgProcessingMs != null ? Math.round(avgProcessingMs / 1000) : null,
      webhookSuccessRate: successRate,
      instantSuccessRate,
    },
    daily,
  };
});

// ─── 12b. adminPayoutOps — real-time operational view for support ────────────
/**
 * Live operational snapshot of the payout pipeline for a support dashboard — no
 * manual Firestore querying. Returns counts by state, the oldest processing payout,
 * the most recent webhook received, the max retry count, and the working lists.
 */
exports.adminPayoutOps = onCall({ cors: true, enforceAppCheck: true }, async (request) => {
  _requireAuth(request);
  _requireAdmin(request);
  const db = getFirestore();

  const states = ['processing', 'retry_scheduled', 'failed', 'approval_failed', 'pending', 'approved', 'scheduled'];
  const byState = {};
  await Promise.all(states.map(async (st) => {
    const snap = await db.collection('payoutRequests').where('status', '==', st).limit(100).get().catch(() => null);
    byState[st] = snap ? snap.docs.map((d) => ({ id: d.id, ...d.data() })) : [];
  }));
  const all = [].concat(...Object.values(byState));

  let reconcileExceptions = 0, maxRetry = 0, oldestProcMs = null, lastWebhookMs = null;
  for (const p of all) {
    if (p.reconcileFlag === 'needs_review') reconcileExceptions++;
    if ((p.retryCount || 0) > maxRetry) maxRetry = p.retryCount;
    if (Array.isArray(p.webhookEvents) && p.webhookEvents.length) {
      const ms = p.webhookEvents[p.webhookEvents.length - 1]?.at?.toMillis?.() ?? null;
      if (ms && (lastWebhookMs === null || ms > lastWebhookMs)) lastWebhookMs = ms;
    }
  }
  for (const p of byState.processing) {
    const ms = p.b2cInitiatedAt?.toMillis?.() ?? p.updatedAt?.toMillis?.() ?? p.createdAt?.toMillis?.() ?? null;
    if (ms && (oldestProcMs === null || ms < oldestProcMs)) oldestProcMs = ms;
  }

  const mask = (a) => { const s = String(a || ''); if (s.length < 6) return s; const l = s.startsWith('254') ? '0' + s.slice(3) : s; return l.slice(0, 4) + '****' + l.slice(-3); };
  const trim = (list) => list.slice(0, 30).map((p) => ({
    id: p.id, sellerUid: p.sellerUid, amount: p.amount, status: p.status, mode: p.mode || null,
    method: p.method, destinationMasked: mask(p.accountNumber), intasendRef: p.intasendRef || null,
    retryCount: p.retryCount || 0, reconcileFlag: p.reconcileFlag || null,
    lastWebhookState: p.lastWebhookState || null, createdAt: p.createdAt, updatedAt: p.updatedAt || null,
  }));

  return {
    counts: {
      processing: byState.processing.length,
      retrying: byState.retry_scheduled.length,
      failed: byState.failed.length,
      approvalFailed: byState.approval_failed.length,
      pending: byState.pending.length,
      approved: byState.approved.length,
      scheduled: byState.scheduled.length,
      reconcileExceptions,
    },
    oldestProcessingAt: oldestProcMs ? new Date(oldestProcMs).toISOString() : null,
    lastWebhookAt: lastWebhookMs ? new Date(lastWebhookMs).toISOString() : null,
    maxRetryCount: maxRetry,
    lists: {
      processing:  trim(byState.processing),
      retrying:    trim(byState.retry_scheduled),
      failed:      trim(byState.failed),
      needsReview: trim(all.filter((p) => p.reconcileFlag === 'needs_review')),
      pending:     trim(byState.pending),
    },
  };
});

// ─── 13. finalizeB2CPayoutFromWebhook — called by the IntaSend webhook ────────
/**
 * Advance a B2C payout from an IntaSend webhook. Matches a payoutRequests doc by
 * id (api_ref === our reqId) or by intasendRef (tracking_id), then settles on a
 * COMPLETE state or refunds on a FAILED state. Idempotent (settle/refund guard on
 * terminal status). Returns true if it matched a payout so the webhook can stop.
 * NOT a Cloud Function — a plain helper the webhook in index.js invokes.
 */
exports.finalizeB2CPayoutFromWebhook = async function (db, ref, state, rawPayload) {
  if (!ref) return false;
  const rid = _san(ref, 128);

  let reqRef = db.collection('payoutRequests').doc(rid);
  let snap   = await reqRef.get();
  if (!snap.exists) {
    const q = await db.collection('payoutRequests').where('intasendRef', '==', ref).limit(1).get().catch(() => null);
    if (!q || q.empty) return false;                 // not one of our payouts
    reqRef = q.docs[0].ref; snap = q.docs[0];
  }

  const p  = snap.data();
  const st = String(state || '').toUpperCase();

  /* Audit: attach the raw (redacted) webhook payload to the payout record, so if
     IntaSend changes field names/formats we can see exactly what arrived. */
  await reqRef.update({
    updatedAt: Timestamp.now(),
    lastWebhookState: st,
    webhookEvents: FieldValue.arrayUnion({ state: st, at: Timestamp.now(), payload: _redact(rawPayload) }),
  }).catch(() => {});
  _plog('webhook_received', { ...p, id: reqRef.id }, { webhookState: st });

  const COMPLETE = ['COMPLETE', 'COMPLETED', 'SUCCESS', 'PAID', 'SETTLED'];
  const FAILED   = ['FAILED', 'FAILURE', 'CANCELLED', 'CANCELED', 'REJECTED'];
  const REVERSED = ['REVERSED', 'REVERSAL', 'REFUNDED', 'CHARGEBACK'];

  if (COMPLETE.includes(st)) {
    await _settlePayoutPaid(db, reqRef.id, { intasendRef: p.intasendRef || ref, webhookReceivedAt: Timestamp.now(), detail: `IntaSend B2C confirmed (${st})` });
    _plog('paid', { ...p, id: reqRef.id, status: 'paid' });   /* metric+latency inside _settlePayoutPaid */
  } else if (REVERSED.includes(st)) {
    await _reversePayout(db, reqRef.id, `IntaSend reversed (${st})`);
    await _payoutMetric(db, 'reversed');
    _plog('reversed', { ...p, id: reqRef.id, status: 'reversed' });
  } else if (FAILED.includes(st)) {
    /* _refundPayout is a no-op if already paid/terminal — never double-pays. */
    await _refundPayout(db, reqRef.id, 'failed', { detail: `IntaSend B2C failed (${st})` });
    await _payoutMetric(db, 'b2cErrors');
    _plog('failed', { ...p, id: reqRef.id, status: 'failed' }, { webhookState: st });
  } else {
    await reqRef.update({
      statusHistory: FieldValue.arrayUnion(_payoutEvent('processing', `IntaSend update: ${st}`)),
    }).catch(() => {});
  }
  return true;
};

// ─── 14. sweepEarningsToWallet — converge ecosystem earnings into ONE
//        withdrawable balance (Option A) ─────────────────────────────────────
/**
 * Ecosystem convergence. Marketplace / food / rider / service earnings are credited by
 * FinOS `creditWalletTxn` into availableBalance + withdrawableBalance (CENTS) — a ledger
 * the wallet withdrawal (requestSellerPayout, which reads `balance` in SHILLINGS) cannot
 * pay out, so those earnings were stranded. This scheduled job MOVES (not copies)
 * whole-shilling withdrawable earnings into `balance`, decrementing the FinOS fields in
 * the SAME transaction, so the money is in exactly ONE place at all times — no
 * double-withdrawal — and becomes withdrawable to M-Pesa. Idempotent (once moved the
 * source is 0, so re-runs are no-ops) and doubles as the one-off migration for existing
 * stranded funds. Sub-shilling remainders stay in FinOS until they accrue to a shilling.
 *
 * Note: provider-service booking earnings are credited to `balance` transactionally at
 * booking completion (provider-ops.js `providerCompleteBooking` → providerPayouts marked
 * `settled` + a `walletTransactions` row), so they do NOT flow through this FinOS sweep and
 * are never `pending` for the mechanism-1 payout scheduler. This job covers only the
 * FinOS-ledger flows (marketplace / food / rider) credited via `creditWalletTxn`.
 */
exports.sweepEarningsToWallet = onSchedule(
  { schedule: 'every 5 minutes', region: 'us-central1', timeoutSeconds: 300, memory: '256MiB' },
  async () => {
    const db = getFirestore();
    const snap = await db.collection('wallets')
      .where('withdrawableBalance', '>', 0).limit(200).get().catch(() => null);
    if (!snap || snap.empty) return;

    let moved = 0, totalShillings = 0;
    for (const doc of snap.docs) {
      await db.runTransaction(async (t) => {
        const s = await t.get(doc.ref);
        if (!s.exists) return;
        const d  = s.data();
        const wd = Number(d.withdrawableBalance || 0);   // cents
        const av = Number(d.availableBalance || 0);      // cents
        const moveCents = Math.min(wd, av);              // lockstep fields; move the safe minimum
        const moveShillings = Math.floor(moveCents / 100);
        if (moveShillings < 1) return;
        const backCents = moveShillings * 100;
        t.update(doc.ref, {
          balance:             FieldValue.increment(moveShillings),
          availableBalance:    FieldValue.increment(-backCents),
          withdrawableBalance: FieldValue.increment(-backCents),
          updatedAt:           Timestamp.now(),
        });
        t.set(db.collection('walletTransactions').doc(`${doc.id}_earnsettle_${Date.now()}`), {
          uid: doc.id, type: 'earning_settlement', amount: moveShillings,
          description: 'Earnings moved to your withdrawable wallet balance',
          status: 'completed', createdAt: Timestamp.now(),
        });
        moved++; totalShillings += moveShillings;
      }).catch((e) => console.error('[sweepEarningsToWallet] txn error', doc.id, e.message));
    }
    if (moved) console.log(`[sweepEarningsToWallet] moved KSh ${totalShillings} into withdrawable balance across ${moved} wallet(s)`);
  }
);
