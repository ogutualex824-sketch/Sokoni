'use strict';
/**
 * CERTIFICATION — RES-1 option 1: a quote carried from the checkout SESSION is BOUND to its order.
 *
 * The defect: on the webhook-first rail (`_finalizeMarketplacePayment` writes the order without reading
 * the session), the carry found the pin on the session and wrote it to the delivery record UNBOUND —
 * `deliveryQuotes/{id}` stayed `issued`, no `orderId`. Repair 5 refuses an unbound quote, so no rider
 * on that rail could ever be paid; and an unbound quote is not single-use.
 *
 * This does NOT assert "the entitlement is non-null". It proves the CHAIN, link by link:
 *   real quote -> the session that names it -> the order -> the quote bound EXACTLY ONCE to that order
 *   -> the delivery record carries THAT quote -> Repair 5 derives the entitlement FROM that quote,
 * and the security property that makes binding different from copying a quote id around:
 *   quote bound to order A -> order B cannot claim it.
 *
 * Real code: requestDeliveryQuote, createCheckoutSession, bindQuoteToOrderTx,
 * deliveryPricingForOrder (+ bindSessionQuoteToOrder), rider-entitlement. MIRRORED (not exported): the
 * two ORDER writes — verifyIntasendPayment's (binds in the order transaction) and
 * _finalizeMarketplacePayment's (does not) — and the delivery-record write of the webhook (2b) block.
 *
 *   REPAIR_ROOT  tree under test (default: this repo). The pre-repair tree must FAIL.
 * Refuses without FIRESTORE_EMULATOR_HOST.
 */
const path = require('path');
const fs = require('fs');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set. This suite only runs against an emulator.');
  process.exit(2);
}
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-res1-bind';
const WATCHDOG = setTimeout(() => { console.log('\n  ✖ WATCHDOG — suite exceeded 240s'); process.exit(3); }, 240000);

const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
let idx, dqEndpoint, dqCarry, RE, APPROVED;
try {
  idx = require(path.join(FN, 'index.js'));
  dqEndpoint = require(path.join(FN, 'delivery-quote-endpoint.js'));
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
  process.stdout.write = () => true; process.stderr.write = () => true;
  try { return await fn(); } finally { process.stdout.write = so; process.stderr.write = se; }
}

const BUYER = 'r1b-buyer', OTHER = 'r1b-other', SELLER = 'r1b-seller', PRODUCT = 'r1b-prod';
const REQ = (uid, data) => ({ data, auth: { uid, token: { uid } }, rawRequest: { headers: {}, ip: '127.0.0.1' }, acceptsStreaming: false });
const TRIP = { distanceKm: 8, estimatedMinutes: 26, shipment: { totalWeightKg: 3, packageCount: 1 } };
const get = async (c, id) => { const s = await db.collection(c).doc(String(id)).get(); return s.exists ? s.data() : null; };
const count = async (c) => (await db.collection(c).get()).size;

