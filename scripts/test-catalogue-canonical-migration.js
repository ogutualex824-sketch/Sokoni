/* ═══════════════════════════════════════════════════════════════════════════
   CATALOGUE → CANONICAL products  (the write/read migration)
   scripts/test-catalogue-canonical-migration.js

   The catalogue now produces the same canonical product records the rest of
   SOKONI already consumes:

       catalogue -> smartPosDispatch -> upsertCanonicalProduct -> products

   ── WHY THIS SUITE EXECUTES THE TRIGGERS ───────────────────────────────────

   A `products` write fans out to FIVE triggers; `posProducts` had none. So
   checking that a document appeared would prove almost nothing: the question is
   whether the triggers' assumptions are satisfied by what the canonical writer
   actually writes. They are therefore EXECUTED against the produced document,
   and where one is not satisfied the suite records the gap rather than skipping
   it.

   ── WHAT IS NOT CLAIMED ────────────────────────────────────────────────────

   "The sale works." This asserts that the produced document satisfies the
   FIELDS `posCompleteCheckout` looks up. Proving a real sale is a separate gate
   with its own evidence, and nothing here should be read as that.
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const Module = require('module');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const R    = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0, noted = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; return ok; };
const note = (l, d) => { console.log('  NOTE  ' + l + (d ? '   [' + d + ']' : '')); noted++; };
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(t.length));

/* ── Fake Firestore ──────────────────────────────────────────────────────── */
const STORE = {};
const WRITES = [];
const INC = (n) => ({ __inc: n });
let autoId = 0;
const apply = (key, data, merge) => {
  const cur = merge ? Object.assign({}, STORE[key]) : {};
  for (const k of Object.keys(data)) {
    const v = data[k];
    if (v && typeof v === 'object' && typeof v.__inc === 'number') cur[k] = (typeof cur[k] === 'number' ? cur[k] : 0) + v.__inc;
    else cur[k] = v;
  }
  STORE[key] = cur;
};
const refFor = (col, id) => ({
  id, __key: col + '/' + id, __col: col,
  async get() { const has = Object.prototype.hasOwnProperty.call(STORE, this.__key); return { exists: has, id, data: () => (has ? STORE[this.__key] : undefined) }; },
  async set(data, opts) { apply(this.__key, data, !!(opts && opts.merge)); WRITES.push({ col: this.__col, id: this.id, data }); return {}; },
  async update(data) { apply(this.__key, data, true); WRITES.push({ col: this.__col, id: this.id, data }); return {}; },
});
const mkQuery = (col, st) => {
  const s = Object.assign({ wheres: [], order: null, lim: null, after: null }, st);
  const api = {
    where: (f, o, v) => mkQuery(col, Object.assign({}, s, { wheres: s.wheres.concat([[f, o, v]]) })),
    orderBy: (f) => mkQuery(col, Object.assign({}, s, { order: f })),
    limit: (n) => mkQuery(col, Object.assign({}, s, { lim: n })),
    startAfter: (v) => mkQuery(col, Object.assign({}, s, { after: v })),
    count: () => ({ async get() { const r = await api.get(); return { data: () => ({ count: r.docs.length }) }; } }),
    async get() {
      let rows = Object.keys(STORE).filter((k) => k.startsWith(col + '/'))
        .map((k) => ({ id: k.slice(col.length + 1), data: STORE[k] }));
      for (const [f, o, v] of s.wheres) rows = rows.filter((r) => (o === '==' ? r.data[f] === v : true));
      if (s.order && s.order !== '__name__') { rows = rows.filter((r) => r.data[s.order] !== undefined); }
      rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (s.after != null) { const i = rows.findIndex((r) => r.id === s.after); rows = i >= 0 ? rows.slice(i + 1) : []; }
      if (s.lim != null) rows = rows.slice(0, s.lim);
      return { empty: rows.length === 0, size: rows.length, docs: rows.map((r) => ({ id: r.id, exists: true, ref: refFor(col, r.id), data: () => r.data })) };
    },
  };
  return api;
};
const fakeDb = {
  collection(col) { return Object.assign(mkQuery(col, {}), { doc: (id) => refFor(col, id === undefined ? 'auto-' + (++autoId) : String(id)), add: async (data) => { const id = 'auto-' + (++autoId); apply(col + '/' + id, data, false); WRITES.push({ col, id, data }); return refFor(col, id); } }); },
  async runTransaction(fn) {
    return fn({ get: (r) => r.get(), set: (r, d, o) => { apply(r.__key, d, !!(o && o.merge)); WRITES.push({ col: r.__col, id: r.id, data: d }); }, update: (r, d) => { apply(r.__key, d, true); WRITES.push({ col: r.__col, id: r.id, data: d }); } });
  },
  batch: () => ({ set() {}, update() {}, async commit() {} }),
};
const stubAdmin = {
  apps: [1], initializeApp() {},
  firestore: Object.assign(() => fakeDb, {
    FieldValue: { serverTimestamp: () => '<ts>', increment: INC, delete: () => '<del>', arrayUnion: (...a) => ({ __u: a }) },
    Timestamp: { fromDate: (x) => ({ __ts: x }), fromMillis: (m) => ({ __ts: m }), fromDate2: null, now: () => ({ toMillis: () => Date.now() }) },
    FieldPath: { documentId: () => '__name__' },
  }),
};

