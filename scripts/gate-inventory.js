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

   READING A FAILURE
   A non-zero exit here surfaces on Windows as
       Error: spawn node scripts\gate-inventory.js ENOENT
   which reads as a missing script and is not one — cross-spawn synthesises that
   message over a real refusal. Check docs/release-gates/<commit>.json and the
   true exit code first. See docs/DEPLOYMENT_GUIDE.md.
   ──────────────────────────────────────────────────────────────────────────── */
'use strict';
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

/* ── SCOPE ──────────────────────────────────────────────────────────────────
   This gate needs the Firestore emulator (JDK 21). Sitting unconditionally in
   the hosting predeploy chain, it blocked EVERY release — including
   documentation-only ones — for a reason unrelated to what was changing.

   The protection is unchanged; only its scope narrows. It still runs, and still
   blocks, whenever inventory-related code changes.

   FAIL-CLOSED. The gate is skipped only when we can positively PROVE that no
   inventory path changed. If the baseline cannot be established — no network,
   no git, deployed commit not present locally — the gate RUNS. Absence of
   evidence is never treated as evidence of safety.

   Override: SOKONI_FORCE_INVENTORY_GATE=1 always runs it.                    */

/* Documentation cannot change runtime inventory behaviour, and a file merely
   NAMED for inventory (docs/INVENTORY_SUBTYPE_DESIGN.md) would otherwise keep
   every docs-only release blocked — the exact bottleneck this scoping removes.
   Narrow and evidence-based: markdown is not executed. */
