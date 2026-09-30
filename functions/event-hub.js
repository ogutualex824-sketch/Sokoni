'use strict';
/**
 * Event Hub v1.0 — SOKONI Platform
 * Event creation, ticketing, gate check-in, organizer analytics
 * 18 Cloud Functions | enforceAppCheck: true | region: us-central1
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

const REGION = 'us-central1';
const CF_OPTS = { region: REGION, enforceAppCheck: true };
const db = () => admin.firestore();
const auth = () => admin.auth();
const FieldValue = admin.firestore.FieldValue;

/* ── Role / auth guards ──────────────────────────────────────────────── */
async function getUser(uid) {
  const snap = await db().collection('users').doc(uid).get();
  if (!snap.exists) throw new HttpsError('not-found', 'User not found');
  return snap.data();
}

function requireAuth(context) {
  if (!context.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  return context.auth.uid;
}

async function requireOrganizer(uid) {
  const user = await getUser(uid);
  const role = user.role || 0;
  if (role < 2) throw new HttpsError('permission-denied', 'Organizer role required');
  return user;
}

function sanitize(s, max = 200) {
  if (s == null) return '';
  return String(s).trim().slice(0, max);
}

/* ── Category list ───────────────────────────────────────────────────── */
const VALID_CATEGORIES = [
  'concerts', 'conferences', 'weddings', 'sports', 'comedy', 'food_drink',
  'arts', 'education', 'networking', 'festivals', 'fashion', 'fitness',
  'corporate', 'charity', 'kids', 'religious', 'other',
];

/* ── QR token generator ──────────────────────────────────────────────── */
const crypto = require('crypto');
function genTicketToken() {
  return crypto.randomBytes(16).toString('hex');
}

/* ──────────────────────────────────────────────────────────────────────
   1. createEvent — Organizer creates a new event (draft status)
   ────────────────────────────────────────────────────────────────────── */
exports.createEvent = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  await requireOrganizer(uid);

  const { title, description, category, startDate, endDate, venue, address,
          city, bannerImageUrl, capacity, currency, tags, isOnline } = req.data;

  if (!title || !startDate || !category) {
    throw new HttpsError('invalid-argument', 'title, startDate, category are required');
  }
  if (!VALID_CATEGORIES.includes(category)) {
    throw new HttpsError('invalid-argument', 'Invalid category');
  }
  if (new Date(startDate) < new Date()) {
    throw new HttpsError('invalid-argument', 'startDate must be in the future');
  }

  const ref = db().collection('events').doc();
  const now = FieldValue.serverTimestamp();

  await ref.set({
    eventId: ref.id,
    organizerUid: uid,
    title: sanitize(title, 120),
    description: sanitize(description, 5000),
    category,
    startDate: new Date(startDate).toISOString(),
    endDate: endDate ? new Date(endDate).toISOString() : null,
    venue: sanitize(venue, 120),
    address: sanitize(address, 300),
    city: sanitize(city, 80),
    country: 'Kenya',
    bannerImageUrl: sanitize(bannerImageUrl, 500),
    capacity: capacity ? Math.max(1, parseInt(capacity, 10)) : null,
    currency: currency === 'USD' ? 'USD' : 'KES',
    tags: Array.isArray(tags) ? tags.slice(0, 10).map(t => sanitize(t, 30)) : [],
    isOnline: Boolean(isOnline),
    status: 'draft',
    totalTicketsSold: 0,
    totalRevenue: 0,
    checkinsCount: 0,
    ticketTiersCount: 0,
    likeCount: 0,
    viewCount: 0,
    createdAt: now,
    updatedAt: now,
  });

  return { eventId: ref.id, status: 'draft' };
});

/* ──────────────────────────────────────────────────────────────────────
   2. updateEvent — Organizer updates event details (draft or live)
   ────────────────────────────────────────────────────────────────────── */
exports.updateEvent = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { eventId, ...fields } = req.data;
  if (!eventId) throw new HttpsError('invalid-argument', 'eventId required');

  const ref = db().collection('events').doc(eventId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Event not found');
  const ev = snap.data();
  if (ev.organizerUid !== uid) throw new HttpsError('permission-denied', 'Not event owner');
  if (ev.status === 'cancelled') throw new HttpsError('failed-precondition', 'Cannot edit cancelled event');

  const allowed = ['title', 'description', 'venue', 'address', 'city', 'bannerImageUrl',
                   'startDate', 'endDate', 'capacity', 'tags', 'isOnline'];
  const updates = { updatedAt: FieldValue.serverTimestamp() };

  for (const k of allowed) {
    if (fields[k] !== undefined) {
      if (k === 'startDate' || k === 'endDate') {
        updates[k] = fields[k] ? new Date(fields[k]).toISOString() : null;
      } else if (k === 'tags') {
        updates[k] = Array.isArray(fields[k]) ? fields[k].slice(0, 10).map(t => sanitize(t, 30)) : ev.tags;
      } else if (k === 'capacity') {
        updates[k] = fields[k] ? Math.max(1, parseInt(fields[k], 10)) : null;
      } else {
        updates[k] = sanitize(fields[k], k === 'description' ? 5000 : 300);
      }
    }
  }

  await ref.update(updates);
  return { ok: true };
});

