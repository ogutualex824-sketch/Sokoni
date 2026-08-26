/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT-V2 RECEIPT ADAPTER — real order → adapter → canonical document → print text
   ══════════════════════════════════════════════════════════════════════════════
   The defect this exists for: merchant-v2 had NO receipt adapter. docFor() passed the order
   straight through, so the renderer — which reads totalMinor, totals.* and settlement —
   received `total` in major units and nothing else it recognised. Every receipt in the
   workspace rendered TOTAL as an em-dash and PAYMENT as "Not recorded".

   test-receipts-mount did not catch it. It asserted the sheet renders `rc-doc` and the shop
   name — both true — and never checked that the DOCUMENT CONTAINED THE SALE. So this suite
   asserts the printed TEXT, line by line, against orders shaped like production.

   The fixtures are real: orders 1 and 5 are live documents with figures that do not
   reconcile. They are here precisely because they prove the adapter does not manufacture
   financial truth.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '\n          ' + d : '')); ok ? pass++ : fail++; };
const head = (t) => console.log('\n' + t);

global.window = global;
require(path.join(ROOT, 'sokoni-cash.js'));
require(path.join(ROOT, 'sokoni-fulfilment.js'));
require(path.join(ROOT, 'sokoni-receipt.js'));
const R = global.SokoniReceiptDoc;

/* Extract the REAL adapter from the module rather than re-implementing it — a
   re-implementation passes against a build where the real code was never wired in. */
const SRC = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-receipts.js'), 'utf8');
function grab (name) {
  const i = SRC.indexOf('function ' + name);
  if (i < 0) return null;
  let d = 0, j = SRC.indexOf('{', i), e = -1;
  for (let k = j; k < SRC.length; k++) {
    if (SRC[k] === '{') d++;
    else if (SRC[k] === '}') { d--; if (!d) { e = k + 1; break; } }
  }
  return e < 0 ? null : SRC.slice(i, e);
}
const tmSrc = grab('_tenderMethod'), adSrc = grab('toReceiptInput');
const tenderMethod = tmSrc && new Function('return ' + tmSrc.replace('function _tenderMethod', 'function'))();
const adapt = adSrc && new Function('_tenderMethod', 'return (' + adSrc.replace('function toReceiptInput', 'function') + ')')(tenderMethod);

const SHOP = { name: 'Bravilex Duka', branch: 'Westlands' };
const render = (order) => {
  const input = adapt(order);
  const doc = R.render(Object.assign({}, input, { shop: SHOP }), { shop: SHOP });
  return { input, doc, text: R.toText(doc) };
};
const has = (t, s) => t.indexOf(s) > -1;
/* A money line: label anywhere, amount anywhere after it on the same line. */
const line = (t, label) => (t.split('\n').find((l) => l.trim().indexOf(label) === 0) || '');

head('0 - the adapter was extracted from the module');
ck('CONTROL: toReceiptInput extracted', typeof adapt === 'function');
ck('CONTROL: _tenderMethod extracted', typeof tenderMethod === 'function');

/* ── 1. MINOR-UNIT CONVERSION HAPPENS EXACTLY ONCE ────────────────────────── */
head('1 - major → minor, exactly once');
const conv = adapt({ id: 'x', total: 100, items: [] });
ck('100 major becomes 10000 minor', conv.totalMinor === 10000, 'got ' + conv.totalMinor);
/* The sabotage this guards: a value already in minor units must not be converted again.
   The adapter is the ONLY converter, so anything it receives is major by contract. */
const conv2 = adapt({ id: 'x', total: 10000, items: [] });
ck('SABOTAGE CONTROL: 10000 major becomes 1000000, not 10000',
   conv2.totalMinor === 1000000,
   'if this were 10000 the adapter would be treating input as already-minor');
ck('an absent total yields NO totalMinor, never 0',
   adapt({ id: 'x', items: [] }).totalMinor === undefined);
