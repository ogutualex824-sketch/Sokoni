'use strict';
/**
 * SOKONI — WALLET MONEY ADAPTER
 * functions/wallet-money-adapter.js
 *
 * STATUS: **NOT INTEGRATED, NOT DEPLOYED.** No callable calls this. It is not exported from
 * functions/index.js. Building it does not change any live money path.
 *
 * ── D1: read-existing, write-new ────────────────────────────────────────────────────
 * The wallet freeze is NOT lifted and there is NO second balance.
 *
 *     wallets/{uid}.balance      the SOLE mutable monetary authority (shillings)
 *     walletMoneyLedger/{id}     append-only audit trail — records what happened,
 *                                and never maintains a balance of its own
 *
 * The ledger deliberately has no `availableBalance` field to drift out of agreement with
 * the wallet. It records `balanceBefore`/`balanceAfter` as OBSERVATIONS at commit time, not
 * as an authority anyone may read back as truth. Reconstructing a balance from the journal
 * is a reconciliation check, never a source.
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────────────────
 *   A successful wallet transaction has BOTH the balance mutation and its ledger record.
 *   A failed one has NEITHER.
 * Enforced by doing every read, every validation and every write inside ONE Firestore
 * transaction. Nothing is written before validation completes, so a refusal touches nothing.
 *
 * ── IDEMPOTENCY IS PART OF THE SAME ATOMIC ACT ──────────────────────────────────────
 * The ledger document id IS the idempotency key. A retry re-reads that document inside the
 * transaction and returns the prior outcome instead of debiting again. Checking idempotency
 * outside the transaction would leave a window in which two concurrent retries both observe
 * "not yet done" — which is exactly how a wallet gets debited twice.
 *
 * ── ALL READS BEFORE ALL WRITES ─────────────────────────────────────────────────────
 * Firestore requires it, and this codebase has already been bitten: `posCompleteCheckout`
 * once wrote a wallet debit and then read inventory in the same transaction, so every
 * wallet-paid sale failed 100%. Reads are batched first here for that reason.
 *
 * ── DEPENDENCY INJECTION ────────────────────────────────────────────────────────────
 * `db` and `now` are injected so the adapter can be certified against a fake that models
 * transaction semantics — including contention and retry — without an emulator, without
 * credentials, and without touching production.
 */

const MA = require('./money-authority');

const WALLETS = 'wallets';
const LEDGER = 'walletMoneyLedger';

const ENTRY = {
  SALE_CREDIT:           'SALE_CREDIT',
  COMMISSION_DEBIT:      'COMMISSION_DEBIT',
  WALLET_PURCHASE:       'WALLET_PURCHASE',
  COMMISSION_SETTLEMENT: 'COMMISSION_SETTLEMENT',
  WITHDRAWAL_RESERVE:    'WITHDRAWAL_RESERVE',
  WITHDRAWAL_COMPLETE:   'WITHDRAWAL_COMPLETE',
  WITHDRAWAL_REVERSE:    'WITHDRAWAL_REVERSE'
};

/* Which direction each entry type moves money. Fails closed: an unknown type cannot be
   applied at all, so a new entry kind must be classified deliberately rather than
   defaulting to one direction and silently mis-booking. */
const ENTRY_DIRECTION = {
  SALE_CREDIT:           +1,
  COMMISSION_DEBIT:      -1,
  WALLET_PURCHASE:       -1,
  COMMISSION_SETTLEMENT: -1,
  WITHDRAWAL_RESERVE:    -1,
  WITHDRAWAL_COMPLETE:    0,   /* the money already left at RESERVE; this only finalises */
  WITHDRAWAL_REVERSE:    +1
};

class AdapterError extends Error {
  constructor (code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail || null;
  }
}