const TRIGGERS = {};
const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin') return stubAdmin;
  if (request === 'firebase-functions/v2/firestore') {
    return {
      onDocumentCreated: (o, h) => { (TRIGGERS.created = TRIGGERS.created || []).push({ o, h }); return {}; },
      onDocumentDeleted: (o, h) => { (TRIGGERS.deleted = TRIGGERS.deleted || []).push({ o, h }); return {}; },
      onDocumentUpdated: (o, h) => { (TRIGGERS.updated = TRIGGERS.updated || []).push({ o, h }); return {}; },
      onDocumentWritten: (o, h) => { (TRIGGERS.written = TRIGGERS.written || []).push({ o, h }); return {}; },
    };
  }
  if (request === 'firebase-functions/v2/https') return { onCall: (_o, h) => h, HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } };
  if (request === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (request === 'firebase-functions/params') return { defineSecret: () => ({ value: () => '' }) };
  if (request === 'firebase-functions/logger') return { info() {}, warn() {}, error() {} };
  if (request === './subscription-catalog') return { entitlementFor: () => ({ listingLimit: 10, subscriptionStatus: 'free', source: 'stub', catalogVersion: 1 }) };
  if (request === './subscription-core') return { resolveSubscription: async () => ({ status: 'free', limits: {} }) };
  if (request === './business-bootstrap') return { _assertMerchantAccess: async () => true };
  return realLoad.apply(this, arguments);
};

let WRITER = null, LIMIT = null, ANALYTICS = null, LOAD_ERR = null;
try {
  WRITER    = require(path.join(ROOT, 'functions', 'pos-inventory-pro.js'));
  LIMIT     = require(path.join(ROOT, 'functions', 'product-limit.js'));
  try { ANALYTICS = require(path.join(ROOT, 'functions', 'product-analytics.js')); } catch (_) { ANALYTICS = null; }
} catch (e) { LOAD_ERR = e; }
Module._load = realLoad;

console.log('\nCATALOGUE -> CANONICAL products MIGRATION');
console.log('='.repeat(74));

if (LOAD_ERR || !WRITER || !WRITER._h.upsertCanonicalProduct || !WRITER._h.listCanonicalProducts) {
  console.log('\n  LOAD_ERROR — the ANALYZER failed, not the code: ' + (LOAD_ERR ? LOAD_ERR.message : 'ops missing'));
  process.exit(1);
}

const SELLER = 'uid-seller-1';
const TOK = { seller: true };
const upsert = (data) => WRITER._h.upsertCanonicalProduct({ auth: { uid: SELLER, token: TOK }, data });
const list   = (data) => WRITER._h.listCanonicalProducts({ auth: { uid: SELLER, token: TOK }, data: data || {} });
const res = async (fn) => { try { return { ok: true, out: await fn() }; } catch (e) { return { ok: false, code: e.code || 'threw', message: e.message }; } };
const reset = (c) => { for (const k of Object.keys(STORE)) delete STORE[k]; WRITES.length = 0; if (c) STORE['productCounters/' + SELLER] = c; };
const prod = (id) => STORE['products/' + id];

/* The payload the migrated catalogue actually sends, for a fixed-price product. */
const CATALOGUE_PRODUCT = {
  name: 'Phone Charger', price: 1200, category: 'Electronics',
  description: 'USB-C 20W', unit: 'pcs', status: 'active',
  isService: false, trackInventory: true, sku: 'CHG-20', stock: 7,
  lowStockThreshold: 2, idempotencyKey: 'cat-1',
};
const CATALOGUE_SERVICE = {
  name: 'Phone Repair', price: 1500, category: 'Services',
  unit: 'session', status: 'active', isService: true, idempotencyKey: 'cat-svc-1',
};

