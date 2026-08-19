/* ══════════════════════════════════════════════════════════════════════════════
   THE UNIVERSAL SOKONI RECEIPT CONTRACT — certification
   ══════════════════════════════════════════════════════════════════════════════
   ONE renderer serves every receipt SOKONI produces, so this suite certifies every
   STATE that renderer has to survive — not only the happy path:

     owner sale · employee sale · pickup · delivery · a shop with NO logo ·
     a sample/test receipt · the P58E paper adapter

   Those are genuinely different receipts. A shop with no logo is the common case
   on day one; a sample receipt is what a merchant sees before their first sale;
   and the P58E is a single-byte codepage that turns a heart into garbage. Certify
   only the happy path and the first receipt a real merchant ever sees is the one
   nobody looked at.

   The invariants that matter most are about not lying:

     · the time is the SERVER's, and a missing one is STATED, never substituted
     · "Served by" names WHO ACTUALLY SERVED — an employee sale never credits the
       owner — and is omitted rather than guessed
     · the total is the order's authoritative figure, never recomputed here
     · a pickup NEVER shows a destination
     · an unassigned rider is named as unassigned
     · an M-PESA overpayment is not printed as change
     · the QR resolves to a real SOKONI surface and carries nothing sensitive
     · the shared text and the printed text are ONE composition

   Run: node scripts/test-receipt-contract.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
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
const NL = String.fromCharCode(10);

const SHOP = { name: "Alex's Store", phone: '0712345678' };
const DEST = { label: 'Home', recipientName: 'Alex', phone: '0712345678',
               building: 'Green Estate', unit: 'House 14', town: 'Nairobi',
               formatted: 'Green Estate · House 14 · Nairobi', instructions: 'Gate 2' };
const ITEMS = [{ name: 'Blue Phone', qty: 1, lineMinor: K(18500) },
               { name: 'Screen', qty: 1, lineMinor: K(3000) }];
const TS = new Date(Date.UTC(2026, 7, 19, 18, 45));
const OWNER = { name: 'Alex Ogutu', role: 'owner' };
const EMPLOYEE = { name: 'Mary', role: 'employee' };

function order (extra) {
  return Object.assign({
    receiptId: 'SKN-2841', shop: SHOP, items: ITEMS, totalMinor: K(21500),
    createdAt: TS, customer: { name: 'Jane', phone: '0722000111' },
    servedBy: OWNER,
  }, extra || {});
}
const pickup = () => Ful.buildFulfilment({ type: 'pickup' });
/* Blocks are looked up BY TYPE, never by index. A sample receipt prepends a notice
   block, so every index shifts by one — and an index-based lookup then reads the
   reference block and reports a missing logo on a receipt that has one. */
const blockOf = (r, type) => r.blocks.filter((b) => b.type === type)[0];
const closeOf = (r) => blockOf(r, 'closing');

console.log('\nTHE UNIVERSAL SOKONI RECEIPT CONTRACT');
console.log('='.repeat(74));

/* ────────────────────────────────────────────────────────────────────────────
   PART A — the composition invariants
   ──────────────────────────────────────────────────────────────────────────── */

head('1 - a pickup sale, paid in cash');
const settleCash = Cash.settle({ totalMinor: K(21500), tenders: [{ method: 'cash', amountMinor: K(25000) }] });
const rPick = R.render(order({ settlement: settleCash, fulfilment: pickup() }));
const tPick = R.toText(rPick);
ck('carries the shop identity', tPick.indexOf("Alex's Store") > -1);
ck('carries the receipt reference', tPick.indexOf('SKN-2841') > -1);
ck('carries the server time, formatted', /19 Aug 2026/.test(tPick));
ck('lists both items', tPick.indexOf('Blue Phone') > -1 && tPick.indexOf('Screen') > -1);
ck('shows the authoritative total', tPick.indexOf('21,500') > -1);
ck('shows the cash tendered', tPick.indexOf('25,000') > -1);
ck('shows the CHANGE', /CHANGE\s+3,500/.test(tPick), (tPick.match(/CHANGE.*/) || [])[0]);
ck('is headed PICKUP', rPick.blocks.some((b) => b.heading === 'PICKUP'));
ck('prints NO destination on a pickup', !/Green Estate|House 14|Nairobi/.test(tPick));
ck('prints no rider line on a pickup', !/Rider/.test(tPick));
ck('no warnings on a complete order', rPick.warnings.length === 0, rPick.warnings.join('; '));

