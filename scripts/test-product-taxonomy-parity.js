#!/usr/bin/env node
/* THE TAXONOMY STILL MATCHES THE FORM IT CAME FROM.
 *
 *   node scripts/test-product-taxonomy-parity.js
 *
 * sokoni-product-taxonomy.js is GENERATED from seller.html by
 * scripts/build-product-taxonomy.js. Generation is a one-time act; drift is continuous. The
 * moment someone adds a category to the legacy form — or edits the generated module by hand
 * — the two disagree, and the failure is silent and expensive: a merchant picks a category
 * that the storefront filters, the spec suggestions and the commission lane do not recognise,
 * and nothing says so.
 *
 * This repo has been there. commission-config.js: "The platform once had NINE commission
 * tables that disagreed." A generated file with no parity test is the tenth.
 *
 * IT COMPARES THE SOURCE, NOT THE GENERATOR. Re-running the build and diffing would only
 * prove the generator is deterministic. This parses seller.html independently and checks the
 * SHIPPED module against it, so a hand edit to either side fails.
 *
 * WHEN seller.html IS RETIRED: delete this suite with it, and the taxonomy becomes the
 * single source outright. Until then it is the second one, and this is what keeps it honest.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'seller.html'), 'utf8');
const gate = fs.readFileSync(path.join(ROOT, 'adult-gate.js'), 'utf8');
const T = require(path.join(ROOT, 'sokoni-product-taxonomy.js'));

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label +
    (detail !== undefined && detail !== '' ? '   [' + String(detail).slice(0, 130) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n' + t + '\n');

const dec = (s) => s.replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
function selectBlock(id) {
  const at = html.indexOf('id="' + id + '"');
  if (at < 0) return '';
  return html.slice(at, html.indexOf('</select>', at));
}
function values(id) {
  return (selectBlock(id).match(/<option value="([^"]+)"/g) || [])
    .map((s) => s.replace(/<option value="|"/g, '')).filter(Boolean);
}
function setOf(name, src) {
  const m = new RegExp('const ' + name + '\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)').exec(src);
  return m ? (m[1].match(/"([^"]+)"/g) || []).map((s) => s.replace(/"/g, '')) : null;
}
const sorted = (a) => a.slice().sort();
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

head('1 - the category list');
{
  const legacy = values('productCategory');
  const mine = [];
  T.GROUPS.forEach((g) => g.options.forEach((o) => mine.push(o.value)));
  ck('every legacy category exists in the taxonomy', same(legacy, mine),
     'legacy ' + legacy.length + ' vs taxonomy ' + mine.length +
     ' | missing: ' + legacy.filter((v) => mine.indexOf(v) < 0).join(', ') +
     ' | extra: ' + mine.filter((v) => legacy.indexOf(v) < 0).join(', '));

  const legacyGroups = (selectBlock('productCategory').match(/<optgroup label="([^"]+)"/g) || [])
    .map((s) => dec(s.replace(/<optgroup label="|"/g, '')));
  const mineGroups = T.GROUPS.map((g) => (g.emoji ? g.emoji + ' ' : '') + g.label);
  ck('the groups match, in the same order',
     JSON.stringify(legacyGroups) === JSON.stringify(mineGroups),
     legacyGroups.length + ' vs ' + mineGroups.length);

  /* Every option must carry an emoji, because every dropdown in the new form does. */
  const bare = [];
  T.GROUPS.forEach((g) => g.options.forEach((o) => { if (!o.emoji) bare.push(o.value); }));
  ck('every category carries an emoji', bare.length === 0, bare.slice(0, 8).join(', '));
  ck('every group carries an emoji', T.GROUPS.every((g) => !!g.emoji),
     T.GROUPS.filter((g) => !g.emoji).map((g) => g.label).join(', '));
}

head('2 - the other vocabularies');
[
  ['productLocation', 'LOCATIONS'],
  ['ownerSource',     'OWNER_SOURCES'],
  ['foodStorage',     'FOOD_STORAGE'],
  ['foodSlaughter',   'FOOD_SLAUGHTER'],
].forEach(([id, key]) => {
  const legacy = values(id);
  const mine = T[key].map((o) => o.value);
  ck(id + ' -> ' + key, same(legacy, mine),
     'legacy ' + legacy.length + ' vs ' + mine.length);
});

