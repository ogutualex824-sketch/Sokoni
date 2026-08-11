#!/usr/bin/env node
/* Positive controls for scripts/scan-cart-writers.js.
 *
 *   node scripts/test-cart-scanner.js
 *
 * The scanner's whole job is to report zero only when zero is true. It has already been
 * silently weaker than it looked once: requiring a string literal inside the localStorage
 * call hid sokoni-food.js — a complete parallel cart implementation across five pages —
 * through three migration slices while the reports quoted confident writer counts.
 *
 * So every form the scanner claims to resolve gets a control that must be DETECTED, and
 * every form it must ignore gets one that must NOT be. If someone simplifies the scanner
 * later, this fails rather than the sweep going quietly green.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const S = require('./scan-cart-writers.js');
const { stripComments } = require('./scan-legacy-wishlist.js');

let pass = 0, fail = 0;
function ck(label, ok, detail) {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined ? '   [' + String(detail).slice(0, 80) + ']' : ''));
  ok ? pass++ : fail++;
}
/* Controls go through the same stripper the scanner uses in production. */
const hits = (src) => S.scanSource(stripComments(src), 'control.js');
const writes = (src) => hits(src).filter(h => h.kind === 'WRITE' && h.key === 'cart');
const reads  = (src) => hits(src).filter(h => h.kind === 'READ' && h.key === 'cart');
const any    = (src) => hits(src).filter(h => h.key === 'cart');

console.log('\nCART SCANNER — positive controls\n' + '='.repeat(64));

console.log('\nA. Forms it must DETECT');
ck('literal setItem', writes(`localStorage.setItem('cart', JSON.stringify(x));`).length === 1);
ck('literal getItem', reads(`var c = localStorage.getItem("cart");`).length === 1);
ck('literal removeItem',
   hits(`localStorage.removeItem('cart');`).filter(h => h.kind === 'DELETE').length === 1);
ck('bracket write', writes(`localStorage['cart'] = v;`).length === 1);
ck('bracket read', reads(`var c = localStorage['cart'];`).length === 1);

/* The form that hid sokoni-food.js. */
ck('CONSTANT key — the sokoni-food.js form',
   writes(`const SHARED_CART_KEY='cart';\nlocalStorage.setItem(SHARED_CART_KEY, JSON.stringify(items));`).length === 1);
ck('constant key, read side',
   reads(`const K = 'cart';\nreturn JSON.parse(localStorage.getItem(K)||'[]');`).length === 1);
ck('constant key via let', writes(`let KK='cart'; localStorage.setItem(KK, x);`).length === 1);
ck('constant key in bracket form', writes(`const K='cart'; localStorage[K] = x;`).length === 1);

ck('storage ALIAS', writes(`const ls = localStorage;\nls.setItem('cart', x);`).length === 1);
ck('window-qualified alias', writes(`var st = window.localStorage;\nst.setItem('cart', x);`).length === 1);
ck('alias AND constant together',
   writes(`const ls = window.localStorage; const K = 'cart';\nls.setItem(K, x);`).length === 1);

/* A sokoniCart write must be TRACKED, but must not be miscounted as a 'cart' hit —
   they are different stores and 2.5 owns the bridge between them. */
{
  const src = `localStorage.setItem('sokoniCart', x);`;
  ck('sokoniCart is tracked under its own key',
     hits(src).some(h => h.key === 'sokoniCart' && h.kind === 'WRITE'),
     JSON.stringify(hits(src).map(h => h.key + ':' + h.kind)));
  ck('...and is NOT counted as a cart hit', any(src).length === 0,
     JSON.stringify(any(src).map(h => h.key)));
}

console.log('\nB. Forms it must IGNORE');
ck('block comment', any(`/* localStorage.setItem('cart', x) */`).length === 0);
ck('line comment', any(`// localStorage.setItem('cart', x)`).length === 0);
ck('a comment DESCRIBING a removed writer',
   any(`/* This used to call localStorage.setItem('cart', …) and no longer does. */`).length === 0);
