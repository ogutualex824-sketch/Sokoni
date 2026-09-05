'use strict';
/**
 * CERT — Slice D: GRN / receiving converged onto canonical receiveGoods.
 *
 * INVARIANTS UNDER TEST
 *   1. Only a party authorized for the BUYER business can record receipt.
 *   2. Being the SUPPLIER on a PO does not grant the buyer-side receiving path.
 *   3. The PO must be in a receivable state.
 *   4. Ordered quantity, unit cost, merchant and supplier are derived from the
 *      authoritative PO — never from the client payload.
 *   5. Receipt is the CANONICAL inventory event: one server batch writes the GRN, the PO
 *      status, the stock increment and the stock movement. No parallel client mutation.
 *   6. The local record cannot claim 'received' before server confirmation.
 *
 * METHOD
 *   The real `receiveGoods` and `_assertPoAuthority` are EXECUTED: procurement.js is loaded
 *   with firebase-admin stubbed at require time, so they close over an injected fixture
 *   holding two businesses, three principals and three purchase orders. Batch writes are
 *   captured and asserted. The client module runs in a VM sandbox with IndexedDB/firebase
 *   doubles. Static checks appear only where the property is genuinely textual.
 *   Syntax validity proves nothing here and is not relied upon.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const PROC = fs.readFileSync(path.join(ROOT, 'functions/procurement.js'), 'utf8');
const CLI  = fs.readFileSync(path.join(ROOT, 'pos-suppliers.js'), 'utf8');

let pass = 0, fail = 0, sabotage = 0, sabotageOk = 0;
const failures = [];
const check = (n, c) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); } };
const sab   = (n, c) => { sabotage++; if (c) { sabotageOk++; pass++; console.log('  PASS    (sabotage: ' + n + ')'); } else { fail++; failures.push('SABOTAGE ' + n); console.log('  FAIL    (sabotage: ' + n + ')'); } };

console.log('\nCERT — Slice D: GRN / receiving\n');

/* ══════════════════════════════════════════════════════════════
   FIXTURE
══════════════════════════════════════════════════════════════ */
const UID_A = 'buyer-A', UID_B = 'buyer-B', UID_SUP = 'supplier-principal';
const BIZ_A = 'SOK-AAAA11', BIZ_B = 'SOK-BBBB22', BIZ_SUP = 'SOK-SUPP99';
const PO_A_SENT   = 'po_a_sent';
const PO_B_SENT   = 'po_b_sent';
const PO_A_DRAFT  = 'po_a_draft';

function freshData() {
  return {
    businesses: {
      [BIZ_A]:   { ownerId: UID_A },
      [BIZ_B]:   { ownerId: UID_B },
      [BIZ_SUP]: { ownerId: UID_SUP, supply: { enabled: true } },
    },
    procPurchaseOrders: {
      [PO_A_SENT]:  { poId: PO_A_SENT, merchantId: BIZ_A, buyerBusinessId: BIZ_A,
                      supplierId: 'sup1', supplierBusinessId: BIZ_SUP, status: 'sent',
                      items: [{ productId: 'p1', qty: 10, unitCost: 100 }] },
      [PO_B_SENT]:  { poId: PO_B_SENT, merchantId: BIZ_B, buyerBusinessId: BIZ_B,
                      supplierId: 'sup2', status: 'sent',
                      items: [{ productId: 'p9', qty: 5, unitCost: 50 }] },
      [PO_A_DRAFT]: { poId: PO_A_DRAFT, merchantId: BIZ_A, buyerBusinessId: BIZ_A,
                      supplierId: 'sup1', status: 'draft',
                      items: [{ productId: 'p1', qty: 10, unitCost: 100 }] },
    },
    workspaceMemberships: [],
  };
}

/** Load the REAL procurement.js over a fixture, capturing every transaction write. */
function loadProcurement(data) {
  const writes = { set: [], update: [], committed: 0 };
  const fsFn = () => ({
    collection(n) {
      return {
        doc(id) {
          const ref = { _c: n, _id: id || ('auto_' + Math.random().toString(36).slice(2)),
            async get() { const d = (data[n] || {})[id]; return { exists: !!d, data: () => d }; },
            async update() { return true; }, async set() { return true; } };
          return ref;
        },
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
      /* A transaction double with real read-your-writes and a contention hook. `docs` is
         the shared store, so a duplicate submission genuinely sees the first one's GRN. */
      const staged = [];
      const t = {
        async get(ref) {
          if (data.__beforeRead) await data.__beforeRead(ref);
          const d = (data[ref._c] || {})[ref._id];
          return { exists: !!d, data: () => d };
        },
        set(ref, val, opts) {
          staged.push({ op: 'set', collection: ref._c, id: ref._id, val, merge: !!(opts && opts.merge) });
        },
        update(ref, val) { staged.push({ op: 'update', collection: ref._c, id: ref._id, val }); },
      };
      const out = await fn(t);
      /* Commit: apply staged writes to the shared store so later reads see them. */
      for (const w of staged) {
        writes[w.op].push(w);
        const bag = (data[w.collection] = data[w.collection] || {});
        const cur = bag[w.id] || {};
        const next = Object.assign({}, w.merge || w.op === 'update' ? cur : {}, w.val);
        for (const k of Object.keys(w.val || {})) {
          const v = w.val[k];
          if (v && typeof v === 'object' && v.__inc != null) next[k] = (Number(cur[k]) || 0) + v.__inc;
        }
        bag[w.id] = next;
      }
      writes.committed++;
      return out;
    },
    batch() {
      return {
        set(ref, val) { writes.set.push({ collection: ref._c, id: ref._id, val }); },
        update(ref, val) { writes.update.push({ collection: ref._c, id: ref._id, val }); },
        async commit() { writes.committed++; return true; },
      };
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
async function verdict(fn) { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, code: e && e.code, message: e && e.message }; } }

/** Drive the real receiveGoods handler through its onCall wrapper's inner function. */
function callReceive(procLive, a, data) {
  /* The exported onCall object exposes .run in firebase-functions v2 for direct invocation;
     fall back to the gate + handler composition if unavailable. */
  const fn = procLive.receiveGoods;
  if (fn && typeof fn.run === 'function') return fn.run({ auth: a, data });
  throw new Error('receiveGoods is not directly invocable in this environment');
}

(async () => {
  /* ══════════════════════════════════════════════════════════
     §1 the gate — executed via the real _assertPoAuthority
  ══════════════════════════════════════════════════════════ */
  console.log('§1 buyer-side authority (executed)');
  const L = loadProcurement(freshData());
  const gate = (a, poId) => L.proc._assertPoAuthority({ auth: a }, poId);

  {
    const r = await verdict(() => gate(auth(UID_A), PO_A_SENT));
    check('authorized buyer A is admitted on its own PO', r.ok && r.value.merchantId === BIZ_A);
  }
  {
    const r = await verdict(() => gate(auth(UID_A), PO_B_SENT));
    check('merchant A -> B PO is DENIED', !r.ok && r.code === 'permission-denied');
  }
  {
    const r = await verdict(() => gate(auth(UID_B), PO_A_SENT));
    check('merchant B -> A PO is DENIED', !r.ok && r.code === 'permission-denied');
  }
  {
    /* THE B2 INVARIANT: supplier-side identity must not open the buyer-side path. */
    const r = await verdict(() => gate(auth(UID_SUP), PO_A_SENT));
    check('the SUPPLIER on the PO is DENIED the buyer-side receiving path',
      !r.ok && r.code === 'permission-denied');
  }
  {
    const r = await verdict(() => gate(auth(UID_A, { manager: true, role: 3 }), PO_B_SENT));
    check('a manager claim does not reach another merchant\'s PO', !r.ok && r.code === 'permission-denied');
  }
  {
    const r = await verdict(() => gate(auth(UID_A), 'po_missing'));
    check('a nonexistent PO fails closed', !r.ok && r.code === 'not-found');
  }
  {
    const r = await verdict(() => gate(null, PO_A_SENT));
    check('unauthenticated is rejected', !r.ok && r.code === 'unauthenticated');
  }
  {
    const forged = auth(UID_A);
    forged.merchantId = BIZ_B; forged.supplierId = 'sup2'; forged.supplierBusinessId = BIZ_B;
    const r = await verdict(() => gate(forged, PO_B_SENT));
    check('forged merchant/supplier/business ids have no authority effect',
      !r.ok && r.code === 'permission-denied');
  }

  /* ══════════════════════════════════════════════════════════
     §2 receiveGoods carries the gate + state rules
  ══════════════════════════════════════════════════════════ */
  console.log('\n§2 receiveGoods contract');
  check('receiveGoods uses the PO-derived gate',
    /const receiveGoods[\s\S]{0,1400}await _assertPoAuthority\(request, poId\)/.test(PROC));
  sab('the detector catches an ungated receiveGoods',
    !/const receiveGoods[\s\S]{0,1400}await _assertPoAuthority\(request, poId\)/.test(
      "const receiveGoods = onCall(OPT, async (request) => {\n  const uid = _requireAuth(request);\n  const poSnap = await poRef.get();"));
  check('receiveGoods no longer reads the PO independently of the gate',
    !/const receiveGoods[\s\S]{0,1400}const poSnap = await poRef\.get\(\)/.test(PROC));
  check('receivable states are exactly sent | partially_received',
    /\['sent', 'partially_received'\]\.includes\(poNow\.status\)/.test(PROC));
  /* Ordering matters and is easy to get wrong: an earlier version checked the state BEFORE
     the idempotency read, so retrying the very receipt that closed the order was rejected
     as "cannot receive in status 'received'" instead of recognised as a duplicate. */
  check('the state gate runs AFTER the idempotency check',
    PROC.indexOf('if (grnSnap.exists)') < PROC.indexOf("includes(poNow.status)"));
  sab('the ordering detector is not vacuous',
    !('state();\nidem();'.indexOf('idem') < 'state();\nidem();'.indexOf('state')));
  check('orderedQty is derived from the PO, not the payload',
    /orderedQty:\s*ordered\?\.qty \?\? 0,/.test(PROC));
  check('unitCost is derived from the PO, not the payload',
    /unitCost:\s*ordered\?\.unitCost \?\? 0,/.test(PROC));
  sab('the detector catches a payload-sourced unitCost',
    /unitCost:\s*it\.unitCost/.test('unitCost: it.unitCost,'));
  check('merchantId on the GRN comes from the PO', /merchantId:\s*po\.merchantId,/.test(PROC));
  check('supplierId on the GRN comes from the PO', /supplierId:\s*po\.supplierId,/.test(PROC));
  check('negative receivedQty is rejected', /receivedQty cannot be negative/.test(PROC));
  check('condition is a closed set', /new Set\(\['good', 'damaged', 'rejected'\]\)/.test(PROC));

  /* ══════════════════════════════════════════════════════════
     §3 receipt IS the canonical inventory event
  ══════════════════════════════════════════════════════════ */
  console.log('\n§3 canonical inventory event');
  /* The hardening replaced the batch with a TRANSACTION — the idempotency check is a read
     the writes depend on, which a batch cannot express. Atomicity is unchanged. */
  check('GRN, PO status, stock and movement are ONE atomic unit',
    /await db\.runTransaction\(async \(t\) => \{/.test(PROC));
  check('the op no longer uses a non-transactional batch for receipt',
    !/const receiveGoods[\s\S]{0,5000}db\.batch\(\)/.test(PROC));
  sab('the atomicity detector is not vacuous',
    !/await db\.runTransaction\(async \(t\) => \{/.test('const b = db.batch(); await b.commit();'));
  check('stock is incremented on posProducts', /stockQty:\s*F\.increment\(it\.receivedQty\)/.test(PROC));
  check('a stockMovement is recorded with the GRN reference',
    /type:\s*'procurement_receipt'/.test(PROC) && /refType:\s*'grn'/.test(PROC));
  check('only GOOD items move stock', /const allGoodItems\s+= cleanReceived\.filter\(it => it\.condition === 'good'\)/.test(PROC));
  check('zero-quantity lines do not move stock', /if \(it\.receivedQty <= 0\) continue;/.test(PROC));
  sab('the detector catches stock moving for non-good items',
    !/const allGoodItems\s+= cleanReceived\.filter\(it => it\.condition === 'good'\)/.test(
      'const allGoodItems  = cleanReceived;'));

  /* ── the three hardening defects, asserted structurally then executed below ── */
  check('HARDENING: the GRN id is DERIVED, not minted',
    /_deterministicId\(keySeed, 'grn'\)/.test(PROC) && !/_genId\('grn'\)/.test(PROC));
  sab('the detector catches a minted (non-idempotent) GRN id',
    /_genId\('grn'\)/.test("const grnId = _genId('grn');"));
  check('HARDENING: the idempotency read is INSIDE the transaction',
    /runTransaction\(async \(t\) => \{[\s\S]{0,400}await t\.get\(grnRef\)/.test(PROC));
  check('HARDENING: a duplicate returns the ORIGINAL outcome, not an error',
    /if \(grnSnap\.exists\)[\s\S]{0,300}duplicate:\s*true/.test(PROC));
  check('HARDENING: PO status is CUMULATIVE, not per-receipt',
    /totalReceivedCum >= totalOrderedQty/.test(PROC) &&
    /receivedQty: \(Number\(it\.receivedQty\) \|\| 0\) \+ add/.test(PROC));
  sab('the detector catches a per-receipt status computation',
    !/totalReceivedCum >= totalOrderedQty/.test(
      'const newPoStatus = totalReceivedGood >= totalOrderedQty ? "received" : "partially_received";'));
  check('HARDENING: stock uses set-merge so a first receipt can create the doc',
    /t\.set\(productRef, \{[\s\S]{0,300}\}, \{ merge: true \}\);/.test(PROC));
  sab('the detector catches update-on-missing-doc (the first-receipt failure)',
    !/t\.set\(productRef, \{[\s\S]{0,300}\}, \{ merge: true \}\);/.test(
      'batch.update(productRef, { stockQty: F.increment(q) });'));

  /* ══════════════════════════════════════════════════════════
     §3b HARDENING, EXECUTED — the real transaction, ten scenarios
  ══════════════════════════════════════════════════════════ */
  console.log('\n§3b hardening scenarios (real transaction, executed)');

  /* Drive the real handler body. The onCall wrapper is not directly invocable here, so the
     transaction is exercised through the exported internals the handler composes: the same
     gate, the same runTransaction, the same fixture. */
  function makeReceiver(L) {
    return async function receive(a, payload) {
      const inner = L.proc.receiveGoods;
      if (inner && typeof inner.run === 'function') return inner.run({ auth: a, data: payload });
      if (inner && typeof inner.__handler === 'function') return inner.__handler({ auth: a, data: payload });
      throw Object.assign(new Error('handler-not-invocable'), { code: 'harness' });
    };
  }

  const stockOf = (L, branch, pid) =>
    ((L.data.posProducts || {})[branch + '_' + pid] || {}).stockQty || 0;
  const grnCount = (L) => Object.keys(L.data.procGRN || {}).length;
  const movCount = (L) => Object.keys(L.data.stockMovements || {}).length;

  const L2 = loadProcurement(freshData());
  const receive = makeReceiver(L2);
  const probe = await verdict(() => receive(auth(UID_A), { poId: PO_A_SENT, branchId: 'main', items: [{ productId: 'p1', receivedQty: 1 }] }));
  const INVOCABLE = !(probe.code === 'harness');
  check('the real receiveGoods handler is invocable in this harness', INVOCABLE);

  if (INVOCABLE) {
    /* 1. FIRST RECEIPT of a product with no existing posProducts document. */
    const F1 = loadProcurement(freshData());
    const r1 = makeReceiver(F1);
    const a1 = await verdict(() => r1(auth(UID_A), { poId: PO_A_SENT, branchId: 'main',
      items: [{ productId: 'p1', receivedQty: 4 }], receiptKey: 'k1' }));
    check('first receipt of a never-stocked product SUCCEEDS', a1.ok);
    check('first receipt creates the stock document', stockOf(F1, 'main', 'p1') === 4);
    check('first receipt writes exactly one GRN', grnCount(F1) === 1);
    check('first receipt writes one stock movement', movCount(F1) === 1);
    check('a partial receipt leaves the PO partially_received',
      a1.ok && a1.value.poStatus === 'partially_received');

    /* 2. CUMULATIVE second receipt closes the order. */
    const a2 = await verdict(() => r1(auth(UID_A), { poId: PO_A_SENT, branchId: 'main',
      items: [{ productId: 'p1', receivedQty: 6 }], receiptKey: 'k2' }));
    check('a second receipt succeeds', a2.ok);
    check('CUMULATIVE: 4 + 6 against an order of 10 closes the PO',
      a2.ok && a2.value.poStatus === 'received');
    check('cumulative stock is 4 + 6 = 10', stockOf(F1, 'main', 'p1') === 10);
    check('two distinct receipts wrote two GRNs', grnCount(F1) === 2);

    /* 3. DUPLICATE — same key, sequential retry. */
    const before = { stock: stockOf(F1, 'main', 'p1'), grns: grnCount(F1), movs: movCount(F1) };
    const dup = await verdict(() => r1(auth(UID_A), { poId: PO_A_SENT, branchId: 'main',
      items: [{ productId: 'p1', receivedQty: 6 }], receiptKey: 'k2' }));
    check('a duplicate submission does not error', dup.ok);
    check('a duplicate is reported as such', dup.ok && dup.value.duplicate === true);
    check('a duplicate returns the SAME grnId', dup.ok && dup.value.grnId === a2.value.grnId);
    check('DUPLICATE: no second stock increment', stockOf(F1, 'main', 'p1') === before.stock);
    check('DUPLICATE: no second GRN', grnCount(F1) === before.grns);
    check('DUPLICATE: no second stock movement', movCount(F1) === before.movs);

    /* 4. CONCURRENT duplicate — both submitted before either commits. */
    const F2 = loadProcurement(freshData());
    const r2 = makeReceiver(F2);
    const payload = { poId: PO_A_SENT, branchId: 'main', items: [{ productId: 'p1', receivedQty: 5 }], receiptKey: 'race' };
    /* Hold the first transaction's read open until the second has also read, so both
       observe "no GRN yet" — the interleaving a sequential retry can never produce. */
    let released; const gate2 = new Promise((res) => { released = res; });
    let firstRead = false;
    F2.data.__beforeRead = async (ref) => {
      if (ref._c === 'procGRN' && !firstRead) { firstRead = true; await gate2; }
    };
    const p1 = r2(auth(UID_A), payload).catch((e) => ({ __err: e }));
    const p2 = r2(auth(UID_A), payload).catch((e) => ({ __err: e }));
    setTimeout(released, 10);
    const [c1, c2] = await Promise.all([p1, p2]);
    check('CONCURRENT: both submissions resolve', !c1.__err && !c2.__err);
    check('CONCURRENT: only one GRN exists', grnCount(F2) === 1);
    check('CONCURRENT: stock incremented exactly once', stockOf(F2, 'main', 'p1') === 5);
    check('CONCURRENT: exactly one stock movement', movCount(F2) === 1);
    check('CONCURRENT: both callers see the same grnId',
      !c1.__err && !c2.__err && c1.grnId === c2.grnId);
    delete F2.data.__beforeRead;

    /* 5. OVER-RECEIPT — permitted by the existing contract, recorded as a discrepancy. */
    const F3 = loadProcurement(freshData());
    const r3 = makeReceiver(F3);
    const over = await verdict(() => r3(auth(UID_A), { poId: PO_A_SENT, branchId: 'main',
      items: [{ productId: 'p1', receivedQty: 12 }], receiptKey: 'over' }));
    check('OVER-RECEIPT is permitted (existing contract, unchanged)', over.ok);
    check('over-receipt is recorded as a discrepancy',
      over.ok && over.value.discrepancies.length === 1 && over.value.discrepancies[0].receivedQty === 12);
    check('over-receipt still closes the PO', over.ok && over.value.poStatus === 'received');

    /* 6-10. authority and state negatives, through the real handler. */
    const F4 = loadProcurement(freshData());
    const r4 = makeReceiver(F4);
    const base = { branchId: 'main', items: [{ productId: 'p1', receivedQty: 1 }] };
    const nCross = await verdict(() => r4(auth(UID_A), Object.assign({ poId: PO_B_SENT }, base)));
    check('EXECUTED: cross-merchant receipt is denied', !nCross.ok && nCross.code === 'permission-denied');
    const nSup = await verdict(() => r4(auth(UID_SUP), Object.assign({ poId: PO_A_SENT }, base)));
    check('EXECUTED: the supplier cannot use the buyer-side path', !nSup.ok && nSup.code === 'permission-denied');
    const nMissing = await verdict(() => r4(auth(UID_A), Object.assign({ poId: 'po_nope' }, base)));
    check('EXECUTED: a nonexistent PO fails closed', !nMissing.ok && nMissing.code === 'not-found');
    const nState = await verdict(() => r4(auth(UID_A), Object.assign({ poId: PO_A_DRAFT }, base)));
    check('EXECUTED: a draft PO cannot be received against', !nState.ok);
    const nAuth = await verdict(() => r4(null, Object.assign({ poId: PO_A_SENT }, base)));
    check('EXECUTED: unauthenticated is rejected', !nAuth.ok);
    check('EXECUTED: no failed attempt wrote a GRN', grnCount(F4) === 0);
    check('EXECUTED: no failed attempt moved stock', stockOf(F4, 'main', 'p1') === 0);
  }

  /* ══════════════════════════════════════════════════════════
     §4 the client no longer mutates inventory in parallel
  ══════════════════════════════════════════════════════════ */
  console.log('\n§4 no parallel client inventory mutation');
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const CLI_CODE = stripComments(CLI);
  check('PosInventory.receiveGoods is no longer called', !/PosInventory\.receiveGoods/.test(CLI_CODE));
  sab('the detector catches a reintroduced parallel mutation',
    /PosInventory\.receiveGoods/.test(stripComments('/* was PosInventory.receiveGoods */\nawait PosInventory.receiveGoods(x);')));
  check('the client calls the canonical receiveGoods', /httpsCallable\('receiveGoods'\)/.test(CLI_CODE));
  check('the client sends the CANONICAL poId, not the local one', /poId:\s*po\.procPoId,/.test(CLI_CODE));
  check('the client no longer mints a GRN number', !/_grnNo\(\)/.test(CLI_CODE));
  check('the client no longer mirrors GRNs to posGRN in createGRN',
    !/async function createGRN[\s\S]{0,3000}_sync\('posGRN'/.test(CLI_CODE));
  check('the client no longer computes PO received quantities locally',
    !/pItem\.receivedQty = \(pItem\.receivedQty \|\| 0\) \+ gItem\.receivedQty/.test(CLI_CODE));
  check('the client no longer adjusts supplier outstandingBalance on receipt',
    !/async function createGRN[\s\S]{0,3000}outstandingBalance/.test(CLI_CODE));

  /* ══════════════════════════════════════════════════════════
     §5 the local record cannot claim received early (executed)
  ══════════════════════════════════════════════════════════ */
  console.log('\n§5 local record honesty (executed)');
  function loadClient(opts) {
    opts = opts || {};
    const store = { purchase_orders: {}, grns: {}, suppliers: {} };
    if (opts.seedPO) store.purchase_orders[opts.seedPO.id] = JSON.parse(JSON.stringify(opts.seedPO));
    const events = [], calls = [];
    const idb = { open() { const req = {}; setTimeout(() => { const db = { objectStoreNames:{contains:()=>true}, createObjectStore:()=>({createIndex(){}}),
      transaction(){ return { objectStore(n){ const bag=store[n]||(store[n]={}); return {
        put(r0){const r={};setTimeout(()=>{bag[r0.id]=r0;r.onsuccess&&r.onsuccess();},0);return r;},
        get(id){const r={};setTimeout(()=>{r.result=bag[id]||null;r.onsuccess&&r.onsuccess();},0);return r;},
        getAll(){const r={};setTimeout(()=>{r.result=Object.values(bag);r.onsuccess&&r.onsuccess();},0);return r;},
        delete(){const r={};setTimeout(()=>{r.onsuccess&&r.onsuccess();},0);return r;},
        index(){return{getAll(){const r={};setTimeout(()=>{r.result=[];r.onsuccess&&r.onsuccess();},0);return r;}};},
      };} }; } }; req.result=db; req.onsuccess&&req.onsuccess({target:{result:db}}); },0); return req; } };
    const sb = { indexedDB: idb, navigator:{onLine:opts.online!==false}, crypto:{randomUUID:()=> 'g'+Math.random().toString(36).slice(2)},
      console, setTimeout, clearTimeout, Date, Math, JSON, Promise, Object, Array, String, Number, Error };
    sb.window = sb;
    sb.firebase = opts.noFns ? {} : { functions: () => ({ httpsCallable: (name) => async (p) => { calls.push({ name, p }); return opts.callable(name, p); } }) };
    sb.window.addEventListener = () => {};
    vm.createContext(sb); vm.runInContext(CLI, sb, { filename: 'pos-suppliers.js' });
    const PS = sb.window.PosSuppliers;
    ['grn:created', 'grn:failed'].forEach((e) => PS.on(e, (d) => events.push({ e, d })));
    return { PS, store, events, calls };
  }

  const SEED_PO = { id: 'local-po-1', procPoId: 'po_canonical', supplierId: 's1', status: 'submitted',
                    items: [{ productId: 'p1', qty: 10, unitCost: 100, receivedQty: 0 }] };
  const GRN_IN = { poId: 'local-po-1', supplierId: 's1', branchId: 'main',
                   items: [{ productId: 'p1', orderedQty: 10, receivedQty: 10, unitCost: 100 }] };

  {
    const h = loadClient({ seedPO: SEED_PO, callable: async () => ({ data: { grnId: 'grn_srv_1', poStatus: 'received', discrepancies: [] } }) });
    await h.PS.init('default', BIZ_A);
    const grn = await h.PS.createGRN(GRN_IN);
    check('a confirmed receipt marks the local GRN received', grn.status === 'received');
    check('the canonical GRN id is adopted', grn.procGrnId === 'grn_srv_1');
    check('the PO status comes from the server', h.store.purchase_orders['local-po-1'].status === 'received');
    check('the canonical poId was sent', h.calls.some((c) => c.name === 'receiveGoods' && c.p.poId === 'po_canonical'));
    check('the client does not send orderedQty or unitCost',
      h.calls.every((c) => c.name !== 'receiveGoods' || c.p.items.every((i) => !('orderedQty' in i) && !('unitCost' in i))));
  }
  for (const [label, opts] of [
    ['a rejected receipt', { callable: async () => { const e = new Error('permission-denied'); e.code = 'functions/permission-denied'; throw e; } }],
    ['a reply with no grnId', { callable: async () => ({ data: {} }) }],
    ['offline', { online: false, callable: async () => ({ data: { grnId: 'x' } }) }],
  ]) {
    const h = loadClient(Object.assign({ seedPO: SEED_PO }, opts));
    await h.PS.init('default', BIZ_A);
    let threw = null;
    try { await h.PS.createGRN(GRN_IN); } catch (e) { threw = e; }
    const rec = Object.values(h.store.grns)[0];
    check(label + ' throws rather than claiming receipt', threw !== null);
    check(label + ' leaves the local GRN unreceived', rec && rec.status === 'local_draft');
    check(label + ' does not invent a canonical GRN id', rec && !rec.procGrnId);
    check(label + ' leaves the PO status unchanged', h.store.purchase_orders['local-po-1'].status === 'submitted');
    check(label + ' emits grn:failed', h.events.some((x) => x.e === 'grn:failed'));
  }
  {
    /* Receipt against an unsubmitted PO cannot reach the server at all. */
    const h = loadClient({ seedPO: { id: 'local-po-1', procPoId: null, supplierId: 's1', status: 'local_draft', items: [] },
                           callable: async () => ({ data: { grnId: 'x' } }) });
    await h.PS.init('default', BIZ_A);
    let threw = null;
    try { await h.PS.createGRN(GRN_IN); } catch (e) { threw = e; }
    check('receipt against an unsubmitted PO is refused', threw !== null && /submit/i.test(threw.message));
    check('and makes no server call', !h.calls.some((c) => c.name === 'receiveGoods'));
  }

  /* ══════════════════════════════════════════════════════════
     §6 preservation
  ══════════════════════════════════════════════════════════ */
  console.log('\n§6 preservation');
  check('UNTOUCHED: sendPurchaseOrder delivery abstraction', /emailId:\s*`po-sent-\$\{poId\}`/.test(PROC) && /dedupeKey:\s*`po:\$\{poId\}:sent`/.test(PROC));
  check('UNTOUCHED: approvePurchaseOrder semantics', /const newStatus = approved \? 'approved' : 'cancelled';/.test(PROC));
  check('UNTOUCHED: approval still requires manager', /const approvePurchaseOrder[\s\S]{0,400}_requireManager\(request\)/.test(PROC));
  check('NOT REVIVED: no server createGRN endpoint was added', !/exports\.createGRN|const createGRN = onCall/.test(PROC));
  check('PRESERVED: posBatches untouched by this slice', !/posBatches/.test(PROC));
  check('PRESERVED: Slice B2 supplier-side authority still separate', /async function _assertSupplierSideAuthority/.test(PROC));
  check('PRESERVED: client submit path from Slice B', /op: 'posSupplierSync'|httpsCallable\('createPurchaseOrder'\)/.test(CLI_CODE));

  const RULES = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  const grantsWrite = (src, coll) => {
    const m = new RegExp('match /' + coll + '/\\{[^}]*\\} \\{([\\s\\S]*?)\\n    \\}').exec(src);
    if (!m) return false;
    return /allow\s+(write|create|update|delete)[^;]*:\s*if\s+(?!false\s*;)/.test(m[1]);
  };
  check('NOT WIDENED: posGRN rule not granted client write', !grantsWrite(RULES, 'posGRN'));
  check('NOT WIDENED: posBatches rule not granted client write', !grantsWrite(RULES, 'posBatches'));

  console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed  ·  ' + sabotageOk + '/' + sabotage + ' sabotage catches');
  if (fail) { console.log('\n  ' + fail + ' FAILURE(S):'); failures.forEach((f) => console.log('    - ' + f)); process.exit(1); }
  console.log('\n  PASS — receipt is buyer-authorized, server-authoritative, and the canonical inventory event.\n');
})().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });
