#!/usr/bin/env node
'use strict';
/* ============================================================================
   The service-booking "order" record is a VIEW — no live order trigger can act on it
   ----------------------------------------------------------------------------
   2026-10-01 audit (STOP S1): mirrorServiceOrder wrote orders/{bookingId} with sellerUid =
   providerId and status copied from the booking. Live onOrderStatusChange settles an order whose
   status becomes "completed" WITH a sellerUid → it would credit the provider a SECOND time beside
   providerCompleteBooking; it also auto-assigns a rider on "confirmed", and onNewOrderCreated
   notifies the seller. Real function (booking-pin-core.mirrorServiceOrder) on the in-memory fake.
     A  across pending → paid_held → confirmed → completed/settled, the record never carries a field a
        live order trigger acts on (status, orderStatus, sellerUid, sellerId, paymentVerified, hubId,
        assignedDriverUid, riderId)
     B  it still records what the buyer needs: type service_booking, booking state, escrow amounts
     C  the gates of the live triggers (copied verbatim from the live archive) all return early on it
   node scripts/test-service-order-mirror-inert.js
   ============================================================================ */
const path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 300) : '')); } };
const F = makeFakeFirestore();
const res = (r) => Module._resolveFilename(r, { id: path.join(FN, 'x.js'), filename: path.join(FN, 'x.js'), paths: Module._nodeModulePaths(FN) });
const stub = (r, e) => { const f = res(r); require.cache[f] = { id: f, filename: f, loaded: true, exports: e }; };
stub('firebase-admin/firestore', { getFirestore: () => F.db, FieldValue: F.FieldValue, Timestamp: F.Timestamp });
const C = require(path.join(FN, process.env.BPC || 'booking-pin-core.js'))._internal;
const FORBIDDEN = ['status', 'orderStatus', 'sellerUid', 'sellerId', 'paymentVerified', 'hubId', 'assignedDriverUid', 'riderId'];

/* Gates of the live order triggers (live archive onorderstatuschange-00065-fud) — an order write is
   acted on only if one of these returns true. */
const GATES = {
  onOrderStatusChange_settle: (b, a) => !!(b && a) && b.status !== a.status && a.status === 'completed' && !!a.sellerUid,
  onOrderStatusChange_any: (b, a) => !!(b && a) && b.status !== a.status,
  onNewOrderCreated: (d) => (d.status === 'paid' || d.paymentVerified === true) && !!(d.sellerUid || d.sellerId),
  emailOnOrderCreated: (d) => d.status === 'paid' || d.paymentVerified === true,
  messages_assignment: (b, a) => (b.status || b.orderStatus) !== (a.status || a.orderStatus),
  hubEtims: (b, a) => !!a.hubId,
};

(async () => {
  console.log('Service-booking order record is trigger-inert\n');
  const B = 'bk1';
  const stages = [
    { status: 'pending', paymentStatus: 'pending' },
    { status: 'pending', paymentStatus: 'paid_held' },
    { status: 'confirmed', paymentStatus: 'paid_held' },
    { status: 'completed', paymentStatus: 'settled' },
  ];
  let prev = null, leaks = [], fired = [];
  for (const st of stages) {
    const b = { customerUid: 'buyer1', providerId: 'prov1', service: 'Haircut', price: 200000, fee: 0, commissionHub: 'beauty', ...st };
    await C.mirrorServiceOrder(B, b, 'svc_' + B);
    const doc = (await F.db.collection('orders').doc(B).get()).data();
    FORBIDDEN.forEach((k) => { if (k in doc && doc[k] != null) leaks.push(st.status + '/' + st.paymentStatus + ':' + k); });
    if (prev) {
      if (GATES.onOrderStatusChange_settle(prev, doc)) fired.push('settle@' + st.status);
      if (GATES.onOrderStatusChange_any(prev, doc)) fired.push('statusChange@' + st.status);
      if (GATES.messages_assignment(prev, doc)) fired.push('messages@' + st.status);
      if (GATES.hubEtims(prev, doc)) fired.push('hubEtims@' + st.status);
    } else {
      if (GATES.onNewOrderCreated(doc)) fired.push('newOrder');
      if (GATES.emailOnOrderCreated(doc)) fired.push('emailCreated');
    }
    prev = doc;
  }
  ck('A1 no trigger field ever written (' + FORBIDDEN.join(', ') + ')', leaks.length === 0, leaks);
  ck('C1 no live order trigger gate opens at any stage (no second settlement, no rider, no seller notice)', fired.length === 0, fired);
  const last = prev;
  ck('B1 still the buyer\'s record: type service_booking, booking state, provider, escrow released', last.type === 'service_booking' && last.bookingStatus === 'completed' && last.bookingPaymentStatus === 'settled' && last.providerUid === 'prov1' && last.buyerUid === 'buyer1' && last.escrow && last.escrow.released === 2000, last);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
