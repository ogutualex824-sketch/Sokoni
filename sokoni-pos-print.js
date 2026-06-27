/* ================================================================
   SOKONI Universal POS Print Engine v2.0
   Offline-first multi-transport, multi-driver receipt + label system
   Supports: Bluetooth BLE/Classic, USB OTG/HID/Serial, Wi-Fi/LAN,
             Ethernet, Windows, Network, Android native, Browser fallback
================================================================ */
/* global SokoniPrinterDrivers, SokoniPrinterDiscovery, SokoniReceiptEngine, PosPrinter */
window.SokoniPosprint = (() => {
  'use strict';

  /* ── Constants ── */
  const DB_NAME       = 'sokoni_pos_print_v2';
  const STORE_PRINTERS= 'printers';
  const STORE_QUEUE   = 'print_queue';
  const SETTINGS_KEY  = 'sokoni_print_settings_v3';
  const MAX_RETRIES   = 5;
  const CHUNK_MS      = 20;   /* inter-chunk delay for BLE */

  /* ── Default settings ── */
  const DEFAULTS = {
    defaultPrinterId: null,
    paperWidth: 80,
    copies: 1,
    autoCut: true,
    openDrawerOnSale: false,
    darkness: 8,
    fontSize: 'normal',
    logoBase64: null,
    showQR: true,
    showBarcode: false,
    margins: { top: 0, bottom: 30 },
    autoReconnect: true,
    printQueue: true,
    shopName: '',
    shopAddress: '',
    shopPhone: '',
    shopPin: '',
    taxRate: 16,
    footerMessage: 'Thank you for shopping with us!',
  };

  /* ── State ── */
  let _db            = null;
  let _settings      = null;
  let _connections   = {};   /* id → { transport, status } */
  let _listeners     = {};   /* event → [fn] */
  let _draining      = false;

  /* ── UUID ── */
  const uuid = () => {
    try { return crypto.randomUUID(); } catch (_) {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
    }
  };

  /* ── Event emitter ── */
  function on(event, fn)  { (_listeners[event] = _listeners[event] || []).push(fn); }
  function off(event, fn) { if (_listeners[event]) _listeners[event] = _listeners[event].filter(f => f !== fn); }
  function emit(event, data) {
    (_listeners[event] || []).forEach(fn => { try { fn(data); } catch (_) {} });
  }

  /* ── IndexedDB helpers ── */
  async function _openDB() {
    if (_db) return _db;
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_PRINTERS)) {
          db.createObjectStore(STORE_PRINTERS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_QUEUE)) {
          const qs = db.createObjectStore(STORE_QUEUE, { keyPath: 'id' });
          qs.createIndex('status', 'status', { unique: false });
          qs.createIndex('printerId', 'printerId', { unique: false });
        }
      };
      req.onsuccess = e => { _db = e.target.result; res(_db); };
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function _dbGet(store, id) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(id);
      req.onsuccess = () => res(req.result);
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function _dbGetAll(store) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function _dbPut(store, record) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const tx  = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).put(record);
      req.onsuccess = () => res(req.result);
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function _dbDelete(store, id) {
    const db = await _openDB();
    return new Promise((res, rej) => {
      const tx  = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).delete(id);
      req.onsuccess = () => res();
      req.onerror   = e => rej(e.target.error);
    });
  }

  /* localStorage fallback for Safari private mode */
  function _lsGetPrinters() {
    try {
      return JSON.parse(localStorage.getItem('sokoni_printers_fb') || '[]');
    } catch (_) { return []; }
  }
  function _lsSavePrinters(arr) {
    try { localStorage.setItem('sokoni_printers_fb', JSON.stringify(arr)); } catch (_) {}
  }

  /* ── Settings ── */
  function getSettings() {
    if (_settings) return _settings;
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      _settings = Object.assign({}, DEFAULTS, raw ? JSON.parse(raw) : {});
    } catch (_) { _settings = Object.assign({}, DEFAULTS); }
    return _settings;
  }

  function saveSettings(partial) {
    _settings = Object.assign(getSettings(), partial);
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(_settings)); } catch (_) {}
    emit('settings:changed', _settings);
    return _settings;
  }

  /* ── Printer Registry ── */
  async function getPrinters() {
    try { return await _dbGetAll(STORE_PRINTERS); }
    catch (_) { return _lsGetPrinters(); }
  }

  async function getPrinter(id) {
    try { return await _dbGet(STORE_PRINTERS, id); }
    catch (_) { return _lsGetPrinters().find(p => p.id === id) || null; }
  }

  async function getDefaultPrinter() {
    const s = getSettings();
    if (s.defaultPrinterId) {
      const p = await getPrinter(s.defaultPrinterId);
      if (p) return p;
    }
    const all = await getPrinters();
    return all.find(p => p.isDefault) || all[0] || null;
  }

  async function addPrinter(record) {
    const printer = {
      id:             uuid(),
      name:           'Printer',
      type:           'browser',
      driver:         'auto',
      paperWidth:     getSettings().paperWidth || 80,
      config:         {},
      isDefault:      false,
      paired:         Date.now(),
      lastConnected:  null,
      status:         'disconnected',
      batteryLevel:   null,
      paperStatus:    'unknown',
      firmwareVersion:null,
      ...record,
    };
    try {
      await _dbPut(STORE_PRINTERS, printer);
    } catch (_) {
      const arr = _lsGetPrinters();
      const idx = arr.findIndex(p => p.id === printer.id);
      idx >= 0 ? arr.splice(idx, 1, printer) : arr.push(printer);
      _lsSavePrinters(arr);
    }
    emit('printer:added', printer);
    return printer.id;
  }

  async function updatePrinter(id, partial) {
    const existing = await getPrinter(id);
    if (!existing) return;
    const updated = Object.assign({}, existing, partial);
    try { await _dbPut(STORE_PRINTERS, updated); }
    catch (_) {
      const arr = _lsGetPrinters();
      const idx = arr.findIndex(p => p.id === id);
      if (idx >= 0) { arr[idx] = updated; _lsSavePrinters(arr); }
    }
  }

  async function removePrinter(id) {
    disconnectPrinter(id);
    try { await _dbDelete(STORE_PRINTERS, id); }
    catch (_) {
      const arr = _lsGetPrinters().filter(p => p.id !== id);
      _lsSavePrinters(arr);
    }
    emit('printer:removed', { id });
  }

  async function setDefault(id) {
    const all = await getPrinters();
    for (const p of all) {
      await updatePrinter(p.id, { isDefault: p.id === id });
    }
    saveSettings({ defaultPrinterId: id });
    emit('printer:default', { id });
  }

  /* ── Connection layer ── */
  function getConnectionStatus(id) {
    return _connections[id]?.status || 'disconnected';
  }

  async function connectPrinter(id) {
    const printer = await getPrinter(id);
    if (!printer) throw new Error('Printer not found: ' + id);

    if (_connections[id]?.status === 'connected') return;
    _connections[id] = { status: 'connecting', transport: null };
    emit('printer:connecting', { id, name: printer.name });

    try {
      const transport = await _buildTransport(printer);
      _connections[id] = { status: 'connected', transport };
      await updatePrinter(id, { status: 'connected', lastConnected: Date.now() });
      emit('printer:connected', { id, name: printer.name });
      _drainQueue(id);
    } catch (err) {
      _connections[id] = { status: 'error', transport: null, error: err.message };
      await updatePrinter(id, { status: 'error' });
      emit('printer:error', { id, name: printer.name, error: err.message });
      throw err;
    }
  }

  async function disconnectPrinter(id) {
    const conn = _connections[id];
    if (!conn) return;
    try { conn.transport?.disconnect?.(); } catch (_) {}
    delete _connections[id];
    await updatePrinter(id, { status: 'disconnected' });
    emit('printer:disconnected', { id });
  }

  /* Build the correct transport for a printer type */
  async function _buildTransport(printer) {
    const { type, config } = printer;

    /* Android native bridge — highest priority on Android */
    if (window.SokoniAndroid && (type === 'bluetooth-classic' || type === 'android')) {
      return _androidTransport(config);
    }

    /* Existing PosPrinter legacy transport for BLE & USB */
    if (type === 'bluetooth-ble') {
      if (!navigator.bluetooth) throw new Error('Web Bluetooth not supported');
      /* Try to reconnect to previously authorised device */
      if (navigator.bluetooth.getDevices) {
        const known = await navigator.bluetooth.getDevices();
        const match = known.find(d => d.id === config.deviceId || d.name === config.deviceName);
        if (match) return _buildBLETransportFromDevice(match);
      }
      /* Fallback: new request (requires user gesture) */
      await PosPrinter.connectBluetooth();
      return _legacyTransport();
    }

    if (type === 'usb') {
      if (!navigator.usb) throw new Error('WebUSB not supported');
      const known = await navigator.usb.getDevices();
      const match = known.find(d => d.vendorId === config.vendorId && d.productId === config.productId);
      if (match) return _buildUSBTransportFromDevice(match);
      await PosPrinter.connectUSB();
      return _legacyTransport();
    }

    if (type === 'usb-serial') {
      return _buildSerialTransport(config);
    }

    if (type === 'network' || type === 'ethernet') {
      return _buildNetworkTransport(config);
    }

    if (type === 'windows') {
      return _browserTransport();
    }

    /* Browser fallback */
    PosPrinter.connectBrowser();
    return _legacyTransport();
  }

  /* BLE transport from a known BluetoothDevice */
  async function _buildBLETransportFromDevice(device) {
    const BLE_PROFILES = [
      ['0000ffe0-0000-1000-8000-00805f9b34fb', '0000ffe1-0000-1000-8000-00805f9b34fb'],
      ['000018f0-0000-1000-8000-00805f9b34fb', '00002af1-0000-1000-8000-00805f9b34fb'],
      ['e7810a71-73ae-499d-8c15-faa9aef0c3f2', 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f'],
      ['49535343-fe7d-4ae5-8fa9-9fafd205e455', '49535343-8841-43f4-a8d4-ecbe34729bb3'],
    ];
    const server = await device.gatt.connect();
    let char = null;
    for (const [svcUUID, chrUUID] of BLE_PROFILES) {
      try {
        const svc = await server.getPrimaryService(svcUUID);
        char = await svc.getCharacteristic(chrUUID);
        if (char) break;
      } catch (_) {}
    }
    if (!char) throw new Error('No writable BLE characteristic found');

    device.addEventListener('gattserverdisconnected', () => {
      /* handled by reconnect logic */
    });

    return {
      type: 'bluetooth-ble',
      device,
      async send(bytes) {
        const MTU = 512;
        for (let i = 0; i < bytes.length; i += MTU) {
          const chunk = bytes.slice(i, i + MTU);
          if (char.properties.writeWithoutResponse) await char.writeValueWithoutResponse(chunk);
          else await char.writeValueWithResponse(chunk);
          await new Promise(r => setTimeout(r, CHUNK_MS));
        }
      },
      disconnect() { try { device.gatt.disconnect(); } catch (_) {} },
    };
  }

  /* USB transport from a known USBDevice */
  async function _buildUSBTransportFromDevice(device) {
    await device.open();
    if (!device.configuration) await device.selectConfiguration(1);
    let endpoint = null;
    for (const iface of device.configuration.interfaces) {
      try {
        await device.claimInterface(iface.interfaceNumber);
        endpoint = iface.alternate.endpoints.find(e => e.direction === 'out' && e.type === 'bulk');
        if (endpoint) break;
      } catch (_) {}
    }
    if (!endpoint) throw new Error('No bulk-OUT endpoint on USB printer');
    const epNum = endpoint.endpointNumber;
    return {
      type: 'usb',
      device,
      async send(bytes) {
        const MTU = 512;
        for (let i = 0; i < bytes.length; i += MTU) {
          await device.transferOut(epNum, bytes.slice(i, i + MTU));
        }
      },
      disconnect() { try { device.close(); } catch (_) {} },
    };
  }

  /* Web Serial transport (USB-serial, COM ports) */
  async function _buildSerialTransport(config) {
    if (!navigator.serial) throw new Error('Web Serial API not supported');
    let port;
    const known = await navigator.serial.getPorts();
    if (known.length > 0 && config.portIndex !== undefined) {
      port = known[config.portIndex] || known[0];
    } else {
      port = await navigator.serial.requestPort({ filters: [] });
    }
    await port.open({ baudRate: config.baudRate || 115200 });
    const writer = port.writable.getWriter();
    return {
      type: 'usb-serial',
      port,
      writer,
      async send(bytes) { await writer.write(bytes); },
      async disconnect() {
        try { writer.releaseLock(); await port.close(); } catch (_) {}
      },
    };
  }

  /* Network transport — local bridge first, then Cloud Function */
  async function _buildNetworkTransport(config) {
    const host = config.host || '192.168.1.100';
    const port = config.port || 9100;

    /* Try local SOKONI Desktop bridge (WebSocket → TCP) */
    const localBridgeOk = await _probeLocalBridge();

    return {
      type: 'network',
      host, port, localBridgeOk,
      async send(bytes) {
        if (localBridgeOk) {
          await _sendViaLocalBridge(host, port, bytes);
        } else {
          /* Cloud Function proxy — requires internet */
          await _sendViaCloudProxy(host, port, bytes);
        }
      },
      disconnect() {},
    };
  }

  /* Android native bridge */
  function _androidTransport(config) {
    return {
      type: 'android',
      async send(bytes) {
        const b64 = btoa(String.fromCharCode(...bytes));
        if (window.SokoniAndroid.printESCPOS) {
          window.SokoniAndroid.printESCPOS(b64);
        } else if (window.SokoniAndroid.print) {
          window.SokoniAndroid.print(b64);
        }
      },
      disconnect() {
        try { window.SokoniAndroid.disconnectPrinter?.(); } catch (_) {}
      },
    };
  }

  /* Browser fallback — renders HTML receipt in a new window */
  function _browserTransport() {
    return {
      type: 'browser',
      async send(_bytes, htmlDoc) {
        if (htmlDoc) {
          const bu = URL.createObjectURL(new Blob([htmlDoc], {type:'text/html;charset=utf-8'}));
          const w = window.open(bu, '_blank', 'width=400,height=600');
          if (w) setTimeout(() => { w.print(); URL.revokeObjectURL(bu); }, 300);
          else URL.revokeObjectURL(bu);
        } else {
          window.print();
        }
      },
      disconnect() {},
    };
  }

  /* Legacy transport — delegates to existing PosPrinter */
  function _legacyTransport() {
    return {
      type: 'legacy',
      async send(bytes) { await PosPrinter.sendRaw(bytes); },
      disconnect() { PosPrinter.disconnect(); },
    };
  }

  /* Local SOKONI Desktop bridge probe (WebSocket on localhost:9101) */
  let _localBridgeStatus = null;
  async function _probeLocalBridge() {
    if (_localBridgeStatus !== null) return _localBridgeStatus;
    try {
      const resp = await fetch('http://localhost:9101/ping', { signal: AbortSignal.timeout(500) });
      _localBridgeStatus = resp.ok;
    } catch (_) { _localBridgeStatus = false; }
    return _localBridgeStatus;
  }

  async function _sendViaLocalBridge(host, port, bytes) {
    const resp = await fetch('http://localhost:9101/print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Target-Host': host, 'X-Target-Port': String(port) },
      body: bytes,
    });
    if (!resp.ok) throw new Error('Local bridge error: ' + resp.status);
  }

  async function _sendViaCloudProxy(host, port, bytes) {
    const CF = 'https://us-central1-sokoni-aeb26.cloudfunctions.net/posPrint';
    let idToken = '';
    try {
      const auth = window.firebase?.auth?.() || window.firebaseAuth;
      if (auth?.currentUser) idToken = await auth.currentUser.getIdToken();
    } catch (_) {}
    const qs = new URLSearchParams({ host, port: String(port) });
    const resp = await fetch(`${CF}?${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...(idToken && { 'Authorization': `Bearer ${idToken}` }) },
      body: bytes,
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || 'Network printer error: ' + resp.status);
    }
  }

  /* ── Print Queue ── */
  async function _addToQueue(job) {
    const record = {
      id:         uuid(),
      printerId:  job.printerId || null,
      type:       job.type || 'receipt',
      data:       job.data || {},
      copies:     job.copies || getSettings().copies || 1,
      status:     'pending',
      retries:    0,
      maxRetries: MAX_RETRIES,
      createdAt:  Date.now(),
      printedAt:  null,
      error:      null,
    };
    try { await _dbPut(STORE_QUEUE, record); }
    catch (_) {
      const q = _lsGetQueue();
      q.push(record);
      _lsSaveQueue(q);
    }
    emit('queue:updated', { action: 'added', job: record });
    return record.id;
  }

  async function _updateJobStatus(id, partial) {
    try {
      const job = await _dbGet(STORE_QUEUE, id);
      if (!job) return;
      const updated = Object.assign({}, job, partial);
      await _dbPut(STORE_QUEUE, updated);
    } catch (_) {
      const q = _lsGetQueue();
      const idx = q.findIndex(j => j.id === id);
      if (idx >= 0) { Object.assign(q[idx], partial); _lsSaveQueue(q); }
    }
    emit('queue:updated', { action: 'updated', id });
  }

  async function getQueue() {
    try { return await _dbGetAll(STORE_QUEUE); }
    catch (_) { return _lsGetQueue(); }
  }

  async function clearQueue() {
    const all = await getQueue();
    for (const job of all.filter(j => j.status === 'done' || j.status === 'cancelled')) {
      try { await _dbDelete(STORE_QUEUE, job.id); }
      catch (_) {}
    }
    emit('queue:updated', { action: 'cleared' });
  }

  async function cancelJob(id) {
    await _updateJobStatus(id, { status: 'cancelled' });
  }

  async function retryJob(id) {
    await _updateJobStatus(id, { status: 'pending', retries: 0, error: null });
    _drainQueue();
  }

  function _lsGetQueue()   { try { return JSON.parse(localStorage.getItem('sokoni_pq_fb') || '[]'); } catch (_) { return []; } }
  function _lsSaveQueue(q) { try { localStorage.setItem('sokoni_pq_fb', JSON.stringify(q)); } catch (_) {} }

  /* ── Queue drainer ── */
  async function _drainQueue(specificPrinterId) {
    if (_draining) return;
    _draining = true;
    try {
      const jobs = (await getQueue()).filter(j => j.status === 'pending' || j.status === 'retry');
      for (const job of jobs) {
        const pid = job.printerId || getSettings().defaultPrinterId;
        if (specificPrinterId && pid !== specificPrinterId) continue;
        const conn = _connections[pid];
        if (!conn || conn.status !== 'connected') continue;
        await _executeJob(job, conn.transport);
      }
    } finally { _draining = false; }
  }

  async function _executeJob(job, transport) {
    await _updateJobStatus(job.id, { status: 'printing' });
    try {
      const settings = getSettings();
      const driver   = _resolveDriver(job.printerId);
      const engine   = window.SokoniReceiptEngine || window.SokoniPrintEngine;

      let bytes;
      if (transport.type === 'browser') {
        /* Render HTML receipt for browser print */
        const html = engine ? engine.buildHTML(job) : _fallbackHTML(job);
        await transport.send(null, html);
      } else {
        bytes = engine ? engine.buildBytes(job, settings) : _fallbackBytes(job, settings);
        if (driver && driver.build) bytes = driver.build(job, settings);
        for (let c = 0; c < (job.copies || 1); c++) {
          await transport.send(bytes);
        }
        /* Cash drawer kick if sale and setting enabled */
        if (job.type === 'receipt' && settings.openDrawerOnSale) {
          await transport.send(_drawerKickCmd());
        }
      }

      await _updateJobStatus(job.id, { status: 'done', printedAt: Date.now() });
      emit('job:done', { jobId: job.id, type: job.type });
    } catch (err) {
      const retries = (job.retries || 0) + 1;
      if (retries >= (job.maxRetries || MAX_RETRIES)) {
        await _updateJobStatus(job.id, { status: 'failed', error: err.message, retries });
        emit('job:failed', { jobId: job.id, error: err.message });
      } else {
        await _updateJobStatus(job.id, { status: 'retry', retries, error: err.message });
        /* Exponential backoff */
        setTimeout(() => _drainQueue(), Math.min(2000 * Math.pow(2, retries - 1), 60000));
      }
    }
  }

  function _resolveDriver(printerId) {
    if (!window.SokoniPrinterDrivers || !printerId) return null;
    return null; /* driver selection is handled inside SokoniReceiptEngine */
  }

  /* ── Public print API ── */
  async function print(data, opts = {}) {
    const s = getSettings();
    const printerId = opts.printerId || s.defaultPrinterId;
    const type      = opts.type || 'receipt';
    const copies    = opts.copies || s.copies || 1;

    const jobId = await _addToQueue({ printerId, type, data, copies });

    if (!s.printQueue || opts.immediate) {
      /* Try to print immediately without waiting for next drain */
      const conn = _connections[printerId];
      if (conn?.status === 'connected') {
        const jobs = await getQueue();
        const job  = jobs.find(j => j.id === jobId);
        if (job) await _executeJob(job, conn.transport);
      } else if (printerId) {
        /* Attempt auto-connect then print */
        connectPrinter(printerId).then(() => _drainQueue(printerId)).catch(() => {});
      }
    } else {
      _drainQueue(printerId);
    }

    return jobId;
  }

  async function printLabel(items, opts = {}) {
    return print({ items, labelOpts: opts }, { type: 'label', ...opts });
  }

  async function printTest(printerId) {
    const pid = printerId || getSettings().defaultPrinterId;
    return print({
      shopName: getSettings().shopName || 'SOKONI SmartPOS',
      shopAddress: getSettings().shopAddress || 'Nairobi, Kenya',
      shopPhone: getSettings().shopPhone || '+254700000000',
      receiptNo: 'TEST-' + Date.now().toString().slice(-6),
      cashierName: 'Test Mode',
      timestamp: Date.now(),
      items: [
        { name: 'Test Item A',    qty: 2, price: 100 },
        { name: 'Sample Product', qty: 1, price: 250 },
      ],
      subtotal: 450, taxRate: 16, taxAmount: 72, total: 522,
      paymentMethod: 'cash', amountPaid: 600, change: 78,
      footerMessage: '=== PRINT TEST OK ===',
    }, { printerId: pid, type: 'receipt', immediate: true });
  }

  async function openCashDrawer(printerId) {
    const pid  = printerId || getSettings().defaultPrinterId;
    const conn = _connections[pid];
    if (!conn || conn.status !== 'connected') return false;
    try {
      await conn.transport.send(_drawerKickCmd());
      return true;
    } catch (_) { return false; }
  }

  function _drawerKickCmd() {
    return new Uint8Array([0x1B, 0x70, 0x00, 0x19, 0xFA]);
  }

  /* ── Simple ESC/POS fallback (if SokoniReceiptEngine not loaded) ── */
  function _fallbackBytes(job, s) {
    const ESC = 0x1B, GS = 0x1D, LF = 0x0A;
    const cols = (s.paperWidth || 80) >= 80 ? 48 : 32;
    const bytes = [];
    const w  = v => { bytes.push(...(typeof v === 'number' ? [v] : Array.from(v))); };
    const ln = t => { const b = new TextEncoder().encode(String(t || '')); w(b); w(LF); };
    const ctr = t => {
      const s2 = String(t || '');
      const pad = Math.max(0, Math.floor((cols - s2.length) / 2));
      ln(' '.repeat(pad) + s2);
    };
    /* Init */
    w([ESC, 0x40]);
    w([ESC, 0x61, 0x01]); /* center */
    w([ESC, 0x45, 0x01]); /* bold */
    ctr(job.data?.shopName || job.data?.businessName || 'SOKONI POS');
    w([ESC, 0x45, 0x00]); /* bold off */
    if (job.data?.shopAddress) ctr(job.data.shopAddress);
    if (job.data?.shopPhone)   ctr(job.data.shopPhone);
    w([ESC, 0x61, 0x00]); /* left */
    ln('-'.repeat(cols));
    ln('Receipt: ' + (job.data?.receiptNo || ''));
    ln('-'.repeat(cols));
    (job.data?.items || []).forEach(item => {
      const l = String(item.name || '').slice(0, cols - 10);
      const r = 'KES ' + Number(item.price * item.qty).toFixed(2);
      const sp = Math.max(1, cols - l.length - r.length);
      ln(l + ' '.repeat(sp) + r);
    });
    ln('-'.repeat(cols));
    w([ESC, 0x45, 0x01]);
    const tot = 'TOTAL: KES ' + Number(job.data?.total || 0).toFixed(2);
    ln(' '.repeat(Math.max(0, cols - tot.length)) + tot);
    w([ESC, 0x45, 0x00]);
    ln('-'.repeat(cols));
    w([ESC, 0x61, 0x01]);
    ctr(job.data?.footerMessage || 'Thank you!');
    ctr('mysokoni.co.ke');
    w([ESC, 0x61, 0x00]);
    /* Paper feed + cut */
    ln(''); ln(''); ln('');
    if (s.autoCut) w([GS, 0x56, 0x00]);
    return new Uint8Array(bytes);
  }

  function _fallbackHTML(job) {
    const d = job.data || {};
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Receipt</title>
    <style>body{font-family:monospace;font-size:12px;width:80mm;margin:0 auto;}
    .c{text-align:center;}.b{font-weight:bold;}.hr{border:none;border-top:1px dashed #000;}</style></head>
    <body><div class="c b">${d.shopName||d.businessName||'SOKONI'}</div>
    <div class="c">${d.shopAddress||''}</div><hr class="hr">
    <div>Receipt: ${d.receiptNo||''}</div><hr class="hr">
    ${(d.items||[]).map(i=>`<div style="display:flex;justify-content:space-between"><span>${i.name} x${i.qty}</span><span>KES ${(i.price*i.qty).toFixed(2)}</span></div>`).join('')}
    <hr class="hr"><div class="b" style="text-align:right">TOTAL: KES ${Number(d.total||0).toFixed(2)}</div>
    <hr class="hr"><div class="c">${d.footerMessage||'Thank you!'}</div>
    <script>window.onload=()=>window.print()<\/script></body></html>`;
  }

  /* ── Auto-reconnect on init ── */
  async function _autoReconnect() {
    if (!getSettings().autoReconnect) return;
    const printers = await getPrinters();
    for (const p of printers) {
      if (p.type === 'browser' || p.type === 'windows') continue;
      /* Try silent reconnect (only works for pre-authorised devices) */
      try { await connectPrinter(p.id); }
      catch (_) { /* silent — printer may not be on */ }
    }
  }

  /* ── Init ── */
  async function init() {
    getSettings(); /* load settings into cache */
    try { await _openDB(); } catch (_) {}
    _autoReconnect().catch(() => {});
    /* Periodic queue drain for retry jobs */
    setInterval(() => _drainQueue(), 30000);
    emit('ready', {});
  }

  /* ── Discovery helper ── */
  async function discover(types) {
    if (window.SokoniPrinterDiscovery) {
      return window.SokoniPrinterDiscovery.scan(types);
    }
    return [];
  }

  return {
    init,
    getSettings, saveSettings,
    getPrinters, getPrinter, getDefaultPrinter,
    addPrinter, updatePrinter, removePrinter, setDefault,
    connectPrinter, disconnectPrinter, getConnectionStatus,
    print, printLabel, printTest, openCashDrawer,
    getQueue, clearQueue, cancelJob, retryJob,
    discover,
    on, off,
  };
})();
