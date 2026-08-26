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
/* Anchored on the handler as it now reads. It was `k === 'print'` until the print OPTIONS
   sheet arrived and split opening options from printing; the old anchor then matched nothing
   and this whole section silently measured an empty string — five assertions passing or
   failing against "". The length CONTROL is what caught it, which is why it is here. */
const printBlock = SRC.slice(SRC.indexOf("if (k === 'doprint' || k === 'print')"),
                             SRC.indexOf("function onKey"));
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

/* ── 9b. THE FILTERS ACTUALLY RUN ─────────────────────────────────────────
   EXECUTED, not read. Every assertion above this point checks source text, and source text
   is exactly what hid a severe defect: the state extension silently failed to apply, so
   S.pay and S.kind were UNDEFINED. `if (S.pay !== 'all')` is TRUE for undefined, so the list
   filtered on payKind(o) === undefined — which matches nothing — and every merchant would
   have opened Receipts to an empty page. Two commits shipped that way while these suites
   stayed green.

   So: run visible() against real rows, with the DEFAULT state, and require receipts back. */
console.log('\n9b. Default filters return receipts, not an empty page');
const runVisible = (function () {
  const grab = (re) => (SRC.match(re) || [''])[0];
  const parts = ['dayStart \\(offsetDays\\)', 'inRange \\(o\\)', 'payKind \\(o\\)',
                 'saleKind \\(o\\)', 'servedName \\(o\\)', 'visible \\(\\)']
    .map((n) => grab(new RegExp('function ' + n + ' \\{[\\s\\S]*?\\n    \\}')));
  if (parts.some((p) => !p)) return null;
  return (rows, over) => new Function('S',
    parts.join('\n') + '\nreturn visible();')(Object.assign({ rows: rows }, over));
})();
ok(typeof runVisible === 'function', 'CONTROL: visible() and its helpers were extracted');

/* The DEFAULTS as the module declares them — read from source so this cannot drift. */
const defaults = (function () {
  const blk = SRC.slice(SRC.indexOf('var S = {'), SRC.indexOf('function skeleton'));
  const g = (k, d) => { const m = blk.match(new RegExp(k + ":\\s*'([a-z0-9]+)'")); return m ? m[1] : d; };
  return { range: g('range'), pay: g('pay'), kind: g('kind'), cashier: g('cashier'), pins: [], q: '' };
})();
ok(defaults.pay === 'all' && defaults.kind === 'all' && defaults.cashier === 'all',
   'the payment, type and cashier filters DEFAULT to "all"',
   JSON.stringify(defaults));
ok(defaults.range === 'today', 'the date filter defaults to today');

const NOW_ = Date.now();
const sample = [
  { ref: 'R1', ts: NOW_, total: 2800, method: 'M-PESA', payment: 'paid', items: [] },
  { ref: 'R2', ts: NOW_, total: 1500, method: 'Cash', payment: 'paid', items: [] },
];
const seen = runVisible(sample, defaults);
ok(Array.isArray(seen) && seen.length === 2,
   'today\'s receipts are RETURNED under the default filters',
   'got ' + (seen ? seen.length : 'null') + ' of 2 — an empty page is the defect this catches');

/* And the filters must genuinely narrow, or the check above passes for the wrong reason. */
ok(runVisible(sample, Object.assign({}, defaults, { pay: 'cash' })).length === 1,
   'CONTROL: the payment filter genuinely narrows (cash -> 1 of 2)');
ok(runVisible(sample, Object.assign({}, defaults, { range: 'yesterday' })).length === 0,
   'CONTROL: the date filter genuinely narrows (yesterday -> 0 of 2)');

/* ── 9c. THE REST OF THE SURFACE ──────────────────────────────────────────── */
console.log('\n9c. Tiles, percentages, card menu, Save and a custom range');

/* Percentages need a denominator. 0% / 0% on a day with no takings would be a claim about
   a day that has not happened — the same shape as an unknown total rendered as zero. */
const sumBody = CODE.slice(CODE.indexOf('function summaryHTML'), CODE.indexOf('function visible'));
ok(/if \(!takings\) return '';/.test(SRC),
   'a payment share is omitted entirely when there are no takings to divide');
ok(/Math\.round\(\(n \/ takings\) \* 100\)/.test(SRC), 'the share is a real percentage of takings');
ok(/💰 Sales/.test(SRC) && /🧾 Receipts/.test(SRC), 'the Sales and Receipts tiles are present');

/* The card overflow, with the same always-in-the-DOM rule Products had to learn. */
ok(/data-rc="menu"/.test(CODE), 'the card carries an overflow control');
ok(SRC.indexOf(`'<div class="rc-menu" role="menu"' + (S.menu === i ? '' : ' hidden')`) > -1,
   'the menu is ALWAYS rendered and toggled with [hidden], not conditionally created');
['quickprint', 'quickcopy', 'pin'].forEach((a) => {
  ok(new RegExp('data-rc="' + a + '"').test(CODE), 'the menu offers ' + a);
});
ok(/S\.menu = \(S\.menu === mi\) \? null : mi;/.test(SRC), 'tapping the same control closes it');
/* A menu left open across a re-filtered list points at a different receipt than was tapped. */
ok((SRC.match(/S\.menu = null/g) || []).length >= 3,
   'search, filters and menu actions all close it (' +
   (SRC.match(/S\.menu = null/g) || []).length + ' sites)');
/* Print from the card must OPEN options, not fire a job the merchant did not size. */
ok(/S\.open = qo; S\.printErr = null; S\.printSheet = true;/.test(SRC),
   'print-from-card opens the options sheet rather than printing immediately');

/* ONE copy implementation — a second would be a dormant duplicate free to drift. */
ok((SRC.match(/navigator\.clipboard\.writeText/g) || []).length === 1,
   'there is exactly ONE clipboard implementation, shared by the sheet and the card menu');
ok(!/__never_/.test(SRC), 'no unreachable leftover branch survives in the handler');

/* Save reports honestly — a download the browser refused is not a saved file. */
ok(/data-rc="save"/.test(CODE), 'the sheet offers Save');
ok(/could not be saved on this device/.test(SRC),
   'a refused download says so rather than claiming the receipt was saved');

/* Custom range: an unset bound is OPEN, not zero. */
ok(/sel\('custom', 'Custom…', S\.range\)/.test(SRC), 'a custom range is offered');
ok(/S\.from \? new Date\(S\.from \+ 'T00:00:00'\)/.test(SRC), 'the from bound is read as a local day start');
ok(/S\.to \? new Date\(S\.to \+ 'T23:59:59\.999'\)/.test(SRC), 'the to bound covers the whole day');
ok(/if \(f !== null && isFinite\(f\) && t < f\) return false;/.test(SRC),
   'an unset bound is OPEN — filling only "from" means "since then", not "nothing"');

/* Executed: a custom range must actually select. */
const NOWC = Date.now();
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const rowsC = [
  { ref: 'A', ts: NOWC - 86400000 * 3, total: 10, items: [] },
  { ref: 'B', ts: NOWC, total: 20, items: [] },
];
const baseC = { q: '', pay: 'all', kind: 'all', cashier: 'all', pins: [] };
ok(runVisible(rowsC, Object.assign({}, baseC, { range: 'custom', from: iso(NOWC), to: '' })).length === 1,
   'CONTROL: from-only selects just the later receipt');
ok(runVisible(rowsC, Object.assign({}, baseC, { range: 'custom', from: '', to: '' })).length === 2,
   'CONTROL: an empty custom range excludes nothing');

/* ── 9d. THE FILTER CONTROLS ARE WIRED ────────────────────────────────────
   Rendering a select is not wiring it. onInput's guard was `!== 'q'` and returned early for
   everything else, so every filter rendered and did NOTHING — a merchant switched Payment to
   M-PESA and the list did not move. A control that looks live and is inert is worse than a
   missing one, because it is trusted. Section 9b proved the filters FILTER; this proves the
   controls reach them. */
