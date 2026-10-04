#!/usr/bin/env node
/* test-procurement-po-tab.js — procurement.html Purchase Orders tab data contract + dashboard
 * error state (owner decisions O-9..O-12, 2026-10-04). Browser-free: plain Node + vm, no network,
 * no emulator.
 *
 * Fixtures are the SERVING shape of listPurchaseOrders (live 00001-zik, source 49e81a1, read from
 * the downloaded serving archive's functions/procurement.js `_listScoped` + projection):
 *   in : { merchantId, status?, supplierId?, limit (1..200, default 50), cursor? }
 *   out: { merchantId, items:[{ poId, poNumber, status, supplierId, supplierName, supplierBusinessId,
 *          buyerBusinessId, itemCount, subtotal, vatAmount, total, expectedDelivery, approvedAt,
 *          sentAt, delivery, createdAt }], count (this page), nextCursor (doc id | null) }
 *   de9fb9d adds vatRate, vatBasis, deliveryFee — exercised as optional fields.
 * Serialized Timestamps arrive as { _seconds, _nanoseconds }.
 *
 *   node scripts/test-procurement-po-tab.js
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const strip = (h) => String(h).replace(/<[^>]*>/g, ' ').replace(/&mdash;/g, '—').replace(/\s+/g, ' ').trim();
const decode = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/* ── fixtures (serving listPurchaseOrders projection) ── */
const base = { supplierId: 'sup1', supplierBusinessId: null, buyerBusinessId: 'biz1', subtotal: 1000,
  expectedDelivery: null, approvedAt: null, sentAt: null, delivery: null };
const PO = (o) => Object.assign({}, base, o);
const HOSTILE_ID = `po_x"><img src=x onerror=alert(1)>',alert(2),'`;
const ITEMS = [
  PO({ poId: 'po_draft', poNumber: 'PO-0001', status: 'draft', supplierName: 'Kilimo Ltd', itemCount: 2, vatAmount: 160, total: 1160, createdAt: { _seconds: 1790000000, _nanoseconds: 0 } }),
  PO({ poId: 'po_pend', poNumber: 'PO-0002', status: 'pending_approval', supplierName: 'Maji Co', itemCount: 1, vatAmount: null, total: 1000, vatBasis: 'unknown_supplier_status', createdAt: '2026-09-30T10:00:00.000Z' }),
  PO({ poId: 'po_rcv', poNumber: 'PO-0003', status: 'received', supplierName: 'Maji Co', itemCount: 3, vatAmount: 0, total: 500, createdAt: { toDate: () => new Date('2026-08-01T00:00:00Z') } }),
  PO({ poId: 'po_paid', poNumber: 'PO-0004', status: 'paid', supplierName: 'Kilimo Ltd', itemCount: 1, vatAmount: 16, total: 116, createdAt: null }),
  PO({ poId: 'po_sent', poNumber: 'PO-0005', status: 'sent', supplierName: 'Kilimo Ltd', itemCount: 1, vatAmount: null, total: null, createdAt: null }),
];
const LIST = { merchantId: 'biz1', items: ITEMS, count: ITEMS.length, nextCursor: null };
const ALL_STATUS = { draft: 'Draft', pending_approval: 'Awaiting approval', approved: 'Approved', sent: 'Sent',
  partially_received: 'Partly received', received: 'Awaiting invoice', invoiced: 'Invoiced',
  paid: 'Recorded – unverified', cancelled: 'Cancelled' };
const failedPrecondition = () => Object.assign(new Error('9 FAILED_PRECONDITION: The query requires an index.'), { code: 'functions/failed-precondition' });

