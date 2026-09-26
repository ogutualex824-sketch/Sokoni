'use strict';
/**
 * CERTIFICATION — marketplace delivery pricing authority = the RES-1 server-issued policy quote.
 *
 * Owner decision 2026-09-27: for marketplace orders the buyer's delivery charge is the
 * customerCharge of the quote the server issued to that buyer; seller deliveryConfig no longer
 * prices marketplace delivery (records preserved); no quote -> fail closed, no fallback to a
 * browser figure or to deliveryConfig; historical orders are never repriced.
 *
 * Runs the REAL requestDeliveryQuote and createPaymentIntent('product_order') out of the real
 * functions/index.js (`.run`) against a Firestore EMULATOR, plus the pure multi-shop quote.
 *
 *   REPAIR_ROOT  tree under test (default: this repo). Pointed at the pre-change tree it must FAIL.
 * Refuses without FIRESTORE_EMULATOR_HOST.
 */
const path = require('path');
const fs = require('fs');

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-mkt-delivery';

const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
let idx, dqEndpoint, MSQ, APPROVED;
try {
  idx = require(path.join(FN, 'index.js'));
  dqEndpoint = require(path.join(FN, 'delivery-quote-endpoint.js'));
  MSQ = require(path.join(FN, 'multishop-checkout-quote.js'));
  APPROVED = require(path.join(ROOT, 'scripts', 'write-delivery-pricing-policy.js')).APPROVED;
} catch (e) { console.log('  ✖ SETUP — ' + e.message); process.exit(2); }
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

let pass = 0, fail = 0;
const ok = (c, id, m) => { if (c) { pass++; console.log('  PASS', id, m); } else { fail++; console.log('  FAIL', id, m); } };
async function quiet(fn) {
  const so = process.stdout.write.bind(process.stdout), se = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true; process.stderr.write = () => true;
  try { return await fn(); } finally { process.stdout.write = so; process.stderr.write = se; }
}
const REQ = (uid, data) => ({ data, auth: { uid, token: { uid } }, rawRequest: { headers: {}, ip: '127.0.0.1' }, acceptsStreaming: false });
const TRIP = { distanceKm: 8, estimatedMinutes: 26, shipment: { totalWeightKg: 3, packageCount: 1 } };
const BUYER = 'mkt-buyer', OTHER = 'mkt-other';
const S_CFG = 'seller-distance', S_FLAT = 'seller-flat', S_NONE = 'seller-none';
const PRICE = 1000;
const get = async (c, id) => { const s = await db.collection(c).doc(String(id)).get(); return s.exists ? s.data() : null; };

async function issueQuote(uid) { return quiet(() => idx.requestDeliveryQuote.run(REQ(uid || BUYER, TRIP))); }
async function intent(orderId, data, uid) {
  try { return { v: await quiet(() => idx.createPaymentIntent.run(REQ(uid || BUYER, Object.assign({ purpose: 'product_order', orderId }, data)))) }; }
  catch (e) { return { err: e, code: e.code, msg: e.message }; }
}
const items = (sid) => [{ productId: 'prod-' + sid, qty: 1 }];

