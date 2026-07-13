'use strict';
/**
 * Digital Products Hub v1.0 — SOKONI Platform
 * Digital product sales: ebooks, software, templates, courses, music, art
 * 10 Cloud Functions | enforceAppCheck: true | region: us-central1
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const crypto = require('crypto');

const REGION = 'us-central1';
const CF_OPTS = { region: REGION, enforceAppCheck: true };
const db = () => admin.firestore();
const auth = () => admin.auth();
const storage = () => admin.storage();
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

const DIGITAL_CATEGORIES = [
  'ebook', 'template', 'software', 'course', 'music', 'video', 'photography',
  'graphic_design', 'font', 'plugin', 'preset', 'spreadsheet', 'dataset', 'other',
];

/* ── 1. createDigitalProduct ── */
exports.createDigitalProduct = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const role = await getRole(uid);
  if (role < 2) throw new HttpsError('permission-denied', 'Seller role required');

  const {
    title, description, category, price, currency,
    previewImageUrl, previewFileUrl, fileStoragePath,
    fileType, fileSizeMB, version, tags, licenseType,
    allowedDownloads,
  } = req.data;

  if (!title || !category || price == null || !fileStoragePath) {
    throw new HttpsError('invalid-argument', 'title, category, price, fileStoragePath required');
  }
  if (!DIGITAL_CATEGORIES.includes(category)) throw new HttpsError('invalid-argument', 'Invalid category');

  const ref = db().collection('digitalProducts').doc();
  await ref.set({
    productId: ref.id, sellerUid: uid,
    title: san(title, 120), description: san(description, 5000),
    category, price: parseFloat(price), currency: currency === 'USD' ? 'USD' : 'KES',
    previewImageUrl: san(previewImageUrl, 500),
    previewFileUrl: san(previewFileUrl, 500),
    fileStoragePath: san(fileStoragePath, 500),
    fileType: san(fileType, 40), fileSizeMB: parseFloat(fileSizeMB) || null,
    version: san(version, 20) || '1.0',
    tags: Array.isArray(tags) ? tags.slice(0, 10).map(t => san(t, 30)) : [],
    licenseType: ['personal', 'commercial', 'extended', 'open_source'].includes(licenseType) ? licenseType : 'personal',
    allowedDownloads: parseInt(allowedDownloads) || 3,
    status: 'draft',
    totalSales: 0, totalRevenue: 0,
    rating: 0, ratingCount: 0,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  return { productId: ref.id, status: 'draft' };
});

/* ── 2. updateDigitalProduct ── */
exports.updateDigitalProduct = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { productId, ...fields } = req.data;
  if (!productId) throw new HttpsError('invalid-argument', 'productId required');

  const ref = db().collection('digitalProducts').doc(productId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Product not found');
  const role = await getRole(uid);
  if (snap.data().sellerUid !== uid && role < 4) throw new HttpsError('permission-denied', 'Not authorized');

  const allowed = ['title','description','price','previewImageUrl','previewFileUrl','tags','version','status'];
  const updates = { updatedAt: FieldValue.serverTimestamp() };
  for (const k of allowed) { if (fields[k] !== undefined) updates[k] = fields[k]; }
  await ref.update(updates);
  return { ok: true };
});

