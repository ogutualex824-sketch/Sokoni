/* test-f1-payment-lineage.js — F1 on the PAYMENT functions lineage (bdbd29c), owner 2026-09-30.
 *
 * Production serves webhookIntasend and updateClickAndCollectStatus from this lineage, and the rider
 * functions (riderPresence / availableDeliveries / claimAvailableDelivery / dispatchDelivery) plus
 * shopSetPickupLocation from the rider lineage (feat/f1-pickup-location). F1 is ported to BOTH, with
 * geo-point.js, pickup-location.js and shop-employees.js byte-identical in each.
 *
 * This suite proves the two DELIVERY CREATION paths this lineage serves, driving the real code:
 *   W  webhookIntasend (HTTP, real challenge check) — a COMPLETE marketplace payment creates the
 *      delivery with the shop's pickup snapshot, never pickupCoords:null or a client-supplied point.
 *   C  updateClickAndCollectStatus 'ready' — the same authority, the same snapshot rules.
 *   K  the shared pure helpers; R  the served rules keep deliveryPickups server-only.
 * The shop's pickup point is SEEDED by admin here: the callable that sets it is served from the rider
 * lineage and certified there (test-f1-pickup-location.js, section A/V). That is a fixture, not a claim.
 *
 *   firebase emulators:exec --only firestore,auth --project demo-f1 "node scripts/test-f1-payment-lineage.js"
 * FUNCTIONS_DIR (default ../functions): point it at bdbd29c unmodified — the F1 rows must FAIL there.
 */
'use strict';
const path = require('path'), fs = require('fs');
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) { console.log('CRASH needs Firestore + Auth emulators'); process.exit(2); }
if (!/^demo-/.test(process.env.GCLOUD_PROJECT || '')) { console.log('CRASH needs a demo-* project'); process.exit(2); }
process.env.FUNCTIONS_EMULATOR = 'true';
const CHALLENGE = 'f1-lineage-test-challenge';
process.env.INTASEND_WEBHOOK_CHALLENGE = CHALLENGE;      /* defineSecret().value() reads the env in tests */
const FN_DIR = path.resolve(process.env.FUNCTIONS_DIR || path.join(__dirname, '..', 'functions'));
const RULES_FILE = process.env.RULES_FILE || 'C:/temp/sok-p0rules/firestore.rules.build';
let pass = 0, fail = 0;
const ck = (label, ok, got) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '   [got ' + JSON.stringify(got) + ']')); ok ? pass++ : fail++; };
const run = async (fn, req) => { try { return { ok: true, r: await fn.run(req) }; } catch (e) { return { ok: false, code: e.code || String(e.message || e).slice(0, 80), msg: String(e.message || '') }; } };

/* A minimal Express-shaped response that resolves when the handler answers. */
function http(fn, body) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; }, set(k, v) { this.headers[k] = v; return this; }, setHeader(k, v) { this.headers[k] = v; },
      send(b) { resolve({ code: this.statusCode, body: b }); return this; }, json(b) { resolve({ code: this.statusCode, body: b }); return this; },
      end(b) { resolve({ code: this.statusCode, body: b }); return this; } };
    const req = { method: 'POST', headers: { 'content-type': 'application/json' }, body, query: {}, get(h) { return this.headers[String(h).toLowerCase()]; } };
    Promise.resolve().then(() => fn(req, res)).catch((e) => resolve({ code: 'THREW', body: String(e && e.message || e).slice(0, 160) }));
    setTimeout(() => resolve({ code: 'TIMEOUT', body: null }), 45000);
  });
}

