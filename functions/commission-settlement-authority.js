'use strict';
/**
 * SOKONI — POS COMMISSION SETTLEMENT AUTHORITY (pure core)
 * functions/commission-settlement-authority.js
 *
 * STATUS: **NOT INTEGRATED, NOT DEPLOYED.** Nothing calls this; it is not exported from
 * functions/index.js. No POS operation is gated by it yet.
 *
 * ── THE RULE (D4b, superseding the 48-hour term) ────────────────────────────────────
 * POS commission settles DAILY. At 07:00 each settlement day the gate closes on unpaid POS
 * commission: outstanding liability must be settled through an authorised payment or the
 * merchant's SOKONI BUSINESS wallet before POS operations continue.
 *
 * ── WHY THIS IS A PREDICATE, NOT A SCHEDULED JOB ────────────────────────────────────
 * A scheduler can only open and close a cycle. If the rule lived only in the scheduler, a
 * merchant could call an older POS callable directly and transact straight past it. So the
 * boundary is computed from the clock on every operation, and the scheduler becomes an
 * optimisation — it can pre-compute and notify, but it is never the thing that decides.
 *
 * ── WHY REPLACING THE 48-HOUR MODEL COSTS NOTHING ───────────────────────────────────
 * Measured in production 2026-09-02, before writing any of this:
 *   sellerRestrictions   0 rows   — the restriction lifecycle has never fired
 *   commissionLedger    11 rows   — NONE carry `billingModel` or `collectionStatus`,
 *                                   so PER_SALE_48H has never written a production row
 *   commissionLedger     0 rows with category 'pos' — despite 5 posRetailSales
 * The 48-hour machinery is built and unexercised, and POS commission has never been recorded
 * at all. There is no population to migrate, and this gate would be the first commission
 * enforcement POS has ever had.
 *
 * ── TWO WALLETS, NEVER CROSSED ──────────────────────────────────────────────────────
 * A merchant's liability is settled from the BUSINESS wallet. A buyer's personal wallet pays
 * for that buyer's own purchases and is NEVER debited for a merchant's commission. The
 * distinction is enforced structurally here rather than left to a caller passing the right
 * id — see `assertBusinessWallet`.
 */

const MA = require('./money-authority');

/* Kenya is UTC+3 year-round — no daylight saving, so a fixed offset is correct here and
   will not silently drift twice a year the way a naive fixed offset does elsewhere. */
const EAT_OFFSET_MINUTES = 180;
const GATE_HOUR_LOCAL = 7;               /* 07:00 EAT */

const WALLET_KIND = { BUSINESS: 'BUSINESS', PERSONAL: 'PERSONAL' };

class SettlementError extends Error {
  constructor (code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail || null;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   The settlement day
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Which settlement day a moment belongs to.
 *
 * A settlement day runs 07:00 EAT to 06:59:59.999 EAT the next morning, and is NAMED by the
 * date it opened. A sale at 02:00 on the 5th belongs to the day that opened at 07:00 on the
 * 4th — it is still last night's trading, and treating it as a new day would let a merchant
 * roll a night's takings past a gate that has not yet closed on them.
 *
 * Returned as 'YYYY-MM-DD' in EAT so it is stable, comparable and readable in a ledger.
 */
function settlementDayFor (ms) {
  if (typeof ms !== 'number' || !isFinite(ms)) {
    throw new SettlementError('SETTLEMENT_NO_CLOCK', 'A finite epoch-ms timestamp is required');
  }
  /* shift into EAT, then back by the gate hour, so local midnight lands on the boundary */
  const shifted = ms + EAT_OFFSET_MINUTES * 60000 - GATE_HOUR_LOCAL * 3600000;
  return new Date(shifted).toISOString().slice(0, 10);
}

/** The instant a settlement day's gate closes: 07:00 EAT on the FOLLOWING calendar day. */
function gateClosesAt (settlementDay) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(settlementDay || ''))) {
    throw new SettlementError('SETTLEMENT_BAD_DAY', 'settlementDay must be YYYY-MM-DD');
  }
  const openUtc = Date.parse(settlementDay + 'T00:00:00.000Z')
                + GATE_HOUR_LOCAL * 3600000 - EAT_OFFSET_MINUTES * 60000;
  return openUtc + 86400000;
}

/* ═══════════════════════════════════════════════════════════════════════════
   The gate
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Is the merchant permitted to continue POS operations?
 *
 * CLOSED when a settlement day whose gate has already passed still carries unpaid liability.
 * The CURRENT day's liability never blocks: a merchant must be able to trade during the day
 * that is accruing the charge, or the rule would stop business the moment the first sale
 * booked.
 *
 * FAILS CLOSED on unreadable input. An unparseable liability is not treated as zero — "we
 * could not tell what you owe" must never resolve to "you owe nothing", which is the exact
 * shape that lets an outage become free trading.
 *
 * @param {object} p
 * @param {number} p.nowMs
 * @param {Array<{settlementDay:string, outstanding:object}>} p.unpaid  Money per day
 */