/* ──────────────────────────────────────────────────────────────────────
   3. publishEvent — Validate and make event live
   ────────────────────────────────────────────────────────────────────── */
exports.publishEvent = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { eventId } = req.data;
  if (!eventId) throw new HttpsError('invalid-argument', 'eventId required');

  const ref = db().collection('events').doc(eventId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Event not found');
  const ev = snap.data();
  if (ev.organizerUid !== uid) throw new HttpsError('permission-denied', 'Not event owner');
  if (ev.status === 'live') throw new HttpsError('failed-precondition', 'Already live');
  if (ev.status === 'cancelled') throw new HttpsError('failed-precondition', 'Event is cancelled');

  if (new Date(ev.startDate) < new Date()) {
    throw new HttpsError('failed-precondition', 'Cannot publish an event with a past start date');
  }

  if (ev.ticketTiersCount < 1) {
    throw new HttpsError('failed-precondition', 'Add at least one ticket tier before publishing');
  }

  await ref.update({ status: 'live', publishedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  return { ok: true, status: 'live' };
});

/* ──────────────────────────────────────────────────────────────────────
   4. cancelEvent — Cancel event and flag orders for refund
   ────────────────────────────────────────────────────────────────────── */
exports.cancelEvent = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { eventId, reason } = req.data;
  if (!eventId) throw new HttpsError('invalid-argument', 'eventId required');

  const ref = db().collection('events').doc(eventId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Event not found');
  const ev = snap.data();

  const tok = await auth().getUser(uid);
  const role = (tok.customClaims || {}).role || 0;
  const isOwner = ev.organizerUid === uid;
  const isAdmin = role >= 4;
  if (!isOwner && !isAdmin) throw new HttpsError('permission-denied', 'Not authorised');
  if (ev.status === 'cancelled') throw new HttpsError('failed-precondition', 'Already cancelled');

  const batch = db().batch();
  batch.update(ref, {
    status: 'cancelled',
    cancelledAt: FieldValue.serverTimestamp(),
    cancellationReason: sanitize(reason, 500),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Mark all paid orders for refund processing
  const ordersSnap = await db().collection('eventOrders')
    .where('eventId', '==', eventId)
    .where('status', '==', 'paid')
    .get();

  ordersSnap.docs.forEach(doc => {
    batch.update(doc.ref, { status: 'pending_refund', cancelledAt: FieldValue.serverTimestamp() });
  });

  await batch.commit();
  return { ok: true, ordersMarkedForRefund: ordersSnap.size };
});

/* ──────────────────────────────────────────────────────────────────────
   5. getEvent — Public: get event details + tier summary
   ────────────────────────────────────────────────────────────────────── */
exports.getEvent = onCall(CF_OPTS, async (req) => {
  const { eventId } = req.data;
  if (!eventId) throw new HttpsError('invalid-argument', 'eventId required');

  const [evSnap, tiersSnap] = await Promise.all([
    db().collection('events').doc(eventId).get(),
    db().collection('eventTicketTiers')
      .where('eventId', '==', eventId)
      .where('isActive', '==', true)
      .orderBy('sortOrder', 'asc')
      .get(),
  ]);

  if (!evSnap.exists) throw new HttpsError('not-found', 'Event not found');
  const ev = evSnap.data();
  if (ev.status !== 'live' && ev.status !== 'ended') {
    const uid = req.auth?.uid;
    if (!uid || uid !== ev.organizerUid) {
      const tok = uid ? await auth().getUser(uid) : null;
      const role = tok ? ((tok.customClaims || {}).role || 0) : 0;
      if (role < 4) throw new HttpsError('not-found', 'Event not found');
    }
  }

  // Increment view count (fire-and-forget)
  db().collection('events').doc(eventId).update({ viewCount: FieldValue.increment(1) }).catch(() => {});

  const tiers = tiersSnap.docs.map(d => {
    const t = d.data();
    return {
      tierId: t.tierId,
      name: t.name,
      price: t.price,
      currency: t.currency,
      description: t.description,
      quantity: t.quantity,
      sold: t.sold,
      available: t.quantity - t.sold,
      perks: t.perks,
      saleEndsAt: t.saleEndsAt,
    };
  });

  return { ...ev, tiers };
});

/* ──────────────────────────────────────────────────────────────────────
   6. listEvents — Public discovery with filters & pagination
   ────────────────────────────────────────────────────────────────────── */
exports.listEvents = onCall(CF_OPTS, async (req) => {
  const { category, city, startAfter: afterDate, limit = 24, cursor, priceMax, free } = req.data;

  let q = db().collection('events')
    .where('status', '==', 'live')
    .orderBy('startDate', 'asc')
    .limit(Math.min(48, parseInt(limit, 10) || 24));

  if (category && VALID_CATEGORIES.includes(category)) {
    q = db().collection('events')
      .where('status', '==', 'live')
      .where('category', '==', category)
      .orderBy('startDate', 'asc')
      .limit(Math.min(48, parseInt(limit, 10) || 24));
  }

  // Simple date filter: events starting after now by default
  const fromDate = afterDate ? new Date(afterDate).toISOString() : new Date().toISOString();
  q = q.where('startDate', '>=', fromDate);

  if (cursor) {
    const cursorDoc = await db().collection('events').doc(cursor).get();
    if (cursorDoc.exists) q = q.startAfter(cursorDoc);
  }

  const snap = await q.get();
  let events = snap.docs.map(d => {
    const e = d.data();
    return {
      eventId: e.eventId,
      title: e.title,
      category: e.category,
      startDate: e.startDate,
      endDate: e.endDate,
      venue: e.venue,
      city: e.city,
      bannerImageUrl: e.bannerImageUrl,
      totalTicketsSold: e.totalTicketsSold,
      isOnline: e.isOnline,
    };
  });

  // Client-side filters (avoid composite indexes)
  if (city) events = events.filter(e => (e.city || '').toLowerCase().includes(city.toLowerCase()));

  const nextCursor = snap.docs.length === Math.min(48, parseInt(limit, 10) || 24)
    ? snap.docs[snap.docs.length - 1].id : null;

  return { events, nextCursor };
});

/* ──────────────────────────────────────────────────────────────────────
   7. searchEvents — Basic text search across title / description / city
   ────────────────────────────────────────────────────────────────────── */
exports.searchEvents = onCall(CF_OPTS, async (req) => {
  const { query, limit = 20 } = req.data;
  if (!query || !query.trim()) throw new HttpsError('invalid-argument', 'query required');

  const q = query.trim().toLowerCase();
  const snap = await db().collection('events')
    .where('status', '==', 'live')
    .where('startDate', '>=', new Date().toISOString())
    .orderBy('startDate', 'asc')
    .limit(200)
    .get();

  const results = snap.docs
    .map(d => d.data())
    .filter(e =>
      (e.title || '').toLowerCase().includes(q) ||
      (e.description || '').toLowerCase().includes(q) ||
      (e.city || '').toLowerCase().includes(q) ||
      (e.category || '').toLowerCase().includes(q) ||
      (e.tags || []).some(t => t.toLowerCase().includes(q))
    )
    .slice(0, Math.min(50, parseInt(limit, 10) || 20))
    .map(e => ({
      eventId: e.eventId,
      title: e.title,
      category: e.category,
      startDate: e.startDate,
      venue: e.venue,
      city: e.city,
      bannerImageUrl: e.bannerImageUrl,
    }));

  return { results, total: results.length };
});

/* ──────────────────────────────────────────────────────────────────────
   8. createTicketTier — Organizer adds a ticket tier to an event
   ────────────────────────────────────────────────────────────────────── */
exports.createTicketTier = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { eventId, name, price, quantity, description, perks, saleEndsAt, sortOrder } = req.data;

  if (!eventId || !name || price == null || !quantity) {
    throw new HttpsError('invalid-argument', 'eventId, name, price, quantity required');
  }

  const evSnap = await db().collection('events').doc(eventId).get();
  if (!evSnap.exists) throw new HttpsError('not-found', 'Event not found');
  const ev = evSnap.data();
  if (ev.organizerUid !== uid) throw new HttpsError('permission-denied', 'Not event owner');
  if (ev.status === 'cancelled') throw new HttpsError('failed-precondition', 'Event is cancelled');

  const parsedPrice = parseFloat(price);
  if (parsedPrice < 0) throw new HttpsError('invalid-argument', 'Price cannot be negative');
  const parsedQty = parseInt(quantity, 10);
  if (parsedQty < 1) throw new HttpsError('invalid-argument', 'Quantity must be at least 1');

  const ref = db().collection('eventTicketTiers').doc();
  const batch = db().batch();

  batch.set(ref, {
    tierId: ref.id,
    eventId,
    organizerUid: uid,
    name: sanitize(name, 80),
    price: parsedPrice,
    currency: ev.currency || 'KES',
    quantity: parsedQty,
    sold: 0,
    description: sanitize(description, 500),
    perks: Array.isArray(perks) ? perks.slice(0, 10).map(p => sanitize(p, 100)) : [],
    saleEndsAt: saleEndsAt ? new Date(saleEndsAt).toISOString() : null,
    sortOrder: parseInt(sortOrder, 10) || 0,
    isActive: true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  batch.update(db().collection('events').doc(eventId), {
    ticketTiersCount: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await batch.commit();
  return { tierId: ref.id };
});

/* ──────────────────────────────────────────────────────────────────────
   9. updateTicketTier — Edit tier details (price/qty before sales only)
   ────────────────────────────────────────────────────────────────────── */
exports.updateTicketTier = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { tierId, name, description, perks, saleEndsAt, isActive, sortOrder } = req.data;
  if (!tierId) throw new HttpsError('invalid-argument', 'tierId required');

  const ref = db().collection('eventTicketTiers').doc(tierId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Tier not found');
  const tier = snap.data();
  if (tier.organizerUid !== uid) throw new HttpsError('permission-denied', 'Not tier owner');

  const updates = { updatedAt: FieldValue.serverTimestamp() };
  if (name != null) updates.name = sanitize(name, 80);
  if (description != null) updates.description = sanitize(description, 500);
  if (perks != null) updates.perks = Array.isArray(perks) ? perks.slice(0, 10).map(p => sanitize(p, 100)) : tier.perks;
  if (saleEndsAt != null) updates.saleEndsAt = saleEndsAt ? new Date(saleEndsAt).toISOString() : null;
  if (isActive != null) updates.isActive = Boolean(isActive);
  if (sortOrder != null) updates.sortOrder = parseInt(sortOrder, 10) || 0;

  await ref.update(updates);
  return { ok: true };
});

/* ──────────────────────────────────────────────────────────────────────
   10. purchaseTickets — Atomic ticket purchase (idempotent)
   ────────────────────────────────────────────────────────────────────── */
exports.purchaseTickets = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { tierId, quantity, promoCode, idempotencyKey, attendeeName, attendeeEmail } = req.data;

  if (!tierId || !quantity || !idempotencyKey) {
    throw new HttpsError('invalid-argument', 'tierId, quantity, idempotencyKey required');
  }

  const qty = parseInt(quantity, 10);
  if (qty < 1 || qty > 20) throw new HttpsError('invalid-argument', 'Quantity 1-20');

  // Idempotency ref — checked INSIDE the transaction (see below) to prevent TOCTOU races
  const idemRef = db().collection('eventOrderIdempotency').doc(idempotencyKey);

  const tierRef = db().collection('eventTicketTiers').doc(tierId);
  const tierSnap = await tierRef.get();
  if (!tierSnap.exists) throw new HttpsError('not-found', 'Ticket tier not found');
  const tier = tierSnap.data();

  if (!tier.isActive) throw new HttpsError('failed-precondition', 'This tier is no longer available');
  if (tier.saleEndsAt && new Date(tier.saleEndsAt) < new Date()) {
    throw new HttpsError('failed-precondition', 'Ticket sales for this tier have ended');
  }

  const evSnap = await db().collection('events').doc(tier.eventId).get();
  if (!evSnap.exists) throw new HttpsError('not-found', 'Event not found');
  const ev = evSnap.data();
  if (ev.status !== 'live') throw new HttpsError('failed-precondition', 'Event is not available for ticket purchase');
  if (new Date(ev.startDate) < new Date()) throw new HttpsError('failed-precondition', 'Event has already started');

  // Promo code validation
  let discountAmount = 0;
  let promoCodeId = null;
  if (promoCode) {
    const promoSnap = await db().collection('eventPromoCodes')
      .where('eventId', '==', tier.eventId)
      .where('code', '==', promoCode.toUpperCase())
      .where('isActive', '==', true)
      .limit(1)
      .get();

    if (!promoSnap.empty) {
      const promo = promoSnap.docs[0].data();
      if ((!promo.maxUses || promo.uses < promo.maxUses) && (!promo.expiresAt || new Date(promo.expiresAt) > new Date())) {
        promoCodeId = promoSnap.docs[0].id;
        if (promo.discountType === 'percent') {
          discountAmount = (tier.price * qty * promo.discountValue) / 100;
        } else {
          discountAmount = Math.min(promo.discountValue, tier.price * qty);
        }
      }
    }
  }

  const subtotal = tier.price * qty;
  /* Event ticket purchase — priced by the ONE Commission Engine.
   *
   * This computed the fee itself. The RATE was already correct (it came from the single config),
   * but the calculation bypassed calculateCommission, so this flow ignored commissionRules,
   * revenueConfig overrides, commission holidays and the audit trail.
   *
   * PRICING IS UNCHANGED: same category (event_tickets), same arithmetic. skipMinimum:true because this
   * flow never applied the KES 10 platform floor, and introducing one here would be a repricing
   * of small purchases, not a refactor. */
  const _payable = Math.max(0, subtotal - discountAmount);
  const _comm = tier.price === 0 ? null : await require('./finos-utils').calculateCommission(db(), {
    orderAmountCents: Math.round(_payable * 100),
    category:         'event_tickets',
    sellerId:         ev.organizerUid || null,   /* the events doc field — verified */
    hubId:            'events',
    skipMinimum:      true,
  });
  const platformFee = _comm ? _comm.commissionCents / 100 : 0;
  const totalAmount = Math.max(0, subtotal - discountAmount);
  const organizerAmount = totalAmount - platformFee;

  // Generate orderId once, before the transaction — stable across Firestore retries
  const orderId = db().collection('eventOrders').doc().id;

  let isReplay = false; let replayData = null;
  await db().runTransaction(async t => {
    // Idempotency — FIRST read inside the transaction so concurrent retries cannot both win
    const idemSnap = await t.get(idemRef);
    if (idemSnap.exists) { isReplay = true; replayData = idemSnap.data(); return; }

    const freshTier = await t.get(tierRef);
    if (!freshTier.exists) throw new HttpsError('not-found', 'Tier not found');
    const td = freshTier.data();
    const available = td.quantity - td.sold;
    if (available < qty) throw new HttpsError('resource-exhausted', `Only ${available} ticket(s) remaining`);

    const orderRef = db().collection('eventOrders').doc(orderId);
    t.set(orderRef, {
      orderId,
      buyerUid: uid,
      eventId: tier.eventId,
      tierId,
      tierName: tier.name,
      quantity: qty,
      unitPrice: tier.price,
      subtotal,
      discountAmount,
      platformFee,
      totalAmount,
      organizerAmount,
      currency: tier.currency,
      promoCodeId,
      promoCode: promoCode || null,
      attendeeName: sanitize(attendeeName, 120),
      attendeeEmail: sanitize(attendeeEmail, 200),
      status: tier.price === 0 ? 'paid' : 'pending_payment',
      idempotencyKey,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    t.update(tierRef, {
      sold: FieldValue.increment(qty),
      updatedAt: FieldValue.serverTimestamp(),
    });

    t.update(db().collection('events').doc(tier.eventId), {
      totalTicketsSold: FieldValue.increment(qty),
      updatedAt: FieldValue.serverTimestamp(),
    });

    t.set(idemRef, { orderId, createdAt: FieldValue.serverTimestamp() });

    if (promoCodeId) {
      t.update(db().collection('eventPromoCodes').doc(promoCodeId), {
        uses: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  });

  // Return early if this was an idempotent replay (transaction found existing idemRef)
  if (isReplay) return { orderId: replayData.orderId, idempotent: true };

  // Generate individual ticket documents
  const ticketBatch = db().batch();
  const tokens = [];
  for (let i = 0; i < qty; i++) {
    const ticketRef = db().collection('eventTickets').doc();
    const token = genTicketToken();
    tokens.push(token);
    ticketBatch.set(ticketRef, {
      ticketId: ticketRef.id,
      orderId,
      eventId: tier.eventId,
      tierId,
      tierName: tier.name,
      buyerUid: uid,
      token,
      qrData: `sokoni-ticket:${ticketRef.id}:${token}`,
      attendeeName: sanitize(attendeeName, 120),
      attendeeEmail: sanitize(attendeeEmail, 200),
      status: tier.price === 0 ? 'valid' : 'awaiting_payment',
      checkedIn: false,
      checkedInAt: null,
      checkedInBy: null,
      seatNumber: null,
      createdAt: FieldValue.serverTimestamp(),
    });
  }
  await ticketBatch.commit();

  return {
    orderId,
    totalAmount,
    currency: tier.currency,
    status: tier.price === 0 ? 'paid' : 'pending_payment',
    ticketCount: qty,
  };
});

/* ──────────────────────────────────────────────────────────────────────
   11. getMyTickets — Buyer: list all their event tickets
   ────────────────────────────────────────────────────────────────────── */
exports.getMyTickets = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { status, limit = 20 } = req.data;

  let q = db().collection('eventTickets')
    .where('buyerUid', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(Math.min(50, parseInt(limit, 10) || 20));

  if (status) q = q.where('status', '==', status);

  const snap = await q.get();
  const tickets = snap.docs.map(d => d.data());

  // Enrich with event details
  const eventIds = [...new Set(tickets.map(t => t.eventId))];
  const eventSnaps = await Promise.all(eventIds.map(id => db().collection('events').doc(id).get()));
  const eventMap = {};
  eventSnaps.forEach(s => { if (s.exists) eventMap[s.id] = s.data(); });

  return {
    tickets: tickets.map(t => ({
      ticketId: t.ticketId,
      orderId: t.orderId,
      eventId: t.eventId,
      tierId: t.tierId,
      tierName: t.tierName,
      qrData: t.status === 'valid' ? t.qrData : null,
      status: t.status,
      checkedIn: t.checkedIn,
      checkedInAt: t.checkedInAt,
      event: eventMap[t.eventId] ? {
        title: eventMap[t.eventId].title,
        startDate: eventMap[t.eventId].startDate,
        venue: eventMap[t.eventId].venue,
        city: eventMap[t.eventId].city,
        bannerImageUrl: eventMap[t.eventId].bannerImageUrl,
      } : null,
    })),
  };
});

/* ──────────────────────────────────────────────────────────────────────
   12. getTicket — Get single ticket (buyer or gate staff)
   ────────────────────────────────────────────────────────────────────── */
exports.getTicket = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { ticketId } = req.data;
  if (!ticketId) throw new HttpsError('invalid-argument', 'ticketId required');

  const snap = await db().collection('eventTickets').doc(ticketId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Ticket not found');
  const ticket = snap.data();

  // Buyer, organizer, or admin can view
  const tok = await auth().getUser(uid);
  const role = (tok.customClaims || {}).role || 0;
  const evSnap = await db().collection('events').doc(ticket.eventId).get();
  const ev = evSnap.exists ? evSnap.data() : null;
  const isOrganizer = ev && ev.organizerUid === uid;
  if (ticket.buyerUid !== uid && !isOrganizer && role < 4) {
    throw new HttpsError('permission-denied', 'Access denied');
  }

  return {
    ...ticket,
    event: ev ? { title: ev.title, startDate: ev.startDate, venue: ev.venue, city: ev.city } : null,
  };
});

/* ──────────────────────────────────────────────────────────────────────
   13. checkInTicket — Gate staff: validate QR and mark used
   ────────────────────────────────────────────────────────────────────── */
exports.checkInTicket = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { ticketId, token } = req.data;
  if (!ticketId || !token) throw new HttpsError('invalid-argument', 'ticketId and token required');

  const ticketRef = db().collection('eventTickets').doc(ticketId);
  const snap = await ticketRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Ticket not found');
  const ticket = snap.data();

  // Verify token matches
  if (ticket.token !== token) throw new HttpsError('invalid-argument', 'Invalid ticket token');

  // Verify operator is event organizer or admin
  const tok = await auth().getUser(uid);
  const role = (tok.customClaims || {}).role || 0;
  const evSnap = await db().collection('events').doc(ticket.eventId).get();
  if (!evSnap.exists) throw new HttpsError('not-found', 'Event not found');
  const ev = evSnap.data();
  if (ev.organizerUid !== uid && role < 4) throw new HttpsError('permission-denied', 'Not authorized for check-in');

  if (ticket.checkedIn) {
    return {
      result: 'already_used',
      checkedInAt: ticket.checkedInAt,
      checkedInBy: ticket.checkedInBy,
      ticketId,
    };
  }

  if (ticket.status !== 'valid') {
    return { result: 'invalid', reason: `Ticket status: ${ticket.status}`, ticketId };
  }

  const batch = db().batch();
  batch.update(ticketRef, {
    checkedIn: true,
    checkedInAt: FieldValue.serverTimestamp(),
    checkedInBy: uid,
    status: 'used',
  });

  const checkinRef = db().collection('eventCheckins').doc();
  batch.set(checkinRef, {
    checkinId: checkinRef.id,
    ticketId,
    eventId: ticket.eventId,
    buyerUid: ticket.buyerUid,
    checkedInBy: uid,
    checkedInAt: FieldValue.serverTimestamp(),
    tierName: ticket.tierName,
  });

  batch.update(db().collection('events').doc(ticket.eventId), {
    checkinsCount: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await batch.commit();

  return {
    result: 'success',
    ticketId,
    attendeeName: ticket.attendeeName,
    tierName: ticket.tierName,
  };
});

/* ──────────────────────────────────────────────────────────────────────
   14. getEventOrders — Organizer: paginated order list for an event
   ────────────────────────────────────────────────────────────────────── */
exports.getEventOrders = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { eventId, status, limit = 50, cursor } = req.data;
  if (!eventId) throw new HttpsError('invalid-argument', 'eventId required');

  const evSnap = await db().collection('events').doc(eventId).get();
  if (!evSnap.exists) throw new HttpsError('not-found', 'Event not found');
  const ev = evSnap.data();

  const tok = await auth().getUser(uid);
  const role = (tok.customClaims || {}).role || 0;
  if (ev.organizerUid !== uid && role < 4) throw new HttpsError('permission-denied', 'Not authorized');

  let q = db().collection('eventOrders')
    .where('eventId', '==', eventId)
    .orderBy('createdAt', 'desc')
    .limit(Math.min(200, parseInt(limit, 10) || 50));

  if (status) q = q.where('status', '==', status);

  if (cursor) {
    const cursorDoc = await db().collection('eventOrders').doc(cursor).get();
    if (cursorDoc.exists) q = q.startAfter(cursorDoc);
  }

  const snap = await q.get();
  const orders = snap.docs.map(d => d.data());
  const nextCursor = snap.docs.length === Math.min(200, parseInt(limit, 10) || 50)
    ? snap.docs[snap.docs.length - 1].id : null;

  return { orders, nextCursor, total: orders.length };
});

/* ──────────────────────────────────────────────────────────────────────
   15. getEventAnalytics — Organizer: revenue, check-in, sales breakdown
   ────────────────────────────────────────────────────────────────────── */
exports.getEventAnalytics = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { eventId } = req.data;
  if (!eventId) throw new HttpsError('invalid-argument', 'eventId required');

  const evSnap = await db().collection('events').doc(eventId).get();
  if (!evSnap.exists) throw new HttpsError('not-found', 'Event not found');
  const ev = evSnap.data();

  const tok = await auth().getUser(uid);
  const role = (tok.customClaims || {}).role || 0;
  if (ev.organizerUid !== uid && role < 4) throw new HttpsError('permission-denied', 'Not authorized');

  const [tiersSnap, ordersSnap] = await Promise.all([
    db().collection('eventTicketTiers').where('eventId', '==', eventId).get(),
    db().collection('eventOrders')
      .where('eventId', '==', eventId)
      .where('status', '==', 'paid')
      .get(),
  ]);

  const orders = ordersSnap.docs.map(d => d.data());
  const tiers = tiersSnap.docs.map(d => d.data());

  const totalRevenue = orders.reduce((s, o) => s + (o.totalAmount || 0), 0);
  const platformFees = orders.reduce((s, o) => s + (o.platformFee || 0), 0);
  const organizerRevenue = totalRevenue - platformFees;
  const totalTickets = orders.reduce((s, o) => s + o.quantity, 0);
  const checkins = ev.checkinsCount || 0;
  const checkInRate = totalTickets > 0 ? Math.round((checkins / totalTickets) * 100) : 0;

  const capacity = tiers.reduce((s, t) => s + t.quantity, 0);
  const sold = tiers.reduce((s, t) => s + t.sold, 0);
  const capacityUtilization = capacity > 0 ? Math.round((sold / capacity) * 100) : 0;

  const tierBreakdown = tiers.map(t => ({
    tierId: t.tierId,
    name: t.name,
    price: t.price,
    quantity: t.quantity,
    sold: t.sold,
    available: t.quantity - t.sold,
    revenue: t.sold * t.price,
    percentSold: t.quantity > 0 ? Math.round((t.sold / t.quantity) * 100) : 0,
  }));

  return {
    eventId,
    title: ev.title,
    status: ev.status,
    totalTickets,
    totalRevenue,
    platformFees,
    organizerRevenue,
    checkins,
    checkInRate,
    capacity,
    sold,
    capacityUtilization,
    tierBreakdown,
    viewCount: ev.viewCount || 0,
    likeCount: ev.likeCount || 0,
  };
});

