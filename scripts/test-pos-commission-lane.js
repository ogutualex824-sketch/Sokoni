#!/usr/bin/env node
/* POS COMMISSION LANE — certification.
 *
 * Certifies the absolute POS schedule inside commission-config.js, its floor semantics, and
 * the chain resolvePosRate() -> planSaleAccounting(). Nothing is wired and nothing deploys.
 *
 * THE TWO THINGS THIS MUST NOT BREAK, both asserted:
 *   1. marketplace pricing, unchanged
 *   2. the 48-hour settlement gate — `_is48hCommission()` in index.js treats any hub
 *      resolving to 'marketplace' as a 48-hour obligation. `pos` must STILL resolve there
 *      until that commercial decision is taken separately, or POS silently moves to monthly
 *      invoicing as a side effect of a pricing change.
 *
 * SABOTAGE CONTROL: a second commission table is planted in a real file and the
 * single-source guard must FAIL. A guard that cannot fail is decoration.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const CC = require('../functions/commission-config');
const MA = require('../functions/money-authority');

let pass = 0, fail = 0;
const ok = (label, cond, note) => {
  if (cond) pass++;
  else { fail++; console.log('  FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
};
const KES = (n) => MA.fromMajor(n);
const minor = (n) => MA.fromMinor(n);

console.log('');
console.log('  POS COMMISSION LANE — certification');
console.log('');

/* ── 1 · the schedule ──────────────────────────────────────────────────────── */
/* OWNER RULING 2026-09-07: the POS lane is FLAT and plan-independent. The plan ladder
   (15/10/5/0) it used to carry was countermanded and moved to the MARKETPLACE lane,
   where a subscription is buying something SOKONI actually provides — the order. A till
   sale is one the merchant made themselves, so it costs the same on every plan.

   The rate is READ from the config, never pinned here. A pinned number means this suite
   has to be hand-edited on every pricing change, and the day someone forgets it certifies
   a schedule that no longer ships. What is asserted is the SHAPE — flat, plan-independent,
   fail-safe on unknown plans — plus the arithmetic, computed from whatever the rate is. */
const POS_RATE = CC.POS_FLAT_RATE_FRACTION;
const EXPECT = [
  ['seller_free',       POS_RATE, false],
  ['seller_basic',      POS_RATE, false],
  ['seller_pro',        POS_RATE, false],
  ['seller_enterprise', POS_RATE, false]
];
ok('the POS lane is FLAT — every plan resolves to the same rate',
   new Set(EXPECT.map(function (e) { return CC.resolvePosRate(e[0]).rateFraction; })).size === 1,
   EXPECT.map(function (e) { return e[0] + '=' + CC.resolvePosRate(e[0]).rateFraction; }).join(' '));
ok('the POS rate is NOT the marketplace Free rate — the lanes are separate products',
   CC.resolvePosRate('seller_free').rateFraction !== CC.resolveMarketplaceRate('seller_free').rateFraction,
   'pos=' + CC.resolvePosRate('seller_free').rateFraction + ' mkt=' + CC.resolveMarketplaceRate('seller_free').rateFraction);
EXPECT.forEach(([plan, rate, exempt]) => {
  const r = CC.resolvePosRate(plan);
  ok(plan + ' rate = ' + rate, r.rateFraction === rate, String(r.rateFraction));
  ok(plan + ' floorExempt = ' + exempt, r.floorExempt === exempt, String(r.floorExempt));
  ok(plan + ' is matched', r.matched === true);
  ok(plan + ' carries provenance',
     r.source === 'commission-config.POS_PLAN_RATES' && r.lane === 'pos' && r.plan === plan);
});

/* the unit trap: these must be FRACTIONS, never percentages */
EXPECT.forEach(([plan, rate]) => {
  const r = CC.resolvePosRate(plan);
  ok(plan + ' rate is a fraction (<= 1)', r.rateFraction <= 1, String(r.rateFraction));
  ok(plan + ' pct is the fraction x100', r.pct === rate * 100, String(r.pct));
});

/* ── 2 · unknown plans fail SAFE (highest rate), never free ────────────────── */
['', null, undefined, 'nonsense', 'seller_platinum', 'SELLER_ENTERPRISE_X'].forEach((p) => {
  const r = CC.resolvePosRate(p);
  ok('unknown plan ' + JSON.stringify(p) + ' -> the flat POS rate, never zero',
     r.rateFraction === POS_RATE && r.plan === 'seller_free' && r.matched === false && r.rateFraction > 0,
     r.rateFraction + '/' + r.plan);
});
ok('plan lookup is case-insensitive',
   CC.resolvePosRate('SELLER_PRO').rateFraction === POS_RATE &&
   CC.resolvePosRate('Seller_Pro').matched === true);

