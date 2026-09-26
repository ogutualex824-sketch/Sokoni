'use strict';
/**
 * CERTIFICATION — Track G: initiateRefund binds the escrow to the requested order.
 *
 * Drives the REAL `initiateRefund` (functions/index.js, via `.run()`) on a real Firestore
 * emulator. For every refused case it snapshots the order, the escrow, `refunds` and
 * `paymentLedger` before and after: a refusal that still wrote something is a FAIL.
 * Refuses to run without FIRESTORE_EMULATOR_HOST.
 *
 *   REFUND_FUNCTIONS_DIR   the functions/ tree under test (default: this repo's)
 */
const path = require('path');
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const FN = process.env.REFUND_FUNCTIONS_DIR || path.join(__dirname, '..', 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-refund-binding';
/* index.js initialises the default app itself; load it FIRST and share that app. */
const idx = require(path.join(FN, 'index.js'));
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();
const run = (uid, data, isAdmin) => idx.initiateRefund.run({ auth: { uid, token: isAdmin ? { admin: true } : {} }, data });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };

const BUYER = 'buyer_owner', OTHER = 'someone_else', ADMIN = 'admin_1';
async function wipe() {
  for (const c of ['escrows', 'orders', 'refunds', 'paymentLedger', 'auditLogs', 'analytics', 'platformAnalytics', 'sellerAnalytics']) {
    const s = await db.collection(c).get(); await Promise.all(s.docs.map((d) => d.ref.delete()));
  }
}
async function seed() {
  await wipe();
  await db.doc('orders/ORD_A').set({ buyerUid: BUYER, sellerUid: 'seller_a', status: 'confirmed', settlementStatus: 'HELD', total: 97 });
  await db.doc('orders/ORD_B').set({ buyerUid: 'victim_buyer', sellerUid: 'seller_b', status: 'confirmed', settlementStatus: 'HELD', total: 500 });
  await db.doc('escrows/E_TX').set({ buyerId: BUYER, sellerId: 'seller_a', transactionId: 'ORD_A', amount: 97, currency: 'KES', status: 'held' });
  await db.doc('escrows/E_ORD').set({ buyerId: BUYER, sellerId: 'seller_a', orderId: 'ORD_A', amount: 97, currency: 'KES', status: 'held' });
  await db.doc('escrows/E_NONE').set({ buyerId: BUYER, sellerId: 'seller_a', amount: 97, currency: 'KES', status: 'held' });
  await db.doc('escrows/E_CONFLICT').set({ buyerId: BUYER, sellerId: 'seller_a', orderId: 'ORD_A', transactionId: 'ORD_B', amount: 97, currency: 'KES', status: 'held' });
}
const snap = async () => JSON.stringify({
  a: (await db.doc('orders/ORD_A').get()).data(), b: (await db.doc('orders/ORD_B').get()).data(),
  escrows: (await db.collection('escrows').get()).docs.map((d) => [d.id, d.data()]).sort(),
  refunds: (await db.collection('refunds').get()).size, ledger: (await db.collection('paymentLedger').get()).size,
});

async function refused(label, uid, data, isAdmin, codeRx) {
  await seed();
  const before = await snap();
  let err = null;
  try { await run(uid, data, isAdmin); } catch (e) { err = e; }
  const after = await snap();
  ok(!!err && (!codeRx || codeRx.test(err.code || '')) && before === after,
    `${label} -> REFUSED (${err ? err.code + ': ' + (err.details && err.details.reason || err.message) : 'NOT refused'}); ` +
    `order/escrow/refunds/ledger ${before === after ? 'UNCHANGED' : 'MUTATED'}`);
}

(async () => {
  console.log('[G1] owning escrow + matching order -> ALLOWED');
  await seed();
  { const r = await run(BUYER, { escrowRef: 'E_TX', orderId: 'ORD_A', reason: 'x' });
    const a = (await db.doc('orders/ORD_A').get()).data();
    ok(r && r.ref && (await db.collection('refunds').get()).size === 1, `refund filed (${r && r.ref})`);
    ok(a.settlementStatus === 'REFUNDED', `requested order updated as before (${a.settlementStatus})`);
    ok(JSON.stringify((await db.doc('orders/ORD_B').get()).data().settlementStatus) === '"HELD"', 'unrelated order untouched'); }
  await seed();
  { const r = await run(BUYER, { escrowRef: 'E_ORD', orderId: 'ORD_A', reason: 'x' });
    ok(r && r.ref, 'CONTROL: escrow recording its order as `orderId` (releaseEscrow shape) is also accepted'); }
  await seed();
  { const before = JSON.stringify([(await db.doc('orders/ORD_A').get()).data(), (await db.doc('orders/ORD_B').get()).data()]);
    const r = await run(BUYER, { escrowRef: 'E_TX', reason: 'x' });
    const after = JSON.stringify([(await db.doc('orders/ORD_A').get()).data(), (await db.doc('orders/ORD_B').get()).data()]);
    ok(r && r.ref && before === after, 'CONTROL: escrowRef alone (no order named) still works and mutates no order'); }

  console.log('\n[G2] owning escrow + DIFFERENT order -> refused, nothing written');
  await refused('buyer owns E_TX (for ORD_A), names ORD_B', BUYER, { escrowRef: 'E_TX', orderId: 'ORD_B' }, false, /permission-denied/);
  await refused('same, with the `orderId`-shaped escrow', BUYER, { escrowRef: 'E_ORD', orderId: 'ORD_B' }, false, /permission-denied/);
  await refused('ADMIN naming a mismatched escrow/order pair', ADMIN, { escrowRef: 'E_TX', orderId: 'ORD_B' }, true, /permission-denied/);

  console.log('\n[G3] NON-owning escrow + matching order -> refused, nothing written');
  await refused('stranger uses E_TX with its own order ORD_A', OTHER, { escrowRef: 'E_TX', orderId: 'ORD_A' }, false, /permission-denied/);

  console.log('\n[G4] nonexistent / missing relationship -> refused, nothing written');
  await refused('escrow does not exist', BUYER, { escrowRef: 'E_MISSING', orderId: 'ORD_A' }, false, /not-found/);
  await refused('escrow records no order at all', BUYER, { escrowRef: 'E_NONE', orderId: 'ORD_A' }, false, /failed-precondition/);
  await refused('escrow names two different orders', BUYER, { escrowRef: 'E_CONFLICT', orderId: 'ORD_A' }, false, /failed-precondition/);
  await refused('escrow names two different orders (other side)', BUYER, { escrowRef: 'E_CONFLICT', orderId: 'ORD_B' }, false, /failed-precondition/);

  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH (not a verdict):', e && e.stack || e); process.exit(3); });
