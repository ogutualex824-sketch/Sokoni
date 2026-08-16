#!/usr/bin/env node
/* Merchant Sell/Inventory data layer (2D-1 foundation).
 *
 *   node scripts/test-merchant-data.js
 *
 * FIXTURE — non-degenerate by construction:
 *     SELLER_A   the account   (auth.uid / sellerUid)
 *     SHOP_B     the shop      (activeShopId, products.shopId)
 *     SHOP_C     a second shop belonging to nobody in this test
 * SELLER_A !== SHOP_B, so any code substituting the account for the shop fails
 * here rather than in production. KASS is a control only.
 *
 * The acceptance chain under test:
 *   merchant loads SHOP_B products → sale created → SERVER applies inventory
 *   exactly once → the sale carries SELLER_A + SHOP_B → an abandoned cart
 *   changes nothing.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const MD = require(path.join(ROOT, 'sokoni-merchant-data.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 140) + ']' : ''));
  ok ? pass++ : fail++;
};

const SELLER_A = 'SELLER_A_uid_7f3';
const SHOP_B = 'SHOP_B_shop_91c';
const SHOP_C = 'SHOP_C_shop_42x';
const KASS = 'D5Ql2EYr95bt79IpcGTmOMTK0P83';

const CATALOGUE = [
  { id: 'p1', name: 'Airtime card', price: 100, stock: 12, shopId: SHOP_B, sku: '1234', lowStockThreshold: 5, inventoryVersion: 3 },
  { id: 'p2', name: 'Phone case', price: 450, stock: 2, shopId: SHOP_B, lowStockThreshold: 5 },
  { id: 'p3', name: 'Charger', price: 900, shopId: SHOP_B },              /* stock unknown */
  { id: 'x9', name: 'Other shop item', price: 50, stock: 5, shopId: SHOP_C },
];

/* Adapter that honours the query descriptor, so a wrong scope returns the
   wrong rows instead of silently returning everything. */
const db = {
  reads: [],
  async queryProducts(spec) {
    db.reads.push(spec);
    const [[field, , value]] = spec.where;
    return CATALOGUE.filter(p => String(p[field]) === String(value));
  },
};

const scopeOf = (uid, shop) => MD.resolveScope({ uid, activeShopId: shop });

