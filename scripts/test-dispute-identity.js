'use strict';
/**
 * CERTIFICATION — Repair 2: one canonical identity for a dispute (buyerUid · sellerUid · reason).
 *
 * Built on the REAL production order shapes (scripts/fixtures/prod-order-identity-shapes-20260926.json:
 * all 10 production orders, uids pseudonymised, field presence and agreement exact). Dates are rebased
 * to "now" so createDispute's 30-day window — not under test — does not refuse them.
 *
 * Proves, on a real Firestore emulator with the REAL callables:
 *   · every legitimate buyer of the 10 orders can open a dispute (the old code refused ALL of them)
 *   · every other identity is refused — other buyers, the seller, a stranger — and nothing is written
 *   · the dispute is written ONLY in canonical names; every reader agrees with the writer
 *   · the buyer is ONE uid by precedence (synthetic: a merged order whose uid is a deprecated account)
 *   · the SERVED rules now match real dispute documents (they never matched the old field names)
 * Refuses to run without FIRESTORE_EMULATOR_HOST.
 */
const path = require('path');
const fs = require('fs');
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const FN = process.env.REFUND_FUNCTIONS_DIR || path.join(__dirname, '..', 'functions');
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-dispute-identity';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
const TS = admin.firestore.Timestamp;
const D = require(path.join(FN, 'disputes.js'));
const SHAPES = require(path.join(__dirname, 'fixtures', 'prod-order-identity-shapes-20260926.json'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };
const call = async (fn, uid, data, token) => { try { return { ok: true, v: await fn.run({ auth: { uid, token: token || {} }, data }) }; } catch (e) { return { ok: false, code: e.code || e.message }; } };
const LEGACY = ['buyerId', 'sellerId', 'customerId', 'type', 'uid'];
const IDS = [...new Set(SHAPES.orders.flatMap((o) => [o.buyerUid, o.uid, o.sellerUid].filter(Boolean)))];
const STRANGER = 'STRANGER_uid';
const buyerOf = (o) => o.buyerUid || o.buyerId || o.userId || o.customerId || o.uid;

async function wipe() { for (const c of ['orders', 'disputes']) { const s = await db.collection(c).get(); await Promise.all(s.docs.map((d) => d.ref.delete())); } }
async function load() {
  await wipe();
  for (const o of SHAPES.orders) {
    const doc = { status: o.status, total: 97, createdAt: TS.now() };
    for (const k of ['buyerUid', 'buyerId', 'userId', 'customerId', 'uid', 'sellerUid', 'sellerId', 'vendorId', 'shopId']) if (o[k] !== undefined) doc[k] = o[k];
    await db.doc(`orders/${o.order}`).set(doc);
  }
}
const snapAll = async () => JSON.stringify([(await db.collection('orders').get()).docs.map((d) => [d.id, d.data()]).sort(),
  (await db.collection('disputes').get()).docs.map((d) => [d.id, d.data()]).sort()]);
const open = (uid, orderId) => call(D.createDispute, uid, { orderId, reason: 'not_received', description: 'The parcel never arrived at all.' });

(async () => {
  console.log(`[R2-1] every legitimate buyer of the ${SHAPES.count} REAL order shapes can open a dispute`);
  await load();
  const opened = [];
  for (const o of SHAPES.orders) {
    const r = await open(buyerOf(o), o.order);
    if (r.ok) opened.push(o.order);
    else console.log(`    refused ${o.order} buyer ${buyerOf(o)}: ${r.code}`);
  }
  ok(opened.length === SHAPES.count, `${opened.length}/${SHAPES.count} real-shaped orders: the legitimate buyer opened a dispute`);

  console.log('\n[R2-2] every OTHER identity is refused, and nothing is written');
  let refusedAll = true, wrote = false, tried = 0;
  for (const o of SHAPES.orders) {
    await load();
    const before = await snapAll();
    for (const who of IDS.concat([STRANGER]).filter((u) => u !== buyerOf(o))) {
      tried++;
      const r = await open(who, o.order);
      if (r.ok || r.code !== 'permission-denied') { refusedAll = false; console.log(`    NOT refused: ${who} on ${o.order} (${r.code})`); }
    }
    if ((await snapAll()) !== before) wrote = true;
  }
  ok(refusedAll && tried > 0, `${tried} cross-identity attempts (other buyers, the seller, a stranger): all permission-denied`);
  ok(!wrote, 'no order or dispute changed on any refused attempt');

  console.log('\n[R2-3] disputes are written ONLY in canonical names, and every reader agrees');
  await load();
  const ext = SHAPES.orders.filter((o) => o.buyerUid && o.sellerUid && o.buyerUid !== o.sellerUid);
  ok(ext.length === 2, `production has ${ext.length} orders with an outside buyer (${ext.map((o) => o.order).join(', ')})`);
  for (const o of ext) await open(o.buyerUid, o.order);
  const d0 = (await db.doc(`disputes/dp_${ext[0].order}`).get()).data() || {};
  ok(d0.buyerUid === ext[0].buyerUid && d0.sellerUid === ext[0].sellerUid && d0.reason === 'not_received', 'dispute carries buyerUid / sellerUid / reason');
  ok(LEGACY.every((k) => !(k in d0)), `no legacy field written (${LEGACY.filter((k) => k in d0).join(',') || 'none'})`);
  const mine = await call(D.getMyDisputes, ext[0].buyerUid, {});
  ok(mine.ok && mine.v.disputes.length === 1 && mine.v.disputes[0].orderId === ext[0].order, `getMyDisputes: buyer ${ext[0].buyerUid} sees exactly their dispute`);
  const other = await call(D.getMyDisputes, ext[1].buyerUid, {});
  ok(other.ok && other.v.disputes.every((x) => x.orderId === ext[1].order), `getMyDisputes: buyer ${ext[1].buyerUid} does NOT see the other buyer's dispute`);
  const sold = await call(D.getSellerDisputes, ext[0].sellerUid, {});
  ok(sold.ok && sold.v.disputes.length === 2, `getSellerDisputes: the seller sees both disputes on their sales (${sold.ok ? sold.v.disputes.length : sold.code})`);
  ok(!(await call(D.getDisputeDetail, ext[1].buyerUid, { disputeId: `dp_${ext[0].order}` })).ok, 'getDisputeDetail: another buyer is refused');
  ok(!(await call(D.getDisputeDetail, STRANGER, { disputeId: `dp_${ext[0].order}` })).ok, 'getDisputeDetail: a stranger is refused');
  ok((await call(D.getDisputeDetail, ext[0].sellerUid, { disputeId: `dp_${ext[0].order}` })).ok, 'getDisputeDetail: the seller is allowed');
  ok((await call(D.addDisputeEvidence, ext[0].sellerUid, { disputeId: `dp_${ext[0].order}`, evidenceType: 'note', description: 'Dispatched on time' })).ok,
    'addDisputeEvidence: the seller (a party) is allowed');
  ok(!(await call(D.addDisputeEvidence, ext[1].buyerUid, { disputeId: `dp_${ext[0].order}`, evidenceType: 'note', description: 'Not my order' })).ok,
    'addDisputeEvidence: a non-party buyer is refused');
  ok(!(await call(D.sellerRespondToDispute, ext[0].buyerUid, { disputeId: `dp_${ext[0].order}`, response: 'I am the buyer' })).ok, 'sellerRespondToDispute: the buyer is refused');
  ok((await call(D.sellerRespondToDispute, ext[0].sellerUid, { disputeId: `dp_${ext[0].order}`, response: 'We delivered it on the 14th.' })).ok, 'sellerRespondToDispute: the seller is allowed');
  ok(!(await call(D.cancelDispute, ext[0].sellerUid, { disputeId: `dp_${ext[1].order}` })).ok, 'cancelDispute: the seller is refused');
  ok((await call(D.cancelDispute, ext[1].buyerUid, { disputeId: `dp_${ext[1].order}` })).ok, 'cancelDispute: the buyer is allowed');

  const src = (f) => fs.readFileSync(path.join(FN, f), 'utf8');
  /* Anchored on the DISPUTES query: wallet.js has other sellerUid queries (payoutRequests), and an
     unanchored pattern passed on the old code by matching one of those. */
  ok(/collection\('disputes'\)\.where\('sellerUid', '==', uid\)/.test(src('wallet.js')), 'wallet.js _hasOpenDispute queries disputes by sellerUid (static)');
  ok(/dispute\.reason === 'not_received'/.test(src('automation-engine.js')) && !/dispute\.(type|buyerId|sellerId)\b/.test(src('automation-engine.js')),
    'automation-engine reads reason / buyerUid / sellerUid (static)');
  ok(/emailForUid\(d\.buyerUid/.test(src('email-triggers.js')) && /emailForUid\(after\.buyerUid/.test(src('email-triggers.js')), 'dispute emails address the buyerUid (static)');

  console.log('\n[R2-4] ONE buyer by precedence (SYNTHETIC — production has no uid/buyerUid disagreement today)');
  await wipe();
  await db.doc('orders/MERGED').set({ uid: 'DEPRECATED_acct', buyerUid: 'CANONICAL_acct', sellerUid: 'SELLER_x', status: 'delivered', total: 97, createdAt: TS.now() });
  const dep = await open('DEPRECATED_acct', 'MERGED');
  ok(!dep.ok && dep.code === 'permission-denied', `the deprecated account (order.uid) is refused (${dep.code})`);
  ok((await open('CANONICAL_acct', 'MERGED')).ok, 'the canonical buyer (order.buyerUid) is accepted');

  console.log('\n[R2-5] the SERVED rules now match real disputes');
  let RUT = null;
  try { RUT = require('@firebase/rules-unit-testing'); } catch (e) { ok(false, 'rules-unit-testing available'); }
  const servedPath = process.env.SERVED_RULES_PATH;
  if (RUT && servedPath && fs.existsSync(servedPath)) {
    const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
    const env = await RUT.initializeTestEnvironment({ projectId: (PROJECT + '-rules').toLowerCase(), firestore: { rules: fs.readFileSync(servedPath, 'utf8'), host, port: Number(port) } });
    try {
      await env.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc('disputes/dp_NEW').set({ orderId: 'NEW', buyerUid: 'B1', sellerUid: 'S1', reason: 'not_received', status: 'open', evidence: [] });
        await ctx.firestore().doc('disputes/dp_OLD').set({ orderId: 'OLD', buyerId: 'B1', sellerId: 'S1', reason: 'not_received', status: 'open', evidence: [] });
      });
      const can = async (uid, p) => { try { await env.authenticatedContext(uid).firestore().doc(p).get(); return true; } catch (_) { return false; } };
      ok(await can('B1', 'disputes/dp_NEW') && await can('S1', 'disputes/dp_NEW'), 'canonical dispute: buyer and seller CAN read it under the served rules');
      ok(!(await can('B2', 'disputes/dp_NEW')), 'canonical dispute: another user cannot');
      ok(!(await can('B1', 'disputes/dp_OLD')) && !(await can('S1', 'disputes/dp_OLD')),
        'CONTROL: the OLD field names were never matched by the served rules — buyer and seller could not read their own dispute');
    } finally { await env.cleanup(); }
  } else { console.log('  (SERVED_RULES_PATH not set — served-rules checks NOT run)'); }

  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH (not a verdict):', e && e.stack || e); process.exit(3); });