/* ──────────────────────────────────────────────────────────────────────
   16. getOrganizerDashboard — All events + aggregate metrics for organizer
   ────────────────────────────────────────────────────────────────────── */
exports.getOrganizerDashboard = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  await requireOrganizer(uid);

  const snap = await db().collection('events')
    .where('organizerUid', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();

  const events = snap.docs.map(d => d.data());
  const now = new Date().toISOString();

  const upcoming = events.filter(e => e.status === 'live' && e.startDate >= now);
  const past = events.filter(e => e.status === 'ended' || e.startDate < now);
  const drafts = events.filter(e => e.status === 'draft');
  const cancelled = events.filter(e => e.status === 'cancelled');

  const totalRevenue = events.reduce((s, e) => s + (e.totalRevenue || 0), 0);
  const totalTicketsSold = events.reduce((s, e) => s + (e.totalTicketsSold || 0), 0);
  const totalCheckins = events.reduce((s, e) => s + (e.checkinsCount || 0), 0);

  return {
    summary: {
      totalEvents: events.length,
      upcoming: upcoming.length,
      past: past.length,
      drafts: drafts.length,
      cancelled: cancelled.length,
      totalRevenue,
      totalTicketsSold,
      totalCheckins,
    },
    events: events.map(e => ({
      eventId: e.eventId,
      title: e.title,
      category: e.category,
      status: e.status,
      startDate: e.startDate,
      venue: e.venue,
      totalTicketsSold: e.totalTicketsSold || 0,
      totalRevenue: e.totalRevenue || 0,
      checkinsCount: e.checkinsCount || 0,
      viewCount: e.viewCount || 0,
      bannerImageUrl: e.bannerImageUrl,
    })),
  };
});

