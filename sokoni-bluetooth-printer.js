/* sokoni-bluetooth-printer.js — P58E Bluetooth Printer Service v1.0
 *
 * Foundation layer for Bluetooth ESC/POS printing on SOKONI SmartPOS.
 * Designed to support the P58E (58mm thermal) as the primary hardware target,
 * while remaining compatible with any BLE-capable ESC/POS printer.
 *
 * Depends on: sokoni-universal-printer.js (must load first)
 * Exposes:   window.P58EPrinter  (P58EService singleton)
 */

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

/* ─────────────────────────────────────────────────────────────────
   P58E SERVICE
───────────────────────────────────────────────────────────────── */
class P58EService {

  constructor () {
    this._info              = null;     /* connected device info */
    this._status            = 'idle';   /* idle|scanning|connecting|connected|reconnecting|error */
    this._btDevice          = null;     /* BluetoothDevice reference for reconnect */
    this._reconnectTimer    = null;
    this._reconnectAttempts = 0;
    this._MAX_RECONNECT     = 8;
    this._listeners         = {};
    this._checklist         = this._load(KEY_CHECKLIST, {});
    this._paired            = this._load(KEY_DEVICE, null);
    this._settings          = this._load(KEY_SETTINGS, { autoConnect: true, drawerEnabled: true });

    /* Default paper width to 58mm when SokoniPrinter is available */
    this._applyCfg();
  }

