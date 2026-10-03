#!/usr/bin/env node
'use strict';
/* ============================================================================
   Platform-wide transaction receipts (owner 2026-10-03, via sokoni-b2)
     R1  verified payment → ONE receipt (SKN-RCT number), every owner field present; held = paid; status paid_held
     R2  replayed webhook → same receipt, no second number, no second 'paid' event
     R3  PIN release → event 'released' with SOKONI fee + provider net; held 0, released = paid; status released;
         a retried release changes nothing
     R4  refund before release → refunded, held 0; refund after release → refunded (position never negative);
         refund > paid refused; a repeated refund changes nothing
     R5  milestones later: two partial releases with milestoneIds → partially_released then released, no reshaping
     R6  no VAT computed: taxTreatment recorded as given, unknown values → 'unknown'; method null when not reported
     R7  bad input refused (unknown kind, no ref, zero amount); release > held refused
     R8  receiptsFor: client sees theirs as 'client', provider as 'provider'; a stranger sees none
     R9  safely(): a throwing writer is queued to transactionReceiptFailures and never throws into the money path
   NODE_PATH=<functions/node_modules> node scripts/test-transaction-receipts.js
   ============================================================================ */
const path = require('path');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 240) : '')); } };

function fakeDb () {
  const docs = new Map(); let auto = 0;
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const snap = (p) => { const v = clone(docs.get(p)); return { id: p.split('/').pop(), exists: v !== undefined, data: () => v }; };
  const ref = (p) => ({ path: p, id: p.split('/').pop(), get: async () => snap(p), collection: (c) => coll(p + '/' + c) });
  const coll = (c) => ({ doc: (id) => ref(c + '/' + id), add: async (v) => { const id = 'a' + (++auto); docs.set(c + '/' + id, clone(v)); return { id }; },
    where: (f, op, v) => q(c, [[f, v]]), limit: () => q(c, []), get: () => q(c, []).get() });
  const q = (c, filters) => ({ where: (f, op, v) => q(c, filters.concat([[f, v]])), limit: () => q(c, filters),
    get: async () => { const rows = [...docs.keys()].filter((k) => k.startsWith(c + '/') && k.split('/').length === c.split('/').length + 1 && filters.every(([f, v]) => (docs.get(k) || {})[f] === v)); return { docs: rows.map(snap) }; } });
  return { _docs: docs, collection: coll,
    async runTransaction (fn) {
      const w = [];
      const t = { get: async (r) => snap(r.path),
        create: (r, v) => w.push(() => { if (docs.has(r.path)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } docs.set(r.path, clone(v)); }),
        update: (r, v) => w.push(() => docs.set(r.path, Object.assign({}, docs.get(r.path), clone(v)))) };
      const out = await fn(t); const before = new Map(docs);
      try { w.forEach((f) => f()); } catch (e) { docs.clear(); before.forEach((v, k) => docs.set(k, v)); throw e; }
      return out;
    } };
}
const TR = require(path.join(FN, 'transaction-receipts.js'));
let SEQ = 0;
const deps = { nextNumber: async (k) => 'SKN-' + k + '-2026-' + String(++SEQ).padStart(6, '0'), serverTs: () => '2026-10-03T10:00:00Z' };
const paid = (over) => Object.assign({ kind: 'service_booking', sourceId: 'bk1', clientUid: 'buyer1', counterpartyId: 'adv1', counterpartyName: 'Wakili & Co',
  serviceLabel: 'Legal consultation', quotedCents: 300000, paidCents: 300000, paymentRef: 'API_1', providerRef: 'INV_X', method: 'M-PESA',
  taxTreatment: 'provider_fiscal_invoice' }, over || {});
const events = (db, id) => [...db._docs.keys()].filter((k) => k.startsWith('transactionReceipts/' + id + '/events/'));

