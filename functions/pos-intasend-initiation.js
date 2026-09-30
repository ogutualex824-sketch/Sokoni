/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — POS/TILL PAYMENT INITIATION VIA INTASEND   (slice P5)
   functions/pos-intasend-initiation.js

       Till ─► posInitiateIntasendPayment ─► IntaSend STK ─► customer phone
                        │                                          │
                 posPaymentIntents/{ref}                     webhook (P5 bridge)
                        │                                          ▼
                        └───────────────────────────────► posPaymentStatus/{ref}
                                                                   │
                                              existing posCheckPaymentStatus poller

   WHAT WAS MISSING, AND WHAT ALREADY EXISTED
   ──────────────────────────────────────────
   The IntaSend *primitive* already exists: payment-adapters.js `IntaSendAdapter`
   `initiatePayment()` (POST /api/v1/payment/mpesa-stk-push/), proven by the live wallet
   top-up. The POS *poller* already exists: pos-zero-friction.js `posCheckPaymentStatus`
   reads `posPaymentStatus/{ref}`.

   Two things were absent, and this file supplies exactly those:
     1. INITIATION — nothing ever asked IntaSend to charge a till customer. POS initiation
        was the legacy STK initiator.
     2. THE BRIDGE — NOTHING wrote `posPaymentStatus`. The poller read a document no
        producer created, so it could only ever return `pending` or fall through.

   This path was built and certified before any cutover, and a live payment rail is never
   removed before its replacement is proven. It is now the only POS/Till initiator.

   THE AMOUNT IS SERVER-HELD, NOT CLIENT-ASSERTED
   ──────────────────────────────────────────────
   Payment happens BEFORE posCompleteCheckout, so there is no server order to price
   against yet. The intent document is therefore the authority: the amount is recorded
   server-side at intent creation and every subsequent action — re-initiation, webhook
   finalisation, status — reads THAT value. A client cannot raise or lower a charge by
   replaying with different data; a mismatched replay is refused, not silently re-priced.

   COMMISSION IS NOT TOUCHED HERE
   ──────────────────────────────
   This file moves the CUSTOMER's money to the shop. It creates no commission entry of any
   kind. POS/Till commission is a 5% RECEIVABLE accrued once by posCompleteCheckout
   (P1/P4) and collected under the 07:00 gate (P3). P4 removed a duplicate accrual that
   arose exactly because a payment path also recorded commission — this path must never
   reintroduce one.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const INTASEND_PRIVATE_KEY = defineSecret('INTASEND_PRIVATE_KEY');

const REGION   = 'us-central1';
const INTENTS  = 'posPaymentIntents';
const STATUS   = 'posPaymentStatus';   /* read by the EXISTING posCheckPaymentStatus poller */
const REF_PREFIX = 'postill_';

const _db = () => getFirestore();

/* Deterministic, collision-free, and self-describing. The webhook dispatches on the
   api_ref prefix exactly as it does for `pout_` (B2C) and `wtop_` (top-up), so a POS
   reference can never be mistaken for a wallet top-up or a payout. */