console.log('\n9d. Changing a filter actually changes the state');
const inputFn = SRC.slice(SRC.indexOf('function onInput'), SRC.indexOf('function onClick'));
ok(inputFn.length > 300, 'CONTROL: onInput located (' + inputFn.length + ' chars)');
ok(!/getAttribute\('data-rc'\) !== 'q'\) return;/.test(inputFn),
   'the early return no longer discards every non-search control');
['range', 'pay', 'kind', 'cashier'].forEach((k) => {
  ok(new RegExp("key === '" + k + "'").test(inputFn), 'onInput handles the ' + k + ' control');
});
ok(/key === 'from' \|\| key === 'to'/.test(inputFn), 'onInput handles the custom date bounds');
ok(/key === 'qr'/.test(inputFn), 'onInput handles the include-QR checkbox');
/* Executed: a change event must land on state. */
const runInput = (function () {
  const body = inputFn.replace(/^\s*function onInput \(ev\) \{/, '').replace(/\}\s*$/, '');
  return (state, attr, value) => {
    const S2 = state;
    const el = { getAttribute: (n) => (n === 'data-rc' ? attr : null), value: value, checked: true };
    new Function('S', 'ev', 'paint', 'clearTimeout', 'setTimeout', 'host', '_t', body)(
      S2, { target: el }, function () {}, function () {}, function () {}, { querySelector: () => null }, null);
    return S2;
  };
})();
ok(runInput({ pay: 'all', menu: 3 }, 'pay', 'mpesa').pay === 'mpesa',
   'changing Payment writes S.pay');
ok(runInput({ range: 'today', menu: 2 }, 'range', 'custom').range === 'custom',
   'changing the date range writes S.range');
ok(runInput({ cashier: 'all', menu: null }, 'cashier', 'Alex').cashier === 'Alex',
   'changing Cashier writes S.cashier');
ok(runInput({ pay: 'all', menu: 4 }, 'pay', 'cash').menu === null,
   'a filter change closes an open card menu — a stale index points at another receipt');

/* ── 10. THE VIEWER ───────────────────────────────────────────────────────── */
console.log('\n10. The receipt viewer');
const sheetFn = CODE.slice(CODE.indexOf('function sheet ()'), CODE.indexOf('function sel ('));
ok(sheetFn.length > 500, 'CONTROL: the sheet body was located (' + sheetFn.length + ' chars)');
ok(/rc-backb/.test(sheetFn), 'it has a back control INSIDE the sheet, not a floating page button');
ok(/rc-vamt/.test(sheetFn) && /PAID/.test(SRC), 'the header states paid status and the total');
['openprint', 'share', 'copyref', 'verify'].forEach((a) => {
  ok(new RegExp('data-rc="' + a + '"').test(sheetFn), 'offers the ' + a + ' action');
});

/* ── 11. VERIFICATION USES THE CONTRACT'S OWN URL ─────────────────────────── */
console.log('\n11. Verification');
const vfn = CODE.slice(CODE.indexOf('function verifyUrl'), CODE.indexOf('function deliveryBlock'));
ok(vfn.length > 80, 'CONTROL: verifyUrl located');
ok(/RECEIPT_URL_BASE/.test(vfn),
   'the link is the contract\'s own base — the same URL the printed QR encodes');
/* The contract is explicit that the QR must carry a reference and nothing else. */
ok(!/phone|uid|total|amount/i.test(vfn),
   'the verification link carries no phone, uid or amount');
ok(/if \(!base \|\| !ref\) return null;/.test(SRC),
   'no reference means no link — rather than one that leads nowhere');
