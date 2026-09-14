#!/usr/bin/env node
/* MONEY AUTHORITY — exhaustive certification of the pure core.
 *
 * No Firestore, no network, no deployment. This suite exists to certify the arithmetic and
 * the refusals BEFORE any of it is wired to a document, because a money path entangled with
 * writes cannot be exercised at its boundaries.
 *
 * IT CARRIES ITS OWN CONTROLS. A suite that only asserts correct behaviour cannot show it
 * would notice incorrect behaviour. Two controls run at the end:
 *   - a NEGATIVE control that must fail (proving assertions can fail at all)
 *   - a SABOTAGE control that mutates the commission invariant and requires detection
 * If either misbehaves the run is BLOCKED, regardless of how many tests passed.
 */
'use strict';
const M = require('../functions/money-authority');

let pass = 0, fail = 0;
const NL = String.fromCharCode(10);

function ok (label, cond, note) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
}
/** assert that `fn` throws, and with the expected code — a throw for the WRONG reason is a
    failure, not a pass, or a suite drifts into accepting any error at all. */
function throwsWith (label, code, fn) {
  try { fn(); fail++; console.log('  FAIL  ' + label + '   [did not throw; expected ' + code + ']'); }
  catch (e) {
    if (e.code === code) pass++;
    else { fail++; console.log('  FAIL  ' + label + '   [threw ' + (e.code || e.message) + ', expected ' + code + ']'); }
  }
}

const KES = (major) => M.fromMajor(major);
const minor = (n) => M.fromMinor(n);

console.log('');
console.log('  MONEY AUTHORITY — pure core certification');
console.log('');

/* ── Money ─────────────────────────────────────────────────────────────────── */
ok('fromMajor(100) = 10000 minor', M.fromMajor(100).minorUnits === 10000);
ok('fromMinor(10000) = 10000 minor', M.fromMinor(10000).minorUnits === 10000);
ok('the 100x divergence is representable and distinct',
   M.fromMajor(100).minorUnits !== M.fromMinor(100).minorUnits);
throwsWith('fractional minor unit refused', 'MONEY_SUBUNIT', () => M.fromMajor(10.005));
throwsWith('non-integer minor refused', 'MONEY_NOT_INTEGER', () => M.fromMinor(10.5));
throwsWith('string amount refused', 'MONEY_NOT_INTEGER', () => M.fromMinor('100'));
throwsWith('NaN refused', 'MONEY_NOT_FINITE', () => M.fromMajor(NaN));
throwsWith('Infinity refused', 'MONEY_NOT_FINITE', () => M.fromMajor(Infinity));
throwsWith('unsupported currency refused', 'MONEY_CURRENCY', () => M.fromMinor(100, 'USD'));
ok('0.01 KES is one minor unit', M.fromMajor(0.01).minorUnits === 1);
ok('toMajorString formats 2dp', M.toMajorString(minor(123456)) === '1234.56');
ok('add', M.add(minor(100), minor(50)).minorUnits === 150);
ok('sub', M.sub(minor(100), minor(50)).minorUnits === 50);

/* ── Custody: fails closed ─────────────────────────────────────────────────── */
ok('cash is NON_CUSTODIAL', M.classifyCustody('cash') === M.CUSTODY.NON_CUSTODIAL);
ok('mpesa_stk is CUSTODIAL', M.classifyCustody('mpesa_stk') === M.CUSTODY.CUSTODIAL);
ok('sokoni_wallet is CUSTODIAL', M.classifyCustody('sokoni_wallet') === M.CUSTODY.CUSTODIAL);
ok('store_credit is NON_CUSTODIAL', M.classifyCustody('store_credit') === M.CUSTODY.NON_CUSTODIAL);
ok('mpesa_direct (till) is NON_CUSTODIAL', M.classifyCustody('mpesa_direct') === M.CUSTODY.NON_CUSTODIAL);
ok('classification is case-insensitive', M.classifyCustody('CASH') === M.CUSTODY.NON_CUSTODIAL);
throwsWith('an UNKNOWN method fails closed', 'CUSTODY_UNKNOWN', () => M.classifyCustody('crypto'));
throwsWith('an empty method fails closed', 'CUSTODY_UNKNOWN', () => M.classifyCustody(''));
throwsWith('undefined method fails closed', 'CUSTODY_UNKNOWN', () => M.classifyCustody(undefined));

