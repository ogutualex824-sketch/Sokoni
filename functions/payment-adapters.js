/* ================================================================
   SOKONI Payment Adapter Layer v1.0
   Provider-agnostic abstraction so any payment provider
   can be added or swapped without touching business logic.

   Usage:
     const { getAdapter } = require('./payment-adapters');
     const mpesa = getAdapter('intasend', { key: INTASEND_PRIVATE_KEY.value(), sandbox: false });
     const result = await mpesa.stkPush({ phone, amountKES, ref, narrative });
================================================================ */
'use strict';

const https  = require('https');
const crypto = require('crypto');

/* ═══════════════════════════════════════════════════════════════
   Base Adapter — all adapters extend this
═══════════════════════════════════════════════════════════════ */
class PaymentAdapter {
  /* Initiate customer payment (e.g. STK push, card form, QR) */
  async initiatePayment({ phone, amountKES, ref, narrative, currency = 'KES', metadata = {} }) {
    throw new Error(`${this.constructor.name}.initiatePayment() not implemented`);
  }

  /* Verify a payment by its api_ref / reference */
  async verifyPayment(ref) {
    throw new Error(`${this.constructor.name}.verifyPayment() not implemented`);
  }

  /* Initiate B2C payout to user (M-Pesa, bank, etc.) */
  async initiatePayout({ phone, amountKES, ref, reason }) {
    throw new Error(`${this.constructor.name}.initiatePayout() not implemented`);
  }

  /* Refund a previous payment */
  async initiateRefund({ originalRef, amountKES, reason }) {
    throw new Error(`${this.constructor.name}.initiateRefund() not implemented`);
  }

  /* Validate incoming webhook signature */
  verifyWebhookSignature(rawBody, signature, secret) {
    throw new Error(`${this.constructor.name}.verifyWebhookSignature() not implemented`);
  }

  /* Probe the provider API (returns { healthy: bool, latencyMs: number }) */
  async healthCheck() {
    return { healthy: true, latencyMs: 0, provider: this.constructor.name };
  }

  /* Settlement capabilities — providers override to declare NATIVE split support.
     Base default: no split (caller falls back to collect-then-payout). */
  capabilities() {
    return { supportsSplit: false, supportsPayout: true, supportsRefund: true };
  }

  /* Initiate a NATIVE split payment: the gateway distributes the single customer
     charge directly to multiple destinations per the computed split (platform
     commission → Bravilex, seller net → seller payout account). Only providers
     that support it override this; the base throws so the caller cleanly falls
     back to the collect-then-payout workflow.
       splits: [{ role:'platform'|'seller', account:{type,value}, amountKES }] */
  async initiateSplitPayment({ phone, amountKES, ref, narrative, splits, currency = 'KES', metadata = {} }) {
    throw new Error(`${this.constructor.name} does not support native split settlement`);
  }

  /* Normalise a phone number to international format (254XXXXXXXXX) */
  _normalizeKenyanPhone(phone) {
    const d = String(phone).replace(/\D/g, '');
    if (d.startsWith('254') && d.length === 12) return d;
    if (d.startsWith('0')   && d.length === 10) return '254' + d.slice(1);
    if (d.length === 9)                          return '254' + d;
    return d;
  }
}

/* ═══════════════════════════════════════════════════════════════
   IntaSend Adapter
   Handles M-Pesa (STK push), card payments, and B2C payouts
═══════════════════════════════════════════════════════════════ */
class IntaSendAdapter extends PaymentAdapter {
  constructor(privateKey, { sandbox = false } = {}) {
    super();
    if (!privateKey) throw new Error('IntaSendAdapter: privateKey is required');
    this._key  = privateKey;
    this._host = sandbox ? 'sandbox.intasend.com' : 'payment.intasend.com';
  }

