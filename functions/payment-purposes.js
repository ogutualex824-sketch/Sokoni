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
/* A stay longer than this is a lease, not a booking, and is almost certainly a date
   typo — an unbounded night count multiplies the nightly rate without limit. */
const MAX_NIGHTS = 90;
/* An unbounded quantity multiplies the unit price without limit. */
const MAX_TICKETS = 20;
/* The destination test charge. A server constant: the browser must not be able to
   verify a destination with a payment of zero. */
const DESTINATION_TEST_KES = 1;
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

      /* DELIVERY — server-recomputed from the merchant's own config through the
         same engine the client uses, so the two cannot drift. Where a merchant
         has no deliveryConfig the server has nothing to recompute from; charge
         zero rather than trusting a client figure. That is stricter than
         the legacy initiator's clamp, and deliberately so: this path is new, so
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

      /* ── PROMOTION AND LOYALTY — DECIDED HERE, NEVER SENT ────────────────────
         The browser names a promo CODE and states an INTENT to redeem points. It
         never sends a discount, a points figure, or a total. Those are read and
         decided on this side, because a client that can assert its own discount can
         assert any discount.

         This capability used to live in createCheckoutSession, which only the
         retired M-PESA rail called. The card path never carried it, so converging on
         one checkout would have left a customer seeing a discounted total and being
         charged the full one. Moving it into the pricing authority means every path
         gets it — there is only one path now, and it prices completely. */
      let promoDiscount = 0;
      let promoApplied = null;
      let promoError = null;
      const _promoCode = String(data.promoCode || '').trim().toUpperCase();
      if (_promoCode) {
        try {
          const { validatePromoCode } = require('./finos-utils');
          const _res = await validatePromoCode(db(), {
            code: _promoCode,
            buyerUid: uid,
            orderAmountCents: Math.round(subtotal * 100),
            category: 'product',
          });
          if (_res && _res.valid) {
            /* A discount may never exceed the goods value — delivery is still owed. */
            promoDiscount = Math.min(Math.round((_res.discountCents || 0) / 100), Math.round(subtotal));
            /* fundedBy is carried through so settlement can tell a SOKONI-funded
               discount from a seller-funded one. Dropping it here would make every
               discount look like the platform's. */
            promoApplied = {
              code: _res.promoCode, promoId: _res.promoId,
              discount: promoDiscount, fundedBy: _res.fundedBy || 'platform',
            };
          } else {
            promoError = (_res && _res.reason) || 'This promo code could not be applied';
          }
        } catch (e) {
          /* An invalid or unavailable promo is not a payment failure: the buyer is
             told and pays full price, rather than being blocked from paying at all. */
          promoError = 'Promo code could not be verified';
        }
      }

      /* Points are NOT deducted here. An abandoned checkout must never burn them —
         the redemption is recorded as intent and settled when the payment is.

         RATE NOTE: 1 point = KES 0.50 is the MARKETPLACE loyalty rate, carried
         forward unchanged from createCheckoutSession. The POS programme uses a
         different rate through rewards-rate.js (10 points = KES 1). They are separate
         programmes; this is not a third opinion about one of them. */
      const POINTS_TO_KES = 0.5;
      const MAX_REDEEM_PCT = 0.25;
      let loyaltyDiscount = 0;
      let loyaltyPoints = 0;
      let loyaltyError = null;
      if (data.redeemLoyalty === true) {
        try {
          const _lSnap = await db().collection('loyaltyAccounts').doc(uid).get();
          const _bal = _lSnap.exists ? Math.max(0, Math.floor(Number(_lSnap.data().balance) || 0)) : 0;
          if (_bal <= 0) {
            loyaltyError = 'No loyalty points available to redeem';
          } else {
            loyaltyDiscount = Math.floor(Math.min(
              _bal * POINTS_TO_KES,
              Math.round(subtotal) * MAX_REDEEM_PCT
            ));
            loyaltyPoints = loyaltyDiscount > 0 ? Math.ceil(loyaltyDiscount / POINTS_TO_KES) : 0;
            if (loyaltyDiscount <= 0) loyaltyError = 'Order too small to redeem points';
          }
        } catch (e) {
          loyaltyError = 'Loyalty balance could not be verified';
        }
      }

      /* Discounts may never take the charge below KES 1 — a gateway cannot bill zero,
         and a free order must not silently become a zero-value checkout. The loyalty
         portion is trimmed FIRST: points are refundable to the customer, a promo code
         is not, so trimming the promo would destroy value that cannot be given back. */
      const grossTotal = Math.round(subtotal + deliveryFee);
      let discount = promoDiscount + loyaltyDiscount;
      if (discount > grossTotal - 1) {
        const allowed = Math.max(0, grossTotal - 1);
        let trim = discount - allowed;
        const loyaltyTrim = Math.min(trim, loyaltyDiscount);
        loyaltyDiscount -= loyaltyTrim;
        loyaltyPoints = loyaltyDiscount > 0 ? Math.ceil(loyaltyDiscount / POINTS_TO_KES) : 0;
        trim -= loyaltyTrim;
        if (trim > 0) {
          promoDiscount = Math.max(0, promoDiscount - trim);
          if (promoApplied) promoApplied.discount = promoDiscount;
        }
        discount = promoDiscount + loyaltyDiscount;
      }

      const total = Math.round(grossTotal - discount);
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
          /* The complete authoritative pricing decision, so the hosted checkout is
             opened against a figure whose derivation is recorded rather than implied. */
          promoDiscount, promoApplied, promoError,
          loyaltyDiscount, loyaltyPoints, loyaltyError,
          discountTotal: discount,
          grossTotal, chargedTotal: total,
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

  /* ── Listing boost / featured placement ───────────────────────────────
     A promotional boost on a listing. The price is fixed by the platform and lives
     HERE, server-side — the client sends only the boost TYPE (a key), NEVER an
     amount. buyBoost() previously passed a client-held depositAmount with no intent
     behind it, so a tampered client could pay any 1–150000 figure for a boost. The
     key selects one of a small fixed set; anything else is refused. resourceId
     records the listing the boost was bought for. */
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

  /* ── Marketing-hub boost (marketing.html) ─────────────────────────────
     A distinct product from the listing boost above: a paid marketing-hub promotion
     with its own plans (pro / vip). Same invariant — the client sends the PLAN key,
     the server sets the price. (The 'basic' plan is free and carries no money, so it
     is not a purpose here.) */
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

  /* ── Courier delivery (delivery.html / courier-delivery.js) ───────────────
     Priced from the QUOTE, not re-priced. courierQuotes/{quoteId} was written by
     getCourierQuote from the server catalogue and stamped with its pricing version;
     re-running the pricer here would let a catalogue change between quote and payment
     silently move the figure after the customer agreed to it.

     PAYABILITY IS A COMMERCIAL QUESTION, and it fails closed on both halves:

       pricing_version_not_approved        the rate catalogue carries approved:false,
                                           because no business decision approving those
                                           figures is evidenced anywhere in the repo
       platform_payout_destination_unset   platformConfig/courier.platformPayoutUid is
                                           unset, and the old browser
                                           SOKONI_CONFIG.platformSellerUid is NOT a
                                           substitute — it had no server-side existence

     So the mechanism is complete and certifiable today, and exactly one thing is
     outstanding: a person approving the commercial values and naming the account. Until
     then a quote can be shown and a delivery booked unpaid, and a charge is refused. */
  courier_delivery: {
    resourceType: 'courierDelivery',
    async price(uid, data) {
      const deliveryId = String(data.deliveryId || '').trim();
      if (!deliveryId) fail('invalid-argument', 'deliveryId is required.');

      const dSnap = await db().collection('deliveries').doc(deliveryId).get();
      if (!dSnap.exists) fail('not-found', 'Delivery not found.');
      const del = dSnap.data() || {};

      if (String(del.senderUid || '') !== String(uid)) {
        fail('permission-denied', 'This delivery is not yours.');
      }
      if (String(del.paymentStatus || '') === 'paid') {
        fail('already-exists', 'This delivery is already paid.');
      }
      if (!del.quoteId) fail('failed-precondition', 'This delivery was not priced by a quote.');

      /* The figure comes from the QUOTE the delivery was created from. */
      const qSnap = await db().collection('courierQuotes').doc(String(del.quoteId)).get();
      if (!qSnap.exists) fail('failed-precondition', 'The quote for this delivery no longer exists.');
      const q = qSnap.data() || {};
      if (String(q.consumedBy || '') !== deliveryId) {
        fail('failed-precondition', 'This quote does not belong to this delivery.');
      }
      if (String(q.pricingVersion || '') !== String(del.pricingVersion || '')) {
        fail('failed-precondition', 'The delivery and its quote disagree on the pricing version.');
      }

      const kes = Number(q.deliveryFee);
      if (!Number.isFinite(kes) || kes <= 0) fail('failed-precondition', 'This delivery has no payable fee.');
      if (Math.round(Number(del.deliveryFee)) !== Math.round(kes)) {
        fail('failed-precondition', 'The delivery record and its quote disagree on the fee.');
      }

      const CP = require('./courier-pricing');
      const problems = await CP.payabilityProblems(db(), q.pricingVersion);
      if (problems.length) {
        fail('failed-precondition',
             'Courier payments are not yet enabled: ' + problems.join(', ') + '.');
      }

      const platformUid = await CP.platformPayoutUid(db());
      if (!platformUid) fail('failed-precondition', 'No courier payout destination is configured.');

      return {
        amountCents: Math.round(kes * 100),
        currency: q.currency || 'KES',
        resourceType: 'courierDelivery',
        resourceId: deliveryId,
        preferredRef: deliveryId,
        metadata: {
          type: 'courier-delivery',
          sellerUid: platformUid,          /* declared platform account, from server config */
          destinationField: 'platformConfig/courier.platformPayoutUid',
          ownershipEnforced: true,         /* a server document, not client-writable */
          deliveryId,
          quoteId: String(del.quoteId),
          pricingVersion: q.pricingVersion,
          riderFeeKES: q.riderFeeKES,
          platformFeeKES: q.platformFeeKES,
        },
      };
    },
  },

  /* ── Payment-destination verification (payment-destinations.js) ───────────
     A merchant proves control of a Till or PayBill by making one small payment
     against a server-minted intent. The webhook's confirmation is what promotes the
     pending destination to VERIFIED — see payment-destination-verify.js.

     The amount is a SERVER CONSTANT. There is nothing for a merchant to choose here:
     the figure exists only to produce a real provider confirmation, and letting the
     browser name it would let a merchant verify a destination with a payment of zero.

     The payee is the merchant THEMSELVES. Every other pricer refuses that as money in
     a circle, and it is refused here too for a third party — but for this purpose the
     merchant paying their own destination IS the test. The webhook skips the wallet
     credit for this purpose so the token amount does not appear as earnings. */
  destination_verification: {
    resourceType: 'paymentDestination',
    async price(uid, data) {
      const PD = require('./payment-destinations');
      /* Server-resolved scope: users/{uid}.activeShopId -> shops/{id}, ownership
         checked. Nothing here is taken from the request. */
      const scope = await PD._resolveScope(uid);
      const sellerUid = scope.sellerUid;

      const snap = await db().collection('paymentDestinations').doc(sellerUid).get();
      if (!snap.exists) fail('failed-precondition', 'No payment destination to verify.');
      const d = snap.data() || {};
      const pending = d.pending;
      if (!pending) fail('failed-precondition', 'There is no pending destination to verify.');
      if (!pending.destinationNumber) {
        fail('failed-precondition', 'The pending destination has no number to test.');
      }

      return {
        amountCents: DESTINATION_TEST_KES * 100,
        currency: 'KES',
        resourceType: 'paymentDestination',
        resourceId: sellerUid,
        metadata: {
          type: 'destination-verification',
          sellerUid,                 /* the merchant; the webhook skips the credit */
          destinationField: 'resolvedScope',
          ownershipEnforced: true,   /* _resolveScope proves the shop belongs to the caller */
          destinationType: pending.destinationType || null,
          shopId: scope.shopId || null,
        },
      };
    },
  },

  /* ── Entertainment hub ticket (entertainment.html / entertainment-hub.js) ──
     A SEPARATE AUTHORITY FROM `event_ticket`, and deliberately not merged with it:

       event_ticket  ->  events/{id}.ticketTiers    (Event Hub; tiers also exist as
                                                     their own eventTicketTiers docs,
                                                     purchased through the atomic
                                                     purchaseTickets CF)
       ent_ticket    ->  entEvents/{id}.ticketTypes (Entertainment Hub)

     Different collection, different field, different tier shape. Treating them as one
     would price a ticket from a document the buyer never selected.

     DESTINATION — `entEvents.uid`. firestore.rules enforces it at create
     (claimsOwner(): request.resource.data.uid == request.auth.uid) and makes it
     immutable on update (uidUnchanged()), so the payee is the account that created the
     event and cannot be re-pointed afterwards. `organizerUid` is NOT used: the
     entTickets rule mentions it but nothing in entertainment-hub.js ever writes it, so
     it is a field that does not exist on these documents.

     TIERS — when `ticketTypes` is a non-empty array the named tier must be found in
     it; a name that is not there is rejected rather than silently falling back. An
     event with no tiers is priced from its own `ev.price`, which is what the hub
     already does for flat-priced events. Either way the figure must be positive and
     finite; nothing is defaulted to zero and then charged. */
  ent_ticket: {
    resourceType: 'entEvent',
    async price(uid, data) {
      const eventId = String(data.eventId || '').trim();
      if (!eventId) fail('invalid-argument', 'eventId is required.');

      const qty = Number(data.quantity);
      if (!Number.isInteger(qty) || qty < 1 || qty > MAX_TICKETS) {
        fail('invalid-argument', `quantity must be a whole number between 1 and ${MAX_TICKETS}.`);
      }

      const snap = await db().collection('entEvents').doc(eventId).get();
      if (!snap.exists) fail('not-found', 'Event not found.');
      const ev = snap.data() || {};

      if (ev.status && ['cancelled', 'deleted', 'draft'].includes(String(ev.status))) {
        fail('failed-precondition', 'Tickets are not on sale for this event.');
      }

      /* ── the tier ── */
      const tiers = Array.isArray(ev.ticketTypes) ? ev.ticketTypes : [];
      const wanted = String(data.ticketType || '').trim();
      let unitKES, tierName, tierIndex = -1;

      if (tiers.length) {
        if (!wanted) fail('invalid-argument', 'ticketType is required for this event.');
        tierIndex = tiers.findIndex((t) => t && String(t.name) === wanted);
        if (tierIndex < 0) fail('not-found', 'That ticket type is not available for this event.');
        const tier = tiers[tierIndex];

        /* Capacity, when the tier declares one. A tier with no capacity is unlimited,
           which is what the hub already assumes; a tier WITH one must not oversell. */
        if (tier.capacity != null) {
          const cap = Number(tier.capacity);
          const sold = Number(tier.sold || 0);
          if (!Number.isFinite(cap) || cap <= 0) fail('failed-precondition', 'This ticket type is not on sale.');
          if (sold >= cap) fail('failed-precondition', 'This ticket type is sold out.');
          if (sold + qty > cap) {
            fail('failed-precondition', `Only ${Math.max(0, cap - sold)} of this ticket type remain.`);
          }
        }
        unitKES = Number(tier.price);
        tierName = String(tier.name);
      } else {
        /* No tiers — the event's own flat price. */
        unitKES = Number(ev.price);
        tierName = 'General';
      }

      if (!Number.isFinite(unitKES) || unitKES <= 0) {
        fail('failed-precondition', 'This ticket has no payable price.');
      }

      /* ── the payee ── */
      const sellerUid = ev.uid && String(ev.uid).trim();
      if (!sellerUid) {
        fail('failed-precondition', 'This event has no payout destination and cannot sell tickets.');
      }
      if (sellerUid === uid) fail('failed-precondition', 'You cannot buy tickets to your own event.');

      /* Cents on the UNIT, then multiplied by an integer count, so N tickets is
         exactly N times one ticket. */
      const unitCents = Math.round(unitKES * 100);

      return {
        amountCents: unitCents * qty,
        currency: ev.currency || 'KES',
        resourceType: 'entEvent',
        resourceId: eventId,
        metadata: {
          type: 'ent-ticket',
          sellerUid,                    /* -> attribution.sellerUid -> wallet credit */
          destinationField: 'uid',
          ownershipEnforced: true,      /* claimsOwner() at create, uidUnchanged() on update */
          eventId,
          eventTitle: ev.title || ev.name || null,
          ticketType: tierName,
          tierIndex,
          quantity: qty,
          unitCents,
        },
      };
    },
  },

  /* ── Legal consultation deposit (legal-hub.html) ──────────────────────────
     The strongest provenance of the migrated hubs so far, and worth stating why:

       firestore.rules   match /legalProviders/{providerId} { allow write: if false }
       registerLegalProvider   db().collection('legalProviders').doc(uid)
                                 .set({ providerId: uid, uid, … })

     The document is CF-ONLY — no client can write it at all — and its id IS the
     provider's uid, with providerId and uid stored as the same value. So the fee is
     not self-declared through a client write, and the payee is the document's own
     identity rather than a field that could point elsewhere. Both are checked for
     agreement below anyway: a document whose id, uid and providerId disagree is
     corrupt, and paying it would be guessing which one is the advocate.

     NO FALLBACK. legal-hub.html carried FOUR browser-side defaults —
     `l.depositAmount || 500`, `p.consultationFee || 500` in the CF mapping,
     `p.consultationFee || 5000` in the rate display, and `SERVICE_FEES.deposits.legal
     = 500` reached through SokoniPay.bookNow. Every one of them invents a price for an
     advocate who has not set one. A missing or non-positive fee FAILS CLOSED here. */
  legal_consultation: {
    resourceType: 'legalProvider',
    async price(uid, data) {
      const providerId = String(data.providerId || data.lawyerId || '').trim();
      if (!providerId) fail('invalid-argument', 'providerId is required.');

      const snap = await db().collection('legalProviders').doc(providerId).get();
      if (!snap.exists) fail('not-found', 'Advocate not found.');
      const p = snap.data() || {};

      /* getLegalProviders only ever lists status:'active'; anything else is not
         bookable and must not be payable either. */
      if (String(p.status || '') !== 'active') {
        fail('failed-precondition', 'This advocate is not currently accepting consultations.');
      }

      /* The three identities must agree. They are written together by
         registerLegalProvider, so a disagreement means the document was not written by
         that path and its payee is not established. */
      const docUid = p.uid && String(p.uid).trim();
      const docPid = p.providerId && String(p.providerId).trim();
      if (!docUid || !docPid || docUid !== providerId || docPid !== providerId) {
        fail('failed-precondition', 'This advocate record is inconsistent and cannot be paid.');
      }

      const kes = Number(p.consultationFee);
      if (!Number.isFinite(kes) || kes <= 0) {
        fail('failed-precondition',
             'This advocate has not set a consultation fee, so a deposit cannot be taken.');
      }

      if (providerId === uid) fail('failed-precondition', 'You cannot pay yourself.');

      return {
        amountCents: Math.round(kes * 100),
        currency: p.currency || 'KES',
        resourceType: 'legalProvider',
        resourceId: providerId,
        metadata: {
          type: 'legal-consultation',
          sellerUid: providerId,        /* == doc id == uid -> attribution -> wallet credit */
          destinationField: 'documentId',
          ownershipEnforced: true,      /* CF-only writes; id is the provider's uid */
          providerName: p.name || null,
          firmName: p.firmName || null,
        },
      };
    },
  },

  /* ── Digital hub: gig order, or accepted proposal (digital.html) ──────────
     TWO transaction types, and which one applies is decided by WHICH AUTHORITATIVE
     RECORD the caller names — not by a type string the browser sends:

       gigId      -> digitalGigs/{id}.price        paid to .sellerUid
       proposalId -> digitalProposals/{id}.bid     paid to .freelancerUid

     Exactly one must be named. Both is ambiguous and is refused rather than
     silently preferring one — a caller that can pick the cheaper record by sending
     both would be choosing its own price.

     DESTINATION PROVENANCE IS PROVEN HERE, unlike bnb_booking. firestore.rules
     enforces `sellerUid == request.auth.uid` on digitalGigs create and
     `freelancerUid == request.auth.uid` on digitalProposals create, so the payee on
     each record is the account that created it. Recorded as ownershipEnforced: true.

     WHO MAY PAY. A proposal is accepted by the JOB OWNER, so the caller is checked
     against digitalJobs/{jobId}. digital.html writes that owner as `posterUid` while
     the /digitalJobs rule names `employerUid`; firestore.rules already accepts either
     for reads, and this accepts either for the same reason. Neither matching is a
     permission-denied, not a default.

     A LATER BID EDIT CANNOT CHANGE WHAT IS CHARGED. The freelancer may update their
     own proposal, bid included. The amount is read once, here, and written into
     paymentIntents/{ref}; initiateSTKPush enforces the push against that document, and
     an idempotent replay whose amount differs FAILS CLOSED rather than re-pricing. */
  digital_order: {
    resourceType: 'digitalOrder',
    async price(uid, data) {
      const gigId      = String(data.gigId      || '').trim();
      const proposalId = String(data.proposalId || '').trim();

      if (gigId && proposalId) {
        fail('invalid-argument', 'Name either a gig or a proposal, not both.');
      }
      if (!gigId && !proposalId) {
        fail('invalid-argument', 'gigId or proposalId is required.');
      }

      let kes, sellerUid, kind, resourceId, title, extra;

      if (gigId) {
        const gSnap = await db().collection('digitalGigs').doc(gigId).get();
        if (!gSnap.exists) fail('not-found', 'Gig not found.');
        const g = gSnap.data() || {};
        if (g.status && ['deleted', 'paused', 'unpublished'].includes(String(g.status))) {
          fail('failed-precondition', 'This gig is not available to order.');
        }
        kes        = Number(g.price);
        sellerUid  = g.sellerUid && String(g.sellerUid).trim();
        kind       = 'gig';
        resourceId = gigId;
        title      = g.title || null;
        extra      = { gigId, category: g.category || null };
      } else {
        const pSnap = await db().collection('digitalProposals').doc(proposalId).get();
        if (!pSnap.exists) fail('not-found', 'Proposal not found.');
        const p = pSnap.data() || {};
        if (p.status && String(p.status) !== 'pending' && String(p.status) !== 'submitted') {
          fail('failed-precondition', 'This proposal is no longer open.');
        }

        /* Only the owner of the job may accept and pay for a proposal on it. */
        const jobId = String(p.jobId || '').trim();
        if (!jobId) fail('failed-precondition', 'This proposal is not attached to a job.');
        const jSnap = await db().collection('digitalJobs').doc(jobId).get();
        if (!jSnap.exists) fail('not-found', 'The job for this proposal no longer exists.');
        const j = jSnap.data() || {};
        const owner = (j.employerUid && String(j.employerUid)) || (j.posterUid && String(j.posterUid)) || null;
        if (!owner || owner !== uid) {
          fail('permission-denied', 'Only the owner of this job can accept a proposal on it.');
        }

        kes        = Number(p.bid);
        sellerUid  = p.freelancerUid && String(p.freelancerUid).trim();
        kind       = 'proposal';
        resourceId = proposalId;
        title      = j.title || null;
        extra      = { proposalId, jobId, category: j.category || null };
      }

      if (!Number.isFinite(kes) || kes <= 0) {
        fail('failed-precondition', 'This item has no payable price.');
      }
      if (!sellerUid) {
        fail('failed-precondition', 'This item has no payout destination and cannot be paid for.');
      }
      /* Paying yourself is never a real transaction, and it would move money in a
         circle through the platform's books. */
      if (sellerUid === uid) {
        fail('failed-precondition', 'You cannot pay yourself.');
      }

      return {
        amountCents: Math.round(kes * 100),
        currency: 'KES',
        resourceType: 'digitalOrder',
        resourceId,
        metadata: {
          type: 'digital-order',
          kind,                    /* 'gig' | 'proposal' */
          sellerUid,               /* -> attribution.sellerUid -> wallet credit */
          destinationField: kind === 'gig' ? 'sellerUid' : 'freelancerUid',
          ownershipEnforced: true, /* both are checked against the creator by firestore.rules */
          title,
          ...extra,
        },
      };
    },
  },

  /* ── BnB stay (bnb.html) ──────────────────────────────────────────────────
     The browser sends WHICH listing and WHICH dates. It never sends a price.

     PRICE FIELD PRECEDENCE — `pricePerNight` then `price`. Both exist on this
     collection and the divergence is real: firestore.rules mandates `price` in the
     CREATE key set and allows BOTH on update, while bnb.html — the surface that
     actually charges — reads only `pricePerNight`.

       On authority: admin-os.html, the canonical Admin surface, has NO BnB surface
       at all — zero references to bnbListings. BnB property administration exists
       only on the legacy admin.html, so there is no AdminOS convention to follow.
       This precedence is chosen because it charges exactly what the booking page
       charges today — migrating the rail must not silently reprice a listing — with
       `price` as the rules-mandated fallback.

     Neither present, or not a positive finite number, FAILS CLOSED. A listing with no
     price is not payable, and defaulting one would be the server inventing a charge.

     DESTINATION — resolved only from the listing document the server just read, never
     from the request. Order: sellerUid, hostSellerUid, hostUid.

       ⚠ Only `hostUid` is ownership-ENFORCED: the create rule requires
         `hostUid == request.auth.uid`. `sellerUid`/`hostSellerUid` are not in the
         create key set and are never compared to the creator, so a listing can carry
         an arbitrary one. They are still server-read, so no BROWSER can redirect a
         payment — but a host could have aimed their own listing elsewhere at create
         time. Recorded in metadata as destinationField so settlement and any later
         audit can see which was used. Tightening the rule is a separate decision.

     NIGHTS — derived here from the two dates, never accepted from the request. Dates
     are strict YYYY-MM-DD and compared as UTC midnights, so the count is exact and
     cannot drift with a timezone. */
  bnb_booking: {
    resourceType: 'bnbListing',
    async price(uid, data) {
      const listingId = String(data.listingId || data.bnbId || '').trim();
      if (!listingId) fail('invalid-argument', 'listingId is required.');

      const snap = await db().collection('bnbListings').doc(listingId).get();
      if (!snap.exists) fail('not-found', 'Listing not found.');
      const l = snap.data() || {};

      /* ── dates -> nights, server-side ── */
      const DATE = /^\d{4}-\d{2}-\d{2}$/;
      const checkIn  = String(data.checkIn  || '').trim();
      const checkOut = String(data.checkOut || '').trim();
      if (!DATE.test(checkIn) || !DATE.test(checkOut)) {
        fail('invalid-argument', 'checkIn and checkOut must be YYYY-MM-DD dates.');
      }
      const inMs  = Date.parse(checkIn  + 'T00:00:00Z');
      const outMs = Date.parse(checkOut + 'T00:00:00Z');
      if (!Number.isFinite(inMs) || !Number.isFinite(outMs)) {
        fail('invalid-argument', 'checkIn or checkOut is not a real date.');
      }
      const nights = (outMs - inMs) / 86400000;
      if (!Number.isInteger(nights) || nights < 1) {
        fail('invalid-argument', 'checkOut must be at least one night after checkIn.');
      }
      if (nights > MAX_NIGHTS) {
        fail('invalid-argument', `A stay may not exceed ${MAX_NIGHTS} nights.`);
      }

      /* ── price, from the listing ── */
      const perNight = Number(l.pricePerNight != null ? l.pricePerNight : l.price);
      if (!Number.isFinite(perNight) || perNight <= 0) {
        fail('failed-precondition', 'This listing has no nightly price and cannot be booked online.');
      }
      /* KES -> cents once, then multiplied by an integer night count. Rounding the
         rate (not the total) keeps N nights exactly N times one night. */
      const perNightCents = Math.round(perNight * 100);
      const cents = perNightCents * nights;

      /* ── destination, from the listing ── */
      const DEST = ['sellerUid', 'hostSellerUid', 'hostUid'];
      const destinationField = DEST.find((k) => l[k] && String(l[k]).trim());
      if (!destinationField) {
        fail('failed-precondition', 'This listing has no payout destination and cannot be booked online.');
      }
      const sellerUid = String(l[destinationField]).trim();

      return {
        amountCents: cents,
        currency: l.currency || 'KES',
        resourceType: 'bnbListing',
        resourceId: listingId,
        metadata: {
          type: 'bnb-booking',
          sellerUid,                 /* -> attribution.sellerUid -> wallet credit */
          destinationField,          /* which listing field supplied it */
          listingId,
          listingName: l.name || l.title || null,
          checkIn,
          checkOut,
          nights,
          perNightCents,
          ownershipEnforced: destinationField === 'hostUid',
        },
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
