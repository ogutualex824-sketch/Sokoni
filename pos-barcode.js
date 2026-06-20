/* SOKONI SmartPOS — Barcode Scanner & Generator v1.0
   Supports: Hardware scanner (keyboard wedge), Camera (BarcodeDetector API),
   Manual entry fallback, and SVG barcode generation. */

const PosBarcode = (function () {
  'use strict';

  let _callback   = null;
  let _stream     = null;
  let _detector   = null;
  let _scanTimer  = null;
  let _videoEl    = null;
  let _active     = false;

  /* Hardware scanner state — scanners type very fast and send Enter */
  let _hwBuffer = '';
  let _hwTimer  = null;
  let _lastCode = '';
  let _lastTime = 0;

  /* ── Init ────────────────────────────────────────────────────── */
  async function init() {
    if ('BarcodeDetector' in window) {
      try {
        const fmts = await BarcodeDetector.getSupportedFormats().catch(() => []);
        const use  = fmts.length
          ? fmts
          : ['ean_13','ean_8','upc_a','upc_e','code_128','code_39','qr_code','data_matrix'];
        _detector = new BarcodeDetector({ formats: use });
      } catch (_) { _detector = null; }
    }
    document.addEventListener('keydown', _onKey, true);
    return { detector: !!_detector };
  }

  /* ── Hardware scanner intercept ──────────────────────────────── */
  function _onKey(e) {
    if (!_callback) return;

    /* Skip if a real text field is focused (not our scanner input) */
    const tgt = e.target;
    const isRealField = ['INPUT','TEXTAREA','SELECT'].includes(tgt.tagName)
                        && !tgt.dataset.posScanner;
    if (isRealField) return;

    if (e.key === 'Enter') {
      if (_hwBuffer.length > 2) {
        const code = _hwBuffer.trim();
        _hwBuffer  = '';
        clearTimeout(_hwTimer);
        _emit(code);
      }
      e.preventDefault();
      return;
    }

    if (e.key.length === 1) {
      _hwBuffer += e.key;
      clearTimeout(_hwTimer);
      _hwTimer = setTimeout(() => { _hwBuffer = ''; }, 120); /* scanners finish in <100ms */
    }
  }

  function _emit(code) {
    const now = Date.now();
    /* Debounce: ignore same code scanned within 1.5s */
    if (code === _lastCode && now - _lastTime < 1500) return;
    _lastCode = code;
    _lastTime = now;
    if (_callback) _callback(code);
  }

  /* ── Camera scanning ─────────────────────────────────────────── */
  async function startCamera(videoEl, cb) {
    if (!videoEl) return false;
    _videoEl  = videoEl;
    _callback = cb;
    _active   = true;

    try {
      _stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      videoEl.srcObject = _stream;
      await new Promise((res, rej) => {
        videoEl.onloadedmetadata = res;
        setTimeout(rej, 5000);
      });
      await videoEl.play().catch(() => {});

      if (_detector) {
        _scanTimer = setInterval(async () => {
          if (!_active || videoEl.readyState < 2) return;
          try {
            const barcodes = await _detector.detect(videoEl);
            if (barcodes.length > 0) _emit(barcodes[0].rawValue);
          } catch (_) {}
        }, 350);
      } else {
        /* Fallback: alert user that manual entry is needed */
        console.warn('[PosBarcode] BarcodeDetector not available — use hardware scanner or manual entry');
      }
      return true;
    } catch (e) {
      console.warn('[PosBarcode] Camera error:', e.message);
      return false;
    }
  }

  function stopCamera() {
    _active = false;
    clearInterval(_scanTimer);
    if (_stream)  { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
    if (_videoEl) { _videoEl.srcObject = null; _videoEl = null; }
  }

  function setCallback(cb) { _callback = cb; }
  function clearCallback()  { _callback = null; }

  function destroy() {
    stopCamera();
    document.removeEventListener('keydown', _onKey, true);
  }

  /* ── Generate barcode SVG ────────────────────────────────────── */
  /* Renders a visual approximation of Code128 for display/labels.
     For print-quality barcodes, integrate jsbarcode or a server-side renderer. */
  function generateSVG(value, options = {}) {
    const w = options.width  || 250;
    const h = options.height || 80;
    const textSize = options.textSize || 11;

    /* Build a deterministic but visually barcode-like pattern from the value */
    const barH   = h - textSize - 10;
    const startX = 6;
    let bars = [];
    let x    = startX;

    /* Start bars */
    for (const w of [2, 1, 2]) {
      bars.push({ x, w, bar: bars.length % 2 === 0 });
      x += w + 1;
    }

    /* Data bars — derived from char codes */
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      const pattern = [
        1 + (code >> 6 & 1),
        1 + (code >> 5 & 1),
        1 + (code >> 4 & 1),
        1 + (code >> 3 & 1),
        1 + (code >> 2 & 1),
        1 + (code >> 1 & 1),
        1 + (code      & 1),
      ];
      let isBar = true;
      for (const pw of pattern) {
        bars.push({ x, w: pw, bar: isBar });
        x += pw + 1;
        isBar = !isBar;
      }
    }

    /* Stop bars */
    for (const pw of [2, 3, 1]) {
      bars.push({ x, w: pw, bar: bars.length % 2 === 0 });
      x += pw + 1;
    }

    const totalW = x + startX;
    const scale  = (w - 12) / totalW;

    const rects = bars
      .filter(b => b.bar)
      .map(b => `<rect x="${(b.x * scale + 6).toFixed(1)}" y="5" width="${Math.max(1, b.w * scale).toFixed(1)}" height="${barH}" fill="#000"/>`)
      .join('');

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <rect width="${w}" height="${h}" fill="#fff" rx="2"/>
      ${rects}
      <text x="${w / 2}" y="${h - 2}" text-anchor="middle" font-family="monospace" font-size="${textSize}" fill="#000">${value}</text>
    </svg>`;
  }

  /* ── Generate EAN-13 check digit ─────────────────────────────── */
  function ean13CheckDigit(digits12) {
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      sum += parseInt(digits12[i]) * (i % 2 === 0 ? 1 : 3);
    }
    return (10 - (sum % 10)) % 10;
  }

  /* ── Auto-generate a unique barcode ─────────────────────────────
     Format: 619 + 7-digit product sequence + check digit (EAN-13)
     619 = Kenya country code */
  function generateProductBarcode(sequence) {
    const prefix = '619';
    const seq    = String(sequence).padStart(7, '0').slice(-7);
    const digits = prefix + seq;
    const check  = ean13CheckDigit(digits);
    return digits + check;
  }

  return { init, startCamera, stopCamera, setCallback, clearCallback, destroy, generateSVG, generateProductBarcode, ean13CheckDigit };
})();

window.PosBarcode = PosBarcode;
