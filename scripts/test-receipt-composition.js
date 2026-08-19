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
/* The device clock must not appear ANYWHERE on a receipt with no server time —
   including the copyright year, which previously fell back to new Date(). */
ck('...and the device clock is NOT substituted, anywhere',
   !new RegExp(String(new Date().getFullYear())).test(R.toText(noTime)),
   (R.toText(noTime).match(/©.*/) || [])[0]);
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

head('8 - branded merchant identity, every line conditional');
const full = R.render(order({ settlement: settleCash, fulfilment: Ful.buildFulfilment({ type: 'pickup' }),
  shop: { name: "Alex's Store", phone: '0712345678', email: 'shop@x.co.ke',
          address: 'Ngong Rd', city: 'Nairobi', logo: 'https://x/logo.png' },
  tax: { kraPin: 'P051234567X' }, terminalId: 'TILL-2', cashierName: 'Mary' }));
const tFull = R.toText(full);
ck('the shop name leads', tFull.split(String.fromCharCode(10))[0] === "Alex's Store", tFull.split(String.fromCharCode(10))[0]);
ck('SOKONI is named', tFull.indexOf('SOKONI') > -1);
ck('powered by Bravilex', tFull.indexOf('Powered by ' + R.BRAVILEX) > -1);
ck('phone, email and location appear', /0712345678/.test(tFull) && /shop@x.co.ke/.test(tFull) && /Ngong Rd, Nairobi/.test(tFull));
ck('KRA PIN appears when the merchant has one', tFull.indexOf('KRA PIN: P051234567X') > -1);
ck('the logo is carried as a URL for the screen', full.blocks[0].logo === 'https://x/logo.png');
ck('a REAL terminal is named', tFull.indexOf('Terminal: TILL-2') > -1);
ck('the cashier is named', tFull.indexOf('Served by: Mary') > -1);

const bare = R.render(order({ settlement: settleCash, fulfilment: Ful.buildFulfilment({ type: 'pickup' }),
  shop: { name: 'Kiosk' } }));
const tBare = R.toText(bare);
ck('NO terminal on a phone sale — the line is ABSENT, not invented', tBare.indexOf('Terminal') === -1);
ck('no KRA PIN when the merchant has none', tBare.indexOf('KRA PIN') === -1);
ck('no cashier line when unknown', tBare.indexOf('Served by') === -1);
ck('no email or address lines when unset', !/@/.test(tBare.split('------')[0]));
ck('...but the SOKONI + Bravilex identity is still present',
   tBare.indexOf('SOKONI') > -1 && tBare.indexOf(R.BRAVILEX) > -1);

head('9 - itemised totals');
const priced = R.render(order({ settlement: settleCash, fulfilment: Ful.buildFulfilment({ type: 'pickup' }),
  items: [{ name: 'Blue Phone', qty: 2, unitMinor: K(9000) }],
  totals: { subtotalMinor: K(18000), discountMinor: K(500), deliveryMinor: K(150), taxMinor: K(80), totalMinor: K(17730) } }));
const tPriced = R.toText(priced);
ck('unit price and line total both shown', /9,000 ea/.test(tPriced) && /18,000/.test(tPriced));
ck('subtotal shown', /Subtotal   18,000/.test(tPriced));
ck('discount shown as a deduction', /Discount   -500/.test(tPriced), (tPriced.match(/Discount.*/) || [])[0]);
ck('delivery fee shown', /Delivery   150/.test(tPriced));
ck('tax shown', /Tax   80/.test(tPriced));
ck('a zero discount is OMITTED, not printed as 0',
   R.toText(R.render(order({ settlement: settleCash, fulfilment: Ful.buildFulfilment({ type: 'pickup' }),
     totals: { subtotalMinor: K(100), discountMinor: 0, totalMinor: K(100) } }))).indexOf('Discount') === -1);

head('10 - the close brings the customer back to SOKONI');
ck('thanks the customer', tFull.indexOf('Thank you for shopping with us') > -1);
ck('offers help INSIDE SOKONI', tFull.indexOf('Message us on SOKONI') > -1);
ck('...and does NOT send them to WhatsApp', !/whatsapp/i.test(tFull));
ck('carries the SOKONI tagline', tFull.indexOf(R.TAGLINE) > -1);
ck('carries the Bravilex copyright', /© 2026 BRAVILEX INTERNATIONAL CO. LIMITED/.test(tFull),
   (tFull.match(/©.*/) || [])[0]);

head('7 - negative controls');
ck('NC the destination DOES appear on a delivery (so section 1 is not vacuous)',
   tDel.indexOf('Green Estate') > -1);
ck('NC a rider IS named when assigned (so section 3 is not vacuous)', tDel.indexOf('Brian') > -1);
ck('NC CHANGE does appear when cash produced it (so section 3 is not vacuous)', /CHANGE/.test(tPick));
ck('NC an empty order produces warnings rather than a clean receipt',
   R.render({}).warnings.length >= 3, String(R.render({}).warnings.length));

head('11 - it does not squat on a global that is already in use');
/* `window.SokoniReceipt` belongs to the EXISTING POS receipt path and carries a
   .print()/.doc() API this module does not have. Claiming it would break printing
   on any page that loads both — and the page would look fine right up until a
   merchant tried to print. */
const fs2 = require('fs');
const self = fs2.readFileSync(path.join(ROOT, 'sokoni-receipt.js'), 'utf8');
ck('this module publishes SokoniReceiptDoc', /global\.SokoniReceiptDoc =/.test(self));
ck('...and never assigns window/global SokoniReceipt',
   !/(global|window)\.SokoniReceipt\s*=/.test(self));
/* Prove the name really is occupied, rather than trusting the claim. */
const OWNERS = ['pos-checkout.html', 'pos-marketplace.html', 'pos-printer.js'];
const users = OWNERS.filter((f) => {
  try { return /window\.SokoniReceipt\b(?!Doc|Engine)/.test(fs2.readFileSync(path.join(ROOT, f), 'utf8')); }
  catch (_) { return false; }
});
ck('the old name IS in use by the existing POS path', users.length === 3, users.join(', '));
ck('NC ...and the detector does not confuse it with SokoniReceiptEngine',
   !/window\.SokoniReceipt\b(?!Doc|Engine)/.test('window.SokoniReceiptEngine.print()'));
ck('NC ...nor with the new name', !/window\.SokoniReceipt\b(?!Doc|Engine)/.test('window.SokoniReceiptDoc.render()'));
ck('NC ...but DOES catch a real squat', /window\.SokoniReceipt\b(?!Doc|Engine)/.test('window.SokoniReceipt = {}'));

console.log('\n' + '='.repeat(74));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('='.repeat(74) + '\n');
process.exit(fail ? 1 : 0);
