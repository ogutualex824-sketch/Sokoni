#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   SHELL PRINTER CONVERGENCE

   One shell-owned connection, consumed by Devices, POS and POS Setup.

   The LOAD-BEARING test is the NEGATIVE CONTROL: a framed module reporting
   connected:false must NEVER downgrade a shell that is already connected. A framed
   module runs in its own JS context, so its SokoniPrinter is not the object holding
   the GATT link — pos.html reports false on a tick while the shell is genuinely
   connected, and acting on it flipped the Devices card to "saved" the moment POS was
   opened.

   Second: a framed print must reach the shell's real engine. Queueing locally reports
   success and produces NO PAPER, which is worse than failing.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const V2  = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');
const PPS = fs.readFileSync(path.join(ROOT, 'sokoni-pos-print-service.js'), 'utf8');
const POS = fs.readFileSync(path.join(ROOT, 'pos.html'), 'utf8');
const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '');

let pass = 0, fail = 0, invalid = 0;
const ok = (l, d) => { pass++; console.log('  PASS       ' + l + (d ? '   [' + d + ']' : '')); };
const no = (l, d) => { fail++; console.log('  FAIL       ' + l + (d ? '   [' + d + ']' : '')); };
const ck = (l, c, d) => (c ? ok(l, d) : no(l, d));
const head = (t) => console.log('\n-- ' + t + ' --');

head('0 - harness integrity');
ck('merchant-v2 read', V2.length > 10000, V2.length + ' bytes');
ck('print service read', PPS.length > 10000, PPS.length + ' bytes');
ck('CONTROL pos.html still reports its local state on a tick',
   POS.indexOf("type: 'printerStatus'") > -1,
   'if POS stopped reporting, the guard below would be untested rather than passing');

head('1 - THE NEGATIVE CONTROL: a module must not downgrade the shell');
const v2c = code(V2);
ck('the shell guards the negative branch',
   /else if \(DEV\.printer\.state !== 'connected'\)/.test(v2c),
   'a false report is accepted ONLY when the shell does not already know better');
ck('...and the OLD unconditional assignment is GONE',
   v2c.indexOf("DEV.printer.state = d.connected ? 'connected' : (DEV.printer.saved ? 'saved' : 'unknown');") === -1,
   'this single line was the state corruption');
