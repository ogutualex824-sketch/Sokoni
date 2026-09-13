'use strict';
/**
 * SOKONI — MONEY AUTHORITY (pure core)
 * functions/money-authority.js
 *
 * STATUS: **CERTIFIED / NOT INTEGRATED** (2026-09-02, scripts/test-money-authority.js 94/0)
 *
 * The arithmetic is certified. NO CLAIM IS MADE that any production wallet balance, POS
 * sale, commission or IntaSend transaction uses it — nothing calls this module. Those are
 * different claims and the distinction is the point: a certified calculation that is not
 * wired is worth exactly as much as it says it is, and no more.
 *
 * It must STAY pure. Firestore transactions, idempotency keys, ledger writes and the
 * existing wallet schema belong in an adapter above it, so the adapter can be certified
 * separately under the same fail-closed rules. Writes do not go in this file.
 *
 * The arithmetic and the guards for every POS money movement, with **no I/O**: no Firestore,
 * no network, no clock beyond what is passed in. It computes and it refuses. Callers do the
 * writing.
 *
 * ── WHY A PURE CORE ─────────────────────────────────────────────────────────────────
 * A money path cannot be certified while it is entangled with writes. This module can be
 * exercised exhaustively — every boundary, every rounding case, every refusal — before a
 * single document is touched, the same shape that made the Rules equivalence harness worth
 * anything. It is deliberately NOT wired into any callable yet.
 *
 * ── THE UNIT ────────────────────────────────────────────────────────────────────────
 * Everything internal is INTEGER MINOR UNITS (cents). This exists because the divergence is
 * already live and already costing something:
 *
 *     requestWithdrawal    amountCents : 10000  ->  KES    100
 *     requestSellerPayout  amount      : 10000  ->  KES 10,000
 *
 * Two deployed callables, both taking "an amount", 100x apart. `withdrawals` holds ZERO rows
 * while that callable took TWO requests in 30 days — consistent with a UI sending shillings
 * into a cents parameter and being rejected below its minimum. No function here accepts a
 * bare number called `amount`; conversion happens once, at the boundary, through Money.
 *
 * ── THE INVARIANT EVERY CALLER MUST HONOUR ──────────────────────────────────────────
 * No wallet debit or credit occurs unless the complete transaction can be committed
 * atomically. This module makes that enforceable by returning a fully-resolved plan or
 * throwing: there is no partial result to act on.
 */

/* ═══════════════════════════════════════════════════════════════════════════
   Money — integer minor units, currency-tagged
   ═══════════════════════════════════════════════════════════════════════════ */

const CURRENCY = 'KES';
const MINOR_PER_MAJOR = 100;

class MoneyError extends Error {
  constructor (code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail || null;
  }
}

/** Construct from integer minor units. The ONLY constructor the internals use. */
function fromMinor (minorUnits, currency = CURRENCY) {
  if (typeof minorUnits !== 'number' || !Number.isInteger(minorUnits)) {
    throw new MoneyError('MONEY_NOT_INTEGER',
      'Money must be integer minor units, got ' + JSON.stringify(minorUnits));
  }
  if (!Number.isSafeInteger(minorUnits)) {
    throw new MoneyError('MONEY_UNSAFE', 'Money exceeds safe integer range');
  }
  if (currency !== CURRENCY) {
    throw new MoneyError('MONEY_CURRENCY', 'Unsupported currency ' + currency);
  }
  return { currency, minorUnits };
}

/**
 * Boundary conversion from major units (shillings). Rejects fractional cents rather than
 * rounding: a caller that produced KES 10.005 has a bug, and silently absorbing a half-cent
 * is how ledgers drift.
 */
function fromMajor (majorUnits, currency = CURRENCY) {
  if (typeof majorUnits !== 'number' || !isFinite(majorUnits)) {
    throw new MoneyError('MONEY_NOT_FINITE', 'Amount must be a finite number');
  }
  const scaled = majorUnits * MINOR_PER_MAJOR;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-9) {
    throw new MoneyError('MONEY_SUBUNIT',
      'Amount ' + majorUnits + ' ' + currency + ' is not a whole number of minor units');
  }
  return fromMinor(rounded, currency);
}