/* ── Commission ────────────────────────────────────────────────────────────── */
{
  const r = M.computeCommission({ gross: KES(1000), rateFraction: 0.05, minimumMinor: 1000 });
  ok('KES 1,000 @ 5% -> commission 50', r.commission.minorUnits === 5000, M.toMajorString(r.commission));
  ok('KES 1,000 @ 5% -> net 950', r.net.minorUnits === 95000, M.toMajorString(r.net));
  ok('commission + net === gross', r.commission.minorUnits + r.net.minorUnits === r.gross.minorUnits);
}
{
  const r = M.computeCommission({ gross: KES(1000), rateFraction: 0.15, minimumMinor: 1000 });
  ok('Free plan 15% -> 150', r.commission.minorUnits === 15000);
  ok('Free plan 15% -> net 850', r.net.minorUnits === 85000);
}
{
  const r = M.computeCommission({ gross: KES(1000), rateFraction: 0, minimumMinor: 1000, floorExempt: true });
  ok('Enterprise 0% exempt -> commission 0', r.commission.minorUnits === 0);
  ok('Enterprise 0% exempt -> net = gross', r.net.minorUnits === r.gross.minorUnits);
}
{
  /* the live commercial trap: a 0% plan still owes the floor unless exempted */
  const r = M.computeCommission({ gross: KES(1000), rateFraction: 0, minimumMinor: 1000 });
  ok('0% NOT exempt still owes the KES 10 floor', r.commission.minorUnits === 1000,
     M.toMajorString(r.commission));
}
{
  const r = M.computeCommission({ gross: KES(97), rateFraction: 0.05, minimumMinor: 1000 });
  ok('KES 97 @ 5% floors to KES 10', r.commission.minorUnits === 1000);
  ok('floorApplied is reported', r.floorApplied === true);
}
{
  const r = M.computeCommission({ gross: KES(5), rateFraction: 0.05, minimumMinor: 1000 });
  ok('floor never exceeds the sale itself', r.commission.minorUnits === 500);
  ok('net is never negative', r.net.minorUnits >= 0);
}
{
  const r = M.computeCommission({ gross: minor(0), rateFraction: 0.05, minimumMinor: 1000 });
  ok('a zero sale owes nothing', r.commission.minorUnits === 0);
}
{
  /* rounding: 333 minor @ 5% = 16.65 -> 17, and parts must still sum */
  const r = M.computeCommission({ gross: minor(333), rateFraction: 0.05, minimumMinor: 0 });
  ok('half-up rounding', r.commission.minorUnits === 17, String(r.commission.minorUnits));
  ok('parts sum exactly after rounding',
     r.commission.minorUnits + r.net.minorUnits === 333);
}
throwsWith('rate 5 (percent) is refused as out of range', 'COMMISSION_RATE_RANGE',
  () => M.computeCommission({ gross: KES(1000), rateFraction: 5 }));
throwsWith('rate 15 (percent) is refused', 'COMMISSION_RATE_RANGE',
  () => M.computeCommission({ gross: KES(1000), rateFraction: 15 }));
throwsWith('negative rate refused', 'COMMISSION_RATE_RANGE',
  () => M.computeCommission({ gross: KES(1000), rateFraction: -0.05 }));
throwsWith('negative gross refused', 'COMMISSION_NEGATIVE_GROSS',
  () => M.computeCommission({ gross: minor(-1), rateFraction: 0.05 }));

/* exhaustive sum invariant across a wide range */
{
  let bad = 0;
  for (let g = 0; g <= 500000; g += 997) {
    for (const rate of [0, 0.05, 0.10, 0.15, 0.03, 0.075]) {
      const r = M.computeCommission({ gross: minor(g), rateFraction: rate, minimumMinor: 1000 });
      if (r.commission.minorUnits + r.net.minorUnits !== g) bad++;
      if (r.net.minorUnits < 0) bad++;
      if (r.commission.minorUnits > g) bad++;
    }
  }
  ok('commission+net===gross and net>=0 across 3,012 combinations', bad === 0, bad + ' violations');
}

