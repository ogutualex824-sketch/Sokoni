'use strict';
/**
 * SOKONI — 48-HOUR COMMISSION RECEIVABLE
 * functions/commission-collection.js
 *
 *   SALE ─▶ DUE (0–46h) ─▶ REMINDED (46–48h) ─▶ OVERDUE (>48h)
 *                                                 │ penalty, if configured
 *                                                 ▼
 *                                            RESTRICTED ──paid+verified──▶ CLEAR
 *
 * The merchant receives 100% of the customer's payment directly. SOKONI's 5%
 * (minimum KES 10) is a RECEIVABLE against that sale, payable within 48 hours.
 *
 * ── NO SECOND LEDGER ────────────────────────────────────────────────────────
 * Everything here reads and extends `commissionLedger`, the existing
 * authoritative record. It adds lifecycle fields to rows; it never re-computes
 * `commissionPct`, `commissionKES`, `grossAmount` or `totalOwed`. A settlement
 * has to stay reproducible years later, so the figures charged at the time of
 * sale are immutable — the lifecycle moves around them.
 *
 * ── THE MIGRATION CUTOFF ────────────────────────────────────────────────────
 * Only rows written with `billingModel === 'PER_SALE_48H'` are governed here.
 * That field is stamped at creation (index.js, onSellerPaymentCreated). Every
 * row that existed before the migration has no such field and NO `dueAt`, so it
 * can never be picked up, given a deadline, or judged overdue. The sweep matches
 * on the field, never on a date — a date cutoff would have retroactively made
 * every old pending row overdue the moment it shipped.
 *
 * ── PENALTY IS CONFIGURATION, FAIL-CLOSED ───────────────────────────────────
 * There is no default penalty rate anywhere in this file. `revenueConfig/
 * commission_penalty` must exist, be `enabled: true`, AND carry a rate before a
 * single shilling of penalty is assessed. Absent config, unreadable config,
 * empty database, fresh environment — all mean NO PENALTY. Inventing a rate
 * would be charging merchants money nobody approved.
 */

const { onCall, onSchedule, HttpsError } = (() => {
  const https = require('firebase-functions/v2/https');
  const sched = require('firebase-functions/v2/scheduler');
  return { onCall: https.onCall, HttpsError: https.HttpsError, onSchedule: sched.onSchedule };
})();
const admin = require('firebase-admin');

const REGION      = 'us-central1';
const LEDGER      = 'commissionLedger';
const RESTRICTION = 'sellerRestrictions';
/* Deterministic settlement claims, keyed on the provider payment reference —
   the idempotency record that makes a webhook redelivery a no-op. */
const SETTLEMENT = 'commissionSettlements';
const PENALTY_DOC = 'revenueConfig/commission_penalty';

const DUE_HOURS      = 48;
const REMINDER_HOURS = 46;

const CS = {
  DUE:      'DUE',
  REMINDED: 'REMINDED',
  OVERDUE:  'OVERDUE',
  PAID:     'PAID',
  WAIVED:   'WAIVED',
};

function _db() { return admin.firestore(); }
function _ts() { return admin.firestore.FieldValue.serverTimestamp(); }

/* ── Penalty policy ───────────────────────────────────────────────────────
   Returns null whenever a penalty must not be assessed. Every caller treats
   null as zero. There is deliberately no fallback rate. */
async function loadPenaltyPolicy() {
  try {
    const [coll, id] = PENALTY_DOC.split('/');
    const snap = await _db().collection(coll).doc(id).get();
    if (!snap.exists) return null;
    const c = snap.data() || {};
    if (c.enabled !== true) return null;

    const pct   = Number(c.penaltyPct);
    const fixed = Number(c.penaltyFixedKES);
    const hasPct   = Number.isFinite(pct)   && pct   > 0;
    const hasFixed = Number.isFinite(fixed) && fixed > 0;
    /* Enabled but rate-less is a misconfiguration, not permission to guess. */
    if (!hasPct && !hasFixed) return null;

    return {
      penaltyPct:      hasPct   ? Math.min(pct, 100) : 0,
      penaltyFixedKES: hasFixed ? fixed : 0,
      ruleId: String(c.ruleId || 'commission_penalty_v1'),
      restrictAccess: c.restrictAccess !== false,
    };
  } catch (_e) {
    return null;   /* unreadable config ⇒ no penalty */
  }
}

function computePenalty(policy, commissionKES) {
  if (!policy) return 0;
  const pct = policy.penaltyPct ? (Number(commissionKES) * policy.penaltyPct) / 100 : 0;
  return Math.round((pct + (policy.penaltyFixedKES || 0)) * 100) / 100;
}

