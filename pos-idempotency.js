/**
 * SOKONI SmartPOS — Idempotency & Transaction Safety v1.0
 *
 * Guarantees:
 *  - Every sale has a globally unique, collision-resistant ID
 *  - Double-submit prevention (button lock + in-flight tracking)
 *  - Duplicate transaction detection (IDB idempotency store)
 *  - Safe re-submission after network failure
 *  - Atomic saga pattern for payment.complete()
 */
(function () {
  'use strict';

  /* ── Unique ID Generation ──────────────────────────────────── */
  /* Format: {device-prefix}-{timestamp-base36}-{random-8hex}
     Uses Web Crypto CSPRNG — cryptographically unpredictable IDs */
  function generateTxnId() {
    const device  = _devicePrefix();
    const ts      = Date.now().toString(36).toUpperCase();
    const bytes   = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    const rand    = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    return `TXN-${device}-${ts}-${rand}`;
  }

  function generateReceiptNo(prefix = 'R') {
    const ts    = Date.now().toString(36).toUpperCase().slice(-6);
    const bytes = new Uint8Array(2);
    crypto.getRandomValues(bytes);
    const rand  = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').slice(0, 3).toUpperCase();
    return `${prefix}${ts}${rand}`;
  }

  function _devicePrefix() {
    const raw = localStorage.getItem('pos_device_id') || 'D0';
    return raw.slice(-4).toUpperCase().replace(/[^A-Z0-9]/g, 'X');
  }

  /* ── In-Flight Transaction Lock ───────────────────────────── */
  const _inFlight = new Map();  // txnId → { startedAt, timeout }

  function lockTransaction(txnId, timeoutMs = 60_000) {
    if (_inFlight.has(txnId)) return false;
    const timer = setTimeout(() => _inFlight.delete(txnId), timeoutMs);
    _inFlight.set(txnId, { startedAt: Date.now(), timer });
    return true;
  }

  function unlockTransaction(txnId) {
    const entry = _inFlight.get(txnId);
    if (entry) { clearTimeout(entry.timer); _inFlight.delete(txnId); }
  }

  function isInflight(txnId) { return _inFlight.has(txnId); }

  /* ── UI Button Lock ───────────────────────────────────────── */
  let _payBtnLocked = false;
  let _payBtnTimer  = null;

  function lockPayButton(label = 'Processing…', timeoutMs = 30_000) {
    const btn = document.getElementById('pay-btn');
    if (!btn || _payBtnLocked) return false;
    _payBtnLocked = true;
    btn.disabled = true;
    btn._originalLabel = btn.textContent;
    btn.textContent = label;
    btn.style.opacity = '0.65';
    _payBtnTimer = setTimeout(() => unlockPayButton(), timeoutMs);
    return true;
  }

  function unlockPayButton() {
    clearTimeout(_payBtnTimer);
    _payBtnLocked = false;
    const btn = document.getElementById('pay-btn');
    if (btn) {
      btn.disabled = false;
      if (btn._originalLabel) btn.textContent = btn._originalLabel;
      btn.style.opacity = '';
    }
  }

  function isPayButtonLocked() { return _payBtnLocked; }

  /* ── IDB Idempotency Store ────────────────────────────────── */
  /* Records recently completed transactions to detect duplicates.
     Key: receiptNo. TTL: 48 hours. */
  const IDB_STORE    = 'idempotency_keys';
  const KEY_TTL_MS   = 48 * 3600 * 1000;
  let   _idb         = null;
  const _localCache  = new Map();  // fast in-memory check

  async function _getIDB() {
    if (_idb) return _idb;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('pos_idempotency', 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          const store = db.createObjectStore(IDB_STORE, { keyPath: 'key' });
          store.createIndex('expiresAt', 'expiresAt');
        }
      };
      req.onsuccess = e => { _idb = e.target.result; resolve(_idb); };
      req.onerror   = () => reject(req.error);
    });
  }

  async function recordKey(key, metadata = {}) {
    _localCache.set(key, Date.now());
    try {
      const db = await _getIDB();
      const tx = db.transaction([IDB_STORE], 'readwrite');
      tx.objectStore(IDB_STORE).put({
        key,
        createdAt: Date.now(),
        expiresAt: Date.now() + KEY_TTL_MS,
        ...metadata,
      });
    } catch (_) { /* non-critical */ }
  }

  async function hasKey(key) {
    if (_localCache.has(key)) return true;
    try {
      const db = await _getIDB();
      return new Promise(res => {
        const req = db.transaction([IDB_STORE]).objectStore(IDB_STORE).get(key);
        req.onsuccess = () => {
          const rec = req.result;
          if (rec && rec.expiresAt > Date.now()) { _localCache.set(key, Date.now()); res(true); }
          else res(false);
        };
        req.onerror = () => res(false);
      });
    } catch (_) { return false; }
  }

  async function purgeExpired() {
    try {
      const db   = await _getIDB();
      const tx   = db.transaction([IDB_STORE], 'readwrite');
      const store= tx.objectStore(IDB_STORE);
      const now  = Date.now();
      const range= IDBKeyRange.upperBound(now);
      const req  = store.index('expiresAt').openCursor(range);
      req.onsuccess = e => {
        const cursor = e.target.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
      // Also purge in-memory cache
      for (const [k, ts] of _localCache) {
        if (Date.now() - ts > KEY_TTL_MS) _localCache.delete(k);
      }
    } catch (_) {}
  }

  /* ── Saga Pattern for payment.complete() ─────────────────── */
  /**
   * Execute payment as a saga with compensating transactions.
   * Each step registers a compensate function.
   * If any step fails, all completed steps are rolled back in reverse.
   */
  class Saga {
    constructor(name) {
      this.name         = name;
      this._steps       = [];
      this._completed   = [];
      this._failed      = false;
    }

    /** Register a step: { execute: async fn, compensate: async fn, name: string } */
    step(stepDef) { this._steps.push(stepDef); return this; }

    async run() {
      for (const step of this._steps) {
        try {
          const result = await step.execute();
          this._completed.push({ step, result });
        } catch (err) {
          this._failed = true;
          console.error(`[PosSaga:${this.name}] Step "${step.name}" failed:`, err);
          await this._compensate();
          throw Object.assign(err, { sagaStep: step.name });
        }
      }
      return this._completed.map(c => c.result);
    }

    async _compensate() {
      console.warn(`[PosSaga:${this.name}] Compensating ${this._completed.length} step(s)...`);
      const reversed = [...this._completed].reverse();
      for (const { step } of reversed) {
        if (step.compensate) {
          try { await step.compensate(); }
          catch (err) { console.error(`[PosSaga:${this.name}] Compensation failed for "${step.name}":`, err); }
        }
      }
    }

    get failed() { return this._failed; }
  }

  /* ── Scheduled purge ─────────────────────────────────────── */
  setInterval(purgeExpired, 3600_000); // hourly
  purgeExpired(); // run once at startup

  /* ── Public API ─────────────────────────────────────────── */
  window.PosIdempotency = {
    generateTxnId,
    generateReceiptNo,
    lockTransaction,
    unlockTransaction,
    isInflight,
    lockPayButton,
    unlockPayButton,
    isPayButtonLocked,
    recordKey,
    hasKey,
    purgeExpired,
    Saga,
  };

  console.info('[PosIdempotency] v1.0 ready');
})();
