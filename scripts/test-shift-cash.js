/* ══════════════════════════════════════════════════════════════════════════════
   OPENING CASH → SELL → DRAWER → CLOSE — certification
   ══════════════════════════════════════════════════════════════════════════════
   Two invariants carry real money, and neither may depend on a caller remembering
   them:

     1. OPENING CASH IS NOT REVENUE. The float is the merchant's own money, put in
        the drawer to make change. If it reaches sales, it inflates turnover,
        commission and merchant earnings — a platform-wide financial defect that
        would look like growth.

     2. M-PESA IS NOT CASH IN THE DRAWER. A phone payment is revenue but not
        physical money and cannot fund change. Counting it toward the drawer makes
        every till reconcile "over" and gets cashiers accused of nothing.

   Both are asserted with MUTATION CONTROLS: the defect is constructed deliberately
   and the assertion is shown to catch it. An invariant test that cannot fail is
   not evidence.

   This module also had to agree with the EXISTING cash manager rather than invent
   a second till arithmetic, so the formula is compared against the deployed one
   character for character.

   Run: node scripts/test-shift-cash.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const Cash = require(path.join(ROOT, 'sokoni-cash.js'));
const S = require(path.join(ROOT, 'sokoni-shift.js'));

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);
const K = (n) => n * 100;           /* shillings -> cents */
const EV = S.EV;

console.log('\nOPENING CASH → SELL → DRAWER → CLOSE');
console.log('='.repeat(74));

/* The user's worked example:
     Opening cash  5,000 | Cash sales 8,450 | Refunds -500 | Paid out -200
     Expected cash 12,750                                                  */
const DAY = [
  { type: EV.FLOAT, amountCents: K(5000) },
  { type: EV.SALE, amountCents: K(8450) },
  { type: EV.REFUND, amountCents: K(500) },
  { type: EV.OUT, amountCents: K(200) },
];

head('1 - the worked example reconciles');
const day = S.summarise(DAY);
ck('opening cash is carried', day.openingFloat === K(5000));
ck('cash sales are carried', day.cashSales === K(8450));
ck('refunds SUBTRACT', day.cashRefunds === K(500));
ck('paid out SUBTRACTS', day.cashOut === K(200));
ck('expected cash is 12,750', day.expected === K(12750), Cash.fromMinor(day.expected));
ck('the shift is reconcilable', day.reconcilable === true);

head('2 - INVARIANT: opening cash is NOT revenue');
const sales = S.salesTotal(DAY);
ck('sales are 8,450 - 500 = 7,950, with NO float in them',
   sales.netMinor === K(7950), Cash.fromMinor(sales.netMinor));
ck('...and the float is nowhere near the sales figure', sales.netMinor !== day.expected);
/* MUTATION CONTROL — build the defect and prove the assertion catches it. */
const inflated = (evts) => evts.reduce((acc, e) => {
  const a = S.amountOf(e) || 0;
  /* The defect: a summariser that counts the float as a sale. */
  if (e.type === EV.FLOAT || e.type === EV.SALE) return acc + a;
  if (e.type === EV.REFUND) return acc - a;
  return acc;
}, 0);
ck('MC an implementation that counts the float as revenue reports 12,950',
   inflated(DAY) === K(12950), Cash.fromMinor(inflated(DAY)));
ck('MC ...and that is EXACTLY the float more than the truth',
   inflated(DAY) - sales.netMinor === K(5000));
ck('MC ...so the assertion in section 2 would have failed on it',
   !(inflated(DAY) === K(7950)));
ck('the float is not even in the set of types salesTotal sums',
   S.salesTotal([{ type: EV.FLOAT, amountCents: K(999999) }]).netMinor === 0);

head('3 - INVARIANT: M-PESA is not cash in the drawer');
const mpesaOnly = Cash.settle({ totalMinor: K(1800), tenders: [{ method: 'mpesa', amountMinor: K(1800) }] });
ck('an M-PESA sale produces NO drawer event', S.eventsForSale(mpesaOnly, {}).length === 0);
const cardOnly = Cash.settle({ totalMinor: K(1800), tenders: [{ method: 'card', amountMinor: K(1800) }] });
ck('a card sale produces NO drawer event either', S.eventsForSale(cardOnly, {}).length === 0);
/* MC: an implementation that treats every tender as cash. */
const naive = (s) => (s.tenders || []).reduce((a, t) => a + t.amountMinor, 0);
ck('MC a naive implementation would add 1,800 to the drawer', naive(mpesaOnly) === K(1800));
ck('MC ...and the real one adds nothing',
   S.eventsForSale(mpesaOnly, {}).reduce((a, e) => a + e.amountCents, 0) === 0);
