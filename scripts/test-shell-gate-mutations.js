#!/usr/bin/env node
/* test-shell-gate-mutations.js — mutation tests for the shell authority. Each mutation removes or inverts one clause of
 * the gate in a COPY of functions/business-workspace.js, runs scripts/test-shell-approval-gate.js against it, and requires
 * the suite to FAIL. A suite that cannot fail proves nothing. The original file is restored and its hash re-verified.
 *
 *   node scripts/test-shell-gate-mutations.js
 */
'use strict';
const fs = require('fs'); const Path = require('path'); const cp = require('child_process'); const crypto = require('crypto');
const ROOT = Path.resolve(__dirname, '..'); const FILE = Path.join(ROOT, 'functions', 'business-workspace.js'); const SUITE = Path.join(__dirname, 'test-shell-approval-gate.js');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const original = fs.readFileSync(FILE, 'utf8'); const origSha = sha(original);
const MUTATIONS = [
  { name: 'M1 no gate: REAPPLICATION_REQUIRED branch removed (invalid/no-evidence accounts fall through to routing)', find: "  if (approval.state === A.INVALID_LEGACY || approval.state === A.NONE) {", replace: "  if (false) {" },
  { name: 'M2 NO_APPROVAL treated as valid (status alone approves)', find: "const A = REM.STATES;", replace: "const A = Object.assign({}, REM.STATES, { NONE: '__never__' });" },
  { name: 'M3 cleanup ownership ignored (claimed identities get the transition)', find: "    if (approval.ownership === 'cleanup') {", replace: "    if (false) {" },
  { name: 'M4 REFUSED not held (a refused record reaches routing)', find: "  if (approval.state === A.REFUSED) {", replace: "  if (false) {" },
  { name: 'M5 fail OPEN on unreadable evidence', find: "  if (!approval.readable) {", replace: "  if (false) {" },
  { name: 'M6 shop homes not gated (a shop live by status alone gets merchant-v2)', find: "  if (approvalValid) try {", replace: "  try {" },
  { name: 'M7 route to a dashboard instead of the completion surface', find: "{ route: 'complete-application.html', remediation:", replace: "{ route: 'provider-dashboard.html', remediation:" },
];
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 160) + ']' : '')); ok ? pass++ : fail++; };
const run = () => { const r = cp.spawnSync(process.execPath, [SUITE], { encoding: 'utf8', timeout: 180000 }); const m = /(\d+) passed, (\d+) failed/.exec(r.stdout || ''); return { code: r.status, passed: m ? +m[1] : null, failed: m ? +m[2] : null, crashed: /SUITE CRASH/.test(r.stdout || '') }; };
try {
  console.log('\n── baseline ──');
  const base = run(); ck('the unmutated gate suite passes', base.code === 0 && base.failed === 0, JSON.stringify(base));
  console.log('\n── mutations (each must make the suite FAIL) ──');
  for (const m of MUTATIONS) {
    if (!original.includes(m.find)) { ck(m.name + ' — anchor present in business-workspace.js', false, m.find.slice(0, 60)); continue; }
    fs.writeFileSync(FILE, original.replace(m.find, m.replace));
    const r = run();
    ck(m.name + ' → suite fails (' + (r.failed ?? 'crash') + ' failing assertions)', (r.code !== 0) && (r.failed > 0 || r.crashed), JSON.stringify(r));
    fs.writeFileSync(FILE, original);
  }
} finally { fs.writeFileSync(FILE, original); }
ck('business-workspace.js restored byte-identical (' + origSha + ')', sha(fs.readFileSync(FILE, 'utf8')) === origSha);
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
