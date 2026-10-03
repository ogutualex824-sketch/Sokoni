#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = path.join(__dirname, '..', 'functions', 'disputes.js');
const O = fs.readFileSync(F, 'utf8');
process.on('exit', () => fs.writeFileSync(F, O));
const M = [
  ['hold not written', "    txn.update(db.collection('orders').doc(orderId), {", "    if (false) txn.update(db.collection('orders').doc(orderId), {", 'H-3'],
  ['hold never lifted', "        disputeOpen: false, hasDispute: false,", "", 'H-6'],
  ['re-open does not re-hold', "      await db.collection('orders').doc(orderId).update({ disputeStatus: action, disputeOpen: true, hasDispute: true })", "      await db.collection('orders').doc(orderId).update({ disputeStatus: action })", 'H-8'],
];
let c = 0;
for (const [l, a, b, row] of M) {
  if (O.split(a).length !== 2) { console.log('  ANCHOR x' + (O.split(a).length - 1) + '  ' + l); continue; }
  fs.writeFileSync(F, O.replace(a, b));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'test-dispute-payout-hold.js')], { encoding: 'utf8', timeout: 120000 });
  fs.writeFileSync(F, O);
  const f = (r.stdout.match(/^\s+FAIL \S+/mg) || []).map((x) => x.trim().split(' ')[1]);
  const ok = r.status === 1 && f.includes(row); if (ok) c++;
  console.log('  ' + (ok ? 'CAUGHT' : 'MISSED') + '  ' + l + '  <- ' + f.join(','));
}
console.log('\nSABOTAGE: ' + c + '/' + M.length);
process.exit(c === M.length ? 0 : 1);
