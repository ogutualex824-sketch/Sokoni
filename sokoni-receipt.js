/**
 * SOKONI Receipt Printing Module
 * Supports:
 *  - Thermal 58mm / 80mm ESC/POS via window.print()
 *  - Browser print (desktop/mobile)
 *  - PDF download via print-to-PDF
 *  - QR code on receipt (order scan URL)
 */
(function () {
  'use strict';

  const BRAND_NAME  = 'SOKONI';
  const BRAND_SUB   = 'mysokoni.co.ke';
  const SUPPORT_TEL = '+254 800 SOKONI';
  const RECEIPT_CSS = `
    @page { size: 80mm auto; margin: 0; }
    @media print {
      body { margin: 0 !important; }
      .no-print { display: none !important; }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Courier New', Courier, monospace;
      font-size: 12px;
      background: white;
      color: black;
      width: 80mm;
      max-width: 80mm;
    }
    .rct-wrap    { width: 80mm; padding: 4mm; }
    .rct-center  { text-align: center; }
    .rct-right   { text-align: right; }
    .rct-logo    { font-size: 22px; font-weight: 900; letter-spacing: 0.1em; margin-bottom: 2px; }
    .rct-brand-sub { font-size: 10px; color: #555; margin-bottom: 6px; }
    .rct-divider { border: none; border-top: 1px dashed #aaa; margin: 6px 0; }
    .rct-divider-solid { border: none; border-top: 2px solid black; margin: 6px 0; }
    .rct-meta    { font-size: 10px; color: #444; margin-bottom: 2px; }
    .rct-title   { font-size: 13px; font-weight: 900; margin: 4px 0; }
    .rct-row     { display: flex; justify-content: space-between; padding: 2px 0; font-size: 11px; }
    .rct-row-item{ flex: 1; }
    .rct-row-qty { width: 28px; text-align: center; flex-shrink: 0; }
    .rct-row-price { width: 54px; text-align: right; flex-shrink: 0; font-weight: 700; }
    .rct-total   { font-size: 15px; font-weight: 900; }
    .rct-tax     { font-size: 10px; color: #555; }
    .rct-footer  { font-size: 10px; color: #666; margin-top: 6px; line-height: 1.5; }
    .rct-qr      { margin: 8px auto 4px; display: block; }
    .rct-thankyou{ font-size: 13px; font-weight: 900; letter-spacing: 0.05em; }
  `;

  /* ── Formatting helpers ── */
  function _fmt(n) {
    return 'KES ' + Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function _esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function _padRight(s, n) { return String(s).substring(0, n).padEnd(n); }
  function _padLeft(s, n)  { return String(s).substring(0, n).padStart(n); }
  function _date(d) {
    const dt = d ? new Date(d) : new Date();
    return dt.toLocaleString('en-KE', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
  }

  /* ── QR image builder (uses SokoniQR if available, else placeholder) ── */
  async function _qrDataURL(text) {
    if (window.SokoniQR) {
      try { return await window.SokoniQR.toDataURL(text, { width: 120, color: { dark: '#000000', light: '#ffffff' } }); }
      catch (_) {}
    }
    return null;
  }

  /* ── Build receipt HTML ── */
  async function buildHTML(opts) {
    const {
      type       = 'sale',      // 'sale' | 'refund' | 'quote' | 'delivery'
      orderId    = '',
      items      = [],          // [{ name, qty, unitPrice, discount? }]
      subtotal   = 0,
      discount   = 0,
      tax        = 0,
      total      = 0,
      method     = 'M-Pesa',
      mpesaRef   = '',
      cashier    = '',
      storeName  = '',
      storeAddr  = '',
      storeTel   = '',
      customer   = '',
      note       = '',
      date       = null,
      showQR     = true,
      vatRate    = 16,          // % for VAT line display
    } = opts;

    const typeLabelMap = { sale: 'RECEIPT', refund: 'REFUND', quote: 'QUOTATION', delivery: 'DELIVERY NOTE' };
    const typeLabel = typeLabelMap[type] || 'RECEIPT';
    const qrText    = orderId ? `https://mysokoni.co.ke/scan?t=order&id=${orderId}` : '';
    const qrImg     = (showQR && qrText) ? await _qrDataURL(qrText) : null;
    const qrTag     = qrImg
      ? `<img src="${qrImg}" class="rct-qr" width="100" height="100" alt="Scan to track">`
      : (qrText ? `<div class="rct-center rct-meta" style="font-size:9px;">Scan: ${_esc(qrText)}</div>` : '');

    const itemRows = items.map(it => {
      const lineTotal = (Number(it.qty || 1) * Number(it.unitPrice || 0)) - Number(it.discount || 0);
      return `<div class="rct-row">
        <span class="rct-row-item">${_esc(it.name || '—')}</span>
        <span class="rct-row-qty">${Number(it.qty || 1)}x</span>
        <span class="rct-row-price">${_fmt(lineTotal)}</span>
      </div>`;
    }).join('');

    const vatAmt = tax || (total - discount > 0 ? (total - discount) * vatRate / (100 + vatRate) : 0);

    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<title>Receipt ${_esc(orderId)}</title>
<style>${RECEIPT_CSS}</style>
</head>
<body>
<div class="rct-wrap">

  <!-- Header -->
  <div class="rct-center">
    <div class="rct-logo">${_esc(storeName || BRAND_NAME)}</div>
    <div class="rct-brand-sub">${_esc(storeAddr || BRAND_SUB)}</div>
    ${storeTel ? `<div class="rct-meta">Tel: ${_esc(storeTel)}</div>` : ''}
    <hr class="rct-divider-solid">
    <div class="rct-title">${typeLabel}</div>
  </div>

  <!-- Order meta -->
  <div style="margin: 6px 0;">
    ${orderId  ? `<div class="rct-meta">Order #: <strong>${_esc(orderId)}</strong></div>` : ''}
    ${customer ? `<div class="rct-meta">Customer: ${_esc(customer)}</div>` : ''}
    ${cashier  ? `<div class="rct-meta">Cashier: ${_esc(cashier)}</div>` : ''}
    <div class="rct-meta">Date: ${_date(date)}</div>
  </div>
  <hr class="rct-divider">

  <!-- Items -->
  <div class="rct-row" style="font-weight:900;font-size:11px;border-bottom:1px solid black;padding-bottom:3px;margin-bottom:3px;">
    <span class="rct-row-item">ITEM</span>
    <span class="rct-row-qty">QTY</span>
    <span class="rct-row-price">TOTAL</span>
  </div>
  ${itemRows}
  <hr class="rct-divider">

  <!-- Totals -->
  <div class="rct-row rct-tax"><span>Subtotal</span><span>${_fmt(subtotal || total)}</span></div>
  ${discount > 0 ? `<div class="rct-row rct-tax"><span>Discount</span><span>-${_fmt(discount)}</span></div>` : ''}
  ${vatAmt > 0   ? `<div class="rct-row rct-tax"><span>VAT (${vatRate}%) incl.</span><span>${_fmt(vatAmt)}</span></div>` : ''}
  <hr class="rct-divider">
  <div class="rct-row" style="margin:4px 0;">
    <span class="rct-total">TOTAL</span>
    <span class="rct-total">${_fmt(total)}</span>
  </div>
  <div class="rct-row rct-tax"><span>Paid via</span><span>${_esc(method)}</span></div>
  ${mpesaRef ? `<div class="rct-row rct-tax"><span>M-Pesa Ref</span><span>${_esc(mpesaRef)}</span></div>` : ''}
  <div class="rct-row rct-tax" style="font-weight:900;color:green;"><span>CHANGE</span><span>${_fmt(0)}</span></div>

  <!-- QR code -->
  <hr class="rct-divider">
  <div class="rct-center">
    ${qrTag}
    ${orderId ? `<div class="rct-meta" style="font-size:9px;margin-top:2px;">Scan to track order</div>` : ''}
  </div>

  <!-- Footer -->
  <hr class="rct-divider">
  ${note ? `<div class="rct-meta" style="margin-bottom:4px;">Note: ${_esc(note)}</div>` : ''}
  <div class="rct-center rct-footer">
    <div class="rct-thankyou">★ THANK YOU! ★</div>
    <div style="margin-top:4px;">Support: ${SUPPORT_TEL}</div>
    <div>${BRAND_SUB}</div>
    <div style="font-size:9px;margin-top:4px;color:#888;">
      Powered by SOKONI SmartPOS · VAT PIN: P051234567X
    </div>
    <div style="font-size:9px;margin-top:2px;color:#888;">
      Operated by Bravilex International Co. Limited
    </div>
  </div>

</div>
</body></html>`;
  }

  /* ── Print in a new window ── */
  async function printReceipt(opts) {
    const html = await buildHTML(opts);
    const blobUrl = URL.createObjectURL(new Blob([html], {type:'text/html;charset=utf-8'}));
    const w = window.open(blobUrl, '_blank', 'width=350,height=600,scrollbars=yes');
    if (!w) { URL.revokeObjectURL(blobUrl); alert('Pop-up blocked. Allow pop-ups for printing.'); return; }
    w.focus();
    /* Give QR image time to load before printing, then revoke blob URL */
    setTimeout(() => { w.print(); URL.revokeObjectURL(blobUrl); }, 600);
  }

  /* ── Download as PDF (using print dialog save-as-PDF) ── */
  async function downloadPDF(opts) {
    await printReceipt({ ...opts, showQR: true });
  }

  /* ── Inline preview in an iframe ── */
  async function previewInto(iframeId, opts) {
    const el = document.getElementById(iframeId);
    if (!el) return;
    const html = await buildHTML(opts);
    el.srcdoc = html;
  }

  /* ── Build from a Firestore order document ── */
  function fromOrder(orderDoc, storeOpts = {}) {
    const o = orderDoc;
    const items = (o.items || o.cart || []).map(it => ({
      name:      it.name || it.productName || '—',
      qty:       it.qty  || it.quantity    || 1,
      unitPrice: it.price || it.unitPrice  || 0,
      discount:  it.discount || 0,
    }));
    return {
      type:      'sale',
      orderId:   o.id || o.orderId || '',
      items,
      subtotal:  o.subtotal || o.total,
      discount:  o.discount || 0,
      tax:       o.tax || 0,
      total:     o.total || o.amount || 0,
      method:    o.paymentMethod || o.method || 'M-Pesa',
      mpesaRef:  o.mpesaRef || o.paymentRef || '',
      customer:  o.buyerName || o.customerName || '',
      date:      o.createdAt?.toDate ? o.createdAt.toDate() : (o.createdAt || null),
      storeName: storeOpts.storeName || '',
      storeAddr: storeOpts.storeAddr || '',
      storeTel:  storeOpts.storeTel  || '',
      cashier:   storeOpts.cashier   || '',
    };
  }

  /* ── Thermal 58mm variant (narrower, smaller font) ── */
  async function print58mm(opts) {
    const html = (await buildHTML(opts))
      .replace('width: 80mm', 'width: 58mm')
      .replace('max-width: 80mm', 'max-width: 58mm')
      .replace('size: 80mm', 'size: 58mm')
      .replace('width: 80mm;', 'width: 58mm;')
      .replace('font-size: 12px', 'font-size: 11px');
    const blobUrl2 = URL.createObjectURL(new Blob([html], {type:'text/html;charset=utf-8'}));
    const w = window.open(blobUrl2, '_blank', 'width=280,height=600,scrollbars=yes');
    if (!w) { URL.revokeObjectURL(blobUrl2); alert('Pop-up blocked.'); return; }
    w.focus();
    setTimeout(() => { w.print(); URL.revokeObjectURL(blobUrl2); }, 600);
  }

  /* ── Expose public API ── */
  window.SokoniReceipt = {
    print:      printReceipt,
    print58mm,
    downloadPDF,
    previewInto,
    buildHTML,
    fromOrder,
  };
})();
