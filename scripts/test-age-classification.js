/* Canonical 18+ product classification — one predicate, every surface.

   Run:  node scripts/test-age-classification.js        (no emulator needed)

   WHY THIS EXISTS
   Three surfaces disagreed about the same product row from the same
   /api/catalogue response:

     Shop     (category.js)  ageRestricted OR its OWN duplicate category Set
     Home     (script.js)    category ONLY — ignored ageRestricted entirely
     Product  (product.js)   NO age check, and adult-gate.js was never loaded

   So a product flagged ageRestricted outside an adult category was gated on Shop
   and open on Home; and ANY restricted product was purchasable by opening its
   detail URL directly, bypassing both. category.html states this catalogue
   complies with Kenya's Alcoholic Drinks Control Act and Tobacco Control Act,
   both of which turn on the buyer's age.

   This pins the contract: the PRODUCT DOCUMENT is the source of truth, category
   is a fallback, and nothing may classify by index, position, name or price.
*/
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

/* Load adult-gate.js in a sandbox with just enough browser surface. */
const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'adult-gate.js'), 'utf8');
const store = {};
const stub = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
const sandbox = {
  window: {}, document: { addEventListener() {}, getElementById: () => null, querySelector: () => null,
                          querySelectorAll: () => [], body: { style: {} }, createElement: () => ({ style: {}, classList: { add(){}, remove(){} } }) },
  localStorage: stub, sessionStorage: stub, console, setTimeout, clearTimeout,
};
sandbox.window.document = sandbox.document;
sandbox.window.localStorage = stub;
sandbox.window.sessionStorage = stub;
vm.createContext(sandbox);
try { vm.runInContext(src, sandbox); } catch (e) {
  console.error('adult-gate.js failed to load in sandbox:', e.message); process.exit(1);
}
const isRestricted = sandbox.window.isProductAgeRestricted;

console.log('\nCanonical 18+ classification (adult-gate.js)');
ck('isProductAgeRestricted is exported', typeof isRestricted === 'function');
if (typeof isRestricted !== 'function') { console.log('\n0 passed, 1 failed\n'); process.exit(1); }

console.log('\nThe product document is the source of truth');
ck('ageRestricted:true → restricted, whatever the category',
   isRestricted({ id: 'X', category: 'food', ageRestricted: true }) === true);
ck('ageRestricted:true on an uncategorised product → restricted',
   isRestricted({ id: 'X', ageRestricted: true }) === true);
ck('ageRestriction:"18+" string enum → restricted',
   isRestricted({ id: 'X', category: 'food', ageRestriction: '18+' }) === true);
ck('ageRestriction:"18" (no plus) → restricted',
   isRestricted({ id: 'X', category: 'food', ageRestriction: '18' }) === true);

console.log('\nCategory remains a fallback for the legacy catalogue');
['alcohol', 'vape', 'tobacco', 'adult'].forEach(c =>
  ck('category "' + c + '" → restricted', isRestricted({ id: 'X', category: c }) === true));
ck('category is case-insensitive', isRestricted({ id: 'X', category: 'ALCOHOL' }) === true);

console.log('\nOrdinary products stay ordinary — no false positives');
['electronics', 'fashion', 'food', 'beauty', 'shoes', 'books', ''].forEach(c =>
  ck('category "' + (c || '(none)') + '" → NOT restricted', isRestricted({ id: 'X', category: c }) === false));
ck('ageRestricted:false is honoured', isRestricted({ id: 'X', category: 'food', ageRestricted: false }) === false);
ck('a null product is not restricted (and does not throw)', isRestricted(null) === false);
ck('an empty product is not restricted', isRestricted({}) === false);

console.log('\nClassification must never come from position, name or price');
ck('a product named "Whisky Glass Set" in glassware is NOT auto-restricted',
   isRestricted({ id: 'X', name: 'Whisky Glass Set', category: 'furniture' }) === false,
   'name must not classify');
ck('an expensive product is NOT auto-restricted',
   isRestricted({ id: 'X', category: 'electronics', price: 999999 }) === false);

console.log('\nEvery surface consumes the same predicate');
const surfaces = { 'script.js (Home)': 'isProductAgeRestricted', 'category.js (Shop)': 'isProductAgeRestricted', 'product.js (detail)': 'isProductAgeRestricted' };
Object.entries(surfaces).forEach(([f, needle]) => {
  const p = path.join(ROOT, f.split(' ')[0]);
  ck(f + ' calls the canonical predicate', fs.readFileSync(p, 'utf8').includes(needle));
});
ck('product.html loads adult-gate.js (was the bypass)',
   fs.readFileSync(path.join(ROOT, 'product.html'), 'utf8').includes('adult-gate.js'));
ck('category.js no longer defines a duplicate category list',
   !/const\s+ADULT_CATS_CAT\s*=/.test(fs.readFileSync(path.join(ROOT, 'category.js'), 'utf8')));

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
