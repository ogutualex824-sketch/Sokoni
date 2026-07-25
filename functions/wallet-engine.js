'use strict';

/**
 * SOKONI Wallet Engine 2.0 — Cloud Functions
 * Firebase Gen2 / Node.js 22
 *
 * This file owns these collections:
 *   wallets/{uid}                   — extends existing wallet (adds V2 fields)
 *   wallets/{uid}/savings/{vaultId} — savings vaults
 *   moneyRequests/{reqId}           — P2P money requests
 *   walletAuditLog/{logId}          — immutable security audit trail
 *   walletPinAttempts/{uid}         — PIN rate-limit tracking
 *   escrowV2/{escrowId}             — escrow holds (separate from legacy escrow)
 *
 * DO NOT touch:
 *   functions/wallet.js             — legacy CFs remain canonical for their endpoints
 *
 * Secrets required:
 *   ANTHROPIC_API_KEY   — Claude Haiku for AI insights
 *   WALLET_QR_SECRET    — HMAC signing key for QR payloads (falls back to uid)
 *
 * @module wallet-engine
 * @version 2.0.0
 * @since 2026-07-14
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { defineSecret } = require('firebase-functions/params');
const crypto = require('crypto');

// ─── Secrets ──────────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const WALLET_QR_SECRET  = defineSecret('WALLET_QR_SECRET');

// ─── Constants ────────────────────────────────────────────────────────────────

const TAG              = '[WALLET-ENGINE]';
const BASE_URL         = 'https://mysokoni.co.ke';
const MIN_SEND         = 10;       // KES — minimum P2P send
const MIN_DEPOSIT      = 1;        // KES — minimum savings deposit
const PIN_MAX_ATTEMPTS = 5;        // attempts before freeze
const PIN_WINDOW_MS    = 3_600_000; // 1 hour
const IDEMPOTENCY_WINDOW_MS = 5_000; // 5 seconds

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Assert request is authenticated. Throws unauthenticated HttpsError otherwise.
 * @param {object} request — Firebase onCall request object
 * @returns {string} caller UID
 */
function _requireAuth(request) {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Sign in required');
  }
  return request.auth.uid;
}

/**
 * Assert caller has admin custom claim.
 */
function _requireAdmin(request) {
  if (!request.auth?.token?.admin && !request.auth?.token?.superAdmin) {
    throw new HttpsError('permission-denied', 'Admin access required');
  }
}

/**
 * Strip HTML tags, trim, and truncate a string.
 * @param {*} s — raw value
 * @param {number} max — max characters
 */
function _san(s, max = 300) {
  if (s == null) return '';
  return String(s).replace(/<[^>]*>/g, '').trim().slice(0, max);
}

/**
 * Normalize a Kenyan phone number to 254XXXXXXXXX format.
 * Accepts: 07XXXXXXXX, 01XXXXXXXX, +254XXXXXXXXX, 254XXXXXXXXX
 * @param {string} raw
 * @returns {string|null}
 */
function _normalizePhone(raw) {
  const cleaned = String(raw || '').replace(/[\s\-().+]/g, '');
  const match = cleaned.match(/^(?:254|0)([17]\d{8})$/);
  return match ? `254${match[1]}` : null;
}

/**
 * Find a SOKONI user by phone, tolerant of how phones are actually stored.
 * Firebase-Auth users carry `phoneNumber` in "+254…" form; some legacy docs use
 * `phone` in "254…" form. _normalizePhone yields "254…", so the old
 * where('phone','==','254…') query matched NEITHER — every recipient lookup
 * returned USER_NOT_FOUND. This checks both fields in both formats (first hit
 * wins → one read for a valid recipient). Returns the doc snapshot or null.
 */
async function _findUserByPhone(db, normalizedPhone) {
  if (!normalizedPhone) return null;
  const plus = `+${normalizedPhone}`;
  const attempts = [
    ['phoneNumber', plus],            // Firebase Auth default: "+254…"
    ['phone',       normalizedPhone], // legacy: "254…"
    ['phoneNumber', normalizedPhone], // "254…" stored in phoneNumber
    ['phone',       plus],            // "+254…" stored in phone
  ];
  for (const [field, val] of attempts) {
    const snap = await db.collection('users').where(field, '==', val).limit(1).get();
    if (!snap.empty) return snap.docs[0];
  }
  return null;
}

/**
 * Generate a prefixed random ID suitable for Firestore doc IDs.
 * Format: {prefix}_{base36-timestamp}_{6-char-random}
 */
