'use strict';
/**
 * CERTIFICATION — Q0b-1: customer scope for posLookupCustomer, getPOSCustomer and upsertPOSCustomer.
 *
 * Runs the REAL handlers against the Firestore EMULATOR — the SERVER authority, not a browser's
 * displayed merchant. Pointed at the pre-Q0b tree (REPAIR_ROOT = export of dd9dc2a) the cross-tenant
 * reads, the foreign overwrite and the forged seller must all SUCCEED; on this tree each must be
 * refused or answered `{found:false}`, while every legitimate path still works.
 *
 *   L  posLookupCustomer (till): the request's merchantId is a CLAIM proven by resolveActor or by a
 *      business membership holding `customers`; only that merchant's customers are ever returned
 *   G  getPOSCustomer (owner CRM): owner = the caller, or the seller an ADMIN names (_boundSellerId)
 *   U  upsertPOSCustomer: owner-scoped, transactional; a new customer is create()d at {owner}_{254…}
 *   F  the real till flow: upsert → till lookup → posCompleteCheckout → points on that customer
 *
 * A refusal must carry the stated code (and reason where one is stated); a crash is not a refusal. Every
 * attempted foreign write is checked BYTE-UNCHANGED: the victim document's data AND its updateTime.
 *
 *   REPAIR_ROOT  tree under test (default: this repo). Refuses without FIRESTORE_EMULATOR_HOST.
 */
const path = require('path');

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-q0b-scope';
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

/* READ SPY (X-13): records every posCustomers document a Query or DocumentReference read returns. */
const SPY = { on: false, seen: [] };
{
  const qProto = Object.getPrototypeOf(Object.getPrototypeOf(db.collection('x')));   /* Query.prototype */
  const dProto = Object.getPrototypeOf(db.doc('x/y'));
  const _qGet = qProto.get, _dGet = dProto.get;
  qProto.get = async function (...a) { const r = await _qGet.apply(this, a); if (SPY.on) for (const d of r.docs) if (d.ref.path.startsWith('posCustomers/')) SPY.seen.push({ id: d.id, sellerId: d.data().sellerId }); return r; };
  dProto.get = async function (...a) { const r = await _dGet.apply(this, a); if (SPY.on && r.exists && this.path.startsWith('posCustomers/')) SPY.seen.push({ id: r.id, sellerId: r.data().sellerId }); return r; };
}

/* U-13 injection: the next Transaction.create on the named path throws ALREADY_EXISTS once. */
const INJ = { existsOnce: null, fired: 0 };
{
  const tProto = require(require.resolve('@google-cloud/firestore', { paths: [FN] })).Transaction.prototype;
  const _create = tProto.create;
  tProto.create = function (ref, ...a) {
    if (INJ.existsOnce && ref.path === INJ.existsOnce) { INJ.existsOnce = null; INJ.fired++; throw Object.assign(new Error('6 ALREADY_EXISTS: injected'), { code: 6 }); }
    return _create.call(this, ref, ...a);
  };
}

let PZF, PRE;
try { PZF = require(path.join(FN, 'pos-zero-friction.js')); PRE = require(path.join(FN, 'pos-retail-engine.js')); }
catch (e) { process.stdout.write('  ✖ SETUP — ' + e.message + '\n'); process.exit(2); }

const A = 'qb-a', B = 'qb-b', A_EMP = 'qb-a-cashier', BIZ = 'QB-BIZ', BIZ_OWNER = 'qb-bizowner';
const SELLER = { role: 'seller' }, ADMIN = { admin: true };
const tok = (uid, extra) => Object.assign({ uid }, extra || {});
const res = (p) => p.then((out) => ({ ok: true, out }), (e) => ({ ok: false, code: e.code, msg: String(e.message || '') }));
const lookup = (uid, merchantId, query, method) => res(quiet(() =>
  PZF.posLookupCustomer.run({ data: { query, merchantId, method }, auth: { uid, token: tok(uid) }, rawRequest: { headers: {} }, acceptsStreaming: false })));
