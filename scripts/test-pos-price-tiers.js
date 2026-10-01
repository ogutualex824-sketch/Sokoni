#!/usr/bin/env node
/* POS PRICE TIERS + PRODUCT OWNERSHIP — proven by EXECUTION of the real posCompleteCheckout (owner, 2026-10-01).
 * Harness copied from test-pos-gate-behavioural.js (same fake store, same REAL merchant-identity authority).
 *   node scripts/test-pos-price-tiers.js
 *   BASE=<tree> node scripts/test-pos-price-tiers.js   (baseline: live ee37437 must FAIL the tier/ownership rows) */
'use strict';

const path = require('path');
const Module = require('module');

const ROOT = path.resolve(process.env.BASE || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label +
    (detail !== undefined && detail !== '' ? '   [' + String(detail).slice(0, 150) + ']' : ''));
  ok ? pass++ : fail++;
};

class HttpsError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}

const CTL = {
  membershipOk: false,     /* workspaceMemberships grants the `sales` capability */
  liabilities: [],         /* rows the commission ledger holds                   */
  ledgerUnreadable: false, /* the commission ledger read fails                   */
  shopsUnreadable: false,  /* the IDENTITY authority itself is unavailable       */
};

const DOCS = new Map();
let AUTO = 0;
/* Apply FieldValue.increment the way Firestore does (the stock deduction writes increment(-qty)). */
const applyInc = (cur, v) => { const out = Object.assign({}, cur || {}); for (const [k, x] of Object.entries(v || {})) out[k] = (x && x.__inc !== undefined) ? Number(out[k] || 0) + x.__inc : x; return out; };
const FieldValue = { serverTimestamp: () => 'TS', increment: (n) => ({ __inc: n }) };

function makeDb() {
  const mk = (name, filters) => ({
    doc(id) {
      if (id === undefined) id = 'auto_' + (++AUTO);   /* Firestore auto-id: the real uid() helper mints sale ids this way */
      const key = name + '/' + id;
      return {
        _key: key, id,
        async get() {
          /* The identity authority being DOWN is a different event from the caller not being
             employed, and posCompleteCheckout must not collapse the two. */
          if (name === 'shops' && CTL.shopsUnreadable) throw new Error('identity store unavailable');
          const d = DOCS.get(key);
          return { exists: !!d, id, data: () => (d ? Object.assign({}, d) : undefined) };
        },
        async set(v) { DOCS.set(key, applyInc(DOCS.get(key), v)); },
        async create(v) {
          if (DOCS.has(key)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; }
          DOCS.set(key, Object.assign({}, v));
        },
        async update(v) { DOCS.set(key, applyInc(DOCS.get(key), v)); },
      };
    },
    where(f, _op, v) { return mk(name, filters.concat([[f, v]])); },
    orderBy() { return this; },
    limit() { return this; },
    async get() {
      if (name === 'posCommissionLiabilities' && CTL.ledgerUnreadable) {
        throw new Error('simulated Firestore outage');
      }
      const rows = name === 'posCommissionLiabilities' ? CTL.liabilities : [];
      const kept = rows.filter((r) => filters.every(([f, v]) => r[f] === v));
      return { docs: kept.map((r, i) => ({ id: 'L' + i, data: () => r })), empty: kept.length === 0,
               forEach(cb) { kept.forEach((r, i) => cb({ id: 'L' + i, data: () => r })); } };
    },
  });
  return {
    collection: (n) => mk(n, []),
    async runTransaction(fn) {
      const w = [];
      const t = { async get(r) { return r.get(); }, set(r, v) { w.push([r._key, v]); },
                  update(r, v) { w.push([r._key, v]); }, create(r, v) { w.push([r._key, v]); } };
      const out = await fn(t);
      for (const [k, v] of w) DOCS.set(k, applyInc(DOCS.get(k), v));
      return out;
    },
  };
}
const DB = makeDb();

