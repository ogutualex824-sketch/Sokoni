/* ════════════════════════════════════════════════════════════════════
   SOKONI Universal Printer Engine v5.0
   Vendor-neutral, standards-based receipt printing for SmartPOS

   Transports  : Bluetooth (Web Bluetooth) · USB / USB-OTG (WebUSB) ·
                 Serial (Web Serial) · Network (HTTP/WS) · Browser (fallback)
   Protocol    : ESC/POS industry standard
   Documents   : Sales · Invoice · Refund · Exchange · Kitchen · Packing ·
                 Delivery · Shipping Label · Labels · Queue · Parking ·
                 Picking Slip · Booking · Appointment · Service Order ·
                 Daily Summary · Monthly Summary · Custom (free-form)

   Public API  : window.SokoniPrinter.{discover,connect,print,printQR,
                 printBarcode,printImage,registerDocType,waitForJob,…}
   ════════════════════════════════════════════════════════════════════ */
'use strict';
(function (root) {

/* ─────────────────────────────────────────────────────────────────
   PRINTER ERROR CODES
───────────────────────────────────────────────────────────────── */
const PRINTER_ERRORS = {
  OFFLINE:           'PRINTER_OFFLINE',
  PAPER_OUT:         'PAPER_OUT',
  COVER_OPEN:        'COVER_OPEN',
  LOW_BATTERY:       'LOW_BATTERY',
  CONNECTION_LOST:   'CONNECTION_LOST',
  TIMEOUT:           'PRINT_TIMEOUT',
  UNSUPPORTED_CMD:   'UNSUPPORTED_CMD',
  IMAGE_LOAD_FAILED: 'IMAGE_LOAD_FAILED',
  UNKNOWN:           'UNKNOWN_ERROR',
};

/* ─────────────────────────────────────────────────────────────────
   ESC/POS CONSTANTS
───────────────────────────────────────────────────────────────── */
const ESC = 0x1B, GS = 0x1D, DLE = 0x10, LF = 0x0A, FS = 0x1C;

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
  STATUS_PROBE:  [DLE,0x04,0x01],  // Real-time status: paper/cover/drawer
  CHARSET_PC437: [ESC,0x74,0x00],
  CHARSET_PC850: [ESC,0x74,0x02],
};

const PAPER = {
  '58mm': { chars: 32, px: 384 },
  '76mm': { chars: 42, px: 504 },
  '80mm': { chars: 48, px: 576 },
};

/* ─────────────────────────────────────────────────────────────────
   ESC/POS ENCODER
───────────────────────────────────────────────────────────────── */
class ESCPOSEncoder {
  constructor () { this._b = []; }

  _a (d) {
    if (Array.isArray(d)) this._b.push(...d);
    else if (d instanceof Uint8Array) { for (let i = 0; i < d.length; i++) this._b.push(d[i]); }
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
  drawer ()         { return this._a(CMD.DRAWER); }
  statusProbe ()    { return this._a(CMD.STATUS_PROBE); }

  text (str) {
    const b = [];
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      b.push(c < 256 ? c : 0x3F);
    }
    return this._a(b);
  }

  line (str, align = 'left') {
    const ac = { left: CMD.ALIGN_L, center: CMD.ALIGN_C, right: CMD.ALIGN_R }[align] || CMD.ALIGN_L;
    return this._a(ac).text(str).lf();
  }

  row (left, right, w = 48) {
    const r = String(right);
    const l = String(left).slice(0, w - r.length - 1).padEnd(w - r.length - 1);
    return this.text(l + ' ' + r).lf();
  }

  sep (ch = '-', w = 48) { return this.text(ch.repeat(w)).lf(); }

  qr (data, size = 5) {
    const n = data.length + 3, pL = n & 0xFF, pH = (n >> 8) & 0xFF;
    this._a([GS,0x28,0x6B,0x04,0x00,0x31,0x41,0x32,0x00]);
    this._a([GS,0x28,0x6B,0x03,0x00,0x31,0x43,size]);
    this._a([GS,0x28,0x6B,0x03,0x00,0x31,0x45,0x31]);
    this._a([GS,0x28,0x6B,pL,pH,0x31,0x50,0x30]);
    for (let i = 0; i < data.length; i++) this._a(data.charCodeAt(i) & 0xFF);
    this._a([GS,0x28,0x6B,0x03,0x00,0x31,0x51,0x30]);
    return this;
  }

  barcode (data, type = 73, height = 80, width = 2) {
    this._a([GS,0x68,height, GS,0x77,width, GS,0x6B,type, data.length]);
    for (let i = 0; i < data.length; i++) this._a(data.charCodeAt(i) & 0xFF);
    return this;
  }

  /* Raster image — ESC/POS GS v 0 command
     widthBytes = ceil(widthPx / 8), heightDots = pixel height
     pixels = Uint8Array of packed 1-bit data (1=black, MSB first) */
  raster (widthBytes, heightDots, pixels) {
    const xL = widthBytes & 0xFF, xH = (widthBytes >> 8) & 0xFF;
    const yL = heightDots & 0xFF, yH = (heightDots >> 8) & 0xFF;
    this._a([GS, 0x76, 0x30, 0x00, xL, xH, yL, yH]);
    for (let i = 0; i < pixels.length; i++) this._b.push(pixels[i]);
    return this;
  }

  build () { return new Uint8Array(this._b); }
  reset () { this._b = []; return this; }
}

/* ─────────────────────────────────────────────────────────────────
   IMAGE → ESC/POS RASTER CONVERTER  (browser Canvas API)
───────────────────────────────────────────────────────────────── */
const _imgRasterCache = new Map();  // url → { pixels, widthBytes, heightDots }

function _imgToRaster (src, maxWidthPx, threshold = 128) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const scale = Math.min(1, maxWidthPx / img.width);
      const w = Math.floor(img.width  * scale);
      const h = Math.floor(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      const bytesPerRow = Math.ceil(w / 8);
      const pixels = new Uint8Array(bytesPerRow * h);
      for (let y = 0; y < h; y++) {
        for (let bx = 0; bx < bytesPerRow; bx++) {
          let byte = 0;
          for (let bit = 0; bit < 8; bit++) {
            const px = bx * 8 + bit;
            if (px < w) {
              const idx = (y * w + px) * 4;
              const gray = 0.299 * data[idx] + 0.587 * data[idx+1] + 0.114 * data[idx+2];
              if (gray < threshold) byte |= (0x80 >> bit);
            }
          }
          pixels[y * bytesPerRow + bx] = byte;
        }
      }
      resolve({ pixels, widthBytes: bytesPerRow, heightDots: h });
    };
    img.onerror = () => reject(Object.assign(new Error('Image load failed: ' + src), { code: PRINTER_ERRORS.IMAGE_LOAD_FAILED }));
    img.src = src;
  });
}

async function _imgToRasterCached (src, maxWidthPx, threshold = 128) {
  const key = src + '_' + maxWidthPx + '_' + threshold;
  if (_imgRasterCache.has(key)) return _imgRasterCache.get(key);
  const result = await _imgToRaster(src, maxWidthPx, threshold);
  _imgRasterCache.set(key, result);
  return result;
}

/* ─────────────────────────────────────────────────────────────────
   RECEIPT RENDERER  (adapts to 58mm / 76mm / 80mm)
───────────────────────────────────────────────────────────────── */
class ReceiptRenderer {
  constructor (paperWidth = '80mm', cfg = {}) {
    this._p = PAPER[paperWidth] || PAPER['80mm'];
    this._cfg = cfg;
    this._custom = {}; /* extensible doc type registry */
  }