const NEVER_TRIGGERS = [/\.md$/i, /^docs\//i];

const INVENTORY_PATHS = [
  /inventory/i,                 /* deliberately broad: any path naming inventory */
  /^functions\/shared\//,
  /^functions\/index\.js$/,     /* re-exports the inventory Cloud Functions */
  /^firestore\.rules$/,
  /^firestore\.indexes\.json$/,
  /* The client Firestore provider. pos-inventory.js reads canonical stock through this
     shim's query/snapshot wrappers, so a change here can break inventory sync without
     touching any path named "inventory" — which is exactly how a dropped docChanges()
     silently killed the POS stock listeners while this gate skipped itself. */
  /^firebase\.js$/,
];

/** Files changed between what is LIVE and what is about to ship.
 *  Returns null when the baseline cannot be established — null means RUN. */
function changedFiles() {
  const git = (args) =>
    execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

  let live;
  try {
    /* What is actually deployed, not what happens to be merged. */
    const out = execFileSync(
      'curl', ['-s', '--max-time', '10', 'https://mysokoni.co.ke/version.json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    live = String(JSON.parse(out).commit || '').trim();
  } catch (e) {
    return null;
  }
  if (!/^[0-9a-f]{7,40}$/.test(live)) return null;

  try {
    git(['cat-file', '-e', live + '^{commit}']);   /* is the live commit present locally? */
    const committed = git(['diff', '--name-only', live, 'HEAD']).split('\n');
    const dirty = git(['status', '--porcelain']).split('\n').map((l) => l.slice(3));
    return committed.concat(dirty).map((f) => f.trim()).filter(Boolean);
  } catch (e) {
    return null;
  }
}

if (process.env.SOKONI_FORCE_INVENTORY_GATE !== '1') {
  const files = changedFiles();

  if (files === null) {
    console.log('[gate-inventory] baseline unknown — running the gate (fail-closed).');
  } else {
    const hits = files
      .filter((f) => !NEVER_TRIGGERS.some((re) => re.test(f)))
      .filter((f) => INVENTORY_PATHS.some((re) => re.test(f)));
    if (hits.length === 0) {
      console.log(
        '[gate-inventory] SKIPPED — none of ' + files.length +
        ' changed file(s) touch inventory. The gate remains mandatory for inventory releases.'
      );
      process.exit(0);
    }
    console.log(
      '[gate-inventory] inventory paths changed (' + hits.slice(0, 4).join(', ') +
      (hits.length > 4 ? ', +' + (hits.length - 4) + ' more' : '') + ') — running the gate.'
    );
  }
}

/* ── RUN IT WITH THE EMULATOR IT SAYS IT NEEDS ──────────────────────────────
   The SCOPE note above states plainly that this gate needs the Firestore emulator, and
   then this line used to spawn test-inventory.js WITHOUT one. In the hosting predeploy
   chain there is no emulator, so ~12 emulator-backed cart/checkout suites failed or timed
   out and the hook exited 1 — aborting the deploy. Measured: the same cart family run under
   `firebase emulators:exec` is 15/15 PASS. The suites were never the problem; the execution
   model was.

   Launching the emulator here keeps them BLOCKING, which is the point. The alternative —
   teaching each suite to skip — would convert a large part of the release's coverage into
   ENV at exactly the moment it matters most, on a release that changes firestore.rules and
   Cloud Functions.

   FAIL-CLOSED, consistent with the doctrine above: if the emulator cannot start, this gate
   does NOT fall through to an unguarded run. Absence of evidence is never evidence of
   safety, so it exits non-zero and says why. */
/* ── ENVIRONMENT-AWARE, NOT UNCONDITIONALLY SELF-EMULATING ──────────────────
   Two callers, opposite environments:

     DEPLOY HOOK          no emulator exists  → this gate MUST start one
     AUTHORITATIVE GATE   already inside      → this gate MUST NOT start another
                          emulators:exec

   The first version started one unconditionally. Inside the authoritative gate that
   NESTED a second Firestore/Auth emulator on the same ports while test-inventory ran the
   whole population in the inner one: 16 suites timed out at 150s and two died with raw
   Node stack output, on a machine that minutes earlier measured deep-switch at 41.6s
   twice with 43ms variance. That is an environment failure, not variance — and I built it.

   Detection reads the REAL emulator environment rather than a flag of our own invention,
   because FIRESTORE_EMULATOR_HOST is what the Admin SDK and the suites themselves obey.
   If it is set, an emulator is already serving us and starting another is the bug. */
const INSIDE_EMULATOR = !!process.env.FIRESTORE_EMULATOR_HOST;

if (INSIDE_EMULATOR) {
  console.log('[gate-inventory] emulator already present at ' + process.env.FIRESTORE_EMULATOR_HOST +
              ' — running the gate directly (no nested emulators:exec).');
  const direct = spawnSync(process.execPath, [path.join(__dirname, 'test-inventory.js'), '--gate'],
    { stdio: 'inherit' });
  if (direct.error) {
    console.error('[gate-inventory] failed to run test-inventory.js:', direct.error.message);
    process.exit(1);
  }
  process.exit(direct.status == null ? 1 : direct.status);
}

const EMU_PROJECT = process.env.SOKONI_GATE_PROJECT || 'sokoni-inventory-gate';

/* ONE command string, not an argv array. With shell:true an argv array is re-joined and
   re-split by the shell, so the inner `--gate` arrived as an option to `firebase` itself
   ("error: unknown option '--gate'") rather than staying inside the quoted script. Quoting
   the inner command in a single string keeps it one argument to emulators:exec. */
const cmd = 'firebase emulators:exec --only firestore,auth --project ' + EMU_PROJECT +
            ' "node scripts/test-inventory.js --gate"';

const res = spawnSync(cmd, {
  stdio: 'inherit',
  shell: true,                         /* Windows resolves firebase.cmd only via the shell */
  cwd: path.resolve(__dirname, '..'),  /* so scripts/test-inventory.js resolves */
  env: { ...process.env, CLOUDSDK_PYTHON: process.env.CLOUDSDK_PYTHON || 'bundled' },
});

if (res.error || res.status === null) {
  console.error('\n[gate-inventory] could not run the gate under the Firestore emulator.');
  console.error('  ' + ((res.error && res.error.message) || 'emulator exited abnormally'));
  console.error('  This gate needs the Firebase CLI and JDK 21. It fails CLOSED rather than');
  console.error('  running the inventory suites without the emulator they require — an');
  console.error('  unguarded run would report failures that are not defects.');
  process.exit(1);
}

/* Propagate the gate's verdict verbatim. A spawn error (res.status === null)
   must fail closed, not silently pass. */
if (res.error) {
  console.error('[gate-inventory] failed to run test-inventory.js:', res.error.message);
  process.exit(1);
}
process.exit(res.status == null ? 1 : res.status);
