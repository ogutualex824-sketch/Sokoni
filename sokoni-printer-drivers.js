/* ================================================================
   SOKONI Printer Driver Library v2.0
   ESC/POS, TSPL, ZPL, CPCL — auto-detect by printer model/name
================================================================ */
window.SokoniPrinterDrivers = (() => {
  'use strict';

  /* ── ESC/POS command constants ── */
  const ESC = 0x1B, GS = 0x1D, FS = 0x1C, DLE = 0x10;
  const LF  = 0x0A, CR = 0x0D, HT = 0x09, NUL = 0x00;

  /* ── Base byte buffer builder ── */
  function Buf() {
    const buf = [];
    const push = (...args) => {
      for (const a of args) {
        if (typeof a === 'number') buf.push(a);
        else if (a instanceof Uint8Array || Array.isArray(a)) buf.push(...a);
        else if (typeof a === 'string') {
          const encoded = new TextEncoder().encode(a);
          buf.push(...encoded);
        }
      }
    };
    return {
      push,
      get bytes() { return new Uint8Array(buf); },
    };
  }

  /* ── Text encoder ── */
  const ENC = new TextEncoder();
  const encode = s => ENC.encode(String(s || ''));

  /* ================================================================
     ESC/POS Driver — works with 58mm/80mm thermal receipt printers
     Tested with: Epson TM-T88, Star TSP100, Sunmi, Xprinter, HOIN
  ================================================================ */
  const ESCPOSDriver = {
    name: 'escpos',

    /* ── Core commands ── */
    init()         { return new Uint8Array([ESC, 0x40]); },
    cut(full=true) { return new Uint8Array([GS, 0x56, full ? 0x00 : 0x01]); },
    feed(n=3)      { return new Uint8Array([ESC, 0x64, Math.min(n, 255)]); },
    lf()           { return new Uint8Array([LF]); },

    /* ── Text styling ── */
    bold(on)   { return new Uint8Array([ESC, 0x45, on ? 0x01 : 0x00]); },
    underline(n=1) { return new Uint8Array([ESC, 0x2D, n]); },
    align(a)   {
      const m = { left: 0x00, center: 0x01, right: 0x02 };
      return new Uint8Array([ESC, 0x61, m[a] || 0x00]);
    },
    doubleWidth(on)  { return new Uint8Array([ESC, 0x0E, on ? 1 : 0]); },
    doubleHeight(on) { return new Uint8Array([GS, 0x21, on ? 0x01 : 0x00]); },
    fontSize(n) {
      /* n: 0=normal, 1=double-width, 2=double-height, 3=double-both */
      const map = [0x00, 0x10, 0x01, 0x11];
      return new Uint8Array([GS, 0x21, map[n] || 0x00]);
    },
    charset(n=0) { return new Uint8Array([ESC, 0x74, n]); },

    /* ── Barcode printing ── */
    barcodeHeight(h=80)      { return new Uint8Array([GS, 0x68, Math.min(h, 255)]); },
    barcodeWidth(w=3)        { return new Uint8Array([GS, 0x77, Math.min(Math.max(w, 2), 6)]); },
    barcodeHRI(pos=2)        { return new Uint8Array([GS, 0x48, pos]); }, /* 0=none,1=above,2=below */
    barcode(type, data) {
      /* type: 'EAN13','EAN8','UPCA','UPCE','CODE39','CODE93','CODE128','ITF' */
      const b = Buf();
      b.push(this.barcodeHeight(80));
      b.push(this.barcodeWidth(3));
      b.push(this.barcodeHRI(2));
      b.push(this.align('center'));

      switch (type.toUpperCase()) {
        case 'EAN13': {
          const d = encode(data.slice(0,12));
          b.push(GS, 0x6B, 0x02, ...d, NUL);
          break;
        }
        case 'EAN8': {
          const d = encode(data.slice(0,7));
          b.push(GS, 0x6B, 0x03, ...d, NUL);
          break;
        }
        case 'UPCA': {
          const d = encode(data.slice(0,11));
          b.push(GS, 0x6B, 0x00, ...d, NUL);
          break;
        }
        case 'CODE39': {
          const d = encode(data);
          b.push(GS, 0x6B, 0x04, ...d, NUL);
          break;
        }
        case 'ITF': {
          const d = encode(data);
          b.push(GS, 0x6B, 0x05, ...d, NUL);
          break;
        }
        case 'CODE93': {
          const d = encode(data);
          b.push(GS, 0x6B, 0x48, d.length, ...d);
          break;
        }
        case 'CODE128':
        default: {
          /* {B prefix selects full ASCII character set */
          const payload = '{B' + data;
          const d = encode(payload);
          b.push(GS, 0x6B, 0x49, d.length, ...d);
          break;
        }
      }
      b.push(this.align('left'));
      return b.bytes;
    },

    /* ── QR Code (GS ( k) ── */
    qr(data, size=6, ecLevel='M') {
      const ecMap = { L: 48, M: 49, Q: 50, H: 51 };
      const ec    = ecMap[ecLevel] || 49;
      const d     = encode(data);
      const dLen  = d.length + 3;
      const b     = Buf();
      b.push(this.align('center'));
      /* Model, size, error correction */
      b.push(GS, 0x28, 0x6B, 4, 0, 49, 65, 50, 0);
      b.push(GS, 0x28, 0x6B, 3, 0, 49, 67, Math.min(Math.max(size, 1), 16));
      b.push(GS, 0x28, 0x6B, 3, 0, 49, 69, ec);
      /* Store data */
      b.push(GS, 0x28, 0x6B, dLen & 0xFF, (dLen >> 8) & 0xFF, 49, 80, 48, ...d);
      /* Print */
      b.push(GS, 0x28, 0x6B, 3, 0, 49, 81, 48);
      b.push(this.align('left'));
      return b.bytes;
    },

    /* ── Logo / raster image (ESC * bitmap) ── */
    logoBytes(canvas) {
      /* canvas: HTMLCanvasElement (already greyscale, 1-bit dithered) */
      if (!canvas) return new Uint8Array(0);
      const ctx = canvas.getContext('2d');
      const w   = canvas.width;
      const h   = canvas.height;
      const img = ctx.getImageData(0, 0, w, h);
      const b   = Buf();
      b.push(this.align('center'));
      /* ESC * mode nL nH [data] */
      const mode = 33; /* 24-dot double-density */
      for (let y = 0; y < h; y += 24) {
        b.push(ESC, 0x2A, mode, w & 0xFF, (w >> 8) & 0xFF);
        for (let x = 0; x < w; x++) {
          for (let row = 0; row < 3; row++) {
            let byte = 0;
            for (let bit = 0; bit < 8; bit++) {
              const py = y + row * 8 + bit;
              if (py < h) {
                const idx = (py * w + x) * 4;
                const lum = 0.299 * img.data[idx] + 0.587 * img.data[idx+1] + 0.114 * img.data[idx+2];
                if (lum < 128) byte |= (1 << (7 - bit));
              }
            }
            b.push(byte);
          }
        }
        b.push(LF);
      }
      b.push(this.align('left'));
      return b.bytes;
    },

    /* ── Cash drawer ── */
    drawerKick(pin=0) {
      return new Uint8Array([ESC, 0x70, pin, 0x19, 0xFA]);
    },

    /* ── Full receipt builder ── */
    buildReceipt(job, settings = {}) {
      const d    = job.data || {};
      const cols = (settings.paperWidth || d.paperWidth || 80) >= 80 ? 48 : 32;
      const b    = Buf();

      const line  = (s='')         => b.push(encode(String(s).slice(0, cols)), LF);
      const sep   = (c='-')        => line(c.repeat(cols));
      const ctrS  = s => {
        const t = String(s || '');
        const p = Math.max(0, Math.floor((cols - t.length) / 2));
        return ' '.repeat(p) + t;
      };
      const ctr = s => line(ctrS(s));
      const twoCol = (l, r) => {
        const ls = String(l || ''), rs = String(r || '');
        const sp = Math.max(1, cols - ls.length - rs.length);
        line(ls + ' '.repeat(sp) + rs);
      };
      const money = n => 'KES ' + Number(n || 0).toFixed(2);

      /* Init */
      b.push(this.init());
      b.push(this.charset(18)); /* PC858 — handles KES sign */

      /* Logo */
      if (settings.logoCanvas) b.push(this.logoBytes(settings.logoCanvas));

      /* Header */
      b.push(this.align('center'), this.bold(true), this.fontSize(1));
      ctr(d.shopName || d.businessName || settings.shopName || 'SOKONI');
      b.push(this.fontSize(0), this.bold(false));
      if (d.shopAddress || settings.shopAddress) ctr(d.shopAddress || settings.shopAddress);
      if (d.shopPhone   || settings.shopPhone)   ctr(d.shopPhone   || settings.shopPhone);
      if (d.shopPin     || settings.shopPin)     ctr('PIN: ' + (d.shopPin || settings.shopPin));
      b.push(this.align('left'));
      sep();

      /* Receipt meta */
      const ts = new Date(d.timestamp || Date.now());
      const dateStr = ts.toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' });
      const timeStr = ts.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
      twoCol('Date: ' + dateStr, 'Time: ' + timeStr);
      if (d.receiptNo)    line('Receipt #: ' + d.receiptNo);
      if (d.cashierName)  line('Cashier:   ' + d.cashierName);
      if (d.customerName) line('Customer:  ' + d.customerName);
      sep();

      /* Items */
      line('ITEM                     QTY    AMOUNT');
      sep();
      (d.items || []).forEach(item => {
        const name  = String(item.name || '').slice(0, cols - 12);
        const qty   = String(item.qty || 1);
        const total = money(item.price * item.qty);
        /* Item name */
        line(name);
        /* Qty + price on right */
        const unitStr = money(item.price) + ' x' + qty;
        twoCol('  ' + unitStr, total);
        if (item.sku)     line('  SKU: ' + item.sku);
        if (item.barcode) line('  BC:  ' + item.barcode);
      });
      sep();

      /* Totals */
      b.push(this.align('right'));
      if (d.subtotal !== undefined)      { b.push(this.align('left')); twoCol('Subtotal:', money(d.subtotal)); }
      if (d.discountAmount)              { b.push(this.align('left')); twoCol('Discount:', '-' + money(d.discountAmount)); }
      if (d.taxRate && d.taxAmount)      { b.push(this.align('left')); twoCol(`Tax (${d.taxRate}% VAT):`, money(d.taxAmount)); }
      sep();
      b.push(this.align('left'), this.bold(true), this.fontSize(1));
      twoCol('TOTAL:', money(d.total));
      b.push(this.fontSize(0), this.bold(false));
      sep();

      /* Payment */
      if (d.paymentMethod) { line('Payment:  ' + String(d.paymentMethod).toUpperCase()); }
      if (d.mpesaCode)     { line('M-Pesa:   ' + d.mpesaCode); }
      if (d.amountPaid)    { twoCol('Paid:', money(d.amountPaid)); }
      if (d.change)        { twoCol('Change:', money(d.change)); }

      /* eTIMS block */
      if (d.etimsInvoiceNo || d.etimsQR) {
        sep('=');
        b.push(this.align('center'));
        ctr('KRA TAX INVOICE');
        b.push(this.align('left'));
        if (d.etimsInvoiceNo) line('Invoice No: ' + d.etimsInvoiceNo);
        if (d.etimsCode)      line('Verify:     ' + d.etimsCode);
        if (d.etimsQR) {
          b.push(this.align('center'));
          b.push(this.qr(d.etimsQR, 4));
          b.push(this.align('left'));
        }
        sep('=');
      }

      /* QR code (website / order) */
      if (settings.showQR && d.qrData) {
        b.push(this.align('center'));
        ctr('Scan to view order');
        b.push(this.qr(d.qrData, 5));
        b.push(this.align('left'));
      }

      /* Footer */
      sep();
      b.push(this.align('center'));
      ctr(d.footerMessage || settings.footerMessage || 'Thank you for shopping with us!');
      ctr('mysokoni.co.ke');
      b.push(this.align('left'));

      /* Feed and cut */
      b.push(this.feed(4));
      if (settings.autoCut !== false) b.push(this.cut());

      return b.bytes;
    },

    /* ── Kitchen receipt (simplified, larger text) ── */
    buildKitchenReceipt(job, settings = {}) {
      const d    = job.data || {};
      const cols = (settings.paperWidth || 80) >= 80 ? 48 : 32;
      const b    = Buf();
      const line = s => b.push(encode(String(s || '').slice(0, cols)), LF);
      const sep  = () => line('='.repeat(cols));

      b.push(this.init(), this.bold(true), this.fontSize(1));
      line('** KITCHEN ORDER **');
      b.push(this.fontSize(0));
      sep();
      line('Order: ' + (d.receiptNo || d.orderNo || ''));
      line('Time:  ' + new Date(d.timestamp || Date.now()).toLocaleTimeString());
      if (d.tableName || d.tableNo) line('Table: ' + (d.tableName || d.tableNo));
      if (d.customerName) line('Cust:  ' + d.customerName);
      sep();
      (d.items || []).filter(i => !i.skipKitchen).forEach(item => {
        b.push(this.fontSize(1), this.bold(true));
        line(item.qty + 'x ' + String(item.name || '').slice(0, cols - 4));
        b.push(this.fontSize(0), this.bold(false));
        if (item.notes)     line('   NOTE: ' + item.notes);
        if (item.modifiers) item.modifiers.forEach(m => line('   + ' + m));
      });
      sep();
      if (d.kitchenNotes) { b.push(this.bold(true)); line('NOTES: ' + d.kitchenNotes); b.push(this.bold(false)); }
      b.push(this.feed(3));
      if (settings.autoCut !== false) b.push(this.cut());
      return b.bytes;
    },

    build(job, settings) {
      if (job.type === 'kitchen') return this.buildKitchenReceipt(job, settings);
      if (job.type === 'label' || job.type === 'barcode') return new Uint8Array(0); /* handled by label engine */
      return this.buildReceipt(job, settings);
    },
  };

  /* ================================================================
     TSPL Driver — TSC label printers (T200, TTP-244, etc.)
     Commands are ASCII text, terminated with \r\n
  ================================================================ */
  const TSPLDriver = {
    name: 'tspl',

    cmd(...parts) {
      return new TextEncoder().encode(parts.join(' ') + '\r\n');
    },

    buildLabel(job, settings = {}) {
      const d    = job.data || {};
      const opts = d.labelOpts || {};
      const w    = opts.widthMM  || 40;  /* label width mm */
      const h    = opts.heightMM || 30;  /* label height mm */
      const gap  = opts.gapMM   || 3;
      const b    = Buf();

      const cmd = (...parts) => b.push(this.cmd(...parts));

      /* Label setup */
      cmd('SIZE', `${w} mm,${h} mm`);
      cmd('GAP', `${gap} mm,0 mm`);
      cmd('DIRECTION', opts.direction || '0');
      cmd('REFERENCE', '0,0');
      cmd('OFFSET', '0 mm');
      cmd('SET PEEL OFF');
      cmd('SET TEAR OFF');
      cmd('CLS');

      /* Items */
      let y = 10;
      (d.items || [d]).forEach(item => {
        if (!item || !item.name) return;

        /* Product name */
        cmd('TEXT', `10,${y},"3",0,1,1,"${this._escape(item.name.slice(0, 20))}"`);
        y += 28;

        /* Price */
        if (item.price !== undefined) {
          cmd('TEXT', `10,${y},"3",0,1,1,"KES ${Number(item.price).toFixed(2)}"`);
          y += 28;
        }

        /* Barcode */
        if (opts.showBarcode !== false && item.barcode) {
          const bcType = opts.barcodeType || 'CODE128';
          cmd('BARCODE', `10,${y},"${bcType}",60,1,0,2,2,"${this._escape(item.barcode)}"`);
          y += 80;
        }

        /* QR code */
        if (opts.showQR && (item.qr || item.url)) {
          cmd('QRCODE', `10,${y},L,3,A,0,"${this._escape(item.qr || item.url)}"`);
          y += 80;
        }

        /* Shop name / footer */
        if (opts.showShop && (item.shopName || settings.shopName)) {
          cmd('TEXT', `10,${y},"2",0,1,1,"${this._escape(item.shopName || settings.shopName)}"`);
          y += 24;
        }
      });

      cmd('PRINT', String(job.copies || 1) + ',1');
      return b.bytes;
    },

    _escape(s) {
      return String(s || '').replace(/"/g, "'");
    },

    build(job, settings) { return this.buildLabel(job, settings); },
  };

  /* ================================================================
     ZPL Driver — Zebra label printers (ZT230, GK420, ZD220, etc.)
  ================================================================ */
  const ZPLDriver = {
    name: 'zpl',

    buildLabel(job, settings = {}) {
      const d    = job.data || {};
      const opts = d.labelOpts || {};
      const dpi  = opts.dpi || 203;    /* dots per mm */
      const wMM  = opts.widthMM  || 40;
      const hMM  = opts.heightMM || 30;
      const wDots = Math.round(wMM * dpi / 25.4);
      const hDots = Math.round(hMM * dpi / 25.4);
      const lines = [];

      const mm2d = mm => Math.round(mm * dpi / 25.4);

      lines.push('^XA');
      lines.push(`^PW${wDots}`);       /* Label width */
      lines.push(`^LL${hDots}`);       /* Label height */
      lines.push('^CI28');             /* UTF-8 character set */

      let y = mm2d(3);
      (d.items || [d]).forEach(item => {
        if (!item || !item.name) return;

        /* Product name */
        const fsize = Math.max(20, Math.min(40, mm2d(4)));
        lines.push(`^FO${mm2d(2)},${y}^A0N,${fsize},${fsize}^FD${this._escape(item.name.slice(0,24))}^FS`);
        y += fsize + mm2d(2);

        /* Price */
        if (item.price !== undefined) {
          lines.push(`^FO${mm2d(2)},${y}^A0N,${fsize},${fsize}^FDKES ${Number(item.price).toFixed(2)}^FS`);
          y += fsize + mm2d(2);
        }

        /* Barcode */
        if (opts.showBarcode !== false && item.barcode) {
          const bcHeight = mm2d(10);
          lines.push(`^FO${mm2d(2)},${y}^BY2^BCN,${bcHeight},Y,N,N^FD${this._escape(item.barcode)}^FS`);
          y += bcHeight + mm2d(2);
        }

        /* QR */
        if (opts.showQR && (item.qr || item.url)) {
          const qrSize = Math.max(3, Math.min(10, mm2d(1)));
          lines.push(`^FO${mm2d(2)},${y}^BQN,2,${qrSize}^FDQA,${this._escape(item.qr || item.url)}^FS`);
          y += qrSize * 20 + mm2d(2);
        }
      });

      lines.push(`^PQ${job.copies || 1},0,1,Y`);
      lines.push('^XZ');

      return new TextEncoder().encode(lines.join('\n') + '\n');
    },

    _escape(s) { return String(s || '').replace(/[\\^]/g, ''); },

    build(job, settings) { return this.buildLabel(job, settings); },
  };

  /* ================================================================
     CPCL Driver — Honeywell/Intermec (PC43, PM4) label printers
  ================================================================ */
  const CPCLDriver = {
    name: 'cpcl',

    buildLabel(job, settings = {}) {
      const d    = job.data || {};
      const opts = d.labelOpts || {};
      const lines = [];

      lines.push(`! 0 200 200 400 1`);  /* header: offset dpi dpi height copies */
      lines.push('JOURNAL');
      lines.push('CENTER');

      let y = 10;
      (d.items || [d]).forEach(item => {
        if (!item || !item.name) return;
        lines.push(`TEXT 7 0 10 ${y} ${this._escape(item.name.slice(0,20))}`);
        y += 30;
        if (item.price !== undefined) {
          lines.push(`TEXT 7 0 10 ${y} KES ${Number(item.price).toFixed(2)}`);
          y += 30;
        }
        if (opts.showBarcode !== false && item.barcode) {
          lines.push(`LEFT`);
          lines.push(`BARCODE CODE128 1 1 50 10 ${y} ${this._escape(item.barcode)}`);
          y += 70;
          lines.push('CENTER');
        }
      });

      lines.push('FORM');
      lines.push('PRINT');

      return new TextEncoder().encode(lines.join('\n') + '\n');
    },

    _escape(s) { return String(s || '').replace(/[^A-Za-z0-9 .,\-/:()]/g, ''); },

    build(job, settings) { return this.buildLabel(job, settings); },
  };

  /* ================================================================
     Language Detector — auto-select driver by printer model/name
  ================================================================ */
  const TSPL_KEYWORDS = ['TSC','TTP','T200','T800','TC200','TC300','DA210','DA220','DH220','DH320','TSP','GODEX','BIXOLON'];
  const ZPL_KEYWORDS  = ['ZEBRA','ZT','ZD','GK','GX','GT','LP2844','ZM','ZP','ELTRON','HONEYWELL ZD'];
  const CPCL_KEYWORDS = ['HONEYWELL','INTERMEC','PM4','PC43','PC23','PX4','PX6','PB50','PB51'];

  function detectLanguage(printerName = '') {
    const u = printerName.toUpperCase();
    if (TSPL_KEYWORDS.some(k => u.includes(k))) return 'tspl';
    if (ZPL_KEYWORDS.some(k => u.includes(k)))  return 'zpl';
    if (CPCL_KEYWORDS.some(k => u.includes(k))) return 'cpcl';
    return 'escpos';
  }

  function getDriver(language) {
    switch ((language || 'escpos').toLowerCase()) {
      case 'tspl': return TSPLDriver;
      case 'zpl':  return ZPLDriver;
      case 'cpcl': return CPCLDriver;
      default:     return ESCPOSDriver;
    }
  }

  function getDriverForPrinter(printer) {
    const lang = printer.driver === 'auto'
      ? detectLanguage(printer.name)
      : (printer.driver || 'escpos');
    return getDriver(lang);
  }

  return {
    ESCPOSDriver,
    TSPLDriver,
    ZPLDriver,
    CPCLDriver,
    detectLanguage,
    getDriver,
    getDriverForPrinter,
  };
})();
