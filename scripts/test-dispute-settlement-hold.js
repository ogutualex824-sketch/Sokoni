'use strict';
/**
 * CERTIFICATION — Repair 1: an open dispute pauses auto-confirm AND seller settlement.
 *
 *   OPEN DISPUTE -> NO AUTO-CONFIRM -> NO SELLER SETTLEMENT
 *
 * Part A drives the REAL callables (disputes.createDispute / cancelDispute / adminResolveDispute via
 * `.run()`) and the REAL settleOrder + auto-confirm sweep on a Firestore emulator.
 * Part B loads the SERVED production ruleset (and the repo's build) into @firebase/rules-unit-testing
 * and proves a buyer or seller cannot forge or lift a hold; a permissive COUNTERPROOF ruleset must
 * ALLOW the same forgeries, so a refusal is the rules' doing and not a dead harness.
 *
 * Refuses to run without FIRESTORE_EMULATOR_HOST (never assumes a port).
 *   REFUND_FUNCTIONS_DIR  functions/ tree under test (default: this repo's)
 *   SERVED_RULES_PATH     served ruleset text (Part B); the repo's firestore.rules.build is always tested too
 */
const path = require('path');
const fs = require('fs');
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const FN = process.env.REFUND_FUNCTIONS_DIR || path.join(__dirname, '..', 'functions');
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-dispute-hold';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
const TS = admin.firestore.Timestamp;
const disputes = require(path.join(FN, 'disputes.js'));          /* after initializeApp: it binds admin.firestore() at load */
const OS = require(path.join(FN, 'order-settlement.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const getv = async (p) => (await get(p)) || {};
const tryRun = async (fn, req) => { try { return await fn.run(req); } catch (e) { return { __error: e.code || e.message }; } };
const BUYER = 'buyer_d', SELLER = 'seller_d', ADMINCTX = { uid: 'admin_d', token: { admin: true } };
const sellerBal = async () => Number((await getv(`wallets/${SELLER}`)).balance || 0);

async function wipe() {
  for (const c of ['orders', 'disputes', 'wallets', 'walletTransactions', 'settlements', 'ledger']) {
    const s = await db.collection(c).get(); await Promise.all(s.docs.map((d) => d.ref.delete()));
  }
}
/* A pickup marketplace order the settlement path credits (no delivery-proof gate). */
async function order(id, status, extra) {
  await db.doc(`orders/${id}`).set(Object.assign({ id, buyerId: BUYER, uid: BUYER, buyerUid: BUYER, sellerUid: SELLER, sellerId: SELLER,
    total: 97, orderTotal: 97, deliveryFee: 0, fulfillmentType: 'pickup', status, paymentVerified: true,
    createdAt: TS.now() },
    /* R1_WITH_DELIVERY_STATUS=1 gives the old createDispute the field it crashes without, isolating the pause defect. */
    process.env.R1_WITH_DELIVERY_STATUS === '1' ? { deliveryStatus: status } : {}, extra || {}));
}
const openDispute = (orderId) => tryRun(disputes.createDispute, { auth: { uid: BUYER, token: {} },
  data: { orderId, reason: 'not_received', description: 'The parcel never arrived at all.' } });

async function partA() {
  console.log('[A1] opening a dispute marks the canonical state');
  await wipe(); await order('O1', 'delivered');
  const r = await openDispute('O1');
  const d = await getv('disputes/dp_O1'), o = await getv('orders/O1');
  ok(r.disputeId === 'dp_O1' && d.settlementHold === 'HELD' && d.status === 'open', `dispute dp_O1 open with settlementHold HELD (${d.settlementHold})`);
  ok(o.disputeHold && o.disputeHold.active === true && o.disputeHold.disputeId === 'dp_O1', 'order mirror disputeHold.active = true');

  console.log('\n[A2] settlement refuses while the dispute is open');
  await db.doc('orders/O1').update({ status: 'completed' });
  const s1 = await OS.settleOrder(db, admin, 'O1');
  ok(s1.outcome === 'dispute-hold' && await sellerBal() === 0 && !(await get('settlements/O1')), `settleOrder -> ${s1.outcome}; seller not credited, no settlement record`);
  ok((await getv('orders/O1')).settlementStatus === 'HELD' && (await getv('orders/O1')).settlementNote === 'dispute_open', 'order parked HELD / dispute_open');

  console.log('\n[A3] auto-confirm refuses while the dispute is open; undisputed control still confirms');
  await wipe();
  /* 5 days: past the 3-day auto-confirm window, inside createDispute's own 30-day dispute window. */
  const old = TS.fromMillis(Date.now() - 5 * 86400000);
  await order('SW_D', 'delivered', { deliveredAt: old, createdAt: TS.now() });
  await order('SW_C', 'delivered', { deliveredAt: old });
  await openDispute('SW_D');
  await OS.autoConfirmDeliveredOrders(db, admin);
  ok((await getv('orders/SW_D')).status === 'delivered', 'disputed delivered order NOT auto-completed');
  ok((await getv('orders/SW_C')).status === 'completed', 'CONTROL: undisputed delivered order IS auto-completed');

  console.log('\n[A4] CONTROL: an undisputed completed order still settles');
  await wipe(); await order('O4', 'completed');
  const s4 = await OS.settleOrder(db, admin, 'O4');
  ok(s4.outcome === 'settled' && await sellerBal() > 0, `settled; seller credited KES ${await sellerBal()}`);

  console.log('\n[A5] closing the dispute restores the lifecycle');
  await wipe(); await order('O5', 'delivered'); await openDispute('O5');
  await db.doc('orders/O5').update({ status: 'completed' });
  await OS.settleOrder(db, admin, 'O5');
  const c = await tryRun(disputes.cancelDispute, { auth: { uid: BUYER, token: {} }, data: { disputeId: 'dp_O5' } });
  ok(c.settlementHold === 'RELEASED' && c.settlement === 'settled' && await sellerBal() > 0, `buyer withdraws -> hold RELEASED, parked order settled (${c.settlement}, KES ${await sellerBal()})`);
  ok(((await getv('orders/O5')).disputeHold || {}).active === false, 'order mirror cleared');
  const bal = await sellerBal();
  await tryRun(disputes.cancelDispute, { auth: { uid: BUYER, token: {} }, data: { disputeId: 'dp_O5' } });
  ok(await sellerBal() === bal, 'a repeated withdrawal does not settle twice');

  await wipe(); await order('O6', 'delivered'); await openDispute('O6');
  await db.doc('orders/O6').update({ status: 'completed' });
  await OS.settleOrder(db, admin, 'O6');
  const a1 = await tryRun(disputes.adminResolveDispute, { auth: ADMINCTX, data: { disputeId: 'dp_O6', action: 'resolved', resolution: 'Refunded buyer' } });
  ok(a1.settlementHold === 'HELD' && await sellerBal() === 0 && (await OS.settleOrder(db, admin, 'O6')).outcome === 'dispute-hold',
    'admin RESOLVES without releaseSettlement -> hold retained (fail-closed), seller not settled');
  const a2 = await tryRun(disputes.adminResolveDispute, { auth: ADMINCTX, data: { disputeId: 'dp_O6', action: 'closed', resolution: 'Seller was right', releaseSettlement: true } });
  ok(a2.settlementHold === 'RELEASED' && a2.settlement === 'settled' && await sellerBal() > 0, `admin closes WITH releaseSettlement -> settled (${a2.settlement})`);
  const a3 = await tryRun(disputes.adminResolveDispute, { auth: ADMINCTX, data: { disputeId: 'dp_O6', action: 'investigating' } });
  ok(a3.settlementHold === 'HELD', 're-opening (investigating) re-applies the hold');

  console.log('\n[A6] the order flags are NOT the authority (a forged or stale mirror decides nothing)');
  await wipe(); await order('O7', 'completed'); await openDispute('O7');
  await db.doc('orders/O7').update({ disputeHold: { active: false }, disputeOpen: false, hasDispute: false });
  ok((await OS.settleOrder(db, admin, 'O7')).outcome === 'dispute-hold' && await sellerBal() === 0, 'mirror forged to "no dispute" -> still held');
  await wipe(); await order('O8', 'completed', { disputeHold: { active: true }, disputeOpen: true });
  ok((await OS.settleOrder(db, admin, 'O8')).outcome === 'settled', 'mirror forged to "disputed" with no dispute record -> settles (cannot manufacture a hold)');

  console.log('\n[A7] a dispute racing a settlement cannot produce an unintended seller settlement');
  let violations = 0, held = 0, settledFirst = 0;
  for (let i = 0; i < 12; i++) {
    await wipe(); await order('R', 'completed');
    await Promise.allSettled([openDispute('R'), OS.settleOrder(db, admin, 'R')]);
    const st = await get('settlements/R'), dp = await get('disputes/dp_R');
    if (st && dp) {
      const settledMs = st.createdAt && st.createdAt.toMillis ? st.createdAt.toMillis() : Number(st.createdAt);
      const disputedMs = dp.createdAt && dp.createdAt.toMillis ? dp.createdAt.toMillis() : Number(dp.createdAt);
      if (settledMs > disputedMs) violations++; else settledFirst++;
    } else if (!st) held++;
  }
  ok(violations === 0, `12 races: ${held} held, ${settledFirst} settled strictly BEFORE the dispute, ${violations} settled after it`);
}

async function partB() {
  let RUT;
  try { RUT = require('@firebase/rules-unit-testing'); } catch (e) { ok(false, 'rules-unit-testing available (' + e.message + ')'); return; }
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  const sets = [];
  if (process.env.SERVED_RULES_PATH && fs.existsSync(process.env.SERVED_RULES_PATH)) sets.push(['SERVED', fs.readFileSync(process.env.SERVED_RULES_PATH, 'utf8'), true]);
  else console.log('  (SERVED_RULES_PATH not set — served ruleset NOT tested)');
  sets.push(['repo build', fs.readFileSync(path.join(__dirname, '..', 'firestore.rules.build'), 'utf8'), true]);
  sets.push(['COUNTERPROOF allow-all', "rules_version = '2';\nservice cloud.firestore { match /databases/{d}/documents { match /{x=**} { allow read, write: if true; } } }", false]);

  for (const [label, rules, expectDenied] of sets) {
    console.log(`\n[B] ${label} ruleset`);
    let env;
    /* Project ids must be lowercase. A load failure is a FAIL for THIS ruleset — never a crash, never a pass. */
    try {
      env = await RUT.initializeTestEnvironment({ projectId: (PROJECT + '-rules-' + label).toLowerCase().replace(/[^a-z0-9-]/g, ''),
        firestore: { rules, host, port: Number(port) } });
    } catch (e) { ok(false, `${label}: ruleset LOAD_ERROR (${String(e.message).slice(0, 120)})`); continue; }
    try {
      await env.withSecurityRulesDisabled(async (ctx) => {
        const fdb = ctx.firestore();
        await fdb.doc('orders/RO').set({ uid: BUYER, buyerUid: BUYER, sellerUid: SELLER, status: 'delivered', total: 97 });
        await fdb.doc('disputes/dp_RO').set({ orderId: 'RO', buyerId: BUYER, uid: BUYER, buyerUid: BUYER, sellerUid: SELLER, status: 'open', settlementHold: 'HELD', evidence: [] });
      });
      const buyer = env.authenticatedContext(BUYER).firestore();
      const seller = env.authenticatedContext(SELLER).firestore();
      const attempts = [
        ['buyer CREATES a dispute doc directly', () => buyer.doc('disputes/dp_OTHER').set({ orderId: 'OTHER', status: 'open', settlementHold: 'HELD' })],
        ['buyer lifts the hold (settlementHold RELEASED)', () => buyer.doc('disputes/dp_RO').update({ settlementHold: 'RELEASED' })],
        ['buyer closes the dispute (status)', () => buyer.doc('disputes/dp_RO').update({ status: 'closed' })],
        ['seller lifts the hold', () => seller.doc('disputes/dp_RO').update({ settlementHold: 'RELEASED', status: 'closed' })],
        ['seller deletes the dispute', () => seller.doc('disputes/dp_RO').delete()],
        ['buyer writes the order mirror', () => buyer.doc('orders/RO').update({ disputeHold: { active: false } })],
        ['seller writes the order mirror / legacy flag', () => seller.doc('orders/RO').update({ disputeHold: { active: false }, disputeOpen: false })],
      ];
      for (const [what, fn] of attempts) {
        let denied = false;
        try { await fn(); } catch (e) { denied = /PERMISSION_DENIED|permission/i.test(e.code || e.message); }
        ok(denied === expectDenied, `${what}: ${denied ? 'DENIED' : 'ALLOWED'}${expectDenied ? '' : ' (counterproof must allow)'}`);
      }
      if (expectDenied) {
        let allowed = true;
        try { await buyer.doc('disputes/dp_RO').update({ evidence: [{ type: 'photo', description: 'x' }] }); } catch (_) { allowed = false; }
        ok(allowed, 'CONTROL: the buyer CAN add evidence (the harness is exercising real rules, not denying everything)');
      }
    } finally { await env.cleanup(); }
  }
}

(async () => {
  await partA();
  await partB();
  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH (not a verdict):', e && e.stack || e); process.exit(3); });
