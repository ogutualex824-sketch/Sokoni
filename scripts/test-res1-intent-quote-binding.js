'use strict';
/**
 * CERTIFICATION — RES-1 option 2: the quote on the SERVER-OWNED payment intent is bound and carried.
 *
 * The live Place Order path has no checkout session. The buyer's delivery charge is priced from a
 * RES-1 quote by createPaymentIntent('product_order'), which records it on paymentIntents/{orderId}.
 * Before this repair the webhook never looked there:
 *   - fulfillmentType came from browser STK meta, which never carried it, so EVERY STK order defaulted
 *     to "delivery" and a PICKUP order was dispatched to a rider;
 *   - the carry looked for the pin on the order / a session — browser-writable fields — found none on
 *     the main path, and created every delivery `pricingBlocked` (no rider could be paid), while a
 *     browser-written pin on the order was carried unbound as though it were authority.
 *
 * The seven proofs (owner, 2026-09-27), each driven through the REAL functions out of functions/index.js:
 *   [A] wrong payment/order pairing fails          [B] wrong buyer fails
 *   [C] a forged browser quote/session is not authority
 *   [D] pickup generates no delivery dispatch      [E] duplicate webhook = one binding, one rider credit
 *   [F] an already-bound quote fails closed        [G] webhook-first works without browser verification
 *
 * REAL: requestDeliveryQuote, createCheckoutSession, createPaymentIntent, initiateSTKPush (its ONE
 * outbound HTTPS call to IntaSend is answered by a local stub), webhookIntasend (challenge-verified),
 * delivery-quote-carry, rider-entitlement. MIRRORED: the browser's own Firestore writes (the pending
 * order, a forged pin) — done with the Admin SDK, i.e. assuming the browser CAN write them (B2).
 *
 *   REPAIR_ROOT  tree under test (default: this repo). The pre-repair tree must FAIL.
 * Refuses without FIRESTORE_EMULATOR_HOST.
 */
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set. This suite only runs against an emulator.');
  process.exit(2);
}
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-res1-intent';
/* Test-only secret values. defineSecret().value() reads process.env; nothing here is a real secret. */
const CHALLENGE = 'test-challenge-res1-opt2';
process.env.INTASEND_WEBHOOK_CHALLENGE = CHALLENGE;
process.env.INTASEND_PRIVATE_KEY = 'test-private-key-not-real';
const WATCHDOG = setTimeout(() => { console.log('\n  ✖ WATCHDOG — suite exceeded 300s'); process.exit(3); }, 300000);

/* ── The ONE outbound call: IntaSend's STK endpoint. Anything else leaving the process is refused. ── */
const _realRequest = https.request;
let stkCalls = 0;
const blockedCalls = [];
https.request = function (a0, a1, a2) {
  /* (options, cb) or (url, [options], cb) — the forms node accepts. */
  const isUrl = typeof a0 === 'string' || a0 instanceof URL;
  const u = isUrl ? new URL(String(a0)) : null;
  const opts = isUrl ? Object.assign({ hostname: u.hostname, path: u.pathname }, typeof a1 === 'object' ? a1 : {}) : a0;
  const cb = isUrl ? (typeof a1 === 'function' ? a1 : a2) : a1;
  const host = (opts && (opts.hostname || opts.host)) || '';
  if (!/intasend\.com$/.test(host) || !/mpesa-stk-push/.test(String(opts.path || ''))) {
    const req = new EventEmitter();
    let done = false;
    const fail = () => { if (!done) { done = true; setImmediate(() => req.emit('error', new Error('outbound blocked by test: ' + host))); } };
    Object.assign(req, { write: () => true, end: fail, abort: () => {}, destroy: () => {}, setTimeout: () => req,
      setHeader: () => {}, getHeader: () => undefined, removeHeader: () => {}, setNoDelay: () => {}, setSocketKeepAlive: () => {} });
    blockedCalls.push(host);
    return req;
  }
  stkCalls++;
  const req = new EventEmitter();
  req.write = () => {};
  req.end = () => setImmediate(() => {
    const res = new EventEmitter(); res.statusCode = 201;
    cb(res);
    res.emit('data', JSON.stringify({ id: 'CHK-' + stkCalls, checkout_id: 'CHK-' + stkCalls }));
    res.emit('end');
  });
  return req;
};
void _realRequest;

const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
let idx, dqCarry, RE, APPROVED;
try {
  idx = require(path.join(FN, 'index.js'));
  dqCarry = require(path.join(FN, 'delivery-quote-carry.js'));
  RE = require(path.join(FN, 'rider-entitlement.js'));
  APPROVED = require(path.join(ROOT, 'scripts', 'write-delivery-pricing-policy.js')).APPROVED;
} catch (e) {
  console.log('  ✖ SETUP — could not load the functions under test: ' + (e && e.message));
  process.exit(2);
}
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

let pass = 0, fail = 0;
const ok = (cond, id, msg) => { if (cond) { pass++; console.log('  PASS', id, msg); } else { fail++; console.log('  FAIL', id, msg); } };
async function quiet(fn) {
  const so = process.stdout.write.bind(process.stdout), se = process.stderr.write.bind(process.stderr);
  const cw = console.warn, ce = console.error, cl = console.log;
  process.stdout.write = () => true; process.stderr.write = () => true;
  console.warn = () => {}; console.error = () => {}; console.log = () => {};
  try { return await fn(); } finally {
    process.stdout.write = so; process.stderr.write = se; console.warn = cw; console.error = ce; console.log = cl;
  }
}

const SELLER = 'r1o2-seller', PRODUCT = 'r1o2-prod', PRICE = 1200, PHONE = '254712345678';
const REQ = (uid, data) => ({ data, auth: { uid, token: { uid } }, rawRequest: { headers: {}, ip: '127.0.0.1' }, acceptsStreaming: false });
const TRIP = { distanceKm: 8, estimatedMinutes: 26, shipment: { totalWeightKg: 3, packageCount: 1 } };
const ITEMS = [{ productId: PRODUCT, qty: 1 }];
const get = async (c, id) => { const s = await db.collection(c).doc(String(id)).get(); return s.exists ? s.data() : null; };
const where = async (c, f, v) => (await db.collection(c).where(f, '==', v).get()).docs.map((d) => ({ id: d.id, ...d.data() }));

async function issueQuote(uid) { return quiet(() => idx.requestDeliveryQuote.run(REQ(uid, TRIP))); }
async function mkIntent(uid, orderId, fulfillmentType, quoteId) {
  return quiet(() => idx.createPaymentIntent.run(REQ(uid, {
    purpose: 'product_order', orderId, items: ITEMS, sellerUid: SELLER, fulfillmentType,
    ...(fulfillmentType === 'delivery' ? { deliveryQuoteId: quoteId } : {}), phone: PHONE,
  })));
}
/* The REAL server STK call with the meta the REAL wrapper (sokoni-intasend.js) sends — which drops
   fulfillmentType and intentRef. `extraMeta` is what a crafted client could add by calling directly. */
async function stk(uid, orderId, amount, extraMeta) {
  return quiet(() => idx.initiateSTKPush.run(REQ(uid, {
    phone: PHONE, amount, ref: orderId,
    meta: Object.assign({ providerName: '', serviceDesc: '', category: 'product', uid,
      orderId, sellerUid: SELLER, sellerName: 'Opt2 Shop', hub: 'marketplace', items: ITEMS }, extraMeta || {}),
  })));
}
/* MIRROR of checkout.html _ckPersistPendingOrder (the browser's own write). */
async function browserPendingOrder(orderId, uid, fulfillmentType, extra) {
  await db.collection('orders').doc(orderId).set(Object.assign({
    id: orderId, uid, buyerUid: uid, sellerUid: SELLER, sellerName: 'Opt2 Shop', lineItems: ITEMS,
    status: 'pending_payment', hub: 'marketplace', fulfillmentType, deliveryMethod: fulfillmentType,
  }, extra || {}), { merge: true });
}
/* The REAL webhook, challenge-verified. */
async function webhook(apiRef, amount) {
  const res = { code: null, body: null, headers: {},
    status(c) { this.code = c; return this; }, send(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; }, setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; }, end() { return this; }, json(b) { this.body = b; return this; } };
  const body = { challenge: CHALLENGE, api_ref: apiRef, state: 'COMPLETE', invoice_id: 'INV-' + apiRef,
    net_amount: amount, value: amount, mpesa_reference: 'MP' + apiRef.replace(/[^A-Z0-9]/gi, '').slice(-8) };
  const req = { method: 'POST', body, headers: { 'content-type': 'application/json' }, rawBody: Buffer.from(JSON.stringify(body)),
    get(h) { return this.headers[String(h).toLowerCase()]; }, header(h) { return this.get(h); } };
  await quiet(() => idx.webhookIntasend(req, res));
  return res;
}
async function riderAccepts(orderId, rider) {
  const d = await where('packageRequests', 'orderId', orderId);
  for (const x of d) {
    await db.collection('packageRequests').doc(x.id).update({
      status: 'delivered', assignedDriverId: rider, riderId: rider, assignedDriverUid: rider, assignedRiderId: rider });
  }
}
const safe = async (fn) => { try { return await fn(); } catch (e) { return { err: e, msg: (e && e.message) || String(e) }; } };
/* What a browser can copy onto its own order: the EXACT pin shape of a real, stored quote — internally
   valid, so conservation/version/band guards pass and only the authority rule can refuse it. */