/* ══════════════════════════════════════════════════════════════════════════
   sweepCommissionDue — the state machine. Hourly.
   ══════════════════════════════════════════════════════════════════════════ */
exports.sweepCommissionDue = onSchedule(
  { region: REGION, schedule: '15 * * * *', timeZone: 'Africa/Nairobi', timeoutSeconds: 540 },
  async () => {
    const db  = _db();
    const now = Date.now();
    const policy = await loadPenaltyPolicy();

    /* Only rows this system owns. The billingModel equality is the migration
       cutoff; without it this sweep would reach historical monthly rows. */
    const snap = await db.collection(LEDGER)
      .where('billingModel', '==', 'PER_SALE_48H')
      .where('collectionStatus', 'in', [CS.DUE, CS.REMINDED, CS.OVERDUE])
      .limit(2000)
      .get()
      .catch((e) => { console.error('[commission-sweep] query failed:', e.message); return null; });

    if (!snap) return;

    let reminded = 0, overdue = 0, penalised = 0;
    const restrictionTotals = new Map();   /* sellerUid -> outstanding */

    for (const doc of snap.docs) {
      const d = doc.data();
      const dueMs = d.dueAt?.toMillis?.();
      /* A row of this model with no deadline is malformed — skip rather than
         invent one. Inventing a dueAt is exactly the retroactive-deadline
         failure the cutoff exists to prevent. */
      if (!dueMs) continue;

      const hoursLeft = (dueMs - now) / 3600000;
      const commission = Number(d.totalOwed || 0);

      /* ── REMINDER at 46h (2 hours before the deadline), exactly once ────── */
      if (d.collectionStatus === CS.DUE && hoursLeft <= (DUE_HOURS - REMINDER_HOURS) && hoursLeft > 0) {
        if (!d.reminderSentAt) {
          await doc.ref.set({
            collectionStatus: CS.REMINDED,
            reminderSentAt: _ts(),
            updatedAt: _ts(),
          }, { merge: true });
          await _notifySeller(d.sellerUid, 'commission_due_soon', {
            commissionKES: commission,
            dueAt: new Date(dueMs).toISOString(),
            hoursLeft: Math.max(0, Math.round(hoursLeft)),
          });
          reminded++;
        }
        continue;
      }

      /* ── OVERDUE past the deadline ──────────────────────────────────────── */
      if (hoursLeft <= 0 && d.collectionStatus !== CS.OVERDUE) {
        const penalty = computePenalty(policy, commission);
        await doc.ref.set({
          collectionStatus: CS.OVERDUE,
          overdueAt: _ts(),
          /* Penalty is assessed ONCE, from the policy in force at the moment it
             is applied, and the rule id is stored with it. A penalty whose rate
             cannot be explained later is not defensible. */
          penaltyKES: penalty,
          penaltyRuleId: penalty > 0 ? policy.ruleId : null,
          penaltyAssessedAt: penalty > 0 ? _ts() : null,
          totalOutstanding: Math.round((commission + penalty) * 100) / 100,
          updatedAt: _ts(),
        }, { merge: true });
        if (penalty > 0) penalised++;
        overdue++;
      }

      /* Accumulate the seller's outstanding balance from OVERDUE rows only. */
      if (hoursLeft <= 0) {
        const penalty = Number(d.penaltyKES || 0) || computePenalty(policy, commission);
        restrictionTotals.set(
          d.sellerUid,
          (restrictionTotals.get(d.sellerUid) || 0) + commission + penalty
        );
      }
    }

    /* ── Restriction. Only when the policy says to restrict. ─────────────── */
    if (policy && policy.restrictAccess) {
      for (const [sellerUid, outstanding] of restrictionTotals) {
        await db.collection(RESTRICTION).doc(String(sellerUid)).set({
          sellerUid: String(sellerUid),
          restricted: true,
          reason: 'commission_overdue',
          outstandingKES: Math.round(outstanding * 100) / 100,
          restrictedAt: _ts(),
          clearedAt: null,
          updatedAt: _ts(),
        }, { merge: true });
      }
    }

    console.log(`[commission-sweep] reminded=${reminded} overdue=${overdue} penalised=${penalised} restricted=${restrictionTotals.size} penaltyPolicy=${policy ? 'active' : 'none'}`);
  }
);

/* Best-effort seller notification. Observability must never fail a financial
   state transition, so this swallows its own errors. */
async function _notifySeller(sellerUid, type, payload) {
  try {
    await _db().collection('notifications').add({
      uid: String(sellerUid), type, payload,
      read: false, createdAt: _ts(),
    });
  } catch (_e) { /* non-fatal */ }
}

