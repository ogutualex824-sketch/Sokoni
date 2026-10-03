#!/usr/bin/env node
/* test-supplier-invoice-ui.js — hosting copy for "supplier-invoice payment is a CLAIM until VERIFIED"
 * (owner 2026-10-04; ships with functions de9fb9d). Browser-free: plain Node + vm, no network.
 *
 * Fixtures are the SHAPES de9fb9d's functions/procurement.js returns:
 *   listSupplierInvoices → { items:[{ invoiceId, invoiceNumber, poId, supplierId, amount, vatAmount,
 *     total, status, dueDate, paymentStatus, paymentClaim, paymentVerified, paidAt, paymentMethod,
 *     createdAt }], count, nextCursor }
 *   getProcurementDashboard → { openPOs:{count,totalValue,vatUnknownCount}, pendingApproval:{count},
 *     goodsToReceive:{count}, pendingInvoices / unclaimedInvoices / claimedInvoices /
 *     verifiedPaidLast30d / recordedUnverifiedLast30d : {count,totalValue|null,unknownTotalCount},
 *     overdueInvoices:{count,items}, topSuppliers:[{supplierId,name,spend}], reorderAlerts, generatedAt }
 *   approveAndPayInvoice → { invoiceId, status, paymentStatus, total, verified, duplicate, paymentClaim }
 *
 *   L  labels per paymentStatus (both surfaces); "Paid" only for verified_paid + paymentVerified
 *   A  approve: no required method; optional ref sent as paymentRef and labelled a claim; toast wording
 *   R  procurement.html reads listSupplierInvoices, never procInvoices
 *   D  no KES 0.00 fabrication: unknown totals render '—'; claimed tile from claimedInvoices
 *   C  compat: test-mv2-2a-supply's section regex still finds invoices/payments
 *   N  negative controls: (a) "Paid" for claimed → L2 fails; (b) pendingInvoicesTotal ?? 0 → D1 fails
 *
 *   node scripts/test-supplier-invoice-ui.js
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const strip = (h) => String(h).replace(/<[^>]*>/g, ' ').replace(/&mdash;/g, '—').replace(/\s+/g, ' ').trim();

/* ── fixtures (de9fb9d shapes) ── */
const INV = {
  unpaid:   { invoiceId: 'inv_u', invoiceNumber: 'INV-U', poId: 'po1', supplierId: 'sup1', amount: 1000, vatAmount: 160, total: 1160, status: 'pending',  dueDate: '2099-01-01', paymentStatus: 'unpaid', paymentClaim: null, paymentVerified: false, paidAt: null, paymentMethod: null, createdAt: null },
  claimed:  { invoiceId: 'inv_c', invoiceNumber: 'INV-C', poId: 'po2', supplierId: 'sup1', amount: 2000, vatAmount: 320, total: 2320, status: 'approved', dueDate: { _seconds: 4070908800, _nanoseconds: 0 }, paymentStatus: 'claimed', paymentClaim: { method: 'mpesa', ref: 'QWE123', claimedAt: null }, paymentVerified: false, paidAt: null, paymentMethod: null, createdAt: null },
  verified: { invoiceId: 'inv_v', invoiceNumber: 'INV-V', poId: 'po3', supplierId: 'sup2', amount: 500, vatAmount: 80, total: 580, status: 'paid', dueDate: null, paymentStatus: 'verified_paid', paymentClaim: null, paymentVerified: true, paidAt: { _seconds: 1, _nanoseconds: 0 }, paymentMethod: 'bank', createdAt: null },
  recorded: { invoiceId: 'inv_r', invoiceNumber: 'INV-R', poId: 'po4', supplierId: 'sup2', amount: 700, vatAmount: null, total: null, status: 'paid', dueDate: null, paymentStatus: 'recorded_unverified', paymentClaim: null, paymentVerified: false, paidAt: { _seconds: 1, _nanoseconds: 0 }, paymentMethod: 'mpesa', createdAt: null },
  hostile:  { invoiceId: 'inv_x"><img src=x onerror=alert(1)>', invoiceNumber: '<script>alert(1)</script>', poId: null, supplierId: 'sup<b>', amount: null, vatAmount: null, total: 10, status: 'pending', dueDate: null, paymentStatus: 'unpaid', paymentClaim: null, paymentVerified: false, paidAt: null, paymentMethod: null, createdAt: null },
};
const LIST = { items: Object.values(INV), count: 5, nextCursor: null };
const DASH_UNKNOWN = {
  merchantId: 'biz1',
  openPOs: { count: 2, totalValue: 4500, vatUnknownCount: 0 }, pendingApproval: { count: 1 }, goodsToReceive: { count: 2 },
  pendingInvoices: { count: 3, totalValue: null, unknownTotalCount: 1 },
  unclaimedInvoices: { count: 2, totalValue: null, unknownTotalCount: 1 },
  claimedInvoices: { count: 1, totalValue: null, unknownTotalCount: 1 },
  verifiedPaidLast30d: { count: 0, totalValue: 0, unknownTotalCount: 0 },
  recordedUnverifiedLast30d: { count: 1, totalValue: null, unknownTotalCount: 1 },
  overdueInvoices: { count: 0, items: [] },
  topSuppliers: [{ supplierId: 'sup2', name: 'Kilimo', spend: 580 }],
  reorderAlerts: [{ productId: 'p1', reorderPoint: 5, reorderQty: 20 }],
  generatedAt: '2026-10-04T00:00:00.000Z',
};
const DASH_KNOWN = Object.assign({}, DASH_UNKNOWN, {
  pendingInvoices: { count: 2, totalValue: 3480, unknownTotalCount: 0 },
  claimedInvoices: { count: 1, totalValue: 2320, unknownTotalCount: 0 },
});

