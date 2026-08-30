#!/usr/bin/env node
/* ============================================================================
   Multi-Shop Checkout — INTEGRATION certification (Rail B)
   ============================================================================
   Proves the wiring the pure 33/0 quote test does NOT: that the callable is
   actually reachable through the coordinated index.js export, that ONE canonical
   validator is reused (no fork), that delivery stays server-authoritative, and
   that the checkout UI's payable comes from the server quote — never a client
   computation. Negatives on the quote math itself live in
   test-multishop-checkout-quote.js (referenced in section E).

     node scripts/test-multishop-checkout-integration.js
   ========================================================================= */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };

console.log('\nA. Reachable through the coordinated index.js export (not just the pure module)');
{
  const idx = read('functions', 'index.js');
  ck('index.js re-exports createMultiShopCheckoutQuote',
     /exports\.createMultiShopCheckoutQuote\s*=\s*require\('\.\/multishop-checkout-quote'\)\.createMultiShopCheckoutQuote/.test(idx));
  ck('the re-export sits in the checkout cluster (near getShopCheckoutMode), not the Daraja region',
     idx.indexOf('exports.getShopCheckoutMode') !== -1 &&
     Math.abs(idx.indexOf('exports.createMultiShopCheckoutQuote') - idx.indexOf('exports.getShopCheckoutMode')) < 600);
  let mod = null;
  try { mod = require('../functions/multishop-checkout-quote'); } catch (e) { console.log('   [require err] ' + e.message); }
  ck('the module actually exports the onCall createMultiShopCheckoutQuote',
     !!mod && typeof mod.createMultiShopCheckoutQuote !== 'undefined');
  ck('App Check is enforced on the callable',
     /enforceAppCheck:\s*true/.test(read('functions', 'multishop-checkout-quote.js')));
}

console.log('\nB. ONE canonical validator — the quote reuses product_order, no fork');
{
  const q  = read('functions', 'multishop-checkout-quote.js');
  const pp = read('functions', 'payment-purposes.js');
  ck('the quote calls the shared validateOrderLines', /validateOrderLines/.test(q));
  ck('payment-purposes exports validateOrderLines',
     /module\.exports = \{[^}]*validateOrderLines/.test(pp));
  ck('product_order calls validateOrderLines (not a private copy)',
     /await validateOrderLines\(uid, data\.items\)/.test(pp));
  ck('exactly ONE product-line validation loop exists in payment-purposes',
     (pp.match(/for \(const raw of items\)/g) || []).length === 1);
}

console.log('\nC. Delivery stays server-authoritative through the shared engine');
{
  const q = read('functions', 'multishop-checkout-quote.js');
  ck('the quote prices delivery through shared/delivery-engine', /shared\/delivery-engine/.test(q));
  ck('the quote does not hardcode a delivery fee', !/delivery\.fee\s*=\s*[0-9]/.test(q));
}

console.log('\nD. Checkout UI guard — the payable is the quote, never a client compute');
{
  const html   = read('checkout.html');
  const render = (html.split('window._ckRenderMultiShop')[1] || '').split('function _ckMultiShopSummary')[0];
  ck('checkout requests createMultiShopCheckoutQuote', /createMultiShopCheckoutQuote/.test(render));
  ck('per-shop payable is the quote shopTotal', /shopTotalLabel/.test(render));
  ck('the multishop render no longer computes a client subtotal as payable',
     !/g\.items\.reduce\([\s\S]*?price/.test(render));
  ck('the consolidated total is the quote grandTotal', /quote\.grandTotal/.test(html));
  ck('a failed quote shows an "at payment" state, not a fabricated total',
     /[Cc]onfirmed at payment/.test(html));
  ck('Option A documented: product_order takes no quoteId by design',
     /absence of quoteId here is intentional|takes NO quoteId/.test(read('functions', 'payment-purposes.js')));
  ck('per-shop pay SCOPES the charge: _ckPayShop sets _ckPendingShop and the charge consumes it',
     /window\._ckPendingShop = sellerUid/.test(html) &&
     /_ckScopeSeller\s*=\s*window\._ckPendingShop/.test(html) &&
     /_ckFullCart2\.filter\(i => \(i\.sellerUid \|\| i\.sellerId\) === _ckScopeSeller\)/.test(html));
  ck('the dead _ckShopScope (set-but-never-read) is gone from live code',
     !/window\._ckShopScope\s*=/.test(html));
  ck('the per-shop selection is cleared after the shop settles',
     /window\._ckPendingShop = null/.test(html));
}

console.log('\nE. Negatives covered elsewhere (referenced, not duplicated)');
{
  const t  = read('scripts', 'test-multishop-checkout-quote.js');
  ['amount_drift', 'expired', 'no server unitPrice', 'server could not resolve', 'Never free by default']
    .forEach((k) => ck('quote suite asserts: ' + k, t.indexOf(k) !== -1));
  ck('cross-shop settlement rejected by product_order (single-shop guard present)',
     /spans multiple sellers/.test(read('functions', 'payment-purposes.js')));
  ck('manual_payment refused at checkout-mode (gated to unavailable)',
     /manual_payment_unavailable/.test(read('functions', 'checkout-mode.js')));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