head('2 - a delivery sale, mixed payment, rider assigned');
const settleMixed = Cash.settle({ totalMinor: K(21500), tenders: [
  { method: 'mpesa', amountMinor: K(10000) }, { method: 'cash', amountMinor: K(12000) }] });
const rDel = R.render(order({ settlement: settleMixed,
  fulfilment: Ful.buildFulfilment({ type: 'delivery', destinationSnapshot: DEST,
    assignment: { method: 'sokoni', rider: { uid: 'r1', name: 'Brian' } } }) }));
const tDel = R.toText(rDel);
ck('both tenders appear', /MPESA\s+10,000/.test(tDel) && /CASH\s+12,000/.test(tDel));
ck('change is 500 and comes from the cash', /CHANGE\s+500/.test(tDel), (tDel.match(/CHANGE.*/) || [])[0]);
ck('the rider is named', tDel.indexOf('Brian') > -1);
ck('the delivery method is named', tDel.indexOf('Method: SOKONI Rider') > -1);
ck('is headed DELIVERY', rDel.blocks.some((b) => b.heading === 'DELIVERY'));
/* One address component per line: a joined address wraps at an arbitrary point on
   32-column paper and the rider reads a mangled street. */
const delLines = tDel.split(NL);
ck('the destination is shown ONE COMPONENT PER LINE',
   delLines.indexOf('Green Estate') > -1 && delLines.indexOf('House 14') > -1 && delLines.indexOf('Nairobi') > -1);
ck('...and is NOT the separator-joined single line', tDel.indexOf('Green Estate · House 14 · Nairobi') === -1);
ck('the delivery instruction is shown', tDel.indexOf('Gate 2') > -1);
ck('the customer block is present', tDel.indexOf('Jane') > -1);

head('3 - it never invents');
const rNoRider = R.render(order({ settlement: settleCash,
  fulfilment: Ful.buildFulfilment({ type: 'delivery', destinationSnapshot: DEST, assignment: { method: 'sokoni' } }) }));
ck('an unassigned rider is NAMED as unassigned', R.toText(rNoRider).indexOf(Ful.RIDER_UNASSIGNED) > -1);
ck('...and nobody is invented', !/Brian|Kevin|John/.test(R.toText(rNoRider)));

const rNoCustomer = R.render(order({ customer: null, settlement: settleCash, fulfilment: pickup() }));
/* Asserted on the BLOCK, not the text — heading words contain each other and a
   text search has produced a false positive here before. */
ck('no customer -> the block is ABSENT, not a placeholder',
   !rNoCustomer.blocks.some((b) => b.heading === 'CUSTOMER'),
   rNoCustomer.blocks.map((b) => b.heading || b.type).join(','));
ck('...while an order WITH a customer does get the block (not vacuous)',
   rDel.blocks.some((b) => b.heading === 'CUSTOMER'));

const rMpesaOver = R.render(order({
  settlement: Cash.settle({ totalMinor: K(21500), tenders: [{ method: 'mpesa', amountMinor: K(25000) }] }),
  fulfilment: pickup() }));
ck('an M-PESA overpayment prints OVERPAID, never CHANGE',
   /OVERPAID/.test(R.toText(rMpesaOver)) && !/CHANGE/.test(R.toText(rMpesaOver)));

head('4 - the server timestamp is the authority');
const noTime = R.render(order({ createdAt: null, settlement: settleCash, fulfilment: pickup() }));
ck('a missing server time is STATED', R.toText(noTime).indexOf('Time not recorded') > -1);
ck('...and warned about', noTime.warnings.some((w) => /server timestamp/.test(w)), noTime.warnings.join('; '));
ck('...and the device clock is NOT substituted, anywhere',
   !new RegExp(String(new Date().getFullYear())).test(R.toText(noTime)));
ck('a Firestore Timestamp is accepted', /19 Aug 2026/.test(
   R.toText(R.render(order({ createdAt: { toDate: () => TS }, settlement: settleCash, fulfilment: pickup() })))));

head('5 - the total is not recomputed here');
const wrongTotal = R.render(order({ totalMinor: K(999), settlement: settleCash, fulfilment: pickup() }));
ck('it prints the ORDER total, even when it disagrees with the items',
   /TOTAL\s+999$/m.test(R.toText(wrongTotal)), (R.toText(wrongTotal).match(/TOTAL.*/) || [])[0]);
