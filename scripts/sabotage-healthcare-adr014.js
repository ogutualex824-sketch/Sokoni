#!/usr/bin/env node
/* sabotage-healthcare-adr014.js — every mutant must turn test-healthcare-adr014-e2e.js RED (exit 1).
   One per consumer re-adds a "compatibility" read of the retired healthProviders registry (the fallback the owner
   forbade); the rest break the exception / identity / discovery guards. Mutates files in place, ALWAYS restores.
   A crash (exit 2) or a dead anchor is NOT a catch. Run on a quiescent tree. */
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..'), FN = path.join(ROOT, 'functions');
const LEGACY = (idExpr) => `(await (async () => { const _l = await db().collection('healthProviders').doc(String(${idExpr})).get(); return _l.exists && _l.data().status === 'active' ? Object.assign({ status: 'active', healthcare: { category: 'clinician', source: 'application' } }, _l.data()) : null; })())`;
const M = [
  ['functions/healthcare-hub.js', 'profile falls back to healthProviders',
    '  const p = await HD.readProvider(db(), providerId);', `  const p = (await HD.readProvider(db(), providerId)) || ${LEGACY('providerId')};`],
  ['functions/healthcare-hub.js', 'clinical identity falls back to healthProviders',
    '  if (!HD.canOperate(prov)) throw', "  const _lg = await t.get(db().collection('healthProviders').doc(String(uid)));\n  if (!HD.canOperate(prov) && !(_lg.exists && _lg.data().status === 'active')) throw"],
  ['functions/healthcare-hub.js', 'directory merges healthProviders',
    "  let providers = await HD.listDirectory(db(), { category, limit: Math.min(50, parseInt(limit) || 24) });",
    "  let providers = await HD.listDirectory(db(), { category, limit: Math.min(50, parseInt(limit) || 24) });\n  (await db().collection('healthProviders').where('status', '==', 'active').limit(50).get()).docs.forEach((d) => providers.push(Object.assign({ providerId: d.id }, d.data())));"],
  ['functions/healthcare-hub.js', 'search merges healthProviders',
    '  const rows = await HD.listDirectory(db(), { limit: 60 });',
    "  const rows = await HD.listDirectory(db(), { limit: 60 });\n  (await db().collection('healthProviders').where('status', '==', 'active').limit(60).get()).docs.forEach((d) => rows.push(Object.assign({ providerId: d.id }, d.data())));"],
  ['functions/healthcare-directory.js', 'clinical identity ignores the healthcare record',
    "  if (!p || !p.healthcare || !['application', 'admin'].includes(p.healthcare.source)) return false;", '  if (!p) return false;'],
  ['functions/healthcare-directory.js', 'clinical identity ignores suspension',
    '  return p.suspended !== true && p.deactivated !== true && p.banned !== true;', '  return true;'],
  ['functions/healthcare-directory.js', 'discovery ignores classification',
    '  return elig.eligible && HCAT.isCategory(elig.category) && elig.category === HCAT.categoryOf(p);', "  return !!p && ['active', 'approved'].includes(String(p.status || '')) && !p.suspended;"],
  ['functions/application-lifecycle.js', 'health loses the category exception',
    "      if (_role !== 'health' && _projectsToProviders(cur, _role)) {", '      if (_projectsToProviders(cur, _role)) {'],
  ['functions/application-lifecycle.js', 'the exception leaks to every role',
    "      if (_role !== 'health' && _projectsToProviders(cur, _role)) {", '      if (false) {'],
  ['functions/application-lifecycle.js', 'health is delegated again (no providers projection)',
    "const DELEGATED_ROLES = { event_organizer: 'events' };", "const DELEGATED_ROLES = { health: 'healthProviders', event_organizer: 'events' };"],
  ['functions/discovery-eligibility.js', 'the index admits the legacy registry',
    "const DEINDEXED = Object.freeze(['mechanics', 'lawyers', 'healthProviders',", "const DEINDEXED = Object.freeze(['mechanics', 'lawyers',"],
  ['sokoni-firestore-search.js', 'browser search scans healthProviders again',
    "  /* healthProviders — REMOVED (ADR-014, owner 2026-10-04).", "  { col: 'healthProviders', tab: 'professionals', scan: 150 },\n  /* healthProviders — REMOVED (ADR-014, owner 2026-10-04)."],
  ['functions/scripts/algolia-backfill.js', 'backfill indexes deindexed collections',
    "    if (DEINDEXED.includes(entry.col)) {", '    if (false) {'],
];
let caught = 0, bad = 0;
for (const [rel, label, a, b] of M) {
  const F = path.join(ROOT, rel); const ORIG = fs.readFileSync(F, 'utf8');
  const n = ORIG.split(a).length - 1;
  if (n !== 1) { console.log('  ANCHOR x' + n + '  ' + label); bad++; continue; }
  try {
    fs.writeFileSync(F, ORIG.replace(a, b));
    const r = spawnSync(process.execPath, [path.join(__dirname, 'test-healthcare-adr014-e2e.js')], { encoding: 'utf8', timeout: 240000 });
    const fails = (r.stdout.match(/^\s+FAIL\s+(\S+)/mg) || []).map((l) => l.trim().split(/\s+/)[1]);
    if (r.status === 1) { caught++; console.log('  CAUGHT  ' + label + '  ← ' + fails.join(',')); }
    else { bad++; console.log('  ' + (r.status === 2 ? 'CRASH ' : 'MISSED') + '  ' + label + '  (exit ' + r.status + ')'); }
  } finally { fs.writeFileSync(F, ORIG); }
}
console.log('\nSABOTAGE: ' + caught + '/' + M.length + ' caught, ' + bad + ' missed/anchor/crash');
process.exit(bad ? 1 : 0);