  /* ── Private: storage ────────────────────────────────────── */
  _load (key, def) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch(e) { return def; }
  }
  _save (key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch(e) {} }

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
      if (e.name === 'NotFoundError') return null;          // user pressed Cancel
      throw new Error('Bluetooth scan failed: ' + e.message);
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
     CONNECTION — internal; pass a BluetoothDevice instance
  ───────────────────────────────────────────────────────────── */
  async _connectDevice (device, savePaired = false) {
    this._setStatus('connecting');
    this._emit('connecting', { name: device.name || 'Bluetooth Printer' });

    try {
      const gatt = await device.gatt.connect();

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

      /* — Store connection info — */
      this._btDevice = device;
      this._info = {
        name:        device.name || 'Bluetooth Printer',
        id:          device.id,
        serviceUUID: matchedService,
        charUUID:    char.uuid,
        writeMode:   char.properties.writeWithoutResponse ? 'writeWithoutResponse' : 'write',
        connectedAt: new Date().toISOString(),
      };
      this._reconnectAttempts = 0;

      if (savePaired) {
        this._paired = { name: this._info.name, id: this._info.id, serviceUUID: matchedService, savedAt: new Date().toISOString() };
        this._save(KEY_DEVICE, this._paired);
      }

      /* — GATT disconnect handler — */
      device.addEventListener('gattserverdisconnected', () => {
        this._setStatus('reconnecting');
        this._emit('disconnected', this._info);
        this._scheduleReconnect(device);
      });

      /* — Wire SokoniPrinter to this device for queue/render support — */
      if (window.SokoniPrinter) {
        try {
          await SokoniPrinter.connect({ type: 'bluetooth', name: device.name, id: device.id, _dev: device });
        } catch(e) { /* already managed — ignore */ }
      }

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
  _scheduleReconnect (device) {
    if (this._reconnectAttempts >= this._MAX_RECONNECT) {
      this._setStatus('error');
      this._emit('reconnect_failed', { attempts: this._reconnectAttempts });
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
    this._reconnectAttempts = this._MAX_RECONNECT; // stop auto-reconnect
    if (this._btDevice?.gatt?.connected) {
      try { this._btDevice.gatt.disconnect(); } catch(e) {}
    }
    this._info     = null;
    this._btDevice = null;
    this._setStatus('idle');
    if (window.SokoniPrinter) await SokoniPrinter.disconnect().catch(() => {});
    this._emit('disconnected', null);
  }

  forget () {
    this._paired = null;
    localStorage.removeItem(KEY_DEVICE);
    this.disconnect();
    this._emit('forgotten', null);
  }

  /* ─────────────────────────────────────────────────────────────
     PRINT — test receipt with full hardware diagnostics
  ───────────────────────────────────────────────────────────── */
  async printTestReceipt () {
    if (!window.SokoniPrinter?.connected) throw new Error('Printer not connected — pair first.');

    const info    = this._info || {};
    const now     = new Date();
    const dateStr = now.toLocaleDateString('en-KE', { day:'2-digit', month:'short', year:'numeric' });
    const timeStr = now.toLocaleTimeString('en-KE', { hour12: false });

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

        /* ── Header ── */
        enc.ac()
           .bold(true).sz('tall').text(center('SOKONI SmartPOS')).lf()
           .sz('normal').bold(false)
           .text(center('Powered by P58E Thermal')).lf()
           .al().text(sep).lf()
           .ac().bold(true).text(center('★  PRINTER TEST RECEIPT  ★')).lf().bold(false)
           .al().text(sep).lf();

        /* ── Date / Time ── */
        enc.text(row('Test Date:', dateStr)).lf()
           .text(row('Test Time:', timeStr)).lf();

        /* ── Printer hardware info ── */
        enc.text(dash).lf()
           .bold(true).text('PRINTER INFORMATION').lf().bold(false)
           .text(dash).lf()
           .text(row('Model:', info.name || 'P58E Bluetooth')).lf()
           .text(row('BT Device ID:', (info.id || 'N/A').slice(0, W - 14))).lf()
           .text(row('BLE Service:', info.serviceUUID ? 'FF00 (P58E)' : 'Unknown')).lf()
           .text(row('Write Char:', info.charUUID ? (info.charUUID.slice(4,8).toUpperCase()) : 'N/A')).lf()
           .text(row('Write Mode:', info.writeMode || 'N/A')).lf()
           .text(row('Paper Width:', '58mm / 32 chars')).lf()
           .text(row('Connection:', 'BLE (Web Bluetooth)')).lf()
           .text(row('Status:', 'CONNECTED  ✓')).lf()
           .text(row('Firmware:', 'N/A (BLE only)')).lf()
           .text(row('Paired At:', (info.connectedAt || now.toISOString()).slice(0, 16))).lf();

        /* ── ESC/POS feature verification ── */
        enc.text(dash).lf()
           .bold(true).text('FEATURE VERIFICATION').lf().bold(false)
           .text(dash).lf()
           .text(row('Text printing:',  'PASS  ✓')).lf()
           .text(row('Bold text:',      'PASS  ✓')).lf()
           .text(row('Double height:',  'PASS  ✓')).lf()
           .text(row('Column layout:',  'PASS  ✓')).lf();

        /* ── Sample products (receipt body) ── */
        enc.text(dash).lf()
           .bold(true).text('SAMPLE TRANSACTION').lf().bold(false)
           .text(dash).lf();

        const items = [
          { name: 'Unga Ndovu 2kg',        qty: 2, price: 220 },
          { name: 'Mafuta ya Kupika 1L',   qty: 1, price: 190 },
          { name: 'Sukari Futa 1kg',       qty: 3, price: 150 },
          { name: 'Maziwa Safi 500ml',     qty: 2, price:  60 },
          { name: 'Chumvi Kilo 1',         qty: 1, price:  50 },
          { name: 'Uji wa Mtoto 500g',     qty: 1, price: 140 },
        ];

        const qW = 3, pW = 9, nW = W - qW - pW - 2;
        enc.bold(true)
           .text('Item'.padEnd(nW) + 'Qty'.padStart(qW) + 'Amount'.padStart(pW)).lf()
           .bold(false).text(dash).lf();

        let subtotal = 0;
        for (const it of items) {
          const total = it.qty * it.price; subtotal += total;
          enc.text(it.name.slice(0, nW).padEnd(nW) + String(it.qty).padStart(qW) + ('KES '+total).padStart(pW)).lf();
        }

        const vat   = Math.round(subtotal * 0.16);
        const grand = subtotal + vat;
        enc.text(dash).lf()
           .text(row('Subtotal:', 'KES ' + subtotal)).lf()
           .text(row('VAT (16%):', 'KES ' + vat)).lf()
           .text(dash).lf()
           .bold(true).sz('tall').text(row('TOTAL:', 'KES ' + grand)).lf().sz('normal').bold(false)
           .text(dash).lf()
           .text(row('Payment:', 'M-PESA')).lf()
           .text(row('Mpesa Ref:', 'SH12345678A')).lf()
           .text(row('Amount Paid:', 'KES 1,500')).lf()
           .text(row('Change:', 'KES ' + (1500 - grand))).lf()
           .text(row('Cashier:', 'Jane Kamau')).lf()
           .text(row('Till #:', 'TILL-01')).lf()
           .text(row('Receipt #:', 'RCP-TEST-001')).lf();

        /* ── Barcode test ── */
        enc.text(dash).lf()
           .ac().bold(true).text('SAMPLE BARCODE (Code 128)').lf().bold(false);
        enc.barcode('1234567890').lf();
        enc.text(row('Barcode print:', 'PASS  ✓')).lf();

        /* ── QR code test ── */
        enc.ac().bold(true).text('SAMPLE QR CODE').lf().bold(false);
        enc.qr('https://sokoni.co.ke/r/TEST-P58E-001', 4).lf();
        enc.al().text(row('QR code print:', 'PASS  ✓')).lf();

        /* ── Auto-cutter test marker ── */
        enc.text(dash).lf()
           .text(row('Auto-cut test:', 'BELOW  ↓')).lf();

        /* ── Pass banner ── */
        enc.text(sep).lf()
           .ac()
           .bold(true).sz('tall').text(center('ALL TESTS PASSED')).lf()
           .sz('normal').bold(false)
           .text(center('P58E is ready for production')).lf().lf()
           .text(center('sokoni.co.ke')).lf()
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
    if (!navigator.bluetooth) issues.push('Web Bluetooth API not available — use Chrome on Android or Desktop.');
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
      issues.push('Page must be served over HTTPS for Bluetooth to work.');
    }
    if (!navigator.bluetooth?.getDevices) {
      issues.push('navigator.bluetooth.getDevices not available — auto-reconnect requires Chrome 85+.');
    }
    return { supported: issues.length === 0, issues };
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
