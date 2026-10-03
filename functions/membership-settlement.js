/* ============================================================================
   MEMBERSHIP SETTLEMENT — held membership money: hold → release → refund gating (owner 2026-10-03)
   ----------------------------------------------------------------------------
   Owner decisions (2026-10-03, final):
     • memberships / packages pay the SAME 5% as fitness bookings (commission-config RATES.fitness, a fixed lane)
     • "IF ATTENDED_SESSIONS = 0 → membership may be refundable … IF ATTENDED_SESSIONS >= 1 → membership becomes
       NON-REFUNDABLE"; a valid QR check-in counts as attendance ("VALID QR CHECK-IN → … NORMAL REFUND ELIGIBILITY
       LOCKED"); "DO NOT automatically calculate a proportional refund after the member attends"
     • payout (owner's choice): HOLD everything until the first attendance (still fully refundable); from the first
       attendance, release every month already passed at once, then MONTHLY; never attended and the membership ends
       without a refund request → the gym is settled at expiry
     • "Attendance QR scanning is NOT a payment" — attendance only UNLOCKS release of verified, held money

   THIS IS NOT A NEW MONEY SYSTEM. One more TRIGGER on the provider settlement used by bookings (provider-ops
   settleOnPinRelease / _settlementWrites): the same commission engine (finos-utils.calculateCommission), the same
   ledger — providerPayouts row, the provider's BUSINESS wallet wallets/{providerId}.balance in whole shillings with the
   remainder recorded, a deterministic walletTransactions id. No fitnessWallet / fitnessPayments / fitnessSettlement.

   RECORD — providerMemberships/{membershipId}. Fields by OWNER (no client writes any of them):
     creation (Fitness lane, server):  providerId, buyerUid, priceCents (integer), periodCount (1..60), periodUnit
                                       'month', startAt, category 'fitness', title
     payment (verified webhook):        paymentStatus 'paid_held'
     attendance (Fitness lane ONLY, its server check-in path — this module READS, never writes):
                                        attendedSessions (integer ≥ 0), firstAttendedAt (timestamp | null),
                                        refundEligible (false once used)
     settlement (THIS module ONLY):     paymentStatus 'partially_released' | 'released' | 'refund_requested',
                                        status 'active' | 'refund_requested', releasedPeriods, releasedCents,
                                        nextReleaseAt, refund{…}
   USED = attendedSessions ≥ 1 OR firstAttendedAt set OR refundEligible === false (any one is enough — fail toward
   "used", so a partial write can never re-open a refund).

   Each released month is CLAIMED with create() at providerMemberships/{id}/releases/{index} inside the same transaction
   as the money — a replay or a concurrent sweep cannot pay a month twice.

   SLICES: integer cents, base = floor(price / periods); the LAST month carries the remainder (sum = price exactly).
   Month k is due at the end of month k (subscription-period.periodEnd applied k times, the one period copy).

   REFUND: only a REQUEST (B9.31), only with zero attendance, only before the membership ends, only once. Execution
   belongs to the canonical refund authority (not built yet); nothing is paid out here and the auto-crediting
   `refundRequests` collection is never written. A request freezes all releases.
   ============================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

const COL = 'providerMemberships';
const HELD = Object.freeze(['paid_held', 'partially_released']);
/* Overridable ONLY by the suite (in-memory Firestore; the emulator is not required to prove the arithmetic). */
const _hooks = { db: null, ts: null, inc: null, tsFromDate: null };
const _db = () => _hooks.db || admin.firestore();
const _ts = () => (_hooks.ts ? _hooks.ts() : admin.firestore.FieldValue.serverTimestamp());
const _inc = (n) => (_hooks.inc ? _hooks.inc(n) : admin.firestore.FieldValue.increment(n));
const _tsFromDate = (d) => (_hooks.tsFromDate ? _hooks.tsFromDate(d) : admin.firestore.Timestamp.fromDate(d));

function _date(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v.toDate === 'function') return v.toDate();
  if (typeof v._seconds === 'number') return new Date(v._seconds * 1000);
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/** Pure: the month slices of a membership — [{ index, amountCents, startsAt, dueAt }]. Throws on an invalid record. */
function slicesOf(m) {
  const price = Number(m && m.priceCents);
  const n = Number(m && m.periodCount);
  const start = _date(m && m.startAt);
  if (!Number.isInteger(price) || price < 0) throw Object.assign(new Error('priceCents must be a non-negative integer'), { code: 'invalid_membership' });
  if (!Number.isInteger(n) || n < 1 || n > 60) throw Object.assign(new Error('periodCount must be 1..60'), { code: 'invalid_membership' });
  if (!start) throw Object.assign(new Error('startAt missing'), { code: 'invalid_membership' });
  if ((m.periodUnit || 'month') !== 'month') throw Object.assign(new Error('only monthly periods are decided'), { code: 'invalid_membership' });
  const { periodEnd } = require('./subscription-period');
  const base = Math.floor(price / n);
  const out = [];
  let from = start;
  for (let i = 0; i < n; i++) {
    const due = periodEnd(from, 'monthly');
    out.push({ index: i, amountCents: i === n - 1 ? price - base * (n - 1) : base, startsAt: from, dueAt: due });
    from = due;
  }
  return out;
}

/** The settlement fields the VERIFIED payment webhook writes when it marks a membership held (one owner of their
    initial values). The webhook adds paymentStatus/payment provenance itself; this returns only settlement state. */
function initialSettlementFields(m) {
  const first = slicesOf(m)[0];
  return { releasedPeriods: 0, releasedCents: 0, status: 'active', refund: null, nextReleaseAt: _tsFromDate(first.dueAt) };
}

/** Has the member used the membership? (read-only over the Fitness lane's attendance fields; fails toward "used") */
function isUsed(m) {
  return (Number(m && m.attendedSessions) || 0) >= 1 || !!(m && m.firstAttendedAt) || (m && m.refundEligible === false);
}
/** When the membership ends (the last month's due date). */
function endsAt(m) { const sl = slicesOf(m); return sl[sl.length - 1].dueAt; }

/** Pure: which unreleased slices may be released at `now`. Unused + not ended → none (held, refundable). */
function dueSlices(m, now) {
  const t = (now || new Date()).getTime();
  const from = Number(m.releasedPeriods) || 0;
  const used = isUsed(m);
  if (!used && t < endsAt(m).getTime()) return [];
  return slicesOf(m).filter((s) => s.index >= from && s.dueAt.getTime() <= t);
}

/** Pure: may a refund be requested now? → { ok:true, amountCents } | { ok:false, code, reason } */
function refundDecision(m, now) {
  const t = (now || new Date()).getTime();
  if (!m) return { ok: false, code: 'missing', reason: 'Membership not found.' };
  if (m.refund && m.refund.state) return { ok: false, code: 'refund_exists', reason: 'A refund has already been requested for this membership.' };
  if (!['paid_held'].includes(m.paymentStatus)) return { ok: false, code: 'not_refundable_state', reason: 'This membership is not in a refundable state.' };
  if (isUsed(m)) {
    const n = Math.max(1, Number(m.attendedSessions) || 0);
    return { ok: false, code: 'used', reason: 'Refund unavailable because this membership has already been used.',
             detail: 'Member attended ' + n + ' session' + (n === 1 ? '' : 's') + '.' };
  }
  if (t >= endsAt(m).getTime()) return { ok: false, code: 'ended', reason: 'This membership has ended.' };
  if ((Number(m.releasedPeriods) || 0) > 0) return { ok: false, code: 'released', reason: 'Part of this membership has already been settled.' };
  return { ok: true, amountCents: Number(m.priceCents) };
}

/* Commission for each slice from the ONE engine, computed before the transaction (the engine reads Firestore). */
async function _priceSlices(m, slices, deps) {
  const calc = (deps && deps.calculateCommission) || require('./finos-utils').calculateCommission;
  const out = [];
  for (const s of slices) {
    const comm = await calc(_db(), { orderAmountCents: s.amountCents, sellerId: m.providerId, category: m.category || 'fitness' });
    out.push({ slice: s, comm });
  }
  return out;
}

/* Ledger writes for one released slice — same collections and field meanings as provider-ops._settlementWrites. */
function _sliceWrites(t, { ref, m, slice, comm, trigger }) {
  const id = ref.id;
  const gross = slice.amountCents;
  const commission = comm.commissionCents;
  const net = gross - commission;
  const shillings = Math.floor(net / 100);
  const remainder = net - shillings * 100;
  const key = `${id}_m${slice.index}`;
  t.create(ref.collection('releases').doc(String(slice.index)), {   /* the exactly-once claim */
    index: slice.index, gross, commission, net, trigger, releasedAt: _ts(),
  });
  t.set(_db().collection('providerPayouts').doc(key), {
    providerId: m.providerId, membershipId: id, periodIndex: slice.index, sourceType: 'membership', sourceId: id,
    gross, commission, commissionRate: comm.effectiveRate / 100, fee: 0, net, settlementCents: net, amount: net,
    currency: 'KES', status: 'settled', createdAt: _ts(), settledAt: _ts(), settledTrigger: trigger,
    walletCredited: shillings >= 1, netShillingsCredited: shillings >= 1 ? shillings : 0, remainderCents: remainder,
    walletTxnId: shillings >= 1 ? `${m.providerId}_${key}_membership` : null,
    commissionPct: comm.effectiveRate, baseRate: comm.baseRate, pricingSource: comm.pricingSource,
    ruleId: comm.ruleId, ruleSource: comm.ruleSource, fixedRateCategory: comm.fixedRateCategory === true,
    hubType: 'provider', category: comm.category, idempotencyKey: key,
    calculatedAt: comm.calculatedAt || null, engineVersion: comm.engineVersion || null,
  });
  if (shillings >= 1) {
    t.set(_db().collection('wallets').doc(m.providerId), { balance: _inc(shillings), updatedAt: _ts() }, { merge: true });
    t.set(_db().collection('walletTransactions').doc(`${m.providerId}_${key}_membership`), {
      uid: m.providerId, type: 'membership_earning', amount: shillings,
      description: `Membership — month ${slice.index + 1}${m.title ? ' · ' + String(m.title).slice(0, 80) : ''}`,
      membershipId: id, periodIndex: slice.index, sourceType: 'membership', sourceId: id, trigger, status: 'completed', createdAt: _ts(),
    });
  }
  return { gross, commission, net, credited: shillings >= 1 ? shillings : 0 };
}

/**
 * releaseDueSlices(membershipId, { now, trigger }) — release what may be released: nothing while unused and running;
 * every passed month once used (catch-up, then monthly); everything at expiry if never used and no refund was
 * requested. Idempotent; safe from the daily sweep, from the Fitness lane right after a first check-in, or twice at once.
 */
async function releaseDueSlices(membershipId, opts) {
  const o = opts || {};
  const now = o.now || new Date();
  const ref = _db().collection(COL).doc(String(membershipId));
  const snap = await ref.get();
  if (!snap.exists) return { skipped: 'missing' };
  const m = snap.data();
  if (!HELD.includes(m.paymentStatus)) return { skipped: `payment_${m.paymentStatus}` };
  if (m.status !== 'active') return { skipped: `status_${m.status}` };
  const due = dueSlices(m, now);
  if (!due.length) return { released: 0, held: !isUsed(m) };
  const priced = await _priceSlices(m, due, o.deps);
  let out = null;
  await _db().runTransaction(async (t) => {
    const cur = (await t.get(ref)).data();
    if (!cur || !HELD.includes(cur.paymentStatus) || cur.status !== 'active' || (Number(cur.releasedPeriods) || 0) !== (Number(m.releasedPeriods) || 0)
        || (cur.refund && cur.refund.state) || dueSlices(cur, now).length !== due.length) {
      out = { skipped: 'changed_concurrently' }; return;
    }
    const trigger = o.trigger || (isUsed(cur) ? 'period_passed' : 'expired_unused');
    let releasedCents = 0, credited = 0;
    for (const p of priced) { const r = _sliceWrites(t, { ref, m: cur, slice: p.slice, comm: p.comm, trigger }); releasedCents += r.gross; credited += r.credited; }
    const done = (Number(cur.releasedPeriods) || 0) + priced.length;
    const all = slicesOf(cur);
    const next = all[done];
    t.update(ref, {
      releasedPeriods: done, releasedCents: _inc(releasedCents),
      paymentStatus: done >= all.length ? 'released' : 'partially_released',
      nextReleaseAt: next ? _tsFromDate(next.dueAt) : null,
      updatedAt: _ts(),
    });
    out = { released: priced.length, releasedCents, credited, trigger };
  });
  if (out && out.released) logger.info('membership release', { membershipId, providerId: m.providerId, released: out.released, releasedCents: out.releasedCents, trigger: out.trigger });
  return out;
}

/**
 * requestRefund(membershipId, { by, now }) — the member (or an admin) asks for a refund. Allowed ONLY with zero
 * attendance, before the end, once; becomes a REQUEST for the canonical refund authority and freezes releases.
 */
async function requestRefund(membershipId, opts) {
  const o = opts || {};
  const now = o.now || new Date();
  const ref = _db().collection(COL).doc(String(membershipId));
  let out = null;
  await _db().runTransaction(async (t) => {
    const s0 = await t.get(ref);
    const cur = s0.exists ? s0.data() : null;
    const dec = refundDecision(cur, now);
    if (!dec.ok) { out = { ok: false, code: dec.code, reason: dec.reason, detail: dec.detail || null }; return; }
    t.update(ref, {
      status: 'refund_requested', paymentStatus: 'refund_requested', nextReleaseAt: null, updatedAt: _ts(),
      refund: { state: 'requested', amountCents: dec.amountCents, attendedSessionsAtRequest: Number(cur.attendedSessions) || 0,
                requestedBy: o.by || null, requestedAt: _ts(),
                note: 'Zero attendance — awaiting the canonical refund authority (B9.31). Nothing has been paid out.' },
    });
    out = { ok: true, refundRequestedCents: dec.amountCents };
  });
  logger.info('membership refund request', { membershipId, by: o.by || null, ok: out && out.ok, code: out && out.code });
  return out;
}

/* ── deployables ─────────────────────────────────────────────────────────── */
/* Daily 06:00 Nairobi: release every membership whose next month has passed. Single-field range query
   (nextReleaseAt) — no composite index; the held/active filter is re-checked per document inside its txn. */
const membershipReleaseSweep = onSchedule({ schedule: '0 6 * * *', timeZone: 'Africa/Nairobi', region: 'us-central1', timeoutSeconds: 300 }, async () => {
  const now = new Date();
  const q = await _db().collection(COL).where('nextReleaseAt', '<=', _tsFromDate(now)).limit(300).get();
  let released = 0, failed = 0;
  for (const d of q.docs) {
    try { const r = await releaseDueSlices(d.id, { now, trigger: 'period_passed' }); released += (r && r.released) || 0; }
    catch (e) { failed++; logger.error('membership sweep item failed', { membershipId: d.id, error: (e && e.message) || 'Error' }); }
  }
  logger.info('membership sweep', { scanned: q.size, released, failed });
});

/* The member (buyerUid) or an admin requests a refund. The membership id is the only input — attendance, amounts and
   state are read from the record; a browser cannot claim "0 sessions". */
const membershipRequestRefund = onCall({ region: 'us-central1', maxInstances: 20 }, async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const id = String((req.data && req.data.membershipId) || '');
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(id)) throw new HttpsError('invalid-argument', 'membershipId required.');
  const snap = await _db().collection(COL).doc(id).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Membership not found.');
  const isAdmin = req.auth.token && (req.auth.token.admin === true || req.auth.token.superAdmin === true);
  if (snap.data().buyerUid !== uid && !isAdmin) throw new HttpsError('permission-denied', 'Not your membership.');
  const r = await requestRefund(id, { by: uid });
  if (!r || !r.ok) throw new HttpsError('failed-precondition', (r && r.reason) || 'Refund unavailable.', { code: r && r.code, detail: r && r.detail });
  return { ok: true, refundRequestedCents: r.refundRequestedCents, state: 'requested' };
});

module.exports = { slicesOf, initialSettlementFields, dueSlices, isUsed, endsAt, refundDecision, releaseDueSlices, requestRefund,
                   membershipReleaseSweep, membershipRequestRefund, COL,
                   _test: { use: (h) => Object.assign(_hooks, h || {}) } };
