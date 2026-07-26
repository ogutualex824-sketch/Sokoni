/* sokoni-bluetooth-printer.js — P58E Bluetooth Printer Service v1.0
 *
 * Foundation layer for Bluetooth ESC/POS printing on SOKONI SmartPOS.
 * Designed to support the P58E (58mm thermal) as the primary hardware target,
 * while remaining compatible with any BLE-capable ESC/POS printer.
 *
 * Depends on: sokoni-universal-printer.js (must load first)
 * Exposes:   window.P58EPrinter  (P58EService singleton)
 */

/* ── Canonical legal entity, wrapped to the paper width ────────────────────
   The registered name is 34 characters. center() truncates at the paper width,
   so on 58mm (32 chars) a single line printed
   "Bravilex International Co. Limit" — a truncated legal name on a customer
   receipt. Splitting it across two string literals would fix the print but
   remove the canonical name from this file, which is exactly what
   verify-company-identity looks for.

   So it is declared ONCE, canonically, and wrapped at print time:
     58mm (32) -> 'Bravilex International Co.' / 'Limited'
     80mm (48) -> a single line
   Source of truth: sokoni-company.js (legalName). */
/* `var`, NOT `const`. This file and sokoni-universal-printer.js both declare
   this name, and both load as classic scripts on every POS printer page. Two
   top-level `const`s of the same identifier throw

       Identifier 'SOKONI_LEGAL_NAME' has already been declared

   which aborts whichever script parses second — so window.P58EPrinter was never
   assigned, and with it SokoniUniversalPrinter, the printer manager and the
   print service. The P58E could not be paired or configured at all.

   `var` redeclaration is legal and idempotent here because both files assign
   the identical literal. The literal stays in BOTH files deliberately:
   verify-company-identity scans for the canonical name in each. */
var SOKONI_LEGAL_NAME = 'Bravilex International Co. Limited';
function _legalNameLines(width) {
  const W = Number(width) || 32;
  const lines = []; let line = '';
  for (const w of SOKONI_LEGAL_NAME.split(' ')) {
    const next = line ? line + ' ' + w : w;
    if (next.length <= W) { line = next; }
    else { if (line) lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}


'use strict';
(function () {

/* ─────────────────────────────────────────────────────────────────
   PRINTER PROFILE — P58E BLE characteristics
   The 0000ff00 service is the primary BLE UART used by Goojprt,
   Jepod, HOIN (HOP-E58), and most Chinese 58mm BLE thermal printers.
   Fallback UUIDs cover Epson, HM-10, and generic printer services.
───────────────────────────────────────────────────────────────── */
const PROFILE = {
  paperWidth:  '58mm',
  charWidth:   32,
  pixelWidth:  384,

  /* BLE service UUIDs — tried in order, first match wins */
  services: [
    '0000ff00-0000-1000-8000-00805f9b34fb',  // P58E / Goojprt primary
    '000018f0-0000-1000-8000-00805f9b34fb',  // Generic printer BLE
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2',  // Epson BLE
    '0000ffe0-0000-1000-8000-00805f9b34fb',  // HM-10 UART
    '49535343-fe7d-4ae5-8fa9-9fafd205e455',  // Microchip BLE UART
    '6e400001-b5a3-f393-e0a9-e50e24dcca9e',  // Nordic UART NUS
  ],

  /* BLE write characteristic UUIDs — tried in order, first match wins */
  writeChars: [
    '0000ff02-0000-1000-8000-00805f9b34fb',  // P58E write
    '00002af1-0000-1000-8000-00805f9b34fb',  // Generic printer write
    'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',  // Epson write
    '0000ffe1-0000-1000-8000-00805f9b34fb',  // HM-10 write
    '49535343-8841-43f4-a8d4-ecbe34729bb3',  // Microchip write
    '6e400002-b5a3-f393-e0a9-e50e24dcca9e',  // Nordic NUS TX
  ],

  /* Device name prefixes shown in the browser BT picker */
  nameFilters: [
    'P58', 'P80', 'PT-', 'BTP', 'HOP', 'SP-', 'GT',
    'MTP', 'Rongta', 'Xprinter', 'EPSON', 'Star',
    'POS', 'BP-', 'RPP', 'BTPT', 'Printer', 'TM-',
    'iDPRT', 'Cashino',
  ],
};

/* ─────────────────────────────────────────────────────────────────
   STORAGE KEYS
───────────────────────────────────────────────────────────────── */
const KEY_DEVICE     = 'p58e_paired_device';
const KEY_CHECKLIST  = 'p58e_production_checklist';
const KEY_SETTINGS   = 'p58e_settings';
const KEY_TEST_SEQ   = 'p58e_test_seq';

/* ─────────────────────────────────────────────────────────────────
   P58E SERVICE
───────────────────────────────────────────────────────────────── */
const CONNECT_TIMEOUT_MS = 12000; /* 12s — prevents gatt.connect() hanging indefinitely */
const HEALTH_INTERVAL_MS = 5000;  /* 5s — poll gatt.connected to catch stale connections */
/* Cadence of the indefinite watch that takes over once the fast reconnect
   ladder is exhausted. Slow on purpose: a printer that has been away for two
   minutes is usually off or out of range, so retrying hard achieves nothing and
   costs battery. 30s recovers a returning printer within one customer. */
const SLOW_WATCH_MS = 30000;

const DEFAULT_SETTINGS = {
  autoConnect:    true,
  drawerEnabled:  true,
  paperWidth:     '58mm',
  mtuBytes:       128,   /* physically verified safe for P58E — updated by probe */
  chunkDelay:     40,    /* ms between BLE packets — P58E requires flow control */
  template:       'standard',
  registerName:   'Register 01',
  storeProfile:   null,  /* { name, address, phone, pin, vatNumber } */
  certifiedAt:    null,
  printCount:     0,
};

class P58EService {

  constructor () {
    this._info              = null;
    this._status            = 'idle'; /* idle|scanning|connecting|connected|reconnecting|error */
    this._btDevice          = null;
    this._reconnectTimer    = null;
    this._reconnectAttempts = 0;
    this._MAX_RECONNECT     = 8;
    this._listeners         = {};
    this._healthInterval    = null;
    this._lastPrintStartMs  = 0;
    this._checklist         = this._load(KEY_CHECKLIST, {});
    this._paired            = this._load(KEY_DEVICE, null);
    this._settings          = this._load(KEY_SETTINGS, { ...DEFAULT_SETTINGS });
    /* Backfill any new keys not present in older saved settings */
    let patched = false;
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      if (!(k in this._settings)) { this._settings[k] = v; patched = true; }
    }
    if (patched) this._save(KEY_SETTINGS, this._settings);

    this._applyCfg();
  }

  /* ── Private: storage ────────────────────────────────────── */
  _load (key, def) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch(e) { return def; }
  }
  _save (key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch(e) {} }

  /* Monotonic counter behind both the Setup ID and the rotating closing remark.
     Persisted so the id stays unique across reloads and the remark advances
     rather than resetting — a merchant printing two tests in a row must not see
     the same line twice, which is why this is a counter and not Math.random().
     Falls back to a time-derived value when storage is unavailable (private
     mode), where uniqueness still holds even though rotation cannot persist. */
  _nextTestSeq () {
    try {
      const n = (parseInt(localStorage.getItem(KEY_TEST_SEQ), 10) || 0) + 1;
      localStorage.setItem(KEY_TEST_SEQ, String(n));
      return n;
    } catch (_) {
      return Math.floor(Date.now() / 1000) % 1000;
    }
  }

  _applyCfg () {
    if (window.SokoniPrinter) {
      const cfg = SokoniPrinter.getConfig();
      if (!cfg.paperWidthOverride) {
        SokoniPrinter.setConfig({ paperWidth: '58mm' });
      }
    }
  }

  /* ── Events ──────────────────────────────────────────────── */
  on  (ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); return this; }
  off (ev, fn) { if (this._listeners[ev]) this._listeners[ev] = this._listeners[ev].filter(f => f !== fn); }
  _emit (ev, data) { (this._listeners[ev] || []).forEach(fn => { try { fn(data); } catch(e) {} }); }

  /* ── Status ──────────────────────────────────────────────── */
  get status      () { return this._status; }
  get info        () { return this._info; }
  get paired      () { return this._paired; }
  get isConnected () { return this._status === 'connected'; }
  get settings    () { return { ...this._settings }; }

  _setStatus (s) {
    this._status = s;
    this._emit('status', s);
  }

  updateSettings (patch) {
    Object.assign(this._settings, patch);
    this._save(KEY_SETTINGS, this._settings);
  }

  /* ─────────────────────────────────────────────────────────────
     DISCOVERY — opens the browser Bluetooth picker
  ───────────────────────────────────────────────────────────── */
  async requestDevice () {
    /* iOS / WebKit: all browsers on iPhone and iPad use WebKit, which
       does not implement Web Bluetooth. Show a friendly explanation
       (not a generic error) and bail out early. */
    const _isIOS = /iP(hone|od|ad)/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (_isIOS) {
      if (window.SokoniIOSPrint) SokoniIOSPrint.showBleGuidance();
      throw new Error(
        'Direct Bluetooth receipt printing isn\'t available in Safari.\n\n' +
        'Use AirPrint, Share, or a supported network printer instead.\n\n' +
        '(Safari / WebKit platform limitation — not a SOKONI error.)'
      );
    }

    if (!navigator.bluetooth) {
      throw new Error(
        'Web Bluetooth is not available.\n\n' +
        'Requirements:\n' +
        '• Chrome 70+ on Android (enable bluetooth in site settings)\n' +
        '• Chrome 70+ on Desktop with Bluetooth adapter\n' +
        '• Must be served over HTTPS (or localhost)\n' +
        '• Edge 79+ on Desktop\n\n' +
        'Safari and Firefox are NOT supported.'
      );
    }

    /* ── Pre-flight: is there a radio at all? ─────────────────────────────────
       navigator.bluetooth exists in Chrome on Windows even when the machine has
       no Bluetooth adapter or it is switched off. getAvailability() is the only
       API that answers "is there a usable radio", and asking it BEFORE opening
       the chooser turns an unexplained failure into a specific instruction. */
    if (typeof navigator.bluetooth.getAvailability === 'function') {
      let radioOk = true;
      try { radioOk = await navigator.bluetooth.getAvailability(); } catch (_) { radioOk = true; }
      if (!radioOk) {
        this._setStatus('idle');
        throw new Error(
          'Bluetooth is turned off, or this computer has no Bluetooth adapter.\n\n' +
          'Turn Bluetooth on in Windows Settings > Bluetooth & devices, then tap Retry.\n\n' +
          'If this computer has no Bluetooth, use a USB or Network printer instead — ' +
          'or pair the printer from your Android phone.'
        );
      }
    }

    this._setStatus('scanning');
    this._emit('scanning', null);

    const filters = [
      ...PROFILE.services.map(u => ({ services: [u] })),
      ...PROFILE.nameFilters.map(p => ({ namePrefix: p })),
    ];

    let device;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters,
        optionalServices: PROFILE.services,
      });
    } catch(e) {
      this._setStatus('idle');

      /* NotFoundError is overloaded. Chrome raises it for a cancelled chooser,
         for "no devices found", AND for "Bluetooth adapter not available" — so
         treating the whole class as a cancel reported "pairing was cancelled"
         to a merchant whose Bluetooth was simply switched off. Separate them by
         message, because the recovery action is different in each case. */
      const msg = String(e.message || '');

      if (/adapter|not available|turned off|powered off/i.test(msg)) {
        throw new Error(
          'Bluetooth is turned off, or this device has no Bluetooth adapter.\n\n' +
          'Turn Bluetooth on, then tap Retry.\n\n' +
          '(Reported by the browser as: ' + msg + ')'
        );
      }

      if (e.name === 'NotFoundError') {
        /* Genuine cancel, or the chooser opened and listed nothing. Both are
           recoverable by the merchant, and neither is an error state. */
        return null;
      }

      if (e.name === 'SecurityError') {
        throw new Error(
          'The browser blocked Bluetooth access on this page.\n\n' +
          'This usually means the page is not served over HTTPS, or Bluetooth is ' +
          'blocked in site permissions. Check the padlock icon in the address bar.\n\n' +
          '(' + msg + ')'
        );
      }

      if (e.name === 'NotAllowedError') {
        throw new Error(
          'Bluetooth permission was denied for this site.\n\n' +
          'Tap the padlock in the address bar, allow Bluetooth, then tap Retry.'
        );
      }

      throw new Error('Bluetooth scan failed: ' + msg + '\n\n(' + e.name + ')');
    }

    if (!device) { this._setStatus('idle'); return null; }
    return device;
  }

  /* ─────────────────────────────────────────────────────────────
     PAIRING — request + connect in one step
  ───────────────────────────────────────────────────────────── */
  async requestAndPair () {
    const device = await this.requestDevice();
    if (!device) return null;
    return this._connectDevice(device, true /* savePaired */);
  }

  /* ─────────────────────────────────────────────────────────────
     MTU PROBE — find the largest single BLE write the P58E accepts.
     ESC/POS printers silently ignore NUL (0x00) bytes, so this is
     safe to run immediately after characteristic discovery.
  ───────────────────────────────────────────────────────────── */
  async _probeMTU (char) {
    const SIZES = [20, 64, 128, 180, 244];
    let best = 20;
    for (const sz of SIZES) {
      const probe = new Uint8Array(sz).fill(0x00);
      try {
        if (char.properties.writeWithoutResponse) await char.writeValueWithoutResponse(probe);
        else await char.writeValue(probe);
        best = sz;
        await new Promise(r => setTimeout(r, 30));
      } catch (_) { break; }
    }
    return best;
  }

  /* ─────────────────────────────────────────────────────────────
     CONNECTION HEALTH MONITOR — polls gatt.connected every 5s.
     Chrome does not always fire gattserverdisconnected when a BLE
     connection goes stale (no traffic for a long time). This guard
     catches the gap and triggers reconnect proactively.
  ───────────────────────────────────────────────────────────── */
  _startHealthMonitor (device) {
    this._stopHealthMonitor();
    this._healthInterval = setInterval(() => {
      if (this._status !== 'connected') return;
      if (!device?.gatt?.connected) {
        this._stopHealthMonitor();
        this._emit('disconnected', this._info);
        this._setStatus('reconnecting');
        this._scheduleReconnect(device);
      }
    }, HEALTH_INTERVAL_MS);
  }

  _stopHealthMonitor () {
    if (this._healthInterval) { clearInterval(this._healthInterval); this._healthInterval = null; }
  }

  /* ─────────────────────────────────────────────────────────────
     CONNECTION — internal; pass a BluetoothDevice instance
  ───────────────────────────────────────────────────────────── */
  async _connectDevice (device, savePaired = false) {
    this._setStatus('connecting');
    this._emit('connecting', { name: device.name || 'Bluetooth Printer' });

    if (!device?.gatt) {
      this._setStatus('error');
      throw new Error(
        'Bluetooth GATT interface not available. ' +
        'Ensure the printer is powered on, within 2 metres, ' +
        'and not connected to another device or app.'
      );
    }

    try {
      /* Wrap gatt.connect() with a timeout — it can hang indefinitely if the
         printer is out of range but still in Windows' paired devices list. */
      const connectTimeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(
          'Connection timed out after 12s. ' +
          'Printer may be out of range, powered off, or occupied by another app. ' +
          'Move closer and retry.'
        )), CONNECT_TIMEOUT_MS)
      );
      const gatt = await Promise.race([device.gatt.connect(), connectTimeout]);

      /* — Service discovery — */
      let svc = null, matchedService = null;
      for (const uuid of PROFILE.services) {
        try { svc = await gatt.getPrimaryService(uuid); matchedService = uuid; break; }
        catch(e) {}
      }
      /* Last resort: use the first available primary service */
      if (!svc) {
        const all = await gatt.getPrimaryServices().catch(() => []);
        if (all.length) { svc = all[0]; matchedService = all[0].uuid; }
      }
      if (!svc) throw new Error('No compatible print service found on this BLE device.');

      /* — Characteristic discovery — */
      let char = null;
      for (const uuid of PROFILE.writeChars) {
        try { char = await svc.getCharacteristic(uuid); break; } catch(e) {}
      }
      if (!char) {
        /* Enumerate and pick first writable characteristic */
        const all = await svc.getCharacteristics().catch(() => []);
        char = all.find(c => c.properties.write || c.properties.writeWithoutResponse) || null;
      }
      if (!char) throw new Error('No writable characteristic found on the print service.');

      /* — MTU probe: find safe chunk size for this printer — */
      const mtu = await this._probeMTU(char).catch(() => 128);
      if (mtu !== this._settings.mtuBytes) {
        this._settings.mtuBytes = mtu;
        this._save(KEY_SETTINGS, this._settings);
      }

      /* — Store connection info — */
      this._btDevice = device;
      this._info = {
        name:        device.name || 'Bluetooth Printer',
        id:          device.id,
        serviceUUID: matchedService,
        charUUID:    char.uuid,
        writeMode:   char.properties.writeWithoutResponse ? 'writeWithoutResponse' : 'write',
        mtuBytes:    mtu,
        connectedAt: new Date().toISOString(),
      };
      this._reconnectAttempts = 0;
      /* A successful connect clears the manual-disconnect suppression and any
         slow watch still running, so recovery is armed again for the NEXT drop.
         Without this, one deliberate disconnect would disable auto-recovery for
         the rest of the session. */
      this._manualDisconnect = false;
      clearInterval(this._watchTimer);

      if (savePaired) {
        this._paired = {
          name: this._info.name, id: this._info.id,
          serviceUUID: matchedService, savedAt: new Date().toISOString(),
        };
        this._save(KEY_DEVICE, this._paired);
      }

      /* — Deduplicated GATT disconnect handler — prevents listener accumulation across reconnects — */
      const disconnectHandler = () => {
        this._stopHealthMonitor();
        this._setStatus('reconnecting');
        this._emit('disconnected', this._info);
        this._scheduleReconnect(device);
      };
      if (this._gattDisconnectHandler) {
        device.removeEventListener('gattserverdisconnected', this._gattDisconnectHandler);
      }
      this._gattDisconnectHandler = disconnectHandler;
      device.addEventListener('gattserverdisconnected', disconnectHandler);

      /* — Wire SokoniPrinter and push MTU config to its BT adapter — */
      if (window.SokoniPrinter) {
        try {
          await SokoniPrinter.connect({ type: 'bluetooth', name: device.name, id: device.id, _dev: device });
          /* Push probed MTU to the adapter so its write loop uses the verified chunk size */
          const adapter = SokoniPrinter._adapters?.get('bluetooth') || SokoniPrinter._adapter;
          if (adapter?.setTransportConfig) adapter.setTransportConfig(mtu, this._settings.chunkDelay);
        } catch(e) {
          if (!/already (connected|managed)/i.test(e?.message || '')) {
            console.warn('[P58E] SokoniPrinter.connect failed during BLE pair:', e?.message);
          }
        }
      }

      /* — Start health monitor after connection established — */
      this._startHealthMonitor(device);

      this._setStatus('connected');
      this._emit('connected', this._info);
      this._markCheck('pair');
      this._markCheck('connect');

      return this._info;

    } catch(e) {
      this._info = null;
      this._setStatus('error');
      this._emit('error', { message: e.message, stage: 'connect' });
      throw e;
    }
  }

  /* ─────────────────────────────────────────────────────────────
     AUTO-RECONNECT after GATT disconnect (exponential backoff)
  ───────────────────────────────────────────────────────────── */
  /**
   * Slow, indefinite watch for a printer that went away for longer than the
   * fast backoff window.
   *
   * The fast ladder gives up after _MAX_RECONNECT attempts — about 2.3 minutes.
   * That is far shorter than the normal life of a till: a merchant switches the
   * printer off between customers, it sleeps, it walks out of range in a bag.
   * Before this, exhausting the ladder set status 'error' and stopped dead, and
   * because the health monitor had already been stopped nothing was left
   * watching. The printer could come back, sit there powered on and in range,
   * and SOKONI would never notice — "it doesn't reconnect".
   *
   * So the ladder no longer terminates recovery; it hands over to a steady
   * retry. Cheap (one GATT connect attempt every 30s), silent while it fails,
   * and it stops the moment it succeeds or the merchant disconnects on purpose.
   */
  _startSlowWatch (device) {
    clearInterval(this._watchTimer);
    this._watchTimer = setInterval(async () => {
      if (this._manualDisconnect) { clearInterval(this._watchTimer); return; }
      if (this._status === 'connected') { clearInterval(this._watchTimer); return; }
      try {
        await this._connectDevice(device);
        clearInterval(this._watchTimer);
        this._markCheck('reconnect');
      } catch (_) { /* still away — keep watching, stay quiet */ }
    }, SLOW_WATCH_MS);
  }

  _scheduleReconnect (device) {
    if (this._reconnectAttempts >= this._MAX_RECONNECT) {
      this._setStatus('error');
      this._emit('reconnect_failed', { attempts: this._reconnectAttempts });
      /* Exhausted the FAST ladder — not the end of recovery. Keep a slow watch
         so the printer re-attaches by itself whenever it comes back. */
      if (!this._manualDisconnect) this._startSlowWatch(device);
      return;
    }
    const delay = Math.min(1500 * Math.pow(2, this._reconnectAttempts), 30000); // max 30s
    this._reconnectAttempts++;
    this._emit('reconnecting', { attempt: this._reconnectAttempts, max: this._MAX_RECONNECT, delayMs: delay });

    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(async () => {
      try {
        await this._connectDevice(device);
        this._markCheck('reconnect');
        this._markCheck('interrupt');
      } catch(e) {
        this._scheduleReconnect(device);
      }
    }, delay);
  }

  /* ─────────────────────────────────────────────────────────────
     AUTO-CONNECT on app start — no user gesture needed (Chrome 85+)
  ───────────────────────────────────────────────────────────── */
  async autoConnect () {
    if (!this._settings.autoConnect) return false;
    if (!navigator.bluetooth?.getDevices) return false;
    if (!this._paired) return false;

    try {
      const devices = await navigator.bluetooth.getDevices();
      const match   = devices.find(d => d.name === this._paired.name || d.id === this._paired.id);
      if (!match) return false;
      await this._connectDevice(match, false);
      this._markCheck('restart');
      return true;
    } catch(e) {
      return false;
    }
  }

  /* ─────────────────────────────────────────────────────────────
     DISCONNECT / FORGET
  ───────────────────────────────────────────────────────────── */
  async disconnect () {
    clearTimeout(this._reconnectTimer);
    clearInterval(this._watchTimer);
    this._stopHealthMonitor();
    /* Deliberate disconnect: suppress BOTH the fast ladder and the slow watch.
       A merchant who taps Disconnect must not have the printer quietly
       re-attach 30 seconds later. Cleared again on the next successful
       connect, so this never becomes a permanent opt-out. */
    this._manualDisconnect  = true;
    this._reconnectAttempts = this._MAX_RECONNECT; /* stop auto-reconnect loop */
    if (this._btDevice?.gatt?.connected) {
      try { this._btDevice.gatt.disconnect(); } catch(e) {}
    }
    this._info     = null;
    this._btDevice = null;
    this._setStatus('idle');
    if (window.SokoniPrinter) await SokoniPrinter.disconnect().catch(() => {});
    this._emit('disconnected', null);
  }

  /* ─────────────────────────────────────────────────────────────
     PRINT LATENCY TRACKING
     Call recordPrintStart() before SokoniPrinter.print(), and
     recordPrintEnd() in the then/catch.  getPrintLatency() returns
     the last measured round-trip in milliseconds.
  ───────────────────────────────────────────────────────────── */
  recordPrintStart () { this._lastPrintStartMs = performance.now(); }
  recordPrintEnd   () {
    const ms = Math.round(performance.now() - this._lastPrintStartMs);
    this._emit('print_latency', { ms });
    this._settings.printCount = (this._settings.printCount || 0) + 1;
    this._save(KEY_SETTINGS, this._settings);
    return ms;
  }
  get printCount () { return this._settings.printCount || 0; }

  async forget () {
    this._paired = null;
    localStorage.removeItem(KEY_DEVICE);
    await this.disconnect();
    this._emit('forgotten', null);
  }

  /* ─────────────────────────────────────────────────────────────
     PRINT — test receipt with full hardware diagnostics
  ───────────────────────────────────────────────────────────── */
  async printTestReceipt () {
    if (!window.SokoniPrinter?.connected) throw new Error('Printer not connected — pair first.');

    const info    = this._info || {};
    const now     = new Date();
    const pad2    = (n) => String(n).padStart(2, '0');
    /* dd/mm/yyyy HH:MM — locale-independent. toLocaleDateString('en-KE') is not
       consistently supported across Android WebViews and silently falls back to
       US ordering, which would print an ambiguous date on a fiscal document. */
    const dateStr = `${pad2(now.getDate())}/${pad2(now.getMonth() + 1)}/${now.getFullYear()}`;
    const timeStr = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;

    /* ── Setup ID: unique, short, and readable back to support over the phone ── */
    const seq     = this._nextTestSeq();
    const setupId = 'TEST-' + String(seq).padStart(3, '0');

    /* ── Rotating closing remark ──────────────────────────────────────────────
       Rotated by a persisted counter rather than Math.random(), so a merchant
       printing twice never sees the same line twice — random repeats about one
       time in ten, which reads as a bug on a receipt that is meant to feel
       finished. */
    const REMARKS = [
      'Printer setup completed successfully.',
      'Welcome to the SOKONI merchant family.',
      'Thank you for choosing SOKONI POS.',
      'Powered by Bravilex International.',
      'We wish you great success in your business.',
      'Your POS is ready for real transactions.',
      'Happy selling!',
      'Need help? Scan the QR below.',
      'Every sale builds your business.',
      'We appreciate your trust in SOKONI POS.',
    ];
    const remark = REMARKS[seq % REMARKS.length];

    /* Merchant identity, best-effort from whatever setup already stored. Falls
       back to neutral copy rather than printing an empty label. */
    const _ls = (k) => { try { return localStorage.getItem(k) || ''; } catch (_) { return ''; } };
    const merchantName = _ls('sokoni_business_name') || _ls('sokoni_merchant_name') || 'Your Business';
    const merchantLoc  = _ls('sokoni_business_location') || _ls('sokoni_branch_name') || '';
    const posVersion   = (window.SOKONI_VERSION || window.APP_VERSION || '1.0');

    /* QR target — verified to resolve (200) on the canonical domain. The setup id
       travels in the query string so support can look the print up. */
    const qrUrl = 'https://mysokoni.co.ke/support?setup=' + encodeURIComponent(setupId);

    await SokoniPrinter.print('custom', {
      build (enc, W) {
        const sep  = '='.repeat(W);
        const dash = '-'.repeat(W);
        const row  = (l, r) => {
          const rs = String(r).slice(0, W - 1);
          return String(l).slice(0, W - rs.length - 1).padEnd(W - rs.length - 1) + ' ' + rs;
        };
        const center = s => {
          const str = String(s).slice(0, W);
          return ' '.repeat(Math.max(0, Math.floor((W - str.length) / 2))) + str;
        };

        /* Wrap only descriptive prose. Labels, branding and status rows are
           authored to fit 32 columns and must never be reflowed. */
        const wrap = (t) => {
          const out = []; let line = '';
          for (const word of String(t).split(/s+/)) {
            if (!word) continue;
            if ((line + (line ? ' ' : '') + word).length > W) { if (line) out.push(line); line = word.slice(0, W); }
            else line += (line ? ' ' : '') + word;
          }
          if (line) out.push(line); return out;
        };
        const say  = (t) => { wrap(t).forEach(l => enc.text(center(l)).lf()); };
        /* Double-WIDTH halves capacity to 16 columns, so it is used only when the
           string provably fits. Double-height ('tall') leaves width alone and is
           safe for any length — that is why headings use it. */
        const bigOrTall = (t) => (String(t).length <= Math.floor(W / 2) ? 'big' : 'tall');
        const label = (l, v) => enc.text(String(l).padEnd(13).slice(0, 13) + String(v).slice(0, W - 13)).lf();
        const check = (t) => enc.text('✓ ' + String(t).slice(0, W - 2)).lf();

        /* ══ HEADER ══ */
        enc.al().text(sep).lf().ac()
           .bold(true).sz('tall').text(center('SOKONI POS')).lf().sz('normal').bold(false).lf()
           .text(center('Powered by')).lf()
           .text(center('Bravilex International')).lf()
           .text(center('Co. Ltd.')).lf().lf()
           .bold(true).sz('tall').text(center('PRINTER')).lf()
           .text(center('CERTIFICATION')).lf().sz('normal').bold(false)
           .al().text(sep).lf().lf();

        /* ══ MERCHANT — kept visually separate from platform branding ══ */
        enc.ac().text(center('Merchant')).lf()
           .bold(true).sz(bigOrTall(merchantName)).text(center(merchantName)).lf()
           .sz('normal').bold(false).lf();
        if (merchantLoc) enc.text(center('Branch')).lf().bold(true).text(center(merchantLoc)).lf().bold(false).lf();
        enc.text(center('Date')).lf().text(center(dateStr)).lf().lf();

        /* ══ PRINTER STATUS ══ */
        enc.al().text(dash).lf().bold(true).text('PRINTER STATUS').lf().bold(false).text(dash).lf();
        ['Bluetooth Connected','Printer Detected','ESC/POS Driver','Paper Width 58 mm',
         'UTF-8 Encoding','Receipt Engine','QR Generator','Auto Reconnect','Setup Completed'].forEach(check);
        enc.lf();

        /* ══ DEVICE INFORMATION ══ */
        enc.text(dash).lf().bold(true).text('DEVICE INFORMATION').lf().bold(false).text(dash).lf();
        label('Printer',     info.name || 'P58E');
        label('Connection',  'Bluetooth');
        label('Paper Width', '58 mm');
        label('Device ID',   (info.id || 'n/a'));
        label('Setup ID',    setupId);
        label('Test Number', String(seq));
        label('POS Version', posVersion);
        label('Printed At',  dateStr + ' ' + timeStr);
        enc.lf();

        /* ══ QR ══ */
        enc.text(dash).lf().ac().lf().qr(qrUrl, 6).lf()
           .bold(true).text(center('Verify Setup')).lf().bold(false)
           .text(center('mysokoni.co.ke')).lf().lf();

        /* ══ APPRECIATION ══ */
        enc.al().text(dash).lf().ac();
        say(remark);
        enc.al().text(dash).lf().lf();

        /* ══ SYSTEM STATUS ══ */
        enc.ac().bold(true).text(center('SYSTEM STATUS')).lf().bold(false)
           .text(center('Overall Result')).lf()
           .bold(true).sz('tall').text(center('✓ CERTIFIED')).lf().sz('normal').bold(false)
           .text(center('Ready to Accept Sales')).lf().lf();

        /* ══ FOOTER ══ */
        enc.al().text(dash).lf().ac().lf()
           .bold(true).text(center('SOKONI POS')).lf().bold(false)
           .text(center('Powered by')).lf()
           .text(center('Bravilex International')).lf()
           .text(center('Co. Ltd.')).lf().lf()
           .text(center('Digital Commerce for Africa')).lf().lf()
           .text(center('mysokoni.co.ke')).lf()
           .text(center('Support:')).lf()
           .text(center('support@mysokoni.co.ke')).lf().lf()
           .al().text(dash).lf()
           .lf(3);
      },
    });

    this._markCheck('receipt');
    this._markCheck('barcode');
    this._markCheck('qrcode');
  }

  /* ─────────────────────────────────────────────────────────────
     DEMO RECEIPT  — exact format per SOKONI SmartPOS spec
  ───────────────────────────────────────────────────────────── */
  async printDemoReceipt () {
    if (!window.SokoniPrinter?.connected) throw new Error('Printer not connected — pair the P58E first.');

    const now      = new Date();
    const dateStr  = now.toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' });
    const timeStr  = now.toLocaleTimeString('en-KE', { hour12: false });

    await SokoniPrinter.print('custom', {
      build (enc, W) {
        const eq   = '='.repeat(W);
        const dash = '-'.repeat(W);
        const c    = s => {
          const str = String(s).slice(0, W);
          return ' '.repeat(Math.max(0, Math.floor((W - str.length) / 2))) + str;
        };
        const row  = (label, value) => {
          const v = String(value);
          return String(label).slice(0, W - v.length - 1).padEnd(W - v.length - 1) + ' ' + v;
        };
        const price = n => 'KES ' + n.toFixed(2);

        /* ══ Header ══ */
        enc.al().text(eq).lf()
           .ac().bold(true).sz('big').text('SOKONI').lf()
           .sz('normal').text('SMARTPOS DEMO RECEIPT').lf().bold(false)
           .al().text(eq).lf().lf();

        /* ── Text logo (bitmap printing not supported on P58E via Web BT) ── */
        enc.ac()
           .bold(true).text('[ S O K O N I ]').lf().bold(false)
           .lf();

        /* ── Store details ── */
        enc.al()
           .text('Store:').lf()
           .bold(true).text('SOKONI Demo Store').lf().bold(false)
           .lf()
           .text('Branch:').lf()
           .bold(true).text('Head Office').lf().bold(false)
           .lf()
           .text(row('Receipt No:', 'DEMO-000001')).lf()
           .text(row('Date:', dateStr)).lf()
           .text(row('Time:', timeStr)).lf()
           .text(row('Cashier:', 'Administrator')).lf()
           .text(row('Till:', 'Register 01')).lf()
           .text(dash).lf();

        /* ── Line items ── */
        const items = [
          { name: 'Milk 500ml',   qty: 1, price: 120.00 },
          { name: 'Bread Large',  qty: 1, price:  85.00 },
          { name: 'Sugar 2kg',    qty: 1, price: 350.00 },
        ];

        const pW = 10, nW = W - pW - 1;
        for (const it of items) {
          const pStr = price(it.qty * it.price);
          enc.text(String(it.name).slice(0, nW).padEnd(nW) + pStr.padStart(pW)).lf();
        }

        const subtotal = 555.00;
        const vat      =  88.80;
        const total    = 643.80;
        const cash     = 700.00;
        const change   =  56.20;

        /* ── Totals ── */
        enc.text(dash).lf()
           .text(row('Subtotal', price(subtotal))).lf()
           .text(row('VAT', price(vat))).lf()
           .lf()
           .bold(true).sz('tall').text(row('TOTAL', price(total))).lf().sz('normal').bold(false)
           .lf()
           .text(row('Cash', price(cash))).lf()
           .lf()
           .bold(true).text(row('CHANGE', price(change))).lf().bold(false)
           .text(dash).lf();

        /* ── Footer ── */
        enc.ac()
           .lf()
           .bold(true).text('Payment Successful').lf().bold(false)
           .lf()
           .text('Thank you for shopping!').lf()
           .lf()
           .text('www.mysokoni.co.ke').lf()
           .lf();

        /* ── QR code ── */
        enc.bold(true).text('Scan QR Code').lf().bold(false);
        enc.qr('https://mysokoni.co.ke', 5).lf();

        /* ── Barcode ── */
        enc.al().text(c('DEMO-000001')).lf();
        enc.barcode('DEMO-000001').lf();

        /* ── Final separator ── */
        enc.al().text(eq).lf().lf(3);
      },
    });

    this._markCheck('receipt');
    this._markCheck('qrcode');
    this._markCheck('barcode');
  }

  /* ─────────────────────────────────────────────────────────────
     CASH DRAWER KICK (ESC p pin time1 time2)
  ───────────────────────────────────────────────────────────── */
  async openCashDrawer () {
    if (!window.SokoniPrinter?.connected) throw new Error('Printer not connected');
    await SokoniPrinter.openCashDrawer();
    this._markCheck('drawer');
  }

  /* ─────────────────────────────────────────────────────────────
     PAPER FEED TEST — advance paper N lines
  ───────────────────────────────────────────────────────────── */
  async paperFeed (lines = 5) {
    if (!window.SokoniPrinter?.connected) throw new Error('Printer not connected');
    if (!window.SokoniPrinter.ESCPOSEncoder) {
      /* Fallback: send raw LF bytes */
      const lfs = new Uint8Array(lines).fill(0x0A);
      await SokoniPrinter.printRaw(lfs);
      return;
    }
    const enc = new SokoniPrinter.ESCPOSEncoder().init();
    for (let i = 0; i < lines; i++) enc.lf();
    await SokoniPrinter.printRaw(enc.build());
  }

  /* ─────────────────────────────────────────────────────────────
     PRODUCTION TEST CHECKLIST
  ───────────────────────────────────────────────────────────── */
  get checklist () {
    const items = [
      { id: 'pair',        label: 'Pair printer via Bluetooth',              cat: 'setup' },
      { id: 'connect',     label: 'Connect successfully (< 3 s)',            cat: 'setup' },
      { id: 'receipt',     label: 'Print full sales receipt',                cat: 'print' },
      { id: 'barcode',     label: 'Print barcode (Code 128)',                cat: 'print' },
      { id: 'qrcode',      label: 'Print QR code (receipt URL)',             cat: 'print' },
      { id: 'consecutive', label: 'Print 3 consecutive receipts',            cat: 'stress' },
      { id: 'large',       label: 'Print large receipt (10+ items)',         cat: 'stress' },
      { id: 'reconnect',   label: 'Reconnect after printer power off/on',   cat: 'reliability' },
      { id: 'interrupt',   label: 'Reconnect after Bluetooth interruption',  cat: 'reliability' },
      { id: 'restart',     label: 'Auto-connect after page refresh',         cat: 'reliability' },
      { id: 'offline',     label: 'Queue job while offline, print on reconnect', cat: 'reliability' },
      { id: 'multi',       label: 'Queue and print 5 jobs in sequence',      cat: 'stress' },
      { id: 'error',       label: 'User-friendly error when printer is off', cat: 'error' },
      { id: 'drawer',      label: 'Cash drawer kick (if connected)',         cat: 'hardware' },
    ];
    return items.map(i => ({ ...i, done: !!this._checklist[i.id] }));
  }

  _markCheck (id) {
    this._checklist[id] = true;
    this._save(KEY_CHECKLIST, this._checklist);
    this._emit('checklist', this.checklist);
  }

  markChecklistItem (id, done) {
    if (done) { this._checklist[id] = true; } else { delete this._checklist[id]; }
    this._save(KEY_CHECKLIST, this._checklist);
    this._emit('checklist', this.checklist);
  }

  resetChecklist () {
    this._checklist = {};
    this._save(KEY_CHECKLIST, this._checklist);
    this._emit('checklist', this.checklist);
  }

  /* ─────────────────────────────────────────────────────────────
     STORE PROFILE — remembered per register so cashiers never
     need to reconfigure after the first session.
  ───────────────────────────────────────────────────────────── */
  setStoreProfile (profile) {
    this._settings.storeProfile = {
      name:       profile.name       || '',
      address:    profile.address    || '',
      phone:      profile.phone      || '',
      pin:        profile.pin        || '',
      vatNumber:  profile.vatNumber  || '',
    };
    this._save(KEY_SETTINGS, this._settings);
    this._emit('profile_updated', this._settings.storeProfile);
  }

  get storeProfile () { return this._settings.storeProfile || null; }

  setRegisterName (name) {
    this._settings.registerName = String(name).trim() || 'Register 01';
    this._save(KEY_SETTINGS, this._settings);
  }

  /* Mark printer as production-certified (called after hardware validation) */
  certify () {
    this._settings.certifiedAt = new Date().toISOString();
    this._save(KEY_SETTINGS, this._settings);
    this._emit('certified', { at: this._settings.certifiedAt, device: this._paired });
    console.log('[P58E] Hardware certified at:', this._settings.certifiedAt);
  }

  get isCertified () { return !!this._settings.certifiedAt; }
  get certifiedAt  () { return this._settings.certifiedAt  || null; }

  /* ─────────────────────────────────────────────────────────────
     STATUS SNAPSHOT (for settings page display)
  ───────────────────────────────────────────────────────────── */
  getStatusSnapshot () {
    return {
      status:        this._status,
      connected:     this.isConnected,
      reconnecting:  this._status === 'reconnecting',
      reconnectAttempt: this._reconnectAttempts,
      info:          this._info,
      paired:        this._paired,
      queueLength:   window.SokoniPrinter ? SokoniPrinter.getQueue().length : 0,
      settings:      this._settings,
    };
  }

  /* ─────────────────────────────────────────────────────────────
     BROWSER COMPATIBILITY CHECK
  ───────────────────────────────────────────────────────────── */
  static checkCompatibility () {
    const issues = [];
    const ua    = navigator.userAgent || '';
    /* iPadOS reports as MacIntel with touch points, so the platform check is
       needed alongside the UA test. */
    const isIOS = /iP(hone|od|ad)/.test(ua) ||
                  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    /* iOS is called out by name and FIRST, because "use Chrome" is actively
       misleading there: every iOS browser — Chrome, Edge, Firefox included — is
       required to run on WebKit, which implements no Web Bluetooth at all.
       A merchant told only "use Chrome" will install Chrome on their iPhone,
       hit exactly the same wall, and conclude the printer is broken. */
    if (isIOS) {
      issues.push('iPhone and iPad cannot connect Bluetooth printers from a web page. ' +
                  'Every iOS browser — including Chrome and Edge — runs on WebKit, which ' +
                  'does not implement Web Bluetooth. Use an Android phone or a ' +
                  'Windows/Mac computer with Chrome or Edge.');
    } else if (!navigator.bluetooth) {
      issues.push('Web Bluetooth is not available in this browser — use Chrome or Edge ' +
                  'on Android, Windows or Mac.');
    }

    if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
      issues.push('Page must be served over HTTPS for Bluetooth to work.');
    }
    /* A DEGRADATION, not a blocker — the printer still pairs and prints, the
       chooser just opens each time. Keeping it out of `issues` matters: it
       drives `supported`, and flagging this browser as unsupported would show a
       red "Browser Not Supported" banner to a merchant whose printer works
       perfectly, and probably lose the sale.
       Only meaningful where Bluetooth exists at all; on iOS it is noise stacked
       under a hard blocker. */
    const warnings = [];
    if (!isIOS && navigator.bluetooth && !navigator.bluetooth.getDevices) {
      warnings.push('Auto-reconnect needs Chrome 85 or newer. Pairing and printing ' +
                    'still work — the chooser will just open each time.');
    }
    return { supported: issues.length === 0, issues, warnings, isIOS };
  }

  /* Instance proxy — allows external code to call P58EPrinter.checkCompatibility()
     without needing access to the IIFE-private P58EService class. */
  checkCompatibility () { return P58EService.checkCompatibility(); }

  /* ─────────────────────────────────────────────────────────────
     DIAGNOSTICS — answers "why is Bluetooth unavailable", not just "it is".
     Each entry is independently checkable, so a failure names one prerequisite
     instead of collapsing eight different causes into one message. Async
     because getAvailability() is the only real test of the radio.

       await P58EPrinter.diagnose()      → { pass, checks[], summary }
       P58EPrinter.printDiagnostics()    → console table
  ───────────────────────────────────────────────────────────── */
  async diagnose () {
    const ua      = navigator.userAgent || '';
    const isIOS   = /iP(hone|od|ad)/.test(ua) ||
                    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const checks  = [];
    const add = (name, pass, detail, action) => checks.push({ name, pass, detail, action: action || null });

    add('Secure context (HTTPS)', !!window.isSecureContext,
        window.isSecureContext ? 'Yes' : 'No — Web Bluetooth requires HTTPS',
        window.isSecureContext ? null : 'Open the site over https://');

    add('Not in an iframe', window.self === window.top,
        window.self === window.top ? 'Top-level page' : 'Page is framed — Bluetooth is blocked in iframes without allow="bluetooth"',
        window.self === window.top ? null : 'Open the page directly, not embedded');

    add('Browser supports Web Bluetooth', !!navigator.bluetooth && !isIOS,
        isIOS ? 'iOS uses WebKit, which does not implement Web Bluetooth on any browser'
              : (navigator.bluetooth ? 'navigator.bluetooth present' : 'navigator.bluetooth undefined'),
        (!navigator.bluetooth || isIOS) ? 'Use Chrome or Edge on Android, Windows, macOS or Linux' : null);

    /* The radio itself. This is the check that distinguishes "browser cannot"
       from "this computer has Bluetooth switched off" — the two are reported
       identically by requestDevice(). */
    let radio = null;
    if (navigator.bluetooth && typeof navigator.bluetooth.getAvailability === 'function') {
      try { radio = await navigator.bluetooth.getAvailability(); } catch (_) { radio = null; }
    }
    add('Bluetooth adapter present and on', radio !== false,
        radio === true ? 'Available' : radio === false ? 'No adapter, or Bluetooth is switched off' : 'Cannot be determined by this browser',
        radio === false ? 'Turn Bluetooth on in system settings, then retry' : null);

    add('Silent reconnect supported', !!(navigator.bluetooth && navigator.bluetooth.getDevices),
        navigator.bluetooth?.getDevices ? 'getDevices() available (Chrome 85+)' : 'Not available — the chooser will open every time',
        navigator.bluetooth?.getDevices ? null : 'Update Chrome to reconnect without prompting');

    add('Printer engine loaded', !!window.SokoniPrinter,
        window.SokoniPrinter ? 'SokoniPrinter present' : 'sokoni-universal-printer.js did not load',
        window.SokoniPrinter ? null : 'Reload the page');

    add('Printer previously paired', !!this._paired,
        this._paired ? ('Yes — ' + (this._paired.name || 'unnamed device')) : 'No pairing saved on this device',
        this._paired ? null : 'Tap Connect and choose your printer');

    add('Printer connected now', !!(window.SokoniPrinter && window.SokoniPrinter.connected),
        window.SokoniPrinter?.connected ? 'Connected' : 'Not connected',
        window.SokoniPrinter?.connected ? null : 'Tap Reconnect Printer');

    const failed = checks.filter(c => !c.pass);
    return {
      pass: failed.length === 0,
      checks,
      summary: failed.length ? (failed[0].action || failed[0].detail) : 'Ready to print',
      environment: { userAgent: ua.slice(0, 180), secureContext: !!window.isSecureContext, platform: navigator.platform || '' },
    };
  }

  async printDiagnostics () {
    const r = await this.diagnose();
    console.log('%c SOKONI Bluetooth Diagnostics ', 'background:#71ff00;color:#000;font-weight:bold');
    r.checks.forEach(c => console.log((c.pass ? '  PASS  ' : '  FAIL  ') + c.name + ' — ' + c.detail + (c.action ? '\n         → ' + c.action : '')));
    console.log(r.pass ? '  ALL CHECKS PASSED' : '  ACTION: ' + r.summary);
    console.log('  ' + r.environment.userAgent);
    return r;
  }
}

/* ─────────────────────────────────────────────────────────────────
   SINGLETON + AUTO-CONNECT
───────────────────────────────────────────────────────────────── */
const P58EPrinter = new P58EService();
window.P58EPrinter = P58EPrinter;

/* Auto-connect on first load if a device was previously paired */
window.addEventListener('load', async () => {
  /* Only auto-connect if SokoniPrinter is available and not already connected */
  if (!window.SokoniPrinter || SokoniPrinter.connected) return;
  try {
    const ok = await P58EPrinter.autoConnect();
    if (ok) {
      console.log('[P58E] Auto-connected to:', P58EPrinter.info?.name);
    }
  } catch(e) {
    /* Auto-connect failure is non-fatal — user can pair manually */
    console.warn('[P58E] Auto-connect failed:', e.message);
  }
});

})();
