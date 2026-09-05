'use strict';
/**
 * CERT — Slice B: canonical PO convergence.
 *
 * INVARIANTS UNDER TEST
 *   1. Exactly one authoritative PO engine — no browser-side pos* PO cloud writer survives.
 *   2. PO ids and numbers are SERVER-generated; the client generator is gone.
 *   3. IndexedDB is a draft/offline queue, never authoritative cloud truth.
 *   4. A local draft cannot become sent / received / invoiced / paid without server
 *      confirmation.
 *   5. The canonical PO shape carries nullable buyerBusinessId / supplierBusinessId, with
 *      merchantId / supplierId retained for compatibility.
 *   6. procurement.sendPurchaseOrder is unchanged; posSendPurchaseOrder stays retired.
 *
 * METHOD
 *   The client module is loaded into a VM sandbox with IndexedDB / firebase / navigator
 *   doubles and the real createPurchaseOrder / submitPurchaseOrder are EXECUTED. Verdicts
 *   are read off the resulting local records and emitted events. Static checks are used only
 *   where the property is genuinely textual. Syntax validity proves nothing here and is not
 *   relied upon. Every detector is exercised in both directions.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'pos-suppliers.js'), 'utf8');
const PROC = fs.readFileSync(path.join(ROOT, 'functions/procurement.js'), 'utf8');
const IDX  = fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');

let pass = 0, fail = 0, sabotage = 0, sabotageOk = 0;
const failures = [];
const check = (n, c) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); } };
const sab   = (n, c) => { sabotage++; if (c) { sabotageOk++; pass++; console.log('  PASS    (sabotage: ' + n + ')'); } else { fail++; failures.push('SABOTAGE ' + n); console.log('  FAIL    (sabotage: ' + n + ')'); } };

console.log('\nCERT — Slice B: canonical PO convergence\n');

/* ══════════════════════════════════════════════════════════════
   HARNESS
══════════════════════════════════════════════════════════════ */
function load(opts) {
  opts = opts || {};
  const store = { purchase_orders: {}, suppliers: {}, grns: {}, supplier_invoices: {}, supplier_payments: {} };
  const events = [];
  const calls  = [];
  const idb = { open() { const req = {}; setTimeout(() => {
    const db = { objectStoreNames: { contains: () => true }, createObjectStore: () => ({ createIndex() {} }),
      transaction() { return { objectStore(n) { const bag = store[n] || (store[n] = {}); return {
        put(rec) { const r = {}; setTimeout(() => { bag[rec.id] = rec; r.onsuccess && r.onsuccess(); }, 0); return r; },
        get(id)  { const r = {}; setTimeout(() => { r.result = bag[id] || null; r.onsuccess && r.onsuccess(); }, 0); return r; },
        getAll() { const r = {}; setTimeout(() => { r.result = Object.values(bag); r.onsuccess && r.onsuccess(); }, 0); return r; },
        delete() { const r = {}; setTimeout(() => { r.onsuccess && r.onsuccess(); }, 0); return r; },
        index() { return { getAll() { const r = {}; setTimeout(() => { r.result = []; r.onsuccess && r.onsuccess(); }, 0); return r; } }; },
      }; } }; } };
    req.result = db; req.onsuccess && req.onsuccess({ target: { result: db } }); }, 0); return req; } };

  const sandbox = { indexedDB: idb, navigator: { onLine: opts.online !== false },
    crypto: { randomUUID: () => 'local-' + (opts.seq = (opts.seq || 0) + 1) },
    console, setTimeout, clearTimeout, Date, Math, JSON, Promise, Object, Array, String, Number, Error };
  sandbox.window = sandbox;
  sandbox.firebase = opts.noFns ? {} : { functions: () => ({
    httpsCallable: (name) => async (payload) => { calls.push({ name, payload });
      if (!opts.callable) throw new Error('no callable configured');
      return opts.callable(name, payload); } }) };
  sandbox.window.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'pos-suppliers.js' });
  const PS = sandbox.window.PosSuppliers;
  ['po:created', 'po:submitted', 'po:submit-failed', 'po:sent'].forEach((e) => PS.on(e, (d) => events.push({ e, d })));
  return { PS, store, events, calls };
}

const DRAFT = { supplierId: 'sup-1', supplierName: 'S', items: [{ productId: 'p1', productName: 'P', qty: 2, unitCost: 100 }] };
const okCreate = { data: { poId: 'po_canonical_abc', poNumber: 'PO-2026-00042' } };

