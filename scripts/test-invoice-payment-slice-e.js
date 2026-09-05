'use strict';
/**
 * CERT — Slice E: supplier invoice + payment.
 *
 * INVARIANT UNDER TEST
 *   A failed, duplicated, unauthorized or partially executed payment must never produce an
 *   incorrect financial state.
 *
 * METHOD
 *   The real `createSupplierInvoice` and `approveAndPayInvoice` are EXECUTED: procurement.js
 *   is loaded with firebase-admin stubbed at require time, so both close over an injected
 *   fixture with two merchants, three principals, GRNs and invoices. The transaction double
 *   has real read-your-writes and a contention hook, so CONCURRENT duplicate payment is
 *   exercised — not merely a sequential retry, which would pass even against the defective
 *   read-then-write shape this slice replaces.
 *
 *   Money assertions read the resulting store: ledger row count, supplier balance, invoice
 *   status. Static checks appear only where the property is genuinely textual.
 */

const fs   = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const PROC = fs.readFileSync(path.join(ROOT, 'functions/procurement.js'), 'utf8');

let pass = 0, fail = 0, sabotage = 0, sabotageOk = 0;
const failures = [];
const check = (n, c) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); } };
const sab   = (n, c) => { sabotage++; if (c) { sabotageOk++; pass++; console.log('  PASS    (sabotage: ' + n + ')'); } else { fail++; failures.push('SABOTAGE ' + n); console.log('  FAIL    (sabotage: ' + n + ')'); } };

console.log('\nCERT — Slice E: invoice + payment\n');

/* ══════════════════════════════════════════════════════════════
   FIXTURE
══════════════════════════════════════════════════════════════ */
const UID_A = 'buyer-A', UID_B = 'buyer-B', UID_SUP = 'supplier-principal';
const BIZ_A = 'SOK-AAAA11', BIZ_B = 'SOK-BBBB22', BIZ_SUP = 'SOK-SUPP99';
const PO_A = 'po_a', PO_B = 'po_b';
const GRN_A = 'grn_a', GRN_B = 'grn_b';
const INV_A = 'inv_a_pending';

function freshData() {
  return {
    businesses: {
      [BIZ_A]:   { ownerId: UID_A },
      [BIZ_B]:   { ownerId: UID_B },
      [BIZ_SUP]: { ownerId: UID_SUP, supply: { enabled: true } },
    },
    procPurchaseOrders: {
      [PO_A]: { poId: PO_A, merchantId: BIZ_A, buyerBusinessId: BIZ_A, supplierId: 'supA',
                supplierBusinessId: BIZ_SUP, status: 'received', total: 1000,
                items: [{ productId: 'p1', qty: 10, unitCost: 100 }] },
      [PO_B]: { poId: PO_B, merchantId: BIZ_B, buyerBusinessId: BIZ_B, supplierId: 'supB',
                status: 'received', total: 500, items: [{ productId: 'p9', qty: 5, unitCost: 100 }] },
      'po_a_draft': { poId: 'po_a_draft', merchantId: BIZ_A, buyerBusinessId: BIZ_A,
                      supplierId: 'supA', status: 'draft', total: 100, items: [] },
      'po_a_zero': { poId: 'po_a_zero', merchantId: BIZ_A, buyerBusinessId: BIZ_A,
                     supplierId: 'supA', status: 'received', total: 0, items: [] },
    },
    procGRN: {
      [GRN_A]: { grnId: GRN_A, poId: PO_A, merchantId: BIZ_A },
      [GRN_B]: { grnId: GRN_B, poId: PO_B, merchantId: BIZ_B },
    },
    procSuppliers: {
      supA: { supplierId: 'supA', merchantId: BIZ_A, currentBalance: 1000 },
      supB: { supplierId: 'supB', merchantId: BIZ_B, currentBalance: 500 },
    },
    procSupplierInvoices: {
      [INV_A]: { invoiceId: INV_A, poId: PO_A, merchantId: BIZ_A, supplierId: 'supA',
                 invoiceNumber: 'SUP-001', total: 1000, status: 'pending', paidAt: null },
    },
  };
}

