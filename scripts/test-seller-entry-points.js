#!/usr/bin/env node
/**
 * SELLER ENTRY POINTS — every rail must reach the same Seller Hub.
 *
 *   node scripts/test-seller-entry-points.js
 *
 * The Seller Hub cutover moved four rails to merchant-v2: the role authority, the entry
 * resolver, the profile links and post-login. A FIFTH was missed, because it is not code:
 *
 *     manifest.json  "Sell on Sokoni"  ->  /seller?source=shortcut
 *
 * A PWA shortcut is a static URL. It consults no authority, so long-pressing the app icon
 * dropped a merchant straight into the legacy Seller Dashboard — old pages, old chrome, its
 * own bottom nav — while every code path was correctly pointing at v2. That is why the
 * surfaces looked "rolled back" after a release that had moved them all.
 *
 * This audits ENTRY POINTS, not code paths, because the defect lived in data.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 96) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n' + t);

/* The legacy destinations a seller must no longer be dropped into. */
const LEGACY = /\/seller(\?|$|#)|seller\.html|\/merchant(\?|$|#)(?!-v2)|merchant\.html/;

console.log('\nSELLER ENTRY POINTS\n' + '='.repeat(58));

/* ── 1. the PWA manifest ─────────────────────────────────────────────────────── */
head('1 · the PWA manifest — a static URL that consults no authority');
const mf = JSON.parse(read('manifest.json'));
const shortcuts = mf.shortcuts || [];
ck('the manifest declares shortcuts', shortcuts.length > 0, shortcuts.length);

const sell = shortcuts.filter((s) => /sell|merchant|shop.?owner/i.test(s.name || ''));
ck('a selling shortcut exists', sell.length > 0, sell.map((s) => s.name).join(', '));
sell.forEach((s) => {
  ck('"' + s.name + '" does NOT point at the legacy shell', !LEGACY.test(s.url || ''), s.url);
  ck('"' + s.name + '" points at the Seller Hub', /\/merchant-v2/.test(s.url || ''), s.url);
});
const strayed = shortcuts.filter((s) => LEGACY.test(s.url || ''));
ck('NO shortcut of any name reaches the legacy shell', strayed.length === 0,
   strayed.map((s) => s.name + ' -> ' + s.url).join(', ') || 'none');

ck('start_url is unchanged and public', mf.start_url === '/?source=pwa', mf.start_url);

/* ── 2. the four code rails still agree ──────────────────────────────────────── */
head('2 · the code rails still point at the same hub');
const RA = read('sokoni-role-authority.js');
const ENTRY = read('sokoni-merchant-entry.js');
const PROFILE = read('profile.html');
const AUTH = read('auth.js');

ck('role authority: seller -> merchant-v2', /seller:\s*'merchant-v2\.html'/.test(RA));
ck('entry resolver: MERCHANT_URL = /merchant-v2', /MERCHANT_URL\s*=\s*'\/merchant-v2'/.test(ENTRY));
ck('profile links route through the authority',
   (PROFILE.match(/data-sk-merchant-entry/g) || []).length >= 4 &&
   PROFILE.indexOf('href="merchant.html"') === -1);
ck('post-login asks the authority, not a checkbox',
   /_entry\.resolve\(\)/.test(AUTH) && AUTH.indexOf('dest  = "seller.html";') === -1);

/* ── 3. buyer routing is untouched ───────────────────────────────────────────── */
head('3 · the buyer is not collateral');
ck('buyer still resolves to index.html', /buyer:\s*'index\.html'/.test(RA));
ck('the shopping shortcuts are unchanged',
   shortcuts.some((s) => /category/.test(s.url || '')) &&
   shortcuts.some((s) => /flashsale/.test(s.url || '')),
   'this slice moves the SELLER entry only');

/* ── 4. controls ─────────────────────────────────────────────────────────────── */
head('4 · controls — the check must be able to fail');
ck('CONTROL the legacy pattern matches what it is meant to catch',
   LEGACY.test('/seller?source=shortcut') && LEGACY.test('seller.html') && LEGACY.test('/merchant'),
   'a pattern that matches nothing would pass every manifest');
ck('CONTROL it does NOT match the Seller Hub itself',
   !LEGACY.test('/merchant-v2?source=shortcut') && !LEGACY.test('merchant-v2.html'),
   'or the fix would look like the defect');
ck('CONTROL it does not match unrelated seller pages',
   !LEGACY.test('/seller-analytics') && !LEGACY.test('/seller-delivery'),
   'those are distinct surfaces, not the legacy dashboard');

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