head('3 - the rules that decide the shape of the form');
{
  const pairs = [
    ['KEBS_CATEGORIES',   'KEBS',         html],
    ['FOOD_LICENSE_CATS', 'FOOD_LICENCE', html],
    ['SERVICE_CATEGORIES','SERVICE',      html],
    ['DIGITAL_CATEGORIES','DIGITAL',      html],
  ];
  pairs.forEach(([name, key, src]) => {
    const legacy = setOf(name, src);
    ck(name + ' -> ' + key, !!legacy && same(legacy, T[key]),
       legacy ? (legacy.length + ' vs ' + T[key].length) : 'legacy set not found');
  });
  const adult = (/(?:const|var)\s+ADULT_CATS\s*=\s*\[([\s\S]*?)\]/.exec(gate) || [])[1];
  const adultVals = adult ? (adult.match(/"([^"]+)"/g) || []).map((s) => s.replace(/"/g, '')) : null;
  ck('adult-gate.js ADULT_CATS -> ADULT', !!adultVals && same(adultVals, T.ADULT),
     adultVals ? adultVals.join(', ') : 'not found');
}

head('4 - the ownership matrix');
{
  const at = html.indexOf('const OWNERSHIP_CATS = {');
  const src = html.slice(at, html.indexOf('};', at));
  const legacyKeys = [];
  const re = /"?([a-zA-Z-]+)"?\s*:\s*\{\s*serial:/g;
  let m;
  while ((m = re.exec(src))) legacyKeys.push(m[1]);
  ck('the same categories require proof of ownership',
     same(legacyKeys, Object.keys(T.OWNERSHIP)),
     legacyKeys.length + ' vs ' + Object.keys(T.OWNERSHIP).length);
  ck('each carries its own serial label, hint, document and reason',
     Object.keys(T.OWNERSHIP).every((k) => {
       const o = T.OWNERSHIP[k];
       return o && o.serial && o.hint && o.doc && o.sub;
     }));
  /* The wording is the point: an IMEI is not a chassis number, and a form that asked for
     "serial number" on a car would be asking the wrong question. */
  ck('a car is asked for a chassis/VIN, a phone for an IMEI',
     /VIN/i.test(T.OWNERSHIP.cars.serial) && /IMEI/i.test(T.OWNERSHIP.electronics.serial),
     T.OWNERSHIP.cars.serial + ' / ' + T.OWNERSHIP.electronics.serial);
}

head('5 - the derived helpers agree with the sets');
{
  ck('kindOf splits digital, service and physical',
     T.kindOf('ebook') === 'digital' && T.kindOf('plumbing') === 'service' &&
     T.kindOf('electronics') === 'physical');
  ck('a service is never shown a KEBS certificate', !T.showsKebs('plumbing'));
  ck('a download is never shown a KEBS certificate', !T.showsKebs('ebook'));
  ck('every food-licence category is also a real category',
     T.FOOD_LICENCE.every((c) => T.isKnown(c)),
     T.FOOD_LICENCE.filter((c) => !T.isKnown(c)).join(', '));
  ck('every ownership category is also a real category',
     Object.keys(T.OWNERSHIP).every((c) => T.isKnown(c)),
     Object.keys(T.OWNERSHIP).filter((c) => !T.isKnown(c)).join(', '));
  ck('every adult category is also a real category',
     T.ADULT.every((c) => T.isKnown(c)), T.ADULT.filter((c) => !T.isKnown(c)).join(', '));
  /* NEGATIVE CONTROL: the parity checks above compare two lists, and two lists that were
     both empty would compare equal. */
  ck('NC the taxonomy is not empty',
     T.GROUPS.length >= 20 && T.LOCATIONS.length >= 20 &&
     Object.keys(T.OWNERSHIP).length >= 9);
  ck('NC isKnown rejects something that is not a category', !T.isKnown('not-a-real-category'));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
