#!/usr/bin/env node
/* POS / Till commission rail — sale -> liability -> 07:00 gate -> settlement.
 *
 *   node scripts/test-pos-commission-rail.js
 *
 * WHAT THIS IS FOR
 * Three certified pure modules existed and nothing called any of them. A pure function that
 * summarises an ARRAY cannot gate anything, because nobody was writing the array. This suite
 * exercises the layer that closes that loop, against an in-memory Firestore — so every
 * assertion is on a document that would actually be written and read back.
 *
 * THE FOUR PROPERTIES THAT MATTER MOST, and each is sabotage-verified:
 *
 *   1. UNREADABLE IS NOT ZERO. A failed liability read must throw, never return "owes
 *      nothing". That single fallback turns a Firestore incident into a day of free trading
 *      and looks like resilience while it does it.
 *   2. ONE SALE, ONE LIABILITY. The document id is the sale id, so a retried trigger or a
 *      double-submitted checkout converges instead of billing twice.
 *   3. CUSTODIAL SALES ARE NOT BILLED AGAIN. Their commission already came out of money
 *      SOKONI held. Charging them at 07:00 too would look like diligence.
 *   4. AN INTENT IS NOT A COLLECTION. Settlement requires an authoritative reference and is
 *      idempotent on it, so a replayed webhook cannot clear a second day for one payment.
 */
'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');

const MA = require(path.join(FN, 'money-authority.js'));
const P  = require(path.join(FN, 'pos-sale-commission.js'));
const S  = require(path.join(FN, 'commission-settlement-authority.js'));
const R  = require(path.join(FN, 'pos-commission-rail.js'));
const BW = require(path.join(FN, 'business-wallet.js'));

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label +
    (detail !== undefined && detail !== '' ? '   [' + String(detail).slice(0, 150) + ']' : ''));
  ok ? pass++ : fail++;
};

/* ── In-memory Firestore with the bits the rail uses ─────────────────────── */
function makeDb(opts = {}) {
  const docs = new Map();
  const fail = opts.failReads ? true : false;
  function coll(name) {
    return {
      _name: name,
      _wheres: [],
      doc(id) {
        const key = name + '/' + id;
        return {
          _key: key, id,
          async get() {
            const d = docs.get(key);
            return { exists: !!d, id, data: () => (d ? Object.assign({}, d) : undefined) };
          },
          async set(v) { docs.set(key, Object.assign({}, v)); },
        };
      },
      where(field, op, value) {
        const next = coll(name);
        next._wheres = this._wheres.concat([[field, op, value]]);
        return next;
      },
      limit() { return this; },
      async get() {
        if (fail) throw new Error('simulated Firestore outage');
        const rows = [];
        for (const [k, v] of docs.entries()) {
          if (!k.startsWith(name + '/')) continue;
          if (this._wheres.every(([f, , val]) => v[f] === val)) {
            rows.push({ id: k.slice(name.length + 1), data: () => Object.assign({}, v) });
          }
        }
        return { docs: rows, empty: rows.length === 0 };
      },
    };
  }
  return {
    _docs: docs,
    collection: coll,
    /* business-wallet moves money in a transaction; this mirrors Firestore closely enough
       to catch the mistake that matters — all reads before any write. */
    async runTransaction(fn) {
      const writes = [];
      const tx = {
        async get(ref) { return ref.get(); },
        set(ref, v) { writes.push([ref._key, v, false]); },
        update(ref, v) { writes.push([ref._key, v, true]); },
        /* M0-1: create() must FAIL when the document exists, as Firestore's does — a fake
           that let it overwrite would certify a double debt as a single one. */
        create(ref, v) { writes.push([ref._key, v, 'create']); },
      };
      const out = await fn(tx);
      for (const [key] of writes.filter((w) => w[2] === 'create')) {
        if (docs.has(key)) { const e = new Error('ALREADY_EXISTS: ' + key); e.code = 6; throw e; }
      }
      for (const [key, v, merge] of writes) {
        docs.set(key, merge === true ? Object.assign({}, docs.get(key) || {}, v) : Object.assign({}, v));
      }
      return out;
    },
    batch() {
      const ops = [];
      return {
        set(ref, v) { ops.push(['set', ref, v]); },
        update(ref, v) { ops.push(['update', ref, v]); },
        async commit() {
          for (const [op, ref, v] of ops) {
            const key = ref._key || null;
            void key;
            if (op === 'set') await ref.set(v);
            else {
              const cur = (await ref.get()).data() || {};
              await ref.set(Object.assign({}, cur, v));
            }
          }
        },
      };
    },
  };
}