/* ── Sale accounting: custody decides the booking ──────────────────────────── */
{
  const s = M.planSaleAccounting({
    gross: KES(1000), rateFraction: 0.05, custody: M.CUSTODY.CUSTODIAL, minimumMinor: 1000
  });
  ok('CUSTODIAL: commission 50', s.commission.minorUnits === 5000);
  ok('CUSTODIAL: merchant credited NET 950', s.merchantCredit.minorUnits === 95000);
  ok('CUSTODIAL: no liability', s.liability.minorUnits === 0);
  ok('CUSTODIAL: credit + commission === gross',
     s.merchantCredit.minorUnits + s.commission.minorUnits === s.gross.minorUnits);
}
{
  const s = M.planSaleAccounting({
    gross: KES(1000), rateFraction: 0.05, custody: M.CUSTODY.NON_CUSTODIAL, minimumMinor: 1000
  });
  ok('CASH: commission still 50', s.commission.minorUnits === 5000);
  ok('CASH: merchant credited NOTHING', s.merchantCredit.minorUnits === 0);
  ok('CASH: commission becomes a liability of 50', s.liability.minorUnits === 5000);
}
{
  /* the whole point: the same sale books differently by custody, and the merchant is never
     credited money the platform never received */
  const g = KES(1000), r = 0.15;
  const cu = M.planSaleAccounting({ gross: g, rateFraction: r, custody: M.CUSTODY.CUSTODIAL });
  const nc = M.planSaleAccounting({ gross: g, rateFraction: r, custody: M.CUSTODY.NON_CUSTODIAL });
  ok('same commission regardless of custody',
     cu.commission.minorUnits === nc.commission.minorUnits);
  ok('custody changes only WHERE the money sits',
     cu.merchantCredit.minorUnits === 85000 && nc.merchantCredit.minorUnits === 0);
  ok('exactly one of credit/liability is non-zero (custodial)',
     (cu.merchantCredit.minorUnits > 0) !== (cu.liability.minorUnits > 0));
  ok('exactly one of credit/liability is non-zero (cash)',
     (nc.merchantCredit.minorUnits > 0) !== (nc.liability.minorUnits > 0));
}
{
  /* the plan ladder, booked custodially */
  const rates = [['Free', 0.15, 85000], ['Basic', 0.10, 90000],
                 ['Pro', 0.05, 95000], ['Enterprise', 0, 100000]];
  let bad = 0;
  rates.forEach(([, rate, expectNet]) => {
    const s = M.planSaleAccounting({ gross: KES(1000), rateFraction: rate,
      custody: M.CUSTODY.CUSTODIAL, floorExempt: true });
    if (s.merchantCredit.minorUnits !== expectNet) bad++;
  });
  ok('the 15/10/5/0 ladder nets 850/900/950/1000 on a KES 1,000 sale', bad === 0, bad + ' wrong');
}
throwsWith('custody must be passed, not a method name', 'SALE_CUSTODY_REQUIRED',
  () => M.planSaleAccounting({ gross: KES(1000), rateFraction: 0.05, custody: 'cash' }));
throwsWith('missing custody refuses', 'SALE_CUSTODY_REQUIRED',
  () => M.planSaleAccounting({ gross: KES(1000), rateFraction: 0.05 }));

/* the booking invariant across a wide range, both custody modes */
{
  let bad = 0;
  for (let g = 0; g <= 200000; g += 1013) {
    for (const rate of [0, 0.05, 0.10, 0.15]) {
      const cu = M.planSaleAccounting({ gross: minor(g), rateFraction: rate,
        custody: M.CUSTODY.CUSTODIAL, minimumMinor: 1000 });
      const nc = M.planSaleAccounting({ gross: minor(g), rateFraction: rate,
        custody: M.CUSTODY.NON_CUSTODIAL, minimumMinor: 1000 });
      if (cu.merchantCredit.minorUnits + cu.commission.minorUnits !== g) bad++;
      if (nc.merchantCredit.minorUnits !== 0) bad++;
      if (nc.liability.minorUnits !== nc.commission.minorUnits) bad++;
      if (cu.merchantCredit.minorUnits > g) bad++;
    }
  }
  ok('booking invariants hold across 792 sale/rate/custody combinations', bad === 0,
     bad + ' violations');
}

