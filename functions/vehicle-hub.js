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
/* Car Hub C4 (sokoni-f3, 2026-10-03). The numeric role gate above (customClaims.role >= 2 / >= 4) predates the role
   lifecycle: applicationDecide sets NAMED claims (seller / provider / admin …), never a numeric role, so every
   createVehicleListing was refused and every admin check failed. Admin = the named claims, as firestore.rules isAdmin(). */
function isAdminReq(req) {
  const t = (req && req.auth && req.auth.token) || {};
  return t.admin === true || t.superAdmin === true || t.role === 'admin' || t.role === 'superAdmin' || (typeof t.role === 'number' && t.role >= 80);
}
/* Owner 2026-10-03: MARKETPLACE FIRST, basic listing FREE, nothing public without AdminOS approval.
   draft → (seller submits) pending_review → (AdminOS) active | rejected ; active → (AdminOS) suspended ;
   seller may close active/pending as sold | withdrawn. A material edit of an active listing returns it to review. */
const OPEN_STATES = ['draft', 'pending_review', 'active'];
const MAX_OPEN_PER_SELLER = 20;   /* spam guard for the free basic listing */

const VEHICLE_TYPES = ['sedan', 'suv', 'pickup', 'van', 'bus', 'truck', 'motorbike', 'tuk_tuk', 'bicycle', 'boat', 'other'];
const FUEL_TYPES = ['petrol', 'diesel', 'electric', 'hybrid', 'lpg', 'other'];
const CONDITIONS = ['new', 'used_excellent', 'used_good', 'used_fair', 'salvage'];
const LISTING_TYPES = ['for_sale', 'for_rent', 'lease'];

/* ── 1. createVehicleListing ── */
exports.createVehicleListing = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  /* Any signed-in account may draft a listing (private sellers included); it becomes public only after AdminOS review. */
  const open = await db().collection('vehicleListings').where('sellerUid', '==', uid).limit(MAX_OPEN_PER_SELLER + 30).get();
  if (open.docs.filter((d) => OPEN_STATES.includes(d.data().status)).length >= MAX_OPEN_PER_SELLER) {
    throw new HttpsError('resource-exhausted', 'You have reached the limit of open vehicle listings. Close a sold or withdrawn one first.');
  }

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
    condition: CONDITIONS.includes(condition) ? condition : 'used_good',
    price: (function (n) { if (!(n > 0) || n > 1e9) throw new HttpsError('invalid-argument', 'price must be a positive amount'); return n; })(parseFloat(price)),
    currency: currency === 'USD' ? 'USD' : 'KES',
    /* hasLogbook / importDutyPaid below are the SELLER'S DECLARATIONS — never shown as verified. */
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
  const cur = snap.data();
  if (cur.sellerUid !== uid && !isAdminReq(req)) throw new HttpsError('permission-denied', 'Not authorized');
  if (['sold', 'withdrawn'].includes(cur.status)) throw new HttpsError('failed-precondition', 'This listing is closed.');

  /* 'status' is NOT editable here (it was: a seller could set status:'active' and skip review). Values are sanitised. */
  const updates = { updatedAt: FieldValue.serverTimestamp() };
  if (fields.price !== undefined) { const n = parseFloat(fields.price); if (!(n > 0) || n > 1e9) throw new HttpsError('invalid-argument', 'price must be a positive amount'); updates.price = n; }
  if (fields.description !== undefined) updates.description = san(fields.description, 3000);
  if (fields.images !== undefined) updates.images = Array.isArray(fields.images) ? fields.images.slice(0, 15).map((i) => san(i, 500)) : [];
  if (fields.color !== undefined) updates.color = san(fields.color, 40);
  if (fields.mileageKm !== undefined) updates.mileageKm = Math.max(0, parseInt(fields.mileageKm) || 0);
  if (fields.negotiable !== undefined) updates.negotiable = Boolean(fields.negotiable);
  if (fields.location !== undefined) updates.location = san(fields.location, 100);
  const material = ['description', 'images', 'mileageKm'].some((k) => updates[k] !== undefined);
  if (cur.status === 'active' && material && !isAdminReq(req)) { updates.status = 'pending_review'; updates.resubmittedAt = FieldValue.serverTimestamp(); }
  await ref.update(updates);
  return { ok: true, status: updates.status || cur.status };
});