ck('NC but a CASH sale DOES move the drawer (so section 3 is not vacuous)',
   S.eventsForSale(Cash.settle({ totalMinor: K(1800), tenders: [{ method: 'cash', amountMinor: K(1800) }] }), {})
     .length === 1);

head('4 - a mixed payment moves only the cash half');
const mixed = Cash.settle({ totalMinor: K(2000), tenders: [
  { method: 'mpesa', amountMinor: K(1500) }, { method: 'cash', amountMinor: K(500) }] });
const mixedEv = S.eventsForSale(mixed, { saleId: 's1' });
ck('one drawer event, for the CASH portion only', mixedEv.length === 1 && mixedEv[0].amountCents === K(500),
   Cash.fromMinor(mixedEv[0].amountCents));
ck('...not the full 2,000', mixedEv[0].amountCents !== K(2000));
ck('it carries the sale id for audit', mixedEv[0].saleId === 's1');

head('5 - change LEAVES the drawer');
/* 5,000 tendered on a 4,700 sale: the drawer keeps 4,700, not 5,000. Recording the
   gross tender overstates the drawer by the change on EVERY cash sale. */
const withChange = Cash.settle({ totalMinor: K(4700), tenders: [{ method: 'cash', amountMinor: K(5000) }] });
ck('the settlement says 300 change', withChange.changeMinor === K(300));
const chEv = S.eventsForSale(withChange, {});
ck('the drawer gains the NET 4,700, not the gross 5,000',
   chEv[0].amountCents === K(4700), Cash.fromMinor(chEv[0].amountCents));
ck('MC the gross-recording defect would have been 5,000',
   K(5000) - chEv[0].amountCents === K(300));
/* An exact-change sale still moves the full amount. */
const exact = Cash.settle({ totalMinor: K(4700), tenders: [{ method: 'cash', amountMinor: K(4700) }] });
ck('NC an exact-cash sale moves the whole amount', S.eventsForSale(exact, {})[0].amountCents === K(4700));

head('6 - the full day: open → sell → close');
const shift = [{ type: EV.FLOAT, amountCents: K(5000) }];
[withChange, mixed, mpesaOnly].forEach((s) => { shift.push.apply(shift, S.eventsForSale(s, {})); });
const live = S.summarise(shift);
ck('the drawer holds float + cash-net-of-change only',
   live.expected === K(5000) + K(4700) + K(500), Cash.fromMinor(live.expected));
ck('...and the M-PESA sale is absent from the drawer',
   live.expected !== K(5000) + K(4700) + K(500) + K(1800));
const closed = S.close(shift, K(10200));
ck('a drawer counted at 10,200 is BALANCED', closed.status === 'balanced', String(closed.varianceMinor));
ck('a drawer counted short is SHORT', S.close(shift, K(10000)).status === 'short');
ck('a drawer counted over is OVER', S.close(shift, K(10500)).status === 'over');
ck('...with the variance stated', S.close(shift, K(10000)).varianceMinor === -K(200));
ck('an uncounted drawer is pending_close, not balanced',
   S.close(shift, null).status === 'pending_close');

head('7 - unreadable is a refusal, never zero');
const bad = [{ type: EV.FLOAT, amountCents: K(5000) }, { type: EV.SALE, amountCents: 'abc' }];
const badSum = S.summarise(bad);
ck('an unreadable amount is counted as unreadable', badSum.unreadable === 1);
ck('...and NOT silently added as zero', badSum.cashSales === 0 && badSum.reconcilable === false);
ck('closing refuses rather than reporting a confident figure',
   S.close(bad, K(5000)).ok === false, S.close(bad, K(5000)).error);
ck('an UNKNOWN event type is unreadable too, not ignored',
   S.summarise([{ type: 'mystery_event', amountCents: K(1) }]).unreadable === 1);
ck('a negative amount is refused on a non-adjustment event',
   S.amountOf({ type: EV.SALE, amountCents: -K(100) }) === null);
ck('NC ...but a float ADJUSTMENT may legitimately be negative',
   S.amountOf({ type: EV.ADJUST, adjustmentCents: -K(100) }) === -K(100));
