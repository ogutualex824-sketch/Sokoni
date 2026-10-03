#!/usr/bin/env node
/**
 * test-invoices-console.js — the ONE invoices page (sokoni-invoices-console.js) for AdminOS + Super Admin.
 * The SHIPPED module on a minimal fake DOM with a fake adminInvoicesList.
 *   V1  counts / totals / aging come from the server summary; an unavailable figure shows "—" + its reason, never 0
 *   V2  aging percentages are arithmetic on the server's own bucket sums (of the open amount)
 *   V3  no invented metrics: no "Avg days to pay", no "vs last 30 days" trend, no card brand / last-4
 *   V4  "paid" is labelled MARKED paid (merchant-recorded), never a verified payment
 *   V5  READ-ONLY: no write controls (send / void / mark paid / new invoice) — there is no admin write authority
 *   V6  every field escaped; CSV formula-safe
 *   V7  "Load more" sends the server's cursor and appends; tab change re-queries the server with the tab
 *   V8  status + overdue days are rendered from the server's derived fields
 *   V9  AdminOS and Super Admin both mount THIS module (one component)
 *   SABOTAGE=1 → unavailable totals render as KES 0 → V1 must FAIL
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
let SRC = fs.readFileSync(path.join(ROOT, 'sokoni-invoices-console.js'), 'utf8');
if (process.env.SABOTAGE === '1') SRC = SRC.replace("const big = (v) => { const n = num(v); return n === null ? '—' :", "const big = (v) => { const n = num(v) ?? 0; return false ? '—' :");
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
const SUMMARY = { asOf: '2026-10-04T09:00:00.000Z', counts: { all: 1248, draft: 32, open: 312, overdue: 87, paid: 849, void: null },
  totalInvoiced: 1248650, paidLast30Days: null, openAmount: 400000, overdueAmount: 79842,
  aging: { current: 320000, d1_30: 40000, d31_60: 20000, d61_90: 16000, d91plus: null, undated: 4000 },
  unavailable: { paid30: 'index_missing', aging91: 'index_missing', void: 'unavailable' } };
const INV = [
  { id: 'i1', invoiceNumber: 'INV-2024-10845', clientName: 'TechCorp Inc.', clientEmail: 'ap@techcorp.co', shopName: 'Duka A', display: 'overdue', daysOverdue: 15, status: 'sent', dueDate: '2026-09-19T00:00:00.000Z', total: 12842, balanceDue: 12842, currency: 'KES', subtotal: 11863, tax: 979, taxRate: 8.25, items: [{ description: 'Retainer', quantity: 1, total: 11863 }], itemCount: 1 },
  { id: 'i2', invoiceNumber: 'INV-2', clientName: '<img src=x onerror=alert(1)>', clientEmail: '=cmd|calc', display: 'paid', status: 'paid', paidAt: '2026-10-01T00:00:00.000Z', total: 8645, balanceDue: 0, currency: 'KES', paymentMethod: 'mpesa', paymentReferenced: true, items: [], itemCount: 0 },
];
(async () => {
  console.log('\nInvoices console' + (process.env.SABOTAGE === '1' ? '  (SABOTAGE)' : '') + '\n');
  const calls = [];
  const E = env();
  const call = async (op, d) => { calls.push({ op, d }); if (d.cursor === 'CUR1') return { invoices: [{ id: 'i3', invoiceNumber: 'INV-3', display: 'draft', status: 'draft', total: 50, balanceDue: 50, currency: 'KES' }], cursor: null }; return { invoices: INV, cursor: 'CUR1', summary: SUMMARY }; };
  E.C.mount(E.root, { call }); await tick(); await tick();
  let h = E.root.innerHTML;
  const counts = [...h.matchAll(/class="spc-count[^"]*">([^<]*)</g)].map((m) => m[1]);
  ck('V1a', counts.join('|') === '1,248|32|312|87|849|—', 'tab counts are the server\'s; an unavailable count is "—"', counts);
  ck('V1b', /Total invoiced[^<]*<\/small><b>KES 1,248,650/.test(h) && /Marked paid \(last 30 days\)<\/small><b>—<\/b><span class="sic-unav">database index not deployed yet/.test(h), 'totals from the server; an unavailable total is "—" with the reason (not KES 0)', (h.match(/Marked paid[^]{0,160}/) || [''])[0]);
  ck('V1c', /91\+ days<\/small><b>—<\/b>/.test(h) && /KES 4,000 on invoices with no due date/.test(h), 'an unavailable aging bucket is "—"; undated open money is shown, not dropped');
  ck('V2', /1–30 days overdue<\/small><b>KES 40,000<\/b> <span class="sic-sub">10%/.test(h) && /Current \(not yet due\)<\/small><b>KES 320,000<\/b> <span class="sic-sub">80%/.test(h), 'aging % = bucket ÷ server open amount (40,000/400,000 = 10%)');
  ck('V3', !/Avg\.? days|days to pay|vs last 30|VISA|Mastercard|•••• \d{4}/i.test(h), 'no invented metrics (avg days to pay, trends, card brand / last-4)');
  ck('V8', /INV-2024-10845/.test(h) && /15 days overdue/.test(h) && /spc-pill bad">Overdue/.test(h), 'status + overdue days rendered from the server\'s derived fields');
  ck('V6a', !/<img src=x onerror/.test(h) && /&lt;img src=x onerror=alert\(1\)&gt;/.test(h), 'customer-written fields are escaped');
  click(E.handlers, { open: 'i2' }); h = E.root.innerHTML;
  ck('V4', /Marked paid 1 Oct 2026/.test(h) && /<dt>Marked paid<\/dt>/.test(h) && /entered by the merchant \(not a verified payment\)/.test(h) && !/>Paid on /.test(h), 'paid is "marked paid" (merchant-recorded); a merchant reference is flagged as not verified');
  ck('V5', !/data-act="(send|void|markpaid|new|delete|download)"/.test(h) && !/New Invoice|Mark (as )?paid|Void invoice|Send invoice/i.test(h) && /Read-only/.test(h), 'read-only: no write controls without an admin authority');
  click(E.handlers, { act: 'export' });
  ck('V6b', /"'=cmd\|calc"/.test(E.blobs[0] || ''), 'CSV export neutralises a formula-like cell', (E.blobs[0] || '').split('\n')[2]);
  click(E.handlers, { act: 'more' }); await tick(); await tick();
  ck('V7a', calls[calls.length - 1].d.cursor === 'CUR1' && /INV-3/.test(E.root.innerHTML) && /INV-2024-10845/.test(E.root.innerHTML) && !/data-act="more"/.test(E.root.innerHTML), 'Load more sends the server cursor and appends; no cursor → no button');
  click(E.handlers, { tab: 'overdue' }); await tick();
  ck('V7b', calls[calls.length - 1].op === 'adminInvoicesList' && calls[calls.length - 1].d.tab === 'overdue' && calls[calls.length - 1].d.cursor === undefined, 'a tab change re-queries the server with that tab', calls[calls.length - 1]);
  const aos = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8'), ah = fs.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8'), sa = fs.readFileSync(path.join(ROOT, 'super-admin.html'), 'utf8');
  ck('V9', /SokoniInvoicesConsole\.mount\(el/.test(aos) && /invoices:\s+\(\) => _loadInvoices\(\)/.test(aos) && /data-section="invoices"/.test(ah) && /id="panel-invoices"/.test(ah) && /sokoni-invoices-console\.js/.test(ah) &&
    /data-section="invoices"/.test(sa) && /id="panel-invoices"/.test(sa) && /SokoniInvoicesConsole\.mount\(el/.test(sa) && /sokoni-invoices-console\.js/.test(sa), 'AdminOS and Super Admin both mount THIS module (nav entry + panel + loader + script)');
  console.log('\n' + pass + ' passed, ' + fail + ' failed' + (process.env.SABOTAGE === '1' ? '   (SABOTAGE — failures EXPECTED)' : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e.stack || e.message); process.exit(2); });
