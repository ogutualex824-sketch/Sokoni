#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = path.join(__dirname, '..', 'functions', 'index.js');
const O = fs.readFileSync(F, 'utf8');
process.on('exit', () => fs.writeFileSync(F, O));
const M = [
  ['buyer runs settlement reversal', '  if (orderId && isAdminCaller) {', '  if (orderId) {', ['R-1', 'R-3']],
  ['buyer moves escrow', '  if (escrowRef && escrow && isAdminCaller) {', '  if (escrowRef && escrow) {', ['R-4']],
  ['pending request eats ceiling', ' && d.data().requiresApproval !== true)', ')', ['R-5']],
  ['request not flagged', '    requiresApproval: !isAdminCaller,\n    status: "pending",', '    status: "pending",', ['R-2']],
];
let c = 0;
for (const [label, a, b, rows] of M) {
  if (O.split(a).length !== 2) { console.log('  ANCHOR ' + label); continue; }
  fs.writeFileSync(F, O.replace(a, b));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'test-refund-approval-authority.js')], { encoding: 'utf8', timeout: 300000 });
  fs.writeFileSync(F, O);
  const f = (r.stdout.match(/^\s+FAIL \S+/mg) || []).map((l) => l.trim().split(' ')[1]);
  const ok = r.status === 1 && rows.some((x) => f.includes(x)); if (ok) c++;
  console.log('  ' + (ok ? 'CAUGHT' : 'MISSED') + '  ' + label + '  <- ' + f.join(','));
}
console.log('\nSABOTAGE: ' + c + '/' + M.length);
process.exit(c === M.length ? 0 : 1);
