/* The Receipt Vault.
 *
 *   node scripts/test-receipts-vault.js
 *
 * Two rules carry the weight here, and both are about a merchant standing at a counter:
 *
 *   1. The screen and the paper must be the SAME document. Two compositions would be two
 *      answers to "what did the customer buy", and the divergence surfaces on a slip someone
 *      is already holding.
 *   2. A printer that answered {ok:false} must never read as a printed receipt. The old
 *      handler did `return ctx.onPrint(...)` and said nothing at all — out of paper, GATT
 *      dropped mid-job, printer asleep, all silently successful.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-receipts.js'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0, fail = 0;
const ok = (c, label, detail) => {
  if (c) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
};

/* ── 1. PRINTING IS REPORTED HONESTLY ─────────────────────────────────────── */
console.log('\n1. A printer that failed is never reported as printed');
const printBlock = SRC.slice(SRC.indexOf("if (k === 'print')"), SRC.indexOf("function onKey"));
ok(printBlock.length > 300, 'CONTROL: the print handler was located (' + printBlock.length + ' chars)');
ok(/res && res\.ok === true/.test(printBlock),
   'success requires an explicit ok:true from the device layer');
/* undefined is not success. A device layer returning nothing has told us nothing. */
ok(!/if \(res\)\s*\{?\s*say\(/.test(printBlock),
   'a truthy-but-unspecified result is NOT treated as success');
ok(/\.catch\(/.test(printBlock), 'a thrown print error is caught rather than lost');
ok(/S\.printErr/.test(printBlock), 'the failure is held in state, not only toasted');
ok(/rc-perr/.test(CODE) && /did not print/.test(SRC),
   'the failure is SHOWN in the sheet with what to do about it');
/* The old shape must be gone, not merely bypassed. */
ok(!/return ctx\.onPrint\(\{ text: d\.text, order: S\.open \}\);/.test(CODE),
   'the old fire-and-forget print call is REMOVED');
ok(/S\.printing/.test(CODE), 'a printing state exists so the button cannot be double-tapped');

/* ── 2. ONE DOCUMENT, SCREEN AND PAPER ────────────────────────────────────── */
console.log('\n2. The screen shows what the printer will produce');
ok(/SokoniReceiptDoc/.test(CODE), 'the sheet renders through the locked contract');
const docFn = SRC.slice(SRC.indexOf('function docFor'), SRC.indexOf('function sheet'));
ok(docFn.length > 100, 'CONTROL: docFor located');
ok(/R\.render\(/.test(docFn) && /R\.toText\(/.test(docFn),
   'the same docFor() produces BOTH the preview and the print text');
ok(printBlock.indexOf('docFor(S.open)') > -1,
   'print composes from docFor — not from a second layout built for paper');

/* ── 3. NO SECOND SALES CALCULATOR ────────────────────────────────────────── */
console.log('\n3. The summary comes from the canonical engine');
ok(/SokoniAnalyticsEngine/.test(CODE), 'it reads through SokoniAnalyticsEngine');
const sumFn = SRC.slice(SRC.indexOf('function summaryFor'), SRC.indexOf('function summaryHTML'));
ok(/return null/.test(sumFn),
   'with no engine it returns NULL rather than summing locally');
const sumHtml = SRC.slice(SRC.indexOf('function summaryHTML'), SRC.indexOf('function visible'));
ok(/a \? esc\(money\(a\.revenue\)\) : dash/.test(sumHtml),
   'the total renders an em-dash when the engine is absent — never a locally derived figure');
ok(!/reduce\(function \(s, o\) \{ return s \+ \(Number\(o\.total\)/.test(sumFn),
   'summaryFor performs no aggregation of its own');

/* ── 4. THE STRIP AND THE LIST CANNOT DISAGREE ────────────────────────────── */
console.log('\n4. One classifier per question');
ok((CODE.match(/function payKind/g) || []).length === 1, 'exactly one payment classifier');
ok((CODE.match(/function saleKind/g) || []).length === 1, 'exactly one sale-type classifier');
ok(/payKind\(o\) === S\.pay/.test(CODE), 'the payment FILTER uses payKind');
ok(/byPay\[payKind\(o\)\]/.test(CODE), 'the payment SPLIT uses the same payKind');
ok(/saleKind\(o\) === S\.kind/.test(CODE), 'the type filter uses saleKind');
/* Cancelled money was never taken, so it must not appear in a payment split. */
ok(/if \(saleKind\(o\) === 'cancelled'\) return;/.test(SRC),
   'cancelled sales are excluded from the payment split');

/* ── 5. SEARCH FINDS WHAT A MERCHANT HOLDS ────────────────────────────────── */
console.log('\n5. One box, everything they might remember');
const vis = SRC.slice(SRC.indexOf('function visible'), SRC.indexOf('function groupRows'));
['o.ref', 'o.customer', 'o.phone', 'o.mpesaRef', 'o.deliveryId', 'o.rider', 'it.name', 'it.sku']
  .forEach((f) => ok(vis.indexOf(f) > -1, 'search covers ' + f));
ok(/servedBy && \(o\.servedBy\.name/.test(vis), 'search covers the cashier who served it');

/* ── 6. GROUPING MUST NOT MISADDRESS A RECEIPT ────────────────────────────── */
console.log('\n6. Grouped display, flat indices');
ok(/function groupRows/.test(CODE), 'CONTROL: groupRows exists');
/* Each group rendering over its OWN indices would make every button after the first group
   open the wrong receipt — a silent, plausible, completely wrong answer. */
ok(/row\(o, rows\.indexOf\(o\)\)/.test(CODE),
   'a card is indexed against the FLAT painted list, not its position in a group');
ok(/S\.painted = rows;/.test(CODE), 'S.painted is the flat list the indices address');

/* ── 7. DELIVERY ──────────────────────────────────────────────────────────── */
console.log('\n7. Delivery is shown only when it is one, and never queries a rider');
/* Sliced from the COMMENT-STRIPPED source. The comment inside row() explains that rider
   location is never queried — and the absence check below matched that sentence, reporting
   a defect that existed only in my own prose. Third time this session; asserting over
   comments proves the author can write the word, not that the code does the thing. */
const rowFn = CODE.slice(CODE.indexOf('function row (o, i)'), CODE.indexOf('function say ('));
ok(rowFn.length > 400, 'CONTROL: the row body was located (' + rowFn.length + ' chars)');
ok(/kind === 'delivery'\s*\n?\s*\?/.test(rowFn),
   'the delivery block renders ONLY for a delivery — an ordinary sale gets no empty section');
/* Rider LOCATION belongs to the tracking authority; a receipt must not reach for it. */
ok(!/location|lat|lng|coords|geo/i.test(rowFn),
   'the card never reads rider location — that belongs to the tracking authority');
ok(!/servedBy \|\| .*owner|ownerName/.test(rowFn),
   'served-by is never defaulted to the shop owner');

/* ── 8. PINS ARE A PREFERENCE, NOT DATA ───────────────────────────────────── */
console.log('\n8. Pinned receipts');
ok(/function pinKey/.test(CODE), 'CONTROL: pins are keyed');
ok(/ctx\.scope && ctx\.scope\.shopId/.test(SRC),
   'pins are scoped per SHOP — one shop\'s pins never appear on another');
ok(/try \{ return JSON\.parse/.test(SRC) && /catch \(e\) \{ return \[\]; \}/.test(SRC),
   'a corrupt or unavailable store yields no pins rather than throwing');
ok(!/pins.*total|pins.*revenue/i.test(CODE), 'pinning never affects a figure');

/* ── 9. STILL NO ESCAPE ───────────────────────────────────────────────────── */
console.log('\n9. Navigation stays in merchant-v2');
ok(!/seller\.html/.test(CODE), 'no reference to seller.html');
ok(!/location\s*\.\s*(href|assign|replace)/.test(CODE), 'it never sets location');
ok(!/<a\s[^>]*href=/i.test(CODE), 'it renders no anchor that could leave the workspace');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
