/* ═══════════════════════════════════════════════════════════════════
   SOKONI Unified Printing Engine v1.0

   Extends PosPrinter with:
   • Auto-merchant branding — logo, name, branch, address, contacts
     loaded from Firestore (shops/{shopId}) with localStorage cache
   • 9 document templates:
       Thermal: Receipt (with QR), Barcode Label, QR Label
       HTML:    Shelf Price Tag, Product Sticker, Invoice,
                Quotation, Delivery Note, Return Slip
   • ESC/POS logo bitmap rendering via Canvas API
   • Print job queue with up to 3 auto-retries
   • Fully XSS-safe HTML generation

   Requires: pos-printer.js (PosPrinter) loaded before this file.
   Optional: Firebase — used for Firestore brand loading only.
   Exports:  window.SokoniPrint
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const SokoniPrint = (() => {

  /* ── ESC/POS byte constants ───────────────────────────────────── */
  const ESC = 0x1b, GS = 0x1d, LF = 0x0a;

  /* ── Storage keys ─────────────────────────────────────────────── */
  const BRAND_KEY = 'sokoni_print_brand_v1';
  const MAX_RETRY  = 3;
  const RETRY_DELAY_MS = 5000;

  /* ── Job queue state ──────────────────────────────────────────── */
  let _queue = [];
  let _processing = false;

  /* ── Merchant branding ────────────────────────────────────────── */
  let _brand = null;

  function _normBrand(raw) {
    raw = raw || {};
    return {
      name:          raw.businessName    || raw.name        || 'SOKONI',
      branch:        raw.branch          || raw.branchName  || '',
      address:       raw.businessAddress || raw.address     || 'Nairobi, Kenya',
      phone:         raw.businessPhone   || raw.phone       || '',
      email:         raw.businessEmail   || raw.email       || '',
      website:       raw.website         || 'mysokoni.co.ke',
      pin:           raw.businessPin     || raw.kra_pin     || '',
      logoUrl:       raw.logoUrl         || raw.logo        || '',
      color:         raw.brandColor      || '#1a73e8',
      tagline:       raw.tagline         || '',
      receiptFooter: raw.receiptFooter   || 'Thank you for shopping with us!',
      paperWidth:    raw.paperWidth      || 80,
    };
  }

  async function loadBrand(shopId) {
    /* 1 — Live POS session settings take highest priority */
    if (window._posBizSettings) {
      _brand = _normBrand(window._posBizSettings);
      return _brand;
    }

    /* 2 — localStorage cache (1-hour TTL) */
    try {
      const cached = localStorage.getItem(BRAND_KEY);
      if (cached) {
        const p = JSON.parse(cached);
        if (p.shopId === shopId && (Date.now() - p.cachedAt) < 3_600_000) {
          _brand = p.brand;
          return _brand;
        }
      }
    } catch (_) { /* ignore parse errors */ }

    /* 3 — Firestore lookup */
    if (shopId) {
      const db = (typeof firebase !== 'undefined' && firebase.firestore) ? firebase.firestore() : null;
      if (db) {
        try {
          const snap = await db.collection('shops').doc(shopId).get();
          if (snap.exists) {
            _brand = _normBrand(snap.data());
            try {
              localStorage.setItem(BRAND_KEY, JSON.stringify({
                shopId, brand: _brand, cachedAt: Date.now(),
              }));
            } catch (_) {}
            return _brand;
          }
        } catch (e) {
          console.warn('[SokoniPrint] Firestore brand load failed:', e.message);
        }
      }
    }

    /* 4 — Fallback defaults */
    _brand = _normBrand({});
    return _brand;
  }

  function getBrand() { return _brand || _normBrand({}); }

  /* ── XSS-safe HTML escape ─────────────────────────────────────── */
  function escH(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  /* ── ESC/POS buffer helpers ──────────────────────────────────── */
  function _buf() {
    const b = [];
    return {
      push: (...cmds) => { cmds.flat().forEach(c => b.push(c)); },
      str:  s => {
        for (let i = 0; i < s.length; i++) b.push(s.charCodeAt(i) & 0x7f);
        b.push(LF);
      },
      raw:  s => { for (let i = 0; i < s.length; i++) b.push(s.charCodeAt(i) & 0x7f); },
      bytes: () => new Uint8Array(b),
    };
  }

  /* ── Logo → ESC/POS GS v 0 raster bitmap ─────────────────────── */
  async function _logoBytes(url, targetPx) {
    if (!url) return new Uint8Array(0);
    const px = targetPx - (targetPx % 8); // must be multiple of 8
    try {
      const img = await new Promise((res, rej) => {
        const el = new Image();
        el.crossOrigin = 'anonymous';
        el.onload  = () => res(el);
        el.onerror = () => rej(new Error('Logo load failed'));
        el.src = url;
      });
      const canvas = document.createElement('canvas');
      const aspect = img.naturalHeight / img.naturalWidth;
      canvas.width  = px;
      canvas.height = Math.ceil(px * aspect);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const { data, width: w, height: h } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const bytesPerRow = w / 8;
      const out = [GS, 0x76, 0x30, 0x00,
        bytesPerRow & 0xff, (bytesPerRow >> 8) & 0xff,
        h & 0xff, (h >> 8) & 0xff];
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < bytesPerRow; col++) {
          let byte = 0;
          for (let bit = 0; bit < 8; bit++) {
            const x   = col * 8 + bit;
            const off = (row * w + x) * 4;
            const grey = data[off] * 0.299 + data[off + 1] * 0.587 + data[off + 2] * 0.114;
            if (grey < 128) byte |= (0x80 >> bit);
          }
          out.push(byte);
        }
      }
      return new Uint8Array(out);
    } catch (e) {
      console.warn('[SokoniPrint] Logo render failed, skipping:', e.message);
      return new Uint8Array(0);
    }
  }

  /* ── Thermal: Receipt with logo + QR ─────────────────────────── */
  async function _buildReceipt(d) {
    const brand = getBrand();
    const w    = brand.paperWidth <= 58 ? 32 : 42;
    const b    = _buf();
    const hr   = () => b.str('-'.repeat(w));
    const ctr  = s => { s = String(s); const p = Math.max(0, Math.floor((w - s.length) / 2)); b.str(' '.repeat(p) + s); };
    const row  = (l, r) => {
      r = String(r);
      const max = w - r.length - 1;
      b.str(String(l).slice(0, max).padEnd(max) + ' ' + r);
    };

    b.push(ESC, 0x40); // init

    /* Logo */
    if (brand.logoUrl) {
      b.push(ESC, 0x61, 0x01); // center
      const logoPx = brand.paperWidth <= 58 ? 160 : 224;
      const logo   = await _logoBytes(brand.logoUrl, logoPx);
      logo.forEach(byte => b.push(byte));
      b.push(LF);
    }

    /* Business header */
    b.push(ESC, 0x61, 0x01, GS, 0x21, 0x11, ESC, 0x45, 0x01);
    ctr(brand.name.slice(0, Math.floor(w / 2)));
    b.push(GS, 0x21, 0x00, ESC, 0x45, 0x00);
    if (brand.branch)  ctr(brand.branch);
    if (brand.address) ctr(brand.address);
    if (brand.phone)   ctr('Tel: ' + brand.phone);
    if (brand.pin)     ctr('KRA PIN: ' + brand.pin);

    b.push(ESC, 0x61, 0x00); // left
    hr();
    b.str('Receipt : ' + (d.receiptNo || '---'));
    b.str('Date    : ' + new Date(d.timestamp || Date.now()).toLocaleString('en-KE'));
    b.str('Cashier : ' + (d.cashierName || 'N/A'));
    if (d.customerName) b.str('Customer: ' + d.customerName);
    hr();

    b.push(ESC, 0x45, 0x01);
    row('DESCRIPTION', 'KES');
    b.push(ESC, 0x45, 0x00);
    hr();

    for (const item of (d.items || [])) {
      b.str(String(item.name).slice(0, w));
      row(`  ${item.qty} x ${Number(item.price).toFixed(2)}`,
          (item.qty * item.price).toFixed(2));
    }
    hr();

    if ((d.discountAmount || 0) > 0) row('Subtotal:', (d.subtotal || 0).toFixed(2));
    if ((d.discountAmount || 0) > 0) row('Discount:', '-' + (d.discountAmount || 0).toFixed(2));
    if ((d.taxAmount      || 0) > 0) row(`VAT (${d.taxRate || 16}%):`, (d.taxAmount || 0).toFixed(2));

    b.push(ESC, 0x45, 0x01, GS, 0x21, 0x01);
    row('TOTAL KES:', (d.total || 0).toFixed(2));
    b.push(GS, 0x21, 0x00, ESC, 0x45, 0x00);
    hr();

    const pm = (d.paymentMethod || 'CASH').toUpperCase();
    row(`Paid (${pm}):`, (d.amountPaid || d.total || 0).toFixed(2));
    if ((d.change || 0) > 0) row('Change:', (d.change || 0).toFixed(2));
    if (d.mpesaRef)   b.str('M-PESA Ref: ' + d.mpesaRef);
    if (d.mpesaPhone) b.str('Phone: ' + d.mpesaPhone);
    hr();

    /* QR code linking to receipt verification */
    if (d.receiptNo) {
      b.push(ESC, 0x61, 0x01);
      const qrUrl  = d.qrUrl || `https://mysokoni.co.ke/receipt/${d.receiptNo}`;
      const qrCmd  = window.PosPrinter?.buildQR(qrUrl, 4) || _buildQRCmd(qrUrl, 4);
      qrCmd.forEach(byte => b.push(byte));
      b.push(LF);
    }

    b.push(ESC, 0x61, 0x01);
    ctr(brand.receiptFooter);
    if (brand.website) ctr(brand.website);
    ctr('Powered by SOKONI SmartPOS');
    b.push(LF, LF, LF, LF);
    b.push(GS, 0x56, 0x42, 0x05); // full cut

    return b.bytes();
  }

  /* ── Thermal: Barcode label ───────────────────────────────────── */
  async function _buildBarcodeLabel(d) {
    const brand = getBrand();
    const w = 32;
    const b = _buf();
    const ctr = s => { s = String(s); const p = Math.max(0, Math.floor((w - s.length) / 2)); b.str(' '.repeat(p) + s); };

    b.push(ESC, 0x40, ESC, 0x61, 0x01);

    b.push(ESC, 0x45, 0x01);
    ctr(brand.name.slice(0, w));
    b.push(ESC, 0x45, 0x00);

    const name = String(d.productName || d.name || '').slice(0, w);
    ctr(name);

    b.push(GS, 0x21, 0x11, ESC, 0x45, 0x01);
    ctr('KES ' + Number(d.price || 0).toLocaleString('en-KE'));
    b.push(GS, 0x21, 0x00, ESC, 0x45, 0x00);

    const barcode = String(d.barcode || d.sku || '');
    if (barcode) {
      const enc = [];
      for (let i = 0; i < barcode.length; i++) enc.push(barcode.charCodeAt(i));
      b.push(GS, 0x48, 0x02); // HRI below barcode
      b.push(GS, 0x68, 60);   // barcode height 60 dots
      b.push(GS, 0x77, 2);    // barcode module width 2
      b.push(GS, 0x6b, 73, enc.length, ...enc); // CODE128
    }

    if (d.sku && d.sku !== d.barcode) ctr('SKU: ' + d.sku);
    if (d.expiryDate) ctr('Exp: ' + d.expiryDate);
    if (d.batch)      ctr('Batch: ' + d.batch);

    b.push(LF, LF);
    b.push(GS, 0x56, 0x42, 0x03); // partial cut

    return b.bytes();
  }

  /* ── Thermal: QR label ───────────────────────────────────────── */
  async function _buildQRLabel(d) {
    const brand = getBrand();
    const w = 32;
    const b = _buf();
    const ctr = s => { s = String(s); const p = Math.max(0, Math.floor((w - s.length) / 2)); b.str(' '.repeat(p) + s); };

    b.push(ESC, 0x40, ESC, 0x61, 0x01);
    b.push(ESC, 0x45, 0x01); ctr(brand.name.slice(0, w)); b.push(ESC, 0x45, 0x00);
    if (d.title) ctr(String(d.title).slice(0, w));

    const qrData = String(d.qrData || d.url || d.productId || 'https://mysokoni.co.ke');
    const qrCmd  = window.PosPrinter?.buildQR(qrData, 6) || _buildQRCmd(qrData, 6);
    qrCmd.forEach(byte => b.push(byte));
    b.push(LF);

    if (d.subtitle) ctr(String(d.subtitle).slice(0, w));
    if (d.price != null) {
      b.push(GS, 0x21, 0x10, ESC, 0x45, 0x01);
      ctr('KES ' + Number(d.price).toLocaleString('en-KE'));
      b.push(GS, 0x21, 0x00, ESC, 0x45, 0x00);
    }
    if (d.sku) ctr(d.sku);

    b.push(LF, LF);
    b.push(GS, 0x56, 0x42, 0x03);

    return b.bytes();
  }

  /* Inline QR builder in case PosPrinter is not loaded yet */
  function _buildQRCmd(data, size = 6) {
    const enc = [];
    for (let i = 0; i < data.length; i++) enc.push(data.charCodeAt(i) & 0x7f);
    const dLen = enc.length + 3;
    return [
      GS, 0x28, 0x6b, 4, 0, 49, 65, 50, 0,
      GS, 0x28, 0x6b, 3, 0, 49, 67, Math.min(Math.max(size, 1), 16),
      GS, 0x28, 0x6b, 3, 0, 49, 69, 49,
      GS, 0x28, 0x6b, dLen & 0xff, (dLen >> 8) & 0xff, 49, 80, 48, ...enc,
      GS, 0x28, 0x6b, 3, 0, 49, 81, 48,
    ];
  }

  /* ── HTML: Shelf price tag ────────────────────────────────────── */
  function _shelfTagHTML(items) {
    const brand = getBrand();
    const arr = Array.isArray(items) ? items : [items];
    return `<!DOCTYPE html><html lang="en"><head>
    <meta charset="UTF-8"><title>Shelf Price Tags — SOKONI</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Arial,Helvetica,sans-serif;background:#fff;padding:6mm}
      .wrap{display:flex;flex-wrap:wrap;gap:3mm}
      .tag{width:80mm;height:50mm;border:1.5pt solid #000;padding:3mm;
           display:flex;flex-direction:column;justify-content:space-between;
           page-break-inside:avoid}
      .biz{font-size:7.5pt;font-weight:bold;color:#444;
           white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .name{font-size:11.5pt;font-weight:bold;line-height:1.3;
            flex:1;display:flex;align-items:center;padding:1mm 0}
      .price-row{border-top:1pt solid #000;padding-top:2mm;
                 display:flex;align-items:baseline;gap:3mm}
      .price{font-size:22pt;font-weight:900}
      .unit{font-size:8.5pt;color:#666}
      .was{font-size:8.5pt;text-decoration:line-through;color:#aaa;margin-left:auto}
      .sku{font-size:6.5pt;font-family:monospace;color:#888;margin-top:1mm}
      @media print{body{padding:3mm}@page{margin:3mm;size:A4}}
    </style></head><body>
    <div class="wrap">
    ${arr.map(p => `
      <div class="tag">
        <div class="biz">${escH(brand.name)}${brand.branch ? ' — ' + escH(brand.branch) : ''}</div>
        <div class="name">${escH(p.productName || p.name || '')}</div>
        <div class="price-row">
          <div class="price">KES&nbsp;${Number(p.price || 0).toLocaleString('en-KE', { minimumFractionDigits: 2 })}</div>
          <div class="unit">${escH(p.unit || 'per piece')}</div>
          ${p.comparePrice ? `<div class="was">KES ${Number(p.comparePrice).toLocaleString('en-KE', { minimumFractionDigits: 2 })}</div>` : ''}
        </div>
        ${p.sku ? `<div class="sku">SKU: ${escH(p.sku)}</div>` : ''}
      </div>`).join('')}
    </div>
    <script>window.onload=()=>{window.print();window.onafterprint=()=>window.close()}<\/script>
    </body></html>`;
  }

  /* ── HTML: Product sticker ────────────────────────────────────── */
  function _stickerHTML(items) {
    const brand = getBrand();
    const arr = Array.isArray(items) ? items : [items];
    return `<!DOCTYPE html><html lang="en"><head>
    <meta charset="UTF-8"><title>Product Stickers — SOKONI</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Arial,Helvetica,sans-serif;background:#fff;padding:5mm}
      .wrap{display:flex;flex-wrap:wrap;gap:2mm}
      .sticker{width:50mm;height:32mm;border:0.5pt solid #ccc;padding:2mm;
               display:flex;flex-direction:column;justify-content:space-between;
               page-break-inside:avoid;background:#fff}
      .biz{font-size:6pt;font-weight:bold;color:#555;
           white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .name{font-size:8.5pt;font-weight:bold;line-height:1.2;
            flex:1;display:flex;align-items:center}
      .price{font-size:13.5pt;font-weight:900}
      .code{font-size:6pt;font-family:monospace;color:#666;text-align:center;margin-top:1mm}
      @media print{body{padding:2mm}@page{margin:2mm;size:A4}}
    </style></head><body>
    <div class="wrap">
    ${arr.map(p => `
      <div class="sticker">
        <div class="biz">${escH(brand.name)}</div>
        <div class="name">${escH(p.productName || p.name || '')}</div>
        <div class="price">KES&nbsp;${Number(p.price || 0).toLocaleString('en-KE')}</div>
        ${(p.barcode || p.sku) ? `<div class="code">${escH(p.barcode || p.sku || '')}</div>` : ''}
      </div>`).join('')}
    </div>
    <script>window.onload=()=>{window.print();window.onafterprint=()=>window.close()}<\/script>
    </body></html>`;
  }

  /* ── HTML: Full-page document base ──────────────────────────────
     Used by invoice, quotation, delivery note, return slip.         */
  function _fullPageDoc({ docType, docNo, date, secondaryLabel, secondaryDate,
      customer, items, subtotal, tax, discount, total, notes, extra, accentColor }) {
    const brand = getBrand();
    const c   = customer || {};
    const col = accentColor || brand.color;
    const showAmounts = total != null;

    /* totals block */
    let totalsHTML = '';
    if (showAmounts) {
      totalsHTML = `
      <div style="width:55mm;margin-left:auto;border-top:1pt solid #ddd;padding-top:3mm">
        ${subtotal != null ? _trow('Subtotal', 'KES ' + _fmt(subtotal)) : ''}
        ${discount != null && discount > 0 ? _trow('Discount', '-KES ' + _fmt(discount)) : ''}
        ${tax != null && tax > 0 ? _trow('VAT (16%)', 'KES ' + _fmt(tax)) : ''}
        <div style="display:flex;justify-content:space-between;font-size:12pt;font-weight:900;
                    border-top:1.5pt solid #000;margin-top:2mm;padding-top:2mm;color:${col}">
          <span>TOTAL</span><span>KES ${_fmt(total)}</span>
        </div>
      </div>`;
    }

    return `<!DOCTYPE html><html lang="en"><head>
    <meta charset="UTF-8"><title>${escH(docType)} — SOKONI</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Arial,Helvetica,sans-serif;font-size:10pt;color:#111;background:#fff;padding:15mm}
      .hdr{display:flex;justify-content:space-between;align-items:flex-start;
           margin-bottom:8mm;border-bottom:2pt solid ${col};padding-bottom:5mm}
      .brand .bname{font-size:17pt;font-weight:900;color:${col};line-height:1.1}
      .brand .bsub{font-size:8.5pt;color:#555;line-height:1.7;margin-top:1.5mm}
      .docinfo{text-align:right}
      .docinfo .dtype{font-size:20pt;font-weight:900;color:${col};text-transform:uppercase}
      .docinfo .dno{font-size:9pt;color:#666;margin-top:1.5mm}
      .docinfo .dates{font-size:8.5pt;color:#444;margin-top:2mm;line-height:1.8}
      .billto{background:#f7f7f7;border-left:3pt solid ${col};padding:4mm 5mm;margin-bottom:6mm}
      .billto .lbl{font-size:7.5pt;color:#999;font-weight:bold;text-transform:uppercase;letter-spacing:0.4pt;margin-bottom:1.5mm}
      .billto .cname{font-size:11pt;font-weight:bold}
      .billto .cdetail{font-size:9pt;color:#444;line-height:1.7}
      table{width:100%;border-collapse:collapse;margin-bottom:5mm}
      th{background:${col};color:#fff;font-size:8pt;padding:2.5mm 4mm;text-align:left}
      th.r,td.r{text-align:right}
      td{padding:2.5mm 4mm;font-size:9.5pt;border-bottom:0.5pt solid #eee;vertical-align:top}
      tr:nth-child(even) td{background:#fafafa}
      .note{background:#fffbeb;border:0.5pt solid #e5c940;border-radius:2pt;
            padding:3mm 4mm;font-size:9pt;color:#555;margin-top:5mm}
      .extra{font-size:9pt;color:#444;margin-top:3mm}
      .footer{margin-top:10mm;border-top:0.5pt solid #ddd;padding-top:3mm;
              text-align:center;font-size:8pt;color:#bbb}
      @media print{body{padding:10mm}@page{margin:8mm;size:A4}}
    </style></head><body>

    <div class="hdr">
      <div class="brand">
        ${brand.logoUrl ? `<img src="${escH(brand.logoUrl)}" style="height:13mm;margin-bottom:2mm;display:block" crossorigin="anonymous">` : ''}
        <div class="bname">${escH(brand.name)}</div>
        <div class="bsub">
          ${brand.branch  ? escH(brand.branch)  + '<br>' : ''}
          ${escH(brand.address)}<br>
          ${brand.phone   ? 'Tel: '     + escH(brand.phone)   + '<br>' : ''}
          ${brand.email   ? escH(brand.email)   + '<br>' : ''}
          ${brand.pin     ? 'KRA PIN: ' + escH(brand.pin)     : ''}
        </div>
      </div>
      <div class="docinfo">
        <div class="dtype">${escH(docType)}</div>
        <div class="dno"># ${escH(docNo)}</div>
        <div class="dates">Date: ${escH(date)}<br>${escH(secondaryLabel)}: ${escH(secondaryDate)}</div>
      </div>
    </div>

    ${c.name ? `
    <div class="billto">
      <div class="lbl">Bill / Deliver To</div>
      <div class="cname">${escH(c.name)}</div>
      <div class="cdetail">
        ${c.address ? escH(c.address) + '<br>' : ''}
        ${c.phone   ? 'Tel: ' + escH(c.phone) + '<br>' : ''}
        ${c.email   ? escH(c.email) : ''}
      </div>
    </div>` : ''}

    <table>
      <thead><tr>
        <th style="width:5%">#</th>
        <th>Description</th>
        <th class="r" style="width:10%">Qty</th>
        ${showAmounts ? '<th class="r" style="width:15%">Unit Price</th><th class="r" style="width:15%">Amount</th>' : ''}
      </tr></thead>
      <tbody>
        ${(items || []).map((item, i) => `
          <tr>
            <td>${i + 1}</td>
            <td>${escH(item.description || item.name || '')}</td>
            <td class="r">${escH(String(item.qty ?? 1))}</td>
            ${showAmounts ? `
              <td class="r">${item.unitPrice != null && item.unitPrice !== '' ? 'KES ' + _fmt(item.unitPrice) : '&mdash;'}</td>
              <td class="r">${item.total    != null && item.total    !== '' ? 'KES ' + _fmt(item.total)    : '&mdash;'}</td>` : ''}
          </tr>`).join('')}
      </tbody>
    </table>

    ${totalsHTML}
    ${extra ? `<div class="extra">${extra}</div>` : ''}
    ${notes ? `<div class="note"><strong>Notes:</strong> ${escH(notes)}</div>` : ''}
    <div class="footer">${escH(brand.name)} &mdash; ${escH(brand.website)} &mdash; Powered by SOKONI</div>

    <script>window.onload=()=>{window.print();window.onafterprint=()=>window.close()}<\/script>
    </body></html>`;
  }

  function _trow(label, value) {
    return `<div style="display:flex;justify-content:space-between;font-size:9.5pt;line-height:1.9">
      <span>${escH(label)}</span><span>${escH(value)}</span></div>`;
  }
  function _fmt(n) { return Number(n).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function _fmtDate(d) { return d ? new Date(d).toLocaleDateString('en-KE') : '&mdash;'; }

  /* ── HTML: Invoice ────────────────────────────────────────────── */
  function _invoiceHTML(d) {
    return _fullPageDoc({
      docType: 'INVOICE', docNo: d.invoiceNo || d.id || '—',
      date: _fmtDate(d.date || Date.now()),
      secondaryLabel: 'Due Date', secondaryDate: _fmtDate(d.dueDate),
      customer:  d.customer,
      items:     d.items,
      subtotal:  d.subtotal,
      tax:       d.tax || d.taxAmount,
      discount:  d.discount || d.discountAmount,
      total:     d.total,
      notes:     d.notes,
      extra:     d.paymentTerms ? `<strong>Payment Terms:</strong> ${escH(d.paymentTerms)}` : '',
    });
  }

  /* ── HTML: Quotation ──────────────────────────────────────────── */
  function _quotationHTML(d) {
    return _fullPageDoc({
      docType: 'QUOTATION', docNo: d.quoteNo || d.quotationNo || d.id || '—',
      date: _fmtDate(d.date || Date.now()),
      secondaryLabel: 'Valid Until', secondaryDate: _fmtDate(d.validUntil),
      customer:  d.customer,
      items:     d.items,
      subtotal:  d.subtotal,
      tax:       d.tax || d.taxAmount,
      discount:  d.discount || d.discountAmount,
      total:     d.total,
      notes:     d.notes || 'Prices subject to change after validity period.',
      extra:     '',
    });
  }

  /* ── HTML: Delivery note ─────────────────────────────────────── */
  function _deliveryNoteHTML(d) {
    const itemsNormalized = (d.items || []).map(i => ({
      name:        i.name || i.description,
      description: [i.name || i.description, i.unit ? '(' + i.unit + ')' : ''].filter(Boolean).join(' '),
      qty:         i.qty,
      unitPrice:   '',
      total:       '',
    }));
    const extras = [
      d.driver  ? `<strong>Driver:</strong> ${escH(d.driver)}`   : '',
      d.vehicle ? `<strong>Vehicle:</strong> ${escH(d.vehicle)}` : '',
    ].filter(Boolean).join(' &nbsp;&bull;&nbsp; ');
    return _fullPageDoc({
      docType: 'DELIVERY NOTE', docNo: d.deliveryNo || d.id || '—',
      date: _fmtDate(d.date || Date.now()),
      secondaryLabel: 'Order Ref', secondaryDate: escH(d.orderNo || '—'),
      customer:  d.customer,
      items:     itemsNormalized,
      subtotal:  null, tax: null, discount: null, total: null,
      notes:     d.notes || '',
      extra:     extras,
    });
  }

  /* ── HTML: Return slip ────────────────────────────────────────── */
  function _returnSlipHTML(d) {
    const itemsNormalized = (d.items || []).map(i => ({
      description: `${i.name} — Reason: ${i.reason || 'N/A'} | Condition: ${i.condition || 'N/A'}`,
      qty: i.qty, unitPrice: '', total: '',
    }));
    return _fullPageDoc({
      docType: 'RETURN SLIP', docNo: d.returnNo || d.id || '—',
      date: _fmtDate(d.date || Date.now()),
      secondaryLabel: 'Orig. Receipt', secondaryDate: escH(d.originalReceiptNo || '—'),
      customer:  d.customer,
      items:     itemsNormalized,
      subtotal:  null, tax: null, discount: null,
      total:     d.refundAmount != null ? d.refundAmount : null,
      notes:     d.notes || '',
      extra:     d.refundMethod ? `<strong>Refund Method:</strong> ${escH(d.refundMethod)}` : '',
      accentColor: '#dc2626',
    });
  }

  /* ── HTML popup opener ───────────────────────────────────────── */
  function _openHTML(html) {
    const blobUrl = URL.createObjectURL(new Blob([html], {type:'text/html;charset=utf-8'}));
    const w = window.open(blobUrl, '_blank', 'width=860,height=720');
    if (!w) {
      URL.revokeObjectURL(blobUrl);
      (window._skToast || window.alert)('Allow popups to print documents');
      return;
    }
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
  }

  /* ── Thermal send via PosPrinter.sendRaw ─────────────────────── */
  async function _sendThermal(bytes) {
    if (!window.PosPrinter) throw new Error('PosPrinter not loaded');
    if (!PosPrinter.isConnected() || PosPrinter.getType() === 'browser') {
      throw new Error('No thermal printer connected');
    }
    return PosPrinter.sendRaw(bytes);
  }

  /* ── Main dispatch ────────────────────────────────────────────── */
  async function _dispatch(docType, data) {
    const pt = window.PosPrinter;
    const thermalConnected = pt && pt.isConnected() && pt.getType() !== 'browser';

    switch (docType) {
      /* Thermal-first; browser fallback */
      case 'receipt':
        if (thermalConnected) {
          await _sendThermal(await _buildReceipt(data));
        } else if (pt) {
          pt.printBrowser(data);
        } else {
          throw new Error('PosPrinter not available');
        }
        break;

      case 'barcode-label': {
        const arr = Array.isArray(data) ? data : [data];
        if (thermalConnected) {
          for (const item of arr) await _sendThermal(await _buildBarcodeLabel(item));
        } else {
          _openHTML(_buildBarcodeLabelHTML(arr));
        }
        break;
      }

      case 'qr-label': {
        const arr = Array.isArray(data) ? data : [data];
        if (thermalConnected) {
          for (const item of arr) await _sendThermal(await _buildQRLabel(item));
        } else {
          _openHTML(_buildQRLabelHTML(arr));
        }
        break;
      }

      /* HTML-only (window.print) */
      case 'shelf-tag':
        _openHTML(_shelfTagHTML(data));
        break;
      case 'sticker':
        _openHTML(_stickerHTML(data));
        break;
      case 'invoice':
        _openHTML(_invoiceHTML(data));
        break;
      case 'quotation':
        _openHTML(_quotationHTML(data));
        break;
      case 'delivery-note':
        _openHTML(_deliveryNoteHTML(data));
        break;
      case 'return-slip':
        _openHTML(_returnSlipHTML(data));
        break;

      default:
        throw new Error('[SokoniPrint] Unknown document type: ' + docType);
    }
  }

  /* ── HTML barcode label (browser fallback) ───────────────────── */
  function _buildBarcodeLabelHTML(items) {
    const brand = getBrand();
    return `<!DOCTYPE html><html lang="en"><head>
    <meta charset="UTF-8"><title>Barcode Labels — SOKONI</title>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Arial,sans-serif;background:#fff;padding:5mm}
      .wrap{display:flex;flex-wrap:wrap;gap:2mm}
      .label{width:58mm;height:40mm;border:0.7pt solid #aaa;padding:2.5mm;
             display:flex;flex-direction:column;align-items:center;
             justify-content:space-between;page-break-inside:avoid}
      .biz{font-size:6.5pt;font-weight:bold;color:#444;text-align:center;
           width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .name{font-size:9pt;font-weight:bold;text-align:center;line-height:1.2;
            flex:1;display:flex;align-items:center;justify-content:center;padding:0 1mm}
      .bc{text-align:center;width:100%}
      .bc-num{font-size:7pt;font-family:monospace;margin-top:0.5mm}
      .price{font-size:15pt;font-weight:900;text-align:center}
      @media print{body{padding:3mm}@page{margin:3mm;size:A4}}
    </style></head><body>
    <div class="wrap">
    ${items.map(p => `
      <div class="label">
        <div class="biz">${escH(brand.name)}</div>
        <div class="name">${escH(p.productName || p.name || '')}</div>
        ${(p.barcode || p.sku) ? `
        <div class="bc">
          ${window.PosBarcode ? PosBarcode.generateSVG(p.barcode || p.sku, { width: 150, height: 28 }) || '' : ''}
          <div class="bc-num">${escH(p.barcode || p.sku || '')}</div>
        </div>` : ''}
        <div class="price">KES ${Number(p.price || 0).toLocaleString('en-KE')}</div>
      </div>`).join('')}
    </div>
    <script>window.onload=()=>{window.print();window.onafterprint=()=>window.close()}<\/script>
    </body></html>`;
  }

  /* ── HTML QR label (browser fallback) ─────────────────────────── */
  function _buildQRLabelHTML(items) {
    const brand = getBrand();
    const itemsJSON = JSON.stringify(items.map(p => ({
      qr: p.qrData || p.url || ('https://mysokoni.co.ke/p/' + (p.productId || p.id || '')),
      title: p.title || p.productName || p.name || '',
      price: p.price,
    })));
    return `<!DOCTYPE html><html lang="en"><head>
    <meta charset="UTF-8"><title>QR Labels — SOKONI</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script>
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Arial,sans-serif;background:#fff;padding:5mm}
      .wrap{display:flex;flex-wrap:wrap;gap:3mm}
      .label{width:60mm;height:62mm;border:0.7pt solid #aaa;padding:3mm;
             display:flex;flex-direction:column;align-items:center;
             justify-content:space-between;page-break-inside:avoid}
      .biz{font-size:7pt;font-weight:bold;color:#444}
      .qr{width:42mm;height:42mm}
      .name{font-size:8.5pt;font-weight:bold;text-align:center;line-height:1.2}
      .price{font-size:13pt;font-weight:900}
      @media print{body{padding:3mm}@page{margin:3mm;size:A4}}
    </style></head><body>
    <div class="wrap">
    ${items.map((p, i) => `
      <div class="label">
        <div class="biz">${escH(brand.name)}</div>
        <div class="qr" id="qr${i}"></div>
        <div class="name">${escH(p.title || p.productName || p.name || '')}</div>
        ${p.price != null ? `<div class="price">KES ${Number(p.price).toLocaleString('en-KE')}</div>` : ''}
      </div>`).join('')}
    </div>
    <script>
    (function(){
      var items=${itemsJSON};
      items.forEach(function(p,i){
        if(window.QRCode){
          new QRCode(document.getElementById('qr'+i),
            {text:p.qr,width:126,height:126,correctLevel:QRCode.CorrectLevel.M});
        }
      });
      setTimeout(function(){window.print();window.onafterprint=function(){window.close()};},600);
    })();
    <\/script>
    </body></html>`;
  }

  /* ── Job queue ────────────────────────────────────────────────── */
  function _makeId() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  function _enqueue(docType, data, priority) {
    const job = {
      id:        _makeId(),
      docType,
      data,
      priority:  priority || 'normal',
      status:    'pending',
      attempts:  0,
      createdAt: Date.now(),
    };
    _queue.push(job);
    /* high-priority jobs move to front */
    if (job.priority === 'high') {
      _queue.sort(j => j.priority === 'high' ? -1 : 1);
    }
    _processQueue();
    return job.id;
  }

  async function _processQueue() {
    if (_processing || _queue.length === 0) return;
    _processing = true;
    while (true) {
      const job = _queue.find(j => j.status === 'pending');
      if (!job) break;
      job.status = 'processing';
      job.attempts++;
      try {
        await _dispatch(job.docType, job.data);
        job.status = 'done';
        _queue = _queue.filter(j => j.id !== job.id);
        if (window._skToast) window._skToast('Printed successfully', 'success');
      } catch (err) {
        console.error('[SokoniPrint] Job error:', err.message);
        if (job.attempts < MAX_RETRY) {
          job.status = 'pending';
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        } else {
          job.status = 'failed';
          _queue = _queue.filter(j => j.id !== job.id);
          if (window._skToast) window._skToast('Print failed: ' + err.message, 'error');
        }
      }
    }
    _processing = false;
  }

  /* ── Public API ───────────────────────────────────────────────── */
  return {

    /**
     * Load merchant branding.
     * Call once: await SokoniPrint.init(shopId)
     * shopId may be null — falls back to localStorage, then POS session settings.
     */
    init: loadBrand,

    /** Override branding from a plain settings object (no Firestore needed) */
    setBrand(settings) {
      _brand = _normBrand(settings);
      try {
        localStorage.setItem(BRAND_KEY, JSON.stringify({
          shopId: settings?.shopId || settings?.uid,
          brand:  _brand,
          cachedAt: Date.now(),
        }));
      } catch (_) {}
    },

    /** Returns current brand object */
    getBrand,

    /**
     * Print a document immediately.
     * @param {'receipt'|'barcode-label'|'qr-label'|'shelf-tag'|'sticker'|'invoice'|'quotation'|'delivery-note'|'return-slip'} docType
     * @param {object} data
     */
    async print(docType, data) {
      return _dispatch(docType, data);
    },

    /**
     * Add to print queue (auto-retries on transient printer errors).
     * @returns {string} jobId
     */
    queue(docType, data, priority) {
      return _enqueue(docType, data, priority);
    },

    /** Snapshot of pending/failed queue items */
    getQueue() { return _queue.map(j => ({ ...j })); },

    /** Cancel a queued job */
    cancel(jobId) { _queue = _queue.filter(j => j.id !== jobId); },

    /* ── Printer connection pass-throughs ── */
    connectBluetooth() { return window.PosPrinter?.connectBluetooth(); },
    connectUSB()        { return window.PosPrinter?.connectUSB(); },
    connectNetwork(host, port) { return window.PosPrinter?.connectNetwork(host, port); },
    connectBrowser()    { return window.PosPrinter?.connectBrowser(); },
    disconnect()        { return window.PosPrinter?.disconnect(); },
    isConnected()       { return window.PosPrinter?.isConnected() ?? false; },
    getConnectionType() { return window.PosPrinter?.getType() ?? 'none'; },
    openCashDrawer()    { return window.PosPrinter?.openCashDrawer(); },
    setPaperWidth(mm)   { return window.PosPrinter?.setPaperWidth(mm); },

    /** Test print — branded receipt with sample items */
    testPrint() {
      return _dispatch('receipt', {
        receiptNo: 'TEST-001',
        timestamp:    Date.now(),
        cashierName:  'Test Cashier',
        items: [
          { name: 'Test Product A',  qty: 2, price: 150 },
          { name: 'Sample Item B',   qty: 1, price: 250 },
          { name: 'Another Product', qty: 3, price:  80 },
        ],
        subtotal:      640,
        discountAmount: 0,
        taxAmount:     102.4,
        taxRate:       16,
        total:         742.4,
        paymentMethod: 'cash',
        amountPaid:    800,
        change:        57.6,
      });
    },
  };
})();

window.SokoniPrint = SokoniPrint;
