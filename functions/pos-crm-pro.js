'use strict';

/**
 * pos-crm-pro.js — SOKONI SmartPOS CRM Pro Engine
 *
 * Sections:
 *   A. Customer Wallet
 *   B. Gift Cards
 *   C. Store Credit
 *   D. Birthday Rewards
 *   E. Referral Rewards
 *   F. Personalized Offers
 *   G. Customer Segmentation
 *   H. Membership Tiers
 *   I. Scheduled: birthdayRewardSweep
 *
 * Currency: KES
 * Loyalty:  1 point per KES 10 spent
 * Tiers:    Bronze(0) | Silver(1000) | Gold(5000) | Platinum(20000)
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }         = require('firebase-functions/v2/scheduler');
const admin                  = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();

exports._h = {}; // handler registry — consumed by smartpos-dispatch.js
const db = admin.firestore();

// ─── Shared config ────────────────────────────────────────────────────────────
const _CF  = { region: 'us-central1', enforceAppCheck: true };
const _TS  = () => admin.firestore.FieldValue.serverTimestamp();
const _INC = (n) => admin.firestore.FieldValue.increment(n);

// ─── Auth helpers ──────────────────────────────────────────────────────────────
function _requireAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
  return req.auth;
}

function _requireRole(auth, minRole) {
  const levels = { cashier: 0, supervisor: 1, manager: 2, owner: 3 };
  const actual  = levels[auth.token?.posRole || 'cashier'] ?? 0;
  const required = levels[minRole] ?? 0;
  if (actual < required)
    throw new HttpsError('permission-denied', `Requires ${minRole} role`);
}

// ─── Validation helpers ────────────────────────────────────────────────────────
function _requireFields(data, fields) {
  for (const f of fields) {
    if (data[f] === undefined || data[f] === null || data[f] === '')
      throw new HttpsError('invalid-argument', `Missing required field: ${f}`);
  }
}

function _normalizePhone(phone) {
  const s = String(phone).replace(/\D/g, '');
  if (s.startsWith('254') && s.length === 12) return s;
  if (s.startsWith('0') && s.length === 10) return '254' + s.slice(1);
  if (s.length === 9) return '254' + s;
  throw new HttpsError('invalid-argument', `Invalid phone number: ${phone}`);
}

function _validateAmount(amount, fieldName = 'amount') {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0)
    throw new HttpsError('invalid-argument', `${fieldName} must be a positive number`);
  return Math.round(n * 100) / 100; // round to 2 dp
}

// ─── Loyalty helpers ───────────────────────────────────────────────────────────
const TIER_THRESHOLDS = { Bronze: 0, Silver: 1000, Gold: 5000, Platinum: 20000 };

function _tierFromPoints(points) {
  if (points >= 20000) return 'Platinum';
  if (points >= 5000)  return 'Gold';
  if (points >= 1000)  return 'Silver';
  return 'Bronze';
}

function _pointsForSpend(kes) {
  return Math.floor(kes / 10);
}

// ─── Wallet doc key ───────────────────────────────────────────────────────────
function _walletId(sellerId, phone) {
  return `${sellerId}_${phone}`;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION A — Customer Wallet
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * getWalletBalance
 * Returns the customer wallet balance and last 10 transactions.
 */
/* Dispatcher key namespaced posGetWalletBalance to avoid a cross-domain name
   clash with the global wallet CF. Caller: pos-crm-pro.html cf('posGetWalletBalance'). */
exports.getWalletBalance = onCall(_CF, exports._h.posGetWalletBalance = async (req) => {
  _requireAuth(req);
  const { sellerId, phone } = req.data;
  _requireFields(req.data, ['sellerId', 'phone']);
  const normPhone = _normalizePhone(phone);
  const walletId  = _walletId(sellerId, normPhone);

  const [walletSnap, txSnap] = await Promise.all([
    db.collection('posWallets').doc(walletId).get(),
    db.collection('posWalletTransactions')
      .where('sellerId', '==', sellerId)
      .where('phone', '==', normPhone)
      .orderBy('createdAt', 'desc')
      .limit(10)
      .get(),
  ]);

  const balance = walletSnap.exists ? (walletSnap.data().balance ?? 0) : 0;
  const transactions = txSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  return { balance, transactions };
});

/**
 * topUpWallet
 * Role: manager+. Credits funds to a customer wallet.
 */
exports.topUpWallet = onCall(_CF, exports._h.topUpWallet = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');
  const { sellerId, phone, amount, method, ref } = req.data;
  _requireFields(req.data, ['sellerId', 'phone', 'amount', 'method']);
  const normPhone  = _normalizePhone(phone);
  const safeAmount = _validateAmount(amount);
  const walletId   = _walletId(sellerId, normPhone);

  const batch = db.batch();

  const walletRef = db.collection('posWallets').doc(walletId);
  batch.set(
    walletRef,
    {
      sellerId,
      phone: normPhone,
      balance: _INC(safeAmount),
      updatedAt: _TS(),
    },
    { merge: true }
  );

  const txRef = db.collection('posWalletTransactions').doc();
  batch.set(txRef, {
    sellerId,
    phone: normPhone,
    type: 'topup',
    amount: safeAmount,
    method: method || 'cash',
    ref: ref || null,
    performedBy: auth.uid,
    createdAt: _TS(),
  });

  await batch.commit();
  return { ok: true, credited: safeAmount };
});