/* ── loaders ── */
function loadSupply (src) {
  const w = { console }; w.window = w;
  const ctx = vm.createContext(w);
  vm.runInContext(src, ctx, { filename: 'sokoni-merchant-supply.js' });
  return ctx.SokoniMerchantSupply._invoiceUi;
}

function loadPortal (html) {
  const m = html.match(/<script>\s*(const ProcurementPortal = [\s\S]*?)<\/script>/);
  if (!m) throw new Error('ProcurementPortal script not found');
  const els = {}, calls = [], toasts = [], listeners = {}, claimInputs = [];
  const el = (id) => els[id] || (els[id] = { id, innerHTML: '', textContent: '', value: '', classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(t, f) { (listeners[id + ':' + t] = listeners[id + ':' + t] || []).push(f); }, appendChild() {} });
  const replies = {};
  const document = {
    getElementById: el,
    querySelectorAll: (sel) => sel === '[data-claim-ref]' ? claimInputs : [],
    addEventListener: (t, f) => { (listeners['doc:' + t] = listeners['doc:' + t] || []).push(f); },
    createElement: () => ({ style: {}, remove() {}, set textContent (v) { toasts.push(v); } }),
    body: { appendChild() {} },
  };
  const firebase = {
    firestore: () => ({ collection: (c) => { calls.push({ name: 'firestore:' + c }); throw new Error('firestore read not expected: ' + c); } }),
    functions: () => ({ httpsCallable: (name) => async (payload) => { calls.push({ name, payload }); const r = replies[name]; if (!r) throw new Error('not-found'); return { data: typeof r === 'function' ? r(payload) : r }; } }),
    auth: () => ({ onAuthStateChanged () {} }),
  };
  const ctx = vm.createContext({ document, firebase, window: { location: {} }, console, setTimeout: () => 0, Object, Array, String, Number, Date, JSON, Math, isFinite });
  vm.runInContext(m[1] + '\n;this.ProcurementPortal = ProcurementPortal;', ctx, { filename: 'procurement.html#inline' });
  (listeners['doc:DOMContentLoaded'] || []).forEach((f) => f());
  return { P: ctx.ProcurementPortal, els, calls, toasts, replies, claimInputs, listeners, el };
}

/* ── rows (run against any pair of sources so negative controls exercise the SAME rows) ── */
async function runRows (supplySrc, html) {
  const res = {};
  const row = (id, ok, got) => { res[id] = { ok: !!ok, got }; };
  const U = loadSupply(supplySrc);
  const cell = (cols, h, r) => strip(cols.find((c) => c.h === h).f(r));

  /* L — labels */
  const want = { unpaid: 'Unpaid', claimed: 'Payment claimed — not verified', verified: 'Paid — verified', recorded: 'Recorded as paid — not verified' };
  const supInv = Object.fromEntries(Object.keys(want).map((k) => [k, cell(U.INVOICE_COLS, 'Status', INV[k])]));
  row('L1  supply Invoices Status renders the paymentStatus label for each state',
    Object.keys(want).every((k) => supInv[k].includes(want[k])), supInv);

  const P1 = loadPortal(html);
  P1.replies.listSupplierInvoices = LIST;
  P1.replies.getProcurementDashboard = DASH_UNKNOWN;
  P1.el('midInput').value = 'biz1';
  P1.P.load();
  await P1.P.loadInvoices('biz1');
  const tbody = P1.els['invoice-tbody'].innerHTML;
  const rowsHtml = tbody.split('<tr>').slice(1);
  const rowFor = (k) => strip(rowsHtml.find((r) => r.includes(INV[k].invoiceNumber)) || '');
  const htmlInv = Object.fromEntries(Object.keys(want).map((k) => [k, rowFor(k)]));

  const noPaid = (t) => !/\bPaid\b/.test(t);
  const supPay = { claimed: cell(U.PAYMENT_COLS, 'Payment', INV.claimed), recorded: cell(U.PAYMENT_COLS, 'Payment', INV.recorded) };
  row('L2  no "Paid" for claimed / recorded_unverified (supply Invoices + Payments, procurement.html)',
    noPaid(supInv.claimed) && noPaid(supInv.recorded) && noPaid(supPay.claimed) && noPaid(supPay.recorded) &&
    noPaid(htmlInv.claimed) && noPaid(htmlInv.recorded) && htmlInv.claimed.includes('not verified') && htmlInv.recorded.includes('not verified'),
    { supInv, supPay, htmlInv });

  row('L3  procurement.html badge per paymentStatus (render from paymentStatus, not status)',
    Object.keys(want).every((k) => htmlInv[k].includes(want[k])), htmlInv);

  const forged = Object.assign({}, INV.verified, { paymentVerified: false });       /* verified_paid without the flag */
  const statusOnly = Object.assign({}, INV.verified, { paymentStatus: undefined, paymentVerified: undefined }); /* older engine: status 'paid' only */
  row('L4  "Paid" requires paymentStatus verified_paid AND paymentVerified true; status "paid" alone is never Paid',
    noPaid(cell(U.INVOICE_COLS, 'Status', forged)) && noPaid(cell(U.INVOICE_COLS, 'Status', statusOnly)) &&
    cell(U.PAYMENT_COLS, 'Verified', forged) === 'No' && cell(U.PAYMENT_COLS, 'Payment', INV.verified) === 'Verified' &&
    cell(U.PAYMENT_COLS, 'Payment', INV.recorded) === 'Recorded — not verified' && cell(U.PAYMENT_COLS, 'Verified', INV.verified) === 'Yes',
    { forged: cell(U.INVOICE_COLS, 'Status', forged), statusOnly: cell(U.INVOICE_COLS, 'Status', statusOnly) });

  row('L5  PO filter relabelled "Paid (verified)"; no "Approve & Pay" anywhere',
    /<option value="paid">Paid \(verified\)<\/option>/.test(html) && !/Approve &amp; Pay|Approve & Pay/.test(html), null);

  row('L6  escaping: hostile invoice fields never reach the DOM as markup',
    !/<script>alert|<img src=x|<b>/.test(tbody) && tbody.includes('&lt;script&gt;') &&
    !/<script>alert/.test(U.INVOICE_COLS[0].f(INV.hostile)), tbody.slice(0, 300));

  /* A — approve */
  P1.replies.approveAndPayInvoice = (p) => ({ invoiceId: p.invoiceId, status: 'approved', paymentStatus: p.paymentRef ? 'claimed' : 'unpaid', total: 1160, verified: false, duplicate: false, paymentClaim: p.paymentRef ? { ref: p.paymentRef } : null });
  P1.calls.length = 0; P1.toasts.length = 0;
  await P1.P.approveInvoice('inv_u');
  const a1 = P1.calls.find((c) => c.name === 'approveAndPayInvoice');
  const t1 = P1.toasts[0];
  P1.claimInputs.push({ getAttribute: () => 'inv_u', value: '  QWE123  ' });
  P1.calls.length = 0; P1.toasts.length = 0;
  await P1.P.approveInvoice('inv_u');
  const a2 = P1.calls.find((c) => c.name === 'approveAndPayInvoice');
  const t2 = P1.toasts[0];
  row('A1  approve sends NO paymentMethod; the optional ref is sent as paymentRef only when typed',
    !!a1 && !('paymentMethod' in a1.payload) && !('paymentRef' in a1.payload) &&
    !!a2 && !('paymentMethod' in a2.payload) && a2.payload.paymentRef === 'QWE123', { a1: a1 && a1.payload, a2: a2 && a2.payload });
  row('A2  button says "Approve"; the ref field is labelled a claim; toast never says paid',
    /data-approve-invoice="inv_u">Approve</.test(tbody) && /placeholder="Payment reference \(claim, optional\)"/.test(tbody) &&
    /aria-label="Payment reference — recorded as a claim, not verified payment"/.test(tbody) &&
    t1 === 'Invoice approved — payment not verified' && t2 === 'Invoice approved — payment claimed, not verified',
    { t1, t2 });

  /* R — read path */
  row('R1  procurement.html reads listSupplierInvoices (callable), never procInvoices',
    !/procInvoices/.test(html.replace(/\/\*[\s\S]*?\*\//g, '')) &&
    /_call\('listSupplierInvoices'\)/.test(html) && rowsHtml.length === 5, { rows: rowsHtml.length });

  /* D — no fabrication */
  P1.replies.getProcurementDashboard = DASH_UNKNOWN;
  await P1.P.loadDashboard('biz1');
  const k = { inv: P1.els['kpi-invoices'].textContent, claimed: P1.els['kpi-claimed'].textContent, open: P1.els['kpi-open'].textContent };
  row('D1  dashboard: unknown pendingInvoices / claimedInvoices totals render "—", never KES 0.00',
    k.inv === '—' && k.claimed === '—' && k.open === '2' && !/KES 0\.00/.test(P1.els['top-suppliers-tbody'].innerHTML), k);
  P1.replies.getProcurementDashboard = DASH_KNOWN;
  await P1.P.loadDashboard('biz1');
  const k2 = { inv: P1.els['kpi-invoices'].textContent, claimed: P1.els['kpi-claimed'].textContent };
  row('D2  dashboard: known totals come from pendingInvoices.totalValue / claimedInvoices.totalValue',
    /3,480\.00/.test(k2.inv) && /2,320\.00/.test(k2.claimed), k2);
  const tilesU = U.overviewTiles(DASH_UNKNOWN);
  const ct = tilesU.find((t) => t.k === 'Payment claimed — not verified');
  const ctK = U.overviewTiles(DASH_KNOWN).find((t) => t.k === 'Payment claimed — not verified');
  const ctOld = U.overviewTiles({}).find((t) => t.k === 'Payment claimed — not verified');
  row('D3  supply overview: "Payment claimed — not verified" tile from claimedInvoices; money(null) → "—"',
    !!ct && ct.v === '1' && ct.s === '—' && ctK.s === 'KES 2,320' && ctOld.v === '—' && ctOld.s === '—', { ct, ctK, ctOld });
  row('D4  invoice row with total null renders "—" (supply + procurement.html)',
    cell(U.INVOICE_COLS, 'Total', INV.recorded) === '—' && htmlInv.recorded.includes('—') && !/KES 0\.00/.test(htmlInv.recorded), htmlInv.recorded);

  /* C — compat with test-mv2-2a-supply's static parser */
  const ops = Object.fromEntries([...supplySrc.matchAll(/^\s+([a-z]+): \{ op: '([A-Za-z]+)'/gm)].map((mm) => [mm[1], mm[2]]));
  row('C1  section op map still parses: invoices + payments → listSupplierInvoices; payments queries status paid',
    ops.invoices === 'listSupplierInvoices' && ops.payments === 'listSupplierInvoices' && /query: \{ status: 'paid' \}/.test(supplySrc), ops);
  row('C2  Payments note states verification needs a verified payment event and none exists yet',
    /verified ONLY by a verified payment event/.test(supplySrc) && /No verified ' \+\s*'supplier-payment rail exists yet/.test(supplySrc), null);
  return res;
}

(async () => {
  let pass = 0, fail = 0;
  const supply = read('sokoni-merchant-supply.js'), html = read('procurement.html');
  const real = await runRows(supply, html);
  for (const [id, r] of Object.entries(real)) {
    console.log('  ' + (r.ok ? 'PASS  ' : 'FAIL  ') + id + (r.ok ? '' : '   [got ' + JSON.stringify(r.got).slice(0, 500) + ']'));
    r.ok ? pass++ : fail++;
  }

  /* N — negative controls: each mutation MUST fail its named row. */
  const control = async (label, rowId, s, h) => {
    if (s === supply && h === html) { console.log('  FAIL  ' + label + ' — mutation did not apply'); fail++; return; }
    let r;
    try { r = await runRows(s, h); } catch (e) { console.log('  FAIL  ' + label + ' — crashed (' + e.message + '), a crash is not a refusal'); fail++; return; }
    const ok = r[rowId] && r[rowId].ok === false;
    console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + ' → ' + rowId.split('  ')[0] + (ok ? ' fails' : ' still passes'));
    ok ? pass++ : fail++;
  };
  const rowL2 = Object.keys(real).find((k) => k.startsWith('L2'));
  const rowD1 = Object.keys(real).find((k) => k.startsWith('D1'));
  await control('N1  (a) show "Paid" for claimed', rowL2,
    supply.replace("claimed:             'Payment claimed — not verified'", "claimed:             'Paid'"),
    html.replace("claimed:'Payment claimed — not verified'", "claimed:'Paid'"));
  await control('N2  (b) default pendingInvoicesTotal to 0', rowD1, supply,
    html.replace("_q('kpi-invoices').textContent = _money(d.pendingInvoices && d.pendingInvoices.totalValue);",
                 "_q('kpi-invoices').textContent = _fmt(d.pendingInvoicesTotal ?? 0);"));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (fail closed):', e && e.stack || e); process.exit(2); });
