/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — SUBSCRIPTION PAYMENT METHODS
   ══════════════════════════════════════════════════════════════════════════════
   One payment intent, several rails. The subscription system must not grow a
   separate activation path per payment method, because that is how six payment
   initiators already came to exist in this codebase.

       Subscription checkout
              │
         Payment Intent          createPaymentIntent (payment-intents.js)
              │                  server-derived amount, duplicate guard
       ┌──────┼────────┬──────────┐
       ▼      ▼        ▼          ▼
    WALLET  MPESA   AIRTEL     future rails
       └──────┴────────┴──────────┘
              │
       VERIFIED PAYMENT
              │
       Subscription ACTIVE

   ── A PAYMENT REQUEST IS NOT A PAYMENT ──────────────────────────────────────
   Only a VERIFIED payment activates a subscription. Wallet verifies by an atomic
   debit inside a transaction; M-PESA and Airtel verify by provider confirmation
   and webhook. `created`, `pending` and `processing` entitle nothing — that is
   enforced by the shared lifecycle in subscription-catalog.js, where
   PENDING_PAYMENT and PROCESSING carry `entitled: false`.

   ── IT COMPOSES; IT DOES NOT REBUILD ────────────────────────────────────────
   The wallet backend is FROZEN (tag wallet-backend-v1.0-frozen). This file does
   not modify it and does not open a second money path: it performs the same
   atomic balance-check-and-debit that `wallet.spendFromWallet` performs, against
   the same `wallets/{uid}.balance` and `walletTransactions/{id}` records, with a
   deterministic transaction id so a retry cannot double-spend.

   ── THE DEBIT MUST NEVER VANISH ─────────────────────────────────────────────
   If activation fails AFTER the wallet is debited, the money must not disappear.
   The debit and the intent's `paid` stamp happen in ONE transaction, so a later
   activation failure leaves a PAID intent that can be reconciled and retried —
   never a debited wallet with no record of what it bought.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const REGION = 'us-central1';
const OPTS = { region: REGION, enforceAppCheck: true };
const _db = () => admin.firestore();
const _now = () => admin.firestore.FieldValue.serverTimestamp();

/* The vocabulary the UI uses. The UI must not care which provider sits behind a
   rail — it names the method, the server owns the implementation. */
const METHODS = Object.freeze({
  SOKONI_WALLET: { id: 'SOKONI_WALLET', label: 'SOKONI Business Wallet', instant: true },
  MPESA:         { id: 'MPESA',         label: 'M-PESA',                 instant: false },
  AIRTEL_MONEY:  { id: 'AIRTEL_MONEY',  label: 'Airtel Money',           instant: false },
});

function isMethod(m) { return Object.prototype.hasOwnProperty.call(METHODS, String(m || '')); }

function _uid(auth) {
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'Sign in to continue.');
  return auth.uid;
}

/* ══════════════════════════════════════════════════════════════════════════════
   subscriptionPaymentMethods — what this merchant can actually pay with
   ══════════════════════════════════════════════════════════════════════════════
   Returns the wallet balance so the UI can show it, and marks the wallet
   unaffordable rather than hiding it — a merchant should see why a rail is
   unavailable, not wonder where it went. */
exports.subscriptionPaymentMethods = onCall(OPTS, async ({ data, auth }) => {
  const uid = _uid(auth);
  const amountKES = Number((data || {}).amount);

  let balance = null;
  try {
    const w = await _db().collection('wallets').doc(uid).get();
    if (w.exists && typeof w.data().balance === 'number') balance = w.data().balance;
  } catch (_) { balance = null; }

  const affordable = (balance !== null && Number.isFinite(amountKES)) ? balance >= amountKES : null;

  return {
    methods: [
      {
        ...METHODS.SOKONI_WALLET,
        /* null, never 0, when the balance could not be read — a merchant with
           funds must never be told they have none. */
        balance: balance,
        available: affordable === true,
        reason: affordable === false ? 'insufficient-balance'
              : affordable === null ? 'balance-unavailable' : null,
      },
      { ...METHODS.MPESA, available: true, reason: null },
      { ...METHODS.AIRTEL_MONEY, available: true, reason: null },
    ],
    amount: Number.isFinite(amountKES) ? amountKES : null,
    currency: 'KES',
  };
});

