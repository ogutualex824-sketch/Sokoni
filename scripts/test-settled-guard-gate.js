'use strict';
/**
 * CERTIFICATION of the predeploy gate scripts/deploy/guard-settled-case.js.
 *
 * A gate is only as good as what it REFUSES. Every mutant below is a way a future edit, a stale
 * branch or a recovery rebuild could disconnect the double-credit guard while leaving the word
 * `isAlreadySettled` in the file. Each must make the gate FAIL — and fail on the check that is
 * supposed to catch it, so a mutant that fails for an unrelated reason does not count.
 *
 * Mutants are compiled from TEXT and resolved as if they were functions/order-settlement.js, so
 * no temporary file is ever written into functions/ (which a deploy would ship).
 *
 * Optional external targets (reported SKIPPED, never PASS, when absent):
 *   SETTLED_GUARD_PROD_TREE    a production-lineage order-settlement.js that must PASS
 *   SETTLED_GUARD_UNPATCHED    the known-vulnerable source (resolved as PROD_TREE) that must FAIL
 */
const fs = require('fs');
const path = require('path');
const { runGate } = require('./deploy/guard-settled-case');

const TARGET = path.resolve(__dirname, '..', 'functions', 'order-settlement.js');
const SRC = fs.readFileSync(TARGET, 'utf8');
let pass = 0, fail = 0, skip = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };

/* Exact-once text surgery: a mutant whose anchor no longer matches is a broken TEST, not a pass. */
function mutate(name, edits) {
  let s = SRC;
  for (const [a, b] of edits) {
    const n = s.split(a).length - 1;
    if (n !== 1) throw new Error(`mutant "${name}": anchor matched ${n} times: ${a.slice(0, 60)}`);
    s = s.replace(a, b);
  }
  return s;
}
const SETTLE_GUARD = "    if (isAlreadySettled(st))   return { outcome: 'already-settled' };";
const SWEEP_GUARD  = '    if (isAlreadySettled(o.settlementStatus) || o.settlementStatus === STATES.REFUNDED) continue;';
const HELPER_BODY  = "  return typeof status === 'string' && status.trim().toUpperCase() === STATES.SETTLED;";

const MUTANTS = [
  { name: 'settleOrder reverted to the case-sensitive check (helper still defined + exported)',
    src: () => mutate('m1', [[SETTLE_GUARD, "    if (st === STATES.SETTLED)  return { outcome: 'already-settled' };"]]),
    expect: ['S5', 'S6', 'B3'] },
  /* Repair 1 (dispute hold) made the sweep complete each order in its own transaction, which
     re-checks isAlreadySettled on the fresh snapshot. Reverting only the pre-filter is therefore no
     longer behaviourally observable — the gate still refuses it STRUCTURALLY (S7, S8). m2b reverts
     BOTH guards and must fail behaviourally, so behavioural coverage of the sweep is kept. */
  { name: 'sweep pre-filter reverted to the case-sensitive check (in-transaction guard still present)',
    src: () => mutate('m2', [[SWEEP_GUARD, '    if (o.settlementStatus === STATES.SETTLED || o.settlementStatus === STATES.REFUNDED) continue;']]),
    expect: ['S7', 'S8'] },
  { name: 'sweep: BOTH guards reverted to the case-sensitive check',
    src: () => mutate('m2b', [
      [SWEEP_GUARD, '    if (o.settlementStatus === STATES.SETTLED || o.settlementStatus === STATES.REFUNDED) continue;'],
      ['        if (isAlreadySettled(cur.settlementStatus) || cur.settlementStatus === STATES.REFUNDED) return false;',
       '        if (cur.settlementStatus === STATES.SETTLED || cur.settlementStatus === STATES.REFUNDED) return false;']]),
    expect: ['S7', 'S8', 'B4'] },
  { name: 'guard called but its result ignored in settleOrder',
    src: () => mutate('m3', [[SETTLE_GUARD, "    isAlreadySettled(st);"]]),
    expect: ['S5', 'B3'] },
  { name: 'guard neutralised inside the condition (`&& false`)',
    src: () => mutate('m4', [[SETTLE_GUARD, "    if (isAlreadySettled(st) && false)   return { outcome: 'already-settled' };"]]),
    expect: ['S5', 'B3'] },
  { name: 'helper made case-sensitive again (call sites intact)',
    src: () => mutate('m5', [[HELPER_BODY, '  return status === STATES.SETTLED;']]),
    expect: ['B1', 'B3', 'B4'] },
  { name: 'helper always false (defined, exported, called — and useless)',
    src: () => mutate('m6', [[HELPER_BODY, '  return false;']]),
    expect: ['B1', 'B3', 'B4'] },
  { name: 'export removed',
    src: () => mutate('m7', [['module.exports = { STATES, isAlreadySettled, ', 'module.exports = { STATES, ']]),
    expect: ['S2', 'B0'] },
  { name: 'second raw decision added after the guard (bypass beside the guard)',
    src: () => mutate('m8', [[SETTLE_GUARD, SETTLE_GUARD + "\n    if (o.settlementStatus !== 'SETTLED') { /* divergent decision */ }"]]),
    expect: ['S6'] },
  { name: 'helper deleted entirely (call sites left dangling)',
    src: () => mutate('m9', [[HELPER_BODY, "  throw new Error('removed');"]]),
    expect: ['B1'] },
];