ck('a missing total is warned about, not guessed',
   R.render(order({ totalMinor: null, settlement: settleCash, fulfilment: pickup() }))
     .warnings.some((w) => /authoritative total/.test(w)));

/* ────────────────────────────────────────────────────────────────────────────
   PART B — WHO SERVED: owner sale vs employee sale
   ──────────────────────────────────────────────────────────────────────────── */

head('6 - STATE: an OWNER sale names the owner');
const tOwner = R.toText(R.render(order({ servedBy: OWNER, settlement: settleCash, fulfilment: pickup() })));
ck('the owner is named', tOwner.indexOf('Served by: Alex Ogutu') > -1);

head('7 - STATE: an EMPLOYEE sale names the EMPLOYEE, not the owner');
const rEmp = R.render(order({ servedBy: EMPLOYEE, shop: { name: "Alex's Store", ownerName: 'Alex Ogutu' },
  settlement: settleCash, fulfilment: pickup() }));
const tEmp = R.toText(rEmp);
ck('the employee is named', tEmp.indexOf('Served by: Mary') > -1);
/* The defect this exists to prevent: a receipt crediting the owner for a sale an
   employee rang up is a false record, and it is the record a shift dispute turns on. */
ck('...and the OWNER is NOT named anywhere on it', tEmp.indexOf('Alex Ogutu') === -1);
ck('NC the owner IS named on an owner sale (so that check is not vacuous)',
   tOwner.indexOf('Alex Ogutu') > -1);

head('8 - STATE: unknown server -> the line is OMITTED, never guessed');
const rUnknown = R.render(order({ servedBy: null, settlement: settleCash, fulfilment: pickup() }));
ck('no "Served by" line at all', R.toText(rUnknown).indexOf('Served by') === -1);
ck('...and it is warned about rather than passed over silently',
   rUnknown.warnings.some((w) => /who served/.test(w)), rUnknown.warnings.join('; '));
/* An employee sale whose employee name did not resolve must NOT fall back to the
   shop owner — that is the same false record by a quieter route. */
const rNameless = R.render(order({ servedBy: { role: 'employee' },
  shop: { name: "Alex's Store", ownerName: 'Alex Ogutu' }, settlement: settleCash, fulfilment: pickup() }));
ck('a nameless EMPLOYEE does not fall through to the owner',
   R.toText(rNameless).indexOf('Served by') === -1 && R.toText(rNameless).indexOf('Alex Ogutu') === -1);
ck('an unrecognised role is refused rather than printed',
   R.servedByLine({ servedBy: { name: 'Someone', role: 'auditor' } }) === null);
ck('NC ...but every real role IS accepted',
   R.SERVER_ROLES.every((role) => R.servedByLine({ servedBy: { name: 'X', role: role } }) === 'Served by: X'),
   R.SERVER_ROLES.join(','));
ck('NC a role-less but NAMED server is still printed',
   R.servedByLine({ servedBy: { name: 'Alex' } }) === 'Served by: Alex');

/* ────────────────────────────────────────────────────────────────────────────
   PART C — branding, the logo fallback, and the QR
   ──────────────────────────────────────────────────────────────────────────── */

head('9 - branded merchant identity, every line conditional');
const full = R.render(order({ settlement: settleCash, fulfilment: pickup(),
  shop: { name: "Alex's Store", phone: '0712345678', email: 'shop@x.co.ke',
          address: 'Ngong Rd', city: 'Nairobi', logo: 'https://x/logo.png' },
  tax: { kraPin: 'P052468135M' }, terminalId: 'TILL-2', servedBy: EMPLOYEE }));
const tFull = R.toText(full);
const fullLines = tFull.split(NL).map((l) => l.trim());
ck('SOKONI leads the receipt', fullLines[0] === 'SOKONI', fullLines[0]);
ck('...with the shop name directly under it', fullLines[1] === "Alex's Store", fullLines[1]);
ck('phone, email and location appear',
   /0712345678/.test(tFull) && /shop@x.co.ke/.test(tFull) && /Ngong Rd, Nairobi/.test(tFull));
