/* ═══════════════════════════════════════════════════════════════════════════
   THE CANONICAL `products` WRITER — upsertCanonicalProduct
   scripts/test-canonical-product-writer.js

   `products` is the canonical saleable merchant product (owner decision
   2026-09-22, after the product authority census). This writer exists so the
   catalogue can eventually produce canonical products instead of a parallel
   catalogue in `posProducts`.

   ── WHAT THIS SUITE IS REALLY FOR ──────────────────────────────────────────

   The served ruleset ALREADY enforces six things on every browser write to
   `products`. The Admin SDK bypasses all six, so a server writer is a silent
   LOOSENING unless it re-implements each one. Every guard is therefore asserted
   here against the executed handler:

       isActive · isSeller · sellerUid == uid (immutable) · validPrice > 0
       noAdminFields · noBase64Image · withinProductLimit

   The entitlement one matters most because it fails QUIETLY: the counter keeps
   counting correctly while the cap stops being enforced, so "the counter is
   right" is not evidence that the limit works.

   ── WHAT THIS SUITE CANNOT PROVE ───────────────────────────────────────────

   True concurrency. A fake transaction cannot reproduce Firestore's conflict
   detection — the emulator takes locks and production aborts on updateTime, so
   contention is not reproducible in either. What IS asserted is the MECHANISM
   that makes contention safe (the transaction reads AND writes the counter, so
   a concurrent create conflicts and retries) plus the sequential boundary. The
   residual is named, not hidden.
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const Module = require('module');
const fs     = require('fs');
const path   = require('path');

const ROOT = path.join(__dirname, '..');
const R    = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; return ok; };
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(t.length));

/* ── Fake Firestore with increment support ───────────────────────────────── */
const STORE = {};
const WRITES = [];
const INC = (n) => ({ __inc: n });
let autoId = 0;

const apply = (key, data, merge) => {
  const cur = merge ? Object.assign({}, STORE[key]) : {};
  for (const k of Object.keys(data)) {
    const v = data[k];
    if (v && typeof v === 'object' && typeof v.__inc === 'number') {
      cur[k] = (typeof cur[k] === 'number' ? cur[k] : 0) + v.__inc;
    } else if (v === '<del>') { delete cur[k]; }
    else cur[k] = v;
  }
  STORE[key] = cur;
};
const refFor = (col, id) => ({
  id, __key: col + '/' + id, __col: col,
  async get() {
    const has = Object.prototype.hasOwnProperty.call(STORE, this.__key);
    return { exists: has, id, data: () => (has ? STORE[this.__key] : undefined) };
  },
});
const fakeDb = {
  collection(col) {
    const q = { where: () => q, orderBy: () => q, limit: () => q, async get() { return { empty: true, docs: [] }; } };
    return Object.assign(q, { doc: (id) => refFor(col, id === undefined ? 'auto-' + (++autoId) : String(id)) });
  },
  async runTransaction(fn) {
    return fn({
      get: (ref) => ref.get(),
      set: (ref, data, opts) => { apply(ref.__key, data, !!(opts && opts.merge)); WRITES.push({ col: ref.__col, id: ref.id, data }); },
      update: (ref, data) => { apply(ref.__key, data, true); WRITES.push({ col: ref.__col, id: ref.id, data }); },
    });
  },
};

const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin') {
    return {
      apps: [1], initializeApp() {},
      firestore: Object.assign(() => fakeDb, {
        FieldValue: { serverTimestamp: () => '<ts>', increment: INC, delete: () => '<del>' },
        Timestamp: { fromDate: (x) => ({ __ts: x }), now: () => ({}) },
        FieldPath: { documentId: () => '__name__' },
      }),
    };
  }
  if (request === 'firebase-functions/v2/https') {
    return { onCall: (_o, h) => h, HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } };
  }
  if (request === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (request === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h };
  if (request === 'firebase-functions/params') return { defineSecret: () => ({ value: () => '' }) };
  if (request === 'firebase-functions/logger') return { info() {}, warn() {}, error() {} };
  if (request === './business-bootstrap') return { _assertMerchantAccess: async () => true };
  return realLoad.apply(this, arguments);
};

