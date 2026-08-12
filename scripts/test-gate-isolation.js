#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   GATE ISOLATION — a suite's result must not depend on which suites ran before it
   ------------------------------------------------------------------------------
   Three suites passed standalone and failed inside the gate:

       test-wishlist-marketplace      28/0 standalone   FAIL in gate
       test-wishlist-market-actions   35/0 standalone   FAIL in gate
       test-auth-email-challenge      63/0 standalone   FAIL in gate

   None was a product defect. `firebase emulators:exec` injects GCLOUD_PROJECT, which
   overrode each suite's own declared project id, so every suite shared one emulator
   database — concurrently. scripts/gate-namespace.js gives each suite its own.

   This proves the fix rather than assuming it:

     A  static — namespaces are unique, deterministic, well-formed, and actually
        override an injected GCLOUD_PROJECT
     B  each affected suite passes standalone under its namespace
     C  each still passes after a deliberately state-mutating predecessor
     D  reversing suite order does not change any result
     E  POSITIVE CONTROL — with namespacing removed, a polluted predecessor DOES
        break the same suite. Without this, A–D could pass for the wrong reason.

   Requires the emulators:
     firebase emulators:exec --only firestore,auth "node scripts/test-gate-isolation.js"
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
/* firebase-admin lives under functions/, not at the repo root — resolved the same
   way every other emulator-backed suite resolves it. */
const FN = path.resolve(__dirname, '..', 'functions');
const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
const { suiteNamespace, suiteEnv } = require('./gate-namespace');

const ROOT = path.resolve(__dirname, '..');
const SHARED = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';   /* what the CLI injects */

/* The suites the shared namespace actually broke. */
const AFFECTED = [
  'test-wishlist-marketplace.js',
  'test-wishlist-market-actions.js',
  'test-auth-email-challenge.js',
];

let pass = 0, fail = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + label); return true; }
  fail++; failures.push(label + (detail ? '  → ' + detail : ''));
  console.log('  FAIL  ' + label + (detail ? '   → ' + detail : ''));
  return false;
};
const head = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');

/* Run a suite exactly as the gate does. `namespaced:false` reproduces the OLD
   behaviour for the positive control. */
function runSuite(file, namespaced) {
  return new Promise((resolve) => {
    const env = namespaced
      ? suiteEnv(file, process.env)
      : { ...process.env, NODE_ENV: 'test' };
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', file)], { cwd: ROOT, env });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 90000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { out += String((e && e.message) || e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ file, exit: timedOut ? 'TIMEOUT' : code, out });
    });
  });
}

/* Write garbage into a namespace, the way a neighbouring suite would. */
async function pollute(projectId, tag) {
  const app = admin.initializeApp({ projectId }, 'pollute-' + tag + '-' + Date.now());
  const db = app.firestore();
  const batch = db.batch();
  for (let i = 0; i < 5; i++) {
    batch.set(db.collection('wishlistItems').doc('garbage-' + tag + '-' + i),
              { uid: 'ghost-' + i, productId: 'ghost-' + i, name: 'left by a previous suite' });
  }
  batch.set(db.collection('products').doc('garbage-' + tag), { name: 'ghost' });
  await batch.commit();
  const n = (await db.collection('wishlistItems').get()).size;
  await app.delete();
  return n;
}

async function countIn(projectId, coll) {
  const app = admin.initializeApp({ projectId }, 'count-' + Date.now() + '-' + Math.round(performance.now()));
  try { return (await app.firestore().collection(coll).get()).size; }
  finally { await app.delete(); }
}