ck('KRA PIN appears when the merchant has one', tFull.indexOf('KRA PIN: P052468135M') > -1);
ck('the logo is carried as a URL for the screen', blockOf(full,'identity').logo === 'https://x/logo.png');
ck('a REAL terminal is named', tFull.indexOf('Terminal: TILL-2') > -1);
ck('Powered by SOKONI is on it', tFull.indexOf(R.POWERED_BY) > -1);
/* Asserted against the LITERAL canonical legal name, not only R.BRAVILEX. If the
   constant were ever edited to a shortened or stale form, comparing it to itself
   would still pass — the receipt would carry the wrong legal identity and this
   suite would agree with it. The company-identity gate reads this literal too. */
ck('the Bravilex operating identity is on it', tFull.replace(/\s+/g, ' ').indexOf(R.BRAVILEX) > -1);
ck('...spelled as the canonical legal name',
   R.BRAVILEX === 'Bravilex International Co. Limited', R.BRAVILEX);
ck('the tagline is carried in the structure for the digital footer',
   closeOf(full).tagline === R.TAGLINE);
/* Bravilex must appear ONCE on 32-column paper. The copyright line stays in the
   structure for the web footer, where there is room. */
ck('Bravilex is not printed twice on paper',
   (tFull.replace(/\s+/g, ' ').split(R.BRAVILEX).length - 1) === 1);
ck('...though the copyright IS available to the digital adapter',
   /Bravilex/.test(closeOf(full).copyright));

const bare = R.render(order({ settlement: settleCash, fulfilment: pickup(),
  shop: { name: 'Kiosk' }, servedBy: null }));
const tBare = R.toText(bare);
ck('NO terminal on a phone sale — the line is ABSENT, not invented', tBare.indexOf('Terminal') === -1);
ck('no KRA PIN when the merchant has none', tBare.indexOf('KRA PIN') === -1);
ck('no "Served by" line when unknown', tBare.indexOf('Served by') === -1);
ck('no email or address lines when unset', !/@/.test(tBare.split('------')[0]));
ck('...but the SOKONI + Bravilex identity is still present',
   tBare.indexOf('SOKONI') > -1 && tBare.replace(/\s+/g, ' ').indexOf(R.BRAVILEX) > -1);

head('10 - STATE: a shop with NO logo never looks broken');
const noLogo = R.render(order({ settlement: settleCash, fulfilment: pickup(),
  shop: { name: 'Kass Electronics', city: 'Nairobi' } }));
const idNoLogo = blockOf(noLogo,'identity');
ck('the identity block carries NO logo url', idNoLogo.logo === null);
ck('...and falls back to a WORDMARK, not an empty frame', idNoLogo.mark.kind === 'wordmark');
ck('...whose text is the SHOP NAME', idNoLogo.mark.text === 'Kass Electronics');
ck('...with the SOKONI mark still present', idNoLogo.mark.platform === 'SOKONI');
ck('the printed receipt still leads with SOKONI then the shop name',
   R.toText(noLogo).split(NL)[0].trim() === 'SOKONI' &&
   R.toText(noLogo).split(NL)[1].trim() === 'Kass Electronics');
ck('NC a shop WITH a logo gets kind:logo instead (so the branch is real)',
   blockOf(full,'identity').mark.kind === 'logo' && blockOf(full,'identity').mark.src === 'https://x/logo.png');
/* Even a shop with no name at all must not render an empty identity. */
const noName = R.render(order({ settlement: settleCash, fulfilment: pickup(), shop: {} }));
const idNoName = blockOf(noName,'identity');
ck('a shop with NO name still falls back to the SOKONI wordmark',
   idNoName.mark.kind === 'wordmark' && idNoName.mark.text === 'SOKONI');
ck('...and is warned about', noName.warnings.some((w) => /no name/.test(w)));

head('11 - the QR is functional, and carries nothing sensitive');
const close = closeOf(full);
ck('every receipt with a number carries a QR', !!close.qr);
ck('it resolves to the SOKONI customer receipt surface',
   close.qr.url === 'https://mysokoni.co.ke/payment-receipt.html?ref=SKN-2841', close.qr.url);
/* ONE spelling of the customer receipt surface. A third would be the same defect
   as a twelfth spelling of a delivery destination — so it is asserted against the
   two production writers rather than trusted. */
