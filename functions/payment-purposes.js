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

const { getFirestore } = require('firebase-admin/firestore');
const { HttpsError }   = require('firebase-functions/v2/https');

const db = () => getFirestore();

/* Provider floor/ceiling. Mirrors the subscription path so no purpose can mint
   an intent the provider will refuse, or a zero-value intent that would grant an
   entitlement for nothing. */
const MIN_KES = 1;
const MAX_KES = 150000;

const fail = (code, msg) => { throw new HttpsError(code, msg); };

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

  /* ── Hub registration ─────────────────────────────────────────────────
     Replaces the localStorage grant. The tier price is read from the hub
     catalogue so a merchant cannot register for an Enterprise hub at the
     Starter price by editing a request. */
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

module.exports = { PURPOSES, priceFor, isRegistered, registered, MIN_KES, MAX_KES };
