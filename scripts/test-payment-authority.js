/* Server pricing authority — the exploit must not survive.

   The defect: darajaSTKPush took `amount` from the browser and handed it to
   Safaricom unchecked. Setting orderTotal = 1 in the console bought a full
   cart for KES 1 and produced a genuine M-Pesa receipt.

   These tests extract the real pricing block from functions/index.js and run
   it against a fake Firestore. They assert the CHARGED amount, because that is
   the only number that moves money — a test that only checked "did it throw"
   would pass against the vulnerable code. */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

/* ── Fake Firestore: only what the pricing block touches ─────────────────── */
const CATALOGUE = {
  vape1: { price: 2500, sellerUid: 'SELLER_A', status: 'active' },
  vape2: { price: 1800, sellerUid: 'SELLER_A', status: 'active' },
  other: { price: 900,  sellerUid: 'SELLER_B', status: 'active' },
  gone:  { price: 500,  sellerUid: 'SELLER_A', status: 'archived' },
};
const audits = [];
const db = {
  collection: (c) => ({
    doc: (id) => ({
      get: async () => ({ exists: !!CATALOGUE[id], data: () => CATALOGUE[id] }),
    }),
    add: async (d) => { if (c === 'auditLogs') audits.push(d); return { id: 'a' }; },
  }),
};
class HttpsError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}
const admin = { firestore: { FieldValue: { serverTimestamp: () => 'TS' } } };

/* ── Extract the real block from source. Testing a copy would let the two
      drift apart silently, which is how the original comment ended up
      describing behaviour that did not exist. ──────────────────────────── */
const SRC = fs.readFileSync(path.join(__dirname, '..', 'functions', 'index.js'), 'utf8');
const START = '/* ── Server pricing authority';
/* Anchored on CODE, not a comment. The previous anchor was the comment
   "Load seller's Daraja credentials from Firestore", which commit 5ee7e3a
   rewrote into the LEGACY PATH block when per-merchant credential collection was
   retired. The pricing block's boundary did not move — only the prose above it
   changed — but the test could no longer find its end and failed with "could not
   locate the pricing block", blocking an unrelated hosting deploy.
   `const settingsSnap = await db.collection("shopSettings")` is the first line
   after the pricing block and appears exactly once in the file. Code changes
   only when behaviour changes; a comment can be reworded by any refactor that
   touches the neighbourhood. The trailing legacy-path comment now falls inside
   the slice, which is inert — it is a comment, and the slice is executed. */
const END = '    const settingsSnap = await db.collection("shopSettings")';
const s = SRC.indexOf(START), e = SRC.indexOf(END, s);
if (s < 0 || e < 0) {
  console.log('  FAIL  could not locate the pricing block in functions/index.js');
  process.exit(1);
}
const BLOCK = SRC.slice(s, e);

/* eslint-disable no-new-func */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
/* The pricing block calls `_availability.isPubliclyListed(p)` to refuse unlisted products.
   That module is required at the top of functions/index.js, far outside this slice, so the
   slice cannot resolve it on its own and threw ReferenceError before the first assertion —
   silently converting the whole suite from 22/0 into no coverage at all. Inject the REAL
   module rather than a stub: a stub would let the pricing block and the sellability engine
   drift apart, which is the exact failure this suite extracts real source to avoid. */
const _availability = require(path.join(__dirname, '..', 'functions', 'shared', 'sellability'));

const priceIt = new AsyncFunction('db', 'admin', 'HttpsError', '_availability', 'request', 'amount', 'items', 'sellerUid', 'orderId',
  '"use strict";' + BLOCK + '; return { authoritativeAmount, pricingSource, pricedItems };');

const run = (o) => priceIt(db, admin, HttpsError, _availability,
  { auth: { uid: 'BUYER' }, data: { deliveryFee: o.deliveryFee } },
  o.amount, o.items, o.sellerUid || 'SELLER_A', o.orderId || 'SKN1');

(async () => {
  console.log('\n── The exploit ──');
  {
    /* A KES 4,300 cart with the client claiming it costs KES 1. */
    const r = await run({ amount: 1, items: [{ productId: 'vape1', qty: 1 }, { productId: 'vape2', qty: 1 }] });
    ck('charge is the catalogue total, not the client claim', r.authoritativeAmount === 4300, 'charged ' + r.authoritativeAmount);
    ck('client amount is discarded entirely', r.authoritativeAmount !== 1);
    ck('pricing marked server_recomputed', r.pricingSource === 'server_recomputed');
    ck('under-payment attempt is audited as high severity',
       audits.some((a) => a.type === 'payment_amount_mismatch' && a.severity === 'high' && a.clientAmount === 1));
  }

  console.log('\n── Quantity and delivery ──');
  {
    const r = await run({ amount: 0, items: [{ productId: 'vape1', qty: 3 }] });
    ck('quantity multiplies server-side', r.authoritativeAmount === 7500, 'charged ' + r.authoritativeAmount);
  }
  {
    const r = await run({ amount: 0, items: [{ productId: 'vape2', qty: 1 }], deliveryFee: 300 });
    ck('delivery fee is added', r.authoritativeAmount === 2100, 'charged ' + r.authoritativeAmount);
  }
  {
    /* Delivery is the one client-influenced input, so it must be bounded. */
    const r = await run({ amount: 0, items: [{ productId: 'vape2', qty: 1 }], deliveryFee: 9999999 });
    ck('inflated delivery fee is capped at 5000', r.authoritativeAmount === 6800, 'charged ' + r.authoritativeAmount);
    const r2 = await run({ amount: 0, items: [{ productId: 'vape2', qty: 1 }], deliveryFee: -5000 });
    ck('negative delivery fee cannot discount', r2.authoritativeAmount === 1800, 'charged ' + r2.authoritativeAmount);
  }

  console.log('\n── Rejections ──');
  const throws = async (label, o, codeWanted) => {
    try { await run(o); ck(label, false, 'did not throw'); }
    catch (e) { ck(label, e.code === codeWanted, e.code + ': ' + e.message.slice(0, 40)); }
  };
  await throws('cross-seller cart rejected',
    { amount: 0, items: [{ productId: 'vape1', qty: 1 }, { productId: 'other', qty: 1 }] }, 'failed-precondition');
  await throws('non-active product rejected',
    { amount: 0, items: [{ productId: 'gone', qty: 1 }] }, 'failed-precondition');
  await throws('unknown product rejected',
    { amount: 0, items: [{ productId: 'nope', qty: 1 }] }, 'not-found');
  await throws('zero quantity rejected',
    { amount: 0, items: [{ productId: 'vape1', qty: 0 }] }, 'invalid-argument');
  await throws('negative quantity rejected',
    { amount: 0, items: [{ productId: 'vape1', qty: -5 }] }, 'invalid-argument');
  await throws('missing productId rejected',
    { amount: 0, items: [{ qty: 1 }] }, 'invalid-argument');
  await throws('oversized cart rejected',
    { amount: 0, items: Array.from({ length: 101 }, () => ({ productId: 'vape1', qty: 1 })) }, 'invalid-argument');

  console.log('\n── SmartPOS till path preserved ──');
  {
    /* No line items: an operator keyed the amount at a till. This must keep
       working — breaking it takes live merchants offline. */
    const r = await run({ amount: 750, items: null });
    ck('operator-entered amount is honoured', r.authoritativeAmount === 750, 'charged ' + r.authoritativeAmount);
    ck('marked as operator-entered, not server-priced', r.pricingSource === 'client_operator_entered');
  }
  await throws('zero amount with no items still rejected', { amount: 0, items: null }, 'invalid-argument');

  /* These exist because node --check passed while pricedItems was declared
     inside the `if` block and read outside it — a ReferenceError on every
     call that syntax checking cannot see. Scope is behaviour, so it is
     asserted like behaviour. */
  console.log('\n── Line items reach the callback (scope + payload) ──');
  {
    const r = await run({ amount: 0, items: [{ productId: 'vape1', qty: 2 }] });
    ck('pricedItems is in scope outside the pricing block', r.pricedItems !== undefined);
    ck('pricedItems carries productId and qty',
       Array.isArray(r.pricedItems) && r.pricedItems[0].productId === 'vape1' && r.pricedItems[0].qty === 2,
       JSON.stringify(r.pricedItems));
    ck('unit price recorded for reconciliation', r.pricedItems[0].unitPrice === 2500);
  }
  {
    const r = await run({ amount: 750, items: null });
    ck('POS path leaves pricedItems null, not undefined', r.pricedItems === null);
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
