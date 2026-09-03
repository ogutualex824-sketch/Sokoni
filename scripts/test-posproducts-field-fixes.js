#!/usr/bin/env node
/**
 * test-posproducts-field-fixes.js — certifies the posProducts field-mismatch fixes
 * from docs/POSPRODUCTS_MIGRATION_GRAPH.md (step 1: fix field names, independent of
 * any migration decision).
 *
 * EXECUTED against the real shipped logic (stubbed firebase-admin/functions, an
 * in-memory Firestore capable of ==, <, <=, >, in, and FieldPath.documentId() —
 * enough to exercise every query these fixes actually issue):
 *   - business-health-score.js  _scoreInventory       (via exports._h)
 *   - self-heal.js              checkInventoryIntegrity (via exports._h, dual-writer)
 *   - release-readiness.js      _runDomainCheck('inventory', ...) (via exports._h)
 *   - procurement.js            getProcurementForecast (composite-ID lookup fix)
 *
 * STATIC (source-inspection, comment-stripped) for the remaining fixed files, where
 * the auth-guard machinery (_assertMerchantOrAdmin / _assertMerchantAccess) is not
 * worth re-implementing for this suite:
 *   - bi-advanced.js, business-bootstrap.js (both backend, guard-heavy)
 *   - pos-inventory.js, pos-sync.js (client-side)
 *
 * FIXTURE — one shared posProducts set, both real writer schemas represented:
 *   PID_LOW    posUpsertProduct, merchantId M1, active, stockQty 3,  reorderPoint 5  (low stock)
 *   PID_OK     posUpsertProduct, merchantId M1, active, stockQty 10, reorderPoint 5  (healthy)
 *   PID_DEL    posUpsertProduct, merchantId M1, active:false (soft-deleted), stockQty 2
 *   PID_NEG    posUpsertProduct, merchantId M1, active, stockQty -3            (integrity issue)
 *   PID_MIRROR seller.js mirror, NO merchantId, status:'active', stockLevel -4 (integrity issue)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  pass  ' + m); };
const bad = m => { fail++; console.error('  FAIL  ' + m); };
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ══════════════════════════════════════════════════════════════════════════
   In-memory Firestore — supports what these fixes actually query with:
   ==, <, <=, >, >=, in (incl. FieldPath.documentId()), .limit(), .select().
   Range/inequality operators exclude documents missing the filtered field,
   matching real Firestore semantics — that's the exact defect shape being
   certified, so the stub must reproduce it faithfully, not paper over it.
   ══════════════════════════════════════════════════════════════════════════ */
const DATA = {};
const ADDED = []; /* captures every .add() call, e.g. adminAlerts */
const ID_FIELD = '__id__';

function seed(col, id, data) { DATA[col] = DATA[col] || {}; DATA[col][id] = data; }

function matches(id, data, filters) {
  return filters.every(({ field, op, value }) => {
    const actual = field === ID_FIELD ? id : data[field];
    if (op === '==') return actual === value;
    if (op === '!=') return actual !== undefined && actual !== value;
    if (op === 'in')  return actual !== undefined && value.includes(actual);
    if (actual === undefined) return false; /* range ops exclude missing fields, like real Firestore */
    if (op === '<')  return actual < value;
    if (op === '<=') return actual <= value;
    if (op === '>')  return actual > value;
    if (op === '>=') return actual >= value;
    throw new Error('unsupported op in stub: ' + op);
  });
}

function makeQuery(col, filters, limitN) {
  return {
    where(field, op, value) { return makeQuery(col, filters.concat([{ field, op, value }]), limitN); },
    limit(n) { return makeQuery(col, filters, n); },
    select() { return this; },
    orderBy() { return this; },
    async get() {
      const store = DATA[col] || {};
      let ids = Object.keys(store).filter(id => matches(id, store[id], filters));
      if (limitN != null) ids = ids.slice(0, limitN);
      const docs = ids.map(id => ({
        id, exists: true,
        data: () => store[id],
      }));
      return {
        docs, size: docs.length, empty: docs.length === 0,
        forEach(fn) { docs.forEach(fn); },
      };
    },
  };
}

const db = {
  collection(col) {
    return Object.assign(makeQuery(col, [], null), {
      doc(id) {
        const _id = id || 'auto_' + Math.random().toString(36).slice(2, 8);
        return {
          id: _id,
          async get() {
            const d = DATA[col] && DATA[col][_id];
            return { exists: !!d, id: _id, data: () => d };
          },
          async set(data, opts) {
            seed(col, _id, opts && opts.merge ? Object.assign({}, DATA[col] && DATA[col][_id], data) : data);
          },
          async update(data) { seed(col, _id, Object.assign({}, DATA[col] && DATA[col][_id], data)); },
        };
      },
      async add(entry) { ADDED.push({ col, entry }); seed(col, 'auto_' + ADDED.length, entry); },
    });
  },
  async runTransaction(fn) {
    return fn({
      get: (ref) => ref.get(),
      set: (ref, d, o) => ref.set(d, o),
      update: (ref, d) => ref.update(d),
    });
  },
};