function createWalletAdapter ({ db, now }) {
  if (!db || typeof db.runTransaction !== 'function') {
    throw new AdapterError('ADAPTER_NO_DB', 'db with runTransaction is required');
  }
  const clock = typeof now === 'function' ? now : () => Date.now();

  /**
   * Apply one money movement atomically.
   *
   * Returns { applied:true, ... } on a fresh commit, or { applied:false, replayed:true, ... }
   * when the idempotency key has already been honoured — never a second debit.
   */
  async function apply ({
    walletUid, entryType, amount, reason, idempotencyKey,
    authorization = null, metadata = null, expectCustody = null
  }) {
    if (!walletUid || typeof walletUid !== 'string') {
      throw new AdapterError('ADAPTER_NO_WALLET', 'walletUid is required');
    }
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      throw new AdapterError('ADAPTER_NO_IDEMPOTENCY_KEY',
        'An idempotency key is required: without one a retry debits twice.');
    }
    const direction = ENTRY_DIRECTION[entryType];
    if (direction === undefined) {
      throw new AdapterError('ADAPTER_UNKNOWN_ENTRY_TYPE',
        'Entry type "' + entryType + '" has no direction. Classify it deliberately.');
    }
    if (!amount || typeof amount.minorUnits !== 'number') {
      throw new AdapterError('ADAPTER_NO_AMOUNT', 'amount must be Money');
    }
    if (amount.minorUnits < 0) {
      throw new AdapterError('ADAPTER_NEGATIVE_AMOUNT',
        'Amount must not be negative; direction is carried by entryType, not by sign.');
    }
    if (expectCustody && expectCustody !== MA.CUSTODY.CUSTODIAL) {
      throw new AdapterError('ADAPTER_NON_CUSTODIAL',
        'A NON_CUSTODIAL movement must not touch a wallet balance. ' +
        'Cash and direct-to-merchant sales record a liability, not a credit.');
    }

    const walletRef = db.collection(WALLETS).doc(walletUid);
    const ledgerRef = db.collection(LEDGER).doc(idempotencyKey);

    return db.runTransaction(async (txn) => {
      /* ── PHASE 1: ALL READS ── */
      const [ledgerSnap, walletSnap] = await Promise.all([
        txn.get(ledgerRef),
        txn.get(walletRef)
      ]);

      /* ── PHASE 2: VALIDATE — no writes yet, so a refusal touches nothing ── */

      /* idempotency, INSIDE the transaction: a concurrent retry cannot also see "absent" */
      if (ledgerSnap.exists) {
        const prior = ledgerSnap.data() || {};
        if (prior.walletUid !== walletUid || prior.amountMinor !== amount.minorUnits ||
            prior.entryType !== entryType) {
          throw new AdapterError('ADAPTER_IDEMPOTENCY_CONFLICT',
            'This idempotency key was used for a different movement. Reusing a key across ' +
            'different amounts or wallets would hide one of them.',
            { key: idempotencyKey });
        }
        return {
          applied: false, replayed: true, ledgerId: idempotencyKey,
          balanceAfter: MA.fromMinor(prior.balanceAfterMinor, prior.currency),
          entryType, walletUid
        };
      }

      if (!walletSnap.exists) {
        /* A missing wallet is NOT a zero balance. Treating it as zero would let a credit
           conjure a wallet with no owner, and would report a debit as merely unaffordable
           rather than as addressed to nothing. */
        throw new AdapterError('ADAPTER_WALLET_NOT_FOUND',
          'No wallet exists for this account.', { walletUid });
      }
      const w = walletSnap.data() || {};

      const currency = w.currency || MA.CURRENCY;
      if (currency !== amount.currency) {
        throw new AdapterError('ADAPTER_CURRENCY_MISMATCH',
          'Wallet is ' + currency + ' but the amount is ' + amount.currency);
      }
      if (w.frozen === true) {
        throw new AdapterError('ADAPTER_WALLET_FROZEN', 'This wallet is frozen.');
      }

      /* `balance` is the canonical withdrawable figure, in shillings — confirmed by
         production data (present on every sampled wallet; `available`/`availableBalance`
         appear in code but in no document). Absent is refused, not defaulted to zero. */
      if (typeof w.balance !== 'number' || !isFinite(w.balance)) {
        throw new AdapterError('ADAPTER_BALANCE_UNREADABLE',
          'The wallet balance could not be read as a number. Refusing to transact.',
          { walletUid });
      }
      const balance = MA.fromMajor(Number(w.balance), currency);

      /* authorization, for movements that spend someone else's wallet */
      if (entryType === ENTRY.WALLET_PURCHASE) {
        MA.planWalletPayment({
          buyerUid: walletUid, balance, amount, authorization, nowMs: clock()
        });   /* throws WALLET_* on any failure, including insufficient balance */
      } else if (direction < 0) {
        if (!MA.gte(balance, amount)) {
          throw new AdapterError('ADAPTER_INSUFFICIENT_BALANCE',
            'Insufficient balance. The wallet holds ' + MA.toMajorString(balance) +
            ' but ' + MA.toMajorString(amount) + ' is required.',
            { balanceMinor: balance.minorUnits, requiredMinor: amount.minorUnits,
              shortfallMinor: amount.minorUnits - balance.minorUnits });
        }
      }

      const delta = direction * amount.minorUnits;
      const afterMinor = balance.minorUnits + delta;
      if (afterMinor < 0) {
        /* belt and braces: no path may leave a negative balance */
        throw new AdapterError('ADAPTER_WOULD_GO_NEGATIVE',
          'This movement would leave a negative balance.',
          { balanceMinor: balance.minorUnits, deltaMinor: delta });
      }
      const balanceAfter = MA.fromMinor(afterMinor, currency);
      const ts = clock();

      /* ── PHASE 3: ALL WRITES ── */
      txn.create(ledgerRef, {
        ledgerId: idempotencyKey,
        idempotencyKey,
        walletUid,
        entryType,
        direction,
        amountMinor: amount.minorUnits,
        currency,
        reason: reason || null,
        /* observations at commit time — NOT an authority to read back as a balance */
        balanceBeforeMinor: balance.minorUnits,
        balanceAfterMinor: balanceAfter.minorUnits,
        authorizationId: authorization ? (authorization.id || null) : null,
        metadata: metadata || null,
        createdAt: ts
      });
      txn.update(walletRef, {
        balance: Number(MA.toMajorString(balanceAfter)),
        updatedAt: ts
      });

      return {
        applied: true, replayed: false, ledgerId: idempotencyKey,
        balanceBefore: balance, balanceAfter, entryType, walletUid, delta
      };
    });
  }

  return {
    ENTRY,
    apply,
    /* Convenience wrappers — they add no authority of their own, only a name. */
    creditSale:  (a) => apply(Object.assign({ entryType: ENTRY.SALE_CREDIT }, a)),
    purchase:    (a) => apply(Object.assign({ entryType: ENTRY.WALLET_PURCHASE }, a)),
    settle:      (a) => apply(Object.assign({ entryType: ENTRY.COMMISSION_SETTLEMENT }, a)),
    reserve:     (a) => apply(Object.assign({ entryType: ENTRY.WITHDRAWAL_RESERVE }, a)),
    reverse:     (a) => apply(Object.assign({ entryType: ENTRY.WITHDRAWAL_REVERSE }, a))
  };
}

module.exports = { createWalletAdapter, AdapterError, ENTRY, ENTRY_DIRECTION, WALLETS, LEDGER };
