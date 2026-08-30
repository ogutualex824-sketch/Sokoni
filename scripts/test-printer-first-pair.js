#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   FIRST-TIME PAIRING — does the tap actually reach navigator.bluetooth.requestDevice?

   The reported defect was NOT a Bluetooth failure. window.PosPrintService.connect did
   not exist, so merchant-v2's

       if (!ok && eng.connect) ok = await eng.connect();

   skipped its own branch and reported "No printer connected." without ever asking for
   a chooser. Every assertion here exists to stop that returning.

   The load-bearing test is CHOOSER REACHED. A test that only checks "connect returns
   true" would pass against a stub that never touches Bluetooth at all.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0, invalid = 0;
const ok = (l, d) => { pass++; console.log('  PASS       ' + l + (d ? '   [' + d + ']' : '')); };
const no = (l, d) => { fail++; console.log('  FAIL       ' + l + (d ? '   [' + d + ']' : '')); };
const ck = (l, c, d) => (c ? ok(l, d) : no(l, d));
const iv = (l, d) => { invalid++; console.log('  HARNESS-INVALID  ' + l + (d ? '   [' + d + ']' : '')); };
const head = (t) => console.log('\n-- ' + t + ' --');

/* ── Load the hub inside a sandbox with a RECORDING navigator ──────────────── */
function loadHub () {
  const calls = { requestDevice: 0, args: null };
  const fakeDevice = { id: 'dev-1', name: 'P58E-Test', gatt: { connect: async () => ({}) } };
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON,
    /* Minimal DOM: the hub touches document/events at load. Enough to let it
       initialise, and nothing more — this suite tests pairing, not rendering. */
    document: {
      addEventListener: () => {}, removeEventListener: () => {},
      createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      body: { appendChild: () => {} }, hidden: false,
    },
    CustomEvent: function (t, o) { this.type = t; this.detail = (o || {}).detail; },
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => true,
    location: { origin: 'https://mysokoni.co.ke', href: 'https://mysokoni.co.ke/merchant-v2' },
    /* The hub attaches connect/disconnect listeners to each transport, so every
       mocked transport needs addEventListener or loading throws before any test runs. */
    navigator: {
      bluetooth: {
        requestDevice: async (opts) => { calls.requestDevice++; calls.args = opts; return fakeDevice; },
        getDevices: async () => [],
        addEventListener: () => {}, removeEventListener: () => {},
      },
      usb: {
        getDevices: async () => [], requestDevice: async () => { throw new Error('no usb'); },
        addEventListener: () => {}, removeEventListener: () => {},
      },
      serial: {
        getPorts: async () => [], requestPort: async () => { throw new Error('no serial'); },
        addEventListener: () => {}, removeEventListener: () => {},
      },
    },
    localStorage: (function () {
      const m = new Map();
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
      };
    })(),
    window: null,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(ROOT, 'sokoni-device-hub.js'), 'utf8');
  try { vm.runInContext(src, sandbox, { filename: 'sokoni-device-hub.js' }); }
  catch (e) { return { err: e, calls }; }
  return { hub: sandbox.SokoniDeviceHub, calls, sandbox, fakeDevice };
}