function assertSame (a, b) {
  if (a.currency !== b.currency) {
    throw new MoneyError('MONEY_CURRENCY_MISMATCH', a.currency + ' vs ' + b.currency);
  }
}
const add = (a, b) => { assertSame(a, b); return fromMinor(a.minorUnits + b.minorUnits, a.currency); };
const sub = (a, b) => { assertSame(a, b); return fromMinor(a.minorUnits - b.minorUnits, a.currency); };
const gte = (a, b) => { assertSame(a, b); return a.minorUnits >= b.minorUnits; };
const isZero = (a) => a.minorUnits === 0;
const isPositive = (a) => a.minorUnits > 0;
const toMajorString = (a) =>
  (a.minorUnits / MINOR_PER_MAJOR).toFixed(2);

/* ═══════════════════════════════════════════════════════════════════════════
   Custody — the ONLY thing the commission engine may branch on
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Custody, not the rail name, decides the accounting. Adding a payment method must not add
 * a third case; it must classify into one of these two.
 *
 *   CUSTODIAL      SOKONI receives/controls the funds -> commission deducted, merchant
 *                  credited NET.
 *   NON_CUSTODIAL  the merchant holds the funds -> sale recorded gross, commission becomes
 *                  a LIABILITY the merchant owes.
 */
const CUSTODY = { CUSTODIAL: 'CUSTODIAL', NON_CUSTODIAL: 'NON_CUSTODIAL' };

const METHOD_CUSTODY = {
  cash:            CUSTODY.NON_CUSTODIAL,
  store_credit:    CUSTODY.NON_CUSTODIAL,  /* merchant-issued posWallets credit */
  mpesa_direct:    CUSTODY.NON_CUSTODIAL,  /* DIRECT_TO_SELLER till — never in SOKONI custody */
  mpesa_stk:       CUSTODY.CUSTODIAL,
  intasend:        CUSTODY.CUSTODIAL,
  card:            CUSTODY.CUSTODIAL,
  sokoni_wallet:   CUSTODY.CUSTODIAL,      /* buyer's wallets/{uid} — funds already held */
};

/**
 * Fail closed. An unrecognised method is NOT assumed custodial or non-custodial: guessing
 * either way silently mis-books money. A new rail must be classified deliberately.
 */
