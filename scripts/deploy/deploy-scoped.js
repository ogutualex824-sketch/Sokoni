#!/usr/bin/env node
'use strict';
/* The ONLY launcher for a single-purpose deploy tree (incl. the reconciliation gate — see guard-tree-scope.js).
     node scripts/deploy/deploy-scoped.js <fn,...> --config <firebase.x.json> [--dry-run]
   Validates against deploy-scope.json (scripts/deploy/guard-tree-scope.js), then runs
   `firebase deploy --config <cfg> --project sokoni-aeb26 --only functions:<names> --non-interactive` with SOKONI_DEPLOY_SCOPE
   set, so the predeploy hook re-checks inside the deploy and prints its banner into the log. */
const cp = require('child_process'), path = require('path');
const { check, load, gitState } = require('./guard-tree-scope');
const ROOT = path.resolve(__dirname, '..', '..');
const list = process.argv[2];
const ci = process.argv.indexOf('--config'); const config = ci > 0 ? process.argv[ci + 1] : null;
if (!config) { console.error('deploy-scoped: --config <firebase.x.json> is required'); process.exit(1); }
const r = check(list, load(), gitState());
if (!r.ok) { console.error('deploy-scoped: REFUSED — ' + r.reason); process.exit(1); }
const args = ['firebase', 'deploy', '--config', config, '--project', 'sokoni-aeb26', '--only', r.names.map((n) => 'functions:' + n).join(','), '--non-interactive'];
console.log('deploy-scoped: npx ' + args.join(' '));
if (process.argv.includes('--dry-run')) process.exit(0);
const res = cp.spawnSync('npx', args, { cwd: ROOT, stdio: 'inherit', shell: true, env: Object.assign({}, process.env, { SOKONI_DEPLOY_SCOPE: r.names.join(',') }) });
process.exit(res.status == null ? 1 : res.status);
