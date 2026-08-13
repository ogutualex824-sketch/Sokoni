#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   MAP / GPS ENGINE RATCHET — stop the proliferation, do not reverse it yet
   ---------------------------------------------------------------------------
     node scripts/test-map-engine-ratchet.js

   A proposal for a canonical `sokoni-map.js` prompted a survey which found TEN geo
   modules already present — including two different files both calling themselves
   "SOKONI Navigation Engine v2.0" — plus fifteen HTML pages constructing their own
   Leaflet map or calling getCurrentPosition directly.

   The disease is proliferation, not absence, so an eleventh canonical engine would make
   it worse. See ADR-0017. This suite therefore does exactly one thing: it fixes the
   count. New independent map/GPS code fails; the existing fifteen are baselined and are
   NOT reduced here, because that is a refactor and this is an armed release candidate.

   The list can only shrink: converting a page must also remove its name, and a stale
   entry fails — so the baseline cannot rot into fiction the way a comment would.
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 110) + ']' : ''));
  if (ok) pass++; else { fail++; failures.push(l + (d ? ' — ' + d : '')); }
};

/* The primitives that mean "this page owns map or location logic itself". Constructing a
   map or reading the device position directly is the thing being counted; merely holding
   a coordinate is not. */
const OWNS_MAP_OR_GPS = /L\.map\s*\(|new\s+google\.maps\.Map|navigator\.geolocation\.(getCurrentPosition|watchPosition)/;

/* Comments are not code. A page that DESCRIBES getCurrentPosition while calling the
   canonical engine must not be counted — the same trap the App Check ratchet hit. */
function stripNonCode(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
            .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/* Pages that held their own map/GPS code when ADR-0017 was accepted. Baselined, not
   blessed: each is a convergence candidate once the canonical owner is chosen. */
const BASELINE = [
  'car-hub.html',
  'checkout.html',
  'delivery-tracking.html',
  'delivery.html',
  'dispatch.html',
  'driver.html',
  'fleet-monitor.html',
  'food-order.html',
  'food-rider.html',
  'gip.html',
  'index.html',
  'onboarding-driver.html',
  'search.html',
  'seller-delivery.html',
  'track.html',
];

/* The engines that already exist. A new file matching this shape is engine #11 and is
   exactly what ADR-0017 forbids. */
const KNOWN_ENGINES = [
  'sokoni-geo.js', 'sokoni-map-manager.js', 'sokoni-nav-engine.js', 'sokoni-navigation.js',
  'sokoni-gip.js', 'sokoni-gip-api.js', 'sokoni-gip-router.js', 'sokoni-gip-dispatch.js',
  'sokoni-gip-fleet.js', 'sokoni-gip-analytics.js',
  /* ELEVEN, not ten. The hand survey behind ADR-0017 globbed the map, geo, nav and gip
     prefixes and missed this one entirely — which is the argument for the ratchet in one
     line: a count maintained by memory drifts, a count maintained by a test does not. */
  'sokoni-gps-manager.js',
];

console.log('\nMAP / GPS ENGINE RATCHET — ADR-0017\n');

/* ── 1. no page outside the baseline owns map/GPS code ───────────────────── */
const pages = fs.readdirSync(ROOT).filter((f) => /\.html$/.test(f)).sort();
const owning = pages.filter((f) => {
  try { return OWNS_MAP_OR_GPS.test(stripNonCode(fs.readFileSync(path.join(ROOT, f), 'utf8'))); }
  catch (_) { return false; }
});

const added = owning.filter((f) => !BASELINE.includes(f));
ck('no NEW page implements its own map or GPS', added.length === 0,
   added.join(', ') || 'none');

/* ── 2. the baseline describes reality ──────────────────────────────────────
   A converted page must also leave this list. Without this the baseline would keep
   permitting map code in a file that no longer has any — a permanent silent allowance. */
const stale = BASELINE.filter((f) => !owning.includes(f));
ck('no BASELINE entry is stale (converted pages must be removed from the list)',
   stale.length === 0, stale.join(', ') || 'none');

/* ── 3. the count may never rise ────────────────────────────────────────────── */
ck('independent map/GPS implementations did not increase',
   owning.length <= BASELINE.length, owning.length + ' vs baseline ' + BASELINE.length);

/* ── 4. no eleventh engine ───────────────────────────────────────────────────
   Including the specific name the ADR rejects, so the decision is enforced and not
   merely written down. */
ck('sokoni-map.js was NOT created (ADR-0017 rejects an 11th engine)',
   !fs.existsSync(path.join(ROOT, 'sokoni-map.js')));

const rootJs = fs.readdirSync(ROOT).filter((f) => /\.js$/.test(f));
const newEngines = rootJs.filter((f) => {
  if (KNOWN_ENGINES.includes(f)) return false;
  if (!/^sokoni-(map|geo|nav|route|gps|location)/.test(f)) return false;
  try { return OWNS_MAP_OR_GPS.test(stripNonCode(fs.readFileSync(path.join(ROOT, f), 'utf8'))); }
  catch (_) { return false; }
});
ck('no new geo/map/navigation engine module appeared', newEngines.length === 0,
   newEngines.join(', ') || 'none');

/* ── 5. the money-path boundary the ADR exists to protect ────────────────────
   Rule 7: the map informs, it never authorizes. A geofence or arrival check must never
   be what causes `delivered` — that is the shape of the defect just fixed in the PIN
   path, wearing a different coat. */
const geoSources = KNOWN_ENGINES
  .filter((f) => fs.existsSync(path.join(ROOT, f)))
  .map((f) => ({ f, src: stripNonCode(fs.readFileSync(path.join(ROOT, f), 'utf8')) }));

/* Scoped to the ACTUAL money path: `delivered` on an ORDER, or any wallet write. The
   payout fires from onOrderStatusChange watching orders/{id}.status, so that document and
   the wallet are the boundary. A first, broader version of this check flagged
   sokoni-gip-dispatch.js for writing `delivered` on gipDispatch/{jobId} — a parallel
   dispatch collection that does not feed onOrderStatusChange, so it authorises no payout.
   Reporting that as a money-path breach would have been an overstatement, and a check that
   cries wolf gets waived. */
const touchesOrders = geoSources.filter(({ src }) =>
  /doc\(\s*db\s*,\s*['"]orders['"]/.test(src) || /collection\(\s*['"]orders['"]/.test(src));
const touchesWallet = geoSources.filter(({ src }) =>
  /walletTransactions|collection\(\s*['"]wallets['"]/.test(src));
const callsAuth = geoSources.filter(({ src }) => /completeDeliveryWithPin|buyerConfirmDelivery/.test(src));

ck('no geo module writes an ORDER status', touchesOrders.length === 0,
   touchesOrders.map((a) => a.f).join(', ') || 'none');
ck('no geo module touches a wallet', touchesWallet.length === 0,
   touchesWallet.map((a) => a.f).join(', ') || 'none');
ck('no geo module invokes the delivery-authorization callables', callsAuth.length === 0,
   callsAuth.map((a) => a.f).join(', ') || 'none');

/* KNOWN, and deliberately not a failure: gipDispatch.markDelivered() sets otpVerified from
   a CLIENT-SUPPLIED argument (`otp !== null`) — the same client-asserted-proof shape as the
   delivery PIN defect, on a parallel collection. It pays nobody today. Printed every run so
   the convergence cannot quietly inherit it. */
const gipOtp = geoSources.find(({ f, src }) =>
  f === 'sokoni-gip-dispatch.js' && /otpVerified\s*=\s*true/.test(src));
if (gipOtp) {
  console.log('  NOTE  sokoni-gip-dispatch.markDelivered sets otpVerified from a client');
  console.log('        argument on gipDispatch/{jobId}. No payout path today — REVIEW during');
  console.log('        convergence before that collection is ever wired to orders.');
}

console.log('\n' + '─'.repeat(70));
console.log('  OUTSTANDING: ' + BASELINE.length + ' pages still own map/GPS code.');
console.log('  Not reduced here by design — convergence is post-release (ADR-0017), and the');
console.log('  canonical owner is chosen by evaluation, not because a module says "central".');
if (fail) { console.log('\nFAILURES'); failures.forEach((f) => console.log('  x ' + f)); }
console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
