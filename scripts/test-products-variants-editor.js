/* The Variants section of the product editor.
 *
 *   node scripts/test-products-variants-editor.js
 *
 * Variants had a model and a writer path from 6d524dd and no way to create one — the same
 * gap the Specifications section had. This asserts a merchant can build them, and that the
 * stock figure POS reads is the SUM rather than whatever the form happened to hold.
 *
 * The key design point being guarded: option NAMES are the merchant's own ("Colour",
 * "Size"), so they cannot live in the input key. They are declared once (vopt.N) and each
 * row supplies a value per option (variant.R.v.N). If those two ever drift apart, a row's
 * values attach to the wrong option and a shop's Black/42 becomes 42/Black.
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

/* ── 1. THE SECTION EXISTS AND IS REACHED ─────────────────────────────────── */
console.log('\n1. The editor offers Variants');
ok(/function variantsHTML \(/.test(CODE), 'CONTROL: variantsHTML exists');
ok(/function variantOptionNames \(/.test(CODE), 'CONTROL: variantOptionNames exists');
/* Defined is not reached — that was exactly the specs gap one commit ago. */
ok(SRC.indexOf('variantsHTML(p);') > -1, 'it is MOUNTED into the editor, not merely defined');
ok(/data-pr="addvariant"/.test(CODE), 'a merchant can add a variant row');
ok(/data-pr="addopt"/.test(CODE), 'a merchant can add an option column');

/* ── 2. ASSEMBLY ──────────────────────────────────────────────────────────── */
console.log('\n2. Option columns and row values assemble into attrs');
const body = SRC.match(/function fieldsFromForm \(\) \{[\s\S]*?\n    \}/);
ok(!!body, 'CONTROL: fieldsFromForm extracted');
const FORM_KEYS = ['name', 'price', 'costPrice', 'stock', 'sku', 'category', 'description', 'status'];
const NUMERIC = { price: 1, costPrice: 1, stock: 1 };
const run = (values) => new Function('S', 'FORM_KEYS', 'NUMERIC', 'return (' + body[0] + ')()')(
  { editor: { values } }, FORM_KEYS, NUMERIC);

const out = run({
  name: 'Nike Air Max', price: '8500', stock: '0', category: 'clothing',
  'vopt.0': 'Colour', 'vopt.1': 'Size',
  'variant.0.v.0': 'Black', 'variant.0.v.1': '42', 'variant.0.stock': '8',
  'variant.0.sku': 'NAM-B42', 'variant.0.price': '8500',
  'variant.1.v.0': 'Black', 'variant.1.v.1': '43', 'variant.1.stock': '5',
  'variant.2.v.0': 'White', 'variant.2.v.1': '42', 'variant.2.stock': '3',
  'variant.3.v.0': '', 'variant.3.v.1': '', 'variant.3.stock': '9',
});
ok(Array.isArray(out.variants), 'variants assemble into an array');
ok(out.variants.length === 3, 'three real rows survive', 'got ' + (out.variants || []).length);
/* The ordering guarantee: value N attaches to option N, by name. */
ok(out.variants[0].attrs.Colour === 'Black' && out.variants[0].attrs.Size === '42',
   'row values attach to the option NAMES the merchant declared');
ok(out.variants[1].attrs.Size === '43', 'the second row keeps its own values');
ok(out.variants[0].sku === 'NAM-B42', 'a variant carries its own SKU');
/* An empty row with a quantity typed is still not a variant — attrs are what define it. */
ok(!out.variants.some((v) => v.stock === '9'),
   'a row with NO option values is dropped, even when a quantity was typed');

/* Rename an option and the attribute follows it — nothing is keyed to a position. */
const renamed = run({
  'vopt.0': 'Colour', 'variant.0.v.0': 'Black', 'variant.0.stock': '2',
});
ok(renamed.variants[0].attrs.Colour === 'Black',
   'a single-option product works (not everything has two)');

/* ── 3. THE STOCK THE TILL READS ──────────────────────────────────────────── */
console.log('\n3. Product stock is the SUM, never the form\'s own figure');
(async () => {
  globalThis.SokoniProductSpecs = SPECS;
  const MD = require(path.join(ROOT, 'sokoni-merchant-data.js'));
  let captured = null;
  const adjusted = [];
  await MD.createProduct({
    scope: { ok: true, shopId: 's1', sellerUid: 'u1' },
    db: { writeProduct: async (o) => { captured = o; return { ok: true }; } },
    draftToken: 't1',
    /* The inventory authority, recorded — the derived total has to be observable, and this
       is now where it goes. */
    adjustStock: async (p) => { adjusted.push(p); return { ok: true }; },
    product: Object.assign({}, out, { price: 8500, stock: 0 }),
  });
  const d = (captured || {}).data || {};
  ok(!!captured, 'CONTROL: the write reached the adapter');
  ok(d.variants && d.variants.length === 3, 'all three variants reached the document');
  /* THE DERIVATION IS UNCHANGED — 8+5+3 = 16, not the form's 0. What changed is the
     DESTINATION. It previously asserted d.stock === 16: the derived total written into the
     product document through a plain setDoc(merge), with no transaction, no inventoryVersion
     and no floor. That assertion was green while protecting exactly the untransacted shelf
     mutation the inventory boundary now forbids. The total is an opening quantity, so it takes
     the server authority every later movement takes. */
  ok(d.stock === undefined, 'the derived total does NOT go into the product document');
  ok(adjusted.length === 1 && adjusted[0].delta === 16,
     'it reached the inventory authority as 16 (8+5+3), not the form-supplied 0',
     'got ' + d.stock);
  ok(d.variants.every((v) => v.id), 'every variant is given a stable id');
  ok(typeof d.variants[0].price === 'number' && typeof d.variants[0].stock === 'number',
     'the strings the form produced are stored as NUMBERS');

  /* Duplicate combinations are a data defect: two rows for Black/42 give the till two
     answers for one shelf. The model refuses; the editor must not bypass that. */
  let refused = false;
  try {
    await MD.createProduct({
      scope: { ok: true, shopId: 's1', sellerUid: 'u1' },
      db: { writeProduct: async () => ({ ok: true }) }, draftToken: 't2',
      product: { name: 'X', price: 1, stock: 1,
        variants: [{ attrs: { Colour: 'Black' }, stock: 1 }, { attrs: { colour: 'black' }, stock: 2 }] },
    });
  } catch (e) { refused = /same options/i.test(e.message); }
  ok(refused, 'duplicate option combinations are REFUSED through the editor path too');

  /* ── 4. THE MERCHANT SEES THE TOTAL BEFORE SAVING ──────────────────────── */
  console.log('\n4. The derived total is shown, from the same function that computes it');
  ok(/SP\.totalStock\(/.test(CODE),
     'the editor renders the total via the model\'s totalStock — not a second addition');
  ok(/pr-vtot/.test(CODE), 'and shows it, so a product-level figure is never a surprise');

  /* ── 5. ADDING ROWS DOES NOT LOSE TYPING ───────────────────────────────── */
  console.log('\n5. Adding a row keeps what is already typed');
  ok(/captureForm\(\);\s*\n\s*S\.editor\.variantRows/.test(CODE),
     'add-variant captures the form BEFORE repainting');
  ok(/captureForm\(\);\s*\n\s*var names = variantOptionNames/.test(CODE),
     'add-option captures the form BEFORE repainting');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  aborted: ' + (e && e.stack)); process.exit(1); });
