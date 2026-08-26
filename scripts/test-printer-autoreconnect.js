/* ══════════════════════════════════════════════════════════════════════════════
   SILENT RECONNECT — the reload path, executed
   ══════════════════════════════════════════════════════════════════════════════
   merchant-v2 has always called eng.autoReconnect(), and until this slice NOTHING
   implemented it — not the print service, not pos-printer.js, not any of the five modules
   that touch GATT. The ternary took the false branch every time and the printer state fell to
   'saved' on every load, which a merchant reads as "my printer is gone" while the browser has
   held the grant the whole time.

   The behaviour under test is a RELOAD, so the assertions are mostly about what must NOT
   happen: no chooser, no pairing prompt, no adopting somebody else's device, no claiming a
   connection that was never made, and above all no printing. A reload is not a print trigger.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '\n          ' + d : '')); ok ? pass++ : fail++; };
const head = (t) => console.log('\n' + t);

/* ── A hub stub that RECORDS what was asked of it ─────────────────────────── */
function makeHub (opts) {
  const o = opts || {};
  const calls = { discover: 0, connect: [], requestDevice: 0 };
  let devices = (o.devices || []).map((d) => Object.assign({ type: 'printer' }, d));
  return {
    calls,
    discover: async (types) => { calls.discover++; return devices.filter((d) => !types || types.includes(d.type)); },
    /* If autoReconnect ever calls this, a browser chooser appears on a page reload. */
    requestDevice: async () => { calls.requestDevice++; throw new Error('chooser opened'); },
    getDevicesByType: (t) => devices.filter((d) => d.type === t),
    getPrinter: () => devices.find((d) => d.type === 'printer' && d.status === 'connected') || null,
    isConnected: (id) => { const d = devices.find((x) => x.id === id); return !!d && d.status === 'connected'; },
    connect: async (id) => {
      calls.connect.push(id);
      const d = devices.find((x) => x.id === id);
      if (!d) throw new Error('not found');
      if (o.connectFails) throw new Error('GATT unreachable');
      d.status = 'connected';
      return d;
    },
    on: () => {},
  };
}

/* Load the print service with a DOM stub, then swap the hub per case. */
global.window = global;
/* The service wires window focus/online listeners at construction. */
global.addEventListener = function () {};
global.removeEventListener = function () {};
global.document = {
  readyState: 'complete', head: { appendChild() {} }, body: { appendChild() {}, removeChild() {} },
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  querySelector: () => null, querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {}, getElementById: () => null,
};
try { Object.defineProperty(global, 'navigator', { value: {}, configurable: true, writable: true }); } catch (e) {}
global.localStorage = { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = String(v); } };

require(path.join(ROOT, 'sokoni-pos-print-service.js'));
const PPS = global.window.PosPrintService;

head('0 - the capability exists at all');
ck('CONTROL: PosPrintService loaded', !!PPS);
ck('autoReconnect is IMPLEMENTED', typeof PPS.autoReconnect === 'function',
   'merchant-v2 has been calling this into the void');
/* The defect, stated as an assertion: the shell must find it on the engine. */
const shell = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');
ck('the shell call site still expects it on the engine',
   /eng\.autoReconnect \? eng\.autoReconnect\(\)/.test(shell));

