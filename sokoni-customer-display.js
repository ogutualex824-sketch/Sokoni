/* ================================================================
   SOKONI SmartPOS 2.0 — Customer Display Engine
   sokoni-customer-display.js  v1.0  (2026-07-06)

   Drives a second screen (monitor, tablet, phone, TV, browser tab)
   showing the customer-facing POS view in real time.

   Three sync channels (in priority order):
     1. BroadcastChannel  — same device, instant (< 1ms)
     2. Firestore         — cross-device, near-real-time (< 500ms)
     3. SharedWorker      — same origin, multiple tabs

   Public API: window.SokoniCustomerDisplay
================================================================ */
(function (root) {
  'use strict';

  const VERSION  = '1.0.0';
  const CHANNEL  = 'sokoni_customer_display';
  const IDLE_MS  = 60_000;  /* show idle screen after 60s inactivity */

  /* ── Message types ──────────────────────────────────────────── */
  const MSG = {
    CART_UPDATE:     'cart_update',
    ITEM_ADDED:      'item_added',
    ITEM_REMOVED:    'item_removed',
    TOTAL_UPDATE:    'total_update',
    PAYMENT_START:   'payment_start',
    PAYMENT_APPROVED:'payment_approved',
    PAYMENT_DECLINED:'payment_declined',
    RECEIPT_READY:   'receipt_ready',
    IDLE:            'idle',
    PROMO:           'promo',
    BRANDING:        'branding',
    CUSTOM:          'custom',
  };

  /* ── SokoniCustomerDisplay (Sender side — POS sends) ────────── */

  class SokoniCustomerDisplay {
    constructor() {
      this._channel   = null;
      this._db        = null;   /* Firestore db reference */
      this._sessionId = null;
      this._idleTimer = null;
      this._displayWindow = null;
      this._displayUrl    = '/customer-display.html';
      this._listeners     = {};
      this._lastMsg       = null;
      this._branding      = {};
    }

    /* ── Initialization ───────────────────────────────────────── */

    init(options = {}) {
      this._sessionId  = options.sessionId || this._loadSessionId();
      this._displayUrl = options.displayUrl || this._displayUrl;
      this._branding   = options.branding   || {};
      this._db         = options.db || (root.firebase?.firestore ? root.firebase.firestore() : null);

      /* BroadcastChannel for same-device sync */
      if (typeof BroadcastChannel !== 'undefined') {
        this._channel = new BroadcastChannel(CHANNEL + '_' + this._sessionId);
        this._channel.onmessageerror = () => {};
      }

      this._resetIdleTimer();
      return this;
    }

    /* ── Display window management ────────────────────────────── */

    /** Open the customer display in a new window (second monitor) */
    openDisplay(options = {}) {
      const w = options.width  || 1280;
      const h = options.height || 720;
      const url = this._displayUrl + '?session=' + this._sessionId;
      this._displayWindow = window.open(url, 'sokoni_display',
        `width=${w},height=${h},menubar=no,toolbar=no,location=no,status=no,scrollbars=no`);
      if (!this._displayWindow) {
        this._emit('error', { code: 'popup_blocked', message: 'Customer display window was blocked by browser' });
      }
      return this._displayWindow;
    }

    closeDisplay() {
      if (this._displayWindow && !this._displayWindow.closed) this._displayWindow.close();
      this._displayWindow = null;
    }

    isDisplayOpen() {
      return !!(this._displayWindow && !this._displayWindow.closed);
    }

    /* ── POS → Display messaging ─────────────────────────────── */

    sendCartUpdate(cartItems, subtotal, discount, tax, total, currency) {
      this._send({
        type:     MSG.CART_UPDATE,
        cart:     cartItems,
        subtotal, discount, tax, total,
        currency: currency || 'KES',
      });
      this._resetIdleTimer();
    }

    sendItemAdded(item) {
      this._send({ type: MSG.ITEM_ADDED, item });
      this._resetIdleTimer();
    }

    sendItemRemoved(itemId) {
      this._send({ type: MSG.ITEM_REMOVED, itemId });
      this._resetIdleTimer();
    }

    sendTotalUpdate(subtotal, discount, tax, total, currency) {
      this._send({ type: MSG.TOTAL_UPDATE, subtotal, discount, tax, total, currency: currency || 'KES' });
    }

    sendPaymentStart(method, amount, currency) {
      this._send({ type: MSG.PAYMENT_START, method, amount, currency: currency || 'KES' });
    }

    sendPaymentApproved(result) {
      this._send({ type: MSG.PAYMENT_APPROVED, result });
      setTimeout(() => this.sendIdle(), 6000);
    }

    sendPaymentDeclined(reason) {
      this._send({ type: MSG.PAYMENT_DECLINED, reason });
    }

    sendReceiptReady(receiptData) {
      this._send({ type: MSG.RECEIPT_READY, receipt: receiptData });
    }

    sendIdle() {
      this._send({ type: MSG.IDLE });
    }

    sendPromo(promo) {
      this._send({ type: MSG.PROMO, promo });
    }

    sendBranding(branding) {
      this._branding = { ...this._branding, ...branding };
      this._send({ type: MSG.BRANDING, branding: this._branding });
    }

    sendCustom(payload) {
      this._send({ type: MSG.CUSTOM, payload });
    }

    /* ── Internal ──────────────────────────────────────────────── */

    _send(msg) {
      const envelope = {
        ...msg,
        sessionId: this._sessionId,
        ts: Date.now(),
        v:  VERSION,
      };
      this._lastMsg = envelope;

      /* 1. BroadcastChannel (same device) */
      try { this._channel?.postMessage(envelope); } catch {}

      /* 2. postMessage to display window (same origin) */
      try {
        if (this._displayWindow && !this._displayWindow.closed)
          this._displayWindow.postMessage(envelope, '*');
      } catch {}

      /* 3. Firestore (cross-device) */
      this._syncFirestore(envelope);

      this._emit('sent', envelope);
    }

    async _syncFirestore(envelope) {
      if (!this._db) return;
      try {
        const ref = this._db.collection('posCustomerDisplays').doc(this._sessionId);
        await ref.set({ ...envelope, updatedAt: new Date() }, { merge: true });
      } catch {}
    }

    _loadSessionId() {
      let id = sessionStorage.getItem('sokoni_display_session');
      if (!id) {
        id = 'disp_' + Math.random().toString(36).slice(2, 10);
        sessionStorage.setItem('sokoni_display_session', id);
      }
      return id;
    }

    _resetIdleTimer() {
      clearTimeout(this._idleTimer);
      this._idleTimer = setTimeout(() => this.sendIdle(), IDLE_MS);
    }

    on(event, fn) { (this._listeners[event] = this._listeners[event] || []).push(fn); return this; }
    off(event, fn) { this._listeners[event] = (this._listeners[event] || []).filter(f => f !== fn); }
    _emit(e, d) { (this._listeners[e] || []).forEach(fn => { try { fn(d); } catch {} }); }

    destroy() {
      clearTimeout(this._idleTimer);
      try { this._channel?.close(); } catch {}
      this.closeDisplay();
    }
  }

  /* ── SokoniDisplayReceiver (customer-display.html side) ──────── */

  class SokoniDisplayReceiver {
    constructor() {
      this._channel   = null;
      this._db        = null;
      this._sessionId = null;
      this._unsub     = null;
      this._handlers  = {};
      this._state     = 'idle';
    }

    init(options = {}) {
      /* Read session from URL query param */
      const params = new URLSearchParams(location.search);
      this._sessionId = options.sessionId || params.get('session') || 'default';
      this._db        = options.db || (root.firebase?.firestore ? root.firebase.firestore() : null);

      /* BroadcastChannel */
      if (typeof BroadcastChannel !== 'undefined') {
        this._channel = new BroadcastChannel(CHANNEL + '_' + this._sessionId);
        this._channel.onmessage = e => this._handle(e.data);
      }

      /* window.onmessage (cross-window postMessage) */
      window.addEventListener('message', e => {
        if (e.data?.sessionId === this._sessionId) this._handle(e.data);
      });

      /* Firestore real-time listener */
      this._subscribeFirestore();

      return this;
    }

    on(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); return this; }
    off(type, fn) { this._handlers[type] = (this._handlers[type] || []).filter(f => f !== fn); }

    _handle(msg) {
      if (!msg || !msg.type) return;
      this._state = msg.type;
      (this._handlers[msg.type] || []).forEach(fn => { try { fn(msg); } catch {} });
      (this._handlers['*']      || []).forEach(fn => { try { fn(msg); } catch {} });
    }

    _subscribeFirestore() {
      if (!this._db || !this._sessionId) return;
      if (this._unsub) this._unsub();
      this._unsub = this._db.collection('posCustomerDisplays')
        .doc(this._sessionId)
        .onSnapshot(snap => {
          if (snap.exists) this._handle(snap.data());
        }, () => {});
    }

    destroy() {
      try { this._channel?.close(); } catch {}
      if (this._unsub) this._unsub();
    }
  }

  /* ── Public API ─────────────────────────────────────────────── */

  const sender   = new SokoniCustomerDisplay();
  const receiver = new SokoniDisplayReceiver();

  root.SokoniCustomerDisplay          = sender;
  root.SokoniCustomerDisplay.Receiver = receiver;
  root.SokoniCustomerDisplay.MSG      = MSG;
  root.SokoniCustomerDisplay.VERSION  = VERSION;

}(window));
