/* ================================================================
   SOKONI — Universal Cash Drawer SDK v1.0
   sokoni-cash-drawer.js

   Single authority for all cash drawer operations across SOKONI SmartPOS.

   Supported connection paths:
     1. ESC/POS via receipt printer   — SokoniPrinter.openCashDrawer()
     2. USB HID                       — Web HID API (navigator.hid)
     3. Web Serial / RS-232           — Web Serial API (navigator.serial)
     4. Ethernet / TCP-IP             — HTTP POST to configured endpoint
     5. Web Bluetooth                 — Web Bluetooth API (navigator.bluetooth)

   Public API: window.CashDrawer
     init(storeCtx)              — initialise with store context
     openAfterSale(context)      — auto-open after cash/mixed payment
     openManual(context)         — manual open (role + optional manager auth)
     openRaw(context)            — direct open with no auth gate (admin use)
     testOpen(context)           — diagnostics test
     recordCashEvent(type, amt, ctx) — cash in/out/safe drop/pickup/float
     getDiagnostics()            — live diagnostics object
     getAuditLog(limit)          — recent open events from IndexedDB
     getShiftSummary()           — expected cash position for this shift
     resetShift()                — clear shift counters (call on shift close)
     getConfig() / setConfig()   — read / update drawer configuration
     syncQueue()                 — force offline queue flush
     on(event, fn) / off(...)    — event subscriptions

   Events emitted: 'open', 'error', 'config', 'cash_event'
================================================================ */
'use strict';

