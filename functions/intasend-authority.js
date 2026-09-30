'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — THE INTASEND PAYMENT AUTHORITY
   functions/intasend-authority.js

   ONE place decides everything about an IntaSend payment: which host, which
   credential form, what a provider result must match before it counts, which method
   actually happened, and whether a state means settled, failed or nothing at all.

   WHY THIS EXISTS — measured, not assumed (traced 2026-09-10)

     10 sites construct the IntaSend host independently
      2 different environment variables decide live-vs-sandbox, and they are
        INDEPENDENT: INTASEND_LIVE at index.js:2744, INTASEND_SANDBOX at nine other
        sites. Setting one leaves the other on its own default, so verification could
        run against production while initiation ran against sandbox.
      2 credential header forms, `Bearer` and `Token`
      3 hardcoded hosts that ignore the switch entirely — sub-engine.js:744 pins
        SANDBOX (a production subscription retry would charge nothing), index.js:8692
        and wallet.js:491 pin PRODUCTION (a sandbox run would move real money)

   A payment provider reached through ten doors is ten integrations wearing one name.

   THIS MODULE IS PURE. No Firestore, no network, no admin SDK. It decides; callers
   perform. That is what makes it certifiable without an emulator and what keeps the
   frozen wallet backend untouched — this operates at the PROVIDER boundary only and
   never credits, debits or settles anything itself.
   ══════════════════════════════════════════════════════════════════════════════ */

const _method = require('./intasend-method');

/* ── 1. ENVIRONMENT — exactly one answer ─────────────────────────────────────
   Both historical variables are read so no existing deployment silently flips, but
   they must AGREE. Disagreement is a configuration fault and is refused rather than
   resolved by precedence: picking a winner is how a sandbox key ends up talking to
   production. */
const HOST_LIVE = 'payment.intasend.com';
const HOST_SANDBOX = 'sandbox.intasend.com';

function resolveMode(env) {
  const e = env || {};
  const sandboxSet = Object.prototype.hasOwnProperty.call(e, 'INTASEND_SANDBOX');
  const liveSet = Object.prototype.hasOwnProperty.call(e, 'INTASEND_LIVE');

  const sandboxSays = sandboxSet ? (String(e.INTASEND_SANDBOX) === 'true' ? 'sandbox' : 'live') : null;
  /* Legacy spelling: INTASEND_LIVE !== 'false' meant live. */
  const liveSays = liveSet ? (String(e.INTASEND_LIVE) === 'false' ? 'sandbox' : 'live') : null;

  if (sandboxSays && liveSays && sandboxSays !== liveSays) {
    return { ok: false, reason: 'ENV_CONFLICT', detail: 'INTASEND_SANDBOX and INTASEND_LIVE disagree' };
  }
  const mode = sandboxSays || liveSays || 'live';   /* unset = live, the historical default */
  return { ok: true, mode, host: mode === 'sandbox' ? HOST_SANDBOX : HOST_LIVE };
}

/** One credential header form. IntaSend authenticates API keys as a Bearer token. */
function authHeader(key) {
  const k = String(key || '').trim();
  if (!k) return { ok: false, reason: 'NO_CREDENTIAL' };
  return { ok: true, header: 'Bearer ' + k };
}

/* ── 2. MONEY — minor units, integers, per-currency exponent ─────────────────
   A bare number is not a monetary value. The exponent is per-currency and is never
   assumed to be 2: JPY is 0, KWD/BHD/TND are 3. No floating-point arithmetic occurs
   in this module. */
const EXPONENT = { KES: 2, USD: 2, EUR: 2, GBP: 2, UGX: 0, TZS: 2, RWF: 0, JPY: 0, KWD: 3, BHD: 3, TND: 3 };

function exponentFor(currency) {
  const c = String(currency || '').toUpperCase();
  return Object.prototype.hasOwnProperty.call(EXPONENT, c) ? EXPONENT[c] : null;
}

/** A money value. `minor` must be a safe integer; a float is refused, never rounded. */
function money(currency, minor) {
  const c = String(currency || '').toUpperCase();
  const exp = exponentFor(c);
  if (exp === null) return { ok: false, reason: 'UNKNOWN_CURRENCY', detail: c || '(none)' };
  if (!Number.isInteger(minor)) return { ok: false, reason: 'NOT_MINOR_UNITS', detail: String(minor) };
  return { ok: true, value: { currency: c, minor, exponent: exp } };
}

/* Provider amounts arrive as major units ("1000", "1000.50"). Parsed by STRING, so
   1000.10 cannot become 1000.0999999. */
function minorFromProviderAmount(raw, currency) {
  const exp = exponentFor(currency);
  if (exp === null) return { ok: false, reason: 'UNKNOWN_CURRENCY', detail: String(currency || '') };
  const s = String(raw === 0 ? '0' : (raw || '')).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return { ok: false, reason: 'UNPARSEABLE_AMOUNT', detail: s || '(empty)' };

  const neg = s.startsWith('-');
  const [whole, frac = ''] = s.replace('-', '').split('.');
  if (frac.length > exp) return { ok: false, reason: 'SUB_MINOR_PRECISION', detail: s };
  const padded = (frac + '0'.repeat(exp)).slice(0, exp);
  const minor = Number(whole) * Math.pow(10, exp) + Number(padded || '0');
  if (!Number.isSafeInteger(minor)) return { ok: false, reason: 'AMOUNT_OUT_OF_RANGE', detail: s };
  return { ok: true, minor: neg ? -minor : minor };
}

/** The major-unit string to send the provider, derived by integer maths only. */
function providerAmountFromMinor(m) {
  const exp = exponentFor(m && m.currency);
  if (exp === null || !m || !Number.isInteger(m.minor)) return { ok: false, reason: 'BAD_MONEY' };
  const sign = m.minor < 0 ? '-' : '';
  const abs = Math.abs(m.minor);
  const div = Math.pow(10, exp);
  const whole = Math.floor(abs / div);
  if (exp === 0) return { ok: true, text: sign + String(whole) };
  const frac = String(abs - whole * div).padStart(exp, '0');
  return { ok: true, text: sign + String(whole) + '.' + frac };
}

/* ── 3. PROVIDER STATE — unknown fails CLOSED ────────────────────────────────
   An unrecognised state is not "probably fine". Treating it as pending is also wrong
   if it is terminal, so it is reported as UNKNOWN and the caller must refuse to
   settle on it. */
const SETTLED_STATES = ['COMPLETE', 'COMPLETED', 'PAID', 'SUCCESS'];
const FAILED_STATES = ['FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED', 'REVERSED', 'REFUNDED', 'CHARGEBACK'];
const PENDING_STATES = ['PENDING', 'PROCESSING', 'IN-PROGRESS', 'IN_PROGRESS', 'RETRY'];

function classifyState(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return 'UNKNOWN';
  if (SETTLED_STATES.indexOf(s) > -1) return 'SETTLED';
  if (FAILED_STATES.indexOf(s) > -1) return 'FAILED';
  if (PENDING_STATES.indexOf(s) > -1) return 'PENDING';
  return 'UNKNOWN';
}

/* ── 4. TENDER BOUNDARY — cash and points are never provider transactions ────
   Cash is settled at a drawer and SOKONI cannot return it electronically; points are
   a merchant-funded reward, not money. Representing either as an IntaSend transaction
   would put a provider reference on money the provider never saw. */
const PROVIDER_METHODS = ['MPESA', 'CARD', 'BANK'];
const INTERNAL_TENDERS = ['CASH', 'POINTS', 'WALLET'];

/**
 * THE METHODS THIS SOKONI ACCOUNT ACTUALLY HAS ENABLED.
 *
 * PROVIDER_METHODS below is a SAFETY FLOOR, not the product contract. The contract is
 * "whatever IntaSend has enabled for this account": a method the account enables
 * tomorrow must reach the buyer without a code change, and a method it disables must
 * stop being offered without one either.
 *
 * Two things the configuration may NEVER do:
 *
 *   · enable an INTERNAL TENDER. Cash is settled at a drawer and points are a
 *     merchant-funded reward; representing either as a provider transaction would put
 *     a provider reference on money the provider never saw.
 *   · enable nothing at all. An empty set would silently close the tills, so the
 *     incumbent set is used and SAID to be the incumbent.
 */
