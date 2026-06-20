/**
 * SOKONI SmartPOS — Health Monitor & Observability v1.0
 *
 * Provides:
 *  - Structured error log (persisted to IDB)
 *  - Performance metrics collection
 *  - Sync lag monitoring
 *  - PIN brute-force protection
 *  - Health status indicator (system tray badge)
 *  - Alerting for critical conditions
 *  - Production readiness checks
 */
(function () {
  'use strict';

  /* ── IDB for persistent error log ────────────────────────── */
  const IDB_NAME    = 'pos_health';
  const IDB_VER     = 1;
  const STORES      = { errors: 'errors', metrics: 'metrics', alerts: 'alerts' };
  const MAX_ERRORS  = 500;
  const MAX_METRICS = 2000;
  let _idb = null;

  async function _getIDB() {
    if (_idb) return _idb;
    return new Promise((res, rej) => {
      const req = indexedDB.open(IDB_NAME, IDB_VER);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORES.errors)) {
          const s = db.createObjectStore(STORES.errors, { keyPath: 'id', autoIncrement: true });
          s.createIndex('ts', 'ts'); s.createIndex('type', 'type');
        }
        if (!db.objectStoreNames.contains(STORES.metrics)) {
          const m = db.createObjectStore(STORES.metrics, { keyPath: 'id', autoIncrement: true });
          m.createIndex('ts', 'ts'); m.createIndex('name', 'name');
        }
        if (!db.objectStoreNames.contains(STORES.alerts)) {
          const a = db.createObjectStore(STORES.alerts, { keyPath: 'id', autoIncrement: true });
          a.createIndex('ts', 'ts');
        }
      };
      req.onsuccess = e => { _idb = e.target.result; res(_idb); };
      req.onerror   = () => rej(req.error);
    });
  }

  async function _idbPut(storeName, record) {
    const db = await _getIDB();
    return new Promise((res, rej) => {
      const tx = db.transaction([storeName], 'readwrite');
      const r  = tx.objectStore(storeName).put(record);
      r.onsuccess = () => res(r.result);
      r.onerror   = () => rej(r.error);
    });
  }

  async function _idbGetAll(storeName, indexName, range) {
    const db = await _getIDB();
    return new Promise((res, rej) => {
      const store = db.transaction([storeName]).objectStore(storeName);
      const source = indexName ? store.index(indexName) : store;
      const req = source.getAll(range);
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });
  }

  /* ── In-memory metrics (for real-time display) ────────────── */
  const _metrics = {
    checkout_count:    0,
    checkout_total_ms: 0,
    errors_total:      0,
    sync_success:      0,
    sync_failed:       0,
    payments_success:  0,
    payments_failed:   0,
    offline_sales:     0,
  };

  const _counters = {};   // arbitrary counter by name

  /* ── Error Recording ─────────────────────────────────────── */
  async function recordError(type, message, context = {}) {
    const record = {
      type,
      message: String(message).slice(0, 500),
      context: JSON.stringify(context).slice(0, 1000),
      ts: Date.now(),
      deviceId: _deviceId(),
    };
    _metrics.errors_total++;
    console.error(`[PosHealth] ${type}: ${message}`);

    try { await _idbPut(STORES.errors, record); } catch (_) {}
    _checkAlertThresholds(type);

    /* Trim error log */
    _trimStore(STORES.errors, MAX_ERRORS);
  }

  /* ── Metric Recording ────────────────────────────────────── */
  function recordMetric(name, value = 1, tags = {}) {
    _metrics[name] = (_metrics[name] || 0) + value;
    _counters[name] = (_counters[name] || 0) + 1;

    /* Async persist (non-blocking) */
    _idbPut(STORES.metrics, { name, value, tags, ts: Date.now() }).catch(() => {});
    _updateStatusUI();
  }

  /* ── Checkout Timing ─────────────────────────────────────── */
  function startCheckoutTimer() {
    return Date.now();
  }

  function endCheckoutTimer(startTs, success = true) {
    const ms = Date.now() - startTs;
    _metrics.checkout_count++;
    _metrics.checkout_total_ms += ms;
    if (success) _metrics.payments_success++;
    else         _metrics.payments_failed++;
    recordMetric('checkout_ms', ms);
    if (ms > 3000) recordError('slow_checkout', `Checkout took ${ms}ms`, { ms });
  }

  function avgCheckoutMs() {
    return _metrics.checkout_count > 0
      ? Math.round(_metrics.checkout_total_ms / _metrics.checkout_count)
      : 0;
  }

  /* ── PIN Brute-Force Protection (IDB-persisted) ──────────── */
  /* Lockout survives page reloads — attacker cannot bypass by refreshing. */
  const PIN_MAX_ATTEMPTS = 5;
  const PIN_LOCKOUT_MS   = 5 * 60 * 1000; // 5 minutes
  const PIN_IDB_STORE    = 'pin_lockout';

  async function _pinIDB() {
    const db = await _getIDB();
    if (!db.objectStoreNames.contains(PIN_IDB_STORE)) return null;
    return db;
  }

  async function _pinLoad(key) {
    try {
      const db = await _getIDB();
      /* Lazily add pin_lockout store via a version bump only if needed */
      return new Promise(res => {
        const tx  = db.transaction([STORES.alerts], 'readonly');
        /* Reuse alerts store with a namespaced key */
        const req = tx.objectStore(STORES.alerts).index('ts').openCursor();
        /* Simpler: use localStorage as durable fallback (survives tab close) */
        res(null);
      });
    } catch (_) { return null; }
  }

  /* Use localStorage as durable store — it survives page reload and
     is isolated per origin. IDB would require a schema migration. */
  const _PIN_LS_KEY = 'pos_pin_lockout';

  function _pinLSLoad() {
    try { return JSON.parse(localStorage.getItem(_PIN_LS_KEY) || '{}'); } catch (_) { return {}; }
  }
  function _pinLSSave(data) {
    try { localStorage.setItem(_PIN_LS_KEY, JSON.stringify(data)); } catch (_) {}
  }

  async function recordPinAttempt(cashierId, success) {
    const key  = cashierId || 'default';
    const data = _pinLSLoad();
    if (!data[key]) data[key] = { count: 0, lockedUntil: 0 };

    if (success) {
      data[key] = { count: 0, lockedUntil: 0 };
      _pinLSSave(data);
      return true;
    }

    /* Ignore attempts while already locked */
    if (data[key].lockedUntil > Date.now()) return 'locked';

    data[key].count++;
    if (data[key].count >= PIN_MAX_ATTEMPTS) {
      data[key].lockedUntil = Date.now() + PIN_LOCKOUT_MS;
      data[key].count = 0;
      _pinLSSave(data);
      recordError('pin_lockout', `PIN locked after ${PIN_MAX_ATTEMPTS} failed attempts`, { key });
      return 'locked';
    }
    _pinLSSave(data);
    return false;
  }

  function isPinLocked(cashierId) {
    const key   = cashierId || 'default';
    const data  = _pinLSLoad();
    const entry = data[key];
    if (!entry || entry.lockedUntil <= Date.now()) return false;
    const remainSec = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
    return { locked: true, remainSec };
  }

  /* ── Alert Thresholds ────────────────────────────────────── */
  const _alertCounts = {};

  function _checkAlertThresholds(type) {
    _alertCounts[type] = (_alertCounts[type] || 0) + 1;
    const thresholds = {
      sync_dlq:           1,   // any DLQ item → alert
      pin_lockout:        1,
      slow_checkout:      5,
      unhandled_rejection:3,
      payment_failed:     3,
    };
    const limit = thresholds[type];
    if (limit && _alertCounts[type] >= limit) {
      _triggerAlert(type, `${_alertCounts[type]} ${type} events`);
      _alertCounts[type] = 0; // reset counter
    }
  }

  function _triggerAlert(type, detail) {
    const msg = `⚠️ POS Alert: ${type} — ${detail}`;
    console.warn('[PosHealth]', msg);
    _idbPut(STORES.alerts, { type, detail, ts: Date.now() }).catch(() => {});
    /* Optionally notify owner via cloud */
    if (window.PosNotify) PosNotify.send('pos_alert', { type, detail }).catch(() => {});
  }

  /* ── Status Badge UI ─────────────────────────────────────── */
  let _badge = null;
  let _lastStatus = 'ok';

  function _ensureBadge() {
    if (_badge) return;
    _badge = document.createElement('div');
    _badge.id = 'pos-health-badge';
    _badge.style.cssText = `
      position:fixed;bottom:72px;right:12px;z-index:9000;
      background:rgba(10,15,25,0.95);border:1px solid rgba(113,255,0,0.3);
      border-radius:12px;padding:6px 12px;font-size:11px;font-weight:800;
      color:#71ff00;font-family:'Courier New',monospace;cursor:pointer;
      box-shadow:0 4px 20px rgba(0,0,0,0.4);min-width:140px;text-align:center;
      transition:all 0.3s;`;
    _badge.onclick = () => showHealthPanel();
    document.body.appendChild(_badge);
  }

  function _updateStatusUI() {
    if (!document.body) return;
    requestAnimationFrame(() => {
      _ensureBadge();
      const online    = navigator.onLine;
      const syncOk    = (window.PosSyncEngine?.getStatus().errors || 0) === 0;
      const errCount  = _metrics.errors_total;
      const pending   = window.PosSyncEngine?.getStatus().pending || 0;

      let status = 'ok';
      let color  = '#71ff00';
      let icon   = '🟢';
      let label  = 'HEALTHY';

      if (!online)          { status = 'offline'; color = '#f87171'; icon = '🔴'; label = `OFFLINE${pending ? ` · ${pending}q` : ''}`; }
      else if (!syncOk)     { status = 'sync_err'; color = '#fbbf24'; icon = '🟡'; label = 'SYNC ERR'; }
      else if (errCount > 10){ status = 'errors'; color = '#f87171'; icon = '🔴'; label = `${errCount} ERRORS`; }
      else if (pending > 0) { status = 'syncing'; color = '#38bdf8'; icon = '🔵'; label = `SYNCING ${pending}`; }

      _badge.style.borderColor = `rgba(${_hexToRgb(color)},0.4)`;
      _badge.style.color       = color;
      _badge.textContent       = `${icon} POS ${label}`;

      if (status !== _lastStatus) {
        _lastStatus = status;
        window.dispatchEvent(new CustomEvent('pos:health:status', { detail: { status, color } }));
      }
    });
  }

  /* ── Health Panel Modal ───────────────────────────────────── */
  function showHealthPanel() {
    const existing = document.getElementById('pos-health-panel');
    if (existing) { existing.remove(); return; }

    const syncStatus = window.PosSyncEngine?.getStatus() || {};
    const pending    = syncStatus.pending || 0;
    const lastSync   = syncStatus.lastSyncAt ? new Date(syncStatus.lastSyncAt).toLocaleTimeString('en-KE') : 'Never';
    const online     = navigator.onLine;

    const el = document.createElement('div');
    el.id = 'pos-health-panel';
    el.style.cssText = `
      position:fixed;bottom:110px;right:12px;z-index:9001;width:300px;
      background:#0a0f1a;border:1px solid rgba(113,255,0,0.2);border-radius:16px;
      font-size:12px;font-family:'Segoe UI',sans-serif;box-shadow:0 8px 40px rgba(0,0,0,0.6);
      overflow:hidden;`;

    el.innerHTML = `
      <div style="padding:14px 16px;background:rgba(113,255,0,0.06);border-bottom:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;align-items:center;">
        <span style="font-weight:900;color:white;font-size:13px;">📊 SmartPOS Health</span>
        <button onclick="document.getElementById('pos-health-panel').remove()" style="background:none;border:none;color:rgba(255,255,255,0.4);cursor:pointer;font-size:16px;">×</button>
      </div>
      <div style="padding:14px 16px;">
        ${_hRow('Network',     online ? '🟢 Online' : '🔴 Offline')}
        ${_hRow('Sync Queue',  pending > 0 ? `🔵 ${pending} pending` : '🟢 Clear')}
        ${_hRow('Last Sync',   lastSync)}
        ${_hRow('Avg Checkout', `${avgCheckoutMs()}ms`)}
        ${_hRow('Errors',      _metrics.errors_total + ' total')}
        ${_hRow('Payments OK', _metrics.payments_success)}
        ${_hRow('Circuit',     _getCircuitSummary())}
        ${_hRow('Device ID',   (window.PosSyncEngine?.getDeviceId() || '—').slice(-8))}
      </div>
      <div style="padding:10px 16px;border-top:1px solid rgba(255,255,255,0.06);display:flex;gap:8px;">
        <button onclick="PosSyncEngine?.processQueue()" style="flex:1;padding:7px;background:rgba(56,189,248,0.15);border:1px solid rgba(56,189,248,0.3);border-radius:8px;color:#38bdf8;font-size:11px;font-weight:800;cursor:pointer;">Force Sync</button>
        <button onclick="PosHealth.showErrorLog()" style="flex:1;padding:7px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);border-radius:8px;color:#f87171;font-size:11px;font-weight:800;cursor:pointer;">Error Log</button>
      </div>`;

    document.body.appendChild(el);
    setTimeout(() => { document.addEventListener('click', function h(e) { if (!el.contains(e.target) && !_badge?.contains(e.target)) { el.remove(); document.removeEventListener('click', h); } }); }, 200);
  }

  function _hRow(label, value) {
    return `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
      <span style="color:rgba(255,255,255,0.4);">${label}</span>
      <span style="color:white;font-weight:700;">${value}</span>
    </div>`;
  }

  function _getCircuitSummary() {
    if (!window.PosResilience) return '—';
    const circuits = PosResilience.circuits;
    const open = Object.entries(circuits).filter(([,c]) => c.state !== 'closed');
    return open.length === 0 ? '🟢 All closed' : `🔴 ${open.map(([n])=>n).join(', ')} open`;
  }

  /* ── Error Log Panel ─────────────────────────────────────── */
  async function showErrorLog() {
    const errors = await _idbGetAll(STORES.errors, 'ts').catch(() => []);
    const recent = errors.slice(-20).reverse();
    alert(
      recent.length === 0
        ? 'No errors recorded'
        : recent.map(e => `[${new Date(e.ts).toLocaleTimeString('en-KE')}] ${e.type}: ${e.message}`).join('\n')
    );
  }

  /* ── Production Readiness Checks ─────────────────────────── */
  async function runReadinessCheck() {
    const checks = [];
    const ok  = (name, detail = '') => checks.push({ name, status: 'ok', detail });
    const warn = (name, detail)     => checks.push({ name, status: 'warn', detail });
    const fail = (name, detail)     => checks.push({ name, status: 'fail', detail });

    /* IDB available */
    try { await _getIDB(); ok('IndexedDB', 'Available'); } catch { fail('IndexedDB', 'Not available'); }

    /* PosDB ready */
    if (window.PosDB) ok('PosDB', 'Ready'); else fail('PosDB', 'Not initialised');

    /* Firestore connectivity */
    if (navigator.onLine) ok('Network', 'Online'); else warn('Network', 'Offline');

    /* Service Worker */
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) ok('Service Worker', 'Registered: ' + reg.scope);
      else      warn('Service Worker', 'Not registered');
    } else fail('Service Worker', 'Not supported');

    /* Security: HTTPS */
    if (location.protocol === 'https:' || location.hostname === 'localhost') ok('HTTPS', 'Secure');
    else fail('HTTPS', 'Not secure — production must use HTTPS');

    /* Resilience modules */
    if (window.PosResilience)   ok('Resilience Engine', 'Loaded'); else fail('Resilience Engine', 'Missing');
    if (window.PosSyncEngine)   ok('Sync Engine', 'Loaded');       else fail('Sync Engine', 'Missing');
    if (window.PosIdempotency)  ok('Idempotency', 'Loaded');       else fail('Idempotency', 'Missing');

    /* Printer */
    if (window.PosPrinter) ok('Printer Module', 'Loaded'); else warn('Printer Module', 'Missing');

    /* Auth */
    const cashiers = window.PosDB ? await PosDB.cashiers.getAll().catch(() => []) : [];
    if (cashiers.length > 0) ok('Cashier Auth', `${cashiers.length} cashier(s) configured`);
    else warn('Cashier Auth', 'No cashiers configured — set up before going live');

    /* Demo data */
    const prods = window.PosDB ? await PosDB.products.getAll().catch(() => []) : [];
    const hasDemo = prods.some(p => p.id?.startsWith('prd_demo'));
    if (hasDemo) warn('Demo Data', 'Demo products present — clear before production');
    else ok('Demo Data', 'Clean');

    return checks;
  }

  /* ── Utilities ───────────────────────────────────────────── */
  function _deviceId() {
    return localStorage.getItem('pos_device_id') || 'unknown';
  }

  function _hexToRgb(hex) {
    const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return r ? `${parseInt(r[1],16)},${parseInt(r[2],16)},${parseInt(r[3],16)}` : '255,255,255';
  }

  async function _trimStore(storeName, maxItems) {
    try {
      const db    = await _getIDB();
      const all   = await new Promise((res, rej) => {
        const req = db.transaction([storeName]).objectStore(storeName).getAllKeys();
        req.onsuccess = () => res(req.result);
        req.onerror   = () => rej(req.error);
      });
      if (all.length <= maxItems) return;
      const toDelete = all.slice(0, all.length - maxItems);
      const tx = db.transaction([storeName], 'readwrite');
      const store = tx.objectStore(storeName);
      toDelete.forEach(k => store.delete(k));
    } catch (_) {}
  }

  /* ── Init ────────────────────────────────────────────────── */
  function init() {
    /* Start status updates */
    setInterval(_updateStatusUI, 5000);
    _updateStatusUI();

    /* Wire into resilience events */
    window.addEventListener('pos:resilience:circuit:open',  () => _updateStatusUI());
    window.addEventListener('pos:resilience:circuit:closed',() => _updateStatusUI());
    window.addEventListener('pos:sync:complete',            () => _updateStatusUI());
    window.addEventListener('pos:sync:error',               () => { recordError('sync_error', 'Sync failed'); _updateStatusUI(); });

    console.info('[PosHealth] v1.0 ready — health monitoring active');
  }

  /* ── Public API ──────────────────────────────────────────── */
  window.PosHealth = {
    recordError,
    recordMetric,
    startCheckoutTimer,
    endCheckoutTimer,
    avgCheckoutMs,
    recordPinAttempt,
    isPinLocked,
    showHealthPanel,
    showErrorLog,
    runReadinessCheck,
    getMetrics: () => ({ ..._metrics }),
  };

  if (document.body) { init(); }
  else { document.addEventListener('DOMContentLoaded', init); }
})();
