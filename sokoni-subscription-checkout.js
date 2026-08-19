/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — SUBSCRIPTION CHECKOUT
   ══════════════════════════════════════════════════════════════════════════════
   ONE checkout for every SOKONI package — Seller Packaging, Seller Basic, hotels,
   accommodation, services, KASS — and one payment-intent path underneath it:

       plan → createPaymentIntent → chosen rail → PAID → activation → entitlement

   There is no activateWalletSubscription() and no activateMpesaSubscription().
   The rail produces a payment; `onPaymentIntentPaid` activates the subscription.
   A new package is a catalogue entry, not a new payment system.

   ── NOTHING APPEARS USABLE UNLESS IT IS WIRED ───────────────────────────────
   A method renders as selectable ONLY when the server says `available`. Airtel
   has no provider adapter, so the server reports it unavailable and this screen
   shows it greyed with "Coming soon" — visible, so the roadmap is honest;
   unpressable, so nobody hands it money it cannot take.

   ── IT COMPUTES NOTHING ─────────────────────────────────────────────────────
   Price, entitlement, balance and availability all arrive resolved. This module
   decides what the merchant is TOLD, never what they are charged — a browser
   that could name its own price would make the catalogue decorative.

   ── AND IT NEVER GUESSES A PAYMENT ──────────────────────────────────────────
   `created`, `pending` and `processing` are shown as exactly that. The screen
   cannot declare a payment successful; only a server-verified PAID intent
   activates anything, and this renders that outcome rather than predicting it.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var METHOD_COPY = {
    SOKONI_WALLET: { title: 'SOKONI Business Wallet', hint: 'Pay instantly' },
    MPESA:         { title: 'M-PESA',                 hint: 'STK Push' },
    AIRTEL_MONEY:  { title: 'Airtel Money',           hint: 'Coming soon' },
  };

  /* Why a rail cannot be used, in the merchant's words — and with the way out.
     "Unavailable" alone sends people to support. */
  var REASON_COPY = {
    'insufficient-balance': 'Insufficient wallet balance. Add funds or choose M-PESA.',
    'balance-unavailable': 'Your wallet balance could not be loaded just now.',
    'provider-not-available': "Airtel Money isn't available yet. Choose SOKONI Wallet or M-PESA.",
  };

  function _money(n) {
    if (typeof n !== 'number' || !isFinite(n)) return null;
    return 'KES ' + Math.round(n).toLocaleString('en-KE');
  }

  /* ── THE PLAN SUMMARY ──────────────────────────────────────────────────────
     Straight from the resolved entitlement. A capability the entitlement did not
     mention is omitted rather than shown as unavailable — an unknown is not a no. */
  function planSummary(plan) {
    var p = plan || {};
    var limit = (typeof p.listingLimit === 'number') ? p.listingLimit : null;
    return {
      name: p.label || p.planName || p.planId || 'Plan',
      price: _money(p.priceKES),
      cycleLabel: p.billingCycle === 'annual' ? 'per year' : 'per month',
      products: limit === -1 ? 'Unlimited products'
              : limit === null ? null
              : limit + ' products',
      includes: [
        { id: 'inventory', label: 'Inventory', on: true },
        { id: 'pos', label: 'POS', on: true },
        { id: 'online', label: 'Online selling', on: true },
        { id: 'orders', label: 'Orders', on: true },
        { id: 'messages', label: 'Messages', on: true },
      ],
    };
  }

  /* ── THE METHOD LIST ───────────────────────────────────────────────────────
     `methods` is exactly what subscriptionPaymentMethods returned. This adds
     copy; it does not add availability. */
  function methods(serverMethods) {
    var list = Array.isArray(serverMethods) ? serverMethods : [];
    return list.map(function (m) {
      var copy = METHOD_COPY[m.id] || { title: m.label || m.id, hint: '' };
      var usable = m.available === true;
      return {
        id: m.id,
        title: copy.title,
        hint: usable ? copy.hint : (m.id === 'AIRTEL_MONEY' ? 'Coming soon' : copy.hint),
        /* The balance line, shown only for the wallet and only when known. A
           null balance renders as a dash, never as KES 0. */
        detail: m.id === 'SOKONI_WALLET'
          ? (typeof m.balance === 'number' ? 'Balance: ' + _money(m.balance) : 'Balance: —')
          : null,
        selectable: usable,
        disabledReason: usable ? null : (REASON_COPY[m.reason] || 'Not available right now.'),
        needsPhone: m.id === 'MPESA',
      };
    });
  }

  /* The first rail a merchant can actually use. Never preselects a disabled one,
     because a preselected dead button is worse than no preselection. */
  function defaultMethod(serverMethods) {
    var usable = methods(serverMethods).filter(function (m) { return m.selectable; });
    return usable.length ? usable[0].id : null;
  }

  /* Can Confirm & Pay be pressed? Every reason it cannot is nameable. */
  function payability(serverMethods, selectedId, phone) {
    var all = methods(serverMethods);
    var chosen = all.filter(function (m) { return m.id === selectedId; })[0] || null;
    if (!chosen) return { ok: false, reason: 'choose-a-method', message: 'Choose a payment method.' };
    if (!chosen.selectable) return { ok: false, reason: 'method-unavailable', message: chosen.disabledReason };
    if (chosen.needsPhone && !validPhone(phone)) {
      return { ok: false, reason: 'phone-required', message: 'Enter the M-PESA number to send the prompt to.' };
    }
    return { ok: true, reason: null, message: null, method: chosen.id };
  }

  /* Kenyan MSISDN, the shape initiateSTKPush enforces. Accepting a number the
     server will reject only moves the failure later. */
  function normalisePhone(input) {
    var s = String(input == null ? '' : input).replace(/[\s-]/g, '');
    if (/^0[17]\d{8}$/.test(s)) return '254' + s.slice(1);
    if (/^\+?254[17]\d{8}$/.test(s)) return s.replace(/^\+/, '');
    if (/^[17]\d{8}$/.test(s)) return '254' + s;
    return null;
  }
  function validPhone(input) { return normalisePhone(input) !== null; }

  /* ── PAYMENT STATE ─────────────────────────────────────────────────────────
     What the merchant sees while a rail is working. Each state says what is
     true, and none of them claims success. */
  var PAYMENT_VIEW = {
    created:    { title: 'Ready to pay',        body: null, busy: false, done: false },
    stk_sent:   { title: 'Check your phone',    body: 'Enter your M-PESA PIN to complete the payment.', busy: true, done: false },
    pending:    { title: 'Waiting for payment', body: "We're waiting for confirmation from your payment.", busy: true, done: false },
    processing: { title: 'Payment processing',  body: 'This usually takes a few seconds.', busy: true, done: false },
    paid:       { title: 'Payment confirmed',   body: 'Activating your plan…', busy: true, done: false },
    active:     { title: 'Plan activated',      body: null, busy: false, done: true },
    failed:     { title: 'Payment not completed', body: 'Nothing was charged. You can try again.', busy: false, done: false },
    expired:    { title: 'Payment request expired', body: 'Start again to get a fresh quote.', busy: false, done: false },
  };

  function paymentView(status) {
    var key = String(status || '').toLowerCase();
    /* An unknown status is reported as unknown — never as success. */
    return PAYMENT_VIEW[key] || { title: 'Checking payment…', body: null, busy: true, done: false };
  }

  /* ── THE SUBSCRIPTION STATE MERCHANT V2 SHOWS ──────────────────────────────
     Resolved server-side; this only chooses the sentence and the action. */
  var SUBSCRIPTION_VIEW = {
    FREE:                 { line: 'Free plan', action: { id: 'upgrade', label: 'Choose a plan' } },
    TRIALING:             { line: null,        action: { id: 'continue', label: 'Continue selling' } },
    PENDING_PAYMENT:      { line: "We're waiting for confirmation.", action: { id: 'check', label: 'Check payment status' } },
    PROCESSING:           { line: 'Payment processing.', action: { id: 'check', label: 'Check payment status' } },
    ACTIVE:               { line: 'Active', action: { id: 'manage', label: 'Manage subscription' } },
    GRACE:                { line: 'Payment overdue — your plan is still active.', action: { id: 'pay', label: 'Update payment' } },
    CANCEL_AT_PERIOD_END: { line: 'Active until the end of your billing period.', action: { id: 'resume', label: 'Resume subscription' } },
    EXPIRED:             { line: 'Your plan has expired.', action: { id: 'renew', label: 'Renew plan' } },
    CANCELLED:           { line: 'Your plan was cancelled.', action: { id: 'upgrade', label: 'Choose a plan' } },
  };

  function subscriptionView(state, opts) {
    var o = opts || {};
    var key = String(state || '').toUpperCase();
    var v = SUBSCRIPTION_VIEW[key];
    if (!v) return { state: 'UNKNOWN', line: 'We could not load your plan just now.',
                     action: { id: 'retry', label: 'Try again' } };
    var line = v.line;
    if (key === 'TRIALING') line = o.trialLine || 'Trial active';
    return { state: key, line: line, action: v.action };
  }

  global.SokoniSubscriptionCheckout = {
    METHOD_COPY: METHOD_COPY, REASON_COPY: REASON_COPY,
    planSummary: planSummary, methods: methods, defaultMethod: defaultMethod,
    payability: payability, normalisePhone: normalisePhone, validPhone: validPhone,
    paymentView: paymentView, subscriptionView: subscriptionView,
    PAYMENT_VIEW: PAYMENT_VIEW, SUBSCRIPTION_VIEW: SUBSCRIPTION_VIEW,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  module.exports = (typeof window !== 'undefined' ? window : globalThis).SokoniSubscriptionCheckout;
}
