#!/usr/bin/env node
/* test-parcel-rail-guard.js — proves the emulator-only guard at the top of test-parcel-rail.js.
 *
 * test-parcel-rail.js deletes every collection on startup. This suite runs it as a CHILD process
 * under each unsafe environment and asserts, for every case:
 *   · exit code 3 and the "REFUSED test-parcel-rail: <reason>" message on stderr;
 *   · ZERO module loads after the guard — in particular firebase-admin is never requested
 *     (a tracer installed with `-r` records every Module._load the suite makes).
 * A positive control runs the same child with a SAFE environment and asserts the guard lets it
 * through and the suite then DOES ask for firebase-admin — proving the tracer can see that
 * request, so its silence in the refusal cases is evidence, not blindness. In the positive
 * control the tracer THROWS on that request, so nothing is ever reached even then; the
 * block-admin preload (NODE_OPTIONS) is inherited as a second wall. No emulator, no network.
 *
 *   node scripts/test-parcel-rail-guard.js
 */
'use strict';

/* ── tracer mode: loaded into the child with `-r` ─────────────────────────────────────────── */
if (process.env.PARCEL_GUARD_TRACER === '1' && require.main !== module) {
  const Module = require('module');
  const inner = Module._load;
  const loads = [];
  Module._load = function (req, parent, isMain) {
    if (isMain) return inner.apply(this, arguments);           // the suite file itself
    loads.push(String(req));
    if (/^firebase-admin(\/|$)/.test(String(req)) || /[\\/]node_modules[\\/]firebase-admin[\\/]/.test(String(req))) {
      process.stderr.write('[tracer] FIREBASE_ADMIN_REQUESTED ' + req + '\n');
      throw new Error('[tracer] firebase-admin requested — blocked by the guard test');
    }
    return inner.apply(this, arguments);
  };
  process.on('exit', () => { process.stderr.write('[tracer] LOADS=' + JSON.stringify(loads) + '\n'); });
  return;
}

const path = require('path');
const { spawnSync } = require('child_process');
const SUITE = path.join(__dirname, 'test-parcel-rail.js');
const SELF = __filename;

const SCRUB = ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT',
  'FIREBASE_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS', 'FUNCTIONS_DIR'];
const SAFE = { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', GCLOUD_PROJECT: 'demo-parcel' };
const PROD = 'sokoni-aeb26';

function run(extra) {
  const env = Object.assign({}, process.env);
  SCRUB.forEach((k) => { delete env[k]; });
  Object.entries(extra).forEach(([k, v]) => { if (v === undefined) delete env[k]; else env[k] = v; });
  env.PARCEL_GUARD_TRACER = '1';
  const r = spawnSync(process.execPath, ['-r', SELF, SUITE], { env, encoding: 'utf8', timeout: 30000 });
  const err = r.stderr || '';
  const m = /\[tracer\] LOADS=(\[.*\])/.exec(err);
  return { status: r.status, out: (r.stdout || '') + err, loads: m ? JSON.parse(m[1]) : null,
           adminAsked: /\[tracer\] FIREBASE_ADMIN_REQUESTED|\[block-admin\] BLOCKED require of firebase-admin/.test(err) };
}

let pass = 0, fail = 0;
const ck = (label, ok, got) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '   [got ' + JSON.stringify(got) + ']')); ok ? pass++ : fail++; };