/* NOTE: this is the PROVIDER'S enabled list, not the offerable set. A method can be
   enabled by the account and still be one SOKONI cannot reconcile — ask
   (or payment-method-capability.offerableMethods) for what a buyer may actually see. */
function enabledMethods(config) {
  const c = (config && typeof config === 'object' && !Array.isArray(config)) ? config : {};
  const raw = Array.isArray(c.enabledMethods) ? c.enabledMethods : null;

  if (!raw || !raw.length) {
    return { ok: true, methods: PROVIDER_METHODS.slice(), source: 'INCUMBENT' };
  }

  const seen = {};
  const methods = [];
  const rejected = [];
  raw.forEach((m) => {
    const k = String(m == null ? '' : m).trim().toUpperCase();
    if (!k || seen[k]) return;
    seen[k] = 1;
    /* An internal tender in the enabled list is a configuration error, not a new
       payment method. Dropped and reported rather than honoured. */
    if (INTERNAL_TENDERS.indexOf(k) > -1) { rejected.push(k); return; }
    methods.push(k);
  });

  if (!methods.length) {
    return { ok: true, methods: PROVIDER_METHODS.slice(), source: 'INCUMBENT',
             rejected, detail: 'configuration enabled no provider method' };
  }
  return { ok: true, methods, source: 'CONFIG', rejected };
}

/* OFFERABILITY LIVES IN payment-method-capability.js, not here.

   Whether a buyer may be shown a method is two questions — has the account enabled
   it, and can SOKONI reconcile it — and the second needs a table of controls that
   has no business inside a verification authority. Requiring that module here would
   also grow this file's dependency surface, which its own certification forbids for
   good reason: a decision module that reaches for things can move money. */

function assertProviderTender(method, config) {
  const m = String(method || '').trim().toUpperCase();
  if (!m) return { ok: false, reason: 'NO_METHOD' };
  if (INTERNAL_TENDERS.indexOf(m) > -1) return { ok: false, reason: 'NOT_A_PROVIDER_TENDER', detail: m };
  /* THE ENABLED SET, which defaults to the closed incumbent list. A method must be one
     this account actually has enabled — an unrecognised token is refused, because a
     method nothing can reconcile is worse than one nobody can choose. Passing config
     is what lets a method IntaSend enables be accepted without editing this file. */
  const allowed = config ? enabledMethods(config).methods : PROVIDER_METHODS;
  if (allowed.indexOf(m) === -1) return { ok: false, reason: 'UNKNOWN_METHOD', detail: m };
  return { ok: true, method: m };
}

/* ── 5. THE VERIFICATION — a provider result must MATCH the intent ───────────
   Reference, currency and amount, all three, plus a state that means settled. The
   currency check is not ceremony: the webhook books `amountPaidKES` from a payload
   whose currency it reads only for logging, so a non-KES settlement would be recorded
   as KES today.

   THE METHOD IS RESOLVED FROM THE PAYLOAD ONLY. There is deliberately no parameter
   for the requested method: a function that cannot see the request cannot fall back
   to it, and recording the requested method as the actual one is how a card payment
   becomes an M-PESA row in the ledger. */
