'use strict';
/**
 * pickup-location.js — F1, the pickup-location authority (owner 2026-09-30).
 *
 * THE CONTRACT
 *   merchant → shops/{shopId}.pickupLocation            (server-validated {lat,lng}; shopSetPickupLocation)
 *            → deliveryPickups/{deliveryRef}            (SERVER-ONLY snapshot, created once)
 *            → packageRequests.pickupLocation           (a projection, rewritten by every server write)
 *            → distance computed on the server only     (rider board, dispatch, batching, navigation)
 *
 * THE NEGATIVE CONTRACT
 *   no pickup coordinates → NO distance, NO proximity claim, NO rider-radius claim, NO batching.
 *   Nothing here substitutes 0°,0°, the drop-off, a default kilometre figure or a random one.
 *
 * WHY A SEPARATE SERVER-ONLY RECORD
 *   packageRequests can still be created and edited from a browser (the create-rule hardening is a
 *   separate, not-yet-approved slice). A pickup kept on that document would therefore keep a FORGED
 *   pickup a buyer pre-created. deliveryPickups has NO firestore rule — deny-by-default, exactly like
 *   deliveryPins — so only the Admin SDK reads or writes it, and it is written with create(): the
 *   first snapshot for a delivery wins, a retried webhook or a second "ready" cannot replace it, and
 *   a shop that later moves its pickup does not rewrite deliveries already created. Every consumer
 *   reads THIS record; the projection on packageRequests is display only.
 *
 * WHY (2026-09-30 census)
 *   No production writer stored numeric pickup coordinates (webhookIntasend wrote pickupCoords:null,
 *   the click-and-collect "ready" path wrote none, no shop had coordinates), and downstream code
 *   invented positions: 0°,0° in optimizeBatchRoute / findBestHub / _scoreRider, and the drop-off
 *   substituted for the pickup in navDispatchRider.
 *
 * REUSED, NOT RE-INVENTED
 *   - the location shape and its validation: geo-point.validLocation (the D2 rule, re-exported by rider-presence);
 *   - who may act for a shop: shop-employees.resolveShopAccess / shopOwnerOf (self-contained: it needs
 *     only npm packages, so it travels whole into any functions lineage — see the F1 port notes).
 */

const { validLocation } = require('./geo-point');     /* the D2 rule, from its leaf module */

const PICKUPS = 'deliveryPickups';
const LABEL_MAX = 120;
const EARTH_KM = 6371;

function _san(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
}

/** The one distance function: great-circle km between two VALID points, else null. */
function distanceKm(a, b) {
  const p = validLocation(a), q = validLocation(b);
  if (!p || !q) return null;
  const rad = (d) => d * Math.PI / 180;
  const dLat = rad(q.lat - p.lat), dLng = rad(q.lng - p.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(p.lat)) * Math.cos(rad(q.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_KM * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)) * 100) / 100;
}

/** The drop-off point of a delivery record, or null. NEVER the pickup, never 0°,0°. (Buyer
    destination is not F1's authority; this only stops downstream code inventing one.) */
function dropoffPointOf(d) {
  if (!d) return null;
  return validLocation(d.deliveryCoords)
    || validLocation(d.destination)
    || validLocation({ lat: d.dropoffLat, lng: d.dropoffLng })
    || validLocation({ lat: d.deliveryLat, lng: d.deliveryLng })
    || null;
}

/** A shop's pickup snapshot, or null when the shop has no valid point. */
function snapshotFromShop(shopId, shopData) {
  const loc = shopData && shopData.pickupLocation;
  const p = validLocation(loc);
  if (!p) return null;
  return {
    lat: p.lat, lng: p.lng,
    label: _san(loc.label, LABEL_MAX) || null,
    shopId: String(shopId),
    version: Number.isFinite(Number(loc.version)) ? Number(loc.version) : 1,
    source: 'shop',
  };
}

/**
 * Resolve the shop a delivery's pickup belongs to. A named shopId is read directly; otherwise the
 * seller's shop is found by READING shops — never guessed. More than one owned shop is ambiguous and
 * resolves to null with a reason (a pickup must not be picked arbitrarily).
 */
async function resolveShop(db, { shopId, sellerUid }) {
  const { shopOwnerOf } = require('./shop-employees');
  if (shopId) {
    const s = await db.collection('shops').doc(String(shopId)).get();
    return s.exists ? { id: s.id, data: s.data() } : { id: null, reason: 'shop_not_found' };
  }
  if (!sellerUid) return { id: null, reason: 'no_seller' };
  const direct = await db.collection('shops').doc(String(sellerUid)).get();
  if (direct.exists && shopOwnerOf(direct.data()) === sellerUid) return { id: direct.id, data: direct.data() };
  const found = new Map();
  for (const field of ['ownerId', 'sellerUid', 'ownerUid']) {
    const q = await db.collection('shops').where(field, '==', sellerUid).limit(2).get();
    q.docs.forEach((doc) => found.set(doc.id, doc.data()));
  }
  if (found.size === 1) { const [id, data] = [...found][0]; return { id, data }; }
  return { id: null, reason: found.size ? 'shop_ambiguous' : 'no_shop' };
}

