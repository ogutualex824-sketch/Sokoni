'use strict';
/**
 * SOKONI — Marketplace Extensions Engine (Sprint 4.2)
 * Auctions • Rentals • Digital Products • Q&A • Wishlist • Price History • SEO
 * 31 Cloud Functions — enforceAppCheck: true on all onCall CFs
 */
const { onCall, onRequest } = require('firebase-functions/v2/https');
const { onSchedule }        = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

function _db()  { return admin.firestore(); }
function _ts()  { return admin.firestore.FieldValue.serverTimestamp(); }
function _fv()  { return admin.firestore.FieldValue; }
function _id()  { return _db().collection('_').doc().id; }

async function _assertAuth(auth) {
  if (!auth || !auth.uid) throw new Error('unauthenticated');
  return auth;
}

async function _assertAdmin(auth) {
  await _assertAuth(auth);
  const role = (auth.token && auth.token.role) || '';
  if (!['admin', 'super_admin'].includes(role)) throw new Error('forbidden');
}

async function _assertSeller(auth, shopId) {
  await _assertAuth(auth);
  if (!shopId) throw new Error('shopId-required');
  const snap = await _db().collection('shops').doc(shopId).get();
  if (!snap.exists) throw new Error('shop-not-found');
  const shop = snap.data();
  const role = (auth.token && auth.token.role) || '';
  if (['admin', 'super_admin'].includes(role)) return shop;
  if (shop.ownerId === auth.uid) return shop;
  const emp = await _db().collection('shopEmployees')
    .where('shopId', '==', shopId).where('uid', '==', auth.uid).limit(1).get();
  if (emp.empty) throw new Error('forbidden');
  return shop;
}

// Minimum bid increment by current bid value
function _minIncrement(currentBid) {
  if (currentBid < 1000)  return 50;
  if (currentBid < 5000)  return 100;
  if (currentBid < 20000) return 500;
  return 1000;
}

// ─── AUCTIONS ────────────────────────────────────────────────────────────────
// Collections: auctions/{id}, auctionBids/{id}

exports.auctionCreate = onCall({ enforceAppCheck: true }, async (req) => {
  const {
    shopId, title, description, images,
    startingPrice, reservePrice,
    startTime, endTime, category,
  } = req.data;
  await _assertSeller(req.auth, shopId);
  if (!title || !startingPrice || !endTime) throw new Error('missing-required-fields');
  if (startingPrice <= 0) throw new Error('invalid-starting-price');

  const start = startTime ? new Date(startTime) : new Date();
  const end   = new Date(endTime);
  if (end <= start) throw new Error('end-must-be-after-start');
  if (end <= new Date()) throw new Error('end-must-be-in-future');

  const id = _id();
  await _db().collection('auctions').doc(id).set({
    shopId,
    title,
    description: description || '',
    images: images || [],
    category: category || 'general',
    startingPrice,
    reservePrice: reservePrice || null,
    reserveMet: !reservePrice,        // true if no reserve
    currentBid: startingPrice,
    currentBidderId: null,
    currentBidderName: null,
    bidCount: 0,
    startTime: admin.firestore.Timestamp.fromDate(start),
    endTime:   admin.firestore.Timestamp.fromDate(end),
    status: start <= new Date() ? 'active' : 'scheduled',
    winnerId: null,
    winnerBid: null,
    winnerName: null,
    createdBy: req.auth.uid,
    createdAt: _ts(),
  });
  return { auctionId: id };
});