const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') {
    return { getFirestore: () => DB, FieldValue,
             Timestamp: { now: () => ({ toMillis: () => Date.now() }) } };
  }
  if (id === 'firebase-admin') {
    return { apps: [1], initializeApp: () => {}, auth: () => ({}),
             firestore: Object.assign(() => DB, { FieldValue,
               Timestamp: { now: () => ({ toMillis: () => Date.now() }) } }) };
  }
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError };
  if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (id === 'firebase-functions/v2/firestore') {
    return { onDocumentWritten: (_o, h) => h, onDocumentCreated: (_o, h) => h,
             onDocumentUpdated: (_o, h) => h };
  }
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {} };
  if (id === 'firebase-functions/params') return { defineSecret: (n) => ({ name: n, value: () => '0' }) };
  if (id === './pos-audit') return { writeAudit: () => {} };
  /* NOT stubbed: ./merchant-identity is the real, restored, deployed-canonical module. */
  if (id === './workforce-identity') {
    return { _assertBusinessPermission: async () => {
      if (!CTL.membershipOk) throw new HttpsError('permission-denied', 'no membership');
      return true;
    } };
  }
  if (id === './tenant-identity') return { resolveMerchantIdForOwner: async () => ({ ok: false }) };
  return orig.apply(this, arguments);
};

let ZF, loadErr = null;
try { ZF = require(path.join(FN, 'pos-zero-friction.js')); } catch (e) { loadErr = e; }
Module.prototype.require = orig;

/* `merchantId` IS the shopId — the till sends `merchantId: scope.shopId`. The OWNER's uid
   equals the shop id (ownership is the document id); the CASHIER is a different uid, which is
   what makes the fixture non-degenerate. */
const MERCHANT = 'SHOP_KASS_001';
const CASHIER  = 'CSH_uid_442';
const STRANGER = 'STR_uid_909';
const eat = (iso) => Date.parse(iso + '+03:00');

let keySeq = 0;

/* Seed the REAL resolveActor's inputs and return the uid to call as. */
function seedActor(kind) {
  DOCS.set('shops/' + MERCHANT, { name: 'KASS Shop' });
  DOCS.set('users/' + MERCHANT, { displayName: 'Owner Ann' });
  if (kind === 'owner') return MERCHANT;
  if (kind === 'employee') {
    DOCS.set('users/' + CASHIER, { displayName: 'Cashier Zed' });
    /* THE CANONICAL COMPOSITE KEY — `${shopId}_${uid}`, exactly what
       shop-employees.js `employeeDocId()` produces. An earlier version of this fixture
       wrote `shopEmployees/{uid}`, which is the LEGACY single-uid key. That fixture
       passed against the deployed merchant-identity (ccc43cf, which still reads the
       legacy key) and failed against the newer one — so the test was asserting the old
       key, and would have quietly certified a module that disagrees with the writer.
       Keyed here through the real employeeDocId so the fixture cannot drift from it. */
    const EMP = require(path.join(FN, 'shop-employees.js'));
    DOCS.set('shopEmployees/' + EMP.employeeDocId(MERCHANT, CASHIER), {
      shopId: MERCHANT, uid: CASHIER, shopOwnerId: MERCHANT,
      role: 'cashier', name: 'Cashier Zed', active: true, status: 'active',
    });
    return CASHIER;
  }
  return STRANGER;                    /* shop exists; caller is a stranger to it */
}

function reset() {
  DOCS.clear();
  CTL.membershipOk = false; CTL.liabilities = [];
  CTL.ledgerUnreadable = false; CTL.shopsUnreadable = false;
  DOCS.set('businesses/' + MERCHANT, { ownerId: 'SOMEONE_ELSE' });
  DOCS.set('products/P1', { name: 'Rice', price: 100, stock: 50, trackInventory: true });
}

const call = async (uid, over = {}) => {
  try {
    const r = await ZF.posCompleteCheckout({
      data: Object.assign({
        idempotencyKey: 'IK_' + (++keySeq),
        merchantId: MERCHANT,
        items: [{ productId: 'P1', qty: 1, unitPrice: 100 }],
        subtotal: 100, grandTotal: 100, discountTotal: 0, taxTotal: 0,
        payments: [{ method: 'cash', amount: 100 }],
      }, over),
      auth: { uid, token: { posRole: 'cashier' } },
    });
    return { ok: true, result: r };
  } catch (e) { return { ok: false, code: e && e.code, message: e && e.message }; }
};

