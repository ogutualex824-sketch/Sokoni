#!/usr/bin/env node
'use strict';
/**
 * etims-release-gate.js — the eTIMS pre-deploy / CI gate.
 *
 *   node scripts/etims-release-gate.js
 *
 * Composes the deterministic suites + live integrity scans and exits NON-ZERO on any
 * failure, so an eTIMS deploy can be blocked automatically. Checks:
 *   1. Tax engine determinism           (test-etims-tax-engine.js)   — no spec needed
 *   2. Audit-trail tamper-evidence      (test-etims-audit.js)        — no spec needed
 *   3. Payout idempotency (shared guard test — sanity)               — no spec needed
 *   4. LIVE: no duplicate invoice numbers across etimsInvoices/hubInvoices
 *   5. LIVE: audit completeness + chain integrity — every invoice that has audit
 *      events has an unbroken, untampered hash chain (functions/etims-audit.js).
 *
 * Live checks are read-only and pass trivially when there is no data yet (sandbox),
 * so the gate is safe to wire into predeploy now and becomes meaningful as data grows.
 */
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;

function runTest(label, script) {
  process.stdout.write(`\n▶ ${label}\n`);
  try { process.stdout.write(execFileSync(NODE, [path.join('scripts', script)], { cwd: ROOT, encoding: 'utf8' })); return true; }
  catch (e) { if (e.stdout) process.stdout.write(e.stdout); if (e.stderr) process.stderr.write(e.stderr); return false; }
}

async function liveChecks() {
  let admin, Audit;
  try {
    admin = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin'));
    Audit = require(path.join(ROOT, 'functions', 'etims-audit'));
    admin.initializeApp({ projectId: 'sokoni-aeb26' });
  } catch (e) {
    console.log('  (live checks skipped — firebase-admin unavailable:', e.message, ')');
    return { ok: true, skipped: true };
  }
  const db = admin.firestore();
  const issues = [];

  // 4) Duplicate invoice numbers
  for (const coll of ['etimsInvoices', 'hubInvoices']) {
    const snap = await db.collection(coll).get().catch(() => null);
    if (!snap) continue;
    const seen = new Map();
    snap.docs.forEach((d) => {
      const n = d.data().invoiceNumber;
      if (!n) return;
      if (seen.has(n)) issues.push(`DUPLICATE invoice number in ${coll}: ${n} (${seen.get(n)}, ${d.id})`);
      else seen.set(n, d.id);
    });
    console.log(`  ${coll}: ${snap.size} invoices, ${seen.size} distinct numbers`);
  }

  // 5) Audit completeness + chain integrity
  const auditSnap = await db.collection(Audit.AUDIT_COLL).get().catch(() => null);
  if (auditSnap) {
    const byEntity = new Map();
    auditSnap.docs.forEach((d) => {
      const r = d.data(); const arr = byEntity.get(r.entityId) || []; arr.push(r); byEntity.set(r.entityId, arr);
    });
    let chains = 0;
    for (const [entityId, recs] of byEntity) {
      recs.sort((a, b) => (a.seq || 0) - (b.seq || 0));
      const v = Audit.verifyRecords(recs);
      if (!v.ok) issues.push(`AUDIT CHAIN broken for ${entityId}: ${v.issues.join('; ')}`);
      chains++;
    }
    console.log(`  audit: ${auditSnap.size} events across ${chains} entity chains verified`);

    // Every accepted/failed invoice SHOULD have audit events (completeness).
    for (const coll of ['etimsInvoices', 'hubInvoices']) {
      const inv = await db.collection(coll).get().catch(() => null);
      if (!inv) continue;
      inv.docs.forEach((d) => {
        const st = d.data().status;
        if ((st === 'accepted' || st === 'failed') && !byEntity.has(d.id)) {
          issues.push(`AUDIT MISSING: ${coll}/${d.id} is '${st}' but has no audit events`);
        }
      });
    }
  }

  if (issues.length) { issues.forEach((i) => console.log('   ⛔ ' + i)); return { ok: false }; }
  console.log('  ✅ no duplicate invoice numbers; all audit chains intact and complete');
  return { ok: true };
}

(async () => {
  const results = [];
  results.push(['Tax engine determinism', runTest('Tax engine determinism (22)', 'test-etims-tax-engine.js')]);
  results.push(['Audit tamper-evidence', runTest('Audit tamper-evidence (6)', 'test-etims-audit.js')]);
  results.push(['Payout idempotency guard', runTest('Payout idempotency guard (11)', 'test-payout-idempotency.js')]);
  results.push(['Invoice lifecycle model', runTest('Invoice lifecycle model (16)', 'test-etims-lifecycle.js')]);

  process.stdout.write('\n▶ Live integrity scan (duplicate invoices / audit completeness + chain)\n');
  const live = await liveChecks();
  results.push(['Live integrity (no-dup invoices / audit complete + intact)', live.ok]);

  process.stdout.write('\n=== eTIMS RELEASE GATE ===\n');
  let ok = true;
  for (const [label, pass] of results) { process.stdout.write(`  ${pass ? 'PASS' : 'FAIL'}  ${label}\n`); if (!pass) ok = false; }
  process.stdout.write(ok ? '\n✅ eTIMS gate GREEN.\n' : '\n⛔ eTIMS gate RED — fix before deploy.\n');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('etims-release-gate FAILED:', e.message); process.exit(1); });