  /* Register a custom document type renderer.
     fn(data, encoder, W, PX) should return void (mutates encoder).
     Or fn(data) may return a new Uint8Array directly. */
  register (docType, fn) { this._custom[String(docType)] = fn; return this; }
  get W () { return this._p.chars; }
  get PX () { return this._p.px; }
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

    /* Logo: raster image takes priority over text logo */
    e.ac();
    if (d._logoRaster) {
      const { pixels, widthBytes, heightDots } = d._logoRaster;
      e.raster(widthBytes, heightDots, pixels).lf();
    } else if (c.logoText || d.businessName) {
      e.bold(true).sz('big').text((c.logoText || d.businessName).slice(0, Math.floor(W / 2))).lf().sz('normal').bold(false);
    }
    if (d.businessName && (c.logoText || d._logoRaster)) e.bold(true).text(d.businessName).lf().bold(false);
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
    const qW = 4, pW = 10, nW = W - qW - pW - 2;
    e.bold(true).text('Item'.padEnd(nW) + ' Qty'.padStart(qW) + 'Amount'.padStart(pW)).lf().bold(false);
    e.text(this._sep()).lf();

    for (const it of (d.items || [])) {
      const name   = String(it.name || 'Item').slice(0, nW).padEnd(nW);
      const qty    = String(it.quantity || 1).padStart(qW);
      const amount = this._kes((it.unitPrice || 0) * (it.quantity || 1)).padStart(pW);
      e.text(name + qty + amount).lf();
      if (it.variant)  e.text('  Variant: ' + it.variant).lf();
      if (it.notes)    e.text('  Note: ' + it.notes).lf();
      if (it.discount) e.text(('  Disc: -' + this._kes(it.discount)).padEnd(W)).lf();
    }

    e.text(this._sep()).lf();
    const t = d.totals || {};
    if (t.subtotal  != null)  e.text(this._cols('Subtotal:',      this._kes(t.subtotal))).lf();
    if (t.discount)           e.text(this._cols('Discount:',     '-' + this._kes(t.discount))).lf();
    if (t.coupon)             e.text(this._cols('Coupon:',       '-' + this._kes(t.coupon))).lf();
    if (t.vat)                e.text(this._cols('VAT (16%):',     this._kes(t.vat))).lf();
    if (t.serviceCharge)      e.text(this._cols('Service Charge:', this._kes(t.serviceCharge))).lf();
    if (t.deliveryFee)        e.text(this._cols('Delivery:',      this._kes(t.deliveryFee))).lf();
    if (t.commission && this._cfg.showCommission)
                              e.text(this._cols('Platform Fee:',  this._kes(t.commission))).lf();
    e.text(this._sep()).lf();
    e.bold(true).sz('tall').text(this._cols('TOTAL:', this._kes(t.grandTotal))).lf().sz('normal').bold(false);
    e.text(this._sep()).lf();

    const pay = d.payment || {};
    if (pay.method)          e.text(this._cols('Payment:',  pay.method)).lf();
    if (pay.amountTendered)  e.text(this._cols('Tendered:', this._kes(pay.amountTendered))).lf();
    if (pay.change != null)  e.text(this._cols('Change:',   this._kes(pay.change))).lf();
    if (pay.mpesaCode)       e.text('M-PESA: ' + pay.mpesaCode).lf();
    if (pay.authCode)        e.text('Auth: ' + pay.authCode).lf();

    if (d.receiptUrl || d.digitalRef) {
      e.lf().ac().text('Scan for digital receipt').lf();
      e.qr(d.receiptUrl || d.digitalRef, 4);
    }
    if (d.barcode) e.ac().barcode(d.barcode);

    e.lf().ac();
    if (c.footer)            e.text(c.footer).lf();
    if (d.returnPolicy)      e.text(d.returnPolicy).lf();
    if (d.warrantyInfo)      e.text(d.warrantyInfo).lf();
    if (d.promoMessage)      e.bold(true).text(d.promoMessage).lf().bold(false);
    if (d.digitalRef)        e.text('Ref: ' + d.digitalRef).lf();

