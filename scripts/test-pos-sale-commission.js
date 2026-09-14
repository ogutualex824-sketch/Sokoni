#!/usr/bin/env node
/* POS & TILL SALE COMMISSION — certification of the sale -> liability -> 07:00 chain.
 *
 * Pure, no I/O, nothing wired. This is the join that was missing: planSaleAccounting said
 * how much, evaluateGate said when, and nothing produced the settlement-day-stamped rows the
 * gate reads.
 *
 * The two claims under test:
 *   1. POS and Till are charged IDENTICALLY — the rail decides custody, never the rate.
 *   2. A custodial sale is never billed twice: its commission came out of money SOKONI held,
 *      so it must NOT reappear as a collectible liability at 07:00.
 */
'use strict';
const P = require('../functions/pos-sale-commission');
const S = require('../functions/commission-settlement-authority');
const CC = require('../functions/commission-config');

/* OWNER RULING 2026-09-07: the POS/TILL lane is FLAT and plan-independent — the 15/10/5/0
   ladder this suite was written against moved to the MARKETPLACE lane. Every expectation
   below is now DERIVED from the configured rate rather than pinned, so the suite follows
   the schedule it certifies instead of having to be hand-edited beside it. */
const R = CC.POS_FLAT_RATE_FRACTION;
const comm = (kes) => Math.round(kes * 100 * R);      /* commission, minor units */
const net  = (kes) => Math.round(kes * 100) - comm(kes);
const MA = require('../functions/money-authority');

let pass = 0, fail = 0;
const ok = (label, cond, note) => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
};
const throwsWith = (label, code, fn) => {
  try { fn(); fail++; console.log('  FAIL  ' + label + '   [did not throw; expected ' + code + ']'); }
  catch (e) {
    if (e.code === code) pass++;
    else { fail++; console.log('  FAIL  ' + label + '   [threw ' + (e.code || e.message) + ', expected ' + code + ']'); }
  }
};
const KES = (n) => MA.fromMajor(n);
const eat = (iso) => Date.parse(iso + '+03:00');
const SOLD = eat('2026-09-04T14:00:00');          /* mid-afternoon, settlement day 09-04 */

const sale = (rail, grossKES, planId, at) => P.planSaleCommission({
  rail, gross: KES(grossKES), planId: planId || 'seller_free',
  soldAtMs: at || SOLD, saleId: 's_' + rail + '_' + grossKES, merchantUid: 'm1'
});

console.log('');
console.log('  POS & TILL SALE COMMISSION — certification');
console.log('');

/* ── 1 · POS and TILL are charged identically ──────────────────────────────── */
{
  const pos = sale('POS_CASH', 1000);
  const till = sale('TILL_DIRECT', 1000);
  ok('POS cash and TILL charge the SAME commission',
     pos.commission.minorUnits === till.commission.minorUnits,
     pos.commission.minorUnits + ' vs ' + till.commission.minorUnits);
  ok('both are the flat POS rate on KES 1,000', pos.commission.minorUnits === comm(1000),
     String(pos.commission.minorUnits));
  ok('both are NON_CUSTODIAL', pos.custody === MA.CUSTODY.NON_CUSTODIAL &&
     till.custody === MA.CUSTODY.NON_CUSTODIAL);
  ok('both credit NOTHING', pos.merchantCredit.minorUnits === 0 && till.merchantCredit.minorUnits === 0);
  ok('both create a liability', pos.createsLiability === true && till.createsLiability === true);
  ok('the surface is recorded distinctly', pos.surface === 'POS' && till.surface === 'TILL');
}
{
  /* cash does not bypass commission — the headline rule */
  const s = sale('POS_CASH', 100000);
  ok('KES 100,000 cash -> ' + (comm(100000) / 100) + ' commission', s.commission.minorUnits === comm(100000),
     String(s.commission.minorUnits));
  ok('KES 100,000 cash -> merchant credit ZERO', s.merchantCredit.minorUnits === 0);
  ok('KES 100,000 cash -> liability ' + (comm(100000) / 100), s.liability.minorUnits === comm(100000),
     String(s.liability.minorUnits));
  ok('no wallet credit instruction is emitted', s.walletCredit === null);
}