exports.auctionBid = onCall({ enforceAppCheck: true }, async (req) => {
  const { auctionId, amount } = req.data;
  await _assertAuth(req.auth);
  if (!auctionId || !amount || amount <= 0) throw new Error('invalid-input');

  const auctionRef = _db().collection('auctions').doc(auctionId);
  const bidId = _id();

  const result = await _db().runTransaction(async (tx) => {
    const snap = await tx.get(auctionRef);
    if (!snap.exists) throw new Error('auction-not-found');
    const auction = snap.data();
    if (auction.status !== 'active') throw new Error(`auction-${auction.status}`);

    const now = new Date();
    const endTime = auction.endTime.toDate();
    if (now > endTime) throw new Error('auction-ended');
    if (auction.shopId === req.auth.uid) throw new Error('seller-cannot-bid');
    if (auction.currentBidderId === req.auth.uid) throw new Error('already-highest-bidder');

    const minBid = auction.currentBid + _minIncrement(auction.currentBid);
    if (amount < minBid) throw new Error(`minimum-bid-is-${minBid}`);

    // Auto-extend: if bid within last 2 minutes, extend by 2 minutes
    const twoMinBefore = new Date(endTime.getTime() - 2 * 60 * 1000);
    let newEndTime = endTime;
    if (now >= twoMinBefore) {
      newEndTime = new Date(now.getTime() + 2 * 60 * 1000);
    }

    const reserveMet = !auction.reservePrice || amount >= auction.reservePrice;
    const previousBidderId = auction.currentBidderId;

    const updates = {
      currentBid: amount,
      currentBidderId: req.auth.uid,
      currentBidderName: req.auth.token.name || 'Bidder',
      bidCount: _fv().increment(1),
      reserveMet,
      endTime: admin.firestore.Timestamp.fromDate(newEndTime),
      updatedAt: _ts(),
    };

    tx.update(auctionRef, updates);

    const bidRef = _db().collection('auctionBids').doc(bidId);
    tx.set(bidRef, {
      auctionId,
      bidderId: req.auth.uid,
      bidderName: req.auth.token.name || 'Bidder',
      amount,
      bidAt: _ts(),
      isWinning: true,
    });

    return { previousBidderId, extended: now >= twoMinBefore, newEndTime };
  });

  // Notify outbid user (non-fatal)
  if (result.previousBidderId) {
    _db().collection('notifications').add({
      uid: result.previousBidderId,
      type: 'auction_outbid',
      title: 'You\'ve been outbid!',
      body: 'Someone placed a higher bid. Bid again to stay in the lead.',
      data: { auctionId },
      read: false,
      createdAt: _ts(),
    }).catch(() => {});
  }

  return {
    success: true,
    currentBid: amount,
    extended: result.extended,
  };
});

exports.auctionGet = onCall({ enforceAppCheck: true }, async (req) => {
  const { auctionId } = req.data;
  await _assertAuth(req.auth);
  const snap = await _db().collection('auctions').doc(auctionId).get();
  if (!snap.exists) throw new Error('not-found');
  const auction = { id: snap.id, ...snap.data() };
  // Hide exact reserve price — only reveal if met
  if (auction.reservePrice && !auction.reserveMet) {
    auction.reservePrice = null;
    auction.hasReserve = true;
  }
  return { auction };
});

exports.auctionList = onCall({ enforceAppCheck: true }, async (req) => {
  const { status, category, shopId, limit: lim } = req.data;
  await _assertAuth(req.auth);
  const maxResults = Math.min(lim || 40, 100);

  let query = _db().collection('auctions');
  if (shopId) {
    query = query.where('shopId', '==', shopId).limit(maxResults);
  } else if (status) {
    query = query.where('status', '==', status).limit(maxResults);
  } else if (category) {
    query = query.where('category', '==', category).limit(maxResults);
  } else {
    query = query.where('status', '==', 'active').limit(maxResults);
  }

  const snap = await query.get();
  let auctions = snap.docs.map(d => {
    const a = { id: d.id, ...d.data() };
    if (a.reservePrice && !a.reserveMet) {
      a.reservePrice = null; a.hasReserve = true;
    }
    return a;
  });

  // In-memory filter by category when querying by status
  if (status && category) auctions = auctions.filter(a => a.category === category);

  auctions.sort((a, b) => {
    const aT = a.endTime && a.endTime.toMillis ? a.endTime.toMillis() : 0;
    const bT = b.endTime && b.endTime.toMillis ? b.endTime.toMillis() : 0;
    return aT - bT;
  });

  return { auctions };
});

exports.auctionGetBids = onCall({ enforceAppCheck: true }, async (req) => {
  const { auctionId } = req.data;
  await _assertAuth(req.auth);
  const snap = await _db().collection('auctionBids')
    .where('auctionId', '==', auctionId).limit(50).get();
  const bids = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  bids.sort((a, b) => {
    const aT = a.bidAt && a.bidAt.toMillis ? a.bidAt.toMillis() : 0;
    const bT = b.bidAt && b.bidAt.toMillis ? b.bidAt.toMillis() : 0;
    return bT - aT;
  });
  return { bids };
});

