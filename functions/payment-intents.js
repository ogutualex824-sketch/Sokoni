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

    /* DETERMINISTIC REF, when the pricer asks for one.
       The marketplace product path keys payments/{ref} and orders/{ref} to the
       SAME deterministic order id, so a retry reuses one order identity instead
       of minting a second. Letting createPaymentIntent mint its own ref here
       would introduce a competing identity and force retry/idempotency semantics
       to be rebuilt around it. A pricer that returns `preferredRef` therefore
       owns the identity; everything else keeps the random ref. */
    const ref2 = quote.preferredRef ? String(quote.preferredRef) : _mintRef();
    if (quote.preferredRef && !/^[A-Za-z0-9_-]{6,128}$/.test(ref2)) {
      throw new HttpsError('invalid-argument', 'Invalid order reference.');
    }
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

    /* IDEMPOTENT REPLAY.
       With a deterministic ref, a retry of the same checkout necessarily hits an
       existing document. `.create()` throws ALREADY_EXISTS; surfacing that as a
       payment failure would strand a buyer who simply tapped Pay twice.

       So a replay RETURNS the existing intent — but only after proving it is the
       same purchase. Ownership, purpose, resource and amount must all match. A
       mismatch FAILS CLOSED rather than overwriting: an existing intent whose
       amount differs is either a stale cart or an attempt to re-price an
       identity that has already been quoted, and silently replacing it would
       hand back exactly the client-controlled amount B1 exists to remove.

       A terminal intent is never replayed — paying it again is a new purchase
       and must not reuse a consumed identity. */
    try {
      await db().collection('paymentIntents').doc(ref2).create(intent2);
    } catch (createErr) {
      if (!quote.preferredRef || createErr.code !== 6 /* ALREADY_EXISTS */) throw createErr;

      const priorSnap = await db().collection('paymentIntents').doc(ref2).get();
      if (!priorSnap.exists) throw createErr;              /* raced deletion — surface it */
      const prior = priorSnap.data() || {};

      const sameBuyer    = prior.uid === uid;
      const samePurpose  = prior.purpose === quote.purpose;
      const sameResource = String(prior.resourceId || '') === String(quote.resourceId || '');
      const sameAmount   = Number(prior.amountCents) === Number(quote.amountCents);
      const terminal     = ['paid', 'completed', 'cancelled', 'expired'].includes(String(prior.status));

      if (!sameBuyer || !samePurpose || !sameResource) {
        logger.error('[intent] replay REFUSED — identity mismatch', {
          ref: ref2, sameBuyer, samePurpose, sameResource,
        });
        throw new HttpsError('permission-denied', 'This order reference is already in use.');
      }
      if (terminal) {
        throw new HttpsError('failed-precondition',
          'This order has already been paid. Start a new order.');
      }
      if (!sameAmount) {
        logger.error('[intent] replay REFUSED — amount changed for an existing intent', {
          ref: ref2, priorCents: prior.amountCents, quotedCents: quote.amountCents,
        });
        throw new HttpsError('failed-precondition',
          'Your cart has changed since this order was created. Please refresh and try again.',
          { serverAmount: Math.round(Number(quote.amountCents) / 100) });
      }

      logger.info('[intent] idempotent replay', { ref: ref2, purpose: prior.purpose, amount: prior.amount });
      return { ref: ref2, amount: prior.amount, currency: prior.currency || 'KES',
        purpose: prior.purpose, replay: true };
    }
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

  const ref = _mintRef();
  const now = Date.now();

  const intent = {
    ref,
    uid,
    planId,
    planName:     plan.name || planId,
    billingCycle: cycle,
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
    expiresAt: now + TTL_MS,
  };
});
