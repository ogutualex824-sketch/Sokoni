'use strict';
/**
 * CERT — Supplier invoice payment is a CLAIM UNTIL VERIFIED (owner decision 2026-10-04).
 *
 * INVARIANT UNDER TEST
 *   No supplier invoice becomes 'paid', and no paymentLedger row is written for it, on the
 *   strength of a reference an admin typed. Only a verified payment event — through the
 *   server-only markSupplierInvoicePaidVerified — settles an invoice, exactly once, and only
 *   when invoice, amount and currency match. Payables never count a claim as paid.
 *
 * METHOD
 *   functions/procurement.js is EXECUTED with firebase-admin stubbed at require time. The
 *   transaction double has read-your-writes, create() conflicts detected at commit, and
 *   retry-on-conflict (as Firestore does). Negative controls compile a MUTATED copy of the
 *   real source in memory (no file is written) and assert that a NAMED row fails.
 *
 * Run: node scripts/test-supplier-invoice-claim.js
 */

const fs     = require('fs');
const path   = require('path');
const Module = require('module');

const ROOT      = path.resolve(__dirname, '..');
const PROC_PATH = path.join(ROOT, 'functions/procurement.js');
const PROC      = fs.readFileSync(PROC_PATH, 'utf8');
const INDEX     = fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');

let pass = 0, fail = 0, sabotage = 0, sabotageOk = 0;
const failures = [];
const check = (n, c) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); } };
const sab = (n, c) => { sabotage++; if (c) { sabotageOk++; pass++; console.log('  PASS    (control: ' + n + ')'); } else { fail++; failures.push('CONTROL ' + n); console.log('  FAIL    (control: ' + n + ')'); } };

/* ══════════════════════════════════════════════════════════════
   FIXTURE
══════════════════════════════════════════════════════════════ */
const UID_A = 'buyer-A';
const BIZ_A = 'SOK-AAAA11';
const PO_A  = 'po_a';
const INV   = 'inv_claim';
const INV2  = 'inv_noref';
const ADMIN = { admin: true };
const auth  = (uid, token) => ({ uid, token: token || {} });

function freshData() {
  const recent = new Date(Date.now() - 2 * 86400000);
  return {
    businesses: { [BIZ_A]: { ownerId: UID_A } },
    procPurchaseOrders: {
      [PO_A]: { poId: PO_A, merchantId: BIZ_A, buyerBusinessId: BIZ_A, supplierId: 'supA',
                status: 'invoiced', total: 1000, items: [] },
    },
    procSuppliers: {
      supA: { supplierId: 'supA', merchantId: BIZ_A, name: 'Supplier A', status: 'active', currentBalance: 1000 },
      supB: { supplierId: 'supB', merchantId: BIZ_A, name: 'Supplier B', status: 'active', currentBalance: 0 },
    },
    procSupplierInvoices: {
      [INV]:  { invoiceId: INV,  poId: PO_A, merchantId: BIZ_A, supplierId: 'supA',
                invoiceNumber: 'SUP-001', total: 1000, status: 'pending', paidAt: null },
      [INV2]: { invoiceId: INV2, poId: PO_A, merchantId: BIZ_A, supplierId: 'supA',
                invoiceNumber: 'SUP-002', total: 250, status: 'pending', paidAt: null },
      /* Marked paid by the PRE-2026-10-04 typed-reference path: never verified. */
      inv_legacy: { invoiceId: 'inv_legacy', poId: PO_A, merchantId: BIZ_A, supplierId: 'supB',
                    invoiceNumber: 'OLD-1', total: 700, status: 'paid', paidAt: recent,
                    paymentMethod: 'mpesa', paymentRef: 'TYPED-1' },
    },
    procForecast: {},
  };
}