function loadProcurement(data) {
  const writes = { set: [], update: [], create: [], committed: 0 };
  const mkRef = (n, id) => ({
    _c: n, _id: id,
    async get() { const d = (data[n] || {})[id]; return { exists: !!d, data: () => d, id }; },
    async update(val) { const bag = data[n] = data[n] || {}; bag[id] = Object.assign({}, bag[id], val); return true; },
    async set(val) { const bag = data[n] = data[n] || {}; bag[id] = val; return true; },
    async create(val) {
      const bag = data[n] = data[n] || {};
      if (bag[id]) { const e = new Error('Document already exists'); e.code = 6; throw e; }
      bag[id] = val; writes.create.push({ collection: n, id }); return true;
    },
  });
  const fsFn = () => ({
    collection(n) {
      return {
        doc(id) { return mkRef(n, id || ('auto_' + Math.random().toString(36).slice(2))); },
        where(f1, _o, v1) {
          const conds = [[f1, v1]];
          const q = { where(f, _o2, v) { conds.push([f, v]); return q; }, limit() { return q; },
            async get() { const rows = (Array.isArray(data[n]) ? data[n] : []).filter((r) => conds.every(([f, v]) => r[f] === v));
              return { empty: rows.length === 0, size: rows.length, docs: rows.map((r) => ({ data: () => r })) }; } };
          return q;
        },
      };
    },
    async runTransaction(fn) {
      const staged = [];
      const t = {
        async get(ref) {
          if (data.__beforeRead) await data.__beforeRead(ref);
          const d = (data[ref._c] || {})[ref._id];
          return { exists: !!d, data: () => d, id: ref._id };
        },
        set(ref, val, opts) { staged.push({ op: 'set', c: ref._c, id: ref._id, val, merge: !!(opts && opts.merge) }); },
        update(ref, val) { staged.push({ op: 'update', c: ref._c, id: ref._id, val }); },
      };
      const out = await fn(t);
      for (const w of staged) {
        writes[w.op].push({ collection: w.c, id: w.id, val: w.val });
        const bag = (data[w.c] = data[w.c] || {});
        const cur = bag[w.id] || {};
        const next = Object.assign({}, (w.merge || w.op === 'update') ? cur : {}, w.val);
        for (const k of Object.keys(w.val || {})) {
          const v = w.val[k];
          if (v && typeof v === 'object' && v.__inc != null) next[k] = (Number(cur[k]) || 0) + v.__inc;
        }
        bag[w.id] = next;
      }
      writes.committed++;
      return out;
    },
  });
  fsFn.FieldValue = { serverTimestamp: () => 'TS', increment: (n) => ({ __inc: n }) };
  fsFn.Timestamp  = { fromDate: (d) => d };
  const stubAdmin = { firestore: fsFn, auth: () => ({}), storage: () => ({}), messaging: () => ({}),
                      apps: [{}], initializeApp() {}, credential: { applicationDefault() {} } };
  const orig = Module._load;
  Module._load = function (req) { if (req === 'firebase-admin') return stubAdmin; return orig.apply(this, arguments); };
  try {
    delete require.cache[require.resolve(path.join(ROOT, 'functions/procurement.js'))];
    delete require.cache[require.resolve(path.join(ROOT, 'functions/merchant-authority.js'))];
    return { proc: require(path.join(ROOT, 'functions/procurement.js')), writes, data };
  } finally { Module._load = orig; }
}

const auth = (uid, token) => ({ uid, token: token || {} });
const ADMIN = { admin: true };
async function verdict(fn) { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, code: e && e.code, message: e && e.message }; } }
function invoker(L, name) {
  const fn = L.proc[name];
  return (a, data) => {
    if (fn && typeof fn.run === 'function') return fn.run({ auth: a, data });
    if (fn && typeof fn.__handler === 'function') return fn.__handler({ auth: a, data });
    throw Object.assign(new Error('handler-not-invocable'), { code: 'harness' });
  };
}
const ledgerRows = (L, invoiceId) =>
  Object.values(L.data.paymentLedger || {}).filter((r) => r.refId === invoiceId);
