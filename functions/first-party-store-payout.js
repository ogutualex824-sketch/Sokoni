'use strict';
/**
 * SOKONI STORE — operator payout (HELD: ships dark behind a server-only flag)
 * functions/first-party-store-payout.js
 *
 * Owner decisions 2026-10-01:
 *   · the store wallet is wallets/{businessId} = wallets/SOK-XX2338 — where the LIVE
 *     onOrderStatusChange archive settles store orders (order-settlement: wallets/{order.sellerUid});
 *   · the store's named operator withdraws from it, to ONE fixed destination, under the
 *     operator's OWN wallet PIN, required and fail-closed;
 *   · the code deploys DARK and the owner lifts the flag after the money-safety review.
 *
 * ── NO SECOND EXECUTION RAIL ─────────────────────────────────────────────────────────────
 * This module never calls IntaSend and never marks anything paid. It does exactly what
 * wallet.js requestSellerPayout does on its REVIEW path — reserve the amount on the wallet
 * (balance −= amt, pendingPayout += amt) and create payoutRequests/{pout_<key>} with status
 * 'pending', in ONE transaction — using wallet.js's own helpers (payoutEvent, eatDay,
 * getPayoutConfig). The request carries sellerUid = 'SOK-XX2338', so the EXISTING admin path
 * (adminProcessPayout → _disburseB2C / _settlePayoutPaid / _refundPayout, all keyed on
 * payout.sellerUid) approves, pays, rejects or refunds it against wallets/SOK-XX2338.
 * There is no 'instant' mode here: every store withdrawal waits for an admin.
 *
 * ── THE GATES, IN ORDER (each refusal carries a stable details.reason) ──────────────────
 *   1. signed in + App Check                              (onCall enforceAppCheck)
 *   2. caller is the store operator                       not-store-operator
 *   3. flag firstPartyStoreConfig/payouts.enabled === true store-payouts-not-enabled
 *   4. operator's own wallet has a PIN                    pin-not-set   ("Set your wallet PIN first")
 *   5. PIN correct (wallet-engine _assertPinOk: same hash, same attempt counter, lock at cap)
 *   6. destination: set-destination requires the number == the operator's VERIFIED Firebase Auth
 *      phone; the request takes NO destination from the client — it pays the stored one only.
 *   7. amount: integer KES ≥ 100 (the pipeline's minimum), ≤ the wallet balance read INSIDE the
 *      transaction; velocity cap per EAT day from config/payouts.maxPayoutsPerDay (same as sellers).
 *   8. idempotency: client requestId → payoutRequests/pout_<requestId>, claimed with a
 *      transactional create(); a replay returns the first result and reserves nothing again.
 *
 * FLAG: firstPartyStoreConfig/payouts { enabled: true } — a server-only collection (no rules
 * match → no client, admin or otherwise, can write it). Absent or anything but `true` = OFF.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const OP = require('./first-party-store-operator');

const OPTS = { region: 'us-central1', maxInstances: 5, memory: '256MiB', timeoutSeconds: 30, enforceAppCheck: true };
const FLAG = Object.freeze({ collection: 'firstPartyStoreConfig', doc: 'payouts', field: 'enabled' });
const AUDIT = 'firstPartyStoreAudit';
const MIN_PAYOUT_KES = 100;           /* requestSellerPayout's own minimum */

const REASON = Object.freeze({
  DISABLED: 'store-payouts-not-enabled',
  PIN_NOT_SET: 'pin-not-set',
  PIN_REQUIRED: 'pin-required',
  PHONE_UNVERIFIED: 'operator-phone-not-verified',
  PHONE_MISMATCH: 'destination-not-operator-verified-phone',
  NO_DESTINATION: 'payout-destination-not-set',
  BAD_AMOUNT: 'invalid-amount',
  BAD_REQUEST_ID: 'invalid-request-id',
  NO_SETTLED_SALES: 'no-store-sale-settled-yet',
  INSUFFICIENT: 'insufficient-store-balance',
  VELOCITY: 'daily-payout-limit',
  FROZEN: 'store-wallet-frozen',
});

function _db() {
  const admin = require('firebase-admin');
  if (!admin.apps.length) admin.initializeApp();
  return admin.firestore();
}
function _auth() {
  return require('firebase-admin/auth').getAuth();
}
const _h = {};
exports._h = _h;

/** +2547XXXXXXXX / +2541XXXXXXXX, or null. */
function normalizeKePhone(raw) {
  const s = String(raw == null ? '' : raw).replace(/[\s\-()]/g, '');
  let m = s.match(/^\+?254([17]\d{8})$/);
  if (m) return '+254' + m[1];
  m = s.match(/^0([17]\d{8})$/);
  if (m) return '+254' + m[1];
  return null;
}
const last3 = (v) => String(v || '').replace(/\D/g, '').slice(-3) || null;
const _refuse = (code, reason, message) => new HttpsError(code, message, { reason });

