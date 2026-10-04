#!/usr/bin/env node
/**
 * test-admin-invoices.js — the canonical invoice chain (owner 2026-10-04), end to end on a fake Firestore:
 *   shared/invoice-model · invoice-allocation · migrate-invoices-canonical · adminInvoicesList · adminInvoicesExport
 *
 *   A  allocation: a verified payment → partially_paid → paid; duplicate / replayed webhook → ONE allocation, ONE
 *      transition; refund → payment refunded, balance recalculated, invoice re-opens; refusals for a non-canonical,
 *      draft, void or other-currency invoice, a non-positive amount, an over-refund; overpayment flagged
 *   G  migration: shapes A/B/C classified; legacy "paid" → unverified claim with the original PRESERVED; unknown
 *      flagged + excluded; idempotent (second run changes nothing); dry run writes NOTHING; audit record on apply
 *   L  admin list: confirmed paid = verified allocations ONLY; claims counted separately; unclassified + unmigrated
 *      excluded from totals; the same order in etimsInvoices is NOT a second invoice; admin-only; read-only
 *   X  export: same server query, complete set, phone/items NOT exported, formula-safe, AUDITED before returning
 *   B  deliberate breaks: merchant "mark paid" / fake reference has no effect on confirmed money (claims never sum)
 *   SABOTAGE=1 → confirmed paid sums the CLAIMED total too → L2 must FAIL
 */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), Module = require('module');
const FN = path.join(__dirname, '..', 'functions');
let pass = 0, fail = 0;
const ck = (id, ok, m, d) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (ok || d === undefined ? '' : '   [' + JSON.stringify(d).slice(0, 260) + ']')); ok ? pass++ : fail++; };

/* ── fake Firestore: nested paths, transactions, batches, aggregates, startAfter, getAll ─────────────────── */
const NOW = Date.UTC(2026, 9, 4, 9, 0, 0), DAY = 864e5;
class TS { constructor(ms) { this.ms = ms; } toMillis() { return this.ms; } static fromMillis(ms) { return new TS(ms); } }
const SERVER_TS = { __ts: true };
const INC = (n) => ({ __inc: n });
const store = {};
const readCols = new Set();
const val = (v) => (v instanceof TS ? v.ms : v);
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
function applyPatch(prev, patch) {
  const o = Object.assign({}, prev || {});
  for (const [k, v] of Object.entries(patch)) {
    if (v && v.__inc != null) o[k] = (Number(o[k]) || 0) + v.__inc;
    else if (v && v.__ts) o[k] = new TS(NOW);
    else o[k] = v;
  }
  return o;
}
function docRef(p) {
  return { _p: p, id: p.split('/').pop(), ref: null,
    collection: (c) => colRef(p + '/' + c),
    get: async () => snapOf(p),
    set: async (v) => { store[p] = applyPatch({}, v); },
    update: async (v) => { if (!(p in store)) throw new Error('NOT_FOUND ' + p); store[p] = applyPatch(store[p], v); } };
}
function snapOf(p) { const r = docRef(p); return { exists: p in store, id: p.split('/').pop(), ref: r, data: () => (p in store ? Object.assign({}, store[p]) : undefined) }; }
function colRef(col, filters = [], orders = [], lim = null, after = null) {
  const q = {
    doc: (id) => docRef(col + '/' + (id || ('auto' + Math.random().toString(36).slice(2, 10)))),
    add: async (v) => { const r = q.doc(); await r.set(v); return r; },
    where: (f, op, v) => colRef(col, filters.concat([[f, op, v]]), orders, lim, after),
    orderBy: (f, d) => colRef(col, filters, orders.concat([[f, d || 'asc']]), lim, after),
    limit: (n) => colRef(col, filters, orders, n, after),
    startAfter: (...v) => colRef(col, filters, orders, lim, v),
    _run() {
      readCols.add(col.split('/')[0]);
      const depth = col.split('/').length + 1;
      let ds = Object.keys(store).filter((p) => p.startsWith(col + '/') && p.split('/').length === depth).map((p) => ({ p, id: p.split('/').pop(), raw: store[p] }));
      for (const [f, op, v] of filters) ds = ds.filter((d) => { const x = val(getPath(d.raw, f)), y = val(v);
        if (op === '==') return x === y; if (op === 'in') return y.includes(x); if (x === undefined || x === null) return false;
        if (op === '<') return x < y; if (op === '>=') return x >= y; return false; });
      ds.sort((a, b) => { for (const [f, d] of orders) { const x = f === '__name__' ? a.id : val(getPath(a.raw, f)), y = f === '__name__' ? b.id : val(getPath(b.raw, f)); if (x === y) continue; if (x === undefined) return 1; if (y === undefined) return -1; return (x < y ? -1 : 1) * (d === 'desc' ? -1 : 1); } return 0; });
      if (after) { const key = (d) => orders.map(([f]) => (f === '__name__' ? d.id : val(getPath(d.raw, f)))); const av = after.map((v) => (v && v.ref && v.ref._p !== undefined ? v.id : (v && v._p !== undefined ? v.id : val(v))));   /* a DocumentSnapshot cursor → its id (SDK semantics for orderBy __name__) */
        const idx = ds.findIndex((d) => JSON.stringify(key(d)) === JSON.stringify(av.length === 1 && orders.length === 1 ? av : av)); ds = idx >= 0 ? ds.slice(idx + 1) : ds; }
      if (lim != null) ds = ds.slice(0, lim);
      return ds.map((d) => snapOf(d.p));
    },
    get: async () => { const docs = q._run(); return { docs, size: docs.length, empty: !docs.length }; },
    aggregate: (spec) => ({ get: async () => { const docs = q._run(); const out = {};
      for (const [k, s] of Object.entries(spec)) out[k] = s.t === 'count' ? docs.length : docs.reduce((a, d) => a + (Number(getPath(d.data(), s.f)) || 0), 0);
      return { data: () => out }; } }),
  };
  return q;
}
const db = {
  collection: (c) => colRef(c),
  getAll: async (...refs) => refs.map((r) => snapOf(r._p)),
  batch: () => { const w = []; return { update: (r, v) => w.push(() => { store[r._p] = applyPatch(store[r._p], v); }), set: (r, v) => w.push(() => { store[r._p] = applyPatch({}, v); }), commit: async () => { w.forEach((f) => f()); } }; },
  runTransaction: async (fn) => { const w = []; let wrote = false;
    const t = { get: async (r) => { if (wrote) throw new Error('reads after writes'); return r.get ? r.get() : r; },
      create: (r, v) => { wrote = true; w.push(() => { if (r._p in store) throw new Error('ALREADY_EXISTS ' + r._p); store[r._p] = applyPatch({}, v); }); },
      update: (r, v) => { wrote = true; w.push(() => { store[r._p] = applyPatch(store[r._p], v); }); },
      set: (r, v) => { wrote = true; w.push(() => { store[r._p] = applyPatch({}, v); }); } };
    const out = await fn(t); for (const f of w) f(); return out; },
};
const FV = { serverTimestamp: () => SERVER_TS, increment: INC };
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
const _load = Module._load;
Module._load = function (req) {
  if (req === 'firebase-functions/v2/https') return { onCall: (o, h) => h, HttpsError };
  if (req === 'firebase-admin/firestore') return { getFirestore: () => db, AggregateField: { count: () => ({ t: 'count' }), sum: (f) => ({ t: 'sum', f }) }, FieldValue: FV, Timestamp: TS };
  return _load.apply(this, arguments);
};
let src = fs.readFileSync(path.join(FN, 'admin-invoices.js'), 'utf8');
if (process.env.SABOTAGE === '1') src = src.replace("_agg('confirmedPaid', canon, { sum: AggregateField.sum('paidCents') }, out, why),", "_agg('confirmedPaid', canon.where('status', 'in', ['issued', 'partially_paid', 'paid']), { sum: AggregateField.sum('totalCents') }, out, why),");
const tmp = path.join(FN, '.under-test-admin-invoices-' + process.pid + '.js'); fs.writeFileSync(tmp, src);
let AI; try { AI = require(tmp)._internal; } finally { fs.unlinkSync(tmp); }
AI._setClock(() => NOW);
const ALLOC = require(path.join(FN, 'invoice-allocation.js'));
const MIG = require(path.join(__dirname, 'migrate-invoices-canonical.js'));
const admin = (data) => ({ auth: { uid: 'adm', token: { admin: true } }, data: data || {} });
const call = async (fn, r) => { try { return await fn(r); } catch (e) { return { err: e.code || e.message, reason: e.details && e.details.reason }; } };
const iso = (d) => new Date(NOW + d * DAY).toISOString();
const reset = () => { for (const k of Object.keys(store)) delete store[k]; };