const without = (k) => { const o = Object.assign({}, SAFE); o[k] = undefined; return o; };
const CASES = [
  ['G1  no emulator env at all',                         { GCLOUD_PROJECT: 'demo-parcel' },                                      /FIRESTORE_EMULATOR_HOST is not set/],
  ['G2  Firestore emulator only (no Auth emulator)',      without('FIREBASE_AUTH_EMULATOR_HOST'),                                 /FIREBASE_AUTH_EMULATOR_HOST is not set/],
  ['G3  Auth emulator only (no Firestore emulator)',      without('FIRESTORE_EMULATOR_HOST'),                                     /FIRESTORE_EMULATOR_HOST is not set/],
  ['G4  Firestore host is a remote endpoint',             Object.assign({}, SAFE, { FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com:443' }), /FIRESTORE_EMULATOR_HOST is not localhost/],
  ['G5  Auth host is a LAN address',                      Object.assign({}, SAFE, { FIREBASE_AUTH_EMULATOR_HOST: '10.0.0.5:9099' }),            /FIREBASE_AUTH_EMULATOR_HOST is not localhost/],
  ['G6  host merely STARTS with localhost',               Object.assign({}, SAFE, { FIRESTORE_EMULATOR_HOST: 'localhost.evil.example:8080' }),  /FIRESTORE_EMULATOR_HOST is not localhost/],
  ['G7  host with no port',                               Object.assign({}, SAFE, { FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1' }),                /FIREBASE_AUTH_EMULATOR_HOST is not localhost/],
  ['G8  no project id at all',                            without('GCLOUD_PROJECT'),                                              /no project id is set/],
  ['G9  GCLOUD_PROJECT is the production project',        Object.assign({}, SAFE, { GCLOUD_PROJECT: PROD }),                     /GCLOUD_PROJECT "sokoni-aeb26" is not a demo-\* project/],
  ['G10 GOOGLE_CLOUD_PROJECT production beside a demo GCLOUD_PROJECT', Object.assign({}, SAFE, { GOOGLE_CLOUD_PROJECT: PROD }), /GOOGLE_CLOUD_PROJECT "sokoni-aeb26" is not a demo-\* project/],
  ['G11 FIREBASE_CONFIG.projectId is production',         Object.assign({}, SAFE, { FIREBASE_CONFIG: JSON.stringify({ projectId: PROD }) }),    /FIREBASE_CONFIG\.projectId "sokoni-aeb26" is not a demo-\* project/],
  ['G12 FIREBASE_CONFIG is a path (unverifiable)',        Object.assign({}, SAFE, { FIREBASE_CONFIG: 'C:/somewhere/firebase.json' }),           /FIREBASE_CONFIG is not inline JSON/],
  ['G13 GOOGLE_APPLICATION_CREDENTIALS set (all else safe)', Object.assign({}, SAFE, { GOOGLE_APPLICATION_CREDENTIALS: 'C:/keys/sa.json' }),   /GOOGLE_APPLICATION_CREDENTIALS is set/],
  ['G14 project id "demo" without the dash',              Object.assign({}, SAFE, { GCLOUD_PROJECT: 'demoparcel' }),             /is not a demo-\* project/],
];

console.log('\nCERT — test-parcel-rail.js emulator-only guard (child processes, tracer-instrumented)\n');
for (const [label, env, why] of CASES) {
  const r = run(env);
  ck(label + ' → exit 3', r.status === 3, r.status);
  ck(label + ' → REFUSED message ' + why, /REFUSED test-parcel-rail: /.test(r.out) && why.test(r.out), r.out.slice(0, 300));
  ck(label + ' → tracer ran and saw ZERO module loads (firebase-admin never required)', Array.isArray(r.loads) && r.loads.length === 0 && !r.adminAsked, r.loads);
}

console.log('\n── positive control: a SAFE environment passes the guard and the tracer SEES the admin request ──');
{
  const r = run(Object.assign({}, SAFE));
  ck('P1  safe env is NOT refused', !/REFUSED test-parcel-rail/.test(r.out), r.out.slice(0, 300));
  ck('P2  past the guard the suite DOES request firebase-admin (the tracer is not blind)', r.adminAsked, r.out.slice(0, 400));
  ck('P3  …and loads modules (path first)', Array.isArray(r.loads) && r.loads[0] === 'path', r.loads && r.loads.slice(0, 5));
  ck('P4  …and is stopped there (non-zero exit, nothing reached)', r.status !== 0, r.status);
}
{
  const r = run(Object.assign({}, SAFE, { FIRESTORE_EMULATOR_HOST: 'localhost:8080', FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099',
    FIREBASE_CONFIG: JSON.stringify({ projectId: 'demo-parcel' }), GOOGLE_CLOUD_PROJECT: 'demo-parcel' }));
  ck('P5  localhost spelling + matching demo FIREBASE_CONFIG/GOOGLE_CLOUD_PROJECT pass the guard', !/REFUSED test-parcel-rail/.test(r.out) && r.adminAsked, r.out.slice(0, 300));
}

console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed');
process.exit(fail ? 1 : 0);
