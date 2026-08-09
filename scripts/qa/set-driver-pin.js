/* ────────────────────────────────────────────────────────────────────────────
   set-driver-pin.js — set the KASS rider's driver login PIN.
   Driver = rideDrivers/{D5Ql2} (same account as the KASS shop, phone 0705726803).
   The client login previously only checked localStorage (lost on a fresh device);
   now driver.html falls back to rideDrivers by phone, and this persists the PIN.

   USAGE:  node scripts/qa/set-driver-pin.js            # PIN 3030
           node scripts/qa/set-driver-pin.js 1234
   ──────────────────────────────────────────────────────────────────────────── */
'use strict';
const admin = require('../../functions/node_modules/firebase-admin');
admin.initializeApp({ projectId: 'sokoni-aeb26' });
const db = admin.firestore();

const UID = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';
const pin = String(process.argv[2] || '3030').replace(/\D/g, '').slice(0, 6) || '3030';

(async () => {
  const ts = admin.firestore.FieldValue.serverTimestamp();
  for (const col of ['rideDrivers', 'drivers']) {
    const ref = db.collection(col).doc(UID);
    const snap = await ref.get();
    if (!snap.exists) { console.log(`${col}/${UID} — absent, skipped`); continue; }
    await ref.set({ pin, updatedAt: ts }, { merge: true });
    console.log(`${col}/${UID} — pin set to ${pin} (phone ${snap.data().phone || '?'})`);
  }
  console.log('\nDone. Driver login: phone 0705726803 · PIN ' + pin);
})().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
