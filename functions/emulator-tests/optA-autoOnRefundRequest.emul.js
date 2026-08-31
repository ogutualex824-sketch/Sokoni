'use strict';
/* F9 refund-safety Option A — autoOnRefundRequest DISARM. Emulator suite; drives the
 * REAL exported v2 handler via `.run({data: snapshot, params})` against the Firestore
 * emulator. Success condition: a qualifying small refund request may be created, but
 * autoOnRefundRequest cannot move refund money (no users.walletBalance credit, no
 * single-sided ledger) and the request is honestly surfaced for operator action.
 *
 * Run: firebase emulators:exec --only firestore --project sokoni-test \
 *        "node functions/emulator-tests/optA-autoOnRefundRequest.emul.js"
 */
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-test';
process.env.FUNCTIONS_EMULATOR = 'true';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;

const fns = require('../automation-engine.js');
const handler = fns.autoOnRefundRequest;

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

async function clearCol(n) { const s = await db.collection(n).get(); await Promise.all(s.docs.map(d => d.ref.delete())); }
async function reset() {
  await Promise.all(['refundRequests', 'users', 'ledger', 'automationQueue', 'notifications', 'automationAuditLog', 'automationRules'].map(clearCol));
  await db.collection('automationRules').doc('refunds').set({ enabled: true, autoApproveBelow: 2000, requireManualAbove: 20000 });
}
async function seedReq(id, data) { await db.collection('refundRequests').doc(id).set({ status: 'pending', ...data }); }
async function fire(id) { const snap = await db.collection('refundRequests').doc(id).get(); await handler.run({ data: snap, params: { refId: id } }); }
const doc = async (c, id) => (await db.collection(c).doc(id).get()).data() || {};
const size = async (c) => (await db.collection(c).get()).size;
const where = async (c, f, v) => (await db.collection(c).where(f, '==', v).get());

(async () => {
  /* 1. Qualifying small refund → NO money move, routed to operator queue, honest status/notify */
  await reset();
  await seedReq('r1', { amount: 500, buyerUid: 'buyer1', orderId: 'o1', reason: 'x' });
  await fire('r1');
  ok((await doc('refundRequests', 'r1')).status === 'under_review', '1: small-refund status → under_review (NOT approved)');
  ok((await doc('users', 'buyer1')).walletBalance === undefined, '1: NO users.walletBalance credit (money-safety core)');
  ok((await where('ledger', 'refundId', 'r1')).empty, '1: NO single-sided refund ledger row');
  const q1 = await where('automationQueue', 'entityId', 'r1');
  ok(q1.size === 1 && q1.docs[0].data().type === 'auto_refund_pending_execution', 'M2: request surfaced to operator queue (automationQueue)');
  const n1 = await where('notifications', 'userId', 'buyer1');
  const nb1 = n1.docs.map(d => d.data().body).join(' ');
  ok(n1.size === 1 && !/credited/i.test(nb1) && !/has been credited/i.test(nb1), 'M1: buyer notification does NOT falsely claim credit');
  const a1 = await where('automationAuditLog', 'entityId', 'r1');
  ok(a1.docs.some(d => d.data().outcome === 'queued_for_execution') && !a1.docs.some(d => d.data().outcome === 'approved'),
     '1: audit outcome honest (queued_for_execution, not approved)');

  /* NEG control — replicate the OLD money-move so the suite proves it can DETECT a credit */
  await reset();
  await db.collection('users').doc('bN').set({ walletBalance: 0 });
  await db.runTransaction(async tx => { tx.update(db.collection('users').doc('bN'), { walletBalance: FV.increment(500) }); });
  ok((await doc('users', 'bN')).walletBalance === 500, 'NEG: control proves the suite DETECTS a users.walletBalance credit (teeth)');

  /* M3. High-value branch UNCHANGED */
  await reset();
  await seedReq('r3', { amount: 25000, buyerUid: 'buyer3', orderId: 'o3', reason: 'big' });
  await fire('r3');
  ok((await doc('refundRequests', 'r3')).status === 'under_review', 'M3: high-value → under_review (unchanged)');
  const q3 = await where('automationQueue', 'entityId', 'r3');
  ok(q3.size === 1 && q3.docs[0].data().type === 'high_value_refund', 'M3: high-value routes to high_value_refund queue (unchanged)');
  ok((await doc('users', 'buyer3')).walletBalance === undefined, 'M3: high-value never credits a wallet');

  /* M4. Middle band (autoApproveBelow < amount < requireManualAbove) — pre-existing strand */
  await reset();
  await seedReq('r4', { amount: 10000, buyerUid: 'buyer4', orderId: 'o4' });
  await fire('r4');
  ok((await doc('refundRequests', 'r4')).status === 'pending', 'M4: middle-band stays pending (pre-existing strand)');
  ok((await where('automationQueue', 'entityId', 'r4')).empty, 'M4: middle-band writes NO queue entry (strand characterized)');
  ok((await doc('refundRequests', 'r4')).automationProcessed === true, 'M4: middle-band only sets automationProcessed');

  /* M5. Non-pending guard — status !== pending → early return, no effect */
  await reset();
  await seedReq('r5', { amount: 500, buyerUid: 'buyer5', status: 'approved' });   // NOT pending
  await fire('r5');
  ok((await where('automationQueue', 'entityId', 'r5')).empty, 'M5: non-pending guard → no queue');
  ok((await size('notifications')) === 0, 'M5: non-pending guard → no notification');
  ok((await doc('users', 'buyer5')).walletBalance === undefined, 'M5: non-pending guard → no credit');

  console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ': ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e && (e.stack || e)); process.exit(2); });