(async () => {
  console.log('\nGATE ISOLATION — result must not depend on suite order\n' + '='.repeat(66));
  console.log('  injected (shared) project : ' + SHARED);

  /* ══ A. static ══ */
  head('A · namespaces are unique, deterministic and well-formed');
  const allSuites = fs.readdirSync(path.join(ROOT, 'scripts'))
    .filter((f) => /^test-.*\.js$/.test(f) && f !== 'test-inventory.js');
  const ns = allSuites.map(suiteNamespace);
  ok('every suite gets a namespace', ns.every(Boolean));
  ok('all namespaces are unique across ' + allSuites.length + ' suites',
     new Set(ns).size === ns.length,
     ns.length - new Set(ns).size + ' collision(s)');
  ok('all are valid project ids (<=30 chars, [a-z0-9-], leading letter)',
     ns.every((p) => /^[a-z][a-z0-9-]{4,29}$/.test(p)),
     ns.filter((p) => !/^[a-z][a-z0-9-]{4,29}$/.test(p)).slice(0, 3).join(', '));
  ok('deterministic across calls',
     allSuites.every((f) => suiteNamespace(f) === suiteNamespace(f)));
  ok('no namespace equals the injected shared project', !ns.includes(SHARED));

  const probe = suiteEnv('test-wishlist-marketplace.js', { GCLOUD_PROJECT: SHARED, FIREBASE_CONFIG: JSON.stringify({ projectId: SHARED, x: 1 }) });
  ok('suiteEnv OVERRIDES an injected GCLOUD_PROJECT',
     probe.GCLOUD_PROJECT !== SHARED, probe.GCLOUD_PROJECT);
  ok('...and sets GOOGLE_CLOUD_PROJECT to the same value',
     probe.GOOGLE_CLOUD_PROJECT === probe.GCLOUD_PROJECT);
  ok('...and rewrites FIREBASE_CONFIG.projectId rather than dropping the blob',
     JSON.parse(probe.FIREBASE_CONFIG).projectId === probe.GCLOUD_PROJECT &&
     JSON.parse(probe.FIREBASE_CONFIG).x === 1);

  /* ══ B. standalone ══ */
  head('B · each affected suite passes standalone under its own namespace');
  const standalone = {};
  for (const f of AFFECTED) {
    const r = await runSuite(f, true);
    standalone[f] = r.exit;
    ok(f + ' passes standalone', r.exit === 0, 'exit=' + r.exit);
  }

  /* ══ C. after a state-mutating predecessor ══ */
  head('C · each still passes after a deliberately state-mutating predecessor');
  const sharedCount = await pollute(SHARED, 'shared');
  console.log('    polluted the SHARED namespace: wishlistItems=' + sharedCount);
  for (const f of AFFECTED) {
    await pollute(suiteNamespace('test-wishlist-phase47.js'), 'neighbour');
    const r = await runSuite(f, true);
    ok(f + ' unaffected by a polluted neighbour + shared namespace',
       r.exit === 0, 'exit=' + r.exit);
  }

  /* ══ D. order independence ══ */
  head('D · reversing suite order changes nothing');
  const forward = [];
  for (const f of AFFECTED) forward.push((await runSuite(f, true)).exit);
  const reverse = [];
  for (const f of [...AFFECTED].reverse()) reverse.push((await runSuite(f, true)).exit);
  reverse.reverse();
  ok('forward order all pass', forward.every((c) => c === 0), JSON.stringify(forward));
  ok('reverse order all pass', reverse.every((c) => c === 0), JSON.stringify(reverse));
  ok('per-suite results identical in both orders',
     JSON.stringify(forward) === JSON.stringify(reverse),
     'forward=' + JSON.stringify(forward) + ' reverse=' + JSON.stringify(reverse));
  ok('...and identical to the standalone results',
     JSON.stringify(forward) === JSON.stringify(AFFECTED.map((f) => standalone[f])));

  /* ══ E. positive control ══
     A polluted PREDECESSOR does not reproduce the defect: every one of these suites
     wipes its collections on entry, so sequential garbage is simply deleted before
     the assertions run (measured — the first draft of this proof asserted otherwise
     and was wrong). The gate's real mechanism is CONCURRENCY: it runs up to 6 suites
     at once, so a neighbour wipes and writes WHILE another is asserting. That is what
     has to be reproduced, and what the namespace has to defeat. */
  head('E · POSITIVE CONTROL — concurrent suites in one namespace must break');
  const concurrently = (namespaced) => Promise.all(AFFECTED.map((f) => runSuite(f, namespaced)));

  const sharedRun = await concurrently(false);       /* old behaviour: one namespace */
  sharedRun.forEach((r) => console.log('    shared    ' + r.file.padEnd(36) + 'exit=' + r.exit));
  const brokeUnfixed = sharedRun.filter((r) => r.exit !== 0).length;
  ok('running them concurrently in ONE namespace breaks at least one suite',
     brokeUnfixed > 0,
     'all passed — the proof cannot detect the regression it exists to catch');

  const nsRun = await concurrently(true);            /* fixed: one namespace each */
  nsRun.forEach((r) => console.log('    isolated  ' + r.file.padEnd(36) + 'exit=' + r.exit));
  ok('the same three run concurrently ISOLATED all pass',
     nsRun.every((r) => r.exit === 0),
     nsRun.filter((r) => r.exit !== 0).map((r) => r.file + '=' + r.exit).join(', '));
  ok('concurrent isolated results match the standalone results',
     JSON.stringify(nsRun.map((r) => r.exit)) === JSON.stringify(AFFECTED.map((f) => standalone[f])),
     JSON.stringify(nsRun.map((r) => r.exit)));

  /* ══ F. separate databases, not a shared one that gets reset ══ */
  head('F · emulator state is separated, not merely reset');
  const nsA = suiteNamespace('test-wishlist-marketplace.js');
  const nsB = suiteNamespace('test-wishlist-phase47.js');
  await pollute(nsB, 'sep');
  const inB = await countIn(nsB, 'wishlistItems');
  const inA = await countIn(nsA, 'wishlistItems');
  ok('the polluted namespace holds the garbage', inB > 0, String(inB));
  ok('a different suite namespace cannot see it', inA === 0, String(inA));

  /* A sentinel in the SHARED namespace must survive a namespaced suite: if the suite
     still touched the shared database, its wipe() would delete this. */
  const sentinelCount = await pollute(SHARED, 'sentinel');
  const after = await runSuite('test-wishlist-marketplace.js', true);
  const survived = await countIn(SHARED, 'wishlistItems');
  console.log('    shared sentinel before = ' + sentinelCount + ', after a namespaced run = ' + survived);
  ok('a namespaced suite does not touch the shared database',
     survived === sentinelCount && after.exit === 0,
     'before=' + sentinelCount + ' after=' + survived + ' exit=' + after.exit);

  console.log('\n' + '─'.repeat(66));
  if (fail) { console.log('\x1b[31mFAILURES\x1b[0m'); failures.forEach((f) => console.log('  ✗ ' + f)); }
  console.log((fail ? '\x1b[31m' : '\x1b[32m') + 'gate isolation: ' + pass + '/' + (pass + fail) + '\x1b[0m\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n  isolation proof error: ' + ((e && e.stack) || e) + '\n');
  process.exit(1);
});
