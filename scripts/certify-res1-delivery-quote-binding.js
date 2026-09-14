'use strict';
/* ════════════════════════════════════════════════════════════════════════════════════════════
   RES-1 CERTIFICATION — the delivery the rider is paid for is the delivery the buyer paid for.

   Gate C made the CHARGE authoritative. This gate makes the RIDER'S side of the same delivery
   authoritative, by carrying the identical pin from checkout to the dispatch record.

   WHAT THIS SUITE EXECUTES.
   The real `requestDeliveryQuote` and `createCheckoutSession` handlers out of the real
   `functions/index.js`, and the real `delivery-quote-carry` / `delivery-quote-endpoint` decision
   code, against an in-memory Firestore installed before the module graph loads. The producer's
   decision was previously unreachable — it sits inside a signature-verified IntaSend callback — so
   it was extracted into `delivery-quote-carry` precisely so it could be RUN here. A guard no test
   can drive is a guard nobody has checked.

   THE ASSERTION THAT MATTERS.
   Not "a quote is present" but "it is THE SAME quote, and nothing downstream minted another".
   The producer used to call the authority a second time; the decisive checks here are that the
   carried quoteId is identical to the checkout one and that the carry path issues NO new quote.

   Sabotage is in-process only — server guards are rebound on the live call path, source guards are
   mutated as strings. Nothing is written to disk, so a killed run cannot strand a mutation.

   Run:  node scripts/certify-res1-delivery-quote-binding.js
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-res1-cert';

const WATCHDOG = setTimeout(() => {
  process.stdout.write('\n  ✖ WATCHDOG — the suite did not finish in 180s. Failing closed.\n');
  process.exit(2);
}, 180000);

let PASS = 0, FAIL = 0, BLOCKED = 0;
const FAILURES = [];
const RESIDUALS = [];
const ok = (id, m) => { PASS++; console.log('  ✔ ' + id.padEnd(8) + m); return true; };
const bad = (id, m, x) => {
  FAIL++; FAILURES.push(id + ' — ' + m);
  console.log('  ✖ ' + id.padEnd(8) + m + (x ? '\n             ' + String(x).slice(0, 300) : ''));
  return false;
};
const blocked = (id, m) => { BLOCKED++; FAILURES.push(id + ' — BLOCKED: ' + m); console.log('  ⚠ ' + id.padEnd(8) + 'BLOCKED: ' + m); return false; };
const check = (id, c, m, x) => (c ? ok(id, m) : bad(id, m, x));
const section = (t) => console.log('\n' + t + '\n' + '─'.repeat(Math.max(t.length, 78)));

async function quiet(fn) {
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true; process.stderr.write = () => true;
  try { return await fn(); } finally { process.stdout.write = so; process.stderr.write = se; }
}

/* ── In-memory store ───────────────────────────────────────────────────────────────────────── */
function makeStore() {
  const data = new Map();
  let reads = [], writes = [];
  const key = (c, d) => c + '/' + d;
  const snapOf = (c, d) => {
    const v = data.get(key(c, d));
    return { id: d, exists: v !== undefined, ref: { path: key(c, d) }, data: () => (v === undefined ? undefined : Object.assign({}, v)) };
  };
  const collection = (c) => ({
    doc: (d) => ({
      id: String(d),
      get: async () => { reads.push(key(c, d)); return snapOf(c, d); },
      set: async (o) => { writes.push(key(c, d)); data.set(key(c, d), Object.assign({}, o)); },
      create: async (o) => {
        if (data.has(key(c, d))) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; }
        writes.push(key(c, d)); data.set(key(c, d), Object.assign({}, o));
      },
      update: async (o) => { writes.push(key(c, d)); data.set(key(c, d), Object.assign({}, data.get(key(c, d)) || {}, o)); },
      delete: async () => { writes.push(key(c, d)); data.delete(key(c, d)); },
    }),
    where: function (_f, _op, val) {
      const self = {
        where: () => self, limit: () => self, orderBy: () => self,
        get: async () => {
          const ids = Array.isArray(val) ? val : [val];
          const docs = ids.filter((i) => data.has(key(c, i))).map((i) => { reads.push(key(c, i)); return snapOf(c, i); });
          return { empty: !docs.length, size: docs.length, docs, forEach: (f) => docs.forEach(f) };
        },
      };
      return self;
    },
  });
  return {
    collection,
    _put: (c, d, o) => data.set(key(c, d), Object.assign({}, o)),
    _patch: (c, d, o) => data.set(key(c, d), Object.assign({}, data.get(key(c, d)) || {}, o)),
    _get: (c, d) => (data.has(key(c, d)) ? Object.assign({}, data.get(key(c, d))) : null),
    _del: (c, d) => data.delete(key(c, d)),
    _count: (c) => [...data.keys()].filter((k) => k.startsWith(c + '/')).length,
    _trace: () => ({ reads: reads.slice(), writes: writes.slice() }),
    _clearTrace: () => { reads = []; writes = []; },
  };
}
const STORE = makeStore();

