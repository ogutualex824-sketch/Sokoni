#!/usr/bin/env node
/* test-census-4d-rules.js — sokoni-4d's four SAFE census fixes in the combined candidate (2026-10-01).
 *   C  conversations: client create DENIED (messagesDispatch is the creator); participants still read + update.
 *   A  accountProfiles (rider DOB / national ID): a stranger cannot read; the account owner and admins can.
 *   R  deliveryRiders: other users cannot read a rider's record; the rider can; the rider cannot write their own
 *      rating / trips / earnings but can still update ordinary fields.
 *   O  orders: a seller cannot set payment / dispatch states (paid, refunded, confirmed, …); a legitimate seller
 *      progress write (shipped) and a buyer cancel still pass.
 * Emulator on a private port via run-rules-suite.js; RULES_FILE is the ruleset under test.
 */
'use strict';
const fs = require('fs'), path = require('path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require(require.resolve('@firebase/rules-unit-testing', { paths: [process.cwd(), path.resolve(__dirname, '..')] }));
const RULES = path.resolve(__dirname, '..', process.env.RULES_FILE || 'firestore.rules.build');
const [host, port] = String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
let pass = 0, fail = 0;
const ck = async (label, p) => { try { await p; console.log('  PASS  ' + label); pass++; } catch (e) { console.log('  FAIL  ' + label + '   [' + String(e && e.message || e).slice(0, 110) + ']'); fail++; } };

(async () => {
  const env = await initializeTestEnvironment({ projectId: 'demo-census4d', firestore: { rules: fs.readFileSync(RULES, 'utf8'), host, port: Number(port) } });
  console.log('\nRULES: ' + path.basename(RULES));
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await db.doc('conversations/order_o1').set({ participants: ['buyer1', 'seller1'], lastMessage: '' });
    await db.doc('accountProfiles/p1').set({ accountId: 'rider1', nationalId: '12345678', dob: '1990-01-01' });
    await db.doc('deliveryRiders/rider1').set({ uid: 'rider1', name: 'R', phone: '0700000000', rating: 4.2, earnings: 1000, vehicle: 'bike' });
    await db.doc('orders/o1').set({ uid: 'buyer1', buyerUid: 'buyer1', sellerUid: 'seller1', status: 'processing', total: 500 });
    await db.doc('orders/o2').set({ uid: 'buyer1', buyerUid: 'buyer1', sellerUid: 'seller1', status: 'pending', total: 500 });
  });
  const as = (uid, claims) => env.authenticatedContext(uid, claims || {}).firestore();
  const buyer = as('buyer1'), seller = as('seller1'), rider = as('rider1'), mallory = as('mallory'), adm = as('adm', { admin: true });

  console.log('\n── C: conversations ──');
  await ck('C1  a client cannot create a conversation (even one it is in)', assertFails(mallory.doc('conversations/x1').set({ participants: ['mallory', 'seller1'] })));
  await ck('C2  POSITIVE: a participant still reads the thread', assertSucceeds(buyer.doc('conversations/order_o1').get()));
  await ck('C3  POSITIVE: a participant still updates lastMessage', assertSucceeds(buyer.doc('conversations/order_o1').update({ lastMessage: 'hi' })));
  await ck('C4  a stranger cannot read the thread', assertFails(mallory.doc('conversations/order_o1').get()));

  console.log('\n── A: accountProfiles ──');
  await ck('A1  a stranger cannot read a rider\'s national ID / DOB', assertFails(mallory.doc('accountProfiles/p1').get()));
  await ck('A2  POSITIVE: the account owner reads it', assertSucceeds(rider.doc('accountProfiles/p1').get()));
  await ck('A3  POSITIVE: an admin reads it', assertSucceeds(adm.doc('accountProfiles/p1').get()));

  console.log('\n── R: deliveryRiders ──');
  await ck('R1  another signed-in user cannot read a rider record', assertFails(mallory.doc('deliveryRiders/rider1').get()));
  await ck('R2  POSITIVE: the rider reads their own record', assertSucceeds(rider.doc('deliveryRiders/rider1').get()));
  await ck('R3  the rider cannot raise their own rating', assertFails(rider.doc('deliveryRiders/rider1').update({ rating: 5 })));
  await ck('R4  the rider cannot write their own earnings', assertFails(rider.doc('deliveryRiders/rider1').update({ earnings: 999999 })));
  await ck('R5  POSITIVE: the rider still updates an ordinary field (vehicle)', assertSucceeds(rider.doc('deliveryRiders/rider1').update({ vehicle: 'car' })));

  console.log('\n── O: orders ──');
  for (const st of ['paid', 'refunded', 'confirmed', 'pending_payment']) {
    await ck('O-' + st + '  a seller cannot set status "' + st + '"', assertFails(seller.doc('orders/o1').update({ status: st, updatedAt: 1 })));
  }
  await ck('O5  POSITIVE: a seller still marks the order shipped', assertSucceeds(seller.doc('orders/o1').update({ status: 'shipped', updatedAt: 1 })));
  await ck('O6  POSITIVE: the buyer still cancels an unpaid (pending) order', assertSucceeds(buyer.doc('orders/o2').update({ status: 'cancelled', updatedAt: 1 })));
  await env.withSecurityRulesDisabled(async (c) => {
    for (const [id, st] of [['o3', 'paid'], ['o4', 'shipped'], ['o5', 'delivered'], ['o6', 'pending_payment']]) {
      await c.firestore().doc('orders/' + id).set({ uid: 'buyer1', buyerUid: 'buyer1', sellerUid: 'seller1', status: st, total: 500 });
    }
  });
  await ck('O7  a buyer cannot cancel a PAID order (no refund flow behind it)', assertFails(buyer.doc('orders/o3').update({ status: 'cancelled', updatedAt: 1 })));
  await ck('O8  a buyer cannot cancel a SHIPPED order', assertFails(buyer.doc('orders/o4').update({ status: 'cancelled', updatedAt: 1 })));
  await ck('O9  a buyer cannot cancel a DELIVERED order', assertFails(buyer.doc('orders/o5').update({ status: 'cancelled', updatedAt: 1 })));
  await ck('O10 POSITIVE: the buyer cancels an order still awaiting payment', assertSucceeds(buyer.doc('orders/o6').update({ status: 'cancelled', updatedAt: 1 })));

  console.log('\n── P: completion-PIN server records (sokoni-70) ──');
  await env.withSecurityRulesDisabled(async (c) => {
    for (const col of ['bookingPaymentReviews', 'pinDeliveryFailures', 'pinSecurityEvents', 'deliveryPins']) await c.firestore().doc(col + '/x1').set({ uid: 'buyer1', v: 1 });
  });
  for (const col of ['bookingPaymentReviews', 'pinDeliveryFailures', 'pinSecurityEvents']) {
    await ck('P-' + col + '  POSITIVE: an admin reads it', assertSucceeds(adm.doc(col + '/x1').get()));
    await ck('P-' + col + '  the subject user cannot read it', assertFails(buyer.doc(col + '/x1').get()));
    await ck('P-' + col + '  not even an admin writes it from a client', assertFails(adm.doc(col + '/x2').set({ v: 1 })));
  }
  await ck('P-deliveryPins  stays deny-all, even for an admin', assertFails(adm.doc('deliveryPins/x1').get()));

  await env.cleanup();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
