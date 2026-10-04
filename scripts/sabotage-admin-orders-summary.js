#!/usr/bin/env node
/* Deliberate breaks for scripts/test-admin-orders-summary.js (owner gate 6, 2026-10-04).
 * Each mutation is applied to a TEMPORARY COPY of functions/admin-os.js (functions/.aossab-<pid>.js, removed on exit)
 * and loaded through AOS_MODULE — the real file is never edited, so a crash cannot leave the tree sabotaged.
 * A break counts as CAUGHT only when the suite exits 1 AND the named row is among the failures. */
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const F = path.join(__dirname, '..', 'functions', 'admin-os.js');
const TMP = path.join(__dirname, '..', 'functions', '.aossab-' + process.pid + '.js');
const O = fs.readFileSync(F, 'utf8');
process.on('exit', () => { try { fs.unlinkSync(TMP); } catch (_) {} });
const M = [
  ['(a) summary authz removed', "exports._h.adminOrdersSummary = async (req) => {\n  _requireAdminCallable(req);", "exports._h.adminOrdersSummary = async (req) => {\n", 'S-10'],
  ['(b) revenue includes non-PV orders', "tasks.push(Promise.resolve().then(() => PVq().aggregate(", "tasks.push(Promise.resolve().then(() => col.aggregate(", 'S-5'],
  ['(c) failed aggregate becomes 0', "const fail = (bag, key, e) => { ERRS.get(bag)[key] = _aggReason(e);", "const fail = (bag, key, e) => { bag[key] = 0; ERRS.get(bag)[key] = _aggReason(e);", 'S-3a'],
  ['(d) status update accepts paid', "  if (to === 'paid') return { ok: false, reason: 'PAYMENT_AUTHORITY_ONLY' };", "  if (to === 'paid') return { ok: true };", 'S-14c'],
  ['(e) acceptedProcessing counts unverified orders', "for (const v of ORDER_STATUSES) cnt(SP, v, PVq().where('status', '==', v));", "for (const v of ORDER_STATUSES) cnt(SP, v, (_ORDER_STATUS.processing.includes(v) ? col : PVq()).where('status', '==', v));", 'S-9'],
  ['(f) buyer total used as revenue fallback', "if (x.paymentVerified !== true) continue;", "", 'S-6'],
  ['(g) index error surfaces as unavailable', "if (code === 'FAILED_PRECONDITION' && st) {", "if (false) {", 'S-13a'],
  ['(h) exec dashboard order count back to 0', "count().get().catch(_nullCount('totalOrders'))", "count().get().catch(() => ({ data: () => ({ count: 0 }) }))", 'S-16a'],
  ['(i) cursor ignored', "    try { q = q.startAfter(cs); } catch (_) {", "    try { q = q; } catch (_) {", 'S-12a'],
];
let c = 0;
for (const [l, a, b, row] of M) {
  const n = O.split(a).length - 1;
  if (n !== 1) { console.log('  ANCHOR x' + n + '  ' + l); continue; }
  fs.writeFileSync(TMP, O.replace(a, b));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'test-admin-orders-summary.js')], { encoding: 'utf8', timeout: 120000, env: Object.assign({}, process.env, { AOS_MODULE: TMP }) });
  const f = (r.stdout.match(/^\s+FAIL \S+/mg) || []).map((x) => x.trim().split(' ')[1]);
  const ok = r.status === 1 && f.includes(row); if (ok) c++;
  console.log('  ' + (ok ? 'CAUGHT' : 'MISSED') + '  ' + l + '  <- ' + f.join(',') + (ok ? '' : ' (exit ' + r.status + ', expected ' + row + ')'));
}
console.log('\nSABOTAGE: ' + c + '/' + M.length);
process.exit(c === M.length ? 0 : 1);
