#!/usr/bin/env node
'use strict';
/**
 * CERT — procurement purchase orders never INFER VAT (2026-10-03).
 *
 * DEFECT CLOSED
 *   functions/procurement.js held `VAT_RATE = 0.16` and createPurchaseOrder charged it on
 *   every PO; the PO email and PDF printed "VAT (16%)" whenever no rate was stored. That
 *   turned "KRA's general rate is 16%" into "16% on every supplier" — the exact move
 *   docs/VAT_POLICY_2026-09-30.md forbids. A supplier→merchant supply follows the SUPPLIER's
 *   own VAT status (etimsProfiles/{ownerUid}.vatStatus); unresolved ⇒ no VAT figure.
 *
 * METHOD
 *   The REAL procurement.js (with the real merchant-authority / tenant-identity / po-pdf /
 *   etims-tax-engine) is executed against an in-memory Firestore double. Hermetic: the
 *   firebase-admin module is replaced by a stub before load, nothing touches a network.
 *   Every row is NAMED. Two negative controls recompile procurement.js with the defect put
 *   back and require a NAMED row to fail:
 *     (a) restore the 16% inference                  → UNKNOWN_EXTERNAL must fail
 *     (b) treat an unknown status as 'registered'    → UNKNOWN_EXTERNAL must fail
 *   A control that does not make its named row fail fails the suite.
 */
const fs     = require('fs');
const path   = require('path');
const Module = require('module');

const ROOT    = path.resolve(__dirname, '..');
const PROC_P  = path.join(ROOT, 'functions/procurement.js');
const PROC    = fs.readFileSync(PROC_P, 'utf8');
const PDF_SRC = fs.readFileSync(path.join(ROOT, 'functions/po-pdf.js'), 'utf8');
const Tax     = require(path.join(ROOT, 'functions/etims-tax-engine.js'));
const { buildPoPdf, poVatPresentation } = require(path.join(ROOT, 'functions/po-pdf.js'));

/* ── fixture ─────────────────────────────────────────────────────────────── */
const BUYER = 'SOK-BUYER1', BUYER_UID = 'uid-buyer';
const SUPPLIERS = {
  registered: { biz: 'SOK-REG001', uid: 'uid-reg',  profile: { status: 'active', vatStatus: 'registered' } },
  zero:       { biz: 'SOK-ZER001', uid: 'uid-zero', profile: { status: 'active', vatStatus: 'zero_rated' } },
  exempt:     { biz: 'SOK-EXE001', uid: 'uid-exe',  profile: { status: 'active', vatStatus: 'exempt' } },
  noprofile:  { biz: 'SOK-NOP001', uid: 'uid-nop',  profile: null },
  inactive:   { biz: 'SOK-INA001', uid: 'uid-ina',  profile: { status: 'pending', vatStatus: 'registered' } },
  garbage:    { biz: 'SOK-GAR001', uid: 'uid-gar',  profile: { status: 'active', vatStatus: 'sixteen' } },
};

function baseData() {
  const d = {
    businesses: { [BUYER]: { ownerId: BUYER_UID, status: 'active', name: 'Buyer Ltd' } },
    procSuppliers: {
      'sup_external': { supplierId: 'sup_external', merchantId: BUYER, status: 'active',
                        name: 'Corner Hardware', supplierBusinessId: null },
    },
    etimsProfiles: {}, procPurchaseOrders: {}, procSupplierInvoices: {}, procGRN: {},
    workspaceMemberships: {}, procCounters: {}, securityAuditLog: {},
  };
  for (const [k, s] of Object.entries(SUPPLIERS)) {
    d.businesses[s.biz] = { ownerId: s.uid, status: 'active', name: 'Supplier ' + k,
                            supply: { enabled: true } };
    d.procSuppliers['sup_' + k] = { supplierId: 'sup_' + k, merchantId: BUYER, status: 'active',
                                    name: 'Supplier ' + k, supplierBusinessId: s.biz };
    if (s.profile) d.etimsProfiles[s.uid] = Object.assign({ sellerUid: s.uid }, s.profile);
  }
  return d;
}

