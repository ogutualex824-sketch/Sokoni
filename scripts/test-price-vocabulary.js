/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — PRICE VOCABULARY and BUSINESS CONTEXT
   scripts/test-price-vocabulary.js      node scripts/test-price-vocabulary.js

   KES 12,500 is a different promise for a room than for a kettle: one is per night, the
   other is the whole thing. The unit belongs to the type authority so the card and the
   listing page cannot disagree.

   THE ASSERTION THAT MATTERS MOST is about the word "From". The spec writes "From KES
   12,500 / night" and "From KES 6,500", and the tempting build prints "From" on every
   listing of those types. On a single fixed price that is a lie of the most ordinary kind:
   it implies a cheaper option that does not exist. "From" therefore appears only when the
   listing really does start at that figure.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const LT = require(path.join(ROOT, 'sokoni-listing-types.js'));

let pass = 0, fail = 0;
function ok (name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  → ' + detail : '')); }
}
function section (t) { console.log('\n' + t); }

/* ── 1. THE UNIT COMES FROM THE TYPE ────────────────────────────────────────── */
section('Price unit');
{
  ok('a room is priced per night',
     LT.priceText({ listingType: 'room', price: 12500 }) === 'KES 12,500 / night');
  ok('a rental is priced per day',
     LT.priceText({ listingType: 'rental', price: 3000 }) === 'KES 3,000 / day');
  ok('a product has no unit',
     LT.priceText({ listingType: 'product', price: 2500 }) === 'KES 2,500');
  ok('food has no unit',
     LT.priceText({ listingType: 'food', price: 850 }) === 'KES 850');

  /* A SERVICE IS PRICED PER JOB unless the merchant says otherwise. Inventing "/ hour"
     would be a claim about billing that nobody made. */
  ok('a service is not given an invented unit',
     LT.priceText({ listingType: 'service', price: 6500 }) === 'KES 6,500');
  ok('control — a type WITH a unit does show one',
     LT.priceText({ listingType: 'room', price: 100 }).indexOf('/ night') > -1);
}

/* ── 2. "FROM" IS EARNED ────────────────────────────────────────────────────── */
section('The word From');
{
  ok('a single fixed price does not say From',
     LT.priceText({ listingType: 'room', price: 12500 }).indexOf('From') === -1);

  /* Variants that all cost the same are not a range either. */
  ok('identical variant prices do not say From',
     LT.priceText({ listingType: 'room', price: 12500,
       variants: [{ price: 12500 }, { price: 12500 }] }).indexOf('From') === -1);

  /* THE CONTROL: genuinely differing prices DO. */
  ok('control — differing variant prices DO say From',
     LT.priceText({ listingType: 'room', price: 18000,
       variants: [{ price: 12500 }, { price: 18000 }] }) === 'From KES 12,500 / night');
  ok('and it is the LOWEST that is quoted',
     LT.priceLabel({ price: 900, variants: [{ price: 400 }, { price: 700 }] }).amount === 400);

  ok('a variant cheaper than the base is still the start',
     LT.priceText({ listingType: 'product', price: 2000, variants: [{ price: 1500 }] })
       === 'From KES 1,500');
}

/* ── 3. NO PRICE IS NOT A ZERO ──────────────────────────────────────────────── */
section('Absent price');
{
  ok('no price yields null, never "KES 0"', LT.priceText({ listingType: 'room' }) === null);
  ok('a zero price yields null too',
     LT.priceText({ listingType: 'product', price: 0 }) === null);
  ok('rubbish yields null',
     LT.priceText({ listingType: 'product', price: 'ask us' }) === null);
  ok('priceLabel agrees', LT.priceLabel({}) === null);
  /* Control — a real price is never null. */
  ok('control — a real price is returned',
     LT.priceLabel({ price: 10 }) !== null);

  /* Unpriced variants must not drag the quote to zero. */
  ok('variants with no price are ignored, not treated as free',
     LT.priceLabel({ price: 500, variants: [{ name: 'Blue' }, { price: 0 }] }).amount === 500);
}

/* ── 4. THE CARD USES IT, AND STILL DEGRADES ────────────────────────────────── */
section('Card wiring');
{
  const s = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
  ok('the card asks the type authority', /SokoniListingTypes\.priceText/.test(s));
  ok('both price positions use it',
     (s.match(/_cardPriceText\(product, price\)/g) || []).length === 2);
  ok('and the output is escaped', /_escHtml\(_cardPriceText/.test(s));
  /* A CARD MUST NEVER LOSE ITS PRICE because a module did not load. */
  ok('it falls back to the plain figure', /return 'KES ' \+ plain;/.test(s));
  ok('and the fallback is inside a catch', /catch \(_\) \{\}\s*\n\s*return 'KES ' \+ plain;/.test(s));
}

/* ── 5. BUSINESS CONTEXT ────────────────────────────────────────────────────── */
section('Business context');
{
  const p = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-products.js'), 'utf8');
  const code = p.replace(/\/\*[\s\S]*?\*\//g, '');
  const fn = code.slice(code.indexOf('function businessContextHTML'),
                        code.indexOf('function editorHTML'));
  ok('the editor states where the listing is going', fn.indexOf('Listing goes to') > -1);
  ok('it reads the shop the shell already resolved', /ctx\.shopName/.test(fn));

  /* IT SHOWS, IT DOES NOT SWITCH. The shell owns workspace switching and reloads
     deliberately; a second switcher here would duplicate it or fake it. */
  ok('it offers no switcher of its own',
     fn.indexOf('<select') === -1 && fn.indexOf('data-pr="switch') === -1);
  ok('and points at the control that works', fn.indexOf('Switch business from the shop menu') > -1);

  /* AN UNRESOLVED SHOP IS SAID, not papered over with a default name. */
  ok('an unknown destination is stated plainly', fn.indexOf('No shop resolved') > -1);
  ok('and warns it cannot be saved', fn.indexOf('cannot be saved yet') > -1);
  ok('no placeholder shop name is invented',
     fn.indexOf("'SOKONI'") === -1 && fn.indexOf("'My Shop'") === -1);

  ok('it is rendered above the type picker, since it is the wider question',
     code.indexOf('businessContextHTML()') < code.indexOf('typePickerHTML'));
}

console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
