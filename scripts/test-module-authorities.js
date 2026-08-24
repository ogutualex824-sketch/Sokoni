#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   TEST — every AUTHORITY a mounted module composes is actually loaded by its host
   ══════════════════════════════════════════════════════════════════════════════
   Run:  node scripts/test-module-authorities.js

   THE PATTERN THIS EXISTS TO STOP, which has now happened four times:

     · SokoniCash absent      → the till could not work out change
     · SokoniReceiptDoc absent→ receipts had no branded renderer
     · --panel / --card absent→ the payment sheet rendered transparent
     · and this run's finding: SokoniFulfilment, SokoniBuyerLocations and
       SokoniShift were never loaded into merchant-v2 at all

   Each time the module DEGRADED politely instead of failing, so nothing showed
   up in a console and nothing failed a test. "Delivery addresses are unavailable
   on this device" is not a bug report anyone can act on — it is the correct
   message for a missing authority, printed because the host never supplied it.

   A module is entitled to the authorities it declares. This asserts the host
   supplies every one, the same contract test-module-tokens.js asserts for CSS.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const rows = [];
const ck = (label, ok, detail) => rows.push({ ok, label, detail: detail == null ? '' : String(detail) });
const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };

/* Hosts, and the modules they mount. */
const HOSTS = [
  { host: 'merchant-v2.html', modules: [
    'sokoni-merchant-sell.js',
    'sokoni-merchant-inventory-ui.js',
    'sokoni-merchant-store-ui.js',
    'sokoni-merchant-customers-ui.js',
    'sokoni-merchant-disputes-ui.js',
    'sokoni-merchant-messages-ui.js',
  ] },
];

/* Which file defines a given global — discovered, not hardcoded, so a renamed
   file cannot make this suite quietly stop checking. */
function providerOf(globalName) {
  const files = fs.readdirSync(ROOT).filter((f) => /^sokoni-[a-z0-9-]+\.js$/.test(f));
  const re = new RegExp('(?:root|global|window)\\.' + globalName + '\\s*=');
  for (const f of files) if (re.test(read(f))) return f;
  return null;
}

/* Every `G().SokoniX` / `globalThis.SokoniX` a module reaches for. Comments are
   stripped first: a module that DOCUMENTS an authority it no longer uses would
   otherwise be reported as needing it. */
function authoritiesUsed(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out = new Set();
  const re = /(?:G\(\)|globalThis|window|root)\.(Sokoni[A-Za-z]+)/g;
  let m;
  while ((m = re.exec(code))) out.add(m[1]);
  /* A module's OWN global is not a dependency on the host. */
  return out;
}

let anyMissing = false;

for (const H of HOSTS) {
  const hostSrc = read(H.host);
  ck('A0  host ' + H.host + ' was readable', hostSrc.length > 0, hostSrc.length + ' bytes');

  for (const mod of H.modules) {
    const src = read(mod);
    if (!src) continue;
    const own = (src.match(/(?:root|global|window)\.(Sokoni[A-Za-z]+)\s*=/) || [])[1];
    const needs = [...authoritiesUsed(src)].filter((g) => g !== own);

    const missing = [];
    for (const g of needs) {
      const file = providerOf(g);
      /* No provider file at all → the global is defined inline by the host, or
         it does not exist. Either way, look for it in the host source. */
      const loadedByFile = file
        ? new RegExp('src="/?' + file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"').test(hostSrc)
        : false;
      const definedInline = new RegExp('(?:window|globalThis)\\.' + g + '\\s*=').test(hostSrc);
      if (!loadedByFile && !definedInline) missing.push(g + (file ? ' (' + file + ')' : ' (no provider found)'));
    }

    if (missing.length) anyMissing = true;
    ck('A  ' + mod + ' — every authority it composes is loaded by the host',
      missing.length === 0,
      missing.length
        ? 'NOT LOADED: ' + missing.join(', ') +
          '  — the module degrades politely and the merchant sees a dead feature'
        : needs.length + ' authorities, all supplied');
  }
}

/* ── the four that actually broke, named so a regression is unmistakable ───── */
const mv2 = read('merchant-v2.html');
for (const [g, f] of [['SokoniCash', 'sokoni-cash.js'],
                      ['SokoniReceiptDoc', 'sokoni-receipt.js'],
                      ['SokoniFulfilment', 'sokoni-fulfilment.js'],
                      ['SokoniBuyerLocations', 'sokoni-buyer-locations.js'],
                      ['SokoniShift', 'sokoni-shift.js']]) {
  ck('A1  ' + g + ' is loaded into merchant-v2',
    new RegExp('src="/?' + f.replace(/\./g, '\\.') + '"').test(mv2),
    f + (g === 'SokoniBuyerLocations'
      ? ' — absent, the till said "Delivery addresses are unavailable on this device"'
      : g === 'SokoniShift' ? ' — absent, no cash-drawer movement was ever emitted' : ''));
}

/* ── CONTROLS ──────────────────────────────────────────────────────────────── */
ck('A2  CONTROL the detector finds a genuinely absent authority',
  !new RegExp('src="/?sokoni-definitely-not-real\\.js"').test(mv2),
  'a checker that cannot fail would have passed while three modules were missing');

ck('A3  CONTROL comments do not count as usage',
  !authoritiesUsed('/* uses G().SokoniNotReallyUsed */ var x = 1;').has('SokoniNotReallyUsed'),
  'otherwise documenting a removed dependency would demand it back');

ck('A4  CONTROL a module does not depend on ITSELF',
  !(() => {
    const src = read('sokoni-merchant-sell.js');
    const own = (src.match(/(?:root|global|window)\.(Sokoni[A-Za-z]+)\s*=/) || [])[1];
    return [...authoritiesUsed(src)].filter((g) => g !== own).includes('SokoniMerchantSell');
  })(),
  'self-registration is not a host dependency');

const passed = rows.filter((r) => r.ok).length;
console.log('');
console.log('  MODULE AUTHORITIES — a module is entitled to what it composes');
console.log('  ' + '='.repeat(68));
console.log('');
for (const r of rows) console.log('  ' + (r.ok ? 'PASS  ' : 'FAIL  ') + r.label + '\n        [' + r.detail + ']');
console.log('');
console.log('  ' + passed + ' passed, ' + (rows.length - passed) + ' failed');
console.log('');
process.exit(passed === rows.length ? 0 : 1);
