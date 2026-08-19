'use strict';
/**
 * SOKONI Payment Intents — server-authoritative commercial values.
 *
 * WHY THIS EXISTS
 * initiateSTKPush accepted {phone, amount, ref} straight from the browser. A
 * live production payload proved it: api_ref SKNTJKAS8 was client-generated
 * with no paymentIntents record, and the function logged STK_NO_AUTHORITY
 * while charging the client-named figure. An authenticated user could pay
 * KES 1 for any plan, and every downstream commission, settlement and tax
 * figure would inherit that number.
 *
 * The fix is not to validate the client's number harder. It is to stop asking
 * the client. The server derives plan, amount, currency, merchant, reference
 * and expiry, writes them to paymentIntents/{ref}, and returns only an id.
 *
 * WHY paymentIntents/{ref} AND NOT A NEW COLLECTION
 * initiateSTKPush already looks up paymentIntents/{ref} and already enforces
 * ownership and amount when the document exists (index.js ~5232). This is the
 * missing half of an authority model that was built and never populated —
 * "Stage 1b" in that function's own comment. No parallel payment path is
 * introduced; the canonical one is finally given its source of truth.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const logger = require('firebase-functions/logger');
const { PLANS } = require('./sub-billing');
const timeline = require('./payment-timeline');

const REGION = 'us-central1';
const _OPTS = { region: REGION, timeoutSeconds: 20, memory: '256MiB', enforceAppCheck: true };

/** Intents are short-lived. A stale price must never be payable. */
const TTL_MS = 15 * 60 * 1000;

const db = () => admin.firestore();

/**
 * Reference format: SKN + 9 base36 chars, matching what the provider and the
 * existing STK path already carry. Server-minted and unguessable, so a client
 * cannot pre-create or collide with someone else's intent.
 */
function _mintRef() {
  const rnd = require('crypto').randomBytes(6).toString('hex').toUpperCase();
  return 'SKN' + rnd.slice(0, 9);
}

/**
 * createPaymentIntent — the ONLY way a subscription payment may begin.
 *
 * Client sends { planId, billingCycle, phone }. It does NOT send amount,
 * currency, merchant or reference: those are derived here and are the figures
 * the provider will be asked to collect.
 *
 * `phone` is accepted from the client because it is the customer's own handset
 * and carries no commercial authority — it cannot change what is charged. It is
 * still validated, and it is recorded on the intent so the STK call does not
 * re-read it from the request.
 */
