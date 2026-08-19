/* ══════════════════════════════════════════════════════════════════════════════
   RECEIPT — COMPOSITION
   ══════════════════════════════════════════════════════════════════════════════
   This is the first test in the commerce set that proves the authorities work
   TOGETHER rather than each working alone. A receipt is where cash, fulfilment and
   the order meet, and it is the document a customer keeps — so the invariants that
   matter most are about not lying:

     · the time is the SERVER's, and a missing one is STATED, never substituted
       with the device clock
     · the total is the order's authoritative figure, never recomputed here
     · a pickup NEVER shows a destination
     · an unassigned rider is named as unassigned
     · an M-PESA overpayment is not printed as change
     · the shared text and the printed text are ONE composition

   Run: node scripts/test-receipt-composition.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const Cash = require(path.join(ROOT, 'sokoni-cash.js'));
const Ful = require(path.join(ROOT, 'sokoni-fulfilment.js'));
const R = require(path.join(ROOT, 'sokoni-receipt.js'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n' + t);
const K = (n) => n * 100;

const SHOP = { name: "Alex's Store", phone: '0712345678' };
const DEST = { label: 'Home', recipientName: 'Alex', phone: '0712345678',
               building: 'Green Estate', unit: 'House 14', town: 'Nairobi',
               formatted: 'Green Estate · House 14 · Nairobi', instructions: 'Gate 2' };
const ITEMS = [{ name: 'Blue Phone', qty: 1, lineMinor: K(18500) },
               { name: 'Screen', qty: 1, lineMinor: K(3000) }];
const TS = new Date(Date.UTC(2026, 7, 19, 18, 45));

function order (extra) {
  return Object.assign({
    receiptId: 'SKN-2841', shop: SHOP, items: ITEMS, totalMinor: K(21500),
    createdAt: TS, customer: { name: 'Jane', phone: '0722000111' },
  }, extra || {});
}

console.log('\nRECEIPT — COMPOSITION');
console.log('='.repeat(74));

head('1 - a pickup sale, paid in cash');
const settleCash = Cash.settle({ totalMinor: K(21500), tenders: [{ method: 'cash', amountMinor: K(25000) }] });
const rPick = R.render(order({ settlement: settleCash, fulfilment: Ful.buildFulfilment({ type: 'pickup' }) }));
const tPick = R.toText(rPick);
ck('carries the shop identity', tPick.indexOf("Alex's Store") > -1);
ck('carries the receipt reference', tPick.indexOf('SKN-2841') > -1);
ck('carries the server time, formatted', /19 Aug 2026/.test(tPick), tPick.split('\n')[4]);
ck('lists both items', tPick.indexOf('Blue Phone') > -1 && tPick.indexOf('Screen') > -1);
ck('shows the authoritative total', tPick.indexOf('21,500') > -1);
ck('shows the cash tendered', tPick.indexOf('25,000') > -1);
ck('shows the CHANGE', /CHANGE\s+3,500/.test(tPick), (tPick.match(/CHANGE.*/) || [])[0]);
ck('says CUSTOMER PICKUP', tPick.indexOf('CUSTOMER PICKUP') > -1);
ck('prints NO destination on a pickup', !/Green Estate|House 14|Nairobi/.test(tPick));
ck('prints no rider line on a pickup', !/Rider/.test(tPick));
ck('no warnings on a complete order', rPick.warnings.length === 0, rPick.warnings.join('; '));

head('2 - a delivery sale, mixed payment, rider assigned');
const settleMixed = Cash.settle({ totalMinor: K(21500), tenders: [
  { method: 'mpesa', amountMinor: K(10000) }, { method: 'cash', amountMinor: K(12000) }] });
const rDel = R.render(order({ settlement: settleMixed,
  fulfilment: Ful.buildFulfilment({ type: 'delivery', destinationSnapshot: DEST,
    assignment: { method: 'shop', rider: { uid: 'r1', name: 'Brian' } } }) }));
const tDel = R.toText(rDel);
ck('both tenders appear', /MPESA\s+10,000/.test(tDel) && /CASH\s+12,000/.test(tDel));
ck('change is 500 and comes from the cash', /CHANGE\s+500/.test(tDel), (tDel.match(/CHANGE.*/) || [])[0]);
ck('the rider is named', tDel.indexOf('Brian') > -1);
ck('the destination is shown', tDel.indexOf('Green Estate · House 14 · Nairobi') > -1);
ck('the delivery instruction is shown', tDel.indexOf('Gate 2') > -1);
ck('the customer block is present', tDel.indexOf('Jane') > -1);