function _projection(snap) {
  return {
    pickupLocation: { lat: snap.lat, lng: snap.lng, label: snap.label || null, shopId: snap.shopId, version: snap.version, source: 'shop' },
    pickupCoords: { lat: snap.lat, lng: snap.lng },
    pickupLocationGap: null,
  };
}

/**
 * The pickup fields a delivery writer merges onto packageRequests/{deliveryRef}.
 * 1. The server-only deliveryPickups/{deliveryRef} snapshot, when it exists, is THE fact: its
 *    projection is returned (overwriting anything a client put on the delivery).
 * 2. Otherwise the seller's shop snapshot is created there with create() — first write wins, so a
 *    concurrent or repeated creation converges on one fact — and projected.
 * 3. No shop point → an explicit gap (no record is created, so a later server write can still
 *    snapshot the location once the shop sets one — that fills a gap, it cannot contradict a fact).
 * Client-supplied pickup values are never read.
 */
async function ensureDeliveryPickup(db, deliveryRef, { shopId, sellerUid }) {
  const ref = db.collection(PICKUPS).doc(String(deliveryRef));
  const existing = await ref.get();
  if (existing.exists && validLocation(existing.data())) return _projection(existing.data());
  const shop = await resolveShop(db, { shopId, sellerUid });
  const snap = shop.id ? snapshotFromShop(shop.id, shop.data) : null;
  if (!snap) {
    return { pickupLocation: null, pickupCoords: null, pickupLocationGap: shop.id ? 'shop_has_no_pickup_location' : (shop.reason || 'no_shop') };
  }
  const { FieldValue } = require('firebase-admin/firestore');
  try {
    await ref.create(Object.assign({}, snap, { deliveryRef: String(deliveryRef), capturedAt: FieldValue.serverTimestamp() }));
    return _projection(snap);
  } catch (e) {
    /* Lost the race to another writer: that record is the fact. */
    const again = await ref.get();
    if (again.exists && validLocation(again.data())) return _projection(again.data());
    throw e;
  }
}

/**
 * The AUTHORITATIVE pickup point for each delivery ref: read from deliveryPickups only (one
 * batched read). A ref without a record maps to null — unknown — whatever the delivery document
 * itself claims.
 */
async function authoritativePickups(db, refs) {
  const ids = [...new Set((refs || []).filter(Boolean).map(String))];
  const out = new Map();
  if (!ids.length) return out;
  const snaps = await db.getAll(...ids.map((id) => db.collection(PICKUPS).doc(id)));
  snaps.forEach((s, i) => out.set(ids[i], s.exists ? validLocation(s.data()) : null));
  return out;
}

/**
 * shopSetPickupLocation — the ONLY writer of shops/{shopId}.pickupLocation.
 *   data: { shopId, lat, lng, label? }  or  { shopId, clear: true }
 * Who: the shop owner, a platform admin, or a corroborated employee with the manager role
 * (shop-employees.resolveShopAccess). Cashiers and other roles are refused.
 */
function makeSetPickupLocation({ onCall, HttpsError, admin, db, logger }) {
  return onCall({ region: 'us-central1', timeoutSeconds: 20, memory: '256MiB', enforceAppCheck: true }, async (req) => {
    const uid = req.auth && req.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in to set your pickup location.');
    const data = req.data || {};
    const shopId = _san(data.shopId, 128);
    if (!shopId) throw new HttpsError('invalid-argument', 'shopId is required.');

    const { resolveShopAccess } = require('./shop-employees');
    const access = await resolveShopAccess(uid, shopId);   /* throws permission-denied when none */
    const allowed = access.via === 'owner' || access.via === 'admin' || (access.via === 'employee' && access.role === 'manager');
    if (!allowed) throw new HttpsError('permission-denied', 'Only the shop owner or a manager can set the pickup location.');

    const ref = db.collection('shops').doc(shopId);
    const FV = admin.firestore.FieldValue;
    if (data.clear === true) {
      await ref.update({ pickupLocation: FV.delete(), updatedAt: FV.serverTimestamp() });
      if (logger) logger.info('[shopSetPickupLocation] cleared', { shopId, by: uid, via: access.via });
      return { ok: true, pickupLocation: null };
    }

    const p = validLocation(data);
    if (!p) throw new HttpsError('invalid-argument', 'A valid latitude and longitude are required.');
    const label = _san(data.label, LABEL_MAX) || null;
    const saved = await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'Shop not found.');
      const prev = (snap.data() || {}).pickupLocation;
      const version = (prev && Number.isFinite(Number(prev.version)) ? Number(prev.version) : 0) + 1;
      t.update(ref, {
        pickupLocation: { lat: p.lat, lng: p.lng, label, version, source: 'merchant', setBy: uid, setVia: access.via, setAt: FV.serverTimestamp() },
        updatedAt: FV.serverTimestamp(),
      });
      return { lat: p.lat, lng: p.lng, label, version };
    });
    if (logger) logger.info('[shopSetPickupLocation] set', { shopId, by: uid, via: access.via, version: saved.version });
    return { ok: true, pickupLocation: saved };
  });
}

module.exports = {
  PICKUPS, LABEL_MAX,
  distanceKm, dropoffPointOf, snapshotFromShop, resolveShop,
  ensureDeliveryPickup, authoritativePickups, makeSetPickupLocation,
};
