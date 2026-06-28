/**
 * sokoni-qr.js — SOKONI Unified QR Code Engine v1.0
 * Client-side QR generation, rendering, download, print, and scan.
 * Uses Google Charts API for QR image generation (no external library needed).
 */
window.SokoniQR = (() => {
  'use strict';

  // ─── QR Type Registry ────────────────────────────────────────────────────
  const QR_TYPES = {
    SHOP:          'shop',
    PRODUCT:       'product',
    ORDER:         'order',
    EVENT:         'event',
    VENUE:         'venue',
    JOB:           'job',
    LOYALTY:       'loyalty',
    PAYMENT:       'payment',
    BUSINESS_CARD: 'card',
    CUSTOM:        'custom',
  };

  const BASE_URL = 'https://mysokoni.co.ke';

  // ─── URL Builder ─────────────────────────────────────────────────────────
  function _buildUrl(type, id, base) {
    base = base || BASE_URL;
    const routes = {
      shop:    `/shop/${id}`,
      product: `/product?id=${id}`,
      order:   `/track/${id}`,
      event:   `/event?id=${id}`,
      venue:   `/venue-booking?id=${id}`,
      job:     `/jobs?job=${id}`,
      loyalty: `/loyalty?ref=${id}`,
      payment: `/checkout?ref=${id}`,
      card:    `/card/${id}`,
      custom:  id, // id IS the full URL for custom type
    };
    const path = routes[type];
    if (path === undefined) return `${base}/${id}`;
    // For custom type, id is already the full URL
    if (type === 'custom') return id;
    return `${base}${path}`;
  }

  // ─── Generate QR Image URL (Google Charts) ───────────────────────────────
  /**
   * Returns a Google Charts QR code image URL.
   * @param {string} type - QR_TYPES value
   * @param {string} id   - Entity ID or URL (for custom)
   * @param {object} options - { size, color, bg, ecl, baseUrl, label }
   * @returns {string} Image URL
   */
  function generate(type, id, options) {
    options = options || {};
    const size  = options.size  || 300;
    const color = options.color || '000000';
    const bg    = options.bg    || 'FFFFFF';
    const ecl   = options.ecl   || 'M';
    const base  = options.baseUrl || BASE_URL;
    const url   = _buildUrl(type, id, base);
    return `https://chart.googleapis.com/chart?chs=${size}x${size}&cht=qr&chl=${encodeURIComponent(url)}&choe=UTF-8&chld=${ecl}|0&chco=${color}|${bg}`;
  }

  // ─── Render QR into DOM Element ──────────────────────────────────────────
  /**
   * Renders a QR code image into the provided DOM element.
   * @param {HTMLElement} el
   * @param {string} type
   * @param {string} id
   * @param {object} options
   * @returns {string} The generated image src URL
   */
  function renderTo(el, type, id, options) {
    options = options || {};
    const src   = generate(type, id, options);
    const label = options.label || type;
    const size  = options.size  || 300;
    el.innerHTML = `<img src="${src}" alt="QR Code for ${label}" width="${size}" height="${size}" style="border-radius:8px;display:block;max-width:100%">`;
    return src;
  }

  // ─── Download QR as PNG ──────────────────────────────────────────────────
  /**
   * Downloads the QR image as a PNG file.
   * @param {string} imgSrc - The Google Charts image URL
   * @param {string} filename - Download filename
   */
  function download(imgSrc, filename) {
    filename = filename || 'sokoni-qr.png';
    fetch(imgSrc)
      .then(function(r) { return r.blob(); })
      .then(function(blob) {
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href     = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function() { URL.revokeObjectURL(url); }, 5000);
      })
      .catch(function(err) {
        console.error('[SokoniQR] Download failed:', err);
        // Fallback: open image in new tab
        window.open(imgSrc, '_blank');
      });
  }

  // ─── Print QR Sheet ──────────────────────────────────────────────────────
  /**
   * Opens a print-ready window with a grid of QR codes on an A4 sheet.
   * @param {Array<{type, id, label, size}>} codes
   */
  function printSheet(codes) {
    if (!codes || codes.length === 0) {
      alert('No QR codes to print.');
      return;
    }
    const items = codes.map(function(c) {
      const src  = generate(c.type, c.id, { size: c.size || 200 });
      const lbl  = _escapeHtml(c.label || c.type);
      return `<div class="qr-item">
        <img src="${src}" width="200" height="200" alt="${lbl}">
        <div class="qr-label">${lbl}</div>
      </div>`;
    }).join('');

    const win = window.open('', '_blank');
    if (!win) {
      alert('Please allow popups to print QR codes.');
      return;
    }
    win.document.write(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>QR Codes — SOKONI</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; background: #fff; color: #111; padding: 20px; }
    h1 { font-size: 18px; margin-bottom: 16px; color: #00bcd4; }
    .no-print { margin-bottom: 20px; display: flex; gap: 12px; }
    .no-print button {
      padding: 8px 20px; border: none; border-radius: 6px;
      cursor: pointer; font-size: 14px; font-weight: 600;
    }
    .btn-print { background: #00bcd4; color: #fff; }
    .btn-close { background: #eee; color: #333; }
    .qr-grid {
      display: flex; flex-wrap: wrap; gap: 24px;
      justify-content: flex-start;
    }
    .qr-item {
      text-align: center; border: 1px solid #ddd;
      padding: 16px; border-radius: 8px; background: #fff;
      break-inside: avoid; page-break-inside: avoid;
    }
    .qr-item img { display: block; }
    .qr-label { font-size: 12px; margin-top: 8px; font-weight: 600; color: #333; }
    @media print {
      .no-print { display: none !important; }
      body { padding: 10px; }
      .qr-grid { gap: 16px; }
    }
    @page { size: A4; margin: 15mm; }
  </style>
</head>
<body>
  <div class="no-print">
    <button class="btn-print" onclick="window.print()">Print</button>
    <button class="btn-close" onclick="window.close()">Close</button>
  </div>
  <div class="qr-grid">${items}</div>
</body>
</html>`);
    win.document.close();
  }

  // ─── QR Scanner (BarcodeDetector API) ───────────────────────────────────
  /**
   * Activates the device camera to scan QR codes.
   * Uses BarcodeDetector API where available.
   * @param {HTMLVideoElement} videoEl - Video element for camera feed
   * @param {function} onDetect - Callback(rawValue: string)
   * @returns {Promise<{supported: boolean, stop?: function, message?: string}>}
   */
  async function scan(videoEl, onDetect) {
    if (!('BarcodeDetector' in window)) {
      return {
        supported: false,
        message: 'QR scanning not supported in this browser. Use Chrome on Android or desktop.',
      };
    }
    let intervalId = null;
    let stream     = null;
    try {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      videoEl.srcObject = stream;
      await videoEl.play();

      intervalId = setInterval(async () => {
        try {
          const codes = await detector.detect(videoEl);
          if (codes.length > 0) {
            _stopScan(intervalId, stream);
            onDetect(codes[0].rawValue);
          }
        } catch (e) {
          // Detection frame error — continue
        }
      }, 300);

      return {
        supported: true,
        stop: function() { _stopScan(intervalId, stream); },
      };
    } catch (err) {
      if (stream) stream.getTracks().forEach(function(t) { t.stop(); });
      throw err;
    }
  }

  function _stopScan(intervalId, stream) {
    if (intervalId) clearInterval(intervalId);
    if (stream) stream.getTracks().forEach(function(t) { t.stop(); });
  }

  // ─── Utilities ───────────────────────────────────────────────────────────
  function _escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Builds a destination URL string (without generating the QR image).
   * Useful for display / copy-to-clipboard.
   * @param {string} type
   * @param {string} id
   * @param {string} [base]
   * @returns {string}
   */
  function buildUrl(type, id, base) {
    return _buildUrl(type, id, base || BASE_URL);
  }

  // ─── Public API ──────────────────────────────────────────────────────────
  return {
    QR_TYPES,
    generate,
    renderTo,
    download,
    printSheet,
    scan,
    buildUrl,
  };
})();
