/* Product specifications — one shape for every category.
 *
 *   node scripts/test-product-specs.js
 *
 * The failure this guards against is a schema per category, which becomes a product
 * database per category, after which search, filters, inventory and POS each have to know
 * which one they are addressing. So the assertions below are mostly about what the model
 * REFUSES to do: invent a unit, trust a stock figure it can also derive, or drop a spec it
 * did not anticipate.
 */
'use strict';
const path = require('path');
const S = require(path.join(__dirname, '..', 'sokoni-product-specs.js'));

let pass = 0, fail = 0;
const ok = (c, label, detail) => {
  if (c) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
};

/* ── 1. UNITS ─────────────────────────────────────────────────────────────── */
console.log('\n1. Units are canonical, and an unknown one is refused rather than guessed');
ok(S.canonicalUnit('weight', 'kgs') === 'kg', 'a merchant typing "kgs" resolves to kg');
ok(S.canonicalUnit('weight', 'Kilos') === 'kg', '"Kilos" resolves to kg (case-insensitive)');
ok(S.canonicalUnit('length', 'miles') === 'mi', '"miles" resolves to mi');
ok(S.canonicalUnit('volume', 'litre') === 'l', '"litre" resolves to l');
/* The converse is the point: guessing a unit silently changes a quantity. */
ok(S.canonicalUnit('weight', 'furlongs') === null, 'an unrecognised unit returns null, not a guess');
ok(S.canonicalUnit('weight', 'cm') === null, 'a unit from the WRONG dimension is refused');

console.log('\n2. Measurements carry a comparable base');
const w = S.measure('weight', 2, 'kg');
ok(w.v === 2 && w.u === 'kg', 'the merchant\'s own value and unit are preserved');
ok(w.base === 2000 && w.baseUnit === 'g', '2 kg normalises to 2000 g for comparison');
const mi = S.measure('length', 1, 'mi');
ok(mi.base === 1609344, '1 mi normalises to 1609344 mm');
/* Mixed units must sort correctly — that is the whole reason base exists. */
const mixed = [S.measure('weight', 500, 'g'), S.measure('weight', 2, 'kg'), S.measure('weight', 1, 'kg')];
ok(mixed.slice().sort((a, b) => a.base - b.base).map(m => m.v + m.u).join(',') === '500g,1kg,2kg',
   'mixed units sort correctly by base');

/* ── 3. CATEGORY SUGGESTIONS ──────────────────────────────────────────────── */
console.log('\n3. Category suggestions — a car does not get a meaningless "size"');
const veh = S.suggestionsFor('vehicles').map(s => s.key);
ok(veh.includes('mileage') && veh.includes('engineCapacity') && veh.includes('vin'),
   'vehicles suggest mileage, engine capacity and VIN');
ok(S.suggestionsFor('cars').length === S.suggestionsFor('vehicles').length,
   '"cars" aliases to the vehicles set');
const el = S.suggestionsFor('electronics').map(s => s.key);
ok(el.includes('ram') && el.includes('batteryCapacity') && el.includes('screenSize'),
   'electronics suggest RAM, battery capacity and screen size');
ok(S.suggestionsFor('groceries').map(s => s.key).includes('expiryDate'),
   'groceries alias to food and suggest an expiry date');
/* Suggestions must NOT become a schema — an unknown category is a complete product. */
ok(S.suggestionsFor('taxidermy').length === 0,
   'an unknown category yields no suggestions (and is NOT rejected)');
ok(S.build({ specs: { brand: 'Acme' }, stockUnit: 'pieces' }).ok,
   'CONTROL: a product in an unknown category still builds successfully');

/* ── 4. THE ESCAPE HATCH ──────────────────────────────────────────────────── */
console.log('\n4. A merchant can name a specification we never anticipated');
const custom = S.build({ specs: { custom: [{ name: 'Battery capacity', value: 5000, unit: 'mAh' }] } });
ok(custom.ok, 'a custom spec builds');
ok(custom.patch.specs.custom[0].name === 'Battery capacity' &&
   custom.patch.specs.custom[0].unit === 'mAh' &&
   custom.patch.specs.custom[0].number === 5000,
   'name, unit and numeric value are all retained');

/* ── 5. STOCK UNITS ───────────────────────────────────────────────────────── */
console.log('\n5. "20" means something');
ok(S.normalizeStockUnit('kg').name === 'kg', 'a bare string unit is accepted');
const boxes = S.normalizeStockUnit({ name: 'boxes', perPack: 24, packUnit: 'pieces' });
ok(boxes.perPack === 24 && boxes.packUnit === 'pieces',
   'a box declares how many pieces are inside');
ok(S.normalizeStockUnit({ name: 'jerrycans' }).custom === true,
   'a merchant\'s own unit is kept and flagged custom, not refused');
ok(S.normalizeStockUnit('') === null, 'no unit given yields null rather than a default');

/* ── 6. VARIANTS ──────────────────────────────────────────────────────────── */
console.log('\n6. Variants, and the stock number POS reads');
const nike = S.build({
  stockUnit: 'pairs',
  variants: [
    { attrs: { colour: 'Black', size: '42' }, stock: 8, sku: 'NAM-B42', price: 8500 },
    { attrs: { colour: 'Black', size: '43' }, stock: 5, sku: 'NAM-B43' },
    { attrs: { colour: 'White', size: '42' }, stock: 3, sku: 'NAM-W42' },
  ],
});
ok(nike.ok, 'three distinct variants build cleanly');
ok(nike.patch.variants.length === 3, 'all three are retained');
ok(nike.patch.variants[0].price === 8500, 'a variant may carry its own price');
/* The important one: stock is DERIVED, so the till and the catalogue cannot disagree. */
ok(nike.patch.stock === 16, 'product stock is the SUM of variant stock (8+5+3=16)');

