'use strict';
/**
 * SOKONI — ORDER → TAX SOURCE RECORD
 *
 * The bridge between a settled marketplace order and the tax engine.
 *
 * ── WHY THIS IS NOT "WALLET BALANCE × RATE" ───────────────────────────────────────────────
 * A settled order produces THREE distinct economic facts, and collapsing them loses the two
 * that matter most:
 *
 *     grossSale          10,000   what the customer paid          (the taxable supply)
 *     platformCommission  1,500   what SOKONI charged the seller  (a separate supply, and
 *                                 an expense in the merchant's books)
 *     merchantProceeds    8,500   what reached the merchant
 *
 * `merchantProceeds` is a CASH position, not a tax basis. VAT works on output tax less
 * allowable input tax, so the merchant's output tax follows the GROSS supply, while the
 * commission is a separate service supplied TO them — potentially carrying its own treatment
 * and its own invoice. Income tax follows accounting profit, which is neither figure.
 *
 * So this module records all three, plus the discounts and refunds that move them, and
 * declares NO tax. Each obligation derives its own basis from these facts in the tax engine.
 *
 * ── IT NEVER CALCULATES A TAX ─────────────────────────────────────────────────────────────
 * There is no rate in this file, and there must never be one. A settled payment does not mean
 * a tax amount exists: if no approved rule set prices the period, the obligation stays
 * `calculated: null` with a stated reason. Recording a figure here would manufacture the very
 * number the engine refuses to guess.
 *
 * ── IT FAILS CLOSED ON IDENTITY ───────────────────────────────────────────────────────────
 * The taxpayer is the BUSINESS. A record keyed on an auth uid would file one person's tax
 * against another's books, so an unresolved or uid-shaped identity produces a refusal and a
 * reconcilable pending state — never a record attributed to a guess.
 */

const REASON = {
  NO_ORDER:        'an-order-id-is-required',
  UID_SHAPED:      'the-taxpayer-is-the-business-not-the-person',
  NO_BUSINESS:     'no-business-resolved-for-this-settlement',
  NOT_RECONCILED:  'gross-does-not-equal-commission-plus-net-plus-adjustments',
  BAD_AMOUNT:      'amounts-must-be-whole-numbers-of-cents',
};

class TaxSourceError extends Error {
  constructor(reason, message, detail) { super(message || reason); this.reason = reason; this.detail = detail || null; }
}

const _int = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};

