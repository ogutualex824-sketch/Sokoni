#!/usr/bin/env node
'use strict';
/* ============================================================================
   B2B lead invoice RECOVERY — settlement deduction + Pay Now + overdue gate (owner 2026-10-03; contracts with f3 / 5b)
     I1  a successful issue opens the receivable (outstanding = net + 16% VAT, paid 0); a failed issue opens nothing
     D1  settlement 500,000 vs outstanding 696 → deduct 696, net 499,304, invoice paid, one claim; buyer untouched
     D2  partial: settlement 500 vs 696 → deduct 500, 196 stays open; oldest invoice first across two
     D3  RETRY of the same settlementId after commit → 0 more, SAME net (full and partial cases) — never a second cut
     D4  a Pay Now that commits BETWEEN discovery and the release txn → exactly ONE recovery (re-read in txn)
     D5  an invoice issued after discovery is not deducted this round (carries forward); paid-in-between is skipped
     P1  Pay Now applies oldest first; replay recovers nothing twice; surplus reported, never applied
     G1  overdue gate: issued > 2 days + outstanding → overdue (enforce:false); < 2 days / paid / never issued → not
     W1  wiring: purpose priced from the server balance; self-settling; webhook hook on the early intent read
   NODE_PATH=<functions/node_modules> node scripts/test-b2b-lead-recovery.js
   ============================================================================ */
const path = require('path'), fs = require('fs');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 260) : '')); } };

/* Snapshots are COPIES taken at read time (as Firestore's are), so stale data stays stale. */
function fakeDb (seed, hooks) {
  const docs = new Map(Object.entries(seed || {}));
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const snap = (p) => { const v = clone(docs.get(p)); return { id: p.split('/').pop(), exists: v !== undefined, data: () => v }; };
  const ref = (p) => ({ path: p, id: p.split('/').pop(), get: async () => snap(p),
    update: async (v) => docs.set(p, Object.assign({}, docs.get(p), v)), set: async (v) => docs.set(p, Object.assign({}, v)) });
  const query = (c, filters, lim) => ({
    where: (f, op, v) => query(c, filters.concat([[f, v]]), lim),
    limit: (n) => query(c, filters, n),
    startAfter: () => query(c, filters, lim),
    get: async () => {
      const rows = [...docs.keys()].filter((k) => k.startsWith(c + '/') && k.split('/').length === 2).sort()
        .filter((k) => filters.every(([f, v]) => (docs.get(k) || {})[f] === v)).slice(0, lim || 1e9);
      const out = { docs: rows.map(snap), size: rows.length };
      if (hooks && hooks.afterQuery) { const h = hooks.afterQuery; hooks.afterQuery = null; await h(docs); }   /* fires once, after discovery */
      return out;
    } });
  const db = { _docs: docs,
    collection: (c) => Object.assign({ doc: (id) => ref(c + '/' + id) }, query(c, [], 0)),
    async runTransaction (fn) {
      const w = [];
      const t = { get: async (r) => snap(r.path),
        create: (r, v) => w.push(() => { if (docs.has(r.path)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } docs.set(r.path, clone(v)); }),
        set: (r, v) => w.push(() => docs.set(r.path, clone(v))),
        update: (r, v) => w.push(() => docs.set(r.path, Object.assign({}, docs.get(r.path), clone(v)))) };
      const out = await fn(t); const before = new Map(docs);
      try { w.forEach((f) => f()); } catch (e) { docs.clear(); before.forEach((v, k) => docs.set(k, v)); throw e; }
      return out;
    } };
  return db;
}
const L = require(path.join(FN, 'b2b-leads.js'));
const DAY = 86400000, NOW = Date.parse('2026-11-05T09:00:00Z');
const inv = (key, uid, outKES, issuedAtMs, extra) => ({ ['b2bLeadMonths/' + key]: Object.assign({ billToUid: uid, status: 'issued', month: key.split('__')[1], outstandingKES: outKES, paidKES: 0, issuedAtMs, invoiceId: 'INV_' + key }, extra || {}) });
/* Errors come back as values so a row FAILS BY NAME (a crash is not a refusal). */
const deduct = (db, settlementId, settlementKES, uid) => db.runTransaction(async (t) => { const st = await L.prepareLeadDeduction(t, db, { settlementId, billToUid: uid || 'uidA', settlementKES }); return L.commitLeadDeduction(t, st); }).catch((e) => ({ error: e.code || e.message }));
const payNow = (db, ref, amountKES, uid) => db.runTransaction(async (t) => { const st = await L.preparePayment(t, db, { paymentRef: ref, billToUid: uid || 'uidA', amountKES }); return L.commitLeadRecovery(t, st); }).catch((e) => ({ error: e.code || e.message }));
const claims = (db) => [...db._docs.keys()].filter((k) => k.startsWith('b2bLeadRecoveries/') && !db._docs.get(k).header);
const headers = (db) => [...db._docs.keys()].filter((k) => k.startsWith('b2bLeadRecoveries/') && db._docs.get(k).header);

