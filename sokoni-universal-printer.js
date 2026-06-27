/* ════════════════════════════════════════════════════════════════════
   SOKONI Universal Printer Engine v3.0
   Vendor-neutral, standards-based receipt printing for SmartPOS

   Transports: Bluetooth (Web Bluetooth) · USB (WebUSB) · Serial
               (Web Serial) · Network (HTTP/WS) · Browser (fallback)
   Protocol  : ESC/POS industry standard
   Documents : Sales · Refund · Exchange · Kitchen · Packing ·
               Delivery · Labels · Queue · Summary · Custom

   Public API: window.SokoniPrinter.{discover, connect, print, …}
   ════════════════════════════════════════════════════════════════════ */
'use strict';
(function (root) {

/* ─────────────────────────────────────────────────────────────────
   ESC/POS CONSTANTS
───────────────────────────────────────────────────────────────── */
const ESC = 0x1B, GS = 0x1D, LF = 0x0A;

const CMD = {
  INIT:          [ESC,0x40],
  LF:            [LF],
  CUT_FULL:      [GS,0x56,0x00],
  CUT_PARTIAL:   [GS,0x56,0x01],
  ALIGN_L:       [ESC,0x61,0x00],
  ALIGN_C:       [ESC,0x61,0x01],
  ALIGN_R:       [ESC,0x61,0x02],
  BOLD_ON:       [ESC,0x45,0x01],
  BOLD_OFF:      [ESC,0x45,0x00],
  UL_ON:         [ESC,0x2D,0x01],
  UL_OFF:        [ESC,0x2D,0x00],
  SIZE_NORMAL:   [ESC,0x21,0x00],
  SIZE_TALL:     [ESC,0x21,0x10],
  SIZE_WIDE:     [ESC,0x21,0x20],
  SIZE_BIG:      [ESC,0x21,0x30],
  INVERT_ON:     [GS,0x42,0x01],
  INVERT_OFF:    [GS,0x42,0x00],
  FONT_A:        [ESC,0x4D,0x00],
  FONT_B:        [ESC,0x4D,0x01],
  DRAWER:        [ESC,0x70,0x00,0x19,0x78],
};

const PAPER = {
  '58mm': { chars: 32, px: 384 },
  '80mm': { chars: 48, px: 576 },
  '76mm': { chars: 42, px: 512 },
};

/* ─────────────────────────────────────────────────────────────────
   ESC/POS ENCODER
───────────────────────────────────────────────────────────────── */
class ESCPOSEncoder {
  constructor () { this._b = []; }

  _a (d) {
    if (Array.isArray(d)) this._b.push(...d);
    else if (d instanceof Uint8Array) this._b.push(...d);
    else this._b.push(d & 0xFF);
    return this;
  }

  init ()           { return this._a(CMD.INIT); }
  lf  (n = 1)      { for (let i = 0; i < n; i++) this._a(CMD.LF); return this; }
  cut (full = true) { return this._a(full ? CMD.CUT_FULL : CMD.CUT_PARTIAL); }
  al  ()            { return this._a(CMD.ALIGN_L); }
  ac  ()            { return this._a(CMD.ALIGN_C); }
  ar  ()            { return this._a(CMD.ALIGN_R); }
  bold (on = true)  { return this._a(on ? CMD.BOLD_ON  : CMD.BOLD_OFF); }
  ul   (on = true)  { return this._a(on ? CMD.UL_ON    : CMD.UL_OFF); }
  inv  (on = true)  { return this._a(on ? CMD.INVERT_ON: CMD.INVERT_OFF); }
  sz (s) {
    const m = { normal: CMD.SIZE_NORMAL, tall: CMD.SIZE_TALL, wide: CMD.SIZE_WIDE, big: CMD.SIZE_BIG };
    return this._a(m[s] || CMD.SIZE_NORMAL);
  }
  drawer () { return this._a(CMD.DRAWER); }

  text (str) {
    const b = [];
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      b.push(c < 256 ? c : 0x3F);  // '?' for chars outside latin-1
    }
    return this._a(b);
  }

  line (str, align = 'left') {
    const ac = { left: CMD.ALIGN_L, center: CMD.ALIGN_C, right: CMD.ALIGN_R }[align] || CMD.ALIGN_L;
    return this._a(ac).text(str).lf();
  }

  // Two-column row padded to `w` chars
  row (left, right, w = 48) {
    const r = String(right);
    const l = String(left).slice(0, w - r.length - 1).padEnd(w - r.length - 1);
    return this.text(l + ' ' + r).lf();
  }

  sep (ch = '-', w = 48) { return this.text(ch.repeat(w)).lf(); }

  qr (data, size = 5) {
    const n = data.length + 3, pL = n & 0xFF, pH = (n >> 8) & 0xFF;
    this._a([GS,0x28,0x6B,0x04,0x00,0x31,0x41,0x32,0x00]);  // model
    this._a([GS,0x28,0x6B,0x03,0x00,0x31,0x43,size]);         // size
    this._a([GS,0x28,0x6B,0x03,0x00,0x31,0x45,0x31]);         // ECC level M
    this._a([GS,0x28,0x6B,pL,pH,0x31,0x50,0x30]);             // store
    for (let i = 0; i < data.length; i++) this._a(data.charCodeAt(i) & 0xFF);
    this._a([GS,0x28,0x6B,0x03,0x00,0x31,0x51,0x30]);         // print
    return this;
  }

  barcode (data, type = 73, height = 80, width = 2) {
    this._a([GS,0x68,height, GS,0x77,width, GS,0x6B,type, data.length]);
    for (let i = 0; i < data.length; i++) this._a(data.charCodeAt(i) & 0xFF);
    return this;
  }

  build () { return new Uint8Array(this._b); }
  reset () { this._b = []; return this; }
}

/* ─────────────────────────────────────────────────────────────────
   RECEIPT RENDERER  (adapts to 58mm / 80mm / future widths)
───────────────────────────────────────────────────────────────── */
class ReceiptRenderer {
  constructor (paperWidth = '80mm', cfg = {}) {
    this._p = PAPER[paperWidth] || PAPER['80mm'];
    this._cfg = cfg;
  }
  get W () { return this._p.chars; }
  _sep (ch = '-') { return ch.repeat(this.W); }
  _mid (s) {
    const w = this.W, l = s.length;
    return s.slice(0, w).padStart(Math.ceil((w + l) / 2)).padEnd(w);
  }
  _cols (l, r) {
    const rs = String(r), w = this.W;
    return String(l).slice(0, w - rs.length - 1).padEnd(w - rs.length - 1) + ' ' + rs;
  }
  _kes (n) { return 'KES ' + Number(n || 0).toLocaleString(); }

  /* ── Sales receipt ─────────────────────────────────────────── */
  sale (d) {
    const e = new ESCPOSEncoder().init();
    const W = this.W, c = this._cfg;

    // Header
    e.ac();
    if (c.logoText) e.bold(true).sz('big').text(c.logoText || d.businessName || 'SOKONI').lf().sz('normal').bold(false);
    if (d.businessName) e.bold(true).text(d.businessName).lf().bold(false);
    if (d.businessAddress) e.text(d.businessAddress).lf();
    if (d.businessPhone)   e.text('Tel: ' + d.businessPhone).lf();
    if (d.businessPin)     e.text('PIN: ' + d.businessPin).lf();
    if (d.vatNumber)       e.text('VAT: ' + d.vatNumber).lf();

    e.al().text(this._sep()).lf();

    const now = new Date();
    e.text(this._cols('Date:', d.date || now.toLocaleDateString('en-KE'))).lf();
    e.text(this._cols('Time:', d.time || now.toLocaleTimeString('en-KE'))).lf();
    if (d.receiptNumber) e.text(this._cols('Receipt #:', d.receiptNumber)).lf();
    if (d.invoiceNumber) e.text(this._cols('Invoice #:', d.invoiceNumber)).lf();
    if (d.orderNumber)   e.text(this._cols('Order #:',   d.orderNumber)).lf();
    if (d.cashierName)   e.text(this._cols('Cashier:',   d.cashierName)).lf();
    if (d.customerName) {
      e.text(this._sep()).lf();
      e.text('Customer: ' + d.customerName).lf();
      if (d.customerPhone) e.text('Phone: ' + d.customerPhone).lf();
    }

    e.text(this._sep()).lf();

    // Items header
    const qW = 4, pW = 10, nW = W - qW - pW - 2;
    e.bold(true).text('Item'.padEnd(nW) + ' Qty'.padStart(qW) + 'Amount'.padStart(pW)).lf().bold(false);
    e.text(this._sep()).lf();

    for (const it of (d.items || [])) {
      const name   = String(it.name || 'Item').slice(0, nW).padEnd(nW);
      const qty    = String(it.quantity || 1).padStart(qW);
      const amount = this._kes((it.unitPrice || 0) * (it.quantity || 1)).padStart(pW);
      e.text(name + qty + amount).lf();
      if (it.variant)  e.text('  + ' + it.variant).lf();
      if (it.notes)    e.text('  * ' + it.notes).lf();
      if (it.discount) e.text(('  Disc: -' + this._kes(it.discount)).padEnd(W)).lf();
    }

    e.text(this._sep()).lf();

    // Totals
    const t = d.totals || {};
    if (t.subtotal  != null)  e.text(this._cols('Subtotal:',     this._kes(t.subtotal))).lf();
    if (t.discount)           e.text(this._cols('Discount:',    '-' + this._kes(t.discount))).lf();
    if (t.coupon)             e.text(this._cols('Coupon:',      '-' + this._kes(t.coupon))).lf();
    if (t.vat)                e.text(this._cols('VAT (16%):',    this._kes(t.vat))).lf();
    if (t.serviceCharge)      e.text(this._cols('Service Charge:', this._kes(t.serviceCharge))).lf();
    if (t.deliveryFee)        e.text(this._cols('Delivery:',     this._kes(t.deliveryFee))).lf();
    if (t.commission)         e.text(this._cols('Platform Fee:', this._kes(t.commission))).lf();

    e.text(this._sep()).lf();
    e.bold(true).sz('tall').text(this._cols('TOTAL:', this._kes(t.grandTotal))).lf().sz('normal').bold(false);
    e.text(this._sep()).lf();

    // Payment
    const pay = d.payment || {};
    if (pay.method) e.text(this._cols('Payment:', pay.method)).lf();
    if (pay.amountTendered) e.text(this._cols('Tendered:', this._kes(pay.amountTendered))).lf();
    if (pay.change != null) e.text(this._cols('Change:',   this._kes(pay.change))).lf();
    if (pay.mpesaCode)      e.text('M-PESA: ' + pay.mpesaCode).lf();
    if (pay.authCode)       e.text('Auth: ' + pay.authCode).lf();

    // QR & barcode
    if (d.receiptUrl || d.digitalRef) {
      e.lf().ac().text('Scan for digital receipt').lf();
      e.qr(d.receiptUrl || d.digitalRef, 4);
    }
    if (d.barcode) e.ac().barcode(d.barcode);

    // Footer
    e.lf().ac();
    if (c.footer)           e.text(c.footer).lf();
    if (d.returnPolicy)     e.text(d.returnPolicy).lf();
    if (d.warrantyInfo)     e.text(d.warrantyInfo).lf();
    if (d.promoMessage)     e.bold(true).text(d.promoMessage).lf().bold(false);
    if (d.digitalRef)       e.text('Ref: ' + d.digitalRef).lf();

    e.lf(3).cut();
    return e.build();
  }

  /* ── Refund receipt ────────────────────────────────────────── */
  refund (d) {
    const e = new ESCPOSEncoder().init();
    e.ac().bold(true).sz('big').text('** REFUND **').lf().sz('normal').bold(false);
    const rest = this.sale({ ...d, receiptUrl: null });
    // Prepend refund marker to sales receipt bytes
    const marker = e.build();
    const combined = new Uint8Array(marker.length + rest.length);
    combined.set(marker); combined.set(rest, marker.length);
    return combined;
  }

  /* ── Kitchen ticket ────────────────────────────────────────── */
  kitchen (d) {
    const e = new ESCPOSEncoder().init();
    e.ac().bold(true).sz('big').text('*** KITCHEN ***').lf().sz('normal').lf();
    e.text(this._cols('Order #:', d.orderNumber || '?')).lf();
    e.text(this._cols('Table:',   d.table || 'Takeaway')).lf();
    e.text(this._cols('Time:',    new Date().toLocaleTimeString('en-KE'))).lf();
    e.bold(false).text(this._sep()).lf();
    for (const it of (d.items || [])) {
      e.bold(true).sz('tall').text(String(it.quantity || 1) + 'x ' + (it.name || 'Item')).lf().sz('normal').bold(false);
      if (it.variant) e.text('   - ' + it.variant).lf();
      if (it.notes)   e.text('   ** ' + it.notes).lf();
    }
    if (d.notes) { e.text(this._sep()).lf().bold(true).text('NOTE: ' + d.notes).lf().bold(false); }
    e.lf(4).cut();
    return e.build();
  }

  /* ── Delivery / packing slip ───────────────────────────────── */
  delivery (d) {
    const e = new ESCPOSEncoder().init();
    e.ac().bold(true).text('DELIVERY SLIP').lf().bold(false);
    e.al().text(this._sep()).lf();
    e.text(this._cols('Order:',  d.orderNumber || '?')).lf();
    e.text(this._cols('Date:',   d.date || new Date().toLocaleDateString('en-KE'))).lf();
    if (d.driverName) e.text(this._cols('Driver:', d.driverName)).lf();
    e.text(this._sep()).lf();
    e.bold(true).text('DELIVER TO:').lf().bold(false);
    if (d.customerName)    e.text(d.customerName).lf();
    if (d.deliveryAddress) e.text(d.deliveryAddress).lf();
    if (d.customerPhone)   e.text('Tel: ' + d.customerPhone).lf();
    e.text(this._sep()).lf();
    e.bold(true).text('ITEMS:').lf().bold(false);
    for (const it of (d.items || [])) e.text((it.quantity || 1) + 'x  ' + (it.name || 'Item')).lf();
    e.text(this._sep()).lf();
    if (d.notes) e.text('Notes: ' + d.notes).lf();
    if (d.qr || d.receiptUrl) e.ac().lf().qr(d.qr || d.receiptUrl, 4);
    e.lf(3).cut();
    return e.build();
  }

  /* ── Label (product / barcode / QR) ───────────────────────── */
  label (d) {
    const e = new ESCPOSEncoder().init().ac();
    if (d.productName) e.bold(true).text(d.productName).lf().bold(false);
    if (d.price != null) e.sz('tall').text(this._kes(d.price)).lf().sz('normal');
    if (d.sku)  e.text('SKU: ' + d.sku).lf();
    if (d.lot)  e.text('LOT: ' + d.lot).lf();
    if (d.barcode) e.barcode(d.barcode, 73, 60, 2);
    if (d.qr)  e.qr(d.qr, 3);
    e.lf(2).cut();
    return e.build();
  }

  /* ── Queue / appointment ticket ────────────────────────────── */
  queueTicket (d) {
    const e = new ESCPOSEncoder().init().ac();
    if (d.businessName) e.text(d.businessName).lf();
    e.lf().sz('big').bold(true).text(d.ticketNumber || '001').lf().sz('normal').bold(false);
    if (d.service)   e.text(d.service).lf();
    if (d.estimatedWait) e.text('Est. wait: ' + d.estimatedWait).lf();
    if (d.time)      e.text(d.time).lf();
    if (d.date)      e.text(d.date).lf();
    if (d.qr)        e.lf().qr(d.qr, 4);
    e.lf(3).cut();
    return e.build();
  }

  /* ── Booking / appointment confirmation ────────────────────── */
  booking (d) {
    const e = new ESCPOSEncoder().init();
    e.ac().bold(true).text('BOOKING CONFIRMATION').lf().bold(false);
    e.al().text(this._sep()).lf();
    if (d.bookingRef)  e.text(this._cols('Ref:',     d.bookingRef)).lf();
    if (d.service)     e.text(this._cols('Service:', d.service)).lf();
    if (d.provider)    e.text(this._cols('With:',    d.provider)).lf();
    if (d.date)        e.text(this._cols('Date:',    d.date)).lf();
    if (d.time)        e.text(this._cols('Time:',    d.time)).lf();
    if (d.location)    e.text(this._cols('Location:', d.location)).lf();
    e.text(this._sep()).lf();
    if (d.customerName)  e.text('Name: ' + d.customerName).lf();
    if (d.customerPhone) e.text('Phone: ' + d.customerPhone).lf();
    if (d.notes) e.lf().text('Notes: ' + d.notes).lf();
    if (d.qr) e.ac().lf().qr(d.qr, 4);
    e.lf(3).cut();
    return e.build();
  }

  /* ── Daily cash / sales summary ───────────────────────────── */
  dailySummary (d) {
    const e = new ESCPOSEncoder().init();
    e.ac().bold(true).text('DAILY SALES SUMMARY').lf().bold(false);
    e.text(d.date || new Date().toLocaleDateString('en-KE')).lf();
    if (d.businessName) e.text(d.businessName).lf();
    if (d.cashierName)  e.text('Cashier: ' + d.cashierName).lf();
    e.al().text(this._sep()).lf();
    e.text(this._cols('Total Sales:',    this._kes(d.totalSales))).lf();
    e.text(this._cols('Transactions:',   String(d.transactionCount || 0))).lf();
    e.text(this._cols('Refunds:',       this._kes(d.totalRefunds))).lf();
    e.text(this._cols('Net Revenue:',   this._kes(d.netRevenue))).lf();
    e.text(this._sep()).lf();
    if (d.paymentBreakdown) {
      for (const [m, v] of Object.entries(d.paymentBreakdown))
        e.text(this._cols(m + ':', this._kes(v))).lf();
      e.text(this._sep()).lf();
    }
    e.text(this._cols('Opening Float:',  this._kes(d.openingFloat))).lf();
    e.text(this._cols('Expected Cash:',  this._kes(d.expectedCash))).lf();
    e.text(this._cols('Actual Cash:',    this._kes(d.actualCash))).lf();
    const variance = (d.actualCash || 0) - (d.expectedCash || 0);
    e.bold(variance !== 0).text(this._cols('Variance:', this._kes(variance))).lf().bold(false);
    e.lf(3).cut();
    return e.build();
  }

  /* ── Generic dispatcher ────────────────────────────────────── */
  render (docType, data) {
    const map = {
      sale: this.sale, receipt: this.sale, sales_receipt: this.sale,
      refund: this.refund, refund_receipt: this.refund,
      exchange: this.refund,
      kitchen: this.kitchen, kitchen_ticket: this.kitchen,
      delivery: this.delivery, packing_slip: this.delivery,
      delivery_slip: this.delivery, shipping_label: this.delivery,
      label: this.label, inventory_label: this.label,
      barcode_label: this.label, qr_label: this.label,
      queue_ticket: this.queueTicket, parking_ticket: this.queueTicket,
      booking: this.booking, appointment: this.booking,
      service_confirmation: this.booking, booking_confirmation: this.booking,
      daily_summary: this.dailySummary, cash_report: this.dailySummary,
      monthly_summary: this.dailySummary,
    };
    const fn = map[docType];
    if (!fn) return this.sale(data);
    return fn.call(this, data);
  }

  /* ── HTML preview (browser fallback + on-screen) ──────────── */
  previewHTML (docType, data) {
    const raw  = this.render(docType, data);
    let txt = '';
    let i = 0;
    // Strip ESC/POS control sequences, keep printable chars + LF
    while (i < raw.length) {
      const b = raw[i];
      if (b === 0x1B || b === 0x1D || b === 0x1C) { i += 2; while (i < raw.length && (raw[i] > 127 || raw[i] < 0x20)) i++; continue; }
      if (b === 0x0A) { txt += '\n'; }
      else if (b >= 0x20 && b < 0x7F) txt += String.fromCharCode(b);
      i++;
    }
    const w = this._p.chars * 7.5;
    return `<div style="width:${w}px;font-family:'Courier New',monospace;font-size:12px;line-height:1.5;white-space:pre;padding:12px 10px;border:1px solid #ddd;background:#fff;color:#111">${txt.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>`;
  }
}

/* ─────────────────────────────────────────────────────────────────
   PRINT QUEUE  (persistent via localStorage)
───────────────────────────────────────────────────────────────── */
class PrintQueue {
  constructor () {
    this._q = []; this._hist = []; this._paused = false;
    this._ev = {};
    this._load();
  }
  _load () {
    try { this._q = JSON.parse(localStorage.getItem('spp_queue') || '[]').filter(j => j.status === 'pending' || j.status === 'failed'); } catch(e) {}
    try { this._hist = JSON.parse(localStorage.getItem('spp_history') || '[]'); } catch(e) {}
  }
  _save () {
    try { localStorage.setItem('spp_queue',   JSON.stringify(this._q)); } catch(e) {}
    try { localStorage.setItem('spp_history', JSON.stringify(this._hist.slice(0, 200))); } catch(e) {}
  }
  emit (ev, d) { (this._ev[ev] || []).forEach(fn => { try { fn(d); } catch(e) {} }); }
  on  (ev, fn) { (this._ev[ev] = this._ev[ev] || []).push(fn); }
  off (ev, fn) { this._ev[ev] = (this._ev[ev] || []).filter(f => f !== fn); }

  enqueue (docType, data, opts = {}) {
    const job = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      docType, data,
      copies:      opts.copies || 1,
      priority:    opts.priority || 0,
      maxAttempts: opts.maxAttempts || 3,
      status:      'pending', attempts: 0, error: null,
      createdAt:   new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    this._q.push(job); this._save();
    this.emit('enqueued', job);
    return job.id;
  }

  next ()   { return this._paused ? null : this._q.find(j => j.status === 'pending') || null; }
  pause ()  { this._paused = true;  this.emit('paused', null); }
  resume () { this._paused = false; this.emit('resumed', null); this.emit('tick', null); }

  _upd (job) { job.updatedAt = new Date().toISOString(); this._save(); }
  markProcessing (job) { job.status = 'processing'; this._upd(job); }
  markDone (job) {
    job.status = 'done'; this._upd(job);
    this._q = this._q.filter(j => j.id !== job.id);
    this._hist.unshift(job); this._save();
    this.emit('done', job);
  }
  markFailed (job, err) {
    job.error = err;
    if (job.attempts >= job.maxAttempts) {
      job.status = 'failed';
      this._q = this._q.filter(j => j.id !== job.id);
      this._hist.unshift(job);
    } else {
      job.status = 'pending';
    }
    this._upd(job); this.emit('failed', { job, err });
  }

  cancel (id) {
    const j = this._q.find(j => j.id === id);
    if (!j) return;
    j.status = 'cancelled';
    this._q = this._q.filter(j => j.id !== id);
    this._hist.unshift(j); this._save(); this.emit('cancelled', j);
  }
  retry (id) {
    const j = [...this._q, ...this._hist].find(j => j.id === id);
    if (!j) return;
    j.status = 'pending'; j.attempts = 0; j.error = null;
    if (!this._q.find(j => j.id === id)) this._q.unshift(j);
    this._save(); this.emit('tick', null);
  }
  jobs    () { return [...this._q]; }
  history () { return [...this._hist]; }
}

/* ─────────────────────────────────────────────────────────────────
   TRANSPORT ADAPTERS
───────────────────────────────────────────────────────────────── */

class BtAdapter {
  constructor () { this.ok = false; this._char = null; this._dev = null; }
  get type () { return 'bluetooth'; }
  get avail () { return !!navigator.bluetooth; }
  async discover () {
    if (!this.avail) return [];
    const filters = [
      { services: ['000018f0-0000-1000-8000-00805f9b34fb'] },
      { services: ['e7810a71-73ae-499d-8c15-faa9aef0c3f2'] },
      { namePrefix: 'MTP' },{ namePrefix: 'Rongta' },{ namePrefix: 'Xprinter' },
      { namePrefix: 'EPSON' },{ namePrefix: 'Star' },{ namePrefix: 'POS' },
      { namePrefix: 'BP-' },{ namePrefix: 'RPP' },{ namePrefix: 'BTPT' },
    ];
    try {
      const d = await navigator.bluetooth.requestDevice({
        filters,
        optionalServices: ['000018f0-0000-1000-8000-00805f9b34fb','e7810a71-73ae-499d-8c15-faa9aef0c3f2'],
      });
      return [{ id: d.id, name: d.name || 'Bluetooth Printer', type: 'bluetooth', _dev: d }];
    } catch(e) { return e.name === 'NotFoundError' ? [] : []; }
  }
  async connect (info) {
    const d = info._dev;
    const srv = await d.gatt.connect();
    const serviceUUIDs = ['000018f0-0000-1000-8000-00805f9b34fb','e7810a71-73ae-499d-8c15-faa9aef0c3f2'];
    let svc = null;
    for (const u of serviceUUIDs) { try { svc = await srv.getPrimaryService(u); break; } catch(e) {} }
    if (!svc) throw new Error('No print service on this Bluetooth device');
    const charUUIDs = ['00002af1-0000-1000-8000-00805f9b34fb','bef8d6c9-9c21-4c9e-b632-bd58c1009f9f'];
    for (const u of charUUIDs) { try { this._char = await svc.getCharacteristic(u); break; } catch(e) {} }
    if (!this._char) throw new Error('No write characteristic found');
    this.ok = true; this._info = info;
    d.addEventListener('gattserverdisconnected', () => { this.ok = false; });
  }
  async disconnect () { this._info?._dev?.gatt?.connected && this._info._dev.gatt.disconnect(); this.ok = false; }
  async write (data) {
    if (!this.ok || !this._char) throw new Error('BT printer not connected');
    const CHUNK = 512;
    for (let i = 0; i < data.length; i += CHUNK) {
      await this._char.writeValueWithoutResponse(data.slice(i, i + CHUNK));
      await new Promise(r => setTimeout(r, 20));
    }
  }
}

class UsbAdapter {
  constructor () { this.ok = false; this._ep = null; this._iface = null; this._dev = null; }
  get type () { return 'usb'; }
  get avail () { return !!navigator.usb; }
  async discover () {
    if (!this.avail) return [];
    try {
      const d = await navigator.usb.requestDevice({ filters: [] });
      return [{ id: d.serialNumber || 'usb-0', name: d.productName || 'USB Printer', type: 'usb', _dev: d }];
    } catch(e) { return []; }
  }
  async connect (info) {
    const d = info._dev;
    await d.open();
    if (d.configuration === null) await d.selectConfiguration(1);
    let iface = null, ep = null;
    outer: for (const cfg of d.configurations)
      for (const intf of cfg.interfaces)
        for (const alt of intf.alternates)
          if (alt.interfaceClass === 7) {
            ep = alt.endpoints.find(e => e.direction === 'out');
            if (ep) { iface = intf; break outer; }
          }
    if (!ep) throw new Error('No printer interface on USB device (class 7)');
    await d.claimInterface(iface.interfaceNumber);
    this._iface = iface; this._ep = ep; this._dev = d; this.ok = true;
  }
  async disconnect () {
    await this._iface && this._dev?.releaseInterface(this._iface.interfaceNumber).catch(()=>{});
    await this._dev?.close().catch(()=>{});
    this.ok = false;
  }
  async write (data) {
    if (!this.ok) throw new Error('USB printer not connected');
    const CHUNK = 16384;
    for (let i = 0; i < data.length; i += CHUNK)
      await this._dev.transferOut(this._ep.endpointNumber, data.slice(i, i + CHUNK));
  }
}

class SerialAdapter {
  constructor () { this.ok = false; this._writer = null; this._port = null; }
  get type () { return 'serial'; }
  get avail () { return !!navigator.serial; }
  async discover () {
    if (!this.avail) return [];
    try {
      const p = await navigator.serial.requestPort({ filters: [] });
      const info = await p.getInfo();
      return [{ id: String(info.usbVendorId || 'serial'), name: 'Serial / COM Printer', type: 'serial', _port: p }];
    } catch(e) { return []; }
  }
  async connect (info) {
    const p = info._port;
    await p.open({ baudRate: 9600 });
    this._port = p; this._writer = p.writable.getWriter(); this.ok = true;
  }
  async disconnect () {
    await this._writer?.releaseLock(); await this._port?.close().catch(()=>{});
    this.ok = false;
  }
  async write (data) {
    if (!this.ok || !this._writer) throw new Error('Serial printer not connected');
    await this._writer.write(data);
  }
}

class NetworkAdapter {
  constructor () { this.ok = false; this._ep = null; this._proto = null; this._ws = null; }
  get type () { return 'network'; }
  get avail () { return true; }
  async discover () {
    const saved = JSON.parse(localStorage.getItem('spp_net_printers') || '[]');
    return saved.map(p => ({ ...p, type: 'network' }));
  }
  static save (name, endpoint) {
    const list = JSON.parse(localStorage.getItem('spp_net_printers') || '[]');
    const idx  = list.findIndex(p => p.endpoint === endpoint);
    const e    = { id: 'net-' + btoa(endpoint).slice(0, 10), name, endpoint, type: 'network' };
    if (idx >= 0) list[idx] = e; else list.push(e);
    localStorage.setItem('spp_net_printers', JSON.stringify(list));
  }
  static remove (endpoint) {
    const list = JSON.parse(localStorage.getItem('spp_net_printers') || '[]').filter(p => p.endpoint !== endpoint);
    localStorage.setItem('spp_net_printers', JSON.stringify(list));
  }
  async connect (info) {
    const ep = info.endpoint;
    this._ep = ep; this._proto = ep.startsWith('ws') ? 'ws' : 'http';
    if (this._proto === 'ws') {
      await new Promise((res, rej) => {
        this._ws = new WebSocket(ep);
        this._ws.binaryType = 'arraybuffer';
        this._ws.onopen  = () => { this.ok = true; res(); };
        this._ws.onerror = () => rej(new Error('WS connection failed: ' + ep));
        this._ws.onclose = () => { this.ok = false; };
        setTimeout(() => rej(new Error('Connection timeout')), 5000);
      });
    } else {
      try {
        const r = await fetch(ep + '/status', { method: 'GET', signal: AbortSignal.timeout(4000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        this.ok = true;
      } catch(e) { throw new Error('Cannot reach printer at ' + ep + ': ' + e.message); }
    }
    this._info = info;
  }
  async disconnect () { this._ws?.close(); this.ok = false; }
  async write (data) {
    if (!this.ok) throw new Error('Network printer not connected');
    if (this._proto === 'ws') {
      this._ws.send(data.buffer);
    } else {
      const r = await fetch(this._ep + '/print', { method: 'POST', body: data, headers: { 'Content-Type': 'application/octet-stream' } });
      if (!r.ok) throw new Error('HTTP print failed: ' + r.status);
    }
  }
}

class BrowserAdapter {
  constructor () { this.ok = true; }
  get type () { return 'browser'; }
  get avail () { return true; }
  async discover () { return [{ id: 'browser', name: 'System Print Dialog (Fallback)', type: 'browser' }]; }
  async connect () { this.ok = true; }
  async disconnect () {}
  async write (data, htmlFallback) {
    const win = window.open('', '_blank', 'width=420,height=680');
    if (!win) throw new Error('Popup blocked — please allow pop-ups for this site');
    win.document.write(`<!DOCTYPE html><html><head><style>@media print{body{margin:0;font-family:'Courier New',monospace;font-size:11px}}</style></head><body><pre id="r"></pre><script>window.onload=function(){window.print();window.close();}<\/script></html>`);
    win.document.close();
    win.document.getElementById('r').textContent = htmlFallback || '';
  }
}

/* ─────────────────────────────────────────────────────────────────
   SOKONI UNIVERSAL PRINTER ENGINE  (singleton)
───────────────────────────────────────────────────────────────── */
class SPEngine {
  constructor () {
    this._adapters = {
      bluetooth: new BtAdapter(),
      usb:       new UsbAdapter(),
      serial:    new SerialAdapter(),
      network:   new NetworkAdapter(),
      browser:   new BrowserAdapter(),
    };
    this._active  = null;       // active adapter
    this._queue   = new PrintQueue();
    this._profile = this._loadProfile();
    this._cfg     = this._loadCfg();
    this._ev      = {};
    this._busy    = false;

    this._queue.on('enqueued', () => this._tick());
    this._queue.on('tick',     () => this._tick());
    this._queue.on('resumed',  () => this._tick());
  }

  /* ── Persistence ─────────────────────────────────────────── */
  _loadProfile () {
    try { return JSON.parse(localStorage.getItem('spp_profile') || '{}'); } catch(e) { return {}; }
  }
  _saveProfile () { localStorage.setItem('spp_profile', JSON.stringify(this._profile)); }
  _loadCfg () {
    const defaults = {
      paperWidth: '80mm', autoCut: true, copies: 1,
      autoPrintOnSale: false, logoText: '', footer: '',
      promoMessage: '', returnPolicy: '', showCommission: false,
    };
    try { return Object.assign({}, defaults, JSON.parse(localStorage.getItem('spp_config') || '{}')); }
    catch(e) { return defaults; }
  }
  _saveCfg () { localStorage.setItem('spp_config', JSON.stringify(this._cfg)); }

  /* ── Events ──────────────────────────────────────────────── */
  emit (ev, d) { (this._ev[ev] || []).forEach(fn => { try { fn(d); } catch(e) {} }); }
  on   (ev, fn) { (this._ev[ev] = this._ev[ev] || []).push(fn); return this; }
  off  (ev, fn) { this._ev[ev] = (this._ev[ev] || []).filter(f => f !== fn); return this; }

  /* ── Discovery ───────────────────────────────────────────── */
  async discoverAll () {
    const results = [];
    await Promise.allSettled(
      Object.values(this._adapters).map(async a => {
        if (!a.avail) return;
        try { results.push(...(await a.discover())); } catch(e) {}
      })
    );
    this.emit('discovered', results);
    return results;
  }
  async discoverBy (type) {
    const a = this._adapters[type];
    if (!a) throw new Error('Unknown transport: ' + type);
    return a.discover();
  }

  /* ── Connection ──────────────────────────────────────────── */
  async connect (deviceInfo) {
    if (this._active?.ok) await this.disconnect();
    const a = this._adapters[deviceInfo.type];
    if (!a) throw new Error('No adapter for: ' + deviceInfo.type);
    await a.connect(deviceInfo);
    this._active = a;
    this._profile.connectionType = deviceInfo.type;
    this._profile.lastDevice = { ...deviceInfo, _dev: undefined, _port: undefined };
    this._saveProfile();
    this.emit('connected', deviceInfo);
    this._tick();
  }
  async autoReconnect () {
    const last = this._profile.lastDevice;
    if (!last || last.type !== 'network') return false;
    try { await this.connect(last); return true; } catch(e) { return false; }
  }
  async disconnect () {
    if (this._active) { await this._active.disconnect().catch(()=>{}); this._active = null; }
    this.emit('disconnected', null);
  }
  get connected () { return !!(this._active?.ok); }

  /* ── Config / capabilities ───────────────────────────────── */
  setConfig (updates) { Object.assign(this._cfg, updates); this._saveCfg(); return this; }
  getConfig ()        { return { ...this._cfg }; }
  setCapabilities (u) { Object.assign(this._profile, u); this._saveProfile(); return this; }
  getCapabilities ()  { return { ...this._profile }; }

  /* ── Status ──────────────────────────────────────────────── */
  async getStatus () {
    if (!this._active) return { connected: false, online: false };
    try {
      const s = await (this._active.getStatus ? this._active.getStatus() : { online: this._active.ok });
      return { ...s, connected: this._active.ok };
    } catch(e) { return { connected: false, online: false, error: e.message }; }
  }

  /* ── Printing ────────────────────────────────────────────── */
  // Enqueue (non-blocking, returns jobId)
  async print (docType, data, options = {}) {
    return this._queue.enqueue(docType, data, { ...options, copies: options.copies || this._cfg.copies || 1 });
  }

  // Print immediately (blocking, throws on error)
  async printNow (docType, data, options = {}) {
    if (!this.connected) throw new Error('No printer connected');
    const renderer = new ReceiptRenderer(this._cfg.paperWidth || '80mm', this._cfg);
    const copies = options.copies || this._cfg.copies || 1;
    for (let c = 0; c < copies; c++) {
      await this._writeRender(renderer, docType, data);
      if (c < copies - 1) await new Promise(r => setTimeout(r, 400));
    }
  }

  async printRaw (bytes) {
    if (!this.connected) throw new Error('No printer connected');
    await this._active.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  }

  async openCashDrawer () {
    if (!this.connected) throw new Error('No printer connected');
    await this._active.write(new ESCPOSEncoder().init().drawer().build());
  }

  async _writeRender (renderer, docType, data) {
    const commands = renderer.render(docType, data);
    if (this._active?.type === 'browser') {
      const preview = renderer.previewHTML(docType, data);
      // Extract text from the HTML for browser print
      const tmp = document.createElement('div');
      tmp.innerHTML = preview;
      await this._active.write(null, tmp.textContent || '');
    } else {
      await this._active.write(commands);
    }
  }

  /* ── Queue processing ────────────────────────────────────── */
  _tick () {
    if (this._busy || !this.connected || this._queue._paused) return;
    const job = this._queue.next();
    if (!job) return;
    this._busy = true;
    this._queue.markProcessing(job);
    job.attempts++;
    const renderer = new ReceiptRenderer(this._cfg.paperWidth || '80mm', this._cfg);
    (async () => {
      for (let c = 0; c < job.copies; c++) {
        await this._writeRender(renderer, job.docType, job.data);
        if (c < job.copies - 1) await new Promise(r => setTimeout(r, 400));
      }
      this._queue.markDone(job);
      this.emit('printed', job);
    })()
    .catch(err => {
      this._queue.markFailed(job, err.message);
      this.emit('error', { job, error: err.message });
    })
    .finally(() => {
      this._busy = false;
      setTimeout(() => this._tick(), 150);
    });
  }

  /* ── Queue management ────────────────────────────────────── */
  getQueue   () { return this._queue.jobs(); }
  getHistory () { return this._queue.history(); }
  cancelJob  (id) { this._queue.cancel(id); }
  retryJob   (id) { this._queue.retry(id); }
  pauseQueue ()   { this._queue.pause(); }
  resumeQueue ()  { this._queue.resume(); }

  /* ── Preview ────────────────────────────────────────────── */
  preview (docType, data) {
    const r = new ReceiptRenderer(this._cfg.paperWidth || '80mm', this._cfg);
    return r.previewHTML(docType, data);
  }

  /* ── Test print ─────────────────────────────────────────── */
  async testPrint () {
    await this.printNow('receipt', {
      businessName: this._cfg.logoText || 'SOKONI SmartPOS',
      businessAddress: 'Printer Test Print',
      receiptNumber: 'TEST-001',
      cashierName: 'System',
      items: [
        { name: 'Test Item A', quantity: 1, unitPrice: 1000 },
        { name: 'Test Item B', quantity: 2, unitPrice: 500 },
      ],
      totals: { subtotal: 2000, grandTotal: 2000 },
      payment: { method: 'Cash', amountTendered: 2000, change: 0 },
    });
  }
}

/* ─────────────────────────────────────────────────────────────────
   SINGLETON + PUBLIC API
───────────────────────────────────────────────────────────────── */
let _inst = null;
function getInstance () { if (!_inst) _inst = new SPEngine(); return _inst; }

const api = {
  // Instance
  getInstance,

  // Discovery
  discover:        (...a) => getInstance().discoverAll(...a),
  discoverBy:      (...a) => getInstance().discoverBy(...a),

  // Connection
  connect:         (...a) => getInstance().connect(...a),
  disconnect:      (...a) => getInstance().disconnect(...a),
  autoReconnect:   (...a) => getInstance().autoReconnect(...a),
  get connected ()       { return getInstance().connected; },

  // Status
  getStatus:       (...a) => getInstance().getStatus(...a),
  getCapabilities: (...a) => getInstance().getCapabilities(...a),
  setCapabilities: (...a) => getInstance().setCapabilities(...a),

  // Config
  setConfig:       (...a) => getInstance().setConfig(...a),
  getConfig:       (...a) => getInstance().getConfig(...a),

  // Printing
  print:           (...a) => getInstance().print(...a),
  printNow:        (...a) => getInstance().printNow(...a),
  printRaw:        (...a) => getInstance().printRaw(...a),
  openCashDrawer:  (...a) => getInstance().openCashDrawer(...a),
  testPrint:       (...a) => getInstance().testPrint(...a),
  preview:         (...a) => getInstance().preview(...a),

  // Queue
  getQueue:        (...a) => getInstance().getQueue(...a),
  getHistory:      (...a) => getInstance().getHistory(...a),
  cancelJob:       (...a) => getInstance().cancelJob(...a),
  retryJob:        (...a) => getInstance().retryJob(...a),
  pauseQueue:      (...a) => getInstance().pauseQueue(...a),
  resumeQueue:     (...a) => getInstance().resumeQueue(...a),

  // Events
  on:              (...a) => getInstance().on(...a),
  off:             (...a) => getInstance().off(...a),

  // Network printer helpers
  saveNetworkPrinter:  NetworkAdapter.save,
  removeNetworkPrinter:NetworkAdapter.remove,

  // Exposed classes for extension
  ESCPOSEncoder,
  ReceiptRenderer,
  NetworkAdapter,
  PAPER_WIDTHS: PAPER,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.SokoniPrinter = api;

})(typeof window !== 'undefined' ? window : global);
