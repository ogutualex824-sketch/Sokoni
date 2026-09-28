'use strict';
/**
 * CERTIFICATION — L-9A: posCompleteCheckout's membership-path owner set cannot be changed between the
 * permission proof and the stock transaction.
 *
 * _assertBusinessPermission reads businesses/{biz} and admits `ownerId === caller` as the owner; 0b's
 * _merchantOwnerSet then read the SAME document again and added its `ownerId` to the accepted product owners.
 * A change of `ownerId` between the two reads let a caller be admitted as owner and then sell the NEW owner's
 * products. The repair re-derives admission AND the owner set from ONE transactional read of the business (and
 * of the caller's membership) inside the stock transaction.
 *
 * The change of state is INJECTED with the Admin SDK at the exact point named in each case (the read performed by
 * the named function returns, then the document changes) — it models "some writer can change it"; whether a CLIENT
 * can is a rules question (live ruleset 6c67a34d: no; this lineage's repository rules: yes).
 *
 *   CTL-1  owner-admitted: the business owner sells their own product at their business            → sold
 *   CTL-2  membership-admitted: a `sales` member sells the business owner's product (0b R4-W1 shape) → sold
 *   CTL-3  owner-admitted caller, the VICTIM's product, nothing changes                               → refused
 *   T-1    ownerId flipped owner→victim right after the permission proof; the VICTIM's product       → refused,
 *          victim stock unchanged, no sale                           (pre-repair tree: SOLD, victim stock moved)
 *   T-2    ownerId flipped owner→victim after the pre-transaction owner set; the caller's OWN product → refused:
 *          admission is re-evaluated on the transaction's read       (pre-repair tree: SOLD)
 *   T-3    the member's membership is deactivated after the permission proof                         → refused
 *                                                                    (pre-repair tree: SOLD)
 *   T-4    the member's `sales` capability is removed after the permission proof                     → refused
 *                                                                    (pre-repair tree: SOLD)
 *
 *   REPAIR_ROOT  tree under test (default: this repo). Refuses without FIRESTORE_EMULATOR_HOST.
 */
const path = require('path');
if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-l9a-toctou';
const WATCHDOG = setTimeout(() => { process.stdout.write('\n  ✖ WATCHDOG — suite exceeded 200s\n'); process.exit(3); }, 200000);

const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

