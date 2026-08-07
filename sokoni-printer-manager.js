/* sokoni-printer-manager.js — SOKONI SmartPOS Enterprise Printer Framework v2.0
 *
 * This is the permanent enterprise printing framework for SOKONI SmartPOS.
 * Used by supermarkets, restaurants, pharmacies, hardware stores,
 * wholesalers, retail chains, and enterprise customers.
 *
 * Architecture:
 *   PrinterManager (window.PrinterManager)
 *   ├── Transports  : Bluetooth | WebSerial | USB | Network | Browser
 *   ├── Languages   : ESC/POS (full) | TSPL (ready) | ZPL (ready) | CPCL (ready)
 *   ├── Profiles    : 15+ printer brands auto-detected from BT name / USB ID
 *   ├── Features    : Queue | Auto-reconnect | Stats | Diagnostics | Drawer log
 *   └── p58e proxy  : backward-compatible window.P58EPrinter namespace
 *
 * Depends on (must load first):
 *   sokoni-universal-printer.js  →  window.SokoniPrinter
 *   sokoni-bluetooth-printer.js  →  window.P58EPrinter
 *
 * All UI pages communicate exclusively through window.PrinterManager.
 * No direct SokoniPrinter / P58EPrinter references in page code.
 */

'use strict';
(function () {

/* ═══════════════════════════════════════════════════════════════════
   PRINTER BRAND PROFILES
   Auto-detected from BT device name, USB vendor ID, or user config.
   Drives paper width, character width, pixel width, default language,
   and capability flags used throughout the system.
═══════════════════════════════════════════════════════════════════ */
const PRINTER_PROFILES = {
  /* ── 58mm Bluetooth / Mobile ── */
  P58E:      { brand:'Goojprt',      model:'P58E',       width:'58mm', chars:32, px:384, lang:'escpos', cut:true,  drawer:true,  qr:true, barcode:true,  img:true  },
  'XP-58':   { brand:'Xprinter',     model:'XP-58III',   width:'58mm', chars:32, px:384, lang:'escpos', cut:true,  drawer:false, qr:true, barcode:true,  img:true  },
  RP58:      { brand:'Rongta',       model:'RP58',       width:'58mm', chars:32, px:384, lang:'escpos', cut:true,  drawer:false, qr:true, barcode:true,  img:true  },
  'PT-210':  { brand:'Goojprt',      model:'PT-210',     width:'58mm', chars:32, px:384, lang:'escpos', cut:false, drawer:false, qr:true, barcode:true,  img:false },
  'HOP-E58': { brand:'HOIN',         model:'HOP-E58',    width:'58mm', chars:32, px:384, lang:'escpos', cut:true,  drawer:false, qr:true, barcode:true,  img:true  },
  PTP:       { brand:'Cashino',      model:'PTP-II',     width:'58mm', chars:32, px:384, lang:'escpos', cut:true,  drawer:false, qr:true, barcode:true,  img:false },
  MTP:       { brand:'Mypos',        model:'MTP-II',     width:'58mm', chars:32, px:384, lang:'escpos', cut:false, drawer:false, qr:true, barcode:true,  img:false },
  Sunmi:     { brand:'Sunmi',        model:'V2s/T2',     width:'58mm', chars:32, px:384, lang:'escpos', cut:false, drawer:false, qr:true, barcode:true,  img:true  },
  /* ── 80mm Desktop ── */
  'TM-T88':  { brand:'Epson',        model:'TM-T88VI',   width:'80mm', chars:48, px:576, lang:'escpos', cut:true,  drawer:true,  qr:true, barcode:true,  img:true  },
  'TM-T20':  { brand:'Epson',        model:'TM-T20III',  width:'80mm', chars:48, px:576, lang:'escpos', cut:true,  drawer:true,  qr:true, barcode:true,  img:true  },
  TSP100:    { brand:'Star',         model:'TSP100IV',   width:'80mm', chars:48, px:576, lang:'escpos', cut:true,  drawer:true,  qr:true, barcode:true,  img:true  },
  mPOP:      { brand:'Star',         model:'mPOP',       width:'58mm', chars:32, px:384, lang:'escpos', cut:true,  drawer:true,  qr:true, barcode:true,  img:true  },
  'CT-S310': { brand:'Citizen',      model:'CT-S310II',  width:'80mm', chars:48, px:576, lang:'escpos', cut:true,  drawer:true,  qr:true, barcode:true,  img:true  },
  'SRP-350': { brand:'Bixolon',      model:'SRP-350V',   width:'80mm', chars:48, px:576, lang:'escpos', cut:true,  drawer:true,  qr:true, barcode:true,  img:true  },
  'XP-80':   { brand:'Xprinter',     model:'XP-80',      width:'80mm', chars:48, px:576, lang:'escpos', cut:true,  drawer:true,  qr:true, barcode:true,  img:true  },
  RP80:      { brand:'Rongta',       model:'RP80US',     width:'80mm', chars:48, px:576, lang:'escpos', cut:true,  drawer:true,  qr:true, barcode:true,  img:true  },
  /* ── Label Printers (TSPL / ZPL — future language drivers) ── */
  Zebra:     { brand:'Zebra',        model:'ZD421',      width:'label',chars:0,  px:203, lang:'zpl',    cut:false, drawer:false, qr:true, barcode:true,  img:true  },
  ZT:        { brand:'Zebra',        model:'ZT411',      width:'label',chars:0,  px:300, lang:'zpl',    cut:false, drawer:false, qr:true, barcode:true,  img:true  },
  TSC:       { brand:'TSC',          model:'TE200',      width:'label',chars:0,  px:203, lang:'tspl',   cut:false, drawer:false, qr:true, barcode:true,  img:true  },
  CPCL:      { brand:'Zebra/Honeywell', model:'Mobile',  width:'label',chars:0,  px:203, lang:'cpcl',   cut:false, drawer:false, qr:true, barcode:true,  img:true  },
  /* ── Generic fallback ── */
  GENERIC:   { brand:'Generic',      model:'ESC/POS',    width:'80mm', chars:48, px:576, lang:'escpos', cut:true,  drawer:false, qr:true, barcode:true,  img:true  },
};

/* Detect profile from BT device name or USB product string */
function _detectProfile (nameOrId) {
  if (!nameOrId) return PRINTER_PROFILES.GENERIC;
  const n = String(nameOrId).toUpperCase();
  if (n.includes('P58'))      return PRINTER_PROFILES.P58E;
  if (n.includes('XP-58') || n.includes('XP58')) return PRINTER_PROFILES['XP-58'];
  if (n.includes('XP-80') || n.includes('XP80')) return PRINTER_PROFILES['XP-80'];
  if (n.includes('RP58') || n.includes('RP-58')) return PRINTER_PROFILES.RP58;
  if (n.includes('RP80') || n.includes('RP-80')) return PRINTER_PROFILES.RP80;
  if (n.includes('HOP'))      return PRINTER_PROFILES['HOP-E58'];
  if (n.includes('PTP'))      return PRINTER_PROFILES.PTP;
  if (n.includes('MTP'))      return PRINTER_PROFILES.MTP;
  if (n.includes('SUNMI'))    return PRINTER_PROFILES.Sunmi;
  if (n.includes('TM-T88') || n.includes('TMT88')) return PRINTER_PROFILES['TM-T88'];
  if (n.includes('TM-T20') || n.includes('T20'))   return PRINTER_PROFILES['TM-T20'];
  if (n.includes('EPSON') || n.includes('TM-'))    return PRINTER_PROFILES['TM-T88'];
  if (n.includes('TSP'))      return PRINTER_PROFILES.TSP100;
  if (n.includes('MPOP'))     return PRINTER_PROFILES.mPOP;
  if (n.includes('STAR'))     return PRINTER_PROFILES.TSP100;
  if (n.includes('CT-S') || n.includes('CITIZEN')) return PRINTER_PROFILES['CT-S310'];
  if (n.includes('SRP') || n.includes('BIXOLON'))  return PRINTER_PROFILES['SRP-350'];
  if (n.includes('ZT'))       return PRINTER_PROFILES.ZT;
  if (n.includes('ZEBRA') || n.includes('ZD'))     return PRINTER_PROFILES.Zebra;
  if (n.includes('TSC'))      return PRINTER_PROFILES.TSC;
  if (n.includes('RONGTA'))   return PRINTER_PROFILES.RP80;
  if (n.includes('GOOJPRT'))  return PRINTER_PROFILES.P58E;
  if (n.includes('CASHINO'))  return PRINTER_PROFILES.PTP;
  return PRINTER_PROFILES.GENERIC;
}

/* ═══════════════════════════════════════════════════════════════════
   LANGUAGE DRIVERS
   Every printer language has the same interface:
     driver.isSupported() → boolean
     driver.init()        → Uint8Array   (initialization sequence)
     driver.text(s)       → Uint8Array
     driver.cut()         → Uint8Array
     driver.feed(n)       → Uint8Array
   ESC/POS fully delegates to window.SokoniPrinter.
   TSPL/ZPL/CPCL have correct API shape — physical verification needed.
═══════════════════════════════════════════════════════════════════ */

class EscPosDriver {
  get name () { return 'ESC/POS'; }
  get supported () { return !!window.SokoniPrinter; }

  /* All ESC/POS operations delegate to the SokoniPrinter engine */
  print       (docType, data, opts) { return _eng().print(docType, data, opts); }
  printNow    (docType, data, opts) { return _eng().printNow(docType, data, opts); }
  printRaw    (bytes)               { return _eng().printRaw(bytes); }
  printImage  (src, opts)           { return _eng().printImage(src, opts); }
  printQR     (data, opts)          { return _eng().printQR(data, opts); }
  printBarcode(data, opts)          { return _eng().printBarcode(data, opts); }
  openDrawer  ()                    { return _eng().openCashDrawer(); }
  testPrint   ()                    { return _eng().testPrint(); }
  preview     (docType, data)       { return _eng().preview(docType, data); }

  encode (docType, data) {
    /* Synchronous ESC/POS byte generation for raw transmission */
    try {
      const r = _eng()._getRenderer();
      return r ? r.render(docType, data) : new Uint8Array(0);
    } catch(_) { return new Uint8Array(0); }
  }
}

class TsplDriver {
  get name () { return 'TSPL'; }
  get supported () { return true; }

  /* TSPL (TSC Printer Language) — for thermal label printers (TSC, etc.)
     Physical printers required for end-to-end verification. */
  _enc (text) { return new TextEncoder().encode(text); }

  init (widthMm = 50, heightMm = 30, gap = 2) {
    return this._enc(`SIZE ${widthMm} mm, ${heightMm} mm\r\nGAP ${gap} mm, 0 mm\r\nDIRECTION 0\r\nCLS\r\n`);
  }
  text (x, y, font, rotation, xMul, yMul, text) {
    return this._enc(`TEXT ${x},${y},"${font}",${rotation},${xMul},${yMul},"${text}"\r\n`);
  }
  barcode (x, y, type, height, readable, rotation, narrow, wide, data) {
    return this._enc(`BARCODE ${x},${y},"${type}",${height},${readable},${rotation},${narrow},${wide},"${data}"\r\n`);
  }
  qr (x, y, level, width, mode, rotation, data) {
    return this._enc(`QRCODE ${x},${y},${level},${width},${mode},${rotation},"${data}"\r\n`);
  }
  print (copies = 1) { return this._enc(`PRINT ${copies},1\r\n`); }
  cut   ()           { return this._enc(`CUT\r\n`); }
  feed  (mm)         { return this._enc(`FEED ${mm}\r\n`); }
}

class ZplDriver {
  get name () { return 'ZPL'; }
  get supported () { return true; }

  /* ZPL / ZPL II (Zebra Programming Language) — for Zebra label printers.
     Physical Zebra printer required for end-to-end verification. */
  _enc (text) { return new TextEncoder().encode(text); }

  init () { return this._enc('^XA\n^CF0,40\n'); }
  end  () { return this._enc('^XZ\n'); }

  text (x, y, size, text) {
    return this._enc(`^FO${x},${y}^CF0,${size}^FD${text}^FS\n`);
  }
  barcode (x, y, type, height, printAbove, data) {
    return this._enc(`^FO${x},${y}^B${type || 'C'},${height || 80},${printAbove ? 'Y' : 'N'},N,N^FD${data}^FS\n`);
  }
  qr (x, y, magnification, errorCorrection, data) {
    return this._enc(`^FO${x},${y}^BQN,2,${magnification || 6}^FD${errorCorrection || 'M'},A${data}^FS\n`);
  }
  label (fields, opts = {}) {
    const parts = [
      `^XA`,
      `^PW${opts.widthDots || 609}`,
      `^LL${opts.lengthDots || 406}`,
      ...fields,
      `^XZ`,
    ];
    return this._enc(parts.join('\n') + '\n');
  }
}

class CpclDriver {
  get name () { return 'CPCL'; }
  get supported () { return true; }

  /* CPCL (Comtec Printer Control Language) — for Zebra mobile & Honeywell printers.
     Physical CPCL printer required for end-to-end verification. */
  _enc (text) { return new TextEncoder().encode(text); }

  init (heightDots = 200, qty = 1) {
    return this._enc(`! 0 200 200 ${heightDots} ${qty}\r\n`);
  }
  text (font, size, x, y, text) {
    return this._enc(`TEXT ${font} ${size} ${x} ${y} ${text}\r\n`);
  }
  barcode (type, width, ratio, height, x, y, data) {
    return this._enc(`BARCODE ${type} ${width} ${ratio} ${height} ${x} ${y} ${data}\r\n`);
  }
  qr (x, y, model, unitWidth, data) {
    return this._enc(`B QR ${x} ${y} M 2 U ${unitWidth}\n${data}\nENDQR\r\n`);
  }
  print () { return this._enc(`FORM\r\nPRINT\r\n`); }
}

/* Language driver factory */
const LANGUAGE_DRIVERS = {
  escpos: new EscPosDriver(),
  tspl:   new TsplDriver(),
  zpl:    new ZplDriver(),
  cpcl:   new CpclDriver(),
};

/* ═══════════════════════════════════════════════════════════════════
   TRANSPORT LAYER
   Each transport wraps the corresponding adapter in SokoniPrinter.
   The UI calls PrinterManager.connect/disconnect — never the adapter.
═══════════════════════════════════════════════════════════════════ */

class BluetoothTransport {
  get name      () { return 'bluetooth'; }
  get label     () { return 'BLE Bluetooth'; }
  get available () { return !!navigator.bluetooth; }

  /* Open BT picker; returns [{id, name, type:'bluetooth', _dev}] */
  async scan () { return _eng().discoverBy('bluetooth'); }

  /* Pair P58E (or any ESC/POS BLE printer) via dedicated BLE engine */
  async pairP58E () { return _p58e().requestAndPair(); }

  /* Connect from a device returned by scan() — _dev must be present */
  async connect (deviceInfo) {
    _requireField(deviceInfo, '_dev',      'Bluetooth device object missing. Please scan first or click Pair.');
    _requireField(deviceInfo._dev, 'gatt', 'Bluetooth GATT interface unavailable. Ensure printer is on and in range.');
    return _eng().connect(deviceInfo);
  }

  async autoConnect () {
    return window.P58EPrinter ? window.P58EPrinter.autoConnect() : false;
  }
}

class WebSerialTransport {
  get name      () { return 'serial'; }
  get label     () { return 'Bluetooth COM Port (SPP)'; }
  get available () { return !!navigator.serial; }

  /* List already-permitted ports — no user gesture, no picker */
  async listPermitted () { return _eng().discoverBy('serial-list'); }

  /* Open Chrome port picker → return a deviceInfo with ._port */
  async requestPort () {
    if (!navigator.serial) throw _friendlyError(new Error('serial'));
    const port = await navigator.serial.requestPort({});
    const meta = port?.getInfo?.() || {};
    return {
      type:  'serial',
      _port: port,
      id:    'serial-req',
      name:  meta.usbVendorId
        ? 'USB ' + meta.usbVendorId.toString(16).toUpperCase() + ' Port'
        : 'Bluetooth COM Port (SPP)',
    };
  }

  async connect (deviceInfo) {
    _requireField(deviceInfo, '_port', 'Serial port object missing. Call requestPort() or listPermitted() first.');
    return _eng().connect(deviceInfo);
  }
}

class UsbTransport {
  get name      () { return 'usb'; }
  get label     () { return 'USB / OTG'; }
  get available () { return !!navigator.usb; }

  async scan    ()            { return _eng().discoverBy('usb'); }
  async connect (deviceInfo)  { _requireDefined(deviceInfo, 'USB device'); return _eng().connect(deviceInfo); }
}

class NetworkTransport {
  get name      () { return 'network'; }
  get label     () { return 'Network / Wi-Fi'; }
  get available () { return true; }

  async scan   ()             { return _eng().discoverBy('network'); }
  async connect (deviceInfo)  {
    if (!deviceInfo?.endpoint) throw new Error('Endpoint URL required. Enter the printer IP: http://192.168.1.x');
    return _eng().connect(deviceInfo);
  }

  getSaved   ()             { try { return JSON.parse(localStorage.getItem('spp_net_printers') || '[]'); } catch(_) { return []; } }
  save       (name, ep)     { _eng().saveNetworkPrinter?.(name, ep); }
  remove     (ep)           { _eng().removeNetworkPrinter?.(ep); }
}

class BrowserPrintTransport {
  get name      () { return 'browser'; }
  get label     () { return 'Browser / AirPrint'; }
  get available () { return typeof window.print === 'function'; }

  async scan    ()            { return [{ id:'browser', name:'System Print Dialog', type:'browser' }]; }
  async connect (deviceInfo)  { return _eng().connect({ type: 'browser', ...(deviceInfo || {}) }); }
}

/* ═══════════════════════════════════════════════════════════════════
   ENTERPRISE ERROR HANDLER
   Maps every known JavaScript / Web API exception to an enterprise-
   friendly message with a root cause and suggested action.
   UI receives a structured { title, detail, action, code } object.
═══════════════════════════════════════════════════════════════════ */
const _ERR_MAP = [
  { test: /P58EService is not defined/i,
    title: 'Printer service failed to initialize.',
    detail: 'The P58E printer module could not be loaded.',
    action: 'Reload the page. If the issue persists, clear the browser cache (Ctrl+Shift+R).',
    code: 'ERR_SERVICE_INIT' },

  { test: /cannot read propert.*connect|undefined.*connect/i,
    title: 'Unable to establish a connection with the selected printer.',
    detail: 'The printer transport was not initialized before attempting to connect.',
    action: 'Ensure the printer is powered on. Click Scan again and select the printer.',
    code: 'ERR_CONNECT_UNDEFINED' },

  { test: /gatt|gatt server|gatt interface/i,
    title: 'Bluetooth GATT connection failed.',
    detail: 'The printer rejected the GATT connection request.',
    action: 'Power cycle the printer. Ensure no other device is connected to it. Move within 1 metre.',
    code: 'ERR_GATT_CONNECT' },

  { test: /user cancel|no device selected|notfounderror/i,
    title: 'No printer was selected.',
    detail: 'The selection was cancelled before a printer was chosen.',
    action: 'Click the transport tile again and select your printer from the list.',
    code: 'ERR_USER_CANCEL' },

  { test: /permission|security|blocked|notallowederror/i,
    title: 'Browser permission denied.',
    detail: 'The browser did not grant access to Bluetooth or Serial.',
    action: 'Click Allow when the browser permission prompt appears. Check site permissions in Chrome Settings.',
    code: 'ERR_PERMISSION' },

  { test: /in use|already open|resource busy/i,
    title: 'Printer port is in use by another application.',
    detail: 'The COM port or USB device is locked by another process.',
    action: 'Close any other POS software, terminal emulators, or browser tabs using this printer. Then retry.',
    code: 'ERR_PORT_BUSY' },

  { test: /no port|failed to open|cannot open port|com port not found/i,
    title: 'Could not open the COM port.',
    detail: 'The selected serial port did not open successfully.',
    action: 'In Windows, open Device Manager → Bluetooth → verify an Outgoing COM Port exists for the P58E. If missing, add one in Bluetooth Settings → COM Ports → Add.',
    code: 'ERR_COM_PORT' },

  { test: /network|fetch|offline|unreachable/i,
    title: 'Network printer is unreachable.',
    detail: 'The printer did not respond on the configured IP address.',
    action: 'Ensure the printer and this device are on the same Wi-Fi network. Verify the printer IP in the network card settings.',
    code: 'ERR_NETWORK' },

  { test: /no service|no print service|characteristic/i,
    title: 'Printer service UUID not found.',
    detail: 'The connected Bluetooth device does not expose a known ESC/POS print service.',
    action: 'Confirm this is a P58E or ESC/POS compatible printer. Try the "BLE Bluetooth" transport and select your printer model.',
    code: 'ERR_NO_SERVICE' },

  { test: /not supported|web bluetooth|web serial/i,
    title: 'This feature is not supported in your browser.',
    detail: 'Web Bluetooth and Web Serial require Chrome or Edge on desktop.',
    action: 'Open this page in Google Chrome or Microsoft Edge. Safari and Firefox are not supported for direct printer connections.',
    code: 'ERR_BROWSER' },

  { test: /timeout/i,
    title: 'Connection timed out.',
    detail: 'The printer did not respond within the expected time.',
    action: 'Move closer to the printer. Ensure it is powered on and not in sleep mode.',
    code: 'ERR_TIMEOUT' },

  { test: /offline|not connected/i,
    title: 'Printer not connected.',
    detail: 'A print command was issued but no printer is currently connected.',
    action: 'Connect a printer using the Discover tab, then try printing again.',
    code: 'ERR_OFFLINE' },
];

function _friendlyError (err) {
  const raw = (err?.message || String(err || '') || '').toLowerCase();
  for (const rule of _ERR_MAP) {
    if (rule.test.test(raw)) {
      const e = new Error(rule.title);
      e.detail = rule.detail;
      e.action = rule.action;
      e.code   = rule.code;
      e.original = err;
      return e;
    }
  }
  /* Unknown error — DO NOT hide it behind a generic title. Surface the real message so the
     dialog is actionable and debuggable (the founder specifically flagged the dead-end
     "unexpected error"). Keep the technical string in .detail/.original for a Details view. */
  const realMsg = (err?.message || String(err || '') || '').trim() || 'Unknown error';
  const short   = realMsg.length <= 140 ? realMsg : realMsg.slice(0, 137) + '…';
  const e = new Error('Printer connection failed: ' + short);
  e.detail   = realMsg + (err?.name ? '  (' + err.name + ')' : '');
  e.action   = 'Make sure the printer is powered on and in range, then Reconnect. Tap Details for the technical error.';
  e.code     = 'ERR_UNKNOWN';
  e.original = err;
  return e;
}

/* ═══════════════════════════════════════════════════════════════════
   PRINT STATISTICS
   Tracks total prints, errors, throughput, and per-transport counts.
   Persisted in localStorage for dashboard display.
═══════════════════════════════════════════════════════════════════ */
const _STATS_KEY = 'pm_print_stats';
class PrintStats {
  constructor () { this._data = this._load(); }

  _load () {
    try { return JSON.parse(localStorage.getItem(_STATS_KEY) || 'null') || this._defaults(); }
    catch(_) { return this._defaults(); }
  }
  _defaults () {
    return { total:0, errors:0, byTransport:{}, firstPrintAt:null, lastPrintAt:null,
             totalPrintMs:0, longestPrintMs:0 };
  }
  _save () { try { localStorage.setItem(_STATS_KEY, JSON.stringify(this._data)); } catch(_) {} }

  recordPrint (transport, durationMs) {
    this._data.total++;
    this._data.byTransport[transport] = (this._data.byTransport[transport] || 0) + 1;
    this._data.lastPrintAt = new Date().toISOString();
    if (!this._data.firstPrintAt) this._data.firstPrintAt = this._data.lastPrintAt;
    this._data.totalPrintMs += (durationMs || 0);
    if ((durationMs || 0) > this._data.longestPrintMs) this._data.longestPrintMs = durationMs;
    this._save();
  }
  recordError () { this._data.errors++; this._save(); }

  get () {
    const d = this._data;
    return {
      ...d,
      avgPrintMs: d.total ? Math.round(d.totalPrintMs / d.total) : 0,
      successRate: d.total ? Math.round(((d.total - d.errors) / d.total) * 100) : 100,
    };
  }
  reset () { this._data = this._defaults(); this._save(); }
}

/* ═══════════════════════════════════════════════════════════════════
   CASH DRAWER EVENT LOG
   Every drawer open event is logged with timestamp, reason, and user.
   Enterprise requirement: drawer audit trail for shift reconciliation.
═══════════════════════════════════════════════════════════════════ */
const _DRAWER_KEY = 'pm_drawer_log';
class DrawerLog {
  _load   ()  { try { return JSON.parse(localStorage.getItem(_DRAWER_KEY) || '[]'); } catch(_) { return []; } }
  _save   (l) { try { localStorage.setItem(_DRAWER_KEY, JSON.stringify(l.slice(-200))); } catch(_) {} }

  record (reason = 'manual', user = null) {
    const log = this._load();
    log.push({ at: new Date().toISOString(), reason, user: user || 'System', transport: window.PrinterManager?._activeTransport || 'unknown' });
    this._save(log);
  }

  getAll   ()     { return this._load(); }
  getLast  (n=10) { return this._load().slice(-n); }
  clear    ()     { this._save([]); }
}

/* ═══════════════════════════════════════════════════════════════════
   P58E PROXY  (PrinterManager.p58e.*)
   Exposes P58E engine methods without leaking implementation.
   Backward-compatible with pos-printer-setup.html references.
═══════════════════════════════════════════════════════════════════ */
const P58EProxy = {
  get engine     () { return window.P58EPrinter || null; },
  get checklist  () { return this.engine?.checklist   || []; },
  get settings   () { return this.engine?.settings    || { autoConnect: false, drawerEnabled: false }; },
  get paired     () { return this.engine?.paired      || null; },
  get isConnected() { return this.engine?.isConnected || false; },
  get info       () { return this.engine?.info        || null; },
  get status     () { return this.engine?.status      || 'idle'; },

  checkCompatibility ()      { return this.engine?.checkCompatibility?.() || { supported: true, issues: [] }; },
  requestAndPair     ()      { return this.engine?.requestAndPair?.(); },
  autoConnect        ()      { return this.engine?.autoConnect?.(); },
  forget             ()      { return this.engine?.forget?.(); },
  disconnect         ()      { return this.engine?.disconnect?.(); },
  openCashDrawer     ()      { return this.engine?.openCashDrawer?.(); },
  paperFeed          (n)     { return this.engine?.paperFeed?.(n); },
  printTestReceipt   ()      { return this.engine?.printTestReceipt?.(); },
  printDemoReceipt   ()      { return this.engine?.printDemoReceipt?.(); },
  markChecklistItem  (id, d) { return this.engine?.markChecklistItem?.(id, d); },
  updateSettings     (p)     { return this.engine?.updateSettings?.(p); },
  on                 (ev, f) { return this.engine?.on?.(ev, f); },
  off                (ev, f) { return this.engine?.off?.(ev, f); },
};

/* ═══════════════════════════════════════════════════════════════════
   PRINTER SETTINGS STORE
   Enterprise settings persisted across sessions.
   Separate from ESC/POS config (which lives in SokoniPrinter).
═══════════════════════════════════════════════════════════════════ */
const _PM_SETTINGS_KEY = 'pm_enterprise_settings';
function _loadPmSettings () {
  const defaults = {
    defaultTransport:   null,
    autoConnect:        true,
    autoPrintOnSale:    false,
    autoPrintCopies:    1,
    paperWidth:         '80mm',
    receiptTemplate:    'standard',
    showLogo:           true,
    showQR:             true,
    showBarcode:        true,
    cashDrawerAuto:     true,
    cashDrawerAutoEvents: ['cash_payment', 'refund', 'exchange', 'manual_open'],
    printDensity:       0,
    characterEncoding:  'PC437',
    language:           'en',
    printerProfileKey:  null,
  };
  try { return Object.assign({}, defaults, JSON.parse(localStorage.getItem(_PM_SETTINGS_KEY) || '{}')); }
  catch(_) { return defaults; }
}
function _savePmSettings (s) {
  try { localStorage.setItem(_PM_SETTINGS_KEY, JSON.stringify(s)); } catch(_) {}
}

/* ═══════════════════════════════════════════════════════════════════
   PRINTER MANAGER — MAIN PUBLIC CLASS
   All UI pages communicate exclusively through this class.
═══════════════════════════════════════════════════════════════════ */
class PrinterManager {

  constructor () {
    /* Transport sub-objects */
    this.bluetooth = new BluetoothTransport();
    this.serial    = new WebSerialTransport();
    this.usb       = new UsbTransport();
    this.network   = new NetworkTransport();
    this.browser   = new BrowserPrintTransport();

    /* Language drivers */
    this.languages = LANGUAGE_DRIVERS;

    /* P58E proxy namespace */
    this.p58e = P58EProxy;

    /* Subsystems */
    this.stats  = new PrintStats();
    this.drawer = new DrawerLog();

    /* Internal state */
    this._activeTransport = null;
    this._currentProfile  = null;
    this._settings        = _loadPmSettings();
    this._listeners       = {};
    this._printT0         = null;   /* timestamp of current print start */

    /* Wire engine events → PrinterManager events */
    this._bridgeEvents();
  }

  /* ── Event infrastructure ───────────────────────────────────── */
  _bridgeEvents () {
    const self = this;
    const wire = () => {
      const sp = window.SokoniPrinter;
      if (sp) {
        sp.on('connected',    d => { self._onConnected(d);    self._emit('connected',    d); });
        sp.on('disconnected', d => { self._onDisconnected(d); self._emit('disconnected', d); });
        sp.on('printed',      d => { self._onPrinted(d);      self._emit('printed',      d); });
        sp.on('error',        d => { self._onError(d);        self._emit('error',        d); });
      }
      const p5 = window.P58EPrinter;
      if (p5) {
        p5.on('connected',        d => self._emit('p58e:connected',        d));
        p5.on('disconnected',     d => self._emit('p58e:disconnected',     d));
        p5.on('reconnecting',     d => self._emit('p58e:reconnecting',     d));
        p5.on('reconnect_failed', d => self._emit('p58e:reconnect_failed', d));
        p5.on('checklist',        d => self._emit('p58e:checklist',        d));
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  }

  _onConnected (d) {
    this._currentProfile = _detectProfile(d?.name || '');
    if (this._settings.paperWidth) _eng().setConfig({ paperWidth: this._currentProfile?.width || this._settings.paperWidth });
  }
  _onDisconnected ()  { /* keep _currentProfile for diagnostics */ }
  _onPrinted (job) {
    const ms = this._printT0 ? Date.now() - this._printT0 : 0;
    this.stats.recordPrint(this._activeTransport || 'unknown', ms);
    this._printT0 = null;
  }
  _onError () { this.stats.recordError(); this._printT0 = null; }

  on   (ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); return this; }
  off  (ev, fn) { if (this._listeners[ev]) this._listeners[ev] = this._listeners[ev].filter(f => f !== fn); }
  _emit (ev, d) { (this._listeners[ev] || []).forEach(fn => { try { fn(d); } catch(_) {} }); }

  /* ── State ──────────────────────────────────────────────────── */
  get connected () { return !!(window.SokoniPrinter?.connected); }
  get profile   () { return this._currentProfile; }
  get language  () { return LANGUAGE_DRIVERS[this._currentProfile?.lang || 'escpos']; }

  /* ── Connection ─────────────────────────────────────────────── */
  async connect (deviceInfo) {
    if (!deviceInfo?.type) throw new Error('deviceInfo.type is required');
    try {
      switch (deviceInfo.type) {
        case 'bluetooth': case 'ble': await this.bluetooth.connect(deviceInfo); break;
        case 'serial': case 'serial-list': await this.serial.connect(deviceInfo); break;
        case 'usb':     await this.usb.connect(deviceInfo); break;
        case 'browser': await this.browser.connect(deviceInfo); break;
        default:        await this.network.connect(deviceInfo);
      }
      this._activeTransport = deviceInfo.type;
      _savePmSettings(Object.assign(this._settings, { defaultTransport: deviceInfo.type }));
    } catch (err) {
      throw _friendlyError(err);
    }
  }

  async disconnect () {
    try { await _eng().disconnect(); } catch(_) {}
    this._activeTransport = null;
  }

  async reconnect () {
    await this.disconnect();
    return this.autoReconnect();
  }

  /* Single canonical Forget — clears the remembered printer across BOTH underlying engines and
     every storage key, and revokes the browser grant where supported. Every "Forget" button in
     the app calls this, so nothing keeps auto-reconnecting a printer the merchant forgot. */
  async forget () {
    try { if (window.SokoniPrinter && window.SokoniPrinter.forget) await window.SokoniPrinter.forget(); } catch (_) {}
    try { if (window.P58EPrinter && window.P58EPrinter.forget)    await window.P58EPrinter.forget(); } catch (_) {}
    ['spp_profile', 'pps_store_profile', 'sokoni_printer_last_print', 'p58e_paired_device', 'pps_remember']
      .forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });
    this._activeTransport = null;
    this._emit('disconnected', null);
  }

  async autoReconnect () {
    /* 1. SokoniPrinter handles last-used serial / network / BLE */
    try {
      const ok1 = await _eng().autoReconnect();
      if (ok1) return true;
    } catch(_) {}
    /* 2. P58E dedicated BLE reconnect (Chrome 85+ getDevices) */
    try {
      const ok2 = await window.P58EPrinter?.autoConnect?.();
      if (ok2) return true;
    } catch(_) {}
    return false;
  }

  async discoverBy (type) {
    try { return await _eng().discoverBy(type) || []; }
    catch (err) { throw _friendlyError(err); }
  }

  /* ── Printing ───────────────────────────────────────────────── */
  print (docType, data, opts) {
    this._printT0 = Date.now();
    return _eng().print(docType, data, opts).catch(e => { throw _friendlyError(e); });
  }

  printNow (docType, data, opts) {
    this._printT0 = Date.now();
    return _eng().printNow(docType, data, opts).catch(e => { throw _friendlyError(e); });
  }

  printRaw  (bytes)         { return _eng().printRaw(bytes).catch(e => { throw _friendlyError(e); }); }
  printImage (src, opts)    { return _eng().printImage(src, opts).catch(e => { throw _friendlyError(e); }); }
  testPrint ()              { return _eng().testPrint().catch(e => { throw _friendlyError(e); }); }
  preview (docType, data)   { return _eng().preview(docType, data); }

  printQR (data, opts) {
    return _eng().printQR(data, opts).catch(e => { throw _friendlyError(e); });
  }

  printBarcode (data, opts) {
    return _eng().printBarcode(data, opts).catch(e => { throw _friendlyError(e); });
  }

  /* Full SOKONI-branded production receipt — logo, items, VAT, M-Pesa, QR, barcode */
  async printSokoniReceipt (storeOverride = {}) {
    if (!this.connected) throw new Error('No printer connected — connect a printer first then retry.');
    const now     = new Date();
    const pad     = n => String(n).padStart(2, '0');
    const dateStr = now.toLocaleDateString('en-KE', { day:'2-digit', month:'short', year:'numeric' });
    const timeStr = now.toLocaleTimeString('en-KE', { hour12: false });
    const rcpt    = 'SK' + now.getFullYear().toString().slice(2) +
                    pad(now.getMonth()+1) + pad(now.getDate()) + '-' +
                    pad(now.getHours()) + pad(now.getMinutes());
    const mpesa   = 'SK' + Math.random().toString(36).slice(2,9).toUpperCase();

    const data = Object.assign({
      businessName:    'SOKONI SMARTPOS',
      businessAddress: 'Westlands, Nairobi, Kenya',
      businessPhone:   '+254 700 000 000',
      businessPin:     'P000000000A',
      vatNumber:       'VAT-000000000',
      receiptNumber:   rcpt,
      orderNumber:     'ORD-' + rcpt,
      cashierName:     'SmartPOS Demo',
      items: [
        { name:'Maize Flour 2kg — Jogoo',   quantity:2, unitPrice:220 },
        { name:'Cooking Oil 1L — Elianto',  quantity:1, unitPrice:350 },
        { name:'Sugar 1kg — Mumias',        quantity:3, unitPrice:160, discount:30 },
        { name:'Bread Loaf — Supa Loaf',    quantity:2, unitPrice:55  },
        { name:'UHT Milk 500ml — KCC',      quantity:4, unitPrice:75  },
      ],
      totals: { subtotal:1700, discount:30, vat:267, grandTotal:1937 },
      payment: { method:'M-Pesa', amountTendered:2000, change:63, mpesaCode:mpesa },
      receiptUrl:   'https://mysokoni.co.ke/r/' + rcpt,
      promoMessage: 'Thank you for shopping with SOKONI!',
      returnPolicy: 'Returns accepted within 7 days with receipt.',
    }, storeOverride);

    return this.printNow('sale', data);
  }

  /* ── Printer hardware commands ──────────────────────────────── */
  async feed (lines = 3) {
    if (!this.connected) throw new Error('Printer not connected');
    /* Route through P58E engine if connected via BLE, else raw ESC/POS */
    if (window.P58EPrinter?.isConnected) return window.P58EPrinter.paperFeed(lines);
    const ESC = 27, LF = 10, GS = 29;
    const cmd = new Uint8Array([GS, 0x4A, Math.min(lines * 24, 255)]);
    return _eng().printRaw(cmd);
  }

  async cut (partial = false) {
    if (!this.connected) throw new Error('Printer not connected');
    const GS = 29;
    const cmd = new Uint8Array([GS, 0x56, partial ? 0x42 : 0x41, 0x00]);
    return _eng().printRaw(cmd);
  }

  async openDrawer (reason = 'manual', user = null) {
    if (!this.connected) throw new Error('Printer not connected — connect a printer to open the cash drawer.');
    await _eng().openCashDrawer();
    this.drawer.record(reason, user);
    this._emit('drawer:opened', { reason, user, at: new Date().toISOString() });
  }

  /* ── Status & diagnostics ───────────────────────────────────── */
  async status () {
    const s = await _eng().getStatus();
    return {
      ...s,
      profile:  this._currentProfile,
      language: this._currentProfile?.lang || 'escpos',
    };
  }

  /* Battery and paper status: not available over standard BLE ESC/POS.
     Some Android/Sunmi printers expose these via proprietary SDKs.
     Returns null for unsupported transports. */
  async battery () {
    /* P58E does not expose battery level over BLE ESC/POS */
    return { level: null, supported: false, note: 'Battery monitoring requires a proprietary printer SDK.' };
  }

  async paperStatus () {
    /* Paper near-end / paper-out status requires printer-to-host response
       which needs a bidirectional serial/USB transport.
       Currently read-only over BLE ESC/POS. */
    return { papersOut: null, nearEnd: null, supported: false, note: 'Paper status requires bidirectional communication (USB/Serial).' };
  }

  async diagnostics () {
    const p = this.detectPlatform();
    let permPorts = [];
    if (p.supportsSerial) try { permPorts = await navigator.serial.getPorts(); } catch(_) {}
    let btDevices = [];
    if (p.hasBluetooth && navigator.bluetooth?.getDevices) try { btDevices = await navigator.bluetooth.getDevices(); } catch(_) {}
    const lp = (() => { try { return JSON.parse(localStorage.getItem('sokoni_printer_last_print') || 'null'); } catch(_) { return null; } })();

    return {
      /* Platform */
      platform:             p,
      /* Connection */
      connected:            this.connected,
      activeTransport:      this._activeTransport,
      printerName:          this.p58e.info?.name || this._currentProfile?.model || 'Not connected',
      printerBrand:         this._currentProfile?.brand || 'Unknown',
      printerModel:         this._currentProfile?.model || 'Unknown',
      printLanguage:        this._currentProfile?.lang  || 'Unknown',
      paperWidth:           this._currentProfile?.width || _eng().getConfig()?.paperWidth || 'Unknown',
      capabilities:         this._currentProfile || {},
      /* Bluetooth */
      btAddress:            this.p58e.info?.id || 'N/A',
      bleService:           this.p58e.info?.serviceUUID || 'N/A',
      /* Serial */
      permittedComPorts:    permPorts.length,
      permittedComPortList: permPorts.map((p2, i) => { const info = p2.getInfo?.() || {}; return { index: i, vendorId: info.usbVendorId, productId: info.usbProductId }; }),
      /* Bluetooth devices */
      permittedBtDevices:   btDevices.map(d => ({ name: d.name || 'Unknown', id: d.id })),
      /* Print history */
      lastPrint:            lp,
      printStats:           this.stats.get(),
      /* Settings */
      settings:             this._settings,
      /* Engine health */
      engines: {
        universalPrinter: !!window.SokoniPrinter,
        p58eService:      !!window.P58EPrinter,
        printerManager:   true,
      },
      /* Supported printers */
      supportedPrinters:    Object.entries(PRINTER_PROFILES).map(([k, v]) => ({ key:k, brand:v.brand, model:v.model, lang:v.lang, width:v.width })),
      recommendedTransport: this.getRecommendedTransport(),
    };
  }

  /* ── Queue / history ────────────────────────────────────────── */
  getQueue    ()   { return _eng().getQueue() || []; }
  getHistory  ()   { return _eng().getHistory() || []; }
  cancelJob   (id) { return _eng().cancelJob(id); }
  retryJob    (id) { return _eng().retryJob(id); }
  pauseQueue  ()   { return _eng().pauseQueue(); }
  resumeQueue ()   { return _eng().resumeQueue(); }
  waitForJob  (id, ms) { return _eng().waitForJob(id, ms); }

  /* ── Config / capabilities ──────────────────────────────────── */
  detectCapabilities  ()    { return _eng().detectCapabilities(); }
  getCapabilities     ()    { return _eng().getCapabilities(); }
  getConfig           ()    { return _eng().getConfig() || {}; }
  setConfig           (cfg) { return _eng().setConfig(cfg); }

  /* Enterprise printer settings (PM layer, separate from ESC/POS config) */
  getPrinterSettings ()       { return { ...this._settings }; }
  updatePrinterSettings (p)   { Object.assign(this._settings, p); _savePmSettings(this._settings); return this._settings; }

  /* ── Network printer management ─────────────────────────────── */
  saveNetworkPrinter   (name, ep) { this.network.save(name, ep); }
  removeNetworkPrinter (ep)       { this.network.remove(ep); }

  /* ── Supported printer catalog ──────────────────────────────── */
  getSupportedPrinters () {
    return Object.entries(PRINTER_PROFILES).map(([key, p]) => ({
      key, brand: p.brand, model: p.model, width: p.width,
      language: p.lang, cut: p.cut, drawer: p.drawer, qr: p.qr,
    }));
  }

  detectPrinterBrand (nameOrId) { return _detectProfile(nameOrId); }
  getLanguageDriver  (lang)     { return LANGUAGE_DRIVERS[lang] || LANGUAGE_DRIVERS.escpos; }
  registerDocType    (t, fn)    { return _eng().registerDocType(t, fn); }

  /* ── Platform detection ─────────────────────────────────────── */
  detectPlatform () {
    const ua  = navigator.userAgent || '';
    const pl  = navigator.platform  || '';
    const ios     = /iP(hone|od|ad)/.test(ua) || (pl === 'MacIntel' && navigator.maxTouchPoints > 1);
    const android = /Android/.test(ua);
    const windows = /Windows NT/.test(ua) || pl.startsWith('Win');
    const macos   = /Macintosh/.test(ua) && !ios;
    const edge    = /Edg\//.test(ua);
    const chrome  = /Chrome\//.test(ua) && !edge;
    const samsung = /SamsungBrowser/.test(ua);
    const safari  = /Safari\//.test(ua) && !chrome && !edge && !samsung;
    const firefox = /Firefox\//.test(ua);
    return {
      os:       ios ? 'iOS / iPadOS' : android ? 'Android' : windows ? 'Windows' : macos ? 'macOS' : 'Unknown OS',
      browser:  edge ? 'Microsoft Edge' : chrome ? 'Google Chrome' : samsung ? 'Samsung Internet' :
                safari ? 'Safari' : firefox ? 'Firefox' : 'Unknown Browser',
      ios, android, windows, macos, chrome, edge, samsung, safari, firefox,
      hasBluetooth:      !!navigator.bluetooth,
      hasSerial:         !!navigator.serial,
      hasUsb:            !!navigator.usb,
      supportsBluetooth: !!navigator.bluetooth && !ios && !firefox,
      supportsSerial:    !!navigator.serial && !ios && !android && !samsung && (chrome || edge),
      supportsUsb:       !!navigator.usb && !ios && (chrome || edge || samsung),
      isHttps:           location.protocol === 'https:',
      isSecureContext:   !!window.isSecureContext,
    };
  }

  /* Returns the recommended transport key for the detected platform */
  getRecommendedTransport () {
    const p = this.detectPlatform();
    if (p.windows && (p.chrome || p.edge) && p.supportsSerial) return 'serial-list';
    if ((p.android || p.macos) && p.supportsBluetooth)         return 'bluetooth';
    if (p.ios)                                                  return 'network';
    return 'network';
  }

  /* Connection priority order for the detected platform */
  getConnectionPriority () {
    const p = this.detectPlatform();
    if (p.windows && (p.chrome || p.edge)) {
      return ['bluetooth', 'serial-list', 'serial', 'usb', 'network', 'browser'];
    }
    if (p.android && (p.chrome || p.samsung)) {
      return ['bluetooth', 'usb', 'network', 'browser'];
    }
    if (p.ios || p.safari) {
      return ['network', 'browser'];
    }
    return ['network', 'bluetooth', 'browser'];
  }
}

/* ── Private module helpers ─────────────────────────────────────── */
function _eng () {
  if (!window.SokoniPrinter) throw _friendlyError(new Error('Universal printer engine (SokoniPrinter) not loaded.'));
  return window.SokoniPrinter;
}
function _p58e () {
  if (!window.P58EPrinter) throw _friendlyError(new Error('P58E BLE service (P58EPrinter) not loaded.'));
  return window.P58EPrinter;
}
function _requireField (obj, field, msg) {
  if (!obj)        throw new Error('No device selected. Please scan first.');
  if (!obj[field]) throw new Error(msg || `Missing required field: ${field}`);
}
function _requireDefined (val, label) {
  if (val == null) throw new Error(`${label || 'Value'} is undefined. Please select a device first.`);
}

/* ── Export ─────────────────────────────────────────────────────── */
window.PrinterManager = new PrinterManager();

/* Expose for console debugging */
window._PM_PRINTER_PROFILES = PRINTER_PROFILES;

console.log(
  '[PrinterManager v2.0] Enterprise Printer Framework loaded\n' +
  '  Transports : Bluetooth | WebSerial | USB | Network | Browser\n' +
  '  Languages  : ESC/POS (full) | TSPL | ZPL | CPCL (ready)\n' +
  '  Profiles   : ' + Object.keys(PRINTER_PROFILES).length + ' printer brands\n' +
  '  window.PrinterManager ready'
);

})();
