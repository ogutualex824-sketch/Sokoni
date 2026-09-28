'use strict';
/**
 * CERTIFICATION — Q0a: loyalty redemption and the customer it touches (posCompleteCheckout).
 *
 * Runs the REAL posCompleteCheckout (`.run`) against the Firestore EMULATOR. Pointed at the pre-Q0a tree
 * (REPAIR_ROOT = export of 96d31e4) it must mint, coerce, burn and cross tenants; on this tree every one of
 * those must be a DELIBERATE refusal — the stated code AND reason, never a crash that happens to stop the
 * sale — with no stock, sale or points moved. Controls (zero / omitted redemption, owned customers, no
 * customer, an unknown customer id) must sell on both trees.
 *
 *   L   loyaltyRedeemPoints: whole and non-negative, else invalid-argument; any non-zero redemption is
 *       failed-precondition (no server-side price for a point exists on this path)
 *   O   the named customer, if it exists, must be the PROVEN merchant's (pos-customer-scope rule), checked
 *       before payment and again inside the transaction; the customer id must be one document id
 *
 *   REPAIR_ROOT  tree under test (default: this repo). Refuses without FIRESTORE_EMULATOR_HOST.
 */
const path = require('path');

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-q0a-loyalty';
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

/* O-f: the pre-transaction read (ref.get) sees an owned customer; the owner then changes before the
   transaction reads it. Transaction reads do not pass through DocumentReference.get. */
const proto = Object.getPrototypeOf(db.doc('x/y'));
const _get = proto.get, _update = proto.update;
const INJ = { switchCustomer: null, fired: 0 };
proto.get = async function (...a) {
  const snap = await _get.apply(this, a);
  if (INJ.switchCustomer && this.path === 'posCustomers/' + INJ.switchCustomer.id) {
    const to = INJ.switchCustomer.to; INJ.switchCustomer = null; INJ.fired++;
    await _update.call(this, { sellerId: to });
  }
  return snap;
};

let PZF;
try { PZF = require(path.join(FN, 'pos-zero-friction.js')); }
catch (e) { process.stdout.write('  ✖ SETUP — could not load pos-zero-friction.js: ' + e.message + '\n'); process.exit(2); }

const OWNER = 'q0a-owner', OTHER = 'q0a-other-shop', BIZ = 'Q0A-BIZ', BIZ_OWNER = 'q0a-bizowner', STAFF = 'q0a-staff';
const COMP_OWN = OWNER + '_254700000001', COMP_FOREIGN = OTHER + '_254700000002', COMP_CONFLICT = OWNER + '_254700000003';
const REQ = (uid, data) => ({ data, auth: { uid, token: { uid } }, rawRequest: { headers: {}, ip: '127.0.0.1' }, acceptsStreaming: false });
const PRICE = { P_OWN: 100, P_WS: 200 };
const get = async (c, id) => { const s = await db.collection(c).doc(String(id)).get(); return s.exists ? s.data() : null; };
const stockOf = async (id) => Number(((await get('products', id)) || {}).stock);
const ptsOf = async (id) => ((await get('posCustomers', id)) || {}).loyaltyPoints;
const salesForKey = async (k) => (await db.collection('posRetailSales').where('idempotencyKey', '==', k).get()).size;

let seq = 0;
/* `redeem` is passed through VERBATIM, including undefined (omitted). The charged total never includes a
   loyalty discount, exactly as pos-checkout.html sends it: discountTotal excludes it. */
async function sell({ uid = OWNER, merchantId = OWNER, product = 'P_OWN', customer, redeem, omitRedeem } = {}) {
  const key = 'q0a-key-' + (++seq);
  const total = PRICE[product];
  const data = { idempotencyKey: key, merchantId, items: [{ productId: product, qty: 1, unitPrice: total, name: product }],
    customer: customer === undefined ? null : customer,
    payments: [{ method: 'cash', amount: total }], subtotal: total, discountTotal: 0, taxTotal: 0, grandTotal: total };
  if (!omitRedeem) data.loyaltyRedeemPoints = redeem;
  try {
    const r = await quiet(() => PZF.posCompleteCheckout.run(REQ(uid, data)));
    return { ok: true, key, r };
  } catch (e) { return { ok: false, key, code: e.code, msg: e.message }; }
}
const why = (r) => (r.ok ? 'SOLD' : 'refused [' + r.code + ']: ' + String(r.msg || '').slice(0, 70));
/* A refusal must be the DELIBERATE one: the stated code and reason. A crash is not a refusal. */
const refusedFor = (r, code, re) => !r.ok && r.code === code && re.test(String(r.msg || ''));
/* ...and it must leave nothing behind: no sale for the key, no stock moved, no points moved. */
async function untouched(r, product, stockBefore, custId, ptsBefore) {
  return (await salesForKey(r.key)) === 0 && (await stockOf(product)) === stockBefore &&
    (custId === null || (await ptsOf(custId)) === ptsBefore);
}
const cust = (id) => ({ id, name: 'Customer ' + id, phone: '0700000000' });

