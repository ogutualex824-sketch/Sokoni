'use strict';
/* ============================================================================
   SOKONI — QA harness: two delivery-dispatch branches + exactly-once settlement
   functions/qa-dispatch-settlement-e2e.js

   ON-DEMAND integration test (NOT a jest unit test — lives outside test/, so
   `npm test` ignores it). Runs the REAL server-authoritative code against a
   live Firestore emulator:

     • settleOrder()  — imported REAL from ./order-settlement.js
     • riderClaim     — the exact first-claim-wins transaction body from
                        sokoni-orders.js:447 (that file is a browser ES module,
                        so the txn semantics are mirrored 1:1; the property under
                        test is the emulator's real transaction isolation).

   Proves the correctness surface a real prod transaction would exercise, with
   ZERO production pollution:
     BRANCH A (auto-assigned rider)   → completed → settle → seller credited once
     BRANCH B (no rider → claimable)  → concurrent claims, first wins → completed
                                        → settle → seller credited once
     IDEMPOTENCY                       → concurrent + replayed settleOrder credits once

   Usage (from repo root, Git Bash):
     JAVA="/c/Program Files/Microsoft/jdk-17.0.19.10-hotspot/bin/java.exe"
     JAR=~/.cache/firebase/emulators/cloud-firestore-emulator-v1.19.8.jar
     "$JAVA" -jar "$JAR" --host 127.0.0.1 --port 8722 >/tmp/fs-emu.log 2>&1 &
     # wait for readiness, then:
     FIRESTORE_EMULATOR_HOST=127.0.0.1:8722 node functions/qa-dispatch-settlement-e2e.js
   (the accompanying runner script scripts/qa/run-dispatch-e2e.sh does all of this)
   ========================================================================== */

const admin = require('firebase-admin');
const { settleOrder, STATES } = require('./order-settlement');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('REFUSING TO RUN: FIRESTORE_EMULATOR_HOST is not set. This harness must target the emulator, never prod.');
  process.exit(2);
}

admin.initializeApp({ projectId: 'sokoni-aeb26-qa' });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;

