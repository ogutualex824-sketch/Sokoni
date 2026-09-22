#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════
   REALTIME / MULTI-DEVICE — static certification
   scripts/test-realtime-multidevice.js

   Asserts the wiring that makes SOKONI converge across devices. Static: it
   reads source, starts no browser and contacts nothing.

   WHAT A STATIC SUITE CAN AND CANNOT SAY
   A source assertion proves a module is WIRED. It does not prove two phones
   actually converge — that needs the live matrix in
   docs/REALTIME_MULTIDEVICE.md, which is listed there as NOT YET RUN rather
   than quietly implied by a green run here. Every check below is a wiring
   claim, and the summary says so.

   Run:  node scripts/test-realtime-multidevice.js
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const R = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let pass = 0, fail = 0;
const results = [];
function ok (id, cond, msg) {
  if (cond) { pass++; results.push('  PASS  ' + id + '  ' + msg); }
  else      { fail++; results.push('  FAIL  ' + id + '  ' + msg); }
}

const security   = R('security.js');
const securityS  = strip(security);
const header     = R('shared-header.js');
const center     = R('sokoni-notif-center.js');
const centerS    = strip(center);
const bus        = R('sokoni-device-bus.js');
const busS       = strip(bus);

/* The stripper must not be a no-op — otherwise a check could match its own
   explanatory comment and pass for the wrong reason. */
ok('C0', securityS.length < security.length && centerS.length < center.length,
   'comment stripper is not a no-op (a check could otherwise match its own prose)');

/* ── A. ONE SYSTEM, NOT SIX ──────────────────────────────────────────────── */

/* THE COLLISION THIS SUITE EXISTS FOR.
   security.js guards realtime.js with `script[src*="realtime"]`, a SUBSTRING
   test. Any file whose name contains "realtime" satisfies that guard and
   silently suppresses realtime.js — taking the live product grid, hub and
   order-status listeners down with it, with no error anywhere. This was
   nearly shipped as `sokoni-realtime.js`. */
const realtimeGuard = /script\[src\*="realtime"\]/.test(securityS);
ok('A1', realtimeGuard, 'security.js still guards realtime.js on a substring match');
const injectedNames = (securityS.match(/base \+ '([a-z0-9-]+\.js)'/g) || [])
  .map((m) => m.replace(/.*'([^']+)'.*/, '$1'));
const collide = injectedNames.filter((n) => n !== 'realtime.js' && /realtime/.test(n));
ok('A2', collide.length === 0,
   'no injected module name contains "realtime" besides realtime.js itself' +
   (collide.length ? ' — COLLIDES: ' + collide.join(', ') : ''));

/* Positive control for A2: prove the detector CAN see a colliding name. An
   empty result must not be indistinguishable from a detector that cannot
   match. */
ok('A2c', ['sokoni-realtime.js', 'realtime.js', 'x.js']
      .filter((n) => n !== 'realtime.js' && /realtime/.test(n)).length === 1,
   'CONTROL: the collision detector does match a colliding name when one exists');

ok('A3', /SokoniDeviceBus/.test(busS) && !/window\.SokoniRealtime\s*=/.test(busS),
   'device bus exposes SokoniDeviceBus and does not squat the Realtime name');

/* Exactly one engine and one centre per page: both injectors must use the
   SAME element ids, so whichever runs first makes the other a no-op. */
['sk-notif-engine-script', 'sk-notif-center-script'].forEach((id, i) => {
  ok('A4.' + (i + 1),
     header.indexOf(id) !== -1 && security.indexOf(id) !== -1,
     'both injectors share the id "' + id + '" so neither can double-load');
});

/* ── B. BELL COVERAGE IS A PLATFORM PROPERTY ─────────────────────────────── */

ok('B1', /_mountFallbackBell/.test(centerS),
   'notif-center self-mounts a bell when a page provides none');
ok('B2', /_NO_BELL/.test(centerS) && /pos-kiosk/.test(centerS) &&
         /customer-display/.test(centerS),
   'customer-facing/unattended surfaces are denied a merchant bell');
ok('B3', /getElementById\('sk-notif-btn'\)/.test(centerS),
   'a hand-written #sk-notif-btn still wins over the fallback');
