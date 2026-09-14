#!/usr/bin/env node
/* SOKONI GOOD MORNING — certification of the presentation layer.
 *
 * The screen is warm. The numbers are not. This suite exists mostly to prove ONE thing:
 * the presenter cannot put a figure in front of a merchant that it was not given.
 *
 * That is where a cheerful UI is most dangerous. A "KES 0.00 — you're all clear! 🎉" screen
 * rendered from an unreadable balance is worse than an error, because the merchant acts on
 * it. So the no-fabrication assertions here are the point, and the copy tests are secondary.
 */
'use strict';
const G = require('../functions/good-morning-gate');
const S = require('../functions/commission-settlement-authority');
const MA = require('../functions/money-authority');

let pass = 0, fail = 0;
const ok = (label, cond, note) => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
};
const KES = (n) => MA.fromMajor(n);
const eat = (iso) => Date.parse(iso + '+03:00');
const NOW = eat('2026-09-05T07:30:00');

const gateWith = (unpaid) => S.evaluateGate({ nowMs: NOW, unpaid });
const OVERDUE_700 = gateWith([{ settlementDay: '2026-09-04', outstanding: KES(700) }]);
const CLEAR = gateWith([]);

/* every string a screen might show, flattened, so a number cannot hide in a nested field */
const allText = (v) => {
  const out = [];
  (function walk (x) {
    if (typeof x === 'string') out.push(x);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.keys(x).forEach((k) => walk(x[k]));
  })(v);
  return out.join(' | ');
};

console.log('');
console.log('  SOKONI GOOD MORNING — presentation certification');
console.log('');

/* ── 1 · THE RULE: no fabricated figures ───────────────────────────────────── */
{
  const s = G.buildGoodMorning({ shopName: 'KASS SHOP', gate: null, nowMs: NOW });
  ok('unreadable gate -> UNKNOWN state', s.state === G.STATE.UNKNOWN);
  ok('UNKNOWN shows NO amount', s.amount === null);
  ok('UNKNOWN label is a neutral dash, not 0', s.amountLabel === '—', s.amountLabel);
  ok('UNKNOWN offers no settle action', s.cta === null && s.canSettle === false);
  ok('UNKNOWN never renders a currency figure',
     !/KES\s*[\d]/.test(allText(s)), allText(s).slice(0, 90));
  ok('UNKNOWN never says zero', !/\b0\.00\b/.test(allText(s)));
  ok('UNKNOWN does not block trading on a number it cannot read', s.blocking === false);
}
[undefined, {}, { closed: 'yes' }, 42, 'nope'].forEach((bad) => {
  const s = G.buildGoodMorning({ shopName: 'X', gate: bad, nowMs: NOW });
  ok('malformed gate ' + JSON.stringify(bad) + ' -> UNKNOWN, no figure',
     s.state === G.STATE.UNKNOWN && s.amount === null && !/KES\s*\d/.test(allText(s)));
});
{
  /* overdue but the wallet is unreadable: the DUE amount is known, the balance is not.
     It may state the debt; it must not state a balance it never received. */
  const s = G.buildGoodMorning({ shopName: 'KASS SHOP', gate: OVERDUE_700, nowMs: NOW });
  ok('overdue + unreadable wallet -> DUE_NO_WALLET', s.state === G.STATE.DUE_NO_WALLET);
  ok('the DUE amount is shown (it IS known)', s.amount.minorUnits === 70000);
  ok('no wallet balance is invented', s.walletBalance === undefined);
  ok('the copy mentions no balance', !/Business Wallet has/.test(allText(s)));
  ok('wallet settlement is not offered without a readable wallet',
     s.cta.methods.indexOf('BUSINESS_WALLET') === -1, JSON.stringify(s.cta.methods));
}
{
  /* every figure rendered must equal a figure passed in */
  const s = G.buildGoodMorning({
    shopName: 'KASS SHOP', gate: OVERDUE_700, walletBalance: KES(500), nowMs: NOW });
  const shown = (allText(s).match(/\d+\.\d{2}/g) || []).sort();
  const allowed = ['700.00', '500.00', '200.00'].sort();
  ok('exactly the given/derived figures appear, nothing else',
     JSON.stringify(Array.from(new Set(shown))) === JSON.stringify(allowed),
     JSON.stringify(shown));
}

/* ── 2 · CLEAR ─────────────────────────────────────────────────────────────── */
{
  const s = G.buildGoodMorning({ shopName: 'KASS SHOP', gate: CLEAR, nowMs: NOW });
  ok('nothing overdue -> CLEAR', s.state === G.STATE.CLEAR);
  ok('CLEAR does not block', s.blocking === false);
  ok('CLEAR offers no settlement', s.cta === null);
  ok('CLEAR greets by name', /KASS SHOP/.test(s.heading), s.heading);
  ok('CLEAR shows no amount to pay', s.amount === null);
}
{
  const g = gateWith([{ settlementDay: '2026-09-05', outstanding: KES(240) }]);
  const s = G.buildGoodMorning({ shopName: 'KASS SHOP', gate: g, nowMs: NOW });
  ok('today’s accrual does not block', s.state === G.STATE.CLEAR && s.blocking === false);
  ok('today’s accrual is stated accurately', /240\.00/.test(s.body), s.body);
  ok('and framed as settling tomorrow', /tomorrow/.test(s.body));
}

