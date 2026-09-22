/* ═══════════════════════════════════════════════════════════════════════════
   PRODUCT COUNTER RECONCILIATION — the serverReserved lifecycle
   scripts/test-product-counter-reconciliation.js

   `upsertCanonicalProduct` reserves against `productCounters/{uid}` so two
   concurrent server creates cannot both pass at count = max-1. The reservation
   covers ONE window: product committed -> `count` incremented by the trigger.
   Without reconciliation the product is then counted twice and the merchant's
   allowance shrinks permanently.

   THE INVARIANT THIS CERTIFIES

       count           products/{id} with sellerUid == uid   (recount = authority)
       serverReserved  server creates COMMITTED but not yet counted.
                       Transient. Floor 0. NEVER entitlement debt.
       usage           count + serverReserved

   WHAT IS NOT PROVEN HERE: true concurrent contention. A fake transaction cannot
   reproduce Firestore's conflict detection; the emulator takes locks and
   production aborts on updateTime. What is asserted is that the MECHANISM is
   intact (the writer still reads and writes the counter) and that the lifecycle
   is arithmetically correct. The residual is named, never implied away.
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

/* ── Fake Firestore ──────────────────────────────────────────────────────── */
const STORE = {};
const WRITES = [];
const INC = (n) => ({ __inc: n });
let autoId = 0;
let COUNT_AGG = 0;

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
});
const fakeDb = {
  collection(col) {
    const q = {
      where: () => q, orderBy: () => q, limit: () => q,
      async get() { return { empty: true, docs: [] }; },
      count: () => ({ async get() { return { data: () => ({ count: COUNT_AGG }) }; } }),
    };
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

const stubAdmin = {
  apps: [1], initializeApp() {},
  firestore: Object.assign(() => fakeDb, {
    FieldValue: { serverTimestamp: () => '<ts>', increment: INC, delete: () => '<del>' },
    Timestamp: { fromDate: (x) => ({ __ts: x }), now: () => ({}) },
    FieldPath: { documentId: () => '__name__' },
  }),
};

/* Captured trigger handlers, so the real trigger body can be EXECUTED. */
const TRIGGERS = {};
const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin') return stubAdmin;
  if (request === 'firebase-functions/v2/firestore') {
    return {
      onDocumentCreated: (o, h) => { TRIGGERS.created = h; return { __t: 'created', o }; },
      onDocumentDeleted: (o, h) => { TRIGGERS.deleted = h; return { __t: 'deleted', o }; },
      onDocumentWritten: (o, h) => { TRIGGERS.written = h; return { __t: 'written', o }; },
    };
  }
  if (request === 'firebase-functions/v2/https') {
    return { onCall: (_o, h) => h, HttpsError: class extends Error { constructor(c, m) { super(m); this.code = c; } } };
  }
  if (request === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (request === 'firebase-functions/params') return { defineSecret: () => ({ value: () => '' }) };
  if (request === 'firebase-functions/logger') return { info() {}, warn() {}, error() {} };
  if (request === './subscription-catalog') return { entitlementFor: () => ({ listingLimit: 10, subscriptionStatus: 'free', source: 'stub', catalogVersion: 1 }) };
  if (request === './subscription-core') return { resolveSubscription: async () => ({ status: 'free', limits: {} }) };
  if (request === './business-bootstrap') return { _assertMerchantAccess: async () => true };
  return realLoad.apply(this, arguments);
};

let LIMIT = null, WRITER = null, LOAD_ERROR = null;
try {
  LIMIT  = require(path.join(ROOT, 'functions', 'product-limit.js'));
  WRITER = require(path.join(ROOT, 'functions', 'pos-inventory-pro.js'));
} catch (e) { LOAD_ERROR = e; }
Module._load = realLoad;

console.log('\nPRODUCT COUNTER RECONCILIATION — serverReserved lifecycle');
console.log('='.repeat(74));

if (LOAD_ERROR || !TRIGGERS.created || !TRIGGERS.deleted || !WRITER || !WRITER._h.upsertCanonicalProduct) {
  console.log('\n  LOAD_ERROR — the ANALYZER failed, not the code.');
  console.log('  ' + (LOAD_ERROR ? LOAD_ERROR.message : 'triggers or writer not captured'));
  process.exit(1);
}

const SELLER = 'uid-seller-1';
const CK = 'productCounters/' + SELLER;
const counter = () => STORE[CK] || {};
const reset = (c) => { for (const k of Object.keys(STORE)) delete STORE[k]; WRITES.length = 0; if (c) STORE[CK] = c; };

const create = (data) => WRITER._h.upsertCanonicalProduct({
  auth: { uid: SELLER, token: { seller: true } },
  data: Object.assign({ name: 'P', price: 100 }, data),
});
const fireCreated = (sellerUid) => TRIGGERS.created({ data: { data: () => ({ sellerUid: sellerUid || SELLER }) } });
const fireDeleted = (sellerUid) => TRIGGERS.deleted({ data: { data: () => ({ sellerUid: sellerUid || SELLER }) } });
const res = async (fn) => { try { return { ok: true, out: await fn() }; } catch (e) { return { ok: false, code: e.code || 'threw', message: e.message }; } };

async function main() {
  head('0. CONTROL — the real trigger bodies were captured and are executable');
  ck('onMarketplaceProductCreated captured', typeof TRIGGERS.created === 'function');
  ck('onMarketplaceProductDeleted captured', typeof TRIGGERS.deleted === 'function');
  reset({ uid: SELLER, count: 5, maxProducts: 10 });
  await fireCreated();
  ck('CONTROL — the create trigger still increments count', counter().count === 6, String(counter().count));

  head('1. A successful server create consumes ONE unit, not two');
  reset({ uid: SELLER, count: 0, maxProducts: 10 });
  {
    const r = await res(() => create({ idempotencyKey: 'a' }));
    ck('the writer reserved', r.ok && counter().serverReserved === 1, 'reserved=' + counter().serverReserved);
    await fireCreated();
    ck('the trigger counted it', counter().count === 1, 'count=' + counter().count);
    ck('and CLEARED the reservation', counter().serverReserved === 0, 'reserved=' + counter().serverReserved);
    ck('usage is 1, not 2 — no permanent entitlement debt',
       counter().count + counter().serverReserved === 1,
       'usage=' + (counter().count + counter().serverReserved));
  }

  head('2. Ten server creates against a limit of ten — the drift case');
  reset({ uid: SELLER, count: 0, maxProducts: 10 });
  {
    let made = 0;
    for (let i = 0; i < 10; i++) {
      const r = await res(() => create({ idempotencyKey: 'k' + i }));
      if (r.ok) { made++; await fireCreated(); }
    }
    ck('all TEN creates succeeded (before reconciliation only five would)', made === 10, made + '/10');
    ck('count is 10, reserved is 0', counter().count === 10 && counter().serverReserved === 0,
       'count=' + counter().count + ' reserved=' + counter().serverReserved);
    const over = await res(() => create({ idempotencyKey: 'k10' }));
    ck('the ELEVENTH is REFUSED — the cap still holds', !over.ok && over.code === 'resource-exhausted', over.ok ? 'CREATED' : over.code);
  }

  head('3. A refused create consumes NOTHING');
  reset({ uid: SELLER, count: 10, maxProducts: 10 });
  {
    const r = await res(() => create({ idempotencyKey: 'x' }));
    ck('the create was refused', !r.ok && r.code === 'resource-exhausted', r.code);
    ck('no reservation was left behind', !counter().serverReserved, 'reserved=' + (counter().serverReserved || 0));
    ck('count was not touched', counter().count === 10, String(counter().count));
    ck('and no product document was written', !WRITES.some((w) => w.col === 'products'));
  }

  head('4. A browser create is unchanged, and cannot mine a reservation into the negative');
  reset({ uid: SELLER, count: 3, maxProducts: 10 });
  await fireCreated();
  ck('count increments as before', counter().count === 4, String(counter().count));
  ck('serverReserved is NOT driven negative', (counter().serverReserved || 0) >= 0,
     'reserved=' + (counter().serverReserved === undefined ? 'absent' : counter().serverReserved));
  reset({ uid: SELLER, count: 3, maxProducts: 10, serverReserved: 0 });
  await fireCreated();
  ck('an existing zero reservation stays zero (floored, not decremented)',
     counter().serverReserved === 0, String(counter().serverReserved));

  head('5. A browser create MAY consume a concurrent reservation — total stays right');
  reset({ uid: SELLER, count: 0, maxProducts: 10 });
  {
    await res(() => create({ idempotencyKey: 'srv' }));      /* reserved = 1 */
    await fireCreated();                                      /* browser product counted first */
    await fireCreated();                                      /* the server product's own trigger */
    ck('two products, two counts, no reservation left',
       counter().count === 2 && counter().serverReserved === 0,
       'count=' + counter().count + ' reserved=' + counter().serverReserved);
  }

  head('6. Delete releases exactly one unit, and never touches the reservation');
  reset({ uid: SELLER, count: 5, maxProducts: 10, serverReserved: 1 });
  await fireDeleted();
  ck('count decremented by exactly one', counter().count === 4, String(counter().count));
  ck('the reservation is untouched by a delete', counter().serverReserved === 1, String(counter().serverReserved));

  head('7. The recount is the reconciliation AUTHORITY');
  reset({ uid: SELLER, count: -23, maxProducts: 10, serverReserved: 4 });
  COUNT_AGG = 103;                                            /* the real, measured drift case */
  {
    const recount = LIMIT.recountMarketplaceProducts;
    const r = await res(() => recount({ auth: { uid: SELLER, token: {} }, data: {} }));
    ck('a recount from source repairs a negative count', r.ok && counter().count === 103, 'count=' + counter().count);
    ck('and clears outstanding reservations', counter().serverReserved === 0, 'reserved=' + counter().serverReserved);
  }

  head('8. canPublishProduct answers from usage, not from count alone');
  reset({ uid: SELLER, count: 9, maxProducts: 10, serverReserved: 1 });
  {
    const out = await LIMIT.canPublishProduct({ auth: { uid: SELLER, token: {} }, data: {} });
    ck('an outstanding reservation makes the advisory say NO', out.allowed === false, 'allowed=' + out.allowed);
    ck('used = count + reserved', out.used === 10, 'used=' + out.used);
    ck('remaining is 0, not 1', out.remaining === 0, 'remaining=' + out.remaining);
    ck('count keeps its old meaning for existing callers', out.count === 9, 'count=' + out.count);
  }
  reset({ uid: SELLER, count: 9, maxProducts: 10 });
  {
    const out = await LIMIT.canPublishProduct({ auth: { uid: SELLER, token: {} }, data: {} });
    ck('with no reservation the answer is unchanged from before', out.allowed === true && out.remaining === 1,
       'allowed=' + out.allowed + ' remaining=' + out.remaining);
  }
  reset({ uid: SELLER, count: 50, maxProducts: -1, serverReserved: 3 });
  {
    const out = await LIMIT.canPublishProduct({ auth: { uid: SELLER, token: {} }, data: {} });
    ck('unlimited is still unlimited', out.allowed === true && out.unlimited === true);
  }

  head('9. The concurrency MECHANISM is still intact');
  reset({ uid: SELLER, count: 9, maxProducts: 10 });
  {
    await res(() => create({ idempotencyKey: 'c1' }));
    ck('the create still WRITES the counter (what makes a concurrent create conflict)',
       WRITES.some((w) => w.col === 'productCounters'), 'counter written inside the transaction');
    const second = await res(() => create({ idempotencyKey: 'c2' }));
    ck('a second create before the trigger fires is REFUSED',
       !second.ok && second.code === 'resource-exhausted', second.ok ? 'CREATED — limit bypassed' : second.code);
    console.log('       NOTE: true contention remains UNPROVEN here. A fake transaction cannot');
    console.log('       reproduce Firestore conflict detection, the emulator takes locks, and');
    console.log('       production aborts on updateTime. Mechanism + arithmetic are asserted.');
  }

  head('10. The stated residual, asserted so it cannot be forgotten');
  const SRC = R('functions/product-limit.js');
  ck('rules are NOT consulted for serverReserved (documented, not silently assumed)',
     /serverReserved` is not read by\s*\n?\s*\* *rules|not read by rules|rules cannot be changed in this mutation/.test(SRC),
     'browser creates still gate on count alone');
  ck('the reservation is written ABSOLUTELY, never as increment(-1)',
     /patch\.serverReserved = held - 1/.test(SRC) && !/serverReserved: F\.increment\(-1\)/.test(SRC));
  ck('no Firestore rules file was touched', (() => {
    try { return require('child_process').execSync('git status --porcelain firestore.rules firestore.rules.build', { cwd: ROOT, encoding: 'utf8' }).trim() === ''; }
    catch (_) { return false; }
  })());
  ck('the catalogue is still NOT wired to the canonical writer',
     !/upsertCanonicalProduct/.test(R('catalogue.html')), 'wiring remains a separate mutation');

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log(fail === 0
    ? '  RECONCILED — a server create now consumes exactly one unit. Wiring is still separate.'
    : '  NOT RECONCILED.');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\n  CRASH — not a refusal:\n  ' + (e && e.stack || e)); process.exit(1); });
