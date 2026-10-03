#!/usr/bin/env node
'use strict';
/* ============================================================================
   Platform receipts convergence (owner 2026-10-03)
     L1  Legal: a quote receipt links quoteId + bookingId; release with fee + provider share balances
     B1  B2B: gross 500,000, commission 0, lead-fee recovery 696 as a DEDUCTION (never platformFee), supplier 499,304
     B2  an UNBALANCED release (fee + share + deductions ≠ amount) is refused — nothing written
     B3  an unknown deduction kind is refused
     Q1  a failed receipt write is queued WITH its replay; the payment path is unaffected; retry writes EXACTLY ONE receipt;
         a second retry changes nothing; a replayed event retry writes one event
     A1  admin search by receiptNo / paymentRef returns header + immutable events
     N1  numbering: 120 concurrent allocations across two instances → all unique; per-instance ascending; year rollover resets
     C2  deliberate anomalies: receipt without payment, duplicate payment ref, invalid history, release without hold, refund missing from history
     C1  reconciliation: missing receipt, paid mismatch, settled-without-release, provider-share mismatch, refund mismatch,
         orphan receipt — recorded as exceptions, nothing corrected; a recurring exception keeps its firstSeenAt
     X1  the old Daraja recorder is RETIRED (refuses, writes nothing)
   NODE_PATH=<functions/node_modules> node scripts/test-receipts-convergence.js
   ============================================================================ */
const path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 240) : '')); } };

function fakeDb (opts) {
  const docs = new Map(); let auto = 0; const o = opts || {};
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const snap = (p) => { const v = clone(docs.get(p)); return { id: p.split('/').pop(), exists: v !== undefined, data: () => v }; };
  const ref = (p) => ({ path: p, id: p.split('/').pop(), get: async () => snap(p), collection: (c) => coll(p + '/' + c),
    set: async (v, m) => docs.set(p, Object.assign({}, m && m.merge ? docs.get(p) : {}, clone(v))) });
  const coll = (c) => ({ doc: (id) => ref(c + '/' + id), add: async (v) => { const id = 'a' + (++auto); docs.set(c + '/' + id, clone(v)); return { id }; },
    where: (f, op, v) => q(c, [[f, v]]), limit: () => q(c, []), get: () => q(c, []).get() });
  const q = (c, filters) => ({ where: (f, op, v) => q(c, filters.concat([[f, v]])), limit: () => q(c, filters),
    get: async () => { const rows = [...docs.keys()].filter((k) => k.startsWith(c + '/') && k.split('/').length === c.split('/').length + 1 && filters.every(([f, v]) => (docs.get(k) || {})[f] === v)); return { docs: rows.map(snap) }; } });
  return { _docs: docs, collection: coll,
    async runTransaction (fn) {
      if (o.failTxn && o.failTxn()) throw new Error('simulated outage');
      const w = []; const reads = new Map();
      const t = { get: async (r) => { const s = snap(r.path); reads.set(r.path, JSON.stringify(docs.get(r.path))); return s; },
        set: (r, v, m) => w.push(() => docs.set(r.path, Object.assign({}, m && m.merge ? docs.get(r.path) : {}, clone(v)))),
        create: (r, v) => w.push(() => { if (docs.has(r.path)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } docs.set(r.path, clone(v)); }),
        update: (r, v) => w.push(() => docs.set(r.path, Object.assign({}, docs.get(r.path), clone(v)))) };
      for (let i = 0; i < 8; i++) {
        w.length = 0; reads.clear();
        const out = await fn(t);
        await new Promise((r) => setImmediate(r));
        if ([...reads].some(([k, v]) => JSON.stringify(docs.get(k)) !== v)) continue;   /* optimistic retry */
        const before = new Map(docs);
        try { w.forEach((f) => f()); } catch (e) { docs.clear(); before.forEach((v, k) => docs.set(k, v)); throw e; }
        return out;
      }
      throw new Error('contention');
    } };
}
const TR = require(path.join(FN, 'transaction-receipts.js'));
const RR = require(path.join(FN, 'receipt-reconciliation.js'));
let SEQ = 0;
const deps = { nextNumber: async (k) => 'SKN-' + k + '-2026-' + String(++SEQ).padStart(6, '0'), serverTs: () => '2026-10-03T10:00:00Z' };