head('3 - it never invents');
const rNoRider = R.render(order({ settlement: settleCash,
  fulfilment: Ful.buildFulfilment({ type: 'delivery', destinationSnapshot: DEST, assignment: { method: 'sokoni' } }) }));
ck('an unassigned rider is NAMED as unassigned',
   R.toText(rNoRider).indexOf(Ful.RIDER_UNASSIGNED) > -1);
ck('...and nobody is invented', !/Brian|Kevin|John/.test(R.toText(rNoRider)));

const rNoCustomer = R.render(order({ customer: null, settlement: settleCash,
  fulfilment: Ful.buildFulfilment({ type: 'pickup' }) }));
/* Asserted on the BLOCK, not the text: "CUSTOMER PICKUP" contains the substring
   "CUSTOMER", so a text search reports a customer block on every pickup receipt that
   has none. Structure says what prose cannot. */
ck('no customer -> the block is ABSENT, not a placeholder',
   !rNoCustomer.blocks.some((b) => b.heading === 'CUSTOMER'),
   rNoCustomer.blocks.map((b) => b.heading || b.type).join(','));
ck('...while an order WITH a customer does get the block (not vacuous)',
   rDel.blocks.some((b) => b.heading === 'CUSTOMER'));

const rMpesaOver = R.render(order({
  settlement: Cash.settle({ totalMinor: K(21500), tenders: [{ method: 'mpesa', amountMinor: K(25000) }] }),
  fulfilment: Ful.buildFulfilment({ type: 'pickup' }) }));
ck('an M-PESA overpayment prints OVERPAID, never CHANGE',
   /OVERPAID/.test(R.toText(rMpesaOver)) && !/CHANGE/.test(R.toText(rMpesaOver)));

head('4 - the server timestamp is the authority');
const noTime = R.render(order({ createdAt: null, settlement: settleCash,
  fulfilment: Ful.buildFulfilment({ type: 'pickup' }) }));
ck('a missing server time is STATED', R.toText(noTime).indexOf('Time not recorded') > -1);
ck('...and warned about', noTime.warnings.some((w) => /server timestamp/.test(w)), noTime.warnings.join('; '));
ck('...and the device clock is NOT substituted',
   R.toText(noTime).indexOf(String(new Date().getFullYear()) + '-') === -1 &&
   !new RegExp(R.formatTime(Date.now()) || 'xxx').test(R.toText(noTime)));
ck('a Firestore Timestamp is accepted', /19 Aug 2026/.test(
   R.toText(R.render(order({ createdAt: { toDate: () => TS }, settlement: settleCash,
     fulfilment: Ful.buildFulfilment({ type: 'pickup' }) })))));

head('5 - the total is not recomputed here');
const wrongTotal = R.render(order({ totalMinor: K(999), settlement: settleCash,
  fulfilment: Ful.buildFulfilment({ type: 'pickup' }) }));
ck('it prints the ORDER total, even when it disagrees with the items',
   R.toText(wrongTotal).indexOf('TOTAL   999') > -1, (R.toText(wrongTotal).match(/TOTAL.*/) || [])[0]);
ck('a missing total is warned about, not guessed',
   R.render(order({ totalMinor: null, settlement: settleCash,
     fulfilment: Ful.buildFulfilment({ type: 'pickup' }) })).warnings.some((w) => /authoritative total/.test(w)));

head('6 - print is optional, share is not a second document');
ck('a receipt is shareable and printable from ONE composition',
   rDel.shareable === true && rDel.printable === true);
ck('toText is derived from the same blocks the screen renders',
   R.toText(rDel).indexOf('Brian') > -1 && rDel.blocks.some((b) =>
     (b.lines || []).some((l) => typeof l === 'string' && l.indexOf('Brian') > -1)));
ck('a receipt with no printer is still complete', R.toText(rPick).split('\n').length > 6);

head('7 - negative controls');
ck('NC the destination DOES appear on a delivery (so section 1 is not vacuous)',
   tDel.indexOf('Green Estate') > -1);
ck('NC a rider IS named when assigned (so section 3 is not vacuous)', tDel.indexOf('Brian') > -1);
ck('NC CHANGE does appear when cash produced it (so section 3 is not vacuous)', /CHANGE/.test(tPick));
ck('NC an empty order produces warnings rather than a clean receipt',
   R.render({}).warnings.length >= 3, String(R.render({}).warnings.length));

console.log('\n' + '='.repeat(74));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('='.repeat(74) + '\n');
process.exit(fail ? 1 : 0);
