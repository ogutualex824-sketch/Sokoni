/* ══════════════════════════════════════════════════════════════════════════════
   Desktop printer-host UI — EXECUTED
   ══════════════════════════════════════════════════════════════════════════════
   FIRST TIME   merchant chooses → Connect P58E → register host
   LATER        open SOKONI → autoReconnect → connected → listen → print

   Two safety boundaries carry this slice, and both are executed rather than read:

     1. OPENING SOKONI NEVER REGISTERS A HOST. refresh() and mount() are read-only; the
        registration callable is reachable only from register(), which only a button calls.

     2. THE LISTENER STARTS ONLY WHEN host === true AND the printer is genuinely CONNECTED.
        Every other combination must leave it stopped, or jobs pile up and all print at once
        the moment a printer appears.

   Plus: saved must never render as connected.

   Run: node scripts/test-printer-host-ui.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '\n          ' + d : '')); ok ? pass++ : fail++; };
const head = (t) => console.log('\n' + t);

const ROOT = path.join(__dirname, '..');
global.window = global;
const LS = {};
global.localStorage = { getItem: (k) => (k in LS ? LS[k] : null), setItem: (k, v) => { LS[k] = String(v); } };
try { Object.defineProperty(global, 'navigator', { value: { bluetooth: { getDevices: () => [] } }, configurable: true, writable: true }); } catch (_) {}

require(path.join(ROOT, 'sokoni-print-host-listener.js'));
require(path.join(ROOT, 'sokoni-printer-host-ui.js'));
const UI = global.window.SokoniPrinterHostUI;
const ST = UI.STATES;

/* ── A dependency set that RECORDS what was asked of it ───────────────────── */
function mkDeps (over) {
  const calls = { getStatus: 0, registerHost: [], connectPrinter: 0, start: [], stop: 0, test: 0, reconnect: 0 };
  const d = Object.assign({
    calls,
    getStatus: async () => { calls.getStatus++; return d._status; },
    registerHost: async (p) => { calls.registerHost.push(p); return { ok: true }; },
    connectPrinter: async () => { calls.connectPrinter++; return { ok: true, identity: { name: 'MP58E' } }; },
    printerState: () => d._printerState || 'unknown',
    startListener: (p) => { calls.start.push(p); },
    stopListener: () => { calls.stop++; },
    testPrint: async () => { calls.test++; },
    reconnect: async () => { calls.reconnect++; },
    _status: null,
    _printerState: 'unknown',
  }, over || {});
  return d;
}

const HOSTED = { registered: true, isHost: true, shopId: 'SHOP_A', printerName: 'P58E' };

