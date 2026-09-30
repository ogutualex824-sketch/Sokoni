/* ============================================================================
   SOKONI — Multi-Shop Checkout Quote  (server-authoritative)
   ============================================================================
   ONE customer checkout experience over a basket that may span several shops,
   with delivery priced INDEPENDENTLY per shop and a single consolidated,
   server-issued quote the payment path consumes. The customer sees one total;
   SOKONI records one order/fulfilment per shop underneath.

   ── What this module IS ─────────────────────────────────────────────────────
   The orchestration ABOVE the existing single-shop authority. It does NOT
   re-implement money validation. Item prices arrive already server-validated
   (unitPrice resolved from the product document by the canonical
   `product_order` validator in payment-purposes.js — the Single-Shop Checkout
   Invariant, docs/CHECKOUT_CONTRACT.md). Delivery is priced through the ONE
   shared engine (shared/delivery-engine.js) that checkout, POS and the payment
   path already use, so a shop's fee cannot fork.

   The pure core (`assembleQuote`) takes numbers and configs and returns a quote
   — no Firestore, no network, no writes — so it is testable without an emulator
   and identical wherever it runs. `makeCreateQuote` is a thin onCall factory
   whose Firestore/auth dependencies are INJECTED, so this file has NO hard
   dependency on peer-owned payment code and never forks item-price validation.

   ── Invariants this module enforces ─────────────────────────────────────────
   • The browser is never authoritative for money. Every unitPrice consumed here
     must come from the server-side product validator; a line without a positive
     server unitPrice is rejected, never defaulted.
   • Delivery is NEVER free by default. Free only where the shop's own
     deliveryConfig makes it free (mode 'free', freeAbove threshold, or a zero
     zone/own_fleet fee) — the engine decides, not this module and not the client.
   • A shop with no delivery config that the customer asked to have delivered is
     surfaced as available:false (delivery_not_offered) — not silently free.
   • The quote is authoritative and time-boxed. The payment path MUST call
     `revalidateQuote` with freshly re-read server data before charging or
     creating orders, so a stale or drifted quote cannot settle.

   ── Payment-rail boundary (owned by the checkout/payment agent) ──────────────
   • IntaSend / platform-MoR MAY collect the grandTotal in one payment, then
     create per-shop orders from this authoritative quote.
   • Direct-to-Till / manual-Till MUST NOT be presented as one atomic
     payment — each shop follows its own rail's semantics (one payment → one
     order per shop). This module produces the per-shop breakdown that lets the
     payment layer do either; it does not choose the rail and it never enables
     manual_payment.
   ========================================================================= */
'use strict';

const DELIVERY = require('./shared/delivery-engine.js');

const CURRENCY = 'KES';
const DEFAULT_TTL_MS = 15 * 60 * 1000; /* a quote is good for 15 minutes */

function _round(n) { return Math.max(0, Math.round(Number(n) || 0)); }

/* ── assembleQuote — PURE ────────────────────────────────────────────────────
   input.validatedLines : [{ productId, qty, unitPrice, sellerUid, name? }]
       unitPrice is SERVER-AUTHORITATIVE (from the product_order validator).
       This function trusts it as the price of record and rejects a line that
       has no positive server price rather than inventing one.
   input.sellerConfigs  : { [sellerUid]: { shopName?, deliveryConfig } }
   input.order          : { fulfillmentType: 'delivery'|'pickup', distanceKm?, zone? }
   input.now, input.ttlMs, input.genId : injectable clock / TTL / id (tests) */
function assembleQuote(input) {
  input = input || {};
  const validatedLines = input.validatedLines;
  const sellerConfigs = input.sellerConfigs || {};
  const order = input.order || {};
  const now = input.now != null ? Number(input.now) : Date.now();
  const ttlMs = input.ttlMs != null ? Number(input.ttlMs) : DEFAULT_TTL_MS;
  const genId = input.genId || function () {
    return 'q_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  };

  if (!Array.isArray(validatedLines) || validatedLines.length === 0) {
    throw new Error('assembleQuote: validatedLines is required and must be non-empty');
  }

  const wantsDelivery =
    String(order.fulfillmentType || '').toLowerCase() === 'delivery';

  /* Partition by shop, preserving first-appearance order. */
  const seen = [];
  const byShop = {};
  for (const l of validatedLines) {
    const sid = String((l && (l.sellerUid || l.sellerId)) || '');
    if (!sid) {
      /* Matches the Single-Shop Invariant's refusal: a line whose seller the
         server could not establish is not checkout-able. Never fill the gap. */
      throw new Error('assembleQuote: every line must carry a server-resolved sellerUid');
    }
    const qty = Math.max(1, Math.round(Number(l.qty) || 1));
    const unitPrice = Number(l.unitPrice);
    if (!(unitPrice > 0)) {
      throw new Error('assembleQuote: line ' + (l && l.productId) +
        ' has no server-authoritative unitPrice > 0 (client prices are never trusted)');
    }
    if (!byShop[sid]) { byShop[sid] = { sellerUid: sid, items: [], itemTotal: 0 }; seen.push(sid); }
    const lineTotal = _round(unitPrice * qty);
    byShop[sid].items.push({
      productId: String((l && l.productId) || ''),
      name: (l && l.name) || null,
      qty,
      unitPrice: _round(unitPrice),
      lineTotal,
    });
    byShop[sid].itemTotal += lineTotal;
  }

  const shops = seen.map(function (sid) {
    const s = byShop[sid];
    s.itemTotal = _round(s.itemTotal);
    const wrap = sellerConfigs[sid] || {};
    const cfg = wrap.deliveryConfig || null;

    let delivery;
    if (!wantsDelivery) {
      /* Pickup: no delivery charge, and we say so explicitly rather than
         implying "free delivery" (a different, seller-granted thing). */
      delivery = {
        available: null, fee: 0, free: false, reason: 'pickup',
        mode: 'pickup', policy: { configured: !!(cfg && cfg.enabled !== undefined) },
      };
    } else {
      const calc = DELIVERY.calculateDelivery(cfg || {}, {
        subtotal: s.itemTotal,
        distanceKm: order.distanceKm,
        zone: order.zone,
      });
      delivery = {
        available: calc.deliverable === true,
        fee: calc.deliverable ? _round(calc.fee) : 0,
        free: calc.free === true,
        reason: calc.reason,
        mode: calc.mode,
        etaMinutes: calc.etaMinutes == null ? null : Number(calc.etaMinutes),
        policy: {
          configured: !!(cfg && cfg.enabled !== undefined),
          freeAbove: (cfg && cfg.freeAbove != null) ? Number(cfg.freeAbove) : null,
        },
      };
    }

    /* Only a deliverable shop adds a delivery charge; an undeliverable shop's
       fee is 0 and the checkout layer must resolve it (pickup, remove, or block
       — a policy decision that belongs to the payment/checkout agent). */
    const chargedDelivery = delivery.available === true ? delivery.fee : 0;
    const shopTotal = _round(s.itemTotal + chargedDelivery);

    return {
      sellerUid: sid,
      shopName: wrap.shopName || null,
      items: s.items,
      itemTotal: s.itemTotal,
      delivery,
      shopTotal,
    };
  });

  const itemsTotal = _round(shops.reduce(function (n, s) { return n + s.itemTotal; }, 0));
  const deliveryTotal = _round(shops.reduce(function (n, s) {
    return n + (s.delivery.available === true ? s.delivery.fee : 0);
  }, 0));
  const grandTotal = _round(itemsTotal + deliveryTotal);

  return {
    quoteId: genId(),
    createdAt: now,
    expiresAt: now + ttlMs,
    currency: CURRENCY,
    fulfillmentType: wantsDelivery ? 'delivery' : 'pickup',
    shopCount: shops.length,
    shops,
    itemsTotal,
    deliveryTotal,
    grandTotal,
    /* Every shop with delivery requested is actually deliverable — a convenience
       flag for the checkout layer; per-shop `delivery.available` is the truth. */
    allDeliverable: wantsDelivery
      ? shops.every(function (s) { return s.delivery.available === true; })
      : null,
    authoritative: true,
  };
}

/* ── revalidateQuote ─────────────────────────────────────────────────────────
   The payment path MUST call this with FRESHLY re-read server data before it
   charges or creates orders. It re-derives the quote from the same inputs under
   the stored quote's own id/clock and refuses on expiry or any amount drift, so
   a stale basket or a tampered stored total can never settle. */
function revalidateQuote(storedQuote, freshInput, deps) {
  deps = deps || {};
  const now = deps.now != null ? Number(deps.now) : Date.now();
  if (!storedQuote || storedQuote.authoritative !== true) {
    return { ok: false, reason: 'not_authoritative' };
  }
  if (now > Number(storedQuote.expiresAt || 0)) {
    return { ok: false, reason: 'expired' };
  }
  const fresh = assembleQuote(Object.assign({}, freshInput, {
    now: Number(storedQuote.createdAt),
    ttlMs: Number(storedQuote.expiresAt) - Number(storedQuote.createdAt),
    genId: function () { return storedQuote.quoteId; },
  }));
  if (fresh.grandTotal !== Number(storedQuote.grandTotal)) {
    return { ok: false, reason: 'amount_drift', expected: Number(storedQuote.grandTotal), recomputed: fresh.grandTotal };
  }
  return { ok: true, quote: fresh };
}

/* ── makeCreateQuote — onCall factory, dependencies INJECTED ──────────────────
   Production wiring (coordinated with the checkout/payment agent; NOT in this
   isolated slice) supplies:
     validateLines(uid, items)     -> [{ productId, qty, unitPrice, sellerUid, name }]
         MUST be the canonical product_order authority (server product prices +
         availability + stock). Do NOT fork item-price validation.
     readSellerConfigs(sellerUids) -> { [uid]: { shopName, deliveryConfig } }
     persistQuote(quote)           -> Promise   (e.g. checkoutQuotes/{quoteId})
   Kept dependency-injected so this module is unit-testable and touches no
   peer-owned file. */
function makeCreateQuote(deps) {
  deps = deps || {};
  const validateLines = deps.validateLines;
  const readSellerConfigs = deps.readSellerConfigs;
  const persistQuote = deps.persistQuote;
  if (typeof validateLines !== 'function' ||
      typeof readSellerConfigs !== 'function' ||
      typeof persistQuote !== 'function') {
    throw new Error('makeCreateQuote: validateLines, readSellerConfigs and persistQuote are required');
  }
  return async function createMultiShopCheckoutQuote(uid, data) {
    data = data || {};
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) throw new Error('Cart is empty.');

    const validatedLines = await validateLines(uid, items);
    const sellerUids = [];
    for (const l of validatedLines) {
      const sid = String((l && (l.sellerUid || l.sellerId)) || '');
      if (sid && sellerUids.indexOf(sid) === -1) sellerUids.push(sid);
    }
    const sellerConfigs = await readSellerConfigs(sellerUids);

    const quote = assembleQuote({
      validatedLines,
      sellerConfigs,
      order: {
        fulfillmentType: data.fulfillmentType,
        distanceKm: data.distanceKm,
        zone: data.deliveryZone,
      },
      now: deps.now,
      ttlMs: deps.ttlMs,
      genId: deps.genId,
    });

    await persistQuote(quote);
    return quote;
  };
}

module.exports = { assembleQuote, revalidateQuote, makeCreateQuote, DEFAULT_TTL_MS, CURRENCY };

/* ── onCall: createMultiShopCheckoutQuote (production wiring) ─────────────────
   Reuses the CANONICAL product_order validator (payment-purposes.validateOrderLines
   — NO forked money validation) and the shared delivery engine, and persists the
   quote so the payment path can revalidate before charging. App Check enforced to
   match the checkout callables (getShopCheckoutMode). Requiring this module for its
   pure functions (tests) does not initialise firebase-admin: getFirestore() is
   called only INSIDE the handler, never at module load. This assignment is placed
   AFTER module.exports above so the object reassignment cannot wipe it. */
const { onCall: _onCall, HttpsError: _HttpsError } = require('firebase-functions/v2/https');
const { getFirestore: _getFirestore } = require('firebase-admin/firestore');

const QUOTE_CFG = { region: 'us-central1', enforceAppCheck: true, memory: '256MiB', timeoutSeconds: 30 };

module.exports.createMultiShopCheckoutQuote = _onCall(QUOTE_CFG, async (request) => {
  if (!request.auth) throw new _HttpsError('unauthenticated', 'Sign in required.');
  const uid  = request.auth.uid;
  const data = request.data || {};
  const db   = _getFirestore();

  const create = makeCreateQuote({
    /* Canonical validator — server-authoritative lines. NO second money validator. */
    validateLines: async (u, items) => {
      const { validateOrderLines } = require('./payment-purposes');
      const { lines } = await validateOrderLines(u, items);
      return lines;
    },
    /* Per-shop delivery config from the seller doc — the SAME source product_order reads. */
    readSellerConfigs: async (sellerUids) => {
      const out = {};
      await Promise.all((sellerUids || []).map(async (sid) => {
        const snap = await db.collection('sellers').doc(String(sid)).get().catch(() => null);
        const d = snap && snap.exists ? (snap.data() || {}) : {};
        out[String(sid)] = { shopName: d.shopName || d.name || null, deliveryConfig: d.deliveryConfig || null };
      }));
      return out;
    },
    /* Persist for revalidation before payment/order creation. */
    persistQuote: async (quote) => {
      await db.collection('checkoutQuotes').doc(String(quote.quoteId))
        .set({ ...quote, uid }).catch(() => {});
    },
  });

  try {
    return await create(uid, data);
  } catch (e) {
    throw new _HttpsError('failed-precondition', (e && e.message) || 'Could not build checkout quote.');
  }
});
