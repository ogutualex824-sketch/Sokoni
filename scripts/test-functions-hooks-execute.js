/* test-functions-hooks-execute.js — the functions predeploy gates must actually RUN.
 *
 *   node scripts/test-functions-hooks-execute.js       (no network)
 *
 * 2026-10-01: on this Windows machine firebase-tools runs each hook as
 *   "<node>" "<cross-env-shell.js>" "<command with \" escaped>"   (shell: true)
 * and the quoted form  node "$RESOURCE_DIR/../scripts/X.js"  is mangled into a spawn of 'scripts\X.js"' — the script
 * never executes. Two K13 functions deploys reported "Finished running predeploy script" with ZERO hook output
 * (the safety guard always prints a banner), i.e. the gates silently did not run. The hosting chain already uses
 * the plain relative form (cwd = project root), which a faithful replica of runCommand proves executes.
 *
 * This suite pins: every functions predeploy hook is the relative form, names a script that exists, and the
 * replica launcher actually executes that form (a marker script writes a file).
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (!ok && d !== undefined ? '   [' + String(d).slice(0, 200) + ']' : '')); ok ? pass++ : fail++; };

const fj = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
const hooks = [].concat(fj.functions).flatMap((c) => c.predeploy || []);
console.log('\nFUNCTIONS PREDEPLOY HOOKS — they must execute');
console.log('='.repeat(70));
ck('there are functions predeploy hooks', hooks.length >= 5, hooks.length);
ck('no hook uses the quoted $RESOURCE_DIR form (it never executes on Windows)', !hooks.some((h) => /\$RESOURCE_DIR/.test(h)), hooks.filter((h) => /RESOURCE_DIR/.test(h)));
for (const h of hooks) {
  const m = /^node (scripts\/[A-Za-z0-9_\/.-]+\.js)$/.exec(h);
  ck('relative form and the script exists: ' + h, !!m && fs.existsSync(path.join(ROOT, m[1])), h);
}
ck('the payment safety guard and the syntax gate are both in the chain',
   hooks.includes('node scripts/deploy/guard-functions-safety.js') && hooks.includes('node scripts/predeploy-syntax-gate.js'));

/* Replica of firebase-tools runCommand, run against a scratch project with a marker script. */
let ce = null;
try { ce = path.resolve(require.resolve(path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'firebase-tools', 'node_modules', 'cross-env')), '..', 'bin', 'cross-env-shell.js'); } catch (_) { ce = null; }
if (!ce || !fs.existsSync(ce)) {
  console.log('  UNPROVEN  firebase-tools cross-env not found on this machine — launcher replica skipped (not a pass)');
} else {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'hookprobe-'));
  fs.mkdirSync(path.join(proj, 'scripts')); fs.mkdirSync(path.join(proj, 'functions'));
  const mark = path.join(proj, 'ran.txt');
  fs.writeFileSync(path.join(proj, 'scripts', 'marker.js'), "require('fs').appendFileSync(" + JSON.stringify(mark) + ", process.argv[2] + '\\n');");
  const run = (command) => {
    const t = '"' + process.execPath + '" "' + ce + '" "' + command.replace(/"/g, '\\"') + '"';
    cp.spawnSync(t, [], { cwd: proj, shell: true, env: Object.assign({}, process.env, { RESOURCE_DIR: path.join(proj, 'functions') }), stdio: 'ignore', timeout: 30000 });
    return fs.existsSync(mark) && fs.readFileSync(mark, 'utf8').includes(command.split(' ').pop());
  };
  ck('replica launcher: the relative form EXECUTES the script', run('node scripts/marker.js relative'));
  const quotedRan = run('node "$RESOURCE_DIR/../scripts/marker.js" quoted');
  console.log('  info  replica launcher: quoted $RESOURCE_DIR form executed = ' + quotedRan + ' (false on the 2026-10-01 machine)');
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
