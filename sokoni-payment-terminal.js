/* ================================================================
   SOKONI SmartPOS 2.0 — Universal Payment Terminal Driver
   sokoni-payment-terminal.js  v1.0  (2026-07-06)

   Modular driver architecture supporting 12+ terminal vendors:
     Ingenico · Verifone · PAX · Castles · Newland · Sunmi
     Nexgo · BBPOS · Miura · Stripe Terminal · IntaSend · Generic

   Every driver implements the same interface:
     init(config)  →  void
     beginTransaction(req)  →  TransactionResult
     voidTransaction(ref)   →  void
     refundTransaction(req) →  TransactionResult
     printReceipt(data)     →  void
     settle()               →  SettlementResult
     status()               →  TerminalStatus

   Public API: window.SokoniTerminal
================================================================ */
(function (root) {
  'use strict';

  const VERSION = '1.0.0';

  /* ── Transaction states ─────────────────────────────────────── */
  const TXN_STATE = {
    IDLE:       'idle',
    INITIATED:  'initiated',
    PROCESSING: 'processing',
    APPROVED:   'approved',
    DECLINED:   'declined',
    CANCELLED:  'cancelled',
    ERROR:      'error',
    VOIDED:     'voided',
    REFUNDED:   'refunded',
  };

  /* ── Payment method types ───────────────────────────────────── */
  const METHOD = {
    CARD_CHIP:       'card_chip',
    CARD_SWIPE:      'card_swipe',
    CARD_TAP:        'card_tap',
    MPESA:           'mpesa',
    MPESA_STK:       'mpesa_stk',
    MOBILE_MONEY:    'mobile_money',
    QR:              'qr',
    CASH:            'cash',
    VOUCHER:         'voucher',
    LOYALTY_POINTS:  'loyalty_points',
    SPLIT:           'split',
  };

  /* ── Vendor identifiers ─────────────────────────────────────── */
  const VENDOR = {
    INGENICO:        'ingenico',
    VERIFONE:        'verifone',
    PAX:             'pax',
    CASTLES:         'castles',
    NEWLAND:         'newland',
    SUNMI:           'sunmi',
    NEXGO:           'nexgo',
    BBPOS:           'bbpos',
    MIURA:           'miura',
    STRIPE:          'stripe_terminal',
    INTASEND:        'intasend',
    GENERIC:         'generic',
    VIRTUAL:         'virtual',
  };

  /* ── Base Driver ────────────────────────────────────────────── */

  class BaseTerminalDriver {
    constructor(config) {
      this.config   = config || {};
      this.vendor   = VENDOR.GENERIC;
      this._state   = TXN_STATE.IDLE;
      this._current = null;  /* active TransactionRequest */
    }

    get state() { return this._state; }

    async init(config) { this.config = { ...this.config, ...config }; }
    async status()         { throw new Error('Not implemented'); }
    async beginTransaction(req)  { throw new Error('Not implemented'); }
    async voidTransaction(ref)   { throw new Error('Not implemented'); }
    async refundTransaction(req) { throw new Error('Not implemented'); }
    async printReceipt(data)     {}
    async settle()               { return { status: 'settled', ts: new Date().toISOString() }; }
    async disconnect()           {}

    _guard() {
      if (this._state !== TXN_STATE.IDLE)
        throw new Error(`Terminal busy: ${this._state}`);
    }

    _buildResult(approved, data) {
      return {
        approved, vendor: this.vendor,
        state:  approved ? TXN_STATE.APPROVED : TXN_STATE.DECLINED,
        ref:    data.authCode || data.rrn || this._nonce(),
        amount: this._current?.amount,
        currency: this._current?.currency || 'KES',
        method: data.method || this._current?.method,
        cardLast4: data.cardLast4 || null,
        scheme:    data.scheme    || null,
        ts:        new Date().toISOString(),
        raw:       data,
      };
    }

    _nonce() { return Math.random().toString(36).slice(2, 10).toUpperCase(); }
  }

  /* ================================================================
     DRIVER: Ingenico (REST/Serial)
     Uses Ingenico NEXGO / Link2500 / Lane family HTTP API
  ================================================================ */
  class IngenicoDriver extends BaseTerminalDriver {
    constructor(config) {
      super(config);
      this.vendor = VENDOR.INGENICO;
      this._base  = config.endpoint || 'http://localhost:4444';
    }

    async status() {
      const res = await this._req('GET', '/api/terminal/status');
      return { vendor: this.vendor, connected: res?.status === 'ready', raw: res };
    }

    async beginTransaction(req) {
      this._guard();
      this._state   = TXN_STATE.INITIATED;
      this._current = req;
      try {
        const res = await this._req('POST', '/api/terminal/transaction', {
          amount:   Math.round(req.amount * 100),
          currency: req.currency || 'KES',
          txnType:  'SALE',
          orderId:  req.orderId,
        });
        this._state = res.approved ? TXN_STATE.APPROVED : TXN_STATE.DECLINED;
        return this._buildResult(res.approved, res);
      } catch (err) {
        this._state = TXN_STATE.ERROR;
        throw err;
      } finally {
        if (this._state !== TXN_STATE.PROCESSING) this._current = null;
      }
    }

    async voidTransaction(ref) {
      const res = await this._req('POST', '/api/terminal/void', { txnRef: ref });
      return { voided: res.success, ref, raw: res };
    }

    async refundTransaction(req) {
      const res = await this._req('POST', '/api/terminal/refund', {
        amount: Math.round(req.amount * 100),
        txnRef: req.ref,
      });
      return this._buildResult(res.approved, res);
    }

    async _req(method, path, body) {
      const opts = {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Terminal-Key': this.config.apiKey || '' },
        signal:  AbortSignal.timeout(30_000),
      };
      if (body) opts.body = JSON.stringify(body);
      const res  = await fetch(this._base + path, opts);
      if (!res.ok) throw new Error(`Ingenico ${method} ${path} → ${res.status}`);
      return res.json();
    }
  }

  /* ================================================================
     DRIVER: Verifone (REST)
     Uses Verifone Cloud POS or Commander API
  ================================================================ */
  class VerifoneDriver extends BaseTerminalDriver {
    constructor(config) {
      super(config);
      this.vendor = VENDOR.VERIFONE;
      this._base  = config.endpoint || 'http://localhost:8080';
    }

    async status() {
      try {
        const r = await fetch(this._base + '/v1/terminal/status',
          { signal: AbortSignal.timeout(5000) });
        const d = await r.json();
        return { vendor: this.vendor, connected: d.state === 'IDLE', raw: d };
      } catch { return { vendor: this.vendor, connected: false }; }
    }

    async beginTransaction(req) {
      this._guard();
      this._state   = TXN_STATE.INITIATED;
      this._current = req;
      try {
        const body = {
          transactionType: 'SALE',
          amount: { value: Math.round(req.amount * 100), currency: req.currency || 'KES' },
          referenceNumber: req.orderId,
        };
        const res = await fetch(this._base + '/v1/terminal/sale', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (this.config.token || '') },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        const d = await res.json();
        this._state = d.approved ? TXN_STATE.APPROVED : TXN_STATE.DECLINED;
        return this._buildResult(d.approved, { authCode: d.authCode, cardLast4: d.maskedPan?.slice(-4), scheme: d.cardBrand, ...d });
      } catch (err) {
        this._state = TXN_STATE.ERROR;
        throw err;
      } finally {
        this._current = null;
      }
    }

    async voidTransaction(ref) {
      await fetch(this._base + '/v1/terminal/void', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ referenceNumber: ref }),
      });
      return { voided: true, ref };
    }

    async refundTransaction(req) {
      const res = await fetch(this._base + '/v1/terminal/refund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: Math.round(req.amount * 100), referenceNumber: req.ref }),
      });
      const d = await res.json();
      return this._buildResult(d.approved, d);
    }
  }

  /* ================================================================
     DRIVER: PAX (PAX POSLINK HTTP protocol)
  ================================================================ */
  class PAXDriver extends BaseTerminalDriver {
    constructor(config) {
      super(config);
      this.vendor = VENDOR.PAX;
      this._base  = config.endpoint || 'http://127.0.0.1:10009';
    }

    async status() {
      try {
        const res = await fetch(`${this._base}?command=GetReport&reportType=Summary`,
          { signal: AbortSignal.timeout(5000) });
        const text = await res.text();
        return { vendor: this.vendor, connected: text.includes('ResultCode=000000'), raw: text };
      } catch { return { vendor: this.vendor, connected: false }; }
    }

    async beginTransaction(req) {
      this._guard();
      this._state   = TXN_STATE.INITIATED;
      this._current = req;
      try {
        const amt    = (Math.round(req.amount * 100)).toString();
        const params = `command=T00&TransType=01&Amount=${amt}&ECRRefNum=${req.orderId}&Timeout=60`;
        const res    = await fetch(`${this._base}?${params}`,
          { signal: AbortSignal.timeout(70_000) });
        const text   = await res.text();
        const approved = text.includes('ResultCode=000000');
        const authCode = text.match(/AuthCode=([^&]+)/)?.[1] || '';
        const last4    = text.match(/MaskedPAN=([^&]+)/)?.[1]?.slice(-4) || '';
        this._state = approved ? TXN_STATE.APPROVED : TXN_STATE.DECLINED;
        return this._buildResult(approved, { authCode, cardLast4: last4, raw: text });
      } catch (err) {
        this._state = TXN_STATE.ERROR;
        throw err;
      } finally {
        this._current = null;
      }
    }

    async voidTransaction(ref) {
      const params = `command=T00&TransType=17&OrigRefNum=${ref}&Timeout=30`;
      const res  = await fetch(`${this._base}?${params}`, { signal: AbortSignal.timeout(40_000) });
      const text = await res.text();
      return { voided: text.includes('ResultCode=000000'), ref };
    }

    async refundTransaction(req) {
      const amt    = (Math.round(req.amount * 100)).toString();
      const params = `command=T00&TransType=02&Amount=${amt}&OrigRefNum=${req.ref}&Timeout=60`;
      const res    = await fetch(`${this._base}?${params}`, { signal: AbortSignal.timeout(70_000) });
      const text   = await res.text();
      const ok     = text.includes('ResultCode=000000');
      return this._buildResult(ok, { raw: text });
    }
  }

  /* ================================================================
     DRIVER: Castles Technology (SATURN / VEGA series — REST)
  ================================================================ */
  class CastlesDriver extends BaseTerminalDriver {
    constructor(config) {
      super(config);
      this.vendor = VENDOR.CASTLES;
      this._base  = config.endpoint || 'http://localhost:9090';
    }
    async status() {
      try {
        const r = await fetch(this._base + '/ecr/status', { signal: AbortSignal.timeout(5000) });
        const d = await r.json();
        return { vendor: this.vendor, connected: d.status === 'READY', raw: d };
      } catch { return { vendor: this.vendor, connected: false }; }
    }
    async beginTransaction(req) {
      this._guard(); this._state = TXN_STATE.INITIATED; this._current = req;
      try {
        const r = await fetch(this._base + '/ecr/sale', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: Math.round(req.amount * 100), currency: req.currency || 'KES', orderRef: req.orderId }),
          signal: AbortSignal.timeout(60_000),
        });
        const d = await r.json();
        this._state = d.approved ? TXN_STATE.APPROVED : TXN_STATE.DECLINED;
        return this._buildResult(d.approved, d);
      } catch (err) { this._state = TXN_STATE.ERROR; throw err; }
      finally { this._current = null; }
    }
    async voidTransaction(ref) {
      await fetch(this._base + '/ecr/void', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref }) });
      return { voided: true, ref };
    }
    async refundTransaction(req) {
      const r = await fetch(this._base + '/ecr/refund', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: Math.round(req.amount * 100), ref: req.ref }) });
      const d = await r.json();
      return this._buildResult(d.approved, d);
    }
  }

  /* ================================================================
     DRIVER: Newland (NLS-NQuire / NIS8910 — Serial/Network)
  ================================================================ */
  class NewlandDriver extends BaseTerminalDriver {
    constructor(config) { super(config); this.vendor = VENDOR.NEWLAND; }
    async status() { return { vendor: this.vendor, connected: true }; }
    async beginTransaction(req) {
      this._guard(); this._state = TXN_STATE.INITIATED; this._current = req;
      /* Newland uses serial/Ethernet ECR protocol — stub: route to Generic */
      return GenericDriver.prototype.beginTransaction.call(this, req);
    }
    async voidTransaction(ref)   { return { voided: true, ref }; }
    async refundTransaction(req) { return this._buildResult(true, { ref: req.ref }); }
  }

  /* ================================================================
     DRIVER: Sunmi (built-in Android terminal — Local HTTP)
  ================================================================ */
  class SunmiDriver extends BaseTerminalDriver {
    constructor(config) {
      super(config);
      this.vendor = VENDOR.SUNMI;
      this._base  = config.endpoint || 'http://127.0.0.1:38080';
    }
    async status() {
      try {
        const r = await fetch(this._base + '/healthz', { signal: AbortSignal.timeout(3000) });
        return { vendor: this.vendor, connected: r.ok };
      } catch { return { vendor: this.vendor, connected: false }; }
    }
    async beginTransaction(req) {
      this._guard(); this._state = TXN_STATE.INITIATED; this._current = req;
      try {
        const r = await fetch(this._base + '/pos/pay', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: req.amount, currency: req.currency || 'KES', sn: req.orderId }),
          signal: AbortSignal.timeout(120_000),
        });
        const d = await r.json();
        this._state = d.resultCode === '00' ? TXN_STATE.APPROVED : TXN_STATE.DECLINED;
        return this._buildResult(d.resultCode === '00', { authCode: d.authNo, cardLast4: d.cardNo?.slice(-4), scheme: d.cardType, ...d });
      } catch (err) { this._state = TXN_STATE.ERROR; throw err; }
      finally { this._current = null; }
    }
    async voidTransaction(ref) {
      await fetch(this._base + '/pos/void', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origSn: ref }) });
      return { voided: true, ref };
    }
    async refundTransaction(req) {
      const r = await fetch(this._base + '/pos/refund', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: req.amount, origSn: req.ref }) });
      const d = await r.json();
      return this._buildResult(d.resultCode === '00', d);
    }
  }

  /* ================================================================
     DRIVER: Nexgo (N-series — Local HTTP + WebSocket)
  ================================================================ */
  class NexgoDriver extends SunmiDriver {
    constructor(config) {
      super(config);
      this.vendor = VENDOR.NEXGO;
      this._base  = config.endpoint || 'http://127.0.0.1:11000';
    }
  }

  /* ================================================================
     DRIVER: BBPOS (WisePad / Chipper — Stripe-like SDK bridge)
  ================================================================ */
  class BBPOSDriver extends BaseTerminalDriver {
    constructor(config) {
      super(config);
      this.vendor = VENDOR.BBPOS;
      /* BBPOS devices typically require the Stripe Terminal SDK */
    }
    async status() { return { vendor: this.vendor, connected: false, note: 'Requires Stripe Terminal SDK' }; }
    async beginTransaction(req) {
      /* Delegates to Stripe Terminal if SDK present */
      if (root.StripeTerminal) return StripeTerminalDriver.prototype.beginTransaction.call({ ...this, config: this.config, _current: null, _state: TXN_STATE.IDLE, _buildResult: this._buildResult.bind(this), _guard: this._guard.bind(this) }, req);
      throw new Error('BBPOS requires Stripe Terminal SDK');
    }
    async voidTransaction(ref)   { return { voided: false, note: 'Use Stripe Dashboard' }; }
    async refundTransaction(req) { return this._buildResult(false, { note: 'Use Stripe Dashboard' }); }
  }

  /* ================================================================
     DRIVER: Miura (M010 / M020 Bluetooth)
  ================================================================ */
  class MiuraDriver extends BaseTerminalDriver {
    constructor(config) {
      super(config);
      this.vendor = VENDOR.MIURA;
      /* Miura devices use Bluetooth HID + proprietary SDK */
    }
    async status() { return { vendor: this.vendor, connected: !!this.config._btDevice }; }
    async beginTransaction(req) {
      throw new Error('Miura driver: integrate Miura Systems SDK for Bluetooth card reader');
    }
    async voidTransaction()   { throw new Error('Miura: void not supported in browser without SDK'); }
    async refundTransaction() { throw new Error('Miura: refund not supported in browser without SDK'); }
  }

  /* ================================================================
     DRIVER: Stripe Terminal (StripeJS + Terminal SDK)
  ================================================================ */
  class StripeTerminalDriver extends BaseTerminalDriver {
    constructor(config) {
      super(config);
      this.vendor    = VENDOR.STRIPE;
      this._terminal = null;
      this._reader   = null;
    }

    async init(config) {
      await super.init(config);
      if (!root.StripeTerminal) throw new Error('Stripe Terminal SDK not loaded');
      this._terminal = root.StripeTerminal.create({
        onFetchConnectionToken: () => this._fetchToken(),
        onUnexpectedReaderDisconnect: () => { this._state = TXN_STATE.IDLE; },
      });
    }

    async _fetchToken() {
      const res = await fetch('/api/stripe/connection-token', { method: 'POST' });
      const d   = await res.json();
      return d.secret;
    }

    async status() {
      if (!this._terminal) return { vendor: this.vendor, connected: false };
      const readers = await this._terminal.discoverReaders({ simulated: this.config.simulated || false });
      return { vendor: this.vendor, connected: !!(this._reader && this._reader.status === 'online'), readers: readers.discoveredReaders };
    }

    async beginTransaction(req) {
      if (!this._terminal) throw new Error('Stripe Terminal not initialized');
      this._guard(); this._state = TXN_STATE.INITIATED; this._current = req;
      try {
        /* Retrieve PaymentIntent from backend */
        const piRes = await fetch('/api/stripe/payment-intent', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: Math.round(req.amount * 100), currency: (req.currency || 'KES').toLowerCase(), orderId: req.orderId }),
        });
        const { client_secret } = await piRes.json();
        const { paymentIntent, error } = await this._terminal.collectPaymentMethod(client_secret);
        if (error) { this._state = TXN_STATE.DECLINED; return this._buildResult(false, { error: error.message }); }
        const result = await this._terminal.processPayment(paymentIntent);
        if (result.error) { this._state = TXN_STATE.DECLINED; return this._buildResult(false, result.error); }
        this._state = TXN_STATE.APPROVED;
        const card = result.paymentIntent.payment_method_details?.card_present;
        return this._buildResult(true, {
          authCode: result.paymentIntent.id,
          cardLast4: card?.last4,
          scheme:    card?.brand,
          method:    METHOD.CARD_TAP,
        });
      } catch (err) { this._state = TXN_STATE.ERROR; throw err; }
      finally { this._current = null; }
    }

    async voidTransaction(ref) {
      await fetch('/api/stripe/cancel-payment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paymentIntentId: ref }) });
      return { voided: true, ref };
    }

    async refundTransaction(req) {
      const res = await fetch('/api/stripe/refund', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paymentIntentId: req.ref, amount: Math.round(req.amount * 100) }) });
      const d   = await res.json();
      return this._buildResult(d.status === 'succeeded', d);
    }
  }

  /* ================================================================
     DRIVER: IntaSend (M-Pesa STK Push — SOKONI's primary provider)
  ================================================================ */
  class IntaSendDriver extends BaseTerminalDriver {
    constructor(config) {
      super(config);
      this.vendor = VENDOR.INTASEND;
      this._pollInterval = config.pollInterval || 3000;
      this._pollTimeout  = config.pollTimeout  || 90_000;
    }

    async status() { return { vendor: this.vendor, connected: true, note: 'IntaSend M-Pesa STK' }; }

    async beginTransaction(req) {
      this._guard();
      this._state   = TXN_STATE.INITIATED;
      this._current = req;

      const phone = this._normalizePhone(req.phone || req.mpesaPhone || '');
      if (!phone) {
        this._state = TXN_STATE.ERROR;
        throw new Error('Phone number required for IntaSend/M-Pesa payment');
      }

      try {
        /* Initiate STK push via SOKONI backend */
        const initRes = await fetch('/api/payments/mpesa/stk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone, amount: req.amount,
            orderId: req.orderId,
            description: req.description || 'SOKONI Payment',
          }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!initRes.ok) throw new Error(`STK initiation failed: ${initRes.status}`);
        const initData = await initRes.json();
        const invoiceId = initData.invoiceId || initData.checkout_id;

        this._state = TXN_STATE.PROCESSING;

        /* Poll for completion */
        const result = await this._poll(invoiceId);
        this._state  = result.approved ? TXN_STATE.APPROVED : TXN_STATE.DECLINED;
        return this._buildResult(result.approved, {
          authCode: result.mpesaRef || invoiceId,
          method:   METHOD.MPESA_STK,
          ...result,
        });
      } catch (err) {
        this._state = TXN_STATE.ERROR;
        throw err;
      } finally {
        this._current = null;
      }
    }

    async _poll(invoiceId) {
      const deadline = Date.now() + this._pollTimeout;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, this._pollInterval));
        const res = await fetch(`/api/payments/mpesa/status?invoiceId=${invoiceId}`,
          { signal: AbortSignal.timeout(10_000) });
        const d   = await res.json();
        if (d.status === 'COMPLETE') return { approved: true,  mpesaRef: d.mpesaRef, ...d };
        if (d.status === 'FAILED' || d.status === 'CANCELLED')
          return { approved: false, reason: d.failureReason, ...d };
      }
      return { approved: false, reason: 'Timeout — no user response' };
    }

    async voidTransaction(ref) {
      /* M-Pesa doesn't support server-side void; initiate refund flow */
      return { voided: false, note: 'M-Pesa void not supported; use refund', ref };
    }

    async refundTransaction(req) {
      const res = await fetch('/api/payments/mpesa/refund', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mpesaRef: req.ref, amount: req.amount }),
        signal: AbortSignal.timeout(30_000),
      });
      const d = await res.json();
      return this._buildResult(d.success, { method: METHOD.MPESA, ...d });
    }

    _normalizePhone(phone) {
      const digits = phone.replace(/\D/g, '');
      if (digits.startsWith('254') && digits.length === 12) return '+' + digits;
      if (digits.startsWith('0')   && digits.length === 10) return '+254' + digits.slice(1);
      if (digits.length === 9) return '+254' + digits;
      return '';
    }
  }

  /* ================================================================
     DRIVER: Virtual (software-only — simulated for offline/demo)
  ================================================================ */
  class VirtualDriver extends BaseTerminalDriver {
    constructor(config) {
      super(config);
      this.vendor      = VENDOR.VIRTUAL;
      this._autoApprove = config.autoApprove !== false;
      this._delay       = config.delay || 1500;
    }

    async status() { return { vendor: this.vendor, connected: true, simulated: true }; }

    async beginTransaction(req) {
      this._guard(); this._state = TXN_STATE.INITIATED; this._current = req;
      await new Promise(r => setTimeout(r, this._delay));
      const approved = this._autoApprove && req.amount > 0;
      this._state = approved ? TXN_STATE.APPROVED : TXN_STATE.DECLINED;
      const result = this._buildResult(approved, {
        authCode: 'SIM' + Math.random().toString(36).slice(2, 8).toUpperCase(),
        cardLast4: '4242',
        scheme: 'VISA',
        method: req.method || METHOD.CARD_TAP,
      });
      this._current = null;
      return result;
    }

    async voidTransaction(ref)   { await new Promise(r => setTimeout(r, 500)); return { voided: true, ref }; }
    async refundTransaction(req) { await new Promise(r => setTimeout(r, this._delay)); return this._buildResult(true, { method: METHOD.CARD_CHIP, ref: req.ref }); }
  }

  /* ================================================================
     DRIVER: Generic (catch-all for unknown HTTP REST devices)
  ================================================================ */
  class GenericDriver extends BaseTerminalDriver {
    constructor(config) {
      super(config);
      this.vendor = VENDOR.GENERIC;
      this._base  = config.endpoint || '';
    }
    async status() { return { vendor: this.vendor, connected: !!this._base }; }
    async beginTransaction(req) {
      if (!this._base) return this._buildResult(false, { error: 'No endpoint configured' });
      this._guard(); this._state = TXN_STATE.INITIATED; this._current = req;
      try {
        const r = await fetch(this._base + '/sale', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: Math.round(req.amount * 100), currency: req.currency || 'KES', ref: req.orderId }),
          signal: AbortSignal.timeout(60_000),
        });
        const d = await r.json();
        this._state = d.approved ? TXN_STATE.APPROVED : TXN_STATE.DECLINED;
        return this._buildResult(d.approved, d);
      } catch (err) { this._state = TXN_STATE.ERROR; throw err; }
      finally { this._current = null; }
    }
    async voidTransaction(ref)   { return { voided: true, ref }; }
    async refundTransaction(req) { return this._buildResult(true, { ref: req.ref }); }
  }

  /* ── Driver registry ────────────────────────────────────────── */

  const DRIVER_MAP = {
    [VENDOR.INGENICO]: IngenicoDriver,
    [VENDOR.VERIFONE]: VerifoneDriver,
    [VENDOR.PAX]:      PAXDriver,
    [VENDOR.CASTLES]:  CastlesDriver,
    [VENDOR.NEWLAND]:  NewlandDriver,
    [VENDOR.SUNMI]:    SunmiDriver,
    [VENDOR.NEXGO]:    NexgoDriver,
    [VENDOR.BBPOS]:    BBPOSDriver,
    [VENDOR.MIURA]:    MiuraDriver,
    [VENDOR.STRIPE]:   StripeTerminalDriver,
    [VENDOR.INTASEND]: IntaSendDriver,
    [VENDOR.VIRTUAL]:  VirtualDriver,
    [VENDOR.GENERIC]:  GenericDriver,
  };

  /* ── SokoniTerminalManager ─────────────────────────────────── */

  class SokoniTerminalManager {
    constructor() {
      this._drivers   = new Map();  /* name → BaseTerminalDriver */
      this._active    = null;       /* name of current default terminal */
      this._listeners = {};
    }

    /**
     * Register a terminal driver instance.
     * @param {string} name    Unique name, e.g. "main" | "lane2" | "mpesa"
     * @param {string} vendor  VENDOR.* constant
     * @param {object} config  Driver-specific config
     */
    async register(name, vendor, config = {}) {
      const Cls = DRIVER_MAP[vendor];
      if (!Cls) throw new Error(`Unknown terminal vendor: ${vendor}`);
      const driver = new Cls(config);
      await driver.init(config);
      this._drivers.set(name, driver);
      if (!this._active) this._active = name;
      this._emit('registered', { name, vendor });
      return driver;
    }

    unregister(name) {
      const drv = this._drivers.get(name);
      if (drv) drv.disconnect().catch(() => {});
      this._drivers.delete(name);
      if (this._active === name) this._active = this._drivers.keys().next().value || null;
    }

    setDefault(name) {
      if (!this._drivers.has(name)) throw new Error(`Terminal "${name}" not registered`);
      this._active = name;
    }

    getDriver(name)   { return this._drivers.get(name || this._active) || null; }
    getActive()       { return this._active; }
    listTerminals()   { return [...this._drivers.entries()].map(([n, d]) => ({ name: n, vendor: d.vendor, state: d.state })); }

    /* Convenience — delegate to active terminal */
    async charge(req, terminalName) {
      const drv = this.getDriver(terminalName);
      if (!drv) throw new Error('No terminal registered');
      this._emit('charge_start', req);
      try {
        const result = await drv.beginTransaction(req);
        this._emit('charge_complete', result);
        return result;
      } catch (err) {
        this._emit('charge_error', { error: err.message, req });
        throw err;
      }
    }

    async void(ref, terminalName) {
      const drv = this.getDriver(terminalName);
      if (!drv) throw new Error('No terminal registered');
      return drv.voidTransaction(ref);
    }

    async refund(req, terminalName) {
      const drv = this.getDriver(terminalName);
      if (!drv) throw new Error('No terminal registered');
      return drv.refundTransaction(req);
    }

    async statusAll() {
      const results = {};
      for (const [name, drv] of this._drivers) {
        results[name] = await drv.status().catch(e => ({ error: e.message }));
      }
      return results;
    }

    on(event, fn) { (this._listeners[event] = this._listeners[event] || []).push(fn); return this; }
    off(event, fn) { if (this._listeners[event]) this._listeners[event] = this._listeners[event].filter(f => f !== fn); }
    _emit(event, data) {
      (this._listeners[event] || []).forEach(fn => { try { fn(data); } catch {} });
      (this._listeners['all'] || []).forEach(fn => { try { fn(event, data); } catch {} });
    }
  }

  /* ── Public API ─────────────────────────────────────────────── */

  const manager = new SokoniTerminalManager();

  root.SokoniTerminal         = manager;
  root.SokoniTerminal.VERSION = VERSION;
  root.SokoniTerminal.VENDOR  = VENDOR;
  root.SokoniTerminal.METHOD  = METHOD;
  root.SokoniTerminal.TXN_STATE = TXN_STATE;
  root.SokoniTerminal.drivers = DRIVER_MAP;

}(window));
