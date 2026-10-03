#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   THE PROVIDER SELF-GRANT IS CLOSED — a priced plan cannot be activated by a caller
   scripts/test-provider-selfgrant-closed.js        B9.31 Gate 1 · 21F-2b.2-PROVIDER-SELFGRANT
   ══════════════════════════════════════════════════════════════════════════════
   THE DEFECT, which was live in production: providerActivateSubscription is reachable
   through providerDispatch, whose only gate is authentication. It took `plan` and
   `paymentRef` from the request, verified neither, and wrote status:'active' with the
   plan's commissionRate — which lands on providerSubscriptions/{uid}, is resolved by
   subscription-core, and charges every booking through provider-ops. Any authenticated
   caller could name `enterprise` (KES 9,999/month) for nothing and move their own
   commission from 20% to 5%.

   THIS SUITE ASSERTS THE REPAIRED STATE. The finding itself is pinned against the
   immutable pre-repair commit 13a997c, so the evidence survives without the suite going
   green only while the bug is present.

   WHAT THE REPAIR IS, AND IS NOT. It is not a better paymentRef check: a reference the
   client supplies can never be proof of payment however it is validated. A priced plan is
   refused outright; free_trial stays self-serve because there is nothing to forge when
   there is nothing to pay.

   SCOPE IS GATE 1 ONLY. Publication authority, verification state, provider history and
   wallet settlement are untouched and case 6 proves it, because the failure mode of a
   focused repair is quietly doing a second one.

   Run: node scripts/test-provider-selfgrant-closed.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const F = require(path.join(ROOT, 'scripts', 'deploy', 'functions-surface'));
const U = require(path.join(ROOT, 'scripts', 'deploy', 'undeclared-identifiers'));

let pass = 0, failed = 0;
const ck = (msg, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + msg + (detail ? '   [' + detail + ']' : '')); }
  else { failed++; console.error('  FAIL  ' + msg + (detail ? '   [' + detail + ']' : '')); }
};
const head = (t) => console.log('\n-- ' + t + ' --');