exports.auctionWatch = onCall({ enforceAppCheck: true }, async (req) => {
  const { auctionId, watching } = req.data;
  await _assertAuth(req.auth);
  const ref = _db().collection('auctionWatchers').doc(`${auctionId}_${req.auth.uid}`);
  if (watching) {
    await ref.set({ auctionId, uid: req.auth.uid, addedAt: _ts() });
  } else {
    await ref.delete();
  }
  return { success: true };
});

exports.auctionGetMyBids = onCall({ enforceAppCheck: true }, async (req) => {
  await _assertAuth(req.auth);
  const snap = await _db().collection('auctionBids')
    .where('bidderId', '==', req.auth.uid).limit(50).get();
  const bids = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  bids.sort((a, b) => {
    const aT = a.bidAt && a.bidAt.toMillis ? a.bidAt.toMillis() : 0;
    const bT = b.bidAt && b.bidAt.toMillis ? b.bidAt.toMillis() : 0;
    return bT - aT;
  });
  return { bids };
});

// Scheduled: close expired auctions every 5 minutes
exports.auctionCloseSweep = onSchedule('every 5 minutes', async () => {
  const now = admin.firestore.Timestamp.now();
  const snap = await _db().collection('auctions')
    .where('status', '==', 'active').limit(100).get();

  const toClose = snap.docs.filter(d => {
    const et = d.data().endTime;
    return et && et.toMillis() <= now.toMillis();
  });

  await Promise.all(toClose.map(async (doc) => {
    const auction = doc.data();
    const winnerId = auction.currentBidderId;
    const winnerBid = auction.currentBid;
    const reserveMet = auction.reserveMet;

    const status = winnerId && reserveMet ? 'ended_sold' : 'ended_unsold';

    await doc.ref.update({
      status,
      winnerId: reserveMet ? winnerId : null,
      winnerBid: reserveMet ? winnerBid : null,
      winnerName: reserveMet ? auction.currentBidderName : null,
      closedAt: _ts(),
    });

    // Notify winner
    if (winnerId && reserveMet) {
      _db().collection('notifications').add({
        uid: winnerId,
        type: 'auction_won',
        title: 'You won the auction!',
        body: `Congratulations! You won "${auction.title}" for KES ${winnerBid.toLocaleString()}.`,
        data: { auctionId: doc.id },
        read: false,
        createdAt: _ts(),
      }).catch(() => {});
    }
  }));
});

// ─── RENTALS ─────────────────────────────────────────────────────────────────
// Collections: rentalProducts/{id}, rentalBookings/{id}

exports.rentalProductCreate = onCall({ enforceAppCheck: true }, async (req) => {
  const {
    shopId, title, description, images, category,
    pricingType, hourlyRate, dailyRate, weeklyRate, monthlyRate,
    deposit, minDuration, maxDuration, terms,
  } = req.data;
  await _assertSeller(req.auth, shopId);
  if (!title || !pricingType) throw new Error('missing-required-fields');
  if (!['hourly', 'daily', 'weekly', 'monthly', 'flexible'].includes(pricingType)) {
    throw new Error('invalid-pricing-type');
  }

  const id = _id();
  await _db().collection('rentalProducts').doc(id).set({
    shopId,
    title,
    description: description || '',
    images: images || [],
    category: category || 'general',
    pricingType,
    hourlyRate:  hourlyRate  || null,
    dailyRate:   dailyRate   || null,
    weeklyRate:  weeklyRate  || null,
    monthlyRate: monthlyRate || null,
    deposit:     deposit     || 0,
    minDuration: minDuration || 1,
    maxDuration: maxDuration || null,
    terms:       terms       || '',
    status: 'active',
    bookingCount: 0,
    createdBy: req.auth.uid,
    createdAt: _ts(),
  });
  return { rentalProductId: id };
});

