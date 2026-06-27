/* ================================================================
   SOKONI Payment Trust Module v1.0
   sokoni-payment-trust.js

   Central trust layer for the entire SOKONI platform.
   Handles: IntaSend badge, payment status, price transparency,
   buyer protection, seller verification, digital receipts,
   duplicate payment detection, security monitoring.

   Auto-discovers data-trust="..." attributes on DOMContentLoaded.
   Also exposes window.SokoniTrust for programmatic use.

   Data attributes:
     data-trust="badge"         → IntaSend + SSL + PCI badges
     data-trust="status"        → Payment status bar
     data-trust="breakdown"     → Price breakdown (data-items JSON)
     data-trust="protection"    → Buyer protection (data-type marketplace|service|digital)
     data-trust="seller"        → Seller badge (data-level seller|business|provider|professional)
     data-trust="footer"        → Full trust footer
================================================================ */
(function (global) {
  'use strict';

  /* ── Payment status phases ── */
  const PHASES = {
    preparing:   { icon: '⟳', label: 'Preparing payment',      desc: 'Setting up your secure payment session…', spin: true },
    waiting:     { icon: '⏳', label: 'Waiting for confirmation', desc: 'Waiting for you to approve the payment on your phone or device.' },
    received:    { icon: '✓',  label: 'Payment received',        desc: 'We received your payment. Verifying now…' },
    verified:    { icon: '✓',  label: 'Payment verified',        desc: 'Your payment has been confirmed and is being processed.' },
    completing:  { icon: '⟳', label: 'Completing order',         desc: 'Updating your order, inventory and records…', spin: true },
    receipt:     { icon: '📄', label: 'Receipt generated',        desc: 'Your receipt is ready. Check your email or download below.' },
    complete:    { icon: '✓',  label: 'Transaction complete',     desc: 'Everything is done. Thank you for your purchase!' },
    failed:      { icon: '✕',  label: 'Payment not completed',   desc: 'The payment was not completed. No charge was made. Please try again.' },
  };

  /* ── Buyer protection sets ── */
  const PROTECTIONS = {
    marketplace: [
      { icon: '🔒', text: '<strong>Secure payment</strong> — all transactions are encrypted end-to-end' },
      { icon: '🔄', text: '<strong>Refund policy</strong> — raise a dispute within 7 days if your order is not as described' },
      { icon: '📦', text: '<strong>Order tracking</strong> — track your delivery from dispatch to door' },
      { icon: '✅', text: '<strong>Delivery confirmation</strong> — payment is released to seller after confirmed delivery' },
      { icon: '🛡', text: '<strong>Dispute process</strong> — our team mediates any seller disputes fairly' },
    ],
    service: [
      { icon: '🔒', text: '<strong>Secure payment</strong> — all transactions are encrypted end-to-end' },
      { icon: '✅', text: '<strong>Verified provider</strong> — all service providers are vetted before listing' },
      { icon: '🔄', text: '<strong>Cancellation policy</strong> — cancel up to 24 hours before for a full refund' },
      { icon: '🛡', text: '<strong>Dispute process</strong> — our team mediates any provider disputes fairly' },
    ],
    digital: [
      { icon: '🔒', text: '<strong>Secure download</strong> — your files are delivered over an encrypted connection' },
      { icon: '🔄', text: '<strong>Refund policy</strong> — contact support within 24 hours if there is an issue' },
      { icon: '🛡', text: '<strong>Fraud protection</strong> — every transaction is monitored for suspicious activity' },
    ],
    pos: [
      { icon: '🔒', text: '<strong>Secure payment processing</strong> — 256-bit SSL encryption' },
      { icon: '📄', text: '<strong>Digital receipt</strong> — sent to your phone or email automatically' },
      { icon: '🛡', text: '<strong>PCI compliant</strong> — your card data is never stored on our servers' },
    ],
  };

  /* ── Seller badge config ── */
  const SELLER_LEVELS = {
    seller:       { label: 'Verified Seller',           cls: 'seller',       icon: '✓' },
    business:     { label: 'Verified Business',         cls: 'business',     icon: '🏢' },
    provider:     { label: 'Verified Service Provider', cls: 'provider',     icon: '⭐' },
    professional: { label: 'Verified Professional',     cls: 'professional', icon: '🎓' },
  };

  /* ── Active receipts (keyed by receiptNo) ── */
  const _receipts = {};

  /* ── Receipt overlay singleton ── */
  let _overlay = null;

  /* ── Active status element and phase dots ── */
  let _statusEl = null;
  let _phaseDots = [];
  const PHASE_ORDER = ['preparing','waiting','received','verified','completing','receipt','complete'];

  /* ── Escape helper (XSS) ── */
  function _e(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  /* ── Format KES ── */
  function _kes(n) {
    return 'KES ' + Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /* ── IntaSend official badge SVG ── */
  function _isShieldSvg(size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2L3 6v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V6L12 2z" fill="#00a651"/>
      <path d="M10 14l-3-3 1.4-1.4L10 11.2l5.6-5.6L17 7l-7 7z" fill="white"/>
    </svg>`;
  }

  /* ── Generic lock SVG ── */
  function _lockSvg(size, color) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">
      <rect x="5" y="11" width="14" height="10" rx="2" fill="${color || '#00a651'}" opacity=".85"/>
      <path d="M8 11V7a4 4 0 018 0v4" stroke="${color || '#00a651'}" stroke-width="2" stroke-linecap="round"/>
      <circle cx="12" cy="16" r="1.5" fill="white"/>
    </svg>`;
  }

  /* ================================================================
     BADGE — IntaSend official badge
  ================================================================ */
  function renderBadge(el, opts) {
    opts = opts || {};
    const variant = opts.variant || 'full'; // 'full' | 'compact' | 'banner'

    if (variant === 'banner') {
      el.innerHTML = `
        <div class="st-badge-banner">
          <div class="st-badge-item">${_lockSvg(14, '#00a651')} Secure Payment</div>
          <div class="st-sep"></div>
          <div class="st-badge-item">${_isShieldSvg(14)} Powered by IntaSend</div>
          <div class="st-sep"></div>
          <div class="st-badge-item">${_lockSvg(14, '#00a651')} 256-bit SSL Encrypted</div>
          <div class="st-sep"></div>
          <div class="st-badge-item"><span style="font-size:14px">✓</span> PCI DSS Compliant</div>
        </div>`;
      return;
    }

    if (variant === 'compact') {
      el.innerHTML = `
        <div class="st-badge-group">
          <div class="st-badge compact">${_lockSvg(12)} Secure &amp; Encrypted</div>
          <div class="st-badge compact">${_isShieldSvg(12)} IntaSend</div>
        </div>`;
      return;
    }

    /* Full — default */
    el.innerHTML = `
      <div class="st-intasend-badge">
        <div class="st-is-logo">${_isShieldSvg(28)} <span>IntaSend</span></div>
        <div class="st-is-sep"></div>
        <div class="st-is-pills">
          <div class="st-is-pill">✓ Secure Checkout</div>
          <div class="st-is-pill">✓ 256-bit SSL Encrypted</div>
          <div class="st-is-pill">✓ PCI DSS Compliant</div>
        </div>
      </div>`;
  }

  /* ================================================================
     STATUS BAR — payment status with phase dots
  ================================================================ */
  function renderStatus(el) {
    _statusEl = el;
    const dots = PHASE_ORDER.map((p, i) => `<div class="st-phase-dot" data-phase="${p}" id="st-pd-${i}"></div>`).join('');
    el.innerHTML = `
      <div class="st-status preparing" id="st-status-inner">
        <div class="st-status-row">
          <div class="st-status-icon" id="st-status-icon">⟳</div>
          <div class="st-status-text">
            <div class="st-status-title" id="st-status-title">Preparing payment</div>
            <div class="st-status-desc"  id="st-status-desc">Setting up your secure payment session…</div>
          </div>
        </div>
        <div class="st-status-phase">${dots}</div>
      </div>`;
    _phaseDots = Array.from(el.querySelectorAll('.st-phase-dot'));
  }

  function setStatus(phase, customMsg) {
    const def = PHASES[phase];
    if (!def) return;

    const inner = document.getElementById('st-status-inner');
    const icon  = document.getElementById('st-status-icon');
    const title = document.getElementById('st-status-title');
    const desc  = document.getElementById('st-status-desc');
    if (!inner) return;

    inner.className = 'st-status ' + phase;
    if (icon) {
      icon.textContent = def.icon;
      icon.classList.toggle('st-spinning', !!def.spin);
    }
    if (title) title.textContent = def.label;
    if (desc)  desc.textContent  = customMsg || def.desc;

    /* Update phase dots */
    const idx = PHASE_ORDER.indexOf(phase);
    _phaseDots.forEach((dot, i) => {
      dot.className = 'st-phase-dot';
      if (i < idx) dot.classList.add('done');
      else if (i === idx) dot.classList.add('active');
    });

    /* Broadcast to customer display if available */
    if (global.SokoniTrust && global.SokoniTrust._channel) {
      global.SokoniTrust._channel.postMessage({ type: 'trust_status', phase, label: def.label });
    }
  }

  /* ================================================================
     PRICE BREAKDOWN — transparent pricing
  ================================================================ */
  function renderBreakdown(el, rows) {
    if (!Array.isArray(rows)) {
      try { rows = JSON.parse(el.dataset.items || '[]'); } catch (_) { rows = []; }
    }

    const rowHtml = rows.map(r => {
      const cls = r.type ? ` ${_e(r.type)}` : '';
      const prefix = (r.type === 'discount' || r.type === 'coupon') ? '−' : '';
      const sign   = (r.type === 'discount' || r.type === 'coupon') ? '-' : '';
      if (r.type === 'total') {
        return `<div class="st-breakdown-row total">
          <span class="st-bd-label">${_e(r.label)}</span>
          <span class="st-bd-amount">${_kes(r.amount)}</span>
        </div>`;
      }
      return `<div class="st-breakdown-row${cls}">
        <span class="st-bd-label">${_e(r.label)}</span>
        <span class="st-bd-amount">${prefix}${_kes(r.amount)}</span>
      </div>`;
    }).join('');

    el.innerHTML = `
      <div class="st-breakdown">
        <div class="st-breakdown-header">${_lockSvg(12)} Price Breakdown</div>
        ${rowHtml}
        <div class="st-no-hidden">${_lockSvg(10)} No hidden charges</div>
      </div>`;
  }

  /* ================================================================
     BUYER PROTECTION
  ================================================================ */
  function renderProtection(el, type) {
    type = type || el.dataset.type || 'marketplace';
    const items = PROTECTIONS[type] || PROTECTIONS.marketplace;
    const listHtml = items.map(p =>
      `<div class="st-protection-item"><span class="st-pi-icon">${p.icon}</span><span>${p.text}</span></div>`
    ).join('');
    el.innerHTML = `
      <div class="st-protection">
        <div class="st-protection-title">${_lockSvg(12)} Buyer Protection</div>
        <div class="st-protection-list">${listHtml}</div>
      </div>`;
  }

  /* ================================================================
     SELLER BADGE
  ================================================================ */
  function renderSellerBadge(el, level, merchantName) {
    level = level || el.dataset.level || 'seller';
    merchantName = merchantName || el.dataset.merchant || '';
    const def = SELLER_LEVELS[level] || SELLER_LEVELS.seller;
    el.innerHTML = `<span class="st-seller-badge ${def.cls}">${def.icon} ${_e(def.label)}</span>`;
  }

  function renderSellerTrustCard(el, opts) {
    opts = opts || {};
    const level      = opts.level || 'seller';
    const def        = SELLER_LEVELS[level] || SELLER_LEVELS.seller;
    const merchant   = _e(opts.name || 'This Seller');
    const joinedYear = _e(opts.joinedYear || new Date().getFullYear());
    const sales      = opts.sales ? _e(String(opts.sales)) : null;
    const rating     = opts.rating ? _e(String(opts.rating)) : null;

    const extra = [
      `<div class="st-stc-item">📅 Member since ${joinedYear}</div>`,
      sales  ? `<div class="st-stc-item">🛒 ${sales} sales</div>` : '',
      rating ? `<div class="st-stc-item">⭐ ${rating} rating</div>` : '',
    ].join('');

    el.innerHTML = `
      <div class="st-seller-trust-card">
        <div class="st-stc-header">
          <div class="st-stc-name">${merchant}</div>
          <span class="st-seller-badge ${def.cls}">${def.icon} ${_e(def.label)}</span>
        </div>
        <div class="st-stc-items">${extra}</div>
      </div>`;
  }

  /* ================================================================
     TRUST FOOTER
  ================================================================ */
  function renderFooter(el) {
    el.innerHTML = `
      <div class="st-footer">
        <div class="st-footer-badges">
          <span class="st-footer-pill">${_lockSvg(10)} 256-bit SSL</span>
          <span class="st-footer-pill">${_isShieldSvg(10)} IntaSend Secured</span>
          <span class="st-footer-pill">✓ PCI DSS</span>
          <span class="st-footer-pill">🇰🇪 CBK Compliant</span>
        </div>
        <div class="st-footer-text">
          Payments processed securely by IntaSend. Your card and M-Pesa details are encrypted and never stored on SOKONI servers.
        </div>
      </div>`;
  }

  /* ================================================================
     DIGITAL RECEIPT MODAL
  ================================================================ */
  function _ensureOverlay() {
    if (_overlay) return _overlay;
    _overlay = document.createElement('div');
    _overlay.className = 'st-receipt-overlay';
    _overlay.setAttribute('role', 'dialog');
    _overlay.setAttribute('aria-modal', 'true');
    _overlay.setAttribute('aria-label', 'Payment Receipt');
    _overlay.innerHTML = `<div class="st-receipt-modal" id="st-receipt-modal"></div>`;
    _overlay.addEventListener('click', e => { if (e.target === _overlay) hideReceipt(); });
    document.body.appendChild(_overlay);
    return _overlay;
  }

  function _buildQRCode(text) {
    /* Renders a basic QR placeholder. If qrcode.js is available, uses it. */
    const canvas = document.createElement('canvas');
    canvas.width  = 120;
    canvas.height = 120;
    canvas.className = 'st-qr-canvas';
    if (global.QRCode) {
      try {
        new global.QRCode(canvas, { text, width: 120, height: 120, correctLevel: global.QRCode.CorrectLevel.M });
      } catch (_) {
        _drawPlaceholderQR(canvas, text);
      }
    } else {
      _drawPlaceholderQR(canvas, text);
    }
    return canvas;
  }

  function _drawPlaceholderQR(canvas, text) {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 120, 120);
    ctx.fillStyle = '#333';
    /* Finder patterns */
    [[8,8],[8,84],[84,8]].forEach(([x,y]) => {
      ctx.fillRect(x-8, y-8, 28, 28);
      ctx.fillStyle = '#fff';
      ctx.fillRect(x-5, y-5, 22, 22);
      ctx.fillStyle = '#333';
      ctx.fillRect(x-2, y-2, 16, 16);
      ctx.fillStyle = '#333';
    });
    /* Receipt ref text */
    ctx.font = '7px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#555';
    ctx.fillText(text.slice(-8), 60, 115);
  }

  function showReceipt(data) {
    const overlay = _ensureOverlay();
    const modal   = overlay.querySelector('#st-receipt-modal');
    if (!modal) return;

    const receiptNo  = _e(data.receiptNo || 'N/A');
    const merchant   = _e(data.merchantName || 'SOKONI');
    const address    = _e(data.merchantAddress || '');
    const phone      = _e(data.merchantPhone || '');
    const date       = _e(data.date || new Date().toLocaleString('en-KE'));
    const cashier    = _e(data.cashierName || '');
    const payMethod  = _e(data.paymentMethod || 'M-Pesa');
    const payRef     = _e(data.paymentRef || '');
    const customer   = data.customerName ? _e(data.customerName) : null;
    const items      = Array.isArray(data.items) ? data.items : [];
    const subtotal   = data.subtotal || 0;
    const tax        = data.tax || 0;
    const discount   = data.discount || 0;
    const total      = data.total || data.grandTotal || 0;
    const loyalty    = data.loyaltyEarned || 0;

    _receipts[receiptNo] = data;

    const itemsHtml = items.map(it =>
      `<div class="st-receipt-item">
        <span class="st-ri-name">${_e(it.name || it.description || 'Item')}</span>
        <span class="st-ri-qty">×${_e(String(it.qty || 1))}</span>
        <span class="st-ri-price">${_kes((it.unitPrice || it.price || 0) * (it.qty || 1))}</span>
      </div>`
    ).join('');

    const totalsHtml = [
      items.length > 1 ? `<div class="st-receipt-total-row"><span>Subtotal</span><span>${_kes(subtotal)}</span></div>` : '',
      discount > 0 ? `<div class="st-receipt-total-row" style="color:#00a651"><span>Discount</span><span>−${_kes(discount)}</span></div>` : '',
      tax > 0      ? `<div class="st-receipt-total-row"><span>VAT (16%)</span><span>${_kes(tax)}</span></div>` : '',
      `<div class="st-receipt-total-row grand"><span>TOTAL</span><span class="st-rt-amount">${_kes(total)}</span></div>`,
    ].join('');

    const loyaltyHtml = loyalty > 0
      ? `<div style="text-align:center;font-size:12px;color:#00a651;margin-bottom:8px;">+${loyalty} loyalty points earned</div>`
      : '';

    /* QR points to public receipt page */
    const receiptUrl = `${location.origin}/payment-receipt.html?ref=${encodeURIComponent(receiptNo)}`;
    const qrCanvas   = _buildQRCode(receiptUrl);

    modal.innerHTML = `
      <div class="st-receipt-header">
        <div class="st-receipt-title">Receipt</div>
        <button class="st-receipt-close" onclick="SokoniTrust.hideReceipt()" aria-label="Close">✕</button>
      </div>
      <div class="st-receipt-body">
        <div class="st-receipt-merchant">
          <div class="st-rm-name">${merchant}</div>
          ${address ? `<div class="st-rm-sub">${address}</div>` : ''}
          ${phone   ? `<div class="st-rm-sub">${phone}</div>`   : ''}
        </div>
        <hr class="st-receipt-divider">
        <div class="st-receipt-meta">
          <div class="st-receipt-meta-item"><div class="st-rmi-label">Receipt No</div><div class="st-rmi-val">${receiptNo}</div></div>
          <div class="st-receipt-meta-item"><div class="st-rmi-label">Date &amp; Time</div><div class="st-rmi-val">${date}</div></div>
          ${cashier  ? `<div class="st-receipt-meta-item"><div class="st-rmi-label">Cashier</div><div class="st-rmi-val">${cashier}</div></div>` : ''}
          ${customer ? `<div class="st-receipt-meta-item"><div class="st-rmi-label">Customer</div><div class="st-rmi-val">${customer}</div></div>` : ''}
        </div>
        <hr class="st-receipt-divider">
        <div class="st-receipt-items">${itemsHtml || '<div class="st-receipt-item"><span class="st-ri-name">Payment</span><span class="st-ri-price">' + _kes(total) + '</span></div>'}</div>
        <div class="st-receipt-totals">${totalsHtml}</div>
        ${loyaltyHtml}
        <div class="st-receipt-payment-badge">
          ✓ Paid via ${payMethod}${payRef ? ' · Ref: ' + payRef : ''}
        </div>
        <div class="st-receipt-qr">
          <div id="st-qr-mount" style="background:white;padding:8px;border-radius:8px;"></div>
          <div class="st-qr-ref">${receiptNo}</div>
          <div class="st-qr-label">Scan to verify this receipt</div>
        </div>
        <div class="st-receipt-actions">
          <button class="st-receipt-action st-ra-download" onclick="SokoniTrust.downloadReceipt('${receiptNo}')">
            ⬇ Download PDF
          </button>
          <button class="st-receipt-action st-ra-email" onclick="SokoniTrust.promptEmailReceipt('${receiptNo}')">
            ✉ Email
          </button>
          <button class="st-receipt-action st-ra-print" onclick="window.print()">
            🖨 Print
          </button>
        </div>
      </div>`;

    /* Mount QR canvas */
    const qrMount = modal.querySelector('#st-qr-mount');
    if (qrMount) qrMount.appendChild(qrCanvas);

    overlay.classList.add('visible');
    document.body.style.overflow = 'hidden';
  }

  function hideReceipt() {
    if (_overlay) {
      _overlay.classList.remove('visible');
      document.body.style.overflow = '';
    }
  }

  function downloadReceipt(receiptNo) {
    /* Generate a printable view and trigger browser save */
    const data    = _receipts[receiptNo];
    const winRef  = window.open('', '_blank', 'width=480,height=700,menubar=yes,toolbar=yes');
    if (!winRef) { window.print(); return; }
    const css     = document.querySelector('link[href*="sokoni-trust"]');
    const cssHref = css ? css.href : '/sokoni-trust.css';

    winRef.document.write(`<!DOCTYPE html><html><head>
      <meta charset="UTF-8"><title>Receipt ${_e(receiptNo)}</title>
      <link rel="stylesheet" href="${cssHref}">
      <style>body{margin:0;background:#fff;font-family:Arial,sans-serif;}</style>
    </head><body></body></html>`);

    winRef.document.close();
    winRef.onload = () => {
      /* Build receipt HTML in new window and print */
      const tmpDiv = winRef.document.createElement('div');
      tmpDiv.className = 'st-receipt-overlay visible';
      tmpDiv.innerHTML = document.getElementById('st-receipt-modal').outerHTML;
      winRef.document.body.appendChild(tmpDiv);
      /* Remove action buttons from print view */
      tmpDiv.querySelectorAll('.st-receipt-actions, .st-receipt-close, .st-receipt-header').forEach(el => el.remove());
      winRef.focus();
      winRef.print();
    };
  }

  function promptEmailReceipt(receiptNo) {
    const email = window.prompt('Enter email address for receipt:');
    if (!email || !email.includes('@')) { return; }
    emailReceipt(receiptNo, email);
  }

  function emailReceipt(receiptNo, email) {
    if (!global.firebase || !global.firebase.functions) {
      console.warn('SokoniTrust: firebase.functions not available for emailReceipt');
      return Promise.resolve({ ok: false });
    }
    const fn = global.firebase.functions().httpsCallable('emailTrustReceipt');
    return fn({ receiptNo, email }).then(r => {
      if (r.data?.sent) {
        _toast('Receipt sent to ' + email, 'success');
      } else {
        _toast('Could not send email — please download instead', 'warning');
      }
      return r.data;
    }).catch(() => {
      _toast('Email failed — please download instead', 'error');
      return { ok: false };
    });
  }

  /* ── Simple toast (falls back to SokoniToast if available) ── */
  function _toast(msg, type) {
    if (global._toast) { global._toast(msg, type); return; }
    const t = document.createElement('div');
    t.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
      background:${type==='success'?'#00a651':type==='error'?'#c62828':'#555'};
      color:white;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;
      z-index:99999;pointer-events:none;transition:opacity .3s;`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 2800);
  }

  /* ================================================================
     DUPLICATE PAYMENT DETECTION (client-side guard)
     Server-side check is in posCompleteCheckout (idempotency key).
     This client-side check catches accidental double-taps.
  ================================================================ */
  const _recentPayments = [];

  function checkDuplicate(amount, method) {
    const now = Date.now();
    const key = `${method}_${Math.round(amount)}`;
    const dup = _recentPayments.find(p => p.key === key && (now - p.ts) < 5 * 60 * 1000);
    if (dup) {
      console.warn('SokoniTrust: duplicate payment detected', { amount, method, previous: dup.ts });
      return true;
    }
    _recentPayments.push({ key, ts: now });
    /* Keep only last 20 */
    if (_recentPayments.length > 20) _recentPayments.shift();
    return false;
  }

  /* ================================================================
     AUTO-INIT — discovers data-trust attributes on DOMContentLoaded
  ================================================================ */
  function init(opts) {
    opts = opts || {};
    document.querySelectorAll('[data-trust]').forEach(el => {
      const type = el.dataset.trust;
      switch (type) {
        case 'badge':      renderBadge(el, { variant: el.dataset.variant });      break;
        case 'status':     renderStatus(el);                                       break;
        case 'breakdown':  renderBreakdown(el, null);                             break;
        case 'protection': renderProtection(el, el.dataset.type);                 break;
        case 'seller':     renderSellerBadge(el, el.dataset.level, el.dataset.merchant); break;
        case 'footer':     renderFooter(el);                                       break;
      }
    });

    /* Auto-attach BroadcastChannel for display sync */
    if ('BroadcastChannel' in global && !global.SokoniTrust._channel) {
      global.SokoniTrust._channel = new BroadcastChannel('sokoni_trust_display');
    }
  }

  /* ── Public API ── */
  global.SokoniTrust = {
    /* Auto-init */
    init,

    /* Badge */
    badge: renderBadge,
    intasendBadge: (el, opts) => renderBadge(el, Object.assign({ variant: 'full' }, opts)),

    /* Status */
    renderStatus,
    setStatus,

    /* Transparency */
    breakdown: renderBreakdown,

    /* Protection */
    protections: renderProtection,

    /* Seller */
    sellerBadge:      renderSellerBadge,
    sellerTrustCard:  renderSellerTrustCard,

    /* Receipt */
    showReceipt,
    hideReceipt,
    downloadReceipt,
    emailReceipt,
    promptEmailReceipt,

    /* Footer */
    footer: renderFooter,

    /* Security */
    checkDuplicate,

    /* Internal: broadcast channel (set by init) */
    _channel: null,

    /* Constants exposed for external use */
    PHASES,
    PROTECTIONS,
    SELLER_LEVELS,
  };

  /* Auto-run on DOMContentLoaded */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init());
  } else {
    init();
  }

})(window);
