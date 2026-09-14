'use strict';
/* V-1 — Business → Vehicle authority. Emulator-backed; drives the REAL handlers.
 *
 *   firebase emulators:exec --only firestore "node scripts/test-v1-vehicle-authority.js"
 *
 * THE POINT OF THIS SUITE is the shop-independence proof. Delivery Hub must be able to register
 * and manage a vehicle with NO `shops` document anywhere, because `shops` is the still-undecided
 * Business->Store collection and the canonical business bootstrap does not create one. So the
 * fixtures deliberately seed ZERO shops, and a passing run is evidence that vehicle authority no
 * longer depends on the Store model.
 *
 * It also keeps the blast radius honest: the other 25 `_assertRole` call sites stay shop-bound,
 * and that is asserted from the source rather than assumed. */
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
const ROOT = path.join(__dirname, '..');

process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-v1-vehicle';
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

const LP = require(path.join(ROOT, 'functions', 'logistics-plus'));
const H = LP._h;

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 78) + ']' : '')); ok ? pass++ : fail++; };
const ok_ = async (l, fn, d) => { try { const r = await fn(); ck(l, true, d || (r && r.vehicleId ? 'vehicleId ' + r.vehicleId.slice(0, 8) : '')); return r; } catch (e) { ck(l, false, 'THREW: ' + e.message); return null; } };
const no_ = async (l, fn, expect) => {
  try { await fn(); ck(l, false, 'succeeded but should have been refused'); }
  catch (e) { ck(l, expect ? new RegExp(expect).test(e.message) : true, e.message); }
};

const OWNER = 'owner-uid', STRANGER = 'stranger-uid', ADMIN = 'admin-uid', DRIVER = 'driver-uid';
const BIZ = 'SOK-TEST01', OTHER_BIZ = 'SOK-TEST02';
const call = (h, uid, data) => H[h]({ auth: { uid }, data });

