#!/usr/bin/env node
/**
 * test-provider-nav-home.js — a SERVICE provider's home is the provider dashboard. Static analysis.
 *
 * Owner 2026-10-03: "make sure Shave 'n' Trims [a barber] … even DJ Bambi have the correct equipped dashboard".
 * Live (72dca56) sokoni-nav-engine mapped the `provider` role to seller.html in BOTH the Back map and the role
 * switcher. seller.html is the PRODUCT seller hub (Products · Orders · POS · Delivery Hub), and because seller.html
 * is a `seller`-mapped page, _workspace() resolves a provider there as a BUYER. A barber or a DJ following the nav
 * landed on the wrong workspace with the wrong tools.
 *
 * Rows:
 *   N1  _BACK.provider        === 'provider-dashboard.html'
 *   N2  _ROLE_META.provider.h === 'provider-dashboard.html'
 *   N3  the provider home is NOT a seller-mapped page (it must resolve to the provider workspace, not to buyer)
 *   N4  the target page exists in this tree and is the provider workspace (Services + Bookings + Calendar sections)
 *   N5  no other provider home target points at seller.html
 *   SABOTAGE=1 → the original seller.html mapping must FAIL N1 / N2 / N5.
 *
 *   node scripts/test-provider-nav-home.js
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
let src = fs.readFileSync(path.join(ROOT, 'sokoni-nav-engine.js'), 'utf8');
if (process.env.SABOTAGE === '1') src = src.split("'provider-dashboard.html'").join("'seller.html'");
let pass = 0, fail = 0;
const ck = (id, ok, m, d) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (ok || d === undefined ? '' : '   [' + JSON.stringify(d) + ']')); ok ? pass++ : fail++; };

function block(name) {
  const i = src.indexOf('var ' + name + ' = {');
  if (i < 0) return null;
  let d = 0;
  for (let j = src.indexOf('{', i); j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) return src.slice(i, j + 1); }
  return null;
}
const BACK = block('_BACK'), META = block('_ROLE_META'), WS = block('_WS_MAP');
if (!BACK || !META || !WS) { console.error('HARNESS ERROR: nav maps not found (_BACK/_ROLE_META/_WS_MAP) — cannot prove anything'); process.exit(2); }

const back = (BACK.match(/provider:\s*'([^']+)'/) || [])[1];
const meta = (META.match(/provider:\s*\{[^}]*h:\s*'([^']+)'/) || [])[1];
console.log('\nProvider nav home   (sokoni-nav-engine.js' + (process.env.SABOTAGE === '1' ? ', SABOTAGE' : '') + ')\n');
ck('N1', back === 'provider-dashboard.html', 'Back destination for the provider workspace is the provider dashboard', back);
ck('N2', meta === 'provider-dashboard.html', 'role switcher sends a provider to the provider dashboard', meta);
const sellerMapped = new RegExp("'" + (meta || '').replace(/\./g, '\\.') + "'\\s*:\\s*'seller'").test(WS);
ck('N3', !!meta && !sellerMapped, 'the provider home is not a seller-mapped page (resolves to provider, never buyer)', { meta, sellerMapped });
let page = '';
try { page = fs.readFileSync(path.join(ROOT, meta || 'missing.html'), 'utf8'); } catch (_) {}
ck('N4', /data-tab=|Services/.test(page) && /Bookings/.test(page) && /Calendar/.test(page), 'the target exists and is the provider workspace (Services · Bookings · Calendar)', meta);
ck('N5', !/provider:\s*'seller\.html'/.test(BACK) && !/provider:\s*\{[^}]*h:\s*'seller\.html'/.test(META), 'no provider home target points at seller.html');
console.log('\n' + pass + ' passed, ' + fail + ' failed' + (process.env.SABOTAGE === '1' ? '   (SABOTAGE — failures EXPECTED)' : ''));
process.exit(fail ? 1 : 0);