const WRITERS = ['functions/payment-trust.js', 'functions/fulfilment-scan.js'];
const agree = WRITERS.filter((f) =>
  fs.readFileSync(path.join(ROOT, f), 'utf8').indexOf('https://mysokoni.co.ke/payment-receipt.html?ref=') > -1);
ck('...the SAME url the production writers build', agree.length === 2, agree.join(', '));
ck('...and this module holds exactly that constant',
   R.RECEIPT_URL_BASE === 'https://mysokoni.co.ke/payment-receipt.html?ref=');
/* A photographed receipt must not leak anything the receipt itself does not show. */
const SENSITIVE = ['0722000111', 'Jane', '21,500', '2150000', 'Alex Ogutu', 'Mary', 'TILL-2'];
const leaks = SENSITIVE.filter((v) => close.qr.url.indexOf(v) > -1);
ck('the QR encodes the receipt number and NOTHING else', leaks.length === 0, leaks.join(', ') || 'no leaks');
ck('NC the detector would catch a leak if one were there',
   ['x'].concat(SENSITIVE).filter((v) => ('?ref=SKN-2841&phone=0722000111').indexOf(v) > -1).length === 1);
const noRef = R.render(order({ receiptId: null, saleId: null, settlement: settleCash, fulfilment: pickup() }));
const closeNoRef = closeOf(noRef);
ck('NO receipt number -> NO QR, rather than one pointing nowhere', closeNoRef.qr === null);
ck('...and it is warned about', noRef.warnings.some((w) => /QR/.test(w)), noRef.warnings.join('; '));
ck('the printed receipt then carries no QR block either',
   R.toText(noRef).indexOf('SOKONI QR') === -1);

head('12 - the close brings the customer back INTO SOKONI');
ck('thanks the customer', tFull.indexOf('Thank you for shopping with us') > -1);
ck('offers help INSIDE SOKONI', tFull.indexOf('Message us on SOKONI') > -1);
ck('...and does NOT send them to WhatsApp', !/whatsapp/i.test(tFull));

/* ────────────────────────────────────────────────────────────────────────────
   PART D — the sample receipt and the paper adapter
   ──────────────────────────────────────────────────────────────────────────── */

head('13 - STATE: a SAMPLE/TEST receipt is a SOKONI receipt');
const sample = R.render(order({ settlement: settleCash, fulfilment: pickup() }), { sample: true });
const tSample = R.toText(sample);
ck('it is flagged as a sample', sample.sample === true);
/* The notice is 34 characters and the paper is 32, so it REFLOWS — asserted on the
   structure for the exact wording and on the collapsed text for what is printed. */
ck('the exact notice is in the structure', blockOf(sample, 'notice').text === R.SAMPLE_NOTICE);
ck('it says so, unmistakably, on the paper too',
   tSample.replace(/\s+/g, ' ').indexOf(R.SAMPLE_NOTICE) > -1, tSample.split(NL).slice(0, 2).join(' / '));
ck('...at the very top, before anything else', tSample.split(NL)[0].trim().indexOf('SAMPLE') === 0);
/* The whole point: one renderer, so the sample proves the real thing. */
ck('the SOKONI branding is IDENTICAL, not stripped for tests', tSample.indexOf('SOKONI') > -1);
ck('...Powered by SOKONI is present', tSample.indexOf(R.POWERED_BY) > -1);
ck('...the Bravilex identity is present', tSample.replace(/\s+/g, ' ').indexOf(R.BRAVILEX) > -1);
ck('...the SOKONI QR is present', tSample.indexOf('SOKONI QR') > -1);
ck('...the items and total are present', tSample.indexOf('Blue Phone') > -1 && tSample.indexOf('21,500') > -1);
/* Structural proof there is no second renderer: sample and real differ ONLY by the
   notice block. */
const realBlocks = rPick.blocks.map((b) => b.type || b.heading).join(',');
const sampleBlocks = sample.blocks.map((b) => b.type || b.heading).join(',');
ck('a sample differs from a real receipt by EXACTLY one notice block',
   sampleBlocks === 'notice,' + realBlocks, sampleBlocks);
ck('NC and a real receipt carries no notice block', !rPick.blocks.some((b) => b.type === 'notice'));