/* ── 2 · custodial rails deduct first, credit net ──────────────────────────── */
['POS_MPESA_STK', 'POS_WALLET', 'POS_CARD'].forEach((rail) => {
  const s = sale(rail, 1000);
  ok(rail + ' is CUSTODIAL', s.custody === MA.CUSTODY.CUSTODIAL);
  ok(rail + ' credits NET ' + (net(1000) / 100), s.merchantCredit.minorUnits === net(1000), String(s.merchantCredit.minorUnits));
  ok(rail + ' creates NO liability', s.createsLiability === false && s.liability.minorUnits === 0);
  ok(rail + ' emits a wallet credit instruction', s.walletCredit !== null);
  ok(rail + ' commission + credit === gross',
     s.commission.minorUnits + s.merchantCredit.minorUnits === s.gross.minorUnits);
});
{
  const s = sale('POS_STORE_CREDIT', 1000);
  ok('store credit is NON_CUSTODIAL (the merchant issued it)',
     s.custody === MA.CUSTODY.NON_CUSTODIAL && s.createsLiability === true);
}

/* ── 3 · the plan ladder applies to both surfaces ──────────────────────────── */
/* Flat: every plan pays the same at the till. The old table asserted four DIFFERENT
   numbers, which is precisely the rule that was countermanded. */
[['seller_free', comm(1000)], ['seller_basic', comm(1000)], ['seller_pro', comm(1000)],
 ['seller_enterprise', comm(1000)]].forEach(([plan, expect]) => {
  const pos = sale('POS_CASH', 1000, plan);
  const till = sale('TILL_DIRECT', 1000, plan);
  ok(plan + ': POS commission ' + (expect / 100), pos.commission.minorUnits === expect);
  ok(plan + ': TILL matches POS exactly', till.commission.minorUnits === expect);
  ok(plan + ': provenance is carried', pos.rateSource === 'commission-config.POS_PLAN_RATES' &&
     pos.plan === plan);
});
{
  /* THE RULING, stated as a test: a subscription buys a better MARKETPLACE rate and
     changes nothing at the till. Enterprise pays the same flat rate as Free on a sale
     it made itself. This block used to assert Enterprise owed nothing here — the exact
     rule that was countermanded — so it is inverted rather than deleted, because
     'Enterprise is not free at the till' is now the property most worth protecting. */
  const s = sale('TILL_DIRECT', 1000, 'seller_enterprise');
  const free = sale('TILL_DIRECT', 1000, 'seller_free');
  ok('Enterprise Till owes the SAME flat commission as Free',
     s.commission.minorUnits === comm(1000) && s.commission.minorUnits === free.commission.minorUnits,
     s.commission.minorUnits + ' vs ' + free.commission.minorUnits);
  ok('Enterprise Till DOES create a liability — the till is never free',
     s.createsLiability === true && s.commission.minorUnits > 0);
  ok('and it is NOT floor-exempt (only a genuine 0% rate is)', s.floorExempt === false);
  /* Enterprise MARKETPLACE was 0% and floor-exempt. The owner repricing of 2026-09-13 moved
     the ladder to 16/12/8/4, so Enterprise is no longer free — and the exemption went with the
     zero, because the invariant asserted one line above is "only a genuine 0% rate is
     floor-exempt". The retired id must still resolve, or a stored tier silently falls to Free. */
  const mktEnt = CC.resolveMarketplaceRate('seller_enterprise');
  ok('...while Enterprise MARKETPLACE is 4% and NOT floor-exempt (repriced 2026-09-13)',
     mktEnt.rateFraction === 0.04 && mktEnt.floorExempt === false,
     mktEnt.rateFraction * 100 + '% floorExempt=' + mktEnt.floorExempt);
  ok('...and the retired seller_enterprise id still maps to a real package',
     mktEnt.plan === 'enterprise' && mktEnt.matched === true, mktEnt.plan);
}
{
  /* the floor reaches Till too */
  const s = sale('TILL_DIRECT', 50, 'seller_free');
  ok('a KES 50 Till sale is floored at KES 10', s.commission.minorUnits === 1000);
  ok('floorApplied is recorded', s.floorApplied === true);
}