let MOD = null, LOAD_ERROR = null;
try { MOD = require(path.join(ROOT, 'functions', 'pos-inventory-pro.js')); }
catch (e) { LOAD_ERROR = e; }
Module._load = realLoad;

console.log('\nCANONICAL products WRITER — upsertCanonicalProduct');
console.log('='.repeat(74));

if (LOAD_ERROR || !MOD || !MOD._h || typeof MOD._h.upsertCanonicalProduct !== 'function') {
  console.log('\n  LOAD_ERROR — could not reach the handler; the ANALYZER failed, not the writer.');
  console.log('  ' + (LOAD_ERROR ? LOAD_ERROR.message : 'no _h.upsertCanonicalProduct'));
  process.exit(1);
}
const upsert = MOD._h.upsertCanonicalProduct;

const SELLER = 'uid-seller-1';
const OTHER  = 'uid-seller-2';
const SELLER_TOKEN = { seller: true };

const reset = (counter) => {
  for (const k of Object.keys(STORE)) delete STORE[k];
  WRITES.length = 0;
  if (counter) STORE['productCounters/' + SELLER] = counter;
};
const call = (uid, token, data) => upsert({ auth: { uid, token: token || SELLER_TOKEN }, data });
const res = async (fn) => {
  try { return { ok: true, out: await fn() }; }
  catch (e) { return { ok: false, code: e.code || 'threw', message: e.message }; }
};
const lastProduct = () => { for (let i = WRITES.length - 1; i >= 0; i--) if (WRITES[i].col === 'products') return WRITES[i].data; return null; };
const GOOD = { name: 'Charger', price: 1000, category: 'Electronics', stock: 5 };

