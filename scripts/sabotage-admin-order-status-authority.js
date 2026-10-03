#!/usr/bin/env node
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = path.join(__dirname, '..', 'functions', 'admin-os.js');
const O = fs.readFileSync(F, 'utf8');
process.on('exit', () => fs.writeFileSync(F, O));
const M = [
  ['paid allowed', "  if (to === 'paid') return { ok: false, reason: 'PAYMENT_AUTHORITY_ONLY' };", "", 'A-1'],
  ['delivered without evidence', "  if (to === 'delivered') return o.deliveredAt ? { ok: true } : { ok: false, reason: 'DELIVERY_EVIDENCE_REQUIRED' };", "  if (to === 'delivered') return { ok: true };", 'A-2'],
  ['refunded without evidence', "    return (st === 'REFUNDED' || st === 'REVERSED' || String(o.refundStatus || '').toLowerCase() === 'completed') ? { ok: true } : { ok: false, reason: 'REFUND_EVIDENCE_REQUIRED' };", "    return { ok: true };", 'A-3'],
  ['complete undelivered', "    if (fromN !== 'delivered') return { ok: false, reason: 'NOT_DELIVERED', from };", "", 'A-4'],
  ['complete during dispute', "    if (o.disputeOpen === true || o.hasDispute === true) return { ok: false, reason: 'DISPUTE_OPEN' };", "", 'A-6'],
  ['cancel paid', "  if (to === 'cancelled') return _orderPaid(o) ? { ok: false, reason: 'PAID_CANCEL_IS_A_REFUND' } : { ok: true };", "  if (to === 'cancelled') return { ok: true };", 'A-7'],
  ['backwards allowed', "    if (!FL.canAdvance(from || 'pending', to)) return { ok: false, reason: 'BACKWARDS', from };", "", 'A-9'],
  ['terminal reopened', "  if (FL.isTerminal(from)) return { ok: false, reason: 'TERMINAL', from };", "", 'A-10b'],
  ['write without transaction verdict', "    if (!v.ok || v.noop) return v;", "    if (v.noop) return v;", 'A-1'],
];
let c = 0;
for (const [l, a, b, row] of M) {
  if (O.split(a).length !== 2) { console.log('  ANCHOR x' + (O.split(a).length - 1) + '  ' + l); continue; }
  fs.writeFileSync(F, O.replace(a, b));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'test-admin-order-status-authority.js')], { encoding: 'utf8', timeout: 120000 });
  fs.writeFileSync(F, O);
  const f = (r.stdout.match(/^\s+FAIL \S+/mg) || []).map((x) => x.trim().split(' ')[1]);
  const ok = r.status === 1 && f.includes(row); if (ok) c++;
  console.log('  ' + (ok ? 'CAUGHT' : 'MISSED') + '  ' + l + '  <- ' + f.join(',') + (ok ? '' : ' (exit ' + r.status + ', expected ' + row + ')'));
}
console.log('\nSABOTAGE: ' + c + '/' + M.length);
process.exit(c === M.length ? 0 : 1);
