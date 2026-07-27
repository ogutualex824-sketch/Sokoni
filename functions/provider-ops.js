'use strict';
/**
 * SOKONI Provider Ops — post-onboarding dashboard + service management handlers.
 *
 * Fills the gaps left by provider-onboarding.js (which owns onboarding/publish):
 *   • 7 dashboard handlers the Provider Dashboard already calls but that did not
 *     exist (bookings actions, earnings, payout, reviews).
 *   • Subscription COMMISSION enforcement — applied at booking completion, the
 *     one place real money is computed (rate read from providerSubscriptions).
 *   • LISTINGS-LIMIT enforcement — providerServices respects plan limits.listings.
 *   • Creates the 4 collections the onboarding module only named in a comment:
 *     providerPortfolio, providerServices, providerCalendar, providerAnalytics.
 *
 * All ops route through providerDispatch — ZERO new Cloud Run services.
 * Every op requires auth and verifies resource ownership (providerId === uid).
 */

const { HttpsError }               = require('firebase-functions/v2/https');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const logger                       = require('firebase-functions/logger');
const subCore                      = require('./subscription-core');
const legal                        = require('./legal-agreements');
const rc                           = require('./reservation-core');

const _db  = () => getFirestore();
const _ts  = () => FieldValue.serverTimestamp();
const _inc = (n) => FieldValue.increment(n);
const _san = (v, n = 500) => String(v == null ? '' : v).slice(0, n).replace(/[<>]/g, '');
/* Service images — https URLs only, capped. Money fields (price/fee/deposit) are
   integer CENTS in storage; the UI converts to/from KSh (platform money invariant). */