/* A transaction that behaves like Firestore's for the one property under test: reads happen
   first, writes are collected and applied on commit. */
function makeTx(store) {
  const pending = [];
  return {
    tx: {
      get: async (ref) => ref.get(),
      update: (ref, obj) => pending.push(['update', ref, obj]),
      set: (ref, obj) => pending.push(['set', ref, obj]),
    },
    async commit() { for (const [op, ref, obj] of pending) await ref[op](obj); return pending.length; },
    pendingCount: () => pending.length,
  };
}

/* ── Load the production graph ─────────────────────────────────────────────────────────────── */
let admin, idx, dqEndpoint, dqCarry, dqa, APPROVED;
try {
  admin = require(require.resolve('firebase-admin', { paths: [FN] }));
  const real = admin.firestore;
  const stub = function () { return STORE; };
  Object.getOwnPropertyNames(real).forEach((k) => {
    if (k === 'length' || k === 'name' || k === 'prototype') return;
    try { stub[k] = real[k]; } catch (_) { /* non-configurable */ }
  });
  /* `firestore` is a prototype GETTER: assignment throws in strict mode and fails SILENTLY in
     sloppy mode, so a stub can look installed while every call hits the real backend. */
  Object.defineProperty(admin, 'firestore', { value: stub, configurable: true, writable: true });
  if (admin.firestore() !== STORE) throw new Error('the Firestore stub did not take effect — refusing to run against a real backend');

  dqa = require(path.join(FN, 'delivery-quote-authority.js'));
  dqEndpoint = require(path.join(FN, 'delivery-quote-endpoint.js'));
  dqCarry = require(path.join(FN, 'delivery-quote-carry.js'));
  APPROVED = require(path.join(ROOT, 'scripts', 'write-delivery-pricing-policy.js')).APPROVED;
  idx = require(path.join(FN, 'index.js'));
} catch (e) {
  console.log('\n  ✖ SETUP — could not load the production modules: ' + (e && e.message));
  console.log((e && e.stack || '').split('\n').slice(0, 8).join('\n'));
  clearTimeout(WATCHDOG); process.exit(2);
}

/* ── Fixtures ──────────────────────────────────────────────────────────────────────────────── */
const BUYER = 'buyer-res1', OTHER = 'other-res1', SELLER = 'seller-res1';
const PRODUCT = 'prod-res1', UNIT_PRICE = 1500;
const POLICY = Object.assign({}, APPROVED, { effectiveFrom: new Date(Date.now() - 86400000).toISOString() });

function seed() {
  STORE._put('platformConfig', 'deliveryPricing', JSON.parse(JSON.stringify(POLICY)));
  STORE._put('products', PRODUCT, { name: 'RES-1 Item', price: UNIT_PRICE, sellerUid: SELLER, stock: 100 });
  STORE._put('shops', SELLER, { open: true });
}
seed();

const REQ = (uid, data) => ({ data, auth: { uid, token: { uid } }, rawRequest: { headers: {}, ip: '127.0.0.1' }, acceptsStreaming: false });
const CART = [{ productId: PRODUCT, qty: 1 }];
const TRIP = (o) => Object.assign({ distanceKm: 8, estimatedMinutes: 26, shipment: { totalWeightKg: 3, packageCount: 1 } }, o || {});
const issue = (uid, o) => quiet(() => idx.requestDeliveryQuote.run(REQ(uid || BUYER, TRIP(o))));
const checkout = (data, uid) => quiet(() => idx.createCheckoutSession.run(REQ(uid || BUYER, data)));

/* The step `verifyIntasendPayment` performs, exercised through the REAL binder. The order write
   mirrors the fields the handler sets; the binding itself is production code, not a re-write. */
async function createOrderFromSession(sessionId, orderId, opts) {
  const s = STORE._get('checkoutSessions', sessionId);
  const t = makeTx(STORE);
  const dqId = (s && s.deliveryQuoteId) || null;
  const existing = dqId ? await STORE.collection(dqEndpoint.QUOTES).doc(String(dqId)).get() : null;
  STORE._put('orders', orderId, {
    orderId, sessionId, uid: (s && s.uid) || null, sellerUid: SELLER,
    deliveryFee: (s && s.deliveryFee) || 0,
    deliveryQuoteId: (s && s.deliveryQuoteId) || null,
    deliveryQuote: (opts && opts.pinOverride !== undefined) ? opts.pinOverride : ((s && s.deliveryQuote) || null),
  });
  dqEndpoint.bindQuoteToOrderTx(t.tx, STORE, dqId, orderId, (s && s.uid) || null, existing);
  await t.commit();
  return STORE._get('orders', orderId);
}

/* A fresh quote + session + order in one step. Each order gets its OWN quote deliberately: the
   binder refuses a second order on the same quote, which is the point of the gate — a fixture that
   reused one would be testing the fixture. */
async function freshOrder(orderId, pinOverride) {
  const q = (await issue()).quoteId;
  const s = (await quiet(() => checkout({ cartItems: CART, deliveryQuoteId: q, fulfillmentType: 'delivery' }))).sessionId;
  await createOrderFromSession(s, orderId, pinOverride === undefined ? undefined : { pinOverride });
  return { quoteId: q, sessionId: s };
}

async function refuses(id, fn, matcher, what) {
  let threw = null, ret;
  try { ret = await fn(); } catch (e) { threw = e; }
  if (!threw) return bad(id, what + ' — NOT refused', 'returned ' + JSON.stringify(ret).slice(0, 160));
  if (threw instanceof TypeError || threw instanceof ReferenceError) return bad(id, what + ' — CRASHED rather than refused', threw.message);
  const text = (threw.message || '') + ' ' + (threw.reason || '');
  if (!matcher.test(text)) return bad(id, what + ' — refused for the WRONG reason', text.slice(0, 200));
  return ok(id, what + ' → ' + (threw.reason || threw.message || '').slice(0, 80));
}

/* ── Source readers (stripped — the RES-1 comments quote the patterns under test) ───────────── */
const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/[^\n]*$/gm, ' ');
const INDEX_RAW = fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
const INDEX = strip(INDEX_RAW);
const DISPATCH = strip(fs.readFileSync(path.join(FN, 'dispatch.js'), 'utf8'));

function producerBody(src) {
  const a = src.indexOf('(2b) Delivery dispatch');
  const start = a >= 0 ? a : src.indexOf('packageRequests').valueOf();
  if (start < 0) return null;
  const end = src.indexOf('deliveryPins', start);
  return end > start ? src.slice(start, end) : null;
}