/* ── 3. publishDigitalProduct ── */
exports.publishDigitalProduct = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { productId } = req.data;
  if (!productId) throw new HttpsError('invalid-argument', 'productId required');

  const ref = db().collection('digitalProducts').doc(productId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Product not found');
  const role = await getRole(uid);
  if (snap.data().sellerUid !== uid && role < 4) throw new HttpsError('permission-denied', 'Not authorized');

  await ref.update({ status: 'active', publishedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

/* ── 4. getDigitalProduct ── */
exports.getDigitalProduct = onCall(CF_OPTS, async (req) => {
  const { productId } = req.data;
  if (!productId) throw new HttpsError('invalid-argument', 'productId required');
  const snap = await db().collection('digitalProducts').doc(productId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Product not found');
  const p = snap.data();
  if (p.status !== 'active') {
    const uid = req.auth?.uid;
    const role = uid ? await getRole(uid) : 0;
    if (!uid || (p.sellerUid !== uid && role < 4)) throw new HttpsError('not-found', 'Product not found');
  }
  const safe = { ...p };
  delete safe.fileStoragePath; // never expose storage path publicly
  return safe;
});

/* ── 5. listDigitalProducts ── */
exports.listDigitalProducts = onCall(CF_OPTS, async (req) => {
  const { category, minPrice, maxPrice, limit = 24, cursor } = req.data;

  let q = db().collection('digitalProducts')
    .where('status', '==', 'active')
    .orderBy('totalSales', 'desc')
    .limit(Math.min(50, parseInt(limit) || 24));

  if (category && DIGITAL_CATEGORIES.includes(category)) {
    q = db().collection('digitalProducts')
      .where('status', '==', 'active')
      .where('category', '==', category)
      .orderBy('totalSales', 'desc')
      .limit(Math.min(50, parseInt(limit) || 24));
  }

  if (cursor) {
    const c = await db().collection('digitalProducts').doc(cursor).get();
    if (c.exists) q = q.startAfter(c);
  }

  const snap = await q.get();
  let products = snap.docs.map(d => {
    const p = d.data();
    return { productId: p.productId, title: p.title, category: p.category,
      price: p.price, currency: p.currency, previewImageUrl: p.previewImageUrl,
      fileType: p.fileType, fileSizeMB: p.fileSizeMB, licenseType: p.licenseType,
      rating: p.rating, ratingCount: p.ratingCount, totalSales: p.totalSales,
      tags: p.tags, version: p.version };
  });

  if (minPrice) products = products.filter(p => p.price >= parseFloat(minPrice));
  if (maxPrice) products = products.filter(p => p.price <= parseFloat(maxPrice));

  const nextCursor = snap.docs.length === Math.min(50, parseInt(limit) || 24)
    ? snap.docs[snap.docs.length - 1].id : null;
  return { products, nextCursor };
});

/* ── 6. purchaseDigitalProduct ── */
exports.purchaseDigitalProduct = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { productId, idempotencyKey } = req.data;
  if (!productId || !idempotencyKey) throw new HttpsError('invalid-argument', 'productId and idempotencyKey required');

  const idemRef = db().collection('digitalPurchaseIdempotency').doc(idempotencyKey);
  const idemSnap = await idemRef.get();
  if (idemSnap.exists) return { purchaseId: idemSnap.data().purchaseId, idempotent: true };

  const productSnap = await db().collection('digitalProducts').doc(productId).get();
  if (!productSnap.exists || productSnap.data().status !== 'active') {
    throw new HttpsError('not-found', 'Product not available');
  }
  const product = productSnap.data();

  // Check not already purchased
  const existing = await db().collection('digitalPurchases')
    .where('buyerUid', '==', uid).where('productId', '==', productId).limit(1).get();
  if (!existing.empty) return { purchaseId: existing.docs[0].id, alreadyOwned: true };

  /* Rate from the single config (digital_products). Was a bare 0.10 literal here. */
  const platformFeeRate = require('./commission-config').resolveRate('digital_products').pct / 100;
  const platformFee = product.price === 0 ? 0 : Math.round(product.price * platformFeeRate * 100) / 100;
  const sellerAmount = product.price - platformFee;
  const licenseKey = product.price === 0 ? null : crypto.randomBytes(12).toString('hex').toUpperCase();

  const purchaseRef = db().collection('digitalPurchases').doc();
  await db().runTransaction(async t => {
    t.set(purchaseRef, {
      purchaseId: purchaseRef.id, buyerUid: uid, productId,
      sellerUid: product.sellerUid,
      title: product.title, category: product.category,
      price: product.price, currency: product.currency,
      platformFee, sellerAmount,
      licenseKey, licenseType: product.licenseType,
      allowedDownloads: product.allowedDownloads,
      downloadsUsed: 0,
      status: product.price === 0 ? 'completed' : 'pending_payment',
      idempotencyKey,
      createdAt: FieldValue.serverTimestamp(),
    });
    t.update(db().collection('digitalProducts').doc(productId), {
      totalSales: FieldValue.increment(1),
      totalRevenue: FieldValue.increment(product.price),
      updatedAt: FieldValue.serverTimestamp(),
    });
    t.set(idemRef, { purchaseId: purchaseRef.id, createdAt: FieldValue.serverTimestamp() });
  });

  return {
    purchaseId: purchaseRef.id, licenseKey,
    status: product.price === 0 ? 'completed' : 'pending_payment',
    price: product.price,
  };
});

/* ── 7. getMyDigitalPurchases ── */
exports.getMyDigitalPurchases = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const snap = await db().collection('digitalPurchases')
    .where('buyerUid', '==', uid)
    .orderBy('createdAt', 'desc').limit(50).get();
  return { purchases: snap.docs.map(d => { const p = d.data(); delete p.fileStoragePath; return p; }) };
});

/* ── 8. downloadDigitalProduct ── */
exports.downloadDigitalProduct = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { purchaseId } = req.data;
  if (!purchaseId) throw new HttpsError('invalid-argument', 'purchaseId required');

  const purchaseSnap = await db().collection('digitalPurchases').doc(purchaseId).get();
  if (!purchaseSnap.exists) throw new HttpsError('not-found', 'Purchase not found');
  const purchase = purchaseSnap.data();
  if (purchase.buyerUid !== uid) throw new HttpsError('permission-denied', 'Not your purchase');
  if (purchase.status !== 'completed') throw new HttpsError('failed-precondition', 'Payment not completed');
  if (purchase.downloadsUsed >= purchase.allowedDownloads) {
    throw new HttpsError('resource-exhausted', `Download limit reached (${purchase.allowedDownloads} downloads)`);
  }

  const productSnap = await db().collection('digitalProducts').doc(purchase.productId).get();
  if (!productSnap.exists) throw new HttpsError('not-found', 'Product file not found');
  const product = productSnap.data();

  // Generate signed URL (15-minute expiry)
  const file = storage().bucket().file(product.fileStoragePath);
  const [url] = await file.getSignedUrl({
    action: 'read',
    expires: Date.now() + 15 * 60 * 1000,
  });

  await db().collection('digitalPurchases').doc(purchaseId).update({
    downloadsUsed: FieldValue.increment(1),
    lastDownloadAt: FieldValue.serverTimestamp(),
  });

  return { downloadUrl: url, expiresInSeconds: 900, downloadsRemaining: purchase.allowedDownloads - purchase.downloadsUsed - 1 };
});

/* ── 9. rateDigitalProduct ── */
exports.rateDigitalProduct = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { productId, purchaseId, rating, review } = req.data;
  if (!productId || !purchaseId || !rating) throw new HttpsError('invalid-argument', 'productId, purchaseId, rating required');
  if (rating < 1 || rating > 5) throw new HttpsError('invalid-argument', 'Rating 1–5');

  const purchaseSnap = await db().collection('digitalPurchases').doc(purchaseId).get();
  if (!purchaseSnap.exists || purchaseSnap.data().buyerUid !== uid) throw new HttpsError('permission-denied', 'Not your purchase');
  if (purchaseSnap.data().rated) throw new HttpsError('already-exists', 'Already rated');

  await db().runTransaction(async t => {
    const productRef = db().collection('digitalProducts').doc(productId);
    const pSnap = await t.get(productRef);
    if (!pSnap.exists) throw new HttpsError('not-found', 'Product not found');
    const p = pSnap.data();
    const newCount = p.ratingCount + 1;
    const newRating = ((p.rating * p.ratingCount) + rating) / newCount;
    t.update(productRef, { rating: Math.round(newRating * 10) / 10, ratingCount: newCount, updatedAt: FieldValue.serverTimestamp() });
    t.update(db().collection('digitalPurchases').doc(purchaseId), { rated: true, rating, review: san(review, 500) });
  });
  return { ok: true };
});

/* ── 10. getDigitalSellerDashboard ── */
exports.getDigitalSellerDashboard = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const snap = await db().collection('digitalProducts')
    .where('sellerUid', '==', uid).orderBy('createdAt', 'desc').limit(100).get();
  const products = snap.docs.map(d => d.data());
  const active = products.filter(p => p.status === 'active');
  const totalRevenue = products.reduce((s, p) => s + (p.totalRevenue || 0), 0);
  const totalSales = products.reduce((s, p) => s + (p.totalSales || 0), 0);
  return {
    totalProducts: products.length, activeProducts: active.length,
    totalRevenue, totalSales,
    platformFeeTotal: Math.round(totalRevenue * (require('./commission-config').resolveRate('digital_products').pct / 100) * 100) / 100,
    sellerRevenue: Math.round(totalRevenue * 0.90 * 100) / 100,
    products: products.map(p => ({
      productId: p.productId, title: p.title, category: p.category,
      status: p.status, price: p.price, totalSales: p.totalSales,
      totalRevenue: p.totalRevenue, rating: p.rating,
    })),
  };
});

module.exports = {
  createDigitalProduct:    exports.createDigitalProduct,
  updateDigitalProduct:    exports.updateDigitalProduct,
  publishDigitalProduct:   exports.publishDigitalProduct,
  getDigitalProduct:       exports.getDigitalProduct,
  listDigitalProducts:     exports.listDigitalProducts,
  purchaseDigitalProduct:  exports.purchaseDigitalProduct,
  getMyDigitalPurchases:   exports.getMyDigitalPurchases,
  downloadDigitalProduct:  exports.downloadDigitalProduct,
  rateDigitalProduct:      exports.rateDigitalProduct,
  getDigitalSellerDashboard: exports.getDigitalSellerDashboard,
};
