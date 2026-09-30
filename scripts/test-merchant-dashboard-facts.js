/* test-merchant-dashboard-facts.js — the server-authoritative Business Pulse + Customers source.
 *
 *   node scripts/test-merchant-dashboard-facts.js        (no emulator, no network)
 *
 * Proves: scope is the AUTHENTICATED uid only (no client id accepted); till sales + online orders
 * combine honestly (known / partial / unknown, truncation refused as a total); customers are derived
 * from identified sales only (walk-ins are sales, not customers); the handler runs against the fake
 * Firestore end to end; deliberate-breakage controls.
 */
'use strict';
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
const stub = (m, exp) => { const p = m.startsWith('./') ? Path.join(FN, m + '.js') : require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
stub('firebase-functions/v2/https', { onCall: (o, h) => Object.assign(h, { _opts: o }), HttpsError });
stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), firestore: () => db });
const M = require(Path.join(FN, 'merchant-dashboard-facts.js'));
const I = M._internal;
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 170) + ']' : '')); ok ? pass++ : fail++; };
/* Fixtures are pinned to KENYA time (UTC+3), not to whatever timezone this machine runs in — the function's
   day is the shop's day, so a UTC CI runner and a Nairobi laptop must see the same results. */
const EAT = 3 * 3600 * 1000;
const kenya = (y, mo, d, h, mi) => Date.UTC(y, mo, d, h, mi || 0, 0) - EAT;
const NOW = new Date(kenya(2026, 8, 30, 14)); const now = NOW.getTime();
const today = (h) => kenya(2026, 8, 30, h);
const yday = (h) => kenya(2026, 8, 29, h);
const TS = (ms) => ({ toMillis: () => ms });

console.log('\nMERCHANT DASHBOARD FACTS — server-authoritative Business Pulse + Customers');
console.log('='.repeat(78));

console.log('\n1 — declaration');
ck('callable enforces App Check, us-central1, bounded timeout', M.merchantDashboardFacts._opts.enforceAppCheck === true && M.merchantDashboardFacts._opts.region === 'us-central1' && M.merchantDashboardFacts._opts.timeoutSeconds <= 60);

console.log('\n2 — computeFacts on the live shape (till completed sales + orders)');
const sales = [
  { grandTotal: 500, status: 'completed', saleDate: '2026-09-30', createdAt: TS(today(9)), customer: null, payments: [{ method: 'cash' }] },
  { grandTotal: 250, status: 'completed', saleDate: '2026-09-30', createdAt: TS(today(11)), customer: { phone: '0700000001', name: 'Amina' } },
  { grandTotal: 999, status: 'completed', saleDate: '2026-09-29', createdAt: TS(yday(10)), customer: null },
  { grandTotal: 100, status: 'voided',    saleDate: '2026-09-30', createdAt: TS(today(12)), customer: null },
];
const orders = [
  { total: 1200, status: 'paid',      createdAt: TS(today(8)),  buyerUid: 'b1', buyerName: 'Kim', buyerPhone: '0711' },
  { total: 300,  status: 'pending',   createdAt: TS(today(13)), buyerUid: 'b2' },
  { total: 400,  status: 'delivered', createdAt: TS(yday(15)),  buyerPhone: '0700000001' },   /* same person as the till customer */
  { amount: 50,  status: 'paid',      createdAt: TS(today(7)),  buyerUid: 'b1' },
];
const f = I.computeFacts({ orders, sales, ordersReadable: true, salesReadable: true, ordersTruncated: false, salesTruncated: false, now });
ck('till today = completed sales dated today only (500 + 250; voided and yesterday excluded)', f.tillToday.state === 'known' && f.tillToday.value === 750, f.tillToday);
ck('online today = PAID orders today only (1200 + 50; pending excluded)', f.onlineToday.state === 'known' && f.onlineToday.value === 1250, f.onlineToday);
ck('takings = till + online, known when both are complete', f.takings.state === 'known' && f.takings.value === 2000, f.takings);
ck('orders today counts every order created today (paid or not)', f.ordersToday.state === 'known' && f.ordersToday.value === 3, f.ordersToday);
ck('needsAttention = open orders (pending, paid)', f.needsAttention === 3, f.needsAttention);
ck('trend vs yesterday (999 till + 400 online = 1399) → +43%', f.trend.state === 'known' && Math.round(f.trend.value) === 43, f.trend);
ck('customers = distinct identities: b1, b2, phone 0700000001 (till + order merged) = 3; walk-ins excluded', f.customers.state === 'known' && f.customers.value === 3, f.customers);
ck('7-day series: yesterday 1399, today 2000, oldest first', Array.isArray(f.series) && f.series.length === 7 && f.series[5] === 1399 && f.series[6] === 2000, f.series);
ck('deliveries stay unknown (the dispatch-authority finding is unchanged)', f.deliveries.state === 'unknown');

