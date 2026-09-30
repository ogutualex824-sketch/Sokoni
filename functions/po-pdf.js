/* ══════════════════════════════════════════════════════════════════════════════
   PURCHASE ORDER PDF  —  po-pdf.js

   Builds a real, printable PDF Purchase Order with no dependencies.

   Why hand-rolled: functions/package.json carries no PDF library, and adding pdfkit or
   (worse) puppeteer to a Cloud Function costs cold-start time and a large deploy for a
   document that is a table of numbers. The same technique already ships in
   sokoni-legal-certificate.js, so this is the codebase's existing idiom rather than a
   new one.

   A supplier must be able to file, print and sign this. It is the legal artefact of the
   order — not a formatted email.

   Branding: SOKONI is the customer-facing brand. Bravilex International Co. Limited
   appears once, in the footer, as the legal issuing entity — a regulatory disclosure,
   which is the one place the brand policy permits it (docs/BRAND_POLICY.md).
════════════════════════════════════════════════════════════════════════════════ */
'use strict';

/* PDF strings must escape \, ( and ) or the file is corrupt — an unbalanced paren ends
   the string token early and every reader rejects the document. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    /* WinAnsi has no glyph for these; a raw non-latin byte renders as garbage. */
    .replace(/[^\x20-\x7E]/g, '');
}

