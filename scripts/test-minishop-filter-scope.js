#!/usr/bin/env node
/* Catalogue-type filter pill: visual centring ONLY.
 *
 * THE REQUIREMENT THIS LOCKS IN
 * The pill fix must change where a pill SITS, never which products a shopper
 * SEES. Global catalogue keeps listing everything; an individual shop page keeps
 * listing only that shop's products. A regression here would be near-invisible
 * in review — a filter strip looks fine while quietly showing the wrong stock.
 *
 * WHY THE ASSERTIONS ARE SHAPED THIS WAY
 * The cheap version of this test would check "does _filterProductsByType still
 * exist". That passes even if the function starts issuing its own query. So the
 * assertions below pin the MECHANISM: the filter must read the already-loaded
 * in-memory array and must not contain any query construct at all.
 *
 *   node scripts/test-minishop-filter-scope.js
 */
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

const ROOT = path.join(__dirname, '..');
const JS   = fs.readFileSync(path.join(ROOT, 'sokoni-minishop.js'), 'utf8');
const CSS  = fs.readFileSync(path.join(ROOT, 'minishop.css'), 'utf8');

/* ══ A. Product scope is untouched ═══════════════════════════════════════ */
console.log('\nA. Catalogue scope — unchanged\n');
{
  const fn = JS.slice(JS.indexOf('function _filterProductsByType'),
                      JS.indexOf('function _filterProductsByType') + 1400);
  ck('the filter reads the ALREADY-LOADED in-memory array',
     /const products = _state\.allProducts \|\| \[\];/.test(fn));
  ck('  ...and filters it locally by type only',
     /products\.filter\(p => \(p\.type \|\| 'product'\) === cat\)/.test(fn));
  ck('  ...with "all" returning the unfiltered set',
     /cat === 'all' \? products :/.test(fn));

  /* The mechanism check: no query may appear inside the filter. */
  const queryish = /\b(where|collection|orderBy|startAfter|limit|getDocs|query)\s*\(/.test(fn);
  ck('the filter issues NO query of its own', !queryish);
  /* Negative control — the detector must be able to see one. */
  ck('  negative control: detector DOES flag a planted query',
     /\b(where|collection|orderBy|startAfter|limit|getDocs|query)\s*\(/
       .test("const x = collection(db,'products');"));

  ck('shop scoping still flows from the loader, not the filter',
     /_renderProductSections\(products, shopId\)/.test(JS)
     && /_state\.shopIdForFilter = shopId;/.test(JS));
  ck('the pill handler still passes the SAME category through',
     /btn\.classList\.add\('active'\);[\s\S]{0,700}?_filterProductsByType\(cat\);/.test(JS));
}

/* ══ B. The pill fix is visual only ══════════════════════════════════════ */
console.log('\nB. The fix changes position, not data\n');
{
  ck('centring is a scrollIntoView on the pill',
     /btn\.scrollIntoView\(\{ inline: 'center', block: 'nearest' \}\)/.test(JS));
  ck('  ...block:"nearest" so the PAGE is not scrolled',
     /block: 'nearest'/.test(JS));
  ck('  ...guarded, so an unsupported browser cannot break filtering',
     /try \{ btn\.scrollIntoView[\s\S]{0,90}?catch \(_\) \{\}/.test(JS));
  ck('scrollIntoView appears exactly once in the pill handler',
     (JS.match(/btn\.scrollIntoView/g) || []).length === 1);
  ck('the hidden-pill logic is untouched',
     /if \(cat !== 'all' && !products\.some\(p => \(p\.type \|\| 'product'\) === cat\)\) \{\s*\n\s*btn\.hidden = true; return;/.test(JS));
}

/* ══ C. CSS is scoped to the strip ═══════════════════════════════════════ */
console.log('\nC. CSS scope\n');
{
  /* Strip comments before asserting. The rule's own comment explains why
     `justify-content: center` must NOT be used, and a naive scan flags that
     prose as the very declaration it warns against. */
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = stripComments(CSS.slice(CSS.indexOf('.ms-catalog-filter {'),
                                       CSS.indexOf('.ms-catalog-filter::-webkit-scrollbar')));
  ck('scroll-padding-inline added to the strip', /scroll-padding-inline: 16px;/.test(rule));
  ck('scroll-behavior added', /scroll-behavior: smooth;/.test(rule));
  ck('horizontal scrolling preserved', /overflow-x: auto;/.test(rule));
  ck('flex layout preserved', /display: flex;/.test(rule));
  ck('container padding unchanged', /padding: 10px 16px;/.test(rule));

  /* The trap: justify-content:center on an overflowing flex scroller makes the
     leading pill unreachable. It must never appear here. */
  ck('NO justify-content DECLARATION on the strip (would make "All" unreachable)',
     !/^\s*justify-content\s*:/m.test(rule));
  /* Negative control: the detector must catch a real declaration. */
  ck('  negative control: detector DOES flag a real declaration',
     /^\s*justify-content\s*:/m.test('.x {\n  justify-content: center;\n}'));
  ck('reduced-motion honoured',
     /@media \(prefers-reduced-motion: reduce\) \{\s*\n\s*\.ms-catalog-filter \{ scroll-behavior: auto; \}/.test(CSS));

  /* The pills themselves must be untouched — the brief said so explicitly. */
  const pill = CSS.slice(CSS.indexOf('.ms-cat-btn {'), CSS.indexOf('.ms-cat-btn.active'));
  ck('pill rule still shrink-proof (strip still scrolls)', /flex-shrink: 0;/.test(pill));
  ck('  ...and carries no new alignment/width rules',
     !/margin: *auto|justify-self|align-self|width:|max-width:/.test(pill));
}

/* ══ D. Containment — only the minishop surface is involved ══════════════ */
console.log('\nD. Containment\n');
{
  ck('the filter strip markup still has all six pills',
     (fs.readFileSync(path.join(ROOT, 'minishop.html'), 'utf8')
        .match(/class="ms-cat-btn/g) || []).length === 6);
  /* sokoni-minishop.js + minishop.css are loaded only by the minishop surfaces,
     so the global catalogue (category/search/home) cannot be affected by this
     change — it does not load either file. */
  const loaders = ['minishop.html', 'minishop-admin.html'];
  loaders.forEach((f) => {
    const h = fs.readFileSync(path.join(ROOT, f), 'utf8');
    ck(f + ' loads the minishop bundle', /sokoni-minishop\.js|minishop\.css/.test(h));
  });
  ['category.html', 'index.html', 'search.html'].forEach((f) => {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) { ck(f + ' — not present, skipped', true); return; }
    const h = fs.readFileSync(p, 'utf8');
    ck(f + ' does NOT load the minishop bundle (global catalogue unaffected)',
       !/sokoni-minishop\.js/.test(h));
  });
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