/* ── Wallet payment ────────────────────────────────────────────────────────── */
const AUTH = (over) => Object.assign({
  id: 'auth_1', buyerUid: 'buyer_1', amountMinor: 100000,
  expiresAtMs: 2000, consumed: false
}, over || {});

{
  const p = M.planWalletPayment({
    buyerUid: 'buyer_1', balance: KES(5000), amount: KES(1000),
    authorization: AUTH(), nowMs: 1000
  });
  ok('sufficient balance produces a plan', p.debit.minorUnits === 100000);
  ok('balanceAfter is exact', p.balanceAfter.minorUnits === 400000);
  ok('wallet payment is CUSTODIAL', p.custody === M.CUSTODY.CUSTODIAL);
}
{
  /* exact-balance boundary: equality must SUCCEED */
  const p = M.planWalletPayment({
    buyerUid: 'buyer_1', balance: KES(1000), amount: KES(1000),
    authorization: AUTH(), nowMs: 1000
  });
  ok('exact balance succeeds and leaves zero', p.balanceAfter.minorUnits === 0);
}
throwsWith('one minor unit short DECLINES', 'WALLET_INSUFFICIENT_BALANCE',
  () => M.planWalletPayment({ buyerUid: 'buyer_1', balance: minor(99999), amount: KES(1000),
    authorization: AUTH(), nowMs: 1000 }));
throwsWith('missing authorization refuses', 'WALLET_NOT_AUTHORIZED',
  () => M.planWalletPayment({ buyerUid: 'buyer_1', balance: KES(5000), amount: KES(1000),
    authorization: null, nowMs: 1000 }));
throwsWith('authorization for another buyer refuses', 'WALLET_AUTHORIZATION_WRONG_BUYER',
  () => M.planWalletPayment({ buyerUid: 'buyer_1', balance: KES(5000), amount: KES(1000),
    authorization: AUTH({ buyerUid: 'buyer_2' }), nowMs: 1000 }));
throwsWith('authorization for a different amount refuses', 'WALLET_AUTHORIZATION_AMOUNT_MISMATCH',
  () => M.planWalletPayment({ buyerUid: 'buyer_1', balance: KES(5000), amount: KES(2000),
    authorization: AUTH(), nowMs: 1000 }));
throwsWith('expired authorization refuses', 'WALLET_AUTHORIZATION_EXPIRED',
  () => M.planWalletPayment({ buyerUid: 'buyer_1', balance: KES(5000), amount: KES(1000),
    authorization: AUTH({ expiresAtMs: 500 }), nowMs: 1000 }));
throwsWith('replayed authorization refuses', 'WALLET_AUTHORIZATION_CONSUMED',
  () => M.planWalletPayment({ buyerUid: 'buyer_1', balance: KES(5000), amount: KES(1000),
    authorization: AUTH({ consumed: true }), nowMs: 1000 }));
throwsWith('negative balance refuses', 'WALLET_NEGATIVE_BALANCE',
  () => M.planWalletPayment({ buyerUid: 'buyer_1', balance: minor(-1), amount: KES(1000),
    authorization: AUTH(), nowMs: 1000 }));
throwsWith('zero amount refuses', 'WALLET_AMOUNT_NOT_POSITIVE',
  () => M.planWalletPayment({ buyerUid: 'buyer_1', balance: KES(5000), amount: minor(0),
    authorization: AUTH({ amountMinor: 0 }), nowMs: 1000 }));
throwsWith('no buyer refuses', 'WALLET_NO_BUYER',
  () => M.planWalletPayment({ buyerUid: '', balance: KES(5000), amount: KES(1000),
    authorization: AUTH(), nowMs: 1000 }));

/* authorization is checked BEFORE balance: an unauthorised payment must not be reported
   as an affordability problem, which would leak whether a stranger's wallet is funded */