const money = n => 'KES ' + Number(n || 0).toLocaleString('en-KE', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

/* Wrap a string to a column width (in characters) so long product names do not run off
   the page — the most common way a generated PDF becomes unreadable. */
function wrap(s, width) {
  const words = String(s || '').split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width) { if (line) lines.push(line); line = w; }
    else line = (line ? line + ' ' : '') + w;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/**
 * buildPoPdf(po, supplier, buyer) → Buffer
 *
 * po:       { poNumber, createdAt, expectedDelivery, items[], subtotal, vatAmount, total,
 *             notes, paymentTerms, deliveryLocation }
 * supplier: { name, contactName, email, phone, address, kraPin }
 * buyer:    { name, email, phone, address, kraPin }   — the merchant
 */
function buildPoPdf(po, supplier = {}, buyer = {}) {
  const W = 595.28, H = 841.89;            /* A4, points */
  const L = 48, R = W - 48;
  const ops = [];

  const text = (font, size, x, y, s, gray) => {
    ops.push('BT /' + font + ' ' + size + ' Tf ' +
             (gray != null ? gray + ' g ' : '0 g ') +
             x.toFixed(2) + ' ' + y.toFixed(2) + ' Td (' + esc(s) + ') Tj ET');
  };
  const rule = (y, gray) => ops.push((gray != null ? gray : 0.82) + ' G 0.7 w ' +
                                     L + ' ' + y.toFixed(2) + ' m ' + R + ' ' + y.toFixed(2) + ' l S');
  const box = (x, y, w, h, gray) => ops.push((gray != null ? gray : 0.95) + ' g ' +
                                             x.toFixed(2) + ' ' + y.toFixed(2) + ' ' +
                                             w.toFixed(2) + ' ' + h.toFixed(2) + ' re f 0 g');

  let y = H - 56;

  /* ── Header ── */
  text('F2', 22, L, y, 'SOKONI');
  text('F2', 15, R - 150, y, 'PURCHASE ORDER');
  y -= 16;
  text('F1', 9, L, y, 'Procurement', 0.45);
  text('F2', 11, R - 150, y, String(po.poNumber || po.id || ''), 0.15);
  y -= 14;
  rule(y);
  y -= 22;

  /* ── Parties ── */
  const colR = L + 270;
  text('F2', 9, L,    y, 'SUPPLIER', 0.45);
  text('F2', 9, colR, y, 'BILL TO', 0.45);
  y -= 14;
  const sup = [
    supplier.name || '—',
    supplier.contactName ? 'Attn: ' + supplier.contactName : '',
    supplier.email || '', supplier.phone || '', supplier.address || '',
    supplier.kraPin ? 'KRA PIN: ' + supplier.kraPin : '',
  ].filter(Boolean);
  const buy = [
    buyer.name || 'SOKONI Merchant',
    buyer.email || '', buyer.phone || '', buyer.address || '',
    buyer.kraPin ? 'KRA PIN: ' + buyer.kraPin : '',
  ].filter(Boolean);
  const rows = Math.max(sup.length, buy.length);
  for (let i = 0; i < rows; i++) {
    if (sup[i]) text(i === 0 ? 'F2' : 'F1', i === 0 ? 10 : 9, L,    y, sup[i], i === 0 ? 0 : 0.35);
    if (buy[i]) text(i === 0 ? 'F2' : 'F1', i === 0 ? 10 : 9, colR, y, buy[i], i === 0 ? 0 : 0.35);
    y -= 12;
  }
  y -= 10;

  /* ── Dates / terms ── */
  const d = v => { try { return v ? new Date(v).toDateString() : '—'; } catch (e) { return '—'; } };
  text('F1', 9, L,       y, 'Order date: ' + d(po.createdAt), 0.35);
  text('F1', 9, L + 180, y, 'Expected delivery: ' + d(po.expectedDelivery), 0.35);
  y -= 12;
  if (po.deliveryLocation) { text('F1', 9, L, y, 'Deliver to: ' + po.deliveryLocation, 0.35); y -= 12; }
  y -= 8;
  rule(y);
  y -= 8;

  /* ── Items table ── */
  const cX = { desc: L, qty: L + 300, unit: L + 355, total: R - 90 };
  box(L - 4, y - 14, (R - L) + 8, 18, 0.94);
  text('F2', 8.5, cX.desc,  y - 9, 'DESCRIPTION', 0.35);
  text('F2', 8.5, cX.qty,   y - 9, 'QTY',         0.35);
  text('F2', 8.5, cX.unit,  y - 9, 'UNIT PRICE',  0.35);
  text('F2', 8.5, cX.total, y - 9, 'AMOUNT',      0.35);
  y -= 24;

  for (const it of (po.items || [])) {
    const qty  = Number(it.qty || it.quantity || 0);
    const unit = Number(it.unitCost != null ? it.unitCost : it.unitPrice || 0);
    const line = qty * unit;
    const nameLines = wrap(it.name || it.productName || 'Item', 44);

    text('F1', 9.5, cX.desc,  y, nameLines[0]);
    text('F1', 9.5, cX.qty,   y, String(qty));
    text('F1', 9.5, cX.unit,  y, money(unit));
    text('F1', 9.5, cX.total, y, money(line));
    y -= 12;

    for (let i = 1; i < nameLines.length; i++) { text('F1', 9.5, cX.desc, y, nameLines[i]); y -= 12; }
    if (it.sku) { text('F1', 8, cX.desc, y, 'SKU: ' + it.sku, 0.5); y -= 11; }
    y -= 3;

    /* One page only. A PO with more items than fit is truncated with an explicit note
       rather than silently losing lines — a supplier must never receive a PO that quietly
       omits what was ordered. */
    if (y < 190) {
      text('F2', 9, cX.desc, y, '… additional items continue — see the itemised list in the portal.', 0.4);
      y -= 14;
      break;
    }
  }

  y -= 4;
  rule(y);
  y -= 18;

  /* ── Totals ── */
  const tx = R - 200, tv = R - 90;
  text('F1', 9.5, tx, y, 'Subtotal', 0.4);       text('F1', 9.5, tv, y, money(po.subtotal)); y -= 14;
  const vatPct = po.vatRate != null ? po.vatRate : 16;
  text('F1', 9.5, tx, y, `VAT (${vatPct}%)`, 0.4); text('F1', 9.5, tv, y, money(po.vatAmount)); y -= 16;
  box(tx - 8, y - 6, (R - tx) + 8, 20, 0.94);
  text('F2', 11, tx, y, 'GRAND TOTAL');           text('F2', 11, tv, y, money(po.total)); y -= 30;

  /* ── Notes / terms ── */
  if (po.notes) {
    text('F2', 9, L, y, 'NOTES', 0.45); y -= 12;
    wrap(po.notes, 95).slice(0, 4).forEach(l => { text('F1', 9, L, y, l, 0.3); y -= 11; });
    y -= 6;
  }
  text('F2', 9, L, y, 'PAYMENT TERMS', 0.45); y -= 12;
  text('F1', 9, L, y, po.paymentTerms || 'Net 30 days from date of delivery.', 0.3);
  y -= 22;

  /* ── Signatures ── */
  const sy = Math.max(y, 120);
  rule(sy, 0.7);
  ops.push('0.7 G 0.7 w ' + L + ' ' + (sy - 40) + ' m ' + (L + 190) + ' ' + (sy - 40) + ' l S');
  ops.push('0.7 G 0.7 w ' + (R - 190) + ' ' + (sy - 40) + ' m ' + R + ' ' + (sy - 40) + ' l S');
  text('F1', 8, L,       sy - 52, 'Authorised by (Buyer)', 0.45);
  text('F1', 8, R - 190, sy - 52, 'Accepted by (Supplier)', 0.45);

  /* ── Footer: the legal entity, as a regulatory disclosure. ── */
  rule(64, 0.88);
  text('F1', 7.4, L, 50,
    'This Purchase Order is issued through SOKONI. Acceptance constitutes agreement to the terms above.', 0.5);
  text('F1', 7.4, L, 40,
    'SOKONI is operated by Bravilex International Co. Limited, the legal issuing entity.', 0.5);
  text('F1', 7.4, R - 120, 40, String(po.poNumber || ''), 0.5);

  /* ── Assemble ── */
  const content = ops.join('\n');
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objs[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + W + ' ' + H + '] ' +
            '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>';
  objs[4] = '<< /Length ' + Buffer.byteLength(content, 'latin1') + ' >>\nstream\n' + content + '\nendstream';
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[6] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += i + ' 0 obj\n' + objs[i] + '\nendobj\n';
  }
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += 'xref\n0 ' + objs.length + '\n0000000000 65535 f \n';
  for (let i = 1; i < objs.length; i++) {
    pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  pdf += 'trailer\n<< /Size ' + objs.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';

  return Buffer.from(pdf, 'latin1');
}

module.exports = { buildPoPdf };