function evaluateGate ({ nowMs, unpaid }) {
  if (typeof nowMs !== 'number' || !isFinite(nowMs)) {
    throw new SettlementError('SETTLEMENT_NO_CLOCK', 'nowMs is required');
  }
  if (!Array.isArray(unpaid)) {
    throw new SettlementError('SETTLEMENT_LIABILITY_UNREADABLE',
      'Outstanding commission could not be read. Refusing to declare the gate open.');
  }

  const today = settlementDayFor(nowMs);
  let overdueMinor = 0;
  const overdueDays = [];
  let currentDayMinor = 0;

  for (const row of unpaid) {
    if (!row || typeof row.settlementDay !== 'string' || !row.outstanding ||
        typeof row.outstanding.minorUnits !== 'number') {
      throw new SettlementError('SETTLEMENT_LIABILITY_UNREADABLE',
        'An outstanding-commission row is unreadable. Refusing to declare the gate open.',
        { row });
    }
    if (row.outstanding.minorUnits <= 0) continue;
    if (row.settlementDay === today) { currentDayMinor += row.outstanding.minorUnits; continue; }
    if (nowMs >= gateClosesAt(row.settlementDay)) {
      overdueMinor += row.outstanding.minorUnits;
      overdueDays.push(row.settlementDay);
    } else {
      currentDayMinor += row.outstanding.minorUnits;
    }
  }

  const closed = overdueMinor > 0;
  return {
    closed,
    today,
    overdue: MA.fromMinor(overdueMinor),
    overdueDays: overdueDays.sort(),
    accruingToday: MA.fromMinor(currentDayMinor),
    nextGateAt: gateClosesAt(today),
    reason: closed
      ? 'Unpaid POS commission from ' + overdueDays.length + ' settlement day(s). ' +
        'Settle ' + MA.toMajorString(MA.fromMinor(overdueMinor)) + ' to continue.'
      : null
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Settlement
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The wallet used to settle a merchant liability must be the merchant's BUSINESS wallet.
 *
 * Structural, not advisory. A buyer's personal wallet paying a shop's commission would be
 * taking a stranger's money for someone else's debt, and the only thing standing between
 * those two cases is which id a caller passed — so the kind is asserted, and ownership is
 * asserted with it.
 */
function assertBusinessWallet ({ wallet, merchantUid }) {
  if (!wallet || typeof wallet !== 'object') {
    throw new SettlementError('SETTLE_NO_WALLET', 'A wallet is required');
  }
  if (wallet.kind !== WALLET_KIND.BUSINESS) {
    throw new SettlementError('SETTLE_NOT_BUSINESS_WALLET',
      'Commission may only be settled from the merchant\'s BUSINESS wallet. ' +
      'A personal wallet is never debited for a merchant liability.',
      { kind: wallet.kind || null });
  }
  if (!merchantUid || wallet.ownerUid !== merchantUid) {
    throw new SettlementError('SETTLE_WALLET_NOT_OWNED',
      'This business wallet does not belong to the merchant being settled.',
      { ownerUid: wallet.ownerUid || null });
  }
  return true;
}

/**
 * Plan a settlement. All or nothing.
 *
 * A partial deduction is refused rather than accepted: taking KES 500 against a KES 700
 * liability leaves the merchant still gated, KES 500 poorer, and a remainder that some other
 * process now has to track. Either the liability clears or nothing moves.
 */
function planCommissionSettlement ({
  merchantUid, wallet, balance, amountDue, idempotencyKey, nowMs
}) {
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    throw new SettlementError('SETTLE_NO_IDEMPOTENCY_KEY',
      'An idempotency key is required: without one a retry settles twice.');
  }
  assertBusinessWallet({ wallet, merchantUid });
  if (!balance || !amountDue) {
    throw new SettlementError('SETTLE_NO_AMOUNT', 'balance and amountDue must be Money');
  }
  if (!MA.isPositive(amountDue)) {
    throw new SettlementError('SETTLE_NOTHING_DUE', 'There is no commission outstanding.');
  }
  if (balance.minorUnits < 0) {
    throw new SettlementError('SETTLE_NEGATIVE_BALANCE',
      'The business wallet balance is negative — refusing to transact against it.');
  }

  if (!MA.gte(balance, amountDue)) {
    const shortfall = MA.sub(amountDue, balance);
    throw new SettlementError('SETTLE_INSUFFICIENT_BALANCE',
      'Commission unpaid. Due ' + MA.toMajorString(amountDue) +
      ', business wallet holds ' + MA.toMajorString(balance) +
      '. Pay ' + MA.toMajorString(shortfall) + ' to continue.',
      {
        dueMinor: amountDue.minorUnits,
        balanceMinor: balance.minorUnits,
        shortfallMinor: shortfall.minorUnits,
        partialDeductionRefused: true
      });
  }

  return {
    merchantUid,
    walletUid: wallet.uid,
    debit: amountDue,
    balanceAfter: MA.sub(balance, amountDue),
    settles: amountDue,
    idempotencyKey,
    settledAtMs: typeof nowMs === 'number' ? nowMs : null,
    method: 'BUSINESS_WALLET'
  };
}

module.exports = {
  SettlementError, WALLET_KIND,
  EAT_OFFSET_MINUTES, GATE_HOUR_LOCAL,
  settlementDayFor, gateClosesAt,
  evaluateGate,
  assertBusinessWallet, planCommissionSettlement
};
