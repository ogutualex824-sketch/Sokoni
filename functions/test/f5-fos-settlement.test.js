'use strict';
/* F5 "correct-before-use" FOS settlement — adversarial emulator suite.
 *
 * _processFOSTransaction is module-private (reached only via the HMAC-guarded onRequest
 * webhook), so — as with the F2 negative control and the design-review prototype — the
 * settlement + refund TRANSACTION BODIES below are copied VERBATIM from
 * functions/financial-os.js and exercised against the REAL Firestore emulator (real
 * optimistic concurrency). The independent-verification gate confirms this copy is faithful
 * and verifies the actual deployed generation. Static items (no availableCents / zero export
 * delta / frozen wallet.js zero-diff / F3-F8 untouched) are asserted outside this suite.
 *
 * Run: firebase emulators:exec --only firestore --project sokoni-test \
 *        "node functions/test/f5-fos-settlement.test.js"
 */
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-test';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
const now = () => FV.serverTimestamp();

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };

/* ── VERBATIM copy of financial-os.js _processFOSTransaction's settlement transaction ──
   (with `withGuard=false` reproducing the pre-amendment id-only path, for the neg control) */
async function settle(txId, { withGuard = true } = {}) {
  const txRef = db.collection('fosTransactions').doc(txId);
  const outer = await txRef.get();
  if (!outer.exists) return { settled: false };
  const tx = outer.data();
  const commissionCents = tx.commissionCents;
  const netCents = tx.amountCents - commissionCents;
  const netShillings = Math.floor(netCents / 100);
  const remainderCents = netCents - netShillings * 100;

  return db.runTransaction(async (txn) => {
    const freshTx = await txn.get(txRef);
    if (withGuard && (!freshTx.exists || freshTx.data().status === 'COMPLETED')) return { settled: false };
    const walletRef = db.collection('wallets').doc(tx.sellerUid);
    const wSnap = await txn.get(walletRef);
    const debt = wSnap.exists ? Math.max(0, Number(wSnap.data().refundRecoveryDebt) || 0) : 0;
    const appliedToDebt = Math.min(debt, netShillings);
    const withdrawable = netShillings - appliedToDebt;

    txn.update(txRef, { status: 'COMPLETED', commissionCents, netCents, remainderCents, completedAt: now(), updatedAt: now() });
    if (tx.metadata && tx.metadata.consultationId) {
      txn.set(db.collection('legalConsultations').doc(tx.metadata.consultationId),
        { paymentStatus: 'paid', status: 'confirmed', paidAmountCents: tx.amountCents, paidAt: now() }, { merge: true });
    }
    txn.set(walletRef, { balance: FV.increment(withdrawable), refundRecoveryDebt: FV.increment(-appliedToDebt), updatedAt: now() }, { merge: true });
    txn.set(db.collection('walletTransactions').doc(`fos_${txId}_settle`),
      { uid: tx.sellerUid, type: 'fos_settlement', amount: withdrawable, appliedToDebt, grossCredit: netShillings,
        sourceType: 'fos', sourceId: txId, grossCents: tx.amountCents, commissionCents, netCents, remainderCents, createdAt: now() });
    const platformCents = commissionCents + remainderCents;
    txn.set(db.collection('commissionLedger').doc(`fos_${txId}`),
      { source: 'fos', txId, sellerUid: tx.sellerUid, commissionCents, remainderCents,
        sokoniCut: platformCents / 100, serviceTotal: tx.amountCents / 100, status: 'auto_collected', createdAt: now() }, { merge: true });
    txn.set(db.collection('ledger').doc(`fos_${txId}_seller`),
      { entryType: 'fos_settlement', debitAccount: 'GROSS_COLLECTION', creditAccount: `seller:${tx.sellerUid}`, amountCents: netCents - remainderCents, sourceType: 'fos', sourceId: txId, createdAt: now() });
    txn.set(db.collection('ledger').doc(`fos_${txId}_commission`),
      { entryType: 'fos_commission', debitAccount: 'GROSS_COLLECTION', creditAccount: 'PLATFORM_REVENUE', amountCents: platformCents, sourceType: 'fos', sourceId: txId, createdAt: now() });
    return { settled: true, withdrawable, netShillings, remainderCents, commissionCents };
  });
}

/* VERBATIM copy of fosApproveRefund's wallet-debit transaction (balance rail) */
async function refund(sellerUid, amountCents) {
  return db.runTransaction(async (txn) => {
    const wSnap = await txn.get(db.collection('wallets').doc(sellerUid));
    const bal = wSnap.exists ? Math.max(0, Number(wSnap.data().balance) || 0) : 0;
    const refundShillings = Math.round(amountCents / 100);
    const fromBalance = Math.min(bal, refundShillings);
    const toDebt = refundShillings - fromBalance;
    txn.set(db.collection('wallets').doc(sellerUid),
      { balance: FV.increment(-fromBalance), refundRecoveryDebt: FV.increment(toDebt), refundedCents: FV.increment(amountCents), updatedAt: now() }, { merge: true });
    return { fromBalance, toDebt };
  });
}

