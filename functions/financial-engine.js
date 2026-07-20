'use strict';
/**
 * SOKONI Financial Engine — one place where a confirmed payment becomes
 * financial records.
 *
 * WHY THIS EXISTS
 * An audit of the payment-confirmation paths found that nothing generated an
 * invoice, a receipt, a journal entry or a tax record when money arrived. The
 * modules all existed and were deployed; every one was gated behind a client
 * callable, an admin action, or an order status the payment paths never write.
 * The system recorded THAT money arrived and WHAT commission was owed, and
 * produced no customer-facing document and no accounting entry.
 *
 * It also found four ledger writers across two unit systems, three invoice
 * generators and three receipt generators, none cross-referenced. This engine
 * is the single subscriber to a confirmed payment. It does not replace those
 * modules; it becomes the one thing a payment path calls, so the others can be
 * retired against a working reference rather than all at once.
 *
 * DESIGN RULES
 * - Idempotent by construction. Every document id is derived from the payment
 *   reference, so a webhook retry rewrites the same rows instead of creating
 *   duplicates. A replayed payment produces zero additional financial effect.
 * - Sequential document numbers. Random ids do not satisfy an auditor and
 *   every existing generator used them. Numbers come from a transactional
 *   counter: SKN-INV-2026-000001.
 * - Immutable. Documents are created, never updated. A correction is a credit
 *   note plus a replacement, which preserves the trail.
 * - Never throws into the payment path. Money has already moved; a failure to
 *   generate paperwork must be recorded and retried, not surfaced as a payment
 *   failure. All errors land in financialEngineFailures for reconciliation.
 * - Tax is configuration, not code. Rates come from _systemConfig/tax so a VAT
 *   change is a document edit, not a deployment.
 */
const admin = require('firebase-admin');
const logger = require('firebase-functions/logger');
const timeline = require('./payment-timeline');

const db = () => admin.firestore();
const FV = () => admin.firestore.FieldValue;

/* Default tax config. Overridden by _systemConfig/tax at runtime so rates can
   change without a deploy — Kenyan VAT has moved before and will again. */
const TAX_DEFAULTS = {
  vatRatePct: 16,
  vatInclusive: true,   /* Kenyan consumer prices are quoted VAT-inclusive */
  currency: 'KES',
};

async function _taxConfig() {
  try {
    const snap = await db().collection('_systemConfig').doc('tax').get();
    return snap.exists ? { ...TAX_DEFAULTS, ...snap.data() } : TAX_DEFAULTS;
  } catch (e) {
    logger.warn('[fin] tax config unreadable, using defaults', { err: e.message });
    return TAX_DEFAULTS;
  }
}

/**
 * Sequential document numbers, transactionally.
 *
 * Two payments confirming in the same instant must not receive the same
 * invoice number, so the counter is read and written inside a transaction.
 * Format SKN-INV-2026-000001: prefix, document class, year, zero-padded
 * sequence. The year resets the sequence, which is what accountants expect.
 */
async function _nextNumber(kind /* 'INV' | 'RCT' | 'CRN' */) {
  const year = new Date().getUTCFullYear();
  const counterRef = db().collection('_counters').doc(`${kind}-${year}`);

  const seq = await db().runTransaction(async (txn) => {
    const snap = await txn.get(counterRef);
    const next = ((snap.exists && Number(snap.data().value)) || 0) + 1;
    txn.set(counterRef, { value: next, kind, year, updatedAt: FV().serverTimestamp() }, { merge: true });
    return next;
  });

  return `SKN-${kind}-${year}-${String(seq).padStart(6, '0')}`;
}

/**
 * Split a gross amount into taxable base and VAT.
 * Inclusive is the Kenyan default: KES 499 already contains the VAT.
 */
function _splitTax(grossKES, cfg) {
  const rate = Number(cfg.vatRatePct) || 0;
  if (rate <= 0) return { taxable: grossKES, vat: 0, rate };
  if (cfg.vatInclusive) {
    const taxable = grossKES / (1 + rate / 100);
    return { taxable: Math.round(taxable * 100) / 100, vat: Math.round((grossKES - taxable) * 100) / 100, rate };
  }
  const vat = Math.round(grossKES * (rate / 100) * 100) / 100;
  return { taxable: grossKES, vat, rate };
}

/**
 * recordConfirmedPayment — the single entry point.
 *
 * Called from a payment-confirmation path AFTER the provider has confirmed and
 * the order/subscription has been marked paid. Safe to call more than once
 * with the same ref.
 *
 * @param {object} p
 * @param {string} p.ref            payment reference — the idempotency key
 * @param {number} p.amountKES      gross amount actually collected
 * @param {string} p.uid            payer
 * @param {string} [p.sellerUid]    counterparty, when the sale has one
 * @param {string} [p.description]  line description
 * @param {string} [p.method]       'mpesa' | 'card' | ...
 * @param {string} [p.providerRef]  M-Pesa receipt / IntaSend invoice id
 * @param {string} [p.orderId]
 * @param {string} [p.planId]       for subscriptions
 * @param {string} [p.source]       which path called us, for tracing
 */