ck('an uncountable counted amount is refused, not treated as an empty drawer',
   S.close(DAY, 'lots').ok === false);

head('8 - the float is counted exactly once');
/* A shift opened through cdRecordCashEvent AND the cash manager carries both
   spellings. Counting both makes every drawer look short by the float. */
const twoSpellings = [
  { type: EV.FLOAT, amountCents: K(5000) },
  { type: EV.OPEN, openingFloatCents: K(5000) },
  { type: EV.SALE, amountCents: K(1000) },
];
ck('both spellings present -> the float still counts ONCE',
   S.summarise(twoSpellings).openingFloat === K(5000));
ck('...so expected is 6,000, not 11,000', S.summarise(twoSpellings).expected === K(6000));
ck('NC a register_open alone still supplies the float',
   S.summarise([{ type: EV.OPEN, openingFloatCents: K(3000) }]).openingFloat === K(3000));

head('9 - it agrees with the DEPLOYED cash manager, and does not fork it');
const fnMgr = fs.readFileSync(path.join(ROOT, 'functions/pos-cash-manager.js'), 'utf8');
const shiftSrc = fs.readFileSync(path.join(ROOT, 'sokoni-shift.js'), 'utf8');
const norm = (s) => s.replace(/\s+/g, ' ');
/* The canonical formula, as deployed. */
const CANON = 'openingFloatCents + cashSales - cashRefunds + cashIn - cashOut - safeDrops - cashPickups + adjustments';
ck('the deployed cash manager uses the canonical formula', norm(fnMgr).indexOf(CANON) > -1);
ck('this module uses the SAME signs',
   norm(shiftSrc).indexOf('t.openingFloat + t.cashSales - t.cashRefunds + t.cashIn - t.cashOut - t.safeDrops - t.cashPickups + t.adjustments') > -1);
/* Proven by behaviour, not just by text. */
const mirror = (t) => t.openingFloat + t.cashSales - t.cashRefunds + t.cashIn
                    - t.cashOut - t.safeDrops - t.cashPickups + t.adjustments;
const wide = S.summarise([
  { type: EV.FLOAT, amountCents: K(1000) }, { type: EV.SALE, amountCents: K(900) },
  { type: EV.REFUND, amountCents: K(100) }, { type: EV.IN, amountCents: K(50) },
  { type: EV.OUT, amountCents: K(40) }, { type: EV.DROP, amountCents: K(30) },
  { type: EV.PICKUP, amountCents: K(20) }, { type: EV.ADJUST, adjustmentCents: -K(10) },
]);
ck('every event type moves expected in the canonical direction',
   wide.expected === mirror(wide) && wide.expected === K(1750), Cash.fromMinor(wide.expected));
ck('a cash PICKUP reduces the drawer', wide.cashPickups === K(20) &&
   S.summarise([{ type: EV.FLOAT, amountCents: K(100) }, { type: EV.PICKUP, amountCents: K(40) }]).expected === K(60));
ck('the event vocabulary is the EXISTING one, not a new one',
   ['register_open', 'cash_sale', 'cash_refund', 'cash_in', 'cash_out', 'safe_drop',
    'cash_pickup', 'float_adjustment'].every((t) => fnMgr.indexOf("'" + t + "'") > -1 &&
      shiftSrc.indexOf("'" + t + "'") > -1));

head('10 - FINDING: cdGetShiftSummary disagrees with the canonical formula');
/* Not a test of this module — a live defect this work uncovered, asserted so it
   cannot be quietly forgotten. cdGetShiftSummary is deployed
   (functions/index.js exports it) and computes expected cash from the same event
   stream with two differences, BOTH of which overstate the drawer. */
const drawer = fs.readFileSync(path.join(ROOT, 'functions/pos-cash-drawer.js'), 'utf8');
const drawerFormula = (norm(drawer).match(/const expectedCents = [^;]+/) || [''])[0];
/* The divergence is COMPUTED, not asserted. cdGetShiftSummary's formula is
   reimplemented here exactly as written at pos-cash-drawer.js:283 and run against
   the same events as the canonical one, so the gap is a number rather than a claim. */
const asDrawerFn = (t) => t.openingFloat + t.cashSales + t.cashIn
                        - t.cashOut - t.safeDrop + t.cashPickup;
const SCENARIO = { openingFloat: K(5000), cashSales: K(8000), cashIn: 0,
                   cashOut: 0, safeDrop: 0, cashPickup: K(5000) };
