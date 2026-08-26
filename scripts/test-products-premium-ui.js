/* The premium Products surface.
 *
 *   node scripts/test-products-premium-ui.js
 *
 * The defect class this guards is a strip that says "5 low stock" over a list showing 4.
 * That happens when the counts and the filter each classify stock their own way, which is
 * exactly what the module did before: the counts were a bare row length and the "out"
 * filter was its own `Number(p.stock) === 0` — which also swallowed a MISSING stock as
 * "out of stock", turning an unknown into a definite claim about a shelf.
 *
 * So the assertions are mostly about ONE classifier, and about navigation never leaving
 * the shell.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-products.js'), 'utf8');
/* Comments stripped before any structural assertion: the prose above and inside the module
   names these very identifiers, and matching my own writing proves nothing. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0, fail = 0;
const ok = (c, label, detail) => {
  if (c) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
};

/* ── 1. ONE CLASSIFIER ────────────────────────────────────────────────────── */
console.log('\n1. Stock is classified in exactly one place');
ok(/function stockState \(/.test(CODE), 'CONTROL: stockState exists');
ok((CODE.match(/function stockState \(/g) || []).length === 1,
   'there is exactly ONE stock classifier');
ok(/counts\s*\(\)[\s\S]{0,200}stockState\(/.test(CODE),
   'the counts classify through stockState');
ok(/S\.status === 'in' \|\| S\.status === 'low' \|\| S\.status === 'out'[\s\S]{0,160}stockState\(p\) === S\.status/.test(CODE),
   'the stock FILTER classifies through the same stockState');
ok(/function statusPill[\s\S]{0,200}stockState\(p\)/.test(CODE),
   'the card badge classifies through the same stockState');
/* The old independent test must be gone, not merely unused. */
ok(!/Number\(p\.stock\) === 0/.test(CODE),
   'the old independent `Number(p.stock) === 0` test is REMOVED');

/* Behaviour of the classifier itself, executed rather than read. */
console.log('\n2. The classifier behaves — unknown is not zero');
/* Extracted and EXECUTED, never transcribed. An earlier draft of this file hand-copied the
   classifier into the test and asserted against the copy — so sabotaging the module changed
   nothing and the suite reported 0 failures over broken code. A test that re-implements what
   it checks proves only that the author can write the same bug twice. */
const CLS = (function () {
  const m = SRC.match(/function stockState \(p\) \{[\s\S]*?\n    \}/);
  if (!m) return null;
  const body = m[0].replace(/^function stockState \(p\) \{/, '').replace(/\}\s*$/, '');
  const low = (SRC.match(/var DEFAULT_LOW = (\d+);/) || [, '5'])[1];
  // eslint-disable-next-line no-new-func
  return new Function('p', 'var DEFAULT_LOW = ' + low + ';' + body);
})();
ok(typeof CLS === 'function',
   'CONTROL: the classifier was extracted from the module and is executable',
   'Extraction failed — every case below would throw rather than test anything.');
ok(CLS({ stock: 24 }) === 'in', '24 in stock -> in');
ok(CLS({ stock: 4 }) === 'low', '4 with the default threshold -> low');
ok(CLS({ stock: 0 }) === 'out', '0 -> out');
ok(CLS({ stock: 8, lowStockThreshold: 10 }) === 'low',
   'the merchant\'s own lowStockThreshold wins over the default');
/* The one that matters: an absent stock is NOT a claim that the shelf is empty. */
ok(CLS({}) === 'unknown', 'a MISSING stock is unknown — never "out of stock"');
ok(CLS({ stock: null }) === 'unknown', 'a null stock is unknown, not zero');
/* Number(null) is 0 and isFinite(0) is true, so a bare Number() reports an absent stock
   as OUT OF STOCK. The module must reject the empty values before the numeric test. */
/* indexOf on a literal, NOT a regex: `||` inside a regex is alternation with empty
   branches, so /a || b/ matches every string. The first version of this line was exactly
   that and passed against any source at all. */
ok(SRC.indexOf("raw === null || raw === undefined || raw === ''") > -1,
   'the module rejects null/undefined/empty BEFORE Number(), not after');
ok(CLS({ stock: '' }) === 'unknown', 'an empty-string stock is unknown, not zero');
ok(CLS({ stock: false }) === 'unknown', 'a boolean stock is unknown, not zero');

/* ── 3. NO ESCAPE FROM THE SHELL ──────────────────────────────────────────── */
console.log('\n3. Navigation belongs to merchant-v2');
ok(!/seller\.html/.test(CODE), 'the module never references seller.html');
ok(!/location\s*\.\s*(href|assign|replace)/.test(CODE),
   'the module never sets location — no navigation of its own');
ok(!/<a\s[^>]*href=/i.test(CODE), 'it renders no anchor that could leave the workspace');
ok(/data-pr="go"/.test(CODE) && /SokoniShell\.go|ctx\.go/.test(CODE),
   'it ROUTES by asking the shell (ctx.go / SokoniShell.go)');
/* A floating back control is the specific thing the brief removes. */
ok(!/pr-back|back-btn|floating/i.test(CODE), 'there is no floating back control');

/* ── 4. THE OVERVIEW ──────────────────────────────────────────────────────── */
console.log('\n4. The first screen is useful, and honest before data arrives');
ok(/function overviewHTML/.test(CODE), 'CONTROL: overviewHTML exists');
ok(/if \(!S\.rows\) return '';/.test(CODE),
   'the overview renders NOTHING before rows load — not zeros, which would read as an empty shop');
ok(/available · /.test(SRC) && /low stock · /.test(SRC) && /out of stock/.test(SRC),
   'it states available / low stock / out of stock');
ok(/pr-alert/.test(CODE) && /need' : ' needs'|needs' : ' need|products need|product needs/.test(SRC),
   'a low-stock count surfaces as an actionable alert');
ok(/data-chip="low"/.test(CODE), '...which filters to the low-stock view');

/* ── 5. SEARCH ────────────────────────────────────────────────────────────── */
console.log('\n5. Search covers the identifiers a merchant actually holds');
const vis = SRC.slice(SRC.indexOf('function visible ('), SRC.indexOf('function card ('));
['p.name', 'p.sku', 'p.category', 'sp.brand', 'sp.barcode'].forEach((f) => {
  ok(vis.indexOf(f) > -1, 'search covers ' + f);
});
ok(/variants \|\| \[\]\)\.forEach[\s\S]{0,80}v\.sku, v\.barcode/.test(vis),
   'search reaches VARIANT skus and barcodes — a scanned variant must find its product');

/* ── 6. STOCK IS SHOWN IN THE MERCHANT'S UNIT ─────────────────────────────── */
console.log('\n6. Stock reads in the unit the merchant counts in');
ok(/function stockLine/.test(CODE), 'CONTROL: stockLine exists');
ok(/p\.stockUnit && p\.stockUnit\.name/.test(CODE),
   'the card renders the product\'s own stock unit');
ok(/perPack/.test(CODE) && /packUnit/.test(CODE),
   'a pack shows how many pieces are inside');
ok(/if \(!isFinite\(n\)\) return 'Stock —';/.test(SRC),
   'an unknown stock renders an em-dash, never 0');

/* ── 7. EMPTY STATES ──────────────────────────────────────────────────────── */
console.log('\n7. Empty states distinguish "no products" from "no matches"');
ok(/ready for its first product/.test(SRC), 'a brand-new shop gets an invitation, not "0 results"');
ok(/No products match this search or filter/.test(SRC), 'a filtered-empty list says so instead');
ok(/data-chip="all">Clear filters/.test(SRC), '...and offers a way out of the filter');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
