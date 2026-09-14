#!/usr/bin/env node
/* POS COMMISSION SETTLEMENT AUTHORITY — certification of the 07:00 gate.
 *
 * Pure core, no I/O, nothing wired. Certifies the settlement-day boundary, the gate
 * predicate, the business/personal wallet separation, and all-or-nothing settlement.
 *
 * The boundary cases are the point. A gate that is a minute wrong lets a night's takings
 * past it, and the failure is invisible until reconciliation.
 */
'use strict';
const S = require('../functions/commission-settlement-authority');
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
/* a wall-clock EAT moment -> epoch ms (EAT = UTC+3, no DST) */
const eat = (iso) => Date.parse(iso + '+03:00');

console.log('');
console.log('  COMMISSION SETTLEMENT AUTHORITY — 07:00 EAT gate');
console.log('');

/* ── 1 · the settlement day boundary ───────────────────────────────────────── */
ok('07:00:00 EAT opens a NEW day',
   S.settlementDayFor(eat('2026-09-05T07:00:00')) === '2026-09-05',
   S.settlementDayFor(eat('2026-09-05T07:00:00')));
ok('06:59:59 EAT still belongs to the PREVIOUS day',
   S.settlementDayFor(eat('2026-09-05T06:59:59')) === '2026-09-04',
   S.settlementDayFor(eat('2026-09-05T06:59:59')));
ok('one millisecond before the gate is the previous day',
   S.settlementDayFor(eat('2026-09-05T07:00:00') - 1) === '2026-09-04');
ok('02:00 EAT — last night\'s trading, not a new day',
   S.settlementDayFor(eat('2026-09-05T02:00:00')) === '2026-09-04');
ok('midnight EAT belongs to the day that opened yesterday morning',
   S.settlementDayFor(eat('2026-09-05T00:00:00')) === '2026-09-04');
ok('23:59 EAT belongs to the same day it opened',
   S.settlementDayFor(eat('2026-09-05T23:59:00')) === '2026-09-05');
ok('12:00 EAT is the current day',
   S.settlementDayFor(eat('2026-09-05T12:00:00')) === '2026-09-05');
throwsWith('a non-finite clock is refused', 'SETTLEMENT_NO_CLOCK',
  () => S.settlementDayFor(NaN));
throwsWith('a missing clock is refused', 'SETTLEMENT_NO_CLOCK',
  () => S.settlementDayFor(undefined));

/* month and year rollovers */
ok('month rollover: 2026-10-01 06:00 EAT -> 2026-09-30',
   S.settlementDayFor(eat('2026-10-01T06:00:00')) === '2026-09-30');
ok('year rollover: 2027-01-01 03:00 EAT -> 2026-12-31',
   S.settlementDayFor(eat('2027-01-01T03:00:00')) === '2026-12-31');
ok('leap day: 2028-02-29 08:00 EAT -> 2028-02-29',
   S.settlementDayFor(eat('2028-02-29T08:00:00')) === '2028-02-29');

/* every minute of a full day maps to exactly one of two days, and flips exactly once */
{
  let flips = 0, prev = null, bad = 0;
  for (let m = 0; m < 24 * 60; m++) {
    const t = eat('2026-09-05T00:00:00') + m * 60000;
    const d = S.settlementDayFor(t);
    if (d !== '2026-09-04' && d !== '2026-09-05') bad++;
    if (prev !== null && d !== prev) flips++;
    prev = d;
  }
  ok('across 1,440 minutes the day flips exactly once', flips === 1, 'flips=' + flips);
  ok('and never lands outside the two adjacent days', bad === 0, bad + ' stray');
}

/* ── 2 · gateClosesAt ──────────────────────────────────────────────────────── */
ok('a day\'s gate closes at 07:00 EAT the NEXT morning',
   S.gateClosesAt('2026-09-04') === eat('2026-09-05T07:00:00'),
   new Date(S.gateClosesAt('2026-09-04')).toISOString());
ok('close time is exactly 24h after the day opened',
   S.gateClosesAt('2026-09-04') - eat('2026-09-04T07:00:00') === 86400000);
throwsWith('a malformed day is refused', 'SETTLEMENT_BAD_DAY',
  () => S.gateClosesAt('05/09/2026'));

/* ── 3 · the gate ──────────────────────────────────────────────────────────── */
const NOW = eat('2026-09-05T09:00:00');       /* after the 07:00 close of the 4th */
{
  const g = S.evaluateGate({ nowMs: NOW, unpaid: [] });
  ok('no liability -> OPEN', g.closed === false);
  ok('today is reported', g.today === '2026-09-05');
}
{
  /* liability accrued TODAY must not block trading */
  const g = S.evaluateGate({ nowMs: NOW,
    unpaid: [{ settlementDay: '2026-09-05', outstanding: KES(5000) }] });
  ok('TODAY\'S accruing liability does NOT close the gate', g.closed === false);
  ok('but it is reported as accruing', g.accruingToday.minorUnits === 500000);
}
{
  /* yesterday's gate has closed and it is unpaid */
  const g = S.evaluateGate({ nowMs: NOW,
    unpaid: [{ settlementDay: '2026-09-04', outstanding: KES(700) }] });
  ok('unpaid liability past its gate -> CLOSED', g.closed === true);
  ok('overdue total is exact', g.overdue.minorUnits === 70000);
  ok('the overdue day is named', g.overdueDays.join(',') === '2026-09-04');
  ok('a reason is given', /700\.00/.test(g.reason || ''), g.reason);
}
{
  /* one minute BEFORE the close, yesterday is not yet overdue */
  const justBefore = eat('2026-09-05T06:59:00');
  const g = S.evaluateGate({ nowMs: justBefore,
    unpaid: [{ settlementDay: '2026-09-04', outstanding: KES(700) }] });
  ok('at 06:59 the previous day is NOT yet overdue', g.closed === false);
  const justAfter = eat('2026-09-05T07:00:00');
  const g2 = S.evaluateGate({ nowMs: justAfter,
    unpaid: [{ settlementDay: '2026-09-04', outstanding: KES(700) }] });
  ok('at 07:00 exactly, it IS overdue', g2.closed === true);
}
{
  const g = S.evaluateGate({ nowMs: NOW, unpaid: [
    { settlementDay: '2026-09-02', outstanding: KES(100) },
    { settlementDay: '2026-09-03', outstanding: KES(250) },
    { settlementDay: '2026-09-04', outstanding: KES(50)  },
    { settlementDay: '2026-09-05', outstanding: KES(999) }
  ]});
  ok('multiple overdue days aggregate', g.overdue.minorUnits === 40000,
     String(g.overdue.minorUnits));
  ok('three days named, today excluded', g.overdueDays.length === 3);
  ok('today still only accrues', g.accruingToday.minorUnits === 99900);
}
{
  const g = S.evaluateGate({ nowMs: NOW,
    unpaid: [{ settlementDay: '2026-09-04', outstanding: MA.fromMinor(0) }] });
  ok('a zero balance for a past day does not close the gate', g.closed === false);
}
throwsWith('a non-array liability FAILS CLOSED', 'SETTLEMENT_LIABILITY_UNREADABLE',
  () => S.evaluateGate({ nowMs: NOW, unpaid: null }));
throwsWith('an unreadable row FAILS CLOSED', 'SETTLEMENT_LIABILITY_UNREADABLE',
  () => S.evaluateGate({ nowMs: NOW, unpaid: [{ settlementDay: '2026-09-04' }] }));
throwsWith('a row with no day FAILS CLOSED', 'SETTLEMENT_LIABILITY_UNREADABLE',
  () => S.evaluateGate({ nowMs: NOW, unpaid: [{ outstanding: KES(10) }] }));

/* ── 4 · business vs personal wallet ───────────────────────────────────────── */
const BIZ = { uid: 'w_biz', kind: S.WALLET_KIND.BUSINESS, ownerUid: 'm1' };
const PERSONAL = { uid: 'w_me', kind: S.WALLET_KIND.PERSONAL, ownerUid: 'm1' };
ok('a business wallet owned by the merchant is accepted',
   S.assertBusinessWallet({ wallet: BIZ, merchantUid: 'm1' }) === true);
throwsWith('a PERSONAL wallet may NOT settle a merchant liability',
  'SETTLE_NOT_BUSINESS_WALLET',
  () => S.assertBusinessWallet({ wallet: PERSONAL, merchantUid: 'm1' }));
throwsWith('a business wallet belonging to someone else is refused',
  'SETTLE_WALLET_NOT_OWNED',
  () => S.assertBusinessWallet({ wallet: BIZ, merchantUid: 'other' }));
throwsWith('a wallet with no kind is refused', 'SETTLE_NOT_BUSINESS_WALLET',
  () => S.assertBusinessWallet({ wallet: { uid: 'x', ownerUid: 'm1' }, merchantUid: 'm1' }));
throwsWith('no wallet is refused', 'SETTLE_NO_WALLET',
  () => S.assertBusinessWallet({ wallet: null, merchantUid: 'm1' }));