/* ── in-memory Firestore + stub admin ────────────────────────────────────── */
function makeAdmin(data) {
  let autoId = 0;
  const bag = (n) => (data[n] = data[n] || {});
  const mkRef = (n, id) => ({
    id,
    async get() { const v = bag(n)[id]; return { exists: v !== undefined, id, data: () => v, ref: mkRef(n, id) }; },
    async set(v, o) { bag(n)[id] = (o && o.merge) ? Object.assign({}, bag(n)[id], v) : v; },
    async update(v) { if (bag(n)[id] === undefined) throw new Error('not-found'); bag(n)[id] = Object.assign({}, bag(n)[id], v); },
    async create(v) { if (bag(n)[id] !== undefined) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } bag(n)[id] = v; },
  });
  const getPath = (o, p) => String(p).split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  function q(n, conds, lim) {
    return {
      where(f, op, v) { return q(n, conds.concat([[f, op, v]]), lim); },
      orderBy() { return q(n, conds, lim); }, startAfter() { return q(n, conds, lim); },
      select() { return q(n, conds, lim); }, limit(k) { return q(n, conds, k); },
      async get() {
        let ids = Object.keys(bag(n)).sort().filter((id) => conds.every(([f, op, v]) => {
          if (f && f.__docId) return true;
          const x = getPath(bag(n)[id], f);
          return op === '==' ? x === v : op === 'in' ? (v || []).includes(x) : true;
        }));
        if (lim) ids = ids.slice(0, lim);
        const docs = ids.map((id) => ({ id, data: () => bag(n)[id], ref: mkRef(n, id) }));
        return { empty: !docs.length, size: docs.length, docs, forEach: (f) => docs.forEach(f) };
      },
    };
  }
  const fsFn = () => ({
    collection(n) {
      return Object.assign(q(n, [], null), {
        doc: (id) => mkRef(n, id == null ? 'auto' + (++autoId) : id),
        async add(v) { const id = 'auto' + (++autoId); bag(n)[id] = v; return mkRef(n, id); },
      });
    },
    async runTransaction(fn) {
      return fn({
        get: (r) => r.get(), set: (r, v, o) => { r.set(v, o); }, update: (r, v) => { r.update(v); },
        create: (r, v) => r.create(v),
      });
    },
    batch() { const ops = []; return { set: (r, v, o) => ops.push(() => r.set(v, o)), update: (r, v) => ops.push(() => r.update(v)), commit: async () => { for (const o of ops) await o(); } }; },
  });
  fsFn.FieldValue = { serverTimestamp: () => 'TS', increment: (n) => ({ __inc: n }), arrayUnion: (...a) => a, delete: () => undefined };
  fsFn.Timestamp  = { fromDate: (d) => d, now: () => new Date() };
  fsFn.FieldPath  = { documentId: () => ({ __docId: true }) };
  return { firestore: fsFn, auth: () => ({}), storage: () => ({}), messaging: () => ({}),
           apps: [{}], initializeApp() {}, credential: { applicationDefault() {} } };
}

function loadProcurement(data, srcOverride) {
  const stub = makeAdmin(data);
  const orig = Module._load;
  Module._load = function (req) { if (req === 'firebase-admin') return stub; return orig.apply(this, arguments); };
  try {
    Object.keys(require.cache).forEach((k) => { if (k.startsWith(path.join(ROOT, 'functions')) && !/node_modules/.test(k)) delete require.cache[k]; });
    if (srcOverride) {
      const m = new Module(PROC_P, null);
      m.filename = PROC_P;
      m.paths = Module._nodeModulePaths(path.dirname(PROC_P));
      m._compile(srcOverride, PROC_P);
      return m.exports;
    }
    return require(PROC_P);
  } finally { Module._load = orig; }
}

const auth = (uid, token) => ({ uid, token: token || {} });
const call = (P, op, a, d) => P[op].run({ auth: a, data: d || {} });
async function verdict(fn) { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, code: e && e.code, message: e && e.message }; } }
const ITEMS = [{ productId: 'p1', name: 'Maize 2kg', qty: 10, unitCost: 125 },
               { productId: 'p2', name: 'Oil 5L',    qty: 3,  unitCost: 900.5 }];
const SUBTOTAL = 10 * 125 + +(3 * 900.5).toFixed(2);   /* 3951.5 */
const pdfText = (po) => buildPoPdf(po, { name: 'S' }, { name: 'B' }).toString('latin1');

async function createFor(P, data, key, extra) {
  const r = await call(P, 'createPurchaseOrder', auth(BUYER_UID),
    Object.assign({ merchantId: BUYER, supplierId: 'sup_' + key, items: ITEMS }, extra || {}));
  return { ret: r, doc: data.procPurchaseOrders[r.poId] };
}

/* RFQ-shaped PO, exactly the fields functions/rfq.js (functions/b2b-rfq-on-e61c73e @ 6f62a69)
   writes in its accept transaction — not via createPurchaseOrder. */
function rfqPo(id, vatRate) {
  const sub = 5000, vat = Math.round(sub * vatRate) / 100, fee = 300;
  return { poId: id, poNumber: 'RFQ-ABCD1234', merchantId: BUYER, supplierId: 'sup_registered',
    supplierName: 'Supplier registered', buyerBusinessId: BUYER, supplierBusinessId: SUPPLIERS.registered.biz,
    items: [{ productId: 'rfq_line_1', sku: '', name: 'Cement', qty: 10, unitCost: 500, totalCost: 5000 }],
    subtotal: sub, vatAmount: vat, vatRate, vatBasis: 'declared_on_quote', deliveryFee: fee,
    total: Math.round((sub + vat + fee) * 100) / 100, source: { kind: 'rfq', rfqId: 'rfq1', quoteVersion: 1 },
    status: 'draft', paymentStatus: 'unpaid', notes: 'From RFQ', createdBy: BUYER_UID };
}
function legacyPo(id) {
  return { poId: id, poNumber: 'PO-2026-00001', merchantId: BUYER, supplierId: 'sup_external',
    supplierName: 'Corner Hardware', buyerBusinessId: BUYER, supplierBusinessId: null,
    items: [{ productId: 'p1', name: 'Old', qty: 1, unitCost: 1000, totalCost: 1000 }],
    subtotal: 1000, vatAmount: 160, total: 1160, vatRate: 16, status: 'sent' };
}

/* ── ROWS (each named; each returns true/false) ──────────────────────────── */
const ROWS = [
  ['REGISTERED_ENGINE_RATE', 'registered supplier → VAT at the tax engine rate, category A', async (P, d) => {
    const { ret, doc } = await createFor(P, d, 'registered');
    const vat = Tax.r2(SUBTOTAL * Tax.DEFAULTS.vatRate);
    return doc.vatBasis === 'supplier_registered' && doc.vatCategory === 'A' &&
      doc.vatAmount === vat && doc.vatRate === Math.round(Tax.DEFAULTS.vatRate * 10000) / 100 &&
      doc.total === Tax.r2(SUBTOTAL + vat) && ret.vatAmount === vat && ret.total === doc.total;
  }],
  ['ZERO_RATED_LABELLED', 'zero_rated supplier → VAT 0, rate 0, category B, labelled zero-rated', async (P, d) => {
    const { doc } = await createFor(P, d, 'zero');
    const s = pdfText(doc);
    return doc.vatBasis === 'supplier_zero_rated' && doc.vatCategory === 'B' && doc.vatAmount === 0 &&
      doc.vatRate === 0 && doc.total === SUBTOTAL && s.includes('VAT \\(zero-rated, 0%\\)') && !s.includes('16%');
  }],
  ['EXEMPT_NO_VAT_LINE', 'exempt supplier → no VAT figure line, category C, labelled exempt', async (P, d) => {
    const { doc } = await createFor(P, d, 'exempt');
    const s = pdfText(doc);
    return doc.vatBasis === 'supplier_exempt' && doc.vatCategory === 'C' && doc.vatAmount === 0 &&
      doc.vatRate === null && doc.total === SUBTOTAL && s.includes('VAT: exempt supply') &&
      !s.includes('VAT \\(') && !s.includes('16%');
  }],
  ['UNKNOWN_EXTERNAL', 'external supplier → vatAmount null, total = subtotal, vatBasis unknown', async (P, d) => {
    const { ret, doc } = await createFor(P, d, 'external');
    return doc.vatBasis === 'unknown_supplier_status' && doc.vatAmount === null && doc.vatRate === null &&
      doc.vatCategory === null && doc.total === SUBTOTAL && doc.vatStatusReason === 'external_supplier' &&
      ret.vatAmount === null && ret.total === SUBTOTAL;
  }],
  ['UNKNOWN_NO_PROFILE', 'SOKONI supplier with no eTIMS profile → unknown, never a default', async (P, d) => {
    const { doc } = await createFor(P, d, 'noprofile');
    return doc.vatBasis === 'unknown_supplier_status' && doc.vatAmount === null && doc.vatStatusReason === 'no_etims_profile';
  }],
  ['UNKNOWN_INACTIVE_PROFILE', 'inactive eTIMS profile → unknown', async (P, d) => {
    const { doc } = await createFor(P, d, 'inactive');
    return doc.vatBasis === 'unknown_supplier_status' && doc.vatAmount === null && doc.vatStatusReason === 'etims_profile_not_active';
  }],
  ['UNKNOWN_UNRECOGNISED_STATUS', 'unrecognised vatStatus → unknown (NOT the engine\'s exempt fallback)', async (P, d) => {
    const { doc } = await createFor(P, d, 'garbage');
    return doc.vatBasis === 'unknown_supplier_status' && doc.vatAmount === null && doc.vatCategory === null;
  }],
  ['CLIENT_VAT_IGNORED', 'client-supplied vatRate / vatAmount / total / vatBasis are ignored', async (P, d) => {
    const { ret, doc } = await createFor(P, d, 'external',
      { vatRate: 16, vatAmount: 999, total: 1, subtotal: 1, vatBasis: 'supplier_registered' });
    return doc.vatAmount === null && doc.vatRate === null && doc.total === SUBTOTAL &&
      doc.subtotal === SUBTOTAL && doc.vatBasis === 'unknown_supplier_status' && ret.vatAmount === null;
  }],
  ['RETURN_SHAPE_KEPT', 'createPurchaseOrder still returns {poId, poNumber, subtotal, vatAmount, total}', async (P, d) => {
    const { ret } = await createFor(P, d, 'external');
    return ['poId', 'poNumber', 'subtotal', 'vatAmount', 'total'].every((k) => k in ret) && 'vatBasis' in ret;
  }],
  ['PDF_UNKNOWN_NO_16', 'PDF + email for an unknown-VAT PO: "per supplier\'s tax invoice", never 16%', async (P, d) => {
    const { doc } = await createFor(P, d, 'external');
    const s = pdfText(doc);
    const html = P._poEmailHtml(doc, doc.poId, { name: 'S' }, { name: 'B' });
    return s.includes("VAT: per supplier's tax invoice") && !s.includes('16%') && !/VAT \\\(/.test(s) &&
      /per supplier&#39;s tax invoice/.test(html) && !html.includes('16%');
  }],
  ['PDF_ABSENT_RATE_NOT_DEFAULTED', 'a PO with a VAT figure but no stored rate prints no rate (no 16 default)', async () => {
    const s = pdfText({ poNumber: 'X', items: [], subtotal: 100, vatAmount: 5, total: 105 });
    return !s.includes('16%') && s.includes('\\(VAT\\)') === false && s.includes('VAT');
  }],
  ['RFQ_DECLARED_THROUGH_READERS', 'RFQ-shaped PO (declared_on_quote 16 + delivery) survives every reader', async (P, d) => {
    const po = rfqPo('po_rfq_1', 16); d.procPurchaseOrders[po.poId] = po;
    const g = await call(P, 'getPurchaseOrder', auth(BUYER_UID), { poId: po.poId });
    const l = await call(P, 'listPurchaseOrders', auth(BUYER_UID), { merchantId: BUYER });
    const row = (l.items || []).find((x) => x.poId === po.poId) || {};
    const ib = await call(P, 'getInboundSupplyOrders', auth(SUPPLIERS.registered.uid),
      { supplierBusinessId: SUPPLIERS.registered.biz });
    const io = (ib.orders || []).find((x) => x.poId === po.poId) || {};
    const ap = await call(P, 'approvePurchaseOrder', auth(BUYER_UID, { manager: true }), { poId: po.poId, approved: true });
    const s = pdfText(d.procPurchaseOrders[po.poId]);
    const html = P._poEmailHtml(d.procPurchaseOrders[po.poId], po.poId, {}, {});
    const inv = await call(P, 'createSupplierInvoice', auth(BUYER_UID),
      { poId: po.poId, invoiceNumber: 'INV-R1', amount: 5300, vatAmount: 800 });
    const invDoc = d.procSupplierInvoices[inv.invoiceId] || {};
    return g.vatBasis === 'declared_on_quote' && g.vatRate === 16 && g.vatAmount === 800 && g.deliveryFee === 300 &&
      row.vatBasis === 'declared_on_quote' && row.vatAmount === 800 &&
      io.vatBasis === 'declared_on_quote' && io.vatRate === 16 && io.vatAmount === 800 &&
      ap.status === 'approved' && d.procPurchaseOrders[po.poId].vatAmount === 800 &&
      s.includes('VAT \\(16%, as quoted\\)') && s.includes('Delivery') &&
      html.includes('VAT (16%, as quoted)') && html.includes('Delivery') &&
      invDoc.poMatchedOn === 'total' && invDoc.vatSource === 'supplier_invoice' && invDoc.vatAmount === 800;
  }],
  ['RFQ_DECLARED_ZERO', 'RFQ-shaped PO declared 0% is printed as quoted, never re-rated', async (P, d) => {
    const po = rfqPo('po_rfq_0', 0); d.procPurchaseOrders[po.poId] = po;
    const g = await call(P, 'getPurchaseOrder', auth(BUYER_UID), { poId: po.poId });
    const s = pdfText(po);
    return g.vatAmount === 0 && g.vatRate === 0 && s.includes('VAT \\(0%, as quoted\\)') && !s.includes('16%');
  }],
  ['LEGACY_RENDERED_AS_STORED', 'legacy PO (vatRate 16, no vatBasis) renders as stored and matches total-to-total', async (P, d) => {
    const po = legacyPo('po_legacy'); d.procPurchaseOrders[po.poId] = po;
    const g = await call(P, 'getPurchaseOrder', auth(BUYER_UID), { poId: po.poId });
    const s = pdfText(po);
    const inv = await call(P, 'createSupplierInvoice', auth(BUYER_UID),
      { poId: po.poId, invoiceNumber: 'INV-L1', amount: 1000, vatAmount: 160 });
    return g.vatBasis === null && g.vatRate === 16 && g.vatAmount === 160 && s.includes('VAT \\(16%\\)') &&
      d.procSupplierInvoices[inv.invoiceId].poMatchedOn === 'total';
  }],
  ['INVOICE_UNKNOWN_MATCHES_NET', 'unknown-VAT PO: supplier invoice with its OWN VAT is matched net of VAT', async (P, d) => {
    const { doc } = await createFor(P, d, 'external');
    d.procPurchaseOrders[doc.poId].status = 'sent';
    const inv = await call(P, 'createSupplierInvoice', auth(BUYER_UID),
      { poId: doc.poId, invoiceNumber: 'INV-U1', amount: SUBTOTAL, vatAmount: Tax.r2(SUBTOTAL * 0.08) });
    const r = d.procSupplierInvoices[inv.invoiceId];
    const off = await verdict(() => call(P, 'createSupplierInvoice', auth(BUYER_UID),
      { poId: doc.poId, invoiceNumber: 'INV-U2', amount: SUBTOTAL * 1.5, vatAmount: 0 }));
    return r.poMatchedOn === 'net_of_vat' && r.vatSource === 'supplier_invoice' &&
      r.vatAmount === Tax.r2(SUBTOTAL * 0.08) && !off.ok && /before VAT/.test(off.message || '');
  }],
  ['INVOICE_VAT_VALIDATED', 'a non-numeric or negative invoice VAT is refused (no NaN total)', async (P, d) => {
    const po = legacyPo('po_legacy2'); d.procPurchaseOrders[po.poId] = po;
    const a = await verdict(() => call(P, 'createSupplierInvoice', auth(BUYER_UID), { poId: po.poId, invoiceNumber: 'I-a', amount: 1000, vatAmount: 'abc' }));
    const b = await verdict(() => call(P, 'createSupplierInvoice', auth(BUYER_UID), { poId: po.poId, invoiceNumber: 'I-b', amount: 1000, vatAmount: -5 }));
    return !a.ok && !b.ok;
  }],
  ['PRESENTATION_UNKNOWN_BEATS_STORED_RATE', 'vatAmount null with a stray vatRate 16 is still UNKNOWN, not 16%', async () => {
    const v = poVatPresentation({ vatAmount: null, vatRate: 16 });
    return v.vatKnown === false && !/16/.test(v.vatLabel);
  }],
  ['SOURCE_NO_INFERENCE', 'procurement.js has no `subtotal * VAT_RATE`, no 0.16 literal; po-pdf.js has no 16 default', async () => {
    const code = PROC;
    return !/subtotal\s*\*\s*VAT_RATE/.test(code) && !/(^|[^0-9])0?\.16\b/.test(code) &&
      !/vatRate\s*!=\s*null\s*\?\s*po\.vatRate\s*:\s*16/.test(code) &&
      !/vatRate\s*!=\s*null\s*\?\s*po\.vatRate\s*:\s*16/.test(PDF_SRC) &&
      /TaxEngine\.DEFAULTS\.vatRate/.test(code);
  }],
];

async function runRows(src) {
  const out = {};
  /* firebase-functions/logger writes structured lines through console; mute them while rows run. */
  const saved = [console.log, console.info, console.warn, console.error];
  console.log = console.info = console.warn = console.error = () => {};
  try {
  for (const [id, , fn] of ROWS) {
    const data = baseData();
    let ok = false, err = null;
    try { const P = loadProcurement(data, src); ok = !!(await fn(P, data)); }
    catch (e) { err = e && (e.message || String(e)); }
    out[id] = { ok, err };
  }
  } finally { [console.log, console.info, console.warn, console.error] = saved; }
  return out;
}

(async () => {
  console.log('\nCERT — procurement purchase orders never infer VAT\n');
  const real = await runRows(null);
  let pass = 0;
  for (const [id, desc] of ROWS) {
    const r = real[id];
    if (r.ok) pass++;
    console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + id.padEnd(40) + desc + (r.err ? '  [' + r.err + ']' : ''));
  }

  /* Negative controls — the defect put back must fail a NAMED row. SOURCE_NO_INFERENCE is
     excluded from the evidence so the BEHAVIOURAL row is what has to catch it. */
  const ANCHOR = 'const vat       = _poVatFor(subtotal, await _resolveSupplierVat(supplier));';
  const CONTROLS = [
    ['a', 'restore the 16% inference on every PO', 'UNKNOWN_EXTERNAL',
      PROC.replace(ANCHOR, "const vat = { vatBasis: 'supplier_registered', vatCategory: 'A', vatRate: 16, " +
        'vatAmount: +(subtotal * (16 / 100)).toFixed(2), total: +(subtotal * (116 / 100)).toFixed(2), reason: null };')],
    ['b', "treat an unknown supplier status as 'registered'", 'UNKNOWN_EXTERNAL',
      PROC.replace("if (status === 'registered') {", "if (status === 'registered' || status === 'unknown') {")],
  ];
  let ctlOk = 0;
  for (const [k, desc, must, src] of CONTROLS) {
    if (src === PROC) { console.log('  FAIL  control (' + k + ') anchor not found in procurement.js'); continue; }
    const r = await runRows(src);
    const failing = Object.keys(r).filter((id) => !r[id].ok);
    const caught = failing.includes(must);
    if (caught) ctlOk++;
    console.log('  ' + (caught ? 'PASS' : 'FAIL') + '  control (' + k + ') ' + desc + ' → failing rows: ' +
      (failing.join(', ') || 'none') + ' (must include ' + must + ')');
  }

  const total = ROWS.length;
  console.log('\n  rows ' + pass + '/' + total + ' PASS · controls caught ' + ctlOk + '/' + CONTROLS.length);
  const green = pass === total && ctlOk === CONTROLS.length;
  console.log(green ? '  PASS — no purchase order VAT is inferred; unknown stays unknown.\n'
                    : '  FAIL\n');
  process.exit(green ? 0 : 1);
})().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });
