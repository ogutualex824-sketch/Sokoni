/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — PARCEL REQUEST AUTHORITY  (Send a Parcel, Delivery Hub D5)
   functions/parcel-requests.js
   ══════════════════════════════════════════════════════════════════════════════
   WHAT THIS REPLACES

   delivery.html priced a parcel in the browser (a VEHICLES table copied into two
   files), wrote root `deliveries` from the browser (refused by the served rules
   since DL-02 — "Send a Parcel" has created 0 documents), charged M-Pesa with no
   server record, and stored the proof PIN in plaintext on a document the rider
   could read. Nothing it wrote could ever reach a rider: the board
   (availableDeliveries) refuses any job the server did not create.

   THE RAIL (owner decision 2026-09-29, D5): parcels run on `packageRequests` +
   the existing rider machinery (board, claim, presence). This module is the ONLY
   writer of a parcel job. Money is a SERVER record (`parcelRequests`, no client
   rule → default deny), the job doc (`packageRequests/PRC…`) is what the sender
   and the assigned rider read, exactly the orders + paymentIntents split the
   marketplace uses. rider-presence.validateJob() has a parcel branch that
   validates a board entry against the server record — a browser-written
   `kind:'parcel'` doc is refused there, not merely hidden.

   PAYMENT — ALL IntaSend methods, server-initiated, server-verified.
     · mpesa    → IntaSend STK push (api_ref = parcelId)
     · checkout → IntaSend hosted checkout URL: M-Pesa, card, bank, Airtel
                  (api_ref = parcelId, redirect back to delivery.html)
   The browser never reports "paid". confirmParcelPayment asks IntaSend's
   collection API, requires api_ref === parcelId, currency KES, state COMPLETE and
   amount ≥ fee, and claims the invoice with create() so a replay cannot pay twice.
   The recorded `method` is IntaSend's provider (mpesa | card | … | unknown); the
   sender's route is kept separately as `channel` ('stk' | 'checkout').

   PRICING — the catalogue below carries the browser's figures VERBATIM so the
   move to the server changes the architecture, not anyone's price. The owner
   directed on 2026-09-30 that the parcel flow work end-to-end with these prices,
   which is recorded here as the approval. Every quote and job records its
   catalogue version; a later change never restates a past job.

   NOT IN THIS SLICE (recorded on the record, never faked): automatic rider
   payout for parcels (`riderPayoutState: 'pending_manual'` — FinOS pays riders
   off ORDERS today), multi-stop, scheduled dispatch, sender/rider messaging.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const crypto = require('crypto');

const CATALOGUES = Object.freeze({
  'parcel-2026-09-30': Object.freeze({
    version: 'parcel-2026-09-30',
    approved: true,
    approvedBy: 'owner directive 2026-09-30 (parcel rail go-live)',
    approvedAt: '2026-09-30',
    source: 'delivery-hub.js VEHICLES / WEIGHT_SURCHARGE / URGENCY_MULT, verbatim',
    currency: 'KES',
    vehicles: Object.freeze({
      boda:    { label: 'Boda Boda',       icon: '🏍️', base: 150,  perKm: 35,  maxKm: 25,  capacity: 'Up to 5 kg',      eta: '15–40 min'  },
      bicycle: { label: 'Bicycle Courier', icon: '🚲', base: 100,  perKm: 20,  maxKm: 10,  capacity: 'Up to 3 kg',      eta: '20–50 min'  },
      car:     { label: 'Car / Saloon',    icon: '🚗', base: 400,  perKm: 60,  maxKm: 80,  capacity: 'Up to 50 kg',     eta: '20–60 min'  },
      pickup:  { label: 'Pickup (1T)',     icon: '🛻', base: 1500, perKm: 90,  maxKm: 200, capacity: 'Up to 1 tonne',   eta: '30–90 min'  },
      van:     { label: 'Van / Canter',    icon: '🚐', base: 2500, perKm: 110, maxKm: 300, capacity: 'Up to 3 tonnes',  eta: '45–120 min' },
      truck:   { label: 'Lorry (5T+)',     icon: '🚛', base: 5000, perKm: 150, maxKm: 500, capacity: '5+ tonnes',       eta: '1–4 hrs'    },
      ref:     { label: 'Refrigerated',    icon: '🧊', base: 3000, perKm: 130, maxKm: 300, capacity: 'Perishables',     eta: '30–90 min'  },
      flatbed: { label: 'Flatbed',         icon: '🚚', base: 6000, perKm: 170, maxKm: 500, capacity: 'Oversized cargo', eta: '1–5 hrs'    },
    }),
    weightSurcharge:   Object.freeze({ light: 0, medium: 0.1, heavy: 0.25, bulk: 0.4 }),
    urgencyMultiplier: Object.freeze({ standard: 1, express: 1.3, urgent: 1.6 }),
  }),
});
const ACTIVE_VERSION  = 'parcel-2026-09-30';
const QUOTE_TTL_MS    = 15 * 60 * 1000;
const MAX_DISTANCE_KM = 500;
const MIN_DISTANCE_KM = 0.5;
const PIN_MAX_ATTEMPTS = 5;
const JOB_PREFIX = 'PRC';