/* ── loader ── */
function loadPortal (html) {
  const m = html.match(/<script>\s*(const ProcurementPortal = [\s\S]*?)<\/script>/);
  if (!m) throw new Error('ProcurementPortal script not found');
  const els = {}, calls = [], toasts = [], listeners = {}, confirms = [];
  const el = (id) => els[id] || (els[id] = { id, innerHTML: '', textContent: '', value: '', attrs: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute (k, v) { this.attrs[k] = String(v); }, getAttribute (k) { return this.attrs[k]; },
    addEventListener (t, f) { (listeners[id + ':' + t] = listeners[id + ':' + t] || []).push(f); }, appendChild () {} });
  const replies = {};
  const document = {
    getElementById: el,
    querySelectorAll: () => [],
    addEventListener: (t, f) => { (listeners['doc:' + t] = listeners['doc:' + t] || []).push(f); },
    createElement: () => ({ style: {}, remove () {}, set textContent (v) { toasts.push(v); } }),
    body: { appendChild () {} },
  };
  const firebase = {
    firestore: () => ({ collection: (c) => { calls.push({ name: 'firestore:' + c }); throw new Error('firestore read not expected: ' + c); } }),
    functions: () => ({ httpsCallable: (name) => async (payload) => {
      calls.push({ name, payload });
      const r = replies[name];
      if (r === undefined) throw new Error('not-found');
      const v = typeof r === 'function' ? r(payload) : r;
      return { data: v };
    } }),
    auth: () => ({ onAuthStateChanged () {} }),
  };
  const win = { location: {}, confirmAnswer: true, confirm (msg) { confirms.push(msg); return win.confirmAnswer; } };
  const ctx = vm.createContext({ document, firebase, window: win, console, setTimeout: () => 0, Object, Array, String, Number, Date, JSON, Math, isFinite, Set });
  vm.runInContext(m[1] + '\n;this.ProcurementPortal = ProcurementPortal;', ctx, { filename: 'procurement.html#inline' });
  (listeners['doc:DOMContentLoaded'] || []).forEach((f) => f());
  /* Simulate a click on the first element in container `id` carrying attribute `attr`
     (optionally with a given decoded value) — as a browser would, the attribute value
     reaches the handler HTML-decoded. */
  const click = async (id, attr, value) => {
    const re = new RegExp(attr + '="([^"]*)"', 'g');
    let mm, found = null;
    while ((mm = re.exec(el(id).innerHTML))) { if (value === undefined || decode(mm[1]) === value) { found = decode(mm[1]); break; } }
    if (found === null) return false;
    const btn = { disabled: false, hasAttribute: (a) => a === attr, getAttribute: (a) => (a === attr ? found : null) };
    const target = { closest: (sel) => (sel.includes('[' + attr + ']') ? btn : null) };
    for (const f of listeners[id + ':click'] || []) await f({ target });
    return true;
  };
  return { P: ctx.ProcurementPortal, els, calls, toasts, replies, confirms, win, el, click };
}

const poRows = (tb) => tb.split('<tr').slice(1).filter((r) => r.includes('data-po-row='));
const rowText = (tb, poNumber) => strip(poRows(tb).find((r) => r.includes(poNumber)) || '');
const stateOf = (tb) => { const mm = tb.match(/data-po-state="([a-z]+)"/); return mm ? mm[1] : null; };

async function boot (html) {
  const T = loadPortal(html);
  T.el('midInput').value = 'biz1';
  T.replies.getProcurementDashboard = { openPOs: { count: 1 }, pendingApproval: { count: 1 }, goodsToReceive: { count: 0 } };
  T.P.load();
  return T;
}

/* ── rows (run against any (html, supply) pair so the deliberate breaks hit the SAME rows) ── */
async function runRows (html, supplySrc) {
  const res = {};
  const row = (id, ok, got) => { res[id] = { ok: !!ok, got }; };

  /* P1 — populated mapping */
  let T = await boot(html);
  T.replies.listPurchaseOrders = LIST;
  T.calls.length = 0;
  await T.P.loadPOs('biz1', 'All');
  let tb = T.els['po-tbody'].innerHTML;
  const draftAttr = (tb.match(/data-approve-po="([^"]*)"/) || [])[1];
  const pendRow = poRows(tb).find((r) => r.includes('PO-0002')) || '';
  row('P1  Purchase Orders response mapping: poId → row id / action id, createdAt ({_seconds} | ISO | Timestamp) → date',
    poRows(tb).length === 5 && draftAttr === 'po_draft' && /data-po-row="po_draft"/.test(tb) &&
    rowText(tb, 'PO-0001').includes('2026-09-21') && rowText(tb, 'PO-0002').includes('2026-09-30') &&
    rowText(tb, 'PO-0003').includes('2026-08-01') && /data-approve-po="po_pend"/.test(pendRow),
    { rows: poRows(tb).length, draftAttr, r1: rowText(tb, 'PO-0001'), r3: rowText(tb, 'PO-0003') });

  /* P2 — the canonical read, real params */
  const lp = T.calls.filter((c) => c.name === 'listPurchaseOrders');
  await T.P.loadPOs('biz1', 'received');
  const lp2 = T.calls.filter((c) => c.name === 'listPurchaseOrders').pop();
  row('P2  calls listPurchaseOrders {merchantId, limit:50[, status]} — never getProcurementDashboard{listPOs}',
    lp.length === 1 && lp[0].payload.merchantId === 'biz1' && lp[0].payload.limit === 50 && !('status' in lp[0].payload) &&
    !('listPOs' in lp[0].payload) && lp2.payload.status === 'received' &&
    !T.calls.some((c) => c.name === 'getProcurementDashboard' && c.payload && 'listPOs' in c.payload) && !/listPOs/.test(html.replace(/\/\*[\s\S]*?\*\//g, '')),
    { first: lp[0] && lp[0].payload, filtered: lp2 && lp2.payload });

  /* P3 — TRUE empty */
  T = await boot(html);
  T.replies.listPurchaseOrders = { merchantId: 'biz1', items: [], count: 0, nextCursor: null };
  await T.P.loadPOs('biz1', 'All');
  tb = T.els['po-tbody'].innerHTML;
  row('P3  genuine empty (op succeeded, zero records) → "No purchase orders yet"',
    stateOf(tb) === 'empty' && strip(tb) === 'No purchase orders yet', strip(tb));

  /* P4 — error ≠ empty */
  T = await boot(html);
  T.replies.listPurchaseOrders = () => { throw failedPrecondition(); };
  await T.P.loadPOs('biz1', 'All');
  tb = T.els['po-tbody'].innerHTML;
  const errTb = tb;
  T.replies.listPurchaseOrders = LIST;
  const retried = await T.click('po-tbody', 'data-po-retry');
  row('P4  error ≠ empty: a failed read shows the server message + Retry, never "No purchase orders"; Retry reloads',
    stateOf(errTb) === 'error' && errTb.includes('FAILED_PRECONDITION: The query requires an index.') &&
    /data-po-retry/.test(errTb) && !/No purchase orders/.test(errTb) && retried && poRows(T.els['po-tbody'].innerHTML).length === 5,
    strip(errTb));

  /* P5 — malformed responses */
  const shapes = { legacyDash: { purchaseOrders: [{ id: 'x' }] }, nullData: null, itemsNotArray: { items: 'x' },
    noPoId: { items: [{ id: 'po_x', status: 'draft' }], nextCursor: null }, badCursor: { items: [], nextCursor: 7 } };
  const got5 = {};
  for (const [k, v] of Object.entries(shapes)) {
    T = await boot(html);
    T.replies.listPurchaseOrders = () => v;
    await T.P.loadPOs('biz1', 'All');
    got5[k] = stateOf(T.els['po-tbody'].innerHTML);
  }
  row('P5  malformed response (legacy {purchaseOrders}, null, non-array, item without poId, bad cursor) → error state, never empty',
    Object.values(got5).every((s) => s === 'error'), got5);

  /* P6 — status labels */
  T = await boot(html);
  const every = Object.keys(ALL_STATUS).map((s, i) => PO({ poId: 'p_' + s, poNumber: 'N-' + i, status: s, supplierName: 'S', itemCount: 1, vatAmount: 1, total: 10, createdAt: null }));
  T.replies.listPurchaseOrders = { items: every, count: every.length, nextCursor: null };
  await T.P.loadPOs('biz1', 'All');
  tb = T.els['po-tbody'].innerHTML;
  const lab = Object.fromEntries(Object.keys(ALL_STATUS).map((s, i) => [s, rowText(tb, 'N-' + i)]));
  const supplyLab = (() => {
    const w = { console }; w.window = w; const c = vm.createContext(w);
    vm.runInContext(supplySrc, c, { filename: 'sokoni-merchant-supply.js' });
    const cols = c.SokoniMerchantSupply._invoiceUi.PO_COLS;
    const st = cols.find((x) => x.h === 'Status').f, tot = cols.find((x) => x.h === 'Total').f;
    return { received: st({ status: 'received' }), paid: st({ status: 'paid' }), draft: st({ status: 'draft' }),
      vatNull: tot({ total: 1000, vatAmount: null }), vatKnown: tot({ total: 1160, vatAmount: 160 }), totalNull: tot({ total: null }) };
  })();
  row('P6  paid-state protection + labels: received → "Awaiting invoice", legacy paid → "Recorded – unverified", no "Paid" (procurement.html + supply)',
    Object.keys(ALL_STATUS).every((s) => lab[s].includes(ALL_STATUS[s])) && !/\bPaid\b/.test(lab.paid) &&
    supplyLab.received === 'Awaiting invoice' && supplyLab.paid === 'Recorded – unverified' && supplyLab.draft === 'Draft',
    { paid: lab.paid, received: lab.received, supplyLab });

  /* P7 — Approve */
  T = await boot(html);
  T.replies.listPurchaseOrders = { items: every, count: every.length, nextCursor: null };
  await T.P.loadPOs('biz1', 'All');
  tb = T.els['po-tbody'].innerHTML;
  const approveIds = [...tb.matchAll(/data-approve-po="([^"]*)"/g)].map((x) => x[1]).sort();
  T.replies.approvePurchaseOrder = (p) => ({ poId: p.poId, status: 'approved' });
  T.win.confirmAnswer = false; T.calls.length = 0;
  await T.click('po-tbody', 'data-approve-po', 'p_draft');
  const declined = T.calls.filter((c) => c.name === 'approvePurchaseOrder').length;
  T.win.confirmAnswer = true; T.toasts.length = 0;
  await T.click('po-tbody', 'data-approve-po', 'p_draft');
  const ap = T.calls.find((c) => c.name === 'approvePurchaseOrder');
  const okToast = T.toasts[0];
  T.replies.approvePurchaseOrder = () => { throw new Error("Cannot approve a PO in status 'approved'."); };
  T.toasts.length = 0;
  await T.click('po-tbody', 'data-approve-po', 'p_pending_approval');
  row('P7  Approve offered on draft AND pending_approval only; confirm first; server refusal shown verbatim',
    JSON.stringify(approveIds) === JSON.stringify(['p_draft', 'p_pending_approval']) && declined === 0 &&
    T.confirms.length >= 2 && /not a payment/.test(T.confirms[0]) &&
    ap && ap.payload.poId === 'p_draft' && ap.payload.approved === true && okToast === 'PO approved' &&
    T.toasts[0] === "Not approved: Cannot approve a PO in status 'approved'.",
    { approveIds, declined, ap: ap && ap.payload, okToast, refusal: T.toasts[0] });

  /* P8 — manipulated PO id */
  T = await boot(html);
  T.replies.listPurchaseOrders = { items: [PO({ poId: HOSTILE_ID, poNumber: '<script>alert(3)</script>', status: 'draft', supplierName: '<b>x</b>', itemCount: 1, vatAmount: 1, total: 1, createdAt: '<img src=y>' })], count: 1, nextCursor: null };
  T.replies.approvePurchaseOrder = (p) => ({ poId: p.poId, status: 'approved' });
  await T.P.loadPOs('biz1', 'All');
  tb = T.els['po-tbody'].innerHTML;
  T.calls.length = 0;
  await T.click('po-tbody', 'data-approve-po');
  const hp = T.calls.find((c) => c.name === 'approvePurchaseOrder');
  row('P8  manipulated PO id/text escaped, no inline handler; the id reaches the server as inert data',
    !/<img|<script>|<b>/.test(tb) && !/onclick/i.test(tb) && tb.includes('&lt;script&gt;') &&
    !!hp && hp.payload.poId === HOSTILE_ID, { tb: tb.slice(0, 300), sent: hp && hp.payload.poId });

  /* P9 — no client-controlled payment state */
  const poSection = html.slice(html.indexOf('/* ── Purchase Orders ──'), html.indexOf('/* ── Suppliers ── */'));
  const payloadKeys = new Set();
  [T].forEach((t) => t.calls.forEach((c) => Object.keys((c && c.payload) || {}).forEach((k) => payloadKeys.add(k))));
  row('P9  no paid state settable from the PO UI: no payment fields sent, no pay/verify callable, no Pay button',
    !['status', 'paymentStatus', 'paymentVerified', 'paidAt', 'paidAmount'].some((k) => payloadKeys.has(k)) &&
    !/markSupplierInvoicePaidVerified|approveAndPayInvoice/.test(poSection) &&
    !/>\s*(Pay|Mark (as )?paid)\s*</i.test(poSection) && /approvePurchaseOrder'\)\(\{merchantId: mid, poId, approved: yes\}\)/.test(poSection),
    [...payloadKeys]);

  /* P10 — totals/counts honesty + VAT */
  T = await boot(html);
  T.replies.listPurchaseOrders = LIST;
  await T.P.loadPOs('biz1', 'All');
  tb = T.els['po-tbody'].innerHTML;
  const foot = strip((tb.match(/data-po-state="footer">([\s\S]*?)<\/td>/) || [])[1] || '');
  row('P10 "N listed" (a page, not a total); vatAmount null → "VAT per supplier’s tax invoice"; total null → "—"; no summed total',
    /^5 listed · end of list$/.test(foot) && rowText(tb, 'PO-0002').includes('VAT per supplier’s tax invoice') &&
    !rowText(tb, 'PO-0001').includes('VAT per') && /— Sent/.test(rowText(tb, 'PO-0005')) && !/KES 0\.00/.test(tb) &&
    !/2,776|2776/.test(tb) && supplyLab.vatNull === 'KES 1,000 · VAT per supplier’s tax invoice' && supplyLab.vatKnown === 'KES 1,160' && supplyLab.totalNull === '—',
    { foot, p2: rowText(tb, 'PO-0002'), p5: rowText(tb, 'PO-0005'), supplyLab });

  /* P11 — pagination via the op's cursor */
  T = await boot(html);
  T.replies.listPurchaseOrders = (p) => p.cursor === 'po_pend'
    ? { items: ITEMS.slice(2), count: 3, nextCursor: null }
    : { items: ITEMS.slice(0, 2), count: 2, nextCursor: 'po_pend' };
  await T.P.loadPOs('biz1', 'draft');
  const tbA = T.els['po-tbody'].innerHTML;
  T.calls.length = 0;
  await T.click('po-tbody', 'data-po-more');
  const more = T.calls.find((c) => c.name === 'listPurchaseOrders');
  const tbB = T.els['po-tbody'].innerHTML;
  row('P11 pagination: nextCursor → "Load more" sends {cursor, same status}; rows append; end of list after',
    /2 listed · more exist/.test(strip(tbA)) && /data-po-more/.test(tbA) && more && more.payload.cursor === 'po_pend' &&
    more.payload.status === 'draft' && poRows(tbB).length === 5 && /5 listed · end of list/.test(strip(tbB)),
    { a: strip(tbA).slice(-60), more: more && more.payload, b: strip(tbB).slice(-40) });

  /* P12 — dashboard FAILED_PRECONDITION → error state with Retry (coordinator 2026-10-04) */
  T = await boot(html);
  T.replies.getProcurementDashboard = () => { throw failedPrecondition(); };
  await T.P.loadDashboard('biz1');
  const ds = T.el('dash-state');
  const errState = ds.getAttribute('data-dash-state'), errHtml = ds.innerHTML;
  const kpis = ['kpi-open', 'kpi-approval', 'kpi-grn', 'kpi-invoices', 'kpi-claimed'].map((k) => T.els[k].textContent);
  const reorder = T.els['reorder-tbody'].innerHTML;
  T.replies.getProcurementDashboard = { openPOs: { count: 0 }, pendingApproval: { count: 0 }, goodsToReceive: { count: 0 } };
  const retriedD = await T.click('dash-state', 'data-dash-retry');
  row('P12 dashboard FAILED_PRECONDITION → error state (server message + Retry), every KPI "—" not 0; Retry reloads',
    errState === 'error' && errHtml.includes('FAILED_PRECONDITION') && /data-dash-retry/.test(errHtml) &&
    kpis.every((v) => v === '—') && /data-dash-state="error"/.test(reorder) && !/No reorder alerts/.test(reorder) &&
    retriedD && ds.getAttribute('data-dash-state') === 'data' && T.els['kpi-open'].textContent === '0',
    { errState, kpis, after: ds.getAttribute('data-dash-state') });

  return res;
}

(async () => {
  let pass = 0, fail = 0;
  const html = read('procurement.html'), supply = read('sokoni-merchant-supply.js');
  const real = await runRows(html, supply);
  for (const [id, r] of Object.entries(real)) {
    console.log('  ' + (r.ok ? 'PASS  ' : 'FAIL  ') + id + (r.ok ? '' : '   [got ' + JSON.stringify(r.got).slice(0, 600) + ']'));
    r.ok ? pass++ : fail++;
  }

  /* Deliberate breaks (owner gate 6): each mutation MUST fail its named row. */
  const control = async (label, prefix, h, s) => {
    if (h === html && s === supply) { console.log('  FAIL  ' + label + ' — mutation did not apply'); fail++; return; }
    let r;
    try { r = await runRows(h, s); } catch (e) { console.log('  FAIL  ' + label + ' — crashed (' + e.message + '); a crash is not a refusal'); fail++; return; }
    const id = Object.keys(r).find((k) => k.startsWith(prefix));
    const ok = id && r[id].ok === false;
    console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + ' → ' + prefix + (ok ? ' fails' : ' still passes'));
    ok ? pass++ : fail++;
  };
  await control('B1  Purchase Orders response mapping: map from id instead of poId', 'P1',
    html.replace('id:              po.poId,', 'id:              po.id,'), supply);
  await control('B2  paid-state protection: render "Paid" for status paid without verification', 'P6',
    html.replace("paid:'Recorded – unverified'", "paid:'Paid'"), supply);
  await control('B3  paid-state protection (supply surface): PO paid → "Paid"', 'P6',
    html, supply.replace("paid: 'Recorded – unverified'", "paid: 'Paid'"));
  await control('B4  error rendered as empty (catch → items = [])', 'P4',
    html.replace('      poView.error = _errText(e);\n    }\n    poView.loading = false;', '      poView.items = [];\n    }\n    poView.loading = false;'), supply);
  await control('B5  dashboard failure swallowed to a toast (pre-fix behaviour)', 'P12',
    html.replace("      _dashState('error', 'Could not load procurement figures: ' + msg +", "      _toast('Dashboard error: ' + msg); _dashState('idle', '' +"), supply);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (fail closed):', e && e.stack || e); process.exit(2); });
