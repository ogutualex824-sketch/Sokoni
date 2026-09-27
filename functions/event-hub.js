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

/* An organizer is an account holding the `event_organizer` CUSTOM CLAIM — minted only by the
   canonical approval authority (applicationDecide → application-lifecycle → role-authority
   claimsFor), after the organizer agreements are accepted, and revoked (false) on suspension.
   2026-09-27 (Entertainment readiness sweep): this used to read users.roles[] / users.role from
   Firestore on the belief that the rules blocked clients from writing them. They did not — `roles`
   is client-writable (sign-up writes ['buyer'], driver onboarding arrayUnions 'driver') — so ANY
   signed-in user could write roles:['event_organizer'] and create, publish and sell tickets with no
   approval and no agreements. The Auth record is read (not the caller's token) so a suspension
   takes effect immediately rather than at the next token refresh. */
async function requireOrganizer(uid) {
  const u = await auth().getUser(uid).catch(() => null);
  const claims = (u && u.customClaims) || {};
  if (claims.event_organizer !== true) throw new HttpsError('permission-denied', 'Organizer role required — apply to become an event organizer.');
  return claims;
}

/* Legacy numeric `role` claim (>= 4 = admin) OR the canonical boolean admin claims (admin-claim.js).
   `role < 4` was the check everywhere, and a STRING role makes `'superAdmin' < 4` false — i.e. the
   guard FAILED OPEN for any string role. The numeric branch now requires an actual number. */
function _isAdminCaller(req, role) {
  return (typeof role === 'number' && role >= 4) || require('./admin-claim').isAdmin(req);
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
  /* Owning a draft is not enough: a suspended / de-roled organizer cannot put it on sale. */
  await requireOrganizer(uid);
  if (ev.status === 'live') throw new HttpsError('failed-precondition', 'Already live');
  /* Buyers must know the refund terms before they can buy (event-refunds.js setPolicy). */
  if (!ev.refundPolicy || !ev.refundPolicy.mode) throw new HttpsError('failed-precondition', 'Set the event refund policy before publishing');
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
  /* Platform admins hold boolean claims (admin-claim.js); the numeric role >= 4 is legacy and
     is minted by nothing, so it alone locked every real admin out of cancelling an event. */
  const isAdmin = _isAdminCaller(req, role);
  if (!isOwner && !isAdmin) throw new HttpsError('permission-denied', 'Not authorised');
  if (ev.status === 'cancelled') throw new HttpsError('failed-precondition', 'Already cancelled');
  /* 2026-09-27: an organizer could cancel AFTER the event (and after being paid): every refund then
     came out of SOKONI's funds (refund_after_release). Once the event has started, cancellation is an
     administrator's decision (AdminOS), taken with the settlement exceptions in view. */
  if (!isAdmin && ev.startDate && new Date(ev.startDate).getTime() <= Date.now()) {
    throw new HttpsError('failed-precondition', 'This event has already started. Contact SOKONI support to cancel it.');
  }

  /* The event flips FIRST, in a transaction: two concurrent cancels cannot both proceed, and from
     this moment settlement release refuses (releaseOne checks the event status). */
  await db().runTransaction(async (txn) => {
    const cur = await txn.get(ref);
    if (cur.data().status === 'cancelled') throw new HttpsError('failed-precondition', 'Already cancelled');
    txn.update(ref, {
      status: 'cancelled',
      cancelledAt: FieldValue.serverTimestamp(),
      cancellationReason: sanitize(reason, 500),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  // Mark all paid orders for refund processing — in chunks: a single batch holds at most 500
  // writes, so one batch made a large event impossible to cancel at all.
  const ordersSnap = await db().collection('eventOrders')
    .where('eventId', '==', eventId)
    .where('status', '==', 'paid')
    .get();
  for (let i = 0; i < ordersSnap.docs.length; i += 400) {
    const batch = db().batch();
    ordersSnap.docs.slice(i, i + 400).forEach((doc) => {
      batch.update(doc.ref, { status: 'pending_refund', cancelledAt: FieldValue.serverTimestamp() });
    });
    await batch.commit(); // eslint-disable-line no-await-in-loop
  }

  /* Tell each online buyer. Best effort (a failed notice never undoes a cancellation), one per
     order via dedupeKey. Cashier-sold orders have no reachable buyer account — the organizer
     handles those at the door. */
  const { notify } = require('./notify');
  const buyers = ordersSnap.docs.map((d) => d.data()).filter((o) => o.buyerUid && o.channel !== 'cashier');
  for (let i = 0; i < buyers.length; i += 25) {
    await Promise.all(buyers.slice(i, i + 25).map((o) => notify({ // eslint-disable-line no-await-in-loop
      uid: o.buyerUid, type: 'event_cancelled', title: 'Event cancelled',
      body: `${ev.title || 'An event you booked'} has been cancelled. Your order is queued for a refund to your original payment method.`,
      dedupeKey: `evt_cancel:${o.orderId || eventId}`, data: { eventId, orderId: o.orderId || null },
    }).catch(() => null)));
  }
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
      if (!_isAdminCaller(req, role)) throw new HttpsError('not-found', 'Event not found');
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
      saleStartsAt: t.saleStartsAt || null,
      maxPerBuyer: t.maxPerBuyer || null,
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
  const { eventId, name, price, quantity, description, perks, saleEndsAt, sortOrder, saleStartsAt, maxPerBuyer } = req.data;

  if (!eventId || !name || price == null || !quantity) {
    throw new HttpsError('invalid-argument', 'eventId, name, price, quantity required');
  }

  const evSnap = await db().collection('events').doc(eventId).get();
  if (!evSnap.exists) throw new HttpsError('not-found', 'Event not found');
  const ev = evSnap.data();
  if (ev.organizerUid !== uid) throw new HttpsError('permission-denied', 'Not event owner');
  if (ev.status === 'cancelled') throw new HttpsError('failed-precondition', 'Event is cancelled');

  const parsedPrice = Number(price);
  /* Whole shillings only (2026-09-27): M-PESA collects whole shillings, so a fractional price made the
     settled gross differ from what was actually collected. NaN / Infinity were accepted too. */
  if (!Number.isFinite(parsedPrice) || !Number.isInteger(parsedPrice)) throw new HttpsError('invalid-argument', 'Price must be a whole number of shillings');
  if (parsedPrice < 0) throw new HttpsError('invalid-argument', 'Price cannot be negative');
  const parsedQty = parseInt(quantity, 10);
  if (parsedQty < 1) throw new HttpsError('invalid-argument', 'Quantity must be at least 1');

  const _maxPer = maxPerBuyer == null || maxPerBuyer === '' ? null : parseInt(maxPerBuyer, 10);
  if (_maxPer != null && !(_maxPer >= 1 && _maxPer <= 20)) throw new HttpsError('invalid-argument', 'Maximum per buyer must be 1-20');
  const _start = saleStartsAt ? new Date(saleStartsAt) : null;
  const _end = saleEndsAt ? new Date(saleEndsAt) : null;
  if ((_start && isNaN(_start)) || (_end && isNaN(_end))) throw new HttpsError('invalid-argument', 'Invalid sale window');
  if (_start && _end && _end <= _start) throw new HttpsError('invalid-argument', 'Sales must end after they start');

  const ref = db().collection('eventTicketTiers').doc();
  /* Capacity is enforced in a TRANSACTION: two tiers created at once must not each see the old
     total and together exceed the venue's capacity. */
  await db().runTransaction(async (txn) => {
    const [evNow, tiersNow] = await Promise.all([
      txn.get(db().collection('events').doc(eventId)),
      txn.get(db().collection('eventTicketTiers').where('eventId', '==', eventId)),
    ]);
    const cap = evNow.data().capacity;
    const allocated = tiersNow.docs.reduce((a, d) => a + (d.data().isActive === false ? 0 : Number(d.data().quantity) || 0), 0);
    if (cap && allocated + parsedQty > cap) {
      throw new HttpsError('failed-precondition', `Ticket quantities would exceed the event capacity (${cap}); ${Math.max(0, cap - allocated)} left to allocate.`);
    }
    /* Admission PINs are 4 digits and never recycled within an event, so an event may configure at
       most EVENT_PIN_CEILING tickets across ALL its tiers (inactive ones too — their tickets keep
       their PINs). Refused here, at configuration, so a PAID order never meets an exhausted space. */
    const PIN_CEILING = require('./event-ops').EVENT_PIN_CEILING;
    const everConfigured = tiersNow.docs.reduce((a, d) => a + (Number(d.data().quantity) || 0), 0);
    if (everConfigured + parsedQty > PIN_CEILING) {
      throw new HttpsError('failed-precondition', `An event can sell at most ${PIN_CEILING.toLocaleString()} tickets (4-digit admission PINs); ${Math.max(0, PIN_CEILING - everConfigured).toLocaleString()} left to configure.`);
    }
    txn.set(ref, {
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
    saleEndsAt: _end ? _end.toISOString() : null,
    saleStartsAt: _start ? _start.toISOString() : null,
    maxPerBuyer: _maxPer,
    sortOrder: parseInt(sortOrder, 10) || 0,
    isActive: true,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    });
    txn.update(db().collection('events').doc(eventId), {
      ticketTiersCount: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  return { tierId: ref.id };
});

/* ──────────────────────────────────────────────────────────────────────
   9. updateTicketTier — Edit tier details (price/qty before sales only)
   ────────────────────────────────────────────────────────────────────── */
exports.updateTicketTier = onCall(CF_OPTS, async (req) => {
  const uid = requireAuth(req);
  const { tierId, name, description, perks, saleEndsAt, isActive, sortOrder, saleStartsAt, maxPerBuyer } = req.data;
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
  if (saleStartsAt !== undefined) updates.saleStartsAt = saleStartsAt ? new Date(saleStartsAt).toISOString() : null;
  if (maxPerBuyer !== undefined) {
    const m = maxPerBuyer == null || maxPerBuyer === '' ? null : parseInt(maxPerBuyer, 10);
    if (m != null && !(m >= 1 && m <= 20)) throw new HttpsError('invalid-argument', 'Maximum per buyer must be 1-20');
    updates.maxPerBuyer = m;
  }

  await ref.update(updates);
  return { ok: true };
});

/* ──────────────────────────────────────────────────────────────────────
   10. purchaseTickets — Atomic ticket purchase (idempotent)
   ────────────────────────────────────────────────────────────────────── */
/* SOKONI_HMAC_KEY: a free / fully-discounted order is issued its ticket PINs right here. */
exports.purchaseTickets = onCall({ ...CF_OPTS, secrets: [require('./event-ops').SOKONI_HMAC_KEY] }, async (req) => {
  const uid = requireAuth(req);
  const { tierId, quantity, promoCode, idempotencyKey, attendeeName, attendeeEmail } = req.data;

  if (!tierId || !quantity || !idempotencyKey) {
    throw new HttpsError('invalid-argument', 'tierId, quantity, idempotencyKey required');
  }

  const qty = parseInt(quantity, 10);
  if (qty < 1 || qty > 20) throw new HttpsError('invalid-argument', 'Quantity 1-20');

  // Idempotency ref — checked INSIDE the transaction (see below) to prevent TOCTOU races
  /* Namespaced by the buyer (2026-09-27): a global key let one buyer's replay return ANOTHER buyer's
     orderId. The key is also bounded so it is always a valid document id. */
  const _ik = String(idempotencyKey);
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(_ik)) throw new HttpsError('invalid-argument', 'idempotencyKey must be 4–128 letters, digits, _ or -');
  const idemRef = db().collection('eventOrderIdempotency').doc(`${uid}__${_ik}`);

  const tierRef = db().collection('eventTicketTiers').doc(tierId);
  const tierSnap = await tierRef.get();
  if (!tierSnap.exists) throw new HttpsError('not-found', 'Ticket tier not found');
  const tier = tierSnap.data();

  if (!tier.isActive) throw new HttpsError('failed-precondition', 'This tier is no longer available');
  if (tier.saleEndsAt && new Date(tier.saleEndsAt) < new Date()) {
    throw new HttpsError('failed-precondition', 'Ticket sales for this tier have ended');
  }
  if (tier.saleStartsAt && new Date(tier.saleStartsAt) > new Date()) {
    throw new HttpsError('failed-precondition', 'Ticket sales for this tier have not started');
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
          discountAmount = Math.round((tier.price * qty * promo.discountValue) / 100);
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
    /* Event capacity and the per-buyer limit, read INSIDE the transaction so concurrent checkouts
       cannot each pass a stale count. Unpaid orders count while they hold seats. */
    const freshEv = await t.get(db().collection('events').doc(tier.eventId));
    const cap = freshEv.data().capacity;
    if (cap && (Number(freshEv.data().totalTicketsSold) || 0) + qty > cap) {
      throw new HttpsError('resource-exhausted', 'This event is at capacity');
    }
    /* Promo usage is re-checked HERE (2026-09-27): maxUses was only checked before the transaction, so
       concurrent checkouts could each redeem the last use. Read phase, before any write. */
    if (promoCodeId) {
      const ps = await t.get(db().collection('eventPromoCodes').doc(promoCodeId));
      const p = ps.exists ? ps.data() : null;
      if (!p || p.isActive !== true || (p.maxUses && (Number(p.uses) || 0) >= p.maxUses) || (p.expiresAt && new Date(p.expiresAt) <= new Date())) {
        throw new HttpsError('failed-precondition', 'This promo code is no longer available. Remove it and try again.');
      }
    }
    if (td.maxPerBuyer) {
      const mine = await t.get(db().collection('eventOrders').where('buyerUid', '==', uid).where('tierId', '==', tierId));
      const held = mine.docs.reduce((a, d) => a + (['paid', 'pending_payment'].includes(d.data().status) ? Number(d.data().quantity) || 0 : 0), 0);
      if (held + qty > td.maxPerBuyer) {
        throw new HttpsError('resource-exhausted', `At most ${td.maxPerBuyer} ticket(s) of this type per buyer`);
      }
    }

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
      /* Nothing to collect (a free tier, or a promo covering the whole order) = paid now.
         Previously a 100 % promo left a PAID-tier order at pending_payment for ever: there
         was no amount to take and no path that could complete it. */
      status: totalAmount <= 0 ? 'paid' : 'pending_payment',
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
  const tokens = [];
  const _free = totalAmount <= 0;
  const OPS = require('./event-ops');
  const _writeTickets = (writer, ids) => {
    for (let i = 0; i < qty; i++) {
      const ticketRef = db().collection('eventTickets').doc();
      const token = genTicketToken();
      tokens.push(token);
      writer.set(ticketRef, {
        /* Paid tickets get their PIN at payment activation; nothing to pay = issued now. */
        ...(_free ? OPS.issueCredentials(writer, { eventId: tier.eventId, ticketId: ticketRef.id, buyerUid: uid, identity: ids[i] }) : {}),
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
        status: _free ? 'valid' : 'awaiting_payment',
        checkedIn: false,
        checkedInAt: null,
        checkedInBy: null,
        seatNumber: null,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
  };
  if (_free) {
    /* Free tickets are credentials NOW: their 4-digit PINs + ticket numbers are chosen by reading the
       index inside this transaction (event-ops.allocateIdentities), never create()-and-hope. */
    await db().runTransaction(async (txn) => {
      tokens.length = 0;
      const ids = await OPS.allocateIdentities(txn, tier.eventId, qty);
      _writeTickets(txn, ids);
    });
  } else {
    const ticketBatch = db().batch();
    _writeTickets(ticketBatch, []);
    await ticketBatch.commit();
  }
  /* Free / fully-discounted: issued now, so confirm now (no PIN in the notice; best effort). */
  if (_free) await require('./event-settlement').notifyTicketsConfirmed(orderId);

  return {
    orderId,
    totalAmount,
    currency: tier.currency,
    status: totalAmount <= 0 ? 'paid' : 'pending_payment',
    ticketCount: qty,
    /* The next step for a payable order: createPaymentIntent({ purpose: 'event_ticket',
       orderId }) — the server prices THIS order; the client never sends an amount. */
    payment: totalAmount <= 0 ? null : { purpose: 'event_ticket', orderId },
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

  /* The admission PIN (event-ops) lives in eventTicketSecrets — no client rule, deny by default.
     It is returned ONLY here, to the ticket's own buyer, and only while the ticket is valid. */
  const _valid = tickets.filter((t) => t.status === 'valid' && t.buyerUid === uid);
  const _secretSnaps = await Promise.all(_valid.map((t) => db().collection('eventTicketSecrets').doc(t.ticketId).get()));
  const pins = {};
  _secretSnaps.forEach((s2) => { if (s2.exists && s2.data().buyerUid === uid) pins[s2.id] = s2.data().pin; });

  // Enrich with event details
  const eventIds = [...new Set(tickets.map(t => t.eventId))];
  const eventSnaps = await Promise.all(eventIds.map(id => db().collection('events').doc(id).get()));
  const eventMap = {};
  eventSnaps.forEach(s => { if (s.exists) eventMap[s.id] = s.data(); });
  /* Ticket display: the tier price, the PIN lifetime state, and the FISCAL state derived from the
     eTIMS invoice (event-fiscal) — genuine KRA values only, never a SOKONI stand-in. */
  const tierIds = [...new Set(tickets.map((t) => t.tierId).filter(Boolean))];
  const tierSnaps = await Promise.all(tierIds.map((id) => db().collection('eventTicketTiers').doc(id).get()));
  const tierPrice = {};
  tierSnaps.forEach((s3) => { if (s3.exists) tierPrice[s3.id] = Number(s3.data().price); });
  const FISCAL = require('./event-fiscal');
  const fiscal = await FISCAL.viewsFor(tickets.map(FISCAL.keyOfTicket));
  const OPS = require('./event-ops');
  const nowMs = Date.now();

  return {
    tickets: tickets.map(t => ({
      ticketId: t.ticketId,
      orderId: t.orderId,
      eventId: t.eventId,
      tierId: t.tierId,
      tierName: t.tierName,
      qrData: t.status === 'valid' ? t.qrData : null,
      ticketNumber: t.ticketNumber || null,
      pin: pins[t.ticketId] || null,
      admissionStatus: t.admissionStatus || null,
      refundStatus: t.refundStatus || null,
      pinState: t.pinHash && eventMap[t.eventId] ? OPS.pinState(t, eventMap[t.eventId], nowMs) : null,
      priceKes: Number.isFinite(tierPrice[t.tierId]) ? tierPrice[t.tierId] : null,
      /* no payment and no sale = a free ticket: nothing was sold, so nothing is fiscalised */
      fiscal: FISCAL.keyOfTicket(t) ? (fiscal[FISCAL.keyOfTicket(t)] || FISCAL.view(null)) : { ...FISCAL.view(null), reason: tierPrice[t.tierId] === 0 ? 'FREE_TICKET' : 'NO_FISCAL_RECORD' },
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
  if (ticket.buyerUid !== uid && !isOrganizer && !_isAdminCaller(req, role)) {
    throw new HttpsError('permission-denied', 'Access denied');
  }

  /* The QR token and the PIN hash are admission credentials. The organizer and admins see the
     ticket, never the credential — only the buyer gets the token (for the optional QR). */
  const { token, qrData, pinHash, ...safe } = ticket;
  const isBuyer = ticket.buyerUid === uid;
  return {
    ...safe,
    ...(isBuyer && ticket.status === 'valid' ? { token, qrData } : {}),
    event: ev ? { title: ev.title, startDate: ev.startDate, venue: ev.venue, city: ev.city } : null,
  };
});

/* ──────────────────────────────────────────────────────────────────────
   13. checkInTicket — Gate staff: validate QR and mark used
   ────────────────────────────────────────────────────────────────────── */
exports.checkInTicket = onCall(CF_OPTS, async (req) => {
  /* OPTIONAL QR path. The canonical credential is the ticket PIN (event-ops eventAdmitTicket);
     this stays for organizers who scan. It used to compare the token with !==, read-then-batch
     (two gates could both admit one ticket), and allow only the organizer. It now:
       · authorizes through the SAME event-scoped actor resolver as PIN admission (ADMIT),
       · compares in constant time,
       · admits in a transaction with the SAME create-only eventAdmissions/{ticketId} record. */
  const uid = requireAuth(req);
  const { ticketId, token } = req.data || {};
  if (!ticketId || !token) throw new HttpsError('invalid-argument', 'ticketId and token required');
  const ticketRef = db().collection('eventTickets').doc(String(ticketId));
  const pre = await ticketRef.get();
  if (!pre.exists) throw new HttpsError('not-found', 'Ticket not found');
  const OPS = require('./event-ops');
  const actor = await OPS.resolveEventActor(req, pre.data().eventId, OPS.CAPS.ADMIT);
  const a = Buffer.from(String(pre.data().token || ''));
  const b = Buffer.from(String(token));
  if (a.length === 0 || a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpsError('invalid-argument', 'Invalid ticket token');
  const admRef = db().collection('eventAdmissions').doc(String(ticketId));
  const out = await db().runTransaction(async (txn) => {
    const evRef = db().collection('events').doc(String(pre.data().eventId));
    const [ts, as, evs] = await Promise.all([txn.get(ticketRef), txn.get(admRef), txn.get(evRef)]);
    const t = ts.data();
    if (as.exists || t.admissionStatus === 'ADMITTED' || t.checkedIn) return { result: 'already_used', checkedInAt: t.checkedInAt || null, checkedInBy: t.checkedInBy || null, ticketId };
    /* The SAME lifetime as PIN admission (event-ops.pinState): refunded / void / cancelled / outside
       the admission window are refused here too — the QR is never a way around the PIN rules. */
    const why = OPS.admissibleReason(t, evs.exists ? evs.data() : actor.event, Date.now());
    if (why) return { result: 'invalid', reason: why, ticketId };
    txn.create(admRef, { ticketId, eventId: t.eventId, admittedBy: uid, admittedRole: actor.role, method: 'qr', admittedAt: FieldValue.serverTimestamp() });
    txn.update(ticketRef, { admissionStatus: 'ADMITTED', admittedAt: FieldValue.serverTimestamp(), admittedBy: uid,
      checkedIn: true, checkedInAt: FieldValue.serverTimestamp(), checkedInBy: uid });
    txn.set(db().collection('eventCheckins').doc(), { ticketId, eventId: t.eventId, buyerUid: t.buyerUid || null,
      checkedInBy: uid, checkedInAt: FieldValue.serverTimestamp(), tierName: t.tierName || null, method: 'qr' });
    txn.update(db().collection('events').doc(t.eventId), { checkinsCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() });
    return { result: 'success', ticketId, attendeeName: t.attendeeName, tierName: t.tierName };
  });
  /* Admission settles the ticket (owner decision 2026-09-27) — the QR path settles exactly like the PIN path. */
  if (out && out.result === 'success') await require('./event-settlement').releaseTicketShare(ticketId, { actorUid: uid });
  return out;
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
  if (ev.organizerUid !== uid && !_isAdminCaller(req, role)) throw new HttpsError('permission-denied', 'Not authorized');

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
  if (ev.organizerUid !== uid && !_isAdminCaller(req, role)) throw new HttpsError('permission-denied', 'Not authorized');

  const [tiersSnap, ordersSnap] = await Promise.all([
    db().collection('eventTicketTiers').where('eventId', '==', eventId).get(),
    db().collection('eventOrders')
      .where('eventId', '==', eventId)
      .where('status', '==', 'paid')
      .get(),
  ]);

  const orders = ordersSnap.docs.map(d => d.data());
  const tiers = tiersSnap.docs.map(d => d.data());

  /* Money from eventSettlements (every paid channel, incl. cash/card door sales, and the SETTLED
     commission net of provider fee) — not the order's purchase-time quote. Capped → unknown. */
  const _st = await db().collection('eventSettlements').where('eventId', '==', eventId).limit(5000).get();
  const _paid = _st.docs.map((d) => d.data()).filter((x) => x.status !== 'REFUNDED');
  const _cap = _st.size >= 5000;
  const _unknownFee = _paid.some((x) => x.status === 'FEE_UNREPORTED');
  const totalRevenue = _cap ? null : _paid.reduce((a, x) => a + (Number(x.grossCents) || 0), 0) / 100;
  const platformFees = (_cap || _unknownFee) ? null : _paid.reduce((a, x) => a + (Number(x.commissionCents) || 0), 0) / 100;
  const organizerRevenue = (_cap || _unknownFee) ? null : _paid.reduce((a, x) => a + (Number(x.organizerNetCents) || 0), 0) / 100;
  const totalTickets = _cap ? null : _paid.reduce((a, x) => a + (Number(x.quantity) || 0), 0);
  void orders;
  const checkins = ev.checkinsCount || 0;
  const checkInRate = totalTickets ? Math.round((checkins / totalTickets) * 100) : (totalTickets === 0 ? 0 : null);

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

  /* Revenue and tickets sold come from eventSettlements — the canonical record of PAID tickets across
     every channel (online, cashier, cash, card). `events.totalRevenue` was initialised to 0 and never
     written, so the dashboard always showed KES 0; `totalTicketsSold` counts seats HELD by unpaid
     orders too. A capped read reports null (the UI shows "—"), never a partial sum. */
  const _setSnap = await db().collection('eventSettlements').where('organizerUid', '==', uid).limit(5000).get();
  const _paid = _setSnap.docs.map((d) => d.data()).filter((x) => x.status !== 'REFUNDED');
  const _capped = _setSnap.size >= 5000;
  const _byEvent = {};
  _paid.forEach((x) => { const b = (_byEvent[x.eventId] = _byEvent[x.eventId] || { grossCents: 0, tickets: 0 }); b.grossCents += Number(x.grossCents) || 0; b.tickets += Number(x.quantity) || 0; });
  const totalRevenue = _capped ? null : _paid.reduce((s, x) => s + (Number(x.grossCents) || 0), 0) / 100;
  const totalTicketsSold = _capped ? null : _paid.reduce((s, x) => s + (Number(x.quantity) || 0), 0);
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
      totalTicketsSold: _capped ? null : ((_byEvent[e.eventId] || {}).tickets || 0),
      seatsHeld: e.totalTicketsSold || 0,
      totalRevenue: _capped ? null : (((_byEvent[e.eventId] || {}).grossCents || 0) / 100),
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

  /* Organizer, or event-scoped MARKETING staff (event-ops) — never another event's staff. */
  const _ops = require('./event-ops');
  await _ops.resolveEventActor(req, eventId, _ops.CAPS.MARKETING);
  void uid;

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
  /* An event ends at its END time (endDate; startDate only when no end is set). This used to end
     every event the hour it STARTED — which would stop door sales and PIN admission mid-event. */
  const now = new Date().toISOString();
  const snap = await db().collection('events')
    .where('status', '==', 'live')
    .where('startDate', '<', now)
    .limit(200)
    .get();

  const due = snap.docs.filter((doc) => { const e = doc.data(); return String(e.endDate || e.startDate) < now; });
  if (!due.length) return;

  const batch = db().batch();
  due.forEach(doc => {
    batch.update(doc.ref, {
      status: 'ended',
      endedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  await batch.commit();
  console.log(`[autoEndEvents] Ended ${due.length} events`);
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
  _internal:                { genTicketToken, requireOrganizer, VALID_CATEGORIES },
};