async function main() {
  head('1. The catalogue payload produces a canonical products document');
  reset({ uid: SELLER, count: 0, maxProducts: 10 });
  let PID = null;
  {
    const r = await res(() => upsert(CATALOGUE_PRODUCT));
    ck('the create succeeded', r.ok, r.ok ? r.out.productId : r.code + ' ' + r.message);
    PID = r.ok ? r.out.productId : null;
    ck('it landed in products/, not posProducts/',
       !!prod(PID) && !WRITES.some((w) => w.col === 'posProducts'), 'products/' + PID);
    ck('sellerUid is server-stamped', prod(PID).sellerUid === SELLER);
    ck('shopId is server-derived', prod(PID).shopId === SELLER);
    ck('lowStockThreshold was stored as reorderPoint, not dropped', prod(PID).reorderPoint === 2,
       String(prod(PID).reorderPoint));
    ck('NO posProducts vocabulary leaked in',
       !('trackStock' in prod(PID)) && !('stockQty' in prod(PID)) && !('priceMode' in prod(PID)));
  }

  head('2. The document satisfies what posCompleteCheckout LOOKS UP');
  {
    const p = prod(PID);
    /* pos-zero-friction.js:373-388 — doc exists, then salePrice||price, name, category. */
    ck('the lookup would find the document', !!p);
    ck('serverPrice = salePrice || price resolves > 0', (p.salePrice || p.price) > 0, String(p.salePrice || p.price));
    ck('name is present (the mismatch message and receipt use it)', typeof p.name === 'string' && p.name.length > 0);
    ck('category resolves (prod.category || prod.categoryId)', !!(p.category || p.categoryId));
    /* pos-zero-friction.js:754 — stock ?? stockQty ?? quantity ?? 9999, gated on trackInventory !== false */
    ck('the stock gate reads a real number, not the 9999 fallback',
       (p.stock ?? p.stockQty ?? p.quantity ?? 9999) === 7, String(p.stock));
    ck('trackInventory !== false, so the gate APPLIES to this product', p.trackInventory !== false);
    console.log('       NOT A CLAIM THAT A SALE WORKS: these are the fields the lookup reads.');
    console.log('       The sale-path proof is a separate gate with its own evidence.');
  }

  head('3. The products triggers — which are EXECUTED, and which are not');
  const fire = (kind, filterDoc, before, after, params) => {
    const list = TRIGGERS[kind] || [];
    let ran = 0;
    for (const t of list) {
      const docPath = (t.o && t.o.document) || '';
      if (!docPath.startsWith(filterDoc)) continue;
      ran++;
      try {
        Promise.resolve(t.h(kind === 'updated'
          ? { data: { before: { data: () => before }, after: { data: () => after } }, params: params || {} }
          : { data: { data: () => after }, params: params || {} })).catch(() => {});
      } catch (_) { /* recorded by effect, or by its absence */ }
    }
    return ran;
  };
  const created = (TRIGGERS.created || []).filter((t) => (t.o.document || '').startsWith('products/'));
  const updated = (TRIGGERS.updated || []).filter((t) => (t.o.document || '').startsWith('products/'));
  const deleted = (TRIGGERS.deleted || []).filter((t) => (t.o.document || '').startsWith('products/'));
  ck('CONTROL — real trigger bodies were captured from the real modules',
     created.length >= 1 && updated.length >= 1,
     created.length + ' created, ' + updated.length + ' updated, ' + deleted.length + ' deleted');
  /* HONEST ACCOUNTING. Five triggers watch products/{productId}. Three are
     reachable in this harness and two are not, and saying 'five executed' when
     three did would be the kind of claim this suite exists to prevent:
       EXECUTED  product-limit onMarketplaceProductCreated   (count + reservation)
       EXECUTED  product-analytics onProductPriceChanged     (price history)
       CAPTURED  product-limit onMarketplaceProductDeleted   — the catalogue has no
                 delete path; archive is a status change, so nothing exercises it here
       STATIC    email-triggers emailOnProductStatusChange   — module not loaded;
                 its field assumption is analysed below instead
       NOT COVERED redis-integrations onInventoryUpdated     — not loaded, not analysed */
  note('redis-integrations onInventoryUpdated watches products/{id} and is NOT covered by this ' +
       'suite — neither executed nor analysed. Stated so the trigger accounting is not read as complete.');

  /* 3a. product-limit create trigger. */
  {
    const before = (STORE['productCounters/' + SELLER] || {}).count || 0;
    await Promise.all((LIMIT ? [LIMIT] : []).map(() => null));
    const ran = fire('created', 'products/', null, prod(PID), { productId: PID });
    /* the trigger is async; give it a turn */
    await new Promise((r) => setTimeout(r, 30));
    const after = (STORE['productCounters/' + SELLER] || {}).count || 0;
    ck('the create trigger COUNTED the catalogue product', after === before + 1,
       'count ' + before + ' -> ' + after + ' (' + ran + ' create trigger(s) ran)');
    ck('and the reservation was cleared', ((STORE['productCounters/' + SELLER] || {}).serverReserved || 0) === 0,
       'reserved=' + ((STORE['productCounters/' + SELLER] || {}).serverReserved || 0));
  }

  /* 3b. price-change trigger writes price history — and needs sellerUid. */
  if (ANALYTICS) {
    const before = Object.assign({}, prod(PID));
    await res(() => upsert(Object.assign({}, CATALOGUE_PRODUCT, { productId: PID, price: 1400 })));
    fire('updated', 'products/', before, prod(PID), { productId: PID });
    await new Promise((r) => setTimeout(r, 30));
    const hist = Object.keys(STORE).filter((k) => k.startsWith('productPriceHistory/'));
    ck('a price change produced a productPriceHistory row', hist.length >= 1, hist.length + ' row(s)');
    if (hist.length) {
      ck('and it resolved the seller from sellerUid (the field the writer stamps)',
         STORE[hist[0]].sellerId === SELLER, String(STORE[hist[0]].sellerId));
    }
  } else {
    note('product-analytics did not load in this harness — price-history effect NOT observed');
  }

  /* 3c. The email trigger's assumption is NOT satisfied — recorded, not skipped. */
  {
    const src = R('functions/email-triggers.js');
    const usesSellerId = /after\.sellerEmail \|\| await emailForUid\(after\.sellerId/.test(src);
    const p = prod(PID);
    ck('CONTROL — the email trigger keys on sellerEmail / sellerId', usesSellerId);
    const gap = !('sellerEmail' in p) && !('sellerId' in p);
    ck('the canonical writer writes NEITHER sellerEmail nor sellerId', gap,
       gap ? 'both absent' : 'one is present');
    note('FINDING: a status-change email cannot reach a merchant for a canonical-writer product — ' +
         'emailOnProductStatusChange resolves the recipient from sellerEmail/sellerId, and the writer ' +
         'stamps sellerUid. It fails CLOSED (no email, no wrong email). Out of scope for this ' +
         'mutation; recorded so wiring more paths does not bury it.');
    note('The same trigger only acts on status approved/rejected, so an ARCHIVE sends nothing.');
  }

  head('4. Service semantics use the products vocabulary');
  reset({ uid: SELLER, count: 0, maxProducts: 10 });
  {
    const r = await res(() => upsert(CATALOGUE_SERVICE));
    const p = r.ok ? prod(r.out.productId) : null;
    ck('a service is created', r.ok, r.ok ? 'ok' : r.code);
    ck('isService: true', !!p && p.isService === true);
    ck('trackInventory: false', !!p && p.trackInventory === false);
    ck('no stock key at all (not 0, not a sentinel)', !!p && !('stock' in p));
  }

  head('5. Variable pricing is refused, at the writer AND before the call');
  reset({ uid: SELLER, count: 0, maxProducts: 10 });
  ck('the writer refuses variablePrice',
     await (async () => { const r = await res(() => upsert(Object.assign({}, CATALOGUE_SERVICE, { variablePrice: true }))); return !r.ok && r.code === 'failed-precondition'; })());
  const HTML = R('catalogue.html');
  const CODE = HTML.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  ck('the page refuses it BEFORE dispatching, with a stated reason',
     /if\(svc && st\.variable\)\{[\s\S]{0,400}return;/.test(CODE) && /Counter-priced services are not available yet/.test(HTML));

  head('6. Identity and entitlement cannot be bypassed from the page');
  reset({ uid: SELLER, count: 0, maxProducts: 10 });
  ck('a spoofed sellerUid is REFUSED',
     await (async () => { const r = await res(() => upsert(Object.assign({}, CATALOGUE_PRODUCT, { sellerUid: 'someone-else' }))); return !r.ok && r.code === 'permission-denied'; })());
  ck('the page never sends sellerUid or shopId', !/sellerUid|shopId/.test(CODE), 'server-derived only');
  reset({ uid: SELLER, count: 10, maxProducts: 10 });
  ck('the product limit still refuses at the boundary',
     await (async () => { const r = await res(() => upsert(CATALOGUE_PRODUCT)); return !r.ok && r.code === 'resource-exhausted'; })());
  reset({ uid: SELLER, count: 0, maxProducts: 10 });
  ck('an admin field is REFUSED',
     await (async () => { const r = await res(() => upsert(Object.assign({}, CATALOGUE_PRODUCT, { featured: true }))); return !r.ok && r.code === 'permission-denied'; })());
  ck('a base64 image is REFUSED',
     await (async () => { const r = await res(() => upsert(Object.assign({}, CATALOGUE_PRODUCT, { image: 'data:image/png;base64,AA' }))); return !r.ok && r.code === 'invalid-argument'; })());

  head('7. Update / archive / restore act on the SAME document');
  reset({ uid: SELLER, count: 0, maxProducts: 10 });
  {
    const a = await res(() => upsert(CATALOGUE_PRODUCT));
    const id = a.out.productId;
    const b = await res(() => upsert(Object.assign({}, CATALOGUE_PRODUCT, { productId: id, name: 'Charger v2' })));
    ck('an update keeps the same id', b.ok && b.out.productId === id, id);
    ck('and the change landed', prod(id).name === 'Charger v2');
    const arch = await res(() => upsert({ productId: id, name: 'Charger v2', price: 1200, status: 'archived', isService: false }));
    ck('archive sets status archived on the same document', arch.ok && prod(id).status === 'archived', prod(id).status);
    const rest = await res(() => upsert({ productId: id, name: 'Charger v2', price: 1200, status: 'active', isService: false }));
    ck('restore sets it back', rest.ok && prod(id).status === 'active', prod(id).status);
    ck('only ONE products document exists throughout',
       Object.keys(STORE).filter((k) => k.startsWith('products/')).length === 1);
    const c = await res(() => upsert(CATALOGUE_PRODUCT));
    ck('a replayed create is idempotent', c.ok && c.out.idempotent === true && c.out.productId === id);
  }

  head('8. The page reads what it writes');
  reset({ uid: SELLER, count: 0, maxProducts: 10 });
  {
    await res(() => upsert(Object.assign({}, CATALOGUE_PRODUCT, { idempotencyKey: 'r1' })));
    await res(() => upsert(Object.assign({}, CATALOGUE_SERVICE, { idempotencyKey: 'r2' })));
    const r = await res(() => list({ pageSize: 200 }));
    ck('listCanonicalProducts returns both rows', r.ok && r.out.count === 2, r.ok ? String(r.out.count) : r.code);
    ck('the page reads via listCanonicalProducts', /dispatch\('listCanonicalProducts'/.test(CODE));
    ck('and no longer reads posListProducts', !/dispatch\('posListProducts'/.test(CODE));
  }
  {
    const r = await res(() => WRITER._h.listCanonicalProducts({ auth: { uid: 'other', token: { seller: true } }, data: {} }));
    ck("another seller sees none of this seller's products", r.ok && r.out.count === 0, r.ok ? String(r.out.count) : r.code);
  }
  {
    const r = await res(() => WRITER._h.listCanonicalProducts({ auth: { uid: SELLER, token: {} }, data: {} }));
    ck('a caller without the seller claim is REFUSED', !r.ok && r.code === 'permission-denied', r.code);
  }

  head('9. Boundaries this mutation must not cross');
  ck('the page makes NO posProducts call of any kind',
     !/posUpsertProduct|posDeleteProduct|posListProducts|['"]posProducts['"]/.test(CODE));
  ck('the branch-stock posProducts writer is untouched',
     /db\.collection\('posProducts'\)\.doc\(branchId \+ '_' \+ it\.productId\)/.test(R('functions/procurement.js')),
     'procurement.js:1909 intact');
  ck('posUpsertProduct still exists for the POS inventory domain',
     typeof WRITER._h.posUpsertProduct === 'function' && typeof WRITER._h.posListProducts === 'function');
  ck('seller.js browser write is untouched',
     /setDoc\(m\.doc\(db,'products',newProduct\.id\), fsProduct\)/.test(R('seller.js')));
  ck('no rules file was touched', (() => {
    try { return require('child_process').execSync('git status --porcelain firestore.rules firestore.rules.build', { cwd: ROOT, encoding: 'utf8' }).trim() === ''; } catch (_) { return false; }
  })());
  ck('pos-zero-friction and pos-service-pricing untouched', (() => {
    try { return require('child_process').execSync('git status --porcelain functions/pos-zero-friction.js functions/shared/pos-service-pricing.js', { cwd: ROOT, encoding: 'utf8' }).trim() === ''; } catch (_) { return false; }
  })());

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + noted + ' recorded findings');
  console.log(fail === 0
    ? '  MIGRATED — the catalogue writes and reads canonical products. A SALE is NOT yet proven.'
    : '  NOT MIGRATED.');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\n  CRASH — not a refusal:\n  ' + (e && e.stack || e)); process.exit(1); });
