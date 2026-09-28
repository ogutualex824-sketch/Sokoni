'use strict';
/**
 * CERTIFICATION — Q0b-2a: recordPOSSale's named customer must be the bound seller's own.
 *
 * Runs the REAL recordPOSSale handler (pos-retail-engine `_h`, the one smartPosDispatch routes to) against
 * the Firestore EMULATOR. Pointed at the pre-2a tree (REPAIR_ROOT = export of 287bf37) a sale naming another
 * merchant's customer must SUCCEED and carry that customer into the sale, the receipt and a loyalty award; on
 * this tree it must be REFUSED with nothing written, while walk-in and own-customer sales still work.
 *
 *   C  controls: walk-in; own customer by phone, by composite id, by document id; an admin for the seller named
 *   R  a named customer that is foreign / unowned / malformed / conflicting / missing → ONE refusal, no write,
 *      the foreign document BYTE-UNCHANGED (data and updateTime), stock unchanged
 *   S  an owner that changes before the stock transaction refuses the sale; one that changes after the sale
 *      committed is never credited
 *   N  no foreign name / phone / tier / points total appears in any written sale or receipt, and the
 *      existing posRetailSales records (the 5-record production shape) are untouched
 *
 *   REPAIR_ROOT  tree under test (default: this repo). Refuses without FIRESTORE_EMULATOR_HOST.
 */
const path = require('path');

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-q0b2a';
const WATCHDOG = setTimeout(() => { process.stdout.write('\n  ✖ WATCHDOG — suite exceeded 240s\n'); process.exit(3); }, 240000);

const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

