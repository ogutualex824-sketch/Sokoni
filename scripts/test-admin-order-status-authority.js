#!/usr/bin/env node
/* SECURITY CONVERGENCE 2026-10-03 — adminUpdateOrderStatus is a TRANSITION with evidence, not a free status string.
 *   node scripts/test-admin-order-status-authority.js
 *   BASE=18cfe7fdd5 node scripts/test-admin-order-status-authority.js   (byte-identical to the LIVE archive — must FAIL)
 * Runs the REAL handler (admin-os.js exports._h.adminUpdateOrderStatus) on an in-memory Firestore, with the REAL
 * fulfilment-lifecycle. Every refusal asserts the order was NOT changed. */
'use strict';
const path = require('path'), fs = require('fs'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { fakeDb } = require('./lib/fake-firestore');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 200) + ']')); ok ? pass++ : fail++; };
console.log('\nadminUpdateOrderStatus authority   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
let MOD = path.join(FN, 'admin-os.js');
if (process.env.BASE) { MOD = path.join(FN, '.aosbase-' + process.pid + '.js'); fs.writeFileSync(MOD, execSync('git show ' + process.env.BASE + ':functions/admin-os.js', { cwd: ROOT, maxBuffer: 64 << 20 })); process.on('exit', () => { try { fs.unlinkSync(MOD); } catch (_) {} }); }
let DB = fakeDb({});
const realFS = require(require.resolve('firebase-admin/firestore', { paths: [FN] }));
const fsPath = require.resolve('firebase-admin/firestore', { paths: [FN] });
require.cache[fsPath] = { id: fsPath, filename: fsPath, loaded: true, exports: Object.assign({}, realFS, { getFirestore: () => DB }) };
const adminPath = require.resolve('firebase-admin', { paths: [FN] });
const fsFn = () => DB; fsFn.FieldValue = realFS.FieldValue;
require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: { firestore: fsFn, apps: [1], initializeApp() {}, auth: () => ({ getUser: async () => ({}) }) } };
const AOS = require(MOD);
const H = AOS._h.adminUpdateOrderStatus;
const set = async (order, status) => {
  DB = fakeDb({ orders: { O: order } });
  let r; try { r = await H({ auth: { uid: 'ops', token: { admin: true } }, data: { orderId: 'O', status } }); } catch (e) { r = { err: e.code || 'error', reason: (e.details && e.details.reason) || e.message }; }
  return { r, after: DB._store.orders.O.status };
};
const PAID = { paymentVerified: true, paymentStatus: 'paid' };

(async () => {
  const rows = [
    ['A-1', { status: 'pending_payment' }, 'paid', false, 'fake PAID — an admin cannot mark an unpaid order paid (payment authority only)', 'PAYMENT_AUTHORITY_ONLY'],
    ['A-2', Object.assign({ status: 'in_transit' }, PAID), 'delivered', false, 'fake DELIVERED — no delivery evidence (deliveredAt) → refused'],
    ['A-3', Object.assign({ status: 'delivered', deliveredAt: 1 }, PAID), 'refunded', false, 'fake REFUNDED — no refund evidence → refused'],
    ['A-4', Object.assign({ status: 'in_transit' }, PAID), 'completed', false, 'fake COMPLETED — an undelivered order cannot be completed (settleOrder pays on it)'],
    ['A-5', { status: 'delivered', deliveredAt: 1 }, 'completed', false, 'an UNPAID delivered order cannot be completed'],
    ['A-6', Object.assign({ status: 'delivered', deliveredAt: 1, disputeOpen: true }, PAID), 'completed', false, 'an order under an OPEN DISPUTE cannot be completed'],
    ['A-7', Object.assign({ status: 'confirmed' }, PAID), 'cancelled', false, 'a PAID order cannot be cancelled by status (the refund programme handles it)'],
    ['A-8', { status: 'pending' }, 'shipped', false, 'fulfilment on an UNPAID order is refused'],
    ['A-9', Object.assign({ status: 'in_transit' }, PAID), 'processing', false, 'a backwards move (in transit → processing) is refused'],
    ['A-10', Object.assign({ status: 'completed' }, PAID), 'in_transit', false, 'a TERMINAL order cannot be reopened'],
    ['A-10b', Object.assign({ status: 'completed', deliveredAt: 1 }, PAID), 'delivered', false, 'a COMPLETED order cannot be stepped back to delivered even with delivery evidence (the terminal guard on its own)', 'TERMINAL'],
    ['A-11', Object.assign({ status: 'cancelled' }), 'paid', false, 'a cancelled order cannot be revived as paid'],
    ['A-12', Object.assign({ status: 'confirmed' }, PAID), 'banana', false, 'an unknown status string is refused'],
    ['A-13', Object.assign({ status: 'confirmed' }, PAID), 'shipped', true, 'CONTROL: a paid order moves forward (confirmed → shipped)'],
    ['A-14', Object.assign({ status: 'delivered', deliveredAt: 1 }, PAID), 'completed', true, 'CONTROL: a paid, delivered, undisputed order completes'],
    ['A-15', { status: 'pending_payment' }, 'cancelled', true, 'CONTROL: an unpaid order can be cancelled'],
    ['A-16', Object.assign({ status: 'delivered', deliveredAt: 1, settlementStatus: 'REFUNDED' }, PAID), 'refunded', true, 'CONTROL: refunded is allowed WITH refund evidence'],
    ['A-17', Object.assign({ status: 'in_transit', deliveredAt: 5 }, PAID), 'delivered', true, 'CONTROL: delivered is allowed WITH delivery evidence'],
  ];
  for (const [id, order, to, allow, msg, wantReason] of rows) {
    const { r, after } = await set(Object.assign({}, order), to);
    if (allow) ck(id, !r.err && after === to, msg, { r, after });
    else ck(id, !!r.err && after === order.status && (!wantReason || r.reason === wantReason), msg + ' (order unchanged)', { r, after });
  }
  /* a refused attempt is AUDITED */
  DB = fakeDb({ orders: { O: { status: 'pending_payment' } } });
  try { await H({ auth: { uid: 'ops', token: { admin: true } }, data: { orderId: 'O', status: 'paid' } }); } catch (_) {}
  ck('A-18', Object.values(DB._store.adminAudit || {}).some((a) => a.action === 'order_status_refused' && a.reason === 'PAYMENT_AUTHORITY_ONLY'), 'a refused admin attempt is written to adminAudit with its reason');
  let r; try { r = await H({ auth: { uid: 'u1', token: {} }, data: { orderId: 'O', status: 'shipped' } }); } catch (e) { r = { err: e.code || e.message }; }
  ck('A-19', !!r.err, 'CONTROL: a non-admin is refused', r);
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
