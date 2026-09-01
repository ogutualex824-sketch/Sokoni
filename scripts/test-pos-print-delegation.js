#!/usr/bin/env node
/**
 * POS → SHELL PRINT DELEGATION, and Till Setup's view of the printer.
 *
 *   node scripts/test-pos-print-delegation.js
 *
 * THREE DEFECTS, all of which made a receipt that never printed look identical to one
 * that came out on paper:
 *
 *   1. THE FRAMED POS CLAIMED SUCCESS. printReceipt/smartPrint posted the receipt up to
 *      the shell and returned status:'routed_to_shell' immediately. postMessage()
 *      returning proves the browser accepted a message — nothing about whether a printer
 *      existed, accepted the job, or produced paper.
 *
 *   2. THE SHELL NEVER ANSWERED. It printed, toasted its own result, and sent nothing
 *      back, so the frame could not have learned the outcome even if it had waited.
 *
 *   3. SALE COMPLETION IGNORED THE RESULT. Only .catch() was handled; a promise
 *      RESOLVING with status 'failed' or 'unknown' was treated as a success.
 *
 * And Till Setup was the ONLY POS surface not listening for the shell's printer state,
 * so a merchant with a connected P58E was still sent back to configure a printer.
 *
 * The boundary that must survive all of this: ONE printer authority — the shell. The
 * framed POS must never acquire its own Bluetooth/GATT.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);
const SHELL = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');
const SVC   = fs.readFileSync(path.join(ROOT, 'sokoni-pos-print-service.js'), 'utf8');
const POSJS = fs.readFileSync(path.join(ROOT, 'pos.js'), 'utf8');
const SETUP = fs.readFileSync(path.join(ROOT, 'pos-setup.html'), 'utf8');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 96) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log(NL + t);

console.log(NL + 'POS PRINT DELEGATION + TILL SETUP' + NL + '='.repeat(62));

/* ── 1 · one printer authority ────────────────────────────────────────────── */
head('1 · one printer authority — the shell');
(function () {
  const m = SHELL.match(/MODULE_ALLOW = '([^']*)'/);
  const allow = m ? m[1] : null;
  ck('the framed POS is not granted bluetooth / usb / serial',
     !!allow && !/bluetooth|usb|serial/i.test(allow), allow);
})();
ck('the framed POS delegates rather than printing locally',
   SVC.indexOf('_printViaShell') > -1 && /window\.parent !== window/.test(SVC));
ck('the shell holds the print service',
   SHELL.indexOf('window.PosPrintService') > -1 && SHELL.indexOf('__fromShell: true') > -1,
   '__fromShell stops the shell bouncing its own job back up');
ck('CONTROL the service still prints locally when NOT framed',
   SVC.indexOf('const jobId =') > -1,
   'standalone POS must keep working; this is delegation, not removal');

/* ── 2 · the request is answered ──────────────────────────────────────────── */
head('2 · the shell answers the frame that asked');
ck('the shell replies with a result message',
   SHELL.indexOf('__sokoniModulePrintResult') > -1);
ck('...keyed by the jobId it was given', SHELL.indexOf('jobId: jobId') > -1,
   'two receipts in flight must not resolve each other');
ck('...to the frame that asked, not broadcast',
   SHELL.indexOf('e.source') > -1 && /src\.postMessage/.test(SHELL));
