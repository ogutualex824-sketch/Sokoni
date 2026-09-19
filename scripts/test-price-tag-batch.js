/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — PRICE TAG PRINTING, single and batch
   scripts/test-price-tag-batch.js      node scripts/test-price-tag-batch.js

   WHY THIS SUITE EXISTS
   The single price-tag button had never printed anything. It called
   PosPrintService.printPriceTag(), which does not exist and never has — that service prints
   receipts, refunds, quotes, invoices, kitchen tickets and shift reports, and has no label
   surface at all. The guard beneath it fired on every press and reported "the printer
   service is not loaded on this page", which was itself untrue: the service WAS loaded.

   A control that fails silently and then misreports why is worse than a missing one, so the
   assertions below pin both halves — that the engine is reachable, and that the message
   names the piece that is actually absent.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok (name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  → ' + detail : '')); }
}
function section (t) { console.log('\n' + t); }

const src = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-products.js'), 'utf8');
/* Assert on STRIPPED code: a check that matches its own explanatory comment proves
   nothing about what runs. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/* ── 1. THE ENGINE THAT ACTUALLY PRINTS LABELS ──────────────────────────────── */
section('Which engine');
{
  const svc = fs.readFileSync(path.join(ROOT, 'sokoni-pos-print-service.js'), 'utf8');
  /* THE PREMISE OF THE FIX, asserted rather than assumed. If PosPrintService ever gains a
     price-tag method this test fails loudly, which is correct: the routing should then be
     revisited, and the code already prefers it when present. */
  ok('PosPrintService still has no price-tag method',
     !/\bprintPriceTag\s*\(/.test(svc) && !/\bprintLabel\s*\(/.test(svc));

  const eng = fs.readFileSync(path.join(ROOT, 'sokoni-label-engine.js'), 'utf8');
  ok('control — the label engine does have one', /function printPriceTag\(/.test(eng));
  ok('and printLabel takes an ARRAY, so batch is its native shape',
     /function printLabel\(items/.test(eng));
  ok('printPriceTag is merely its one-item wrapper',
     /return printLabel\(\[item\]/.test(eng));

  ok('the module prefers PosPrintService when it has the method',
     /svc && typeof svc\.printPriceTag === 'function'/.test(code));
  ok('and falls back to the label engine', /window\.SokoniLabelEngine/.test(code));
  ok('a batch goes to printLabel as ONE job, not N',
     /eng\.printLabel\(items/.test(code));

  /* THE MISLEADING MESSAGE IS GONE. */
  ok('it no longer claims the printer service is not loaded',
     src.indexOf('The printer service is not loaded on this page') === -1);
  ok('and names the piece that is actually missing',
     src.indexOf('sokoni-label-engine.js is not loaded') > -1);

  ok('merchant-v2 now loads the label engine',
     fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8')
       .indexOf('sokoni-label-engine.js') > -1);
}

/* ── 2. WHAT GETS PRINTED ───────────────────────────────────────────────────── */
section('The tag');
{
  ok('the tag is built from the STORED record, not the form',
     /var p = E\.product;/.test(code));
  ok('an unsaved product cannot print',
     /if \(!p \|\| !p\.id\) return say\('Add the product first/.test(code));
  ok('the item carries name, price, sku and barcode',
     /name:.*\n?.*price:.*\n?.*sku:/s.test(code.slice(code.indexOf('function tagItem'),
                                                      code.indexOf('function printTags'))));
  ok('nothing without an id is ever printed',
     /\.filter\(function \(p\) \{ return p && p\.id; \}\)/.test(code));

  /* A QUEUED JOB IS NOT A PRINTED ONE. Announcing paper that does not exist is how a
     merchant walks to a printer that never ran. */
  ok('a queued job is reported distinctly', /r && r\.queued/.test(code));
  ok('and says so in words', src.indexOf('No printer connected —') > -1);
  ok('a missing barcode is explained, not swallowed',
     /BARCODE_UNAVAILABLE/.test(code));
}

/* ── 3. SELECTION ───────────────────────────────────────────────────────────── */
section('Batch selection');
{
  ok('the tick is its own control, not the card', /data-pr="pick"/.test(code));

  /* Checked BEFORE the card-body branch, or ticking a product would also open it — the
     thing that makes a bulk selector unusable on a phone. */
  const pickAt = code.indexOf("closest('[data-pr=\"pick\"]')");
  const openAt = code.indexOf("data-pr=\"open\"", code.indexOf('function onClick'));
  ok('and it is handled before anything that opens the product',
     pickAt > -1 && (openAt === -1 || pickAt < openAt), pickAt + ' vs ' + openAt);
  ok('ticking stops the event reaching the card', /ev\.stopPropagation\(\)/.test(code));

  /* SELECTION LIVES IN VIEW STATE, never on the record — being ticked must change nothing
     about a product. */
  ok('selection is held in view state', /S\.selected/.test(code));
  ok('and nothing is written to the product by ticking',
     !/S\.selected\[[^\]]+\]\s*=\s*[^t]/.test(code) || /S\.selected\[pp\.id\] = true/.test(code));

  /* A SELECTION MUST NOT OUTLIVE ITS ROWS. */
  const loadFn = code.slice(code.indexOf('function load ()'), code.indexOf('function load ()') + 400);
  ok('reloading the catalogue clears the selection', /S\.selected = \{\}/.test(loadFn));

  /* "ALL" MEANS WHAT IS ON SCREEN. All-meaning-the-whole-catalogue-behind-a-filter is how
     someone prints four hundred tags intending to print four. */
  const allFn = code.slice(code.indexOf("k === 'pickall'"), code.indexOf("k === 'pickno'"));
  ok('select-all covers only the painted rows', /S\.painted/.test(allFn));
  ok('and not the whole row set', allFn.indexOf('S.rows') === -1);
}

/* ── 4. THE BAR ─────────────────────────────────────────────────────────────── */
section('Batch bar');
{
  ok('it is absent until something is ticked',
     /if \(!n\) return '';/.test(code.slice(code.indexOf('function batchBarHTML'),
                                            code.indexOf('function batchBarHTML') + 400)));
  /* IT NAMES THE COUNT. Nobody should press print without knowing how much paper is about
     to come out — a 3-tag correction and a 40-tag shelf run are different decisions. */
  ok('it names how many will print', /'🖨 Print ' \+ n \+ ' price tag'/.test(code));
  /* The literal carries its closing tag, so an exact-quote match missed it. Matching the
     rendered phrase rather than the source's string boundaries is what the assertion
     actually meant. */
  ok('it says how many are selected', /n \+ ' selected</.test(code));
  ok('it is disabled while printing', /S\.printing \? ' disabled' : ''/.test(code));
  ok('a single tag is not called "1 price tags"',
     /\(n === 1 \? '' : 's'\)/.test(code));
  ok('one product can also be printed straight from its row menu',
     /data-pr="tag1"/.test(code));
}

console.log('\n' + (fail ? 'FAIL' : 'PASS') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