function verifyProviderResult(input) {
  const { intent, payload } = input || {};
  if (!intent || !payload) return { ok: false, reason: 'MISSING_INPUT' };

  const state = classifyState(payload.state || payload.status || (payload.invoice && payload.invoice.state));
  if (state !== 'SETTLED') {
    return { ok: false, reason: state === 'UNKNOWN' ? 'UNKNOWN_STATE' : 'NOT_SETTLED', state };
  }

  const inv = payload.invoice || payload;

  /* reference */
  const providerRef = String(inv.api_ref || payload.api_ref || '').trim();
  const intentRef = String(intent.ref || '').trim();
  if (!providerRef || !intentRef) return { ok: false, reason: 'NO_REFERENCE' };
  if (providerRef !== intentRef) {
    return { ok: false, reason: 'REFERENCE_MISMATCH', detail: providerRef + ' != ' + intentRef };
  }

  /* currency — never assumed */
  const providerCur = String(inv.currency || payload.currency || '').toUpperCase();
  const intentCur = String((intent.money && intent.money.currency) || '').toUpperCase();
  if (!providerCur) return { ok: false, reason: 'NO_CURRENCY' };
  if (!intentCur) return { ok: false, reason: 'INTENT_HAS_NO_CURRENCY' };
  if (providerCur !== intentCur) {
    return { ok: false, reason: 'CURRENCY_MISMATCH', detail: providerCur + ' != ' + intentCur };
  }

  /* amount — compared in MINOR UNITS, exactly.

     `net_amount` is the gross minus the provider's own charge and is NOT what the
     customer agreed to pay, so the comparison is against `amount`. Reading net here
     would make every payment look short by the provider fee. */
  const parsed = minorFromProviderAmount(
    inv.amount !== undefined ? inv.amount : payload.amount, providerCur);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, detail: parsed.detail };
  const expected = intent.money && intent.money.minor;
  if (!Number.isInteger(expected)) return { ok: false, reason: 'INTENT_AMOUNT_NOT_MINOR_UNITS' };
  if (parsed.minor !== expected) {
    return { ok: false, reason: 'AMOUNT_MISMATCH', detail: parsed.minor + ' != ' + expected };
  }

  /* method — from the payload, or UNKNOWN. Never the requested method. */
  const norm = _method.normalizeIntasendPaymentMethod(payload);
  const actualMethod = norm && norm.ok ? norm.method : 'UNKNOWN';

  /* The provider fee, when the payload states it, is recorded SEPARATELY — it is not
     SOKONI's fee and the two must never be summed into one figure. */
  let providerFeeMinor = null;
  const feeRaw = inv.charges !== undefined ? inv.charges : (payload.charges !== undefined ? payload.charges : null);
  if (feeRaw !== null && feeRaw !== undefined && feeRaw !== '') {
    const f = minorFromProviderAmount(feeRaw, providerCur);
    if (f.ok) providerFeeMinor = f.minor;
  }

  return {
    ok: true,
    state,
    ref: providerRef,
    money: { currency: providerCur, minor: parsed.minor, exponent: exponentFor(providerCur) },
    actualMethod,
    providerFeeMinor,
    providerTrackingId: String(inv.invoice_id || inv.id || payload.tracking_id || '') || null,
  };
}

/* ── 5b. REFUNDS ────────────────────────────────────────────────────────────
   Money going back the way it came. The SAME provider, the same minor-unit discipline and
   the same refusal to believe a payload that merely arrived.

   A REFUND IS TIED TO THE ORIGINAL PAYMENT, not merely to an amount. IntaSend is told
   which invoice to reverse, so a refund cannot be issued against a payment that never
   happened and cannot be redirected to a destination the original payer did not use. That
   is also why no destination is accepted here: the money returns along the rail it came
   in on, and a caller who could name one could route a refund to themselves. */

/**
 * Build the refund request. PURE — it returns what to send, and sends nothing.
 *
 * The amount is passed in MINOR UNITS and converted once, here, by the same function the
 * payment path uses. A caller handing shillings to a provider that expects a decimal
 * string is how a refund becomes a hundred times too large.
 */
function buildRefundRequest(input) {
  const { intentRef, originalTrackingId, currency, amountMinor, reason } = input || {};

  const ref = String(intentRef || '').trim();
  if (!ref) return { ok: false, reason: 'NO_REFERENCE' };

  /* THE ORIGINAL PAYMENT IS REQUIRED. Without it this is not a refund, it is a payout to
     whoever asked — and the two must never share a code path. */
  const invoice = String(originalTrackingId || '').trim();
  if (!invoice) return { ok: false, reason: 'NO_ORIGINAL_PAYMENT' };

  const cur = String(currency || '').toUpperCase();
  if (!cur) return { ok: false, reason: 'NO_CURRENCY' };
  if (!Number.isInteger(amountMinor)) return { ok: false, reason: 'AMOUNT_NOT_MINOR_UNITS' };
  if (amountMinor <= 0) return { ok: false, reason: 'NON_POSITIVE_AMOUNT' };

  const amt = providerAmountFromMinor({ currency: cur, minor: amountMinor });
  if (!amt.ok) return amt;

  return {
    ok: true,
    path: '/api/v1/chargebacks/create/',
    body: {
      invoice_id: invoice,
      /* .text, not .amount — providerAmountFromMinor returns the DECIMAL STRING the
         provider expects. Reading the wrong field sent a refund request with no amount at
         all, which certification caught before it could reach IntaSend. */
      amount: amt.text,
      currency: cur,
      /* Carried so the provider's own record names the cause; a refund with no stated
         reason is one nobody can reconcile against a return months later. */
      reason: String(reason || 'Customer return').slice(0, 200),
      api_ref: ref,
    },
    money: { currency: cur, minor: amountMinor },
  };
}

