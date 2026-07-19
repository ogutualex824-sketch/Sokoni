/* ============================================================
   SOKONI BARCODE  —  POS barcode scanning + product lookup
   Strategy:
     1. Native BarcodeDetector API  (Chrome 83+, Safari 17+)
     2. ZXing WASM fallback         (all modern browsers)
     3. Manual entry UI             (always available)
   Formats: EAN-13, EAN-8, UPC-A, Code-128, Code-39, QR Code
============================================================ */
(function (global) {
  'use strict';

  const ZXING_CDN = 'https://unpkg.com/@zxing/library@0.20.0/umd/index.min.js';

  let _zxingReady = false;
  let _zxingP     = null;
  let _reader     = null; /* ZXing BrowserBarcodeReader instance */

  /* ─── Capability detection ─── */
  const _hasNative = () => typeof BarcodeDetector !== 'undefined';

  function _loadZXing() {
    if (_zxingReady) return Promise.resolve();
    if (_zxingP)     return _zxingP;
    _zxingP = new Promise((res, rej) => {
      const s    = document.createElement('script');
      s.src      = ZXING_CDN;
      s.onload   = () => { _zxingReady = true; res(); };
      s.onerror  = () => rej(new Error('[SokoniBarcode] ZXing load failed'));
      document.head.appendChild(s);
    });
    return _zxingP;
  }

  /* ─── Native BarcodeDetector scan (single frame) ─── */
  async function _nativeScan(imageOrVideo) {
    const bd = new BarcodeDetector({
      formats: ['ean_13','ean_8','upc_a','upc_e','code_128','code_39','qr_code','data_matrix'],
    });
    const codes = await bd.detect(imageOrVideo);
    return codes.length ? codes[0].rawValue : null;
  }

  /* ─── Native BarcodeDetector stream scanner ─── */
  async function _nativeStreamScan(videoEl, onDetect) {
    const bd = new BarcodeDetector({
      formats: ['ean_13','ean_8','upc_a','upc_e','code_128','code_39','qr_code'],
    });
    let active = true;
    const loop = async () => {
      if (!active || videoEl.readyState < 2) { if (active) requestAnimationFrame(loop); return; }
      try {
        const codes = await bd.detect(videoEl);
        if (codes.length) { onDetect(codes[0].rawValue, codes[0].format); return; }
      } catch (_) {}
      if (active) requestAnimationFrame(loop);
    };
    loop();
    return () => { active = false; };
  }

  /* ─── ZXing stream scanner ─── */
  async function _zxingScan(videoEl, onDetect) {
    await _loadZXing();
    if (!_reader) _reader = new ZXing.BrowserMultiFormatReader();
    _reader.decodeFromVideoElement(videoEl, (result, err) => {
      if (result) onDetect(result.getText(), result.getBarcodeFormat()?.toString() || 'unknown');
    });
    return () => { try { _reader.reset(); } catch (_) {} };
  }

  /* ─── Start camera stream ─── */
  async function _startCamera(videoEl) {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    videoEl.srcObject = stream;
    await videoEl.play();
    return stream;
  }

  /* ─── Firestore product lookup by barcode ─── */
  async function _lookupProduct(barcode) {
    try {
      const { db }         = await import('./firebase.js');
      const { collection, query, where, getDocs, limit } = await import(
        'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'
      );
      const snap = await getDocs(
        query(collection(db, 'products'), where('barcode', '==', barcode), limit(1))
      );
      if (!snap.empty) return { _id: snap.docs[0].id, ...snap.docs[0].data() };
    } catch (err) {
      console.warn('[SokoniBarcode] Firestore lookup failed', err);
    }
    return null;
  }

  /* ─── Public API ─── */
  const SokoniBarcode = {

    /* Scan from a static image/canvas and return first barcode value */
    async scanImage(imageOrCanvas) {
      if (_hasNative()) return _nativeScan(imageOrCanvas);
      await _loadZXing();
      const reader = new ZXing.BrowserMultiFormatReader();
      const result = await reader.decodeFromImageElement(imageOrCanvas).catch(() => null);
      return result ? result.getText() : null;
    },

    /* Open full-screen camera scanner modal, calls onScan(value, format) */
    async openScanner({ onScan, title = 'Scan Barcode or QR Code', onClose } = {}) {
      document.getElementById('_sbc_modal')?.remove();

      const overlay = document.createElement('div');
      overlay.id    = '_sbc_modal';
      overlay.setAttribute('role','dialog');
      overlay.style.cssText = [
        'position:fixed;inset:0;background:#000;z-index:var(--sk-z-sheet,100010)',
        'display:flex;flex-direction:column;align-items:center',
      ].join(';');

      overlay.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;
                    width:100%;max-width:500px;padding:16px 20px;flex-shrink:0;">
          <span style="font-size:15px;font-weight:800;color:white;">${title}</span>
          <button id="_sbc_close"
            style="background:rgba(255,255,255,.1);border:none;color:white;width:36px;height:36px;
                   border-radius:50%;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;">×</button>
        </div>
        <div style="position:relative;width:100%;max-width:500px;flex:1;overflow:hidden;background:#000;">
          <video id="_sbc_video" autoplay playsinline muted
            style="width:100%;height:100%;object-fit:cover;"></video>
          <!-- Scanning frame overlay -->
          <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;">
            <div style="width:260px;height:180px;position:relative;">
              <div style="position:absolute;inset:0;border:2px solid rgba(113,255,0,.7);border-radius:12px;"></div>
              <div style="position:absolute;top:0;left:0;width:28px;height:28px;border-top:3px solid #71ff00;border-left:3px solid #71ff00;border-radius:4px 0 0 0;"></div>
              <div style="position:absolute;top:0;right:0;width:28px;height:28px;border-top:3px solid #71ff00;border-right:3px solid #71ff00;border-radius:0 4px 0 0;"></div>
              <div style="position:absolute;bottom:0;left:0;width:28px;height:28px;border-bottom:3px solid #71ff00;border-left:3px solid #71ff00;border-radius:0 0 0 4px;"></div>
              <div style="position:absolute;bottom:0;right:0;width:28px;height:28px;border-bottom:3px solid #71ff00;border-right:3px solid #71ff00;border-radius:0 0 4px 0;"></div>
              <!-- Scan line animation -->
              <div id="_sbc_scanline"
                style="position:absolute;left:4px;right:4px;height:2px;background:linear-gradient(90deg,transparent,#71ff00,transparent);
                       animation:_sbcline 1.8s ease-in-out infinite;top:50%;"></div>
            </div>
          </div>
          <div id="_sbc_status"
            style="position:absolute;bottom:20px;left:0;right:0;text-align:center;font-size:13px;
                   color:rgba(255,255,255,.6);font-weight:600;">Initializing camera…</div>
        </div>
        <!-- Manual entry -->
        <div style="width:100%;max-width:500px;padding:16px 20px;flex-shrink:0;background:#0a0a12;">
          <div style="display:flex;gap:8px;">
            <input id="_sbc_manual" type="text" placeholder="Type barcode manually…"
              style="flex:1;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);
                     border-radius:12px;padding:12px 14px;color:white;font-size:16px;font-family:inherit;outline:none;">
            <button id="_sbc_manual_btn"
              style="padding:12px 18px;background:rgba(113,255,0,.15);border:1px solid rgba(113,255,0,.3);
                     border-radius:12px;color:#71ff00;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;white-space:nowrap;">
              Look Up
            </button>
          </div>
        </div>
        <style>
          @keyframes _sbcline { 0%,100%{top:10%} 50%{top:85%} }
        </style>`;

      document.body.appendChild(overlay);

      const videoEl   = document.getElementById('_sbc_video');
      const statusEl  = document.getElementById('_sbc_status');
      let stream      = null;
      let stopScan    = null;
      let resolved    = false;

      function _finish(value, format) {
        if (resolved) return;
        resolved = true;
        try { stopScan?.(); } catch (_) {}
        try { stream?.getTracks().forEach(t => t.stop()); } catch (_) {}
        overlay.remove();
        if (value) onScan?.(value, format || 'unknown');
      }

      document.getElementById('_sbc_close').onclick = () => { _finish(null); onClose?.(); };

      document.getElementById('_sbc_manual_btn').onclick = () => {
        const v = document.getElementById('_sbc_manual').value.trim();
        if (v) _finish(v, 'manual');
      };
      document.getElementById('_sbc_manual').addEventListener('keydown', e => {
        if (e.key === 'Enter') { const v = e.target.value.trim(); if (v) _finish(v, 'manual'); }
      });

      // Start camera
      try {
        stream     = await _startCamera(videoEl);
        statusEl.textContent = 'Point camera at barcode or QR code';
        stopScan   = _hasNative()
          ? await _nativeStreamScan(videoEl, (val, fmt) => _finish(val, fmt))
          : await _zxingScan(videoEl, (val, fmt) => _finish(val, fmt));
      } catch (err) {
        statusEl.textContent = 'Camera unavailable — use manual entry';
        console.warn('[SokoniBarcode] camera error', err);
      }
    },

    /* Open scanner specifically for POS product lookup */
    async openPOSScan({ onProduct, onNotFound } = {}) {
      await this.openScanner({
        title: 'Scan Product Barcode',
        onScan: async (barcode, format) => {
          const product = await _lookupProduct(barcode);
          if (product) {
            onProduct?.(product, barcode);
          } else {
            onNotFound?.(barcode, format);
          }
        },
      });
    },

    /* Look up product by barcode string (no camera) */
    lookupProduct: _lookupProduct,

    /* Check if native BarcodeDetector is supported */
    get hasNativeScanner() { return _hasNative(); },
  };

  global.SokoniBarcode = SokoniBarcode;
})(window);