head('14 - STATE: the P58E paper adapter');
const p58 = R.toText(rDel, { cols: 32, ascii: true });
const p58Lines = p58.split(NL);
ck('nothing overflows 32 columns', p58Lines.every((l) => l.length <= 32 || /^https:/.test(l)),
   (p58Lines.filter((l) => l.length > 32 && !/^https:/.test(l))[0] || 'all within width'));
ck('the column header is a real grid', p58.indexOf('PRODUCT') > -1 && /QTY/.test(p58) && /AMOUNT/.test(p58));
ck('amounts are right-aligned to the same column',
   (() => {
     const rows = p58Lines.filter((l) => /\b(18,500|3,000)$/.test(l));
     return rows.length === 2 && rows[0].length === rows[1].length;
   })());
/* A single-byte codepage turns a heart into garbage on thermal paper. */
ck('every character is printable ASCII', /^[\x20-\x7E\n]*$/.test(p58));
ck('...the heart is gone', p58.indexOf('❤') === -1);
ck('...the middle dot became a hyphen', /19 Aug 2026 - /.test(p58));
ck('NC the PHONE adapter keeps them (so the transliteration is real)',
   tDel.indexOf('❤') > -1 && /19 Aug 2026 · /.test(tDel));
/* A long product name must REFLOW, not truncate: a truncated name is a different
   product, and a merchant reconciling stock cannot tell which one was sold. */
const longName = R.render(order({ settlement: settleCash, fulfilment: pickup(),
  items: [{ name: 'Samsung Galaxy A54 5G Dual SIM 256GB Awesome Graphite', qty: 1, lineMinor: K(48000) }] }));
const tLong = R.toText(longName, { cols: 32, ascii: true });
ck('a long product name REFLOWS rather than overflowing',
   tLong.split(NL).every((l) => l.length <= 32 || /^https:/.test(l)));
ck('...and no word of it is lost',
   ['Samsung', 'Galaxy', 'A54', '5G', 'Dual', 'SIM', '256GB', 'Awesome', 'Graphite']
     .every((w) => tLong.indexOf(w) > -1));
ck('...with the amount still on the last line of the row',
   /Graphite\s+1\s+48,000/.test(tLong) || /48,000$/m.test(tLong), (tLong.match(/.*48,000.*/) || [])[0]);
ck('80mm paper widens the same composition', (() => {
  const w = R.toText(rDel, { cols: 42 }).split(NL);
  return w.some((l) => l.length > 32 && l.length <= 42);
})());
ck('the QR url is NEVER hard-wrapped — a split url is not tappable',
   p58Lines.some((l) => l === close.qr.url.replace('SKN-2841', 'SKN-2841')) ||
   p58Lines.some((l) => /^https:\/\/mysokoni\.co\.ke\/payment-receipt\.html\?ref=SKN-2841$/.test(l)));

head('15 - print is optional, share is not a second document');
ck('a receipt is shareable and printable from ONE composition',
   rDel.shareable === true && rDel.printable === true);
ck('the phone text and the paper text come from the SAME blocks',
   tDel.indexOf('Brian') > -1 && p58.indexOf('Brian') > -1);
ck('a receipt with no printer is still complete', tPick.split(NL).length > 6);

head('16 - negative controls');
ck('NC the destination DOES appear on a delivery (so section 1 is not vacuous)',
   tDel.indexOf('Green Estate') > -1);
ck('NC a rider IS named when assigned (so section 3 is not vacuous)', tDel.indexOf('Brian') > -1);
ck('NC CHANGE does appear when cash produced it', /CHANGE/.test(tPick));
ck('NC an empty order produces warnings rather than a clean receipt',
   R.render({}).warnings.length >= 3, String(R.render({}).warnings.length));

head('17 - it does not squat on a global that is already in use');
/* `window.SokoniReceipt` belongs to the EXISTING POS receipt path and carries a
   .print()/.doc() API this module does not have. */
const self = fs.readFileSync(path.join(ROOT, 'sokoni-receipt.js'), 'utf8');
ck('this module publishes SokoniReceiptDoc', /global\.SokoniReceiptDoc =/.test(self));
ck('...and never assigns window/global SokoniReceipt', !/(global|window)\.SokoniReceipt\s*=/.test(self));
const OWNERS = ['pos-checkout.html', 'pos-marketplace.html', 'pos-printer.js'];
const users = OWNERS.filter((f) => {
  try { return /window\.SokoniReceipt\b(?!Doc|Engine)/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')); }
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
