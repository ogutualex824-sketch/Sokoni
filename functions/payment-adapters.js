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

  async _request(path, method = 'POST', body = null) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : '';
      const opts = {
        hostname: this._host,
        path,
        method,
        headers: {
          'Content-Type':   'application/json',
          'Authorization':  `Token ${this._key}`,
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

  async initiatePayment({ phone, amountKES, ref, narrative, currency = 'KES' }) {
    const res = await this._request('/api/v1/payment/mpesa-stk-push/', 'POST', {
      phone_number: this._normalizeKenyanPhone(phone),
      amount:       String(Math.round(amountKES)),
      currency,
      narrative:    narrative || `SOKONI ${ref}`,
      api_ref:      ref,
    });
    const ok = res.status === 200 || res.status === 201;
    return {
      success:     ok,
      checkoutId:  res.body?.checkout_id || res.body?.id || null,
      providerRef: ref,
      rawResponse: res.body,
      error:       ok ? null : (res.body?.detail || 'IntaSend error'),
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

  async initiatePayout({ phone, amountKES, ref, reason }) {
    const res = await this._request('/api/v1/send-money/mpesa/', 'POST', {
      phone_number: this._normalizeKenyanPhone(phone),
      amount:       String(Math.round(amountKES)),
      currency:     'KES',
      narrative:    reason || `SOKONI Payout ${ref}`,
      api_ref:      ref,
    });
    const ok = res.status === 200 || res.status === 201;
    return {
      success:     ok,
      payoutId:    res.body?.id || null,
      rawResponse: res.body,
      error:       ok ? null : (res.body?.detail || 'IntaSend payout error'),
    };
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