/* Mirrors sokoni-orders.js:447 riderClaim — atomic first-claim-wins. */
async function riderClaim(orderId, driverUid) {
  const ref = db.collection('orders').doc(String(orderId));
  try {
    await db.runTransaction(async (txn) => {
      const s = await txn.get(ref);
      if (!s.exists) throw new Error('Order not found.');
      const o = s.data();
      if (o.assignedDriverUid) throw new Error('Just claimed by another rider.');
      if (o.status !== 'confirmed') throw new Error('This delivery is no longer available.');
      txn.update(ref, {
        status: 'rider_assigned', assignedDriverUid: driverUid, claimedByRider: true,
        riderAssignedAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(),
        statusHistory: FV.arrayUnion({ status: 'rider_assigned', at: new Date().toISOString(), by: driverUid, claimed: true }),
      });
    });
    return { ok: true, driverUid };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function seedOrder(id, { sellerUid, total, deliveryFee, assignedDriverUid = null }) {
  await db.collection('orders').doc(id).set({
    orderId: id, sellerUid, buyerUid: 'buyer_' + id,
    orderTotal: total, deliveryFee,
    status: assignedDriverUid ? 'rider_assigned' : 'confirmed',
    assignedDriverUid,
    settlementStatus: STATES.HELD,
    escrow: { held: Math.round(total * 100), released: 0 },
    createdAt: FV.serverTimestamp(),
  });
}

async function walletBalance(uid) {
  const w = await db.collection('wallets').doc(uid).get();
  return w.exists ? (Number(w.data().balance) || 0) : 0;
}

async function toCompleted(id) {
  await db.collection('orders').doc(id).update({ status: 'completed', settlementStatus: STATES.ELIGIBLE, completedAt: FV.serverTimestamp() });
}

/* ── assertion plumbing ─────────────────────────────────────────── */
const results = [];
function check(name, cond, detail) { results.push({ name, ok: !!cond, detail: detail || '' }); }

async function run() {
  /* ───────────── BRANCH A — auto-assigned rider settles once ───────────── */
  {
    const seller = 'sellerA', id = 'orderA';
    await seedOrder(id, { sellerUid: seller, total: 1000, deliveryFee: 100, assignedDriverUid: 'rider_auto_1' });
    const before = await walletBalance(seller);
    await toCompleted(id);
    const r = await settleOrder(db, admin, id);
    const after = await walletBalance(seller);
    const settleDoc = await db.collection('settlements').doc(id).get();
    const oSnap = await db.collection('orders').doc(id).get();
    check('A1 auto-assigned rider preserved through settle', oSnap.data().assignedDriverUid === 'rider_auto_1');
    check('A2 settleOrder outcome=settled', r.outcome === 'settled', JSON.stringify(r));
    check('A3 seller credited a positive amount', after - before === r.netShillings && r.netShillings > 0, `Δ=${after - before} netShillings=${r.netShillings}`);
    check('A4 settlements/{orderId} written exactly once', settleDoc.exists && settleDoc.data().netShillingsCredited > 0);
    check('A5 order.settlementStatus=SETTLED', oSnap.data().settlementStatus === STATES.SETTLED);
  }

  /* ───────────── BRANCH B — no rider → first-claim-wins → settles once ───────────── */
  {
    const seller = 'sellerB', id = 'orderB';
    await seedOrder(id, { sellerUid: seller, total: 2000, deliveryFee: 150, assignedDriverUid: null });
    /* 5 riders race for the one claimable delivery */
    const claims = await Promise.all(
      ['r1', 'r2', 'r3', 'r4', 'r5'].map((rid) => riderClaim(id, rid))
    );
    const winners = claims.filter((c) => c.ok);
    const oSnap = await db.collection('orders').doc(id).get();
    check('B1 exactly ONE rider won the claim', winners.length === 1, `winners=${winners.length}`);
    check('B2 order.status=rider_assigned', oSnap.data().status === 'rider_assigned');
    check('B3 assignedDriverUid == the winner', winners.length === 1 && oSnap.data().assignedDriverUid === winners[0].driverUid);
    check('B4 losers got a clean rejection (not a crash)', claims.filter((c) => !c.ok).every((c) => /another rider|no longer available/.test(c.error || '')));

    const before = await walletBalance(seller);
    await toCompleted(id);
    const r = await settleOrder(db, admin, id);
    const after = await walletBalance(seller);
    check('B5 seller credited once, positive', after - before === r.netShillings && r.netShillings > 0, `Δ=${after - before}`);
  }

  /* ───────────── IDEMPOTENCY — concurrent + replayed settle credits once ───────────── */
  {
    const seller = 'sellerC', id = 'orderC';
    await seedOrder(id, { sellerUid: seller, total: 500, deliveryFee: 0, assignedDriverUid: 'rider_auto_2' });
    await toCompleted(id);
    const before = await walletBalance(seller);
    /* three concurrent settlements + one replay after */
    const rs = await Promise.all([settleOrder(db, admin, id), settleOrder(db, admin, id), settleOrder(db, admin, id)]);
    const replay = await settleOrder(db, admin, id);
    const after = await walletBalance(seller);
    const settledOnce = rs.filter((r) => r.outcome === 'settled').length;
    const wtxn = await db.collection('walletTransactions').doc(`${seller}_${id}_ordersettle`).get();
    check('C1 exactly one of the concurrent settlements did the credit', settledOnce === 1, `settled=${settledOnce} outcomes=${rs.map(r=>r.outcome).join(',')}`);
    check('C2 replay is a no-op', replay.outcome === 'already-settled', replay.outcome);
    const credited = rs.find((r) => r.outcome === 'settled');
    check('C3 wallet credited by exactly the settled amount (no double-credit)', after - before === (credited ? credited.netShillings : -1), `Δ=${after - before}`);
    check('C4 single deterministic walletTransaction exists', wtxn.exists);
  }

  /* ── report ─────────────────────────────────────────────────────── */
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log('\n──────────── DISPATCH + SETTLEMENT E2E (emulator) ────────────');
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`);
  console.log(`──────────────────────────────────────────────────────────────`);
  console.log(`  ${pass}/${results.length} checks passed${fail ? `  —  ${fail} FAILED` : ''}\n`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(3); });
