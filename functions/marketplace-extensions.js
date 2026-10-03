'use strict';
/**
 * SOKONI — Marketplace Extensions Engine (Sprint 4.2)
 * Auctions • Rentals • Digital Products • Q&A • Wishlist • Price History • SEO
 * 31 Cloud Functions — enforceAppCheck: true on all onCall CFs
 */
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }        = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

function _db()  { return admin.firestore(); }
function _ts()  { return admin.firestore.FieldValue.serverTimestamp(); }
function _fv()  { return admin.firestore.FieldValue; }
function _id()  { return _db().collection('_').doc().id; }

async function _assertAuth(auth) {
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  return auth;
}

async function _assertAdmin(auth) {
  await _assertAuth(auth);
  const role = (auth.token && auth.token.role) || '';
  if (!['admin', 'super_admin'].includes(role)) throw new Error('forbidden');
}

async function _assertSeller(auth, shopId) {
  await _assertAuth(auth);
  if (!shopId || typeof shopId !== 'string') throw new HttpsError('invalid-argument', 'shopId is required.');
  const snap = await _db().collection('shops').doc(shopId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Shop not found.');
  const shop = snap.data() || {};
  const tk = auth.token || {};
  if (tk.admin === true || tk.superAdmin === true || ['admin', 'super_admin'].includes(tk.role || '')) return shop;
  /* Owner resolution = the served shops rule (sokoni-f3 rentals fix, sokoni-e3 finding: shops carry no ownerId in the
     shop identity model, so every real owner was refused): ownerId when the doc has one, otherwise shopId === uid. */
  if (shop.ownerId === auth.uid || (!('ownerId' in shop) && shopId === auth.uid)) return shop;
  const emp = await _db().collection('shopEmployees')
    .where('shopId', '==', shopId).where('uid', '==', auth.uid).limit(1).get();
  if (emp.empty) throw new HttpsError('permission-denied', 'You do not manage this shop.');
  return shop;
}

// Minimum bid increment by current bid value
function _minIncrement(currentBid) {
  if (currentBid < 1000)  return 50;
  if (currentBid < 5000)  return 100;
  if (currentBid < 20000) return 500;
  return 1000;
}

exports._h = {}; // handler registry — consumed by commerce-dispatch.js

// ─── AUCTIONS ────────────────────────────────────────────────────────────────
// Collections: auctions/{id}, auctionBids/{id}

exports.auctionCreate = onCall({ enforceAppCheck: true }, exports._h.auctionCreate = async (req) => {
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

exports.auctionBid = onCall({ enforceAppCheck: true }, exports._h.auctionBid = async (req) => {
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

exports.auctionGet = onCall({ enforceAppCheck: true }, exports._h.auctionGet = async (req) => {
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

exports.auctionList = onCall({ enforceAppCheck: true }, exports._h.auctionList = async (req) => {
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

exports.auctionGetBids = onCall({ enforceAppCheck: true }, exports._h.auctionGetBids = async (req) => {
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

exports.auctionWatch = onCall({ enforceAppCheck: true }, exports._h.auctionWatch = async (req) => {
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

exports.auctionGetMyBids = onCall({ enforceAppCheck: true }, exports._h.auctionGetMyBids = async (req) => {
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

exports.rentalProductCreate = onCall({ enforceAppCheck: true }, exports._h.rentalProductCreate = async (req) => {
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

exports.rentalGetAvailability = onCall({ enforceAppCheck: true }, exports._h.rentalGetAvailability = async (req) => {
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

exports.rentalBook = onCall({ enforceAppCheck: true }, exports._h.rentalBook = async (req) => {
  const { rentalProductId, startDate, endDate, durationUnit, customerName, customerPhone, notes } = req.data || {};
  await _assertAuth(req.auth);
  if (!rentalProductId || !startDate || !endDate) throw new HttpsError('invalid-argument', 'Choose the equipment and the rental dates.');
  const start = new Date(startDate), end = new Date(endDate);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) throw new HttpsError('invalid-argument', 'The rental dates are not valid.');
  if (end <= start) throw new HttpsError('invalid-argument', 'The end must be after the start.');
  if (start.getTime() < Date.now() - 3600000) throw new HttpsError('invalid-argument', 'The rental cannot start in the past.');
  const unit = ['hourly', 'daily', 'weekly', 'monthly'].includes(durationUnit) ? durationUnit : 'daily';
  const productRef = _db().collection('rentalProducts').doc(String(rentalProductId));
  const id = _id();
  const bookingRef = _db().collection('rentalBookings').doc(id);

  /* ONE transaction (sokoni-f3): the overlap check used to run outside any transaction, so two renters could both book
     the same dates. Product + existing bookings are read inside, then the booking is created. */
  const out = await _db().runTransaction(async (t) => {
    const productSnap = await t.get(productRef);
    if (!productSnap.exists) throw new HttpsError('not-found', 'That equipment was not found.');
    const product = productSnap.data();
    if (product.status !== 'active') throw new HttpsError('failed-precondition', 'That equipment is not available for rent.');
    if (product.shopId === req.auth.uid || product.createdBy === req.auth.uid) throw new HttpsError('failed-precondition', 'You cannot rent your own equipment.');
    const existing = await t.get(_db().collection('rentalBookings').where('rentalProductId', '==', String(rentalProductId)).limit(200));
    const conflict = existing.docs.some((d) => {
      const b = d.data();
      if (!['pending', 'confirmed', 'active'].includes(b.status)) return false;
      const bs = b.startDate && b.startDate.toDate ? b.startDate.toDate() : new Date(b.startDate);
      const be = b.endDate && b.endDate.toDate ? b.endDate.toDate() : new Date(b.endDate);
      return start < be && end > bs;
    });
    if (conflict) throw new HttpsError('failed-precondition', 'Those dates are already booked.');
    const hours = (end - start) / 3600000, days = hours / 24, weeks = days / 7, months = days / 30;
    let totalAmount = 0;
    if (unit === 'hourly'  && product.hourlyRate)  totalAmount = Math.ceil(hours)  * product.hourlyRate;
    if (unit === 'daily'   && product.dailyRate)   totalAmount = Math.ceil(days)   * product.dailyRate;
    if (unit === 'weekly'  && product.weeklyRate)  totalAmount = Math.ceil(weeks)  * product.weeklyRate;
    if (unit === 'monthly' && product.monthlyRate) totalAmount = Math.ceil(months) * product.monthlyRate;
    if (!(totalAmount > 0)) throw new HttpsError('failed-precondition', 'This equipment has no ' + unit + ' rate.');
    const depositAmount = Number(product.deposit) > 0 ? Number(product.deposit) : 0;
    t.create(bookingRef, {
      rentalProductId: String(rentalProductId), shopId: product.shopId, buyerId: req.auth.uid,
      customerName: String(customerName || req.auth.token.name || 'Customer').slice(0, 100),
      customerPhone: String(customerPhone || '').replace(/[^0-9+]/g, '').slice(0, 20),
      startDate: admin.firestore.Timestamp.fromDate(start), endDate: admin.firestore.Timestamp.fromDate(end),
      durationUnit: unit, totalAmount, depositAmount,
      /* No payment happens here (sokoni-e3 finding: the old default 'mpesa' was misleading). The rental_booking payment
         purpose (commercial authority) moves this to paid; until then the booking is unpaid. */
      paymentMethod: 'none', paymentStatus: 'unpaid',
      notes: String(notes || '').slice(0, 1000), status: 'pending', createdAt: _ts(),
    });
    return { totalAmount, depositAmount };
  });
  return { bookingId: id, totalAmount: out.totalAmount, depositAmount: out.depositAmount, paymentStatus: 'unpaid' };
});

/* Seller-side booking transition in ONE transaction: re-read, shop match, legal from-state. */
async function _rentalTransition(req, { from, to, extra }) {
  const { bookingId, shopId } = req.data || {};
  await _assertSeller(req.auth, shopId);
  if (!bookingId) throw new HttpsError('invalid-argument', 'bookingId is required.');
  const ref = _db().collection('rentalBookings').doc(String(bookingId));
  return _db().runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Booking not found.');
    const b = snap.data();
    if (b.shopId !== shopId) throw new HttpsError('permission-denied', 'That booking belongs to another shop.');
    if (b.status === to) return { success: true, unchanged: true, status: to };
    if (!from.includes(b.status)) throw new HttpsError('failed-precondition', 'A ' + b.status + ' booking cannot be ' + to + '.');
    t.update(ref, Object.assign({ status: to }, extra(req, b)));
    if (to === 'completed') t.update(_db().collection('rentalProducts').doc(b.rentalProductId), { bookingCount: _fv().increment(1) });
    return { success: true, status: to };
  });
}

exports.rentalConfirm = onCall({ enforceAppCheck: true }, exports._h.rentalConfirm = (req) =>
  _rentalTransition(req, { from: ['pending'], to: 'confirmed', extra: (r) => ({ confirmedAt: _ts(), confirmedBy: r.auth.uid }) }));

/* Was status-blind (sokoni-e3 finding): it would "complete" a pending or cancelled booking. */
exports.rentalComplete = onCall({ enforceAppCheck: true }, exports._h.rentalComplete = (req) =>
  _rentalTransition(req, { from: ['confirmed', 'active'], to: 'completed', extra: (r) => ({ completedAt: _ts(), completedBy: r.auth.uid, completionNotes: String((r.data || {}).notes || '').slice(0, 1000) }) }));

exports.rentalCancel = onCall({ enforceAppCheck: true }, exports._h.rentalCancel = async (req) => {
  const { bookingId, reason } = req.data || {};
  await _assertAuth(req.auth);
  if (!bookingId) throw new HttpsError('invalid-argument', 'bookingId is required.');
  const ref = _db().collection('rentalBookings').doc(String(bookingId));
  const pre = await ref.get();
  if (!pre.exists) throw new HttpsError('not-found', 'Booking not found.');
  const isRenter = pre.data().buyerId === req.auth.uid;
  /* The seller path used a token.shopId claim nothing mints (sokoni-e3 finding) — sellers could never cancel. It is now
     the same shop authority as every other seller op. */
  if (!isRenter) await _assertSeller(req.auth, pre.data().shopId);
  return _db().runTransaction(async (t) => {
    const snap = await t.get(ref);
    const b = snap.data();
    if (b.status === 'cancelled') return { success: true, unchanged: true, status: 'cancelled' };
    if (['completed', 'active'].includes(b.status)) throw new HttpsError('failed-precondition', 'A ' + b.status + ' booking cannot be cancelled.');
    t.update(ref, { status: 'cancelled', cancelledAt: _ts(), cancelledBy: req.auth.uid, cancelledByRole: isRenter ? 'renter' : 'seller', cancelReason: String(reason || '').slice(0, 500) });
    return { success: true, status: 'cancelled' };
  });
});

/* The shop's own equipment listings in every state (sokoni-e3 asked: replaces the page's direct rentalProducts read). */
exports.rentalOwnerListings = onCall({ enforceAppCheck: true }, exports._h.rentalOwnerListings = async (req) => {
  const { shopId } = req.data || {};
  await _assertSeller(req.auth, shopId);
  const snap = await _db().collection('rentalProducts').where('shopId', '==', shopId).limit(201).get();
  const listings = snap.docs.slice(0, 200).map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => ((b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0) - (a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0)));
  return { listings, hasMore: snap.docs.length > 200 };
});

exports.rentalList = onCall({ enforceAppCheck: true }, exports._h.rentalList = async (req) => {
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

exports.digitalProductCreate = onCall({ enforceAppCheck: true }, exports._h.digitalProductCreate = async (req) => {
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

exports.digitalProductPurchase = onCall({ enforceAppCheck: true }, exports._h.digitalProductPurchase = async (req) => {
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

exports.digitalProductDownload = onCall({ enforceAppCheck: true }, exports._h.digitalProductDownload = async (req) => {
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

exports.digitalProductGetMyLibrary = onCall({ enforceAppCheck: true }, exports._h.digitalProductGetMyLibrary = async (req) => {
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

exports.digitalProductGetSales = onCall({ enforceAppCheck: true }, exports._h.digitalProductGetSales = async (req) => {
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

exports.productAskQuestion = onCall({ enforceAppCheck: true }, exports._h.productAskQuestion = async (req) => {
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

exports.productAnswerQuestion = onCall({ enforceAppCheck: true }, exports._h.productAnswerQuestion = async (req) => {
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

exports.productGetQA = onCall({ enforceAppCheck: true }, exports._h.productGetQA = async (req) => {
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

exports.productVoteHelpful = onCall({ enforceAppCheck: true }, exports._h.productVoteHelpful = async (req) => {
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

exports.wishlistAdd = onCall({ enforceAppCheck: true }, exports._h.wishlistAdd = async (req) => {
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

exports.wishlistRemove = onCall({ enforceAppCheck: true }, exports._h.wishlistRemove = async (req) => {
  const { productId } = req.data;
  await _assertAuth(req.auth);
  await _db().collection('wishlistItems').doc(`${req.auth.uid}_${productId}`).delete();
  return { success: true };
});

exports.wishlistGet = onCall({ enforceAppCheck: true }, exports._h.wishlistGet = async (req) => {
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

exports.priceHistoryRecord = onCall({ enforceAppCheck: true }, exports._h.priceHistoryRecord = async (req) => {
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

exports.priceHistoryGet = onCall({ enforceAppCheck: true }, exports._h.priceHistoryGet = async (req) => {
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

exports.seoGetProductMeta = onCall({ enforceAppCheck: true }, exports._h.seoGetProductMeta = async (req) => {
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

exports.seoGetShopMeta = onCall({ enforceAppCheck: true }, exports._h.seoGetShopMeta = async (req) => {
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