async function sessionWithQuote(uid) {
  const q = await quiet(() => idx.requestDeliveryQuote.run(REQ(uid || BUYER, TRIP)));
  const s = await quiet(() => idx.createCheckoutSession.run(REQ(uid || BUYER,
    { cartItems: [{ productId: PRODUCT, qty: 1 }], deliveryQuoteId: q.quoteId, fulfillmentType: 'delivery' })));
  return { quoteId: q.quoteId, sessionId: s.sessionId };
}
/* MIRROR of _finalizeMarketplacePayment's order create: buyer from the payment record, no session read, no binding. */
async function webhookFirstOrder(orderId, buyer) {
  await db.collection('orders').doc(orderId).set({ orderId, uid: buyer, buyerUid: buyer, sellerUid: SELLER,
    status: 'paid', paymentVerified: true, fulfillmentType: 'delivery', source: 'webhookIntasend' });
}
/* MIRROR of verifyIntasendPayment's order create: from the session, binding in the SAME transaction (index.js 2939-2947). */
async function verifyFirstOrder(orderId, sessionId) {
  const s = await get('checkoutSessions', sessionId);
  const qref = db.collection(dqEndpoint.QUOTES).doc(s.deliveryQuoteId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(qref);
    tx.set(db.collection('orders').doc(orderId), { orderId, sessionId, uid: s.uid, buyerUid: s.uid, sellerUid: SELLER,
      status: 'paid', deliveryQuoteId: s.deliveryQuoteId, deliveryQuote: s.deliveryQuote });
    dqEndpoint.bindQuoteToOrderTx(tx, db, s.deliveryQuoteId, orderId, s.uid, snap);
  });
}
/* MIRROR of the webhook (2b) delivery record: server-authored (no uid) + the carry fragment; then the server accept. */
async function deliveryRecord(orderId, sessionIdSeenByWebhook, rider) {
  const pricing = await dqCarry.deliveryPricingForOrder(db, { orderId, sessionId: sessionIdSeenByWebhook });
  await db.collection('packageRequests').doc('DEL' + orderId).set(Object.assign(
    { ref: 'DEL' + orderId, deliveryRef: 'DEL' + orderId, orderId, sellerUid: SELLER, status: 'order_placed', source: 'webhookIntasend' },
    pricing));
  if (rider) {
    await db.collection('packageRequests').doc('DEL' + orderId).update({
      status: 'driver_accepted', assignedDriverId: rider, riderId: rider, assignedDriverUid: rider, assignedRiderId: rider });
  }
  return pricing;
}

