/* test-catalogue-u7a-till-sellability.js — universal catalogue U7a (2026-09-29): the till refuses what the catalogue
 * says is no longer for sale, exactly as the online checkout already does.
 *
 * Census (U7): posCompleteCheckout checked price and ownership but never status, so an ARCHIVED product — the tombstone
 * merchant-v2 writes instead of deleting — stayed sellable over the counter while every online path refused it.
 *
 * REAL functions/shared/sellability.js (+ its byte-identical browser copy), payment-purposes.validateOrderLines and
 * pos-zero-friction.posCompleteCheckout over the transactional fake Firestore.
 *
 * PROVES
 *   TS1 the predicate: archived / deleted / removed / banned / suspended / rejected (any case) and the deleted flags are
 *       refused; active, isVisible:false, draft, paused and inactive are NOT (they govern the ONLINE listing); the
 *       browser copy is byte-identical
 *   TS2 the till refuses an archived product BEFORE anything is charged or written (no stock, no sale, no transaction)
 *   TS3 the till refuses a package whose component is archived; nothing is deducted
 *   TS4 positive control: an unlisted (isVisible:false) but active product still sells at the till, and stock moves
 *   TS5 an archive that lands AFTER the pre-check, inside the sale's window, is still refused on the transaction's read
 *   TS6 parity: the online pricer refuses the same archived product
 *
 *   node scripts/test-catalogue-u7a-till-sellability.js
 */
'use strict';
process.env.GCLOUD_PROJECT = 'demo-catalogue-u7a';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const fs = require('fs'), path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const say = console.log; console.log = console.info = console.warn = console.error = console.debug = () => {};
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 300) + ']' : '')); ok ? pass++ : fail++; };
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
const SELL = load(path.join(FN, 'shared', 'sellability.js'));
const PP = load(path.join(FN, 'payment-purposes.js'));
const ZF = load(path.join(FN, 'pos-zero-friction.js'));
const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const count = async (c) => (await db.collection(c).get()).docs.length;

const A = 'shopA';
async function seed(over) {
  const base = {
    pizza: { name: 'Pizza', price: 800, stock: 10, sellerUid: A, shopId: A, status: 'active', isVisible: true },
    soda: { name: 'Soda', price: 100, stock: 5, sellerUid: A, shopId: A, status: 'active', isVisible: true },
    deal: { name: 'Pizza Meal Deal', price: 900, sellerUid: A, shopId: A, status: 'active', isVisible: true, listingType: 'package', trackInventory: false,
      components: [{ productId: 'pizza', qty: 1 }, { productId: 'soda', qty: 2 }] },
  };
  for (const [id, d] of Object.entries(Object.assign(base, over || {}))) await db.doc('products/' + id).set(d);
}

(async () => {
  /* TS1 — the predicate */
  const tb = typeof SELL.tillBlockReason === 'function' ? SELL.tillBlockReason : null;
  const refused = ['archived', 'deleted', 'removed', 'banned', 'suspended', 'rejected', 'ARCHIVED'].map((s) => tb && tb({ status: s }));
  const allowed = [{ status: 'active' }, { isVisible: false }, { status: 'draft' }, { status: 'paused' }, { status: 'inactive' }, {}].map((p) => tb && tb(p));
  ck('TS1 the till predicate refuses gone/blocked statuses and deleted flags, never the online-only states; browser copy identical',
    !!tb && refused.every(Boolean) && tb({ isDeleted: true }) === 'deleted' && tb({ deleted: true }) === 'deleted' && allowed.every((r) => r === null)
    && read('sokoni-sellability.js') === read('functions/shared/sellability.js'), { refused, allowed });

  if (!ZF || typeof ZF.posCompleteCheckout !== 'function') { ck('TS2-5 the till loads', false, ZF && ZF.__err); }
  else {
    let seq = 0;
    const till = (items, total) => ZF.posCompleteCheckout({ data: { idempotencyKey: 'IK' + (++seq), merchantId: A, items, subtotal: total, grandTotal: total,
      discountTotal: 0, taxTotal: 0, payments: [{ method: 'cash', amount: total }] }, auth: { uid: A, token: { posRole: 'cashier' } } })
      .then(() => 'ok', (e) => e.code + ' | ' + e.message);
    await db.doc('shops/' + A).set({ name: 'Duka A', sellerUid: A });
    await db.doc('users/' + A).set({ displayName: 'Owner A' });

    /* TS2 — archived loose product */
    await seed({ soda: { name: 'Soda', price: 100, stock: 5, sellerUid: A, shopId: A, status: 'archived', isVisible: false } });
    const txBefore = await count('posTransactions');
    const t2 = await till([{ productId: 'soda', qty: 1, unitPrice: 100 }], 100);
    const s2 = await get('products/soda');
    ck('TS2 the till refuses an archived product before anything is charged or written',
      /^failed-precondition \| Soda is no longer for sale.*Nothing has been charged/.test(t2) && s2.stock === 5 && s2.sold === undefined && (await count('posTransactions')) === txBefore,
      { t2, stock: s2.stock, sold: s2.sold });

    /* TS3 — package with an archived component */
    await seed({ pizza: { name: 'Pizza', price: 800, stock: 10, sellerUid: A, shopId: A, status: 'archived', isVisible: false } });
    const t3 = await till([{ productId: 'deal', qty: 1, unitPrice: 900 }], 900);
    const p3 = await get('products/pizza'), s3 = await get('products/soda'), d3 = await get('products/deal');
    ck('TS3 the till refuses a package whose component is archived; nothing is deducted',
      /^failed-precondition \| A package in this sale contains an item that is no longer for sale.*Nothing has been charged/.test(t3)
      && p3.stock === 10 && s3.stock === 5 && d3.sold === undefined, { t3, pizza: p3.stock, soda: s3.stock });

    /* TS4 — positive control: unlisted but active still sells in person */
    await seed({ soda: { name: 'Soda', price: 100, stock: 5, sellerUid: A, shopId: A, status: 'active', isVisible: false } });
    const t4 = await till([{ productId: 'soda', qty: 2, unitPrice: 100 }], 200);
    const s4 = await get('products/soda');
    ck('TS4 an unlisted (isVisible:false) active product still sells at the till, and its stock moves',
      t4 === 'ok' && s4.stock === 3, { t4, stock: s4.stock });

    /* TS5 — archived AFTER the pre-check, before the transaction reads */
    await seed();
    const origRun = db.runTransaction.bind(db);
    let armed = true;
    db.runTransaction = async function (fn, o) {
      if (armed) { armed = false; await db.doc('products/soda').set({ status: 'archived', isVisible: false }, { merge: true }); }
      return origRun(fn, o);
    };
    const t5 = await till([{ productId: 'soda', qty: 1, unitPrice: 100 }], 100);
    db.runTransaction = origRun;
    const s5 = await get('products/soda');
    ck('TS5 an archive that lands after the pre-check is refused on the transaction\'s own read; stock unchanged',
      !armed && /^failed-precondition \| Soda is no longer for sale/.test(t5) && s5.stock === 5, { t5, armedFired: !armed, stock: s5.stock });
  }

  /* TS6 — online parity */
  await seed({ soda: { name: 'Soda', price: 100, stock: 5, sellerUid: A, shopId: A, status: 'archived', isVisible: false } });
  const on = await PP.validateOrderLines('buyer', [{ productId: 'soda', qty: 1 }]).then(() => 'ok', (e) => (e.details && e.details.code) || e.code || e.message);
  ck('TS6 parity: the online pricer refuses the same archived product', on !== 'ok', on);

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
