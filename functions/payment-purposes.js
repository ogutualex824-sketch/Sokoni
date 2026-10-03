'use strict';
/**
 * SOKONI Payment Purpose Registry — server-side pricing for every paid capability.
 *
 * createPaymentIntent could only mint `purpose: 'subscription'`. Every other
 * paid domain therefore had no intent, which is why none of them could be swept
 * by the reconciler and why the digital-download adapter had nothing to fire on.
 * One hardcoded field was the bottleneck behind four non-compliant domains.
 *
 * The property that must survive generalisation is the one that makes the
 * subscription path safe: THE SERVER DERIVES THE PRICE. A pricer receives the
 * caller's uid and the client's request, reads the authoritative figure from
 * Firestore, and returns it. No pricer may read an amount from the request —
 * that is the whole reason this file exists rather than a `purpose` parameter
 * being passed through to the provider.
 *
 * Adding a paid feature = one entry here + one entitlement adapter. No change
 * to createPaymentIntent, the webhook, the reconciler or the engine.
 *
 * Related: functions/entitlement-engine.js · functions/entitlement-adapters.js
 */

const { getFirestore, FieldPath } = require('firebase-admin/firestore');
const { HttpsError }   = require('firebase-functions/v2/https');

const db = () => getFirestore();

/* Provider floor/ceiling. Mirrors the subscription path so no purpose can mint
   an intent the provider will refuse, or a zero-value intent that would grant an
   entitlement for nothing. */
const MIN_KES = 1;
const MAX_KES = 150000;

const fail = (code, msg, details) => { throw new HttpsError(code, msg, details); };   /* details carry a machine code (U5) */

/* ── Canonical marketplace line validation ──────────────────────────────────
   The SINGLE source of item-price / availability / stock truth, shared by
   product_order (single-shop payment) and the multi-shop checkout quote so the
   two cannot fork. Returns SERVER-authoritative lines + subtotal read from the
   product documents — NEVER a client price — and applies NO settlement policy:
   the caller decides that (product_order enforces one seller; the multi-shop
   quote partitions). Extracted verbatim from product_order.price. */
async function validateOrderLines(uid, items) {
  items = Array.isArray(items) ? items : [];
  if (!items.length) fail('invalid-argument', 'Cart is empty.');
  if (items.length > 100) fail('invalid-argument', 'Too many line items.');

  const ids = [...new Set(items
    .map((i) => String((i && (i.productId || i.id)) || '').trim())
    .filter(Boolean))];
  if (!ids.length) fail('invalid-argument', 'No valid products in cart.');

  /* Catalogue read. Firestore caps documentId() `in` queries, so chunk. */
  const prods = {};
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10);
    const snap = await db().collection('products')
      .where(FieldPath.documentId(), 'in', chunk).get();
    snap.forEach((d) => { prods[d.id] = d.data() || {}; });
  }
  /* PACKAGES / BUNDLES (universal catalogue U5, 2026-09-29): a package's components come from the package's OWN
     document, read here by the server — never from the request. They are read now so every stock check below sees
     them; selling the package takes THEIR stock (functions/shared/package-stock.js). */
  const PS = require('./shared/package-stock');
  const compProds = {};
  const compIds = [...new Set(Object.values(prods).filter(PS.isComposite)
    .reduce((a, p) => a.concat(PS.componentsForLine(p).map((c) => c.productId)), []))];
  for (let i = 0; i < compIds.length; i += 10) {
    const chunk = compIds.slice(i, i + 10);
    const snap = await db().collection('products').where(FieldPath.documentId(), 'in', chunk).get();
    snap.forEach((d) => { compProds[d.id] = d.data() || {}; });
  }

  /* Shop state for availability — fail OPEN on read error, matching
     createCheckoutSession: availability is a merchant convenience, not a
     security control, and the PRICE is what this function protects. */
  const sellerUids = [...new Set(Object.values(prods)
    .map((p) => p.sellerUid).filter(Boolean))];
  const shopState = {};
  try {
    for (let i = 0; i < sellerUids.length; i += 10) {
      const chunk = sellerUids.slice(i, i + 10);
      const snap = await db().collection('shopState')
        .where(FieldPath.documentId(), 'in', chunk).get();
      snap.forEach((d) => { shopState[d.id] = d.data() || {}; });
    }
  } catch (_) { /* default open */ }

  const avail = require('./availability-enforce');
  const lines = [];
  let subtotal = 0;
  /* An AGREED buyer offer (functions/product-offers.js) is the only thing that can change a line's unit price, and it
     is read HERE from productOffers — never from the request. A line naming an offer that is not this buyer's, not
     accepted, expired, used, or over its quantity is REFUSED (never silently re-priced). 2026-09-29. */
  const priceLine = await require('./product-offers').offerResolver(db(), uid, items, Date.now());

  for (const raw of items) {
    const pid = String((raw && (raw.productId || raw.id)) || '').trim();
    const prod = prods[pid];
    /* An item missing from the catalogue is REJECTED, not skipped: the buyer is
       about to be charged, so silently dropping a line would charge a total for a
       different cart than the one they saw. */
    if (!prod) fail('failed-precondition', `Product ${pid} is no longer available.`);
    if (!avail.itemAvailability(prod, shopState[prod.sellerUid]).available)
      fail('failed-precondition', `${prod.name || pid} is not currently available.`);

    const stockQty = prod.stock !== undefined ? Number(prod.stock) : null;
    if (prod.outOfStock === true || (stockQty !== null && stockQty <= 0))
      fail('failed-precondition', `${prod.name || pid} is out of stock.`);

    const qty = Math.max(1, Math.min(99, Math.round(Number(raw.qty) || 1)));
    if (stockQty !== null && qty > stockQty)
      fail('failed-precondition',
        `Only ${stockQty} of ${prod.name || pid} remain. Please update your cart.`);

    const catalogueUnit = Number(prod.salePrice || prod.price || 0);
    if (!(catalogueUnit > 0)) fail('failed-precondition', `${prod.name || pid} has no price.`);
    const { unitPrice, offerId } = priceLine(raw, pid, qty, catalogueUnit);

    subtotal += unitPrice * qty;
    const components = PS.componentsForLine(prod);   /* null unless this is a package / bundle */
    /* shopId: the product's canonical owner — the key the merchant's offers (shopOffers.shopId) and the till use (U7c2) */
    lines.push(Object.assign({ productId: pid, qty, unitPrice, sellerUid: prod.sellerUid || null, shopId: prod.shopId || prod.sellerUid || null },
      offerId ? { offerId, listUnitPrice: catalogueUnit } : {}, components ? { components } : {}));
  }

  /* U5: the whole cart against the shelf, ONCE — a Meal Deal and a loose Soda ask for the soda together. Every
     component must be the package's own shop's live product, not itself a package, and in stock for the total. */
  const lineSeller = {};
  lines.forEach((l) => { lineSeller[l.productId] = l.sellerUid; });
  for (const e of PS.expandLines(lines)) {
    if (!e.viaPackage) {
      const p = prods[e.productId];
      const st = PS.stockOf(p);
      if (p && st !== null && e.qty > st) fail('failed-precondition', `Only ${st} of ${p.name || e.productId} remain. Please update your cart.`);
      continue;
    }
    const pkgName = (prods[e.viaPackage] && prods[e.viaPackage].name) || 'This package';
    const c = compProds[e.productId] || prods[e.productId];
    if (!c) fail('failed-precondition', `${pkgName} is not available — one of its items no longer exists.`, { code: 'PACKAGE_COMPONENT_MISSING' });
    if ((c.sellerUid || c.shopId || null) !== (lineSeller[e.viaPackage] || null)) fail('failed-precondition', `${pkgName} is not available.`, { code: 'PACKAGE_COMPONENT_FOREIGN' });
    if (PS.isComposite(c)) fail('failed-precondition', `${pkgName} is not available.`, { code: 'PACKAGE_NESTED' });
    if (!avail.itemAvailability(c, shopState[c.sellerUid]).available || c.outOfStock === true)
      fail('failed-precondition', `${pkgName} is not available right now — ${c.name || 'an item in it'} is not.`, { code: 'PACKAGE_COMPONENT_UNAVAILABLE' });
    const cs = PS.stockOf(c);
    if (cs !== null && e.qty > cs) fail('failed-precondition', `${pkgName}: only ${cs} of ${c.name || 'an item in it'} left.`, { code: 'PACKAGE_COMPONENT_STOCK' });
  }

  return { lines, subtotal };
}