ck('CONTROL a POSITIVE report is still accepted',
   /if \(d\.connected\) \{[\s\S]{0,200}DEV\.printer\.state = 'connected'/.test(v2c),
   'the guard must not deafen the shell to a real connection');
ck('...and a positive report still saves the device',
   /if \(d\.deviceId\) saveDevice\(/.test(v2c));
ck('the reason is recorded for the next reader',
   V2.indexOf('A MODULE MAY NOT DOWNGRADE THE SHELL') > -1);

head('2 - the shell broadcasts the shape modules already consume');
ck('__sokoniPrinterState is sent', v2c.indexOf('__sokoniPrinterState: true') > -1);
ck('...carrying a real connected flag',
   /connected: DEV\.printer\.state === 'connected'/.test(v2c));
ck('CONTROL the receiver already exists and was never wired',
   PPS.indexOf('window.__sokoniApplyShellPrinter') > -1,
   'this suite would be vacuous if nothing consumed the message');
ck('CONTROL pos.html consumes it', POS.indexOf('__sokoniApplyShellPrinter') > -1);
ck('the original devices broadcast is retained', v2c.indexOf("type: 'devices'") > -1);
/* A BROADCAST ON CHANGE IS NOT ENOUGH. broadcastDevices() only runs when a device
   changes, so a panel opened while nothing changed received the old shapes only and
   showed a disconnected printer beside a connected Devices card. The load handshake
   must carry it too, and the module must ASK so a late-registered listener cannot
   lose it. Either alone leaves a race. */
ck('the LOAD HANDSHAKE also sends it',
   (v2c.split('__sokoniPrinterState: true').length - 1) === 2,
   'one in broadcastDevices, one in the iframe load handshake');
const PSU = fs.readFileSync(path.join(ROOT, 'pos-printer-setup.html'), 'utf8');
ck('the module ASKS on boot', PSU.indexOf("type: 'requestShellState'") > -1);
ck('...only when framed', PSU.indexOf('window.parent && window.parent !== window') > -1);
ck('CONTROL the shell answers that request',
   v2c.indexOf("if (d.type === 'requestShellState') { broadcastSession(); broadcastDevices(); }") > -1,
   'asking would be pointless if the shell did not answer');

head('3 - a framed print must reach the SHELL engine, not the local queue');
const ppc = code(PPS);
ck('the shell transport exists', ppc.indexOf('function _printViaShell') > -1);
ck('it is gated on BEING FRAMED', /function _framed \(\)/.test(ppc));
ck('...AND on the shell reporting connected',
   /_framed\(\) && !!\(_shellPrinterState && _shellPrinterState\.connected\)/.test(ppc));
const iTry = ppc.indexOf('if (_shellCanPrint())');
const iQ   = ppc.indexOf('const queued = this.queue.enqueue');
ck('the shell is tried BEFORE queueing', iTry > -1 && iQ > -1 && iTry < iQ,
   'try@' + iTry + ' queue@' + iQ);
ck('success is returned ONLY on a real ack',
   /if \(viaShell\.ok\) \{[\s\S]{0,400}return \{ success: true, viaShell: true/.test(ppc),
   'never merely because a job was queued');
ck('a silent shell FAILS rather than hanging',
   PPS.indexOf('The shell printer did not respond.') > -1);
ck('a shell failure is emitted, not masked',
   ppc.indexOf("this._emit('error'") > -1 && PPS.indexOf('do not pretend the job') > -1);

head('4 - the shell only prints on a REAL connection');
ck('the shell accepts printBytes', v2c.indexOf("d.type === 'printBytes'") > -1);
ck('...validates the payload', /Array\.isArray\(d\.bytes\)/.test(v2c));
ck('...REFUSES when its own engine is not connected',
   v2c.indexOf("if (!eng.connected) { reply(false, 'The shell printer is not connected.'); return; }") > -1,
   'the shell must not claim a print it cannot perform');
ck('...and reports the real outcome back', v2c.indexOf("type: 'printResult'") > -1);
ck('...writing through the ONE engine', /eng\.printRaw\(new Uint8Array\(bytes\)\)/.test(v2c));

head('5 - the print path must recognise the engine that can actually print');
/* printReceipt() chose between the working path and a legacy chain by asking about
   PrinterManager and the iOS bridge only. The universal engine — the object that
   performs the print — was not counted, so merchant-v2 (engine, no PrinterManager)
   was diverted to _legacyFallback, which tries SokoniPrint then PosPrinter. It loads
   neither, so every shell print failed and the caller discarded the result. */
ck('the gate counts the engine',
   ppc.indexOf('const enterpriseAvailable = !!pm || !!_eng() || !!window.SokoniIOSPrint;') > -1);
ck('...and the OLD gate is gone',
   ppc.indexOf('const enterpriseAvailable = !!pm || !!window.SokoniIOSPrint;') === -1,
   'this single expression sent every shell print to a chain merchant-v2 cannot run');
ck('CONTROL PrinterManager is still consulted FIRST',
   /enterpriseAvailable = !!pm \|\|/.test(ppc),
   'the engine is added, not substituted');
ck('CONTROL the legacy chain is retained as a fallback', ppc.indexOf('_legacyFallback') > -1);
ck('CONTROL merchant-v2 really lacks the legacy globals',
   V2.indexOf('src="sokoni-print-engine.js"') === -1 && V2.indexOf('src="pos-printer.js"') === -1,
   'if it loaded them the legacy chain would have worked and this gate would be untested');

head('5b - a failed print must SAY so');
ck('Orders reads the result',
   v2c.indexOf("var st = (r && (r.status || (r.queued ? 'queued_offline' : ''))) || '';") > -1,
   'printReceipt RESOLVES on failure; discarding it turned failure into silence');
ck('failure is reported', V2.indexOf('The receipt did not print.') > -1);
ck('queued is NOT reported as success', V2.indexOf('the receipt is queued.') > -1);
ck('a thrown error is caught', v2c.indexOf("toast('Could not print: '") > -1);

head('6 - boundaries held');
ck('PrinterManager NOT removed from the service',
   PPS.indexOf('function _pm  () { return window.PrinterManager; }') > -1);
ck('cash-drawer audit path untouched',
   fs.readFileSync(path.join(ROOT, 'sokoni-printer-manager.js'), 'utf8')
     .indexOf('this.drawer.record(reason, user)') > -1);
ck('standalone POS keeps the local path',
   ppc.indexOf('const queued = this.queue.enqueue') > -1,
   '_framed() is false standalone, so the original behaviour runs unchanged');
ck('server-side provisioning predicate untouched',
   fs.readFileSync(path.join(ROOT, 'pos-printer-setup.html'), 'utf8')
     .indexOf("st.checklist.deviceRegistered") > -1,
   'Device completion must remain a provisioning fact, never a Bluetooth fact');

head('what this suite does NOT prove');
console.log('  UNPROVEN   that physical paper comes out   [needs the P58E]');
console.log('  UNPROVEN   cross-frame postMessage delivery in a real browser   [static analysis only]');

console.log('\n' + '-'.repeat(62));
console.log('  PASS ' + pass + '   FAIL ' + fail + '   HARNESS-INVALID ' + invalid);
process.exit((fail || invalid) ? 1 : 0);
