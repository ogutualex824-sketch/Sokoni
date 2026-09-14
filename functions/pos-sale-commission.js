'use strict';
/**
 * SOKONI — POS & TILL SALE COMMISSION (pure composition)
 * functions/pos-sale-commission.js
 *
 * STATUS: **NOT INTEGRATED, NOT DEPLOYED.** Nothing calls this.
 *
 * The link that was missing: a sale in, a commission liability out, stamped with the
 * settlement day the 07:00 gate collects on. `planSaleAccounting()` said how much and where
 * it sits; `evaluateGate()` said when it becomes collectible; nothing joined them, so the
 * gate had no source to read.
 *
 * ── ONE AUTHORITY, TWO RAILS ────────────────────────────────────────────────────────
 * POS and Till are the same commercial surface and are charged identically. The rail
 * decides only CUSTODY — who is holding the money — never the rate and never whether a
 * commission exists at all.
 *
 *     POS cash            NON_CUSTODIAL   merchant holds it   -> liability
 *     POS M-PESA STK      CUSTODIAL       SOKONI holds it     -> deducted, net credited
 *     POS SOKONI Wallet   CUSTODIAL       SOKONI holds it     -> deducted, net credited
 *     POS store credit    NON_CUSTODIAL   merchant issued it  -> liability
 *     TILL (direct)       NON_CUSTODIAL   paid to the merchant's own till -> liability
 *
 * ── WHAT THIS CLOSES ────────────────────────────────────────────────────────────────
 * The Till rail (`DIRECT_TO_SELLER`) was recorded as "commission never collected", and
 * index.js states the consequence in its own words: the seller receives 100% while the
 * ledger records a commission that was never collected. A liability with no collection
 * mechanism is not a receivable, it is a note-to-self. The 07:00 gate is that mechanism, and
 * Till belongs inside it for exactly the same reason cash does: SOKONI never touched the
 * money, so the commission can only ever be a debt.
 *
 * ── CALCULATED AT THE SALE, COLLECTED AT 07:00 ──────────────────────────────────────
 * The rate is resolved and frozen when the sale happens. It is NOT recomputed at collection
 * time: a merchant who upgrades on Tuesday must not have Monday's commission silently
 * repriced, in either direction. The resolved rate and its provenance travel on the ledger
 * row so a receipt or an audit can explain the charge months later.
 */

const MA = require('./money-authority');
const CC = require('./commission-config');
const S = require('./commission-settlement-authority');

/* Which POS/Till tender each rail represents. Everything here is priced on the POS lane —
   these differ only in who ends up holding the cash. */
const RAIL = {
  POS_CASH:         { method: 'cash',          surface: 'POS'  },
  POS_MPESA_STK:    { method: 'mpesa_stk',     surface: 'POS'  },
  POS_WALLET:       { method: 'sokoni_wallet', surface: 'POS'  },
  POS_STORE_CREDIT: { method: 'store_credit',  surface: 'POS'  },
  POS_CARD:         { method: 'card',          surface: 'POS'  },
  TILL_DIRECT:      { method: 'mpesa_direct',  surface: 'TILL' }
};

class SaleCommissionError extends Error {
  constructor (code, message, detail) { super(message); this.code = code; this.detail = detail || null; }
}

/**
 * Turn one sale into its commission consequence.
 *
 * @param {object} p
 * @param {string} p.rail          a key of RAIL
 * @param {object} p.gross         Money
 * @param {string} p.planId        the merchant's seller plan
 * @param {number} p.soldAtMs      when the sale happened — decides the settlement day
 * @param {string} p.saleId
 * @param {string} p.merchantUid
 * @returns {object} a ledger-ready record plus, for custodial rails, the net credit
 */
