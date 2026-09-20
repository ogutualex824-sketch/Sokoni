/* ══════════════════════════════════════════════════════════════════════════════
   W4 — entitlement-adapters subscription period            (A4-F3E certification)
   scripts/test-entitlement-adapter-period.js

   WHAT W4 IS, PRECISELY
   Not dormant code. It EXECUTES in production, on every subscription payment:

       webhookIntasend -> shadowCompareSubscription -> engine.simulate()
                       -> subscription.activate(capture, ctx)

   engine.simulate() passes a CAPTURE transaction: get() is a real read, but
   set/create/update/delete are pushed to an array and never applied. The engine's
   own ledger — collection `entitlements`, keyed by paymentRef, written by
   txn.create() exactly once per activation — holds ZERO such rows in production.
   So W4 runs, and W4 has never written.

   Neither caller of the real engine.activate() can reach it either:
     payment-reconciliation  routes purpose === 'subscription' to W3 explicitly
     healthcare trigger      returns unless purpose === 'healthcare_subscription'
   and `isEngineEnabled()` has no call sites at all, so the _systemConfig flag
   gates nothing — the routing is what makes W4 non-authoritative, not a flag.

   WHY REPAIR SOMETHING THAT CANNOT WRITE
   Drift prevention, not damage repair. Production holds two shadow comparisons;
   one reports an expiry mismatch against the real subscription document, caused
   entirely by W4's flat span. A comparison that cries wolf teaches readers to
   ignore it. And if any future caller routes a `subscription` intent into
   engine.activate(), W4 becomes a live writer still carrying the defect A4 and
   A4-F3D removed from the other three.

   THIS SUITE REQUIRES THE REAL MODULE AND CALLS THE REAL ADAPTER. What is
   asserted is what W4 computes, not what its source looks like.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
};
const head = t => console.log('\n' + t);
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ── Stub firebase-admin/firestore BEFORE the adapter module loads ────────── */
const NM = path.join(ROOT, 'functions/node_modules');
const fsPath = require.resolve('firebase-admin/firestore', { paths: [NM] });
const TS = { fromDate: d => ({ __ts: d }) };
require.cache[fsPath] = {
  id: fsPath, filename: fsPath, loaded: true, exports: {
    getFirestore: () => ({
      collection: (c) => ({ doc: (id) => ({ path: c + '/' + id, get: async () => ({ exists: false, data: () => ({}) }) }) }),
    }),
    FieldValue: { serverTimestamp: () => '<ts>' },
    Timestamp: TS,
  },
};

const ADAPTERS_PATH = path.join(ROOT, 'functions/entitlement-adapters.js');
let adapters = null, loadErr = null;
try { adapters = require(ADAPTERS_PATH); } catch (e) { loadErr = e; }

const SRC = fs.readFileSync(ADAPTERS_PATH, 'utf8');
const D = s => new Date(s + 'T00:00:00Z');
const f = d => d.toISOString().slice(0, 10);

/* A capture transaction, exactly as engine.simulate() builds one. */
function capture () {
  const ops = [];
  return {
    ops,
    txn: {
      get: async (r) => r.get(),
      set: (r, v, o) => ops.push({ op: 'set', path: r.path, data: v, merge: !!(o && o.merge) }),
      create: (r, v) => ops.push({ op: 'create', path: r.path, data: v }),
      update: (r, v) => ops.push({ op: 'update', path: r.path, data: v }),
      delete: (r) => ops.push({ op: 'delete', path: r.path }),
    },
  };
}
function runW4 (cycle, over) {
  const c = capture();
  const ctx = Object.assign({
    paymentRef: 'REF1', ownerUid: 'u1',
    intent: { purpose: 'subscription', planId: 'pro', uid: 'u1', billingCycle: cycle },
    resourceId: null,
  }, over || {});
  try { const domain = adapters.subscription.activate(c.txn, ctx); return { ok: true, ops: c.ops, domain }; }
  catch (e) { return { ok: false, error: e, ops: c.ops }; }
}
const sub = (r) => (r.ops.find(o => /^subscriptions\//.test(o.path)) || null);

/* The three existing period implementations, extracted from the shipped files. */
function block (src, from) {
  const open = src.indexOf('{', from); let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (d === 0) return src.slice(from, i + 1); }
  }
  return null;
}
function extract (file, name) {
  const s = fs.readFileSync(path.join(ROOT, 'functions', file), 'utf8');
  const i = s.indexOf('function ' + name + '(');
  return i === -1 ? null : block(s, i);
}
/* eslint-disable no-new-func */
const W1 = new Function(extract('index.js', '_subPeriodEnd') + '\n return _subPeriodEnd;')();
const W3 = new Function(extract('payment-reconciliation.js', '_periodEnd') + '\n return _periodEnd;')();
const SB = new Function(extract('sub-billing.js', '_addMonths') + '\n' +
                        extract('sub-billing.js', '_periodEnd') + '\n return _periodEnd;')();

