'use strict';
/**
 * Vehicle Hub v1.0 — SOKONI Platform
 * Vehicle listings (buy/sell/rent), enquiries, comparisons
 * 10 Cloud Functions | enforceAppCheck: true | region: us-central1
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const REGION = 'us-central1';
const CF_OPTS = { region: REGION, enforceAppCheck: true };
const db = () => admin.firestore();
const auth = () => admin.auth();
const FieldValue = admin.firestore.FieldValue;

function requireAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  return req.auth.uid;
}
async function getRole(uid) {
  const tok = await auth().getUser(uid);
  return (tok.customClaims || {}).role || 0;
}
function san(s, max = 200) { return s == null ? '' : String(s).trim().slice(0, max); }

const VEHICLE_TYPES = ['sedan', 'suv', 'pickup', 'van', 'bus', 'truck', 'motorbike', 'tuk_tuk', 'bicycle', 'boat', 'other'];
const FUEL_TYPES = ['petrol', 'diesel', 'electric', 'hybrid', 'lpg', 'other'];
const CONDITIONS = ['new', 'used_excellent', 'used_good', 'used_fair', 'salvage'];
const LISTING_TYPES = ['for_sale', 'for_rent', 'lease'];

/* ── 1. createVehicleListing ── */
exports.createVehicleListing = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const role = await getRole(uid);
  if (role < 2) throw new HttpsError('permission-denied', 'Seller role required');

  const {
    make, model, year, vehicleType, listingType, condition,
    price, currency, fuelType, transmission, mileageKm,
    engineCC, color, description, images,
    location, county, negotiable, hasLogbook, importDutyPaid,
    seats, doors,
  } = req.data;

  if (!make || !model || !year || !vehicleType || !listingType || price == null) {
    throw new HttpsError('invalid-argument', 'make, model, year, vehicleType, listingType, price required');
  }
  if (!VEHICLE_TYPES.includes(vehicleType)) throw new HttpsError('invalid-argument', 'Invalid vehicleType');
  if (!LISTING_TYPES.includes(listingType)) throw new HttpsError('invalid-argument', 'Invalid listingType');

  const ref = db().collection('vehicleListings').doc();
  await ref.set({
    listingId: ref.id, sellerUid: uid,
    make: san(make, 60), model: san(model, 80),
    year: parseInt(year), vehicleType, listingType,
    condition: VEHICLE_TYPES.includes(condition) ? condition : (CONDITIONS.includes(condition) ? condition : 'used_good'),
    price: parseFloat(price), currency: currency === 'USD' ? 'USD' : 'KES',
    fuelType: FUEL_TYPES.includes(fuelType) ? fuelType : 'petrol',
    transmission: ['automatic', 'manual', 'semi_auto'].includes(transmission) ? transmission : 'manual',
    mileageKm: parseInt(mileageKm) || 0,
    engineCC: parseInt(engineCC) || null,
    color: san(color, 40),
    description: san(description, 3000),
    images: Array.isArray(images) ? images.slice(0, 15).map(i => san(i, 500)) : [],
    location: san(location, 100), county: san(county, 80), country: 'Kenya',
    negotiable: Boolean(negotiable),
    hasLogbook: Boolean(hasLogbook),
    importDutyPaid: Boolean(importDutyPaid),
    seats: parseInt(seats) || null, doors: parseInt(doors) || null,
    status: 'draft',
    viewCount: 0, enquiryCount: 0, savedCount: 0,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  return { listingId: ref.id, status: 'draft' };
});

/* ── 2. updateVehicleListing ── */
exports.updateVehicleListing = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { listingId, ...fields } = req.data;
  if (!listingId) throw new HttpsError('invalid-argument', 'listingId required');

  const ref = db().collection('vehicleListings').doc(listingId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Listing not found');
  const role = await getRole(uid);
  if (snap.data().sellerUid !== uid && role < 4) throw new HttpsError('permission-denied', 'Not authorized');

  const allowed = ['price','description','images','color','mileageKm','negotiable','status','location'];
  const updates = { updatedAt: FieldValue.serverTimestamp() };
  for (const k of allowed) { if (fields[k] !== undefined) updates[k] = fields[k]; }
  await ref.update(updates);
  return { ok: true };
});

