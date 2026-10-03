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

   PAYMENT (owner 2026-10-03: money side owns intake): payment-purposes 'fitness_membership' prices the membership from
   THIS record (never the browser), bound to the buyer; the verified webhook calls holdMembershipPayment, which checks
   the intent → membership binding, the amount (provider-confirmed KES == priceCents) and replay, then marks it
   paid_held + active. A mismatch is parked as 'payment_review' — never activated. A payment landing AFTER payBy (or on an
   expired record) never resurrects it: it is refunded to the buyer's SOKONI wallet (paymentStatus 'refunded_late'),
   exactly as a late booking payment is.

   REFUND (B9.31): request → a SECOND authorized actor decides → execution. Requested only with zero attendance, before
   the end, once (requestRefund) — or as an explicit AdminOS EXCEPTION (requestException: admin, reason required,
   attendance preserved, refunds the unreleased held balance). decideRefund: an admin who is NOT the requester, buyer or
   provider approves or rejects; approval EXECUTES through the canonical held-money refund destination — the buyer's
   SOKONI wallet (users/{uid}.walletBalance + a deterministic `ledger` row), exactly as provider-ops._disburseHeldFunds and
   the late-payment refund do. A normal (non-exception) approval re-checks attendance inside its transaction. Rejection
   resumes the schedule. The auto-crediting `refundRequests` collection is never written. Every step is audited at
   providerMemberships/{id}/events.
   ============================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

const COL = 'providerMemberships';
const HELD = Object.freeze(['paid_held', 'partially_released']);
/* Overridable ONLY by the suite (in-memory Firestore; the emulator is not required to prove the arithmetic). */
const _hooks = { db: null, ts: null, inc: null, tsFromDate: null, now: null, notify: null };
const _now = () => (_hooks.now ? _hooks.now() : new Date());
/* Notifications through the ONE sender (notify.js); the suite may capture them. Never throws into money paths. */
async function _notify(args) {
  try {
    if (_hooks.notify) return _hooks.notify(args);
    if (_hooks.db) return null;
    await require('./notify').notify(Object.assign({ awaitDelivery: false }, args)).catch(() => {});
  } catch (_) { /* optional */ }
  return null;
}
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
    _event(t, ref, 'settlement_released', { months: priced.map((p) => p.slice.index), releasedCents, trigger });
    out = { released: priced.length, releasedCents, credited, trigger };
  });
  if (out && out.released) {
    logger.info('membership release', { membershipId, providerId: m.providerId, released: out.released, releasedCents: out.releasedCents, trigger: out.trigger });
    await _notify({ uid: m.providerId, type: 'wallet_credit', title: 'Membership earnings released 💰', body: `${out.released} month${out.released === 1 ? '' : 's'} of ${m.title || 'a membership'} settled to your business wallet (KES ${out.credited.toLocaleString()} after SOKONI's commission).`, dedupeKey: `membership_settle_${membershipId}_${(Number(m.releasedPeriods) || 0) + out.released}` });
    const all = slicesOf(m);
    if ((Number(m.releasedPeriods) || 0) + out.released >= all.length) {
      await _notify({ uid: m.buyerUid, type: 'subscription_expired', title: 'Membership ended', body: `Your ${m.title || 'membership'} has reached its end date.`, dedupeKey: `membership_ended_${membershipId}` });
    }
  }
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
      refund: { state: 'requested', amountCents: dec.amountCents, attendedSessionsAtRequest: Number(cur.attendedSessions) || 0, previousPaymentStatus: cur.paymentStatus,
                requestedBy: o.by || null, requestedAt: _ts(),
                note: 'Zero attendance — awaiting the canonical refund authority (B9.31). Nothing has been paid out.' },
    });
    _event(t, ref, 'refund_requested', { by: o.by || null, amountCents: dec.amountCents, attendedSessionsSeen: 0 });
    out = { ok: true, refundRequestedCents: dec.amountCents };
  });
  logger.info('membership refund request', { membershipId, by: o.by || null, ok: out && out.ok, code: out && out.code });
  if (out && out.ok) {
    const m = (await ref.get()).data() || {};
    await _notify({ uid: m.buyerUid, type: 'booking_refund', title: 'Refund request received', body: `We received your refund request for ${m.title || 'your membership'}. A SOKONI reviewer will decide it.`, dedupeKey: `membership_refund_req_${membershipId}` });
    await _notify({ uid: m.providerId, type: 'booking_refund', title: 'Membership refund requested', body: `A member who has not attended asked for a refund of ${m.title || 'a membership'}. Payouts are paused until SOKONI decides.`, dedupeKey: `membership_refund_req_gym_${membershipId}` });
  }
  return out;
}

/* ── AUDIT: one append-only event per lifecycle step (AdminOS reads the whole story from here) ── */
function _event(t, ref, type, data) {
  t.set(ref.collection('events').doc(), Object.assign({ type, at: _ts() }, data || {}));
}

/**
 * holdMembershipPayment(db, adminSdk, apiRef, intentRef, amountKES) — called by the verified IntaSend webhook next to
 * holdServiceBookingPayment. Returns true when the intent is a membership (caller responds 200 and skips ALL credit
 * logic). The membership id comes from the SERVER-MINTED intent, never client metadata. Moves no money.
 */
async function holdMembershipPayment(db, adminSdk, apiRef, intentRef, amountKES) {
  const D = _hooks.db || db || _db();
  let intent = null;
  try {
    const iSnap = await D.collection('paymentIntents').doc(intentRef || apiRef).get();
    if (iSnap.exists && iSnap.data().resourceType === 'providerMembership') intent = iSnap.data();
  } catch (_) { return false; }
  if (!intent || !intent.resourceId) return false;
  const ref = D.collection(COL).doc(String(intent.resourceId));
  let outcome = null;
  try {
    outcome = await D.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) return 'no-membership';
      const m = snap.data();
      if (m.paymentStatus && m.paymentStatus !== 'pending') return 'noop';                     /* replay / already handled */
      /* LATE PAYMENT (owner 2026-10-03: a stale callback "MUST NOT silently resurrect" an expired unpaid membership).
         The canonical answer is the one the booking hold already gives a payment that lands on a dead booking
         (booking-payment-sweep.holdServiceBookingPayment): do NOT activate; return the money to the buyer's SOKONI
         wallet with a deterministic ledger row, mark the record, tell the member. Expired = the creation path's payBy
         has passed, or the record was explicitly expired. */
      const nowL = _now();
      const payByMs = m.payBy ? (_date(m.payBy) || new Date(0)).getTime() : null;
      if (m.status === 'expired' || (payByMs !== null && nowL.getTime() > payByMs)) {
        const paidL = Math.max(0, Math.round((Number(amountKES) || 0) * 100));
        const shillingsL = Math.floor(paidL / 100);
        if (shillingsL >= 1 && m.buyerUid) {
          t.set(D.collection('users').doc(m.buyerUid), { walletBalance: _inc(shillingsL) }, { merge: true });
          t.create(D.collection('ledger').doc(`${m.buyerUid}_${apiRef}_membership_latepay_refund`), {
            uid: m.buyerUid, type: 'membership_refund', credit: shillingsL, membershipId: ref.id, paymentRef: apiRef,
            reason: 'paid_after_expiry', createdAt: _ts() });
        }
        t.update(ref, { paymentStatus: 'refunded_late', status: 'expired', paymentRef: apiRef, refundedCents: paidL,
                        refundReason: 'paid_after_expiry', updatedAt: _ts() });
        _event(t, ref, 'payment_late_refunded', { apiRef, paidCents: paidL, shillings: shillingsL });
        return 'late_refunded';
      }
      const paidCents = Math.round((Number(amountKES) || 0) * 100);
      const bound = intent.uid === m.buyerUid && (intent.currency || 'KES') === 'KES' && Number(intent.amountCents) === Number(m.priceCents);
      if (!bound || paidCents !== Number(m.priceCents)) {
        t.update(ref, { paymentStatus: 'payment_review', paymentRef: apiRef, paymentReviewReason: !bound ? 'intent_binding' : 'amount_mismatch',
                        paidCentsReported: paidCents, updatedAt: _ts() });
        _event(t, ref, 'payment_review', { apiRef, paidCents, expectedCents: m.priceCents, reason: !bound ? 'intent_binding' : 'amount_mismatch' });
        return 'review';
      }
      /* The months run from PAYMENT, not from when the record was created: a membership created on the 1st and paid
         on the 9th starts on the 9th. A deliberately later start (startAt in the future) is kept. */
      const now = _now();
      const chosen = _date(m.startAt);
      const start = chosen && chosen.getTime() > now.getTime() ? chosen : now;
      const eff = Object.assign({}, m, { startAt: start });
      t.update(ref, Object.assign({ paymentStatus: 'paid_held', paymentRef: apiRef, paidAt: _ts(), heldCents: paidCents, updatedAt: _ts(),
        startAt: _tsFromDate(start), requestedStartAt: m.startAt || null }, initialSettlementFields(eff)));
      _event(t, ref, 'payment_held', { apiRef, heldCents: paidCents });
      return 'held';
    });
  } catch (e) {
    logger.error('[membership] hold failed (recoverable, payment stands)', { apiRef, error: (e && e.message) || 'Error' });
    return true;
  }
  if (outcome === 'held' || outcome === 'review' || outcome === 'late_refunded') {
    const st = outcome === 'held' ? 'paid' : outcome === 'review' ? 'review' : 'refunded';
    await D.collection('paymentIntents').doc(intentRef || apiRef).set({ status: st, paidRef: apiRef, paidAt: _ts() }, { merge: true }).catch(() => {});
  }
  if (outcome === 'late_refunded') {
    const m = (await ref.get()).data() || {};
    await _notify({ uid: m.buyerUid, type: 'booking_refund', title: 'Payment refunded ↩', body: `Your payment for ${m.title || 'a membership'} arrived after the offer expired, so the membership was not started and the money is back in your SOKONI wallet. Ref ${apiRef}.`, dedupeKey: `membership_latepay_${apiRef}` });
  }
  if (outcome === 'review') {
    const m = (await ref.get()).data() || {};
    await _notify({ uid: m.buyerUid, type: 'payment_failed', title: 'Payment under review', body: `We received a payment for ${m.title || 'your membership'} that we need to check before activating it. Ref ${apiRef}. Our team will follow up — you have not been charged twice.`, dedupeKey: `membership_review_${apiRef}` });
  }
  if (outcome === 'held') {
    const m = (await ref.get()).data() || {};
    await _notify({ uid: m.buyerUid, type: 'subscription_activated', title: 'Membership active ✅', body: `Payment confirmed — your ${m.title || 'membership'} is active. Ref ${apiRef}.`, dedupeKey: `membership_active_${apiRef}` });
    await _notify({ uid: m.providerId, type: 'booking_new', title: 'New membership 🏋️', body: `A member has paid for ${m.title || 'a membership'}. SOKONI holds the money and releases it monthly after their first visit.`, deepLink: '/provider-dashboard.html', dedupeKey: `membership_new_${apiRef}` });
  }
  logger.info('[membership] payment ' + outcome, { apiRef, membershipId: intent.resourceId });
  return true;
}

