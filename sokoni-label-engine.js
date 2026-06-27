/* ================================================================
   SOKONI Label Engine v2.0
   Barcode + QR + label generation for 58mm–100mm printers
   Supports: TSPL, ZPL, ESC/POS barcode commands
   Label sizes: 30×20, 40×30, 50×30, 60×40, 70×50, 100×100, custom
================================================================ */
/* global SokoniPrinterDrivers, SokoniPosprint */
window.SokoniLabelEngine = (() => {
  'use strict';

  /* ── Preset label sizes (mm) ── */
  const SIZES = {
    '30x20':  { w: 30,  h: 20,  gap: 2, name: '30×20 mm (small tag)' },
    '40x30':  { w: 40,  h: 30,  gap: 3, name: '40×30 mm (price tag)' },
    '50x30':  { w: 50,  h: 30,  gap: 3, name: '50×30 mm (product)' },
    '60x40':  { w: 60,  h: 40,  gap: 3, name: '60×40 mm (barcode)' },
    '70x50':  { w: 70,  h: 50,  gap: 3, name: '70×50 mm (shipping)' },
    '100x100':{ w: 100, h: 100, gap: 4, name: '100×100 mm (square)' },
    '100x150':{ w: 100, h: 150, gap: 4, name: '100×150 mm (parcel)' },
  };

  /* ── Barcode type definitions ── */
  const BARCODE_TYPES = {
    'EAN13':      { tspl: 'EAN13',   zpl: '^BEN',  escpos: 0x02, len: 12, desc: 'EAN-13 (retail)' },
    'EAN8':       { tspl: 'EAN8',    zpl: '^BE8',  escpos: 0x03, len: 7,  desc: 'EAN-8 (compact)' },
    'UPCA':       { tspl: 'UPCA',    zpl: '^BUA',  escpos: 0x00, len: 11, desc: 'UPC-A (North America)' },
    'UPCE':       { tspl: 'UPCE',    zpl: '^BUE',  escpos: 0x01, len: 7,  desc: 'UPC-E (compact)' },
    'CODE128':    { tspl: 'CODE128', zpl: '^BCN',  escpos: 0x49, len: 0,  desc: 'Code 128 (alphanumeric)' },
    'CODE39':     { tspl: 'CODE39',  zpl: '^B3N',  escpos: 0x04, len: 0,  desc: 'Code 39 (industrial)' },
    'ITF':        { tspl: 'ITF14',   zpl: '^BIN',  escpos: 0x05, len: 0,  desc: 'ITF-14 (logistics)' },
    'QR':         { tspl: 'QRCODE', zpl: '^BQN',  escpos: 'qr', len: 0,  desc: 'QR Code (URL, text)' },
    'DATAMATRIX': { tspl: 'DMATRIX',zpl: '^BXN',  escpos: null, len: 0,  desc: 'Data Matrix' },
    'PDF417':     { tspl: 'PDF417', zpl: '^BPN',  escpos: null, len: 0,  desc: 'PDF417 (high-capacity)' },
  };

  /* ── Barcode validation ── */
  function validate(type, data) {
    const def = BARCODE_TYPES[type];
    if (!def) return { ok: false, error: 'Unknown barcode type: ' + type };
    if (def.len > 0 && String(data).replace(/\D/g,'').length < def.len) {
      return { ok: false, error: `${type} requires at least ${def.len} digits` };
    }
    return { ok: true };
  }

  /* ── EAN-13 checksum calculator ── */
  function ean13Checksum(data12) {
    const d = String(data12).replace(/\D/g, '').slice(0, 12).padEnd(12, '0');
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += parseInt(d[i]) * (i % 2 === 0 ? 1 : 3);
    return String((10 - (sum % 10)) % 10);
  }

  function ean8Checksum(data7) {
    const d = String(data7).replace(/\D/g, '').slice(0, 7).padEnd(7, '0');
    let sum = 0;
    for (let i = 0; i < 7; i++) sum += parseInt(d[i]) * (i % 2 === 0 ? 3 : 1);
    return String((10 - (sum % 10)) % 10);
  }

  function addChecksum(type, data) {
    switch (type) {
      case 'EAN13': {
        const d12 = String(data).replace(/\D/g,'').slice(0,12).padEnd(12,'0');
        return d12 + ean13Checksum(d12);
      }
      case 'EAN8': {
        const d7 = String(data).replace(/\D/g,'').slice(0,7).padEnd(7,'0');
        return d7 + ean8Checksum(d7);
      }
      default: return String(data);
    }
  }

  /* ── TSPL label byte generator ── */
  function buildTSPL(items, opts = {}) {
    const size   = SIZES[opts.size] || SIZES['40x30'];
    const w      = opts.w  || size.w;
    const h      = opts.h  || size.h;
    const gap    = opts.gap || size.gap;
    const copies = opts.copies || 1;
    const dpi    = opts.dpi || 203;

    const lines = [];
    const cmd = (...parts) => lines.push(parts.join(' '));

    /* Label setup */
    cmd('SIZE', `${w} mm,${h} mm`);
    cmd('GAP', `${gap} mm,0 mm`);
    cmd('DIRECTION', opts.direction || '0');
    cmd('REFERENCE', '0,0');
    cmd('OFFSET', '0 mm');
    cmd('SET CUTTER OFF');
    cmd('SET PEEL OFF');
    cmd('SET TEAR OFF');
    cmd('CLS');

    /* Items */
    let y = opts.marginTop || 6;
    (Array.isArray(items) ? items : [items]).forEach(item => {
      if (!item) return;

      /* Shop / brand name (small) */
      if (opts.showShop && (item.shopName || opts.shopName)) {
        cmd('TEXT', `8,${y},"1",0,1,1,"${_esc(item.shopName || opts.shopName)}"`);
        y += 16;
      }

      /* Product name */
      const name = String(item.name || '').slice(0, 24);
      const fontH = Math.max(16, Math.min(30, Math.round(dpi * 0.12)));
      cmd('TEXT', `8,${y},"3",0,1,1,"${_esc(name)}"`);
      y += fontH + 4;

      /* Variant/SKU */
      if (item.variant || item.sku) {
        cmd('TEXT', `8,${y},"1",0,1,1,"${_esc(item.variant || ('SKU: ' + item.sku))}"`);
        y += 16;
      }

      /* Price — large */
      if (item.price !== undefined && opts.showPrice !== false) {
        const priceStr = 'KES ' + Number(item.price).toFixed(2);
        cmd('TEXT', `8,${y},"4",0,1,1,"${_esc(priceStr)}"`);
        y += 28;
      }

      /* Expiry / date */
      if (item.expiry || item.date) {
        cmd('TEXT', `8,${y},"1",0,1,1,"${_esc('EXP: ' + (item.expiry || item.date))}"`);
        y += 16;
      }

      /* Barcode */
      if (item.barcode && opts.showBarcode !== false) {
        const bcType = opts.barcodeType || 'CODE128';
        const bc     = addChecksum(bcType, item.barcode);
        const bcH    = opts.barcodeHeight || 40;
        cmd('BARCODE', `8,${y},"${bcType}",${bcH},1,0,2,2,"${_esc(bc)}"`);
        y += bcH + 8;
      }

      /* QR code */
      if ((item.qr || item.url || item.barcode) && opts.showQR) {
        const qrData = item.qr || item.url || item.barcode;
        const qrSize = opts.qrSize || 3;
        cmd('QRCODE', `8,${y},L,${qrSize},A,0,"${_esc(qrData)}"`);
        y += qrSize * 20 + 8;
      }

      /* Serial number */
      if (item.serial) {
        cmd('TEXT', `8,${y},"1",0,1,1,"${_esc('S/N: ' + item.serial)}"`);
        y += 16;
      }
    });

    cmd('PRINT', `${copies},1`);

    return new TextEncoder().encode(lines.join('\r\n') + '\r\n');
  }

  /* ── ZPL label byte generator ── */
  function buildZPL(items, opts = {}) {
    const size = SIZES[opts.size] || SIZES['40x30'];
    const w    = opts.w  || size.w;
    const h    = opts.h  || size.h;
    const dpi  = opts.dpi || 203;
    const mm2d = mm => Math.round(mm * dpi / 25.4);

    const lines = [];
    lines.push('^XA');
    lines.push(`^PW${mm2d(w)}`);
    lines.push(`^LL${mm2d(h)}`);
    lines.push('^CI28');  /* UTF-8 */
    lines.push('^MMT');   /* tear mode */
    lines.push('^MNM');   /* media non-continuous */

    let y = mm2d(3);
    const x0 = mm2d(2);

    (Array.isArray(items) ? items : [items]).forEach(item => {
      if (!item) return;

      /* Shop name */
      if (opts.showShop && (item.shopName || opts.shopName)) {
        lines.push(`^FO${x0},${y}^A0N,14,14^FD${_escZPL(item.shopName||opts.shopName)}^FS`);
        y += 18;
      }

      /* Product name */
      const fs = Math.max(20, Math.min(36, mm2d(3)));
      lines.push(`^FO${x0},${y}^A0N,${fs},${fs}^FD${_escZPL(String(item.name||'').slice(0,24))}^FS`);
      y += fs + mm2d(1);

      /* Variant / SKU */
      if (item.variant || item.sku) {
        lines.push(`^FO${x0},${y}^A0N,14,14^FD${_escZPL(item.variant||('SKU:'+item.sku))}^FS`);
        y += 18;
      }

      /* Price */
      if (item.price !== undefined && opts.showPrice !== false) {
        const ps = Math.max(24, mm2d(4));
        lines.push(`^FO${x0},${y}^A0N,${ps},${ps}^FDKES ${Number(item.price).toFixed(2)}^FS`);
        y += ps + mm2d(1);
      }

      /* Barcode */
      if (item.barcode && opts.showBarcode !== false) {
        const bcDef = BARCODE_TYPES[opts.barcodeType || 'CODE128'];
        const bcH   = mm2d(opts.barcodeHeightMM || 10);
        const bc    = addChecksum(opts.barcodeType || 'CODE128', item.barcode);
        const zplCmd = bcDef ? bcDef.zpl : '^BCN';
        lines.push(`^FO${x0},${y}^BY2${zplCmd},${bcH},Y,N,N^FD${_escZPL(bc)}^FS`);
        y += bcH + mm2d(2);
      }

      /* QR */
      if ((item.qr || item.url) && opts.showQR) {
        const qrMag = opts.qrSize || 3;
        lines.push(`^FO${x0},${y}^BQN,2,${qrMag}^FDQA,${_escZPL(item.qr||item.url)}^FS`);
        y += qrMag * 20 + mm2d(2);
      }
    });

    lines.push(`^PQ${opts.copies || 1},0,1,Y`);
    lines.push('^XZ');

    return new TextEncoder().encode(lines.join('\n') + '\n');
  }

  /* ── ESC/POS label (thermal receipt printer, small labels) ── */
  function buildESCPOS(items, opts = {}) {
    if (!window.SokoniPrinterDrivers) return new Uint8Array(0);
    const drv = SokoniPrinterDrivers.ESCPOSDriver;
    const b   = [];
    const push = bytes => b.push(...bytes);

    push(drv.init());
    push(drv.charset(18));

    (Array.isArray(items) ? items : [items]).forEach(item => {
      if (!item) return;

      push(drv.align('center'));

      /* Product name */
      push(drv.bold(true));
      push(new TextEncoder().encode(String(item.name || '').slice(0, 32)));
      push([0x0A]);
      push(drv.bold(false));

      /* Price */
      if (item.price !== undefined && opts.showPrice !== false) {
        push(drv.fontSize(0x11)); /* double size */
        push(new TextEncoder().encode('KES ' + Number(item.price).toFixed(2)));
        push([0x0A]);
        push(drv.fontSize(0));
      }

      /* Barcode */
      if (item.barcode && opts.showBarcode !== false) {
        push(drv.barcodeHeight(60));
        push(drv.barcodeWidth(3));
        push(drv.barcodeHRI(2));
        const bc = addChecksum(opts.barcodeType || 'CODE128', item.barcode);
        push(drv.barcode(opts.barcodeType || 'CODE128', bc));
        push([0x0A]);
      }

      /* QR */
      if ((item.qr || item.url) && opts.showQR) {
        push(drv.qr(item.qr || item.url, opts.qrSize || 5));
        push([0x0A]);
      }

      /* Feed between labels */
      push(drv.feed(2));
      if (opts.cutBetween) push(drv.cut(false)); /* partial cut */
    });

    push(drv.align('left'));
    push(drv.feed(3));
    push(drv.cut());

    return new Uint8Array(b);
  }

  /* ── HTML label builder (browser print) ── */
  function buildHTML(items, opts = {}) {
    const size  = SIZES[opts.size] || SIZES['40x30'];
    const w     = opts.w  || size.w;
    const h     = opts.h  || size.h;
    const itemArr = Array.isArray(items) ? items : [items];

    const _e = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    const cards = itemArr.map(item => `
      <div class="label">
        ${opts.showShop&&(item.shopName||opts.shopName)?`<div class="shop">${_e(item.shopName||opts.shopName)}</div>`:''}
        <div class="name">${_e(String(item.name||'').slice(0,22))}</div>
        ${item.variant?`<div class="sub">${_e(item.variant)}</div>`:''}
        ${item.price!==undefined&&opts.showPrice!==false?`<div class="price">KES ${Number(item.price).toFixed(2)}</div>`:''}
        ${item.expiry?`<div class="sub">EXP: ${_e(item.expiry)}</div>`:''}
        ${item.barcode&&opts.showBarcode!==false?`<div class="bc">${_e(item.barcode)}</div>`:''}
        ${item.serial?`<div class="sub">S/N: ${_e(item.serial)}</div>`:''}
        ${item.sku?`<div class="sub">SKU: ${_e(item.sku)}</div>`:''}
      </div>`).join('');

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Labels</title>
    <style>
      @page { size: ${w}mm ${h}mm; margin: 1mm; }
      @media print { body { width: ${w}mm; } }
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: Arial, sans-serif; }
      .label {
        width: ${w}mm; height: ${h}mm;
        display: flex; flex-direction: column;
        justify-content: center; align-items: center;
        text-align: center; overflow: hidden;
        padding: 1.5mm; border: 0.5mm dashed #ccc;
      }
      .shop  { font-size: 6px; color: #999; }
      .name  { font-size: ${Math.max(8, Math.min(14, w/3.5))}px; font-weight: bold; line-height: 1.2; }
      .sub   { font-size: 7px; color: #666; margin-top: 0.5mm; }
      .price { font-size: ${Math.max(12, Math.min(20, w/2.5))}px; font-weight: bold; color: #1a1a2e; margin: 1mm 0; }
      .bc    { font-family: monospace; font-size: 7px; letter-spacing: 1px; margin-top: 0.5mm; }
    </style></head>
    <body>${cards}
    <script>setTimeout(()=>{window.print();},300)<\/script>
    </body></html>`;
  }

  /* ── Master print-label entry point ── */
  async function printLabel(items, opts = {}) {
    if (!window.SokoniPosprint) {
      /* Fallback: browser print */
      const html = buildHTML(items, opts);
      const bu = URL.createObjectURL(new Blob([html], {type:'text/html;charset=utf-8'}));
      const w = window.open(bu, '_blank', 'width=600,height=500');
      if (w) setTimeout(() => URL.revokeObjectURL(bu), 10000);
      else URL.revokeObjectURL(bu);
      return;
    }

    const printer = await SokoniPosprint.getDefaultPrinter();
    const lang    = printer
      ? (window.SokoniPrinterDrivers?.detectLanguage(printer.name || '') || 'escpos')
      : 'browser';

    let bytes;
    switch (lang) {
      case 'tspl': bytes = buildTSPL(items, opts); break;
      case 'zpl':  bytes = buildZPL(items, opts);  break;
      case 'escpos': bytes = buildESCPOS(items, opts); break;
      default:
        /* Browser fallback */
        return SokoniPosprint.print({ items, labelOpts: opts }, { type: 'label' });
    }

    /* Send bytes directly via the print engine */
    const id = printer?.id || null;
    if (id && SokoniPosprint.getConnectionStatus(id) === 'connected') {
      /* Access internal connection — bridge via print() with raw bytes job */
      return SokoniPosprint.print({ items, labelOpts: opts, _rawBytes: bytes }, { type: 'label', printerId: id });
    }

    /* Fall back to browser HTML label */
    const html = buildHTML(items, opts);
    const bu2 = URL.createObjectURL(new Blob([html], {type:'text/html;charset=utf-8'}));
    const w = window.open(bu2, '_blank', 'width=600,height=500');
    if (w) setTimeout(() => URL.revokeObjectURL(bu2), 10000); else URL.revokeObjectURL(bu2);
  }

  /* Print a product barcode sticker */
  async function printBarcode(data, type = 'CODE128', opts = {}) {
    return printLabel([{
      name:    opts.name || data,
      barcode: data,
      price:   opts.price,
      sku:     opts.sku,
      shopName: opts.shopName,
    }], { barcodeType: type, showBarcode: true, showQR: false, ...opts });
  }

  /* Print a QR code label */
  async function printQR(data, opts = {}) {
    return printLabel([{
      name: opts.name || 'Scan QR',
      qr:   data,
      url:  data,
      shopName: opts.shopName,
    }], { showQR: true, showBarcode: false, qrSize: opts.qrSize || 5, ...opts });
  }

  /* Print a price tag */
  async function printPriceTag(item, opts = {}) {
    return printLabel([item], { showPrice: true, showBarcode: true, ...opts });
  }

  /* Print shipping label */
  function printShippingLabel(data, opts = {}) {
    const _openBlob = (h, dims) => {
      const bu = URL.createObjectURL(new Blob([h], {type:'text/html;charset=utf-8'}));
      const w = window.open(bu, '_blank', dims);
      if (w) setTimeout(() => URL.revokeObjectURL(bu), 10000); else URL.revokeObjectURL(bu);
    };
    if (!window.SokoniReceiptEngine) {
      _openBlob(buildHTML([data], { size: '100x150', ...opts }), 'width=500,height=600');
      return;
    }
    _openBlob(SokoniReceiptEngine.buildShippingLabel({ data, type: 'shipping' }), 'width=500,height=600');
  }

  /* ── Helpers ── */
  function _esc(s)    { return String(s||'').replace(/"/g,"'").replace(/[\r\n]/g,' '); }
  function _escZPL(s) { return String(s||'').replace(/[\\^~]/g,''); }

  /* ── Label size catalog ── */
  function getSizes()         { return Object.entries(SIZES).map(([id, s]) => ({ id, ...s })); }
  function getBarcodeTypes()  { return Object.entries(BARCODE_TYPES).map(([id, t]) => ({ id, ...t })); }

  return {
    /* Label builders */
    buildTSPL,
    buildZPL,
    buildESCPOS,
    buildHTML,
    /* Print helpers */
    printLabel,
    printBarcode,
    printQR,
    printPriceTag,
    printShippingLabel,
    /* Utilities */
    validate,
    addChecksum,
    ean13Checksum,
    getSizes,
    getBarcodeTypes,
    SIZES,
    BARCODE_TYPES,
  };
})();
