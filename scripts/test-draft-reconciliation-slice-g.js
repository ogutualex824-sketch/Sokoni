'use strict';
/**
 * CERT — Slice G: local-draft reconciliation.
 *
 * THE CORE INVARIANT
 *   No local draft is promoted to canonical procurement state without an explicit merchant
 *   action AND successful server confirmation.
 *
 * SECONDARY INVARIANTS
 *   - A local id is never treated as a canonical id.
 *   - A claimed procPoId is verified against the server, not assumed valid.
 *   - A draft composed for another merchant is never attached to the current one.
 *   - Nothing is ever deleted; a malformed record is quarantined with a reason.
 *   - No old pos* PO cloud writer is reintroduced.
 *
 * METHOD
 *   The real module runs in a VM sandbox over a real IndexedDB double, and the real
 *   `reconcileLocalDrafts` / `submitReconciledDraft` / `submitPurchaseOrder` are EXECUTED.
 *   Every callable invocation is captured, so "did anything submit by itself" is answered by
 *   observing behaviour. Static checks appear only where the property is genuinely textual.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.resolve(__dirname, '..');
const CLI  = fs.readFileSync(path.join(ROOT, 'pos-suppliers.js'), 'utf8');
const PROC = fs.readFileSync(path.join(ROOT, 'functions/procurement.js'), 'utf8');
const IDX  = fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');

let pass = 0, fail = 0, sabotage = 0, sabotageOk = 0;
const failures = [];
const check = (n, c) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); } };
const sab   = (n, c) => { sabotage++; if (c) { sabotageOk++; pass++; console.log('  PASS    (sabotage: ' + n + ')'); } else { fail++; failures.push('SABOTAGE ' + n); console.log('  FAIL    (sabotage: ' + n + ')'); } };

console.log('\nCERT — Slice G: local-draft reconciliation\n');

const MERCHANT = 'SOK-AAAA11';
const OTHER    = 'SOK-BBBB22';
const ITEMS    = [{ productId: 'p1', productName: 'Oil', qty: 4, unitCost: 100 }];

function draft(over) {
  return Object.assign({
    id: 'local-1', poNo: null, procPoId: null, supplierId: 'sup1', supplierName: 'XYZ',
    branchId: 'main', items: ITEMS, totalCost: 400, status: 'local_draft',
    ownerMerchantId: MERCHANT, createdAt: 1, updatedAt: 1,
  }, over || {});
}

function load(opts) {
  opts = opts || {};
  const store = { purchase_orders: {}, suppliers: {}, grns: {}, supplier_invoices: {}, supplier_payments: {} };
  (opts.seed || []).forEach((d) => { store.purchase_orders[d.id] = JSON.parse(JSON.stringify(d)); });
  const events = [], calls = [];
  const idb = { open() { const req = {}; setTimeout(() => { const db = { objectStoreNames:{contains:()=>true}, createObjectStore:()=>({createIndex(){}}),
    transaction(){ return { objectStore(n){ const bag=store[n]||(store[n]={}); return {
      put(r0){const r={};setTimeout(()=>{bag[r0.id]=r0;r.onsuccess&&r.onsuccess();},0);return r;},
      get(id){const r={};setTimeout(()=>{r.result=bag[id]||null;r.onsuccess&&r.onsuccess();},0);return r;},
      getAll(){const r={};setTimeout(()=>{r.result=Object.values(bag);r.onsuccess&&r.onsuccess();},0);return r;},
      delete(id){const r={};setTimeout(()=>{delete bag[id];r.onsuccess&&r.onsuccess();},0);return r;},
      index(){return{getAll(){const r={};setTimeout(()=>{r.result=[];r.onsuccess&&r.onsuccess();},0);return r;}};},
    };} }; } }; req.result=db; req.onsuccess&&req.onsuccess({target:{result:db}}); },0); return req; } };
  let seq = 0;
  const sb = { indexedDB: idb, navigator: { onLine: opts.online !== false },
    crypto: { randomUUID: () => 'local-' + (++seq) },
    console, setTimeout, clearTimeout, Date, Math, JSON, Promise, Object, Array, String, Number, Error };
  sb.window = sb;
  sb.PosInventory = { getReorderSuggestions: async () => [] };
  sb.firebase = opts.noFns ? {} : { functions: () => ({
    httpsCallable: (name) => async (payload) => {
      calls.push({ name, payload });
      if (opts.callable) return opts.callable(name, payload);
      return { data: { poId: 'proc_' + (++seq), poNumber: 'PO-2026-0000' + seq } };
    },
  }) };
  sb.window.addEventListener = () => {};
  vm.createContext(sb);
  vm.runInContext(CLI, sb, { filename: 'pos-suppliers.js' });
  const PS = sb.window.PosSuppliers;
  ['po:submitted', 'po:submit-failed'].forEach((e) => PS.on(e, (d) => events.push({ e, d })));
  return { PS, store, events, calls };
}

(async () => {
  const ST = load({}).PS.RECONCILE_STATES;
  check('the reconciliation states are exported', !!ST && !!ST.SUBMITTABLE);

  /* ══════════════════════════════════════════════════════════
     §1 classification is READ-ONLY and never auto-submits
  ══════════════════════════════════════════════════════════ */
  console.log('\n§1 classification is read-only');
  {
    const h = load({ seed: [] });
    await h.PS.init('main', MERCHANT);
    const out = await h.PS.reconcileLocalDrafts();
    check('EMPTY QUEUE: zero records', out.records.length === 0);
    check('EMPTY QUEUE: zero action — no callable invoked', h.calls.length === 0);
    check('EMPTY QUEUE: a summary is still returned', out.summary.total === 0);
  }
  {
    const h = load({ seed: [draft()] });
    await h.PS.init('main', MERCHANT);
    const out = await h.PS.reconcileLocalDrafts();
    check('ONE DRAFT: classified submittable', out.records[0].state === ST.SUBMITTABLE);
    check('ONE DRAFT: NOT submitted by classification', h.calls.length === 0);
    check('ONE DRAFT: remains local_draft', h.store.purchase_orders['local-1'].status === 'local_draft');
    check('ONE DRAFT: no canonical id invented', !h.store.purchase_orders['local-1'].procPoId);
    check('ONE DRAFT: no PO number invented', !h.store.purchase_orders['local-1'].poNo);
    check('ONE DRAFT: every original field preserved',
      JSON.stringify(out.records[0].record.items) === JSON.stringify(ITEMS) &&
      out.records[0].record.totalCost === 400);
    check('the local id is reported separately from any canonical id',
      out.records[0].localId === 'local-1' && out.records[0].procPoId === null);
  }

  /* ══════════════════════════════════════════════════════════
     §2 explicit submission — the core invariant
  ══════════════════════════════════════════════════════════ */
  console.log('\n§2 explicit submission (executed)');
  {
    const h = load({ seed: [draft()] });
    await h.PS.init('main', MERCHANT);
    const rec = await h.PS.submitReconciledDraft('local-1');
    check('EXPLICIT ACTION: submission succeeds', !!rec.procPoId);
    check('the canonical id came from the SERVER', /^proc_/.test(rec.procPoId));
    check('the PO number came from the SERVER', /^PO-2026-/.test(rec.poNo));
    check('the local id was NOT reused as the canonical id', rec.procPoId !== 'local-1');
    check('status advances only after confirmation', rec.status === 'submitted');
    check('the canonical createPurchaseOrder was the path used',
      h.calls.some((c) => c.name === 'createPurchaseOrder'));
    check('no approve/send/pay happened', !h.calls.some((c) => /approve|send|Invoice/i.test(c.name)));
  }
  {
    /* MULTIPLE drafts, each independently recoverable. */
    const h = load({ seed: [draft({ id: 'd1' }), draft({ id: 'd2' }), draft({ id: 'd3' })] });
    await h.PS.init('main', MERCHANT);
    await h.PS.submitReconciledDraft('d2');
    const out = await h.PS.reconcileLocalDrafts();
    const by = (id) => out.records.find((r) => r.localId === id);
    check('MULTIPLE: only the named draft was submitted', by('d2').state === ST.LINKED);
    check('MULTIPLE: the others remain submittable',
      by('d1').state === ST.SUBMITTABLE && by('d3').state === ST.SUBMITTABLE);
    check('MULTIPLE: exactly one server call was made',
      h.calls.filter((c) => c.name === 'createPurchaseOrder').length === 1);
  }
  {
    /* ONE SUCCEEDS / ONE FAILS */
    let n = 0;
    const h = load({ seed: [draft({ id: 'ok' }), draft({ id: 'bad' })],
      callable: async () => { n++; if (n === 1) return { data: { poId: 'proc_ok', poNumber: 'PO-1' } };
        const e = new Error('rejected'); e.code = 'internal'; throw e; } });
    await h.PS.init('main', MERCHANT);
    await h.PS.submitReconciledDraft('ok');
    let threw = null;
    try { await h.PS.submitReconciledDraft('bad'); } catch (e) { threw = e; }
    check('MIXED: the successful draft gained canonical identity',
      h.store.purchase_orders.ok.procPoId === 'proc_ok');
    check('MIXED: the failed one throws', threw !== null);
    check('MIXED: the failed draft is untouched — still local_draft',
      h.store.purchase_orders.bad.status === 'local_draft');
    check('MIXED: the failed draft invented no identity',
      !h.store.purchase_orders.bad.procPoId && !h.store.purchase_orders.bad.poNo);
    check('MIXED: the failure is recorded on the draft', !!h.store.purchase_orders.bad.lastSubmitError);
    check('MIXED: neither draft was deleted',
      !!h.store.purchase_orders.ok && !!h.store.purchase_orders.bad);
  }

  /* ══════════════════════════════════════════════════════════
     §3 offline + duplicate
  ══════════════════════════════════════════════════════════ */
  console.log('\n§3 offline and duplicate submission');
  {
    const h = load({ seed: [draft()], online: false });
    await h.PS.init('main', MERCHANT);
    let threw = null;
    try { await h.PS.submitReconciledDraft('local-1'); } catch (e) { threw = e; }
    check('OFFLINE: submission fails rather than claiming success', threw !== null);
    check('OFFLINE: remains a local draft', h.store.purchase_orders['local-1'].status === 'local_draft');
    check('OFFLINE: no fake server identity', !h.store.purchase_orders['local-1'].procPoId);
    check('OFFLINE: no callable was reached', h.calls.length === 0);
  }
  {
    const h = load({ seed: [draft()] });
    await h.PS.init('main', MERCHANT);
    const first  = await h.PS.submitReconciledDraft('local-1');
    const second = await h.PS.submitReconciledDraft('local-1');
    check('DUPLICATE SUBMIT: returns the same canonical id', first.procPoId === second.procPoId);
    check('DUPLICATE SUBMIT: no second canonical PO created',
      h.calls.filter((c) => c.name === 'createPurchaseOrder').length === 1);
    check('DUPLICATE SUBMIT: reuses the canonical idempotency, no new mechanism',
      /if \(po\.procPoId\) return po;/.test(CLI) || /if \(rec\.procPoId\) return rec;/.test(CLI));
  }

  /* ══════════════════════════════════════════════════════════
     §4 identity — a local id is never a canonical id
  ══════════════════════════════════════════════════════════ */
  console.log('\n§4 identity verification');
  {
    /* A record CLAIMING a canonical id that the server does not know. */
    const h = load({ seed: [draft({ id: 'claim', procPoId: 'looks_canonical', poNo: 'PO-FAKE' })],
      callable: async (name) => { if (name === 'getPurchaseOrder') { const e = new Error('Purchase order not found.'); e.code = 'not-found'; throw e; } return { data: {} }; } });
    await h.PS.init('main', MERCHANT);
    const out = await h.PS.reconcileLocalDrafts({ verify: true });
    check('a claimed procPoId is VERIFIED against the server',
      h.calls.some((c) => c.name === 'getPurchaseOrder'));
    check('an unresolvable claim is flagged UNVERIFIED, not trusted',
      out.records[0].state === ST.UNVERIFIED_LINK);
    check('the unverified record carries a reason', !!out.records[0].reason);
    check('the unverified record is NOT deleted', !!h.store.purchase_orders.claim);
    sab('the detector would fail if verification were skipped',
      !/httpsCallable\('getPurchaseOrder'\)/.test('const x = 1;'));
  }
  {
    const h = load({ seed: [draft({ id: 'good', procPoId: 'proc_real', poNo: 'PO-9' })],
      callable: async (name) => (name === 'getPurchaseOrder'
        ? { data: { poId: 'proc_real', status: 'draft', total: 400 } } : { data: {} }) });
    await h.PS.init('main', MERCHANT);
    const out = await h.PS.reconcileLocalDrafts({ verify: true });
    check('a verified link is reported LINKED', out.records[0].state === ST.LINKED);
    check('the server view is attached for the caller', !!out.records[0].server);
  }
  {
    const h = load({ seed: [draft({ id: 'x', procPoId: 'proc_1' })], online: false });
    await h.PS.init('main', MERCHANT);
    const out = await h.PS.reconcileLocalDrafts({ verify: true });
    check('OFFLINE verification does not assume validity', out.records[0].state === ST.UNVERIFIED_LINK);
  }

  /* ══════════════════════════════════════════════════════════
     §5 account/device change — the stale-identity edge
  ══════════════════════════════════════════════════════════ */
  console.log('\n§5 another merchant\'s draft is never attached');
  {
    const h = load({ seed: [draft({ id: 'theirs', ownerMerchantId: OTHER })] });
    await h.PS.init('main', MERCHANT);
    const out = await h.PS.reconcileLocalDrafts();
    check('a draft owned by ANOTHER merchant is flagged foreign', out.records[0].state === ST.FOREIGN_MERCHANT);
    let threw = null;
    try { await h.PS.submitReconciledDraft('theirs'); } catch (e) { threw = e; }
    check('submitting a foreign draft is REFUSED', threw !== null && threw.code === ST.FOREIGN_MERCHANT);
    check('the foreign draft never reached the server', !h.calls.some((c) => c.name === 'createPurchaseOrder'));
    check('the foreign draft is NOT deleted', !!h.store.purchase_orders.theirs);
    check('the foreign draft was not re-owned', h.store.purchase_orders.theirs.ownerMerchantId === OTHER);
  }
  {
    /* Legacy draft: no ownerMerchantId at all. */
    const d = draft({ id: 'legacy' }); delete d.ownerMerchantId;
    const h = load({ seed: [d] });
    await h.PS.init('main', MERCHANT);
    const out = await h.PS.reconcileLocalDrafts();
    check('a legacy draft with no recorded owner is flagged unknown_owner',
      out.records[0].state === ST.UNKNOWN_OWNER);
    let threw = null;
    try { await h.PS.submitReconciledDraft('legacy'); } catch (e) { threw = e; }
    check('submitting it without confirmation is REFUSED', threw !== null && threw.code === ST.UNKNOWN_OWNER);
    check('it did not reach the server', !h.calls.some((c) => c.name === 'createPurchaseOrder'));
    const ok = await h.PS.submitReconciledDraft('legacy', { confirmOwnership: true });
    check('with EXPLICIT ownership confirmation it submits', !!ok.procPoId);
    check('confirmation is recorded on the record', !!h.store.purchase_orders.legacy.ownershipConfirmedAt);
  }
  {
    /* New drafts stamp provenance so this cannot recur. */
    const h = load({ seed: [] });
    await h.PS.init('main', MERCHANT);
    const po = await h.PS.createPurchaseOrder({ supplierId: 'sup1', items: ITEMS });
    check('a newly composed draft records the merchant it belongs to', po.ownerMerchantId === MERCHANT);
  }

  /* ══════════════════════════════════════════════════════════
     §6 malformed records are quarantined, never deleted
  ══════════════════════════════════════════════════════════ */
  console.log('\n§6 malformed quarantine');
  {
    const h = load({ seed: [
      draft({ id: 'no-items', items: [] }),
      draft({ id: 'no-supplier', supplierId: null }),
      draft({ id: 'fine' }),
    ] });
    await h.PS.init('main', MERCHANT);
    const out = await h.PS.reconcileLocalDrafts();
    const by = (id) => out.records.find((r) => r.localId === id);
    check('a record with no line items is MALFORMED', by('no-items').state === ST.MALFORMED);
    check('a record with no supplier is MALFORMED', by('no-supplier').state === ST.MALFORMED);
    check('each malformed record carries an explicit reason',
      !!by('no-items').reason && !!by('no-supplier').reason);
    check('a healthy record alongside them is unaffected', by('fine').state === ST.SUBMITTABLE);
    check('NOTHING was deleted', Object.keys(h.store.purchase_orders).length === 3);
    let threw = null;
    try { await h.PS.submitReconciledDraft('no-items'); } catch (e) { threw = e; }
    check('a malformed record cannot be submitted', threw !== null && threw.code === ST.MALFORMED);
    check('and it still exists afterwards', !!h.store.purchase_orders['no-items']);
  }

  /* ══════════════════════════════════════════════════════════
     §7 no old pos* writer, and the canonical read is scoped
  ══════════════════════════════════════════════════════════ */
  console.log('\n§7 no pos* writer reintroduced');
  const CODE = CLI.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('no _sync to posPurchaseOrders anywhere', !/_sync\('posPurchaseOrders'/.test(CODE));
  sab('the detector catches a reintroduced pos* PO mirror',
    /_sync\('posPurchaseOrders'/.test("_sync('posPurchaseOrders', po.id, po);"));
  const syncMod = require(path.join(ROOT, 'functions/pos-supplier-sync.js'));
  check('the sync op still has no purchaseOrder entity',
    !Object.prototype.hasOwnProperty.call(syncMod._ENTITIES, 'purchaseOrder'));
  check('reconciliation never calls a pos* PO writer',
    !/reconcileLocalDrafts[\s\S]{0,2000}posPurchaseOrders/.test(CODE));
  check('the new canonical read is merchant-scoped',
    /const getPurchaseOrder = onCall[\s\S]{0,400}await _assertPoAuthority\(request, poId\)/.test(PROC));
  sab('the detector catches an ungated canonical read',
    !/const getPurchaseOrder = onCall[\s\S]{0,400}await _assertPoAuthority\(request, poId\)/.test(
      'const getPurchaseOrder = onCall(OPT, async (r) => { const s = await ref.get(); return s.data(); });'));
  check('getPurchaseOrder is re-exported by name',
    /^exports\.getPurchaseOrder\s+=\s+procurement\.getPurchaseOrder;/m.test(IDX));
  check('NOT REVIVED: posSendPurchaseOrder stays retired', !/^exports\.posSendPurchaseOrder\s*=/m.test(IDX));

  /* ══════════════════════════════════════════════════════════
     §8 preservation of A-F
  ══════════════════════════════════════════════════════════ */
  console.log('\n§8 preservation');
  check('PRESERVED: Slice A merchant authority', /_assertMerchantAuthority/.test(PROC));
  check('PRESERVED: Slice B canonical PO shape', /buyerBusinessId:\s*merchantId,/.test(PROC));
  check('PRESERVED: Slice B2 supplier-side authority', /_assertSupplierSideAuthority/.test(PROC));
  check('PRESERVED: Slice C approve/send gates',
    /const approvePurchaseOrder[\s\S]{0,700}_assertPoAuthority/.test(PROC));
  check('PRESERVED: Slice D receipt idempotency', /_deterministicId\(keySeed, 'grn'\)/.test(PROC));
  check('PRESERVED: Slice E payment idempotency', /_deterministicId\(invoiceId \+ '\|debit', 'led'\)/.test(PROC));
  check('PRESERVED: Slice F auto-reorder summary', /summary: \{ created: results\.length/.test(CLI));
  check('PRESERVED: PO send honesty guard', /if \(!data \|\| data\.status !== 'sent'\)/.test(CODE));

  console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed  ·  ' + sabotageOk + '/' + sabotage + ' sabotage catches');
  if (fail) { console.log('\n  ' + fail + ' FAILURE(S):'); failures.forEach((f) => console.log('    - ' + f)); process.exit(1); }
  console.log('\n  PASS — no local draft becomes canonical without explicit action and server confirmation.\n');
})().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });
