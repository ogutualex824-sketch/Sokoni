/* test-etims-release-gate.js — gap 17: the eTIMS release gate must never silently read production,
 * and must never report "0 records" as a validated pass.
 *
 * PROVES
 *   default run      offline: firebase-admin is NEVER loaded (a preload hook throws if it is), exit 0,
 *                    integrity VALIDATED on fixture data only after the positive controls fire
 *   explicit live    --live without --project / --env is refused before anything is loaded
 *   verdicts         VALIDATED / NO_DATA / VIOLATIONS / UNREADABLE are distinct; NO_DATA is not a pass
 *   read-only        the live handle refuses add / set / update / delete / doc / batch / transaction
 *
 *   node scripts/test-etims-release-gate.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const G = require('./etims-release-gate.js');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 160) + ']' : '')); ok ? pass++ : fail++; };

(async () => {
  console.log('\n── argument contract ──');
  ck('no flags → fixture mode', G.parseArgs([]).mode === 'fixture');
  ck('--live without --project is refused', !!G.parseArgs(['--live', '--env=sandbox']).error);
  ck('--live without --env is refused', !!G.parseArgs(['--live', '--project=sokoni-sandbox']).error);
  ck('--live with an unknown env is refused', !!G.parseArgs(['--live', '--project=sokoni-sandbox', '--env=prod']).error);
  const ok = G.parseArgs(['--live', '--project=sokoni-sandbox', '--env=sandbox']);
  ck('--live --project --env → explicit live target', ok.mode === 'live' && ok.project === 'sokoni-sandbox' && ok.env === 'sandbox');

  console.log('\n── verdicts ──');
  const F = G.fixtures();
  const v = async (colls, o) => (await G.scanIntegrity(G.memDb(colls, o))).state;
  ck('clean data → VALIDATED', (await v(F.clean)) === 'VALIDATED');
  ck('zero records → NO_DATA (not VALIDATED)', (await v({})) === 'NO_DATA');
  ck('duplicate invoice number → VIOLATIONS', (await v(F.dup)) === 'VIOLATIONS');
  ck('tampered audit chain → VIOLATIONS', (await v(F.tampered)) === 'VIOLATIONS');
  ck('accepted invoice without audit → VIOLATIONS', (await v(F.missing)) === 'VIOLATIONS');
  ck('unreadable collection → UNREADABLE (fails closed, was silently skipped)', (await v(F.clean, { failOn: 'etimsInvoices' })) === 'UNREADABLE');

  console.log('\n── read-only handle ──');
  const writes = [];
  const fakeDb = { collection: () => ({ get: async () => ({ docs: [] }), add: () => writes.push('add'), doc: () => ({ set: () => writes.push('set') }) }), batch: () => writes.push('batch'), runTransaction: () => writes.push('txn') };
  const ro = G.readOnly(fakeDb);
  const refused = ['add', 'set', 'update', 'delete', 'doc'].every((op) => { try { ro.collection('x')[op]({}); return false; } catch (e) { return /read-only/.test(e.message); } })
    && ['batch', 'runTransaction', 'doc'].every((op) => { try { ro[op](); return false; } catch (e) { return /read-only/.test(e.message); } });
  ck('every write surface throws; nothing reached the underlying db', refused && writes.length === 0);
  ck('reads still work', Array.isArray((await ro.collection('etimsInvoices').get()).docs));

  console.log('\n── the default run never touches a project ──');
  const hook = path.join(os.tmpdir(), `no-firebase-admin-${process.pid}.js`);
  fs.writeFileSync(hook, "const M=require('module');const o=M._load;M._load=function(r,...a){if(/firebase-admin/.test(r)){console.log('HOOK-TRIPPED firebase-admin');process.exit(97);}return o.call(this,r,...a);};");
  const env = { ...process.env }; delete env.FIRESTORE_EMULATOR_HOST;
  const r = spawnSync(process.execPath, ['-r', hook, path.join('scripts', 'etims-release-gate.js')], { cwd: ROOT, encoding: 'utf8', env, timeout: 300000 });
  const out = (r.stdout || '') + (r.stderr || '');
  ck('default run exits 0 without loading firebase-admin', r.status === 0 && !/HOOK-TRIPPED/.test(out), `exit=${r.status}`);
  ck('…and says the integrity was validated on FIXTURE data with the controls firing', /Integrity scan \[fixture: VALIDATED\]/.test(out) && /control: zero records is NO_DATA/.test(out) && /no project was contacted/.test(out));
  const bad = spawnSync(process.execPath, ['-r', hook, path.join('scripts', 'etims-release-gate.js'), '--live'], { cwd: ROOT, encoding: 'utf8', env, timeout: 60000 });
  ck('--live with no target exits non-zero BEFORE loading anything', bad.status === 64 && !/HOOK-TRIPPED/.test(bad.stdout + bad.stderr), `exit=${bad.status}`);
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'etims-release-gate.js'), 'utf8');
  ck('no hardcoded project id remains in the gate', !/sokoni-aeb26/.test(src));
  ck('the live path prints PROJECT / ENVIRONMENT / MODE READ-ONLY', /PROJECT {6}\$\{project\}/.test(src) && /ENVIRONMENT {2}\$\{env\}/.test(src) && /MODE {9}READ-ONLY/.test(src));
  try { fs.unlinkSync(hook); } catch (_) {}

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
