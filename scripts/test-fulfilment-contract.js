/* ══════════════════════════════════════════════════════════════════════════════
   FULFILMENT CONTRACT
   ══════════════════════════════════════════════════════════════════════════════
   Three invariants, in order of how much damage breaking them does:

     1. PAYMENT AND DELIVERY ARE INDEPENDENT. Changing the rider must not move a
        single shilling, and there must never be a second order.
     2. THE RECEIPT NEVER INVENTS. No rider assigned means the receipt says so —
        it does not name a default rider, and it does not omit the line.
     3. PICKUP CARRIES NO DESTINATION, even when one is handed in. A pickup receipt
        printing an address tells the customer something untrue about their order.

   Plus the standing rule while the destination migration is unproven: this module
   must write NO production destination field.

   Run: node scripts/test-fulfilment-contract.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const F = require(path.join(ROOT, 'sokoni-fulfilment.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n' + t);
const threw = (fn) => { try { fn(); return false; } catch (_) { return true; } };

console.log('\nFULFILMENT CONTRACT');
console.log('='.repeat(74));

const DEST = { label: 'Home', recipientName: 'Alex', phone: '0712345678',
               building: 'Green Estate', unit: 'House 14', town: 'Nairobi',
               formatted: 'Green Estate · House 14 · Nairobi', instructions: 'Gate 2' };
const ORDER = { id: 'o1', items: [{ name: 'Phone', qty: 2, price: 18500 }],
                totals: { subtotal: 37000, delivery: 150, total: 37150 },
                payment: { method: 'mpesa', status: 'paid', received: 40000, change: 2850 },
                serverTimestamp: 'TS' };

head('1 - payment and delivery are independent');
const pickup = F.applyFulfilment(ORDER, { type: 'pickup' });
const deliver = F.applyFulfilment(ORDER, { type: 'delivery', destinationSnapshot: DEST });
const reassigned = F.applyFulfilment(deliver, {
  type: 'delivery', destinationSnapshot: DEST,
  assignment: { method: 'shop', rider: { uid: 'r1', name: 'Brian' } } });

ck('totals survive a fulfilment change', JSON.stringify(reassigned.totals) === JSON.stringify(ORDER.totals),
   JSON.stringify(reassigned.totals));
ck('payment survives a fulfilment change', JSON.stringify(reassigned.payment) === JSON.stringify(ORDER.payment));
ck('items survive a fulfilment change', JSON.stringify(reassigned.items) === JSON.stringify(ORDER.items));
ck('the server timestamp is untouched', reassigned.serverTimestamp === 'TS');
ck('the order id is unchanged — no second order', reassigned.id === ORDER.id);
ck('the ORIGINAL order object is not mutated', ORDER.fulfilment === undefined);
ck('switching pickup -> delivery -> assigned still costs the same',
   pickup.totals.total === deliver.totals.total && deliver.totals.total === reassigned.totals.total);

head('2 - the receipt never invents a rider');
const rUnassigned = F.receiptFulfilment(deliver.fulfilment);
ck('no rider -> the receipt SAYS not yet assigned',
   rUnassigned.lines.some((l) => l.indexOf(F.RIDER_UNASSIGNED) > -1), rUnassigned.lines[0]);
ck('...and does not omit the rider line entirely',
   rUnassigned.lines.some((l) => /^Rider:/.test(l)));
ck('...and names nobody', !/Brian|Kevin|John/.test(rUnassigned.lines.join(' ')));

const rSokoni = F.receiptFulfilment(F.buildFulfilment({
  type: 'delivery', destinationSnapshot: DEST, assignment: { method: 'sokoni' } }));
ck('method sokoni with NO rider still says not yet assigned',
   rSokoni.lines.some((l) => l.indexOf(F.RIDER_UNASSIGNED) > -1), rSokoni.lines[0]);
/* The heading is now the word the customer looks for — DELIVERY — and the method
   is a named line, so a receipt states BOTH where it is going and who brings it. */
ck('...while the METHOD is still named on the receipt',
   rSokoni.heading === 'DELIVERY' && rSokoni.lines.indexOf('Method: SOKONI Rider') > -1,
   rSokoni.lines.join(' | '));