/**
 * deductWallet
 * Deducts funds from customer wallet for a POS sale.
 * Runs inside a Firestore transaction to guarantee balance safety.
 */
exports.deductWallet = onCall(_CF, exports._h.deductWallet = async (req) => {
  _requireAuth(req);
  const { sellerId, phone, amount, saleId } = req.data;
  _requireFields(req.data, ['sellerId', 'phone', 'amount', 'saleId']);
  const normPhone  = _normalizePhone(phone);
  const safeAmount = _validateAmount(amount);
  const walletId   = _walletId(sellerId, normPhone);

  const walletRef = db.collection('posWallets').doc(walletId);
  const txDocRef  = db.collection('posWalletTransactions')
    .doc(`${sellerId}_${normPhone}_${saleId}_deduct`);

  await db.runTransaction(async (tx) => {
    const [snap, txSnap] = await Promise.all([tx.get(walletRef), tx.get(txDocRef)]);
    if (txSnap.exists) return; // idempotent — already deducted on prior attempt
    const balance = snap.exists ? (snap.data().balance ?? 0) : 0;
    if (balance < safeAmount)
      throw new HttpsError('failed-precondition', 'Insufficient wallet balance');

    tx.set(
      walletRef,
      { balance: _INC(-safeAmount), updatedAt: _TS() },
      { merge: true }
    );

    tx.set(txDocRef, {
      sellerId,
      phone: normPhone,
      type: 'purchase',
      amount: -safeAmount,
      saleId,
      createdAt: _TS(),
    });
  });

  return { ok: true, deducted: safeAmount };
});

/**
 * refundToWallet
 * Role: manager+. Refunds an amount back to the customer wallet.
 */
exports.refundToWallet = onCall(_CF, exports._h.posRefundToWallet = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');
  const { sellerId, phone, amount, saleId, reason } = req.data;
  _requireFields(req.data, ['sellerId', 'phone', 'amount']);
  const normPhone  = _normalizePhone(phone);
  const safeAmount = _validateAmount(amount);
  const walletId   = _walletId(sellerId, normPhone);

  /* ── IDEMPOTENT refund ──
       Previously this used db.batch() with _INC() and an auto-id .doc() — atomic, but NOT
       idempotent. A manager tapping "Refund" twice, or a retried call, CREDITED THE WALLET
       TWICE with two orphan transaction rows. deductWallet gets this right; the refund path did
       not inherit it. It is now keyed (client idempotencyKey, else the original sale id) and
       written inside a transaction that skips a repeat — deductWallet's exact pattern. */
    const refundKey = (String(req.data.idempotencyKey || req.data.originalSaleId || saleId || '')
      .replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100))
      || (Date.now().toString(36) + '_' + auth.uid);   /* Firestore-id-safe, non-empty */
    const walletRef = db.collection('posWallets').doc(walletId);
    const txDocRef  = db.collection('posWalletTransactions')
      .doc(sellerId + '_' + normPhone + '_' + refundKey + '_refund');

    const applied = await db.runTransaction(async (tx) => {
      const txSnap = await tx.get(txDocRef);
      if (txSnap.exists) return false;   /* already refunded under this key — idempotent no-op */
      tx.set(walletRef,
        { sellerId, phone: normPhone, balance: _INC(safeAmount), updatedAt: _TS() },
        { merge: true });
      tx.set(txDocRef, {
        sellerId,
        phone:          normPhone,
        type:           'refund',
        amount:         safeAmount,
        saleId:         saleId || req.data.originalSaleId || null,
        idempotencyKey: refundKey,
        reason:         reason || null,
        performedBy:    auth.uid,
        createdAt:      _TS(),
      });
      return true;
    });

    return { ok: true, refunded: safeAmount, idempotent: !applied };
});

/**
 * getWalletTransactions
 * Returns the last 50 wallet transactions for a customer.
 */
