'use strict';
/* D1-A — governed approved-driver -> Business provisioning. Emulator-backed; drives the REAL
 * projectDriver and the REAL _ensureBusinessForOwner.
 *
 *   firebase emulators:exec --only firestore "node scripts/test-d1a-driver-business-provisioning.js"
 *
 * The constraints under test are mostly things that must NOT happen — no second business, no
 * shop, no vehicle, no seller subscription, no buyer identity, no eligibility. Absence is easy to
 * assert accidentally (query the wrong collection and everything is absent), so each negative is
 * paired with a positive that proves the probe can see: the merchant path IS still given a seller
 * subscription, and provisioning DOES create a business. */
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
const ROOT = path.join(__dirname, '..');

process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-d1a';
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

const AL = require(path.join(ROOT, 'functions', 'application-lifecycle'))._internal;
const BB = require(path.join(ROOT, 'functions', 'business-bootstrap'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== null && d !== '' ? '   [' + String(d).slice(0, 78) + ']' : '')); ok ? pass++ : fail++; };
const ckSafe = async (l, fn, d) => { try { ck(l, (await fn()) === true, d); } catch (e) { ck(l, false, 'THREW: ' + e.message); } };

const UID = 'driver-uid-1';
const APP = {
  applicationId: 'APP-D1A-1', name: 'Test Rider', phone: '+254700000001',
  vehicleType: 'motorcycle', plate: 'KAA100A', city: 'Nairobi', area: 'Westlands',
  nationalId: '12345678', dlNumber: 'DL-998877', dlExpiry: '2030-01-01',
};
const count = async (c) => (await db.collection(c).get()).size;

(async () => {
  console.log('\nD1-A — APPROVED DRIVER -> BUSINESS PROVISIONING\n' + '='.repeat(64));

  console.log('\n1 - approval provisions a business');
  const r1 = await AL.projectDriver(db, APP, UID, true);
  ck('1  the receipt carries the business result', !!(r1 && r1.business), r1 && JSON.stringify(r1.business));
  const bizId = r1.business.merchantId;
  ck('1b a business was provisioned', r1.business.action === 'provisioned' && !!bizId, bizId);
  ck('1c the id is SOK-*, NEVER businesses/{uid}', /^SOK-[A-Z0-9]+$/.test(bizId || ''), bizId);
  const bizDoc = (await db.collection('businesses').doc(bizId).get()).data();
  ck('1d ownerId is the driver uid', bizDoc && bizDoc.ownerId === UID, bizDoc && bizDoc.ownerId);
  ck('1e businessType records it as delivery', bizDoc && bizDoc.businessType === 'delivery', bizDoc && bizDoc.businessType);
  ck('1f no businesses doc is keyed by the uid', !(await db.collection('businesses').doc(UID).get()).exists);

  console.log('\n2 - repeat approval is idempotent');
  const before = await count('businesses');
  const r2 = await AL.projectDriver(db, APP, UID, true);
  ck('2  the second approval does NOT create a second business', (await count('businesses')) === before,
    before + ' -> ' + (await count('businesses')));
  ck('2b it reports already-provisioned', r2.business.action === 'already-provisioned', r2.business.action);
  ck('2c and returns the SAME business id', r2.business.merchantId === bizId, r2.business.merchantId);

  console.log('\n3 - what provisioning must NOT do');
  ck('3  no shops document was created', (await count('shops')) === 0, (await count('shops')) + ' shops');
  ck('3b no vehicle was auto-created', (await count('vehicles')) === 0, (await count('vehicles')) + ' vehicles');
  const userDoc = await db.collection('users').doc(UID).get();
  ck('3c no buyer/seller identity written to users/{uid}', !userDoc.exists, userDoc.exists ? JSON.stringify(userDoc.data()) : 'absent');
  const subs = await db.collection('subscriptions').doc(bizId).get();
  ck('3d NO seller subscription for a delivery business', !subs.exists,
    subs.exists ? JSON.stringify(subs.data().hubType) + '/' + subs.data().planId : 'absent');

  /* POSITIVE CONTROL for 3d — if the probe simply looked in the wrong place, this would fail. */
  console.log('\n4 - positive control: the MERCHANT path is unchanged');
  const m = await BB._ensureBusinessForOwner({ uid: 'merchant-uid-1', businessName: 'A Shop', category: 'retail' });
  const msub = await db.collection('subscriptions').doc(m.merchantId).get();
  ck('4  a normal merchant provisioning STILL gets its seller subscription', msub.exists,
    msub.exists ? msub.data().hubType + '/' + msub.data().planId : 'MISSING — the opt-out leaked');
  ck('4b so 3d measured a real difference, not an empty collection', msub.exists && !subs.exists);

  console.log('\n5 - retraction is not provisioning');
  const r3 = await AL.projectDriver(db, APP, 'driver-uid-2', false);
  ck('5  a rejected/suspended application provisions NO business',
    !r3.business && (await db.collection('businesses').where('ownerId', '==', 'driver-uid-2').get()).empty,
    r3.action);

  console.log('\n6 - provisioning is NOT an approval mechanism');
  const elig = fs.readFileSync(path.join(ROOT, 'functions', 'rider-eligibility.js'), 'utf8');
  ck('6  rider-eligibility never reads `businesses`', !/collection\('businesses'\)/.test(elig));
  ck('6b eligibility still rests on drivers + driverVerification',
    /collection\('drivers'\)/.test(elig) && /collection\('driverVerification'\)/.test(elig));
  const drv = (await db.collection('drivers').doc(UID).get()).data();
  /* The realistic production shape: an application carrying NO identifiers, which is what every
     one of the 10 live applications looks like. The driver gets a business, and must still be
     refused — a business is somewhere to put a vehicle, not a substitute for verification. */
  const BARE = { applicationId: 'APP-D1A-2', name: 'Unverified Rider', phone: '+254700000009',
    vehicleType: 'motorcycle', plate: 'KAA200B', city: 'Nairobi' };
  const r6 = await AL.projectDriver(db, BARE, 'driver-uid-3', true);
  const E6 = require(path.join(ROOT, 'functions', 'rider-eligibility'));
  const d6 = (await db.collection('drivers').doc('driver-uid-3').get()).data();
  const v6 = (await db.collection('driverVerification').doc('driver-uid-3').get()).data();
  ck('6c a driver WITH a business but incomplete verification is still refused',
    !!r6.business.merchantId && E6.evaluate(d6, v6).eligible === false,
    'business ' + r6.business.merchantId + ' -> ' + E6.evaluate(d6, v6).reason);

  console.log('\n7 - the rest of the driver projection survived');
  ck('7  drivers/{uid} written', !!drv && drv.approved === true, drv && drv.status);
  ck('7b driverVerification written', (await db.collection('driverVerification').doc(UID).get()).exists);
  ck('7c rideDrivers/{uid} written', (await db.collection('rideDrivers').doc(UID).get()).exists);
  ck('7d the rider is created OFFLINE (approval is not presence)', drv.available === false || drv.onlineStatus === 'offline',
    'available=' + drv.available + ' onlineStatus=' + drv.onlineStatus);

  /* THE INTEGRATION LINK. The DL-01 unit suite builds its own driver fixtures, so it can only
     prove the gate refuses the wrong shapes — never that the shape the REAL projection produces
     is accepted. It wasn't: projectDriver wrote `approvedAt` and `status:'active'` but no
     `approved` flag, so every genuinely approved driver would have been refused in production.
     This assertion is the one that catches that class of defect, and it belongs here because
     only this suite has both halves. */
  const E = require(path.join(ROOT, 'functions', 'rider-eligibility'));
  await db.collection('driverVerification').doc(UID)
    .set({ documentsComplete: true, status: 'verified_on_file' }, { merge: true });
  const drvNow = (await db.collection('drivers').doc(UID).get()).data();
  const verNow = (await db.collection('driverVerification').doc(UID).get()).data();
  const verdict = E.evaluate(drvNow, verNow);
  ck('7e a driver from the REAL projection, once verified, IS dispatch-eligible',
    verdict.eligible === true, verdict.reason);

  console.log('\n' + '-'.repeat(64));
  console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('  FAIL  SUITE THREW   [' + e.message + ']');
  console.log('RESULT: ' + pass + ' passed, ' + (fail + 1) + ' failed');
  process.exit(1);
});