(async () => {
  /* L1 */
  let db = fakeDb();
  await TR.recordPaid(db, { kind: 'quote', sourceId: 'q9', clientUid: 'c1', counterpartyId: 'firm1', counterpartyName: 'Wakili Advocates', serviceLabel: 'Term sheet review',
    quotedCents: 2000000, paidCents: 2000000, paymentRef: 'API_Q9', links: { quoteId: 'q9', bookingId: 'bk77', junk: 'x' }, taxTreatment: 'provider_fiscal_invoice' }, deps);
  let r = await TR.recordEvent(db, 'quote_q9', { type: 'released', amountCents: 2000000, platformFeeCents: 100000, providerNetCents: 1900000, opKey: 'bk77' }, deps);
  let rc = db._docs.get('transactionReceipts/quote_q9');
  ck('L1 Legal quote receipt links quoteId + bookingId (unknown link keys dropped); 5% fee 1,000 + share 19,000 balances → released',
    rc.links.quoteId === 'q9' && rc.links.bookingId === 'bk77' && !('junk' in rc.links) && r.ok && rc.status === 'released' && rc.platformFeeCents === 100000, rc);

  /* B1 – B3 */
  db = fakeDb();
  await TR.recordPaid(db, { kind: 'b2b_order', sourceId: 'po1', clientUid: 'buyerBiz', counterpartyId: 'supUid', counterpartyName: 'Wholesale Ltd', serviceLabel: 'PO po1',
    paidCents: 50000000, paymentRef: 'API_PO1', links: { purchaseOrderId: 'po1' }, taxTreatment: 'provider_fiscal_invoice' }, deps);
  r = await TR.recordEvent(db, 'b2b_order_po1', { type: 'released', amountCents: 50000000, platformFeeCents: 0, providerNetCents: 49930400,
    deductions: [{ kind: 'lead_fee_recovery', amountCents: 69600, ref: 'leaddeduct_set1' }], opKey: 'set1' }, deps);
  rc = db._docs.get('transactionReceipts/b2b_order_po1');
  const ev = db._docs.get('transactionReceipts/b2b_order_po1/events/released_set1');
  ck('B1 B2B: gross 500,000 · commission 0 · lead-fee recovery 696 as a DEDUCTION · supplier 499,304 (the 696 is never platformFee)',
    r.ok && rc.platformFeeCents === 0 && rc.deductionsCents === 69600 && rc.providerNetCents === 49930400 && ev.deductions[0].kind === 'lead_fee_recovery' && ev.deductions[0].ref === 'leaddeduct_set1', { rc, ev });
  db = fakeDb();
  await TR.recordPaid(db, { kind: 'service_booking', sourceId: 'bkU', clientUid: 'c', paidCents: 300000, paymentRef: 'API_U' }, deps);
  r = await TR.recordEvent(db, 'service_booking_bkU', { type: 'released', amountCents: 300000, platformFeeCents: 15000, providerNetCents: 270000, opKey: 'bkU' }, deps);
  ck('B2 an unbalanced release (15,000 + 270,000 ≠ 300,000) is refused; nothing released', r.ok === false && r.reason === 'unbalanced_release' && db._docs.get('transactionReceipts/service_booking_bkU').releasedCents === 0, r);
  r = await TR.recordEvent(db, 'service_booking_bkU', { type: 'released', amountCents: 300000, platformFeeCents: 0, providerNetCents: 290000, deductions: [{ kind: 'tip', amountCents: 10000 }], opKey: 'bkU2' }, deps);
  ck('B3 an unknown deduction kind is refused', r.ok === false && r.reason === 'bad_deduction');

  /* Q1 */
  let down = true;
  db = fakeDb({ failTxn: () => down });
  const args = { kind: 'service_booking', sourceId: 'bkQ', clientUid: 'c', paidCents: 300000, paymentRef: 'API_Q' };
  r = await TR.safely(db, 'paid:bkQ', () => TR.recordPaid(db, args, deps), { op: 'paid', args });
  const fails = () => [...db._docs.keys()].filter((k) => k.startsWith('transactionReceiptFailures/'));
  ck('Q1a receipt write fails → queued with its replay; the payment path got a value, not a throw', r.ok === false && r.reason === 'queued_for_retry' && fails().length === 1 && db._docs.get(fails()[0]).replay.op === 'paid');
  down = false;
  let out = await TR.retryFailures(db, deps);
  const receipts = () => [...db._docs.keys()].filter((k) => /^transactionReceipts\/[^/]+$/.test(k));
  ck('Q1b retry writes EXACTLY ONE receipt and resolves the failure', out.resolved === 1 && receipts().length === 1 && db._docs.get(fails()[0]).status === 'resolved', out);
  db._docs.set(fails()[0], Object.assign(db._docs.get(fails()[0]), { status: 'open' }));
  out = await TR.retryFailures(db, deps);
  ck('Q1c a second retry of the same failure changes nothing (already present)', out.resolved === 1 && receipts().length === 1 && db._docs.get(fails()[0]).result === 'already_present', out);
  down = true;
  const eargs = { type: 'released', amountCents: 300000, platformFeeCents: 15000, providerNetCents: 285000, opKey: 'bkQ' };
  await TR.safely(db, 'rel:bkQ', () => TR.recordEvent(db, 'service_booking_bkQ', eargs, deps), { op: 'event', receiptId: 'service_booking_bkQ', args: eargs });
  down = false;
  await TR.retryFailures(db, deps); await TR.retryFailures(db, deps);
  ck('Q1d a queued release replays to exactly one event', [...db._docs.keys()].filter((k) => k.startsWith('transactionReceipts/service_booking_bkQ/events/released_')).length === 1
    && db._docs.get('transactionReceipts/service_booking_bkQ').releasedCents === 300000);

  /* A1 */
  const a = await TR.adminSearch(db, { paymentRef: 'API_Q' });
  const b = await TR.adminSearch(db, { receiptNo: db._docs.get('transactionReceipts/service_booking_bkQ').receiptNo });
  ck('A1 admin search by paymentRef / receiptNo → header + immutable events; empty query refused',
    a.ok && a.receipts.length === 1 && a.receipts[0].events.length === 2 && b.receipts.length === 1 && (await TR.adminSearch(db, {})).ok === false);

  /* N1 — the REAL allocator (financial-engine._nextNumber) over a shared counter, two instances */
  const counters = fakeDb();
  let YEAR = 2026;
  const RealDate = Date;
  const loadFE = () => {
    const orig = Module.prototype.require;
    Module.prototype.require = function (id) {
      if (id === 'firebase-admin') return { firestore: Object.assign(() => counters, { FieldValue: { serverTimestamp: () => 'TS', increment: (n) => n } }) };
      if (id === 'firebase-functions/logger') return { info () {}, warn () {}, error () {} };
      if (id === './payment-timeline') return { mark () {}, fail () {} };
      return orig.apply(this, arguments);
    };
    const p = path.join(FN, 'financial-engine.js'); delete require.cache[require.resolve(p)];
    const m = require(p); Module.prototype.require = orig; return m;
  };
  global.Date = class extends RealDate { getUTCFullYear () { return YEAR; } };
  const i1 = loadFE(), i2 = loadFE();
  const nums = await Promise.all(Array.from({ length: 120 }, (_, k) => (k % 2 ? i1 : i2)._nextNumber('RCT')));
  const uniq = new Set(nums).size === nums.length;
  YEAR = 2027;
  const n27 = await i1._nextNumber('RCT');
  global.Date = RealDate;
  ck('N1 120 concurrent allocations over two instances → all unique, correct format; the new year restarts at 000001',
    uniq && nums.every((x) => /^SKN-RCT-2026-\d{6}$/.test(x)) && n27 === 'SKN-RCT-2027-000001', { dup: nums.length - new Set(nums).size, n27 });

  /* C1 — reconciliation (every receipt here cites a CONFIRMED payment and carries matching events unless the row is about that) */
  db = fakeDb();
  const put = (k, v) => db._docs.set(k, v);
  const okPay = (ref) => put('payments/' + ref, { status: 'COMPLETE' });
  const rcpt = (id, v, events) => { put('transactionReceipts/service_booking_' + id, Object.assign({ kind: 'service_booking', sourceId: id, paymentRef: 'P_' + id, refundedCents: 0, releasedCents: 0, heldCents: 0 }, v)); okPay('P_' + id);
    (events || [['paid', v.paidCents]]).forEach(([t, a], i) => put('transactionReceipts/service_booking_' + id + '/events/' + t + '_' + i, { type: t, amountCents: a })); };
  put('providerBookings/b1', { paymentStatus: 'paid_held', heldAmount: 300000 });                                                   /* no receipt */
  put('providerBookings/b2', { paymentStatus: 'paid_held', heldAmount: 300000 });
  rcpt('b2', { paidCents: 250000, heldCents: 250000 });                                                                              /* paid mismatch */
  put('providerBookings/b3', { paymentStatus: 'settled', heldAmount: 300000 });
  rcpt('b3', { paidCents: 300000, heldCents: 300000, providerNetCents: 0 });                                                         /* settled, nothing released */
  put('providerPayouts/b3', { settlementCents: 285000 });
  put('providerBookings/b4', { paymentStatus: 'refunded', heldAmount: 300000, refundedCents: 300000 });
  rcpt('b4', { paidCents: 300000, heldCents: 300000 });                                                                              /* refund mismatch */
  rcpt('gone', { paidCents: 100, heldCents: 100 });                                                                                  /* orphan */
  put('providerBookings/b5', { paymentStatus: 'settled', heldAmount: 300000 });
  rcpt('b5', { paidCents: 300000, releasedCents: 300000, providerNetCents: 285000 }, [['paid', 300000], ['released', 300000]]);      /* CLEAN */
  put('providerPayouts/b5', { settlementCents: 285000 });
  const snapBefore = JSON.stringify([...db._docs].filter(([k]) => !k.startsWith('receiptReconciliationExceptions/')));
  let t0 = new Date('2026-10-03T00:00:00Z');
  out = await RR.reconcileServiceBookings(db, { now: () => t0 });
  const ex = (k) => db._docs.get('receiptReconciliationExceptions/' + k);
  const exKeys = () => [...db._docs.keys()].filter((k) => k.startsWith('receiptReconciliationExceptions/')).map((k) => k.split('/')[1]);
  ck('C1a exceptions: missing_receipt b1, paid_mismatch b2, release_missing + provider_share_mismatch b3, refund_mismatch b4, orphan_receipt gone; clean b5 has none',
    ex('missing_receipt_b1') && ex('paid_mismatch_b2') && ex('release_missing_b3') && ex('provider_share_mismatch_b3') && ex('refund_mismatch_b4') && ex('orphan_receipt_gone')
    && !exKeys().some((k) => k.endsWith('_b5')), exKeys());
  ck('C1b nothing was corrected (bookings / receipts / payouts / payments unchanged)', JSON.stringify([...db._docs].filter(([k]) => !k.startsWith('receiptReconciliationExceptions/'))) === snapBefore);
  t0 = new Date('2026-10-04T00:00:00Z');
  await RR.reconcileServiceBookings(db, { now: () => t0 });
  ck('C1c a recurring exception stays ONE doc, keeps firstSeenAt, updates lastSeenAt',
    JSON.stringify(ex('missing_receipt_b1').firstSeenAt) === JSON.stringify(new Date('2026-10-03T00:00:00Z')) && JSON.stringify(ex('missing_receipt_b1').lastSeenAt) === JSON.stringify(t0));

  /* C2 — the deliberate anomalies added to the daily check */
  db = fakeDb();
  const put2 = (k, v) => db._docs.set(k, v);
  put2('providerBookings/x1', { paymentStatus: 'paid_held', heldAmount: 300000 });
  put2('transactionReceipts/service_booking_x1', { kind: 'service_booking', sourceId: 'x1', paymentRef: 'P_NONE', paidCents: 300000, heldCents: 300000, refundedCents: 0, releasedCents: 0 });
  put2('transactionReceipts/service_booking_x1/events/paid_0', { type: 'paid', amountCents: 300000 });
  put2('providerBookings/x2', { paymentStatus: 'paid_held', heldAmount: 300000 });
  put2('providerBookings/x3', { paymentStatus: 'paid_held', heldAmount: 300000 });
  put2('payments/P_DUP', { status: 'COMPLETE' });
  for (const id of ['x2', 'x3']) {
    put2('transactionReceipts/service_booking_' + id, { kind: 'service_booking', sourceId: id, paymentRef: 'P_DUP', paidCents: 300000, heldCents: 300000, refundedCents: 0, releasedCents: 0 });
    put2('transactionReceipts/service_booking_' + id + '/events/paid_0', { type: 'paid', amountCents: 300000 });
  }
  put2('providerBookings/x4', { paymentStatus: 'settled', heldAmount: 300000 });
  put2('payments/P_X4', { status: 'COMPLETE' });
  put2('transactionReceipts/service_booking_x4', { kind: 'service_booking', sourceId: 'x4', paymentRef: 'P_X4', paidCents: 300000, heldCents: 0, releasedCents: 400000, providerNetCents: 0, refundedCents: 0 });
  put2('providerBookings/x5', { paymentStatus: 'refunded', heldAmount: 300000, refundedCents: 300000 });
  put2('payments/P_X5', { status: 'COMPLETE' });
  put2('transactionReceipts/service_booking_x5', { kind: 'service_booking', sourceId: 'x5', paymentRef: 'P_X5', paidCents: 300000, heldCents: 0, refundedCents: 300000, releasedCents: 0 });
  put2('transactionReceipts/service_booking_x5/events/paid_0', { type: 'paid', amountCents: 300000 });   /* refund never written to history */
  await RR.reconcileServiceBookings(db, { now: () => new Date('2026-10-05T00:00:00Z') });
  const ex2 = (k) => !!db._docs.get('receiptReconciliationExceptions/' + k);
  ck('C2 deliberate anomalies are detected: receipt_without_payment x1 · duplicate_payment_ref P_DUP · invalid_history + release_without_hold x4 · history_total_mismatch x5 (refund missing from history)',
    ex2('receipt_without_payment_x1') && ex2('duplicate_payment_ref_P_DUP') && ex2('invalid_history_x4') && ex2('release_without_hold_x4') && ex2('history_total_mismatch_x5'),
    [...db._docs.keys()].filter((k) => k.startsWith('receiptReconciliationExceptions/')));


  /* X1 */
  const FE = loadFE();
  const x = await FE.recordConfirmedPayment({ ref: 'R1', amountKES: 100 });
  ck('X1 the old Daraja recorder is RETIRED: refuses, writes nothing', x.ok === false && x.reason === 'retired' && ![...counters._docs.keys()].some((k) => k.startsWith('financialDocuments/')));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