(async () => {
  console.log(`\nMarketplace delivery pricing authority = RES-1 quote   (tree: ${ROOT})\n`);
  await db.collection('platformConfig').doc('deliveryPricing').set(Object.assign({}, APPROVED,
    { effectiveFrom: new Date(Date.now() - 86400000).toISOString() }));
  const sellerDocs = {
    [S_CFG]:  { shopName: 'Distance Shop', deliveryConfig: { enabled: true, mode: 'distance', baseFee: 100, perKm: 20, freeAbove: 3000 } },
    [S_FLAT]: { shopName: 'Flat Shop', deliveryConfig: { enabled: true, mode: 'flat', defaultFee: 9999, freeAbove: 50 } },
    [S_NONE]: { shopName: 'No Config Shop' },
  };
  for (const [sid, d] of Object.entries(sellerDocs)) {
    await db.collection('sellers').doc(sid).set(d);
    await db.collection('shops').doc(sid).set({ open: true });
    await db.collection('products').doc('prod-' + sid).set({ name: 'Item ' + sid, price: PRICE, sellerUid: sid, stock: 100 });
  }
  const sellerSnapshot = async () => JSON.stringify(await Promise.all(Object.keys(sellerDocs).map((s) => get('sellers', s))));
  const sellersBefore = await sellerSnapshot();

  /* H0 — a HISTORICAL intent + order, priced under the old authority, exist before anything runs. */
  const HIST = 'HIST-ORDER-0001';
  /* The REAL intent shape (payment-intents.js writes both uid and ownerUid; the replay rule reads uid). */
  const histIntent = { ref: HIST, uid: BUYER, ownerUid: BUYER, purpose: 'product_order', resourceType: 'order', resourceId: HIST,
    amount: 1260, amountCents: 126000, currency: 'KES', status: 'created',
    metadata: { orderId: HIST, sellerUid: S_CFG, subtotal: 1000, deliveryFee: 260, deliverySource: 'delivery-engine' } };
  const histOrder = { orderId: HIST, buyerUid: BUYER, sellerUid: S_CFG, deliveryFee: 260, orderTotal: 1260, status: 'paid' };
  await db.collection('paymentIntents').doc(HIST).set(histIntent);
  await db.collection('orders').doc(HIST).set(histOrder);
  const histBefore = JSON.stringify([await get('paymentIntents', HIST), await get('orders', HIST)]);

  /* ── P: the quote is the charge ── */
  console.log('[P] the RES-1 quote is the buyer\'s delivery charge');
  const q1 = await issueQuote();
  const quoteKES = Math.round(q1.customerChargeMinor / 100);
  ok(Number.isInteger(q1.customerChargeMinor) && quoteKES > 0, 'P0', `CONTROL — a real quote is issued (customerCharge ${q1.customerChargeMinor} minor = KES ${quoteKES} charged)`);
  const p1 = await intent('ORD-P1', { items: items(S_CFG), fulfillmentType: 'delivery', deliveryQuoteId: q1.quoteId });
  const i1 = await get('paymentIntents', 'ORD-P1');
  ok(!p1.err && i1 && i1.amount === PRICE + quoteKES && i1.metadata.deliveryFee === quoteKES && i1.metadata.deliverySource === 'res1_quote',
    'P1', `a DISTANCE-config seller is charged items + the quote: KES ${i1 && i1.amount} = ${PRICE} + ${quoteKES} (source ${i1 && i1.metadata.deliverySource})${p1.err ? ' — ERR ' + p1.msg : ''}`);
  ok(!!i1 && i1.metadata.deliveryQuote && i1.metadata.deliveryQuote.deliveryQuoteId === q1.quoteId, 'P2', 'the intent records WHICH quote priced the delivery');

  const q2 = await issueQuote();
  const p3 = await intent('ORD-P3', { items: items(S_FLAT), fulfillmentType: 'delivery', deliveryQuoteId: q2.quoteId });
  const i3 = await get('paymentIntents', 'ORD-P3');
  ok(!p3.err && i3 && i3.amount === PRICE + Math.round(q2.customerChargeMinor / 100), 'P3',
    `a FLAT KES 9,999 seller (free above KES 50) is charged the quote, not 9,999 and not free: KES ${i3 && i3.amount}${p3.err ? ' — ERR ' + p3.msg : ''}`);
  const q3 = await issueQuote();
  const p4 = await intent('ORD-P4', { items: items(S_NONE), fulfillmentType: 'delivery', deliveryQuoteId: q3.quoteId });
  const i4 = await get('paymentIntents', 'ORD-P4');
  ok(!p4.err && i4 && i4.amount === PRICE + Math.round(q3.customerChargeMinor / 100) && i4.metadata.deliveryFee > 0, 'P4',
    `an UNCONFIGURED seller is charged the quote, not KES 0: KES ${i4 && i4.amount}${p4.err ? ' — ERR ' + p4.msg : ''}`);
  const q4 = await issueQuote();
  const p5 = await intent('ORD-P5', { items: items(S_CFG), fulfillmentType: 'delivery', deliveryQuoteId: q4.quoteId, distanceKm: 0.1, deliveryZone: 'cbd' });
  const i5 = await get('paymentIntents', 'ORD-P5');
  ok(!p5.err && i5 && i5.amount === PRICE + Math.round(q4.customerChargeMinor / 100), 'P5',
    `a browser distanceKm/zone does not move the charge: KES ${i5 && i5.amount}${p5.err ? ' — ERR ' + p5.msg : ''}`);
  const k1 = await intent('ORD-K1', { items: items(S_CFG), fulfillmentType: 'pickup' });
  const ik = await get('paymentIntents', 'ORD-K1');
  ok(!k1.err && ik && ik.amount === PRICE && ik.metadata.deliveryFee === 0, 'P6', `pickup needs no quote and carries a real KES 0 delivery: KES ${ik && ik.amount}${k1.err ? ' — ERR ' + k1.msg : ''}`);

  /* ── F: fail closed ── */
  console.log('\n[F] fail closed — no authoritative quote, no delivery charge');
  /* Each refusal must carry ITS OWN reason. The cases use the UNCONFIGURED seller, which the old
     authority charged KES 0 without complaint — so a refusal here can only come from the quote rule. */
  const refused = async (id, orderId, data, uid, label, why) => {
    const r = await intent(orderId, data, uid);
    const doc = await get('paymentIntents', orderId);
    ok(!!r.err && !doc && why.test(r.msg || ''), id, `${label} → refused (${r.code || 'ACCEPTED'}: ${(r.msg || '').slice(0, 60)}), no intent written`);
  };
  await refused('F1', 'ORD-F1', { items: items(S_NONE), fulfillmentType: 'delivery' }, null, 'delivery with NO quote (unconfigured seller)', /delivery quote is required/);
  await refused('F2', 'ORD-F2', { items: items(S_NONE), fulfillmentType: 'delivery', deliveryQuoteId: 'dq_forged_000' }, null, 'an unknown/forged quote id', /delivery_quote_not_found/);
  const qo = await issueQuote(OTHER);
  await refused('F3', 'ORD-F3', { items: items(S_NONE), fulfillmentType: 'delivery', deliveryQuoteId: qo.quoteId }, null, "another buyer's quote", /delivery_quote_not_yours/);
  const qe = await issueQuote();
  await db.collection(dqEndpoint.QUOTES).doc(qe.quoteId).update({ expiresAtMs: Date.now() - 1000 });
  await refused('F4', 'ORD-F4', { items: items(S_NONE), fulfillmentType: 'delivery', deliveryQuoteId: qe.quoteId }, null, 'an expired quote', /delivery_quote_expired/);
  const qc = await issueQuote();
  await db.runTransaction(async (tx) => { const s = await tx.get(db.collection(dqEndpoint.QUOTES).doc(qc.quoteId)); dqEndpoint.bindQuoteToOrderTx(tx, db, qc.quoteId, 'SOME-OTHER-ORDER', BUYER, s); });
  await refused('F5', 'ORD-F5', { items: items(S_NONE), fulfillmentType: 'delivery', deliveryQuoteId: qc.quoteId }, null, 'a quote already bound to another order', /delivery_quote_already_used/);
  const qd = await issueQuote();
  await refused('F6', 'ORD-F6', { items: items(S_NONE), fulfillmentType: 'delivery', deliveryQuoteId: qd.quoteId, deliveryFee: 1 }, null, 'a payload stating its own deliveryFee', /server-authoritative.*deliveryFee/);
  const qp = await issueQuote();
  await db.collection('platformConfig').doc('deliveryPricing').update({ policyVersion: 'v-next' });
  await refused('F7', 'ORD-F7', { items: items(S_NONE), fulfillmentType: 'delivery', deliveryQuoteId: qp.quoteId }, null, 'a quote priced under a policy that has since changed', /delivery_quote_policy_changed/);
  await db.collection('platformConfig').doc('deliveryPricing').update({ policyVersion: APPROVED.policyVersion });

  /* ── C: seller configs preserved and non-authoritative ── */
  console.log('\n[C] seller deliveryConfig — preserved, and not a marketplace pricing input');
  ok(await sellerSnapshot() === sellersBefore, 'C1', 'every seller record (deliveryConfig included) is byte-identical after all of the above');
  const ms = MSQ.assembleQuote({ validatedLines: [{ productId: 'a', qty: 1, unitPrice: 500, sellerUid: S_FLAT }, { productId: 'b', qty: 1, unitPrice: 700, sellerUid: S_CFG }],
    sellerConfigs: { [S_FLAT]: sellerDocs[S_FLAT], [S_CFG]: sellerDocs[S_CFG] }, order: { fulfillmentType: 'delivery', distanceKm: 5 } });
  ok(ms.shops.every((s) => s.delivery.fee === null && s.delivery.available === false && s.delivery.reason === 'res1_quote_required')
    && ms.deliveryTotal === null && ms.grandTotal === 1200, 'C2',
    `the multi-shop quote prices NO delivery from seller configs (fees ${ms.shops.map((s) => s.delivery.fee).join('/')}, total ${ms.deliveryTotal}, grand ${ms.grandTotal})`);

  /* ── H: historical orders never repriced ── */
  console.log('\n[H] historical orders are not repriced');
  const qh = await issueQuote();
  const h1 = await intent(HIST, { items: items(S_NONE), fulfillmentType: 'delivery', deliveryQuoteId: qh.quoteId });
  const histAfter = JSON.stringify([await get('paymentIntents', HIST), await get('orders', HIST)]);
  ok(histAfter === histBefore, 'H1', `the historical intent and order are byte-identical afterwards (a re-price attempt was ${h1.err ? 'refused: ' + h1.code : 'ACCEPTED'})`);
  /* The refusal must be the AMOUNT rule — not an ownership mismatch, which would prove nothing. */
  ok(!!h1.err && h1.code === 'failed-precondition' && /cart has changed/i.test(h1.msg || ''), 'H2',
    `the refusal is the replay AMOUNT rule, not ownership (${h1.code}: ${(h1.msg || '').slice(0, 70)})`);

  /* ── S: static — no marketplace server path reads deliveryConfig ── */
  console.log('\n[S] static');
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const pp = strip(fs.readFileSync(path.join(FN, 'payment-purposes.js'), 'utf8'));
  const po = pp.slice(pp.indexOf('product_order: {'), pp.indexOf('hub_registration: {'));
  ok(po.length > 200 && !/deliveryConfig|calculateDelivery|delivery-engine/.test(po), 'S1', 'product_order code reads no deliveryConfig and calls no delivery engine');
  const mq = strip(fs.readFileSync(path.join(FN, 'multishop-checkout-quote.js'), 'utf8'));
  ok(!/\.deliveryConfig\b|calculateDelivery|require\(['"]\.\/shared\/delivery-engine/.test(mq), 'S2', 'the multi-shop quote code reads no deliveryConfig and loads no delivery engine');
  const ch = fs.readFileSync(path.join(ROOT, 'checkout.html'), 'utf8');
  const call = ch.slice(ch.indexOf("purpose:         'product_order'"), ch.indexOf("purpose:         'product_order'") + 700);
  ok(/deliveryQuoteId:\s*_deliveryQuoteId/.test(call) && /fulfillmentType === 'delivery' && !_deliveryQuoteId/.test(ch), 'S3',
    'checkout sends the displayed quote id to createPaymentIntent and stops a delivery payment that has no quote');
  ok(strip('a /* deliveryConfig */ b').indexOf('deliveryConfig') === -1 && /deliveryConfig/.test('x.deliveryConfig'), 'S4', 'CONTROL — the stripper and detector work');

  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('  ✖ CRASH', e && e.stack); process.exit(2); });
