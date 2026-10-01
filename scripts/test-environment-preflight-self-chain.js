#!/usr/bin/env node
'use strict';
/* ============================================================================
   environment-preflight — never blocks on its OWN ancestor chain, still blocks on a real peer
   ----------------------------------------------------------------------------
   2026-10-01: inside a real `firebase deploy --only hosting`, the chain is
   firebase deploy → cross-env-shell → node scripts/predeploy-browser-suites.js → this preflight.
   Only {pid, ppid} were excluded, so the wrapper and the deploy itself were reported as a PEER runner
   and a PEER deploy ("Peer browser lock FAIL", "Hosting deploy FAIL") and the release blocked itself
   without running a single suite. Real processes, Windows process table:
     A  a runner launched as an UNRELATED process (not an ancestor) → Peer browser lock FAIL (positive control)
     B  the preflight launched FROM a process whose command line is the browser-suite runner → that
        ancestor is NOT a peer (Peer browser lock PASS)
   Fake scripts live outside the repo (OS temp) so no test runner ever picks them up.
   node scripts/test-environment-preflight-self-chain.js
   ============================================================================ */
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const PREFLIGHT = path.join(ROOT, 'scripts', 'environment-preflight.js');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + String(d).slice(0, 300) : '')); } };
if (process.platform !== 'win32') { console.log('  (skipped: Windows process table only)'); process.exit(0); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sok-preflight-'));
const sdir = path.join(tmp, 'scripts'); fs.mkdirSync(sdir);
const peer = path.join(sdir, 'test-fakepeer-runner.js');
fs.writeFileSync(peer, 'setTimeout(() => {}, 120000);\n');
const wrapper = path.join(sdir, 'predeploy-browser-suites.js');
fs.writeFileSync(wrapper, `const r = require('child_process').spawnSync(process.execPath, [${JSON.stringify(PREFLIGHT)}, '--for', 'browser'], { encoding: 'utf8' });\nprocess.stdout.write(r.stdout || '');\n`);
const peerLine = (out) => (String(out).split(/\r?\n/).find((l) => /Peer browser lock/.test(l)) || '');

console.log('environment-preflight — ancestor chain vs real peer\n');
let child = null;
try {
  child = cp.spawn(process.execPath, [peer], { stdio: 'ignore', detached: false });
  cp.spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},2500)']);   /* let the process table see it */
  const a = cp.spawnSync(process.execPath, [PREFLIGHT, '--for', 'browser'], { encoding: 'utf8', timeout: 120000 });
  ck('A  an unrelated runner process is reported as a peer (Peer browser lock FAIL)', /Peer browser lock\s+FAIL/.test(peerLine(a.stdout)), peerLine(a.stdout));
} finally { if (child) try { child.kill(); } catch (_) {} }
cp.spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1500)']);
const b = cp.spawnSync(process.execPath, [wrapper], { encoding: 'utf8', timeout: 120000 });
ck('B  the browser-suite runner that LAUNCHED the preflight is not a peer (Peer browser lock PASS)', /Peer browser lock\s+PASS/.test(peerLine(b.stdout)), peerLine(b.stdout) || b.stdout);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