async function _flagOn(db) {
  const snap = await db.collection(FLAG.collection).doc(FLAG.doc).get();
  return snap.exists && (snap.data() || {})[FLAG.field] === true;
}

/** Gate 2 + 3: operator first (a non-operator never learns the flag state), then the flag. */
async function _gate(req, db) {
  const gate = await OP.assertStoreOperator(req, db);
  if (!(await _flagOn(db))) {
    throw _refuse('failed-precondition', REASON.DISABLED, 'Store withdrawals are awaiting owner approval.');
  }
  return gate;
}

/** Gate 4 + 5: the OPERATOR's own wallet PIN, required and fail-closed. */
async function _assertOperatorPin(db, operatorUid, pin) {
  const w = await db.collection('wallets').doc(operatorUid).get();
  const hasPin = w.exists && !!(w.data() || {}).pinHash;
  if (!hasPin) {
    /* _assertPinOk PASSES a wallet with no PIN configured; that absence must never be a pass here. */
    throw _refuse('failed-precondition', REASON.PIN_NOT_SET, 'Set your wallet PIN first.');
  }
  if (pin == null || !/^\d{4}$/.test(String(pin))) {
    throw _refuse('failed-precondition', REASON.PIN_REQUIRED, 'Enter your 4-digit wallet PIN.');
  }
  const { assertPinOk } = require('./wallet-engine')._internal;
  await assertPinOk(db, operatorUid, String(pin));   /* throws permission-denied on a wrong PIN; locks at the cap */
}

async function _audit(db, entry) {
  try { await db.collection(AUDIT).add(Object.assign({ createdAt: new Date() }, entry)); }
  catch (e) { console.error('[sokoniStorePayout] audit write failed', entry.action, e && e.message); }
}

/* ══════════════════════════════════════════════════════════════════════════════
   SET DESTINATION — operator + PIN + number == the operator's verified Auth phone.
   ══════════════════════════════════════════════════════════════════════════════ */
_h.sokoniStoreSetPayoutDestination = async (req, dbOverride, authOverride) => {
  const db = dbOverride || _db();
  const gate = await _gate(req, db);
  const d = req.data || {};
  await _assertOperatorPin(db, gate.uid, d.pin);

  const requested = normalizeKePhone(d.msisdn);
  /* The server's own copy of the account — not the client's token, not a users/ doc. */
  const user = await (authOverride || _auth()).getUser(gate.uid);
  const verified = normalizeKePhone(user && user.phoneNumber);
  if (!verified) {
    throw _refuse('failed-precondition', REASON.PHONE_UNVERIFIED,
      'Verify a phone number on your account first; payouts can only go to your verified number.');
  }
  if (!requested || requested !== verified) {
    await _audit(db, { action: 'sokoniStore.setPayoutDestination.refused', operatorUid: gate.uid,
      storeId: gate.storeId, businessId: gate.businessId, reason: REASON.PHONE_MISMATCH, destinationLast3: last3(requested) });
    throw _refuse('permission-denied', REASON.PHONE_MISMATCH,
      'The payout number must be your own verified phone number.');
  }

  const recRef = db.collection(OP.OPERATORS).doc(gate.storeId);
  const now = new Date();
  await db.runTransaction(async (t) => {
    const s = await t.get(recRef);
    const rec = s.exists ? s.data() : null;
    /* Re-prove inside the write: the operator record must still authorise this caller. */
    if (!OP.recordAuthorises(rec, { ok: true, storeId: gate.storeId, businessId: gate.businessId, ownerUid: gate.ownerUid }, gate.uid)) {
      throw _refuse('permission-denied', OP.REASON.NOT_OPERATOR, 'Access denied — the SOKONI Store is operated by its owner.');
    }
    t.update(recRef, { payoutDestination: { msisdn: requested, setAt: now, setBy: gate.uid } });
  });
  await _audit(db, { action: 'sokoniStore.setPayoutDestination', operatorUid: gate.uid,
    storeId: gate.storeId, businessId: gate.businessId, destinationLast3: last3(requested) });
  return { ok: true, payoutDestination: { status: 'set', last3: last3(requested) } };
};

/* ══════════════════════════════════════════════════════════════════════════════
   REQUEST — reserve + create the payoutRequests doc in ONE transaction, requestSellerPayout's
   shape, status 'pending' (admin review). Pays the STORED destination only.
   ══════════════════════════════════════════════════════════════════════════════ */