(async () => {
  /* ══════════════════════════════════════════════════════════
     §1 the client PO-number generator is gone
  ══════════════════════════════════════════════════════════ */
  console.log('§1 server-generated identity');
  check('_poNo() is deleted from the client', !/function _poNo\s*\(/.test(SRC));
  check('_poSeq counter is deleted', !/let _poSeq\s*=/.test(SRC));
  sab('the detector catches a reintroduced client generator',
    /function _poNo\s*\(/.test("function _poNo() { return 'PO-' + y + '-' + (++_poSeq); }"));
  check('the server issues the number from a transactional counter',
    /collection\('procCounters'\)/.test(PROC) && /runTransaction/.test(PROC));

  {
    const h = load({ callable: async () => okCreate });
    await h.PS.init('default', 'merchant-1');
    const po = await h.PS.createPurchaseOrder(DRAFT);
    check('a locally-composed PO has NO poNo', po.poNo === null);
    check('a locally-composed PO has NO canonical id', po.procPoId === null);
    check('a locally-composed PO is status local_draft', po.status === 'local_draft');
    check('local_draft is not a lifecycle state', ['sent', 'received', 'invoiced', 'paid'].indexOf(po.status) === -1);
    check('po:created is still emitted for the local draft', h.events.some((x) => x.e === 'po:created'));
    check('creating a draft makes NO cloud call', h.calls.length === 0);
  }

  /* ══════════════════════════════════════════════════════════
     §2 submission reconciles against the canonical engine
  ══════════════════════════════════════════════════════════ */
  console.log('\n§2 POSITIVE — submission to the canonical engine');
  {
    const h = load({ callable: async () => okCreate });
    await h.PS.init('default', 'merchant-1');
    const draft = await h.PS.createPurchaseOrder(DRAFT);
    const po = await h.PS.submitPurchaseOrder(draft.id);

    check('submission calls the CANONICAL createPurchaseOrder',
      h.calls.some((c) => c.name === 'createPurchaseOrder'));
    check('it does NOT call any pos* PO endpoint',
      !h.calls.some((c) => /posSendPurchaseOrder|posSupplierSync/.test(c.name)));
    check('the canonical poId is stored locally', po.procPoId === 'po_canonical_abc');
    check('the SERVER PO number is adopted', po.poNo === 'PO-2026-00042');
    check('status advances to submitted', po.status === 'submitted');
    check('po:submitted is emitted', h.events.some((x) => x.e === 'po:submitted'));
    check('merchantId is sent as a REQUEST, not asserted as authority',
      h.calls.some((c) => c.name === 'createPurchaseOrder' && c.payload.merchantId === 'merchant-1'));
    check('the client does not send a poNumber', h.calls.every((c) => !('poNumber' in (c.payload || {}))));
    check('the client does not send a poId', h.calls.every((c) => !('poId' in (c.payload || {}))));

    /* idempotent */
    const again = await h.PS.submitPurchaseOrder(draft.id);
    check('re-submitting an already-submitted PO is idempotent', again.procPoId === 'po_canonical_abc');
    check('re-submission makes no second cloud call',
      h.calls.filter((c) => c.name === 'createPurchaseOrder').length === 1);
  }

  /* ══════════════════════════════════════════════════════════
     §3 NEGATIVE — a draft cannot self-promote
  ══════════════════════════════════════════════════════════ */
  console.log('\n§3 NEGATIVE — no promotion without server confirmation');
  for (const [label, opts, expectCall] of [
    ['a rejected submission', { callable: async () => { const e = new Error('permission-denied'); e.code = 'functions/permission-denied'; throw e; } }, true],
    ['a result with no canonical poId', { callable: async () => ({ data: {} }) }, true],
    ['a resolved call with no data', { callable: async () => ({}) }, true],
    ['offline', { online: false, callable: async () => okCreate }, false],
    ['no procurement service', { noFns: true, callable: async () => okCreate }, false],
  ]) {
    const h = load(opts);
    await h.PS.init('default', 'merchant-1');
    const draft = await h.PS.createPurchaseOrder(DRAFT);
    let threw = null;
    try { await h.PS.submitPurchaseOrder(draft.id); } catch (e) { threw = e; }
    const rec = h.store.purchase_orders[draft.id];
    check(label + ' throws rather than claiming success', threw !== null);
    check(label + ' leaves the record a local_draft', rec.status === 'local_draft');
    check(label + ' does not invent a canonical id', !rec.procPoId);
    check(label + ' does not invent a PO number', !rec.poNo);
    check(label + ' records the failure for the merchant', !!rec.lastSubmitError);
    check(label + ' emits po:submit-failed', h.events.some((x) => x.e === 'po:submit-failed'));
    if (!expectCall) check(label + ' makes no cloud call at all', h.calls.length === 0);
  }

  /* ══════════════════════════════════════════════════════════
     §4 no pos* PO cloud writer survives
  ══════════════════════════════════════════════════════════ */
  console.log('\n§4 one authoritative PO engine');
  check('no _sync to posPurchaseOrders remains in the client',
    !/_sync\('posPurchaseOrders'/.test(SRC));
  sab('the detector catches a reintroduced pos* PO mirror',
    /_sync\('posPurchaseOrders'/.test("_sync('posPurchaseOrders', po.id, po);"));

  const syncMod = require(path.join(ROOT, 'functions/pos-supplier-sync.js'));
  check('the sync op no longer registers a purchaseOrder entity',
    !Object.prototype.hasOwnProperty.call(syncMod._ENTITIES, 'purchaseOrder'));
  check('posPurchaseOrders is unreachable through the sync op',
    Object.keys(syncMod._ENTITIES).map((k) => syncMod._ENTITIES[k].collection).indexOf('posPurchaseOrders') === -1);
  sab('the detector would catch a reinstated PO entity',
    Object.prototype.hasOwnProperty.call({ purchaseOrder: {} }, 'purchaseOrder'));

  {
    /* Executed: the op itself must now REJECT a purchaseOrder write. */
    let rejected = false;
    try {
      await syncMod._h.posSupplierSync({ auth: { uid: 'u', token: {} },
        data: { merchantId: 'u', entity: 'purchaseOrder', id: 'x', data: { supplierId: 's' } } });
    } catch (e) { rejected = /Unknown entity/i.test(e.message || ''); }
    check('the sync op rejects a purchaseOrder write at runtime', rejected);
  }

  /* ══════════════════════════════════════════════════════════
     §5 the canonical PO shape
  ══════════════════════════════════════════════════════════ */
  console.log('\n§5 canonical PO shape (additive)');
  check('buyerBusinessId is on the canonical PO', /buyerBusinessId:\s*merchantId,/.test(PROC));
  check('supplierBusinessId is nullable and read off the supplier record',
    /supplierBusinessId:\s*supplier\.supplierBusinessId \|\| null,/.test(PROC));
  /* Scoped to createPurchaseOrder specifically. An earlier version matched the FIRST
     `const { merchantId … } = request.data` in the file, which after Slice B2 is
     addSupplier's — where supplierBusinessId is legitimately accepted and then VERIFIED.
     The invariant here is narrower: the PO must never take the counterparty from the
     caller, because a client asserting "this PO supplies business X" would be declaring a
     relationship it has no authority to declare. */
  const CPO = (/const createPurchaseOrder = onCall[\s\S]*?\}\s*=\s*request\.data \?\? \{\};/.exec(PROC) || [''])[0];
  check('createPurchaseOrder does not destructure supplierBusinessId from the payload',
    CPO.length > 0 && !/supplierBusinessId/.test(CPO));
  check('the PO reads the counterparty off the SUPPLIER record',
    /supplierBusinessId:\s*supplier\.supplierBusinessId \|\| null,/.test(PROC));
  sab('the detector catches a client-supplied supplierBusinessId',
    /supplierBusinessId/.test('const {\n  merchantId, supplierId, supplierBusinessId,\n} = request.data ?? {};'));
  sab('the detector does not misfire on the correct code', !/supplierBusinessId/.test(CPO));
  check('COMPAT: merchantId retained on the PO', /^\s+merchantId,$/m.test(PROC));
  check('COMPAT: supplierId retained on the PO', /^\s+supplierId,$/m.test(PROC));
  check('buyerBusinessId uses the AUTHORIZED merchantId, not the payload',
    /const merchantId = await _assertMerchantAuthority\(request, _requestedMerchantId\);/.test(PROC));

  /* ══════════════════════════════════════════════════════════
     §6 SABOTAGE — differential on the promotion guard
  ══════════════════════════════════════════════════════════ */
  console.log('\n§6 SABOTAGE (executed, differential)');
  const SAB_SRC = SRC.replace(
    "    const data = res && res.data;\n    if (!data || !data.poId) {",
    "    const data = (res && res.data) || { poId: 'FABRICATED' };\n    if (false) {"
  );
  check('the sabotage actually changed the promotion guard', SAB_SRC !== SRC);

  function runWith(src, opts) {
    const saved = fs.readFileSync(path.join(ROOT, 'pos-suppliers.js'), 'utf8');
    const tmp = path.join(require('os').tmpdir(), 'posb_' + Date.now() + '.js');
    fs.writeFileSync(tmp, src);
    /* reuse load() by pointing it at the alternate source */
    const origSrc = SRC;
    return (function () {
      const store = { purchase_orders: {} }; const events = []; const calls = [];
      const idb = { open() { const req = {}; setTimeout(() => { const db = { objectStoreNames:{contains:()=>true}, createObjectStore:()=>({createIndex(){}}),
        transaction(){ return { objectStore(n){ const bag=store[n]||(store[n]={}); return {
          put(r0){const r={};setTimeout(()=>{bag[r0.id]=r0;r.onsuccess&&r.onsuccess();},0);return r;},
          get(id){const r={};setTimeout(()=>{r.result=bag[id]||null;r.onsuccess&&r.onsuccess();},0);return r;},
          getAll(){const r={};setTimeout(()=>{r.result=Object.values(bag);r.onsuccess&&r.onsuccess();},0);return r;},
          delete(){const r={};setTimeout(()=>{r.onsuccess&&r.onsuccess();},0);return r;},
          index(){return{getAll(){const r={};setTimeout(()=>{r.result=[];r.onsuccess&&r.onsuccess();},0);return r;}};},
        };} }; } }; req.result=db; req.onsuccess&&req.onsuccess({target:{result:db}}); },0); return req; } };
      const sb = { indexedDB: idb, navigator:{onLine:true}, crypto:{randomUUID:()=> 'lx'}, console, setTimeout, clearTimeout, Date, Math, JSON, Promise, Object, Array, String, Number, Error };
      sb.window = sb;
      sb.firebase = { functions: () => ({ httpsCallable: (name) => async (p) => { calls.push({name,p}); return opts.callable(); } }) };
      sb.window.addEventListener = () => {};
      vm.createContext(sb); vm.runInContext(src, sb, { filename: 'sab.js' });
      return { PS: sb.window.PosSuppliers, store, events, calls };
    })();
  }

  const sabH = runWith(SAB_SRC, { callable: async () => ({}) });   /* server returns nothing */
  await sabH.PS.init('default', 'm1');
  const sabDraft = await sabH.PS.createPurchaseOrder(DRAFT);
  let sabThrew = null;
  try { await sabH.PS.submitPurchaseOrder(sabDraft.id); } catch (e) { sabThrew = e; }
  const sabRec = sabH.store.purchase_orders[sabDraft.id];

  const curH = load({ callable: async () => ({}) });
  await curH.PS.init('default', 'm1');
  const curDraft = await curH.PS.createPurchaseOrder(DRAFT);
  let curThrew = null;
  try { await curH.PS.submitPurchaseOrder(curDraft.id); } catch (e) { curThrew = e; }
  const curRec = curH.store.purchase_orders[curDraft.id];

  sab('with the guard removed, an EMPTY server reply promotes the draft', sabRec.status === 'submitted');
  sab('with the guard present, the same reply leaves it a local_draft', curRec.status === 'local_draft');
  sab('the two differ — the detector measures the guard', sabRec.status !== curRec.status);
  sab('with the guard removed a FABRICATED id is stored', sabRec.procPoId === 'FABRICATED');
  sab('with the guard present no id is stored', !curRec.procPoId);

  /* ══════════════════════════════════════════════════════════
     §7 preservation
  ══════════════════════════════════════════════════════════ */
  console.log('\n§7 preservation');
  check('UNTOUCHED: sendPurchaseOrder still reads procPurchaseOrders',
    /collection\('procPurchaseOrders'\)\.doc\(poId\)/.test(PROC));
  check('UNTOUCHED: sendPurchaseOrder still requires approved status', /po\.status !== 'approved'/.test(PROC));
  check('NOT REVIVED: posSendPurchaseOrder stays retired', !/^exports\.posSendPurchaseOrder\s*=/m.test(IDX));
  check('PRESERVED: the PO send-honesty guard from e331182',
    /if \(!data \|\| data\.status !== 'sent'\)/.test(SRC));
  check('PRESERVED: observable supplier sync', /op: 'posSupplierSync'/.test(SRC));
  check('PRESERVED: local-first IndexedDB for drafts', /await _put\(S\.POS, po\);/.test(SRC));
  check('getUnsubmittedDrafts is exposed for Slice G', /getUnsubmittedDrafts/.test(SRC));
  {
    const h = load({ callable: async () => okCreate });
    await h.PS.init('default', 'merchant-1');
    const d1 = await h.PS.createPurchaseOrder(DRAFT);
    await h.PS.createPurchaseOrder(DRAFT);
    await h.PS.submitPurchaseOrder(d1.id);
    const un = await h.PS.getUnsubmittedDrafts();
    check('getUnsubmittedDrafts returns only records lacking a canonical id',
      un.length === 1 && !un[0].procPoId);
  }

  console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed  ·  ' + sabotageOk + '/' + sabotage + ' sabotage catches');
  if (fail) { console.log('\n  ' + fail + ' FAILURE(S):'); failures.forEach((f) => console.log('    - ' + f)); process.exit(1); }
  console.log('\n  PASS — one PO engine; server-issued identity; drafts cannot self-promote.\n');
})().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });
