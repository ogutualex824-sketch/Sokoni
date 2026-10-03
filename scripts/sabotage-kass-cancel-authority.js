#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = path.join(__dirname, '..', 'functions', 'index.js');
const O = fs.readFileSync(F, 'utf8');
process.on('exit', () => fs.writeFileSync(F, O));
const M = [
  ['paid evidence ignored', '          if (_paid(o) || !["pending", "pending_payment"].includes(st)) {', '          if (!["pending", "pending_payment"].includes(st)) {', 'K-3'],
  ['confirmed cancellable again', '          if (_paid(o) || !["pending", "pending_payment"].includes(st)) {', '          if (!["pending", "pending_payment", "confirmed"].includes(st)) {', 'K-1'],
  ['ownership skipped', '          if (!owns) return { error: "You can only cancel your own orders." };', '', 'K-6'],
];
let c = 0;
for (const [l, a, b, row] of M) {
  if (O.split(a).length !== 2) { console.log('  ANCHOR x' + (O.split(a).length - 1) + '  ' + l); continue; }
  fs.writeFileSync(F, O.replace(a, b));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'test-kass-cancel-authority.js')], { encoding: 'utf8', timeout: 300000 });
  fs.writeFileSync(F, O);
  const f = (r.stdout.match(/^\s+FAIL \S+/mg) || []).map((x) => x.trim().split(' ')[1]);
  const ok = r.status === 1 && f.includes(row); if (ok) c++;
  console.log('  ' + (ok ? 'CAUGHT' : 'MISSED') + '  ' + l + '  <- ' + f.join(','));
}
console.log('\nSABOTAGE: ' + c + '/' + M.length);
process.exit(c === M.length ? 0 : 1);