const _cents  = (v) => Math.max(0, Math.round(Number(v) || 0));
const _images = (a) => (Array.isArray(a) ? a : []).filter(u => typeof u === 'string' && /^https:\/\//i.test(u)).slice(0, 8);

function _uid(req) {
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Authentication required.');
  return uid;
}

/* Provider's effective commission rate — resolved through the canonical
   subscription-core seam (unifies providerSubscriptions + accountSubscriptions),
   so the provider hub and UEOE can never disagree on the rate charged. */
async function _commissionRate(uid) {
  return subCore.getCommissionRate(uid, { role: 'provider' });
}

/* Load a booking and assert the caller owns it. Returns {ref, data}. */
async function _ownBooking(uid, bookingId) {
  const id = _san(bookingId, 128);
  if (!id) throw new HttpsError('invalid-argument', 'bookingId is required.');
  const ref  = _db().collection('providerBookings').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Booking not found.');
  const data = snap.data();
  if (data.providerId !== uid) throw new HttpsError('permission-denied', 'Not your booking.');
  return { ref, data };
}

/* The slot lock a booking holds (providerAvailability/{providerId}/slotLocks/{slotKey}).
   Booking Lifecycle Contract §3.2: an active booking holds exactly one lock; every
   terminal transition must release it. Prefer the stored slotKey; fall back to
   recomputing it from the booking's times (older docs pre-date the stored field). */
function _slotLockRef(providerId, b) {
  const key = b.slotKey || ((b.date && b.startTs && b.endTs) ? rc.slotKey(b.date, b.startTs, b.endTs) : null);
  if (!key) return null;
  return _db().collection('providerAvailability').doc(providerId).collection('slotLocks').doc(String(key));
}

const _h = {};
exports._h = _h;

/* ── 1. providerConfirmBooking ───────────────────────────────────────────────
   pending → confirmed. Also mirrors the slot into providerCalendar. */
_h.providerConfirmBooking = async (req) => {
  const uid = _uid(req);
  await legal.assertLegalCompliance(uid, 'provider'); // receive booking — dark-launched
  const { ref, data } = await _ownBooking(uid, req.data?.bookingId);
  if (!['pending', 'requested'].includes(data.status)) {
    throw new HttpsError('failed-precondition', `Cannot confirm a booking that is "${data.status}".`);
  }
  const batch = _db().batch();
  batch.update(ref, { status: 'confirmed', confirmedAt: _ts(), updatedAt: _ts() });
  // providerCalendar — busy slot (idempotent doc id = booking id)
  batch.set(_db().collection('providerCalendar').doc(ref.id), {
    providerId: uid, bookingId: ref.id, status: 'busy',
    scheduledAt: data.scheduledAt || null, service: _san(data.service, 200),
    customerName: _san(data.customerName, 200), createdAt: _ts(),
  }, { merge: true });
  await batch.commit();
  return { success: true, status: 'confirmed' };
};

/* ── 2. providerDeclineBooking ───────────────────────────────────────────────
   pending → declined. Frees any calendar hold. */
_h.providerDeclineBooking = async (req) => {
  const uid = _uid(req);
  const { ref, data } = await _ownBooking(uid, req.data?.bookingId);
  if (['completed', 'cancelled'].includes(data.status)) {
    throw new HttpsError('failed-precondition', `Cannot decline a "${data.status}" booking.`);
  }
  const batch = _db().batch();
  batch.update(ref, { status: 'declined', declinedAt: _ts(), updatedAt: _ts(),
    declineReason: _san(req.data?.reason, 300) || null });
  batch.delete(_db().collection('providerCalendar').doc(ref.id));
  const lockRef = _slotLockRef(uid, data);   /* §3.2 — release the slot lock on decline */
  if (lockRef) batch.delete(lockRef);
  await batch.commit();
  return { success: true, status: 'declined' };
};

/* ── 3. providerCompleteBooking ──────────────────────────────────────────────
   confirmed/in_progress → completed. Computes commission from the provider's
   subscription and writes a pending providerPayouts entry + analytics rollup.
   This is the enforcement point for commissionRate. Idempotent per booking. */
_h.providerCompleteBooking = async (req) => {
  const uid = _uid(req);
  await legal.assertLegalCompliance(uid, 'provider'); // receive settlement — dark-launched
  const { ref, data } = await _ownBooking(uid, req.data?.bookingId);
  if (data.status === 'completed') return { success: true, status: 'completed', alreadyDone: true };
  if (!['confirmed', 'in_progress', 'pending'].includes(data.status)) {
    throw new HttpsError('failed-precondition', `Cannot complete a "${data.status}" booking.`);
  }

  const gross = Math.max(0, Math.round(Number(data.price) || 0)); // cents

  /* ── COMMISSION: the ONE engine ────────────────────────────────────────────────────────
   * This used to compute commission itself:
   *     const rate = await _commissionRate(uid);          // subscription-core, a fraction
   *     const commission = Math.round(gross * rate);
   * That bypassed the Commission Engine entirely, so provider bookings ignored
   * commissionRules, revenueConfig overrides, promotional/holiday campaigns, plan adjustments
   * and the audit trail. It was the last money path on the platform outside the engine.
   *
   * PRICING IS UNCHANGED. `subscriptionRole: 'provider'` puts the engine in compatibility
   * mode, where it consumes the provider's own plan rate through the SAME
   * subscription-core.getCommissionRate() call this code used to make. Free Trial 20%,
   * Starter 15%, Professional 10%, Business 7%, Enterprise 5% — exactly as before.
   * Migrating to the engine's flat `services` rate would have charged an Enterprise provider
   * 15% instead of 5%; that is a commercial decision, and it is not taken here.
   *
   * What the provider GAINS: commissionRules and revenueConfig now reach these bookings for
   * the first time, so the platform can price, discount or run a commission holiday for
   * providers without a deploy. An operator retires compatibility mode by writing
   * revenueConfig/hub_provider — no code change. */
  const { calculateCommission } = require('./finos-utils');
  const comm = await calculateCommission(_db(), {
    orderAmountCents: gross,
    category:         'services',
    sellerId:         uid,
    hubId:            'provider',
    subscriptionRole: 'provider',   /* compatibility mode: the plan rate is authoritative */
  });

  const commission = comm.commissionCents;
  const net        = gross - commission;
  const rate       = comm.effectiveRate / 100;   /* fraction — the shape every reader expects */
  const dayKey     = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  /* ── SETTLEMENT → WALLET (Phase C, docs/BOOKING_CONVERGENCE.md) ────────────────────────
   * The earning must reach the provider's WITHDRAWABLE balance, not sit forever as a
   * `pending` providerPayouts row. `wallets.balance` is the canonical withdrawable field
   * and is denominated in whole SHILLINGS (requestSellerPayout / the FinOS sweep both treat
   * it that way); `net` here is CENTS. Credit floor(net/100) shillings and record the
   * sub-shilling remainder for exact reconciliation — never round up (money integrity).
   *
   * DOUBLE-PAY GUARD: crediting the wallet AND marking the payout `settled` (not `pending`)
   * removes it from providerRequestPayout's `status==='pending'` sweep, so an earning can be
   * withdrawn through exactly ONE path (the wallet). providerPayouts stays as the audit
   * ledger; the wallet is the money. This does NOT touch FinOS availableBalance/
   * withdrawableBalance, so sweepEarningsToWallet never sees it either — two disjoint paths.
   *
   * EXACTLY-ONCE: the whole thing runs in a runTransaction that re-reads the booking status
   * inside the txn. Two concurrent completions cannot both credit — the loser retries, sees
   * `completed`, and returns without a second increment. */
  const netShillings   = Math.floor(net / 100);
  const remainderCents = net - netShillings * 100;
  const willCredit      = netShillings >= 1;

  const payoutRef   = _db().collection('providerPayouts').doc(ref.id);
  const profileRef  = _db().collection('providerProfiles').doc(uid);
  const analyticsRef = _db().collection('providerAnalytics').doc(`${uid}_${dayKey}`);
  const walletRef   = _db().collection('wallets').doc(uid);
  const walletTxId  = `${uid}_${ref.id}_bookingsettle`;   /* deterministic → no duplicate txn */
  const walletTxRef = _db().collection('walletTransactions').doc(walletTxId);

  let result = null;
  await _db().runTransaction(async (t) => {
    const bSnap = await t.get(ref);   /* re-read inside the txn — the exactly-once guard */
    if (!bSnap.exists) throw new HttpsError('not-found', 'Booking not found.');
    const cur = bSnap.data();
    if (cur.status === 'completed') { result = { alreadyDone: true }; return; }
    if (cur.providerId !== uid) throw new HttpsError('permission-denied', 'Not your booking.');

    t.update(ref, { status: 'completed', completedAt: _ts(), updatedAt: _ts() });

    /* §3.2 — completed is terminal; release the slot lock (harmless no-op if absent). */
    const lockRef = _slotLockRef(uid, cur);
    if (lockRef) t.delete(lockRef);

    /* Earnings ledger entry (deterministic id = booking id → one payout per booking).
       status:'settled' — credited to the withdrawable wallet, NOT awaiting a separate payout. */
    t.set(payoutRef, {
      providerId: uid, bookingId: ref.id,
      sourceType: 'booking', sourceId: ref.id,   /* explicit FK — reconciliation/reporting/exports */
      gross, commission, commissionRate: rate,
      net, amount: net, currency: 'KES', method: null, reference: null,
      status: 'settled', createdAt: _ts(),
      /* settlement evidence — how the earning reached the wallet */
      walletCredited:      willCredit,
      netShillingsCredited: willCredit ? netShillings : 0,
      remainderCents,                       /* sub-shilling not withdrawable; recorded for reconciliation */
      walletTxnId:         willCredit ? walletTxId : null,
      settledAt:           _ts(),

      /* ── AUDIT TRAIL ──────────────────────────────────────────────────────────────────────
       * A provider booking now carries the same evidence as every other payment on the
       * platform, so a settlement is reproducible years later: which authority priced it,
       * which rule, which plan, what adjustment, and under which engine version.
       * `commissionRate` above is retained unchanged so existing analytics, receipts,
       * exports, dashboards and payout reports keep working untouched. */
      commissionPct:   comm.effectiveRate,
      baseRate:        comm.baseRate,
      pricingSource:   comm.pricingSource,
      ruleId:          comm.ruleId,
      ruleSource:      comm.ruleSource,
      planId:          comm.planId,
      planName:        comm.planName,
      planAdjustment:  comm.planAdjustment,
      adjustmentType:  comm.adjustmentType,
      planApplied:     comm.planApplied,
      reason:          comm.reason,
      hubType:         'provider',
      category:        comm.category,
      idempotencyKey:  ref.id,        /* the booking id IS the key — one payout per booking */
      calculatedAt:    comm.calculatedAt,
      engineVersion:   comm.engineVersion,
    }, { merge: true });

    /* Credit the withdrawable wallet + a matching ledger row (set-merge creates the wallet
       doc if the provider never had one; increment starts an absent field at 0). */
    if (willCredit) {
      t.set(walletRef, { balance: _inc(netShillings), updatedAt: _ts() }, { merge: true });
      t.set(walletTxRef, {
        uid, type: 'booking_earning', amount: netShillings,
        description: `Earnings — ${_san(cur.service || 'service booking', 120)}`,
        bookingId: ref.id,
        sourceType: 'booking', sourceId: ref.id,   /* explicit FK — don't rely on the encoded doc id */
        status: 'completed', createdAt: _ts(),
      });
    }

    // Profile counters
    t.set(profileRef, { bookingCount: _inc(1), lifetimeGrossKes: _inc(gross), updatedAt: _ts() }, { merge: true });

    // providerAnalytics — daily rollup (id = uid_YYYY-MM-DD)
    t.set(analyticsRef, {
      providerId: uid, date: dayKey, bookingsCompleted: _inc(1),
      grossCents: _inc(gross), commissionCents: _inc(commission), netCents: _inc(net),
      updatedAt: _ts(),
    }, { merge: true });

    result = { credited: willCredit ? netShillings : 0, remainderCents };
  });

  if (result && result.alreadyDone) return { success: true, status: 'completed', alreadyDone: true };
  logger.info('providerCompleteBooking', { uid, bookingId: ref.id, gross, commission, net, creditedShillings: result.credited, remainderCents });
  return { success: true, status: 'completed', gross, commission, net, creditedShillings: result.credited, remainderCents };
};

/* ============================================================================
   D1 — Booking lifecycle ops. Implements docs/BOOKING_LIFECYCLE_CONTRACT.md v1.0.
   Every terminal transition releases the slot lock (§3.2); only completion settles
   (§3.1, provider-ops.js above); booking identity is immutable (§3.5).
   ========================================================================== */

/* ── 3a. providerStartBooking — confirmed → in_progress ──────────────────────── */
_h.providerStartBooking = async (req) => {
  const uid = _uid(req);
  const { ref, data } = await _ownBooking(uid, req.data?.bookingId);
  if (data.status === 'in_progress') return { success: true, status: 'in_progress', alreadyDone: true };
  if (data.status !== 'confirmed') {
    throw new HttpsError('failed-precondition', `Only a confirmed booking can be started (is "${data.status}").`);
  }
  /* Guard: don't start a far-future booking (generous 2h grace for early arrivals). */
  if (data.startTs && Date.now() < data.startTs - 2 * 3600000) {
    throw new HttpsError('failed-precondition', 'Too early to start this booking.');
  }
  await ref.update({ status: 'in_progress', startedAt: _ts(), updatedAt: _ts() });
  return { success: true, status: 'in_progress' };
};

/* ── 3b. providerCancelBooking — active → cancelled (provider OR customer) ────── */
_h.providerCancelBooking = async (req) => {
  const uid = _uid(req);
  const id  = _san(req.data?.bookingId, 128);
  if (!id) throw new HttpsError('invalid-argument', 'bookingId is required.');
  const ref  = _db().collection('providerBookings').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Booking not found.');
  const data = snap.data();
  const isProvider = data.providerId === uid;
  const isCustomer = data.customerUid === uid;
  if (!isProvider && !isCustomer) throw new HttpsError('permission-denied', 'Not your booking.');
  if (['cancelled', 'declined', 'no_show'].includes(data.status)) {
    return { success: true, status: data.status, alreadyDone: true };
  }
  if (data.status === 'completed') throw new HttpsError('failed-precondition', 'A completed booking cannot be cancelled.');

  const batch = _db().batch();
  batch.update(ref, {
    status: 'cancelled', cancelledAt: _ts(), updatedAt: _ts(),
    cancelledBy: isProvider ? 'provider' : 'customer',
    cancelReason: _san(req.data?.reason, 300) || null,
  });
  const lockRef = _slotLockRef(data.providerId, data);   /* §3.2 release */
  if (lockRef) batch.delete(lockRef);
  batch.delete(_db().collection('providerCalendar').doc(id));
  await batch.commit();

  /* Notify the counterparty (best-effort). */
  try {
    const targetUid = isProvider ? data.customerUid : data.providerId;
    if (targetUid) await _db().collection('notifications').add({
      targetUid, type: 'booking', heading: 'Booking cancelled',
      sub: `${_san(data.service, 120)} · ${data.date || ''} ${data.startTime || ''}`,
      link: isProvider ? 'my-bookings.html' : 'provider-dashboard.html',
      createdAt: _ts(), read: false,
    });
  } catch (e) { /* ignore */ }

  return { success: true, status: 'cancelled', cancelledBy: isProvider ? 'provider' : 'customer' };
};

/* ── 3c. providerMarkNoShow — confirmed → no_show (provider only) ─────────────── */
_h.providerMarkNoShow = async (req) => {
  const uid = _uid(req);
  const { ref, data } = await _ownBooking(uid, req.data?.bookingId);
  if (data.status === 'no_show') return { success: true, status: 'no_show', alreadyDone: true };
  if (data.status !== 'confirmed') {
    throw new HttpsError('failed-precondition', `Only a confirmed booking can be marked no-show (is "${data.status}").`);
  }
  /* Guard: cannot mark no-show before the scheduled start (§2). */
  if (data.startTs && Date.now() < data.startTs) {
    throw new HttpsError('failed-precondition', 'Cannot mark no-show before the scheduled time.');
  }
  const batch = _db().batch();
  batch.update(ref, { status: 'no_show', noShowAt: _ts(), updatedAt: _ts() });
  const lockRef = _slotLockRef(uid, data);   /* §3.2 release — no settlement (§3.1) */
  if (lockRef) batch.delete(lockRef);
  batch.delete(_db().collection('providerCalendar').doc(ref.id));
  await batch.commit();
  return { success: true, status: 'no_show' };
};

/* ── 3d. providerRescheduleBooking — in-place, identity-preserving slot move ────
   §4: keeps the SAME booking (id/provider/customer immutable), moves the reservation
   to a new slot. ATOMIC single transaction — acquire the new lock BEFORE releasing
   the old, so the booking never holds two locks or zero (§3.2). Reuses the shared
   availability gate (_prepareSlot) + reservation-core CAS, exactly like create. */
_h.providerRescheduleBooking = async (req) => {
  const uid      = _uid(req);
  const id       = _san(req.data?.bookingId, 128);
  const newDate  = _san(req.data?.date, 10);
  const newStart = _san(req.data?.startTime, 5);
  if (!id || !newDate || !newStart) throw new HttpsError('invalid-argument', 'bookingId, date, startTime required.');
  const ref  = _db().collection('providerBookings').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Booking not found.');
  const data = snap.data();
  const isProvider = data.providerId === uid;
  const isCustomer = data.customerUid === uid;
  if (!isProvider && !isCustomer) throw new HttpsError('permission-denied', 'Not your booking.');
  if (!['pending', 'confirmed'].includes(data.status)) {
    throw new HttpsError('failed-precondition', `Cannot reschedule a "${data.status}" booking.`);
  }
  const providerId   = data.providerId;
  const durationMins = Math.max(15, Number(data.durationMins) || 30);

  /* Shared availability gate — same validation the create path runs (D2 adds breaks here). */
  const { _prepareSlot } = require('./booking-service');
  const slot = await _prepareSlot(_db(), { providerId, date: newDate, startTime: newStart, durationMins });
  const { endTime, startTs, endTs, slotKey, cfg, bufMs, cfgRef } = slot;

  const oldLockRef = _slotLockRef(providerId, data);
  const newLockRef = cfgRef.collection('slotLocks').doc(String(slotKey));
  const sameSlot   = oldLockRef && oldLockRef.path === newLockRef.path;

  /* Prefetch same-day active bookings EXCLUDING this one (it's moving). */
  const activeSnap = await _db().collection('providerBookings')
    .where('providerId', '==', providerId).where('date', '==', newDate)
    .where('status', 'in', rc.ACTIVE_STATUSES).get();
  const existing = activeSnap.docs.filter(d => d.id !== id).map(d => d.data());

  await _db().runTransaction(async (txn) => {
    if (!sameSlot) {
      const newLock = await txn.get(newLockRef);
      if (newLock.exists) throw new HttpsError('already-exists', 'That slot was just taken. Choose another time.');
    }
    const maxConcurrent = Math.max(1, Number(cfg.cap && cfg.cap.maxSimultaneous || 1));
    const overlap = existing.filter(b => rc.pairOverlaps(startTs, endTs, b.startTs, b.endTs, bufMs, bufMs)).length;
    if (overlap >= maxConcurrent) throw new HttpsError('already-exists', 'That time overlaps another booking.');
    const maxPerDay = Number(cfg.cap && cfg.cap.maxPerDay || 0);
    if (maxPerDay > 0 && existing.length >= maxPerDay) throw new HttpsError('resource-exhausted', 'The provider is fully booked that day.');

    /* Acquire new BEFORE releasing old — never zero locks (§3.2). */
    txn.set(newLockRef, {
      bookingId: id, providerId, customerUid: data.customerUid || null,
      date: newDate, startTime: newStart, endTime, startTs, endTs, createdAt: _ts(),
    });
    if (oldLockRef && !sameSlot) txn.delete(oldLockRef);

    /* Identity immutable (§3.5): only scheduling fields change. */
    txn.update(ref, {
      date: newDate, startTime: newStart, endTime, startTs, endTs, slotKey,
      scheduledAt: Timestamp.fromMillis(startTs),
      rescheduleCount: _inc(1),
      rescheduleHistory: FieldValue.arrayUnion({
        from: { date: data.date || null, startTime: data.startTime || null },
        to:   { date: newDate, startTime: newStart },
        by:   isProvider ? 'provider' : 'customer',
        at:   new Date().toISOString(),
      }),
      updatedAt: _ts(),
    });
    /* Keep the calendar mirror in sync if it exists. */
    txn.set(_db().collection('providerCalendar').doc(id),
      { scheduledAt: Timestamp.fromMillis(startTs), updatedAt: _ts() }, { merge: true });
  });

  /* Notify the counterparty (best-effort). */
  try {
    const targetUid = isProvider ? data.customerUid : data.providerId;
    if (targetUid) await _db().collection('notifications').add({
      targetUid, type: 'booking', heading: 'Booking rescheduled',
      sub: `${_san(data.service, 120)} → ${newDate} ${newStart}`,
      link: isProvider ? 'my-bookings.html' : 'provider-dashboard.html',
      createdAt: _ts(), read: false,
    });
  } catch (e) { /* ignore */ }

  return { success: true, status: data.status, date: newDate, startTime: newStart, endTime };
};

/* ── 3e. providerContactCustomer — NON-transition (§6). Returns the customer's
   contact channel for the provider's own active booking; never changes status. */
_h.providerContactCustomer = async (req) => {
  const uid = _uid(req);
  const { data } = await _ownBooking(uid, req.data?.bookingId);
  const custUid = data.customerUid;
  if (!custUid) throw new HttpsError('failed-precondition', 'This booking has no linked customer account.');
  const uSnap = await _db().collection('users').doc(custUid).get();
  const u = uSnap.exists ? uSnap.data() : {};
  /* Phone lives in `phoneNumber` ("+254…"), not `phone`. */
  return {
    success: true,
    customer: {
      name:  data.customerName || u.name || u.displayName || null,
      phone: u.phoneNumber || null,
    },
  };
};

/* ── 4. providerGetEarnings ──────────────────────────────────────────────────
   Aggregates providerPayouts over `days`. All amounts in cents. */
_h.providerGetEarnings = async (req) => {
  const uid  = _uid(req);
  const days = Math.min(365, Math.max(1, Number(req.data?.days) || 30));
  const since = new Date(Date.now() - days * 86400000);

  // Single-field equality (auto-indexed) + in-memory date filter → no composite index.
  const snap = await _db().collection('providerPayouts')
    .where('providerId', '==', uid).limit(2000).get();

  let gross = 0, commission = 0, net = 0, pending = 0, settled = 0, paid = 0;
  const byDay = {};
  const payouts = [];
  for (const doc of snap.docs) {
    const p = doc.data();
    const created = p.createdAt?.toDate ? p.createdAt.toDate() : null;
    if (created && created < since) continue;
    gross += p.gross || 0; commission += p.commission || 0; net += p.net || 0;
    /* paid = withdrawn to M-Pesa; settled = credited to the withdrawable wallet (Phase C);
       pending = legacy earnings not yet settled (pre-Phase-C completions). */
    if (p.status === 'paid') paid += p.net || 0;
    else if (p.status === 'settled') settled += p.net || 0;
    else pending += p.net || 0;
    const d = p.createdAt?.toDate ? p.createdAt.toDate() : new Date();
    const k = d.toISOString().slice(5, 10); // MM-DD
    byDay[k] = (byDay[k] || 0) + (p.net || 0);
    if (p.status !== 'pending') {
      payouts.push({ id: doc.id, net: p.net || 0, method: p.method || null,
        reference: p.reference || null, status: p.status, createdAt: p.createdAt || null });
    }
  }
  const dailyRevenue = Object.keys(byDay).sort().map((date) => ({ date, net: byDay[date] }));
  return { gross, commission, net, pending, settled, paid, dailyRevenue,
    payouts: payouts.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)).slice(0, 20),
    currency: 'KES', days };
};

