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
      /* ── AIRTEL IS DECLARED, NOT WIRED ────────────────────────────────────
         There is no Airtel provider adapter. Reporting it available would put a
         button in front of a merchant that cannot take their money — the exact
         failure this project keeps finding, where something looks usable
         because it renders. It stays visible so the roadmap is honest, and
         unavailable so nobody can press it. Flip this ONLY when an adapter
         exists and has been verified against the provider. */
      { ...METHODS.AIRTEL_MONEY, available: false, reason: 'provider-not-available' },
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

/* ══════════════════════════════════════════════════════════════════════════════
   ACTIVATION RECONCILIATION — a PAID intent becomes a subscription, exactly once
   ══════════════════════════════════════════════════════════════════════════════
   This closes the dangerous gap: money collected without the merchant receiving
   what they bought. Until this existed, a wallet payment debited the balance,
   stamped the intent PAID, and stopped there.

   ── EXACTLY ONCE ────────────────────────────────────────────────────────────
   The subscription write and the intent's `reconciledAt` claim happen in ONE
   transaction. A replay reads the claim and returns the original subscription id
   without activating again — so a retry, a double-tap, a webhook redelivery and
   a sweeper can all call this safely.

   ── THE PLAN COMES FROM THE INTENT ──────────────────────────────────────────
   Never from the caller. The intent was minted server-side by
   createPaymentIntent, which derived the amount from the canonical catalogue.
   Re-deriving anything from a request here would reopen the hole that authority
   was built to close.

   ── A REQUEST IS STILL NOT A PAYMENT ────────────────────────────────────────
   Only `status === 'paid'` reconciles. `created`, `pending` and `processing` are
   refused, so no rail can activate a subscription by asking. */

const PERIOD_DAYS = { monthly: 30, annual: 365 };

async function reconcilePaidIntent(intentId) {
  const id = String(intentId || '').slice(0, 128);
  if (!id) return { ok: false, reason: 'no-intent-id' };

  const intentRef = _db().collection('paymentIntents').doc(id);
  let out = null;

  await _db().runTransaction(async (t) => {
    const snap = await t.get(intentRef);
    if (!snap.exists) { out = { ok: false, reason: 'intent-not-found' }; return; }
    const intent = snap.data();

    /* Already reconciled — return what was created, do not create it again. */
    if (intent.reconciledAt && intent.subscriptionId) {
      out = { ok: true, replayed: true, subscriptionId: intent.subscriptionId,
              planId: intent.planId, uid: intent.uid };
      return;
    }

    if (intent.status !== 'paid') {
      out = { ok: false, reason: 'not-paid:' + (intent.status || 'unknown') };
      return;
    }
    if (intent.purpose && intent.purpose !== 'subscription') {
      out = { ok: false, reason: 'not-a-subscription-intent' };
      return;
    }

    const uid = intent.uid;
    const planId = intent.planId;
    if (!uid || !planId) { out = { ok: false, reason: 'intent-incomplete' }; return; }

    const cycle = intent.billingCycle === 'annual' ? 'annual' : 'monthly';

    /* ── Trial period vs PAID period ────────────────────────────────────────
       A trial that ships with a paid plan delays the paid period; it does not
       consume it. Paying on the 19th with a 3-day trial means:

         trial   19 Aug → 22 Aug   (already paid for, nothing more to collect)
         paid    22 Aug → 22 Sep   (monthly)  or  22 Aug 2026 → 22 Aug 2027
         renewal 22 Sep

       Charging on the 19th and ending the paid month on the 19th would sell
       30 days and deliver 27. The paid period therefore STARTS at trial end.

       trialDays comes from the intent — the terms quoted when the merchant
       paid — not from today's catalogue. */
    const paidAtMs  = Date.now();
    const trialDays = Math.max(0, Math.min(90, Number(intent.trialDays) || 0));
    const trialEndMs = paidAtMs + trialDays * 86400000;
    const startMs = trialEndMs;                       /* paid period begins after the trial */
    const endMs = startMs + PERIOD_DAYS[cycle] * 86400000;
    const onTrial = trialDays > 0;

    /* One subscription per uid per hub. An upgrade REPLACES rather than
       accumulating a second document — two active subscriptions for one hub is
       how a merchant ends up billed twice and entitled once. */
    const subRef = _db().collection('subscriptions').doc(uid);

    const subDoc = {
      uid: uid,
      planId: planId,
      plan: planId,
      planName: intent.planName || planId,
      hubType: intent.hubType || null,
      billingCycle: cycle,
      /* `status` stays the one field every reader already consults — rules,
         entitlement-authority, the sweep, the UI. TRIALING and ACTIVE are both
         entitled (subscription-catalog LIFECYCLE), so the merchant has full
         access from the moment they pay. */
      status: onTrial ? 'trialing' : 'active',
      /* ── The three orthogonal facts, stated separately ──────────────────
         Collapsing them into one field is what made a paid subscription
         indistinguishable from an unpaid promotional trial. */
      paymentStatus: 'paid',                          /* the money arrived */
      subscriptionStatus: onTrial ? 'trialing' : 'active',
      trialStatus: onTrial ? 'active' : 'none',
      trialDays: trialDays,
      trialSource: onTrial ? 'paid_plan' : null,      /* NOT a promotional trial */
      trialStart: onTrial ? admin.firestore.Timestamp.fromMillis(paidAtMs) : null,
      trialEnd: onTrial ? admin.firestore.Timestamp.fromMillis(trialEndMs) : null,
      /* Already settled — the trial ending must never ask for money again. */
      renewalDueAt: admin.firestore.Timestamp.fromMillis(endMs),
      currentPeriodStart: admin.firestore.Timestamp.fromMillis(startMs),
      currentPeriodEnd: admin.firestore.Timestamp.fromMillis(endMs),
      /* Provenance: which payment bought this, and how it was paid. A
         subscription whose origin cannot be traced is a support ticket. */
      lastPaymentRef: id,
      lastPaymentAmountCents: intent.amountCents || null,
      lastPaymentMethod: intent.method || null,
      lastPaymentAt: _now(),
      /* ── COMPATIBILITY WITH THE DEPLOYED WEBHOOKS ─────────────────────────
         intasendWebhook (index.js:6848) and webhookMpesa (index.js:8333) both
         activate subscriptions themselves, and both guard on
         `subData.paymentRef !== apiRef`. Writing only `lastPaymentRef` would
         leave `paymentRef` undefined, their guard would read
         `undefined !== apiRef` as TRUE, and they would activate AGAIN with a
         fresh 30-day expiresAt — the period extended twice for one payment.

         Writing the field they guard on makes them skip. This is a bridge, not
         the destination: the webhooks should mark the intent PAID and let this
         reconciler be the only writer. That is a change to a deployed money
         path and belongs in the subscription release, not here. */
      paymentRef: id,
      expiresAt: admin.firestore.Timestamp.fromMillis(endMs),
      updatedAt: _now(),
    };

    t.set(subRef, subDoc, { merge: true });
    t.update(intentRef, {
      activationPending: false,
      reconciledAt: _now(),
      subscriptionId: subRef.id,
    });

    out = { ok: true, replayed: false, subscriptionId: subRef.id, planId: planId, uid: uid,
            billingCycle: cycle, trialDays: trialDays, onTrial: onTrial,
            trialEnd: onTrial ? trialEndMs : null,
            currentPeriodStart: startMs, currentPeriodEnd: endMs };
  });

  /* OUTSIDE the transaction: the enforced ceiling follows the new entitlement.
     A failure here leaves the subscription active and the ceiling stale — which
     is recoverable — whereas holding the transaction open across it would risk
     losing the activation itself. */
  if (out && out.ok && !out.replayed && out.uid) {
    try {
      const pl = require('./product-limit');
      if (pl._internal && pl._internal.syncLimit) await pl._internal.syncLimit(out.uid);
    } catch (e) {
      out.ceilingSyncFailed = String((e && e.message) || e).slice(0, 120);
    }
  }
  return out || { ok: false, reason: 'unknown' };
}

/* Fires the moment an intent is stamped PAID, whichever rail did it. */
exports.onPaymentIntentPaid = require('firebase-functions/v2/firestore').onDocumentWritten(
  { document: 'paymentIntents/{ref}', region: REGION, memory: '256MiB' },
  async (event) => {
    const after = event.data && event.data.after && event.data.after.data();
    if (!after || after.status !== 'paid' || after.reconciledAt) return;
    if (after.purpose && after.purpose !== 'subscription') return;
    const r = await reconcilePaidIntent(event.params.ref);
    if (!r.ok) console.error('[activation] reconcile failed', event.params.ref, r.reason);
  }
);

/* Manual retry, and the path a client polls after paying with the wallet. */
exports.reconcileSubscriptionPayment = onCall(OPTS, async ({ data, auth }) => {
  const uid = _uid(auth);
  const id = String((data || {}).paymentIntentId || '').slice(0, 128);
  if (!id) throw new HttpsError('invalid-argument', 'paymentIntentId required');
  const snap = await _db().collection('paymentIntents').doc(id).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Payment not found.');
  if (snap.data().uid !== uid) throw new HttpsError('permission-denied', 'This payment is not yours.');
  const r = await reconcilePaidIntent(id);
  if (!r.ok) throw new HttpsError('failed-precondition', r.reason);
  return r;
});

exports._internal.reconcilePaidIntent = reconcilePaidIntent;
exports._internal.PERIOD_DAYS = PERIOD_DAYS;