/**
 * requestException(membershipId, { by, reason }) — AdminOS exception for a membership whose normal refund is locked.
 * Explicit, reasoned, audited; attendance is PRESERVED; it refunds only the unreleased held balance and still needs a
 * SECOND admin's decision (decideRefund).
 */
async function requestException(membershipId, opts) {
  const o = opts || {};
  const reason = String(o.reason || '').trim();
  if (reason.length < 10) return { ok: false, code: 'reason_required', reason: 'An exception needs a written reason (at least 10 characters).' };
  const ref = _db().collection(COL).doc(String(membershipId));
  let out = null;
  await _db().runTransaction(async (t) => {
    const snap = await t.get(ref);
    const m = snap.exists ? snap.data() : null;
    if (!m) { out = { ok: false, code: 'missing', reason: 'Membership not found.' }; return; }
    if (m.refund && ['requested', 'refunded'].includes(m.refund.state)) { out = { ok: false, code: 'refund_exists', reason: 'A refund is already open or completed.' }; return; }
    if (!HELD.includes(m.paymentStatus) || m.status !== 'active') { out = { ok: false, code: 'not_refundable_state', reason: 'This membership holds no refundable balance.' }; return; }
    const remaining = Number(m.priceCents) - (Number(m.releasedCents) || 0);
    if (!(remaining > 0)) { out = { ok: false, code: 'nothing_held', reason: 'Everything has already been settled to the gym.' }; return; }
    t.update(ref, { status: 'refund_requested', paymentStatus: 'refund_requested', nextReleaseAt: null, updatedAt: _ts(),
      refund: { state: 'requested', exception: true, amountCents: remaining, reason: reason.slice(0, 500),
                attendedSessionsAtRequest: Number(m.attendedSessions) || 0, used: isUsed(m),
                requestedBy: o.by || null, requestedAt: _ts(), previousPaymentStatus: m.paymentStatus } });
    _event(t, ref, 'refund_exception_requested', { by: o.by || null, amountCents: remaining, reason: reason.slice(0, 500), attendedSessionsSeen: Number(m.attendedSessions) || 0 });
    out = { ok: true, refundRequestedCents: remaining, exception: true, buyerUid: m.buyerUid, providerId: m.providerId, title: m.title || null };
  });
  if (out && out.ok) {
    await _notify({ uid: out.buyerUid, type: 'booking_refund', title: 'Refund review opened', body: `SOKONI opened a review of a possible refund for ${out.title || 'your membership'}. A second reviewer will decide it.`, dedupeKey: `membership_exception_${membershipId}` });
    await _notify({ uid: out.providerId, type: 'booking_refund', title: 'Membership refund under review', body: `SOKONI is reviewing an exceptional refund for ${out.title || 'a membership'}. Remaining payouts are paused until it is decided.`, dedupeKey: `membership_exception_gym_${membershipId}` });
    delete out.buyerUid; delete out.providerId; delete out.title;
  }
  return out;
}

/**
 * decideRefund(membershipId, { by, decision: 'approve'|'reject', reason }) — the SECOND authorized actor. Approval
 * executes through the canonical held-money refund destination (buyer SOKONI wallet + deterministic ledger row).
 */
async function decideRefund(membershipId, opts) {
  const o = opts || {};
  if (!['approve', 'reject'].includes(o.decision)) return { ok: false, code: 'bad_decision', reason: 'Decision must be approve or reject.' };
  const ref = _db().collection(COL).doc(String(membershipId));
  let out = null, notifyArgs = null, gymNotice = null;
  await _db().runTransaction(async (t) => {
    const snap = await t.get(ref);
    const m = snap.exists ? snap.data() : null;
    if (!m) { out = { ok: false, code: 'missing', reason: 'Membership not found.' }; return; }
    const r = m.refund || {};
    if (r.state !== 'requested') { out = { ok: false, code: 'no_open_request', reason: r.state === 'refunded' ? 'This membership has already been refunded.' : 'There is no open refund request.' }; return; }
    if (!o.by || o.by === r.requestedBy || o.by === m.buyerUid || o.by === m.providerId) {
      out = { ok: false, code: 'separation_of_duties', reason: 'The refund must be decided by a different authorized person than the one who requested it.' }; return;
    }
    if (o.decision === 'reject') {
      const resumeStatus = (Number(m.releasedPeriods) || 0) > 0 ? 'partially_released' : 'paid_held';
      const next = slicesOf(m)[Number(m.releasedPeriods) || 0];
      t.update(ref, { status: 'active', paymentStatus: r.previousPaymentStatus || resumeStatus, nextReleaseAt: next ? _tsFromDate(next.dueAt) : null, updatedAt: _ts(),
        refund: Object.assign({}, r, { state: 'rejected', decidedBy: o.by, decidedAt: _ts(), decisionReason: String(o.reason || '').slice(0, 500) }) });
      _event(t, ref, 'refund_rejected', { by: o.by, reason: String(o.reason || '').slice(0, 500) });
      out = { ok: true, state: 'rejected' };
      notifyArgs = { uid: m.buyerUid, type: 'booking_refund', title: 'Refund request declined', body: 'Your membership refund request was reviewed and declined.' + (o.reason ? ' Reason: ' + String(o.reason).slice(0, 200) : '') };
      return;
    }
    /* APPROVE — re-verify everything inside the transaction */
    if (!r.exception && isUsed(m)) { out = { ok: false, code: 'used', reason: 'Refund unavailable because this membership has already been used.' }; return; }
    const remaining = Number(m.priceCents) - (Number(m.releasedCents) || 0);
    const amount = Number(r.amountCents);
    if (!(amount > 0) || amount > remaining) { out = { ok: false, code: 'amount_invalid', reason: 'The refund exceeds the balance SOKONI still holds.' }; return; }
    if (!m.paymentRef) { out = { ok: false, code: 'no_verified_payment', reason: 'No verified payment is recorded for this membership.' }; return; }
    const shillings = Math.floor(amount / 100);
    const ledgerRef = _db().collection('ledger').doc(`${m.buyerUid}_${ref.id}_membership_refund`);
    t.create(ledgerRef, { uid: m.buyerUid, type: 'membership_refund', credit: shillings, remainderCents: amount - shillings * 100,
      membershipId: ref.id, paymentRef: m.paymentRef, exception: r.exception === true, approvedBy: o.by, createdAt: _ts() });
    if (shillings >= 1) t.set(_db().collection('users').doc(m.buyerUid), { walletBalance: _inc(shillings) }, { merge: true });
    t.update(ref, { status: 'refunded', paymentStatus: 'refunded', nextReleaseAt: null, refundedCents: amount, updatedAt: _ts(),
      refund: Object.assign({}, r, { state: 'refunded', decidedBy: o.by, decidedAt: _ts(), decisionReason: String(o.reason || '').slice(0, 500),
        executedAt: _ts(), destination: 'sokoni_wallet', walletCreditShillings: shillings, ledgerId: ledgerRef.id }) });
    _event(t, ref, 'refund_executed', { by: o.by, amountCents: amount, shillings, exception: r.exception === true, destination: 'sokoni_wallet' });
    out = { ok: true, state: 'refunded', amountCents: amount, walletCreditShillings: shillings };
    notifyArgs = { uid: m.buyerUid, type: 'refund_processed', title: 'Membership refunded ↩', body: `KES ${shillings.toLocaleString()} has been returned to your SOKONI wallet.` };
    gymNotice = { uid: m.providerId, type: 'booking_refund', title: 'Membership refunded', body: `${m.title || 'A membership'} was refunded to the member after review. Its remaining payouts are cancelled; months already settled to you are unaffected.` };
  });
  if (notifyArgs) await _notify(Object.assign({ dedupeKey: `membership_refund_${membershipId}_${out.state}` }, notifyArgs));
  if (gymNotice) await _notify(Object.assign({ dedupeKey: `membership_refund_gym_${membershipId}` }, gymNotice));
  logger.info('[membership] refund decision', { membershipId, by: o.by || null, decision: o.decision, ok: out && out.ok, code: out && out.code });
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

const _admin = (req) => !!(req.auth && req.auth.token && (req.auth.token.admin === true || req.auth.token.superAdmin === true));
const _idOf = (req) => { const id = String((req.data && req.data.membershipId) || ''); if (!/^[A-Za-z0-9_-]{6,128}$/.test(id)) throw new HttpsError('invalid-argument', 'membershipId required.'); return id; };

/* AdminOS: approve / reject an open request. Admin only; the decider must differ from the requester (enforced inside). */
const membershipDecideRefund = onCall({ region: 'us-central1', maxInstances: 10 }, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  if (!_admin(req)) throw new HttpsError('permission-denied', 'Only an authorized administrator can decide refunds.');
  let r;
  try { r = await decideRefund(_idOf(req), { by: req.auth.uid, decision: req.data && req.data.decision, reason: req.data && req.data.reason }); }
  catch (e) {
    /* The wallet credit is inside the decision transaction — a failure leaves NOTHING half-done (no credit, no state change).
       It is surfaced to the deciding admin and as a structured ops error; there is no admin recipient list to notify. */
    logger.error('[membership] REFUND_EXECUTION_FAILED', { membershipId: req.data && req.data.membershipId, by: req.auth.uid, error: (e && e.message) || 'Error' });
    throw new HttpsError('internal', 'The refund could not be executed; nothing was changed. Please retry.');
  }
  if (!r || !r.ok) throw new HttpsError('failed-precondition', (r && r.reason) || 'Not possible.', { code: r && r.code });
  return r;
});

/* AdminOS: exception for a used membership — admin only, written reason, still needs a SECOND admin's decision. */
const membershipRequestException = onCall({ region: 'us-central1', maxInstances: 10 }, async (req) => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  if (!_admin(req)) throw new HttpsError('permission-denied', 'Only an authorized administrator can open an exception.');
  const r = await requestException(_idOf(req), { by: req.auth.uid, reason: req.data && req.data.reason });
  if (!r || !r.ok) throw new HttpsError('failed-precondition', (r && r.reason) || 'Not possible.', { code: r && r.code });
  return r;
});

module.exports = { slicesOf, initialSettlementFields, dueSlices, isUsed, endsAt, refundDecision, releaseDueSlices, requestRefund,
                   holdMembershipPayment, requestException, decideRefund,
                   membershipReleaseSweep, membershipRequestRefund, membershipDecideRefund, membershipRequestException, COL,
                   _test: { use: (h) => Object.assign(_hooks, h || {}) } };
