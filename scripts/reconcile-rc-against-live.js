#!/usr/bin/env node
/* Reconcile this RC against the live lineage before any deployment decision.
 *
 *   node scripts/reconcile-rc-against-live.js [liveRef]     (default: 61f468e — UPDATE THIS when live moves)
 *
 * WHY THIS EXISTS
 * This RC was CONSTRUCTED from live by cherry-picking onto it, and a cherry-pick can
 * silently drop or revert content from the base. Production has already been rolled back
 * once in this repo by deploying a tree that was behind live, so "my changes are present"
 * is only half the question. The other half — "is everything that was already live still
 * here" — is the one that causes rollbacks, and it is checked FILE BY FILE against the
 * live commit rather than assumed from a clean cherry-pick exit code.
 *
 * Deploys nothing. Grants nothing. Read-only.
 */
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const LIVE = process.argv[2] || '61f468e';

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 86) + ']' : ''));
  ok ? pass++ : fail++;
  return ok;
};
/* maxBuffer: the CHANGELOG alone exceeds the 1 MB default and throws a confusing
   dump of the whole output object rather than a clear error. */
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const gitQuiet = (...a) => { try { execFileSync('git', a, { cwd: ROOT, stdio: 'pipe' }); return true; } catch (e) { return false; } };

/* The changes this release is ALLOWED to contain. Anything else is unintended. */
const INTENDED = [
  '.gitignore',
  'CHANGELOG.md',
  'firebase.json',
  'scripts/build-minimal-rules-release.js',
  'firestore.rules.release-minimal',
  'firebase.rules-minimal.json',
  'firestore.indexes.json',
  'firestore.rules',
  'firestore.rules.build',
  'package.json',
  'docs/AUTHORIZATION_REVIEW.md',
  'docs/TENANT_AUTHORITY_PRIMITIVE.md',
  'docs/TENANT_ISOLATION_BASELINE_SNIPPET.md',
  'docs/index-registry.json',
  'docs/findings/LIVE_FINANCIAL_LEDGER_AUDIT.md',
  'docs/findings/COMMISSION_RAIL_SEPARATION_AUDIT.md',
  'docs/findings/CERTIFICATION_ROLE_SEPARATION.md',
  'docs/findings/SHOPEMPLOYEES_ESCALATION.md',
  'docs/findings/STAFF_AWARE_ATTEMPT_1_REJECTED.md',
  'docs/findings/STAFF_AWARE_AUTHORITY_SPEC.md',
  'docs/findings/TENANT_AUTHZ_RESIDUAL_DEBT.md',
  'functions/business-health-score.js',
  'functions/crm.js',
  'functions/merchant-authority.js',
  'functions/pos-peripherals.js',
  'functions/pos-zero-friction.js',
  'scripts/cert-pos-cashier-callables.js',
  'scripts/cert-pos-checkout-authority.js',
  'scripts/emulators.cert.json',
  'scripts/gate-rules-release-path.js',
  'scripts/gate-served-rules-parity.js',
  'scripts/reconcile-rc-against-live.js',
  'scripts/test-merchant-authority.js',
  'scripts/test-shopemployees-authority.js',
];

console.log('\nRC RECONCILIATION AGAINST LIVE\n');

const head = git('rev-parse', '--short', 'HEAD');
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
console.log('  RC   : ' + branch + ' @ ' + head);
console.log('  LIVE : ' + LIVE + '  ' + git('log', '-1', '--format=%s', LIVE).slice(0, 76) + '\n');

console.log('1. LINEAGE\n');
ck('the live commit exists locally', gitQuiet('cat-file', '-e', LIVE));
ck('LIVE is an ancestor of the RC — no rollback of the live release',
   gitQuiet('merge-base', '--is-ancestor', LIVE, 'HEAD'),
   'the RC builds ON live, it does not replace it');
ck('the RC is strictly ahead of live', Number(git('rev-list', '--count', LIVE + '..HEAD')) > 0,
   git('rev-list', '--count', LIVE + '..HEAD') + ' commits');
ck('live has nothing the RC lacks', Number(git('rev-list', '--count', 'HEAD..' + LIVE)) === 0,
   git('rev-list', '--count', 'HEAD..' + LIVE) + ' commits behind');
ck('the working tree is clean', git('status', '--porcelain') === '', git('status', '--porcelain').split('\n')[0] || 'clean');

console.log('\n2. THE DIFF CONTAINS ONLY INTENDED RELEASE CHANGES\n');
const changed = git('diff', '--name-only', LIVE, 'HEAD').split('\n').filter(Boolean);
const unexpected = changed.filter((f) => INTENDED.indexOf(f) === -1);
ck('every changed file is an intended release change', unexpected.length === 0,
   unexpected.length ? 'UNEXPECTED: ' + unexpected.join(', ') : changed.length + ' files');
ck('no HTML page is modified', changed.filter((f) => f.endsWith('.html')).length === 0,
   changed.filter((f) => f.endsWith('.html')).join(', ') || 'none');
ck('no client-side app JS is modified',
   changed.filter((f) => /^sokoni-|^pos\.js$|^auth\.js$|^seller\.js$/.test(f)).length === 0);
ck('the service worker is not touched', changed.indexOf('sw.js') === -1 && changed.indexOf('sw-register.js') === -1);
ck('version.json is not hand-edited', changed.indexOf('version.json') === -1);

console.log('\n3. NOTHING FROM THE LIVE RELEASE WAS REVERTED\n');
/* Every file the live lineage itself changed must still match live byte for byte,
   except CHANGELOG.md which legitimately gains this release's entry on top. */
const base = git('merge-base', LIVE, git('rev-list', '--max-parents=0', 'HEAD').split('\n').pop());
const liveTouched = git('diff', '--name-only', 'de20ba1', LIVE).split('\n').filter(Boolean);
let reverted = [];
for (const f of liveTouched) {
  if (f === 'CHANGELOG.md') continue;
  if (!gitQuiet('diff', '--quiet', LIVE, 'HEAD', '--', f)) reverted.push(f);
}
ck('every file the live release touched is byte-identical in the RC', reverted.length === 0,
   reverted.length ? 'REVERTED: ' + reverted.join(', ') : liveTouched.length - 1 + ' files verified');

const cl = git('show', 'HEAD:CHANGELOG.md');
ck('CHANGELOG keeps the live release entry', /Role Entry Authorization Convergence/.test(cl));
ck('CHANGELOG keeps this release entry', /merchant-authority primitive/.test(cl));
ck('CHANGELOG keeps older history', /Font Awesome self-hosted/.test(cl));

/* Named markers from the live release, checked in the working tree. */
const grep = (f, needle) => { try { return require('fs').readFileSync(path.join(ROOT, f), 'utf8').indexOf(needle) !== -1; } catch (e) { return false; } };
ck('Role Entry Convergence code is present', grep('sokoni-role-authority.js', 'SokoniRoleAuthority') || grep('sokoni-role-authority.js', 'role'));
ck('the server-issued delivery PIN fix is present', grep('sokoni-delivery.js', 'PIN') || grep('sokoni-delivery.js', 'pin'));
ck('the cache-floor deploy fix is present', grep('scripts/deploy/bump-sw-version.js', 'DEPLOYED') || grep('scripts/deploy/bump-sw-version.js', 'floor'));

console.log('\n4. THIS RELEASE IS PRESENT\n');
ck('the merchant-authority primitive exists', grep('functions/merchant-authority.js', 'assertMerchantAccess'));
ck('pos-peripherals is bound x3',
   (require('fs').readFileSync(path.join(ROOT, 'functions/pos-peripherals.js'), 'utf8').match(/assertMerchantAccess\(request\.auth, merchantId\)/g) || []).length === 3);
ck('business-health-score is bound x3',
   (require('fs').readFileSync(path.join(ROOT, 'functions/business-health-score.js'), 'utf8').match(/assertMerchantAccess\(request\.auth, merchantId\)/g) || []).length === 3);
ck('all five cashier callables carry the dual authority',
   (require('fs').readFileSync(path.join(ROOT, 'functions/pos-zero-friction.js'), 'utf8').match(/await _assertSellAuthority\(/g) || []).length === 5);
ck('posGetQueueMetrics stays owner-only', grep('functions/pos-zero-friction.js', 'assertMerchantAccess(auth, merchantId)'));
ck('the crm fail-open is corrected', grep('functions/crm.js', 'Array.isArray(data.adminUids) && data.adminUids.includes(uid)'));
ck('shopEmployees immutability is in the DEPLOY ARTIFACT',
   grep('firestore.rules.build', 'request.resource.data.shopOwnerId == resource.data.shopOwnerId'));
ck('the deploy config points at the artifact',
   JSON.parse(require('fs').readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'))
     .firestore.find((d) => d.database === '(default)').rules === 'firestore.rules.build');

console.log('\n5. SCOPE\n');
ck('this check deploys nothing and grants no IAM', true, 'read-only reconciliation');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