(async function () {
  head('0 - harness integrity');
  const L = loadHub();
  if (L.err) { iv('device hub loads in the sandbox', L.err.message); }
  else ok('device hub loads in the sandbox');
  if (!L.hub) {
    iv('SokoniDeviceHub is exported', 'cannot continue without the hub');
    console.log('\n' + '-'.repeat(62));
    console.log('  PASS ' + pass + '   FAIL ' + fail + '   HARNESS-INVALID ' + invalid);
    process.exit(1);
  }
  ok('SokoniDeviceHub is exported');
  ck('CONTROL no chooser has been opened merely by loading', L.calls.requestDevice === 0,
     'a page load must never ambush the merchant with a Bluetooth prompt');

  head('1 - THE DEFECT: the chooser must actually be reached');
  let profile = null;
  try { profile = await L.hub.requestDevice('bluetooth', 'printer'); }
  catch (e) { no('hub.requestDevice(bluetooth, printer) runs', e.message); }
  ck('CHOOSER REACHED - navigator.bluetooth.requestDevice was called',
     L.calls.requestDevice === 1, 'calls=' + L.calls.requestDevice);
  ck('...exactly once (one gesture, one chooser)', L.calls.requestDevice === 1);

  head('2 - the chooser must LIST a P58E');
  const args = L.calls.args || {};
  ck('printers are NOT filtered by advertised service', !args.filters || args.filters.length === 0,
     'a filtered request shows an EMPTY chooser for clones that advertise nothing');
  ck('...so acceptAllDevices is set', args.acceptAllDevices === true);
  const opt = (args.optionalServices || []).map(String);
  ck('optionalServices includes the P58E service', opt.indexOf('0000ff00-0000-1000-8000-00805f9b34fb') > -1,
     'without it getPrimaryService() fails AFTER the user already picked');
  ck('...and the generic ESC/POS-over-BLE service', opt.indexOf('000018f0-0000-1000-8000-00805f9b34fb') > -1);

  head('3 - a device paired AS a printer must be REGISTERED as one');
  ck('profile returned', !!profile);
  ck('profile.type is printer, not unknown', profile && profile.type === 'printer',
     'type=' + (profile && profile.type) + '  - UNKNOWN here means silent reconnect can never find it');
  const saved = (typeof L.hub.getDevicesByType === 'function') ? L.hub.getDevicesByType('printer') : [];
  ck('getDevicesByType(printer) now finds it', saved.length === 1, 'found=' + saved.length);

  head('4 - user cancellation is a normal outcome, not a crash');
  const C = loadHub();
  C.sandbox.navigator.bluetooth.requestDevice = async () => {
    const e = new Error('User cancelled'); e.name = 'NotFoundError'; throw e;
  };
  let cancelled = 'threw';
  try { cancelled = await C.hub.requestDevice('bluetooth', 'printer'); }
  catch (e) { cancelled = 'threw:' + e.name; }
  ck('cancellation returns null (no throw)', cancelled === null, 'got ' + JSON.stringify(cancelled));

  head('5 - a REAL failure must propagate, never be flattened');
  const S = loadHub();
  S.sandbox.navigator.bluetooth.requestDevice = async () => {
    const e = new Error('disallowed by permissions policy'); e.name = 'SecurityError'; throw e;
  };
  let sec = 'no-throw';
  try { await S.hub.requestDevice('bluetooth', 'printer'); }
  catch (e) { sec = e.name; }
  ck('SecurityError propagates to the caller', sec === 'SecurityError', 'got ' + sec);
  ck('...and is NOT reported as a cancellation', sec !== null && sec !== 'no-throw',
     'flattening this is what produced "No printer connected" for a blocked page');

  head('6 - PosPrintService.connect exists and is wired to the hub');
  const pps = fs.readFileSync(path.join(ROOT, 'sokoni-pos-print-service.js'), 'utf8');
  const code = pps.replace(/\/\*[\s\S]*?\*\//g, '');
  ck('window.PosPrintService.connect is defined',
     code.indexOf('window.PosPrintService.connect') > -1,
     'its absence WAS the bug: the if-branch was skipped silently');
  ck('it calls the hub chooser', code.indexOf("hub.requestDevice('bluetooth', 'printer')") > -1);
  ck('CONTROL it adds no second Bluetooth implementation',
     code.indexOf('navigator.bluetooth.requestDevice') === -1,
     'comments stripped first, so a mention in prose cannot pass this');

  head('7 - GESTURE CONTRACT: nothing awaited before the chooser');
  const body = (code.split('window.PosPrintService.connect')[1] || '').split('window.PosPrintService.autoReconnect')[0];
  /* Split on the CHOOSER CALL, not on the identifier. The first mention of
     `hub.requestDevice` is the guard `typeof hub.requestDevice !== 'function'`, so
     splitting there truncated the region before the code under test and this
     assertion passed against an await deliberately inserted ahead of the chooser. */
  const beforeChooser = body.split('await hub.requestDevice')[0];
  ck('PRECONDITION the chooser call was located', body.indexOf('await hub.requestDevice') > -1,
     'if this fails the assertion below is vacuous');
  ck('no await precedes the chooser call inside connect()',
     beforeChooser.indexOf('await') === -1,
     'an await here ends the transient activation and the browser refuses the chooser');
  ck('the hub is read synchronously', /const\s+hub\s*=\s*window\.SokoniDeviceHub/.test(beforeChooser));

  const v2 = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');
  const cpn = (v2.split('async function connectPrinterNow')[1] || '').slice(0, 1400);
  const uncommented = cpn.replace(/\/\*[\s\S]*?\*\//g, '');
  const beforeConnect = uncommented.split('eng.connect()')[0];
  ck('connectPrinterNow does not lazy-load the service before connecting',
     beforeConnect.indexOf('await printerEngine()') === -1 || beforeConnect.indexOf('window.PosPrintService ||') > -1,
     'a loadScript() fetch between tap and chooser spends the activation');
  ck('autoReconnect is gated on an actually-saved printer',
     /if\s*\(\s*DEV\.printer\.saved\s*&&\s*eng\.autoReconnect\s*\)/.test(uncommented),
     'awaiting it with nothing saved spent the gesture for no benefit');

  head('8 - the stack is preloaded, not fetched inside the click');
  ck('sokoni-device-hub.js is loaded by merchant-v2',
     v2.indexOf('src="sokoni-device-hub.js"') > -1,
     'it owns the chooser; without it connect() cannot pair at all');
  ck('sokoni-pos-print-service.js is loaded by merchant-v2',
     v2.indexOf('src="sokoni-pos-print-service.js"') > -1);

  head('what this suite does NOT prove');
  console.log('  UNPROVEN   real GATT pairing with physical hardware   [needs the handset]');
  console.log('  UNPROVEN   that Android Chrome grants the chooser in the PWA   [device-only]');

  console.log('\n' + '-'.repeat(62));
  console.log('  PASS ' + pass + '   FAIL ' + fail + '   HARNESS-INVALID ' + invalid);
  process.exit((fail || invalid) ? 1 : 0);
})();
