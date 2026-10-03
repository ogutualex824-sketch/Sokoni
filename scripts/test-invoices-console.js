#!/usr/bin/env node
/**
 * test-invoices-console.js — the ONE canonical invoices page (AdminOS + Super Admin) and the merchant page wording.
 * The SHIPPED module on a minimal fake DOM with a fake adminInvoicesList / adminInvoicesExport.
 *   V1  counts / totals / aging come from the server summary (cents); unavailable → "—" + reason, never 0
 *   V2  "Confirmed paid (verified)" and "Unverified payment claims" are SEPARATE; claims say "not counted as paid"
 *   V3  excluded documents (unclassified / unmigrated) are reported, not summed
 *   V4  a claim row reads "Unverified claim — awaiting verification"; the drawer says a reference is not a payment
 *   V5  READ-ONLY: no New / Send / Void / Mark-paid controls
 *   V6  export calls the SERVER (adminInvoicesExport with the tab) — it never serialises the browser's rows
 *   V7  source + transaction link + audit (created / migrated / legacy) rendered from server fields
 *   V8  every field escaped
 *   V9  both hosts mount THIS module
 *   M1  merchant page: no "Mark Paid"/"Marked as paid"; submits a payment CLAIM through financeSprintDispatch
 *   SABOTAGE=1 → confirmed paid shows the claims-inclusive total → V2 must FAIL
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
let SRC = fs.readFileSync(path.join(ROOT, 'sokoni-invoices-console.js'), 'utf8');
if (process.env.SABOTAGE === '1') SRC = SRC.replace("kesBig(s.confirmedPaidCents)", "kesBig((s.confirmedPaidCents || 0) + 80000)");
let pass = 0, fail = 0;
const ck = (id, ok, m, d) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (ok || d === undefined ? '' : '   [' + String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 240) + ']')); ok ? pass++ : fail++; };
function env() {
  const handlers = {}; const root = { innerHTML: '', classList: { add() {} }, addEventListener: (e, f) => { handlers[e] = f; }, contains: () => true, querySelector: () => null };
  const window = {}; const blobs = [];
  const sb = { window, document: { head: { appendChild() {} }, body: { appendChild() {} }, getElementById: () => null, createElement: () => ({ set textContent(v) {}, click() {}, remove() {} }) },
    Blob: function (p) { blobs.push(p.join('')); }, URL: { createObjectURL: () => 'b', revokeObjectURL() {} }, setTimeout: (f) => f(), console, Date, Math, Number, String, JSON, Object, Array, Set, Promise, isFinite };
  new Function(...Object.keys(sb), SRC)(...Object.values(sb));
  return { C: window.SokoniInvoicesConsole, root, handlers, blobs };
}
const click = (h, ds) => h.click({ target: { closest: () => ({ dataset: ds }) } });
const tick = () => new Promise((r) => setImmediate(r));
const SUMMARY = { asOf: '2026-10-04T09:00:00.000Z', currency: 'KES', unit: 'cents',
  counts: { all: 5, draft: 1, issued: 3, partially_paid: 1, overdue: 1, paid: 0, void: 0, unverified: 3, unclassified: 1 },
  totalInvoicedCents: 880050, confirmedPaidCents: 100000, openBalanceCents: 780050, overdueBalanceCents: null, unverifiedClaims: 3,
  aging: { current: 630050, d1_30: 150000, d31_60: 0, d61_90: 0, d91plus: 0, undated: 0 },
  excluded: { unclassified: 1, unmigrated: 1 }, unavailable: { overdue: 'index_missing' } };
const INV = [
  { id: 'ord9', invoiceNumber: 'INV-ORD9', source: 'order', classification: 'canonical', transactionRef: { kind: 'order', id: 'ord9' }, clientName: 'Buyer <b>x</b>', status: 'partially_paid', display: 'overdue', base: 'partially_paid', daysOverdue: 10, paymentStatus: 'succeeded', allocationCount: 1, currency: 'KES', totalCents: 250000, paidCents: 100000, balanceCents: 150000, dueDate: '2026-09-24T00:00:00.000Z', createdAt: '2026-09-14T00:00:00.000Z', migratedAt: '2026-10-04T00:00:00.000Z' },
  { id: 'mAp', invoiceNumber: 'INV-2', source: 'manual', classification: 'canonical', clientName: 'Beta', status: 'issued', display: 'issued', paymentStatus: 'unverified', paymentClaim: { status: 'unverified', reference: 'QWE123', method: 'mpesa', source: 'legacy_mark_paid' }, legacy: { status: 'paid', markedPaidAt: '2026-10-02T00:00:00.000Z' }, currency: 'KES', totalCents: 80000, paidCents: 0, balanceCents: 80000, createdAt: '2026-10-01T00:00:00.000Z', createdBy: 'merch' },
];
(async () => {
  console.log('\nInvoices console (canonical)' + (process.env.SABOTAGE === '1' ? '  (SABOTAGE)' : '') + '\n');
  const calls = []; const E = env();
  const call = async (op, d) => { calls.push({ op, d }); if (op === 'adminInvoicesExport') return { csv: 'id,invoiceNumber\n"ord9","INV-ORD9"', rows: 1, truncated: false }; return { invoices: INV, cursor: null, summary: SUMMARY }; };
  E.C.mount(E.root, { call, toast: () => {} }); await tick(); await tick();
  let h = E.root.innerHTML;
  const counts = [...h.matchAll(/class="spc-count[^"]*">([^<]*)</g)].map((m) => m[1]);
  ck('V1a', counts.join('|') === '5|1|3|1|1|0|0|3|1', 'tab counts are the server\'s canonical counts', counts);
  ck('V1b', /Total invoiced<\/small><b>KES 8,801<\/b>/.test(h) && /Overdue balance<\/small><b>—<\/b><span class="sic-unav">database index not deployed yet/.test(h), 'totals from server cents; an unavailable figure is "—" + reason (not KES 0)', (h.match(/Overdue balance[^]{0,120}/) || [''])[0]);
  ck('V2', /Confirmed paid \(verified\)<\/small><b>KES 1,000<\/b>/.test(h) && /Unverified payment claims<\/small><b>3<\/b><span class="sic-unav">not counted as paid/.test(h), 'confirmed paid (verified only) and unverified claims are SEPARATE', (h.match(/Confirmed paid[^]{0,80}/) || [''])[0]);
  ck('V3', /Excluded from every total: 1 unclassified · 1 not yet migrated/.test(h), 'excluded documents are reported, not summed');
  ck('V4a', /Unverified claim — awaiting verification/.test(h) && /Verified \(1\)/.test(h), 'payment column: claim vs verified, from server fields');
  ck('V8', !/<b>x<\/b>/.test(h) && /Buyer &lt;b&gt;x&lt;\/b&gt;/.test(h), 'fields escaped');
  click(E.handlers, { open: 'mAp' }); h = E.root.innerHTML;
  ck('V4b', /a reference entered by a person, not a verified payment/.test(h) && /marked paid 2 Oct 2026 \(unverified\)/.test(h), 'drawer: the claim reference is not a payment; the legacy "paid" is shown as unverified history');
  ck('V5', !/data-act="(send|void|markpaid|new|create)"/.test(h) && !/New Invoice|Mark (as )?paid|Void invoice|Send invoice/i.test(h), 'read-only: no write controls');
  click(E.handlers, { open: 'ord9' }); h = E.root.innerHTML;
  ck('V7', /order ord9/.test(h) && /Paid \(verified\)<\/dt><dd>KES 1,000\.00/.test(h) && /Migrated<\/dt>/.test(h) && /Source<\/dt><dd>Order/.test(h), 'source + transaction link + verified paid + audit rendered from server fields');
  click(E.handlers, { act: 'export' }); await tick(); await tick();
  const ex = calls.find((c) => c.op === 'adminInvoicesExport');
  ck('V6', ex && ex.d.tab === 'all' && E.blobs[0] === 'id,invoiceNumber\n"ord9","INV-ORD9"', 'export is the SERVER query (adminInvoicesExport + tab); the file is the server\'s CSV verbatim', ex);
  const aos = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8'), ah = fs.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8'), sa = fs.readFileSync(path.join(ROOT, 'super-admin.html'), 'utf8');
  ck('V9', /SokoniInvoicesConsole\.mount\(el/.test(aos) && /sokoni-invoices-console\.js/.test(ah) && /SokoniInvoicesConsole\.mount\(el/.test(sa) && /sokoni-invoices-console\.js/.test(sa), 'AdminOS and Super Admin both mount THIS module');
  const fin = fs.readFileSync(path.join(ROOT, 'finance-invoices.html'), 'utf8');
  ck('M1', !/Mark Paid|Marked as paid/.test(fin) && /invoiceSubmitPaymentClaim/.test(fin) && /httpsCallable\('financeSprintDispatch'\)/.test(fin) && /awaiting verification/.test(fin) && !/httpsCallable\(n\)/.test(fin), 'merchant page: "Submit payment reference" → a CLAIM via financeSprintDispatch; no "Mark Paid" anywhere');
  console.log('\n' + pass + ' passed, ' + fail + ' failed' + (process.env.SABOTAGE === '1' ? '   (SABOTAGE — failures EXPECTED)' : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e.stack || e.message); process.exit(2); });
