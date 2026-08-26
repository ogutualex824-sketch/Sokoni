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

/* ── 10. SIZE IS NOT ALWAYS A MEASUREMENT ─────────────────────────────────
   "XL" is a legitimate product attribute with no numeric value. Number('XL') is NaN, so any
   path that coerces would drop it entirely — the same class of bug as Number(null) reporting
   an absent stock as zero. And a bare 38 means nothing without its system: it is a different
   shoe in EU and in US. */
/* Null-safe reads. Under sabotage size() can return null, and a bare `.value` then THREW —
   the suite died at the first assertion and printed NO failures at all, so a broken model
   looked like a broken harness. A guard that crashes instead of failing is not a guard. */
const sz = (v, sys) => S.size(v, sys) || {};

console.log('\n10. Sizes — alpha, numeric and systemed');
ok(sz('XL').value === 'XL' && sz('XL').system === 'alpha',
   'XL survives as XL and identifies its own system');
ok(sz('xl').value === 'XL', 'case is normalised for alpha sizes');
ok(sz('XL').number === undefined, 'an alpha size carries NO number — it is not one');
ok(sz(38, 'EU').system === 'EU' && sz(38, 'EU').number === 38,
   'EU 38 keeps its system AND sorts, because it genuinely is a number');
ok(sz(38, 'EU').system !== sz(38, 'US').system,
   'EU 38 and US 38 are distinguishable — a 38 is a different shoe in each');
ok(sz('4T', 'toddler').customSystem === true,
   'a merchant\'s own sizing system is KEPT, not discarded over a vocabulary disagreement');
ok(S.size('') === null && S.size(null) === null, 'an empty size is absent, not a blank value');
/* No cross-system conversion is attempted, deliberately: alpha-to-EU differs by garment,
   manufacturer and country, so a table would be a confident guess beside a real figure. */
ok(sz('XL').base === undefined && sz(38, 'EU').base === undefined,
   'NO cross-system conversion is invented');

/* ── 11. THE UNIT FAMILIES A REAL SHOP NEEDS ──────────────────────────────── */
console.log('\n11. Storage, power, voltage, frequency, charge and counts');
['storage', 'power', 'voltage', 'frequency', 'charge', 'count'].forEach((dim) => {
  ok(!!S.UNITS[dim], 'the ' + dim + ' family exists');
});
ok(S.measure('storage', 256, 'GB').base === 262144, '256 GB normalises to 262144 MB');
ok(S.measure('charge', 5, 'Ah').base === 5000, '5 Ah normalises to 5000 mAh');
ok(S.measure('frequency', 2.4, 'GHz').base === 2400000000, '2.4 GHz normalises to Hz');
ok(S.canonicalUnit('count', 'tablets') === 'tablets', 'a pharmacy can count in tablets');
ok(S.canonicalUnit('count', 'sachets') === 'sachets', '...and in sachets');
/* Families must not leak into each other — a battery in mAh is not a weight. */
ok(S.canonicalUnit('weight', 'mAh') === null,
   'NEGATIVE CONTROL: mAh is refused as a WEIGHT');
ok(S.canonicalUnit('storage', 'kg') === null,
   'NEGATIVE CONTROL: kg is refused as STORAGE');

/* ── 12. THE CATEGORIES A KENYAN MARKET ACTUALLY HAS ──────────────────────── */
console.log('\n12. Medicine, hardware and cosmetics');
const med = S.suggestionsFor('pharmacy').map((x) => x.key);
ok(med.indexOf('dose') >= 0 && med.indexOf('packCount') >= 0 && med.indexOf('expiryDate') >= 0,
   'a pharmacy is offered dose, pack count and expiry');
const hw = S.suggestionsFor('tools').map((x) => x.key);
ok(hw.indexOf('diameter') >= 0 && hw.indexOf('gauge') >= 0 && hw.indexOf('packQuantity') >= 0,
   'hardware is offered diameter, gauge and pack quantity');
