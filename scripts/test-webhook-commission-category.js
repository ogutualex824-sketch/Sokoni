#!/usr/bin/env node
'use strict';
/* Commission category from SERVER records only (owner rule; 2f lead confirmed 2026-10-03).
   LAYER A: the resolver (functions/shared/commission-category-source.js) on an in-memory store — always runs.
   LAYER B: the REAL webhookIntasend handler (scripts/lib/p0-webhook-harness.js) — the client's meta.category is ignored, the
            ledger carries the product's category, an unresolvable category HOLDS the seller credit. Below the harness's
            memory floor the B rows are UNPROVEN (never pass). */
const path = require('path'), Module = require('module');
const NM = process.env.SOKONI_NODE_MODULES || 'C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/node_modules';
process.env.NODE_PATH = NM; Module._initPaths();
const WH = path.resolve(path.join(__dirname, '..'), 'functions');
let pass = 0, fail = 0, unproven = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id.padEnd(5) + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 220) + ']')); ok ? pass++ : fail++; };
const unp = (id, m, why) => { console.log('  UNPROVEN ' + id.padEnd(5) + ' ' + m + '   [' + why + ']'); unproven++; };

const CC = require(path.join(WH, 'shared', 'commission-category-source.js'));
const mem = (docs) => ({ collection: (c) => ({ doc: (id) => ({ get: async () => ({ exists: (c + '/' + id) in docs, data: () => docs[c + '/' + id] }) }) }) });
const PI = (o) => Object.assign({ purpose: 'product_order', metadata: { items: [{ productId: 'p1' }] } }, o || {});

(async () => {
  console.log('\nLAYER A — resolver');
  let r = await CC.resolveCommissionCategory(mem({ 'paymentIntents/I1': PI(), 'products/p1': { category: 'Electronics' } }), { intentRef: 'I1' });
  ck('A-1', r.ok && r.category === 'electronics' && r.source === 'products', 'a product order is priced under its PRODUCT\'s category', r);
  r = await CC.resolveCommissionCategory(mem({ 'paymentIntents/I1': PI({ metadata: { items: [{ productId: 'p1' }, { productId: 'p2' }] } }), 'products/p1': { category: 'electronics' }, 'products/p2': { category: 'jobs' } }), { intentRef: 'I1' });
  ck('A-2', !r.ok && r.reason === 'mixed_categories', 'mixed categories in one order → unresolved (never pick one)', r);
  r = await CC.resolveCommissionCategory(mem({ 'paymentIntents/I1': PI(), 'products/p1': { name: 'x' } }), { intentRef: 'I1' });
  ck('A-3', !r.ok && r.reason === 'product_category_missing', 'a product with no category → unresolved (no default)', r);
  r = await CC.resolveCommissionCategory(mem({}), { intentRef: 'I1' });
  ck('A-4', !r.ok && r.reason === 'no_intent', 'no server intent → unresolved (the client label is never consulted)', r);
  r = await CC.resolveCommissionCategory(mem({ 'paymentIntents/I1': { purpose: 'marketing_plan', metadata: { category: 'marketing' } } }), { intentRef: 'I1' });
  ck('A-5', r.ok && r.category === 'marketing' && r.source === 'intent_metadata', 'a non-product purpose uses the category its SERVER pricer stamped', r);
  r = await CC.resolveCommissionCategory(mem({ 'paymentIntents/I1': { purpose: 'other', metadata: {} } }), { intentRef: 'I1' });
  ck('A-6', !r.ok && r.reason === 'category_unresolved', 'nothing server-side to price by → unresolved', r);
  r = await CC.resolveCommissionCategory(mem({}), { intentRef: '../x' });
  ck('A-7', !r.ok, 'a path-like intent ref is refused', r);

  console.log('\nLAYER B — the real webhookIntasend handler');
  let H = null, herr = null;
  try { H = require('./lib/p0-webhook-harness.js')(WH, NM); } catch (e) { herr = e && e.message; }
  if (!H || !H.ready) {
    ['B-1', 'B-2', 'B-3'].forEach((id) => unp(id, 'handler row', 'harness: ' + String(herr || (H && H.error) || 'not ready').slice(0, 120)));
  } else {
    const cb = (ref) => ({ challenge: H.CHALLENGE, invoice_id: 'INV-' + ref, api_ref: ref, state: 'COMPLETE', currency: 'KES', value: 10000, net_amount: 9998.2, charges: 1.8, provider: 'M-PESA' });
    const confirm = (ref) => H.setStatus({ results: [{ invoice_id: 'INV-' + ref, api_ref: ref, state: 'COMPLETE', value: 10000, currency: 'KES' }] });
    const seed = (ref, productCat, clientCat) => {
      H.DOCS.set('products/pc-' + ref, Object.assign({ name: 'TV', price: 10000, stock: 5, sellerUid: 'S1', status: 'active' }, productCat ? { category: productCat } : {}));
      H.DOCS.set('payments/' + ref, { ref, amount: 10000, currency: 'KES', status: 'PENDING', uid: 'buyerA', intentRef: ref,
        meta: { category: clientCat, orderId: ref, sellerUid: 'S1', items: [{ productId: 'pc-' + ref, qty: 1, sellerUid: 'S1' }] } });
      H.DOCS.set('paymentIntents/' + ref, { purpose: 'product_order', uid: 'buyerA', ownerUid: 'buyerA', amountCents: 1000000, currency: 'KES', status: 'created',
        resourceId: ref, metadata: { orderId: ref, sellerUid: 'S1', items: [{ productId: 'pc-' + ref, qty: 1, unitPrice: 10000, sellerUid: 'S1' }] } });
      H.DOCS.set('orders/' + ref, { uid: 'buyerA', buyerUid: 'buyerA', status: 'pending_payment', total: 10000, currency: 'KES', items: [{ productId: 'pc-' + ref, qty: 1 }] });
      confirm(ref);
    };
    seed('CAT1', 'electronics', 'jobs'); let r1 = await H.invoke(cb('CAT1'));
    const L1 = H.get('commissionLedger', 'CAT1') || {};
    ck('B-1', !r1.threw && L1.category === 'electronics' && L1.category !== 'jobs', "THE LEAD: the client says 'jobs' (0%) — the ledger prices the PRODUCT's category", { L1, threw: r1.threw });
    seed('CAT2', null, 'jobs'); const r2 = await H.invoke(cb('CAT2'));
    const p2 = H.get('payments', 'CAT2') || {}, q2 = H.get('commissionReviewQueue', 'commission_hold_CAT2');
    const credited2 = [...H.DOCS.keys()].some((k) => /^walletTransactions\/S1_CAT2|^sellerPayments\/.*CAT2/.test(k));
    ck('B-2', !r2.threw && p2.walletCreditSkipped === 'commission_unresolved' && !!q2 && q2.clientCategory === 'jobs' && !credited2,
      'a product with no server category → the seller credit is HELD for review (never the client label, never 100%)', { p2, q2, credited2, threw: r2.threw });
    const o2 = H.get('orders', 'CAT2') || {};
    ck('B-3', o2.status === 'paid' || o2.paymentVerified === true || p2.status === 'COMPLETE', 'the buyer\'s verified payment still records as paid — only the SELLER credit waits for review', { o2: { status: o2.status, pv: o2.paymentVerified }, p: p2.status });
  }
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed' + (unproven ? ', ' + unproven + ' UNPROVEN' : ''));
  process.exit(fail ? 1 : (unproven ? 3 : 0));
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