function _genId(prefix = 'wv2') {
  const ts   = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${ts}_${rand}`;
}

/**
 * Compute SHA-256 hex digest of a string.
 */
function _sha256(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Return a Firestore db instance. Centralised so we only call getFirestore() once per CF.
 */
function _db() {
  return getFirestore();
}

/**
 * Ensure a wallet document exists for `uid`. Merges V2 defaults without
 * clobbering existing balance or other V1 fields. Returns the doc reference.
 */
async function _ensureWallet(db, uid) {
  const ref  = db.collection('wallets').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      uid,
      balance:         0,
      pendingBalance:  0,
      savingsBalance:  0,
      cashbackBalance: 0,
      rewardPoints:    0,
      tier:            'bronze',
      frozen:          false,
      currency:        'KES',
      dailyLimit:      50_000,
      monthlyLimit:    500_000,
      dailySpent:      0,
      monthlySpent:    0,
      pinHash:         null,
      pinLocked:       false,
      lastTopUp:       null,
      pendingTopUp:    null,
      pendingPayout:   null,
      createdAt:       Timestamp.now(),
      v2:              true,
    });
  } else {
    // Migrate: add missing V2 fields without touching existing balance
    const data    = snap.data();
    const missing = {};
    const defaults = {
      pendingBalance:  0,
      savingsBalance:  0,
      cashbackBalance: 0,
      rewardPoints:    0,
      tier:            'bronze',
      frozen:          false,
      dailyLimit:      50_000,
      monthlyLimit:    500_000,
      dailySpent:      0,
      monthlySpent:    0,
      pinHash:         null,
      pinLocked:       false,
      v2:              true,
    };
    for (const [k, v] of Object.entries(defaults)) {
      if (data[k] === undefined) missing[k] = v;
    }
    if (Object.keys(missing).length > 0) {
      await ref.update(missing);
    }
  }
  return ref;
}

/**
 * Assert the wallet is not frozen. Reads the wallet doc and throws if frozen.
 */
async function _assertNotFrozen(db, uid) {
  const snap = await db.collection('wallets').doc(uid).get();
  if (snap.exists && snap.data().frozen === true) {
    throw new HttpsError('failed-precondition', 'Wallet is frozen');
  }
}

/**
 * Write a row to walletAuditLog.
 */
async function _audit(db, uid, action, details = {}) {
  const logId = _genId('wal');
  await db.collection('walletAuditLog').doc(logId).set({
    logId,
    uid,
    action,
    details,
    createdAt: Timestamp.now(),
  });
}

// ─── CF options factory ───────────────────────────────────────────────────────

/**
 * Standard CF options: App Check enforced, CORS open (caller SDK handles origin).
 * Inject secrets only for the CFs that need them.
 */
const BASE_OPTS = { cors: true, enforceAppCheck: true };

function _optsWithSecrets(...secrets) {
  return { ...BASE_OPTS, secrets };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. walletV2Dashboard
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch the full wallet state for the current user in a single call.
 * Creates the wallet document if it does not yet exist (backward compatibility).
 *
 * @returns {{
 *   balance, pendingBalance, savingsBalance, cashbackBalance, rewardPoints,
 *   tier, frozen, pinLocked, dailyLimit, monthlyLimit, dailySpent, monthlySpent,
 *   currency, last5Transactions, vaultCount, totalSaved
 * }}
 */
exports.walletV2Dashboard = onCall(BASE_OPTS, async (request) => {
  const uid = _requireAuth(request);
  const db  = _db();

  try {
    const walletRef = await _ensureWallet(db, uid);

    // Fan-out: wallet doc, savings subcollection, last 5 transactions in parallel
    const [walletSnap, savingsSnap, txSnap] = await Promise.all([
      walletRef.get(),
      db.collection('wallets').doc(uid).collection('savings').get(),
      db.collection('walletTransactions')
        .where('uid', '==', uid)
        .orderBy('createdAt', 'desc')
        .limit(5)
        .get(),
    ]);

    const w = walletSnap.data();

    // Compute savings totals
    let totalSaved = 0;
    for (const vDoc of savingsSnap.docs) {
      totalSaved += vDoc.data().currentAmount || 0;
    }

    const last5Transactions = txSnap.docs.map((d) => {
      const t = d.data();
      return {
        txId:      d.id,
        type:      t.type,
        direction: t.direction,
        amount:    t.amount,
        note:      t.note,
        category:  t.category,
        createdAt: t.createdAt,
      };
    });

    return {
      balance:         w.balance         ?? 0,
      pendingBalance:  w.pendingBalance   ?? 0,
      savingsBalance:  w.savingsBalance   ?? 0,
      cashbackBalance: w.cashbackBalance  ?? 0,
      rewardPoints:    w.rewardPoints     ?? 0,
      tier:            w.tier             ?? 'bronze',
      frozen:          w.frozen           ?? false,
      pinLocked:       w.pinLocked        ?? false,
      dailyLimit:      w.dailyLimit       ?? 50_000,
      monthlyLimit:    w.monthlyLimit     ?? 500_000,
      dailySpent:      w.dailySpent       ?? 0,
      monthlySpent:    w.monthlySpent     ?? 0,
      currency:        w.currency         ?? 'KES',
      last5Transactions,
      vaultCount:      savingsSnap.size,
      totalSaved,
    };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error(TAG, 'walletV2Dashboard error:', err);
    throw new HttpsError('internal', 'Could not load wallet dashboard');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. walletV2Send  — P2P internal transfer
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Transfer funds from caller to another SOKONI user identified by phone number.
 *
 * @param {{ phone: string, amount: number, note?: string }} data
 * @returns {{ success: boolean, recipientName?: string, newBalance?: number, txId?: string, error?: string }}
 */
exports.walletV2Send = onCall(BASE_OPTS, async (request) => {
  const senderUid = _requireAuth(request);
  const db        = _db();

  const { phone, amount, note } = request.data || {};

  // ── Validation ──────────────────────────────────────────────────────────────
  const normalizedPhone = _normalizePhone(phone);
  if (!normalizedPhone) {
    throw new HttpsError('invalid-argument', 'Invalid Kenyan phone number');
  }
  const safeAmount = Number(amount);
  if (!Number.isFinite(safeAmount) || safeAmount < MIN_SEND) {
    throw new HttpsError('invalid-argument', `Minimum send amount is KES ${MIN_SEND}`);
  }
  const safeNote = _san(note, 200);

  try {
    await _assertNotFrozen(db, senderUid);

    // ── Recipient lookup (tolerant of phone/phoneNumber + "+254…"/"254…") ──────
    const recipientDoc = await _findUserByPhone(db, normalizedPhone);
    if (!recipientDoc) {
      return { success: false, error: 'USER_NOT_FOUND' };
    }

    const recipientUid  = recipientDoc.id;
    const recipientData = recipientDoc.data();

    if (recipientUid === senderUid) {
      throw new HttpsError('invalid-argument', 'Cannot send money to yourself');
    }

    const recipientName = _san(
      recipientData.displayName || recipientData.name || 'SOKONI User', 60
    );

    // ── Idempotency check — dedupe within 5-second window ───────────────────
    const windowStart  = Timestamp.fromMillis(Date.now() - IDEMPOTENCY_WINDOW_MS);
    const dupeKey      = _sha256(`${senderUid}_${recipientUid}_${safeAmount}`);
    const dupeSnap     = await db.collection('walletTransactions')
      .where('idempotencyKey', '==', dupeKey)
      .where('createdAt', '>=', windowStart)
      .limit(1)
      .get();

    if (!dupeSnap.empty) {
      const existing = dupeSnap.docs[0].data();
      return {
        success:       true,
        recipientName,
        newBalance:    existing.balanceAfter ?? 0,
        txId:          dupeSnap.docs[0].id,
        deduplicated:  true,
      };
    }

    // ── Ensure both wallets exist ─────────────────────────────────────────────
    await Promise.all([
      _ensureWallet(db, senderUid),
      _ensureWallet(db, recipientUid),
    ]);

    // ── Firestore transaction ─────────────────────────────────────────────────
    const senderWalletRef    = db.collection('wallets').doc(senderUid);
    const recipientWalletRef = db.collection('wallets').doc(recipientUid);

    const txOutId = _genId('snd');
    const txInId  = _genId('rcv');

    let newSenderBalance;

    await db.runTransaction(async (t) => {
      const senderSnap    = await t.get(senderWalletRef);
      const recipientSnap = await t.get(recipientWalletRef);

      const senderBalance    = senderSnap.data().balance ?? 0;
      const recipientBalance = recipientSnap.data().balance ?? 0;

      if (senderBalance < safeAmount) {
        throw new HttpsError('failed-precondition', 'Insufficient balance');
      }

      newSenderBalance = senderBalance - safeAmount;
      const newRecipientBalance = recipientBalance + safeAmount;
      const now = Timestamp.now();

      // Debit sender
      t.update(senderWalletRef, {
        balance:      newSenderBalance,
        dailySpent:   FieldValue.increment(safeAmount),
        monthlySpent: FieldValue.increment(safeAmount),
        updatedAt:    now,
      });

      // Credit recipient
      t.update(recipientWalletRef, {
        balance:   newRecipientBalance,
        updatedAt: now,
      });

      // Sender transaction record
      t.set(db.collection('walletTransactions').doc(txOutId), {
        txId:           txOutId,
        uid:            senderUid,
        counterpartyUid: recipientUid,
        type:           'send',
        direction:      'out',
        amount:         safeAmount,
        balanceAfter:   newSenderBalance,
        note:           safeNote,
        category:       'transfer',
        status:         'completed',
        idempotencyKey: dupeKey,
        createdAt:      now,
      });

      // Recipient transaction record
      t.set(db.collection('walletTransactions').doc(txInId), {
        txId:            txInId,
        uid:             recipientUid,
        counterpartyUid: senderUid,
        type:            'receive',
        direction:       'in',
        amount:          safeAmount,
        balanceAfter:    newRecipientBalance,
        note:            safeNote,
        category:        'transfer',
        status:          'completed',
        idempotencyKey:  dupeKey,
        createdAt:       now,
      });
    });

    return {
      success:       true,
      recipientName,
      newBalance:    newSenderBalance,
      txId:          txOutId,
    };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error(TAG, 'walletV2Send error:', err);
    throw new HttpsError('internal', 'Transfer failed. Please try again.');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. walletV2Request  — create a money request
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a money request that can be shared via link.
 *
 * @param {{ phone?: string, amount?: number, note?: string }} data
 * @returns {{ reqId, shareLink, amount, note, fromUid }}
 */
exports.walletV2Request = onCall(BASE_OPTS, async (request) => {
  const uid = _requireAuth(request);
  const db  = _db();

  const { phone, amount, note } = request.data || {};

  const safeAmount = amount != null ? Number(amount) : null;
  if (safeAmount !== null && (!Number.isFinite(safeAmount) || safeAmount < 1)) {
    throw new HttpsError('invalid-argument', 'Amount must be at least KES 1');
  }

  const normalizedPhone = phone ? _normalizePhone(phone) : null;
  const safeNote        = _san(note, 300);

  try {
    const reqId = crypto.randomUUID();
    const now   = Timestamp.now();

    // Look up toUid if phone provided
    let toUid   = null;
    let toPhone = normalizedPhone;

    if (normalizedPhone) {
      const recipientDoc = await _findUserByPhone(db, normalizedPhone);
      if (recipientDoc) {
        toUid = recipientDoc.id;
      }
    }

    await db.collection('moneyRequests').doc(reqId).set({
      reqId,
      fromUid:   uid,
      toUid,
      toPhone,
      amount:    safeAmount,
      note:      safeNote,
      status:    'pending',
      createdAt: now,
      expiresAt: Timestamp.fromMillis(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    });

    return {
      reqId,
      shareLink: `${BASE_URL}/pay?req=${reqId}`,
      amount:    safeAmount,
      note:      safeNote,
      fromUid:   uid,
    };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error(TAG, 'walletV2Request error:', err);
    throw new HttpsError('internal', 'Could not create money request');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. walletV2GetRequests  — list incoming and outgoing money requests
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Retrieve all pending money requests for the current user.
 *
 * @returns {{ incoming: MoneyRequest[], outgoing: MoneyRequest[] }}
 */
exports.walletV2GetRequests = onCall(BASE_OPTS, async (request) => {
  const uid = _requireAuth(request);
  const db  = _db();

  try {
    // Get caller's phone for matching toPhone requests
    const userSnap  = await db.collection('users').doc(uid).get();
    const userPhone = userSnap.exists ? (userSnap.data().phone || null) : null;

    // Queries: incoming (toUid), outgoing (fromUid)
    const [toUidSnap, outSnap, toPhoneSnap] = await Promise.all([
      db.collection('moneyRequests').where('toUid', '==', uid).where('status', '==', 'pending').orderBy('createdAt', 'desc').limit(50).get(),
      db.collection('moneyRequests').where('fromUid', '==', uid).where('status', '==', 'pending').orderBy('createdAt', 'desc').limit(50).get(),
      userPhone
        ? db.collection('moneyRequests').where('toPhone', '==', userPhone).where('status', '==', 'pending').orderBy('createdAt', 'desc').limit(50).get()
        : Promise.resolve({ docs: [] }),
    ]);

    const _fmt = (d) => ({ reqId: d.id, ...d.data() });

    // Merge incoming (toUid + toPhone), deduplicate by reqId
    const incomingMap = new Map();
    for (const d of [...toUidSnap.docs, ...toPhoneSnap.docs]) {
      incomingMap.set(d.id, _fmt(d));
    }

    return {
      incoming: [...incomingMap.values()],
      outgoing: outSnap.docs.map(_fmt),
    };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error(TAG, 'walletV2GetRequests error:', err);
    throw new HttpsError('internal', 'Could not fetch money requests');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. walletV2SavingsList  — list savings vaults
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * List all savings vaults for the current user.
 *
 * @returns {{ vaults: SavingsVault[], totalSaved: number }}
 */
exports.walletV2SavingsList = onCall(BASE_OPTS, async (request) => {
  const uid = _requireAuth(request);
  const db  = _db();

  try {
    const snap = await db.collection('wallets').doc(uid).collection('savings')
      .orderBy('createdAt', 'desc')
      .get();

    let totalSaved = 0;
    const vaults   = snap.docs.map((d) => {
      const v = d.data();
      totalSaved += v.currentAmount || 0;
      return { vaultId: d.id, ...v };
    });

    return { vaults, totalSaved };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error(TAG, 'walletV2SavingsList error:', err);
    throw new HttpsError('internal', 'Could not list savings vaults');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. walletV2SavingsCreate  — create a new savings vault
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a new savings vault under wallets/{uid}/savings.
 *
 * @param {{
 *   name: string, emoji: string,
 *   targetAmount?: number, deadline?: string,
 *   locked?: boolean, autoSave?: boolean, autoSaveAmount?: number
 * }} data
 * @returns {{ vaultId: string, vault: object }}
 */
exports.walletV2SavingsCreate = onCall(BASE_OPTS, async (request) => {
  const uid = _requireAuth(request);
  const db  = _db();

  const {
    name, emoji,
    targetAmount, deadline,
    locked      = false,
    autoSave    = false,
    autoSaveAmount,
  } = request.data || {};

  // Validation
  const safeName = _san(name, 50);
  if (!safeName) throw new HttpsError('invalid-argument', 'Vault name is required');
  if (safeName.length > 50) throw new HttpsError('invalid-argument', 'Name must be 50 characters or less');

  const safeEmoji = _san(emoji, 8) || '💰';

  let safeTarget = null;
  if (targetAmount != null) {
    safeTarget = Number(targetAmount);
    if (!Number.isFinite(safeTarget) || safeTarget < 1) {
      throw new HttpsError('invalid-argument', 'Target amount must be at least KES 1');
    }
  }

  let safeDeadline = null;
  if (deadline) {
    const d = new Date(deadline);
    if (isNaN(d.getTime())) throw new HttpsError('invalid-argument', 'Invalid deadline date');
    if (d < new Date()) throw new HttpsError('invalid-argument', 'Deadline must be in the future');
    safeDeadline = Timestamp.fromDate(d);
  }

  let safeAutoSaveAmount = null;
  if (autoSave && autoSaveAmount != null) {
    safeAutoSaveAmount = Number(autoSaveAmount);
    if (!Number.isFinite(safeAutoSaveAmount) || safeAutoSaveAmount < 1) {
      throw new HttpsError('invalid-argument', 'Auto-save amount must be at least KES 1');
    }
  }

  try {
    const vaultId  = _genId('svlt');
    const now      = Timestamp.now();
    const vaultRef = db.collection('wallets').doc(uid).collection('savings').doc(vaultId);

    const vault = {
      vaultId,
      ownerUid:       uid,
      name:           safeName,
      emoji:          safeEmoji,
      targetAmount:   safeTarget,
      deadline:       safeDeadline,
      locked:         Boolean(locked),
      autoSave:       Boolean(autoSave),
      autoSaveAmount: safeAutoSaveAmount,
      currentAmount:  0,
      status:         'active',
      createdAt:      now,
      updatedAt:      now,
    };

    await vaultRef.set(vault);
    return { vaultId, vault };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error(TAG, 'walletV2SavingsCreate error:', err);
    throw new HttpsError('internal', 'Could not create savings vault');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. walletV2SavingsDeposit  — move funds from wallet into a vault
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Deposit from the main wallet balance into a savings vault.
 *
 * @param {{ vaultId: string, amount: number }} data
 * @returns {{ newBalance: number, newVaultAmount: number }}
 */
exports.walletV2SavingsDeposit = onCall(BASE_OPTS, async (request) => {
  const uid = _requireAuth(request);
  const db  = _db();

  const { vaultId, amount } = request.data || {};
  if (!vaultId) throw new HttpsError('invalid-argument', 'vaultId is required');

  const safeAmount = Number(amount);
  if (!Number.isFinite(safeAmount) || safeAmount < MIN_DEPOSIT) {
    throw new HttpsError('invalid-argument', `Minimum deposit is KES ${MIN_DEPOSIT}`);
  }

  try {
    await _assertNotFrozen(db, uid);

    const walletRef = db.collection('wallets').doc(uid);
    const vaultRef  = walletRef.collection('savings').doc(vaultId);

    let newBalance, newVaultAmount;

    await db.runTransaction(async (t) => {
      const [walletSnap, vaultSnap] = await Promise.all([t.get(walletRef), t.get(vaultRef)]);

      if (!vaultSnap.exists) throw new HttpsError('not-found', 'Savings vault not found');
      if (vaultSnap.data().ownerUid !== uid) throw new HttpsError('permission-denied', 'Access denied');

      const walletBalance = walletSnap.data().balance ?? 0;
      if (walletBalance < safeAmount) throw new HttpsError('failed-precondition', 'Insufficient balance');

      newBalance     = walletBalance - safeAmount;
      newVaultAmount = (vaultSnap.data().currentAmount ?? 0) + safeAmount;
      const now      = Timestamp.now();

      t.update(walletRef, { balance: newBalance, savingsBalance: FieldValue.increment(safeAmount), updatedAt: now });
      t.update(vaultRef,  { currentAmount: newVaultAmount, updatedAt: now });

      const txId = _genId('sdep');
      t.set(db.collection('walletTransactions').doc(txId), {
        txId,
        uid,
        vaultId,
        type:        'savings_deposit',
        direction:   'out',
        amount:      safeAmount,
        balanceAfter: newBalance,
        note:        `Savings deposit → vault ${vaultId}`,
        category:    'savings',
        status:      'completed',
        createdAt:   now,
      });
    });

    return { newBalance, newVaultAmount };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error(TAG, 'walletV2SavingsDeposit error:', err);
    throw new HttpsError('internal', 'Deposit failed. Please try again.');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. walletV2SavingsWithdraw  — move funds from a vault back to wallet
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Withdraw from a savings vault back into the main wallet balance.
 * Locked vaults can only be withdrawn from after their deadline.
 *
 * @param {{ vaultId: string, amount: number }} data
 * @returns {{ newBalance: number, newVaultAmount: number }}
 */
exports.walletV2SavingsWithdraw = onCall(BASE_OPTS, async (request) => {
  const uid = _requireAuth(request);
  const db  = _db();

  const { vaultId, amount } = request.data || {};
  if (!vaultId) throw new HttpsError('invalid-argument', 'vaultId is required');

  const safeAmount = Number(amount);
  if (!Number.isFinite(safeAmount) || safeAmount < 1) {
    throw new HttpsError('invalid-argument', 'Amount must be at least KES 1');
  }

  try {
    await _assertNotFrozen(db, uid);

    const walletRef = db.collection('wallets').doc(uid);
    const vaultRef  = walletRef.collection('savings').doc(vaultId);

    let newBalance, newVaultAmount;

    await db.runTransaction(async (t) => {
      const [walletSnap, vaultSnap] = await Promise.all([t.get(walletRef), t.get(vaultRef)]);

      if (!vaultSnap.exists) throw new HttpsError('not-found', 'Savings vault not found');

      const vault = vaultSnap.data();
      if (vault.ownerUid !== uid) throw new HttpsError('permission-denied', 'Access denied');

      // Locked vault: only allow withdrawal after deadline
      if (vault.locked && vault.deadline) {
        const deadlineMs = vault.deadline.toMillis ? vault.deadline.toMillis() : vault.deadline._seconds * 1000;
        if (Date.now() < deadlineMs) {
          throw new HttpsError(
            'failed-precondition',
            'This vault is locked until ' + new Date(deadlineMs).toLocaleDateString('en-KE')
          );
        }
      }

      const vaultBalance = vault.currentAmount ?? 0;
      if (vaultBalance < safeAmount) throw new HttpsError('failed-precondition', 'Insufficient vault balance');

      const walletBalance = walletSnap.data().balance ?? 0;
      newBalance          = walletBalance + safeAmount;
      newVaultAmount      = vaultBalance  - safeAmount;
      const now           = Timestamp.now();

      t.update(walletRef, { balance: newBalance, savingsBalance: FieldValue.increment(-safeAmount), updatedAt: now });
      t.update(vaultRef,  { currentAmount: newVaultAmount, updatedAt: now });

      const txId = _genId('swth');
      t.set(db.collection('walletTransactions').doc(txId), {
        txId,
        uid,
        vaultId,
        type:        'savings_withdrawal',
        direction:   'in',
        amount:      safeAmount,
        balanceAfter: newBalance,
        note:        `Savings withdrawal ← vault ${vaultId}`,
        category:    'savings',
        status:      'completed',
        createdAt:   now,
      });
    });

    return { newBalance, newVaultAmount };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error(TAG, 'walletV2SavingsWithdraw error:', err);
    throw new HttpsError('internal', 'Withdrawal failed. Please try again.');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. walletV2SetPin  — set (or reset) the 4-digit wallet PIN
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Hash and store a 4-digit wallet PIN for the current user.
 * Rate-limited to 5 calls per hour to prevent brute-force PIN cycling.
 *
 * @param {{ pin: string }} data
 * @returns {{ success: true }}
 */
exports.walletV2SetPin = onCall(BASE_OPTS, async (request) => {
  const uid = _requireAuth(request);
  const db  = _db();

  const { pin } = request.data || {};
  if (!pin || !/^\d{4}$/.test(String(pin))) {
    throw new HttpsError('invalid-argument', 'PIN must be exactly 4 digits');
  }

  // Rate limit: max 5 set-PIN calls per hour
  try {
    const rateRef  = db.collection('walletPinAttempts').doc(uid);
    const rateSnap = await rateRef.get();
    const now      = Date.now();

    if (rateSnap.exists) {
      const data     = rateSnap.data();
      const windowMs = data.windowStart?.toMillis ? data.windowStart.toMillis() : 0;
      const attempts = data.setAttempts ?? 0;

      if (now - windowMs < PIN_WINDOW_MS && attempts >= PIN_MAX_ATTEMPTS) {
        throw new HttpsError('resource-exhausted', 'Too many PIN set attempts. Try again in an hour.');
      }

      if (now - windowMs >= PIN_WINDOW_MS) {
        // Reset window
        await rateRef.set({ setAttempts: 1, windowStart: Timestamp.now() }, { merge: true });
      } else {
        await rateRef.update({ setAttempts: FieldValue.increment(1) });
      }
    } else {
      await rateRef.set({ setAttempts: 1, windowStart: Timestamp.now() });
    }

    // Hash: SHA-256(pin + uid) — uid acts as per-user salt
    const pinHash = _sha256(`${pin}${uid}`);

    await db.collection('wallets').doc(uid).update({
      pinHash,
      pinLocked:  false,
      updatedAt:  Timestamp.now(),
    });

    await _audit(db, uid, 'PIN_SET', { method: 'sha256' });

    return { success: true };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error(TAG, 'walletV2SetPin error:', err);
    throw new HttpsError('internal', 'Could not set PIN');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. walletV2VerifyPin  — verify wallet PIN, freeze on excess failures
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Verify the 4-digit wallet PIN. Freezes the wallet after 5 consecutive
 * failed attempts within the rate-limit window.
 *
 * @param {{ pin: string }} data
 * @returns {{ valid: boolean, attemptsRemaining?: number }}
 */
exports.walletV2VerifyPin = onCall(BASE_OPTS, async (request) => {
  const uid = _requireAuth(request);
  const db  = _db();

  const { pin } = request.data || {};
  if (!pin || !/^\d{4}$/.test(String(pin))) {
    throw new HttpsError('invalid-argument', 'PIN must be exactly 4 digits');
  }

  try {
    const [walletSnap, rateSnap] = await Promise.all([
      db.collection('wallets').doc(uid).get(),
      db.collection('walletPinAttempts').doc(uid).get(),
    ]);

    if (!walletSnap.exists) throw new HttpsError('not-found', 'Wallet not found');

    const wallet = walletSnap.data();
    if (wallet.pinLocked) throw new HttpsError('failed-precondition', 'Wallet is PIN-locked. Contact support.');
    if (!wallet.pinHash)  throw new HttpsError('failed-precondition', 'No PIN set. Please set a PIN first.');

    // Track failed attempts
    const now      = Date.now();
    let   attempts = 0;

    if (rateSnap.exists) {
      const rd       = rateSnap.data();
      const windowMs = rd.windowStart?.toMillis ? rd.windowStart.toMillis() : 0;
      attempts       = now - windowMs < PIN_WINDOW_MS ? (rd.verifyAttempts ?? 0) : 0;
    }

    const inputHash = _sha256(`${pin}${uid}`);
    const valid     = inputHash === wallet.pinHash;

    if (valid) {
      // Reset attempts on success
      await db.collection('walletPinAttempts').doc(uid).set(
        { verifyAttempts: 0, windowStart: Timestamp.now() },
        { merge: true }
      );
      return { valid: true };
    }

    // Wrong PIN — increment attempts
    const newAttempts       = attempts + 1;
    const attemptsRemaining = Math.max(0, PIN_MAX_ATTEMPTS - newAttempts);

    await db.collection('walletPinAttempts').doc(uid).set(
      { verifyAttempts: newAttempts, windowStart: Timestamp.now() },
      { merge: true }
    );

    if (newAttempts >= PIN_MAX_ATTEMPTS) {
      // Freeze wallet
      await db.collection('wallets').doc(uid).update({
        pinLocked: true,
        updatedAt: Timestamp.now(),
      });
      await _audit(db, uid, 'WALLET_PIN_LOCKED', { attempts: newAttempts });
      throw new HttpsError('failed-precondition', 'Too many wrong PINs. Wallet locked. Contact support.');
    }

    return { valid: false, attemptsRemaining };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error(TAG, 'walletV2VerifyPin error:', err);
    throw new HttpsError('internal', 'PIN verification failed');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. walletV2FreezeToggle  — freeze or unfreeze the wallet
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Freeze or unfreeze the current user's wallet. Always writes an audit log entry.
 *
 * @param {{ freeze: boolean }} data
 * @returns {{ frozen: boolean }}
 */
exports.walletV2FreezeToggle = onCall(BASE_OPTS, async (request) => {
  const uid = _requireAuth(request);
  const db  = _db();

  const { freeze } = request.data || {};
  if (typeof freeze !== 'boolean') {
    throw new HttpsError('invalid-argument', '`freeze` must be a boolean');
  }

  try {
    const walletRef = db.collection('wallets').doc(uid);
    await walletRef.update({ frozen: freeze, updatedAt: Timestamp.now() });
    await _audit(db, uid, freeze ? 'WALLET_FROZEN' : 'WALLET_UNFROZEN', { initiatedByUid: uid });

    return { frozen: freeze };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error(TAG, 'walletV2FreezeToggle error:', err);
    throw new HttpsError('internal', 'Could not update wallet freeze status');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. walletV2SetLimits  — configure daily / monthly spend limits
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Set daily and/or monthly spend limits for the wallet.
 *
 * @param {{ dailyLimit?: number, monthlyLimit?: number }} data
 * @returns {{ dailyLimit: number, monthlyLimit: number }}
 */
exports.walletV2SetLimits = onCall(BASE_OPTS, async (request) => {
  const uid = _requireAuth(request);
  const db  = _db();

  const { dailyLimit, monthlyLimit } = request.data || {};

  const update = {};

  if (dailyLimit !== undefined) {
    const d = Number(dailyLimit);
    if (!Number.isFinite(d) || d < 0 || d > 500_000) {
      throw new HttpsError('invalid-argument', 'dailyLimit must be between 0 and 500,000');
    }
    update.dailyLimit = d;
  }

  if (monthlyLimit !== undefined) {
    const m = Number(monthlyLimit);
    if (!Number.isFinite(m) || m < 0 || m > 5_000_000) {
      throw new HttpsError('invalid-argument', 'monthlyLimit must be between 0 and 5,000,000');
    }
    update.monthlyLimit = m;
  }

  if (Object.keys(update).length === 0) {
    throw new HttpsError('invalid-argument', 'Provide at least one of dailyLimit or monthlyLimit');
  }

  try {
    update.updatedAt = Timestamp.now();
    const walletRef  = db.collection('wallets').doc(uid);
    await walletRef.update(update);

    const snap = await walletRef.get();
    const w    = snap.data();

    return {
      dailyLimit:   w.dailyLimit   ?? 50_000,
      monthlyLimit: w.monthlyLimit ?? 500_000,
    };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error(TAG, 'walletV2SetLimits error:', err);
    throw new HttpsError('internal', 'Could not update wallet limits');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 13. walletV2Analytics  — spending analytics for a given period
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Aggregate wallet transactions for the specified period.
 *
 * @param {{ period: 'week'|'month'|'year', year?: number, month?: number }} data
 * @returns {{ period, totalIn, totalOut, netFlow, byCategory, byDay, topMerchants }}
 */
exports.walletV2Analytics = onCall(BASE_OPTS, async (request) => {
  const uid = _requireAuth(request);
  const db  = _db();

  const { period, year, month } = request.data || {};
  if (!['week', 'month', 'year'].includes(period)) {
    throw new HttpsError('invalid-argument', 'period must be week, month, or year');
  }

  // Compute period boundaries
  const now      = new Date();
  const y        = Number(year)  || now.getFullYear();
  const m        = Number(month) || (now.getMonth() + 1); // 1-indexed
  let   startMs, endMs;

  if (period === 'week') {
    const day  = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1); // Monday
    startMs    = new Date(now.getFullYear(), now.getMonth(), diff, 0, 0, 0, 0).getTime();
    endMs      = startMs + 7 * 24 * 60 * 60 * 1000;
  } else if (period === 'month') {
    startMs    = new Date(y, m - 1, 1).getTime();
    endMs      = new Date(y, m, 1).getTime();
  } else {
    // year
    startMs    = new Date(y, 0, 1).getTime();
    endMs      = new Date(y + 1, 0, 1).getTime();
  }

  const startTs = Timestamp.fromMillis(startMs);
  const endTs   = Timestamp.fromMillis(endMs);

  try {
    const snap = await db.collection('walletTransactions')
      .where('uid', '==', uid)
      .where('createdAt', '>=', startTs)
      .where('createdAt', '<', endTs)
      .orderBy('createdAt', 'desc')
      .limit(500)
      .get();

    let totalIn  = 0;
    let totalOut = 0;
    const byCategory  = {};
    const byDayMap    = {};
    const merchantMap = {};

    for (const d of snap.docs) {
      const tx       = d.data();
      const amt      = tx.amount ?? 0;
      const dir      = tx.direction; // 'in' | 'out'
      const cat      = tx.category || 'other';
      const dateKey  = tx.createdAt?.toDate
        ? tx.createdAt.toDate().toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10);
      const merchant = tx.merchantName || tx.counterpartyUid || null;

      if (dir === 'in')  totalIn  += amt;
      if (dir === 'out') totalOut += amt;

      // By category
      if (!byCategory[cat]) byCategory[cat] = { category: cat, totalIn: 0, totalOut: 0, count: 0 };
      byCategory[cat].count++;
      if (dir === 'in')  byCategory[cat].totalIn  += amt;
      if (dir === 'out') byCategory[cat].totalOut += amt;

      // By day
      if (!byDayMap[dateKey]) byDayMap[dateKey] = { date: dateKey, in: 0, out: 0 };
      if (dir === 'in')  byDayMap[dateKey].in  += amt;
      if (dir === 'out') byDayMap[dateKey].out += amt;

      // Top merchants
      if (merchant) {
        if (!merchantMap[merchant]) merchantMap[merchant] = { name: merchant, total: 0, count: 0 };
        merchantMap[merchant].total += amt;
        merchantMap[merchant].count++;
      }
    }

    const topMerchants = Object.values(merchantMap)
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    return {
      period,
      totalIn,
      totalOut,
      netFlow:      totalIn - totalOut,
      byCategory:   Object.values(byCategory).sort((a, b) => (b.totalOut + b.totalIn) - (a.totalOut + a.totalIn)),
      byDay:        Object.values(byDayMap).sort((a, b) => a.date.localeCompare(b.date)),
      topMerchants,
    };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error(TAG, 'walletV2Analytics error:', err);
    throw new HttpsError('internal', 'Could not compute analytics');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 14. walletV2GenerateQR  — generate a signed QR payload
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a signed QR code payload that encodes a payment request.
 *
 * Signature: SHA-256(uid + amount + ts + secret)
 * The payload is a JSON string that should be encoded into an actual QR image
 * on the client side.
 *
 * @param {{ amount?: number, note?: string }} data
 * @returns {{ qrPayload: string, amount?: number, note?: string }}
 */
exports.walletV2GenerateQR = onCall(
  _optsWithSecrets(WALLET_QR_SECRET),
  async (request) => {
    const uid = _requireAuth(request);

    const { amount, note } = request.data || {};
    const safeAmount = amount != null ? Number(amount) : null;
    const safeNote   = _san(note, 200);

    if (safeAmount !== null && (!Number.isFinite(safeAmount) || safeAmount < 0)) {
      throw new HttpsError('invalid-argument', 'Invalid amount');
    }

    const ts     = Date.now();
    const secret = WALLET_QR_SECRET.value() || uid;
    const sigInput = `${uid}${safeAmount ?? ''}${ts}${secret}`;
    const sig      = _sha256(sigInput);

    const payload = {
      v:      2,
      uid,
      amount: safeAmount,
      note:   safeNote || undefined,
      ts,
      sig,
    };

    return {
      qrPayload: JSON.stringify(payload),
      amount:    safeAmount,
      note:      safeNote || undefined,
    };
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// 15. walletV2PayViaQR  — execute a payment using a scanned QR payload
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse and validate a QR payload, then execute a P2P transfer to the QR owner.
 *
 * @param {{ qrPayload: string }} data
 * @returns {{ success, recipientName, newBalance, txId }}
 */
exports.walletV2PayViaQR = onCall(
  _optsWithSecrets(WALLET_QR_SECRET),
  async (request) => {
    const payerUid = _requireAuth(request);
    const db       = _db();

    const { qrPayload } = request.data || {};
    if (!qrPayload) throw new HttpsError('invalid-argument', 'QR payload is required');

    let parsed;
    try {
      parsed = JSON.parse(qrPayload);
    } catch {
      throw new HttpsError('invalid-argument', 'Invalid QR payload format');
    }

    const { v, uid: recipientUid, amount, note, ts, sig } = parsed;

    // Version check
    if (v !== 2) throw new HttpsError('invalid-argument', 'Unsupported QR version');

    // Expiry: QR codes are valid for 15 minutes
    if (!ts || Date.now() - Number(ts) > 15 * 60 * 1000) {
      throw new HttpsError('deadline-exceeded', 'QR code has expired');
    }

    // Signature verification
    const secret   = WALLET_QR_SECRET.value() || recipientUid;
    const expected = _sha256(`${recipientUid}${amount ?? ''}${ts}${secret}`);
    if (sig !== expected) {
      throw new HttpsError('invalid-argument', 'QR signature invalid');
    }

    if (!recipientUid) throw new HttpsError('invalid-argument', 'QR payload missing recipient');
    if (payerUid === recipientUid) throw new HttpsError('invalid-argument', 'Cannot pay yourself');

    if (!amount || Number(amount) < MIN_SEND) {
      throw new HttpsError('invalid-argument', `QR payment minimum is KES ${MIN_SEND}`);
    }

    const safeAmount = Number(amount);
    const safeNote   = _san(note, 200) || 'QR payment';

    try {
      await _assertNotFrozen(db, payerUid);

      // Fetch recipient display name
      const recipientDoc  = await db.collection('users').doc(recipientUid).get();
      const recipientName = recipientDoc.exists
        ? _san(recipientDoc.data().displayName || recipientDoc.data().name || 'SOKONI User', 60)
        : 'SOKONI User';

      // Idempotency key for QR payment
      const dupeKey  = _sha256(`qr_${payerUid}_${recipientUid}_${safeAmount}_${ts}`);
      const dupeSnap = await db.collection('walletTransactions')
        .where('idempotencyKey', '==', dupeKey)
        .limit(1)
        .get();

      if (!dupeSnap.empty) {
        const ex = dupeSnap.docs[0].data();
        return { success: true, recipientName, newBalance: ex.balanceAfter ?? 0, txId: dupeSnap.docs[0].id, deduplicated: true };
      }

      await Promise.all([_ensureWallet(db, payerUid), _ensureWallet(db, recipientUid)]);

      const payerRef     = db.collection('wallets').doc(payerUid);
      const recipientRef = db.collection('wallets').doc(recipientUid);
      const txOutId      = _genId('qrp');
      const txInId       = _genId('qrr');

      let newPayerBalance;

      await db.runTransaction(async (t) => {
        const [payerSnap, recpSnap] = await Promise.all([t.get(payerRef), t.get(recipientRef)]);

        const payerBalance = payerSnap.data().balance ?? 0;
        if (payerBalance < safeAmount) throw new HttpsError('failed-precondition', 'Insufficient balance');

        newPayerBalance = payerBalance - safeAmount;
        const newRecipientBalance = (recpSnap.data().balance ?? 0) + safeAmount;
        const now = Timestamp.now();

        t.update(payerRef,     { balance: newPayerBalance, dailySpent: FieldValue.increment(safeAmount), monthlySpent: FieldValue.increment(safeAmount), updatedAt: now });
        t.update(recipientRef, { balance: newRecipientBalance, updatedAt: now });

        t.set(db.collection('walletTransactions').doc(txOutId), {
          txId: txOutId, uid: payerUid, counterpartyUid: recipientUid,
          type: 'qr_payment', direction: 'out', amount: safeAmount,
          balanceAfter: newPayerBalance, note: safeNote, category: 'qr_transfer',
          status: 'completed', idempotencyKey: dupeKey, createdAt: now,
        });
        t.set(db.collection('walletTransactions').doc(txInId), {
          txId: txInId, uid: recipientUid, counterpartyUid: payerUid,
          type: 'qr_receive', direction: 'in', amount: safeAmount,
          balanceAfter: newRecipientBalance, note: safeNote, category: 'qr_transfer',
          status: 'completed', idempotencyKey: dupeKey, createdAt: now,
        });
      });

      return { success: true, recipientName, newBalance: newPayerBalance, txId: txOutId };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      console.error(TAG, 'walletV2PayViaQR error:', err);
      throw new HttpsError('internal', 'QR payment failed. Please try again.');
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// 16. walletV2AiInsights  — Anthropic Claude Haiku spending insights
// ═══════════════════════════════════════════════════════════════════════════════

const FALLBACK_INSIGHTS = [
  'Keep tracking your spending to stay on top of your finances!',
  'Set a savings goal this week — even KES 500 counts.',
  "Review your subscriptions monthly and cancel what you don't use.",
];

/**
 * Generate 3 personalised financial insights using Claude Haiku.
 * Falls back to static tips on any Anthropic error.
 *
 * @returns {{ insights: string[], generatedAt: string }}
 */
exports.walletV2AiInsights = onCall(
  _optsWithSecrets(ANTHROPIC_API_KEY),
  async (request) => {
    const uid         = _requireAuth(request);
    const db          = _db();
    const generatedAt = new Date().toISOString();

    try {
      // Fetch last 30 transactions
      const snap = await db.collection('walletTransactions')
        .where('uid', '==', uid)
        .orderBy('createdAt', 'desc')
        .limit(30)
        .get();

      const txSummaries = snap.docs.map((d) => {
        const t = d.data();
        return `${t.direction === 'out' ? '-' : '+'}KES${t.amount} [${t.category || t.type}] ${t.note || ''}`.trim();
      }).join('\n');

      if (!txSummaries) {
        return { insights: FALLBACK_INSIGHTS, generatedAt };
      }

      const apiKey = ANTHROPIC_API_KEY.value();
      if (!apiKey) {
        return { insights: FALLBACK_INSIGHTS, generatedAt };
      }

      // Call Anthropic Claude Haiku via REST (no SDK — keeps bundle lean)
      const body = JSON.stringify({
        model:      'claude-haiku-4-5',
        max_tokens: 300,
        messages: [
          {
            role:    'user',
            content: `You are a friendly Kenyan financial advisor. Based on this user's last 30 wallet transactions, give exactly 3 short, actionable financial insights (max 40 words each). Be casual, helpful, and specific to their patterns. Use light Kenyan English where appropriate.\n\nTransactions:\n${txSummaries}\n\nRespond with ONLY a JSON array of 3 strings: ["insight1","insight2","insight3"]`,
          },
        ],
      });

      const https    = require('https');
      const response = await new Promise((resolve, reject) => {
        const req = https.request(
          {
            hostname: 'api.anthropic.com',
            path:     '/v1/messages',
            method:   'POST',
            headers: {
              'Content-Type':      'application/json',
              'x-api-key':         apiKey,
              'anthropic-version': '2023-06-01',
              'Content-Length':    Buffer.byteLength(body),
            },
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
          }
        );
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      if (response.statusCode !== 200) {
        console.error(TAG, 'Anthropic API error:', response.statusCode, response.body);
        return { insights: FALLBACK_INSIGHTS, generatedAt };
      }

      const parsed  = JSON.parse(response.body);
      const content = parsed?.content?.[0]?.text || '[]';

      let insights;
      try {
        insights = JSON.parse(content);
        if (!Array.isArray(insights) || insights.length === 0) throw new Error('bad format');
        // Sanitize each insight
        insights = insights.slice(0, 3).map((s) => _san(s, 200));
      } catch {
        insights = FALLBACK_INSIGHTS;
      }

      return { insights, generatedAt };
    } catch (err) {
      console.error(TAG, 'walletV2AiInsights error:', err);
      // Never fail the user — return fallbacks
      return { insights: FALLBACK_INSIGHTS, generatedAt };
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// 17. walletV2EscrowCreate  — create an escrow hold
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Lock funds into an escrow hold. Funds are deducted from the caller's
 * (buyer's) wallet and held in the escrowV2 document until released.
 *
 * @param {{
 *   amount: number, description: string, releaseCondition: string,
 *   counterpartyPhone?: string, milestones?: Array<{name: string, amount: number}>
 * }} data
 * @returns {{ escrowId, amount, status: 'held' }}
 */
exports.walletV2EscrowCreate = onCall(BASE_OPTS, async (request) => {
  const buyerUid = _requireAuth(request);
  const db       = _db();

  const { amount, description, releaseCondition, counterpartyPhone, milestones } = request.data || {};

  const safeAmount = Number(amount);
  if (!Number.isFinite(safeAmount) || safeAmount < 1) {
    throw new HttpsError('invalid-argument', 'Escrow amount must be at least KES 1');
  }

  const safeDesc      = _san(description, 500);
  const safeCond      = _san(releaseCondition, 500);
  if (!safeDesc) throw new HttpsError('invalid-argument', 'description is required');
  if (!safeCond) throw new HttpsError('invalid-argument', 'releaseCondition is required');

  // Validate milestones if provided
  let safeMilestones = null;
  if (Array.isArray(milestones) && milestones.length > 0) {
    const mTotal = milestones.reduce((s, ms) => s + (Number(ms.amount) || 0), 0);
    if (Math.abs(mTotal - safeAmount) > 0.01) {
      throw new HttpsError('invalid-argument', 'Milestone amounts must sum to the escrow amount');
    }
    safeMilestones = milestones.map((ms) => ({
      name:   _san(ms.name, 100),
      amount: Number(ms.amount),
      status: 'pending',
    }));
  }

  // Resolve counterparty
  let sellerUid   = null;
  let sellerPhone = null;
  if (counterpartyPhone) {
    const normalizedPhone = _normalizePhone(counterpartyPhone);
    if (!normalizedPhone) throw new HttpsError('invalid-argument', 'Invalid counterparty phone number');
    sellerPhone = normalizedPhone;
    const sellerDoc = await _findUserByPhone(db, normalizedPhone);
    if (sellerDoc) sellerUid = sellerDoc.id;
  }

  try {
    await _assertNotFrozen(db, buyerUid);
    await _ensureWallet(db, buyerUid);

    const walletRef  = db.collection('wallets').doc(buyerUid);
    const escrowId   = _genId('esc2');
    const escrowRef  = db.collection('escrowV2').doc(escrowId);

    await db.runTransaction(async (t) => {
      const walletSnap = await t.get(walletRef);
      const balance    = walletSnap.data().balance ?? 0;

      if (balance < safeAmount) throw new HttpsError('failed-precondition', 'Insufficient balance');

      const now = Timestamp.now();

      t.update(walletRef, { balance: FieldValue.increment(-safeAmount), updatedAt: now });

      t.set(escrowRef, {
        escrowId,
        buyerUid,
        sellerUid,
        sellerPhone,
        amount:           safeAmount,
        description:      safeDesc,
        releaseCondition: safeCond,
        milestones:       safeMilestones,
        status:           'held',
        createdAt:        now,
        updatedAt:        now,
      });

      const txId = _genId('elck');
      t.set(db.collection('walletTransactions').doc(txId), {
        txId,
        uid:         buyerUid,
        escrowId,
        type:        'escrow_lock',
        direction:   'out',
        amount:      safeAmount,
        note:        `Escrow: ${safeDesc}`,
        category:    'escrow',
        status:      'completed',
        createdAt:   now,
      });
    });

    return { escrowId, amount: safeAmount, status: 'held' };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error(TAG, 'walletV2EscrowCreate error:', err);
    throw new HttpsError('internal', 'Could not create escrow');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 18. walletV2EscrowRelease  — release escrow funds to the seller
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Release an escrow hold. Only the buyer (initiator) or an admin may call this.
 * Credits the seller's wallet and marks the escrow as released.
 *
 * @param {{ escrowId: string }} data
 * @returns {{ success: true, releasedAmount: number }}
 */
exports.walletV2EscrowRelease = onCall(BASE_OPTS, async (request) => {
  const callerUid = _requireAuth(request);
  const db        = _db();

  const { escrowId } = request.data || {};
  if (!escrowId) throw new HttpsError('invalid-argument', 'escrowId is required');

  try {
    const escrowRef  = db.collection('escrowV2').doc(escrowId);
    const escrowSnap = await escrowRef.get();

    if (!escrowSnap.exists) throw new HttpsError('not-found', 'Escrow not found');

    const escrow     = escrowSnap.data();
    const isAdmin    = request.auth?.token?.admin || request.auth?.token?.superAdmin;
    const isBuyer    = escrow.buyerUid === callerUid;

    if (!isAdmin && !isBuyer) {
      throw new HttpsError('permission-denied', 'Only the buyer or an admin can release escrow');
    }

    if (escrow.status !== 'held') {
      throw new HttpsError('failed-precondition', `Escrow is already ${escrow.status}`);
    }

    if (!escrow.sellerUid) {
      throw new HttpsError('failed-precondition', 'No seller linked to this escrow. Set sellerUid before releasing.');
    }

    await _ensureWallet(db, escrow.sellerUid);

    const sellerRef = db.collection('wallets').doc(escrow.sellerUid);

    await db.runTransaction(async (t) => {
      const now = Timestamp.now();

      t.update(escrowRef, { status: 'released', releasedAt: now, releasedBy: callerUid, updatedAt: now });
      t.update(sellerRef, { balance: FieldValue.increment(escrow.amount), updatedAt: now });

      const txId = _genId('erel');
      t.set(db.collection('walletTransactions').doc(txId), {
        txId,
        uid:       escrow.sellerUid,
        escrowId,
        buyerUid:  escrow.buyerUid,
        type:      'escrow_release',
        direction: 'in',
        amount:    escrow.amount,
        note:      `Escrow released: ${escrow.description}`,
        category:  'escrow',
        status:    'completed',
        createdAt: now,
      });
    });

    await _audit(db, callerUid, 'ESCROW_RELEASED', { escrowId, amount: escrow.amount, sellerUid: escrow.sellerUid });

    return { success: true, releasedAmount: escrow.amount };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error(TAG, 'walletV2EscrowRelease error:', err);
    throw new HttpsError('internal', 'Could not release escrow');
  }
});