(function (root) {

  /* ── ESC/POS drawer kick sequences ────────────────────────────────── */
  const DRAWER_CMD = {
    pin2: new Uint8Array([0x1B, 0x70, 0x00, 0x19, 0xFA]),  // DK1 — most common
    pin5: new Uint8Array([0x1B, 0x70, 0x01, 0x19, 0xFA]),  // DK2 — alternate pin
  };

  /* ── Event type constants ──────────────────────────────────────────── */
  const EVENT = {
    SALE:          'sale',
    SPLIT_CASH:    'split_cash',
    MANUAL:        'manual',
    SHIFT_OPEN:    'shift_open',
    SHIFT_CLOSE:   'shift_close',
    CASH_IN:       'cash_in',
    CASH_OUT:      'cash_out',
    SAFE_DROP:     'safe_drop',
    CASH_PICKUP:   'cash_pickup',
    OPENING_FLOAT: 'opening_float',
    CLOSING_FLOAT: 'closing_float',
    REFUND:        'refund',
    EXCHANGE:      'exchange',
    TEST:          'test',
  };

  /* ── Default configuration ─────────────────────────────────────────── */
  const DEFAULT_CONFIG = {
    openMode:        'after_receipt', // after_payment|after_receipt|before_receipt|manual_only|never
    connectionType:  'printer',       // printer|usb|serial|ethernet|bluetooth
    drawerPin:       'pin2',          // pin2|pin5
    requireManager:  false,
    allowedRoles:    ['admin', 'superAdmin', 'manager', 'supervisor', 'cashier'],
    ethernetHost:    '',
    ethernetPort:    9100,
    ethernetTimeout: 3000,
    openOnCashOnly:  true,            // skip drawer for card/M-Pesa-only sales
  };

  /* ── IndexedDB schema ──────────────────────────────────────────────── */
  const DB_NAME    = 'sokoni_drawer_v1';
  const DB_VER     = 1;
  const ST_QUEUE   = 'queue';
  const ST_CONFIG  = 'config';
  const ST_HISTORY = 'history';
  const ST_SHIFT   = 'shift';
  const ST_DEVICE  = 'device';  // persisted device handles (USB/Serial)

  let _idb = null;

  async function _openIDB() {
    if (_idb) return _idb;
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        [ST_QUEUE, ST_CONFIG, ST_HISTORY, ST_SHIFT, ST_DEVICE].forEach(name => {
          const kp = (name === ST_CONFIG || name === ST_SHIFT || name === ST_DEVICE) ? 'key' : undefined;
          if (!d.objectStoreNames.contains(name))
            d.createObjectStore(name, kp ? { keyPath: kp } : { autoIncrement: true });
        });
      };
      req.onsuccess = e => { _idb = e.target.result; res(_idb); };
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function _dbGet(st, key) {
    const d = await _openIDB();
    return new Promise((res, rej) => {
      const r = d.transaction(st, 'readonly').objectStore(st).get(key);
      r.onsuccess = () => res(r.result);
      r.onerror   = e => rej(e.target.error);
    });
  }

  async function _dbPut(st, val, key) {
    const d = await _openIDB();
    return new Promise((res, rej) => {
      const store = d.transaction(st, 'readwrite').objectStore(st);
      const r = (key !== undefined) ? store.put(val, key) : store.put(val);
      r.onsuccess = () => res(r.result);
      r.onerror   = e => rej(e.target.error);
    });
  }

  async function _dbGetAll(st) {
    const d = await _openIDB();
    return new Promise((res, rej) => {
      const r = d.transaction(st, 'readonly').objectStore(st).getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror   = e => rej(e.target.error);
    });
  }

  async function _dbDelete(st, key) {
    const d = await _openIDB();
    return new Promise((res, rej) => {
      const r = d.transaction(st, 'readwrite').objectStore(st).delete(key);
      r.onsuccess = () => res();
      r.onerror   = e => rej(e.target.error);
    });
  }

  /* ── Module state ──────────────────────────────────────────────────── */
  let _cfg       = { ...DEFAULT_CONFIG };
  let _ctx       = { merchantId: null, branchId: null, registerId: null, cashierId: null, cashierName: null, role: null };
  let _lastOpen  = null;
  let _openCount = 0;
  let _listeners = {};
  let _syncing   = false;
  let _usbDevice = null;   // cached USB HID device
  let _serialPort= null;   // cached Web Serial port

  /* ── Event emitter ─────────────────────────────────────────────────── */
  const _emit = (ev, data) => (_listeners[ev] || []).forEach(fn => { try { fn(data); } catch (_) {} });

  /* ── Config ─────────────────────────────────────────────────────────── */
  async function _loadConfig() {
    const saved = await _dbGet(ST_CONFIG, 'config');
    if (saved) _cfg = { ...DEFAULT_CONFIG, ...saved.value };
  }

  async function _saveConfig() {
    await _dbPut(ST_CONFIG, { key: 'config', value: { ..._cfg } });
  }

  /* ── Hardware adapters ──────────────────────────────────────────────── */

  async function _viaPrinter() {
    if (!root.SokoniPrinter) throw new Error('SokoniPrinter not loaded');
    if (!root.SokoniPrinter.connected) throw new Error('Printer not connected — connect a receipt printer first');
    await root.SokoniPrinter.openCashDrawer();
  }

  async function _viaUSB() {
    if (!navigator.hid) throw new Error('Web HID is not supported in this browser');
    if (!_usbDevice || !_usbDevice.opened) {
      const paired = await navigator.hid.getDevices();
      _usbDevice = paired.find(d => !d.opened) || paired[0];
      if (!_usbDevice) {
        const results = await navigator.hid.requestDevice({ filters: [] });
        _usbDevice = results[0];
      }
    }
    if (!_usbDevice) throw new Error('No USB HID cash drawer selected');
    if (!_usbDevice.opened) await _usbDevice.open();
    const cmd = DRAWER_CMD[_cfg.drawerPin] || DRAWER_CMD.pin2;
    await _usbDevice.sendReport(0, cmd);
  }

  async function _viaSerial() {
    if (!navigator.serial) throw new Error('Web Serial is not supported in this browser');
    if (!_serialPort) {
      const ports = await navigator.serial.getPorts();
      _serialPort = ports[0] || await navigator.serial.requestPort();
    }
    if (!_serialPort) throw new Error('No serial port selected');
    if (!_serialPort.readable) {
      await _serialPort.open({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' });
    }
    const writer = _serialPort.writable.getWriter();
    try {
      await writer.write(DRAWER_CMD[_cfg.drawerPin] || DRAWER_CMD.pin2);
    } finally {
      writer.releaseLock();
    }
  }

  async function _viaEthernet() {
    const host = _cfg.ethernetHost;
    if (!host) throw new Error('Ethernet cash drawer host not configured — set ethernetHost in drawer config');
    const port = _cfg.ethernetPort || 9100;
    const url  = `http://${host}:${port}/drawer`;
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), _cfg.ethernetTimeout || 3000);
    try {
      const r = await fetch(url, {
        method: 'POST',
        body:   DRAWER_CMD[_cfg.drawerPin] || DRAWER_CMD.pin2,
        headers: { 'Content-Type': 'application/octet-stream' },
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status} from cash drawer`);
    } finally {
      clearTimeout(t);
    }
  }

  async function _viaBluetooth() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth is not supported in this browser');
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: ['000018f0-0000-1000-8000-00805f9b34fb'],
    });
    const server = await device.gatt.connect();
    const services = await server.getPrimaryServices();
    const cmd = DRAWER_CMD[_cfg.drawerPin] || DRAWER_CMD.pin2;
    let sent = false;
    for (const svc of services) {
      if (sent) break;
      try {
        const chars = await svc.getCharacteristics();
        for (const c of chars) {
          if (c.properties.writeWithoutResponse || c.properties.write) {
            if (c.properties.writeWithoutResponse) await c.writeValueWithoutResponse(cmd);
            else await c.writeValueWithResponse(cmd);
            sent = true;
            break;
          }
        }
      } catch (_) {}
    }
    device.gatt.disconnect();
    if (!sent) throw new Error('No writable Bluetooth characteristic found on this device');
  }

  async function _kick() {
    const type = _cfg.connectionType || 'printer';
    switch (type) {
      case 'printer':   return _viaPrinter();
      case 'usb':       return _viaUSB();
      case 'serial':    return _viaSerial();
      case 'ethernet':  return _viaEthernet();
      case 'bluetooth': return _viaBluetooth();
      default: throw new Error(`Unsupported cash drawer connection type: "${type}"`);
    }
  }

  /* ── Audit logging ─────────────────────────────────────────────────── */
  function _buildCtx(ctx = {}) {
    return {
      merchantId:  ctx.merchantId  || _ctx.merchantId,
      branchId:    ctx.branchId    || _ctx.branchId,
      registerId:  ctx.registerId  || _ctx.registerId,
      cashierId:   ctx.cashierId   || _ctx.cashierId,
      cashierName: ctx.cashierName || _ctx.cashierName,
      role:        ctx.role        || _ctx.role,
      shiftId:     ctx.shiftId     || null,
      receiptNo:   ctx.receiptNo   || null,
      amount:      ctx.amount      || null,
      reason:      ctx.reason      || null,
    };
  }

  async function _log(type, ctx, outcome, error) {
    const entry = {
      type, outcome,
      error: error ? (error.message || String(error)) : null,
      ts: Date.now(),
      synced: false,
      ..._buildCtx(ctx),
    };
    await _dbPut(ST_HISTORY, entry);

    if (navigator.onLine) {
      try { await _syncEntry('cdOpenDrawer', entry); entry.synced = true; }
      catch (_) { await _dbPut(ST_QUEUE, { ...entry, _cfn: 'cdOpenDrawer' }); }
    } else {
      await _dbPut(ST_QUEUE, { ...entry, _cfn: 'cdOpenDrawer' });
    }
    return entry;
  }

  async function _syncEntry(cfName, data) {
    if (!root.firebase) return;
    const fn = root.firebase.functions().httpsCallable(cfName);
    await fn(data);
  }

  async function _syncQueue() {
    if (_syncing || !navigator.onLine || !root.firebase) return;
    _syncing = true;
    try {
      const items = await _dbGetAll(ST_QUEUE);
      for (const item of items) {
        try {
          const cfn = item._cfn || 'cdOpenDrawer';
          const { _cfn, ...payload } = item;
          await _syncEntry(cfn, payload);
          if (typeof item === 'object' && !Array.isArray(item)) {
            const all = await _dbGetAll(ST_QUEUE);
            const idx = all.findIndex(a => a.ts === item.ts && a.type === item.type);
            if (idx >= 0) {
              const d = await _openIDB();
              const keys = await new Promise((res, rej) => {
                const r = d.transaction(ST_QUEUE, 'readonly').objectStore(ST_QUEUE).getAllKeys();
                r.onsuccess = () => res(r.result);
                r.onerror   = e => rej(e.target.error);
              });
              if (keys[idx] !== undefined) await _dbDelete(ST_QUEUE, keys[idx]);
            }
          }
        } catch (_) { break; }
      }
    } finally {
      _syncing = false;
    }
  }

  /* ── Shift cash counters ───────────────────────────────────────────── */
  async function _getShift() {
    const s = await _dbGet(ST_SHIFT, 'current');
    return s?.value || { openingFloat: 0, cashSales: 0, cashIn: 0, cashOut: 0, safeDrop: 0, cashPickup: 0, closingFloat: null };
  }

  async function _patchShift(fn) {
    const current = await _getShift();
    const updated = fn(current);
    await _dbPut(ST_SHIFT, { key: 'current', value: updated });
    return updated;
  }

  /* ── Core open ─────────────────────────────────────────────────────── */
  async function _open(type, ctx) {
    const t0 = Date.now();
    let outcome = 'success', error = null;
    try {
      await _kick();
      _lastOpen  = Date.now();
      _openCount++;
      _emit('open', { type, ctx, elapsed: Date.now() - t0 });
    } catch (err) {
      outcome = 'failed';
      error   = err;
      _emit('error', { type, ctx, error: err, message: err.message });
      console.warn('[CashDrawer] Open failed:', err.message);
      // Never interrupt the sale — failure is logged but non-blocking
    }
    await _log(type, ctx, outcome, error);
    return { success: outcome === 'success', elapsed: Date.now() - t0, error: error?.message || null };
  }

  /* ── Public API ────────────────────────────────────────────────────── */
  const CashDrawer = {

    EVENT,

    async init(storeCtx = {}) {
      _ctx = { ..._ctx, ...storeCtx };
      await _loadConfig();
      root.addEventListener('online', () => _syncQueue().catch(() => {}));
      _syncQueue().catch(() => {});
      return this;
    },

    getConfig() { return { ..._cfg }; },

    async setConfig(patch = {}) {
      _cfg = { ..._cfg, ...patch };
      await _saveConfig();
      _emit('config', { ..._cfg });
      return this;
    },

    on(ev, fn)  { (_listeners[ev] = _listeners[ev] || []).push(fn); return this; },
    off(ev, fn) {
      if (_listeners[ev]) _listeners[ev] = _listeners[ev].filter(f => f !== fn);
      return this;
    },

    /* Called after a successful sale. Respects openMode and openOnCashOnly. */
    async openAfterSale(ctx = {}) {
      const mode = _cfg.openMode;
      if (mode === 'manual_only' || mode === 'never') return { skipped: true, reason: mode };

      if (_cfg.openOnCashOnly) {
        const hasCash = Array.isArray(ctx.payments)
          ? ctx.payments.some(p => p.method === 'cash' && (p.amount || 0) > 0)
          : ctx.method === 'cash';
        if (!hasCash) return { skipped: true, reason: 'no_cash_component' };
      }

      // Track cash sales total for shift reconciliation
      const cashAmt = Array.isArray(ctx.payments)
        ? ctx.payments.filter(p => p.method === 'cash').reduce((s, p) => s + (p.amount || 0), 0)
        : (ctx.amount || 0);
      if (cashAmt > 0) {
        await _patchShift(s => ({ ...s, cashSales: (s.cashSales || 0) + cashAmt }));
      }

      return _open(EVENT.SALE, { ...ctx, reason: 'cash_sale' });
    },

    /* Called from the "Open Drawer" button. Checks role and optional manager auth. */
    async openManual(ctx = {}) {
      const role = ctx.role || _ctx.role || 'cashier';
      if (_cfg.requireManager || ctx.forceAuth) {
        if (root.ManagerAuth) {
          const ok = await root.ManagerAuth.request('cash_drawer', {
            cashierId: ctx.cashierId || _ctx.cashierId,
            reason: ctx.reason || 'Manual drawer open',
          });
          if (!ok) return { skipped: true, reason: 'auth_denied' };
        }
      } else {
        if (!_cfg.allowedRoles.includes(role)) return { skipped: true, reason: 'role_not_permitted' };
      }
      return _open(EVENT.MANUAL, { ...ctx, reason: ctx.reason || 'manual' });
    },

    /* Raw open — admin-only, no auth gate. */
    async openRaw(ctx = {}) {
      return _open(EVENT.MANUAL, { ...ctx, reason: ctx.reason || 'raw_open' });
    },

    /* Diagnostics test. */
    async testOpen(ctx = {}) {
      return _open(EVENT.TEST, { ...ctx, reason: 'test' });
    },

    /* Record a till event (cash in/out/safe drop/pickup/float). */
    async recordCashEvent(type, amount, ctx = {}) {
      const knownTypes = Object.values(EVENT);
      if (!knownTypes.includes(type)) throw new Error(`Unknown cash event type: "${type}"`);

      // Update shift counters
      await _patchShift(s => {
        const n = { ...s };
        if (type === EVENT.OPENING_FLOAT) n.openingFloat  = amount;
        if (type === EVENT.CLOSING_FLOAT) n.closingFloat  = amount;
        if (type === EVENT.CASH_IN)       n.cashIn        = (s.cashIn  || 0) + amount;
        if (type === EVENT.CASH_OUT)      n.cashOut       = (s.cashOut || 0) + amount;
        if (type === EVENT.SAFE_DROP)     n.safeDrop      = (s.safeDrop    || 0) + amount;
        if (type === EVENT.CASH_PICKUP)   n.cashPickup    = (s.cashPickup  || 0) + amount;
        return n;
      });

      const entry = {
        type, amount,
        ts: Date.now(),
        synced: false,
        ..._buildCtx(ctx),
        note: ctx.note || null,
      };

      if (navigator.onLine && root.firebase) {
        try { await _syncEntry('cdRecordCashEvent', entry); entry.synced = true; }
        catch (_) { await _dbPut(ST_QUEUE, { ...entry, _cfn: 'cdRecordCashEvent' }); }
      } else {
        await _dbPut(ST_QUEUE, { ...entry, _cfn: 'cdRecordCashEvent' });
      }

      _emit('cash_event', { type, amount, ctx: entry });
      return entry;
    },

    /* Live diagnostics. */
    async getDiagnostics() {
      const [history, queue] = await Promise.all([_dbGetAll(ST_HISTORY), _dbGetAll(ST_QUEUE)]);
      const sorted = history.sort((a, b) => b.ts - a.ts);
      return {
        connectionType:   _cfg.connectionType,
        drawerPin:        _cfg.drawerPin,
        openMode:         _cfg.openMode,
        printerConnected: !!(root.SokoniPrinter?.connected),
        drawerReady:      _cfg.connectionType === 'printer' ? !!(root.SokoniPrinter?.connected) : true,
        lastOpen:         sorted.find(h => h.type !== EVENT.TEST && h.outcome === 'success')?.ts || null,
        lastAttempt:      sorted[0]?.ts || null,
        sessionOpenCount: _openCount,
        pendingSync:      queue.length,
        recentErrors:     sorted.filter(h => h.outcome === 'failed').slice(0, 10),
        config:           { ..._cfg },
        browserSupport:   {
          webHID:       'hid'       in navigator,
          webSerial:    'serial'    in navigator,
          webBluetooth: 'bluetooth' in navigator,
        },
      };
    },

    /* Local audit log (IndexedDB). */
    async getAuditLog(limit = 50) {
      const all = await _dbGetAll(ST_HISTORY);
      return all.sort((a, b) => b.ts - a.ts).slice(0, limit);
    },

    /* Expected cash in drawer at this point in the shift. */
    async getShiftSummary() {
      const s = await _getShift();
      const expected = (s.openingFloat || 0)
        + (s.cashSales   || 0)
        + (s.cashIn      || 0)
        - (s.cashOut     || 0)
        - (s.safeDrop    || 0)
        + (s.cashPickup  || 0);
      return { ...s, expectedCash: Math.round(expected * 100) / 100 };
    },

    /* Reset shift counters after closing a shift. */
    async resetShift() {
      await _dbPut(ST_SHIFT, { key: 'current', value: {
        openingFloat: 0, cashSales: 0, cashIn: 0, cashOut: 0, safeDrop: 0, cashPickup: 0, closingFloat: null,
      }});
    },

    /* Force flush the offline queue. */
    async syncQueue() { return _syncQueue(); },

    /* Update store context (called from pos-checkout.html when cashier info loads). */
    updateContext(patch = {}) {
      _ctx = { ..._ctx, ...patch };
    },

    get lastOpen()  { return _lastOpen; },
    get openCount() { return _openCount; },
  };

  root.CashDrawer = CashDrawer;

})(window);
