/* OR — orders status allow-lists (sokoni-5b security slice, 2026-10-03). Emulator-backed, against a rules FILE.
   Run: node scripts/build-firestore-rules.js
        RULES_FILE=firestore.rules.build FIRESTORE_PORT=<port> \
          firebase emulators:exec --only firestore --project demo-orders-status "node scripts/zz-test-orders-status-rules.js"
   Baseline (OR-S1 / OR-R1..4 must FAIL there): RULES_FILE=firestore.rules.served-f259c0b5
   CONTRACT
     seller (sellerUid): status unchanged (notes / tracking) OR cancelled from pending|pending_payment OR
                         shipped|out_for_delivery from paid|confirmed|processing|accepted|ready_for_pickup|awaiting_rider.
     rider (assignedDriverUid): status unchanged OR picked_up|in_transit|out_for_delivery from a rider stage.
     delivered / completed / payment states: server only. */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs'), path = require('path');
const { doc, setDoc, updateDoc } = require('firebase/firestore');
let pass = 0, fail = 0;
const ck = (id, ok, m, d) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (ok || !d ? '' : '   [' + String(d).slice(0, 90) + ']')); ok ? pass++ : fail++; };
const allows = async (id, m, p) => { try { await assertSucceeds(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
const denies = async (id, m, p) => { try { await assertFails(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
(async () => {
  const file = process.env.RULES_FILE || 'firestore.rules.build';
  const env = await initializeTestEnvironment({ projectId: 'demo-orders-status',
    firestore: { rules: fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), host: '127.0.0.1', port: Number(process.env.FIRESTORE_PORT || 8080) } });
  console.log('\nOR orders status allow-lists   RULES_FILE=' + file + '\n');
  await env.clearFirestore();
  const order = (id, status) => ({ uid: 'buyer1', buyerUid: 'buyer1', sellerUid: 'seller1', assignedDriverUid: 'rider1', status, total: 1000 });
  await env.withSecurityRulesDisabled(async (c) => {
    const d = c.firestore();
    for (const [id, st] of [['oPaid', 'paid'], ['oUnpaid', 'pending_payment'], ['oPending', 'pending'], ['oPaid2', 'paid'], ['oRider', 'rider_assigned'], ['oRiderPend', 'pending'], ['oNote', 'paid'], ['oRiderNote', 'in_transit']]) await setDoc(doc(d, 'orders/' + id), order(id, st));
  });
  const seller = env.authenticatedContext('seller1').firestore(), rider = env.authenticatedContext('rider1').firestore();
  console.log('── seller ──');
  await denies('OR-S1', 'seller cancels a PAID order (no refund path)', updateDoc(doc(seller, 'orders/oPaid'), { status: 'cancelled' }));
  await allows('OR-S2', 'seller cancels an UNPAID order (pending_payment)', updateDoc(doc(seller, 'orders/oUnpaid'), { status: 'cancelled' }));
  await denies('OR-S3', 'seller pending → shipped (unpaid order shipped)', updateDoc(doc(seller, 'orders/oPending'), { status: 'shipped' }));
  await allows('OR-S4', 'seller paid → shipped', updateDoc(doc(seller, 'orders/oPaid2'), { status: 'shipped' }));
  await denies('OR-S5', 'seller sets delivered (server-only delivery proof)', updateDoc(doc(seller, 'orders/oPaid'), { status: 'delivered' }));
  await denies('OR-S6', 'seller sets paid (payment state is the webhook\'s)', updateDoc(doc(seller, 'orders/oUnpaid'), { status: 'paid' }));
  await allows('OR-S7', 'seller edits sellerNote / trackingNo without changing status', updateDoc(doc(seller, 'orders/oNote'), { sellerNote: 'packed', trackingNo: 'TRK1' }));
  console.log('── rider ──');
  for (const [i, st] of [['1', 'paid'], ['2', 'refunded'], ['3', 'cancelled'], ['4', 'confirmed']]) {
    await denies('OR-R' + i, 'rider sets ' + st, updateDoc(doc(rider, 'orders/oRider'), { status: st }));
  }
  await allows('OR-R5', 'rider rider_assigned → picked_up', updateDoc(doc(rider, 'orders/oRider'), { status: 'picked_up', pickedUpAt: 1 }));
  await denies('OR-R6', 'rider pending → picked_up (not a rider stage)', updateDoc(doc(rider, 'orders/oRiderPend'), { status: 'picked_up' }));
  await denies('OR-R7', 'rider sets delivered (server-only)', updateDoc(doc(rider, 'orders/oRiderNote'), { status: 'delivered' }));
  await allows('OR-R8', 'rider updates etaMin / driverNote without changing status', updateDoc(doc(rider, 'orders/oRiderNote'), { etaMin: 12, driverNote: 'traffic' }));
  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (not a rules result):', e.message); process.exit(2); });