(async () => {
  await db.collection('platformConfig').doc('deliveryPricing').set(Object.assign({}, APPROVED,
    { effectiveFrom: new Date(Date.now() - 86400000).toISOString() }));
  await db.collection('products').doc(PRODUCT).set({ name: 'RES-1 bind item', price: 1500, sellerUid: SELLER, stock: 1000 });
  await db.collection('shops').doc(SELLER).set({ open: true });
  console.log(`\nRES-1 option 1 — session-carried quote is bound to its order   (tree: ${ROOT})\n`);

  /* ── [W] webhook-first + session known: the chain, link by link ── */
  console.log('[W] webhook-first, session known — the chain');
  const W = { orderId: 'R1B-W', rider: 'r1b-rider-w' };
  {
    const { quoteId, sessionId } = await sessionWithQuote();
    W.quoteId = quoteId; W.sessionId = sessionId;
    const q0 = await get('deliveryQuotes', quoteId);
    ok(!!q0 && q0.status === 'issued' && q0.buyerUid === BUYER && Number.isInteger(q0.riderEarningMinor), 'W-1',
      `a real quote is issued to the buyer (status=${q0 && q0.status}, riderEarning=${q0 && q0.riderEarningMinor})`);
    const s0 = await get('checkoutSessions', sessionId);
    ok(!!s0 && s0.deliveryQuoteId === quoteId && s0.deliveryQuote && s0.deliveryQuote.quoteId === quoteId && s0.uid === BUYER,
      'W-2', 'the real checkout session names THAT quote, pins it, and belongs to the buyer');
    await webhookFirstOrder(W.orderId, BUYER);
    const o0 = await get('orders', W.orderId);
    ok(!o0.deliveryQuoteId && !o0.deliveryQuote && !o0.sessionId, 'W-3', 'the webhook-first order carries no quote and no session (the defect\'s starting state)');
    const quotesBefore = await count('deliveryQuotes');
    const p = await deliveryRecord(W.orderId, sessionId, W.rider);
    ok(!p.pricingBlocked && p.quoteId === quoteId && p.quotePinSource === 'session', 'W-4',
      `the carry finds THAT quote via the session (blocked=${p.pricingBlocked || 'no'}, source=${p.quotePinSource})`);
    const q1 = await get('deliveryQuotes', quoteId);
    ok(q1.status === 'consumed' && q1.orderId === W.orderId, 'W-5', `the quote is BOUND to this order (status=${q1.status}, orderId=${q1.orderId || '-'})`);
    const boundHere = (await db.collection('deliveryQuotes').where('orderId', '==', W.orderId).get()).size;
    ok(boundHere === 1 && await count('deliveryQuotes') === quotesBefore, 'W-6',
      `exactly one quote is bound to the order, and no quote was minted (${boundHere} bound, ${quotesBefore}→${await count('deliveryQuotes')} quotes)`);
    const o1 = await get('orders', W.orderId), s1 = await get('checkoutSessions', sessionId);
    ok(o1.deliveryQuoteId === quoteId && o1.deliveryQuote && o1.deliveryQuote.quoteId === quoteId && o1.sessionId === sessionId,
      'W-7', 'the order now records THAT quote and its session');
    ok(s1.status === 'consumed' && s1.orderId === W.orderId, 'W-8', 'the session is consumed by this order');
    const d = await get('packageRequests', 'DEL' + W.orderId);
    ok(d.deliveryQuote && d.deliveryQuote.quoteId === quoteId && d.uid === undefined, 'W-9', 'the delivery record carries THAT quote id (server-authored); binding itself is W-5');
    const e = await RE.forOrder(db, W.orderId);
    ok(e.ok && e.quoteId === quoteId && e.minorUnits === q0.riderEarningMinor && e.riderUid === W.rider, 'W-10',
      `Repair 5 derives the entitlement FROM that quote: ${e.ok ? e.minorUnits + ' minor = issued ' + q0.riderEarningMinor + ', to ' + e.riderUid : 'REFUSED ' + e.reason}`);
    /* idempotent for the same order */
    const p2 = await dqCarry.deliveryPricingForOrder(db, { orderId: W.orderId, sessionId });
    const q2 = await get('deliveryQuotes', quoteId);
    ok(!p2.pricingBlocked && q2.status === 'consumed' && q2.orderId === W.orderId, 'W-11',
      `carrying again for the same order is a no-op, not a refusal (blocked=${p2.pricingBlocked || 'no'})`);
  }

  /* ── [N] the security properties ── */
  console.log('\n[N] a bound quote cannot be claimed or replaced');
  {
    /* quote bound to order A (W above) -> order B presents A's session */
    await webhookFirstOrder('R1B-B', BUYER);
    const pB = await deliveryRecord('R1B-B', W.sessionId, 'r1b-rider-b');
    const qA = await get('deliveryQuotes', W.quoteId), oB = await get('orders', 'R1B-B');
    ok(!!pB.pricingBlocked && qA.orderId === W.orderId && !oB.deliveryQuoteId, 'N-1',
      `order B cannot claim order A's quote (blocked=${pB.pricingBlocked}; quote still bound to ${qA.orderId})`);
    const eB = await RE.forOrder(db, 'R1B-B');
    ok(!eB.ok, 'N-2', `…and Repair 5 pays nobody on B (${eB.reason})`);
    const eA = await RE.forOrder(db, W.orderId);
    ok(eA.ok && eA.riderUid === W.rider, 'N-3', '…and A\'s entitlement is unaffected');
  }
  {
    /* quote bound to A through the VERIFY rail -> B tries through the session path */
    const { quoteId, sessionId } = await sessionWithQuote();
    await verifyFirstOrder('R1B-VA', sessionId);
    await webhookFirstOrder('R1B-VB', BUYER);
    const p = await deliveryRecord('R1B-VB', sessionId, 'r1b-rider-vb');
    const q = await get('deliveryQuotes', quoteId);
    ok(!!p.pricingBlocked && q.orderId === 'R1B-VA', 'N-4', `a quote the verify rail bound to A cannot be claimed by B (${p.pricingBlocked})`);
  }
  {
    /* another buyer's order presents this buyer's session */
    const { quoteId, sessionId } = await sessionWithQuote();
    await webhookFirstOrder('R1B-X', OTHER);
    const p = await deliveryRecord('R1B-X', sessionId, 'r1b-rider-x');
    const q = await get('deliveryQuotes', quoteId), s = await get('checkoutSessions', sessionId), o = await get('orders', 'R1B-X');
    ok(p.pricingBlocked === 'buyer_mismatch' && q.status === 'issued' && !q.orderId && s.status !== 'consumed' && !o.deliveryQuoteId, 'N-5',
      `another buyer's order cannot bind this buyer's quote, and nothing is written (${p.pricingBlocked}; quote ${q.status})`);
  }
  {
    /* an order already carrying a different quote is never re-pointed */
    const first = await sessionWithQuote();
    const second = await sessionWithQuote();
    await verifyFirstOrder('R1B-R', first.sessionId);
    const r = await dqCarry.bindSessionQuoteToOrder ? await dqCarry.bindSessionQuoteToOrder(db,
      { orderId: 'R1B-R', sessionId: second.sessionId, quoteId: second.quoteId }).then(() => 'bound', (e) => e.reason) : 'absent';
    const o = await get('orders', 'R1B-R'), q2 = await get('deliveryQuotes', second.quoteId);
    ok(r === 'order_bound_to_another_quote' && o.deliveryQuoteId === first.quoteId && q2.status === 'issued', 'N-6',
      `a bound order's quote cannot be silently replaced (${r}; order keeps ${o.deliveryQuoteId === first.quoteId ? 'its quote' : 'ANOTHER'})`);
  }

  /* ── [V] verify-first remains working ── */
  console.log('\n[V] verify-first is unchanged');
  {
    const { quoteId, sessionId } = await sessionWithQuote();
    await verifyFirstOrder('R1B-V', sessionId);
    const p = await deliveryRecord('R1B-V', null, 'r1b-rider-v');
    const q = await get('deliveryQuotes', quoteId);
    const e = await RE.forOrder(db, 'R1B-V');
    ok(!p.pricingBlocked && p.quotePinSource === 'order' && q.orderId === 'R1B-V', 'V-1', 'verify-first carries the pin from the order, bound by the verify rail');
    ok(e.ok && e.quoteId === quoteId && e.minorUnits === q.riderEarningMinor, 'V-2', `Repair 5 pays from that quote (${e.ok ? e.minorUnits : e.reason})`);
  }

  /* ── [W2] webhook-first, no session: stays blocked, nothing inferred ── */
  console.log('\n[W2] webhook-first with no session — blocked, never guessed');
  {
    const { quoteId } = await sessionWithQuote();
    await webhookFirstOrder('R1B-W2', BUYER);
    const p = await deliveryRecord('R1B-W2', null, 'r1b-rider-w2');
    const q = await get('deliveryQuotes', quoteId), o = await get('orders', 'R1B-W2');
    const e = await RE.forOrder(db, 'R1B-W2');
    ok(p.pricingBlocked === 'no_pinned_quote' && q.status === 'issued' && !o.deliveryQuoteId, 'W2-1',
      `no session known → no pin, the buyer's open quote is NOT inferred or bound (${p.pricingBlocked}; quote ${q.status})`);
    ok(!e.ok && e.reason === 'no_pinned_quote', 'W2-2', `Repair 5 refuses (${e.reason})`);
  }

  /* ── [S] scope ── */
  console.log('\n[S] scope');
  {
    const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const carry = strip(fs.readFileSync(path.join(FN, 'delivery-quote-carry.js'), 'utf8'));
    ok(!/refund|deliveryFee\b|driverNet|orderTotal|amount/i.test(carry), 'S-1', 'the carry reads no refund, order amount, delivery fee or driverNet');
    const reSrc = fs.readFileSync(path.join(FN, 'rider-entitlement.js'), 'utf8');
    const reHead = require('child_process').execSync('git show 9405e3a:functions/rider-entitlement.js',
      { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
    ok(reSrc === reHead, 'S-2', 'Repair 5\'s authority is byte-identical to its landed version');
  }

  console.log(`\n${pass} pass / ${fail} fail`);
  clearTimeout(WATCHDOG);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('  ✖ CRASH', e && e.stack); clearTimeout(WATCHDOG); process.exit(2); });
