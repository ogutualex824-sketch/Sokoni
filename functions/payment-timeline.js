'use strict';
/**
 * SOKONI Payment Timeline — where did this payment stop?
 *
 * WHY THIS EXISTS
 * Diagnosing one failed KES 499 subscription took hours of Cloud Logging
 * queries across five services, and the answer turned out to be that webhooks
 * were arriving at a function whose name differed from the one being watched by
 * word order alone. Nothing in Firestore said which stage a payment had
 * reached, so every question needed a log query and every log query needed the
 * right service name guessed first.
 *
 * One document per payment, keyed by reference, with a timestamp per stage.
 * Answering "where did it stop" becomes a single read.
 *
 * DESIGN RULES
 * - Never throws. This is observability attached to a money path; it must not
 *   be able to fail a payment. Every write is best-effort and swallowed.
 * - Append-only per stage. A stage records its first occurrence and its latest,
 *   so a retry is visible as a retry rather than overwriting history.
 * - No secrets, no PINs, no full phone numbers. Only the last four digits.
 * - The correlation key is the payment reference, the same id the intent, the
 *   provider, the webhook and the financial records all carry. One id joins
 *   the whole lifecycle.
 */
const admin = require('firebase-admin');
const logger = require('firebase-functions/logger');

const db = () => admin.firestore();
const FV = () => admin.firestore.FieldValue;

/** Canonical stages, in lifecycle order. Anything else is rejected so a typo
 *  cannot silently create a stage nobody queries. */
const STAGES = [
  'intent_created',
  'stk_requested',
  'provider_accepted',
  'provider_rejected',
  'customer_authorized',
  'webhook_received',
  'webhook_verified',
  'webhook_rejected',
  'payment_reconciled',
  'order_updated',
  'inventory_updated',
  'subscription_activated',
  'financial_records_written',
  'settlement_queued',
  'failed',
];

/**
 * mark — record that a payment reached a stage.
 *
 * @param {string} ref    payment reference (the correlation id)
 * @param {string} stage  one of STAGES
 * @param {object} [data] small, non-sensitive context
 */
async function mark(ref, stage, data) {
  try {
    const key = String(ref || '').trim();
    if (!key) return;
    if (!STAGES.includes(stage)) {
      logger.warn('[timeline] unknown stage ignored', { ref: key, stage });
      return;
    }

    const safe = {};
    for (const [k, v] of Object.entries(data || {})) {
      if (/pin|secret|token|key|password/i.test(k)) continue;
      if (/^phone$/i.test(k) && v) { safe.phoneSuffix = String(v).slice(-4); continue; }
      if (v === undefined) continue;
      safe[k] = typeof v === 'object' ? JSON.stringify(v).slice(0, 300) : v;
    }

    const now = Date.now();
    await db().collection('paymentTimeline').doc(key).set({
      ref: key,
      /* Top-level uid so the Firestore rule can authorise a read. Nested only
         inside stages.*.data it would be invisible to resource.data.uid, and a
         customer could never see their own payment's progress. Written on the
         first stage that knows it and preserved thereafter. */
      ...(data && data.uid ? { uid: String(data.uid) } : {}),
      currentStage: stage,
      updatedAt: FV().serverTimestamp(),
      updatedAtMs: now,
      /* first occurrence is preserved; latest always moves */
      [`stages.${stage}.firstAt`]: FV().serverTimestamp(),
      [`stages.${stage}.lastAt`]: FV().serverTimestamp(),
      [`stages.${stage}.count`]: FV().increment(1),
      ...(Object.keys(safe).length ? { [`stages.${stage}.data`]: safe } : {}),
    }, { merge: true });

  } catch (e) {
    /* Observability must never break a payment. */
    logger.warn('[timeline] mark failed', { ref, stage, err: e && e.message });
  }
}

/**
 * fail — record a terminal failure with the reason a human needs.
 * Kept separate from mark() so failures are queryable without scanning stages.
 */
async function fail(ref, reason, data) {
  await mark(ref, 'failed', { reason, ...(data || {}) });
  try {
    await db().collection('paymentTimeline').doc(String(ref)).set({
      failed: true,
      failureReason: String(reason || 'unknown').slice(0, 300),
      failedAt: FV().serverTimestamp(),
    }, { merge: true });
  } catch (_) { /* best effort */ }
}

module.exports = { mark, fail, STAGES };