/* ──────────────────────────────────────────────────────────────────────
   17. createEventPromoCode — Organizer creates discount code for event
   ────────────────────────────────────────────────────────────────────── */
exports.createEventPromoCode = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { eventId, code, discountType, discountValue, maxUses, expiresAt } = req.data;

  if (!eventId || !code || !discountType || discountValue == null) {
    throw new HttpsError('invalid-argument', 'eventId, code, discountType, discountValue required');
  }
  if (!['percent', 'fixed'].includes(discountType)) {
    throw new HttpsError('invalid-argument', 'discountType must be percent or fixed');
  }

  const evSnap = await db().collection('events').doc(eventId).get();
  if (!evSnap.exists) throw new HttpsError('not-found', 'Event not found');
  if (evSnap.data().organizerUid !== uid) throw new HttpsError('permission-denied', 'Not event owner');

  const cleanCode = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
  if (cleanCode.length < 3) throw new HttpsError('invalid-argument', 'Code must be at least 3 alphanumeric characters');

  // Check uniqueness within event
  const existingSnap = await db().collection('eventPromoCodes')
    .where('eventId', '==', eventId)
    .where('code', '==', cleanCode)
    .limit(1)
    .get();
  if (!existingSnap.empty) throw new HttpsError('already-exists', 'Promo code already exists for this event');

  if (discountType === 'percent' && (discountValue <= 0 || discountValue > 100)) {
    throw new HttpsError('invalid-argument', 'Percent discount must be 1–100');
  }

  const ref = db().collection('eventPromoCodes').doc();
  await ref.set({
    promoCodeId: ref.id,
    eventId,
    organizerUid: uid,
    code: cleanCode,
    discountType,
    discountValue: parseFloat(discountValue),
    maxUses: maxUses ? parseInt(maxUses, 10) : null,
    uses: 0,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    isActive: true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  return { promoCodeId: ref.id, code: cleanCode };
});

/* ──────────────────────────────────────────────────────────────────────
   18. validateEventPromoCode — Pre-checkout promo code validation
   ────────────────────────────────────────────────────────────────────── */
exports.validateEventPromoCode = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { eventId, code, tierId, quantity } = req.data;
  if (!eventId || !code) throw new HttpsError('invalid-argument', 'eventId and code required');

  const promoSnap = await db().collection('eventPromoCodes')
    .where('eventId', '==', eventId)
    .where('code', '==', code.toUpperCase())
    .where('isActive', '==', true)
    .limit(1)
    .get();

  if (promoSnap.empty) return { valid: false, reason: 'Code not found' };
  const promo = promoSnap.docs[0].data();

  if (promo.maxUses && promo.uses >= promo.maxUses) return { valid: false, reason: 'Code usage limit reached' };
  if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) return { valid: false, reason: 'Code has expired' };

  let discountAmount = 0;
  if (tierId && quantity) {
    const tierSnap = await db().collection('eventTicketTiers').doc(tierId).get();
    if (tierSnap.exists) {
      const tier = tierSnap.data();
      const subtotal = tier.price * parseInt(quantity, 10);
      if (promo.discountType === 'percent') {
        discountAmount = (subtotal * promo.discountValue) / 100;
      } else {
        discountAmount = Math.min(promo.discountValue, subtotal);
      }
    }
  }

  return {
    valid: true,
    code: promo.code,
    discountType: promo.discountType,
    discountValue: promo.discountValue,
    discountAmount: Math.round(discountAmount * 100) / 100,
  };
});