/* ══════════════════════════════════════════════════════════════
   HARNESS
══════════════════════════════════════════════════════════════ */
function matches(row, conds) {
  return conds.every(([f, op, v]) => {
    const x = row[f];
    if (op === '==') return x === v;
    if (op === 'in') return Array.isArray(v) && v.includes(x);
    if (op === '>=') return x != null && x >= v;
    return false;
  });
}

function buildAdmin(data) {
  const mkRef = (n, id) => ({
    _c: n, _id: id,
    async get() { const d = (data[n] || {})[id]; return { exists: !!d, data: () => d, id }; },
    async update(val) { const bag = data[n] = data[n] || {}; bag[id] = Object.assign({}, bag[id], val); return true; },
    async set(val) { const bag = data[n] = data[n] || {}; bag[id] = val; return true; },
    async create(val) {
      const bag = data[n] = data[n] || {};
      if (bag[id]) { const e = new Error('Document already exists'); e.code = 6; throw e; }
      bag[id] = val; return true;
    },
  });
  const query = (n, conds) => {
    const q = {
      where(f, op, v) { return query(n, conds.concat([[f, op, v]])); },
      limit() { return q; }, orderBy() { return q; }, startAfter() { return q; },
      async get() {
        const bag = data[n] || {};
        const rows = Object.keys(bag).map((id) => [id, bag[id]]).filter(([, r]) => matches(r, conds));
        return { empty: rows.length === 0, size: rows.length,
                 docs: rows.map(([id, r]) => ({ id, data: () => r })),
                 forEach(cb) { rows.forEach(([id, r]) => cb({ id, data: () => r })); } };
      },
    };
    return q;
  };
  const fsFn = () => ({
    collection(n) {
      return {
        doc(id) { return mkRef(n, id || ('auto_' + Math.random().toString(36).slice(2))); },
        where(f, op, v) { return query(n, [[f, op, v]]); },
        add: async (val) => { const id = 'auto_' + Math.random().toString(36).slice(2); (data[n] = data[n] || {})[id] = val; return { id }; },
      };
    },
    async runTransaction(fn) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const staged = [];
        const t = {
          async get(ref) {
            if (data.__beforeRead) await data.__beforeRead(ref);
            const d = (data[ref._c] || {})[ref._id];
            return { exists: !!d, data: () => d, id: ref._id };
          },
          set(ref, val, opts) { staged.push({ op: 'set', c: ref._c, id: ref._id, val, merge: !!(opts && opts.merge) }); },
          update(ref, val) { staged.push({ op: 'update', c: ref._c, id: ref._id, val }); },
          create(ref, val) { staged.push({ op: 'create', c: ref._c, id: ref._id, val }); },
        };
        const out = await fn(t);
        /* Atomic commit: a create() over an existing doc aborts the whole transaction,
           which is then retried — exactly the Firestore contract. */
        const conflict = staged.some((w) => w.op === 'create' && (data[w.c] || {})[w.id]);
        if (conflict) continue;
        for (const w of staged) {
          const bag = (data[w.c] = data[w.c] || {});
          const cur = bag[w.id] || {};
          const next = Object.assign({}, (w.merge || w.op === 'update') ? cur : {}, w.val);
          for (const k of Object.keys(w.val || {})) {
            const v = w.val[k];
            if (v && typeof v === 'object' && v.__inc != null) next[k] = (Number(cur[k]) || 0) + v.__inc;
          }
          bag[w.id] = next;
        }
        return out;
      }
      const e = new Error('transaction contention'); e.code = 'aborted'; throw e;
    },
  });
  fsFn.FieldValue = { serverTimestamp: () => 'TS', increment: (n) => ({ __inc: n }) };
  fsFn.Timestamp  = { fromDate: (d) => d };
  fsFn.FieldPath  = { documentId: () => '__id__' };
  return { firestore: fsFn, auth: () => ({}), storage: () => ({}), messaging: () => ({}),
           apps: [{}], initializeApp() {}, credential: { applicationDefault() {} } };
}

