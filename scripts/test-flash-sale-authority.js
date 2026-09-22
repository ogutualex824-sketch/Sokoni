/* ═══════════════════════════════════════════════════════════════════════════
   F-1 — FLASH SALE AUTHORITY CERTIFICATION
   scripts/test-flash-sale-authority.js

   The eleven F-1 acceptance points, executed against the real handler rather
   than read off the source. `createFlashSale` is called through the exported
   `_h` registry, so the code under test is the code that ships.

   ── WHAT F-1 IS, AND WHAT IT IS NOT ────────────────────────────────────────

   F-1 is the authority boundary ONLY:

       Flash Sale request -> _requireMerchant -> merchant identity
                          -> product ownership -> canonical posProducts
                          -> authoritative price

   It is NOT the localStorage retirement (F-2) and NOT the promotional-display
   question (F-3). This suite therefore asserts that checkout is UNCHANGED —
   including that `mktFlashSales` still has no checkout reader. F-1 must not
   quietly become the wiring it is a prerequisite for.

   ── THE INVERTING CONTROL ──────────────────────────────────────────────────

   Every refusal here is paired against the PREVIOUS predicate (`role < 2` on a
   coerced claim). A suite that only shows the new guard refusing 'buyer' cannot
   distinguish "the guard works" from "the harness never reached the guard" —
   so the old form is executed too and MUST admit 'buyer'. If the control stops
   failing, this suite has stopped testing anything.
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const Module = require('module');
const fs     = require('fs');
const path   = require('path');
const cp     = require('child_process');

const ROOT = path.join(__dirname, '..');
const R    = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
  return ok;
};
const head = t => console.log('\n' + t + '\n' + '-'.repeat(t.length));

/* ── Fake Firestore ─────────────────────────────────────────────────────────
   A flat store keyed 'collection/id'. Writes are captured so the DOCUMENT the
   handler produced can be asserted field by field — the stored price is the
   whole point of F-1, so reading it back is not optional. */
const STORE   = {};
const WRITES  = [];
const SENTINEL = '<serverTimestamp>';
let   nextId  = 0;

const docRef = (col, id) => ({
  id,
  async get() {
    const key = col + '/' + id;
    const has = Object.prototype.hasOwnProperty.call(STORE, key);
    return { exists: has, id, data: () => (has ? STORE[key] : undefined) };
  },
  async set(data) {
    STORE[col + '/' + id] = data;
    WRITES.push({ collection: col, id, data });
    return {};
  },
  async update(data) {
    STORE[col + '/' + id] = Object.assign({}, STORE[col + '/' + id], data);
    WRITES.push({ collection: col, id, data, update: true });
    return {};
  },
});

const emptyQuery = () => {
  const q = {
    where: () => q, orderBy: () => q, limit: () => q,
    async get() { return { empty: true, docs: [], size: 0 }; },
  };
  return q;
};

const fakeDb = {
  collection(col) {
    return Object.assign(emptyQuery(), {
      doc: (id) => docRef(col, id === undefined ? 'generated-' + (++nextId) : String(id)),
    });
  },
  runTransaction: async (fn) => fn({
    get: (ref) => ref.get(),
    set: (ref, d) => ref.set(d),
    update: (ref, d) => ref.update(d),
  }),
};

/* ── Load the module under test with the platform stubbed ───────────────────
   The real `firebase-admin` is never touched. `admin.firestore` is a PROTOTYPE
   GETTER on the real package and assigning to it fails silently, which is how a
   harness ends up reading production while printing "stubbed" — so a complete
   replacement object is supplied instead of a mutated real one. */
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'firebase-admin') {
    return {
      apps: [1],
      initializeApp() {},
      firestore: Object.assign(() => fakeDb, {
        FieldValue: { serverTimestamp: () => SENTINEL, increment: (n) => ({ __inc: n }) },
        Timestamp: {
          fromDate: (d) => ({ __ts: d.toISOString(), toDate: () => d }),
          now: () => ({ __ts: 'now', toDate: () => new Date() }),
        },
      }),
    };
  }
  if (request === 'firebase-functions/v2/https') {
    return {
      onCall: (_opts, handler) => handler,
      HttpsError: class HttpsError extends Error {
        constructor(code, message) { super(message); this.code = code; }
      },
    };
  }
  if (request === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (request === 'firebase-functions/params')       return { defineSecret: () => ({ value: () => '' }) };
  if (request === 'firebase-functions/logger')       return { info() {}, warn() {}, error() {}, debug() {} };
  if (request === '@anthropic-ai/sdk')               return function () { return {}; };
  return realLoad.apply(this, arguments);
};