exports.getWalletTransactions = onCall(_CF, exports._h.posGetWalletTransactions = async (req) => {
  _requireAuth(req);
  const { sellerId, phone } = req.data;
  _requireFields(req.data, ['sellerId', 'phone']);
  const normPhone = _normalizePhone(phone);

  const snap = await db.collection('posWalletTransactions')
    .where('sellerId', '==', sellerId)
    .where('phone', '==', normPhone)
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();

  return { transactions: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION B — Gift Cards
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const GIFT_CARD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // omit 0/O/1/I

function _generateGiftCardCode() {
  let code = '';
  const arr = new Uint8Array(12);
  // Use crypto.getRandomValues equivalent via Node built-in
  const { randomBytes } = require('crypto');
  const buf = randomBytes(12);
  for (let i = 0; i < 12; i++) {
    code += GIFT_CARD_CHARS[buf[i] % GIFT_CARD_CHARS.length];
  }
  return code; // e.g. "XK8M2PNQ7TRV"
}

/**
 * issueGiftCard
 * Role: manager+. Creates a new gift card with a unique 12-char code.
 */
exports.issueGiftCard = onCall(_CF, exports._h.issueGiftCard = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');
  const { sellerId, amount, recipientName, recipientPhone } = req.data;
  _requireFields(req.data, ['sellerId', 'amount']);
  const safeAmount = _validateAmount(amount);

  // Generate unique code — retry up to 5 times on collision
  let code;
  let attempts = 0;
  while (attempts < 5) {
    code = _generateGiftCardCode();
    const existing = await db.collection('posGiftCards').doc(code).get();
    if (!existing.exists) break;
    attempts++;
    if (attempts === 5)
      throw new HttpsError('internal', 'Failed to generate unique gift card code');
  }

  const expiryDate = new Date();
  expiryDate.setFullYear(expiryDate.getFullYear() + 1);

  await db.collection('posGiftCards').doc(code).set({
    sellerId,
    code,
    amount: safeAmount,
    remaining: safeAmount,
    status: 'active',
    recipientName: recipientName || null,
    recipientPhone: recipientPhone ? _normalizePhone(recipientPhone) : null,
    issuedBy: auth.uid,
    issuedAt: _TS(),
    expiryDate: admin.firestore.Timestamp.fromDate(expiryDate),
    redemptions: [],
  });

  return { ok: true, code, amount: safeAmount, expiryDate: expiryDate.toISOString() };
});

/**
 * redeemGiftCard
 * Validates and redeems a gift card at checkout.
 */
exports.redeemGiftCard = onCall(_CF, exports._h.redeemGiftCard = async (req) => {
  _requireAuth(req);
  const { sellerId, code, amount, saleId } = req.data;
  _requireFields(req.data, ['sellerId', 'code', 'amount', 'saleId']);
  const safeAmount = _validateAmount(amount);

  const cardRef = db.collection('posGiftCards').doc(String(code).toUpperCase().trim());

  const newBalance = await db.runTransaction(async (tx) => {
    const snap = await tx.get(cardRef);
    if (!snap.exists)
      throw new HttpsError('not-found', 'Gift card not found');

    const card = snap.data();

    if (card.sellerId !== sellerId)
      throw new HttpsError('permission-denied', 'Gift card belongs to a different seller');
    if (card.status !== 'active')
      throw new HttpsError('failed-precondition', `Gift card is ${card.status}`);

    const now = new Date();
    if (card.expiryDate && card.expiryDate.toDate() < now)
      throw new HttpsError('failed-precondition', 'Gift card has expired');

    if ((card.remaining ?? 0) < safeAmount)
      throw new HttpsError('failed-precondition', 'Insufficient gift card balance');

    const newRemaining = Math.round(((card.remaining ?? 0) - safeAmount) * 100) / 100;
    const newStatus    = newRemaining <= 0 ? 'depleted' : 'active';

    tx.update(cardRef, {
      remaining: newRemaining,
      status: newStatus,
      updatedAt: _TS(),
      redemptions: admin.firestore.FieldValue.arrayUnion({
        saleId,
        amount: safeAmount,
        redeemedAt: new Date().toISOString(),
      }),
    });

    return newRemaining;
  });

  return { ok: true, newBalance };
});

/**
 * checkGiftCardBalance
 * No auth required — cashier can scan QR to check balance.
 */
exports.checkGiftCardBalance = onCall({ region: 'us-central1', enforceAppCheck: true }, exports._h.checkGiftCardBalance = async (req) => {
  const { code } = req.data;
  if (!code) throw new HttpsError('invalid-argument', 'Gift card code required');

  const snap = await db.collection('posGiftCards').doc(String(code).toUpperCase().trim()).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Gift card not found');

  const { remaining, status, expiryDate } = snap.data();
  return {
    remaining: remaining ?? 0,
    status,
    expiryDate: expiryDate ? expiryDate.toDate().toISOString() : null,
  };
});

/**
 * getGiftCards
 * Role: manager+. List gift cards for seller, optionally filtered by status.
 */
exports.getGiftCards = onCall(_CF, exports._h.getGiftCards = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');
  const { sellerId, status } = req.data;
  _requireFields(req.data, ['sellerId']);

  let query = db.collection('posGiftCards')
    .where('sellerId', '==', sellerId)
    .orderBy('issuedAt', 'desc')
    .limit(50);

  if (status) query = query.where('status', '==', status);

  const snap = await query.get();
  return { cards: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION C — Store Credit
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * issueStoreCredit
 * Role: manager+. Add store credit to a customer account.
 */
exports.issueStoreCredit = onCall(_CF, exports._h.issueStoreCredit = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');
  const { sellerId, phone, amount, reason } = req.data;
  _requireFields(req.data, ['sellerId', 'phone', 'amount', 'reason']);
  const normPhone  = _normalizePhone(phone);
  const safeAmount = _validateAmount(amount);

  const customerRef = db.collection('posCustomers').doc(`${sellerId}_${normPhone}`);

  const batch = db.batch();
  batch.set(customerRef, { storeCredit: _INC(safeAmount), updatedAt: _TS() }, { merge: true });

  const logRef = db.collection('posStoreCreditLog').doc();
  batch.set(logRef, {
    sellerId,
    phone: normPhone,
    type: 'issue',
    amount: safeAmount,
    reason,
    performedBy: auth.uid,
    createdAt: _TS(),
  });

  await batch.commit();
  return { ok: true, credited: safeAmount };
});

/**
 * useStoreCredit
 * Deducts store credit at checkout. Runs in a Firestore transaction.
 */
exports.useStoreCredit = onCall(_CF, exports._h.useStoreCredit = async (req) => {
  _requireAuth(req);
  const { sellerId, phone, amount, saleId } = req.data;
  _requireFields(req.data, ['sellerId', 'phone', 'amount', 'saleId']);
  const normPhone  = _normalizePhone(phone);
  const safeAmount = _validateAmount(amount);

  const customerRef = db.collection('posCustomers').doc(`${sellerId}_${normPhone}`);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(customerRef);
    if (!snap.exists)
      throw new HttpsError('not-found', 'Customer not found');

    const credit = snap.data().storeCredit ?? 0;
    if (credit < safeAmount)
      throw new HttpsError('failed-precondition', 'Insufficient store credit');

    tx.update(customerRef, { storeCredit: _INC(-safeAmount), updatedAt: _TS() });

    const logRef = db.collection('posStoreCreditLog').doc();
    tx.set(logRef, {
      sellerId,
      phone: normPhone,
      type: 'use',
      amount: -safeAmount,
      saleId,
      createdAt: _TS(),
    });
  });

  return { ok: true, deducted: safeAmount };
});

/**
 * getStoreCreditBalance
 * Returns a customer's current store credit balance.
 */
exports.getStoreCreditBalance = onCall(_CF, exports._h.getStoreCreditBalance = async (req) => {
  _requireAuth(req);
  const { sellerId, phone } = req.data;
  _requireFields(req.data, ['sellerId', 'phone']);
  const normPhone = _normalizePhone(phone);

  const snap = await db.collection('posCustomers').doc(`${sellerId}_${normPhone}`).get();
  if (!snap.exists) return { storeCredit: 0 };

  return { storeCredit: snap.data().storeCredit ?? 0 };
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION D — Birthday Rewards
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const BIRTHDAY_BONUS_POINTS = 200;
const BIRTHDAY_WINDOW_DAYS  = 7;

/**
 * _isWithinBirthdayWindow
 * Returns true if the given month/day is within BIRTHDAY_WINDOW_DAYS of today.
 */
function _isWithinBirthdayWindow(birthdayMonth, birthdayDay) {
  const today = new Date();
  const thisYear = today.getFullYear();

  // Construct birthday this year and next year (handles Dec→Jan edge)
  const candidates = [
    new Date(thisYear,     birthdayMonth - 1, birthdayDay),
    new Date(thisYear + 1, birthdayMonth - 1, birthdayDay),
  ];

  for (const bday of candidates) {
    const diffMs   = bday - today;
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    if (diffDays >= 0 && diffDays < BIRTHDAY_WINDOW_DAYS) return true;
    // Also allow -1 day for timezone edge
    if (diffDays >= -1 && diffDays < 0) return true;
  }
  return false;
}

/**
 * checkBirthdayReward
 * Awards 200 bonus points if today is within 7 days of customer birthday
 * and reward hasn't been given this calendar year.
 */
exports.checkBirthdayReward = onCall(_CF, exports._h.checkBirthdayReward = async (req) => {
  _requireAuth(req);
  const { sellerId, phone } = req.data;
  _requireFields(req.data, ['sellerId', 'phone']);
  const normPhone = _normalizePhone(phone);

  const customerRef = db.collection('posCustomers').doc(`${sellerId}_${normPhone}`);
  const snap        = await customerRef.get();

  if (!snap.exists) return { rewarded: false, points: 0, reason: 'Customer not found' };

  const customer    = snap.data();
  const currentYear = new Date().getFullYear();

  if (!customer.birthdayMonth || !customer.birthdayDay)
    return { rewarded: false, points: 0, reason: 'Birthday not set' };

  if (customer.lastBirthdayRewardYear === currentYear)
    return { rewarded: false, points: 0, reason: 'Already rewarded this year' };

  if (!_isWithinBirthdayWindow(customer.birthdayMonth, customer.birthdayDay))
    return { rewarded: false, points: 0, reason: 'Not within birthday window' };

  // Award points
  const newPoints = (customer.loyaltyPoints ?? 0) + BIRTHDAY_BONUS_POINTS;
  const newTier   = _tierFromPoints(newPoints);

  await customerRef.update({
    loyaltyPoints: _INC(BIRTHDAY_BONUS_POINTS),
    tier: newTier,
    lastBirthdayRewardYear: currentYear,
    updatedAt: _TS(),
  });

  // Log in notification queue
  await db.collection('posNotificationQueue').add({
    sellerId,
    phone: normPhone,
    type: 'birthday_reward',
    points: BIRTHDAY_BONUS_POINTS,
    customerName: customer.name || null,
    status: 'pending',
    createdAt: _TS(),
  });

  return { rewarded: true, points: BIRTHDAY_BONUS_POINTS, newTier };
});

/**
 * getBirthdayCustomers
 * Role: manager+. Returns customers with birthdays in the next 30 days.
 */
exports.getBirthdayCustomers = onCall(_CF, exports._h.getBirthdayCustomers = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');
  const { sellerId } = req.data;
  _requireFields(req.data, ['sellerId']);

  const today = new Date();

  // Collect upcoming months (handles Dec→Jan)
  const months = new Set();
  for (let i = 0; i < 30; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    months.add(d.getMonth() + 1); // 1-indexed
  }

  const monthsArray = Array.from(months);

  // Query by seller + birthdayMonth in upcoming months
  const snap = await db.collection('posCustomers')
    .where('sellerId', '==', sellerId)
    .where('birthdayMonth', 'in', monthsArray)
    .limit(200)
    .get();

  // Filter to only those within 30 days
  const results = [];
  for (const doc of snap.docs) {
    const c = doc.data();
    if (!c.birthdayDay || !c.birthdayMonth) continue;

    // Check each candidate year
    const thisYear = today.getFullYear();
    const candidates = [
      new Date(thisYear,     c.birthdayMonth - 1, c.birthdayDay),
      new Date(thisYear + 1, c.birthdayMonth - 1, c.birthdayDay),
    ];
    for (const bday of candidates) {
      const diffDays = (bday - today) / (1000 * 60 * 60 * 24);
      if (diffDays >= -1 && diffDays <= 30) {
        results.push({
          id: doc.id,
          name: c.name,
          phone: c.phone,
          birthdayMonth: c.birthdayMonth,
          birthdayDay: c.birthdayDay,
          daysUntilBirthday: Math.round(diffDays),
          tier: c.tier || 'Bronze',
        });
        break;
      }
    }
  }

  results.sort((a, b) => a.daysUntilBirthday - b.daysUntilBirthday);
  return { customers: results, total: results.length };
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION E — Referral Rewards
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const REFERRAL_POINTS = 500;

/**
 * recordReferral
 * Records the referral intent. Points are awarded only on first purchase.
 */
exports.recordReferral = onCall(_CF, exports._h.recordReferral = async (req) => {
  _requireAuth(req);
  const { sellerId, referrerPhone, referredPhone } = req.data;
  _requireFields(req.data, ['sellerId', 'referrerPhone', 'referredPhone']);
  const normReferrer = _normalizePhone(referrerPhone);
  const normReferred = _normalizePhone(referredPhone);

  if (normReferrer === normReferred)
    throw new HttpsError('invalid-argument', 'Cannot refer yourself');

  // Prevent duplicate pending referral
  const existing = await db.collection('posReferrals')
    .where('sellerId', '==', sellerId)
    .where('referredPhone', '==', normReferred)
    .where('status', '==', 'pending')
    .limit(1)
    .get();

  if (!existing.empty)
    return { ok: false, reason: 'Referral already pending for this customer' };

  const docRef = db.collection('posReferrals').doc();
  await docRef.set({
    sellerId,
    referrerPhone: normReferrer,
    referredPhone: normReferred,
    status: 'pending',
    pointsAwarded: 0,
    createdAt: _TS(),
    updatedAt: _TS(),
  });

  return { ok: true, referralId: docRef.id };
});

/**
 * completeReferralReward
 * Role: manager+. Called when referred customer completes first purchase.
 * Awards REFERRAL_POINTS to the referrer.
 */
exports.completeReferralReward = onCall(_CF, exports._h.completeReferralReward = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');
  const { sellerId, referredPhone, saleId } = req.data;
  _requireFields(req.data, ['sellerId', 'referredPhone', 'saleId']);
  const normReferred = _normalizePhone(referredPhone);

  // Find pending referral
  const referralSnap = await db.collection('posReferrals')
    .where('sellerId', '==', sellerId)
    .where('referredPhone', '==', normReferred)
    .where('status', '==', 'pending')
    .limit(1)
    .get();

  if (referralSnap.empty)
    return { ok: false, reason: 'No pending referral found for this customer' };

  const referralDoc  = referralSnap.docs[0];
  const referral     = referralDoc.data();
  const referrerPhone = referral.referrerPhone;

  const referrerCustomerRef = db.collection('posCustomers').doc(`${sellerId}_${referrerPhone}`);

  await db.runTransaction(async (tx) => {
    const referrerSnap = await tx.get(referrerCustomerRef);

    if (!referrerSnap.exists)
      throw new HttpsError('not-found', 'Referrer customer record not found');

    const newPoints = (referrerSnap.data().loyaltyPoints ?? 0) + REFERRAL_POINTS;
    const newTier   = _tierFromPoints(newPoints);

    tx.update(referrerCustomerRef, {
      loyaltyPoints: _INC(REFERRAL_POINTS),
      tier: newTier,
      updatedAt: _TS(),
    });

    tx.update(referralDoc.ref, {
      status: 'rewarded',
      pointsAwarded: REFERRAL_POINTS,
      rewardedSaleId: saleId,
      rewardedAt: _TS(),
      updatedAt: _TS(),
    });
  });

  return { ok: true, pointsAwarded: REFERRAL_POINTS, referrerPhone };
});

/**
 * getReferralStats
 * Returns referral count and total points earned for a customer.
 */
exports.getReferralStats = onCall(_CF, exports._h.getReferralStats = async (req) => {
  _requireAuth(req);
  const { sellerId, phone } = req.data;
  _requireFields(req.data, ['sellerId', 'phone']);
  const normPhone = _normalizePhone(phone);

  const [asReferrer, asReferred] = await Promise.all([
    db.collection('posReferrals')
      .where('sellerId', '==', sellerId)
      .where('referrerPhone', '==', normPhone)
      .get(),
    db.collection('posReferrals')
      .where('sellerId', '==', sellerId)
      .where('referredPhone', '==', normPhone)
      .limit(1)
      .get(),
  ]);

  const referrals       = asReferrer.docs.map((d) => d.data());
  const totalReferrals  = referrals.length;
  const rewarded        = referrals.filter((r) => r.status === 'rewarded').length;
  const pending         = referrals.filter((r) => r.status === 'pending').length;
  const totalPoints     = referrals.reduce((sum, r) => sum + (r.pointsAwarded ?? 0), 0);
  const wasReferred     = !asReferred.empty;

  return { totalReferrals, rewarded, pending, totalPoints, wasReferred };
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION F — Personalized Offers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const VALID_OFFER_TYPES    = ['percent_discount', 'fixed_discount', 'free_item', 'bogo'];
const VALID_ELIGIBILITIES  = ['tier', 'minSpend', 'segment', 'all'];
const TIER_ORDER           = ['Bronze', 'Silver', 'Gold', 'Platinum'];

/**
 * createOffer
 * Role: manager+. Create a personalized offer for a seller's customers.
 */
exports.createOffer = onCall(_CF, exports._h.createOffer = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');
  const {
    sellerId, name, description, offerType, value,
    eligibility, targetTier, minSpend, productId,
    startDate, endDate,
  } = req.data;

  _requireFields(req.data, ['sellerId', 'name', 'offerType', 'value', 'eligibility']);

  if (!VALID_OFFER_TYPES.includes(offerType))
    throw new HttpsError('invalid-argument', `offerType must be one of: ${VALID_OFFER_TYPES.join(', ')}`);
  if (!VALID_ELIGIBILITIES.includes(eligibility))
    throw new HttpsError('invalid-argument', `eligibility must be one of: ${VALID_ELIGIBILITIES.join(', ')}`);

  const safeValue = _validateAmount(value, 'value');

  if (offerType === 'percent_discount' && safeValue > 100)
    throw new HttpsError('invalid-argument', 'Percent discount cannot exceed 100');

  if (eligibility === 'tier' && !targetTier)
    throw new HttpsError('invalid-argument', 'targetTier required for tier eligibility');
  if (eligibility === 'minSpend' && !minSpend)
    throw new HttpsError('invalid-argument', 'minSpend required for minSpend eligibility');

  const docRef = db.collection('posOffers').doc();
  await docRef.set({
    sellerId,
    name,
    description: description || null,
    offerType,
    value: safeValue,
    eligibility,
    targetTier: targetTier || null,
    minSpend: minSpend ? _validateAmount(minSpend, 'minSpend') : null,
    productId: productId || null,
    startDate: startDate ? new Date(startDate) : null,
    endDate: endDate ? new Date(endDate) : null,
    isActive: true,
    redemptionCount: 0,
    createdBy: auth.uid,
    createdAt: _TS(),
    updatedAt: _TS(),
  });

  return { ok: true, offerId: docRef.id };
});

/**
 * getActiveOffers
 * Returns offers the given customer is currently eligible for.
 */
exports.getActiveOffers = onCall(_CF, exports._h.getActiveOffers = async (req) => {
  _requireAuth(req);
  const { sellerId, customerTier, customerSpend } = req.data;
  _requireFields(req.data, ['sellerId']);

  const now = new Date();

  const snap = await db.collection('posOffers')
    .where('sellerId', '==', sellerId)
    .where('isActive', '==', true)
    .get();

  const eligible = [];

  for (const doc of snap.docs) {
    const offer = doc.data();

    // Date range check
    if (offer.startDate && offer.startDate.toDate && offer.startDate.toDate() > now) continue;
    if (offer.endDate   && offer.endDate.toDate   && offer.endDate.toDate()   < now) continue;

    // Eligibility check
    const elig = offer.eligibility;
    if (elig === 'all') {
      eligible.push({ id: doc.id, ...offer });
      continue;
    }
    if (elig === 'tier') {
      const custIdx   = TIER_ORDER.indexOf(customerTier || 'Bronze');
      const targetIdx = TIER_ORDER.indexOf(offer.targetTier || 'Bronze');
      if (custIdx >= targetIdx) eligible.push({ id: doc.id, ...offer });
      continue;
    }
    if (elig === 'minSpend') {
      if ((customerSpend ?? 0) >= (offer.minSpend ?? 0))
        eligible.push({ id: doc.id, ...offer });
      continue;
    }
    if (elig === 'segment') {
      // Segment-based offers are returned without further filter here;
      // the caller cross-references with segmentation engine.
      eligible.push({ id: doc.id, ...offer });
    }
  }

  return { offers: eligible };
});

/**
 * getOffers
 * Role: manager+. Returns all offers for a seller.
 */
exports.getOffers = onCall(_CF, exports._h.getOffers = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');
  const { sellerId, status } = req.data;
  _requireFields(req.data, ['sellerId']);

  let query = db.collection('posOffers')
    .where('sellerId', '==', sellerId)
    .orderBy('createdAt', 'desc')
    .limit(100);

  if (status === 'active')   query = query.where('isActive', '==', true);
  if (status === 'inactive') query = query.where('isActive', '==', false);

  const snap = await query.get();
  return { offers: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
});

/**
 * toggleOffer
 * Role: manager+. Activate or deactivate an offer.
 */
exports.toggleOffer = onCall(_CF, exports._h.toggleOffer = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');
  const { offerId, isActive } = req.data;
  _requireFields(req.data, ['offerId']);

  if (typeof isActive !== 'boolean')
    throw new HttpsError('invalid-argument', 'isActive must be a boolean');

  const offerRef = db.collection('posOffers').doc(offerId);
  const snap     = await offerRef.get();

  if (!snap.exists) throw new HttpsError('not-found', 'Offer not found');

  await offerRef.update({ isActive, updatedAt: _TS(), updatedBy: auth.uid });
  return { ok: true, offerId, isActive };
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION G — Customer Segmentation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * _daysSince
 * Returns the number of days since a Firestore Timestamp (or null if missing).
 */
function _daysSince(ts) {
  if (!ts) return Infinity;
  const ms = ts.toDate ? ts.toDate() : new Date(ts);
  return (Date.now() - ms.getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * _classifyCustomer
 * Returns the segment label for a customer record.
 */
function _classifyCustomer(c) {
  const visits    = c.totalVisits  ?? 0;
  const spent     = c.totalSpent   ?? 0;
  const daysSince = _daysSince(c.lastVisit);

  if (spent >= 10000)                          return 'High Value';
  if (visits >= 10 && daysSince <= 30 && spent >= 5000) return 'Champions';
  if (visits >= 5  && daysSince <= 60)         return 'Loyal';
  if (daysSince > 60 && daysSince <= 90 && visits >= 3) return 'At Risk';
  if (daysSince > 90)                          return 'Lost';
  if (visits <= 2)                             return 'New';
  return 'Occasional';
}

/**
 * getCustomerSegments
 * Role: manager+. Segments all customers for a seller.
 */
exports.getCustomerSegments = onCall(_CF, exports._h.getCustomerSegments = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');
  const { sellerId } = req.data;
  _requireFields(req.data, ['sellerId']);

  const snap = await db.collection('posCustomers')
    .where('sellerId', '==', sellerId)
    .limit(2000)
    .get();

  const segments = {
    Champions: [],
    Loyal:     [],
    'At Risk': [],
    Lost:      [],
    New:       [],
    'High Value': [],
    Occasional: [],
  };

  for (const doc of snap.docs) {
    const c       = doc.data();
    const segment = _classifyCustomer(c);
    if (!segments[segment]) segments[segment] = [];
    segments[segment].push({
      id: doc.id,
      name: c.name,
      phone: c.phone,
      tier: c.tier || 'Bronze',
      totalSpent: c.totalSpent ?? 0,
      totalVisits: c.totalVisits ?? 0,
      lastVisit: c.lastVisit ? (c.lastVisit.toDate ? c.lastVisit.toDate().toISOString() : c.lastVisit) : null,
    });
  }

  // Build summary: count + top 10 per segment
  const summary = {};
  for (const [seg, customers] of Object.entries(segments)) {
    const sorted = customers.sort((a, b) => (b.totalSpent ?? 0) - (a.totalSpent ?? 0));
    summary[seg] = {
      count: sorted.length,
      top10: sorted.slice(0, 10),
    };
  }

  return { segments: summary };
});

/**
 * getCustomerInsights
 * Full 360° profile for a single customer: purchases, basket, favourites, loyalty, wallet, credit.
 */
exports.getCustomerInsights = onCall(_CF, exports._h.getCustomerInsights = async (req) => {
  _requireAuth(req);
  const { sellerId, phone } = req.data;
  _requireFields(req.data, ['sellerId', 'phone']);
  const normPhone = _normalizePhone(phone);
  const customerId = `${sellerId}_${normPhone}`;

  const [
    customerSnap,
    salesSnap,
    walletSnap,
    loyaltySnap,
  ] = await Promise.all([
    db.collection('posCustomers').doc(customerId).get(),
    db.collection('posSales')
      .where('sellerId', '==', sellerId)
      .where('customerPhone', '==', normPhone)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get(),
    db.collection('posWallets').doc(_walletId(sellerId, normPhone)).get(),
    db.collection('posLoyaltyLog')
      .where('sellerId', '==', sellerId)
      .where('phone', '==', normPhone)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get(),
  ]);

  if (!customerSnap.exists)
    throw new HttpsError('not-found', 'Customer not found');

  const customer = customerSnap.data();
  const sales    = salesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // Compute average basket size
  const avgBasket = sales.length > 0
    ? Math.round(sales.reduce((s, sl) => s + (sl.total ?? 0), 0) / sales.length)
    : 0;

  // Compute favourite products (top 5 by frequency)
  const productFreq = {};
  for (const sale of sales) {
    for (const item of (sale.items ?? [])) {
      const key = item.productId || item.name;
      if (key) productFreq[key] = (productFreq[key] || 0) + (item.qty ?? 1);
    }
  }
  const favouriteProducts = Object.entries(productFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([productId, count]) => ({ productId, count }));

  // Wallet & credit
  const walletBalance = walletSnap.exists ? (walletSnap.data().balance ?? 0) : 0;
  const loyaltyHistory = loyaltySnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  return {
    profile: {
      name: customer.name,
      phone: customer.phone,
      email: customer.email || null,
      tier: customer.tier || 'Bronze',
      loyaltyPoints: customer.loyaltyPoints ?? 0,
      totalSpent: customer.totalSpent ?? 0,
      totalVisits: customer.totalVisits ?? 0,
      storeCredit: customer.storeCredit ?? 0,
      segment: _classifyCustomer(customer),
      lastVisit: customer.lastVisit
        ? (customer.lastVisit.toDate ? customer.lastVisit.toDate().toISOString() : customer.lastVisit)
        : null,
      joinedAt: customer.createdAt
        ? (customer.createdAt.toDate ? customer.createdAt.toDate().toISOString() : customer.createdAt)
        : null,
    },
    recentPurchases: sales,
    averageBasket: avgBasket,
    favouriteProducts,
    walletBalance,
    loyaltyHistory,
  };
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION H — Membership Tiers (Enhanced)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * upgradeMembershipTier
 * Role: manager+. Manually override a customer's tier with a reason.
 */
exports.upgradeMembershipTier = onCall(_CF, exports._h.upgradeMembershipTier = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');
  const { sellerId, phone, newTier, reason } = req.data;
  _requireFields(req.data, ['sellerId', 'phone', 'newTier', 'reason']);

  if (!TIER_ORDER.includes(newTier))
    throw new HttpsError('invalid-argument', `newTier must be one of: ${TIER_ORDER.join(', ')}`);

  const normPhone   = _normalizePhone(phone);
  const customerId  = `${sellerId}_${normPhone}`;
  const customerRef = db.collection('posCustomers').doc(customerId);
  const snap        = await customerRef.get();

  if (!snap.exists) throw new HttpsError('not-found', 'Customer not found');

  const previousTier = snap.data().tier || 'Bronze';

  const batch = db.batch();
  batch.update(customerRef, { tier: newTier, tierManualOverride: true, updatedAt: _TS() });

  const logRef = db.collection('posTierUpgradeLog').doc();
  batch.set(logRef, {
    sellerId,
    phone: normPhone,
    previousTier,
    newTier,
    reason,
    performedBy: auth.uid,
    createdAt: _TS(),
  });

  await batch.commit();
  return { ok: true, previousTier, newTier };
});

/**
 * getMembershipStats
 * Role: manager+. Returns count of customers per tier and revenue by tier.
 */
exports.getMembershipStats = onCall(_CF, exports._h.getMembershipStats = async (req) => {
  const auth = _requireAuth(req);
  _requireRole(auth, 'manager');
  const { sellerId } = req.data;
  _requireFields(req.data, ['sellerId']);

  const snap = await db.collection('posCustomers')
    .where('sellerId', '==', sellerId)
    .get();

  const stats = {
    Bronze:   { count: 0, totalRevenue: 0 },
    Silver:   { count: 0, totalRevenue: 0 },
    Gold:     { count: 0, totalRevenue: 0 },
    Platinum: { count: 0, totalRevenue: 0 },
  };

  for (const doc of snap.docs) {
    const c    = doc.data();
    const tier = c.tier || 'Bronze';
    if (!stats[tier]) stats[tier] = { count: 0, totalRevenue: 0 };
    stats[tier].count++;
    stats[tier].totalRevenue += c.totalSpent ?? 0;
  }

  // Round revenue values
  for (const tier of Object.keys(stats)) {
    stats[tier].totalRevenue = Math.round(stats[tier].totalRevenue);
  }

  const totalCustomers = snap.size;
  return { stats, totalCustomers };
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SECTION I — Scheduled: birthdayRewardSweep
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * birthdayRewardSweep
 * Runs every 24 hours. Finds all customers whose birthday is today,
 * awards BIRTHDAY_BONUS_POINTS if not yet awarded this year,
 * and queues a birthday notification.
 */
exports.birthdayRewardSweep = onSchedule(
  { schedule: 'every 24 hours', region: 'us-central1', timeZone: 'Africa/Nairobi' },
  async () => {
    const today       = new Date();
    const todayMonth  = today.getMonth() + 1; // 1-indexed
    const todayDay    = today.getDate();
    const currentYear = today.getFullYear();

    console.log(`[birthdayRewardSweep] Running for ${today.toISOString().slice(0, 10)}`);

    // Query customers with birthday today (month + day)
    const snap = await db.collection('posCustomers')
      .where('birthdayMonth', '==', todayMonth)
      .where('birthdayDay',   '==', todayDay)
      .get();

    if (snap.empty) {
      console.log('[birthdayRewardSweep] No birthday customers today');
      return;
    }

    console.log(`[birthdayRewardSweep] Found ${snap.size} birthday customers`);

    // Process in batches of 400 (Firestore batch limit is 500)
    const BATCH_SIZE = 400;
    let processed    = 0;
    let awarded      = 0;

    const docs = snap.docs;

    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const chunk = docs.slice(i, i + BATCH_SIZE);
      const batch = db.batch();

      for (const doc of chunk) {
        const customer = doc.data();
        processed++;

        // Skip if already rewarded this year
        if (customer.lastBirthdayRewardYear === currentYear) continue;

        const newPoints = (customer.loyaltyPoints ?? 0) + BIRTHDAY_BONUS_POINTS;
        const newTier   = _tierFromPoints(newPoints);

        batch.update(doc.ref, {
          loyaltyPoints: _INC(BIRTHDAY_BONUS_POINTS),
          tier: newTier,
          lastBirthdayRewardYear: currentYear,
          updatedAt: _TS(),
        });

        // Queue birthday notification
        const notifRef = db.collection('posNotificationQueue').doc();
        batch.set(notifRef, {
          sellerId: customer.sellerId || null,
          phone: customer.phone,
          customerName: customer.name || null,
          type: 'birthday_reward',
          points: BIRTHDAY_BONUS_POINTS,
          message: `Happy Birthday ${customer.name || 'Valued Customer'}! You've earned ${BIRTHDAY_BONUS_POINTS} bonus points. 🎂`,
          status: 'pending',
          createdAt: _TS(),
        });

        awarded++;
      }

      await batch.commit();
    }

    console.log(`[birthdayRewardSweep] Processed ${processed}, awarded to ${awarded} customers`);
  }
);
