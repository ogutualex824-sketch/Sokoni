#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = path.join(__dirname, '..', 'functions', 'pos-marketplace-sync.js');
const O = fs.readFileSync(F, 'utf8');
process.on('exit', () => fs.writeFileSync(F, O));
const M = [
  ['order ownership skipped', "if (_order && !_elevated && ![_order.sellerUid", "if (false && ![_order.sellerUid", 'H-1'],
  ['rider job ownership skipped', "if (_prSnap.exists && !_elevated && String", "if (false && String", 'S-4'],
  ['restores any shop stock', "        if (!_pd || String(_pd.sellerUid || _pd.uid || '') !== String(sellerId)) continue;", "        if (!_pd) continue;", 'S-1'],
  ['mirror creates orders', "        if (_order) { try { await _oRef.update({ status: 'ready_for_pickup'", "        { try { await _oRef.set({ status: 'ready_for_pickup'", 'S-2'],
];
let c = 0;
for (const [l, a, b, row] of M) {
  if (O.split(a).length !== 2) { console.log('  ANCHOR ' + l); continue; }
  fs.writeFileSync(F, O.replace(a, b));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'test-cnc-order-ownership.js')], { encoding: 'utf8' });
  fs.writeFileSync(F, O);
  const f = (r.stdout.match(/FAIL \S+/g) || []).map((x) => x.split(' ')[1]);
  const ok = r.status === 1 && f.includes(row); if (ok) c++;
  console.log('  ' + (ok ? 'CAUGHT' : 'MISSED') + '  ' + l + '  <- ' + f.join(','));
}
console.log('\nSABOTAGE: ' + c + '/' + M.length);
process.exit(c === M.length ? 0 : 1);
