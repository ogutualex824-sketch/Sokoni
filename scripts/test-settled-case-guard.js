'use strict';
/**
 * CERTIFICATION — the "already settled" guard is case-insensitive in BOTH credit gates.
 *
 * The defect (docs/MARKETPLACE_DOUBLE_CREDIT_MEASUREMENT.md): the IntaSend webhook credits the
 * seller and marks the order `settlementStatus: "settled"` (lowercase). settleOrder and the
 * auto-confirm sweep skipped only 'SETTLED', so completing a webhook-paid order credited the
 * seller a SECOND time.
 *
 * Runs against a REAL Firestore emulator (real transactions, real FieldValue.increment) — never
 * a hand-written fake, and never production. Refuses to run without FIRESTORE_EMULATOR_HOST: a
 * silent fallback to a default port could be another session's emulator.
 *
 *   ORDER_SETTLEMENT_PATH   the order-settlement.js under test (default: this repo's functions/)
 *
 * Positive controls prove the harness can SEE a credit, so "no second credit" is an observation
 * and not the absence of a detector. Point it at the unpatched file and it must FAIL.
 */
const path = require('path');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set. This suite only runs against an emulator.');
  process.exit(2);
}
const target = path.resolve(process.env.ORDER_SETTLEMENT_PATH || path.join(__dirname, '..', 'functions', 'order-settlement.js'));
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-settled-guard' });
const db = admin.firestore();
const OS = require(target);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS', msg); } else { fail++; console.log('  FAIL', msg); } };

const SELLER = 'seller_guard_test';
const OPENING = 1000;                                   /* shillings */
const walletBal = async () => Number(((await db.collection('wallets').doc(SELLER).get()).data() || {}).balance || 0);
const settleTx = async (id) => (await db.collection('walletTransactions').doc(`${SELLER}_${id}_ordersettle`).get()).exists;

/* A pickup order: no delivery to prove, so the branch lineage's delivery gate and the deployed
   lineage (which has none) both reach the credit decision on the same input. */
function paidOrder(id, settlementStatus, status) {
  const o = { id, sellerUid: SELLER, uid: 'buyer_guard_test', buyerUid: 'buyer_guard_test',
    total: 97, orderTotal: 97, deliveryFee: 0, fulfillmentType: 'pickup',
    status: status || 'completed', paymentStatus: 'paid', paymentVerified: true, channel: 'online' };
  if (settlementStatus !== undefined) o.settlementStatus = settlementStatus;
  return o;
}

async function reset() {
  const cols = ['orders', 'wallets', 'walletTransactions', 'settlements', 'ledger', 'payments'];
  for (const c of cols) {
    const s = await db.collection(c).get();
    await Promise.all(s.docs.map((d) => d.ref.delete()));
  }
  await db.collection('wallets').doc(SELLER).set({ uid: SELLER, balance: OPENING, currency: 'KES' });
}