/* ── 3 · the KES 10 floor, exhaustively at the boundary ────────────────────── */
const MIN = CC.MIN_COMMISSION_KES;                 /* 10 */
const MIN_MINOR = MIN * 100;                       /* 1000 */
ok('MIN_COMMISSION_KES is 10', MIN === 10, String(MIN));

/* The crossover is DERIVED, not memorised: the floor binds below MIN / rate, which is
   KES 66.67 at 15% and KES 200 at 5%. Writing the boundary as a literal is how a suite
   silently stops testing the boundary the moment a rate moves.

   THREE outcomes, not two — an earlier version of this table modelled only floor/rate and
   failed on KES 1, where the correct answer is neither: the floor is CAPPED at the sale, so
   a KES 1 sale is charged KES 1, never KES 10. A sale must never owe more than itself. */
const CROSSOVER = MIN / POS_RATE;                       /* KES at which rate overtakes floor */
ok('the floor/rate crossover is derived from the live rate',
   Number.isFinite(CROSSOVER) && CROSSOVER > MIN, 'KES ' + CROSSOVER.toFixed(2));
[
  [1, 'capped'], [5, 'capped'], [MIN, 'capped'],
  [MIN + 1, 'floor'], [Math.floor(CROSSOVER / 2), 'floor'], [Math.ceil(CROSSOVER) - 1, 'floor'],
  [Math.ceil(CROSSOVER), 'rate'], [Math.ceil(CROSSOVER) * 2, 'rate'], [100000, 'rate']
].forEach(([kes, expect]) => {
  const r = CC.resolvePosRate('seller_free');
  const grossMinor = Math.round(kes * 100);
  const c = MA.computeCommission({
    gross: KES(kes), rateFraction: r.rateFraction,
    minimumMinor: MIN_MINOR, floorExempt: r.floorExempt
  });
  const byRate = Math.round(grossMinor * POS_RATE);
  const which = c.commission.minorUnits === grossMinor && grossMinor <= MIN_MINOR ? 'capped'
              : c.commission.minorUnits === MIN_MINOR && byRate < MIN_MINOR ? 'floor'
              : 'rate';
  ok('POS, KES ' + kes + ' -> ' + expect, which === expect,
     'got ' + which + ', commission=' + MA.toMajorString(c.commission));
  ok('POS, KES ' + kes + ' — commission never exceeds the sale',
     c.commission.minorUnits <= grossMinor);
});
{
  /* The exact crossing point, computed for whatever the live rate is. Below it the floor
     must bind and say so; at or above it the rate must take over and say so. */
  const r = CC.resolvePosRate('seller_free');
  const below = Math.ceil(CROSSOVER) - 1;
  const above = Math.ceil(CROSSOVER);
  const atBelow = MA.computeCommission({ gross: KES(below), rateFraction: r.rateFraction,
    minimumMinor: MIN_MINOR, floorExempt: r.floorExempt });
  const atAbove = MA.computeCommission({ gross: KES(above), rateFraction: r.rateFraction,
    minimumMinor: MIN_MINOR, floorExempt: r.floorExempt });
  ok('floor binds just below the crossover (KES ' + below + ')',
     atBelow.commission.minorUnits === MIN_MINOR, MA.toMajorString(atBelow.commission));
  ok('rate takes over at the crossover (KES ' + above + ')',
     atAbove.commission.minorUnits === Math.round(above * 100 * POS_RATE),
     MA.toMajorString(atAbove.commission));
  ok('floorApplied flag is truthful below the crossover', atBelow.floorApplied === true);
  ok('floorApplied flag is truthful at the crossover', atAbove.floorApplied === false);
}
{
  /* the floor never exceeds the sale itself */
  const r = CC.resolvePosRate('seller_free');
  const c = MA.computeCommission({ gross: KES(3), rateFraction: r.rateFraction,
    minimumMinor: MIN_MINOR, floorExempt: r.floorExempt });
  ok('a KES 3 sale is not charged KES 10', c.commission.minorUnits === 300,
     MA.toMajorString(c.commission));
  ok('net never negative on a tiny sale', c.net.minorUnits === 0);
}

/* ── 4 · Enterprise is GENUINELY zero, including tiny transactions ─────────── */
/* This behaviour did not disappear when the ladder moved — it MOVED WITH IT. 0% now
   exists on the MARKETPLACE lane, so that is where it is certified. Reading it from the
   POS lane after the ruling would assert 5% === 0 and fail, or worse, be deleted and take
   the floorExempt guarantee with it. */
{
  /* THIS BLOCK WAS PINNED TO A PLAN, AND THE PLAN MOVED.
     It read `resolveMarketplaceRate('seller_enterprise')` and asserted 0% + floorExempt. That
     was true when Enterprise was free; it stopped being true on 2026-09-13 (ladder 16/12/8/4)
     and is further from true after 2026-09-22 (flat 15%). The suite has therefore been RED for
     nine days over a repricing that was entirely intended — the assertion was measuring the
     price, not the guarantee.

     THE GUARANTEE IS ABOUT THE ARITHMETIC, NOT ABOUT WHO HOLDS THE RATE: a genuine 0% rate
     carrying floorExempt must charge nothing at EVERY amount, including below the floor. That
     is certified here against a CONSTRUCTED rate, so it holds whether or not any plan is
     currently zero — which is the whole point, because the trap it guards (a "0%" plan
     silently charging the KES 10 minimum) reappears the moment a zero-rated plan is
     reintroduced, and a deleted assertion would not be there to catch it.

     The contrast case immediately below — 0% WITHOUT floorExempt charges KES 10 — is the
     inverting control that makes this one mean something. */
  const ZERO = { rateFraction: 0, floorExempt: true };
  let bad = 0;
  for (const kes of [0.01, 1, 5, 9.99, 10, 10.01, 66, 67, 100, 1000, 100000]) {
    const c = MA.computeCommission({
      gross: KES(kes), rateFraction: ZERO.rateFraction,
      minimumMinor: MIN_MINOR, floorExempt: ZERO.floorExempt
    });
    if (c.commission.minorUnits !== 0) bad++;
    if (c.net.minorUnits !== Math.round(kes * 100)) bad++;
  }
  ok('a genuine 0% floor-exempt rate pays ZERO at every amount incl. below the floor',
     bad === 0, bad + ' non-zero');

  /* And the TABLE invariant, in both directions, derived — never a literal. If a plan is
     zero-rated it MUST be floor-exempt (or "0%" quietly bills KES 10); if it is non-zero it
     must NOT be (or one tier escapes the minimum for no stated reason). */
  const PLANS = CC.MARKETPLACE_PLAN_RATES || {};
  ok('every marketplace plan agrees with the floor-exemption invariant',
     Object.keys(PLANS).every(k =>
       PLANS[k].rateFraction === 0 ? PLANS[k].floorExempt === true : PLANS[k].floorExempt === false),
     Object.keys(PLANS).map(k => k + '=' + PLANS[k].rateFraction + '/' + PLANS[k].floorExempt).join(' '));

  /* The till is never free, at any plan — the one price fact this lane really owns. */
  ok('Enterprise POS rate is NOT zero — the till is never free',
     CC.resolvePosRate('seller_enterprise').rateFraction === POS_RATE);
}
{
  /* the trap this exists to prevent: without floorExempt, "0%" would charge KES 10 */
  const c = MA.computeCommission({ gross: KES(1000), rateFraction: 0,
    minimumMinor: MIN_MINOR, floorExempt: false });
  ok('CONTRAST: a 0% rate WITHOUT floorExempt would charge KES 10',
     c.commission.minorUnits === 1000, MA.toMajorString(c.commission));
}

/* ── 5 · the full chain, both custody modes ────────────────────────────────── */
/* On a KES 1,000 till sale every plan pays the same, because the POS lane is flat. The
   numbers are computed from the rate rather than typed, so this table cannot disagree
   with the schedule it is certifying. */
