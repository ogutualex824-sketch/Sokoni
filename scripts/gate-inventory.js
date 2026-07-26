#!/usr/bin/env node
/* ────────────────────────────────────────────────────────────────────────────
   gate-inventory.js — no-argument wrapper for the test-inventory deploy gate.

   WHY THIS EXISTS
   firebase.json ran the gate as a predeploy command WITH an argument:
       "node scripts/test-inventory.js --gate"
   On Windows, the Firebase CLI predeploy runner spawned that whole string as a
   single executable path and it failed immediately with ENOENT
   (spawn "node scripts\test-inventory.js --gate"), blocking EVERY deploy — while
   the five sibling predeploy commands (all no-argument "node scripts/x.js") ran
   fine. The differentiator was the trailing "--gate" argument.

   This wrapper carries the argument itself, so firebase.json can invoke a plain
   no-argument command ("node scripts/gate-inventory.js") that matches the working
   pattern. The gate still runs identically — test-inventory.js --gate — and its
   exit code is propagated unchanged, so the check is preserved, not bypassed.
   ──────────────────────────────────────────────────────────────────────────── */
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

const res = spawnSync(
  process.execPath,
  [path.join(__dirname, 'test-inventory.js'), '--gate'],
  { stdio: 'inherit' }
);

/* Propagate the gate's verdict verbatim. A spawn error (res.status === null)
   must fail closed, not silently pass. */
if (res.error) {
  console.error('[gate-inventory] failed to run test-inventory.js:', res.error.message);
  process.exit(1);
}
process.exit(res.status == null ? 1 : res.status);
