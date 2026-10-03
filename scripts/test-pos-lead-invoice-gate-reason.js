#!/usr/bin/env node
'use strict';
/* ============================================================================
   POS gate — the B2B lead invoice is a SECOND REASON in the ONE gate (owner 2026-10-03; 2f owns producer + consumer)
     S1  the shared predicate (shared/lead-invoice-gate.js, byte-identical on the commercial line): issued > 2 days and
         outstanding → overdue; fresh / paid / never-issued / another supplier's → not
     G1  no lead invoices → card state 'clear'; gate open
     G2  overdue → its own card (state overdue, KES, keys); NOT enforced → gate open, assertGateOpen passes
     G3  predicate throws → 'unreadable'; not enforced → gate open
     G4  with LEAD_INVOICE_GATE_ENFORCED switched on (the certified Pay Now unit): overdue closes with POS_GATE_LEAD_INVOICE;
         unreadable closes (fail closed); clear stays open
     G5  ONE switch: the sale rails still call enforceSaleGate only; the lead flag is off in the shipped file; no optional
         require (the deploy require-closure gate refuses a module absent from the tree)
   NODE_PATH=<functions/node_modules> node scripts/test-pos-lead-invoice-gate-reason.js
   ============================================================================ */
const path = require('path'), fs = require('fs'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const RAIL = path.join(FN, 'pos-commission-rail.js');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 240) : '')); } };

const NOW = Date.parse('2026-11-05T09:00:00Z'), DAY = 86400000;
let MONTHS = {};       /* b2bLeadMonths docs */
let THROW = false;
const db = { collection: (c) => {
  const q = (filters) => ({ where: (f, op, v) => q(filters.concat([[f, v]])), limit () { return this; },
    async get () {
      if (c === 'b2bLeadMonths' && THROW) throw new Error('unreadable');
      const src = c === 'b2bLeadMonths' ? MONTHS : {};
      const rows = Object.entries(src).filter(([, d]) => filters.every(([f, v]) => d[f] === v));
      return { docs: rows.map(([id, d]) => ({ id, data: () => d })) };
    } });
  return q([]);
} };
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
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
const inv = (uid, out, issuedAtMs, status) => ({ billToUid: uid, status: status || 'issued', outstandingKES: out, issuedAtMs });

(async () => {
  const LIG = require(path.join(FN, 'shared', 'lead-invoice-gate.js'));
  MONTHS = { 'supA__2026-09': inv('uidA', 300, NOW - 3 * DAY), 'supA__2026-10': inv('uidA', 696, NOW - DAY),
    'supA__2026-08': inv('uidA', 0, NOW - 60 * DAY, 'paid'), 'supA__2026-07': { billToUid: 'uidA', status: 'failed' }, 'supB__2026-09': inv('uidB', 999, NOW - 9 * DAY) };
  const s = await LIG.evaluate(db, 'uidA', NOW);
  ck('S1 shared predicate: only the invoice issued > 2 days ago and unpaid (300) is overdue; fresh / paid / failed / other supplier are not',
    s.overdue && s.overdueKES === 300 && s.invoiceKeys.join() === 'supA__2026-09' && s.since === NOW - DAY && s.enforce === false, s);

  let R = loadRail(false);
  MONTHS = {};
  let g = await R.evaluateMerchantGate(db, 'uidA', NOW);
  ck('G1 no lead invoices → card clear; gate open', g.leadInvoice.state === 'clear' && g.closed === false && g.closedBy === null, g.leadInvoice);
  MONTHS = { 'supA__2026-10': inv('uidA', 696, NOW - 3 * DAY) };
  g = await R.evaluateMerchantGate(db, 'uidA', NOW);
  ck('G2 overdue → its own card (state overdue, 696, keys) but NOT enforced: gate open, assertGateOpen passes',
    g.leadInvoice.state === 'overdue' && g.leadInvoice.overdueKES === 696 && g.leadInvoice.invoiceKeys[0] === 'supA__2026-10' && g.leadInvoice.enforce === false
    && g.closed === false && (await caught(R.assertGateOpen(db, 'uidA', NOW))) === null, g.leadInvoice);
  THROW = true;
  g = await R.evaluateMerchantGate(db, 'uidA', NOW);
  ck('G3 predicate unreadable → state unreadable; not enforced → open', g.leadInvoice.state === 'unreadable' && g.closed === false);
  THROW = false;

  R = loadRail(true);
  ck('G4a ENFORCED: overdue lead invoice closes the till with POS_GATE_LEAD_INVOICE', (await caught(R.assertGateOpen(db, 'uidA', NOW))) === 'POS_GATE_LEAD_INVOICE');
  THROW = true;
  ck('G4b ENFORCED: an unreadable lead state closes (fail closed)', (await R.evaluateMerchantGate(db, 'uidA', NOW)).closed === true);
  THROW = false; MONTHS = { 'supA__2026-10': inv('uidA', 696, NOW - DAY) };
  ck('G4c ENFORCED: a fresh (< 2 days) invoice stays open', (await caught(R.assertGateOpen(db, 'uidA', NOW))) === null);

  const SRC = fs.readFileSync(RAIL, 'utf8');
  const ZF = fs.readFileSync(path.join(FN, 'pos-zero-friction.js'), 'utf8');
  ck('G5 shipped flag OFF; sale rail calls only enforceSaleGate; no optional require of b2b-leads',
    /const LEAD_INVOICE_GATE_ENFORCED = false;/.test(SRC) && /enforceSaleGate\(/.test(ZF) && !/leadInvoiceGate|lead-invoice-gate/.test(ZF) && !/require\('\.\/b2b-leads'\)/.test(SRC));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
