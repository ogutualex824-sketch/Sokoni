#!/usr/bin/env node
/* SHOP PRODUCT CARDS — the marketplace action controls, one canonical implementation.
 *
 * THE DEFECT
 * store.html rendered each product as a bare <a> containing image, name and price. It had
 * NO cart, wishlist or buy control on ANY viewport — measured live: 0 product cards with
 * actions at 390px and at 1280px. The homepage and category pages were already correct
 * (40 and 100 cards, mobile strips visible below 600px with 44x44 targets, desktop rows
 * above it), so this was never "mobile is broken": the upgraded card system had simply
 * never been applied to the shop surface.
 *
 * WHAT IS ASSERTED HERE, AND WHY IT IS SOURCE-LEVEL
 * The live shop page renders zero cards without a shop that has products, so a viewport
 * sweep of store.html itself needs production data this rig does not have — that is
 * reported UNPROVEN rather than dressed up. What CAN be proven without it: the shop now
 * emits the SAME canonical markup the working pages emit, wired to the SAME action
 * service, and the stylesheet that governs it no longer omits the shop's grid.
 *
 * The companion browser sweep (test-shop-card-viewports.js) measures the canonical
 * component itself at every required width on a page that does render it.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0, unproven = 0;
function head (t) { console.log('\n' + t); }
function ck (label, cond, note) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (note ? '   [' + note + ']' : '')); }
}
function unk (label, why) { unproven++; console.log('  UNPROVEN  ' + label + '   [' + why + ']'); }

const STORE = read('store.html');
const CSS = read('compact-grid.css');
const CAT = read('category.js');

/* ── 1 · CONTROL ─────────────────────────────────────────────────────────────── */
head('1 · CONTROL — the reference implementation is present to compare against');
ck('category.js emits the canonical rows', CAT.indexOf('pcard-mobile-strip') > -1 &&
   CAT.indexOf('pcard-actions') > -1,
   'if the reference vanished, every comparison below would be vacuous');
ck('CONTROL the stylesheet governs both rows',
   CSS.indexOf('.pcard-actions') > -1 && CSS.indexOf('.pcard-mobile-strip') > -1);

/* ── 2 · THE SHOP EMITS THE CANONICAL MARKUP ────────────────────────────────── */
head('2 · the shop card carries both rows');
ck('a desktop action row is emitted', STORE.indexOf('class="pcard-actions"') > -1,
   'the shop had none on any viewport');
ck('a mobile action strip is emitted', STORE.indexOf('class="pcard-mobile-strip"') > -1);
ck('the mobile strip carries all three controls',
   STORE.indexOf('pcard-m-wish') > -1 && STORE.indexOf('pcard-m-cart') > -1 &&
   STORE.indexOf('pcard-m-buy') > -1,
   'wishlist, add-to-cart and buy');
ck('NEGATIVE no shop-only button class was invented',
   !/class="st-(cart|buy|wish)-btn/.test(STORE),
   'a second implementation is exactly what drifts from the marketplace');

/* ── 3 · CONTROLS ARE NOT INSIDE THE LINK ───────────────────────────────────── */
head('3 · the controls are siblings of the link, not children of it');
ck('the card is no longer the anchor', STORE.indexOf('<a class="st-product-card"') === -1,
   'a <button> inside an <a> follows the href on tap and is announced as a link');
ck('the anchor wraps only image and text', STORE.indexOf('class="st-product-link"') > -1);
ck('the link class is styled', CSS.indexOf('.st-product-link') > -1 ||
   STORE.indexOf('.st-product-link {') > -1 || STORE.indexOf('.st-product-link{') > -1,
   'moving the anchor without moving its styling would flatten the card');
ck('the handler cancels navigation explicitly',
   STORE.indexOf('ev.preventDefault()') > -1,
   'stopPropagation alone does NOT cancel an ancestor anchor default');

/* ── 4 · ONE ACTION SERVICE, NOT A SECOND CART ──────────────────────────────── */
head('4 · the shop uses the canonical action service');
ck('SokoniMarket is the action path', STORE.indexOf('window.SokoniMarket') > -1);
ck('the module is actually loaded', /<script[^>]+src="market-actions\.js"/.test(STORE));
ck('NEGATIVE the shop does not write the cart itself',
   STORE.indexOf("localStorage.setItem('cart'") === -1 &&
   STORE.indexOf('localStorage.setItem("cart"') === -1,
   'sokoni-cart.js exists to end the seventeen-writer problem');
ck('buy-now goes through the cart rather than a parallel path',
   STORE.indexOf("M.addToCart(item)") > -1,
   'add-then-checkout keeps the cart the single source of truth');
ck('a missing service is reported, not silently swallowed',
   STORE.indexOf('Still loading') > -1);
ck('one delegated listener at document level, not one per grid or card',
   /document\.addEventListener\('click'/.test(STORE) &&
   STORE.indexOf('ONE listener on the document') > -1,
   'this page has THREE renderers writing to more than one container; a grid-bound ' +
   'handler covers only whichever ran, and per-button handlers leak on every re-render');
ck('the action markup has exactly ONE definition',
   (STORE.match(/function stActionRows/g) || []).length === 1 &&
   (STORE.match(/class="pcard-actions"/g) || []).length === 1,
   'three renderers emitting their own copy is how the shop drifted from the marketplace');
ck('every renderer uses it', (STORE.match(/stActionRows\(/g) || []).length === 3,
   'the cached-shop path and both live-Firestore paths');

/* ── 5 · THE STYLESHEET NO LONGER OMITS THE SHOP GRID ───────────────────────── */
head('5 · the mobile-strip selector asymmetry');
{
  const strip = (CSS.match(/\.[a-z-]+ \.pcard-mobile-strip/g) || []);
  ck('CONTROL mobile-strip selector groups were found', strip.length > 0, strip.length + ' selectors');
  ck('the shop grid is styled by the strip rules',
     CSS.indexOf('.st-products-grid .pcard-mobile-strip') > -1);
  ck('the previously-omitted .products-grid is styled too',
     CSS.indexOf('.products-grid .pcard-mobile-strip') > -1,
     'the desktop row was scoped to three containers, the strip to two');
  ck('NEGATIVE no selector was duplicated inside a group',
     (function () {
       const groups = CSS.split('}').filter((g) => g.indexOf('.pcard-') > -1);
       return groups.every((g) => ['\\.products-grid', '\\.st-products-grid'].every((s) => {
         const m = g.match(new RegExp(s + ' \\.pcard-[a-z-]+', 'g')) || [];
         return m.length === new Set(m).size;
       }));
     })());
  ck('CONTROL the stylesheet still balances', (CSS.match(/\{/g) || []).length === (CSS.match(/\}/g) || []).length);
}

/* ── 6 · WHAT THIS FILE CANNOT PROVE ────────────────────────────────────────── */
head('6 · boundaries');
unk('the live shop page rendered at each required viewport',
    'store.html renders zero cards without a shop that has products; needs a real shop URL');
unk('a real tap adding to the real cart',
    'requires a signed-in session and a live shop');

head('RESULT');
console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
process.exit(fail > 0 ? 1 : 0);