/** Load procurement.js (or a MUTATED copy of its source, compiled in memory). */
function load(data, src) {
  const stubAdmin = buildAdmin(data);
  const orig = Module._load;
  Module._load = function (req) { if (req === 'firebase-admin') return stubAdmin; return orig.apply(this, arguments); };
  try {
    delete require.cache[require.resolve(path.join(ROOT, 'functions/merchant-authority.js'))];
    let proc;
    if (src == null) {
      delete require.cache[require.resolve(PROC_PATH)];
      proc = require(PROC_PATH);
    } else {
      const m = new Module(PROC_PATH, null);
      m.filename = PROC_PATH;
      m.paths = Module._nodeModulePaths(path.dirname(PROC_PATH));
      m._compile(src, PROC_PATH);
      proc = m.exports;
    }
    return { proc, data };
  } finally { Module._load = orig; }
}

async function verdict(fn) { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, code: e && e.code, message: e && e.message }; } }
function call(L, name, a, payload) {
  const fn = L.proc[name];
  if (fn && typeof fn.run === 'function') return fn.run({ auth: a, data: payload });
  if (fn && typeof fn.__handler === 'function') return fn.__handler({ auth: a, data: payload });
  throw Object.assign(new Error('handler-not-invocable'), { code: 'harness' });
}
const ledger  = (L, id) => Object.values(L.data.paymentLedger || {}).filter((r) => r.refId === id);
const invOf   = (L, id) => L.data.procSupplierInvoices[id];
const event   = (over) => Object.assign({ verified: true, source: 'intasend_payout', eventId: 'EV-1',
                                          amount: 1000, currency: 'KES', invoiceId: INV }, over || {});

/* ══════════════════════════════════════════════════════════════
   ROWS — each returns { name: boolean }. Run against the real source and, for the
   negative controls, against mutated source.
══════════════════════════════════════════════════════════════ */
const ROW = {
  APPROVE_REF:     'R1 approve with ref -> status approved + paymentStatus claimed',
  APPROVE_NOLEDGER:'R2 approve with ref -> NO paymentLedger row, no balance move, PO not paid',
  APPROVE_NOREF:   'R3 approve without ref -> approved + unpaid, no claim',
  CLIENT_PAID:     'R4 client payload cannot set paid (status/paymentStatus/verifiedEvent ignored)',
  HELPER_PLAIN:    'R5 verified helper is a plain server function, not a callable',
  HELPER_NOT_INDEX:'R6 verified helper is NOT re-exported from functions/index.js',
  HELPER_CLIENT:   'R7 helper refuses an unverified / callable-shaped event',
  VERIFIED_ONCE:   'R8 verified event marks paid once (replay is a no-op)',
  VERIFIED_LEDGER: 'R9 verified settlement writes exactly the double-entry pair, verified',
  MISMATCH_AMT:    'R10 mismatched amount refused, nothing written',
  MISMATCH_CCY:    'R11 mismatched currency refused, nothing written',
  MISMATCH_INV:    'R12 event for a different invoice / no match refused',
  EVENT_REUSE:     'R13 one event cannot settle a second invoice',
  CONCURRENT:      'R14 concurrent delivery of one event settles once',
  DASH_CLAIMS:     'R15 dashboard counts claims separately, outstanding still includes them',
  DASH_SPEND:      'R16 dashboard spend counts verified only; legacy recorded-paid separate',
  LIST_STATUS:     'R17 listSupplierInvoices exposes claimed vs verified',
};