const CHAIN_GROSS_MINOR = 100000;                        /* KES 1,000 */
const CHAIN_COMM = Math.round(CHAIN_GROSS_MINOR * POS_RATE);
[
  ['seller_free',       CHAIN_GROSS_MINOR - CHAIN_COMM, CHAIN_COMM],
  ['seller_basic',      CHAIN_GROSS_MINOR - CHAIN_COMM, CHAIN_COMM],
  ['seller_pro',        CHAIN_GROSS_MINOR - CHAIN_COMM, CHAIN_COMM],
  ['seller_enterprise', CHAIN_GROSS_MINOR - CHAIN_COMM, CHAIN_COMM]
].forEach(([plan, expectNet, expectComm]) => {
  const r = CC.resolvePosRate(plan);
  const custodial = MA.planSaleAccounting({
    gross: KES(1000), rateFraction: r.rateFraction, custody: MA.CUSTODY.CUSTODIAL,
    minimumMinor: MIN_MINOR, floorExempt: r.floorExempt
  });
  ok(plan + ' custodial KES 1,000 -> credit ' + (expectNet / 100),
     custodial.merchantCredit.minorUnits === expectNet, String(custodial.merchantCredit.minorUnits));
  ok(plan + ' custodial commission ' + (expectComm / 100),
     custodial.commission.minorUnits === expectComm);

  const cash = MA.planSaleAccounting({
    gross: KES(1000), rateFraction: r.rateFraction, custody: MA.CUSTODY.NON_CUSTODIAL,
    minimumMinor: MIN_MINOR, floorExempt: r.floorExempt
  });
  ok(plan + ' CASH credits nothing', cash.merchantCredit.minorUnits === 0);
  ok(plan + ' CASH owes ' + (expectComm / 100), cash.liability.minorUnits === expectComm);
});
{
  /* the 95% cash day, end to end */
  const r = CC.resolvePosRate('seller_free');
  const cash = MA.planSaleAccounting({ gross: KES(95000), rateFraction: r.rateFraction,
    custody: MA.CUSTODY.NON_CUSTODIAL, minimumMinor: MIN_MINOR, floorExempt: r.floorExempt });
  const elec = MA.planSaleAccounting({ gross: KES(5000), rateFraction: r.rateFraction,
    custody: MA.CUSTODY.CUSTODIAL, minimumMinor: MIN_MINOR, floorExempt: r.floorExempt });
  const cashComm = Math.round(9500000 * POS_RATE);
  const elecComm = Math.round(500000 * POS_RATE);
  ok('95k cash -> liability ' + (cashComm / 100) + ', credit 0',
     cash.liability.minorUnits === cashComm && cash.merchantCredit.minorUnits === 0,
     String(cash.liability.minorUnits));
  ok('5k electronic -> credit ' + ((500000 - elecComm) / 100),
     elec.merchantCredit.minorUnits === (500000 - elecComm),
     String(elec.merchantCredit.minorUnits));
  /* Derived: the whole day is one flat rate, so the total is the rate on the total. */
  const dayTotal = Math.round(10000000 * POS_RATE);
  ok('total commission on 100k of till sales = ' + (dayTotal / 100),
     cash.commission.minorUnits + elec.commission.minorUnits === dayTotal,
     String(cash.commission.minorUnits + elec.commission.minorUnits));
}

/* ── 6 · nothing live changed ──────────────────────────────────────────────── */
ok('marketplace still 5%', CC.resolveRate('marketplace').pct === 5);
ok('POS still PRICES as marketplace (alias intact)',
   CC.resolveRate('pos').category === 'marketplace' && CC.resolveRate('pos').pct === 5);
ok('the 48-HOUR settlement gate still sees POS as marketplace',
   CC.categoryForHub('pos') === 'marketplace', CC.categoryForHub('pos'));
ok('no `pos` key was added to RATES (it would beat the alias)',
   !Object.prototype.hasOwnProperty.call(CC.RATES, 'pos'));
['product', 'shopping', 'b2b', 'food', 'property'].forEach((k) => {
  ok('alias ' + k + ' unchanged', CC.resolveRate(k).matched === true);
});
ok('POS_PLAN_RATES is frozen', Object.isFrozen(CC.POS_PLAN_RATES));

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
  /* SABOTAGE: plant a second commission table and require the guard to catch it.
   *
   * The file is left UNTRACKED deliberately. That is the case the guard used to miss: it
   * enumerated `git ls-files`, so an untracked file shipped (functions/ deploys whole, with
   * no .gcloudignore) while being invisible to the gate. The first version of this control
   * planted exactly this and the guard PASSED — the control reported itself broken, which is
   * how the blind spot was found at all.
   *
   * Since the guard now enumerates the DEPLOY FOOTPRINT, an untracked plant is both the
   * stronger test and the safer one: no git index manipulation in a shared working tree. */
  const ROOT = path.join(__dirname, '..');
  const rel = 'functions/_sabotage_second_table.js';
  const victim = path.join(ROOT, rel);
  let caught = false;
  try {
    fs.writeFileSync(victim,
      '/* temporary sabotage control — untracked on purpose */\nconst commission_rate = 0.15;\n' +
      'module.exports = { commission_rate };\n');
    const r = spawnSync(process.execPath,
      [path.join(__dirname, 'verify-commission-single-source.js')],
      { encoding: 'utf8', cwd: ROOT });
    caught = r.status !== 0 && /_sabotage_second_table/.test(String(r.stdout || ''));
  } finally {
    try { fs.unlinkSync(victim); } catch (_) {}
  }
  console.log('    ' + (caught ? 'PASS' : 'FAIL') +
              '  the single-source guard catches a planted second commission table');
  if (!caught) controlsOk = false;

  /* and it must be GREEN again once the sabotage is removed */
  const after = spawnSync(process.execPath,
    [path.join(__dirname, 'verify-commission-single-source.js')],
    { encoding: 'utf8', cwd: path.join(__dirname, '..') });
  console.log('    ' + (after.status === 0 ? 'PASS' : 'FAIL') +
              '  the guard is green again after cleanup');
  if (after.status !== 0) controlsOk = false;
}

console.log('');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
if (!controlsOk) {
  console.log('');
  console.log('  BLOCKED — a control misbehaved; the result above cannot be trusted.');
  process.exit(1);
}
process.exit(fail > 0 ? 1 : 0);
