#!/usr/bin/env node
/* Deliberate breakages of the Legal L1/L2 server; each must turn its NAMED row red in test-legal-profile. */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const M = [
  ['protected-field guard removed', 'legal-hub.js', '  const tried = PROTECTED.filter((k) => k in d);\n  if (tried.length) {', '  const tried = [];\n  if (tried.length) {', 'U2'],
  ['resubmit allowed from any status', 'legal-hub.js', "if (as.data().status !== 'info_requested') throw", "if (false) throw", 'U3'],
  ['unrated advocate shown with a default rating', 'legal-hub.js', 'rating: rated ? p.rating : null,', 'rating: rated ? p.rating : 5,', 'P2'],
  ['unknown practice area ignored (shows everyone)', 'legal-hub.js', "if (area) providers = TAX.isArea(area) ? providers.filter(p => p.practiceAreas.includes(area)) : [];", "if (area && TAX.isArea(area)) providers = providers.filter(p => p.practiceAreas.includes(area));", 'P1'],
  ['firm application not typed for AdminOS', 'legal-hub.js', "applicationType: entityType === 'firm' ? 'law_firm' : 'lawyer',", "applicationType: 'lawyer',", 'R2'],
  ['legacy criminal_law guessed onto litigation', 'shared/legal-taxonomy.js', 'criminal_law: null,', "criminal_law: 'litigation-support',", 'T3'],
  ['public shows REQUESTED specialist areas', 'legal-hub.js', 'specialistAreas: TAX.specialistConfirmedOf(p),', 'specialistAreas: TAX.specialistRequestedOf(p),', 'SP1'],
  ['specialist confirmed without the advocate request', 'legal-verification.js', "if (confirm && TAX.specialistRequestedOf(lp).indexOf(area) < 0) throw", 'if (false) throw', 'SP2'],
];
let caught = 0, missed = 0;
for (const [name, file, a, b, row] of M) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lgps-'));
  cp.execSync('cp -r "' + path.join(ROOT, 'functions').split(path.sep).join('/') + '" "' + d.split(path.sep).join('/') + '/functions"', { shell: 'bash' });
  const f = path.join(d, 'functions', file);
  let s = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  if (s.split(a).length !== 2) { console.log('  MISSED  ' + name + ' (anchor ' + (s.split(a).length - 1) + 'x — UNPROVEN)'); missed++; continue; }
  fs.writeFileSync(f, s.replace(a, () => b));
  const o = cp.spawnSync(process.execPath, [path.join(__dirname, 'test-legal-profile.js')], { env: Object.assign({}, process.env, { FN_DIR: path.join(d, 'functions') }), encoding: 'utf8' });
  const out = o.stdout || '';
  const red = new RegExp('^  FAIL ' + row + ' ', 'm').test(out) && !/CRASH/.test(out);
  console.log('  ' + (red ? 'CAUGHT' : 'MISSED') + '  ' + name + ' → ' + row);
  red ? caught++ : missed++;
}
console.log('\nSABOTAGE: ' + caught + '/' + M.length + ' caught');
process.exit(missed ? 1 : 0);