/* ── 5. providerRequestPayout ────────────────────────────────────────────────
   Moves all pending earnings to "requested" (settled by the payout scheduler). */
_h.providerRequestPayout = async (req) => {
  const uid = _uid(req);
  await legal.assertLegalCompliance(uid, 'provider'); // dark-launched; no-op until enabled
  const snap = await _db().collection('providerPayouts')
    .where('providerId', '==', uid).limit(600).get();
  const pending = snap.docs.filter((d) => d.data().status === 'pending');
  if (!pending.length) throw new HttpsError('failed-precondition', 'No pending earnings to pay out.');

  const reference = `PO-${uid.slice(0, 6).toUpperCase()}-${new Date().toISOString().slice(0, 10)}`;
  let total = 0;
  const batch = _db().batch();
  pending.forEach((d) => { total += d.data().net || 0;
    batch.update(d.ref, { status: 'requested', payoutRef: reference, requestedAt: _ts() }); });
  await batch.commit();
  return { success: true, reference, amount: total, count: pending.length, currency: 'KES' };
};

/* ── 6. providerGetReviews ───────────────────────────────────────────────────
   Reviews + rating distribution for the caller's profile. */
_h.providerGetReviews = async (req) => {
  const uid = _uid(req);
  // Single-field equality (auto-indexed) + in-memory sort → no composite index.
  const snap = await _db().collection('providerReviews')
    .where('providerId', '==', uid).limit(200).get();

  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  const reviews = snap.docs.map((d) => {
    const r = d.data();
    const rating = Math.max(1, Math.min(5, Math.round(Number(r.rating) || 0)));
    distribution[rating] = (distribution[rating] || 0) + 1;
    sum += rating;
    return { id: d.id, customerName: _san(r.customerName, 120) || 'Customer',
      rating, text: _san(r.text, 1000), reply: r.reply ? _san(r.reply, 1000) : null,
      createdAt: r.createdAt || null,
      _sort: r.createdAt?.toDate ? r.createdAt.toDate().getTime() : 0 };
  }).sort((a, b) => b._sort - a._sort).map(({ _sort, ...r }) => r);
  const total = reviews.length;
  return { total, averageRating: total ? sum / total : 0, distribution, reviews };
};