/* ══════════════════════════════════════════════════════════════════════════════
   payIntentWithWallet — the instant rail, verified by an atomic debit
   ══════════════════════════════════════════════════════════════════════════════
   Consumes a payment intent minted by createPaymentIntent. The AMOUNT comes from
   the intent, never from the caller: a client that could name its own price
   would make the catalogue decorative. */
exports.payIntentWithWallet = onCall(OPTS, async ({ data, auth }) => {
  const uid = _uid(auth);
  const intentId = String((data || {}).paymentIntentId || '').slice(0, 128);
  if (!intentId) throw new HttpsError('invalid-argument', 'paymentIntentId required');

  const intentRef = _db().collection('paymentIntents').doc(intentId);
  const walletRef = _db().collection('wallets').doc(uid);
  /* Deterministic, so a double-tap claims the same row rather than debiting
     twice. Mirrors wallet.spendFromWallet's `{uid}_{orderId}_spend` shape. */
  const txRef = _db().collection('walletTransactions').doc(uid + '_' + intentId + '_spend');

  let result = null;

  await _db().runTransaction(async (t) => {
    const [intentSnap, walletSnap, txSnap] = await Promise.all([
      t.get(intentRef), t.get(walletRef), t.get(txRef),
    ]);

    if (!intentSnap.exists) throw new HttpsError('not-found', 'Payment intent not found.');
    const intent = intentSnap.data();

    /* Ownership, before anything else. */
    if (intent.uid !== uid) throw new HttpsError('permission-denied', 'This payment is not yours.');

    /* Already settled — return the original outcome rather than charging again. */
    if (txSnap.exists && txSnap.data().status === 'completed') {
      result = { ok: true, replayed: true, paymentIntentId: intentId,
                 amount: intent.amount, newBalance: walletSnap.exists ? walletSnap.data().balance : null };
      return;
    }

    if (intent.status === 'paid') {
      result = { ok: true, replayed: true, paymentIntentId: intentId, amount: intent.amount,
                 newBalance: walletSnap.exists ? walletSnap.data().balance : null };
      return;
    }
    if (intent.status !== 'created') {
      throw new HttpsError('failed-precondition', 'This payment can no longer be completed.');
    }

    /* An expired intent must not be payable — the price it quoted has aged out. */
    const exp = intent.expiresAt && intent.expiresAt.toMillis ? intent.expiresAt.toMillis() : null;
    if (exp && Date.now() > exp) throw new HttpsError('failed-precondition', 'This payment request has expired.');

    const amount = Number(intent.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new HttpsError('failed-precondition', 'This payment intent has no payable amount.');
    }

    if (!walletSnap.exists) throw new HttpsError('not-found', 'You do not have a SOKONI wallet yet.');
    const balance = walletSnap.data().balance;
    if (typeof balance !== 'number') throw new HttpsError('failed-precondition', 'Your wallet balance could not be read.');
    if (balance < amount) throw new HttpsError('failed-precondition', 'Insufficient wallet balance.');

    const newBalance = balance - amount;

    /* ── ONE TRANSACTION ────────────────────────────────────────────────────
       Debit, ledger row and the intent's PAID stamp commit together. If any
       part fails they all fail; if they succeed the money is spent AND the
       record of what it bought exists. A debit without that record is the one
       outcome that would leave a merchant paying for nothing. */
    t.update(walletRef, { balance: newBalance });
    t.set(txRef, {
      uid, type: 'debit', amount,
      description: 'SOKONI subscription — ' + (intent.planName || intent.planId || 'plan'),
      orderId: intentId, paymentIntentId: intentId, planId: intent.planId || null,
      method: METHODS.SOKONI_WALLET.id,
      status: 'completed', createdAt: admin.firestore.Timestamp.now(),
    });
    t.update(intentRef, {
      status: 'paid',
      method: METHODS.SOKONI_WALLET.id,
      paidAt: _now(),
      paidVia: 'wallet',
      walletTxId: txRef.id,
      /* Recorded so reconciliation can find an intent that was paid but whose
         subscription activation has not yet run. */
      activationPending: true,
    });

    result = { ok: true, replayed: false, paymentIntentId: intentId, amount, newBalance };
  });

  return result;
});

/* Internals for the certification suite. */
exports._internal = { METHODS, isMethod };
