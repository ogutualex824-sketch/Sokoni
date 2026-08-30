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
          subtotal, deliveryFee, deliverySource,
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