async function runRows(src) {
  const r = {};

  { /* R1-R2 */
    const L = load(freshData(), src);
    const v = await verdict(() => call(L, 'approveAndPayInvoice', auth(UID_A, ADMIN),
      { invoiceId: INV, paymentMethod: 'bank_transfer', paymentRef: '<b>TRX-9</b>' }));
    const inv = invOf(L, INV) || {};
    r[ROW.APPROVE_REF] = v.ok && v.value.status === 'approved' && v.value.paymentStatus === 'claimed' &&
      v.value.verified === false && inv.status === 'approved' && inv.paymentStatus === 'claimed' &&
      !inv.paidAt && inv.paymentClaim && inv.paymentClaim.ref === 'TRX-9' &&
      inv.paymentClaim.method === 'bank_transfer' && inv.paymentClaim.claimedBy === UID_A;
    r[ROW.APPROVE_NOLEDGER] = v.ok && ledger(L, INV).length === 0 &&
      L.data.procSuppliers.supA.currentBalance === 1000 && L.data.procPurchaseOrders[PO_A].status !== 'paid';
  }
  { /* R3 */
    const L = load(freshData(), src);
    const v = await verdict(() => call(L, 'approveAndPayInvoice', auth(UID_A, ADMIN), { invoiceId: INV2 }));
    const inv = invOf(L, INV2) || {};
    r[ROW.APPROVE_NOREF] = v.ok && inv.status === 'approved' && inv.paymentStatus === 'unpaid' &&
      !inv.paymentClaim && ledger(L, INV2).length === 0;
  }
  { /* R4 */
    const L = load(freshData(), src);
    const v = await verdict(() => call(L, 'approveAndPayInvoice', auth(UID_A, ADMIN), {
      invoiceId: INV, paymentMethod: 'mpesa', paymentRef: 'X', status: 'paid', paymentStatus: 'verified_paid',
      paidAt: new Date(), verified: true, verifiedEvent: event() }));
    const inv = invOf(L, INV) || {};
    r[ROW.CLIENT_PAID] = v.ok && inv.status !== 'paid' && inv.paymentStatus === 'claimed' &&
      !inv.paymentVerification && ledger(L, INV).length === 0;
  }
  { /* R5-R7 */
    const L = load(freshData(), src);
    const h = L.proc.markSupplierInvoicePaidVerified;
    r[ROW.HELPER_PLAIN] = typeof h === 'function' && typeof h.run !== 'function' &&
      typeof h.__handler !== 'function' && h.__endpoint === undefined && h.__trigger === undefined;
    r[ROW.HELPER_NOT_INDEX] = !/markSupplierInvoicePaidVerified/.test(INDEX);
    const req = { auth: auth(UID_A, ADMIN), data: { invoiceId: INV, verifiedEvent: event() } };
    const a = await verdict(() => h(req));                                         /* callable request as arg */
    const b = await verdict(() => h(INV, Object.assign({ auth: req.auth }, event()))); /* request-shaped event */
    const c = await verdict(() => h(INV, event({ verified: undefined })));          /* not verified */
    const d = await verdict(() => h(INV, event({ verified: 'true' })));             /* truthy is not true */
    const e = await verdict(() => h(INV, event({ source: 'manual' })));             /* not a rail */
    const f = await verdict(() => h(INV, event({ eventId: '' })));                  /* no event id */
    r[ROW.HELPER_CLIENT] = !a.ok && !b.ok && !c.ok && !d.ok && !e.ok && !f.ok &&
      (invOf(L, INV) || {}).status === 'pending' && ledger(L, INV).length === 0;
  }
  { /* R8-R9 */
    const L = load(freshData(), src);
    await verdict(() => call(L, 'approveAndPayInvoice', auth(UID_A, ADMIN), { invoiceId: INV, paymentMethod: 'mpesa', paymentRef: 'TRX-9' }));
    const h = L.proc.markSupplierInvoicePaidVerified;
    const v1 = await verdict(() => h(INV, event()));
    const v2 = await verdict(() => h(INV, event()));
    const inv = invOf(L, INV) || {};
    r[ROW.VERIFIED_ONCE] = v1.ok && v1.value.duplicate === false && v2.ok && v2.value.duplicate === true &&
      inv.status === 'paid' && inv.paymentStatus === 'verified_paid' && inv.paymentVerification &&
      inv.paymentVerification.eventId === 'EV-1' && L.data.procSuppliers.supA.currentBalance === 0 &&
      Object.keys(L.data.procSupplierPaymentEvents || {}).length === 1 &&
      L.data.procPurchaseOrders[PO_A].status === 'paid';
    const rows = ledger(L, INV);
    r[ROW.VERIFIED_LEDGER] = rows.length === 2 && rows.every((x) => x.verified === true && x.amount === 1000) &&
      rows.filter((x) => x.type === 'debit' && x.account === 'accounts_payable').length === 1;
  }
  { /* R10-R12 */
    const L = load(freshData(), src);
    const h = L.proc.markSupplierInvoicePaidVerified;
    const amt = await verdict(() => h(INV, event({ amount: 999.99 })));
    const untouched1 = (invOf(L, INV) || {}).status === 'pending' && ledger(L, INV).length === 0 &&
      !Object.keys(L.data.procSupplierPaymentEvents || {}).length;
    r[ROW.MISMATCH_AMT] = !amt.ok && /amount/i.test(amt.message || '') && untouched1;
    const ccy = await verdict(() => h(INV, event({ currency: 'USD' })));
    r[ROW.MISMATCH_CCY] = !ccy.ok && /currency/i.test(ccy.message || '') &&
      (invOf(L, INV) || {}).status === 'pending' && ledger(L, INV).length === 0;
    const other = await verdict(() => h(INV, event({ invoiceId: INV2 })));
    const nomatch = await verdict(() => h(INV, event({ invoiceId: undefined, ref: 'NOPE' })));
    r[ROW.MISMATCH_INV] = !other.ok && !nomatch.ok && (invOf(L, INV) || {}).status === 'pending';
  }
  { /* R13 */
    const L = load(freshData(), src);
    const h = L.proc.markSupplierInvoicePaidVerified;
    await verdict(() => h(INV, event()));
    const reuse = await verdict(() => h(INV2, event({ invoiceId: INV2, amount: 250 })));
    r[ROW.EVENT_REUSE] = !reuse.ok && (invOf(L, INV2) || {}).status === 'pending' && ledger(L, INV2).length === 0;
  }
  { /* R14 */
    const L = load(freshData(), src);
    const h = L.proc.markSupplierInvoicePaidVerified;
    let release; const gate = new Promise((res) => { release = res; }); let first = false;
    L.data.__beforeRead = async (ref) => { if (ref._c === 'procSupplierInvoices' && !first) { first = true; await gate; } };
    const a = verdict(() => h(INV, event())); const b = verdict(() => h(INV, event()));
    setTimeout(release, 10);
    const [x, y] = await Promise.all([a, b]); delete L.data.__beforeRead;
    r[ROW.CONCURRENT] = x.ok && y.ok && [x, y].filter((q) => q.value.duplicate === false).length === 1 &&
      L.data.procSuppliers.supA.currentBalance === 0 && ledger(L, INV).length === 2;
  }
  { /* R15-R16 */
    const L = load(freshData(), src);
    await verdict(() => call(L, 'approveAndPayInvoice', auth(UID_A, ADMIN), { invoiceId: INV, paymentMethod: 'mpesa', paymentRef: 'TRX-9' }));
    const d1 = await verdict(() => call(L, 'getProcurementDashboard', auth(UID_A), { merchantId: BIZ_A }));
    const D = d1.ok ? d1.value : {};
    r[ROW.DASH_CLAIMS] = d1.ok && D.claimedInvoices && D.claimedInvoices.count === 1 &&
      D.claimedInvoices.totalValue === 1000 && D.pendingInvoices.count === 2 &&
      D.pendingInvoices.totalValue === 1250 && D.unclaimedInvoices.count === 1 &&
      D.unclaimedInvoices.totalValue === 250 && D.verifiedPaidLast30d.count === 0;
    /* spend: legacy recorded-paid (TYPED-1) is NOT spend; after a verified event INV is. */
    const legacyOnly = d1.ok && D.recordedUnverifiedLast30d && D.recordedUnverifiedLast30d.count === 1 &&
      D.recordedUnverifiedLast30d.totalValue === 700 && Array.isArray(D.topSuppliers) && D.topSuppliers.length === 0;
    L.data.procSupplierInvoices[INV2].total = undefined; /* unknown total -> bucket total null, not 0 */
    await verdict(() => L.proc.markSupplierInvoicePaidVerified(INV, event()));
    L.data.procSupplierInvoices[INV].paidAt = new Date();   /* serverTimestamp stub -> a real date */
    const d2 = await verdict(() => call(L, 'getProcurementDashboard', auth(UID_A), { merchantId: BIZ_A }));
    const E = d2.ok ? d2.value : {};
    r[ROW.DASH_SPEND] = legacyOnly && d2.ok && E.verifiedPaidLast30d.count === 1 &&
      E.verifiedPaidLast30d.totalValue === 1000 && E.topSuppliers.length === 1 &&
      E.topSuppliers[0].supplierId === 'supA' && E.topSuppliers[0].spend === 1000 &&
      E.claimedInvoices.count === 0 && E.pendingInvoices.count === 1 && E.pendingInvoices.totalValue === null;
  }
  { /* R17 — the real list callable, executed */
    const L = load(freshData(), src);
    await verdict(() => call(L, 'approveAndPayInvoice', auth(UID_A, ADMIN), { invoiceId: INV, paymentMethod: 'mpesa', paymentRef: 'TRX-9' }));
    const lv = await verdict(() => call(L, 'listSupplierInvoices', auth(UID_A), { merchantId: BIZ_A }));
    const items = lv.ok ? (lv.value.items || lv.value.rows || lv.value.data || []) : [];
    const by = {}; items.forEach((x) => { by[x.invoiceId] = x; });
    r[ROW.LIST_STATUS] = lv.ok && items.length === 3 &&
      by[INV] && by[INV].paymentStatus === 'claimed' && by[INV].paymentVerified === false &&
      by[INV].paymentClaim && by[INV].paymentClaim.ref === 'TRX-9' &&
      by.inv_legacy && by.inv_legacy.paymentStatus === 'recorded_unverified' && by.inv_legacy.paymentVerified === false &&
      by[INV2] && by[INV2].paymentStatus === 'unpaid' &&
      L.proc._invoicePaymentStatus({ paymentStatus: 'verified_paid' }) === 'recorded_unverified';
    if (!lv.ok && src == null) console.log('  (list error: ' + lv.message + ')');
  }
  return r;
}

