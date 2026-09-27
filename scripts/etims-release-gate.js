#!/usr/bin/env node
'use strict';
/**
 * etims-release-gate.js — the eTIMS pre-deploy / CI gate.
 *
 *   node scripts/etims-release-gate.js                                   fixture mode (default, offline)
 *   node scripts/etims-release-gate.js --live --project=<id> --env=<sandbox|production>
 *
 * Composes the deterministic suites + an integrity scan and exits NON-ZERO on any failure:
 *   1. Tax engine determinism           (test-etims-tax-engine.js)
 *   2. Audit-trail tamper-evidence      (test-etims-audit.js)
 *   3. Payout idempotency (shared guard test — sanity)
 *   4. Invoice lifecycle model          (test-etims-lifecycle.js)
 *   5. Integrity scan: no duplicate invoice numbers across etimsInvoices/hubInvoices; audit
 *      completeness + hash-chain integrity (functions/etims-audit.js).
 *
 * DEFAULT = FIXTURE. The ordinary run never loads firebase-admin and never touches a network or
 * project: the scan runs over in-repo fixture data, and FIRST proves the detector can see — a planted
 * duplicate, a tampered chain, a missing audit trail and an unreadable collection must each be
 * reported (positive controls). A clean fixture is VALIDATED only after those controls fire.
 *
 * LIVE is explicit (gap 17, 2026-09-27: the old gate silently initialised firebase-admin against the
 * production project on every run and reported "0 records" as PASS). It requires --project and
 * --env, prints PROJECT / ENVIRONMENT / MODE, and reads through a READ-ONLY handle (collection().get()
 * only — any write throws). Outcomes are distinguished, never collapsed:
 *   VALIDATED    records present and every assertion held            → PASS
 *   NO_DATA      zero records — nothing was validated                → NOT PASS (exit 2)
 *   VIOLATIONS   duplicates / broken or missing audit                → FAIL
 *   UNREADABLE   a collection could not be read                      → FAIL (fail closed)
 */
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const Audit = require(path.join(ROOT, 'functions', 'etims-audit'));

const INVOICE_COLLS = ['etimsInvoices', 'hubInvoices'];

function parseArgs(argv) {
  const get = (k) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
  if (!argv.includes('--live')) return { mode: 'fixture' };
  const project = get('project'), env = get('env');
  if (!project || !/^[a-z][a-z0-9-]{4,29}$/.test(project)) return { error: '--live requires --project=<firebase project id>' };
  if (env !== 'sandbox' && env !== 'production') return { error: '--live requires --env=sandbox|production' };
  return { mode: 'live', project, env };
}

/** A READ-ONLY view of a Firestore handle: collection(name).get() and nothing else. */
function readOnly(db) {
  const deny = (op) => () => { throw new Error(`etims-release-gate is read-only: ${op} refused`); };
  return {
    collection: (name) => {
      const c = db.collection(name);
      return { get: () => c.get(), add: deny('add'), doc: deny('doc'), set: deny('set'), update: deny('update'), delete: deny('delete') };
    },
    batch: deny('batch'), runTransaction: deny('runTransaction'), doc: deny('doc'),
  };
}

/** The integrity scan over any { collection(name).get() } source. Pure: returns a verdict. */
async function scanIntegrity(db) {
  const issues = [], counts = {};
  const read = async (coll) => { try { return await db.collection(coll).get(); } catch (e) { return { error: String(e && e.message || e) }; } };
  const unreadable = [];
  const invoices = {};
  for (const coll of INVOICE_COLLS) {
    const snap = await read(coll);
    if (snap.error) { unreadable.push(`${coll}: ${snap.error}`); continue; }
    invoices[coll] = snap.docs;
    const seen = new Map();
    snap.docs.forEach((d) => {
      const n = d.data().invoiceNumber;
      if (!n) return;
      if (seen.has(n)) issues.push(`DUPLICATE invoice number in ${coll}: ${n} (${seen.get(n)}, ${d.id})`);
      else seen.set(n, d.id);
    });
    counts[coll] = snap.docs.length;
  }
  const auditSnap = await read(Audit.AUDIT_COLL);
  if (auditSnap.error) unreadable.push(`${Audit.AUDIT_COLL}: ${auditSnap.error}`);
  else {
    counts[Audit.AUDIT_COLL] = auditSnap.docs.length;
    const byEntity = new Map();
    auditSnap.docs.forEach((d) => { const r = d.data(); const arr = byEntity.get(r.entityId) || []; arr.push(r); byEntity.set(r.entityId, arr); });
    for (const [entityId, recs] of byEntity) {
      recs.sort((a, b) => (a.seq || 0) - (b.seq || 0));
      const v = Audit.verifyRecords(recs);
      if (!v.ok) issues.push(`AUDIT CHAIN broken for ${entityId}: ${v.issues.join('; ')}`);
    }
    for (const [coll, docs] of Object.entries(invoices)) {
      docs.forEach((d) => {
        const st = d.data().status;
        if ((st === 'accepted' || st === 'failed') && !byEntity.has(d.id)) issues.push(`AUDIT MISSING: ${coll}/${d.id} is '${st}' but has no audit events`);
      });
    }
  }
  if (unreadable.length) return { state: 'UNREADABLE', counts, issues: unreadable };
  if (issues.length) return { state: 'VIOLATIONS', counts, issues };
  const records = Object.values(counts).reduce((a, b) => a + b, 0);
  return { state: records === 0 ? 'NO_DATA' : 'VALIDATED', counts, issues: [] };
}

/* ── fixtures (in-repo, offline) ── */
function memDb(colls, { failOn } = {}) {
  return { collection: (name) => ({ get: async () => {
    if (name === failOn) throw new Error('PERMISSION_DENIED (fixture)');
    const docs = (colls[name] || []).map(([id, data]) => ({ id, data: () => data }));
    return { docs, size: docs.length };
  } }) };
}
function chain(entityId, events) {
  let prev = Audit.GENESIS;
  return events.map((e, i) => {
    const core = Audit.coreOf({ entityType: 'invoice', entityId, event: e, prevStatus: null, newStatus: e, actor: 'system', sellerUid: 'S1', hubId: null, seq: i, at: `2026-09-27T10:0${i}:00Z`, detail: null });
    const hash = Audit.chainHash(prev, core); const rec = { ...core, prevHash: prev, hash, immutable: true }; prev = hash; return rec;
  });
}
function fixtures() {
  const audit = [...chain('INV-A', ['created', 'queued', 'accepted']), ...chain('INV-B', ['created', 'failed'])];
  const clean = {
    etimsInvoices: [['INV-A', { invoiceNumber: 'KEV-0001', status: 'accepted' }], ['INV-B', { invoiceNumber: 'KEV-0002', status: 'failed' }], ['INV-C', { invoiceNumber: 'KEV-0003', status: 'pending_submission' }]],
    hubInvoices: [['HUB-1', { invoiceNumber: 'HUB-0001', status: 'pending_submission' }]],
    [Audit.AUDIT_COLL]: audit.map((r, i) => [`a${i}`, r]),
  };
  const dup = { ...clean, etimsInvoices: [...clean.etimsInvoices, ['INV-D', { invoiceNumber: 'KEV-0001', status: 'pending_submission' }]] };
  const tampered = { ...clean, [Audit.AUDIT_COLL]: clean[Audit.AUDIT_COLL].map(([id, r]) => [id, r.entityId === 'INV-A' && r.seq === 1 ? { ...r, newStatus: 'accepted' } : r]) };
  const missing = { ...clean, [Audit.AUDIT_COLL]: clean[Audit.AUDIT_COLL].filter(([, r]) => r.entityId !== 'INV-B') };
  return { clean, dup, tampered, missing };
}

async function fixtureScan() {
  const F = fixtures();
  const controls = [
    ['planted duplicate invoice number is reported', await scanIntegrity(memDb(F.dup)), (r) => r.state === 'VIOLATIONS' && r.issues.some((i) => /DUPLICATE/.test(i))],
    ['tampered audit record is reported', await scanIntegrity(memDb(F.tampered)), (r) => r.state === 'VIOLATIONS' && r.issues.some((i) => /hash mismatch/.test(i))],
    ['accepted/failed invoice without audit is reported', await scanIntegrity(memDb(F.missing)), (r) => r.state === 'VIOLATIONS' && r.issues.some((i) => /AUDIT MISSING/.test(i))],
    ['an unreadable collection fails closed', await scanIntegrity(memDb(F.clean, { failOn: 'hubInvoices' })), (r) => r.state === 'UNREADABLE'],
    ['zero records is NO_DATA, not a pass', await scanIntegrity(memDb({})), (r) => r.state === 'NO_DATA'],
  ];
  let controlsOk = true;
  for (const [label, r, want] of controls) { const ok = want(r); controlsOk = controlsOk && ok; console.log(`  ${ok ? 'PASS' : 'FAIL'}  control: ${label}   [${r.state}]`); }
  const clean = await scanIntegrity(memDb(F.clean));
  console.log(`  ${clean.state === 'VALIDATED' ? 'PASS' : 'FAIL'}  fixture scan: ${clean.state}   ${JSON.stringify(clean.counts)}`);
  return { ok: controlsOk && clean.state === 'VALIDATED', state: controlsOk ? clean.state : 'DETECTOR_BLIND' };
}

async function liveScan({ project, env }) {
  console.log(`  PROJECT      ${project}\n  ENVIRONMENT  ${env}\n  MODE         READ-ONLY (collection().get() only; writes refused)`);
  const admin = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin'));
  const app = admin.initializeApp({ projectId: project }, 'etims-release-gate');
  const r = await scanIntegrity(readOnly(app.firestore()));
  r.issues.forEach((i) => console.log('   ⛔ ' + i));
  console.log(`  integrity: ${r.state}   ${JSON.stringify(r.counts)}`);
  if (r.state === 'NO_DATA') console.log('  ⚠ NO DATA — nothing was validated. This is not a pass.');
  return { ok: r.state === 'VALIDATED', state: r.state };
}

function runTest(label, script) {
  process.stdout.write(`\n▶ ${label}\n`);
  try { process.stdout.write(execFileSync(NODE, [path.join('scripts', script)], { cwd: ROOT, encoding: 'utf8' })); return true; }
  catch (e) { if (e.stdout) process.stdout.write(e.stdout); if (e.stderr) process.stderr.write(e.stderr); return false; }
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) { console.error('etims-release-gate: ' + opts.error); return 64; }
  const results = [];
  results.push(['Tax engine determinism', runTest('Tax engine determinism (22)', 'test-etims-tax-engine.js')]);
  results.push(['Audit tamper-evidence', runTest('Audit tamper-evidence (6)', 'test-etims-audit.js')]);
  results.push(['Payout idempotency guard', runTest('Payout idempotency guard (11)', 'test-payout-idempotency.js')]);
  results.push(['Invoice lifecycle model', runTest('Invoice lifecycle model (16)', 'test-etims-lifecycle.js')]);

  process.stdout.write(`\n▶ Integrity scan (${opts.mode}) — duplicate invoices / audit completeness + chain\n`);
  const scan = opts.mode === 'live' ? await liveScan(opts) : await fixtureScan();
  results.push([`Integrity scan [${opts.mode}: ${scan.state}]`, scan.ok]);

  process.stdout.write('\n=== eTIMS RELEASE GATE ===\n');
  let ok = true;
  for (const [label, pass] of results) { process.stdout.write(`  ${pass ? 'PASS' : 'FAIL'}  ${label}\n`); if (!pass) ok = false; }
  if (opts.mode === 'fixture') process.stdout.write('  note: integrity validated on FIXTURE data only — no project was contacted.\n');
  process.stdout.write(ok ? '\n✅ eTIMS gate GREEN.\n' : '\n⛔ eTIMS gate RED — fix before deploy.\n');
  if (!ok && scan.state === 'NO_DATA') return 2;
  return ok ? 0 : 1;
}

module.exports = { parseArgs, readOnly, scanIntegrity, fixtures, memDb };
if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error('etims-release-gate FAILED:', e.message); process.exit(1); });
