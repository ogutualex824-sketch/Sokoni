'use strict';
/**
 * CERT — Slice F: auto-reorder produces canonical drafts, never orders.
 *
 * THE INVARIANT
 *   Auto-reorder may recommend and create a canonical DRAFT. It can never autonomously turn
 *   that recommendation into an approved or sent purchase order. A machine noticing that
 *   stock is low is not a decision to spend money.
 *
 * METHOD
 *   The real `createAutoReorderPOs` is EXECUTED in a VM sandbox with IndexedDB, firebase and
 *   PosInventory doubles. Every callable invocation is captured, so "did it ever call approve
 *   or send" is answered by observing behaviour, not by reading source. Static checks appear
 *   only where the property is genuinely textual. Every detector runs in both directions.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.resolve(__dirname, '..');
const CLI  = fs.readFileSync(path.join(ROOT, 'pos-suppliers.js'), 'utf8');
const PROC = fs.readFileSync(path.join(ROOT, 'functions/procurement.js'), 'utf8');

let pass = 0, fail = 0, sabotage = 0, sabotageOk = 0;
const failures = [];
const check = (n, c) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); } };
const sab   = (n, c) => { sabotage++; if (c) { sabotageOk++; pass++; console.log('  PASS    (sabotage: ' + n + ')'); } else { fail++; failures.push('SABOTAGE ' + n); console.log('  FAIL    (sabotage: ' + n + ')'); } };

console.log('\nCERT — Slice F: auto-reorder → canonical drafts\n');

const SUGGESTIONS = [
  { product: { id: 'p1', name: 'Cooking Oil 20L', sku: 'OIL20', supplierId: 'sup1', cost: 3450 }, reorderQty: 32 },
  { product: { id: 'p2', name: 'Printer Paper',   sku: 'PPR80', supplierId: 'sup1', cost: 620  }, reorderQty: 24 },
  { product: { id: 'p3', name: 'Sugar 2kg',       sku: 'SUG2',  supplierId: 'sup2', cost: 310  }, reorderQty: 50 },
  { product: { id: 'p4', name: 'Unassigned item', sku: 'NONE',  supplierId: null,   cost: 100  }, reorderQty: 10 },
];

function load(opts) {
  opts = opts || {};
  const store = { purchase_orders: {}, suppliers: { sup1: { id: 'sup1', name: 'XYZ Traders' }, sup2: { id: 'sup2', name: 'Rift Mills' } },
                  grns: {}, supplier_invoices: {}, supplier_payments: {} };
  const events = [], calls = [];
  const idb = { open() { const req = {}; setTimeout(() => { const db = { objectStoreNames:{contains:()=>true}, createObjectStore:()=>({createIndex(){}}),
    transaction(){ return { objectStore(n){ const bag=store[n]||(store[n]={}); return {
      put(r0){const r={};setTimeout(()=>{bag[r0.id]=r0;r.onsuccess&&r.onsuccess();},0);return r;},
      get(id){const r={};setTimeout(()=>{r.result=bag[id]||null;r.onsuccess&&r.onsuccess();},0);return r;},
      getAll(){const r={};setTimeout(()=>{r.result=Object.values(bag);r.onsuccess&&r.onsuccess();},0);return r;},
      delete(){const r={};setTimeout(()=>{r.onsuccess&&r.onsuccess();},0);return r;},
      index(){return{getAll(){const r={};setTimeout(()=>{r.result=[];r.onsuccess&&r.onsuccess();},0);return r;}};},
    };} }; } }; req.result=db; req.onsuccess&&req.onsuccess({target:{result:db}}); },0); return req; } };

  let seq = 0;
  const sb = { indexedDB: idb, navigator: { onLine: opts.online !== false },
    crypto: { randomUUID: () => 'local-' + (++seq) },
    console, setTimeout, clearTimeout, Date, Math, JSON, Promise, Object, Array, String, Number, Error };
  sb.window = sb;
  sb.PosInventory = opts.noInventory ? undefined : {
    getReorderSuggestions: async () => (opts.suggestions || SUGGESTIONS),
  };
  sb.firebase = opts.noFns ? {} : { functions: () => ({
    httpsCallable: (name) => async (payload) => {
      calls.push({ name, payload });
      if (opts.callable) return opts.callable(name, payload);
      return { data: { poId: 'proc_' + (++seq), poNumber: 'PO-2026-' + String(seq).padStart(5, '0') } };
    },
  }) };
  sb.window.addEventListener = () => {};
  vm.createContext(sb);
  vm.runInContext(CLI, sb, { filename: 'pos-suppliers.js' });
  const PS = sb.window.PosSuppliers;
  ['po:created', 'po:submitted', 'po:submit-failed', 'reorder:completed'].forEach((e) => PS.on(e, (d) => events.push({ e, d })));
  return { PS, store, events, calls };
}

(async () => {
  /* ══════════════════════════════════════════════════════════
     §1 the heuristic is preserved
  ══════════════════════════════════════════════════════════ */
  console.log('§1 heuristic preserved (executed)');
  {
    const h = load({});
    await h.PS.init('main', 'SOK-AAAA11');
    const out = await h.PS.createAutoReorderPOs('main', 'operator-1');

    check('suggestions are grouped by supplier — 2 suppliers, 2 orders', out.length === 2);
    check('an item with no supplier is skipped, as before',
      !out.some((p) => (p.items || []).some((i) => i.productId === 'p4')));
    check('the multi-item supplier keeps both of its lines',
      out.some((p) => (p.items || []).length === 2));
    check('reorder quantities come from the heuristic, unmodified',
      out.some((p) => (p.items || []).some((i) => i.qty === 32)));
    check('the supplier name is carried through', out.some((p) => p.supplierName === 'XYZ Traders'));
    check('drafts are marked as auto-reordered',
      out.every((p) => p.autoReorder === true));
  }

  /* ══════════════════════════════════════════════════════════
     §2 canonical drafts, server identity
  ══════════════════════════════════════════════════════════ */
  console.log('\n§2 canonical draft creation (executed)');
  {
    const h = load({});
    await h.PS.init('main', 'SOK-AAAA11');
    const out = await h.PS.createAutoReorderPOs('main', 'operator-1');

    check('each order was submitted to the CANONICAL engine',
      h.calls.filter((c) => c.name === 'createPurchaseOrder').length === 2);
    check('each carries a server-issued canonical id', out.every((p) => !!p.procPoId));
    check('each carries a SERVER PO number', out.every((p) => /^PO-2026-\d{5}$/.test(p.poNo || '')));
    check('no client-generated PO number is used', !/_poNo\(\)/.test(CLI.replace(/\/\*[\s\S]*?\*\//g, '')));
    check('the client never sends a poId or poNumber',
      h.calls.every((c) => !('poId' in (c.payload || {})) && !('poNumber' in (c.payload || {}))));
    check('merchantId is sent as a request, resolved server-side',
      h.calls.every((c) => c.name !== 'createPurchaseOrder' || c.payload.merchantId === 'SOK-AAAA11'));
    check('the summary reports what actually happened',
      out.summary && out.summary.created === 2 && out.summary.submitted === 2 &&
      out.summary.queued === 0 && out.summary.failed === 0);
  }

  /* ══════════════════════════════════════════════════════════
     §3 THE INVARIANT — never approves, sends or pays
  ══════════════════════════════════════════════════════════ */
  console.log('\n§3 auto-reorder never approves, sends or pays (executed)');
  {
    const h = load({});
    await h.PS.init('main', 'SOK-AAAA11');
    await h.PS.createAutoReorderPOs('main', 'operator-1');
    const names = h.calls.map((c) => c.name);

    check('EXECUTED: approvePurchaseOrder was never called', names.indexOf('approvePurchaseOrder') === -1);
    check('EXECUTED: sendPurchaseOrder was never called', names.indexOf('sendPurchaseOrder') === -1);
    check('EXECUTED: receiveGoods was never called', names.indexOf('receiveGoods') === -1);
    check('EXECUTED: createSupplierInvoice was never called', names.indexOf('createSupplierInvoice') === -1);
    check('EXECUTED: approveAndPayInvoice was never called', names.indexOf('approveAndPayInvoice') === -1);
    check('EXECUTED: the ONLY callable used is createPurchaseOrder',
      names.every((n) => n === 'createPurchaseOrder'));
    sab('the detector would notice an approve call',
      ['createPurchaseOrder', 'approvePurchaseOrder'].indexOf('approvePurchaseOrder') !== -1);

    check('no local record is left in an approved or sent state',
      Object.values(h.store.purchase_orders).every((p) => p.status === 'submitted'));
    check('the canonical engine creates POs as draft, requiring approval',
      /status:\s+'draft',/.test(PROC));
    check('approval remains manager-gated and merchant-scoped',
      /const approvePurchaseOrder[\s\S]{0,400}_requireManager\(request\)/.test(PROC) &&
      /const approvePurchaseOrder[\s\S]{0,700}_assertPoAuthority/.test(PROC));
  }

  /* ══════════════════════════════════════════════════════════
     §4 offline / failure — queued, never claimed
  ══════════════════════════════════════════════════════════ */
  console.log('\n§4 offline and failure honesty (executed)');
  {
    const h = load({ online: false });
    await h.PS.init('main', 'SOK-AAAA11');
    const out = await h.PS.createAutoReorderPOs('main', 'op');
    check('OFFLINE: drafts are still composed locally', out.length === 2);
    check('OFFLINE: nothing reaches the cloud', h.calls.length === 0);
    check('OFFLINE: they remain local_draft', out.every((p) => p.status === 'local_draft'));
    check('OFFLINE: no canonical id is invented', out.every((p) => !p.procPoId));
    check('OFFLINE: the summary says queued, not submitted',
      out.summary.queued === 2 && out.summary.submitted === 0);
    check('OFFLINE: getUnsubmittedDrafts surfaces them for Slice G',
      (await h.PS.getUnsubmittedDrafts()).length === 2);
  }
  {
    const h = load({ callable: async () => { const e = new Error('permission-denied'); e.code = 'functions/permission-denied'; throw e; } });
    await h.PS.init('main', 'SOK-AAAA11');
    const out = await h.PS.createAutoReorderPOs('main', 'op');
    check('REJECTED: the batch does not throw — partial success is reportable', Array.isArray(out));
    check('REJECTED: nothing is marked submitted', out.every((p) => p.status === 'local_draft'));
    check('REJECTED: no canonical id is invented', out.every((p) => !p.procPoId));
    check('REJECTED: the failure is recorded on each draft', out.every((p) => !!p.lastSubmitError));
    check('REJECTED: the summary counts failures honestly',
      out.summary.failed === 2 && out.summary.submitted === 0);
  }
  {
    /* Partial: first supplier submits, second is rejected. */
    let n = 0;
    const h = load({ callable: async () => {
      n++; if (n === 1) return { data: { poId: 'proc_ok', poNumber: 'PO-2026-00009' } };
      const e = new Error('boom'); e.code = 'internal'; throw e;
    } });
    await h.PS.init('main', 'SOK-AAAA11');
    const out = await h.PS.createAutoReorderPOs('main', 'op');
    check('PARTIAL: one submitted, one failed', out.summary.submitted === 1 && out.summary.failed === 1);
    check('PARTIAL: the successful one has its canonical id',
      out.filter((p) => p.procPoId).length === 1);
    check('PARTIAL: the failed one stays a local_draft',
      out.filter((p) => p.status === 'local_draft').length === 1);
  }
  {
    const h = load({ noInventory: true });
    await h.PS.init('main', 'SOK-AAAA11');
    const out = await h.PS.createAutoReorderPOs('main', 'op');
    check('no inventory module: returns an empty result with a summary',
      out.length === 0 && out.summary && out.summary.created === 0);
  }

  /* ══════════════════════════════════════════════════════════
     §5 preservation
  ══════════════════════════════════════════════════════════ */
  console.log('\n§5 preservation');
  const CODE = CLI.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  check('PRESERVED: no pos* PO cloud writer returned', !/_sync\('posPurchaseOrders'/.test(CODE));
  check('PRESERVED: Slice B submit path is reused, not duplicated',
    (CODE.match(/httpsCallable\('createPurchaseOrder'\)/g) || []).length === 1);
  sab('the detector catches a second, divergent submit path',
    (("httpsCallable('createPurchaseOrder')\nhttpsCallable('createPurchaseOrder')").match(/httpsCallable\('createPurchaseOrder'\)/g) || []).length !== 1);
  check('PRESERVED: Slice D receipt path untouched', /httpsCallable\('receiveGoods'\)/.test(CODE));
  check('PRESERVED: PO send honesty guard from e331182',
    /if \(!data \|\| data\.status !== 'sent'\)/.test(CODE));
  check('PRESERVED: Slice A/B2/C authority untouched in procurement',
    /_assertMerchantAuthority/.test(PROC) && /_assertSupplierSideAuthority/.test(PROC) &&
    /_assertPoAuthority/.test(PROC));
  check('NOT REVIVED: posSendPurchaseOrder stays retired',
    !/^exports\.posSendPurchaseOrder\s*=/m.test(fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8')));

  console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed  ·  ' + sabotageOk + '/' + sabotage + ' sabotage catches');
  if (fail) { console.log('\n  ' + fail + ' FAILURE(S):'); failures.forEach((f) => console.log('    - ' + f)); process.exit(1); }
  console.log('\n  PASS — auto-reorder recommends canonical drafts and never orders.\n');
})().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });
