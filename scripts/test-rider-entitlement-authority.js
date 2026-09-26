'use strict';
/**
 * CERTIFICATION — Repair 5: the delivery record is the ONE authority for what a rider is owed.
 *
 *     delivery record  ->  authoritative rider entitlement  ->  credit / refund / H2 execution
 *
 * Before: four independent rider-pay rules, all LIVE —
 *   onOrderStatusChange     order.deliveryFee − 12% hub commission, paid to the ORDER's rider id
 *   processDriverEarning    the queue entry's `amount`, paid to the queue entry's rider id
 *   recordPayment           deliveryFeeCents × 0.88, paid to the CALLER's riderId
 *   finosRecordTransaction  deliveryFeeCents × 0.88, paid to the CALLER's riderId
 *   (+ settlement-engine    DEFAULT_RIDER_PCT 0.88 / caller riderPct)
 *
 * Runs the REAL handlers out of the REAL functions/index.js (`.run`) against a Firestore EMULATOR,
 * with quotes issued by the REAL requestDeliveryQuote under the approved policy — never a
 * hand-built quote, so the suite tests the contract the product actually produces.
 *
 *   REPAIR_ROOT   the tree under test (default: this repo). Point it at the pre-repair tree and the
 *                 suite must FAIL: that is the counterproof.
 *
 * Refuses without FIRESTORE_EMULATOR_HOST — never a default port, never production.
 */
const path = require('path');
const fs = require('fs');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set. This suite only runs against an emulator.');
  process.exit(2);
}
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-rider-entitlement';
const WATCHDOG = setTimeout(() => { console.log('\n  ✖ WATCHDOG — suite exceeded 240s'); process.exit(3); }, 240000);

const admin = require(require.resolve('firebase-admin', { paths: [FN] }));

let idx, dqEndpoint, APPROVED, SE, RE = null;
try {
  idx = require(path.join(FN, 'index.js'));
  dqEndpoint = require(path.join(FN, 'delivery-quote-endpoint.js'));
  SE = require(path.join(FN, 'settlement-engine.js'));
  APPROVED = require(path.join(ROOT, 'scripts', 'write-delivery-pricing-policy.js')).APPROVED;
} catch (e) {
  console.log('  ✖ SETUP — could not load the functions under test: ' + (e && e.message));
  process.exit(2);
}
try { RE = require(path.join(FN, 'rider-entitlement.js')); } catch (e) { RE = null; }
/* index.js initialises the default app itself; the suite uses that one. */
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

let pass = 0, fail = 0;
const ok = (cond, id, msg) => {
  if (cond) { pass++; console.log('  PASS', id, msg); } else { fail++; console.log('  FAIL', id, msg); }
};
async function quiet(fn) {
  const so = process.stdout.write.bind(process.stdout), se = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true; process.stderr.write = () => true;
  try { return await fn(); } finally { process.stdout.write = so; process.stderr.write = se; }
}
/* A crash is not a verdict: capture it, and let the assertion judge the resulting STATE. */
async function tryRun(fn) {
  try { return { value: await quiet(fn) }; } catch (e) { return { error: e }; }
}

/* ── Fixtures ─────────────────────────────────────────────────────────────────────────────── */
const BUYER = 'r5-buyer', SELLER = 'r5-seller', ATTACKER = 'r5-attacker';
const POLICY = Object.assign({}, APPROVED, { effectiveFrom: new Date(Date.now() - 86400000).toISOString() });
const REQ = (uid, data, token) => ({ data, auth: { uid, token: Object.assign({ uid }, token || {}) },
  rawRequest: { headers: {}, ip: '127.0.0.1' }, acceptsStreaming: false });
const TRIP = { distanceKm: 8, estimatedMinutes: 26, shipment: { totalWeightKg: 3, packageCount: 1 } };

const balance = async (uid) => Number(((await db.collection('wallets').doc(uid).get()).data() || {}).balance || 0);
const finosCents = async (uid) => Number(((await db.collection('wallets').doc(uid).get()).data() || {}).availableBalance || 0);
const ledgerFor = async (orderId) => (await db.collection('ledger').where('orderId', '==', orderId).get()).docs.map((d) => d.data());

/** A real quote, issued by the real endpoint, bound to `orderId` by the real binder. */
async function boundQuote(orderId, trip) {
  const r = await quiet(() => idx.requestDeliveryQuote.run(REQ(BUYER, Object.assign({}, TRIP, trip || {}))));
  const ref = db.collection(dqEndpoint.QUOTES).doc(r.quoteId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    dqEndpoint.bindQuoteToOrderTx(tx, db, r.quoteId, orderId, BUYER, snap);
  });
  const stored = (await ref.get()).data();
  return { stored, pinned: dqEndpoint.pinnedFromStored(stored) };
}

/** The server's delivery record (no `uid` — no server writer sets one). */
async function serverDelivery(orderId, pinned, rider, extra) {
  const id = 'DEL' + orderId;
  await db.collection('packageRequests').doc(id).set(Object.assign({
    ref: id, deliveryRef: id, orderId, buyerUid: BUYER, sellerUid: SELLER, status: 'driver_accepted',
    deliveryQuote: pinned, quoteId: pinned ? pinned.quoteId : null,
    assignedDriverId: rider, riderId: rider, assignedDriverUid: rider, assignedRiderId: rider,
    source: 'webhookIntasend',
  }, extra || {}));
  return id;
}

async function order(orderId, fields) {
  const o = Object.assign({ id: orderId, buyerUid: BUYER, uid: BUYER, sellerUid: SELLER, status: 'out_for_delivery',
    deliveryFee: 500, orderTotal: 1500, paymentVerified: true, paymentStatus: 'paid', fulfillmentType: 'delivery',
    deliveryRef: 'DEL' + orderId }, fields || {});
  await db.collection('orders').doc(orderId).set(o);
  return o;
}

/** Fire the REAL onOrderStatusChange for `before.status -> delivered`. */
async function deliver(orderId, o, fromStatus) {
  const before = Object.assign({}, o, { status: fromStatus || 'out_for_delivery' });
  const after = Object.assign({}, o, { status: 'delivered' });
  const snap = (d) => ({ exists: true, id: orderId, data: () => d, ref: db.collection('orders').doc(orderId) });
  return tryRun(() => idx.onOrderStatusChange.run({ data: { before: snap(before), after: snap(after) }, params: { orderId } }));
}

async function feesRecord(orderId) {
  const q = await db.collection('deliveryFees').where('orderId', '==', orderId).get();
  return q.docs.map((d) => d.data());
}
const settle = () => new Promise((r) => setTimeout(r, 400));   /* deliveryFees.add is fire-and-forget */