let ENGINE = null, LOAD_ERROR = null;
try { ENGINE = require(path.join(ROOT, 'functions', 'marketing-engine.js')); }
catch (e) { LOAD_ERROR = e; }
Module._load = realLoad;

console.log('\nF-1 — FLASH SALE AUTHORITY CERTIFICATION');
console.log('='.repeat(74));

if (LOAD_ERROR || !ENGINE || !ENGINE._h || typeof ENGINE._h.createFlashSale !== 'function') {
  console.log('\n  LOAD_ERROR — the suite could not reach the handler. This says nothing');
  console.log('  about the authority; it says the ANALYZER failed.');
  console.log('  ' + (LOAD_ERROR ? LOAD_ERROR.message : 'no _h.createFlashSale export'));
  process.exit(1);
}

const createFlashSale = ENGINE._h.createFlashSale;

/* ── Fixtures ───────────────────────────────────────────────────────────── */
const OWNER  = 'uid-owner-1';
const OTHER  = 'uid-other-2';
const BIZ    = 'SOK-BIZ-001';

const reset = () => {
  for (const k of Object.keys(STORE)) delete STORE[k];
  WRITES.length = 0;
  /* Owned three ways, so each ownership spelling is exercised separately. */
  STORE['posProducts/p-sellerid']  = { name: 'Charger', price: 1000, sku: 'SKU-A', sellerId: OWNER };
  STORE['posProducts/p-ownerid']   = { name: 'Cable',   price: 500,  sku: 'SKU-B', ownerId:  OWNER };
  STORE['posProducts/p-selleruid'] = { name: 'Case',    price: 800,  sku: 'SKU-C', sellerUid: OWNER };
  STORE['posProducts/p-biz']       = { name: 'Screen',  price: 2000, sku: 'SKU-D', merchantId: BIZ };
  STORE['posProducts/p-foreign']   = { name: 'Foreign', price: 900,  sku: 'SKU-E', sellerId: OTHER };
  STORE['posProducts/p-orphan']    = { name: 'Orphan',  price: 700,  sku: 'SKU-F' };
  STORE['posProducts/p-unpriced']  = { name: 'NoPrice', sku: 'SKU-G', sellerId: OWNER };
  STORE['businesses/' + BIZ]       = { merchantId: BIZ, ownerId: OWNER };
  STORE['businesses/SOK-BIZ-OTHER'] = { merchantId: 'SOK-BIZ-OTHER', ownerId: OTHER };
  STORE['posProducts/p-biz-foreign'] = { name: 'FarShop', price: 1500, sku: 'SKU-H', merchantId: 'SOK-BIZ-OTHER' };
};

const FUTURE = new Date(Date.now() + 3600e3).toISOString();
const LATER  = new Date(Date.now() + 7200e3).toISOString();

const call = (role, uid, data) => createFlashSale({
  auth: { uid, token: role === undefined ? {} : { role } },
  data,
});

const sale = (over) => Object.assign({
  productId: 'p-sellerid', salePrice: 800, startAt: FUTURE, endAt: LATER, stockLimit: 5,
}, over);

const codeOf = async (fn) => {
  try { const r = await fn(); return { ok: true, result: r }; }
  catch (e) { return { ok: false, code: e.code || 'threw', message: e.message }; }
};