const getC = (uid, token, data) => res(quiet(() => PRE._h.getPOSCustomer({ data, auth: { uid, token: tok(uid, token) } })));
const upsert = (uid, token, data) => res(quiet(() => PRE._h.upsertPOSCustomer({ data, auth: { uid, token: tok(uid, token) } })));
const found = (r, id) => r.ok && r.out && r.out.found === true && (id === undefined || (r.out.id || (r.out.customer && r.out.customer.customerId)) === id);
const notFound = (r) => r.ok && r.out && r.out.found === false;
const refusedFor = (r, code, re) => !r.ok && r.code === code && (!re || re.test(r.msg));
const why = (r) => (r.ok ? JSON.stringify(r.out).slice(0, 70) : 'refused [' + r.code + ']: ' + r.msg.slice(0, 60));
/* the exact bytes of a document, including when it was last written */
async function fingerprint(p) {
  const s = await db.doc(p).get();
  return s.exists ? JSON.stringify(s.data()) + '@' + s.updateTime.toMillis() : 'ABSENT';
}
const ownedByPhone = async (owner, phone254) => (await db.collection('posCustomers').where('phone', '==', phone254).get()).docs
  .filter((d) => (d.data().sellerId === owner) || d.id.indexOf(owner + '_') === 0);

(async () => {
  process.stdout.write(`\nQ0b-1 — customer scope   (tree: ${ROOT})\n\n`);
  const set = (p, d) => db.doc(p).set(d);
  for (const [uid, name] of [[A, 'Alice A'], [B, 'Bob B'], [A_EMP, 'Carl Cashier'], [BIZ_OWNER, 'Biz Owner']]) await set(`users/${uid}`, { name });
  await set(`shops/${A}`, { ownerId: A, storeName: 'A Shop' });
  await set(`shops/${B}`, { ownerId: B, storeName: 'B Shop' });
  await set(`shopEmployees/${A}_${A_EMP}`, { uid: A_EMP, name: 'Carl Cashier', role: 'cashier', shopId: A, shopOwnerId: A, shopName: 'A Shop', active: true });
  await set(`businesses/${BIZ}`, { ownerId: BIZ_OWNER, name: 'QB Biz' });
  await set(`workspaceMemberships/qb-mem-cust_${BIZ}`, { uid: 'qb-mem-cust', businessId: BIZ, status: 'active', permissions: ['pos', 'customers'] });
  await set(`workspaceMemberships/qb-mem-pos_${BIZ}`, { uid: 'qb-mem-pos', businessId: BIZ, status: 'active', permissions: ['pos', 'view_products'] });
  /* seeded customers — A's and B's share nothing, so an unscoped query finds the WRONG one, not nothing */
  await set('posCustomers/A1R', { sellerId: A, phone: '+254711000001', email: 'a1@x.test', memberCardCode: 'MA1', name: 'A One', loyaltyPoints: 10 });
  await set(`posCustomers/${A}_254711000002`, { phone: '254711000002', name: 'A Composite' });                 /* composite-only */
  await set('posCustomers/B1R', { sellerId: B, phone: '+254711000009', email: 'b1@x.test', memberCardCode: 'MB1', name: 'B One', loyaltyPoints: 50 });
  await set(`posCustomers/${B}_254711000008`, { phone: '254711000008', name: 'B Composite' });
  await set(`posCustomers/${A}_254711000007`, { sellerId: B, phone: '254711000007', name: 'Conflict' });     /* our prefix, B's body */
  await set('posCustomers/LEGR', { phone: '+254711000005', name: 'Legacy, no owner' });
  await set(`posCustomers/${A}_254711000006`, { sellerId: 12345, phone: '254711000006', name: 'Malformed owner' });
  await set('posCustomers/BZR', { sellerId: BIZ_OWNER, phone: '+254711000004', name: 'Biz Customer' });
  await set('products/QB_P', { name: 'QB_P', price: 100, stock: 50, trackInventory: true, sellerUid: A, shopId: A });

  process.stdout.write('[L] till lookup — authorized\n');
  ok(found(await lookup(A, A, '0711000001'), 'A1R'), 'L-1', 'owner, own customer by phone');
  { const r = [await lookup(A, A, 'A1R', 'id'), await lookup(A, A, 'a1@x.test', 'email'), await lookup(A, A, 'ma1', 'memberCard')];
    ok(r.every((x) => found(x, 'A1R')), 'L-2', 'owner, own customer by id / email / member card: ' + r.map(why).join(' | ')); }
  ok(found(await lookup(A, A, '0711000002'), `${A}_254711000002`), 'L-3', 'owner, own COMPOSITE-ID customer by phone');
  { const r = await lookup(A_EMP, A, '0711000001'); ok(found(r, 'A1R'), 'L-4', "the shop's cashier (resolveActor) finds the shop's customer: " + why(r)); }
  { const r = await lookup('qb-mem-cust', BIZ, '0711000004'); ok(found(r, 'BZR'), 'L-5', "business member WITH `customers` finds the business's customer: " + why(r)); }

  process.stdout.write('\n[L] till lookup — nothing of another merchant is ever returned\n');
  for (const [id, q, m, label] of [
    ['X-1', '0711000009', 'phone', "B's customer by phone"], ['X-2', 'B1R', 'id', "B's customer by id"],
    ['X-3', 'b1@x.test', 'email', "B's customer by email"], ['X-4', 'MB1', 'memberCard', "B's customer by member card"],
    ['X-5', `${B}_254711000008`, 'id', "B's COMPOSITE id"], ['X-6', '0711000007', 'auto', "a record with OUR prefix but B's sellerId"],
    ['X-7', '0711000005', 'auto', 'a legacy record with NO owner'],
  ]) { const r = await lookup(A, A, q, m); ok(notFound(r), id, label + ' → ' + why(r)); }
  { const P = `posCustomers/${A}_254711000006`, before = await fingerprint(P);
    const r1 = await lookup(A, A, '0711000006'), r2 = await lookup(A, A, `${A}_254711000006`, 'id');
    const r3 = await upsert(A, SELLER, { phone: '0711000006', name: 'Through malformed', email: 'm@x.test' });
    ok(notFound(r1) && notFound(r2) && refusedFor(r3, 'permission-denied', /not one of your customers/) && before === await fingerprint(P), 'X-14',
      'OUR prefix with a MALFORMED sellerId (a number): lookups miss, upsert refused, record byte-unchanged — never a crash: ' + [why(r1), why(r3)].join(' | ')); }
  { const r = await lookup(A, A, `${A}_254711000007`, 'id'); ok(notFound(r), 'X-6b', "by id: OUR prefix but B's sellerId → " + why(r)); }
  {
    SPY.on = true; SPY.seen = [];
    for (const [q, m] of [['0711000009', 'phone'], ['B1R', 'id'], ['b1@x.test', 'email'], ['MB1', 'memberCard'], [`${B}_254711000008`, 'id'], ['0711000005', 'auto']]) await lookup(A, A, q, m);
    SPY.on = false;
    const leaked = SPY.seen.filter((d) => d.sellerId === B || d.id.indexOf(B + '_') === 0 || d.id === 'LEGR');
    ok(leaked.length === 0, 'X-13', "A's lookups of B's phone / id / email / card / composite id and a legacy record never LOAD one of those documents (owner filter is in the query): " + (leaked.length ? 'loaded ' + leaked.map((d) => d.id).join(',') : 'none loaded'));
  }
  { const r = await lookup(A, B, '0711000009'); ok(refusedFor(r, 'permission-denied', /not authorised to look up/), 'X-8', "FORGED merchantId: A's owner claims B: " + why(r)); }
  { const r = await lookup('qb-stranger', A, '0711000001'); ok(refusedFor(r, 'permission-denied', /not authorised to look up/), 'X-9', 'a stranger claiming a real shop: ' + why(r)); }
  { const r = await lookup('qb-mem-pos', BIZ, '0711000004'); ok(refusedFor(r, 'permission-denied', /not authorised to look up/), 'X-10', 'business member WITHOUT `customers`: ' + why(r)); }
  { const r = await lookup(A_EMP, B, '0711000009'); ok(refusedFor(r, 'permission-denied', /not authorised to look up/), 'X-11', "A's cashier claiming B: " + why(r)); }
  { const r = await lookup('qb-admin', A, '0711000001'); ok(refusedFor(r, 'permission-denied', /not authorised to look up/), 'X-12', 'no NEW admin capability at the till (admin who is not the shop): ' + why(r)); }

  process.stdout.write('\n[U] upsert — create / update / idempotence\n');
  { const r = await upsert(A, SELLER, { phone: '0722000001', name: 'Ann', email: 'ann@x.test' });
    const d = (await db.doc(`posCustomers/${A}_254722000001`).get()).data() || {};
    ok(r.ok && r.out.customerId === `${A}_254722000001` && d.sellerId === A, 'U-1', 'new customer → create() at {owner}_{254…} with a matching sellerId: ' + why(r)); }
  { const r = await upsert(A, SELLER, { phone: '+254 722 000 001', name: 'Ann Two', email: 'ann@x.test' });
    const docs = await ownedByPhone(A, '254722000001');
    ok(r.ok && r.out.customerId === `${A}_254722000001` && docs.length === 1 && docs[0].data().name === 'Ann Two', 'U-2', 'the same phone again (another format) UPDATES the one record: ' + docs.length + ' record(s)'); }
  { const [r1, r2] = await Promise.all([upsert(A, SELLER, { phone: '0722000002', name: 'Race 1', email: 'r@x.test' }), upsert(A, SELLER, { phone: '0722000002', name: 'Race 2', email: 'r@x.test' })]);
    const docs = await ownedByPhone(A, '254722000002');
    ok(r1.ok && r2.ok && docs.length === 1 && r1.out.customerId === r2.out.customerId, 'U-3', 'two CONCURRENT first upserts of one phone → ONE record, both calls succeed: ' + docs.length + ' record(s); ' + why(r1) + ' | ' + why(r2)); }
  { const r = await upsert(A, SELLER, { phone: '0711000002', name: 'A Composite (renamed)', email: 'ac@x.test' });
    const d = (await db.doc(`posCustomers/${A}_254711000002`).get()).data() || {};
    ok(r.ok && r.out.customerId === `${A}_254711000002` && d.sellerId === A && d.name === 'A Composite (renamed)', 'U-4', 'an existing COMPOSITE-ONLY customer is found and updated in place (and gains its owner field): ' + why(r)); }
  { const r = await upsert('qb-admin', ADMIN, { phone: '0722000077', name: 'For B', email: 'fb@x.test', sellerId: B });
    const d = (await db.doc(`posCustomers/${B}_254722000077`).get()).data() || {};
    ok(r.ok && d.sellerId === B, 'U-5', 'an ADMIN names a seller (the existing _boundSellerId authority): ' + why(r)); }

  { const r = await upsert(A, SELLER, { phone: '0722000003', name: 'No Email' });
    const d = (await db.doc(`posCustomers/${A}_254722000003`).get()).data() || {};
    ok(r.ok && d.sellerId === A && d.name === 'No Email', 'U-12', 'a new customer WITHOUT an email is created (main rejected every one: set() carried FieldValue.delete()): ' + why(r)); }

  { INJ.existsOnce = `posCustomers/${A}_254722000004`; INJ.fired = 0;
    const r = await upsert(A, SELLER, { phone: '0722000004', name: 'Lost the race', email: 'race@x.test' });
    const fired = INJ.fired; INJ.existsOnce = null;
    const docs = await ownedByPhone(A, '254722000004');
    ok(fired === 1 && r.ok && r.out.customerId === `${A}_254722000004` && docs.length === 1, 'U-13',
      'a first create that loses the race (ALREADY_EXISTS, injected ' + fired + 'x) is retried → one record: ' + why(r)); }

  process.stdout.write('\n[U] upsert — never another merchant\'s record (byte-unchanged proofs)\n');
  await upsert(B, SELLER, { phone: '0722000009', name: 'B Two', email: 'b2@x.test' });
  const B2 = `posCustomers/${B}_254722000009`;
  { const before = await fingerprint(B2);
    const r = await upsert(A, SELLER, { phone: '0722000009', name: 'Hijack', email: 'hijack@x.test' });
    const after = await fingerprint(B2);
    ok(r.ok && r.out.customerId === `${A}_254722000009` && before === after && before !== 'ABSENT', 'U-6', "A upserts B's customer's PHONE → A gets its OWN record; B's document byte-unchanged: " + why(r)); }
  { const before = await fingerprint(B2);
    const r = await upsert(A, SELLER, { phone: '0722000055', name: 'Overwrite', email: 'ow@x.test', customerId: `${B}_254722000009` });
    const after = await fingerprint(B2);
    ok(refusedFor(r, 'permission-denied', /not one of your customers/) && before === after, 'U-7', "A names B's customerId → REFUSED, B's document byte-unchanged (was: set() replaced it): " + why(r)); }
  { const r1 = await upsert(A, SELLER, { phone: '0722000056', email: 'u8@x.test', customerId: 'B1R' });
    const r2 = await upsert(A, SELLER, { phone: '0722000056', email: 'u8@x.test', customerId: 'NO_SUCH_CUSTOMER' });
    ok(refusedFor(r1, 'permission-denied') && refusedFor(r2, 'permission-denied') && r1.msg === r2.msg && (await db.doc('posCustomers/NO_SUCH_CUSTOMER').get()).exists === false,
      'U-8', 'a foreign id and a missing id get the SAME refusal (no existence disclosure), and nothing is created: ' + why(r1)); }
  { const before = await fingerprint('posCustomers/B1R');
    const r = await upsert(A, SELLER, { phone: '0722000057', email: 'u9@x.test', customerId: 'B1R/nested/x' });
    ok(refusedFor(r, 'invalid-argument') && before === await fingerprint('posCustomers/B1R'), 'U-9', 'a customerId that is a PATH: ' + why(r)); }
  { const before = await fingerprint(B2);
    const r = await upsert(A, SELLER, { phone: '0722000009', name: 'Forged', email: 'fg@x.test', sellerId: B });
    ok(refusedFor(r, 'permission-denied', /own shop/) && before === await fingerprint(B2), 'U-10', "FORGED sellerId (A names B): refused, B byte-unchanged: " + why(r)); }
  { const P = `posCustomers/${A}_254711000007`, before = await fingerprint(P);
    const r = await upsert(A, SELLER, { phone: '0711000007', name: 'Through the prefix', email: 'tp@x.test' });
    ok(refusedFor(r, 'permission-denied', /not one of your customers/) && before === await fingerprint(P), 'U-11', "our deterministic id but B's sellerId → refused, never written through: " + why(r)); }

  process.stdout.write('\n[S] an owner that changes fails closed\n');
  const sMade = await upsert(A, SELLER, { phone: '0733000001', name: 'Soon B', email: 'sb@x.test' });
  const SID = (sMade.ok && sMade.out.customerId) || `${A}_254733000001`;
  const S = `posCustomers/${SID}`;
  { const g = await getC(A, SELLER, { customerId: SID });
    await db.doc(S).update({ sellerId: B });                                /* the owner changes after A read it */
    const before = await fingerprint(S);
    const r1 = await upsert(A, SELLER, { phone: '0733000001', name: 'A again', email: 'sb@x.test' });
    const r2 = await upsert(A, SELLER, { phone: '0733000001', customerId: SID, name: 'A by id', email: 'sb@x.test' });
    const r3 = await getC(A, SELLER, { customerId: SID });
    const r4 = await lookup(A, A, '0733000001');
    ok(found(g) && refusedFor(r1, 'permission-denied') && refusedFor(r2, 'permission-denied') && notFound(r3) && notFound(r4) && before === await fingerprint(S), 'S-1',
      'A read it, the owner became B → upsert by phone and by id REFUSED, both reads now {found:false}, record byte-unchanged: ' + [why(r1), why(r3)].join(' | ')); }

  process.stdout.write('\n[G] getPOSCustomer — the owner CRM read\n');
  { const r = [await getC(A, SELLER, { phone: '0722000001' }), await getC(A, SELLER, { customerId: `${A}_254722000001` })];
    ok(r.every((x) => found(x, `${A}_254722000001`)), 'G-1', 'owner, own customer by phone and by id: ' + r.map(why).join(' | ')); }
  { const r = [await getC(A, SELLER, { phone: '0722000009' }), await getC(A, SELLER, { customerId: `${B}_254722000009` }), await getC(A, SELLER, { customerId: 'B1R' })];
    const own = r[0].ok && r[0].out.found && r[0].out.customer.customerId === `${A}_254722000009`;
    ok(own && notFound(r[1]) && notFound(r[2]), 'G-2', "A never reads B's customers (B's phone resolves to A's OWN record from U-6; B's ids → not found): " + r.map(why).join(' | ')); }
  { const r = await getC(A, SELLER, { phone: '0722000009', sellerId: B }); ok(refusedFor(r, 'permission-denied', /own shop/), 'G-3', 'FORGED sellerId: ' + why(r)); }
  { const r = await getC('qb-admin', ADMIN, { phone: '0722000009', sellerId: B }); ok(found(r, `${B}_254722000009`), 'G-4', 'an ADMIN names B (existing _boundSellerId authority): ' + why(r)); }
  { const r = await getC(A_EMP, SELLER, { customerId: 'A1R' }); ok(notFound(r), 'G-5', "shop STAFF on the owner-bound CRM read see only their own (none) — fail closed per _boundSellerId: " + why(r)); }

  process.stdout.write('\n[F] the real till flow: create → till lookup → sale → points\n');
  { const u = await upsert(A, SELLER, { phone: '0744000001', name: 'Flow Customer', email: 'flow@x.test' });
    const l = await lookup(A_EMP, A, '0744000001');
    let sold = null;
    if (found(l)) {
      sold = await res(quiet(() => PZF.posCompleteCheckout.run({ data: { idempotencyKey: 'qb-flow-1', merchantId: A,
        items: [{ productId: 'QB_P', qty: 1, unitPrice: 100, name: 'QB_P' }], customer: { id: l.out.id, name: l.out.name, phone: l.out.phone },
        payments: [{ method: 'cash', amount: 100 }], subtotal: 100, discountTotal: 0, taxTotal: 0, grandTotal: 100, loyaltyRedeemPoints: 0 },
        auth: { uid: A_EMP, token: tok(A_EMP) }, rawRequest: { headers: {}, ip: '127.0.0.1' }, acceptsStreaming: false })));
    }
    const pts = ((await db.doc(`posCustomers/${A}_254744000001`).get()).data() || {}).loyaltyPoints;
    ok(u.ok && found(l, `${A}_254744000001`) && sold && sold.ok && pts === 1, 'F-1',
      "owner creates → the shop's cashier finds it at the till → sells to it → the customer earns 1 point on KES 100: " +
      [why(u), why(l), sold ? why(sold) : 'no sale attempted', 'points=' + pts].join(' | ')); }

  process.stdout.write(`\n${pass} pass / ${fail} fail\n`);
  clearTimeout(WATCHDOG);
  process.exit(fail ? 1 : 0);
})().catch((e) => { process.stdout.write('  ✖ CRASH — ' + (e && e.stack || e) + '\n'); process.exit(4); });
