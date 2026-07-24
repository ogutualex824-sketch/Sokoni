#!/usr/bin/env node
'use strict';

/**
 * Variant integration guard.
 *
 * Cloud Functions bundle only functions/, so functions/search-terms.js cannot
 * require the browser-side sokoni-product-schema.js. The variant key list
 * therefore exists on both sides of that boundary, and this test is what stands
 * in for the shared import: if a seller-facing attribute is added to the schema
 * and not to the indexer, products would save the value and search would never
 * find it — a silent, data-shaped failure with no error anywhere.
 *
 * Also exercises the pure functions on both sides against the shapes real
 * documents actually hold: missing, null, empty, scalar, and non-string.
 *
 *   node scripts/check-variant-parity.js
 */

const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const schema = require(path.join(ROOT, 'sokoni-product-schema.js'));
const { buildSearchTerms, VARIANT_FIELDS, variantAttributes } =
  require(path.join(ROOT, 'functions', 'search-terms.js'));

let failed = 0;
function check(name, fn) {
  try { fn(); console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + '\n        ' + e.message); }
}

console.log('\nVariant parity + behaviour\n');

/* ── 1. The two key lists must be identical ─────────────────────────────── */
check('server VARIANT_FIELDS === client ALL_ATTR_KEYS', () => {
  const server = [...VARIANT_FIELDS].sort();
  const client = [...schema.ALL_ATTR_KEYS].sort();
  assert.deepStrictEqual(server, client,
    `indexer knows [${server}] but the seller form writes [${client}] — ` +
    'a value saved under a key the indexer does not read is unsearchable');
});

/* ── 2. Every attribute a category offers must be a known key ───────────── */
check('every CATEGORY_ATTRS entry resolves to a real attribute', () => {
  Object.keys(schema.CATEGORY_ATTRS).forEach(cat => {
    schema.attrsForCategory(cat).forEach(a => {
      assert.ok(a && a.key, `category "${cat}" maps to an undefined attribute`);
      assert.ok(VARIANT_FIELDS.includes(a.key),
        `category "${cat}" offers "${a.key}", which the indexer does not index`);
    });
  });
});

/* ── 3. Search terms actually contain variant values ────────────────────── */
check('variant values become search terms', () => {
  const terms = buildSearchTerms({
    name: 'Nike Air',
    colors: ['Black', 'White'],
    sizes: ['42'],
    storage: ['256GB'],
    materials: ['Cotton'],
  });
  ['black', 'white', '42', '256gb', 'cotton'].forEach(t =>
    assert.ok(terms.includes(t), `expected term "${t}"`));
});

check('single-character sizes survive (the 2-char floor would drop S/M/L)', () => {
  const terms = buildSearchTerms({ name: 'Tee', sizes: ['S', 'M', 'L'] });
  ['s', 'm', 'l'].forEach(t => assert.ok(terms.includes(t), `expected term "${t}"`));
});

check('"256 gb" matches a product stored as "256GB"', () => {
  const terms = buildSearchTerms({ name: 'Phone', storage: ['256GB'] });
  assert.ok(terms.includes('256'), 'expected the numeric part');
  assert.ok(terms.includes('gb'), 'expected the unit part');
});

/* ── 4. Backward compatibility: never assume a field exists ─────────────── */
const HOSTILE = [
  ['missing',      {}],
  ['null',         { colors: null, sizes: null }],
  ['empty array',  { colors: [], sizes: [] }],
  ['bare scalar',  { colors: 'Black' }],
  ['null member',  { colors: ['Black', null, undefined, ''] }],
  ['non-string',   { sizes: [42, true] }],
  ['whitespace',   { colors: ['  Black  ', 'Black'] }],
];

HOSTILE.forEach(([label, doc]) => {
  check(`buildSearchTerms tolerates ${label}`, () => {
    const t = buildSearchTerms(Object.assign({ name: 'X' }, doc));
    assert.ok(Array.isArray(t));
    assert.ok(!t.includes(''), 'empty string leaked into terms');
    assert.ok(t.every(x => typeof x === 'string'), 'non-string leaked into terms');
  });
  check(`variantAttributes tolerates ${label}`, () => {
    const a = variantAttributes(Object.assign({}, doc));
    VARIANT_FIELDS.forEach(f => {
      assert.ok(Array.isArray(a[f]), `${f} must always be an array for faceting`);
      assert.ok(a[f].every(v => typeof v === 'string' && v.length),
        `${f} must hold only non-empty strings`);
    });
  });
  check(`variantGroups tolerates ${label}`, () => {
    const g = schema.variantGroups(Object.assign({ category: 'fashion' }, doc));
    assert.ok(Array.isArray(g));
    g.forEach(x => assert.ok(x.values.length, 'a group was emitted with no values'));
  });
});

check('variantAttributes trims and de-duplicates like the display path', () => {
  const a = variantAttributes({ colors: ['  Black  ', 'Black'] });
  assert.deepStrictEqual(a.colors, ['Black', 'Black'],
    'indexing keeps duplicates (Algolia de-dupes facets itself) but must trim');
});

/* ── 5. Display: no empty headings, correct grouping ────────────────────── */
check('a product with nothing declared yields no groups (no empty headings)', () => {
  assert.deepStrictEqual(schema.variantGroups({ category: 'fashion' }), []);
  assert.strictEqual(schema.variantSummary({ category: 'fashion' }), '');
});

check('groups follow the category order', () => {
  const g = schema.variantGroups({
    category: 'fashion', materials: ['Cotton'], sizes: ['M'], colors: ['Black'],
  });
  assert.deepStrictEqual(g.map(x => x.key), ['colors', 'sizes', 'materials']);
});

check('a re-categorised product still shows attributes its category dropped', () => {
  /* meat offers only weights; the leftover colours must not vanish silently */
  const g = schema.variantGroups({ category: 'meat', weights: ['1kg'], colors: ['Red'] });
  assert.deepStrictEqual(g.map(x => x.key), ['weights', 'colors']);
});

check('card summary matches the spec examples', () => {
  const cases = [
    [{ category: 'fashion',     colors: ['Black'], sizes: ['XL'], materials: ['Cotton'] }, 'Black • XL'],
    [{ category: 'electronics', colors: ['Black'], storage: ['256GB'] },                   'Black • 256GB'],
    [{ category: 'skincare',    volumes: ['500ml'] },                                      '500ml'],
    [{ category: 'food',        weights: ['1kg'] },                                        '1kg'],
  ];
  cases.forEach(([p, want]) =>
    assert.strictEqual(schema.variantSummary(p), want,
      `summary for ${p.category}: got "${schema.variantSummary(p)}"`));
});

check('summary is capped at two parts so cards stay scannable', () => {
  const s = schema.variantSummary({
    category: 'fashion', colors: ['Black'], sizes: ['XL'], materials: ['Cotton'],
  });
  assert.ok(s.split('•').length <= 2, `too many parts: "${s}"`);
});

/* ── 6. The index-settings file must declare what the transformer writes ── */
check('every variant field is searchable AND facetable in Algolia settings', () => {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(ROOT, 'functions', 'algolia-admin.js'), 'utf8');
  const block = src.slice(src.indexOf('sokoni_products:'), src.indexOf('customRanking'));
  VARIANT_FIELDS.forEach(f => {
    assert.ok(block.includes(`unordered(${f})`), `${f} is not a searchable attribute`);
    assert.ok(new RegExp(`'${f}',`).test(block), `${f} is not in attributesForFaceting`);
  });
});

console.log(failed ? `\n${failed} FAILED\n` : '\nAll checks passed\n');
process.exit(failed ? 1 : 0);
