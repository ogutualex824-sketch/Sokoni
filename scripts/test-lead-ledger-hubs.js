#!/usr/bin/env node
'use strict';
/* Hub-aware lead ledger (b2b-leads.js) — owner 2026-10-03, via sokoni-f3
     H1  prices by hub + tier: b2b 200 (legacy b2b_leads override still wins), construction standard 200
     H2  QUALIFIED is server-only: a caller's tier 'qualified' is downgraded to standard (no amount-based classification)
     H3  an admin override of construction.standard applies; an invalid one is ignored; an unknown hub has NO price (refused)
     H4  ONE commercial event → ONE fee: a second leadClaimWrite for the same commercialEventId aborts the transaction
     H5  month end: a supplier with b2b + construction leads is billed each at its hub price; description names both hubs
     H6  leadFields stays backward compatible (no opts → the original b2b shape)
   NODE_PATH=<functions/node_modules> node scripts/test-lead-ledger-hubs.js */
const path = require('path');
const L = require(path.join(path.resolve(__dirname, '..'), 'functions', 'b2b-leads.js'));
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok || d === undefined ? '' : '  -> ' + JSON.stringify(d).slice(0, 220))); ok ? pass++ : fail++; };
function fakeDb (seed) {
  const docs = new Map(Object.entries(seed || {}));
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const snap = (p) => { const v = clone(docs.get(p)); return { id: p.split('/').pop(), exists: v !== undefined, data: () => v }; };
  const ref = (p) => ({ path: p, id: p.split('/').pop(), get: async () => snap(p), update: async (v) => docs.set(p, Object.assign({}, docs.get(p), clone(v))) });
  const q = (c, fl, lim) => ({ where: (f, op, v) => q(c, fl.concat([[f, v]]), lim), limit: (n) => q(c, fl, n), startAfter: () => q(c, fl, lim),
    get: async () => ({ docs: [...docs.keys()].filter((k) => k.startsWith(c + '/') && k.split('/').length === 2 && fl.every(([f, v]) => (docs.get(k) || {})[f] === v)).slice(0, lim || 1e9).map(snap) }) });
  return { _docs: docs, collection: (c) => Object.assign({ doc: (id) => ref(c + '/' + id) }, q(c, [])),
    async runTransaction (fn) {
      const w = [];
      const t = { get: async (r) => snap(r.path), create: (r, v) => w.push(() => { if (docs.has(r.path)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } docs.set(r.path, clone(v)); }),
        set: (r, v) => w.push(() => docs.set(r.path, clone(v))), update: (r, v) => w.push(() => docs.set(r.path, Object.assign({}, docs.get(r.path), clone(v)))) };
      const out = await fn(t); const before = new Map(docs);
      try { w.forEach((f) => f()); } catch (e) { docs.clear(); before.forEach((v, k) => docs.set(k, v)); throw e; }
      return out;
    } };
}

(async () => {
  let db = fakeDb({});
  const b = await L.leadPriceFor(db, 'b2b', 'standard'), cs = await L.leadPriceFor(db, 'construction', 'standard');
  ck('H1 b2b standard 200; construction standard 200', b.priceKES === 200 && cs.priceKES === 200 && cs.hub === 'construction');
  db = fakeDb({ 'revenueConfig/b2b_leads': { priceKES: 250 } });
  ck('H1b the original b2b override still governs b2b', (await L.leadPriceFor(db, 'b2b', 'standard')).priceKES === 250);
  const q = await L.leadPriceFor(fakeDb({}), 'construction', 'qualified');
  ck('H2 a caller-sent "qualified" is downgraded to standard (200) while server rules are off', q.tier === 'standard' && q.priceKES === 200 && L.QUALIFIED_RULES_ENABLED === false);
  db = fakeDb({ 'revenueConfig/lead_prices': { construction: { standard: 300 } } });
  const ov = await L.leadPriceFor(db, 'construction', 'standard');
  const bad = await L.leadPriceFor(fakeDb({ 'revenueConfig/lead_prices': { construction: { standard: -5 } } }), 'construction', 'standard');
  ck('H3 admin override applies (300); invalid override ignored (200); unknown hub → no price', ov.priceKES === 300 && ov.source === 'admin_override' && bad.priceKES === 200
    && (await L.leadPriceFor(fakeDb({}), 'jobs', 'standard')) === null);
  db = fakeDb({});
  await db.runTransaction(async (t) => { L.leadClaimWrite(t, db, { commercialEventId: 'evt_contact_123', hub: 'construction', leadId: 'r1__supA', supplierBusinessId: 'supA' }); });
  let second = null;
  try { await db.runTransaction(async (t) => { L.leadClaimWrite(t, db, { commercialEventId: 'evt_contact_123', hub: 'construction', leadId: 'r2__supA', supplierBusinessId: 'supA' }); }); } catch (e) { second = e.code; }
  ck('H4 one commercial event → one fee: the second claim (contactRequest → RFQ) aborts', second === 6 && [...db._docs.keys()].filter((k) => k.startsWith('leadClaims/')).length === 1);
  db = fakeDb({
    'b2bLeads/r1__supA': { supplierBusinessId: 'supA', supplierOwnerUid: 'uidA', month: '2026-10', hub: 'b2b' },
    'b2bLeads/r2__supA': { supplierBusinessId: 'supA', supplierOwnerUid: 'uidA', month: '2026-10', hub: 'construction' },
    'b2bLeads/r3__supA': { supplierBusinessId: 'supA', supplierOwnerUid: 'uidA', month: '2026-10', hub: 'construction', priceKES: 200 },
    'revenueConfig/lead_prices': { construction: { standard: 300 } },
  });
  const calls = [];
  await L.invoiceMonth(db, '2026-10', { issueInvoice: async (a) => { calls.push(a); return { invoiceId: 'INV' }; }, nowMs: () => Date.now() });
  ck('H5 mixed hubs: b2b 200 + construction 300 (unsnapshotted, hub price) + construction 200 (snapshot) = 700; description names both hubs',
    calls.length === 1 && calls[0].amount === 700 && /b2b/.test(calls[0].description) && /construction/.test(calls[0].description), calls[0]);
  const legacy = await L.leadFields(fakeDb({}));
  const hubbed = await L.leadFields(fakeDb({}), { hub: 'construction', tier: 'qualified' });
  ck('H6 leadFields: no opts → original {priceKES, priceSource}; with hub → hub/tier snapshot (tier standard)', legacy.priceKES === 200 && !('hub' in legacy)
    && hubbed.hub === 'construction' && hubbed.tier === 'standard' && hubbed.priceKES === 200);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