    e.lf(3).cut();
    return e.build();
  }

  /* ── Refund receipt ────────────────────────────────────────── */
  refund (d) {
    const marker = new ESCPOSEncoder().init()
      .ac().bold(true).sz('big').text('** REFUND **').lf().sz('normal').bold(false).build();
    const rest = this.sale({ ...d, receiptUrl: null });
    const out = new Uint8Array(marker.length + rest.length);
    out.set(marker); out.set(rest, marker.length);
    return out;
  }

  /* ── Exchange receipt ──────────────────────────────────────── */
  exchange (d) {
    const e = new ESCPOSEncoder().init();
    e.ac().bold(true).sz('big').text('** EXCHANGE **').lf().sz('normal').bold(false);
    if (d.businessName) e.text(d.businessName).lf();
    e.al().text(this._sep()).lf();
    const now = new Date();
    e.text(this._cols('Date:', d.date || now.toLocaleDateString('en-KE'))).lf();
    e.text(this._cols('Time:', d.time || now.toLocaleTimeString('en-KE'))).lf();
    if (d.exchangeRef)   e.text(this._cols('Exchange #:', d.exchangeRef)).lf();
    if (d.originalRef)   e.text(this._cols('Original #:', d.originalRef)).lf();
    if (d.cashierName)   e.text(this._cols('Cashier:',    d.cashierName)).lf();

    // Returned items
    e.text(this._sep()).lf();
    e.bold(true).text('RETURNED:').lf().bold(false);
    for (const it of (d.returnedItems || [])) {
      e.text(String(it.quantity || 1) + 'x  ' + String(it.name || 'Item').slice(0, this.W - 6)).lf();
      e.text('  Value: ' + this._kes((it.unitPrice || 0) * (it.quantity || 1))).lf();
    }

    // New items
    e.text(this._sep()).lf();
    e.bold(true).text('NEW ITEMS:').lf().bold(false);
    for (const it of (d.newItems || [])) {
      e.text(String(it.quantity || 1) + 'x  ' + String(it.name || 'Item').slice(0, this.W - 6)).lf();
      e.text('  Price: ' + this._kes((it.unitPrice || 0) * (it.quantity || 1))).lf();
    }

    // Settlement
    e.text(this._sep()).lf();
    const returnVal = (d.returnedValue || 0);
    const newVal    = (d.newValue || 0);
    const diff      = newVal - returnVal;
    e.text(this._cols('Returned Value:', this._kes(returnVal))).lf();
    e.text(this._cols('New Items Value:', this._kes(newVal))).lf();
    e.bold(true);
    if (diff > 0)       e.text(this._cols('AMOUNT TO PAY:', this._kes(diff))).lf();
    else if (diff < 0)  e.text(this._cols('REFUND DUE:',    this._kes(-diff))).lf();
    else                e.text('NO ADDITIONAL PAYMENT REQUIRED').lf();
    e.bold(false);

    if (d.payment?.method) e.text(this._cols('Settled via:', d.payment.method)).lf();
    e.lf(3).cut();
    return e.build();
  }

  /* ── Kitchen ticket ────────────────────────────────────────── */
  kitchen (d) {
    const e = new ESCPOSEncoder().init();
    e.ac().bold(true).sz('big').text('*** KITCHEN ***').lf().sz('normal').lf();
    e.text(this._cols('Order #:', d.orderNumber || '?')).lf();
    e.text(this._cols('Table:',   d.table || 'Takeaway')).lf();
    e.text(this._cols('Time:',    new Date().toLocaleTimeString('en-KE'))).lf();
    if (d.priority === 'urgent') e.inv(true).ac().text(' !! URGENT !! ').lf().inv(false);
    e.al().text(this._sep()).lf();
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

  /* ── Shipping label ────────────────────────────────────────── */
  shippingLabel (d) {
    const e = new ESCPOSEncoder().init();
    e.ac().bold(true).sz('big').text('SHIP').lf().sz('normal').bold(false);
    if (d.trackingNumber) {
      e.lf().ac();
      e.barcode(d.trackingNumber, 73, 80, 2);
      e.text(d.trackingNumber).lf();
    }
    e.al().text(this._sep('=')).lf();
    e.bold(true).text('TO:').lf().bold(false);
    if (d.toName)    e.sz('tall').text(d.toName).lf().sz('normal');
    if (d.toAddress) e.text(d.toAddress).lf();
    if (d.toCity)    e.text(d.toCity).lf();
    if (d.toPhone)   e.text('Tel: ' + d.toPhone).lf();
    e.text(this._sep()).lf();
    e.bold(true).text('FROM:').lf().bold(false);
    if (d.fromName)    e.text(d.fromName).lf();
    if (d.fromAddress) e.text(d.fromAddress).lf();
    if (d.fromPhone)   e.text('Tel: ' + d.fromPhone).lf();
    e.text(this._sep()).lf();
    if (d.weight)    e.text(this._cols('Weight:', d.weight)).lf();
    if (d.service)   e.text(this._cols('Service:', d.service)).lf();
    if (d.contents)  e.text(this._cols('Contents:', d.contents)).lf();
    if (d.fragile)   e.inv(true).ac().text(' FRAGILE — HANDLE WITH CARE ').lf().inv(false);
    if (d.qr)        e.ac().lf().qr(d.qr, 4);
    e.lf(3).cut();
    return e.build();
  }

  /* ── Warehouse picking slip ────────────────────────────────── */
  pickingSlip (d) {
    const e = new ESCPOSEncoder().init();
    e.ac().bold(true).text('PICKING SLIP').lf().bold(false);
    e.al().text(this._sep()).lf();
    e.text(this._cols('Order #:',    d.orderNumber  || '?')).lf();
    e.text(this._cols('Picker:',     d.pickerName   || '?')).lf();
    e.text(this._cols('Zone:',       d.zone         || '—')).lf();
    e.text(this._cols('Date:',       d.date || new Date().toLocaleDateString('en-KE'))).lf();
    e.text(this._cols('Time:',       d.time || new Date().toLocaleTimeString('en-KE'))).lf();
    if (d.priority === 'urgent') e.inv(true).ac().text(' !! URGENT PICK !! ').lf().inv(false);
    e.al().text(this._sep()).lf();
    e.bold(true);
    e.text('Bin'.padEnd(10) + 'SKU'.padEnd(14) + 'Qty'.padStart(4) + ' Picked').lf();
    e.bold(false).text(this._sep()).lf();
    for (const it of (d.items || [])) {
      const bin = String(it.bin || '—').padEnd(10);
      const sku = String(it.sku || it.name || '').slice(0, 13).padEnd(14);
      const qty = String(it.quantity || 1).padStart(4);
      e.text(bin + sku + qty + ' [   ]').lf();
      if (it.variant) e.text('       Variant: ' + it.variant).lf();
    }
    e.text(this._sep()).lf();
    e.text('Total Items: ' + (d.items || []).length + '   Total Units: ' +
      (d.items || []).reduce((s, it) => s + (it.quantity || 1), 0)).lf();
    if (d.notes) e.lf().text('Notes: ' + d.notes).lf();
    if (d.qr) e.ac().lf().qr(d.qr, 3);
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
    if (d.exp)  e.text('EXP: ' + d.exp).lf();
    if (d.barcode) e.barcode(d.barcode, 73, 60, 2);
    if (d.qr)  e.qr(d.qr, 3);
    e.lf(2).cut();
    return e.build();
  }

  /* ── Queue / parking ticket ────────────────────────────────── */
  queueTicket (d) {
    const e = new ESCPOSEncoder().init().ac();
    if (d.businessName) e.text(d.businessName).lf();
    e.lf().sz('big').bold(true).text(d.ticketNumber || '001').lf().sz('normal').bold(false);
    if (d.service)       e.text(d.service).lf();
    if (d.estimatedWait) e.text('Est. wait: ' + d.estimatedWait).lf();
    if (d.time)          e.text(d.time).lf();
    if (d.date)          e.text(d.date).lf();
    if (d.qr)            e.lf().qr(d.qr, 4);
    e.lf(3).cut();
    return e.build();
  }

  /* ── Parking ticket ────────────────────────────────────────── */
  parkingTicket (d) {
    const e = new ESCPOSEncoder().init().ac();
    if (d.facilityName) e.bold(true).text(d.facilityName).lf().bold(false);
    e.lf().sz('big').bold(true).text(d.ticketNumber || 'P-001').lf().sz('normal').bold(false);
    e.al().text(this._sep()).lf();
    if (d.plateNumber) e.text(this._cols('Plate:', d.plateNumber)).lf();
    if (d.zone)        e.text(this._cols('Zone/Bay:', d.zone)).lf();
    e.text(this._cols('Entry:', d.entryTime || new Date().toLocaleTimeString('en-KE'))).lf();
    if (d.exitTime)    e.text(this._cols('Exit:', d.exitTime)).lf();
    if (d.duration)    e.text(this._cols('Duration:', d.duration)).lf();
    if (d.rate)        e.text(this._cols('Rate:', d.rate)).lf();
    if (d.fee != null) {
      e.text(this._sep()).lf();
      e.bold(true).text(this._cols('TOTAL FEE:', this._kes(d.fee))).lf().bold(false);
    }
    if (d.paid)        e.text(this._cols('Status:', 'PAID')).lf();
    if (d.barcode)     e.ac().lf().barcode(d.barcode, 73, 80, 2);
    if (d.qr)          e.ac().lf().qr(d.qr, 4);
    e.lf(3).cut();
    return e.build();
  }

  /* ── Booking / appointment confirmation ────────────────────── */
  booking (d) {
    const e = new ESCPOSEncoder().init();
    e.ac().bold(true).text('BOOKING CONFIRMATION').lf().bold(false);
    e.al().text(this._sep()).lf();
    if (d.bookingRef)   e.text(this._cols('Ref:',      d.bookingRef)).lf();
    if (d.service)      e.text(this._cols('Service:',  d.service)).lf();
    if (d.provider)     e.text(this._cols('With:',     d.provider)).lf();
    if (d.date)         e.text(this._cols('Date:',     d.date)).lf();
    if (d.time)         e.text(this._cols('Time:',     d.time)).lf();
    if (d.duration)     e.text(this._cols('Duration:', d.duration)).lf();
    if (d.location)     e.text(this._cols('Location:', d.location)).lf();
    e.text(this._sep()).lf();
    if (d.customerName)  e.text('Name: ' + d.customerName).lf();
    if (d.customerPhone) e.text('Phone: ' + d.customerPhone).lf();
    if (d.amount != null) {
      e.text(this._sep()).lf();
      e.text(this._cols('Amount:', this._kes(d.amount))).lf();
      if (d.deposit) e.text(this._cols('Deposit Paid:', this._kes(d.deposit))).lf();
    }
    if (d.notes) e.lf().text('Notes: ' + d.notes).lf();
    if (d.qr) e.ac().lf().qr(d.qr, 4);
    e.lf(3).cut();
    return e.build();
  }

  /* ── Service / repair confirmation ────────────────────────── */
  serviceConfirmation (d) {
    const e = new ESCPOSEncoder().init();
    e.ac().bold(true).text('SERVICE ORDER').lf().bold(false);
    if (d.businessName) e.text(d.businessName).lf();
    e.al().text(this._sep()).lf();
    if (d.serviceRef)    e.text(this._cols('Job #:',       d.serviceRef)).lf();
    if (d.customerName)  e.text(this._cols('Customer:',    d.customerName)).lf();
    if (d.customerPhone) e.text(this._cols('Phone:',       d.customerPhone)).lf();
    if (d.device)        e.text(this._cols('Device/Item:', d.device)).lf();
    if (d.serial)        e.text(this._cols('Serial #:',    d.serial)).lf();
    if (d.problem)       { e.text(this._sep()).lf(); e.bold(true).text('Issue:').lf().bold(false); e.text(d.problem).lf(); }
    if (d.diagnosis)     { e.text(this._sep()).lf(); e.bold(true).text('Diagnosis:').lf().bold(false); e.text(d.diagnosis).lf(); }
    if (d.parts && d.parts.length) {
      e.text(this._sep()).lf();
      e.bold(true).text('Parts:').lf().bold(false);
      for (const p of d.parts) e.text((p.quantity || 1) + 'x ' + p.name + '  ' + this._kes(p.price)).lf();
    }
    e.text(this._sep()).lf();
    if (d.labour)         e.text(this._cols('Labour:', this._kes(d.labour))).lf();
    if (d.estimatedTotal) e.bold(true).text(this._cols('Est. Total:', this._kes(d.estimatedTotal))).lf().bold(false);
    if (d.completionDate) e.text(this._cols('Est. Ready:', d.completionDate)).lf();
    if (d.warranty)       e.text(this._cols('Warranty:', d.warranty)).lf();
    e.text(this._sep()).lf();
    if (d.terms) e.text(d.terms).lf();
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
    e.text(this._cols('Refunds:',        this._kes(d.totalRefunds))).lf();
    e.text(this._cols('Exchanges:',      String(d.exchangeCount || 0))).lf();
    e.text(this._cols('Net Revenue:',    this._kes(d.netRevenue))).lf();
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
    if (d.topItem) e.text(this._cols('Best Seller:', d.topItem)).lf();
    e.lf(3).cut();
    return e.build();
  }

  /* ── Monthly summary ───────────────────────────────────────── */
  monthlySummary (d) {
    const e = new ESCPOSEncoder().init();
    e.ac().bold(true).sz('tall').text('MONTHLY SUMMARY').lf().sz('normal').bold(false);
    e.text(d.period || '').lf();
    if (d.businessName) e.text(d.businessName).lf();
    e.al().text(this._sep('=')).lf();
    e.text(this._cols('Total Revenue:',    this._kes(d.totalRevenue))).lf();
    e.text(this._cols('Transactions:',     String(d.transactionCount || 0))).lf();
    e.text(this._cols('Avg Daily Sales:',  this._kes(d.avgDailySales))).lf();
    e.text(this._cols('Best Day:',         d.bestDay || '—')).lf();
    e.text(this._cols('Best Day Revenue:', this._kes(d.bestDayRevenue))).lf();
    e.text(this._sep()).lf();
    e.text(this._cols('Refunds:',          this._kes(d.totalRefunds))).lf();
    e.text(this._cols('Net Revenue:',      this._kes(d.netRevenue))).lf();
    if (d.prevMonthRevenue != null) {
      const growth = d.totalRevenue > 0 && d.prevMonthRevenue > 0
        ? (((d.totalRevenue - d.prevMonthRevenue) / d.prevMonthRevenue) * 100).toFixed(1)
        : null;
      if (growth) e.text(this._cols('vs Last Month:', (growth > 0 ? '+' : '') + growth + '%')).lf();
    }
    e.text(this._sep()).lf();
    if (d.topProducts && d.topProducts.length) {
      e.bold(true).text('TOP PRODUCTS:').lf().bold(false);
      d.topProducts.slice(0, 5).forEach((p, i) =>
        e.text(String(i+1) + '. ' + String(p.name).slice(0, this.W - 12) + ' ' + this._kes(p.revenue)).lf()
      );
      e.text(this._sep()).lf();
    }
    if (d.paymentBreakdown) {
      e.bold(true).text('BY PAYMENT:').lf().bold(false);
      for (const [m, v] of Object.entries(d.paymentBreakdown))
        e.text(this._cols(m + ':', this._kes(v))).lf();
      e.text(this._sep()).lf();
    }
    e.lf(3).cut();
    return e.build();
  }

  /* ── Formal invoice ───────────────────────────────────────── */
  invoice (d) {
    const e = new ESCPOSEncoder().init();
    const W = this.W, c = this._cfg;

    e.ac();
    if (d._logoRaster) {
      e.raster(d._logoRaster.widthBytes, d._logoRaster.heightDots, d._logoRaster.pixels).lf();
    } else if (c.logoText || d.businessName) {
      e.bold(true).sz('big').text((c.logoText || d.businessName).slice(0, Math.floor(W / 2))).lf().sz('normal').bold(false);
    }
    e.bold(true).sz('tall').text('TAX INVOICE').lf().sz('normal').bold(false);
    if (d.businessAddress) e.text(d.businessAddress).lf();
    if (d.businessPhone)   e.text('Tel: ' + d.businessPhone).lf();
    if (d.businessPin)     e.text('PIN: ' + d.businessPin).lf();
    if (d.vatNumber)       e.text('VAT: ' + d.vatNumber).lf();

    e.al().text(this._sep('=')).lf();
    if (d.invoiceNumber) e.bold(true).text(this._cols('Invoice #:', d.invoiceNumber)).lf().bold(false);
    e.text(this._cols('Invoice Date:', d.invoiceDate || new Date().toLocaleDateString('en-KE'))).lf();
    if (d.dueDate)       e.text(this._cols('Due Date:', d.dueDate)).lf();
    if (d.paymentTerms)  e.text(this._cols('Terms:', d.paymentTerms)).lf();

    e.text(this._sep()).lf();
    e.bold(true).text('BILL TO:').lf().bold(false);
    if (d.customerName)    e.text(d.customerName).lf();
    if (d.customerCompany) e.text(d.customerCompany).lf();
    if (d.customerAddress) e.text(d.customerAddress).lf();
    if (d.customerPhone)   e.text('Tel: ' + d.customerPhone).lf();
    if (d.customerPin)     e.text('PIN: ' + d.customerPin).lf();

    e.text(this._sep()).lf();
    const qW = 4, pW = 11, nW = W - qW - pW - 2;
    e.bold(true).text('Item'.padEnd(nW) + ' Qty'.padStart(qW) + 'Amount'.padStart(pW)).lf().bold(false);
    e.text(this._sep()).lf();

    for (const it of (d.items || [])) {
      const name   = String(it.name || 'Item').slice(0, nW).padEnd(nW);
      const qty    = String(it.quantity || 1).padStart(qW);
      const amount = this._kes((it.unitPrice || 0) * (it.quantity || 1)).padStart(pW);
      e.text(name + qty + amount).lf();
      if (it.description) e.text('  ' + it.description.slice(0, W - 2)).lf();
      if (it.discount)    e.text(('  Disc: -' + this._kes(it.discount)).padEnd(W)).lf();
    }

    e.text(this._sep()).lf();
    const t = d.totals || {};
    if (t.subtotal  != null)  e.text(this._cols('Subtotal:',       this._kes(t.subtotal))).lf();
    if (t.discount)           e.text(this._cols('Discount:',      '-' + this._kes(t.discount))).lf();
    if (t.vat != null)        e.text(this._cols('VAT (16%):',      this._kes(t.vat))).lf();
    if (t.withholdingTax)     e.text(this._cols('WHT (5%):',      '-' + this._kes(t.withholdingTax))).lf();
    if (t.serviceCharge)      e.text(this._cols('Service Charge:', this._kes(t.serviceCharge))).lf();
    e.text(this._sep()).lf();
    e.bold(true).sz('tall').text(this._cols('AMOUNT DUE:', this._kes(t.grandTotal))).lf().sz('normal').bold(false);
    e.text(this._sep()).lf();

    if (d.bankDetails) {
      e.bold(true).text('PAYMENT DETAILS:').lf().bold(false);
      e.text(d.bankDetails).lf();
    }
    if (d.mpesaTill)   e.text('M-PESA Till: ' + d.mpesaTill).lf();
    if (d.notes)       e.lf().text(d.notes).lf();
    if (d.receiptUrl)  e.lf().ac().text('View invoice online:').lf().qr(d.receiptUrl, 4);
    if (d.barcode)     e.ac().barcode(d.barcode);
    e.lf().ac();
    if (c.footer)       e.text(c.footer).lf();
    if (d.terms)        e.text(d.terms).lf();
    e.lf(3).cut();
    return e.build();
  }

  /* ── Custom / free-form ────────────────────────────────────── */
  custom (d) {
    /* d.build must be a function that receives an ESCPOSEncoder and the W/PX values,
       then returns void (mutates the encoder).
       Allows any printable content without modifying this file. */
    const e = new ESCPOSEncoder().init();
    if (typeof d.build === 'function') {
      try { d.build(e, this.W, this.PX); } catch(err) { e.text('Custom render error: ' + err.message).lf(); }
    } else if (typeof d.lines === 'string') {
      e.text(d.lines).lf();
    } else if (Array.isArray(d.lines)) {
      for (const line of d.lines) e.text(String(line)).lf();
    } else {
      e.text('(empty custom document)').lf();
    }
    e.lf(3).cut();
    return e.build();
  }

  /* ── Generic dispatcher ────────────────────────────────────── */
  render (docType, data) {
    const map = {
      sale: this.sale, receipt: this.sale, sales_receipt: this.sale,
      refund: this.refund, refund_receipt: this.refund,
      exchange: this.exchange, exchange_receipt: this.exchange,
      kitchen: this.kitchen, kitchen_ticket: this.kitchen,
      delivery: this.delivery, packing_slip: this.delivery,
      delivery_slip: this.delivery,
      shipping_label: this.shippingLabel, ship: this.shippingLabel,
      picking_slip: this.pickingSlip, warehouse_pick: this.pickingSlip,
      label: this.label, inventory_label: this.label,
      barcode_label: this.label, qr_label: this.label,
      queue_ticket: this.queueTicket,
      parking_ticket: this.parkingTicket, parking: this.parkingTicket,
      booking: this.booking, appointment: this.booking,
      booking_confirmation: this.booking, appointment_ticket: this.booking,
      service_confirmation: this.serviceConfirmation, service_order: this.serviceConfirmation,
      repair_ticket: this.serviceConfirmation,
      daily_summary: this.dailySummary, cash_report: this.dailySummary,
      shift_report: this.dailySummary,
      monthly_summary: this.monthlySummary, monthly_report: this.monthlySummary,
      invoice: this.invoice, tax_invoice: this.invoice,
      custom: this.custom, freeform: this.custom,
      ...this._custom,
    };
    const fn = map[docType];
    if (!fn) return this.sale(data);
    return fn.call(this, data);
  }

  /* ── HTML preview ──────────────────────────────────────────── */
  previewHTML (docType, data) {
    const raw = this.render(docType, data);
    let txt = '';
    let i = 0;
    while (i < raw.length) {
      const b = raw[i];
      if (b === 0x1B || b === 0x1D || b === 0x10 || b === 0x1C) { i += 2; while (i < raw.length && (raw[i] > 127 || raw[i] < 0x20)) i++; continue; }
      if (b === 0x0A) txt += '\n';
      else if (b >= 0x20 && b < 0x7F) txt += String.fromCharCode(b);
      i++;
    }
    const w = this._p.chars * 7.5;
    return `<div style="width:${w}px;font-family:'Courier New',monospace;font-size:12px;line-height:1.5;white-space:pre;padding:12px 10px;border:1px solid #333;background:#fff;color:#111">${txt.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>`;
  }
}

/* ─────────────────────────────────────────────────────────────────
   PRINT QUEUE  (persistent via localStorage, priority-sorted)
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
  on   (ev, fn) { (this._ev[ev] = this._ev[ev] || []).push(fn); }
  off  (ev, fn) { this._ev[ev] = (this._ev[ev] || []).filter(f => f !== fn); }

  enqueue (docType, data, opts = {}) {
    const job = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      docType, data,
      copies:      opts.copies || 1,
      priority:    opts.priority || 0,   // higher = print first
      maxAttempts: opts.maxAttempts || 3,
      status:      'pending', attempts: 0, error: null,
      createdAt:   new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    this._q.push(job); this._save();
    this.emit('enqueued', job);
    return job.id;
  }

  /* Return highest-priority pending job */
  next () {
    if (this._paused) return null;
    const pending = this._q.filter(j => j.status === 'pending');
    if (!pending.length) return null;
    return pending.reduce((best, j) => j.priority > best.priority ? j : best, pending[0]);
  }

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
  cancelAll () {
    const now = new Date().toISOString();
    const cancelled = this._q.map(j => ({ ...j, status: 'cancelled', updatedAt: now }));
    this._hist.unshift(...cancelled);
    this._q = [];
    this._save();
    this.emit('cancelled_all', cancelled);
  }
  clearHistory () { this._hist = []; this._save(); this.emit('history_cleared', null); }

  jobs    () { return [...this._q]; }
  history () { return [...this._hist]; }
  getJob  (id) { return [...this._q, ...this._hist].find(j => j.id === id) || null; }
}

/* ─────────────────────────────────────────────────────────────────
   TRANSPORT ADAPTERS
───────────────────────────────────────────────────────────────── */

class BtAdapter {
  constructor () { this.ok = false; this._char = null; this._dev = null; this._srv = null; this._chunkSize = 128; this._chunkDelay = 40; }
  get type () { return 'bluetooth'; }
  get avail () { return !!navigator.bluetooth; }

  async discover () {
    if (!this.avail) return [];
    const filters = [
      { services: ['0000ff00-0000-1000-8000-00805f9b34fb'] }, // P58E / Goojprt / Chinese BLE printers
      { services: ['000018f0-0000-1000-8000-00805f9b34fb'] },
      { services: ['e7810a71-73ae-499d-8c15-faa9aef0c3f2'] },
      { services: ['0000ffe0-0000-1000-8000-00805f9b34fb'] },
      { namePrefix: 'P58'  }, { namePrefix: 'P80'   }, { namePrefix: 'PT-'  },
      { namePrefix: 'BTP'  }, { namePrefix: 'HOP'   }, { namePrefix: 'SP-'  },
      { namePrefix: 'MTP'  }, { namePrefix: 'Rongta'}, { namePrefix: 'Xprinter' },
      { namePrefix: 'EPSON'}, { namePrefix: 'Star'  }, { namePrefix: 'POS'  },
      { namePrefix: 'BP-'  }, { namePrefix: 'RPP'   }, { namePrefix: 'BTPT' },
      { namePrefix: 'Printer'}, { namePrefix: 'TM-' }, { namePrefix: 'iDPRT'},
      { namePrefix: 'Cashino'}, { namePrefix: 'GT'  },
    ];
    try {
      const d = await navigator.bluetooth.requestDevice({
        filters,
        optionalServices: [
          '0000ff00-0000-1000-8000-00805f9b34fb',
          '000018f0-0000-1000-8000-00805f9b34fb',
          'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
          '0000ffe0-0000-1000-8000-00805f9b34fb',
        ],
      });
      return [{ id: d.id, name: d.name || 'Bluetooth Printer', type: 'bluetooth', _dev: d }];
    } catch(e) { return []; }
  }

