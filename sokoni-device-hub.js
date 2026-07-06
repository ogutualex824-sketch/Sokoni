/* ================================================================
   SOKONI SmartPOS 2.0 — Universal Device Hub
   sokoni-device-hub.js  v1.0  (2026-07-06)

   Unified plug-and-play peripheral management for:
     • USB   (WebUSB API)
     • Bluetooth  (Web Bluetooth API)
     • Serial / COM  (Web Serial API)
     • Network (HTTP ping / mDNS broadcast)
     • Virtual (software-only: BroadcastChannel, camera)

   Manages printers, scanners, payment terminals, cash drawers,
   customer displays, and any future peripherals.

   Public API: window.SokoniDeviceHub
   Events: 'connected' | 'disconnected' | 'discovered' | 'error'
           | 'health_change' | 'all' (wildcard)
================================================================ */
(function (root) {
  'use strict';

  /* ── Constants ─────────────────────────────────────────────── */

  const HUB_VERSION  = '1.0.0';
  const STORE_KEY    = 'sdk_device_registry';
  const HEALTH_TICK  = 30_000;   // 30s health check interval
  const RECONNECT_BASE_MS = 3_000;
  const RECONNECT_MAX_MS  = 60_000;
  const MAX_RECONNECT_ATTEMPTS = 8;

  /* Device types */
  const TYPE = {
    PRINTER:          'printer',
    SCANNER:          'scanner',
    PAYMENT_TERMINAL: 'payment_terminal',
    CASH_DRAWER:      'cash_drawer',
    CUSTOMER_DISPLAY: 'customer_display',
    WEIGHT_SCALE:     'weight_scale',
    LABEL_PRINTER:    'label_printer',
    CARD_READER:      'card_reader',
    UNKNOWN:          'unknown',
  };

  /* Transport layers */
  const TRANSPORT = {
    USB:       'usb',
    BLUETOOTH: 'bluetooth',
    SERIAL:    'serial',
    NETWORK:   'network',
    VIRTUAL:   'virtual',
  };

  /* Connection states */
  const STATE = {
    DISCOVERED:   'discovered',
    CONNECTING:   'connecting',
    CONNECTED:    'connected',
    DISCONNECTING:'disconnecting',
    DISCONNECTED: 'disconnected',
    ERROR:        'error',
    RECONNECTING: 'reconnecting',
  };

  /* ── Known USB Vendor / Product ID → Device Profile Map ────── */
  /* A subset of common POS peripherals. Used for auto-type detection. */
  const USB_VID_MAP = {
    /* Printers */
    0x04b8: { type: TYPE.PRINTER,  vendor: 'Epson',     protocol: 'escpos' },
    0x0dd4: { type: TYPE.PRINTER,  vendor: 'Custom',    protocol: 'escpos' },
    0x0fe6: { type: TYPE.PRINTER,  vendor: 'ICS Advent',protocol: 'escpos' },
    0x067b: { type: TYPE.PRINTER,  vendor: 'Prolific',  protocol: 'escpos' },
    0x0519: { type: TYPE.PRINTER,  vendor: 'Zebra',     protocol: 'zpl'   },
    0x0a5f: { type: TYPE.PRINTER,  vendor: 'Zebra',     protocol: 'zpl'   },
    0x154f: { type: TYPE.PRINTER,  vendor: 'STAR',      protocol: 'star'  },
    0x0416: { type: TYPE.PRINTER,  vendor: 'Winbond',   protocol: 'escpos' },
    /* Scanners */
    0x05e0: { type: TYPE.SCANNER,  vendor: 'Symbol/Zebra', protocol: 'hid' },
    0x0c2e: { type: TYPE.SCANNER,  vendor: 'Honeywell',    protocol: 'hid' },
    0x08ff: { type: TYPE.SCANNER,  vendor: 'AuthenTec',    protocol: 'hid' },
    0x0483: { type: TYPE.SCANNER,  vendor: 'Datalogic',    protocol: 'hid' },
    0x0536: { type: TYPE.SCANNER,  vendor: 'Hand Held',    protocol: 'hid' },
    0x0b00: { type: TYPE.SCANNER,  vendor: 'Metrologic',   protocol: 'hid' },
    /* Payment terminals */
    0x0603: { type: TYPE.PAYMENT_TERMINAL, vendor: 'Ingenico', protocol: 'ingenico' },
    0x16ae: { type: TYPE.PAYMENT_TERMINAL, vendor: 'Verifone', protocol: 'verifone' },
    0x1220: { type: TYPE.PAYMENT_TERMINAL, vendor: 'PAX',      protocol: 'pax'      },
    0x0b97: { type: TYPE.PAYMENT_TERMINAL, vendor: 'O2Micro',  protocol: 'generic'  },
    /* Cash drawers */
    0x0425: { type: TYPE.CASH_DRAWER, vendor: 'APG',   protocol: 'drawer' },
    0x07da: { type: TYPE.CASH_DRAWER, vendor: 'Adesso', protocol: 'drawer' },
  };

  /* Bluetooth service UUIDs for known POS devices */
  const BT_SERVICE_MAP = {
    '00001101-0000-1000-8000-00805f9b34fb': { type: TYPE.PRINTER,  vendor: 'Generic BT Printer', protocol: 'escpos' },
    '00001124-0000-1000-8000-00805f9b34fb': { type: TYPE.SCANNER,  vendor: 'Generic BT Scanner', protocol: 'hid'    },
    '000018f0-0000-1000-8000-00805f9b34fb': { type: TYPE.PRINTER,  vendor: 'Generic BT Printer', protocol: 'escpos' },
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2': { type: TYPE.PRINTER,  vendor: 'Xprinter BT',        protocol: 'escpos' },
    '49535343-fe7d-4ae5-8fa9-9fafd205e455': { type: TYPE.PRINTER,  vendor: 'Issc BT Serial',     protocol: 'escpos' },
    '0000fff0-0000-1000-8000-00805f9b34fb': { type: TYPE.SCANNER,  vendor: 'BT Scanner SPP',     protocol: 'hid'    },
  };

  /* ── Utility ────────────────────────────────────────────────── */

  function genId() {
    return 'dev_' + Math.random().toString(36).slice(2, 11) + '_' + Date.now().toString(36);
  }

  function now() { return new Date().toISOString(); }

  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

  function backoff(attempt) {
    return clamp(RECONNECT_BASE_MS * Math.pow(2, attempt), RECONNECT_BASE_MS, RECONNECT_MAX_MS);
  }

  /* ── DeviceProfile ──────────────────────────────────────────── */

  class DeviceProfile {
    constructor(data) {
      this.id          = data.id       || genId();
      this.type        = data.type     || TYPE.UNKNOWN;
      this.transport   = data.transport;
      this.name        = data.name     || 'Unknown Device';
      this.vendor      = data.vendor   || '';
      this.model       = data.model    || '';
      this.protocol    = data.protocol || '';
      this.status      = data.status   || STATE.DISCOVERED;
      this.config      = data.config   || {};
      this.nativeDevice= data.nativeDevice || null;  /* underlying USB/BT/Serial handle */
      this.lastSeen    = data.lastSeen || now();
      this.connectedAt = data.connectedAt || null;
      this.error       = data.error   || null;
      this._reconnectAttempts = 0;
      this._reconnectTimer    = null;
    }

    toJSON() {
      /* nativeDevice is not serializable; omit from JSON */
      return {
        id: this.id, type: this.type, transport: this.transport,
        name: this.name, vendor: this.vendor, model: this.model,
        protocol: this.protocol, status: this.status,
        config: this.config, lastSeen: this.lastSeen,
        connectedAt: this.connectedAt, error: this.error,
      };
    }
  }

  /* ── Transport Adapters ─────────────────────────────────────── */

  /* Each adapter exposes: discover(), connect(profile), disconnect(profile), ping(profile) */

  const UsbAdapter = {
    available() { return !!navigator.usb; },

    async discover() {
      if (!this.available()) return [];
      try {
        const devices = await navigator.usb.getDevices();
        return devices.map(d => this._toProfile(d));
      } catch { return []; }
    },

    async requestNew() {
      if (!this.available()) throw new Error('WebUSB not supported');
      const device = await navigator.usb.requestDevice({ filters: [] });
      return this._toProfile(device);
    },

    _toProfile(d) {
      const hint = USB_VID_MAP[d.vendorId] || {};
      return new DeviceProfile({
        type:       hint.type      || TYPE.UNKNOWN,
        transport:  TRANSPORT.USB,
        name:       d.productName || `USB ${d.vendorId.toString(16)}:${d.productId.toString(16)}`,
        vendor:     d.manufacturerName || hint.vendor || '',
        model:      d.productName || '',
        protocol:   hint.protocol || '',
        config:     { vendorId: d.vendorId, productId: d.productId, serialNumber: d.serialNumber },
        nativeDevice: d,
      });
    },

    async connect(profile) {
      const dev = profile.nativeDevice;
      if (!dev) throw new Error('No native USB device handle');
      await dev.open();
      if (dev.configuration === null) await dev.selectConfiguration(1);
      await dev.claimInterface(0);
      profile.connectedAt = now();
    },

    async disconnect(profile) {
      const dev = profile.nativeDevice;
      if (!dev) return;
      try { await dev.releaseInterface(0); } catch {}
      try { await dev.close(); } catch {}
    },

    async ping(profile) {
      const dev = profile.nativeDevice;
      if (!dev) return false;
      return dev.opened;
    },
  };

  const BluetoothAdapter = {
    available() { return !!navigator.bluetooth; },

    async discover() {
      if (!this.available()) return [];
      /* getDevices() returns previously paired devices (no user prompt) */
      try {
        const devices = await navigator.bluetooth.getDevices();
        return devices.map(d => this._toProfile(d));
      } catch { return []; }
    },

    async requestNew(deviceType) {
      if (!this.available()) throw new Error('Web Bluetooth not supported');
      const filters = [];
      /* Narrow the BT scan based on intended device type */
      if (deviceType === TYPE.PRINTER)  filters.push({ services: [0x18F0] });
      if (deviceType === TYPE.SCANNER)  filters.push({ services: [0x1124] });
      if (deviceType === TYPE.PAYMENT_TERMINAL) filters.push({ services: [0x1101] });
      const device = await navigator.bluetooth.requestDevice({
        filters:   filters.length ? filters : undefined,
        acceptAllDevices: !filters.length,
        optionalServices: ['0000fff0-0000-1000-8000-00805f9b34fb',
                           '00001101-0000-1000-8000-00805f9b34fb'],
      });
      return this._toProfile(device);
    },

    _toProfile(d) {
      return new DeviceProfile({
        type:      TYPE.UNKNOWN,
        transport: TRANSPORT.BLUETOOTH,
        name:      d.name || 'Bluetooth Device',
        vendor:    '',
        model:     d.name || '',
        config:    { id: d.id },
        nativeDevice: d,
      });
    },

    async connect(profile) {
      const dev = profile.nativeDevice;
      if (!dev) throw new Error('No native Bluetooth device');
      const server = await dev.gatt.connect();
      profile.config._gattServer = server;
      profile.connectedAt = now();

      /* Auto-detect type from primary service */
      try {
        const services = await server.getPrimaryServices();
        for (const svc of services) {
          const hint = BT_SERVICE_MAP[svc.uuid];
          if (hint) { profile.type = hint.type; profile.protocol = hint.protocol; break; }
        }
      } catch {}

      dev.addEventListener('gattserverdisconnected', () => {
        profile.status = STATE.DISCONNECTED;
      });
    },

    async disconnect(profile) {
      const dev = profile.nativeDevice;
      if (dev && dev.gatt.connected) dev.gatt.disconnect();
    },

    async ping(profile) {
      const dev = profile.nativeDevice;
      return !!(dev && dev.gatt && dev.gatt.connected);
    },
  };

  const SerialAdapter = {
    available() { return !!navigator.serial; },

    async discover() {
      if (!this.available()) return [];
      try {
        const ports = await navigator.serial.getPorts();
        return ports.map(p => this._toProfile(p));
      } catch { return []; }
    },

    async requestNew() {
      if (!this.available()) throw new Error('Web Serial not supported');
      const port = await navigator.serial.requestPort();
      return this._toProfile(port);
    },

    _toProfile(p) {
      const info = p.getInfo ? p.getInfo() : {};
      const hint = USB_VID_MAP[info.usbVendorId] || {};
      return new DeviceProfile({
        type:      hint.type || TYPE.UNKNOWN,
        transport: TRANSPORT.SERIAL,
        name:      `Serial Port (${info.usbVendorId ? '0x'+info.usbVendorId.toString(16) : 'COM'})`,
        vendor:    hint.vendor || '',
        protocol:  hint.protocol || '',
        config:    { usbVendorId: info.usbVendorId, usbProductId: info.usbProductId, baudRate: 9600 },
        nativeDevice: p,
      });
    },

    async connect(profile) {
      const port = profile.nativeDevice;
      if (!port) throw new Error('No native serial port');
      const baud = profile.config.baudRate || 9600;
      await port.open({ baudRate: baud });
      profile.connectedAt = now();
    },

    async disconnect(profile) {
      const port = profile.nativeDevice;
      if (!port) return;
      try { await port.close(); } catch {}
    },

    async ping(profile) {
      const port = profile.nativeDevice;
      return !!(port && port.readable);
    },
  };

  const NetworkAdapter = {
    available() { return true; },

    /* Discover network-based devices by pinging common endpoints */
    async discover(subnets) {
      const found = [];
      /* Check known network printer / terminal endpoints stored in config */
      const saved = _loadNetworkDevices();
      for (const entry of saved) {
        const reachable = await this._ping(entry.endpoint);
        if (reachable) {
          found.push(new DeviceProfile({
            id: entry.id,
            type: entry.type || TYPE.PRINTER,
            transport: TRANSPORT.NETWORK,
            name: entry.name || 'Network Device',
            vendor: entry.vendor || '',
            config: { endpoint: entry.endpoint },
            status: STATE.DISCOVERED,
          }));
        }
      }
      return found;
    },

    async connect(profile) {
      const ok = await this._ping(profile.config.endpoint);
      if (!ok) throw new Error(`Network device unreachable: ${profile.config.endpoint}`);
      profile.connectedAt = now();
    },

    async disconnect(profile) {
      /* HTTP-based devices have no persistent connection to close */
    },

    async ping(profile) {
      return this._ping(profile.config.endpoint);
    },

    async _ping(endpoint) {
      if (!endpoint) return false;
      try {
        const url = endpoint.startsWith('http') ? endpoint + '/status' : 'http://' + endpoint + '/status';
        const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
        return res.ok;
      } catch { return false; }
    },
  };

  /* Load/save network device configs from localStorage */
  function _loadNetworkDevices() {
    try { return JSON.parse(localStorage.getItem('sdk_network_devices') || '[]'); }
    catch { return []; }
  }
  function _saveNetworkDevice(entry) {
    const list = _loadNetworkDevices();
    const idx  = list.findIndex(e => e.endpoint === entry.endpoint);
    if (idx >= 0) list[idx] = entry; else list.push(entry);
    localStorage.setItem('sdk_network_devices', JSON.stringify(list));
  }
  function _removeNetworkDevice(endpoint) {
    const list = _loadNetworkDevices().filter(e => e.endpoint !== endpoint);
    localStorage.setItem('sdk_network_devices', JSON.stringify(list));
  }

  /* ── SokoniDeviceHub ────────────────────────────────────────── */

  class SokoniDeviceHub {
    constructor() {
      this._registry  = new Map();   /* id → DeviceProfile */
      this._listeners = {};
      this._healthTimer = null;
      this._log = [];
      this._adapters = {
        [TRANSPORT.USB]:       UsbAdapter,
        [TRANSPORT.BLUETOOTH]: BluetoothAdapter,
        [TRANSPORT.SERIAL]:    SerialAdapter,
        [TRANSPORT.NETWORK]:   NetworkAdapter,
      };
      this._loadRegistry();
      this._setupNativeEvents();
    }

    /* ── Discovery ─────────────────────────────────────────── */

    /**
     * Scan all available transports for connected peripherals.
     * Returns an array of DeviceProfile objects.
     */
    async discover(types) {
      const discovered = [];
      for (const [transport, adapter] of Object.entries(this._adapters)) {
        if (!adapter.available()) continue;
        try {
          const profiles = await adapter.discover();
          for (const p of profiles) {
            if (types && !types.includes(p.type)) continue;
            if (!this._registry.has(p.id)) this._registry.set(p.id, p);
            discovered.push(p);
            this._emit('discovered', p);
          }
        } catch (err) {
          this._emit('error', { transport, error: err.message });
        }
      }
      this._saveRegistry();
      return discovered;
    },

    /**
     * Show the browser's native device picker for a specific transport.
     * Returns the new DeviceProfile if user selected a device, null otherwise.
     */
    async requestDevice(transport, deviceType) {
      const adapter = this._adapters[transport];
      if (!adapter || !adapter.requestNew) throw new Error(`No requestNew for ${transport}`);
      try {
        const profile = await adapter.requestNew(deviceType);
        this._registry.set(profile.id, profile);
        this._saveRegistry();
        this._emit('discovered', profile);
        return profile;
      } catch (err) {
        if (err.name === 'NotFoundError') return null;  /* user cancelled */
        throw err;
      }
    },

    /**
     * Add a network device by endpoint URL.
     */
    addNetworkDevice(name, endpoint, type) {
      const id = genId();
      _saveNetworkDevice({ id, name, endpoint, type });
      const profile = new DeviceProfile({
        id, type: type || TYPE.PRINTER,
        transport: TRANSPORT.NETWORK,
        name, config: { endpoint },
      });
      this._registry.set(id, profile);
      this._saveRegistry();
      this._emit('discovered', profile);
      return profile;
    },

    removeNetworkDevice(endpoint) {
      _removeNetworkDevice(endpoint);
      for (const [id, p] of this._registry) {
        if (p.transport === TRANSPORT.NETWORK && p.config.endpoint === endpoint) {
          this._registry.delete(id);
        }
      }
      this._saveRegistry();
    },

    /* ── Connection ────────────────────────────────────────── */

    /**
     * Connect to a registered device.
     */
    async connect(deviceId) {
      const profile = this._registry.get(deviceId);
      if (!profile) throw new Error(`Device ${deviceId} not found`);
      const adapter  = this._adapters[profile.transport];
      if (!adapter) throw new Error(`No adapter for ${profile.transport}`);

      profile.status = STATE.CONNECTING;
      profile.error  = null;
      this._emit('status_change', profile);

      try {
        await adapter.connect(profile);
        profile.status  = STATE.CONNECTED;
        profile.lastSeen= now();
        profile._reconnectAttempts = 0;
        this._saveRegistry();
        this._emit('connected', profile);
        this._audit('connected', profile);
        return profile;
      } catch (err) {
        profile.status = STATE.ERROR;
        profile.error  = err.message;
        this._emit('error', { device: profile, error: err.message });
        throw err;
      }
    },

    /**
     * Disconnect a device gracefully.
     */
    async disconnect(deviceId) {
      const profile = this._registry.get(deviceId);
      if (!profile) return;
      const adapter = this._adapters[profile.transport];
      if (!adapter) return;

      profile.status = STATE.DISCONNECTING;
      this._emit('status_change', profile);

      try {
        await adapter.disconnect(profile);
      } catch {}
      profile.status = STATE.DISCONNECTED;
      profile.connectedAt = null;
      this._saveRegistry();
      this._emit('disconnected', profile);
      this._audit('disconnected', profile);
    },

    async disconnectAll() {
      const ids = [...this._registry.keys()];
      for (const id of ids) {
        const p = this._registry.get(id);
        if (p && p.status === STATE.CONNECTED) {
          await this.disconnect(id).catch(() => {});
        }
      }
    },

    /**
     * Forget a device entirely from the registry.
     */
    async remove(deviceId) {
      await this.disconnect(deviceId).catch(() => {});
      this._registry.delete(deviceId);
      this._saveRegistry();
      this._audit('removed', { id: deviceId });
    },

    /* ── Registry ──────────────────────────────────────────── */

    getDevices()              { return [...this._registry.values()]; }
    getDevice(id)             { return this._registry.get(id) || null; }
    getDevicesByType(type)    { return this.getDevices().filter(d => d.type === type); }
    getConnectedDevices()     { return this.getDevices().filter(d => d.status === STATE.CONNECTED); }
    getDevicesByTransport(t)  { return this.getDevices().filter(d => d.transport === t); }
    isConnected(deviceId)     { const d = this.getDevice(deviceId); return d?.status === STATE.CONNECTED; }

    getHealth() {
      const devices = this.getDevices();
      const connected    = devices.filter(d => d.status === STATE.CONNECTED).length;
      const disconnected = devices.filter(d => d.status === STATE.DISCONNECTED).length;
      const errors       = devices.filter(d => d.status === STATE.ERROR).length;
      const reconnecting = devices.filter(d => d.status === STATE.RECONNECTING).length;
      return { total: devices.length, connected, disconnected, errors, reconnecting };
    },

    /* ── Health Monitoring ──────────────────────────────────── */

    startMonitoring() {
      if (this._healthTimer) return;
      this._healthTimer = setInterval(() => this._healthCheck(), HEALTH_TICK);
      this._healthCheck();   /* immediate first check */
    },

    stopMonitoring() {
      if (this._healthTimer) { clearInterval(this._healthTimer); this._healthTimer = null; }
    },

    async _healthCheck() {
      for (const profile of this._registry.values()) {
        if (profile.status !== STATE.CONNECTED) continue;
        const adapter = this._adapters[profile.transport];
        if (!adapter) continue;
        try {
          const alive = await adapter.ping(profile);
          if (alive) {
            profile.lastSeen = now();
          } else {
            profile.status = STATE.DISCONNECTED;
            this._emit('disconnected', profile);
            this._emit('health_change', profile);
            this._scheduleReconnect(profile);
          }
        } catch {
          profile.status = STATE.ERROR;
          this._emit('health_change', profile);
        }
      }
      this._saveRegistry();
    },

    /* ── Auto-reconnect ─────────────────────────────────────── */

    _scheduleReconnect(profile) {
      if (profile._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        profile.status = STATE.ERROR;
        profile.error  = 'Max reconnect attempts reached';
        this._emit('error', { device: profile, error: profile.error });
        return;
      }
      const delay = backoff(profile._reconnectAttempts);
      profile._reconnectAttempts++;
      profile.status = STATE.RECONNECTING;
      this._emit('status_change', profile);

      clearTimeout(profile._reconnectTimer);
      profile._reconnectTimer = setTimeout(async () => {
        try {
          await this.connect(profile.id);
        } catch {
          this._scheduleReconnect(profile);
        }
      }, delay);
    },

    /* ── Native browser events (USB/BT connect/disconnect) ──── */

    _setupNativeEvents() {
      if (navigator.usb) {
        navigator.usb.addEventListener('connect', e => {
          const profile = UsbAdapter._toProfile(e.device);
          if (!this._registry.has(profile.id)) {
            this._registry.set(profile.id, profile);
            this._saveRegistry();
            this._emit('discovered', profile);
          }
        });
        navigator.usb.addEventListener('disconnect', e => {
          for (const [id, p] of this._registry) {
            if (p.transport === TRANSPORT.USB &&
                p.config.vendorId  === e.device.vendorId &&
                p.config.productId === e.device.productId) {
              p.status = STATE.DISCONNECTED;
              this._emit('disconnected', p);
              this._scheduleReconnect(p);
            }
          }
        });
      }
      if (navigator.bluetooth) {
        navigator.bluetooth.addEventListener &&
        navigator.bluetooth.addEventListener('advertisementreceived', () => {});
      }
    },

    /* ── Persistence ─────────────────────────────────────────── */

    _loadRegistry() {
      try {
        const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
        for (const d of raw) {
          const p = new DeviceProfile(d);
          p.status = STATE.DISCONNECTED;  /* assume disconnected on load */
          this._registry.set(p.id, p);
        }
      } catch {}
    },

    _saveRegistry() {
      try {
        const data = this.getDevices().map(d => d.toJSON());
        localStorage.setItem(STORE_KEY, JSON.stringify(data));
      } catch {}
    },

    /* ── Event system ───────────────────────────────────────── */

    on(event, fn) {
      (this._listeners[event] = this._listeners[event] || []).push(fn);
      return this;
    },

    off(event, fn) {
      if (!this._listeners[event]) return this;
      this._listeners[event] = this._listeners[event].filter(f => f !== fn);
      return this;
    },

    _emit(event, data) {
      (this._listeners[event] || []).forEach(fn => { try { fn(data); } catch {} });
      (this._listeners['all']  || []).forEach(fn => { try { fn(event, data); } catch {} });
    },

    /* ── Audit log ──────────────────────────────────────────── */

    _audit(action, device) {
      this._log.push({ ts: now(), action, deviceId: device.id, type: device.type,
                       name: device.name, transport: device.transport });
      if (this._log.length > 500) this._log.shift();
    },

    getAuditLog() { return [...this._log]; },

    /* ── Utility ─────────────────────────────────────────────── */

    getCapabilities() {
      return {
        usb:       UsbAdapter.available(),
        bluetooth: BluetoothAdapter.available(),
        serial:    SerialAdapter.available(),
        network:   true,
        version:   HUB_VERSION,
      };
    },

    /* Quick "first printer" / "first scanner" helpers for POS */
    getPrinter()  { return this.getConnectedDevices().find(d => d.type === TYPE.PRINTER) || null; },
    getScanner()  { return this.getConnectedDevices().find(d => d.type === TYPE.SCANNER) || null; },
    getTerminal() { return this.getConnectedDevices().find(d => d.type === TYPE.PAYMENT_TERMINAL) || null; },
    getCashDrawer() { return this.getConnectedDevices().find(d => d.type === TYPE.CASH_DRAWER) || null; },
    getCustomerDisplay() { return this.getConnectedDevices().find(d => d.type === TYPE.CUSTOMER_DISPLAY) || null; },
  }

  /* ── Singleton ──────────────────────────────────────────────── */

  const instance = new SokoniDeviceHub();

  /* Start health monitoring when page is visible */
  instance.startMonitoring();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) instance.stopMonitoring();
    else instance.startMonitoring();
  });

  /* ── Public exports ─────────────────────────────────────────── */

  root.SokoniDeviceHub  = instance;
  root.SokoniDeviceHub.TYPE      = TYPE;
  root.SokoniDeviceHub.TRANSPORT = TRANSPORT;
  root.SokoniDeviceHub.STATE     = STATE;
  root.SokoniDeviceHub.DeviceProfile = DeviceProfile;

  /* Network device helpers (convenience wrappers) */
  root.SokoniDeviceHub.saveNetworkDevice   = (name, endpoint, type) => instance.addNetworkDevice(name, endpoint, type);
  root.SokoniDeviceHub.removeNetworkDevice = endpoint => instance.removeNetworkDevice(endpoint);

}(window));
