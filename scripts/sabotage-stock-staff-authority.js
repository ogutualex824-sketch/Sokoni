#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = (f) => path.join(__dirname, '..', 'functions', f);
const M = [
  ['merchant-identity.js', "  cashier: ['sell', 'openShift'],", "  cashier: ['sell', 'openShift', 'adjustStock'],", 'S-3'],
  ['merchant-inventory.js', '      const _staffOnProduct = _staffOk && p.sellerUid === _staffOwnerUid;', '      const _staffOnProduct = _staffOk;', 'S-6b'],
  ['merchant-identity.js', "  inventory: { role: 'inventory', label: 'Inventory' },", '', 'S-1'],
  ['merchant-identity.js', "  inventory: ['adjustStock'],", '  inventory: [],', 'S-1'],
];
let c = 0;
for (const [f, a, b, row] of M) {
  const O = fs.readFileSync(F(f), 'utf8');
  if (O.split(a).length !== 2) { console.log('  ANCHOR  ' + f); continue; }
  fs.writeFileSync(F(f), O.replace(a, b));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'test-stock-staff-authority.js')], { encoding: 'utf8' });
  fs.writeFileSync(F(f), O);
  const x = (r.stdout.match(/^\s+FAIL \S+/mg) || []).map((y) => y.trim().split(' ')[1]);
  const ok = r.status === 1 && x.includes(row); if (ok) c++;
  console.log('  ' + (ok ? 'CAUGHT' : 'MISSED') + '  ' + f + ': ' + a.trim().slice(0, 50) + '  <- ' + x.join(','));
}
console.log('\nSABOTAGE: ' + c + '/' + M.length);
process.exit(c === M.length ? 0 : 1);