/* ── Shared fixture ─────────────────────────────────────────────────────── */
seed('posProducts', 'PID_LOW',    { merchantId: 'M1', branchId: 'B1', name: 'Widget', sku: 'W1', active: true,  stockQty: 3,  reorderPoint: 5, costPrice: 50 });
seed('posProducts', 'PID_OK',     { merchantId: 'M1', branchId: 'B1', name: 'Gadget', sku: 'G1', active: true,  stockQty: 10, reorderPoint: 5 });
seed('posProducts', 'PID_DEL',    { merchantId: 'M1', branchId: 'B1', name: 'Old',    sku: 'O1', active: false, stockQty: 2,  reorderPoint: 5, deletedAt: 1 });
seed('posProducts', 'PID_NEG',    { merchantId: 'M1', branchId: 'B1', name: 'Neg',    sku: 'N1', active: true,  stockQty: -3, reorderPoint: 5 });
seed('posProducts', 'PID_MIRROR', { sellerId: 'S1', tenantId: 'S1', status: 'active', stockLevel: -4, name: 'Mirror' }); /* seller.js writer — NO merchantId */

/* ── Module interception ────────────────────────────────────────────────── */
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'firebase-admin') {
    return {
      apps: [{}], initializeApp: () => {},
      firestore: Object.assign(() => db, {
        FieldValue: { serverTimestamp: () => 'TS', increment: n => ({ __inc: n || 1 }), arrayUnion: (...a) => ({ __union: a }) },
        FieldPath: { documentId: () => ID_FIELD },
        Timestamp: { fromDate: d => d.getTime() },
      }),
    };
  }
  if (request === 'firebase-functions/v2/https') {
    return { onCall: (opts, h) => h || opts, HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } };
  }
  if (request === 'firebase-functions/v2/scheduler') return { onSchedule: (opts, h) => h };
  if (request === 'firebase-functions/logger') return { info(){}, warn(){}, error(){}, debug(){} };
  if (request === 'firebase-functions/params') return { defineSecret: () => ({ value: () => 'test-key' }) };
  if (request === './email-service') return { queue: async () => ({}) };
  if (request === './notify')        return { send: async () => ({}), notify: async () => ({}) };
  if (request === './po-pdf')        return { buildPoPdf: async () => Buffer.from('%PDF') };
  return realLoad.apply(this, arguments);
};

let bhs, selfHeal, releaseReadiness, procurement;
try {
  bhs              = require(path.join(FN, 'business-health-score.js'));
  selfHeal         = require(path.join(FN, 'self-heal.js'));
  releaseReadiness = require(path.join(FN, 'release-readiness.js'));
  procurement      = require(path.join(FN, 'procurement.js'));
} finally {
  Module._load = realLoad;
}

(async () => {

/* ══════════════════════════════════════════════════════════════════════════
   business-health-score.js — _scoreInventory
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\nbusiness-health-score.js — _scoreInventory\n');
{
  const r = await bhs._h._scoreInventory('M1');
  ok_assert('totalSKUs counts all 4 M1 documents (merchantId-scoped query, unaffected by the field fix)', r.metrics.totalSKUs === 4, r.metrics.totalSKUs);
  ok_assert('lowStockCount finds PID_LOW/PID_DEL/PID_NEG via stockQty<=reorderPoint — was structurally 0 before (query filtered on a field named `qty`, which does not exist)', r.metrics.lowStockCount === 3, r.metrics.lowStockCount);
  ok_assert('the seller.js-mirrored, merchantId-less document is correctly excluded (never counted toward M1 at all)', r.metrics.totalSKUs !== 5);
}

/* ══════════════════════════════════════════════════════════════════════════
   self-heal.js — checkInventoryIntegrity (global, both writer schemas)
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\nself-heal.js — checkInventoryIntegrity (dual-writer, unscoped)\n');
{
  const before = ADDED.length;
  const log = { info(){}, warn(){}, error(){} };
  const r = await selfHeal._h.checkInventoryIntegrity(log);
  ok_assert('finds PID_NEG (stockQty<0, posUpsertProduct schema) AND PID_MIRROR (stockLevel<0, seller.js schema) — 2 total', r.negativeQtyCount === 2, r.negativeQtyCount);
  ok_assert('status is issues_found, not silently ok', r.status === 'issues_found');
  const alert = ADDED.slice(before).find(a => a.col === 'adminAlerts');
  ok_assert('an adminAlerts entry was written', !!alert);
  /* _writeAdminAlert spreads `meta` onto the top level of the document. */
  const sampleIds = alert ? (alert.entry.affectedSample || []).map(x => x.productId) : [];
  ok_assert('the alert sample includes BOTH schemas\' negative-stock documents', sampleIds.includes('PID_NEG') && sampleIds.includes('PID_MIRROR'), sampleIds.join(','));
}

/* ══════════════════════════════════════════════════════════════════════════
   release-readiness.js — _runDomainCheck('inventory', merchantId)
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\nrelease-readiness.js — _runDomainCheck(\'inventory\')\n');
{
  const r = await releaseReadiness._h._runDomainCheck('inventory', 'M1');
  /* total=4 (all M1 docs), invalid=1 (PID_NEG only — the merchantId scope already
     excludes the seller.js-mirrored PID_MIRROR) -> score = round((4-1)/4*100) = 75 */
  ok_assert('score reflects exactly 1 invalid (negative-stock) doc out of 4 — was ALWAYS 100 before (qty/quantity matched nothing, so `invalid` was always 0)', r.score === 75, r.score);
  ok_assert('passed reflects the >=70 threshold correctly', r.passed === true);
}

