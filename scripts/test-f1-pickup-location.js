/* test-f1-pickup-location.js — F1, the pickup-location authority (owner 2026-09-30).
 *
 * Drives the REAL functions from FUNCTIONS_DIR (default ../functions) against the Firestore + Auth
 * emulators: shopSetPickupLocation, updateClickAndCollectStatus ('ready' creates the delivery),
 * availableDeliveries (HTTP, real ID tokens), dispatchDelivery, optimizeBatchRoute, navDispatchRider,
 * plus the pure helpers and the served rules for deliveryPickups.
 *   firebase emulators:exec --only firestore,auth --project demo-f1 "node scripts/test-f1-pickup-location.js"
 * RULES_FILE (default ../../sok-p0rules/firestore.rules.build) is the SERVED ruleset source for section R.
 * Point FUNCTIONS_DIR at the pre-F1 tree: the F1 rows must FAIL there.
 */
'use strict';
const path = require('path'), fs = require('fs');
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) { console.log('CRASH needs Firestore + Auth emulators'); process.exit(2); }
if (!/^demo-/.test(process.env.GCLOUD_PROJECT || '')) { console.log('CRASH needs a demo-* project'); process.exit(2); }
process.env.FUNCTIONS_EMULATOR = 'true';
const FN_DIR = path.resolve(process.env.FUNCTIONS_DIR || path.join(__dirname, '..', 'functions'));
const RULES_FILE = process.env.RULES_FILE || 'C:/temp/sok-p0rules/firestore.rules.build';
let pass = 0, fail = 0;
const ck = (label, ok, got) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '   [got ' + JSON.stringify(got) + ']')); ok ? pass++ : fail++; };
const run = async (fn, req) => { try { return { ok: true, r: await fn.run(req) }; } catch (e) { return { ok: false, code: e.code || String(e.message || e).slice(0, 80), msg: String(e.message || '') }; } };