_h.sokoniStorePayoutRequest = async (req, dbOverride) => {
  const db = dbOverride || _db();
  const gate = await _gate(req, db);
  const d = req.data || {};

  /* Same throttle as requestSellerPayout (resource-exhausted when exceeded). */
  const { checkRateLimit } = require('./redis-rate-limiter');
  await checkRateLimit(req, 'payment');

  await _assertOperatorPin(db, gate.uid, d.pin);

  const amt = Number(d.amount);
  if (!Number.isInteger(amt) || amt < MIN_PAYOUT_KES) {
    throw _refuse('invalid-argument', REASON.BAD_AMOUNT, 'Minimum payout amount is KSh ' + MIN_PAYOUT_KES + '.');
  }
  const key = String(d.requestId == null ? '' : d.requestId);
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(key)) {
    throw _refuse('invalid-argument', REASON.BAD_REQUEST_ID, 'A request id is required.');
  }
  /* The destination is the STORED one. Anything the client sends as a number is ignored. */
  const dest = gate.record && gate.record.payoutDestination && normalizeKePhone(gate.record.payoutDestination.msisdn);
  if (!dest) throw _refuse('failed-precondition', REASON.NO_DESTINATION, 'Set the store payout number first.');

  const W = require('./wallet')._internal;
  const cfg = await W.getPayoutConfig(db);
  const walletId = gate.businessId;                         /* wallets/SOK-XX2338 */
  const reqId = 'pout_' + key;
  const walletRef = db.collection('wallets').doc(walletId);
  const reqRef = db.collection('payoutRequests').doc(reqId);
  const velocityRef = db.collection('payoutVelocity').doc(walletId);
  const today = W.eatDay();
  const now = new Date();

  let deduplicated = false, existing = null;
  await db.runTransaction(async (t) => {
    const [walletSnap, velocitySnap, reqSnap] = await Promise.all([t.get(walletRef), t.get(velocityRef), t.get(reqRef)]);
    if (reqSnap.exists) { deduplicated = true; existing = reqSnap.data(); return; }

    if (!walletSnap.exists) throw _refuse('failed-precondition', REASON.NO_SETTLED_SALES, 'No store sale has settled yet.');
    const w = walletSnap.data() || {};
    if (w.frozen === true) throw _refuse('failed-precondition', REASON.FROZEN, 'The store wallet is frozen.');
    const maxPerDay = Number(cfg.maxPayoutsPerDay) || 3;
    const vel = velocitySnap.exists ? velocitySnap.data() : null;
    const todayCount = (vel && vel.date === today) ? (vel.count || 0) : 0;
    if (todayCount >= maxPerDay) {
      throw _refuse('resource-exhausted', REASON.VELOCITY, `Maximum ${maxPerDay} payout requests per day. Please try again tomorrow.`);
    }
    const balance = typeof w.balance === 'number' ? w.balance : 0;
    if (balance < amt) throw _refuse('failed-precondition', REASON.INSUFFICIENT, 'Insufficient store balance for this payout.');

    /* Exactly requestSellerPayout's reserve + request, on the review path. */
    t.set(velocityRef, { date: today, count: todayCount + 1, updatedAt: now }, { merge: true });
    t.update(walletRef, { balance: balance - amt, pendingPayout: (typeof w.pendingPayout === 'number' ? w.pendingPayout : 0) + amt });
    t.create(reqRef, {
      sellerUid:     walletId,
      correlationId: reqId,
      amount:        amt,
      fee:           0,
      netAmount:     amt,
      method:        'mpesa',
      accountNumber: dest,
      bankCode:      null,
      bankName:      null,
      mode:          'review',
      riskReasons:   ['first_party_store_operator'],
      status:        'pending',
      statusHistory: [W.payoutEvent('requested', 'Request submitted'),
                      W.payoutEvent('pending', 'SOKONI Store withdrawal — queued for admin review')],
      intasendRef:   null,
      note:          null,
      processedAt:   null,
      createdAt:     now,
      updatedAt:     now,
    });
  });

  if (deduplicated) {
    return { ok: true, deduplicated: true, requestId: reqId, status: existing && existing.status,
             amount: existing && existing.amount, destinationLast3: last3(existing && existing.accountNumber) };
  }
  await _audit(db, { action: 'sokoniStore.payoutRequest', operatorUid: gate.uid, storeId: gate.storeId,
    businessId: gate.businessId, walletId, amount: amt, destinationLast3: last3(dest), requestId: reqId });
  return { ok: true, requestId: reqId, status: 'pending', amount: amt, destinationLast3: last3(dest),
           message: 'Submitted — under review. Funds arrive once an admin approves.' };
};

exports.sokoniStoreSetPayoutDestination = onCall(OPTS, (req) => _h.sokoniStoreSetPayoutDestination(req));
exports.sokoniStorePayoutRequest        = onCall(OPTS, (req) => _h.sokoniStorePayoutRequest(req));

exports._internal = Object.freeze({ FLAG, REASON, MIN_PAYOUT_KES, normalizeKePhone, last3, flagOn: _flagOn });