/* ── 3 · DUE, wallet covers it ─────────────────────────────────────────────── */
{
  const s = G.buildGoodMorning({
    shopName: 'KASS SHOP', gate: OVERDUE_700, walletBalance: KES(2000), nowMs: NOW });
  ok('sufficient wallet -> DUE_CAN_SETTLE', s.state === G.STATE.DUE_CAN_SETTLE);
  ok('amount is exactly 700', s.amountLabel === 'KES 700.00', s.amountLabel);
  ok('both settlement methods offered',
     s.cta.methods.indexOf('BUSINESS_WALLET') > -1 && s.cta.methods.indexOf('MPESA_STK') > -1);
  ok('it blocks', s.blocking === true);
  ok('CTA reads "Settle Now"', s.cta.label === 'Settle Now');
}

/* ── 4 · DUE, wallet short — the worked example ────────────────────────────── */
{
  const s = G.buildGoodMorning({
    shopName: 'KASS SHOP', gate: OVERDUE_700, walletBalance: KES(500), nowMs: NOW });
  ok('short wallet -> DUE_SHORT', s.state === G.STATE.DUE_SHORT);
  ok('greeting is "Almost there."', s.greeting === 'Almost there.');
  ok('states the wallet balance', /500\.00/.test(s.body));
  ok('states the requirement', /700\.00/.test(s.body));
  ok('states the exact shortfall', s.shortfall.minorUnits === 20000 && /200\.00/.test(s.body));
  ok('REASSURES that nothing was taken',
     /No partial deduction was made\./.test(s.reassurance || ''), s.reassurance);
  ok('does NOT offer wallet settlement it cannot honour', s.canSettle === false);
  ok('CTA is Top Up & Settle', s.cta.label === 'Top Up & Settle');
}
{
  /* one minor unit short is still short — the friendly screen must not round it away */
  const s = G.buildGoodMorning({
    shopName: 'X', gate: OVERDUE_700, walletBalance: MA.fromMinor(69999), nowMs: NOW });
  ok('one cent short is still DUE_SHORT', s.state === G.STATE.DUE_SHORT);
  ok('shortfall of one minor unit is stated, not rounded to zero',
     s.shortfall.minorUnits === 1 && /0\.01/.test(s.body), s.body);
}
{
  /* exact balance settles */
  const s = G.buildGoodMorning({
    shopName: 'X', gate: OVERDUE_700, walletBalance: KES(700), nowMs: NOW });
  ok('an exactly sufficient wallet can settle', s.state === G.STATE.DUE_CAN_SETTLE);
}

/* ── 5 · multiple overdue days ─────────────────────────────────────────────── */
{
  const g = gateWith([
    { settlementDay: '2026-09-02', outstanding: KES(100) },
    { settlementDay: '2026-09-03', outstanding: KES(250) },
    { settlementDay: '2026-09-04', outstanding: KES(50)  }
  ]);
  const s = G.buildGoodMorning({ shopName: 'X', gate: g, walletBalance: KES(9999), nowMs: NOW });
  ok('three days aggregate to 400', s.amount.minorUnits === 40000, s.amountLabel);
  ok('copy says "3 days’", not "Yesterday’s"', /3 days/.test(s.body), s.body);
  ok('the days are listed for the merchant', s.overdueDays.length === 3);
}

/* ── 6 · greeting is deterministic ─────────────────────────────────────────── */
{
  const a = G.greetingFor('2026-09-05');
  const b = G.greetingFor('2026-09-05');
  ok('the same day always greets the same way', a === b, a + ' vs ' + b);
  ok('the greeting is one of the defined lines', G.GREETINGS.indexOf(a) > -1);
  const seen = new Set();
  for (let d = 1; d <= 28; d++) {
    seen.add(G.greetingFor('2026-09-' + String(d).padStart(2, '0')));
  }
  ok('greetings actually rotate across a month', seen.size > 1, 'distinct=' + seen.size);
}

/* ── 7 · missing shop name degrades politely ───────────────────────────────── */
[null, '', '   ', undefined, 123].forEach((n) => {
  const s = G.buildGoodMorning({ shopName: n, gate: CLEAR, nowMs: NOW });
  ok('shopName ' + JSON.stringify(n) + ' -> generic greeting, no "undefined"',
     s.heading === 'Good morning' && !/undefined|null|123/.test(s.heading), s.heading);
});

/* ── 8 · the settled screen reports what was ACTUALLY settled ──────────────── */
{
  const s = G.buildSettled({ shopName: 'KASS SHOP', settled: KES(700) });
  ok('settled screen shows the settled amount', /700\.00/.test(s.body));
  ok('settled screen does not block', s.blocking === false);
  ok('settled screen has no CTA', s.cta === null);
}
try {
  G.buildSettled({ shopName: 'X' });
  ok('a settled screen without an amount is refused', false, 'did not throw');
} catch (e) {
  ok('a settled screen without an amount is refused', /actually settled/.test(e.message));
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
  /* SABOTAGE: a presenter that defaulted an unreadable balance to zero would render a
     cheerful "all clear" screen. Prove the no-fabrication assertion catches that shape. */
  const fabricated = {
    state: 'CLEAR', heading: 'Good morning, KASS SHOP',
    body: 'Nothing outstanding — KES 0.00 due. Today is yours. 🚀',
    amount: null, amountLabel: 'KES 0.00'
  };
  const caught = /KES\s*[\d]/.test(allText(fabricated)) && /\b0\.00\b/.test(allText(fabricated));
  console.log('    ' + (caught ? 'PASS' : 'FAIL') +
              '  the no-fabrication check catches a zero-defaulted "all clear" screen');
  if (!caught) controlsOk = false;
}

console.log('');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
if (!controlsOk) {
  console.log('');
  console.log('  BLOCKED — a control misbehaved; the result above cannot be trusted.');
  process.exit(1);
}
process.exit(fail > 0 ? 1 : 0);