async function browserPinCopy(quoteId) {
  const q = await get('deliveryQuotes', quoteId);
  return { quoteId, pricingVersion: q.pricingVersion, sokoniSharePct: q.sokoniSharePct,
    customerCharge: { currency: 'KES', minorUnits: q.customerChargeMinor },
    riderEarning: { currency: 'KES', minorUnits: q.riderEarningMinor },
    sokoniCommission: { currency: 'KES', minorUnits: q.sokoniCommissionMinor },
    pricingInputs: q.pricingInputs, vehicleClass: q.vehicleClass };
}
/* A crash inside one section is that section's FAIL, never the end of the run. */
async function section(id, fn) {
  try { await fn(); } catch (e) { ok(false, id + '-CRASH', 'section crashed: ' + ((e && e.message) || e)); }
}

/* The full live flow for one buyer: quote -> intent -> STK -> (optional pending order) -> webhook. */
async function liveOrder(tag, { fulfillmentType = 'delivery', preWrite = false, extraMeta, quoteId } = {}) {
  const buyer = 'r1o2-buyer-' + tag, orderId = 'R1O2-' + tag;
  const q = fulfillmentType === 'delivery' ? (quoteId ? { quoteId } : await issueQuote(buyer)) : null;
  const intent = await safe(() => mkIntent(buyer, orderId, fulfillmentType, q && q.quoteId));
  const amount = intent && intent.amount;
  const stkRes = await safe(() => stk(buyer, orderId, amount, extraMeta));
  if (preWrite) await browserPendingOrder(orderId, buyer, fulfillmentType);
  return { buyer, orderId, quoteId: q && q.quoteId, amount, intent, stkRes };
}

