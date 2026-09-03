#!/usr/bin/env node
/* POS Till QR — PAID-transition certification (Q7), pure core.
 *
 * No Firestore, no network, no deployment, no emulator — certifies
 * functions/payment-attribution.js's decidePaidTransition directly, same
 * methodology as Q5 (scripts/test-sokoni-qr-payment.js) and Q6
 * (scripts/test-webhook-attribution.js). The webhookIntasend call site is a
 * thin read-decide-write wrapper around this decision.
 *
 * IT CARRIES ITS OWN CONTROLS:
 *   - a NEGATIVE control that must itself fail
 *   - a SABOTAGE control: the amount-equality check is loosened in a
 *     temporary weakened copy, and the same "wrong amount" case the real
 *     code correctly refuses is proven to be wrongly accepted there.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const A = require('../functions/payment-attribution');

let pass = 0, fail = 0;

function ok(label, cond, note) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
}

console.log('');
console.log('  POS TILL QR — PAID-transition (Q7) — pure core certification');
console.log('');

/* ── 1. Valid, matching-amount Till sale → mark_paid ───────────────────── */
console.log('  -- valid verified payment -> correct sale becomes PAID --');
{
  const intent = { status: 'created', amount: 500, purpose: 'pos_till_sale' };
  const r = A.decidePaidTransition({ intent, confirmedAmount: 500, isTillSale: true });
  ok('matching amount, non-terminal intent, Till sale -> mark_paid', r.action === 'mark_paid');
}

/* ── 2. Same webhook replay -> no second effect (already-paid = noop) ──── */
console.log('  -- same webhook replay / already-PAID sale -> idempotent noop --');
{
  const paidIntent = { status: 'paid', amount: 500 };
  const r1 = A.decidePaidTransition({ intent: paidIntent, confirmedAmount: 500, isTillSale: true });
  ok('already status:paid -> noop (not re-marked)', r1.action === 'noop');
  const r2 = A.decidePaidTransition({ intent: paidIntent, confirmedAmount: 500, isTillSale: true });
  ok('repeated call with the same already-paid intent -> still noop', r2.action === 'noop');
}

/* ── 3. Wrong intent -> can't be marked paid (no intent at all) ─────────── */
console.log('  -- wrong/missing intent -> cannot be marked paid --');
{
  const r = A.decidePaidTransition({ intent: null, confirmedAmount: 500, isTillSale: true });
  ok('no intent found -> noop, never mark_paid', r.action === 'noop');
}

/* ── 4. Wrong merchant/Till -> denied (gated entirely by isTillSale) ────── */
console.log('  -- wrong merchant/Till -> denied (isTillSale gate) --');
{
  const intent = { status: 'created', amount: 500, purpose: 'product_order' };
  const r = A.decidePaidTransition({ intent, confirmedAmount: 500, isTillSale: false });
  ok('isTillSale:false (not a verified Till sale) -> noop regardless of amount match', r.action === 'noop');
}

/* ── 5. Wrong amount -> sale remains pending (flag_mismatch, not paid) ──── */
console.log('  -- wrong amount -> sale remains pending --');
{
  const intent = { status: 'created', amount: 500 };
  ok('confirmed LESS than intent amount -> flag_mismatch, never mark_paid',
    A.decidePaidTransition({ intent, confirmedAmount: 400, isTillSale: true }).action === 'flag_mismatch');
  ok('confirmed MORE than intent amount -> flag_mismatch, never mark_paid',
    A.decidePaidTransition({ intent, confirmedAmount: 600, isTillSale: true }).action === 'flag_mismatch');
  ok('confirmed off by just 1 KES -> flag_mismatch (exact match required)',
    A.decidePaidTransition({ intent, confirmedAmount: 501, isTillSale: true }).action === 'flag_mismatch');
  ok('non-numeric confirmed amount -> flag_mismatch, not a crash',
    A.decidePaidTransition({ intent, confirmedAmount: 'not-a-number', isTillSale: true }).action === 'flag_mismatch');
  ok('intent with a non-numeric amount -> flag_mismatch, not a crash',
    A.decidePaidTransition({ intent: { status: 'created', amount: 'oops' }, confirmedAmount: 500, isTillSale: true }).action === 'flag_mismatch');
}

/* ── 6. Expired/terminal intent -> no new PAID transition ───────────────── */
console.log('  -- expired/terminal intent -> no new PAID transition --');
{
  for (const status of ['expired', 'cancelled', 'paid']) {
    const intent = { status, amount: 500 };
    const r = A.decidePaidTransition({ intent, confirmedAmount: 500, isTillSale: true });
    ok(`terminal status "${status}" (even with a matching amount) -> noop, not mark_paid`, r.action === 'noop');
  }
  // A terminal intent with a MISMATCHED amount must also stay noop, not flag_mismatch —
  // terminal takes priority; there is nothing left to "flag" for an already-closed intent.
  const terminalMismatch = A.decidePaidTransition({ intent: { status: 'expired', amount: 500 }, confirmedAmount: 999, isTillSale: true });
  ok('terminal status wins over an amount mismatch -> noop, not flag_mismatch', terminalMismatch.action === 'noop');
}

/* ── 7. Unrelated payment -> no POS mutation (purity / independence) ────── */
console.log('  -- unrelated payment -> no cross-contamination (purity) --');
{
  const intentA = { status: 'created', amount: 100 };
  const intentB = { status: 'created', amount: 200 };
  const rA = A.decidePaidTransition({ intent: intentA, confirmedAmount: 100, isTillSale: true });
  const rB = A.decidePaidTransition({ intent: intentB, confirmedAmount: 999, isTillSale: true }); // wrong amount for B
  ok('two independent decisions do not affect each other', rA.action === 'mark_paid' && rB.action === 'flag_mismatch');
  // Mutating the returned object of one call must not affect a later call with a fresh object.
  rA.action = 'MUTATED';
  const rA2 = A.decidePaidTransition({ intent: intentA, confirmedAmount: 100, isTillSale: true });
  ok('mutating a prior result does not leak into a subsequent identical call', rA2.action === 'mark_paid');
}

/* ── NEGATIVE CONTROL ───────────────────────────────────────────────────── */
console.log('  -- negative control (must fail; proves the harness can detect failure) --');
{
  const before = fail;
  ok('deliberately false assertion', 1 === 2);
  ok('control recorded exactly one failure', fail === before + 1);
  fail--;
}

/* ── SABOTAGE CONTROL ───────────────────────────────────────────────────── */
console.log('  -- sabotage control (amount-equality loosening must be CAUGHT failing) --');
{
  const realSrc = fs.readFileSync(path.join(__dirname, '..', 'functions', 'payment-attribution.js'), 'utf8');

  const sabotagedSrc = realSrc.replace(
    'if (!Number.isFinite(expected) || !Number.isFinite(confirmed) || expected !== confirmed) {',
    'if (false) { // SABOTAGED: amount check disabled'
  );
  if (sabotagedSrc === realSrc) {
    throw new Error('SABOTAGE CONTROL SETUP FAILED — the amount-equality line to weaken was not found; ' +
      'the control cannot prove anything and the run must be blocked.');
  }

  const tmpFile = path.join(os.tmpdir(), `payment-attribution.sabotaged2.${process.pid}.js`);
  fs.writeFileSync(tmpFile, sabotagedSrc);
  let sabotaged;
  try {
    sabotaged = require(tmpFile);

    const intent = { status: 'created', amount: 500 };
    const sabotagedResult = sabotaged.decidePaidTransition({ intent, confirmedAmount: 1, isTillSale: true });
    ok('SABOTAGE: weakened code WRONGLY marks a grossly mismatched amount as paid',
      sabotagedResult.action === 'mark_paid');

    const realResult = A.decidePaidTransition({ intent, confirmedAmount: 1, isTillSale: true });
    ok('control: the REAL (unmodified) module still refuses the same mismatched amount',
      realResult.action === 'flag_mismatch');
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) { /* best-effort cleanup */ }
  }
}

/* ── Summary ────────────────────────────────────────────────────────────── */
console.log('');
console.log(`  ${pass} passed, ${fail} failed`);
console.log('');

if (fail > 0) {
  console.log('  BLOCKED — see FAIL lines above.');
  process.exit(1);
} else {
  console.log('  CERTIFIED — Q7 pure core (decidePaidTransition, functions/payment-attribution.js).');
  process.exit(0);
}