async function main() {
/* ═══ 1. _requireMerchant cannot be satisfied by a client-supplied identity ═ */
head('1-2. The role gate — and the inverting control');

/* THE CONTROL FIRST. The old predicate must ADMIT 'buyer'; if it refuses, the
   defect this suite exists to pin down is not reproducible and every PASS
   below is unanchored. */
const oldGuardAdmits = (role) => !((role ?? 0) < 2);
ck("CONTROL — the OLD predicate admits role:'buyer' (defect reproducible)",
   oldGuardAdmits('buyer') === true, "Number('buyer') is NaN; NaN < 2 is false");
ck("CONTROL — the OLD predicate admits role:'anything'",
   oldGuardAdmits('anything') === true);
ck('CONTROL — the OLD predicate refuses an absent claim',
   oldGuardAdmits(undefined) === false, 'so absence was the ONLY thing it caught');

const REFUSED = [
  ['buyer',        "role:'buyer'"],
  ['anything',     "role:'anything'"],
  ['rider',        "role:'rider'"],
  ['',             "role:''"],
  [undefined,      'absent claim'],
  [null,           'role:null'],
  [true,           'role:true'],
  [1,              'role:1 (numeric, below threshold)'],
  [0,              'role:0'],
  [NaN,            'role:NaN'],
  [Infinity,       'role:Infinity — not below 2, still not a role'],
];
for (const [role, label] of REFUSED) {
  reset();
  const r = await codeOf(() => call(role, OWNER, sale()));
  ck('REFUSED  ' + label, !r.ok && r.code === 'permission-denied', r.ok ? 'ADMITTED' : r.code);
}

const ADMITTED = [['seller', "role:'seller'"], ['merchant', "role:'merchant'"],
                  ['admin', "role:'admin'"], ['superAdmin', "role:'superAdmin'"],
                  [2, 'role:2 (legacy numeric)'], [5, 'role:5 (legacy numeric)']];
for (const [role, label] of ADMITTED) {
  reset();
  const r = await codeOf(() => call(role, OWNER, sale()));
  ck('ADMITTED ' + label, r.ok === true, r.ok ? 'created' : r.code + ' ' + r.message);
}

reset();
{
  const r = await codeOf(() => createFlashSale({ auth: null, data: sale() }));
  ck('REFUSED  unauthenticated', !r.ok && r.code === 'unauthenticated', r.code);
}

/* ═══ 3-4. Ownership is established server-side, and must MATCH ═══════════ */
head('3-4. Product ownership — server-side, and belonging to the resolved merchant');

for (const [pid, how] of [['p-sellerid', 'sellerId'], ['p-ownerid', 'ownerId'],
                          ['p-selleruid', 'sellerUid']]) {
  reset();
  const r = await codeOf(() => call('seller', OWNER, sale({ productId: pid, salePrice: 100 })));
  ck('OWNED via ' + how + ' -> accepted', r.ok === true, r.ok ? 'created' : r.code);
}

reset();
{
  const r = await codeOf(() => call('seller', OWNER, sale({ productId: 'p-biz', salePrice: 100 })));
  ck('OWNED via merchantId -> businesses.ownerId -> accepted', r.ok === true,
     r.ok ? WRITES[0].data.ownershipProvenBy : r.code);
}

reset();
{
  const r = await codeOf(() => call('seller', OWNER, sale({ productId: 'p-foreign', salePrice: 100 })));
  ck("WRONG MERCHANT'S product (sellerId=other) -> REFUSED",
     !r.ok && r.code === 'permission-denied', r.ok ? 'CREATED' : r.code);
}

reset();
{
  const r = await codeOf(() => call('seller', OWNER, sale({ productId: 'p-biz-foreign', salePrice: 100 })));
  ck("WRONG MERCHANT'S business (ownerId=other) -> REFUSED",
     !r.ok && r.code === 'permission-denied', r.ok ? 'CREATED' : r.code);
}

reset();
{
  const r = await codeOf(() => call('seller', OWNER, sale({ productId: 'p-orphan', salePrice: 100 })));
  ck('NO ownership field at all -> REFUSED (absent is UNRESOLVED, not mine)',
     !r.ok && r.code === 'failed-precondition', r.ok ? 'CREATED' : r.code);
}

reset();
{
  const r = await codeOf(() => call('seller', OWNER, sale({ productId: 'p-missing', salePrice: 100 })));
  ck('product does not exist -> REFUSED', !r.ok && r.code === 'not-found', r.code);
}

/* ═══ 5-6. Price comes from the catalogue, never from the caller ══════════ */
head('5-6. Pricing authority — canonical posProducts, not the payload');

reset();
{
  const r = await codeOf(() => call('seller', OWNER, sale({ salePrice: 800 })));
  const w = WRITES[0] && WRITES[0].data;
  ck('stored originalPrice IS the catalogue price',
     r.ok && w && w.originalPrice === 1000, w ? String(w.originalPrice) : 'no write');
  ck("priceSource recorded as 'catalogue'", !!w && w.priceSource === 'catalogue',
     w ? String(w.priceSource) : 'no write');
  ck('discountPct derived from the catalogue price', !!w && w.discountPct === 20,
     w ? String(w.discountPct) : 'no write');
}

/* THE TAMPER CASES. A caller who names a different originalPrice must not be
   able to move the stored figure in EITHER direction. */
for (const [claimed, label] of [[50, 'tampered LOW (50 vs 1000)'],
                                [100000, 'tampered HIGH (100000 vs 1000)'],
                                [999.99, 'tampered by a hair (999.99 vs 1000)']]) {
  reset();
  const r = await codeOf(() => call('seller', OWNER, sale({ originalPrice: claimed, salePrice: 40 })));
  ck('REFUSED  ' + label, !r.ok && r.code === 'aborted', r.ok ? 'CREATED' : r.code);
  ck('  ... and nothing was written', WRITES.length === 0, String(WRITES.length) + ' writes');
}

reset();
{
  const r = await codeOf(() => call('seller', OWNER, sale({ originalPrice: 1000, salePrice: 800 })));
  ck('a payload originalPrice that AGREES is accepted (and still not the authority)',
     r.ok && WRITES[0].data.originalPrice === 1000, r.ok ? 'ok' : r.code);
}

reset();
{
  const r = await codeOf(() => call('seller', OWNER, sale({ salePrice: 1000 })));
  ck('salePrice >= catalogue price -> REFUSED', !r.ok && r.code === 'invalid-argument', r.code);
}

reset();
{
  const r = await codeOf(() => call('seller', OWNER, sale({ productId: 'p-unpriced', salePrice: 10 })));
  ck('product with NO price -> REFUSED (never priced from the payload)',
     !r.ok && r.code === 'failed-precondition', r.ok ? 'CREATED' : r.code);
}

/* ═══ 7-8. Payload merchantId and sku are not authorities ════════════════ */
head('7-8. The payload cannot name the shop or the SKU');

reset();
{
  const r = await codeOf(() => call('seller', OWNER, sale({
    merchantId: 'SOK-BIZ-OTHER', sku: 'FORGED-SKU', productId: 'p-biz', salePrice: 100,
  })));
  const w = WRITES[0] && WRITES[0].data;
  ck('payload merchantId IGNORED — stored value comes from the product',
     r.ok && w && w.merchantId === BIZ, w ? String(w.merchantId) : 'no write');
  ck('payload sku IGNORED — stored value comes from the product',
     r.ok && w && w.sku === 'SKU-D', w ? String(w.sku) : 'no write');
  ck('the proven owner is recorded as sellerUid', !!w && w.sellerUid === OWNER,
     w ? String(w.sellerUid) : 'no write');
}

reset();
{
  const r = await codeOf(() => call('seller', OWNER, sale({ productId: 'p-sellerid', salePrice: 100 })));
  const w = WRITES[0] && WRITES[0].data;
  ck('unresolved business id is recorded as unresolved, NOT invented',
     r.ok && w && w.merchantId === null && w.merchantIdSource === 'unresolved',
     w ? String(w.merchantId) + '/' + String(w.merchantIdSource) : 'no write');
}

/* ═══ 9-11. Boundaries F-1 must not cross ════════════════════════════════ */
head('9-11. F-1 stays inside its boundary');

const SRC = R('functions/marketing-engine.js');

/* STRIP COMMENTS BEFORE ASSERTING. The first draft of these two checks read the
   whole file including prose, and both failed for the wrong reason: the
   `activeShopId` detector matched a COMMENT saying ownership must never use
   activeShopId, and the merchantId detector matched four OTHER functions
   (getActiveBundleDeals, getFlashSalePrice, cross-sell, upsell) that legitimately
   take a merchantId for a read. A detector that cannot tell code from prose, or
   this function from its neighbours, reports on neither. */
const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/* The createFlashSale body plus the ownership resolver it calls — the F-1
   surface, and nothing else in the file. */
const bodyOf = (name) => {
  const i = SRC.indexOf('const ' + name + ' = onCall');
  if (i < 0) return '';
  const j = SRC.indexOf('\n// ---', i);
  return decomment(SRC.slice(i, j < 0 ? SRC.length : j));
};
const fnBody = (name) => {
  const i = SRC.indexOf('async function ' + name);
  if (i < 0) return '';
  const j = SRC.indexOf('\n}', i);
  return decomment(SRC.slice(i, j < 0 ? SRC.length : j));
};
const CREATE   = bodyOf('createFlashSale');
const RESOLVER = fnBody('_resolveOwnedPosProduct');
const F1 = CREATE + '\n' + RESOLVER;

ck('CONTROL — the F-1 surface was actually extracted',
   CREATE.length > 400 && RESOLVER.length > 400,
   'create=' + CREATE.length + 'B resolver=' + RESOLVER.length + 'B');
ck('no localStorage identity introduced',
   !/localStorage|sessionStorage/.test(decomment(SRC)), 'server module, no browser storage');
ck('payload merchantId is not destructured in createFlashSale',
   !/const\s*\{[^}]*\bmerchantId\b[^}]*\}\s*=\s*req\.data/.test(CREATE), 'not read from req.data');