function planSaleCommission ({ rail, gross, planId, soldAtMs, saleId, merchantUid }) {
  const spec = RAIL[rail];
  if (!spec) {
    /* Fails closed: an unrecognised rail is not quietly treated as cash or as custodial.
       Either guess mis-books the money, and the wrong one is unrecoverable. */
    throw new SaleCommissionError('SALE_UNKNOWN_RAIL',
      'Rail "' + rail + '" is not a recognised POS or Till tender. Classify it deliberately.',
      { known: Object.keys(RAIL) });
  }
  if (!saleId || !merchantUid) {
    throw new SaleCommissionError('SALE_UNIDENTIFIED',
      'saleId and merchantUid are required — a liability nobody owns cannot be collected.');
  }
  if (!gross || typeof gross.minorUnits !== 'number') {
    throw new SaleCommissionError('SALE_NO_GROSS', 'gross must be Money');
  }
  if (gross.minorUnits < 0) {
    throw new SaleCommissionError('SALE_NEGATIVE_GROSS', 'A sale cannot be negative');
  }

  const custody = MA.classifyCustody(spec.method);      /* throws on an unclassified method */
  const rate = CC.resolvePosRate(planId);               /* rate + floor policy + provenance */

  const booking = MA.planSaleAccounting({
    gross,
    rateFraction: rate.rateFraction,
    custody,
    minimumMinor: CC.MIN_COMMISSION_KES * MA.MINOR_PER_MAJOR,
    floorExempt: rate.floorExempt
  });

  const settlementDay = S.settlementDayFor(soldAtMs);

  return {
    /* identity */
    saleId, merchantUid, rail, surface: spec.surface, method: spec.method,

    /* money — every figure derived, none defaulted */
    gross: booking.gross,
    commission: booking.commission,
    net: booking.net,
    merchantCredit: booking.merchantCredit,
    liability: booking.liability,
    currency: gross.currency,

    /* why it was charged what it was — frozen at the sale, never recomputed at collection */
    custody,
    plan: rate.plan,
    rateFraction: rate.rateFraction,
    floorExempt: rate.floorExempt,
    floorApplied: booking.floorApplied,
    rateSource: rate.source,
    rateMatched: rate.matched,

    /* when the 07:00 gate will collect it */
    settlementDay,
    collectibleAtMs: S.gateClosesAt(settlementDay),
    soldAtMs,

    /* what the caller must write, stated rather than inferred */
    walletCredit: MA.isPositive(booking.merchantCredit) ? booking.merchantCredit : null,
    createsLiability: MA.isPositive(booking.liability)
  };
}

/**
 * Roll a day's sales into the per-day outstanding figures `evaluateGate()` consumes.
 *
 * Only NON-CUSTODIAL sales create a collectible liability. A custodial sale's commission was
 * already taken out of money SOKONI was holding — billing it again at 07:00 would charge the
 * merchant twice for one sale, and it would look like diligence rather than a defect.
 */
function summariseLiability (records) {
  if (!Array.isArray(records)) {
    throw new SaleCommissionError('SUMMARY_NOT_A_LIST', 'records must be an array');
  }
  const byDay = new Map();
  let creditedTotal = 0;
  for (const r of records) {
    if (!r || typeof r.settlementDay !== 'string' || !r.liability) {
      throw new SaleCommissionError('SUMMARY_UNREADABLE_RECORD',
        'A sale record is unreadable. Refusing to summarise a partial day.', { record: r });
    }
    if (r.merchantCredit) creditedTotal += r.merchantCredit.minorUnits;
    if (r.liability.minorUnits <= 0) continue;
    byDay.set(r.settlementDay, (byDay.get(r.settlementDay) || 0) + r.liability.minorUnits);
  }
  const unpaid = Array.from(byDay.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([settlementDay, minorUnits]) => ({
      settlementDay, outstanding: MA.fromMinor(minorUnits)
    }));
  return {
    unpaid,
    totalLiability: MA.fromMinor(unpaid.reduce((s, u) => s + u.outstanding.minorUnits, 0)),
    totalCredited: MA.fromMinor(creditedTotal)
  };
}

module.exports = { RAIL, SaleCommissionError, planSaleCommission, summariseLiability };
