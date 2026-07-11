'use strict';
/**
 * Property Hub v1.0 â€” SOKONI Platform
 * Property listings, enquiries, viewings, agent management
 * 12 Cloud Functions | enforceAppCheck: true | region: us-central1
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const REGION = 'us-central1';
const CF_OPTS = { region: REGION, enforceAppCheck: true };
const db = () => admin.firestore();
const auth = () => admin.auth();
const FieldValue = admin.firestore.FieldValue;
exports._h = {};

function requireAuth(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  return req.auth.uid;
}
async function getRole(uid) {
  const tok = await auth().getUser(uid);
  return (tok.customClaims || {}).role || 0;
}
function san(s, max = 200) { return s == null ? '' : String(s).trim().slice(0, max); }

const PROPERTY_TYPES = ['apartment', 'house', 'townhouse', 'villa', 'land', 'commercial', 'office', 'warehouse', 'bedsitter', 'studio', 'other'];
const LISTING_TYPES = ['for_sale', 'for_rent', 'short_let'];

/* â”€â”€ 1. createPropertyListing â”€â”€ */
exports.createPropertyListing = onCall(CF_OPTS, exports._h.createPropertyListing = async (req) => {
  const uid = requireAuth(req);
  const role = await getRole(uid);
  if (role < 2) throw new HttpsError('permission-denied', 'Seller role required to list property');

  const {
    title, description, propertyType, listingType,
    price, currency, bedrooms, bathrooms, sizeM2,
    address, city, county, neighborhood,
    images, amenities, isNegotiable, furnished,
    yearBuilt, floors, parkingSpaces,
  } = req.data;

  if (!title || !propertyType || !listingType || price == null) {
    throw new HttpsError('invalid-argument', 'title, propertyType, listingType, price required');
  }
  if (!PROPERTY_TYPES.includes(propertyType)) throw new HttpsError('invalid-argument', 'Invalid propertyType');
  if (!LISTING_TYPES.includes(listingType)) throw new HttpsError('invalid-argument', 'Invalid listingType');

  const ref = db().collection('propertyListings').doc();
  await ref.set({
    listingId: ref.id, agentUid: uid,
    title: san(title, 150), description: san(description, 5000),
    propertyType, listingType,
    price: parseFloat(price), currency: currency === 'USD' ? 'USD' : 'KES',
    bedrooms: parseInt(bedrooms) || 0, bathrooms: parseInt(bathrooms) || 0,
    sizeM2: parseFloat(sizeM2) || null,
    address: san(address, 300), city: san(city, 80),
    county: san(county, 80), neighborhood: san(neighborhood, 80),
    images: Array.isArray(images) ? images.slice(0, 20).map(i => san(i, 500)) : [],
    amenities: Array.isArray(amenities) ? amenities.slice(0, 20).map(a => san(a, 60)) : [],
    isNegotiable: Boolean(isNegotiable),
    furnished: Boolean(furnished),
    yearBuilt: parseInt(yearBuilt) || null,
    floors: parseInt(floors) || null,
    parkingSpaces: parseInt(parkingSpaces) || 0,
    status: 'draft',
    viewCount: 0, enquiryCount: 0, viewingCount: 0,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  return { listingId: ref.id, status: 'draft' };
});

/* â”€â”€ 2. updatePropertyListing â”€â”€ */
exports.updatePropertyListing = onCall(CF_OPTS, exports._h.updatePropertyListing = async (req) => {
  const uid = requireAuth(req);
  const { listingId, ...fields } = req.data;
  if (!listingId) throw new HttpsError('invalid-argument', 'listingId required');

  const ref = db().collection('propertyListings').doc(listingId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Listing not found');
  const listing = snap.data();
  const role = await getRole(uid);
  if (listing.agentUid !== uid && role < 4) throw new HttpsError('permission-denied', 'Not authorized');

  const allowed = ['title','description','price','bedrooms','bathrooms','sizeM2','address','city',
    'county','neighborhood','images','amenities','isNegotiable','furnished','yearBuilt','parkingSpaces'];
  const updates = { updatedAt: FieldValue.serverTimestamp() };
  for (const k of allowed) {
    if (fields[k] !== undefined) updates[k] = fields[k];
  }
  await ref.update(updates);
  return { ok: true };
});

/* â”€â”€ 3. publishPropertyListing â”€â”€ */
exports.publishPropertyListing = onCall(CF_OPTS, exports._h.publishPropertyListing = async (req) => {
  const uid = requireAuth(req);
  const { listingId } = req.data;
  if (!listingId) throw new HttpsError('invalid-argument', 'listingId required');

  const ref = db().collection('propertyListings').doc(listingId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Listing not found');
  const listing = snap.data();
  const role = await getRole(uid);
  if (listing.agentUid !== uid && role < 4) throw new HttpsError('permission-denied', 'Not authorized');

  await ref.update({ status: 'active', publishedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  return { ok: true, status: 'active' };
});

/* â”€â”€ 4. deactivatePropertyListing â”€â”€ */
exports.deactivatePropertyListing = onCall(CF_OPTS, exports._h.deactivatePropertyListing = async (req) => {
  const uid = requireAuth(req);
  const { listingId, reason } = req.data;
  if (!listingId) throw new HttpsError('invalid-argument', 'listingId required');

  const ref = db().collection('propertyListings').doc(listingId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Listing not found');
  const listing = snap.data();
  const role = await getRole(uid);
  if (listing.agentUid !== uid && role < 4) throw new HttpsError('permission-denied', 'Not authorized');

  await ref.update({
    status: 'inactive', deactivatedReason: san(reason, 300),
    deactivatedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

/* â”€â”€ 5. getProperty â”€â”€ */
exports.getProperty = onCall(CF_OPTS, exports._h.getProperty = async (req) => {
  const { listingId } = req.data;
  if (!listingId) throw new HttpsError('invalid-argument', 'listingId required');
  const snap = await db().collection('propertyListings').doc(listingId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Listing not found');
  const listing = snap.data();
  if (listing.status !== 'active') {
    const uid = req.auth?.uid;
    const role = uid ? await getRole(uid) : 0;
    if (!uid || (listing.agentUid !== uid && role < 4)) throw new HttpsError('not-found', 'Listing not found');
  }
  db().collection('propertyListings').doc(listingId).update({ viewCount: FieldValue.increment(1) }).catch(() => {});
  return listing;
});

/* â”€â”€ 6. listProperties â”€â”€ */
exports.listProperties = onCall(CF_OPTS, exports._h.listProperties = async (req) => {
  const { propertyType, listingType, city, county, minPrice, maxPrice,
          minBedrooms, limit = 24, cursor } = req.data;

  let q = db().collection('propertyListings')
    .where('status', '==', 'active')
    .orderBy('createdAt', 'desc')
    .limit(Math.min(50, parseInt(limit) || 24));

  if (propertyType && PROPERTY_TYPES.includes(propertyType)) {
    q = db().collection('propertyListings')
      .where('status', '==', 'active')
      .where('propertyType', '==', propertyType)
      .orderBy('createdAt', 'desc')
      .limit(Math.min(50, parseInt(limit) || 24));
  } else if (listingType && LISTING_TYPES.includes(listingType)) {
    q = db().collection('propertyListings')
      .where('status', '==', 'active')
      .where('listingType', '==', listingType)
      .orderBy('createdAt', 'desc')
      .limit(Math.min(50, parseInt(limit) || 24));
  }

  if (cursor) {
    const c = await db().collection('propertyListings').doc(cursor).get();
    if (c.exists) q = q.startAfter(c);
  }

  const snap = await q.get();
  let listings = snap.docs.map(d => {
    const l = d.data();
    return {
      listingId: l.listingId, title: l.title, propertyType: l.propertyType,
      listingType: l.listingType, price: l.price, currency: l.currency,
      bedrooms: l.bedrooms, bathrooms: l.bathrooms, sizeM2: l.sizeM2,
      city: l.city, county: l.county, neighborhood: l.neighborhood,
      images: (l.images || []).slice(0, 1),
      isNegotiable: l.isNegotiable, furnished: l.furnished,
      viewCount: l.viewCount,
    };
  });

  if (city) listings = listings.filter(l => (l.city || '').toLowerCase().includes(city.toLowerCase()));
  if (county) listings = listings.filter(l => (l.county || '').toLowerCase().includes(county.toLowerCase()));
  if (minPrice) listings = listings.filter(l => l.price >= parseFloat(minPrice));
  if (maxPrice) listings = listings.filter(l => l.price <= parseFloat(maxPrice));
  if (minBedrooms) listings = listings.filter(l => l.bedrooms >= parseInt(minBedrooms));

  const nextCursor = snap.docs.length === Math.min(50, parseInt(limit) || 24)
    ? snap.docs[snap.docs.length - 1].id : null;
  return { listings, nextCursor };
});

/* â”€â”€ 7. searchProperties â”€â”€ */
exports.searchProperties = onCall(CF_OPTS, exports._h.searchProperties = async (req) => {
  const { query, limit = 20 } = req.data;
  if (!query) throw new HttpsError('invalid-argument', 'query required');
  const q = query.toLowerCase();
  const snap = await db().collection('propertyListings')
    .where('status', '==', 'active').orderBy('createdAt', 'desc').limit(200).get();
  const results = snap.docs.map(d => d.data())
    .filter(l =>
      l.title.toLowerCase().includes(q) ||
      (l.description || '').toLowerCase().includes(q) ||
      (l.city || '').toLowerCase().includes(q) ||
      (l.neighborhood || '').toLowerCase().includes(q) ||
      l.propertyType.includes(q)
    )
    .slice(0, Math.min(40, parseInt(limit) || 20))
    .map(l => ({ listingId: l.listingId, title: l.title, propertyType: l.propertyType,
      listingType: l.listingType, price: l.price, currency: l.currency,
      city: l.city, bedrooms: l.bedrooms, images: (l.images || []).slice(0, 1) }));
  return { results };
});

/* â”€â”€ 8. submitPropertyEnquiry â”€â”€ */
exports.submitPropertyEnquiry = onCall(CF_OPTS, exports._h.submitPropertyEnquiry = async (req) => {
  const uid = requireAuth(req);
  const { listingId, message, phone, moveInDate, budget } = req.data;
  if (!listingId || !message) throw new HttpsError('invalid-argument', 'listingId and message required');

  const snap = await db().collection('propertyListings').doc(listingId).get();
  if (!snap.exists || snap.data().status !== 'active') throw new HttpsError('not-found', 'Listing not found');

  const ref = db().collection('propertyEnquiries').doc();
  const batch = db().batch();
  batch.set(ref, {
    enquiryId: ref.id, listingId, buyerUid: uid,
    agentUid: snap.data().agentUid,
    message: san(message, 1000), phone: san(phone, 20),
    moveInDate: moveInDate || null, budget: parseFloat(budget) || null,
    status: 'new',
    createdAt: FieldValue.serverTimestamp(),
  });
  batch.update(db().collection('propertyListings').doc(listingId), {
    enquiryCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();
  return { enquiryId: ref.id };
});

/* â”€â”€ 9. getPropertyEnquiries (agent) â”€â”€ */
exports.getPropertyEnquiries = onCall(CF_OPTS, exports._h.getPropertyEnquiries = async (req) => {
  const uid = requireAuth(req);
  const { listingId } = req.data;
  if (!listingId) throw new HttpsError('invalid-argument', 'listingId required');

  const listingSnap = await db().collection('propertyListings').doc(listingId).get();
  if (!listingSnap.exists) throw new HttpsError('not-found', 'Listing not found');
  const role = await getRole(uid);
  if (listingSnap.data().agentUid !== uid && role < 4) throw new HttpsError('permission-denied', 'Not authorized');

  const snap = await db().collection('propertyEnquiries')
    .where('listingId', '==', listingId)
    .orderBy('createdAt', 'desc').limit(100).get();
  return { enquiries: snap.docs.map(d => d.data()) };
});

/* â”€â”€ 10. scheduleViewing â”€â”€ */
exports.scheduleViewing = onCall(CF_OPTS, exports._h.scheduleViewing = async (req) => {
  const uid = requireAuth(req);
  const { listingId, preferredDate, preferredTime, notes } = req.data;
  if (!listingId || !preferredDate) throw new HttpsError('invalid-argument', 'listingId and preferredDate required');

  const snap = await db().collection('propertyListings').doc(listingId).get();
  if (!snap.exists || snap.data().status !== 'active') throw new HttpsError('not-found', 'Listing not found');

  const ref = db().collection('propertyViewings').doc();
  const batch = db().batch();
  batch.set(ref, {
    viewingId: ref.id, listingId, buyerUid: uid,
    agentUid: snap.data().agentUid,
    propertyTitle: snap.data().title,
    preferredDate, preferredTime: san(preferredTime, 20),
    notes: san(notes, 500), status: 'requested',
    createdAt: FieldValue.serverTimestamp(),
  });
  batch.update(db().collection('propertyListings').doc(listingId), {
    viewingCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();
  return { viewingId: ref.id };
});

/* â”€â”€ 11. getViewings (agent or buyer) â”€â”€ */
exports.getViewings = onCall(CF_OPTS, exports._h.getViewings = async (req) => {
  const uid = requireAuth(req);
  const { asAgent } = req.data;
  const field = asAgent ? 'agentUid' : 'buyerUid';
  const snap = await db().collection('propertyViewings')
    .where(field, '==', uid)
    .orderBy('createdAt', 'desc').limit(50).get();
  return { viewings: snap.docs.map(d => d.data()) };
});

/* â”€â”€ 12. getPropertyAnalytics (agent) â”€â”€ */
exports.getPropertyAnalytics = onCall(CF_OPTS, exports._h.getPropertyAnalytics = async (req) => {
  const uid = requireAuth(req);
  const snap = await db().collection('propertyListings')
    .where('agentUid', '==', uid).orderBy('createdAt', 'desc').limit(100).get();
  const listings = snap.docs.map(d => d.data());
  const active = listings.filter(l => l.status === 'active');
  const totalViews = listings.reduce((s, l) => s + (l.viewCount || 0), 0);
  const totalEnquiries = listings.reduce((s, l) => s + (l.enquiryCount || 0), 0);
  const totalViewings = listings.reduce((s, l) => s + (l.viewingCount || 0), 0);
  return {
    totalListings: listings.length, activeListings: active.length,
    totalViews, totalEnquiries, totalViewings,
    conversionRate: totalViews > 0 ? Math.round((totalEnquiries / totalViews) * 100) : 0,
    listings: listings.map(l => ({
      listingId: l.listingId, title: l.title, status: l.status,
      price: l.price, viewCount: l.viewCount, enquiryCount: l.enquiryCount,
    })),
  };
});

module.exports = {
  createPropertyListing:    exports.createPropertyListing,
  updatePropertyListing:    exports.updatePropertyListing,
  publishPropertyListing:   exports.publishPropertyListing,
  deactivatePropertyListing:exports.deactivatePropertyListing,
  getProperty:              exports.getProperty,
  listProperties:           exports.listProperties,
  searchProperties:         exports.searchProperties,
  submitPropertyEnquiry:    exports.submitPropertyEnquiry,
  getPropertyEnquiries:     exports.getPropertyEnquiries,
  scheduleViewing:          exports.scheduleViewing,
  getViewings:              exports.getViewings,
  getPropertyAnalytics:     exports.getPropertyAnalytics,
};
