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
const PENALTY_DOC = 'revenueConfig/commission_penalty';

/* DUE_HOURS (48) and REMINDER_HOURS (46) are DELETED with the state machine that read
   them. They were dead — declared and exported, read by nothing — and a surviving
   constant on this path is how a retired clock restarts: the next person to need a
   deadline finds one already named and reaches for it. */

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
   THE 48-HOUR COMMISSION MECHANISM IS DELETED
   ══════════════════════════════════════════════════════════════════════════
   `sweepCommissionDue` ran hourly (15 * * * *, Africa/Nairobi) and drove the
   DUE -> REMINDED -> OVERDUE state machine over rows stamped PER_SALE_48H.
   POS/Till commission is now collected at the 06:00 business-day gate against the
   OUTSTANDING OBLIGATION (accrued minus collected), not on a 48-hour timer.

   DELETED, NOT DISABLED. A flag would have left an hourly money-touching job one
   edit away from returning, and a second deadline competing with the gate is how a
   merchant gets charged twice for one sale.

   WHAT DELIBERATELY SURVIVES, AND WHY IT MUST
     • getCommissionBalance / getSellerRestriction — READS. They report what a
       historical row says. Removing them would hide the debt, not settle it.
     • the PER_SALE_48H EXCLUSION in index.js (~4513, ~4521). Historical rows still
       carry that billingModel, and monthly invoicing skips them precisely because
       something else already owned them. Deleting the exclusion together with the
       mechanism would sweep already-settled obligations into monthly billing and
       BILL REAL MERCHANTS TWICE. The timer goes; the exclusion stays.

   Nothing stamps PER_SALE_48H any more (index.js:4054 writes MONTHLY), so the
   surviving population is closed and can only shrink.
   ══════════════════════════════════════════════════════════════════════════ */
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
  getCommissionBalance: exports.getCommissionBalance,
  getSellerRestriction: exports.getSellerRestriction,
  settleConfirmedPayment,
  loadPenaltyPolicy,
  computePenalty,
  CS,
};
