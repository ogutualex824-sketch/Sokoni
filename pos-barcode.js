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
  /* ── ZXing fallback decoder ─────────────────────────────────────────
     2026-09-30: the merchant's scanner reported "unavailable". BarcodeDetector is the only
     decoder this module had, and it is honest only on Android Chrome: on Windows / Linux
     Chrome and Edge the constructor exists but getSupportedFormats() is EMPTY and every
     detect() rejects ("Barcode detection service unavailable"); on iOS Safari and Firefox
     the API is absent. sokoni-barcode.js already carries a ZXing (WASM) fallback from the
     same CDN — this is the same engine, so every scan path here (live camera, image upload,
     hardware wedge) resolves on every device, still through the ONE submitScannedCode. */
  const ZXING_CDN = 'https://unpkg.com/@zxing/library@0.20.0/umd/index.min.js';
  let _zxingP = null, _zxingReader = null, _zxingFailed = false, _nativeUnusable = false;
  function _loadZXing() {
    if (typeof window.ZXing !== 'undefined') return Promise.resolve(window.ZXing);
    if (_zxingP) return _zxingP;
    _zxingP = new Promise((res, rej) => {
      const sc = document.createElement('script');
      sc.src = ZXING_CDN; sc.async = true;
      sc.onload  = () => (typeof window.ZXing !== 'undefined' ? res(window.ZXing) : rej(new Error('ZXing did not define a global')));
      sc.onerror = () => rej(new Error('ZXing failed to load'));
      document.head.appendChild(sc);
    }).catch((e) => { _zxingFailed = true; _zxingP = null; throw e; });
    return _zxingP;
  }
  async function _zxing() {
    const Z = await _loadZXing();
    if (!_zxingReader) _zxingReader = new Z.BrowserMultiFormatReader();
    return _zxingReader;
  }
  /* Any image source → a canvas ZXing can read (File/Blob, <img>, <video>, <canvas>, ImageBitmap). */
  async function _toCanvas(src) {
    let bmp = null, w = 0, h = 0, drawable = src;
    if (typeof Blob !== 'undefined' && src instanceof Blob) { bmp = await createImageBitmap(src); drawable = bmp; }
    if (typeof HTMLCanvasElement !== 'undefined' && drawable instanceof HTMLCanvasElement) return drawable;
    if (typeof HTMLVideoElement !== 'undefined' && drawable instanceof HTMLVideoElement) { w = drawable.videoWidth; h = drawable.videoHeight; }
    else { w = drawable.naturalWidth || drawable.width || 0; h = drawable.naturalHeight || drawable.height || 0; }
    if (!w || !h) { try { bmp && bmp.close && bmp.close(); } catch (_) {} throw new Error('empty_frame'); }
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(drawable, 0, 0, w, h);
    try { bmp && bmp.close && bmp.close(); } catch (_) {}
    return c;
  }
  async function _zxingDecode(src) {
    const reader = await _zxing();
    const canvas = await _toCanvas(src);
    try {
      const result = reader.decodeFromCanvas(canvas);
      const raw = result && typeof result.getText === 'function' ? result.getText() : null;
      if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'no_barcode_found' };
      const fmt = result.getBarcodeFormat ? String(result.getBarcodeFormat()) : null;
      return { ok: true, code: raw.trim(), format: fmt };
    } catch (e) {
      /* ZXing signals "nothing in this frame" as NotFoundException — a real answer, not a fault */
      return { ok: false, reason: 'no_barcode_found' };
    }
  }
  /* A decoder exists when the native one is usable, or ZXing is available / not yet proven unavailable. */
  function hasDecoder() { return !!_detector || (!_zxingFailed); }

  async function init() {
    if ('BarcodeDetector' in window) {
      try {
        const fmts = await BarcodeDetector.getSupportedFormats().catch(() => []);
        if (fmts.length) {
          _detector = new BarcodeDetector({ formats: fmts });
        } else {
          /* present but empty = unusable (desktop Chrome/Edge): fall through to ZXing */
          _nativeUnusable = true; _detector = null;
        }
      } catch (_) { _detector = null; }
    }
    if (!_detector) { _loadZXing().catch(() => {}); }   /* warm the fallback; failure is recorded, not thrown */
    document.addEventListener('keydown', _onKey, true);
    return { detector: !!_detector, fallback: !_detector ? 'zxing' : null, nativeUnusable: _nativeUnusable };
  }

  /* ── Decode a barcode from a STILL IMAGE ─────────────────────────
     A real image-processing path, not a camera preview wearing an "upload" label:
     the file is decoded to a bitmap and handed to the SAME BarcodeDetector the live
     camera path uses, so an uploaded photo and a live frame resolve identically.

     It returns the barcode VALUE ONLY. Resolution stays with the caller's callback —
     ultimately PosDB.products.getByBarcode — so no scanner surface can invent a
     product or bypass the catalogue. A decoder that returned a product id instead of
     a barcode would be a second, unauthoritative product lookup.

     Returns { ok, code, format } or { ok:false, reason }. It never throws at the
     caller and never guesses: an undecodable image is `no_barcode_found`, which is a
     real answer the UI can act on, not an error to swallow. */
  async function decodeImage(fileOrBlob) {
    if (!fileOrBlob) return { ok: false, reason: 'no_image' };
    if (!_detector) {
      if (_zxingFailed) return { ok: false, reason: 'no_decoder' };
      try { return await _zxingDecode(fileOrBlob); }
      catch (e) { return { ok: false, reason: (e && e.message === 'empty_frame') ? 'unreadable_image' : 'no_decoder' }; }
    }

    let bitmap = null;
    try {
      /* createImageBitmap handles File, Blob and ImageBitmapSource alike. */
      bitmap = await createImageBitmap(fileOrBlob);
    } catch (err) {
      return { ok: false, reason: 'unreadable_image' };
    }

    try {
      const found = await _detector.detect(bitmap);
      if (!found || !found.length) return { ok: false, reason: 'no_barcode_found' };

      /* A barcode value must be a non-empty string. A detector returning an object,
         a number, or an empty string is malformed input to a product lookup, and
         passing it on would turn a decode fault into a mysterious catalogue miss. */
      const raw = found[0] && found[0].rawValue;
      if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'malformed_result' };

      return { ok: true, code: raw.trim(), format: found[0].format || null };
    } catch (err) {
      /* Desktop Chrome/Edge: the native detector exists but its service does not. Switch this
         session to ZXing and answer the SAME frame with it, so the failure is invisible. */
      if (err && /NotSupported|not supported|unavailable/i.test(String(err.name || '') + ' ' + String(err.message || ''))) {
        _nativeUnusable = true; _detector = null;
        try { return await _zxingDecode(fileOrBlob); } catch (_) { return { ok: false, reason: 'no_decoder' }; }
      }
      return { ok: false, reason: 'decode_failed' };
    } finally {
      try { bitmap && bitmap.close && bitmap.close(); } catch (_) {}
    }
  }

  /* THE ONE RESOLUTION ENTRY POINT.
     The hardware wedge, the live camera and the image decoder all end here, so there is
     exactly one place where a scanned value becomes a cart line. `_emit` carries the
     duplicate-scan debounce, which every path therefore inherits — an image uploaded
     twice behaves like a barcode scanned twice. */
  function submitScannedCode(code) {
    if (typeof code !== 'string' || !code.trim()) return false;
    _emit(code.trim());
    return true;
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
        /* ZXing continuous decode from the same <video>; a load failure leaves the hardware
           wedge and manual entry, and says so once. */
        try {
          const reader = await _zxing();
          reader.decodeFromVideoElement(videoEl, (result) => {
            if (_active && result && typeof result.getText === 'function') _emit(result.getText());
          });
          _zxingLive = reader;
        } catch (e) {
          console.warn('[PosBarcode] no camera decoder on this device (' + (e && e.message) + ') — use hardware scanner or manual entry');
        }
      }
      return true;
    } catch (e) {
      console.warn('[PosBarcode] Camera error:', e.message);
      return false;
    }
  }

  let _zxingLive = null;
  function stopCamera() {
    _active = false;
    clearInterval(_scanTimer);
    if (_zxingLive) { try { _zxingLive.reset(); } catch (_) {} _zxingLive = null; }
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

  return { init, startCamera, stopCamera, setCallback, clearCallback, destroy, generateSVG, generateProductBarcode, ean13CheckDigit,
           /* Premium Scanner surface. decodeImage extracts a VALUE; submitScannedCode routes
              it through the same debounce and callback every other scan path uses. */
           decodeImage, submitScannedCode, hasDecoder,
           /* test seams — the fallback plumbing, so a suite can prove the device matrix without a camera */
           _fallback: { loadZXing: _loadZXing, zxingDecode: _zxingDecode, state: () => ({ native: !!_detector, nativeUnusable: _nativeUnusable, zxingFailed: _zxingFailed }) } };
})();

window.PosBarcode = PosBarcode;