try {
  M.planWalletPayment({ buyerUid: 'buyer_1', balance: minor(1), amount: KES(1000),
    authorization: null, nowMs: 1000 });
  ok('unauthorised + unaffordable reports the AUTH failure', false, 'did not throw');
} catch (e) {
  ok('unauthorised + unaffordable reports the AUTH failure, not the balance',
     e.code === 'WALLET_NOT_AUTHORIZED', e.code);
}

/* ── Commission settlement ─────────────────────────────────────────────────── */
{
  const s = M.planCommissionSettlement({
    merchantUid: 'm1', walletBalance: KES(5000), amountDue: KES(2450)
  });
  ok('settlement debits the full amount due', s.debit.minorUnits === 245000);
  ok('settlement leaves the correct balance', s.balanceAfter.minorUnits === 255000);
}
throwsWith('partial settlement refused', 'SETTLE_PARTIAL_REFUSED',
  () => M.planCommissionSettlement({ merchantUid: 'm1', walletBalance: KES(5000),
    amountDue: KES(2450), amountOffered: KES(1000) }));
throwsWith('overpayment refused', 'SETTLE_PARTIAL_REFUSED',
  () => M.planCommissionSettlement({ merchantUid: 'm1', walletBalance: KES(5000),
    amountDue: KES(2450), amountOffered: KES(3000) }));
throwsWith('settlement with insufficient balance refused', 'SETTLE_INSUFFICIENT_BALANCE',
  () => M.planCommissionSettlement({ merchantUid: 'm1', walletBalance: KES(1000),
    amountDue: KES(2450) }));
throwsWith('nothing due refused', 'SETTLE_NOTHING_DUE',
  () => M.planCommissionSettlement({ merchantUid: 'm1', walletBalance: KES(5000),
    amountDue: minor(0) }));

/* ── Withdrawal quote ──────────────────────────────────────────────────────── */
{
  const q = M.calculateWithdrawalQuote({
    availableBalance: KES(10000), requested: KES(8000), providerFee: KES(120),
    feeSource: 'PROVIDER_API', destinationType: 'PHONE', destination: '2547...'
  });
  ok('fees are charged ON TOP', q.totalDebit.minorUnits === 812000, M.toMajorString(q.totalDebit));
  ok('recipient receives the REQUESTED amount', q.recipientAmount.minorUnits === 800000);
  ok('quote carries feeSource', q.feeSource === 'PROVIDER_API');
  ok('quote carries destinationType', q.destinationType === 'PHONE');
}
{
  /* the worked example: 8,000 requested, 100 fee, 8,050 available -> REJECT */
  try {
    M.calculateWithdrawalQuote({
      availableBalance: KES(8050), requested: KES(8000), providerFee: KES(100),
      feeSource: 'PROVIDER_API', destinationType: 'PHONE'
    });
    ok('8,050 available cannot fund 8,000 + 100', false, 'did not throw');
  } catch (e) {
    ok('8,050 available cannot fund 8,000 + 100', e.code === 'INSUFFICIENT_BALANCE', e.code);
    ok('shortfall is exact (KES 50)', e.detail && e.detail.shortfallMinor === 5000,
       e.detail && String(e.detail.shortfallMinor));
  }
}
{
  /* exact boundary: balance === totalDebit must SUCCEED */
  const q = M.calculateWithdrawalQuote({
    availableBalance: KES(8100), requested: KES(8000), providerFee: KES(100),
    feeSource: 'PROVIDER_API', destinationType: 'PHONE'
  });
  ok('balance exactly equal to totalDebit succeeds', q.totalDebit.minorUnits === 810000);
}
throwsWith('one minor unit short rejects', 'INSUFFICIENT_BALANCE',
  () => M.calculateWithdrawalQuote({ availableBalance: minor(809999), requested: KES(8000),
    providerFee: KES(100), feeSource: 'PROVIDER_API', destinationType: 'PHONE' }));
throwsWith('a MISSING fee is a hard failure, never zero', 'FEE_INDETERMINATE',
  () => M.calculateWithdrawalQuote({ availableBalance: KES(10000), requested: KES(8000),
    providerFee: null, feeSource: 'PROVIDER_API', destinationType: 'PHONE' }));