console.log('\n3 — honesty under incompleteness');
const tr = I.computeFacts({ orders, sales, ordersReadable: true, salesReadable: true, ordersTruncated: true, salesTruncated: false, now });
ck('a truncated order sample makes the online figure PARTIAL with the reason, never a silent total', tr.onlineToday.state === 'partial' && /limit/.test(tr.onlineToday.note) && tr.takings.state === 'partial');
ck('trend and series are withheld when a sample was truncated', tr.trend.state === 'unknown' && tr.series === null);
const ur = I.computeFacts({ orders, sales: [], ordersReadable: true, salesReadable: false, ordersTruncated: false, salesTruncated: false, now });
ck('an unreadable till source → till unknown, takings partial (online only), customers partial', ur.tillToday.state === 'unknown' && ur.takings.state === 'partial' && ur.takings.value === 1250 && ur.customers.state === 'partial');
const none = I.computeFacts({ orders: [], sales: [], ordersReadable: false, salesReadable: false, now });
ck('nothing readable → every figure unknown, series null (dashes, never zeros)', none.takings.state === 'unknown' && none.customers.state === 'unknown' && none.series === null);
const badTotals = I.computeFacts({ orders: [], sales: [{ grandTotal: 'x', status: 'completed', saleDate: '2026-09-30' }], ordersReadable: true, salesReadable: true, now });
ck('a sale without a readable total is counted as incomplete (partial), not as 0', badTotals.tillToday.state === 'partial' && /no readable total/.test(badTotals.tillToday.note));

console.log('\n4 — computeCustomers');
const c = I.computeCustomers({ orders, sales, ordersReadable: true, salesReadable: true, ordersTruncated: false, salesTruncated: false });
ck('three customers, sorted by spend', c.count === 3 && c.customers[0].totalSpend >= c.customers[1].totalSpend, c.customers.map((x) => x.key + ':' + x.totalSpend));
const merged = c.customers.find((x) => x.key === 'phone:0700000001');
ck('the phone identity merges the till sale and the online order (2 orders, 650 spend, sources till+online)', merged && merged.orderCount === 2 && merged.totalSpend === 650 && merged.sources.till === 1 && merged.sources.online === 1, merged);
ck('walk-in till sales are reported in the note, not invented as customers', /2 till sale\(s\) were walk-ins/.test(c.note), c.note);
ck('completeness is stated', c.completeness === 'complete' && I.computeCustomers({ orders, sales, ordersReadable: true, salesReadable: false }).completeness === 'partial');

console.log('\n4b — the shop\'s day is Kenya\'s day, not the server\'s (Cloud Functions run in UTC)');
{
  const at0100 = kenya(2026, 9, 1, 1);                 /* 01:00 in Nairobi = 22:00 UTC the day before */
  ck('dayStart at 01:00 Nairobi is Nairobi midnight, not UTC midnight (which is 03:00 Nairobi)', I.dayStart(at0100, 0) === kenya(2026, 9, 1, 0), I.dayStart(at0100, 0));
  const lateLastNight = { grandTotal: 400, status: 'completed', createdAt: TS(kenya(2026, 8, 30, 23)) };
  const justAfterMidnight = { grandTotal: 60, status: 'completed', createdAt: TS(kenya(2026, 9, 1, 0, 30)) };
  const k = I.computeFacts({ orders: [], sales: [lateLastNight, justAfterMidnight], ordersReadable: true, salesReadable: true, now: at0100 });
  ck('at 01:00 Nairobi, last night\'s 23:00 sale is NOT today; the 00:30 sale is', k.tillToday.value === 60, k.tillToday);
  const utcStamped = { grandTotal: 75, status: 'completed', saleDate: '2026-09-30', createdAt: TS(kenya(2026, 9, 1, 0, 45)) };
  ck('a sale\'s own timestamp wins over a UTC-stamped saleDate (toISOString would file a 00:45 sale under yesterday)', I.computeFacts({ orders: [], sales: [utcStamped], ordersReadable: true, salesReadable: true, now: at0100 }).tillToday.value === 75);
  ck('saleDate alone is read as that day in Nairobi', I.saleMillis({ saleDate: '2026-10-01' }) === kenya(2026, 9, 1, 12));
  ck('control: the old server-local rule on a UTC host would have counted last night\'s sale', (function () { const d = new Date(at0100); const utcMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); return kenya(2026, 8, 30, 23) >= utcMidnight; }()));
}

