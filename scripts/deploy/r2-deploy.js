#!/usr/bin/env node
'use strict';
/* The ONLY way to deploy functions from release/marketing-functions-r2.
     node scripts/deploy/r2-deploy.js providerDispatch,createPaymentIntent [--dry-run]
   Validates the list with the same guard the predeploy hook runs (scripts/deploy/guard-r2-scope.js), then launches
   `firebase deploy --config firebase.r2deploy.json --only functions:<names> --non-interactive` with SOKONI_R2_SCOPE set, so
   the hook re-checks the scope inside the deploy and prints its banner into the log. A bare `firebase deploy` from this tree
   has no SOKONI_R2_SCOPE and is aborted by the hook. --dry-run prints the command and exits without deploying. */
const cp = require('child_process'), path = require('path');
const { check } = require('./guard-r2-scope');
const ROOT = path.resolve(__dirname, '..', '..');
const list = process.argv[2];
const r = check(list);
if (!r.ok) { console.error('r2-deploy: REFUSED — ' + r.reason); process.exit(1); }
const only = r.names.map((n) => 'functions:' + n).join(',');
const args = ['firebase', 'deploy', '--config', 'firebase.r2deploy.json', '--project', 'sokoni-aeb26', '--only', only, '--non-interactive'];
console.log('r2-deploy: npx ' + args.join(' '));
if (process.argv.includes('--dry-run')) process.exit(0);
const res = cp.spawnSync('npx', args, { cwd: ROOT, stdio: 'inherit', shell: true, env: Object.assign({}, process.env, { SOKONI_R2_SCOPE: r.names.join(',') }) });
process.exit(res.status == null ? 1 : res.status);
