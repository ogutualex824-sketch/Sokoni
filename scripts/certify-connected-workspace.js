#!/usr/bin/env node
/* ================================================================
   SOKONI — CONNECTED WORKSPACE, final certification runner
   scripts/certify-connected-workspace.js

   Runs every slice suite of the verification / communications convergence
   (D → E → V1 → V2 → V3 → C1 → C2 → C3 → C4 → C5 → C6) ONE AT A TIME and
   writes a ledger. It is a runner, not a re-implementation: each invariant is
   proven by the suite that owns it, and this file only refuses to call the
   whole connected if any one of them did not end green.

   FAIL CLOSED
     · a suite that exits non-zero, prints no "N passed, 0 failed" line, prints
       a HARNESS ERROR / BLOCKED / PROBE INVALID line, or reports ANY failure,
       fails the certification
     · a suite with fewer than MIN_ASSERTIONS assertions fails it too — a suite
       that silently registered nothing must not read as green
     · the count is asserted as a FLOOR, never as equality: a legitimate
       addition to a suite must not break the certification (parallel agents)
   Chromium suites run strictly one at a time on this 6 GB host; a concurrent
   run reads as a harness error, not a product result.
   Usage: node scripts/certify-connected-workspace.js [--json out.json]
   Exit: 0 certified · 1 not certified · 2 the runner itself could not run
   ================================================================ */
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MIN_ASSERTIONS = 5;

/* slice → suite. Floors are the counts certified at the time of writing; a
   suite may grow, never shrink, without touching this file. */
const SUITES = [
  ['D · one navigation path',                'test-adminos-single-navigation',  22],
  ['B · accessible drawer / rail',           'test-adminos-sidebar-a11y',       34],
  ['C · built ⇒ reachable, deep links',      'test-adminos-nav-coverage',       32],
  ['E · shell at 320–1440',                  'test-adminos-shell-final',        48],
  ['V1 · one verification reviewer',         'test-verification-convergence',   29],
  ['V2 · ticket ↔ record context (server)',  'test-ticket-context',             18],
  ['V2 · ticket ↔ record context (client)',  'test-support-context',            19],
  ['V3 · contextual video verification',     'test-video-verification-actions', 18],
  ['V3 · Connect authority',                 'test-connect-authority',         856],
  ['C2 · email workspace',                   'test-email-workspace',            24],
  ['C3+C4 · rails by lane (catalogue)',      'test-integration-comms-lanes',    59],
  ['C3 · registry parity',                   'test-integration-registry-parity', 26],
  ['C3 · console consumption',               'test-integrations-console',      119],
  ['C4 · SMS workspace',                     'test-sms-workspace',              16],
  ['C5 · support number, one source',        'test-support-phone',               9],
  ['C6 · record links',                      'test-record-links',               21],
  ['AdminOS wiring (regression)',            'test-admin-os-wiring',           310],
  ['AdminOS renderers (regression)',         'test-admin-os-render',            43],
];

const jsonIdx = process.argv.indexOf('--json');
const jsonOut = jsonIdx > -1 ? process.argv[jsonIdx + 1] : null;
const ledger = { at: new Date().toISOString(), commit: null, suites: [], certified: false };
try { ledger.commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || null; } catch (_) {}

console.log('CONNECTED WORKSPACE — FINAL CERTIFICATION (' + (ledger.commit || 'no commit') + ')\n');
let allOk = true;
for (const [slice, suite, floor] of SUITES) {
  const file = path.join(ROOT, 'scripts', suite + '.js');
  const row = { slice, suite, floor, passed: null, failed: null, exit: null, verdict: 'not-run', note: '' };
  if (!fs.existsSync(file)) { row.verdict = 'FAIL'; row.note = 'suite file missing'; allOk = false; ledger.suites.push(row); console.log('  FAIL  ' + slice + '  (' + suite + ': missing)'); continue; }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [file], { cwd: ROOT, encoding: 'utf8', timeout: 480000, maxBuffer: 64 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  row.exit = r.status; row.ms = Date.now() - t0;
  const m = /(\d+) passed,\s*(\d+) failed/.exec(out.split('\n').reverse().find((l) => /passed,\s*\d+ failed/.test(l)) || '');
  const m2 = /passed\s*:\s*(\d+)[\s\S]*?failed\s*:\s*(\d+)/.exec(out);   /* the tests/ certify format */
  const passed = m ? +m[1] : (m2 ? +m2[1] : null), failed = m ? +m[2] : (m2 ? +m2[2] : null);
  row.passed = passed; row.failed = failed;
  /* A harness marker is a LINE that begins with it. An assertion whose name merely
     contains the word (e.g. "a BLOCKED relationship permits nothing") is a result,
     not a harness failure — the first draft of this check failed a green 856/0 suite
     on exactly that. */
  const harness = /^\s*(HARNESS ERROR|BLOCKED\b|PROBE INVALID)/m.test(out.split('\n').filter((l) => !/^\s*(PASS|FAIL)\b/.test(l)).join('\n'));
  if (r.error) { row.verdict = 'FAIL'; row.note = 'spawn: ' + r.error.message; }
  else if (harness) { row.verdict = 'FAIL'; row.note = 'harness error / blocked'; }
  else if (passed === null) { row.verdict = 'FAIL'; row.note = 'no summary line'; }
  else if (failed !== 0) { row.verdict = 'FAIL'; row.note = failed + ' failed'; }
  else if (r.status !== 0) { row.verdict = 'FAIL'; row.note = 'exit ' + r.status; }
  else if (passed < MIN_ASSERTIONS) { row.verdict = 'FAIL'; row.note = 'only ' + passed + ' assertions'; }
  else if (passed < floor) { row.verdict = 'FAIL'; row.note = 'below floor ' + floor + ' (a suite shrank)'; }
  else row.verdict = 'PASS';
  if (row.verdict !== 'PASS') allOk = false;
  ledger.suites.push(row);
  console.log('  ' + row.verdict + '  ' + slice.padEnd(42) + (suite + '.js').padEnd(40) + (passed === null ? '—' : passed + '/' + failed) + (row.note ? '   ' + row.note : '') + '   ' + Math.round(row.ms / 1000) + 's');
}
ledger.certified = allOk;
if (jsonOut) { try { fs.writeFileSync(path.resolve(ROOT, jsonOut), JSON.stringify(ledger, null, 2)); console.log('\nledger → ' + jsonOut); } catch (e) { console.error('could not write ledger: ' + e.message); process.exit(2); } }
console.log('\n' + (allOk ? 'CERTIFIED — every slice suite ended green, one at a time.' : 'NOT CERTIFIED — at least one slice suite did not end green.'));
process.exit(allOk ? 0 : 1);