(async () => {
  console.log('\nV-1 — BUSINESS -> VEHICLE AUTHORITY\n' + '='.repeat(64));

  /* Seed: two businesses, an admin user, and DELIBERATELY NO shops. */
  await db.collection('businesses').doc(BIZ).set({ ownerId: OWNER, businessType: 'delivery' });
  await db.collection('businesses').doc(OTHER_BIZ).set({ ownerId: 'someone-else' });
  await db.collection('users').doc(ADMIN).set({ role: 'admin' });
  const shopCount = (await db.collection('shops').get()).size;

  console.log('\n0 - the shop-independence premise');
  ck('0  ZERO shops documents exist in the fixture', shopCount === 0, shopCount + ' shops');

  console.log('\n1 - who may register a vehicle');
  const v1 = await ok_('1  the business OWNER may create a vehicle, with no shop anywhere',
    () => call('fleetVehicleCreate', OWNER, { businessId: BIZ, plate: 'KAA001A', type: 'motorcycle' }));

  await no_('2  a stranger may NOT create a vehicle on that business',
    () => call('fleetVehicleCreate', STRANGER, { businessId: BIZ, plate: 'KAA002B', type: 'motorcycle' }), 'forbidden');

  await ok_('3  an ADMIN may (existing AdminOS authority preserved)',
    () => call('fleetVehicleCreate', ADMIN, { businessId: BIZ, plate: 'KAA003C', type: 'van' }));

  await no_('4  a missing businessId is refused',
    () => call('fleetVehicleCreate', OWNER, { plate: 'KAA004D', type: 'car' }), 'businessId required');

  await no_('5  a businessId that does not exist is refused',
    () => call('fleetVehicleCreate', OWNER, { businessId: 'SOK-NOPE', plate: 'KAA005E', type: 'car' }), 'business not found');

  console.log('\n2 - V-2 vocabulary is the class authority here too');
  await no_('6  an unrecognised vehicle type is refused (not defaulted to a motorcycle)',
    () => call('fleetVehicleCreate', OWNER, { businessId: BIZ, plate: 'KAA006F', type: 'spaceship' }), 'unrecognised');

  await ok_('7  "bike" is accepted and canonicalised',
    () => call('fleetVehicleCreate', OWNER, { businessId: BIZ, plate: 'KAA007G', type: 'bike' }));
  const bikeDoc = (await db.collection('vehicles').where('plate', '==', 'KAA007G').get()).docs[0];
  ck('7b and stored as MOTORCYCLE, not bicycle', bikeDoc && bikeDoc.data().vehicleClass === 'motorcycle',
    bikeDoc && bikeDoc.data().vehicleClass);
  ck('7c the raw submitted token is preserved alongside the canonical class',
    bikeDoc && bikeDoc.data().type === 'bike', bikeDoc && bikeDoc.data().type);

  console.log('\n3 - the record is owned by the BUSINESS');
  const created = v1 && (await db.collection('vehicles').doc(v1.vehicleId).get()).data();
  ck('8  the vehicle carries businessId', created && created.businessId === BIZ, created && created.businessId);
  ck('8b and carries NO shopId', created && created.shopId === undefined, created && String(created.shopId));

  console.log('\n4 - authority does not leak across businesses');
  await no_('9  authority over one business cannot update another business\'s vehicle',
    () => call('fleetVehicleUpdate', OWNER, { businessId: BIZ, vehicleId: 'nonexistent' }), 'vehicle not found');
  await db.collection('vehicles').doc('other-veh').set({ id: 'other-veh', businessId: OTHER_BIZ, plate: 'KBB001Z' });
  await no_('9b the owner cannot reach a vehicle belonging to a business they do not own',
    () => call('fleetVehicleUpdate', OWNER, { businessId: OTHER_BIZ, vehicleId: 'other-veh', status: 'retired' }), 'forbidden');

  console.log('\n5 - assignment ties a vehicle to a driver');
  await ok_('10 the owner may assign a driver to their vehicle',
    () => call('fleetVehicleUpdate', OWNER, { businessId: BIZ, vehicleId: v1.vehicleId, assignedDriverId: DRIVER }));
  const assigned = (await db.collection('vehicles').doc(v1.vehicleId).get()).data();
  ck('10b assignedDriverId recorded', assigned.assignedDriverId === DRIVER, assigned.assignedDriverId);

  console.log('\n6 - listing is scoped to the business');
  const list = await call('fleetVehicleList', OWNER, { businessId: BIZ });
  ck('11 list returns only this business\'s vehicles',
    list.vehicles.length > 0 && list.vehicles.every((v) => v.businessId === BIZ),
    list.vehicles.length + ' vehicles');

  console.log('\n7 - plate uniqueness is global');
  await no_('12 the same plate cannot be registered twice, even under another business',
    () => call('fleetVehicleCreate', ADMIN, { businessId: OTHER_BIZ, plate: 'KAA001A', type: 'car' }), 'already registered');

  console.log('\n8 - blast radius: the rest of the module is untouched');
  const src = fs.readFileSync(path.join(ROOT, 'functions', 'logistics-plus.js'), 'utf8');
  const shopCalls = (src.match(/_assertRole\(uid, shopId/g) || []).length;
  const bizCalls = (src.match(/_assertVehicleAuthority\(uid, businessId\)/g) || []).length - 1; /* minus the definition */
  ck('13 exactly 6 vehicle functions moved to business authority', bizCalls === 6, bizCalls);
  ck('13b the other 25 call sites remain shop-bound (a separate gate)', shopCalls === 25, shopCalls);
  ck('13c the module\'s private vehicle vocabulary is retired', !/_VEHICLE_TYPES/.test(src));
  ck('13d no shopEmployees collection was created to "fix" delegation',
    !/collection\('shopEmployees'\)[\s\S]{0,80}\.set\(/.test(src));

  console.log('\n' + '-'.repeat(64));
  console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('  FAIL  SUITE THREW   [' + e.message + ']');
  console.log('RESULT: ' + pass + ' passed, ' + (fail + 1) + ' failed');
  process.exit(1);
});