const overdue = () => ([{ merchantUid: MERCHANT, settlementDay: '2026-09-05',
                          liabilityMinor: 5000, status: 'OUTSTANDING' }]);
const noSale = () => ![...DOCS.keys()].some((k) => k.indexOf('posRetailSales/') === 0);

/* Products for the tier matrix (owner's brief, section 16). A/B/C/L belong to the till's shop; X to another shop. */
function seedProducts() {
  DOCS.set('products/A', { name: 'Coffee A', price: 100, shopPrice: 90, wholesalePrice: 80, stock: 50, shopId: MERCHANT, sellerUid: MERCHANT });
  DOCS.set('products/B', { name: 'Coffee B', price: 100, wholesalePrice: 80, stock: 50, shopId: MERCHANT, sellerUid: MERCHANT });
  DOCS.set('products/C', { name: 'Coffee C', price: 100, shopPrice: 90, stock: 50, shopId: MERCHANT, sellerUid: MERCHANT });
  DOCS.set('products/L', { name: 'Legacy (no shopId)', price: 100, stock: 50, sellerUid: MERCHANT });
  DOCS.set('products/X', { name: 'Other shop', price: 100, shopPrice: 90, stock: 50, shopId: 'SHOP_OTHER', sellerUid: 'OTHER_OWNER' });
}
const line = (productId, qty, unitPrice, priceTier) => Object.assign({ productId, qty, unitPrice }, priceTier === undefined ? {} : { priceTier });
const sell = async (uid, lines, extra) => {
  const sub = lines.reduce((s, l) => s + l.unitPrice * l.qty, 0);
  return call(uid, Object.assign({ items: lines, subtotal: sub, grandTotal: sub, payments: [{ method: 'cash', amount: sub }] }, extra || {}));
};
const saleKeys = () => [...DOCS.keys()].filter((x) => x.indexOf('posRetailSales/') === 0);
const lastSale = () => { const k = saleKeys().pop(); return k ? DOCS.get(k) : null; };
const stockOf = (id) => { const s = DOCS.get('products/' + id).stock; return (s && s.__inc !== undefined) ? s : s; };

