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

  /* Retention: drop only OLD, finished jobs (done/failed). Unfinished work
     (pending) is NEVER auto-removed — a queued receipt must not silently vanish. */
  purgeOld (daysOld = 7) {
    const cutoff = Date.now() - daysOld * 86400000;
    const q = this._load().filter(j =>
      j.status === 'pending' ||                                 /* keep all unfinished */
      new Date(j.queuedAt).getTime() > cutoff);                 /* keep recent finished */
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
    /* Not a competing status calc: nudge the ONE canonical state to reconcile with the
       transport truth (safety net for any BLE/transport event that was missed), then let
       the state machine's subscribers (chip + status text) re-render. */
    try { _printerState.reconcile(); } catch (_) {}
    this._status = _printerState.get();   /* mirror for back-compat getStatus() */
    try { _updateHeaderWidget(); } catch (_) {}
  }

  on (fn)      { this._listeners.push(fn); return this; }
  off (fn)     { this._listeners = this._listeners.filter(f => f !== fn); }
  getStatus () { return this._status; }
  markPrinted (id) { this._lastPrint = { id, at: new Date().toISOString() }; }
}

/* ═══════════════════════════════════════════════════════════════════
   CANONICAL PRINTER STATE — the SINGLE source of truth for printer state.
   Event-driven (no polling): derived from PrinterManager transport events, the
   printReceipt lifecycle, and browser online/offline. Every status surface
   (the header light, diagnostics, future settings) subscribes HERE — there is no
   other status calculation. Emits only on change.
═══════════════════════════════════════════════════════════════════ */
const PRINTER_STATES = {
  disconnected: { icon: '○',   text: 'No printer' },
  searching:    { icon: '🔍',  text: 'Searching…' },
  connecting:   { icon: '…',   text: 'Connecting…' },
  connected:    { icon: '✅',  text: 'Connected' },
  printing:     { icon: '🖨️',  text: 'Printing…' },
  retrying:     { icon: '↻',   text: 'Reconnecting…' },
  offline:      { icon: '📴',  text: 'Offline — queued' },
};

class PrinterStateMachine {
  constructor () { this._state = 'disconnected'; this._meta = {}; this._subs = []; this._wired = false; }

  get ()   { return this._state; }
  meta ()  { const d = PRINTER_STATES[this._state] || PRINTER_STATES.disconnected; return { state: this._state, icon: d.icon, text: d.text, ...this._meta }; }

  /* subscribe returns an unsubscribe fn and fires once with the current state. */
  subscribe (fn) {
    if (typeof fn !== 'function') return () => {};
    this._subs.push(fn);
    try { fn(this.meta()); } catch (_) {}
    return () => { this._subs = this._subs.filter(f => f !== fn); };
  }

  set (stateKey, meta) {
    const next = PRINTER_STATES[stateKey] ? stateKey : 'disconnected';
    const changed = next !== this._state || (meta && meta.name && meta.name !== this._meta.name);
    this._state = next;
    this._meta  = meta || {};
    if (changed) { const m = this.meta(); this._subs.forEach(fn => { try { fn(m); } catch (_) {} }); }
  }

  /* Resting state from the transport truth — used on wire + as a reconciliation nudge. */
  reconcile () {
    const pm = window.PrinterManager, sp = window.SokoniPrinter;
    const connected = !!(pm && pm.connected) || !!(sp && sp.connected);
    if (connected) { if (this._state !== 'printing') this.set('connected', { name: (pm && pm.profile && pm.profile.model) || undefined }); return; }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { this.set('offline'); return; }
    if (this._state !== 'retrying') this.set('disconnected');
  }

  /* Attach to printer transport events + browser connectivity. Idempotent.
     Subscribes to BOTH the engine (window.SokoniPrinter — where connect() actually fires
     'connected') AND the PrinterManager wrapper. Earlier this only wired PrinterManager;
     since the in-POS dropdown connects via SokoniPrinter, the wrapper never forwarded the
     event and the header chip stayed grey ("doesn't turn connected") even on success. */
  wire () {
    if (this._wired) return; this._wired = true;
    const sources = [window.SokoniPrinter, window.PrinterManager].filter(
      (p, i, a) => p && typeof p.on === 'function' && a.indexOf(p) === i
    );
    for (const pm of sources) {
      pm.on('connected',         d  => this.set('connected', { name: d && (d.name || d.model) }));
      pm.on('disconnected',      () => this.reconcile());
      pm.on('printed',           () => { if (this._state === 'printing') this.set('connected', this._meta); });
      pm.on('error',             () => { if (this._state !== 'retrying') this.reconcile(); });
      pm.on('p58e:connected',        d  => this.set('connected', { name: d && d.name }));
      pm.on('p58e:disconnected',     () => this.reconcile());
      pm.on('p58e:reconnecting',     () => this.set('retrying'));
      pm.on('p58e:reconnect_failed', () => this.set('disconnected'));
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online',  () => this.reconcile());
      window.addEventListener('offline', () => this.set('offline'));
    }
    this.reconcile();
  }

