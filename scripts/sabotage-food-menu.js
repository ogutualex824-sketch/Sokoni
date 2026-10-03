#!/usr/bin/env node
/* Sabotage for scripts/test-food-menu.js. Each mutation breaks ONE Gate 2 guarantee; it counts as CAUGHT only when the
 * suite exits 1 AND a named expected row fails (attributable), never on a crash (exit 2). Files are restored after
 * every mutation and on exit.   node scripts/sabotage-food-menu.js */
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const FM = path.join(__dirname, '..', 'functions', 'food-menu.js');
const SC = path.join(__dirname, '..', 'functions', 'shared', 'service-capabilities.js');
const ORIG = { [FM]: fs.readFileSync(FM, 'utf8'), [SC]: fs.readFileSync(SC, 'utf8') };
const restore = () => { for (const [f, s] of Object.entries(ORIG)) fs.writeFileSync(f, s); };
process.on('exit', restore); process.on('SIGINT', () => { restore(); process.exit(130); });

const M = [
  ['cashier may edit the menu', FM, `const MENU_WRITERS = Object.freeze(['owner', 'manager']);`, `const MENU_WRITERS = Object.freeze(['owner', 'manager', 'cashier']);`, ['S-6']],
  ['module gate bypassed', FM, `  if (!w || w.state !== 'AVAILABLE' || w.route !== 'merchant-v2.html') {`, `  if (false) {`, ['S-4', 'S-4b']],
  ['module key ignored', FM, `  if (!m || m.state !== 'AVAILABLE') {`, `  if (false) {`, ['S-5']],
  ['item ownership not checked', FM, `  if (String(p.shopId || '') !== ctx.shopId || String(p.sellerUid || '') !== ctx.ownerUid) {`, `  if (false) {`, ['S-2', 'S-16']],
  ['price not validated', FM, `  if (typeof n !== 'number' || !isFinite(n) || n <= 0 || n > MAX_PRICE || Math.round(n * 100) !== n * 100) {`, `  if (false) {`, ['P-1']],
  ['browser fields spread into the product', FM, `    await ref.set(Object.assign({}, fields, {
      menu: Object.assign({}, prevMenu,`, `    await ref.set(Object.assign({}, data, fields, {
      menu: Object.assign({}, prevMenu,`, ['D-3']],
  ['archive deletes', FM, `  await ref.set(Object.assign(SELL.tombstonePatch(), {`, `  await ref.delete(); await ref.set(Object.assign(SELL.tombstonePatch(), {`, ['M-10']],
  ['plan limit skipped', FM, `  if (!lim || lim.allowed !== true) {`, `  if (false) {`, ['S-12']],
  ['public shows drafts', FM, `String(x.p.status || '') === 'active' && x.p.isVisible !== false && !_archived(x.p)`, `!_archived(x.p)`, ['PUB-1']],
  ['public ignores the shop gate', FM, `  if (!elig.eligible) return Object.assign(none, { reason: 'SHOP_NOT_PUBLIC' });`, ``, ['PUB-5']],
  ['availability skips the canonical flag', FM, `    outOfStock: av !== 'available',`, ``, ['M-7']],
  ['created published', FM, `    status: 'draft',                     /* never published by creation`, `    status: 'active',                     /* never published by creation`, ['M-2']],
  ['section-in-use not checked', FM, `    if (used.length) throw _fail(`, `    if (false) throw _fail(`, ['S-11']],
  ['kitchen claims to work', SC, `  kitchen:  { label: 'Kitchen',  implemented: false, why: 'FOOD_ORDERS_PENDING' },`, `  kitchen:  { label: 'Kitchen',  implemented: true },`, ['CAP-2']],
  ['cashier cannot mark sold out', FM, `const AVAILABILITY_WRITERS = Object.freeze(['owner', 'manager', 'cashier']);`, `const AVAILABILITY_WRITERS = Object.freeze(['owner', 'manager']);`, ['S-7']],
  ['public leaks the owner', FM, `    id, name: p.name || '', description: p.description || '', price: p.price,`, `    id, sellerUid: p.sellerUid, name: p.name || '', description: p.description || '', price: p.price,`, ['PUB-3']],
];
let caught = 0, other = 0;
for (const [label, file, a, b, rows] of M) {
  const n = ORIG[file].split(a).length - 1;
  if (n !== 1) { console.log('  ANCHOR x' + n + '  ' + label); other++; continue; }
  fs.writeFileSync(file, ORIG[file].replace(a, b));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'test-food-menu.js')], { encoding: 'utf8', timeout: 180000 });
  restore();
  const fails = (r.stdout.match(/^\s+FAIL \S+/mg) || []).map((l) => l.trim().split(' ')[1]);
  const attributable = rows.some((x) => fails.includes(x));
  if (r.status === 1 && attributable) { caught++; console.log('  CAUGHT  ' + label + '  ← ' + fails.join(',')); }
  else { other++; console.log('  ' + (r.status === 2 ? 'CRASH ' : 'MISSED') + '  ' + label + '  (exit ' + r.status + ', failed: ' + fails.join(',') + '; expected ' + rows.join('/') + ')'); }
}
console.log('\nSABOTAGE: ' + caught + '/' + M.length + ' caught by their named row, ' + other + ' not');
process.exit(caught === M.length ? 0 : 1);