(async () => {
  console.log('\nFUNCTIONS: ' + FN_DIR);
  const mod = require(path.join(FN_DIR, 'index.js'));
  const admin = require(require.resolve('firebase-admin', { paths: [FN_DIR] }));
  const db = admin.firestore();
  let PL = null; try { PL = require(path.join(FN_DIR, 'pickup-location.js')); } catch (_) {}
  let G = null; try { G = require(path.join(FN_DIR, 'geo-point.js')); } catch (_) {}
  for (const c of await db.listCollections()) { const s = await c.get(); await Promise.all(s.docs.map((d) => d.ref.delete())); }
  const pkgOf = async (id) => ((await db.collection('packageRequests').doc(id).get()).data() || {});
  const pickupRec = async (ref) => (await db.collection('deliveryPickups').doc(ref).get());
  const NBO = { lat: -1.2921, lng: 36.8219 }, MOMBASA = { lat: -4.0435, lng: 39.6682 }, LONDON = { lat: 51.5, lng: -0.12 };

  /* ── fixtures (the pickup point is SEEDED — see header) ── */
  await db.collection('shops').doc('uOwner').set({ name: 'Shop A', sellerUid: 'uOwner', pickupLocation: Object.assign({ label: 'Main gate', version: 3, source: 'merchant' }, NBO) });
  await db.collection('shops').doc('uNoPick').set({ name: 'No pickup shop', sellerUid: 'uNoPick' });

  console.log('\n── L. what this lineage serves ──');
  ck('L1  webhookIntasend and updateClickAndCollectStatus are exported here', typeof mod.webhookIntasend === 'function' && !!mod.updateClickAndCollectStatus, Object.keys(mod).filter((k) => /webhookIntasend|updateClickAndCollect/.test(k)));
  ck('L2  shopSetPickupLocation is NOT exported here (it is served from the rider lineage — one writer)', !mod.shopSetPickupLocation, !!mod.shopSetPickupLocation);

  console.log('\n── W. webhookIntasend: a paid marketplace order creates the delivery from the shop snapshot ──');
  const pay = async (ref, meta, over) => db.collection('payments').doc(ref).set(Object.assign({ status: 'PENDING', uid: 'uBuyer', amount: 500, phone: '254700000001', createdAt: admin.firestore.FieldValue.serverTimestamp(),
    meta: Object.assign({ category: 'marketplace', hub: 'marketplace', fulfillmentType: 'delivery', address: 'Kilimani', sellerName: 'Shop A', items: [{ productId: 'p1', name: 'Item', qty: 1, price: 500 }] }, meta) }, over || {}));
  const hook = (ref, challenge) => http(mod.webhookIntasend, { challenge: challenge == null ? CHALLENGE : challenge, invoice: { state: 'COMPLETE', api_ref: ref, id: 'INV_' + ref, net_amount: 500, value: 500 } });

  await pay('W1', { orderId: 'OW1', sellerUid: 'uOwner' });
  let h = await hook('W1');
  let pkg = await pkgOf('DELW1'), rec = await pickupRec('DELW1');
  ck('W0  control: the webhook accepted the payment and created the delivery', h.code === 200 && !!pkg.ref, { h, ref: pkg.ref || null });
  ck('W1  the delivery carries the SHOP\'s pickup (projection), not pickupCoords:null', !!pkg.pickupLocation && pkg.pickupLocation.lat === NBO.lat && pkg.pickupLocation.version === 3 && !!pkg.pickupCoords && pkg.pickupCoords.lat === NBO.lat, { pl: pkg.pickupLocation, pc: pkg.pickupCoords });
  ck('W2  …backed by the server-only deliveryPickups record (same point, shop version, shopId)', rec.exists && rec.data().lat === NBO.lat && rec.data().version === 3 && rec.data().shopId === 'uOwner', rec.exists && rec.data());

  /* client-supplied pickup fields in the payment metadata are ignored */
  await pay('W3', { orderId: 'OW3', sellerUid: 'uOwner', pickupLocation: LONDON, pickupCoords: LONDON, pickupLat: LONDON.lat, pickupLng: LONDON.lng });
  h = await hook('W3');
  pkg = await pkgOf('DELW3');
  ck('W3  pickup fields smuggled in payment meta are NOT used (still the shop point)', h.code === 200 && !!pkg.pickupLocation && pkg.pickupLocation.lat === NBO.lat, { h: h.code, pl: pkg.pickupLocation });

  /* a seller with no shop point → explicit unknown */
  await pay('W4', { orderId: 'OW4', sellerUid: 'uNoPick', sellerName: 'No pickup shop' });
  h = await hook('W4');
  pkg = await pkgOf('DELW4');
  ck('W4  no shop point → pickupLocation null + pickupLocationGap, no invented point, no snapshot', h.code === 200 && !!pkg.ref && pkg.pickupLocation === null && pkg.pickupCoords === null && pkg.pickupLocationGap === 'shop_has_no_pickup_location' && !(await pickupRec('DELW4')).exists, { pl: pkg.pickupLocation, gap: pkg.pickupLocationGap });

  /* replay after the shop moves: the payment is already COMPLETE → no second fact */
  await db.collection('shops').doc('uOwner').set({ pickupLocation: Object.assign({ version: 4, source: 'merchant' }, MOMBASA) }, { merge: true });
  h = await hook('W1');
  pkg = await pkgOf('DELW1'); rec = await pickupRec('DELW1');
  ck('W5  a replayed webhook after the shop moved changes nothing (original snapshot kept)', h.code === 200 && pkg.pickupLocation && pkg.pickupLocation.lat === NBO.lat && rec.data().lat === NBO.lat, { pl: pkg.pickupLocation, rec: rec.data() });

  /* wrong challenge → refused, nothing created */
  await pay('W6', { orderId: 'OW6', sellerUid: 'uOwner' });
  h = await hook('W6', 'wrong-challenge');
  ck('W6  a webhook with the wrong challenge is refused and creates no delivery or snapshot', h.code !== 200 && !(await pkgOf('DELW6')).ref && !(await pickupRec('DELW6')).exists, { h });
  ck('W6b control: the same payment with the right challenge DOES create it (the refusal was the challenge)', (await hook('W6')).code === 200 && !!(await pkgOf('DELW6')).ref, null);

  console.log('\n── C. updateClickAndCollectStatus "ready": same authority ──');
  const cc = async (sellerUid, orderId, extra) => {
    await db.doc(`sellers/${sellerUid}/clickAndCollect/${orderId}`).set(Object.assign({ status: 'pending', fulfillmentType: 'delivery', sellerName: 'Shop', items: [{ id: 'p', name: 'x', qty: 1 }], total: 500 }, extra || {}));
    return run(mod.updateClickAndCollectStatus, { auth: { uid: sellerUid, token: {} }, data: { sellerId: sellerUid, orderId, status: 'ready' } });
  };
  let r = await cc('uOwner', 'OC1', { shopId: 'uOwner' });
  pkg = await pkgOf('DELOC1'); rec = await pickupRec('DELOC1');
  ck('C1  "ready" creates the delivery with the shop\'s CURRENT pickup snapshot', r.ok && pkg.pickupLocation && pkg.pickupLocation.lat === MOMBASA.lat && rec.exists && rec.data().version === 4, { r, pl: pkg.pickupLocation });
  await db.collection('shops').doc('uOwner').set({ pickupLocation: Object.assign({ version: 5, source: 'merchant' }, NBO) }, { merge: true });
  r = await cc('uOwner', 'OC1', { shopId: 'uOwner' });
  pkg = await pkgOf('DELOC1');
  ck('C2  "ready" pressed again after the shop moved keeps the ORIGINAL fact', r.ok && pkg.pickupLocation && pkg.pickupLocation.lat === MOMBASA.lat && (await pickupRec('DELOC1')).data().lat === MOMBASA.lat, pkg.pickupLocation);
  await db.collection('packageRequests').doc('DELOC2').set({ orderId: 'OC2', status: 'order_placed', sellerUid: 'uOwner', pickupLocation: Object.assign({ source: 'shop' }, LONDON), pickupCoords: LONDON });
  r = await cc('uOwner', 'OC2', { shopId: 'uOwner' });
  pkg = await pkgOf('DELOC2');
  ck('C3  a client-FORGED pickup on a pre-created delivery is replaced by the shop snapshot', r.ok && pkg.pickupLocation && pkg.pickupLocation.lat === NBO.lat, pkg.pickupLocation);
  r = await cc('uNoPick', 'OC3', { shopId: 'uNoPick' });
  pkg = await pkgOf('DELOC3');
  ck('C4  no shop point → null + explicit gap', r.ok && pkg.pickupLocation === null && pkg.pickupLocationGap === 'shop_has_no_pickup_location', { pl: pkg.pickupLocation, gap: pkg.pickupLocationGap });

  console.log('\n── K. shared helpers (byte-identical to the rider lineage) ──');
  ck('K1  geo-point refuses 0°,0°, out-of-range and text; accepts a real point', !!G && G.validLocation({ lat: 0, lng: 0 }) === null && G.validLocation({ lat: 91, lng: 0 }) === null && G.validLocation({ lat: 'x', lng: 1 }) === null && !!G.validLocation(NBO), null);
  ck('K2  distanceKm with an unknown end → null (no distance claim)', !!PL && PL.distanceKm(null, NBO) === null && PL.distanceKm({ lat: 0, lng: 0 }, NBO) === null, null);
  if (PL) {
    const par = await Promise.all([1, 2, 3, 4, 5].map(() => PL.ensureDeliveryPickup(db, 'DELRACE', { shopId: 'uOwner' })));
    ck('K3  five concurrent creations converge on ONE pickup fact', new Set(par.map((p) => p.pickupLocation && p.pickupLocation.lat)).size === 1, par.map((p) => p.pickupLocation && p.pickupLocation.lat));
  } else ck('K3  five concurrent creations converge on ONE pickup fact', false, 'no pickup authority');

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
    ck('R1  a signed-in client cannot READ deliveryPickups', readDenied, readDenied);
    ck('R2  a signed-in client cannot WRITE deliveryPickups', writeDenied, writeDenied);
    await env.cleanup();
  } catch (e) { ck('R1  rules harness ran', false, String(e.message || e).slice(0, 120)); }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
