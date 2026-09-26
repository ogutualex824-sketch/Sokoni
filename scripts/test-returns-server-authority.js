'use strict';
/**
 * CERTIFICATION — Repair 4: a return is a REQUEST the server creates — the browser writes nothing.
 *
 * The server decides: the buyer (ONE uid, Repair 2), ownership, the reason (the ONE reason authority,
 * Repair 3), payment, delivery, the published 7-day window and evidence requirement, and the items with
 * the ORDER's prices. It moves NO money and decides no refund, fee or liability (H2).
 *
 * E-parts drive the REAL returns callables on a Firestore emulator, over the REAL production order shapes
 * (scripts/fixtures/prod-order-identity-shapes-20260926.json). R-part loads the SERVED rules. S-part
 * checks the page and sokoni-trust.js. Refuses to run without FIRESTORE_EMULATOR_HOST.
 */
const path = require('path');
const fs = require('fs');
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const FN = process.env.REFUND_FUNCTIONS_DIR || path.join(__dirname, '..', 'functions');
const ROOT = process.env.REPAIR_ROOT || path.join(__dirname, '..');
const PROJECT = process.env.GCLOUD_PROJECT || 'demo-returns-authority';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore();
const TS = admin.firestore.Timestamp;
const RET = require(path.join(FN, 'returns-engine.js'));
const SHAPES = require(path.join(__dirname, 'fixtures', 'prod-order-identity-shapes-20260926.json'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };
const call = async (fn, uid, data, token) => { try { return { ok: true, v: await fn.run({ auth: { uid, token: token || {} }, data }) }; } catch (e) { return { ok: false, code: e.code || e.message, reason: e.details && e.details.reason }; } };
const buyerOf = (o) => o.buyerUid || o.buyerId || o.userId || o.customerId || o.uid;
const IDS = [...new Set(SHAPES.orders.flatMap((o) => [o.buyerUid, o.uid, o.sellerUid].filter(Boolean)))];
const DAY = 86400000;
const ITEMS = [{ id: 'P1', name: 'Blue kettle', price: 97, sellerUid: 'x' }, { id: 'P2', name: 'Cup', price: 40 }];
const MONEY = ['wallets', 'walletTransactions', 'payments', 'refundAuthority', 'ledger', 'paymentLedger'];

async function wipe() { for (const c of ['orders', 'returns'].concat(MONEY)) { const s = await db.collection(c).get(); await Promise.all(s.docs.map((d) => d.ref.delete())); } }
async function loadShapes(extra) {
  await wipe();
  for (const o of SHAPES.orders) {
    const doc = Object.assign({ status: 'delivered', total: 97, paymentVerified: true, deliveredAt: TS.fromMillis(Date.now() - 2 * DAY), items: ITEMS, createdAt: TS.now() }, extra || {});
    for (const k of ['buyerUid', 'buyerId', 'userId', 'customerId', 'uid', 'sellerUid', 'sellerId', 'vendorId', 'shopId']) if (o[k] !== undefined) doc[k] = o[k];
    /* R4_WITH_LEGACY_BUYERID=1 also sets the legacy buyerId the OLD engine requires, so a counterproof run can
       reach its price / eligibility behaviour instead of stopping at the identity defect. */
    if (process.env.R4_WITH_LEGACY_BUYERID === '1') { doc.buyerId = doc.buyerUid; doc.sellerId = doc.sellerUid; }
    await db.doc(`orders/${o.order}`).set(doc);
  }
}
/* Every submit also SENDS client items (the old engine required them). The repaired server ignores them — so
   this both proves "client items never count" on every call and lets the old code reach its eligibility logic. */
const submit = (uid, orderId, more) => call(RET.submitReturn, uid, Object.assign({ orderId, reason: 'defective', description: 'It stopped working on day two.',
  resolution: 'refund', items: [{ productId: 'P1', name: 'Blue kettle', qty: 1, price: 97 }] }, more || {}));
const snapAll = async () => JSON.stringify([(await db.collection('orders').get()).docs.map((d) => [d.id, d.data()]).sort(), (await db.collection('returns').get()).size]);

(async () => {
  console.log(`[E1] identity: every legitimate buyer of the ${SHAPES.count} REAL order shapes can request a return`);
  await loadShapes();
  let okCount = 0;
  for (const o of SHAPES.orders) { const r = await submit(buyerOf(o), o.order); if (r.ok) okCount++; else console.log(`    refused ${o.order}: ${r.code}`); }
  ok(okCount === SHAPES.count, `${okCount}/${SHAPES.count} legitimate buyers (delivered 2 days ago, paid)`);
  let refused = true, wrote = false, tried = 0;
  for (const o of SHAPES.orders) {
    await loadShapes(); const before = await snapAll();
    for (const who of IDS.concat(['STRANGER']).filter((u) => u !== buyerOf(o))) {
      tried++; const r = await submit(who, o.order);
      if (r.ok || r.code !== 'permission-denied') { refused = false; console.log(`    NOT refused ${who} on ${o.order}: ${r.code}`); }
    }
    if ((await snapAll()) !== before) wrote = true;
  }
  ok(refused && tried > 0, `${tried} cross-identity attempts refused (permission-denied)`);
  ok(!wrote, 'nothing written on any refused attempt');

  console.log('\n[E2] eligibility is the server\'s, from the published policy');
  const one = async (extra, label, want) => { await loadShapes(extra); const r = await submit(buyerOf(SHAPES.orders[1]), SHAPES.orders[1].order);
    ok(!r.ok && r.code === 'failed-precondition' && r.reason === want && (await db.collection('returns').get()).size === 0, `${label} -> refused [${r.reason}], nothing written`); };
  await one({ paymentVerified: false, paymentStatus: 'pending' }, 'unpaid order', 'order-not-paid');
  await one({ deliveredAt: null, status: 'in_transit' }, 'not yet delivered', 'order-not-delivered');
  await one({ deliveredAt: TS.fromMillis(Date.now() - 8 * DAY) }, 'delivered 8 days ago (7-day window)', 'return-window-closed');
  await loadShapes({ deliveredAt: TS.fromMillis(Date.now() - 6 * DAY) });
  const in6 = await submit(buyerOf(SHAPES.orders[1]), SHAPES.orders[1].order);
  ok(in6.ok && in6.v.windowEndsAt, `delivered 6 days ago -> accepted; window ends ${String((in6.ok && in6.v.windowEndsAt) || '?').slice(0, 10)}`);

  console.log('\n[E3] items and prices come from the ORDER, never the client');
  await loadShapes();
  const o = SHAPES.orders[1];
  await submit(buyerOf(o), o.order, { items: [{ productId: 'P1', name: 'Gold bar', price: 999999, qty: 50 }], price: 999999, refundAmount: 999999 });
  const doc = (await db.doc(`returns/ret_${o.order}_${buyerOf(o)}`).get()).data() || {};
  ok(Array.isArray(doc.items) && doc.items.length === 2 && doc.items[0].name === 'Blue kettle' && doc.items[0].price === 97 && doc.items[0].qty === 1,
    'client items / prices / quantities ignored: the ORDER\'s items are stored (Blue kettle KES 97 x1)');
  ok(doc.refundAmount === null && !JSON.stringify(doc).includes('999999'), 'no client amount anywhere in the stored request');
  await loadShapes();
  await submit(buyerOf(o), o.order, { productIds: ['P2'] });
  const sub = (await db.doc(`returns/ret_${o.order}_${buyerOf(o)}`).get()).data() || {};
  ok(sub.items && sub.items.length === 1 && sub.items[0].productId === 'P2' && sub.items[0].price === 40, 'a chosen subset of the order\'s items (by productId) keeps the order\'s price');
  await loadShapes();
  const unk = await submit(buyerOf(o), o.order, { productIds: ['NOT_ON_ORDER'] });
  ok(!unk.ok && unk.reason === 'item-not-on-this-order', `an item not on the order is refused [${unk.reason}]`);

  console.log('\n[E4] the ONE reason authority, and the evidence requirement');
  await loadShapes();
  await submit(buyerOf(o), o.order, { reason: 'changed_mind' });
  const al = (await db.doc(`returns/ret_${o.order}_${buyerOf(o)}`).get()).data() || {};
  ok(al.reason === 'buyer_request' && al.evidenceRequired === false, 'changed_mind stored as buyer_request; no evidence required');
  await loadShapes();
  ok(!(await submit(buyerOf(o), o.order, { reason: 'counterfeit' })).ok, 'counterfeit is not a return reason (unchanged)');
  await loadShapes(); await submit(buyerOf(o), o.order, { reason: 'wrong_item' });
  ok(((await db.doc(`returns/ret_${o.order}_${buyerOf(o)}`).get()).data() || {}).evidenceRequired === true, 'wrong_item: photos required (published policy)');
  await loadShapes(); await submit(buyerOf(o), o.order, { reason: 'damaged' });
  ok(((await db.doc(`returns/ret_${o.order}_${buyerOf(o)}`).get()).data() || {}).evidenceRequired === false, 'damaged: no evidence requirement stated by the policy');

  console.log('\n[E5] canonical identity end to end: list, seller scope, review');
  const ext = SHAPES.orders.find((x) => x.buyerUid !== x.sellerUid);
  await loadShapes(); await submit(ext.buyerUid, ext.order);
  const rid = `ret_${ext.order}_${ext.buyerUid}`;
  const rd = (await db.doc(`returns/${rid}`).get()).data() || {};
  ok(rd.buyerUid === ext.buyerUid && rd.sellerUid === ext.sellerUid && !('buyerId' in rd) && !('sellerId' in rd), 'stored with buyerUid / sellerUid only');
  const mine = await call(RET.getMyReturns, ext.buyerUid, {});
  ok(mine.ok && mine.v.length === 1 && mine.v[0].returnId === rid, 'getMyReturns: the buyer sees their request');
  const sel = await call(RET.getSellerReturns, ext.sellerUid, {});
  ok(sel.ok && sel.v.some((x) => x.returnId === rid), 'getSellerReturns: the seller sees it WITHOUT holding a seller claim');
  const strg = await call(RET.getSellerReturns, 'STRANGER', {});
  ok(strg.ok && strg.v.length === 0, 'a stranger sees nothing');
  ok(!(await call(RET.reviewReturn, ext.buyerUid, { returnId: rid, action: 'approve' })).ok, 'the buyer cannot review their own return');
  ok(!(await call(RET.reviewReturn, 'STRANGER', { returnId: rid, action: 'approve' })).ok, 'a stranger cannot review it');
  const ap = await call(RET.reviewReturn, ext.sellerUid, { returnId: rid, action: 'approve' });
  ok(ap.ok && ap.v.status === 'approved', 'the seller (no claim) can approve their own return');

  console.log('\n[E6] no money moves — this is a request, not a refund');
  const moved = [];
  for (const c of MONEY) if ((await db.collection(c).get()).size) moved.push(c);
  ok(moved.length === 0, `after submit + approve, nothing written to ${MONEY.join(' / ')} (${moved.join(',') || 'none'})`);

  console.log('\n[R] the browser cannot write a return record (SERVED rules)');
  let RUT = null; try { RUT = require('@firebase/rules-unit-testing'); } catch (_) {}
  const servedPath = process.env.SERVED_RULES_PATH;
  if (!RUT || !servedPath || !fs.existsSync(servedPath)) console.log('  (SERVED_RULES_PATH / rules-unit-testing unavailable — rules checks NOT run)');
  else {
    const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
    for (const [label, rules, expectDenied] of [['served', fs.readFileSync(servedPath, 'utf8'), true],
      ['COUNTERPROOF allow-all', "rules_version = '2';\nservice cloud.firestore { match /databases/{d}/documents { match /{x=**} { allow read, write: if true; } } }", false]]) {
      const env = await RUT.initializeTestEnvironment({ projectId: ('demo-ret-rules-' + label).toLowerCase().replace(/[^a-z0-9-]/g, ''), firestore: { rules, host, port: Number(port) } });
      try {
        await env.withSecurityRulesDisabled(async (ctx) => { await ctx.firestore().doc('returns/R1').set({ buyerId: 'B', status: 'submitted' }); });
        const b = env.authenticatedContext('B').firestore();
        for (const [what, fn] of [['buyer creates a return directly', () => b.collection('returns').add({ orderId: 'X', buyerUid: 'B', items: [{ price: 999999 }] })],
                                   ['buyer approves a return directly', () => b.doc('returns/R1').update({ status: 'approved' })]]) {
          let denied = false; try { await fn(); } catch (e) { denied = /PERMISSION_DENIED|permission/i.test(e.code || e.message); }
          ok(denied === expectDenied, `${label}: ${what}: ${denied ? 'DENIED' : 'ALLOWED'}`);
        }
      } finally { await env.cleanup(); }
    }
  }

  console.log('\n[S] the page and the client library write nothing themselves');
  const page = fs.readFileSync(path.join(ROOT, 'returns.html'), 'utf8');
  const code = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  ok(!/collection\('returns'\)/.test(code), 'returns.html: no direct Firestore access to returns');
  ok(!/httpsCallable\('processReturn'\)/.test(code), 'returns.html: the nonexistent processReturn is not called');
  ok(['submitReturn', 'getMyReturns', 'getSellerReturns', 'reviewReturn', 'adminForceReturn'].every((n) => code.includes(`httpsCallable('${n}')`)), 'returns.html: every read and write goes through the returns callables');
  ok(!/refund initiated|trigger refund/i.test(page), 'returns.html: no message claims a refund was started');
  const subCall = (code.match(/httpsCallable\('submitReturn'\)\(\{([^}]*)\}\)/) || [])[1] || '';
  ok(subCall && !/price|items|amount/i.test(subCall), `returns.html: the submit payload carries no items / price / amount ({${subCall.trim()}})`);
  const trust = fs.readFileSync(path.join(ROOT, 'sokoni-trust.js'), 'utf8');
  const rr = (trust.match(/requestRefund: async function[\s\S]*?\n    \},/) || [''])[0].replace(/\/\*[\s\S]*?\*\//g, '');
  ok(rr && !/updateDoc|setDoc|refundAmount/.test(rr), 'sokoni-trust.js requestRefund writes nothing and carries no client amount');

  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH (not a verdict):', e && e.stack || e); process.exit(3); });
