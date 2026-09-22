/* ═══════════════════════════════════════════════════════════════════════════
   OPTION 1 — posUpsertProduct AS THE CANONICAL POS PRODUCT WRITER
   scripts/test-posupsert-catalogue-contract.js

   The owner chose Option 1 on 2026-09-22: the SERVER writer becomes canonical
   and must carry the catalogue contract, rather than the browser writer being
   legitimised. This suite executes the real handler through the exported `_h`
   registry and asserts the contract it now owes.

   ── WHAT WAS WRONG ─────────────────────────────────────────────────────────

   The document was an explicit whitelist that never mentioned `trackStock`,
   `variablePrice`, `listingType` or `trackInventory`. A caller could send them
   and they were **discarded** — so a service could not exist through the
   canonical writer at all, and "variable price" was indistinguishable from
   "KES 0".

   ── WHAT THIS SUITE WILL NOT DO ────────────────────────────────────────────

   It does not assert that `catalogue.html` works. Under the SERVED ruleset
   (`ad2033ad`, proven 12/0 in test-served-posproducts-authorization.js) that
   surface is denied every operation on `posProducts`, and this writer does not
   and must not change that: granting client access means writing `sellerId`,
   which the served rules couple to WRITE permission as well as read — and a
   client that can write `posProducts` directly is the opposite of Option 1.
   That repair is a deliberate RULES change, gated separately.
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const Module = require('module');
const path   = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; return ok; };
const head = t => console.log('\n' + t + '\n' + '-'.repeat(t.length));

/* ── Fake Firestore with transaction support ─────────────────────────────── */
const STORE = {};
const WRITES = [];
const DELETE_SENTINEL = '<<delete>>';
let autoId = 0;

const refFor = (col, id) => ({
  id, __col: col, __key: col + '/' + id,
  async get() { return snapFor(col, id); },
});
const snapFor = (col, id) => {
  const key = col + '/' + id;
  const has = Object.prototype.hasOwnProperty.call(STORE, key);
  return { exists: has, id, data: () => (has ? STORE[key] : undefined) };
};
const applyWrite = (ref, data, opts) => {
  const merge = !!(opts && opts.merge);
  const cur = merge ? Object.assign({}, STORE[ref.__key]) : {};
  for (const k of Object.keys(data)) {
    if (data[k] === DELETE_SENTINEL) { delete cur[k]; continue; }
    cur[k] = data[k];
  }
  STORE[ref.__key] = cur;
  WRITES.push({ collection: ref.__col, id: ref.id, data, merge });
};

const query = () => { const q = { where: () => q, orderBy: () => q, limit: () => q, async get() { return { empty: true, docs: [] }; } }; return q; };
const fakeDb = {
  collection(col) {
    return Object.assign(query(), { doc: (id) => refFor(col, id === undefined ? 'auto-' + (++autoId) : String(id)) });
  },
  async runTransaction(fn) {
    return fn({
      get: (ref) => ref.get(),
      set: (ref, data, opts) => applyWrite(ref, data, opts),
      update: (ref, data) => applyWrite(ref, data, { merge: true }),
      delete: (ref) => { delete STORE[ref.__key]; },
    });
  },
};

/* ── Stub the platform, never the real firebase-admin ────────────────────── */
const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin') {
    return {
      apps: [1], initializeApp() {},
      firestore: Object.assign(() => fakeDb, {
        FieldValue: {
          serverTimestamp: () => '<ts>',
          increment: (n) => ({ __inc: n }),
          delete: () => DELETE_SENTINEL,
          arrayUnion: (...a) => ({ __union: a }),
        },
        Timestamp: { fromDate: (d) => ({ __ts: d.toISOString() }), now: () => ({ __ts: 'now' }) },
        FieldPath: { documentId: () => '__name__' },
      }),
    };
  }
  if (request === 'firebase-functions/v2/https') {
    return {
      onCall: (_o, h) => h,
      HttpsError: class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } },
    };
  }
  if (request === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (request === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h, onDocumentCreated: (_o, h) => h, onDocumentUpdated: (_o, h) => h };
  if (request === 'firebase-functions/params') return { defineSecret: () => ({ value: () => '' }) };
  if (request === 'firebase-functions/logger') return { info() {}, warn() {}, error() {}, debug() {} };
  if (request === 'firebase-functions') return { logger: { info() {}, warn() {}, error() {} }, config: () => ({}) };
  /* The canonical membership guard lives in business-bootstrap. It is replaced
     here rather than reimplemented: the ownership CHAIN it enforces
     (uid -> business -> ownerId) is asserted through its real refusals below by
     driving this stub from the seeded businesses, so the test still fails if the
     writer stops calling it. */
  if (request === './business-bootstrap') {
    return {
      _assertMerchantAccess: async (req, merchantId) => {
        const uid = req && req.auth && req.auth.uid;
        const biz = STORE['businesses/' + merchantId];
        if (!biz) { const e = new Error('Business not found'); e.code = 'not-found'; throw e; }
        if (biz.ownerId !== uid) { const e = new Error('Access denied.'); e.code = 'permission-denied'; throw e; }
        return true;
      },
    };
  }
  return realLoad.apply(this, arguments);
};