const rShop = F.receiptFulfilment(reassigned.fulfilment);
ck('an assigned shop rider IS named', rShop.lines.some((l) => l.indexOf('Brian') > -1), rShop.lines[0]);

const rExt = F.receiptFulfilment(F.buildFulfilment({
  type: 'delivery', destinationSnapshot: DEST,
  assignment: { method: 'external', rider: { name: 'John', phone: '0722000111', plate: 'KCA 123A' } } }));
ck('an external rider is named with phone and plate',
   rExt.lines.indexOf('Method: External rider') > -1 && rExt.lines.join(' ').indexOf('KCA 123A') > -1 &&
   rExt.lines.join(' ').indexOf('John') > -1, rExt.lines.join(' | '));

head('3 - pickup carries no destination');
const forced = F.buildFulfilment({ type: 'pickup', destinationSnapshot: DEST, note: 'deliver please' });
ck('a destination handed to a pickup is DISCARDED', forced.destinationSnapshot === undefined);
const rPick = F.receiptFulfilment(forced);
ck('the pickup receipt is headed PICKUP and says where to collect',
   rPick.heading === 'PICKUP' && rPick.lines.join(' ') === 'Collected at the shop',
   rPick.heading + ': ' + rPick.lines.join(' '));
ck('...and prints no address', !/Green Estate|Nairobi|House 14/.test(rPick.lines.join(' ')));
ck('...and no rider line, because there is no delivery', !/Rider/.test(rPick.lines.join(' ')));

head('4 - refusals');
ck('an unknown fulfilment type is refused', threw(() => F.buildFulfilment({ type: 'teleport' })));
ck('a missing type is refused', threw(() => F.buildFulfilment({})));
ck('a delivery with NO destination is refused', threw(() => F.buildFulfilment({ type: 'delivery' })));
ck('an unknown delivery method is refused',
   threw(() => F.buildFulfilment({ type: 'delivery', destinationSnapshot: DEST, assignment: { method: 'drone' } })));
ck('an external rider with no phone is refused',
   threw(() => F.buildFulfilment({ type: 'delivery', destinationSnapshot: DEST,
     assignment: { method: 'external', rider: { name: 'John' } } })));
ck('an external rider with no name is refused',
   threw(() => F.buildFulfilment({ type: 'delivery', destinationSnapshot: DEST,
     assignment: { method: 'external', rider: { phone: '0722000111' } } })));

head('5 - "assign later" is a real answer, not a failure');
const later = F.buildFulfilment({ type: 'delivery', destinationSnapshot: DEST, assignment: { method: 'shop' } });
ck('method chosen, rider deferred -> status unassigned', later.assignment.status === 'unassigned');
ck('...and rider is null rather than a placeholder', later.assignment.rider === null);
ck('...and the receipt reflects it', F.receiptFulfilment(later).lines.some((l) => l.indexOf(F.RIDER_UNASSIGNED) > -1));

head('6 - no production destination field is written');
const src = fs.readFileSync(path.join(ROOT, 'sokoni-fulfilment.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
['deliveryAddress', 'dropoffAddress', 'dropoffLat', 'dropoffLng', 'deliveryCoords', 'deliveryLocation']
  .forEach((f) => ck('does not write ' + f, src.indexOf(f) === -1));
ck('projection() is inert until the migration gate clears', F.projection() === null);
ck('the built branch carries ONLY the contract keys',
   Object.keys(deliver.fulfilment).every((k) => ['type', 'destinationSnapshot', 'assignment', 'note'].indexOf(k) > -1),
   Object.keys(deliver.fulfilment).join(','));

head('7 - negative controls');
ck('NC the receipt CAN name a rider (so section 2 is not vacuous)',
   F.receiptFulfilment(reassigned.fulfilment).lines.join(' ').indexOf('Brian') > -1);
ck('NC a delivery DOES keep its destination (so section 3 is not vacuous)',
   deliver.fulfilment.destinationSnapshot === DEST);
ck('NC buildFulfilment really can throw', threw(() => F.buildFulfilment({ type: 'nope' })));

console.log('\n' + '='.repeat(74));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('='.repeat(74) + '\n');
process.exit(fail ? 1 : 0);