/* ── 5 · all-or-nothing settlement ─────────────────────────────────────────── */
{
  const p = S.planCommissionSettlement({
    merchantUid: 'm1', wallet: BIZ, balance: KES(2000), amountDue: KES(700),
    idempotencyKey: 'k1', nowMs: NOW
  });
  ok('sufficient balance settles in full', p.debit.minorUnits === 70000);
  ok('balance after is exact', p.balanceAfter.minorUnits === 130000);
  ok('method is recorded', p.method === 'BUSINESS_WALLET');
}
{
  /* the worked example: due 700, wallet 500 -> refuse, do NOT take the 500 */
  try {
    S.planCommissionSettlement({ merchantUid: 'm1', wallet: BIZ,
      balance: KES(500), amountDue: KES(700), idempotencyKey: 'k2' });
    ok('700 due against a 500 wallet is refused', false, 'did not throw');
  } catch (e) {
    ok('700 due against a 500 wallet is refused', e.code === 'SETTLE_INSUFFICIENT_BALANCE', e.code);
    ok('shortfall is exactly 200', e.detail && e.detail.shortfallMinor === 20000,
       e.detail && String(e.detail.shortfallMinor));
    ok('the refusal states that no partial deduction occurred',
       e.detail && e.detail.partialDeductionRefused === true);
    ok('the message names the amount to pay', /200\.00/.test(e.message), e.message);
  }
}
{
  /* exact balance settles */
  const p = S.planCommissionSettlement({ merchantUid: 'm1', wallet: BIZ,
    balance: KES(700), amountDue: KES(700), idempotencyKey: 'k3' });
  ok('an exactly sufficient wallet settles to zero', p.balanceAfter.minorUnits === 0);
}
throwsWith('one minor unit short is refused', 'SETTLE_INSUFFICIENT_BALANCE',
  () => S.planCommissionSettlement({ merchantUid: 'm1', wallet: BIZ,
    balance: MA.fromMinor(69999), amountDue: KES(700), idempotencyKey: 'k4' }));
throwsWith('settlement without an idempotency key is refused', 'SETTLE_NO_IDEMPOTENCY_KEY',
  () => S.planCommissionSettlement({ merchantUid: 'm1', wallet: BIZ,
    balance: KES(2000), amountDue: KES(700) }));
throwsWith('nothing due is refused', 'SETTLE_NOTHING_DUE',
  () => S.planCommissionSettlement({ merchantUid: 'm1', wallet: BIZ,
    balance: KES(2000), amountDue: MA.fromMinor(0), idempotencyKey: 'k5' }));
throwsWith('a personal wallet cannot settle, even when funded',
  'SETTLE_NOT_BUSINESS_WALLET',
  () => S.planCommissionSettlement({ merchantUid: 'm1', wallet: PERSONAL,
    balance: KES(999999), amountDue: KES(700), idempotencyKey: 'k6' }));
throwsWith('a negative business balance is refused', 'SETTLE_NEGATIVE_BALANCE',
  () => S.planCommissionSettlement({ merchantUid: 'm1', wallet: BIZ,
    balance: MA.fromMinor(-1), amountDue: KES(700), idempotencyKey: 'k7' }));

/* the wallet-kind check precedes the balance check: a personal wallet must be refused for
   BEING personal, never reported as merely underfunded */
try {
  S.planCommissionSettlement({ merchantUid: 'm1', wallet: PERSONAL,
    balance: MA.fromMinor(1), amountDue: KES(700), idempotencyKey: 'k8' });
  ok('personal + underfunded reports the WALLET KIND failure', false, 'did not throw');
} catch (e) {
  ok('personal + underfunded reports the WALLET KIND failure, not the balance',
     e.code === 'SETTLE_NOT_BUSINESS_WALLET', e.code);
}

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
  /* SABOTAGE: a gate computed on UTC midnight instead of 07:00 EAT would mis-assign the
     small hours. Prove the boundary tests would catch that shift. */
  const utcMidnightDay = (ms) => new Date(ms).toISOString().slice(0, 10);
  const t = eat('2026-09-05T02:00:00');
  const correct = S.settlementDayFor(t);          /* 2026-09-04 */
  const naive = utcMidnightDay(t);                /* 2026-09-04 in UTC too — pick a case that differs */
  const t2 = eat('2026-09-05T05:00:00');
  const differs = S.settlementDayFor(t2) !== utcMidnightDay(t2);
  console.log('    ' + (differs ? 'PASS' : 'FAIL') +
              '  the 07:00 EAT boundary differs from a naive UTC-midnight day' +
              ' (' + S.settlementDayFor(t2) + ' vs ' + utcMidnightDay(t2) + ')');
  if (!differs) controlsOk = false;
  void correct; void naive;
}
{
  /* SABOTAGE: a gate that ignored the close time would block today's trading. */
  const g = S.evaluateGate({ nowMs: NOW,
    unpaid: [{ settlementDay: '2026-09-05', outstanding: KES(9999) }] });
  const wouldBlock = g.closed === true;
  console.log('    ' + (!wouldBlock ? 'PASS' : 'FAIL') +
              '  a gate ignoring the close time would block today — it does not');
  if (wouldBlock) controlsOk = false;
}

console.log('');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
if (!controlsOk) {
  console.log('');
  console.log('  BLOCKED — a control misbehaved; the result above cannot be trusted.');
  process.exit(1);
}
process.exit(fail > 0 ? 1 : 0);