let pass = 0, fail = 0;
const ok = (c, id, m) => { if (c) pass++; else fail++; process.stdout.write('  ' + (c ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + '\n'); };
const _REAL = { so: process.stdout.write.bind(process.stdout), se: process.stderr.write.bind(process.stderr),
  cw: console.warn, ce: console.error, cl: console.log };
let _quietDepth = 0;
async function quiet(fn) {
  if (_quietDepth++ === 0) {
    process.stdout.write = () => true; process.stderr.write = () => true;
    console.warn = () => {}; console.error = () => {}; console.log = () => {};
  }
  try { return await fn(); } finally {
    if (--_quietDepth === 0) {
      process.stdout.write = _REAL.so; process.stderr.write = _REAL.se;
      console.warn = _REAL.cw; console.error = _REAL.ce; console.log = _REAL.cl;
    }
  }
}

/* S-1: the pre-transaction read of a named customer (DocumentReference.get) sees it owned; its owner then
   changes before the stock transaction reads it. S-2: the sale+receipt batch commits; the customer's owner
   then changes before the points are written. Each injection must be seen to fire. */
const proto = Object.getPrototypeOf(db.doc('x/y'));
const _get = proto.get, _update = proto.update;
const batchProto = Object.getPrototypeOf(db.batch());
const _commit = batchProto.commit;
const INJ = { switchOnRead: null, switchAfterCommit: null, fired: 0 };
proto.get = async function (...a) {
  const snap = await _get.apply(this, a);
  if (INJ.switchOnRead && this.path === INJ.switchOnRead.path) {
    const to = INJ.switchOnRead.to; INJ.switchOnRead = null; INJ.fired++;
    await _update.call(this, { sellerId: to });
  }
  return snap;
};
batchProto.commit = async function (...a) {
  const r = await _commit.apply(this, a);
  if (INJ.switchAfterCommit) {
    const { path: p, to } = INJ.switchAfterCommit; INJ.switchAfterCommit = null; INJ.fired++;
    await _update.call(db.doc(p), { sellerId: to });
  }
  return r;
};
/* L-7 LINEAGE NOTE: on this lineage M0-2 commits the sale (claim · stock · sale · receipt) in ONE
   runTransaction, not a batch, so S-2's "after the sale committed" point is the resolution of the first
   transaction the handler runs — before the points transaction. Same injection, same assertion. */
{
  const fsProto = Object.getPrototypeOf(db);
  const _runTx = fsProto.runTransaction;
  fsProto.runTransaction = async function (...a) {
    const r = await _runTx.apply(this, a);
    if (INJ.switchAfterCommit) {
      const { path: p, to } = INJ.switchAfterCommit; INJ.switchAfterCommit = null; INJ.fired++;
      await _update.call(db.doc(p), { sellerId: to });
    }
    return r;
  };
}

/* N-4 READ SPY: every posCustomers document handed back by a Query, a DocumentReference or a Transaction read. */
const SPY = { on: false, seen: [] };
{
  const qProto = Object.getPrototypeOf(Object.getPrototypeOf(db.collection('x')));
  const _qGet = qProto.get;
  qProto.get = async function (...a) { const r = await _qGet.apply(this, a); if (SPY.on) for (const d of r.docs) if (d.ref.path.startsWith('posCustomers/')) SPY.seen.push({ id: d.id, sellerId: d.data().sellerId }); return r; };
  const _dGet2 = proto.get;
  proto.get = async function (...a) { const r = await _dGet2.apply(this, a); if (SPY.on && r.exists && this.path.startsWith('posCustomers/')) SPY.seen.push({ id: r.id, sellerId: r.data().sellerId }); return r; };
  const tProto = require(require.resolve('@google-cloud/firestore', { paths: [FN] })).Transaction.prototype;
  const _tGet = tProto.get;
  tProto.get = async function (ref, ...a) {
    const r = await _tGet.call(this, ref, ...a);
    if (SPY.on && r && r.exists && ref && ref.path && ref.path.startsWith('posCustomers/')) SPY.seen.push({ id: r.id, sellerId: r.data().sellerId });
    return r;
  };
}

let PRE;
try { PRE = require(path.join(FN, 'pos-retail-engine.js')); }
catch (e) { process.stdout.write('  ✖ SETUP — ' + e.message + '\n'); process.exit(2); }

const A = 'q2a-seller-a', B = 'q2a-seller-b';
const SELLER = { role: 'seller' }, ADMIN = { admin: true };
const res = (p) => p.then((out) => ({ ok: true, out }), (e) => ({ ok: false, code: e.code, msg: String(e.message || '') }));
const why = (r) => (r.ok ? 'SOLD ' + JSON.stringify({ tier: r.out.tier, pts: r.out.pointsTotal }) : 'refused [' + r.code + ']: ' + r.msg.slice(0, 70));
const refusedFor = (r, code, re) => !r.ok && r.code === code && (!re || re.test(r.msg));
const NOT_YOURS = /not one of your customers/;
let seq = 0;
async function sale(uid, token, extra) {
  const key = 'q2a-' + (++seq);
  /* L-7 LINEAGE NOTE: M0-2 requires an idempotencyKey (8–128 chars) on every recordPOSSale call. */
  const data = Object.assign({ idempotencyKey: 'l7-q2a-sale-' + seq, items: [{ productId: 'Q2A_P', name: 'Widget', qty: 1, price: 100 }], payment: { method: 'cash', amount: 100 },
    cashierName: key }, extra || {});
  return res(quiet(() => PRE._h.recordPOSSale({ data, auth: { uid, token: Object.assign({ uid }, token) } })));
}
const fingerprint = async (p) => { const s = await db.doc(p).get(); return s.exists ? JSON.stringify(s.data()) + '@' + s.updateTime.toMillis() : 'ABSENT'; };
const stock = async () => Number(((await db.doc('products/Q2A_P').get()).data() || {}).stock);
const salesCount = async () => (await db.collection('posSales').get()).size;
const receiptsCount = async () => (await db.collection('receipts').get()).size;
/* one attempt must leave: no new sale, no new receipt, stock unchanged, the named document byte-unchanged */
async function untouched(fn, docPath) {
  const [s0, r0, k0, f0] = [await salesCount(), await receiptsCount(), await stock(), docPath ? await fingerprint(docPath) : null];
  const r = await fn();
  const same = (await salesCount()) === s0 && (await receiptsCount()) === r0 && (await stock()) === k0 &&
    (!docPath || (await fingerprint(docPath)) === f0);
  return { r, same, before: f0 };
}

(async () => {
  process.stdout.write(`\nQ0b-2a — recordPOSSale customer authorization   (tree: ${ROOT})\n\n`);
  const set = (p, d) => db.doc(p).set(d);
  await set(`sellers/${A}`, { businessName: 'A Shop' });
  await set(`sellers/${B}`, { businessName: 'B Shop' });
  await set('products/Q2A_P', { name: 'Widget', price: 100, stock: 100, sellerUid: A });
  await set('products/Q2B_P', { name: 'B Widget', price: 100, stock: 100, sellerUid: B });
  /* customers — B's carry the "secrets" that must never enter A's books */
  await set('posCustomers/A1R', { sellerId: A, phone: '254711000001', name: 'Ann A', loyaltyPoints: 10 });
  await set(`posCustomers/${A}_254711000002`, { phone: '254711000002', name: 'Comp A', loyaltyPoints: 20 });
  await set('posCustomers/B1R', { sellerId: B, phone: '254711000009', name: 'Bella SECRET-B1', loyaltyPoints: 777 });
  await set(`posCustomers/${B}_254711000008`, { phone: '254711000008', name: 'Boris SECRET-B2', loyaltyPoints: 888 });
  await set('posCustomers/LEGR', { phone: '254711000005', name: 'Legacy SECRET-L', loyaltyPoints: 555 });
  await set(`posCustomers/${A}_254711000006`, { sellerId: 12345, phone: '254711000006', name: 'Malformed SECRET-M', loyaltyPoints: 666 });
  await set(`posCustomers/${A}_254711000007`, { sellerId: B, phone: '254711000007', name: 'Conflict SECRET-C', loyaltyPoints: 999 });
  await set(`posCustomers/${A}_254722000001`, { sellerId: A, phone: '254722000001', name: 'Switch One', loyaltyPoints: 30 });
  await set(`posCustomers/${A}_254722000002`, { sellerId: A, phone: '254722000002', name: 'Switch Two', loyaltyPoints: 40 });
  await set('posCustomers/BADM', { sellerId: B, phone: '254711000003', name: 'Admin-target B', loyaltyPoints: 1 });
  /* the production shape the owner asked to keep in view: 5 posRetailSales records, never touched here */
  for (let i = 1; i <= 5; i++) await set(`posRetailSales/ps_prod_${i}`, { merchantId: 'prod-merchant', grandTotal: 100 * i, loyaltyRedeemed: 0, loyaltyAwarded: 0 });
  const retailBefore = [];
  for (let i = 1; i <= 5; i++) retailBefore.push(await fingerprint(`posRetailSales/ps_prod_${i}`));

  process.stdout.write('[C] controls — walk-in and own-customer sales still work\n');
  { const r = await sale(A, SELLER); ok(r.ok && r.out.pointsTotal === 10 && r.out.tier, 'C-1', 'walk-in (no customer named): ' + why(r)); }
  { const r = await sale(A, SELLER, { customerPhone: '0711000001' });
    const d = (await db.doc('posCustomers/A1R').get()).data();
    ok(r.ok && d.loyaltyPoints === 20 && r.out.pointsTotal === 20, 'C-2', 'own customer by phone: sold and credited 10 → ' + d.loyaltyPoints + ': ' + why(r)); }
  { const r = await sale(A, SELLER, { customerPhone: '+254 711 000 002' });
    const d = (await db.doc(`posCustomers/${A}_254711000002`).get()).data();
    ok(r.ok && d.loyaltyPoints === 30, 'C-3', 'own COMPOSITE-ONLY customer by phone: credited 20 → ' + d.loyaltyPoints + ': ' + why(r)); }
  { const r = await sale(A, SELLER, { customerId: 'A1R' });
    ok(r.ok && (await db.doc('posCustomers/A1R').get()).data().loyaltyPoints === 30, 'C-4', 'own customer by document id: ' + why(r)); }
  { const r = await res(quiet(() => PRE._h.recordPOSSale({ data: { idempotencyKey: 'l7-q2a-admin-c5', sellerId: B, customerId: 'BADM', items: [{ productId: 'Q2B_P', name: 'B Widget', qty: 1, price: 100 }],
      payment: { method: 'cash', amount: 100 } }, auth: { uid: 'q2a-admin', token: { uid: 'q2a-admin', admin: true } } })));
    ok(r.ok && (await db.doc('posCustomers/BADM').get()).data().loyaltyPoints === 11, 'C-5', "an ADMIN recording for seller B with B's own customer (the existing binding): " + why(r)); }

  process.stdout.write('\n[R] a named customer that is not this seller\'s refuses the sale — nothing written, the record byte-unchanged\n');
  const cases = [
    ['R-1', { customerPhone: '0711000009' }, 'posCustomers/B1R', "B's customer by PHONE"],
    ['R-2', { customerId: 'B1R' }, 'posCustomers/B1R', "B's customer by document ID"],
    ['R-3', { customerId: `${B}_254711000008` }, `posCustomers/${B}_254711000008`, "B's COMPOSITE id"],
    ['R-4', { customerPhone: '0711000008' }, `posCustomers/${B}_254711000008`, "B's composite customer by phone"],
    ['R-5', { customerId: 'LEGR' }, 'posCustomers/LEGR', 'a legacy customer with NO owner'],
    ['R-6', { customerPhone: '0711000006' }, `posCustomers/${A}_254711000006`, 'OUR prefix with a MALFORMED sellerId'],
    ['R-7', { customerId: `${A}_254711000007` }, `posCustomers/${A}_254711000007`, "OUR prefix but B's sellerId"],
  ];
  for (const [id, extra, p, label] of cases) {
    const { r, same, before } = await untouched(() => sale(A, SELLER, extra), p);
    ok(refusedFor(r, 'permission-denied', NOT_YOURS) && same && before !== 'ABSENT', id, label + ' → refused, no sale/receipt, stock and record byte-unchanged: ' + why(r));
  }
  { const a = await untouched(() => sale(A, SELLER, { customerId: 'NO_SUCH_CUSTOMER' }));
    const b = await sale(A, SELLER, { customerId: 'B1R' });
    ok(refusedFor(a.r, 'permission-denied', NOT_YOURS) && a.same && !b.ok && a.r.msg === b.msg, 'R-8',
      'a MISSING customer gets the SAME refusal as a foreign one (no existence disclosure), nothing written: ' + why(a.r)); }
  { const { r, same } = await untouched(() => sale(A, SELLER, { customerId: 'B1R/nested/x' }));
    ok(refusedFor(r, 'invalid-argument') && same, 'R-9', 'a customer id that is a PATH: ' + why(r)); }
  { const { r, same } = await untouched(() => sale(A, SELLER, { customerPhone: 'not-a-phone' }));
    ok(refusedFor(r, 'invalid-argument') && same, 'R-10', 'an unreadable customer phone (and no id) is a bad request, not a walk-in: ' + why(r)); }
  { const { r, same } = await untouched(() => sale(A, SELLER, { sellerId: B, customerId: 'B1R' }), 'posCustomers/B1R');
    ok(refusedFor(r, 'permission-denied') && same, 'R-11', "a FORGED sellerId naming B, with B's customer (the existing seller binding holds): " + why(r)); }

  { SPY.on = true; SPY.seen = [];
    for (const extra of [{ customerPhone: '0711000009' }, { customerId: 'B1R' }, { customerId: `${B}_254711000008` }, { customerPhone: '0711000008' }, { customerId: 'LEGR' }]) await sale(A, SELLER, extra);
    SPY.on = false;
    const loaded = SPY.seen.filter((d) => d.sellerId === B || d.id.indexOf(B + '_') === 0 || d.id === 'LEGR');
    ok(loaded.length === 0, 'N-4', "the refused attempts on B's customers and a legacy record never LOAD those documents (owner filter is in the lookup): " +
      (loaded.length ? 'loaded ' + [...new Set(loaded.map((d) => d.id))].join(',') : 'none loaded')); }

  process.stdout.write('\n[S] an owner that changes fails closed\n');
  { const P = `posCustomers/${A}_254722000001`;
    INJ.switchOnRead = { path: P, to: B }; INJ.fired = 0;
    const s0 = await salesCount(), k0 = await stock();
    const r = await sale(A, SELLER, { customerId: `${A}_254722000001` });
    const fired = INJ.fired; INJ.switchOnRead = null;
    const d = (await db.doc(P).get()).data();
    ok(fired === 1 && refusedFor(r, 'permission-denied', NOT_YOURS) && (await salesCount()) === s0 && (await stock()) === k0 && d.loyaltyPoints === 30, 'S-1',
      'owner becomes B between the lookup and the stock transaction → refused INSIDE it, nothing written, no points (injection fired ' + fired + 'x): ' + why(r)); }
  { const P = `posCustomers/${A}_254722000002`;
    INJ.switchAfterCommit = { path: P, to: B }; INJ.fired = 0;
    const r = await sale(A, SELLER, { customerId: `${A}_254722000002` });
    const fired = INJ.fired; INJ.switchAfterCommit = null;
    const d = (await db.doc(P).get()).data();
    ok(fired === 1 && r.ok && d.loyaltyPoints === 40 && d.sellerId === B, 'S-2',
      'owner becomes B AFTER the sale committed → the sale stands, but the customer is NOT credited (points still ' + d.loyaltyPoints + ', injection fired ' + fired + 'x): ' + why(r)); }

  { await set(`posCustomers/${A}_254722000003`, { sellerId: A, phone: '254722000003', name: 'Switch Three', loyaltyPoints: 50 });
    const P = `posCustomers/${A}_254722000003`;
    INJ.switchOnRead = { path: P, to: B }; INJ.fired = 0;
    const s0 = await salesCount();
    const r = await sale(A, SELLER, { customerId: `${A}_254722000003`, items: [{ name: 'Service (no stock)', qty: 1, price: 100 }] });
    const fired = INJ.fired; INJ.switchOnRead = null;
    ok(fired === 1 && refusedFor(r, 'permission-denied', NOT_YOURS) && (await salesCount()) === s0 && (await db.doc(P).get()).data().loyaltyPoints === 50, 'S-3',
      'a SERVICE sale (no stock items) naming a customer whose owner then changes is still re-checked in a transaction → refused (fired ' + fired + 'x): ' + why(r)); }

  process.stdout.write('\n[N] nothing foreign entered the books, and existing records are untouched\n');
  { const SECRETS = ['SECRET-B1', 'SECRET-B2', 'SECRET-L', 'SECRET-M', 'SECRET-C', '254711000009', '254711000008', '254711000005', '777', '888'];
    const docs = [...(await db.collection('posSales').get()).docs, ...(await db.collection('receipts').get()).docs];
    const leaked = [];
    for (const d of docs) {
      const body = JSON.stringify(d.data());
      for (const s of SECRETS) if (body.indexOf('"' + s) !== -1 || body.indexOf(s + '"') !== -1 || body.indexOf(':' + s + ',') !== -1 || body.indexOf(':' + s + '}') !== -1) leaked.push(d.ref.path + '←' + s);
    }
    ok(docs.length > 0 && leaked.length === 0, 'N-1', 'no foreign name / phone / points total appears in any of ' + docs.length + ' written sale or receipt documents: ' + (leaked.slice(0, 4).join(', ') || 'none'));
    const foreignPts = [(await db.doc('posCustomers/B1R').get()).data().loyaltyPoints, (await db.doc(`posCustomers/${B}_254711000008`).get()).data().loyaltyPoints,
      (await db.doc('posCustomers/LEGR').get()).data().loyaltyPoints, (await db.doc(`posCustomers/${A}_254711000007`).get()).data().loyaltyPoints];
    ok(foreignPts.join(',') === '777,888,555,999', 'N-2', 'every foreign / unowned / conflicting customer kept its points (no loyalty award): ' + foreignPts.join(','));
    const retailAfter = [];
    for (let i = 1; i <= 5; i++) retailAfter.push(await fingerprint(`posRetailSales/ps_prod_${i}`));
    ok(retailAfter.every((f, i) => f === retailBefore[i]), 'N-3', 'the 5 existing posRetailSales records are byte-unchanged'); }

  process.stdout.write(`\n${pass} pass / ${fail} fail\n`);
  clearTimeout(WATCHDOG);
  process.exit(fail ? 1 : 0);
})().catch((e) => { process.stdout.write('  ✖ CRASH — ' + (e && e.stack || e) + '\n'); process.exit(4); });
