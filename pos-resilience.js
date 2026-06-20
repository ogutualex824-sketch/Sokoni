/**
 * SOKONI SmartPOS — Resilience Engine v1.0
 *
 * Provides:
 *  - Circuit breaker (prevents cascading failures)
 *  - Exponential backoff retry with jitter
 *  - Online/offline detection + auto-recovery
 *  - Heartbeat monitor
 *  - Global error boundary for async operations
 */
(function () {
  'use strict';

  /* ── Configuration ────────────────────────────────────────── */
  const CFG = {
    CIRCUIT_TRIP_THRESHOLD:  5,        // failures before opening circuit
    CIRCUIT_RESET_MS:        30_000,   // how long circuit stays open
    RETRY_MAX:               6,
    RETRY_BASE_MS:           500,
    RETRY_MAX_MS:            60_000,
    HEARTBEAT_INTERVAL_MS:   30_000,
    HEALTH_ENDPOINT:         null,     // optional ping URL
    SYNC_DEBOUNCE_MS:        2_000,    // debounce for sync-on-reconnect
  };

  /* ── Circuit Breaker ──────────────────────────────────────── */
  const circuits = {};

  function _getCircuit(name) {
    if (!circuits[name]) {
      circuits[name] = { state: 'closed', failures: 0, openedAt: 0, successes: 0 };
    }
    return circuits[name];
  }

  /**
   * Execute `fn` through a named circuit breaker.
   * - Closed: normal execution
   * - Open:   throws immediately (fast fail) until reset timeout expires
   * - Half-open: allows one probe; success closes, failure re-opens
   */
  async function withCircuit(name, fn) {
    const c = _getCircuit(name);
    const now = Date.now();

    if (c.state === 'open') {
      if (now - c.openedAt < CFG.CIRCUIT_RESET_MS) {
        throw new Error(`[Circuit:${name}] Open — fast-fail`);
      }
      c.state = 'half-open';
    }

    try {
      const result = await fn();
      if (c.state === 'half-open') {
        c.state = 'closed'; c.failures = 0; c.successes = 0;
        _emit('circuit:closed', { name });
      } else {
        c.failures = 0;
      }
      return result;
    } catch (err) {
      c.failures++;
      if (c.state === 'half-open' || c.failures >= CFG.CIRCUIT_TRIP_THRESHOLD) {
        c.state = 'open'; c.openedAt = now;
        _emit('circuit:open', { name, failures: c.failures });
        console.warn(`[PosResilience] Circuit ${name} OPENED after ${c.failures} failures`);
      }
      throw err;
    }
  }

  function getCircuitState(name) { return _getCircuit(name).state; }

  /* ── Exponential Backoff Retry ────────────────────────────── */
  /**
   * Retry `fn` up to `maxRetries` times with exponential backoff + jitter.
   * `shouldRetry(err)` returns false to abort immediately (e.g. auth errors).
   */
  async function retry(fn, {
    maxRetries  = CFG.RETRY_MAX,
    baseMs      = CFG.RETRY_BASE_MS,
    maxMs       = CFG.RETRY_MAX_MS,
    shouldRetry = () => true,
    onRetry     = null,
    label       = 'op',
  } = {}) {
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (err) {
        attempt++;
        if (attempt > maxRetries || !shouldRetry(err)) throw err;
        const delay = Math.min(baseMs * Math.pow(2, attempt - 1) + Math.random() * baseMs, maxMs);
        console.warn(`[PosResilience] ${label} failed (attempt ${attempt}/${maxRetries}), retry in ${Math.round(delay)}ms:`, err.message);
        if (onRetry) onRetry({ attempt, err, delay });
        await _sleep(delay);
      }
    }
  }

  /* ── Online / Offline Detection ───────────────────────────── */
  let _isOnline = navigator.onLine;
  let _syncDebounceTimer = null;
  const _listeners = {};

  window.addEventListener('online',  () => _handleOnlineChange(true));
  window.addEventListener('offline', () => _handleOnlineChange(false));

  function _handleOnlineChange(online) {
    const wasOnline = _isOnline;
    _isOnline = online;

    if (online && !wasOnline) {
      console.info('[PosResilience] Network restored — scheduling sync');
      _emit('network:online');
      clearTimeout(_syncDebounceTimer);
      _syncDebounceTimer = setTimeout(() => {
        _emit('sync:trigger', { reason: 'reconnect' });
        if (window.PosSyncEngine) PosSyncEngine.processQueue().catch(console.error);
      }, CFG.SYNC_DEBOUNCE_MS);

      _toast('🟢 Back online — syncing...', 'success');
    } else if (!online && wasOnline) {
      console.warn('[PosResilience] Network lost — entering offline mode');
      _emit('network:offline');
      _toast('🔴 Offline — transactions saved locally', 'warning');
    }
  }

  function isOnline() { return _isOnline; }

  /* ── Event Bus (lightweight) ──────────────────────────────── */
  function _emit(event, data = {}) {
    const handlers = _listeners[event] || [];
    handlers.forEach(h => { try { h(data); } catch (_) {} });
    window.dispatchEvent(new CustomEvent('pos:resilience:' + event, { detail: data }));
  }

  function on(event, handler) {
    if (!_listeners[event]) _listeners[event] = [];
    _listeners[event].push(handler);
    return () => { _listeners[event] = _listeners[event].filter(h => h !== handler); };
  }

  /* ── Heartbeat ────────────────────────────────────────────── */
  let _hbTimer = null;
  let _hbMissed = 0;

  function startHeartbeat() {
    if (_hbTimer) return;
    _hbTimer = setInterval(async () => {
      if (!_isOnline) { _hbMissed = 0; return; }
      try {
        if (CFG.HEALTH_ENDPOINT) {
          await fetch(CFG.HEALTH_ENDPOINT, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(5000) });
        }
        if (_hbMissed > 0) {
          _emit('heartbeat:recovered', { missed: _hbMissed });
          _hbMissed = 0;
        }
        _emit('heartbeat:ok');
      } catch (_) {
        _hbMissed++;
        _emit('heartbeat:missed', { count: _hbMissed });
        if (_hbMissed >= 3) {
          console.warn('[PosResilience] Heartbeat missed ' + _hbMissed + 'x — possible connectivity issue');
        }
      }
    }, CFG.HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeat() {
    clearInterval(_hbTimer);
    _hbTimer = null;
  }

  /* ── Global Async Error Boundary ──────────────────────────── */
  window.addEventListener('unhandledrejection', ev => {
    const err = ev.reason;
    console.error('[PosResilience] Unhandled rejection:', err);
    _emit('error:unhandled', { message: err?.message || String(err), stack: err?.stack });
    if (window.PosHealth) PosHealth.recordError('unhandled_rejection', err?.message || String(err));
  });

  /* ── Atomic IDB Multi-Store Transaction Helper ────────────── */
  /**
   * Execute multiple IDB operations in a single IDB transaction.
   * ALL writes succeed or ALL fail — true atomicity at the IDB level.
   *
   * Usage:
   *   await PosResilience.atomicWrite(db, ['products','transactions'], tx => {
   *     tx.objectStore('transactions').put(txnRecord);
   *     tx.objectStore('products').put(updatedProduct);
   *   });
   */
  function atomicWrite(idbDatabase, storeNames, operationsFn) {
    return new Promise((resolve, reject) => {
      const tx = idbDatabase.transaction(storeNames, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
      tx.onabort    = () => reject(new Error('IDB transaction aborted'));
      try {
        operationsFn(tx);
      } catch (err) {
        tx.abort();
        reject(err);
      }
    });
  }

  /* ── Idempotency Lock ─────────────────────────────────────── */
  const _activeLocks = new Set();

  /**
   * Acquire a lock by key. Returns false if already locked.
   * Automatically releases after `timeoutMs`.
   */
  function acquireLock(key, timeoutMs = 30_000) {
    if (_activeLocks.has(key)) return false;
    _activeLocks.add(key);
    setTimeout(() => _activeLocks.delete(key), timeoutMs);
    return true;
  }

  function releaseLock(key) { _activeLocks.delete(key); }
  function isLocked(key)    { return _activeLocks.has(key); }

  /* ── Utilities ────────────────────────────────────────────── */
  function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function _toast(msg, type = 'info') {
    if (window._skToast) { window._skToast(msg, type); return; }
    if (window.SPos?.toast) SPos.toast(msg, type);
  }

  /* ── Degraded Mode ────────────────────────────────────────── */
  let _degraded = false;

  function enterDegradedMode(reason) {
    if (_degraded) return;
    _degraded = true;
    console.warn('[PosResilience] Entering degraded mode:', reason);
    _emit('mode:degraded', { reason });
    _toast('⚠️ Running in offline-only mode: ' + reason, 'warning');
  }

  function exitDegradedMode() {
    if (!_degraded) return;
    _degraded = false;
    _emit('mode:restored');
    _toast('✅ Full connectivity restored', 'success');
  }

  function isDegraded() { return _degraded; }

  /* ── Public API ───────────────────────────────────────────── */
  window.PosResilience = {
    withCircuit,
    getCircuitState,
    retry,
    isOnline,
    on,
    startHeartbeat,
    stopHeartbeat,
    atomicWrite,
    acquireLock,
    releaseLock,
    isLocked,
    enterDegradedMode,
    exitDegradedMode,
    isDegraded,
    circuits,
    config: CFG,
  };

  /* Auto-start heartbeat */
  startHeartbeat();
  console.info('[PosResilience] v1.0 ready — circuit breakers active, heartbeat started');
})();
