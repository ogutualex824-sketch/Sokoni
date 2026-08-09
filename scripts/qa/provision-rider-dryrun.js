'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   RIDER PROVISIONING DRY-RUN — exercises the CANONICAL onboarding path end-to-end
   so you can prove a rider becomes dispatchable BEFORE spending real money in the
   RC checkout gate. It does NOT hand-write operational docs: it creates a driver
   APPLICATION (the real input) and lets the DEPLOYED applicationLifecycle trigger
   run projectDriver, exactly as an admin approval would.

     node scripts/qa/provision-rider-dryrun.js <UID> [plate] [vehicleType]

   Example (alexochieng3030 / KASS operator, Boxer BM125):
     node scripts/qa/provision-rider-dryrun.js D5Ql2EYr95bt79IpcGTmOMTK0P83 KMGQ748T motorcycle

   ID/DL PHOTOS ARE SKIPPED (owner-authorised for this account) — they are a KYC
   concern (driverVerification.documentsMissing), NOT a provisioning blocker. A real
   rider would upload them in driver.html; this backend path is a controlled test.

   Steps + what it proves:
     1. create applications/{id} (status pending, uid injected)   → submission works
     2. approve it → DEPLOYED trigger runs projectDriver           → provisioning works
     3. poll rideDrivers/{uid} until it appears                    → operational record created
     4. read drivers / driverVerification / users.roles           → all records + role granted
     5. set isOnline:true (what driver.html go-online does)        → go-online works
     6. count rideDrivers where isOnline==true                     → rider is DISCOVERABLE by dispatch

   Requires admin creds (GOOGLE_APPLICATION_CREDENTIALS or `gcloud auth
   application-default login`) and NODE_PATH=functions/node_modules (for firebase-admin).
   Prints the appId at the end so you can clean up the test application if desired.

   IF ANY STEP FAILS: do NOT hand-create the missing doc. Fix the canonical path
   (submission / approval trigger / go-online write) so every future rider is provisioned
   the same way. That keeps the RC clean.
   ───────────────────────────────────────────────────────────────────────────── */
const admin = require('firebase-admin');

const UID   = process.argv[2];
const PLATE = (process.argv[3] || 'KMGQ748T').toUpperCase();
const VTYPE = process.argv[4] || 'motorcycle';
if (!UID) { console.error('Usage: node scripts/qa/provision-rider-dryrun.js <UID> [plate] [vehicleType]'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'sokoni-aeb26' });
  const db = admin.firestore();
  const now = () => admin.firestore.FieldValue.serverTimestamp();

  /* Guard: don't double-provision. */
  const existing = await db.collection('rideDrivers').doc(UID).get();
  if (existing.exists) {
    console.log(`rideDrivers/${UID} already exists — rider already provisioned:`,
      JSON.stringify({ status: existing.data().status, isOnline: existing.data().isOnline }));
    console.log('Set isOnline via driver.html go-online, or delete the doc to re-run the dry-run.');
    process.exit(0);
  }

  const appId = 'DRV' + Date.now();

  /* 1. Application (uid injected, ID/DL skipped for this account) */
  await db.collection('applications').doc(appId).set({
    id: appId, uid: UID, name: 'Kaspa', phone: '',
    type: 'driver', hub: 'delivery',
    category: VTYPE, vehicle: VTYPE, vehicleType: VTYPE, plate: PLATE,
    location: 'Nairobi', status: 'pending',
    idPhotoSkipped: true, dlPhotoSkipped: true,
    createdAt: now(), submittedAt: new Date().toISOString(), _dryRun: true,
  });
  console.log(`1) application created: ${appId} (pending, ID/DL skipped)`);
  await sleep(3000);

  /* 2. Approve → deployed applicationLifecycle trigger runs projectDriver */
  await db.collection('applications').doc(appId).set(
    { status: 'approved', decidedBy: 'backend-dry-run', decidedAt: now() }, { merge: true });
  console.log('2) application -> approved; waiting for deployed projectDriver...');

  /* 3. Poll rideDrivers (trigger is async, ~a few seconds) */
  let rd = null;
  for (let i = 0; i < 12; i++) {
    await sleep(4000);
    const s = await db.collection('rideDrivers').doc(UID).get();
    if (s.exists) { rd = s.data(); console.log(`   rideDrivers appeared after ~${(i + 1) * 4}s`); break; }
    console.log(`   ...${(i + 1) * 4}s no rideDrivers yet`);
  }

  const app = (await db.collection('applications').doc(appId).get()).data();
  console.log(`\n3) application.projectionStatus: ${app.projectionStatus} | receipt: ${JSON.stringify(app.projectionReceipt || null)}`);
  if (!rd) { console.log(`FAIL: rideDrivers not created — fix the approval trigger/projectDriver, do NOT hand-create. appId=${appId}`); process.exit(2); }

  /* 4. Verify the full record set */
  console.log('4) rideDrivers:', JSON.stringify({ uid: rd.uid, vehicleType: rd.vehicleType, plate: rd.plate, status: rd.status, isOnline: rd.isOnline }));
  const drv = await db.collection('drivers').doc(UID).get();
  const dv  = await db.collection('driverVerification').doc(UID).get();
  const u   = (await db.collection('users').doc(UID).get()).data();
  console.log('   drivers:', drv.exists, '| driverVerification:', dv.exists,
    dv.exists ? ('docsMissing=' + JSON.stringify(dv.data().documentsMissing || null)) : '',
    '| roles:', JSON.stringify(u.roles), '| isDriver:', u.isDriver, '| isRider:', u.isRider);

  /* 5. Go-online (mirrors driver.html _setRiderOnline) */
  await db.collection('rideDrivers').doc(UID).update({ isOnline: true, status: 'active', updatedAt: now() });
  const on = (await db.collection('rideDrivers').doc(UID).get()).data();
  console.log('5) go-online -> isOnline:', on.isOnline, '| status:', on.status);

  /* 6. Dispatch discoverability */
  const cand = await db.collection('rideDrivers').where('isOnline', '==', true).get();
  console.log('6) dispatch candidate set (isOnline==true):', cand.size, cand.size > 0 ? '-> DISCOVERABLE' : '-> NOT discoverable');

  console.log(`\nDONE. appId=${appId} (delete applications/${appId} to clean up the test application).`);
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(3); });
