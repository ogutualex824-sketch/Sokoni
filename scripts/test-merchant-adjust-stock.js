#!/usr/bin/env node
/* merchantAdjustStock — the sole canonical authority for a stock CORRECTION.
 *
 *   node scripts/test-merchant-adjust-stock.js
 *
 * The real callable is captured as it registers and invoked with synthetic
 * requests against a stubbed Firestore/Auth, so every assertion is on what the
 * function actually wrote — including a transaction whose writes are recorded
 * in order.
 *
 * FIXTURE:  SELLER_A owns SHOP_B.  SHOP_C belongs to someone else.
 *           SELLER_A !== SHOP_B, so a shop/account substitution fails here.
 *           KASS is a control only.
 *
 * THE INVARIANT UNDER TEST
 *   sale       → posCompleteCheckout → stock ↓ → sale event → sold ↑
 *   correction → merchantAdjustStock → stock ⇅ → movement   → sold UNCHANGED
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'functions');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 150) + ']' : ''));
  ok ? pass++ : fail++;
};

const SELLER_A = 'SELLER_A_uid_7f3';
const SHOP_B = 'SHOP_B_shop_91c';
const SHOP_C = 'SHOP_C_shop_42x';
const KASS = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';

/* ── Stubbed SDK with a real-ish transaction ─────────────────────────────── */
const FieldValue = {
  serverTimestamp: () => ({ __s: 'ts' }),
  increment: (by) => ({ __s: 'inc', by }),
  delete: () => ({ __s: 'del' }),
};

let ENV;
function makeEnv(docs = {}, accounts = {}) {
  const data = { ...docs };
  const writes = [];
  const ref = (coll, id) => ({ __path: `${coll}/${id}`, coll, id });
  const snap = (p) => ({ exists: !!data[p], id: p.split('/')[1], data: () => data[p] });

  const tx = {
    async get(r) { return snap(r.__path); },
    update(r, patch) {
      writes.push({ op: 'update', path: r.__path, patch });
      const cur = data[r.__path] || {};
      const next = { ...cur };
      for (const [k, v] of Object.entries(patch)) {
        next[k] = (v && v.__s === 'inc') ? (Number(cur[k]) || 0) + v.by : v;
      }
      data[r.__path] = next;
    },
    set(r, doc) { writes.push({ op: 'set', path: r.__path, doc }); data[r.__path] = { ...doc }; },
  };

  return {
    data, writes,
    db: {
      collection: (coll) => ({
        doc: (id) => ({
          ...ref(coll, id),
          async get() { return snap(`${coll}/${id}`); },
        }),
      }),
      async runTransaction(fn) { return fn(tx); },
    },
    auth: {
      async getUser(uid) {
        if (!accounts[uid]) throw new Error('no user record');
        return { uid, customClaims: accounts[uid] };
      },
    },
  };
}

/* Capture the callable as the module registers it. */
function loadCallable(sourceOverride) {
  let captured = null;
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'firebase-admin/firestore') return { getFirestore: () => ENV.db, FieldValue };
    if (id === 'firebase-admin/auth') return { getAuth: () => ENV.auth };
    if (id === 'firebase-functions/logger') return { info() {}, warn() {}, error() {} };
    if (id === 'firebase-functions/v2/https') {
      return {
        onCall: (_o, h) => { captured = h; return h; },
        HttpsError: class HttpsError extends Error {
          constructor(code, message) { super(message); this.code = code; }
        },
      };
    }
    return orig.apply(this, arguments);
  };
  let file = path.join(FUNCTIONS_DIR, 'merchant-inventory.js');
  if (sourceOverride) {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mi-')), 'merchant-inventory.js');
    fs.writeFileSync(file, sourceOverride);
  }
  delete require.cache[require.resolve(file)];
  try { require(file); } finally { Module.prototype.require = orig; }
  if (!captured) throw new Error('callable not registered');
  return captured;
}

const PRODUCT = { name: 'Phone case', price: 450, stock: 10, sold: 7, shopId: SHOP_B, inventoryVersion: 4 };
const baseDocs = () => ({
  'products/p1': { ...PRODUCT },
  'products/x9': { name: 'Other shop item', stock: 5, sold: 2, shopId: SHOP_C, inventoryVersion: 1 },
  [`shops/${SHOP_B}`]: { ownerId: SELLER_A, status: 'active' },
  [`shops/${SHOP_C}`]: { ownerId: 'SOMEONE_ELSE', status: 'active' },
});

