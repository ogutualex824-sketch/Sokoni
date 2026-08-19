/* ══════════════════════════════════════════════════════════════════════════════
   SELL COMPOSITION — the till composes the authorities, and writes no destination
   ══════════════════════════════════════════════════════════════════════════════
   The Sell screen now composes five separately-proven modules:

     SokoniCash            change, balance, overpayment — integer cents
     SokoniFulfilment      pickup vs delivery, destinationSnapshot, rider
     SokoniBuyerLocations  the address shape
     SokoniReceiptDoc         the branded document
     SokoniSaleSubmit      the idempotency key

   Two things must be true here, and they pull in opposite directions:

     1. the fulfilment IS captured, shown, and printed on the receipt
     2. the destination is NOT written to the production order

   (2) is the migration gate. Production orders carry the destination under two
   live spellings (`deliveryAddress`, `address`, both 100%) and nine dead ones,
   with geometry entirely absent — see docs/CANONICAL_ORDER_DESTINATION.md. Adding
   a twelfth spelling from the till while those are still being reconciled is the
   one outcome that would make the migration harder.

   So this suite proves the checkout payload carries NO destination under ANY known
   spelling, at RUNTIME against the real payload builder — and then proves the
   detector is not vacuous by planting destinations and catching them.

   Run: node scripts/test-sell-composition.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n' + t);

/* Every spelling the census found, live or dead. */
const ADDRESS_KEYS = ['deliveryAddress', 'dropoffAddress', 'address', 'deliveryLocation',
                      'destination', 'destinationSnapshot', 'dropoffLocation'];
const GEO_KEYS = ['dropoffLat', 'dropoffLng', 'deliveryCoords', 'dropLat', 'dropLng',
                  'deliveryLat', 'deliveryLng'];
const ALL_DEST_KEYS = ADDRESS_KEYS.concat(GEO_KEYS);

/* Walks the WHOLE payload, not just its top level — a destination tucked under
   `metadata` would be just as much a twelfth spelling. */
function destKeysIn (obj) {
  const seen = [];
  const found = [];
  (function walk (o, trail) {
    if (!o || typeof o !== 'object' || seen.indexOf(o) > -1) return;
    seen.push(o);
    Object.keys(o).forEach((k) => {
      const at = (trail ? trail + '.' : '') + k;
      if (ALL_DEST_KEYS.indexOf(k) > -1) found.push(at);
      walk(o[k], at);
    });
  })(obj, '');
  return found;
}

console.log('\nSELL COMPOSITION — authorities composed, destination NOT written');
console.log('='.repeat(74));

const sell = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-sell.js'), 'utf8');
/* Comments are stripped before every static assertion. A comment that MENTIONS
   SokoniCash is not a use of it, and that exact mistake has already produced one
   false positive in this repo. */
const code = sell.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