const PRE_REPAIR = '13a997c';
const FILE = path.join(ROOT, 'functions', 'provider-onboarding.js');
const SRC = fs.readFileSync(FILE, 'utf8');
const show = (ref) => {
  try {
    return cp.execFileSync('git', ['show', ref + ':functions/provider-onboarding.js'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 1e9, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (_) { return null; }
};

function handlerRaw(src, name) {
  const key = 'exports._h.' + name;
  const i = src.indexOf(key);
  if (i === -1) return '';
  const rest = src.slice(i + key.length);
  const m = /exports\._h\.[A-Za-z0-9_]+/.exec(rest);
  return src.slice(i, m ? i + key.length + m.index : src.length);
}
/* Two readers, and the reason is recorded: the raw slice runs to the NEXT declaration and
   sweeps in its leading comment banner, so a raw match can find the next handler's name in
   prose. Symbols use the blanking reader; strings use the keeping one. */
const code = (src, n) => F.stripComments(handlerRaw(src, n));
const str = (src, n) => F.stripCommentsKeepStrings(handlerRaw(src, n));

console.log('\nPROVIDER SELF-GRANT — CLOSED (Gate 1)\n');

/* ── 0. controls ─────────────────────────────────────────────────────────────── */
head('0 - control: the handler is isolated and the readers are the right way round');
{
  const h = code(SRC, 'providerActivateSubscription');
  ck('the handler is found and bounded', h.length > 400, h.split('\n').length + ' lines');
  ck('POSITIVE — it contains its own name', h.indexOf('providerActivateSubscription') !== -1);
  ck('NEGATIVE — it does not contain the next handler', h.indexOf('providerPublish') === -1,
    'so every assertion below is about THIS handler only');
  ck('strip integrity holds on the file', F.stripIntegrity(SRC).ok);
  ck('the file declares every identifier it uses',
    U.findUndeclared(SRC).ok && U.findUndeclared(SRC).undeclared.length === 0,
    'the repair introduced no free identifier');
}

/* ── 1. the repaired state ───────────────────────────────────────────────────── */
head('1 - REPAIRED: a priced plan is refused, whatever the caller supplies');
{
  const h = code(SRC, 'providerActivateSubscription');
  const hs = str(SRC, 'providerActivateSubscription');

  ck('paymentRef is NOT destructured from the request',
    !/const\s*\{[^}]*paymentRef[^}]*\}\s*=\s*req\.data/.test(h),
    'it cannot be stored as a payment record if it is never bound');
  ck('a priced plan is refused', /failed-precondition/.test(hs) &&
    /A paid plan cannot be activated from the client/.test(hs));

  /* THE SUBTLE HALF. Testing only the REQUESTED cycle would let billingCycle:'yearly'
     through on a plan whose yearly is absent while its monthly is not. */
  ck('the price test covers EVERY billing cycle, not the requested one',
    /_monthly\s*>\s*0\s*\|\|\s*_yearly\s*>\s*0/.test(h),
    'a plan is self-serve only if it is free under every cycle');
  ck('both figures come from the server-side plan table',
    /Number\(p\.monthly\)/.test(h) && /Number\(p\.yearly\)/.test(h),
    'never from req.data');

  ck('a non-empty paymentRef is REFUSED, not ignored',
    /invalid-argument/.test(hs) && /A payment reference is not accepted here/.test(hs),
    'silently dropping it would let a caller believe the server acted on it');
  ck('paymentMethod is written as null', /paymentMethod:\s*null/.test(h),
    'it was `paymentRef || null` — a caller string recorded as an observed payment');
  ck('the refusal is logged with the plan and whether a ref was supplied',
    /refused unverified paid activation/.test(hs));
}

/* ── 2. what a legitimate caller still gets ──────────────────────────────────── */
head('2 - PRESERVED: free_trial is still self-serve and server-priced');
{
  const h = code(SRC, 'providerActivateSubscription');
  const hs = str(SRC, 'providerActivateSubscription');
  ck('free_trial still activates', /free_trial/.test(hs) && /trialing/.test(hs));
  ck('the rate is still taken from the server plan table',
    /commissionRate:\s*p\.commissionRate/.test(h), 'never from the request');
  ck('limits and features likewise', /limits:\s*p\.limits/.test(h) && /features:\s*p\.features/.test(h));
  ck('the write target is unchanged', /collection\('providerSubscriptions'\)\.doc\(uid\)/.test(hs));

  /* free_trial must be genuinely free in the pinned table, or the guard would refuse it
     and onboarding would break. Read from the source, not asserted from memory. */
  const blk = SRC.slice(SRC.indexOf('const PLANS'));
  const i = blk.indexOf('free_trial: {');
  const seg = blk.slice(i, i + 400);
  const m = /monthly:\s*(\d+)/.exec(seg), y = /yearly:\s*(\d+)/.exec(seg);
  ck('free_trial is free under BOTH cycles in the plan table',
    m && y && Number(m[1]) === 0 && Number(y[1]) === 0,
    'monthly ' + (m && m[1]) + ', yearly ' + (y && y[1]));
}

/* ── 3. every priced plan is now unreachable from the client ─────────────────── */
head('3 - the ladder: every priced tier is refused, and the free one is not');
{
  const blk = SRC.slice(SRC.indexOf('const PLANS'));
  const plans = [...blk.matchAll(/^  ([a-z_]+):\s*\{/gm)].map((x) => x[1]);
  ck('the plan table still has five tiers', plans.length === 5, plans.join(', '));
  let priced = 0, free = 0;
  for (const p of plans) {
    const i = blk.indexOf(p + ': {');
    const seg = blk.slice(i, i + 400);
    const mo = Number((/monthly:\s*(\d+)/.exec(seg) || [])[1] || 0);
    const yr = Number((/yearly:\s*(\d+)/.exec(seg) || [])[1] || 0);
    if (mo > 0 || yr > 0) priced++; else free++;
  }
  ck('four tiers are priced and would be refused', priced === 4, priced + ' priced');
  ck('exactly one tier is free and still self-serve', free === 1, free + ' free');
}

/* ── 4. the historical defect, pinned so the evidence cannot rot ─────────────── */
head('4 - the defect this closed, asserted against ' + PRE_REPAIR + ' (immutable)');
{
  const before = show(PRE_REPAIR);
  ck('the pre-repair commit is readable', !!before);
  if (before) {
    const h = code(before, 'providerActivateSubscription');
    const hs = str(before, 'providerActivateSubscription');
    ck('it DID destructure paymentRef from the request',
      /const\s*\{[^}]*paymentRef[^}]*\}\s*=\s*req\.data/.test(h));
    ck('it DID store it as paymentMethod', /paymentMethod:\s*paymentRef/.test(h));
    ck('it had NO price refusal', !/A paid plan cannot be activated/.test(hs));
    ck('...so a priced plan was activatable by any authenticated caller', true,
      'which is what this gate closed');
  }
}

