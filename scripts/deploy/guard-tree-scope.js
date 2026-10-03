#!/usr/bin/env node
'use strict';
/* TREE SCOPE GUARD — first predeploy hook of a single-purpose deploy tree (b2 finding 2026-10-04).
   A live-pinned hotfix tree is correct ONLY for the functions it was built for: deploying any other export from it can
   silently roll production back (e.g. this tree's wallet.js carries 45a837d for adminProcessPayout but NOT the P0
   withdrawal gate on requestSellerPayout / processPayoutRetries — deploying those from here would UN-GATE withdrawals).
   The allow-list lives in deploy-scope.json at the tree root. A predeploy hook cannot see firebase's --only flags, so the
   launcher scripts/deploy/deploy-scoped.js passes the scope in SOKONI_DEPLOY_SCOPE; this hook ABORTS:
     · no scope (a bare / unscoped deploy)          · any function not in deploy-scope.json "allow"
   Accept a deploy only when "TREE SCOPE GUARD: PASS" is IN the deploy log. */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
function load() { return JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy-scope.json'), 'utf8')); }
function check(scope, cfg) {
  const allow = new Set((cfg && cfg.allow) || []);
  const raw = String(scope == null ? '' : scope).trim();
  if (!raw) return { ok: false, reason: 'UNSCOPED: no SOKONI_DEPLOY_SCOPE — deploy only via node scripts/deploy/deploy-scoped.js <fn,...>' };
  const names = raw.split(',').map((s) => s.trim().replace(/^functions:/, '')).filter(Boolean);
  const bad = names.filter((n) => !allow.has(n));
  if (!names.length) return { ok: false, reason: 'UNSCOPED: empty list' };
  if (bad.length) return { ok: false, reason: 'OUT OF SCOPE for this tree (' + (cfg.tree || '?') + '): ' + bad.join(', ') + ' — allowed: ' + [...allow].join(', ') };
  return { ok: true, names };
}
if (require.main === module) {
  let cfg; try { cfg = load(); } catch (e) { console.error('TREE SCOPE GUARD: ABORT — deploy-scope.json unreadable'); process.exit(1); }
  const r = check(process.env.SOKONI_DEPLOY_SCOPE, cfg);
  if (!r.ok) { console.error('TREE SCOPE GUARD: ABORT — ' + r.reason); process.exit(1); }
  console.log('TREE SCOPE GUARD: PASS — ' + r.names.join(', ') + ' (tree ' + cfg.tree + ')');
}
module.exports = { check, load };