const balanceOf = (L, sid) => ((L.data.procSuppliers || {})[sid] || {}).currentBalance;

(async () => {
  const L0 = loadProcurement(freshData());
  const probe = await verdict(() => invoker(L0, 'approveAndPayInvoice')(auth('x', ADMIN), {}));
  const INVOCABLE = probe.code !== 'harness';
  check('the real handlers are invocable in this harness', INVOCABLE);
  if (!INVOCABLE) { console.log('\n  HARNESS CANNOT INVOKE — aborting'); process.exit(1); }

  /* ══════════════════════════════════════════════════════════
     §1 INVOICE — authority
  ══════════════════════════════════════════════════════════ */
  console.log('\n§1 invoice authority (executed)');
  {
    const L = loadProcurement(freshData()); const mk = invoker(L, 'createSupplierInvoice');
    const ok = await verdict(() => mk(auth(UID_A), { poId: PO_A, invoiceNumber: 'SUP-100', amount: 1000 }));
    check('authorized buyer can invoice its own PO', ok.ok && !!ok.value.invoiceId);

    const cross = await verdict(() => mk(auth(UID_A), { poId: PO_B, invoiceNumber: 'X', amount: 500 }));
    check('merchant A -> merchant B PO is DENIED', !cross.ok && cross.code === 'permission-denied');

    const sup = await verdict(() => mk(auth(UID_SUP), { poId: PO_A, invoiceNumber: 'X', amount: 1000 }));
    check('the SUPPLIER principal cannot raise the buyer-side invoice',
      !sup.ok && sup.code === 'permission-denied');

    const anon = await verdict(() => mk(null, { poId: PO_A, invoiceNumber: 'X', amount: 1000 }));
    check('unauthenticated is rejected', !anon.ok);

    const missing = await verdict(() => mk(auth(UID_A), { poId: 'nope', invoiceNumber: 'X', amount: 1 }));
    check('a nonexistent PO fails closed', !missing.ok && missing.code === 'not-found');

    const draft = await verdict(() => mk(auth(UID_A), { poId: 'po_a_draft', invoiceNumber: 'X', amount: 100 }));
    check('a draft PO cannot be invoiced', !draft.ok);
  }

  /* ══════════════════════════════════════════════════════════
     §2 INVOICE — which GRNs may be referenced
  ══════════════════════════════════════════════════════════ */
  console.log('\n§2 GRN reference validation (executed)');
  {
    const L = loadProcurement(freshData()); const mk = invoker(L, 'createSupplierInvoice');
    const good = await verdict(() => mk(auth(UID_A), { poId: PO_A, grnId: GRN_A, invoiceNumber: 'G1', amount: 1000 }));
    check('a GRN belonging to the same PO is accepted', good.ok);
    check('the verified GRN is stored on the invoice',
      good.ok && (L.data.procSupplierInvoices[good.value.invoiceId] || {}).grnId === GRN_A);

    const wrongPo = await verdict(() => mk(auth(UID_A), { poId: PO_A, grnId: GRN_B, invoiceNumber: 'G2', amount: 1000 }));
    check("a GRN from ANOTHER purchase order is REJECTED", !wrongPo.ok && /different purchase order/i.test(wrongPo.message || ''));

    const ghost = await verdict(() => mk(auth(UID_A), { poId: PO_A, grnId: 'grn_ghost', invoiceNumber: 'G3', amount: 1000 }));
    check('a nonexistent GRN is REJECTED', !ghost.ok && ghost.code === 'not-found');

    const none = await verdict(() => mk(auth(UID_A), { poId: PO_A, invoiceNumber: 'G4', amount: 1000 }));
    check('omitting the GRN is still permitted (existing contract)', none.ok);
    check('an omitted GRN stores null, not a fabricated reference',
      none.ok && (L.data.procSupplierInvoices[none.value.invoiceId] || {}).grnId === null);
  }

  /* ══════════════════════════════════════════════════════════
     §3 INVOICE — duplicate handling + totals
  ══════════════════════════════════════════════════════════ */
  console.log('\n§3 duplicate invoice + totals (executed)');
  {
    const L = loadProcurement(freshData()); const mk = invoker(L, 'createSupplierInvoice');
    const one = await verdict(() => mk(auth(UID_A), { poId: PO_A, invoiceNumber: 'DUP-1', amount: 1000 }));
    const before = Object.keys(L.data.procSupplierInvoices).length;
    const two = await verdict(() => mk(auth(UID_A), { poId: PO_A, invoiceNumber: 'DUP-1', amount: 1000 }));
    check('the first invoice is created', one.ok);
    check('DUPLICATE invoice number is REJECTED', !two.ok && two.code === 'already-exists');
    check('DUPLICATE creates no second payable',
      Object.keys(L.data.procSupplierInvoices).length === before);
    check('the id is derived, so the duplicate addressed the same document',
      /_deterministicId\(/.test(PROC) && !/const invoiceId = _genId\('inv'\)/.test(PROC));
    sab('the detector catches a random invoice id', /_genId\('inv'\)/.test("const invoiceId = _genId('inv');"));

    const dev = await verdict(() => mk(auth(UID_A), { poId: PO_A, invoiceNumber: 'DEV', amount: 5000 }));
    check('an invoice deviating >5% from the PO total is rejected', !dev.ok && /deviates/i.test(dev.message || ''));

    const zero = await verdict(() => mk(auth(UID_A), { poId: 'po_a_zero', invoiceNumber: 'Z', amount: 100 }));
    check('a zero-total PO cannot be invoiced (was NaN, silently passing)', !zero.ok);
  }

  /* ══════════════════════════════════════════════════════════
     §4 PAYMENT — authority
  ══════════════════════════════════════════════════════════ */
  console.log('\n§4 payment authority (executed)');
  {
    const L = loadProcurement(freshData()); const pay = invoker(L, 'approveAndPayInvoice');
    const noAdmin = await verdict(() => pay(auth(UID_A), { invoiceId: INV_A, paymentMethod: 'mpesa' }));
    check('a non-admin cannot pay (existing admin requirement retained)',
      !noAdmin.ok && noAdmin.code === 'permission-denied');

    /* WHAT THE MERCHANT SCOPING ACTUALLY ADDS, stated precisely rather than aspirationally.
       `_requireAdmin` admits token.admin, token.superAdmin, OR role >= 4. The merchant
       primitive bypasses only on the first two — the unforgeable PLATFORM claims. So the
       caller this slice newly blocks is a role>=4 principal WITHOUT a platform-admin claim,
       acting on a merchant they have no relationship to. Before, _requireAdmin alone let
       them through. */
    const roleFour = await verdict(() => pay(auth(UID_B, { role: 4 }), { invoiceId: INV_A, paymentMethod: 'mpesa' }));
    check('a role>=4 principal without a platform claim is DENIED another merchant\'s invoice',
      !roleFour.ok && roleFour.code === 'permission-denied');

    /* And the converse, documented rather than pretended away: a PLATFORM admin IS
       permitted, exactly as in Slice C. This slice preserves that model; it does not
       silently narrow it. */
    const L2 = loadProcurement(freshData()); const pay2 = invoker(L2, 'approveAndPayInvoice');
    const platformAdmin = await verdict(() => pay2(auth('platform-root', ADMIN), { invoiceId: INV_A, paymentMethod: 'mpesa' }));
    check('a PLATFORM admin IS permitted (existing model, deliberately preserved)', platformAdmin.ok);

    const supPay = await verdict(() => pay(auth(UID_SUP), { invoiceId: INV_A, paymentMethod: 'mpesa' }));
    check('the SUPPLIER principal cannot execute the buyer-side payment', !supPay.ok);

    const anon = await verdict(() => pay(null, { invoiceId: INV_A, paymentMethod: 'mpesa' }));
    check('unauthenticated is rejected', !anon.ok);

    const ghost = await verdict(() => pay(auth(UID_A, ADMIN), { invoiceId: 'nope', paymentMethod: 'mpesa' }));
    check('a nonexistent invoice fails closed', !ghost.ok && ghost.code === 'not-found');

    const noMethod = await verdict(() => pay(auth(UID_A, ADMIN), { invoiceId: INV_A }));
    check('paymentMethod is required', !noMethod.ok);
    check('no failed attempt wrote a ledger row', ledgerRows(L, INV_A).length === 0);
    check('no failed attempt moved the supplier balance', balanceOf(L, 'supA') === 1000);
  }

  /* ══════════════════════════════════════════════════════════
     §5 PAYMENT — the money path, once and only once
  ══════════════════════════════════════════════════════════ */
  console.log('\n§5 payment executes exactly once');
  {
    const L = loadProcurement(freshData()); const pay = invoker(L, 'approveAndPayInvoice');
    const p1 = await verdict(() => pay(auth(UID_A, ADMIN), { invoiceId: INV_A, paymentMethod: 'mpesa', paymentRef: 'R1' }));
    check('an authorized payment succeeds', p1.ok && p1.value.status === 'paid');
    check('the invoice is marked paid', L.data.procSupplierInvoices[INV_A].status === 'paid');
    check('exactly TWO ledger rows (double entry)', ledgerRows(L, INV_A).length === 2);
    check('one debit to accounts_payable',
      ledgerRows(L, INV_A).filter((r) => r.type === 'debit' && r.account === 'accounts_payable').length === 1);
    check('one credit to the payment method',
      ledgerRows(L, INV_A).filter((r) => r.type === 'credit' && r.account === 'mpesa').length === 1);
    check('the supplier balance decreased by the invoice total once', balanceOf(L, 'supA') === 0);
    check('the PO is marked paid', L.data.procPurchaseOrders[PO_A].status === 'paid');

    /* SEQUENTIAL duplicate */
    const p2 = await verdict(() => pay(auth(UID_A, ADMIN), { invoiceId: INV_A, paymentMethod: 'mpesa', paymentRef: 'R1' }));
    check('a duplicate payment does not error', p2.ok);
    check('a duplicate is reported as such', p2.ok && p2.value.duplicate === true);
    check('DUPLICATE: still exactly two ledger rows', ledgerRows(L, INV_A).length === 2);
    check('DUPLICATE: supplier balance unchanged', balanceOf(L, 'supA') === 0);
  }

  /* ══════════════════════════════════════════════════════════
     §6 PAYMENT — CONCURRENT duplicate (the D lesson, applied to money)
  ══════════════════════════════════════════════════════════ */
  console.log('\n§6 concurrent duplicate payment');
  {
    const L = loadProcurement(freshData()); const pay = invoker(L, 'approveAndPayInvoice');
    let release; const gate = new Promise((r) => { release = r; });
    let first = false;
    L.data.__beforeRead = async (ref) => {
      if (ref._c === 'procSupplierInvoices' && !first) { first = true; await gate; }
    };
    const payload = { invoiceId: INV_A, paymentMethod: 'mpesa', paymentRef: 'RACE' };
    const a = pay(auth(UID_A, ADMIN), payload).catch((e) => ({ __err: e }));
    const b = pay(auth(UID_A, ADMIN), payload).catch((e) => ({ __err: e }));
    setTimeout(release, 10);
    const [r1, r2] = await Promise.all([a, b]);
    delete L.data.__beforeRead;

    check('CONCURRENT: both attempts resolve without an inconsistent error', !r1.__err && !r2.__err);
    check('CONCURRENT: exactly two ledger rows — not four', ledgerRows(L, INV_A).length === 2);
    check('CONCURRENT: supplier balance decremented ONCE', balanceOf(L, 'supA') === 0);
    check('CONCURRENT: the invoice is paid exactly once', L.data.procSupplierInvoices[INV_A].status === 'paid');
    check('CONCURRENT: both callers see the same invoice outcome',
      !r1.__err && !r2.__err && r1.invoiceId === r2.invoiceId && r1.total === r2.total);
  }

  /* ══════════════════════════════════════════════════════════
     §7 PAYMENT — state + partial-execution guards
  ══════════════════════════════════════════════════════════ */
  console.log('\n§7 state guards + atomicity');
  {
    const d = freshData();
    d.procSupplierInvoices.inv_disputed = { invoiceId: 'inv_disputed', poId: PO_A, merchantId: BIZ_A,
      supplierId: 'supA', invoiceNumber: 'D', total: 100, status: 'disputed', paidAt: null };
    d.procSupplierInvoices.inv_nosupplier = { invoiceId: 'inv_nosupplier', poId: PO_A, merchantId: BIZ_A,
      supplierId: 'ghost', invoiceNumber: 'N', total: 100, status: 'pending', paidAt: null };
    const L = loadProcurement(d); const pay = invoker(L, 'approveAndPayInvoice');

    const disp = await verdict(() => pay(auth(UID_A, ADMIN), { invoiceId: 'inv_disputed', paymentMethod: 'cash' }));
    check('a disputed invoice cannot be paid', !disp.ok);
    check('the disputed invoice wrote no ledger row', ledgerRows(L, 'inv_disputed').length === 0);

    const noSup = await verdict(() => pay(auth(UID_A, ADMIN), { invoiceId: 'inv_nosupplier', paymentMethod: 'cash' }));
    check('an invoice whose supplier is missing cannot be paid', !noSup.ok && noSup.code === 'failed-precondition');
    check('PARTIAL EXECUTION: the failed payment wrote NO ledger row', ledgerRows(L, 'inv_nosupplier').length === 0);
    check('PARTIAL EXECUTION: the failed payment left the invoice unpaid',
      L.data.procSupplierInvoices.inv_nosupplier.status === 'pending');
  }

  /* ══════════════════════════════════════════════════════════
     §8 structural + preservation
  ══════════════════════════════════════════════════════════ */
  console.log('\n§8 structure + preservation');
  check('payment is transactional', /const approveAndPayInvoice[\s\S]{0,2500}db\.runTransaction/.test(PROC));
  sab('the transactional detector is not vacuous',
    !/const approveAndPayInvoice[\s\S]{0,2500}db\.runTransaction/.test(
      'const approveAndPayInvoice = onCall(OPT, async (r) => { const b = db.batch(); await b.commit(); });'));
  check('the paid-check is INSIDE the transaction',
    /runTransaction\(async \(t\) => \{[\s\S]{0,400}if \(inv\.paidAt\)/.test(PROC));
  sab('the detector catches a read-then-write paid check',
    !/runTransaction\(async \(t\) => \{[\s\S]{0,400}if \(inv\.paidAt\)/.test(
      "const inv = (await invRef.get()).data();\nif (inv.paidAt !== null) _err('paid');\nconst batch = db.batch();"));
  check('ledger ids are derived from the invoice', /_deterministicId\(invoiceId \+ '\|debit', 'led'\)/.test(PROC));
  check('payment no longer uses a non-transactional batch',
    !/const approveAndPayInvoice[\s\S]{0,3000}db\.batch\(\)/.test(PROC));
  check('the admin requirement is retained', /const approveAndPayInvoice[\s\S]{0,200}_requireAdmin\(request\)/.test(PROC));
  check('merchant scoping is composed with it', /_assertMerchantAuthority\(request, invPre\.merchantId\)/.test(PROC));

  check('PRESERVED: double-entry semantics unchanged',
    /account: 'accounts_payable'/.test(PROC) && /type: 'credit', account: method/.test(PROC));
  check('PRESERVED: the 5% deviation tolerance (existing contract)', /deviation > 0\.05/.test(PROC));
  check('PRESERVED: Slice D receipt hardening', /_deterministicId\(keySeed, 'grn'\)/.test(PROC));
  check('PRESERVED: Slice C send/approve gates', /const sendPurchaseOrder[\s\S]{0,700}_assertPoAuthority/.test(PROC));
  check('NOT TOUCHED: sendPurchaseOrder delivery abstraction', /emailId:\s*`po-sent-\$\{poId\}`/.test(PROC));

  console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed  ·  ' + sabotageOk + '/' + sabotage + ' sabotage catches');
  if (fail) { console.log('\n  ' + fail + ' FAILURE(S):'); failures.forEach((f) => console.log('    - ' + f)); process.exit(1); }
  console.log('\n  PASS — payment executes once, is merchant-scoped, and never partially applies.\n');
})().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });
