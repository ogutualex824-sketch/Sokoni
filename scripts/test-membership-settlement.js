#!/usr/bin/env node
'use strict';
/* ============================================================================
   Membership settlement — FINAL owner rules (2026-10-03): hold until first attendance, then monthly; refund only with
   zero attendance (a REQUEST); never attended + ended → gym settled at expiry
     M1  slices are integer cents that sum EXACTLY to the price (last month carries the remainder)
     M2  months fall due at calendar month ends (subscription-period.periodEnd); invalid records refused
     M3  UNUSED + running: nothing is released even after months pass (money stays held, refundable)
     M4  first attendance (written by the Fitness lane) → every passed month released at once, 5% via the real engine,
         gym BUSINESS wallet credited, providerPayouts + deterministic walletTransaction; then monthly
     M5  idempotent: a second sweep, or two at once, pays nothing twice (create() claim per month)
     M6  never attended and the membership ended → all months released at expiry (trigger expired_unused)
     M7  refund: zero attendance + running → REQUEST of the full price, releases frozen, nothing paid out,
         refundRequests never written
     M8  refund REFUSED after one attendance ("Refund unavailable because this membership has already been used.",
         detail "Member attended 1 session."), after a refund exists, after the end, when not held; any of
         attendedSessions / firstAttendedAt / refundEligible:false counts as used (fails toward used)
     M9  a browser-shaped claim cannot help: refund state is read from the record, never from the request
   In-memory Firestore (transactions all-or-nothing + contention retry, create() fails on an existing doc). No network.
   NODE_PATH=<functions/node_modules> node scripts/test-membership-settlement.js
   ============================================================================ */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const MS = require(path.join(ROOT, 'functions/membership-settlement.js'));
const CC = require(path.join(ROOT, 'functions/commission-config.js'));
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 260) : '')); } };

/* ── in-memory Firestore ── */
function fakeDb (seed) {
  const docs = new Map(Object.entries(seed || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const INC = Symbol('inc');
  const apply = (cur, patch) => {
    const out = Object.assign({}, cur || {});
    for (const [k, v] of Object.entries(patch)) {
      if (v && v[INC] !== undefined) out[k] = (Number(out[k]) || 0) + v[INC];
      else out[k] = v;
    }
    return out;
  };
  const ref = (p) => ({ path: p, id: p.split('/').pop(), collection: (c) => col(p + '/' + c) });
  const col = (c) => ({
    doc: (id) => ref(c + '/' + id),
    where: (f, op, v) => ({ limit: () => ({ get: async () => {
      const hits = [...docs.entries()].filter(([k, d]) => k.startsWith(c + '/') && k.split('/').length === 2 && d[f] != null && (op === '<=' ? d[f] <= v : false));
      return { size: hits.length, docs: hits.map(([k]) => ({ id: k.split('/')[1] })) };
    } }) }),
  });
  const db = {
    _docs: docs, _inc: (n) => ({ [INC]: n }),
    collection: col,
    /* Firestore semantics: a transaction whose READ documents changed before commit is re-run (contention), so the
       loser of a race re-reads and sees the winner's write. Up to 5 attempts, like the SDK. */
    async runTransaction (fn) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const reads = new Map();
        const res = await this._attempt(fn, reads);
        if (res.conflict) continue;
        return res.out;
      }
      throw new Error('ABORTED: too much contention');
    },
    async _attempt (fn, reads) {
      const writes = [];
      const t = {
        get: async (r) => { const d = docs.get(r.path); reads.set(r.path, JSON.stringify(d === undefined ? null : d)); return { exists: !!d, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) }; },
        create: (r, v) => writes.push(() => { if (docs.has(r.path)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } docs.set(r.path, apply(null, v)); }),
        set: (r, v, o) => writes.push(() => docs.set(r.path, apply(o && o.merge ? docs.get(r.path) : null, v))),
        update: (r, v) => writes.push(() => { if (!docs.has(r.path)) throw new Error('NOT_FOUND'); docs.set(r.path, apply(docs.get(r.path), v)); }),
      };
      const out = await fn(t);
      for (const [p, v] of reads) if (JSON.stringify(docs.get(p) === undefined ? null : docs.get(p)) !== v) return { conflict: true };
      const snapshot = new Map(docs);
      try { writes.forEach((w) => w()); } catch (e) { docs.clear(); snapshot.forEach((v, k) => docs.set(k, v)); throw e; }
      return { out };
    },
  };
  ref.prototype = null;
  db.collection = (c) => Object.assign(col(c), {});
  /* ref().get for the top-level reads */
  const origDoc = (c) => col(c).doc;
  db.collection = (c) => ({ ...col(c), doc: (id) => { const r = origDoc(c)(id); r.get = async () => { const d = docs.get(r.path); return { exists: !!d, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) }; }; return r; } });
  return db;
}
/* the REAL commission engine, with a stub Firestore that offers no overrides */
const FU = require(path.join(ROOT, 'functions/finos-utils.js'));
const emptyDb = { collection: () => ({ where () { return this; }, doc: () => ({ get: async () => ({ exists: false, data: () => null }) }), get: async () => ({ docs: [], empty: true }) }) };
const deps = { calculateCommission: (_db, o) => FU.calculateCommission(emptyDb, o) };

