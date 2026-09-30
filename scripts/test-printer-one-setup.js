/* test-printer-one-setup.js — ONE saved printer for the whole merchant-v2 ecosystem; receipts, labels and chips
 * that report what actually happened.
 *
 *   node scripts/test-printer-one-setup.js          (no browser, no network)
 *
 * 2026-10-01 owner: "make sure the printer works across the whole merchant-v2 ecosystem — test print in POS setup,
 * barcode and price tag buttons in the uploader page, till/POS should print, chips should show and be synced to
 * diagnostics and be saved, and one setup is enough."
 *
 * Executes the REAL functions lifted from merchant-v2.html, sokoni-merchant-products.js and pos-setup.html against
 * stub engines, plus the real sokoni-till-registry.js. No new print engine is introduced (the ADR-0001 ratchet
 * suites stay the authority for that); every path here goes through PosPrintService / SokoniPrinter.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (!ok && d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 220) + ']' : '')); ok ? pass++ : fail++; };
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(70));
function lift(src, name) {
  const m = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(src); if (!m) throw new Error('lift failed: ' + name);
  const open = src.indexOf('{', m.index); let d = 0;
  for (let i = open; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}') { d--; if (d === 0) return src.slice(m.index, i + 1); } }
  throw new Error('unbalanced ' + name);
}
function memStorage(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

const MV2 = read('merchant-v2.html');
const PROD = read('sokoni-merchant-products.js');
const PS = read('pos-setup.html');

(async () => {
console.log('\nPRINTER — ONE SETUP ACROSS MERCHANT-V2');
console.log('='.repeat(70));

/* ── A. one saved printer (shell) ─────────────────────────────────────────── */
head('A — the shell adopts the engine pairing; newest record wins; real device id');
function shellBox(storage, uid) {
  const box = { localStorage: storage, S: { uid }, DEV: { printer: { state: 'unknown', name: null, saved: null, reason: '' }, list: [] },
    JSON, String, Date, console };
  vm.createContext(box);
  vm.runInContext("function devKey () { return 'sk_devices_' + (S.uid || 'anon'); }\n" + lift(MV2, '_enginePairing') + '\n' + lift(MV2, 'loadDevices'), box);
  return box;
}
const PAIR = JSON.stringify({ lastDevice: { id: 'BT-AA:BB', name: 'P58E', type: 'bluetooth' } });
let st = memStorage({ spp_profile: PAIR });
let b = shellBox(st, 'u1'); vm.runInContext('loadDevices()', b);
ck('a printer paired anywhere (engine spp_profile) is adopted as this merchant\'s saved printer', b.DEV.printer.saved && b.DEV.printer.saved.id === 'BT-AA:BB' && b.DEV.printer.state === 'saved', b.DEV.printer);
ck('…and persisted to sk_devices_<uid>, so every later page and reload sees it (one setup)', /BT-AA:BB/.test(st.getItem('sk_devices_u1') || ''), st.getItem('sk_devices_u1'));
st = memStorage({ spp_profile: PAIR });
b = shellBox(st, null); vm.runInContext('loadDevices()', b);
ck('a signed-out shell never adopts a pairing into the anonymous key', b.DEV.printer.saved === null && st.getItem('sk_devices_anon') === null);
st = memStorage({ spp_profile: PAIR, sk_devices_u1: JSON.stringify([{ type: 'printer', id: 'Printer', name: 'Printer' }, { type: 'printer', id: 'BT-NEW', name: 'Xprinter' }]) });
b = shellBox(st, 'u1'); vm.runInContext('loadDevices()', b);
ck('the MOST RECENT printer record wins (same rule as SokoniTillRegistry.first)', b.DEV.printer.saved && b.DEV.printer.saved.id === 'BT-NEW', b.DEV.printer.saved);
ck('connect saves the ENGINE device id, not the display name', /id: \(ep && ep\.id\) \|\| DEV\.printer\.name/.test(MV2) && !/saveDevice\(\{ type: 'printer', id: DEV\.printer\.name, name: DEV\.printer\.name, at: Date\.now\(\) \}\)/.test(MV2));

/* registry agreement: what POS setup saves, the shell reads */
const regCtx = { localStorage: memStorage({}), JSON, String, Date, Array, globalThis: null };
regCtx.globalThis = regCtx; vm.createContext(regCtx);
vm.runInContext(read('sokoni-till-registry.js'), regCtx);
regCtx.SokoniTillRegistry.save('u9', { type: 'printer', id: 'BT-1', name: 'P58E' });
b = shellBox(regCtx.localStorage, 'u9'); vm.runInContext('loadDevices()', b);
ck('a printer saved through SokoniTillRegistry (POS setup) is the printer the shell reads', b.DEV.printer.saved && b.DEV.printer.saved.id === 'BT-1');

