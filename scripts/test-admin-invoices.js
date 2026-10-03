#!/usr/bin/env node
/**
 * test-admin-invoices.js — adminInvoicesList (owner 2026-10-04: admin Invoices page, merchant invoices only).
 * The REAL handler on a fake Firestore with where / orderBy / startAfter / limit / aggregate(count,sum) / getAll,
 * including a switch that makes composite-index queries fail (as production does before the index deploys).
 *   I1  admin / superAdmin only; anonymous + ordinary users refused
 *   I2  display status is server-derived: sent + past due → overdue (days), sent + future → open (days left)
 *   I3  balance due is a fact of the status (paid / void → 0); client paymentRef is reported as presence only
 *   I4  summary figures are DATABASE aggregates over the WHOLE collection, not the page
 *   I5  aging buckets partition the open money; undated open money is reported, never dropped
 *   I6  a missing index → that figure is null with reason 'index_missing' (never 0), the rest still compute
 *   I7  pagination: an opaque cursor, no overlap, ends with null; a forged cursor is refused
 *   I8  tabs filter correctly (overdue = sent past due, ordered by due date)
 *   I9  only the `invoices` store is read (no other invoice collection)
 *   I10 read-only: the store is identical after the call
 *   SABOTAGE=1 → a failed aggregate reports 0 instead of null → I6 must FAIL
 */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), Module = require('module');
const FN = path.join(__dirname, '..', 'functions');
let pass = 0, fail = 0;
const ck = (id, ok, m, d) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (ok || d === undefined ? '' : '   [' + JSON.stringify(d).slice(0, 240) + ']')); ok ? pass++ : fail++; };

const NOW = Date.UTC(2026, 9, 4, 9, 0, 0); const DAY = 864e5;
class TS { constructor(ms) { this.ms = ms; } toMillis() { return this.ms; } static fromMillis(ms) { return new TS(ms); } }
const store = {}; const readCols = new Set(); let INDEX_OK = true;
const val = (v) => (v instanceof TS ? v.ms : v);
function query(col, filters = [], orders = [], lim = null, after = null) {
  const q = {
    where: (f, op, v) => query(col, filters.concat([[f, op, v]]), orders, lim, after),
    orderBy: (f, d) => query(col, filters, orders.concat([[f, d || 'asc']]), lim, after),
    limit: (n) => query(col, filters, orders, n, after),
    startAfter: (...vals) => query(col, filters, orders, lim, vals),
    _run() {
      readCols.add(col);
      const fieldsUsed = new Set(filters.map((f) => f[0]).concat(orders.map((o) => o[0]).filter((f) => f !== '__name__')));
      if (!INDEX_OK && fieldsUsed.size > 1) throw new Error('FAILED_PRECONDITION: The query requires an index.');
      let ds = Object.keys(store).filter((p) => p.startsWith(col + '/')).map((p) => ({ id: p.split('/')[1], data: () => Object.assign({}, store[p]), _raw: store[p]   /* shallow copy keeps Timestamp instances, like the SDK */ }));
      for (const [f, op, v] of filters) ds = ds.filter((d) => { const x = val(d._raw[f]), y = val(v);
        if (op === '==') return x === y; if (op === 'in') return y.includes(x); if (x === undefined || x === null) return false;
        if (op === '<') return x < y; if (op === '>=') return x >= y; return false; });
      ds.sort((a, b) => { for (const [f, d] of orders) { const x = f === '__name__' ? a.id : val(a._raw[f]), y = f === '__name__' ? b.id : val(b._raw[f]); if (x < y) return d === 'desc' ? 1 : -1; if (x > y) return d === 'desc' ? -1 : 1; } return 0; });
      if (after) { const key = (d) => orders.map(([f]) => (f === '__name__' ? d.id : val(d._raw[f]))); const av = after.map(val);
        const idx = ds.findIndex((d) => JSON.stringify(key(d)) === JSON.stringify(av)); ds = idx >= 0 ? ds.slice(idx + 1) : ds; }
      if (lim != null) ds = ds.slice(0, lim);
      return ds;
    },
    get: async () => { const docs = q._run(); return { docs, size: docs.length }; },
    aggregate: (spec) => ({ get: async () => { const docs = q._run(); const out = {};
      for (const [k, s] of Object.entries(spec)) out[k] = s.t === 'count' ? docs.length : docs.reduce((a, d) => a + (Number(d._raw[s.f]) || 0), 0);
      return { data: () => out }; } }),
    doc: (id) => ({ _p: col + '/' + id, id }),
  };
  return q;
}
const db = { collection: (c) => query(c), getAll: async (...refs) => refs.map((r) => ({ id: r.id, exists: r._p in store, data: () => store[r._p] })) };
const AggregateField = { count: () => ({ t: 'count' }), sum: (f) => ({ t: 'sum', f }) };
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
const _load = Module._load;
Module._load = function (req) {
  if (req === 'firebase-functions/v2/https') return { onCall: (o, h) => h, HttpsError };
  if (req === 'firebase-admin/firestore') return { getFirestore: () => db, AggregateField, Timestamp: TS };
  return _load.apply(this, arguments);
};
let src = fs.readFileSync(path.join(FN, 'admin-invoices.js'), 'utf8');
if (process.env.SABOTAGE === '1') src = src.replace('    out[label] = null;\n', '    out[label] = { n: 0, sum: 0 };\n');
const tmp = path.join(os.tmpdir(), 'admin-invoices-under-test-' + process.pid + '.js'); fs.writeFileSync(tmp, src);
const M = require(tmp); fs.unlinkSync(tmp);
const I = M._internal; I._setClock(() => NOW);
const iso = (d) => new Date(NOW + d * DAY).toISOString();
const seed = (id, x) => { store['invoices/' + id] = Object.assign({ shopId: 'shopA', invoiceNumber: 'INV-' + id, clientName: 'Client ' + id, total: 100, currency: 'KES', items: [{ description: 'x', quantity: 1, unitPrice: 100, total: 100 }] }, x); };
const admin = (data) => ({ auth: { uid: 'adm', token: { admin: true } }, data: data || {} });
const call = async (r) => { try { return await I.list(r); } catch (e) { return { err: e.code || e.message, reason: e.details && e.details.reason }; } };

