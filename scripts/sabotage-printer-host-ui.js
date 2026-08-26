/* Sabotage runner for the desktop printer-host UI.
   Every edit asserts it matched EXACTLY ONCE before writing; every verdict is the EXIT CODE. */
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SUITE = 'scripts/test-printer-host-ui.js';

const CASES = [
  ['saved renders as connected', 'sokoni-printer-host-ui.js',
   "    return _s(ST.HOST_SAVED, 'Saved printer',",
   "    return _s(ST.HOST_CONNECTED, 'Connected',"],

  ['the listener starts without a live printer', 'sokoni-printer-host-ui.js',
   "    if (printerState === 'connected') {", "    if (true) {"],

  ['a non-host may start the listener', 'sokoni-printer-host-ui.js',
   "    if (host.isHost !== true) {", "    if (false) {"],

  ['opening the app registers a host', 'sokoni-printer-host-ui.js',
   "      try { S.host = await S.deps.getStatus({ deviceId: S.deviceId }); }",
   "      try { await S.deps.registerHost({ deviceId: S.deviceId }); S.host = await S.deps.getStatus({ deviceId: S.deviceId }); }"],

  ['registration skips connecting the printer', 'sokoni-printer-host-ui.js',
   "    if (!connected || connected.ok === false) {", "    if (false) {"],

  ['a dropped printer leaves the listener running', 'sokoni-printer-host-ui.js',
   "    } else if (!view.mayStartListener && S.listenerStarted) {", "    } else if (false) {"],

  ['re-mounting does not reset the start flag', 'sokoni-printer-host-ui.js',
   "    S.listenerStarted = false;\n    S.host = null;", "    S.host = null;"],

  ['the browser asserts its own shop', 'sokoni-printer-host-ui.js',
   "        S.deps.startListener({ shopId: S.host.shopId, deviceId: S.deviceId });",
   "        S.deps.startListener({ shopId: 'SHOP_ANY', deviceId: S.deviceId });"],

  ['the status callable starts writing', 'functions/device-manager.js',
   "  const snap = await db.collection('posDevices').doc(deviceId).get();\n  if (!snap.exists) {\n    /* Not an error. A fresh desktop that has never run POS setup is a normal state, and the\n       UI needs to say so rather than show a failure. */\n    return { ok: true, registered: false, deviceId, isHost: false };",
   "  const snap = await db.collection('posDevices').doc(deviceId).get();\n  if (!snap.exists) {\n    await db.collection('posDevices').doc(deviceId).set({ touched: true }, { merge: true });\n    return { ok: true, registered: false, deviceId, isHost: false };"],

  ['the status callable trusts a request shopId', 'functions/device-manager.js',
   "  const shopId = device.merchantId || null;",
   "  const shopId = (req.data && req.data.shopId) || device.merchantId || null;"],

  ['the shell gains a second connect path', 'merchant-v2.html',
   "      var r = await connectPrinterNow();",
   "      var eng = await printerEngine(); var r = { ok: eng && eng.connect ? await eng.connect() : false };"],
];

let caught = 0, missed = 0;
for (const [label, file, find, repl] of CASES) {
  const p = path.join(ROOT, file);
  const orig = fs.readFileSync(p, 'utf8');
  const n = orig.split(find).length - 1;
  if (n !== 1) {
    console.log('  BROKEN PROBE  ' + label + '  (matched ' + n + 'x in ' + file + ')');
    missed++; continue;
  }
  fs.writeFileSync(p, orig.replace(find, repl));
  let code = 0, out = '';
  try { out = execFileSync(process.execPath, [SUITE], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { code = e.status === undefined ? 1 : e.status; out = (e.stdout || '') + (e.stderr || ''); }
  fs.writeFileSync(p, orig);

  const fails = (out.match(/^ {2}FAIL/gm) || []).length;
  console.log('  ' + (code ? 'CAUGHT ' : 'MISSED ') + label.padEnd(46)
    + 'exit=' + code + ' fails=' + fails + (/^ {2}aborted/m.test(out) ? ' (aborted)' : ''));
  if (code) caught++; else missed++;
}

console.log('\n  ' + caught + ' caught, ' + missed + ' missed / not proven');
process.exit(missed ? 1 : 0);