/**
 * Did the provider actually reverse it?
 *
 * The same discipline as verifyProviderResult, and for the same reason: a response that
 * arrived is not a response that agreed. Reference, currency and EXACT minor amount must
 * all match the request, and an unrecognised state fails closed as UNKNOWN rather than
 * being read optimistically.
 */
function verifyRefundResult(input) {
  const { intent, payload } = input || {};
  if (!intent || !payload) return { ok: false, reason: 'MISSING_INPUT' };

  const state = classifyState(payload.state || payload.status ||
    (payload.chargeback && payload.chargeback.state));
  if (state !== 'SETTLED') {
    return { ok: false, reason: state === 'UNKNOWN' ? 'UNKNOWN_STATE' : 'NOT_SETTLED', state };
  }

  const cb = payload.chargeback || payload;

  const providerRef = String(cb.api_ref || payload.api_ref || '').trim();
  const intentRef = String(intent.ref || '').trim();
  if (!providerRef || !intentRef) return { ok: false, reason: 'NO_REFERENCE' };
  if (providerRef !== intentRef) {
    return { ok: false, reason: 'REFERENCE_MISMATCH', detail: providerRef + ' != ' + intentRef };
  }

  const providerCur = String(cb.currency || payload.currency || '').toUpperCase();
  const intentCur = String((intent.money && intent.money.currency) || '').toUpperCase();
  if (!providerCur) return { ok: false, reason: 'NO_CURRENCY' };
  if (!intentCur) return { ok: false, reason: 'INTENT_HAS_NO_CURRENCY' };
  if (providerCur !== intentCur) {
    return { ok: false, reason: 'CURRENCY_MISMATCH', detail: providerCur + ' != ' + intentCur };
  }

  const parsed = minorFromProviderAmount(
    cb.amount !== undefined ? cb.amount : payload.amount, providerCur);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, detail: parsed.detail };
  const expected = intent.money && intent.money.minor;
  if (!Number.isInteger(expected)) return { ok: false, reason: 'INTENT_AMOUNT_NOT_MINOR_UNITS' };
  if (parsed.minor !== expected) {
    /* A PARTIAL REVERSAL IS NOT THIS REFUND. It is refused rather than accepted as
       'close enough', because recording a smaller reversal as complete leaves a buyer
       short with a record that says they were paid. */
    return { ok: false, reason: 'AMOUNT_MISMATCH', detail: parsed.minor + ' != ' + expected };
  }

  return {
    ok: true,
    state,
    ref: providerRef,
    money: { currency: providerCur, minor: parsed.minor, exponent: exponentFor(providerCur) },
    providerTrackingId: String(cb.chargeback_id || cb.id || payload.tracking_id || '') || null,
  };
}

/* ── 6. IDEMPOTENCY ─────────────────────────────────────────────────────────
   The settlement record id is DERIVED from the reference, so an at-least-once
   webhook redelivery overwrites one record instead of creating a second movement.
   A caller-absent key is refused, never generated here: a generated key makes every
   retry a new movement, which is the defect wearing a safety feature's clothes. */
function settlementId(intentRef, providerTrackingId) {
  const a = String(intentRef || '').trim();
  if (!a) return { ok: false, reason: 'NO_IDEMPOTENCY_BASIS' };
  const b = String(providerTrackingId || '').trim();
  return { ok: true, id: b ? a + '__' + b : a };
}

module.exports = {
  enabledMethods,
  buildRefundRequest, verifyRefundResult,
  resolveMode, authHeader, HOST_LIVE, HOST_SANDBOX,
  money, exponentFor, minorFromProviderAmount, providerAmountFromMinor, EXPONENT,
  classifyState, SETTLED_STATES, FAILED_STATES, PENDING_STATES,
  assertProviderTender, PROVIDER_METHODS, INTERNAL_TENDERS,
  verifyProviderResult, settlementId,
};
