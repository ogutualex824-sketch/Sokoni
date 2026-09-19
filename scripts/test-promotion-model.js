#!/usr/bin/env node
/* The promotion resolver, asserted. Pure logic, no network, no emulator.
 *
 *   node scripts/test-promotion-model.js
 *
 * WHY IT MATTERS MORE THAN A UI TEST
 * This decides what a customer is TOLD they will pay. It is not the pricing authority — the
 * server still decides what is charged — but a quote that disagrees with the charge is a
 * trust failure even when the money is right. So the arithmetic is pinned here, including
 * the cases that produce a WRONG total quietly: an offer that outlives its schedule, a
 * discount larger than the basket, two exclusive offers both applying, and a resolution that
 * depends on the order offers happen to arrive in.
 */
'use strict';
const P = require('../sokoni-promotion-model.js');
let pass = 0; const fails = [];
const ck = (n, c, d) => { if (c) { pass++; console.log('    ok   ' + n); }
  else { fails.push(n); console.log('    FAIL ' + n + (d ? '   [' + d + ']' : '')); } };
const B = () => ({ lines: [{ listingId:'a', price:1000, qty:3 }], deliveryFee:100 });

console.log('\n' + '='.repeat(78));
console.log('  PROMOTION MODEL — deterministic resolution');
console.log('='.repeat(78));

console.log('\n  A  the worked example resolves exactly');
const pizza = P.resolve({ lines:[
  { listingId:'pizza-bbq', price:1200, qty:1 }, { listingId:'pizza-pep', price:1200, qty:1 },
  { listingId:'garlic', price:450, qty:1 }, { listingId:'soda', price:200, qty:4 }],
  deliveryFee:150, fulfilment:'delivery' }, [
  { id:'family', name:'Family Pizza Night', type:'bundle', bundlePrice:2999, priority:10, status:'live',
    items:[{listingId:'pizza-bbq',qty:1},{listingId:'pizza-pep',qty:1},{listingId:'garlic',qty:1},{listingId:'soda',qty:4}] },
  { id:'weekend', name:'Weekend Offer', type:'fixed', amount:200, priority:5, status:'live' },
  { id:'freedel', name:'Free Delivery', type:'freeDelivery', priority:1, status:'live' }], {});
ck('A  subtotal 3,650', pizza.subtotal === 3650, String(pizza.subtotal));
ck('A  total 2,799', pizza.total === 2799, String(pizza.total));
ck('A  every applied offer is named in the explanation',
   pizza.explain.filter(e => e.amount < 0).length === pizza.applied.length);
ck('A  it declares itself advisory, not authoritative', /server decides/.test(pizza.advisory));

console.log('\n  B  exclusivity picks the BEST, not the first');
const ex = P.resolve(B(), [
  { id:'flash', type:'percentage', percent:20, stacking:'exclusive', status:'live' },
  { id:'member', type:'percentage', percent:30, stacking:'exclusive', status:'live' }], {});
ck('B  exactly one applies', ex.applied.length === 1);
ck('B  the larger saving wins', ex.applied[0].id === 'member', ex.applied[0].id);
ck('B  the excluded offer is explained', ex.rejected.some(r => /excluded by/.test(r.why)));

console.log('\n  C  schedule is a window, not a date range');
const hh = { id:'hh', type:'percentage', percent:20, status:'live',
             schedule:{ days:['mon','tue','wed','thu','fri'], from:'17:00', to:'19:00' } };
ck('C  live inside the window', P.isLive(hh, new Date('2026-09-18T18:00:00')));
ck('C  not live one minute before', !P.isLive(hh, new Date('2026-09-18T16:59:00')));
ck('C  not live on an excluded day', !P.isLive(hh, new Date('2026-09-20T18:00:00')));
ck('C  a window crossing midnight still works',
   P.isLive({ id:'m', type:'percentage', percent:10, status:'live', schedule:{ from:'22:00', to:'02:00' } },
            new Date('2026-09-18T23:30:00')));
ck('C  a BROKEN schedule fails CLOSED',
   !P.isLive({ id:'b', type:'percentage', percent:10, status:'live', schedule:{ from:'oops', to:'19:00' } }, new Date()),
   'an unreadable window must not run forever');

console.log('\n  D  limits, caps and floors');
ck('D  an exhausted limit blocks', !P.withinLimits({ totalRedemptionLimit:5 }, { totalRedemptions:5 }));
ck('D  an ABSENT counter is unmetered, not exhausted', P.withinLimits({ totalRedemptionLimit:5 }, {}));
ck('D  maxDiscount caps the amount',
   P.resolve(B(), [{ id:'c', type:'percentage', percent:50, maxDiscount:100, status:'live' }], {}).discount === 100);
const neg = P.resolve({ lines:[{ listingId:'a', price:100, qty:1 }], deliveryFee:0 },
                      [{ id:'big', type:'fixed', amount:99999, status:'live' }], {});
ck('D  a discount never exceeds the basket', neg.total === 0 && neg.discount === 100, 'total ' + neg.total);

console.log('\n  E  buy X get Y discounts the CHEAPEST qualifying item');
ck('E  3 items under buy-2-get-1 frees one',
   P.resolve(B(), [{ id:'bx', type:'buyXgetY', buyQty:2, getQty:1, status:'live' }], {}).discount === 1000);

console.log('\n  F  determinism — input order cannot change the total');
const offs = [{ id:'x', type:'percentage', percent:10, priority:1, status:'live' },
              { id:'y', type:'fixed', amount:300, priority:9, status:'live' }];
const r1 = P.resolve(B(), offs, {}), r2 = P.resolve(B(), offs.slice().reverse(), {});
ck('F  same basket, same total regardless of order', r1.total === r2.total, r1.total + ' vs ' + r2.total);
ck('F  higher priority resolves first', r1.applied[0].id === 'y');

console.log('\n  G  malformed input is safe, never a wrong number');
ck('G  empty basket', P.resolve({ lines:[] }, [], {}).total === 0);
ck('G  null everything', P.resolve(null, null, null).total === 0);
ck('G  an unknown offer type is rejected with a reason',
   P.resolve(B(), [{ id:'weird', type:'not-a-type', status:'live' }], {}).rejected.some(r => /unknown offer type/.test(r.why)));

console.log('\n' + '='.repeat(78));
console.log('  PROMOTION MODEL   PASS ' + pass + '   FAIL ' + fails.length);
if (fails.length) fails.forEach(f => console.log('    x ' + f));
console.log('='.repeat(78) + '\n');
process.exit(fails.length ? 1 : 0);
