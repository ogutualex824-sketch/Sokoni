/* Regression test for sokoni-sync.js — THE invariant:
   window.SokoniSync is SHARED INFRASTRUCTURE injected on every page by
   security.js. It carries TWO contracts on ONE object and BOTH must survive:

     1. the cross-device sync ENGINE  — init / pull / pushAll / clear
        (firebase.js calls .clear() on logout and .init()/.pull() on login;
         dropping these threw "SokoniSync.clear is not a function" platform-wide).
     2. the merchant domain-event FACADE — emit / on / onAny + *Changed emitters.

   A new feature needing a similar facade must EXTEND/COMPOSE this module, never
   replace it. This test fails loudly if either contract is dropped — the exact
   regression that shipped at v457 and was fixed in f672482.

   Runs the real module under mocked browser globals (mirrors test-auth-state.js). */
'use strict';
const path = require('path');
const fs = require('fs');

/* ── mock the browser globals the module touches at load ── */
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
global.Event = function (type) { this.type = type; };
global.CustomEvent = function (type, opts) { this.type = type; this.detail = opts && opts.detail; };
/* Minimal but REAL event system so the bus-less DOM-fallback delivery path is
   genuinely exercised (SokoniEventBus is absent in this node harness). */
const _listeners = {};
global.window = {
  localStorage: global.localStorage,
  addEventListener: (t, fn) => { (_listeners[t] = _listeners[t] || []).push(fn); },
  removeEventListener: (t, fn) => { _listeners[t] = (_listeners[t] || []).filter((f) => f !== fn); },
  dispatchEvent: (ev) => { (_listeners[ev.type] || []).slice().forEach((f) => f(ev)); return true; },
};

require(path.join(__dirname, '..', 'sokoni-sync.js'));
const S = global.window.SokoniSync;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m); } };

/* ── Contract 1: the cross-device sync ENGINE must be intact ── */
ok(S && typeof S === 'object', 'window.SokoniSync exposed');
['init', 'pull', 'pushAll', 'clear'].forEach((k) =>
  ok(typeof S[k] === 'function', 'engine method present: SokoniSync.' + k + '()'));

/* ── Contract 2: the merchant domain-event FACADE must be present ── */
['emit', 'on', 'onAny'].forEach((k) =>
  ok(typeof S[k] === 'function', 'facade method present: SokoniSync.' + k + '()'));
['productChanged', 'stockChanged', 'availabilityChanged', 'shopChanged',
 'orderChanged', 'paymentChanged', 'refundChanged', 'customerChanged'].forEach((k) =>
  ok(typeof S[k] === 'function', 'facade emitter present: SokoniSync.' + k + '()'));
ok(S.EVENTS && Object.keys(S.EVENTS).length === 8, 'SokoniSync.EVENTS lists the 8 domain events');

/* ── The module must still BE the engine, not a replacement of it ── */
const src = fs.readFileSync(path.join(__dirname, '..', 'sokoni-sync.js'), 'utf8');
ok(/SOKONI SYNC ENGINE/.test(src), 'file still contains the cross-device SYNC ENGINE (not overwritten)');
ok(/localStorage\.setItem\s*=\s*function/.test(src), 'engine still patches localStorage.setItem (its core mechanism)');
ok(/dispatchEvent\(new Event\('sokoniSyncLoaded'\)\)/.test(src), 'engine still fires sokoniSyncLoaded (firebase.js handshake)');

/* ── Tie the test to the REAL dependency: firebase.js must find the methods it calls ── */
const fb = fs.readFileSync(path.join(__dirname, '..', 'firebase.js'), 'utf8');
const calls = (fb.match(/SokoniSync\.(init|pull|pushAll|clear)\b/g) || [])
  .map((c) => c.split('.')[1]);
[...new Set(calls)].forEach((m) =>
  ok(typeof S[m] === 'function', 'firebase.js calls SokoniSync.' + m + '() — and it exists'));

/* ── emit/on actually deliver (facade wiring sane even without the bus) ── */
let got = null;
const off = S.on('AvailabilityChanged', (p) => { got = p && p.shopOpen; });
S.availabilityChanged({ shopOpen: true });
ok(got === true, 'facade delivers a domain event to a subscriber');
off();

console.log(fail === 0 ? ('\nALL ' + pass + ' PASSED') : ('\n' + pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