/* ══════════════════════════════════════════════════════════════════════════
   procurement.js — getProcurementForecast (composite-ID lookup fix)
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\nprocurement.js — getProcurementForecast\n');
{
  seed('procForecast', 'M1_PID_LOW', { merchantId: 'M1', branchId: 'B1', productId: 'PID_LOW', reorderPoint: 5, leadDays: 7, preferredSupplierId: null });
  const r = await procurement.getProcurementForecast({ auth: { uid: 'u1' }, data: { merchantId: 'M1', branchId: 'B1' } });
  ok_assert('the forecast resolves exactly one reorder item', r.reorderList.length === 1, r.reorderList.length);
  const item = r.reorderList[0];
  ok_assert('resolved via the FIXED plain-productId lookup, not the old ${branchId}_${productId} composite', item && item.productId === 'PID_LOW');
  ok_assert('productName comes from the REAL posProducts document ("Widget"), not the productId fallback — proves the doc was actually found', item && item.productName === 'Widget', item && item.productName);
  ok_assert('sku comes from the real document', item && item.sku === 'W1');
  ok_assert('currentStock is the real stockQty (3), not the 0 fallback', item && item.currentStock === 3, item && item.currentStock);
  ok_assert('unitCost comes from the real document\'s costPrice (50)', item && item.unitCost === 50, item && item.unitCost);
}

/* ══════════════════════════════════════════════════════════════════════════
   STATIC — bi-advanced.js / business-bootstrap.js / pos-inventory.js / pos-sync.js
   ══════════════════════════════════════════════════════════════════════════ */
console.log('\nSTATIC — remaining fixed files (source inspection)\n');

const bi = strip(fs.readFileSync(path.join(FN, 'bi-advanced.js'), 'utf8'));
/d\.stockQty\s*\?\?\s*d\.stockLevel/.test(bi)
  ? ok('bi-advanced.js inventoryHealth reads stockQty/stockLevel, not qty/quantity')
  : bad('bi-advanced.js does not read the real stock field names');
!/d\.qty\s*\?\?\s*d\.quantity/.test(bi)
  ? ok('bi-advanced.js no longer reads the nonexistent qty/quantity fallback (converse check)')
  : bad('bi-advanced.js still reads the wrong qty/quantity fallback');

const bb = strip(fs.readFileSync(path.join(FN, 'business-bootstrap.js'), 'utf8'));
const bbActiveCount = (bb.match(/\.where\('active', '==', true\)/g) || []).length;
bbActiveCount >= 2
  ? ok('business-bootstrap.js has both posProducts queries (getSetupStatus + getIncrementalSync) reading active==true')
  : bad('business-bootstrap.js is missing one or both active==true fixes (found ' + bbActiveCount + ')');
!/collection\('posProducts'\)[\s\S]{0,80}\.where\('status', '==', 'active'\)/.test(bb)
  ? ok('business-bootstrap.js no longer filters posProducts on status==active anywhere (converse check)')
  : bad('business-bootstrap.js still has a posProducts status==active filter');

const pi = strip(fs.readFileSync(path.join(ROOT, 'pos-inventory.js'), 'utf8'));
/\.where\('active', '==', true\)/.test(pi)
  ? ok('pos-inventory.js adds a second listener for active==true (posUpsertProduct schema)')
  : bad('pos-inventory.js does not have the second, active==true listener');
/_unsubs = \[unsub1, unsub1b, unsub2\]/.test(pi)
  ? ok('the new listener\'s unsubscribe is tracked for cleanup (no leaked listener on stopFirestoreSync)')
  : bad('the new listener is not included in the cleanup array — would leak');

console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed.');
if (fail) { console.log('\n  ' + fail + ' FAILURE(S).'); process.exit(1); }
console.log('\n  PASS — posProducts field-mismatch remediation certified.');

})().catch(e => { console.error('harness error:', e.stack || e.message); process.exit(2); });

function ok_assert(label, cond, detail) {
  if (cond) ok(label); else bad(label + (detail !== undefined ? '  [' + String(detail).slice(0,120) + ']' : ''));
}
