/* test-d2-rider-presence.js — Delivery Hub D2: server presence, stale detection, eligible feed.
 *
 * Drives the REAL functions from FUNCTIONS_DIR (default ../functions) against the Firestore +
 * Auth emulators: riderPresence (callable), availableDeliveries (HTTP, real ID tokens from the
 * Auth emulator), claimAvailableDelivery (callable). Also the pure presenceState() at the stale
 * boundary with an injected clock.
 *   firebase emulators:exec --only firestore,auth --project demo-d2 "node scripts/test-d2-rider-presence.js"
 * Point FUNCTIONS_DIR at the pre-D2 tree too: the D2 rows must FAIL there.
 */
'use strict';
const path = require('path');
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) { console.log('CRASH needs Firestore + Auth emulators'); process.exit(2); }
if (!/^demo-/.test(process.env.GCLOUD_PROJECT || '')) { console.log('CRASH needs a demo-* project'); process.exit(2); }
process.env.FUNCTIONS_EMULATOR = 'true';
const FN_DIR = path.resolve(process.env.FUNCTIONS_DIR || path.join(__dirname, '..', 'functions'));
let pass = 0, fail = 0;
const ck = (label, ok, got) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '   [got ' + JSON.stringify(got) + ']')); ok ? pass++ : fail++; };

