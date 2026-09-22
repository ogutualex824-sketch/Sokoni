/* ═══════════════════════════════════════════════════════════════════════════
   3B — posListProducts, THE SERVER-SIDE CATALOGUE READ (Option A)
   scripts/test-poslistproducts-contract.js

   Option A was chosen so that `posProducts` stays CLOSED to browsers for both
   reads and writes. This suite executes the real handler through the exported
   `_h` registry and asserts the contract the owner specified:

       explicit merchantId · the same _assertMerchantAccess chain as the writer
       deterministic ordering · explicit hard page cap · cursor pagination
       no unbounded reads · empty distinguished from failure · no rules grant

   ── THE FAKE QUERY IS REAL ENOUGH TO CATCH THE ORDERING TRAP ───────────────
   Firestore OMITS documents that lack the field being ordered on. The fake below
   reproduces that, because it is the whole reason the op orders by document id:
   `nameLower` is written by `posUpsertProduct` and by nothing else, so ordering
   on it would silently hide rows from other writers. A fake that returned them
   anyway would let that defect through.
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const Module = require('module');
const fs     = require('fs');
const path   = require('path');
const cp     = require('child_process');

const ROOT = path.join(__dirname, '..');
const R    = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; return ok; };
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(t.length));

/* ── Fake Firestore with a query engine ─────────────────────────────────── */
const STORE = {};
const DOCID = '__name__';

const makeQuery = (col, state) => {
  const st = Object.assign({ wheres: [], order: null, lim: null, after: null }, state);
  const api = {
    where: (f, op, v) => makeQuery(col, Object.assign({}, st, { wheres: st.wheres.concat([[f, op, v]]) })),
    orderBy: (f) => makeQuery(col, Object.assign({}, st, { order: f })),
    limit: (n) => makeQuery(col, Object.assign({}, st, { lim: n })),
    startAfter: (v) => makeQuery(col, Object.assign({}, st, { after: v })),
    async get() {
      let rows = Object.keys(STORE)
        .filter((k) => k.startsWith(col + '/'))
        .map((k) => ({ id: k.slice(col.length + 1), data: STORE[k] }));

      for (const [f, op, v] of st.wheres) {
        rows = rows.filter((r) => (op === '==' ? r.data[f] === v : true));
      }
      if (st.order && st.order !== DOCID) {
        /* Firestore behaviour: a document missing the ordered field is EXCLUDED. */
        rows = rows.filter((r) => r.data[st.order] !== undefined);
        rows.sort((a, b) => String(a.data[st.order]).localeCompare(String(b.data[st.order])));
      } else {
        rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      }
      if (st.after !== null && st.after !== undefined) {
        const cut = rows.findIndex((r) => r.id === st.after);
        rows = cut >= 0 ? rows.slice(cut + 1) : [];
      }
      if (st.lim !== null) rows = rows.slice(0, st.lim);
      return {
        empty: rows.length === 0,
        size: rows.length,
        docs: rows.map((r) => ({ id: r.id, exists: true, data: () => r.data })),
      };
    },
  };
  return api;
};

const fakeDb = {
  collection(col) {
    return Object.assign(makeQuery(col, {}), {
      doc: (id) => ({
        id: id || 'auto',
        async get() {
          const key = col + '/' + id;
          const has = Object.prototype.hasOwnProperty.call(STORE, key);
          return { exists: has, id, data: () => (has ? STORE[key] : undefined) };
        },
        async set() { return {}; },
      }),
    });
  },
  runTransaction: async (fn) => fn({ get: (r) => r.get(), set: () => {}, update: () => {} }),
};

const realLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin') {
    return {
      apps: [1], initializeApp() {},
      firestore: Object.assign(() => fakeDb, {
        FieldValue: { serverTimestamp: () => '<ts>', increment: (n) => n, delete: () => '<del>' },
        Timestamp: { fromDate: (d) => ({ __ts: d.toISOString() }), now: () => ({}) },
        FieldPath: { documentId: () => DOCID },
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
  if (request === './business-bootstrap') {
    /* The REAL guard is replaced, but driven from the seeded businesses, so the
       ownership CHAIN (uid -> businesses/{id}.ownerId) is still what decides —
       and the suite fails if the op stops calling it. */
    return {
      _assertMerchantAccess: async (req, merchantId) => {
        const uid = req && req.auth && req.auth.uid;
        const biz = STORE['businesses/' + merchantId];
        if (!biz) { const e = new Error('Business not found'); e.code = 'not-found'; throw e; }
        if (biz.ownerId !== uid) { const e = new Error('Access denied.'); e.code = 'permission-denied'; throw e; }
        return uid;
      },
    };
  }
  return realLoad.apply(this, arguments);
};

let MOD = null, LOAD_ERROR = null;
try { MOD = require(path.join(ROOT, 'functions', 'pos-inventory-pro.js')); }
catch (e) { LOAD_ERROR = e; }
Module._load = realLoad;

console.log('\n3B — posListProducts (SERVER-SIDE CATALOGUE READ)');
console.log('='.repeat(74));

if (LOAD_ERROR || !MOD || !MOD._h || typeof MOD._h.posListProducts !== 'function') {
  console.log('\n  LOAD_ERROR — could not reach the handler; this says the ANALYZER failed.');
  console.log('  ' + (LOAD_ERROR ? LOAD_ERROR.message : 'no _h.posListProducts export'));
  process.exit(1);
}
const list = MOD._h.posListProducts;

const OWNER = 'uid-owner-1', OTHER = 'uid-other-2';
const BIZ = 'SOK-BIZ-001', BIZ2 = 'SOK-BIZ-002';

const reset = (n, opts) => {
  for (const k of Object.keys(STORE)) delete STORE[k];
  STORE['businesses/' + BIZ]  = { ownerId: OWNER };
  STORE['businesses/' + BIZ2] = { ownerId: OTHER };
  const o = opts || {};
  for (let i = 0; i < (n || 0); i++) {
    const id = 'p' + String(i).padStart(3, '0');
    const row = { name: 'Item ' + i, price: 100 + i, merchantId: BIZ, active: true };
    if (!o.noNameLower) row.nameLower = ('item ' + i);
    STORE['posProducts/' + id] = row;
  }
};
const call = (uid, data) => list({ auth: { uid, token: { posRole: 'owner', role: 'owner' } }, data });
const res = async (fn) => {
  try { return { ok: true, out: await fn() }; }
  catch (e) { return { ok: false, code: e.code || 'threw', message: e.message }; }
};

async function main() {
  head('1. Ownership — the same chain as the canonical writer');
  reset(3);
  ck('the owner can list', (await res(() => call(OWNER, { merchantId: BIZ }))).ok);
  ck('another uid is REFUSED',
     await (async () => { const r = await res(() => call(OTHER, { merchantId: BIZ })); return !r.ok && r.code === 'permission-denied'; })());
  ck('cross-business is REFUSED',
     await (async () => { const r = await res(() => call(OWNER, { merchantId: BIZ2 })); return !r.ok && r.code === 'permission-denied'; })());
  ck('an unknown business is REFUSED',
     await (async () => { const r = await res(() => call(OWNER, { merchantId: 'SOK-NOPE' })); return !r.ok; })());
  ck('a missing merchantId is REFUSED (never defaulted)',
     await (async () => { const r = await res(() => call(OWNER, {})); return !r.ok && r.code === 'invalid-argument'; })());
  ck('unauthenticated is REFUSED',
     await (async () => { const r = await res(() => list({ auth: null, data: { merchantId: BIZ } })); return !r.ok; })());

  head('2. Scope — only this merchant\'s rows');
  reset(2);
  STORE['posProducts/zz-foreign'] = { name: 'Foreign', price: 1, merchantId: BIZ2, active: true };
  {
    const r = await res(() => call(OWNER, { merchantId: BIZ }));
    ck('a foreign row is not returned',
       r.ok && r.out.products.every((p) => p.merchantId === BIZ), r.ok ? r.out.count + ' rows' : r.code);
  }

  head('3. Empty is a SUCCESS, not an error');
  reset(0);
  {
    const r = await res(() => call(OWNER, { merchantId: BIZ }));
    ck('an empty catalogue returns ok', r.ok && r.out.ok === true);
    ck('and says empty: true', r.ok && r.out.empty === true && r.out.count === 0);
    ck('and carries no cursor', r.ok && r.out.nextCursor === null);
  }

  head('4. Bounded by construction — the cap is the SERVER\'s');
  reset(300);
  {
    /* REFUSED, not clamped — and that is the deliberate choice. Clamping would
       silently hand back less than was asked for, and a caller that believed it
       had 5,000 rows would conclude the catalogue ended at 200. The stricter
       answer is to reject the request, which is also this codebase's habit:
       refuse rather than quietly alter. What must hold either way is that NO
       accepted value produces an unbounded read. */
    const r = await res(() => call(OWNER, { merchantId: BIZ, pageSize: 5000 }));
    ck('an oversized pageSize is REFUSED, never honoured',
       !r.ok && r.code === 'invalid-argument', r.ok ? 'returned ' + r.out.count : r.code);
    const atMax = await res(() => call(OWNER, { merchantId: BIZ, pageSize: 200 }));
    ck('the largest ACCEPTED page is the cap, and it is honoured exactly',
       atMax.ok && atMax.out.count === 200 && atMax.out.pageSize === 200,
       atMax.ok ? String(atMax.out.count) : atMax.code);
    const overByOne = await res(() => call(OWNER, { merchantId: BIZ, pageSize: 201 }));
    ck('one above the cap is REFUSED (the boundary is exact)',
       !overByOne.ok && overByOne.code === 'invalid-argument', overByOne.ok ? 'accepted' : overByOne.code);
    const d = await res(() => call(OWNER, { merchantId: BIZ }));
    ck('the default page is 100', d.ok && d.out.count === 100, d.ok ? String(d.out.count) : d.code);
    const neg = await res(() => call(OWNER, { merchantId: BIZ, pageSize: -5 }));
    ck('a negative pageSize is refused or clamped, never unbounded',
       !neg.ok || neg.out.count <= 200, neg.ok ? String(neg.out.count) : neg.code);
  }

  head('5. Cursor pagination — total order, no gaps, no repeats');
  reset(250);
  {
    const p1 = await res(() => call(OWNER, { merchantId: BIZ, pageSize: 100 }));
    const p2 = await res(() => call(OWNER, { merchantId: BIZ, pageSize: 100, cursor: p1.out.nextCursor }));
    const p3 = await res(() => call(OWNER, { merchantId: BIZ, pageSize: 100, cursor: p2.out.nextCursor }));
    ck('page 1 is full and offers a cursor', p1.ok && p1.out.count === 100 && !!p1.out.nextCursor);
    ck('page 2 is full and offers a cursor', p2.ok && p2.out.count === 100 && !!p2.out.nextCursor);
    ck('page 3 is SHORT and ends the walk', p3.ok && p3.out.count === 50 && p3.out.nextCursor === null,
       p3.ok ? p3.out.count + ' rows' : p3.code);
    const ids = [].concat(p1.out.products, p2.out.products, p3.out.products).map((x) => x.id);
    ck('every row appears exactly once across pages', new Set(ids).size === 250, new Set(ids).size + ' unique');
    ck('all 250 rows were reachable', ids.length === 250);
    const sorted = ids.slice().sort();
    ck('the order is deterministic (ascending document id)', JSON.stringify(ids) === JSON.stringify(sorted));
  }

  head('6. THE ORDERING TRAP — rows from other writers must not vanish');
  reset(5, { noNameLower: true });      /* rows as another writer would leave them */
  {
    const r = await res(() => call(OWNER, { merchantId: BIZ }));
    ck('rows WITHOUT nameLower are still returned (ordering is by document id)',
       r.ok && r.out.count === 5, r.ok ? r.out.count + '/5' : r.code);
  }
  {
    /* CONTROL: the fake really does drop rows when ordering on a missing field,
       so the assertion above is testing something. */
    const q = fakeDb.collection('posProducts').where('merchantId', '==', BIZ).orderBy('nameLower');
    const snap = await q.get();
    ck('CONTROL — ordering on the absent field DOES drop them in the fake',
       snap.size === 0, snap.size + ' rows survived');
  }

  head('7. Archived rows are included — the read answers the page\'s question');
  reset(2);
  STORE['posProducts/p900'] = { name: 'Archived', price: 5, merchantId: BIZ, active: false };
  {
    const r = await res(() => call(OWNER, { merchantId: BIZ }));
    ck('an inactive row is returned (no active filter)',
       r.ok && r.out.products.some((p) => p.active === false), r.ok ? r.out.count + ' rows' : r.code);
  }

  head('8. The boundary — no rules grant, no direct client access');
  const HTML = R('catalogue.html');
  const CODE = HTML.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  /* RE-POINTED. This suite certifies the OP, and the op is unchanged. What changed
     is its caller: the catalogue moved to `products` (canonical) and therefore to
     listCanonicalProducts, so posListProducts now has ZERO client callers and
     remains available for the POS inventory domain it was built for. A deployed op
     with no caller is a fact worth asserting, not a failure. */
  ck('CONTROL — catalogue.html read and stripped', CODE.length > 8000, CODE.length + 'B');
  ck('posListProducts has no client caller now (the catalogue reads canonical products)',
     !/dispatch\('posListProducts'/.test(CODE) && /dispatch\('listCanonicalProducts'/.test(CODE),
     'POS-domain op, retained');
  ck('no direct posProducts read remains in the page',
     !/getDocs\s*\(\s*query\s*\(\s*collection\s*\(\s*db\s*,\s*'posProducts'/.test(CODE));
  ck('no direct posProducts write remains in the page',
     !/(setDoc|addDoc|updateDoc)\s*\(\s*doc\s*\(\s*db\s*,\s*['"]posProducts/.test(CODE));
  ck('the page pages until the cursor is exhausted', /nextCursor/.test(CODE) && /while\(true\)/.test(CODE));
  ck('a truncated walk is RECORDED, not hidden', /truncated/.test(CODE));
  ck('no firestore rules file was touched by this unit', (() => {
    try {
      const out = cp.execSync('git status --porcelain firestore.rules firestore.rules.build', { cwd: ROOT, encoding: 'utf8' });
      return out.trim() === '';
    } catch (_) { return false; }
  })(), 'rules untouched');
  ck('no caching was introduced in this unit',
     !/bootstrapCache/.test(R('functions/pos-inventory-pro.js').slice(
       R('functions/pos-inventory-pro.js').indexOf('exports._h.posListProducts'),
       R('functions/pos-inventory-pro.js').indexOf('exports._h.posDeleteProduct'))),
     'reads live data');

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log(fail === 0
    ? '  3B CERTIFIED — posProducts stays closed to browsers; the catalogue reads through the server.'
    : '  3B NOT CERTIFIED.');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\n  CRASH — not a refusal:\n  ' + (e && e.stack || e)); process.exit(1); });
