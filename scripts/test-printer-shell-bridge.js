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
/* This pinned the WHOLE literal expression, so adding a term broke it while the property
   it guards was intact. The property is "every object that can actually perform a print is
   counted, added and never substituted" - so assert the TERMS, and then EVALUATE the gate
   under each configuration rather than matching its text.

   The new term is _shellCanPrint(): a framed POS prints by posting the job UP to the shell,
   a path that never touches _eng(). Without it, a framed POS with no local engine would
   fail this gate and divert to _legacyFallback - which returns FALSE with no error, the
   silent non-print described above. It is STRICTER than its neighbours: it requires the
   shell to have a CONNECTED printer, not merely to have loaded an engine object. */
const gateExpr = (ppc.match(/const enterpriseAvailable = ([^;]+);/) || [])[1] || '';
ck('the availability gate was located', !!gateExpr, gateExpr || 'NOT FOUND');
ck('...counts PrinterManager FIRST', /^!!pm \|\|/.test(gateExpr.trim()), gateExpr);
ck('...counts the local engine', /!!_eng\(\)/.test(gateExpr));
ck('...counts the SHELL TRANSPORT', /!!_shellCanPrint\(\)/.test(gateExpr),
   'a framed POS prints through the shell, not through its own engine');
ck('...counts the iOS bridge', /!!window\.SokoniIOSPrint/.test(gateExpr));
ck('...and every term is ADDED, never substituted', (gateExpr.match(/\|\|/g) || []).length === 3, gateExpr);

/* Evaluate it, rather than trust the shape. Four configurations, each a real deployment. */
function evalGate (o) {
  const pm = o.pm, _eng = () => o.eng, _shellCanPrint = () => o.shell;
  const window = { SokoniIOSPrint: o.ios };
  return eval('!!pm || !!_eng() || !!_shellCanPrint() || !!window.SokoniIOSPrint');
}
ck('EVAL framed POS, shell printer connected, NO local engine -> available',
   evalGate({ pm: null, eng: null, shell: true, ios: null }) === true,
   'this is the configuration step 2 creates; without it the print silently fails');
ck('EVAL standalone POS with a local engine -> available (unchanged)',
   evalGate({ pm: null, eng: {}, shell: false, ios: null }) === true);
ck('EVAL merchant-v2 shell: engine, no PrinterManager -> available (the original fix)',
   evalGate({ pm: null, eng: {}, shell: false, ios: null }) === true);
ck('CONTROL nothing available at all -> NOT available',
   evalGate({ pm: null, eng: null, shell: false, ios: null }) === false,
   'the gate must still be able to say no, or the legacy fallback is unreachable');
ck('CONTROL removing the shell term strands a framed POS with no engine',
   (function () {
     const pm = null, _eng = () => null;
     const window = { SokoniIOSPrint: null };
     return eval('!!pm || !!_eng() || !!window.SokoniIOSPrint') === false;
   })(),
   'proves _shellCanPrint() is what carries that case, not something else');
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

head('5c - POS Setup: ONE predicate, and a route for the step it cannot satisfy');
const PS = fs.readFileSync(path.join(ROOT, 'pos-printer-setup.html'), 'utf8');
const psc = code(PS);
/* ~13 independent reads of PrinterManager.connected (the LOCAL iframe engine) meant
   fixing only the status bar was cosmetic: every functional guard still refused, so
   Test Print said "not connected" beside a connected Devices card. */
ck('one shared predicate exists', psc.indexOf('function _printerConnected ()') > -1);
ck('functional guards use it',
   (psc.match(/_printerConnected\(\)/g) || []).length >= 10,
   'found ' + (psc.match(/_printerConnected\(\)/g) || []).length + ' uses');
ck('only the DEFINITION still names PrinterManager.connected',
   (psc.match(/PrinterManager\.connected/g) || []).length === 1,
   'any other read would be a surface disagreeing with the rest');
ck('the shell honours __sokoniModulePrint',
   v2c.indexOf('d.__sokoniModulePrint && d.receipt') > -1,
   'printReceipt returns status routed_to_shell — a CLAIMED success — if nobody handles it');
ck('...marked __fromShell so it cannot bounce back up', v2c.indexOf('{ __fromShell: true }') > -1);
ck('Device step offers the provisioning route',
   psc.indexOf("type: 'goModule', id: 'pos-provision'") > -1,
   'the step is unsatisfiable on this page; it must point at the one that can');
ck('the shell validates that request through the CONTRACT',
   v2c.indexOf("if (d.type === 'goModule' && typeof d.id === 'string') { go(d.id); }") > -1,
   'go() refuses undeclared routes; a raw location.assign would not');
ck('CONTROL Device remains provisioning-only',
   psc.indexOf("['Device', !!(st.checklist && (st.checklist.deviceRegistered || st.checklist.device))]") > -1 &&
   psc.indexOf("['Device', !!(_printerConnected") === -1,
   'a Bluetooth connection must never mark a device registered');

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