/* ══════════════════════════════════════════════════════════════════════════
   getCommissionBalance — what the seller owes, itemised
   ══════════════════════════════════════════════════════════════════════════ */
exports.getCommissionBalance = onCall(
  { region: REGION, timeoutSeconds: 20, cors: true },
  async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const uid = String(req.auth.uid);
    const db  = _db();

    const snap = await db.collection(LEDGER)
      .where('sellerUid', '==', uid)
      .where('billingModel', '==', 'PER_SALE_48H')
      .where('collectionStatus', 'in', [CS.DUE, CS.REMINDED, CS.OVERDUE])
      .limit(500)
      .get();

    let commission = 0, penalty = 0;
    const items = snap.docs.map((doc) => {
      const d = doc.data();
      const c = Number(d.totalOwed || 0);
      const p = Number(d.penaltyKES || 0);
      commission += c; penalty += p;
      return {
        id: doc.id,
        reference:  d.mpesaCode || d.orderId || d.paymentId || doc.id,
        grossAmount: Number(d.grossAmount || 0),
        commissionPct: d.commissionPct ?? null,
        commissionKES: c,
        penaltyKES: p,
        dueAt: d.dueAt?.toMillis?.() || null,
        status: d.collectionStatus || null,
      };
    });

    const restrictSnap = await db.collection(RESTRICTION).doc(uid).get();

    return {
      commissionKES: Math.round(commission * 100) / 100,
      penaltyKES:    Math.round(penalty * 100) / 100,
      totalOutstanding: Math.round((commission + penalty) * 100) / 100,
      items,
      restricted: restrictSnap.exists ? restrictSnap.data().restricted === true : false,
      /* The seller sees the policy that governs them BEFORE it is enforced. */
      penaltyPolicy: await loadPenaltyPolicy(),
    };
  }
);

/* ── computeOutstandingKES — the server-authoritative amount a seller owes ────
   The single source of the outstanding figure. getCommissionBalance renders it
   for the seller; the payment registry prices a collection intent from it so the
   amount a seller is asked to pay is derived here, never sent by the client.
   Sums totalOwed + penaltyKES over the OPEN 48-hour rows — the exact set
   settleConfirmedPayment will clear — so the quote and the settlement agree. */
async function computeOutstandingKES(sellerUid) {
  const uid = String(sellerUid || '');
  if (!uid) return 0;
  const snap = await _db().collection(LEDGER)
    .where('sellerUid', '==', uid)
    .where('billingModel', '==', 'PER_SALE_48H')
    .where('collectionStatus', 'in', [CS.DUE, CS.REMINDED, CS.OVERDUE])
    .limit(500)
    .get();
  let total = 0;
  snap.docs.forEach((doc) => {
    const d = doc.data();
    total += Number(d.totalOwed || 0) + Number(d.penaltyKES || 0);
  });
  return Math.round(total * 100) / 100;
}

/* ══════════════════════════════════════════════════════════════════════════
   settleCommissionBalance — records a CONFIRMED payment. Never an intent.
   ══════════════════════════════════════════════════════════════════════════
   NOT callable from a browser. An STK request being ACCEPTED is not payment;
   the customer may never enter a PIN. Only a verified provider confirmation
   reaches here, and it arrives server-to-server.
   ══════════════════════════════════════════════════════════════════════════ */
