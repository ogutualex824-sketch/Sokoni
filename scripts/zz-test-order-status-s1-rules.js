/* S1 — sellers and riders cannot mark an order paid / refunded (owner via sokoni-e3, 2026-10-04, EMERGENCY S-1).
   Emulator-backed, against a rules FILE:
     RULES_FILE=firestore.rules.hotfix-jobs  …  and  RULES_FILE=firestore.rules.build
   Baseline RULES_FILE=firestore.rules.served-f259c0b5: S1-1 / S1-2 / S1-5 / S1-6 must FAIL there (the live gap). */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs'), path = require('path');
const { doc, setDoc, updateDoc } = require('firebase/firestore');
let pass = 0, fail = 0;
const ck = (id, ok, m, d) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (ok || !d ? '' : '   [' + String(d).slice(0, 90) + ']')); ok ? pass++ : fail++; };
const allows = async (id, m, p) => { try { await assertSucceeds(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
const denies = async (id, m, p) => { try { await assertFails(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
(async () => {
  const file = process.env.RULES_FILE || 'firestore.rules.hotfix-jobs';
  const env = await initializeTestEnvironment({ projectId: 'demo-order-status-s1',
    firestore: { rules: fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), host: '127.0.0.1', port: Number(process.env.FIRESTORE_PORT || 8080) } });
  console.log('\nS1 order status   RULES_FILE=' + file + '\n');
  await env.clearFirestore();
  const order = (id, status, extra) => Object.assign({ uid: 'buy', buyerUid: 'buy', sellerUid: 'sel', assignedDriverUid: 'drv', status, total: 1000 }, extra || {});
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    await setDoc(doc(f, 'users/sel'), { uid: 'sel', status: 'active', roles: ['buyer', 'seller'] });
    await setDoc(doc(f, 'users/drv'), { uid: 'drv', status: 'active', roles: ['buyer', 'rider'] });
    await setDoc(doc(f, 'users/buy'), { uid: 'buy', status: 'active', roles: ['buyer'] });
    for (const [id, st] of [['o-pend', 'pending'], ['o-pend2', 'pending'], ['o-paid', 'paid'], ['o-paid2', 'paid'], ['o-paid3', 'paid'], ['o-rider', 'rider_assigned'], ['o-rider2', 'rider_assigned'], ['o-adm', 'pending']])
      await setDoc(doc(f, 'orders/' + id), order(id, st));
  });
  const sel = env.authenticatedContext('sel').firestore(), drv = env.authenticatedContext('drv').firestore(), adm = env.authenticatedContext('adm', { admin: true }).firestore();
  const at = (db, id) => doc(db, 'orders/' + id);
  await denies('S1-1', 'SELLER marks its own unpaid order paid (the live gap)', updateDoc(at(sel, 'o-pend'), { status: 'paid', updatedAt: 1 }));
  await denies('S1-2', 'SELLER marks its own paid order refunded (the live gap)', updateDoc(at(sel, 'o-paid'), { status: 'refunded', updatedAt: 1 }));
  await denies('S1-3', 'SELLER marks payment_failed', updateDoc(at(sel, 'o-pend'), { status: 'payment_failed', updatedAt: 1 }));
  await denies('S1-4', 'SELLER marks delivered / completed (server PIN only — served behaviour kept)', updateDoc(at(sel, 'o-paid'), { status: 'delivered', updatedAt: 1 }));
  await denies('S1-4b', 'SELLER ships an UNPAID order (shipped only from a paid / accepted stage)', updateDoc(at(sel, 'o-pend'), { status: 'shipped', updatedAt: 1 }));
  await denies('S1-4c', 'SELLER cancels a PAID order (would strand the buyer\'s money; refunds are server-side)', updateDoc(at(sel, 'o-paid3'), { status: 'cancelled', updatedAt: 1 }));
  await denies('S1-4d', 'SELLER writes paymentStatus directly (outside the key allow-list)', updateDoc(at(sel, 'o-pend'), { paymentStatus: 'paid', updatedAt: 1 }));
  await denies('S1-5', 'RIDER marks its assigned order paid', updateDoc(at(drv, 'o-rider'), { status: 'paid', updatedAt: 1 }));
  await denies('S1-6', 'RIDER marks its assigned order refunded', updateDoc(at(drv, 'o-rider'), { status: 'refunded', updatedAt: 1 }));
  await denies('S1-6b', 'RIDER marks delivered (server PIN only)', updateDoc(at(drv, 'o-rider'), { status: 'delivered', updatedAt: 1 }));
  await allows('S1-P1', 'CONTROL: SELLER ships a PAID order with a tracking number', updateDoc(at(sel, 'o-paid2'), { status: 'shipped', trackingNo: 'TRK1', updatedAt: 1 }));
  await allows('S1-P2', 'CONTROL: SELLER cancels an unpaid pending order', updateDoc(at(sel, 'o-pend2'), { status: 'cancelled', updatedAt: 1 }));
  await allows('S1-P3', 'CONTROL: SELLER adds a note without changing status', updateDoc(at(sel, 'o-paid'), { sellerNote: 'packing', updatedAt: 1 }));
  await allows('S1-P4', 'CONTROL: RIDER moves rider_assigned → picked_up', updateDoc(at(drv, 'o-rider2'), { status: 'picked_up', pickedUpAt: 1, updatedAt: 1 }));
  await allows('S1-P5', 'CONTROL: ADMIN path unaffected (isAdmin branch)', updateDoc(at(adm, 'o-adm'), { status: 'paid', updatedAt: 1 }));
  /* SERVER path: the Admin SDK bypasses rules entirely — rules-disabled write models the webhook / refund authority. */
  let srv = true; try { await env.withSecurityRulesDisabled(async (c) => { await updateDoc(doc(c.firestore(), 'orders/o-pend'), { status: 'paid', paymentStatus: 'paid' }); }); } catch (e) { srv = false; }
  ck('S1-P6', srv, 'CONTROL: SERVER (Admin SDK) still sets paid — rules never block it');
  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (not a rules result):', e.message); process.exit(2); });
