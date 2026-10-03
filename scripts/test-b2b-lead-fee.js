#!/usr/bin/env node
'use strict';
/* ============================================================================
   B2B lead fee + B2B order exemption (owner 2026-10-03, via sokoni-f3)
     L1  KES 200 default; Super Admin override applies; an invalid override is ignored
     L2  reads rfq.js's ledger (never writes it); snapshots honoured; unsnapshotted rows priced at invoice time + flagged;
         self-RFQ excluded; month is Africa/Nairobi
     L3  month end: one invoice per supplier, net KES, standard VAT EXCLUSIVE, fee type 'lead'; re-run issues nothing twice;
         engine failure → failed + pending → sweep issues it at the STORED total
     L4  the real VAT engine: 3 leads = 600 + 96 VAT = 696
     X1  a B2B order resolves to b2b_order 0%, fixed lane, floor-exempt, never the marketplace ladder
     X2  the REAL calculateCommission charges 0 on a B2B order even with seller + global revenueConfig overrides
     W1  wiring: exports, fee label, secrets bound, Super Admin guard + audit
   NODE_PATH=<functions/node_modules> node scripts/test-b2b-lead-fee.js
   ============================================================================ */
const path = require('path'), fs = require('fs'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 240) : '')); } };

const INC = Symbol('inc');
const inc = (n) => ({ [INC]: n });
function fakeDb (seed) {
  const docs = new Map(Object.entries(seed || {}));
  const apply = (c, p) => { const o = Object.assign({}, c || {}); for (const [k, v] of Object.entries(p)) o[k] = (v && v[INC] !== undefined) ? (Number(o[k]) || 0) + v[INC] : v; return o; };
  const snap = (p) => ({ id: p.split('/').pop(), exists: docs.has(p), data: () => docs.get(p) });
  const ref = (p) => ({ path: p, id: p.split('/').pop(), get: async () => snap(p),
    update: async (v) => { if (!docs.has(p)) throw new Error('NOT_FOUND ' + p); docs.set(p, apply(docs.get(p), v)); },
    set: async (v, o) => docs.set(p, apply(o && o.merge ? docs.get(p) : null, v)) });
  const query = (c, filters, lim, after) => ({
    where: (f, op, v) => query(c, filters.concat([[f, v]]), lim, after),
    limit: (n) => query(c, filters, n, after),
    startAfter: (d) => query(c, filters, lim, d),
    get: async () => {
      let rows = [...docs.keys()].filter((k) => k.startsWith(c + '/') && k.split('/').length === 2).sort()
        .filter((k) => filters.every(([f, v]) => docs.get(k)[f] === v));
      if (after) rows = rows.filter((k) => k.split('/')[1] > after.id);
      rows = rows.slice(0, lim || 1e9);
      return { docs: rows.map(snap), size: rows.length };
    } });
  return { _docs: docs,
    collection: (c) => Object.assign({ doc: (id) => ref(c + '/' + id) }, query(c, [], 0, null)),
    async runTransaction (fn) {
      const w = [];
      const t = { get: async (r) => snap(r.path),
        create: (r, v) => w.push(() => { if (docs.has(r.path)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } docs.set(r.path, apply(null, v)); }),
        set: (r, v, o) => w.push(() => docs.set(r.path, apply(o && o.merge ? docs.get(r.path) : null, v))),
        update: (r, v) => w.push(() => docs.set(r.path, apply(docs.get(r.path), v))) };
      const out = await fn(t); const before = new Map(docs);
      try { w.forEach((f) => f()); } catch (e) { docs.clear(); before.forEach((v, k) => docs.set(k, v)); throw e; }
      return out;
    } };
}

const L = require(path.join(FN, 'b2b-leads.js'));
const CC = require(path.join(FN, 'commission-config.js'));

