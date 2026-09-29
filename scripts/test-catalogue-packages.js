/* test-catalogue-packages.js — universal catalogue U5 (2026-09-29): packages and bundles take their COMPONENTS off the
 * canonical shelf — online and at the till — and never keep a second stock.
 *
 * REAL functions/shared/package-stock.js, payment-purposes.validateOrderLines, _finalizeMarketplacePayment (extracted
 * verbatim from index.js with its own module scope) and pos-zero-friction.posCompleteCheckout, over the transactional
 * fake Firestore (increments applied).
 *
 *   Pizza Meal Deal  =  Pizza × 1 · Soda × 2        (shop A)
 *
 * PROVES
 *   PK1 the helper: components sanitised; lines expanded and merged; sets available = the fewest complete sets
 *       (unmetered components never limit; an archived component makes the package unavailable)
 *   PK2 online pricing: the package line carries the SERVER's components; the whole cart is checked against the shelf
 *       ONCE (2 deals + a loose soda need 5 sodas); a foreign, nested or archived component is refused
 *   PK3 online payment (finalize): the components are deducted, the package is not; the receipt lists the package at
 *       its charged price; a forged foreign component is flagged, not deducted; a package with no server components
 *       is never driven to a negative stock
 *   PK4 the till: the components are deducted and the package is not; a loose item of a component is folded into one
 *       write; a component from another shop, or too little combined stock, refuses the sale before anything is written
 *   PK5 the card path: the session carries the server's components and a package's availability comes from them;
 *       payment expands only a SERVER session (client components are ignored); a package document is never deducted
 *
 *   node scripts/test-catalogue-packages.js
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-catalogue-packages';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const fs = require('fs'), path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 280) + ']' : '')); ok ? pass++ : fail++; };
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
const ADMIN = { apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({}) };
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-admin') return ADMIN;
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h, onDocumentCreated: (_o, h) => h, onDocumentUpdated: (_o, h) => h };
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {} };
  if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => '0' }) };
  if (id === './pos-audit') return { writeAudit: () => {} };
  if (id === './workforce-identity') return { _assertBusinessPermission: async () => { throw new HttpsError('permission-denied', 'no membership'); } };
  if (id === './tenant-identity') return { resolveMerchantIdForOwner: async () => ({ ok: false }) };
  return origReq.apply(this, arguments);
};
const load = (p) => { try { return require(p); } catch (e) { return { __err: e.message }; } };
const PS = load(path.join(FN, 'shared', 'package-stock.js'));
const PP = load(path.join(FN, 'payment-purposes.js'));
const ZF = load(path.join(FN, 'pos-zero-friction.js'));
const src = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const codeOf = async (p) => { try { await p; return null; } catch (e) { return (e.details && e.details.code) || e.code || e.message; } };
function extractFinalize() {
  const s = src('functions/index.js'), i = s.indexOf('async function _finalizeMarketplacePayment(');
  if (i < 0) return null;
  let d = 0, j = s.indexOf('{', s.indexOf(')', i));
  for (let k = j; k < s.length; k++) { if (s[k] === '{') d++; else if (s[k] === '}' && --d === 0) { j = k; break; } }
  const fnRequire = (id) => require(id.startsWith('./') ? path.join(FN, id) : id);
  try { return new Function('require', 'return (' + s.slice(i, j + 1) + ')')(fnRequire); } catch (_) { return null; }
}

const A = 'shopA', B = 'shopB';
async function seed(over) {
  const base = {
    pizza: { name: 'Pizza', price: 800, stock: 10, sellerUid: A, shopId: A, status: 'active', isVisible: true },
    soda: { name: 'Soda', price: 100, stock: 5, sellerUid: A, shopId: A, status: 'active', isVisible: true },
    deal: { name: 'Pizza Meal Deal', price: 900, sellerUid: A, shopId: A, status: 'active', isVisible: true, listingType: 'package', trackInventory: false,
      components: [{ productId: 'pizza', qty: 1 }, { productId: 'soda', qty: 2 }] },
    theirs: { name: 'Their Juice', price: 50, stock: 9, sellerUid: B, shopId: B, status: 'active', isVisible: true },
  };
  for (const [id, d] of Object.entries(Object.assign(base, over || {}))) await db.doc('products/' + id).set(d);
}

(async () => {
  /* PK1 */
  const helperOk = typeof PS.expandLines === 'function';
  const sane = helperOk && PS.sanitizeComponents([{ productId: 'a', qty: 2 }, { productId: 'a', qty: 1 }, { productId: 'x/y', qty: 1 }, { productId: 'b', qty: 0 }]);
  const exp = helperOk && PS.expandLines([{ productId: 'deal', qty: 2, sellerUid: A, components: [{ productId: 'pizza', qty: 1 }, { productId: 'soda', qty: 2 }] }, { productId: 'soda', qty: 1, sellerUid: A }]);
  const sodaE = exp && exp.find((e) => e.productId === 'soda'), pizzaE = exp && exp.find((e) => e.productId === 'pizza');
  const deal = { listingType: 'package', components: [{ productId: 'pizza', qty: 1 }, { productId: 'soda', qty: 2 }] };
  ck('PK1 components sanitised; lines expanded + merged; sets = the fewest complete (unmetered never limits; archived → 0)',
    helperOk && JSON.stringify(sane) === JSON.stringify([{ productId: 'a', qty: 3 }]) && sodaE.qty === 5 && pizzaE.qty === 2 && !exp.some((e) => e.productId === 'deal')
    && PS.availableUnits(deal, { pizza: { stock: 10 }, soda: { stock: 5 } }) === 2 && PS.availableUnits(deal, { pizza: {}, soda: {} }) === null
    && PS.availableUnits(deal, { pizza: { stock: 10, status: 'archived' }, soda: { stock: 5 } }) === 0, { sane, exp });

  /* PK2 — online pricing */
  await seed();
  const v1 = await PP.validateOrderLines('buyer', [{ productId: 'deal', qty: 2 }]).catch((e) => ({ err: e.message }));
  const dl = v1.lines && v1.lines[0];
  const over = await codeOf(PP.validateOrderLines('buyer', [{ productId: 'deal', qty: 2 }, { productId: 'soda', qty: 2 }]));   /* needs 6 sodas, 5 on the shelf */
  await seed({ deal: { name: 'Bad Deal', price: 100, sellerUid: A, status: 'active', isVisible: true, listingType: 'package', components: [{ productId: 'theirs', qty: 1 }] } });
  const foreign = await codeOf(PP.validateOrderLines('buyer', [{ productId: 'deal', qty: 1 }]));
  await seed({ deal: { name: 'Nest', price: 100, sellerUid: A, status: 'active', isVisible: true, listingType: 'package', components: [{ productId: 'deal2', qty: 1 }] },
    deal2: { name: 'Inner', price: 50, sellerUid: A, status: 'active', isVisible: true, listingType: 'bundle', components: [{ productId: 'soda', qty: 1 }] } });
  const nested = await codeOf(PP.validateOrderLines('buyer', [{ productId: 'deal', qty: 1 }]));
  await seed({ pizza: { name: 'Pizza', price: 800, stock: 10, sellerUid: A, status: 'archived', isVisible: false } });
  const archived = await codeOf(PP.validateOrderLines('buyer', [{ productId: 'deal', qty: 1 }]));
  ck('PK2 online pricing carries the server\'s components; the whole cart vs the shelf once; foreign / nested / archived components refused',
    dl && dl.unitPrice === 900 && Array.isArray(dl.components) && dl.components.length === 2 && v1.subtotal === 1800
    && over === 'PACKAGE_COMPONENT_STOCK' && foreign === 'PACKAGE_COMPONENT_FOREIGN' && nested === 'PACKAGE_NESTED' && archived === 'PACKAGE_COMPONENT_UNAVAILABLE',
    { price: dl && dl.unitPrice, over, foreign, nested, archived, err: v1.err });

  /* PK3 — online payment */
  const finalize = extractFinalize();
  if (!finalize) ck('PK3 the real finalize could be extracted', false);
  else {
    await seed();
    const r = await finalize(db, ADMIN, { checkoutId: 'O1', orderId: 'O1', sellerUid: A, callerUid: 'buyer', amount: 1800, pathLabel: 'intasend', writeSellerPayment: false,
      items: [{ productId: 'deal', qty: 2, unitPrice: 900, sellerUid: A, components: [{ productId: 'pizza', qty: 1 }, { productId: 'soda', qty: 2 }] }] }).catch((e) => ({ err: e.message }));
    const p1 = await get('products/pizza'), s1 = await get('products/soda'), d1 = await get('products/deal');
    await seed();
    await finalize(db, ADMIN, { checkoutId: 'O2', orderId: 'O2', sellerUid: A, callerUid: 'buyer', amount: 900, pathLabel: 'intasend', writeSellerPayment: false,
      items: [{ productId: 'deal', qty: 1, unitPrice: 900, sellerUid: A, components: [{ productId: 'theirs', qty: 3 }] }] }).catch(() => null);
    const theirs = await get('products/theirs');
    const alerts = (await db.collection('oversoldAlerts').get()).docs.map((d) => d.data());
    await seed();
    await finalize(db, ADMIN, { checkoutId: 'O3', orderId: 'O3', sellerUid: A, callerUid: 'buyer', amount: 900, pathLabel: 'intasend', writeSellerPayment: false,
      items: [{ productId: 'deal', qty: 1, unitPrice: 900, sellerUid: A }] }).catch(() => null);
    const d3 = await get('products/deal');
    const rec = r && r.pricedItems && r.pricedItems.find((x) => x.productId === 'deal');
    ck('PK3 payment deducts the components, not the package; receipt lists the package; forged foreign component flagged not deducted; no negative package stock',
      r && r.finalised && p1.stock === 8 && s1.stock === 1 && d1.stock === undefined && d1.sold === 2 && rec && rec.unitPrice === 900 && rec.qty === 2
      && !(r.pricedItems || []).some((x) => x.productId === 'soda') && theirs.stock === 9 && alerts.some((a) => a.reason === 'package_component_foreign' && a.productId === 'theirs')
      && d3.stock === undefined, { pizza: p1.stock, soda: s1.stock, deal: d1.stock, theirs: theirs.stock, d3: d3.stock, err: r && r.err });
  }

  /* PK4 — the till */
  if (!ZF || typeof ZF.posCompleteCheckout !== 'function') ck('PK4 the till loads', false, ZF && ZF.__err);
  else {
    let seq = 0;
    const till = (items, total) => ZF.posCompleteCheckout({ data: { idempotencyKey: 'IK' + (++seq), merchantId: A, items, subtotal: total, grandTotal: total,
      discountTotal: 0, taxTotal: 0, payments: [{ method: 'cash', amount: total }] }, auth: { uid: A, token: { posRole: 'cashier' } } });
    await db.doc('shops/' + A).set({ name: 'Duka A', sellerUid: A });
    await db.doc('users/' + A).set({ displayName: 'Owner A' });
    /* the till's OWN guard: this package carries no trackInventory flag (older data / another writer) */
    await seed({ deal: { name: 'Pizza Meal Deal', price: 900, sellerUid: A, shopId: A, status: 'active', isVisible: true, listingType: 'package',
      components: [{ productId: 'pizza', qty: 1 }, { productId: 'soda', qty: 2 }] } });
    const t1 = await till([{ productId: 'deal', qty: 1, unitPrice: 900 }, { productId: 'soda', qty: 1, unitPrice: 100 }], 1000).then(() => 'ok', (e) => e.code + ' ' + e.message);
    const tp = await get('products/pizza'), ts = await get('products/soda'), td = await get('products/deal');
    await seed({ deal: { name: 'Bad Deal', price: 100, sellerUid: A, shopId: A, status: 'active', isVisible: true, listingType: 'package', trackInventory: false, components: [{ productId: 'theirs', qty: 1 }] } });
    const tForeign = await till([{ productId: 'deal', qty: 1, unitPrice: 100 }], 100).then(() => 'ok', (e) => e.code + ' | ' + e.message);
    const theirs2 = await get('products/theirs');
    await seed();
    const tShort = await till([{ productId: 'deal', qty: 2, unitPrice: 900 }, { productId: 'soda', qty: 2, unitPrice: 100 }], 2000).then(() => 'ok', (e) => e.message);
    const ts2 = await get('products/soda');
    ck('PK4 the till deducts components not the package (loose soda folded in); a foreign component or short combined stock refuses before writing',
      t1 === 'ok' && tp.stock === 9 && ts.stock === 2 && td.stock === undefined && td.sold === 1 && /^permission-denied \| .*Nothing has been charged/.test(tForeign) && theirs2.stock === 9
      && /Insufficient stock for Soda/.test(tShort) && ts2.stock === 5, { t1, pizza: tp.stock, soda: ts.stock, deal: td.stock, tForeign, tShort: String(tShort).slice(0, 60), soda2: ts2.stock });
  }

  /* PK5 — the card path wiring (the full callables need index.js's module scope) */
  const idx = src('functions/index.js');
  ck('PK5 the card session carries the server\'s components and derives package availability; payment expands only a SERVER session; a package doc is never deducted',
    /\.\.\.\(_pkgComps \? \{ components: _pkgComps \} : \{\}\)/.test(idx) && /_pkgUnits = _PSs\.availableUnits\(/.test(idx)
    && /const _deductItems = sessionDoc\s*\? _PS\.expandLines\(resolvedItems \|\| \[\]\)\s*: \(resolvedItems \|\| \[\]\)\.map\(\(it\) => Object\.assign\(\{\}, it, \{ components: undefined \}\)\);/.test(idx)
    && /if \(!item\.viaPackage && _PS\.isComposite\(pdata\)\) return;/.test(idx));

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