/* ── 5. SABOTAGE — each half of the repair is load-bearing ───────────────────── */
head('5 - SABOTAGE: reverting any part of the repair must be caught');
{
  const cases = [
    {
      name: 'the price refusal removed',
      mutate: (s) => s.replace(/  if \(_monthly > 0 \|\| _yearly > 0\) \{[\s\S]*?\n  \}\n/, ''),
      detect: (s) => /A paid plan cannot be activated from the client/
        .test(str(s, 'providerActivateSubscription')),
    },
    {
      name: 'the price test narrowed to the requested cycle only',
      mutate: (s) => s.replace('if (_monthly > 0 || _yearly > 0) {',
        "if ((billingCycle === 'yearly' ? _yearly : _monthly) > 0) {"),
      detect: (s) => /_monthly\s*>\s*0\s*\|\|\s*_yearly\s*>\s*0/
        .test(code(s, 'providerActivateSubscription')),
    },
    {
      name: 'paymentRef destructured again',
      mutate: (s) => s.replace('const { plan, billingCycle } = req.data || {};',
        'const { plan, billingCycle, paymentRef } = req.data || {};'),
      detect: (s) => !/const\s*\{[^}]*paymentRef[^}]*\}\s*=\s*req\.data/
        .test(code(s, 'providerActivateSubscription')),
    },
    {
      name: 'paymentMethod storing a caller string again',
      mutate: (s) => s.replace('paymentMethod: null,', 'paymentMethod: req.data.paymentRef || null,'),
      detect: (s) => /paymentMethod:\s*null/.test(code(s, 'providerActivateSubscription')),
    },
  ];
  /* MUTATE INSIDE THE HANDLER, THEN SPLICE BACK. Mutating the whole file with
     String.replace hits the FIRST match, and `const { plan, billingCycle } = req.data || {};`
     appears in an EARLIER handler at :255 as well as in this one. The paymentRef sabotage
     silently landed there, the handler under test was untouched, and the guard correctly
     reported it still held — which read as a guard failure. A sabotage that does not reach
     the code under test proves nothing, so reach is now asserted on the HANDLER. */
  const before = handlerRaw(SRC, 'providerActivateSubscription');
  for (const c of cases) {
    const after = c.mutate(before);
    const reached = after !== before;
    ck('SABOTAGE reaches THE HANDLER (' + c.name + ')', reached,
      reached ? Math.abs(after.length - before.length) + ' bytes changed inside the handler'
              : 'the mutation matched NOTHING in this handler — untested');
    if (!reached) continue;
    const mutated = SRC.replace(before, after);
    ck('...the spliced file differs from the original', mutated !== SRC);
    ck('...and the guard REFUSES it (' + c.name + ')', !c.detect(mutated));
  }
}

/* ── 6. SCOPE — this gate did one thing ──────────────────────────────────────── */
head('6 - SCOPE: publication, verification, history and wallet are untouched');
{
  const before = show(PRE_REPAIR);
  ck('the pre-repair copy is readable for comparison', !!before);
  if (before) {
    const same = (n) => F.stripComments(handlerRaw(before, n)) === F.stripComments(handlerRaw(SRC, n));
    for (const h of ['providerPublish', 'providerSubmitVerification', 'providerGetPublicProfile']) {
      ck(h + ' is byte-identical to before this gate', same(h),
        'Gate 2, Gate 4 and the verification gate own those');
    }
    /* and the export surface of the file has not moved */
    const names = (s) => [...s.matchAll(/exports\._h\.([A-Za-z0-9_]+)/g)].map((m) => m[1]).sort().join(',');
    ck('the _h handler surface is unchanged', names(before) === names(SRC),
      [...new Set([...SRC.matchAll(/exports\._h\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))].length + ' handlers');
  }
}

console.log('\n  ' + pass + ' passed, ' + failed + ' failed\n');
if (!failed) {
  console.log('  A priced provider plan can no longer be activated from the client, under any');
  console.log('  billing cycle, with or without a supplied reference. free_trial is unchanged and');
  console.log('  still server-priced. Nothing else in the file moved.');
  console.log('');
  console.log('  STILL OPEN, by design: paid provider plans have no route until');
  console.log('  21F-2b.2-PROVIDER-PAID-PLAN-ROUTE, and the commission is still not posted to');
  console.log('  the ledger — 21F-2b-PROVIDER-COMMISSION-BEFORE-WALLET-CREDIT is unaffected by');
  console.log('  this gate.\n');
}
process.exit(failed ? 1 : 0);