async function recordConfirmedPayment(p) {
  const ref = String(p && p.ref || '').trim();
  if (!ref) { logger.error('[fin] recordConfirmedPayment called with no ref'); return { ok: false, reason: 'no-ref' }; }

  const gross = Math.round(Number(p.amountKES) * 100) / 100;
  if (!Number.isFinite(gross) || gross <= 0) {
    logger.error('[fin] invalid amount', { ref, amountKES: p.amountKES });
    return { ok: false, reason: 'bad-amount' };
  }

  /* Idempotency gate. One document per payment reference, created not set, so
     a concurrent retry loses the race cleanly instead of double-writing. */
  const docRef = db().collection('financialDocuments').doc(ref);
  try {
    const existing = await docRef.get();
    if (existing.exists) {
      logger.info('[fin] already recorded — replay ignored', { ref, invoiceNo: existing.data().invoiceNo });
      return { ok: true, replay: true, invoiceNo: existing.data().invoiceNo, receiptNo: existing.data().receiptNo };
    }
  } catch (e) {
    logger.warn('[fin] idempotency read failed, continuing', { ref, err: e.message });
  }

  try {
    const cfg = await _taxConfig();
    const { taxable, vat, rate } = _splitTax(gross, cfg);

    const invoiceNo = await _nextNumber('INV');
    const receiptNo = await _nextNumber('RCT');
    const now = FV().serverTimestamp();

    const common = {
      ref,
      uid:         p.uid || null,
      sellerUid:   p.sellerUid || null,
      orderId:     p.orderId || null,
      planId:      p.planId || null,
      description: p.description || 'SOKONI payment',
      method:      p.method || 'mpesa',
      providerRef: p.providerRef || null,
      currency:    cfg.currency || 'KES',
      source:      p.source || 'unknown',
    };

    const batch = db().batch();

    /* 1. Tax invoice — immutable, sequential. */
    batch.create(docRef, {
      ...common,
      invoiceNo, receiptNo,
      grossAmount:   gross,
      taxableAmount: taxable,
      vatAmount:     vat,
      vatRatePct:    rate,
      vatInclusive:  !!cfg.vatInclusive,
      status:        'issued',
      issuedAt:      now,
      createdAt:     now,
    });

    /* 2. Receipt — only ever written after confirmation, so its existence is
          itself evidence the money arrived. */
    batch.create(db().collection('financialReceipts').doc(ref), {
      ...common,
      receiptNo, invoiceNo,
      amountReceived: gross,
      paidAt:         now,
      createdAt:      now,
    });

    /* 3. Double-entry journal. Deterministic ids so a retry overwrites the
          same two legs rather than unbalancing the book. Debit what came in,
          credit revenue and the VAT owed to KRA. */
    const jBase = `${ref}-`;
    batch.create(db().collection('financialJournal').doc(jBase + 'dr-cash'), {
      ref, invoiceNo, entry: 'debit', account: 'CASH', amount: gross,
      currency: common.currency, postedAt: now, source: common.source,
    });
    batch.create(db().collection('financialJournal').doc(jBase + 'cr-revenue'), {
      ref, invoiceNo, entry: 'credit', account: 'REVENUE', amount: taxable,
      currency: common.currency, postedAt: now, source: common.source,
    });
    if (vat > 0) {
      batch.create(db().collection('financialJournal').doc(jBase + 'cr-vat'), {
        ref, invoiceNo, entry: 'credit', account: 'VAT_PAYABLE', amount: vat,
        currency: common.currency, postedAt: now, source: common.source,
      });
    }

    /* 4. Tax ledger — the row a KRA return is built from. Flat and queryable
          by period on purpose; a reporting job should not have to join. */
    batch.create(db().collection('taxLedger').doc(ref), {
      ...common,
      invoiceNo,
      invoiceDate:   now,
      vatRatePct:    rate,
      vatAmount:     vat,
      taxableAmount: taxable,
      grossAmount:   gross,
      netAmount:     taxable,
      period:        new Date().toISOString().slice(0, 7),   /* YYYY-MM */
      status:        'recorded',
      createdAt:     now,
    });

    await batch.commit();

    timeline.mark(ref, 'financial_records_written', { invoiceNo, receiptNo, gross, vat });

    logger.info('[fin] recorded', {
      ref, invoiceNo, receiptNo, gross, vat, source: common.source,
    });
    return { ok: true, invoiceNo, receiptNo, gross, vat, taxable };

  } catch (e) {
    /* Money has already moved. Paperwork failure must never surface as a
       payment failure, so it is queued for reconciliation instead. */
    logger.error('[fin] FAILED to record confirmed payment', { ref, err: e && e.message });
    timeline.fail(ref, 'financial_records_failed: ' + ((e && e.message) || 'unknown'));
    try {
      await db().collection('financialEngineFailures').doc(ref).set({
        ref, amountKES: gross, uid: p.uid || null, source: p.source || null,
        error: (e && e.message) || 'unknown',
        attempts: FV().increment(1),
        lastAttemptAt: FV().serverTimestamp(),
      }, { merge: true });
    } catch (_) { /* nothing further we can do here */ }
    return { ok: false, reason: 'write-failed' };
  }
}

module.exports = { recordConfirmedPayment, _splitTax, _nextNumber, TAX_DEFAULTS };
