#!/usr/bin/env node
'use strict';
/**
 * USERS RELEASE DEPLOY GUARD (owner 2026-10-04): setUserRole / suspendUser / tsBanUser / tsReviewReport / adminOsDispatch /
 * expireSuspensions FAIL the deploy unless a per-function reconciliation approval for the EXACT candidate commit is recorded.
 *   G1 unscoped deploy → ABORT                 G2 a function outside the tree allow-list → ABORT
 *   G3 gated function with no record → ABORT   G4 record for another commit → ABORT (a later commit voids approval)
 *   G5 uncommitted functions/ change → ABORT   G6 complete record for HEAD on a clean tree → PASS
 *   G7 git state unreadable → ABORT            G8 incomplete record (no approver / no live generation) → ABORT
 *   G9 the REAL hook: run as a predeploy would, with this tree's deploy-scope.json — unscoped and gated scopes exit non-zero,
 *      and firebase.json runs it FIRST (relative path, so it actually executes)
 */
const path = require('path'), cp = require('child_process'), fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const { check } = require(path.join(ROOT, 'scripts/deploy/guard-tree-scope.js'));
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const cfg = (reconciled) => ({ tree: 't', allow: ['setUserRole', 'suspendUser', 'tsBanUser', 'harmless'], reconciliationRequired: ['setUserRole', 'suspendUser', 'tsBanUser'], reconciled: reconciled || {} });
const okRec = { live: 'setUserRole-1788256990847659 (00010-jif)', candidate: HEAD.slice(0, 12), approvedBy: 'b2 live comparison 2026-10-04' };
const clean = { head: HEAD, dirty: false };

const g1 = check('', cfg(), clean); ck('G1', !g1.ok && /UNSCOPED/.test(g1.reason), 'unscoped deploy → ABORT', g1);
const g2 = check('requestSellerPayout', cfg(), clean); ck('G2', !g2.ok && /OUT OF SCOPE/.test(g2.reason), 'function outside the allow-list → ABORT', g2);
const g3 = check('setUserRole', cfg(), clean); ck('G3', !g3.ok && /NOT RECONCILIATION-APPROVED: setUserRole/.test(g3.reason), 'gated function without a reconciliation record → ABORT', g3);
const g4 = check('setUserRole', cfg({ setUserRole: Object.assign({}, okRec, { candidate: '1111111' }) }), clean);
ck('G4', !g4.ok && /approved 1111111/.test(g4.reason), 'approval recorded for ANOTHER commit → ABORT (a later commit voids it)', g4);
const g5 = check('setUserRole', cfg({ setUserRole: okRec }), { head: HEAD, dirty: true }); ck('G5', !g5.ok && /uncommitted/.test(g5.reason), 'uncommitted functions/ change → ABORT', g5);
const g6 = check('setUserRole,harmless', cfg({ setUserRole: okRec }), clean); ck('G6', g6.ok, 'complete record for HEAD on a clean tree → PASS (ungated allowed fn passes too)', g6);
const g6b = check('setUserRole,suspendUser', cfg({ setUserRole: okRec }), clean); ck('G6b', !g6b.ok && /suspendUser/.test(g6b.reason) && !/setUserRole \(/.test(g6b.reason), 'ONE approval never covers another function', g6b);
const g7 = check('tsBanUser', cfg({ tsBanUser: okRec }), null); ck('G7', !g7.ok && /unreadable/.test(g7.reason), 'git state unreadable → ABORT (fail closed)', g7);
const g8 = check('tsBanUser', cfg({ tsBanUser: { candidate: HEAD.slice(0, 12), live: '' } }), clean); ck('G8', !g8.ok && /NOT RECONCILIATION-APPROVED/.test(g8.reason), 'incomplete record (no approver / empty live) → ABORT', g8);

const run = (scope) => { const env = Object.assign({}, process.env); delete env.SOKONI_DEPLOY_SCOPE; if (scope != null) env.SOKONI_DEPLOY_SCOPE = scope;
  const r = cp.spawnSync('node', ['scripts/deploy/guard-tree-scope.js'], { cwd: ROOT, env, encoding: 'utf8' }); return { status: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy-scope.json'), 'utf8'));
const h1 = run(null), h2 = run('setUserRole'), h3 = run('suspendUser,tsBanUser,tsReviewReport,adminOsDispatch,expireSuspensions');
const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
const pre = (Array.isArray(fb.functions) ? fb.functions[0] : fb.functions).predeploy || [];
ck('G9', h1.status === 1 && /UNSCOPED/.test(h1.out) && (Object.keys(real.reconciled || {}).length ? true : (h2.status === 1 && /NOT RECONCILIATION-APPROVED|uncommitted/.test(h2.out) && h3.status === 1))
  && pre[0] === 'node scripts/deploy/guard-tree-scope.js'
  && ['setUserRole', 'suspendUser', 'tsBanUser', 'tsReviewReport', 'adminOsDispatch'].every((n) => (real.reconciliationRequired || []).includes(n)),
  'the REAL hook (this tree\'s deploy-scope.json) refuses unscoped and unreconciled deploys, and runs FIRST in functions predeploy', { h1: h1.status, h2: h2.out.trim().slice(0, 140), h3: h3.status, pre0: pre[0] });

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