(async () => {
  console.log('\nCanonical invoices — allocation · migration · admin list · export' + (process.env.SABOTAGE === '1' ? '  (SABOTAGE)' : '') + '\n');

  /* ── A allocation ── */
  reset();
  store['invoices/c1'] = { modelVersion: 1, source: 'order', status: 'issued', currency: 'KES', totalCents: 100000, paidCents: 0, balanceCents: 100000, invoiceNumber: 'INV-C1' };
  let r = await ALLOC.applyVerifiedPayment(db, { invoiceId: 'c1', paymentId: 'pay1', amountCents: 40000, currency: 'KES', provider: 'intasend', providerRef: 'ISL1', FieldValue: FV });
  ck('A1', r.ok && store['invoices/c1'].status === 'partially_paid' && store['invoices/c1'].paidCents === 40000 && store['invoices/c1'].balanceCents === 60000 && r.receipt && r.receipt.receivedCents === 40000 && r.receipt.appliedCents === 40000 && r.receipt.excessHeldCents === 0, 'a verified payment of 400 on 1,000 → partially_paid, balance 600, a receipt payload returned', store['invoices/c1']);
  r = await ALLOC.applyVerifiedPayment(db, { invoiceId: 'c1', paymentId: 'pay1', amountCents: 40000, FieldValue: FV });
  ck('A2', r.replay === true && store['invoices/c1'].paidCents === 40000 && Object.keys(store).filter((p) => p.startsWith('invoices/c1/allocations/')).length === 1, 'a DUPLICATE / replayed webhook → one payment, one allocation, no second transition');
  r = await ALLOC.applyVerifiedPayment(db, { invoiceId: 'c1', paymentId: 'pay2', amountCents: 60000, FieldValue: FV });
  ck('A3', store['invoices/c1'].status === 'paid' && store['invoices/c1'].balanceCents === 0 && store['invoices/c1'].paidAt, 'the second verified payment completes it → paid, balance 0', store['invoices/c1']);
  r = await ALLOC.refundAllocation(db, { invoiceId: 'c1', paymentId: 'pay2', refundId: 'rf1', refundCents: 60000, FieldValue: FV });
  ck('A4', store['invoices/c1'].status === 'partially_paid' && store['invoices/c1'].paidCents === 40000 && store['invoices/c1/allocations/pay2'].status === 'refunded', 'a full refund of pay2 → that payment refunded, invoice re-opens to partially_paid, balance recalculated', store['invoices/c1']);
  r = await ALLOC.refundAllocation(db, { invoiceId: 'c1', paymentId: 'pay2', refundId: 'rf1', refundCents: 60000, FieldValue: FV });
  ck('A5', r.replay === true && store['invoices/c1'].paidCents === 40000, 'a replayed refund is a no-op');
  let e = await ALLOC.refundAllocation(db, { invoiceId: 'c1', paymentId: 'pay1', refundId: 'rf2', refundCents: 50000, FieldValue: FV }).catch((x) => x);
  ck('A6', e && e.code === 'too_much' && store['invoices/c1'].paidCents === 40000, 'a refund larger than what the payment holds is refused, nothing changes', e && e.code);
  store['invoices/legacy1'] = { status: 'sent', total: 100 };
  store['invoices/d1'] = { modelVersion: 1, source: 'manual', status: 'draft', totalCents: 500, currency: 'KES' };
  store['invoices/v1'] = { modelVersion: 1, source: 'manual', status: 'void', totalCents: 500, currency: 'KES' };
  const refusals = [];
  for (const [inv, cur, amt] of [['legacy1', 'KES', 100], ['d1', 'KES', 100], ['v1', 'KES', 100], ['c1', 'USD', 100], ['c1', 'KES', 0], ['nope', 'KES', 100]]) {
    const x = await ALLOC.applyVerifiedPayment(db, { invoiceId: inv, paymentId: 'px' + refusals.length, amountCents: amt, currency: cur, FieldValue: FV }).catch((er) => er);
    refusals.push(x && x.code);
  }
  ck('A7', JSON.stringify(refusals) === JSON.stringify(['not_canonical', 'not_payable', 'not_payable', 'currency', 'invalid', 'not_found']), 'refused: non-canonical, draft, void, other currency, non-positive, unknown invoice', refusals);
  store['invoices/o1'] = { modelVersion: 1, source: 'order', status: 'issued', currency: 'KES', totalCents: 1000, paidCents: 0 };
  const ov = await ALLOC.applyVerifiedPayment(db, { invoiceId: 'o1', paymentId: 'big', amountCents: 1500, FieldValue: FV });
  const hold = store['invoiceExcessHolds/big'] || {};
  ck('A8', store['invoices/o1'].status === 'paid' && store['invoices/o1'].paidCents === 1000 && store['invoices/o1'].excessHeldCents === 500 && store['invoices/o1'].reviewFlag === 'overpaid' && hold.status === 'held' && hold.excessCents === 500, 'OVERPAY 1,500 on 1,000: APPLIED 1,000 (paid), EXCESS 500 HELD separately + flagged — never credited', { inv: store['invoices/o1'], hold });
  ck('A9', ov.receivedCents === 1500 && ov.appliedCents === 1000 && ov.excessHeldCents === 500 && ov.receipt.receivedCents === 1500 && ov.receipt.appliedCents === 1000 && ov.receipt.excessHeldCents === 500, 'the receipt distinguishes RECEIVED 1,500 / APPLIED 1,000 / EXCESS HELD 500 (never more than resolved)', ov.receipt);
  const ov2 = await ALLOC.applyVerifiedPayment(db, { invoiceId: 'o1', paymentId: 'big', amountCents: 1500, FieldValue: FV });
  ck('A10', ov2.replay === true && store['invoices/o1'].excessHeldCents === 500 && Object.keys(store).filter((p) => p.startsWith('invoiceExcessHolds/')).length === 1, 'a DUPLICATE overpaying webhook → one allocation, ONE hold, excess not doubled', store['invoices/o1']);
  store['invoices/u1'] = { modelVersion: 1, source: 'manual', status: 'issued', currency: 'KES', totalCents: 1000, paidCents: 0 };
  const un = await ALLOC.applyVerifiedPayment(db, { invoiceId: 'u1', paymentId: 'small', amountCents: 300, FieldValue: FV });
  ck('A11', un.appliedCents === 300 && un.excessHeldCents === 0 && store['invoices/u1'].status === 'partially_paid' && store['invoices/u1'].balanceCents === 700 && !store['invoiceExcessHolds/small'], 'UNDERPAY 300 on 1,000: applied 300, invoice stays outstanding (700), no hold', store['invoices/u1']);

  /* ── G migration ── */
  reset();
  store['invoices/mA'] = { shopId: 'shopA', clientName: 'Acme', invoiceNumber: 'INV-1', status: 'sent', total: 1000.5, dueDate: iso(+5), createdAt: TS.fromMillis(NOW - DAY), sentAt: TS.fromMillis(NOW - DAY) };
  store['invoices/mAp'] = { shopId: 'shopA', clientName: 'Beta', invoiceNumber: 'INV-2', status: 'paid', total: 800, paidAt: TS.fromMillis(NOW - 2 * DAY), paidBy: 'merch', paymentRef: 'QWE123', paymentMethod: 'mpesa', createdAt: TS.fromMillis(NOW - 3 * DAY) };
  store['invoices/mB'] = { sellerUid: 'seller1', period: '2026-09', status: 'paid', total: 4500, paymentRef: 'ADMIN-REF', paidAt: TS.fromMillis(NOW - DAY), createdAt: TS.fromMillis(NOW - 4 * DAY) };
  store['invoices/ord9'] = { orderId: 'ord9', status: 'issued', total: 2500, dueDate: iso(-10), createdAt: TS.fromMillis(NOW - 20 * DAY) };
  store['invoices/junk'] = { foo: 'bar', total: 999999 };
  store['invoices/mAd'] = { shopId: 'shopA', clientName: 'Draft Co', status: 'draft', total: 300, createdAt: TS.fromMillis(NOW) };
  const before = JSON.stringify(store);
  let g = await MIG.run(db, { apply: false });
  ck('G1', JSON.stringify(store) === before && g.counts.canonicalise === 5 && g.counts.flag_unknown === 1, 'DRY RUN classifies 5 + flags 1 and writes NOTHING', g.counts);
  g = await MIG.run(db, { apply: true, serverTs: () => SERVER_TS, runId: 't1' });
  ck('G2', store['invoices/mA'].source === 'manual' && store['invoices/mB'].source === 'commission' && store['invoices/ord9'].source === 'order' && store['invoices/ord9'].transactionRef.id === 'ord9' && store['invoices/mA'].modelVersion === 1 && store['invoices/mA'].totalCents === 100050 && store['invoices/mA'].status === 'issued', 'shapes A / B / C classified; cents; sent → issued', { mA: store['invoices/mA'].status, ord: store['invoices/ord9'].transactionRef });
  const p = store['invoices/mAp'];
  ck('G3', p.status === 'issued' && p.paidCents === 0 && p.paymentStatus === 'unverified' && p.paymentClaim.status === 'unverified' && p.paymentClaim.reference === 'QWE123' && p.paymentClaim.source === 'legacy_mark_paid' && p.legacy.status === 'paid' && p.legacy.paymentRef === 'QWE123', 'a legacy merchant "paid" → an UNVERIFIED claim, paid 0, original preserved under legacy', p);
  ck('G4', store['invoices/mB'].paymentClaim.source === 'legacy_admin_recorded' && store['invoices/mB'].paidCents === 0, 'a legacy admin-recorded commission payment is a claim too (never confirmed money)', store['invoices/mB'].paymentClaim);
  ck('G5', store['invoices/junk'].classification === 'unknown' && store['invoices/junk'].excludedFromTotals === true && !store['invoices/junk'].modelVersion, 'an unrecognisable doc is flagged unknown and excluded (no modelVersion)', store['invoices/junk']);
  ck('G6', store['migrationRuns/invoices-canonical-t1'] && store['migrationRuns/invoices-canonical-t1'].counts.canonicalise === 5, 'the apply run writes ONE audit record with its counts');
  const afterApply = JSON.stringify(store);
  g = await MIG.run(db, { apply: true, serverTs: () => SERVER_TS, runId: 't2' });
  ck('G7', g.counts.skip === 6 && g.counts.canonicalise === 0 && JSON.stringify(Object.fromEntries(Object.entries(store).filter(([k]) => !k.startsWith('migrationRuns/')))) === JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(afterApply)).filter(([k]) => !k.startsWith('migrationRuns/')))), 'idempotent: a second run skips all 6 and changes no invoice', g.counts);

  /* ── L admin list (on the migrated store + a verified payment + a fresh claim + an unmigrated doc + an etims copy) ── */
  await ALLOC.applyVerifiedPayment(db, { invoiceId: 'ord9', paymentId: 'payO', amountCents: 100000, FieldValue: FV });     /* 1,000 verified on 2,500 */
  store['invoices/mA'].paymentClaim = { status: 'unverified', reference: 'FAKE-ISL-XYZ', source: 'merchant_claim' };        /* break B: a fresh merchant claim */
  store['invoices/unmig'] = { status: 'sent', total: 70 };                                                                     /* not migrated yet */
  store['etimsInvoices/e1'] = { orderId: 'ord9', status: 'accepted', total: 2500 };                                             /* tax copy of the SAME order */
  store['shops/shopA'] = { name: 'Duka A' };
  const snapBefore = JSON.stringify(store);
  r = await call(AI.list, admin({ limit: 100 }));
  const s = r.summary;
  ck('L1', s.counts.all === 5 && s.counts.unclassified === 1 && s.excluded.unmigrated === 1 && s.counts.issued === 3 && s.counts.partially_paid === 1 && s.counts.draft === 1, 'counts: 5 canonical; 1 unclassified + 1 unmigrated EXCLUDED; status counts from canonical only', s.counts);
  ck('L2', s.confirmedPaidCents === 100000, 'CONFIRMED PAID = verified allocations only (1,000.00) — never a legacy "paid", an admin-recorded ref or a merchant claim (break B)', s.confirmedPaidCents);
  ck('L3', s.unverifiedClaims === 3, 'unverified claims are counted SEPARATELY (2 migrated legacy + 1 fresh merchant claim)', s.unverifiedClaims);
  ck('L4', s.totalInvoicedCents === 100050 + 80000 + 450000 + 250000 && s.openBalanceCents === 100050 + 80000 + 450000 + 150000 && s.overdueBalanceCents === 150000, 'invoiced / open / overdue balances from canonical cents (overdue = the order, 1,500 left)', s);
  ck('L5', !readCols.has('etimsInvoices') && r.invoices.filter((x) => x.transactionRef && x.transactionRef.id === 'ord9').length === 1, 'the same order in etimsInvoices is NOT counted: ONE canonical invoice for the transaction');
  const ord = r.invoices.find((x) => x.id === 'ord9') || {};
  ck('L6', ord.display === 'overdue' && ord.base === 'partially_paid' && ord.paidCents === 100000 && ord.balanceCents === 150000 && ord.source === 'order', 'row: server-derived overdue over partially_paid, paid / balance in cents, source order', ord);
  const legacyRow = r.invoices.find((x) => x.id === 'mAp') || {};
  ck('L7', legacyRow.paymentClaim && legacyRow.paymentClaim.status === 'unverified' && legacyRow.legacy && legacyRow.legacy.status === 'paid' && legacyRow.status === 'issued', 'the migrated legacy "paid" shows as issued + unverified claim + its legacy history', legacyRow);
  const rU = await call(AI.list, admin({ tab: 'unclassified' }));
  ck('L8', rU.invoices.length === 1 && rU.invoices[0].id === 'junk' && rU.invoices[0].classification === 'unknown', 'the unclassified tab lists only flagged docs', rU.invoices.map((x) => x.id));
  const rC = await call(AI.list, admin({ tab: 'unverified', limit: 100 }));
  ck('L9', rC.invoices.map((x) => x.id).sort().join(',') === 'mA,mAp,mB', 'the unverified tab = invoices carrying an unverified payment claim', rC.invoices.map((x) => x.id));
  const rN = await call(AI.list, { auth: { uid: 'u', token: {} }, data: {} });
  const rA = await call(AI.list, { auth: null, data: {} });
  ck('L10', rN.err === 'permission-denied' && rA.err === 'unauthenticated', 'admin / superAdmin only', { rN, rA });
  ck('L11', JSON.stringify(store) === snapBefore, 'read-only: the store is identical after the list calls');

  /* ── X export ── */
  store['invoices/mA'].clientPhone = '0700111222';
  store['invoices/mA'].clientName = '=HYPERLINK("evil")';
  r = await call(AI.exportCsv, admin({ tab: 'all' }));
  const audit = Object.entries(store).find(([k, v]) => k.startsWith('adminAudit/') && v.action === 'invoices_export');
  ck('X1', r.rows === 5 && /^id,invoiceNumber,/.test(r.csv) && r.csv.split('\n').length === 6, 'export = the same canonical query, complete (5 rows)', r.rows);
  ck('X2', !/0700111222/.test(r.csv) && !/Work|items/.test(r.csv.split('\n')[0]), 'sensitive fields restricted: no phone, no line items');
  ck('X3', /"'=HYPERLINK/.test(r.csv), 'formula-safe cells');
  ck('X4', audit && audit[1].performedBy === 'adm' && audit[1].rows === 5 && audit[1].tab === 'all', 'AUDITED: admin, tab, row count recorded', audit && audit[1]);
  const rX = await call(AI.exportCsv, { auth: { uid: 'u', token: {} }, data: {} });
  ck('X5', rX.err === 'permission-denied', 'export is admin-only');

  console.log('\n' + pass + ' passed, ' + fail + ' failed' + (process.env.SABOTAGE === '1' ? '   (SABOTAGE — failures EXPECTED)' : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e.stack || e.message); process.exit(2); });