ck('total 0 is preserved as a real zero',
   adapt({ id: 'x', total: 0, items: [] }).totalMinor === 0);

/* ── 2. CASH ──────────────────────────────────────────────────────────────── */
head('2 - an ordinary cash sale');
const cash = render({
  id: 'c1', receiptNumber: 'RCPT-CASH', customer: 'Jane Doe', when: new Date('2025-08-24T04:46:00'),
  total: 2800, pricing: { subtotal: 2800, total: 2800 }, paidAmount: 2800,
  method: 'cash', items: [{ name: 'Sugar 2kg', qty: 1, price: 2800 }],
});
ck('TOTAL shows 2,800', /TOTAL\s+2,800/.test(cash.text), line(cash.text, 'TOTAL'));
ck('CASH tender line present', /CASH\s+2,800/.test(cash.text), line(cash.text, 'CASH'));
ck('no MPESA line on a cash sale', !has(cash.text, 'MPESA'));
ck('NO fulfilment section on a counter sale',
   !has(cash.text, 'DELIVERY') && !has(cash.text, 'FULFILMENT') && !has(cash.text, 'PICKUP'),
   'this is the confirmed renderer defect');
ck('and no "Not recorded" anywhere', !has(cash.text, 'Not recorded'));

/* ── 3. M-PESA ONLY, FULL REFERENCE ───────────────────────────────────────── */
head('3 - M-PESA only');
const mp = render({
  id: 'm1', receiptNumber: 'RCPT-MP', customer: 'Jane', when: new Date(),
  total: 4300, pricing: { subtotal: 4300, total: 4300 }, paidAmount: 4300,
  method: 'mpesa', paymentMethod: 'mpesa_intasend', mpesaCode: 'TFG7H2K9QQ',
  items: [{ name: 'Sugar 2kg', qty: 1, price: 4300 }],
});
ck('MPESA tender line present', /MPESA\s+4,300/.test(mp.text), line(mp.text, 'MPESA'));
ck('no CASH line on an M-PESA sale', !/^CASH/m.test(mp.text));
ck('the M-PESA reference is COMPLETE, not clipped', has(mp.text, 'TFG7H2K9QQ'));
ck('the gateway name is not printed as a tender', !has(mp.text, 'INTASEND'),
   'mpesa_intasend is the rail, not the tender the customer chose');

/* ── 4. THE LADDER ────────────────────────────────────────────────────────── */
head('4 - subtotal, discount, delivery fee');
const ladder = render({
  id: 'l1', receiptNumber: 'RCPT-L', customer: 'Jane', when: new Date(),
  total: 4300, pricing: { subtotal: 4300, discount: 300, deliveryFee: 300, total: 4300 },
  paidAmount: 4300, method: 'cash', items: [{ name: 'Sugar', qty: 1, price: 4300 }],
});
ck('Subtotal renders', /Subtotal\s+4,300/.test(ladder.text), line(ladder.text, 'Subtotal'));
ck('Discount renders NEGATIVE', /Discount\s+-300/.test(ladder.text), line(ladder.text, 'Discount'));
ck('Delivery renders', /Delivery\s+300/.test(ladder.text), line(ladder.text, 'Delivery'));
ck('TOTAL is the order figure, NOT subtotal+delivery',
   /TOTAL\s+4,300/.test(ladder.text) && !has(ladder.text, '4,600'),
   'reconstructing the total is the one thing the adapter must never do');