const lied = S.build({
  stock: 999,                                   /* caller claims something else */
  variants: [{ attrs: { size: 'M' }, stock: 2 }, { attrs: { size: 'L' }, stock: 3 }],
});
ok(lied.patch.stock === 5,
   'a supplied stock figure is RECOMPUTED from variants, never trusted',
   'got ' + lied.patch.stock);

const dupe = S.build({
  variants: [{ attrs: { colour: 'Black', size: '42' }, stock: 1 },
             { attrs: { size: '42', colour: 'black' }, stock: 4 }],
});
ok(!dupe.ok && /same options/i.test(dupe.problems.join(' ')),
   'two variants with the same options are REFUSED (case/order-insensitive)');

const naked = S.build({ variants: [{ stock: 5 }] });
ok(!naked.ok, 'a variant with nothing distinguishing it is refused');

/* Without variants, stock is left to the existing writer — this file does not
   redefine a field it did not create. */
const plain = S.build({ specs: { brand: 'Acme' }, stock: 12 });
ok(plain.patch.stock === undefined,
   'with no variants, stock is NOT touched — it stays the existing writer\'s field');

/* ── 7. ADDITIVE ──────────────────────────────────────────────────────────── */
console.log('\n7. Additive — it cannot redefine what already exists');
const patchKeys = Object.keys(S.build({
  specs: { brand: 'A', weight: { v: 2, u: 'kg' } },
  stockUnit: 'kg',
  variants: [{ attrs: { size: 'M' }, stock: 1 }],
}).patch).sort();
ok(patchKeys.join(',') === 'specs,stock,stockUnit,variants',
   'the patch touches ONLY specs / stockUnit / variants / derived stock',
   patchKeys.join(','));
['price', 'name', 'category', 'colors', 'sizes', 'weights', 'sellerUid', 'shopId'].forEach((f) => {
  ok(patchKeys.indexOf(f) === -1, 'the patch never writes "' + f + '"');
});

/* ── 8. UNRESOLVED UNITS ARE REPORTED ─────────────────────────────────────── */
console.log('\n8. An unusable unit is reported, not stored as a bare number');
const bad = S.build({ specs: { weight: { v: 5, u: 'furlongs' } } });
ok(!bad.ok && /not a unit we recognise/i.test(bad.problems.join(' ')),
   'an unrecognised unit on a known measure is a problem the merchant sees');

/* ── 9. IT REACHES THE DOCUMENT ───────────────────────────────────────────
   The model being correct is worth nothing if the writer drops it. _productFields is a
   strict whitelist: anything it does not name is silently discarded, and the editor
   would have appeared to save specs that never left the browser. Asserted through the
   real createProduct against a stub adapter — not by reading the whitelist. */
console.log('\n9. Specs survive the writer whitelist and reach the document');
(async () => {
  globalThis.SokoniProductSpecs = S;
  const MD = require(path.join(__dirname, '..', 'sokoni-merchant-data.js'));
  let captured = null;
  const db = { writeProduct: async (o) => { captured = o; return { ok: true }; } };

  await MD.createProduct({
    scope: { ok: true, shopId: 's1', sellerUid: 'u1' }, db, draftToken: 't1',
    product: {
      name: 'Nike Air Max', price: 8500, stock: 0, category: 'clothing',
      specs: { brand: 'Nike' }, stockUnit: { name: 'pairs' },
      variants: [{ attrs: { colour: 'Black', size: '42' }, stock: 8 },
                 { attrs: { colour: 'White', size: '42' }, stock: 3 }],
    },
  });

  const d = (captured || {}).data || {};
  ok(!!captured, 'CONTROL: the writer reached the db adapter');
  ok(d.specs && d.specs.brand === 'Nike', 'specs reached the document');
  ok(Array.isArray(d.variants) && d.variants.length === 2, 'variants reached the document');
  ok(d.stockUnit && d.stockUnit.name === 'pairs', 'the stock unit reached the document');
  /* The one that matters to the till: input said 0, variants say 8+3. */
  ok(d.stock === 11, 'product stock was DERIVED (11), not taken from the input 0', 'got ' + d.stock);
  ok(d.price === 8500 && d.name === 'Nike Air Max' && d.category === 'clothing',
     'the existing fields are untouched');
  ok(d.shopId === 's1' && d.sellerUid === 'u1',
     'ownership still comes from the scope, not from the product input');

  /* A bad spec must REFUSE the write rather than store a meaningless figure. */
  let refused = false;
  try {
    await MD.createProduct({
      scope: { ok: true, shopId: 's1', sellerUid: 'u1' }, db, draftToken: 't2',
      product: { name: 'X', price: 1, stock: 1, specs: { weight: { v: 5, u: 'furlongs' } } },
    });
  } catch (e) { refused = /not a unit we recognise/i.test(e.message); }
  ok(refused, 'an unusable unit REFUSES the write instead of storing a bare number');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  aborted: ' + (e && e.stack)); process.exit(1); });
