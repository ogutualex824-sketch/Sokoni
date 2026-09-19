#!/usr/bin/env node
/* The listing field configuration, quality assessment and lifecycle, asserted.
 *   node scripts/test-listing-model.js
 * The quality score decides what a merchant is TOLD is missing. A score that flatters an
 * incomplete listing is worse than no score: it tells them to stop working. */
'use strict';
require('../sokoni-listing-types.js');
const M = require('../sokoni-listing-model.js');
let pass = 0; const fails = [];
const ck = (n,c,d)=>{ if(c){pass++;console.log('    ok   '+n);} else {fails.push(n);console.log('    FAIL '+n+(d?'   ['+d+']':''));} };

console.log('\n' + '='.repeat(78));
console.log('  LISTING MODEL — one engine, many field configurations');
console.log('='.repeat(78));

console.log('\n  A  each type collects its own fields over one common core');
const keysFor = l => M.fieldsFor(l).map(f=>f.key);
ck('A  food asks for allergens',      keysFor({category:'food'}).includes('allergens'));
ck('A  a product does NOT',          !keysFor({category:'electronics'}).includes('allergens'));
ck('A  a room asks for check-in',     keysFor({category:'hotel'}).includes('checkIn'));
ck('A  a vehicle asks for mileage',   keysFor({category:'vehicles'}).includes('mileage'));
ck('A  a property asks for bedrooms', keysFor({category:'property'}).includes('bedrooms'));
ck('A  every type still has the common core',
   ['food','hotel','services','vehicles','property'].every(c => {
     const k = keysFor({category:c});
     return ['name','description','price','category','location'].every(x => k.includes(x));
   }));
ck('A  an unknown type falls back to product fields',
   keysFor({category:'widgets'}).includes('sku'));

console.log('\n  B  media groups are metadata over ONE pipeline');
ck('B  a hotel groups by room and view', M.mediaGroupsFor({category:'hotel'}).includes('View'));
ck('B  a restaurant groups by dish',     M.mediaGroupsFor({category:'food'}).includes('Dish'));

console.log('\n  C  quality names what is missing, it does not just score');
const bare = M.quality({ category:'food' });
ck('C  an empty listing scores low',      bare.score < 25, String(bare.score));
ck('C  and lists what is missing',        bare.missing.length > 0);
ck('C  required gaps are marked blocking', bare.blocking.length > 0);
ck('C  a missing main image BLOCKS',       bare.blocking.some(b=>/Main image/.test(b.label)));

const good = M.quality({ category:'food', name:'Alfredo', description:'Creamy pasta',
  price:850, location:'nairobi', cuisine:'Italian', portion:'Large', prepTime:25,
  ingredients:['Pasta'], allergens:['Milk'], dietary:['Halal'], addOns:['Cheese'],
  stock:20, images:['a','b','c'] });
ck('C  a complete listing scores high', good.score >= 90, String(good.score));
ck('C  and has nothing blocking',       good.blocking.length === 0);

const twoPhotos = M.quality({ category:'food', name:'x', description:'y', price:1,
  location:'nairobi', images:['a','b'] });
ck('C  2 photos asks for 1 more, and does not block',
   twoPhotos.missing.some(m=>/Add 1 more photo\b/.test(m.label)) &&
   !twoPhotos.blocking.some(b=>/photo/i.test(b.label)));

console.log('\n  D  publishing is gated, saving a draft is not');
ck('D  an incomplete listing cannot publish', M.validate({category:'food'}).ok === false);
ck('D  a complete one can',                   M.validate({ category:'product', name:'a',
    description:'b', price:1, location:'nairobi', stock:5, images:['1','2','3'] }).ok === true);

console.log('\n  E  lifecycle transitions are explicit');
ck('E  draft -> live',        M.canTransition('draft','live'));
ck('E  live -> paused',       M.canTransition('live','paused'));
ck('E  archived -> draft',    M.canTransition('archived','draft'));
ck('E  live -> draft is NOT a transition', !M.canTransition('live','draft'),
   'a live listing is paused or archived, never silently un-published');
ck('E  an unknown state transitions nowhere', !M.canTransition('nonsense','live'));

console.log('\n  F  malformed input is safe');
ck('F  null listing', M.quality(null).score >= 0);
ck('F  null validate', M.validate(null).ok === false);

console.log('\n' + '='.repeat(78));
console.log('  LISTING MODEL   PASS ' + pass + '   FAIL ' + fails.length);
if (fails.length) fails.forEach(f=>console.log('    x '+f));
console.log('='.repeat(78) + '\n');
process.exit(fails.length?1:0);
