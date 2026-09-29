#!/usr/bin/env node
/* ============================================================================
   scripts/run-evidence-firestore-cert.js
   ============================================================================
   Starts a throwaway Firestore emulator and runs the adapter proof against it.

   WHY A RUNNER RATHER THAN A DOCUMENTED COMMAND
   ----------------------------------------------
   Three things have to be true at once for the proof to be both valid and safe,
   and a command in a README is not a mechanism:

     * the emulator must NOT be on the repository's default port. Several agents
       work this repository in parallel; binding 8080 would either collide with
       someone else's emulator or, worse, quietly attach to it and run the proof
       against a database somebody else is mutating.
     * the project id must be the dedicated cert project, so that even a
       misconfiguration cannot address production.
     * the emulator must be destroyed afterwards, and only the one this script
       started. `emulators:exec` owns that lifecycle; killing emulator processes
       by name would take out another agent's run.

   It uses its own config, generated in a temp directory, so the repository's
   firebase.json is neither read nor modified.
   ============================================================================ */
'use strict';

const { spawn, spawnSync } = require('child_process');
const net  = require('net');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = 'sokoni-evidence-cert';
const SUITE = 'scripts/test-integration-evidence-firestore.js';

/* Deliberately away from 8080. */
const CANDIDATE_PORTS = [8091, 8092, 8093, 8094, 8095, 8096, 8097, 8098, 8099];

function freePort (port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

(async function main () {
  let port = null;
  for (const p of CANDIDATE_PORTS) {
    /* eslint-disable no-await-in-loop */
    if (await freePort(p)) { port = p; break; }
  }
  if (!port) {
    console.error('  No free port in ' + CANDIDATE_PORTS[0] + '-' +
      CANDIDATE_PORTS[CANDIDATE_PORTS.length - 1] + '. Another run may be in flight.');
    console.error('  NOT falling back to 8080 — that is the shared default.');
    process.exit(2);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sokoni-evidence-cert-'));
  const cfg = path.join(dir, 'firebase.json');
  fs.writeFileSync(cfg, JSON.stringify({
    emulators: {
      firestore: { port, host: '127.0.0.1' },
      ui: { enabled: false },
      singleProjectMode: true,
    },
  }, null, 2));

  console.log('  emulator   127.0.0.1:' + port + '   project ' + PROJECT);
  console.log('  config     ' + cfg + '  (repository firebase.json untouched)');
  console.log('  suite      ' + SUITE + '\n');

  const env = Object.assign({}, process.env, {
    GCLOUD_PROJECT: PROJECT,
    GOOGLE_CLOUD_PROJECT: PROJECT,
    /* Cleared so the suite's own guard reads what emulators:exec sets, and a
       stale value in this shell cannot satisfy it. */
    FIRESTORE_EMULATOR_HOST: '',
  });

  /* shell: true is required, not preferred. Node 24 on Windows refuses to spawn
     a .cmd shim directly (EINVAL), and the Firebase CLI is exactly that. With a
     shell the arguments go through a command line, so every path is quoted here
     rather than trusted to contain no spaces — `cfg` lives under the user's temp
     directory, which on Windows routinely does. */
  const q = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';
  const cmd = [
    process.platform === 'win32' ? 'firebase.cmd' : 'firebase',
    'emulators:exec', '--only', 'firestore',
    '--project', q(PROJECT),
    '--config', q(cfg),
    q('node ' + SUITE),
  ].join(' ');

  const child = spawn(cmd, { cwd: ROOT, env, stdio: 'inherit', shell: true });
  child.on('error', (e) => {
    console.error('\n  Could not start the Firebase CLI: ' + e.message);
    process.exit(2);
  });
  child.on('exit', (code) => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    /* The emulator's data is in-memory and dies with it; nothing is exported.
       The exit code is the SUITE's, passed through by emulators:exec. */
    console.log('\n  runner exit ' + code + '  (temp config removed)');
    process.exit(code === null ? 1 : code);
  });
  void spawnSync;
})();
