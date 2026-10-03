#!/usr/bin/env node
'use strict';
/* TREE SCOPE + RECONCILIATION GUARD — first predeploy hook of the Users security functions tree (owner 2026-10-04).
   Ported from the payout trees (b2 finding 2026-10-04) and extended with the owner's mechanical reconciliation gate:
     · no scope (a bare / unscoped deploy)                              → ABORT
     · any function not in deploy-scope.json "allow"                    → ABORT
     · a function in "reconciliationRequired" WITHOUT a "reconciled" record for it → ABORT
       The record must name the live generation, the approver, and the EXACT candidate commit; the candidate must equal
       HEAD and functions/ must have no uncommitted change — so any later commit or edit voids the approval and the
       live-vs-candidate comparison has to be re-run and re-recorded. Not memory: a refusal.
   A predeploy hook cannot see firebase's --only flags, so the launcher scripts/deploy/deploy-scoped.js passes the scope in
   SOKONI_DEPLOY_SCOPE. Accept a deploy only when "TREE SCOPE GUARD: PASS" is IN the deploy log. */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');
function load() { return JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy-scope.json'), 'utf8')); }
function gitState() {
  try {
    const head = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const dirty = cp.execFileSync('git', ['status', '--porcelain', '--', 'functions'], { cwd: ROOT, encoding: 'utf8' }).trim();
    return { head, dirty: dirty.length > 0 };
  } catch (_) { return null; }
}
function check(scope, cfg, git) {
  const allow = new Set((cfg && cfg.allow) || []);
  const raw = String(scope == null ? '' : scope).trim();
  if (!raw) return { ok: false, reason: 'UNSCOPED: no SOKONI_DEPLOY_SCOPE — deploy only via node scripts/deploy/deploy-scoped.js <fn,...>' };
  const names = raw.split(',').map((s) => s.trim().replace(/^functions:/, '')).filter(Boolean);
  if (!names.length) return { ok: false, reason: 'UNSCOPED: empty list' };
  const bad = names.filter((n) => !allow.has(n));
  if (bad.length) return { ok: false, reason: 'OUT OF SCOPE for this tree (' + (cfg.tree || '?') + '): ' + bad.join(', ') + ' — allowed: ' + [...allow].join(', ') };
  const need = new Set((cfg && cfg.reconciliationRequired) || []);
  const gated = names.filter((n) => need.has(n));
  if (gated.length) {
    if (!git) return { ok: false, reason: 'RECONCILIATION: git state unreadable — refusing (fail closed)' };
    if (git.dirty) return { ok: false, reason: 'RECONCILIATION: functions/ has uncommitted changes — an approval covers a COMMIT, not a working tree' };
    const rec = (cfg && cfg.reconciled) || {};
    const missing = [];
    for (const n of gated) {
      const r = rec[n];
      const valid = r && typeof r === 'object' && typeof r.live === 'string' && r.live.trim() && typeof r.approvedBy === 'string' && r.approvedBy.trim()
        && typeof r.candidate === 'string' && /^[0-9a-f]{7,40}$/.test(r.candidate) && git.head.startsWith(r.candidate);
      if (!valid) missing.push(n + (r && r.candidate && !git.head.startsWith(r.candidate) ? ' (approved ' + r.candidate + ', HEAD is ' + git.head.slice(0, 12) + ')' : ' (no reconciliation record)'));
    }
    if (missing.length) return { ok: false, reason: 'NOT RECONCILIATION-APPROVED: ' + missing.join('; ') + ' — record { live, candidate, approvedBy } per function in deploy-scope.json "reconciled" after the live-vs-candidate comparison' };
  }
  return { ok: true, names };
}
if (require.main === module) {
  let cfg; try { cfg = load(); } catch (e) { console.error('TREE SCOPE GUARD: ABORT — deploy-scope.json unreadable'); process.exit(1); }
  const r = check(process.env.SOKONI_DEPLOY_SCOPE, cfg, gitState());
  if (!r.ok) { console.error('TREE SCOPE GUARD: ABORT — ' + r.reason); process.exit(1); }
  console.log('TREE SCOPE GUARD: PASS — ' + r.names.join(', ') + ' (tree ' + cfg.tree + ')');
}
module.exports = { check, load, gitState };