(async () => {
  head('0 - controls');
  ck('CONTROL: the module loaded', !!UI && typeof UI.computeState === 'function');
  const SRC = fs.readFileSync(path.join(ROOT, 'sokoni-printer-host-ui.js'), 'utf8');
  ck('CONTROL: it is a real implementation, not a stub', SRC.length > 4000);

  /* ── 1. every state, executed ───────────────────────────────────────────── */
  head('1 - the state machine');
  const S = (o) => UI.computeState(Object.assign({ deviceId: 'dev-uuid', supported: true }, o));

  let v = S({ supported: false });
  ck('no Web Bluetooth → unsupported, no Connect button', v.kind === ST.UNSUPPORTED
     && v.actions.indexOf('connect') < 0, 'offering a button that cannot work is worse than saying so');

  v = S({ deviceId: null });
  ck('no device id → "not set up"', v.kind === ST.NO_DEVICE);

  v = S({ host: null });
  ck('server not yet asked → "Checking…", never a guess', v.kind === ST.UNKNOWN);

  v = S({ host: { registered: false } });
  ck('unregistered device → setup, not an error', v.kind === ST.NOT_REGISTERED);

  v = S({ host: { registered: true, isHost: false } });
  ck('registered but not host → the exact copy asked for', v.kind === ST.NOT_HOST
     && v.title === 'Printer not connected'
     && v.detail === 'This desktop is not currently the printing host for this shop.', v.detail);
  ck('and it offers Connect P58E', v.actions.indexOf('connect') === 0);

  v = S({ host: { registered: true, isHost: false, otherHost: { deviceId: 'other', printerName: 'Till 2' } } });
  ck('another desktop holds it → said plainly', v.kind === ST.OTHER_HOST && /Till 2/.test(v.detail));
  ck('and taking over is explicit', v.actions.indexOf('connect-replace') === 0,
     'a silent takeover would stop another till printing with no warning');

  v = S({ host: HOSTED, printerState: 'connected' });
  ck('host + connected → Connected', v.kind === ST.HOST_CONNECTED && v.title === 'Connected');
  ck('detail reads "P58E · Ready to print"', v.detail === 'P58E · Ready to print', v.detail);
  ck('actions are Test Print and Change Printer',
     v.actions.join(',') === 'test,change', v.actions.join(','));

  v = S({ host: HOSTED, printerState: 'saved' });
  ck('host + saved → "Saved printer"', v.kind === ST.HOST_SAVED && v.title === 'Saved printer');
  ck('and it reads Reconnecting…, not Connected', /Reconnecting/.test(v.detail) && v.title !== 'Connected',
     v.detail);

  v = S({ host: HOSTED, printerState: 'connecting' });
  ck('host + connecting → Reconnecting…', v.kind === ST.HOST_CONNECTING);

  head('2 - saved is never dressed as connected');
  ['saved', 'connecting', 'unknown', 'unsupported', 'disconnected'].forEach((ps) => {
    const x = S({ host: HOSTED, printerState: ps });
    ck('printerState "' + ps + '" does not render as Connected',
       x.kind !== ST.HOST_CONNECTED && x.dot === 'off' && x.title !== 'Connected', x.title);
  });
  ck('only "connected" gets the filled dot',
     S({ host: HOSTED, printerState: 'connected' }).dot === 'on');

  /* ── 3. THE LISTENER GATE ───────────────────────────────────────────────── */
  head('3 - the listener starts in exactly one state');
  const combos = [];
  [null, { registered: false }, { registered: true, isHost: false },
   { registered: true, isHost: true, shopId: 'SHOP_A' }].forEach((h) => {
    ['unknown', 'saved', 'connecting', 'connected', 'unsupported'].forEach((ps) => {
      combos.push({ host: h, printerState: ps });
    });
  });
  const starts = combos.filter((c) => S(c).mayStartListener);
  ck('across all ' + combos.length + ' host×printer combinations, exactly ONE may start',
     starts.length === 1, 'got ' + starts.length);
  ck('and it is host + connected',
     starts.length === 1 && starts[0].host.isHost === true && starts[0].printerState === 'connected');
  ck('a host whose printer is merely saved may NOT start',
     S({ host: HOSTED, printerState: 'saved' }).mayStartListener === false,
     'jobs would pile up and all print at once when the printer appeared');
  ck('a connected printer on a NON-host may not start',
     S({ host: { registered: true, isHost: false }, printerState: 'connected' }).mayStartListener === false);

  /* ── 4. opening SOKONI must not register ────────────────────────────────── */
  head('4 - opening SOKONI never registers a host');
  LS.sokoni_device_id = 'dev-uuid-1';
  let deps = mkDeps();
  deps._status = { registered: true, isHost: false };
  await UI.mount(null, deps);
  ck('mount() asked the server', deps.calls.getStatus === 1);
  ck('mount() registered NOTHING', deps.calls.registerHost.length === 0,
     'registration is an explicit merchant action, never a side effect of opening the app');
  ck('mount() connected no printer', deps.calls.connectPrinter === 0);
  ck('and started no listener', deps.calls.start.length === 0);

  await UI.refresh();
  await UI.refresh();
  ck('repeated refreshes still register nothing', deps.calls.registerHost.length === 0);

  /* The read-only claim, structurally. */
  ck('refresh() has no path to registerHost',
     SRC.slice(SRC.indexOf('async function refresh ()'), SRC.indexOf('function _apply ()'))
       .indexOf('registerHost') < 0);
  const reg = SRC.slice(SRC.indexOf('async function register ('), SRC.indexOf('function _render ('));
  ck('registerHost is called from exactly one place', (SRC.match(/deps\.registerHost\(/g) || []).length === 1);
  ck('and that place is register()', reg.indexOf('deps.registerHost(') > 0);

  head('5 - registering is explicit, and connects the printer first');
  deps = mkDeps();
  deps._status = { registered: true, isHost: false };
  await UI.mount(null, deps);
  deps._status = Object.assign({}, HOSTED);
  deps._printerState = 'connected';
  const res = await UI.register({ replace: false });
  ck('it succeeds', res.ok === true);
  ck('the printer was connected BEFORE registration', deps.calls.connectPrinter === 1
     && deps.calls.registerHost.length === 1,
     'registering a host that cannot print is a promise the shop cannot keep');
  ck('the printer identity was passed through',
     deps.calls.registerHost[0].printerIdentity && deps.calls.registerHost[0].printerIdentity.name === 'MP58E');
  ck('the caller supplied only a deviceId — no shopId', !('shopId' in deps.calls.registerHost[0]),
     'the shop is read from the stored device record, never asserted by the browser');
  ck('and NOW the listener starts', deps.calls.start.length === 1);
  ck('it starts with the SERVER-supplied shopId', deps.calls.start[0].shopId === 'SHOP_A');

  head('6 - a printer that will not connect does not become a host');
  deps = mkDeps({ connectPrinter: async () => ({ ok: false }) });
  deps._status = { registered: true, isHost: false };
  await UI.mount(null, deps);
  const bad = await UI.register({});
  ck('registration is refused', bad.ok === false && bad.reason === 'printer-not-connected');
  ck('nothing was registered', deps.calls.registerHost.length === 0);
  ck('no listener started', deps.calls.start.length === 0);

  head('7 - replace is only ever explicit');
  deps = mkDeps();
  deps._status = { registered: true, isHost: false, otherHost: { deviceId: 'till2', printerName: 'Till 2' } };
  await UI.mount(null, deps);
  await UI.register({ replace: false });
  ck('a plain Connect does NOT pass replace', deps.calls.registerHost[0].replace === false,
     'the server then refuses with already-exists, which is the correct place to decide');
  await UI.register({ replace: true });
  ck('taking over passes replace explicitly', deps.calls.registerHost[1].replace === true);

  head('8 - losing the printer stops the listener');
  deps = mkDeps();
  deps._status = Object.assign({}, HOSTED);
  deps._printerState = 'connected';
  await UI.mount(null, deps);
  ck('CONTROL: it started', deps.calls.start.length === 1);
  deps._printerState = 'saved';                     /* the P58E dropped */
  await UI.refresh();
  ck('the listener is stopped', deps.calls.stop === 1,
     'a listener claiming jobs it cannot print would mark them CLAIMED and strand them');
  ck('the surface reads Saved printer', UI.view().kind === ST.HOST_SAVED);
  deps._printerState = 'connected';
  await UI.refresh();
  ck('and it restarts when the printer returns', deps.calls.start.length === 2);

  head('9 - it does not start twice');
  deps = mkDeps();
  deps._status = Object.assign({}, HOSTED);
  deps._printerState = 'connected';
  await UI.mount(null, deps);
  await UI.refresh(); await UI.refresh(); await UI.refresh();
  ck('four passes, ONE start', deps.calls.start.length === 1, 'starts=' + deps.calls.start.length);

  head('9b - re-mounting starts the NEW listener');
  /* The bug this exists for: listenerStarted is module state. Left set across a re-mount — a
     shop switch, a re-login, a device change — _apply() believes a listener is already running
     and never starts the new one. The surface would read "Connected" while nothing consumed
     print intents. Found by test-ordering contamination, kept as a case in its own right. */
  const first = mkDeps();
  first._status = Object.assign({}, HOSTED);
  first._printerState = 'connected';
  await UI.mount(null, first);
  ck('CONTROL: the first listener started', first.calls.start.length === 1);
  const second = mkDeps();
  second._status = Object.assign({}, HOSTED, { shopId: 'SHOP_B' });
  second._printerState = 'connected';
  await UI.mount(null, second);
  ck('the previous listener was stopped', first.calls.stop === 1);
  ck('and the NEW one started', second.calls.start.length === 1);
  ck('with the new shop', second.calls.start[0].shopId === 'SHOP_B');

  head('10 - the device id and the shop');
  ck('it uses sokoni_device_id', deps.calls.getStatus > 0 && LS.sokoni_device_id === 'dev-uuid-1');
  LS.pos_device_id = 'dev_local_xyz';
  ck('pos_device_id is never used as identity', !/pos_device_id/.test(
     SRC.replace(/\/\*[\s\S]*?\*\//g, '')),
     'it names nothing on the server — see POS_DEVICE_ID_TWO_KEYS');
  const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, '');
  ck('the UI never sends a shopId to the server', !/shopId:\s*[^)]*localStorage/.test(stripped));
  ck('shopId is only ever read back off the host reply', /S\.host\.shopId/.test(stripped));

  head('11 - no Bluetooth in this file');
  /* The feature-detect names it twice (`x.bluetooth && x.bluetooth.getDevices`), so counting
     occurrences is the wrong instrument. Assert what actually matters: it reads capability and
     never drives the transport. */
  ck('navigator.bluetooth appears only inside the feature detect',
     /_supported \(\)[\s\S]{0,220}navigator\.bluetooth\.getDevices/.test(stripped)
     && !/navigator\.bluetooth\.(requestDevice|getDevices)\s*\(/.test(
        stripped.replace(/function _supported[\s\S]*?\n  \}/, '')),
     'it may ask whether Bluetooth exists; it may not use it');
  ck('it never calls requestDevice', !/requestDevice/.test(stripped),
     'connecting is PosPrintService/SokoniDeviceHub work — no sixth Bluetooth implementation');

  head('12 - the callable it depends on exists and is read-only');
  const DM = fs.readFileSync(path.join(ROOT, 'functions', 'device-manager.js'), 'utf8');
  const gs = DM.indexOf('exports.getPrinterHostStatus = onCall(');
  ck('CONTROL: getPrinterHostStatus exists', gs > 0);
  const body = DM.slice(gs, DM.indexOf('module.exports = {'));
  ck('it writes nothing', !/\.set\(|\.update\(|runTransaction/.test(body),
     'opening the app must not be able to change anything');
  ck('it derives the shop from the stored device', /const shopId = device\.merchantId/.test(body));
  ck('it never reads a shopId from the request', !/data\.(shopId|merchantId)/.test(body));
  const IDX = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
  ck('re-exported by name from index.js',
     /exports\.getPrinterHostStatus\s*=\s*deviceMgr\.getPrinterHostStatus/.test(IDX));

  head('13 - the shell wiring');
  const MV2 = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');
  const clean = MV2.replace(/\/\*[\s\S]*?\*\//g, '');
  ck('the devices panel has a mount point', /id="sk-printer-host-mount"/.test(clean));
  ck('renderDevices mounts the host surface', /mountPrinterHost\(\);/.test(clean));
  ck('mounting is not wired to page load',
     !/DOMContentLoaded[\s\S]{0,200}mountPrinterHost/.test(clean),
     'it binds when the merchant opens Devices, and even then it only reads');
  ck('registerPrinterHost has exactly ONE call site',
     (clean.match(/registerPrinterHost/g) || []).length === 1,
     'a second call site would be a second way to become host');
  ck('the shell has ONE connect',
     (clean.match(/async function connectPrinterNow/g) || []).length === 1);
  ck('deviceConnect delegates to it', /await connectPrinterNow\(\)/.test(clean),
     'two pairing paths would drift into two answers about how a printer comes up');
  const startSites = (clean.match(/SokoniPrintHost\.start\(|m\.start\(o\)/g) || []).length;
  ck('the listener has exactly one start site', startSites === 1, 'found ' + startSites);
  ck('and it sits inside the startListener dep, not at load',
     /startListener:[\s\S]{0,200}m\.start\(o\)/.test(clean),
     'a page load is not a decision to start printing');

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  aborted: ' + (e && e.stack)); process.exit(1); });
