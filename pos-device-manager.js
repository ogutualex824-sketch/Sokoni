/* pos-device-manager.js — SOKONI SmartPOS Unified Device Manager v1.0
 * ─────────────────────────────────────────────────────────────────────
 * Centralised registry for all POS peripherals:
 *   Receipt Printers · Barcode Printers · Label Printers
 *   Barcode Scanners · QR Scanners · Camera Scanners
 *   Cash Drawers · PDQ Terminals · SoftPOS Devices
 *
 * Capabilities:
 *   Discovery  · Pairing  · Persistence (IndexedDB via PosDB.devices)
 *   Health monitoring (30s heartbeat) · Automatic reconnection (backoff)
 *   Branch + Till assignment · Battery status · Last-seen tracking
 *
 * Integrates with: PosPrinter, PosBarcode, PosScanner, PosTerminals
 */
'use strict';

window.PosDeviceManager = (() => {

  /* ═══════════════════════════════════════════════════════════
     CONSTANTS
  ═══════════════════════════════════════════════════════════ */
  const TYPES = {
    printer_receipt: { label: 'Receipt Printer',  icon: '🖨️',  reconnectable: true  },
    printer_barcode: { label: 'Barcode Printer',  icon: '🏷️',  reconnectable: true  },
    printer_label:   { label: 'Label Printer',    icon: '📛',  reconnectable: true  },
    scanner_barcode: { label: 'Barcode Scanner',  icon: '📟',  reconnectable: false },
    scanner_qr:      { label: 'QR Scanner',       icon: '📷',  reconnectable: false },
    scanner_camera:  { label: 'Camera Scanner',   icon: '📸',  reconnectable: false },
    cash_drawer:     { label: 'Cash Drawer',      icon: '💰',  reconnectable: true  },
    pdq_terminal:    { label: 'PDQ Terminal',     icon: '💳',  reconnectable: true  },
    softpos:         { label: 'SoftPOS',          icon: '📱',  reconnectable: false },
  };

  const CONN = {
    bluetooth: { label: 'Bluetooth',    icon: '🔵' },
    usb:       { label: 'USB',          icon: '🔌' },
    network:   { label: 'Wi-Fi / LAN', icon: '📡' },
    serial:    { label: 'Serial Port',  icon: '🔗' },
    camera:    { label: 'Camera',       icon: '📸' },
    keyboard:  { label: 'USB HID',      icon: '⌨️' },
    virtual:   { label: 'Virtual',      icon: '💻' },
    cloud:     { label: 'Cloud',        icon: '☁️' },
  };

  const STATUS = {
    connected:    { label: 'Connected',    color: '#71ff00', dot: '●' },
    disconnected: { label: 'Disconnected', color: '#ef4444', dot: '●' },
    reconnecting: { label: 'Reconnecting', color: '#f59e0b', dot: '●' },
    offline:      { label: 'Offline',      color: '#9898aa', dot: '●' },
    error:        { label: 'Error',        color: '#ef4444', dot: '●' },
    pairing:      { label: 'Pairing',      color: '#60a5fa', dot: '●' },
    unknown:      { label: 'Unknown',      color: '#9898aa', dot: '●' },
  };

  /* reconnect backoff */
  const RECONNECT_BASE_MS  = 3000;
  const RECONNECT_MAX_MS   = 60000;
  const RECONNECT_MAX_TRIES= 5;
  const HEALTH_POLL_MS     = 30000;
  const LAST_SEEN_STALE_MS = 120000;  /* 2 min without heartbeat = offline */

  /* ═══════════════════════════════════════════════════════════
     STATE
  ═══════════════════════════════════════════════════════════ */
  const _registry   = new Map();          /* id → device object (augmented with runtime fields) */
  const _reconnect  = new Map();          /* id → { timer, attempts } */
  let   _healthTimer = null;
  let   _initialized = false;
  const _listeners  = {};                 /* event → [handler, ...] */

  /* ═══════════════════════════════════════════════════════════
     HELPERS
  ═══════════════════════════════════════════════════════════ */
  function _escH(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _uid() {
    return 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  function _now() { return Date.now(); }

  function _emit(event, data = {}) {
    (_listeners[event] || []).forEach(h => { try { h(data); } catch (_) {} });
    window.dispatchEvent(new CustomEvent('pdm:' + event, { detail: data }));
  }

  function on(event, handler) {
    if (!_listeners[event]) _listeners[event] = [];
    _listeners[event].push(handler);
  }

  function off(event, handler) {
    if (!_listeners[event]) return;
    _listeners[event] = _listeners[event].filter(h => h !== handler);
  }

  function _toast(msg, type = 'info') {
    if (window.SPos?.toast) SPos.toast(msg, type);
    else console.log('[PDM]', msg);
  }

  /* ═══════════════════════════════════════════════════════════
     PERSISTENCE (via PosDB.devices)
  ═══════════════════════════════════════════════════════════ */
  async function _save(device) {
    const toSave = { ...device };
    delete toSave._btDevice;    /* don't persist live handles */
    delete toSave._usbDevice;
    delete toSave._server;
    delete toSave._char;
    if (!window.PosDB) return;
    await PosDB.devices.save(toSave);
  }

  async function _load() {
    if (!window.PosDB) return [];
    try {
      const all = await PosDB.devices.getAll();
      return Array.isArray(all) ? all : [];
    } catch (_) { return []; }
  }

  async function _remove(id) {
    _registry.delete(id);
    if (window.PosDB) await PosDB.devices.delete(id).catch(() => {});
    _emit('device:removed', { id });
    _renderUI();
  }

  /* ═══════════════════════════════════════════════════════════
     REGISTRY OPERATIONS
  ═══════════════════════════════════════════════════════════ */
  function _setStatus(id, status, errorMsg = null) {
    const dev = _registry.get(id);
    if (!dev) return;
    const prev = dev.status;
    dev.status = status;
    if (errorMsg) dev.lastError = errorMsg;
    if (status === 'connected') { dev.lastSeen = _now(); dev.lastError = null; }
    _save(dev);
    if (prev !== status) _emit('device:status', { id, status, prev, device: dev });
    _renderUI();
  }

  function _updateLastSeen(id) {
    const dev = _registry.get(id);
    if (!dev) return;
    dev.lastSeen = _now();
    if (dev.status !== 'connected') _setStatus(id, 'connected');
    else _save(dev);
  }

  function _registerRuntime(device) {
    const existing = _registry.get(device.id);
    const merged = { ...device, ...(existing ? { _btDevice: existing._btDevice, _usbDevice: existing._usbDevice } : {}) };
    _registry.set(device.id, merged);
    return merged;
  }

  /* ═══════════════════════════════════════════════════════════
     HEALTH MONITOR
  ═══════════════════════════════════════════════════════════ */
  function _startHealthMonitor() {
    if (_healthTimer) return;
    _healthTimer = setInterval(_pollHealth, HEALTH_POLL_MS);
  }

  async function _pollHealth() {
    const now = _now();
    for (const [id, dev] of _registry) {
      if (dev.status === 'offline' || dev.status === 'pairing' || dev.status === 'disconnected') continue;

      /* Bluetooth: check GATT connection state */
      if (dev.connectionMethod === 'bluetooth' && dev._btDevice) {
        const connected = dev._btDevice?.gatt?.connected ?? false;
        if (!connected && dev.status === 'connected') {
          console.warn('[PDM] BT device disconnected:', dev.name);
          _setStatus(id, 'disconnected');
          _scheduleReconnect(id);
        } else if (connected) {
          _updateLastSeen(id);
        }
        continue;
      }

      /* USB: check device opened */
      if (dev.connectionMethod === 'usb' && dev._usbDevice) {
        if (!dev._usbDevice.opened && dev.status === 'connected') {
          _setStatus(id, 'disconnected');
          _scheduleReconnect(id);
        }
        continue;
      }

      /* Network: probe every 30s */
      if (dev.connectionMethod === 'network' && dev.meta?.ip) {
        _probeNetwork(id, dev.meta.ip, dev.meta.port || 9100);
        continue;
      }

      /* Stale last-seen: mark offline */
      if (dev.lastSeen && (now - dev.lastSeen) > LAST_SEEN_STALE_MS && dev.status === 'connected') {
        _setStatus(id, 'offline');
      }
    }
  }

  async function _probeNetwork(id, ip, port) {
    try {
      const res = await fetch(`http://${ip}:${port}/status`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) { _updateLastSeen(id); }
      else { _setStatus(id, 'error', 'HTTP ' + res.status); }
    } catch (_) {
      const dev = _registry.get(id);
      if (dev?.status === 'connected') _setStatus(id, 'disconnected');
    }
  }

  /* ═══════════════════════════════════════════════════════════
     RECONNECTION ENGINE
  ═══════════════════════════════════════════════════════════ */
  function _scheduleReconnect(id) {
    if (!TYPES[_registry.get(id)?.type]?.reconnectable) return;

    const state = _reconnect.get(id) || { attempts: 0, timer: null };
    if (state.attempts >= RECONNECT_MAX_TRIES) {
      _setStatus(id, 'offline');
      _reconnect.delete(id);
      _toast(`Device "${_registry.get(id)?.name}" unreachable after ${RECONNECT_MAX_TRIES} attempts.`, 'error');
      return;
    }

    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, state.attempts) + Math.random() * 1000, RECONNECT_MAX_MS);
    state.attempts++;
    _setStatus(id, 'reconnecting');

    state.timer = setTimeout(async () => {
      await _attemptReconnect(id);
    }, delay);
    _reconnect.set(id, state);
  }

  async function _attemptReconnect(id) {
    const dev = _registry.get(id);
    if (!dev) return;
    console.info('[PDM] Reconnect attempt', _reconnect.get(id)?.attempts, 'for', dev.name);

    try {
      if (dev.connectionMethod === 'bluetooth' && dev._btDevice?.gatt) {
        await dev._btDevice.gatt.connect();
        const server = await dev._btDevice.gatt.connect();
        dev._server = server;
        _clearReconnect(id);
        _setStatus(id, 'connected');
        _emit('device:reconnected', { id, device: dev });
        _toast(`✓ ${dev.name} reconnected`, 'success');
        /* Re-wire to PosPrinter if it's the active printer */
        if (['printer_receipt','printer_barcode','printer_label'].includes(dev.type)) {
          _rewirePrinter(dev);
        }
        return;
      }

      if (dev.connectionMethod === 'usb' && dev._usbDevice) {
        await dev._usbDevice.open();
        _clearReconnect(id);
        _setStatus(id, 'connected');
        _emit('device:reconnected', { id, device: dev });
        _toast(`✓ ${dev.name} reconnected via USB`, 'success');
        return;
      }

      if (dev.connectionMethod === 'network' && dev.meta?.ip) {
        const res = await fetch(`http://${dev.meta.ip}:${dev.meta.port || 9100}/status`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          _clearReconnect(id);
          _setStatus(id, 'connected');
          _toast(`✓ ${dev.name} back online at ${dev.meta.ip}`, 'success');
          return;
        }
      }

      /* Failed attempt — schedule another */
      _scheduleReconnect(id);
    } catch (e) {
      console.warn('[PDM] Reconnect failed:', e.message);
      _scheduleReconnect(id);
    }
  }

  function _clearReconnect(id) {
    const state = _reconnect.get(id);
    if (state?.timer) clearTimeout(state.timer);
    _reconnect.delete(id);
  }

  function _rewirePrinter(dev) {
    if (!window.PosPrinter) return;
    /* Notify PosPrinter of re-established connection */
    _emit('printer:reconnected', { id: dev.id, device: dev });
  }

  /* ═══════════════════════════════════════════════════════════
     DEVICE DISCOVERY & PAIRING
  ═══════════════════════════════════════════════════════════ */

  /* ─── Pair a Bluetooth printer ─── */
  async function pairBluetoothPrinter(type = 'printer_receipt') {
    if (!window.PosPrinter) throw new Error('PosPrinter module not loaded');
    const name = await PosPrinter.connectBluetooth();

    /* Capture the device object for reconnect */
    let btDevice = null;
    if (navigator.bluetooth) {
      try {
        const devices = await navigator.bluetooth.getDevices?.() || [];
        btDevice = devices.find(d => d.name === name) || null;
      } catch (_) {}
    }

    const device = {
      id:               _uid(),
      name:             name || 'Bluetooth Printer',
      type,
      connectionMethod: 'bluetooth',
      status:           'connected',
      branchId:         _currentBranch(),
      tillId:           _currentTill(),
      lastSeen:         _now(),
      meta:             { btName: name },
      createdAt:        _now(),
      updatedAt:        _now(),
    };

    const registered = _registerRuntime(device);
    if (btDevice) {
      registered._btDevice = btDevice;
      /* Listen for GATT disconnect */
      btDevice.addEventListener('gattserverdisconnected', () => {
        console.warn('[PDM] BT GATT disconnect for', device.id);
        _setStatus(device.id, 'disconnected');
        _scheduleReconnect(device.id);
      });
    }

    await _save(registered);
    _emit('device:paired', { id: device.id, device: registered });
    _renderUI();
    return registered;
  }

  /* ─── Pair a USB printer ─── */
  async function pairUSBPrinter(type = 'printer_receipt') {
    if (!window.PosPrinter) throw new Error('PosPrinter module not loaded');
    const name = await PosPrinter.connectUSB();

    let usbDevice = null;
    if (navigator.usb) {
      try {
        const devices = await navigator.usb.getDevices();
        usbDevice = devices[devices.length - 1] || null;
      } catch (_) {}
    }

    const device = {
      id:               _uid(),
      name:             name || 'USB Printer',
      type,
      connectionMethod: 'usb',
      status:           'connected',
      branchId:         _currentBranch(),
      tillId:           _currentTill(),
      lastSeen:         _now(),
      meta:             { usbName: name },
      createdAt:        _now(),
      updatedAt:        _now(),
    };

    const registered = _registerRuntime(device);
    if (usbDevice) registered._usbDevice = usbDevice;
    await _save(registered);
    _emit('device:paired', { id: device.id, device: registered });
    _renderUI();
    return registered;
  }

  /* ─── Register a network printer ─── */
  async function registerNetworkPrinter(ip, port = 9100, type = 'printer_receipt') {
    const name = await (window.PosPrinter ? PosPrinter.connectNetwork(ip, port) : Promise.resolve(`${ip}:${port}`));
    const device = {
      id:               _uid(),
      name:             `Network Printer (${ip})`,
      type,
      connectionMethod: 'network',
      status:           'connected',
      branchId:         _currentBranch(),
      tillId:           _currentTill(),
      lastSeen:         _now(),
      meta:             { ip, port },
      createdAt:        _now(),
      updatedAt:        _now(),
    };
    const registered = _registerRuntime(device);
    await _save(registered);
    _emit('device:paired', { id: device.id, device: registered });
    _renderUI();
    return registered;
  }

  /* ─── Register camera scanner ─── */
  async function registerCameraScanner() {
    const device = {
      id:               _uid(),
      name:             'Camera Scanner',
      type:             'scanner_camera',
      connectionMethod: 'camera',
      status:           'connected',
      branchId:         _currentBranch(),
      tillId:           _currentTill(),
      lastSeen:         _now(),
      meta:             { detector: 'BarcodeDetector' in window ? 'native' : 'not-available' },
      createdAt:        _now(),
      updatedAt:        _now(),
    };
    if (!('BarcodeDetector' in window)) device.status = 'error';
    const registered = _registerRuntime(device);
    await _save(registered);
    _emit('device:paired', { id: device.id, device: registered });
    _renderUI();
    return registered;
  }

  /* ─── Register hardware keyboard-wedge scanner ─── */
  async function registerHIDScanner() {
    const device = {
      id:               _uid(),
      name:             'Barcode Scanner (USB HID)',
      type:             'scanner_barcode',
      connectionMethod: 'keyboard',
      status:           'connected',
      branchId:         _currentBranch(),
      tillId:           _currentTill(),
      lastSeen:         _now(),
      meta:             {},
      createdAt:        _now(),
      updatedAt:        _now(),
    };
    const registered = _registerRuntime(device);
    await _save(registered);
    _emit('device:paired', { id: device.id, device: registered });
    _renderUI();
    return registered;
  }

  /* ─── Register virtual/browser cash drawer ─── */
  async function registerCashDrawer(connectionMethod = 'bluetooth') {
    const device = {
      id:               _uid(),
      name:             'Cash Drawer',
      type:             'cash_drawer',
      connectionMethod,
      status:           'connected',
      branchId:         _currentBranch(),
      tillId:           _currentTill(),
      lastSeen:         _now(),
      meta:             {},
      createdAt:        _now(),
      updatedAt:        _now(),
    };
    const registered = _registerRuntime(device);
    await _save(registered);
    _emit('device:paired', { id: device.id, device: registered });
    _renderUI();
    return registered;
  }

  /* ─── Register PDQ terminal (delegates to PosTerminals) ─── */
  async function registerPDQ(config) {
    /* If PosTerminals is loaded, use it for PDQ registration */
    if (window.PosTerminals) {
      return PosTerminals.wiz ? PosTerminals.openWizard() : null;
    }
    const device = {
      id:               config.id || _uid(),
      name:             config.name || 'PDQ Terminal',
      type:             'pdq_terminal',
      connectionMethod: config.connectionMethod || 'network',
      status:           'disconnected',
      branchId:         _currentBranch(),
      tillId:           _currentTill(),
      lastSeen:         null,
      meta:             config.meta || {},
      createdAt:        _now(),
      updatedAt:        _now(),
    };
    const registered = _registerRuntime(device);
    await _save(registered);
    _emit('device:paired', { id: device.id, device: registered });
    _renderUI();
    return registered;
  }

  /* ─── Manually register any device ─── */
  async function registerManual(name, type, connectionMethod, meta = {}) {
    if (!TYPES[type]) throw new Error('Unknown device type: ' + type);
    const device = {
      id:               _uid(),
      name:             name.trim(),
      type,
      connectionMethod,
      status:           'unknown',
      branchId:         _currentBranch(),
      tillId:           _currentTill(),
      lastSeen:         null,
      meta,
      createdAt:        _now(),
      updatedAt:        _now(),
    };
    const registered = _registerRuntime(device);
    await _save(registered);
    _emit('device:registered', { id: device.id, device: registered });
    _renderUI();
    return registered;
  }

  /* ─── Remove device ─── */
  async function removeDevice(id) {
    _clearReconnect(id);
    await _remove(id);
    _toast('Device removed', 'info');
  }

  /* ─── Mark heartbeat (called by printer/scanner on successful use) ─── */
  function heartbeat(id) {
    _updateLastSeen(id);
  }

  /* ─── Set branch/till assignment ─── */
  async function assign(id, branchId, tillId) {
    const dev = _registry.get(id);
    if (!dev) throw new Error('Device not found');
    dev.branchId = branchId;
    dev.tillId   = tillId;
    dev.updatedAt = _now();
    await _save(dev);
    _emit('device:assigned', { id, branchId, tillId });
    _renderUI();
  }

  /* ═══════════════════════════════════════════════════════════
     CONTEXT HELPERS
  ═══════════════════════════════════════════════════════════ */
  function _currentBranch() {
    return window.state?.settings?.branchId || window.PosBoss?.branch?.current || 'main';
  }
  function _currentTill() {
    return window.state?.settings?.tillId || localStorage.getItem('sokoni_till_id') || '1';
  }

  /* ═══════════════════════════════════════════════════════════
     DEVICE LIST QUERY
  ═══════════════════════════════════════════════════════════ */
  function getAll() {
    return [..._registry.values()];
  }

  function getByType(type) {
    return [..._registry.values()].filter(d => d.type === type);
  }

  function getForTill(tillId) {
    return [..._registry.values()].filter(d => d.tillId === String(tillId));
  }

  function getActiveReceiptPrinter() {
    const printers = getByType('printer_receipt').filter(d => d.status === 'connected');
    return printers[0] || null;
  }

  function getActiveBarcodeScanner() {
    const scanners = [...getByType('scanner_barcode'), ...getByType('scanner_qr'), ...getByType('scanner_camera')]
      .filter(d => d.status === 'connected');
    return scanners[0] || null;
  }

  /* ═══════════════════════════════════════════════════════════
     COMMISSIONING HEALTH CHECK
  ═══════════════════════════════════════════════════════════ */
  async function runHealthCheck() {
    const results = [];
    const now = _now();

    for (const [id, dev] of _registry) {
      const stale = dev.lastSeen && (now - dev.lastSeen) > LAST_SEEN_STALE_MS;
      results.push({
        id,
        name:             dev.name,
        type:             dev.type,
        typeLabel:        TYPES[dev.type]?.label || dev.type,
        connectionMethod: dev.connectionMethod,
        connLabel:        CONN[dev.connectionMethod]?.label || dev.connectionMethod,
        status:           dev.status,
        branchId:         dev.branchId,
        tillId:           dev.tillId,
        lastSeen:         dev.lastSeen,
        lastSeenRelative: dev.lastSeen ? _relTime(dev.lastSeen) : 'Never',
        battery:          dev.battery ?? null,
        stale,
        lastError:        dev.lastError || null,
      });
    }

    return results;
  }

  function _relTime(ts) {
    const diff = _now() - ts;
    if (diff < 60000)  return 'Just now';
    if (diff < 3600000) return Math.round(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.round(diff / 3600000) + 'h ago';
    return new Date(ts).toLocaleDateString('en-KE');
  }

  /* ═══════════════════════════════════════════════════════════
     DEVICE MANAGER UI  (renders into any container)
  ═══════════════════════════════════════════════════════════ */
  let _uiContainer = null;

  function mountUI(containerId) {
    _uiContainer = document.getElementById(containerId);
    if (!_uiContainer) return;
    _injectCSS();
    _renderUI();
  }

  function _injectCSS() {
    if (document.getElementById('pdm-css')) return;
    const s = document.createElement('style');
    s.id = 'pdm-css';
    s.textContent = `
.pdm-wrap{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f0f0f6}
.pdm-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.pdm-btn{padding:8px 14px;border:1px solid rgba(255,255,255,.1);border-radius:9px;background:#1e1e28;color:#f0f0f6;font-size:12px;font-weight:700;cursor:pointer;transition:all .15s;white-space:nowrap}
.pdm-btn:hover{border-color:rgba(113,255,0,.3);color:#71ff00}
.pdm-btn.primary{background:#71ff00;color:#111;border-color:transparent}
.pdm-count{font-size:12px;color:#9898aa;margin-left:auto}
.pdm-empty{text-align:center;padding:40px 20px;color:#9898aa}
.pdm-table{width:100%;border-collapse:collapse;font-size:12px}
.pdm-table th{padding:8px 10px;text-align:left;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#9898aa;border-bottom:1px solid rgba(255,255,255,.07)}
.pdm-table td{padding:9px 10px;border-bottom:1px solid rgba(255,255,255,.04);vertical-align:middle}
.pdm-table tr:hover td{background:rgba(255,255,255,.02)}
.pdm-dot{font-size:10px;margin-right:4px}
.pdm-name{font-weight:700;font-size:13px}
.pdm-sub{font-size:11px;color:#9898aa;margin-top:2px}
.pdm-badge{display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;letter-spacing:.03em}
.pdm-actions{display:flex;gap:5px}
.pdm-act{padding:5px 10px;border:1px solid rgba(255,255,255,.08);border-radius:7px;background:#1e1e28;color:#9898aa;font-size:11px;font-weight:600;cursor:pointer;transition:all .15s}
.pdm-act:hover{border-color:rgba(255,255,255,.2);color:#f0f0f6}
.pdm-act.danger{border-color:rgba(239,68,68,.2);color:#ef4444}
.pdm-act.danger:hover{background:#ef4444;color:#fff}
`;
    document.head.appendChild(s);
  }

  function _renderUI() {
    if (!_uiContainer) return;
    const devices = getAll();

    const pairedCount   = devices.length;
    const connectedCount = devices.filter(d => d.status === 'connected').length;

    _uiContainer.innerHTML = `<div class="pdm-wrap">
      <div class="pdm-toolbar">
        <button class="pdm-btn primary" onclick="PosDeviceManager.openPairWizard()">+ Add Device</button>
        <button class="pdm-btn" onclick="PosDeviceManager._pollHealth();PosDeviceManager._renderUI()">Refresh</button>
        <span class="pdm-count">${connectedCount}/${pairedCount} devices connected</span>
      </div>
      ${!devices.length
        ? `<div class="pdm-empty">No devices paired.<br>Tap "+ Add Device" to pair a printer, scanner, or terminal.</div>`
        : `<table class="pdm-table">
            <thead><tr>
              <th>Device Name</th><th>Type</th><th>Connection</th>
              <th>Branch / Till</th><th>Status</th><th>Last Seen</th><th>Actions</th>
            </tr></thead>
            <tbody>${devices.map(_renderRow).join('')}</tbody>
          </table>`}
    </div>`;
  }

  function _renderRow(dev) {
    const st     = STATUS[dev.status] || STATUS.unknown;
    const tMeta  = TYPES[dev.type]   || { label: dev.type, icon: '📦' };
    const cMeta  = CONN[dev.connectionMethod] || { label: dev.connectionMethod, icon: '🔌' };
    const battery = dev.battery != null ? `🔋 ${dev.battery}%` : '';
    const stale   = dev.lastSeen && (_now() - dev.lastSeen) > LAST_SEEN_STALE_MS;

    return `<tr>
      <td>
        <div class="pdm-name">${tMeta.icon} ${_escH(dev.name)}</div>
        <div class="pdm-sub">ID: ${_escH(dev.id.slice(-8))}</div>
      </td>
      <td>${_escH(tMeta.label)}</td>
      <td>${_escH(cMeta.icon)} ${_escH(cMeta.label)}</td>
      <td>${_escH(dev.branchId || '—')} / Till ${_escH(dev.tillId || '—')}</td>
      <td>
        <span class="pdm-dot" style="color:${st.color}">${st.dot}</span>
        <span class="pdm-badge" style="background:${st.color}22;color:${st.color}">${_escH(st.label)}</span>
        ${battery ? `<span style="font-size:11px;color:#9898aa;margin-left:6px">${battery}</span>` : ''}
      </td>
      <td style="font-size:11px;color:${stale?'#ef4444':'#9898aa'}">${dev.lastSeen ? _relTime(dev.lastSeen) : 'Never'}</td>
      <td>
        <div class="pdm-actions">
          ${dev.status === 'disconnected' || dev.status === 'error'
            ? `<button class="pdm-act" onclick="PosDeviceManager._scheduleReconnect('${_escH(dev.id)}')">Reconnect</button>`
            : ''}
          <button class="pdm-act danger" onclick="PosDeviceManager.removeDevice('${_escH(dev.id)}')">Remove</button>
        </div>
      </td>
    </tr>`;
  }

  /* ═══════════════════════════════════════════════════════════
     PAIRING WIZARD MODAL
  ═══════════════════════════════════════════════════════════ */
  function openPairWizard() {
    _injectCSS();
    const ov = document.createElement('div');
    ov.id = 'pdm-wizard';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.87);display:flex;align-items:flex-end;justify-content:center';
    ov.innerHTML = `
      <div style="background:#18181f;border-radius:20px 20px 0 0;width:100%;max-width:480px;padding:20px 20px 36px;font-family:-apple-system,sans-serif;color:#f0f0f6;max-height:90dvh;overflow-y:auto">
        <div style="width:40px;height:4px;background:rgba(255,255,255,.14);border-radius:2px;margin:0 auto 16px"></div>
        <div style="font-size:17px;font-weight:800;margin-bottom:14px">Add Device</div>
        <div style="font-size:12px;color:#9898aa;margin-bottom:12px">Select device category:</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px">
          ${Object.entries(TYPES).map(([k,v]) => `
            <button onclick="PosDeviceManager._wizardSelectType('${k}')" style="padding:12px;border:1px solid rgba(255,255,255,.08);border-radius:11px;background:#1e1e28;color:#f0f0f6;font-size:13px;font-weight:600;cursor:pointer;text-align:left;transition:all .15s" onmouseover="this.style.borderColor='rgba(113,255,0,.3)'" onmouseout="this.style.borderColor='rgba(255,255,255,.08)'">
              <div style="font-size:22px;margin-bottom:4px">${v.icon}</div>
              ${_escH(v.label)}
            </button>`).join('')}
        </div>
        <button onclick="document.getElementById('pdm-wizard').remove()" style="width:100%;padding:12px;background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.18);border-radius:11px;color:#ef4444;font-size:14px;font-weight:700;cursor:pointer">Cancel</button>
      </div>`;
    document.body.appendChild(ov);
  }

  async function _wizardSelectType(type) {
    const ov = document.getElementById('pdm-wizard');
    if (ov) ov.remove();

    const meta = TYPES[type];
    if (!meta) return;

    /* Route to appropriate pairing flow */
    try {
      if (['printer_receipt','printer_barcode','printer_label'].includes(type)) {
        await _pairPrinterFlow(type);
      } else if (['scanner_barcode','scanner_qr'].includes(type)) {
        await registerHIDScanner();
        _toast('HID Scanner registered — plug in your scanner and start scanning', 'success');
      } else if (type === 'scanner_camera') {
        await registerCameraScanner();
        _toast('Camera scanner registered', 'success');
      } else if (type === 'cash_drawer') {
        await registerCashDrawer('bluetooth');
        _toast('Cash drawer registered', 'success');
      } else if (type === 'pdq_terminal') {
        if (window.PosTerminals?.openWizard) PosTerminals.openWizard();
        else _toast('Use Settings → Terminals to add a PDQ terminal', 'info');
      } else if (type === 'softpos') {
        _toast('SoftPOS requires a certified NFC payment SDK from your acquiring bank', 'info');
      }
    } catch (e) {
      _toast('Pairing failed: ' + e.message, 'error');
    }
  }

  async function _pairPrinterFlow(type) {
    const choice = await _showChoiceDialog(
      TYPES[type].label + ' — Choose Connection',
      [
        { value: 'bluetooth', label: '🔵 Bluetooth', desc: 'BLE thermal printer (most common)' },
        { value: 'usb',       label: '🔌 USB',       desc: 'WebUSB (Chrome desktop)' },
        { value: 'network',   label: '📡 Wi-Fi / LAN', desc: 'Enter IP address' },
        { value: 'browser',   label: '💻 Browser',   desc: 'Print via system dialog' },
      ]
    );
    if (!choice) return;

    if (choice === 'bluetooth') await pairBluetoothPrinter(type);
    else if (choice === 'usb')  await pairUSBPrinter(type);
    else if (choice === 'network') {
      const ip = prompt('Enter printer IP address:');
      if (ip) await registerNetworkPrinter(ip.trim(), 9100, type);
    } else {
      if (window.PosPrinter) PosPrinter.connectBrowser();
      await registerManual('Browser Printer', type, 'virtual', {});
    }
    _toast('Device paired successfully', 'success');
  }

  function _showChoiceDialog(title, options) {
    return new Promise(res => {
      const ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.87);display:flex;align-items:flex-end;justify-content:center';
      ov.innerHTML = `
        <div style="background:#18181f;border-radius:20px 20px 0 0;width:100%;max-width:420px;padding:18px 18px 36px;font-family:-apple-system,sans-serif;color:#f0f0f6">
          <div style="font-size:16px;font-weight:800;margin-bottom:12px">${_escH(title)}</div>
          ${options.map(o => `
            <button data-val="${_escH(o.value)}" style="width:100%;margin-bottom:8px;padding:12px 14px;border:1px solid rgba(255,255,255,.08);border-radius:11px;background:#1e1e28;color:#f0f0f6;font-size:13px;font-weight:600;cursor:pointer;text-align:left;display:flex;flex-direction:column;gap:2px">
              <span>${_escH(o.label)}</span>
              <span style="font-size:11px;color:#9898aa;font-weight:400">${_escH(o.desc)}</span>
            </button>`).join('')}
          <button style="width:100%;margin-top:4px;padding:12px;background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.18);border-radius:11px;color:#ef4444;font-size:14px;font-weight:700;cursor:pointer" data-val="">Cancel</button>
        </div>`;
      ov.addEventListener('click', e => {
        const btn = e.target.closest('[data-val]');
        if (!btn) return;
        ov.remove();
        res(btn.dataset.val || null);
      });
      document.body.appendChild(ov);
    });
  }

  /* ═══════════════════════════════════════════════════════════
     BATTERY UPDATE (for devices that report it)
  ═══════════════════════════════════════════════════════════ */
  function updateBattery(id, percent) {
    const dev = _registry.get(id);
    if (!dev) return;
    dev.battery = percent;
    _save(dev);
    _renderUI();
  }

  /* ═══════════════════════════════════════════════════════════
     INIT
  ═══════════════════════════════════════════════════════════ */
  async function init() {
    if (_initialized) return;
    _initialized = true;

    /* Load persisted devices */
    const saved = await _load();
    for (const dev of saved) {
      /* Restore as disconnected (require re-pair for live connections) */
      const restored = {
        ...dev,
        status: dev.connectionMethod === 'virtual' || dev.connectionMethod === 'keyboard' || dev.connectionMethod === 'camera'
          ? 'connected'
          : 'disconnected',
      };
      _registry.set(dev.id, restored);
    }

    /* Auto-restore Bluetooth devices that were previously paired */
    if (navigator.bluetooth?.getDevices) {
      try {
        const btDevices = await navigator.bluetooth.getDevices();
        for (const btDev of btDevices) {
          /* Find matching registered device */
          for (const [id, reg] of _registry) {
            if (reg.connectionMethod === 'bluetooth' && reg.meta?.btName === btDev.name) {
              reg._btDevice = btDev;
              btDev.addEventListener('gattserverdisconnected', () => {
                _setStatus(id, 'disconnected');
                _scheduleReconnect(id);
              });
              /* Attempt silent reconnect */
              btDev.gatt.connect()
                .then(() => _setStatus(id, 'connected'))
                .catch(() => { /* will reconnect on demand */ });
            }
          }
        }
      } catch (_) {}
    }

    /* Auto-restore USB devices */
    if (navigator.usb?.getDevices) {
      try {
        const usbDevices = await navigator.usb.getDevices();
        for (const usbDev of usbDevices) {
          for (const [id, reg] of _registry) {
            if (reg.connectionMethod === 'usb') {
              reg._usbDevice = usbDev;
              usbDev.open().then(() => _setStatus(id, 'connected')).catch(() => {});
            }
          }
        }
      } catch (_) {}
    }

    /* Sync with PosTerminals PDQ devices */
    if (window.PosTerminals) {
      try {
        const terminals = await PosTerminals.devices.all();
        for (const t of terminals) {
          if (!_registry.has(t.id)) {
            _registry.set(t.id, { ...t, type: t.type || 'pdq_terminal' });
          }
        }
      } catch (_) {}
    }

    /* Register built-in camera scanner if BarcodeDetector available */
    const hasCam = [..._registry.values()].some(d => d.type === 'scanner_camera');
    if (!hasCam && ('BarcodeDetector' in window)) {
      await registerCameraScanner();
    }

    _startHealthMonitor();
    _renderUI();
    console.info('[PDM] Device Manager initialized —', _registry.size, 'devices loaded');
    _emit('ready', { count: _registry.size });
  }

  /* Auto-init */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ═══════════════════════════════════════════════════════════
     PUBLIC API
  ═══════════════════════════════════════════════════════════ */
  return {
    /* Init */
    init,
    mountUI,
    /* Discovery */
    pairBluetoothPrinter,
    pairUSBPrinter,
    registerNetworkPrinter,
    registerCameraScanner,
    registerHIDScanner,
    registerCashDrawer,
    registerPDQ,
    registerManual,
    /* Management */
    removeDevice,
    assign,
    heartbeat,
    updateBattery,
    /* Queries */
    getAll,
    getByType,
    getForTill,
    getActiveReceiptPrinter,
    getActiveBarcodeScanner,
    /* Health */
    runHealthCheck,
    _pollHealth,
    /* UI */
    openPairWizard,
    _renderUI,
    _wizardSelectType,
    _scheduleReconnect,
    /* Events */
    on,
    off,
    /* Expose metadata for commissioning */
    TYPES,
    CONN,
    STATUS,
  };

})();
