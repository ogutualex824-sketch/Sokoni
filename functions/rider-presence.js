'use strict';
/**
 * RIDER PRESENCE + JOB-BOARD ELIGIBILITY — Delivery Hub D2 (2026-09-29).
 *
 * WHY THIS EXISTS. Measured against the SERVED rules: `rideDrivers` is `write: if false`, so every
 * Go Online / heartbeat write driver.html made from the browser was silently refused. Nothing on
 * the server expired presence — production held a rider "online" ~54 days after its last write.
 * The job board (availableDeliveries) and claimAvailableDelivery trusted an INLINE approval check
 * on that presence shard instead of the DL-01 authority, and listed any `packageRequests` doc with
 * status 'awaiting_rider' — a status a browser can write at create.
 *
 * THE SPLIT (unchanged from DL-01, made complete):
 *   AUTHORITY    rider-eligibility.evaluate(drivers, driverVerification) — server-only records.
 *   PRESENCE     rideDrivers/{uid}, now written ONLY by riderPresence (Admin SDK). The browser
 *                REQUESTS a transition; the server decides and writes it.
 *   FRESHNESS    lastSeen older than platformConfig/riderPresence.staleAfterSeconds (default 300)
 *                is STALE — not offline. Offline is an explicit rider act; stale is a heartbeat
 *                that stopped; suspended is an administrative restriction; on_delivery is work.
 *                A stale rider becomes fresh again through the same authorized operation.
 *   JOBS         A job is on the board only when the SERVER created and readied it: canonical id
 *                DEL{orderId}, the order paymentVerified and in 'awaiting_rider' (server-set),
 *                unassigned, same seller. Money shown comes from the order, never the job doc.
 *
 * Distance is deliberately absent: no pickup or drop coordinates exist in production yet, and
 * the owner ruled that no radius is invented before the pickup-location slice.
 */
const riderEligibility = require('./rider-eligibility');
const vehicleClasses = require('./vehicle-classes');

const DEFAULT_STALE_SECONDS = 300;
const MIN_STALE_SECONDS = 60, MAX_STALE_SECONDS = 3600;
/* Package statuses that mean the rider is carrying work right now. */
const ACTIVE_JOB_STATUSES = ['driver_accepted', 'driver_at_seller', 'picked_up', 'in_transit', 'rider_en_route'];

let _cfgCache = null, _cfgAt = 0;
async function staleAfterSeconds(db, nowMs) {
  const now = nowMs || Date.now();
  if (_cfgCache !== null && now - _cfgAt < 60000) return _cfgCache;
  let v = DEFAULT_STALE_SECONDS;
  try {
    const s = await db.collection('platformConfig').doc('riderPresence').get();
    const n = s.exists ? Number(s.get('staleAfterSeconds')) : NaN;
    if (Number.isFinite(n)) v = Math.min(MAX_STALE_SECONDS, Math.max(MIN_STALE_SECONDS, Math.round(n)));
  } catch (_) { /* config unreadable: the default is the safe, documented value */ }
  _cfgCache = v; _cfgAt = now;
  return v;
}
function _resetConfigCache() { _cfgCache = null; _cfgAt = 0; }   /* test seam */

function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts === 'number') return ts;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  const s = ts.seconds != null ? ts.seconds : ts._seconds;
  return s != null ? s * 1000 : 0;
}

/**
 * The single presence decision. Pure: everything it needs is passed in, including the clock.
 * Returns { state, eligible } where eligible means "may be offered NEW jobs".
 *   suspended | ineligible | offline | stale | on_delivery | online
 */
function presenceState({ presence, driver, verification, nowMs, staleSeconds, activeCount }) {
  const verdict = riderEligibility.evaluate(driver, verification);
  if (!verdict.eligible) {
    const suspended = verdict.reason === 'suspended' || verdict.reason === 'banned';
    return { state: suspended ? 'suspended' : 'ineligible', eligible: false, reason: verdict.reason };
  }
  /* Only the server-written marker counts. A legacy shard that merely says isOnline:true, with
     no server presence marker and no lastSeen, is not proof of anything — it is exactly the
     54-day ghost. It resolves to stale (online intent, no fresh heartbeat), never online. */
  const p = presence || {};
  if (p.presence === 'offline' || (p.presence == null && p.isOnline !== true && p.online !== true)) {
    return { state: 'offline', eligible: false };
  }
  const last = toMillis(p.lastSeen);
  if (!last || nowMs - last > staleSeconds * 1000) return { state: 'stale', eligible: false, lastSeenMs: last || null };
  if (activeCount > 0) return { state: 'on_delivery', eligible: true, activeCount };
  return { state: 'online', eligible: true };
}

