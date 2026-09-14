'use strict';
/**
 * SOKONI — BUSINESS WALLET   (separate from the personal wallet, structurally)
 * functions/business-wallet.js
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────
 * `commission-settlement-authority.assertBusinessWallet()` refuses to settle a merchant
 * liability from anything but a BUSINESS wallet:
 *
 *     "A buyer's personal wallet paying a shop's commission would be taking a stranger's
 *      money for someone else's debt, and the only thing standing between those two cases
 *      is which id a caller passed."
 *
 * It was guarding a concept that did not exist. Production had `wallets/{uid}` and one
 * stray reference to `merchantWallets`; no document anywhere carried `kind: 'BUSINESS'`.
 * So the settlement path could not be wired without either inventing a mapping onto the
 * personal wallet — the exact thing the guard forbids — or building this.
 *
 * ── THE TWO WALLETS, AND WHY THEY CANNOT BE CONFUSED ────────────────────────────────
 *
 *   wallets/{uid}                PERSONAL   balance in SHILLINGS   the buyer's own money
 *   businessWallets/{shopId}     BUSINESS   balanceMinor in CENTS  the shop's float
 *
 * Three separations, each deliberate:
 *
 *   1. DIFFERENT COLLECTION. Not a flag on the same document, because a flag can be
 *      written and a collection cannot be mistaken.
 *   2. DIFFERENT KEY SPACE. Keyed by SHOP, not by account. One owner may run several
 *      businesses, and the Store-identity work has already ratified that the owner uid
 *      cannot serve as the store identity. Keying by shopId is correct today (where
 *      projectSeller sets shopId = uid) and stays correct after that migration.
 *   3. DIFFERENT UNIT, NAMED IN THE FIELD. `balanceMinor` is CENTS. The personal wallet's
 *      `balance` is SHILLINGS, and FinOS `availableBalance` is cents — this database
 *      already holds two conventions, and a bare `balance` here would eventually be added
 *      to one of them. The unit is in the name so the mistake has to be typed out.
 *
 * ── EVERY MOVEMENT IS LEDGERED AND IDEMPOTENT ───────────────────────────────────────
 * A credit or debit without a reference is refused. The reference is the document id of
 * the ledger entry, so a retried Cloud Function, a replayed webhook or a double-tapped
 * button converge on one movement instead of two. The balance and its ledger entry are
 * written in the SAME transaction: a balance that could move without an entry is
 * untraceable, and an entry that could land without the balance is a phantom.
 *
 * ── NEVER NEGATIVE ──────────────────────────────────────────────────────────────────
 * A debit that would overdraw is refused with the exact shortfall, not clamped to zero. A
 * clamped debit silently forgives part of a debt and leaves the ledger disagreeing with
 * the balance.
 */

const MA = require('./money-authority');

const WALLETS = 'businessWallets';
const ENTRIES = 'businessWalletEntries';

const KIND = 'BUSINESS';

const ENTRY = Object.freeze({
  CREDIT: 'CREDIT',
  DEBIT:  'DEBIT',
});

class BusinessWalletError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'BusinessWalletError';
    this.code = code;
    if (details) this.details = details;
  }
}

const _int = (v) => (typeof v === 'number' && isFinite(v) && Math.floor(v) === v);

/* ═══════════════════════════════════════════════════════════════════════════
   Provisioning
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Create the shop's business wallet if it does not exist. Idempotent.
 *
 * Deliberately does NOT accept an opening balance. A wallet that can be created with money
 * in it is a wallet that can be credited without a ledger entry, and the first thing anyone
 * would do with that is "fix" a balance by recreating it.
 */
async function ensureBusinessWallet(db, { shopId, ownerUid, currency }) {
  if (!db || typeof db.collection !== 'function') {
    throw new BusinessWalletError('BW_NO_DB', 'ensureBusinessWallet(db, …): db is required');
  }
  if (!shopId) throw new BusinessWalletError('BW_NO_SHOP', 'shopId is required');
  if (!ownerUid) {
    throw new BusinessWalletError('BW_NO_OWNER',
      'ownerUid is required — a wallet nobody owns cannot be debited for anybody\'s debt.');
  }
  const ref = db.collection(WALLETS).doc(String(shopId));
  const snap = await ref.get();
  if (snap.exists) {
    const w = snap.data() || {};
    /* An existing wallet is NEVER re-owned here. Silently rewriting ownerUid would let a
       shop transfer, a merge or a bug move a float to a different person, and it would look
       like provisioning. Ownership changes are their own operation, with their own audit. */
    if (String(w.ownerUid || '') !== String(ownerUid)) {
      return { action: 'exists_other_owner', shopId: String(shopId),
        ownerUid: w.ownerUid || null, requestedOwnerUid: String(ownerUid) };
    }
    return { action: 'exists', shopId: String(shopId), ownerUid: w.ownerUid };
  }
  await ref.set({
    uid:      String(shopId),          /* what assertBusinessWallet reads as wallet.uid  */
    shopId:   String(shopId),
    ownerUid: String(ownerUid),
    kind:     KIND,                    /* the field the settlement authority insists on  */
    balanceMinor: 0,                   /* CENTS. The name carries the unit deliberately. */
    currency: currency || 'KES',
    status:   'ACTIVE',
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  });
  return { action: 'created', shopId: String(shopId), ownerUid: String(ownerUid) };
}

/**
 * Read a business wallet in the shape `assertBusinessWallet` expects.
 *
 * Returns null ONLY when the document genuinely does not exist. A failed read throws — a
 * missing wallet and an unreadable one lead to different, and differently safe, outcomes.
 */