let MOD = null, LOAD_ERROR = null;
try { MOD = require(path.join(ROOT, 'functions', 'pos-inventory-pro.js')); }
catch (e) { LOAD_ERROR = e; }
Module._load = realLoad;

console.log('\nOPTION 1 — posUpsertProduct CATALOGUE CONTRACT');
console.log('='.repeat(74));

if (LOAD_ERROR || !MOD || !MOD._h || typeof MOD._h.posUpsertProduct !== 'function') {
  console.log('\n  LOAD_ERROR — could not reach the handler. This says nothing about the');
  console.log('  contract; it says the ANALYZER failed.');
  console.log('  ' + (LOAD_ERROR ? LOAD_ERROR.message : 'no _h.posUpsertProduct'));
  process.exit(1);
}
const upsert = MOD._h.posUpsertProduct;

const OWNER = 'uid-owner-1';
const OTHER = 'uid-other-2';
const BIZ   = 'SOK-BIZ-001';
const BIZ2  = 'SOK-BIZ-002';

const reset = () => {
  for (const k of Object.keys(STORE)) delete STORE[k];
  WRITES.length = 0;
  STORE['businesses/' + BIZ]  = { merchantId: BIZ,  ownerId: OWNER };
  STORE['businesses/' + BIZ2] = { merchantId: BIZ2, ownerId: OTHER };
};

const call = (uid, data, role) => upsert({
  auth: { uid, token: { posRole: role || 'owner', role: role || 'owner' } },
  data,
});
const res = async (fn) => {
  try { const r = await fn(); return { ok: true, result: r }; }
  catch (e) { return { ok: false, code: e.code || 'threw', message: e.message }; }
};
const lastProduct = () => {
  for (let i = WRITES.length - 1; i >= 0; i--) if (WRITES[i].collection === 'posProducts') return WRITES[i].data;
  return null;
};
const PRODUCT = { merchantId: BIZ, name: 'Charger', price: 1000, stockQty: 5 };
const SERVICE = { merchantId: BIZ, name: 'Typing', price: 20, trackStock: false, unit: 'page' };