function posRef(merchantId, idempotencyKey) {
  const safe = String(idempotencyKey).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const biz  = String(merchantId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return REF_PREFIX + biz + '_' + safe;
}
const isPosRef = (ref) => typeof ref === 'string' && ref.startsWith(REF_PREFIX);

/* IntaSend reports many terminal words; the poller understands three states. */
function mapState(state) {
  const s = String(state || '').toUpperCase();
  if (s === 'COMPLETE' || s === 'COMPLETED' || s === 'SUCCESS') return 'completed';
  if (['FAILED', 'CANCELLED', 'EXPIRED', 'REJECTED', 'TIMEOUT'].includes(s)) return 'failed';
  return 'pending';
}

/**
 * Create (or re-read) the POS payment intent and ask IntaSend to prompt the customer.
 *
 * Idempotent on (merchantId, idempotencyKey): a repeated call NEVER pushes a second STK
 * for the same till checkout — a customer must not get two prompts, and a shop must not
 * be able to charge twice by retrying.
 */
/* METHODS THIS RAIL WILL INITIATE. An allow-list, so an unrecognised method is refused
   rather than quietly treated as M-PESA — a caller asking for something this server does
   not implement must be told, not silently given a different payment. */
const INIT_METHODS = ['MPESA', 'CARD'];

async function initiate(db, { merchantId, idempotencyKey, phone, amountKES, narrative, adapter, method }) {
  /* ── WHICH METHOD, DECIDED HERE ────────────────────────────────────────────────────
     CARD IS A METHOD ON THIS RAIL, NOT A RAIL OF ITS OWN. SOKONI briefly had an
     independent card path — PosTerminals, whose Bluetooth and "manual" adapters approved
     on Math.random() — and it was removed because a client cannot be the authority on
     whether money arrived. Rebuilding card as a second acquirer would reintroduce exactly
     that: a second thing that can say "paid", a second webhook, a second reconciliation.

     So card collects where M-PESA already collects. The intent, the api_ref, the webhook
     and the collection proof are the same ones; only the way the payer is reached differs
     — STK rings a handset, a card checkout returns a URL the cardholder completes. The
     wallet, the commission and the channel totals downstream learn nothing new.

     The method is recorded ON THE INTENT so the proof can carry it, which is what lets the
     wallet report method and channel as two independent dimensions. */
  const _method = String(method || 'MPESA').toUpperCase();
  if (INIT_METHODS.indexOf(_method) === -1) {
    throw new HttpsError('invalid-argument',
      'Unsupported payment method: ' + _method + '. This rail initiates ' + INIT_METHODS.join(' or ') + '.');
  }
  if (_method === 'MPESA' && !phone) {
    throw new HttpsError('invalid-argument', 'An M-PESA payment needs the payer phone number.');
  }
  if (!merchantId)     throw new HttpsError('invalid-argument', 'merchantId required.');
  if (!idempotencyKey) throw new HttpsError('invalid-argument', 'idempotencyKey required.');
  if (!phone)          throw new HttpsError('invalid-argument', 'phone required.');

  const amt = Number(amountKES);
  if (!Number.isFinite(amt) || amt <= 0) throw new HttpsError('invalid-argument', 'amountKES must be positive.');
  const amountCents = Math.round(amt * 100);

  const ref = posRef(merchantId, idempotencyKey);
  const intentRef = db.collection(INTENTS).doc(ref);

  /* CLAIM FIRST, CALL THE PROVIDER SECOND. The claim is a transaction on one document, so
     two tills pressing Pay at the same instant produce one claim; the loser returns the
     winner's result instead of pushing a second STK. */
  const claim = await db.runTransaction(async (txn) => {
    const snap = await txn.get(intentRef);
    if (snap.exists) {
      const d = snap.data();
      /* A replay that disagrees about money is refused, never re-priced. */
      if (d.amountCents !== amountCents) {
        return { conflict: true, storedCents: d.amountCents, requestedCents: amountCents };
      }
      if (String(d.merchantId) !== String(merchantId)) {
        return { conflict: true, foreignBusiness: true };
      }
      return { existing: true, intent: d };
    }
    txn.set(intentRef, {
      ref, merchantId: String(merchantId), idempotencyKey: String(idempotencyKey),
      amountCents, currency: 'KES',
      /* The METHOD this intent was minted for. The proof reads it back, so the wallet can
         report how the money arrived independently of where the sale happened. */
      method: _method,
      provider: 'intasend', state: 'initiating',
      providerInvoiceId: null, providerRef: ref,
      createdAtMs: Date.now(), createdAt: FieldValue.serverTimestamp(),
    });
    return { created: true };
  });

  if (claim.conflict) {
    if (claim.foreignBusiness) {
      throw new HttpsError('permission-denied', 'This payment reference belongs to another business.');
    }
    throw new HttpsError('failed-precondition',
      'This checkout was already initiated for a different amount.',
      { storedCents: claim.storedCents, requestedCents: claim.requestedCents });
  }
  if (claim.existing) {
    return { ref, reused: true, state: claim.intent.state,
             providerInvoiceId: claim.intent.providerInvoiceId || null,
             amountCents: claim.intent.amountCents };
  }

  /* Provider call happens OUTSIDE the transaction — a network call inside one would be
     retried by Firestore and could push several STKs for a single till checkout. */
  let result;
  try {
    /* The SERVER's amount, from the claim above — never the argument re-read. Both
       branches take it from the same place, so a card checkout cannot be opened for a
       figure the caller chose any more than an STK can be pushed for one. */
    const _amountKES = amountCents / 100;
    const _narrative = narrative || ('SOKONI till ' + merchantId);
    result = _method === 'CARD'
      ? await adapter.initiateCardCheckout({ amountKES: _amountKES, ref, narrative: _narrative })
      : await adapter.initiatePayment({ phone, amountKES: _amountKES, ref, narrative: _narrative });
  } catch (e) {
    await intentRef.update({ state: 'failed', failureReason: (e && e.message) || String(e),
                             updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
    throw new HttpsError('unavailable', 'Payment provider unreachable: ' + ((e && e.message) || e));
  }

  if (!result || !result.success) {
    const reason = (result && result.error) || 'IntaSend did not accept the request';
    await intentRef.update({ state: 'failed', failureReason: reason,
                             updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
    return { ref, reused: false, state: 'failed', error: reason, amountCents };
  }

  await intentRef.update({
    state: 'pending',
    providerInvoiceId: result.invoiceId || null,
    providerRaw: { invoiceId: result.invoiceId || null },
    /* A card checkout is completed by the CARDHOLDER on a hosted page, so the till needs
       somewhere to send them. Stored on the intent rather than only returned, so a till
       that reloads mid-payment can recover the same checkout instead of minting a second. */
    ...(result.url ? { checkoutUrl: String(result.url) } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { ref, reused: false, state: 'pending', method: _method,
           checkoutUrl: result.url || null,
           providerInvoiceId: result.invoiceId || null, amountCents };
}

/**
 * THE WEBHOOK BRIDGE. Returns true when it handled the reference, so the caller can stop.
 *
 * Writes `posPaymentStatus/{ref}` — the document the EXISTING poller already reads. That
 * is why this is a bridge rather than a new status system: the read side was already
 * built and simply had no producer.
 *
 * Idempotent and transactional: IntaSend retries on timeout, and two concurrent
 * deliveries must not both transition a payment.
 */
/* THE PAYLOAD IS NOW A PARAMETER, and that is the point of the change.
   This function used to take (db, apiRef, state, amount) and therefore could not know
   which method the customer had actually used — it had only the intent, which records
   what SOKONI REQUESTED at initiation. So a checkout opened as CARD and paid by M-PESA
   was recorded, permanently, as CARD.

   `payload` is optional so existing callers keep working; where it is absent the status
   records method UNKNOWN rather than inheriting the intent's request. That is a
   deliberate downgrade: "we could not tell" is a fact a reconciliation can act on, while
   a confident wrong answer is not. */
async function finalizeFromWebhook(db, apiRef, state, amount, payload) {
  if (!isPosRef(apiRef)) return false;      /* not ours — let the caller continue */
  const mapped = mapState(state);
  /* Read the provider's own answer. Never the intent's. */
  const _im = require('./intasend-method');
  const _mv = _im.normalizeIntasendPaymentMethod(payload);
  const _actualMethod = _mv.ok ? _mv.method : 'UNKNOWN';
  const intentRef = db.collection(INTENTS).doc(apiRef);
  const statusRef = db.collection(STATUS).doc(apiRef);

  await db.runTransaction(async (txn) => {
    const [iSnap, sSnap] = await Promise.all([txn.get(intentRef), txn.get(statusRef)]);
    /* A terminal status is final: a late duplicate delivery cannot re-open or flip it. */
    if (sSnap.exists && ['completed', 'failed'].includes(sSnap.data().status)) return;

    const intent = iSnap.exists ? iSnap.data() : null;
    txn.set(statusRef, {
      ref: apiRef,
      status: mapped,
      merchantId: intent ? intent.merchantId : null,
      amountCents: intent ? intent.amountCents : null,
      confirmedAmountKES: (amount === undefined || amount === null) ? null : Number(amount),
      transactionRef: apiRef,
      failureReason: mapped === 'failed' ? ('provider state ' + String(state)) : null,
      providerState: String(state || ''),
      /* ── ATTRIBUTION, FROM THE PROVIDER ──────────────────────────────────────
         `method` is what the customer actually paid with. `methodSource` says how we
         know, so a later reader can tell a confirmed attribution from a gap without
         re-deriving it: 'provider' means IntaSend told us, 'unavailable' means it did
         not and nothing was substituted. `methodRaw` keeps the provider's own spelling
         — an unrecognised value is then a one-line addition to PROVIDER_MAP rather than
         an investigation. */
      method: _actualMethod,
      methodSource: _mv.ok ? 'provider' : 'unavailable',
      methodRaw: _mv.raw || null,
      methodReason: _mv.ok ? null : _mv.reason,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    if (iSnap.exists) txn.update(intentRef, { state: mapped, updatedAt: FieldValue.serverTimestamp() });
  });
  return true;
}

/* ── Callable ─────────────────────────────────────────────────────────────────
   The business is derived SERVER-SIDE from the caller's access, never trusted from the
   payload: without this, one shop could prompt a customer and have the money land against
   another shop's till. */
exports.posInitiateIntasendPayment = onCall(
  { region: REGION, enforceAppCheck: true, memory: '256MiB', timeoutSeconds: 60,
    secrets: [INTASEND_PRIVATE_KEY] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const { merchantId, idempotencyKey, phone, amountKES, narrative, method } = request.data || {};
    if (!merchantId) throw new HttpsError('invalid-argument', 'merchantId required.');

    const { assertShopAccess } = require('./shop-employees');
    await assertShopAccess(request.auth.uid, String(merchantId));   /* throws permission-denied */

    const { getAdapter } = require('./payment-adapters');
    const adapter = getAdapter('intasend', { key: INTASEND_PRIVATE_KEY.value(), sandbox: false });

    return initiate(_db(), { merchantId, idempotencyKey, phone, amountKES, narrative, adapter, method });
  }
);

module.exports.initiate = initiate;
module.exports.finalizeFromWebhook = finalizeFromWebhook;
module.exports.posRef = posRef;
module.exports.isPosRef = isPosRef;
module.exports.mapState = mapState;
module.exports.INTENTS = INTENTS;
module.exports.STATUS = STATUS;
module.exports.REF_PREFIX = REF_PREFIX;