/**
 * Each pricer: async (uid, data) → {
 *   amountCents, currency, resourceType, resourceId, metadata
 * }
 * Throws HttpsError when the resource is missing, not payable, or not the
 * caller's to pay for.
 */
const PURPOSES = {

  /* ── Creator Hub film access ──────────────────────────────────────────
     Price, currency and rental window come from the PUBLISHED film document
     (entertainmentListings, creatorHub:true). The pricer lives with the rest
     of the Creator rules; this entry is the registry binding. The intent
     deliberately carries NO sellerUid — film money accrues to the royalty
     ledger, never to a seller wallet (docs/CREATOR_HUB.md §Payment). */
  film_access: {
    resourceType: 'film',
    price: (uid, data) => require('./creator-hub').priceFilmAccess(uid, data),
  },

  /* ── Digital downloads ────────────────────────────────────────────────
     Price comes from digitalProducts, never from the purchase record and
     never from the client — a purchase row is created before payment and a
     buyer must not be able to influence what it costs. */
  digital_download: {
    resourceType: 'digitalPurchase',
    async price(uid, data) {
      const purchaseId = String(data.purchaseId || '').trim();
      if (!purchaseId) fail('invalid-argument', 'purchaseId is required.');

      const pSnap = await db().collection('digitalPurchases').doc(purchaseId).get();
      if (!pSnap.exists) fail('not-found', 'Purchase not found.');
      const purchase = pSnap.data();

      if (purchase.buyerUid !== uid) fail('permission-denied', 'Not your purchase.');
      if (purchase.status === 'completed') fail('already-exists', 'This purchase is already complete.');

      const prodSnap = await db().collection('digitalProducts').doc(String(purchase.productId)).get();
      if (!prodSnap.exists) fail('not-found', 'Product no longer available.');
      const product = prodSnap.data();
      if (product.isActive === false) fail('failed-precondition', 'Product is no longer for sale.');

      const cents = Math.round(Number(product.price) * 100);
      if (!Number.isFinite(cents) || cents <= 0) fail('failed-precondition', 'Product has no payable price.');

      return {
        amountCents: cents,
        currency: product.currency || 'KES',
        resourceType: 'digitalPurchase',
        resourceId: purchaseId,
        metadata: { productId: purchase.productId, sellerUid: purchase.sellerUid, title: product.title || null },
      };
    },
  },

  /* ── Event tickets ────────────────────────────────────────────────────
     Priced from the event-hub ORDER, never from the request. purchaseTickets
     (event-hub.js) reserves inventory and writes eventOrders/{orderId} with the
     server-computed total inside one transaction; this pricer only proves the
     order is the caller's, still unpaid, and payable, and quotes its total.
     The previous pricer read an `ev.ticketTiers` ARRAY and accepted statuses
     published/active/on_sale — event-hub stores tiers in eventTicketTiers and
     marks events 'live', so it refused every real event and nothing called it.
     The order id is the payment reference (preferredRef): one order, one
     payment identity, so a retried checkout reuses it instead of minting a
     second intent for the same seats. */
  event_ticket: {
    resourceType: 'eventOrder',
    async price(uid, data) {
      const orderId = String(data.orderId || '').trim();
      if (!/^[A-Za-z0-9_-]{6,128}$/.test(orderId)) fail('invalid-argument', 'orderId is required.');
      const oSnap = await db().collection('eventOrders').doc(orderId).get();
      if (!oSnap.exists) fail('not-found', 'Order not found.');
      const o = oSnap.data();
      if (o.buyerUid !== uid) fail('permission-denied', 'This order belongs to another account.');
      if (o.status !== 'pending_payment') fail('failed-precondition', `Order is ${o.status || 'unknown'}, not awaiting payment.`);
      const cents = Math.round(Number(o.totalAmount) * 100);
      if (!Number.isFinite(cents) || cents <= 0) fail('failed-precondition', 'Order has no payable total.');

      const eSnap = await db().collection('events').doc(String(o.eventId || '')).get();
      if (!eSnap.exists) fail('not-found', 'Event not found.');
      const ev = eSnap.data();
      if (ev.status !== 'live') fail('failed-precondition', 'Tickets are not on sale for this event.');
      if (!ev.organizerUid) fail('failed-precondition', 'Event has no organizer to settle to.');

      return {
        amountCents: cents,
        currency: o.currency || ev.currency || 'KES',
        resourceType: 'eventOrder',
        resourceId: orderId,
        preferredRef: orderId,
        metadata: {
          type: 'event_ticket', eventId: o.eventId, tierId: o.tierId || null,
          quantity: Number(o.quantity) || 0, organizerUid: ev.organizerUid,
        },
      };
    },
  },

  /* ── Service booking (Phase E) ────────────────────────────────────────
     The amount is the IMMUTABLE snapshot D3 stamped on the booking at creation
     (price + fee, both cents) — never the current providerServices record and
     never the client. `deposit` is the forfeitable PORTION of that price, not an
     extra charge. The intent's resourceId (bookingId) becomes the authoritative
     link the webhook trusts instead of client metadata. */
  /* Venue bookings (owner decision 2026-09-27): priced from the booking's SERVER total by
     venue-payments.priceVenueBooking; self-settling (settled on the buyer's show-up). */
  /* ── Accepted RFQ quote → a NORMAL SOKONI order (owner 2026-10-03; contract agreed with sokoni-f3 / sokoni-5b) ──
     Priced ONLY from the server-held snapshot rfqs/{rfqId}.acceptedQuote written by rfqDispatch accept — never the client.
     Payer must be the RFQ's buyer (createdBy, individual buyer), status accepted + checkout pending. ONE live intent per
     (rfq, quote version): the deterministic ref makes a retry return the same intent and refuses a changed amount.
     Self-settling here: the webhook hook (sokoni-5b) creates the ONE order, HOLDS the money and settles to the supplier's
     business wallet through the one settlement path; the generic credit path never pays anyone at payment time.
     commissionCategory is stamped on the rfq by the SERVER at accept: a materials label (marketplace 15%) or
     construction_service (0%). VAT is exactly as declared on the quote (vatBasis 'declared_on_quote'). */
  rfq_quote: {
    resourceType: 'rfqQuote',
    async price(uid, data) {
      const rfqId = String(data.rfqId || '').trim();
      if (!/^[A-Za-z0-9_-]{4,128}$/.test(rfqId)) fail('invalid-argument', 'rfqId is required.');
      const s = await db().collection('rfqs').doc(rfqId).get();
      if (!s.exists) fail('not-found', 'Quote request not found.');
      const r = s.data() || {};
      if (r.createdBy !== uid) fail('permission-denied', 'Only the buyer who requested this quote can pay it.');
      if (r.buyerType !== 'individual') fail('failed-precondition', 'Business buyers pay through their purchase order.');
      if (r.status !== 'accepted' || r.checkout !== 'pending') fail('failed-precondition', 'This quote is not awaiting payment.');
      const q = r.acceptedQuote || {};
      const kes = (v) => Math.round(Number(v) * 100) / 100;
      const lines = Array.isArray(q.lines) ? q.lines : [];
      const sub = kes(lines.reduce((t, l) => t + Number(l.lineTotalKES || 0), 0));
      const vatRate = Number(q.vatRate);
      if (!lines.length || !(sub > 0) || kes(q.subtotalKES) !== sub) fail('failed-precondition', 'The accepted quote is inconsistent. Ask the supplier to re-quote.');
      if (![0, 16].includes(vatRate) || Math.abs(kes(q.vatKES) - kes(sub * vatRate / 100)) > 0.01) fail('failed-precondition', 'The quote VAT is inconsistent. Ask the supplier to re-quote.');
      const total = kes(sub + kes(q.vatKES) + kes(q.deliveryFeeKES || 0));
      if (kes(q.totalKES) !== total || !(total >= 1)) fail('failed-precondition', 'The quote total is inconsistent. Ask the supplier to re-quote.');
      const ALLOWED = ['building-materials', 'construction_service'];
      const cat = String(r.commissionCategory || '');
      if (!ALLOWED.includes(cat)) fail('failed-precondition', 'This quote has no commission category on record.');
      const bizId = String(q.supplierBusinessId || '');
      const b = bizId ? await db().collection('businesses').doc(bizId).get() : null;
      const payee = b && b.exists ? ((b.data() || {}).ownerId || null) : null;
      if (!payee) fail('failed-precondition', 'The supplier is not available for payment.');
      if (payee === uid) fail('failed-precondition', 'You cannot pay your own quote.');
      const version = Number.isInteger(q.version) ? q.version : 1;
      return {
        amountCents: Math.round(total * 100), currency: 'KES', resourceType: 'rfqQuote', resourceId: rfqId,
        preferredRef: ('RFQ-' + rfqId + '-v' + version).slice(0, 128),
        metadata: { rfqId, quoteVersion: version, supplierBusinessId: bizId, sellerUid: payee, commissionCategory: cat,
          vatBasis: 'declared_on_quote', vatRate, vatKES: kes(q.vatKES), subtotalKES: sub, deliveryFeeKES: kes(q.deliveryFeeKES || 0) },
      };
    },
  },

  venue_booking: {
    resourceType: 'venueBooking',
    price: (uid, data) => require('./venue-payments').priceVenueBooking(uid, data),
  },
  service_booking: {
    resourceType: 'providerBooking',
    async price(uid, data) {
      const bookingId = String(data.bookingId || '').trim();
      if (!bookingId) fail('invalid-argument', 'bookingId is required.');

      const bSnap = await db().collection('providerBookings').doc(bookingId).get();
      if (!bSnap.exists) fail('not-found', 'Booking not found.');
      const b = bSnap.data();

      if (b.customerUid !== uid) fail('permission-denied', 'Not your booking.');
      if (b.paymentStatus && b.paymentStatus !== 'pending') {
        fail('already-exists', 'This booking is already paid or closed.');
      }
      if (!['pending', 'confirmed'].includes(b.status)) {
        fail('failed-precondition', 'This booking can no longer be paid.');
      }

      /* price + fee from the booking's own snapshot (cents). Commission is applied
         only to `price` at settlement; `fee` passes through to the provider. */
      const cents = Math.max(0, Math.round(Number(b.price) || 0)) + Math.max(0, Math.round(Number(b.fee) || 0));
      if (cents <= 0) fail('failed-precondition', 'Booking has no payable amount.');

      return {
        amountCents: cents,
        currency: b.currency || 'KES',
        resourceType: 'providerBooking',
        resourceId: bookingId,
        metadata: {
          type: 'service-booking',
          bookingId,
          providerId: b.providerId || null,
          deposit: Math.max(0, Math.round(Number(b.deposit) || 0)),   /* cents, forfeitable portion */
          pricingVersion: b.pricingVersion || null,
        },
      };
    },
  },

  /* ── Fitness membership (owner 2026-10-03) ────────────────────────────
     Priced from the membership's OWN server-written record (providerMemberships/{id}.priceCents), never from the
     request; bound to the buyer; payable once (paymentStatus 'pending'). The webhook HOLDS it
     (membership-settlement.holdMembershipPayment) — it is never credited at payment. */
  fitness_membership: {
    resourceType: 'providerMembership',
    async price(uid, data) {
      const membershipId = String(data.membershipId || '').trim();
      if (!/^[A-Za-z0-9_-]{6,128}$/.test(membershipId)) fail('invalid-argument', 'membershipId is required.');
      /* SALES SWITCH (defence in depth with fitnessCreateMembership): featureFlags/fitness_membership_sales.enabled must be
         EXACTLY true (admin-written via AdminOS adminUpdateFeatureFlag, default OFF). A membership created before the flag
         was turned off, or by any other path, cannot be paid while sales are off. A read error FAILS CLOSED. */
      /* The ONE predicate (shared/fitness-sales-switch.js), also used by fitnessCreateMembership. */
      const salesOpen = await require('./shared/fitness-sales-switch').salesEnabled(db());
      if (!salesOpen) fail('failed-precondition', 'Membership sales are not open yet.', { code: 'SALES_DISABLED' });
      const snap = await db().collection('providerMemberships').doc(membershipId).get();
      if (!snap.exists) fail('not-found', 'Membership not found.');
      const m = snap.data();
      if (m.buyerUid !== uid) fail('permission-denied', 'Not your membership.');
      if (m.paymentStatus !== 'pending' || m.status !== 'pending_payment') fail('already-exists', 'This membership is already paid or closed.');
      /* An abandoned unpaid membership is not payable forever: the creation path sets payBy (its own TTL); after it a new
         membership must be started (the price snapshot may be stale). A payment already in flight is still honoured. */
      const payBy = m.payBy && (m.payBy.toMillis ? m.payBy.toMillis() : new Date(m.payBy).getTime());
      if (payBy && Date.now() > payBy) fail('failed-precondition', 'This membership offer has expired. Please start again.');
      const cents = Number(m.priceCents);
      if (!Number.isInteger(cents) || cents <= 0) fail('failed-precondition', 'Membership has no payable amount.');
      if (!m.providerId) fail('failed-precondition', 'Membership has no provider.');
      return {
        amountCents: cents, currency: 'KES', resourceType: 'providerMembership', resourceId: membershipId,
        metadata: { type: 'fitness-membership', membershipId, providerId: m.providerId, periodCount: m.periodCount || null },
      };
    },
  },

  /* ── Healthcare subscription (clinic | hospital | enterprise) ─────────
     The price comes from functions/healthcare-plans.js — the one table for the
     Healthcare hub — and NEVER from the request. The client sends a tier; the
     server prices it. That is the whole security property: a tier is a menu
     choice, an amount is an assertion, and only the server may make it.

     The resource is the SUBSCRIBER, not a document the client can point at:
     resourceId is the caller's own uid, so an intent can never be minted
     against somebody else's account. Activation is separately gated by the
     entitlement engine's ownership check, which compares the payment's uid to
     the intent's owner — belt and braces, and neither is a substitute for the
     other. */
  healthcare_subscription: {
    resourceType: 'healthcareSubscription',
    async price(uid, data) {
      const plans = require('./healthcare-plans');
      const tier = String(data.tier || data.planId || '').trim().toLowerCase();
      if (!tier) fail('invalid-argument', 'tier is required.');

      const plan = plans.resolve(tier);
      /* An unknown tier is REFUSED, never defaulted. Defaulting an unrecognised
         plan to the cheapest one would let a typo buy a subscription, and
         defaulting to the dearest would charge for something nobody chose. */
      if (!plan) {
        fail('invalid-argument',
          `Unknown Healthcare plan "${tier}". Valid plans: ${plans.TIERS.join(', ')}.`);
      }

      const cents = Math.max(0, Math.round(Number(plan.priceCents) || 0));
      if (cents <= 0) fail('failed-precondition', `Healthcare plan "${tier}" has no price.`);

      return {
        amountCents: cents,
        currency: 'KES',
        resourceType: 'healthcareSubscription',
        resourceId: uid,
        metadata: {
          type: 'healthcare-subscription',
          hub: plans.HUB,
          tier: plan.id,
          planLabel: plan.label,
          /* Capacity is snapshotted so the activated subscription records what was
             BOUGHT, not what the table happens to say months later — the same
             snapshot discipline the booking contract applies to price. */
          limits: { doctors: plan.limits.doctors, services: plan.limits.services },
          /* NO commission field. commission-config owns the rate, keyed by hub;
             ADR-015 fixes Healthcare bookings at 5% regardless of tier. */
        },
      };
    },
  },

  /* ── SOKONI Till sale (Q5 of the Till/QR gate) ────────────────────────
     The one registry entry the Till/QR programme adds — no change to
     createPaymentIntent, the webhook, or the reconciler, per this file's own
     "one entry here" contract (docs/SOKONI_TILL_QR_CONTRACT.md,
     docs/SOKONI_TILL_PAYMENT_INTENT_ATTACHMENT.md). The actual pricing
     decision — cashier-cart vs. buyer-entered amount, the authorization
     check, and reading shopId/branchId/merchantUid EXCLUSIVELY off the Till
     document rather than the request — lives in the pure, independently
     certified core (./sokoni-qr-authority.js's priceTillSale), so this entry
     is only the Firestore lookup + error translation every other pricer
     already does inline. */
  pos_till_sale: {
    resourceType: 'posTillSale',
    async price(uid, data) {
      const sokoniTillId = String((data || {}).sokoniTillId || '').trim();
      if (!sokoniTillId) fail('invalid-argument', 'sokoniTillId is required.');

      const tSnap = await db().collection('sokoniTills').doc(sokoniTillId).get();
      const till = tSnap.exists ? tSnap.data() : null;

      const authority = require('./sokoni-qr-authority');
      let quote;
      try {
        quote = authority.priceTillSale({ till, callerUid: uid, data });
      } catch (e) {
        fail(e.code || 'failed-precondition', e.message || 'This Till sale could not be priced.');
      }
      /* Slice 13 (2026-09-29): the till SALE this payment is for. posCompleteCheckout accepts an M-PESA / card tender only
         when the paid intent names ITS sale key here, so one IntaSend payment can never settle a different sale. */
      if (data && data.saleId && /^[A-Za-z0-9_-]{3,80}$/.test(String(data.saleId))) quote.metadata = Object.assign({}, quote.metadata, { saleId: String(data.saleId) });
      /* Points (2026-09-29): PAY PART OF A QUICK CHARGE WITH SOKONI POINTS — through the same buyer-confirmed till
         redemption the POS uses (functions/loyalty-points-spend.js), bound to THIS charge by its sale id. Only on the
         cashier's own charge (pos_cart), never on a buyer-typed permanent-Till payment. The server reads the value
         from the confirmed redemption and takes it off what the customer is asked to pay; the webhook spends the held
         points when the rest is PAID. */
      if (data && data.pointsRedemptionId) {
        if (quote.metadata.sourceMode !== 'pos_cart') fail('failed-precondition', 'Points are spent only on a charge the cashier rings up.');
        const saleId = String(data.saleId || '');
        if (!/^[A-Za-z0-9_-]{6,80}$/.test(saleId)) fail('invalid-argument', 'This charge needs its sale reference to use points.');
        const saleTotal = Math.round(Number(quote.amountCents)) / 100;
        let r;
        try {
          r = await require('./loyalty-points-spend').validateQuickChargeRedemption(db(), {
            redemptionId: data.pointsRedemptionId, shopId: till.shopId, saleKey: saleId, saleTotal });
        } catch (e) { fail(e.code || 'failed-precondition', e.message || 'The points could not be confirmed.'); }
        quote.amountCents = Math.round((saleTotal - r.kes) * 100);
        quote.metadata = Object.assign({}, quote.metadata, {
          saleTotal, pointsRedemptionId: r.redemptionId, pointsRedeemed: r.points, pointsDiscount: r.kes,
          pointsFunding: [{ shopId: String(till.shopId), kes: r.kes, points: r.points }], pointsBuyerUid: r.buyerUid,
        });
      }
      return quote;
    },
  },

  /* ── Hub registration ─────────────────────────────────────────────────
     Replaces the localStorage grant. The tier price is read from the hub
     catalogue so a merchant cannot register for an Enterprise hub at the
     Starter price by editing a request. */
  /* MARKETPLACE PRODUCT ORDER — the B1 fix.
     `initiateSTKPush` accepted a client-computed `orderTotal` for category
     'product', so a crafted client could pay below catalogue price while the
     webhook still decremented stock. This pricer makes the amount originate on
     the server.

     It deliberately REUSES the authorities that already exist rather than
     inventing a parallel one — availability-enforce for shop/product gating, the
     catalogue for price, and shared/delivery-engine for the fee. A second
     implementation of "what does this cost" is how the two would drift, which is
     the same class of defect as the subscription plan-field divergence.

     `data.amount` / `orderTotal` are IGNORED. Nothing here reads a price from
     the request; that is the registry's contract. */
  /* product_order is the INDEPENDENT final charging authority (Rail B, Option A).
     It re-derives product identity, server price, availability/stock, seller and
     delivery on every charge via the shared validateOrderLines + delivery-engine,
     so it deliberately takes NO quoteId: createMultiShopCheckoutQuote is the
     checkout DISPLAY/confirmation snapshot, this function is the money. The absence
     of quoteId here is intentional — coupling the quote lifecycle into the charge
     would weaken this independence. See docs/MULTISHOP_STACK_PROVENANCE_MANIFEST.md. */
  product_order: {
    resourceType: 'order',
    async price(uid, data) {
      const orderId = String(data.orderId || '').trim();
      if (!orderId) fail('invalid-argument', 'orderId required.');

      /* Item price / availability / stock validated by the CANONICAL validator,
         shared with the multi-shop checkout quote so the two cannot fork. It
         returns server-authoritative lines + subtotal; the single-seller
         settlement policy immediately below is product_order's own. */
      const { lines, subtotal } = await validateOrderLines(uid, data.items);

      /* One seller per order — the webhook credits a single seller wallet. */
      const orderSellers = [...new Set(lines.map((l) => l.sellerUid).filter(Boolean))];
      if (orderSellers.length > 1)
        fail('failed-precondition', 'Cart spans multiple sellers; check out one shop at a time.');
      /* NO CLIENT FALLBACK. This previously read
             orderSellers[0] || String(data.sellerUid || '') || null
         so a cart whose products carried no sellerUid deferred to a
         browser-supplied value — trusting the client for exactly the products
         where the SERVER could not establish an owner. That is the worst case
         to trust it: the money is routed, the order is attributed and the
         fulfilment is assigned on that identity.

         A product whose seller cannot be derived from its own document is not
         checkout-able. Reject, never fill the gap.
         See docs/CHECKOUT_CONTRACT.md — Single-Shop Checkout Invariant. */
      if (!orderSellers.length)
        fail('failed-precondition', 'These products have no seller on record and cannot be checked out.');
      const sellerUid = orderSellers[0];

      /* DELIVERY — server-recomputed from the merchant's own config through the
         same engine the client uses, so the two cannot drift. Where a merchant
         has no deliveryConfig the server has nothing to recompute from; charge
         zero rather than trusting a client figure. That is stricter than
         darajaSTKPush's legacy clamp, and deliberately so: this path is new, so
         there is no existing behaviour to preserve. */
      let deliveryFee = 0;
      let deliverySource = 'none';
      const wantsDelivery = String(data.fulfillmentType || '').toLowerCase() === 'delivery';

      if (wantsDelivery && sellerUid) {
        const sSnap = await db().collection('sellers').doc(sellerUid).get().catch(() => null);
        const cfg = sSnap && sSnap.exists ? sSnap.data().deliveryConfig : null;
        if (cfg && cfg.enabled !== undefined) {
          const calc = require('./shared/delivery-engine.js').calculateDelivery(cfg, {
            subtotal, distanceKm: data.distanceKm, zone: data.deliveryZone,
          });
          if (calc.deliverable === false)
            fail('failed-precondition', calc.reason || 'This address cannot be delivered to.');
          deliveryFee = Math.round(Number(calc.fee) || 0);
          deliverySource = 'delivery-engine';
        } else {
          deliverySource = 'unconfigured';
        }
      }

      /* U7c2 (2026-09-29): THE MERCHANT'S LIVE OFFERS, applied here by the server to these server-priced lines
         (functions/shop-offers.js quoteShopOffers — the same resolver the till and the card session use). An offer
         store that cannot be read REFUSES the checkout: charging full price while the cart showed an offer would take
         more than the buyer agreed to. */
      const SO = require('./shop-offers');
      const offerShopId = SO.lineShopOf(lines[0]);
      const off = await SO.quoteShopOffers(db(), { shopId: offerShopId, lines, deliveryFee, buyerUid: uid,
        fulfilment: String(data.fulfillmentType || '').toLowerCase() });
      if (off.unavailable) fail('failed-precondition', 'The shop\'s offers could not be checked just now. Please try again.');
      const offerDiscount = Math.max(0, Math.round(Number(off.discount) || 0));
      const deliveryAfterOffers = Math.max(0, Math.round(Number(off.deliveryFee) || 0));
      const offersApplied = (off.applied || []).map((a) => ({ id: a.id, label: a.label, type: a.type, kind: a.kind, amount: a.amount }));

      const beforePoints = Math.round(subtotal - offerDiscount + deliveryAfterOffers);
      if (!(beforePoints > 0)) fail('failed-precondition', 'Order has no payable amount.');

      /* Points P2 (2026-09-29): PAYMENT-METHOD PARITY. The card session already took points off; this M-PESA path did
         not, so the same cart cost more on M-PESA. The SAME authority prices them here (10 points = KES 1, at most 25% of
         the goods after offers) and HOLDS them against this order id — idempotent, so a retried intent re-prices to the
         same amount. The webhook spends the hold on PAID; an unpaid hold is released. The selling shop funds it. */
      let pointsDiscount = 0, pointsRedeemed = 0, pointsFunding = [], pointsError = null;
      if (data.redeemLoyalty === true || data.redeemLoyalty === false) {
        try {
          const ph = await require('./loyalty-points-spend').priceAndHold(db(), { uid, channel: 'order', ref: orderId,
            redeem: data.redeemLoyalty === true, goodsKES: Math.max(0, Math.round(subtotal - offerDiscount)), payableKES: beforePoints,
            shops: [{ shopId: offerShopId || sellerUid, goods: Math.max(0, Math.round(subtotal - offerDiscount)) }] });
          pointsDiscount = ph.kes || 0; pointsRedeemed = ph.points || 0; pointsFunding = ph.fundingShops || [];
          if (data.redeemLoyalty === true && !pointsDiscount) pointsError = ph.error || 'Order too small to redeem points';
        } catch (e) {
          if (data.redeemLoyalty === true) pointsError = (e && e.code === 'failed-precondition' && e.message) || 'Points could not be verified';
        }
      }
      const total = beforePoints - pointsDiscount;

      return {
        amountCents: Math.round(total * 100),
        currency: 'KES',
        resourceType: 'order',
        resourceId: orderId,
        /* The intent is minted AT the order id so paymentRef === orderId and the
           existing payments/{ref} ↔ orders/{ref} linkage — and the deterministic
           retry identity that depends on it — survive unchanged. */
        preferredRef: orderId,
        metadata: {
          orderId, sellerUid,
          /* U7c2: deliveryFee is what the buyer PAYS for delivery (after a free-delivery offer); the offer discount
             and the offers behind it travel with the payment so the receipt, the order and the redemption ledger
             record the SAME figures the buyer was charged. */
          subtotal, deliveryFee: deliveryAfterOffers, deliveryFeeBeforeOffers: deliveryFee, deliverySource,
          offerDiscount, offersApplied, offerShopId: offerShopId || null,
          /* Points P2: written only when points were taken off (or refused, so the page can say why) */
          ...(pointsRedeemed > 0 ? { pointsRedeemed, pointsDiscount, pointsFunding } : {}),
          ...(pointsError ? { pointsError } : {}),
          itemCount: lines.length,
          items: lines,
          pricingSource: 'server_recomputed',
        },
      };
    },
  },

  hub_registration: {
    resourceType: 'hubApplication',
    async price(uid, data) {
      const applicationId = String(data.applicationId || '').trim();
      if (!applicationId) fail('invalid-argument', 'applicationId is required.');

      const aSnap = await db().collection('applications').doc(applicationId).get();
      if (!aSnap.exists) fail('not-found', 'Application not found.');
      const app = aSnap.data();
      if (app.uid && app.uid !== uid) fail('permission-denied', 'Not your application.');

      const planKey = String(app.plan || '').toLowerCase();
      let cents = null;
      try {
        const pSnap = await db().collection('hubPlans').doc(planKey).get();
        if (pSnap.exists) cents = Math.round(Number(pSnap.data().price) * 100);
      } catch (_) { /* fall through to the catalogue default below */ }

      /* Documented defaults, used only when no catalogue row exists. */
      if (!Number.isFinite(cents) || cents <= 0) {
        const DEFAULTS = { starter: 50000, pro: 200000, enterprise: 500000 };
        cents = DEFAULTS[planKey] || null;
      }
      if (!Number.isFinite(cents) || cents <= 0) fail('failed-precondition', `Hub plan "${planKey}" has no price.`);

      return {
        amountCents: cents,
        currency: 'KES',
        resourceType: 'hubApplication',
        resourceId: applicationId,
        metadata: { plan: planKey, hubType: app.hubType || null },
      };
    },
  },

  /* ── Ported 2026-09-30 from the LIVE createPaymentIntent build (2026-09-09, archive gen 1787988598550043).
     These three purposes were registered in production and consumed by the shipped client
     (marketing.html → marketing_boost; sokoni-pay.js / subscriptions.html → boost; the commission
     balance surface → commission_collection) but were absent on this lineage; deploying
     createPaymentIntent without them would have refused every boost and every commission
     payment as an unregistered purpose. Byte-for-byte from the archive. */
  boost: {
    resourceType: 'listingBoost',
    async price(uid, data) {
      /* Authoritative price per boost type — a server constant, never the request.
         Seeded from the existing SokoniPay.BOOST_PRICES; a rate change is a reviewed
         code change here, not a value a buyer can send. */
      const BOOST_KES = { basic: 200, premium: 500, homepage: 2000, urgent: 100 };
      const key = String(data.boostKey || data.key || '').trim().toLowerCase();
      if (!Object.hasOwn(BOOST_KES, key)) {
        fail('invalid-argument', `Unknown boost type "${key}". Valid: ${Object.keys(BOOST_KES).join(', ')}.`);
      }
      const cents = BOOST_KES[key] * 100;
      /* The listing being boosted, if supplied — links the paid intent to what it
         bought. Optional: a boost with no listing id is still a valid purchase record. */
      const resourceId = String(data.listingId || data.productId || '').trim() || null;
      return {
        amountCents: cents,
        currency: 'KES',
        resourceType: 'listingBoost',
        resourceId: resourceId,
        metadata: { boostKey: key, durationDays: 7 },
      };
    },
  },
  /* ── Car Hub vehicle boosts (owner 2026-10-03) — priced from vehicle-boosts.catalogue (code seed + AdminOS override),
     never from the request. A single boost needs the listing; a bundle buys 7-day credits for the buyer's account. ── */
  /* ── B2B lead invoice Pay Now (owner 2026-10-03) — the supplier owner pays EVERY outstanding issued lead invoice.
     Amount = b2b-leads.payNowAmount (server read), never the request. The verified webhook applies it through the same
     prepare/commit recovery path as a settlement deduction (claim per payment per invoice). Platform revenue. ── */
  b2b_lead_invoice: {
    resourceType: 'b2bLeadInvoice',
    async price(uid) {
      const due = await require('./b2b-leads').payNowAmount(db(), uid);
      if (!(due.amountKES >= 1)) fail('failed-precondition', 'You have no lead invoice to pay.');
      return {
        amountCents: Math.round(due.amountKES * 100), currency: 'KES', resourceType: 'b2bLeadInvoice', resourceId: uid,
        metadata: { invoiceKeys: due.invoiceKeys.slice(0, 50), amountKES: due.amountKES },
      };
    },
  },

  vehicle_boost: {
    resourceType: 'vehicleBoost',
    async price(uid, data) {
      const p = await require('./vehicle-boosts').priceFor(db(), data.boostKey || data.key);
      if (!p) fail('invalid-argument', 'Unknown vehicle boost.');
      const listingId = String(data.listingId || '').trim();
      if (!p.bundle && !/^[A-Za-z0-9_-]{4,128}$/.test(listingId)) fail('invalid-argument', 'Choose the vehicle listing to boost.');
      return {
        amountCents: p.kes * 100, currency: 'KES', resourceType: 'vehicleBoost',
        resourceId: p.bundle ? uid : listingId,
        metadata: { boostKey: p.key, days: p.ms / 86400000, count: p.count, bundle: !!p.bundle, priceSource: p.source },
      };
    },
  },

  marketing_boost: {
    resourceType: 'marketingBoost',
    async price(uid, data) {
      const MKT_KES = { pro: 500, vip: 1500 };
      const key = String(data.plan || data.boostKey || '').trim().toLowerCase();
      if (!Object.hasOwn(MKT_KES, key)) {
        fail('invalid-argument', `Unknown marketing boost plan "${key}". Valid: ${Object.keys(MKT_KES).join(', ')}.`);
      }
      const cents = MKT_KES[key] * 100;
      const resourceId = String(data.product || data.resourceId || '').trim() || null;
      return {
        amountCents: cents,
        currency: 'KES',
        resourceType: 'marketingBoost',
        resourceId: resourceId,
        metadata: { plan: key, category: 'marketing' },
      };
    },
  },
  commission_collection: {
    resourceType: 'commissionObligation',
    async price(uid) {
      const outstanding = await require('./commission-collection').computeOutstandingKES(uid);
      if (!(outstanding > 0)) {
        fail('failed-precondition', 'No outstanding commission to pay.');
      }
      return {
        amountCents: Math.round(outstanding * 100),
        currency: 'KES',
        resourceType: 'commissionObligation',
        resourceId: String(uid),
        metadata: { kind: 'commission_48h' },
      };
    },
  },
};

/**
 * priceFor(purpose, uid, data) — the single entry point.
 * An unregistered purpose is rejected rather than defaulted: silently treating
 * an unknown purpose as a subscription is exactly the kind of quiet
 * mis-dispatch this registry exists to make impossible.
 */
async function priceFor(purpose, uid, data) {
  const spec = PURPOSES[String(purpose || '')];
  if (!spec) fail('invalid-argument', `Unknown payment purpose "${purpose}".`);

  const quote = await spec.price(uid, data || {});

  const kes = Math.round(quote.amountCents / 100);
  if (!(kes >= MIN_KES && kes <= MAX_KES)) {
    fail('failed-precondition', 'Amount is outside the payable range.');
  }
  return { ...quote, amount: kes, purpose: String(purpose) };
}

const isRegistered = (p) => Object.hasOwn(PURPOSES, String(p || ''));
const registered   = () => Object.keys(PURPOSES);

module.exports = { PURPOSES, priceFor, isRegistered, registered, MIN_KES, MAX_KES, validateOrderLines };