ck('a missing print service is REPORTED, not silent',
   /No printer service is loaded[\s\S]{0,160}reply\('failed'/.test(SHELL));
ck('a print rejection is reported with its real message',
   /\.catch\(function \(err\)[\s\S]{0,200}reply\('failed', m\)/.test(SHELL));

/* ── 3 · the frame waits, and never invents a success ─────────────────────── */
head('3 · the frame waits for the answer');
ck('no claimed-success return survives',
   (SVC.match(/status: 'routed_to_shell'/g) || []).length === 0,
   'the old code returned this the instant postMessage returned');
ck('both delegation sites await', (SVC.match(/return this\._printViaShell\(order\);/g) || []).length === 2,
   'printReceipt AND smartPrint');
ck('the listener is removed once settled',
   SVC.indexOf("window.removeEventListener('message', onMsg)") > -1,
   'a leaked listener per receipt is a slow failure on a till open all day');
ck('a reply for a DIFFERENT job is ignored',
   SVC.indexOf("d.jobId !== jobId") > -1);
ck('a timeout resolves UNKNOWN — not success, not failure',
   /setTimeout\([\s\S]{0,200}status: 'unknown'/.test(SVC));
ck('CONTROL an unknown result is never auto-retried',
   SVC.indexOf('retried automatically') > -1 &&
   POSJS.indexOf('NEVER auto-reprint here') > -1,
   'the job may already be on paper; a duplicate receipt for one sale is its own defect');

/* ── 3b · the handshake, EXECUTED ─────────────────────────────────────────── */
head('3b · the real _printViaShell, run against every outcome');
(function () {
  /* Lift the method out of the class and drive it with a fake window and a clock we
     control, so the 20s timeout is provable without waiting 20 seconds. */
  const i = SVC.indexOf('  _printViaShell (order) {');
  let d = 0, started = false, end = -1;
  for (let k = i; k < SVC.length; k++) {
    const c = SVC[k];
    if (c === '{') { d++; started = true; }
    else if (c === '}') { d--; if (started && d === 0) { end = k + 1; break; } }
  }
  const src = SVC.slice(i, end).replace('_printViaShell (order) {', 'function _printViaShell (order) {');
  ck('the method was extracted', end > i, (end - i) + ' chars');

  function drive (mode) {
    let listener = null, sent = null, timerFn = null;
    const sb = {
      receiptIdOf: () => 'R1',
      Math, Date, Promise, console,
      setTimeout: (fn) => { timerFn = fn; return 1; },
      clearTimeout: () => { timerFn = null; },
      window: {
        addEventListener: (t, fn) => { if (t === 'message') listener = fn; },
        removeEventListener: () => { listener = null; },
        parent: { postMessage: (m) => { sent = m; if (mode === 'throw') throw new Error('gone'); } },
      },
      location: { origin: 'https://x' },
    };
    vm.createContext(sb);
    vm.runInContext(src + '; var P = _printViaShell({ id: 1 });', sb);
    if (mode === 'ok')     listener({ data: { __sokoniModulePrintResult: true, jobId: sent.jobId, status: 'printed' } });
    if (mode === 'fail')   listener({ data: { __sokoniModulePrintResult: true, jobId: sent.jobId, status: 'failed', error: 'no paper' } });
    if (mode === 'other')  listener({ data: { __sokoniModulePrintResult: true, jobId: 'SOMEONE-ELSE', status: 'printed' } });
    if (mode === 'timeout' || mode === 'other') { if (timerFn) timerFn(); }
    return { p: sb.P, sent, hasListener: () => listener !== null };
  }

  return Promise.all([
    drive('ok'), drive('fail'), drive('timeout'), drive('other'), drive('throw'),
  ].map((r) => r.p.then((v) => v))).then((res) => {
    ck('a printed reply resolves printed', res[0].status === 'printed', JSON.stringify(res[0]));
    ck('a failure reply resolves failed AND carries the reason',
       res[1].status === 'failed' && res[1].error === 'no paper', JSON.stringify(res[1]));
    ck('no reply resolves UNKNOWN, never printed',
       res[2].status === 'unknown', JSON.stringify(res[2]));
    ck('CONTROL a reply for another job does NOT resolve this one',
       res[3].status === 'unknown',
       'it fell through to the timeout, which is correct — it must not steal another jobs result');
    ck('a postMessage that throws resolves failed, never hangs',
       res[4].status === 'failed', JSON.stringify(res[4]));
    ck('CONTROL every outcome carries the jobId that was sent',
       res.every((r) => typeof r.jobId === 'string' && r.jobId.indexOf('shell:') === 0));
    return true;
  });
})().then(function () {

/* ── 4 · the cashier is told ──────────────────────────────────────────────── */
head('4 · a receipt that did not print is SAID');
ck('sale completion inspects the resolved status',
   /printReceipt\(receiptData[\s\S]{0,400}\.then\(\(r\) =>/.test(POSJS));
ck('a failure is surfaced', /st === 'failed'[\s\S]{0,140}did NOT print/.test(POSJS));
ck('a queued receipt is surfaced', /queued_offline[\s\S]{0,140}receipt queued/.test(POSJS));
ck('an unknown result is surfaced as unknown',
   POSJS.indexOf("st === 'unknown'") > -1 && POSJS.indexOf('did not confirm') > -1,
   'not as success, and not as failure');
ck('CONTROL the sale still completes regardless',
   POSJS.indexOf('settlement is decoupled') > -1,
   'a printer must never hold up money that is already settled');
ck('CONTROL the last-ditch fallback is still there',
   /\.catch\(\(\) => \{ \/\* service already falls back internally/.test(POSJS));

/* ── 5 · Till Setup sees the shell's printer ──────────────────────────────── */
head('5 · Till Setup must not re-ask for a printer that is connected');
ck('Setup listens to the shell printer state',
   SETUP.indexOf('__sokoniPrinterState') > -1,
   'it was the ONLY POS surface that did not');
ck('...and it is the SHELL state, not a local pairing flag',
   SETUP.indexOf('application-level connection') > -1);
/* Assert the PROPERTY, not the expression. This pinned the literal
   `t.key === 'hardwareConnected' && _shellPrinter.connected`, so routing the decision
   through the canonical device registry failed a rewrite that FIXED a real defect
   (Devices said saved while Till Setup said no printer). The behaviour that must hold
   is unchanged: a live connection is offered for recording instead of the wizard. */
ck('a connected printer replaces the wizard button',
   SETUP.indexOf('_pr.connected') > -1 && SETUP.indexOf('_tillPrinter()') > -1,
   'resolved through the registry, which still takes connected from the shell alone');
ck('...and a SAVED printer offers reconnection rather than the wizard',
   SETUP.indexOf('_pr.needsReconnect') > -1,
   'a paired printer must never be presented as though none was ever set up');
ck('...and marking it is still an explicit merchant tap',
   /data-mark="hardwareConnected"/.test(SETUP),
   'connected is a precondition for offering, never an automatic completion');
ck('CONTROL with no printer, the hardware wizard is still offered',
   /} else if \(t\.primary\) \{/.test(SETUP),
   'the original path must survive for a merchant who has no printer yet');
ck('CONTROL Bluetooth pairing alone cannot mark the step',
   SETUP.indexOf('Bluetooth pairing alone must not') > -1);

/* ── 6 · everything converges on one connection ───────────────────────────── */
head('6 · every POS surface reads the same connection');
['pos.html', 'pos-printer-setup.html', 'pos-setup.html'].forEach((f) => {
  let src = '';
  try { src = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) {}
  ck(f + ' consumes the shell printer state', src.indexOf('__sokoniPrinterState') > -1);
});

  console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
