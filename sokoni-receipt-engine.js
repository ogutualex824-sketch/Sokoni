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
  function buildHTML(job, settings = {}) {
    const d    = job.data || {};
    const type = job.type || 'receipt';

    if (type === 'a4' || type === 'invoice' || type === 'quotation') {
      return _buildA4HTML(job, settings);
    }
    if (type === 'label') {
      return _buildLabelHTML(job, settings);
    }
    return _buildReceiptHTML(job, settings);
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

  /* ================================================================
     PUBLIC API
  ================================================================ */
  return {
    buildBytes,
    buildHTML,
    buildShippingLabel,
    /* Individual builders exposed for direct use */
    buildReceiptBytes: _buildReceipt,
    buildReceiptHTML:  _buildReceiptHTML,
    buildA4HTML:       _buildA4HTML,
    buildLabelHTML:    _buildLabelHTML,
  };
})();