(async () => {
  console.log(`\nRES-1 option 2 — the server-owned intent's quote is bound and carried   (tree: ${ROOT})\n`);
  await db.collection('platformConfig').doc('deliveryPricing').set(Object.assign({}, APPROVED,
    { effectiveFrom: new Date(Date.now() - 86400000).toISOString() }));
  await db.collection('sellers').doc(SELLER).set({ shopName: 'Opt2 Shop', uid: SELLER });
  await db.collection('shops').doc(SELLER).set({ open: true });
  await db.collection('products').doc(PRODUCT).set({ name: 'Opt2 item', price: PRICE, sellerUid: SELLER, stock: 1000 });

  await section('G', async () => {
  /* ── [G] webhook-first, no browser verification: the chain, link by link ── */
  console.log('[G] webhook-first — no session, no verify, no pending order');
  const G = await liveOrder('G');
  ok(!G.intent.err && G.amount > PRICE && !G.stkRes.err, 'G-0',
    `CONTROL — the real intent prices items + quote (KES ${G.amount}) and the real STK call is accepted${G.intent.err ? ' — intent ERR ' + G.intent.msg : ''}${G.stkRes.err ? ' — STK ERR ' + G.stkRes.msg : ''}`);
  const gi = await get('paymentIntents', G.orderId), gp0 = await get('payments', G.orderId);
  ok(!!gp0 && gp0.intentRef === G.orderId && gp0.uid === G.buyer && !(gp0.meta || {}).fulfillmentType, 'G-1',
    'the payment record is the server\'s; the browser meta carries NO fulfillmentType (the wrapper drops it)');
  ok(!!gi && gi.metadata && gi.metadata.fulfillmentType === 'delivery' && gi.metadata.deliveryQuote
    && gi.metadata.deliveryQuote.deliveryQuoteId === G.quoteId, 'G-2',
    `the server-owned intent records the fulfilment (${gi && gi.metadata && gi.metadata.fulfillmentType}) and WHICH quote priced it`);
  const gw = await webhook(G.orderId, G.amount);
  ok(gw.code === 200, 'G-3', `the challenge-verified webhook is accepted (HTTP ${gw.code})`);
  const gq = await get('deliveryQuotes', G.quoteId), go = await get('orders', G.orderId);
  ok(!!gq && gq.status === 'consumed' && gq.orderId === G.orderId, 'G-4',
    `the intent's quote is BOUND to this order (status=${gq && gq.status}, orderId=${gq && gq.orderId || '-'})`);
  ok(!!go && go.deliveryQuoteId === G.quoteId && go.deliveryQuote && go.deliveryQuote.quoteId === G.quoteId
    && go.deliveryQuote.riderEarning.minorUnits === gq.riderEarningMinor, 'G-5', 'the order records the SERVER\'s pin of that quote');
  const gd = await where('packageRequests', 'orderId', G.orderId);
  ok(gd.length === 1 && !gd[0].pricingBlocked && gd[0].deliveryQuote && gd[0].deliveryQuote.quoteId === G.quoteId
    && gd[0].quotePinSource === 'intent', 'G-6',
    `ONE delivery record, priced from the intent's quote (blocked=${gd[0] && gd[0].pricingBlocked || 'no'}, source=${gd[0] && gd[0].quotePinSource})`);
  await riderAccepts(G.orderId, 'r1o2-rider-g');
  const ge = await RE.forOrder(db, G.orderId);
  ok(ge.ok && ge.quoteId === G.quoteId && ge.minorUnits === gq.riderEarningMinor, 'G-7',
    `Repair 5 derives the rider entitlement FROM that quote: ${ge.ok ? ge.minorUnits + ' minor = issued ' + gq.riderEarningMinor : 'REFUSED ' + ge.reason}`);
  });

  await section('G2', async () => {
  /* ── [G'] the live Place Order ordering: the browser pending order lands BEFORE the webhook ── */
  console.log('[G\'] browser pending order first, then the webhook');
  const G2 = await liveOrder('G2', { preWrite: true });
  await webhook(G2.orderId, G2.amount);
  const g2d = await where('packageRequests', 'orderId', G2.orderId), g2q = await get('deliveryQuotes', G2.quoteId);
  ok(g2d.length === 1 && !g2d[0].pricingBlocked && g2d[0].quoteId === G2.quoteId && g2q.status === 'consumed' && g2q.orderId === G2.orderId,
    'G-8', `pending-order-first is priced and bound the same way (blocked=${g2d[0] && g2d[0].pricingBlocked || 'no'})`);
  });

  await section('E', async () => {
  /* ── [E] duplicate webhook: one binding, one rider credit ── */
  console.log('[E] duplicate webhook');
  const E = await liveOrder('E');
  await webhook(E.orderId, E.amount);
  const eq1 = await get('deliveryQuotes', E.quoteId), eo1 = await get('orders', E.orderId);
  const ew2 = await webhook(E.orderId, E.amount);
  const eq2 = await get('deliveryQuotes', E.quoteId), eo2 = await get('orders', E.orderId);
  const ed = await where('packageRequests', 'orderId', E.orderId);
  ok(ew2.code === 200 && ed.length === 1, 'E-1', `the replayed webhook is acknowledged and creates NO second delivery (${ed.length} record)`);
  ok(!!eq1 && eq1.status === 'consumed' && eq1.orderId === E.orderId
    && JSON.stringify(eq2) === JSON.stringify(eq1)
    && JSON.stringify(eo2 && eo2.deliveryQuote) === JSON.stringify(eo1 && eo1.deliveryQuote), 'E-2',
    'exactly one binding: the quote and the order pin are byte-identical after the replay');
  const eCarry = await dqCarry.deliveryPricingForOrder(db, { orderId: E.orderId, intentRef: E.orderId });
  const eq3 = await get('deliveryQuotes', E.quoteId);
  ok(!eCarry.pricingBlocked && eCarry.quoteId === E.quoteId && JSON.stringify(eq3) === JSON.stringify(eq1), 'E-3',
    `a repeated carry is a no-op re-read, not a re-binding (blocked=${eCarry.pricingBlocked || 'no'})`);
  await riderAccepts(E.orderId, 'r1o2-rider-e');
  const c1 = await RE.creditDeliveryEarning(db, E.orderId, { source: 'test' });
  const c2 = await RE.creditDeliveryEarning(db, E.orderId, { source: 'test' });
  const credits = (await where('walletTransactions', 'orderId', E.orderId)).filter((t) => t.type === 'delivery_earning');
  ok(c1.credited === true && c2.credited === false && c2.replay === true && credits.length === 1
    && credits[0].entitlementMinor === eq1.riderEarningMinor, 'E-4',
    `exactly one rider credit, from the bound quote (${credits.length} credit, ${credits[0] ? credits[0].entitlementMinor : '-'} minor; 1st=${c1.credited}${c1.credited ? '' : ' ' + (c1.entitlement && c1.entitlement.reason)}, 2nd replay=${c2.replay})`);
  });

  await section('D', async () => {
  /* ── [D] pickup: no delivery dispatch ── */
  console.log('[D] pickup');
  const D1 = await liveOrder('D1', { fulfillmentType: 'pickup' });
  ok(!D1.intent.err && D1.amount === PRICE && !D1.stkRes.err, 'D-0', `CONTROL — a pickup intent charges items only (KES ${D1.amount})`);
  await webhook(D1.orderId, D1.amount);
  const d1d = await where('packageRequests', 'orderId', D1.orderId), d1o = await get('orders', D1.orderId);
  ok(d1d.length === 0, 'D-1', `a pickup order paid by STK creates NO delivery dispatch (${d1d.length} records)`);
  ok(!!d1o && d1o.fulfillmentType === 'pickup', 'D-2', `the webhook-created order is recorded as pickup (fulfillmentType=${d1o && d1o.fulfillmentType})`);
  const D2 = await liveOrder('D2', { fulfillmentType: 'pickup', extraMeta: { fulfillmentType: 'delivery' } });
  await webhook(D2.orderId, D2.amount);
  const d2d = await where('packageRequests', 'orderId', D2.orderId);
  ok(d2d.length === 0, 'D-3', `a crafted STK meta saying "delivery" cannot turn a paid pickup into a dispatch (${d2d.length} records)`);
  const d3 = await dqCarry.deliveryPricingForOrder(db, { orderId: D1.orderId });
  ok(d3.pricingBlocked === 'pickup_order_no_delivery', 'D-4',
    `the carry itself refuses to price a delivery for a pickup intent (${d3.pricingBlocked || 'PRICED ' + d3.quoteId})`);
  });

  await section('C', async () => {
  /* ── [C] a forged browser quote / session is not authority ── */
  console.log('[C] forged browser quote / session');
  {
    /* C1: the browser writes a pin onto its pending order — a real quote of its own, figures inflated. */
    const buyer = 'r1o2-buyer-C1', orderId = 'R1O2-C1';
    const q = await issueQuote(buyer), decoy = await issueQuote(buyer);
    const intent = await mkIntent(buyer, orderId, 'delivery', q.quoteId);
    await stk(buyer, orderId, intent.amount);
    /* A real, self-consistent pin of a quote the buyer was NOT charged for (unbound, unexpired). */
    await browserPendingOrder(orderId, buyer, 'delivery', { deliveryQuote: await browserPinCopy(decoy.quoteId) });
    await webhook(orderId, intent.amount);
    const d = await where('packageRequests', 'orderId', orderId), qd = await get('deliveryQuotes', decoy.quoteId), qr = await get('deliveryQuotes', q.quoteId);
    const pin = d[0] && d[0].deliveryQuote;
    ok(d.length === 1 && !(pin && pin.quoteId === decoy.quoteId), 'C-1',
      `a browser-written pin on the order never reaches the rider record (pin=${pin ? pin.quoteId : 'none'}, blocked=${d[0] && d[0].pricingBlocked || 'no'})`);
    ok(qd.status === 'issued' && !qd.orderId && qr.status !== 'consumed', 'C-2',
      `the conflict is refused, not resolved by either side: decoy ${qd.status}, charged quote ${qr.status} (reason=${d[0] && d[0].pricingBlocked || '-'})`);
    ok(d[0] && d[0].pricingBlocked === 'browser_quote_conflict', 'C-3', `…with a stated reason (${d[0] && d[0].pricingBlocked})`);
  }
  {
    /* C2: the browser names a real checkout session (a different quote) on its pending order. */
    const buyer = 'r1o2-buyer-C2', orderId = 'R1O2-C2';
    const q = await issueQuote(buyer), sq = await issueQuote(buyer);
    const sess = await quiet(() => idx.createCheckoutSession.run(REQ(buyer,
      { cartItems: ITEMS, deliveryQuoteId: sq.quoteId, fulfillmentType: 'delivery' })));
    const intent = await mkIntent(buyer, orderId, 'delivery', q.quoteId);
    await stk(buyer, orderId, intent.amount);
    await browserPendingOrder(orderId, buyer, 'delivery', { sessionId: sess.sessionId });
    await webhook(orderId, intent.amount);
    const d = await where('packageRequests', 'orderId', orderId);
    const qs = await get('deliveryQuotes', sq.quoteId), qi = await get('deliveryQuotes', q.quoteId), s = await get('checkoutSessions', sess.sessionId);
    ok(d.length === 1 && !d[0].pricingBlocked && d[0].quoteId === q.quoteId && qi.status === 'consumed' && qi.orderId === orderId, 'C-4',
      `a browser-named session does not replace the charged quote: the rider pin is the INTENT's (pin=${d[0] && d[0].quoteId === q.quoteId ? 'intent quote' : d[0] && d[0].quoteId === sq.quoteId ? 'SESSION quote' : 'none'})`);
    ok(qs.status === 'issued' && !qs.orderId && s.status !== 'consumed', 'C-5',
      `the session and its quote are left untouched (session quote ${qs.status}, session ${s.status || 'open'})`);
  }
  });

  await section('A', async () => {
  /* ── [A] wrong payment/order pairing ── */
  console.log('[A] wrong payment/order pairing');
  {
    /* The intent (and its paid payment) belong to order A. Order B carries a copy of A's pin — a
       browser can write that. Asking the carry to price B from A's intent must refuse. */
    const A = await liveOrder('A');
    await webhook(A.orderId, A.amount);
    const aPin = await browserPinCopy(A.quoteId);
    const B = 'R1O2-A-other';
    await browserPendingOrder(B, A.buyer, 'delivery', { deliveryQuote: aPin });
    const qBefore = JSON.stringify(await get('deliveryQuotes', A.quoteId));
    const r = await dqCarry.deliveryPricingForOrder(db, { orderId: B, intentRef: A.orderId });
    ok(r.pricingBlocked === 'intent_order_mismatch', 'A-1',
      `pricing order B from order A's payment is refused (${r.pricingBlocked || 'PRICED with ' + r.quoteId})`);
    ok(JSON.stringify(await get('deliveryQuotes', A.quoteId)) === qBefore && !(await get('orders', B)).deliveryQuoteId, 'A-2',
      'nothing is written: A\'s quote is unchanged and B gains no binding');
    let direct = null;
    try { await dqCarry.bindIntentQuoteToOrder(db, { orderId: B, intentRef: A.orderId }); } catch (e) { direct = e.reason || e.message; }
    ok(direct === 'intent_order_mismatch', 'A-3', `the binder itself refuses the pairing (${direct || 'BOUND'})`);
  }
  });

  await section('B', async () => {
  /* ── [B] wrong buyer ── */
  console.log('[B] wrong buyer');
  {
    /* B1: the order belongs to someone other than the intent's owner (the browser wrote it). */
    const buyer = 'r1o2-buyer-B1', intruder = 'r1o2-intruder', orderId = 'R1O2-B1';
    const q = await issueQuote(buyer);
    const intent = await mkIntent(buyer, orderId, 'delivery', q.quoteId);
    await stk(buyer, orderId, intent.amount);
    await db.collection('payments').doc(orderId).update({ status: 'COMPLETE' });
    await browserPendingOrder(orderId, intruder, 'delivery', { deliveryQuote: await browserPinCopy(q.quoteId) });
    const r = await dqCarry.deliveryPricingForOrder(db, { orderId });
    ok(r.pricingBlocked === 'buyer_mismatch', 'B-1', `an order held by a different buyer is refused (${r.pricingBlocked || 'PRICED ' + r.quoteId})`);
    const qa = await get('deliveryQuotes', q.quoteId);
    ok(qa.status === 'issued' && !qa.orderId, 'B-2', `…and the quote is not consumed (${qa.status})`);
  }
  {
    /* B2: the payment was made by someone other than the intent's owner. */
    const buyer = 'r1o2-buyer-B3', orderId = 'R1O2-B3';
    const q = await issueQuote(buyer);
    const intent = await mkIntent(buyer, orderId, 'delivery', q.quoteId);
    await stk(buyer, orderId, intent.amount);
    await db.collection('payments').doc(orderId).update({ status: 'COMPLETE', uid: 'r1o2-someone-else' });
    await browserPendingOrder(orderId, buyer, 'delivery', { deliveryQuote: await browserPinCopy(q.quoteId) });
    const r = await dqCarry.deliveryPricingForOrder(db, { orderId });
    ok(r.pricingBlocked === 'payer_mismatch', 'B-3', `a payment by a different uid is refused (${r.pricingBlocked || 'PRICED ' + r.quoteId})`);
  }
  });

  await section('F', async () => {
  /* ── [F] an already-bound quote fails closed ── */
  console.log('[F] already-bound quote');
  {
    /* Real sequence: the buyer prices TWO orders with one quote while it is still `issued` (both
       intents are legitimately created), pays both, and both webhooks land. */
    const buyer = 'r1o2-buyer-F', o1 = 'R1O2-F1', o2 = 'R1O2-F2';
    const q = await issueQuote(buyer);
    const i1 = await mkIntent(buyer, o1, 'delivery', q.quoteId);
    const i2 = await mkIntent(buyer, o2, 'delivery', q.quoteId);
    ok(i1.amount === i2.amount && (await get('paymentIntents', o2)).metadata.deliveryQuote.deliveryQuoteId === q.quoteId, 'F-0',
      'CONTROL — both intents legitimately name the one quote while it is issued');
    await stk(buyer, o1, i1.amount);
    await safe(() => stk(buyer, o2, i2.amount));
    await webhook(o1, i1.amount);
    const qa = await get('deliveryQuotes', q.quoteId);
    await webhook(o2, i2.amount);
    const d2 = await where('packageRequests', 'orderId', o2), qb = await get('deliveryQuotes', q.quoteId), ord2 = await get('orders', o2);
    ok(qa.status === 'consumed' && qa.orderId === o1, 'F-1', `the first paid order binds the quote (${qa.status} -> ${qa.orderId})`);
    ok(d2.length === 1 && d2[0].pricingBlocked === 'quote_bound_to_another_order', 'F-2',
      `the second order's delivery is refused with the reason (${d2[0] ? d2[0].pricingBlocked || 'PRICED ' + d2[0].quoteId : 'no record'})`);
    ok(qb.orderId === o1 && JSON.stringify(qb) === JSON.stringify(qa) && !(ord2 && ord2.deliveryQuoteId), 'F-3',
      'the bound quote is never replaced, and the second order gains no binding');
  }
  });

  await section('L', async () => {
  /* ── [L] legacy control: a payment with NO intent keeps its old behaviour ── */
  console.log('[L] no-intent control (unchanged behaviour)');
  {
    const buyer = 'r1o2-buyer-L', orderId = 'R1O2-L';
    await db.collection('payments').doc(orderId).set({ ref: orderId, amount: PRICE, status: 'PENDING', uid: buyer, phone: PHONE,
      meta: { category: 'product', orderId, sellerUid: SELLER, items: ITEMS, fulfillmentType: 'pickup' } });
    await webhook(orderId, PRICE);
    const d = await where('packageRequests', 'orderId', orderId);
    ok(d.length === 0, 'L-1', `an intent-less payment still takes fulfillmentType from its meta (pickup -> ${d.length} dispatch)`);
  }
  });

  console.log(`\n  STK calls answered by the stub: ${stkCalls}; other outbound calls blocked: ${blockedCalls.length} (${[...new Set(blockedCalls)].join(', ') || '-'})`);
  console.log(`\n${pass} pass / ${fail} fail`);
  clearTimeout(WATCHDOG);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('  ✖ CRASH — ' + (e && e.stack || e)); process.exit(4); });
