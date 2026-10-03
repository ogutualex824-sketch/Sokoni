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
fakeDb._n = 0;
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
    doc: (id) => ref(c + '/' + (id === undefined ? 'auto' + (++fakeDb._n) : id)),
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
        set: (r, v, o) => writes.push(() => { if (db._failOn && r.path.startsWith(db._failOn)) { throw new Error('INJECTED_COMMIT_FAILURE on ' + r.path); } docs.set(r.path, apply(o && o.merge ? docs.get(r.path) : null, v)); }),
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
  db.collection = (c) => ({ ...col(c), doc: (id) => { const r = origDoc(c)(id); r.get = async () => { const d = docs.get(r.path); return { exists: !!d, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) }; }; r.set = async (v, o) => { docs.set(r.path, apply(o && o.merge ? docs.get(r.path) : null, v)); }; return r; } });
  return db;
}
/* the REAL commission engine, with a stub Firestore that offers no overrides */
const FU = require(path.join(ROOT, 'functions/finos-utils.js'));
const emptyDb = { collection: () => ({ where () { return this; }, doc: () => ({ get: async () => ({ exists: false, data: () => null }) }), get: async () => ({ docs: [], empty: true }) }) };
const deps = { calculateCommission: (_db, o) => FU.calculateCommission(emptyDb, o) };

const START = '2026-01-15T09:00:00.000Z';
const mem = (over) => Object.assign({ providerId: 'gym_A', buyerUid: 'member_1', priceCents: 600000, periodCount: 3, periodUnit: 'month',
  startAt: START, category: 'fitness', title: 'Gold 3-month', paymentStatus: 'paid_held', status: 'active', releasedPeriods: 0, releasedCents: 0 }, over || {});
const NOTES = [];
function setup (over) {
  const db = fakeDb({ 'providerMemberships/mem_000001': mem(over) });
  NOTES.length = 0;
  MS._test.use({ db, ts: () => 'TS', inc: db._inc, tsFromDate: (d) => d.toISOString(), now: () => new Date(START), notify: (a) => { NOTES.push(a); return null; } });
  return db;
}
const D = (s) => new Date(s);

(async () => {
  /* M1/M2 */
  const s = MS.slicesOf(mem({ priceCents: 100000, periodCount: 3 }));
  ck('M1 slices are integers summing exactly to the price (33,333 / 33,333 / 33,334 cents)', s.map((x) => x.amountCents).join() === '33333,33333,33334' && s.reduce((a, x) => a + x.amountCents, 0) === 100000);
  ck('M2 months fall due at calendar month ends (Feb 15, Mar 15, Apr 15)', s.map((x) => x.dueAt.toISOString().slice(0, 10)).join() === '2026-02-15,2026-03-15,2026-04-15', s.map((x) => x.dueAt));
  let bad = 0; for (const o of [{ priceCents: 1.5 }, { periodCount: 0 }, { startAt: null }, { periodUnit: 'year' }]) { try { MS.slicesOf(mem(o)); } catch (_) { bad++; } }
  ck('M2b invalid records refused (fractional cents, 0 periods, no start, undecided period unit year)', bad === 4);

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

  /* ══ P: PAYMENT INTAKE (purpose fitness_membership → verified webhook → hold) ══ */
  const pend = { paymentStatus: 'pending', status: 'pending_payment', releasedPeriods: undefined, releasedCents: undefined };
  const intent = (over) => Object.assign({ resourceType: 'providerMembership', resourceId: 'mem_000001', uid: 'member_1', amountCents: 600000, currency: 'KES' }, over || {});
  const setupPay = (memOver, intentOver) => { const d = setup(Object.assign({}, pend, memOver || {})); d._docs.set('paymentIntents/int_1', intent(intentOver)); return d; };
  db = setupPay();
  let h = await MS.holdMembershipPayment(null, null, 'API_1', 'int_1', 6000);
  let mp = db._docs.get('providerMemberships/mem_000001');
  ck('P1 valid payment → paid_held + active, settlement fields initialised, NOTHING credited, intent paid',
    h === true && mp.paymentStatus === 'paid_held' && mp.status === 'active' && mp.heldCents === 600000 && String(mp.nextReleaseAt).startsWith('2026-02-15') && bal(db) === 0 && db._docs.get('paymentIntents/int_1').status === 'paid', mp);
  h = await MS.holdMembershipPayment(null, null, 'API_1', 'int_1', 6000);
  ck('P2 replayed webhook → no-op (still held once, one event)', h === true && [...db._docs.keys()].filter((k) => k.startsWith('providerMemberships/mem_000001/events/')).length === 1);
  db = setupPay();
  await MS.holdMembershipPayment(null, null, 'API_2', 'int_1', 600);
  mp = db._docs.get('providerMemberships/mem_000001');
  ck('P3 wrong amount (KES 600 for KES 6,000) → payment_review, NOT activated', mp.paymentStatus === 'payment_review' && mp.paymentReviewReason === 'amount_mismatch' && mp.status === 'pending_payment', mp);
  db = setupPay({}, { uid: 'someone_else' });
  await MS.holdMembershipPayment(null, null, 'API_3', 'int_1', 6000);
  ck('P4 intent minted by a different buyer → payment_review (intent_binding), not activated', db._docs.get('providerMemberships/mem_000001').paymentReviewReason === 'intent_binding');
  db = setupPay({}, { amountCents: 100 });
  await MS.holdMembershipPayment(null, null, 'API_4', 'int_1', 6000);
  ck('P5 intent priced differently from the membership → payment_review', db._docs.get('providerMemberships/mem_000001').paymentStatus === 'payment_review');
  db = setupPay({}, { resourceType: 'providerBooking' });
  ck('P6 a non-membership intent is not handled here (returns false, membership untouched)', (await MS.holdMembershipPayment(null, null, 'API_5', 'int_1', 6000)) === false && db._docs.get('providerMemberships/mem_000001').paymentStatus === 'pending');
  db = setupPay();
  ck('P7 fake payment reference (no intent) → not handled, nothing activated', (await MS.holdMembershipPayment(null, null, 'FAKE', 'nope', 6000)) === false && db._docs.get('providerMemberships/mem_000001').status === 'pending_payment');
  const PP = require(path.join(ROOT, 'functions/payment-purposes.js'));
  ck('P8 purpose fitness_membership is registered and prices from the record (resourceType providerMembership)', PP.isRegistered && PP.isRegistered('fitness_membership') && PP.PURPOSES.fitness_membership.resourceType === 'providerMembership');

  /* ══ R: REFUND DECISION (second actor) + EXECUTION ══ */
  const reqd = () => { const d = setup({ paymentRef: 'API_1' }); return d; };
  db = reqd();
  await MS.requestRefund('mem_000001', { by: 'member_1', now: D('2026-01-25T10:00:00Z') });
  r = await MS.decideRefund('mem_000001', { by: 'member_1', decision: 'approve' });
  ck('R1 the requester (buyer) cannot approve their own refund (separation of duties)', r.ok === false && r.code === 'separation_of_duties', r);
  r = await MS.decideRefund('mem_000001', { by: 'gym_A', decision: 'approve' });
  ck('R1b the gym cannot approve it either', r.ok === false && r.code === 'separation_of_duties', r);
  r = await MS.decideRefund('mem_000001', { by: 'admin_9', decision: 'approve', reason: 'zero attendance' });
  const mf = db._docs.get('providerMemberships/mem_000001');
  ck('R2 a second authorized actor approves → KES 6,000 to the buyer\'s SOKONI wallet + one ledger row; refunded',
    r.ok && r.state === 'refunded' && (db._docs.get('users/member_1') || {}).walletBalance === 6000 && db._docs.has('ledger/member_1_mem_000001_membership_refund') && mf.paymentStatus === 'refunded' && mf.refund.destination === 'sokoni_wallet', { r, refund: mf.refund });
  r = await MS.decideRefund('mem_000001', { by: 'admin_8', decision: 'approve' });
  ck('R3 replayed approval → refused, no second credit (already refunded)', r.ok === false && db._docs.get('users/member_1').walletBalance === 6000, r);
  r = await MS.releaseDueSlices('mem_000001', { now: D('2026-04-16T06:00:00Z'), deps });
  ck('R4 a refunded membership never settles to the gym', r.skipped && bal(db) === 0, r);
  db = reqd();
  await MS.requestRefund('mem_000001', { by: 'member_1', now: D('2026-01-25T10:00:00Z') });
  r = await MS.decideRefund('mem_000001', { by: 'admin_9', decision: 'reject', reason: 'policy window' });
  const mj = db._docs.get('providerMemberships/mem_000001');
  ck('R5 rejection → schedule resumes (active, paid_held, nextReleaseAt restored), nothing credited', r.ok && mj.status === 'active' && mj.paymentStatus === 'paid_held' && String(mj.nextReleaseAt).startsWith('2026-02-15') && !db._docs.has('users/member_1'), mj);
  db = reqd();
  await MS.requestRefund('mem_000001', { by: 'member_1', now: D('2026-01-25T10:00:00Z') });
  /* the race: a check-in lands after the request (the Fitness lane must refuse it, but if it slipped through…) */
  const cur = db._docs.get('providerMemberships/mem_000001'); db._docs.set('providerMemberships/mem_000001', Object.assign({}, cur, { attendedSessions: 1, refundEligible: false }));
  r = await MS.decideRefund('mem_000001', { by: 'admin_9', decision: 'approve' });
  ck('R6 check-in vs refund race: approval re-checks attendance inside its txn → refused "already been used"', r.ok === false && r.code === 'used' && !db._docs.has('users/member_1'), r);
  db = setup({ paymentRef: 'API_1' });
  await MS.requestRefund('mem_000001', { by: 'member_1', now: D('2026-01-25T10:00:00Z') });
  const [rel, dec] = await Promise.all([MS.releaseDueSlices('mem_000001', { now: D('2026-04-16T06:00:00Z'), deps }), MS.decideRefund('mem_000001', { by: 'admin_9', decision: 'approve' })]);
  ck('R7 refund approval vs payout worker at the same time: the gym gets nothing, the buyer is refunded once', bal(db) === 0 && db._docs.get('users/member_1').walletBalance === 6000 && dec.ok, { rel, dec });

  /* ══ X: ADMINOS EXCEPTION ══ */
  db = setup(Object.assign({ paymentRef: 'API_1' }, used));
  await MS.releaseDueSlices('mem_000001', { now: D('2026-02-16T06:00:00Z'), deps });   /* month 1 settled to the gym */
  r = await MS.requestException('mem_000001', { by: 'admin_1', reason: 'short' });
  ck('X1 an exception needs a written reason', r.ok === false && r.code === 'reason_required', r);
  r = await MS.requestException('mem_000001', { by: 'admin_1', reason: 'Member relocated — medical certificate on file' });
  const mx = db._docs.get('providerMemberships/mem_000001');
  ck('X2 exception on a USED membership: request for the UNRELEASED KES 4,000 only; attendance preserved; releases frozen',
    r.ok && r.refundRequestedCents === 400000 && mx.refund.exception === true && mx.refund.used === true && mx.attendedSessions === 1 && mx.refundEligible === false && mx.status === 'refund_requested', mx.refund);
  r = await MS.decideRefund('mem_000001', { by: 'admin_1', decision: 'approve' });
  ck('X3 the admin who opened the exception cannot approve it', r.ok === false && r.code === 'separation_of_duties', r);
  r = await MS.decideRefund('mem_000001', { by: 'admin_2', decision: 'approve', reason: 'reviewed' });
  ck('X4 a second admin approves → KES 4,000 to the buyer wallet through the SAME execution; gym keeps month 1; attendance untouched',
    r.ok && db._docs.get('users/member_1').walletBalance === 4000 && bal(db) === 1900 && db._docs.get('providerMemberships/mem_000001').attendedSessions === 1, r);
  const evs = [...db._docs.entries()].filter(([k]) => k.startsWith('providerMemberships/mem_000001/events/')).map(([, v]) => v.type);
  ck('X5 audit trail: settlement_released → refund_exception_requested → refund_executed', evs.join(',') === 'settlement_released,refund_exception_requested,refund_executed', evs);
  const src2 = require('fs').readFileSync(path.join(ROOT, 'functions/membership-settlement.js'), 'utf8');
  ck('X6 no client path writes refundRequests; decide/exception callables are admin-gated', !/collection\('refundRequests'\)/.test(src2) && /membershipDecideRefund = onCall[\s\S]{0,300}_admin\(req\)/.test(src2) && /membershipRequestException = onCall[\s\S]{0,300}_admin\(req\)/.test(src2));

  /* ══ S: START AT PAYMENT ══ */
  db = setupPay({ startAt: '2026-01-01T09:00:00.000Z' });                 /* created on the 1st … */
  MS._test.use({ now: () => new Date('2026-01-09T12:00:00.000Z') });      /* … paid on the 9th */
  await MS.holdMembershipPayment(null, null, 'API_S1', 'int_1', 6000);
  let ms1 = db._docs.get('providerMemberships/mem_000001');
  ck('S1 months run from PAYMENT (Jan 9), not creation (Jan 1): first release Feb 9; requestedStartAt kept',
    String(ms1.startAt).startsWith('2026-01-09') && String(ms1.nextReleaseAt).startsWith('2026-02-09') && ms1.requestedStartAt === '2026-01-01T09:00:00.000Z', ms1);
  db = setupPay({ startAt: '2026-03-01T06:00:00.000Z' });                 /* a deliberately LATER start */
  MS._test.use({ now: () => new Date('2026-01-09T12:00:00.000Z') });
  await MS.holdMembershipPayment(null, null, 'API_S2', 'int_1', 6000);
  ms1 = db._docs.get('providerMemberships/mem_000001');
  ck('S2 a chosen future start (Mar 1) is kept: first release Apr 1', String(ms1.startAt).startsWith('2026-03-01') && String(ms1.nextReleaseAt).startsWith('2026-04-01'), ms1);
  const ppSrc = require('fs').readFileSync(path.join(ROOT, 'functions/payment-purposes.js'), 'utf8');
  ck('S3 an abandoned unpaid membership past payBy cannot mint a new intent', /fitness_membership[\s\S]{0,2500}payBy && Date\.now\(\) > payBy\) fail\('failed-precondition', 'This membership offer has expired/.test(ppSrc));

  /* ══ N: NOTIFICATIONS (existing notify.js sender, no WhatsApp) ══ */
  db = setupPay();
  await MS.holdMembershipPayment(null, null, 'API_N1', 'int_1', 6000);
  ck('N1 payment held → member "Membership active" (payment confirmed) + gym "New membership"',
    NOTES.some((n) => n.uid === 'member_1' && n.type === 'subscription_activated') && NOTES.some((n) => n.uid === 'gym_A' && n.type === 'booking_new'), NOTES.map((n) => n.uid + ':' + n.type));
  db = setup(); await MS.requestRefund('mem_000001', { by: 'member_1', now: D('2026-01-25T10:00:00Z') });
  ck('N2 refund requested → member "Refund request received" + gym "Membership refund requested"',
    NOTES.some((n) => n.uid === 'member_1' && /received/.test(n.title)) && NOTES.some((n) => n.uid === 'gym_A' && /refund requested/i.test(n.title)), NOTES.map((n) => n.title));
  db = setup({ paymentRef: 'API_1' }); await MS.requestRefund('mem_000001', { by: 'member_1', now: D('2026-01-25T10:00:00Z') }); NOTES.length = 0;
  await MS.decideRefund('mem_000001', { by: 'admin_9', decision: 'approve' });
  ck('N3 refund approved + executed → member "Membership refunded" (refund_processed)', NOTES.some((n) => n.uid === 'member_1' && n.type === 'refund_processed'), NOTES);
  db = setup({ paymentRef: 'API_1' }); await MS.requestRefund('mem_000001', { by: 'member_1', now: D('2026-01-25T10:00:00Z') }); NOTES.length = 0;
  await MS.decideRefund('mem_000001', { by: 'admin_9', decision: 'reject', reason: 'outside window' });
  ck('N4 refund rejected → member told, with the reason', NOTES.some((n) => n.uid === 'member_1' && /declined/.test(n.title) && /outside window/.test(n.body)), NOTES);
  db = setup(used); NOTES.length = 0;
  await MS.releaseDueSlices('mem_000001', { now: D('2026-04-16T06:00:00Z'), deps });
  ck('N5 settlement → gym "Membership earnings released"; last month → member "Membership ended"',
    NOTES.some((n) => n.uid === 'gym_A' && n.type === 'wallet_credit') && NOTES.some((n) => n.uid === 'member_1' && n.type === 'subscription_expired'), NOTES.map((n) => n.uid + ':' + n.type));

  /* ══ N6–N9: notifications sokoni-e3's brief audit found missing ══ */
  db = setupPay(); NOTES.length = 0;
  await MS.holdMembershipPayment(null, null, 'API_N6', 'int_1', 600);   /* wrong amount → review */
  ck('N6 payment parked for review → member "Payment under review" (not "active")',
    NOTES.some((n) => n.uid === 'member_1' && n.title === 'Payment under review') && !NOTES.some((n) => n.type === 'subscription_activated'), NOTES.map((n) => n.title));
  db = setup(Object.assign({ paymentRef: 'API_1' }, used)); NOTES.length = 0;
  await MS.requestException('mem_000001', { by: 'admin_1', reason: 'Member relocated — documents on file' });
  ck('N7 exception filed → member "Refund review opened" + gym "Membership refund under review"',
    NOTES.some((n) => n.uid === 'member_1' && /review opened/.test(n.title)) && NOTES.some((n) => n.uid === 'gym_A' && /under review/.test(n.title)), NOTES.map((n) => n.uid + ':' + n.title));
  NOTES.length = 0;
  await MS.decideRefund('mem_000001', { by: 'admin_2', decision: 'approve' });
  ck('N8 refund executed → member "Membership refunded" AND gym "Membership refunded" (remaining payouts cancelled)',
    NOTES.some((n) => n.uid === 'member_1' && n.type === 'refund_processed') && NOTES.some((n) => n.uid === 'gym_A' && n.title === 'Membership refunded'), NOTES.map((n) => n.uid + ':' + n.title));
  const srcN = require('fs').readFileSync(path.join(ROOT, 'functions/membership-settlement.js'), 'utf8');
  ck('N9 a failed refund execution is an ops-visible structured error (REFUND_EXECUTION_FAILED) and tells the admin nothing changed',
    /logger\.error\('\[membership\] REFUND_EXECUTION_FAILED'/.test(srcN) && /nothing was changed/.test(srcN));

  /* ══ L: LATE PAYMENT vs FIVE-MINUTE UNPAID EXPIRY (the race) ══ */
  const PAYBY = '2026-01-15T09:05:00.000Z';                                   /* creation 09:00 + 5 min */
  db = setupPay({ payBy: PAYBY }); NOTES.length = 0;
  MS._test.use({ now: () => new Date('2026-01-15T09:04:59.000Z') });          /* 1 s before payBy */
  await MS.holdMembershipPayment(null, null, 'API_L1', 'int_1', 6000);
  ck('L1 boundary: payment 1 s BEFORE payBy → held + active', db._docs.get('providerMemberships/mem_000001').paymentStatus === 'paid_held');
  db = setupPay({ payBy: PAYBY }); NOTES.length = 0;
  MS._test.use({ now: () => new Date('2026-01-15T09:05:01.000Z') });          /* 1 s after */
  await MS.holdMembershipPayment(null, null, 'API_L2', 'int_1', 6000);
  const ml = db._docs.get('providerMemberships/mem_000001');
  ck('L2 payment 1 s AFTER payBy → NOT resurrected: refunded_late + expired, KES 6,000 back to the buyer wallet, ledger row',
    ml.paymentStatus === 'refunded_late' && ml.status === 'expired' && db._docs.get('users/member_1').walletBalance === 6000 && db._docs.has('ledger/member_1_API_L2_membership_latepay_refund') && !ml.nextReleaseAt, ml);
  ck('L3 the member is told "Payment refunded" — and NEVER "Membership active"', NOTES.some((n) => n.title === 'Payment refunded ↩') && !NOTES.some((n) => n.type === 'subscription_activated'), NOTES.map((n) => n.title));
  await MS.holdMembershipPayment(null, null, 'API_L2', 'int_1', 6000);
  ck('L4 the late callback replayed → no second refund (still KES 6,000)', db._docs.get('users/member_1').walletBalance === 6000);
  db = setupPay({ status: 'expired' });
  MS._test.use({ now: () => new Date('2026-01-15T09:01:00.000Z') });
  await MS.holdMembershipPayment(null, null, 'API_L5', 'int_1', 6000);
  ck('L5 an explicitly expired record is not resurrected either (refunded_late)', db._docs.get('providerMemberships/mem_000001').paymentStatus === 'refunded_late');
  r = await MS.releaseDueSlices('mem_000001', { now: D('2026-05-01T06:00:00Z'), deps });
  ck('L6 a late-refunded membership never settles to the gym', r.skipped && bal(db) === 0, r);

  /* ══ A: REFUND ATOMICITY under a real commit failure ══ */
  db = setup({ paymentRef: 'API_1' });
  await MS.requestRefund('mem_000001', { by: 'member_1', now: D('2026-01-25T10:00:00Z') });
  NOTES.length = 0; db._failOn = 'users/';                                     /* the wallet credit write fails at commit */
  let threw = null;
  try { await MS.decideRefund('mem_000001', { by: 'admin_9', decision: 'approve' }); } catch (e) { threw = e.message; }
  db._failOn = null;
  const ma = db._docs.get('providerMemberships/mem_000001');
  ck('A1 the wallet write fails → the decision THROWS (the callable turns it into "nothing was changed, please retry")', !!threw && /INJECTED_COMMIT_FAILURE/.test(threw), threw);
  ck('A2 NOTHING changed: refund still "requested", no ledger row, no wallet, membership still refund_requested',
    ma.refund.state === 'requested' && ma.status === 'refund_requested' && !db._docs.has('ledger/member_1_mem_000001_membership_refund') && !db._docs.has('users/member_1'), { refund: ma.refund, status: ma.status });
  ck('A3 no false "refund paid" notification to the member or the gym', !NOTES.some((n) => n.type === 'refund_processed' || n.title === 'Membership refunded'), NOTES);
  r = await MS.releaseDueSlices('mem_000001', { now: D('2026-04-16T06:00:00Z'), deps });
  ck('A4 a failed refund does not cancel or release payouts: still frozen, gym unpaid', r.skipped && bal(db) === 0, r);
  r = await MS.decideRefund('mem_000001', { by: 'admin_9', decision: 'approve' });
  ck('A5 the admin retries → refund completes once (KES 6,000), notifications sent now', r.ok && db._docs.get('users/member_1').walletBalance === 6000 && NOTES.some((n) => n.type === 'refund_processed'), r);

  /* ══ F: SALES SWITCH — the ONE predicate (shared/fitness-sales-switch.js), exercised for real ══ */
  const SW = require(path.join(ROOT, 'functions/shared/fitness-sales-switch.js'));
  const flagDb = (v, throws) => ({ collection: () => ({ doc: () => ({ get: async () => { if (throws) throw new Error('read failed'); return v === undefined ? { exists: false, data: () => undefined } : { exists: true, data: () => v }; } }) }) });
  const sw = await Promise.all([SW.salesEnabled(flagDb({ enabled: true })), SW.salesEnabled(flagDb({ enabled: 'true' })), SW.salesEnabled(flagDb({ enabled: 1 })),
    SW.salesEnabled(flagDb({})), SW.salesEnabled(flagDb(undefined)), SW.salesEnabled(flagDb({ enabled: true }, true))]);
  ck('F1 only boolean true opens sales: true→on; "true", 1, missing field, missing doc, READ ERROR → off', sw.join() === 'true,false,false,false,false,false', sw);
  const pp2 = require('fs').readFileSync(path.join(ROOT, 'functions/payment-purposes.js'), 'utf8');
  const fm = pp2.slice(pp2.indexOf('fitness_membership: {'), pp2.indexOf('fitness_membership: {') + 3000);
  ck('F2 the purpose uses THAT predicate (no second copy) and refuses SALES_DISABLED before reading the membership',
    /require\('\.\/shared\/fitness-sales-switch'\)\.salesEnabled\(db\(\)\)/.test(fm) && /code: 'SALES_DISABLED'/.test(fm) && !/collection('featureFlags')/.test(fm)
    && fm.indexOf('fitness-sales-switch') < fm.indexOf("collection('providerMemberships')"));

  /* ══ D: SHORT PASSES + DEFAULT OFFER CATALOGUE (owner 2026-10-03) ══ */
  const DFT = require(path.join(ROOT, 'functions/shared/fitness-offer-defaults.js'));
  const prices = DFT.OFFER_DEFAULTS.map((o) => o.label + '=' + o.priceCents / 100).join(', ');
  ck('D1 the ONE default catalogue: Daily 500, Weekly 1,500, Monthly 5,000, 3 Months 14,000, 6 Months 26,000, Annual 48,000 (KES)',
    prices === 'Daily Pass=500, Weekly Pass=1500, Monthly=5000, 3 Months=14000, 6 Months=26000, Annual=48000', prices);
  const sv = DFT.withSavings();
  ck('D2 savings are COMPUTED from the same list (3M 7%, 6M 13%, Annual 20%), never typed; single passes show none',
    sv.find((o) => o.key === 'quarter').savingPct === 7 && sv.find((o) => o.key === 'half').savingPct === 13 && sv.find((o) => o.key === 'annual').savingPct === 20 && sv.find((o) => o.key === 'daily').savingPct === null, sv.map((o) => o.key + ':' + o.savingPct));
  ck('D3 every default is a valid settlement shape (slices sum exactly to its price)',
    DFT.OFFER_DEFAULTS.every((o) => { const sl = MS.slicesOf({ priceCents: o.priceCents, periodCount: o.periodCount, periodUnit: o.periodUnit, startAt: START }); return sl.reduce((a, x) => a + x.amountCents, 0) === o.priceCents; }));
  const day = MS.slicesOf({ priceCents: 50000, periodCount: 1, periodUnit: 'day', startAt: START });
  const wk = MS.slicesOf({ priceCents: 150000, periodCount: 1, periodUnit: 'week', startAt: START });
  ck('D4 Daily and Weekly passes are ONE slice each, due at the end of the pass (Jan 16 / Jan 22)',
    day.length === 1 && day[0].dueAt.toISOString().slice(0, 10) === '2026-01-16' && wk.length === 1 && wk[0].dueAt.toISOString().slice(0, 10) === '2026-01-22', [day, wk]);
  db = setup({ priceCents: 150000, periodCount: 1, periodUnit: 'week' });
  r = await MS.releaseDueSlices('mem_000001', { now: D('2026-01-18T06:00:00Z'), deps });
  ck('D5 weekly pass, unused, mid-week → held (refundable), gym unpaid', r.released === 0 && bal(db) === 0, r);
  db = setup({ priceCents: 150000, periodCount: 1, periodUnit: 'week', attendedSessions: 1, firstAttendedAt: '2026-01-16T07:00:00Z', refundEligible: false });
  r = await MS.releaseDueSlices('mem_000001', { now: D('2026-01-22T09:30:00Z'), deps });
  ck('D6 weekly pass, used → paid at the end of the week: KES 1,425 (1,500 − 5%)', r.released === 1 && bal(db) === 1425, r);
  db = setup({ priceCents: 50000, periodCount: 1, periodUnit: 'day' });
  r = await MS.releaseDueSlices('mem_000001', { now: D('2026-01-16T09:30:00Z'), deps });
  ck('D7 daily pass never used → paid to the gym at expiry (KES 475), trigger expired_unused', r.released === 1 && r.trigger === 'expired_unused' && bal(db) === 475, r);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