const KE_PHONE = /^(?:0[17]\d{8}|254[17]\d{8}|\+254[17]\d{8})$/;

function activeCatalogue() { return CATALOGUES[ACTIVE_VERSION]; }
function catalogueFor(v) { return CATALOGUES[String(v || '')] || null; }

/** Public, rider-safe view of the rate card (labels + prices; no internals). */
function publicCatalogue(cat) {
  const c = cat || activeCatalogue();
  return {
    version: c.version, approved: c.approved, currency: c.currency,
    vehicles: c.vehicles, weightSurcharge: c.weightSurcharge, urgencyMultiplier: c.urgencyMultiplier,
  };
}

function _haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371, toR = (d) => d * Math.PI / 180;
  const dLat = toR(bLat - aLat), dLng = toR(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function _validLatLng(p) {
  if (!p || typeof p !== 'object') return null;
  const lat = Number(p.lat), lng = Number(p.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/**
 * Price a parcel. PURE. Same arithmetic the browser used (base + km·perKm, then the
 * load surcharge on that, then the urgency multiplier on the sum), rounded the same way.
 * Throws {code, message} — the callable maps it to an HttpsError.
 */
function quote({ vehicleType, distanceKm, weight, urgency }, version) {
  const cat = version ? catalogueFor(version) : activeCatalogue();
  if (!cat) throw _err('failed-precondition', 'Unknown pricing version.');
  const v = cat.vehicles[String(vehicleType || '')];
  if (!v) throw _err('invalid-argument', 'Choose a vehicle type. Valid: ' + Object.keys(cat.vehicles).join(', ') + '.');
  const km = Math.round(Number(distanceKm) * 10) / 10;
  if (!Number.isFinite(km) || km < MIN_DISTANCE_KM) throw _err('invalid-argument', 'Enter the distance in km (at least 0.5).');
  if (km > MAX_DISTANCE_KM) throw _err('invalid-argument', 'That distance is beyond any courier service.');
  if (km > v.maxKm) throw _err('failed-precondition', v.label + ' max range is ' + v.maxKm + ' km. Choose a larger vehicle.');
  const w = String(weight || 'light'), u = String(urgency || 'standard');
  if (!(w in cat.weightSurcharge)) throw _err('invalid-argument', 'Unknown package weight class.');
  if (!(u in cat.urgencyMultiplier)) throw _err('invalid-argument', 'Unknown urgency.');
  const base      = v.base;
  const kmCharge  = Math.round(km * v.perKm);
  const weightFee = Math.round((base + kmCharge) * cat.weightSurcharge[w]);
  const mult      = cat.urgencyMultiplier[u];
  const urgencyFee = Math.round((base + kmCharge + weightFee) * (mult - 1));
  const total     = Math.round((base + kmCharge + weightFee) * mult);
  return {
    catalogueVersion: cat.version, currency: cat.currency,
    vehicleType: String(vehicleType), vehicleLabel: v.label, distanceKm: km, weight: w, urgency: u,
    base, kmCharge, weightFee, urgencyFee, total, eta: v.eta,
  };
}

function _err(code, message) { const e = new Error(message); e.code = code; return e; }
function _pin6() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }
function _samePin(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function _str(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 200); }
function _phone(v) {
  const p = _str(v, 20).replace(/\s/g, '');
  if (!p) return '';
  if (!KE_PHONE.test(p)) throw _err('invalid-argument', 'Phone numbers must be valid Kenyan numbers (07XX / 01XX / 254…).');
  return p.replace(/^\+/, '').replace(/^0/, '254');
}
/** Coarse area for the rider board: the text before the first comma, never the full line. */
function _areaOf(address) {
  const a = _str(address, 200);
  if (!a) return null;
  const first = a.split(/[,\-–]/)[0].trim();
  return first ? first.slice(0, 40) : null;
}

/* ── Recipient must hold a SOKONI account (owner 2026-09-30): the parcel is tracked by both
   ends in-app, and the recipient reads the job through the served rules' buyerUid grant. ── */
function _phoneSpellings(p254) {
  const local = '0' + p254.slice(3);
  return Array.from(new Set([p254, '+' + p254, local, local.replace(/^0/, '0')]));
}
async function resolveRecipient(admin, db, phone254) {
  try { const u = await admin.auth().getUserByPhoneNumber('+' + phone254); if (u && u.uid) return { uid: u.uid, name: u.displayName || '' }; } catch (_) {}
  const spellings = _phoneSpellings(phone254);
  for (const field of ['phone', 'phoneNumber']) {
    try {
      const q = await db.collection('users').where(field, 'in', spellings).limit(1).get();
      if (!q.empty) { const d = q.docs[0].data() || {}; return { uid: d.uid || q.docs[0].id, name: d.name || d.displayName || '' }; }
    } catch (_) {}
  }
  return null;
}

/* ── IntaSend transport (injectable for tests) ──────────────────────────────── */
function _defaultTransport() {
  return async function intasend(method, path, body, key) {
    const host = process.env.INTASEND_SANDBOX === 'true' ? 'https://sandbox.intasend.com' : 'https://payment.intasend.com';
    const res = await fetch(host + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null; try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, data };
  };
}

/* ── Payment METHOD from the PROVIDER (IntaSend convergence Gate 12, 2026-10-03) ───────────
   The method a parcel was paid with is what IntaSend's collection record reports, never the
   route the sender picked in the UI ('checkout' is a channel; the card or M-Pesa behind it is the
   method). The five mapping lines below are COPIED from 5aa7711 (functions/index.js:2792-2796,
   verifyIntasendPayment) — byte-identical apart from indentation; their sha256 (whitespace-
   trimmed lines joined by LF) is pinned in scripts/test-parcel-payment-gate15.js and compared
   against `git show 5aa7711:functions/index.js`. Change them in both places or neither.
   `payment` is IntaSend's record. An absent provider is 'unknown' — never assumed. */
function _methodFromProvider(payment) {
  payment = payment || {};
  const _providerRaw = String(payment.provider || payment.method || "").trim().toUpperCase();
  const _paymentMethod = _providerRaw === "M-PESA" || _providerRaw === "MPESA" ? "mpesa"
    : _providerRaw === "CARD-PAYMENT" || _providerRaw === "CARD" ? "card"
    : _providerRaw ? _providerRaw.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32) || "unknown"
    : "unknown";
  return { method: _paymentMethod, providerRaw: _providerRaw || null };
}

/* The sender's INITIATION ROUTE — kept, but as `channel`, never as the method.
   payParcelRequest's 'mpesa' route is an STK push; 'checkout' is IntaSend hosted checkout. */
function _channelOf(pay) {
  const p = pay || {};
  if (p.channel === 'stk' || p.channel === 'checkout') return p.channel;
  return p.method === 'mpesa' ? 'stk' : p.method === 'checkout' ? 'checkout' : null;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   FACTORY
   ═══════════════════════════════════════════════════════════════════════════════ */
function makeParcelRequests(deps) {
  const { onCall, HttpsError, admin, db, INTASEND_PRIVATE_KEY, transport, now } = deps;
  const _now = now || (() => Date.now());
  const _transport = transport || _defaultTransport();
  const FV = admin.firestore.FieldValue;
  const TS = admin.firestore.Timestamp;
  const wrap = (fn) => async (request) => {
    try { return await fn(request); }
    catch (e) {
      if (e instanceof HttpsError) throw e;
      if (e && e.code && typeof e.code === 'string' && /^[a-z-]+$/.test(e.code)) throw new HttpsError(e.code, e.message);
      console.error('[parcel-requests]', e);
      throw new HttpsError('internal', 'Something went wrong. Please try again.');
    }
  };
  const _uid = (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in to continue.');
    return uid;
  };
  const _isAdmin = (request) => !!(request.auth && request.auth.token && request.auth.token.admin === true);
  const _key = () => {
    const k = INTASEND_PRIVATE_KEY && INTASEND_PRIVATE_KEY.value ? INTASEND_PRIVATE_KEY.value() : process.env.INTASEND_PRIVATE_KEY;
    if (!k) throw new HttpsError('failed-precondition', 'Payment gateway not configured.');
    return k;
  };

  /* ── 1. getParcelQuote ───────────────────────────────────────────────────────
     "Just check pricing" for anyone; a CLAIMABLE quote (parcelQuotes/{id}) only for a
     signed-in sender. Distance: when both coordinates are present the SERVER computes
     it (haversine × 1.3 road factor, the same estimator the browser used) and the
     declared figure is ignored; otherwise the declared distance is used, bounded. */
  const getParcelQuote = onCall({ region: 'us-central1', timeoutSeconds: 15, memory: '256MiB', invoker: 'public' }, wrap(async (request) => {
    const d = request.data || {};
    const cat = activeCatalogue();
    if (d.catalogueOnly) return { ok: true, catalogue: publicCatalogue(cat) };
    /* OWNER RULE (2026-09-30): coordinates are REQUIRED for a price. The distance is computed
       here from validated pickup + drop-off points; a typed distance is never read. Missing or
       invalid coordinates → `quote_unavailable` (a stated unknown, never an invented figure), and
       nothing is written. A quote has no side effect: no job, no charge, no rider, no debt. */
    const p = _validLatLng(d.pickup), q = _validLatLng(d.dropoff);
    if (!p || !q) {
      return { ok: false, state: 'quote_unavailable', reason: !p && !q ? 'coordinates_required' : (!p ? 'pickup_coordinates_required' : 'dropoff_coordinates_required'), catalogue: publicCatalogue(cat) };
    }
    const distanceKm = Math.max(MIN_DISTANCE_KM, Math.round(_haversineKm(p.lat, p.lng, q.lat, q.lng) * 1.3 * 10) / 10);
    const distanceSource = 'server_coords';
    const qt = quote({ vehicleType: d.vehicleType, distanceKm, weight: d.weight, urgency: d.urgency });
    const uid = request.auth && request.auth.uid;
    let quoteId = null, expiresAt = null;
    /* preview:true = "just checking the price" — the owner rule says a price check creates
       nothing, signed in or not. Only a booking-form quote is stored (claimable, 15 min). */
    if (uid && !d.preview) {
      const ref = db.collection('parcelQuotes').doc();
      quoteId = ref.id;
      expiresAt = _now() + QUOTE_TTL_MS;
      await ref.set({
        uid, status: 'issued', quote: qt, distanceSource,
        pickup: p, dropoff: q,
        expiresAt: TS.fromMillis(expiresAt), createdAt: FV.serverTimestamp(),
      });
    }
    return { ok: true, quoteId, expiresAt, distanceSource, quote: qt, catalogue: publicCatalogue(cat) };
  }));

  /* ── 2. createParcelRequest ──────────────────────────────────────────────────
     Claims the quote in a transaction (issued → claimed, same uid, unexpired), writes
     the server money record and the job doc as pending_payment. Returns the PIN once. */
  const createParcelRequest = onCall({ region: 'us-central1', timeoutSeconds: 30, memory: '256MiB', invoker: 'public' }, wrap(async (request) => {
    const uid = _uid(request);
    const d = request.data || {};
    const quoteId = _str(d.quoteId, 64);
    if (!quoteId) throw new HttpsError('invalid-argument', 'Get a price first.');
    const pickupAddress   = _str(d.pickupAddress, 200);
    const deliveryAddress = _str(d.deliveryAddress, 200);
    if (!pickupAddress || !deliveryAddress) throw new HttpsError('invalid-argument', 'Pickup and drop-off addresses are required.');
    const recipientName  = _str(d.recipientName, 80);
    const recipientPhone = _phone(d.recipientPhone);
    if (!recipientPhone) throw new HttpsError('invalid-argument', 'Recipient phone is required so the rider can reach them.');
    const senderPhone = _phone(d.senderPhone);
    const senderName  = _str(d.senderName, 80);
    const packageType = _str(d.packageType, 40) || 'parcel';
    const notes       = _str(d.notes, 500);
    const scheduledAt = d.scheduledTime ? new Date(String(d.scheduledTime)) : null;
    if (scheduledAt && isNaN(scheduledAt.getTime())) throw new HttpsError('invalid-argument', 'Invalid scheduled time.');
    const pickupCoords  = _validLatLng(d.pickupCoords);
    const dropoffCoords = _validLatLng(d.deliveryCoords);
    /* Same rule as the quote: a parcel job needs both validated points. The quote already had
       them; the request must present the same facts or it is refused, never guessed. */
    if (!pickupCoords || !dropoffCoords) throw new HttpsError('failed-precondition', 'Pickup and drop-off locations are required (choose them on the map or use your location).');
    const recipient = await (deps.resolveRecipient || resolveRecipient)(admin, db, recipientPhone);
    if (!recipient || !recipient.uid) {
      throw new HttpsError('failed-precondition', 'The recipient must have a SOKONI account. Ask them to sign up with ' + recipientPhone.replace(/^254/, '0') + ', then try again.');
    }

    const pin = _pin6();
    const parcelRef = db.collection('parcelRequests').doc();
    const parcelId  = parcelRef.id;
    const jobId     = JOB_PREFIX + parcelId;
    const jobRef    = db.collection('packageRequests').doc(jobId);
    const quoteRef  = db.collection('parcelQuotes').doc(quoteId);

    let qt;
    await db.runTransaction(async (t) => {
      const qs = await t.get(quoteRef);
      if (!qs.exists) throw new HttpsError('not-found', 'That price has expired. Get a new one.');
      const qd = qs.data() || {};
      if (qd.uid !== uid) throw new HttpsError('permission-denied', 'That price is not yours.');
      if (qd.status !== 'issued') throw new HttpsError('failed-precondition', 'That price was already used.');
      const exp = qd.expiresAt && qd.expiresAt.toMillis ? qd.expiresAt.toMillis() : 0;
      if (!exp || exp < _now()) throw new HttpsError('failed-precondition', 'That price has expired. Get a new one.');
      qt = qd.quote;
      t.update(quoteRef, { status: 'claimed', parcelId, claimedAt: FV.serverTimestamp() });
      /* F1-R (preserved): the authoritative pickup for ANY job is the server-only
         deliveryPickups/{deliveryRef} record, which the board, dispatch and navigation read
         through pickup-location.authoritativePickups(). A merchant job snapshots the shop's
         point; a parcel snapshots the sender's validated point. create(): first fact wins. */
      t.create(db.collection('deliveryPickups').doc(jobId), {
        deliveryRef: jobId, lat: pickupCoords.lat, lng: pickupCoords.lng,
        label: _areaOf(pickupAddress) || null, source: 'parcel_sender', parcelId, capturedAt: FV.serverTimestamp(),
      });
      t.set(parcelRef, {
        uid, quoteId, jobId, kind: 'parcel', recipientUid: recipient.uid,
        catalogueVersion: qt.catalogueVersion, currency: qt.currency,
        deliveryFee: qt.total, breakdown: qt,
        vehicleType: qt.vehicleType, distanceKm: qt.distanceKm, weight: qt.weight, urgency: qt.urgency,
        status: 'pending_payment',
        payment: { state: 'unpaid', method: null, invoiceId: null, checkoutId: null, trackingId: null, paidAmount: null, paidAt: null },
        pin, pinAttempts: 0,
        riderId: null, riderPayoutState: 'pending_manual',
        createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(),
      });
      t.set(jobRef, {
        kind: 'parcel', parcelId, deliveryRef: jobId,
        uid, senderUid: uid, senderName, senderPhone,
        /* buyerUid = the recipient: the served packageRequests rules grant read to buyerUid, so
           the recipient can track without a rules change. It is the SAME meaning — the person
           the parcel is delivered to. */
        recipientUid: recipient.uid, buyerUid: recipient.uid,
        pickupAddress, pickupLat: pickupCoords ? pickupCoords.lat : null, pickupLng: pickupCoords ? pickupCoords.lng : null,
        pickupArea: _areaOf(pickupAddress),
        deliveryAddress, deliveryLat: dropoffCoords ? dropoffCoords.lat : null, deliveryLng: dropoffCoords ? dropoffCoords.lng : null,
        deliveryAddressParts: { area: _areaOf(deliveryAddress) },
        recipientName: recipientName || recipient.name || '', recipientPhone, packageType, weight: qt.weight, urgency: qt.urgency, notes,
        scheduledAt: scheduledAt ? TS.fromDate(scheduledAt) : null,
        vehicleType: qt.vehicleType, distanceKm: qt.distanceKm, speed: qt.urgency,
        deliveryFee: qt.total, currency: qt.currency, catalogueVersion: qt.catalogueVersion,
        paymentState: 'unpaid', status: 'pending_payment',
        riderId: null, assignedDriverId: null, assignedRiderId: null,
        timeline: [{ status: 'pending_payment', at: new Date().toISOString(), by: 'server' }],
        createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(),
      });
    });
    return { ok: true, parcelId, deliveryRef: jobId, recipientUid: recipient.uid, deliveryFee: qt.total, distanceKm: qt.distanceKm, currency: qt.currency, proofPIN: pin, status: 'pending_payment' };
  }));

  /* ── 3. payParcelRequest — server-initiated IntaSend payment, any method ─────
     mpesa    → STK push to the sender's phone (M-PESA).
     checkout → hosted checkout URL offering every method IntaSend enables on the
                account (M-Pesa, card, bank transfer, Airtel Money). */
  const payParcelRequest = onCall({ region: 'us-central1', timeoutSeconds: 30, memory: '256MiB', invoker: 'public', secrets: INTASEND_PRIVATE_KEY ? [INTASEND_PRIVATE_KEY] : [] }, wrap(async (request) => {
    const uid = _uid(request);
    const d = request.data || {};
    const parcelId = _str(d.parcelId, 64);
    const method = _str(d.method, 20) || 'mpesa';
    if (!parcelId) throw new HttpsError('invalid-argument', 'parcelId required.');
    if (method !== 'mpesa' && method !== 'checkout') throw new HttpsError('invalid-argument', 'method must be mpesa or checkout.');
    const ref = db.collection('parcelRequests').doc(parcelId);
    const s = await ref.get();
    if (!s.exists) throw new HttpsError('not-found', 'Parcel not found.');
    const p = s.data() || {};
    if (p.uid !== uid) throw new HttpsError('permission-denied', 'Not your parcel.');
    if ((p.payment || {}).state === 'paid') return { ok: true, state: 'paid', alreadyPaid: true };
    if (p.status !== 'pending_payment') throw new HttpsError('failed-precondition', 'This parcel is not awaiting payment.');
    const amount = Number(p.deliveryFee);
    if (!Number.isFinite(amount) || amount <= 0) throw new HttpsError('failed-precondition', 'This parcel has no server price.');
    const key = _key();
    const narrative = 'SOKONI Parcel ' + p.jobId + ' KES ' + amount;

    if (method === 'mpesa') {
      const phone = _phone(d.phone);
      if (!phone) throw new HttpsError('invalid-argument', 'Enter the M-PESA phone number.');
      const r = await _transport('POST', '/api/v1/payment/mpesa-stk-push/', { method: 'M-PESA', phone_number: phone, amount, currency: 'KES', narrative, api_ref: parcelId }, key);
      if (r.status !== 200 && r.status !== 201) {
        console.error('[payParcelRequest] STK rejected', { status: r.status, body: r.data, parcelId, amount });
        throw new HttpsError('internal', (r.data && r.data.detail) || 'M-PESA prompt failed. Try again.');
      }
      const inv = (r.data && r.data.invoice) || {};
      const invoiceId = inv.invoice_id || null, checkoutId = r.data && (r.data.id || r.data.checkout_id) || null;
      await ref.update({ payment: { state: 'pending', method: 'mpesa', channel: 'stk', invoiceId, checkoutId, trackingId: null, phone, paidAmount: null, paidAt: null, initiatedAt: FV.serverTimestamp() }, updatedAt: FV.serverTimestamp() });
      return { ok: true, state: 'pending', method: 'mpesa', invoiceId, checkoutId };
    }

    /* Hosted checkout — every enabled method. redirect_url brings the sender back to the
       parcel page, which then asks the SERVER to confirm; the redirect itself proves nothing. */
    const email = _str(d.email, 120);
    const r = await _transport('POST', '/api/v1/checkout/', {
      amount, currency: 'KES', api_ref: parcelId, comment: narrative,
      redirect_url: 'https://mysokoni.co.ke/delivery.html?paid=' + encodeURIComponent(parcelId),
      email: email || undefined, phone_number: p.senderPhone || undefined,
    }, key);
    if ((r.status !== 200 && r.status !== 201) || !(r.data && r.data.url)) {
      console.error('[payParcelRequest] checkout rejected', { status: r.status, body: r.data, parcelId, amount });
      throw new HttpsError('internal', (r.data && r.data.detail) || 'Could not open the payment page. Try again.');
    }
    await ref.update({ payment: { state: 'pending', method: 'checkout', channel: 'checkout', invoiceId: null, checkoutId: r.data.id || null, trackingId: null, checkoutUrl: r.data.url, paidAmount: null, paidAt: null, initiatedAt: FV.serverTimestamp() }, updatedAt: FV.serverTimestamp() });
    return { ok: true, state: 'pending', method: 'checkout', checkoutId: r.data.id || null, url: r.data.url };
  }));

  /* ── 4. confirmParcelPayment — the ONLY thing that marks a parcel paid ────────
     Asks IntaSend. api_ref must equal the parcelId (the link the server itself set),
     state COMPLETE, value ≥ fee. The invoice is claimed with create(): a second
     confirmation of the same invoice is a no-op, and one invoice can pay one parcel. */
  const confirmParcelPayment = onCall({ region: 'us-central1', timeoutSeconds: 30, memory: '256MiB', invoker: 'public', secrets: INTASEND_PRIVATE_KEY ? [INTASEND_PRIVATE_KEY] : [] }, wrap(async (request) => {
    const uid = _uid(request);
    const d = request.data || {};
    const parcelId = _str(d.parcelId, 64);
    if (!parcelId) throw new HttpsError('invalid-argument', 'parcelId required.');
    const ref = db.collection('parcelRequests').doc(parcelId);
    const s = await ref.get();
    if (!s.exists) throw new HttpsError('not-found', 'Parcel not found.');
    const p = s.data() || {};
    if (p.uid !== uid && !_isAdmin(request)) throw new HttpsError('permission-denied', 'Not your parcel.');
    const pay = p.payment || {};
    if (pay.state === 'paid') return { ok: true, state: 'paid', alreadyPaid: true };
    const fee = Number(p.deliveryFee);
    const key = _key();

    /* Look the payment up by whatever handle we hold; match on api_ref regardless. */
    const handle = _str(d.trackingId, 80) || pay.invoiceId || pay.trackingId || null;
    const path = handle
      ? '/api/v1/payment/collection/?invoice_id=' + encodeURIComponent(handle)
      : '/api/v1/payment/collection/?api_ref=' + encodeURIComponent(parcelId);
    const r = await _transport('GET', path, null, key);
    if (r.status !== 200 || !r.data) throw new HttpsError('unavailable', 'Could not reach the payment gateway. Try again shortly.');
    const results = r.data.results || (Array.isArray(r.data) ? r.data : [r.data]);
    const rec = results.find((x) => x && String(x.api_ref || '') === parcelId && (!handle || x.invoice_id === handle || x.tracking_id === handle || x.checkout_id === handle))
             || results.find((x) => x && String(x.api_ref || '') === parcelId);
    if (!rec) return { ok: false, state: 'not_found' };
    /* WRONG_CURRENCY (Gate 15, 2026-10-03): the fee is KES; a record in another currency — or one
       that does not state its currency — cannot be compared with it. Refused BEFORE any write. */
    const currency = String(rec.currency == null ? '' : rec.currency).trim().toUpperCase();
    if (currency !== 'KES') {
      console.error('[confirmParcelPayment] wrong currency', { parcelId, currency: currency || null });
      throw new HttpsError('failed-precondition', 'This payment is not in KES. Contact support.');
    }
    const state = String(rec.state || '').toUpperCase();
    if (state !== 'COMPLETE') {
      const failed = ['FAILED', 'CANCELLED', 'EXPIRED', 'REJECTED', 'TIMEOUT'].includes(state);
      if (failed && pay.state !== 'failed') await ref.update({ 'payment.state': 'failed', 'payment.failedState': state, updatedAt: FV.serverTimestamp() });
      return { ok: false, state: failed ? 'failed' : 'pending', gatewayState: state, failedReason: rec.failed_reason || null };
    }
    const paid = Number(rec.value || rec.amount || rec.net_amount || 0);
    if (!Number.isFinite(paid) || paid + 0.005 < fee) {
      console.error('[confirmParcelPayment] amount short', { parcelId, fee, paid });
      throw new HttpsError('failed-precondition', 'The amount paid does not cover this parcel. Contact support.');
    }
    const invoiceId = String(rec.invoice_id || rec.tracking_id || rec.id || handle || parcelId);
    const { method } = _methodFromProvider(rec);   // Gate 12: what IntaSend says, never the UI route
    const channel = _channelOf(pay);               // the route the sender chose: 'stk' | 'checkout'
    const claimRef = db.collection('parcelPayments').doc(invoiceId);
    const jobRef = db.collection('packageRequests').doc(p.jobId || (JOB_PREFIX + parcelId));
    await db.runTransaction(async (t) => {
      const [cs, ps] = await Promise.all([t.get(claimRef), t.get(ref)]);
      const cur = ps.data() || {};
      if ((cur.payment || {}).state === 'paid') return;
      if (cs.exists && (cs.data() || {}).parcelId !== parcelId) throw new HttpsError('failed-precondition', 'That payment already paid for a different parcel.');
      if (!cs.exists) t.create(claimRef, { parcelId, uid: cur.uid, invoiceId, apiRef: parcelId, amount: paid, currency, method, channel, mpesaReference: rec.mpesa_reference || null, gateway: 'intasend', claimedAt: FV.serverTimestamp() });
      t.update(ref, {
        status: 'awaiting_rider',
        payment: Object.assign({}, cur.payment || {}, { state: 'paid', method, channel, invoiceId, trackingId: rec.tracking_id || null, paidAmount: paid, paidAt: FV.serverTimestamp(), mpesaReference: rec.mpesa_reference || null, provider: rec.provider || null }),
        updatedAt: FV.serverTimestamp(),
      });
      t.set(jobRef, {
        status: 'awaiting_rider', paymentState: 'paid', paidAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp(),
        /* In-app receipt (owner 2026-09-30): what was paid, how, when, under which gateway
           reference — on the record BOTH ends can read. Never a phone, never the PIN. */
        receipt: { receiptNo: invoiceId, amount: paid, currency: cur.currency || 'KES', method, channel,
                   provider: rec.provider || null, mpesaReference: rec.mpesa_reference || null, gateway: 'intasend',
                   paidAt: FV.serverTimestamp(), breakdown: cur.breakdown || null, catalogueVersion: cur.catalogueVersion || null },
        timeline: FV.arrayUnion({ status: 'awaiting_rider', at: new Date().toISOString(), by: 'server' }),
      }, { merge: true });
    });
    return { ok: true, state: 'paid', amount: paid, receipt: { receiptNo: invoiceId, amount: paid, method, channel, mpesaReference: rec.mpesa_reference || null, paidAt: new Date().toISOString() } };
  }));

  /* ── 5. getMyParcelPin — the sender re-reads the PIN (server record, owner only) ── */
  const getMyParcelPin = onCall({ region: 'us-central1', timeoutSeconds: 10, memory: '256MiB', invoker: 'public' }, wrap(async (request) => {
    const uid = _uid(request);
    const parcelId = _str((request.data || {}).parcelId, 64);
    const s = await db.collection('parcelRequests').doc(parcelId).get();
    const p = s.exists ? (s.data() || {}) : null;
    if (!p || (p.uid !== uid && p.recipientUid !== uid)) throw new HttpsError('not-found', 'Parcel not found.');
    return { ok: true, proofPIN: p.pin, role: p.uid === uid ? 'sender' : 'recipient' };
  }));

  /* ── 6. completeParcelWithPin — the assigned rider closes the job with the sender's PIN ── */
  const completeParcelWithPin = onCall({ region: 'us-central1', timeoutSeconds: 30, memory: '256MiB', invoker: 'public' }, wrap(async (request) => {
    const uid = _uid(request);
    const d = request.data || {};
    const deliveryRef = _str(d.deliveryRef, 80);
    const pin = _str(d.pin, 8);
    if (!deliveryRef) throw new HttpsError('invalid-argument', 'deliveryRef required.');
    if (!/^\d{4,8}$/.test(pin)) throw new HttpsError('invalid-argument', 'Enter the delivery PIN from the sender or recipient.');
    const jobRef = db.collection('packageRequests').doc(deliveryRef);
    let out;
    await db.runTransaction(async (t) => {
      const js = await t.get(jobRef);
      if (!js.exists) throw new HttpsError('not-found', 'Delivery not found.');
      const j = js.data() || {};
      if (j.kind !== 'parcel' || !j.parcelId) throw new HttpsError('failed-precondition', 'Not a parcel job. Use the order delivery PIN flow.');
      if (j.assignedDriverId !== uid && j.riderId !== uid) throw new HttpsError('permission-denied', 'This delivery is not assigned to you.');
      if (['delivered', 'completed'].includes(j.status)) { out = { ok: true, alreadyDelivered: true }; return; }
      const pRef = db.collection('parcelRequests').doc(j.parcelId);
      const ps = await t.get(pRef);
      const p = ps.data() || {};
      if ((p.pinAttempts || 0) >= PIN_MAX_ATTEMPTS) throw new HttpsError('resource-exhausted', 'Too many wrong PINs. Ask support to unlock this delivery.');
      if (!_samePin(p.pin, pin)) {
        t.update(pRef, { pinAttempts: FV.increment(1), updatedAt: FV.serverTimestamp() });
        out = { ok: false, wrongPin: true };
        return;
      }
      const nowTs = FV.serverTimestamp();
      t.update(jobRef, { status: 'delivered', deliveredAt: nowTs, updatedAt: nowTs, timeline: FV.arrayUnion({ status: 'delivered', at: new Date().toISOString(), by: uid }) });
      t.update(pRef, { status: 'delivered', deliveredAt: nowTs, deliveredBy: uid, updatedAt: nowTs });
      out = { ok: true };
    });
    if (out && out.wrongPin) throw new HttpsError('permission-denied', 'Wrong PIN. Ask the customer to read it again.');
    return out;
  }));

  return { getParcelQuote, createParcelRequest, payParcelRequest, confirmParcelPayment, getMyParcelPin, completeParcelWithPin };
}

module.exports = {
  makeParcelRequests,
  quote, publicCatalogue, activeCatalogue, catalogueFor,
  CATALOGUES, ACTIVE_VERSION, QUOTE_TTL_MS, JOB_PREFIX, PIN_MAX_ATTEMPTS,
  resolveRecipient,
  _internal: { _haversineKm, _validLatLng, _areaOf, _phone, _samePin, _phoneSpellings, _methodFromProvider, _channelOf },
};
