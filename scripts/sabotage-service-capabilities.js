'use strict';
/* Sabotage proof for Slice 0 (service-capability engine). CAUGHT only when the NAMED row FAILS in a run that reached its
   RESULT line; missing anchor or crash → UNPROVEN. Files restored after every mutation.
     node scripts/sabotage-service-capabilities.js      (repo QUIESCENT — it edits functions/ in this tree) */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const W = path.join(__dirname, '..', 'functions', 'business-workspace.js');
const S = path.join(__dirname, '..', 'functions', 'shared', 'service-capabilities.js');
const ORIG = { [W]: fs.readFileSync(W, 'utf8'), [S]: fs.readFileSync(S, 'utf8') };
const M = [
  [S, 'invalid approvals counted', "if (!x || x.valid !== true) { ignored.push", "if (!x) { ignored.push", 'A-2'],
  /* NOT a mutation: removing modulesFor's isCapability guard is an EQUIVALENT mutant — an unknown string finds no
     MODULES_OF entry either, so A-7 holds with or without it (defence in depth, recorded, not counted). */
  [W, 'validity verdict bypassed (every application valid)', 'REM.decisionValidity(a, String(uid), (d) => adminMap[d] === true, presentKinds)', "{ valid: true, why: 'forced' }", 'B-5'],
  [W, 'unbuilt module shown as working', "w.modules[key] = def.implemented ? { state: STATE.AVAILABLE, reason: null } : { state: STATE.NOT_IMPLEMENTED, reason: def.why || 'NOT_BUILT' };", 'w.modules[key] = { state: STATE.AVAILABLE, reason: null };', 'B-2'],
  [W, 'capability overrides a LOCKED / plan state', 'if (!def || !cur || cur.state !== STATE.NOT_APPLICABLE) continue;', 'if (!def || !cur) continue;', 'B-8'],
  [W, 'restaurant lane fix reverted', "(BCAT.SELLER_CATEGORIES.includes(category) || ROUTE_OF[category] === 'merchant-v2.html') ? 'products' : 'services'", "BCAT.SELLER_CATEGORIES.includes(category) ? 'products' : 'services'", 'B-6'],
  [W, 'merchant modules not attached', '    w.merchantModules = mm;', '    void mm;', 'B-6'],
  [W, 'capabilities not attached to routed answers', '  return withCap(_svc(w));\n}', '  return withCap(w);\n}', 'B-1'],
];
const rows = [];
try {
  for (const [file, name, find, repl, row] of M) {
    const o = ORIG[file];
    if (o.split(find).length !== 2) { rows.push([name, row, 'anchor not found / not unique', 'UNPROVEN']); continue; }
    fs.writeFileSync(file, o.replace(find, repl));
    const r = spawnSync(process.execPath, [path.join(__dirname, 'test-service-capabilities.js')], { encoding: 'utf8', timeout: 180000 });
    fs.writeFileSync(file, o);
    const out = (r.stdout || '') + (r.stderr || '');
    const done = /RESULT: \d+ passed, \d+ failed/.test(out);
    const failed = new RegExp('^\\s*FAIL ' + row.replace(/-/g, '\\-') + '\\s', 'm').test(out);
    rows.push([name, row, !done ? 'crash / no RESULT' : (failed ? row + ' FAILED' : row + ' passed'), !done ? 'UNPROVEN' : (failed ? 'CAUGHT' : 'MISSED')]);
  }
} finally { for (const f of Object.keys(ORIG)) fs.writeFileSync(f, ORIG[f]); }
console.log('\nSabotage — service capabilities (Slice 0)\n');
console.log('  MUTATION                                         | EXPECTED   | ACTUAL            | RESULT');
rows.forEach((x) => console.log('  ' + x[0].padEnd(49) + '| ' + (x[1] + ' FAILS').padEnd(11) + '| ' + x[2].padEnd(18) + '| ' + x[3]));
const caught = rows.filter((x) => x[3] === 'CAUGHT').length;
const restored = Object.keys(ORIG).every((f) => fs.readFileSync(f, 'utf8') === ORIG[f]);
console.log('\nSABOTAGE: ' + caught + '/' + rows.length + ' caught' + (restored ? '' : '   !! FILES NOT RESTORED'));
process.exit(caught === rows.length && restored ? 0 : 1);