(async () => {
  /* L1 */
  ck('L1a default lead price KES 200', (await L.leadPrice(fakeDb())).priceKES === 200);
  const ov = await L.leadPrice(fakeDb({ 'revenueConfig/b2b_leads': { priceKES: 250 } }));
  const bad = await L.leadPrice(fakeDb({ 'revenueConfig/b2b_leads': { priceKES: -1 } }));
  ck('L1b Super Admin override applies (250); invalid override ignored → 200, flagged', ov.priceKES === 250 && ov.source === 'admin_override' && bad.priceKES === 200 && bad.ignoredOverride === true);

  /* L2 — rows exactly as rfq.js (sokoni-f3 @ 38ab5a8) writes them; this module never writes a lead */
  const row = (rfq, sup, owner, buyer, extra) => Object.assign({ rfqId: rfq, supplierBusinessId: sup, supplierOwnerUid: owner, buyerBusinessId: buyer, month: '2026-10', source: 'rfq', consentAcceptsLeadsAt: 't', createdAt: 't' }, extra || {});
  const lf = await L.leadFields(fakeDb());
  ck('L2a leadFields (spread into the row by rfq.js) = the price at receipt: { priceKES 200, priceSource default }', lf.priceKES === 200 && lf.priceSource === 'default');
  const seed = {
    'b2bLeads/rfq1__supA': row('rfq1', 'supA', 'uidA', 'buyX', { priceKES: 200 }),
    'b2bLeads/rfq3__supA': row('rfq3', 'supA', 'uidA', 'buyY', { priceKES: 200 }),
    'b2bLeads/rfq4__supA': row('rfq4', 'supA', 'uidA', 'buyZ', { priceKES: 300 }),
    'b2bLeads/rfq3__supB': row('rfq3', 'supB', 'uidB', 'buyY'),
    'b2bLeads/rfq2__supA': row('rfq2', 'supA', 'uidA', 'supA', { priceKES: 200 }),
    'b2bLeads/rfq7__supA': Object.assign(row('rfq7', 'supA', 'uidA', 'buyX', { priceKES: 200 }), { month: '2026-09' }),
    'revenueConfig/b2b_leads': { priceKES: 250 },
  };
  const g = L.groupLeads(Object.values(seed).filter((r) => r.month === '2026-10'), 250);
  const gA = g.find((x) => x.supplierBusinessId === 'supA'), gB = g.find((x) => x.supplierBusinessId === 'supB');
  ck('L2b grouping: supA 3 leads = 200+200+300 (snapshots honoured; self-RFQ excluded); supB unsnapshotted row priced at the current 250 and FLAGGED; bill to supplierOwnerUid',
    gA.leadCount === 3 && gA.netKES === 700 && gA.unsnapshottedLeads === 0 && gA.billToUid === 'uidA' && gB.netKES === 250 && gB.unsnapshottedLeads === 1, g);
  ck('L2c month is Africa/Nairobi: 31 Oct 22:00Z → 2026-11; previous month of 1 Nov 04:00 EAT → 2026-10; Jan → Dec',
    L.monthOf(new Date('2026-10-31T22:00:00Z')) === '2026-11' && L.previousMonth(new Date('2026-11-01T01:00:00Z')) === '2026-10' && L.previousMonth(new Date('2027-01-01T04:00:00Z')) === '2026-12');
  ck('L2d this module writes NO lead row (one writer: rfq.js)', !/collection\(LEADS\)\.doc|t\.create\(leadRef/.test(fs.readFileSync(path.join(FN, 'b2b-leads.js'), 'utf8')));

  /* L3 */
  const db = fakeDb(seed);
  const calls = [];
  const issuer = async (a) => { calls.push(a); return { invoiceId: 'INV_' + a.reference, success: true }; };
  let out = await L.invoiceMonth(db, '2026-10', { issueInvoice: issuer });
  const a = calls.find((c) => c.reference === 'supA__2026-10');
  ck('L3a one invoice per supplier (2) from the 2026-10 ledger only; supA 700 net; fee type lead; standard VAT EXCLUSIVE; billed to the owner uid',
    out.issued === 2 && out.leads === 5 && calls.length === 2 && a && a.amount === 700 && a.feeType === 'lead' && a.taxCategory === 'standard' && a.vatInclusive === false && a.sellerUid === 'uidA', { out, calls });
  const mA = db._docs.get('b2bLeadMonths/supA__2026-10');
  ck('L3b month record: issued, invoice id, billed totals stored', mA.status === 'issued' && mA.invoiceId === 'INV_supA__2026-10' && mA.billedLeadCount === 3 && mA.billedNetKES === 700 && mA.invoicePending === false);
  out = await L.invoiceMonth(db, '2026-10', { issueInvoice: issuer });
  ck('L3c re-running month end issues nothing twice', calls.length === 2 && out.issued === 0 && out.skipped === 2);

  const db2 = fakeDb({ 'b2bLeads/rfqA__supC': row('rfqA', 'supC', 'uidC', 'b1', { priceKES: 200 }) });
  out = await L.invoiceMonth(db2, '2026-10', { issueInvoice: async () => { throw new Error('KRA down'); } });
  ck('L3e engine failure → failed + pending, nothing claimed as issued', out.failed === 1 && db2._docs.get('b2bLeadMonths/supC__2026-10').status === 'failed' && db2._docs.get('b2bLeadMonths/supC__2026-10').invoicePending === true);
  db2._docs.set('b2bLeads/rfqB__supC', row('rfqB', 'supC', 'uidC', 'b2', { priceKES: 200 }));
  const c2 = [];
  out = await L.sweepPending(db2, { issueInvoice: async (x) => { c2.push(x); return { invoiceId: 'INV2' }; } });
  ck('L3f the sweep issues the failed month once, at the STORED total (200) — never a recount', out.issued === 1 && c2.length === 1 && c2[0].amount === 200 && db2._docs.get('b2bLeadMonths/supC__2026-10').status === 'issued');
  const db3 = fakeDb({ 'b2bLeadMonths/supD__2026-10': { month: '2026-10', status: 'issuing', issuingSinceMs: Date.now(), leadCount: 1, netKES: 200, billToUid: 'u' } });
  let r = await L.invoiceSupplierMonth(db3, 'supD__2026-10', { issueInvoice: issuer });
  ck('L3g an in-flight claim is not issued twice', r.ok === false && r.reason === 'in_flight');
  r = await L.invoiceSupplierMonth(fakeDb(), 'supE__2026-10', { issueInvoice: issuer }, { month: '2026-10', supplierBusinessId: 'supE', billToUid: null, leadCount: 1, netKES: 200 });
  ck('L3h no supplier owner uid → refused, nothing invoiced', r.ok === false && r.reason === 'no_supplier_owner');

  /* L4 */
  const T = require(path.join(FN, 'etims-tax-engine.js'));
  const line = T.computeLine({ name: 'B2B Lead Fee', quantity: 1, unitPrice: 600, discountRate: 0, seq: 1 }, 'registered', { inclusive: false });
  const tot = T.computeTotals([line]);
  ck('L4 real VAT engine: 3 leads = KES 600 + 96 VAT (16%) = 696', tot.totTaxblAmt === 600 && tot.totTaxAmt === 96 && tot.totAmt === 696, tot);

  /* X1 */
  const rr = ['b2b', 'wholesale', 'b2b_order'].map((k) => CC.resolveRate(k));
  ck('X1 b2b / wholesale → b2b_order 0%, fixed lane, floor-exempt, NOT the marketplace ladder; product stays 15%',
    rr.every((x) => x.pct === 0 && x.fixedKES === 0 && x.category === 'b2b_order') && CC.isFixedRateCategory('b2b') && CC.isFloorExemptFixedCategory('b2b')
    && !CC.isMarketplaceSellerSale('b2b') && CC.resolveRate('product').pct === 15);

  /* X2 — the real engine, with overrides present that WOULD reprice a non-fixed category */
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'firebase-admin') return { firestore: Object.assign(() => ({}), { Timestamp: { now: () => ({ toMillis: () => Date.now() }) }, FieldValue: {} }) };
    return orig.apply(this, arguments);
  };
  const FU = require(path.join(FN, 'finos-utils.js'));
  Module.prototype.require = orig;
  const ovDocs = { 'revenueConfig/seller_SUP1': { commissionPct: 12 }, 'revenueConfig/global': { commissionPct: 9 }, 'revenueConfig/hub_b2b_order': { commissionPct: 7 } };
  const cdb = { collection: (name) => ({
    doc: (id) => ({ async get () { const d = ovDocs[name + '/' + id]; return d ? { exists: true, id, data: () => d } : { exists: false, id, data: () => undefined }; } }),
    where () { return this; },
    async get () { return { empty: true, docs: [], forEach () {} }; } }) };
  const c = await FU.calculateCommission(cdb, { orderAmountCents: 50000000, category: 'b2b', sellerId: 'SUP1' });
  const ctl = await FU.calculateCommission(cdb, { orderAmountCents: 1000000, category: 'services', sellerId: 'SUP1' });
  ck('X2 real calculateCommission: KES 500,000 B2B order → 0 commission (no floor), despite seller/global overrides',
    c.commissionCents === 0, { commissionCents: c.commissionCents, rate: c.effectiveRate, src: c.pricingSource });
  ck('X2c control: the same overrides DO reprice a non-fixed category (proves the fixture is live)', ctl.commissionCents !== 50000, { commissionCents: ctl.commissionCents });

  /* W1 */
  const IX = fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
  const ET = fs.readFileSync(path.join(FN, 'etims.js'), 'utf8');
  const SRC = fs.readFileSync(path.join(FN, 'b2b-leads.js'), 'utf8');
  ck('W1a index exports the four functions by name', ['b2bLeadMonthlyInvoices', 'b2bLeadInvoiceSweep', 'b2bLeadPrice', 'adminSetB2bLeadPrice'].every((n) => new RegExp('exports\\.' + n + '\\s*=\\s*_b2bLeads\\.' + n).test(IX)));
  ck('W1b the one invoice engine knows fee type lead; secrets exported for scheduled callers', /lead:"B2B Lead Fee"/.test(ET) && /^\s*_ALL_SECRETS,/m.test(ET));
  ck('W1c Super Admin only + audited; schedulers bind the eTIMS secrets', /tk\.superAdmin !== true/.test(SRC) && /adminAudit/.test(SRC) && (SRC.match(/secrets: _secrets\(\)/g) || []).length === 2);
  const RT = fs.readFileSync(path.join(FN, 'finos-router.js'), 'utf8');
  ck('W1d finos-router maps hub b2b → b2b_order (was marketplace)', /b2b: 'b2b_order'/.test(RT) && !/b2b: 'marketplace'/.test(RT));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
