#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   PUBLIC BUSINESS PAGES USE THE CANONICAL FIREBASE APP
   ------------------------------------------------------------------------------
   business.html ran initializeApp(FB_CONFIG, 'bizPage') and businesses.html ran
   initializeApp(FB_CONFIG, 'bizDir'). App Check is attached to the DEFAULT app
   (firebase.js:145) and a SECONDARY app does not inherit it — so every Firestore read
   from those two public surfaces went out with no App Check token. Under enforcement
   they came back PERMISSION_DENIED, getDoc threw, and business.html's catch rendered

       "Could not load business"

   for a shop that exists and is perfectly readable. Verified live: App Check returns
   403 "App attestation failed" and Firestore 403 "Missing or insufficient permissions".

   The fix is architectural — reuse the canonical app — not a rules change, not an
   App Check exemption, and not a catch that swallows the error.

   These are static assertions: they need no emulator and no network, so they can guard
   the invariant on every run.

     node scripts/test-public-business-firebase.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
/* These files EXPLAIN the removed pattern in comments — the whole point is that a future
   reader understands why 'bizPage' must not come back. Assertions must therefore read
   code, not prose, or the documentation would fail the test that documents it. */
const code = (f) => read(f)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');

let pass = 0, fail = 0;
const failures = [];
const ok = (l, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + l); return true; }
  fail++; failures.push(l + (d ? '  → ' + d : ''));
  console.log('  FAIL  ' + l + (d ? '   → ' + d : ''));
  return false;
};
const head = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');

const PUBLIC_PAGES = ['business.html', 'businesses.html'];

(function run() {
  console.log('\nPUBLIC BUSINESS PAGES — canonical Firebase app\n' + '='.repeat(64));

  head('A · no secondary Firebase app on a public surface');
  PUBLIC_PAGES.forEach((f) => {
    const src = code(f);
    ok(f + ' does not create a named secondary app',
       !/initializeApp\s*\([^)]*,\s*['"][^'"]+['"]\s*\)/.test(src),
       (src.match(/initializeApp\s*\([^)]*,\s*['"][^'"]+['"]\s*\)/) || [])[0]);
  });
  ok('business.html no longer references the bizPage app in CODE', !/['"]bizPage['"]/.test(code('business.html')));
  ok('businesses.html no longer references the bizDir app in CODE', !/['"]bizDir['"]/.test(code('businesses.html')));

  head('B · they consume the canonical app instead');
  PUBLIC_PAGES.forEach((f) => {
    const src = code(f);
    ok(f + ' imports db from firebase.js',
       /import\s*\{[^}]*\bdb\b[^}]*\}\s*from\s*['"]\.\/firebase\.js['"]/.test(src));
    ok(f + " binds _db to the canonical instance",
       /const\s+_db\s*=\s*_canonicalDb\s*;/.test(src));
  });

  head('C · the canonical app is the one carrying App Check');
  const fb = read('firebase.js');
  ok('firebase.js initialises the DEFAULT app (no name argument)',
     /initializeApp\(firebaseConfig\)/.test(fb));
  ok('firebase.js attaches App Check to that app',
     /initializeAppCheck\(\s*app\s*,/.test(fb));
  ok('firebase.js exports db', /export\s*\{[\s\S]{0,200}\bdb\b/.test(fb));

  head('D · the failure is still reported, never swallowed');
  const biz = read('business.html');
  ok('business.html still surfaces a load failure to the user',
     /Could not load business/.test(biz),
     'the honest error path must remain — the fix is the app, not hiding the error');
  ok('...and still distinguishes a missing document from a failed read',
     /Business not found/.test(biz));
  ok('no blanket demo/fake business fallback was introduced',
     !/DEMO_BUSINESS|FAKE_BUSINESS|sampleBusiness/i.test(biz));

  head('E · App Check and rules were not weakened');
  ok('no App Check debug token was introduced',
     !/FIREBASE_APPCHECK_DEBUG_TOKEN/.test(biz + read('businesses.html')));
  ok('firebase.js still enforces auto-refresh on App Check',
     /isTokenAutoRefreshEnabled:\s*true/.test(fb));

  console.log('\n' + '─'.repeat(64));
  if (fail) { console.log('\x1b[31mFAILURES\x1b[0m'); failures.forEach((f) => console.log('  ✗ ' + f)); }
  console.log((fail ? '\x1b[31m' : '\x1b[32m') + 'public business firebase: ' + pass + '/' + (pass + fail) + '\x1b[0m\n');
  process.exit(fail ? 1 : 0);
})();