const MERCHANT = 'MERCH_A_uid_7f3';           /* never equal to a shop or sale id */
/* The shop is a DIFFERENT id from the account, deliberately: a fixture where they are
   equal would pass even if the code substituted one for the other, and the business
   wallet is keyed by shop while the liability is keyed by account. */
const SHOP = 'SHOP_B_shop_91c';
const eat = (iso) => Date.parse(iso + '+03:00');
const KES = (n) => MA.fromMinor(Math.round(n * 100));

const sale = (id, kes, rail, atMs) => P.planSaleCommission({
  rail, gross: KES(kes), planId: 'seller_free', soldAtMs: atMs,
  saleId: id, merchantUid: MERCHANT,
});

(async () => {

console.log('\nPART A — a sale becomes a collectible liability\n');
{
  const db = makeDb();
  const rec = sale('SALE_1', 1000, 'POS_CASH', eat('2026-09-05T10:00:00'));
  const w = await R.recordSaleLiability(db, rec);
  ck('A1  a cash sale writes a liability', w.action === 'recorded', w.action);
  ck('A2  ...at 5% of KES 1,000 = KES 50', w.liabilityMinor === 5000, String(w.liabilityMinor));
  ck('A3  ...on the sale date settlement day', w.settlementDay === '2026-09-05', w.settlementDay);

  /* M0-1 (owner ruling 2026-09-27): the id is DERIVED from the sale — poscomm_<saleId>. */
  const row = db._docs.get('posCommissionLiabilities/poscomm_SALE_1');
  ck('A4  the document id is derived from the sale id (poscomm_<saleId>)', !!row);
  ck('A5  the amount field names its unit', typeof row.liabilityMinor === 'number' && !('amount' in row));
  ck('A6  rate provenance is frozen on the row',
    row.rateFraction === 0.05 && row.plan === 'seller_free' && !!row.rateSource, row.rateSource);
  ck('A7  it starts OUTSTANDING with no settlement reference',
    row.status === 'OUTSTANDING' && row.settlementRef === null);
}
{
  /* PROPERTY 2 — one sale, one liability. */
  const db = makeDb();
  const rec = sale('SALE_1', 1000, 'POS_CASH', eat('2026-09-05T10:00:00'));
  await R.recordSaleLiability(db, rec);
  const again = await R.recordSaleLiability(db, rec);
  ck('A8  a retried sale does NOT bill twice', again.action === 'already_recorded', again.action);
  const gate = await R.evaluateMerchantGate(db, MERCHANT, eat('2026-09-05T11:00:00'));
  ck('A9  ...and the outstanding total is still KES 50',
    gate.totalOutstanding.minorUnits === 5000, String(gate.totalOutstanding.minorUnits));
}
{
  /* PROPERTY 3 — custodial sales were already netted. */
  const db = makeDb();
  const rec = sale('SALE_C', 1000, 'POS_MPESA_STK', eat('2026-09-05T10:00:00'));
  const w = await R.recordSaleLiability(db, rec);
  ck('A10 a CUSTODIAL sale writes NO liability row', w.action === 'none', w.action);
  ck('A11 ...and no zero-value row is left behind', db._docs.size === 0, String(db._docs.size));
}

console.log('\nPART B — the 07:00 gate, over the ledger rather than over an argument\n');
{
  const db = makeDb();
  await R.recordSaleLiability(db, sale('S1', 1000, 'POS_CASH', eat('2026-09-05T10:00:00')));

  const sameDay = await R.evaluateMerchantGate(db, MERCHANT, eat('2026-09-05T18:00:00'));
  ck('B1  today\'s accrual does NOT close the gate', sameDay.closed === false);
  ck('B2  ...it is reported as accruing, not overdue',
    sameDay.accruingToday.minorUnits === 5000 && sameDay.overdue.minorUnits === 0,
    'accruing=' + sameDay.accruingToday.minorUnits + ' overdue=' + sameDay.overdue.minorUnits);

  const beforeGate = await R.evaluateMerchantGate(db, MERCHANT, eat('2026-09-06T06:59:00'));
  ck('B3  at 06:59 the next morning the gate is still OPEN', beforeGate.closed === false);

  const afterGate = await R.evaluateMerchantGate(db, MERCHANT, eat('2026-09-06T07:00:00'));
  ck('B4  at 07:00 it CLOSES on yesterday\'s unpaid commission', afterGate.closed === true);
  ck('B5  ...naming the amount and the day',
    afterGate.overdue.minorUnits === 5000 && afterGate.overdueDays[0] === '2026-09-05',
    afterGate.reason);
}
{
  const db = makeDb();
  await R.recordSaleLiability(db, sale('S1', 1000, 'POS_CASH', eat('2026-09-05T10:00:00')));
  let threw = null;
  try { await R.assertGateOpen(db, MERCHANT, eat('2026-09-06T07:30:00')); }
  catch (e) { threw = e; }
  ck('B6  assertGateOpen THROWS once the gate has closed', !!threw && threw.code === 'POS_GATE_CLOSED',
    threw && threw.code);
  ck('B7  ...carrying the amount owed, so the caller need not recompute it',
    threw && threw.details && threw.details.overdueMinor === 5000,
    threw && threw.details && String(threw.details.overdueMinor));

  const ok = await R.assertGateOpen(db, MERCHANT, eat('2026-09-05T23:00:00'));
  ck('B8  ...and RETURNS the gate state while it is open', ok.closed === false);
}
{
  /* Multiple unpaid days aggregate, and the gate names them all. */
  const db = makeDb();
  await R.recordSaleLiability(db, sale('S1', 1000, 'POS_CASH',   eat('2026-09-03T10:00:00')));
  await R.recordSaleLiability(db, sale('S2', 2000, 'TILL_DIRECT', eat('2026-09-04T10:00:00')));
  await R.recordSaleLiability(db, sale('S3', 4000, 'POS_CASH',   eat('2026-09-05T10:00:00')));
  const g = await R.evaluateMerchantGate(db, MERCHANT, eat('2026-09-06T08:00:00'));
  ck('B9  three unpaid days are all overdue at 07:00 on the 6th',
    g.overdueDays.length === 3, g.overdueDays.join(','));
  ck('B10 ...totalling 5% of KES 7,000 = KES 350',
    g.overdue.minorUnits === 35000, String(g.overdue.minorUnits));
  ck('B11 Till and POS are collected on the SAME rail',
    g.unpaid.some((u) => u.settlementDay === '2026-09-04'));
}

console.log('\nPART C — unreadable is NOT zero (the property that matters most)\n');
{
  const db = makeDb({ failReads: true });
  let threw = null;
  try { await R.evaluateMerchantGate(db, MERCHANT, Date.now()); } catch (e) { threw = e; }
  ck('C1  a failed liability read THROWS', !!threw, threw && threw.code);
  ck('C2  ...with a code that says the ledger was unreadable',
    threw && threw.code === 'RAIL_LIABILITY_UNREADABLE', threw && threw.code);
  ck('C3  ...and never reports "owes nothing"',
    !!threw && !/owes nothing|KES 0/i.test(String(threw.message)), threw && threw.message);

  let threw2 = null;
  try { await R.assertGateOpen(db, MERCHANT, Date.now()); } catch (e) { threw2 = e; }
  ck('C4  an outage does NOT open the gate — assertGateOpen throws too', !!threw2);
}
{
  /* A corrupt row must not be silently skipped into a smaller bill. */
  const db = makeDb();
  await R.recordSaleLiability(db, sale('S1', 1000, 'POS_CASH', eat('2026-09-05T10:00:00')));
  db._docs.get('posCommissionLiabilities/poscomm_S1').liabilityMinor = 'not-a-number';
  let threw = null;
  try { await R.evaluateMerchantGate(db, MERCHANT, eat('2026-09-06T08:00:00')); } catch (e) { threw = e; }
  ck('C5  an unreadable ROW throws rather than shrinking the bill',
    !!threw && threw.code === 'RAIL_LIABILITY_UNREADABLE', threw && threw.code);
}

console.log('\nPART D — payable at ANY time, and an intent is not a collection\n');
{
  const db = makeDb();
  await R.recordSaleLiability(db, sale('S1', 1000, 'POS_CASH', eat('2026-09-05T10:00:00')));

  /* The merchant clears today's accrual at 14:00, long before it is ever due. */
  const mid = await R.evaluateMerchantGate(db, MERCHANT, eat('2026-09-05T14:00:00'));
  ck('D1  today\'s not-yet-due accrual is still reported as payable',
    mid.totalOutstanding.minorUnits === 5000 && mid.closed === false,
    'outstanding=' + mid.totalOutstanding.minorUnits);

  const res = await R.applySettlement(db, {
    merchantUid: MERCHANT, settlementDays: ['2026-09-05'],
    settlementRef: 'MPESA_ABC123', method: 'MPESA', nowMs: eat('2026-09-05T14:01:00'),
  });
  ck('D2  an early settlement clears it', res.action === 'settled' && res.settledMinor === 5000,
    res.action + '/' + res.settledMinor);

  const after = await R.evaluateMerchantGate(db, MERCHANT, eat('2026-09-06T08:00:00'));
  ck('D3  ...so the next morning the gate does NOT close', after.closed === false);
  ck('D4  ...and nothing is outstanding', after.totalOutstanding.minorUnits === 0);
}
{
  const db = makeDb();
  await R.recordSaleLiability(db, sale('S1', 1000, 'POS_CASH', eat('2026-09-05T10:00:00')));
  let threw = null;
  try {
    await R.applySettlement(db, { merchantUid: MERCHANT, settlementDays: ['2026-09-05'] });
  } catch (e) { threw = e; }
  ck('D5  settling WITHOUT an authoritative reference is refused',
    !!threw && threw.code === 'RAIL_NO_SETTLEMENT_REF', threw && threw.code);
  const still = await R.evaluateMerchantGate(db, MERCHANT, eat('2026-09-06T08:00:00'));
  ck('D6  ...and the liability is untouched', still.overdue.minorUnits === 5000);
}
{
  /* PROPERTY 4 — a replayed webhook must not clear a second day. */
  const db = makeDb();
  await R.recordSaleLiability(db, sale('S1', 1000, 'POS_CASH', eat('2026-09-04T10:00:00')));
  await R.recordSaleLiability(db, sale('S2', 1000, 'POS_CASH', eat('2026-09-05T10:00:00')));
  const first = await R.applySettlement(db, { merchantUid: MERCHANT,
    settlementDays: ['2026-09-04'], settlementRef: 'REF_1', method: 'MPESA' });
  const replay = await R.applySettlement(db, { merchantUid: MERCHANT,
    settlementDays: ['2026-09-05'], settlementRef: 'REF_1', method: 'MPESA' });
  ck('D7  the first application settles one day', first.action === 'settled' && first.rowsSettled === 1);
  ck('D8  a REPLAY of the same reference is a no-op, not a second day cleared',
    replay.action === 'already_applied', replay.action);
  const g = await R.evaluateMerchantGate(db, MERCHANT, eat('2026-09-06T08:00:00'));
  ck('D9  ...so the 5th is still owed', g.overdue.minorUnits === 5000, String(g.overdue.minorUnits));
}
{
  const db = makeDb();
  await R.recordSaleLiability(db, sale('S1', 1000, 'POS_CASH', eat('2026-09-05T10:00:00')));
  const res = await R.applySettlement(db, { merchantUid: MERCHANT,
    settlementDays: ['2026-09-01'], settlementRef: 'REF_X' });
  ck('D10 settling a day with nothing outstanding reports exactly that',
    res.action === 'nothing_outstanding' && res.settledMinor === 0, res.action);
}

console.log('\nPART E — the settled row carries its proof\n');
{
  const db = makeDb();
  await R.recordSaleLiability(db, sale('S1', 1000, 'POS_CASH', eat('2026-09-05T10:00:00')));
  await R.applySettlement(db, { merchantUid: MERCHANT, settlementDays: ['2026-09-05'],
    settlementRef: 'MPESA_XYZ', method: 'MPESA', nowMs: 1757000000000 });
  const row = db._docs.get('posCommissionLiabilities/poscomm_S1');
  ck('E1  the liability is SETTLED', row.status === 'SETTLED', row.status);
  ck('E2  ...against the authoritative reference', row.settlementRef === 'MPESA_XYZ');
  ck('E3  ...with a settlement time', row.settledAtMs === 1757000000000);
  const receipt = db._docs.get('posCommissionSettlements/MPESA_XYZ');
  ck('E4  a settlement receipt exists', !!receipt);
  ck('E5  ...naming the merchant, amount and days',
    receipt.merchantUid === MERCHANT && receipt.settledMinor === 5000 &&
    receipt.settlementDays[0] === '2026-09-05');
}

console.log('\nPART F — adversarial controls\n');
{
  /* If the fixture could not produce a liability, every assertion above is vacuous. */
  const db = makeDb();
  const before = db._docs.size;
  await R.recordSaleLiability(db, sale('S_probe', 1000, 'POS_CASH', eat('2026-09-05T10:00:00')));
  /* M0-1: one sale writes exactly TWO documents — the debt and its ledger projection. */
  ck('F1  the harness actually writes documents (the debt + its ledger projection, nothing else)',
    db._docs.size === before + 2 && db._docs.has('posCommissionLiabilities/poscomm_S_probe') && db._docs.has('ledger/poscomm_S_probe'),
    String(db._docs.size - before));

  /* The gate must be able to say BOTH answers, or "closed" proves nothing. */
  const open = await R.evaluateMerchantGate(db, MERCHANT, eat('2026-09-05T12:00:00'));
  const shut = await R.evaluateMerchantGate(db, MERCHANT, eat('2026-09-06T09:00:00'));
  ck('F2  the same ledger yields OPEN and CLOSED at different clocks',
    open.closed === false && shut.closed === true);

  /* A merchant is never gated by somebody else's debt. */
  const other = await R.evaluateMerchantGate(db, 'SOMEONE_ELSE', eat('2026-09-06T09:00:00'));
  ck('F3  another merchant is unaffected', other.closed === false && other.rowCount === 0);

  /* The rate must come from the POS lane, not the marketplace ladder. */
  const rec = sale('S_rate', 1000, 'POS_CASH', eat('2026-09-05T10:00:00'));
  ck('F4  a FREE merchant is charged the POS 5%, not the marketplace 15%',
    rec.rateFraction === 0.05 && rec.liability.minorUnits === 5000,
    rec.rateFraction + ' / ' + rec.liability.minorUnits);
}

console.log('\nPART G — settling from the BUSINESS wallet (never the personal one)\n');
{
  /* THE ORDER PROPERTY, PROVED. Every other case in this part throws in the PLAN step,
     before either side effect runs — so the order of "debit" and "mark settled" never
     mattered there, and swapping the two statements passed the entire suite. This is the
     case that separates them: the plan succeeds and the DEBIT fails.

       debit first (correct)   money not taken, rows not cleared  -> liability stands
       settle first (wrong)    rows cleared, money not taken      -> a free day

     Found by sabotage. Without this test the safety property was asserted in a comment and
     nowhere else. */
  const db = makeDb();
  await BW.ensureBusinessWallet(db, { shopId: SHOP, ownerUid: MERCHANT });
  await BW.creditBusinessWallet(db, { shopId: SHOP, amountMinor: 100000, ref: 'FLOAT' });
  await R.recordSaleLiability(db, sale('S1', 1000, 'POS_CASH', eat('2026-09-05T10:00:00')));

  const brokenWallet = {
    getBusinessWallet: BW.getBusinessWallet,
    debitBusinessWallet: async () => { throw new Error('wallet service unavailable'); },
  };
  let threw = null;
  try {
    await R.settleFromBusinessWallet(db, { businessWallet: brokenWallet }, {
      merchantUid: MERCHANT, shopId: SHOP, nowMs: eat('2026-09-05T14:00:00') });
  } catch (e) { threw = e; }
  ck('G19 when the DEBIT fails, the settlement fails with it', !!threw, threw && threw.message);

  const g = await R.evaluateMerchantGate(db, MERCHANT, eat('2026-09-06T08:00:00'));
  ck('G20 ...and the liability is NOT cleared — no free day',
    g.overdue.minorUnits === 5000 && g.closed === true, String(g.overdue.minorUnits));
  ck('G21 ...and no settlement receipt was written',
    !Array.from(db._docs.keys()).some((k) => k.indexOf('posCommissionSettlements/') === 0));
}
{
  const db = makeDb();
  await BW.ensureBusinessWallet(db, { shopId: SHOP, ownerUid: MERCHANT });
  await BW.creditBusinessWallet(db, { shopId: SHOP, amountMinor: 100000, ref: 'FLOAT' });
  await R.recordSaleLiability(db, sale('S1', 1000, 'POS_CASH', eat('2026-09-05T10:00:00')));

  const res = await R.settleFromBusinessWallet(db, { businessWallet: BW }, {
    merchantUid: MERCHANT, shopId: SHOP, nowMs: eat('2026-09-05T14:00:00'),
  });
  ck('G1  a merchant can settle at ANY time, before the gate is ever due',
    res.action === 'settled' && res.settledMinor === 5000, res.action + '/' + res.settledMinor);
  ck('G2  the business wallet paid for it', res.walletBalanceMinor === 95000,
    String(res.walletBalanceMinor));
  ck('G3  the personal wallet was never touched', !db._docs.has('wallets/' + MERCHANT));

  const after = await R.evaluateMerchantGate(db, MERCHANT, eat('2026-09-06T08:00:00'));
  ck('G4  ...so the morning gate stays OPEN', after.closed === false);
}
{
  /* Insufficient float: refused with the exact shortfall, and NOTHING moves. */
  const db = makeDb();
  await BW.ensureBusinessWallet(db, { shopId: SHOP, ownerUid: MERCHANT });
  await BW.creditBusinessWallet(db, { shopId: SHOP, amountMinor: 3000, ref: 'FLOAT' });
  await R.recordSaleLiability(db, sale('S1', 1000, 'POS_CASH', eat('2026-09-05T10:00:00')));

  let threw = null;
  try {
    await R.settleFromBusinessWallet(db, { businessWallet: BW }, {
      merchantUid: MERCHANT, shopId: SHOP, nowMs: eat('2026-09-05T14:00:00') });
  } catch (e) { threw = e; }
  ck('G5  a short business wallet REFUSES a partial settlement',
    !!threw && threw.code === 'SETTLE_INSUFFICIENT_BALANCE', threw && threw.code);
  /* BOTH spellings must carry it. The pure module writes .detail, this module and the
     wallet write .details, and a settle screen will read whichever its author guessed —
     so the rail normalises and this asserts the normalisation, not one lucky spelling. */
  ck('G6  ...naming the exact shortfall (KES 50 due, KES 30 held -> KES 20)',
    threw && threw.details && threw.details.shortfallMinor === 2000,
    threw && threw.details && String(threw.details.shortfallMinor));
  ck('G6b ...under BOTH .detail and .details, so no caller loses it',
    threw && threw.detail && threw.detail.shortfallMinor === 2000 &&
    threw.details.shortfallMinor === threw.detail.shortfallMinor);
  ck('G7  ...and the wallet is untouched',
    db._docs.get('businessWallets/' + SHOP).balanceMinor === 3000);
  const still = await R.evaluateMerchantGate(db, MERCHANT, eat('2026-09-06T08:00:00'));
  ck('G8  ...and the liability still stands', still.overdue.minorUnits === 5000);
}
{
  /* THE ORDER PROPERTY. Debit happens before the rows are cleared, so a crash between the
     two is recoverable by calling again — never a free day. */
  const db = makeDb();
  await BW.ensureBusinessWallet(db, { shopId: SHOP, ownerUid: MERCHANT });
  await BW.creditBusinessWallet(db, { shopId: SHOP, amountMinor: 100000, ref: 'FLOAT' });
  await R.recordSaleLiability(db, sale('S1', 1000, 'POS_CASH', eat('2026-09-05T10:00:00')));

  const days = ['2026-09-05'];
  const ref = 'poscomm:' + MERCHANT + ':' + days.join('_');
  /* Simulate the crash: the debit landed, the settlement did not. */
  await BW.debitBusinessWallet(db, { shopId: SHOP, amountMinor: 5000, ref });
  const midBal = db._docs.get('businessWallets/' + SHOP).balanceMinor;
  const midGate = await R.evaluateMerchantGate(db, MERCHANT, eat('2026-09-06T08:00:00'));
  ck('G9  after a crash mid-settlement the money is taken and the gate is still CLOSED',
    midBal === 95000 && midGate.closed === true, 'bal=' + midBal + ' closed=' + midGate.closed);

  const retry = await R.settleFromBusinessWallet(db, { businessWallet: BW }, {
    merchantUid: MERCHANT, shopId: SHOP, settlementDays: days, nowMs: eat('2026-09-06T08:01:00') });
  ck('G10 calling again FINISHES the job', retry.action === 'settled', retry.action);
  ck('G11 ...and does NOT debit a second time',
    retry.debitAction === 'already_applied' &&
    db._docs.get('businessWallets/' + SHOP).balanceMinor === 95000,
    retry.debitAction + ' bal=' + db._docs.get('businessWallets/' + SHOP).balanceMinor);
  const done = await R.evaluateMerchantGate(db, MERCHANT, eat('2026-09-06T08:02:00'));
  ck('G12 ...and the gate is now open', done.closed === false);
}
{
  /* No business wallet: refused, and NEVER redirected to the personal wallet. */
  const db = makeDb();
  await R.recordSaleLiability(db, sale('S1', 1000, 'POS_CASH', eat('2026-09-05T10:00:00')));
  let threw = null;
  try {
    await R.settleFromBusinessWallet(db, { businessWallet: BW }, {
      merchantUid: MERCHANT, shopId: SHOP, nowMs: eat('2026-09-05T14:00:00') });
  } catch (e) { threw = e; }
  ck('G13 with no business wallet, settlement is REFUSED',
    !!threw && threw.code === 'RAIL_NO_BUSINESS_WALLET', threw && threw.code);
  ck('G14 ...and the refusal says a personal wallet is never used',
    !!threw && /never from a personal one/i.test(threw.message));
}
{
  /* A wallet owned by someone else must not pay this merchant's debt. */
  const db = makeDb();
  await BW.ensureBusinessWallet(db, { shopId: SHOP, ownerUid: 'SOMEONE_ELSE' });
  await BW.creditBusinessWallet(db, { shopId: SHOP, amountMinor: 100000, ref: 'FLOAT' });
  await R.recordSaleLiability(db, sale('S1', 1000, 'POS_CASH', eat('2026-09-05T10:00:00')));
  let threw = null;
  try {
    await R.settleFromBusinessWallet(db, { businessWallet: BW }, {
      merchantUid: MERCHANT, shopId: SHOP, nowMs: eat('2026-09-05T14:00:00') });
  } catch (e) { threw = e; }
  ck('G15 a business wallet owned by someone else cannot pay this debt',
    !!threw && threw.code === 'SETTLE_WALLET_NOT_OWNED', threw && threw.code);
  ck('G16 ...and their balance is untouched',
    db._docs.get('businessWallets/' + SHOP).balanceMinor === 100000);
}
{
  /* Settling only ONE of several days is honoured exactly. */
  const db = makeDb();
  await BW.ensureBusinessWallet(db, { shopId: SHOP, ownerUid: MERCHANT });
  await BW.creditBusinessWallet(db, { shopId: SHOP, amountMinor: 100000, ref: 'FLOAT' });
  await R.recordSaleLiability(db, sale('S1', 1000, 'POS_CASH', eat('2026-09-04T10:00:00')));
  await R.recordSaleLiability(db, sale('S2', 2000, 'POS_CASH', eat('2026-09-05T10:00:00')));
  const res = await R.settleFromBusinessWallet(db, { businessWallet: BW }, {
    merchantUid: MERCHANT, shopId: SHOP, settlementDays: ['2026-09-04'],
    nowMs: eat('2026-09-06T08:00:00') });
  ck('G17 settling one named day charges only that day', res.settledMinor === 5000,
    String(res.settledMinor));
  const g = await R.evaluateMerchantGate(db, MERCHANT, eat('2026-09-06T08:01:00'));
  ck('G18 ...and the other day is still owed', g.overdue.minorUnits === 10000,
    String(g.overdue.minorUnits));
}

console.log('\nPART H — the early reminder: who gets warned, an hour before the gate\n');
{
  /* The reminder selection is loaded from SOURCE rather than by requiring the module,
     because pos-commission-surface.js pulls the Cloud Functions runtime. What is under test
     is the selection rule, and it is pure. */
  const fs2 = require('fs');
  const src = fs2.readFileSync(path.join(FN, 'pos-commission-surface.js'), 'utf8');
  const m = src.match(/function selectMerchantsToRemind[\s\S]*?\n\}/);
  const select = m ? new Function('S', 'return ' + m[0])(S) : null;
  ck('H0  the selection function was found in source (the detector can see)', !!select);

  /* 06:00 EAT on the 6th. THE OFF-BY-ONE: the settlement day rolls at 07:00, not midnight,
     so at 06:00 on the 6th the current settlement day is still 2026-09-05 — and ITS gate
     closes at 07:00 on the 6th, one hour from now. That is the cohort to warn. */
  const at6am = eat('2026-09-06T06:00:00');
  ck('H1  at 06:00 the settlement day is still the previous one',
    S.settlementDayFor(at6am) === '2026-09-05', S.settlementDayFor(at6am));
  ck('H2  ...and its gate closes exactly one hour later',
    S.gateClosesAt('2026-09-05') - at6am === 60 * 60 * 1000,
    String((S.gateClosesAt('2026-09-05') - at6am) / 60000) + ' minutes');

  const rows = [
    { merchantUid: 'M1', settlementDay: '2026-09-05', liabilityMinor: 5000 },
    { merchantUid: 'M1', settlementDay: '2026-09-04', liabilityMinor: 3000 },
    { merchantUid: 'M2', settlementDay: '2026-09-06', liabilityMinor: 9999 },
    { merchantUid: 'M3', settlementDay: '2026-09-05', liabilityMinor: 0 },
    { merchantUid: 'M4', settlementDay: '2026-09-03', liabilityMinor: 12000 },
  ];
  const out = select(rows, at6am);
  const m1 = out.find((t) => t.merchantUid === 'M1');

  ck('H3  the merchant about to be gated IS warned, including the day closing in an hour',
    !!m1 && m1.outstandingMinor === 8000, m1 && String(m1.outstandingMinor));
  ck('H4  ...naming every day they owe for', !!m1 && m1.days.length === 2, m1 && m1.days.join(','));
  ck('H5  a day that cannot exist yet is skipped', !out.some((t) => t.merchantUid === 'M2'));
  ck('H6  a zero liability raises no reminder', !out.some((t) => t.merchantUid === 'M3'));
  ck('H7  a merchant who owes nothing is not in the list', !out.some((t) => t.merchantUid === 'M9'));
  ck('H8  the largest debt is reported first', out[0] && out[0].merchantUid === 'M4', out[0] && out[0].merchantUid);

  /* ADVERSARIAL: the regression this replaced. Skipping `settlementDay >= today` warned
     only merchants ALREADY overdue and stayed silent for everyone about to be gated within
     the hour — silence for the entire purpose of the feature. */
  const wouldHaveMissed = rows
    .filter((r) => r.merchantUid === 'M1' && r.settlementDay === '2026-09-05')
    .every((r) => r.settlementDay >= S.settlementDayFor(at6am));
  ck('H9  CONTROL: the old rule would have excluded the about-to-be-gated day',
    wouldHaveMissed === true);
  ck('H10 ...and the current rule includes it', m1.days.indexOf('2026-09-05') !== -1);

  /* A merchant with only TODAY'S accrual, hours before any gate, must not be nagged. */
  const midday = eat('2026-09-05T12:00:00');
  const only = select([{ merchantUid: 'M5', settlementDay: '2026-09-05', liabilityMinor: 4000 }], midday);
  ck('H11 mid-afternoon, the day still being accrued is still warned about (it closes at the next 07:00)',
    only.length === 1 && only[0].outstandingMinor === 4000, JSON.stringify(only));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nsuite crashed:', e.stack, '\n'); process.exit(1); });