const cos = S.suggestionsFor('beauty').map((x) => x.key);
ok(cos.indexOf('spf') >= 0 && cos.indexOf('volume') >= 0, 'cosmetics are offered SPF and volume');
const sizeDef = S.suggestionsFor('clothing').filter((x) => x.key === 'size')[0];
ok(sizeDef && sizeDef.type === 'size',
   'clothing size is a SIZE field, not free text and not a number');
/* Still suggestions, not a schema. */
ok(S.build({ specs: { dose: { v: 500, u: 'mg' } } }).ok,
   'a dose can be recorded on ANY product — categories suggest, they do not constrain');

/* ── 13. THE STANDING RULE, ENFORCED ACROSS EVERY ATTRIBUTE TYPE ──────────
   "Never coerce a merchant's product attribute just to make it sortable. Preserve what they
   entered, and derive a comparable numeric base ONLY when the unit or system genuinely
   supports it."

   Section 10 proves that for sizes and section 11 for units. This proves it for all of them
   at once, as a round trip: what the merchant typed must come back out unchanged, and a
   `base` must appear if and only if the family defines one. Written as one table so a NEW
   attribute type added later is covered by adding a row rather than by remembering to write
   a test — which is how the size case went missing until it was asked for. */
console.log('\n13. Round trip — nothing is coerced, nothing is invented');
const ROUND_TRIP = [
  { label: 'XL',        specs: { size: { value: 'XL' } },                     path: 'size',    keep: 'XL',   base: false },
  { label: 'EU 38',     specs: { size: { value: 38, system: 'EU' } },         path: 'size',    keep: '38',   base: false },
  { label: '4T',        specs: { size: { value: '4T', system: 'toddler' } },  path: 'size',    keep: '4T',   base: false },
  { label: '2 kg',      specs: { weight: { v: 2, u: 'kg' } },                 path: 'weight',  keep: 2,      base: 2000 },
  { label: '2 L',       specs: { capacity: { v: 2, u: 'l' } },                path: 'capacity', keep: 2,     base: 2000 },
  { label: '500 mg',    specs: { dose: { v: 500, u: 'mg' } },                 path: 'dose',    keep: 500,    base: 0.5 },
  { label: '24 tablets', specs: { packCount: { v: 24, u: 'tablets' } },       path: 'packCount', keep: 24,   base: 24 },
  { label: '256 GB',    specs: { storage: { v: 256, u: 'GB' } },              path: 'storage', keep: 256,    base: 262144 },
  { label: '5000 mAh',  specs: { batteryCapacity: { v: 5000, u: 'mAh' } },    path: 'batteryCapacity', keep: 5000, base: 5000 },
  { label: '220 V',     specs: { voltage: { v: 220, u: 'V' } },               path: 'voltage', keep: 220,    base: 220 },
  { label: '50 Hz',     specs: { refreshRate: { v: 50, u: 'Hz' } },           path: 'refreshRate', keep: 50, base: 50 },
  /* Screens and appliances — the rows a new attribute type is meant to be covered by. */
  { label: '15.6 in screen', specs: { screenSize: { v: 15.6, u: 'in' } },     path: 'screenSize', keep: 15.6, base: 396.24 },
  { label: '70 Wh battery',  specs: { batteryEnergy: { v: 70, u: 'Wh' } },    path: 'batteryEnergy', keep: 70, base: 70 },
  { label: '350 L fridge',   specs: { capacity: { v: 350, u: 'l' } },         path: 'capacity', keep: 350, base: 350000 },
  { label: '2000 W',         specs: { power: { v: 2000, u: 'W' } },           path: 'power',   keep: 2000, base: 2000 },
  { label: '44 mm case',     specs: { caseSize: { v: 44, u: 'mm' } },         path: 'caseSize', keep: 44,  base: 44 },
  { label: '3 in nail',      specs: { length: { v: 3, u: 'in' } },            path: 'length',  keep: 3,    base: 76.2 },
];
ROUND_TRIP.forEach((c) => {
  const built = S.build({ specs: c.specs });
  const got = (built.patch.specs || {})[c.path];
  const value = got && (got.value !== undefined ? got.value : got.v);
  ok(!!got, 'CONTROL: ' + c.label + ' produced a stored attribute');
  ok(String(value) === String(c.keep),
     c.label + ' round-trips as ' + JSON.stringify(c.keep),
     'got ' + JSON.stringify(value));
  if (c.base === false) {
    ok(got && got.base === undefined,
       c.label + ' has NO derived base — its system does not support one');
  } else {
    ok(got && got.base === c.base,
       c.label + ' derives base ' + c.base, 'got ' + (got && got.base));
  }
});


/* Float noise is an artefact, not precision. 15.6 * 25.4 is 396.23999999999995 in binary
   floating point; storing that in every product document makes two equal measurements compare
   UNEQUAL, which is the one thing base exists to do. The merchant's own value is never
   rounded — only the derived base. */
ok(S.measure('length', 15.6, 'in').base === 396.24, 'a derived base carries no float noise');
ok(S.measure('weight', 1, 'mg').base === 0.001, 'the smallest real unit stays exact under rounding');
ok(S.measure('length', 1, 'ft').base === S.measure('length', 12, 'in').base,
   '1 ft and 12 in compare EQUAL — they would not without rounding');
ok(S.measure('length', 15.6, 'in').v === 15.6, 'the merchant value itself is never rounded');

/* ── 14. "SIZE" IS NOT ONE FIELD ──────────────────────────────────────────
   A laptop's 15.6-inch screen, a shirt's XL, a shoe's EU 42 and a nail's 3-inch length are
   four DIFFERENT kinds of attribute. If any of them were forced through one hardcoded
   "size" field, three of the four would be wrong — and the wrongness would be invisible,
   because each would still render a number next to a label. */
console.log('\n14. Four kinds of "size", none of them the same field');
const FOUR = S.build({ specs: {
  screenSize: { v: 15.6, u: 'in' },     /* a length, in inches */
  size: { value: 'XL' },                /* an alpha size, no number at all */
  length: { v: 3, u: 'in' },            /* also a length — same family, different meaning */
} }).patch.specs;
ok(FOUR.screenSize.dim === 'length' && FOUR.screenSize.base === 396.24,
   'a 15.6" screen is a LENGTH with a real base');
ok(FOUR.size.system === 'alpha' && FOUR.size.number === undefined,
   'XL is an alpha size with no numeric value at all');
ok(FOUR.length.dim === 'length' && FOUR.length.base === 76.2,
   'a 3" nail is a length too — same family, its own attribute');
ok(FOUR.screenSize.v !== FOUR.length.v,
   'they are separate attributes, not one overwritten "size"');
const shoe = S.build({ specs: { size: { value: 42, system: 'EU' } } }).patch.specs.size;
ok(shoe.system === 'EU' && shoe.number === 42,
   'EU 42 keeps its system AND sorts — a third kind again');

/* Every screen category must reach screenSize as a real measure, not free text. */
['laptop', 'tvs', 'monitor'].forEach((cat) => {
  const def = S.suggestionsFor(cat).filter((x) => x.key === 'screenSize')[0];
  ok(def && def.type === 'measure' && def.dim === 'length',
     cat + ' offers screen size as a measurable length');
});
/* An appliance carries capacity, power and voltage — three different families on ONE
   product, which is exactly why a single generic "size" cannot work. */
const fridge = S.suggestionsFor('fridge').map((x) => x.dim).filter(Boolean);
ok(fridge.indexOf('volume') >= 0 && fridge.indexOf('power') >= 0 && fridge.indexOf('voltage') >= 0,
   'a fridge spans volume, power and voltage on one product');
/* Energy and charge stay apart: converting Wh to mAh needs the cell voltage, which the
   document does not carry. */
ok(S.canonicalUnit('charge', 'Wh') === null && S.canonicalUnit('energy', 'mAh') === null,
   'NEGATIVE CONTROL: Wh is not mAh — no conversion is invented between them');

/* 500 mg and 24 tablets are TWO attributes. Multiplying them into one "12000" would be an
   invented figure that matches nothing on the packet. */
const pharm = S.build({ specs: { dose: { v: 500, u: 'mg' }, packCount: { v: 24, u: 'tablets' } } });
ok(pharm.patch.specs.dose.v === 500 && pharm.patch.specs.packCount.v === 24,
   'dose and pack count stay two distinct attributes, never one invented number');

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