function classifyCustody (method) {
  const key = String(method || '').toLowerCase();
  const c = METHOD_CUSTODY[key];
  if (!c) {
    throw new MoneyError('CUSTODY_UNKNOWN',
      'Payment method "' + method + '" has no custody classification. Classify it ' +
      'deliberately; it must not be inferred.');
  }
  return c;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Commission
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Commission on a gross sale.
 *
 * `rateFraction` is a FRACTION (0.05 = 5%), never a percentage. The platform has three
 * competing conventions in live code — `pct: 5`, `commission_pct: 10`,
 * `commission_discount_pct: 2` — and a prior design used fractions. Passing 5 where 0.05 is
 * meant charges 500%, so the range is asserted rather than trusted.
 *
 * `minimumMinor` is the floor (KES 10 today). It is applied AFTER the rate, and it can make
 * a nominal 0% plan still owe the floor — that is a live commercial question, so the caller
 * must pass `floorExempt` explicitly rather than the floor being quietly skipped for zero
 * rates.
 *
 * Rounding is HALF-UP on the minor unit, and the merchant's net is computed by SUBTRACTION,
 * never by its own rounding — so commission + net === gross exactly, always.
 */
function computeCommission ({ gross, rateFraction, minimumMinor = 0, floorExempt = false }) {
  if (!gross || typeof gross.minorUnits !== 'number') {
    throw new MoneyError('COMMISSION_NO_GROSS', 'gross must be Money');
  }
  if (gross.minorUnits < 0) {
    throw new MoneyError('COMMISSION_NEGATIVE_GROSS', 'gross must not be negative');
  }
  if (typeof rateFraction !== 'number' || !isFinite(rateFraction)) {
    throw new MoneyError('COMMISSION_RATE_INVALID', 'rateFraction must be a finite number');
  }
  if (rateFraction < 0 || rateFraction > 1) {
    throw new MoneyError('COMMISSION_RATE_RANGE',
      'rateFraction must be a FRACTION between 0 and 1 (0.05 = 5%), got ' + rateFraction +
      '. A percentage passed here would overcharge by 100x.');
  }
  if (!Number.isInteger(minimumMinor) || minimumMinor < 0) {
    throw new MoneyError('COMMISSION_MIN_INVALID', 'minimumMinor must be a non-negative integer');
  }

  let commissionMinor = Math.round(gross.minorUnits * rateFraction);

  /* The floor never applies to a zero-value sale, and never exceeds the sale itself. */
  if (!floorExempt && gross.minorUnits > 0 && commissionMinor < minimumMinor) {
    commissionMinor = Math.min(minimumMinor, gross.minorUnits);
  }
  if (commissionMinor > gross.minorUnits) commissionMinor = gross.minorUnits;

  const commission = fromMinor(commissionMinor, gross.currency);
  const net = sub(gross, commission);          /* by subtraction: the parts always sum */
  return { gross, commission, net, rateFraction, floorApplied: !floorExempt &&
           gross.minorUnits > 0 && Math.round(gross.minorUnits * rateFraction) < minimumMinor };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Sale accounting — custody decides the booking, not the rail
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Book one POS sale. This is where "commission before credit" stops being a policy and
 * becomes arithmetic.
 *
 * CUSTODIAL (STK, IntaSend, buyer wallet) — SOKONI controls the funds:
 *     merchantCredit = gross - commission,  liability = 0
 *   The merchant's entitlement is created NET. There is no intermediate state in which the
 *   wallet holds the gross, so there is nothing to claw back and no window in which a crash
 *   leaves the merchant over-credited.
 *
 * NON_CUSTODIAL (cash, merchant store credit, direct-to-till) — the merchant already holds
 * the money and SOKONI never did:
 *     merchantCredit = 0,  liability = commission
 *   Crediting a wallet here would invent money the platform never received. The commission
 *   is a RECEIVABLE, settled later from the merchant's wallet.
 *
 * The caller passes CUSTODY, not a payment method name, so adding a rail cannot introduce a
 * third booking. `rateFraction` is resolved by the caller from the single commission source
 * — this function must never carry a rate table of its own, because a second table is
 * exactly what `scripts/verify-commission-single-source.js` fails the deploy over. The
 * platform once had nine that disagreed.
 */
function planSaleAccounting ({ gross, rateFraction, custody, minimumMinor = 0, floorExempt = false }) {
  if (custody !== CUSTODY.CUSTODIAL && custody !== CUSTODY.NON_CUSTODIAL) {
    throw new MoneyError('SALE_CUSTODY_REQUIRED',
      'custody must be CUSTODIAL or NON_CUSTODIAL — pass the classification, never the ' +
      'payment method name.');
  }
  const c = computeCommission({ gross, rateFraction, minimumMinor, floorExempt });
  const zero = fromMinor(0, gross.currency);

  const booking = custody === CUSTODY.CUSTODIAL
    ? { merchantCredit: c.net,  liability: zero }
    : { merchantCredit: zero,   liability: c.commission };

  /* Asserted, not assumed. A booking that fails either of these has mis-stated the
     platform's position, and it is cheaper to refuse than to reconcile later. */
  if (custody === CUSTODY.CUSTODIAL) {
    if (booking.merchantCredit.minorUnits + c.commission.minorUnits !== gross.minorUnits) {
      throw new MoneyError('SALE_BOOKING_UNBALANCED',
        'Custodial booking does not sum to gross');
    }
  } else if (booking.merchantCredit.minorUnits !== 0 ||
             booking.liability.minorUnits !== c.commission.minorUnits) {
    throw new MoneyError('SALE_BOOKING_UNBALANCED',
      'Non-custodial booking must credit nothing and owe the commission');
  }

  return {
    gross: c.gross,
    commission: c.commission,
    net: c.net,
    custody,
    merchantCredit: booking.merchantCredit,
    liability: booking.liability,
    rateFraction: c.rateFraction,
    floorApplied: c.floorApplied
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Wallet payment — the buyer's own wallet, authorised by the buyer
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Plan a buyer-wallet payment at POS. Returns a fully-resolved plan or throws; there is no
 * partial outcome a caller could act on.
 *
 * FAIL CLOSED ON BALANCE. Insufficient funds DECLINE the whole transaction: no debit, no
 * sale, no commission, no partial capture. The caller must not "take what is there".
 *
 * THE CASHIER NEVER AUTHORISES. `authorization` must be an object produced by the BUYER's
 * own authenticated session (see docs/POS_WALLET_AUTHORIZATION.md). This function refuses a
 * payment whose authorization is missing, unbound to this buyer, unbound to this amount, or
 * expired — because an authorization that is not bound to the exact charge can be replayed
 * against a different one.
 */
function planWalletPayment ({ buyerUid, balance, amount, authorization, nowMs }) {
  if (!buyerUid || typeof buyerUid !== 'string') {
    throw new MoneyError('WALLET_NO_BUYER', 'A wallet payment requires an identified buyer');
  }
  if (!balance || !amount) {
    throw new MoneyError('WALLET_NO_AMOUNT', 'balance and amount must both be Money');
  }
  assertSame(balance, amount);
  if (!isPositive(amount)) {
    throw new MoneyError('WALLET_AMOUNT_NOT_POSITIVE', 'A wallet payment must be positive');
  }
  if (balance.minorUnits < 0) {
    throw new MoneyError('WALLET_NEGATIVE_BALANCE',
      'Wallet balance is negative — refusing to transact against it');
  }

  /* ── authorization, bound to buyer AND amount ── */
  if (!authorization || typeof authorization !== 'object') {
    throw new MoneyError('WALLET_NOT_AUTHORIZED',
      'This payment has not been authorised by the buyer.');
  }
  if (authorization.buyerUid !== buyerUid) {
    throw new MoneyError('WALLET_AUTHORIZATION_WRONG_BUYER',
      'The authorization belongs to a different buyer.');
  }
  if (authorization.amountMinor !== amount.minorUnits) {
    throw new MoneyError('WALLET_AUTHORIZATION_AMOUNT_MISMATCH',
      'The authorization is for ' + authorization.amountMinor +
      ' minor units but the charge is ' + amount.minorUnits +
      '. An authorization must name the exact amount it permits.');
  }
  if (typeof nowMs !== 'number' || !isFinite(nowMs)) {
    throw new MoneyError('WALLET_NO_CLOCK', 'nowMs must be supplied by the caller');
  }
  if (typeof authorization.expiresAtMs !== 'number' || authorization.expiresAtMs <= nowMs) {
    throw new MoneyError('WALLET_AUTHORIZATION_EXPIRED',
      'This authorization has expired. Ask the buyer to approve again.');
  }
  if (authorization.consumed === true) {
    throw new MoneyError('WALLET_AUTHORIZATION_CONSUMED',
      'This authorization has already been used.');
  }

  /* ── the balance guard, last, so a refusal is never mistaken for an auth problem ── */
  if (!gte(balance, amount)) {
    throw new MoneyError('WALLET_INSUFFICIENT_BALANCE',
      'Insufficient balance. The wallet holds ' + toMajorString(balance) +
      ' but ' + toMajorString(amount) + ' is required.',
      { balanceMinor: balance.minorUnits, requiredMinor: amount.minorUnits,
        shortfallMinor: amount.minorUnits - balance.minorUnits });
  }

  return {
    buyerUid,
    debit: amount,
    balanceBefore: balance,
    balanceAfter: sub(balance, amount),
    authorizationId: authorization.id || null,
    custody: CUSTODY.CUSTODIAL
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Settlement of a commission liability from the merchant's wallet
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * No partial settlement and no overpayment. Paying more than is owed would create a credit
 * this ledger has no concept of; paying less would leave a liability whose remainder nobody
 * is tracking. Both are refused rather than absorbed.
 */
function planCommissionSettlement ({ merchantUid, walletBalance, amountDue, amountOffered }) {
  if (!merchantUid) throw new MoneyError('SETTLE_NO_MERCHANT', 'merchantUid required');
  assertSame(walletBalance, amountDue);
  const offered = amountOffered || amountDue;
  assertSame(offered, amountDue);

  if (!isPositive(amountDue)) {
    throw new MoneyError('SETTLE_NOTHING_DUE', 'There is no commission outstanding.');
  }
  if (offered.minorUnits !== amountDue.minorUnits) {
    throw new MoneyError('SETTLE_PARTIAL_REFUSED',
      'Settlement must clear the full amount due (' + toMajorString(amountDue) + ').');
  }
  if (!gte(walletBalance, amountDue)) {
    throw new MoneyError('SETTLE_INSUFFICIENT_BALANCE',
      'Insufficient balance. Commission due is ' + toMajorString(amountDue) +
      ' but the wallet holds ' + toMajorString(walletBalance) + '.',
      { shortfallMinor: amountDue.minorUnits - walletBalance.minorUnits });
  }
  return {
    merchantUid,
    debit: amountDue,
    balanceAfter: sub(walletBalance, amountDue),
    settles: amountDue
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Withdrawal quote
   ═══════════════════════════════════════════════════════════════════════════ */

const FEE_SOURCE = {
  PROVIDER_API: 'PROVIDER_API',
  AUTHORITATIVE_TABLE: 'AUTHORITATIVE_TABLE'
};

/**
 * The merchant enters what they want to RECEIVE. Fees are charged ON TOP.
 *
 *     totalDebit = requested + providerFee + sokoniFee
 *     recipient receives = requested
 *
 * INSUFFICIENT BALANCE REJECTS. It never silently reduces the requested amount — a merchant
 * who asked for 8,000 and received 7,880 was not served, they were surprised. A separate
 * `maximumWithdrawable()` exists for "send everything".
 *
 * FEE_INDETERMINATE IS A HARD FAILURE. A fee of zero because a lookup failed is
 * indistinguishable downstream from a genuinely free transfer, so an absent fee is refused
 * rather than defaulted. `feeSource` records where the number came from so reconciliation
 * can tell an API-returned fee from a table-derived one.
 */
function calculateWithdrawalQuote ({
  availableBalance, requested, providerFee, sokoniFee, feeSource,
  destinationType, destination, quoteVersion, quotedAtMs
}) {
  if (!availableBalance || !requested) {
    throw new MoneyError('QUOTE_NO_AMOUNT', 'availableBalance and requested must be Money');
  }
  assertSame(availableBalance, requested);
  if (!isPositive(requested)) {
    throw new MoneyError('QUOTE_AMOUNT_NOT_POSITIVE', 'The withdrawal amount must be positive');
  }
  if (!destinationType) {
    throw new MoneyError('QUOTE_NO_DESTINATION_TYPE', 'destinationType is required');
  }

  if (!providerFee || typeof providerFee.minorUnits !== 'number') {
    throw new MoneyError('FEE_INDETERMINATE',
      'The withdrawal fee for this destination could not be determined. ' +
      'No withdrawal is created. Try again shortly.',
      { destinationType });
  }
  if (!feeSource || !FEE_SOURCE[feeSource]) {
    throw new MoneyError('FEE_INDETERMINATE',
      'The fee has no recorded source, so it cannot be trusted.', { feeSource });
  }
  if (providerFee.minorUnits < 0) {
    throw new MoneyError('FEE_NEGATIVE', 'A negative provider fee is not meaningful');
  }
  assertSame(requested, providerFee);

  const sok = sokoniFee || fromMinor(0, requested.currency);
  assertSame(requested, sok);
  if (sok.minorUnits < 0) throw new MoneyError('FEE_NEGATIVE', 'Negative SOKONI fee');

  const fees = add(providerFee, sok);
  const totalDebit = add(requested, fees);

  const quote = {
    requested,
    providerFee,
    sokoniFee: sok,
    totalDebit,
    recipientAmount: requested,     /* by construction: fees are ON TOP */
    currency: requested.currency,
    feeSource,
    destinationType,
    destination: destination || null,
    quoteVersion: quoteVersion || 1,
    quotedAtMs: quotedAtMs || null,
    availableBalance
  };

  if (!gte(availableBalance, totalDebit)) {
    const shortfall = sub(totalDebit, availableBalance);
    throw new MoneyError('INSUFFICIENT_BALANCE',
      'Insufficient balance. You need ' + toMajorString(shortfall) + ' more to withdraw ' +
      toMajorString(requested) + '. Total required is ' + toMajorString(totalDebit) +
      ' including fees; available is ' + toMajorString(availableBalance) + '.',
      { quote, shortfallMinor: shortfall.minorUnits });
  }

  return quote;
}

/**
 * The largest amount that can be withdrawn such that amount + fees <= balance.
 * Offered INSTEAD of silently reducing a request, so "send everything" is an explicit
 * choice the merchant makes rather than something the system does to them.
 *
 * Only valid for a fee that does not vary with the amount; a percentage fee needs the
 * provider's own schedule and is refused rather than approximated.
 */
function maximumWithdrawable ({ availableBalance, providerFee, sokoniFee, feeVariesWithAmount }) {
  if (feeVariesWithAmount) {
    throw new MoneyError('MAX_INDETERMINATE',
      'This destination charges a fee that varies with the amount, so the maximum cannot ' +
      'be derived without the provider schedule.');
  }
  if (!providerFee) throw new MoneyError('FEE_INDETERMINATE', 'Fee unknown');
  const sok = sokoniFee || fromMinor(0, availableBalance.currency);
  const fees = add(providerFee, sok);
  const max = availableBalance.minorUnits - fees.minorUnits;
  return fromMinor(max > 0 ? max : 0, availableBalance.currency);
}

module.exports = {
  MoneyError, CURRENCY, MINOR_PER_MAJOR,
  fromMinor, fromMajor, add, sub, gte, isZero, isPositive, toMajorString,
  CUSTODY, METHOD_CUSTODY, classifyCustody,
  computeCommission, planSaleAccounting,
  planWalletPayment,
  planCommissionSettlement,
  FEE_SOURCE, calculateWithdrawalQuote, maximumWithdrawable
};