/* ── 3. publishVehicleListing ── */
exports.publishVehicleListing = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { listingId } = req.data;
  if (!listingId) throw new HttpsError('invalid-argument', 'listingId required');

  const ref = db().collection('vehicleListings').doc(listingId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Listing not found');
  const role = await getRole(uid);
  if (snap.data().sellerUid !== uid && role < 4) throw new HttpsError('permission-denied', 'Not authorized');

  await ref.update({ status: 'active', publishedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

/* ── 4. getVehicle ── */
exports.getVehicle = onCall(CF_OPTS, async (req) => {
  const { listingId } = req.data;
  if (!listingId) throw new HttpsError('invalid-argument', 'listingId required');
  const snap = await db().collection('vehicleListings').doc(listingId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Listing not found');
  const v = snap.data();
  if (v.status !== 'active') {
    const uid = req.auth?.uid;
    const role = uid ? await getRole(uid) : 0;
    if (!uid || (v.sellerUid !== uid && role < 4)) throw new HttpsError('not-found', 'Listing not found');
  }
  db().collection('vehicleListings').doc(listingId).update({ viewCount: FieldValue.increment(1) }).catch(() => {});
  return v;
});

/* ── 5. listVehicles ── */
exports.listVehicles = onCall(CF_OPTS, async (req) => {
  const { vehicleType, listingType, make, minPrice, maxPrice,
          minYear, maxYear, fuelType, county, limit = 24, cursor } = req.data;

  let q = db().collection('vehicleListings')
    .where('status', '==', 'active')
    .orderBy('createdAt', 'desc')
    .limit(Math.min(50, parseInt(limit) || 24));

  if (vehicleType && VEHICLE_TYPES.includes(vehicleType)) {
    q = db().collection('vehicleListings')
      .where('status', '==', 'active')
      .where('vehicleType', '==', vehicleType)
      .orderBy('createdAt', 'desc')
      .limit(Math.min(50, parseInt(limit) || 24));
  }

  if (cursor) {
    const c = await db().collection('vehicleListings').doc(cursor).get();
    if (c.exists) q = q.startAfter(c);
  }

  const snap = await q.get();
  let listings = snap.docs.map(d => {
    const v = d.data();
    return { listingId: v.listingId, make: v.make, model: v.model, year: v.year,
      vehicleType: v.vehicleType, listingType: v.listingType, price: v.price,
      currency: v.currency, mileageKm: v.mileageKm, fuelType: v.fuelType,
      transmission: v.transmission, condition: v.condition, color: v.color,
      county: v.county, negotiable: v.negotiable,
      images: (v.images || []).slice(0, 1), viewCount: v.viewCount };
  });

  if (make) listings = listings.filter(v => v.make.toLowerCase().includes(make.toLowerCase()));
  if (fuelType && FUEL_TYPES.includes(fuelType)) listings = listings.filter(v => v.fuelType === fuelType);
  if (county) listings = listings.filter(v => (v.county || '').toLowerCase().includes(county.toLowerCase()));
  if (minPrice) listings = listings.filter(v => v.price >= parseFloat(minPrice));
  if (maxPrice) listings = listings.filter(v => v.price <= parseFloat(maxPrice));
  if (minYear) listings = listings.filter(v => v.year >= parseInt(minYear));
  if (maxYear) listings = listings.filter(v => v.year <= parseInt(maxYear));
  if (listingType && LISTING_TYPES.includes(listingType)) listings = listings.filter(v => v.listingType === listingType);

  const nextCursor = snap.docs.length === Math.min(50, parseInt(limit) || 24)
    ? snap.docs[snap.docs.length - 1].id : null;
  return { listings, nextCursor };
});

/* ── 6. searchVehicles ── */
exports.searchVehicles = onCall(CF_OPTS, async (req) => {
  const { query, limit = 20 } = req.data;
  if (!query) throw new HttpsError('invalid-argument', 'query required');
  const q = query.toLowerCase();
  const snap = await db().collection('vehicleListings')
    .where('status', '==', 'active').orderBy('createdAt', 'desc').limit(200).get();
  const results = snap.docs.map(d => d.data())
    .filter(v =>
      v.make.toLowerCase().includes(q) || v.model.toLowerCase().includes(q) ||
      String(v.year).includes(q) || v.vehicleType.includes(q) ||
      (v.description || '').toLowerCase().includes(q) ||
      (v.county || '').toLowerCase().includes(q)
    )
    .slice(0, Math.min(40, parseInt(limit) || 20))
    .map(v => ({ listingId: v.listingId, make: v.make, model: v.model, year: v.year,
      price: v.price, currency: v.currency, county: v.county,
      images: (v.images || []).slice(0, 1) }));
  return { results };
});

/* ── 7. submitVehicleEnquiry ── */
exports.submitVehicleEnquiry = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { listingId, message, phone, offerPrice } = req.data;
  if (!listingId || !message) throw new HttpsError('invalid-argument', 'listingId and message required');

  const snap = await db().collection('vehicleListings').doc(listingId).get();
  if (!snap.exists || snap.data().status !== 'active') throw new HttpsError('not-found', 'Listing not found');

  const ref = db().collection('vehicleEnquiries').doc();
  const batch = db().batch();
  batch.set(ref, {
    enquiryId: ref.id, listingId, buyerUid: uid,
    sellerUid: snap.data().sellerUid,
    message: san(message, 1000), phone: san(phone, 20),
    offerPrice: offerPrice ? parseFloat(offerPrice) : null,
    status: 'new', createdAt: FieldValue.serverTimestamp(),
  });
  batch.update(db().collection('vehicleListings').doc(listingId), {
    enquiryCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();
  return { enquiryId: ref.id };
});

/* ── 8. getVehicleEnquiries (seller) ── */
exports.getVehicleEnquiries = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { listingId } = req.data;
  if (!listingId) throw new HttpsError('invalid-argument', 'listingId required');

  const listingSnap = await db().collection('vehicleListings').doc(listingId).get();
  if (!listingSnap.exists) throw new HttpsError('not-found', 'Listing not found');
  const role = await getRole(uid);
  if (listingSnap.data().sellerUid !== uid && role < 4) throw new HttpsError('permission-denied', 'Not authorized');

  const snap = await db().collection('vehicleEnquiries')
    .where('listingId', '==', listingId)
    .orderBy('createdAt', 'desc').limit(100).get();
  return { enquiries: snap.docs.map(d => d.data()) };
});

/* ── 9. compareVehicles ── */
exports.compareVehicles = onCall(CF_OPTS, async (req) => {
  const { listingIds } = req.data;
  if (!Array.isArray(listingIds) || listingIds.length < 2 || listingIds.length > 4) {
    throw new HttpsError('invalid-argument', 'Provide 2–4 listingIds to compare');
  }
  const snaps = await Promise.all(listingIds.map(id => db().collection('vehicleListings').doc(id).get()));
  const vehicles = snaps
    .filter(s => s.exists && s.data().status === 'active')
    .map(s => s.data());
  return { vehicles };
});

/* ── 10. reportVehicleListing ── */
exports.reportVehicleListing = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { listingId, reason } = req.data;
  if (!listingId || !reason) throw new HttpsError('invalid-argument', 'listingId and reason required');

  const ref = db().collection('vehicleReports').doc();
  await ref.set({
    reportId: ref.id, listingId, reporterUid: uid,
    reason: san(reason, 500), status: 'open',
    createdAt: FieldValue.serverTimestamp(),
  });
  return { reportId: ref.id };
});

module.exports = {
  createVehicleListing:  exports.createVehicleListing,
  updateVehicleListing:  exports.updateVehicleListing,
  publishVehicleListing: exports.publishVehicleListing,
  getVehicle:            exports.getVehicle,
  listVehicles:          exports.listVehicles,
  searchVehicles:        exports.searchVehicles,
  submitVehicleEnquiry:  exports.submitVehicleEnquiry,
  getVehicleEnquiries:   exports.getVehicleEnquiries,
  compareVehicles:       exports.compareVehicles,
  reportVehicleListing:  exports.reportVehicleListing,
};
