#!/usr/bin/env node
/* adminUpdateFeatureFlag must never switch a flag ON by omission, nor widen a staged rollout on a plain toggle.
 * (featureFlags/fitness_membership_sales gates PAID Fitness memberships — reported by sokoni-2f 2026-10-03.)
 * Executes the REAL handler on an in-memory Firestore.   node scripts/test-feature-flag-update.js   BASE=<ref> to compare */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), { execSync } = require('child_process');
const H = require('./lib/inmem-firestore').install({ admins: [] });
const { call } = require('./lib/inmem-firestore');
const ROOT = path.join(__dirname, '..');
let FN = path.join(ROOT, 'functions');
if (process.env.BASE) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-'));
  execSync('git archive ' + process.env.BASE + ' functions | tar -x -C "' + d.replace(/\\/g, '/') + '"', { cwd: ROOT, shell: 'bash' });
  FN = path.join(d, 'functions');
}
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 220) + ']')); ok ? pass++ : fail++; };
console.log('\nadminUpdateFeatureFlag   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
const SA = { superAdmin: true };
(async () => {
  const AO = require(path.join(FN, 'admin-os.js'))._h;
  const flag = () => H.DOCS.get('featureFlags/fitness_membership_sales');
  H.reset(); H.DOCS.set('featureFlags/fitness_membership_sales', { key: 'fitness_membership_sales', enabled: false, rolloutPct: 10, enabledForRoles: ['beta'] });
  let r = await call(AO.adminUpdateFeatureFlag, 'sa1', { key: 'fitness_membership_sales', description: 'note only' }, SA);
  ck('F-1', !r.ok && flag().enabled === false, 'a call that omits `enabled` is refused and the gate stays OFF', { r: r.code || r.msg || 'ok', enabled: flag().enabled });
  r = await call(AO.adminUpdateFeatureFlag, 'sa1', { key: 'fitness_membership_sales', enabled: 'true' }, SA);
  ck('F-2', !r.ok && flag().enabled === false, 'a non-boolean `enabled` ("true") is refused', { r: r.code || r.msg || 'ok', enabled: flag().enabled });
  r = await call(AO.adminUpdateFeatureFlag, 'sa1', { key: 'fitness_membership_sales', enabled: true }, SA);
  ck('F-3', !!r.ok && flag().enabled === true && flag().rolloutPct === 10 && JSON.stringify(flag().enabledForRoles) === '["beta"]',
    'a plain toggle ON keeps the staged rollout (10 %, beta) — it does not widen to 100 % / everyone', flag());
  r = await call(AO.adminUpdateFeatureFlag, 'user1', { key: 'fitness_membership_sales', enabled: false }, {});
  ck('F-4', !r.ok && flag().enabled === true, 'a non-super-admin cannot change a flag', { r: r.code || r.msg || 'ok' });
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