async function main() {
  head('1. Stock-tracked product — unchanged behaviour');
  reset();
  {
    const r = await res(() => call(OWNER, PRODUCT));
    const d = lastProduct();
    ck('create succeeds', r.ok, r.ok ? 'created' : r.code + ' ' + r.message);
    ck('stockQty written', !!d && d.stockQty === 5, d ? String(d.stockQty) : 'no write');
    ck("unit defaults to the canonical 'pcs'", !!d && d.unit === 'pcs', d ? String(d.unit) : '-');
    ck("priceMode is 'fixed' on every row, not inferred from absence",
       !!d && d.priceMode === 'fixed', d ? String(d.priceMode) : '-');
    ck('trackStock NOT written when the caller did not state it (absent = product)',
       !!d && d.trackStock === undefined, d ? String(d.trackStock) : '-');
  }

  head('2. Service — the field that used to be discarded');
  reset();
  {
    const r = await res(() => call(OWNER, SERVICE));
    const d = lastProduct();
    ck('create succeeds', r.ok, r.ok ? 'created' : r.code + ' ' + r.message);
    ck('trackStock: false SURVIVES the writer', !!d && d.trackStock === false,
       d ? String(d.trackStock) : 'no write');
    ck('unit persisted as given', !!d && d.unit === 'page', d ? String(d.unit) : '-');
    ck('NO stockQty on a service (not 0, not 9999 — absent)',
       !!d && !('stockQty' in d), d ? JSON.stringify(d.stockQty) : '-');
  }

  reset();
  {
    const r = await res(() => call(OWNER, Object.assign({}, SERVICE, { unit: '' })));
    ck('a service with NO unit is REFUSED (never guessed)',
       !r.ok && r.code === 'invalid-argument', r.ok ? 'CREATED' : r.code);
  }
  reset();
  {
    const r = await res(() => call(OWNER, Object.assign({}, SERVICE, { stockQty: 3 })));
    ck('a service carrying stock is REFUSED', !r.ok && r.code === 'invalid-argument',
       r.ok ? 'CREATED' : r.code);
  }

  head('3. Variable price — "cashier names it" is no longer "free"');
  reset();
  {
    const r = await res(() => call(OWNER, Object.assign({}, SERVICE, { variablePrice: true, price: 0 })));
    const d = lastProduct();
    ck('variablePrice service with price 0 is ACCEPTED', r.ok, r.ok ? 'created' : r.code + ' ' + r.message);
    ck('variablePrice: true persisted', !!d && d.variablePrice === true, d ? String(d.variablePrice) : '-');
    ck("priceMode: 'variable' distinguishes it from FREE",
       !!d && d.priceMode === 'variable', d ? String(d.priceMode) : '-');
  }
  reset();
  {
    const r = await res(() => call(OWNER, { merchantId: BIZ, name: 'Free?', price: 0, trackStock: false, unit: 'hour' }));
    ck('a FIXED-price row priced 0 is REFUSED (a defect, not a giveaway)',
       !r.ok && r.code === 'invalid-argument', r.ok ? 'CREATED' : r.code);
  }
  reset();
  {
    const r = await res(() => call(OWNER, Object.assign({}, PRODUCT, { variablePrice: true })));
    ck('variablePrice on a STOCKED product is REFUSED', !r.ok && r.code === 'invalid-argument',
       r.ok ? 'CREATED' : r.code);
  }

  head('4. listingType is a LABEL and may not contradict the discriminator');
  reset();
  {
    const r = await res(() => call(OWNER, Object.assign({}, SERVICE, { listingType: 'service' })));
    const d = lastProduct();
    ck('consistent label accepted and persisted', r.ok && !!d && d.listingType === 'service',
       d ? String(d.listingType) : (r.code || '-'));
  }
  reset();
  {
    const r = await res(() => call(OWNER, Object.assign({}, PRODUCT, { listingType: 'service' })));
    ck("listingType 'service' with a stocked row is REFUSED, not silently preferred",
       !r.ok && r.code === 'invalid-argument', r.ok ? 'CREATED' : r.code);
  }
  reset();
  {
    const r = await res(() => call(OWNER, Object.assign({}, SERVICE, { listingType: 'product' })));
    ck("listingType 'product' with trackStock:false is REFUSED",
       !r.ok && r.code === 'invalid-argument', r.ok ? 'CREATED' : r.code);
  }
  reset();
  {
    const r = await res(() => call(OWNER, Object.assign({}, PRODUCT, { listingType: 'bundle' })));
    ck('an unknown listingType is REFUSED', !r.ok && r.code === 'invalid-argument', r.code);
  }

  head('5. trackInventory is an input ALIAS and is never stored here');
  reset();
  {
    const r = await res(() => call(OWNER, { merchantId: BIZ, name: 'Haircut', price: 300, trackInventory: false, unit: 'session' }));
    const d = lastProduct();
    ck('the marketplace spelling maps to trackStock', r.ok && !!d && d.trackStock === false,
       d ? String(d.trackStock) : (r.code || '-'));
    ck('trackInventory itself is NOT written to posProducts (no second flag)',
       !!d && !('trackInventory' in d), d ? 'absent' : '-');
  }
  reset();
  {
    const r = await res(() => call(OWNER, Object.assign({}, SERVICE, { trackInventory: true })));
    ck('conflicting trackStock/trackInventory is REFUSED', !r.ok && r.code === 'invalid-argument',
       r.ok ? 'CREATED' : r.code);
  }
  reset();
  {
    const r = await res(() => call(OWNER, Object.assign({}, PRODUCT, { trackStock: 'false' })));
    ck("a COERCIBLE non-boolean ('false') is REFUSED, never coerced",
       !r.ok && r.code === 'invalid-argument', r.ok ? 'CREATED' : r.code);
  }

  head('6. Ownership — uid -> business -> ownerId, unchanged');
  reset();
  {
    const r = await res(() => call(OTHER, PRODUCT));
    ck("another uid cannot write into this business", !r.ok && r.code === 'permission-denied',
       r.ok ? 'CREATED' : r.code);
  }
  reset();
  {
    const r = await res(() => call(OWNER, Object.assign({}, PRODUCT, { merchantId: BIZ2 })));
    ck('cross-business write is REFUSED', !r.ok && r.code === 'permission-denied',
       r.ok ? 'CREATED' : r.code);
  }
  reset();
  {
    const r = await res(() => call(OWNER, Object.assign({}, PRODUCT, { merchantId: 'SOK-NOPE' })));
    ck('unknown business is REFUSED', !r.ok, r.code);
  }
  reset();
  {
    const r = await res(() => call(OWNER, { merchantId: BIZ, price: 100 }));
    ck('missing required name is REFUSED', !r.ok && r.code === 'invalid-argument', r.code);
  }
  reset();
  {
    const r = await res(() => call(OWNER, { merchantId: BIZ, name: 'NoPrice' }));
    ck('missing required price is REFUSED', !r.ok && r.code === 'invalid-argument', r.code);
  }

  head('7. Update path — a product converted to a service loses its stock keys');
  reset();
  {
    await res(() => call(OWNER, PRODUCT));
    const created = WRITES.filter(w => w.collection === 'posProducts').pop();
    const id = created.id;
    WRITES.length = 0;
    const r = await res(() => call(OWNER, {
      merchantId: BIZ, productId: id, name: 'Charger', price: 20,
      trackStock: false, unit: 'page',
    }));
    const d = lastProduct();
    ck('update succeeds', r.ok, r.ok ? 'updated' : r.code + ' ' + r.message);
    ck('stock keys are DELETED, not zeroed (0 reads as out of stock)',
       !!d && d.stockQty === DELETE_SENTINEL && d.stock === DELETE_SENTINEL,
       d ? String(d.stockQty) : '-');
    ck('the stored row no longer carries stockQty',
       !('stockQty' in (STORE['posProducts/' + id] || {})), 'removed');
    ck('trackStock:false now on the stored row', STORE['posProducts/' + id].trackStock === false);
  }

  head('8. The boundary this change must NOT cross');
  const SRC = require('fs').readFileSync(path.join(ROOT, 'functions', 'pos-inventory-pro.js'), 'utf8');
  const decomment = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  /* SCOPE IT TO THE WRITER. The first draft scanned the whole file and failed on
     `_updateAVCO`, which takes a sellerId parameter for AVCO costing and has
     nothing to do with posProducts ownership. A detector that cannot tell this
     function from its neighbours reports on neither. */
  const iU = SRC.indexOf('exports._h.posUpsertProduct');
  const jU = SRC.indexOf('exports._h.posDeleteProduct');
  const UPSERT = decomment(SRC.slice(iU, jU > iU ? jU : SRC.length));
  ck('CONTROL — the posUpsertProduct body was extracted and stripped',
     iU > 0 && jU > iU && UPSERT.includes('doc.priceMode') && UPSERT.length > 2000,
     UPSERT.length + 'B');
  ck('the writer does NOT start writing sellerId (that would grant CLIENT WRITES)',
     !/\bsellerId\b/.test(UPSERT),
     'served rules couple sellerId to write permission, not just read');

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log(fail === 0
    ? '  OPTION 1 WRITER CONTRACT HOLDS. catalogue.html migration + the rules gate remain open.'
    : '  CONTRACT NOT MET.');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\n  CRASH — not a refusal:\n  ' + (e && e.stack || e)); process.exit(1); });