head('1 - the till composes; it does not reimplement');
ck('change comes from SokoniCash', /SokoniCash/.test(code) && /\bC\.settle\(/.test(code));
ck('fulfilment comes from SokoniFulfilment', /SokoniFulfilment/.test(code) && /buildFulfilment\(/.test(code));
ck('the address shape comes from SokoniBuyerLocations',
   /SokoniBuyerLocations/.test(code) && /L\.normalise\(/.test(code) && /L\.snapshot\(/.test(code));
ck('the receipt comes from SokoniReceiptDoc',
   /SokoniReceiptDoc/.test(code) && /R\.render\(/.test(code) && /R\.toText\(/.test(code));
ck('the OLD inline change arithmetic is gone',
   !/given\s*-\s*t\.subtotal/.test(code), (code.match(/given\s*-\s*t\.subtotal/) || ['absent'])[0]);
ck('...and no other local subtraction stands in for it',
   !/cashGiven\s*-/.test(code) && !/-\s*t\.subtotal/.test(code));
ck('a missing authority DEGRADES rather than falling back to local maths',
   /if \(!C\) return null;/.test(code) && /if \(!R\) return null;/.test(code));

head('2 - the checkout payload carries NO destination — proven at runtime');
const md = require(path.join(ROOT, 'sokoni-merchant-data.js'));
const SCOPE = { ok: true, shopId: 'shop1', sellerUid: 'u1' };
const CART = [{ productId: 'p1', qty: 2, price: 250, name: 'Sugar 1kg' }];
/* Everything a caller might try to smuggle through, passed deliberately. */
const payload = md.buildSale({
  scope: SCOPE, cart: CART, saleToken: 'tok1',
  payments: [{ method: 'cash', amount: 500 }],
  fulfilment: { type: 'delivery', destinationSnapshot: { line1: 'Kilimani, Nairobi' } },
  destinationSnapshot: { line1: 'Kilimani, Nairobi' },
  deliveryAddress: 'Kilimani, Nairobi',
  dropoffLat: -1.29, dropoffLng: 36.78,
});
const leaked = destKeysIn(payload);
ck('the built payload contains NO destination key, anywhere',
   leaked.length === 0, leaked.length ? leaked.join(', ') : 'clean against ' + ALL_DEST_KEYS.length + ' spellings');
ck('because buildSale is an ALLOWLIST, not a spread of its input',
   !/\.\.\.o\b/.test(fs.readFileSync(path.join(ROOT, 'sokoni-merchant-data.js'), 'utf8')));
ck('the payload still carries the sale itself',
   payload.items.length === 1 && payload.grandTotal === 500, 'grandTotal ' + payload.grandTotal);

head('3 - NEGATIVE CONTROL: the detector is not vacuous');
/* If the walker cannot see a planted destination, section 2 proves nothing. */
const planted = JSON.parse(JSON.stringify(payload));
planted.deliveryAddress = 'Kilimani, Nairobi';
ck('NC a top-level destination IS detected', destKeysIn(planted).indexOf('deliveryAddress') > -1);
const nested = JSON.parse(JSON.stringify(payload));
nested.metadata.dropoffLat = -1.29;
ck('NC a NESTED destination is detected too',
   destKeysIn(nested).indexOf('metadata.dropoffLat') > -1, destKeysIn(nested).join(','));
const deep = JSON.parse(JSON.stringify(payload));
deep.metadata.extra = { fulfilment: { destinationSnapshot: { line1: 'x' } } };
ck('NC ...at any depth',
   destKeysIn(deep).indexOf('metadata.extra.fulfilment.destinationSnapshot') > -1, destKeysIn(deep).join(','));
ck('NC and a clean payload still reports clean',
   destKeysIn(JSON.parse(JSON.stringify(payload))).length === 0);

head('4 - the fulfilment IS captured, and reaches the receipt');
const Cash = require(path.join(ROOT, 'sokoni-cash.js'));
const Ful = require(path.join(ROOT, 'sokoni-fulfilment.js'));
const Loc = require(path.join(ROOT, 'sokoni-buyer-locations.js'));
const Rcpt = require(path.join(ROOT, 'sokoni-receipt.js'));

const place = Loc.normalise({ label: 'Other', street: 'Kilimani, Nairobi' });
ck('a typed line normalises to a deliverable place', Loc.isDeliverable(place), Loc.formatted(place));
const snap = Loc.snapshot(place, null);
ck('...and its capturedAt is NULL, awaiting a SERVER stamp', snap.capturedAt === null);

const ful = Ful.buildFulfilment({ type: 'delivery', destinationSnapshot: snap });
const settled = Cash.settle({ totalMinor: 50000, tenders: [{ method: 'cash', amountMinor: 100000 }] });
const SALE = {
  receiptId: 'R-1001', createdAt: '2026-08-19T09:15:00Z',
  items: [{ name: 'Sugar 1kg', qty: 2, unitMinor: 25000, lineMinor: 50000 }],
  totalMinor: 50000, totals: { subtotalMinor: 50000 },
  settlement: settled, fulfilment: ful,
  shop: { name: "Alex's Store", phone: '0712345678' },
};
const text = Rcpt.toText(Rcpt.render(SALE, {}));
ck('the DELIVERY destination appears on the receipt', text.indexOf('Kilimani') > -1);
ck('the change appears on the receipt', /CHANGE/.test(text));
ck('the branded identity is on it',
   /SOKONI/.test(text) && text.replace(/\s+/g, ' ').indexOf(Rcpt.BRAVILEX) > -1);

head('5 - the receipt time is the SERVER time, or it says so');
ck('a sale WITH a server timestamp prints that date',
   text.indexOf('2026') > -1 && /\d{2}:\d{2}/.test(text), (text.match(/\d\d \w\w\w \d{4}[^\n]*/) || [''])[0]);
const noTime = Rcpt.toText(Rcpt.render(Object.assign({}, SALE, { createdAt: null }), {}));
ck('...and a sale WITHOUT one says "Time not recorded"', noTime.indexOf('Time not recorded') > -1);
ck('...rather than substituting the device clock',
   noTime.indexOf(String(new Date().getFullYear())) === -1, (noTime.match(/©[^\n]*/) || [''])[0]);
ck('the till reads the timestamp off the COMPLETED sale, never Date.now()',
   /createdAt: r\.timestamp \|\| null/.test(code) && !/createdAt:[^\n]*Date\.now/.test(code));

head('6 - a PICKUP carries no address, even if one was typed');
const pickup = Ful.buildFulfilment({ type: 'pickup', destinationSnapshot: snap });
ck('buildFulfilment strips the destination from a pickup', !pickup.destinationSnapshot);
const pText = Rcpt.toText(Rcpt.render(Object.assign({}, SALE, { fulfilment: pickup }), {}));
ck('...so a pickup receipt never prints Kilimani', pText.indexOf('Kilimani') === -1);
ck('NC and the DELIVERY receipt does — so that check is not vacuous', text.indexOf('Kilimani') > -1);
ck('the till also drops the destination when switching back to pickup',
   /S\.ful\.type === 'pickup'\) \{ S\.ful\.dest = null/.test(code));

head('7 - a delivery with nowhere to go cannot be charged');
let threw = false;
try { Ful.buildFulfilment({ type: 'delivery' }); } catch (_) { threw = true; }
ck('buildFulfilment REFUSES an address-less delivery', threw);
ck('the till disables Complete until the fulfilment is ready',
   /fulReady = !delivering \|\| !!fulfilment\(\)/.test(code) && /!canPay \|\| !fulReady \? ' disabled'/.test(code));
ck('...and until the money is all there, per the settlement',
   /canPay = st \? st\.canComplete : false/.test(code));

head('8 - the receipt describes the sale that HAPPENED');
ck('the settlement is frozen at completion, not re-derived on render',
   /S\.settled = settlement\(\);/.test(code) && /settlement: S\.settled \|\| null/.test(code));
ck('...and so is the fulfilment',
   /S\.fulfilled = fulfilment\(\);/.test(code) && /fulfilment: S\.fulfilled \|\| null/.test(code));
ck('a new sale clears both', /S\.settled = null; S\.fulfilled = null;/.test(code));
ck('the terminal id is only ever a REAL one',
   /terminalId: ctx\.terminalId \|\| null/.test(code) && !/terminalId: ['"]/.test(code));

head('9 - who served comes from the session, and is never synthesised');
ck('the till passes servedBy straight through from the shell',
   /servedBy: ctx\.servedBy \|\| null/.test(code));
ck('...and never substitutes the shop name or owner for it',
   !/servedBy:[^\n]*(shopName|ownerName|shop\.name)/.test(code));
ck('the OLD cashierName field is gone', !/cashierName/.test(code));
/* Proven against the contract, not just the shape: an employee sale names the
   employee and no one else. */
const RD = require(path.join(ROOT, 'sokoni-receipt.js'));
ck('an employee sale names the EMPLOYEE',
   RD.servedByLine({ servedBy: { name: 'Mary', role: 'employee' } }) === 'Served by: Mary');
ck('an owner sale names the OWNER',
   RD.servedByLine({ servedBy: { name: 'Alex Ogutu', role: 'owner' } }) === 'Served by: Alex Ogutu');
ck('an unresolved server yields NO line rather than a guess',
   RD.servedByLine({ servedBy: { role: 'employee' } }) === null &&
   RD.servedByLine({}) === null);

console.log('\n' + '='.repeat(74));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('='.repeat(74) + '\n');
process.exit(fail ? 1 : 0);