(async () => {
  let db = fakeDb();
  let r = await TR.recordPaid(db, paid(), deps);
  let rc = db._docs.get('transactionReceipts/service_booking_bk1');
  const FIELDS = ['receiptNo', 'kind', 'sourceId', 'clientUid', 'counterpartyId', 'counterpartyName', 'serviceLabel', 'quotedCents', 'taxTreatment',
    'platformFeeCents', 'heldCents', 'releasedCents', 'paymentRef', 'method', 'status', 'confirmation', 'issuedAt', 'updatedAt', 'refundedCents'];
  ck('R1 verified payment → one receipt SKN-RCT-2026-000001 with every owner field; held = paid; status paid_held',
    r.ok && rc.receiptNo === 'SKN-RCT-2026-000001' && FIELDS.every((f) => f in rc) && rc.heldCents === 300000 && rc.status === 'paid_held' && events(db, 'service_booking_bk1').length === 1, rc);
  r = await TR.recordPaid(db, paid(), deps);
  ck('R2 replayed webhook → same receipt, no new number, still one event', r.replay === true && r.receiptNo === 'SKN-RCT-2026-000001' && SEQ === 1 && events(db, 'service_booking_bk1').length === 1, r);

  r = await TR.recordEvent(db, 'service_booking_bk1', { type: 'released', amountCents: 300000, platformFeeCents: 15000, providerNetCents: 285000, opKey: 'bk1' }, deps);
  rc = db._docs.get('transactionReceipts/service_booking_bk1');
  ck('R3a PIN release → released event with SOKONI fee 150 + provider net 2,850; held 0, released 3,000; status released',
    r.ok && rc.heldCents === 0 && rc.releasedCents === 300000 && rc.platformFeeCents === 15000 && rc.providerNetCents === 285000 && rc.status === 'released', rc);
  r = await TR.recordEvent(db, 'service_booking_bk1', { type: 'released', amountCents: 300000, platformFeeCents: 15000, providerNetCents: 285000, opKey: 'bk1' }, deps);
  ck('R3b a retried release changes nothing', r.replay === true && db._docs.get('transactionReceipts/service_booking_bk1').releasedCents === 300000 && events(db, 'service_booking_bk1').length === 2);

  db = fakeDb();
  await TR.recordPaid(db, paid({ sourceId: 'bk2', paymentRef: 'API_2' }), deps);
  r = await TR.recordEvent(db, 'service_booking_bk2', { type: 'refunded', amountCents: 300000, opKey: 'rf1', reason: 'provider cancelled' }, deps);
  rc = db._docs.get('transactionReceipts/service_booking_bk2');
  ck('R4a refund before release → refunded 3,000, held 0, status refunded', r.ok && rc.refundedCents === 300000 && rc.heldCents === 0 && rc.status === 'refunded', rc);
  r = await TR.recordEvent(db, 'service_booking_bk2', { type: 'refunded', amountCents: 300000, opKey: 'rf1' }, deps);
  ck('R4b a repeated refund changes nothing', r.replay === true && db._docs.get('transactionReceipts/service_booking_bk2').refundedCents === 300000);
  r = await TR.recordEvent(db, 'service_booking_bk2', { type: 'refunded', amountCents: 1, opKey: 'rf2' }, deps);
  ck('R4c refund beyond what was paid is refused', r.ok === false && r.reason === 'refund_exceeds_paid');
  db = fakeDb();
  await TR.recordPaid(db, paid({ sourceId: 'bk3', paymentRef: 'API_3' }), deps);
  await TR.recordEvent(db, 'service_booking_bk3', { type: 'released', amountCents: 300000, platformFeeCents: 15000, providerNetCents: 285000, opKey: 'bk3' }, deps);
  r = await TR.recordEvent(db, 'service_booking_bk3', { type: 'refunded', amountCents: 300000, opKey: 'rfa', reason: 'refund after settlement' }, deps);
  rc = db._docs.get('transactionReceipts/service_booking_bk3');
  ck('R4d refund after release → refunded, held never negative', r.ok && rc.heldCents === 0 && rc.refundedCents === 300000 && rc.status === 'refunded', rc);

  db = fakeDb();
  await TR.recordPaid(db, paid({ kind: 'quote', sourceId: 'q1', paymentRef: 'API_Q', paidCents: 1000000, quotedCents: 1000000 }), deps);
  await TR.recordEvent(db, 'quote_q1', { type: 'released', amountCents: 400000, platformFeeCents: 20000, providerNetCents: 380000, opKey: 'm1', milestoneId: 'm1' }, deps);
  const mid = db._docs.get('transactionReceipts/quote_q1').status;
  await TR.recordEvent(db, 'quote_q1', { type: 'released', amountCents: 600000, platformFeeCents: 30000, providerNetCents: 570000, opKey: 'm2', milestoneId: 'm2' }, deps);
  rc = db._docs.get('transactionReceipts/quote_q1');
  ck('R5 milestones need no reshaping: two releases with milestoneIds → partially_released then released (fee 500 total)',
    mid === 'partially_released' && rc.status === 'released' && rc.platformFeeCents === 50000 && db._docs.get('transactionReceipts/quote_q1/events/released_m1').milestoneId === 'm1', rc);

  db = fakeDb();
  await TR.recordPaid(db, paid({ sourceId: 'bk6', paymentRef: 'API_6', taxTreatment: 'vat_16_inclusive', method: undefined }), deps);
  rc = db._docs.get('transactionReceipts/service_booking_bk6');
  ck('R6 no VAT is computed: an unknown taxTreatment is stored as "unknown"; method null when IntaSend did not report one; no vat field',
    rc.taxTreatment === 'unknown' && rc.method === null && !Object.keys(rc).some((k) => /vat/i.test(k)), rc);

  const bad = await Promise.all([TR.recordPaid(db, paid({ kind: 'tip' }), deps), TR.recordPaid(db, paid({ paymentRef: '' }), deps), TR.recordPaid(db, paid({ paidCents: 0 }), deps)]);
  r = await TR.recordEvent(db, 'service_booking_bk6', { type: 'released', amountCents: 999999999, opKey: 'x' }, deps);
  ck('R7 bad input refused (kind / ref / amount); a release larger than held refused', bad.every((b) => b.ok === false) && r.ok === false && r.reason === 'release_exceeds_held');

  const mine = await TR.receiptsFor(db, 'buyer1');
  const prov = await TR.receiptsFor(db, 'adv1');
  const none = await TR.receiptsFor(db, 'stranger');
  ck('R8 receiptsFor: client role for the buyer, provider role for the advocate, nothing for a stranger',
    mine.length === 1 && mine[0].role === 'client' && prov.length === 1 && prov[0].role === 'provider' && none.length === 0);
  ck('R8b HISTORY: the caller\'s receipts carry their own events (projection: type, amount, at), nothing for a stranger',
    Array.isArray(mine[0].events) && mine[0].events.length === 1 && mine[0].events[0].type === 'paid' && mine[0].events[0].amountCents === 300000
    && !('opKey' in mine[0].events[0]) && prov[0].events.length === 1, mine[0].events);

  r = await TR.safely(db, 'paid:bkX', async () => { throw new Error('boom'); });
  ck('R9 safely(): a failing writer is queued (transactionReceiptFailures) and does not throw', r.ok === false && [...db._docs.keys()].some((k) => k.startsWith('transactionReceiptFailures/')));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
