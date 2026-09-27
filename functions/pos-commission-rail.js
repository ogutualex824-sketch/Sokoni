'use strict';
/**
 * SOKONI — POS / TILL COMMISSION RAIL  (persistence + the gate, over the pure cores)
 * functions/pos-commission-rail.js
 *
 * This is the layer that was missing. Three certified pure modules already existed and
 * NOTHING CALLED ANY OF THEM:
 *
 *   money-authority                  the arithmetic
 *   pos-sale-commission              a sale  -> a commission record + liability
 *   commission-settlement-authority  a day's liabilities -> is the 07:00 gate closed?
 *   good-morning-gate                how to say it to the merchant
 *
 * Each was internally coherent and none was on the path the money takes — the exact pattern
 * that produced six unreachable commission authorities on this platform before. A pure
 * function that summarises an ARRAY of records cannot gate anything, because nobody was
 * writing the records. This module writes them, reads them back, and turns the gate from a
 * predicate over an argument into a predicate over the ledger.
 *
 * ── THE COMMERCIAL RULE (owner ruling 2026-09-07) ───────────────────────────────────
 *   • POS and Till are charged 5% per sale, every plan. (The marketplace plan ladder does
 *     NOT apply here — see commission-config.MARKETPLACE_SELLER_CATEGORIES.)
 *   • Commission is PAYABLE AT ANY TIME. A merchant who wants to clear today's accrual at
 *     14:00 may do so; they do not have to wait to be gated.
 *   • Unpaid commission is COLLECTED EVERY MORNING at the 07:00 Africa/Nairobi gate,
 *     BEFORE a new sales day starts.
 *   • An EARLY REMINDER goes out before the gate, so being gated is never a surprise.
 *
 * ── WHY THE GATE IS A PREDICATE, NOT A JOB ──────────────────────────────────────────
 * `commission-settlement-authority` says it and it is right: a scheduler can only open and
 * close a cycle, so if the rule lived in the scheduler a merchant could call an older POS
 * callable and transact straight past it. The boundary is recomputed from the clock on every
 * operation. The scheduled reminder is an OPTIMISATION and a courtesy — it never decides.
 *
 * ── UNREADABLE IS NOT ZERO ──────────────────────────────────────────────────────────
 * Every read here either produces a figure from the ledger or throws. There is no `|| 0`,
 * no empty-array fallback, no catch that turns an outage into an open gate. "We could not
 * tell what you owe" resolving to "you owe nothing" is precisely the shape that turns a
 * Firestore incident into a day of free trading, and it would look like resilience.
 *
 * ── IDEMPOTENCY ─────────────────────────────────────────────────────────────────────
 * The liability document id is derived from the sale id (`poscomm_<saleId>`, M0-1) and is
 * CREATED, never overwritten; its ledger projection shares the id and is created with it. A retried trigger, a double-submitted checkout
 * or a replayed webhook converge on one row rather than billing the merchant twice. The
 * settlement writes a `settlementRef` and refuse to re-apply one they have already seen.
 */

const MA = require('./money-authority');
const S  = require('./commission-settlement-authority');
const P  = require('./pos-sale-commission');

/* One row per non-custodial POS/Till sale that owes commission. Custodial sales are NOT
   written here at all — their commission was already taken out of money SOKONI was holding,
   and billing them again at 07:00 would charge the merchant twice for one sale while looking
   like diligence. `pos-sale-commission` decides that; this module obeys it. */
const LIABILITIES = 'posCommissionLiabilities';

/* Settlement attempts, so a payment can be traced from intent to authoritative success.
   Deliberately separate from the liabilities: an INTENT IS NOT A COLLECTION. */
const SETTLEMENTS = 'posCommissionSettlements';

/* The accounting ledger. A POS commission entry there is a PROJECTION of a debt row above,
   written with it — never an obligation in its own right (M0-1). */
const LEDGER = 'ledger';

const STATUS = Object.freeze({
  OUTSTANDING: 'OUTSTANDING',
  SETTLED:     'SETTLED',
});

class RailError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'RailError';
    this.code = code;
    if (details) this.details = details;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   WRITE — a sale becomes a liability
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Record the commission liability for one POS/Till sale.
 *
 * Idempotent by construction: the document id is `poscomm_<saleId>`, created exactly once. Returns what it did rather
 * than a bare ok, because "already recorded" and "recorded" are different facts and a
 * reconciliation needs to tell them apart.
 *
 * @param {object} db      Firestore
 * @param {object} record  the output of pos-sale-commission.planSaleCommission()
 */
async function recordSaleLiability(db, record) {
  if (!db || typeof db.collection !== 'function') {
    throw new RailError('RAIL_NO_DB', 'recordSaleLiability(db, record): db is required');
  }
  if (!record || !record.saleId || !record.merchantUid || !record.settlementDay) {
    throw new RailError('RAIL_UNREADABLE_RECORD',
      'A sale record without saleId, merchantUid and settlementDay cannot be collected.');
  }
  /* A custodial sale owes nothing here. Say so explicitly rather than writing a zero row —
     a zero-value liability row is indistinguishable from a settled one at a glance, and it
     would inflate every count an operator reads. */
  if (!record.createsLiability) {
    return { action: 'none', reason: 'custodial_or_zero', saleId: record.saleId };
  }

  /* M0-1 (owner ruling 2026-09-27): THIS row is the ONE collectible POS commission obligation.
     Its id is derived from the sale, it is CREATED exactly once (create(), never get()+set()),
     and the `ledger` entry is an accounting PROJECTION of it, written in the same transaction
     from the debt's own figures — never a second, independently computed obligation. Pay Now
     and the 07:00 collector will read and settle only this row. */
  const debtRef   = db.collection(LIABILITIES).doc(debtIdFor(record.saleId));
  const ledgerRef = db.collection(LEDGER).doc(debtIdFor(record.saleId));

  /* The fast path, outside the transaction: a retry of a sale whose debt AND projection
     both exist needs no business lookup and writes nothing. */
  const [d0, l0] = await Promise.all([debtRef.get(), ledgerRef.get()]);
  if (d0.exists && l0.exists) {
    return { action: 'already_recorded', saleId: record.saleId, id: debtRef.id };
  }

  /* Which canonical business owes it. Resolved once, frozen on the debt; never blocks, never
     drops the debt — an unresolved mapping is recorded as such and reconciled later. */
  const business = d0.exists ? null : await resolveDebtBusiness(db, record.merchantUid);

  const newDebt = d0.exists ? null : {
    debtId:        debtRef.id,
    saleId:        String(record.saleId),
    merchantUid:   String(record.merchantUid),
    businessId:    business.businessId,
    businessUnresolved: business.businessId === null,
    businessResolution: business.via,
    settlementDay: record.settlementDay,
    /* MINOR UNITS, and the field name says so. This platform carries balances in shillings
       and FinOS balances in cents in the same database; a bare `amount` here is how those
       two get added together. */
    liabilityMinor: record.liability.minorUnits,
    currency:       record.currency || 'KES',
    status:         STATUS.OUTSTANDING,
    settlementRef:  null,
    /* Rate provenance FROZEN at the sale. Collection must never recompute a rate — a
       merchant who changes plan in the afternoon does not retroactively reprice the
       morning's sales, in either direction. */
    plan:          record.plan,
    rateFraction:  record.rateFraction,
    rateSource:    record.rateSource,
    floorApplied:  record.floorApplied,
    rail:          record.rail,
    surface:       record.surface,
    method:        record.method,
    custody:       record.custody,
    grossMinor:    record.gross.minorUnits,
    soldAtMs:      record.soldAtMs,
    collectibleAtMs: record.collectibleAtMs,
    createdAtMs:   Date.now(),
  };

  const action = await db.runTransaction(async (t) => {
    /* All reads first. Inside the transaction, so two concurrent recorders of one sale
       cannot both see "absent": the loser's create() fails at commit, the transaction
       retries, and on the retry it sees the winner's rows. */
    const d = await t.get(debtRef);
    const l = await t.get(ledgerRef);
    if (d.exists && l.exists) return 'already_recorded';
    const debt = d.exists ? d.data() : newDebt;
    if (!debt) throw new RailError('RAIL_DEBT_VANISHED', 'The commission debt was seen and then not found.');
    if (!d.exists) t.create(debtRef, debt);
    if (!l.exists) t.create(ledgerRef, ledgerProjectionOf(debt));
    return d.exists ? 'projection_repaired' : 'recorded';
  });

  return { action, saleId: record.saleId, id: debtRef.id,
    liabilityMinor: record.liability.minorUnits, settlementDay: record.settlementDay,
    businessId: business ? business.businessId : undefined };
}

/* The ONE debt id for a sale. Both sale rails converge on it. */
function debtIdFor(saleId) { return 'poscomm_' + String(saleId); }

/* The ledger entry for a debt: the SAME amount, the SAME identity, derived — never recomputed.
   `status: 'settled'` keeps the ledger's established meaning (the entry is POSTED); whether the
   debt is paid lives only on the debt row. Shaped like finos-utils.createLedgerEntry so every
   existing ledger reader sees a familiar row. */
function ledgerProjectionOf(debt) {
  return {
    id:            debt.debtId,
    type:          'pos_commission_receivable',
    amountCents:   debt.liabilityMinor,
    currency:      debt.currency || 'KES',
    /* The seller HOLDS the cash and OWES the commission: seller debited, platform revenue
       credited — the same double entry posCompleteCheckout used to post directly. */
    debitAccount:  'seller:' + debt.merchantUid,
    creditAccount: 'platform:revenue',
    description:   'SOKONI commission on till sale ' + debt.saleId,
    orderId:       debt.saleId,
    sellerId:      debt.merchantUid,
    businessId:    debt.businessId,
    liabilityId:   debt.debtId,
    category:      'pos',
    metadata:      { rail: debt.rail, rateFraction: debt.rateFraction, projectionOf: LIABILITIES + '/' + debt.debtId },
    status:        'settled',
    reversalRef:   null,
    createdBy:     'pos-commission-rail',
    idempotencyKey: debt.debtId,
    createdAt:     new Date(),
  };
}

/* Resolve the canonical SOK-* business for a proven merchant. Never throws, never blocks.
     · the sale's merchant IS a SOK-* business (membership-proven sales) → that business;
     · otherwise the owner's single business, via the ONE resolver (tenant-identity);
     · zero, several, inactive, non-canonical or unreadable → null + the reason. */
async function resolveDebtBusiness(db, merchantUid) {
  const id = String(merchantUid || '');
  try {
    if (/^SOK-/.test(id)) {
      const b = await db.collection('businesses').doc(id).get();
      if (!b.exists) return { businessId: null, via: 'business-record-missing' };
      const st = (b.data() || {}).status;
      if (st && st !== 'active') return { businessId: null, via: 'business-not-active' };
      return { businessId: id, via: 'sale-merchant-is-business' };
    }
    const r = await require('./tenant-identity').resolveMerchantIdForOwner(id, db);
    if (!r || !r.ok) return { businessId: null, via: (r && r.reason) || 'unresolved' };
    if (!/^SOK-/.test(String(r.merchantId))) return { businessId: null, via: 'non-canonical-business-id' };
    return { businessId: r.merchantId, via: 'owner-single-business' };
  } catch (e) {
    return { businessId: null, via: 'business-lookup-failed' };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   READ — what does this merchant owe?
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Every OUTSTANDING liability row for a merchant, shaped for `summariseLiability`.
 *
 * Throws rather than returning [] when the read fails. An empty array here means "this
 * merchant owes nothing", and that sentence must only ever be said by a successful read.
 */
async function readOutstanding(db, merchantUid) {
  if (!merchantUid) throw new RailError('RAIL_NO_MERCHANT', 'merchantUid is required');
  let snap;
  try {
    snap = await db.collection(LIABILITIES)
      .where('merchantUid', '==', String(merchantUid))
      .where('status', '==', STATUS.OUTSTANDING)
      .limit(2000)
      .get();
  } catch (e) {
    throw new RailError('RAIL_LIABILITY_UNREADABLE',
      'Outstanding POS commission could not be read. Refusing to report a figure.',
      { cause: String(e && e.message || e) });
  }
  if (!snap || !Array.isArray(snap.docs)) {
    throw new RailError('RAIL_LIABILITY_UNREADABLE',
      'The liability query returned nothing readable. Refusing to report a figure.');
  }
  return snap.docs.map((d) => {
    const x = d.data() || {};
    if (typeof x.liabilityMinor !== 'number' || typeof x.settlementDay !== 'string') {
      throw new RailError('RAIL_LIABILITY_UNREADABLE',
        'A liability row is unreadable. Refusing to summarise a partial day.', { id: d.id });
    }
    /* Shaped exactly as pos-sale-commission.summariseLiability expects, so ONE summariser
       serves both the in-memory tests and the live ledger. Two summarisers is how the two
       disagree. */
    return {
      id: d.id,
      settlementDay: x.settlementDay,
      liability: MA.fromMinor(x.liabilityMinor),
      merchantCredit: MA.fromMinor(0),
    };
  });
}

/**
 * THE GATE. Read the ledger, evaluate the 07:00 boundary, and say plainly what happens next.
 *
 * This is what a POS surface must ask before it opens a new sales day, and what the settle
 * screen reads. It never writes.
 */
async function evaluateMerchantGate(db, merchantUid, nowMs) {
  const rows = await readOutstanding(db, merchantUid);
  const summary = P.summariseLiability(rows);
  const gate = S.evaluateGate({ nowMs, unpaid: summary.unpaid });
  return {
    merchantUid: String(merchantUid),
    /* `closed` is the answer to "may I trade?" — false means go. */
    closed: gate.closed,
    today: gate.today,
    overdue: gate.overdue,
    overdueDays: gate.overdueDays,
    accruingToday: gate.accruingToday,
    /* Everything unpaid, overdue or not. This is what "payable at any time" acts on: a
       merchant may clear today's accrual before it is ever due. */
    totalOutstanding: summary.totalLiability,
    unpaid: summary.unpaid,
    nextGateAt: gate.nextGateAt,
    reason: gate.reason,
    rowCount: rows.length,
  };
}

/**
 * The enforcement call. Throws when the gate is closed; returns the gate state when open.
 *
 * Separate from `evaluateMerchantGate` on purpose: a screen wants the state, an operation
 * wants a decision. Making the operation read a boolean off a status object is how a `!`
 * goes missing and the gate stops gating.
 */
async function assertGateOpen(db, merchantUid, nowMs) {
  const gate = await evaluateMerchantGate(db, merchantUid, nowMs);
  if (gate.closed) {
    throw new RailError('POS_GATE_CLOSED',
      gate.reason || 'Unpaid POS commission must be settled before trading continues.',
      {
        overdueMinor: gate.overdue.minorUnits,
        overdueDays: gate.overdueDays,
        totalOutstandingMinor: gate.totalOutstanding.minorUnits,
        nextGateAt: gate.nextGateAt,
      });
  }
  return gate;
}

/**
 * P0 TILL SAFETY (owner ruling 2026-09-27) — the gate does NOT stop a sale, for now.
 *
 * Commission liabilities are recorded on every owed sale, but nothing deployed can PAY
 * them: no settle callable, no collector, no Pay Now. With the gate enforced, a merchant's
 * first cash sale would lock their till at 07:00 the next day with no way to unlock it.
 *
 * So until ONE certified settlement path exists (Pay Now with any IntaSend method, one
 * collector, the evening and 06:00 reminders), the gate is not enforced. Debt still
 * accrues exactly as before; only the refusal is withheld. The owner's target is the
 * STRICT 07:00 gate, switched back on TOGETHER with that path — by changing this one
 * constant, in the same certified unit, never on its own.
 *
 * Both sale rails (posCompleteCheckout and recordPOSSale) must call `enforceSaleGate`
 * and nothing else, so the switch governs every door at once. While it is off there is
 * no ledger read at all: an outage can no longer stop a sale either.
 */
const GATE_ENFORCED = false;

async function enforceSaleGate(db, merchantUid, nowMs) {
  if (!GATE_ENFORCED) return { enforced: false };
  return assertGateOpen(db, merchantUid, nowMs);
}

/* ═══════════════════════════════════════════════════════════════════════════
   SETTLE — and the difference between paying and having paid
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Apply an AUTHORITATIVE settlement success to the ledger.
 *
 * `settlementRef` is the proof — a wallet transaction id, an M-Pesa receipt, a webhook's
 * payment id. This function does NOT initiate a payment and must never be called from a
 * "user pressed pay" handler. Initiation and collection are different events, and the gap
 * between them is where a merchant is marked settled for money that never arrived.
 *
 * ALL OR NOTHING, per settlement day. A partial deduction leaves the merchant still gated,
 * poorer, and holding a remainder somebody else now has to track.
 *
 * Idempotent on `settlementRef`: replaying the same authoritative success is a no-op, so a
 * retried webhook cannot clear a second day's liability for one payment.
 */
async function applySettlement(db, { merchantUid, settlementDays, settlementRef, method, nowMs }) {
  if (!merchantUid) throw new RailError('RAIL_NO_MERCHANT', 'merchantUid is required');
  if (!settlementRef || typeof settlementRef !== 'string') {
    throw new RailError('RAIL_NO_SETTLEMENT_REF',
      'A settlement reference is required: without proof of an authoritative success this ' +
      'would mark a liability paid on somebody pressing a button.');
  }
  if (!Array.isArray(settlementDays) || settlementDays.length === 0) {
    throw new RailError('RAIL_NO_DAYS', 'settlementDays must name at least one day to settle.');
  }

  const settleRef = db.collection(SETTLEMENTS).doc(String(settlementRef));
  const prior = await settleRef.get();
  if (prior.exists) {
    const p = prior.data() || {};
    return { action: 'already_applied', settlementRef, settledMinor: p.settledMinor || 0,
      rowsSettled: p.rowsSettled || 0 };
  }

  const rows = await readOutstanding(db, merchantUid);
  const targeted = rows.filter((r) => settlementDays.indexOf(r.settlementDay) !== -1);
  if (targeted.length === 0) {
    return { action: 'nothing_outstanding', settlementRef, settledMinor: 0, rowsSettled: 0 };
  }
  const settledMinor = targeted.reduce((s, r) => s + r.liability.minorUnits, 0);

  const batch = db.batch();
  for (const r of targeted) {
    batch.update(db.collection(LIABILITIES).doc(r.id), {
      status: STATUS.SETTLED,
      settlementRef: String(settlementRef),
      settledAtMs: typeof nowMs === 'number' ? nowMs : Date.now(),
    });
  }
  /* Written in the SAME batch as the rows it settles. If the receipt could land without the
     rows, a replay would find no receipt and settle them twice; if the rows could land
     without the receipt, the merchant would be cleared with no traceable proof. */
  batch.set(settleRef, {
    settlementRef: String(settlementRef),
    merchantUid: String(merchantUid),
    settlementDays: settledDaysOf(targeted),
    settledMinor,
    rowsSettled: targeted.length,
    method: method || 'UNSPECIFIED',
    appliedAtMs: typeof nowMs === 'number' ? nowMs : Date.now(),
  });
  await batch.commit();

  return { action: 'settled', settlementRef, settledMinor, rowsSettled: targeted.length,
    settlementDays: settledDaysOf(targeted) };
}

function settledDaysOf(rows) {
  return Array.from(new Set(rows.map((r) => r.settlementDay))).sort();
}

/* ═══════════════════════════════════════════════════════════════════════════
   SETTLE FROM THE BUSINESS WALLET — the "payable at any time" path
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Clear outstanding POS/Till commission from the shop's BUSINESS wallet.
 *
 * Callable at ANY time — the merchant does not have to wait to be gated. With no
 * `settlementDays` it clears everything outstanding, including the day still accruing.
 *
 * ── THE ORDER IS THE SAFETY PROPERTY ────────────────────────────────────────────────
 * Debit FIRST, then mark the rows settled. The other order clears the liability and then
 * tries to take the money, so a failure between the two hands the merchant a free day.
 * This order fails the other way — money taken, rows not yet cleared — and that state is
 * RECOVERABLE: both steps are idempotent on the same reference, so simply calling again
 * finishes the job. The debit no-ops and the settlement applies.
 *
 * ── WHY THE REFERENCE IS DERIVED, NOT RANDOM ────────────────────────────────────────
 * A random reference would make the retry above a SECOND debit. The reference is derived
 * from the merchant and the exact days being settled, so a retry is provably the same
 * operation and a genuinely different settlement is a genuinely different reference.
 *
 * @param {object} deps  { businessWallet }  injected so this module stays testable and the
 *                       wallet implementation stays swappable
 */
async function settleFromBusinessWallet(db, deps, { merchantUid, shopId, settlementDays, nowMs }) {
  const BW = deps && deps.businessWallet;
  if (!BW) throw new RailError('RAIL_NO_WALLET_DEP', 'A businessWallet dependency is required');
  if (!merchantUid) throw new RailError('RAIL_NO_MERCHANT', 'merchantUid is required');
  if (!shopId) throw new RailError('RAIL_NO_SHOP', 'shopId is required to find the business wallet');

  const gate = await evaluateMerchantGate(db, merchantUid, nowMs);
  const days = Array.isArray(settlementDays) && settlementDays.length
    ? settlementDays.slice().sort()
    : gate.unpaid.map((u) => u.settlementDay);
  if (days.length === 0) {
    return { action: 'nothing_outstanding', settledMinor: 0, gate };
  }

  const dueMinor = gate.unpaid
    .filter((u) => days.indexOf(u.settlementDay) !== -1)
    .reduce((s, u) => s + u.outstanding.minorUnits, 0);
  if (dueMinor <= 0) return { action: 'nothing_outstanding', settledMinor: 0, gate };

  /* The wallet must exist, be a BUSINESS wallet, and belong to this merchant. All three are
     asserted by the settlement authority rather than by this caller passing the right id. */
  const wallet = await BW.getBusinessWallet(db, shopId);
  if (!wallet) {
    throw new RailError('RAIL_NO_BUSINESS_WALLET',
      'This shop has no business wallet yet. Commission is settled from the business ' +
      'wallet, never from a personal one.', { shopId: String(shopId) });
  }

  const ref = 'poscomm:' + String(merchantUid) + ':' + days.join('_');

  /* planCommissionSettlement asserts the wallet kind and ownership, refuses a partial
     deduction, and reports the exact shortfall. It does not move money.

     ── ONE ERROR SHAPE AT THIS BOUNDARY ──────────────────────────────────────────────
     `SettlementError` carries its payload on `.detail`; the errors this module and
     business-wallet raise carry it on `.details`. A caller reading `err.details.shortfallMinor`
     — which is the natural thing to write, and the thing a settle screen needs — would get
     `undefined` for exactly the case that matters most: "you are short by KES 20". The
     shortfall would silently become a blank, or worse a zero.

     The pure module is certified and shared, so it is not changed. Instead every error
     leaving this function carries BOTH spellings, and callers get one contract. */
  let plan;
  try {
    plan = S.planCommissionSettlement({
      merchantUid: String(merchantUid),
      wallet,
      balance: wallet.balance,
      amountDue: MA.fromMinor(dueMinor),
      idempotencyKey: ref,
      nowMs,
    });
  } catch (e) {
    if (e && e.detail && !e.details) e.details = e.detail;
    if (e && e.details && !e.detail) e.detail = e.details;
    throw e;
  }

  const debit = await BW.debitBusinessWallet(db, {
    shopId: String(shopId),
    amountMinor: plan.debit.minorUnits,
    ref,
    reason: 'POS/Till commission settlement',
    metadata: { merchantUid: String(merchantUid), settlementDays: days },
  });

  /* The DEBIT is the authoritative success. Only now may the liability be marked settled. */
  const applied = await applySettlement(db, {
    merchantUid, settlementDays: days, settlementRef: ref,
    method: 'BUSINESS_WALLET', nowMs,
  });

  return {
    action: 'settled',
    settlementRef: ref,
    settledMinor: applied.settledMinor,
    rowsSettled: applied.rowsSettled,
    settlementDays: days,
    walletBalanceMinor: debit.balanceMinor,
    debitAction: debit.action,
    applyAction: applied.action,
  };
}

module.exports = {
  LIABILITIES, SETTLEMENTS, LEDGER, STATUS, RailError,
  recordSaleLiability,
  debtIdFor,
  ledgerProjectionOf,
  resolveDebtBusiness,
  readOutstanding,
  evaluateMerchantGate,
  assertGateOpen,
  GATE_ENFORCED,
  enforceSaleGate,
  applySettlement,
  settleFromBusinessWallet,
};