/* ══════════════════════════════════════════════════════════════
   NEGATIVE CONTROLS — mutate the real source, the named row must FAIL
══════════════════════════════════════════════════════════════ */
function mutate(from, to) {
  if (!PROC.includes(from)) throw new Error('control anchor missing: ' + from.slice(0, 60));
  return PROC.replace(from, to);
}
const CONTROLS = [
  { name: '(a) approve marks paid', row: ROW.APPROVE_REF,
    src: () => mutate("      status:        'approved',\n      paymentStatus: claim ? 'claimed' : 'unpaid',",
                      "      status:        'paid', paidAt: F.serverTimestamp(),\n      paymentStatus: 'verified_paid',") },
  { name: '(b1) verified helper exposed as a callable', row: ROW.HELPER_PLAIN,
    src: () => mutate('  markSupplierInvoicePaidVerified,\n  _invoicePaymentStatus,',
                      '  markSupplierInvoicePaidVerified: onCall(OPT, async (r) => markSupplierInvoicePaidVerified(r.data.invoiceId, r.data.verifiedEvent)),\n  _invoicePaymentStatus,') },
  { name: '(b2) verified helper accepts client / unverified input', row: ROW.HELPER_CLIENT,
    src: () => mutate("  if (ev.verified !== true) _err('Payment event is not verified.', 'failed-precondition');", '')
               .replace("  if ('auth' in ev || 'rawRequest' in ev) {", '  if (false) {')
               .replace("  if (typeof invoiceId !== 'string' || !invoiceId.trim()) {", '  if (false) {')
               .replace("  if (SUPPLIER_PAYMENT_SOURCE_DENY.has(source.toLowerCase())) {", '  if (false) {') },
  { name: '(c1) claim removed from outstanding (counted as paid)', row: ROW.DASH_CLAIMS,
    src: () => mutate("    outstandingList.push(inv);\n    if (_invoicePaymentStatus(inv) === 'claimed') claimedList.push(inv); else unclaimedList.push(inv);",
                      "    if (_invoicePaymentStatus(inv) === 'claimed') { claimedList.push(inv); return; }\n    outstandingList.push(inv); unclaimedList.push(inv);") },
  { name: '(c2) recorded-but-unverified "paid" counted as spend', row: ROW.DASH_SPEND,
    src: () => mutate("    if (_invoicePaymentStatus(inv) !== 'verified_paid') { recordedUnverifiedList.push(inv); return; }", '') },
  { name: '(d) amount match removed', row: ROW.MISMATCH_AMT,
    src: () => mutate('    if (Math.round(amount * 100) !== Math.round(total * 100)) {', '    if (false) {') },
  { name: '(e) idempotency create() replaced by set()', row: ROW.EVENT_REUSE,
    src: () => mutate('    if (evSnap.exists) {', '    if (false) {').replace('t.create(eventRef,', 't.set(eventRef,') },
  { name: '(f) list treats a recorded paid status as verified', row: ROW.LIST_STATUS,
    src: () => mutate("      paymentVerified: _invoicePaymentStatus(d) === 'verified_paid',", "      paymentVerified: d.status === 'paid' || _invoicePaymentStatus(d) === 'verified_paid',") },
];

