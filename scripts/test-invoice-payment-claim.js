#!/usr/bin/env node
/**
 * test-invoice-payment-claim.js — owner 2026-10-04: a merchant "Mark Paid" is a PAYMENT CLAIM, never "paid".
 * The REAL finance-os-sprint43 handlers on a fake Firestore (transactions with reads-before-writes + create()).
 *   C1  invoiceMarkPaid records an UNVERIFIED claim; invoice status / paidAt / paidBy / paymentRef / balance UNCHANGED
 *   C2  the honest op name invoiceSubmitPaymentClaim runs the same handler
 *   C3  a fake IntaSend-looking reference has NO financial effect (no wallet / commission / receipt / ledger write)
 *   C4  the same reference twice → ONE claim (replay)
 *   C5  shop scope: another shop's merchant / a stranger is refused; a voided invoice refuses claims
 *   C6  validation: reference required; amount positive and ≤ invoice total
 *   C7  CONTROL: invoiceVoid still works for the owner (unchanged handler)
 *   SABOTAGE=1 → the old handler body (status:'paid') → C1 / C3 must FAIL
 */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), Module = require('module');
const FN = path.join(__dirname, '..', 'functions');
let pass = 0, fail = 0;
const ck = (id, ok, m, d) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (ok || d === undefined ? '' : '   [' + JSON.stringify(d).slice(0, 220) + ']')); ok ? pass++ : fail++; };
const store = {}; let seq = 0;
const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const snapOf = (p) => ({ exists: p in store, id: p.split('/').pop(), data: () => clone(store[p]) });
function ref(p) { return { _p: p, id: p.split('/').pop(), get: async () => snapOf(p), set: async (v, o) => { store[p] = Object.assign({}, o && o.merge ? store[p] : {}, clone(v)); }, update: async (v) => { store[p] = Object.assign({}, store[p], clone(v)); } }; }
function col(c, filters = [], lim = null) { return { doc: (id) => ref(c + '/' + (id || 'auto' + (++seq))), where: (f, op, v) => col(c, filters.concat([[f, v]]), lim), limit: (n) => col(c, filters, n),
  get: async () => { let ds = Object.keys(store).filter((p) => p.startsWith(c + '/') && p.split('/').length === 2); for (const [f, v] of filters) ds = ds.filter((p) => store[p][f] === v); if (lim) ds = ds.slice(0, lim); const docs = ds.map(snapOf); return { empty: !docs.length, docs }; } }; }
const db = { collection: (c) => col(c),
  runTransaction: async (fn) => { const w = []; let wrote = false; const t = { get: async (x) => { if (wrote) throw new Error('reads after writes'); return x.get(); },
    create: (x, v) => { wrote = true; w.push(() => { if (x._p in store) throw new Error('ALREADY_EXISTS'); store[x._p] = clone(v); }); },
    update: (x, v) => { wrote = true; w.push(() => { store[x._p] = Object.assign({}, store[x._p], clone(v)); }); },
    set: (x, v) => { wrote = true; w.push(() => { store[x._p] = clone(v); }); } };
    const r = await fn(t); for (const f of w) f(); return r; } };
const firestoreFn = () => db; firestoreFn.FieldValue = { serverTimestamp: () => 'TS', increment: (n) => n, arrayUnion: (...v) => v, delete: () => null };
const _load = Module._load;
Module._load = function (req) {
  if (req === 'firebase-functions/v2/https') return { onCall: (o, h) => h, HttpsError: Error };
  if (req === 'firebase-functions/params') return { defineSecret: () => ({ value: () => 'placeholder' }) };
  if (req === 'firebase-admin') return { firestore: firestoreFn };
  return _load.apply(this, arguments);
};
let src = fs.readFileSync(path.join(FN, 'finance-os-sprint43.js'), 'utf8');
if (process.env.SABOTAGE === '1') src = src.replace("tx.update(invRef, { paymentClaim: { status: 'unverified', claimId, reference, method, amountClaimed, by: uid, at: _ts() }, updatedAt: _ts() });", "tx.update(invRef, { status: 'paid', paidAt: _ts(), paidBy: uid, paymentRef: reference, updatedAt: _ts() });");
const tmp = path.join(FN, '.under-test-fos43-' + process.pid + '.js'); fs.writeFileSync(tmp, src);
let H; try { H = require(tmp)._h; } finally { fs.unlinkSync(tmp); }
const as = (uid, data) => ({ auth: { uid }, data });
const call = async (op, r) => { try { return await H[op](r); } catch (e) { return { err: e.message }; } };
const MONEY = ['wallets', 'walletTransactions', 'commissions', 'commissionLedger', 'transactionReceipts', 'receipts', 'payments', 'paymentLedger', 'revenue', 'providerPayouts', 'settlements'];
const moneyDocs = () => Object.keys(store).filter((p) => MONEY.includes(p.split('/')[0]));