exports.rentalGetAvailability = onCall({ enforceAppCheck: true }, async (req) => {
  const { rentalProductId, fromDate, toDate } = req.data;
  await _assertAuth(req.auth);
  const snap = await _db().collection('rentalBookings')
    .where('rentalProductId', '==', rentalProductId).limit(200).get();

  const bookings = snap.docs
    .map(d => d.data())
    .filter(b => ['pending', 'confirmed', 'active'].includes(b.status))
    .map(b => ({
      start: b.startDate.toDate ? b.startDate.toDate().toISOString() : b.startDate,
      end:   b.endDate.toDate   ? b.endDate.toDate().toISOString()   : b.endDate,
    }));

  return { unavailablePeriods: bookings };
});

exports.rentalBook = onCall({ enforceAppCheck: true }, async (req) => {
  const {
    rentalProductId, startDate, endDate, durationUnit,
    customerName, customerPhone, paymentMethod, notes,
  } = req.data;
  await _assertAuth(req.auth);
  if (!rentalProductId || !startDate || !endDate) throw new Error('missing-required-fields');

  const productSnap = await _db().collection('rentalProducts').doc(rentalProductId).get();
  if (!productSnap.exists) throw new Error('product-not-found');
  const product = productSnap.data();
  if (product.status !== 'active') throw new Error('product-not-available');

  const start = new Date(startDate);
  const end   = new Date(endDate);
  if (end <= start) throw new Error('end-must-be-after-start');

  // Check availability (simple overlap detection, in-memory)
  const existingSnap = await _db().collection('rentalBookings')
    .where('rentalProductId', '==', rentalProductId).limit(200).get();
  const conflict = existingSnap.docs.some(d => {
    const b = d.data();
    if (!['pending', 'confirmed', 'active'].includes(b.status)) return false;
    const bs = b.startDate.toDate ? b.startDate.toDate() : new Date(b.startDate);
    const be = b.endDate.toDate   ? b.endDate.toDate()   : new Date(b.endDate);
    return start < be && end > bs;
  });
  if (conflict) throw new Error('dates-not-available');

  // Calculate price
  const hours   = (end - start) / 3600000;
  const days    = hours / 24;
  const weeks   = days / 7;
  const months  = days / 30;

  let totalAmount = 0;
  const unit = durationUnit || 'daily';
  if (unit === 'hourly'  && product.hourlyRate)  totalAmount = Math.ceil(hours)   * product.hourlyRate;
  if (unit === 'daily'   && product.dailyRate)   totalAmount = Math.ceil(days)    * product.dailyRate;
  if (unit === 'weekly'  && product.weeklyRate)  totalAmount = Math.ceil(weeks)   * product.weeklyRate;
  if (unit === 'monthly' && product.monthlyRate) totalAmount = Math.ceil(months)  * product.monthlyRate;
  if (totalAmount <= 0) throw new Error('unable-to-calculate-price');

  const depositAmount = product.deposit || 0;

  const id = _id();
  await _db().collection('rentalBookings').doc(id).set({
    rentalProductId,
    shopId: product.shopId,
    buyerId: req.auth.uid,
    customerName: customerName || req.auth.token.name || 'Customer',
    customerPhone: customerPhone || '',
    startDate: admin.firestore.Timestamp.fromDate(start),
    endDate:   admin.firestore.Timestamp.fromDate(end),
    durationUnit: unit,
    totalAmount,
    depositAmount,
    paymentMethod: paymentMethod || 'mpesa',
    notes: notes || '',
    status: 'pending',       // pending | confirmed | active | completed | cancelled
    createdAt: _ts(),
  });

  return { bookingId: id, totalAmount, depositAmount };
});

exports.rentalConfirm = onCall({ enforceAppCheck: true }, async (req) => {
  const { bookingId, shopId } = req.data;
  await _assertSeller(req.auth, shopId);
  const ref = _db().collection('rentalBookings').doc(bookingId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('not-found');
  if (snap.data().shopId !== shopId) throw new Error('forbidden');
  if (snap.data().status !== 'pending') throw new Error('invalid-status');
  await ref.update({ status: 'confirmed', confirmedAt: _ts(), confirmedBy: req.auth.uid });
  return { success: true };
});

exports.rentalComplete = onCall({ enforceAppCheck: true }, async (req) => {
  const { bookingId, shopId, notes } = req.data;
  await _assertSeller(req.auth, shopId);
  const ref = _db().collection('rentalBookings').doc(bookingId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('not-found');
  if (snap.data().shopId !== shopId) throw new Error('forbidden');
  await ref.update({ status: 'completed', completedAt: _ts(), completionNotes: notes || '' });
  await _db().collection('rentalProducts').doc(snap.data().rentalProductId)
    .update({ bookingCount: _fv().increment(1) });
  return { success: true };
});

exports.rentalCancel = onCall({ enforceAppCheck: true }, async (req) => {
  const { bookingId, reason } = req.data;
  await _assertAuth(req.auth);
  const ref = _db().collection('rentalBookings').doc(bookingId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('not-found');
  const booking = snap.data();
  const isOwner = booking.buyerId === req.auth.uid;
  const role = (req.auth.token && req.auth.token.role) || '';
  const isSeller = booking.shopId && req.auth.token.shopId === booking.shopId;
  if (!isOwner && !isSeller && !['admin', 'super_admin'].includes(role)) {
    throw new Error('forbidden');
  }
  if (['completed', 'cancelled'].includes(booking.status)) throw new Error('already-closed');
  await ref.update({ status: 'cancelled', cancelledAt: _ts(), cancelReason: reason || '' });
  return { success: true };
});

exports.rentalList = onCall({ enforceAppCheck: true }, async (req) => {
  const { shopId, buyerId, status } = req.data;
  await _assertAuth(req.auth);
  let snap;
  if (shopId) {
    await _assertSeller(req.auth, shopId);
    snap = await _db().collection('rentalBookings').where('shopId', '==', shopId).limit(100).get();
  } else {
    snap = await _db().collection('rentalBookings')
      .where('buyerId', '==', req.auth.uid).limit(50).get();
  }
  let bookings = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (status) bookings = bookings.filter(b => b.status === status);
  bookings.sort((a, b) => {
    const aT = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
    const bT = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
    return bT - aT;
  });
  return { bookings };
});

// ─── DIGITAL PRODUCTS ─────────────────────────────────────────────────────────
// Collections: digitalProducts/{id}, digitalPurchases/{id}
// Files stored in Firebase Storage: digitalProducts/{productId}/{filename}
// Signed download URLs generated per-request (15 min expiry)

exports.digitalProductCreate = onCall({ enforceAppCheck: true }, async (req) => {
  const {
    shopId, title, description, previewUrl, category,
    price, downloadLimit, licenseType, version, fileType, fileSize, storagePath,
  } = req.data;
  await _assertSeller(req.auth, shopId);
  if (!title || !price || !storagePath) throw new Error('missing-required-fields');
  if (price <= 0) throw new Error('invalid-price');

  const id = _id();
  await _db().collection('digitalProducts').doc(id).set({
    shopId,
    title,
    description: description || '',
    previewUrl:  previewUrl  || null,
    category:    category    || 'software',
    price,
    downloadLimit: downloadLimit || 3,
    licenseType:   licenseType   || 'personal',   // personal | commercial | extended
    version:       version       || '1.0',
    fileType:      fileType      || 'zip',
    fileSize:      fileSize      || null,
    storagePath,
    salesCount: 0,
    status: 'active',
    createdBy: req.auth.uid,
    createdAt: _ts(),
  });

  // Record initial price
  await _db().collection('priceHistoryLog').add({
    productId: id,
    shopId,
    oldPrice: null,
    newPrice: price,
    changedAt: _ts(),
    changedBy: req.auth.uid,
    source: 'digital_product_create',
  });

  return { productId: id };
});

exports.digitalProductPurchase = onCall({ enforceAppCheck: true }, async (req) => {
  const { productId, paymentMethod } = req.data;
  await _assertAuth(req.auth);

  const productSnap = await _db().collection('digitalProducts').doc(productId).get();
  if (!productSnap.exists) throw new Error('product-not-found');
  const product = productSnap.data();
  if (product.status !== 'active') throw new Error('product-unavailable');

  // Check not already purchased
  const existing = await _db().collection('digitalPurchases')
    .where('buyerId', '==', req.auth.uid).where('productId', '==', productId).limit(1).get();
  if (!existing.empty) throw new Error('already-purchased');

  // Generate license key
  const genKey = () => {
    const seg = () => Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${seg()}-${seg()}-${seg()}-${seg()}`;
  };

  const purchaseId = _id();
  const licenseKey = genKey();

  const batch = _db().batch();
  batch.set(_db().collection('digitalPurchases').doc(purchaseId), {
    productId,
    shopId: product.shopId,
    buyerId: req.auth.uid,
    price: product.price,
    paymentMethod: paymentMethod || 'wallet',
    licenseKey,
    downloadCount: 0,
    downloadLimit: product.downloadLimit,
    storagePath: product.storagePath,
    purchasedAt: _ts(),
  });
  batch.update(_db().collection('digitalProducts').doc(productId), {
    salesCount: _fv().increment(1),
  });
  await batch.commit();

  return { purchaseId, licenseKey, downloadLimit: product.downloadLimit };
});

exports.digitalProductDownload = onCall({ enforceAppCheck: true }, async (req) => {
  const { purchaseId } = req.data;
  await _assertAuth(req.auth);

  const purchaseRef = _db().collection('digitalPurchases').doc(purchaseId);
  return _db().runTransaction(async (tx) => {
    const snap = await tx.get(purchaseRef);
    if (!snap.exists) throw new Error('purchase-not-found');
    const purchase = snap.data();
    if (purchase.buyerId !== req.auth.uid) throw new Error('forbidden');
    if (purchase.downloadCount >= purchase.downloadLimit) throw new Error('download-limit-reached');

    tx.update(purchaseRef, { downloadCount: _fv().increment(1) });

    // Generate signed URL (15-minute expiry)
    const bucket = admin.storage().bucket();
    const file = bucket.file(purchase.storagePath);
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 15 * 60 * 1000,
    });

    return {
      downloadUrl: url,
      downloadsRemaining: purchase.downloadLimit - purchase.downloadCount - 1,
    };
  });
});

exports.digitalProductGetMyLibrary = onCall({ enforceAppCheck: true }, async (req) => {
  await _assertAuth(req.auth);
  const snap = await _db().collection('digitalPurchases')
    .where('buyerId', '==', req.auth.uid).limit(100).get();
  const purchases = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  // Enrich with product titles
  const productIds = [...new Set(purchases.map(p => p.productId))];
  const productSnaps = await Promise.all(
    productIds.map(id => _db().collection('digitalProducts').doc(id).get())
  );
  const productMap = {};
  productSnaps.forEach(s => { if (s.exists) productMap[s.id] = s.data(); });
  purchases.forEach(p => {
    const prod = productMap[p.productId] || {};
    p.productTitle = prod.title || 'Unknown';
    p.productDescription = prod.description || '';
    p.fileType = prod.fileType || '';
  });
  purchases.sort((a, b) => {
    const aT = a.purchasedAt && a.purchasedAt.toMillis ? a.purchasedAt.toMillis() : 0;
    const bT = b.purchasedAt && b.purchasedAt.toMillis ? b.purchasedAt.toMillis() : 0;
    return bT - aT;
  });
  return { purchases };
});

exports.digitalProductGetSales = onCall({ enforceAppCheck: true }, async (req) => {
  const { shopId } = req.data;
  await _assertSeller(req.auth, shopId);
  const snap = await _db().collection('digitalPurchases')
    .where('shopId', '==', shopId).limit(200).get();
  const sales = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const totalRevenue = sales.reduce((s, p) => s + (p.price || 0), 0);
  sales.sort((a, b) => {
    const aT = a.purchasedAt && a.purchasedAt.toMillis ? a.purchasedAt.toMillis() : 0;
    const bT = b.purchasedAt && b.purchasedAt.toMillis ? b.purchasedAt.toMillis() : 0;
    return bT - aT;
  });
  return { sales, totalRevenue, totalSales: sales.length };
});

// ─── PRODUCT Q&A ─────────────────────────────────────────────────────────────
// Collections: productQuestions/{id}  (answers embedded in array)

exports.productAskQuestion = onCall({ enforceAppCheck: true }, async (req) => {
  const { productId, shopId, question } = req.data;
  await _assertAuth(req.auth);
  if (!productId || !question || question.length < 5) throw new Error('invalid-question');

  const id = _id();
  await _db().collection('productQuestions').doc(id).set({
    productId,
    shopId: shopId || null,
    question: question.slice(0, 500),
    askedBy: req.auth.uid,
    askedByName: req.auth.token.name || 'Customer',
    askedAt: _ts(),
    status: 'open',          // open | answered
    answers: [],
    helpfulCount: 0,
  });

  return { questionId: id };
});

exports.productAnswerQuestion = onCall({ enforceAppCheck: true }, async (req) => {
  const { questionId, answer, shopId } = req.data;
  await _assertAuth(req.auth);
  if (!answer || answer.length < 5) throw new Error('invalid-answer');

  const ref = _db().collection('productQuestions').doc(questionId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('question-not-found');

  const role = (req.auth.token && req.auth.token.role) || '';
  const isSeller = shopId && (
    (await _db().collection('shops').doc(shopId).get()).data()?.ownerId === req.auth.uid
  );
  const isAdmin = ['admin', 'super_admin'].includes(role);

  const answerObj = {
    answeredBy: req.auth.uid,
    answeredByName: req.auth.token.name || 'Community',
    isSeller: isSeller || isAdmin,
    answer: answer.slice(0, 1000),
    answeredAt: new Date().toISOString(),
    helpfulCount: 0,
  };

  await ref.update({
    answers: _fv().arrayUnion(answerObj),
    status: 'answered',
    updatedAt: _ts(),
  });

  return { success: true };
});

exports.productGetQA = onCall({ enforceAppCheck: true }, async (req) => {
  const { productId, limit: lim } = req.data;
  await _assertAuth(req.auth);
  const snap = await _db().collection('productQuestions')
    .where('productId', '==', productId).limit(lim || 20).get();
  const questions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  questions.sort((a, b) => {
    const aT = a.askedAt && a.askedAt.toMillis ? a.askedAt.toMillis() : 0;
    const bT = b.askedAt && b.askedAt.toMillis ? b.askedAt.toMillis() : 0;
    return bT - aT;
  });
  return { questions };
});

exports.productVoteHelpful = onCall({ enforceAppCheck: true }, async (req) => {
  const { questionId } = req.data;
  await _assertAuth(req.auth);
  const ref = _db().collection('productQuestions').doc(questionId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('not-found');
  await ref.update({ helpfulCount: _fv().increment(1) });
  return { success: true };
});

// ─── WISHLIST ─────────────────────────────────────────────────────────────────
// Collections: wishlistItems/{uid_productId}  (single-field uid query)

exports.wishlistAdd = onCall({ enforceAppCheck: true }, async (req) => {
  const { productId, shopId, name, price, image } = req.data;
  await _assertAuth(req.auth);
  if (!productId) throw new Error('productId-required');
  const docId = `${req.auth.uid}_${productId}`;
  await _db().collection('wishlistItems').doc(docId).set({
    uid: req.auth.uid,
    productId,
    shopId: shopId || null,
    name: name || '',
    price: price || null,
    image: image || null,
    addedAt: _ts(),
  });
  return { success: true };
});

exports.wishlistRemove = onCall({ enforceAppCheck: true }, async (req) => {
  const { productId } = req.data;
  await _assertAuth(req.auth);
  await _db().collection('wishlistItems').doc(`${req.auth.uid}_${productId}`).delete();
  return { success: true };
});

exports.wishlistGet = onCall({ enforceAppCheck: true }, async (req) => {
  await _assertAuth(req.auth);
  const snap = await _db().collection('wishlistItems')
    .where('uid', '==', req.auth.uid).limit(200).get();
  const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  items.sort((a, b) => {
    const aT = a.addedAt && a.addedAt.toMillis ? a.addedAt.toMillis() : 0;
    const bT = b.addedAt && b.addedAt.toMillis ? b.addedAt.toMillis() : 0;
    return bT - aT;
  });
  return { items };
});

// ─── PRICE HISTORY ───────────────────────────────────────────────────────────
// Collections: priceHistoryLog/{id}   (query by productId — single-field)
// Also called from digitalProductCreate / any price update

exports.priceHistoryRecord = onCall({ enforceAppCheck: true }, async (req) => {
  const { productId, shopId, oldPrice, newPrice } = req.data;
  await _assertSeller(req.auth, shopId);
  if (!productId || newPrice == null) throw new Error('invalid-input');
  await _db().collection('priceHistoryLog').add({
    productId,
    shopId,
    oldPrice: oldPrice || null,
    newPrice,
    changedAt: _ts(),
    changedBy: req.auth.uid,
    source: 'manual',
  });
  return { success: true };
});

exports.priceHistoryGet = onCall({ enforceAppCheck: true }, async (req) => {
  const { productId, limit: lim } = req.data;
  await _assertAuth(req.auth);
  const snap = await _db().collection('priceHistoryLog')
    .where('productId', '==', productId).limit(lim || 30).get();
  const history = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  history.sort((a, b) => {
    const aT = a.changedAt && a.changedAt.toMillis ? a.changedAt.toMillis() : 0;
    const bT = b.changedAt && b.changedAt.toMillis ? b.changedAt.toMillis() : 0;
    return aT - bT;
  });
  return { history };
});

// ─── SEO ─────────────────────────────────────────────────────────────────────

exports.seoGetProductMeta = onCall({ enforceAppCheck: true }, async (req) => {
  const { productId } = req.data;
  await _assertAuth(req.auth);
  // Try products collection, then digitalProducts, then rentalProducts
  for (const col of ['products', 'digitalProducts', 'rentalProducts', 'auctions']) {
    const snap = await _db().collection(col).doc(productId).get();
    if (snap.exists) {
      const d = snap.data();
      return {
        title: d.title || d.name || 'Product',
        description: (d.description || '').slice(0, 160),
        image: (d.images && d.images[0]) || d.previewUrl || null,
        price: d.price || d.currentBid || d.dailyRate || null,
        type: col,
        shopId: d.shopId,
      };
    }
  }
  throw new Error('product-not-found');
});

exports.seoGetShopMeta = onCall({ enforceAppCheck: true }, async (req) => {
  const { shopId } = req.data;
  await _assertAuth(req.auth);
  const snap = await _db().collection('shops').doc(shopId).get();
  if (!snap.exists) throw new Error('shop-not-found');
  const d = snap.data();
  return {
    name: d.name || d.shopName || 'Shop',
    description: (d.description || d.bio || '').slice(0, 160),
    logo: d.logo || d.profileImage || null,
    handle: d.handle || null,
    verified: d.verified || false,
    category: d.category || null,
  };
});

// Sitemap generator — onRequest, public
exports.seoGetSitemap = onRequest(
  { cors: ['https://mysokoni.co.ke'], invoker: 'public', timeoutSeconds: 30 },
  async (req, res) => {
    const baseUrl = 'https://mysokoni.co.ke';
    const today = new Date().toISOString().split('T')[0];

    const staticPages = [
      '', 'marketplace', 'food-hub', 'events', 'jobs',
      'healthcare', 'rentals', 'digital-store', 'auctions',
      'services', 'entertainment', 'pos.html', 'login.html',
    ];

    let urls = staticPages.map(p =>
      `  <url><loc>${baseUrl}/${p}</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>${p ? '0.8' : '1.0'}</priority></url>`
    );

    // Add active auctions
    try {
      const auctions = await _db().collection('auctions')
        .where('status', '==', 'active').limit(200).get();
      auctions.docs.forEach(d => {
        urls.push(`  <url><loc>${baseUrl}/auction?id=${d.id}</loc><lastmod>${today}</lastmod><changefreq>hourly</changefreq><priority>0.7</priority></url>`);
      });
    } catch (e) {}

    // Add digital products
    try {
      const products = await _db().collection('digitalProducts')
        .where('status', '==', 'active').limit(200).get();
      products.docs.forEach(d => {
        urls.push(`  <url><loc>${baseUrl}/digital-store?id=${d.id}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>`);
      });
    } catch (e) {}

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`;

    res.set('Content-Type', 'application/xml');
    res.set('Cache-Control', 'public, max-age=3600');
    res.status(200).send(xml);
  }
);
