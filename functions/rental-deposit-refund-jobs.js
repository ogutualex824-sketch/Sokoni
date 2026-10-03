'use strict';
/**
 * Wiring for the rental deposit refund executor (rental-deposit-refunds.js). Exported ONCE by name in index.js.
 *
 *   rentalDepositRefundOnCreate  — onDocumentCreated(rentalDepositRefunds/{id}) → executeDepositRefund (sent at most once).
 *   rentalDepositRefundReconcile — every 30 min: status reads for PROVIDER_ACCEPTED / OUTCOME_UNKNOWN / OVERDUE / DISPUTED.
 *                                  Never sends; a request with no chargebackId waits for a person.
 *   adminSetRefundPolicy         — admin / superAdmin only: sets refundPolicy/b2c.minCents, with an immutable adminAudit row
 *                                  (before → after). The ONLY writer of that document (no client rule = default deny).
 *
 * THE B2C MINIMUM COMES FROM CONFIG, NEVER CODE (owner 2026-10-03, direct): refundPolicy/b2c.minCents. Absent / invalid →
 * every refund is HELD ('b2c_minimum_not_configured'). The owner's chosen value is KES 100 (10,000 cents) — seeded by an
 * administrator through adminSetRefundPolicy, not by a deploy and not from a client. OWNER_B2C_MIN_CENTS documents it.
 */
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const RD = require('./rental-deposit-refunds');
const PA = require('./payment-adapters');

const INTASEND_PRIVATE_KEY = defineSecret('INTASEND_PRIVATE_KEY');
const REGION = 'us-central1';
const POLICY = ['refundPolicy', 'b2c'];
const MAX_MIN_CENTS = 1000000;   /* KES 10,000 — a sanity ceiling on the floor itself, not a refund limit */

async function readB2CMinCents(db) {
  try {
    const s = await db.collection(POLICY[0]).doc(POLICY[1]).get();
    const v = s.exists ? (s.data() || {}).minCents : null;
    return Number.isInteger(v) && v > 0 && v <= MAX_MIN_CENTS ? v : null;
  } catch (_) { return null; }   /* unreadable → not configured → held */
}

function _deps(db) {
  let adapter = null;
  try { adapter = PA.getAdapter('intasend', { key: INTASEND_PRIVATE_KEY.value(), sandbox: process.env.INTASEND_SANDBOX === 'true' }); } catch (_) { adapter = null; }
  return { adapter, contract: PA.REFUND_OUTCOME || null, FieldValue: admin.firestore.FieldValue };
}

exports.rentalDepositRefundOnCreate = onDocumentCreated({ document: 'rentalDepositRefunds/{id}', region: REGION, secrets: [INTASEND_PRIVATE_KEY], retry: false }, async (event) => {
  const db = admin.firestore();
  const minCents = await readB2CMinCents(db);
  const out = await RD.executeDepositRefund(db, event.params.id, Object.assign(_deps(db), { minCents }));
  console.info('[rentalDepositRefund] execute', event.params.id.slice(0, 12), out.outcome, out.reason || '');
});

exports.rentalDepositRefundReconcile = onSchedule({ schedule: 'every 30 minutes', region: REGION, secrets: [INTASEND_PRIVATE_KEY] }, async () => {
  const db = admin.firestore();
  const deps = _deps(db);
  const snap = await db.collection(RD.COL).where('state', 'in', ['PROVIDER_ACCEPTED', 'OUTCOME_UNKNOWN', 'OVERDUE', 'DISPUTED']).limit(50).get();
  for (const d of snap.docs) {
    try { const r = await RD.reconcileDepositRefund(db, d.id, deps); console.info('[rentalDepositRefund] reconcile', d.id.slice(0, 12), r.outcome); }
    catch (e) { console.warn('[rentalDepositRefund] reconcile failed', d.id.slice(0, 12), String(e && e.message || e).slice(0, 120)); }
  }
});

exports.adminSetRefundPolicy = onCall({ region: REGION }, async (req) => {
  const tok = (req.auth && req.auth.token) || {};
  if (!req.auth || !(tok.admin === true || tok.superAdmin === true)) throw new HttpsError('permission-denied', 'Administrators only.');
  const minCents = req.data && req.data.minCents;
  if (!Number.isInteger(minCents) || minCents < 100 || minCents > MAX_MIN_CENTS) {
    throw new HttpsError('invalid-argument', 'minCents must be a whole number of cents between 100 (KES 1) and ' + MAX_MIN_CENTS + '.');
  }
  const db = admin.firestore(); const FV = admin.firestore.FieldValue;
  const ref = db.collection(POLICY[0]).doc(POLICY[1]);
  const before = await db.runTransaction(async (t) => {
    const s = await t.get(ref); const prev = s.exists ? ((s.data() || {}).minCents ?? null) : null;
    t.set(ref, { minCents, setBy: req.auth.uid, setAt: FV.serverTimestamp() }, { merge: true });
    t.create(db.collection('adminAudit').doc(), { action: 'refund_policy_set', target: 'refundPolicy/b2c', performedBy: req.auth.uid,
      before: { minCents: prev }, after: { minCents }, at: FV.serverTimestamp() });
    return prev;
  });
  return { ok: true, minCents, previous: before };
});

exports._internal = { readB2CMinCents, MAX_MIN_CENTS };
