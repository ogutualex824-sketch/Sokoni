#!/usr/bin/env node
/* Sabotage for test-nav-dispatch-authority.js — CAUGHT only when the named row fails (exit 1, not a crash). */
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = path.join(__dirname, '..', 'functions', 'navigation.js');
const O = fs.readFileSync(F, 'utf8');
process.on('exit', () => fs.writeFileSync(F, O));
const M = [
  ['anyone may dispatch', "if (!_isAdmin && !_isSeller) throw", "if (false) throw", ['X-3']],
  ['seller may pick a rider', "if (manualRiderId && !_isAdmin) throw", "if (false) throw", ['D-1']],
  ['unpaid deliverable', "  if (!_navOrderPaid(order)) return { ok: false, why: 'order_unpaid' };", "", ['C-4']],
  ['terminal deliverable', "  if (_NAV_TERMINAL.includes(String(order.status || '').toLowerCase())) return { ok: false, why: 'order_terminal' };", "", ['C-5']],
  ['rider match skipped', "if (trip.dispatchAuthority !== 'admin' && !_navOrderRiders(order)", "if (false && !_navOrderRiders(order)", ['C-3']],
  ['authority not required', "  if (!trip.dispatchedBy || !['admin', 'seller'].includes(trip.dispatchAuthority)) return { ok: false, why: 'trip_not_authorised' };", "", ['C-2b']],
  ['status update delivers again', "  };\n  if (orderStatusMap[status] && trip.orderId) {", "    completed: 'delivered',\n  };\n  if (orderStatusMap[status] && trip.orderId) {", ['U-1']],
  ['POD unguarded', "  if (allDone && trip.orderId && _podMay.ok) {", "  if (allDone && trip.orderId) {", ['P-1']],
];
let c = 0;
for (const [label, a, b, rows] of M) {
  if (O.split(a).length !== 2) { console.log('  ANCHOR  ' + label); continue; }
  fs.writeFileSync(F, O.replace(a, b));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'test-nav-dispatch-authority.js')], { encoding: 'utf8', timeout: 120000 });
  fs.writeFileSync(F, O);
  const f = (r.stdout.match(/^\s+FAIL \S+/mg) || []).map((l) => l.trim().split(' ')[1]);
  const ok = r.status === 1 && rows.some((x) => f.includes(x)); if (ok) c++;
  console.log('  ' + (ok ? 'CAUGHT' : 'MISSED') + '  ' + label + '  <- ' + f.join(','));
}
console.log('\nSABOTAGE: ' + c + '/' + M.length);
process.exit(c === M.length ? 0 : 1);