/* ── B. chips ─────────────────────────────────────────────────────────────── */
head('B — chips name every state');
const chip = {}; const dom = {};
const pb = { DEV: { printer: {} }, S: { state: 'x' }, navigator: { onLine: true },
  setDot: (id, c) => { chip[id] = c; }, text: (id, t) => { dom[id] = t; }, _wirePrinterChip: () => {},
  merchantDisplayName: () => '', console };
vm.createContext(pb);
vm.runInContext(lift(MV2, 'paintStatus'), pb);
const paintAs = (p) => { pb.DEV.printer = p; vm.runInContext('paintStatus()', pb); return { dot: chip['st-print'], label: dom['st-print-t'], top: dom['top-print-t'] }; };
let r1 = paintAs({ state: 'connected', name: 'P58E' });
ck('connected → green dot and the printer\'s name', r1.dot === 'ok' && r1.label === 'P58E' && r1.top === 'P58E', r1);
r1 = paintAs({ state: 'needs-tap', saved: { id: 'x' } });
ck('needs-tap → amber "Tap to reconnect printer" (was grey "Printer")', r1.dot === 'warn' && /Tap to reconnect/.test(r1.label) && r1.top === 'Tap printer', r1);
r1 = paintAs({ state: 'reconnect-failed', saved: { id: 'x' } });
ck('reconnect-failed → red "Printer offline"', r1.dot === 'bad' && r1.label === 'Printer offline', r1);
r1 = paintAs({ state: 'unknown', saved: { id: 'x' } });
ck('a saved printer in an undetermined state still says "Printer saved", never a bare "Printer"', r1.label === 'Printer saved' && r1.top === 'Printer saved', r1);
r1 = paintAs({ state: 'unknown', saved: null });
ck('nothing paired → neutral "Printer"', r1.label === 'Printer' && r1.dot === '', r1);

/* ── C. receipts: premium doc, copies, real outcome ───────────────────────── */
head('C — receipts report what actually happened');
const ob = {}; vm.createContext(ob); vm.runInContext(lift(MV2, '_printOutcome'), ob);
const O = (r) => vm.runInContext('_printOutcome(' + JSON.stringify(r) + ')', ob);
ck('{success:true} → ok', O({ jobId: 'j', success: true }).ok === true);
ck('{queued:true} → NOT ok, queued (waits for the printer)', O({ jobId: 'j', queued: true }).ok === false && O({ queued: true }).queued === true);
ck('a queued job that ALSO says success:true is still NOT printed (the enterprise path can answer both)',
   O({ jobId: 'j', success: true, queued: true }).ok === false && O({ status: 'queued_offline', success: true }).ok === false);
ck('{status:"failed"} → NOT ok with the reason', O({ status: 'failed', fallback: true }).ok === false && O({ status: 'failed' }).error === 'failed');
ck('{status:"fallback_success"} → ok, marked as a fallback', O({ status: 'fallback_success', fallback: true }).ok === true && O({ status: 'fallback_success' }).fallback === true);
ck('{skipped:true} and nothing at all → NOT ok', O({ skipped: true }).ok === false && O(null).ok === false);

const calls = [];
const toasts = [];
const rb = { printerEngine: () => Promise.resolve({ printReceipt: (order, opts) => { calls.push({ order, opts }); return Promise.resolve(rb.__next.shift() || { success: true }); } }),
  toast: (m) => toasts.push(m), paintStatus: () => {}, Promise, Math, Number, Object, __next: [] };
vm.createContext(rb);
vm.runInContext(lift(MV2, '_printOutcome') + '\n' + lift(MV2, '_shellPrintReceipt'), rb);
const DOC = { blocks: [{ type: 'closing' }] };
let out = await vm.runInContext('_shellPrintReceipt', rb)({ id: 'r1' }, DOC);
ck('Sell: the composed SokoniReceiptDoc reaches printReceipt (useDoc) — the premium layout POS setup previews', calls[0] && calls[0].opts.useDoc === true && calls[0].opts.doc === DOC && out.ok === true, calls[0] && calls[0].opts);
calls.length = 0; rb.__next = [{ success: true }, { success: true }, { success: true }];
out = await vm.runInContext('_shellPrintReceipt', rb)({ text: 't', order: { id: 'o1' }, copies: 3, includeQr: true });
ck('Receipts: {order, copies:3} prints the ORDER three times and answers ok (was a false "did not print")', calls.length === 3 && calls.every((c) => c.order.id === 'o1') && out.ok === true, { n: calls.length, out });
calls.length = 0; rb.__next = [{ success: true }, { status: 'failed' }, { success: true }];
out = await vm.runInContext('_shellPrintReceipt', rb)({ order: { id: 'o2' }, copies: 3 });
ck('Receipts: a failure on copy 2 stops there and reports failure — never "3 copies printed"', calls.length === 2 && out.ok === false, { n: calls.length, out });
calls.length = 0; toasts.length = 0; rb.__next = [{ queued: true }];
out = await vm.runInContext('_shellPrintReceipt', rb)({ id: 'r3' });
ck('Sell: a queued receipt is announced as queued, not printed', out.ok === false && out.queued === true && /queued/.test(toasts.join(' ')), toasts);
ck('Sell and Receipts share the one shell path', /onPrint: function \(job, doc\) \{ return _shellPrintReceipt\(job, doc\); \},/.test(MV2) && /onPrint: _ctx\(\)\.onPrint,/.test(MV2));
const RC = read('sokoni-merchant-receipts.js');
ck('Receipts reads res.ok — which the shell now provides', /var okd = res && res\.ok === true;/.test(RC) && /return \{ ok: ok, queued: queued/.test(MV2));

/* ── D. labels ────────────────────────────────────────────────────────────── */
head('D — price tags and barcode labels print on the shell printer');
const printed = [];
function labelBox(connected, saved, throws) {
  const lb = { window: { SokoniPrinter: { connected, printNow: (t, d) => { if (throws) return Promise.reject(new Error('paper out')); printed.push({ t, d }); return Promise.resolve(); } } },
    DEV: { printer: { saved: saved ? { id: 's' } : null } }, printerEngine: () => Promise.resolve({ autoReconnect: () => Promise.resolve(false) }),
    paintStatus: () => {}, String, Number, isFinite, Promise, console };
  vm.createContext(lb); vm.runInContext(lift(MV2, '_printLabel'), lb);
  return (k, p) => vm.runInContext('_printLabel', lb)(k, p);
}
let L = labelBox(true, true);
let lr = await L('price', { name: 'Sugar 1kg', price: 180, sku: 'SUG1', specs: { barcode: '6161234567890' } });
ck('price tag → engine label document: name, price, SKU, barcode', lr.ok === true && printed[0].t === 'label' && printed[0].d.productName === 'Sugar 1kg' && printed[0].d.price === 180 && printed[0].d.sku === 'SUG1' && printed[0].d.barcode === '6161234567890', printed[0]);
lr = await L('barcode', { name: 'Sugar 1kg', barcode: '6161234567890' });
ck('barcode label → name + barcode only', lr.ok === true && printed[1].d.barcode === '6161234567890' && printed[1].d.price === undefined);
lr = await L('barcode', { name: 'No code' });
ck('barcode label for a product with no barcode → a clear "add a barcode" answer, nothing printed', lr.ok === false && lr.reason === 'no_barcode' && printed.length === 2);
lr = await L('price', { name: 'Blank price', price: '' });
ck('a blank price is omitted, never printed as KES 0', printed[2] && printed[2].d.price === null, printed[2]);
L = labelBox(false, true); lr = await L('price', { name: 'x', price: 1 });
ck('saved but not connected → "tap the printer chip", nothing queued', lr.ok === false && lr.reason === 'no_printer' && /Tap the printer chip/.test(lr.message));
L = labelBox(false, false); lr = await L('price', { name: 'x', price: 1 });
ck('never set up → "pair one in POS Setup"', lr.ok === false && /POS Setup/.test(lr.message));
L = labelBox(true, true, true); lr = await L('price', { name: 'x', price: 1 });
ck('a printer error is reported with its reason', lr.ok === false && /paper out/.test(lr.message));
ck('Products is handed the label service', /printLabel: function \(kind, product\) \{ return _printLabel\(kind, product\); \},/.test(MV2));
ck('the card menu has Print price tag and Print barcode label', /data-pr="label-price" data-i="' \+ i \+ '">🏷️ Print price tag/.test(PROD) && /data-pr="label-barcode" data-i="' \+ i \+ '">▦ Print barcode label/.test(PROD));
ck('the uploader form has both buttons under the Barcode field', /fld\('spec\.barcode'[^\n]*\n[\s\S]{0,300}data-pr="label-price-form"[\s\S]{0,200}data-pr="label-barcode-form"/.test(PROD));
ck('form labels print what the form shows now (captureForm → fieldsFromForm)', /k === 'label-price-form' \|\| k === 'label-barcode-form'\) \{\s*captureForm\(\);\s*var ff = fieldsFromForm\(\);/.test(PROD));
/* the module helper, executed */
const said = []; let asked = null;
const pm = { ctx: { printLabel: (k, p) => { asked = { k, p }; return Promise.resolve({ ok: false, message: 'No printer is set up. Pair one in POS Setup › Receipt, then print again.' }); } },
  say: (m) => said.push(m), Promise };
vm.createContext(pm);
vm.runInContext('var _labelBusy = false;\n' + lift(PROD, 'printLabelFor'), pm);
await vm.runInContext('printLabelFor', pm)('price', { name: 'x' });
ck('the module shows the shell\'s answer, never "printed" on a refusal', asked && asked.k === 'price' && said.some((m) => /POS Setup/.test(m)) && !said.some((m) => /Price tag printed/.test(m)), said);

/* ── E. POS setup ─────────────────────────────────────────────────────────── */
head('E — POS setup saves where every surface looks; one paper size; completion; Diagnostics chip');
const reg2 = { localStorage: memStorage({ spp_profile: PAIR }), JSON, String, Date, Array, globalThis: null };
reg2.globalThis = reg2; vm.createContext(reg2);
vm.runInContext(read('sokoni-till-registry.js'), reg2);
const psb = { localStorage: reg2.localStorage, window: { SokoniTillRegistry: reg2.SokoniTillRegistry, SokoniPrinter: { connected: true } },
  _auth: { currentUser: { uid: 'u7' } }, _shellPrinter: { connected: false, name: null }, JSON, String };
vm.createContext(psb);
vm.runInContext(lift(PS, '_uidNow') + '\n' + lift(PS, '_printerConnected') + '\n' + lift(PS, '_savePrinterRecord') + '\n' + lift(PS, '_printerTruth'), psb);
const rec = vm.runInContext('_savePrinterRecord()', psb);
ck('after connecting, the engine pairing is saved into the till registry (sk_devices_<uid>)', rec && rec.state === 'connected' && /BT-AA:BB/.test(reg2.localStorage.getItem('sk_devices_u7') || ''), reg2.localStorage.getItem('sk_devices_u7'));
b = shellBox(reg2.localStorage, 'u7'); vm.runInContext('loadDevices()', b);
ck('…and the merchant shell reads that same printer — ONE setup', b.DEV.printer.saved && b.DEV.printer.saved.id === 'BT-AA:BB');
psb.window.SokoniPrinter.connected = false;
ck('Diagnostics truth: paired but not answering → saved (chip "needs attention")', vm.runInContext('_printerTruth()', psb).state === 'saved');
ck('Diagnostics chip maps connected / saved / none → done / attention / pending', /diagnostics: \(function \(\) \{ try \{ const t = _printerTruth\(\); return t\.state === 'connected' \? 'done' : t\.state === 'saved' \? 'attention' : 'pending';/.test(PS));
ck('paper size sets BOTH the engine (spp_config) and the till (pps_till_config)', /function _setPaperWidth\(w\) \{[\s\S]{0,700}sp\.setConfig\(\{ paperWidth: w \}\)[\s\S]{0,300}t\.update\('default', \{ paperWidth: w \}\)/.test(PS));
ck('setup completion is recorded in the registry the shell reads', /window\.SokoniTillRegistry\.markSetupComplete\(_uidNow\(\), \{ branchId \}\)/.test(PS));
ck('the test print still uses the ONE print service with the premium document', /svc\.printReceipt\(Object\.assign\(\{ id: 'sample_' \+ Date\.now\(\) \}, _sampleInput\(\)\),\s*\{ __fromShell: true, sample: true, useDoc: true, doc \}\)/.test(PS));
ck('a silent reconnect during test print is recorded too', /if \(connected\) \{ try \{ _savePrinterRecord\(\); _paintChips\(\); \} catch \(_\) \{\} \}/.test(PS));

/* shell POS route accepts every completion record */
const gate = /var _posReady = null;[\s\S]*?\} catch \(_\) \{ _posReady = null; \}/.exec(MV2);
const gb = { localStorage: null, S: { uid: 'u7' }, JSON };
const ready = (store) => { gb.localStorage = memStorage(store); vm.createContext(gb); vm.runInContext(gate[0] + '; this.__r = _posReady;', gb); return !!gb.__r; };
ck('POS route: posSetupComplete (wizard) → ready', ready({ posSetupComplete: '1' }));
ck('POS route: sokoni_setup_complete (POS setup) → ready (was sent to the wizard again)', ready({ sokoni_setup_complete: '1' }));
ck('POS route: sk_pos_setup_<uid> registry record → ready', ready({ sk_pos_setup_u7: JSON.stringify({ complete: true }) }));
ck('POS route: nothing → not ready (setup still required)', !ready({}));

/* ── F. no new engine ─────────────────────────────────────────────────────── */
head('F — no new print engine, no new storage key');
const addedGlobals = [MV2, PROD, PS].map((s2) => (s2.match(/window\.[A-Z][A-Za-z]+Print[A-Za-z]*\s*=/g) || []).join(','));
ck('no new window.*Print* global assigned by these files', addedGlobals.every((g) => !/SokoniLabel|NewPrinter/.test(g)), addedGlobals);
ck('labels use the engine\'s existing "label" document', /sp\.printNow\('label', data, \{ copies: 1 \}\)/.test(MV2) && /label: this\.label/.test(read('sokoni-universal-printer.js')));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e && e.stack || e); process.exit(2); });