ok('B4', /setTimeout\(/.test(centerS.slice(centerS.indexOf('_tryAutoAttach'))),
   'fallback waits for shared-header nav before mounting (no double bell)');
ok('B5', /safe-area-inset-top/.test(center),
   'floating bell respects the phone safe area (notch/home bar)');

/* Coverage: every page that should show a bell must load at least one
   injector. Diagnostics and unattended terminals are exempt BY NAME, so the
   exemption is auditable rather than implicit. */
const EXEMPT = new Set([
  '_sign-harness', 'android-doctor', 'catalogue-doctor', 'diagnostics',
  'email-preview', 'route-debug', 'sfos-monitor', 'validation',
  'pos-ios-print-test', 'pos-printer-hardware-test', 'pos-hardware-setup',
  'customer-display', 'pos-display', 'kitchen-display', 'print-station',
  'pos-kiosk', 'pay-q', 'login', 'signup', 'register', 'offline', 'success',
  'checkout-2-preview',
]);
const pages = fs.readdirSync(ROOT).filter((f) => /\.html$/.test(f));
/* FOREIGN, not exempt. These are another agent's UNTRACKED work-in-progress in
   a shared multi-agent worktree. They genuinely lack coverage, but editing
   them would cross an ownership boundary, so they are reported separately
   rather than folded into EXEMPT — an exemption would hide a real gap behind
   a green run. Re-check once they land. */
const FOREIGN = new Set(['business-apply', 'catalogue']);

const uncovered = pages.filter((f) => {
  const base = f.replace(/\.html$/, '');
  if (EXEMPT.has(base) || FOREIGN.has(base)) return false;
  const src = R(f);
  return !/security\.js/.test(src) && !/shared-header\.js/.test(src);
});
ok('B6', uncovered.length === 0,
   'every non-exempt page loads an injector' +
   (uncovered.length ? ' — UNCOVERED: ' + uncovered.join(', ') : ''));

const foreignGap = [...FOREIGN].filter((b) => {
  if (!fs.existsSync(path.join(ROOT, b + '.html'))) return false;
  const src = R(b + '.html');
  return !/security\.js/.test(src) && !/shared-header\.js/.test(src);
});
results.push('  NOTE  B6f  ' + foreignGap.length + ' FOREIGN page(s) still uncovered' +
  (foreignGap.length ? ' (' + foreignGap.join(', ') + ') — owned by another agent, ' +
   'not edited. Real gap, deliberately not hidden.' : ''));

/* ── C. SYNCHRONISATION IS NOT NOTIFICATION ──────────────────────────────── */

ok('C1', /AUTHORITATIVE STATE/.test(bus) && /NOTIFICATION/.test(bus),
   'device bus documents the three layers as distinct');
ok('C2', /onReconnect/.test(busS),
   'a reconnect hook exists so state reconciles from source, not from replay');

/* ── D. RELEVANCE IS NOT IDENTITY (security) ─────────────────────────────── */

ok('D1', /TENANT_SCOPED/.test(busS),
   'tenant-scoped collections are enumerated');
['orders', 'payments', 'notifications', 'messages', 'posSales'].forEach((c, i) => {
  ok('D2.' + (i + 1), new RegExp("'" + c + "'").test(busS.slice(busS.indexOf('TENANT_SCOPED'))),
     '"' + c + '" is treated as tenant-scoped');
});
ok('D3', /Refusing an unscoped subscription/.test(bus) && /throw new Error/.test(busS),
   'an unscoped subscription to a tenant collection is REFUSED, not silently widened');

/* Behavioural check, not just textual: actually run the refusal. */
(function behavioural () {
  const sandbox = { window: {}, navigator: { onLine: true }, localStorage: null,
                    addEventListener: () => {}, BroadcastChannel: null };
  sandbox.window = sandbox;
  let mod;
  try {
    // eslint-disable-next-line no-new-func
    new Function('window', bus)(sandbox);
    mod = sandbox.SokoniDeviceBus;
  } catch (e) { /* reported below */ }

  ok('D4', !!mod, 'device bus evaluates and exposes its API');
  if (!mod) return;

  let refused = false;
  try {
    mod.subscribe({ key: 'k', collection: 'orders', attach: () => () => {} });
  } catch (e) { refused = /tenant-scoped/.test(String(e.message)); }
  ok('D5', refused, 'RUNS: subscribe() throws on an unscoped tenant collection');

  /* Inverting control — the same call WITH a scope must be allowed. A guard
     that refuses everybody is not a guard. */
  let allowed = false;
  try {
    const off = mod.subscribe({ key: 'k2', collection: 'orders',
                                scopedBy: 'sellerUid', attach: () => () => {} });
    allowed = typeof off === 'function';
  } catch (e) { allowed = false; }
  ok('D6', allowed, 'CONTROL: a properly scoped subscription IS allowed');

  let rejectedBadAttach = false;
  try { mod.subscribe({ key: 'k3', attach: () => undefined }); }
  catch (e) { rejectedBadAttach = /unsubscribe function/.test(String(e.message)); }
  ok('D7', rejectedBadAttach, 'RUNS: a listener with no unsubscribe is rejected at wire-up');

  /* Dedupe: first claim wins, second is refused. */
  const id = 'evt_' + Math.random();
  ok('D8', mod.claim(id) === true && mod.claim(id) === false,
     'RUNS: claim() is true once and false thereafter (one event, one notification)');

  ok('D9', typeof mod.deviceId() === 'string' && mod.deviceId() === mod.deviceId(),
     'RUNS: deviceId is stable within a load');
  ok('D10', mod.sessionId() !== mod.deviceId(),
     'RUNS: session and device are distinct identities');
})();

/* ── E. DEDUPE SHARES ONE STORE ──────────────────────────────────────────── */

ok('E1', /sk_notif_seen/.test(busS) && /sk_notif_seen/.test(R('sokoni-notif-engine.js')),
   'bus and engine consult the SAME seen-store (a second store is a second opinion)');
ok('E2', /SokoniNotifEngine/.test(busS),
   'bus delegates to the engine when present rather than reimplementing dedupe');

/* ── F. PERFORMANCE ──────────────────────────────────────────────────────── */

ok('F1', /pagehide/.test(busS), 'all subscriptions are released on pagehide');
ok('F2', /refs\+\+|refs--/.test(busS.replace(/\s/g, '')),
   'duplicate subscriptions share one listener via refcounting');
ok('F3', /requestIdleCallback/.test(securityS),
   'notification modules are deferred to idle, not loaded on the critical path');

console.log('══════════════════════════════════════════════════════════════════');
console.log('  REALTIME / MULTI-DEVICE — static certification');
console.log('══════════════════════════════════════════════════════════════════');
results.forEach((r) => console.log(r));
console.log('');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('');
console.log('  SCOPE: these are WIRING claims read from source. They do NOT');
console.log('  establish that two devices converge in practice — that is the');
console.log('  live matrix in docs/REALTIME_MULTIDEVICE.md, still NOT RUN.');
console.log('══════════════════════════════════════════════════════════════════');
process.exit(fail === 0 ? 0 : 1);
