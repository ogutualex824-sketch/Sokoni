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

const fail = (code, msg) => { throw new HttpsError(code, msg); };

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

    const unitPrice = Number(prod.salePrice || prod.price || 0);
    if (!(unitPrice > 0)) fail('failed-precondition', `${prod.name || pid} has no price.`);

    subtotal += unitPrice * qty;
    lines.push({ productId: pid, qty, unitPrice, sellerUid: prod.sellerUid || null });
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
     Quantity is client-supplied and therefore bounded; the unit price is
     read from the event. A client that could send both would be setting its
     own total. */
  event_ticket: {
    resourceType: 'event',
    async price(uid, data) {
      const eventId = String(data.eventId || '').trim();
      const tierId  = String(data.tierId || '').trim();
      const qty     = Math.floor(Number(data.quantity) || 1);
      if (!eventId) fail('invalid-argument', 'eventId is required.');
      if (!(qty >= 1 && qty <= 20)) fail('invalid-argument', 'quantity must be between 1 and 20.');

      const eSnap = await db().collection('events').doc(eventId).get();
      if (!eSnap.exists) fail('not-found', 'Event not found.');
      const ev = eSnap.data();
      if (ev.status && !['published', 'active', 'on_sale'].includes(String(ev.status))) {
        fail('failed-precondition', 'Tickets are not on sale for this event.');
      }

      /* Tier price if tiers exist, otherwise the event price. */
      let unit = Number(ev.ticketPrice);
      if (Array.isArray(ev.ticketTiers) && ev.ticketTiers.length) {
        const tier = ev.ticketTiers.find(t => String(t.id) === tierId) || ev.ticketTiers[0];
        if (!tier) fail('not-found', 'Ticket tier not found.');
        unit = Number(tier.price);
      }
      const cents = Math.round(unit * 100) * qty;
      if (!Number.isFinite(cents) || cents <= 0) fail('failed-precondition', 'Ticket has no payable price.');

      return {
        amountCents: cents,
        currency: ev.currency || 'KES',
        resourceType: 'event',
        resourceId: eventId,
        metadata: { tierId: tierId || null, quantity: qty, organizerUid: ev.organizerUid || null },
      };
    },
  },

  /* ── Service booking (Phase E) ────────────────────────────────────────
     The amount is the IMMUTABLE snapshot D3 stamped on the booking at creation
     (price + fee, both cents) — never the current providerServices record and
     never the client. `deposit` is the forfeitable PORTION of that price, not an
     extra charge. The intent's resourceId (bookingId) becomes the authoritative
     link the webhook trusts instead of client metadata. */
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

  /* ── Car hub — vehicle / equipment rental ────────────────────────────
     The amount is the snapshot `rentalBook` computed SERVER-SIDE at booking
     time (marketplace-extensions.js:396-405) from the rentalProducts rate card
     and the requested duration. This pricer RE-READS that snapshot rather than
     recomputing it: the rate card may have changed since the customer booked,
     and the figure they agreed to is the one on the booking. Same precedent as
     service_booking, and the same reason.

     Dates, durationUnit and the rate card are NOT re-read for pricing, so a
     client cannot lengthen a booking at payment time to change what it costs.
     It would have to change the booking document itself, which its own rules
     govern.

     THE SECURITY DEPOSIT IS DELIBERATELY NOT CHARGED.
     `rentalBookings.depositAmount` is written by rentalBook and then read by
     NOTHING — there is no collection, release or refund path for it anywhere in
     functions/. Collecting a refundable deposit through a rail that cannot
     refund it would strand the customer's money, so the intent charges
     `totalAmount` only and carries the deposit as metadata for whoever builds
     that lifecycle. Under-charging here is recoverable; taking money we have no
     mechanism to give back is not. */
  car_hub: {
    resourceType: 'rentalBooking',
    async price(uid, data) {
      const bookingId = String(data.bookingId || '').trim();
      if (!bookingId) fail('invalid-argument', 'bookingId is required.');

      const bSnap = await db().collection('rentalBookings').doc(bookingId).get();
      if (!bSnap.exists) fail('not-found', 'Rental booking not found.');
      const b = bSnap.data();

      if (b.buyerId !== uid) fail('permission-denied', 'Not your booking.');

      /* `rentalBookings` carries no paymentStatus field today. Absent is treated
         as UNPAID — the correct default for a document that predates the payment
         rail — but any other value is REFUSED, so the guard starts working the
         moment the field is introduced rather than silently ignoring it. */
      if (b.paymentStatus && b.paymentStatus !== 'pending') {
        fail('already-exists', 'This rental is already paid or closed.');
      }
      /* rentalBook statuses: pending | confirmed | active | completed |
         cancelled. A rental that has started, finished or died must not take
         new money. */
      if (!['pending', 'confirmed'].includes(String(b.status))) {
        fail('failed-precondition', 'This rental can no longer be paid.');
      }

      /* rentalProducts rates are whole shillings (rentalProductCreate), so the
         snapshot is too. Convert once, here, at the boundary. */
      const cents = Math.round(Number(b.totalAmount) * 100);
      if (!Number.isFinite(cents) || cents <= 0)
        fail('failed-precondition', 'Rental booking has no payable amount.');

      return {
        amountCents: cents,
        currency: b.currency || 'KES',
        resourceType: 'rentalBooking',
        resourceId: bookingId,
        metadata: {
          type: 'car-hub-rental',
          bookingId,
          rentalProductId: b.rentalProductId || null,
          shopId: b.shopId || null,
          durationUnit: b.durationUnit || null,
          /* cents. NOT part of amountCents — see the note above. Rounded AFTER
             the ×100, not before: rounding to whole shillings first silently
             discards the cents, which is the same class of error as the
             shillings/cents divergence money-authority.js documents. */
          securityDepositUncollected: Math.max(0, Math.round((Number(b.depositAmount) || 0) * 100)),
        },
      };
    },
  },

  /* ── Accommodation — venue / stay booking ────────────────────────────
     `venueCreateBooking` stamps a complete `pricing` breakdown on the booking
     inside the SAME transaction that takes the slot lock (venue-booking.js:203,
     584) — base, weekend premium, peak surcharge, member discount, total,
     deposit. That snapshot is the price the customer was quoted and the slot was
     held at, so it is what they pay.

     `pricing.deposit` here is a PORTION of `pricing.total` (total ×
     depositPercent, venue-booking.js:203), not an extra charge — the opposite of
     the car-hub security deposit above. Two fields with the same name and
     opposite meanings is exactly how a customer gets double-charged, so neither
     is inferred: each pricer states which it has. The full total is charged,
     matching what venueCalculatePrice quotes.

     `sokoni-bnb.js` writes its own client-side `bnbBookings` and is NOT served
     by this pricer. That path has no server price authority at all and must be
     rewired onto venueCreateBooking before it can be paid for — a separate task,
     deliberately not papered over here. */
  accommodation: {
    resourceType: 'venueBooking',
    async price(uid, data) {
      const bookingId = String(data.bookingId || '').trim();
      if (!bookingId) fail('invalid-argument', 'bookingId is required.');

      const bSnap = await db().collection('venueBookings').doc(bookingId).get();
      if (!bSnap.exists) fail('not-found', 'Booking not found.');
      const b = bSnap.data();

      if (b.customerId !== uid) fail('permission-denied', 'Not your booking.');

      const payStatus = String((b.payment && b.payment.status) || 'pending');
      if (payStatus !== 'pending') fail('already-exists', 'This booking is already paid or closed.');

      /* venue-booking.js STATUS: pending_payment | confirmed | checked_in |
         completed | cancelled | no_show. Only the first two are payable. */
      if (!['pending_payment', 'confirmed'].includes(String(b.status))) {
        fail('failed-precondition', 'This booking can no longer be paid.');
      }

      /* _calcPrice returns shillings rounded to 2dp (_round2), so ×100 is exact
         to the cent rather than truncating a fractional shilling. */
      const pricing = b.pricing || {};
      const cents = Math.round(Number(pricing.total) * 100);
      if (!Number.isFinite(cents) || cents <= 0)
        fail('failed-precondition', 'Booking has no payable amount.');

      return {
        amountCents: cents,
        currency: pricing.currency || 'KES',
        resourceType: 'venueBooking',
        resourceId: bookingId,
        metadata: {
          type: 'accommodation',
          bookingId,
          venueId: b.venueId || null,
          date: b.date || null,
          slotKey: b.slotKey || null,
          bookingModel: b.bookingModel || null,
          /* cents, a PORTION of the total already being charged. Rounded AFTER
             the ×100 — _calcPrice emits 2dp shillings, so rounding first would
             drop the cents. */
          deposit: Math.max(0, Math.round((Number(pricing.deposit) || 0) * 100)),
        },
      };
    },
  },

  /* ── POS service sale — the universal till line ───────────────────────
     A cyber café charging for ten printed pages, a salon for a haircut, a
     garage for a diagnosis, a shop for a phone charger. One purpose, because
     to the payment rail they are identical: a merchant's authorized operator
     charging their own customer for a basket of priced lines.

     The arithmetic and every guard live in shared/pos-service-pricing.js,
     which is PURE and separately certified. This entry does the Firestore
     lookup and the error translation, exactly as pos_till_sale delegates to
     sokoni-qr-authority. Nothing is computed here.

     THE CATALOGUE IS posProducts. A service is a row with trackStock:false
     and a `unit` — a shape pos.js already reads. No second collection.

     WHY A CASHIER MAY NAME A PRICE HERE and nowhere else on this rail: the
     client is the MERCHANT, not the buyer. Same trust boundary priceTillSale
     uses. Every cashier-named figure is bounded by a per-merchant ceiling,
     attributed to the cashier's uid, and labelled `quick_charge` or `variable`
     so it can never be mistaken for a catalogue price in reconciliation. */
  pos_service_sale: {
    resourceType: 'posSale',
    async price(uid, data) {
      const merchantId = String(data.merchantId || data.sellerId || '').trim();
      if (!merchantId) fail('invalid-argument', 'merchantId is required.');

      const rawLines = Array.isArray(data.lines) ? data.lines : [];
      if (!rawLines.length) fail('invalid-argument', 'The basket is empty.');

      /* Load ONLY the catalogue items this basket references. Firestore caps
         documentId() `in` queries at 10, so chunk — same shape as
         validateOrderLines above. */
      const ids = [...new Set(rawLines
        .map((l) => String((l && l.itemId) || '').trim())
        .filter(Boolean))];

      const catalogue = {};
      for (let i = 0; i < ids.length; i += 10) {
        const chunk = ids.slice(i, i + 10);
        const snap = await db().collection('posProducts')
          .where(FieldPath.documentId(), 'in', chunk).get();
        snap.forEach((d) => { catalogue[d.id] = d.data() || {}; });
      }

      /* Per-merchant quick-charge policy. Absent ⇒ the module's hard default,
         never "unlimited": the safe reading of a missing limit is the strict
         one. Read from the merchant's own config, so a cashier cannot raise
         their own ceiling. */
      let limits = {};
      try {
        const cfg = await db().collection('posSettings').doc(merchantId).get();
        if (cfg.exists) {
          const c = cfg.data() || {};
          limits = {
            quickChargeEnabled:  c.quickChargeEnabled,
            quickChargeMaxCents: c.quickChargeMaxCents,
          };
        }
      } catch (_) { /* strict default */ }

      /* BUSINESS SCOPE — may this business bill for products, services, or
         both? Resolved from the registry documents APPROVAL wrote, never from
         a self-claimable `businessType` label. A cyber café holding both
         `sellers/{uid}` and `providers/{uid}` bills airtime and printing on
         one basket, one set of books.

         Read failures fail CLOSED to "not trading" rather than skipping the
         check: an unreadable registry is exactly when not to assume approval. */
      const bscope = require('./shared/business-scope');
      let scope;
      try {
        const [sellerSnap, providerSnap] = await Promise.all([
          db().collection('sellers').doc(merchantId).get(),
          db().collection('providers').doc(merchantId).get(),
        ]);
        scope = bscope.resolveBusinessScope({
          seller:   sellerSnap.exists   ? sellerSnap.data()   : null,
          provider: providerSnap.exists ? providerSnap.data() : null,
        });
      } catch (_) {
        scope = bscope.resolveBusinessScope({});     /* trades nothing */
      }
      if (!scope.isTrading) {
        fail('permission-denied', 'This business is not currently approved to take payments.');
      }

      const pricing = require('./shared/pos-service-pricing');
      let priced;
      try {
        priced = pricing.priceServiceBasket({
          lines: rawLines,
          catalogue,
          callerUid:   uid,
          merchantUid: merchantId,
          limits,
          scope,
        });
      } catch (e) {
        fail(e.code || 'failed-precondition', e.message || 'This sale could not be priced.');
      }

      /* Deterministic ref when the till supplies a saleId, so a cashier's
         double-tap replays one intent instead of minting a second. Reuses
         createPaymentIntent's existing preferredRef machinery unchanged. */
      const saleId = String(data.saleId || '').trim();
      let preferredRef;
      if (saleId) {
        if (!/^[A-Za-z0-9_-]{3,80}$/.test(saleId)) fail('invalid-argument', 'Invalid saleId.');
        preferredRef = `POSSVC-${merchantId}-${saleId}`.slice(0, 128);
      }

      return {
        amountCents: priced.amountCents,
        currency: 'KES',
        resourceType: 'posSale',
        resourceId: saleId || merchantId,
        ...(preferredRef ? { preferredRef } : {}),
        metadata: {
          type: 'pos-service-sale',
          merchantId,
          cashierUid: uid,
          saleId: saleId || null,
          lines: priced.lines,
          /* Surfaced so a reconciler can find baskets containing keyed-in
             figures without re-walking every line. */
          priceSourceCounts: priced.counts,
          /* What this business was approved to trade AT THE MOMENT OF SALE.
             A later suspension must not rewrite the history of a sale that was
             legitimate when it happened, and a tax return covering a dual
             business needs to show which side of it each line belonged to. */
          businessScope: scope.scopes,
          pricingSource: 'server_catalogue_and_bounded_counter_entry',
        },
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
      try {
        return authority.priceTillSale({ till, callerUid: uid, data });
      } catch (e) {
        fail(e.code || 'failed-precondition', e.message || 'This Till sale could not be priced.');
      }
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

      /* DELIVERY — THE RES-1 SERVER-ISSUED POLICY QUOTE IS THE AUTHORITY (owner decision 2026-09-27).
         For marketplace orders the buyer's delivery charge is the `customerCharge` of the quote the
         server issued to THIS buyer (requestDeliveryQuote) — the same figure the checkout already
         displays before payment, and the same quote whose allocation pays the rider (Repair 5) and
         SOKONI. This previously priced delivery from `sellers/{uid}.deliveryConfig` through the
         delivery engine, using a distance/zone the browser supplied (and, on the live path, did not
         send — so a distance-mode seller was refused and an unconfigured one charged KES 0) while
         the page showed the quote. The buyer was shown one number and charged another.

         deliveryConfig is NOT read here any more. Seller records are preserved untouched; they are
         simply not a marketplace pricing input. The delivery engine still serves the non-marketplace
         surfaces that use it (courier booking, food menu).

         FAIL CLOSED. A delivery order needs a quote the server can resolve for this buyer — issued,
         unexpired, unconsumed, current policy, figures revalidated (resolveQuoteForCheckout). No
         quote → no charge; there is no fallback to a browser figure or to deliveryConfig. A payload
         that states a delivery price is refused outright rather than ignored.
         Rounding: the quote is held in minor units; the charge is whole shillings, rounded exactly
         as createCheckoutSession rounds the same quote — one rule for one figure. */
      let deliveryFee = 0;
      let deliverySource = 'none';
      let deliveryQuoteRef = null;
      const wantsDelivery = String(data.fulfillmentType || '').toLowerCase() === 'delivery';
      require('./delivery-quote-endpoint').assertNoCheckoutPricing(data);

      if (wantsDelivery) {
        if (!data.deliveryQuoteId) {
          fail('failed-precondition', 'A delivery quote is required before paying for delivery. Please confirm your delivery address.');
        }
        const q = await require('./delivery-quote-endpoint').resolveQuoteForCheckout(String(data.deliveryQuoteId), uid);
        deliveryFee = Math.round(q.customerChargeMinor / 100);
        deliverySource = 'res1_quote';
        deliveryQuoteRef = {
          deliveryQuoteId: q.quoteId,
          pricingVersion: q.pricingVersion,
          policyVersion: q.policyVersion,
          customerChargeMinor: q.customerChargeMinor,
        };
      }

      const total = Math.round(subtotal + deliveryFee);
      if (!(total > 0)) fail('failed-precondition', 'Order has no payable amount.');

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
          /* THE FULFILMENT THIS CHARGE WAS PRICED FOR (RES-1 option 2). The buyer chooses it; the
             SERVER records it here, where it priced the charge, so the webhook reads it from this
             server-owned intent rather than from browser payment metadata (which never carried it,
             so every STK order used to default to "delivery" — a pickup order was dispatched). */
          fulfillmentType: wantsDelivery ? 'delivery' : 'pickup',
          subtotal, deliveryFee, deliverySource,
          /* Provenance of the delivery charge: the quote it came from. Recorded, not yet consumed —
             binding the quote to the order is the order-creation step's job (RES-1). */
          ...(deliveryQuoteRef ? { deliveryQuote: deliveryQuoteRef } : {}),
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