(async () => {
  await db.collection('platformConfig').doc('deliveryPricing').set(JSON.parse(JSON.stringify(POLICY)));

  console.log(`\nREPAIR 5 — rider entitlement authority   (tree: ${ROOT})\n`);

  /* ── [E0] positive controls ── */
  console.log('[E0] controls — the harness can see a credit and produce a real quote');
  const q0 = await boundQuote('r5-ctl');
  const E = q0.stored.riderEarningMinor;
  ok(Number.isInteger(E) && E > 0 && q0.stored.status === 'consumed' && q0.stored.orderId === 'r5-ctl',
    'E0-1', `the real endpoint issues a quote and the real binder binds it (riderEarning ${E} minor)`);
  const EXPECT = Math.floor(E / 100);
  ok(EXPECT !== 440 && EXPECT !== 4400,
    'E0-2', `the quoted earning (KES ${EXPECT}) differs from every percentage the old rules would pay`);
  await db.collection('wallets').doc('r5-ctl-w').set({ balance: 7 });
  ok(await balance('r5-ctl-w') === 7, 'E0-3', 'the balance reader sees a written balance');

  /* ── [E1] the delivery record decides; the order's fee does not ── */
  console.log('\n[E1] onOrderStatusChange pays the delivery record\'s entitlement');
  {
    const id = 'r5-e1', rider = 'r5-rider-e1';
    const { pinned } = await boundQuote(id);
    await serverDelivery(id, pinned, rider);
    const o = await order(id, { assignedDriverUid: rider, deliveryFee: 500 });
    await deliver(id, o); await settle();
    ok(await balance(rider) === EXPECT, 'E1-1', `rider paid the quoted entitlement KES ${EXPECT} (got ${await balance(rider)}), not deliveryFee − 12% (440)`);
    const t = (await db.collection('walletTransactions').doc(`${rider}_${id}_delivery`).get()).data() || {};
    ok(t.entitlementMinor === E && t.quoteId === pinned.quoteId, 'E1-2', 'the credit records the exact entitlement and the quote it came from');
    const f = (await feesRecord(id))[0] || {};
    ok(f.status === 'credited' && f.riderFeeKES === E / 100 && f.totalFeeKES === pinned.customerCharge.minorUnits / 100,
      'E1-3', 'deliveryFees carries the QUOTE\'s figures, not a split recomputed from the order');
    /* Exactly-once is judged on its own: the balance does not MOVE, whatever the first amount was. */
    const beforeRefire = await balance(rider);
    await deliver(id, o, 'out_for_delivery'); await settle();
    ok(beforeRefire > 0 && await balance(rider) === beforeRefire, 'E1-4', 'a re-fired delivered transition pays nothing more (exactly-once)');
  }
  {
    const id = 'r5-e1b', rider = 'r5-rider-e1b';
    const { pinned } = await boundQuote(id);
    await serverDelivery(id, pinned, rider);
    const o = await order(id, { assignedDriverUid: rider, deliveryFee: 5000 });
    await deliver(id, o); await settle();
    ok(await balance(rider) === EXPECT, 'E1-5', `a 10x larger order.deliveryFee changes nothing: KES ${await balance(rider)} (old rule: 4400)`);
  }

  /* ── [E2] the rider is owed the same whatever happens to the buyer ── */
  console.log('\n[E2] the entitlement is independent of the buyer\'s refund');
  {
    const id = 'r5-e2', rider = 'r5-rider-e2';
    const { pinned } = await boundQuote(id);
    await serverDelivery(id, pinned, rider);
    const o = await order(id, { assignedDriverUid: rider, refundStatus: 'refunded', refundAmount: 1500,
      disputeStatus: 'open', escrowStatus: 'refunded' });
    await db.collection('disputes').doc('r5-e2-d').set({ orderId: id, status: 'open', reason: 'defective' });
    await db.collection('escrow').doc(id).set({ orderId: id, status: 'refunded', refundedAmount: 1500 });
    await deliver(id, o); await settle();
    /* Independence judged on its own: the refunded order pays the rider what its un-refunded twin
       (E1, same fee, same trip) paid — whatever that amount is under the tree being tested. */
    const twin = await balance('r5-rider-e1');
    ok(twin > 0 && await balance(rider) === twin, 'E2-1',
      `a 100%-refunded, disputed order pays the rider exactly what the un-refunded twin did (${await balance(rider)} vs ${twin})`);
    if (RE) {
      const a = await RE.forOrder(db, id);
      await db.collection('orders').doc(id).update({ refundStatus: null, disputeStatus: null });
      const b = await RE.forOrder(db, id);
      ok(a.ok && b.ok && a.minorUnits === b.minorUnits && a.minorUnits === E, 'E2-2', 'the entitlement is identical with and without the refund');
    } else ok(false, 'E2-2', 'no rider-entitlement authority exists in this tree');
    const src = RE ? fs.readFileSync(path.join(FN, 'rider-entitlement.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '') : '';
    ok(!!RE && !/refund|dispute|escrow|deliveryFee\b|driverNet/i.test(src), 'E2-3',
      'the authority\'s code reads no refund, dispute, escrow, order deliveryFee or driverNet');
  }

  /* ── [E3] what the delivery record can NOT make you pay ── */
  console.log('\n[E3] refusals — nobody is paid, and the reason is recorded');
  {
    /* a browser-authored record (the rules let any signed-in user create one) naming the attacker */
    const id = 'r5-e3a';
    const { pinned } = await boundQuote(id);
    await db.collection('packageRequests').doc('DEL-r5e3a').set({ uid: ATTACKER, orderId: id, deliveryQuote: pinned,
      assignedDriverId: ATTACKER, riderId: ATTACKER, status: 'driver_accepted' });
    const o = await order(id, { assignedDriverUid: ATTACKER });
    await deliver(id, o); await settle();
    ok(await balance(ATTACKER) === 0, 'E3-1', `a browser-authored delivery record pays nobody (attacker got ${await balance(ATTACKER)})`);
    const f = (await feesRecord(id))[0] || {};
    ok(f.status === 'blocked' && f.blockedReason === 'delivery_record_client_authored', 'E3-2',
      `…and says why (status=${f.status}, reason=${f.blockedReason})`);
  }
  {
    /* a real server record + a browser decoy naming the attacker: the real rider is paid, only */
    const id = 'r5-e3b', rider = 'r5-rider-e3b';
    const { pinned } = await boundQuote(id);
    await serverDelivery(id, pinned, rider);
    await db.collection('packageRequests').doc('DEL-r5e3b').set({ uid: 'r5-attacker-e3b', orderId: id, deliveryQuote: pinned,
      assignedDriverId: 'r5-attacker-e3b', status: 'driver_accepted' });
    const o = await order(id, { assignedDriverUid: rider });
    await deliver(id, o); await settle();
    /* Diversion only — the amount is E1's business. */
    ok(await balance(rider) > 0 && await balance('r5-attacker-e3b') === 0, 'E3-3', 'a browser decoy beside the real record diverts nothing');
  }
  {
    /* a quote bound to ANOTHER order */
    const id = 'r5-e3c', rider = 'r5-rider-e3c';
    const { pinned } = await boundQuote('r5-some-other-order');
    await serverDelivery(id, pinned, rider);
    const o = await order(id, { assignedDriverUid: rider });
    await deliver(id, o); await settle();
    const f = (await feesRecord(id))[0] || {};
    ok(await balance(rider) === 0 && f.blockedReason === 'quote_not_bound_to_this_order', 'E3-4',
      `a quote bound to another order pays nothing (paid ${await balance(rider)}, reason=${f.blockedReason})`);
  }
  {
    /* a pin inflated for the rider but still self-consistent and in-band */
    const id = 'r5-e3d', rider = 'r5-rider-e3d';
    const { pinned } = await boundQuote(id);
    const forged = JSON.parse(JSON.stringify(pinned));
    forged.riderEarning.minorUnits += 100; forged.customerCharge.minorUnits += 100;
    await serverDelivery(id, forged, rider);
    const o = await order(id, { assignedDriverUid: rider });
    await deliver(id, o); await settle();
    const f = (await feesRecord(id))[0] || {};
    ok(await balance(rider) === 0 && f.blockedReason === 'pinned_quote_diverges_from_issued_quote', 'E3-5',
      `a pin that differs from the ISSUED quote pays nothing (paid ${await balance(rider)}, reason=${f.blockedReason})`);
  }
  {
    /* a legacy record with no pinned quote — every production record today */
    const id = 'r5-e3e', rider = 'r5-rider-e3e';
    await serverDelivery(id, null, rider, { driverNet: 180, deliveryFee: 220 });
    const o = await order(id, { assignedDriverUid: rider });
    await deliver(id, o); await settle();
    const f = (await feesRecord(id))[0] || {};
    ok(await balance(rider) === 0 && f.status === 'blocked' && f.blockedReason === 'no_pinned_quote', 'E3-6',
      `no pinned quote: nothing paid, not a browser driverNet or a percentage (paid ${await balance(rider)}, reason=${f.blockedReason})`);
    ok(f.riderFeeKES === null && f.platformFeeKES === null, 'E3-7', 'an unknown entitlement is recorded as null, never 0');
  }
  {
    /* the order names a different rider than the server assigned */
    const id = 'r5-e3f', rider = 'r5-rider-e3f';
    const { pinned } = await boundQuote(id);
    await serverDelivery(id, pinned, rider);
    const o = await order(id, { assignedDriverUid: 'r5-attacker-e3f' });
    await deliver(id, o); await settle();
    const f = (await feesRecord(id))[0] || {};
    ok(await balance('r5-attacker-e3f') === 0 && await balance(rider) === 0 && f.blockedReason === 'rider_mismatch', 'E3-8',
      `an order naming another rider pays nobody (reason=${f.blockedReason})`);
  }

  /* ── [E4] processDriverEarning — the queue names an order, not an amount ── */
  console.log('\n[E4] processDriverEarning pays the entitlement, never the queued amount');
  {
    const id = 'r5-e4', rider = 'r5-rider-e4';
    const { pinned } = await boundQuote(id);
    await serverDelivery(id, pinned, rider);
    await order(id, { assignedDriverUid: rider });
    const qref = db.collection('driverEarningQueue').doc('r5-e4-q');
    await qref.set({ riderId: rider, orderId: id, amount: 999999, source: 'trip' });
    const ev = { data: await qref.get(), params: { docId: 'r5-e4-q' } };
    await tryRun(() => idx.processDriverEarning.run(ev));
    ok(await balance(rider) === EXPECT, 'E4-1', `queued amount 999999 ignored; paid the entitlement KES ${EXPECT} (got ${await balance(rider)})`);
    ok(((await qref.get()).data() || {}).processed === true, 'E4-2', 'the queue entry is marked processed');
    const afterFirst = await balance(rider);
    const q2 = db.collection('driverEarningQueue').doc('r5-e4-q2');
    await q2.set({ riderId: rider, orderId: id, amount: 50 });
    await tryRun(async () => idx.processDriverEarning.run({ data: await q2.get(), params: { docId: 'r5-e4-q2' } }));
    const o = (await db.collection('orders').doc(id).get()).data();
    await deliver(id, o); await settle();
    ok(afterFirst > 0 && await balance(rider) === afterFirst, 'E4-3', 'a second queue entry and the delivered trigger pay nothing more (one shared key)');
    const q3 = db.collection('driverEarningQueue').doc('r5-e4-q3');
    await q3.set({ riderId: 'r5-attacker-e4', orderId: id, amount: 5000 });
    await tryRun(async () => idx.processDriverEarning.run({ data: await q3.get(), params: { docId: 'r5-e4-q3' } }));
    ok(await balance('r5-attacker-e4') === 0, 'E4-4', 'a queue entry naming another rider pays that rider nothing');
  }

  /* ── [E5] the finos callables — no 88%, no caller-named rider ── */
  console.log('\n[E5] recordPayment / finosRecordTransaction delegate to the entitlement');
  for (const [name, mk] of [
    ['recordPayment', (id, fee, riderId) => ({ orderId: id, orderAmountCents: 150000, category: 'marketplace',
      sellerId: SELLER, buyerId: BUYER, riderId, deliveryFeeCents: fee })],
    ['finosRecordTransaction', (id, fee, riderId) => ({ hubType: 'marketplace', transactionId: id, amountCents: 150000,
      sellerId: SELLER, buyerId: BUYER, riderId, deliveryFeeCents: fee })],
  ]) {
    const id = 'r5-e5-' + name, rider = 'r5-rider-e5-' + name;
    const { pinned } = await boundQuote(id);
    await serverDelivery(id, pinned, rider);
    await order(id, { assignedDriverUid: rider });
    const charge = pinned.customerCharge.minorUnits;
    /* The refused call uses its OWN order: both callables take a per-transaction lock before any
       check, so a refused call on the same id would make the good call a "duplicate". */
    const badId = id + '-x';
    const bq = await boundQuote(badId);
    await serverDelivery(badId, bq.pinned, rider);
    await order(badId, { assignedDriverUid: rider });
    const bad = await tryRun(() => idx[name].run(REQ(BUYER, mk(badId, 50000, ('r5-attacker-e5-' + name)))));
    ok(!!bad.error && await finosCents(('r5-attacker-e5-' + name)) === 0 && (await ledgerFor(badId)).length === 0, `E5-${name}-1`,
      `${name}: a caller-named rider and a fee that is not the quoted charge are refused, nothing recorded`);
    const good = await tryRun(() => idx[name].run(REQ(BUYER, mk(id, charge, null))));
    const riderLines = (await ledgerFor(id)).filter((e) => e.type === 'delivery_fee');
    ok(!good.error && riderLines.length === 1 && riderLines[0].amountCents === E && riderLines[0].riderId === rider,
      `E5-${name}-2`, `${name}: the rider line is the entitlement (${riderLines[0] && riderLines[0].amountCents} vs ${E}) for the assigned rider${good.error ? ' — ERR ' + good.error.message : ''}`);
  }

  /* ── [E6] the settlement engine derives no rider figure ── */
  console.log('\n[E6] settlement-engine takes the entitlement, never a percentage');
  {
    const ent = { ok: true, riderUid: 'r5-se', minorUnits: 16400, customerChargeMinor: 20000, sokoniCommissionMinor: 3600 };
    const b = await tryRun(() => SE.computeSettlement(db, { grossCents: 100000, category: 'marketplace', sellerId: SELLER,
      deliveryFeeCents: 20000, riderEntitlement: ent, riderPct: 0.5 }));
    ok(!b.error && b.value.delivery.riderNetCents === 16400 && b.value.delivery.platformCents === 3600, 'E6-1',
      `rider line = entitlement 16400 (got ${b.value && b.value.delivery.riderNetCents}); riderPct ignored; no 0.88 default`);
    const n = await tryRun(() => SE.computeSettlement(db, { grossCents: 100000, category: 'marketplace', sellerId: SELLER,
      deliveryFeeCents: 20000, riderId: 'r5-se' }));
    ok(!!n.error, 'E6-2', 'a delivery fee with no entitlement is refused, not priced at a default share');
  }

  /* ── [S] no independent rider rule survives in the server ── */
  console.log('\n[S] static — the server has one rider-pay authority');
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const files = fs.readdirSync(FN).filter((f) => f.endsWith('.js')).map((f) => [f, strip(fs.readFileSync(path.join(FN, f), 'utf8'))]);
  /* A rider figure as a share of a delivery fee: `deliveryCents * 0.88`, `fee * 0.8`,
     `_delivery * 0.8`, or a percentage default — the shapes all five former rules took. */
  const pctRule = /\b(\w*deliveryFee\w*|deliveryCents|_delivery|fee|feeCents)\s*\*\s*0?\.\d+|DEFAULT_RIDER_PCT|\briderPct\b/;
  const hits = files.filter(([, t]) => t.split('\n').some((l) => pctRule.test(l))).map(([f]) => f);
  ok(hits.length === 0, 'S-1', `no rider percentage of a fee in functions/ (${hits.join(', ') || 'none'})`);
  ok(strip('a /* x * 0.88 */ b').indexOf('0.88') === -1 && pctRule.test('riderEarnings = deliveryCents * 0.88')
    && pctRule.test('driverNet: Math.round(fee * 0.8)') && !pctRule.test('onTimeDeliveryRate * 0.5'), 'S-2',
    'CONTROL — the stripper removes comments and the detector matches the old rule');
  const writers = files.filter(([f, t]) => /['"]delivery_earning['"]/.test(t) && /balance\s*:\s*\w*\.?increment/i.test(t))
    .map(([f]) => f).filter((f) => f !== 'rider-entitlement.js');
  ok(!!RE && writers.length === 0, 'S-3', `wallets.balance delivery_earning is written only by rider-entitlement.js (others: ${writers.join(', ') || 'none'})`);

  console.log(`\n${pass} pass / ${fail} fail`);
  clearTimeout(WATCHDOG);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('  ✖ CRASH', e && e.stack); clearTimeout(WATCHDOG); process.exit(2); });
