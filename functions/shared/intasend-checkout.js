'use strict';
/**
 * THE INTASEND CHECKOUT CALL — one implementation, every rail.
 *
 * `shared/stk-gateway.js` owns the M-PESA-only STK request. This owns the
 * HOSTED CHECKOUT request, which is the only way SOKONI can offer card,
 * Google Pay, Apple Pay, PesaLink or anything else the account has enabled —
 * and the only way a customer can enter card details somewhere a SOKONI
 * cashier cannot see them.
 *
 * ── WHY THIS FILE EXISTS, GIVEN THE SDK IS VENDORED ─────────────────────────
 *
 * `intasend-node` DOES target /api/v1/checkout/ (dist/collection.js:22), and
 * `payment-orchestrator.js:262` calls it. That call cannot work:
 *
 *     new IntaSend('', INTASEND_SK.value(), …)   // publishable='', secret=PRIV
 *     sdk.collection().charge({…})               // charge() sets secret_key=''
 *
 * `charge()` blanks the secret key (collection.js:23) because checkout is the
 * PUBLIC-key flow, and the orchestrator passes '' as the publishable key. So
 * the request goes out with no Authorization header, no INTASEND_PUBLIC_API_KEY
 * header and no public_key in the body. Unauthenticated, every time. That is
 * consistent with the orchestrator being an orphan nothing calls.
 *
 * `charge()` also MUTATES `this.secret_key` on the instance, so a client reused
 * for a later authenticated call is silently de-authenticated. A shared money
 * path must not carry that.
 *
 * ── THE AUTH CONTRACT, AND ITS STATUS ───────────────────────────────────────
 *
 * Checkout is the PUBLIC-key flow: `INTASEND_PUBLIC_API_KEY` header plus
 * `public_key` in the body, and NO Authorization header. That is what the
 * vendored client does, and it is the only in-repo evidence of this endpoint's
 * contract.
 *
 * THIS IS NOT FIELD-VERIFIED. No SOKONI code has ever successfully created a
 * checkout session. Until scripts/probe-intasend-capability.js has run against
 * the production account, treat the contract as asserted, not proven. The
 * module therefore never decides that a non-answer is a failure, and the
 * private key is accepted ONLY so it can be explicitly withheld — see below.
 *
 * ── WHAT THIS MODULE DOES NOT DO, deliberately ──────────────────────────────
 *
 *   - it takes NO reservation and writes NO document. Single-flight is the
 *     CALLER's job, exactly as in stk-gateway.js, so the barrier stays visible
 *     to the suite that has to prove it.
 *   - it NEVER decides that a non-answer is a failure. A timeout or a socket
 *     error THROWS. "No response" is not "no checkout", and a customer may
 *     already be looking at a payment page.
 *   - it NEVER names a payment method unless the caller insists. Omitting
 *     `method` is what makes IntaSend present everything the ACCOUNT has
 *     enabled. Hard-coding a list here would put SOKONI in the business of
 *     asserting capability it cannot see.
 *   - it never logs, returns or embeds either key.
 */

/* The candidate method identifiers IntaSend uses. This list exists ONLY so the
   capability probe has something to enumerate and so a caller-supplied method
   can be rejected before it reaches the wire. It is NOT a claim that any of
   these are enabled on the SOKONI account — that is precisely what cannot be
   known without probing, and why the normal path omits `method` entirely. */
/* 2026-09-26: the identifiers are IntaSend's documented `method` enum (Create
   Checkout reference: M-PESA, PESALINK, CARD-PAYMENT, GOOGLE-PAY, APPLE-PAY,
   BITCOIN, BANK-ACH, COOP_B2B). The previous list spelled GOOGLE_PAY / APPLE_PAY
   with underscores and omitted PESALINK, so a probe of those would have come
   back 400 and been misread as REFUSED. One list, owned by payment-capability. */
const CANDIDATE_METHODS = require('./payment-capability').METHODS;

/* Who absorbs the provider's fee. IntaSend spells these `card_tarrif` and
   `mobile_tarrif` (its spelling, not ours) and they are a MERCHANT setting:
   a cashier must never be able to move the fee onto a customer mid-sale. The
   caller reads this from merchant config; this module only passes it through. */
const TARIFF = Object.freeze({
  BUSINESS_PAYS: 'BUSINESS-PAYS',
  CUSTOMER_PAYS: 'CUSTOMER-PAYS',
});

function hostFor(sandbox) {
  return sandbox ? 'sandbox.intasend.com' : 'payment.intasend.com';
}

/**
 * Build the checkout payload.
 *
 * `method` is OMITTED unless the caller names one. That omission is the whole
 * multi-method feature: IntaSend then presents every method the account has
 * enabled, and SOKONI never has to maintain a parallel list that drifts out of
 * date the moment the account changes.
 *
 * `amountKES` is whole shillings, matching what the provider is asked for
 * everywhere else on this rail. Callers hold cents and convert once, at their
 * own boundary, exactly as payment-purposes -> priceFor already does.
 */