(async () => {
  console.log('\n[1] the patched source in this tree PASSES');
  const base = await runGate({ filename: TARGET, sourceText: SRC });
  ok(base.ok, `gate passes on ${path.relative(process.cwd(), TARGET)} (${base.checks.filter((c) => c.ok).length}/${base.checks.length})`);
  base.checks.filter((c) => !c.ok).forEach((c) => console.log('       unexpected:', c.id, c.msg));

  console.log('\n[2] every disconnecting mutant is REFUSED, on the check meant to catch it');
  for (const m of MUTANTS) {
    let r;
    try { r = await runGate({ filename: TARGET, sourceText: m.src() }); }
    catch (e) { ok(false, `${m.name}: gate crashed instead of refusing (${e.message})`); continue; }
    const failed = r.checks.filter((c) => !c.ok).map((c) => c.id);
    const missing = m.expect.filter((id) => !failed.includes(id));
    ok(!r.ok && !missing.length, `${m.name} -> REFUSED [${failed.join(',')}]` + (missing.length ? ` — expected ${missing.join(',')} to fail too` : ''));
  }

  console.log('\n[3] fails closed when it cannot look');
  const gone = await runGate({ filename: path.join(path.dirname(TARGET), '__does_not_exist__.js') });
  ok(!gone.ok && gone.checks.some((c) => c.id === 'F0' && !c.ok), 'missing order-settlement.js -> REFUSED [F0]');
  const garbage = await runGate({ filename: TARGET, sourceText: 'function (' });
  ok(!garbage.ok, 'unparseable source -> REFUSED');

  console.log('\n[4] external lineages');
  const prod = process.env.SETTLED_GUARD_PROD_TREE, unp = process.env.SETTLED_GUARD_UNPATCHED;
  if (prod && fs.existsSync(prod)) {
    const r = await runGate({ filename: prod });
    ok(r.ok, `CURRENT PRODUCTION SOURCE passes (${prod})`);
    r.checks.filter((c) => !c.ok).forEach((c) => console.log('       unexpected:', c.id, c.msg));
    if (unp && fs.existsSync(unp)) {
      const u = await runGate({ filename: prod, sourceText: fs.readFileSync(unp, 'utf8') });
      const failed = u.checks.filter((c) => !c.ok).map((c) => c.id);
      ok(!u.ok && ['S1', 'S5', 'S7', 'B3', 'B4'].every((id) => failed.includes(id)),
        `KNOWN-VULNERABLE production source is REFUSED [${failed.join(',')}]`);
    } else { skip++; console.log('  SKIPPED unpatched-source control (SETTLED_GUARD_UNPATCHED not set)'); }
  } else { skip++; console.log('  SKIPPED production-lineage controls (SETTLED_GUARD_PROD_TREE not set)'); }

  console.log(`\n${pass} pass / ${fail} fail / ${skip} skipped`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH (not a verdict):', e && e.stack || e); process.exit(3); });