throwsWith('a fee with no source is refused', 'FEE_INDETERMINATE',
  () => M.calculateWithdrawalQuote({ availableBalance: KES(10000), requested: KES(8000),
    providerFee: KES(120), feeSource: null, destinationType: 'PHONE' }));
throwsWith('an unrecognised fee source is refused', 'FEE_INDETERMINATE',
  () => M.calculateWithdrawalQuote({ availableBalance: KES(10000), requested: KES(8000),
    providerFee: KES(120), feeSource: 'GUESSED', destinationType: 'PHONE' }));
throwsWith('no destinationType refused', 'QUOTE_NO_DESTINATION_TYPE',
  () => M.calculateWithdrawalQuote({ availableBalance: KES(10000), requested: KES(8000),
    providerFee: KES(120), feeSource: 'PROVIDER_API' }));
{
  /* a zero fee is legitimate WHEN SOURCED — it must not be confused with an absent fee */
  const q = M.calculateWithdrawalQuote({
    availableBalance: KES(10000), requested: KES(8000), providerFee: minor(0),
    feeSource: 'AUTHORITATIVE_TABLE', destinationType: 'TILL'
  });
  ok('a SOURCED zero fee is accepted', q.totalDebit.minorUnits === 800000);
}
{
  const max = M.maximumWithdrawable({ availableBalance: KES(10000), providerFee: KES(120) });
  ok('maximumWithdrawable leaves room for the fee', max.minorUnits === 988000,
     M.toMajorString(max));
  const q = M.calculateWithdrawalQuote({
    availableBalance: KES(10000), requested: max, providerFee: KES(120),
    feeSource: 'PROVIDER_API', destinationType: 'PHONE'
  });
  ok('the maximum is exactly affordable', q.totalDebit.minorUnits === 1000000);
}
throwsWith('a variable fee makes the maximum indeterminate', 'MAX_INDETERMINATE',
  () => M.maximumWithdrawable({ availableBalance: KES(10000), providerFee: KES(120),
    feeVariesWithAmount: true }));
{
  const max = M.maximumWithdrawable({ availableBalance: KES(1), providerFee: KES(120) });
  ok('maximum is never negative', max.minorUnits === 0);
}

/* ══ CONTROLS — a suite that cannot fail proves nothing ═══════════════════════ */
console.log('');
console.log('  CONTROLS');

let controlsOk = true;

/* negative control: a deliberately false assertion must register as a failure */
{
  const before = fail;
  ok('__negative_control__ (expected to fail)', 1 === 2);
  const detected = fail === before + 1;
  fail = before;                    /* un-count the intentional failure */
  console.log('    ' + (detected ? 'PASS' : 'FAIL') + '  assertions can fail');
  if (!detected) controlsOk = false;
}

/* sabotage: break the commission invariant and require the check to notice */
{
  const sabotaged = (gross, rate) => {
    const c = Math.round(gross * rate) + 1;        /* off by one minor unit */
    return { c, n: gross - Math.round(gross * rate) };   /* parts no longer sum */
  };
  let caught = 0;
  for (let g = 100; g <= 100000; g += 971) {
    const s = sabotaged(g, 0.05);
    if (s.c + s.n !== g) caught++;
  }
  console.log('    ' + (caught > 0 ? 'PASS' : 'FAIL') +
              '  the sum invariant detects a one-unit commission error (' + caught + ' cases)');
  if (caught === 0) controlsOk = false;
}

/* sabotage: a percentage passed as a fraction must be refused, not silently applied */
{
  let refused = false;
  try { M.computeCommission({ gross: KES(1000), rateFraction: 5 }); }
  catch (e) { refused = e.code === 'COMMISSION_RATE_RANGE'; }
  console.log('    ' + (refused ? 'PASS' : 'FAIL') + '  a percentage in the fraction slot is refused');
  if (!refused) controlsOk = false;
}

console.log('');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
if (!controlsOk) {
  console.log('');
  console.log('  BLOCKED — a control misbehaved. The result above cannot be trusted,');
  console.log('  regardless of how many assertions passed.');
  process.exit(1);
}
process.exit(fail > 0 ? 1 : 0);