function buildPayload({
  amountKES, apiRef, publicKey,
  currency = 'KES',
  narrative,
  firstName, lastName, email, phone,
  redirectUrl,
  method,
  cardTariff, mobileTariff,
  walletId,
}) {
  if (!publicKey) throw new Error('intasend-checkout: publicKey is required');
  if (!apiRef)    throw new Error('intasend-checkout: apiRef is required');

  const amt = Number(amountKES);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw new Error('intasend-checkout: amountKES must be a positive number');
  }
  if (method && !CANDIDATE_METHODS.includes(method)) {
    /* Refuse an unrecognised method rather than forwarding it. A typo that
       reaches IntaSend comes back as a 400 with a field-keyed body and no
       `detail` — the same unhelpful shape a failed production STK once
       produced (see stk-gateway.js:29). */
    throw new Error(`intasend-checkout: unknown method "${method}"`);
  }

  const payload = {
    public_key: publicKey,
    amount:     amt,
    currency,
    api_ref:    apiRef,
  };

  /* Only send what we actually have. IntaSend rejects some fields when null,
     and an empty string is not the same as an absent field. */
  if (narrative)    payload.narrative    = narrative;
  if (firstName)    payload.first_name   = firstName;
  if (lastName)     payload.last_name    = lastName;
  if (email)        payload.email        = email;
  if (phone)        payload.phone_number = phone;
  if (redirectUrl)  payload.redirect_url = redirectUrl;
  if (walletId)     payload.wallet_id    = walletId;
  if (method)       payload.method       = method;
  if (cardTariff)   payload.card_tarrif   = cardTariff;   /* IntaSend's spelling */
  if (mobileTariff) payload.mobile_tarrif = mobileTariff; /* IntaSend's spelling */

  return JSON.stringify(payload);
}

/**
 * POST the checkout request.
 *
 * `privateKey` is accepted and DELIBERATELY NOT SENT. Taking it as a named
 * parameter and dropping it is louder than not taking it at all: a future
 * caller that passes it discovers here, in one commented place, that checkout
 * is the public-key flow — rather than adding an Authorization header of their
 * own and quietly creating a second contract.
 *
 * @returns {Promise<{status:number,data:object}>}  REJECTS on a non-answer.
 */
function createCheckout({ payload, publicKey, sandbox, https, privateKey: _unusedPrivateKey }) {
  if (!publicKey) return Promise.reject(new Error('intasend-checkout: publicKey is required'));

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: hostFor(sandbox),
      path:     '/api/v1/checkout/',
      method:   'POST',
      headers:  {
        'Content-Type':            'application/json',
        /* Two spellings, neither field-verified: the vendored SDK
           (intasend-node 1.1.2, dist/requests.js:24) sends INTASEND_PUBLIC_API_KEY;
           IntaSend's current Create Checkout reference documents
           X-IntaSend-Public-API-Key. Both carry the PUBLIC key only, and the
           body carries public_key too — so whichever the gateway reads, the
           same public credential is presented and no secret is. */
        'INTASEND_PUBLIC_API_KEY':   publicKey,
        'X-IntaSend-Public-API-Key': publicKey,
        'Content-Length':          Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        /* A non-JSON body is a non-answer, not a refusal — the same rule
           stk-gateway applies. It may still have created an invoice. */
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (_) { reject(new Error('Invalid IntaSend checkout response')); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * What the gateway's answer means.
 *
 * A 2xx/4xx is the gateway ANSWERING. A 5xx is not an answer: the session may
 * exist and the customer may already be on it. Never collapse the third case
 * into the second. Identical semantics to stk-gateway.classifyOutcome, and
 * deliberately so — two rails that disagree about what "accepted" means is the
 * defect that module was extracted to prevent.
 */
function classifyOutcome(status) {
  if (status === 200 || status === 201) return 'GATEWAY_ACCEPTED';
  if (status >= 400 && status < 500)    return 'GATEWAY_REJECTED';
  return 'OUTCOME_UNKNOWN';
}

/** The hosted payment URL, under any of the spellings IntaSend has used. */
function checkoutUrlOf(data) {
  return (data && (data.url || data.checkout_url || data.invoice?.url)) || null;
}

/** The invoice id the webhook will later quote back. */
function invoiceIdOf(data) {
  return (data && (data.invoice?.invoice_id || data.invoice?.id || data.id || data.invoice_id)) || null;
}

/**
 * Methods the response says the hosted page will offer.
 *
 * Returns null when the response does not say — which is NOT the same as "no
 * methods are available", and callers must not render it as an empty list. An
 * unknown capability is unknown; showing the customer nothing, or showing them
 * a hard-coded list, are both worse than saying so.
 */
function methodsOf(data) {
  if (!data) return null;
  const raw = data.available_methods || data.methods || data.invoice?.available_methods;
  if (!Array.isArray(raw)) return null;
  const list = raw.map((m) => String(typeof m === 'string' ? m : (m && m.name) || '')).filter(Boolean);
  return list.length ? list : null;
}

module.exports = {
  CANDIDATE_METHODS,
  TARIFF,
  hostFor,
  buildPayload,
  createCheckout,
  classifyOutcome,
  checkoutUrlOf,
  invoiceIdOf,
  methodsOf,
};
