/* sokoni-pos-print-service.js — SOKONI SmartPOS Production Print Service v1.0
 *
 * Production printing orchestrator for SOKONI SmartPOS.
 * Handles every document type that originates from a real POS transaction.
 *
 * Architecture:
 *   PosPrintService
 *   ├── RawReceiptBuilder — ESC/POS byte builder (58mm / 80mm)
 *   ├── PrintQueue        — offline queue, dedup, auto-drain on reconnect
 *   ├── PrintHistory      — searchable local history, reprint, PDF export
 *   ├── PrintAudit        — Firestore enterprise audit trail
 *   ├── PrintMetrics      — timing measurements (connect → print done)
 *   ├── PrintHealth       — 30s heartbeat, header widget updates
 *   ├── TillPrinterConfig — per-register printer settings (persistent)
 *   └── AutoPrintSettings — mode/copies/drawer behavior (persistent)
 *
 * Depends on (must load first):
 *   sokoni-universal-printer.js  →  window.SokoniPrinter
 *   sokoni-printer-manager.js    →  window.PrinterManager
 *   firebase (compat SDK)        →  window.firebase (optional — only for audit)
 *
 * All POS pages call window.PosPrintService — never SokoniPrinter directly.
 */

'use strict';
(function () {

/* ═══════════════════════════════════════════════════════════════════
   ESC/POS RAW RECEIPT BUILDER
   Builds a complete byte array for a 58mm or 80mm thermal receipt.
   Every field from the production receipt specification is included.
═══════════════════════════════════════════════════════════════════ */

/* Standard ESC/POS byte constants */
const ESC = 0x1B, GS = 0x1D, LF = 0x0A, NUL = 0x00;
const CMD = {
  INIT:        [ESC, 0x40],
  ALIGN_LEFT:  [ESC, 0x61, 0x00],
  ALIGN_CENTER:[ESC, 0x61, 0x01],
  ALIGN_RIGHT: [ESC, 0x61, 0x02],
  BOLD_ON:     [ESC, 0x45, 0x01],
  BOLD_OFF:    [ESC, 0x45, 0x00],
  UNDERLINE_ON:[ESC, 0x2D, 0x01],
  UNDERLINE_OFF:[ESC,0x2D, 0x00],
  FONT_A:      [ESC, 0x4D, 0x00],   /* normal (12×24) */
  FONT_B:      [ESC, 0x4D, 0x01],   /* condensed (9×17) */
  DBLHEIGHT_ON: [ESC, 0x21, 0x10],
  DBLWIDTH_ON:  [ESC, 0x21, 0x20],
  DBLBOTH_ON:   [ESC, 0x21, 0x30],
  DBLBOTH_OFF:  [ESC, 0x21, 0x00],
  FEED_3:      [ESC, 0x64, 0x03],
  FEED_5:      [ESC, 0x64, 0x05],
  CUT_FULL:    [GS, 0x56, 0x41, 0x05],
  CUT_PARTIAL: [GS, 0x56, 0x42, 0x05],
  DRAWER_PIN0: [ESC, 0x70, 0x00, 0x19, 0xFA],
};

const ENC = new TextEncoder();
function _b (...args) {
  /* Flatten mix of arrays, numbers, strings, Uint8Arrays */
  const parts = [];
  for (const a of args) {
    if (a instanceof Uint8Array) parts.push(...a);
    else if (Array.isArray(a))   parts.push(...a);
    else if (typeof a === 'number') parts.push(a & 0xFF);
    else if (typeof a === 'string') parts.push(...ENC.encode(a));
    else if (a != null) parts.push(...ENC.encode(String(a)));
  }
  return parts;
}

function _buildQr (url, size = 6) {
  const data = ENC.encode(url);
  const len  = data.length + 3;
  const pL   = len & 0xFF;
  const pH   = (len >> 8) & 0xFF;
  return [
    /* Model 2 */ GS,0x28,0x6B,0x04,0x00,0x31,0x41,0x32,0x00,
    /* Size    */ GS,0x28,0x6B,0x03,0x00,0x31,0x43,size,
    /* Err M   */ GS,0x28,0x6B,0x03,0x00,0x31,0x45,0x31,
    /* Store   */ GS,0x28,0x6B,pL,pH,0x31,0x50,0x30,...data,
    /* Print   */ GS,0x28,0x6B,0x03,0x00,0x31,0x51,0x30,
  ];
}

function _buildBarcode (code) {
  const data = ENC.encode(code);
  return [
    GS, 0x68, 64,           /* height 64 dots */
    GS, 0x77, 2,            /* width multiplier 2 */
    GS, 0x48, 0x02,         /* HRI below */
    GS, 0x6B, 0x49, data.length, ...data,
  ];
}

class RawReceiptBuilder {
  constructor (width = 32) {
    this._w   = width;  /* char width: 32 for 58mm, 48 for 80mm */
    this._buf = [];
    this._push(CMD.INIT);
  }

  _push (...args) { this._buf.push(..._b(...args)); return this; }

  /* Typography helpers */
  _ln  (txt = '')  { return this._push(txt, LF); }
  _div ()          { return this._ln('-'.repeat(this._w)); }
  _eq  ()          { return this._ln('='.repeat(this._w)); }
  _blank (n = 1)   { for (let i = 0; i < n; i++) this._push(LF); return this; }

  _center (txt, w = this._w) {
    const s = String(txt).slice(0, w);
    const pad = Math.max(0, Math.floor((w - s.length) / 2));
    return this._ln(' '.repeat(pad) + s);
  }

  _left  (txt) { return this._ln(String(txt).slice(0, this._w)); }

  _col2 (left, right, w = this._w) {
    const l = String(left || ''),  r = String(right || '');
    const gap = w - l.length - r.length;
    return this._ln(gap > 0 ? l + ' '.repeat(gap) + r : (l.slice(0, w - r.length - 1) + ' ' + r).slice(0, w));
  }

  /* ── Document sections ─────────────────────────────────────── */

  header (store = {}) {
    const w = this._w;
    this._push(CMD.ALIGN_CENTER);
    this._push(CMD.DBLBOTH_ON);
    this._ln(store.businessName || 'SOKONI SmartPOS');
    this._push(CMD.DBLBOTH_OFF);
    this._push(CMD.BOLD_ON);
    if (store.branchName) this._ln(store.branchName);
    this._push(CMD.BOLD_OFF);
    if (store.address)    this._center(store.address);
    if (store.phone)      this._center(store.phone);
    if (store.kraPin)     this._center('PIN: ' + store.kraPin);
    if (store.vatNumber)  this._center('VAT: ' + store.vatNumber);
    this._push(CMD.ALIGN_LEFT);
    this._eq();
    return this;
  }

  receiptMeta (r = {}) {
    this._col2('Receipt No:', r.receiptNo  || '—');
    if (r.etimsNo)    this._col2('eTIMS Inv:', r.etimsNo);
    const d = r.timestamp ? new Date(r.timestamp) : new Date();
    this._col2('Date:', d.toLocaleDateString('en-KE', { day:'2-digit', month:'short', year:'numeric' }));
    this._col2('Time:', d.toLocaleTimeString('en-KE', { hour12: false }));
    this._col2('Cashier:', r.cashierName   || r.cashier || '—');
    this._col2('Register:', r.registerName || r.tillNumber || 'Default');
    if (r.customer?.name) this._col2('Customer:', r.customer.name);
    this._eq();
    return this;
  }

  items (items = []) {
    this._push(CMD.BOLD_ON);
    this._ln('ITEMS');
    this._push(CMD.BOLD_OFF);
    this._div();
    for (const item of items) {
      const name    = String(item.name || 'Item').slice(0, this._w);
      const qty     = Number(item.qty || item.quantity || 1);
      const price   = Number(item.unitPrice || item.price || 0);
      const disc    = Number(item.discount || 0);
      const lineTotal = qty * price - disc;

      this._left(name);
      /* Row: "  N x P.pp          KES T.tt" */
      const qtyPart  = `  ${qty} x ${_kes(price)}`;
      const discPart = disc ? ` -${_kes(disc)}` : '';
      const totPart  = _kes(lineTotal);
      const middle   = qtyPart + discPart;
      this._col2(middle, totPart);
    }
    this._div();
    return this;
  }

  totals (t = {}) {
    const sub  = Number(t.subtotal || 0);
    const disc = Number(t.discount || t.discountTotal || 0);
    const tax  = Number(t.vat || t.tax || t.taxTotal || 0);
    const tot  = Number(t.total || t.grandTotal || sub - disc + tax);

    if (sub)  this._col2('Subtotal:', _kes(sub));
    if (disc) this._col2('Discount:', '-' + _kes(disc));
    if (tax)  this._col2('VAT (16%):', _kes(tax));
    this._eq();
    this._push(CMD.BOLD_ON, CMD.DBLHEIGHT_ON);
    this._col2('TOTAL:', _kes(tot));
    this._push(CMD.DBLBOTH_OFF, CMD.BOLD_OFF);
    this._push(CMD.ALIGN_LEFT);
    this._eq();
    return this;
  }

  payment (payments = [], method = '') {
    /* Group by method */
    const byMethod = {};
    for (const p of payments) byMethod[p.method] = p;
    for (const [m, p] of Object.entries(byMethod)) {
      const label = { cash:'Cash', mpesa:'M-Pesa', card:'Card', wallet:'Wallet',
                      gift_card:'Gift Card', loyalty_full:'Loyalty' }[m] || m;
      this._col2(label + ':', _kes(p.amount));
      if (p.ref || p.mpesaCode)  this._col2('  Code:', p.ref || p.mpesaCode);
      if (p.tendered)            this._col2('  Tendered:', _kes(p.tendered));
      if (p.change != null)      this._col2('  Change:', _kes(p.change));
    }
    return this;
  }

  loyalty (l = {}) {
    if (!l || (!l.pointsEarned && !l.pointsBalance && !l.pointsRedeemed)) return this;
    this._div();
    if (l.pointsEarned)  this._col2('Loyalty Pts Earned:', '+' + l.pointsEarned);
    if (l.pointsRedeemed)this._col2('Pts Redeemed:', '-' + l.pointsRedeemed);
    if (l.pointsBalance) this._col2('Total Balance:', l.pointsBalance + ' pts');
    if (l.tierName)      this._col2('Tier:', l.tierName);
    return this;
  }

  qrBlock (url) {
    if (!url) return this;
    this._push(CMD.ALIGN_CENTER);
    this._blank(1);
    this._push(_buildQr(url, 5));
    this._blank(1);
    this._center('Scan to verify receipt');
    this._push(CMD.ALIGN_LEFT);
    return this;
  }

  barcodeBlock (receiptNo) {
    if (!receiptNo) return this;
    const safe = String(receiptNo).replace(/[^A-Za-z0-9\-]/g, '').slice(0, 20);
    if (safe.length < 2) return this;
    this._push(CMD.ALIGN_CENTER);
    this._blank(1);
    this._push(_buildBarcode(safe));
    this._blank(1);
    this._push(CMD.ALIGN_LEFT);
    return this;
  }

  footer (msg, website) {
    this._eq();
    this._push(CMD.ALIGN_CENTER, CMD.BOLD_ON);
    this._center(msg || 'Thank you for shopping with SOKONI!');
    this._push(CMD.BOLD_OFF);
    if (website) this._center(website);
    this._push(CMD.ALIGN_LEFT);
    this._blank(2);
    return this;
  }

  cut (full = true) { this._push(full ? CMD.CUT_FULL : CMD.CUT_PARTIAL); return this; }
  drawerPulse ()    { this._push(CMD.DRAWER_PIN0); return this; }

  build () { return new Uint8Array(this._buf); }
}

/* Receipt number KES formatter */
function _kes (n) {
  const v = Number(n);
  if (isNaN(v)) return '—';
  return 'KES ' + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/* ═══════════════════════════════════════════════════════════════════
   PRINT QUEUE  (offline-first, dedup, auto-drain)
   Jobs persist in localStorage so a refresh doesn't lose receipts.
═══════════════════════════════════════════════════════════════════ */
const _QUEUE_KEY = 'pps_print_queue';
class PrintQueue {
  _load () { try { return JSON.parse(localStorage.getItem(_QUEUE_KEY) || '[]'); } catch(_) { return []; } }
  _save (q) { try { localStorage.setItem(_QUEUE_KEY, JSON.stringify(q.slice(-100))); } catch(_) {} }

  /* Add job — idempotent on receiptId */
  enqueue (job) {
    const q = this._load();
    if (job.receiptId && q.some(j => j.receiptId === job.receiptId && j.status !== 'failed')) return false;
    const fullJob = {
      jobId:    _uuid(),
      status:   'pending',
      attempts: 0,
      maxAttempts: 3,
      queuedAt: new Date().toISOString(),
      ...job,
    };
    q.push(fullJob);
    this._save(q);
    return fullJob;
  }

  getAll     ()  { return this._load(); }
  getPending ()  { return this._load().filter(j => j.status === 'pending'); }
  getLength  ()  { return this.getPending().length; }

  markDone (jobId) { this._update(jobId, { status:'done', doneAt: new Date().toISOString() }); }
  markFail (jobId, err) { this._update(jobId, j => ({ status: j.attempts+1 >= j.maxAttempts ? 'failed' : 'pending', attempts: j.attempts+1, lastError: err })); }

  _update (jobId, patchOrFn) {
    const q = this._load();
    const idx = q.findIndex(j => j.jobId === jobId);
    if (idx < 0) return;
    if (typeof patchOrFn === 'function') Object.assign(q[idx], patchOrFn(q[idx]));
    else Object.assign(q[idx], patchOrFn);
    this._save(q);
  }

  purgeOld (daysOld = 7) {
    const cutoff = Date.now() - daysOld * 86400000;
    const q = this._load().filter(j => new Date(j.queuedAt).getTime() > cutoff);
    this._save(q);
  }
}

/* ═══════════════════════════════════════════════════════════════════
   PRINT HISTORY  (last 200 jobs, searchable, reprint-capable)
═══════════════════════════════════════════════════════════════════ */
const _HIST_KEY = 'pps_print_history';
class PrintHistory {
  _load () { try { return JSON.parse(localStorage.getItem(_HIST_KEY) || '[]'); } catch(_) { return []; } }
  _save (h) { try { localStorage.setItem(_HIST_KEY, JSON.stringify(h.slice(-200))); } catch(_) {} }

  record (entry) {
    const h = this._load();
    h.push({ historyId: _uuid(), recordedAt: new Date().toISOString(), ...entry });
    this._save(h);
  }

  getAll (limit = 50) { return this._load().slice(-limit).reverse(); }

  search (query = '') {
    const q = String(query).toLowerCase();
    return this._load().filter(h =>
      (h.receiptId || '').toLowerCase().includes(q) ||
      (h.docType   || '').toLowerCase().includes(q) ||
      (h.user      || '').toLowerCase().includes(q) ||
      (h.printer   || '').toLowerCase().includes(q)
    ).reverse();
  }

  getById (historyId) { return this._load().find(h => h.historyId === historyId) || null; }

  exportCsv () {
    const rows = this._load();
    const header = 'historyId,receiptId,docType,printedAt,printer,transport,status,durationMs,copies,user,registerId,branchId';
    const body   = rows.map(r =>
      [r.historyId, r.receiptId, r.docType, r.printedAt, r.printer, r.transport,
       r.status, r.durationMs, r.copies, r.user, r.registerId, r.branchId]
      .map(v => `"${String(v || '').replace(/"/g, '""')}"`)
      .join(',')
    ).join('\n');
    return header + '\n' + body;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   PRINT AUDIT  (Firestore enterprise trail — non-blocking)
   Collection: pos_print_audit / {merchantId} / entries
═══════════════════════════════════════════════════════════════════ */
class PrintAudit {
  log (entry) {
    try {
      const db = window.firebase?.firestore?.();
      if (!db) return;
      db.collection('pos_print_audit').add({
        ...entry,
        ts: window.firebase.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
    } catch(_) {}
  }
}

/* ═══════════════════════════════════════════════════════════════════
   PRINT METRICS  (timing measurements stored per session)
═══════════════════════════════════════════════════════════════════ */
const _METRICS_KEY = 'pps_print_metrics';
class PrintMetrics {
  record (m) {
    try {
      const prev = JSON.parse(localStorage.getItem(_METRICS_KEY) || '[]');
      prev.push({ ...m, at: new Date().toISOString() });
      localStorage.setItem(_METRICS_KEY, JSON.stringify(prev.slice(-50)));
    } catch(_) {}
  }

  getAll () { try { return JSON.parse(localStorage.getItem(_METRICS_KEY) || '[]'); } catch(_) { return []; } }

  avg (field) {
    const all = this.getAll().filter(m => m[field] != null);
    if (!all.length) return null;
    return Math.round(all.reduce((s, m) => s + m[field], 0) / all.length);
  }

  summary () {
    return {
      samples:      this.getAll().length,
      avgReceiptMs: this.avg('receiptGenMs'),
      avgPrintMs:   this.avg('printDoneMs'),
      avgTotalMs:   this.avg('totalMs'),
      avgConnectMs: this.avg('connectMs'),
    };
  }
}

/* ═══════════════════════════════════════════════════════════════════
   PRINT HEALTH  (30s heartbeat, drives header widget)
═══════════════════════════════════════════════════════════════════ */
class PrintHealth {
  constructor () {
    this._timer    = null;
    this._status   = 'unknown';
    this._lastPrint = null;
    this._listeners = [];
  }

  start (intervalMs = 30000) {
    if (this._timer) return;
    this._check().catch(() => {});
    this._timer = setInterval(() => this._check().catch(() => {}), intervalMs);
  }
  stop () { clearInterval(this._timer); this._timer = null; }

  async _check () {
    const pm  = window.PrinterManager;
    const sp  = window.SokoniPrinter;
    const was = this._status;

    const connected = !!(pm?.connected || sp?.connected);
    const queueLen  = pm ? pm.getQueue()?.length || 0 : 0;

    this._status = connected ? 'connected' : 'disconnected';
    const health = {
      connected,
      status:        this._status,
      transport:     pm?._activeTransport || 'none',
      profile:       pm?.profile,
      queueLength:   queueLen,
      lastPrint:     this._lastPrint,
      errorRate:     pm?.stats?.get?.()?.errors ?? 0,
    };

    _updateHeaderWidget(health);
    if (was !== this._status) this._listeners.forEach(fn => { try { fn(health); } catch(_) {} });
  }

  on (fn)      { this._listeners.push(fn); return this; }
  off (fn)     { this._listeners = this._listeners.filter(f => f !== fn); }
  getStatus () { return this._status; }
  markPrinted (id) { this._lastPrint = { id, at: new Date().toISOString() }; }
}

/* ═══════════════════════════════════════════════════════════════════
   TILL PRINTER CONFIG  (per-register settings, persistent)
   Keyed by registerId. Falls back to 'default' if no registerId.
═══════════════════════════════════════════════════════════════════ */
const _TILL_KEY = 'pps_till_config';
class TillPrinterConfig {
  _load () { try { return JSON.parse(localStorage.getItem(_TILL_KEY) || '{}'); } catch(_) { return {}; } }
  _save (all) { try { localStorage.setItem(_TILL_KEY, JSON.stringify(all)); } catch(_) {} }

  _defaults () {
    return {
      printerTransport:    null,
      paperWidth:          '58mm',
      receiptTemplate:     'standard',
      defaultCopies:       1,
      autoCashDrawer:      true,
      cashDrawerMethods:   ['cash'],
      lastDeviceInfo:      null,
      lastConnectedName:   null,
    };
  }

  get (registerId = 'default') {
    return Object.assign({}, this._defaults(), this._load()[registerId] || {});
  }

  update (registerId = 'default', patch = {}) {
    const all = this._load();
    all[registerId] = Object.assign({}, this._defaults(), all[registerId] || {}, patch);
    this._save(all);
    return all[registerId];
  }

  remember (registerId, deviceInfo) {
    if (!deviceInfo) return;
    this.update(registerId, {
      lastDeviceInfo:    deviceInfo,
      lastConnectedName: deviceInfo.name || deviceInfo.type || 'Printer',
      printerTransport:  deviceInfo.type || null,
    });
  }

  getAll () { return this._load(); }
}

/* ═══════════════════════════════════════════════════════════════════
   AUTO PRINT SETTINGS  (session-level behavior settings)
═══════════════════════════════════════════════════════════════════ */
const _AUTO_KEY = 'pps_auto_settings';
class AutoPrintSettings {
  _defaults () {
    return {
      autoAfterSale:     true,
      autoAfterRefund:   true,
      autoKitchenPrint:  true,
      askBefore:         false,
      silentMode:        true,
      copies:            1,
      customerCopy:      true,
      merchantCopy:      false,
      kitchenCopy:       false,
      printOnDrawerOpen: false,
    };
  }

  get () {
    try { return Object.assign({}, this._defaults(), JSON.parse(localStorage.getItem(_AUTO_KEY) || '{}')); }
    catch(_) { return this._defaults(); }
  }

  update (patch) {
    const s = Object.assign({}, this.get(), patch);
    try { localStorage.setItem(_AUTO_KEY, JSON.stringify(s)); } catch(_) {}
    return s;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   STORE PROFILE  (cached business identity for receipts)
   Populated on first print from a Firestore read or inline config.
═══════════════════════════════════════════════════════════════════ */
const _STORE_KEY = 'pps_store_profile';
function _getStoreProfile () {
  try { return JSON.parse(localStorage.getItem(_STORE_KEY) || 'null') || {}; }
  catch(_) { return {}; }
}
function _setStoreProfile (profile) {
  try { localStorage.setItem(_STORE_KEY, JSON.stringify(profile)); } catch(_) {}
}

/* ═══════════════════════════════════════════════════════════════════
   HEADER WIDGET  (injected into #pos-header-info on pos.html)
   Shows a ●/○ printer status dot next to the notification bell.
═══════════════════════════════════════════════════════════════════ */
function _updateHeaderWidget (health) {
  let chip = document.getElementById('pps-printer-chip');
  if (!chip) {
    /* First call: inject the chip */
    const target = document.getElementById('pos-header-info') ||
                   document.querySelector('.pos-header-info');
    if (!target) return;
    chip = document.createElement('button');
    chip.id        = 'pps-printer-chip';
    chip.className = 'pos-header-btn';
    chip.title     = 'Printer status — click to open setup';
    chip.style.cssText = 'position:relative;font-size:13px;line-height:1;display:flex;align-items:center;gap:3px;';
    chip.onclick   = () => window.open('pos-printer-setup.html', '_blank', 'width=560,height=900');
    /* Insert before the first button (notifications bell) */
    const firstBtn = target.querySelector('button');
    if (firstBtn) target.insertBefore(chip, firstBtn);
    else target.appendChild(chip);
  }

  const dot   = health.connected ? '🟢' : '⚪';
  const queue = health.queueLength > 0 ? ` (${health.queueLength})` : '';
  chip.innerHTML = dot + ' 🖨️' + queue;
  chip.title = health.connected
    ? `Printer connected${health.transport ? ' via ' + health.transport : ''}${queue ? ' — ' + health.queueLength + ' queued' : ''}`
    : 'Printer not connected — click to set up';
}

/* ═══════════════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════════════ */
function _uuid () {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (c === 'x' ? ((Math.random()*16)|0) : (((Math.random()*16)|0)&0x3|0x8));
    return r.toString(16);
  });
}

function _eng () { return window.SokoniPrinter; }
function _pm  () { return window.PrinterManager; }

async function _sendBytes (bytes) {
  const eng = _eng();
  if (eng?.printRaw) return eng.printRaw(bytes);
  /* Raw API unavailable — fall through to queue-based path */
  throw new Error('printRaw not available');
}

/* ═══════════════════════════════════════════════════════════════════
   POS PRINT SERVICE — MAIN ORCHESTRATOR
═══════════════════════════════════════════════════════════════════ */
class PosPrintService {

  constructor () {
    this.queue   = new PrintQueue();
    this.history = new PrintHistory();
    this.audit   = new PrintAudit();
    this.metrics = new PrintMetrics();
    this.health  = new PrintHealth();
    this.till    = new TillPrinterConfig();
    this.settings= new AutoPrintSettings();

    this._draining     = false;
    this._listeners    = {};

    /* Auto-drain queue when printer reconnects */
    this._wireReconnect();
    /* Start health monitor */
    this.health.start(30000);
  }

  /* ── Event system ───────────────────────────────────────────── */
  on   (ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); return this; }
  off  (ev, fn) { if (this._listeners[ev]) this._listeners[ev] = this._listeners[ev].filter(f => f !== fn); }
  _emit (ev, d) { (this._listeners[ev] || []).forEach(fn => { try { fn(d); } catch(_) {} }); }

  _wireReconnect () {
    const drain = () => this.drainQueue();
    const pm = window.PrinterManager;
    if (pm?.on) {
      pm.on('connected', drain);
      pm.on('p58e:connected', drain);
    } else if (window.SokoniPrinter?.on) {
      window.SokoniPrinter.on('connected', drain);
    }
    /* Retry when window regains focus */
    window.addEventListener('focus', () => { if (this.queue.getLength() > 0) drain(); });
  }

  /* ── Core print engine ──────────────────────────────────────── */
  async _print (bytes, jobMeta = {}) {
    const t0  = Date.now();
    const pm  = _pm();
    const eng = _eng();

    if (!eng?.connected && !pm?.connected) {
      /* Printer offline — queue the job */
      const queued = this.queue.enqueue({ bytes: Array.from(bytes), ...jobMeta });
      this._emit('queued', { ...jobMeta, queued });
      _updateHeaderWidget({ connected: false, queueLength: this.queue.getLength() });
      return { queued: true, jobId: queued?.jobId };
    }

    let jobId   = _uuid();
    let success = false;
    try {
      await _sendBytes(bytes);
      success = true;
      const ms = Date.now() - t0;
      this.metrics.record({ ...jobMeta, printDoneMs: ms, totalMs: ms });
      this.health.markPrinted(jobMeta.receiptId || jobId);
      this._emit('printed', { ...jobMeta, durationMs: ms });
      return { success: true, durationMs: ms };
    } catch (err) {
      /* printRaw failed — fall back to SokoniPrinter.printNow */
      try {
        if (!eng?.printNow) throw new Error('printNow not available on engine');
        await eng.printNow(jobMeta.docType || 'sale', jobMeta.data || {});
        success = true;
        const ms = Date.now() - t0;
        return { success: true, durationMs: ms };
      } catch (err2) {
        this._emit('error', { ...jobMeta, error: err2 });
        throw err2;
      }
    } finally {
      const ms = Date.now() - t0;
      this.history.record({
        receiptId:  jobMeta.receiptId || '—',
        docType:    jobMeta.docType   || 'unknown',
        printedAt:  new Date().toISOString(),
        printer:    pm?.profile?.model || eng?.getConfig?.()?.name || 'Printer',
        transport:  pm?._activeTransport || '—',
        status:     success ? 'success' : 'error',
        durationMs: ms,
        copies:     jobMeta.copies || 1,
        user:       jobMeta.cashierName || '—',
        registerId: jobMeta.registerId  || 'default',
        branchId:   jobMeta.branchId    || '—',
      });
      this.audit.log({
        docType:    jobMeta.docType   || 'unknown',
        receiptId:  jobMeta.receiptId || '—',
        printer:    pm?.profile?.model || 'Printer',
        transport:  pm?._activeTransport || '—',
        status:     success ? 'success' : 'error',
        durationMs: ms,
        copies:     jobMeta.copies || 1,
        cashierName:jobMeta.cashierName || '—',
        registerId: jobMeta.registerId  || '—',
        branchId:   jobMeta.branchId    || '—',
        merchantId: jobMeta.merchantId  || '—',
      });
    }
  }

  /* ── Offline queue drain ───────────────────────────────────── */
  async drainQueue () {
    if (this._draining) return;
    const pending = this.queue.getPending();
    if (!pending.length) return;
    this._draining = true;
    this._emit('queue:draining', { count: pending.length });
    try {
      for (const job of pending) {
        if (!_eng()?.connected && !_pm()?.connected) break; /* printer went away */
        try {
          await _sendBytes(new Uint8Array(job.bytes || []));
          this.queue.markDone(job.jobId);
          this._emit('queue:job_done', { jobId: job.jobId });
        } catch (err) {
          this.queue.markFail(job.jobId, err.message || String(err));
        }
      }
    } finally {
      this._draining = false;
    }
    _updateHeaderWidget({ connected: true, queueLength: this.queue.getLength() });
  }

  /* ── Build production receipt bytes ────────────────────────── */
  _buildSaleReceipt (receipt, context = {}) {
    const tillCfg = this.till.get(context.registerId || 'default');
    const is58mm  = (tillCfg.paperWidth || '58mm') === '58mm';
    const store   = Object.assign({}, _getStoreProfile(), context.store || {});

    const b = new RawReceiptBuilder(is58mm ? 32 : 48);
    b.header({
      businessName: store.businessName  || context.businessName || 'SOKONI SmartPOS',
      branchName:   store.branchName    || context.branchName   || receipt.branchId || '',
      address:      store.address       || context.address      || 'Nairobi, Kenya',
      phone:        store.phone         || context.phone        || '',
      kraPin:       store.kraPin        || context.kraPin       || receipt.kraPin     || '',
      vatNumber:    store.vatNumber     || context.vatNumber    || '',
    });
    b.receiptMeta({
      receiptNo:    receipt.receiptNo     || receipt.receiptNumber || '—',
      etimsNo:      receipt.etimsNo       || receipt.etimsInvoiceNo || '',
      timestamp:    receipt.timestamp     || receipt.createdAt || new Date().toISOString(),
      cashierName:  receipt.cashierName   || context.cashierName || receipt.cashier || '—',
      registerName: receipt.registerName  || context.registerName || receipt.tillNumber || 'Default',
      customer:     receipt.customer      || null,
    });

    const items = receipt.items || context.items || [];
    if (items.length) b.items(items);

    b.totals({
      subtotal:      receipt.subtotal      || receipt.subtotalAmount,
      discount:      receipt.discountTotal || receipt.discount || 0,
      vat:           receipt.taxTotal      || receipt.tax      || receipt.vat || 0,
      grandTotal:    receipt.grandTotal    || receipt.total,
    });

    const payments = receipt.payments || context.payments || [];
    if (payments.length) b.payment(payments, receipt.paymentMethod || '');

    const loyalty = receipt.loyalty || context.loyalty || {};
    if (loyalty.pointsEarned || loyalty.pointsBalance) b.loyalty(loyalty);

    /* QR Code — verify URL */
    const verifyUrl = receipt.receiptUrl
      || `https://mysokoni.co.ke/r/${receipt.receiptNo || ''}`;
    b.qrBlock(verifyUrl);

    /* Barcode of receipt number */
    if (receipt.receiptNo) b.barcodeBlock(String(receipt.receiptNo).replace(/[^A-Za-z0-9]/g, ''));

    b.footer(
      store.thankYouMsg || 'Thank you for shopping with SOKONI!',
      store.website     || 'www.mysokoni.co.ke',
    );
    b.cut(true);

    return b.build();
  }

  /* ── PUBLIC: Print after sale (primary checkout integration) ─ */
  async printAfterSale (receipt, context = {}) {
    const s = this.settings.get();
    if (!s.autoAfterSale) return { skipped: true };

    /* iOS / Safari: Web Bluetooth / Serial / USB not available — route to HTML receipt */
    if (window.SokoniIOSPrint) {
      const { isIOS } = SokoniIOSPrint.getPlatform();
      if (isIOS) return await SokoniIOSPrint.printAfterSale(receipt, context);
    }

    const copies = Number(context.copies || s.copies || 1);
    const meta = {
      docType:     'pos_sale',
      receiptId:   receipt.receiptNo || receipt.receiptNumber || 'UNKNOWN',
      cashierName: receipt.cashierName  || context.cashierName || '—',
      registerId:  context.registerId   || 'default',
      branchId:    context.branchId     || receipt.branchId || '—',
      merchantId:  context.merchantId   || '',
      copies,
      data:        receipt,
    };

    const bytes = this._buildSaleReceipt(receipt, context);
    const result = await this._print(bytes, meta);

    /* Cash drawer: fire after first copy */
    const payments = receipt.payments || context.payments || [];
    const hasCash = payments.some(p => p.method === 'cash') || context.method === 'cash';
    const tillCfg = this.till.get(context.registerId || 'default');
    if (hasCash && tillCfg.autoCashDrawer) {
      await this.openDrawer({ reason:'cash_payment', user: context.cashierName,
                              receiptId: meta.receiptId, registerId: meta.registerId });
    }

    /* Additional copies — unique receiptId per copy to avoid offline queue dedup */
    for (let i = 1; i < copies; i++) await this._print(bytes, { ...meta, receiptId: meta.receiptId + '_copy_' + i });

    /* Remember this device for multi-till */
    const pm = _pm();
    if (pm && context.registerId) {
      const devInfo = { type: pm._activeTransport, name: pm.profile?.model };
      this.till.remember(context.registerId, devInfo);
    }

    return result;
  }

  /* ── Cash drawer ───────────────────────────────────────────── */
  async openDrawer (opts = {}) {
    let opened = false;
    try {
      if (_pm()?.connected) { await _pm().openDrawer(opts.reason || 'manual', opts.user); opened = true; }
      else if (_eng()?.openCashDrawer) { await _eng().openCashDrawer(); opened = true; }
    } catch(_) {}
    if (opened) this._emit('drawer:opened', opts);
  }

  /* ── Refund receipt ────────────────────────────────────────── */
  async printRefund (data = {}) {
    const b = new RawReceiptBuilder(32);
    const store = _getStoreProfile();
    b.header({ businessName: store.businessName || 'SOKONI SmartPOS', ...store });
    b._push(CMD.ALIGN_CENTER, CMD.BOLD_ON); b._ln('REFUND RECEIPT'); b._push(CMD.BOLD_OFF, CMD.ALIGN_LEFT);
    b.receiptMeta({ receiptNo: data.refundNo || data.receiptNo, cashierName: data.cashierName, timestamp: data.timestamp });
    if (data.items?.length) b.items(data.items);
    b.totals({ grandTotal: data.refundAmount || data.total });
    b._eq(); b._center('REFUND APPROVED'); b._eq();
    b.footer('Refund processed. Thank you.', store.website);
    b.cut();
    return this._print(b.build(), { docType:'pos_refund', receiptId: data.refundNo, ...data });
  }

  /* ── Exchange receipt ──────────────────────────────────────── */
  async printExchange (data = {}) {
    const b = new RawReceiptBuilder(32);
    const store = _getStoreProfile();
    b.header({ businessName: store.businessName || 'SOKONI SmartPOS', ...store });
    b._push(CMD.ALIGN_CENTER, CMD.BOLD_ON); b._ln('EXCHANGE RECEIPT'); b._push(CMD.BOLD_OFF, CMD.ALIGN_LEFT);
    b.receiptMeta({ receiptNo: data.exchangeNo || data.receiptNo, cashierName: data.cashierName });
    b._div(); b._left('RETURNED ITEMS:');
    if (data.returnedItems?.length) b.items(data.returnedItems);
    b._div(); b._left('NEW ITEMS:');
    if (data.newItems?.length) b.items(data.newItems);
    if (data.difference != null) b._col2('Amount ' + (data.difference >= 0 ? 'Charged:' : 'Refunded:'), _kes(Math.abs(data.difference)));
    b.footer('Exchange complete. Thank you.', store.website);
    b.cut();
    return this._print(b.build(), { docType:'pos_exchange', receiptId: data.exchangeNo });
  }

  /* ── Quotation ─────────────────────────────────────────────── */
  async printQuote (data = {}) {
    const b = new RawReceiptBuilder(32);
    const store = _getStoreProfile();
    b.header({ businessName: store.businessName || 'SOKONI SmartPOS', ...store });
    b._push(CMD.ALIGN_CENTER, CMD.BOLD_ON); b._ln('QUOTATION'); b._push(CMD.BOLD_OFF, CMD.ALIGN_LEFT);
    b._col2('Quote No:', data.quoteNo || '—'); b._col2('Date:', new Date().toLocaleDateString('en-KE'));
    b._col2('Valid Until:', data.validUntil || '—'); b._col2('Customer:', data.customer?.name || '—');
    b._eq();
    if (data.items?.length) b.items(data.items);
    b.totals({ subtotal: data.subtotal, discount: data.discount, vat: data.vat, grandTotal: data.total });
    b._eq(); b._center('NOT A TAX INVOICE'); b._eq();
    b.footer('To accept this quote, visit SOKONI.', store.website); b.cut();
    return this._print(b.build(), { docType:'pos_quote', receiptId: data.quoteNo });
  }

  /* ── Tax Invoice ───────────────────────────────────────────── */
  async printInvoice (data = {}) {
    const b = new RawReceiptBuilder(32);
    const store = _getStoreProfile();
    b.header({ businessName: store.businessName || 'SOKONI SmartPOS', ...store });
    b._push(CMD.ALIGN_CENTER, CMD.BOLD_ON); b._ln('TAX INVOICE'); b._push(CMD.BOLD_OFF, CMD.ALIGN_LEFT);
    b._col2('Invoice No:', data.invoiceNo || '—'); b._col2('Date:', new Date().toLocaleDateString('en-KE'));
    if (data.etimsNo) b._col2('eTIMS Ref:', data.etimsNo);
    b._col2('Customer:', data.customer?.name || '—');
    if (data.customer?.kraPin) b._col2('Customer PIN:', data.customer.kraPin);
    b._eq();
    if (data.items?.length) b.items(data.items);
    b.totals({ subtotal: data.subtotal, discount: data.discount, vat: data.vat, grandTotal: data.total });
    b._eq(); b._center('OFFICIAL TAX INVOICE'); b._eq();
    b.qrBlock(data.verifyUrl || data.etimsQrUrl || '');
    b.footer('Thank you for your business.', store.website); b.cut();
    return this._print(b.build(), { docType:'pos_invoice', receiptId: data.invoiceNo });
  }

  /* ── Credit Note ───────────────────────────────────────────── */
  async printCreditNote (data = {}) {
    const b = new RawReceiptBuilder(32);
    const store = _getStoreProfile();
    b.header({ businessName: store.businessName || 'SOKONI SmartPOS', ...store });
    b._push(CMD.ALIGN_CENTER, CMD.BOLD_ON); b._ln('CREDIT NOTE'); b._push(CMD.BOLD_OFF, CMD.ALIGN_LEFT);
    b._col2('Credit No:', data.creditNo || '—'); b._col2('Orig Invoice:', data.origInvoiceNo || '—');
    b._col2('Date:', new Date().toLocaleDateString('en-KE'));
    b._eq(); b._col2('Credit Amount:', _kes(data.amount || 0));
    b._eq(); b.footer('Credit note issued. Contact us for details.', store.website); b.cut();
    return this._print(b.build(), { docType:'pos_credit_note', receiptId: data.creditNo });
  }

  /* ── Kitchen Order Ticket ──────────────────────────────────── */
  async printKitchenTicket (data = {}) {
    const b = new RawReceiptBuilder(32);
    b._push(CMD.ALIGN_CENTER, CMD.BOLD_ON, CMD.DBLBOTH_ON);
    b._ln('KITCHEN'); b._push(CMD.DBLBOTH_OFF, CMD.BOLD_OFF, CMD.ALIGN_LEFT);
    b._col2('Order:', data.orderNo || '—'); b._col2('Table:', data.table || '—');
    b._col2('Cashier:', data.cashierName || '—');
    b._col2('Time:', new Date().toLocaleTimeString('en-KE', { hour12:false }));
    b._eq();
    for (const item of (data.items || [])) {
      b._push(CMD.BOLD_ON, CMD.DBLHEIGHT_ON);
      b._ln(`  ${item.qty || 1}x  ${(item.name||'').slice(0,24)}`);
      b._push(CMD.BOLD_OFF, CMD.DBLBOTH_OFF);
      if (item.notes) b._left('     Note: ' + item.notes);
    }
    b._eq(); if (data.notes) { b._left('NOTES: ' + data.notes); b._eq(); }
    b._blank(3); b.cut(false);
    return this._print(b.build(), { docType:'pos_kitchen', receiptId: data.orderNo });
  }

  /* ── Delivery Note ─────────────────────────────────────────── */
  async printDeliveryNote (data = {}) {
    const b = new RawReceiptBuilder(32);
    const store = _getStoreProfile();
    b.header({ businessName: store.businessName || 'SOKONI SmartPOS', ...store });
    b._push(CMD.ALIGN_CENTER, CMD.BOLD_ON); b._ln('DELIVERY NOTE'); b._push(CMD.BOLD_OFF, CMD.ALIGN_LEFT);
    b._col2('Delivery No:', data.deliveryNo || '—'); b._col2('Date:', new Date().toLocaleDateString('en-KE'));
    b._col2('Driver:', data.driverName || '—'); b._col2('Vehicle:', data.vehiclePlate || '—');
    b._eq(); b._left('DELIVER TO:'); b._left(data.customer?.name || '—');
    b._left(data.deliveryAddress || '—');
    b._eq();
    if (data.items?.length) b.items(data.items);
    b._eq(); b._left('Signature: _______________________'); b._blank(2);
    b._left('Received by: ____________________'); b._blank(2); b.cut();
    return this._print(b.build(), { docType:'pos_delivery', receiptId: data.deliveryNo });
  }

  /* ── Packing Slip ──────────────────────────────────────────── */
  async printPackingSlip (data = {}) {
    const b = new RawReceiptBuilder(32);
    const store = _getStoreProfile();
    b.header({ businessName: store.businessName || 'SOKONI SmartPOS', ...store });
    b._push(CMD.ALIGN_CENTER, CMD.BOLD_ON); b._ln('PACKING SLIP'); b._push(CMD.BOLD_OFF, CMD.ALIGN_LEFT);
    b._col2('Order:', data.orderNo || '—'); b._col2('Date:', new Date().toLocaleDateString('en-KE'));
    b._eq();
    if (data.items?.length) b.items(data.items);
    b._eq(); b._left('Packed by: __________________'); b._blank(1);
    b._left('Checked by: _________________'); b.cut();
    return this._print(b.build(), { docType:'pos_packing_slip', receiptId: data.orderNo });
  }

  /* ── Stock Transfer ────────────────────────────────────────── */
  async printStockTransfer (data = {}) {
    const b = new RawReceiptBuilder(32);
    b._push(CMD.ALIGN_CENTER, CMD.BOLD_ON); b._ln('STOCK TRANSFER'); b._push(CMD.BOLD_OFF, CMD.ALIGN_LEFT);
    b._col2('Transfer No:', data.transferNo || '—'); b._col2('Date:', new Date().toLocaleDateString('en-KE'));
    b._col2('From:', data.fromBranch || '—'); b._col2('To:', data.toBranch || '—');
    b._col2('Auth By:', data.authorisedBy || '—'); b._eq();
    if (data.items?.length) b.items(data.items);
    b._eq(); b._left('Dispatched by: ________________'); b._blank(1);
    b._left('Received by: _________________'); b.cut();
    return this._print(b.build(), { docType:'pos_stock_transfer', receiptId: data.transferNo });
  }

  /* ── Purchase Order ────────────────────────────────────────── */
  async printPurchaseOrder (data = {}) {
    const b = new RawReceiptBuilder(32);
    const store = _getStoreProfile();
    b.header({ businessName: store.businessName || 'SOKONI SmartPOS', ...store });
    b._push(CMD.ALIGN_CENTER, CMD.BOLD_ON); b._ln('PURCHASE ORDER'); b._push(CMD.BOLD_OFF, CMD.ALIGN_LEFT);
    b._col2('PO No:', data.poNo || '—'); b._col2('Date:', new Date().toLocaleDateString('en-KE'));
    b._col2('Supplier:', data.supplierName || '—');
    if (data.supplierPin) b._col2('Supplier PIN:', data.supplierPin);
    b._eq();
    if (data.items?.length) b.items(data.items);
    b.totals({ subtotal: data.subtotal, vat: data.vat, grandTotal: data.total });
    b._eq(); b._left('Authorised by: ______________'); b.cut();
    return this._print(b.build(), { docType:'pos_purchase_order', receiptId: data.poNo });
  }

  /* ── Cash In / Out ─────────────────────────────────────────── */
  async printCashIn (data = {}) {
    const b = new RawReceiptBuilder(32);
    b._push(CMD.ALIGN_CENTER, CMD.BOLD_ON); b._ln('CASH IN'); b._push(CMD.BOLD_OFF, CMD.ALIGN_LEFT);
    b._col2('Date:', new Date().toLocaleDateString('en-KE'));
    b._col2('Time:', new Date().toLocaleTimeString('en-KE', { hour12:false }));
    b._col2('Register:', data.registerName || '—'); b._col2('Cashier:', data.cashierName || '—');
    b._eq(); b._push(CMD.BOLD_ON); b._col2('AMOUNT:', _kes(data.amount || 0)); b._push(CMD.BOLD_OFF);
    b._eq(); b._left('Reason: ' + (data.reason || 'Opening float'));
    b._blank(1); b._left('Authorised: __________________'); b.cut();
    return this._print(b.build(), { docType:'pos_cash_in', receiptId: data.refNo || _uuid().slice(0,8) });
  }

  async printCashOut (data = {}) {
    const b = new RawReceiptBuilder(32);
    b._push(CMD.ALIGN_CENTER, CMD.BOLD_ON); b._ln('CASH OUT'); b._push(CMD.BOLD_OFF, CMD.ALIGN_LEFT);
    b._col2('Date:', new Date().toLocaleDateString('en-KE'));
    b._col2('Time:', new Date().toLocaleTimeString('en-KE', { hour12:false }));
    b._col2('Register:', data.registerName || '—'); b._col2('Cashier:', data.cashierName || '—');
    b._eq(); b._push(CMD.BOLD_ON); b._col2('AMOUNT:', _kes(data.amount || 0)); b._push(CMD.BOLD_OFF);
    b._eq(); b._left('Reason: ' + (data.reason || 'Petty cash'));
    b._blank(1); b._left('Authorised: __________________'); b.cut();
    return this._print(b.build(), { docType:'pos_cash_out', receiptId: data.refNo || _uuid().slice(0,8) });
  }

  /* ── Shift / Day Reports ───────────────────────────────────── */
  _buildShiftReport (label, data = {}) {
    const b = new RawReceiptBuilder(32);
    const store = _getStoreProfile();
    b.header({ businessName: store.businessName || 'SOKONI SmartPOS', ...store });
    b._push(CMD.ALIGN_CENTER, CMD.BOLD_ON); b._ln(label); b._push(CMD.BOLD_OFF, CMD.ALIGN_LEFT);
    b._col2('Register:', data.registerName || '—');
    b._col2('Cashier:', data.cashierName || '—');
    b._col2('Shift Start:', data.shiftStart ? new Date(data.shiftStart).toLocaleTimeString('en-KE', {hour12:false}) : '—');
    b._col2('Shift End:', new Date().toLocaleTimeString('en-KE', {hour12:false}));
    b._eq();
    b._col2('Total Sales:', _kes(data.totalSales || 0));
    b._col2('No. Transactions:', String(data.transactionCount || 0));
    b._col2('Cash Sales:', _kes(data.cashSales || 0));
    b._col2('M-Pesa Sales:', _kes(data.mpesaSales || 0));
    b._col2('Card Sales:', _kes(data.cardSales || 0));
    if (data.refunds) b._col2('Refunds:', _kes(data.refunds));
    if (data.discounts) b._col2('Discounts:', _kes(data.discounts));
    b._eq();
    b._col2('Opening Float:', _kes(data.openingFloat || 0));
    b._col2('Cash In:', _kes(data.cashIn || 0));
    b._col2('Cash Out:', _kes(data.cashOut || 0));
    b._col2('Expected Cash:', _kes(data.expectedCash || 0));
    if (data.actualCash != null) b._col2('Actual Cash:', _kes(data.actualCash));
    b._eq();
    b._left('Cashier Signature: _____________'); b._blank(1);
    b._left('Manager Signature: _____________'); b._blank(2);
    b.cut();
    return b;
  }

  async printShiftReport (data = {}) {
    const b = this._buildShiftReport('SHIFT REPORT', data);
    return this._print(b.build(), { docType:'pos_shift_report', receiptId: data.shiftId || _uuid().slice(0,8) });
  }

  async printXReport (data = {}) {
    const b = this._buildShiftReport('X REPORT (MID-DAY)', data);
    return this._print(b.build(), { docType:'pos_x_report', receiptId: data.reportId || _uuid().slice(0,8) });
  }

  async printZReport (data = {}) {
    const b = this._buildShiftReport('Z REPORT (END OF DAY)', data);
    return this._print(b.build(), { docType:'pos_z_report', receiptId: data.reportId || _uuid().slice(0,8) });
  }

  async printEndOfDay (data = {}) {
    const b = this._buildShiftReport('END OF DAY REPORT', data);
    return this._print(b.build(), { docType:'pos_eod', receiptId: data.reportId || _uuid().slice(0,8) });
  }

  /* ── Reprint from history ──────────────────────────────────── */
  async reprint (historyId) {
    const entry = this.history.getById(historyId);
    if (!entry) throw new Error('Print history entry not found');
    /* Re-build the receipt from saved data if available */
    if (entry.receiptData) {
      const bytes = this._buildSaleReceipt(entry.receiptData, {});
      return this._print(bytes, { ...entry, docType: entry.docType + '_reprint' });
    }
    /* Fallback: SokoniPrinter re-print from job ID */
    try {
      const jobId = entry.jobId;
      if (jobId && _eng()?.retryJob) return _eng().retryJob(jobId);
    } catch(_) {}
    throw new Error('Cannot reprint: original receipt data not in history');
  }

  /* ── Export / Download ─────────────────────────────────────── */
  exportHistory () { return this.history.exportCsv(); }

  downloadHistory () {
    const csv  = this.exportHistory();
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url; a.download = 'sokoni-print-history.csv';
    a.click(); URL.revokeObjectURL(url);
  }

  /* Browser print (PDF equivalent — opens system print dialog) */
  downloadPDF (historyId) {
    const h = this.history.getById(historyId);
    if (!h) { alert('History entry not found'); return; }
    const w = window.open('', '_blank', 'width=420,height=700');
    if (!w) return;
    const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    w.document.write(`<html><head><title>Receipt ${esc(h.receiptId)}</title>
      <style>body{font-family:monospace;font-size:12px;margin:20px;max-width:300px}
      h2{text-align:center}.row{display:flex;justify-content:space-between}
      hr{border:1px dashed #000}.footer{text-align:center;margin-top:16px}</style></head>
      <body><h2>SOKONI SmartPOS</h2><hr>
      <div class="row"><span>Receipt:</span><span>${esc(h.receiptId) || '—'}</span></div>
      <div class="row"><span>Printed:</span><span>${esc(new Date(h.printedAt).toLocaleString('en-KE'))}</span></div>
      <div class="row"><span>Type:</span><span>${esc(h.docType) || '—'}</span></div>
      <div class="row"><span>Printer:</span><span>${esc(h.printer) || '—'}</span></div>
      <div class="row"><span>Cashier:</span><span>${esc(h.user) || '—'}</span></div>
      <div class="row"><span>Status:</span><span>${esc(h.status) || '—'}</span></div>
      <div class="row"><span>Duration:</span><span>${esc(h.durationMs) || '—'} ms</span></div>
      <hr><div class="footer">SOKONI SmartPOS — mysokoni.co.ke</div>
      <script>window.onload=function(){window.print()}<\/script>
      </body></html>`);
    w.document.close();
  }

  /* ── Store profile ─────────────────────────────────────────── */
  setStoreProfile (profile) { _setStoreProfile(profile); }
  getStoreProfile ()        { return _getStoreProfile(); }

  /* ── Diagnostics ───────────────────────────────────────────── */
  getDiagnostics () {
    return {
      health:          this.health.getStatus(),
      queueLength:     this.queue.getLength(),
      queuePending:    this.queue.getPending(),
      historyCount:    this.history.getAll(10).length,
      autoSettings:    this.settings.get(),
      metrics:         this.metrics.summary(),
      printStats:      _pm()?.stats?.get?.() || {},
      engines: {
        sokoniPrinter:    !!window.SokoniPrinter,
        printerManager:   !!window.PrinterManager,
        p58ePrinter:      !!window.P58EPrinter,
        posPrintService:  true,
      },
    };
  }
}

/* ── Export ─────────────────────────────────────────────────────── */
window.PosPrintService = new PosPrintService();

/* Start health monitor after DOM is ready */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.PosPrintService.health.start());
} else {
  window.PosPrintService.health.start();
}

console.log('[PosPrintService v1.0] Production Print Service loaded — window.PosPrintService ready');

})();