(async () => {
  ck('S0  pos-zero-friction loads', !loadErr, loadErr && loadErr.message);
  if (loadErr) { console.log('\nCANNOT PROCEED\n'); process.exit(1); }

  const T = async (id, label, lines, expect) => {
    reset(); seedProducts(); const uid = seedActor('employee');
    const before = Object.fromEntries(lines.map((l) => [l.productId, stockOf(l.productId)]));
    const r = await sell(uid, lines);
    const sale = lastSale();
    if (expect.ok) {
      const it = sale && sale.items && sale.items[0];
      const stockOk = lines.every((l) => stockOf(l.productId) === before[l.productId] - l.qty);
      ck(id + ' ' + label, r.ok && it && it.unitPrice === expect.unit && it.priceTier === expect.tier && stockOk,
        JSON.stringify({ ok: r.ok, msg: r.message, unit: it && it.unitPrice, tier: it && it.priceTier, stockOk }));
    } else {
      const unchanged = lines.every((l) => stockOf(l.productId) === before[l.productId]);
      ck(id + ' ' + label, !r.ok && noSale() && unchanged && (!expect.code || r.code === expect.code),
        JSON.stringify({ ok: r.ok, code: r.code, msg: r.message && r.message.slice(0, 90), sale: !noSale(), unchanged }));
    }
  };

  /* Product A: online 100 / shop 90 / wholesale 80 */
  await T('T-1', 'A online (default, no tier sent) -> 100', [line('A', 2, 100)], { ok: true, unit: 100, tier: 'online' });
  await T('T-2', 'A online (explicit) -> 100', [line('A', 1, 100, 'online')], { ok: true, unit: 100, tier: 'online' });
  await T('T-3', 'A shop -> 90, stock -qty exactly once', [line('A', 2, 90, 'shop')], { ok: true, unit: 90, tier: 'shop' });
  await T('T-4', 'A wholesale -> 80', [line('A', 3, 80, 'wholesale')], { ok: true, unit: 80, tier: 'wholesale' });
  /* Product B: shop missing */
  await T('T-5', 'B shop (NOT configured) -> REFUSED, never 0, never another tier', [line('B', 1, 100, 'shop')], { ok: false, code: 'failed-precondition' });
  await T('T-6', 'B wholesale -> 80', [line('B', 1, 80, 'wholesale')], { ok: true, unit: 80, tier: 'wholesale' });
  /* Product C: wholesale missing */
  await T('T-7', 'C wholesale (NOT configured) -> REFUSED', [line('C', 1, 90, 'wholesale')], { ok: false, code: 'failed-precondition' });
  /* Forgery / authority */
  await T('T-8', 'unsupported tier "vip" -> REFUSED', [line('A', 1, 100, 'vip')], { ok: false, code: 'failed-precondition' });
  await T('T-9', 'client price != tier price (shop sold at 50) -> REFUSED', [line('A', 1, 50, 'shop')], { ok: false });
  await T('T-10', 'wholesale price claimed under the online tier -> REFUSED', [line('A', 1, 80, 'online')], { ok: false });
  reset(); seedProducts();
  { const uid = seedActor('employee');
    const r = await sell(uid, [Object.assign(line('A', 1, 90, 'shop'), { priceTierLabel: 'FREE' })]);
    const it = lastSale() && lastSale().items[0];
    ck('T-11 the sale records the SERVER tier + label (a client label is overwritten)', r.ok && it && it.priceTier === 'shop' && it.priceTierLabel === 'SHOP PRICE', JSON.stringify(it)); }
  /* Ownership */
  await T('O-1', 'another shop\'s product -> REFUSED, no sale, no stock move', [line('X', 1, 100)], { ok: false, code: 'permission-denied' });
  await T('O-2', 'mixed cart (own + other shop) -> REFUSED whole', [line('A', 1, 100), line('X', 1, 100)], { ok: false, code: 'permission-denied' });
  await T('O-3', 'legacy own product (no shopId, sellerUid = shop owner) -> allowed', [line('L', 1, 100)], { ok: true, unit: 100, tier: 'online' });
  reset(); seedProducts();
  { const r = await sell(seedActor('stranger'), [line('A', 1, 100)]);
    ck('O-4 a stranger to the shop is refused (unchanged)', !r.ok && noSale(), r.message); }
  /* Receipt */
  reset(); seedProducts();
  { const uid = seedActor('employee'); const r = await sell(uid, [line('A', 2, 90, 'shop')]);
    const res = r.ok ? r.result : null;
    const items = (res && ((res.receipt && res.receipt.items) || res.items)) || [];
    const saleIt = (lastSale() && lastSale().items) || [];
    const has = (arr) => arr.some((x) => x.priceTier === 'shop' && x.priceTierLabel === 'SHOP PRICE' && x.unitPrice === 90 && x.qty === 2);
    ck('R-1 the receipt / sale line carries the tier ("SHOP PRICE", 2 x 90)', r.ok && (has(items) || has(saleIt)), JSON.stringify(items.length ? items : saleIt).slice(0, 160)); }
  /* Idempotency: the same key retried = one sale, one stock effect */
  reset(); seedProducts();
  { const uid = seedActor('employee');
    const d = { idempotencyKey: 'IK_RETRY', items: [line('A', 1, 90, 'shop')], subtotal: 90, grandTotal: 90, payments: [{ method: 'cash', amount: 90 }] };
    const a = await call(uid, d); const b = await call(uid, d);
    ck('I-1 a retry with the same key = one sale, one stock effect', a.ok && saleKeys().length === 1 && stockOf('A') === 49, JSON.stringify({ a: a.ok, b: b.ok, sales: saleKeys().length, stock: stockOf('A') })); }
  /* The dry run uses the same tier rule */
  reset(); seedProducts();
  { const uid = seedActor('employee'); let r;
    try { r = await ZF.posCompleteCheckout({ data: { dryRun: true, idempotencyKey: 'IK_DRY', merchantId: MERCHANT, items: [line('B', 1, 100, 'shop')], subtotal: 100, grandTotal: 100 }, auth: { uid, token: {} } }); } catch (e) { r = { err: e.message }; }
    ck('D-1 the dry run reports an unconfigured tier as a difference', r && r.ok === false && (r.differences || []).some((x) => x.field === 'priceTier'), JSON.stringify(r).slice(0, 150)); }

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