ck('payload sku is not destructured in createFlashSale',
   !/const\s*\{[^}]*\bsku\b[^}]*\}\s*=\s*req\.data/.test(CREATE));
ck('ownership resolves through businesses -> ownerId',
   /collection\('businesses'\)/.test(RESOLVER) && /ownerId\s*===\s*uid/.test(RESOLVER));
ck('ownership never consults activeShopId (code, not comments)',
   !/activeShopId/.test(F1), 'F-1 surface is clean');
ck('the price is read from the product document, not the request',
   /const originalPrice = product\.price/.test(CREATE) &&
   !/originalPrice\s*=\s*claimedOriginalPrice/.test(CREATE));

/* CHECKOUT UNCHANGED. Fixed-string sweep, and the positive control is that the
   sweep FINDS the readers it must find — an empty result from a broken detector
   would otherwise read as "no checkout reader". */
let refs = [];
try {
  refs = cp.execSync('git grep -l -F mktFlashSales -- "*.js" "*.html" "*.rules"',
                     { cwd: ROOT, encoding: 'utf8' })
          .split('\n').map(s => s.trim()).filter(Boolean);
} catch (_) { refs = []; }

ck('CONTROL — the sweep finds the readers it MUST find',
   refs.includes('functions/bi-advanced.js') && refs.includes('functions/marketing-engine.js'),
   refs.length + ' files');

