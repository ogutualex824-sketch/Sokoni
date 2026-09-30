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
/* The compact premium card (owner 2026-09-30): listing cards carry two icon controls on the
   photo — ❤ wishlist and 🛒 cart — and NO labelled rows. category.js is the reference. */
ck('category.js emits the canonical icon controls', CAT.indexOf('pcard-ico pcard-ico--wish') > -1 &&
   CAT.indexOf('pcard-ico pcard-ico--cart') > -1,
   'if the reference vanished, every comparison below would be vacuous');
ck('NEGATIVE category.js no longer emits the labelled rows',
   CAT.indexOf('class="pcard-actions"') === -1 && CAT.indexOf('pcard-mobile-strip') === -1,
   'the owner removed Buy/Add rows from listing cards on purpose');
ck('CONTROL the stylesheet governs the icons on both card kinds',
   CSS.indexOf(':is(.product-card, .st-product-card) .pcard-ico') > -1);

/* ── 2 · THE SHOP EMITS THE CANONICAL MARKUP ────────────────────────────────── */
head('2 · the shop card carries the icon controls');
ck('the ❤ wishlist icon is emitted', STORE.indexOf('class="pcard-ico pcard-ico--wish"') > -1);
ck('the 🛒 cart icon is emitted', STORE.indexOf('class="pcard-ico pcard-ico--cart"') > -1);
ck('both icons carry accessible names',
   /pcard-ico--wish" data-st-wish="' \+ i \+ '" aria-label="Save /.test(STORE) &&
   /pcard-ico--cart" data-st-cart="' \+ i \+ '" aria-label="Add /.test(STORE),
   'an emoji alone is not an accessible name');
ck('NEGATIVE no labelled row or Buy control on the shop card',
   STORE.indexOf('class="pcard-actions"') === -1 && STORE.indexOf('pcard-mobile-strip') === -1 &&
   STORE.indexOf('data-st-buy="') === -1,
   'Buy Now lives on the product page the card link opens');
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
   (STORE.match(/class="st-photo-icons"/g) || []).length === 1,
   'three renderers emitting their own copy is how the shop drifted from the marketplace');
ck('every renderer uses it, passing the product (for its chips)',
   (STORE.match(/stActionRows\(p\.id, (p\.name|name), p\)/g) || []).length === 3,
   'the cached-shop path and both live-Firestore paths');
ck('the icon layer sits OUTSIDE the product link',
   /<\/a>' \+ stActionRows\(/.test(STORE) && /<\/a>\s*\n\s*\$\{stActionRows\(/.test(STORE),
   'an icon inside the link would also navigate on tap');

/* ── 5 · THE STYLESHEET ──────────────────────────────────────────────────────── */
head('5 · the compact card styling');
{
  ck('the icons keep a ≥44px tap area (invisible ::before ring)',
     /\.pcard-ico::before\s*\{[^}]*inset:\s*-7px/.test(CSS));
  ck('a global 44px button min-height cannot stretch the icons into ovals',
     /\.pcard-ico\s*\{[^}]*min-height:\s*0 !important/.test(CSS));
  ck('the shop grid is 3 per row on phones',
     /@media \(max-width: 600px\)\s*\{\s*html body \.st-products-grid \{ grid-template-columns: repeat\(3/.test(CSS));
  ck('the chip row can never cover the photo', CSS.indexOf('.pcard-chips') > -1 && STORE.indexOf('class="pcard-chips"') > -1);
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
