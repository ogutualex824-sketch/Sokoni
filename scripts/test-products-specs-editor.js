/* The Specifications section of the product editor.
 *
 *   node scripts/test-products-specs-editor.js
 *
 * The model landed first (sokoni-product-specs.js) and for one commit had NO entry point —
 * a merchant could not type a weight, a mileage or a variant. This asserts the editor
 * actually offers it, and that the flat HTML form assembles back into the nested model
 * without losing or inventing anything.
 *
 * The chain is proven end to end — form values -> fieldsFromForm -> createProduct -> the
 * document handed to the db adapter — rather than by reading the markup. Markup can render
 * an input whose value never reaches Firestore, which is exactly what a whitelist does.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-products.js'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SPECS = require(path.join(ROOT, 'sokoni-product-specs.js'));

let pass = 0, fail = 0;
const ok = (c, label, detail) => {
  if (c) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
};

/* ── 1. THE SECTION EXISTS AND IS MOUNTED ─────────────────────────────────── */
console.log('\n1. The editor offers Specifications');
['specsHTML', 'measureField', 'dimensionField', 'suggestedHTML', 'customHTML', 'stockUnitHTML']
  .forEach((f) => ok(new RegExp('function ' + f + ' \\(').test(CODE), 'CONTROL: ' + f + ' exists'));
/* Existing is not the same as REACHED — the previous commit shipped a model nobody could open. */
ok(/specsHTML\(p\)/.test(CODE) && /stockUnitHTML\(p\)/.test(CODE),
   'both sections are mounted INTO the editor, not merely defined');

/* Units are offered from the model, so the editor cannot present one the writer refuses. */
ok(/SP\.UNITS\[dim\]/.test(CODE) || /SP && SP\.UNITS/.test(CODE),
   'unit lists come from the model, not a second hardcoded list');
ok(/SP\.STOCK_UNITS/.test(CODE), 'stock units come from the model too');

/* Absent model = no section, and a product still saves. Specs are optional data. */
ok(/if \(!specModel\(\)\) return '';/.test(SRC),
   'with the model script absent the section is skipped, not broken');

/* ── 2. THE FLAT FORM ASSEMBLES INTO THE NESTED MODEL ─────────────────────── */
console.log('\n2. Dotted form keys assemble back into the model shape');
const body = SRC.match(/function fieldsFromForm \(\) \{[\s\S]*?\n    \}/);
ok(!!body, 'CONTROL: fieldsFromForm extracted');
const FORM_KEYS = ['name', 'price', 'costPrice', 'stock', 'sku', 'category', 'description', 'status'];
const NUMERIC = { price: 1, costPrice: 1, stock: 1 };
const run = (values) => new Function('S', 'FORM_KEYS', 'NUMERIC', 'return (' + body[0] + ')()')(
  { editor: { values } }, FORM_KEYS, NUMERIC);

const out = run({
  name: 'Toyota Vitz', price: '850000', category: 'vehicles', stock: '1',
  'spec.brand': 'Toyota', 'spec.barcode': '',
  'spec.weight.v': '1010', 'spec.weight.u': 'kg',
  'spec.dimensions.length.v': '3.8', 'spec.dimensions.length.u': 'm',
  'spec.mileage.v': '82000', 'spec.mileage.u': 'km',
  'spec.custom.0.name': 'Service history', 'spec.custom.0.value': 'Full',
  'spec.custom.1.name': '', 'spec.custom.1.value': 'orphaned',
  'stockUnit.name': 'pieces', 'stockUnit.perPack': '',
});
ok(out.specs && out.specs.brand === 'Toyota', 'a flat spec key becomes specs.brand');
ok(out.specs.weight && out.specs.weight.v === '1010' && out.specs.weight.u === 'kg',
   'value and unit pair up under one key');
ok(out.specs.dimensions && out.specs.dimensions.length.u === 'm',
   'a three-level key (dimensions.length.u) nests correctly');
ok(Array.isArray(out.specs.custom) && out.specs.custom.length === 1,
   'custom rows become an array');
/* Empty is ABSENT, not zero or blank — the same rule the numeric fields follow. */
ok(out.specs.barcode === undefined, 'an empty input is omitted, not stored as ""');
ok(out.stockUnit && out.stockUnit.perPack === undefined,
   'an empty perPack is omitted, not stored as 0');
ok(out.specs.custom[0].name === 'Service history',
   'a named custom row survives');
ok(!out.specs.custom.some((c) => c.value === 'orphaned'),
   'a custom row with NO name is dropped — an unnamed value is not a specification');

/* Nothing leaks upward into the top-level product. */
ok(out['spec.brand'] === undefined && out['stockUnit.name'] === undefined,
   'the dotted keys themselves never reach the product document');

/* ── 3. END TO END, THROUGH THE REAL WRITER ───────────────────────────────── */
console.log('\n3. Form -> model -> the document handed to the adapter');
(async () => {
  globalThis.SokoniProductSpecs = SPECS;
  const MD = require(path.join(ROOT, 'sokoni-merchant-data.js'));
  let captured = null;
  await MD.createProduct({
    scope: { ok: true, shopId: 's1', sellerUid: 'u1' },
    db: { writeProduct: async (o) => { captured = o; return { ok: true }; } },
    draftToken: 't1',
    product: Object.assign({}, out, { price: 850000, stock: 1 }),
  });
  const d = (captured || {}).data || {};
  ok(!!captured, 'CONTROL: the write reached the adapter');
  ok(d.specs.weight.base === 1010000 && d.specs.weight.baseUnit === 'g',
     '1010 kg normalises to a comparable base of 1010000 g');
  /* The point of category suggestions: a car gets mileage, not a generic "size". */
  ok(d.specs.mileage && d.specs.mileage.u === 'km' && d.specs.mileage.dim === 'length',
     'a vehicle carries mileage in km as a real measurement');
  ok(typeof d.specs.weight.v === 'number',
     'the string the form produced is stored as a NUMBER');
  ok(d.price === 850000 && d.name === 'Toyota Vitz',
     'price and name are untouched by the specs path');

  /* ── 4. THE EDITOR CANNOT OFFER A UNIT THE WRITER REFUSES ──────────────── */
  console.log('\n4. Editor and writer agree about units');
  const offered = Object.keys(SPECS.UNITS.weight.units);
  let allAccepted = true;
  offered.forEach((u) => { if (!SPECS.canonicalUnit('weight', u)) allAccepted = false; });
  ok(offered.length > 0, 'CONTROL: the editor has weight units to offer (' + offered.join(', ') + ')');
  ok(allAccepted, 'every unit the editor offers is one the writer accepts');
  /* And the converse: a unit NOT in the list is still refused, so the agreement is
     a real constraint rather than the writer accepting anything. */
  ok(SPECS.canonicalUnit('weight', 'furlongs') === null,
     'NEGATIVE CONTROL: a unit outside the list is still refused');

  /* ── 5. + Add specification ────────────────────────────────────────────── */
  console.log('\n5. A merchant can add a specification we never anticipated');
  ok(/data-pr="addspec"/.test(CODE), 'the add-specification control exists');
  ok(/captureForm\(\);\s*\n\s*S\.editor\.customRows/.test(CODE),
     'it captures the typed form BEFORE repainting, so existing rows are not lost');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  aborted: ' + (e && e.stack)); process.exit(1); });
