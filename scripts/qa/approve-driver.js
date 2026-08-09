/* approve-driver.js — mark the KASS rider (rideDrivers/{D5Ql2}) approved so the driver
   dashboard shows "✅ Verified" instead of "⏳ Pending Review" and shift management works.
   Sets approved:true + status:'approved' on both rideDrivers and drivers mirrors.
   toggleOnline() later writes status 'active'/'offline'; the dashboard now treats
   approved:true OR status active/online as verified, so the badge stays correct.
   USAGE: node scripts/qa/approve-driver.js [uid] */
'use strict';
const admin = require('../../functions/node_modules/firebase-admin');
admin.initializeApp({ projectId: 'sokoni-aeb26' });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const UID = process.argv[2] || 'D5Ql2EYr95bt79IpcGTmOMTK0P83';

(async () => {
  const ts = admin.firestore.FieldValue.serverTimestamp();
  for (const col of ['rideDrivers', 'drivers']) {
    const ref = db.collection(col).doc(UID);
    const snap = await ref.get();
    if (!snap.exists) { console.log(`${col}/${UID} — absent, skipped`); continue; }
    const d = snap.data() || {};
    await ref.set({ approved: true, status: 'approved', approvedAt: ts, updatedAt: ts }, { merge: true });
    console.log(`${col}/${UID} — approved (was status='${d.status || '?'}', approved=${d.approved})  name=${d.name || '?'}  phone=${d.phone || '?'}`);
  }
  console.log('\nDone. Rider is Verified. Hard-reload /driver.');
})().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
