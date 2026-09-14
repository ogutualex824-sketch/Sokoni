'use strict';
/**
 * SOKONI — a verified Healthcare subscription payment becomes an active subscription.
 * ============================================================================================
 * This is the NORMAL activation path. It closes the pre-deployment blocker where a customer
 * could pay for Clinic/Hospital/Enterprise and receive nothing: the intent was minted, IntaSend
 * collected the money, `payments/{ref}` went COMPLETE — and no subscription was ever created,
 * because the only caller of `entitlement-engine.activate()` was the reconciliation sweep, and
 * that sweep heals only when `_systemConfig/reconciliation.subscriptionAutoHeal === true`,
 * which defaults false and fails closed.
 *
 *     customer selects a plan
 *       -> createPaymentIntent({ purpose: 'healthcare_subscription', tier })   server prices it
 *       -> IntaSend
 *       -> webhook writes payments/{ref} COMPLETE
 *       -> THIS TRIGGER
 *       -> entitlement-engine.activate(ref)                                    engine verifies
 *       -> accountSubscriptions/{uid}_healthcare
 *       -> capabilities become available
 *
 * ── WHY A TRIGGER, NOT A CALLABLE ──────────────────────────────────────────────────────────
 * There is deliberately NO client-invocable "activate my subscription" operation. A callable
 * taking a payment reference would be safe in principle — the engine re-verifies everything —
 * but it is an unnecessary attack surface and it invites the next reader to add a "trust the
 * caller" shortcut. Activation is a consequence of money arriving, so it hangs off the money.
 *
 * ── WHY A TRIGGER, NOT THE WEBHOOK ─────────────────────────────────────────────────────────
 * There are TWO live IntaSend webhooks (`intasendWebhook` and `webhookIntasend`) and they
 * diverge in other branches. Hanging activation off `payments/{ref}` means it fires whichever
 * one wrote the payment, and stays correct if a third writer ever appears — including the
 * reconciler. It also keeps this change out of index.js.
 *
 * ── THE ENGINE REMAINS THE AUTHORITY ───────────────────────────────────────────────────────
 * This module performs NO payment reasoning. It decides only "is this a healthcare
 * subscription reference worth handing to the engine". Every actual check — terminal state,
 * not reversed, sufficient amount, ownership, exactly-once — lives in
 * entitlement-engine.assertPaymentHonourable and its create-only ledger, and re-deriving any
 * of it here is the mistake that makes a client-supplied paymentId sufficient to mint a paid
 * plan.
 *
 * ── RECONCILIATION STAYS A RECOVERY MECHANISM ──────────────────────────────────────────────
 * `subscriptionAutoHeal` is NOT enabled by this change and must not become the normal path: a
 * customer should not pay and then wait up to ten minutes for a sweep. The reconciler remains
 * the backstop for a payment this trigger missed, and because both routes converge on the same
 * `engine.activate(ref)` with the same create-only ledger doc, the two can never double-grant.
 */

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const logger = require('firebase-functions/logger');
const { getFirestore } = require('firebase-admin/firestore');

const { TERMINAL_PAID } = require('./shared/constants');

const REGION = 'us-central1';
const PURPOSE = 'healthcare_subscription';

const _db = () => getFirestore();

/**
 * Should this payment document be handed to the engine?
 *
 * Pure, and exported for the suite: the decision is small but load-bearing, and testing it
 * directly is cheaper than provoking every combination through a trigger harness.
 *
 * The BEFORE state matters. A payment that was already terminal before this write has already
 * been offered to the engine, so re-offering on every subsequent touch (a reconciler note, a
 * receipt id) is wasted work. It is not a correctness risk — the ledger is create-only — but
 * "idempotent" is not a reason to be noisy.
 */
function shouldActivate(before, after) {
  if (!after) return false;
  const wasPaid = TERMINAL_PAID.has(String((before && before.status) || '').toUpperCase());
  const isPaid  = TERMINAL_PAID.has(String(after.status || '').toUpperCase());
  return isPaid && !wasPaid;
}

/**
 * The activation step. Separated from the trigger wrapper so the suite can drive it with a
 * plain reference instead of synthesising Firestore event envelopes.
 *
 * Returns a small verdict object rather than throwing for the ordinary "not ours" cases — a
 * trigger that throws on every unrelated payment fills the error budget with non-events.
 */
async function activateIfHealthcareSubscription(paymentRef, opts = {}) {
  const ref = String(paymentRef || '').trim();
  if (!ref) return { skipped: 'no_ref' };

  /* Purpose comes from the server-minted INTENT, never from the payment document — a payment
     is written by a webhook parsing a third party's callback, whereas the intent is ours. */
  let intent = null;
  try {
    const snap = await _db().collection('paymentIntents').doc(ref).get();
    intent = snap.exists ? snap.data() : null;
  } catch (e) {
    /* An unreadable intent must NOT be treated as "not a subscription" — that would silently
       drop a paid activation. Surface it; the reconciler is the backstop. */
    logger.error('[hcSubActivation] intent read failed', { ref, error: e.message });
    return { skipped: 'intent_unreadable', error: e.message };
  }
  if (!intent) return { skipped: 'no_intent' };
  if (intent.purpose !== PURPOSE) return { skipped: 'other_purpose', purpose: intent.purpose || null };

  const engine = require('./entitlement-engine');
  require('./entitlement-adapters');            /* registers healthcare_subscription */

  try {
    const r = await engine.activate(ref, { source: opts.source || 'payment-trigger' });
    if (r && r.alreadyActive) {
      logger.info('[hcSubActivation] already active', { ref });
      return { alreadyActive: true };
    }
    logger.info('[hcSubActivation] activated', { ref, uid: intent.uid || intent.ownerUid || null });
    return { activated: true, domain: (r && r.domain) || null };
  } catch (e) {
    /* A refusal is the engine doing its job — an unpaid, short, reversed or mis-owned payment
       must not activate. Logged as a refusal, not an outage, and never rethrown: throwing here
       makes Firestore retry the trigger against a payment that will be refused every time. */
    logger.warn('[hcSubActivation] refused', { ref, code: e.code || null, error: e.message });
    return { refused: true, code: e.code || 'unknown', error: e.message };
  }
}

/**
 * payments/{ref} reaches a terminal paid state -> activate, if it is a healthcare subscription.
 *
 * Named distinctly from the four triggers already bound to this path
 * (adeOnPaymentCompleted, emailOnPaymentSuccess, onPaymentCreated, onPaymentUpdated) and
 * doing something none of them does, so this is an additional concern rather than a second
 * writer of an existing one.
 */
exports.hcActivateSubscriptionOnPayment = onDocumentWritten(
  { document: 'payments/{paymentId}', region: REGION, timeoutSeconds: 120, memory: '256MiB' },
  async (event) => {
    if (!event.data || !event.data.after || !event.data.after.exists) return;
    const after  = event.data.after.data();
    const before = event.data.before && event.data.before.exists ? event.data.before.data() : null;
    if (!shouldActivate(before, after)) return;

    await activateIfHealthcareSubscription(event.params.paymentId, { source: 'payment-trigger' })
      .catch((e) => logger.error('[hcSubActivation] unexpected', { ref: event.params.paymentId, error: e.message }));
  }
);

exports._internal = { shouldActivate, activateIfHealthcareSubscription, PURPOSE };