/* ── 7. providerReplyReview ──────────────────────────────────────────────────
   Provider replies to a review on their own profile. */
_h.providerReplyReview = async (req) => {
  const uid   = _uid(req);
  const id    = _san(req.data?.reviewId, 128);
  const reply = _san(req.data?.reply, 1000).trim();
  if (!id)    throw new HttpsError('invalid-argument', 'reviewId is required.');
  if (!reply) throw new HttpsError('invalid-argument', 'reply text is required.');
  const ref  = _db().collection('providerReviews').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Review not found.');
  if (snap.data().providerId !== uid) throw new HttpsError('permission-denied', 'Not your review.');
  await ref.update({ reply, repliedAt: _ts(), updatedAt: _ts() });
  return { success: true };
};

/* ── 8. providerSavePortfolio ────────────────────────────────────────────────
   Persists portfolio items (step 11). Creates providerPortfolio. Client uploads
   media to Storage first and passes the resulting URLs. */
_h.providerSavePortfolio = async (req) => {
  const uid   = _uid(req);
  const d     = req.data || {};
  const clamp = (arr, n, len) => (Array.isArray(arr) ? arr.slice(0, n).map((x) => _san(x, len)) : []);
  await _db().collection('providerPortfolio').doc(uid).set({
    providerId: uid,
    images:    clamp(d.images, 30, 600),
    videos:    clamp(d.videos, 10, 600),
    projects:  Array.isArray(d.projects) ? d.projects.slice(0, 30).map((p) => ({
      title: _san(p?.title, 200), description: _san(p?.description, 1000), url: _san(p?.url, 600),
    })) : [],
    certificates: clamp(d.certificates, 20, 600),
    documents:    clamp(d.documents, 20, 600),
    website:  _san(d.website, 300),
    socials:  (d.socials && typeof d.socials === 'object') ? {
      facebook: _san(d.socials.facebook, 300), instagram: _san(d.socials.instagram, 300),
      twitter:  _san(d.socials.twitter, 300),  linkedin:  _san(d.socials.linkedin, 300),
      tiktok:   _san(d.socials.tiktok, 300),   youtube:   _san(d.socials.youtube, 300),
    } : {},
    updatedAt: _ts(),
  }, { merge: true });
  // Reflect completeness on the profile so dashboard profileCompletion counts it.
  await _db().collection('providerProfiles').doc(uid)
    .set({ portfolio: clamp(d.images, 30, 600), updatedAt: _ts() }, { merge: true });
  return { success: true };
};

