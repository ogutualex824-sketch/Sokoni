'use strict';

/**
 * SOKONI Financial Operating System (SFOS) — Cloud Functions
 * Firebase Gen2 / Node.js 22
 *
 * This is the canonical financial backbone of the SOKONI platform.
 * All new money movements, ledger entries, escrow, group wallets, merchant
 * finance, rewards, risk scoring, and financial analytics live here.
 *
 * Collections owned (additive — never drops existing collections):
 *   sfosIdentity/{uid}            — universal financial identity
 *   sfosLedger/{entryId}          — immutable double-entry ledger
 *   sfosTransactions/{txId}       — canonical transaction records
 *   sfosEscrow/{escrowId}         — escrow contracts & milestones
 *   sfosGroups/{groupId}          — group / family wallets
 *   sfosGroups/{groupId}/wallets  — per-member sub-wallets
 *   sfosMerchant/{merchantId}     — merchant revenue & settlement data
 *   sfosRewards/{uid}             — points, tiers, achievements
 *   sfosAuditLog/{logId}          — immutable security audit trail
 *
 * Backward-compat collections written (never drops):
 *   wallets/{uid}                 — balance kept in sync
 *   walletTransactions/{txId}     — legacy transaction mirror
 *
 * Secrets required:
 *   ANTHROPIC_API_KEY             — Claude Haiku for AI financial forecasting
 *
 * @module sfos-engine
 * @version 1.0.0
 * @since 2026-07-14
 */

const { onCall, HttpsError }              = require('firebase-functions/v2/https');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { defineSecret }                    = require('firebase-functions/params');
const crypto                              = require('crypto');
const https                               = require('https');

// ─── Secrets ──────────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

// ─── Constants ────────────────────────────────────────────────────────────────

const TAG = '[SFOS]';

const VALID_TX_TYPES = new Set([
  'WALLET_TRANSFER', 'MARKETPLACE_PURCHASE', 'MERCHANT_SETTLEMENT',
  'DELIVERY_PAYMENT', 'REFUND', 'WITHDRAWAL', 'DEPOSIT', 'ESCROW_LOCK',
  'ESCROW_RELEASE', 'SUBSCRIPTION', 'COMMISSION', 'CASHBACK',
  'LOYALTY_REDEMPTION', 'SAVINGS_DEPOSIT', 'SAVINGS_WITHDRAWAL',
  'SALARY', 'INVOICE', 'DONATION', 'GIFT', 'ROUND_UP',
]);

const VALID_LEDGER_TYPES = new Set([
  'WALLET', 'ESCROW', 'SAVINGS', 'REWARDS', 'MERCHANT', 'BUSINESS', 'FLOAT', 'EXTERNAL', 'PLATFORM',
]);

const TIER_THRESHOLDS = { silver: 1000, gold: 5000, platinum: 15000, diamond: 50000 };

const DEFAULT_DAILY_LIMIT   = 50_000;   // KES
const DEFAULT_MONTHLY_LIMIT = 500_000;  // KES
const POINTS_TO_KES         = 0.10;     // 1 pt = KSh 0.10

const BASE_OPTS = { cors: true, enforceAppCheck: true };

function _optsWithSecrets(...secrets) {
  return { ...BASE_OPTS, secrets };
}

// ─── Firestore accessor ───────────────────────────────────────────────────────

function _db() {
  return getFirestore();
}

// ─── Shared auth helpers ──────────────────────────────────────────────────────

function _requireAuth(request) {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Sign in required');
  }
  return request.auth.uid;
}

function _requireAdmin(request) {
  const t = request.auth?.token;
  if (!t?.admin && !t?.superAdmin) {
    throw new HttpsError('permission-denied', 'Admin access required');
  }
}

// ─── Sanitisation ─────────────────────────────────────────────────────────────

function _san(s, max = 500) {
  if (s == null) return '';
  return String(s).replace(/<[^>]*>/g, '').trim().slice(0, max);
}

function _assertPositiveAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    throw new HttpsError('invalid-argument', 'amount must be a positive finite number');
  }
  return Math.round(n * 100) / 100; // round to 2dp
}

// ─── ID generation ────────────────────────────────────────────────────────────

function _genId(prefix = 'sf') {
  const ts   = Date.now().toString(36);
  const rand = crypto.randomBytes(5).toString('hex');
  return `${prefix}_${ts}_${rand}`;
}

function _genWalletId() {
  // SOK- + 8 uppercase alphanumeric chars
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result  = 'SOK-';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

// ─── Phone normalisation ──────────────────────────────────────────────────────

function _normalizePhone(raw) {
  const cleaned = String(raw || '').replace(/[\s\-().+]/g, '');
  const match   = cleaned.match(/^(?:254|0)([17]\d{8})$/);
  return match ? `254${match[1]}` : null;
}

// ─── Hashing ──────────────────────────────────────────────────────────────────

function _sha256(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

// ─── Logging ──────────────────────────────────────────────────────────────────

function _log(level, msg, extra = {}) {
  const line = JSON.stringify({ severity: level.toUpperCase(), message: `${TAG} ${msg}`, ...extra });
  if (level === 'error') console.error(line);
  else if (level === 'warn')  console.warn(line);
  else                        console.log(line);
}

// ══════════════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Get or create sfosIdentity/{uid}.
 * Unique walletId collision check via Firestore query.
 */
async function _ensureIdentity(db, uid, auth) {
  const ref  = db.collection('sfosIdentity').doc(uid);
  const snap = await ref.get();
  if (snap.exists) return { ref, data: snap.data() };

  // Generate unique walletId
  let walletId;
  for (let i = 0; i < 5; i++) {
    const candidate = _genWalletId();
    const q = await db.collection('sfosIdentity')
      .where('walletId', '==', candidate)
      .limit(1)
      .get();
    if (q.empty) { walletId = candidate; break; }
  }
  if (!walletId) walletId = _genWalletId(); // last resort — astronomically rare collision

  const identity = {
    uid,
    walletId,
    username:             null,
    displayName:          auth?.token?.name   || null,
    phone:                auth?.token?.phone_number || null,
    email:                auth?.token?.email  || null,
    kycStatus:            'none',
    tier:                 'bronze',
    rewardPoints:         0,
    lifetimePoints:       0,
    cashbackBalance:      0,
    financialScore:       50,
    riskScore:            20,
    status:               'active',
    pinHash:              null,
    dailyLimit:           DEFAULT_DAILY_LIMIT,
    monthlyLimit:         DEFAULT_MONTHLY_LIMIT,
    dailySpent:           0,
    monthlySpent:         0,
    velocityDayReset:     null,
    velocityMonthReset:   null,
    createdAt:            Timestamp.now(),
    updatedAt:            Timestamp.now(),
    lastTransactionAt:    null,
  };
  await ref.set(identity);
  return { ref, data: identity };
}

/**
 * Velocity check — compare dailySpent / monthlySpent against limits.
 * Resets counters when the calendar day or month has rolled over.
 */
async function _velocityCheck(db, uid, amount) {
  const ref  = db.collection('sfosIdentity').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) return { allowed: true, dailyRemaining: DEFAULT_DAILY_LIMIT, monthlyRemaining: DEFAULT_MONTHLY_LIMIT };

  const now  = new Date();
  const data = snap.data();

  // Determine if we need to reset daily counter
  let dailySpent   = data.dailySpent   || 0;
  let monthlySpent = data.monthlySpent || 0;

  const lastDayReset   = data.velocityDayReset   ? data.velocityDayReset.toDate()   : null;
  const lastMonthReset = data.velocityMonthReset ? data.velocityMonthReset.toDate() : null;

  const todayStr  = now.toISOString().slice(0, 10);
  const monthStr  = now.toISOString().slice(0, 7);

  if (!lastDayReset || lastDayReset.toISOString().slice(0, 10) !== todayStr) {
    dailySpent = 0;
  }
  if (!lastMonthReset || lastMonthReset.toISOString().slice(0, 7) !== monthStr) {
    monthlySpent = 0;
  }

  const dailyLimit   = data.dailyLimit   || DEFAULT_DAILY_LIMIT;
  const monthlyLimit = data.monthlyLimit || DEFAULT_MONTHLY_LIMIT;

  const dailyRemaining   = Math.max(0, dailyLimit   - dailySpent);
  const monthlyRemaining = Math.max(0, monthlyLimit - monthlySpent);

  const allowed = amount <= dailyRemaining && amount <= monthlyRemaining;
  return { allowed, dailyRemaining, monthlyRemaining };
}

/**
 * Lightweight risk scorer for transaction execution.
 * Returns a number 0-100.
 */
async function _riskScore(db, uid, type, amount, toId) {
  let score = 0;
  const now = new Date();
  const hour = now.getUTCHours() + 3; // EAT offset (UTC+3)
  const eatHour = ((hour % 24) + 24) % 24;

  try {
    const identity = (await db.collection('sfosIdentity').doc(uid).get()).data() || {};
    const tier     = identity.tier || 'bronze';

    // Unusual hour: 11pm–5am EAT
    if (eatHour >= 23 || eatHour < 5) score += 10;

    // Amount > daily average * 3 (approximate using monthlySpent / 30)
    const avgDaily = (identity.monthlySpent || 0) / 30;
    if (avgDaily > 0 && amount > avgDaily * 3) score += 20;

    // Amount > 50% of monthly limit
    const monthlyLimit = identity.monthlyLimit || DEFAULT_MONTHLY_LIMIT;
    if (amount > monthlyLimit * 0.5) score += 15;

    // Bronze sending > 10,000 KES
    if (tier === 'bronze' && amount > 10_000) score += 20;

    if (toId && toId !== 'PLATFORM') {
      // New recipient check
      const sentBefore = await db.collection('sfosTransactions')
        .where('fromId', '==', uid)
        .where('toId',   '==', toId)
        .limit(6)
        .get();
      if (sentBefore.empty) {
        score += 10;
      } else if (sentBefore.size >= 5) {
        score = Math.max(0, score - 20); // known safe recipient
      }
    }

    // Rapid succession: >3 transactions in last 10 minutes
    const tenMinAgo = Timestamp.fromMillis(Date.now() - 10 * 60 * 1000);
    const recentQ   = await db.collection('sfosTransactions')
      .where('initiatorUid', '==', uid)
      .where('createdAt',    '>=', tenMinAgo)
      .limit(4)
      .get();
    if (recentQ.size > 3) score += 25;
  } catch (e) {
    _log('warn', '_riskScore computation error', { uid, err: e.message });
  }

  return Math.min(100, Math.max(0, score));
}

/**
 * Write an immutable sfosAuditLog entry.
 */
async function _writeAuditLog(db, uid, action, entityType, entityId, details = {}, severity = 'INFO', ipHash = null, deviceId = null) {
  const logId = _genId('alog');
  await db.collection('sfosAuditLog').doc(logId).set({
    logId,
    uid,
    action,
    entityType,
    entityId,
    severity,
    before:   details.before || null,
    after:    details.after  || null,
    meta:     details.meta   || null,
    ipHash,
    deviceId,
    createdAt: Timestamp.now(),
  });
  return logId;
}

/**
 * Increment velocity counters on sfosIdentity.
 * Resets the counter if the day / month has rolled over.
 */
async function _updateVelocity(db, uid, amount) {
  try {
    const ref  = db.collection('sfosIdentity').doc(uid);
    const snap = await ref.get();
    if (!snap.exists) return;

    const now   = new Date();
    const data  = snap.data();
    const update = { updatedAt: Timestamp.now() };

    const todayStr  = now.toISOString().slice(0, 10);
    const monthStr  = now.toISOString().slice(0, 7);

    const lastDay   = data.velocityDayReset   ? data.velocityDayReset.toDate().toISOString().slice(0, 10) : null;
    const lastMonth = data.velocityMonthReset ? data.velocityMonthReset.toDate().toISOString().slice(0, 7) : null;

    if (lastDay !== todayStr) {
      update.dailySpent        = amount;
      update.velocityDayReset  = Timestamp.now();
    } else {
      update.dailySpent = FieldValue.increment(amount);
    }

    if (lastMonth !== monthStr) {
      update.monthlySpent        = amount;
      update.velocityMonthReset  = Timestamp.now();
    } else {
      update.monthlySpent = FieldValue.increment(amount);
    }

    await ref.update(update);
  } catch (e) {
    _log('warn', '_updateVelocity error', { uid, err: e.message });
  }
}

/**
 * Award reward points for a completed transaction.
 * Checks for tier upgrades after awarding.
 */
async function _updateRewards(db, uid, txType, amount) {
  try {
    let pts = 0;
    switch (txType) {
      case 'MARKETPLACE_PURCHASE': pts = Math.floor(amount / 10) * 2;  break;
      case 'WALLET_TRANSFER':      pts = Math.floor(amount / 20);       break;
      case 'SAVINGS_DEPOSIT':      pts = Math.floor(amount / 10) * 3;  break;
      case 'SUBSCRIPTION':         pts = 5;                             break;
      default:                     pts = 0;
    }
    if (pts <= 0) return;

    const rewardsRef  = db.collection('sfosRewards').doc(uid);
    const identityRef = db.collection('sfosIdentity').doc(uid);

    const [rewardsSnap, identitySnap] = await Promise.all([rewardsRef.get(), identityRef.get()]);

    const currentPoints   = (rewardsSnap.exists ? rewardsSnap.data().points        : 0) + pts;
    const lifetimePoints  = (rewardsSnap.exists ? rewardsSnap.data().lifetimePoints : 0) + pts;

    // Tier upgrade check
    let tier = (identitySnap.exists ? identitySnap.data().tier : 'bronze') || 'bronze';
    if      (lifetimePoints >= TIER_THRESHOLDS.diamond)  tier = 'diamond';
    else if (lifetimePoints >= TIER_THRESHOLDS.platinum) tier = 'platinum';
    else if (lifetimePoints >= TIER_THRESHOLDS.gold)     tier = 'gold';
    else if (lifetimePoints >= TIER_THRESHOLDS.silver)   tier = 'silver';
    else                                                   tier = 'bronze';

    // tierProgressPct toward next tier
    const tiers       = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];
    const tierIdx     = tiers.indexOf(tier);
    const nextTier    = tiers[tierIdx + 1];
    const nextTarget  = nextTier ? TIER_THRESHOLDS[nextTier] : TIER_THRESHOLDS.diamond;
    const prevTarget  = tierIdx > 0 ? TIER_THRESHOLDS[tiers[tierIdx]] : 0;
    const progress    = nextTier
      ? Math.min(100, Math.round(((lifetimePoints - prevTarget) / (nextTarget - prevTarget)) * 100))
      : 100;

    await rewardsRef.set({
      uid,
      points:          currentPoints,
      lifetimePoints,
      tier,
      tierProgressPct: progress,
      nextTierPoints:  nextTarget,
      cashback:        rewardsSnap.exists ? (rewardsSnap.data().cashback || 0) : 0,
      streakDays:      rewardsSnap.exists ? (rewardsSnap.data().streakDays || 0) : 0,
      streakLastAt:    rewardsSnap.exists ? (rewardsSnap.data().streakLastAt || null) : null,
      achievements:    rewardsSnap.exists ? (rewardsSnap.data().achievements || []) : [],
      updatedAt:       Timestamp.now(),
    }, { merge: true });

    await identityRef.update({
      rewardPoints:   currentPoints,
      lifetimePoints,
      tier,
      updatedAt:      Timestamp.now(),
    });
  } catch (e) {
    _log('warn', '_updateRewards error', { uid, err: e.message });
  }
}

/**
 * Generate a receipt object for a completed transaction.
 */
function _generateReceipt(tx, fromDisplay, toDisplay) {
  const receiptNumber = `RCP-${tx.txId.slice(-8).toUpperCase()}`;
  return {
    receiptNumber,
    date:      tx.createdAt ? new Date(tx.createdAt.toMillis()).toISOString() : new Date().toISOString(),
    from:      fromDisplay || tx.fromId,
    to:        toDisplay   || tx.toId,
    amount:    tx.amount,
    currency:  tx.currency || 'KES',
    type:      tx.type,
    reference: tx.reference || null,
    status:    tx.status,
  };
}

/**
 * Determine fromLedger + toLedger from transaction type.
 */
function _ledgerPair(txType) {
  const map = {
    WALLET_TRANSFER:      ['WALLET',   'WALLET'],
    DEPOSIT:              ['EXTERNAL', 'WALLET'],
    WITHDRAWAL:           ['WALLET',   'EXTERNAL'],
    SAVINGS_DEPOSIT:      ['WALLET',   'SAVINGS'],
    SAVINGS_WITHDRAWAL:   ['SAVINGS',  'WALLET'],
    ESCROW_LOCK:          ['WALLET',   'ESCROW'],
    ESCROW_RELEASE:       ['ESCROW',   'WALLET'],
    COMMISSION:           ['WALLET',   'PLATFORM'],
    CASHBACK:             ['PLATFORM', 'WALLET'],
    MARKETPLACE_PURCHASE: ['WALLET',   'ESCROW'],
    MERCHANT_SETTLEMENT:  ['ESCROW',   'MERCHANT'],
  };
  return map[txType] || ['WALLET', 'WALLET'];
}

/**
 * Write two sfosLedger entries (DEBIT + CREDIT) and return their IDs.
 * Must be called inside a runTransaction for atomicity.
 * Accepts the Firestore Transaction object so writes are batched.
 */
function _writeLedgerEntries(t, db, txId, txType, fromId, toId, fromLedger, toLedger, amount, currency, fromBefore, fromAfter, toBefore, toAfter, description) {
  const debitId  = _genId('dbt');
  const creditId = _genId('cdt');
  const now      = Timestamp.now();

  const base = {
    txId,
    txType,
    currency,
    amount,
    description: description || txType,
    createdAt: now,
  };

  t.set(db.collection('sfosLedger').doc(debitId), {
    ...base,
    entryId:       debitId,
    ledgerType:    fromLedger,
    direction:     'DEBIT',
    accountId:     fromId,
    balanceBefore: fromBefore,
    balanceAfter:  fromAfter,
  });

  t.set(db.collection('sfosLedger').doc(creditId), {
    ...base,
    entryId:       creditId,
    ledgerType:    toLedger,
    direction:     'CREDIT',
    accountId:     toId,
    balanceBefore: toBefore,
    balanceAfter:  toAfter,
  });

  return [debitId, creditId];
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. sfosIdentityGet
// ══════════════════════════════════════════════════════════════════════════════

exports.sfosIdentityGet = onCall(BASE_OPTS, async (request) => {
  const uid = _requireAuth(request);
  const db  = _db();

  try {
    const { data: identity } = await _ensureIdentity(db, uid, request.auth);

    // Merge balance from legacy wallets/{uid}
    const walletSnap = await db.collection('wallets').doc(uid).get();
    const walletData = walletSnap.exists ? walletSnap.data() : {};

    return {
      ...identity,
      balance:         walletData.balance        || 0,
      savingsBalance:  walletData.savingsBalance  || 0,
      cashbackBalance: walletData.cashbackBalance || identity.cashbackBalance || 0,
      frozen:          walletData.frozen          || false,
      currency:        walletData.currency        || 'KES',
    };
  } catch (e) {
    _log('error', 'sfosIdentityGet', { uid, err: e.message });
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'Failed to load identity');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. sfosIdentityUpdate
// ══════════════════════════════════════════════════════════════════════════════

exports.sfosIdentityUpdate = onCall(BASE_OPTS, async (request) => {
  const uid  = _requireAuth(request);
  const db   = _db();
  const data = request.data || {};

  const allowed   = ['username', 'displayName', 'dailyLimit', 'monthlyLimit'];
  const update    = {};
  const oldSnap   = await db.collection('sfosIdentity').doc(uid).get();
  const oldData   = oldSnap.exists ? oldSnap.data() : {};

  try {
    if (data.username !== undefined) {
      const uname = _san(data.username, 30).toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (uname.length < 3) throw new HttpsError('invalid-argument', 'Username must be at least 3 characters');
      // Uniqueness check
      const q = await db.collection('sfosIdentity')
        .where('username', '==', uname)
        .limit(1)
        .get();
      if (!q.empty && q.docs[0].id !== uid) {
        throw new HttpsError('already-exists', 'Username is already taken');
      }
      update.username = uname;
    }

    if (data.displayName !== undefined) {
      update.displayName = _san(data.displayName, 80);
    }

    if (data.dailyLimit !== undefined) {
      const dl = Number(data.dailyLimit);
      if (!Number.isFinite(dl) || dl < 100 || dl > 1_000_000) {
        throw new HttpsError('invalid-argument', 'dailyLimit must be between 100 and 1,000,000 KES');
      }
      update.dailyLimit = dl;
    }

    if (data.monthlyLimit !== undefined) {
      const ml = Number(data.monthlyLimit);
      if (!Number.isFinite(ml) || ml < 1000 || ml > 10_000_000) {
        throw new HttpsError('invalid-argument', 'monthlyLimit must be between 1,000 and 10,000,000 KES');
      }
      update.monthlyLimit = ml;
    }

    if (Object.keys(update).length === 0) {
      throw new HttpsError('invalid-argument', 'No valid fields to update');
    }

    update.updatedAt = Timestamp.now();

    await db.collection('sfosIdentity').doc(uid).set(update, { merge: true });

    await _writeAuditLog(db, uid, 'IDENTITY_UPDATE', 'sfosIdentity', uid, {
      before: oldData,
      after:  update,
    }, 'INFO');

    const refreshed = await db.collection('sfosIdentity').doc(uid).get();
    return refreshed.data();
  } catch (e) {
    _log('error', 'sfosIdentityUpdate', { uid, err: e.message });
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'Failed to update identity');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. sfosLedgerQuery
// ══════════════════════════════════════════════════════════════════════════════

exports.sfosLedgerQuery = onCall(BASE_OPTS, async (request) => {
  const uid  = _requireAuth(request);
  const db   = _db();
  const data = request.data || {};

  const accountId  = _san(data.accountId || uid, 128);
  const ledgerType = data.ledgerType || null;
  const limit      = Math.min(Number(data.limit) || 50, 500);

  // Callers can only query their own account unless they are admin
  if (accountId !== uid) {
    _requireAdmin(request);
  }

  try {
    let q = db.collection('sfosLedger')
      .where('accountId', '==', accountId)
      .orderBy('createdAt', 'desc')
      .limit(limit);

    if (ledgerType && VALID_LEDGER_TYPES.has(ledgerType)) {
      q = db.collection('sfosLedger')
        .where('accountId',  '==', accountId)
        .where('ledgerType', '==', ledgerType)
        .orderBy('createdAt', 'desc')
        .limit(limit);
    }

    if (data.startDate) {
      const start = Timestamp.fromDate(new Date(data.startDate));
      q = q.where('createdAt', '>=', start);
    }
    if (data.endDate) {
      const end = Timestamp.fromDate(new Date(data.endDate));
      q = q.where('createdAt', '<=', end);
    }

    const snap    = await q.get();
    const entries = snap.docs.map(d => d.data());

    return { entries, total: entries.length };
  } catch (e) {
    _log('error', 'sfosLedgerQuery', { uid, err: e.message });
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'Failed to query ledger');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. sfosTransact  — THE UNIVERSAL TRANSACTION ENGINE
// ══════════════════════════════════════════════════════════════════════════════

exports.sfosTransact = onCall(BASE_OPTS, async (request) => {
  const uid  = _requireAuth(request);
  const db   = _db();
  const data = request.data || {};

  try {
    // ── 1. Validate inputs ────────────────────────────────────────────────────
    const amount    = _assertPositiveAmount(data.amount);
    const txType    = _san(data.type, 50);
    if (!VALID_TX_TYPES.has(txType)) {
      throw new HttpsError('invalid-argument', `Unknown transaction type: ${txType}`);
    }
    const toId      = _san(data.toId     || '', 128) || null;
    const note      = _san(data.note     || '', 300);
    const reference = _san(data.reference || '', 100);
    const currency  = 'KES';

    // ── 2. Load / create identity ─────────────────────────────────────────────
    const { data: identity } = await _ensureIdentity(db, uid, request.auth);

    // ── 3. Frozen check ───────────────────────────────────────────────────────
    const walletSnap = await db.collection('wallets').doc(uid).get();
    const walletData = walletSnap.exists ? walletSnap.data() : {};
    if (walletData.frozen || identity.status === 'frozen' || identity.status === 'suspended') {
      throw new HttpsError('failed-precondition', 'WALLET_FROZEN');
    }

    // ── 4. Velocity check ─────────────────────────────────────────────────────
    const velocity = await _velocityCheck(db, uid, amount);
    if (!velocity.allowed) {
      throw new HttpsError('resource-exhausted', 'VELOCITY_EXCEEDED');
    }

    // ── 5. Risk score ─────────────────────────────────────────────────────────
    const risk      = await _riskScore(db, uid, txType, amount, toId);
    const fraudFlag = risk > 80;

    // ── 6. Determine ledger pair ──────────────────────────────────────────────
    const [fromLedger, toLedger] = _ledgerPair(txType);

    // ── 7. Firestore runTransaction ───────────────────────────────────────────
    const txId = crypto.randomUUID();
    const now  = Timestamp.now();

    let debitEntryId, creditEntryId;
    let fromBalanceAfter = 0;
    let toBalanceAfter   = 0;
    let fromBalanceBefore = 0;
    let toBefore          = 0;

    await db.runTransaction(async (t) => {
      // Read source balance
      const srcRef  = db.collection('wallets').doc(uid);
      const srcSnap = await t.get(srcRef);
      const srcData = srcSnap.exists ? srcSnap.data() : { balance: 0 };

      let sourceBalance;
      if (fromLedger === 'WALLET') {
        sourceBalance = srcData.balance || 0;
      } else if (fromLedger === 'SAVINGS') {
        sourceBalance = srcData.savingsBalance || 0;
      } else if (fromLedger === 'ESCROW') {
        sourceBalance = srcData.pendingBalance || 0; // escrow held in pendingBalance
      } else {
        sourceBalance = 0; // EXTERNAL / PLATFORM — no deduction from wallet
      }

      fromBalanceBefore = sourceBalance;

      // Sufficient funds check for deductions from user wallet
      const deductsFromUser = ['WALLET', 'SAVINGS', 'ESCROW'].includes(fromLedger);
      if (deductsFromUser && sourceBalance < amount) {
        throw new HttpsError('failed-precondition', 'INSUFFICIENT_BALANCE');
      }

      fromBalanceAfter = deductsFromUser ? sourceBalance - amount : sourceBalance;

      // Read destination balance
      let destRef, destData, destBalance;
      if (toId && toId !== 'PLATFORM' && toLedger === 'WALLET') {
        destRef  = db.collection('wallets').doc(toId);
        const destSnap = await t.get(destRef);
        destData   = destSnap.exists ? destSnap.data() : { balance: 0 };
        destBalance = destData.balance || 0;
      } else {
        destBalance = 0;
      }

      toBefore       = destBalance;
      toBalanceAfter = toLedger === 'WALLET' && destRef ? destBalance + amount : destBalance;

      // Write ledger entries
      const [d, c] = _writeLedgerEntries(
        t, db, txId, txType,
        uid, toId || 'PLATFORM',
        fromLedger, toLedger,
        amount, currency,
        fromBalanceBefore, fromBalanceAfter,
        toBefore, toBalanceAfter,
        note || txType,
      );
      debitEntryId  = d;
      creditEntryId = c;

      // Update source wallet
      if (fromLedger === 'WALLET') {
        t.update(srcRef, { balance: fromBalanceAfter, updatedAt: now });
      } else if (fromLedger === 'SAVINGS') {
        t.update(srcRef, { savingsBalance: fromBalanceAfter, updatedAt: now });
      } else if (fromLedger === 'ESCROW') {
        t.update(srcRef, { pendingBalance: fromBalanceAfter, updatedAt: now });
      } else if (fromLedger === 'EXTERNAL' || fromLedger === 'PLATFORM') {
        // Deposit / cashback — credit wallet
        if (toLedger === 'WALLET') {
          const curBal = srcData.balance || 0;
          t.update(srcRef, { balance: curBal + amount, updatedAt: now });
          fromBalanceAfter = curBal + amount;
        }
      }

      // Update destination wallet (WALLET → WALLET transfers)
      if (destRef && toLedger === 'WALLET') {
        t.update(destRef, { balance: toBalanceAfter, updatedAt: now });
      }

      // When locking to escrow: increase pendingBalance on caller wallet
      if (toLedger === 'ESCROW') {
        const curPending = srcData.pendingBalance || 0;
        t.update(srcRef, {
          pendingBalance: curPending + amount,
          balance:        fromBalanceAfter,
          updatedAt:      now,
        });
      }

      // Write sfosTransactions
      const txDoc = {
        txId,
        type:          txType,
        status:        'COMPLETED',
        amount,
        currency,
        fromId:        uid,
        toId:          toId || 'PLATFORM',
        fromLedger,
        toLedger,
        note,
        reference,
        riskScore:     risk,
        fraudFlag,
        velocityFlag:  false,
        initiatorUid:  uid,
        deviceId:      _san(data.metadata?.deviceId || '', 64) || null,
        ipHash:        data.metadata?.ipHash ? _sha256(data.metadata.ipHash) : null,
        ledgerEntries: [debitEntryId, creditEntryId],
        digitalReceipt: null,
        createdAt:     now,
        completedAt:   now,
        legacyTxId:    txId,
        metadata:      data.metadata || null,
      };
      t.set(db.collection('sfosTransactions').doc(txId), txDoc);

      // Legacy walletTransactions mirror
      t.set(db.collection('walletTransactions').doc(txId), {
        txId,
        type:       txType,
        amount,
        currency,
        fromId:     uid,
        toId:       toId || 'PLATFORM',
        note,
        reference,
        status:     'COMPLETED',
        createdAt:  now,
        sfosMirror: true,
      });
    });

    // ── 8. Post-transaction (async, non-blocking) ─────────────────────────────
    const postTx = async () => {
      try {
        // Update lastTransactionAt
        await db.collection('sfosIdentity').doc(uid).update({
          lastTransactionAt: Timestamp.now(),
          updatedAt:         Timestamp.now(),
        });

        // Update velocity counters for outbound transfers
        const deductsFromUser = ['WALLET', 'SAVINGS', 'ESCROW'].includes(fromLedger);
        if (deductsFromUser) {
          await _updateVelocity(db, uid, amount);
        }

        // Rewards
        await _updateRewards(db, uid, txType, amount);

        // Notifications (fire-and-forget: write to notifications collection)
        const notifBase = {
          txId,
          txType,
          amount,
          currency: 'KES',
          createdAt: Timestamp.now(),
          read: false,
        };

        await db.collection('notifications').add({
          ...notifBase,
          uid,
          title:   'Transaction Complete',
          body:    `${txType.replace(/_/g, ' ')}: KSh ${amount.toLocaleString()}`,
          type:    'transaction',
        });

        if (toId && toId !== 'PLATFORM') {
          await db.collection('notifications').add({
            ...notifBase,
            uid:   toId,
            title: 'Funds Received',
            body:  `You received KSh ${amount.toLocaleString()} via ${txType.replace(/_/g, ' ')}`,
            type:  'transaction',
          });
        }

        // Flag suspicious transactions
        if (fraudFlag) {
          await _writeAuditLog(db, uid, 'FRAUD_FLAG', 'sfosTransactions', txId, {
            meta: { riskScore: risk, amount, txType, toId },
          }, 'CRITICAL');
        }
      } catch (e) {
        _log('warn', 'post-transaction async error', { txId, err: e.message });
      }
    };

    // Do not await — let the transaction return immediately
    postTx().catch(e => _log('warn', 'postTx uncaught', { txId, err: e.message }));

    // ── 9. Build receipt & return ─────────────────────────────────────────────
    const receipt = _generateReceipt({
      txId,
      createdAt: Timestamp.now(),
      fromId:    uid,
      toId:      toId || 'PLATFORM',
      amount,
      type:      txType,
      reference,
      status:    'COMPLETED',
    });

    return {
      txId,
      status:       'COMPLETED',
      receipt,
      ledgerEntries: [debitEntryId, creditEntryId],
      riskScore:    risk,
      fraudFlag,
    };
  } catch (e) {
    _log('error', 'sfosTransact', { uid, err: e.message });
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'Transaction failed');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. sfosTransactReverse
// ══════════════════════════════════════════════════════════════════════════════

exports.sfosTransactReverse = onCall(BASE_OPTS, async (request) => {
  const uid = _requireAuth(request);
  _requireAdmin(request);
  const db   = _db();
  const data = request.data || {};

  const originalTxId = _san(data.txId,   128);
  const reason       = _san(data.reason, 500);

  if (!originalTxId) throw new HttpsError('invalid-argument', 'txId required');
  if (!reason)       throw new HttpsError('invalid-argument', 'reason required');

  try {
    const txSnap = await db.collection('sfosTransactions').doc(originalTxId).get();
    if (!txSnap.exists) throw new HttpsError('not-found', 'ENTITY_NOT_FOUND');

    const tx = txSnap.data();
    if (tx.status !== 'COMPLETED') {
      throw new HttpsError('failed-precondition', `Cannot reverse a transaction with status ${tx.status}`);
    }

    const reversalTxId = crypto.randomUUID();
    const now          = Timestamp.now();

    await db.runTransaction(async (t) => {
      // Swap from/to and ledger directions
      const fromRef = db.collection('wallets').doc(tx.toId);
      const toRef   = db.collection('wallets').doc(tx.fromId);

      const fromSnap = await t.get(fromRef);
      const toSnap   = await t.get(toRef);

      const fromBal  = fromSnap.exists ? (fromSnap.data().balance || 0) : 0;
      const toBal    = toSnap.exists   ? (toSnap.data().balance   || 0) : 0;

      // Only do balance adjustments if both sides are real wallet accounts
      if (tx.toId !== 'PLATFORM' && fromSnap.exists && toSnap.exists) {
        t.update(fromRef, { balance: fromBal - tx.amount, updatedAt: now });
        t.update(toRef,   { balance: toBal   + tx.amount, updatedAt: now });
      }

      // Write compensating ledger entries
      const [d, c] = _writeLedgerEntries(
        t, db, reversalTxId, 'REFUND',
        tx.toId, tx.fromId,
        tx.toLedger, tx.fromLedger,
        tx.amount, tx.currency,
        fromBal, fromBal - tx.amount,
        toBal,   toBal   + tx.amount,
        `REVERSAL of ${originalTxId}: ${reason}`,
      );

      // Write reversal transaction
      t.set(db.collection('sfosTransactions').doc(reversalTxId), {
        txId:            reversalTxId,
        type:            'REFUND',
        status:          'COMPLETED',
        amount:          tx.amount,
        currency:        tx.currency,
        fromId:          tx.toId,
        toId:            tx.fromId,
        fromLedger:      tx.toLedger,
        toLedger:        tx.fromLedger,
        note:            `Reversal: ${reason}`,
        reference:       `REV-${originalTxId}`,
        riskScore:       0,
        fraudFlag:       false,
        velocityFlag:    false,
        initiatorUid:    uid,
        ledgerEntries:   [d, c],
        digitalReceipt:  null,
        createdAt:       now,
        completedAt:     now,
        reversalOf:      originalTxId,
      });

      // Mark original as REVERSED
      t.update(db.collection('sfosTransactions').doc(originalTxId), {
        status:      'REVERSED',
        reversalTxId,
        reversedAt:  now,
        reversedBy:  uid,
        reversalReason: reason,
      });
    });

    await _writeAuditLog(db, uid, 'TRANSACTION_REVERSED', 'sfosTransactions', originalTxId, {
      meta: { reversalTxId, reason, amount: txSnap.data().amount },
    }, 'CRITICAL');

    return { reversalTxId, status: 'REVERSED', originalTxId };
  } catch (e) {
    _log('error', 'sfosTransactReverse', { uid, err: e.message });
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'Reversal failed');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. sfosWalletGet
// ══════════════════════════════════════════════════════════════════════════════

exports.sfosWalletGet = onCall(BASE_OPTS, async (request) => {
  const uid = _requireAuth(request);
  const db  = _db();

  try {
    const { data: identity } = await _ensureIdentity(db, uid, request.auth);

    // Parallel reads
    const [walletSnap, rewardsSnap, merchantSnap, recentTxSnap, savingsSnap] = await Promise.all([
      db.collection('wallets').doc(uid).get(),
      db.collection('sfosRewards').doc(uid).get(),
      db.collection('sfosMerchant').doc(uid).get(),
      db.collection('sfosTransactions')
        .where('fromId', '==', uid)
        .orderBy('createdAt', 'desc')
        .limit(5)
        .get(),
      db.collection('wallets').doc(uid).collection('savings').get(),
    ]);

    const wallet  = walletSnap.exists  ? walletSnap.data()  : {};
    const rewards = rewardsSnap.exists ? rewardsSnap.data() : {};

    // Savings summary
    let savingsTotal = 0;
    let savingsCount = 0;
    savingsSnap.docs.forEach(d => {
      savingsTotal += d.data().balance || 0;
      savingsCount++;
    });

    const recentTransactions = recentTxSnap.docs.map(d => d.data());

    const result = {
      identity,
      walletId:  identity.walletId,
      tier:      identity.tier || 'bronze',
      balances: {
        available:     wallet.balance         || 0,
        pending:       wallet.pendingBalance  || 0,
        savings:       savingsTotal,
        escrow:        wallet.pendingBalance  || 0,
        rewards:       (rewards.points || 0) * POINTS_TO_KES,
        cashback:      wallet.cashbackBalance || 0,
        merchantFloat: merchantSnap.exists ? (merchantSnap.data().pendingSettlement || 0) : 0,
      },
      limits: {
        daily:          identity.dailyLimit   || DEFAULT_DAILY_LIMIT,
        monthly:        identity.monthlyLimit || DEFAULT_MONTHLY_LIMIT,
        dailySpent:     identity.dailySpent   || 0,
        monthlySpent:   identity.monthlySpent || 0,
      },
      recentTransactions,
      rewards: {
        points:         rewards.points        || 0,
        lifetimePoints: rewards.lifetimePoints || 0,
        cashback:       rewards.cashback       || 0,
        tier:           rewards.tier           || 'bronze',
        tierProgressPct: rewards.tierProgressPct || 0,
        nextTierPoints: rewards.nextTierPoints || TIER_THRESHOLDS.silver,
        achievements:   rewards.achievements  || [],
      },
      savingsVaultCount: savingsCount,
      savingsTotal,
      merchant: merchantSnap.exists ? merchantSnap.data() : null,
      financialScore: identity.financialScore || 50,
      currency: 'KES',
      frozen:   wallet.frozen || false,
      kycStatus: identity.kycStatus || 'none',
    };

    return result;
  } catch (e) {
    _log('error', 'sfosWalletGet', { uid, err: e.message });
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'Failed to load wallet');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. sfosEscrowCreate
// ══════════════════════════════════════════════════════════════════════════════

exports.sfosEscrowCreate = onCall(BASE_OPTS, async (request) => {
  const uid  = _requireAuth(request);
  const db   = _db();
  const data = request.data || {};

  const VALID_ESCROW_TYPES = new Set(['MARKETPLACE', 'PROPERTY', 'CONSTRUCTION', 'FREELANCE', 'GENERAL']);

  try {
    const amount      = _assertPositiveAmount(data.amount);
    const title       = _san(data.title,       120);
    const description = _san(data.description, 500);
    const type        = _san(data.type,          30);

    if (!title)                     throw new HttpsError('invalid-argument', 'title required');
    if (!VALID_ESCROW_TYPES.has(type)) throw new HttpsError('invalid-argument', 'Invalid escrow type');

    // Resolve sellerUid from phone if provided
    let sellerUid = _san(data.sellerUid || '', 128) || null;
    if (!sellerUid && data.sellerPhone) {
      const phone = _normalizePhone(data.sellerPhone);
      if (phone) {
        const q = await db.collection('users')
          .where('phone', '==', phone)
          .limit(1)
          .get();
        if (!q.empty) sellerUid = q.docs[0].id;
      }
    }

    // Validate buyer has enough balance
    const walletSnap = await db.collection('wallets').doc(uid).get();
    const available  = walletSnap.exists ? (walletSnap.data().balance || 0) : 0;
    if (available < amount) {
      throw new HttpsError('failed-precondition', 'INSUFFICIENT_BALANCE');
    }

    // Parse milestones
    const rawMilestones = Array.isArray(data.milestones) ? data.milestones : [];
    const milestones    = rawMilestones.map((m, idx) => ({
      id:          `ms_${idx + 1}`,
      title:       _san(m.title || `Milestone ${idx + 1}`, 120),
      amount:      _assertPositiveAmount(m.amount),
      status:      'PENDING',
      releasedAt:  null,
    }));

    // Lock funds via sfosTransact
    const escrowId = _genId('esc');

    // Use internal transaction rather than calling the exported CF to avoid double auth
    const now = Timestamp.now();
    const txId = crypto.randomUUID();

    await db.runTransaction(async (t) => {
      const srcRef  = db.collection('wallets').doc(uid);
      const srcSnap = await t.get(srcRef);
      const srcData = srcSnap.exists ? srcSnap.data() : { balance: 0 };
      const balance = srcData.balance || 0;

      if (balance < amount) throw new HttpsError('failed-precondition', 'INSUFFICIENT_BALANCE');

      const [d, c] = _writeLedgerEntries(
        t, db, txId, 'ESCROW_LOCK',
        uid, escrowId,
        'WALLET', 'ESCROW',
        amount, 'KES',
        balance, balance - amount,
        0, amount,
        `Escrow lock: ${title}`,
      );

      t.update(srcRef, {
        balance:        balance - amount,
        pendingBalance: FieldValue.increment(amount),
        updatedAt:      now,
      });

      t.set(db.collection('sfosTransactions').doc(txId), {
        txId, type: 'ESCROW_LOCK', status: 'COMPLETED',
        amount, currency: 'KES',
        fromId: uid, toId: escrowId,
        fromLedger: 'WALLET', toLedger: 'ESCROW',
        note: `Escrow: ${title}`, reference: escrowId,
        riskScore: 0, fraudFlag: false, velocityFlag: false,
        initiatorUid: uid, ledgerEntries: [d, c],
        digitalReceipt: null, createdAt: now, completedAt: now,
      });

      t.set(db.collection('sfosEscrow').doc(escrowId), {
        escrowId,
        title,
        description,
        type,
        buyerUid:        uid,
        sellerUid:       sellerUid || null,
        adminUid:        null,
        totalAmount:     amount,
        fundedAmount:    amount,
        releasedAmount:  0,
        status:          'FUNDED',
        milestones,
        releaseCondition: _san(data.releaseCondition || '', 300) || null,
        disputeReason:   null,
        autoReleaseAt:   data.autoReleaseDays
          ? Timestamp.fromMillis(Date.now() + data.autoReleaseDays * 86_400_000)
          : null,
        lockTxId:        txId,
        createdAt:       now,
        updatedAt:       now,
      });
    });

    return { escrowId, status: 'FUNDED', amount, txId };
  } catch (e) {
    _log('error', 'sfosEscrowCreate', { uid, err: e.message });
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'Failed to create escrow');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. sfosEscrowRelease
// ══════════════════════════════════════════════════════════════════════════════

exports.sfosEscrowRelease = onCall(BASE_OPTS, async (request) => {
  const uid  = _requireAuth(request);
  const db   = _db();
  const data = request.data || {};

  const escrowId   = _san(data.escrowId,   128);
  const milestoneId = _san(data.milestoneId || '', 32) || null;

  if (!escrowId) throw new HttpsError('invalid-argument', 'escrowId required');

  try {
    const escrowSnap = await db.collection('sfosEscrow').doc(escrowId).get();
    if (!escrowSnap.exists) throw new HttpsError('not-found', 'ENTITY_NOT_FOUND');

    const escrow = escrowSnap.data();
    const isAdmin  = request.auth?.token?.admin || request.auth?.token?.superAdmin;
    if (escrow.buyerUid !== uid && !isAdmin) {
      throw new HttpsError('permission-denied', 'Only the buyer or admin can release escrow');
    }

    if (!['FUNDED', 'PARTIAL'].includes(escrow.status)) {
      throw new HttpsError('failed-precondition', `Cannot release escrow in status: ${escrow.status}`);
    }

    let releaseAmount;
    let updatedMilestones = escrow.milestones ? [...escrow.milestones] : [];

    if (milestoneId) {
      const msIdx = updatedMilestones.findIndex(m => m.id === milestoneId);
      if (msIdx === -1) throw new HttpsError('not-found', 'Milestone not found');
      const ms = updatedMilestones[msIdx];
      if (ms.status === 'RELEASED') throw new HttpsError('failed-precondition', 'Milestone already released');
      releaseAmount = ms.amount;
      updatedMilestones[msIdx] = { ...ms, status: 'RELEASED', releasedAt: Timestamp.now() };
    } else {
      releaseAmount = data.amount
        ? _assertPositiveAmount(data.amount)
        : escrow.totalAmount - escrow.releasedAmount;
    }

    if (releaseAmount <= 0) throw new HttpsError('failed-precondition', 'No funds to release');

    const sellerUid = escrow.sellerUid;
    if (!sellerUid) throw new HttpsError('failed-precondition', 'No seller associated with this escrow');

    const now   = Timestamp.now();
    const txId  = crypto.randomUUID();

    let sellerNewBalance = 0;

    await db.runTransaction(async (t) => {
      const buyerRef  = db.collection('wallets').doc(escrow.buyerUid);
      const sellerRef = db.collection('wallets').doc(sellerUid);
      const [buyerSnap, sellerSnap] = await Promise.all([t.get(buyerRef), t.get(sellerRef)]);

      const buyerPending  = (buyerSnap.exists  ? buyerSnap.data().pendingBalance  : 0) || 0;
      const sellerBalance = (sellerSnap.exists  ? sellerSnap.data().balance        : 0) || 0;

      sellerNewBalance = sellerBalance + releaseAmount;

      const [d, c] = _writeLedgerEntries(
        t, db, txId, 'ESCROW_RELEASE',
        escrowId, sellerUid,
        'ESCROW', 'WALLET',
        releaseAmount, 'KES',
        escrow.fundedAmount - escrow.releasedAmount, escrow.fundedAmount - escrow.releasedAmount - releaseAmount,
        sellerBalance, sellerNewBalance,
        `Escrow release: ${escrow.title}`,
      );

      t.update(buyerRef,  { pendingBalance: Math.max(0, buyerPending - releaseAmount), updatedAt: now });
      t.update(sellerRef, { balance: sellerNewBalance, updatedAt: now });

      t.set(db.collection('sfosTransactions').doc(txId), {
        txId, type: 'ESCROW_RELEASE', status: 'COMPLETED',
        amount: releaseAmount, currency: 'KES',
        fromId: escrowId, toId: sellerUid,
        fromLedger: 'ESCROW', toLedger: 'WALLET',
        note: `Escrow release: ${escrow.title}`, reference: escrowId,
        riskScore: 0, fraudFlag: false, velocityFlag: false,
        initiatorUid: uid, ledgerEntries: [d, c],
        digitalReceipt: null, createdAt: now, completedAt: now,
      });

      const newReleasedAmount = escrow.releasedAmount + releaseAmount;
      const allReleased = newReleasedAmount >= escrow.totalAmount;

      // Update milestones statuses
      const allMsDone = updatedMilestones.length > 0 && updatedMilestones.every(m => m.status === 'RELEASED');

      t.update(db.collection('sfosEscrow').doc(escrowId), {
        releasedAmount:  newReleasedAmount,
        milestones:      updatedMilestones,
        status:          (allReleased || allMsDone) ? 'RELEASED' : 'PARTIAL',
        updatedAt:       now,
      });
    });

    return { releasedAmount: releaseAmount, sellerNewBalance, status: 'COMPLETED', txId };
  } catch (e) {
    _log('error', 'sfosEscrowRelease', { uid, err: e.message });
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'Escrow release failed');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 9. sfosEscrowDispute
// ══════════════════════════════════════════════════════════════════════════════

exports.sfosEscrowDispute = onCall(BASE_OPTS, async (request) => {
  const uid  = _requireAuth(request);
  const db   = _db();
  const data = request.data || {};

  const escrowId = _san(data.escrowId, 128);
  const reason   = _san(data.reason,   500);

  if (!escrowId) throw new HttpsError('invalid-argument', 'escrowId required');
  if (!reason)   throw new HttpsError('invalid-argument', 'reason required');

  try {
    const escrowSnap = await db.collection('sfosEscrow').doc(escrowId).get();
    if (!escrowSnap.exists) throw new HttpsError('not-found', 'ENTITY_NOT_FOUND');

    const escrow = escrowSnap.data();
    if (escrow.buyerUid !== uid && escrow.sellerUid !== uid) {
      throw new HttpsError('permission-denied', 'Only buyer or seller can raise a dispute');
    }

    if (!['FUNDED', 'PARTIAL'].includes(escrow.status)) {
      throw new HttpsError('failed-precondition', `Cannot dispute escrow in status: ${escrow.status}`);
    }

    const caseId = _genId('case');
    const now    = Timestamp.now();

    await db.collection('sfosEscrow').doc(escrowId).update({
      status:        'DISPUTED',
      disputeReason: reason,
      disputedBy:    uid,
      disputedAt:    now,
      updatedAt:     now,
    });

    await _writeAuditLog(db, uid, 'ESCROW_DISPUTED', 'sfosEscrow', escrowId, {
      meta: { reason, caseId },
    }, 'WARN');

    // Notify admins
    await db.collection('adminNotifications').add({
      type:      'ESCROW_DISPUTE',
      escrowId,
      caseId,
      raisedBy:  uid,
      reason,
      amount:    escrow.totalAmount,
      buyerUid:  escrow.buyerUid,
      sellerUid: escrow.sellerUid,
      createdAt: now,
      resolved:  false,
    });

    return { status: 'DISPUTED', caseId, escrowId };
  } catch (e) {
    _log('error', 'sfosEscrowDispute', { uid, err: e.message });
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'Failed to raise dispute');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 10. sfosEscrowRefund
// ══════════════════════════════════════════════════════════════════════════════

exports.sfosEscrowRefund = onCall(BASE_OPTS, async (request) => {
  const uid = _requireAuth(request);
  _requireAdmin(request);
  const db   = _db();
  const data = request.data || {};

  const escrowId = _san(data.escrowId, 128);
  const reason   = _san(data.reason,   500);

  if (!escrowId) throw new HttpsError('invalid-argument', 'escrowId required');

  try {
    const escrowSnap = await db.collection('sfosEscrow').doc(escrowId).get();
    if (!escrowSnap.exists) throw new HttpsError('not-found', 'ENTITY_NOT_FOUND');

    const escrow        = escrowSnap.data();
    const refundAmount  = escrow.totalAmount - (escrow.releasedAmount || 0);

    if (refundAmount <= 0) {
      throw new HttpsError('failed-precondition', 'No funds to refund');
    }

    const now  = Timestamp.now();
    const txId = crypto.randomUUID();

    await db.runTransaction(async (t) => {
      const buyerRef  = db.collection('wallets').doc(escrow.buyerUid);
      const buyerSnap = await t.get(buyerRef);
      const buyerBal  = (buyerSnap.exists ? buyerSnap.data().balance        : 0) || 0;
      const buyerPend = (buyerSnap.exists ? buyerSnap.data().pendingBalance : 0) || 0;

      const [d, c] = _writeLedgerEntries(
        t, db, txId, 'REFUND',
        escrowId, escrow.buyerUid,
        'ESCROW', 'WALLET',
        refundAmount, 'KES',
        refundAmount, 0,
        buyerBal, buyerBal + refundAmount,
        `Escrow refund: ${reason}`,
      );

      t.update(buyerRef, {
        balance:        buyerBal  + refundAmount,
        pendingBalance: Math.max(0, buyerPend - refundAmount),
        updatedAt:      now,
      });

      t.set(db.collection('sfosTransactions').doc(txId), {
        txId, type: 'REFUND', status: 'COMPLETED',
        amount: refundAmount, currency: 'KES',
        fromId: escrowId, toId: escrow.buyerUid,
        fromLedger: 'ESCROW', toLedger: 'WALLET',
        note: `Escrow refund: ${reason}`, reference: escrowId,
        riskScore: 0, fraudFlag: false, velocityFlag: false,
        initiatorUid: uid, ledgerEntries: [d, c],
        digitalReceipt: null, createdAt: now, completedAt: now,
      });

      t.update(db.collection('sfosEscrow').doc(escrowId), {
        status:    'REFUNDED',
        refundTxId: txId,
        refundReason: reason,
        refundedAt: now,
        updatedAt:  now,
      });
    });

    await _writeAuditLog(db, uid, 'ESCROW_REFUNDED', 'sfosEscrow', escrowId, {
      meta: { reason, refundAmount, txId },
    }, 'CRITICAL');

    return { refundedAmount: refundAmount, status: 'REFUNDED', txId };
  } catch (e) {
    _log('error', 'sfosEscrowRefund', { uid, err: e.message });
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'Escrow refund failed');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 11. sfosGroupCreate
// ══════════════════════════════════════════════════════════════════════════════

exports.sfosGroupCreate = onCall(BASE_OPTS, async (request) => {
  const uid  = _requireAuth(request);
  const db   = _db();
  const data = request.data || {};

  const VALID_GROUP_TYPES = new Set(['FAMILY', 'BUSINESS_TEAM', 'SAVINGS_GROUP', 'CUSTOM']);

  const name  = _san(data.name || '', 80);
  const type  = _san(data.type || 'CUSTOM', 30);

  if (!name)                          throw new HttpsError('invalid-argument', 'name required');
  if (!VALID_GROUP_TYPES.has(type))   throw new HttpsError('invalid-argument', 'Invalid group type');

  try {
    const groupId   = _genId('grp');
    const now       = Timestamp.now();

    const rawMembers   = Array.isArray(data.members) ? data.members : [];
    const membersList  = [
      { uid, role: 'owner', spendLimit: null, canWithdraw: true, addedAt: now },
      ...rawMembers
        .filter(m => m.uid && m.uid !== uid)
        .map(m => ({
          uid:         _san(m.uid, 128),
          role:        ['admin', 'member', 'viewer'].includes(m.role) ? m.role : 'member',
          spendLimit:  m.spendLimit ? Number(m.spendLimit) : null,
          canWithdraw: m.canWithdraw === true,
          addedAt:     now,
        })),
    ];

    const groupDoc = {
      groupId,
      name,
      type,
      ownerUid:          uid,
      totalBalance:      0,
      currency:          'KES',
      members:           membersList,
      requiresApproval:  data.requiresApproval === true,
      approvalThreshold: Number(data.approvalThreshold) || 1,
      createdAt:         now,
      updatedAt:         now,
    };

    const batch = db.batch();
    batch.set(db.collection('sfosGroups').doc(groupId), groupDoc);

    // Create sub-wallet for each member
    for (const m of membersList) {
      batch.set(
        db.collection('sfosGroups').doc(groupId).collection('wallets').doc(m.uid),
        {
          uid:        m.uid,
          balance:    0,
          role:       m.role,
          permissions: {
            canSend:     m.role !== 'viewer',
            canReceive:  true,
            canWithdraw: m.canWithdraw,
          },
          addedAt: now,
        },
      );
    }

    await batch.commit();
    return { groupId, name, memberCount: membersList.length };
  } catch (e) {
    _log('error', 'sfosGroupCreate', { uid, err: e.message });
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'Failed to create group');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 12. sfosGroupTransfer
// ══════════════════════════════════════════════════════════════════════════════

exports.sfosGroupTransfer = onCall(BASE_OPTS, async (request) => {
  const uid  = _requireAuth(request);
  const db   = _db();
  const data = request.data || {};

  const groupId = _san(data.groupId, 128);
  const toUid   = _san(data.toUid,   128);
  const amount  = _assertPositiveAmount(data.amount);
  const note    = _san(data.note || '', 300);

  if (!groupId) throw new HttpsError('invalid-argument', 'groupId required');
  if (!toUid)   throw new HttpsError('invalid-argument', 'toUid required');

  try {
    const groupSnap = await db.collection('sfosGroups').doc(groupId).get();
    if (!groupSnap.exists) throw new HttpsError('not-found', 'Group not found');

    const group      = groupSnap.data();
    const callerMember = group.members?.find(m => m.uid === uid);
    if (!callerMember) throw new HttpsError('permission-denied', 'Not a group member');

    // Check canSend permission from sub-wallet
    const callerWalletSnap = await db.collection('sfosGroups').doc(groupId)
      .collection('wallets').doc(uid).get();
    const callerWallet = callerWalletSnap.exists ? callerWalletSnap.data() : {};
    if (!callerWallet.permissions?.canSend) {
      throw new HttpsError('permission-denied', 'You do not have send permission in this group');
    }

    // Check spendLimit
    if (callerMember.spendLimit && amount > callerMember.spendLimit) {
      throw new HttpsError('failed-precondition', `Amount exceeds your group spend limit of KSh ${callerMember.spendLimit}`);
    }

    const now  = Timestamp.now();
    const txId = crypto.randomUUID();

    let newGroupBalance = 0;

    await db.runTransaction(async (t) => {
      const groupRef      = db.collection('sfosGroups').doc(groupId);
      const callerRef     = groupRef.collection('wallets').doc(uid);
      const recipientRef  = groupRef.collection('wallets').doc(toUid);

      const [callerSnap, recipientSnap, groupDocSnap] = await Promise.all([
        t.get(callerRef),
        t.get(recipientRef),
        t.get(groupRef),
      ]);

      const callerBal    = (callerSnap.exists    ? callerSnap.data().balance    : 0) || 0;
      const recipientBal = (recipientSnap.exists ? recipientSnap.data().balance : 0) || 0;

      if (callerBal < amount) throw new HttpsError('failed-precondition', 'INSUFFICIENT_BALANCE');

      const [d, c] = _writeLedgerEntries(
        t, db, txId, 'WALLET_TRANSFER',
        uid, toUid,
        'WALLET', 'WALLET',
        amount, 'KES',
        callerBal, callerBal - amount,
        recipientBal, recipientBal + amount,
        note || 'Group transfer',
      );

      t.update(callerRef,    { balance: callerBal - amount,    updatedAt: now });
      t.update(recipientRef, { balance: recipientBal + amount, updatedAt: now });

      newGroupBalance = (groupDocSnap.exists ? groupDocSnap.data().totalBalance : 0) || 0;

      t.set(db.collection('sfosTransactions').doc(txId), {
        txId, type: 'WALLET_TRANSFER', status: 'COMPLETED',
        amount, currency: 'KES',
        fromId: uid, toId: toUid,
        fromLedger: 'WALLET', toLedger: 'WALLET',
        note, reference: groupId,
        riskScore: 0, fraudFlag: false, velocityFlag: false,
        initiatorUid: uid, ledgerEntries: [d, c],
        groupId,
        digitalReceipt: null, createdAt: now, completedAt: now,
      });
    });

    return { txId, newGroupBalance, status: 'COMPLETED' };
  } catch (e) {
    _log('error', 'sfosGroupTransfer', { uid, err: e.message });
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'Group transfer failed');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 13. sfosGroupGet
// ══════════════════════════════════════════════════════════════════════════════

exports.sfosGroupGet = onCall(BASE_OPTS, async (request) => {
  const uid  = _requireAuth(request);
  const db   = _db();
  const data = request.data || {};

  const groupId = _san(data.groupId, 128);
  if (!groupId) throw new HttpsError('invalid-argument', 'groupId required');

  try {
    const groupSnap = await db.collection('sfosGroups').doc(groupId).get();
    if (!groupSnap.exists) throw new HttpsError('not-found', 'Group not found');

    const group = groupSnap.data();
    if (!group.members?.find(m => m.uid === uid)) {
      throw new HttpsError('permission-denied', 'Not a member of this group');
    }

    const walletsSnap = await db.collection('sfosGroups').doc(groupId)
      .collection('wallets').get();
    const memberWallets = {};
    walletsSnap.docs.forEach(d => { memberWallets[d.id] = d.data(); });

    const enrichedMembers = group.members.map(m => ({
      ...m,
      balance:     memberWallets[m.uid]?.balance || 0,
      permissions: memberWallets[m.uid]?.permissions || {},
    }));

    return {
      group: { ...group, members: enrichedMembers },
      members: enrichedMembers,
      balance: group.totalBalance || 0,
    };
  } catch (e) {
    _log('error', 'sfosGroupGet', { uid, err: e.message });
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'Failed to load group');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 14. sfosMerchantDashboard
// ══════════════════════════════════════════════════════════════════════════════

exports.sfosMerchantDashboard = onCall(BASE_OPTS, async (request) => {
  const uid  = _requireAuth(request);
  const db   = _db();
  const data = request.data || {};

  const merchantId = _san(data.merchantId || uid, 128);

  // Verify ownership unless admin
  if (merchantId !== uid) {
    const isAdmin = request.auth?.token?.admin || request.auth?.token?.superAdmin;
    if (!isAdmin) {
      const shopSnap = await db.collection('shops').doc(merchantId).get();
      if (!shopSnap.exists || shopSnap.data().ownerUid !== uid) {
        throw new HttpsError('permission-denied', 'Not your merchant account');
      }
    }
  }

  try {
    const now          = new Date();
    const thirtyDaysAgo = Timestamp.fromMillis(now.getTime() - 30 * 86_400_000);

    const [merchantSnap, txSnap] = await Promise.all([
      db.collection('sfosMerchant').doc(merchantId).get(),
      db.collection('sfosTransactions')
        .where('toId',      '==', merchantId)
        .where('createdAt', '>=', thirtyDaysAgo)
        .orderBy('createdAt', 'desc')
        .limit(500)
        .get(),
    ]);

    const merchant = merchantSnap.exists ? merchantSnap.data() : {
      merchantId, dailyRevenue: 0, weeklyRevenue: 0, monthlyRevenue: 0,
      lifetimeRevenue: 0, pendingSettlement: 0, settledAmount: 0,
      commissionPaid: 0, refundsIssued: 0,
    };

    // Aggregate daily breakdown
    const byDay = {};
    let totalIn = 0;
    let commissions = 0;
    let refunds     = 0;

    txSnap.docs.forEach(d => {
      const tx       = d.data();
      const dateStr  = tx.createdAt ? new Date(tx.createdAt.toMillis()).toISOString().slice(0, 10) : 'unknown';
      if (!byDay[dateStr]) byDay[dateStr] = { in: 0, out: 0, count: 0 };

      if (tx.type === 'COMMISSION') {
        commissions += tx.amount;
        byDay[dateStr].out += tx.amount;
      } else if (tx.type === 'REFUND') {
        refunds += tx.amount;
        byDay[dateStr].out += tx.amount;
      } else {
        totalIn += tx.amount;
        byDay[dateStr].in += tx.amount;
        byDay[dateStr].count++;
      }
    });

    return {
      ...merchant,
      analytics: {
        totalIn,
        commissions,
        refunds,
        netRevenue: totalIn - commissions - refunds,
        byDay,
        transactionCount: txSnap.size,
      },
    };
  } catch (e) {
    _log('error', 'sfosMerchantDashboard', { uid, err: e.message });
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'Failed to load merchant dashboard');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 15. sfosMerchantSettle
// ══════════════════════════════════════════════════════════════════════════════

exports.sfosMerchantSettle = onCall(BASE_OPTS, async (request) => {
  const uid  = _requireAuth(request);
  const db   = _db();
  const data = request.data || {};

  const merchantId = _san(data.merchantId || uid, 128);

  try {
    // Ownership verification
    if (merchantId !== uid) {
      const isAdmin = request.auth?.token?.admin || request.auth?.token?.superAdmin;
      if (!isAdmin) {
        const shopSnap = await db.collection('shops').doc(merchantId).get();
        if (!shopSnap.exists || shopSnap.data().ownerUid !== uid) {
          throw new HttpsError('permission-denied', 'Not your merchant account');
        }
      }
    }

    const merchantRef  = db.collection('sfosMerchant').doc(merchantId);
    const merchantSnap = await merchantRef.get();

    const merchant         = merchantSnap.exists ? merchantSnap.data() : {};
    const pendingAmount    = data.amount
      ? _assertPositiveAmount(data.amount)
      : (merchant.pendingSettlement || 0);

    if (pendingAmount <= 0) {
      throw new HttpsError('failed-precondition', 'No pending settlement amount');
    }

    const now  = Timestamp.now();
    const txId = crypto.randomUUID();

    let merchantWalletBalance = 0;

    await db.runTransaction(async (t) => {
      const walletRef  = db.collection('wallets').doc(merchantId);
      const walletSnap = await t.get(walletRef);
      const walletData = walletSnap.exists ? walletSnap.data() : { balance: 0 };
      const balance    = walletData.balance || 0;

      merchantWalletBalance = balance + pendingAmount;

      const [d, c] = _writeLedgerEntries(
        t, db, txId, 'MERCHANT_SETTLEMENT',
        'PLATFORM', merchantId,
        'ESCROW', 'MERCHANT',
        pendingAmount, 'KES',
        pendingAmount, 0,
        balance, merchantWalletBalance,
        'Merchant settlement payout',
      );

      t.update(walletRef, { balance: merchantWalletBalance, updatedAt: now });

      t.set(db.collection('sfosTransactions').doc(txId), {
        txId, type: 'MERCHANT_SETTLEMENT', status: 'COMPLETED',
        amount: pendingAmount, currency: 'KES',
        fromId: 'PLATFORM', toId: merchantId,
        fromLedger: 'ESCROW', toLedger: 'MERCHANT',
        note: 'Settlement payout', reference: null,
        riskScore: 0, fraudFlag: false, velocityFlag: false,
        initiatorUid: uid, ledgerEntries: [d, c],
        digitalReceipt: null, createdAt: now, completedAt: now,
      });

      t.set(merchantRef, {
        merchantId,
        pendingSettlement: 0,
        settledAmount:     FieldValue.increment(pendingAmount),
        lastSettlementAt:  now,
        updatedAt:         now,
      }, { merge: true });
    });

    return { settledAmount: pendingAmount, newBalance: merchantWalletBalance, txId };
  } catch (e) {
    _log('error', 'sfosMerchantSettle', { uid, err: e.message });
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'Settlement failed');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 16. sfosRewardsGet
// ══════════════════════════════════════════════════════════════════════════════

exports.sfosRewardsGet = onCall(BASE_OPTS, async (request) => {
  const uid = _requireAuth(request);
  const db  = _db();

  try {
    const rewardsRef  = db.collection('sfosRewards').doc(uid);
    const rewardsSnap = await rewardsRef.get();

    let rewards;
    if (!rewardsSnap.exists) {
      rewards = {
        uid,
        points:          0,
        lifetimePoints:  0,
        cashback:        0,
        tier:            'bronze',
        tierProgressPct: 0,
        nextTierPoints:  TIER_THRESHOLDS.silver,
        streakDays:      0,
        streakLastAt:    null,
        achievements:    [],
        updatedAt:       Timestamp.now(),
      };
      await rewardsRef.set(rewards);
    } else {
      rewards = rewardsSnap.data();
    }

    // Last 10 reward events from sfosTransactions
    const historySnap = await db.collection('sfosTransactions')
      .where('fromId', '==', uid)
      .where('type',   'in', ['CASHBACK', 'LOYALTY_REDEMPTION'])
      .orderBy('createdAt', 'desc')
      .limit(10)
      .get();

    return {
      ...rewards,
      pointsValueKes: (rewards.points || 0) * POINTS_TO_KES,
      history:        historySnap.docs.map(d => d.data()),
    };
  } catch (e) {
    _log('error', 'sfosRewardsGet', { uid, err: e.message });
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'Failed to load rewards');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 17. sfosRewardsRedeem
// ══════════════════════════════════════════════════════════════════════════════

exports.sfosRewardsRedeem = onCall(BASE_OPTS, async (request) => {
  const uid  = _requireAuth(request);
  const db   = _db();
  const data = request.data || {};

  const points         = Math.floor(Number(data.points));
  const redemptionType = _san(data.redemptionType || 'CASHBACK', 20);

  if (!Number.isFinite(points) || points <= 0) {
    throw new HttpsError('invalid-argument', 'points must be a positive integer');
  }
  if (!['CASHBACK', 'DISCOUNT', 'PRODUCT'].includes(redemptionType)) {
    throw new HttpsError('invalid-argument', 'Invalid redemption type');
  }

  try {
    const rewardsRef  = db.collection('sfosRewards').doc(uid);
    const rewardsSnap = await rewardsRef.get();
    const currentPts  = rewardsSnap.exists ? (rewardsSnap.data().points || 0) : 0;

    if (currentPts < points) {
      throw new HttpsError('failed-precondition', `Insufficient points. You have ${currentPts}, need ${points}`);
    }

    const credited  = Math.round(points * POINTS_TO_KES * 100) / 100; // KES
    const now       = Timestamp.now();
    const txId      = crypto.randomUUID();

    if (redemptionType === 'CASHBACK') {
      await db.runTransaction(async (t) => {
        const walletRef  = db.collection('wallets').doc(uid);
        const walletSnap = await t.get(walletRef);
        const balance    = (walletSnap.exists ? walletSnap.data().balance : 0) || 0;

        const [d, c] = _writeLedgerEntries(
          t, db, txId, 'CASHBACK',
          'PLATFORM', uid,
          'PLATFORM', 'WALLET',
          credited, 'KES',
          0, 0,
          balance, balance + credited,
          `Rewards cashback: ${points} pts → KSh ${credited}`,
        );

        t.update(walletRef, { balance: balance + credited, updatedAt: now });
        t.update(rewardsRef, {
          points:   currentPts - points,
          cashback: FieldValue.increment(credited),
          updatedAt: now,
        });

        t.set(db.collection('sfosTransactions').doc(txId), {
          txId, type: 'CASHBACK', status: 'COMPLETED',
          amount: credited, currency: 'KES',
          fromId: 'PLATFORM', toId: uid,
          fromLedger: 'PLATFORM', toLedger: 'WALLET',
          note: `Rewards redemption: ${points} pts`, reference: null,
          riskScore: 0, fraudFlag: false, velocityFlag: false,
          initiatorUid: uid, ledgerEntries: [d, c],
          digitalReceipt: null, createdAt: now, completedAt: now,
        });
      });
    } else {
      // DISCOUNT / PRODUCT — just deduct points, no wallet credit
      await rewardsRef.update({
        points:    currentPts - points,
        updatedAt: now,
      });
    }

    return { redeemed: points, credited: redemptionType === 'CASHBACK' ? credited : 0, newPoints: currentPts - points, txId };
  } catch (e) {
    _log('error', 'sfosRewardsRedeem', { uid, err: e.message });
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'Redemption failed');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 18. sfosFinancialHealth
// ══════════════════════════════════════════════════════════════════════════════

exports.sfosFinancialHealth = onCall(BASE_OPTS, async (request) => {
  const uid = _requireAuth(request);
  const db  = _db();

  try {
    const thirtyDaysAgo = Timestamp.fromMillis(Date.now() - 30 * 86_400_000);

    const [walletSnap, identitySnap, rewardsSnap, txInSnap, txOutSnap, failedSnap, savingsSnap] = await Promise.all([
      db.collection('wallets').doc(uid).get(),
      db.collection('sfosIdentity').doc(uid).get(),
      db.collection('sfosRewards').doc(uid).get(),
      db.collection('sfosTransactions')
        .where('toId',      '==', uid)
        .where('createdAt', '>=', thirtyDaysAgo)
        .get(),
      db.collection('sfosTransactions')
        .where('fromId',    '==', uid)
        .where('createdAt', '>=', thirtyDaysAgo)
        .get(),
      db.collection('sfosTransactions')
        .where('fromId',    '==', uid)
        .where('status',    '==', 'FAILED')
        .where('createdAt', '>=', thirtyDaysAgo)
        .get(),
      db.collection('wallets').doc(uid).collection('savings').get(),
    ]);

    const wallet   = walletSnap.exists    ? walletSnap.data()    : {};
    const identity = identitySnap.exists  ? identitySnap.data()  : {};

    const balance       = wallet.balance || 0;
    const savingsCount  = savingsSnap.size;
    let   savingsTotal  = 0;
    savingsSnap.docs.forEach(d => { savingsTotal += d.data().balance || 0; });

    const totalIn  = txInSnap.docs.reduce((s, d)  => s + (d.data().amount || 0), 0);
    const totalOut = txOutSnap.docs.reduce((s, d)  => s + (d.data().amount || 0), 0);
    const txCount  = txOutSnap.size + txInSnap.size;

    const breakdown = {
      hasPositiveBalance:    balance > 0,
      hasSavingsVault:       savingsCount > 0,
      savingsProgress:       savingsTotal > 0 && identity.dailyLimit
        ? Math.min(100, Math.round((savingsTotal / (identity.monthlyLimit || DEFAULT_MONTHLY_LIMIT)) * 100 / 0.25))
        : 0,
      noFailedTransactions:  failedSnap.empty,
      engagedUser:           txCount > 5,
      positiveCashflow:      totalIn > totalOut,
      kycVerified:           ['verified', 'enhanced'].includes(identity.kycStatus),
      noFraudFlags:          !identity.fraudFlag,
    };

    let score = 0;
    const recommendations = [];

    if (breakdown.hasPositiveBalance)   { score += 10; }
    else                                { recommendations.push('Deposit funds into your wallet to maintain a positive balance'); }

    if (breakdown.hasSavingsVault)      { score += 15; }
    else                                { recommendations.push('Open a savings vault to build financial resilience'); }

    if (breakdown.savingsProgress >= 25) { score += 10; }
    else                                { recommendations.push('Try to save at least 25% of your monthly spending limit'); }

    if (breakdown.noFailedTransactions) { score += 15; }
    else                                { recommendations.push('Review and resolve failed transactions to improve your score'); }

    if (breakdown.engagedUser)          { score += 10; }
    else                                { recommendations.push('Increase your transaction activity to boost your financial profile'); }

    if (breakdown.positiveCashflow)     { score += 15; }
    else                                { recommendations.push('Your spending exceeds income this month — review your expenditure'); }

    if (breakdown.kycVerified)          { score += 10; }
    else                                { recommendations.push('Complete KYC verification to unlock higher limits and a better score'); }

    if (breakdown.noFraudFlags)         { score += 15; }
    else                                { recommendations.push('Contact support to resolve flagged activity on your account'); }

    const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';

    // Persist score
    await db.collection('sfosIdentity').doc(uid).set({
      financialScore: score,
      updatedAt:      Timestamp.now(),
    }, { merge: true });

    return { score, breakdown, grade, recommendations, totalIn, totalOut, netFlow: totalIn - totalOut };
  } catch (e) {
    _log('error', 'sfosFinancialHealth', { uid, err: e.message });
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'Failed to compute financial health');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 19. sfosNetWorth
// ══════════════════════════════════════════════════════════════════════════════

exports.sfosNetWorth = onCall(BASE_OPTS, async (request) => {
  const uid = _requireAuth(request);
  const db  = _db();

  try {
    const [walletSnap, rewardsSnap, savingsSnap, escrowSnap] = await Promise.all([
      db.collection('wallets').doc(uid).get(),
      db.collection('sfosRewards').doc(uid).get(),
      db.collection('wallets').doc(uid).collection('savings').get(),
      db.collection('sfosEscrow')
        .where('buyerUid', '==', uid)
        .where('status',   'in', ['FUNDED', 'PARTIAL'])
        .get(),
    ]);

    const wallet  = walletSnap.exists   ? walletSnap.data()   : {};
    const rewards = rewardsSnap.exists  ? rewardsSnap.data()  : {};

    let savingsTotal = 0;
    savingsSnap.docs.forEach(d => { savingsTotal += d.data().balance || 0; });

    let escrowTotal = 0;
    escrowSnap.docs.forEach(d => {
      const e = d.data();
      escrowTotal += (e.totalAmount || 0) - (e.releasedAmount || 0);
    });

    const breakdown = {
      available: wallet.balance         || 0,
      savings:   savingsTotal,
      cashback:  wallet.cashbackBalance || 0,
      rewards:   (rewards.points || 0)  * POINTS_TO_KES,
      escrow:    escrowTotal,
    };

    const netWorth = Object.values(breakdown).reduce((s, v) => s + v, 0);
    return { netWorth, breakdown, currency: 'KES' };
  } catch (e) {
    _log('error', 'sfosNetWorth', { uid, err: e.message });
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'Failed to compute net worth');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 20. sfosAnalyticsDetailed
// ══════════════════════════════════════════════════════════════════════════════

exports.sfosAnalyticsDetailed = onCall(BASE_OPTS, async (request) => {
  const uid  = _requireAuth(request);
  const db   = _db();
  const data = request.data || {};

  const period = _san(data.period || 'month', 10);
  const now    = new Date();
  let startMs, endMs;

  switch (period) {
    case 'week':  startMs = now.getTime() - 7   * 86_400_000; endMs = now.getTime(); break;
    case 'month': startMs = now.getTime() - 30  * 86_400_000; endMs = now.getTime(); break;
    case 'year':  startMs = now.getTime() - 365 * 86_400_000; endMs = now.getTime(); break;
    case 'custom':
      startMs = data.startDate ? new Date(data.startDate).getTime() : now.getTime() - 30 * 86_400_000;
      endMs   = data.endDate   ? new Date(data.endDate).getTime()   : now.getTime();
      break;
    default:      startMs = now.getTime() - 30  * 86_400_000; endMs = now.getTime();
  }

  const startTs = Timestamp.fromMillis(startMs);
  const endTs   = Timestamp.fromMillis(endMs);

  try {
    const [outSnap, inSnap] = await Promise.all([
      db.collection('sfosTransactions')
        .where('fromId',    '==', uid)
        .where('createdAt', '>=', startTs)
        .where('createdAt', '<=', endTs)
        .orderBy('createdAt', 'desc')
        .limit(500)
        .get(),
      db.collection('sfosTransactions')
        .where('toId',      '==', uid)
        .where('createdAt', '>=', startTs)
        .where('createdAt', '<=', endTs)
        .orderBy('createdAt', 'desc')
        .limit(500)
        .get(),
    ]);

    const TX_CATEGORY = {
      MARKETPLACE_PURCHASE: 'Shopping',
      WALLET_TRANSFER:      'Transfers',
      DELIVERY_PAYMENT:     'Delivery',
      SUBSCRIPTION:         'Subscriptions',
      COMMISSION:           'Fees',
      CASHBACK:             'Income',
      SALARY:               'Income',
      GIFT:                 'Transfers',
      DONATION:             'Giving',
      SAVINGS_DEPOSIT:      'Savings',
      SAVINGS_WITHDRAWAL:   'Savings',
      DEPOSIT:              'Income',
      WITHDRAWAL:           'Transfers',
      REFUND:               'Income',
      INVOICE:              'Business',
    };

    let totalOut = 0, totalIn = 0;
    const byDay        = {};
    const byCategory   = {};
    const topMerchants = {};
    let   largest      = 0;
    let   txCount      = 0;
    const allAmounts   = [];

    const process = (tx, direction) => {
      if (tx.status === 'REVERSED' || tx.status === 'FAILED') return;
      const dateStr = tx.createdAt ? new Date(tx.createdAt.toMillis()).toISOString().slice(0, 10) : 'unknown';
      if (!byDay[dateStr]) byDay[dateStr] = { in: 0, out: 0 };

      const cat = TX_CATEGORY[tx.type] || 'Other';
      if (!byCategory[cat]) byCategory[cat] = { total: 0, count: 0 };

      if (direction === 'out') {
        totalOut += tx.amount;
        byDay[dateStr].out    += tx.amount;
        byCategory[cat].total += tx.amount;
        byCategory[cat].count++;
        if (tx.type === 'MARKETPLACE_PURCHASE' && tx.toId) {
          if (!topMerchants[tx.toId]) topMerchants[tx.toId] = { name: tx.toId, total: 0, count: 0 };
          topMerchants[tx.toId].total += tx.amount;
          topMerchants[tx.toId].count++;
        }
      } else {
        totalIn             += tx.amount;
        byDay[dateStr].in   += tx.amount;
      }

      if (tx.amount > largest) largest = tx.amount;
      allAmounts.push(tx.amount);
      txCount++;
    };

    outSnap.docs.forEach(d => process(d.data(), 'out'));
    inSnap.docs.forEach(d  => process(d.data(), 'in'));

    const avgSize      = txCount > 0 ? Math.round((totalIn + totalOut) / txCount * 100) / 100 : 0;
    const topMerchList = Object.values(topMerchants)
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);

    return {
      period,
      startDate:            new Date(startMs).toISOString(),
      endDate:              new Date(endMs).toISOString(),
      totalIn,
      totalOut,
      netFlow:              totalIn - totalOut,
      byCategory,
      byDay,
      topMerchants:         topMerchList,
      averageTransactionSize: avgSize,
      largestTransaction:   largest,
      transactionCount:     txCount,
    };
  } catch (e) {
    _log('error', 'sfosAnalyticsDetailed', { uid, err: e.message });
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'Failed to load analytics');
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 21. sfosAiForecast
// ══════════════════════════════════════════════════════════════════════════════

exports.sfosAiForecast = onCall(_optsWithSecrets(ANTHROPIC_API_KEY), async (request) => {
  const uid = _requireAuth(request);
  const db  = _db();

  const STATIC_FALLBACK = {
    forecast:     { next30Days: { predicted_in: null, predicted_out: null, predicted_net: null } },
    opportunities: [
      'Track your daily spend categories to identify unnecessary subscriptions',
      'Set a monthly savings goal using the SFOS savings vault',
      'Enable cashback rewards on every marketplace purchase',
    ],
    savingsGoal:  { amount: 5000, timeline: '3 months', reason: 'Build a 3-month emergency fund of at least KSh 5,000' },
    healthGrade:  'C',
    insights:     ['Complete your KYC to unlock higher limits', 'Regular small savings beats sporadic large deposits'],
  };

  try {
    const ninetyDaysAgo = Timestamp.fromMillis(Date.now() - 90 * 86_400_000);

    const [outSnap, inSnap] = await Promise.all([
      db.collection('sfosTransactions')
        .where('fromId',    '==', uid)
        .where('createdAt', '>=', ninetyDaysAgo)
        .orderBy('createdAt', 'desc')
        .limit(200)
        .get(),
      db.collection('sfosTransactions')
        .where('toId',      '==', uid)
        .where('createdAt', '>=', ninetyDaysAgo)
        .orderBy('createdAt', 'desc')
        .limit(200)
        .get(),
    ]);

    const txHistory = [
      ...outSnap.docs.map(d => ({ direction: 'out', ...d.data() })),
      ...inSnap.docs.map(d  => ({ direction: 'in',  ...d.data() })),
    ]
    .sort((a, b) => (b.createdAt?.toMillis() || 0) - (a.createdAt?.toMillis() || 0))
    .slice(0, 100)
    .map(tx => ({
      date:      tx.createdAt ? new Date(tx.createdAt.toMillis()).toISOString().slice(0, 10) : 'unknown',
      type:      tx.type,
      direction: tx.direction,
      amount:    tx.amount,
      currency:  tx.currency || 'KES',
    }));

    if (txHistory.length < 3) return STATIC_FALLBACK;

    const prompt = `Based on this Kenyan user's 90-day transaction history (JSON), provide: 1) A 30-day cashflow forecast in KSh, 2) Top 3 cost-reduction opportunities, 3) A savings goal recommendation with specific target amount, 4) Financial health grade A-F with one sentence explanation. Be specific, practical, and brief. Use casual but professional Kenyan English.

Transaction history:
${JSON.stringify(txHistory, null, 2)}

Respond ONLY with valid JSON in this exact structure:
{
  "forecast": { "next30Days": { "predicted_in": number, "predicted_out": number, "predicted_net": number } },
  "opportunities": ["string", "string", "string"],
  "savingsGoal": { "amount": number, "timeline": "string", "reason": "string" },
  "healthGrade": "A|B|C|D|F",
  "insights": ["string", "string"]
}`;

    const apiKey = ANTHROPIC_API_KEY.value();
    if (!apiKey) return STATIC_FALLBACK;

    const responseText = await new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model:      'claude-haiku-4-5',
        max_tokens: 600,
        messages:   [{ role: 'user', content: prompt }],
      });

      const options = {
        hostname: 'api.anthropic.com',
        path:     '/v1/messages',
        method:   'POST',
        headers:  {
          'Content-Type':      'application/json',
          'x-api-key':         apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length':    Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end',  ()    => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(15_000, () => { req.destroy(); reject(new Error('Anthropic timeout')); });
      req.write(body);
      req.end();
    });

    const parsed = JSON.parse(responseText);
    const content = parsed.content?.[0]?.text || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return STATIC_FALLBACK;

    const result = JSON.parse(jsonMatch[0]);
    return result;
  } catch (e) {
    _log('warn', 'sfosAiForecast fell back to static tips', { uid, err: e.message });
    return STATIC_FALLBACK;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 22. sfosRiskCheck
// ══════════════════════════════════════════════════════════════════════════════

exports.sfosRiskCheck = onCall(BASE_OPTS, async (request) => {
  const uid  = _requireAuth(request);
  const db   = _db();
  const data = request.data || {};

  const amount  = data.amount  ? _assertPositiveAmount(data.amount) : 0;
  const toId    = _san(data.toId   || '', 128) || null;
  const txType  = _san(data.txType || '', 50)  || null;

  try {
    const now     = new Date();
    const eatHour = (((now.getUTCHours() + 3) % 24) + 24) % 24;

    let score = 0;
    const flags = [];

    const identity = (await db.collection('sfosIdentity').doc(uid).get()).data() || {};
    const tier     = identity.tier || 'bronze';
    const monthlyLimit = identity.monthlyLimit || DEFAULT_MONTHLY_LIMIT;

    // Unusual hour
    if (eatHour >= 23 || eatHour < 5) {
      score += 10;
      flags.push('UNUSUAL_HOUR');
    }

    // Amount > 3x daily average
    const avgDaily = (identity.monthlySpent || 0) / 30;
    if (avgDaily > 0 && amount > avgDaily * 3) {
      score += 20;
      flags.push('LARGE_AMOUNT_VS_AVERAGE');
    }

    // Amount > 50% monthly limit
    if (amount > monthlyLimit * 0.5) {
      score += 15;
      flags.push('HIGH_MONTHLY_PERCENTAGE');
    }

    // High amount for bronze tier
    if (tier === 'bronze' && amount > 10_000) {
      score += 20;
      flags.push('HIGH_AMOUNT_FOR_TIER');
    }

    if (toId && toId !== 'PLATFORM') {
      const sentBefore = await db.collection('sfosTransactions')
        .where('fromId', '==', uid)
        .where('toId',   '==', toId)
        .limit(6)
        .get();

      if (sentBefore.empty) {
        score += 10;
        flags.push('NEW_RECIPIENT');
      } else if (sentBefore.size >= 5) {
        score = Math.max(0, score - 20); // known safe recipient
      }
    }

    // Rapid succession in last 10 min
    const tenMinAgo = Timestamp.fromMillis(Date.now() - 10 * 60 * 1000);
    const recentQ   = await db.collection('sfosTransactions')
      .where('initiatorUid', '==', uid)
      .where('createdAt',    '>=', tenMinAgo)
      .limit(4)
      .get();

    if (recentQ.size > 3) {
      score += 25;
      flags.push('RAPID_SUCCESSION');
    }

    score = Math.min(100, Math.max(0, score));

    const flagged      = score >= 50;
    const requiresPin  = score >= 70;

    return { riskScore: score, flagged, flags, requiresPin };
  } catch (e) {
    _log('error', 'sfosRiskCheck', { uid, err: e.message });
    if (e instanceof HttpsError) throw e;
    throw new HttpsError('internal', 'Risk check failed');
  }
});