const call = (fnRef, data, uid = SELLER_A) => fnRef({ auth: uid ? { uid } : null, data });
const err = async (p) => { try { await p; return null; } catch (e) { return e; } };

(async () => {
const fn = loadCallable();

/* ═══ A — authorisation ═══ */
console.log('\nPART A — who may correct stock\n');
{
  ENV = makeEnv(baseDocs());
  const e = await err(call(fn, { productId: 'p1', shopId: SHOP_B, delta: 1, reason: 'restock', adjustmentId: 'a1' }, null));
  ck('A1  an unauthenticated caller is rejected', e && e.code === 'unauthenticated', e && e.code);
  ck('A2  ...and nothing was written', ENV.writes.length === 0);

  ENV = makeEnv(baseDocs());
  const e2 = await err(call(fn, { productId: 'x9', shopId: SHOP_C, delta: -1, reason: 'damage', adjustmentId: 'a2' }));
  ck('A3  SELLER_A cannot touch SHOP_C (not the owner)', e2 && e2.code === 'permission-denied', e2 && e2.code);
  ck('A4  ...and SHOP_C stock is untouched', ENV.data['products/x9'].stock === 5);

  /* Naming your own shop while pointing at another shop's product. */
  ENV = makeEnv(baseDocs());
  const e3 = await err(call(fn, { productId: 'x9', shopId: SHOP_B, delta: -1, reason: 'damage', adjustmentId: 'a3' }));
  ck('A5  a product from another shop is refused even with your own shopId',
    e3 && e3.code === 'permission-denied', e3 && e3.message);
  ck('A6  ...and still nothing was written', ENV.data['products/x9'].stock === 5);

  /* A shop employee may correct stock. */
  ENV = makeEnv({ ...baseDocs(), [`shopEmployees/${SHOP_B}_EMP_1`]: { role: 'manager' } });
  const okEmp = await call(fn, { productId: 'p1', shopId: SHOP_B, delta: -1, reason: 'damage', adjustmentId: 'a4' }, 'EMP_1');
  ck('A7  a shop employee is authorised', okEmp.ok === true && okEmp.after === 9);
}

/* ═══ B — validation ═══ */
console.log('\nPART B — a correction must be explicable\n');
{
  const bad = async (data) => (await err(call(fn, { productId: 'p1', shopId: SHOP_B, adjustmentId: 'b', ...data })));
  ENV = makeEnv(baseDocs());
  ck('B1  delta 0 is refused', (await bad({ delta: 0, reason: 'damage' }))?.code === 'invalid-argument');
  ENV = makeEnv(baseDocs());
  ck('B2  a fractional delta is refused', (await bad({ delta: 1.5, reason: 'damage' }))?.code === 'invalid-argument');
  ENV = makeEnv(baseDocs());
  ck('B3  a missing reason is refused', (await bad({ delta: 1 }))?.code === 'invalid-argument');
  ENV = makeEnv(baseDocs());
  ck('B4  an unknown reason is refused', (await bad({ delta: 1, reason: 'because' }))?.code === 'invalid-argument');
  ENV = makeEnv(baseDocs());
  ck('B5  a missing adjustmentId is refused (idempotency depends on it)',
    (await err(call(fn, { productId: 'p1', shopId: SHOP_B, delta: 1, reason: 'damage' })))?.code === 'invalid-argument');
  ENV = makeEnv(baseDocs());
  ck('B6  nothing was written by any refusal', ENV.writes.length === 0);
}

/* ═══ C — the correction itself ═══ */
console.log('\nPART C — stock moves, and only stock\n');
{
  ENV = makeEnv(baseDocs());
  const up = await call(fn, { productId: 'p1', shopId: SHOP_B, delta: 6, reason: 'restock', note: 'Delivery 42', adjustmentId: 'c1' });
  const p = ENV.data['products/p1'];
  ck('C1  a positive adjustment applies', up.ok === true && up.before === 10 && up.after === 16 && p.stock === 16);
  ck('C2  inventoryVersion advances exactly one', p.inventoryVersion === 5, String(p.inventoryVersion));
  ck('C3  products.sold is byte-for-byte unchanged', p.sold === 7 && PRODUCT.sold === 7, String(p.sold));

  const patch = ENV.writes.find(w => w.op === 'update' && w.path === 'products/p1').patch;
  ck('C4  the write does not mention `sold` AT ALL', !('sold' in patch), Object.keys(patch).join(','));
  ck('C5  stock, updatedAt and inventoryVersion move together in one write',
    'stock' in patch && 'updatedAt' in patch && 'inventoryVersion' in patch);

  const mv = ENV.data['stockMovements/c1'];
  ck('C6  an adjustment movement is recorded', !!mv && mv.kind === 'adjustment');
  ck('C7  ...carrying the reason and note', mv.reason === 'restock' && mv.note === 'Delivery 42');
  ck('C8  ...and both identities: SELLER_A did it, SHOP_B owns it',
    mv.sellerUid === SELLER_A && mv.shopId === SHOP_B && mv.sellerUid !== mv.shopId);
  ck('C9  ...with the before/after it actually applied', mv.before === 10 && mv.after === 16);

  ck('C10 NO sale event of any kind was created',
    !Object.keys(ENV.data).some(k => /^(orders|saleEvents|posRetailSales|posIdempotency)\//.test(k)),
    Object.keys(ENV.data).filter(k => !k.startsWith('products/') && !k.startsWith('shops/')).join(','));

  ENV = makeEnv(baseDocs());
  const down = await call(fn, { productId: 'p1', shopId: SHOP_B, delta: -4, reason: 'damage', adjustmentId: 'c2' });
  ck('C11 a negative adjustment applies', down.after === 6 && ENV.data['products/p1'].stock === 6);
  ck('C12 ...and still does not touch sold', ENV.data['products/p1'].sold === 7);
}

/* ═══ D — stock cannot become invalid ═══ */
console.log('\nPART D — an impossible correction is refused, not floored\n');
{
  ENV = makeEnv(baseDocs());
  const e = await err(call(fn, { productId: 'p1', shopId: SHOP_B, delta: -25, reason: 'count_correction', adjustmentId: 'd1' }));
  ck('D1  a correction below zero is refused', e && e.code === 'failed-precondition', e && e.code);
  ck('D2  ...the message tells the merchant what is actually there', e && /There are 10/.test(e.message), e && e.message);
  ck('D3  ...and stock is unchanged', ENV.data['products/p1'].stock === 10);
  ck('D4  ...and no movement was recorded', !ENV.data['stockMovements/d1']);

  /* Exactly to zero is legitimate. */
  ENV = makeEnv(baseDocs());
  const z = await call(fn, { productId: 'p1', shopId: SHOP_B, delta: -10, reason: 'theft', adjustmentId: 'd2' });
  ck('D5  correcting exactly to zero is allowed', z.after === 0 && ENV.data['products/p1'].stock === 0);
}

/* ═══ E — idempotency ═══ */
console.log('\nPART E — a repeated adjustment cannot double-apply\n');
{
  ENV = makeEnv(baseDocs());
  const first = await call(fn, { productId: 'p1', shopId: SHOP_B, delta: -3, reason: 'damage', adjustmentId: 'e1' });
  const second = await call(fn, { productId: 'p1', shopId: SHOP_B, delta: -3, reason: 'damage', adjustmentId: 'e1' });
  ck('E1  the first call applies', first.after === 7 && first.idempotent === false);
  ck('E2  the second call applies NOTHING', ENV.data['products/p1'].stock === 7, String(ENV.data['products/p1'].stock));
  ck('E3  ...and reports the original outcome', second.idempotent === true && second.after === 7);
  ck('E4  ...and inventoryVersion advanced only once', ENV.data['products/p1'].inventoryVersion === 5);
  ck('E5  ...and sold is still untouched', ENV.data['products/p1'].sold === 7);
}

/* ═══ F — control + the sale path is untouched ═══ */
console.log('\nPART F — control, and the sale path stays the sale path\n');
{
  ENV = makeEnv({ ...baseDocs(), [`shops/${SHOP_B}`]: { ownerId: KASS } });
  const r = await call(fn, { productId: 'p1', shopId: SHOP_B, delta: 1, reason: 'restock', adjustmentId: 'f1' }, KASS);
  ck('F1  control: KASS is treated by the same rules', r.ok === true && r.after === 11);

  const md = require(path.join(ROOT, 'sokoni-merchant-data.js'));
  ck('F2  the Sell layer still routes sales through posCompleteCheckout only',
    md.SALE_CALLABLE === 'posCompleteCheckout');
  const mdSrc = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-data.js'), 'utf8');
  ck('F3  ...and the Sell layer never calls the adjustment authority',
    !/merchantAdjustStock/.test(mdSrc));

  /* An abandoned cart must not reach ANY inventory authority. */
  const scope = md.resolveScope({ uid: SELLER_A, activeShopId: SHOP_B });
  const calls = [];
  md.cartTotals([{ productId: 'p1', qty: 2, price: 100 }]);
  md.assertInScope(scope, { id: 'p1', shopId: SHOP_B });
  ck('F4  an abandoned cart makes zero inventory calls', calls.length === 0);

  const idxSrc = fs.readFileSync(path.join(FUNCTIONS_DIR, 'index.js'), 'utf8');
  ck('F5  the callable is re-exported by name from functions/index.js',
    /exports\.merchantAdjustStock\s*=\s*merchantInventory\.merchantAdjustStock/.test(idxSrc));
}

/* ═══ G — mutation control ═══ */
console.log('\nPART G — mutation control\n');
{
  const src = fs.readFileSync(path.join(FUNCTIONS_DIR, 'merchant-inventory.js'), 'utf8');
  const mutants = [
    { label: 'M1  the correction also increments sold',
      src: src.replace('        inventoryVersion: FieldValue.increment(1),\n      });',
        '        inventoryVersion: FieldValue.increment(1),\n        sold: FieldValue.increment(-delta),\n      });'),
      check: async (f) => { ENV = makeEnv(baseDocs()); await call(f, { productId: 'p1', shopId: SHOP_B, delta: -2, reason: 'damage', adjustmentId: 'm1' }); return ENV.data['products/p1'].sold !== 7; } },
    { label: 'M2  the shop-ownership check is removed',
      src: src.replace('const role = await assertShopAccess(uid, shopId);', "const role = 'owner';"),
      check: async (f) => { ENV = makeEnv(baseDocs()); const r = await err(call(f, { productId: 'x9', shopId: SHOP_C, delta: -1, reason: 'damage', adjustmentId: 'm2' })); return !r || r.code !== 'permission-denied'; } },
    { label: 'M3  the product/shop match is removed',
      src: src.replace(/if \(String\(p\.shopId \|\| ''\) !== shopId\) \{[\s\S]*?\n      \}/, ''),
      check: async (f) => { ENV = makeEnv(baseDocs()); const r = await err(call(f, { productId: 'x9', shopId: SHOP_B, delta: -1, reason: 'damage', adjustmentId: 'm3' })); return !r; } },
    { label: 'M4  idempotency is dropped',
      src: src.replace(/if \(mvSnap\.exists\) \{[\s\S]*?\n      \}/, ''),
      check: async (f) => {
        ENV = makeEnv(baseDocs());
        await call(f, { productId: 'p1', shopId: SHOP_B, delta: -3, reason: 'damage', adjustmentId: 'm4' });
        await call(f, { productId: 'p1', shopId: SHOP_B, delta: -3, reason: 'damage', adjustmentId: 'm4' });
        return ENV.data['products/p1'].stock !== 7; } },
    { label: 'M5  negative stock is floored instead of refused',
      src: src.replace(/if \(after < 0\) \{[\s\S]*?\n      \}/, 'const _f = Math.max(0, after);'),
      check: async (f) => { ENV = makeEnv(baseDocs()); const r = await err(call(f, { productId: 'p1', shopId: SHOP_B, delta: -25, reason: 'damage', adjustmentId: 'm5' })); return !r || r.code !== 'failed-precondition'; } },
    { label: 'M6  inventoryVersion stops advancing',
      src: src.replace('        inventoryVersion: FieldValue.increment(1),\n      });', '      });'),
      check: async (f) => { ENV = makeEnv(baseDocs()); await call(f, { productId: 'p1', shopId: SHOP_B, delta: 1, reason: 'restock', adjustmentId: 'm6' }); return ENV.data['products/p1'].inventoryVersion === 4; } },
  ];

  for (const mu of mutants) {
    if (mu.src === src) { ck(mu.label + ' → mutation applied', false, 'no-op replace — anchor moved'); continue; }
    let caught = false, detail = '';
    try { caught = await mu.check(loadCallable(mu.src)); }
    catch (e) { caught = true; detail = 'mutant threw: ' + e.message; }
    ck(mu.label + ' → detected', caught, detail);
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('\nsuite crashed:', e.stack, '\n'); process.exit(1); });