ok(/vurl\s*\n?\s*\?/.test(sheetFn) || /\(vurl/.test(sheetFn),
   'the verify control renders only when a link actually resolves');

/* ── 12. DELIVERY IN THE SHEET ────────────────────────────────────────────── */
console.log('\n12. Delivery detail, without reaching for a rider');
const dfn = CODE.slice(CODE.indexOf('function deliveryBlock'), CODE.indexOf('function printSheet'));
ok(dfn.length > 200, 'CONTROL: deliveryBlock located');
ok(/saleKind\(o\) !== 'delivery'\) return '';/.test(SRC),
   'it renders nothing at all for a counter sale');
['deliveryId', 'address', 'rider', 'deliveryFee'].forEach((f) => {
  ok(dfn.indexOf(f) > -1, 'shows ' + f + ' from the order');
});
ok(/stage \?/.test(dfn), 'the fulfilment stage renders only when the order carries one');
ok(!/lat|lng|coords|geo|position/i.test(dfn),
   'it never reads rider position — that authority is not widened to decorate a receipt');
ok(/data-route="fulfilment"/.test(dfn),
   'tracking is a ROUTE into the workspace, not a coordinate read here');

/* ── 13. THE PRINT OPTIONS SHEET ──────────────────────────────────────────── */
console.log('\n13. Printing is a decision, not a reflex');
const pfn = CODE.slice(CODE.indexOf('function printSheet'), CODE.indexOf('function sheet ()'));
ok(pfn.length > 400, 'CONTROL: printSheet located');
ok(/data-rc="openprint"/.test(sheetFn) && /data-rc="doprint"/.test(pfn),
   'opening options is separate from printing');
/* The device state is reported, never assumed — "saved" is not "connected". */
ok(/dev === null \? 'Status unavailable'/.test(SRC),
   'with no device layer it says the status is UNAVAILABLE, not "Connected"');
ok(/Reconnect/.test(pfn), 'a disconnected printer offers Reconnect rather than a dead PRINT');
ok(/copies: S\.copies/.test(SRC) && /includeQr: S\.withQr/.test(SRC),
   'the chosen copies and QR option actually reach the print job');
ok(/Math\.max\(1, Math\.min\(9, S\.copies \+ dstep\)\)/.test(SRC),
   'the copy count is bounded — never zero, never unbounded');

/* ── 14. DAY OVER DAY, ONLY WHEN THERE IS A YESTERDAY ─────────────────────── */
console.log('\n14. A trend is stated only when one exists');
const delta = CODE.slice(CODE.indexOf('function deltaHTML'), CODE.indexOf('function summaryHTML'));
ok(delta.length > 300, 'CONTROL: deltaHTML located');
ok(/if \(!yest\.count \|\| !yest\.total\) return '';/.test(SRC),
   'no yesterday data means NO percentage — a shop that did not trade did not fall 100%');
ok(/S\.range !== 'today'/.test(delta), 'the comparison is only offered for today');
ok(/saleKind\(o\) === 'cancelled'\) return;/.test(delta),
   'cancelled sales are excluded from both sides of the comparison');
/* Executed, not merely read — the arithmetic is the claim. */
const grab = (re) => SRC.match(re)[0];
const runDelta = (function () {
  const src = grab(/function dayStart \(offsetDays\) \{[\s\S]*?\n    \}/) + '\n' +
              grab(/function saleKind \(o\) \{[\s\S]*?\n    \}/) + '\n' +
              grab(/function deltaHTML \(\) \{[\s\S]*?\n    \}/) + '\nreturn deltaHTML();';
  return (rows, range) => new Function('S', src)({ rows, range });
})();
const DAY = 86400000, NOW = Date.now();
ok(runDelta([{ ts: NOW, total: 100 }], 'today') === '',
   'a first-day shop is shown no trend at all');
ok(/12\.4% from yesterday/.test(runDelta([{ ts: NOW - DAY, total: 1000 }, { ts: NOW, total: 1124 }], 'today')),
   '1000 yesterday to 1124 today reads as 12.4%');
ok(runDelta([{ ts: NOW - DAY, total: 100 }, { ts: NOW, total: 200 }], 'all') === '',
   'no trend outside the today range');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
