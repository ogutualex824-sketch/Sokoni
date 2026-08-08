/* Inventory-sync regression — proves canonical `products` reflect on the POS screen
   (PosDB) WITHOUT clobbering an unsynced offline POS sale. This is the inventory
   analogue of the order 9→0 fix: find the source→screen boundary, prove it, lock it. */
'use strict';
const path = require('path');
const S = require(path.join(__dirname, '..', 'pos-inventory-sync.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m); } };

const now = Date.now();
const tsPlain = (ms) => ({ _seconds: Math.floor(ms / 1000), _nanoseconds: 0 });   /* Admin-SDK JSON shape */

/* ── Timestamp coercion (same class as the order bug) ── */
ok(S._toMs(now) === now, 'number passes through');
ok(S._toMs(tsPlain(now)) === Math.floor(now / 1000) * 1000, 'serialized Firestore Timestamp {_seconds} → ms');
ok(S._toMs({ seconds: 100, nanoseconds: 0 }) === 100000, '{seconds,nanoseconds} → ms');
ok(S._toMs(String(now)) === now, 'numeric-string id → ms');
ok(S._toMs({ foo: 1 }) === null, 'unparseable → null (no invented order)');

/* ── New product: inserts with canonical stock ── */
let r = S.reconcileProduct({ id: 'P1', name: 'Milk', price: 50, stock: 10, updatedAt: tsPlain(now) }, null);
ok(r.action === 'insert' && r.record.stock === 10 && r.record.name === 'Milk', 'new canonical product inserts with its stock');
ok(r.record.canonicalUpdatedAt > 0 && r.record.updatedAt === r.record.canonicalUpdatedAt, 'insert is clean (updatedAt == canonicalUpdatedAt)');

/* ── Dashboard edit reflects (canonical newer, no local change) ── */
const local1 = { id: 'P1', name: 'Milk', price: 50, stock: 10, canonicalUpdatedAt: now - 10000, updatedAt: now - 10000 };
r = S.reconcileProduct({ id: 'P1', name: 'Milk 500ml', price: 60, stock: 8, updatedAt: tsPlain(now) }, local1);
ok(r.action === 'update' && r.record.price === 60 && r.record.name === 'Milk 500ml', 'dashboard metadata edit reflects on the screen');
ok(r.record.stock === 8 && r.stockSource === 'canonical', 'dashboard stock edit reflects (no pending local change)');

/* ── Offline POS sale is PRESERVED (local newer than last canonical sync) ── */
const local2 = { id: 'P1', name: 'Milk', price: 50, stock: 7, canonicalUpdatedAt: now - 10000, updatedAt: now - 100 /* just sold locally */ };
r = S.reconcileProduct({ id: 'P1', name: 'Milk', price: 50, stock: 10 /* stale canonical */, updatedAt: tsPlain(now) }, local2);
ok(r.record.stock === 7 && r.stockSource === 'local-preserved', 'unsynced offline POS sale keeps local stock (not clobbered by stale canonical)');
ok(r.record.updatedAt === local2.updatedAt, 'dirty local timestamp preserved until it syncs');
ok(r.record.price === 50 && r.record.canonicalUpdatedAt === S._toMs(tsPlain(now)), 'metadata still refreshes + canonical time advances even when stock is kept local');

/* ── No canonical change → skip (no churn) ── */
const local3 = { id: 'P1', stock: 5, canonicalUpdatedAt: now, updatedAt: now };
r = S.reconcileProduct({ id: 'P1', stock: 99, updatedAt: tsPlain(now - 5000) /* older */ }, local3);
ok(r.action === 'skip' && r.record === null, 'older/equal canonical → skip (screen keeps its value, no churn)');

/* ── Availability fields the old seed dropped are now carried ── */
r = S.reconcileProduct({ id: 'P2', name: 'X', price: 1, stock: 3, status: 'active', isVisible: true, minStockLevel: 2, updatedAt: tsPlain(now) }, null);
ok(r.record.status === 'active' && r.record.isVisible === true && r.record.minStockLevel === 2, 'status/isVisible/minStockLevel carried into PosDB (were silently dropped before)');

/* ── mergeCatalogue: counts + orphan surfacing (never auto-delete) ── */
const canon = [
  { id: 'A', name: 'A', price: 1, stock: 5, updatedAt: tsPlain(now) },            /* new */
  { id: 'B', name: 'B2', price: 2, stock: 4, updatedAt: tsPlain(now) },           /* update (canonical newer) */
  { id: 'C', name: 'C', price: 3, stock: 9, updatedAt: tsPlain(now - 20000) },    /* skip (older) */
];
const locals = [
  { id: 'B', name: 'B', price: 2, stock: 6, canonicalUpdatedAt: now - 10000, updatedAt: now - 10000 },
  { id: 'C', name: 'C', price: 3, stock: 9, canonicalUpdatedAt: now - 10000, updatedAt: now - 10000 },
  { id: 'GONE', name: 'Old', source: 'canonical', canonicalUpdatedAt: now - 10000, updatedAt: now - 10000 }, /* deleted upstream */
];
const merged = S.mergeCatalogue(canon, locals);
ok(merged.stats.inserted === 1 && merged.stats.updated === 1 && merged.stats.skipped === 1, 'mergeCatalogue: 1 new / 1 updated / 1 skipped');
ok(merged.writes.length === 2, 'only the changed rows are written (no needless churn on skips)');
ok(merged.orphans.length === 1 && merged.orphans[0] === 'GONE', 'a canonical row deleted upstream is SURFACED as an orphan, never auto-deleted');
ok(merged.stats.canonical === 3 && merged.stats.local === 3, 'stats report both source sizes');

console.log(fail === 0 ? ('\nALL ' + pass + ' PASSED') : ('\n' + pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