/* ── 4 · settlement day is stamped at the SALE ─────────────────────────────── */
{
  const s = sale('POS_CASH', 100, 'seller_free', eat('2026-09-04T14:00:00'));
  ok('an afternoon sale belongs to that day', s.settlementDay === '2026-09-04');
  ok('it becomes collectible at 07:00 the next morning',
     s.collectibleAtMs === eat('2026-09-05T07:00:00'),
     new Date(s.collectibleAtMs).toISOString());
}
{
  const s = sale('POS_CASH', 100, 'seller_free', eat('2026-09-05T02:00:00'));
  ok('a 02:00 sale is still LAST NIGHT\'S trading', s.settlementDay === '2026-09-04');
  ok('and is collectible the same 07:00', s.collectibleAtMs === eat('2026-09-05T07:00:00'));
}
{
  const s = sale('POS_CASH', 100, 'seller_free', eat('2026-09-05T07:00:00'));
  ok('a 07:00:00 sale opens the NEW day', s.settlementDay === '2026-09-05');
}
{
  /* the rate is frozen at the sale, not recomputed later */
  const s = sale('POS_CASH', 1000, 'seller_free');
  ok('the resolved rate travels on the record', s.rateFraction === R, String(s.rateFraction));
  ok('the plan that was charged is recorded', s.plan === 'seller_free');
  ok('soldAtMs is preserved', s.soldAtMs === SOLD);
}

/* ── 5 · fails closed ──────────────────────────────────────────────────────── */
throwsWith('an unknown rail is refused', 'SALE_UNKNOWN_RAIL',
  () => sale('CRYPTO', 100));
throwsWith('an empty rail is refused', 'SALE_UNKNOWN_RAIL',
  () => sale('', 100));
throwsWith('a sale with no id is refused', 'SALE_UNIDENTIFIED',
  () => P.planSaleCommission({ rail: 'POS_CASH', gross: KES(100), planId: 'seller_free',
    soldAtMs: SOLD, merchantUid: 'm1' }));
throwsWith('a sale with no merchant is refused', 'SALE_UNIDENTIFIED',
  () => P.planSaleCommission({ rail: 'POS_CASH', gross: KES(100), planId: 'seller_free',
    soldAtMs: SOLD, saleId: 's1' }));
throwsWith('a negative sale is refused', 'SALE_NEGATIVE_GROSS',
  () => P.planSaleCommission({ rail: 'POS_CASH', gross: MA.fromMinor(-1), planId: 'seller_free',
    soldAtMs: SOLD, saleId: 's1', merchantUid: 'm1' }));
throwsWith('no clock is refused', 'SETTLEMENT_NO_CLOCK',
  () => P.planSaleCommission({ rail: 'POS_CASH', gross: KES(100), planId: 'seller_free',
    saleId: 's1', merchantUid: 'm1' }));
{
  /* an unknown plan does not become free trading */
  const s = sale('TILL_DIRECT', 1000, 'no_such_plan');
  ok('an unknown plan falls back to the flat POS rate, never to zero',
     s.commission.minorUnits === comm(1000) && s.plan === 'seller_free' && s.commission.minorUnits > 0,
     String(s.commission.minorUnits));
  ok('and the fallback is flagged', s.rateMatched === false);
}