/* ──────────────────────────────────────────────────────────────────────
   19. Scheduled: autoEndEvents — Mark past events as 'ended'
   ────────────────────────────────────────────────────────────────────── */
exports.autoEndEvents = onSchedule({
  schedule: 'every 1 hours',
  timeZone: 'Africa/Nairobi',
  region: REGION,
}, async () => {
  const now = new Date().toISOString();
  const snap = await db().collection('events')
    .where('status', '==', 'live')
    .where('startDate', '<', now)
    .limit(100)
    .get();

  if (snap.empty) return;

  const batch = db().batch();
  snap.docs.forEach(doc => {
    batch.update(doc.ref, {
      status: 'ended',
      endedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();
  console.log(`[autoEndEvents] Ended ${snap.size} events`);
});

module.exports = {
  createEvent:              exports.createEvent,
  updateEvent:              exports.updateEvent,
  publishEvent:             exports.publishEvent,
  cancelEvent:              exports.cancelEvent,
  getEvent:                 exports.getEvent,
  listEvents:               exports.listEvents,
  searchEvents:             exports.searchEvents,
  createTicketTier:         exports.createTicketTier,
  updateTicketTier:         exports.updateTicketTier,
  purchaseTickets:          exports.purchaseTickets,
  getMyTickets:             exports.getMyTickets,
  getTicket:                exports.getTicket,
  checkInTicket:            exports.checkInTicket,
  getEventOrders:           exports.getEventOrders,
  getEventAnalytics:        exports.getEventAnalytics,
  getOrganizerDashboard:    exports.getOrganizerDashboard,
  createEventPromoCode:     exports.createEventPromoCode,
  validateEventPromoCode:   exports.validateEventPromoCode,
  autoEndEvents:            exports.autoEndEvents,
};