async function activeJobCount(db, uid) {
  const s = await db.collection('packageRequests').where('assignedDriverUid', '==', uid).limit(50).get();
  return s.docs.filter((d) => ACTIVE_JOB_STATUSES.includes(String(d.get('status') || ''))).length;
}

/** Load the three records and decide. Admin SDK only. */
async function stateFor(db, uid, nowMs) {
  const now = nowMs || Date.now();
  const [dSnap, vSnap, pSnap, staleSeconds, activeCount] = await Promise.all([
    db.collection('drivers').doc(uid).get(),
    db.collection('driverVerification').doc(uid).get(),
    db.collection('rideDrivers').doc(uid).get(),
    staleAfterSeconds(db, now),
    activeJobCount(db, uid),
  ]);
  const driver = dSnap.exists ? dSnap.data() : null;
  const presence = pSnap.exists ? pSnap.data() : null;
  const st = presenceState({
    presence, driver,
    verification: vSnap.exists ? vSnap.data() : null, nowMs: now, staleSeconds, activeCount,
  });
  /* F1: the rider's position for server-side distance — only when valid AND reported within the
     same stale window as presence. An old fix is not a position (unknown → distance stays null). */
  const locAt = presence ? toMillis(presence.locationUpdatedAt) : null;
  const location = (presence && locAt && now - locAt <= staleSeconds * 1000) ? validLocation(presence) : null;
  return Object.assign(st, { staleSeconds, activeCount, driver, location });
}

/**
 * Is this job one the SERVER created and readied? `pkg` is the packageRequests doc (id + data).
 * Returns { ok, reason, order }. Reason is for logs only.
 */
async function validateJob(db, pkg, getFn) {
  const get = getFn || ((ref) => ref.get());
  const d = pkg || {};
  if (!d.orderId) return { ok: false, reason: 'no_order' };
  if (d.id !== 'DEL' + d.orderId) return { ok: false, reason: 'non_canonical_id' };
  if (d.status !== 'awaiting_rider') return { ok: false, reason: 'job_not_awaiting_rider' };
  if (d.assignedRiderId || d.riderId || d.assignedDriverId || d.assignedDriverUid) return { ok: false, reason: 'job_assigned' };
  const os = await get(db.collection('orders').doc(String(d.orderId)));
  if (!os.exists) return { ok: false, reason: 'order_missing' };
  const o = os.data() || {};
  if (o.paymentVerified !== true) return { ok: false, reason: 'order_not_payment_verified' };
  if (o.status !== 'awaiting_rider') return { ok: false, reason: 'order_not_ready_for_rider' };
  if (o.assignedDriverUid || o.riderId) return { ok: false, reason: 'order_assigned' };
  if (d.sellerUid && o.sellerUid && d.sellerUid !== o.sellerUid) return { ok: false, reason: 'seller_mismatch' };
  return { ok: true, reason: 'ok', order: o };
}

/**
 * The delivery fee a rider may be SHOWN, from a server-only money record — never order.deliveryFee,
 * which on the M-PESA path can be the browser pre-write (the webhook merges paid fields without
 * overwriting it). The product_order intent is minted AT the order id with a server-recomputed
 * metadata.deliveryFee, and `paymentIntents` has no client write rule. No server record → null,
 * which the board renders as — (the card path gains a server record when the delivery-price
 * convergence lands; until then it is honestly unknown).
 */
function serverDeliveryFee(intentSnap, orderId) {
  if (!intentSnap || !intentSnap.exists) return null;
  const i = intentSnap.data() || {};
  const m = i.metadata || {};
  if (i.purpose !== 'product_order' || String(i.resourceId || m.orderId || '') !== String(orderId)) return null;
  const fee = Number(m.deliveryFee);
  return Number.isFinite(fee) && fee >= 0 ? fee : null;
}

/** Can a rider of `riderVehicle` carry a job that asks for `jobVehicle`? No requirement → yes. */
function vehicleCompatible(riderVehicle, jobVehicle) {
  if (!jobVehicle) return true;
  const jc = vehicleClasses.canonicalise(jobVehicle);
  if (!jc) return true;                       /* an unrecognised request is not a requirement */
  const need = vehicleClasses.capacityOf(jc);
  const have = vehicleClasses.capacityOf(riderVehicle);
  if (!need) return true;                     /* unpriced class: no authoritative size to compare */
  if (!have) return false;
  return Number(have.sizeRank) >= Number(need.sizeRank);
}