(async () => {
  /* ── 1. THE RELOAD PATH ─────────────────────────────────────────────────── */
  head('1 - a previously granted printer reconnects with no prompt');
  let hub = makeHub({ devices: [{ id: 'p58e', name: 'MP58E', status: 'disconnected', nativeDevice: {} }] });
  global.window.SokoniDeviceHub = hub;
  let ok = await PPS.autoReconnect();
  ck('it reports connected', ok === true);
  ck('it went through discover()', hub.calls.discover === 1);
  ck('it connected the SAVED device', hub.calls.connect.length === 1 && hub.calls.connect[0] === 'p58e');
  ck('NO chooser was opened', hub.calls.requestDevice === 0,
     'requestDevice needs a user gesture — a reload must never trigger it');

  /* ── 2. ALREADY CONNECTED ───────────────────────────────────────────────── */
  head('2 - an already-connected printer is left alone');
  hub = makeHub({ devices: [{ id: 'p58e', name: 'MP58E', status: 'connected', nativeDevice: {} }] });
  global.window.SokoniDeviceHub = hub;
  ok = await PPS.autoReconnect();
  ck('it reports connected', ok === true);
  ck('it did NOT reconnect a live link', hub.calls.connect.length === 0,
     'reconnecting a live GATT link drops it and re-establishes it for nothing');
  ck('it did not even need to discover', hub.calls.discover === 0);

  /* ── 3. FAILURE MUST NOT CLAIM SUCCESS ──────────────────────────────────── */
  head('3 - a printer that cannot be reached is not "connected"');
  hub = makeHub({ devices: [{ id: 'p58e', name: 'MP58E', status: 'disconnected', nativeDevice: {} }], connectFails: true });
  global.window.SokoniDeviceHub = hub;
  ok = await PPS.autoReconnect();
  ck('it reports FALSE when the connect throws', ok === false);
  ck('it still did not open a chooser', hub.calls.requestDevice === 0,
     'a switched-off printer must not become a pairing prompt');

  /* ── 4. A REMEMBERED DEVICE THE BROWSER DID NOT RETURN ──────────────────── */
  head('4 - saved is not connected');
  hub = makeHub({ devices: [{ id: 'p58e', name: 'MP58E', status: 'disconnected' /* no nativeDevice */ }] });
  global.window.SokoniDeviceHub = hub;
  ok = await PPS.autoReconnect();
  ck('a profile with no live handle is NOT claimed as connected', ok === false,
     'this is exactly the "saved means connected" lie the slice removes');
  ck('and it was not attempted', hub.calls.connect.length === 0);

  /* ── 5. NOTHING TO RECONNECT ────────────────────────────────────────────── */
  head('5 - no printer at all');
  hub = makeHub({ devices: [] });
  global.window.SokoniDeviceHub = hub;
  ck('returns false with no saved printer', (await PPS.autoReconnect()) === false);
  ck('no chooser', hub.calls.requestDevice === 0);

  /* ── 6. IT MUST NOT ADOPT SOMEBODY ELSE'S DEVICE ────────────────────────── */
  head('6 - only a printer is adopted');
  hub = makeHub({ devices: [{ id: 'scan1', name: 'Scanner', type: 'scanner', status: 'disconnected', nativeDevice: {} }] });
  global.window.SokoniDeviceHub = hub;
  ok = await PPS.autoReconnect();
  ck('a scanner is not adopted as the printer', ok === false);
  ck('nothing was connected', hub.calls.connect.length === 0);

  /* ── 7. NO HUB ──────────────────────────────────────────────────────────── */
  head('7 - degrades honestly');
  global.window.SokoniDeviceHub = null;
  ck('with no device hub it returns false rather than throwing',
     (await PPS.autoReconnect()) === false);

  /* ── 8. A RELOAD IS NOT A PRINT TRIGGER ─────────────────────────────────── */
  head('8 - reconnecting never prints');
  const src = fs.readFileSync(path.join(ROOT, 'sokoni-pos-print-service.js'), 'utf8');
  const fn = src.slice(src.indexOf('window.PosPrintService.autoReconnect'),
                       src.indexOf('/* A dropped link is not a forgotten device'));
  ck('CONTROL: the implementation was located (' + fn.length + ' chars)', fn.length > 400);
  ck('it calls nothing that prints',
     !/\bprint\(|printReceipt|drain|enqueue|flush/.test(fn),
     'a reload draining the queue would print receipts nobody asked for');
  ck('it never calls requestDevice', !/requestDevice/.test(fn));
  ck('it asks the hub whether it is connected rather than assuming',
     /isConnected\(target\.id\)/.test(fn));

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
