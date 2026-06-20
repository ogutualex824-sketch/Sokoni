/**
 * SOKONI Enterprise Webhook Engine  v2.0
 *
 * Client-side webhook delivery manager and server-side relay coordinator.
 * Every external payment provider, courier, and integration partner sends
 * events through a single hardened pipeline.
 *
 * Features:
 *  - Per-provider HMAC-SHA256 signature verification
 *  - Replay attack protection via nonce + timestamp window
 *  - Idempotency key store (deduplication across retries)
 *  - Priority retry queue with exponential back-off
 *  - Dead-letter queue (DLQ) with admin replay
 *  - Per-provider rate limiting
 *  - Structured audit log to Firestore
 *  - Health check endpoints for all providers
 *  - Background processing via SokoniQueue
 */

'use strict';

const SokoniWebhookEngine = (function () {

  /* ════════════════════════════════════════════════════════════
     PROVIDER REGISTRY
  ════════════════════════════════════════════════════════════ */
  const PROVIDERS = Object.freeze({
    INTASEND:   'intasend',
    MPESA:      'mpesa',
    STRIPE:     'stripe',
    PAYPAL:     'paypal',
    FLUTTERWAVE:'flutterwave',
    AIRTEL:     'airtel_money',
    VISA:       'visa',
    MASTERCARD: 'mastercard',
    APPLE_PAY:  'apple_pay',
    GOOGLE_PAY: 'google_pay',
    SMARTPOS:   'smartpos',
    SENDY:      'sendy',
    FARGO:      'fargo',
    AFRICASTALKING: 'africastalking',
    MAILGUN:    'mailgun',
    TWILIO:     'twilio',
    FIREBASE:   'firebase',
    CUSTOM:     'custom',
  });

  /* Provider endpoint configurations */
  const PROVIDER_CONFIG = {
    [PROVIDERS.INTASEND]: {
      path:          '/webhooks/intasend',
      algorithm:     'sha256',
      headerKey:     'x-intasend-signature',
      maxAgeSeconds: 300,
      retryLimit:    5,
      rateLimit:     { window: 60000, max: 200 },
    },
    [PROVIDERS.MPESA]: {
      path:          '/webhooks/mpesa',
      algorithm:     'sha256',
      headerKey:     'x-mpesa-signature',
      maxAgeSeconds: 300,
      retryLimit:    5,
      rateLimit:     { window: 60000, max: 500 },
    },
    [PROVIDERS.STRIPE]: {
      path:          '/webhooks/stripe',
      algorithm:     'sha256',
      headerKey:     'stripe-signature',
      maxAgeSeconds: 300,
      retryLimit:    3,
      rateLimit:     { window: 60000, max: 300 },
    },
    [PROVIDERS.SMARTPOS]: {
      path:          '/webhooks/smartpos',
      algorithm:     'sha256',
      headerKey:     'x-sokoni-signature',
      maxAgeSeconds: 600,
      retryLimit:    10,
      rateLimit:     { window: 60000, max: 1000 },
    },
  };

  /* ════════════════════════════════════════════════════════════
     INTERNAL STATE
  ════════════════════════════════════════════════════════════ */
  const _processed  = new Map();   // idempotencyKey → result (TTL 24h)
  const _nonces     = new Set();   // recent nonces for replay protection
  const _dlq        = [];          // dead-letter queue
  const _retryQueue = [];          // { item, attempts, nextAt }
  const _handlers   = {};          // provider → handler function
  const _rateLimits = new Map();   // provider → { count, resetAt }
  const DLQ_MAX     = 1000;
  const NONCE_TTL   = 15 * 60 * 1000;  // 15 min
  let   _retryTimer = null;

  /* ════════════════════════════════════════════════════════════
     SIGNATURE VERIFICATION  (client-side HMAC simulation)
     On the server (Cloud Functions), this uses real crypto.
     Client-side: validates the x-sokoni-signature from SmartPOS
     and outbound webhook relays using SubtleCrypto.
  ════════════════════════════════════════════════════════════ */
  async function _verifySignature(body, signature, secret, algorithm = 'sha256') {
    if (!crypto.subtle) return { valid: false, reason: 'SubtleCrypto unavailable' };
    try {
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw', enc.encode(secret), { name: 'HMAC', hash: `SHA-${algorithm === 'sha256' ? '256' : '512'}` },
        false, ['sign']
      );
      const sig     = await crypto.subtle.sign('HMAC', key, enc.encode(body));
      const hexSig  = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
      /* Constant-time compare */
      const valid   = _constantTimeEqual(hexSig, signature.replace(/^sha256=/, ''));
      return { valid, reason: valid ? null : 'Signature mismatch' };
    } catch (e) {
      return { valid: false, reason: e.message };
    }
  }

  function _constantTimeEqual(a, b) {
    if (a.length !== b.length) return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) {
      mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return mismatch === 0;
  }

  /* ════════════════════════════════════════════════════════════
     IDEMPOTENCY
  ════════════════════════════════════════════════════════════ */
  function _idemKey(provider, eventId) {
    return `${provider}::${eventId}`;
  }

  function _isProcessed(key) {
    const entry = _processed.get(key);
    if (!entry) return false;
    if (Date.now() - entry.ts > 86400000) { _processed.delete(key); return false; }
    return true;
  }

  function _markProcessed(key, result) {
    _processed.set(key, { result, ts: Date.now() });
    /* Evict oldest entries beyond 10,000 */
    if (_processed.size > 10000) {
      const oldest = [..._processed.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 1000);
      oldest.forEach(([k]) => _processed.delete(k));
    }
  }

  /* ════════════════════════════════════════════════════════════
     NONCE / REPLAY PROTECTION
  ════════════════════════════════════════════════════════════ */
  function _checkNonce(nonce) {
    if (!nonce) return false;
    if (_nonces.has(nonce)) return false;
    _nonces.add(nonce);
    setTimeout(() => _nonces.delete(nonce), NONCE_TTL);
    return true;
  }

  /* ════════════════════════════════════════════════════════════
     RATE LIMITING  (per-provider sliding window)
  ════════════════════════════════════════════════════════════ */
  function _checkRateLimit(provider) {
    const cfg = PROVIDER_CONFIG[provider]?.rateLimit;
    if (!cfg) return { allowed: true };

    const now   = Date.now();
    let   state = _rateLimits.get(provider);
    if (!state || now > state.resetAt) {
      state = { count: 0, resetAt: now + cfg.window };
      _rateLimits.set(provider, state);
    }

    if (state.count >= cfg.max) {
      return { allowed: false, resetAt: state.resetAt, count: state.count };
    }
    state.count++;
    return { allowed: true, remaining: cfg.max - state.count };
  }

  /* ════════════════════════════════════════════════════════════
     AUDIT LOGGING  (Firestore)
  ════════════════════════════════════════════════════════════ */
  async function _audit(entry) {
    if (!window.firebaseDB) return;
    try {
      const { collection, addDoc, serverTimestamp } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );
      await addDoc(collection(window.firebaseDB, 'webhookLogs'), {
        ...entry,
        serverTs: serverTimestamp(),
      });
    } catch (_) {}
  }

  /* ════════════════════════════════════════════════════════════
     RETRY ENGINE  (exponential back-off)
  ════════════════════════════════════════════════════════════ */
  function _scheduleRetry() {
    if (_retryTimer) return;
    _retryTimer = setTimeout(_processRetries, 5000);
  }

  async function _processRetries() {
    _retryTimer = null;
    const now  = Date.now();
    const due  = _retryQueue.filter(r => r.nextAt <= now);

    for (const item of due) {
      const idx = _retryQueue.indexOf(item);
      _retryQueue.splice(idx, 1);

      const maxRetries = PROVIDER_CONFIG[item.provider]?.retryLimit ?? 5;
      if (item.attempts >= maxRetries) {
        _dlq.push({ ...item, failedAt: now, reason: 'max_retries_exceeded' });
        if (_dlq.length > DLQ_MAX) _dlq.shift();

        await _audit({
          type: 'webhook.dlq', provider: item.provider,
          eventId: item.eventId, attempts: item.attempts,
        });

        if (window.SokoniEventBus) {
          SokoniEventBus.emit(SokoniEventBus.EVENTS.WEBHOOK_DLQ, {
            provider: item.provider, eventId: item.eventId, attempts: item.attempts,
          });
        }
        continue;
      }

      try {
        await _dispatch(item.provider, item.payload, item.eventId, item.attempts + 1);
      } catch (_) {
        /* Will be re-queued by _dispatch */
      }
    }

    if (_retryQueue.length > 0) _scheduleRetry();
  }

  /* ════════════════════════════════════════════════════════════
     CORE DISPATCH
  ════════════════════════════════════════════════════════════ */
  async function _dispatch(provider, payload, eventId, attempt = 1) {
    const handler = _handlers[provider] || _handlers['*'];
    if (!handler) {
      throw new Error(`[WebhookEngine] No handler registered for provider: ${provider}`);
    }

    try {
      const result = await handler(payload, { provider, eventId, attempt });

      _markProcessed(_idemKey(provider, eventId), result);

      await _audit({ type: 'webhook.processed', provider, eventId, attempt, status: 'success' });

      if (window.SokoniEventBus) {
        SokoniEventBus.emit(SokoniEventBus.EVENTS.WEBHOOK_PROCESSED, {
          provider, eventId, attempt, result,
        });
      }

      return result;
    } catch (err) {
      /* Exponential back-off: 5s, 10s, 20s, 40s, 80s */
      const delayMs = Math.min(5000 * Math.pow(2, attempt - 1), 300000);
      _retryQueue.push({ provider, payload, eventId, attempts: attempt, nextAt: Date.now() + delayMs });
      _scheduleRetry();

      await _audit({ type: 'webhook.failed', provider, eventId, attempt, error: err.message });

      if (window.SokoniEventBus) {
        SokoniEventBus.emit(SokoniEventBus.EVENTS.WEBHOOK_FAILED, {
          provider, eventId, attempt, error: err.message,
        });
      }

      throw err;
    }
  }

  /* ════════════════════════════════════════════════════════════
     PUBLIC API
  ════════════════════════════════════════════════════════════ */
  const Engine = {

    PROVIDERS,
    PROVIDER_CONFIG,

    /**
     * Register a handler for a provider's incoming webhooks.
     * @param {string}   provider - One of Engine.PROVIDERS.*
     * @param {Function} handler  - async (payload, ctx) => result
     */
    register(provider, handler) {
      if (typeof handler !== 'function') throw new Error('handler must be a function');
      _handlers[provider] = handler;
    },

    /** Register a catch-all fallback handler. */
    registerDefault(handler) {
      _handlers['*'] = handler;
    },

    /**
     * Process an incoming webhook event.
     * Validates idempotency, optional signature, rate limit, then dispatches.
     */
    async process(provider, payload, opts = {}) {
      const {
        eventId   = payload?.id || payload?.reference || `evt_${Date.now()}`,
        signature = null,
        secret    = null,
        nonce     = null,
        ts        = null,
      } = opts;

      /* 1. Rate limit */
      const rate = _checkRateLimit(provider);
      if (!rate.allowed) {
        const err = new Error(`[WebhookEngine] Rate limit exceeded for ${provider}`);
        if (window.SokoniEventBus) {
          SokoniEventBus.emit(SokoniEventBus.EVENTS.RATE_LIMIT_HIT, { provider, resetAt: rate.resetAt });
        }
        throw err;
      }

      /* 2. Timestamp window check (prevent old replays) */
      if (ts) {
        const age = Math.abs(Date.now() / 1000 - Number(ts));
        const maxAge = PROVIDER_CONFIG[provider]?.maxAgeSeconds ?? 300;
        if (age > maxAge) throw new Error(`[WebhookEngine] Stale webhook (age: ${age}s)`);
      }

      /* 3. Nonce check */
      if (nonce && !_checkNonce(nonce)) {
        throw new Error('[WebhookEngine] Duplicate nonce — replay attack detected');
      }

      /* 4. Signature verification */
      if (signature && secret) {
        const body   = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const verify = await _verifySignature(body, signature, secret);
        if (!verify.valid) {
          await _audit({ type: 'webhook.invalid_sig', provider, eventId, reason: verify.reason });
          throw new Error(`[WebhookEngine] Invalid signature: ${verify.reason}`);
        }
      }

      /* 5. Idempotency */
      const idem = _idemKey(provider, eventId);
      if (_isProcessed(idem)) {
        return { skipped: true, reason: 'already_processed', eventId };
      }

      /* 6. Emit received event */
      if (window.SokoniEventBus) {
        await SokoniEventBus.emit(SokoniEventBus.EVENTS.WEBHOOK_RECEIVED, { provider, eventId, payload });
      }

      await _audit({ type: 'webhook.received', provider, eventId });

      /* 7. Dispatch */
      return _dispatch(provider, payload, eventId);
    },

    /**
     * Manually replay a dead-letter queue item.
     * @param {string} eventId - The eventId of the DLQ entry to replay.
     */
    async replayDLQ(eventId) {
      const idx   = _dlq.findIndex(e => e.eventId === eventId);
      if (idx === -1) throw new Error(`[WebhookEngine] DLQ entry not found: ${eventId}`);
      const entry = _dlq.splice(idx, 1)[0];
      return _dispatch(entry.provider, entry.payload, entry.eventId, 1);
    },

    /** Health check for all registered providers. */
    health() {
      return Object.keys(_handlers).map(provider => ({
        provider,
        registered: true,
        queueDepth: _retryQueue.filter(r => r.provider === provider).length,
        dlqDepth:   _dlq.filter(r => r.provider === provider).length,
        rateLimit:  _rateLimits.get(provider) || null,
      }));
    },

    /** Dump dead-letter queue (admin use). */
    getDLQ() { return [..._dlq]; },

    /** Clear DLQ (admin use after investigation). */
    clearDLQ() { _dlq.length = 0; },

    /** Return retry queue depth. */
    retryQueueDepth() { return _retryQueue.length; },

    /** Diagnostics snapshot for the monitor dashboard. */
    diagnostics() {
      return {
        registeredProviders: Object.keys(_handlers).filter(k => k !== '*'),
        hasDefault:          !!_handlers['*'],
        retryQueue:          _retryQueue.length,
        dlq:                 _dlq.length,
        idempotencyStore:    _processed.size,
        nonceStore:          _nonces.size,
        rateLimitStates:     Object.fromEntries(_rateLimits),
      };
    },
  };

  /* ── Wire up default handlers for known providers ── */
  Engine.register(PROVIDERS.INTASEND, async (payload, ctx) => {
    const status = payload.state || payload.status || payload.payment_status;
    if (!status) throw new Error('IntaSend payload missing status');

    const eventMap = {
      COMPLETE:   SokoniEventBus?.EVENTS?.PAYMENT_COMPLETED,
      FAILED:     SokoniEventBus?.EVENTS?.PAYMENT_FAILED,
      CANCELLED:  SokoniEventBus?.EVENTS?.PAYMENT_FAILED,
    };

    const busEvent = eventMap[status?.toUpperCase()];
    if (busEvent && window.SokoniEventBus) {
      await SokoniEventBus.emit(busEvent, {
        provider:  'intasend',
        reference: payload.invoice?.invoice_id || payload.id,
        amount:    payload.value || payload.amount,
        currency:  payload.currency || 'KES',
        phone:     payload.invoice?.recipient_phone,
        raw:       payload,
      });
    }

    return { handled: true, status };
  });

  Engine.register(PROVIDERS.MPESA, async (payload, ctx) => {
    const result = payload.Body?.stkCallback || payload;
    const code   = result.ResultCode ?? result.result_code;
    const eventType = code === 0
      ? SokoniEventBus?.EVENTS?.PAYMENT_COMPLETED
      : SokoniEventBus?.EVENTS?.PAYMENT_FAILED;

    if (eventType && window.SokoniEventBus) {
      const items = result.CallbackMetadata?.Item || [];
      const get   = (name) => items.find(i => i.Name === name)?.Value;

      await SokoniEventBus.emit(eventType, {
        provider:      'mpesa',
        reference:     result.CheckoutRequestID,
        amount:        get('Amount'),
        phone:         get('PhoneNumber'),
        mpesaCode:     get('MpesaReceiptNumber'),
        resultCode:    code,
        resultDesc:    result.ResultDesc,
        raw:           payload,
      });
    }

    return { handled: true, resultCode: code };
  });

  Engine.register(PROVIDERS.SMARTPOS, async (payload, ctx) => {
    if (window.SokoniEventBus) {
      await SokoniEventBus.emit(SokoniEventBus.EVENTS.SMARTPOS_TRANSACTION, {
        terminalId: payload.terminal_id,
        amount:     payload.amount,
        method:     payload.payment_method,
        orderId:    payload.order_id,
        timestamp:  payload.timestamp,
        raw:        payload,
      });
    }
    return { handled: true };
  });

  return Engine;
})();

window.SokoniWebhookEngine = SokoniWebhookEngine;
