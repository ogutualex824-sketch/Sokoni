#!/usr/bin/env node
/* GATE — a nav button must say where it actually goes
   =========================================================================
   Run:  node scripts/verify-nav-identity-honest.js

   Sell and POS are two different products. The bottom nav's till slot may
   change its DESTINATION when a shell cannot render the preferred route —
   that is what `fallback` is for — but it may not keep the preferred route's
   LABEL while doing so.

   It did. merchant.html substituted only the id, drew the button from the
   original icon and label, and shipped a control reading "Sell" that opened
   POS. Nothing on screen could tell the merchant why.
========================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const V1 = process.env.SK_V1 || path.join(ROOT, 'merchant.html');
const src = fs.readFileSync(V1, 'utf8');
const code = src.replace(/<!--[\s\S]*?-->/g, ' ')
                .replace(/\/\*[\s\S]*?\*\//g, ' ')
                .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const rows = [];
const ck = (label, ok, detail) => rows.push({ label, ok, detail: detail == null ? '' : String(detail) });

/* Bound the assertions to the substitution's own expression, not the file. A
   file-wide search for "label:" passes on any page that mentions one. */
const sub = (code.match(/if \(b\.fallback && !withheldId\(b\.fallback\)\)[\s\S]{0,700}?\n    \}/) || [''])[0];

ck('N1   the fallback substitution still exists', !!sub,
  sub ? 'found' : 'no fallback branch — the till slot may have been removed entirely');

ck('N2   it carries the DESTINATION label, not the preferred one',
  /label:\s*target\.(label|name)/.test(sub),
  /label:/.test(sub) ? 'label taken from the fallback route'
                     : 'no label override — the button would keep saying "Sell" while opening POS');

ck('N3   it carries the destination ICON too',
  /icon:\s*target\.icon/.test(sub),
  /icon:/.test(sub) ? 'icon taken from the fallback route' : 'icon still the preferred route\'s');

ck('N4   the destination is resolved from the route registry',
  /byId\[b\.fallback\]/.test(sub),
  'a hardcoded label would drift from the contract the moment a route is renamed');

ck('N5   the preferred id is still recorded for diagnosis',
  /preferred:\s*b\.id/.test(sub),
  'so a report can say which route was withheld, not merely what was shown');

/* The renderer must still read label/icon off the (now corrected) object — if a
   future edit inlined the contract values, N2/N3 would be true and useless. */
const render = (code.match(/BOTTOM_NAV\.forEach\([\s\S]{0,600}?\n  \}\);/) || [''])[0];
ck('N6   the renderer draws from the object it was handed',
  /b\.icon/.test(render) && /b\.label/.test(render),
  render ? 'uses b.icon and b.label' : 'renderer not located');

/* Sell and POS must remain separate destinations — the fix must not have
   collapsed one into the other. */
const REG = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-routes.js'), 'utf8');
const sellRoute = /\{\s*id:'sell'/.test(REG);
const posRoute = /\{\s*id:'pos'/.test(REG);
ck('N7   Sell and POS are still SEPARATE routes in the registry', sellRoute && posRoute,
  'sell=' + sellRoute + ' pos=' + posRoute + ' — merging them would be the wrong fix');

const sellNative = /id:'sell'[\s\S]{0,200}?kind:'native'/.test(REG);
ck('N8   Sell remains native, not the POS iframe', sellNative,
  sellNative ? 'kind:native — the phone-first till' : 'sell is no longer a native route');

const passed = rows.filter((r) => r.ok).length;
console.log('');
console.log('  NAV IDENTITY GATE');
console.log('  ' + '='.repeat(56));
console.log('');
for (const r of rows) console.log('  ' + (r.ok ? 'PASS  ' : 'FAIL  ') + r.label + '\n        [' + r.detail + ']');
console.log('');
console.log('  ' + passed + ' passed, ' + (rows.length - passed) + ' failed');
console.log('');
process.exit(passed === rows.length ? 0 : 1);
