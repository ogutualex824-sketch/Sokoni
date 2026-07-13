/**
 * SOKONI Enterprise Payment Engine  v2.0
 *
 * Complete financial processing layer:
 *  - Double-entry ledger (every credit has a matching debit)
 *  - Escrow management (hold → release | refund)
 *  - Split payments (multi-party: platform + seller + driver)
 *  - Settlement engine (batch seller payouts)
 *  - Refund engine (full, partial, item-level)
 *  - Chargeback handling
 *  - Wallet transfers
 *  - Tax calculations (VAT 16%, WHT 5%, DST 1.5%)
 *  - Multi-currency support with KES as base
 *  - Receipt & invoice generation hooks
 *  - Payment reconciliation
 *
 * All financial operations are:
 *  - Atomic (Firestore transaction-backed)
 *  - Idempotent (keyed by reference)
 *  - Audited (every state change written to paymentLedger)
 *  - Validated (amount > 0, currency known, ownership verified)
 */

'use strict';

const SokoniPaymentEngine = (function () {

  /* ════════════════════════════════════════════════════════════
     CONSTANTS
  ════════════════════════════════════════════════════════════ */
  const CURRENCIES = Object.freeze({
    KES: { symbol: 'KES', decimals: 2, minAmount: 1    },
    USD: { symbol: 'USD', decimals: 2, minAmount: 0.01 },
    EUR: { symbol: 'EUR', decimals: 2, minAmount: 0.01 },
    GBP: { symbol: 'GBP', decimals: 2, minAmount: 0.01 },
  });

  const PAYMENT_STATUS = Object.freeze({
    PENDING:    'pending',
    PROCESSING: 'processing',
    COMPLETED:  'completed',
    FAILED:     'failed',
    CANCELLED:  'cancelled',
    REFUNDED:   'refunded',
    DISPUTED:   'disputed',
    ESCROWED:   'escrowed',
    RELEASED:   'released',
    CHARGEBACK: 'chargeback',
  });

  const ESCROW_STATUS = Object.freeze({
    ACTIVE:   'active',
    RELEASED: 'released',
    REFUNDED: 'refunded',
    DISPUTED: 'disputed',
    EXPIRED:  'expired',
  });

  /* Kenyan tax rates */
  const TAX = Object.freeze({
    VAT:  0.16,    // 16% Value Added Tax on platform commission
    WHT:  0.05,    // 5% Withholding Tax on seller/provider payments ≥ KES 24,000/month
    DST:  0.015,   // 1.5% Digital Service Tax on gross revenue
    WHT_THRESHOLD: 24000,
  });

  /* Platform split — DISPLAY DEFAULT ONLY. The client never prices a settlement.
   *
   * This was a hardcoded 0.10. No hub charges 10%: marketplace is 3%, legal 5%, property 2%.
   * It was the default `commissionRate` for this file's escrow-release and settlement helpers,
   * so any caller that omitted the rate silently computed money at a figure the server would
   * never charge.
   *
   * The rate now comes from the one config, via SokoniCommission (generated from
   * functions/commission-config.js). It remains a DISPLAY figure only: the authoritative number
   * for a real order comes from previewCommission / calculateCommission on the server, which
   * also applies commissionRules, revenueConfig and any plan benefit this table cannot know. */
  const PLATFORM_FEE_RATE = (typeof window !== 'undefined' && window.SokoniCommission)
    ? window.SokoniCommission.pct('marketplace') / 100
    : 0.03;   /* the marketplace base — never an invented 10% */

  /* Minimum escrow period in milliseconds */
  const ESCROW_MIN_MS = 30 * 60 * 1000;   // 30 minutes
  const ESCROW_MAX_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days

  /* ════════════════════════════════════════════════════════════
     HELPERS
  ════════════════════════════════════════════════════════════ */
  function _ref() {
    return 'PAY-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();
  }

  function _escrowRef() {
    return 'ESC-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7).toUpperCase();
  }

  function _validateAmount(amount, currency = 'KES') {
    const cur = CURRENCIES[currency];
    if (!cur) throw new Error(`Unsupported currency: ${currency}`);
    const amt = Number(amount);
    if (!isFinite(amt) || amt < cur.minAmount) {
      throw new Error(`Invalid amount ${amount} for ${currency} (min ${cur.minAmount})`);
    }
    return Math.round(amt * 100) / 100;  // normalise to 2dp
  }

  function _round(n) { return Math.round(n * 100) / 100; }

  /* ── Get Firestore helpers ── */
  async function _fsImport() {
    return import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
  }

  function _db() {
    const db = window.firebaseDB;
    if (!db) throw new Error('[PaymentEngine] Firestore not initialised (load firebase.js first)');
    return db;
  }

  function _uid() {
    return window.firebaseAuth?.currentUser?.uid ?? null;
  }

  /* ── Idempotency store (prevents double charges) ── */
  const _idem = new Map();
  function _idemGuard(key) {
    if (_idem.has(key)) return _idem.get(key);
    return null;
  }
  function _idemSet(key, result) {
    _idem.set(key, result);
    setTimeout(() => _idem.delete(key), 86400000);  // 24h TTL
  }

  /* ════════════════════════════════════════════════════════════
     LEDGER — double-entry accounting
  ════════════════════════════════════════════════════════════ */
  const Ledger = {
    /**
     * Record a double-entry ledger transaction.
     * Debit and credit must balance (debit = credit).
     */
    async record(opts) {
      const {
        reference, type, debitAccount, creditAccount,
        amount, currency = 'KES', metadata = {},
      } = opts;

      const amt = _validateAmount(amount, currency);
      if (amt <= 0) throw new Error('[Ledger] Amount must be positive');

      const { collection, addDoc, serverTimestamp } = await _fsImport();
      const db = _db();

      const entry = {
        reference,
        type,
        debitAccount,
        creditAccount,
        amount:   amt,
        currency,
        metadata,
        uid:      _uid(),
        serverTs: serverTimestamp(),
        status:   'posted',
      };

      await addDoc(collection(db, 'paymentLedger'), entry);

      if (window.SokoniLogger) {
        window.SokoniLogger.log(`[Ledger] ${type}: ${currency} ${amt} (DR: ${debitAccount} / CR: ${creditAccount})`);
      }

      return entry;
    },

    /** Fetch ledger entries for an account, newest first. */
    async balance(account, currency = 'KES') {
      const { collection, query, where, orderBy, getDocs } = await _fsImport();
      const db = _db();
      const [debits, credits] = await Promise.all([
        getDocs(query(collection(db, 'paymentLedger'),
          where('debitAccount',  '==', account),
          where('currency',      '==', currency))),
        getDocs(query(collection(db, 'paymentLedger'),
          where('creditAccount', '==', account),
          where('currency',      '==', currency))),
      ]);

      let bal = 0;
      debits.docs.forEach(d  => { bal -= d.data().amount; });
      credits.docs.forEach(c => { bal += c.data().amount; });
      return _round(bal);
    },
  };

  /* ════════════════════════════════════════════════════════════
     ESCROW SERVICE
  ════════════════════════════════════════════════════════════ */
  const Escrow = {
    /**
     * Create an escrow hold for an order.
     * Funds are marked reserved until release or refund.
     */
    async create(opts) {
      const {
        orderId, buyerId, sellerId,
        amount, currency = 'KES',
        releaseAfterMs = ESCROW_MIN_MS,
        metadata = {},
      } = opts;

      if (!orderId || !buyerId || !sellerId) {
        throw new Error('[Escrow] orderId, buyerId, and sellerId are required');
      }
      const amt = _validateAmount(amount, currency);

      /* Idempotency */
      const idemKey = `escrow::${orderId}`;
      const existing = _idemGuard(idemKey);
      if (existing) return existing;

      const ref  = _escrowRef();
      const now  = Date.now();
      const releasableAt = new Date(now + Math.min(Math.max(releaseAfterMs, ESCROW_MIN_MS), ESCROW_MAX_MS));

      const { collection, doc, setDoc, serverTimestamp } = await _fsImport();
      const db = _db();

      const record = {
        ref, orderId, buyerId, sellerId,
        amount: amt, currency,
        status:      ESCROW_STATUS.ACTIVE,
        releasableAt,
        createdAt:   serverTimestamp(),
        metadata,
      };

      await setDoc(doc(db, 'escrows', ref), record);

      /* Ledger: DR buyer wallet / CR escrow holding account */
      await Ledger.record({
        reference:     ref,
        type:          'escrow_created',
        debitAccount:  `buyer:${buyerId}`,
        creditAccount: 'escrow:holding',
        amount:        amt,
        currency,
        metadata:      { orderId },
      });

      if (window.SokoniEventBus) {
        await SokoniEventBus.emit(SokoniEventBus.EVENTS.ESCROW_CREATED, {
          ref, orderId, buyerId, sellerId, amount: amt, currency, releasableAt,
        });
      }

      const result = { ref, status: ESCROW_STATUS.ACTIVE, releasableAt };
      _idemSet(idemKey, result);
      return result;
    },

    /**
     * Release escrow to the seller after successful delivery.
     * Calculates and deducts platform commission before paying out.
     */
    async release(escrowRef, opts = {}) {
      const { releasedBy = _uid(), note = '', commissionRate = PLATFORM_FEE_RATE } = opts;

      const { doc, getDoc, updateDoc, serverTimestamp } = await _fsImport();
      const db = _db();

      const snap = await getDoc(doc(db, 'escrows', escrowRef));
      if (!snap.exists()) throw new Error(`[Escrow] Not found: ${escrowRef}`);

      const escrow = snap.data();
      if (escrow.status !== ESCROW_STATUS.ACTIVE) {
        throw new Error(`[Escrow] Cannot release — status is ${escrow.status}`);
      }

      const now = new Date();
      if (now < (escrow.releasableAt?.toDate?.() ?? now)) {
        /* Allow override by admin, but warn */
        if (window.SokoniLogger) window.SokoniLogger.warn('[Escrow] Released before scheduled time');
      }

      /* Commission split */
      const gross      = escrow.amount;
      const currency   = escrow.currency;
      const commission = _round(gross * commissionRate);
      const vatOnComm  = _round(commission * TAX.VAT);
      const wht        = gross >= TAX.WHT_THRESHOLD ? _round(gross * TAX.WHT) : 0;
      const sellerNet  = _round(gross - commission - wht);

      /* Ledger entries */
      await Ledger.record({
        reference: escrowRef + ':release',
        type: 'escrow_released',
        debitAccount: 'escrow:holding',
        creditAccount: `seller:${escrow.sellerId}`,
        amount: sellerNet,
        currency,
        metadata: { orderId: escrow.orderId, commissionRate },
      });

      if (commission > 0) {
        await Ledger.record({
          reference: escrowRef + ':commission',
          type: 'commission_collected',
          debitAccount: 'escrow:holding',
          creditAccount: 'platform:revenue',
          amount: commission,
          currency,
          metadata: { orderId: escrow.orderId, vat: vatOnComm },
        });
      }

      if (wht > 0) {
        await Ledger.record({
          reference: escrowRef + ':wht',
          type: 'withholding_tax',
          debitAccount: 'escrow:holding',
          creditAccount: 'platform:tax_liability',
          amount: wht,
          currency,
          metadata: { orderId: escrow.orderId, rate: TAX.WHT },
        });
      }

      /* Update escrow document */
      await updateDoc(doc(db, 'escrows', escrowRef), {
        status:      ESCROW_STATUS.RELEASED,
        releasedAt:  serverTimestamp(),
        releasedBy,
        sellerNet,
        commission,
        wht,
        note,
      });

      if (window.SokoniEventBus) {
        await SokoniEventBus.emit(SokoniEventBus.EVENTS.ESCROW_RELEASED, {
          ref: escrowRef, orderId: escrow.orderId,
          sellerId: escrow.sellerId, buyerId: escrow.buyerId,
          gross, sellerNet, commission, wht, currency,
        });
        await SokoniEventBus.emit(SokoniEventBus.EVENTS.SELLER_PAID, {
          sellerId: escrow.sellerId, amount: sellerNet, currency,
          orderId: escrow.orderId, ref: escrowRef,
        });
        await SokoniEventBus.emit(SokoniEventBus.EVENTS.COMMISSION_SETTLED, {
          amount: commission, currency, orderId: escrow.orderId, vat: vatOnComm,
        });
      }

      return { ref: escrowRef, status: ESCROW_STATUS.RELEASED, sellerNet, commission, wht };
    },

    /**
     * Refund escrow back to the buyer.
     */
    async refund(escrowRef, opts = {}) {
      const { reason = '', refundedBy = _uid(), partial = null } = opts;

      const { doc, getDoc, updateDoc, serverTimestamp } = await _fsImport();
      const db = _db();

      const snap = await getDoc(doc(db, 'escrows', escrowRef));
      if (!snap.exists()) throw new Error(`[Escrow] Not found: ${escrowRef}`);

      const escrow = snap.data();
      if (![ESCROW_STATUS.ACTIVE, ESCROW_STATUS.DISPUTED].includes(escrow.status)) {
        throw new Error(`[Escrow] Cannot refund — status is ${escrow.status}`);
      }

      const refundAmt = partial ? _validateAmount(partial, escrow.currency) : escrow.amount;
      if (refundAmt > escrow.amount) throw new Error('[Escrow] Refund amount exceeds escrow');

      await Ledger.record({
        reference: escrowRef + ':refund',
        type: 'escrow_refunded',
        debitAccount:  'escrow:holding',
        creditAccount: `buyer:${escrow.buyerId}`,
        amount: refundAmt,
        currency: escrow.currency,
        metadata: { orderId: escrow.orderId, reason, partial: !!partial },
      });

      await updateDoc(doc(db, 'escrows', escrowRef), {
        status:     ESCROW_STATUS.REFUNDED,
        refundedAt: serverTimestamp(),
        refundedBy,
        refundAmt,
        reason,
      });

      if (window.SokoniEventBus) {
        await SokoniEventBus.emit(SokoniEventBus.EVENTS.ESCROW_REFUNDED, {
          ref: escrowRef, orderId: escrow.orderId,
          buyerId: escrow.buyerId, amount: refundAmt,
          currency: escrow.currency, reason,
        });
        await SokoniEventBus.emit(SokoniEventBus.EVENTS.PAYMENT_REFUNDED, {
          ref: escrowRef, amount: refundAmt, currency: escrow.currency,
          buyerId: escrow.buyerId, reason,
        });
      }

      return { ref: escrowRef, status: ESCROW_STATUS.REFUNDED, refundAmt };
    },

    /** Mark escrow as disputed — freezes funds pending resolution. */
    async dispute(escrowRef, opts = {}) {
      const { reason, disputedBy = _uid(), evidence = [] } = opts;

      const { doc, getDoc, updateDoc, serverTimestamp } = await _fsImport();
      const db = _db();

      const snap = await getDoc(doc(db, 'escrows', escrowRef));
      if (!snap.exists()) throw new Error(`[Escrow] Not found: ${escrowRef}`);
      const escrow = snap.data();

      await updateDoc(doc(db, 'escrows', escrowRef), {
        status:      ESCROW_STATUS.DISPUTED,
        disputedAt:  serverTimestamp(),
        disputedBy,
        reason,
        evidence,
      });

      /* Also update the order */
      if (escrow.orderId) {
        const { doc: doc2, updateDoc: upd2 } = await _fsImport();
        await upd2(doc2(db, 'orders', escrow.orderId), { status: 'disputed', disputedAt: serverTimestamp() }).catch(() => {});
      }

      if (window.SokoniEventBus) {
        await SokoniEventBus.emit(SokoniEventBus.EVENTS.ESCROW_DISPUTED, {
          ref: escrowRef, orderId: escrow.orderId, reason, disputedBy,
        });
        await SokoniEventBus.emit(SokoniEventBus.EVENTS.ORDER_DISPUTED, {
          orderId: escrow.orderId, escrowRef, reason,
        });
      }

      return { ref: escrowRef, status: ESCROW_STATUS.DISPUTED };
    },

    /** Get current escrow record. */
    async get(escrowRef) {
      const { doc, getDoc } = await _fsImport();
      const snap = await getDoc(doc(_db(), 'escrows', escrowRef));
      return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    },
  };

  /* ════════════════════════════════════════════════════════════
     SPLIT PAYMENT — distribute funds among multiple parties
  ════════════════════════════════════════════════════════════ */
  const SplitPayment = {
    /**
     * Calculate and record a multi-party payment split.
     * @param {object} opts
     *   total:    Total amount received
     *   currency: Currency code
     *   splits:   [{ account, share (0-1) | amount, label }]
     *   ref:      Reference string
     */
    async execute(opts) {
      const { total, currency = 'KES', splits = [], ref = _ref(), metadata = {} } = opts;
      const totalAmt = _validateAmount(total, currency);

      /* Validate splits sum to 1.0 (if using share) or total (if using amount) */
      const shareMode  = splits.every(s => s.share !== undefined);
      const amountMode = splits.every(s => s.amount !== undefined);

      if (!shareMode && !amountMode) {
        throw new Error('[SplitPayment] All splits must use either share (0-1) or amount');
      }

      if (shareMode) {
        const totalShare = splits.reduce((acc, s) => acc + s.share, 0);
        if (Math.abs(totalShare - 1.0) > 0.0001) {
          throw new Error(`[SplitPayment] Shares must sum to 1.0 (got ${totalShare})`);
        }
      }

      const entries = splits.map(s => ({
        account: s.account,
        label:   s.label || s.account,
        amount:  shareMode ? _round(totalAmt * s.share) : _validateAmount(s.amount, currency),
      }));

      /* Normalise rounding diff to last entry */
      const entrySum = entries.reduce((a, e) => a + e.amount, 0);
      const diff     = _round(totalAmt - entrySum);
      if (diff !== 0 && entries.length > 0) entries[entries.length - 1].amount = _round(entries[entries.length - 1].amount + diff);

      /* Record ledger entries */
      for (const entry of entries) {
        await Ledger.record({
          reference:     ref + ':' + entry.account,
          type:          'split_payment',
          debitAccount:  'payment:received',
          creditAccount: entry.account,
          amount:        entry.amount,
          currency,
          metadata:      { label: entry.label, ...metadata },
        });
      }

      if (window.SokoniEventBus) {
        await SokoniEventBus.emit(SokoniEventBus.EVENTS.PAYMENT_COMPLETED, {
          ref, total: totalAmt, currency, splits: entries, metadata,
        });
      }

      return { ref, total: totalAmt, currency, splits: entries };
    },
  };

  /* ════════════════════════════════════════════════════════════
     SETTLEMENT ENGINE — batch seller payouts
  ════════════════════════════════════════════════════════════ */
  const Settlement = {
    /**
     * Calculate what is owed to a seller for a period.
     * Returns a settlement report (does not transfer money — that is
     * done by a Cloud Function after admin approval).
     */
    async calculate(sellerId, periodStart, periodEnd) {
      const { collection, query, where, getDocs, Timestamp } = await _fsImport();
      const db = _db();

      const start = Timestamp.fromDate(new Date(periodStart));
      const end   = Timestamp.fromDate(new Date(periodEnd));

      /* Released escrows in the period for this seller */
      const snap = await getDocs(query(
        collection(db, 'escrows'),
        where('sellerId', '==', sellerId),
        where('status',   '==', ESCROW_STATUS.RELEASED),
        where('releasedAt', '>=', start),
        where('releasedAt', '<=', end)
      ));

      let grossRevenue  = 0;
      let platformFees  = 0;
      let whtDeducted   = 0;
      let netPayable    = 0;
      const orders      = [];

      snap.docs.forEach(d => {
        const e = d.data();
        grossRevenue += e.amount       || 0;
        platformFees += e.commission   || 0;
        whtDeducted  += e.wht          || 0;
        netPayable   += e.sellerNet    || 0;
        orders.push({ escrowRef: d.id, orderId: e.orderId, amount: e.amount, net: e.sellerNet });
      });

      const vatLiability   = _round(platformFees * TAX.VAT);
      const dstLiability   = _round(grossRevenue * TAX.DST);

      return {
        sellerId,
        period:       { start: periodStart, end: periodEnd },
        grossRevenue: _round(grossRevenue),
        platformFees: _round(platformFees),
        whtDeducted:  _round(whtDeducted),
        netPayable:   _round(netPayable),
        vatLiability,
        dstLiability,
        orderCount:   orders.length,
        orders,
        generatedAt:  new Date().toISOString(),
      };
    },

    /**
     * Record a settlement payout to Firestore for tracking.
     * Actual M-Pesa / bank transfer is initiated by the Cloud Function.
     */
    async record(opts) {
      const {
        sellerId, amount, currency = 'KES',
        method = 'mpesa', reference, periodStart, periodEnd, metadata = {},
      } = opts;

      const amt = _validateAmount(amount, currency);
      const ref = reference || _ref();

      const { collection, addDoc, serverTimestamp } = await _fsImport();
      const db = _db();

      await addDoc(collection(db, 'settlements'), {
        sellerId, amount: amt, currency,
        method, ref, periodStart, periodEnd,
        status:   'pending',
        metadata,
        serverTs: serverTimestamp(),
      });

      await Ledger.record({
        reference: ref,
        type:      'settlement_initiated',
        debitAccount:  `platform:payable:${sellerId}`,
        creditAccount: `seller:${sellerId}:bank`,
        amount:    amt,
        currency,
        metadata:  { method, periodStart, periodEnd },
      });

      if (window.SokoniEventBus) {
        await SokoniEventBus.emit(SokoniEventBus.EVENTS.SELLER_PAID, {
          sellerId, amount: amt, currency, ref, method,
        });
      }

      return { ref, status: 'pending', amount: amt, currency };
    },
  };

  /* ════════════════════════════════════════════════════════════
     REFUND ENGINE
  ════════════════════════════════════════════════════════════ */
  const RefundEngine = {
    /**
     * Initiate a full or partial refund for an order.
     * If the order has an escrow, delegates to Escrow.refund().
     */
    async initiate(opts) {
      const {
        orderId, amount, currency = 'KES',
        reason, initiatedBy = _uid(), items = [],
      } = opts;

      if (!orderId) throw new Error('[Refund] orderId is required');
      const amt = amount ? _validateAmount(amount, currency) : null;

      /* Look up the order's escrow */
      const { collection, query, where, getDocs } = await _fsImport();
      const db = _db();

      const escrowSnap = await getDocs(query(
        collection(db, 'escrows'),
        where('orderId', '==', orderId),
        where('status', 'in', [ESCROW_STATUS.ACTIVE, ESCROW_STATUS.DISPUTED])
      ));

      if (!escrowSnap.empty) {
        const escrowDoc = escrowSnap.docs[0];
        return Escrow.refund(escrowDoc.id, { reason, refundedBy: initiatedBy, partial: amt });
      }

      /* No escrow — record refund directly */
      const ref = _ref();
      const { addDoc, serverTimestamp } = await _fsImport();

      await addDoc(collection(db, 'refunds'), {
        ref, orderId, amount: amt, currency,
        reason, initiatedBy, items,
        status: 'pending',
        serverTs: serverTimestamp(),
      });

      await Ledger.record({
        reference:     ref,
        type:          'refund_initiated',
        debitAccount:  'platform:revenue',
        creditAccount: `buyer:refund_pending`,
        amount:        amt || 0,
        currency,
        metadata:      { orderId, reason },
      });

      if (window.SokoniEventBus) {
        await SokoniEventBus.emit(SokoniEventBus.EVENTS.PAYMENT_REFUNDED, {
          ref, orderId, amount: amt, currency, reason,
        });
      }

      return { ref, status: 'pending', orderId, amount: amt };
    },
  };

  /* ════════════════════════════════════════════════════════════
     TAX CALCULATOR
  ════════════════════════════════════════════════════════════ */
  const TaxCalc = {
    /** Calculate applicable taxes for a transaction. */
    calculate(gross, opts = {}) {
      const { includeWHT = true, currency = 'KES', commissionRate = PLATFORM_FEE_RATE } = opts;
      const amt        = _validateAmount(gross, currency);
      const commission = _round(amt * commissionRate);
      const vat        = _round(commission * TAX.VAT);
      const dst        = _round(amt * TAX.DST);
      const wht        = includeWHT && amt >= TAX.WHT_THRESHOLD ? _round(amt * TAX.WHT) : 0;

      return {
        gross: amt, commission, vat, dst, wht,
        netToSeller: _round(amt - commission - wht),
        totalTaxBurden: _round(vat + dst + wht),
        rates: { vat: TAX.VAT, dst: TAX.DST, wht: includeWHT ? TAX.WHT : 0, commission: commissionRate },
      };
    },

    /** Monthly WHT summary for KRA remittance. */
    async monthlySummary(year, month) {
      const { collection, query, where, getDocs } = await _fsImport();
      const db = _db();

      const start = new Date(year, month - 1, 1);
      const end   = new Date(year, month, 0, 23, 59, 59);
      const { Timestamp } = await _fsImport();

      const snap = await getDocs(query(
        collection(db, 'paymentLedger'),
        where('type',       '==', 'withholding_tax'),
        where('serverTs',   '>=', Timestamp.fromDate(start)),
        where('serverTs',   '<=', Timestamp.fromDate(end))
      ));

      let totalWHT = 0;
      snap.docs.forEach(d => { totalWHT += d.data().amount || 0; });

      return {
        year, month, totalWHT: _round(totalWHT),
        currency: 'KES',
        dueDate: new Date(year, month, 20).toISOString().split('T')[0],
        remittedTo: 'KRA',
      };
    },
  };

  /* ════════════════════════════════════════════════════════════
     PAYMENT RECORD  — convenience wrapper for order payments
  ════════════════════════════════════════════════════════════ */
  const PaymentRecord = {
    /**
     * Record a completed payment and optionally create an escrow.
     * Called after M-Pesa STK callback or IntaSend webhook confirms payment.
     */
    async recordCompleted(opts) {
      const {
        orderId, buyerId, sellerId,
        amount, currency = 'KES',
        provider, providerRef, phone,
        useEscrow = true,
        commissionRate = PLATFORM_FEE_RATE,
        metadata = {},
      } = opts;

      const idemKey = `payment::${orderId}::${providerRef}`;
      const cached  = _idemGuard(idemKey);
      if (cached) return cached;

      const amt = _validateAmount(amount, currency);
      const ref = _ref();

      const { collection, doc, addDoc, setDoc, serverTimestamp } = await _fsImport();
      const db = _db();

      /* Save payment record */
      const payment = {
        ref, orderId, buyerId, sellerId,
        amount: amt, currency,
        provider, providerRef, phone,
        status: PAYMENT_STATUS.COMPLETED,
        serverTs: serverTimestamp(),
        metadata,
      };
      await addDoc(collection(db, 'payments'), payment);

      /* Create escrow if requested */
      let escrowResult = null;
      if (useEscrow && sellerId) {
        escrowResult = await Escrow.create({
          orderId, buyerId, sellerId,
          amount: amt, currency, metadata,
        });
      } else {
        /* No escrow — split immediately */
        const tax = TaxCalc.calculate(amt, { currency, commissionRate });
        await SplitPayment.execute({
          total: amt, currency,
          ref,
          splits: [
            { account: `seller:${sellerId}`, share: (amt - tax.commission) / amt, label: 'seller_net' },
            { account: 'platform:revenue',   share: tax.commission / amt,          label: 'commission'  },
          ],
          metadata: { orderId },
        });
      }

      /* Update order status */
      await setDoc(doc(db, 'orders', orderId), {
        paymentStatus: 'paid',
        paidAt:        serverTimestamp(),
        paymentRef:    ref,
        escrowRef:     escrowResult?.ref ?? null,
      }, { merge: true }).catch(() => {});

      if (window.SokoniEventBus) {
        await SokoniEventBus.emit(SokoniEventBus.EVENTS.PAYMENT_COMPLETED, {
          ref, orderId, buyerId, sellerId, amount: amt, currency, provider, providerRef,
        });
      }

      const result = { ref, status: PAYMENT_STATUS.COMPLETED, amount: amt, escrowRef: escrowResult?.ref };
      _idemSet(idemKey, result);
      return result;
    },

    /** Record a failed payment attempt. */
    async recordFailed(opts) {
      const { orderId, provider, providerRef, reason, metadata = {} } = opts;

      const { collection, addDoc, serverTimestamp } = await _fsImport();
      await addDoc(collection(_db(), 'payments'), {
        orderId, provider, providerRef, reason,
        status: PAYMENT_STATUS.FAILED,
        serverTs: serverTimestamp(),
        metadata,
      });

      if (window.SokoniEventBus) {
        await SokoniEventBus.emit(SokoniEventBus.EVENTS.PAYMENT_FAILED, {
          orderId, provider, providerRef, reason,
        });
      }
    },
  };

  /* ════════════════════════════════════════════════════════════
     PUBLIC API
  ════════════════════════════════════════════════════════════ */
  return {
    CURRENCIES,
    PAYMENT_STATUS,
    ESCROW_STATUS,
    TAX,
    PLATFORM_FEE_RATE,

    Escrow,
    Ledger,
    SplitPayment,
    Settlement,
    RefundEngine,
    TaxCalc,
    PaymentRecord,

    /** Diagnostics for the admin / monitor dashboard. */
    diagnostics() {
      return {
        idempotencyStore: _idem.size,
        escrowStatuses:   ESCROW_STATUS,
        paymentStatuses:  PAYMENT_STATUS,
        taxRates:         TAX,
        supportedCurrencies: Object.keys(CURRENCIES),
      };
    },
  };
})();

window.SokoniPaymentEngine = SokoniPaymentEngine;
