'use strict';
/**
 * SOKONI — CARD CHECKOUT
 *
 * ONE card-entry surface for the whole platform: IntaSend's hosted checkout.
 *
 * ── HOSTED CHECKOUT IS THE ENTRY MECHANISM; INTASEND IS THE AUTHORITY ────────────────────
 * This module does not make SOKONI a card system. It opens a page on the provider's own
 * domain for a payment intent the SERVER already priced, and then gets out of the way:
 * the confirmation, the webhook, the collection proof, the commission and the wallet
 * credit are the ones that already exist. Card is a payment METHOD on the IntaSend rail,
 * not a rail, and not a second settlement path.
 *
 * ── WHY THE BROWSER NO LONGER TOUCHES A CARD NUMBER ─────────────────────────────────────
 * The marketplace checkout collected the PAN, expiry and CVV in SOKONI's own DOM and
 * handed them to an inline SDK. It priced server-side first, so it was never the
 * fabricated-approval defect — but every script on that page, including anything loaded
 * from a CDN, sat in the cardholder-data path. Card details are now entered on IntaSend's
 * page. SOKONI never sees a card number, which is a smaller claim to have to defend than
 * "we handle them correctly".
 *
 * ── WHAT THE CLIENT MAY AND MAY NOT DECIDE ──────────────────────────────────────────────
 * May:  which METHOD to pay by — card or M-PESA.
 * May not: the amount, the seller, the channel, whether it was collected, or whether it
 *          settled. Every one of those is read here from the intent the server minted, and
 *          the caller supplies only a reference to it. A reference is a lookup key, not a
 *          claim: naming someone else's intent fails the ownership check below.
 *
 * ── A CHECKOUT THAT CANNOT BE OPENED IS NOT A SALE ──────────────────────────────────────
 * If IntaSend declines, or accepts and returns no payment URL, this fails. Nothing is
 * recorded, nothing is credited, and the buyer is told. The order remains unpaid, which is
 * the truth.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();

const REGION = 'us-central1';
const INTASEND_PRIVATE_KEY = defineSecret('INTASEND_PRIVATE_KEY');
const _db = () => admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const INTENTS = 'paymentIntents';

/* States an intent may be in and still be payable. A paid intent must not be re-opened —
   that is how one order gets charged twice — and a failed or expired one must be re-minted
   rather than resurrected. */
const OPENABLE = ['created', 'pending', 'initiating'];

/**
 * Open a hosted card checkout for an EXISTING server-minted intent.
 *
 * @param db      Firestore handle (injectable, so this is testable without an emulator)
 * @param ref     the intent reference — a lookup key, never an amount or an authority
 * @param uid     the authenticated caller
 * @param adapter the IntaSend adapter (injectable for the same reason)
 */
async function openCardCheckout(db, { ref, uid, adapter }) {
  const _ref = String(ref || '').trim();
  if (!_ref) throw new HttpsError('invalid-argument', 'A payment reference is required.');
  if (!uid)  throw new HttpsError('unauthenticated', 'Sign in to pay.');

  const snap = await db.collection(INTENTS).doc(_ref).get();
  if (!snap.exists) {
    /* Not "invalid reference" — a caller must not be able to probe which references
       exist by the shape of the error. */
    throw new HttpsError('not-found', 'This payment could not be found. Start the checkout again.');
  }
  const intent = snap.data() || {};

  /* WHOSE PAYMENT IT IS. Checked against the authenticated caller, not against anything in
     the request, so naming another buyer's reference gains nothing. */
  const owner = String(intent.uid || intent.ownerUid || '');
  if (!owner || owner !== String(uid)) {
    throw new HttpsError('permission-denied', 'This payment belongs to another account.');
  }

  const state = String(intent.status || '');
  if (state === 'paid') {
    throw new HttpsError('failed-precondition', 'This order has already been paid.');
  }
  if (OPENABLE.indexOf(state) === -1) {
    throw new HttpsError('failed-precondition',
      'This payment can no longer be completed (' + (state || 'unknown') + '). Start the checkout again.');
  }

  /* THE AMOUNT IS THE INTENT'S. Never the caller's, and never re-derived here — re-pricing
     at this point would be a second opinion about money, and two opinions is how a buyer
     approves one figure and is charged another. */
  const amountKES = Number(intent.amount);
  if (!Number.isFinite(amountKES) || amountKES <= 0) {
    throw new HttpsError('failed-precondition', 'This payment has no confirmed amount.');
  }

  /* An already-open checkout is REUSED rather than replaced. Minting a second one for the
     same intent gives the buyer two pages that can each be paid. */
  if (intent.checkoutUrl && state !== 'created') {
    return { ref: _ref, checkoutUrl: String(intent.checkoutUrl), amount: amountKES,
             methodsOffered: 'ALL', reused: true };
  }

  let result;
  try {
    result = await adapter.initiateCardCheckout({
      amountKES,
      ref: _ref,
      narrative: 'SOKONI order ' + _ref,
      email: intent.email || undefined,
    });
  } catch (e) {
    throw new HttpsError('unavailable',
      'Payment is unavailable right now: ' + ((e && e.message) || e));
  }

  if (!result || !result.success || !result.url) {
    /* NOT RECORDED AS PENDING. A checkout that could not be opened has not been
       attempted, and marking the intent pending would leave an order waiting on a payment
       page that does not exist. */
    throw new HttpsError('unavailable',
      (result && result.error) || 'Secure checkout could not be opened. You have NOT been charged.');
  }

  await db.collection(INTENTS).doc(_ref).update({
    /* NO METHOD IS RECORDED HERE. The hosted page offers every method the IntaSend
       account has enabled — the adapter omits `method` precisely so it does — and the
       customer has not chosen one yet, let alone paid. Stamping CARD at initiation
       recorded a guess about a rail the buyer may never touch, and an M-PESA payment
       made on that page would have been filed as a card payment forever.

       The actual method is derived from the VERIFIED webhook payload and written then.
       Until that happens the intent is simply awaiting payment. */
    methodsOffered: 'ALL',
    method: null,
    methodSource: 'awaiting_webhook',
    checkoutUrl: String(result.url),
    providerInvoiceId: result.invoiceId || null,
    status: 'pending',
    updatedAt: FieldValue.serverTimestamp(),
  });

  return { ref: _ref, checkoutUrl: String(result.url), amount: amountKES,
           methodsOffered: 'ALL', reused: false };
}

exports.openCardCheckout = openCardCheckout;
exports.OPENABLE = OPENABLE;

exports.createCardCheckout = onCall(
  { region: REGION, secrets: [INTASEND_PRIVATE_KEY], enforceAppCheck: true, timeoutSeconds: 30 },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to pay.');
    const { getAdapter } = require('./payment-adapters');
    const adapter = getAdapter('intasend', { key: INTASEND_PRIVATE_KEY.value(), sandbox: false });
    return openCardCheckout(_db(), {
      ref: (request.data || {}).ref,
      uid: request.auth.uid,
      adapter,
    });
  }
);