/* ── 9. providerGetPortfolio ─────────────────────────────────────────────────*/
_h.providerGetPortfolio = async (req) => {
  const uid  = _uid(req);
  const snap = await _db().collection('providerPortfolio').doc(uid).get();
  return { portfolio: snap.exists ? snap.data() : null };
};

/* ── 10. providerAddService — enforces plan limits.listings ──────────────────
   Creates providerServices; a provider cannot exceed their subscription's
   listing cap (-1 = unlimited). This is the listings-limit enforcement point. */
_h.providerAddService = async (req) => {
  const uid = _uid(req);
  await legal.assertLegalCompliance(uid, 'provider'); // dark-launched; no-op until enabled
  const d   = req.data || {};
  const name = _san(d.name, 200).trim();
  if (!name) throw new HttpsError('invalid-argument', 'Service name is required.');

  const [subSnap, svcSnap] = await Promise.all([
    _db().collection('providerSubscriptions').doc(uid).get(),
    _db().collection('providerServices').where('providerId', '==', uid).limit(200).get(),
  ]);
  const activeCount = svcSnap.docs.filter((d) => d.data().active !== false).length;
  const cap = subSnap.exists ? Number(subSnap.data().limits?.listings) : 1;
  if (cap !== -1 && activeCount >= cap) {
    throw new HttpsError('resource-exhausted',
      `Your plan allows ${cap} active service${cap === 1 ? '' : 's'}. Upgrade to add more.`);
  }
  const ref = await _db().collection('providerServices').add({
    providerId: uid, name, category: _san(d.category, 120), subcategory: _san(d.subcategory, 120),
    description: _san(d.description, 1000), priceType: _san(d.priceType, 40) || 'quotation',
    price:   _cents(d.price),                    /* cents */
    fee:     _cents(d.fee),                      /* cents — per-service booking fee */
    deposit: _cents(d.deposit),                  /* cents — upfront hold (collected in Phase E) */
    images:  _images(d.images),                  /* https URLs */
    durationMins: Math.max(0, Math.round(Number(d.durationMins ?? d.duration) || 0)),
    active: true,
    createdAt: _ts(), updatedAt: _ts(),
  });
  return { success: true, serviceId: ref.id, remaining: cap === -1 ? -1 : cap - activeCount - 1 };
};