ck('an unrelated key', any(`localStorage.setItem('sokoniUser', x);`).length === 0);
ck('a different storage object', any(`sessionStorage.setItem('cart', x);`).length === 0);
ck('the regex-vs-string trap that broke the wishlist scanner',
   writes(`a.replace(/"/g,"&quot;").replace(/'/g,"&#x27;");\nlocalStorage.setItem('cart', x);`).length === 1);

console.log('\nC. Classification');
{
  const h = hits(`localStorage.setItem('cart',a); localStorage.getItem('cart'); localStorage.removeItem('cart');`);
  ck('write / read / delete told apart',
     h.filter(x => x.kind === 'WRITE').length === 1 &&
     h.filter(x => x.kind === 'READ').length === 1 &&
     h.filter(x => x.kind === 'DELETE').length === 1,
     JSON.stringify(h.map(x => x.kind)));
  ck('bracket assignment is a WRITE, bracket read is a READ',
     writes(`localStorage['cart']=1;`).length === 1 && reads(`f(localStorage['cart']);`).length === 1);
  ck('the resolution path is reported for review',
     hits(`const K='cart'; localStorage.setItem(K,x);`)[0].via === 'const K',
     hits(`const K='cart'; localStorage.setItem(K,x);`)[0].via);
}

console.log('\nD. Against the real repository');
{
  const all = S.scan().filter(h => h.key === 'cart');
  const files = new Set(all.map(h => h.file));
  /* The control that matters: constant-keyed access must still be visible against the
     REAL repository, not only against synthetic strings.

     This used to point at sokoni-food.js, the file that hid from the literal-only scanner
     for three slices. 2.5 migrated it, so it no longer has cart access to find — but the
     capability it proved still needs proving, and sokoni-cart.js reaches the same key
     through `const KEY = 'cart'`. Retargeted rather than dropped: losing this control
     would let the scanner silently regress to literal-only again. */
  ck('resolves a constant key against the real repo', files.has('sokoni-cart.js'),
     [...files].join(', '));
  ck('and reports it as constant-keyed',
     all.some(h => h.file === 'sokoni-cart.js' && /^const /.test(h.via)),
     all.filter(h => h.file === 'sokoni-cart.js').map(h => h.via).join(','));
  ck('sokoni-food.js no longer appears at all — 2.5 migrated it',
     !files.has('sokoni-food.js'), [...files].join(', '));
  /* Was `checkout.html && provider-wiring.js`. 2.4 migrated checkout, so it no longer
     appears at all — the assertion is now driven by the registry rather than by two names
     typed here, and it keeps testing the same thing: the scanner can see the survivors. */
  const STATE_ = require('./cart-migration-state.js');
  const survivors = [...STATE_.FROZEN_FILES, ...STATE_.DEFERRED_FILES, ...STATE_.BLOCKED_FILES];
  ck('finds every declared survivor', survivors.every(f => files.has(f)),
     survivors.filter(f => !files.has(f)).join(', ') || 'all present');
  ck('finds every already-migrated surface\'s absence', (function () {
    /* Migrated files must NOT appear at all. */
    const STATE = require('./cart-migration-state.js');
    const leaked = STATE.MIGRATED.filter(f => files.has(f));
    ck('  (migrated surfaces have no direct cart access)', leaked.length === 0, leaked.join(', '));
    return true;
  })());
  ck('page scope resolves a page plus its local scripts', (function () {
    const { files: f } = S.pageScope('index.html');
    return f.length > 1 && f[0] === 'index.html';
  })());
}

console.log('\n' + '='.repeat(64));
console.log('  TOTAL:   ' + (pass + fail) + '\n  PASSED:  ' + pass + '\n  FAILED:  ' + fail);
process.exit(fail ? 1 : 0);
