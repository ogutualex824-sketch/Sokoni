#!/usr/bin/env node
/* ================================================================
   SOKONI — Deployment Integrity Reconciler  (READ-ONLY)
   scripts/deployment-integrity.js

   Compares DEPLOYED Cloud Functions against the functions EXPORTED by
   functions/index.js and classifies every mismatch on hard evidence.

   It NEVER deploys, deletes, or mutates anything.

   Usage:
     firebase functions:list > .fnlist.txt      # raw table (ANSI-stripped)
     node scripts/deployment-integrity.js .fnlist.txt          # report
     node scripts/deployment-integrity.js .fnlist.txt --ci     # CI GATE (exit 1 on drift)

   Emits: docs/orphan-functions.csv  (+ summary to stdout)

   ── CANONICAL INVENTORY RULE ────────────────────────────────────────────
   The source export set is obtained by RUNTIME ENUMERATION only:
       Object.keys(require('./functions/index.js'))
   Static regex scanning (/^exports\.NAME/) is DEPRECATED and MUST NEVER be
   used to determine orphans, undeployed functions, deployment safety, or
   deletion candidates. index.js generates most exports DYNAMICALLY
   (algoliaSync_* / searchSync_* / ts_* factories), so a regex under-counts by
   ~147 and produces phantom orphans. Acting on that false reading would have
   deleted the entire Algolia/Firestore search-sync layer.
   ────────────────────────────────────────────────────────────────────────

   Evidence used per orphan:
     • trigger type   — an onCall DISPATCHER cannot replace an EVENT trigger
                        (firestore/scheduler/pubsub/eventarc). Event-triggered
                        orphans therefore CANNOT have been "consolidated away".
     • replacement dispatcher (deployed AND exported?) and client callers.
     • generation / region / runtime.

   Invocation counts are NOT collected here. Status is therefore UNKNOWN —
   which is NOT "inactive" and NOT "unused". SAFE_DELETE is never issued
   without 30-day metrics. Evidence takes precedence over assumptions.
================================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const listFile = process.argv[2];
const CI = process.argv.includes('--ci');
if (!listFile) { console.error('usage: deployment-integrity.js <firebase-functions-list.txt> [--ci]'); process.exit(1); }

/* ── 1. Parse the deployed inventory ─────────────────────────────── */
const raw = fs.readFileSync(listFile, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
const deployed = [];
for (const line of raw.split('\n')) {
  if (!line.startsWith('│')) continue;
  const cells = line.split('│').map((c) => c.trim()).filter((c, i, a) => i > 0 && i < a.length - 1);
  if (cells.length < 6) continue;
  const [name, gen, trigger, location, memory, runtime] = cells;
  if (!name || name === 'Function') continue;
  deployed.push({ name, gen, trigger, location, memory, runtime });
}

/* ── 2. Source exports — MUST be enumerated at RUNTIME, not by regex ──────
   index.js creates many exports DYNAMICALLY (e.g. algolia-sync.js builds
   `algoliaSync_<col>_create` in a loop; search-sync.js and the ts_* factories do
   the same). A static `^exports.NAME` scan cannot see those and reports 147
   phantom "orphans". Loading the module is the only correct method. */
const fnDir = path.join(__dirname, '..', 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
process.env.FIREBASE_CONFIG = process.env.FIREBASE_CONFIG || JSON.stringify({ projectId: 'sokoni-aeb26' });
const exported = new Set(Object.keys(require(path.join(fnDir, 'index.js'))));

/* ── 3. Does the implementation still exist anywhere in source? ───── */
const modFiles = fs.readdirSync(fnDir).filter((f) => f.endsWith('.js'));
const modLines = {};
for (const f of modFiles) {
  modLines[f] = fs.readFileSync(path.join(fnDir, f), 'utf8').split('\n').map((l) => l.trim());
}
function sourceModule(fn) {
  const a = 'exports.' + fn + ' ';
  const b = 'exports.' + fn + '=';
  return modFiles.find((f) => modLines[f].some((l) => l.startsWith(a) || l.startsWith(b))) || null;
}

/* ── 4. Trigger classification ───────────────────────────────────── */
/* An EVENT trigger fires automatically. A callable/https function is invoked by a
   client — only THOSE can plausibly be superseded by an onCall dispatcher. */
function triggerClass(t) {
  const s = (t || '').toLowerCase();
  if (s.includes('callable')) return 'callable';
  if (s.includes('https')) return 'https';
  if (s.includes('scheduler') || s.includes('schedule')) return 'scheduler';
  if (s.includes('pubsub')) return 'pubsub';
  if (s.includes('firestore') || s.includes('document')) return 'firestore';
  if (s.includes('storage')) return 'storage';
  if (s.includes('auth')) return 'auth';
  if (s.includes('eventarc') || s.includes('event')) return 'eventarc';
  return 'other:' + s.slice(0, 24);
}
const EVENT_TRIGGERS = new Set(['scheduler', 'pubsub', 'firestore', 'storage', 'auth', 'eventarc']);

/* Count client files that still invoke a function directly (httpsCallable). */
const ROOT = path.join(__dirname, '..');
let clientFiles = null;
function loadClientFiles() {
  if (clientFiles) return clientFiles;
  clientFiles = [];
  const walk = (d, depth) => {
    if (depth > 2) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'functions') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.(html|js)$/.test(e.name)) { try { clientFiles.push(fs.readFileSync(p, 'utf8')); } catch (_) {} }
    }
  };
  walk(ROOT, 0);
  return clientFiles;
}
function countClientCallers(fn) {
  return loadClientFiles().filter((s) =>
    s.includes("httpsCallable('" + fn + "'") || s.includes('httpsCallable("' + fn + '"')).length;
}