console.log('\n5 — handler against the fake Firestore: scoped by the AUTHENTICATED uid only');
(async () => {
  /* The handler reads the REAL clock, so its fixtures sit inside the CURRENT Nairobi day (halfway between its
     midnight and now) — they stayed dated 2026-09-30 before, and the suite went red at midnight. */
  const kd0 = I.dayStart(Date.now(), 0);
  const inToday = kd0 + Math.floor((Date.now() - kd0) / 2);
  const kDate = new Date(inToday + EAT).toISOString().slice(0, 10);
  await db.doc('orders/o1').set({ sellerUid: 'kass', total: 700, status: 'paid', createdAt: F.Timestamp.fromMillis(inToday), buyerUid: 'b9' });
  await db.doc('orders/o2').set({ sellerUid: 'other', total: 5000, status: 'paid', createdAt: F.Timestamp.fromMillis(inToday), buyerUid: 'b8' });
  await db.doc('posRetailSales/s1').set({ sellerUid: 'kass', merchantId: 'kass', grandTotal: 300, status: 'completed', saleDate: kDate, createdAt: F.Timestamp.fromMillis(inToday), customer: null });
  await db.doc('posRetailSales/s2').set({ sellerUid: 'other', grandTotal: 9000, status: 'completed', saleDate: kDate, createdAt: F.Timestamp.fromMillis(inToday), customer: null });
  const r = await I.handler({ auth: { uid: 'kass' }, data: { op: 'facts' } });
  ck('facts for kass see only kass rows: till 300, online today counted, other merchant invisible', r.ok && r.facts.tillToday.value === 300 && r.facts.sources.orders.count === 1 && r.facts.sources.tillSales.count === 1, r.facts && r.facts.sources);
  const rc = await I.handler({ auth: { uid: 'kass' }, data: { op: 'customers' } });
  ck('customers for kass: one identified buyer (b9); the till walk-in is a note', rc.ok && rc.count === 1 && rc.customers[0].uid === 'b9' && /walk-ins/.test(rc.note), rc);
  let denied = null; try { await I.handler({ auth: null, data: { op: 'facts' } }); } catch (e) { denied = e.code; }
  ck('unauthenticated → refused', denied === 'unauthenticated');
  let badOp = null; try { await I.handler({ auth: { uid: 'kass' }, data: { op: 'drop' } }); } catch (e) { badOp = e.code; }
  ck('unknown op → invalid-argument', badOp === 'invalid-argument');
  const spoof = await I.handler({ auth: { uid: 'kass' }, data: { op: 'facts', sellerUid: 'other', uid: 'other', merchantId: 'other' } });
  ck('control: a client-supplied sellerUid/merchantId is ignored — scope is still the caller', spoof.facts.tillToday.value === 300 && spoof.facts.sources.orders.count === 1);

  console.log('\n6 — deliberate-breakage controls on the pure functions');
  ck('control: a pending order counted as paid would change onlineToday — it does not', I.computeFacts({ orders: [{ total: 10, status: 'pending', createdAt: TS(today(9)) }], sales: [], ordersReadable: true, salesReadable: true, now }).onlineToday.value === 0);
  ck('control: an order without createdAt is never counted as today', I.computeFacts({ orders: [{ total: 10, status: 'paid' }], sales: [], ordersReadable: true, salesReadable: true, now }).ordersToday.value === 0);
  ck('control: a walk-in never becomes a customer key', I.customerKeyOf({ customer: null }) === null && I.customerKeyOf({}) === null);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { ck('suite ran', false, e.stack && e.stack.slice(0, 300)); console.log('\n' + pass + ' passed, ' + (fail) + ' failed'); process.exit(1); });