(async () => {
  console.log('\nInvoice payment claim' + (process.env.SABOTAGE === '1' ? '  (SABOTAGE)' : '') + '\n');
  store['shops/shopA'] = { ownerId: 'merch' }; store['shops/shopB'] = { ownerId: 'other' };
  store['invoices/inv1'] = { id: 'inv1', shopId: 'shopA', invoiceNumber: 'INV-1', status: 'sent', total: 1000, currency: 'KES', paidAt: null, paidBy: null, paymentRef: null };
  store['invoices/inv2'] = { id: 'inv2', shopId: 'shopA', status: 'void', total: 50 };
  store['invoices/inv3'] = { id: 'inv3', shopId: 'shopA', status: 'sent', total: 200 };
  const before = clone(store['invoices/inv1']);
  let r = await call('invoiceMarkPaid', as('merch', { shopId: 'shopA', invoiceId: 'inv1', paymentRef: 'QWE123XYZ', paymentMethod: 'mpesa' }));
  const inv = store['invoices/inv1'];
  const claims = Object.keys(store).filter((p) => p.startsWith('invoicePaymentClaims/'));
  const cl = claims.length ? store[claims[0]] : {};
  ck('C1', r.success === true && r.verified === false && r.status === 'unverified' && inv.status === 'sent' && inv.paidAt === null && inv.paidBy === null && inv.paymentRef === null && claims.length === 1 && cl.status === 'unverified' && cl.reference === 'QWE123XYZ' && inv.paymentClaim && inv.paymentClaim.status === 'unverified',
    '"Mark Paid" records an UNVERIFIED claim; the invoice stays sent — no paidAt / paidBy / paymentRef', { r, inv, cl });
  ck('C1b', /awaiting verification/.test(r.message || ''), 'the merchant is told "awaiting verification", not "paid"', r.message);
  r = await call('invoiceSubmitPaymentClaim', as('merch', { shopId: 'shopA', invoiceId: 'inv3', paymentRef: 'BANK-777', paymentMethod: 'bank', amount: 200 }));
  ck('C2', r.claimed === true && store['invoices/inv3'].status === 'sent' && store['invoices/inv3'].paymentClaim.amountClaimed === 200, 'invoiceSubmitPaymentClaim is the same handler', r);
  r = await call('invoiceMarkPaid', as('merch', { shopId: 'shopA', invoiceId: 'inv1', paymentRef: 'ISL_faKe-intasend-ref', paymentMethod: 'card' }));
  ck('C3', moneyDocs().length === 0 && store['invoices/inv1'].status === 'sent', 'a fake IntaSend-looking reference: NO wallet / commission / receipt / ledger / payment write', moneyDocs());
  const n = Object.keys(store).filter((p) => p.startsWith('invoicePaymentClaims/')).length;
  r = await call('invoiceMarkPaid', as('merch', { shopId: 'shopA', invoiceId: 'inv1', paymentRef: 'qwe123xyz' }));
  ck('C4', r.replay === true && Object.keys(store).filter((p) => p.startsWith('invoicePaymentClaims/')).length === n, 'the same reference again (any case) → ONE claim, replay', r);
  r = await call('invoiceMarkPaid', as('other', { shopId: 'shopA', invoiceId: 'inv1', paymentRef: 'XYZ999' }));
  const r2 = await call('invoiceMarkPaid', as('other', { shopId: 'shopB', invoiceId: 'inv1', paymentRef: 'XYZ999' }));
  const r3 = await call('invoiceMarkPaid', as('merch', { shopId: 'shopA', invoiceId: 'inv2', paymentRef: 'XYZ999' }));
  ck('C5', r.err === 'forbidden' && r2.err === 'invoice not found' && r3.err === 'invoice is voided', 'another merchant / another shop\'s invoice / a voided invoice are refused', { r, r2, r3 });
  const v1 = await call('invoiceMarkPaid', as('merch', { shopId: 'shopA', invoiceId: 'inv3', paymentRef: 'x' }));
  const v2 = await call('invoiceMarkPaid', as('merch', { shopId: 'shopA', invoiceId: 'inv3', paymentRef: 'REF-OK-1', amount: 5000 }));
  const v3 = await call('invoiceMarkPaid', as('merch', { shopId: 'shopA', invoiceId: 'inv3', paymentRef: 'REF-OK-2', amount: -3 }));
  ck('C6', /reference is required/.test(v1.err || '') && /exceeds/.test(v2.err || '') && /positive/.test(v3.err || ''), 'reference required; amount positive and ≤ the invoice total', { v1, v2, v3 });
  r = await call('invoiceVoid', as('merch', { shopId: 'shopA', invoiceId: 'inv3', reason: 'duplicate' }));
  ck('C7', store['invoices/inv3'].status === 'void', 'CONTROL: invoiceVoid unchanged for the owner', r);
  /* canonical writers (owner 2026-10-04) */
  r = await call('invoiceCreate', as('merch', { shopId: 'shopA', clientName: 'Acme', items: [{ description: 'Work', quantity: 2, unitPrice: 1250.5 }], taxRate: 16, dueDate: '2026-12-01' }));
  const ci = store['invoices/' + r.invoiceId] || {};
  ck('W1', ci.modelVersion === 1 && ci.source === 'manual' && ci.status === 'draft' && ci.totalCents === Math.round(ci.total * 100) && ci.paidCents === 0 && ci.balanceCents === ci.totalCents && ci.paymentStatus === 'pending', 'a new merchant invoice is CANONICAL from birth (source manual, cents, paid 0)', ci);
  r = await call('invoiceSend', as('merch', { shopId: 'shopA', invoiceId: ci.id }));
  ck('W2', store['invoices/' + ci.id].status === 'issued', 'send: draft → issued (canonical name)', store['invoices/' + ci.id].status);
  store['invoices/' + ci.id].paidCents = 100; store['invoices/' + ci.id].status = 'partially_paid';
  r = await call('invoiceVoid', as('merch', { shopId: 'shopA', invoiceId: ci.id, reason: 'oops' }));
  ck('W3', /refund it first/.test(r.err || '') && store['invoices/' + ci.id].status === 'partially_paid', 'void is refused once a verified payment exists (refund first)', r);
  console.log('\n' + pass + ' passed, ' + fail + ' failed' + (process.env.SABOTAGE === '1' ? '   (SABOTAGE — failures EXPECTED)' : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e.stack || e.message); process.exit(2); });