/* ── 5. Reconcile ────────────────────────────────────────────────── */
const deployedNames = new Set(deployed.map((d) => d.name));
const orphans = deployed.filter((d) => !exported.has(d.name));       // in prod, not in source
const undeployed = [...exported].filter((e) => !deployedNames.has(e)); // in source, not in prod

const rows = orphans.map((o) => {
  const mod = sourceModule(o.name);
  const tc = triggerClass(o.trigger);
  const isEvent = EVENT_TRIGGERS.has(tc);

  /* Is this orphan served by a live dispatcher? (consolidation evidence) */
  let dispatcher = '';
  for (const f of modFiles) {
    if (!/dispatch/i.test(f)) continue;
    if (modLines[f].some((l) => l.includes(o.name + ':') || l.includes("'" + o.name + "'"))) {
      dispatcher = f.replace(/\.js$/, ''); break;
    }
  }
  /* Any direct client caller left? */
  const clientCallers = countClientCallers(o.name);

  let recommendation, rationale;
  if (isEvent) {
    recommendation = 'RECOVER_SOURCE';
    rationale = `EVENT trigger (${tc}). An onCall dispatcher CANNOT replace an event trigger, so it was NOT consolidated. Must be exported from index.js before any full deploy.`;
  } else if (mod) {
    recommendation = 'RECOVER_SOURCE';
    rationale = `Implementation exists in functions/${mod}; simply re-export from index.js. Zero risk, no metrics required.`;
  } else if (dispatcher && clientCallers === 0) {
    recommendation = 'INVESTIGATE_LIKELY_SAFE_DELETE';
    rationale = `${tc}, superseded: routed by ${dispatcher} (deployed AND exported) and ZERO direct client callers. Consolidation is consistent with the evidence, BUT confirm 30-day invocations = 0 before deleting. Alternatively re-export it (zero-risk) to make deployed == exported.`;
  } else {
    recommendation = 'INVESTIGATE';
    rationale = `${tc}. No source, no dispatcher route found${clientCallers ? `, ${clientCallers} client caller(s) still reference it` : ''}. Requires 30-day invocation metrics. Do NOT delete on name similarity.`;
  }
  return { ...o, triggerClass: tc, isEvent, sourceModule: mod || '', dispatcher, clientCallers, recommendation, rationale };
});

/* ── 6. Emit CSV ─────────────────────────────────────────────────── */
const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const cols = ['name', 'gen', 'triggerClass', 'trigger', 'location', 'runtime', 'sourceModule', 'dispatcher', 'clientCallers', 'invocations30d', 'status', 'recommendation', 'rationale'];
const csv = [cols.join(',')].concat(rows.map((r) => cols.map((c) => esc(
  c === 'invocations30d' ? 'UNAVAILABLE' : c === 'status' ? 'UNKNOWN' : r[c]
)).join(','))).join('\n');
const outDir = path.join(__dirname, '..', 'docs');
fs.writeFileSync(path.join(outDir, 'orphan-functions.csv'), csv);

/* ── 7. Summary ──────────────────────────────────────────────────── */
const by = (arr, k) => arr.reduce((m, x) => { m[x[k]] = (m[x[k]] || 0) + 1; return m; }, {});
console.log('DEPLOYMENT INTEGRITY — read-only reconciliation\n');
console.log('deployed          :', deployed.length);
console.log('exported (source) :', exported.size);
console.log('ORPHANS (prod, not in source):', orphans.length);
console.log('UNDEPLOYED (source, not in prod):', undeployed.length, undeployed.length ? '→ ' + undeployed.join(', ') : '');
console.log('\nOrphans by trigger class:');
Object.entries(by(rows, 'triggerClass')).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ' + k.padEnd(12), v));
console.log('\nOrphans by recommendation:');
Object.entries(by(rows, 'recommendation')).forEach(([k, v]) => console.log('  ' + k.padEnd(16), v));
const eventNoSrc = rows.filter((r) => r.isEvent && !r.sourceModule);
console.log('\n⚠ EVENT-triggered orphans with NO source (cannot have been consolidated):', eventNoSrc.length);
eventNoSrc.slice(0, 12).forEach((r) => console.log('   ', r.name, '(' + r.triggerClass + ')'));
if (eventNoSrc.length > 12) console.log('    … +' + (eventNoSrc.length - 12) + ' more');
console.log('\nSAFE_DELETE issued:', rows.filter((r) => r.recommendation === 'SAFE_DELETE').length,
  '— none can be issued without invocation metrics.');
console.log('\nCSV → docs/orphan-functions.csv');

/* ── 8. CI GATE ──────────────────────────────────────────────────────────
   Fails the build when production and source have drifted, so a full
   `firebase deploy --only functions` can never silently delete a function. */
if (CI) {
  const problems = [];
  if (orphans.length > 0) {
    problems.push(
      `${orphans.length} DEPLOYED function(s) are NOT exported by index.js. ` +
      `A full deploy would DELETE them: ${orphans.map((o) => o.name).join(', ')}. ` +
      `Re-export them (docs/recovery-plan.md Path A) — do NOT delete on assumption.`);
  }
  if (undeployed.length > 0) {
    problems.push(
      `${undeployed.length} function(s) are exported but NOT deployed: ${undeployed.join(', ')}. ` +
      `If intentional (new functions), confirm Cloud Run quota headroom and re-baseline.`);
  }
  console.log('\n──────── CI DEPLOYMENT-INTEGRITY GATE ────────');
  if (problems.length) {
    console.error('❌ FAIL — production and source have DRIFTED.\n');
    problems.forEach((p) => console.error('  • ' + p + '\n'));
    console.error('  A full `firebase deploy --only functions` is FORBIDDEN until this is 0/0.');
    console.error('  Use targeted deploys: firebase deploy --only functions:<name>');
    process.exit(1);
  }
  console.log('✅ PASS — deployed (' + deployed.length + ') == runtime exported (' + exported.size + ').');
  console.log('   A full `firebase deploy --only functions` would delete nothing and create nothing.');
  process.exit(0);
}