async function getBusinessWallet(db, shopId) {
  if (!shopId) throw new BusinessWalletError('BW_NO_SHOP', 'shopId is required');
  let snap;
  try {
    snap = await db.collection(WALLETS).doc(String(shopId)).get();
  } catch (e) {
    throw new BusinessWalletError('BW_UNREADABLE',
      'The business wallet could not be read. Refusing to report a balance.',
      { cause: String(e && e.message || e) });
  }
  if (!snap.exists) return null;
  const w = snap.data() || {};
  if (!_int(w.balanceMinor)) {
    throw new BusinessWalletError('BW_UNREADABLE',
      'The business wallet balance is not a whole number of cents. Refusing to transact.',
      { shopId: String(shopId) });
  }
  if (w.kind !== KIND) {
    /* Structural, not cosmetic: something in the BUSINESS collection that is not a business
       wallet is a data-integrity failure, and treating it as one anyway is how the personal
       wallet ends up being debited. */
    throw new BusinessWalletError('BW_WRONG_KIND',
      'A document in ' + WALLETS + ' does not carry kind:BUSINESS. Refusing to transact.',
      { shopId: String(shopId), kind: w.kind || null });
  }
  return {
    uid: w.uid || String(shopId),
    shopId: String(shopId),
    ownerUid: w.ownerUid || null,
    kind: w.kind,
    status: w.status || 'ACTIVE',
    currency: w.currency || 'KES',
    balanceMinor: w.balanceMinor,
    balance: MA.fromMinor(w.balanceMinor),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Movement
   ═══════════════════════════════════════════════════════════════════════════ */

async function _move(db, { shopId, amountMinor, ref, reason, direction, metadata }) {
  if (!shopId) throw new BusinessWalletError('BW_NO_SHOP', 'shopId is required');
  if (!ref || typeof ref !== 'string') {
    throw new BusinessWalletError('BW_NO_REF',
      'A reference is required: without one a retry moves the money twice.');
  }
  if (!_int(amountMinor) || amountMinor <= 0) {
    throw new BusinessWalletError('BW_BAD_AMOUNT',
      'amountMinor must be a positive whole number of cents.', { amountMinor });
  }

  const walletRef = db.collection(WALLETS).doc(String(shopId));
  const entryRef  = db.collection(ENTRIES).doc(String(ref));

  return db.runTransaction(async (tx) => {
    /* ALL READS BEFORE ANY WRITE — Firestore requires it, and getting it wrong here fails
       at runtime under contention rather than in a test. */
    const [entrySnap, walletSnap] = await Promise.all([tx.get(entryRef), tx.get(walletRef)]);

    if (entrySnap.exists) {
      const e = entrySnap.data() || {};
      return { action: 'already_applied', ref: String(ref),
        amountMinor: e.amountMinor, balanceMinor: e.balanceAfterMinor };
    }
    if (!walletSnap.exists) {
      throw new BusinessWalletError('BW_NO_WALLET',
        'This shop has no business wallet. Provision one before transacting.',
        { shopId: String(shopId) });
    }
    const w = walletSnap.data() || {};
    if (w.kind !== KIND) {
      throw new BusinessWalletError('BW_WRONG_KIND',
        'Refusing to transact against a document that is not a BUSINESS wallet.',
        { shopId: String(shopId), kind: w.kind || null });
    }
    if (!_int(w.balanceMinor)) {
      throw new BusinessWalletError('BW_UNREADABLE',
        'The business wallet balance is unreadable. Refusing to transact.');
    }

    const before = w.balanceMinor;
    const after = direction === ENTRY.CREDIT ? before + amountMinor : before - amountMinor;
    if (after < 0) {
      /* Refused with the exact shortfall rather than clamped. A clamped debit forgives part
         of a debt silently and leaves the ledger disagreeing with the balance. */
      throw new BusinessWalletError('BW_INSUFFICIENT_FUNDS',
        'The business wallet holds ' + MA.toMajorString(MA.fromMinor(before)) +
        ' and this debit is ' + MA.toMajorString(MA.fromMinor(amountMinor)) +
        '. Short by ' + MA.toMajorString(MA.fromMinor(amountMinor - before)) + '.',
        { balanceMinor: before, amountMinor, shortfallMinor: amountMinor - before,
          partialDebitRefused: true });
    }

    tx.set(entryRef, {
      ref: String(ref),
      shopId: String(shopId),
      ownerUid: w.ownerUid || null,
      direction,
      amountMinor,
      balanceBeforeMinor: before,
      balanceAfterMinor: after,
      currency: w.currency || 'KES',
      reason: reason || null,
      metadata: metadata || null,
      atMs: Date.now(),
    });
    tx.update(walletRef, { balanceMinor: after, updatedAtMs: Date.now() });

    return { action: direction === ENTRY.CREDIT ? 'credited' : 'debited',
      ref: String(ref), amountMinor, balanceMinor: after };
  });
}

const creditBusinessWallet = (db, o) => _move(db, Object.assign({}, o, { direction: ENTRY.CREDIT }));
const debitBusinessWallet  = (db, o) => _move(db, Object.assign({}, o, { direction: ENTRY.DEBIT  }));

module.exports = {
  WALLETS, ENTRIES, KIND, ENTRY, BusinessWalletError,
  ensureBusinessWallet,
  getBusinessWallet,
  creditBusinessWallet,
  debitBusinessWallet,
};