const START = '2026-01-15T09:00:00.000Z';
const mem = (over) => Object.assign({ providerId: 'gym_A', buyerUid: 'member_1', priceCents: 600000, periodCount: 3, periodUnit: 'month',
  startAt: START, category: 'fitness', title: 'Gold 3-month', paymentStatus: 'paid_held', status: 'active', releasedPeriods: 0, releasedCents: 0 }, over || {});
function setup (over) {
  const db = fakeDb({ 'providerMemberships/mem_000001': mem(over) });
  MS._test.use({ db, ts: () => 'TS', inc: db._inc, tsFromDate: (d) => d.toISOString() });
  return db;
}
const D = (s) => new Date(s);

(async () => {
  /* M1/M2 */
  const s = MS.slicesOf(mem({ priceCents: 100000, periodCount: 3 }));
  ck('M1 slices are integers summing exactly to the price (33,333 / 33,333 / 33,334 cents)', s.map((x) => x.amountCents).join() === '33333,33333,33334' && s.reduce((a, x) => a + x.amountCents, 0) === 100000);
  ck('M2 months fall due at calendar month ends (Feb 15, Mar 15, Apr 15)', s.map((x) => x.dueAt.toISOString().slice(0, 10)).join() === '2026-02-15,2026-03-15,2026-04-15', s.map((x) => x.dueAt));
  let bad = 0; for (const o of [{ priceCents: 1.5 }, { periodCount: 0 }, { startAt: null }, { periodUnit: 'week' }]) { try { MS.slicesOf(mem(o)); } catch (_) { bad++; } }
  ck('M2b invalid records refused (fractional cents, 0 periods, no start, undecided period unit)', bad === 4);

  const used = { attendedSessions: 1, firstAttendedAt: '2026-01-20T07:00:00Z', refundEligible: false };
  const bal = (db) => (db._docs.get('wallets/gym_A') || {}).balance || 0;

  /* M3 */
  let db = setup();
  let r = await MS.releaseDueSlices('mem_000001', { now: D('2026-03-20T06:00:00Z'), deps });
  ck('M3 unused, two months passed: nothing released — money stays held and refundable', r.released === 0 && r.held === true && bal(db) === 0, r);

  /* M4 */
  db = setup(used);
  r = await MS.releaseDueSlices('mem_000001', { now: D('2026-03-20T06:00:00Z'), deps });
  const po = db._docs.get('providerPayouts/mem_000001_m0'), m1 = db._docs.get('providerMemberships/mem_000001');
  ck('M4a after the first attendance: both passed months released at once — KES 3,800 net (2 × KES 2,000 − 5%)', r.released === 2 && bal(db) === 3800 && r.trigger === 'period_passed', r);
  ck('M4b ledger: providerPayouts settled, 5% fixed fitness lane, sourceType membership; deterministic walletTransaction',
    po && po.commission === 10000 && po.commissionPct === CC.RATES.fitness.pct && po.fixedRateCategory === true && po.sourceType === 'membership' && po.status === 'settled'
    && db._docs.has('walletTransactions/gym_A_mem_000001_m1_membership'), po);
  ck('M4c then monthly: nextReleaseAt = Apr 15, partially_released', String(m1.nextReleaseAt).startsWith('2026-04-15') && m1.paymentStatus === 'partially_released' && m1.releasedPeriods === 2, m1);
  r = await MS.releaseDueSlices('mem_000001', { now: D('2026-04-16T06:00:00Z'), deps });
  ck('M4d last month at Apr 15 → released, nothing left', r.released === 1 && bal(db) === 5700 && db._docs.get('providerMemberships/mem_000001').paymentStatus === 'released', r);

  /* M5 */
  r = await MS.releaseDueSlices('mem_000001', { now: D('2026-05-01T06:00:00Z'), deps });
  ck('M5a a further sweep pays nothing', r.skipped && bal(db) === 5700, r);
  db = setup(used);
  const both = await Promise.all([1, 2].map(() => MS.releaseDueSlices('mem_000001', { now: D('2026-02-16T06:00:00Z'), deps })));
  ck('M5b two concurrent sweeps: the month is paid ONCE', bal(db) === 1900 && both.filter((x) => x.released === 1).length === 1, both);

  /* M6 */
  db = setup();
  r = await MS.releaseDueSlices('mem_000001', { now: D('2026-04-16T06:00:00Z'), deps });
  ck('M6 never attended, membership ended, no refund requested → all 3 months to the gym at expiry (expired_unused)', r.released === 3 && r.trigger === 'expired_unused' && bal(db) === 5700, r);

  /* M7 */
  db = setup();
  r = await MS.requestRefund('mem_000001', { by: 'member_1', now: D('2026-02-20T10:00:00Z') });
  const mr = db._docs.get('providerMemberships/mem_000001');
  ck('M7a zero attendance, running → refund REQUEST of the full KES 6,000; nothing paid out; refundRequests never written',
    r.ok && r.refundRequestedCents === 600000 && mr.refund.state === 'requested' && mr.refund.attendedSessionsAtRequest === 0 && mr.status === 'refund_requested'
    && !db._docs.has('wallets/member_1') && ![...db._docs.keys()].some((k) => k.startsWith('refundRequests/')), { r, refund: mr.refund });
  r = await MS.releaseDueSlices('mem_000001', { now: D('2026-04-16T06:00:00Z'), deps });
  ck('M7b a refund request freezes releases — even at expiry the gym is not paid', r.skipped && bal(db) === 0, r);

  /* M8 */
  for (const [label, over] of [['attendedSessions 1', { attendedSessions: 1 }], ['firstAttendedAt only', { firstAttendedAt: '2026-01-20T07:00:00Z' }], ['refundEligible false only', { refundEligible: false }]]) {
    db = setup(over);
    r = await MS.requestRefund('mem_000001', { by: 'member_1', now: D('2026-01-25T10:00:00Z') });
    ck('M8 used (' + label + ') → refund refused: "Refund unavailable because this membership has already been used."',
      r.ok === false && r.code === 'used' && r.reason === 'Refund unavailable because this membership has already been used.' && !db._docs.get('providerMemberships/mem_000001').refund, r);
  }
  db = setup({ attendedSessions: 1 });
  r = await MS.requestRefund('mem_000001', { now: D('2026-01-25T10:00:00Z') });
  ck('M8b the reason AdminOS shows: "Member attended 1 session."', r.detail === 'Member attended 1 session.', r);
  db = setup();
  await MS.requestRefund('mem_000001', { now: D('2026-01-25T10:00:00Z') });
  r = await MS.requestRefund('mem_000001', { now: D('2026-01-26T10:00:00Z') });
  ck('M8c a second refund request is refused (no second refund)', r.ok === false && r.code === 'refund_exists', r);
  db = setup();
  r = await MS.requestRefund('mem_000001', { now: D('2026-04-16T10:00:00Z') });
  ck('M8d after the membership ended → refused (ended)', r.ok === false && r.code === 'ended', r);
  db = setup({ paymentStatus: 'pending' });
  r = await MS.requestRefund('mem_000001', { now: D('2026-01-25T10:00:00Z') });
  ck('M8e unpaid (not verified/held) → refused, and nothing released', r.ok === false && r.code === 'not_refundable_state' && (await MS.releaseDueSlices('mem_000001', { now: D('2026-04-16T06:00:00Z'), deps })).skipped === 'payment_pending', r);

  /* M9 */
  const src = require('fs').readFileSync(path.join(ROOT, 'functions/membership-settlement.js'), 'utf8');
  const callable = src.slice(src.indexOf('const membershipRequestRefund'), src.indexOf('module.exports'));
  ck('M9 the refund callable reads only membershipId from the request (no attendedSessions / refundEligible / amount from the browser)',
    /req\.data && req\.data\.membershipId/.test(callable) && !/req\.data\.(attended|refund|amount|price|sessions)/i.test(callable) && !/attendedSessions\s*[:=]/.test(src.replace(/attendedSessionsAtRequest/g, '')));
  ck('M9b settlement never WRITES the attendance fields (Fitness lane owns them)', !/(attendedSessions|firstAttendedAt|refundEligible)\s*:/.test(src.replace(/attendedSessionsAtRequest/g, '')));
  const init = MS.initialSettlementFields(mem());
  ck('M10 initialSettlementFields (for the payment webhook): nextReleaseAt = first month end, counters 0', String(init.nextReleaseAt).startsWith('2026-02-15') && init.releasedPeriods === 0 && init.status === 'active', init);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