(async () => {
  console.log('target:', target);

  console.log('\n[1] isAlreadySettled — the one predicate');
  ok(typeof OS.isAlreadySettled === 'function', 'isAlreadySettled is exported');
  if (typeof OS.isAlreadySettled === 'function') {
    const yes = ['settled', 'SETTLED', 'Settled', ' settled', 'settled ', '\tSETTLED\n'];
    const no = [undefined, null, '', 'UNSETTLED', 'SETTLING', 'HELD', 'queued', 'ELIGIBLE_FOR_SETTLEMENT',
      'REFUNDED', 'REVERSED', 'settledd', 'un settled', 0, {}, ['SETTLED']];
    yes.forEach((v) => ok(OS.isAlreadySettled(v) === true, `settled: ${JSON.stringify(v)}`));
    no.forEach((v) => ok(OS.isAlreadySettled(v) === false, `not settled: ${JSON.stringify(v)}`));
  }

  console.log('\n[2] settleOrder — an already-settled order is never credited again');
  for (const st of ['settled', 'SETTLED', 'Settled', ' settled']) {
    await reset();
    const id = 'ord_' + st.trim().toLowerCase() + '_' + st.length + '_' + (st === st.toUpperCase() ? 'U' : 'm');
    await db.collection('orders').doc(id).set(paidOrder(id, st, 'completed'));
    const r = await OS.settleOrder(db, admin, id);
    ok(r && r.outcome === 'already-settled', `${JSON.stringify(st)} + completed -> outcome already-settled (got ${r && r.outcome})`);
    ok(await walletBal() === OPENING, `${JSON.stringify(st)} -> wallet balance unchanged at ${OPENING}`);
    ok(!(await settleTx(id)), `${JSON.stringify(st)} -> no ordersettle walletTransaction`);
    const after = (await db.collection('orders').doc(id).get()).data();
    ok(after.settlementStatus === st, `${JSON.stringify(st)} -> order settlementStatus left exactly as it was`);
  }

  console.log('\n[3] POSITIVE CONTROL — a genuinely unsettled order IS credited (the detector works)');
  for (const st of [undefined, 'queued', 'HELD', 'ELIGIBLE_FOR_SETTLEMENT']) {
    await reset();
    const id = 'ord_ctl_' + String(st);
    await db.collection('orders').doc(id).set(paidOrder(id, st, 'completed'));
    const r = await OS.settleOrder(db, admin, id);
    const bal = await walletBal();
    ok(r && r.outcome === 'settled', `${JSON.stringify(st)} -> outcome settled (got ${r && r.outcome})`);
    ok(bal > OPENING, `${JSON.stringify(st)} -> wallet credited (${OPENING} -> ${bal})`);
    ok(await settleTx(id), `${JSON.stringify(st)} -> ordersettle walletTransaction written`);
    const r2 = await OS.settleOrder(db, admin, id);
    ok(r2 && r2.outcome === 'already-settled' && await walletBal() === bal, `${JSON.stringify(st)} -> replay credits nothing`);
  }

  console.log('\n[4] THE INCIDENT — webhook-credited order later completed: no second seller credit');
  await reset();
  {
    const id = 'SKN_WEBHOOK_PAID';
    /* Exactly the state _finalizeMarketplacePayment leaves after the webhook credited the seller. */
    await db.collection('orders').doc(id).set(Object.assign(paidOrder(id, 'settled', 'paid'),
      { paymentMethod: 'mpesa_intasend', inventoryApplied: true }));
    await db.collection('payments').doc('API_REF_1').set({ walletCreditedAt: new Date(), walletCreditCents: 8700,
      walletCreditedTo: SELLER, meta: { orderId: id } });
    const before = await walletBal();
    /* The seller moves it along, as the served rules allow, then completes it. */
    for (const s of ['confirmed', 'delivered', 'completed']) {
      await db.collection('orders').doc(id).update({ status: s });
      if (s === 'completed') {
        const results = await Promise.all([OS.settleOrder(db, admin, id), OS.settleOrder(db, admin, id), OS.settleOrder(db, admin, id)]);
        ok(results.every((x) => x && x.outcome === 'already-settled'), `3 concurrent settleOrder calls all refuse (got ${results.map((x) => x && x.outcome)})`);
      }
    }
    ok(await walletBal() === before, `seller wallet unchanged by completion (${before})`);
    ok(!(await settleTx(id)), 'no ordersettle walletTransaction for the webhook-paid order');
    ok(!(await db.collection('settlements').doc(id).get()).exists, 'no settlements record created');
  }

  console.log('\n[5] auto-confirm sweep — skips settled in every case, still confirms the unsettled');
  await reset();
  {
    const old = admin.firestore.Timestamp.fromMillis(Date.now() - 30 * 86400000);
    const rows = { sw_lower: 'settled', sw_upper: 'SETTLED', sw_title: 'Settled', sw_space: ' settled', sw_refunded: 'REFUNDED', sw_ctl_unset: undefined, sw_ctl_held: 'HELD' };
    for (const [id, st] of Object.entries(rows)) {
      await db.collection('orders').doc(id).set(Object.assign(paidOrder(id, st, 'delivered'), { deliveredAt: old }));
    }
    const n = await OS.autoConfirmDeliveredOrders(db, admin);
    const statusOf = async (id) => (await db.collection('orders').doc(id).get()).data().status;
    for (const id of ['sw_lower', 'sw_upper', 'sw_title', 'sw_space', 'sw_refunded']) {
      ok(await statusOf(id) === 'delivered', `${id} (${JSON.stringify(rows[id])}) NOT auto-completed`);
    }
    ok(await statusOf('sw_ctl_unset') === 'completed', 'CONTROL: unsettled delivered order IS auto-completed');
    ok(await statusOf('sw_ctl_held') === 'completed', 'CONTROL: HELD delivered order IS auto-completed');
    ok(n === 2, `sweep confirmed exactly 2 orders (got ${n})`);
  }

  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH (not a verdict):', e && e.stack || e); process.exit(3); });