const canonical = S.summarise([
  { type: EV.FLOAT, amountCents: K(5000) },
  { type: EV.SALE, amountCents: K(8000) },
  { type: EV.PICKUP, amountCents: K(5000) },
]);
ck('cdGetShiftSummary ADDS cash pickups where the canon SUBTRACTS them',
   /\+ till\.cashPickup/.test(drawerFormula), drawerFormula.slice(20));
ck('...so on a 5,000 pickup it reports 10,000 MORE than the canon',
   asDrawerFn(SCENARIO) - canonical.expected === K(10000),
   Cash.fromMinor(asDrawerFn(SCENARIO)) + ' vs ' + Cash.fromMinor(canonical.expected));
ck('cdGetShiftSummary has NO refund term at all',
   drawerFormula.indexOf('efund') === -1 && norm(fnMgr).indexOf('- cashRefunds') > -1);
const withRefund = S.summarise([
  { type: EV.FLOAT, amountCents: K(5000) }, { type: EV.SALE, amountCents: K(8000) },
  { type: EV.REFUND, amountCents: K(700) },
]);
ck('...so a 700 refund is a further 700 overstated',
   asDrawerFn({ openingFloat: K(5000), cashSales: K(8000), cashIn: 0, cashOut: 0,
                safeDrop: 0, cashPickup: 0 }) - withRefund.expected === K(700),
   Cash.fromMinor(withRefund.expected) + ' canonical');
ck('and its cashSales come from DRAWER OPEN events, not sales',
   /posDrawerLog/.test(drawer) && /'type', '==', 'sale'/.test(drawer));
/* A phone till never opens a hardware drawer, so posDrawerLog is empty for it and
   cashSales sums to zero — while the same day's real cash sales are 8,000. */
ck('...so a phone till with no hardware drawer reports ZERO cash sales',
   asDrawerFn({ openingFloat: K(5000), cashSales: 0, cashIn: 0, cashOut: 0,
                safeDrop: 0, cashPickup: 0 }) === K(5000) &&
   S.summarise([{ type: EV.FLOAT, amountCents: K(5000) },
                { type: EV.SALE, amountCents: K(8000) }]).expected === K(13000),
   'drawer 5,000 vs canonical 13,000');
ck('it also requires MANAGER claims, which a solo merchant does not have',
   /cdGetShiftSummary = onCall\(OPTS, async \(req\) => \{\s*_auth\(req\);\s*if \(!_isManager\(req\)\)/.test(drawer));
ck('it IS deployed, so this is live behaviour',
   fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8').indexOf('cdGetShiftSummary') > -1);
un('whether any merchant has hit this in production',
   'needs a posTillEvents query against production — not run');

head('11 - the till is wired into Sell, and only after the server confirms');
const sell = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-sell.js'), 'utf8');
/* Comments stripped: a comment mentioning SokoniShift is not a use of it. */
const sellCode = sell.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
ck('Sell composes SokoniShift', /SokoniShift/.test(sellCode) && /SH\.eventsForSale\(/.test(sellCode));
ck('...and does not compute drawer movements itself',
   !/cashSales\s*[+-]?=/.test(sellCode) && !/openingFloat/.test(sellCode));
/* The ordering that matters: a failed sale must never move the till. */
const doneIdx = sellCode.indexOf("S.sale = 'done'");
const tillIdx = sellCode.indexOf('SH.eventsForSale(');
const failIdx = sellCode.indexOf("S.sale = 'failed'");
ck('the till is moved on the SUCCESS path', tillIdx > -1 && doneIdx > -1 && tillIdx < doneIdx);
ck('...which is reached only after res.ok', /if \(!res\.ok\)[\s\S]{0,220}return null;/.test(sellCode));
ck('...and NOT on the failure path',
   failIdx > -1 && sellCode.slice(failIdx, failIdx + 400).indexOf('eventsForSale') === -1);
ck('the shell persists the movements; Sell does not write them',
   /ctx\.onTillEvents/.test(sellCode) && !/cdRecordCashEvent/.test(sellCode));

console.log('\n' + '='.repeat(74));
console.log('  ' + pass + ' passed, ' + fail + ' failed' + (unproven ? ', ' + unproven + ' unproven' : ''));
console.log('='.repeat(74) + '\n');
process.exit(fail ? 1 : 0);