/* ── 11. providerListServices ────────────────────────────────────────────────*/
_h.providerListServices = async (req) => {
  const uid  = _uid(req);
  const snap = await _db().collection('providerServices')
    .where('providerId', '==', uid).limit(100).get();
  return { services: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
};

/* ── 12. providerRemoveService ───────────────────────────────────────────────
   Soft-delete (active:false) so listing counts free up without losing history. */
_h.providerRemoveService = async (req) => {
  const uid = _uid(req);
  const id  = _san(req.data?.serviceId, 128);
  if (!id) throw new HttpsError('invalid-argument', 'serviceId is required.');
  const ref  = _db().collection('providerServices').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Service not found.');
  if (snap.data().providerId !== uid) throw new HttpsError('permission-denied', 'Not your service.');
  await ref.update({ active: false, removedAt: _ts(), updatedAt: _ts() });
  return { success: true };
};

/* ── 13. providerUpdateService — edit a rate card (owner-only, whitelisted fields).
   providerId/createdAt are never client-mutable; a non-owner is rejected before
   any write. Only fields the caller actually sent are patched. ──────────────── */
_h.providerUpdateService = async (req) => {
  const uid = _uid(req);
  const id  = _san(req.data?.serviceId, 128);
  if (!id) throw new HttpsError('invalid-argument', 'serviceId is required.');
  const ref  = _db().collection('providerServices').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Service not found.');
  if (snap.data().providerId !== uid) throw new HttpsError('permission-denied', 'Not your service.');
  const d = req.data || {};
  const patch = { updatedAt: _ts() };
  if (d.name !== undefined) {
    const n = _san(d.name, 200).trim();
    if (!n) throw new HttpsError('invalid-argument', 'Service name cannot be empty.');
    patch.name = n;
  }
  if (d.category !== undefined)    patch.category    = _san(d.category, 120);
  if (d.subcategory !== undefined) patch.subcategory = _san(d.subcategory, 120);
  if (d.description !== undefined) patch.description = _san(d.description, 1000);
  if (d.priceType !== undefined)   patch.priceType   = _san(d.priceType, 40) || 'quotation';
  if (d.price !== undefined)       patch.price       = _cents(d.price);
  if (d.fee !== undefined)         patch.fee         = _cents(d.fee);      /* cents */
  if (d.deposit !== undefined)     patch.deposit     = _cents(d.deposit);  /* cents */
  if (d.images !== undefined)      patch.images      = _images(d.images);
  if (d.durationMins !== undefined || d.duration !== undefined) {
    patch.durationMins = Math.max(0, Math.round(Number(d.durationMins ?? d.duration) || 0));
  }
  if (d.active !== undefined)      patch.active      = d.active === true;
  await ref.update(patch);
  return { success: true };
};

/* ── 14. providerToggleService — enable/disable a rate card (owner-only).
   Pass {active} to set explicitly, or omit to flip. Never touches removedAt, so a
   deleted card stays deleted. ────────────────────────────────────────────────── */
_h.providerToggleService = async (req) => {
  const uid = _uid(req);
  const id  = _san(req.data?.serviceId, 128);
  if (!id) throw new HttpsError('invalid-argument', 'serviceId is required.');
  const ref  = _db().collection('providerServices').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Service not found.');
  const cur = snap.data();
  if (cur.providerId !== uid) throw new HttpsError('permission-denied', 'Not your service.');
  if (cur.removedAt) throw new HttpsError('failed-precondition', 'This service was deleted.');
  const next = req.data?.active !== undefined ? (req.data.active === true) : !(cur.active !== false);
  await ref.update({ active: next, updatedAt: _ts() });
  return { success: true, active: next };
};

module.exports = { _h };