let pass = 0, fail = 0;
const ok = (c, id, m) => { if (c) pass++; else fail++; process.stdout.write('  ' + (c ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + '\n'); };
const _REAL = { so: process.stdout.write.bind(process.stdout), se: process.stderr.write.bind(process.stderr), cw: console.warn, ce: console.error, cl: console.log };
async function quiet(fn) {
  process.stdout.write = () => true; process.stderr.write = () => true; console.warn = () => {}; console.error = () => {}; console.log = () => {};
  try { return await fn(); } finally { process.stdout.write = _REAL.so; process.stderr.write = _REAL.se; console.warn = _REAL.cw; console.error = _REAL.ce; console.log = _REAL.cl; }
}

/* ── injection: after the plain read of `path` made from inside the function named `inFn` returns, apply `patch` ── */
const INJ = { path: null, inFn: null, patch: null, fired: 0 };
const proto = Object.getPrototypeOf(db.doc('x/y'));
const _get = proto.get, _update = proto.update;
proto.get = async function (...a) {
  const snap = await _get.apply(this, a);
  if (INJ.path && this.path === INJ.path && new RegExp(INJ.inFn).test(new Error().stack || '')) {
    const patch = INJ.patch; INJ.path = null; INJ.fired++;
    await _update.call(this, patch);
  }
  return snap;
};
const arm = (p, inFn, patch) => Object.assign(INJ, { path: p, inFn, patch, fired: 0 });

let PZF;
try { PZF = require(path.join(FN, 'pos-zero-friction.js')); }
catch (e) { process.stdout.write('  ✖ SETUP — ' + e.message + '\n'); process.exit(2); }
const REQ = (uid, data) => ({ data, auth: { uid, token: { uid } }, rawRequest: { headers: {}, ip: '127.0.0.1' }, acceptsStreaming: false });
let seq = 0;
async function sell(uid, merchantId, productId, price) {
  const items = [{ productId, qty: 1, unitPrice: price, name: productId }];
  try {
    const r = await quiet(() => PZF.posCompleteCheckout.run(REQ(uid, { idempotencyKey: 'l9a-' + (++seq) + '-' + Date.now(),
      merchantId, items, payments: [{ method: 'cash', amount: price }], subtotal: price, discountTotal: 0, taxTotal: 0, grandTotal: price })));
    return { ok: true, saleId: r && r.saleId };
  } catch (e) { return { ok: false, code: e.code, msg: String(e.message || '').slice(0, 80) }; }
}
const stock = async (id) => Number((await db.doc('products/' + id).get()).data().stock);
const salesAt = async (m) => (await db.collection('posRetailSales').where('merchantId', '==', m).get()).size;
const why = (r) => (r.ok ? 'SOLD' : 'refused [' + r.code + ']: ' + r.msg);

(async () => {
  process.stdout.write(`\nL-9A — the membership-path owner set is bound to one transactional read   (tree: ${ROOT})\n\n`);
  await db.doc('users/l9a-atk').set({ name: 'Owner A' });
  await db.doc('users/l9a-mem').set({ name: 'Member M' });
  await db.doc('shops/l9a-vic').set({ ownerId: 'l9a-vic', name: 'Victim Shop' });
  await db.doc('businesses/L9A-BX').set({ ownerId: 'l9a-atk', name: 'Business X', status: 'active' });
  await db.doc('businesses/L9A-BM').set({ ownerId: 'l9a-bmo', name: 'Business M', status: 'active' });
  await db.doc('workspaceMemberships/l9a-mem_L9A-BM').set({ uid: 'l9a-mem', businessId: 'L9A-BM', status: 'active', permissions: ['pos', 'sales'] });
  const P = (id, owner) => db.doc('products/' + id).set({ name: id, price: 100, stock: 10, trackInventory: true, sellerUid: owner });
  await P('L9A_OWN', 'l9a-atk'); await P('L9A_VIC', 'l9a-vic'); await P('L9A_BMO', 'l9a-bmo'); await P('L9A_BMO2', 'l9a-bmo');

  { const r = await sell('l9a-atk', 'L9A-BX', 'L9A_OWN', 100);
    ok(r.ok && (await stock('L9A_OWN')) === 9, 'CTL-1', 'owner-admitted: the owner sells their own product at their business: ' + why(r)); }
  { const r = await sell('l9a-mem', 'L9A-BM', 'L9A_BMO', 100);
    ok(r.ok && (await stock('L9A_BMO')) === 9, 'CTL-2', "membership-admitted: a `sales` member sells the business owner's product: " + why(r)); }
  { const r = await sell('l9a-atk', 'L9A-BX', 'L9A_VIC', 100);
    ok(!r.ok && r.code === 'permission-denied' && (await stock('L9A_VIC')) === 10, 'CTL-3', "the victim's product, ownerId unchanged: " + why(r)); }

  { const s0 = await salesAt('L9A-BX');
    arm('businesses/L9A-BX', 'workforce-identity', { ownerId: 'l9a-vic' });
    const r = await sell('l9a-atk', 'L9A-BX', 'L9A_VIC', 100);
    const fired = INJ.fired; await db.doc('businesses/L9A-BX').update({ ownerId: 'l9a-atk' });
    ok(fired === 1 && !r.ok && r.code === 'permission-denied' && (await stock('L9A_VIC')) === 10 && (await salesAt('L9A-BX')) === s0, 'T-1',
      `ownerId flipped to the victim right after the permission proof (fired ${fired}x): the victim's product ${why(r)}; victim stock ${await stock('L9A_VIC')}, sales +${(await salesAt('L9A-BX')) - s0}`); }

  { const s0 = await salesAt('L9A-BX'), st0 = await stock('L9A_OWN');
    arm('businesses/L9A-BX', '_merchantOwnerSet', { ownerId: 'l9a-vic' });
    const r = await sell('l9a-atk', 'L9A-BX', 'L9A_OWN', 100);
    const fired = INJ.fired; await db.doc('businesses/L9A-BX').update({ ownerId: 'l9a-atk' });
    ok(fired === 1 && !r.ok && r.code === 'permission-denied' && (await stock('L9A_OWN')) === st0 && (await salesAt('L9A-BX')) === s0, 'T-2',
      `ownerId flipped away after the pre-transaction owner set (fired ${fired}x): admission re-evaluated in the transaction — ${why(r)}`); }

  { const s0 = await salesAt('L9A-BM'), st0 = await stock('L9A_BMO2');
    /* the membership (not the business) changes: after _assertBusinessPermission's membership query returns */
    const memRef = db.doc('workspaceMemberships/l9a-mem_L9A-BM');
    const qProto = Object.getPrototypeOf(Object.getPrototypeOf(db.collection('x')));
    const _qGet = qProto.get; let fired = 0;
    qProto.get = async function (...a) {
      const r = await _qGet.apply(this, a);
      if (!fired && /workforce-identity/.test(new Error().stack || '') && r.docs.some((d) => d.ref.path === memRef.path)) { fired++; await _update.call(memRef, { status: 'removed' }); }
      return r;
    };
    const r = await sell('l9a-mem', 'L9A-BM', 'L9A_BMO2', 100);
    qProto.get = _qGet; await memRef.update({ status: 'active' });
    ok(fired === 1 && !r.ok && r.code === 'permission-denied' && (await stock('L9A_BMO2')) === st0 && (await salesAt('L9A-BM')) === s0, 'T-3',
      `the membership is deactivated after the permission proof (fired ${fired}x): ${why(r)}`); }

  { const s0 = await salesAt('L9A-BM'), st0 = await stock('L9A_BMO2');
    const memRef = db.doc('workspaceMemberships/l9a-mem_L9A-BM');
    const qProto = Object.getPrototypeOf(Object.getPrototypeOf(db.collection('x')));
    const _qGet = qProto.get; let fired = 0;
    qProto.get = async function (...a) {
      const r = await _qGet.apply(this, a);
      if (!fired && /workforce-identity/.test(new Error().stack || '') && r.docs.some((d) => d.ref.path === memRef.path)) { fired++; await _update.call(memRef, { permissions: ['pos'] }); }
      return r;
    };
    const r = await sell('l9a-mem', 'L9A-BM', 'L9A_BMO2', 100);
    qProto.get = _qGet; await memRef.update({ permissions: ['pos', 'sales'] });
    ok(fired === 1 && !r.ok && r.code === 'permission-denied' && (await stock('L9A_BMO2')) === st0 && (await salesAt('L9A-BM')) === s0, 'T-4',
      `the member's \`sales\` capability is removed after the permission proof (fired ${fired}x): ${why(r)}`); }

  clearTimeout(WATCHDOG);
  process.stdout.write(`\n  ${pass} pass / ${fail} fail\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { process.stdout.write('  ✖ CRASH — ' + (e && e.stack || e) + '\n'); process.exit(4); });