async function clearCol(n) { const s = await db.collection(n).get(); await Promise.all(s.docs.map(d => d.ref.delete())); }
async function reset() { await Promise.all(['fosTransactions', 'wallets', 'walletTransactions', 'commissionLedger', 'ledger', 'legalConsultations'].map(clearCol)); }
async function seedTx(id, { amountCents, commissionCents, sellerUid = 's1', consultationId = 'c1' }) {
  await db.collection('fosTransactions').doc(id).set({ status: 'INITIATED', amountCents, commissionCents, sellerUid, hubType: 'legal', metadata: { consultationId } });
}
const wallet = async (u = 's1') => (await db.collection('wallets').doc(u).get()).data() || {};
const size = async (n) => (await db.collection(n).get()).size;

(async () => {
  /* 1. Successful settlement COMMITS on the corrected path */
  await reset(); await seedTx('t1', { amountCents: 500000, commissionCents: 100000 });   // net 400000c = 4000sh, rem 0
  const r1 = await settle('t1');
  ok(r1.settled === true, '1: settlement commits');
  ok((await wallet()).balance === 4000, '1: seller balance credited in shillings (4000)');
  ok((await db.collection('fosTransactions').doc('t1').get()).data().status === 'COMPLETED', '1: fosTransaction COMPLETED');
  ok((await db.collection('legalConsultations').doc('c1').get()).data().paymentStatus === 'paid', '1: consultation marked paid');
  ok((await size('commissionLedger')) === 1 && (await size('ledger')) === 2, '1: commissionLedger(1) + double-entry ledger(2) written');

  /* 2. Reserved __platform__ negative control FAILS (proves old path could not commit) */
  await reset();
  let platErr = null;
  try { await db.runTransaction(async (txn) => { txn.set(db.collection('wallets').doc('__platform__'), { availableCents: FV.increment(1) }); }); }
  catch (e) { platErr = String(e.message || e); }
  ok(platErr && /reserved/i.test(platErr), '2: NEG control — wallets/__platform__ write fails (reserved id): ' + (platErr ? 'reserved' : 'no error!'));

  /* 3 & 4. Duplicate/replay with the in-txn status guard cannot double-increment balance */
  await reset(); await seedTx('t3', { amountCents: 500000, commissionCents: 100000 });
  await settle('t3'); await settle('t3'); await settle('t3');   // replay ×2
  ok((await wallet()).balance === 4000, '3/4: replay with status guard credits EXACTLY once (4000, not 12000)');

  /* NEG control: WITHOUT the guard, deterministic ids do NOT protect balance (proves the guard is load-bearing) */
  await reset(); await seedTx('tN', { amountCents: 500000, commissionCents: 100000 });
  await settle('tN', { withGuard: false }); await settle('tN', { withGuard: false });
  ok((await wallet()).balance === 8000, 'NEG: without the in-txn guard, replay DOUBLES balance (8000) — guard is load-bearing');

  /* 5. Concurrency — N concurrent settlements of one tx → exactly one credit */
  await reset(); await seedTx('t5', { amountCents: 500000, commissionCents: 100000 });
  await Promise.allSettled(Array.from({ length: 6 }, () => settle('t5')));
  ok((await wallet()).balance === 4000, '5: 6 concurrent settlements credit exactly once (4000)');

  /* 6. Fractional-cent remainder — value invariant holds, nothing dropped */
  await reset(); await seedTx('t6', { amountCents: 500099, commissionCents: 100019 });    // net 400080c → 4000sh + rem 80c
  const r6 = await settle('t6');
  const w6 = await wallet();
  const cl6 = (await db.collection('commissionLedger').doc('fos_t6').get()).data();
  ok(w6.balance === 4000 && r6.remainderCents === 80, '6: floor→4000sh, remainderCents=80 recorded (not dropped)');
  ok(500099 === w6.balance * 100 + cl6.commissionCents + cl6.remainderCents, '6: value invariant buyer==seller*100+commission+remainder (500099==400000+100019+80)');

  /* 7. Refund reduces the SAME authoritative balance rail (with debt-recovery for shortfall) */
  await reset(); await seedTx('t7', { amountCents: 500000, commissionCents: 100000 }); await settle('t7');  // balance 4000
  await refund('s1', 300000);                                                                                // refund 3000sh
  ok((await wallet()).balance === 1000, '7: refund debits balance (4000-3000=1000)');
  await refund('s1', 250000);                                                                                // 2500sh > 1000 bal → 1500 debt
  const w7 = await wallet();
  ok(w7.balance === 0 && w7.refundRecoveryDebt === 1500, '7: over-refund zeroes balance + records refundRecoveryDebt 1500 (no negative balance)');

  /* 8. Commission ledger / accounting consistency */
  await reset(); await seedTx('t8', { amountCents: 500099, commissionCents: 100019 }); await settle('t8');
  const cl8 = (await db.collection('commissionLedger').doc('fos_t8').get()).data();
  const led = await db.collection('ledger').where('sourceId', '==', 't8').get();
  let debit = 0, credit = 0; led.forEach(d => { const e = d.data(); credit += e.amountCents; }); // both entries credit out of GROSS_COLLECTION
  ok(cl8.status === 'auto_collected' && cl8.sokoniCut === (100019 + 80) / 100, '8: commissionLedger auto_collected, sokoniCut=(commission+remainder)/100');
  ok(credit === 500099, '8: double-entry ledger balances to gross (sellerNet + platform = 500099)');

  console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + ': ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e && e.stack || e); process.exit(2); });
