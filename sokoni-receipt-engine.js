/* ================================================================
   SOKONI Receipt Engine v2.0
   All receipt, label, and document templates
   Outputs: ESC/POS bytes or HTML depending on target
================================================================ */
/* global SokoniPrinterDrivers */
window.SokoniReceiptEngine = (() => {
  'use strict';

  const ESC = 0x1B, GS = 0x1D, LF = 0x0A;
  const ENC = new TextEncoder();

  /* ── Byte buffer builder ── */
  function Buf() {
    const buf = [];
    return {
      push(...args) {
        for (const a of args) {
          if (typeof a === 'number') buf.push(a);
          else if (a instanceof Uint8Array) buf.push(...a);
          else if (Array.isArray(a)) buf.push(...a);
          else if (typeof a === 'string') buf.push(...ENC.encode(a));
        }
      },
      get bytes() { return new Uint8Array(buf); },
    };
  }

  /* ── Money formatter ── */
  const KES  = n => 'KES ' + Number(n || 0).toFixed(2);
  const date = (ts) => {
    const d = new Date(ts || Date.now());
    return d.toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' })
      + ' ' + d.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
  };

  /* ── ESC/POS shortcut commands ── */
  const CMD = {
    init:   () => new Uint8Array([ESC, 0x40]),
    lf:     () => new Uint8Array([LF]),
    cut:    ()  => new Uint8Array([GS, 0x56, 0x00]),
    partCut:()  => new Uint8Array([GS, 0x56, 0x01]),
    feed:   n   => new Uint8Array([ESC, 0x64, n || 3]),
    bold:   on  => new Uint8Array([ESC, 0x45, on ? 1 : 0]),
    align:  a   => { const m = {left:0,center:1,right:2}; return new Uint8Array([ESC, 0x61, m[a]||0]); },
    size:   n   => new Uint8Array([GS, 0x21, n||0]),  /* 0=normal,0x11=2x2,0x10=2w,0x01=2h */
    drawer: ()  => new Uint8Array([ESC, 0x70, 0, 0x19, 0xFA]),
    charset:n   => new Uint8Array([ESC, 0x74, n||18]),
  };

  /* ── Column layout helper ── */
  function cols(paperWidth) { return paperWidth >= 80 ? 48 : 32; }

  function _sep(cols_, char = '-')   { return char.repeat(cols_); }
  function _ctr(s, cols_)  { const t = String(s||''); const p = Math.max(0, (cols_ - t.length) >> 1); return ' '.repeat(p) + t; }
  function _right(s, cols_){ const t = String(s||''); return ' '.repeat(Math.max(0, cols_ - t.length)) + t; }
  function _2col(l, r, cols_) {
    const ls = String(l||''), rs = String(r||'');
    return ls + ' '.repeat(Math.max(1, cols_ - ls.length - rs.length)) + rs;
  }

  /* Wrap text at cols width */
  function _wrap(text, cols_) {
    const cols = Math.max(1, cols_ | 0);
    /* A token longer than the paper width has no word boundary to break on, so it
       was pushed whole and the caller's line() silently clipped it (product SKUs and
       long URLs hit this). Hard-break anything wider than the line before wrapping. */
    const words = [];
    for (const w of String(text||'').split(' ')) {
      if (w.length <= cols) { words.push(w); continue; }
      for (let i = 0; i < w.length; i += cols) words.push(w.slice(i, i + cols));
    }
    const lines = []; let cur = '';
    for (const w of words) {
      if (!cur) { cur = w; }
      else if (cur.length + 1 + w.length <= cols) { cur += ' ' + w; }
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  /* ================================================================
     RECEIPT BUILDER — generates ESC/POS byte stream
     Handles: sale receipt, return, exchange, gift, delivery, invoice
  ================================================================ */
  function buildBytes(job, settings = {}) {
    const drv = window.SokoniPrinterDrivers?.ESCPOSDriver;
    if (drv) return drv.build(job, settings);
    return _buildReceipt(job, settings);
  }

  function _buildReceipt(job, settings = {}) {
    const d = job.data || {};
    const pw = settings.paperWidth || d.paperWidth || 80;
    const C  = cols(pw);
    const b  = Buf();
    const line  = s => { b.push(ENC.encode(String(s||'').slice(0, C))); b.push(LF); };
    /* WRAPPING (fix 2026-07-19). line() hard-truncates at the paper width, which silently
       cut identity fields off the receipt. Proven at runtime on 58mm/32 cols:
         "Customer:  Chukwuemeka Oluwaseun"      surname lost
         "Samsung Galaxy S24 Ult"                item cut mid-word
       and on 80mm/48 cols likewise. _wrap() already existed in this file and was used for
       free-text blocks (delivery address, notes, footer, warranty) but never for the
       labelled identity lines or item names.

       wrapLine keeps the label on the first row and indents continuation rows, so
       "Customer: <long name>" stays readable rather than becoming two unrelated lines.
       Truncation is never acceptable on a receipt: a half-printed customer name defeats
       the document's purpose as a record. */
    const wrapLine = (label, value) => {
      const text = String(value == null ? '' : value);
      if ((label + text).length <= C) { line(label + text); return; }
      const indent = ' '.repeat(Math.min(label.length, 4));
      /* The FIRST row must fit label+text within C, so it gets the narrower budget.
         Wrapping the value at (C - indent) and then prepending a longer label pushed
         row one back over the limit and line() truncated it again — which is how the
         80mm case still lost a character after the first attempt at this fix. */
      const first = _wrap(text, Math.max(8, C - label.length));
      const head = first.shift() || '';
      line(label + head);
      /* Remaining words re-wrapped at the indent width. */
      const rest = first.join(' ');
      if (rest) _wrap(rest, Math.max(8, C - indent.length)).forEach(p => line(indent + p));
    };
    const sep   = (c='-') => line(_sep(C, c));
    const ctr   = s => line(_ctr(s, C));
    const right  = s => line(_right(s, C));
    const two   = (l, r) => line(_2col(l, r, C));

    b.push(CMD.init());
    b.push(CMD.charset(18));

    /* ── Header ── */
    const shopName = d.shopName || d.businessName || settings.shopName || 'SOKONI POS';
    b.push(CMD.align('center'), CMD.bold(true), CMD.size(0x11));
    ctr(shopName);
    b.push(CMD.size(0), CMD.bold(false));
    [d.shopAddress || settings.shopAddress, d.shopPhone || settings.shopPhone,
     d.shopEmail || settings.shopEmail, d.shopPin ? 'KRA PIN: ' + d.shopPin : null]
      .filter(Boolean).forEach(ctr);
    b.push(CMD.align('left'));

    /* ── Receipt type banner ── */
    const typeLabels = { return: 'RETURN RECEIPT', exchange: 'EXCHANGE RECEIPT',
      gift: 'GIFT RECEIPT', delivery: 'DELIVERY RECEIPT', invoice: 'TAX INVOICE',
      quotation: 'QUOTATION' };
    if (typeLabels[job.type]) {
      b.push(CMD.align('center'), CMD.bold(true));
      ctr('[ ' + typeLabels[job.type] + ' ]');
      b.push(CMD.bold(false), CMD.align('left'));
    }

    sep();

    /* ── Meta ── */
    line('Date: ' + date(d.timestamp));
    if (d.receiptNo)     line('Receipt #: ' + d.receiptNo);
    if (d.orderNo)       line('Order #:   ' + d.orderNo);
    if (d.invoiceNo)     line('Invoice #: ' + d.invoiceNo);
    if (d.cashierName)   wrapLine('Cashier:   ', d.cashierName);
    if (d.customerName)  wrapLine('Customer:  ', d.customerName);
    if (d.customerPhone) line('Phone:     ' + d.customerPhone);
    if (d.tableName)     wrapLine('Table:     ', d.tableName);
    sep();

    /* ── Items ── */
    if (d.items && d.items.length > 0) {
      (d.items).forEach(item => {
        /* Item names wrap rather than truncate — "Samsung Galaxy S24 Ult" is not a
           record of what was sold. The price row below carries the amounts, so the
           name is free to use the full width. */
        const total = KES(item.price * item.qty);
        _wrap(String(item.name || 'Item'), C).forEach(line);
        two('  ' + KES(item.price) + ' x' + (item.qty || 1), total);
        if (item.discount) two('  Disc: ' + (item.discountNote || ''), '-' + KES(item.discount));
        if (item.notes) { b.push(CMD.size(1)); line('  * ' + item.notes); b.push(CMD.size(0)); }
        if (item.sku)     line('  SKU: ' + item.sku);
        if (item.serial)  line('  S/N: ' + item.serial);
        if (item.warranty) line('  Warranty: ' + item.warranty);
      });
      sep();
    }

    /* ── Totals ── */
    if (d.subtotal  !== undefined)  two('Subtotal:', KES(d.subtotal));
    if (d.discountAmount)           two('Discount:', '-' + KES(d.discountAmount));
    if (d.shippingFee)              two('Delivery:', KES(d.shippingFee));
    if (d.taxRate || d.vatRate) {
      const rate = d.taxRate || d.vatRate;
      const amt  = d.taxAmount || d.vatAmount;
      two(`VAT (${rate}%):`, KES(amt));
    }
    sep('=');
    b.push(CMD.bold(true), CMD.size(0x10));
    two('TOTAL:', KES(d.total));
    b.push(CMD.size(0), CMD.bold(false));
    sep('=');

    /* ── Payment ── */
    if (d.payments && d.payments.length > 0) {
      /* Split payments */
      d.payments.forEach(pay => {
        two(String(pay.method||'').toUpperCase() + ':', KES(pay.amount));
        if (pay.reference) line('  Ref: ' + pay.reference);
      });
    } else {
      if (d.paymentMethod) two('PAYMENT:', String(d.paymentMethod).toUpperCase());
      if (d.mpesaCode)     line('M-Pesa: ' + d.mpesaCode);
      if (d.mpesaPhone)    line('Phone:  ' + d.mpesaPhone);
      if (d.bankRef)       line('Bank Ref: ' + d.bankRef);
      if (d.amountPaid)    two('Paid:', KES(d.amountPaid));
      if (d.change)        two('Change:', KES(d.change));
    }

    /* ── Return / Exchange details ── */
    if (job.type === 'return' || job.type === 'exchange') {
      sep();
      if (d.returnReason)    line('Reason: '  + d.returnReason);
      if (d.refundMethod)    line('Refund to: ' + d.refundMethod);
      if (d.exchangeWith)    line('Exchanged for: ' + d.exchangeWith);
      if (d.originalReceipt) line('Original: #' + d.originalReceipt);
    }

    /* ── Delivery details ── */
    if (job.type === 'delivery') {
      sep();
      line('DELIVERY DETAILS');
      sep('-');
      if (d.deliveryAddress)  _wrap(d.deliveryAddress, C).forEach(line);
      if (d.deliveryPhone)    line('Ph: ' + d.deliveryPhone);
      if (d.deliveryNotes)    _wrap(d.deliveryNotes, C).forEach(line);
      if (d.trackingCode)     line('Track: ' + d.trackingCode);
    }

    /* ── Packing slip ── */
    if (job.type === 'packing') {
      sep();
      line('PACKING SLIP');
      if (d.warehouseNote) _wrap(d.warehouseNote, C).forEach(line);
    }

    /* ── eTIMS / KRA Tax Invoice ── */
    if (d.etimsInvoiceNo || d.etimsQR || d.kraPin) {
      sep('=');
      b.push(CMD.align('center'), CMD.bold(true));
      ctr('KRA TAX INVOICE');
      b.push(CMD.bold(false), CMD.align('left'));
      if (d.kraPin)          line('Supplier PIN: ' + d.kraPin);
      if (d.etimsInvoiceNo)  line('Invoice No:   ' + d.etimsInvoiceNo);
      if (d.etimsCode)       line('Verify Code:  ' + d.etimsCode);
      if (d.etimsTimestamp)  line('Filed at:     ' + date(d.etimsTimestamp));
      if (d.etimsQR) {
        b.push(CMD.align('center'));
        const drv2 = window.SokoniPrinterDrivers?.ESCPOSDriver;
        if (drv2) b.push(drv2.qr(d.etimsQR, 4));
        b.push(CMD.align('left'));
      }
      sep('=');
    }

    /* ── QR (order/website) ── */
    if (settings.showQR && (d.qrData || d.orderUrl)) {
      b.push(CMD.align('center'));
      ctr('Scan to view order');
      const drv3 = window.SokoniPrinterDrivers?.ESCPOSDriver;
      if (drv3) b.push(drv3.qr(d.qrData || d.orderUrl, 5));
      b.push(CMD.align('left'));
    }

    /* ── Barcode (receipt) ── */
    if (settings.showBarcode && d.receiptBarcode) {
      b.push(CMD.align('center'));
      const drv4 = window.SokoniPrinterDrivers?.ESCPOSDriver;
      if (drv4) b.push(drv4.barcode('CODE128', d.receiptBarcode));
      b.push(CMD.align('left'));
    }

    /* ── Footer ── */
    sep();
    b.push(CMD.align('center'));
    const footer = d.footerMessage || settings.footerMessage || 'Thank you for shopping with us!';
    _wrap(footer, C).forEach(ctr);
    ctr('mysokoni.co.ke');
    if (d.surveyUrl) ctr('Review: ' + d.surveyUrl);
    b.push(CMD.align('left'));

    /* ── Warranty / Terms ── */
    if (d.warrantyText) { sep(); b.push(CMD.size(1)); _wrap(d.warrantyText, C * 1.3 | 0).forEach(line); b.push(CMD.size(0)); }

    /* Feed and cut */
    b.push(CMD.feed(4));
    if (settings.autoCut !== false) b.push(CMD.cut());

    return b.bytes;
  }

  /* ================================================================
     HTML RECEIPT BUILDER — for browser print / A4 / PDF
  ================================================================ */
  /* ════════════════════════════════════════════════════════════════════════
     DOCUMENT REGISTRY

     buildHTML() previously hardcoded an if-chain over three types, and
     buildShippingLabel was never reachable through it at all — callers had to
     know to invoke it directly. A registry replaces the chain so a new document
     type is one entry here and NOTHING in checkout changes: checkout asks for a
     document type (or a plan), and the engine resolves the template.

     Each entry declares:
       build   — (job, settings) => html
       printer — logical printer role, for routing (see PRINTER_ROLES)
       carries — what the document is ALLOWED to contain. This is the privacy
                 contract, kept next to the template rather than in prose, so
                 the rule is visible at the point it must be honoured:
                   'money'    line prices and totals
                   'pii'      recipient name, phone, address
                   'internal' commission, settlement, margin

     The dangerous combination is pii + internal on a document that travels with
     a parcel. A packing slip is handled by couriers and customers, so it carries
     pii but MUST NOT carry internal. A merchant receipt is the inverse: internal
     is its purpose, and it never leaves the merchant.
     ════════════════════════════════════════════════════════════════════════ */
  const PRINTER_ROLES = ['receipt', 'packing', 'kitchen', 'label', 'warehouse'];

  const DOC_TYPES = {
    receipt:   { build: (j, s) => _buildReceiptHTML(j, s), printer: 'receipt',   carries: ['money'] },
    customer:  { build: (j, s) => _buildReceiptHTML(j, s), printer: 'receipt',   carries: ['money'] },
    a4:        { build: (j, s) => _buildA4HTML(j, s),      printer: 'receipt',   carries: ['money', 'pii'] },
    invoice:   { build: (j, s) => _buildA4HTML(j, s),      printer: 'receipt',   carries: ['money', 'pii'] },
    quotation: { build: (j, s) => _buildA4HTML(j, s),      printer: 'receipt',   carries: ['money', 'pii'] },
    label:     { build: (j, s) => _buildLabelHTML(j, s),   printer: 'label',     carries: [] },
    shipping:  { build: (j, s) => buildShippingLabel(j, s),printer: 'label',     carries: ['pii'] },
    packing:   { build: (j, s) => _buildPackingSlip(j, s), printer: 'packing',   carries: ['pii'] },
    pickup:    { build: (j, s) => _buildPickupSlip(j, s),  printer: 'receipt',   carries: ['pii'] },
    kitchen:   { build: (j, s) => _buildKitchenTicket(j, s), printer: 'kitchen', carries: [] },
    merchant:  { build: (j, s) => _buildMerchantReceipt(j, s), printer: 'receipt', carries: ['money', 'internal'] },
    manifest:  { build: (j, s) => _buildCourierManifest(j, s), printer: 'warehouse', carries: ['pii'] },
  };

  /* Future-ready: register a document type at runtime without editing this file
     or any checkout code. Refuses to silently replace an existing type. */
  function registerDocument(type, def) {
    if (!type || !def || typeof def.build !== 'function') throw new Error('registerDocument: type and def.build required');
    if (DOC_TYPES[type]) throw new Error('registerDocument: "' + type + '" already registered');
    DOC_TYPES[type] = {
      build:   def.build,
      printer: PRINTER_ROLES.includes(def.printer) ? def.printer : 'receipt',
      carries: Array.isArray(def.carries) ? def.carries : [],
    };
    return true;
  }

  function buildHTML(job, settings = {}) {
    const type = job.type || 'receipt';
    const def  = DOC_TYPES[type] || DOC_TYPES.receipt;
    return def.build(job, settings);
  }

  /* ════════════════════════════════════════════════════════════════════════
     DOCUMENT PLAN — the "smart" in Smart Receipts

     Checkout does not decide which documents to print. It describes the ORDER
     and asks for a plan; the engine decides. Adding a document type or changing
     a fulfilment rule therefore never touches checkout.

     Returns an ordered list of { type, printer, copies }.
     ════════════════════════════════════════════════════════════════════════ */
  function planDocuments(order = {}) {
    const method   = String(order.fulfilment || order.deliveryMethod || order.method || 'walkin').toLowerCase();
    const category = String(order.category || order.merchantCategory || '').toLowerCase();
    const isFood   = /restaurant|food|kitchen|cafe|eatery/.test(category) || order.isFood === true;

    const plan = [];
    const add  = (type) => {
      const def = DOC_TYPES[type];
      if (def) plan.push({ type, printer: def.printer, copies: 1 });
    };

    /* The customer receipt is unconditional — every transaction produces proof
       of payment regardless of how the goods reach the buyer. */
    add('receipt');

    if (/delivery|courier|ship/.test(method))      add('packing');
    else if (/pickup|collect/.test(method))        add('pickup');

    /* Food is orthogonal to fulfilment: a restaurant delivery needs BOTH a
       packing slip and a kitchen ticket. */
    if (isFood) add('kitchen');

    if (order.merchantCopy === true) add('merchant');

    return plan;
  }

  /* Resolve a logical printer role to a configured device. Falls back to the
     receipt printer, then to whatever single printer exists — so a merchant with
     one printer gets every document sequentially rather than losing some. */
  function resolvePrinter(role, printerConfig = {}) {
    return printerConfig[role]
        || printerConfig.receipt
        || printerConfig.default
        || null;
  }

  function _e(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _buildReceiptHTML(job, settings = {}) {
    const d  = job.data || {};
    const pw = settings.paperWidth || d.paperWidth || 80;
    const w  = pw >= 80 ? '80mm' : '58mm';
    const shopName = d.shopName || d.businessName || settings.shopName || 'SOKONI POS';

    const items = (d.items || []).map(i => `
      <tr>
        <td style="padding:2px 4px">${_e(i.name)}<br><small>${_e(i.sku||'')}</small></td>
        <td style="text-align:center">${_e(i.qty)}</td>
        <td style="text-align:right">KES ${Number(i.price).toFixed(2)}</td>
        <td style="text-align:right">KES ${Number(i.price*i.qty).toFixed(2)}</td>
      </tr>`).join('');

    const typeLabel = { return:'RETURN', exchange:'EXCHANGE', gift:'GIFT', delivery:'DELIVERY' }[job.type] || '';

    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Receipt ${_e(d.receiptNo||'')}</title>
    <style>
      @page { size: ${w} auto; margin: 4mm; }
      * { box-sizing: border-box; }
      body { font-family: 'Courier New', monospace; font-size: 11px; width: ${w}; margin: 0 auto; color: #000; }
      .center { text-align: center; }
      .right  { text-align: right; }
      .bold   { font-weight: bold; }
      .big    { font-size: 14px; font-weight: bold; }
      .hr     { border: none; border-top: 1px dashed #000; margin: 4px 0; }
      .hr2    { border: none; border-top: 2px solid #000; margin: 4px 0; }
      table   { width: 100%; border-collapse: collapse; }
      th,td   { font-size: 10px; vertical-align: top; }
      th      { border-bottom: 1px solid #000; padding: 2px 4px; }
      .totrow td { border-top: 1px dashed #000; padding-top: 2px; }
      .final  td { border-top: 2px solid #000; font-weight: bold; font-size: 13px; }
      .small  { font-size: 9px; }
      .badge  { display: inline-block; border: 1px solid #000; padding: 1px 6px; font-weight: bold; }
      .etims  { border: 2px solid #000; padding: 4px; margin: 4px 0; }
      @media print { html,body{width:${w};} }
    </style></head><body>
    <div class="center bold big">${_e(shopName)}</div>
    ${d.shopAddress||settings.shopAddress?`<div class="center">${_e(d.shopAddress||settings.shopAddress)}</div>`:''}
    ${d.shopPhone||settings.shopPhone?`<div class="center">${_e(d.shopPhone||settings.shopPhone)}</div>`:''}
    ${d.shopPin||settings.shopPin?`<div class="center small">KRA PIN: ${_e(d.shopPin||settings.shopPin)}</div>`:''}
    ${typeLabel?`<div class="center badge" style="margin:4px auto">${typeLabel} RECEIPT</div>`:''}
    <hr class="hr">
    <div>Date: ${_e(date(d.timestamp))}</div>
    ${d.receiptNo?`<div>Receipt #: <b>${_e(d.receiptNo)}</b></div>`:''}
    ${d.cashierName?`<div>Cashier: ${_e(d.cashierName)}</div>`:''}
    ${d.customerName?`<div>Customer: ${_e(d.customerName)}</div>`:''}
    <hr class="hr">
    <table>
      <thead><tr><th style="text-align:left">Item</th><th>Qty</th><th class="right">Unit</th><th class="right">Total</th></tr></thead>
      <tbody>${items}</tbody>
    </table>
    <hr class="hr">
    <table>
      ${d.subtotal!==undefined?`<tr class="totrow"><td>Subtotal</td><td class="right">KES ${Number(d.subtotal).toFixed(2)}</td></tr>`:''}
      ${d.discountAmount?`<tr class="totrow"><td>Discount</td><td class="right">-KES ${Number(d.discountAmount).toFixed(2)}</td></tr>`:''}
      ${d.taxRate&&d.taxAmount?`<tr class="totrow"><td>VAT (${_e(d.taxRate)}%)</td><td class="right">KES ${Number(d.taxAmount).toFixed(2)}</td></tr>`:''}
      <tr class="final"><td>TOTAL</td><td class="right">KES ${Number(d.total||0).toFixed(2)}</td></tr>
    </table>
    <hr class="hr">
    ${d.paymentMethod?`<div><b>${_e(String(d.paymentMethod).toUpperCase())}</b></div>`:''}
    ${d.mpesaCode?`<div>M-Pesa: ${_e(d.mpesaCode)}</div>`:''}
    ${d.amountPaid?`<div>Paid: KES ${Number(d.amountPaid).toFixed(2)}</div>`:''}
    ${d.change?`<div>Change: KES ${Number(d.change).toFixed(2)}</div>`:''}
    ${d.etimsInvoiceNo||d.etimsQR?`
    <div class="etims">
      <div class="center bold">KRA TAX INVOICE</div>
      ${d.kraPin?`<div>Supplier PIN: ${_e(d.kraPin)}</div>`:''}
      ${d.etimsInvoiceNo?`<div>Invoice: ${_e(d.etimsInvoiceNo)}</div>`:''}
      ${d.etimsCode?`<div>Verify: ${_e(d.etimsCode)}</div>`:''}
    </div>`:''}
    <hr class="hr">
    <div class="center small">${_e(d.footerMessage||settings.footerMessage||'Thank you for shopping with us!')}</div>
    <div class="center small">mysokoni.co.ke</div>
    <script>setTimeout(()=>{window.print();},300)<\/script>
    </body></html>`;
  }

  function _buildA4HTML(job, settings = {}) {
    const d = job.data || {};
    const shopName = d.shopName || d.businessName || settings.shopName || 'SOKONI';
    const isQuote  = job.type === 'quotation';

    const rows = (d.items || []).map((item, i) => `
      <tr>
        <td style="text-align:center">${i + 1}</td>
        <td>${_e(item.name)}${item.description?`<br><small style="color:#666">${_e(item.description)}</small>`:''}</td>
        <td style="text-align:center">${_e(item.qty)}</td>
        <td style="text-align:right">KES ${Number(item.price).toFixed(2)}</td>
        <td style="text-align:right">KES ${Number((item.price||0)*(item.qty||1)).toFixed(2)}</td>
      </tr>`).join('');

    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>${isQuote?'Quotation':'Invoice'} ${_e(d.invoiceNo||d.receiptNo||'')}</title>
    <style>
      @page { size: A4; margin: 20mm; }
      body { font-family: Arial, sans-serif; font-size: 12px; color: #333; margin: 0; }
      .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; }
      .logo { font-size: 28px; font-weight: bold; color: #1a1a2e; }
      .brand { font-size: 13px; color: #555; }
      .doc-title { font-size: 24px; font-weight: bold; text-align: right; color: #1a1a2e; }
      .meta { display: flex; justify-content: space-between; margin-bottom: 20px; }
      .meta-box { border: 1px solid #ddd; border-radius: 4px; padding: 10px; width: 48%; }
      .meta-box h3 { margin: 0 0 8px; font-size: 13px; color: #888; text-transform: uppercase; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
      thead th { background: #1a1a2e; color: #fff; padding: 8px 12px; text-align: left; }
      tbody tr:nth-child(even) { background: #f9f9f9; }
      td { padding: 8px 12px; border-bottom: 1px solid #eee; }
      .totals { display: flex; justify-content: flex-end; }
      .totals table { width: 280px; }
      .totals td { padding: 4px 12px; }
      .totals .grand { font-size: 16px; font-weight: bold; background: #f0f0f0; }
      .footer { margin-top: 40px; border-top: 1px solid #ddd; padding-top: 10px; font-size: 11px; color: #888; }
      .etims { border: 2px solid #333; padding: 12px; margin-top: 20px; }
      @media print { html,body{-webkit-print-color-adjust:exact;} }
    </style></head><body>
    <div class="header">
      <div>
        <div class="logo">${_e(shopName)}</div>
        <div class="brand">${_e(d.shopAddress||settings.shopAddress||'')}</div>
        <div class="brand">${_e(d.shopPhone||settings.shopPhone||'')}</div>
        ${d.shopPin||settings.shopPin?`<div class="brand">KRA PIN: ${_e(d.shopPin||settings.shopPin)}</div>`:''}
      </div>
      <div>
        <div class="doc-title">${isQuote?'QUOTATION':'TAX INVOICE'}</div>
        <div style="text-align:right;margin-top:8px">
          <div><b>#:</b> ${_e(d.invoiceNo||d.receiptNo||'')}</div>
          <div><b>Date:</b> ${_e(date(d.timestamp))}</div>
          ${d.dueDate?`<div><b>Due:</b> ${_e(d.dueDate)}</div>`:''}
          ${!isQuote&&d.etimsInvoiceNo?`<div><b>eTIMS:</b> ${_e(d.etimsInvoiceNo)}</div>`:''}
        </div>
      </div>
    </div>
    <div class="meta">
      <div class="meta-box">
        <h3>Bill To</h3>
        <div><b>${_e(d.customerName||'Customer')}</b></div>
        ${d.customerAddress?`<div>${_e(d.customerAddress)}</div>`:''}
        ${d.customerPhone?`<div>${_e(d.customerPhone)}</div>`:''}
        ${d.customerPin?`<div>PIN: ${_e(d.customerPin)}</div>`:''}
      </div>
      <div class="meta-box">
        <h3>Details</h3>
        ${d.poNumber?`<div><b>PO #:</b> ${_e(d.poNumber)}</div>`:''}
        ${d.cashierName?`<div><b>Sales Rep:</b> ${_e(d.cashierName)}</div>`:''}
        ${d.paymentMethod?`<div><b>Payment:</b> ${_e(d.paymentMethod)}</div>`:''}
        ${d.paymentTerms?`<div><b>Terms:</b> ${_e(d.paymentTerms)}</div>`:''}
      </div>
    </div>
    <table>
      <thead><tr><th>#</th><th>Description</th><th style="text-align:center">Qty</th><th style="text-align:right">Unit Price</th><th style="text-align:right">Amount</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="totals"><table>
      ${d.subtotal!==undefined?`<tr><td>Subtotal</td><td style="text-align:right">KES ${Number(d.subtotal).toFixed(2)}</td></tr>`:''}
      ${d.discountAmount?`<tr><td>Discount</td><td style="text-align:right">-KES ${Number(d.discountAmount).toFixed(2)}</td></tr>`:''}
      ${d.taxRate&&d.taxAmount?`<tr><td>VAT (${_e(d.taxRate)}%)</td><td style="text-align:right">KES ${Number(d.taxAmount).toFixed(2)}</td></tr>`:''}
      <tr class="grand"><td>TOTAL</td><td style="text-align:right">KES ${Number(d.total||0).toFixed(2)}</td></tr>
    </table></div>
    ${d.etimsInvoiceNo||d.etimsQR?`
    <div class="etims">
      <b>KRA Tax Invoice Details</b><br>
      ${d.kraPin?`Supplier PIN: ${_e(d.kraPin)}<br>`:''}
      Invoice No: ${_e(d.etimsInvoiceNo||'')}<br>
      Verify: ${_e(d.etimsCode||'')}
    </div>`:''}
    ${d.notes?`<div style="margin-top:20px"><b>Notes:</b><br>${_e(d.notes)}</div>`:''}
    <div class="footer">
      <p>${_e(d.footerMessage||settings.footerMessage||'Thank you for your business!')}</p>
      <p>mysokoni.co.ke — Powered by SOKONI</p>
    </div>
    <script>setTimeout(()=>{window.print();},400)<\/script>
    </body></html>`;
  }

  function _buildLabelHTML(job, settings = {}) {
    const d    = job.data || {};
    const opts = d.labelOpts || {};
    const w    = opts.widthMM  || 40;
    const h    = opts.heightMM || 30;
    const items = d.items || [d];

    const labelCards = items.map(item => `
      <div class="label" style="width:${w}mm;height:${h}mm">
        <div class="shop">${_e(item.shopName||settings.shopName||'')}</div>
        <div class="name">${_e(String(item.name||'').slice(0,22))}</div>
        ${item.variant?`<div class="variant">${_e(item.variant)}</div>`:''}
        ${item.price!==undefined?`<div class="price">KES ${Number(item.price).toFixed(2)}</div>`:''}
        ${item.barcode?`<div class="barcode">${_e(item.barcode)}</div>`:''}
        ${item.expiry?`<div class="expiry">EXP: ${_e(item.expiry)}</div>`:''}
      </div>`).join('');

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Labels</title>
    <style>
      @page { size: ${w}mm ${h}mm; margin: 1mm; }
      body { font-family: Arial, sans-serif; margin: 0; }
      .label { border: 1px dashed #ccc; display: flex; flex-direction: column;
               justify-content: center; align-items: center; text-align: center;
               padding: 2mm; overflow: hidden; }
      .shop    { font-size: 7px; color: #666; }
      .name    { font-size: 9px; font-weight: bold; line-height: 1.2; }
      .variant { font-size: 8px; color: #555; }
      .price   { font-size: 12px; font-weight: bold; color: #1a1a2e; margin: 1mm 0; }
      .barcode { font-size: 7px; font-family: monospace; letter-spacing: 1px; }
      .expiry  { font-size: 7px; color: #888; }
    </style></head>
    <body>${labelCards}
    <script>setTimeout(()=>{window.print();},300)<\/script>
    </body></html>`;
  }

  /* ================================================================
     SHIPPING LABEL (A6/100×150mm format)
  ================================================================ */
  function buildShippingLabel(job, settings = {}) {
    const d = job.data || {};
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Shipping Label</title>
    <style>
      @page { size: 100mm 150mm; margin: 5mm; }
      body { font-family: Arial, sans-serif; font-size: 12px; }
      .border { border: 3px solid #000; padding: 4mm; height: 140mm; display: flex; flex-direction: column; }
      .from   { font-size: 10px; color: #666; margin-bottom: 4mm; }
      .to     { font-size: 16px; font-weight: bold; border: 2px solid #000; padding: 4mm; flex: 1; }
      .barcode{ text-align: center; margin-top: 4mm; font-family: monospace; font-size: 18px; }
      .track  { text-align: center; font-size: 10px; margin-top: 2mm; }
    </style></head><body>
    <div class="border">
      <div class="from">
        FROM: ${_e(d.senderName||d.shopName||settings.shopName||'SOKONI')}<br>
        ${_e(d.senderAddress||d.shopAddress||settings.shopAddress||'')}
      </div>
      <div class="to">
        TO:<br>
        <b>${_e(d.recipientName||d.customerName||'')}</b><br>
        ${_e(d.deliveryAddress||d.customerAddress||'')}<br>
        ${_e(d.deliveryPhone||d.customerPhone||'')}
      </div>
      ${d.trackingCode?`<div class="barcode">${_e(d.trackingCode)}</div><div class="track">${_e(d.trackingCode)}</div>`:''}
      ${d.orderNo?`<div class="track">Order: ${_e(d.orderNo)}</div>`:''}
    </div>
    <script>setTimeout(()=>{window.print();},300)<\/script>
    </body></html>`;
  }

  /* ════════════════════════════════════════════════════════════════════════
     SHARED CHROME for the fulfilment documents below.
     _thermal() wraps a body in the same 58/80mm page setup the receipt uses, so
     these print on the merchant's existing paper without new configuration.
     ════════════════════════════════════════════════════════════════════════ */
  function _thermal(title, bodyHtml, settings = {}, d = {}) {
    const pw = settings.paperWidth || d.paperWidth || 80;
    const w  = pw >= 80 ? '80mm' : '58mm';
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${_e(title)}</title>
    <style>
      @page { size: ${w} auto; margin: 0; }
      body { width:${w}; margin:0; padding:4mm; font-family:'Courier New',monospace;
             font-size:12px; line-height:1.45; color:#000; background:#fff; }
      .c { text-align:center; } .r { text-align:right; } .b { font-weight:bold; }
      .xl { font-size:20px; font-weight:bold; letter-spacing:.5px; }
      .lg { font-size:15px; font-weight:bold; }
      .sm { font-size:10px; }
      .sep { border-top:1px dashed #000; margin:6px 0; }
      .solid { border-top:2px solid #000; margin:6px 0; }
      .row { display:flex; justify-content:space-between; gap:8px; }
      .box { border:2px solid #000; padding:5px; margin:5px 0; }
      .fill { border-bottom:1px solid #000; min-height:16px; margin-top:2px; }
      table { width:100%; border-collapse:collapse; }
      td { padding:2px 0; vertical-align:top; }
      .qr { text-align:center; margin-top:8px; }
    </style></head><body>${bodyHtml}
    <script>setTimeout(function(){window.print();},300)<\/script>
    </body></html>`;
  }

  /* A labelled blank that a human fills in by hand after printing. */
  function _blank(label) {
    return `<div class="sm">${_e(label)}</div><div class="fill"></div>`;
  }

  /* ── PACKING SLIP ────────────────────────────────────────────────────────
     Travels ON or IN the parcel. Handled by warehouse staff, couriers and the
     customer, so it carries full recipient PII — that is its job — and MUST NOT
     carry prices, commission, settlement or margin. It deliberately never reads
     d.commission / d.settlement / d.total: an internal figure printed on a
     package is visible to everyone who handles it, including the buyer, who
     would then see the merchant's margin.

     Rider name, phone, dispatch time, delivery time and signature are printed as
     BLANKS, to be completed by hand at handover. */
  function _buildPackingSlip(job, settings = {}) {
    const d   = job.data || {};
    const a   = d.address || d.deliveryAddress || {};
    const nm  = d.recipientName || d.customerName || '';
    const ph  = d.recipientPhone || d.customerPhone || d.deliveryPhone || '';
    const alt = d.altPhone || d.alternativePhone || '';

    /* Address may arrive as a structured object or a single string. */
    const addrLines = typeof a === 'string' ? [a] : [
      a.building && (a.building + (a.house ? ', ' + a.house : '') + (a.floor ? ', Floor ' + a.floor : '')),
      a.street, a.area, a.town, a.county,
    ].filter(Boolean);

    const items = (d.items || []).map(i =>
      `<tr><td class="b">${_e(String(i.qty || 1))}×</td><td>${_e(i.name || i.title || 'Item')}${
        i.sku ? `<div class="sm">SKU ${_e(i.sku)}</div>` : ''}</td></tr>`).join('');

    const flags = [
      d.fragile ? 'FRAGILE' : '',
      d.cod ? 'CASH ON DELIVERY' : (d.prepaid !== false ? 'PREPAID' : ''),
    ].filter(Boolean);

    return _thermal('Packing Slip', `
      <div class="c xl">PACKING SLIP</div>
      <div class="c sm">${_e(d.shopName || d.merchantName || settings.shopName || 'SOKONI')}</div>
      <div class="solid"></div>

      <div class="row b"><span>Order</span><span>${_e(d.orderNo || d.orderId || '')}</span></div>
      <div class="row"><span>Package</span><span>${_e(String(d.packageNo || 1))} of ${_e(String(d.packageCount || 1))}</span></div>
      <div class="row"><span>Items</span><span>${_e(String((d.items || []).length))}</span></div>
      ${d.weight ? `<div class="row"><span>Weight</span><span>${_e(String(d.weight))}</span></div>` : ''}
      ${flags.length ? `<div class="box c b">${flags.map(f => _e(f)).join(' · ')}</div>` : ''}

      <div class="sep"></div>
      <div class="b">DELIVER TO</div>
      <div class="box">
        <div class="lg">${_e(nm)}</div>
        <div class="b">${_e(ph)}</div>
        ${alt ? `<div class="sm">Alt: ${_e(alt)}</div>` : ''}
        <div style="margin-top:4px">${addrLines.map(l => _e(l)).join('<br>')}</div>
        ${a.landmark ? `<div class="sm" style="margin-top:3px">Landmark: ${_e(a.landmark)}</div>` : ''}
      </div>
      ${d.deliveryNotes ? `<div class="sm b">Notes:</div><div class="sm">${_e(d.deliveryNotes)}</div>` : ''}

      <div class="sep"></div>
      <div class="b">CONTENTS</div>
      <table>${items || '<tr><td>—</td></tr>'}</table>

      <div class="sep"></div>
      <div class="b">FROM</div>
      <div class="sm">${_e(d.merchantName || d.shopName || '')}<br>${_e(d.merchantPhone || '')}<br>${_e(d.merchantAddress || '')}</div>

      <div class="solid"></div>
      <div class="b">COURIER — complete at handover</div>
      ${_blank('Rider name')}
      ${_blank('Rider phone')}
      ${_blank('Dispatch time')}
      ${_blank('Delivery time')}
      ${_blank('Recipient signature')}

      ${d.verifyUrl || d.orderNo ? `<div class="qr">
        <canvas id="sk-doc-qr" width="110" height="110"></canvas>
        <div class="sm">${_e(d.deliveryOtp ? 'OTP ' + d.deliveryOtp : (d.orderNo || ''))}</div>
        <script>(function(){var u=${JSON.stringify(String(d.verifyUrl || d.orderNo || ''))};
          var c=document.getElementById('sk-doc-qr');
          if(window.QRCode&&c){try{window.QRCode.toCanvas(c,u,{width:110,margin:0});}catch(e){}}
        })()<\/script>
      </div>` : ''}
      <div class="c sm" style="margin-top:6px">Scan to verify order · confirm delivery · process return</div>
    `, settings, d);
  }

  /* ── PICKUP / COLLECTION SLIP ────────────────────────────────────────────
     No courier block and no address: nothing is being shipped. The pickup code
     is the operative field, so it is the largest thing on the slip. */
  function _buildPickupSlip(job, settings = {}) {
    const d = job.data || {};
    return _thermal('Pickup Slip', `
      <div class="c xl">COLLECTION SLIP</div>
      <div class="c sm">${_e(d.shopName || d.merchantName || settings.shopName || 'SOKONI')}</div>
      <div class="solid"></div>

      <div class="c sm">PICKUP CODE</div>
      <div class="box c xl" style="letter-spacing:3px">${_e(d.pickupCode || d.collectionCode || d.orderNo || '')}</div>

      <div class="row"><span>Order</span><span class="b">${_e(d.orderNo || d.orderId || '')}</span></div>
      <div class="row"><span>Name</span><span class="b">${_e(d.customerName || d.recipientName || '')}</span></div>
      <div class="row"><span>Phone</span><span>${_e(d.customerPhone || d.recipientPhone || '')}</span></div>
      <div class="row"><span>Items</span><span>${_e(String((d.items || []).length))}</span></div>

      <div class="sep"></div>
      <div class="b">COLLECT FROM</div>
      <div>${_e(d.pickupLocation || d.merchantAddress || d.shopAddress || '')}</div>
      ${d.pickupHours ? `<div class="sm">${_e(d.pickupHours)}</div>` : ''}
      ${d.pickupDeadline ? `<div class="box c b">Collect by ${_e(d.pickupDeadline)}</div>` : ''}

      <div class="qr">
        <canvas id="sk-doc-qr" width="110" height="110"></canvas>
        <script>(function(){var u=${JSON.stringify(String(d.verifyUrl || d.pickupCode || d.orderNo || ''))};
          var c=document.getElementById('sk-doc-qr');
          if(window.QRCode&&c){try{window.QRCode.toCanvas(c,u,{width:110,margin:0});}catch(e){}}
        })()<\/script>
        <div class="sm">Present this code when collecting</div>
      </div>
    `, settings, d);
  }

  /* ── KITCHEN TICKET ──────────────────────────────────────────────────────
     Production instruction, not a financial document. NO prices, NO totals, NO
     customer contact details — kitchen staff need what to cook, and printing a
     customer's phone number in a food-prep area is a needless PII exposure.
     Large type: read at arm's length in a busy kitchen. */
  function _buildKitchenTicket(job, settings = {}) {
    const d = job.data || {};
    const rows = (d.items || []).map(i => {
      const mods = (i.modifiers || i.options || []);
      return `<tr><td class="xl" style="width:36px">${_e(String(i.qty || 1))}×</td>
        <td><span class="lg">${_e(i.name || i.title || 'Item')}</span>
        ${mods.length ? `<div class="sm">${mods.map(m => '+ ' + _e(typeof m === 'string' ? m : (m.name || ''))).join('<br>')}</div>` : ''}
        ${i.notes ? `<div class="sm b">** ${_e(i.notes)} **</div>` : ''}</td></tr>`;
    }).join('');

    const dest = d.tableNo ? ('TABLE ' + d.tableNo)
               : /delivery/i.test(String(d.fulfilment || d.deliveryMethod || '')) ? 'DELIVERY'
               : /pickup|collect/i.test(String(d.fulfilment || d.deliveryMethod || '')) ? 'PICKUP'
               : 'COUNTER';

    return _thermal('Kitchen Ticket', `
      <div class="c xl">${_e(dest)}</div>
      <div class="solid"></div>
      <div class="row"><span class="b">Order</span><span class="lg">${_e(d.orderNo || d.orderId || '')}</span></div>
      <div class="row sm"><span>Placed</span><span>${_e(d.time || new Date().toLocaleTimeString('en-KE'))}</span></div>
      ${d.courseNo ? `<div class="row sm"><span>Course</span><span>${_e(String(d.courseNo))}</span></div>` : ''}
      <div class="sep"></div>
      <table>${rows || '<tr><td>—</td></tr>'}</table>
      ${d.orderNotes ? `<div class="sep"></div><div class="b">NOTES</div><div class="lg">${_e(d.orderNotes)}</div>` : ''}
      <div class="solid"></div>
      <div class="c sm">No prices — kitchen copy</div>
    `, settings, d);
  }

  /* ── MERCHANT RECEIPT ────────────────────────────────────────────────────
     The inverse of the packing slip: this is the ONLY fulfilment document that
     may carry commission, settlement and margin, and it never leaves the
     merchant. Keep it off the parcel. */
  function _buildMerchantReceipt(job, settings = {}) {
    const d   = job.data || {};
    const kes = n => 'KES ' + Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const row = (l, v, b) => `<div class="row${b ? ' b' : ''}"><span>${_e(l)}</span><span>${_e(v)}</span></div>`;

    return _thermal('Merchant Copy', `
      <div class="c xl">MERCHANT COPY</div>
      <div class="c sm">NOT FOR CUSTOMER</div>
      <div class="solid"></div>

      ${row('Receipt', d.receiptNo || '')}
      ${row('Order', d.orderNo || d.orderId || '')}
      ${row('Date', d.date || new Date().toLocaleString('en-KE'))}
      ${d.cashierName ? row('Cashier', d.cashierName) : ''}
      ${d.registerNo ? row('Register', String(d.registerNo)) : ''}
      ${d.shiftNo ? row('Shift', String(d.shiftNo)) : ''}

      <div class="sep"></div>
      ${row('Gross', kes(d.total || d.grandTotal))}
      ${(d.discount || 0) > 0 ? row('Discount', '-' + kes(d.discount)) : ''}
      ${(d.tax || 0) > 0 ? row('VAT', kes(d.tax)) : ''}
      ${d.commission != null ? row('Platform commission', '-' + kes(d.commission)) : ''}
      ${d.gatewayFee != null ? row('Gateway fee', '-' + kes(d.gatewayFee)) : ''}
      <div class="solid"></div>
      ${row('SETTLEMENT DUE', kes(d.settlementAmount != null ? d.settlementAmount : d.sellerNet), true)}
      ${d.settlementStatus ? row('Status', d.settlementStatus) : ''}

      <div class="sep"></div>
      ${row('Paid via', d.paymentMethod || '')}
      ${d.paymentRef || d.mpesaCode ? row('Reference', d.paymentRef || d.mpesaCode) : ''}
      <div class="c sm" style="margin-top:6px">Retain for reconciliation</div>
    `, settings, d);
  }

  /* ── COURIER MANIFEST ────────────────────────────────────────────────────
     One document per TRIP, not per order — the rider's worksheet. Lists stops in
     route order with contact numbers, COD amounts to collect, and a signature
     column. COD is the one money figure a courier legitimately needs. */
  function _buildCourierManifest(job, settings = {}) {
    const d     = job.data || {};
    const stops = d.stops || d.deliveries || [];
    const kes   = n => Number(n || 0).toLocaleString('en-KE');
    const codTotal = stops.reduce((s, x) => s + (Number(x.codAmount) || 0), 0);

    const rows = stops.map((s, i) => `
      <tr style="border-bottom:1px solid #000">
        <td class="b" style="width:22px">${i + 1}</td>
        <td>
          <span class="b">${_e(s.recipientName || s.customerName || '')}</span>
          <div class="sm">${_e(s.phone || s.recipientPhone || '')}</div>
          <div class="sm">${_e(typeof s.address === 'string' ? s.address : [s.address && s.address.area, s.address && s.address.town].filter(Boolean).join(', '))}</div>
          <div class="sm">Order ${_e(s.orderNo || '')}</div>
        </td>
        <td class="r" style="width:70px">
          ${Number(s.codAmount) > 0 ? `<span class="b">COD<br>${kes(s.codAmount)}</span>` : '<span class="sm">PREPAID</span>'}
          <div class="fill"></div>
        </td>
      </tr>`).join('');

    return _thermal('Courier Manifest', `
      <div class="c xl">COURIER MANIFEST</div>
      <div class="c sm">${_e(d.tripId || d.manifestNo || '')} · ${_e(d.date || new Date().toLocaleDateString('en-KE'))}</div>
      <div class="solid"></div>
      ${d.riderName ? `<div class="row"><span>Rider</span><span class="b">${_e(d.riderName)}</span></div>` : _blank('Rider name')}
      ${d.riderPhone ? `<div class="row"><span>Phone</span><span>${_e(d.riderPhone)}</span></div>` : ''}
      <div class="row"><span>Stops</span><span class="b">${_e(String(stops.length))}</span></div>
      ${codTotal > 0 ? `<div class="box c b">COD TO COLLECT: KES ${kes(codTotal)}</div>` : ''}
      <div class="sep"></div>
      <table>${rows || '<tr><td>No stops</td></tr>'}</table>
      <div class="solid"></div>
      ${_blank('Dispatched by / time')}
      ${_blank('Cash reconciled by / time')}
      <div class="c sm" style="margin-top:6px">Signature column: recipient signs on delivery</div>
    `, settings, d);
  }

  /* ================================================================
     PUBLIC API
  ================================================================ */
  return {
    buildBytes,
    buildHTML,
    buildShippingLabel,
    /* Smart document selection — checkout describes the order, engine decides */
    planDocuments,
    registerDocument,
    resolvePrinter,
    documentTypes: () => Object.keys(DOC_TYPES),
    documentMeta:  (t) => DOC_TYPES[t] || null,
    PRINTER_ROLES,
    /* Individual builders exposed for direct use */
    buildReceiptBytes: _buildReceipt,
    buildReceiptHTML:  _buildReceiptHTML,
    buildA4HTML:       _buildA4HTML,
    buildLabelHTML:    _buildLabelHTML,
    buildPackingSlip:   _buildPackingSlip,
    buildPickupSlip:    _buildPickupSlip,
    buildKitchenTicket: _buildKitchenTicket,
    buildMerchantReceipt: _buildMerchantReceipt,
    buildCourierManifest: _buildCourierManifest,
  };
})();
