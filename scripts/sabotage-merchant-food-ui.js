#!/usr/bin/env node
/* Sabotage for scripts/test-merchant-food-ui.js — counted CAUGHT only when the named row fails (exit 1, not a crash).
 *   node scripts/sabotage-merchant-food-ui.js */
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = path.join(__dirname, '..', 'sokoni-merchant-food.js'), H = path.join(__dirname, '..', 'merchant-v2.html');
const ORIG = { [F]: fs.readFileSync(F, 'utf8'), [H]: fs.readFileSync(H, 'utf8') };
const restore = () => { for (const [f, s] of Object.entries(ORIG)) fs.writeFileSync(f, s); };
process.on('exit', restore);
const M = [
  ['name not escaped', F, `'<div class="fm-name">' + esc(it.name) + '</div>'`, `'<div class="fm-name">' + it.name + '</div>'`, ['U-4']],
  ['success toast before the server answers', F, `      return call(op, Object.assign({ itemId: id }, payload)).then(function () {
        toast(okMsg); return call('load');`, `      toast(okMsg); return call(op, Object.assign({ itemId: id }, payload)).then(function () {
        return call('load');`, ['U-8']],
  ['staff may change availability', F, `var AVAIL_EDITORS = ['owner', 'manager', 'cashier'];`, `var AVAIL_EDITORS = ['owner', 'manager', 'cashier', 'staff'];`, ['U-11']],
  ['kitchen shows zero counts', F, `'</span><span>—</span></b><small>'`, `'</span><span>0</span></b><small>'`, ['U-12']],
  ['menu loads before the gate', F, `        if (!w || w.state !== 'AVAILABLE' || w.route !== 'merchant-v2.html') {`, `        if (false) {`, ['U-1']],
  ['food links visible by default', H, `    ['menu', 'drinks', 'kitchen'].forEach(function (id) { nav.querySelectorAll('.nav-item[data-route="' + id + '"]').forEach(function (b) { b.hidden = true; }); });`, ``, ['W-2']],
  ['archived items listed', F, `        if (it.status === 'archived') return false;`, ``, ['U-3']],
];
let caught = 0;
for (const [label, file, a, b, rows] of M) {
  if (ORIG[file].split(a).length !== 2) { console.log('  ANCHOR  ' + label); continue; }
  fs.writeFileSync(file, ORIG[file].replace(a, b));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'test-merchant-food-ui.js')], { encoding: 'utf8', timeout: 60000 });
  restore();
  const fails = (r.stdout.match(/^\s+FAIL \S+/mg) || []).map((l) => l.trim().split(' ')[1]);
  const ok = r.status === 1 && rows.some((x) => fails.includes(x));
  if (ok) caught++;
  console.log('  ' + (ok ? 'CAUGHT' : 'MISSED') + '  ' + label + '  ← ' + fails.join(',') + (ok ? '' : ' (exit ' + r.status + ', expected ' + rows.join('/') + ')'));
}
console.log('\nSABOTAGE: ' + caught + '/' + M.length + ' caught by their named row');
process.exit(caught === M.length ? 0 : 1);
