#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   TEST — the receipt receives the AUTHORITATIVE seller identity
   ══════════════════════════════════════════════════════════════════════════════
   Run:  node scripts/test-servedby-wire.js

   SCOPE. Slice A is a wire, not a feature. Two hand-offs were missing between
   pieces that already existed:

     merchantIdentity.resolveActor -> { servedBy: {uid,name,role,label} }   built
     merchant-v2 S.servedBy                                                 built
     _ctx() -> SokoniMerchantSell                                           MISSING
     sokoni-merchant-sell `servedBy: ctx.servedBy || null`                  built
     SokoniReceiptDoc.servedByLine                                          built
     merchant-v2 loading sokoni-receipt.js                                  MISSING

   Wiring only the first would have produced a receipt that still showed nobody,
   because composedReceipt() returns null when the renderer is absent and the
   shell falls back to unbranded text.

   WHAT IS DELIBERATELY NOT TESTED HERE. No sale is completed: that needs
   posCompleteCheckout and an authenticated merchant, and this harness must never
   fake credentials. The receipt CONTRACT is what is proved — that the renderer
   turns the authority's own shape into a seller line, and refuses anything else.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const rows = [];
const ck = (label, ok, detail) => rows.push({ ok, label, detail: detail == null ? '' : String(detail) });

/* The renderer supports CommonJS, so the real module is exercised — not a copy. */
global.window = global;
const R = require(path.join(ROOT, 'sokoni-receipt.js'));

/* ── the shape merchant-identity.js actually returns ────────────────────── */
const AUTHORITATIVE = { uid: 'U123', name: 'Alex Ogutu', role: 'cashier', label: 'Cashier' };

ck('S1  the renderer exposes the seller-line API',
  R && typeof R.servedByLine === 'function' && typeof R.servedRoleLine === 'function',
  'servedByLine + servedRoleLine present');

const line = R.servedByLine({ servedBy: AUTHORITATIVE });
ck('S2  the AUTHORITY shape produces a seller line',
  typeof line === 'string' && /Alex Ogutu/.test(line),
  'line=' + JSON.stringify(line));

const roleLine = R.servedRoleLine ? R.servedRoleLine({ servedBy: AUTHORITATIVE }) : null;
ck('S3  the role is rendered as a customer-facing word',
  roleLine == null || /cashier/i.test(String(roleLine)),
  'roleLine=' + JSON.stringify(roleLine));

/* ── NEGATIVE CONTROLS — the line must be refusable ─────────────────────── */
ck('S4  CONTROL no servedBy yields NO seller line, not a blank one',
  R.servedByLine({}) === null, 'got ' + JSON.stringify(R.servedByLine({})));

ck('S5  CONTROL an employee sale with NO NAME does not fall through to anyone',
  R.servedByLine({ servedBy: { uid: 'U1', role: 'cashier' } }) === null,
  'a nameless employee sale must not become an owner sale — that is a false financial record');

ck('S6  CONTROL an unrecognised role is refused rather than rendered',
  R.servedByLine({ servedBy: { name: 'Someone', role: 'superuser' } }) === null,
  'roles outside the server set are not customer-facing labels');

/* ── the two wires, asserted against the SOURCE ─────────────────────────── */
const shell = fs.readFileSync(path.join(ROOT, 'merchant-v2.html'), 'utf8');
const sell = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-sell.js'), 'utf8');

ck('S7  WIRE _ctx passes servedBy straight from the resolved identity',
  /servedBy:\s*S\.servedBy\b/.test(shell),
  'must be S.servedBy — not a literal, not a default, not the shop owner');

ck('S8  WIRE the shell constructs no seller identity of its own',
  !/servedBy:\s*\{/.test(shell) && !/cashierName\s*:/.test(shell),
  'the client may pass the server\'s value through; it may never build one');

ck('S9  WIRE the shell loads the canonical renderer',
  /<script src="sokoni-receipt\.js"><\/script>/.test(shell),
  'without it composedReceipt() returns null and the seller line can never appear');

ck('S10 the module still reads servedBy from ctx and defaults to null',
  /servedBy:\s*ctx\.servedBy\s*\|\|\s*null/.test(sell),
  'unchanged — the module was already correct');

ck('S11 SCOPE no client-side role or staff-number field was introduced',
  !/staffNo|employeeNo|staffNumber/.test(shell) && !/role:\s*['"]/.test(shell),
  'slice A adds a wire, not identity fields');

const passed = rows.filter((r) => r.ok).length;
console.log('');
console.log('  SERVED-BY WIRE — the receipt receives the authoritative seller');
console.log('  ' + '='.repeat(64));
console.log('');
for (const r of rows) console.log('  ' + (r.ok ? 'PASS  ' : 'FAIL  ') + r.label + '\n        [' + r.detail + ']');
console.log('');
console.log('  ' + passed + ' passed, ' + (rows.length - passed) + ' failed');
console.log('');
process.exit(passed === rows.length ? 0 : 1);