/* ── 3. publishVehicleListing ── */
exports.publishVehicleListing = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { listingId } = req.data;
  if (!listingId) throw new HttpsError('invalid-argument', 'listingId required');

  const ref = db().collection('vehicleListings').doc(listingId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Listing not found');
  const cur = snap.data();
  if (cur.sellerUid !== uid) throw new HttpsError('permission-denied', 'Not authorized');
  if (!['draft', 'rejected'].includes(cur.status)) throw new HttpsError('failed-precondition', 'Only a draft or rejected listing can be submitted for review.');
  /* Was: status 'active' at once — any account published any car with no review. Now AdminOS decides (moderateVehicleListing). */
  await ref.update({ status: 'pending_review', submittedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  return { ok: true, status: 'pending_review' };
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
    if (!uid || (v.sellerUid !== uid && !isAdminReq(req))) throw new HttpsError('not-found', 'Listing not found');
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
  if (listingSnap.data().sellerUid !== uid && !isAdminReq(req)) throw new HttpsError('permission-denied', 'Not authorized');

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

/* ── 11. moderateVehicleListing (AdminOS) — the ONLY path to a public listing ── */
exports.moderateVehicleListing = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  if (!isAdminReq(req)) throw new HttpsError('permission-denied', 'Admin only');
  const { listingId, decision, reason } = req.data || {};
  if (!listingId) throw new HttpsError('invalid-argument', 'listingId required');
  const TO = { approve: 'active', reject: 'rejected', suspend: 'suspended', restore: 'active' };
  if (!Object.prototype.hasOwnProperty.call(TO, decision)) throw new HttpsError('invalid-argument', 'decision must be approve | reject | suspend | restore');
  if ((decision === 'reject' || decision === 'suspend') && !san(reason, 500)) throw new HttpsError('invalid-argument', 'A reason is required to reject or suspend.');
  const ref = db().collection('vehicleListings').doc(listingId);
  const FROM = { approve: ['pending_review'], reject: ['pending_review'], suspend: ['active'], restore: ['suspended'] };
  const out = await db().runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Listing not found');
    const cur = snap.data();
    if (!FROM[decision].includes(cur.status)) throw new HttpsError('failed-precondition', 'Listing is ' + cur.status + ' — cannot ' + decision + '.');
    const to = TO[decision];
    const patch = { status: to, updatedAt: FieldValue.serverTimestamp(), lastModeration: { decision, by: uid, reason: san(reason, 500) || null, at: FieldValue.serverTimestamp() } };
    if (to === 'active') patch.publishedAt = FieldValue.serverTimestamp();
    t.update(ref, patch);
    t.set(db().collection('adminAudit').doc(), { action: 'vehicle_listing_' + decision, actorUid: uid, targetId: listingId, from: cur.status, to, reason: san(reason, 500) || null, createdAt: FieldValue.serverTimestamp() });
    return { from: cur.status, to };
  });
  return { ok: true, status: out.to };
});

/* ── 12. closeVehicleListing (seller) — sold / withdrawn; the sale itself happens outside SOKONI (marketplace first) ── */
exports.closeVehicleListing = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { listingId, outcome } = req.data || {};
  if (!listingId || !['sold', 'withdrawn'].includes(outcome)) throw new HttpsError('invalid-argument', 'listingId and outcome (sold | withdrawn) required');
  const ref = db().collection('vehicleListings').doc(listingId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Listing not found');
  if (snap.data().sellerUid !== uid) throw new HttpsError('permission-denied', 'Not authorized');
  if (!['draft', 'pending_review', 'active', 'rejected'].includes(snap.data().status)) throw new HttpsError('failed-precondition', 'This listing cannot be closed.');
  await ref.update({ status: outcome, closedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  return { ok: true, status: outcome };
});

/* ── 13. listMyVehicleListings (seller dashboard) — every status, own listings only ── */
exports.listMyVehicleListings = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const snap = await db().collection('vehicleListings').where('sellerUid', '==', uid).limit(100).get();
  const listings = snap.docs.map((d) => { const v = d.data(); return { listingId: v.listingId, make: v.make, model: v.model, year: v.year, price: v.price, currency: v.currency,
    status: v.status, enquiryCount: v.enquiryCount || 0, viewCount: v.viewCount || 0, lastModeration: v.lastModeration ? { decision: v.lastModeration.decision, reason: v.lastModeration.reason || null } : null }; });
  return { listings };
});

/* ── 14. listVehicleReviewQueue (AdminOS) — listings awaiting a decision ── */
exports.listVehicleReviewQueue = onCall(CF_OPTS, async (req) => {
  requireAuth(req);
  if (!isAdminReq(req)) throw new HttpsError('permission-denied', 'Admin only');
  const snap = await db().collection('vehicleListings').where('status', '==', 'pending_review').limit(100).get();
  return { listings: snap.docs.map((d) => d.data()) };
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
  moderateVehicleListing: exports.moderateVehicleListing,
  closeVehicleListing:    exports.closeVehicleListing,
  listMyVehicleListings:  exports.listMyVehicleListings,
  listVehicleReviewQueue: exports.listVehicleReviewQueue,
};
