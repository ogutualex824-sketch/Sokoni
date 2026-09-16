#!/usr/bin/env node
/* Homepage product-card contract.
 *
 * Product cards on index.html are browse-only. Cart, Wishlist and Buy controls
 * belong to product.html, where a shopper can select variants and delivery.
 * This static contract test protects every homepage renderer from quietly
 * bringing a duplicate action row back.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'compact-grid.css'), 'utf8');

const start = script.indexOf('function buildProductCard(');
const end = script.indexOf('/* ── Delegated product-card click handler', start);
if (start < 0 || end < 0) throw new Error('Could not locate buildProductCard()');
const renderer = script.slice(start, end);

let pass = 0;
const ck = (label, condition) => {
  if (!condition) throw new Error('FAIL  ' + label);
  pass++;
  console.log('PASS  ' + label);
};

ck('homepage renderer marks every card browse-only',
  /product-card pcard--browse-only/.test(renderer));
ck('homepage renderer emits no Cart action', !/data-action="cart"/.test(renderer));
ck('homepage renderer emits no Wishlist action', !/data-action="wish"/.test(renderer));
ck('homepage renderer emits no Buy action', !/data-action="buy"/.test(renderer));
ck('homepage renderer emits no mobile action strip', !/pcard-mobile-strip/.test(renderer));
ck('homepage renderer emits no desktop action block', !/pcard-actions/.test(renderer));
ck('browse-only cards retain a balanced bottom inset',
  /\.product-card\.pcard--browse-only \.product-body\s*\{[\s\S]*padding-bottom:\s*14px\s*!important/.test(css));

console.log(`\n${pass} passed, 0 failed`);