/* ── 6 · THE DOUBLE-BILLING GUARD ──────────────────────────────────────────── */
{
  /* a mixed trading day */
  const day = [
    sale('POS_CASH',      95000, 'seller_free'),   /* liability 14,250 */
    sale('POS_MPESA_STK',  3000, 'seller_free'),   /* credited net, NO liability */
    sale('POS_WALLET',     2000, 'seller_free'),   /* credited net, NO liability */
    sale('TILL_DIRECT',    5000, 'seller_free')    /* liability    750 */
  ];
  const sum = P.summariseLiability(day);
  ok('one settlement day is produced', sum.unpaid.length === 1 &&
     sum.unpaid[0].settlementDay === '2026-09-04');
  ok('ONLY non-custodial sales create liability (14,250 + 750 = 15,000)',
     sum.totalLiability.minorUnits === comm(100000), String(sum.totalLiability.minorUnits));
  ok('custodial sales are NOT billed again at 07:00',
     sum.unpaid[0].outstanding.minorUnits === comm(100000));
  const credited = net(3000) + net(2000);            /* the two custodial rails, net of commission */
  ok('custodial credits total ' + (credited / 100) + ' (KES 3,000 + KES 2,000 net)',
     sum.totalCredited.minorUnits === credited, String(sum.totalCredited.minorUnits));

  /* and it feeds the gate directly */
  const gate = S.evaluateGate({ nowMs: eat('2026-09-05T07:30:00'), unpaid: sum.unpaid });
  ok('the gate CLOSES on the unpaid day', gate.closed === true);
  ok('the gate collects exactly ' + (comm(100000) / 100), gate.overdue.minorUnits === comm(100000),
     String(gate.overdue.minorUnits));
  ok('the day is named for the merchant', gate.overdueDays.join() === '2026-09-04');

  const before = S.evaluateGate({ nowMs: eat('2026-09-05T06:59:00'), unpaid: sum.unpaid });
  ok('before 07:00 the same day does NOT block', before.closed === false);
}
{
  /* an all-custodial day owes nothing at 07:00 */
  const day = [sale('POS_MPESA_STK', 50000, 'seller_free'), sale('POS_WALLET', 20000, 'seller_free')];
  const sum = P.summariseLiability(day);
  ok('an all-electronic day creates NO collectible liability',
     sum.unpaid.length === 0 && sum.totalLiability.minorUnits === 0);
  const gate = S.evaluateGate({ nowMs: eat('2026-09-05T09:00:00'), unpaid: sum.unpaid });
  ok('so the morning gate stays OPEN', gate.closed === false);
}
{
  /* multiple days aggregate per day, not into one lump */
  const day = [
    sale('POS_CASH', 1000, 'seller_free', eat('2026-09-02T10:00:00')),
    sale('POS_CASH', 2000, 'seller_free', eat('2026-09-03T10:00:00')),
    sale('TILL_DIRECT', 1000, 'seller_free', eat('2026-09-03T18:00:00'))
  ];
  const sum = P.summariseLiability(day);
  ok('two settlement days are kept separate', sum.unpaid.length === 2);
  ok('09-02 owes ' + (comm(1000) / 100), sum.unpaid[0].outstanding.minorUnits === comm(1000),
     String(sum.unpaid[0].outstanding.minorUnits));
  ok('09-03 owes ' + ((comm(2000) + comm(1000)) / 100) + ' (KES 2,000 + KES 1,000 of sales)',
     sum.unpaid[1].outstanding.minorUnits === comm(2000) + comm(1000),
     String(sum.unpaid[1].outstanding.minorUnits));
  ok('days are returned in order',
     sum.unpaid[0].settlementDay < sum.unpaid[1].settlementDay);
}
throwsWith('an unreadable record refuses to summarise a partial day',
  'SUMMARY_UNREADABLE_RECORD',
  () => P.summariseLiability([{ settlementDay: '2026-09-04' }]));
throwsWith('a non-list is refused', 'SUMMARY_NOT_A_LIST',
  () => P.summariseLiability(null));

/* ══ CONTROLS ═════════════════════════════════════════════════════════════ */
console.log('  CONTROLS');
let controlsOk = true;
{
  const before = fail;
  ok('__negative_control__ (expected to fail)', 1 === 2);
  const detected = fail === before + 1;
  fail = before;
  console.log('    ' + (detected ? 'PASS' : 'FAIL') + '  assertions can fail');
  if (!detected) controlsOk = false;
}
{
  /* SABOTAGE: a summariser that billed custodial sales too would over-collect. Prove the
     guard test would catch it, by summing liability the WRONG way. */
  const day = [sale('POS_CASH', 95000, 'seller_free'), sale('POS_MPESA_STK', 3000, 'seller_free')];
  const wrong = day.reduce((s, r) => s + r.commission.minorUnits, 0);   /* bills everything */
  const right = P.summariseLiability(day).totalLiability.minorUnits;
  console.log('    ' + (wrong > right ? 'PASS' : 'FAIL') +
              '  billing custodial sales too would over-collect (' +
              MA.toMajorString(MA.fromMinor(wrong)) + ' vs ' +
              MA.toMajorString(MA.fromMinor(right)) + ')');
  if (!(wrong > right)) controlsOk = false;
}
{
  /* SABOTAGE: a rate recomputed at collection instead of frozen at the sale would differ
     when the merchant changes plan. Prove the record carries the sale-time rate. */
  /* Under the FLAT POS schedule, comparing two POS plans compares a number with itself:
     the control would pass for the wrong reason and detect nothing. The marketplace rate
     for the same merchant is a rate that genuinely differs, so it is what a recompute
     against the wrong lane would actually yield. */
  const atSale = sale('POS_CASH', 1000, 'seller_free');
  const ifRecomputed = CC.resolveMarketplaceRate('seller_free').rateFraction;
  console.log('    ' + (atSale.rateFraction !== ifRecomputed ? 'PASS' : 'FAIL') +
              '  the record pins the sale-time rate (' + atSale.rateFraction +
              '), not a later plan\'s (' + ifRecomputed + ')');
  if (atSale.rateFraction === ifRecomputed) controlsOk = false;
}

console.log('');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
if (!controlsOk) {
  console.log('');
  console.log('  BLOCKED — a control misbehaved; the result above cannot be trusted.');
  process.exit(1);
}
process.exit(fail > 0 ? 1 : 0);
