#!/usr/bin/env node
'use strict';
/* ============================================================================
   Booking PIN at rest — never stored readable (sokoni-70 review, 2026-10-01)
   ----------------------------------------------------------------------------
   Real booking-pin-core on the in-memory fake.
     A  issueForBooking stores the PIN only as an HMAC hash (envelope) + AES-256-GCM ciphertext
        (secrets) — no plaintext PIN anywhere in Firestore
     B  the buyer can still view it (customerGetBookingPin decrypts) — and only the buyer
     C  the ciphertext is bound to its booking (moved to another envelope → unreadable) and
        tamper-evident (a flipped byte → unreadable, never a wrong PIN)
   node scripts/test-booking-pin-at-rest.js
   ============================================================================ */
const path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 300) : '')); } };
const F = makeFakeFirestore();
const res = (r) => Module._resolveFilename(r, { id: path.join(FN, 'x.js'), filename: path.join(FN, 'x.js'), paths: Module._nodeModulePaths(FN) });
const f = res('firebase-admin/firestore'); require.cache[f] = { id: f, filename: f, loaded: true, exports: { getFirestore: () => F.db, FieldValue: F.FieldValue, Timestamp: F.Timestamp } };
const C = require(path.join(FN, 'booking-pin-core.js'))._internal;

(async () => {
  console.log('Booking PIN at rest\n');
  const BID = 'bkRest';
  await F.db.collection('providerBookings').doc(BID).set({ customerUid: 'buyer1', providerId: 'prov1', status: 'confirmed', paymentStatus: 'paid_held', price: 100000, fee: 0, service: 'Plumbing', startTs: F.Timestamp.fromMillis(Date.now() + 3600e3), endTs: F.Timestamp.fromMillis(Date.now() + 7200e3) });
  const b = (await F.db.collection('providerBookings').doc(BID).get()).data();
  let issued = null, err = null;
  try { issued = await C.issueForBooking(BID, b); } catch (e) { err = e.message; }
  ck('A0 PIN issued for a paid_held booking', !err && issued && issued.envId, err || issued);
  const envId = issued && issued.envId;
  const all = [...F.db._store.entries()].map(([k, v]) => [k, JSON.stringify(v.data)]);
  const sec = (await F.db.collection(C.COL.SECRETS).doc(envId).get()).data();
  ck('A1 secrets doc holds ciphertext (pinEnc), no plaintext pin field', sec && sec.pinEnc && sec.pinEnc.v === 1 && !('pin' in sec), sec);

  const view = await C.customerGetBookingPin({ auth: { uid: 'buyer1' }, data: { bookingId: BID } });
  const pin = view && view.pin;
  ck('B1 the buyer still sees a 4-digit PIN (decrypted for them)', /^\d{4}$/.test(String(pin)), view);
  ck('A2 that PIN appears NOWHERE in Firestore in readable form', pin && !all.some(([, v]) => v.includes('"' + pin + '"') || v.includes(':' + pin + ',')), all.filter(([, v]) => pin && v.includes(pin)).map(([k]) => k));
  let other = null; try { await C.customerGetBookingPin({ auth: { uid: 'stranger' }, data: { bookingId: BID } }); other = 'returned'; } catch (e) { other = e.code; }
  ck('B2 nobody else can view it', other === 'permission-denied', other);

  const moved = C._decPin('svc_otherBooking', sec.pinEnc);
  ck('C1 the ciphertext is bound to its booking (decrypting under another envelope fails)', moved === null, moved);
  const bad = { ...sec.pinEnc, ct: Buffer.from(Buffer.from(sec.pinEnc.ct, 'base64').map((x, i) => (i === 0 ? x ^ 1 : x))).toString('base64') };
  ck('C2 tamper-evident: a flipped byte yields nothing, never a wrong PIN', C._decPin(envId, bad) === null);
  ck('C3 round trip', C._decPin(envId, C._encPin(envId, '0420')) === '0420');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
