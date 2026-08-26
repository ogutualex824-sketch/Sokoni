/* The product detail sheet and the quick-action menu.
 *
 *   node scripts/test-products-detail-sheet.js
 *
 * The rule this guards: the sheet RENDERS the record, it does not author it. Every field
 * shown comes from what the authority returned — no defaults, no "Uncategorised" for a
 * product whose category the merchant never set, and no stock figure this surface computes
 * for itself. A detail view that invents a value is worse than one that omits it, because
 * it reads as data.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-products.js'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0, fail = 0;
const ok = (c, label, detail) => {
  if (c) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
};

/* ── 1. IT EXISTS AND IS REACHABLE ────────────────────────────────────────── */
console.log('\n1. The sheet exists and can be opened');
ok(/function detailHTML \(/.test(CODE), 'CONTROL: detailHTML exists');
ok(/function specRows \(/.test(CODE), 'CONTROL: specRows exists');
ok(SRC.indexOf("if (E.mode === 'detail') return detailHTML(") > -1,
   'the editor dispatches the detail mode — defined AND reached');
ok(/data-pr="open"/.test(CODE), 'the card is openable');
ok(/role="button" tabindex="0"/.test(CODE),
   'the card is reachable by keyboard, not a div that only responds to a mouse');

/* ── 2. THE ACTION BUTTONS ARE NOT SWALLOWED ──────────────────────────────── */
console.log('\n2. Tapping Edit opens the editor, not the detail sheet');
/* Both live on the same card. Without the guard the card handler wins and Edit becomes
   unreachable — a control that looks live and does the wrong thing. */
ok(/\[data-pr="edit"\],\[data-pr="photos"\],\[data-pr="del"\],\[data-pr="menu"\]/.test(CODE),
   'the card-open handler excludes the explicit action controls');
const openIdx = CODE.indexOf('data-pr="open"]');
const menuIdx = CODE.indexOf('data-pr="menu"]');
ok(menuIdx > -1 && openIdx > -1 && menuIdx < openIdx,
   'the overflow handler runs BEFORE the card handler, so ⋮ is not read as a card tap');

/* ── 3. THE OVERFLOW MENU ─────────────────────────────────────────────────── */
console.log('\n3. The quick-action menu');
['✏️ Edit', '📦 Adjust stock', '👁️ View details', '🗑️ Remove'].forEach((label) => {
  ok(SRC.indexOf(label) > -1, 'offers ' + label);
});
ok(/S\.menu = \(S\.menu === mi\) \? null : mi;/.test(SRC),
   'tapping the same control CLOSES it — a menu that only opens has to be navigated away from');
ok(/menu: null,/.test(SRC), 'the menu state is declared, not implicit');
/* The menu must be in the DOM for EVERY card, toggled with [hidden] rather than
   conditionally rendered. Rendering it only when open removed Delete from the document
   for every closed card — deletion existed only after a second tap, which the product
   certification caught (test-merchant-v2-products-2b: no control matching [data-pr=del]). */
/* indexOf, not a regex: `+ ( ) ?` in that source line are all regex metacharacters, and
   escaping them by hand through two layers of quoting is how the last vacuous guard got
   written. A literal cannot be accidentally permissive. */
ok(SRC.indexOf("'<div class=\"pr-menu\" role=\"menu\"' + (S.menu === i ? '' : ' hidden')") > -1,
   'the menu is always rendered and toggled with [hidden], not conditionally created');
ok(SRC.indexOf('class="danger" data-pr="del"') > -1,
   'Remove is present in the document for every card, inside the menu');
/* A menu left open across a re-sorted list points at a different product than was tapped,
   because S.painted is rebuilt on every paint and the index moves. */
ok((SRC.match(/S\.menu = null/g) || []).length >= 4,
   'search, status, sort and chips all close the menu (' +
   (SRC.match(/S\.menu = null/g) || []).length + ' sites)');

/* ── 4. IT RENDERS THE RECORD, NOT AN OPINION ─────────────────────────────── */
console.log('\n4. Nothing is invented for display');
const detail = SRC.slice(SRC.indexOf('function detailHTML ('), SRC.indexOf('function editorHTML ('));
ok(detail.length > 500, 'CONTROL: the detail body was located (' + detail.length + ' chars)');
/* Optional fields are conditional, so an unset one is simply absent. */
ok(/p\.category \?/.test(detail), 'category renders only when the product HAS one');
ok(/p\.sku \?/.test(detail), 'SKU renders only when set');
ok(/p\.description \?/.test(detail), 'description renders only when set');
ok(!/Uncategorised|Not set|N\/A|Unknown category/i.test(detail),
   'no placeholder text stands in for a field the merchant never entered');
/* Stock and status come from the SAME helpers the cards and counts use. */
ok(/stockLine\(p\)/.test(detail) && /statusPill\(p\)/.test(detail),
   'stock and availability come from the shared helpers — not a second reading');

/* ── 5. MEASUREMENTS PRINT IN THE MERCHANT'S OWN UNIT ─────────────────────── */
console.log('\n5. A measurement is shown as it was entered');
const rows = SRC.slice(SRC.indexOf('function specRows ('), SRC.indexOf('function detailHTML ('));
ok(/m\.u \? ' ' \+ m\.u : ''/.test(rows),
   'the stored unit is printed alongside the value');
ok(!/\.base\b/.test(rows),
   'the comparison BASE is never displayed — 1010 kg must not read as 1010000 g');
ok(/suggestionsFor\(p\.category\)/.test(rows),
   'category-suggested specs are labelled the way the editor labelled them');
ok(/specs\.custom \|\| \[\]/.test(rows), 'merchant-defined specs are shown too');

/* ── 6. STOCK IS READ HERE, NEVER WRITTEN ─────────────────────────────────── */
console.log('\n6. Adjusting stock belongs to Inventory');
ok(/data-pr="go" data-route="inventory"/.test(detail),
   'Adjust inventory ROUTES to the Inventory module');
/* `=(?!=)` so a COMPARISON is not read as an assignment — the first version of this line
   matched `v.stock == null` while rendering a variant's quantity and reported a stock write
   that does not exist. A false positive here is as bad as a miss: it would have had me
   "fixing" correct code. */
ok(!/adjustStock|writeProduct|\bstock\s*=(?!=)/.test(detail),
   'the sheet performs no stock write of its own');
/* Positive control: the pattern DOES catch a real assignment, so the check is discriminating. */
ok(/\bstock\s*=(?!=)/.test('p.stock = 5'),
   'CONTROL: the write pattern still matches a genuine assignment');
/* And it still cannot leave the workspace. */
ok(!/seller\.html/.test(CODE) && !/location\s*\.\s*(href|assign|replace)/.test(CODE),
   'still no escape route out of merchant-v2');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
