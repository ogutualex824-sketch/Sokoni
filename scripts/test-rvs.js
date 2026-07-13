#!/usr/bin/env node
/**
 * test-rvs.js — Release Validation Standard v1.0. CI-blocking.
 *
 * A standard everybody agrees with and nobody is stopped by is decoration. This is the
 * thing that stops you.
 *
 * It enforces, mechanically:
 *
 *   1. A gate marked VERIFIED must carry EVIDENCE. No evidence → not a pass.
 *   2. A gate cannot jump NOT_EXERCISED → VERIFIED without execution.
 *   3. The verdict must MATCH the gates. You cannot write GO over a register that says
 *      otherwise — which is precisely how a platform gets shipped on a green report that
 *      was never true.
 *   4. Nothing anywhere may claim "production ready" while a critical gate is unproven.
 *
 * Why this is not theoretical: this platform reported push as "sent successfully" while
 * delivering to ZERO devices for months, and measured a form as "0px overflow" while it
 * was falling off the user's screen. Both times a REQUEST was measured and an OUTCOME was
 * reported. That is the failure the RVS exists to make unwritable.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  pass  ' + m); };
const bad = m => { fail++; console.error('  FAIL  ' + m); };

const ROOT = process.cwd();
const REG  = path.join(ROOT, 'release-gates.json');

console.log('\nRelease Validation Standard v1.0\n');

if (!fs.existsSync(REG)) {
  bad('release-gates.json is missing — there is no register, so there is no release state');
  process.exit(1);
}

let reg;
try { reg = JSON.parse(fs.readFileSync(REG, 'utf8')); }
catch (e) { bad('release-gates.json is not valid JSON: ' + e.message); process.exit(1); }

const STATES = ['not_exercised', 'engineering_complete', 'verified', 'failed'];
const gates  = reg.gates || [];

/* ── 1. Every gate is exactly one of the four states ──────────────────────── */
{
  const wrong = gates.filter(g => !STATES.includes(g.state))
                     .map(g => `${g.id}=${g.state}`);
  wrong.length === 0
    ? ok(`all ${gates.length} gates carry one of the four RVS states`)
    : bad('gates with an invalid state: ' + wrong.join(', '));
}

/* ── 2. VERIFIED requires EVIDENCE. This is the whole standard. ───────────── */
{
  const REQUIRED = ['timestamp', 'traceId', 'operator', 'environment'];
  const liars = [];

  for (const g of gates) {
    if (g.state !== 'verified') continue;
    const ev = g.evidence;
    if (!ev || typeof ev !== 'object') {
      liars.push(`${g.id}: marked VERIFIED with NO evidence block`);
      continue;
    }
    const missing = REQUIRED.filter(k => !ev[k]);
    if (missing.length) liars.push(`${g.id}: VERIFIED but evidence lacks ${missing.join(', ')}`);
  }

  liars.length === 0
    ? ok('no gate is marked VERIFIED without evidence (timestamp · traceId · operator · environment)')
    : bad('a gate claims VERIFIED without evidence — that is the exact failure this standard exists to prevent:\n        ' +
          liars.join('\n        '));
}

/* ── 3. FAILED requires a root cause AND a regression test ────────────────── */
{
  const sloppy = gates.filter(g => g.state === 'failed' && (!g.rootCause || !g.regressionTest))
                      .map(g => g.id);
  sloppy.length === 0
    ? ok('every FAILED gate documents a root cause and names a regression test')
    : bad('FAILED gate(s) without a root cause / regression test: ' + sloppy.join(', ') +
          ' — a failure you do not write a test for is a failure you will have again');
}

/* ── 4. The verdict must match the register ───────────────────────────────── */
{
  const critical  = gates.filter(g => g.critical);
  const verified  = critical.filter(g => g.state === 'verified');
  const blocked   = critical.filter(g => g.state === 'failed' || g.state === 'not_exercised');
  const pending   = critical.filter(g => g.state === 'engineering_complete');

  const shouldBeGo = critical.length > 0 && verified.length === critical.length;
  const declared   = String(reg.verdict || '').toUpperCase();

  if (shouldBeGo && declared !== 'GO') {
    ok('every critical gate is VERIFIED, and the register still says NO_GO — conservative, allowed');
  } else if (!shouldBeGo && declared === 'GO') {
    bad(`verdict says GO but ${blocked.length} critical gate(s) are FAILED/NOT_EXERCISED and ` +
        `${pending.length} are only ENGINEERING COMPLETE. Engineering Complete is not Production Proven.`);
  } else {
    ok(`verdict (${declared}) matches the register: ${verified.length}/${critical.length} critical gates VERIFIED`);
  }

  console.log(`        ⚪ ${gates.filter(g=>g.state==='not_exercised').length}` +
              `  🟡 ${gates.filter(g=>g.state==='engineering_complete').length}` +
              `  🟢 ${gates.filter(g=>g.state==='verified').length}` +
              `  🔴 ${gates.filter(g=>g.state==='failed').length}`);
}

/* ── 5. Nothing may declare production-readiness while a gate is unproven ─── */
{
  const critical   = gates.filter(g => g.critical);
  const allVerified = critical.length > 0 && critical.every(g => g.state === 'verified');

  if (allVerified) {
    ok('all critical gates VERIFIED — a production-ready claim would be legitimate');
  } else {
    /* Scan the docs that a stakeholder actually reads. */
    const DOCS = ['docs/GO_NO_GO.md', 'docs/RELEASE_VALIDATION_STANDARD.md',
                  'docs/PRODUCTION_ACCEPTANCE_REPORT.md', 'README.md'];
    const claims = [];
    for (const d of DOCS) {
      const f = path.join(ROOT, d);
      if (!fs.existsSync(f)) continue;
      const src = fs.readFileSync(f, 'utf8');
      /* A claim only counts if it is NOT negated on the same line. */
      /* An ASSERTION that the platform IS ready — not an aspiration that code SHOULD be.
         "Every feature must be production ready" is a development standard and entirely
         correct. "SOKONI is production ready" is a claim, and it needs evidence.
         The first version of this check conflated the two and failed on the standard
         itself, which would have taught everyone to ignore it. */
      const ASSERTS = /\b(sokoni|the platform|this release|v?\d+\.\d+)\b[^.\n]{0,40}\b(is|are)\b[^.\n]{0,20}(production[- ]ready|ready for (public|production|launch))/i;
      const VERDICT = /^\s*[>*#-]*\s*(✅|🟢)?\s*\**GO\**\s*$/;

      src.split('\n').forEach((line, i) => {
        const isClaim = ASSERTS.test(line) || VERDICT.test(line);
        if (!isClaim) return;
        if (/not|never|cannot|no[- ]?go|⛔|🔴|until|unverified|would be/i.test(line)) return;
        claims.push(`${d}:${i + 1}  ${line.trim().slice(0, 80)}`);
      });
    }
    claims.length === 0
      ? ok('no document claims production-readiness while critical gates are unproven')
      : bad('a document claims production-readiness while critical gates are NOT verified:\n        ' +
            claims.join('\n        '));
  }
}

/* ── 6. The money path is tracked step by step ────────────────────────────── */
{
  const pay = gates.find(g => g.id === 'payments');
  const STEPS = ['customer_paid', 'provider_confirms', 'order_created', 'inventory_updated',
                 'ledger_updated', 'commission_correct', 'settlement_correct',
                 'customer_notified', 'merchant_notified', 'refund_path', 'dispute_path'];

  if (!pay || !pay.moneyPath) {
    bad('the payments gate does not break the money path into steps — a single green tick over eleven unproven steps is not evidence');
  } else {
    const missing = STEPS.filter(s => !(s in pay.moneyPath));
    missing.length === 0
      ? ok(`the money path is tracked as ${STEPS.length} separate steps, each needing its own evidence`)
      : bad('money-path steps missing from the register: ' + missing.join(', '));

    const claimed = STEPS.filter(s => pay.moneyPath[s] === 'verified');
    (claimed.length === 0 || pay.evidence)
      ? ok('no money-path step claims VERIFIED without evidence on the gate')
      : bad('money-path step(s) claim VERIFIED but the payments gate carries no evidence: ' + claimed.join(', '));
  }
}

/* ── 7. Notifications and email must validate OUTCOMES, not requests ──────── */
{
  const n = gates.find(g => g.id === 'notifications');
  const e = gates.find(g => g.id === 'email');

  (n && Array.isArray(n.mustValidate) && n.mustValidate.includes('delivered'))
    ? ok('notifications must validate DELIVERED (not queued) — the bug that hid for months')
    : bad('the notifications gate does not require DELIVERED — queued would be accepted as success again');

  (e && Array.isArray(e.mustValidate) && e.mustValidate.includes('delivered'))
    ? ok('email must validate DELIVERED (not 202 Accepted)')
    : bad('the email gate does not require DELIVERED — a 202 would be accepted as success');
}

/* ── 8. Roles are validated separately ────────────────────────────────────── */
{
  const a = gates.find(g => g.id === 'auth');
  const ROLES = ['buyer', 'merchant', 'provider', 'driver', 'employer', 'administrator'];

  (a && Array.isArray(a.roles) && ROLES.every(r => a.roles.includes(r)))
    ? ok('all six roles are tracked separately (one role never proves another)')
    : bad('roles are not tracked separately on the auth gate');

  if (a && a.state === 'verified') {
    const unproven = ROLES.filter(r => !(a.rolesVerified || []).includes(r));
    unproven.length === 0
      ? ok('auth is VERIFIED and every role was exercised')
      : bad('auth is marked VERIFIED but these roles were never exercised: ' + unproven.join(', '));
  } else {
    ok('auth is not yet VERIFIED — per-role evidence not yet required');
  }
}

console.log('');
if (fail) {
  console.error(`RVS FAILED (${fail}) — the release state is not defensible\n`);
  process.exit(1);
}
console.log(`RVS PASSED (${pass} checks) — the register is honest\n`);