  async connect (info) {
    const d = info._dev;
    this._dev = d;
    this._srv = await d.gatt.connect();
    const serviceUUIDs = [
      '0000ff00-0000-1000-8000-00805f9b34fb', // P58E primary — check first
      '000018f0-0000-1000-8000-00805f9b34fb',
      'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
      '0000ffe0-0000-1000-8000-00805f9b34fb',
    ];
    let svc = null;
    for (const u of serviceUUIDs) { try { svc = await this._srv.getPrimaryService(u); break; } catch(e) {} }
    if (!svc) throw new Error('No print service on this Bluetooth device');
    const charUUIDs = [
      '0000ff02-0000-1000-8000-00805f9b34fb', // P58E write characteristic
      '00002af1-0000-1000-8000-00805f9b34fb',
      'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
      '0000ffe1-0000-1000-8000-00805f9b34fb',
    ];
    for (const u of charUUIDs) { try { this._char = await svc.getCharacteristic(u); break; } catch(e) {} }
    if (!this._char) {
      const chars = await svc.getCharacteristics().catch(() => []);
      this._char = chars.find(c => c.properties.write || c.properties.writeWithoutResponse) || null;
    }
    if (!this._char) throw new Error('No write characteristic found');
    this.ok = true; this._info = info;
    d.addEventListener('gattserverdisconnected', () => {
      this.ok = false;
      this._reconnect(d);
    });
  }

  async _reconnect (device) {
    let delay = 1000;
    for (let attempt = 1; attempt <= 6; attempt++) {
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30000);
      try {
        const srv = await device.gatt.connect();
        this._srv = srv;
        const serviceUUIDs = [
          '0000ff00-0000-1000-8000-00805f9b34fb',
          '000018f0-0000-1000-8000-00805f9b34fb',
          'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
          '0000ffe0-0000-1000-8000-00805f9b34fb',
        ];
        let svc = null;
        for (const u of serviceUUIDs) { try { svc = await srv.getPrimaryService(u); break; } catch(e) {} }
        if (!svc) continue;
        const charUUIDs = [
          '0000ff02-0000-1000-8000-00805f9b34fb',
          '00002af1-0000-1000-8000-00805f9b34fb',
          'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
          '0000ffe1-0000-1000-8000-00805f9b34fb',
        ];
        let ch = null;
        for (const u of charUUIDs) { try { ch = await svc.getCharacteristic(u); if (ch) break; } catch(e) {} }
        if (!ch) {
          const chars = await svc.getCharacteristics().catch(() => []);
          ch = chars.find(c => c.properties.write || c.properties.writeWithoutResponse) || null;
        }
        if (ch) { this._char = ch; this.ok = true; return; }
      } catch(e) { /* retry */ }
    }
  }

  async disconnect () { this._dev?.gatt?.connected && this._dev.gatt.disconnect(); this.ok = false; }

  async write (data) {
    if (!this.ok || !this._char) throw Object.assign(new Error('BT printer not connected'), { code: PRINTER_ERRORS.OFFLINE });
    const CHUNK = this._chunkSize || 128; // 128 bytes — safe for P58E and all BLE printers
    const DELAY = this._chunkDelay || 40; // 40ms inter-chunk delay required by P58E
    for (let i = 0; i < data.length; i += CHUNK) {
      if (this._char.properties.writeWithoutResponse) {
        await this._char.writeValueWithoutResponse(data.slice(i, i + CHUNK));
      } else {
        await this._char.writeValue(data.slice(i, i + CHUNK));
      }
      await new Promise(r => setTimeout(r, DELAY));
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
      const d = await navigator.usb.requestDevice({ filters: [{ classCode: 0x07 }] });
      return [{ id: d.serialNumber || 'usb-0', name: d.productName || 'USB Printer', type: 'usb', _dev: d, vendorId: d.vendorId }];
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
            ep = alt.endpoints.find(e => e.direction === 'out' && e.type === 'bulk');
            if (ep) { iface = intf; break outer; }
          }
    if (!ep) throw new Error('No printer interface on USB device (class 7)');
    await d.claimInterface(iface.interfaceNumber);
    this._iface = iface; this._ep = ep; this._dev = d; this.ok = true;
  }

  async disconnect () {
    if (this._iface && this._dev) await this._dev.releaseInterface(this._iface.interfaceNumber).catch(()=>{});
    await this._dev?.close().catch(()=>{});
    this.ok = false;
  }

  async write (data) {
    if (!this.ok) throw Object.assign(new Error('USB printer not connected'), { code: PRINTER_ERRORS.OFFLINE });
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
    try { await this._writer?.releaseLock(); } catch(e) {}
    try { await this._port?.close(); } catch(e) {}
    this.ok = false;
  }

  async write (data) {
    if (!this.ok || !this._writer) throw Object.assign(new Error('Serial printer not connected'), { code: PRINTER_ERRORS.OFFLINE });
    await this._writer.write(data);
  }
}

class NetworkAdapter {
  constructor () { this.ok = false; this._ep = null; this._proto = null; this._ws = null; this._ping = null; }
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
        this._ws.onclose = () => { this.ok = false; clearInterval(this._ping); };
        const t = setTimeout(() => rej(new Error('Connection timeout')), 5000);
        this._ws.onopen = () => { clearTimeout(t); this.ok = true; res(); };
      });
      this._ping = setInterval(() => { if (this._ws.readyState === WebSocket.OPEN) this._ws.send(new Uint8Array(0)); }, 25000);
    } else {
      const r = await fetch(ep + '/status', { method: 'GET', signal: AbortSignal.timeout(4000) }).catch(err => { throw new Error('Cannot reach printer at ' + ep + ': ' + err.message); });
      if (!r.ok) throw new Error('Printer HTTP status error: ' + r.status);
      this.ok = true;
    }
    this._info = info;
  }

  async disconnect () { clearInterval(this._ping); this._ws?.close(); this.ok = false; }

  async write (data) {
    if (!this.ok) throw Object.assign(new Error('Network printer not connected'), { code: PRINTER_ERRORS.OFFLINE });
    if (this._proto === 'ws') {
      this._ws.send(data.buffer instanceof ArrayBuffer ? data.buffer : data);
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
    if (!win) throw new Error('Pop-up blocked — allow pop-ups for this site to print');
    win.document.write(`<!DOCTYPE html><html><head><style>@media print{body{margin:0;font-family:'Courier New',monospace;font-size:11px;white-space:pre}}</style></head><body><pre id="r"></pre><script>window.onload=function(){window.print();window.close();}<\/script></html>`);
    win.document.close();
    if (win.document.getElementById('r')) win.document.getElementById('r').textContent = htmlFallback || '';
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
    this._active   = null;
    this._queue    = new PrintQueue();
    this._profile  = this._loadProfile();
    this._cfg      = this._loadCfg();
    this._ev       = {};
    this._busy     = false;
    this._waiters  = {};           /* jobId → { resolve, reject } */
    this._customDocTypes = {};     /* extra doc type renderers */
    this._renderer = null;         /* shared renderer — rebuilt on config change */

    this._queue.on('enqueued', () => this._tick());
    this._queue.on('tick',     () => this._tick());
    this._queue.on('resumed',  () => this._tick());

    /* Multi-tab sync via BroadcastChannel */
    if (typeof BroadcastChannel !== 'undefined') {
      this._bc = new BroadcastChannel('sokoni_printer_v5');
      this._bc.onmessage = (ev) => {
        if (ev.data?.type === 'config_update') {
          this._cfg = { ...this._cfg, ...ev.data.cfg };
        } else if (ev.data?.type === 'queue_invalidate') {
          this._queue._load();
        }
      };
    }
  }

  /* ── Persistence ─────────────────────────────────────────── */
  _loadProfile () {
    try { return JSON.parse(localStorage.getItem('spp_profile') || '{}'); } catch(e) { return {}; }
  }
  _saveProfile () { localStorage.setItem('spp_profile', JSON.stringify(this._profile)); }
  _loadCfg () {
    const defaults = {
      paperWidth: '80mm', autoCut: true, copies: 1,
      autoPrintOnSale: false, autoPrintAfterPayment: false,
      logoText: '', logoUrl: '', footer: '', promoMessage: '',
      returnPolicy: '', showCommission: false, showPreview: false,
      encoding: 'PC437', printDensity: 0, imageThreshold: 128,
    };
    try { return Object.assign({}, defaults, JSON.parse(localStorage.getItem('spp_config') || '{}')); }
    catch(e) { return defaults; }
  }
  _saveCfg () {
    localStorage.setItem('spp_config', JSON.stringify(this._cfg));
    this._bc?.postMessage({ type: 'config_update', cfg: this._cfg });
  }

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
    if (!last) return false;

    /* Bluetooth: getDevices() returns previously-granted devices without a user gesture (Chrome 85+) */
    if (last.type === 'bluetooth' && navigator.bluetooth?.getDevices) {
      try {
        const devices = await navigator.bluetooth.getDevices();
        const matched = devices.find(d => d.name === last.name || d.id === last.id);
        if (!matched) return false;
        await this.connect({ ...last, _dev: matched });
        return true;
      } catch(e) { return false; }
    }

    if (last.type !== 'network' && last.type !== 'browser') return false;
    try { await this.connect(last); return true; } catch(e) { return false; }
  }

  async disconnect () {
    if (this._active) { await this._active.disconnect().catch(()=>{}); this._active = null; }
    this.emit('disconnected', null);
  }

  get connected () { return !!(this._active?.ok); }

  /* ── Capability detection ────────────────────────────────── */
  async detectCapabilities () {
    const caps = {
      paperWidth:    this._cfg.paperWidth || '80mm',
      connectionType: this._active?.type || 'unknown',
      online:         this.connected,
      qrSupport:      true,   // assume ESC/POS standard support
      barcodeSupport: true,
      imageSupport:   true,
      cutterSupport:  true,
      drawerSupport:  false,  // conservative default
      batteryStatus:  null,
      paperOut:       false,
      coverOpen:      false,
      detectedAt:     new Date().toISOString(),
    };

    /* For network printers, try to GET /capabilities */
    if (this._active?.type === 'network' && this._active?._proto === 'http') {
      try {
        const r = await fetch(this._active._ep + '/capabilities', { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
          const data = await r.json();
          Object.assign(caps, data);
        }
      } catch(e) {}
    }

    /* For BT/USB, attempt DLE EOT status probe (many printers respond) */
    if (this.connected && (this._active.type === 'bluetooth' || this._active.type === 'usb')) {
      try {
        const probe = new ESCPOSEncoder().init().statusProbe().build();
        await this._active.write(probe);
        /* Response parsing would require bidirectional reads (printer-specific) */
        /* Mark as probed — actual response parsing left to hardware integration */
        caps.probeAttempted = true;
      } catch(e) {}
    }

    this.setCapabilities(caps);
    this.emit('capabilities', caps);
    return caps;
  }

  /* ── Config / capabilities ───────────────────────────────── */
  setConfig (updates) {
    Object.assign(this._cfg, updates);
    this._renderer = null; /* invalidate cached renderer */
    this._saveCfg();
    return this;
  }
  getConfig ()        { return { ...this._cfg }; }

  _getRenderer () {
    if (!this._renderer) {
      this._renderer = new ReceiptRenderer(this._cfg.paperWidth || '80mm', this._cfg);
      for (const [t, fn] of Object.entries(this._customDocTypes))
        this._renderer.register(t, fn);
    }
    return this._renderer;
  }

  /* ── Custom doc type registration ───────────────────────── */
  registerDocType (docType, renderFn) {
    this._customDocTypes[String(docType)] = renderFn;
    this._renderer = null;
    return this;
  }
  setCapabilities (u) { Object.assign(this._profile, u); this._saveProfile(); return this; }
  getCapabilities ()  { return { ...this._profile }; }

  /* ── Status ──────────────────────────────────────────────── */
  async getStatus () {
    if (!this._active) return { connected: false, online: false };
    try {
      const s = await (this._active.getStatus ? this._active.getStatus() : { online: this._active.ok });
      return { ...s, connected: this._active.ok, transport: this._active.type };
    } catch(e) { return { connected: false, online: false, error: e.message, code: e.code || PRINTER_ERRORS.UNKNOWN }; }
  }

  /* ── Printing ────────────────────────────────────────────── */
  async print (docType, data, options = {}) {
    return this._queue.enqueue(docType, data, { ...options, copies: options.copies || this._cfg.copies || 1 });
  }

  async printNow (docType, data, options = {}) {
    if (!this.connected) throw Object.assign(new Error('No printer connected'), { code: PRINTER_ERRORS.OFFLINE });
    const renderer = this._getRenderer();
    const copies = options.copies || this._cfg.copies || 1;
    for (let c = 0; c < copies; c++) {
      await this._writeRender(renderer, docType, data);
      if (c < copies - 1) await new Promise(r => setTimeout(r, 400));
    }
  }

  async printRaw (bytes) {
    if (!this.connected) throw Object.assign(new Error('No printer connected'), { code: PRINTER_ERRORS.OFFLINE });
    await this._active.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  }

  /* ── Image printing ──────────────────────────────────────── */
  async printImage (src, options = {}) {
    if (!this.connected) throw Object.assign(new Error('No printer connected'), { code: PRINTER_ERRORS.OFFLINE });
    if (typeof document === 'undefined') throw new Error('printImage requires a browser environment');
    const paper = PAPER[this._cfg.paperWidth || '80mm'];
    const maxPx  = options.maxWidthPx || paper.px;
    const thresh = options.threshold  || this._cfg.imageThreshold || 128;
    const { pixels, widthBytes, heightDots } = await _imgToRaster(src, maxPx, thresh);
    const e = new ESCPOSEncoder().init().ac();
    if (options.align === 'left') e.al();
    e.raster(widthBytes, heightDots, pixels);
    if (options.cut !== false && this._cfg.autoCut) e.cut();
    await this._active.write(e.build());
  }

  async openCashDrawer () {
    if (!this.connected) throw Object.assign(new Error('No printer connected'), { code: PRINTER_ERRORS.OFFLINE });
    await this._active.write(new ESCPOSEncoder().init().drawer().build());
  }

  async _writeRender (renderer, docType, data) {
    /* Pre-load logo raster if configured and not already in data */
    const logoUrl = data.logoUrl || this._cfg.logoUrl;
    if (logoUrl && !data._logoRaster && typeof document !== 'undefined') {
      try {
        const paper = PAPER[this._cfg.paperWidth || '80mm'];
        data = { ...data, _logoRaster: await _imgToRasterCached(logoUrl, paper.px, this._cfg.imageThreshold || 128) };
      } catch(e) { /* logo load failed — fall back to text logo */ }
    }

    const commands = renderer.render(docType, data);
    if (this._active?.type === 'browser') {
      const preview = renderer.previewHTML(docType, data);
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
    const renderer = this._getRenderer();
    (async () => {
      for (let c = 0; c < job.copies; c++) {
        await this._writeRender(renderer, job.docType, job.data);
        if (c < job.copies - 1) await new Promise(r => setTimeout(r, 400));
      }
      this._queue.markDone(job);
      this.emit('printed', job);
      this._waiters[job.id]?.resolve(job); delete this._waiters[job.id];
    })()
    .catch(err => {
      const code = err.code || PRINTER_ERRORS.UNKNOWN;
      this._queue.markFailed(job, err.message);
      this.emit('error', { job, error: err.message, code });
      if (job.status === 'failed') {
        this._waiters[job.id]?.reject(Object.assign(new Error(err.message), { code }));
        delete this._waiters[job.id];
      }
    })
    .finally(() => {
      this._busy = false;
      setTimeout(() => this._tick(), 150);
    });
  }

  /* ── Dedicated QR / barcode printing ────────────────────── */
  async printQR (data, options = {}) {
    if (!this.connected) throw Object.assign(new Error('No printer connected'), { code: PRINTER_ERRORS.OFFLINE });
    const size = options.size || 5;
    const e = new ESCPOSEncoder().init().ac().lf();
    if (options.label) e.text(options.label).lf();
    e.qr(String(data), size).lf(2);
    if (this._cfg.autoCut) e.cut();
    await this._active.write(e.build());
  }

  async printBarcode (data, options = {}) {
    if (!this.connected) throw Object.assign(new Error('No printer connected'), { code: PRINTER_ERRORS.OFFLINE });
    const type   = options.type   || 73;
    const height = options.height || 80;
    const width  = options.width  || 2;
    const e = new ESCPOSEncoder().init().ac().lf();
    if (options.label) e.text(options.label).lf();
    e.barcode(String(data), type, height, width).lf().text(String(data)).lf(2);
    if (this._cfg.autoCut) e.cut();
    await this._active.write(e.build());
  }

  /* ── waitForJob ──────────────────────────────────────────── */
  waitForJob (id, timeoutMs = 30_000) {
    const existing = this._queue.getJob(id);
    if (existing?.status === 'done')      return Promise.resolve(existing);
    if (existing?.status === 'failed')    return Promise.reject(new Error(existing.error || 'Job failed'));
    if (existing?.status === 'cancelled') return Promise.reject(new Error('Job cancelled'));
    return new Promise((resolve, reject) => {
      this._waiters[id] = { resolve, reject };
      setTimeout(() => {
        if (this._waiters[id]) {
          delete this._waiters[id];
          reject(new Error('Print job timeout after ' + timeoutMs + 'ms'));
        }
      }, timeoutMs);
    });
  }

  /* ── Queue management ────────────────────────────────────── */
  getQueue    () { return this._queue.jobs(); }
  getHistory  () { return this._queue.history(); }
  getJob      (id) { return this._queue.getJob(id); }
  cancelJob   (id) { this._queue.cancel(id); }
  cancelAllJobs () { this._queue.cancelAll(); }
  clearHistory ()  { this._queue.clearHistory(); }
  retryJob    (id) { this._queue.retry(id); }
  pauseQueue  ()   { this._queue.pause(); }
  resumeQueue ()   { this._queue.resume(); }

  /* ── Preview ─────────────────────────────────────────────── */
  preview (docType, data) {
    return this._getRenderer().previewHTML(docType, data);
  }

  /* ── Test print ──────────────────────────────────────────── */
  async testPrint () {
    await this.printNow('receipt', {
      businessName: this._cfg.logoText || 'SOKONI SmartPOS',
      businessAddress: 'Printer Test — ' + (this._cfg.paperWidth || '80mm'),
      receiptNumber: 'TEST-001',
      cashierName: 'System',
      items: [
        { name: 'Test Item Alpha',      quantity: 1, unitPrice: 1000 },
        { name: 'Test Item Beta',       quantity: 2, unitPrice: 500  },
        { name: '58-Char Width Test ===', quantity: 1, unitPrice: 250  },
      ],
      totals: { subtotal: 2250, vat: 360, grandTotal: 2610 },
      payment: { method: 'Cash', amountTendered: 3000, change: 390 },
      receiptUrl: 'https://mysokoni.co.ke/r/TEST',
    });
  }
}

/* ─────────────────────────────────────────────────────────────────
   SINGLETON + PUBLIC API
───────────────────────────────────────────────────────────────── */
let _inst = null;
function getInstance () { if (!_inst) _inst = new SPEngine(); return _inst; }

const api = {
  getInstance,

  /* Discovery */
  discover:           (...a) => getInstance().discoverAll(...a),
  discoverBy:         (...a) => getInstance().discoverBy(...a),

  /* Connection */
  connect:            (...a) => getInstance().connect(...a),
  disconnect:         (...a) => getInstance().disconnect(...a),
  autoReconnect:      (...a) => getInstance().autoReconnect(...a),
  get connected ()          { return getInstance().connected; },

  /* Status & capabilities */
  getStatus:          (...a) => getInstance().getStatus(...a),
  detectCapabilities: (...a) => getInstance().detectCapabilities(...a),
  getCapabilities:    (...a) => getInstance().getCapabilities(...a),
  setCapabilities:    (...a) => getInstance().setCapabilities(...a),

  /* Config */
  setConfig:          (...a) => getInstance().setConfig(...a),
  getConfig:          (...a) => getInstance().getConfig(...a),

  /* Printing */
  print:              (...a) => getInstance().print(...a),
  printNow:           (...a) => getInstance().printNow(...a),
  printRaw:           (...a) => getInstance().printRaw(...a),
  printImage:         (...a) => getInstance().printImage(...a),
  printQR:            (...a) => getInstance().printQR(...a),
  printBarcode:       (...a) => getInstance().printBarcode(...a),
  openCashDrawer:     (...a) => getInstance().openCashDrawer(...a),
  testPrint:          (...a) => getInstance().testPrint(...a),
  preview:            (...a) => getInstance().preview(...a),

  /* Extensibility */
  registerDocType:    (...a) => getInstance().registerDocType(...a),

  /* Queue */
  getQueue:           (...a) => getInstance().getQueue(...a),
  getHistory:         (...a) => getInstance().getHistory(...a),
  getJob:             (...a) => getInstance().getJob(...a),
  waitForJob:         (...a) => getInstance().waitForJob(...a),
  cancelJob:          (...a) => getInstance().cancelJob(...a),
  cancelAllJobs:      (...a) => getInstance().cancelAllJobs(...a),
  clearHistory:       (...a) => getInstance().clearHistory(...a),
  retryJob:           (...a) => getInstance().retryJob(...a),
  pauseQueue:         (...a) => getInstance().pauseQueue(...a),
  resumeQueue:        (...a) => getInstance().resumeQueue(...a),

  /* Events */
  on:                 (...a) => getInstance().on(...a),
  off:                (...a) => getInstance().off(...a),

  /* Network printer helpers */
  saveNetworkPrinter:   NetworkAdapter.save,
  removeNetworkPrinter: NetworkAdapter.remove,

  /* Exposed for extension */
  ESCPOSEncoder,
  ReceiptRenderer,
  NetworkAdapter,
  PAPER_WIDTHS:  PAPER,
  ERRORS:        PRINTER_ERRORS,
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.SokoniPrinter = api;

})(typeof window !== 'undefined' ? window : global);
