#!/usr/bin/env node
/* Sabotage for scripts/test-food-gate1-approval.js — each mutation breaks ONE Gate 1 guarantee in
 * functions/application-lifecycle.js; the suite must FAIL (exit 1) for every one. A crash (exit 2) is not a catch.
 * The file is restored after every mutation (and on any exit).   node scripts/sabotage-food-gate1.js */
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = path.join(__dirname, '..', 'functions', 'application-lifecycle.js');
const ORIG = fs.readFileSync(F, 'utf8');
const restore = () => fs.writeFileSync(F, ORIG);
process.on('exit', restore); process.on('SIGINT', () => { restore(); process.exit(130); });

const M = [
  ['no approval evidence on sellers', `  batch.set(sellerRef, Object.assign({
    uid: String(uid),
    status: 'active', active: true,
    approvedAt: _ts(),`, `  batch.set(sellerRef, Object.assign({
    uid: String(uid),
    status: 'active', active: true,`],
  ['businesses gets ownerId', `    uid: String(uid), shopId,
    status: 'active',`, `    uid: String(uid), shopId, ownerId: String(uid),
    status: 'active',`],
  ['approval publishes (no hold)', `const held = (d) => (d ? {} : { _noIndex: true, discovery: 'HELD', createdAt: _ts() });`, `const held = (d) => (d ? {} : { searchable: true, isPublic: true, createdAt: _ts() });`],
  ['ownership check removed', `    if (owner && String(owner) !== String(uid)) {`, `    if (false) {`],
  ['category fallback removed', `    if (cat) return Object.assign({}, r, { role: 'seller', by: r.by + '+category', category: cat });`, `    if (false) return r;`],
  ['any role re-filed', `  if (r.role === 'provider') {
    const cat`, `  if (r.role) {
    const cat`],
  ['shopId sanitising not refusing', `  if (rawShop && !isPlaceholderShopId(rawShop) && !/^[A-Za-z0-9_-]{1,128}$/.test(rawShop)) {`, `  if (false) {`],
  ['admin classification overwritten', `  const adminSet = !!(priorB && priorB.source === 'admin');`, `  const adminSet = false;`],
  ['reinstatement does not restore', `    if (!d || d.suspendedBy !== 'application_lifecycle') return {};`, `    return {};`],
  /* anchor follows Education E1 (2cdc1b3), which extended this line with the education type */
  ['application role not stamped', `      ...(role && app.role !== role ? { role, roleResolvedBy: eduType ? 'education:' + eduType : _resolved.by } : {}),`, ``],
  ['category role ignored at decision', `|| /\\+category$/.test(_resolved.by)`, ``],
  ['seller delegated again', `    } else if (role === 'seller') {`, `    } else if (role === 'seller-x') {`],
  ['suspension leaves seller discoverable', `      batch.set(ref, Object.assign({ status: 'suspended', searchable: false, isPublic: false,`, `      batch.set(ref, Object.assign({ status: 'suspended',`],
  ['message claims search', '? `${app.name || \'Your business\'} is approved on SOKONI. Your business workspace is ready — set it up before customers can find you.`', '? `${app.name || \'Your business\'} is now live on SOKONI and customers can find you in search.`'],
  ['existing seller renamed', `     seller0 && seller0.name ? {} : { name, nameLower: name.toLowerCase() },`, `     { name, nameLower: name.toLowerCase() },`],
];
let caught = 0, missed = 0, bad = 0;
for (const [label, a, b] of M) {
  const n = ORIG.split(a).length - 1;
  if (n !== 1) { console.log('  ANCHOR x' + n + '  ' + label); bad++; continue; }
  fs.writeFileSync(F, ORIG.replace(a, b));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'test-food-gate1-approval.js')], { encoding: 'utf8', timeout: 180000 });
  restore();
  const fails = (r.stdout.match(/^\s+FAIL .*$/mg) || []).map((l) => l.trim().split(' ')[1]);
  if (r.status === 1) { caught++; console.log('  CAUGHT  ' + label + '  ← ' + fails.join(',')); }
  else { r.status === 2 ? bad++ : missed++; console.log('  ' + (r.status === 2 ? 'CRASH ' : 'MISSED') + '  ' + label + '  (exit ' + r.status + ')'); }
}
console.log('\nSABOTAGE: ' + caught + '/' + M.length + ' caught, ' + missed + ' missed, ' + bad + ' anchor/crash');
process.exit(caught === M.length ? 0 : 1);
