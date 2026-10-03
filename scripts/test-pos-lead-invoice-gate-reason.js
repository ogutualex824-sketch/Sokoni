#!/usr/bin/env node
'use strict';
/* ============================================================================
   POS gate — the B2B lead invoice is a SECOND REASON in the ONE gate (owner 2026-10-03; 2f owns producer + consumer)
     G1  b2b-leads.js not in the assembled tree → leadInvoice.state 'not_assembled'; gate unaffected; no crash
     G2  producer says overdue → its own card (state overdue, KES, keys); NOT enforced → gate open, assertGateOpen passes
     G3  producer throws → 'unreadable'; not enforced → gate open
     G4  with LEAD_INVOICE_GATE_ENFORCED switched on (the certified Pay Now unit): overdue closes with POS_GATE_LEAD_INVOICE;
         unreadable closes (fail closed); clear stays open; the commission reason still wins when both apply
     G5  ONE switch: the sale rails still call enforceSaleGate only; the lead flag is off in the shipped file
   NODE_PATH=<functions/node_modules> node scripts/test-pos-lead-invoice-gate-reason.js
   ============================================================================ */
const path = require('path'), fs = require('fs'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const RAIL = path.join(FN, 'pos-commission-rail.js');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 240) : '')); } };

const NOW = Date.parse('2026-11-05T09:00:00Z');
let LEAD = 'absent';   /* 'absent' | 'overdue' | 'clear' | 'throw' */
let LIAB = [];         /* outstanding commission rows */
const db = { collection: () => ({ where () { return this; }, limit () { return this; },
  async get () { return { docs: LIAB.map((x, i) => ({ id: 'L' + i, data: () => x })) }; } }) };

const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === './b2b-leads') {
    if (LEAD === 'absent') { const e = new Error("Cannot find module './b2b-leads'"); e.code = 'MODULE_NOT_FOUND'; throw e; }
    return { leadInvoiceGate: async () => {
      if (LEAD === 'throw') throw new Error('unreadable');
      return LEAD === 'overdue' ? { overdue: true, overdueKES: 696, invoiceKeys: ['supA__2026-10'], since: NOW - 3600000, enforce: false }
        : { overdue: false, overdueKES: 0, invoiceKeys: [], since: null, enforce: false };
    } };
  }
  if (id === 'firebase-admin') return { apps: [1], initializeApp () {}, firestore: Object.assign(() => db, { FieldValue: { serverTimestamp: () => 'TS', increment: (n) => n }, Timestamp: { now: () => ({ toMillis: () => NOW }) } }) };
  if (id === 'firebase-functions/logger') return { info () {}, warn () {}, error () {} };
  return orig.apply(this, arguments);
};
function loadRail (enforced) {
  let src = fs.readFileSync(RAIL, 'utf8');
  if (enforced) src = src.replace('const LEAD_INVOICE_GATE_ENFORCED = false;', 'const LEAD_INVOICE_GATE_ENFORCED = true;');
  const m = new Module(RAIL, module); m.filename = RAIL; m.paths = Module._nodeModulePaths(FN);
  m._compile(src, RAIL);
  return m.exports;
}
const caught = async (p) => { try { await p; return null; } catch (e) { return e.code || e.message; } };

(async () => {
  let R = loadRail(false);
  LEAD = 'absent';
  let g = await R.evaluateMerchantGate(db, 'uidA', NOW);
  ck('G1 module not assembled → leadInvoice not_assembled; gate open; no crash', g.leadInvoice.state === 'not_assembled' && g.closed === false && g.closedBy === null, g.leadInvoice);
  LEAD = 'overdue';
  g = await R.evaluateMerchantGate(db, 'uidA', NOW);
  ck('G2 overdue → its own card (state overdue, 696, keys) but NOT enforced: gate open, assertGateOpen passes',
    g.leadInvoice.state === 'overdue' && g.leadInvoice.overdueKES === 696 && g.leadInvoice.invoiceKeys[0] === 'supA__2026-10' && g.leadInvoice.enforce === false
    && g.closed === false && (await caught(R.assertGateOpen(db, 'uidA', NOW))) === null, g.leadInvoice);
  LEAD = 'throw';
  g = await R.evaluateMerchantGate(db, 'uidA', NOW);
  ck('G3 producer unreadable → state unreadable; not enforced → open', g.leadInvoice.state === 'unreadable' && g.closed === false);

  R = loadRail(true);
  LEAD = 'overdue';
  ck('G4a ENFORCED: overdue lead invoice closes the till with POS_GATE_LEAD_INVOICE', (await caught(R.assertGateOpen(db, 'uidA', NOW))) === 'POS_GATE_LEAD_INVOICE');
  LEAD = 'throw';
  ck('G4b ENFORCED: an unreadable lead state closes (fail closed)', (await R.evaluateMerchantGate(db, 'uidA', NOW)).closed === true);
  LEAD = 'clear';
  ck('G4c ENFORCED: clear stays open', (await caught(R.assertGateOpen(db, 'uidA', NOW))) === null);
  LEAD = 'absent';
  ck('G4d ENFORCED but module not assembled: not a lead-invoice closure (assembly check owns that)', (await R.evaluateMerchantGate(db, 'uidA', NOW)).closedBy !== 'lead_invoice');

  const SRC = fs.readFileSync(RAIL, 'utf8');
  const ZF = fs.readFileSync(path.join(FN, 'pos-zero-friction.js'), 'utf8');
  ck('G5 shipped flag is OFF; the sale rail still calls the ONE switch (enforceSaleGate), never the lead reason directly',
    /const LEAD_INVOICE_GATE_ENFORCED = false;/.test(SRC) && /enforceSaleGate\(/.test(ZF) && !/leadInvoiceGate/.test(ZF));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