(async () => {
  console.log('\nadminInvoicesList' + (process.env.SABOTAGE === '1' ? '  (SABOTAGE)' : '') + '\n');
  store['shops/shopA'] = { name: 'Duka A' };
  seed('d1', { status: 'draft', createdAt: TS.fromMillis(NOW - 1 * DAY), total: 50 });
  seed('o1', { status: 'sent', dueDate: iso(+11), createdAt: TS.fromMillis(NOW - 2 * DAY), total: 9721 });      /* current */
  seed('v1', { status: 'sent', dueDate: iso(-15), createdAt: TS.fromMillis(NOW - 30 * DAY), total: 12842 });    /* 15 days overdue */
  seed('v2', { status: 'sent', dueDate: iso(-45), createdAt: TS.fromMillis(NOW - 60 * DAY), total: 1000 });     /* 31-60 */
  seed('v3', { status: 'sent', dueDate: iso(-75), createdAt: TS.fromMillis(NOW - 90 * DAY), total: 300 });      /* 61-90 */
  seed('v4', { status: 'sent', dueDate: iso(-120), createdAt: TS.fromMillis(NOW - 150 * DAY), total: 70 });     /* 91+ */
  seed('u1', { status: 'sent', dueDate: null, createdAt: TS.fromMillis(NOW - 3 * DAY), total: 5 });             /* undated open */
  seed('p1', { status: 'paid', paidAt: TS.fromMillis(NOW - 5 * DAY), paymentRef: 'client-typed', paymentMethod: 'mpesa', createdAt: TS.fromMillis(NOW - 6 * DAY), total: 8645 });
  seed('p2', { status: 'paid', paidAt: TS.fromMillis(NOW - 50 * DAY), createdAt: TS.fromMillis(NOW - 55 * DAY), total: 4987 });
  seed('x1', { status: 'void', createdAt: TS.fromMillis(NOW - 7 * DAY), total: 2850 });
  store['etimsInvoices/e1'] = { status: 'sent', total: 999999 };
  const before = JSON.stringify(store);

  let r = await call({ auth: null, data: {} });
  const r2 = await call({ auth: { uid: 'u', token: {} }, data: {} });
  const r3 = await call({ auth: { uid: 's', token: { superAdmin: true } }, data: { limit: 2 } });
  ck('I1', r.err === 'unauthenticated' && r2.err === 'permission-denied' && Array.isArray(r3.invoices), 'anonymous / ordinary refused; superAdmin allowed', { r, r2 });

  r = await call(admin({ limit: 100 }));
  const by = (id) => r.invoices.find((x) => x.id === id) || {};
  ck('I2', by('v1').display === 'overdue' && by('v1').daysOverdue === 15 && by('o1').display === 'open' && by('o1').daysLeft === 11 && by('u1').display === 'open' && by('u1').daysLeft === null, 'sent+past due → overdue (15 days); sent+future → open (11 days left); no due date → open, days unknown', { v1: by('v1'), o1: by('o1') });
  ck('I3', by('p1').balanceDue === 0 && by('x1').balanceDue === 0 && by('v1').balanceDue === 12842 && by('p1').paymentReferenced === true && !('paymentRef' in by('p1')) && by('o1').shopName === 'Duka A', 'paid/void owe 0; a client paymentRef is presence-only; shop name joined', by('p1'));

  const s = r.summary;
  ck('I4', s.counts.all === 10 && s.counts.open === 6 && s.counts.overdue === 4 && s.counts.paid === 2 && s.counts.void === 1 && s.counts.draft === 1 && s.openAmount === 9721 + 12842 + 1000 + 300 + 70 + 5 && s.totalInvoiced === 9721 + 12842 + 1000 + 300 + 70 + 5 + 8645 + 4987 && s.paidLast30Days === 8645 && s.overdueAmount === 12842 + 1000 + 300 + 70, 'counts and sums are database aggregates over the WHOLE collection', s);
  ck('I5', s.aging.current === 9721 && s.aging.d1_30 === 12842 && s.aging.d31_60 === 1000 && s.aging.d61_90 === 300 && s.aging.d91plus === 70 && s.aging.undated === 5, 'aging buckets partition the open money; undated open money is reported (5), never dropped', s.aging);
  ck('I9', !readCols.has('etimsInvoices') && s.totalInvoiced < 999999, 'only the `invoices` store is read');

  r = await call(admin({ tab: 'overdue', limit: 100 }));
  ck('I8', r.invoices.map((x) => x.id).join(',') === 'v4,v3,v2,v1' && r.invoices.every((x) => x.display === 'overdue'), 'overdue tab = sent past due, oldest due first', r.invoices.map((x) => x.id));
  r = await call(admin({ tab: 'paid', limit: 100 }));
  ck('I8b', r.invoices.map((x) => x.id).sort().join(',') === 'p1,p2', 'paid tab', r.invoices.map((x) => x.id));

  const seen = []; let cur = undefined, pages = 0;
  do { const p = await call(admin({ limit: 3, cursor: cur, withSummary: false })); pages++; p.invoices.forEach((x) => seen.push(x.id)); cur = p.cursor; if (pages > 10) break; } while (cur);
  ck('I7', seen.length === 10 && new Set(seen).size === 10 && pages === 4, 'pagination: 10 invoices over 4 pages of 3, no overlap, ends with a null cursor', { seen, pages });
  r = await call(admin({ cursor: 'not-base64-json!!' }));
  ck('I7b', r.err === 'invalid-argument', 'a forged cursor is refused', r);

  INDEX_OK = false;
  r = await call(admin({ limit: 5 }));
  ck('I6', r.summary && r.summary.counts.all === 10 && r.summary.overdueAmount === null && r.summary.unavailable.overdue === 'index_missing' && r.summary.paidLast30Days === null && r.summary.aging.d31_60 === null && r.summary.aging.undated === null && r.summary.counts.open === 6, 'a missing index → that figure is null + reason (never 0); figures that need no index still compute', r.summary);
  r = await call(admin({ tab: 'draft' }));
  ck('I6b', r.err === 'failed-precondition' && r.reason === 'INDEX_MISSING', 'a tab whose list needs a missing index says so (no empty list posing as "no invoices")', r);
  INDEX_OK = true;

  ck('I10', JSON.stringify(store) === before, 'read-only: the store is identical after every call');
  console.log('\n' + pass + ' passed, ' + fail + ' failed' + (process.env.SABOTAGE === '1' ? '   (SABOTAGE — failures EXPECTED)' : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e.stack || e.message); process.exit(2); });