(async () => {
  console.log('\nFUNCTIONS: ' + FN_DIR);
  const mod = require(path.join(FN_DIR, 'index.js'));
  const admin = require(require.resolve('firebase-admin', { paths: [FN_DIR] }));
  const db = admin.firestore();
  const hasPresence = typeof mod.riderPresence === 'function' || !!(mod.riderPresence && mod.riderPresence.run);
  let rp = null; try { rp = require(path.join(FN_DIR, 'rider-presence.js')); } catch (_) {}
  for (const c of await db.listCollections()) { const s = await c.get(); await Promise.all(s.docs.map((d) => d.ref.delete())); }
  if (rp && rp._resetConfigCache) rp._resetConfigCache();

  /* ── helpers ── */
  const TS = admin.firestore.Timestamp;
  const ago = (sec) => TS.fromMillis(Date.now() - sec * 1000);
  const presence = (uid, action, extra) => (hasPresence
    ? mod.riderPresence.run({ auth: { uid, token: {} }, data: Object.assign({ action }, extra || {}) })
    : Promise.resolve({ state: 'NO_PRESENCE_AUTHORITY' }));
  /* On the pre-D2 tree there is no presence authority: seed the approval shape the OLD inline
     check read off rideDrivers, so the board rows still run and show the old behaviour. */
  const legacyOnline = async (uid) => { if (!hasPresence) await db.collection('rideDrivers').doc(uid).set({ approved: true, status: 'active', isOnline: true, name: 'Rider ' + uid }, { merge: true }); };
  const tokenFor = async (uid) => {
    try { await admin.auth().createUser({ uid }); } catch (_) {}
    const custom = await admin.auth().createCustomToken(uid);
    const r = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=demo`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) });
    return (await r.json()).idToken;
  };
  const feed = async (uid) => {
    const idToken = await tokenFor(uid);
    return new Promise((resolve) => {
      const res = { statusCode: 200, headers: {}, body: null,
        setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, on() {}, once() {}, emit() {}, removeListener() {}, writeHead(c) { this.statusCode = c; return this; }, set(k, v) { this.headers[k] = v; return this; },
        status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; resolve(this); return this; },
        send(b) { this.body = b; resolve(this); return this; }, end() { resolve(this); } };
      mod.availableDeliveries({ method: 'GET', url: '/', headers: { authorization: 'Bearer ' + idToken, origin: 'https://mysokoni.co.ke' }, query: {}, get(h) { return this.headers[h.toLowerCase()]; } }, res);
    });
  };
  const claim = async (uid, ref) => { try { const r = await mod.claimAvailableDelivery.run({ auth: { uid }, data: { deliveryRef: ref } }); return { ok: true, r }; } catch (e) { return { ok: false, code: e.code || e.message }; } };
  const driver = async (uid, over = {}, ver = { documentsComplete: true, status: 'verified_on_file' }) => {
    await db.collection('drivers').doc(uid).set(Object.assign({ uid, name: 'Rider ' + uid, approved: true, status: 'approved', vehicleType: 'moto' }, over));
    if (ver) await db.collection('driverVerification').doc(uid).set(ver);
  };
  const job = async (orderId, { order = {}, pkg = {}, id } = {}) => {
    await db.collection('orders').doc(orderId).set(Object.assign({ uid: 'buyer', buyerUid: 'buyer', sellerUid: 'seller', sellerName: 'Shop',
      paymentVerified: true, status: 'awaiting_rider', deliveryFee: 1000, items: [{ n: 1 }] }, order));
    const pid = id || ('DEL' + orderId);
    await db.collection('packageRequests').doc(pid).set(Object.assign({ orderId, sellerUid: 'seller', sellerName: 'Shop', status: 'awaiting_rider',
      pickupAddress: 'Shop A', deliveryFee: 1000, driverNet: 800 }, pkg));
    return pid;
  };
  const ids = (r) => ((r.body && r.body.deliveries) || []).map((d) => d.id);

  console.log('\n── presence: the server decides and writes ──');
  ck('D0  riderPresence callable exists', hasPresence, hasPresence);
  await driver('r1');
  let r, f;
  if (hasPresence) {
  r = await presence('r1', 'online', { lat: -1.3, lng: 36.8 });
  const p1 = (await db.collection('rideDrivers').doc('r1').get()).data() || {};
  ck('P1  approved + verified rider goes online (server-written presence + lastSeen)', r.state === 'online' && p1.presence === 'online' && !!p1.lastSeen, { r, p1: { presence: p1.presence, lastSeen: !!p1.lastSeen } });
  ck('P1b greeting name comes from the server (users → drivers), not a hard-coded label', r.displayName === 'Rider r1', r.displayName);
  await db.collection('rideDrivers').doc('r1').set({ lastSeen: ago(400) }, { merge: true });
  r = await presence('r1', 'status');
  ck('P2  no heartbeat for > 5 min → STALE (not offline)', r.state === 'stale', r.state);
  f = await feed('r1');
  ck('P3  a stale rider gets no board (409 not_online)', f.statusCode === 409 && f.body.state === 'stale', { code: f.statusCode, body: f.body });
  r = await presence('r1', 'heartbeat');
  ck('P4  a stale rider reconnects through the server operation → online again', r.state === 'online', r.state);
  await presence('r1', 'offline');
  r = await presence('r1', 'heartbeat');
  ck('P5  explicit offline stays offline — a heartbeat never revives it', r.state === 'offline', r.state);
  f = await feed('r1');
  ck('P5b an offline rider gets no board', f.statusCode === 409 && f.body.state === 'offline', { code: f.statusCode, body: f.body });
  await driver('rs', { suspendedAt: ago(10) });
  await db.collection('rideDrivers').doc('rs').set({ isOnline: true, presence: 'online', lastSeen: ago(1) });
  r = await presence('rs', 'online');
  const prs = (await db.collection('rideDrivers').doc('rs').get()).data();
  ck('P6  suspended rider is refused and taken off the road (presence forced offline)', r.state === 'not_eligible' && prs.isOnline === false, { r: r.state, isOnline: prs.isOnline });
  await driver('rv', {}, { documentsComplete: false, status: 'incomplete' });
  r = await presence('rv', 'online');
  ck('P7  verification incomplete → not eligible (DL-01 authority reused)', r.state === 'not_eligible', r.state);
  await driver('rg');
  await db.collection('rideDrivers').doc('rg').set({ isOnline: true, status: 'active', updatedAt: ago(4680000) });
  r = await presence('rg', 'status');
  ck('P8  legacy ghost shard (isOnline, no server lastSeen) → stale, never online', r.state === 'stale', r.state);
  await db.collection('platformConfig').doc('riderPresence').set({ staleAfterSeconds: 120 });
  rp._resetConfigCache();
  await presence('r1', 'online');
  await db.collection('rideDrivers').doc('r1').set({ lastSeen: ago(180) }, { merge: true });
  r = await presence('r1', 'status');
  ck('P9  threshold is server config (120s): 180s old → stale', r.state === 'stale' && r.staleAfterSeconds === 120, r);
  await db.collection('platformConfig').doc('riderPresence').set({ staleAfterSeconds: 5 });
  rp._resetConfigCache();
  r = await presence('r1', 'status');
  ck('P9b config is clamped (5s → floor 60s)', r.staleAfterSeconds === 60, r.staleAfterSeconds);
  await db.collection('platformConfig').doc('riderPresence').delete(); rp._resetConfigCache();
  const drvOk = { approved: true, status: 'approved', vehicleType: 'moto' }, verOk = { documentsComplete: true };
  const now = 1_000_000_000_000;
  ck('P10 boundary: 299s since heartbeat → online', rp.presenceState({ presence: { presence: 'online', lastSeen: now - 299000 }, driver: drvOk, verification: verOk, nowMs: now, staleSeconds: 300, activeCount: 0 }).state === 'online', null);
  ck('P10b boundary: 301s since heartbeat → stale', rp.presenceState({ presence: { presence: 'online', lastSeen: now - 301000 }, driver: drvOk, verification: verOk, nowMs: now, staleSeconds: 300, activeCount: 0 }).state === 'stale', null);
  ck('P11 fresh + active assignment → on_delivery (still eligible)', (() => { const s = rp.presenceState({ presence: { presence: 'online', lastSeen: now - 5000 }, driver: drvOk, verification: verOk, nowMs: now, staleSeconds: 300, activeCount: 2 }); return s.state === 'on_delivery' && s.eligible; })(), null);
  ck('P12 suspended wins over a fresh heartbeat', rp.presenceState({ presence: { presence: 'online', lastSeen: now }, driver: Object.assign({ suspendedAt: 1 }, drvOk), verification: verOk, nowMs: now, staleSeconds: 300, activeCount: 0 }).state === 'suspended', null);
  } else {
    ck('P*  presence authority rows (P1-P12)', false, 'no riderPresence on this tree');
  }

  console.log('\n── the board lists only server-created, readied jobs ──');
  await presence('r1', 'online'); await legacyOnline('r1');
  const good = await job('o1');
  await db.collection('paymentIntents').doc('o1').set({ purpose: 'product_order', resourceType: 'order', resourceId: 'o1', metadata: { orderId: 'o1', deliveryFee: 1000 } });
  const noIntent = await job('o9', { order: { deliveryFee: 1000 } });   /* order carries a (client-writable) fee, no server money record */
  await job('o2', { id: 'FORGED-123' });                                         /* client-style id */
  await job('o3', { order: { paymentVerified: false } });                       /* unpaid order */
  await job('o4', { order: { status: 'confirmed' } });                          /* seller never readied it */
  await job('o5', { pkg: { sellerUid: 'someoneElse' } });                       /* seller mismatch */
  await db.collection('packageRequests').doc('DELo6').set({ orderId: 'o6', status: 'awaiting_rider', deliveryFee: 99999, driverNet: 99999 }); /* no order at all */
  const truck = await job('o7', { pkg: { vehicleType: 'truck' } });
  f = await feed('r1');
  const listed = ids(f);
  /* A refusal row only counts if the SAME response is a healthy board that lists the valid job —
     a crashed feed (500, empty list) must never satisfy "not listed" (mutant M15 proved it could). */
  const healthy = f.statusCode === 200 && listed.includes(good);
  ck('F1  the canonical server job is listed', f.statusCode === 200 && listed.includes(good), { code: f.statusCode, listed });
  const g = (f.body.deliveries || []).find((d) => d.id === good) || {};
  ck('F1b fee from the SERVER payment intent; rider figure from the payout commission (880 of 1000)', g.deliveryFee === 1000 && g.riderEarning === 880 && g.driverNet === 880, g);
  const ni = (f.body.deliveries || []).find((d) => d.id === noIntent) || {};
  ck('F1e no server money record → fee and earning UNKNOWN (null), not the order figure', ni.id === noIntent && ni.deliveryFee === null && ni.riderEarning === null, ni);
  ck('F1c distance is unknown (null), never invented', g.distanceKm === null, g.distanceKm);
  ck('F1d no buyer PII / PIN on the board', !('buyerPhone' in g) && !('buyerName' in g) && !('proofPin' in g) && !('deliveryAddress' in g), Object.keys(g));
  ck('F2  forged non-canonical job is NOT listed', healthy && !listed.includes('FORGED-123'), listed);
  ck('F3  job on an unpaid order is NOT listed', healthy && !listed.includes('DELo3'), listed);
  ck('F4  job whose order was never readied is NOT listed', healthy && !listed.includes('DELo4'), listed);
  ck('F5  seller mismatch is NOT listed', healthy && !listed.includes('DELo5'), listed);
  ck('F6  job with no order is NOT listed (fake fee never shown)', healthy && !listed.includes('DELo6'), listed);
  ck('F7  motorcycle rider does not see a truck-sized job', healthy && !listed.includes(truck), listed);
  let c = await claim('r1', 'FORGED-123');
  ck('F8  claiming a forged job is refused', !c.ok, c);
  c = await claim('r1', 'DELo3');
  ck('F8b claiming a job on an unpaid order is refused', !c.ok, c);
  c = await claim('r1', truck);
  ck('F8c claiming a job the vehicle cannot carry is refused', !c.ok, c);
  await driver('r2');
  await presence('r2', 'online'); await legacyOnline('r2');
  c = await claim('r1', good);
  const c2 = await claim('r2', good);
  const pk = (await db.collection('packageRequests').doc(good).get()).data();
  const od = (await db.collection('orders').doc('o1').get()).data();
  ck('F9  valid claim succeeds; first claim wins, second refused', c.ok && !c2.ok && pk.assignedDriverUid === 'r1' && od.assignedDriverUid === 'r1' && od.status === 'rider_assigned', { c, c2, pk: pk.assignedDriverUid, od: od.status });
  ck('F9b claimed job carries the SERVER rider name, not the shard', pk.riderName === 'Rider r1', pk.riderName);
  await db.collection('rideDrivers').doc('r2').set({ lastSeen: ago(900) }, { merge: true });
  await job('o8');
  c = await claim('r2', 'DELo8');
  ck('F10 a stale rider cannot claim', !c.ok, c);
  r = await presence('r1', 'status');
  ck('F11 after claiming, the rider is on_delivery', r.state === 'on_delivery' && r.activeCount === 1, r);

  console.log('\n── dispatch uses fresh presence (structural) ──');
  const fs = require('fs');
  const dsrc = fs.readFileSync(path.join(FN_DIR, 'dispatch.js'), 'utf8');
  ck('X1  dispatchDelivery filters presence candidates by server freshness', /isFresh\(c, _nowMs, _staleSec\)/.test(dsrc), null);
  if (rp) ck('X2  isFresh: stale / offline / missing lastSeen are not fresh',
    rp.isFresh({ presence: 'online', lastSeen: Date.now() - 1000 }, Date.now(), 300) === true &&
    rp.isFresh({ presence: 'online', lastSeen: Date.now() - 400000 }, Date.now(), 300) === false &&
    rp.isFresh({ presence: 'offline', lastSeen: Date.now() }, Date.now(), 300) === false &&
    rp.isFresh({ isOnline: true }, Date.now(), 300) === false, null);

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack)); process.exit(2); });