/** Presence freshness for dispatch candidates (they carry the raw shard). */
function isFresh(presenceDoc, nowMs, staleSeconds) {
  const p = presenceDoc || {};
  if (p.presence === 'offline') return false;
  const last = toMillis(p.lastSeen);
  return !!last && nowMs - last <= staleSeconds * 1000;
}

/* Coarse, rider-safe label: never the eligibility reason (it names the gate to attack). */
function publicState(st) {
  return st.state === 'suspended' || st.state === 'ineligible' ? 'not_eligible' : st.state;
}

function validLocation(data) {
  const lat = Number(data && data.lat), lng = Number(data && data.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180 || (lat === 0 && lng === 0)) return null;
  return { lat, lng };
}

async function displayNameFor(db, uid, driver, token) {
  try {
    const u = await db.collection('users').doc(uid).get();
    const x = u.exists ? (u.data() || {}) : {};
    const n = x.name || x.displayName || x.fullName || (driver && driver.name) || (token && token.name) || null;
    return n ? String(n).trim().slice(0, 60) : null;
  } catch (_) { return (driver && driver.name) || null; }
}

/**
 * riderPresence({ action: 'online' | 'heartbeat' | 'offline' | 'status', lat?, lng? })
 * The ONLY writer of rideDrivers presence. Returns { state, staleAfterSeconds, displayName }.
 */
function makeRiderPresence({ onCall, HttpsError, admin, db }) {
  return onCall({ region: 'us-central1', timeoutSeconds: 20, memory: '256MiB' }, async (req) => {
    const uid = req.auth && req.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in to go online.');
    const action = String((req.data && req.data.action) || '');
    if (!['online', 'heartbeat', 'offline', 'status'].includes(action)) {
      throw new HttpsError('invalid-argument', 'Unknown presence action.');
    }
    const ts = admin.firestore.FieldValue.serverTimestamp();
    const ref = db.collection('rideDrivers').doc(uid);
    const now = Date.now();
    const before = await stateFor(db, uid, now);
    const displayName = await displayNameFor(db, uid, before.driver, req.auth.token);
    const reply = (st) => ({ ok: true, state: publicState(st), staleAfterSeconds: before.staleSeconds,
      activeCount: before.activeCount, displayName });

    if (action === 'status') return reply(before);

    if (action === 'offline') {
      /* Always allowed — a suspended or ineligible rider may still take themselves off the road. */
      await ref.set({ presence: 'offline', isOnline: false, online: false, offlineAt: ts, updatedAt: ts }, { merge: true });
      /* An eligible rider is now offline; a suspended/ineligible one keeps reporting that. */
      const restricted = before.state === 'suspended' || before.state === 'ineligible';
      return reply(restricted ? before : { state: 'offline' });
    }

    if (!['online', 'on_delivery', 'stale', 'offline'].includes(before.state)) {
      /* suspended / ineligible: refuse, and make sure no stale "online" flag keeps them dispatchable. */
      console.warn('[riderPresence] refused', { uid, action, reason: before.reason });
      await ref.set({ presence: 'offline', isOnline: false, online: false, updatedAt: ts }, { merge: true });
      return reply(before);
    }
    if (action === 'heartbeat' && before.state === 'offline') {
      /* A heartbeat never turns an explicit offline back on — the rider must choose to go online. */
      return reply(before);
    }
    const loc = validLocation(req.data);
    const d = before.driver || {};
    const patch = {
      presence: 'online', isOnline: true, online: true, lastSeen: ts, updatedAt: ts,
      /* identity + capability from the server record, not from the device */
      name: d.name || null, vehicleType: vehicleClasses.dispatchKey(d.vehicleType) || null,
      activeDeliveries: before.activeCount,
    };
    if (loc) { patch.lat = loc.lat; patch.lng = loc.lng; patch.locationUpdatedAt = ts; }
    if (action === 'online') patch.onlineAt = ts;
    await ref.set(patch, { merge: true });
    /* The rider was eligible (checked above) and is now fresh. */
    return reply({ state: before.activeCount > 0 ? 'on_delivery' : 'online' });
  });
}

module.exports = {
  DEFAULT_STALE_SECONDS, ACTIVE_JOB_STATUSES,
  staleAfterSeconds, presenceState, stateFor, activeJobCount, validateJob, vehicleCompatible, serverDeliveryFee,
  isFresh, publicState, validLocation, displayNameFor, makeRiderPresence, toMillis, _resetConfigCache,
};
