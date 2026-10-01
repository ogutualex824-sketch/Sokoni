#!/usr/bin/env node
'use strict';
/* ============================================================================
   Booking PIN — no credit without a verified PIN, even if the payment lands mid-completion
   ----------------------------------------------------------------------------
   sokoni-70 review 2026-10-01: providerCompleteBooking checked the PIN only when the booking was
   ALREADY paid_held when first read. If the payment landed between that read and the settlement
   transaction, the transaction saw paid_held and credited the provider WITHOUT a PIN.
   Real module (functions/provider-ops.js) with Firestore = in-memory fake and its heavy neighbours
   stubbed; the race is injected inside calculateCommission, which runs between the read and the txn.
     A  pending at read → paid_held before the txn → REFUSED, nothing credited, booking not completed
     B  paid_held + envelope VERIFIED → completes and credits exactly once (retry is a no-op)
     C  unpaid booking (no money held) still completes without a PIN (nothing to release)
     D  sabotage: without the in-txn check, case A credits — the suite catches it
   node scripts/test-booking-pin-race.js
   ============================================================================ */
const path = require('path'), fs = require('fs'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 300) : '')); } };

const F = makeFakeFirestore();
let onCommission = null;
const res = (r) => Module._resolveFilename(r, { id: path.join(FN, 'x.js'), filename: path.join(FN, 'x.js'), paths: Module._nodeModulePaths(FN) });
const stub = (r, e) => { const f = res(r); require.cache[f] = { id: f, filename: f, loaded: true, exports: e }; };
stub('firebase-admin/firestore', { getFirestore: () => F.db, FieldValue: F.FieldValue, Timestamp: F.Timestamp });
stub(path.join(FN, 'legal-agreements.js'), { assertLegalCompliance: async () => ({}) });
stub(path.join(FN, 'subscription-core.js'), {});
stub(path.join(FN, 'reservation-core.js'), {});
stub(path.join(FN, 'booking-events.js'), { bookingEvent: async () => {}, TYPES: new Proxy({}, { get: (t, k) => String(k) }) });
stub(path.join(FN, 'finos-utils.js'), { calculateCommission: async () => { if (onCommission) await onCommission(); return { commissionCents: 1000, effectiveRate: 10 }; } });
stub(path.join(FN, 'booking-pin-core.js'), { _internal: { verifyForCompletion: async () => ({ ok: true }) } });

function load(file) { const f = require.resolve(file); delete require.cache[f]; return require(f); }
const SRC = path.join(FN, 'provider-ops.js');
const credits = async () => [...F.db._store.keys()].filter((k) => k.startsWith('walletTransactions/')).length;
async function call(P, bookingId, pin) {
  try { return { ok: true, v: await P._h.providerCompleteBooking({ auth: { uid: 'prov1', token: {} }, data: { bookingId, pin } }) }; }
  catch (e) { return { ok: false, code: e.code, msg: e.message }; }
}
async function booking(id, paymentStatus, verified) {
  await F.db.collection('providerBookings').doc(id).set({ providerId: 'prov1', customerUid: 'buyer1', status: 'confirmed', paymentStatus, price: 10000, fee: 0 });
  if (verified !== undefined) await F.db.collection('entBookings').doc('svc_' + id).set({ verification: { state: verified ? 'VERIFIED' : 'NOT_VERIFIED' } });
}

(async () => {
  console.log('Booking PIN — race into settlement\n');
  let P = load(SRC);

  await booking('bRace', 'pending', false);
  onCommission = async () => { await F.db.collection('providerBookings').doc('bRace').update({ paymentStatus: 'paid_held' }); };
  const a = await call(P, 'bRace', undefined);
  onCommission = null;
  const aDoc = (await F.db.collection('providerBookings').doc('bRace').get()).data();
  ck('A1 payment lands between the read and the txn → completion REFUSED (PIN required)', !a.ok && a.code === 'failed-precondition' && /PIN/.test(a.msg), a);
  ck('A2 nothing credited and the booking is not completed (funds stay held)', (await credits()) === 0 && aDoc.status === 'confirmed' && aDoc.paymentStatus === 'paid_held', aDoc);

  await booking('bOk', 'paid_held', true);
  const b1 = await call(P, 'bOk', '1234');
  const b2 = await call(P, 'bOk', '1234');
  const bDoc = (await F.db.collection('providerBookings').doc('bOk').get()).data();
  ck('B1 held + PIN verified → completed, settled, credited once', b1.ok && bDoc.status === 'completed' && bDoc.paymentStatus === 'settled' && (await credits()) === 1, { b1, bDoc });
  ck('B2 a retry is a no-op (still exactly one credit)', b2.ok && (await credits()) === 1, b2);

  await booking('bUnpaid', 'unpaid');
  const c = await call(P, 'bUnpaid', undefined);
  ck('C1 an unpaid booking (no held money) completes without a PIN and credits nothing', c.ok && (await credits()) === 1, c);

  /* E — cancel vs complete (STOP S2) */
  await booking('bCancelRace', 'paid_held', true);
  onCommission = async () => { await F.db.collection('providerBookings').doc('bCancelRace').update({ status: 'cancelled' }); };
  const before = await credits();
  const e1 = await call(P, 'bCancelRace', '1234');
  onCommission = null;
  const eDoc = (await F.db.collection('providerBookings').doc('bCancelRace').get()).data();
  ck('E1 a cancel landing mid-completion wins: completion refused, nothing credited, booking stays cancelled', !e1.ok && e1.code === 'failed-precondition' && (await credits()) === before && eDoc.status === 'cancelled', { e1, eDoc });
  const e2 = await (async () => { try { return { ok: true, v: await P._h.providerCancelBooking({ auth: { uid: 'prov1', token: {} }, data: { bookingId: 'bOk' } }) }; } catch (e) { return { ok: false, code: e.code }; } })();
  const okDoc = (await F.db.collection('providerBookings').doc('bOk').get()).data();
  ck('E2 cancelling a completed booking is refused (it stays completed + settled)', !e2.ok && e2.code === 'failed-precondition' && okDoc.status === 'completed', { e2, okDoc });

  /* F — decline of a paid booking refunds it (STOP S4) */
  await booking('bDecline', 'paid_held', false);
  const decl = async () => { try { return { ok: true, v: await P._h.providerDeclineBooking({ auth: { uid: 'prov1', token: {} }, data: { bookingId: 'bDecline' } }) }; } catch (e) { return { ok: false, code: e.code, msg: e.message }; } };
  const creditsBefore = await credits();
  const f1 = await decl();
  const fDoc = (await F.db.collection('providerBookings').doc('bDecline').get()).data();
  const buyer = (await F.db.collection('users').doc('buyer1').get()).data() || {};
  ck('F1 declining a PAID booking refunds the customer in full and credits the provider nothing', f1.ok && fDoc.status === 'declined' && fDoc.paymentStatus === 'refunded' && buyer.walletBalance === 100 && (await credits()) === creditsBefore, { f1, fDoc, buyer });
  const f2 = await decl();
  const buyer2 = (await F.db.collection('users').doc('buyer1').get()).data() || {};
  ck('F2 a second decline is a no-op (no second refund)', f2.ok && buyer2.walletBalance === 100, { f2, buyer2 });

  /* sabotage: remove the in-txn PIN requirement → case A must credit */
  const orig = fs.readFileSync(SRC, 'utf8');
  const sab = orig.replace(/    if \(isHeld\) \{\n      const envSnap[\s\S]*?\n    \}\n/, '');
  if (sab === orig) ck('D0 sabotage anchor present', false);
  else {
    const tmp = path.join(FN, '.sabotage-provider-ops.js');
    fs.writeFileSync(tmp, sab);
    try {
      const S = load(tmp);
      await booking('bSab', 'pending', false);
      onCommission = async () => { await F.db.collection('providerBookings').doc('bSab').update({ paymentStatus: 'paid_held' }); };
      const before = await credits();
      await call(S, 'bSab', undefined);
      onCommission = null;
      ck('D1 sabotage (no in-txn PIN check) → the race CREDITS without a PIN — the suite would catch it', (await credits()) === before + 1);
    } finally { fs.unlinkSync(tmp); delete require.cache[tmp]; }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