(async () => {
/* ═══ A — identity ═══ */
console.log('\nPART A — the shop is not the account\n');
{
  const s = scopeOf(SELLER_A, SHOP_B);
  ck('A1  a resolved scope carries BOTH identifiers',
    s.ok && s.sellerUid === SELLER_A && s.shopId === SHOP_B);
  ck('A2  ...and they are different', s.sellerUid !== s.shopId);

  const noShop = scopeOf(SELLER_A, null);
  ck('A3  no active shop → NOT ok, and shopId is not back-filled from the uid',
    noShop.ok === false && noShop.reason === 'no_active_shop' && noShop.shopId === null,
    JSON.stringify(noShop));

  const anon = scopeOf(null, SHOP_B);
  ck('A4  no signed-in user → not_signed_in', anon.ok === false && anon.reason === 'not_signed_in');

  let threw = false;
  try { MD.productQuery(noShop); } catch (_) { threw = true; }
  ck('A5  an unresolved scope cannot produce a product query', threw);
}

/* ═══ B — the catalogue is the shop's ═══ */
console.log('\nPART B — merchant loads SHOP_B products\n');
{
  const scope = scopeOf(SELLER_A, SHOP_B);
  const q = MD.productQuery(scope);
  ck('B1  the query is scoped by products.shopId (the canonical field)',
    q.collection === 'products' && q.where[0][0] === 'shopId' && q.where[0][2] === SHOP_B,
    JSON.stringify(q.where));

  const rows = await MD.listProducts({ scope, db });
  ck('B2  only this shop\'s products are returned',
    rows.length === 3 && rows.every(r => r.shopId === SHOP_B) && !rows.some(r => r.id === 'x9'),
    rows.map(r => r.id).join(','));

  const charger = rows.find(r => r.id === 'p3');
  ck('B3  unknown stock is null, never 0 (0 is a real, different answer)',
    charger.stock === null && charger.lowStock === null);

  const casePhone = rows.find(r => r.id === 'p2');
  ck('B4  low stock is derived from the product threshold', casePhone.lowStock === true);
  ck('B5  a healthy line is not flagged low', rows.find(r => r.id === 'p1').lowStock === false);
  ck('B6  sku/barcode surfaces when present', rows.find(r => r.id === 'p1').sku === '1234');

  let threw = false;
  try { MD.assertInScope(scope, CATALOGUE[3]); } catch (_) { threw = true; }
  ck('B7  a product from SHOP_C cannot enter SHOP_B\'s cart', threw);
}

/* ═══ C — the sale ═══ */
console.log('\nPART C — the sale is the server\'s to apply\n');
{
  const scope = scopeOf(SELLER_A, SHOP_B);
  const cart = [
    { productId: 'p1', qty: 3, price: 100, name: 'Airtime card' },
    { productId: 'p2', qty: 1, price: 450, name: 'Phone case' },
  ];
  const sale = MD.buildSale({ scope, cart, saleToken: 'tok_1', payments: [{ method: 'mpesa', amount: 750 }] });

  ck('C1  the till is the SHOP, and the seller is recorded separately',
    sale.merchantId === SHOP_B && sale.sellerUid === SELLER_A);
  ck('C2  quantities are carried per line (not one-per-line)',
    sale.items[0].qty === 3 && sale.items[1].qty === 1);
  ck('C3  totals are computed from the cart',
    sale.subtotal === 750 && sale.grandTotal === 750, String(sale.grandTotal));
  ck('C4  the sale declares its channel', sale.channel === 'merchant_pos');

  /* Idempotency: the SAME cart retried must claim the SAME key. */
  const again = MD.buildSale({ scope, cart, saleToken: 'tok_1', payments: [] });
  ck('C5  a retry of the same sale reproduces the same idempotencyKey',
    again.idempotencyKey === sale.idempotencyKey, sale.idempotencyKey);

  const different = MD.buildSale({ scope, cart, saleToken: 'tok_2' });
  ck('C6  a NEW sale attempt gets a different key', different.idempotencyKey !== sale.idempotencyKey);

  const otherShop = MD.buildSale({ scope: scopeOf(SELLER_A, SHOP_C), cart, saleToken: 'tok_1' });
  ck('C7  the same cart in another shop is a different sale',
    otherShop.idempotencyKey !== sale.idempotencyKey);
}

/* ═══ D — exactly once, and nothing local ═══ */
console.log('\nPART D — inventory moves once, on the server, or not at all\n');
{
  const scope = scopeOf(SELLER_A, SHOP_B);
  const cart = [{ productId: 'p1', qty: 3, price: 100 }];
  const calls = [];
  const callable = async (payload) => { calls.push(payload); return { data: { ok: true, orderId: 'ord_1', receiptNo: 'R-1' } }; };

  const r = await MD.completeSale({ scope, cart, saleToken: 'tok_9', callable, payments: [{ method: 'cash', amount: 300 }] });
  ck('D1  the sale completes through the server authority', r.ok === true && r.sale.orderId === 'ord_1');
  ck('D2  posCompleteCheckout was called EXACTLY once', calls.length === 1);
  ck('D3  the payload carries the shop scope', calls[0].merchantId === SHOP_B);

  /* The decisive property: this module cannot write stock at all. */
  const src = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-data.js'), 'utf8');
  const writes = src.match(/updateDoc|setDoc|addDoc|increment\s*\(|writeBatch|runTransaction/g) || [];
  ck('D4  the module contains NO Firestore write of any kind', writes.length === 0, writes.join(','));
  ck('D5  ...and no stock/sold mutation vocabulary',
    !/stock\s*:\s*[a-zA-Z_.]*increment|sold\s*:\s*[a-zA-Z_.]*increment/.test(src));
  ck('D6  ...and no exported stock-writing function',
    !Object.keys(MD).some(k => /decrement|adjustStock|writeStock|setStock/i.test(k)),
    Object.keys(MD).join(','));

  /* A failed sale must not be dressed up, and must not "compensate" locally. */
  const failing = async () => { throw new Error('network down'); };
  const bad = await MD.completeSale({ scope, cart, saleToken: 'tok_10', callable: failing });
  ck('D7  a failed sale reports failure — no success shape, no local fallback',
    bad.ok === false && /network down/.test(bad.error));
  ck('D8  a server-side refusal is reported as a refusal',
    (await MD.completeSale({ scope, cart, saleToken: 't11', callable: async () => ({ data: { ok: false, error: 'shift closed' } }) })).ok === false);
}

/* ═══ E — abandoned cart ═══ */
console.log('\nPART E — an abandoned cart changes nothing\n');
{
  const scope = scopeOf(SELLER_A, SHOP_B);
  const calls = [];
  const callable = async (p) => { calls.push(p); return { data: { ok: true } }; };

  /* Build a cart, price it, look at it, walk away. */
  const cart = [{ productId: 'p1', qty: 2, price: 100 }];
  const totals = MD.cartTotals(cart);
  MD.assertInScope(scope, CATALOGUE[0]);
  const before = JSON.stringify(CATALOGUE);

  ck('E1  pricing a cart calls no server authority', calls.length === 0);
  ck('E2  ...and reserves nothing — the catalogue is untouched',
    JSON.stringify(CATALOGUE) === before);
  ck('E3  ...totals are still correct for the operator', totals.subtotal === 200 && totals.units === 2);

  let threw = false;
  try { MD.buildSale({ scope, cart: [], saleToken: 't' }); } catch (_) { threw = true; }
  ck('E4  an empty sale is refused rather than sent', threw);
}

/* ═══ F — control ═══ */
console.log('\nPART F — control\n');
{
  const s = MD.resolveScope({ uid: KASS, activeShopId: SHOP_B });
  ck('F1  control: KASS resolves by the same rules, no special case',
    s.ok && s.sellerUid === KASS && s.shopId === SHOP_B && s.sellerUid !== s.shopId);
}

/* ═══ G — mutation control ═══ */
console.log('\nPART G — mutation control\n');
{
  const src = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-data.js'), 'utf8');
  const mutants = [
    { label: 'M1  shopId falls back to the uid',
      src: src.replace("return { ok: false, reason: 'no_active_shop', sellerUid: String(uid), shopId: null };",
        "return { ok: true, sellerUid: String(uid), shopId: String(uid) };"),
      check: (M) => { const s = M.resolveScope({ uid: SELLER_A, activeShopId: null }); return s.shopId === s.sellerUid; } },
    { label: 'M2  the product scope drops the shop filter',
      src: src.replace("where: [[SCOPE_FIELD, '==', scope.shopId]]", 'where: []'),
      check: async (M) => {
        try { const q = M.productQuery(M.resolveScope({ uid: SELLER_A, activeShopId: SHOP_B })); return q.where.length === 0; }
        catch (_) { return true; } } },
    { label: 'M3  the idempotency key becomes time-based',
      src: src.replace("var basis = scope.shopId + '::' + token + '::' + lines;",
        "var basis = scope.shopId + '::' + token + '::' + lines + '::' + Math.random();"),
      check: (M) => {
        const scope = M.resolveScope({ uid: SELLER_A, activeShopId: SHOP_B });
        const cart = [{ productId: 'p1', qty: 1, price: 1 }];
        return M.buildSale({ scope, cart, saleToken: 'tok' }).idempotencyKey !==
               M.buildSale({ scope, cart, saleToken: 'tok' }).idempotencyKey; } },
    { label: 'M4  quantity is collapsed to one per line',
      src: src.replace('qty: Number(l.qty) || 0,', 'qty: 1,'),
      check: (M) => {
        const scope = M.resolveScope({ uid: SELLER_A, activeShopId: SHOP_B });
        return M.buildSale({ scope, cart: [{ productId: 'p1', qty: 3, price: 100 }], saleToken: 't' }).items[0].qty === 1; } },
    { label: 'M5  unknown stock is reported as 0',
      src: src.replace('var stock = (typeof p.stock === \'number\') ? p.stock : null;',
        'var stock = (typeof p.stock === \'number\') ? p.stock : 0;'),
      check: async (M) => {
        const rows = await M.listProducts({ scope: M.resolveScope({ uid: SELLER_A, activeShopId: SHOP_B }), db });
        return rows.find(r => r.id === 'p3').stock === 0; } },
  ];

  for (const mu of mutants) {
    if (mu.src === src) { ck(mu.label + ' → mutation applied', false, 'no-op replace'); continue; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-'));
    const file = path.join(dir, 'sokoni-merchant-data.js');
    fs.writeFileSync(file, mu.src);
    delete require.cache[require.resolve(file)];
    let caught = false, detail = '';
    try { caught = await mu.check(require(file)); }
    catch (e) { caught = true; detail = 'mutant threw: ' + e.message; }
    ck(mu.label + ' → detected', caught, detail);
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('\nsuite crashed:', e.stack, '\n'); process.exit(1); });
