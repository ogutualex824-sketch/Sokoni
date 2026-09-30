/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — PAYMENT-DESTINATION VERIFICATION, DRIVEN BY THE INTASEND WEBHOOK
   functions/payment-destination-verify.js
   ══════════════════════════════════════════════════════════════════════════════
   WHAT THIS REPLACES

   A payment destination reached VERIFIED exactly one way: the legacy STK callback saw
   a successful result for a test push and called confirmVerified(sellerUid, checkoutId).
   That callback is deleted, so markTesting, confirmVerified and markFailed were left with
   ZERO callers — a merchant could save a pending destination nothing could ever verify.

   THE AUTHORITATIVE EVENT IS NOW THE INTASEND WEBHOOK, and only the webhook.

       startPaymentDestinationTest      server mints paymentIntents/{ref}
                 │                      purpose 'destination_verification'
                 │                      amount + sellerUid set SERVER-SIDE
                 ▼
             IntaSend
                 │
                 ▼
       webhookIntasend                  challenge-verified, then applyWebhook() here
                 │
                 ▼
       verify against the INTENT        state · amount · currency · purpose · seller
                 │
                 ▼
       confirmVerified(sellerUid, ref)  the one atomic promotion

   WHAT MAKES THIS AUTHORITATIVE RATHER THAN JUST DIFFERENT

   Nothing here reads the request body for anything that decides the outcome. The seller,
   the expected amount and the currency all come from paymentIntents/{apiRef}, which was
   written by the server when the test was started. The webhook supplies only the OUTCOME
   of a payment it already authenticated by challenge. A browser cannot mint that intent,
   cannot reach this function, and cannot claim a payment succeeded.

   ONE-SHOT BY DESIGN

   The idempotency claim is taken BEFORE the amount and currency are checked, so a
   mismatched or replayed webhook cannot be retried into a success. A destination test is
   not a purchase to be re-attempted: a webhook whose figures disagree with the intent is
   evidence that something is wrong, and the correct response is to fail the test and make
   the merchant start a new one. Fail closed, once.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const admin = require('firebase-admin');

const PURPOSE = 'destination_verification';
const INTENTS = 'paymentIntents';

/* The provider states that mean "the buyer paid". Anything else is not a success, and
   an unknown state is treated as a failure rather than ignored — a test left in TESTING
   forever is indistinguishable from one that is still in flight. */
const SUCCESS_STATES = new Set(['COMPLETE', 'COMPLETED', 'PAID', 'SUCCESS']);

/**
 * Apply an IntaSend webhook event to a payment-destination test.
 *
 * Returns { applied, outcome, reason } and NEVER throws for a payload that simply is not
 * a destination test — the webhook handles many payment kinds and must not be broken by
 * one of them. A genuine internal failure still throws so it is not silently swallowed.
 *
 * @param db          Firestore
 * @param apiRef      our server-minted intent ref (invoice.api_ref)
 * @param state       provider state, e.g. 'COMPLETE'
 * @param amountKES   the amount the provider reports
 * @param currency    provider currency, when present
 */
async function applyWebhook(db, { apiRef, state, amountKES, currency }) {
  const ref = String(apiRef || '').trim();
  if (!ref) return { applied: false, outcome: 'skipped', reason: 'no_api_ref' };

  const intentRef = db.collection(INTENTS).doc(ref);
  const snap = await intentRef.get();
  if (!snap.exists) return { applied: false, outcome: 'skipped', reason: 'no_intent' };

  const intent = snap.data() || {};
  if (String(intent.purpose || '') !== PURPOSE) {
    return { applied: false, outcome: 'skipped', reason: 'not_a_destination_test' };
  }

  /* The seller comes from the INTENT, never from the webhook body. */
  const sellerUid = intent.metadata && intent.metadata.sellerUid
    ? String(intent.metadata.sellerUid) : '';
  if (!sellerUid) {
    return { applied: false, outcome: 'skipped', reason: 'intent_has_no_seller' };
  }

  /* ── the one-shot claim ──────────────────────────────────────────────────── */
  const claimed = await db.runTransaction(async (txn) => {
    const s = await txn.get(intentRef);
    const d = s.data() || {};
    if (d.verificationAppliedAt) return false;
    txn.update(intentRef, {
      verificationAppliedAt: admin.firestore.FieldValue.serverTimestamp(),
      verificationState: String(state || '').toUpperCase(),
    });
    return true;
  });
  if (!claimed) {
    return { applied: false, outcome: 'already_applied', reason: 'replay' };
  }

  const PD = require('./payment-destinations');

  /* ── the provider outcome ────────────────────────────────────────────────── */
  const st = String(state || '').toUpperCase();
  if (!SUCCESS_STATES.has(st)) {
    await PD.markFailed(sellerUid, 'payment_' + (st || 'UNKNOWN'));
    return { applied: true, outcome: 'failed', reason: 'state_' + (st || 'UNKNOWN') };
  }

  /* ── the figures must match what the server quoted ───────────────────────── */
  const expected = Number(intent.amount);
  const got = Number(amountKES);
  if (!Number.isFinite(expected) || !Number.isFinite(got) ||
      Math.round(got) !== Math.round(expected)) {
    await PD.markFailed(sellerUid, 'amount_mismatch');
    return { applied: true, outcome: 'amount_mismatch',
             reason: 'expected ' + expected + ', got ' + got };
  }

  const wantCur = String(intent.currency || 'KES').toUpperCase();
  const gotCur = currency ? String(currency).toUpperCase() : wantCur;
  if (gotCur !== wantCur) {
    await PD.markFailed(sellerUid, 'currency_mismatch');
    return { applied: true, outcome: 'currency_mismatch', reason: gotCur + ' != ' + wantCur };
  }

  /* ── the one atomic promotion ────────────────────────────────────────────── */
  const r = await PD.confirmVerified(sellerUid, ref);
  return r && r.swapped
    ? { applied: true, outcome: 'verified', reason: null }
    : { applied: true, outcome: 'not_swapped', reason: (r && r.reason) || 'unknown' };
}

module.exports = { applyWebhook, PURPOSE, SUCCESS_STATES };
