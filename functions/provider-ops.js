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
const { bookingEvent, TYPES }      = require('./booking-events');

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

/* Phase E WS1 — move HELD money when a PAID booking reaches a terminal state.
   Refund → the customer's existing wallet (users.walletBalance, whole KES + a `ledger`
   row — the platform's established refund destination, decision c). Forfeit → the
   deposit becomes provider earnings through the SAME commission engine as any other
   provider revenue (decision d). All amounts from the booking's own immutable snapshot.
   Idempotent: only `paid_held` disburses (re-checked in the txn); a repeat is a no-op.
   Policy (contract §3): provider-cancel → full refund; customer <24h or no-show →
   deposit forfeited + remainder refunded; customer ≥24h → full refund. */
async function _disburseHeldFunds(data, ref, opts) {
  if (data.paymentStatus !== 'paid_held') return null;      /* unpaid → no money to move */
  const priceC   = Math.max(0, Math.round(Number(data.price) || 0));
  const feeC     = Math.max(0, Math.round(Number(data.fee) || 0));
  const depositC = Math.min(priceC, Math.max(0, Math.round(Number(data.deposit) || 0)));
  const heldC    = priceC + feeC;

  let refundC = 0, forfeitC = 0;
  if (opts.isNoShow) { forfeitC = depositC; refundC = heldC - depositC; }  /* no-show → deposit forfeited (checked FIRST) */
  else if (opts.by === 'provider') { refundC = heldC; }                    /* provider cancel → full refund */
  else {                                                                   /* customer cancel */
    const within24h = data.startTs && (Date.now() >= (Number(data.startTs) - 24 * 3600000));
    if (within24h) { forfeitC = depositC; refundC = heldC - depositC; }    /* late cancel → forfeit deposit */
    else { refundC = heldC; }                                              /* early cancel → full refund */
  }

  /* Commission on a forfeited deposit — computed BEFORE the txn (config reads). */
  let forfeitCommissionC = 0;
  if (forfeitC > 0) {
    const { calculateCommission } = require('./finos-utils');
    const fc = await calculateCommission(_db(), { orderAmountCents: forfeitC, category: 'services',
      sellerId: data.providerId, hubId: 'provider', subscriptionRole: 'provider' });
    forfeitCommissionC = fc.commissionCents || 0;
  }
  const providerNetC     = Math.max(0, forfeitC - forfeitCommissionC);
  const refundShillings  = Math.floor(refundC / 100);
  const forfeitShillings = Math.floor(providerNetC / 100);

  const custRef    = data.customerUid ? _db().collection('users').doc(data.customerUid) : null;
  const provWalRef = _db().collection('wallets').doc(data.providerId);
  const payoutRef  = _db().collection('providerPayouts').doc(ref.id);
  const wTxRef     = _db().collection('walletTransactions').doc(`${data.providerId}_${ref.id}_forfeit`);

  await _db().runTransaction(async (t) => {
    const bSnap = await t.get(ref);
    if (!bSnap.exists || bSnap.data().paymentStatus !== 'paid_held') return;   /* idempotent guard */
    if (refundShillings >= 1 && custRef) {
      t.set(custRef, { walletBalance: _inc(refundShillings) }, { merge: true });
      t.set(_db().collection('ledger').doc(), { uid: data.customerUid, type: 'booking_refund',
        credit: refundShillings, bookingId: ref.id, createdAt: _ts() });
    }
    if (forfeitShillings >= 1) {
      t.set(provWalRef, { balance: _inc(forfeitShillings), updatedAt: _ts() }, { merge: true });
      t.set(wTxRef, { uid: data.providerId, type: 'booking_forfeit', amount: forfeitShillings,
        description: `Forfeited deposit — ${_san(data.service || 'service', 120)}`, bookingId: ref.id,
        sourceType: 'booking', sourceId: ref.id, status: 'completed', createdAt: _ts() });
      t.set(payoutRef, { providerId: data.providerId, bookingId: ref.id, sourceType: 'booking', sourceId: ref.id,
        gross: forfeitC, commission: forfeitCommissionC, net: providerNetC, kind: 'deposit_forfeit',
        status: 'settled', walletCredited: true, netShillingsCredited: forfeitShillings,
        settledAt: _ts(), createdAt: _ts() }, { merge: true });
    }
    t.update(ref, { paymentStatus: 'refunded', refundedCents: refundC, forfeitedCents: forfeitC,
      forfeitCommissionCents: forfeitCommissionC, disbursedAt: _ts(), updatedAt: _ts() });
  });
  return { refundC, forfeitC, providerNetC, refundShillings, forfeitShillings };
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
  const cev = bookingEvent({
    bookingId: ref.id, type: TYPES.CONFIRMED, actor: 'provider',
    providerId: uid, customerUid: data.customerUid,
    previousStatus: data.status, newStatus: 'confirmed', paymentRef: data.paymentRef || null,
    key: 'confirmed',
  });
  batch.set(cev.ref, cev.payload);
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
  /* Provider earnings = (price − commission) + fee. Commission applies to the service
     PRICE only; the booking fee passes through to the provider (decision a). Both come
     from the booking's OWN immutable snapshot (data.price / data.fee) — settlement never
     re-reads the current providerServices record (contract: snapshot-only settlement). */
  const feeCents        = Math.max(0, Math.round(Number(data.fee) || 0));
  const settleCents     = net + feeCents;
  const settleShillings = Math.floor(settleCents / 100);
  const remainderCents  = settleCents - settleShillings * 100;
  /* willCredit is decided INSIDE the txn from the live paymentStatus (paid_held) — the
     single provider credit point; an unpaid completion moves no money. */

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

    /* Credit only when the funds are HELD (paid_held) — the SINGLE provider credit point.
       Re-read inside the txn so two concurrent completions can't both credit, and a
       post-settlement retry is a no-op (status==='completed' already returned above). */
    const isHeld     = cur.paymentStatus === 'paid_held';
    const willCredit = isHeld && settleShillings >= 1;

    t.update(ref, Object.assign(
      { status: 'completed', completedAt: _ts(), updatedAt: _ts() },
      isHeld ? { paymentStatus: 'settled', settledAt: _ts() } : {}));   /* paid_held → settled */

    /* §3.2 — completed is terminal; release the slot lock (harmless no-op if absent). */
    const lockRef = _slotLockRef(uid, cur);
    if (lockRef) t.delete(lockRef);

    /* Earnings ledger entry (deterministic id = booking id → one payout per booking).
       status:'settled' — credited to the withdrawable wallet, NOT awaiting a separate payout. */
    t.set(payoutRef, {
      providerId: uid, bookingId: ref.id,
      sourceType: 'booking', sourceId: ref.id,   /* explicit FK — reconciliation/reporting/exports */
      gross, commission, commissionRate: rate,
      fee: feeCents, net, settlementCents: settleCents,   /* provider earns (price−commission)+fee */
      amount: net, currency: 'KES', method: null, reference: null,
      status: isHeld ? 'settled' : 'unpaid',   /* 'unpaid' = completed with no held funds → no credit */
      createdAt: _ts(),
      /* settlement evidence — how the earning reached the wallet */
      walletCredited:      willCredit,
      netShillingsCredited: willCredit ? settleShillings : 0,
      remainderCents,                       /* sub-shilling not withdrawable; recorded for reconciliation */
      walletTxnId:         willCredit ? walletTxId : null,
      settledAt:           isHeld ? _ts() : null,

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
      t.set(walletRef, { balance: _inc(settleShillings), updatedAt: _ts() }, { merge: true });
      t.set(walletTxRef, {
        uid, type: 'booking_earning', amount: settleShillings,
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

    result = { credited: willCredit ? settleShillings : 0, remainderCents, held: isHeld };
  });

  if (result && result.alreadyDone) return { success: true, status: 'completed', alreadyDone: true };
  logger.info('providerCompleteBooking', { uid, bookingId: ref.id, gross, commission, net, fee: feeCents, creditedShillings: result.credited, held: result.held, remainderCents });
  return { success: true, status: 'completed', gross, commission, net, fee: feeCents, settlementCents: settleCents, held: result.held, creditedShillings: result.credited, remainderCents };
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

  /* Move held money per the refund policy (no-op if the booking was never paid). */
  try { await _disburseHeldFunds(data, ref, { by: isProvider ? 'provider' : 'customer', isNoShow: false }); }
  catch (e) { logger.error('disburse-on-cancel failed (recoverable)', { bookingId: id, err: e.message }); }

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
  const lockRef = _slotLockRef(uid, data);   /* §3.2 release — provider not credited via settlement (§3.1) */
  if (lockRef) batch.delete(lockRef);
  batch.delete(_db().collection('providerCalendar').doc(ref.id));
  await batch.commit();

  /* No-show: deposit forfeited to the provider (commissioned), remainder refunded to
     the customer. No-op if the booking was never paid. */
  try { await _disburseHeldFunds(data, ref, { by: 'provider', isNoShow: true }); }
  catch (e) { logger.error('disburse-on-no-show failed (recoverable)', { bookingId: ref.id, err: e.message }); }

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

/* ── 3f. providerSaveBookingNote — the provider's PRIVATE note on a booking.
   Additive metadata only (NOT part of the §-governed booking state machine): it
   never reads/changes status, price, or payment. Owner-gated via _ownBooking,
   sanitized + capped by _san. Stored on the booking doc so the Customers phase can
   surface it later. An empty string clears the note. */
_h.providerSaveBookingNote = async (req) => {
  const uid = _uid(req);
  const { ref } = await _ownBooking(uid, req.data?.bookingId);
  const note = _san(req.data?.note, 1000);
  await ref.update({ providerNotes: note, providerNotesAt: _ts(), updatedAt: _ts() });
  return { success: true, note };
};

/* ── 4. providerGetEarnings ──────────────────────────────────────────────────
   READ-ONLY aggregation over providerPayouts. All amounts in cents. Additive fields
   (count + real-date today/week/month/lifetime nets) power the Wallet overview cards
   without a second round-trip; NO money/ledger logic — the frozen wallet core is
   untouched. `days` still bounds the chart/gross window. */
_h.providerGetEarnings = async (req) => {
  const uid  = _uid(req);
  const days = Math.min(365, Math.max(1, Number(req.data?.days) || 30));
  const now  = Date.now();
  const since = new Date(now - days * 86400000);
  const t1 = now - 1 * 86400000, t7 = now - 7 * 86400000, t30 = now - 30 * 86400000;

  // Single-field equality (auto-indexed) + in-memory date filter → no composite index.
  const snap = await _db().collection('providerPayouts')
    .where('providerId', '==', uid).limit(2000).get();

  let gross = 0, commission = 0, net = 0, pending = 0, settled = 0, paid = 0, count = 0;
  let lifetimeNet = 0, todayNet = 0, weekNet = 0, monthNet = 0;
  const byDay = {};
  const payouts = [];
  for (const doc of snap.docs) {
    const p = doc.data();
    const created = p.createdAt?.toDate ? p.createdAt.toDate() : null;
    const n = p.net || 0;
    lifetimeNet += n;                                     // all-time (within the 2000 cap)
    if (created) { const ms = created.getTime();
      if (ms >= t1) todayNet += n; if (ms >= t7) weekNet += n; if (ms >= t30) monthNet += n; }
    if (created && created < since) continue;             // `days` window for the rest
    count += 1;
    gross += p.gross || 0; commission += p.commission || 0; net += n;
    /* paid = withdrawn to M-Pesa; settled = credited to the withdrawable wallet (Phase C);
       pending = legacy earnings not yet settled (pre-Phase-C completions). */
    if (p.status === 'paid') paid += n;
    else if (p.status === 'settled') settled += n;
    else pending += n;
    const d = created || new Date();
    const k = d.toISOString().slice(5, 10); // MM-DD
    byDay[k] = (byDay[k] || 0) + n;
    if (p.status !== 'pending') {
      payouts.push({ id: doc.id, net: n, method: p.method || null,
        reference: p.reference || null, status: p.status, createdAt: p.createdAt || null });
    }
  }
  const dailyRevenue = Object.keys(byDay).sort().map((date) => ({ date, net: byDay[date] }));
  return { gross, commission, net, pending, settled, paid, count,
    lifetimeNet, todayNet, weekNet, monthNet, dailyRevenue,
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

/* ── 12b. providerDuplicateService — copy an existing service as a new active listing.
   Copies the source's exact cents (no KES↔cents rescale) and enforces the same plan cap. */
_h.providerDuplicateService = async (req) => {
  const uid = _uid(req);
  const id  = _san(req.data?.serviceId, 128);
  if (!id) throw new HttpsError('invalid-argument', 'serviceId is required.');
  const srcRef = _db().collection('providerServices').doc(id);
  const [srcSnap, subSnap, listSnap] = await Promise.all([
    srcRef.get(),
    _db().collection('providerSubscriptions').doc(uid).get(),
    _db().collection('providerServices').where('providerId', '==', uid).limit(200).get(),
  ]);
  if (!srcSnap.exists) throw new HttpsError('not-found', 'Service not found.');
  const s = srcSnap.data();
  if (s.providerId !== uid) throw new HttpsError('permission-denied', 'Not your service.');
  const activeCount = listSnap.docs.filter((d) => d.data().active !== false).length;
  const cap = subSnap.exists ? Number(subSnap.data().limits?.listings) : 1;
  if (cap !== -1 && activeCount >= cap) {
    throw new HttpsError('resource-exhausted', `Your plan allows ${cap} active service${cap === 1 ? '' : 's'}. Upgrade or delete one to duplicate.`);
  }
  const ref = await _db().collection('providerServices').add({
    providerId: uid, name: ((s.name || 'Service') + ' (copy)').slice(0, 200),
    category: s.category || '', subcategory: s.subcategory || '', description: s.description || '',
    priceType: s.priceType || 'quotation', price: Number(s.price) || 0, fee: Number(s.fee) || 0,
    deposit: Number(s.deposit) || 0, images: Array.isArray(s.images) ? s.images : [],
    durationMins: Math.max(0, Math.round(Number(s.durationMins) || 0)), active: true,
    createdAt: _ts(), updatedAt: _ts(),
  });
  return { success: true, serviceId: ref.id };
};

/* ── Advanced Rate Cards (Slice C) — pricing config sanitiser + save + preview ─────────────
   The client sends money already in cents (_k2c). The server coerces (_cents), never trusts the
   structure, and stores the canonical config on providerServices/{id}.pricing. */
function _sanRate(r) {
  if (!r || (r.type !== 'pct' && r.type !== 'flat')) return undefined;
  const v = Number(r.value) || 0; if (v <= 0) return undefined;
  const out = { type: r.type, value: r.type === 'flat' ? _cents(v) : Math.max(0, v) };
  if (Array.isArray(r.hours) && r.hours.length === 2) out.hours = [_san(r.hours[0], 5), _san(r.hours[1], 5)];
  return out;
}
function _sanDeposit(dep) {
  if (!dep || ['fixed', 'pct', 'full'].indexOf(dep.mode) < 0) return undefined;
  const out = { mode: dep.mode };
  if (dep.mode === 'fixed') out.value = _cents(dep.value);
  else if (dep.mode === 'pct') out.value = Math.max(0, Math.min(100, Number(dep.value) || 0));
  if (dep.balanceDue === 'before' || dep.balanceDue === 'completion') out.balanceDue = dep.balanceDue;
  return out;
}
function _sanitizePricing(p) {
  p = p || {};
  const out = {
    currency: _san(p.currency, 8) || 'KES',
    basePrice: _cents(p.basePrice),
    durationMins: Math.max(0, Math.round(Number(p.durationMins) || 0)),
    extraHourRate: _cents(p.extraHourRate),
    holidays: Array.isArray(p.holidays) ? p.holidays.slice(0, 60).map(function (x) { return _san(x, 10); }).filter(Boolean) : [],
  };
  const wk = _sanRate(p.weekendRate); if (wk) out.weekendRate = wk;
  const hd = _sanRate(p.holidayRate); if (hd) out.holidayRate = hd;
  const pk = _sanRate(p.peakRate); if (pk) out.peakRate = pk;
  const op = _sanRate(p.offPeakDiscount); if (op) out.offPeakDiscount = op;
  const dep = _sanDeposit(p.deposit); if (dep) out.deposit = dep;
  if (p.travel && (Number(p.travel.fee) || Number(p.travel.perKm) || Number(p.travel.freeRadiusKm))) {
    out.travel = { fee: _cents(p.travel.fee), perKm: _cents(p.travel.perKm), freeRadiusKm: Math.max(0, Number(p.travel.freeRadiusKm) || 0) };
    if (Number(p.travel.maxKm)) out.travel.maxKm = Math.max(0, Number(p.travel.maxKm) || 0);
  }
  if (Array.isArray(p.packages)) {
    out.packages = p.packages.slice(0, 40).map(function (pk, i) {
      const o = { id: _san(pk.id, 64) || ('pkg_' + i), name: _san(pk.name, 120), price: _cents(pk.price),
        durationMins: Math.max(0, Math.round(Number(pk.durationMins) || 0)), description: _san(pk.description, 500) };
      const pd = _sanDeposit(pk.deposit); if (pd) o.deposit = pd;
      if (Array.isArray(pk.includes)) o.includes = pk.includes.slice(0, 30).map(function (x) { return _san(x, 120); }).filter(Boolean);
      if (Array.isArray(pk.extras)) o.extras = pk.extras.slice(0, 30).map(function (x) { return _san(x, 64); }).filter(Boolean);
      return o;
    }).filter(function (x) { return x.name; });
  }
  if (Array.isArray(p.addOns)) {
    out.addOns = p.addOns.slice(0, 60).map(function (a, i) {
      return { id: _san(a.id, 64) || ('addon_' + i), name: _san(a.name, 120), price: _cents(a.price),
        qtyMax: Math.max(0, Math.round(Number(a.qtyMax) || 0)), available: a.available !== false, description: _san(a.description, 300) };
    }).filter(function (x) { return x.name; });
  }
  return out;
}

_h.providerUpdateServicePricing = async (req) => {
  const uid = _uid(req);
  const id  = _san(req.data?.serviceId, 128);
  if (!id) throw new HttpsError('invalid-argument', 'serviceId is required.');
  const ref  = _db().collection('providerServices').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Service not found.');
  if (snap.data().providerId !== uid) throw new HttpsError('permission-denied', 'Not your service.');
  const pricing = _sanitizePricing(req.data?.pricing || {});
  await ref.update({ pricing: pricing, pricingUpdatedAt: _ts(), updatedAt: _ts() });
  return { success: true, pricing: pricing };
};

/* bookingPreviewPrice — the ONE preview authority. Runs the SAME computePrice so a provider's
   preview and the customer's charge can never diverge. Pass {serviceId} to preview the SAVED
   config, or {pricing} to preview an unsaved draft (editor live preview). Auth required. */
_h.bookingPreviewPrice = async (req) => {
  _uid(req);
  const d = req.data || {};
  let pricing;
  if (d.serviceId) {
    const s = await _db().collection('providerServices').doc(_san(d.serviceId, 128)).get();
    if (!s.exists) throw new HttpsError('not-found', 'Service not found.');
    pricing = s.data().pricing || {};
  } else {
    pricing = _sanitizePricing(d.pricing || {});
  }
  return require('./service-pricing').computePrice(pricing, d.selection || {}, d.ctx || {});
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

/* _disburseHeldFunds + _slotLockRef are reused by the booking resolution engine (Step 3 refund):
   the ONE place booking money moves, and the canonical slot-lock ref. No behavior change. */
module.exports = { _h, _disburseHeldFunds, _slotLockRef };