  /* Fed by the printReceipt lifecycle so the light reflects an in-progress print/retry. */
  onPrintLifecycle (state) {
    if (state === 'sending' || state === 'printing')       this.set('printing');
    else if (state === 'retry')                            this.set('retrying');
    else if (state === 'queued_offline')                   this.set('offline');
    else if (state === 'success' || state === 'fallback_success' || state === 'skipped') this.reconcile();
  }
}

/* Module singleton — the one instance everything shares. */
const _printerState = new PrinterStateMachine();

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
    chip.title     = 'Printer';
    chip.style.cssText = 'position:relative;font-size:13px;line-height:1;display:flex;align-items:center;gap:3px;';
    /* Opens the in-POS printer dropdown — connect / status / reconnect / forget / test /
       advanced — all inside the POS. NEVER navigates to a separate page (that broke the
       checkout flow); "Advanced options" is the only route to the full setup page. */
    chip.onclick = (e) => { try { e.stopPropagation(); } catch (_) {} _ppsTogglePrinterMenu(chip); };
    /* Insert before the first button (notifications bell) */
    const firstBtn = target.querySelector('button');
    if (firstBtn) target.insertBefore(chip, firstBtn);
    else target.appendChild(chip);
  }

  /* Render from the ONE canonical state (arg ignored — kept for call-site compat). */
  const m  = _printerState.meta();
  const pm = window.PrinterManager;
  const qn = pm ? (pm.getQueue()?.length || 0) : 0;
  const connected = m.state === 'connected' || m.state === 'printing';
  const dot   = connected ? '🟢' : (m.state === 'retrying' ? '🟡' : (m.state === 'offline' ? '📴' : '⚪'));
  const queue = qn > 0 ? ` (${qn})` : '';
  chip.innerHTML = dot + ' 🖨️' + queue;
  chip.title = (m.name || m.text)
    + (connected && pm && pm._activeTransport ? ' via ' + pm._activeTransport : '')
    + (queue ? ' — ' + qn + ' queued' : '');
}

/* ═══════════════════════════════════════════════════════════════════
   IN-POS PRINTER DROPDOWN  — connect/status/reconnect/forget/test/advanced,
   all inside the POS (never a separate page). Earbuds-style: pair once → it
   auto-reconnects every future POS open. Hides the BLE/COM/Serial/USB
   complexity — those live under "Advanced options" (pos-printer-setup.html).
═══════════════════════════════════════════════════════════════════ */
function _ppsEsc (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

function _ppsBtn (id, label, kind) {
  const styles = {
    primary: 'flex:1;background:linear-gradient(135deg,#71ff00,#4fc800);color:#000;border:none;',
    ghost:   'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.14);color:#fff;',
    danger:  'background:rgba(255,61,61,0.08);border:1px solid rgba(255,61,61,0.25);color:#ff6b6b;',
  };
  return '<button id="' + id + '" style="' + (styles[kind] || styles.ghost) +
    'padding:11px 13px;border-radius:10px;font-weight:800;font-size:12.5px;cursor:pointer;font-family:inherit;">' + label + '</button>';
}

function _ppsLastPrinter () {
  try { return (JSON.parse(localStorage.getItem('spp_profile') || '{}').lastDevice) || null; } catch (_) { return null; }
}

function _ppsCloseMenu () {
  const p = document.getElementById('pps-printer-menu');
  if (p) { p.remove(); document.removeEventListener('pointerdown', _ppsMenuOutside, true); }
}
function _ppsMenuOutside (e) {
  const panel = document.getElementById('pps-printer-menu');
  const chip  = document.getElementById('pps-printer-chip');
  if (panel && !panel.contains(e.target) && !(chip && chip.contains(e.target))) _ppsCloseMenu();
}

function _ppsTogglePrinterMenu (anchor) {
  if (document.getElementById('pps-printer-menu')) { _ppsCloseMenu(); return; }
  const panel = document.createElement('div');
  panel.id = 'pps-printer-menu';
  panel.style.cssText = [
    'position:fixed', 'z-index:100000', 'width:270px', 'background:#0d0d0d',
    'border:1px solid rgba(113,255,0,0.18)', 'border-radius:14px',
    'box-shadow:0 14px 46px rgba(0,0,0,0.65)', 'padding:14px', 'font-family:inherit', 'color:#fff',
  ].join(';');
  document.body.appendChild(panel);
  /* Anchor to the element's rect when one is given (POS header chip). When opened from a
     button with no meaningful rect (Settings row, off-screen), or no anchor at all, centre
     the panel so it never renders off the viewport. */
  const r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
  if (r && r.width && r.height) {
    panel.style.top  = (r.bottom + 8) + 'px';
    panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 282)) + 'px';
  } else {
    panel.style.top  = '50%';
    panel.style.left = '50%';
    panel.style.transform = 'translate(-50%,-50%)';
  }
  _ppsRenderMenu(panel);
  setTimeout(() => document.addEventListener('pointerdown', _ppsMenuOutside, true), 0);
}

/* Canonical IN-PAGE printer opener — every ordinary printer button (POS header, Settings)
   calls this to open the dropdown in place; NOTHING navigates to another page. Only the
   dropdown's own "Advanced options" opens the full setup page (firmware/USB/serial). */
if (typeof window !== 'undefined') {
  window.openPrinterMenu = function (anchor) {
    try { _ppsTogglePrinterMenu(anchor || document.getElementById('pps-printer-chip') || null); }
    catch (_) {}
  };
}

function _ppsRenderMenu (panel, override) {
  const pm        = window.SokoniPrinter || window.PrinterManager;
  const connected = !!(pm && pm.connected);
  const hasBt     = !!navigator.bluetooth;
  const last      = _ppsLastPrinter();
  const lastName  = last && (last.name || last.type) || null;
  const remember  = localStorage.getItem('pps_remember') !== '0';

  const head = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">' +
    '<div style="font-weight:900;font-size:13px;">🖨️ Printer</div>' +
    '<button id="pps-menu-x" title="Close" style="background:none;border:none;color:rgba(255,255,255,.45);font-size:16px;cursor:pointer;line-height:1;">✕</button></div>';

  let body;
  if (override) {
    body = override;
  } else if (connected) {
    const st = (pm.getStatus && pm.getStatus()) || {};
    const name = st.name || lastName || 'Printer';
    body = '<div style="display:flex;align-items:center;gap:7px;margin-bottom:8px;"><span style="color:#71ff00;">●</span> <strong>Connected</strong></div>' +
      '<div style="font-size:12px;color:rgba(255,255,255,.6);margin-bottom:14px;">' + _ppsEsc(name) + '</div>' +
      '<div style="display:flex;gap:8px;">' + _ppsBtn('pps-test', '🧪 Test print', 'ghost') + _ppsBtn('pps-forget', 'Forget', 'danger') + '</div>';
  } else if (!hasBt) {
    body = '<div style="font-size:12.5px;color:rgba(255,255,255,.75);line-height:1.55;margin-bottom:12px;">Bluetooth pairing needs <strong>Chrome on Android or desktop</strong>. Receipts still print as a shareable page in this browser.</div>' +
      _ppsBtn('pps-advanced', 'Advanced options', 'ghost');
  } else {
    body = '<div style="font-size:12.5px;color:rgba(255,255,255,.65);margin-bottom:12px;">No printer connected</div>' +
      '<div style="display:flex;">' + _ppsBtn('pps-connect', '🔗 Connect Printer', 'primary') + '</div>' +
      '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:rgba(255,255,255,.6);margin:13px 0;cursor:pointer;"><input id="pps-remember" type="checkbox" ' + (remember ? 'checked' : '') + '> Remember this printer</label>' +
      (lastName
        ? '<div style="font-size:11.5px;color:rgba(255,255,255,.45);margin-bottom:8px;">Last printer: <span style="color:#71ff00;">' + _ppsEsc(lastName) + '</span></div><div style="display:flex;gap:8px;">' + _ppsBtn('pps-reconnect', '↻ Reconnect', 'ghost') + _ppsBtn('pps-advanced', 'Advanced', 'ghost') + '</div>'
        : '<div style="display:flex;">' + _ppsBtn('pps-advanced', 'Advanced options', 'ghost') + '</div>');
  }
  panel.innerHTML = head + body;
  _ppsWireMenu(panel);
}

function _ppsWireMenu (panel) {
  const pm = window.SokoniPrinter || window.PrinterManager;
  const q = id => panel.querySelector('#' + id);
  const spin = txt => '<div style="font-size:12.5px;color:rgba(255,255,255,.75);display:flex;align-items:center;gap:8px;">⏳ ' + txt + '</div>';
  if (q('pps-menu-x'))   q('pps-menu-x').onclick   = _ppsCloseMenu;
  if (q('pps-remember')) q('pps-remember').onchange = e => localStorage.setItem('pps_remember', e.target.checked ? '1' : '0');
  if (q('pps-advanced')) q('pps-advanced').onclick = () => { _ppsCloseMenu(); try { (window.openPrinterSetup?window.openPrinterSetup():location.href='pos-printer-setup.html'); } catch (_) {} };
  if (q('pps-test'))     q('pps-test').onclick     = () => { try { pm && pm.testPrint && pm.testPrint(); } catch (_) {} };
  if (q('pps-forget'))   q('pps-forget').onclick   = () => { try { localStorage.removeItem('spp_profile'); pm && pm.disconnect && pm.disconnect(); } catch (_) {} _ppsRenderMenu(panel); };
  if (q('pps-reconnect')) q('pps-reconnect').onclick = () => {
    _ppsRenderMenu(panel, spin('Searching for saved printer…'));
    Promise.resolve(pm && pm.autoReconnect && pm.autoReconnect())
      .then(ok => {
        if (pm.connected || ok) { _ppsRenderMenu(panel); return; }
        /* autoReconnect() returned false → getDevices() had nothing to re-link (printer off,
           out of range, or the browser did not retain the grant). Say so — don't silently fail. */
        _ppsRenderMenu(panel, _ppsErrBody({ message: 'saved printer unavailable' }, true));
      })
      .catch(e => _ppsRenderMenu(panel, _ppsErrBody(e, true)));
  };
  if (q('pps-connect')) q('pps-connect').onclick = () => {
    _ppsRenderMenu(panel, spin('Opening Bluetooth chooser…'));
    Promise.resolve(pm && pm.discoverBy && pm.discoverBy('bluetooth'))
      .then(list => { if (list && list[0]) return pm.connect(list[0]); throw new Error('no-device'); })
      .then(() => { _ppsRenderMenu(panel, '<div style="display:flex;align-items:center;gap:7px;margin-bottom:8px;"><span style="color:#71ff00;">✓</span> <strong>Connected</strong></div><div style="font-size:12px;color:rgba(255,255,255,.6);">Saved — reconnects automatically next time.</div>'); setTimeout(_ppsCloseMenu, 1600); })
      .catch(e => _ppsRenderMenu(panel, _ppsErrBody(e, false)));
  };
  const de = q('pps-details-toggle');
  if (de) de.onclick = () => { const d = q('pps-details'); if (d) d.style.display = d.style.display === 'none' ? 'block' : 'none'; };
}

/* Turn a connect/reconnect exception into an ACTIONABLE message + a collapsible Details view
   with the raw error (the founder asked for meaningful errors, never a swallowed generic one).
   `remembered` picks reconnect-flavoured copy over first-connect copy. */
function _ppsErrClassify (e) {
  const raw = ((e && (e.detail || e.message)) || (e && e.original && e.original.message) || String(e || '')).toLowerCase();
  if (raw.includes('no-device') || raw.includes('no device') || raw.includes('cancel') || raw.includes('notfound'))
    return 'No printer selected — the Bluetooth chooser was dismissed.';
  if (raw.includes('web bluetooth') || raw.includes('bluetooth is not available') || raw.includes('not supported'))
    return 'This browser can’t pair Bluetooth printers. Use Chrome/Edge on Android or desktop (iPhone/Safari can’t).';
  if (raw.includes('no writable') || raw.includes('no print service'))
    return 'That device isn’t an ESC/POS printer (no writable print service). Pick your P58E / 58mm printer.';
  if (raw.includes('saved printer') || raw.includes('getdevices') || raw.includes('unavailable'))
    return 'Saved printer unavailable — it’s likely turned off or out of range. Power it on, then Reconnect.';
  if (raw.includes('gatt') || raw.includes('out of range') || raw.includes('powered'))
    return 'Bluetooth connection failed — make sure the printer is on, charged, and not paired to another device.';
  if (raw.includes('permission') || raw.includes('security') || raw.includes('notallowed'))
    return 'Bluetooth permission is required. Tap Allow when the browser asks.';
  return 'Couldn’t connect. Make sure the printer is on and in range, then try again.';
}
function _ppsErrBody (e, remembered) {
  const msg = _ppsErrClassify(e);
  const raw = (e && (e.detail || e.message)) || (e && e.original && e.original.message) || String(e || 'Unknown error');
  const retryLabel = remembered ? '↻ Reconnect' : '🔗 Try again';
  const retryId    = remembered ? 'pps-reconnect' : 'pps-connect';
  return '<div style="font-size:12.5px;color:#ff8c00;margin-bottom:10px;line-height:1.5;">' + _ppsEsc(msg) + '</div>' +
    '<div style="display:flex;gap:8px;margin-bottom:8px;">' + _ppsBtn(retryId, retryLabel, 'primary') + _ppsBtn('pps-advanced', 'Advanced', 'ghost') + '</div>' +
    '<div style="font-size:11px;"><a id="pps-details-toggle" style="color:rgba(255,255,255,.45);cursor:pointer;text-decoration:underline;">Details</a>' +
    '<pre id="pps-details" style="display:none;white-space:pre-wrap;word-break:break-word;margin:6px 0 0;font-size:10.5px;color:rgba(255,255,255,.5);background:rgba(255,255,255,.04);padding:7px 9px;border-radius:8px;">' + _ppsEsc(raw) + '</pre></div>';
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
    /* Canonical printer-state machine — attach to PrinterManager transport events, and
       drive the header chip reactively from that one state (re-render on every change). */
    _printerState.wire();
    _printerState.subscribe(() => { try { _updateHeaderWidget(); } catch (_) {} });
    /* Health monitor now only RECONCILES the one state + gathers queue metrics (no competing calc). */
    this.health.start(30000);
    /* Crash recovery: resume any receipts left pending by a previous crash/reload/power loss
       once a printer becomes available. (reconnect/focus handlers also cover this — this makes
       recovery explicit for the "already-connected at startup" case that fires no event.) */
    this._recoverOnStartup();
    /* Zero-config printer auto-connect: reconnect to the previously-paired printer on every
       POS open — no reconfiguration, like earbuds. */
    this._autoConnectPrinter();
  }

  /* Reconnect to the last-paired printer automatically whenever the POS loads, with NO
     configuration step. Uses PrinterManager.autoReconnect() — Bluetooth reconnect via
     navigator.bluetooth.getDevices() needs no user gesture on Chrome 85+ (also network/
     browser). Returns false (no-op) when nothing was ever paired, so it's safe everywhere.
     Retries quietly in the background without blocking selling, and also fires on the first
     user interaction for browsers that gate a GATT connect behind a gesture. */
  _autoConnectPrinter () {
    /* Use the ENGINE (SokoniPrinter) — it has the flat connect/autoReconnect API.
       window.PrinterManager is a thin wrapper without autoReconnect. */
    const pm = window.SokoniPrinter || window.PrinterManager;
    if (!pm || typeof pm.autoReconnect !== 'function') return;

    /* A printer is "remembered" once it has been paired — the engine persists its identity
       in spp_profile.lastDevice. Chrome retains the Bluetooth permission for that device, so
       autoReconnect() → navigator.bluetooth.getDevices() re-links WITHOUT a chooser or a user
       gesture. That is what makes the P58E behave like a paired accessory across navigations:
       every page load silently re-establishes the GATT link the previous document dropped. */
    const remembered = () => {
      try { return !!(JSON.parse(localStorage.getItem('spp_profile') || '{}').lastDevice); }
      catch (_) { return false; }
    };

    let inFlight = false;
    const attempt = () => {
      if (pm.connected || inFlight || !remembered()) return;
      inFlight = true;
      try {
        Promise.resolve(pm.autoReconnect())
          .catch(() => {})
          .finally(() => { inFlight = false; });
      } catch (_) { inFlight = false; }
    };

    attempt();                                             /* immediately on boot */

    /* PERSISTENT heartbeat — never gives up. While disconnected but remembered, quietly retry;
       while connected, this is a cheap no-op. This is the "every few seconds: connected? no →
       silent reconnect" loop, and it also recovers a genuine mid-shift drop with no cashier
       action. Backs off from 6s to 20s so a powered-off printer doesn't churn Bluetooth. */
    let tick = 0;
    const beat = () => {
      tick++;
      if (!pm.connected) attempt();
      const next = tick < 8 ? 6000 : 20000;               /* fast for ~48s, then relaxed */
      this._hbTimer = setTimeout(beat, next);
    };
    this._hbTimer = setTimeout(beat, 6000);

    /* Some browsers gate a GATT connect behind a user gesture / tab focus — piggy-back those. */
    const onWake = () => { if (!pm.connected) attempt(); };
    try {
      window.addEventListener('pointerdown', onWake, { passive: true });
      window.addEventListener('focus', onWake);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) onWake(); });
    } catch (_) {}
  }

  /* Poll briefly on boot: if there are pending jobs and a printer is (or becomes) connected,
     drain them. Bounded — reconnect/focus handlers cover anything after this window. */
  _recoverOnStartup () {
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      if (this.queue.getLength() === 0) { clearInterval(iv); return; }
      if (_pm()?.connected || _eng()?.connected) { clearInterval(iv); this.drainQueue(); }
      else if (tries > 20) { clearInterval(iv); }      /* ~30s; later reconnect/focus still recovers */
    }, 1500);
  }

  /* ── Event system ───────────────────────────────────────────── */
  on   (ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); return this; }
  off  (ev, fn) { if (this._listeners[ev]) this._listeners[ev] = this._listeners[ev].filter(f => f !== fn); }
  _emit (ev, d) { (this._listeners[ev] || []).forEach(fn => { try { fn(d); } catch(_) {} }); }

  /* ── Canonical printer state (Phase 2 — the SINGLE status source) ──
     Every status surface subscribes here; nothing else computes printer state. */
  onState (fn) { return _printerState.subscribe(fn); }   /* returns unsubscribe; fires once with current */
  getState ()  { return _printerState.get(); }
  stateMeta () { return _printerState.meta(); }
  get state () { return _printerState; }

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
    /* Bounded retry backoff for jobs that failed transiently but aren't exhausted. */
    this._scheduleBackoff();
  }

  /* Reschedule a drain for still-pending, not-yet-exhausted jobs on a bounded ramp
     (immediate → 2s → 5s → 10s by attempt), then stop and wait for reconnect/focus —
     never an unbounded retry loop. markFail flips a job to 'failed' at maxAttempts, so
     it drops out of "retryable" and the backoff naturally ends. */
  _scheduleBackoff () {
    if (this._backoffTimer) return;
    const retryable = this.queue.getPending().filter(j => (j.attempts || 0) < (j.maxAttempts || 3));
    if (!retryable.length) return;                    /* nothing retryable → wait for reconnect */
    const minAttempts = Math.min(...retryable.map(j => j.attempts || 0));
    const delay = [0, 2000, 5000, 10000][Math.min(minAttempts, 3)] || 10000;
    this._backoffTimer = setTimeout(() => {
      this._backoffTimer = null;
      if (_pm()?.connected || _eng()?.connected) this.drainQueue();
    }, delay);
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
    /* `force` lets printReceipt() — where the caller has already decided to print —
       bypass the auto-after-sale preference without changing that preference. */
    if (!s.autoAfterSale && !context.force) return { skipped: true };

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

  /* ── PUBLIC: the ONE receipt entry point for the sale flow ─────
     Everything that prints a sale receipt calls this — nothing else may touch a
     transport directly. It gives every receipt a stable Job ID, drives an explicit
     lifecycle (queued → preparing → sending → success | offline-queued, or
     retry → fallback → completed), emits one telemetry event, and keeps the
     pre-consolidation legacy chain as an AUTOMATIC fallback until on-hardware parity
     is proven. It never throws — a failed receipt must never interrupt order completion.
     The Job ID is derived from the receipt number, so a retry can never duplicate a
     sale (printing is already decoupled from settlement, which happened before this). */
  async printReceipt (order = {}, context = {}) {
    const jobId = 'rcpt_' + String(order.receiptNo || order.receiptNumber || order.id || order.transactionId || Date.now());
    const _now  = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const t0    = _now();
    const dur   = () => Math.round(_now() - t0);
    const pm    = _pm();
    const emit  = (state, extra) => {
      try { this._emit('lifecycle', { jobId, state, at: Date.now(), ...(extra || {}) }); } catch (_) {}
      try { _printerState.onPrintLifecycle(state); } catch (_) {}   /* feed the one canonical state */
    };

    emit('queued', { receiptId: order.receiptNo || order.receiptNumber || null });

    /* If neither the enterprise transport service nor the iOS HTML path is present,
       there is no drain path for the offline queue — go straight to the legacy chain. */
    const enterpriseAvailable = !!pm || !!window.SokoniIOSPrint;
    if (!enterpriseAvailable) {
      emit('fallback', { reason: 'no PrinterManager/iOS path' });
      const ok = await this._legacyFallback(order);
      const status = ok ? 'fallback_success' : 'failed';
      emit(status);
      this._telemetry({ jobId, transport: 'legacy', printer: null, durationMs: dur(), retries: 1, status, fallback: true });
      return { jobId, status, fallback: true };
    }

    try {
      emit('preparing');
      emit('sending', { transport: pm ? pm._activeTransport : 'ios/browser' });
      const result = await this.printAfterSale(order, { ...context, force: true, jobId });
      const state  = result && result.skipped ? 'skipped'
                   : result && result.queued  ? 'queued_offline'   /* success of the enterprise path — will drain on reconnect */
                   :                             'success';
      emit(state, { transport: pm ? pm._activeTransport : 'ios/browser' });
      this._telemetry({
        jobId,
        transport: (pm && pm._activeTransport) || (result && result.queued ? 'queue' : 'ios/browser'),
        printer:   (pm && pm.profile && pm.profile.model) || null,
        durationMs: dur(), retries: 0, status: state,
      });
      return { jobId, ...result };
    } catch (err) {
      /* Enterprise path failed hard — fall back to the legacy chain (kept until parity proven). */
      emit('retry', { error: err && err.message });
      const ok = await this._legacyFallback(order);
      const status = ok ? 'fallback_success' : 'failed';
      emit(status);
      this._telemetry({ jobId, transport: 'legacy', printer: null, durationMs: dur(), retries: 1, status, fallback: true });
      return { jobId, status, fallback: true };
    }
  }

  /* The pre-consolidation print chain, preserved verbatim (SokoniPrint → PosPrinter.printBrowser
     → PosPrinter.print) so behaviour on fallback is identical to before this migration. */
  async _legacyFallback (order) {
    try { if (window.SokoniPrint) { await SokoniPrint.print('receipt', order); return true; } } catch (_) {
      try { if (window.PosPrinter) { await PosPrinter.printBrowser(order); return true; } } catch (_) {}
    }
    try { if (window.PosPrinter && !window.SokoniPrint) { await PosPrinter.print(order); return true; } } catch (_) {}
    return false;
  }

  /* One lightweight telemetry event per print — Transport / Printer / Duration / Retries / Status.
     Rides the existing emitter (+ optional analytics + a console breadcrumb); durable storage
     stays in history/metrics so this adds no new persistence. */
  _telemetry (evt) {
    try { this._emit('telemetry', evt); } catch (_) {}
    try { if (window.SokoniAnalytics && typeof SokoniAnalytics.track === 'function') SokoniAnalytics.track('pos_receipt_print', evt); } catch (_) {}
    try { console.info('[PosPrintService] receipt', evt.status, '·', evt.transport, '·', evt.durationMs + 'ms', '· retries', evt.retries); } catch (_) {}
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

  /* Concise, human health line for a status widget / support view, e.g.
     "Connected · Queue: 1 pending · Last print: 2m ago · Success 99.6%". */
  getHealthSummary () {
    const st = _printerState.meta();
    const qn = this.queue.getLength();
    const lp = this.health && this.health._lastPrint;
    let lastStr = '—';
    if (lp && lp.at) {
      const s = Math.max(0, Math.round((Date.now() - new Date(lp.at).getTime()) / 1000));
      lastStr = s < 60 ? s + 's ago' : s < 3600 ? Math.round(s/60) + 'm ago'
              : s < 86400 ? Math.round(s/3600) + 'h ago' : Math.round(s/86400) + 'd ago';
    }
    const m = (this.metrics && this.metrics.summary) ? this.metrics.summary() : {};
    let rate = null;
    const total = Number(m.total || m.count || 0), ok = Number(m.success || m.printed || m.ok || 0);
    if (total > 0) rate = (Math.round((ok / total) * 1000) / 10) + '%';
    return {
      state: st.state, label: st.text, printer: st.name || null,
      queuePending: qn, lastPrint: lastStr, successRate: rate,
      text: (st.name || st.text) + ' · Queue: ' + qn + ' pending · Last print: ' + lastStr
            + (rate ? ' · Success ' + rate : ''),
    };
  }

  /* Structured queue snapshot for a diagnostics panel: [{status, receipt, time, attempts, lastError}]. */
  getQueueDiagnostics () {
    return this.queue.getAll().slice(-25).reverse().map(j => ({
      jobId:     j.jobId,
      receipt:   j.receiptId || j.receiptNumber || '—',
      status:    j.status,                                  /* pending | done | failed */
      attempts:  j.attempts || 0,
      maxAttempts: j.maxAttempts || 3,
      queuedAt:  j.queuedAt,
      lastError: j.lastError || null,
    }));
  }

  /* Lightweight queue diagnostics PANEL — a bottom sheet showing the health summary +
     a Status/Job/Time table (printed / waiting / retrying / failed). Self-contained
     (builds its own DOM + inline styles); callable from anywhere, e.g. the printer chip. */
  showQueueDiagnostics () {
    const self = this, ID = 'pps-diag-modal';
    const ex = document.getElementById(ID); if (ex) ex.remove();
    const ov = document.createElement('div'); ov.id = ID;
    ov.style.cssText = 'position:fixed;inset:0;z-index:100050;background:rgba(0,0,0,0.72);display:flex;align-items:flex-end;justify-content:center;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);';
    ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
    const sheet = document.createElement('div');
    sheet.style.cssText = 'width:100%;max-width:560px;max-height:82vh;overflow:auto;background:#0c0c0c;border:1px solid rgba(255,255,255,0.1);border-radius:18px 18px 0 0;padding:16px 16px calc(20px + env(safe-area-inset-bottom,0px));';
    const fmtTime = iso => { try { return new Date(iso).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' }); } catch (_) { return '—'; } };
    const pill = j => {
      if (j.status === 'done')   return '<span style="color:#22c55e;font-weight:800;white-space:nowrap;">&#x2705; Printed</span>';
      if (j.status === 'failed') return '<span style="color:#ff5050;font-weight:800;white-space:nowrap;">&#x274C; Failed</span>';
      if ((j.attempts || 0) > 0) return '<span style="color:#ff9800;font-weight:800;white-space:nowrap;">&#x21BB; Retrying</span>';
      return '<span style="color:#ffb020;font-weight:800;white-space:nowrap;">&#x23F3; Waiting</span>';
    };
    function render () {
      const h = self.getHealthSummary(), jobs = self.getQueueDiagnostics();
      const rows = jobs.length ? jobs.map(j =>
        '<tr style="border-top:1px solid rgba(255,255,255,0.06);">' +
          '<td style="padding:8px 6px;">' + pill(j) + (j.attempts > 0 ? ' <span style="color:rgba(255,255,255,0.3);font-size:10px;">(' + j.attempts + '/' + j.maxAttempts + ')</span>' : '') + '</td>' +
          '<td style="padding:8px 6px;color:rgba(255,255,255,0.85);">Receipt ' + _esc(String(j.receipt)) + (j.lastError ? '<div style="color:#ff6b6b;font-size:10px;">' + _esc(String(j.lastError).slice(0, 60)) + '</div>' : '') + '</td>' +
          '<td style="padding:8px 6px;color:rgba(255,255,255,0.4);white-space:nowrap;">' + fmtTime(j.queuedAt) + '</td></tr>'
      ).join('') : '<tr><td colspan="3" style="padding:26px;text-align:center;color:rgba(255,255,255,0.3);">No print jobs yet</td></tr>';
      sheet.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
          '<div style="font-size:15px;font-weight:900;color:#fff;">&#x1F5A8;&#xFE0F; Printer Queue</div>' +
          '<button id="pps-diag-x" aria-label="Close" style="background:rgba(255,255,255,0.08);border:none;color:#fff;width:32px;height:32px;border-radius:9px;font-size:15px;cursor:pointer;">&#x2715;</button></div>' +
        '<div style="font-size:12px;color:rgba(255,255,255,0.65);background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:10px 12px;margin-bottom:12px;">' + _esc(h.text) + '</div>' +
        '<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="color:rgba(255,255,255,0.4);font-size:10px;text-transform:uppercase;letter-spacing:0.05em;">' +
          '<th style="text-align:left;padding:0 6px 6px;">Status</th><th style="text-align:left;padding:0 6px 6px;">Job</th><th style="text-align:left;padding:0 6px 6px;">Time</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        '<div style="display:flex;gap:8px;margin-top:14px;">' +
          '<button id="pps-diag-refresh" style="flex:1;padding:11px;border-radius:11px;background:rgba(113,255,0,0.1);border:1px solid rgba(113,255,0,0.3);color:#71ff00;font-weight:800;cursor:pointer;font-family:inherit;">&#x21BB; Refresh</button>' +
          '<button id="pps-diag-setup" style="flex:1;padding:11px;border-radius:11px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);color:rgba(255,255,255,0.8);font-weight:800;cursor:pointer;font-family:inherit;">&#x2699;&#xFE0F; Printer Setup</button></div>';
      sheet.querySelector('#pps-diag-x').onclick = () => ov.remove();
      sheet.querySelector('#pps-diag-refresh').onclick = render;
      sheet.querySelector('#pps-diag-setup').onclick = () => { try { (window.openPrinterSetup?window.openPrinterSetup():location.href='pos-printer-setup.html'); } catch (_) {} };
    }
    render();
    ov.appendChild(sheet);
    document.body.appendChild(ov);
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