async function settleConfirmedPayment({ sellerUid, amountKES, paymentRef, source }) {
  const db = _db();
  const uid = String(sellerUid);

  /* ── IDEMPOTENCY — the payment reference is the identity ─────────────────
     Webhooks arrive more than once; that is normal, not exceptional. This
     function previously queried OPEN rows and settled them by amount, with no
     lookup on paymentRef at all — so a redelivery of the SAME payment settled a
     SECOND tranche of rows. One real payment would clear twice the debt, and
     lift a restriction that should still stand.

     The reference is now CLAIMED in a transaction before any row is touched,
     using a deterministic id so the claim itself cannot be duplicated. This is
     the same shape darajaSTKCallback already uses to claim the
     pending→completed transition, and that commissionLedger/{paymentId} and
     sellerPayments/{checkoutId} use for their ids.

     A redelivery therefore becomes a NO-OP: no second ledger settlement, no
     second unlock, no duplicate audit event.
     See docs/COMMISSION_ENFORCEMENT_CONTRACT.md §6. */
  const ref = String(paymentRef || '').trim();
  if (!ref) {
    /* No reference means no idempotency key, and an unrepeatable settlement is
       not safer for being unguarded — it is simply unauditable. Refuse. */
    console.error('[commission-settle] refused: no paymentRef', { uid, amountKES });
    return { settled: 0, stillOwed: -1, restrictionCleared: false, reason: 'no_payment_ref' };
  }

  const claimRef = db.collection(SETTLEMENT).doc(ref);
  const claimed = await db.runTransaction(async (txn) => {
    const prior = await txn.get(claimRef);
    if (prior.exists) return false;          /* already applied — redelivery */
    txn.set(claimRef, {
      paymentRef: ref,
      sellerUid: uid,
      amountKES: Number(amountKES || 0),
      source: String(source || 'unknown'),
      status: 'applying',
      createdAt: _ts(),
    });
    return true;
  });

  if (!claimed) {
    console.log(`[commission-settle] redelivery ignored ref=${ref} uid=${uid}`);
    return { settled: 0, stillOwed: 0, restrictionCleared: false, reason: 'already_settled' };
  }

  const snap = await db.collection(LEDGER)
    .where('sellerUid', '==', uid)
    .where('billingModel', '==', 'PER_SALE_48H')
    .where('collectionStatus', 'in', [CS.DUE, CS.REMINDED, CS.OVERDUE])
    .limit(500)
    .get();

  let remaining = Number(amountKES || 0);
  let settled = 0, stillOwed = 0;

  /* Oldest first: a partial payment clears the most overdue obligations, which
     is both the fair order and the one that reduces penalty exposure fastest. */
  const rows = snap.docs.slice().sort((a, b) => {
    const x = a.data().dueAt?.toMillis?.() || 0;
    const y = b.data().dueAt?.toMillis?.() || 0;
    return x - y;
  });

  for (const doc of rows) {
    const d = doc.data();
    const owed = Number(d.totalOutstanding ?? d.totalOwed ?? 0);
    if (owed <= 0) continue;

    if (remaining >= owed - 0.005) {
      await doc.ref.set({
        collectionStatus: CS.PAID,
        paidAt: _ts(),
        paymentRef: String(paymentRef || null),
        paymentSource: String(source || 'unknown'),
        totalOutstanding: 0,
        updatedAt: _ts(),
      }, { merge: true });
      remaining -= owed;
      settled++;
    } else {
      /* Partial settlement is recorded on the row; the row stays open. Marking
         it PAID for a partial amount would erase a real debt. */
      if (remaining > 0) {
        await doc.ref.set({
          totalOutstanding: Math.round((owed - remaining) * 100) / 100,
          partialPaidKES: admin.firestore.FieldValue.increment(remaining),
          updatedAt: _ts(),
        }, { merge: true });
        remaining = 0;
      }
      stillOwed += 1;
    }
  }

  /* Restriction lifts ONLY when nothing is outstanding. */
  if (stillOwed === 0) {
    await db.collection(RESTRICTION).doc(uid).set({
      restricted: false,
      reason: null,
      outstandingKES: 0,
      clearedAt: _ts(),
      clearedByPaymentRef: String(paymentRef || null),
      updatedAt: _ts(),
    }, { merge: true });
  }

  await claimRef.set({ status: 'applied', settled, stillOwed,
    restrictionCleared: stillOwed === 0, appliedAt: _ts() }, { merge: true });

  console.log(`[commission-settle] uid=${uid} ref=${paymentRef} settled=${settled} openRowsLeft=${stillOwed} restrictionCleared=${stillOwed === 0}`);
  return { settled, stillOwed, restrictionCleared: stillOwed === 0 };
}

/* ══════════════════════════════════════════════════════════════════════════
   getSellerRestriction — what the premium gate reads. Server-computed only.
   ══════════════════════════════════════════════════════════════════════════ */
exports.getSellerRestriction = onCall(
  { region: REGION, timeoutSeconds: 15, cors: true },
  async (req) => {
    if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const snap = await _db().collection(RESTRICTION).doc(String(req.auth.uid)).get();
    if (!snap.exists) return { restricted: false, outstandingKES: 0 };
    const d = snap.data();
    return {
      restricted: d.restricted === true,
      outstandingKES: Number(d.outstandingKES || 0),
      reason: d.reason || null,
      restrictedAt: d.restrictedAt?.toMillis?.() || null,
    };
  }
);

module.exports = {
  sweepCommissionDue:   exports.sweepCommissionDue,
  getCommissionBalance: exports.getCommissionBalance,
  getSellerRestriction: exports.getSellerRestriction,
  settleConfirmedPayment,
  computeOutstandingKES,
  loadPenaltyPolicy,
  computePenalty,
  CS,
  DUE_HOURS,
  REMINDER_HOURS,
};
