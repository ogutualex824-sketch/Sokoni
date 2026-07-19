/**
 * SOKONI SmartPOS 2.1 — Receipt Engine
 * =====================================
 * Client-side premium digital receipt generation engine.
 *
 * Exposes: window.SokoniReceiptEngine
 *
 * Architecture: IIFE, no external dependencies except optional QR code API.
 * Security:     All user data rendered via textContent — zero innerHTML injection.
 * Compatibility: Modern browsers (ES2018+), mobile-first, print-ready.
 *
 * @version     2.1.0
 * @license     Proprietary — SOKONI Platform
 */

;(function (window, document) {
  'use strict';

  // ─── Constants ────────────────────────────────────────────────────────────

  const OVERLAY_ID        = 'sk-receipt-overlay';
  const PRINT_STYLE_ID    = 'sk-receipt-print-style';
  const QR_API_BASE       = 'https://api.qrserver.com/v1/create-qr-code/';
  const SOKONI_BRAND      = 'Powered by SOKONI';
  const THANK_YOU_MSG     = 'Thank you for shopping with us!';
  const MAX_CARD_WIDTH    = 420;

  const TIER_STARS = {
    bronze:   '🥉',
    silver:   '⭐',
    gold:     '🥇',
    platinum: '💎',
  };

  const PAYMENT_LABELS = {
    mpesa:  'M-PESA',
    card:   'Card',
    cash:   'Cash',
    wallet: 'Sokoni Wallet',
  };

  // ─── Utility Helpers ──────────────────────────────────────────────────────

  /**
   * Safely set text content on a DOM element.
   * @param {HTMLElement} el
   * @param {string|number} text
   */
  function setText(el, text) {
    el.textContent = text == null ? '' : String(text);
  }

  /**
   * Create an element, optionally apply a className and text content.
   * @param {string} tag
   * @param {string} [className]
   * @param {string|number} [text]
   * @returns {HTMLElement}
   */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) setText(node, text);
    return node;
  }

  /**
   * Format currency in KES locale.
   * @param {number} amount
   * @returns {string}
   */
  function fmt(amount) {
    if (amount == null || isNaN(Number(amount))) return '0.00';
    return Number(amount).toLocaleString('en-KE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  /**
   * Format a date string or Date object to human-readable form.
   * @param {string|Date} date
   * @returns {string}
   */
  function fmtDate(date) {
    if (!date) return '';
    try {
      return new Date(date).toLocaleString('en-KE', {
        day:    '2-digit',
        month:  'short',
        year:   'numeric',
        hour:   '2-digit',
        minute: '2-digit',
        hour12: true,
      });
    } catch (_) {
      return String(date);
    }
  }

  /**
   * Build a QR code image URL pointing at the receipt verify URL.
   * @param {string} url
   * @param {number} [size=100]
   * @returns {string}
   */
  function qrUrl(url, size) {
    size = size || 100;
    return QR_API_BASE + '?size=' + size + 'x' + size + '&data=' + encodeURIComponent(url);
  }

  /**
   * Normalise and validate saleData, filling safe defaults.
   * Prevents null-ref crashes from callers omitting optional fields.
   * @param {object} saleData
   * @returns {object}
   */
  function normalise(saleData) {
    if (!saleData || typeof saleData !== 'object') {
      throw new TypeError('[SokoniReceiptEngine] saleData must be a plain object.');
    }

    const store    = saleData.store    || {};
    const sale     = saleData.sale     || {};
    const payment  = saleData.payment  || {};
    const customer = saleData.customer || null;

    return {
      receiptId:  saleData.receiptId  || 'RCP-UNKNOWN',
      verifyUrl:  saleData.verifyUrl  || '',
      etimsRef:   saleData.etimsRef   || null,
      store: {
        name:    store.name    || 'SOKONI Store',
        address: store.address || '',
        phone:   store.phone   || '',
        email:   store.email   || '',
        vatNo:   store.vatNo   || '',
        logo:    store.logo    || '',
      },
      sale: {
        date:     sale.date     || new Date().toISOString(),
        cashier:  sale.cashier  || '',
        items:    Array.isArray(sale.items) ? sale.items : [],
        subtotal: Number(sale.subtotal) || 0,
        discount: Number(sale.discount) || 0,
        tax:      Number(sale.tax)      || 0,
        total:    Number(sale.total)    || 0,
      },
      payment: {
        method: payment.method || 'cash',
        ref:    payment.ref    || '',
        amount: Number(payment.amount) || 0,
      },
      customer: customer ? {
        name:         customer.name         || '',
        phone:        customer.phone        || '',
        tier:         (customer.tier || '').toLowerCase(),
        pointsEarned: Number(customer.pointsEarned) || 0,
        pointsTotal:  Number(customer.pointsTotal)  || 0,
      } : null,
    };
  }

  /**
   * Build plain-text receipt for WhatsApp / clipboard.
   * @param {object} d  Normalised saleData
   * @returns {string}
   */
  function buildText(d) {
    const lines = [];
    const hr    = '─'.repeat(34);

    lines.push(d.store.name.toUpperCase());
    if (d.store.address) lines.push(d.store.address);
    if (d.store.phone)   lines.push(d.store.phone);
    if (d.store.vatNo)   lines.push('VAT: ' + d.store.vatNo);
    lines.push(hr);
    lines.push('RECEIPT: ' + d.receiptId);
    lines.push('Date:    ' + fmtDate(d.sale.date));
    if (d.sale.cashier)      lines.push('Cashier: ' + d.sale.cashier);
    if (d.customer && d.customer.name) {
      const tier = d.customer.tier
        ? ' (' + d.customer.tier.charAt(0).toUpperCase() + d.customer.tier.slice(1) + ' ' + (TIER_STARS[d.customer.tier] || '') + ')'
        : '';
      lines.push('Customer: ' + d.customer.name + tier);
    }
    lines.push(hr);

    // Items
    d.sale.items.forEach(function (item) {
      const name  = String(item.name  || '').slice(0, 22);
      const qty   = 'x' + (item.qty  || 1);
      const price = 'KES ' + fmt((item.price || 0) * (item.qty || 1) - (item.discount || 0));
      lines.push(name.padEnd(23) + qty.padEnd(5) + price);
    });

    lines.push(hr);
    lines.push('Subtotal:'.padEnd(22) + 'KES ' + fmt(d.sale.subtotal));
    if (d.sale.discount > 0) {
      lines.push('Discount:'.padEnd(22) + '-KES ' + fmt(d.sale.discount));
    }
    if (d.sale.tax > 0) {
      lines.push('VAT:'.padEnd(22) + 'KES ' + fmt(d.sale.tax));
    }
    lines.push('═'.repeat(34));
    lines.push('TOTAL:'.padEnd(22) + 'KES ' + fmt(d.sale.total));
    lines.push('─'.repeat(34));
    lines.push('Paid via: ' + (PAYMENT_LABELS[d.payment.method] || d.payment.method));
    if (d.payment.ref) lines.push('Ref:      ' + d.payment.ref);
    lines.push(hr);

    if (d.customer) {
      lines.push('Points earned:  +' + d.customer.pointsEarned);
      lines.push('Points balance:  ' + Number(d.customer.pointsTotal).toLocaleString('en-KE') + ' pts');
    }

    if (d.verifyUrl) {
      lines.push(hr);
      lines.push('Verify: ' + d.verifyUrl);
    }
    if (d.etimsRef) {
      lines.push('KRA eTIMS: ' + d.etimsRef);
    }

    lines.push(hr);
    lines.push(THANK_YOU_MSG);
    lines.push(SOKONI_BRAND);

    return lines.join('\n');
  }

  // ─── DOM Receipt Builder ──────────────────────────────────────────────────

  /**
   * Build the receipt card DOM element — fully XSS-safe.
   * @param {object} d  Normalised saleData
   * @returns {HTMLElement}
   */
  function buildReceiptDOM(d) {
    const card = el('div', 'sk-receipt-card');

    // ── Store Header ──────────────────────────────────────────────────────
    const header = el('div', 'sk-receipt-header');

    if (d.store.logo) {
      const logo = el('img', 'sk-receipt-logo');
      // img src is a URL (from store config, not user input text) — set via attribute
      logo.setAttribute('src', d.store.logo);
      logo.setAttribute('alt', d.store.name + ' logo');
      logo.setAttribute('loading', 'lazy');
      header.appendChild(logo);
    }

    header.appendChild(el('h1', 'sk-receipt-store-name', d.store.name));

    const meta = el('p', 'sk-receipt-store-meta');
    const metaParts = [];
    if (d.store.address) metaParts.push(d.store.address);
    if (d.store.phone)   metaParts.push(d.store.phone);
    setText(meta, metaParts.join(' • '));
    if (metaParts.length) header.appendChild(meta);

    if (d.store.email) {
      header.appendChild(el('p', 'sk-receipt-store-meta', d.store.email));
    }
    if (d.store.vatNo) {
      header.appendChild(el('p', 'sk-receipt-store-meta', 'VAT No: ' + d.store.vatNo));
    }

    card.appendChild(header);

    // ── Divider ───────────────────────────────────────────────────────────
    card.appendChild(el('div', 'sk-receipt-divider'));

    // ── Receipt Metadata ──────────────────────────────────────────────────
    const rMeta = el('div', 'sk-receipt-meta');

    const rIdRow  = el('div', 'sk-receipt-meta-row');
    rIdRow.appendChild(el('span', 'sk-receipt-label', 'RECEIPT'));
    rIdRow.appendChild(el('span', 'sk-receipt-value sk-receipt-id', '#' + d.receiptId));
    rMeta.appendChild(rIdRow);

    const dateRow = el('div', 'sk-receipt-meta-row');
    dateRow.appendChild(el('span', 'sk-receipt-label', 'Date'));
    dateRow.appendChild(el('span', 'sk-receipt-value', fmtDate(d.sale.date)));
    rMeta.appendChild(dateRow);

    if (d.sale.cashier) {
      const cashRow = el('div', 'sk-receipt-meta-row');
      cashRow.appendChild(el('span', 'sk-receipt-label', 'Cashier'));
      cashRow.appendChild(el('span', 'sk-receipt-value', d.sale.cashier));
      rMeta.appendChild(cashRow);
    }

    if (d.customer && d.customer.name) {
      const tier     = d.customer.tier;
      const tierIcon = TIER_STARS[tier] || '';
      const tierLabel = tier ? (' ' + tier.charAt(0).toUpperCase() + tier.slice(1) + ' ' + tierIcon) : '';

      const custRow = el('div', 'sk-receipt-meta-row');
      custRow.appendChild(el('span', 'sk-receipt-label', 'Customer'));

      const custVal = el('span', 'sk-receipt-value');
      setText(custVal, d.customer.name + tierLabel);
      custRow.appendChild(custVal);
      rMeta.appendChild(custRow);
    }

    card.appendChild(rMeta);

    // ── Divider ───────────────────────────────────────────────────────────
    card.appendChild(el('div', 'sk-receipt-divider'));

    // ── Items Table ───────────────────────────────────────────────────────
    const table = el('table', 'sk-receipt-items');

    const thead = el('thead');
    const hRow  = el('tr');
    ['Item', 'Qty', 'Price', 'Total'].forEach(function (h) {
      hRow.appendChild(el('th', null, h));
    });
    thead.appendChild(hRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    d.sale.items.forEach(function (item) {
      const qty       = Number(item.qty)   || 1;
      const unitPrice = Number(item.price) || 0;
      const itemDisc  = Number(item.discount) || 0;
      const lineTotal = unitPrice * qty - itemDisc;

      const tr = el('tr');
      tr.appendChild(el('td', 'sk-item-name',  item.name  || ''));
      tr.appendChild(el('td', 'sk-item-qty',   'x' + qty));
      tr.appendChild(el('td', 'sk-item-price', fmt(unitPrice)));
      tr.appendChild(el('td', 'sk-item-total', fmt(lineTotal)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    card.appendChild(table);

    // ── Totals ────────────────────────────────────────────────────────────
    const totals = el('div', 'sk-receipt-totals');

    function addTotalRow(label, value, className) {
      const row = el('div', 'sk-totals-row' + (className ? ' ' + className : ''));
      row.appendChild(el('span', 'sk-totals-label', label));
      row.appendChild(el('span', 'sk-totals-value', value));
      totals.appendChild(row);
    }

    addTotalRow('Subtotal', 'KES ' + fmt(d.sale.subtotal));
    if (d.sale.discount > 0) {
      addTotalRow('Discount', '−KES ' + fmt(d.sale.discount), 'sk-totals-discount');
    }
    if (d.sale.tax > 0) {
      addTotalRow('VAT (16%)', 'KES ' + fmt(d.sale.tax));
    }

    const totalDivider = el('div', 'sk-receipt-total-divider');
    totals.appendChild(totalDivider);

    addTotalRow('TOTAL', 'KES ' + fmt(d.sale.total), 'sk-totals-grand');

    card.appendChild(totals);

    // ── Divider ───────────────────────────────────────────────────────────
    card.appendChild(el('div', 'sk-receipt-divider'));

    // ── Payment ───────────────────────────────────────────────────────────
    const payment = el('div', 'sk-receipt-payment');
    const methodLabel = PAYMENT_LABELS[d.payment.method] || d.payment.method;
    payment.appendChild(el('p', 'sk-payment-method', 'Paid via: ' + methodLabel));
    if (d.payment.ref) {
      payment.appendChild(el('p', 'sk-payment-ref', 'Ref: ' + d.payment.ref));
    }
    card.appendChild(payment);

    // ── Loyalty Points ────────────────────────────────────────────────────
    if (d.customer) {
      card.appendChild(el('div', 'sk-receipt-divider'));
      const loyalty = el('div', 'sk-receipt-loyalty');
      loyalty.appendChild(el('p', 'sk-loyalty-earned',
        '+' + d.customer.pointsEarned + ' points earned this purchase'));
      loyalty.appendChild(el('p', 'sk-loyalty-total',
        'Balance: ' + Number(d.customer.pointsTotal).toLocaleString('en-KE') + ' pts'
        + (d.customer.tier ? ' (' + d.customer.tier.charAt(0).toUpperCase() + d.customer.tier.slice(1) + ')' : '')));
      card.appendChild(loyalty);
    }

    // ── QR / Verify ───────────────────────────────────────────────────────
    if (d.verifyUrl) {
      card.appendChild(el('div', 'sk-receipt-divider'));
      const qrSection = el('div', 'sk-receipt-qr');

      const qrImg = el('img', 'sk-receipt-qr-img');
      qrImg.setAttribute('src', qrUrl(d.verifyUrl, 100));
      qrImg.setAttribute('alt', 'Receipt QR Code');
      qrImg.setAttribute('width', '100');
      qrImg.setAttribute('height', '100');
      qrImg.setAttribute('loading', 'lazy');
      qrSection.appendChild(qrImg);

      qrSection.appendChild(el('p', 'sk-receipt-verify-url', d.verifyUrl));

      if (d.etimsRef) {
        const etims = el('p', 'sk-receipt-etims');
        setText(etims, 'KRA eTIMS: ' + d.etimsRef);
        qrSection.appendChild(etims);
      }

      card.appendChild(qrSection);
    }

    // ── Footer ────────────────────────────────────────────────────────────
    card.appendChild(el('div', 'sk-receipt-divider'));
    const footer = el('div', 'sk-receipt-footer');
    footer.appendChild(el('p', 'sk-receipt-thank-you', THANK_YOU_MSG));
    footer.appendChild(el('p', 'sk-receipt-brand', SOKONI_BRAND));
    card.appendChild(footer);

    return card;
  }

  // ─── Stylesheet Injection ─────────────────────────────────────────────────

  /**
   * Inject receipt CSS once into the document <head>.
   * Safe to call multiple times — idempotent.
   */
  function injectStyles() {
    if (document.getElementById('sk-receipt-styles')) return;

    const style     = document.createElement('style');
    style.id        = 'sk-receipt-styles';
    style.textContent = [
      /* ── Overlay ─────────────────────────────────────────────── */
      '#sk-receipt-overlay {',
      '  position: fixed;',
      '  inset: 0;',
      '  z-index: 9999;',
      '  background: rgba(0,0,0,0.92);',
      '  display: flex;',
      '  flex-direction: column;',
      '  align-items: center;',
      '  justify-content: flex-start;',
      '  overflow-y: auto;',
      '  padding: 24px 16px 100px;',
      '  box-sizing: border-box;',
      '  -webkit-overflow-scrolling: touch;',
      '}',

      /* ── Card ────────────────────────────────────────────────── */
      '.sk-receipt-card {',
      '  background: #fff;',
      '  max-width: ' + MAX_CARD_WIDTH + 'px;',
      '  width: 100%;',
      '  border-radius: 12px;',
      '  padding: 24px 20px;',
      '  box-sizing: border-box;',
      '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;',
      '  font-size: 13px;',
      '  color: #1a1a1a;',
      '  line-height: 1.55;',
      '  position: relative;',
      '}',

      /* ── Store Header ─────────────────────────────────────────── */
      '.sk-receipt-header {',
      '  text-align: center;',
      '  margin-bottom: 4px;',
      '}',
      '.sk-receipt-logo {',
      '  max-height: 64px;',
      '  max-width: 180px;',
      '  object-fit: contain;',
      '  margin: 0 auto 8px;',
      '  display: block;',
      '}',
      '.sk-receipt-store-name {',
      '  font-size: 20px;',
      '  font-weight: 700;',
      '  color: #111;',
      '  margin: 0 0 4px;',
      '  letter-spacing: 0.3px;',
      '}',
      '.sk-receipt-store-meta {',
      '  font-size: 12px;',
      '  color: #666;',
      '  margin: 2px 0;',
      '}',

      /* ── Divider ─────────────────────────────────────────────── */
      '.sk-receipt-divider {',
      '  border-top: 1px dashed #ddd;',
      '  margin: 14px 0;',
      '}',

      /* ── Receipt Meta ─────────────────────────────────────────── */
      '.sk-receipt-meta {',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 4px;',
      '}',
      '.sk-receipt-meta-row {',
      '  display: flex;',
      '  justify-content: space-between;',
      '  align-items: baseline;',
      '  gap: 8px;',
      '}',
      '.sk-receipt-label {',
      '  font-size: 11px;',
      '  text-transform: uppercase;',
      '  letter-spacing: 0.6px;',
      '  color: #888;',
      '  white-space: nowrap;',
      '}',
      '.sk-receipt-value {',
      '  font-size: 13px;',
      '  color: #111;',
      '  text-align: right;',
      '  word-break: break-word;',
      '}',
      '.sk-receipt-id {',
      '  font-weight: 700;',
      '  color: #0057b7;',
      '  font-size: 14px;',
      '}',

      /* ── Items Table ─────────────────────────────────────────── */
      '.sk-receipt-items {',
      '  width: 100%;',
      '  border-collapse: collapse;',
      '  font-size: 12.5px;',
      '}',
      '.sk-receipt-items thead th {',
      '  text-align: left;',
      '  font-size: 10.5px;',
      '  text-transform: uppercase;',
      '  letter-spacing: 0.5px;',
      '  color: #999;',
      '  padding: 0 0 6px;',
      '  border-bottom: 1px solid #eee;',
      '}',
      '.sk-receipt-items thead th:not(:first-child) {',
      '  text-align: right;',
      '}',
      '.sk-receipt-items tbody tr:last-child td {',
      '  padding-bottom: 0;',
      '}',
      '.sk-receipt-items td {',
      '  padding: 5px 0;',
      '  vertical-align: top;',
      '  border-bottom: 1px solid #f5f5f5;',
      '}',
      '.sk-item-name {',
      '  max-width: 140px;',
      '  word-break: break-word;',
      '  color: #222;',
      '  font-weight: 500;',
      '}',
      '.sk-item-qty, .sk-item-price, .sk-item-total {',
      '  text-align: right;',
      '  font-variant-numeric: tabular-nums;',
      '  white-space: nowrap;',
      '  padding-left: 8px;',
      '}',
      '.sk-item-total {',
      '  font-weight: 600;',
      '}',

      /* ── Totals ──────────────────────────────────────────────── */
      '.sk-receipt-totals {',
      '  margin-top: 4px;',
      '}',
      '.sk-totals-row {',
      '  display: flex;',
      '  justify-content: space-between;',
      '  align-items: baseline;',
      '  padding: 3px 0;',
      '  font-size: 13px;',
      '}',
      '.sk-totals-label {',
      '  color: #555;',
      '}',
      '.sk-totals-value {',
      '  font-variant-numeric: tabular-nums;',
      '  color: #111;',
      '  font-weight: 500;',
      '}',
      '.sk-totals-discount .sk-totals-value {',
      '  color: #d32f2f;',
      '}',
      '.sk-totals-grand {',
      '  padding: 6px 0 0;',
      '}',
      '.sk-totals-grand .sk-totals-label {',
      '  font-size: 16px;',
      '  font-weight: 800;',
      '  color: #111;',
      '  text-transform: uppercase;',
      '  letter-spacing: 0.5px;',
      '}',
      '.sk-totals-grand .sk-totals-value {',
      '  font-size: 20px;',
      '  font-weight: 800;',
      '  color: #111;',
      '}',
      '.sk-receipt-total-divider {',
      '  border-top: 2px solid #111;',
      '  margin: 8px 0 4px;',
      '}',

      /* ── Payment ─────────────────────────────────────────────── */
      '.sk-receipt-payment {',
      '  font-size: 13px;',
      '}',
      '.sk-payment-method {',
      '  font-weight: 600;',
      '  color: #0a7c3e;',
      '  margin: 0 0 2px;',
      '}',
      '.sk-payment-ref {',
      '  color: #555;',
      '  font-size: 12px;',
      '  margin: 0;',
      '  font-family: "Courier New", Courier, monospace;',
      '  word-break: break-all;',
      '}',

      /* ── Loyalty ─────────────────────────────────────────────── */
      '.sk-receipt-loyalty {',
      '  background: #fffbf0;',
      '  border: 1px solid #ffe08a;',
      '  border-radius: 8px;',
      '  padding: 10px 14px;',
      '  text-align: center;',
      '}',
      '.sk-loyalty-earned {',
      '  font-size: 14px;',
      '  font-weight: 700;',
      '  color: #b45309;',
      '  margin: 0 0 2px;',
      '}',
      '.sk-loyalty-total {',
      '  font-size: 12px;',
      '  color: #78350f;',
      '  margin: 0;',
      '}',

      /* ── QR Code ─────────────────────────────────────────────── */
      '.sk-receipt-qr {',
      '  text-align: center;',
      '}',
      '.sk-receipt-qr-img {',
      '  display: block;',
      '  margin: 0 auto 8px;',
      '  border: 1px solid #eee;',
      '  border-radius: 6px;',
      '  padding: 4px;',
      '}',
      '.sk-receipt-verify-url {',
      '  font-size: 10px;',
      '  color: #0057b7;',
      '  word-break: break-all;',
      '  margin: 0 0 4px;',
      '}',
      '.sk-receipt-etims {',
      '  font-size: 11px;',
      '  color: #555;',
      '  font-family: "Courier New", Courier, monospace;',
      '  margin: 4px 0 0;',
      '}',

      /* ── Footer ──────────────────────────────────────────────── */
      '.sk-receipt-footer {',
      '  text-align: center;',
      '}',
      '.sk-receipt-thank-you {',
      '  font-size: 14px;',
      '  font-weight: 600;',
      '  color: #0a7c3e;',
      '  margin: 0 0 4px;',
      '}',
      '.sk-receipt-brand {',
      '  font-size: 11px;',
      '  color: #bbb;',
      '  margin: 0;',
      '  letter-spacing: 0.3px;',
      '}',

      /* ── Action Buttons Bar ───────────────────────────────────── */
      '.sk-receipt-actions {',
      '  position: fixed;',
      '  bottom: 0;',
      '  left: 0;',
      '  right: 0;',
      '  z-index: 10000;',
      '  background: rgba(20,20,20,0.97);',
      '  backdrop-filter: blur(8px);',
      '  -webkit-backdrop-filter: blur(8px);',
      '  padding: 10px 16px max(12px, env(safe-area-inset-bottom));',
      '  display: flex;',
      '  flex-direction: row;',
      '  gap: 8px;',
      '  overflow-x: auto;',
      '  -webkit-overflow-scrolling: touch;',
      '  scrollbar-width: none;',
      '}',
      '.sk-receipt-actions::-webkit-scrollbar { display: none; }',
      '.sk-receipt-action-btn {',
      '  display: flex;',
      '  flex-direction: column;',
      '  align-items: center;',
      '  justify-content: center;',
      '  gap: 3px;',
      '  min-width: 64px;',
      '  padding: 8px 10px;',
      '  background: rgba(255,255,255,0.08);',
      '  border: 1px solid rgba(255,255,255,0.12);',
      '  border-radius: 10px;',
      '  color: #fff;',
      '  font-size: 11px;',
      '  font-weight: 500;',
      '  cursor: pointer;',
      '  white-space: nowrap;',
      '  flex-shrink: 0;',
      '  transition: background 0.15s;',
      '  -webkit-tap-highlight-color: transparent;',
      '  font-family: inherit;',
      '}',
      '.sk-receipt-action-btn:hover {',
      '  background: rgba(255,255,255,0.16);',
      '}',
      '.sk-receipt-action-btn:active {',
      '  background: rgba(255,255,255,0.22);',
      '  transform: scale(0.97);',
      '}',
      '.sk-receipt-action-btn .sk-btn-icon {',
      '  font-size: 20px;',
      '  line-height: 1;',
      '}',
      '.sk-receipt-action-btn.sk-btn-close {',
      '  background: rgba(220,38,38,0.15);',
      '  border-color: rgba(220,38,38,0.3);',
      '}',
      '.sk-receipt-action-btn.sk-btn-close:hover {',
      '  background: rgba(220,38,38,0.28);',
      '}',

      /* ── Print Styles ────────────────────────────────────────── */
      '@media print {',
      '  body > *:not(#sk-receipt-overlay) { display: none !important; }',
      '  #sk-receipt-overlay {',
      '    position: static !important;',
      '    background: none !important;',
      '    padding: 0 !important;',
      '    overflow: visible !important;',
      '  }',
      '  .sk-receipt-actions { display: none !important; }',
      '  .sk-receipt-card {',
      '    box-shadow: none !important;',
      '    border-radius: 0 !important;',
      '    padding: 8px !important;',
      '    max-width: 100% !important;',
      '    font-size: 11px !important;',
      '  }',
      '  .sk-receipt-store-name { font-size: 15px !important; }',
      '  .sk-totals-grand .sk-totals-value { font-size: 16px !important; }',
      '  @page { size: 80mm auto; margin: 0; }',
      '}',
    ].join('\n');

    document.head.appendChild(style);
  }

  // ─── Modal Lifecycle ──────────────────────────────────────────────────────

  /**
   * Remove the existing receipt overlay from the DOM, if present.
   */
  function removeOverlay() {
    const existing = document.getElementById(OVERLAY_ID);
    if (existing) {
      existing.parentNode.removeChild(existing);
    }
    // Remove print-specific style injected for PDF
    const ps = document.getElementById(PRINT_STYLE_ID);
    if (ps) ps.parentNode.removeChild(ps);
    // Remove ESC key listener
    if (window._skReceiptEscHandler) {
      document.removeEventListener('keydown', window._skReceiptEscHandler);
      window._skReceiptEscHandler = null;
    }
  }

  /**
   * Build and mount the full-screen receipt modal.
   * @param {object} d       Normalised saleData
   * @param {object} [opts]  Optional overrides (reserved for future use)
   */
  function mountModal(d, opts) {
    opts = opts || {};
    removeOverlay();
    injectStyles();

    const overlay = el('div');
    overlay.id    = OVERLAY_ID;

    // Prevent clicks on the overlay background from closing (allows scrolling)
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) {
        // Intentionally do not auto-close on backdrop click — user must use Close button
      }
    });

    // Receipt card
    const card = buildReceiptDOM(d);
    overlay.appendChild(card);

    // Action bar
    const actions = el('div', 'sk-receipt-actions receipt-actions');

    const buttons = [
      { icon: '🖨️', label: 'Print',    cls: '',              fn: function () { engine.print(d); } },
      { icon: '📄', label: 'PDF',      cls: '',              fn: function () { engine.downloadPDF(d); } },
      { icon: '💬', label: 'WhatsApp', cls: '',              fn: function () { engine.shareWhatsApp(d); } },
      { icon: '📋', label: 'Copy',     cls: '',              fn: function () { engine.copyText(d); } },
      { icon: '✉️', label: 'Email',    cls: '',              fn: function () { _emailReceipt(d); } },
      { icon: '✕',  label: 'Close',    cls: 'sk-btn-close',  fn: function () { engine.close(); } },
    ];

    buttons.forEach(function (btnDef) {
      const btn     = el('button', 'sk-receipt-action-btn ' + btnDef.cls);
      const icon    = el('span', 'sk-btn-icon');
      setText(icon, btnDef.icon);
      btn.appendChild(icon);
      btn.appendChild(el('span', null, btnDef.label));
      btn.type      = 'button';
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        btnDef.fn();
      });
      actions.appendChild(btn);
    });

    overlay.appendChild(actions);
    document.body.appendChild(overlay);

    // ESC key to close
    function escHandler(e) {
      if (e.key === 'Escape') engine.close();
    }
    document.addEventListener('keydown', escHandler);
    window._skReceiptEscHandler = escHandler;

    // Trap focus inside overlay for a11y
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Receipt #' + d.receiptId);
    overlay.setAttribute('tabindex', '-1');
    overlay.focus();
  }

  // ─── Email Helper ─────────────────────────────────────────────────────────

  /**
   * Open the device mail client with the receipt text pre-filled.
   * @param {object} d  Normalised saleData
   */
  function _emailReceipt(d) {
    const subject = encodeURIComponent('Receipt #' + d.receiptId + ' — ' + d.store.name);
    const body    = encodeURIComponent(buildText(d));
    const mailto  = 'mailto:?subject=' + subject + '&body=' + body;
    window.open(mailto, '_blank', 'noopener,noreferrer');
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  var engine = {

    /**
     * Generate and display the receipt modal.
     * @param {object} saleData
     * @param {object} [opts]
     */
    show: function (saleData, opts) {
      try {
        var d = normalise(saleData);
        mountModal(d, opts);
      } catch (err) {
        console.error('[SokoniReceiptEngine] show() error:', err);
      }
    },

    /**
     * Generate the receipt HTML string (for preview, iframe, or server-side storage).
     * Returns a fully self-contained HTML document string.
     * @param {object} saleData
     * @returns {string}
     */
    generate: function (saleData) {
      try {
        var d = normalise(saleData);

        // Build a minimal wrapper to serialise the card DOM
        injectStyles();
        var card    = buildReceiptDOM(d);
        var wrapper = document.createElement('div');
        wrapper.appendChild(card);

        // Collect the injected CSS
        var styleEl = document.getElementById('sk-receipt-styles');
        var css     = styleEl ? styleEl.textContent : '';

        return [
          '<!DOCTYPE html>',
          '<html lang="en">',
          '<head>',
          '<meta charset="UTF-8">',
          '<meta name="viewport" content="width=device-width,initial-scale=1">',
          '<title>Receipt ' + d.receiptId + '</title>',
          '<style>' + css + '</style>',
          '</head>',
          '<body style="background:#f4f4f4;display:flex;justify-content:center;padding:24px;">',
          wrapper.innerHTML,
          '</body>',
          '</html>',
        ].join('\n');
      } catch (err) {
        console.error('[SokoniReceiptEngine] generate() error:', err);
        return '';
      }
    },

    /**
     * Trigger the browser print dialog, configured for 80mm thermal receipt.
     * @param {object} saleData
     */
    print: function (saleData) {
      try {
        var d = normalise(saleData);

        // Ensure the overlay is visible so @media print can target it
        var overlayExists = !!document.getElementById(OVERLAY_ID);
        if (!overlayExists) {
          injectStyles();
          var card    = buildReceiptDOM(d);
          var overlay = el('div');
          overlay.id  = OVERLAY_ID;
          overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.92);display:flex;align-items:flex-start;justify-content:center;overflow-y:auto;padding:24px 16px 100px;';
          overlay.appendChild(card);
          document.body.appendChild(overlay);

          window.print();

          // Remove temporary overlay after print dialog is dismissed
          setTimeout(function () {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
          }, 500);
        } else {
          window.print();
        }
      } catch (err) {
        console.error('[SokoniReceiptEngine] print() error:', err);
      }
    },

    /**
     * Download receipt as PDF via the browser's "Print to PDF" mechanism.
     * Injects a temporary print style that constrains output to 80mm width.
     * @param {object} saleData
     */
    downloadPDF: function (saleData) {
      try {
        // Inject a one-shot print style that sets suggested filename via title
        var d = normalise(saleData);

        var prevTitle = document.title;
        document.title = 'Receipt-' + d.receiptId;

        // Print style is already in sk-receipt-styles via @media print block.
        // Trigger print; browser "Print to PDF" honours the @page 80mm directive.
        engine.print(saleData);

        // Restore title after a tick
        setTimeout(function () {
          document.title = prevTitle;
        }, 800);
      } catch (err) {
        console.error('[SokoniReceiptEngine] downloadPDF() error:', err);
      }
    },

    /**
     * Share receipt summary via WhatsApp.
     * @param {object} saleData
     */
    shareWhatsApp: function (saleData) {
      try {
        var d    = normalise(saleData);
        var text = buildText(d);
        var url  = 'https://wa.me/?text=' + encodeURIComponent(text);
        window.open(url, '_blank', 'noopener,noreferrer');
      } catch (err) {
        console.error('[SokoniReceiptEngine] shareWhatsApp() error:', err);
      }
    },

    /**
     * Copy plain-text receipt to clipboard.
     * Falls back to prompt() on older browsers.
     * @param {object} saleData
     * @returns {Promise<void>}
     */
    copyText: function (saleData) {
      try {
        var d    = normalise(saleData);
        var text = buildText(d);

        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(text).then(function () {
            _showToast('Receipt copied to clipboard!');
          }).catch(function (err) {
            console.warn('[SokoniReceiptEngine] Clipboard write failed:', err);
            _fallbackCopy(text);
          });
        } else {
          _fallbackCopy(text);
        }
      } catch (err) {
        console.error('[SokoniReceiptEngine] copyText() error:', err);
      }
    },

    /**
     * Close and remove the receipt modal.
     */
    close: function () {
      removeOverlay();
    },

  };

  // ─── Internal Utilities ───────────────────────────────────────────────────

  /**
   * Fallback clipboard copy using a temporary textarea.
   * @param {string} text
   */
  function _fallbackCopy(text) {
    var ta        = document.createElement('textarea');
    ta.value      = text;
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      _showToast('Receipt copied to clipboard!');
    } catch (_) {
      _showToast('Could not copy. Please copy manually.');
    }
    document.body.removeChild(ta);
  }

  /**
   * Show a transient toast notification.
   * Self-contained — no external UI dependencies.
   * @param {string} message
   * @param {number} [duration=2500]
   */
  function _showToast(message, duration) {
    duration = duration || 2500;
    var existing = document.getElementById('sk-receipt-toast');
    if (existing) existing.parentNode.removeChild(existing);

    var toast         = el('div');
    toast.id          = 'sk-receipt-toast';
    toast.style.cssText = [
      'position:fixed',
      'bottom:calc(80px + env(safe-area-inset-bottom))',
      'left:50%',
      'transform:translateX(-50%)',
      'z-index:10001',
      'background:rgba(30,30,30,0.95)',
      'color:#fff',
      'padding:10px 20px',
      'border-radius:24px',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'font-size:13px',
      'font-weight:500',
      'white-space:nowrap',
      'box-shadow:0 4px 20px rgba(0,0,0,0.3)',
      'pointer-events:none',
      'opacity:0',
      'transition:opacity 0.2s ease',
    ].join(';');

    setText(toast, message);
    document.body.appendChild(toast);

    // Trigger fade-in
    requestAnimationFrame(function () {
      toast.style.opacity = '1';
    });

    // Fade-out and remove
    setTimeout(function () {
      toast.style.opacity = '0';
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 250);
    }, duration);
  }

  // ─── Expose Public API ────────────────────────────────────────────────────

  /* NAMESPACE COLLISION FIX (2026-07-19).
     sokoni-receipt-engine.js also assigns window.SokoniReceiptEngine, and pos.html loads
     BOTH — that file at line 1445, this one (deferred) at 2226. Deferred scripts run
     last, so a bare assignment here replaced the object outright and destroyed every
     ESC/POS method on it: buildBytes, buildReceiptBytes, buildReceiptHTML,
     buildLabelHTML, buildShippingLabel, buildHTML.

     Confirmed on production /pos: window.SokoniReceiptEngine exposed only
     show/generate/print/downloadPDF/shareWhatsApp/copyText/close. sokoni-label-engine.js
     is loaded on the same page and calls SokoniReceiptEngine.buildShippingLabel() at
     line 413, so printing a shipping label threw TypeError.

     The two engines are complementary, not competing — one builds thermal bytes, the
     other drives the on-screen receipt. Merge rather than replace, so whichever loads
     second keeps the other's methods. Also published under a distinct name so future
     callers can target this API explicitly and never depend on load order. */
  window.SokoniPosReceiptUI = engine;
  window.SokoniReceiptEngine = Object.assign({}, window.SokoniReceiptEngine || {}, engine);

})(window, document);