async function main() {
  head('1. isSeller / isActive — the claims the rules require');
  reset();
  ck('a seller claim is ACCEPTED', (await res(() => call(SELLER, { seller: true }, GOOD))).ok);
  ck('NO seller claim is REFUSED',
     await (async () => { const r = await res(() => call(SELLER, {}, GOOD)); return !r.ok && r.code === 'permission-denied'; })());
  ck("seller:'true' (a STRING) is REFUSED, never coerced",
     await (async () => { const r = await res(() => call(SELLER, { seller: 'true' }, GOOD)); return !r.ok && r.code === 'permission-denied'; })());
  ck('a DEACTIVATED caller is REFUSED',
     await (async () => { const r = await res(() => call(SELLER, { seller: true, deactivated: true }, GOOD)); return !r.ok && r.code === 'permission-denied'; })());
  ck('a platform admin is accepted without the seller claim (matches isActive/isAdmin)',
     (await res(() => call(SELLER, { admin: true }, GOOD))).ok);
  ck('unauthenticated is REFUSED',
     await (async () => { const r = await res(() => upsert({ auth: null, data: GOOD })); return !r.ok; })());

  head('2. Ownership — sellerUid is the caller, and it is immutable');
  reset();
  {
    const r = await res(() => call(SELLER, SELLER_TOKEN, GOOD));
    const p = lastProduct();
    ck('sellerUid is stamped from the token, not the payload', r.ok && p.sellerUid === SELLER, p ? p.sellerUid : '-');
    ck('shopId is DERIVED from the proven owner (103/108 live rows key this way)',
       !!p && p.shopId === SELLER, p ? p.shopId : '-');
  }
  reset();
  ck('a payload sellerUid naming someone else is REFUSED',
     await (async () => { const r = await res(() => call(SELLER, SELLER_TOKEN, Object.assign({}, GOOD, { sellerUid: OTHER }))); return !r.ok && r.code === 'permission-denied'; })());
  reset();
  {
    STORE['products/existing'] = { sellerUid: OTHER, name: 'Theirs', price: 50 };
    const r = await res(() => call(SELLER, SELLER_TOKEN, Object.assign({}, GOOD, { productId: 'existing' })));
    ck("another seller's product cannot be updated (sellerUid immutable in effect)",
       !r.ok && r.code === 'permission-denied', r.ok ? 'UPDATED' : r.code);
  }
  reset();
  {
    STORE['products/mine'] = { sellerUid: SELLER, name: 'Mine', price: 50 };
    const r = await res(() => call(SELLER, SELLER_TOKEN, { productId: 'mine', name: 'Mine v2', price: 60 }));
    const p = lastProduct();
    ck('my own product updates, and sellerUid still resolves to me',
       r.ok && p.sellerUid === SELLER, r.ok ? 'updated' : r.code);
  }
  reset();
  ck('updating a product that does not exist is REFUSED',
     await (async () => { const r = await res(() => call(SELLER, SELLER_TOKEN, Object.assign({}, GOOD, { productId: 'ghost' }))); return !r.ok && r.code === 'not-found'; })());

  head('3. validPrice — strictly greater than zero');
  reset(); ck('price 1000 accepted', (await res(() => call(SELLER, SELLER_TOKEN, GOOD))).ok);
  for (const [v, label] of [[0, 'price 0'], [-5, 'price -5'], [undefined, 'price missing'], ['abc', 'price "abc"']]) {
    reset();
    const r = await res(() => call(SELLER, SELLER_TOKEN, Object.assign({}, GOOD, { price: v })));
    ck('REFUSED  ' + label, !r.ok && r.code === 'invalid-argument', r.ok ? 'ACCEPTED' : r.code);
  }
  reset();
  ck('a missing name is REFUSED',
     await (async () => { const r = await res(() => call(SELLER, SELLER_TOKEN, { price: 100 })); return !r.ok && r.code === 'invalid-argument'; })());

  head('4. noAdminFields — the served list, verbatim');
  const FORBIDDEN = ['isAdmin', 'suspended', 'banned', 'adminApproved', 'featured', 'verified',
                     'flagged', 'adminNote', 'role', 'approved', 'approvedAt', 'approvedBy', 'commissionRate'];
  let allRefused = true;
  for (const f of FORBIDDEN) {
    reset();
    const r = await res(() => call(SELLER, SELLER_TOKEN, Object.assign({}, GOOD, { [f]: true })));
    if (r.ok || r.code !== 'permission-denied') { allRefused = false; console.log('      not refused: ' + f); }
  }
  ck('all ' + FORBIDDEN.length + ' privileged fields are REFUSED', allRefused);
  ck('CONTROL — the writer\'s list matches the served ruleset\'s list exactly', (() => {
    const src = R('functions/pos-inventory-pro.js');
    return FORBIDDEN.every((f) => new RegExp("'" + f + "'").test(src.slice(src.indexOf('CANON_FORBIDDEN_FIELDS'), src.indexOf('CANON_IMAGE_FIELDS'))));
  })(), 'kept verbatim so they can be diffed');

  head('5. noBase64Image — the defect that stalled search indexing');
  for (const f of ['image', 'imageUrl', 'thumbnailUrl']) {
    reset();
    const r = await res(() => call(SELLER, SELLER_TOKEN, Object.assign({}, GOOD, { [f]: 'data:image/png;base64,AAAA' })));
    ck('REFUSED  ' + f + ' as a data: URI', !r.ok && r.code === 'invalid-argument', r.ok ? 'ACCEPTED' : r.code);
  }
  reset();
  ck('REFUSED  a data: URI inside images[]',
     await (async () => { const r = await res(() => call(SELLER, SELLER_TOKEN, Object.assign({}, GOOD, { images: ['https://ok/x.png', 'data:image/png;base64,AAAA'] }))); return !r.ok && r.code === 'invalid-argument'; })());
  reset();
  {
    const r = await res(() => call(SELLER, SELLER_TOKEN, Object.assign({}, GOOD, { image: 'https://cdn/x.png', images: ['https://cdn/x.png'] })));
    ck('a real URL is accepted', r.ok && lastProduct().image === 'https://cdn/x.png');
  }

  head('6. withinProductLimit — the guard that fails QUIETLY if forgotten');
  reset({ uid: SELLER, count: 10, maxProducts: 10 });
  {
    const r = await res(() => call(SELLER, SELLER_TOKEN, GOOD));
    ck('at count == max the create is REFUSED', !r.ok && r.code === 'resource-exhausted', r.ok ? 'CREATED' : r.code);
    ck('  ... and no product was written', !lastProduct(), String(WRITES.filter(w => w.col === 'products').length) + ' product writes');
  }
  reset({ uid: SELLER, count: 9, maxProducts: 10 });
  ck('at count == max-1 the create is allowed', (await res(() => call(SELLER, SELLER_TOKEN, GOOD))).ok);
  reset({ uid: SELLER, count: 0, maxProducts: -1 });
  ck('maxProducts -1 (unlimited) is honoured', (await res(() => call(SELLER, SELLER_TOKEN, GOOD))).ok);
  reset();
  ck('no counter document at all does not block a create (matches the rule)',
     (await res(() => call(SELLER, SELLER_TOKEN, GOOD))).ok);
  reset({ uid: SELLER, count: 3 });
  ck('a counter without maxProducts does not block (matches the rule)',
     (await res(() => call(SELLER, SELLER_TOKEN, GOOD))).ok);

  head('7. Concurrency — the MECHANISM, and what cannot be proven here');
  reset({ uid: SELLER, count: 9, maxProducts: 10 });
  {
    const r1 = await res(() => call(SELLER, SELLER_TOKEN, Object.assign({}, GOOD, { idempotencyKey: 'k1' })));
    const ctr = STORE['productCounters/' + SELLER];
    ck('the create WROTE the counter — this is what makes a concurrent create conflict',
       r1.ok && ctr && ctr.serverReserved === 1, ctr ? 'serverReserved=' + ctr.serverReserved : 'no counter write');
    const r2 = await res(() => call(SELLER, SELLER_TOKEN, Object.assign({}, GOOD, { idempotencyKey: 'k2' })));
    ck('a SECOND create at the boundary is then REFUSED (count 9 + reserved 1 = max)',
       !r2.ok && r2.code === 'resource-exhausted', r2.ok ? 'CREATED — limit bypassed' : r2.code);
    console.log('       NOTE: true contention is NOT reproducible in this harness — the emulator');
    console.log('       takes locks and production aborts on updateTime. What is asserted is the');
    console.log('       mechanism (read+write of the counter inside the transaction) and the');
    console.log('       sequential boundary. The residual is named, not hidden.');
  }

  head('8. Variable pricing is REFUSED until the sale path supports it');
  reset();
  ck('variablePrice: true is REFUSED',
     await (async () => { const r = await res(() => call(SELLER, SELLER_TOKEN, Object.assign({}, GOOD, { variablePrice: true }))); return !r.ok && r.code === 'failed-precondition'; })());
  reset();
  ck("priceMode: 'variable' is REFUSED",
     await (async () => { const r = await res(() => call(SELLER, SELLER_TOKEN, Object.assign({}, GOOD, { priceMode: 'variable' }))); return !r.ok && r.code === 'failed-precondition'; })());

  head('9. products vocabulary — NOT the posProducts one');
  reset();
  {
    await res(() => call(SELLER, SELLER_TOKEN, GOOD));
    const p = lastProduct();
    ck('stock is written (the field the till reads and deducts)', p.stock === 5, String(p.stock));
    ck('trackInventory is written (the exemption the sale path honours)', p.trackInventory === true);
    ck('outOfStock is derived', p.outOfStock === false);
    ck('NO trackStock is written', !('trackStock' in p));
    ck('NO stockQty is written', !('stockQty' in p));
    ck('NO priceMode is written', !('priceMode' in p));
  }
  reset();
  {
    await res(() => call(SELLER, SELLER_TOKEN, { name: 'Haircut', price: 300, isService: true }));
    const p = lastProduct();
    ck('a service is isService:true + trackInventory:false', p.isService === true && p.trackInventory === false);
    ck('a service carries NO stock field', !('stock' in p));
  }
  reset();
  ck('isService with trackInventory:true is REFUSED (a contradiction, not resolved)',
     await (async () => { const r = await res(() => call(SELLER, SELLER_TOKEN, { name: 'X', price: 1, isService: true, trackInventory: true })); return !r.ok && r.code === 'invalid-argument'; })());
  reset();
  ck("a non-boolean trackInventory is REFUSED, never coerced",
     await (async () => { const r = await res(() => call(SELLER, SELLER_TOKEN, Object.assign({}, GOOD, { trackInventory: 'false' }))); return !r.ok && r.code === 'invalid-argument'; })());
  reset();
  {
    await res(() => call(SELLER, SELLER_TOKEN, { name: 'Untracked', price: 10, trackInventory: false }));
    const p = lastProduct();
    ck('trackInventory:false omits stock entirely (no 0, no sentinel)', p.trackInventory === false && !('stock' in p));
  }

  head('10. Idempotency');
  reset();
  {
    const a = await res(() => call(SELLER, SELLER_TOKEN, Object.assign({}, GOOD, { idempotencyKey: 'dup-1' })));
    const b = await res(() => call(SELLER, SELLER_TOKEN, Object.assign({}, GOOD, { idempotencyKey: 'dup-1' })));
    ck('a replayed key returns the SAME product', a.ok && b.ok && a.out.productId === b.out.productId,
       a.ok && b.ok ? a.out.productId : 'failed');
    ck('and the replay reports created:false / idempotent:true', b.ok && b.out.created === false && b.out.idempotent === true);
    ck('only ONE product document was written', WRITES.filter((w) => w.col === 'products').length === 1,
       String(WRITES.filter((w) => w.col === 'products').length));
  }

  head('11. The boundary — this writer does NOT touch posProducts');
  reset();
  {
    await res(() => call(SELLER, SELLER_TOKEN, GOOD));
    ck('no posProducts write occurred', !WRITES.some((w) => w.col === 'posProducts'),
       WRITES.map((w) => w.col).join(','));
    ck('only products and productCounters were written',
       WRITES.every((w) => w.col === 'products' || w.col === 'productCounters'));
  }
  const SRC = R('functions/pos-inventory-pro.js');
  const body = SRC.slice(SRC.indexOf('exports._h.upsertCanonicalProduct'));
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  ck('CONTROL — the handler body was extracted and stripped', code.includes('shopId') && code.length > 2000, code.length + 'B');
  ck('the handler names no posProducts collection in CODE', !/collection\('posProducts'\)/.test(code));
  /* RE-POINTED: this asserted the catalogue was NOT yet wired, which was true when
     written and is the honest statement for that mutation. The catalogue was
     migrated in the following commit, so the assertion now states where it
     points — the fact worth protecting either way. */
  ck('the catalogue is wired to THIS writer, not to posUpsertProduct',
     /dispatch\('upsertCanonicalProduct'/.test(R('catalogue.html')) && !/dispatch\('posUpsertProduct'/.test(R('catalogue.html')),
     'catalogue -> upsertCanonicalProduct');
  ck('seller.js browser write is UNTOUCHED', /setDoc\(m\.doc\(db,'products',newProduct\.id\), fsProduct\)/.test(R('seller.js')),
     'no second outage introduced');

  head('12. Shape parity with the existing seller.js create');
  reset();
  {
    await res(() => call(SELLER, SELLER_TOKEN, Object.assign({}, GOOD, { description: 'd', sku: 's', unit: 'pcs' })));
    const p = lastProduct();
    for (const f of ['sellerUid', 'uid', 'shopId', 'name', 'price', 'status', 'category', 'createdAt', 'updatedAt']) {
      ck('writes ' + f, Object.prototype.hasOwnProperty.call(p, f));
    }
    ck('status defaults to active (what storefront/analytics queries filter on)', p.status === 'active');
    ck('uid mirrors sellerUid, as seller.js writes it', p.uid === p.sellerUid);
  }

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log(fail === 0
    ? '  CANONICAL WRITER CERTIFIED — not yet wired. Counter reconciliation REQUIRED before wiring.'
    : '  NOT CERTIFIED.');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\n  CRASH — not a refusal:\n  ' + (e && e.stack || e)); process.exit(1); });