const CHECKOUT = ['checkout.html', 'pos.js', 'pos.html', 'functions/payment-orchestrator.js',
                  'functions/pos-checkout.js', 'script.js'];
const leaked = refs.filter(f => CHECKOUT.includes(f));
ck('no checkout / till / orchestrator file reads mktFlashSales (F-1 wires nothing)',
   leaked.length === 0, leaked.join(',') || 'none');

/* F-2 must remain untouched: the localStorage rail is still there, and F-1 did
   not start retiring it. Asserting its PRESENCE is what keeps the units
   separate — a suite that let F-2 happen quietly would report progress for the
   wrong reason. */
let lsWriters = [];
try {
  lsWriters = cp.execSync('git grep -l -F "localStorage.setItem(\'sokoniFlashSales" -- "*.js" "*.html"',
                          { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
} catch (_) { lsWriters = []; }
let lsAll = [];
try {
  lsAll = cp.execSync('git grep -l -F sokoniFlashSales -- "*.js" "*.html"',
                      { cwd: ROOT, encoding: 'utf8' }).split('\n').map(s => s.trim()).filter(Boolean);
} catch (_) { lsAll = []; }
ck('F-2 NOT started — the localStorage rail is still present and untouched',
   lsAll.length >= 6, lsAll.length + ' files still reference sokoniFlashSales');
ck("F-2 NOT started — flash-sale route is still kind:'seller'",
   /id:'flash-sale'[\s\S]{0,120}kind:'seller'/.test(R('sokoni-merchant-routes.js')),
   'route flip belongs to F-2');

console.log('\n' + '='.repeat(74));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log(fail === 0
  ? '  F-1 CERTIFIED — authority boundary holds. F-2 and F-3 remain open.'
  : '  F-1 NOT CERTIFIED.');
process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