exports.createPaymentIntent = onCall(_OPTS, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const uid = request.auth.uid;

  const { planId, billingCycle, phone, purpose } = request.data || {};

  /* ── Non-subscription purposes ────────────────────────────────────────────
     createPaymentIntent could only mint purpose 'subscription'. Every other
     paid domain therefore had no intent, which is why none of them could be
     swept by the reconciler and why the digital-download adapter had nothing to
     fire on — one hardcoded field was the bottleneck behind four non-compliant
     domains.

     Other purposes are dispatched to the registry, which derives the price from
     Firestore exactly as the subscription branch derives it from the plan
     catalogue. No branch anywhere reads an amount from the request. An
     unregistered purpose is rejected rather than defaulted, because silently
     treating an unknown purpose as a subscription is precisely the quiet
     mis-dispatch this registry exists to prevent.

     The subscription path below is unchanged, and a request that omits
     `purpose` still takes it — existing clients are unaffected. */
  if (purpose && purpose !== 'subscription') {
    const purposes = require('./payment-purposes');
    const quote = await purposes.priceFor(purpose, uid, request.data || {});

    if (phone && !/^254[17]\d{8}$/.test(String(phone))) {
      throw new HttpsError('invalid-argument', 'Invalid phone number.');
    }

    const ref2 = _mintRef();
    const now2 = Date.now();
    const intent2 = {
      ref:          ref2,
      uid,
      ownerUid:     uid,
      purpose:      quote.purpose,
      resourceType: quote.resourceType,
      resourceId:   quote.resourceId,
      amount:       quote.amount,          /* whole KES — what the provider collects */
      amountCents:  quote.amountCents,
      currency:     quote.currency || 'KES',
      phone:        phone ? String(phone) : null,
      merchantId:   (request.data || {}).merchantId || null,
      metadata:     quote.metadata || {},
      correlationId: ref2,
      status:       'created',
      createdAt:    admin.firestore.FieldValue.serverTimestamp(),
      expiresAt:    admin.firestore.Timestamp.fromMillis(now2 + TTL_MS),
      createdBy:    'createPaymentIntent',
    };

    await db().collection('paymentIntents').doc(ref2).create(intent2);
    timeline.mark(ref2, 'intent_created', {
      uid, purpose: quote.purpose, resourceId: quote.resourceId, amount: quote.amount,
    });
    logger.info('[intent] created', { ref: ref2, purpose: quote.purpose, resourceId: quote.resourceId, amount: quote.amount });

    return { ref: ref2, amount: quote.amount, currency: intent2.currency, purpose: quote.purpose };
  }

  if (!planId || typeof planId !== 'string') {
    throw new HttpsError('invalid-argument', 'planId is required.');
  }
  const cycle = billingCycle === 'annual' ? 'annual' : 'monthly';

  /* Optional at mint time. SokoniPay.gateway collects the handset later, and a
     phone number cannot change what is charged — only plan and amount carry
     commercial authority, and both are derived below. Validated when supplied;
     initiateSTKPush still requires a valid number at push time. */
  if (phone && !/^254[17]\d{8}$/.test(String(phone))) {
    throw new HttpsError('invalid-argument', 'Invalid phone number.');
  }

  /* ── Price resolution: catalogue first, built-in second ──────────────────
     Mirrors subGetPlans so a plan cannot cost one figure on the pricing page
     and another at the till. A custom Firestore plan overrides the built-in
     of the same id, exactly as the plan listing merges them. */
  let plan = PLANS[planId] ? { ...PLANS[planId] } : null;
  try {
    const custom = await db().collection('subscriptionPlans').doc(planId).get();
    if (custom.exists) plan = { ...(plan || {}), ...custom.data(), id: planId };
  } catch (e) {
    logger.warn('[intent] subscriptionPlans lookup failed, using built-in', { planId, err: e.message });
  }

  if (!plan) throw new HttpsError('not-found', 'Unknown plan.');
  if (plan.isActive === false) throw new HttpsError('failed-precondition', 'This plan is no longer available.');

  /* Prices are stored in cents. The provider is asked for whole KES. */
  const cents = Number((plan.price || {})[cycle]);
  if (!Number.isFinite(cents) || cents <= 0) {
    throw new HttpsError('failed-precondition', `Plan "${planId}" has no valid ${cycle} price.`);
  }
  const amountKES = Math.round(cents / 100);
  if (amountKES < 1 || amountKES > 150000) {
    throw new HttpsError('failed-precondition', 'Plan price is outside the payable range.');
  }

  /* ── Duplicate-purchase guard ────────────────────────────────────────────
     Refuse to mint an intent for a plan the user already holds. This is the
     server half of "you're already subscribed"; the UI check is a courtesy,
     this is the authority. */
  try {
    const active = await db().collection('subscriptions')
      .where('uid', '==', uid)
      .where('planId', '==', planId)
      .where('status', '==', 'active')
      .limit(1).get();
    if (!active.empty) {
      throw new HttpsError('already-exists', "You're already subscribed to this plan.");
    }
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    logger.warn('[intent] active-subscription check failed, continuing', { uid, err: e.message });
  }

  /* ── Trial terms are part of the PURCHASE, derived here ──────────────────
     The trial that ships with a paid plan is a package feature, not the
     promotional free trial. It is resolved from the catalogue at mint time and
     carried on the intent so the reconciler activates on the terms that were
     quoted, not on whatever the catalogue says days later when the webhook
     lands. The browser cannot influence it.

     This is deliberately NOT a trialLedger question. trialLedger governs
     eligibility for the FREE promotional trial; asking it here is what made
     "you have already used your free plan" block a paid purchase. */
  const trialDays = Math.max(0, Math.min(90, Number((plan.trial || {}).days) || 0));

  const ref = _mintRef();
  const now = Date.now();

  const intent = {
    ref,
    uid,
    planId,
    planName:     plan.name || planId,
    billingCycle: cycle,
    trialDays,                        /* quoted terms, honoured at activation */
    amount:       amountKES,          /* the figure initiateSTKPush enforces */
    amountCents:  cents,
    currency:     'KES',
    phone:        phone ? String(phone) : null,
    hubType:      plan.hubType || null,
    merchantId:   (request.data || {}).merchantId || null,
    status:       'created',
    purpose:      'subscription',
    createdAt:    admin.firestore.FieldValue.serverTimestamp(),
    expiresAt:    admin.firestore.Timestamp.fromMillis(now + TTL_MS),
    createdBy:    'createPaymentIntent',
  };

  /* create(), not set(): a minted ref must never overwrite an existing intent. */
  await db().collection('paymentIntents').doc(ref).create(intent);

  /* First stage of the timeline. Every later stage joins on this ref. */
  timeline.mark(ref, 'intent_created', { uid, planId, cycle, amount: amountKES });

  logger.info('[intent] created', {
    ref, uid, planId, cycle, amount: amountKES, currency: 'KES',
  });

  /* Return the id and the display figures the UI needs to confirm — never a
     figure the client can send back as authority. */
  return {
    paymentIntentId: ref,
    planId,
    planName: intent.planName,
    amount: amountKES,
    currency: 'KES',
    billingCycle: cycle,
    /* So the checkout can state plainly when money moves and when the paid
       period starts. Display only — the reconciler reads the stored intent. */
    trialDays,
    expiresAt: now + TTL_MS,
  };
});