  async _request(path, method = 'POST', body = null, authScheme = 'Bearer') {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : '';
      const opts = {
        hostname: this._host,
        path,
        method,
        headers: {
          'Content-Type':   'application/json',
          /* IntaSend authenticates the SECRET key as "Bearer <key>" on BOTH the
             collection/STK endpoints AND send-money (B2C) — empirically proven by the
             live wallet top-up (Bearer via intasend-node) and the live B2C payout.
             The default is Bearer; callers no longer need to pass a scheme. A "Token"
             scheme was assumed for collections but never worked on this account. */
          'Authorization':  `${authScheme} ${this._key}`,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      };
      const req = https.request(opts, (res) => {
        let raw = '';
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch (_) { resolve({ status: res.statusCode, body: raw }); }
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /* M-Pesa STK push (customer collection). Same wire contract proven by the live wallet
     top-up via intasend-node: POST /api/v1/payment/mpesa-stk-push/, Bearer auth, numeric
     amount. The response carries invoice.invoice_id, which the webhook/confirm/sweep paths
     key off — surfaced as invoiceId (checkoutId kept as an alias for existing callers). */
  async initiatePayment({ phone, amountKES, ref, narrative, currency = 'KES' }) {
    const res = await this._request('/api/v1/payment/mpesa-stk-push/', 'POST', {
      phone_number: this._normalizeKenyanPhone(phone),
      amount:       Math.round(Number(amountKES)),
      currency,
      narrative:    narrative || `SOKONI ${ref}`,
      api_ref:      ref,
    });
    const ok = res.status === 200 || res.status === 201;
    const invoiceId = res.body?.invoice?.invoice_id || res.body?.checkout_id || res.body?.id || null;
    return {
      success:     ok,
      invoiceId,
      checkoutId:  invoiceId,   /* alias — some callers read checkoutId */
      providerRef: ref,
      rawResponse: res.body,
      error:       ok ? null : (res.body?.detail || res.body?.errors?.[0]?.detail || 'IntaSend STK error'),
    };
  }

  async verifyPayment(ref) {
    const res = await this._request(`/api/v1/payment/collection/?api_ref=${encodeURIComponent(ref)}`, 'GET');
    const tx  = res.body?.results?.[0];
    return {
      found:       !!tx,
      status:      tx?.state || 'UNKNOWN',
      amountKES:   parseFloat(tx?.value || '0'),
      phone:       tx?.phone_number || null,
      checkoutId:  tx?.id || null,
      rawResponse: res.body,
    };
  }

  /* Send-Money (M-Pesa B2C) — the VERIFIED contract (probed against the live API +
     the official intasend-node SDK): POST /api/v1/send-money/initiate/, Bearer auth,
     provider MPESA-B2C, transactions[]. The previous /send-money/mpesa/ + Token + flat
     body returned HTML 404 and NEVER worked. Throws a gateway-tagged Error on failure
     (so the caller's retry/refund path handles it); returns the raw response on success. */
  async sendMoneyB2C({ phone, amountKES, ref, narrative }) {
    const account = this._normalizeKenyanPhone(phone);
    const amt = Math.round(Number(amountKES));
    console.log('[IntaSendAdapter.sendMoneyB2C] contract', JSON.stringify({
      endpoint: `https://${this._host}/api/v1/send-money/initiate/`, auth: 'Bearer',
      provider: 'MPESA-B2C', currency: 'KES', amount: amt,
      account: account.length < 6 ? account : account.slice(0, 6) + '****' + account.slice(-2),
    }));
    const res = await this._request('/api/v1/send-money/initiate/', 'POST', {
      provider: 'MPESA-B2C', currency: 'KES', requires_approval: 'NO',
      transactions: [{ name: narrative || 'SOKONI Payout', account, amount: amt, narrative: narrative || 'SOKONI earnings payout' }],
    }, 'Bearer');
    const ok = res.status === 200 || res.status === 201;
    const b = res.body;
    console.log('[IntaSendAdapter.sendMoneyB2C] response', JSON.stringify({ http: res.status, ok, body: (typeof b === 'string' ? b.slice(0, 200) : b) }));
    if (!ok) {
      const code = (b && (b.errors?.[0]?.code || b.code)) || `HTTP_${res.status}`;
      const msg  = (b && (b.errors?.[0]?.detail || b.detail || b.message)) || (typeof b === 'string' ? b.slice(0, 160) : JSON.stringify(b).slice(0, 160));
      const e = new Error(`IntaSend B2C failed (${res.status}): [${code}] ${msg}`);
      e.gateway = { name: 'IntaSend', http: res.status, code, message: msg };
      throw e;
    }
    return b || {};
  }

  /* Interface-shape wrapper (never throws) over sendMoneyB2C. */
  async initiatePayout({ phone, amountKES, ref, reason }) {
    try {
      const b = await this.sendMoneyB2C({ phone, amountKES, ref, narrative: reason });
      return { success: true, payoutId: b?.tracking_id || b?.file_id || b?.invoice_id || null, rawResponse: b, error: null };
    } catch (e) {
      return { success: false, payoutId: null, rawResponse: e.gateway || null, error: e.message };
    }
  }

  async initiateRefund({ originalRef, amountKES, reason }) {
    /* IntaSend refund via chargeback endpoint */
    const res = await this._request('/api/v1/payment/chargeback/', 'POST', {
      api_ref:  originalRef,
      amount:   String(Math.round(amountKES)),
      reason:   reason || 'Customer refund',
    });
    const ok = res.status === 200 || res.status === 201;
    return {
      success:     ok,
      refundId:    res.body?.id || null,
      rawResponse: res.body,
      error:       ok ? null : (res.body?.detail || 'IntaSend refund error'),
    };
  }

  verifyWebhookSignature(rawBody, signature, secret) {
    if (!signature || !secret) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    try { return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)); }
    catch (_) { return false; }
  }

  /* IntaSend supports native split settlement via its split-payment / wallets
     feature — a single collection is distributed to multiple destination wallets
     or M-Pesa accounts. Declared capable; activation is still gated per-gateway
     by settlement-providers config (splitEnabled, default OFF). */
  capabilities() {
    return { supportsSplit: true, supportsPayout: true, supportsRefund: true, splitApi: 'intasend-split' };
  }

  /* Initiate a split collection. splits: [{ role, account:{type,value}, amountKES }].
     NOTE: the exact IntaSend split endpoint/payload MUST be confirmed against the
     live IntaSend split-payment/wallets API and validated in sandbox before
     splitEnabled is turned on for this provider. Until then this path is never
     reached (config default splitEnabled=false → collect-then-payout fallback). */
  async initiateSplitPayment({ phone, amountKES, ref, narrative, splits, currency = 'KES' }) {
    if (!Array.isArray(splits) || splits.length < 2)
      throw new Error('initiateSplitPayment: at least two splits (platform + seller) required');
    const total = splits.reduce((s, x) => s + Number(x.amountKES || 0), 0);
    if (Math.round(total) !== Math.round(amountKES))
      throw new Error(`split total ${total} != charge amount ${amountKES}`);

    const body = {
      currency,
      amount:       String(Math.round(amountKES)),
      api_ref:      ref,
      phone_number: this._normalizeKenyanPhone(phone),
      narrative:    narrative || 'SOKONI',
      /* Destination distribution — mapped to IntaSend split/wallet fields at
         integration time (pending API confirmation, see note above). */
      splits: splits.map((s) => ({
        role:    s.role,
        account: s.account,
        amount:  String(Math.round(s.amountKES)),
      })),
    };
    const res = await this._request('/api/v1/payment/split-collection/', 'POST', body);
    const ok  = res.status === 200 || res.status === 201;
    return {
      success:      ok,
      splitId:      res.body?.id || res.body?.invoice?.invoice_id || null,
      distribution: splits.map((s) => ({ role: s.role, amountKES: s.amountKES })),
      rawResponse:  res.body,
      error:        ok ? null : (res.body?.detail || 'IntaSend split-collection error'),
    };
  }

  async healthCheck() {
    const t0  = Date.now();
    try {
      const res = await this._request('/api/v1/payment/collection/?page_size=1', 'GET');
      return { healthy: res.status < 500, latencyMs: Date.now() - t0, provider: 'intasend' };
    } catch (_) {
      return { healthy: false, latencyMs: Date.now() - t0, provider: 'intasend' };
    }
  }
}

/* ═══════════════════════════════════════════════════════════════
   Adapter Registry
═══════════════════════════════════════════════════════════════ */
const _registry = new Map();

function registerAdapter(name, AdapterClass) {
  _registry.set(name.toLowerCase(), AdapterClass);
}

/**
 * Get an initialised adapter instance.
 * @param {string} name    - Adapter name (e.g. 'intasend', 'stripe')
 * @param {object} config  - { key, sandbox?, ... }
 */
function getAdapter(name, config = {}) {
  const AdapterClass = _registry.get((name || '').toLowerCase());
  if (!AdapterClass) throw new Error(`Unknown payment provider: "${name}". Register it with registerAdapter().`);
  return new AdapterClass(config.key, config);
}

function listAdapters() {
  return [..._registry.keys()];
}

/* Register built-in adapters */
registerAdapter('intasend', IntaSendAdapter);

/* ── Future registrations (uncomment when keys are added) ──
   registerAdapter('stripe', StripeAdapter);
   registerAdapter('pesalink', PesaLinkAdapter);
   registerAdapter('equity', EquityAdapter);
*/

module.exports = { PaymentAdapter, IntaSendAdapter, registerAdapter, getAdapter, listAdapters };