/** The tax period a settlement falls in. Monthly, from the settlement instant, UTC. */
function periodKeyFor(dateish) {
  const d = dateish ? new Date(dateish) : new Date();
  if (!isFinite(d.getTime())) return null;
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

/**
 * Build the record. PURE — no database, no clock beyond what is passed in, so the reconciliation
 * invariant can be tested directly rather than inferred from a written document.
 */
function buildTaxSource(input) {
  const i = input || {};
  const orderId = String(i.orderId || '');
  if (!orderId) throw new TaxSourceError(REASON.NO_ORDER, 'orderId is required.');

  const businessId = String(i.businessId || '');
  const sellerUid = String(i.sellerUid || '');
  if (!businessId) {
    throw new TaxSourceError(REASON.NO_BUSINESS,
      'This settlement has no resolved business. The taxpayer is the business, so the record '
      + 'is withheld rather than attributed to a guess.', { orderId });
  }
  if (sellerUid && businessId === sellerUid) {
    throw new TaxSourceError(REASON.UID_SHAPED,
      'businessId equals the seller auth uid. A tax record keyed on a person would file one '
      + "individual's tax against a business's books.", { orderId, businessId });
  }

  const grossMinor = _int(i.grossMinor);
  const commissionMinor = _int(i.commissionMinor);
  const merchantNetMinor = _int(i.merchantNetMinor);
  const discountMinor = _int(i.discountMinor);
  const refundMinor = _int(i.refundMinor);
  const otherAdjustmentsMinor = _int(i.otherAdjustmentsMinor);

  /* ── THE RECONCILIATION INVARIANT ────────────────────────────────────────────────────
     gross = commission + merchantNet + explicit other adjustments.

     Checked HERE, at the point the facts are captured, because a record that does not
     balance is a record of money that went somewhere nobody named. Reporting it later from
     the ledger would find the same discrepancy a period after it could be corrected. */
  const accounted = commissionMinor + merchantNetMinor + otherAdjustmentsMinor;
  if (grossMinor !== accounted) {
    throw new TaxSourceError(REASON.NOT_RECONCILED,
      'gross ' + grossMinor + ' != commission ' + commissionMinor + ' + net ' + merchantNetMinor
      + ' + adjustments ' + otherAdjustmentsMinor + ' (= ' + accounted + '). '
      + 'Money would be unaccounted for between the payment and the merchant.',
      { orderId, grossMinor, commissionMinor, merchantNetMinor, otherAdjustmentsMinor, accounted });
  }

  /* THE TAXABLE SUPPLY IS THE GROSS SALE, NET OF DISCOUNTS GIVEN — never the merchant's
     proceeds. The commission is a supply SOKONI makes to the merchant; it does not reduce
     what the merchant supplied to the customer. */
  const taxableSupplyMinor = grossMinor - discountMinor - refundMinor;

  return {
    kind: 'marketplaceOrder',
    orderId,
    /* identity — the canonical chain, never a browser-supplied id */
    businessId,
    storeId: i.storeId ? String(i.storeId) : null,
    sellerUid: sellerUid || null,

    /* the three facts, kept separate */
    grossMinor,
    platformCommissionMinor: commissionMinor,
    merchantProceedsMinor: merchantNetMinor,

    /* movements that change a basis */
    discountMinor,
    refundMinor,
    otherAdjustmentsMinor,

    /* DERIVED, and deliberately not merchantProceeds */
    taxableSupplyMinor,

    /* The plan that priced the commission, recorded so a rate can be explained later rather
       than recomputed against whatever the catalogue says at the time of the question. */
    plan: i.plan || null,
    commissionRatePct: i.commissionRatePct == null ? null : Number(i.commissionRatePct),
    commissionRuleSource: i.commissionRuleSource || null,

    /* NEVER a rate, NEVER an amount. The engine decides, from an approved rule set. */
    taxTreatment: i.taxTreatment || null,

    /* evidence */
    currency: 'KES',
    invoiceRef: i.invoiceRef || null,
    receiptRef: i.receiptRef || null,
    paymentRef: i.paymentRef || null,
    paymentProvider: 'intasend',
    commissionInvoiceRef: i.commissionInvoiceRef || null,
    ledgerRefs: Array.isArray(i.ledgerRefs) ? i.ledgerRefs.slice(0, 20) : [],

    periodKey: i.periodKey || periodKeyFor(i.settledAt),
    settledAt: i.settledAt || null,
    reversalOf: i.reversalOf || null,

    note: 'Economic facts only. No tax is calculated here; each obligation derives its own '
        + 'basis from these figures.',
  };
}

/**
 * The REVERSAL of a settled order.
 *
 * Not a new negative sale — a linked reversal. The distinction is the audit trail: an
 * unrelated negative row nets the period to the right total while leaving nobody able to say
 * which sale was refunded, which commission was returned, or which tax basis moved.
 */
function buildReversal(original, opts) {
  const o = opts || {};
  if (!original || !original.orderId) throw new TaxSourceError(REASON.NO_ORDER, 'the original record is required');
  const src = buildTaxSource({
    orderId: original.orderId,
    businessId: original.businessId,
    storeId: original.storeId,
    sellerUid: original.sellerUid,
    /* Every leg reverses together. A refund that returned the merchant's proceeds but kept
       the commission would leave the platform holding a fee for a sale that did not happen. */
    grossMinor: -_int(original.grossMinor),
    commissionMinor: -_int(original.platformCommissionMinor),
    merchantNetMinor: -_int(original.merchantProceedsMinor),
    otherAdjustmentsMinor: -_int(original.otherAdjustmentsMinor),
    discountMinor: -_int(original.discountMinor),
    plan: original.plan,
    commissionRatePct: original.commissionRatePct,
    commissionRuleSource: original.commissionRuleSource,
    invoiceRef: original.invoiceRef,
    paymentRef: o.refundRef || original.paymentRef,
    periodKey: o.periodKey || original.periodKey,
    settledAt: o.reversedAt || null,
  });
  src.kind = 'marketplaceOrderReversal';
  src.reversalOf = original.orderId;
  src.reason = o.reason || null;
  return src;
}

/**
 * Write it. Idempotent by DETERMINISTIC DOCUMENT ID — a duplicate IntaSend webhook delivery
 * produces exactly one record, because the id is decided by the order, not by a flag someone
 * has to remember to read.
 */
async function recordTaxSource(db, record) {
  const id = record.kind === 'marketplaceOrderReversal'
    ? record.orderId + '__reversal'
    : record.orderId;
  const ref = db.collection('taxSourceRecords').doc(id);
  const snap = await ref.get();
  if (snap.exists) return { written: false, idempotent: true, id };
  await ref.set(Object.assign({}, record, { recordedAt: new Date().toISOString() }));
  return { written: true, idempotent: false, id };
}

module.exports = {
  REASON, TaxSourceError,
  periodKeyFor, buildTaxSource, buildReversal, recordTaxSource,
};
