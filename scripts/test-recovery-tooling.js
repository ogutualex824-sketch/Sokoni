#!/usr/bin/env node
'use strict';
/* ============================================================================
   Recovery tooling — the unsafe rollback is retired; recover.js can only re-point traffic
   ----------------------------------------------------------------------------
     A  scripts/deploy/rollback.js refuses to run (exit 2) and performs no git or deploy step
     B  scripts/deploy/recover.js: no git, no `firebase deploy`, no `run services update`, no
        --to-latest; traffic moves only via update-traffic --to-revisions=<rev>=100; hosting
        release and traffic move sit behind --execute (+ --confirm=<svc> for functions); the
        Artifact-Registry image check is a precondition
   The live read-only runs (hosting --list, dry-run plans, the image check refusing
   webhookintasend-00064-lag and passing 00067-kog) are recorded in docs/BLUE_GREEN_RECOVERY.md.
   node scripts/test-recovery-tooling.js
   ============================================================================ */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 300) : '')); } };

console.log('Recovery tooling\n');
const rb = spawnSync(process.execPath, [path.join(ROOT, 'scripts/deploy/rollback.js')], { encoding: 'utf8', cwd: ROOT });
ck('A1 rollback.js exits 2 and says it is retired', rb.status === 2 && /RETIRED/.test(rb.stderr), { status: rb.status, err: rb.stderr.slice(0, 120) });
const rbSrc = fs.readFileSync(path.join(ROOT, 'scripts/deploy/rollback.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
ck('A2 rollback.js contains no executable git / deploy / spawn', !/spawnSync|execSync|child_process|require\(/.test(rbSrc));

const rc = fs.readFileSync(path.join(ROOT, 'scripts/deploy/recover.js'), 'utf8');
const code = rc.replace(/\/\*[\s\S]*?\*\//g, '');
ck('B1 recover.js never runs git, a firebase deploy, `run services update` or --to-latest',
  !/['"]git['"]|firebase deploy|'services', 'update'[^-]|to-latest/.test(code));
ck('B2 traffic moves only by named revision (update-traffic --to-revisions=<rev>=100)', /'update-traffic', svc[\s\S]{0,120}'--to-revisions=' \+ to \+ '=100'/.test(code));
ck('B3 the traffic move requires --execute AND --confirm=<service>', /if \(!EXECUTE \|\| opt\('confirm'\) !== svc\)/.test(code));
ck('B4 the hosting release requires --execute', /if \(!EXECUTE\) \{ console\.log\('DRY RUN/.test(code));
ck('B5 the Artifact Registry image check is a precondition', /target image still exists in Artifact Registry/.test(code) && /'artifacts', 'docker', 'images', 'describe'/.test(code));
ck('B6 the procedure document exists and marks hosting recovery UNPROVEN until drilled', /tooled but UNPROVEN/.test(fs.readFileSync(path.join(ROOT, 'docs/BLUE_GREEN_RECOVERY.md'), 'utf8')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