(async () => {
  /* I1 */
  let db = fakeDb({ 'b2bLeads/r1__supA': { rfqId: 'r1', supplierBusinessId: 'supA', supplierOwnerUid: 'uidA', month: '2026-10', priceKES: 200 },
    'b2bLeads/r2__supA': { rfqId: 'r2', supplierBusinessId: 'supA', supplierOwnerUid: 'uidA', month: '2026-10', priceKES: 200 },
    'b2bLeads/r3__supA': { rfqId: 'r3', supplierBusinessId: 'supA', supplierOwnerUid: 'uidA', month: '2026-10', priceKES: 200 },
    'b2bLeads/r1__supB': { rfqId: 'r1', supplierBusinessId: 'supB', supplierOwnerUid: 'uidB', month: '2026-10', priceKES: 200 } });
  await L.invoiceMonth(db, '2026-10', { issueInvoice: async (a) => { if (a.sellerUid === 'uidB') throw new Error('KRA down'); return { invoiceId: 'INV' }; }, nowMs: () => NOW });
  const mA = db._docs.get('b2bLeadMonths/supA__2026-10'), mB = db._docs.get('b2bLeadMonths/supB__2026-10');
  ck('I1 successful issue opens the receivable (600 net → outstanding 696, paid 0); a FAILED issue opens none',
    mA.status === 'issued' && mA.outstandingKES === 696 && mA.paidKES === 0 && mB.status === 'failed' && mB.outstandingKES === undefined, { mA, mB });

  /* D1 */
  db = fakeDb(Object.assign({}, inv('supA__2026-10', 'uidA', 696, NOW - 5 * DAY), { 'orders/O1': { buyerUid: 'buyer', total: 500000 } }));
  let r = await deduct(db, 'set1', 500000);
  const m1 = db._docs.get('b2bLeadMonths/supA__2026-10');
  ck('D1 settlement 500,000 vs 696 → deducted 696, net 499,304; invoice paid; one claim; buyer order untouched',
    r.deductedKES === 696 && r.netKES === 499304 && m1.status === 'paid' && m1.outstandingKES === 0 && m1.paidKES === 696 && claims(db).length === 1
    && JSON.stringify(db._docs.get('orders/O1')) === JSON.stringify({ buyerUid: 'buyer', total: 500000 }), r);

  /* D3 (full) */
  r = await deduct(db, 'set1', 500000);
  ck('D3a RETRY of the same settlement after commit → 0 more, SAME net 499,304 (replayed 696); still one claim',
    r.deductedKES === 0 && r.replayedKES === 696 && r.netKES === 499304 && claims(db).length === 1, r);

  /* D3c — f3's defect: a NEW invoice issued between the first commit and a retry of the same settlement */
  db = fakeDb(inv('supA__2026-09', 'uidA', 300, NOW - 40 * DAY));
  r = await deduct(db, 'setC', 1000);
  ck('D3c-1 run 1: settlement 1,000 vs 300 → deduct 300, net 700; one op header', r.deductedKES === 300 && r.netKES === 700 && headers(db).length === 1, r);
  db._docs.set('b2bLeadMonths/supA__2026-10', { billToUid: 'uidA', status: 'issued', month: '2026-10', outstandingKES: 500, paidKES: 0, issuedAtMs: NOW });
  r = await deduct(db, 'setC', 1000);
  ck('D3c-2 RETRY after a new 500 invoice → pure replay: 0 more, SAME net 700; the new invoice stays 500 open',
    r.deductedKES === 0 && r.netKES === 700 && r.replay === true && db._docs.get('b2bLeadMonths/supA__2026-10').outstandingKES === 500, r);
  db = fakeDb({});
  r = await deduct(db, 'setZ', 1000);
  ck('D3d run 1 with NOTHING outstanding still writes the op header (net 1,000)', r.deductedKES === 0 && r.netKES === 1000 && headers(db).length === 1, r);
  db._docs.set('b2bLeadMonths/supA__2026-10', { billToUid: 'uidA', status: 'issued', month: '2026-10', outstandingKES: 500, paidKES: 0, issuedAtMs: NOW });
  r = await deduct(db, 'setZ', 1000);
  ck('D3e RETRY of that zero-recovery settlement after a new invoice → 0, same net 1,000 (case B)', r.deductedKES === 0 && r.netKES === 1000 && db._docs.get('b2bLeadMonths/supA__2026-10').outstandingKES === 500, r);

  /* D2 */
  db = fakeDb(Object.assign({}, inv('supA__2026-09', 'uidA', 300, NOW - 40 * DAY), inv('supA__2026-10', 'uidA', 696, NOW - 5 * DAY)));
  r = await deduct(db, 'set2', 500);
  ck('D2 partial, oldest first: 500 → Sept 300 cleared, Oct 696 → 496 open; net 0',
    r.deductedKES === 500 && r.netKES === 0 && db._docs.get('b2bLeadMonths/supA__2026-09').status === 'paid'
    && db._docs.get('b2bLeadMonths/supA__2026-10').outstandingKES === 496 && db._docs.get('b2bLeadMonths/supA__2026-10').status === 'issued', r);
  r = await deduct(db, 'set2', 500);
  ck('D3b RETRY of a PARTIAL settlement → 0 more (the still-open invoice is NOT cut again), same net 0',
    r.deductedKES === 0 && r.replayedKES === 500 && r.netKES === 0 && db._docs.get('b2bLeadMonths/supA__2026-10').outstandingKES === 496, r);

  /* D4 — Pay Now lands between discovery and the release txn's reads */
  const hooks = {};
  db = fakeDb(inv('supA__2026-10', 'uidA', 696, NOW - 5 * DAY), hooks);
  hooks.afterQuery = async (docs) => {   /* simulate the Pay Now commit after discovery */
    docs.set('b2bLeadMonths/supA__2026-10', Object.assign({}, docs.get('b2bLeadMonths/supA__2026-10'), { outstandingKES: 0, paidKES: 696, status: 'paid' }));
    docs.set('b2bLeadRecoveries/leadpay_PAY9_supA__2026-10', { opKey: 'leadpay_PAY9', invoiceKey: 'supA__2026-10', amountKES: 696 });
  };
  r = await deduct(db, 'set4', 500000);
  ck('D4 a Pay Now committing between discovery and the release → the release re-reads 0 and deducts NOTHING (one recovery total)',
    r.deductedKES === 0 && r.netKES === 500000 && db._docs.get('b2bLeadMonths/supA__2026-10').paidKES === 696 && claims(db).length === 1, r);

  /* D5 */
  const h5 = {};
  db = fakeDb(inv('supA__2026-09', 'uidA', 300, NOW - 40 * DAY), h5);
  h5.afterQuery = async (docs) => { docs.set('b2bLeadMonths/supA__2026-10', { billToUid: 'uidA', status: 'issued', month: '2026-10', outstandingKES: 696, paidKES: 0, issuedAtMs: NOW }); };
  r = await deduct(db, 'set5', 500000);
  ck('D5 an invoice issued AFTER discovery is not deducted this round (carries forward, still 696 open)',
    r.deductedKES === 300 && db._docs.get('b2bLeadMonths/supA__2026-10').outstandingKES === 696, r);

  /* P1 */
  db = fakeDb(Object.assign({}, inv('supA__2026-09', 'uidA', 300, NOW - 40 * DAY), inv('supA__2026-10', 'uidA', 696, NOW - 5 * DAY)));
  const due = await L.payNowAmount(db, 'uidA');
  r = await payNow(db, 'PAY1', due.amountKES);
  ck('P1a Pay Now = every outstanding invoice (996), applied oldest first; both paid', due.amountKES === 996 && r.deductedKES === 996 && r.netKES === 0
    && db._docs.get('b2bLeadMonths/supA__2026-09').status === 'paid' && db._docs.get('b2bLeadMonths/supA__2026-10').status === 'paid', r);
  r = await payNow(db, 'PAY1', 996);
  ck('P1b a replayed payment recovers nothing twice (replayed 996)', r.deductedKES === 0 && r.replayedKES === 996 && claims(db).length === 2, r);
  db._docs.set('b2bLeadMonths/supA__2026-11', { billToUid: 'uidA', status: 'issued', month: '2026-11', outstandingKES: 400, paidKES: 0, issuedAtMs: NOW });
  r = await payNow(db, 'PAY1', 996);
  ck('P1e a REPLAYED webhook after a NEW invoice is issued recovers nothing more (the 400 stays open)', r.deductedKES === 0 && r.replay === true && db._docs.get('b2bLeadMonths/supA__2026-11').outstandingKES === 400, r);
  db = fakeDb(inv('supA__2026-10', 'uidA', 196, NOW - 5 * DAY));
  r = await payNow(db, 'PAY2', 696);
  ck('P1c a payment larger than the balance (deducted meanwhile) applies 196 and REPORTS the 500 surplus — never applied elsewhere', r.deductedKES === 196 && r.netKES === 500, r);
  ck('P1d another supplier\'s invoice is never touched', (await payNow(fakeDb(inv('supB__2026-10', 'uidB', 696, NOW)), 'PAY3', 696, 'uidA')).deductedKES === 0);

  /* G1 */
  db = fakeDb(Object.assign({}, inv('supA__2026-09', 'uidA', 300, NOW - 3 * DAY), inv('supA__2026-10', 'uidA', 696, NOW - 1 * DAY),
    inv('supA__2026-08', 'uidA', 0, NOW - 60 * DAY, { status: 'paid' }), { 'b2bLeadMonths/supA__2026-07': { billToUid: 'uidA', status: 'failed', month: '2026-07' } }));
  const g = await L.leadInvoiceGate(db, 'uidA', NOW);
  ck('G1 overdue only for the invoice issued > 2 days ago and unpaid (300); fresh / paid / never-issued are not; enforce:false',
    g.overdue === true && g.overdueKES === 300 && g.invoiceKeys.join() === 'supA__2026-09' && g.enforce === false && g.since === NOW - 3 * DAY + 2 * DAY, g);
  const g0 = await L.leadInvoiceGate(fakeDb(inv('supA__2026-10', 'uidA', 696, NOW - DAY)), 'uidA', NOW);
  ck('G1b nothing overdue → overdue:false', g0.overdue === false && g0.overdueKES === 0);

  /* W1 */
  const PP = fs.readFileSync(path.join(FN, 'payment-purposes.js'), 'utf8');
  const IX = fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
  const SS = require(path.join(FN, 'shared/self-settling-purposes.js'));
  ck('W1a purpose b2b_lead_invoice priced from the server balance (payNowAmount), never the request', /b2b_lead_invoice: \{[\s\S]{0,300}require\('\.\/b2b-leads'\)\.payNowAmount\(db\(\), uid\)/.test(PP) && /amountCents: Math\.round\(due\.amountKES \* 100\)/.test(PP));
  ck('W1b self-settling (never a seller credit)', SS.isSelfSettling('b2b_lead_invoice'));
  const hk = IX.indexOf("_fiSnap.data().resourceType === 'b2bLeadInvoice'"), selfExit = IX.indexOf('self-settling purpose — no generic commission');
  ck('W1c webhook applies it on the EXISTING early intent read through preparePayment/commitLeadRecovery, before the self-settling exit; surplus → b2bLeadOverpayments',
    hk > 0 && hk < selfExit && /_bl\.preparePayment\(t, db, \{ paymentRef: apiRef/.test(IX) && /b2bLeadOverpayments/.test(IX));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
