'use strict';
/**
 * B1 — product payment amount authority.
 *
 *   node scripts/test-product-payment-authority.js
 *
 * The defect: `initiateSTKPush` accepted a client-computed `orderTotal` for
 * category 'product', so a crafted client could pay below catalogue price while
 * the webhook still decremented stock. The invariant this suite defends:
 *
 *   catalogue price → server recomputation → paymentIntent.amount
 *                   → payment → stock decrement
 *
 * never
 *
 *   client amount → payment → stock decrement
 *
 * No credentials, no network: the pricer is exercised against a fake Firestore.
 */

const path = require('path');
const fs = require('fs');
const Module = require('module');

let pass = 0, fail = 0;
const t = async (n, fn) => {
  try { await fn(); console.log('  PASS  ' + n); pass++; }
  catch (e) { console.log('  FAIL  ' + n + ' — ' + e.message); fail++; }
};
const eq = (a, b, m) => { if (a !== b) throw new Error((m ? m + ': ' : '') + 'expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); };
const throws = async (fn, re) => {
  let e = null; try { await fn(); } catch (x) { e = x; }
  if (!e) throw new Error('expected a throw, got none');
  if (re && !re.test(e.message)) throw new Error('wrong error: ' + e.message);
  return e;
};

/* ── Fake Firestore ───────────────────────────────────────────────────────── */
const DATA = {
  products: {
    P1: { name: 'Maize Flour 2kg', price: 250, sellerUid: 'S1', stock: 10 },
    P2: { name: 'Cooking Oil 1L',  price: 400, salePrice: 320, sellerUid: 'S1', stock: 4 },
    P_OOS:    { name: 'Sugar',   price: 300, sellerUid: 'S1', stock: 0 },
    P_HIDDEN: { name: 'Hidden',  price: 100, sellerUid: 'S1', stock: 5, status: 'archived' },
    P_OTHER:  { name: 'Other',   price: 150, sellerUid: 'S2', stock: 5 },
    P_FREE:   { name: 'NoPrice', price: 0,   sellerUid: 'S1', stock: 5 },
  },
  sellers: { S1: { deliveryConfig: { enabled: true, mode: 'flat', flatFee: 150 } }, S2: {} },
  shopState: {},
};

function fakeFirestore() {
  const coll = (name) => ({
    doc: (id) => ({ get: async () => ({ exists: !!(DATA[name] || {})[id], data: () => (DATA[name] || {})[id] }) }),
    /* U7c2 (2026-09-29): the charge path now reads the shop's LIVE OFFERS (shopOffers where shopId == … where status
       == 'live'). This fixture's shop has none — an empty answer, which is a real "no offers", not a failed read (a
       failed read correctly REFUSES the charge rather than overcharge). */
    where: name === 'shopOffers'
      ? () => ({ where: () => ({ limit: () => ({ get: async () => ({ docs: [], empty: true, size: 0 }) }) }) })
      : (_f, _op, ids) => ({
      get: async () => ({
        forEach: (cb) => ids.filter((i) => (DATA[name] || {})[i])
          .forEach((i) => cb({ id: i, data: () => DATA[name][i] })),
      }),
    }),
  });
  return { collection: coll };
}

/* Stub the module graph so payment-purposes loads without firebase-admin. */
const FN = path.resolve(__dirname, '..', 'functions');
const origResolve = Module._resolveFilename;
const origLoad = Module._load;
class HttpsError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}
Module._load = function (req, parent, isMain) {
  if (req === 'firebase-admin/firestore')
    return { getFirestore: () => fakeFirestore(), FieldPath: { documentId: () => '__name__' } };
  /* U7c2: the charge path now loads shop-offers.js, which declares its callables at load — the stub provides onCall */
  if (req === 'firebase-functions/v2/https') return { HttpsError, onCall: (_o, h) => (h || _o) };
  if (req === 'firebase-functions/logger') return { info() {}, warn() {}, error() {} };
  if (req === './availability-enforce' || req.endsWith('availability-enforce'))
    return { itemAvailability: (p) => ({ available: p.status !== 'archived' && p.hidden !== true }) };
  if (req.includes('delivery-engine'))
    return { calculateDelivery: (cfg) => ({ fee: cfg.flatFee || 0, deliverable: true, reason: 'flat' }) };
  return origLoad.apply(this, arguments);
};

const P = require(path.join(FN, 'payment-purposes.js'));
const price = (data, uid = 'BUYER1') => P.priceFor('product_order', uid, data);
const CART = { orderId: 'SKNORDER1', items: [{ productId: 'P1', qty: 2 }], sellerUid: 'S1' };

(async () => {
  console.log('B1 — PRODUCT PAYMENT AMOUNT AUTHORITY\n');

  await t('product_order is a registered purpose', () => {
    if (!P.isRegistered('product_order')) throw new Error('not registered');
  });

  await t('amount derives from catalogue price × qty', async () => {
    const q = await price(CART);
    eq(q.amount, 500, '250 × 2');
    eq(q.metadata.pricingSource, 'server_recomputed');
  });

  await t('salePrice wins over price when present', async () => {
    const q = await price({ ...CART, items: [{ productId: 'P2', qty: 2 }] });
    eq(q.amount, 640, '320 × 2, not 400 × 2');
  });

  /* THE DEFECT ITSELF. */
  await t('a client-supplied amount CANNOT lower the charge', async () => {
    const q = await price({ ...CART, amount: 1, orderTotal: 1, total: 1, amountCents: 100 });
    eq(q.amount, 500, 'client figures must be ignored entirely');
  });
  await t('a client-supplied amount cannot RAISE the charge either', async () => {
    const q = await price({ ...CART, amount: 99999, orderTotal: 99999 });
    eq(q.amount, 500);
  });
  await t('a tampered unit price in the request is ignored', async () => {
    const q = await price({ ...CART, items: [{ productId: 'P1', qty: 2, price: 1, unitPrice: 1, lineTotal: 2 }] });
    eq(q.amount, 500, 'price must come from the catalogue, not the line item');
  });

  await t('delivery fee is server-recomputed and added', async () => {
    const q = await price({ ...CART, fulfillmentType: 'delivery' });
    eq(q.amount, 650, '500 + 150 flat');
    eq(q.metadata.deliveryFee, 150);
    eq(q.metadata.deliverySource, 'delivery-engine');
  });
  await t('a client-supplied deliveryFee is ignored', async () => {
    const q = await price({ ...CART, fulfillmentType: 'delivery', deliveryFee: 0 });
    eq(q.amount, 650);
  });
  await t('pickup is not charged delivery', async () => {
    const q = await price({ ...CART, fulfillmentType: 'pickup' });
    eq(q.amount, 500); eq(q.metadata.deliveryFee, 0);
  });
  await t('an unconfigured merchant charges zero delivery, never a client figure', async () => {
    const q = await price({ orderId: 'O2', items: [{ productId: 'P_OTHER', qty: 1 }],
      sellerUid: 'S2', fulfillmentType: 'delivery', deliveryFee: 900 });
    eq(q.amount, 150); eq(q.metadata.deliverySource, 'unconfigured');
  });

  await t('out-of-stock is rejected, not silently priced', () =>
    throws(() => price({ ...CART, items: [{ productId: 'P_OOS', qty: 1 }] }), /out of stock/i));
  await t('quantity above remaining stock is rejected', () =>
    throws(() => price({ ...CART, items: [{ productId: 'P2', qty: 99 }] }), /Only 4/));
  await t('an archived product is rejected', () =>
    throws(() => price({ ...CART, items: [{ productId: 'P_HIDDEN', qty: 1 }] }), /not currently available/i));
  await t('a product missing from the catalogue is REJECTED, not skipped', () =>
    /* createCheckoutSession skips; here the buyer is about to be charged, so a
       dropped line would charge a total for a different cart than they saw. */
    throws(() => price({ ...CART, items: [{ productId: 'GHOST', qty: 1 }] }), /no longer available/i));
  await t('a zero-price product is rejected', () =>
    throws(() => price({ ...CART, items: [{ productId: 'P_FREE', qty: 1 }] }), /no price/i));
  await t('a multi-seller cart is rejected', () =>
    throws(() => price({ ...CART, items: [{ productId: 'P1', qty: 1 }, { productId: 'P_OTHER', qty: 1 }] }),
      /one shop at a time/i));
  await t('an empty cart is rejected', () => throws(() => price({ orderId: 'O', items: [] }), /empty/i));
  await t('a missing orderId is rejected', () =>
    throws(() => price({ items: [{ productId: 'P1', qty: 1 }] }), /orderId required/i));

  await t('the intent ref is the deterministic order id', async () => {
    const q = await price(CART);
    eq(q.preferredRef, 'SKNORDER1', 'paymentRef must equal orderId so payments/{ref} ↔ orders/{ref} holds');
    eq(q.resourceId, 'SKNORDER1');
  });

  await t('qty is clamped to a sane range', async () => {
    const q = await price({ ...CART, items: [{ productId: 'P1', qty: -5 }] });
    eq(q.amount, 250, 'negative qty must floor to 1, never produce a credit');
  });

  /* ── Source-level guarantees ───────────────────────────────────────────── */
  const purposesSrc = fs.readFileSync(path.join(FN, 'payment-purposes.js'), 'utf8');
  const intentsSrc  = fs.readFileSync(path.join(FN, 'payment-intents.js'), 'utf8');
  const checkoutSrc = fs.readFileSync(path.resolve(FN, '..', 'checkout.html'), 'utf8');

  await t('the pricer never reads an amount from the request', () => {
    const blk = purposesSrc.slice(purposesSrc.indexOf('product_order:'), purposesSrc.indexOf('hub_registration:'));
    if (/data\.(amount|orderTotal|total|price|deliveryFee)\b/.test(blk))
      throw new Error('the pricer reads a monetary value from the request');
  });

  await t('createPaymentIntent honours preferredRef', () => {
    if (!/quote\.preferredRef \? String\(quote\.preferredRef\) : _mintRef\(\)/.test(intentsSrc))
      throw new Error('deterministic ref not wired');
  });

  await t('replay is idempotent and fails closed on conflict', () => {
    for (const re of [/ALREADY_EXISTS/, /sameBuyer/, /sameAmount/, /replay: true/, /terminal/])
      if (!re.test(intentsSrc)) throw new Error('missing replay guard: ' + re);
    if (!/permission-denied/.test(intentsSrc)) throw new Error('identity mismatch does not fail closed');
  });

  await t('checkout sends the SERVER amount, not its own total', () => {
    if (!/initiateSTKPush\(phone, _authTotal, _ordId/.test(checkoutSrc))
      throw new Error('STK still charges the client-computed orderTotal');
    if (!/waitForConfirmation\(_ordId, \{ amount: _authTotal/.test(checkoutSrc))
      throw new Error('confirmation still compares against the client total');
    if (!/purpose:\s*'product_order'/.test(checkoutSrc))
      throw new Error('checkout does not mint a product_order intent');
  });

  await t('enforcement (Commit B) is NOT yet enabled', () => {
    /* Deliberate: adding "product" before this client ships breaks payments with
       STAGE_1B_REFUSED. This assertion flips in Commit B. */
    const idx = fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
    if (/_enforcedCategories = \["subscription", *"product"\]/.test(idx))
      throw new Error('enforcement enabled in Commit A — deploy the client first');
  });

  Module._load = origLoad; Module._resolveFilename = origResolve;
  console.log('\n' + pass + '/' + (pass + fail) + ' passed' + (fail ? '  — ' + fail + ' FAILED' : ''));
  process.exit(fail ? 1 : 0);
})();
