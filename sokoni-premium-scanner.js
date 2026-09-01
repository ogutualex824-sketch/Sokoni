/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI PREMIUM SCANNER — one product authority, four ways in.
   ══════════════════════════════════════════════════════════════════════════════
   Physical wedge · live camera · uploaded image · manual entry
                            ↓
              PosBarcode.submitScannedCode(value)
                            ↓
              PosDB.products.getByBarcode(value)   ← the ONE authority
                            ↓
                     cart.addByProduct(product)

   THIS FILE DECODES; IT DOES NOT RESOLVE. It turns a camera frame, an uploaded photo
   or a typed string into a barcode VALUE and hands it to the existing scan callback.
   It never touches the product catalogue, never constructs a product, and never adds
   to the cart itself. That boundary is the whole design: a scanner that could put a
   product in a cart without going through getByBarcode would be a second, unpoliced
   product authority — and a premium feature is not a reason to acquire one.

   BARCODE RECOGNITION, NOT PRODUCT RECOGNITION. There is deliberately no vision model
   guessing what an item is. The camera reads a barcode; the catalogue decides what it
   means. Anything that "recognises the product" without a barcode would be inventing a
   product id, which is precisely what the resolution path exists to prevent.

   LAZY BY DESIGN. Nothing here is parsed to open a till. pos.html installs a shim and
   this file arrives only when the merchant opens Premium Scanner — it is part of the
   boot-payload work, not a new cost on it.

   HONEST ABOUT THE DECODER. Where BarcodeDetector is unavailable the camera and image
   paths say so and fall back to manual entry. They do not pretend to scan.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  var _open = false, _stream = null, _raf = null, _els = null;
  var _onCode = null;           /* the caller's scan callback — the resolution path */
  var _continuous = true;
  var _devices = [], _deviceIx = 0, _torchOn = false;

  function _bc () { return root.PosBarcode || null; }

  /* Every path funnels here. It does NOT resolve — it hands the value to the one
     canonical entry point, which carries the shared duplicate-scan debounce. */
  function _submit (code, source) {
    var bc = _bc();
    if (!bc || typeof bc.submitScannedCode !== 'function') {
      _say('Scanner unavailable — barcode module not loaded.', 'err');
      return false;
    }
    var accepted = bc.submitScannedCode(code);
    if (accepted) {
      _say('Scanned ' + code + (source ? ' · ' + source : ''), 'ok');
      if (!_continuous) close();
    }
    return accepted;
  }

  function _say (msg, kind) {
    if (!_els || !_els.status) return;
    _els.status.textContent = msg;
    _els.status.className = 'sps-status sps-' + (kind || 'info');
  }

  /* ── camera ──────────────────────────────────────────────────────────────── */

  async function _listCameras () {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
      var all = await navigator.mediaDevices.enumerateDevices();
      return all.filter(function (d) { return d.kind === 'videoinput'; });
    } catch (_) { return []; }
  }

  async function _startCamera () {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      _say('This device has no camera access. Use image upload or type the code.', 'err');
      return false;
    }
    try {
      var constraints = { video: { facingMode: 'environment' } };
      if (_devices.length && _devices[_deviceIx] && _devices[_deviceIx].deviceId) {
        constraints = { video: { deviceId: { exact: _devices[_deviceIx].deviceId } } };
      }
      _stream = await navigator.mediaDevices.getUserMedia(constraints);
      _els.video.srcObject = _stream;
      await _els.video.play().catch(function () {});
      _say('Point the camera at a barcode.', 'info');
      _loop();
      return true;
    } catch (err) {
      /* A refused permission is a decision, not a fault — say which it was. */
      var denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      _say(denied
        ? 'Camera permission was declined. Use image upload or type the code.'
        : 'Camera unavailable (' + ((err && err.name) || 'unknown') + '). Use image upload.', 'err');
      return false;
    }
  }

  function _stopCamera () {
    if (_raf) { cancelAnimationFrame(_raf); _raf = null; }
    try { _stream && _stream.getTracks().forEach(function (t) { t.stop(); }); } catch (_) {}
    _stream = null;
    _torchOn = false;
  }

  /* Live frames go through the SAME detector the image path uses — decodeImage accepts
     any ImageBitmapSource, and a <video> element is one. One decoder, three inputs. */
  function _loop () {
    var bc = _bc();
    if (!_open || !bc || typeof bc.decodeImage !== 'function') return;
    var busy = false;
    var tick = async function () {
      if (!_open) return;
      if (!busy && _els.video && _els.video.readyState >= 2) {
        busy = true;
        try {
          var r = await bc.decodeImage(_els.video);
          if (r && r.ok) _submit(r.code, 'camera');
        } catch (_) { /* a bad frame is not an error worth surfacing */ }
        busy = false;
      }
      _raf = requestAnimationFrame(tick);
    };
    _raf = requestAnimationFrame(tick);
  }

  async function _toggleTorch () {
    try {
      var track = _stream && _stream.getVideoTracks && _stream.getVideoTracks()[0];
      if (!track) return _say('No camera running.', 'err');
      var caps = track.getCapabilities ? track.getCapabilities() : {};
      if (!caps || !('torch' in caps)) return _say('This camera has no flashlight.', 'err');
      _torchOn = !_torchOn;
      await track.applyConstraints({ advanced: [{ torch: _torchOn }] });
      _say(_torchOn ? 'Flashlight on.' : 'Flashlight off.', 'info');
    } catch (_) { _say('Could not change the flashlight.', 'err'); }
  }

  async function _switchCamera () {
    if (_devices.length < 2) return _say('Only one camera on this device.', 'err');
    _deviceIx = (_deviceIx + 1) % _devices.length;
    _stopCamera();
    await _startCamera();
  }

  /* ── image upload ────────────────────────────────────────────────────────── */

  async function _onFile (file) {
    var bc = _bc();
    if (!bc || typeof bc.decodeImage !== 'function') return _say('Scanner unavailable.', 'err');
    if (!file) return;
    _say('Reading image…', 'info');
    var r = await bc.decodeImage(file);
    if (r && r.ok) { _submit(r.code, 'image'); return; }

    /* Name the actual reason. "Scan failed" tells a merchant nothing about whether to
       retake the photo, get closer, or type the code. */
    var why = {
      no_decoder:       'This device cannot read barcodes from images. Type the code instead.',
      unreadable_image: 'That file could not be opened as an image.',
      no_barcode_found: 'No barcode found in that image — try a closer, sharper photo.',
      malformed_result: 'The barcode could not be read cleanly. Try again.',
      decode_failed:    'Reading the image failed. Try again.',
      no_image:         'No image was selected.',
    }[(r && r.reason) || ''] || 'Could not read that image.';
    _say(why, 'err');
  }

  /* ── UI ──────────────────────────────────────────────────────────────────── */

  function _css () {
    if (document.getElementById('sps-css')) return;
    var s = document.createElement('style');
    s.id = 'sps-css';
    s.textContent =
      '.sps-wrap{position:fixed;inset:0;z-index:100000;background:#0b0d10;color:#e9eef5;' +
        'display:flex;flex-direction:column;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}' +
      '.sps-top{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;' +
        'border-bottom:1px solid rgba(255,255,255,.09)}' +
      '.sps-top b{font-size:15px}' +
      '.sps-x{background:none;border:0;color:#e9eef5;font-size:24px;line-height:1;cursor:pointer;padding:0 6px}' +
      '.sps-view{position:relative;flex:1;background:#000;overflow:hidden}' +
      '.sps-view video{width:100%;height:100%;object-fit:cover}' +
      '.sps-retic{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:72%;height:34%;' +
        'border:2px solid rgba(113,255,0,.85);border-radius:14px;box-shadow:0 0 0 100vmax rgba(0,0,0,.35)}' +
      '.sps-status{padding:10px 14px;font-size:13px;min-height:38px}' +
      '.sps-ok{color:#b6f0cf}.sps-err{color:#ffb4b4}.sps-info{color:rgba(233,238,245,.7)}' +
      '.sps-bar{display:flex;gap:8px;flex-wrap:wrap;padding:12px 14px;border-top:1px solid rgba(255,255,255,.09)}' +
      '.sps-btn{flex:1 1 auto;min-width:120px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);' +
        'color:#e9eef5;border-radius:10px;padding:11px 12px;font-weight:700;font-size:13px;cursor:pointer}' +
      '.sps-btn.primary{background:#71ff00;color:#0b0d10;border-color:#71ff00}' +
      '.sps-manual{display:flex;gap:8px;padding:0 14px 14px}' +
      '.sps-manual input{flex:1;background:#0e1116;border:1px solid rgba(255,255,255,.12);color:#e9eef5;' +
        'border-radius:10px;padding:11px 12px;font-size:15px}';
    document.head.appendChild(s);
  }

  function _build () {
    _css();
    var w = document.createElement('div');
    w.className = 'sps-wrap';
    w.innerHTML =
      '<div class="sps-top"><b>Premium Scanner</b>' +
        '<button class="sps-x" data-sps="close" aria-label="Close">×</button></div>' +
      '<div class="sps-view"><video playsinline muted></video><div class="sps-retic"></div></div>' +
      '<div class="sps-status sps-info">Starting camera…</div>' +
      '<div class="sps-bar">' +
        '<button class="sps-btn primary" data-sps="upload">🖼 Scan an image</button>' +
        '<button class="sps-btn" data-sps="torch">🔦 Flashlight</button>' +
        '<button class="sps-btn" data-sps="flip">🔄 Switch camera</button>' +
        '<button class="sps-btn" data-sps="mode">♾ Continuous: on</button>' +
      '</div>' +
      '<div class="sps-manual">' +
        '<input type="text" inputmode="numeric" placeholder="Or type the barcode" data-sps-input>' +
        '<button class="sps-btn" data-sps="manual" style="flex:0 0 auto">Add</button>' +
      '</div>' +
      '<input type="file" accept="image/*" hidden data-sps-file>';
    document.body.appendChild(w);

    _els = {
      wrap: w,
      video: w.querySelector('video'),
      status: w.querySelector('.sps-status'),
      input: w.querySelector('[data-sps-input]'),
      file: w.querySelector('[data-sps-file]'),
      mode: w.querySelector('[data-sps="mode"]'),
    };

    w.addEventListener('click', function (e) {
      var b = e.target.closest('[data-sps]');
      if (!b) return;
      var a = b.dataset.sps;
      if (a === 'close')  return close();
      if (a === 'upload') return _els.file.click();
      if (a === 'torch')  return _toggleTorch();
      if (a === 'flip')   return _switchCamera();
      if (a === 'manual') return _manual();
      if (a === 'mode') {
        _continuous = !_continuous;
        _els.mode.textContent = '♾ Continuous: ' + (_continuous ? 'on' : 'off');
      }
    });
    _els.file.addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      _onFile(f);
      e.target.value = '';        /* same file twice must re-fire */
    });
    _els.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); _manual(); }
    });
  }

  function _manual () {
    var v = (_els.input.value || '').trim();
    if (!v) return _say('Type a barcode first.', 'err');
    if (_submit(v, 'typed')) _els.input.value = '';
  }

  /* ── public ──────────────────────────────────────────────────────────────── */

  /* open(onCode) — onCode is the CALLER'S resolution path. This module does not choose
     it, does not default it to something of its own, and does nothing with a code
     beyond handing it over. */
  async function open (onCode) {
    if (_open) return true;
    if (typeof onCode === 'function') _onCode = onCode;

    var bc = _bc();
    if (bc && typeof bc.setCallback === 'function' && _onCode) bc.setCallback(_onCode);

    _open = true;
    _build();

    if (bc && typeof bc.hasDecoder === 'function' && !bc.hasDecoder()) {
      _say('This device cannot decode barcodes. Type the code, or use a hardware scanner.', 'err');
      return true;                /* still usable: manual entry works */
    }
    _devices = await _listCameras();
    await _startCamera();
    return true;
  }

  function close () {
    _open = false;
    _stopCamera();
    try { _els && _els.wrap && _els.wrap.remove(); } catch (_) {}
    _els = null;
  }

  var api = { open: open, close: close, isOpen: function () { return _open; },
              decodeFile: _onFile, submit: _submit };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PosPremiumScanner = api;
}(typeof window !== 'undefined' ? window : this));
