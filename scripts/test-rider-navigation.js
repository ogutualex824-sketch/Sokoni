#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   RIDER MAP / NAVIGATION — the destination must belong to THAT order
   ---------------------------------------------------------------------------
     node scripts/test-rider-navigation.js

   "The map opened" is not the property. The property is that it opened at the
   destination for THIS accepted order, that changing orders changes the destination,
   and that a rider cannot ask for a destination that is not theirs.

   WHY THIS IS A SOURCE-LEVEL SUITE
   The two decisive invariants — per-order destination binding and no client-supplied
   destination — are properties of the CODE PATH, and a browser test would prove them
   only for whatever fixture it happened to render. Geolocation, tile loading and marker
   placement genuinely cannot be simulated faithfully headless; those are listed at the
   end as real-device checks rather than asserted here on false evidence.
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 95) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n── ' + t + ' ──');

const driver = read('driver.html');
const riderNav = read('rider-nav.html');
const navFns = read('functions/navigation.js');

/* Comments describe the code; they are not the code. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
const dCode = strip(driver);
const nCode = strip(riderNav);

console.log('\nRIDER MAP / NAVIGATION — destination binding and authorization\n');

head('1 · the accepted-delivery card offers navigation');
ck('active delivery card renders a Navigate control',
   /onclick="window\._drvNavigate\(/.test(dCode), 'window._drvNavigate handler');
ck('the control is rendered inside the ACTIVE delivery branch (not always)',
   /activeStatus\[req\.status\]/.test(dCode));
ck('_drvNavigate is defined', /window\._drvNavigate\s*=\s*function/.test(dCode));

head('2 · the destination comes from THAT order');
/* Seller until picked up, buyer once in transit — read off the request object per card,
   never from a module-level variable that the previous card could have left behind. */
ck('destination is read from the per-order request object',
   /req\.deliveryCoords/.test(dCode) && /req\.pickupCoords/.test(dCode),
   'req.deliveryCoords / req.pickupCoords');
ck('stage decides seller vs buyer destination',
   /req\.status === 'in_transit'[\s\S]{0,160}deliveryAddress/.test(dCode) ||
   /in_transit[\s\S]{0,200}_dc\.lat/.test(dCode));
ck('the destination is passed as an ARGUMENT, not read from shared state',
   /_drvNavigate\('\$\{_navDest\}'\)/.test(dCode) || /_drvNavigate\(\s*encodedDest/.test(dCode));
/* A destination held in a module-scope variable is exactly how delivery A's marker
   survives onto delivery B. */
ck('no module-scope destination variable is reused across cards',
   !/^\s*(let|var)\s+_?(currentDest|activeDest|lastDest)\b/m.test(dCode));

head('3 · missing or invalid coordinates must not fabricate a location');
ck('empty destination is refused rather than navigated',
   /if \(!encodedDest\)[\s\S]{0,120}return/.test(dCode));
ck('the refusal tells the rider why', /No destination location yet/.test(driver));
ck('no 0,0 fallback anywhere in the navigate path',
   !/destination=0,0|lat:\s*0\s*,\s*lng:\s*0/.test(dCode));
/* Falling back to the saved ADDRESS is legitimate — the maps provider geocodes it — and
   is not a fabricated coordinate. */
ck('address fallback is used instead of inventing coordinates',
   /deliveryAddress \|\| ''/.test(dCode) || /pickupAddress \|\| ''/.test(dCode));

head('4 · SECURITY — the rider cannot supply their own destination');
ck('rider-nav.html reads NO destination from the URL',
   !/URLSearchParams|location\.search/.test(nCode),
   'no query-string parsing');
ck('rider-nav.html asks the server with an EMPTY payload',
   /_cf\('navGetActiveTrip'\)\(\{\}\)/.test(nCode), "navGetActiveTrip({})");
ck('the server resolves the trip from the AUTHENTICATED uid',
   /navGetActiveTrip[\s\S]{0,320}request\.auth\.uid[\s\S]{0,200}where\('riderId', '==', uid\)/.test(navFns));
ck('...and accepts no orderId/lat/lng from the caller',
   !/navGetActiveTrip[\s\S]{0,400}request\.data\.(orderId|lat|lng|destination)/.test(navFns));
ck('the endpoint enforces App Check', /navGetActiveTrip = onCall\(\{ enforceAppCheck: true \}/.test(navFns));
ck('completed/cancelled trips are excluded (no stale destination)',
   /status !== 'completed' && t\.status !== 'cancelled'/.test(navFns));

head('5 · switching orders changes the destination');
/* Each card computes _navDest in its own render scope from its own `req`, so the value
   cannot survive from a previous delivery. This is the structural guarantee behind
   "delivery A's marker must not remain on delivery B". */
const navDestDecls = (dCode.match(/const _navDest\s*=/g) || []).length;
ck('_navDest is declared per render, with const (no cross-card leakage)',
   navDestDecls >= 1 && !/^\s*var\s+_navDest/m.test(dCode), navDestDecls + ' declaration(s)');
ck('_navRaw is derived per card from that card\'s req', /const _navRaw\s*=/.test(dCode));

head('6 · the shell is not disturbed');
/* Adding rider navigation must not reintroduce the double-shell: driver.html and
   rider-nav.html are standalone rider surfaces, not merchant-embedded modules. */
ck('rider-nav.html does not mount the merchant shell', !/mshell|sokoni-merchant-routes/.test(nCode));
ck('driver.html does not mount the merchant shell', !/mshell|sokoni-merchant-routes/.test(dCode));
ck('rider-nav.html declares a mobile viewport',
   /name="viewport"[^>]*width=device-width/.test(riderNav));
ck('the navigate control does not open a second app window for in-app nav',
   !/window\.open\([^)]*rider-nav/.test(dCode));

head('7 · every navigation entry point resolves to a real page');
const targets = [...driver.matchAll(/location\.href='([a-z0-9\-]+\.html)'/g)].map((m) => m[1]);
const missing = [...new Set(targets)].filter((t) => !fs.existsSync(path.join(ROOT, t)));
ck('no rider navigation button targets a missing page', missing.length === 0, missing.join(', ') || 'none');

console.log('\n' + '─'.repeat(70));
console.log('  REAL-DEVICE CHECKS (cannot be faithfully simulated headless — do NOT');
console.log('  report these as automated passes):');
console.log('    · map tiles render and the destination marker sits on the buyer address');
console.log('    · rider current-location dot is accurate with permission GRANTED');
console.log('    · permission DENIED shows a usable fallback, not a crash or a fake position');
console.log('    · switching between two accepted deliveries moves the marker');
console.log('    · refresh preserves the destination of the delivery in progress');
console.log('    · duplicate taps do not open two navigation sessions');
console.log('  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