(async () => {
  console.log('\nFUNCTIONS: ' + FN_DIR);
  const mod = require(path.join(FN_DIR, 'index.js'));
  const admin = require(require.resolve('firebase-admin', { paths: [FN_DIR] }));
  const db = admin.firestore();
  let PL = null; try { PL = require(path.join(FN_DIR, 'pickup-location.js')); } catch (_) {}
  let D = null; try { D = require(path.join(FN_DIR, 'sokoni-dispatch.js')); } catch (_) {}
  for (const c of await db.listCollections()) { const s = await c.get(); await Promise.all(s.docs.map((d) => d.ref.delete())); }
  const TS = admin.firestore.Timestamp;
  const ago = (sec) => TS.fromMillis(Date.now() - sec * 1000);
  const setPickup = (uid, data, token) => mod.shopSetPickupLocation
    ? run(mod.shopSetPickupLocation, { auth: uid ? { uid, token: token || {} } : null, data })
    : Promise.resolve({ ok: false, code: 'NO_SET_PICKUP_AUTHORITY' });
  const shop = async (id) => ((await db.collection('shops').doc(id).get()).data() || {});
  const pickupRec = async (ref) => (await db.collection('deliveryPickups').doc(ref).get());
  const NBO = { lat: -1.2921, lng: 36.8219 }, WESTLANDS = { lat: -1.2676, lng: 36.8108 }, MOMBASA = { lat: -4.0435, lng: 39.6682 };

  /* ── fixtures ── */
  await db.collection('shops').doc('SHOP_A').set({ name: 'Shop A', sellerUid: 'uOwner' });
  await db.collection('shops').doc('SHOP_B').set({ name: 'Shop B', sellerUid: 'uOwnerB' });
  await db.collection('shops').doc('SHOP_N').set({ name: 'No pickup shop', sellerUid: 'uNoPick' });
  const emp = (uid, role, over) => db.collection('shopEmployees').doc('SHOP_A_' + uid).set(Object.assign({ shopId: 'SHOP_A', uid, role, active: true, shopOwnerId: 'uOwner' }, over || {}));
  await emp('uMgr', 'manager'); await emp('uCash', 'cashier'); await emp('uForge', 'manager', { shopOwnerId: 'somebodyElse' });
  try { await admin.auth().createUser({ uid: 'uAdmin' }); } catch (_) {}
  await admin.auth().setCustomUserClaims('uAdmin', { admin: true });

  console.log('\n── A. who may set the pickup point (shopSetPickupLocation) ──');
  let r = await setPickup('uOwner', Object.assign({ shopId: 'SHOP_A', label: 'Main gate' }, NBO));
  let s = await shop('SHOP_A');
  ck('A1  the shop owner sets a valid pickup point', r.ok && s.pickupLocation && s.pickupLocation.lat === NBO.lat && s.pickupLocation.version === 1 && s.pickupLocation.setBy === 'uOwner', { r, pl: s.pickupLocation });
  r = await setPickup('uMgr', Object.assign({ shopId: 'SHOP_A' }, WESTLANDS));
  s = await shop('SHOP_A');
  ck('A2  a corroborated MANAGER may set it (version increments)', r.ok && s.pickupLocation && s.pickupLocation.lat === WESTLANDS.lat && s.pickupLocation.version === 2, { r, pl: s.pickupLocation });
  r = await setPickup('uCash', Object.assign({ shopId: 'SHOP_A' }, MOMBASA));
  ck('A3  a cashier is refused', !r.ok && r.code === 'permission-denied', r);
  r = await setPickup('uStranger', Object.assign({ shopId: 'SHOP_A' }, MOMBASA));
  ck('A4  a stranger is refused', !r.ok && r.code === 'permission-denied', r);
  r = await setPickup(null, Object.assign({ shopId: 'SHOP_A' }, MOMBASA));
  ck('A5  unauthenticated is refused', !r.ok && r.code === 'unauthenticated', r);
  r = await setPickup('uForge', Object.assign({ shopId: 'SHOP_A' }, MOMBASA));
  ck('A6  a forged manager record (wrong shopOwnerId) is refused', !r.ok && r.code === 'permission-denied', r);
  s = await shop('SHOP_A');
  ck('A6b none of the refused calls moved the point (still v2 Westlands)', s.pickupLocation && s.pickupLocation.version === 2 && s.pickupLocation.lat === WESTLANDS.lat, s.pickupLocation);
  r = await setPickup('uAdmin', Object.assign({ shopId: 'SHOP_B' }, NBO));
  ck('A7  a platform admin (server claim) may set it', r.ok, r);

  console.log('\n── V. coordinates are validated with the D2 validLocation rule ──');
  const bad = [['text', { lat: 'abc', lng: 36.8 }], ['out of range', { lat: 95, lng: 36.8 }], ['0°,0°', { lat: 0, lng: 0 }], ['missing', {}], ['NaN', { lat: NaN, lng: 1 }]];
  let allBad = true;
  for (const [name, c] of bad) { r = await setPickup('uOwner', Object.assign({ shopId: 'SHOP_A' }, c)); if (r.ok || r.code !== 'invalid-argument') { allBad = false; console.log('     ' + name + ' → ' + JSON.stringify(r)); } }
  ck('V1  text / out-of-range / 0°,0° / missing / NaN are all refused (invalid-argument)', allBad, null);
  ck('V2  …and none of them changed the stored point', ((await shop('SHOP_A')).pickupLocation || {}).version === 2, (await shop('SHOP_A')).pickupLocation);
  r = await setPickup('uOwner', Object.assign({ shopId: 'SHOP_A', label: '<script>x</script>' + 'L'.repeat(300) }, WESTLANDS));
  s = await shop('SHOP_A');
  ck('V3  the label is sanitised and bounded (no <>, ≤120 chars)', r.ok && !!s.pickupLocation && !/[<>]/.test(s.pickupLocation.label) && s.pickupLocation.label.length <= 120, s.pickupLocation && s.pickupLocation.label);

  console.log('\n── S. delivery creation copies a SERVER-ONLY snapshot ──');
  const cc = async (sellerUid, orderId, extra) => {
    await db.doc(`sellers/${sellerUid}/clickAndCollect/${orderId}`).set(Object.assign({ status: 'pending', fulfillmentType: 'delivery', sellerName: 'Shop', items: [{ id: 'p', name: 'x', qty: 1 }], total: 500 }, extra || {}));
    return run(mod.updateClickAndCollectStatus, { auth: { uid: sellerUid, token: {} }, data: { sellerId: sellerUid, orderId, status: 'ready' } });
  };
  const A_now = (await shop('SHOP_A')).pickupLocation || {};   /* {} on a pre-F1 tree: rows then FAIL, never crash */
  r = await cc('uOwner', 'O1', { shopId: 'SHOP_A' });
  let pkg = (await db.collection('packageRequests').doc('DELO1').get()).data() || {};
  let rec = await pickupRec('DELO1');
  ck('S1  "ready" creates the delivery with the shop\'s pickup (projection)', r.ok && pkg.pickupLocation && pkg.pickupLocation.lat === A_now.lat && pkg.pickupCoords && pkg.pickupCoords.lat === A_now.lat, { r, pl: pkg.pickupLocation });
  ck('S1b …backed by the server-only deliveryPickups record (same point + shop version)', rec.exists && rec.data().lat === A_now.lat && rec.data().version === A_now.version && rec.data().shopId === 'SHOP_A', rec.exists && rec.data());
  await setPickup('uOwner', Object.assign({ shopId: 'SHOP_A' }, MOMBASA));
  const auth1 = PL ? (await PL.authoritativePickups(db, ['DELO1'])).get('DELO1') : null;
  ck('S2  a delivery keeps its SNAPSHOT after the shop moves its pickup', !!auth1 && auth1.lat === A_now.lat, auth1);
  const again = PL ? await PL.ensureDeliveryPickup(db, 'DELO1', { shopId: 'SHOP_A' }) : null;
  ck('S3  a repeated creation (retried webhook) returns the ORIGINAL fact, not the new shop point', !!again && again.pickupLocation && again.pickupLocation.lat === A_now.lat, again);
  await db.collection('packageRequests').doc('DELO2').set({ orderId: 'O2', status: 'order_placed', sellerUid: 'uOwner', pickupLocation: { lat: 51.5, lng: -0.12, source: 'shop' }, pickupCoords: { lat: 51.5, lng: -0.12 } });
  r = await cc('uOwner', 'O2', { shopId: 'SHOP_A' });
  pkg = (await db.collection('packageRequests').doc('DELO2').get()).data() || {};
  const auth2 = PL ? (await PL.authoritativePickups(db, ['DELO2'])).get('DELO2') : null;
  ck('S4  a client-FORGED pickup on a pre-created delivery is replaced by the shop snapshot', r.ok && pkg.pickupLocation && pkg.pickupLocation.lat === MOMBASA.lat && !!auth2 && auth2.lat === MOMBASA.lat, { pl: pkg.pickupLocation, auth2 });
  r = await cc('uNoPick', 'O3', { shopId: 'SHOP_N' });
  pkg = (await db.collection('packageRequests').doc('DELO3').get()).data() || {};
  ck('S5  a shop with NO pickup point → pickupLocation null + an explicit gap, no invented point', r.ok && pkg.pickupLocation === null && pkg.pickupCoords === null && pkg.pickupLocationGap === 'shop_has_no_pickup_location' && !(await pickupRec('DELO3')).exists, { pl: pkg.pickupLocation, gap: pkg.pickupLocationGap });
  if (PL) {
    const par = await Promise.all([1, 2, 3, 4, 5].map(() => PL.ensureDeliveryPickup(db, 'DELRACE', { shopId: 'SHOP_A' })));
    const lats = new Set(par.map((p) => p.pickupLocation && p.pickupLocation.lat));
    ck('S6  five concurrent creations converge on ONE pickup fact', lats.size === 1 && (await pickupRec('DELRACE')).exists, [...lats]);
  } else ck('S6  five concurrent creations converge on ONE pickup fact', false, 'no pickup authority');
  /* Absence is a property of CODE: the writer documents the removed null in a comment, so strip
     comments (keeping string contents) before asserting on it. */
  const code = (src) => { let o = '', i = 0; while (i < src.length) { const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { const q = c; o += c; i++; while (i < src.length) { if (src[i] === '\\') { o += src[i] + (src[i + 1] || ''); i += 2; continue; } o += src[i]; if (src[i++] === q) break; } continue; }
    o += c; i++; } return o; };
  const IDX = code(fs.readFileSync(path.join(FN_DIR, 'index.js'), 'utf8'));
  const hook = IDX.slice(IDX.indexOf('const _delDoc = db.collection("packageRequests").doc(_delRef);'), IDX.indexOf('const _delDoc = db.collection("packageRequests").doc(_delRef);') + 9000);
  ck('S7a CONTROL the comment stripper removes a comment but keeps code', !/pickupCoords:\s*null/.test(code('/* pickupCoords: null */ x')) && /pickupCoords:\s*null/.test(code('x = { pickupCoords: null }')), null);
  ck('S7  the webhook delivery writer takes its pickup from ensureDeliveryPickup (no pickupCoords:null literal)', /ensureDeliveryPickup\(db, _delRef/.test(hook) && !/pickupCoords:\s*null/.test(hook), null);

  console.log('\n── K. distance is server-side, and unknown stays unknown ──');
  ck('K1  distanceKm between two valid points is a number (Nairobi→Westlands ≈ 2.9 km)', !!PL && Math.abs(PL.distanceKm(NBO, WESTLANDS) - 2.9) < 0.3, PL && PL.distanceKm(NBO, WESTLANDS));
  ck('K2  a missing point → null', !!PL && PL.distanceKm(null, NBO) === null, null);
  ck('K3  0°,0° is not a point → null', !!PL && PL.distanceKm({ lat: 0, lng: 0 }, NBO) === null, null);
  ck('K4  dropoffPointOf never returns the pickup', !!PL && PL.dropoffPointOf({ pickupLocation: NBO, pickupCoords: NBO }) === null, null);
  const r1 = { lat: -1.29, lng: 36.82, isOnline: true, vehicleType: 'moto' };
  ck('K5  scoreRider refuses a delivery with no pickup (was NaN → not excluded)', !!D && D.scoreRider(r1, {}) === null && D.scoreRider(r1, { pickupLat: 0, pickupLng: 0 }) === null && !!D.scoreRider(r1, { pickupLat: -1.30, pickupLng: 36.80 }), null);
  ck('K6  findBestHub returns no hub when either end is unknown (was 0°,0° midpoint)', !!D && D.findBestHub({ pickupLat: -1.3, pickupLng: 36.8 }, [{ lat: -1.2, lng: 36.8 }]) === null, null);

  console.log('\n── B. the rider board consumes the authoritative pickup ──');
  const tokenFor = async (uid) => {
    try { await admin.auth().createUser({ uid }); } catch (_) {}
    const custom = await admin.auth().createCustomToken(uid);
    const rr = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=demo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
    return (await rr.json()).idToken;
  };
  const feed = async (uid) => {
    const idToken = await tokenFor(uid);
    return new Promise((resolve) => {
      const res = { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, on() {}, once() {}, emit() {}, removeListener() {}, writeHead(c) { this.statusCode = c; return this; }, set(k, v) { this.headers[k] = v; return this; },
        status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; resolve(this); return this; }, send(b) { this.body = b; resolve(this); return this; }, end() { resolve(this); } };
      mod.availableDeliveries({ method: 'GET', url: '/', headers: { authorization: 'Bearer ' + idToken, origin: 'https://mysokoni.co.ke' }, query: {}, get(h) { return this.headers[h.toLowerCase()]; } }, res);
    });
  };
  await db.collection('drivers').doc('rB').set({ uid: 'rB', name: 'Rider B', approved: true, status: 'approved', vehicleType: 'moto' });
  await db.collection('driverVerification').doc('rB').set({ documentsComplete: true, status: 'verified_on_file' });
  await db.collection('rideDrivers').doc('rB').set({ presence: 'online', isOnline: true, lastSeen: ago(5), lat: NBO.lat, lng: NBO.lng, locationUpdatedAt: ago(5) });
  const boardJob = async (orderId, pkgExtra) => {
    await db.collection('orders').doc(orderId).set({ uid: 'buyer', buyerUid: 'buyer', sellerUid: 'uOwner', sellerName: 'Shop A', paymentVerified: true, status: 'awaiting_rider', deliveryFee: 1000, items: [{ n: 1 }] });
    await db.collection('packageRequests').doc('DEL' + orderId).set(Object.assign({ orderId, sellerUid: 'uOwner', sellerName: 'Shop A', status: 'awaiting_rider', pickupAddress: 'Shop A' }, pkgExtra || {}));
  };
  await boardJob('OK1');
  if (PL) await PL.ensureDeliveryPickup(db, 'DELOK1', { shopId: 'SHOP_A' });   /* snapshot = Mombasa (v3/v4) */
  await boardJob('OK2', { pickupLocation: { lat: -1.2925, lng: 36.8220 }, pickupCoords: { lat: -1.2925, lng: 36.8220 } });   /* forged "right next to the rider", NO server record */
  const fb = await feed('rB');
  const byId = new Map(((fb.body && fb.body.deliveries) || []).map((d) => [d.id, d]));
  const j1 = byId.get('DELOK1'), j2 = byId.get('DELOK2');
  ck('B0  the board answered 200 with both jobs', fb.statusCode === 200 && !!j1 && !!j2, { code: fb.statusCode, ids: [...byId.keys()] });
  ck('B1  distance to a job with a server snapshot is computed on the server (rider NBO → Mombasa ≈ 440 km)', !!j1 && typeof j1.distanceKm === 'number' && j1.distanceKm > 400 && j1.pickupKnown === true, j1 && { d: j1.distanceKm, k: j1.pickupKnown });
  ck('B2  a job whose ONLY pickup is on the (client-reachable) delivery doc gets NO distance', !!j2 && j2.distanceKm === null && j2.pickupKnown === false, j2 && { d: j2.distanceKm, k: j2.pickupKnown });
  await db.collection('rideDrivers').doc('rB').set({ locationUpdatedAt: ago(4000) }, { merge: true });
  const fb2 = await feed('rB');
  const j1b = ((fb2.body && fb2.body.deliveries) || []).find((d) => d.id === 'DELOK1');
  ck('B3  a rider whose position is older than the stale window → distance unknown (null), not the old fix', !!j1b && j1b.distanceKm === null, j1b && j1b.distanceKm);

  console.log('\n── X. no legacy fallback manufactures proximity ──');
  await db.collection('packageRequests').doc('DELX1').set({ orderId: 'X1', sellerUid: 'uOwner', status: 'ready_for_pickup', pickupLat: -1.29, pickupLng: 36.82 });
  r = await run(mod.dispatchDelivery, { auth: { uid: 'uOwner', token: {} }, data: { deliveryRef: 'DELX1' } });
  ck('X1  dispatchDelivery with no server pickup record → pickup_location_unknown (legacy pickupLat ignored), no "no riders" claim', r.ok && r.r && r.r.status === 'pickup_location_unknown', r);
  await db.collection('packageRequests').doc('DELR1').set({ orderId: 'R1', sellerUid: 'uOwner', status: 'driver_accepted', assignedDriverUid: 'rB', pickupAddress: 'A', deliveryCoords: { lat: -1.30, lng: 36.79 } });
  if (PL) await PL.ensureDeliveryPickup(db, 'DELR1', { shopId: 'SHOP_A' });
  await db.collection('packageRequests').doc('DELR2').set({ orderId: 'R2', sellerUid: 'uOwner', status: 'driver_accepted', assignedDriverUid: 'rB', pickupAddress: 'B', pickupLat: -1.28, pickupLng: 36.83 });
  r = await run(mod.optimizeBatchRoute, { auth: { uid: 'rB', token: {} }, data: { riderLat: NBO.lat, riderLng: NBO.lng, deliveryRefs: ['DELR1', 'DELR2'] } });
  const un = r.ok ? (r.r.unlocated || []).map((u) => u.id) : [];
  ck('X2  optimizeBatchRoute: stops with no known point are listed as unlocated, not routed through 0°,0°', r.ok && un.includes('DELR2_pickup') && un.includes('DELR2_dropoff') && (r.r.stops || []).every((st) => !(st.lat === 0 && st.lng === 0)), r.ok ? { un, stops: (r.r.stops || []).length } : r);
  ck('X3  …and totalKm is null while any stop is unknown (no partial distance claim)', r.ok && r.r.totalKm === null, r.ok && r.r.totalKm);
  r = await run(mod.optimizeBatchRoute, { auth: { uid: 'rB', token: {} }, data: { riderLat: NBO.lat, riderLng: NBO.lng, deliveryRefs: ['DELR1'] } });
  ck('X4  …and with every stop known it returns a real total', r.ok && typeof r.r.totalKm === 'number' && r.r.totalKm > 0 && !(r.r.unlocated || []).length, r.ok ? r.r.totalKm : r);
  await db.collection('orders').doc('NV1').set({ uid: 'buyer', sellerUid: 'uNoPick', pickupLat: -1.29, pickupLng: 36.82, deliveryLat: -1.31, deliveryLng: 36.80, deliveryAddress: 'x' });
  r = await run(mod.navDispatchRider, { auth: { uid: 'uAdmin', token: { admin: true } }, data: { orderId: 'NV1' } });
  ck('X5  navDispatchRider: client order.pickupLat and the drop-off are NOT used — unknown pickup refuses auto-dispatch', !r.ok && r.code === 'failed-precondition' && /pickup_location_unknown/.test(r.msg), r);

  console.log('\n── R. the snapshot is not reachable from a browser (served rules) ──');
  try {
    const rut = require(require.resolve('@firebase/rules-unit-testing', { paths: [path.join(__dirname, '..'), FN_DIR] }));
    const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
    const env = await rut.initializeTestEnvironment({ projectId: process.env.GCLOUD_PROJECT + '-rules', firestore: { rules: fs.readFileSync(RULES_FILE, 'utf8'), host, port: Number(port) } });
    await env.withSecurityRulesDisabled(async (c) => { await c.firestore().doc('deliveryPickups/DELZ').set({ lat: -1.3, lng: 36.8 }); });
    const buyer = env.authenticatedContext('uOwner').firestore();
    let readDenied = false, writeDenied = false;
    try { await rut.assertFails(buyer.doc('deliveryPickups/DELZ').get()); readDenied = true; } catch (_) {}
    try { await rut.assertFails(buyer.doc('deliveryPickups/DELZ').set({ lat: 51.5, lng: -0.12 })); writeDenied = true; } catch (_) {}
    ck('R1  a signed-in client cannot READ deliveryPickups (no rule = deny-by-default)', readDenied, readDenied);
    ck('R2  a signed-in client cannot WRITE deliveryPickups', writeDenied, writeDenied);
    await env.cleanup();
  } catch (e) { ck('R1  rules harness ran', false, String(e.message || e).slice(0, 120)); }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
