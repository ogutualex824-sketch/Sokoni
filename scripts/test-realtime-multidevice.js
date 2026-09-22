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

/* ── P17 REGRESSION GUARD: CSS SPECIFICITY ───────────────────────────────
   The stylesheet declares `#sk-notif-btn{position:relative}` (ID, 1-0-0). A
   bare `.sk-notif-float` rule (0-1-0) can never override it, so the floating
   bell computed `position:relative` and scrolled away — measured in real
   Chromium as browser-proof P17.

   Every float declaration must therefore be ID-qualified. These are STATIC
   guards; the runtime confirmation is P17/P17b in the browser proof. */
const floatRules = (center.match(/'[^']*sk-notif-float[^']*\{/g) || []);
ok('B7', floatRules.length > 0 && floatRules.every((r) => r.indexOf('#sk-notif-btn') !== -1),
   'every .sk-notif-float rule is ID-qualified so it can outrank #sk-notif-btn' +
   (floatRules.length ? '' : ' — NO float rules found, guard would be vacuous'));

ok('B8', /#sk-notif-btn\.sk-notif-float\{position:fixed/.test(center),
   'the floating bell is declared position:fixed on an ID-qualified selector');

/* The ID rule must SURVIVE — hand-written bells still depend on it. The fix
   must not have been achieved by deleting the thing it conflicts with. */
ok('B9', /'#sk-notif-btn\{',\s*'position:relative;'/.test(center),
   'the original #sk-notif-btn{position:relative} rule is left intact');

/* No !important, per the authorised repair.
   Asserted on STRIPPED source: the comment above this rule discusses
   `!important` by name, and matching the raw file made this check fail against
   its own prose — the certification-reads-itself defect. */
ok('B10', !/!important/.test(centerS),
   'the repair states the cascade correctly rather than using !important');
ok('B10c', /!important/.test(center) && !/!important/.test(centerS),
   'CONTROL: the stripper is what makes B10 meaningful — the token exists in a ' +
   'comment and is correctly excluded from the code check');

/* Coverage: every page that should show a bell must load at least one
   injector. Diagnostics and unattended terminals are exempt BY NAME, so the
   exemption is auditable rather than implicit. */
const EXEMPT = new Set([
  '_sign-harness', 'android-doctor', 'catalogue-doctor', 'diagnostics',
  'email-preview', 'route-debug', 'sfos-monitor', 'validation',
  'pos-ios-print-test', 'pos-printer-hardware-test', 'pos-hardware-setup',
  'customer-display', 'pos-display', 'kitchen-display', 'print-station',
  'pos-kiosk', 'pay-q', 'login', 'signup', 'register', 'offline', 'success',
  'checkout-2-preview', 'realtime-harness',
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

/* ── G. DEVICE IDENTITY, HARDENED ────────────────────────────────────────
   A fresh module instance per case, each with its own mock storage, so one
   case cannot contaminate the next. */
function loadBus (storage) {
  const sandbox = {
    navigator: { onLine: true }, localStorage: storage,
    addEventListener: () => {}, BroadcastChannel: null,
    console: { warn: () => {} },
  };
  sandbox.window = sandbox;
  // eslint-disable-next-line no-new-func
  new Function('window', bus)(sandbox);
  return sandbox.SokoniDeviceBus;
}
function mockStore (initial) {
  const m = Object.assign(Object.create(null), initial || {});
  return { getItem: (k) => (k in m ? m[k] : null),
           setItem: (k, v) => { m[k] = String(v); },
           removeItem: (k) => { delete m[k]; }, _raw: m };
}

(function deviceIdentity () {
  const s1 = mockStore();
  const b1 = loadBus(s1);
  const id1 = b1.deviceId();
  ok('G1', id1 === b1.deviceId() && id1 === b1.deviceId(),
     'repeated deviceId() calls return the SAME id');
  ok('G2', /^dev_/.test(id1) && s1._raw.sk_device_id === id1,
     'device id is persisted under sk_device_id');

  /* Same storage = same browser profile = same device, across navigations
     and across tabs (localStorage is shared by both). */
  const b2 = loadBus(s1);
  ok('G3', b2.deviceId() === id1,
     'a NEW page load on the same storage reuses the device id (navigation + tabs)');

  /* A different browser/device has different storage. */
  const b3 = loadBus(mockStore());
  ok('G4', b3.deviceId() !== id1, 'a different device gets a DIFFERENT identity');

  /* Corruption must not become a permanent identity. */
  ['', 'undefined', '[object Object]', '{"a":1}', 'dev_', 'xx'].forEach((bad, i) => {
    const sb = mockStore({ sk_device_id: bad });
    const bb = loadBus(sb);
    const got = bb.deviceId();
    ok('G5.' + (i + 1), /^dev_[a-z0-9]{4,}_[a-z0-9]{4,}$/.test(got) && got !== bad,
       'malformed stored id ' + JSON.stringify(bad) + ' is replaced, not adopted');
  });

  /* Storage unavailable: still stable for the load (the defect fixed earlier). */
  const thrower = { getItem: () => { throw new Error('blocked'); },
                    setItem: () => { throw new Error('blocked'); },
                    removeItem: () => {} };
  const b4 = loadBus(thrower);
  ok('G6', b4.deviceId() === b4.deviceId() && /^dev_/.test(b4.deviceId()),
     'storage unavailable: deviceId is still STABLE within the load');

  /* Session is per-load even when the device is not. */
  ok('G7', loadBus(s1).sessionId() !== loadBus(s1).sessionId(),
     'two loads on one device get DIFFERENT session ids');

  /* Survives logout: firebase.js must keep sk_device_id off the wipe. */
  const fb = R('firebase.js');
  ok('G8', /_SOKONI_LS_KEEP\s*=\s*\/[^/]*sk_device_id/.test(fb),
     'sk_device_id is on the sign-out KEEP list (identity survives logout/login)');
  ok('G9', !/_SOKONI_LS_KEEP\s*=\s*\/[^/]*sk_notif_seen/.test(fb),
     'CONTROL: user-specific notification state is NOT kept across sign-out');
})();

/* ── H. EVENT IDENTITY AND ONE-NOTIFICATION-PER-EVENT ────────────────────── */
(function eventIdentity () {
  const b = loadBus(mockStore());

  const evt = { type: 'order.status', entity: 'ORD-1', status: 'paid' };
  let shown = 0;
  ['snapshot', 'push', 'sw', 'app'].forEach(() => {
    b.notifyOnce(evt, () => { shown++; });
  });
  ok('H1', shown === 1,
     'ONE notification when the same event arrives via snapshot + push + sw + app');

  /* Different transition, same entity: must NOT be swallowed. */
  let shown2 = 0;
  b.notifyOnce({ type: 'order.status', entity: 'ORD-1', status: 'delivered' },
               () => { shown2++; });
  ok('H2', shown2 === 1,
     'a DIFFERENT transition on the SAME order still notifies (not over-deduped)');

  /* Different entity, same transition. */
  let shown3 = 0;
  b.notifyOnce({ type: 'order.status', entity: 'ORD-2', status: 'paid' },
               () => { shown3++; });
  ok('H3', shown3 === 1, 'a different order notifies independently');

  /* Refuse a key that can only fire once per entity. */
  let threw = false;
  try { b.eventKey({ type: 'order.status', entity: 'ORD-9' }); }
  catch (e) { threw = /discriminator/.test(String(e.message)); }
  ok('H4', threw, 'eventKey REFUSES an entity-only key that would suppress later events');

  ok('H5', b.eventKey({ type: 't', entity: 'e', at: 1 }) ===
           b.eventKey({ type: 't', entity: 'e', at: 1 }),
     'eventKey is deterministic for the same transition');
})();

/* ── I. PUSH FAN-OUT CHAIN (client half — hosting-safe) ──────────────────── */
(function pushChain () {
  const fb = R('firebase.js');
  const notify = R('functions/notify.js');
  ok('I1', /fcmTokens:\s*arrayUnion\(token\)/.test(fb),
     'client ACCUMULATES tokens (fcmTokens arrayUnion) — every device reachable');
  ok('I2', /fcmToken:\s*token/.test(fb),
     'the legacy scalar is still written so old readers keep working');
  ok('I3', /Array\.isArray\(u\.fcmTokens\)/.test(notify),
     'notify.js already reads the array — no Functions change needed');
  ok('I4', /sendEachForMulticast/.test(notify),
     'notify.js already multicasts to every token');
  ok('I5', /arrayRemove\(\.\.\.dead\)/.test(notify),
     'notify.js already prunes dead tokens (bounds array growth)');
  ok('I6', /arrayRemove\(_tok\)/.test(fb) && fb.indexOf('arrayRemove(_tok)') < fb.indexOf('await signOut(auth)'),
     'sign-out deregisters THIS device BEFORE signOut (while the write is still permitted)');
})();

/* ── J. NO DOUBLE BOOT ───────────────────────────────────────────────────── */
ok('J1', /if \(w\.SokoniDeviceBus\) return;/.test(busS),
   'device bus init is idempotent — a second load is a no-op');
ok('J2', !/location\.reload|location\.href\s*=|location\.replace/.test(busS),
   'device bus never navigates or reloads (cannot cause a boot cycle)');
ok('J3', !/location\.reload|location\.replace/.test(strip(R('sokoni-notif-center.js'))),
   'notif-center never reloads the page');

/* ── K. LISTENER LEDGER ──────────────────────────────────────────────────── */
(function ledger () {
  const b = loadBus(mockStore());
  b.subscribe({ key: 'o1', collection: 'orders', scopedBy: 'sellerUid',
                owner: 'test', scope: 'page', cardinality: '<=50',
                attach: () => () => {} });
  const inv = b.inventory();
  ok('K1', inv.length === 1 && inv[0].collection === 'orders' &&
           inv[0].scopedBy === 'sellerUid' && inv[0].cardinality === '<=50',
     'every listener records collection, scope, owner, cardinality and lifecycle');
  b.release('page');
  ok('K2', b.inventory().length === 0, 'release(scope) tears the listener down');
})();

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
