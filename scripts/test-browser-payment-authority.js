#!/usr/bin/env node
/* test-browser-payment-authority.js — Gate 13: the browser never authors a payment fact
 *
 *   node scripts/test-browser-payment-authority.js
 *
 *   F1  SokoniPay.saveFee writes no Firestore fee record (local display cache only)
 *   F2  car hub's no-payment booking records no fee and no commission
 *   F3  an invoice says PAID only with paymentVerified:true (EXECUTED: the real _buildInvoice / _show)
 *   F4  checkout passes its server-verified flag into the invoice
 * Each check is also run against a sabotaged copy and must turn red.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');

function invoiceApi(src) {
  /* Run the real module in a sandbox whose document records every innerHTML written, so _show's markup can be read. */
  const captured = [];
  const mkEl = () => { const el = { style: {}, children: [], classList: { add() {}, remove() {} }, setAttribute() {}, appendChild(c) { el.children.push(c); return c; }, remove() {}, insertAdjacentHTML(_p, h) { captured.push(String(h)); }, addEventListener() {}, querySelector: () => mkEl(), querySelectorAll: () => [] };
    Object.defineProperty(el, 'innerHTML', { set(v) { captured.push(String(v)); }, get() { return ''; } }); return el; };
  const sandbox = { document: { getElementById: () => null, createElement: mkEl, body: mkEl(), head: mkEl(), addEventListener() {}, querySelector: () => null },
    localStorage: { getItem: () => null, setItem() {} }, console, setTimeout: () => 0, navigator: {}, innerWidth: 400 };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox); vm.runInContext(src, sandbox);
  const api = sandbox.window.SokoniInvoice;
  if (api) api.__render = (inv) => { captured.length = 0; try { api._show(inv); } catch (_) {} return captured.join('\n'); };
  return api;
}
function renderedHtml(api, inv) { return api && api.__render ? api.__render(inv) : ''; }

const CHECKS = {
  F1: (s) => { const b = (strip(s['sokoni-pay.js']).match(/function saveBookingFee\(record\)\{[\s\S]*?\n\}/) || [''])[0]; return b.length > 0 && !/bookingFees|\.collection\(|setDoc|addDoc/.test(b); },
  F2: (s) => { const c = strip(s['car-hub.html']); const i = c.indexOf('Booking confirmed — M-Pesa request sent'); const seg = i < 0 ? '' : c.slice(i, i + 700); return i > -1 && !/saveFee|saveCommission/.test(seg); },
  F3: (s) => {
    const api = invoiceApi(s['sokoni-invoice.js']);
    if (!api || typeof api._buildInvoice !== 'function') return false;
    const base = { type: 'rental', buyerName: 'B', items: [{ name: 'X', qty: 1, price: 100 }], total: 100, paymentRef: 'R1' };
    const unverified = api._buildInvoice(Object.assign({}, base));
    const verified = api._buildInvoice(Object.assign({}, base, { paymentVerified: true, paymentMethod: 'M-Pesa' }));
    const notTrue = api._buildInvoice(Object.assign({}, base, { paymentVerified: 'yes' }));
    const hU = renderedHtml(api, unverified), hV = renderedHtml(api, verified);
    return unverified.status !== 'paid' && notTrue.status !== 'paid' && verified.status === 'paid'
      && !/Total Paid|Paid via/.test(hU) && /Amount Due/.test(hU) && /Total Paid/.test(hV) && /Paid via/.test(hV);
  },
  F4: (s) => /paymentVerified:\s*_paid\b/.test(strip(s['checkout.html'])),
};
const SABOTAGE = {
  F1: (s) => Object.assign({}, s, { 'sokoni-pay.js': s['sokoni-pay.js'].replace('saveRecords("sokoniBookingFees",r);\n}', 'saveRecords("sokoniBookingFees",r);\n  window.firebaseDB.collection(\'bookingFees\').doc(\'x\').set({});\n}') }),
  F2: (s) => Object.assign({}, s, { 'car-hub.html': s['car-hub.html'].replace('showFleetMsg("✅ Booking confirmed — M-Pesa request sent!");', 'showFleetMsg("✅ Booking confirmed — M-Pesa request sent!"); SokoniPay.saveFee({});') }),
  F3: (s) => Object.assign({}, s, { 'sokoni-invoice.js': s['sokoni-invoice.js'].replace("status: data.paymentVerified === true ? 'paid' : 'unconfirmed'", "status: 'paid'") }),
  F4: (s) => Object.assign({}, s, { 'checkout.html': s['checkout.html'].replace('paymentVerified: _paid,', '') }),
};
const LABELS = {
  F1: 'saveFee writes no Firestore fee record',
  F2: "car hub's no-payment booking records no fee or commission",
  F3: 'an invoice says PAID only with paymentVerified:true (executed builder + renderer)',
  F4: 'checkout passes its server-verified flag into the invoice',
};

const SRC = {};
for (const f of ['sokoni-pay.js', 'car-hub.html', 'sokoni-invoice.js', 'checkout.html']) SRC[f] = read(f).split('\r\n').join('\n');
let pass = 0, fail = 0, caught = 0;
console.log('\nBROWSER PAYMENT AUTHORITY — Gate 13\n');
for (const k of Object.keys(CHECKS)) { const ok = CHECKS[k](SRC); console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + k + '  ' + LABELS[k]); ok ? pass++ : fail++; }
console.log('\n  [sabotage]');
for (const k of Object.keys(CHECKS)) {
  const broken = SABOTAGE[k](SRC);
  const changed = Object.keys(SRC).some((f) => broken[f] !== SRC[f]);
  if (!changed) { console.log('  FAIL  ' + k + ' sabotage anchor missing'); fail++; continue; }
  const red = !CHECKS[k](broken);
  console.log('  ' + (red ? 'CAUGHT' : 'MISSED') + '  ' + k);
  red ? caught++ : fail++;
}
console.log('\n  ' + pass + ' passed, ' + fail + ' failed, ' + caught + '/' + Object.keys(CHECKS).length + ' sabotages caught\n');
process.exit(fail ? 1 : 0);