const D = {
  producerMintsAQuote: (s) => { const b = producerBody(s); return b === null ? null : /_dqa\s*\.\s*quote\s*\(/.test(b); },
  producerCarries: (s) => { const b = producerBody(s); return b === null ? null : /_dqCarry\s*\.\s*deliveryPricingForOrder\s*\(/.test(b); },
  sessionCarriesPin: (s) => /deliveryQuote:\s*_deliveryQuote\s*\?\s*_deliveryQuote\.pinned/.test(s),
  orderCarriesPin: (s) => /deliveryQuote:\s*\(sessionDoc && sessionDoc\.deliveryQuote\)/.test(s),
  orderBindsQuote: (s) => /_dqEndpoint\.bindQuoteToOrderTx\s*\(/.test(s),
  dispatchSettlesFromPin: (s) => /assertSettleable\s*\(\s*delivery\.deliveryQuote/.test(s),
  dispatchUsesDriverNet: (s) => /increment\s*\(\s*delivery\.driverNet/.test(s),
};

/* ════════════════════════════════════════════════════════════════════════════════════════════ */
async function main() {
  console.log('\n════════════════════════════════════════════════════════════════════════════════');
  console.log('  RES-1 — THE DELIVERY QUOTE IS CARRIED FROM CHECKOUT TO THE RIDER');
  console.log('  Real handlers, executed. Firestore replaced in memory. Nothing deployed.');
  console.log('════════════════════════════════════════════════════════════════════════════════');

  section('0  HARNESS');
  check('H0-1', typeof idx.createCheckoutSession.run === 'function', 'the REAL createCheckoutSession is invocable');
  check('H0-2', typeof dqCarry.deliveryPricingForOrder === 'function', 'the producer decision is EXTRACTED and directly executable');
  check('H0-3', (await quiet(() => STORE.collection('platformConfig').doc('deliveryPricing').get())).exists, 'the approved v1 policy is seeded and in force');
  check('H0-4', strip('a /* _dqa.quote( */ b').indexOf('_dqa.quote') === -1, 'CONTROL — the comment stripper removes comments');
  check('H0-5', D.producerMintsAQuote('(2b) Delivery dispatch\n _dqa.quote({x}) \n deliveryPins') === true,
    'CONTROL — the "producer mints a quote" detector fires when the pattern IS present');

  section('1  REACHABILITY — does the pin actually travel checkout → session → order → rider?');
  const q1 = (await issue()).quoteId;
  const s1 = (await quiet(() => checkout({ cartItems: CART, deliveryQuoteId: q1, fulfillmentType: 'delivery' }))).sessionId;
  const sess1 = STORE._get('checkoutSessions', s1);
  check('R1-1', !!sess1 && sess1.deliveryQuoteId === q1, 'the SESSION carries the quote id');
  check('R1-2', !!sess1 && !!sess1.deliveryQuote && sess1.deliveryQuote.quoteId === q1,
    'the SESSION carries the settlement-shaped pin');
  check('R1-3', !!sess1 && !!sess1.deliveryQuote && !!sess1.deliveryQuote.pricingInputs
    && !!sess1.deliveryQuote.pricingInputs.policy,
    'the pin carries pricingInputs.policy — without it the renegotiation guard cannot run at settlement');

  const o1 = await createOrderFromSession(s1, 'ORD-RES1-1');
  check('R1-4', !!o1.deliveryQuote && o1.deliveryQuote.quoteId === q1, 'the ORDER carries the same pin');

  STORE._clearTrace();
  const p1 = await dqCarry.deliveryPricingForOrder(STORE, { orderId: 'ORD-RES1-1' });
  check('R1-5', !p1.pricingBlocked && p1.quoteId === q1,
    'the DISPATCH RECORD carries the same quote id — ' + String(p1.quoteId).slice(0, 20) + '…');
  check('R1-6', p1.quotePinSource === 'order', 'sourced from the order (' + p1.quotePinSource + ')');
  {
    const t = STORE._trace();
    check('R1-7', t.reads.includes('orders/ORD-RES1-1'), 'proven by execution trace: the producer READ the order');
    check('R1-8', t.reads.includes('platformConfig/deliveryPricing'), '…and re-read the policy to revalidate the pin');
    check('R1-9', !t.reads.includes('orders/never-created-control'), 'CONTROL — the trace records only what was really read');
  }

  section('2  NOT MINTED — the decisive anti-regression check');
  {
    const before = STORE._count('deliveryQuotes');
    await dqCarry.deliveryPricingForOrder(STORE, { orderId: 'ORD-RES1-1' });
    const after = STORE._count('deliveryQuotes');
    check('M2-1', after === before, 'the carry path issues NO new quote (deliveryQuotes ' + before + ' → ' + after + ')');
  }
  check('M2-2', D.producerMintsAQuote(INDEX) === false, 'the webhook producer no longer calls _dqa.quote(');
  check('M2-3', D.producerCarries(INDEX) === true, '…it calls _dqCarry.deliveryPricingForOrder( instead');
  check('M2-4', D.sessionCarriesPin(INDEX) === true, 'createCheckoutSession writes the pin onto the session');
  check('M2-5', D.orderCarriesPin(INDEX) === true, 'verifyIntasendPayment copies it from the SESSION onto the order (not from the client)');

  section('3  COVARIANCE & INTEGRITY — the rider is paid out of the quote the buyer paid');
  {
    const pin = STORE._get('orders', 'ORD-RES1-1').deliveryQuote;
    const stored = STORE._get('deliveryQuotes', q1);
    check('C3-1', pin.riderEarning.minorUnits === stored.riderEarningMinor
      && pin.customerCharge.minorUnits === stored.customerChargeMinor
      && pin.sokoniCommission.minorUnits === stored.sokoniCommissionMinor,
      'every figure on the rider\'s pin is IDENTICAL to the issued quote, not a re-derivation');
    check('C3-2', pin.customerCharge.minorUnits === pin.riderEarning.minorUnits + pin.sokoniCommission.minorUnits,
      'conservation holds across the boundary: charge = rider + commission');
    check('C3-3', Math.round(stored.customerChargeMinor / 100) === sess1.deliveryFee,
      'the carried charge is the figure the buyer was actually billed (KES ' + sess1.deliveryFee + ')');
    const settled = dqa.assertSettleable(pin, null, { currentPolicy: POLICY });
    check('C3-4', settled.minorUnits === stored.riderEarningMinor,
      'what settlement would credit (' + settled.minorUnits + ') equals the quoted rider earning');
  }
  {
    /* Move the quote and everything downstream must move with it. */
    const q2 = (await issue(BUYER, { distanceKm: 30, estimatedMinutes: 75 })).quoteId;
    const s2 = (await quiet(() => checkout({ cartItems: CART, deliveryQuoteId: q2, fulfillmentType: 'delivery' }))).sessionId;
    await createOrderFromSession(s2, 'ORD-RES1-2');
    const p2 = await dqCarry.deliveryPricingForOrder(STORE, { orderId: 'ORD-RES1-2' });
    const e1 = STORE._get('deliveryQuotes', q1).riderEarningMinor;
    const e2 = STORE._get('deliveryQuotes', q2).riderEarningMinor;
    check('C3-5', !p2.pricingBlocked && p2.deliveryQuote.riderEarning.minorUnits === e2 && e2 !== e1,
      'a longer trip carries a DIFFERENT rider earning (' + e1 + ' → ' + e2 + ') — derivation, not a constant');
  }

  section('4  TAMPERING — a pin that could not settle is never written as though it could');
  {
    const probe = await freshOrder('ORD-TAMPER-0');
    const good = STORE._get('orders', 'ORD-TAMPER-0').deliveryQuote;

    const inflate = JSON.parse(JSON.stringify(good));
    inflate.riderEarning.minorUnits += 50000;
    await freshOrder('ORD-TAMPER-1', inflate);
    const r = await dqCarry.deliveryPricingForOrder(STORE, { orderId: 'ORD-TAMPER-1' });
    check('T4-1', r.pricingBlocked === 'pinned_quote_conservation_violated',
      'a pin inflated to overpay the rider → pricingBlocked (' + r.pricingBlocked + ')');
    check('T4-2', r.riderFeeKES === undefined && r.deliveryQuote === undefined,
      '…and NO price is written alongside the refusal');

    const band = JSON.parse(JSON.stringify(good));
    band.riderEarning.minorUnits = band.customerCharge.minorUnits;
    band.sokoniCommission.minorUnits = 0;
    await freshOrder('ORD-TAMPER-2', band);
    const r2 = await dqCarry.deliveryPricingForOrder(STORE, { orderId: 'ORD-TAMPER-2' });
    check('T4-3', r2.pricingBlocked === 'pinned_share_out_of_band', 'a pin moved outside the 16–25% band → ' + r2.pricingBlocked);

    const ver = JSON.parse(JSON.stringify(good));
    ver.pricingVersion = 'dq-0.0.1';
    await freshOrder('ORD-TAMPER-3', ver);
    const r3 = await dqCarry.deliveryPricingForOrder(STORE, { orderId: 'ORD-TAMPER-3' });
    check('T4-4', r3.pricingBlocked === 'pricing_version_mismatch', 'a pin on a superseded pricingVersion → ' + r3.pricingBlocked);

    const rc = await dqCarry.deliveryPricingForOrder(STORE, { orderId: 'ORD-TAMPER-0' });
    check('T4-C', !rc.pricingBlocked && rc.quoteId === probe.quoteId,
      'CONTROL — an UNTAMPERED pin of the same shape still carries (the guard does not refuse everybody)');
  }

  section('5  MISSING / DRIFTED — fail-closed, preserved exactly');
  {
    STORE._put('orders', 'ORD-NOPIN', { orderId: 'ORD-NOPIN', sessionId: null, sellerUid: SELLER });
    const r = await dqCarry.deliveryPricingForOrder(STORE, { orderId: 'ORD-NOPIN' });
    check('F5-1', r.pricingBlocked === 'no_pinned_quote', 'an order with no pin → ' + r.pricingBlocked);
    check('F5-2', !('riderFeeKES' in r) && !('deliveryQuote' in r) && !('quoteId' in r),
      '…and carries NO price of any kind — an unpriced delivery is visible, an invented one becomes a rider\'s pay');
    const r0 = await dqCarry.deliveryPricingForOrder(STORE, {});
    check('F5-3', r0.pricingBlocked === 'no_pinned_quote', 'no order id at all → refused, never a default price');
  }
  {
    const q = (await issue()).quoteId;
    const s = (await quiet(() => checkout({ cartItems: CART, deliveryQuoteId: q, fulfillmentType: 'delivery' }))).sessionId;
    /* The webhook-first race: the order exists without the pin, the session still has it. */
    STORE._put('orders', 'ORD-RACE', { orderId: 'ORD-RACE', sessionId: s, sellerUid: SELLER });
    const r = await dqCarry.deliveryPricingForOrder(STORE, { orderId: 'ORD-RACE' });
    check('F5-4', !r.pricingBlocked && r.quoteId === q && r.quotePinSource === 'session',
      'an order written before the pin lands falls back to the SESSION, the single server-authored origin');
  }
  {
    const q = (await issue()).quoteId;
    const s = (await quiet(() => checkout({ cartItems: CART, deliveryQuoteId: q, fulfillmentType: 'delivery' }))).sessionId;
    await createOrderFromSession(s, 'ORD-DRIFT');
    STORE._patch('platformConfig', 'deliveryPricing', { policyVersion: 'v2' });
    const r = await dqCarry.deliveryPricingForOrder(STORE, { orderId: 'ORD-DRIFT' });
    check('F5-5', r.pricingBlocked === 'earning_renegotiated',
      'the policy moved after the quote was pinned → ' + r.pricingBlocked + ' — a rider agreed to a number and is never silently re-priced');
    STORE._patch('platformConfig', 'deliveryPricing', { policyVersion: 'v1' });

    const saved = STORE._get('platformConfig', 'deliveryPricing');
    STORE._del('platformConfig', 'deliveryPricing');
    const r2 = await dqCarry.deliveryPricingForOrder(STORE, { orderId: 'ORD-DRIFT' });
    check('F5-6', r2.pricingBlocked === 'pricing_policy_required', 'no policy at all → ' + r2.pricingBlocked);
    STORE._put('platformConfig', 'deliveryPricing', saved);

    const r3 = await dqCarry.deliveryPricingForOrder(STORE, { orderId: 'ORD-DRIFT' });
    check('F5-C', !r3.pricingBlocked, 'CONTROL — with the approved policy restored, the pin carries again');
  }

  section('6  LIFECYCLE — one quote, one order');
  {
    const q = (await issue()).quoteId;
    const s = (await quiet(() => checkout({ cartItems: CART, deliveryQuoteId: q, fulfillmentType: 'delivery' }))).sessionId;
    check('L6-1', STORE._get('deliveryQuotes', q).status === 'issued', 'before the order the quote is still issued');
    await createOrderFromSession(s, 'ORD-LIFE-1');
    const after = STORE._get('deliveryQuotes', q);
    check('L6-2', after.status === 'consumed' && after.orderId === 'ORD-LIFE-1',
      'creating the order CONSUMES it and stamps the order — Gate C checked this state; nothing ever wrote it until now');
    await refuses('L6-3', () => dqEndpoint.resolveQuoteForCheckout(q, BUYER, STORE),
      /already_used/, 'the consumed quote can no longer back a second checkout');
    await createOrderFromSession(s, 'ORD-LIFE-1');
    check('L6-4', STORE._get('deliveryQuotes', q).orderId === 'ORD-LIFE-1',
      'rebinding the SAME order is idempotent — a webhook replay is harmless');
  }
  {
    const q = (await issue()).quoteId;
    const s = (await quiet(() => checkout({ cartItems: CART, deliveryQuoteId: q, fulfillmentType: 'delivery' }))).sessionId;
    await createOrderFromSession(s, 'ORD-LIFE-2');
    await refuses('L6-5', async () => {
      const t = makeTx(STORE);
      const ex = await STORE.collection(dqEndpoint.QUOTES).doc(q).get();
      dqEndpoint.bindQuoteToOrderTx(t.tx, STORE, q, 'ORD-LIFE-OTHER', BUYER, ex);
    }, /already_bound/, 'binding an already-bound quote to a DIFFERENT order');
  }
  {
    const q = (await issue(OTHER)).quoteId;
    await refuses('L6-6', async () => {
      const t = makeTx(STORE);
      const ex = await STORE.collection(dqEndpoint.QUOTES).doc(q).get();
      dqEndpoint.bindQuoteToOrderTx(t.tx, STORE, q, 'ORD-FOREIGN', BUYER, ex);
    }, /not_yours/, 'binding another account\'s quote');
    await refuses('L6-7', async () => {
      const t = makeTx(STORE);
      const ex = await STORE.collection(dqEndpoint.QUOTES).doc('dq-does-not-exist').get();
      dqEndpoint.bindQuoteToOrderTx(t.tx, STORE, 'dq-does-not-exist', 'ORD-GHOST', BUYER, ex);
    }, /not_found/, 'binding a quote id that was never issued');
  }
  check('L6-8', D.orderBindsQuote(INDEX) === true,
    'the order transaction calls bindQuoteToOrderTx — consumption is atomic with order creation');

  section('7  SETTLEMENT — dispatch already reads the pin, and nothing else');
  check('S7-1', D.dispatchSettlesFromPin(DISPATCH) === true, 'dispatch.js settles via assertSettleable(delivery.deliveryQuote)');
  check('S7-2', D.dispatchUsesDriverNet(DISPATCH) === false, 'it does NOT credit delivery.driverNet — the browser-authored figure');
  check('S7-3', /_settleBlocked/.test(DISPATCH) && /earningsBlocked/.test(DISPATCH),
    'a pin it cannot revalidate withholds the CREDIT only, records the reason, and keeps the rider\'s proof');

  section('8  SABOTAGE — per guard, in process, nothing written to disk');
  await sabotage('X8-1', 'assertSettleable (a tampered pin cannot be carried)',
    () => { const o = dqa.assertSettleable; dqa.assertSettleable = () => ({ minorUnits: 0 }); return () => { dqa.assertSettleable = o; }; },
    async () => {
      const q = (await issue()).quoteId;
      const s = (await quiet(() => checkout({ cartItems: CART, deliveryQuoteId: q, fulfillmentType: 'delivery' }))).sessionId;
      const pin = JSON.parse(JSON.stringify(STORE._get('checkoutSessions', s).deliveryQuote));
      pin.riderEarning.minorUnits += 50000;
      await createOrderFromSession(s, 'ORD-SAB-1', { pinOverride: pin });
      const r = await dqCarry.deliveryPricingForOrder(STORE, { orderId: 'ORD-SAB-1' });
      return !r.pricingBlocked;
    });

  /* NO FALLBACK PRICE — asserted on the module's own source rather than by rebinding.
     `deliveryPricingForOrder` calls `findCarriedPin` lexically, so patching the export would not
     reach the running code: a "sabotage" aimed there passes whatever the product does, which is
     worse than no check. The real property is that there is NOWHERE for a price to come from —
     the module never calls the quote authority's issuer and holds no money literal — so removing
     the refusal could only crash, never invent a figure. */
  {
    const CARRY = strip(fs.readFileSync(path.join(FN, 'delivery-quote-carry.js'), 'utf8'));
    const mints = (s) => /\bdqa\s*\.\s*quote\s*\(/.test(s);
    const moneyLiteral = (s) => /minorUnits\s*[:=]\s*\d/.test(s) || /=\s*\d{2,}\s*;/.test(s);
    check('X8-2a', mints(CARRY) === false, 'the carry module never calls the quote ISSUER — it cannot mint a price');
    check('X8-2b', moneyLiteral(CARRY) === false, '…and holds no money literal to fall back on');
    sabotageText('X8-2c', 'giving the carry module a fallback price',
      CARRY.replace('throw new dqa.QuoteRefused(\'no_pinned_quote\',', 'pinned = { riderEarning: { minorUnits: 18000 } }; throw new dqa.QuoteRefused(\'no_pinned_quote\','),
      (s) => moneyLiteral(s) === true, 'the no-fallback detector must flag it');
  }

  await sabotage('X8-3', 'the quote-consumption writer (one quote, one order)',
    () => { const o = dqEndpoint.bindQuoteToOrderTx; dqEndpoint.bindQuoteToOrderTx = () => {}; return () => { dqEndpoint.bindQuoteToOrderTx = o; }; },
    async () => {
      const q = (await issue()).quoteId;
      const s = (await quiet(() => checkout({ cartItems: CART, deliveryQuoteId: q, fulfillmentType: 'delivery' }))).sessionId;
      await createOrderFromSession(s, 'ORD-SAB-3');
      return STORE._get('deliveryQuotes', q).status === 'issued';   /* never consumed */
    });

  sabotageText('X8-4', 'restoring the webhook\'s own _dqa.quote( call',
    INDEX.replace('_dqCarry.deliveryPricingForOrder(', '_dqa.quote('),
    (s) => D.producerMintsAQuote(s) === true && D.producerCarries(s) === false,
    'detectors M2-2 and M2-3 must both flag it');
  sabotageText('X8-5', 'dropping the pin from the checkout session',
    INDEX.replace(/deliveryQuote:\s*_deliveryQuote \? _deliveryQuote\.pinned : null,/, ''),
    (s) => D.sessionCarriesPin(s) === false, 'detector M2-4 must flag it');
  sabotageText('X8-6', 'sourcing the order\'s pin from the CLIENT instead of the session',
    INDEX.replace(/deliveryQuote:\s*\(sessionDoc && sessionDoc\.deliveryQuote\)\s*\|\|\s*null,/, 'deliveryQuote: req.body.deliveryQuote || null,'),
    (s) => D.orderCarriesPin(s) === false, 'detector M2-5 must flag it');
  sabotageText('X8-7', 'settling from the browser-authored driverNet again',
    DISPATCH.replace(/assertSettleable\(\s*\n?\s*delivery\.deliveryQuote/, 'increment(delivery.driverNet'),
    (s) => D.dispatchSettlesFromPin(s) === false, 'detector S7-1 must flag it');

  {
    const q = (await issue()).quoteId;
    const s = (await quiet(() => checkout({ cartItems: CART, deliveryQuoteId: q, fulfillmentType: 'delivery' }))).sessionId;
    await createOrderFromSession(s, 'ORD-RESTORE');
    const r = await dqCarry.deliveryPricingForOrder(STORE, { orderId: 'ORD-RESTORE' });
    check('X8-R', !r.pricingBlocked && r.quoteId === q && STORE._get('deliveryQuotes', q).status === 'consumed',
      'POST-SABOTAGE — every guard restored: the pin carries and the quote is consumed exactly once');
  }

  section('9  RESIDUAL — proven here, deliberately NOT changed under this gate');
  {
    const CO = strip(fs.readFileSync(path.join(ROOT, 'checkout.html'), 'utf8'));
    const browserWrite = /SokoniDelivery\.createOrderDelivery/.test(CO)
      && /deliveryFee:\s*result\.deliveryFee/.test(CO);
    const settlementReads = /Number\(order\.deliveryFee\s*\|\|\s*0\)/
      .test(strip(fs.readFileSync(path.join(FN, 'order-settlement.js'), 'utf8')));
    /* THIS DETECTOR ONCE REPORTED A DEFECT THAT DID NOT EXIST.
       It found a client producer and a server consumer and called the path open, without checking
       the layer between them. The 2026-09-14 rules census evaluated the DEPLOYED ruleset: no
       client branch permits `deliveryFee` on orders, so the browser write was refused every time
       and `.catch(function(){})` hid it. The write has since been removed (RES-1b), and the
       boundary is pinned by scripts/certify-res1b-seller-settlement.js against the live engine.

       What remains here is the honest form of the check: a client write to that field is a defect
       REGARDLESS of whether the rules currently stop it, because dead code aimed at a settlement
       field becomes live the day somebody widens an allowlist. But it is no longer described as a
       live money defect, because it is not one. */
    if (browserWrite && settlementReads) {
      RESIDUALS.push(
        'A client write to orders/{id}.deliveryFee has REAPPEARED in checkout.html. '
        + 'order-settlement._grossCents subtracts that field from the seller\'s gross. The deployed '
        + 'rules deny such a write today, so this is not (yet) a money defect — but it is dead code '
        + 'aimed at a settlement field and becomes live the moment an allowlist is widened. '
        + 'RES-1b removed it; run scripts/certify-res1b-seller-settlement.js.');
      console.log('  ○ RES-1b  a client write to orders.deliveryFee has reappeared (see summary)');
    } else {
      ok('RES-1b', 'no client write targets orders.deliveryFee — the settlement field has no browser producer');
    }
  }

  return finish();
}

/* Neutralise a guard on the LIVE call path and require the hostile input to get through. A
   "sabotage" whose patch the running code never consults passes whatever the product does — so
   every use here targets a call site that is genuinely a property lookup at call time. */
async function sabotage(id, what, patch, probe) {
  const restore = patch();
  let got = false, err = null;
  try { got = await probe(); } catch (e) { err = e; }
  finally { restore(); }
  if (err) return bad(id, 'removing ' + what + ' — the probe CRASHED', err.message);
  return got
    ? ok(id, 'removing ' + what + ' lets the defect through — the guard is load-bearing')
    : bad(id, 'removing ' + what + ' changed NOTHING — decorative, or another layer is hiding it');
}

function sabotageText(id, what, src, detector, expectation) {
  let flagged;
  try { flagged = detector(src) === true; } catch (e) { return bad(id, what + ' — detector CRASHED', e.message); }
  return flagged
    ? ok(id, 'SABOTAGE ' + what + ' → detected (' + expectation + ')')
    : bad(id, 'SABOTAGE ' + what + ' → NOT detected — ' + expectation);
}

function finish() {
  section('SUMMARY');
  console.log('  passed  : ' + PASS);
  console.log('  failed  : ' + FAIL);
  console.log('  blocked : ' + BLOCKED);
  if (FAILURES.length) { console.log('\n  FAILURES:'); FAILURES.forEach((f) => console.log('   • ' + f)); }
  const green = FAIL === 0 && BLOCKED === 0;
  console.log('\n  ' + (green ? '✅ RES-1: GREEN' : '❌ RES-1: NOT GREEN') + '  (blocked counts as not-green; a hang exits 2)');
  console.log('  Certification only. Nothing here deploys anything.\n');
  clearTimeout(WATCHDOG);
  process.exit(green ? 0 : 1);
}

main().catch((e) => {
  console.log('\n  ✖ SUITE CRASHED — a crash is not a pass.');
  console.log('    ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n    ') : String(e)));
  clearTimeout(WATCHDOG); process.exit(2);
});