(async () => {
  process.stdout.write(`\nQ0a — loyalty redemption and customer ownership   (tree: ${ROOT})\n\n`);
  const set = (p, d) => db.doc(p).set(d);
  await set(`shops/${OWNER}`, { name: 'Owner Shop', ownerId: OWNER });
  await set(`users/${OWNER}`, { name: 'Olive Owner', displayName: 'Olive Owner' });
  await set(`businesses/${BIZ}`, { ownerId: BIZ_OWNER, name: 'Membership Biz' });
  await set(`workspaceMemberships/${STAFF}_${BIZ}`, { uid: STAFF, businessId: BIZ, status: 'active', permissions: ['sales'] });
  await set('products/P_OWN', { name: 'P_OWN', price: 100, stock: 200, trackInventory: true, sellerUid: OWNER, shopId: OWNER });
  await set('products/P_WS', { name: 'P_WS', price: 200, stock: 200, trackInventory: true, sellerUid: BIZ_OWNER });
  const C = (id, extra) => set(`posCustomers/${id}`, Object.assign({ name: id, phone: '0700000000', loyaltyPoints: 100 }, extra || {}));
  await C('C_OWN', { sellerId: OWNER }); await C('C_ZERO', { sellerId: OWNER }); await C(COMP_OWN);
  await C('C_WS', { sellerId: BIZ_OWNER });
  await C('C_FOREIGN', { sellerId: OTHER }); await C(COMP_FOREIGN); await C('C_NOOWNER');
  await C('C_BAD', { sellerId: 12345 }); await C(COMP_CONFLICT, { sellerId: OTHER }); await C('C_SWITCH', { sellerId: OWNER });
  /* one balance per malformed-figure case, so each old-tree effect is measured on its own */
  const L = ['L_NEG', 'L_NAN', 'L_NULL', 'L_STR', 'L_STRNEG', 'L_INF', 'L_BOOL', 'L_FRAC', 'L_ARR', 'L_POS', 'L_ALL'];
  for (const id of L) await C(id, { sellerId: OWNER });

  process.stdout.write('[CONTROL] zero / omitted redemption and owned customers still sell\n');
  {
    const s0 = await stockOf('P_OWN');
    const r = await sell({ customer: cust('C_ZERO'), redeem: 0 });
    ok(r.ok && (await ptsOf('C_ZERO')) === 101 && (await stockOf('P_OWN')) === s0 - 1, 'C-1',
      'explicit zero redemption, owned customer (sellerId): earns 1 point on KES 100, 100 → ' + (await ptsOf('C_ZERO')) + ': ' + why(r));
  }
  {
    const r = await sell({ customer: cust('C_OWN'), omitRedeem: true });
    ok(r.ok && (await ptsOf('C_OWN')) === 101, 'C-2', 'redemption OMITTED (every caller but pos-checkout.html): ' + why(r));
  }
  {
    const r = await sell({ customer: cust(COMP_OWN), redeem: 0 });
    ok(r.ok && (await ptsOf(COMP_OWN)) === 101, 'C-3', "owned customer by composite id {sellerId}_{phone}: " + why(r));
  }
  {
    const r = await sell({ uid: STAFF, merchantId: BIZ, product: 'P_WS', customer: cust('C_WS'), redeem: 0 });
    ok(r.ok && (await ptsOf('C_WS')) === 102, 'C-4', "business member, the business owner's customer (earns 2 on KES 200): " + why(r));
  }
  {
    const r = await sell({ redeem: 0 });
    ok(r.ok, 'C-5', 'no customer: ' + why(r));
  }
  {
    const r = await sell({ customer: cust('C_DOES_NOT_EXIST'), redeem: 0 });
    ok(r.ok && (await get('posCustomers', 'C_DOES_NOT_EXIST')) === null, 'C-6',
      'an unknown customer id touches nothing and does not stop the sale (unchanged behaviour): ' + why(r));
  }

  process.stdout.write('\n[L] the redemption figure cannot mint, coerce, corrupt or burn\n');
  const bad = /whole, non-negative/;
  const cases = [
    ['L-a', 'L_NEG', -500, 'a NEGATIVE figure (mints points)'],
    ['L-b', 'L_NAN', NaN, 'NaN (corrupts the balance)'],
    ['L-c', 'L_NULL', null, 'null (what NaN becomes over JSON)'],
    ['L-d', 'L_STR', '5', 'the string "5" (coerced)'],
    ['L-e', 'L_STRNEG', '-500', 'the string "-500" (coerced into a mint)'],
    ['L-f', 'L_INF', Infinity, 'Infinity (wipes the balance)'],
    ['L-g', 'L_BOOL', true, 'boolean true (coerced to 1)'],
    ['L-h', 'L_FRAC', 0.5, 'a fraction 0.5 (writes a fractional balance)'],
    ['L-i', 'L_ARR', [-500], 'an array [-500] (coerced into a mint)'],
  ];
  for (const [id, cid, v, label] of cases) {
    const s0 = await stockOf('P_OWN');
    const r = await sell({ customer: cust(cid), redeem: v });
    const pts = await ptsOf(cid);
    ok(refusedFor(r, 'invalid-argument', bad) && await untouched(r, 'P_OWN', s0, cid, 100), id,
      label + ' — balance after: ' + String(pts) + ': ' + why(r));
  }
  const noRedeem = /cannot be redeemed at the till/;
  {
    const s0 = await stockOf('P_OWN');
    const r = await sell({ customer: cust('L_POS'), redeem: 50 });
    ok(refusedFor(r, 'failed-precondition', noRedeem) && await untouched(r, 'P_OWN', s0, 'L_POS', 100), 'L-j',
      'a positive redemption with the total unchanged (burns 50 points for nothing) — balance after: ' + (await ptsOf('L_POS')) + ': ' + why(r));
  }
  {
    const s0 = await stockOf('P_OWN');
    const r = await sell({ customer: cust('L_ALL'), redeem: 1000000 });
    ok(refusedFor(r, 'failed-precondition', noRedeem) && await untouched(r, 'P_OWN', s0, 'L_ALL', 100), 'L-k',
      'a redemption larger than the balance (wipes it) — balance after: ' + (await ptsOf('L_ALL')) + ': ' + why(r));
  }

  process.stdout.write("\n[O] only the proven merchant's customer is touched\n");
  const ownCases = [
    ['O-a', 'C_FOREIGN', /belongs to another shop/, "another shop's customer (sellerId)"],
    ['O-b', COMP_FOREIGN, /not on record as a customer of this shop/, "another shop's customer (composite id)"],
    ['O-c', 'C_NOOWNER', /not on record as a customer of this shop/, 'a customer with NO owner on record (fail closed)'],
    ['O-d', 'C_BAD', /unreadable owner/, 'a MALFORMED sellerId (a number)'],
    ['O-e', COMP_CONFLICT, /belongs to another shop/, "our id prefix but ANOTHER shop's sellerId (not accepted on the id alone)"],
  ];
  for (const [id, cid, re, label] of ownCases) {
    const s0 = await stockOf('P_OWN');
    const r = await sell({ customer: cust(cid), redeem: 0 });
    ok(refusedFor(r, 'permission-denied', re) && await untouched(r, 'P_OWN', s0, cid, 100), id,
      label + ' — its balance after: ' + String(await ptsOf(cid)) + ': ' + why(r));
  }
  {
    const s0 = await stockOf('P_OWN');
    INJ.switchCustomer = { id: 'C_SWITCH', to: OTHER }; INJ.fired = 0;
    const r = await sell({ customer: cust('C_SWITCH'), redeem: 0 });
    const fired = INJ.fired; INJ.switchCustomer = null;
    ok(fired === 1 && refusedFor(r, 'permission-denied', /belongs to another shop/) && await untouched(r, 'P_OWN', s0, 'C_SWITCH', 100), 'O-f',
      'owner changes between the pre-transaction read and the transaction → refused INSIDE it (injection fired ' + fired + 'x): ' + why(r));
  }
  {
    const s0 = await stockOf('P_WS');
    const r = await sell({ uid: STAFF, merchantId: BIZ, product: 'P_WS', customer: cust('C_OWN'), redeem: 0 });
    const before = 101; /* C-2 */
    ok(refusedFor(r, 'permission-denied', /belongs to another shop/) && await untouched(r, 'P_WS', s0, 'C_OWN', before), 'O-g',
      "business member, ANOTHER merchant's customer (the proof decides, not the request): " + why(r));
  }
  {
    const s0 = await stockOf('P_OWN');
    const r = await sell({ customer: cust('C_FOREIGN/nested/x'), redeem: 0 });
    ok(refusedFor(r, 'invalid-argument', /single customer record id/) && await untouched(r, 'P_OWN', s0, null), 'O-h',
      'a customer id that is a PATH (reaches a document outside posCustomers/{id}): ' + why(r));
  }
  {
    const s0 = await stockOf('P_OWN');
    const r = await sell({ customer: { id: 12345, name: 'x' }, redeem: 0 });
    ok(refusedFor(r, 'invalid-argument', /single customer record id/) && await untouched(r, 'P_OWN', s0, null), 'O-i',
      'a customer id that is not a string: ' + why(r));
  }

  process.stdout.write(`\n${pass} pass / ${fail} fail\n`);
  clearTimeout(WATCHDOG);
  process.exit(fail ? 1 : 0);
})().catch((e) => { process.stdout.write('  ✖ CRASH — ' + (e && e.stack || e) + '\n'); process.exit(4); });