(function () {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  W4 — entitlement-adapters subscription period (A4-F3E)');
  console.log('══════════════════════════════════════════════════════════════════');

  head('0 - controls');
  ok('the real adapter module loads', !!adapters && !loadErr, loadErr ? loadErr.message : '');
  if (!adapters) {
    console.log('\n  NOTHING WAS PROVEN — the module could not be required.');
    console.log('\n  ' + pass + ' passed, ' + (fail + 1) + ' failed\n');
    process.exit(1);
  }
  ok('subscription.activate is the function under test', typeof adapters.subscription.activate === 'function');
  ok('control — a valid cycle produces a captured write', !!sub(runW4('annual')));
  ok('control — the other three period functions extracted', !!W1 && !!W3 && !!SB);

  /* ── 1. THE PERIOD ───────────────────────────────────────────────────────── */
  head('1 - W4 derives the period from the purchased cycle');
  {
    /* Executed against a frozen clock by comparing to the same instant. */
    const a = sub(runW4('annual')), m = sub(runW4('monthly'));
    const months = (w) => {
      const d = w.data.expiresAt.__ts, n = new Date();
      return (d.getFullYear() - n.getFullYear()) * 12 + (d.getMonth() - n.getMonth());
    };
    ok('annual is twelve months out', months(a) === 12, months(a) + ' months');
    ok('monthly is one month out', months(m) === 1, months(m) + ' months');
    ok('and they genuinely differ',
       f(a.data.expiresAt.__ts) !== f(m.data.expiresAt.__ts));

    /* Boundary vectors — asserted on the shipped _periodEnd this adapter now
       calls, since activate() uses new Date() internally. */
    const P = new Function(extract('entitlement-adapters.js', '_periodEnd') + '\n return _periodEnd;')();
    [['2026-01-31', 'monthly', '2026-03-03'], ['2024-02-29', 'annual', '2025-03-01'],
     ['2026-01-31', 'annual', '2027-01-31'], ['2026-02-28', 'monthly', '2026-03-28'],
     ['2026-03-15', 'annual', '2027-03-15']].forEach(([s, c, want]) => {
      ok(s + ' ' + c.padEnd(7) + ' -> ' + want, f(P(D(s), c)) === want, f(P(D(s), c)));
    });

    /* AGREEMENT with every other implementation — this is what makes a fourth
       local copy safe rather than a fourth chance to diverge. */
    let agree = true, diffs = [];
    ['2026-01-31', '2026-02-28', '2024-02-29', '2026-03-15', '2026-12-31'].forEach(s => {
      ['monthly', 'annual'].forEach(c => {
        const got = f(P(D(s), c));
        if (got !== f(W1(D(s), c)) || got !== f(W3(D(s), c)) || got !== f(SB(D(s), c))) {
          agree = false; diffs.push(s + '/' + c);
        }
      });
    });
    ok('W4 agrees with W1, W3 and sub-billing on every vector', agree, diffs.join(' ') || '10 vectors');
  }

  /* ── 2. PROVENANCE AND FAIL-CLOSED ───────────────────────────────────────── */
  head('2 - the cycle comes from the intent, and an unknown one refuses');
  {
    const none = runW4(undefined);
    ok('a missing cycle throws', !none.ok && none.error.code === 'billing_cycle_missing',
       none.ok ? 'WROTE ANYWAY' : none.error.code);
    ok('and captures no write', none.ops.length === 0);
    const bad = runW4('weekly');
    ok('an unrecognised cycle throws', !bad.ok && bad.error.code === 'billing_cycle_missing');
    ok('a missing cycle does NOT silently become monthly', !none.ok && !bad.ok);

    /* ADVERSARIAL PROVENANCE. The intent is the server-authoritative record; the
       payment document is shaped by the provider callback. If W4 ever preferred
       the payment's cycle, a provider could choose the term. Both are supplied
       here, disagreeing, and the intent must win — a source-only assertion
       missed exactly this and passed a sabotage that swapped the source. */
    const annualIntent = runW4('annual', {
      intent: { purpose: 'subscription', planId: 'pro', uid: 'u1', billingCycle: 'annual' },
      payment: { billingCycle: 'monthly', status: 'COMPLETE' },
    });
    const monthlyIntent = runW4('monthly', {
      intent: { purpose: 'subscription', planId: 'pro', uid: 'u1', billingCycle: 'monthly' },
      payment: { billingCycle: 'annual', status: 'COMPLETE' },
    });
    const mo = (w) => { const d = sub(w).data.expiresAt.__ts, n = new Date();
      return (d.getFullYear() - n.getFullYear()) * 12 + (d.getMonth() - n.getMonth()); };
    ok('intent annual + payment says monthly -> 12 months', mo(annualIntent) === 12,
       mo(annualIntent) + ' months');
    ok('intent monthly + payment says annual -> 1 month', mo(monthlyIntent) === 1,
       mo(monthlyIntent) + ' months');

    const code = strip(SRC);
    ok('the cycle is read from ctx.intent', /ctx\.intent\.billingCycle/.test(code));
    ok('W4 no longer depends on PLAN_DAYS',
       !/expiresAt = Timestamp\.fromDate\(new Date\(Date\.now\(\) \+ PLAN_DAYS/.test(code));
    ok('control — stripping removed the prose those patterns also appear in',
       strip(SRC).length < SRC.length * 0.75, SRC.length + ' -> ' + strip(SRC).length);
  }

  /* ── 3. STILL SHADOW-ONLY ────────────────────────────────────────────────── */
  head('3 - nothing here made W4 authoritative');
  {
    const r = runW4('annual');
    ok('the write is CAPTURED, never applied', r.ops.length === 1 && r.ops[0].op === 'set');
    ok('and it targets subscriptions/{uid}', r.ops[0].path === 'subscriptions/u1', r.ops[0].path);
    ok('activate still uses the SUPPLIED transaction, not its own',
       /activate\(txn, ctx\)/.test(SRC) && /txn\.set\(subRef/.test(strip(SRC)));

    const eng = fs.readFileSync(path.join(ROOT, 'functions/entitlement-engine.js'), 'utf8');
    ok('simulate() still discards every mutation',
       /set:\s+\(r, v, o\) => ops\.push/.test(eng) && /const domain = await spec\.handler\.activate\(capture, ctx\)/.test(eng));
    const recon = fs.readFileSync(path.join(ROOT, 'functions/payment-reconciliation.js'), 'utf8');
    ok('the reconciler still routes subscriptions to W3, not the engine',
       /if \(purpose === 'subscription'\)/.test(recon) && /healSubscriptionEntitlement\(intent, ref, log\)/.test(recon));
    const hc = fs.readFileSync(path.join(ROOT, 'functions/healthcare-subscription-activation.js'), 'utf8');
    ok('the healthcare trigger still returns on any other purpose',
       /intent\.purpose !== PURPOSE/.test(hc));
    ok('shadowCompareSubscription still records shadowOnly', /shadowOnly:\s+true/.test(SRC));
  }

  /* ── 4. PLAN_DAYS SURVIVES WHERE IT IS STILL A CONTRACT ──────────────────── */
  head('4 - PLAN_DAYS removed as W4 authority, kept everywhere it still means something');
  {
    const code = strip(SRC);
    ok('the constant still exists', /const PLAN_DAYS\s+= 30;/.test(code));
    ok('still exported', /PLAN_DAYS,?\s*\n?\s*\}/.test(code) || /PLAN_DAYS/.test(code.split('module.exports')[1] || ''));
    ok('healthcare currentPeriodEnd still uses it',
       /currentPeriodEnd:\s+Timestamp\.fromDate\(new Date\(now \+ PLAN_DAYS \* 86400000\)\)/.test(code));
    ok('healthcare renewalAt still uses it',
       /renewalAt:\s+Timestamp\.fromDate\(new Date\(now \+ PLAN_DAYS \* 86400000\)\)/.test(code));
    ok('both registerPurpose expiresDays still use it',
       (code.match(/expiresDays:\s+PLAN_DAYS/g) || []).length === 2,
       (code.match(/expiresDays:\s+PLAN_DAYS/g) || []).length + ' occurrences');
    ok('the healthcare adapter is otherwise unchanged — still billingCycle monthly',
       /billingCycle:\s+'monthly'/.test(code), 'its own contract, not adjudicated here');
    /* INVERTING CONTROL — the assertions above would be vacuous if PLAN_DAYS had
       simply been deleted, so prove the file still contains real uses of it. */
    ok('INVERTING CONTROL — PLAN_DAYS still has executable uses',
       (code.match(/PLAN_DAYS/g) || []).length >= 5,
       (code.match(/PLAN_DAYS/g) || []).length + ' in stripped code');
  }

  console.log('\n  what this suite does NOT prove');
  console.log('  SCOPE     W4 remains SHADOW-ONLY and NON-AUTHORITATIVE. This repair does not');
  console.log('            make it a writer, and does not change engine routing.');
  console.log('  OPEN      Four modules now define the same period function. They are proven');
  console.log('            equivalent here; collapsing them onto one shared module is a');
  console.log('            separate decision and touches protected files.');
  console.log('  UNTOUCHED healthcare and digital-download entitlement contracts, and the');
  console.log('            shared `entitlements` collection namespace.');

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('══════════════════════════════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
})();