/* ── 5. THE INCONSISTENT LIVE ORDERS ──────────────────────────────────────── */
head('5 - real orders whose figures do not reconcile');
const o5 = render({
  id: 'o5', receiptNumber: 'SKN0V9YUTN', customer: 'Jane Doe', when: new Date(),
  total: 100, pricing: { subtotal: 100, total: 100, deliveryFee: 0 }, deliveryFeeTop: 220,
  paidAmount: 97, mpesaCode: 'YM4NQ6R', method: 'mpesa',
  fulfillmentType: 'delivery', deliveryAddress: 'Westlands, Nairobi', rider: 'Brian O.',
  items: [{ name: 'Sugar 2kg', qty: 1, price: 100 }],
});
ck('TOTAL stays 100 — the order figure', /TOTAL\s+100/.test(o5.text), line(o5.text, 'TOTAL'));
ck('paidAmount 97 is NOT promoted to TOTAL', !/TOTAL\s+97/.test(o5.text));
ck('MPESA shows what was actually paid', /MPESA\s+97/.test(o5.text), line(o5.text, 'MPESA'));
ck('the shortfall appears as BALANCE DUE 3', /BALANCE DUE\s+3/.test(o5.text),
   'the receipt reports the financial state; it does not repair it');
ck('the conflicting top-level deliveryFee 220 is NOT printed', !has(o5.text, '220'),
   'pricing is the internally reconciled source');
ck('the conflict is REPORTED to the caller',
   (o5.input._adapterWarnings || []).some((w) => /two different delivery fees/.test(w)));

/* ── 6. DELIVERY vs PICKUP vs COUNTER ─────────────────────────────────────── */
head('6 - the fulfilment section appears only when earned');
ck('a delivery prints its destination', has(o5.text, 'Westlands, Nairobi'));
ck('a delivery prints its rider', has(o5.text, 'Brian O.'),
   'buildAssignment needs { method, rider:{name} } — a riderName string is ignored');
const pickup = render({
  id: 'p1', receiptNumber: 'RCPT-P', when: new Date(), total: 500,
  paidAmount: 500, method: 'cash', fulfillmentType: 'pickup',
  items: [{ name: 'Bread', qty: 1, price: 500 }],
});
ck('a pickup prints PICKUP', has(pickup.text, 'PICKUP'));
ck('a pickup does NOT print a DELIVERY block', !has(pickup.text, 'DELIVERY'));
const noaddr = render({
  id: 'n1', receiptNumber: 'RCPT-N', when: new Date(), total: 500, paidAmount: 500,
  method: 'cash', fulfillmentType: 'delivery', items: [],
});
ck('a delivery with NO address prints no fulfilment block at all',
   !has(noaddr.text, 'DELIVERY') && !has(noaddr.text, 'Not recorded'),
   'a delivery with nowhere to go is not a delivery');

/* ── 7. MISSING DATA STAYS MISSING ────────────────────────────────────────── */
head('7 - absent data is never fabricated');
const bare = render({ id: 'b1', ref: 'RCPT-B', when: new Date(), items: [] });
ck('no total yields an em-dash, not 0', /TOTAL\s+—/.test(bare.text), line(bare.text, 'TOTAL'));
ck('no customer line is invented', !has(bare.text, 'CUSTOMER'));
ck('no settlement is invented', !/MPESA|CASH/.test(bare.text));

/* ── 8. SHOP CREDENTIALS COME FROM THE ACTIVE SHOP ────────────────────────── */
head('8 - shop identity');
ck('the shop name prints', has(cash.text, 'Bravilex Duka'));
ck('the branch prints when the shop has one', has(cash.text, 'Branch: Westlands'));
ck('no KRA PIN is invented when the shop has none', !has(cash.text, 'KRA PIN'));
ck('the SOKONI/Bravilex footer is intact',
   has(cash.text, 'SOKONI') && has(cash.text, 'Bravilex International Co.'));
ck('the verification QR line is intact', has(cash.text, 'verify this'));

/* ── 9. ONE DOCUMENT FOR SCREEN AND PRINTER ───────────────────────────────── */
head('9 - the screen and the printer receive the same composition');
const doc = cash.doc;
ck('render() produced a block document', Array.isArray(doc.blocks) && doc.blocks.length > 0);
ck('toText() of that SAME document is the print text',
   R.toText(doc) === cash.text,
   'the printer receives toText(doc); the screen renders doc — one composition, two outputs');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