(async () => {
  console.log('\nCERT — supplier invoice payment: CLAIM UNTIL VERIFIED\n');
  const L0 = load(freshData());
  const probe = await verdict(() => call(L0, 'approveAndPayInvoice', auth('x', ADMIN), {}));
  check('the real handlers are invocable in this harness', probe.code !== 'harness');
  if (probe.code === 'harness') process.exit(1);

  console.log('\n§1 real source');
  const real = await runRows(null);
  for (const n of Object.values(ROW)) check(n, real[n] === true);

  console.log('\n§2 negative controls (mutated source -> named row must FAIL)');
  for (const c of CONTROLS) {
    let rows;
    try { rows = await runRows(c.src()); } catch (e) { rows = { __crash: e.message }; }
    if (rows.__crash) { sab(c.name + ' — harness crashed: ' + rows.__crash, false); continue; }
    sab(c.name + ' -> fails "' + c.row + '"', rows[c.row] !== true);
  }

  console.log('\n§3 structure');
  check('approveAndPayInvoice never writes paymentLedger',
    !/const approveAndPayInvoice[\s\S]*?\n\}\);/.exec(PROC)[0].includes('paymentLedger'));
  check("approveAndPayInvoice never writes status 'paid'",
    !/status:\s*'paid'/.test(/const approveAndPayInvoice[\s\S]*?\n\}\);/.exec(PROC)[0]));
  check('the verified helper claims its event with create() inside the transaction',
    /t\.create\(eventRef,/.test(PROC));
  check('callable name kept for compatibility (index.js still exports approveAndPayInvoice)',
    /exports\.approveAndPayInvoice\s*=\s*procurement\.approveAndPayInvoice/.test(INDEX));

  console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed  ·  ' + sabotageOk + '/' + sabotage + ' negative controls caught');
  if (fail) { console.log('\n  ' + fail + ' FAILURE(S):'); failures.forEach((f) => console.log('    - ' + f)); process.exit(1); }
  console.log('\n  PASS — a typed reference is a claim; only a verified event is payment.\n');
})().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });
