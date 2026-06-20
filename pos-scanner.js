/* SOKONI SmartPOS — Universal AI Scanner v1.0
   Phone-first barcode, QR, IMEI, serial, OCR, invoice,
   receipt, and product image recognition.
   All detection runs on-device; AI fallback calls Cloud Function. */

'use strict';

const PosScanner = (() => {

  /* ── State ─────────────────────────────────────────────────── */
  let _stream     = null;
  let _video      = null;
  let _canvas     = null;
  let _ctx        = null;
  let _detector   = null;
  let _loopId     = null;
  let _mode       = 'auto';
  let _onResult   = null;
  let _lastCode   = '';
  let _lastCodeTs = 0;
  let _overlay    = null;
  let _resultEl   = null;

  /* ── Scan modes ────────────────────────────────────────────── */
  const MODES = {
    auto:    { label: 'Scan Anything',      icon: '📷', hint: 'Point camera at barcode, QR, IMEI, or product' },
    barcode: { label: 'Barcode / QR',       icon: '▦',  hint: 'Point at barcode or QR code' },
    serial:  { label: 'Serial / IMEI',      icon: '🔢', hint: 'Point at IMEI sticker or serial number' },
    invoice: { label: 'Invoice / Receipt',  icon: '🧾', hint: 'Frame the full invoice or receipt' },
    product: { label: 'Product Image',      icon: '🖼️', hint: 'Point at product packaging' },
    ocr:     { label: 'Read Text',          icon: '🔤', hint: 'Point at any printed text' },
  };

  /* ── Luhn algorithm for IMEI validation ────────────────────── */
  function _luhn(digits) {
    let sum = 0;
    let alt = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = parseInt(digits[i], 10);
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  /* ── Pattern detectors ─────────────────────────────────────── */
  function _detectIMEI(text) {
    const matches = text.match(/\b(\d{15})\b/g) || [];
    return matches.find(m => _luhn(m)) || null;
  }

  function _detectSerial(text) {
    /* S/N: XXXXX format, or standalone alphanumeric 6-20 chars */
    const snMatch = text.match(/(?:S\/N|SN|Serial\s*(?:No\.?|Number)?)[:\s]*([A-Z0-9]{6,20})/i);
    if (snMatch) return snMatch[1];
    const standalone = text.match(/\b([A-Z]{2,4}[0-9]{4,12}|[0-9]{4,6}[A-Z]{2,4}[0-9]{4,8})\b/);
    return standalone ? standalone[1] : null;
  }

  function _detectURL(text) {
    return /^https?:\/\//.test(text.trim()) ? text.trim() : null;
  }

  function _classifyText(text) {
    const clean = text.trim();
    const imei  = _detectIMEI(clean);
    if (imei) return { type: 'imei', value: imei };
    const serial = _detectSerial(clean);
    if (serial && !/^\d+$/.test(serial)) return { type: 'serial', value: serial };
    const url = _detectURL(clean);
    if (url) return { type: 'qr_url', value: url };
    if (/^\d{8,13}$/.test(clean)) return { type: 'barcode', value: clean };
    if (clean.length > 10) return { type: 'text', value: clean };
    return null;
  }

  /* ── BarcodeDetector API ───────────────────────────────────── */
  async function _initBarcodeDetector() {
    if (_detector) return _detector;
    if (!('BarcodeDetector' in window)) return null;
    try {
      _detector = new BarcodeDetector({
        formats: ['ean_13', 'ean_8', 'code_128', 'code_39', 'qr_code', 'data_matrix', 'itf', 'upc_a', 'upc_e'],
      });
      return _detector;
    } catch (e) {
      return null;
    }
  }

  /* ── OCR via Tesseract.js (lazy load) ──────────────────────── */
  let _tesseractWorker = null;

  async function _loadOCR() {
    if (_tesseractWorker) return _tesseractWorker;
    if (!window.Tesseract) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
        s.onload = res; s.onerror = () => rej(new Error('Tesseract failed to load'));
        document.head.appendChild(s);
      });
    }
    _tesseractWorker = await Tesseract.createWorker('eng');
    return _tesseractWorker;
  }

  async function _runOCR(imageData) {
    const worker = await _loadOCR();
    const { data } = await worker.recognize(imageData);
    return data.text.trim();
  }

  /* ── Cloud Function for product image recognition ──────────── */
  async function _recognizeProduct(dataUrl) {
    if (!navigator.onLine) throw new Error('No internet. AI image recognition requires connection.');
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    const { getFunctions, httpsCallable } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js');
    const fns  = getFunctions(window._firebaseApp);
    const call = httpsCallable(fns, 'posExtractProductsFromImage');
    const res  = await call({ imageBase64: base64 });
    return res.data;
  }

  /* ── Database lookup after scan ────────────────────────────── */
  async function _lookupBarcode(barcode) {
    return PosDB.products.getByBarcode(barcode);
  }

  async function _lookupSerial(serial) {
    if (window.PosSerial) return PosSerial.getBySerial(serial);
    return null;
  }

  /* ── Build result object ────────────────────────────────────── */
  async function _buildResult(type, value, extra = {}) {
    let product    = null;
    let serialRec  = null;
    let warranty   = null;

    if (type === 'barcode') {
      product = await _lookupBarcode(value);
    }
    if (type === 'imei' || type === 'serial') {
      serialRec = await _lookupSerial(value);
      if (serialRec && window.PosSerial) {
        warranty = await PosSerial.checkWarranty(value);
      }
    }

    const actions = _buildActions(type, value, product, warranty);

    return { type, value, product, serialRec, warranty, actions, ...extra };
  }

  /* ── Build contextual actions ──────────────────────────────── */
  function _buildActions(type, value, product, warranty) {
    const acts = [];

    if (type === 'barcode' && product) {
      acts.push({ id: 'add_cart',    icon: '🛒', label: 'Add to Cart',   color: 'var(--green)', fn: () => _act_addCart(product) });
      acts.push({ id: 'stock_in',    icon: '📦', label: 'Add Stock',     color: '#60a5fa',      fn: () => _act_stockIn(product) });
      acts.push({ id: 'print_label', icon: '🏷️', label: 'Print Label',   color: '#f59e0b',      fn: () => _act_printLabel(product) });
      acts.push({ id: 'view',        icon: '👁️', label: 'View / Edit',   color: 'var(--txt2)',  fn: () => _act_view(product) });
    } else if (type === 'barcode' && !product) {
      acts.push({ id: 'create',      icon: '➕', label: 'Create Product', color: 'var(--green)', fn: () => _act_create(value) });
      acts.push({ id: 'search',      icon: '🔍', label: 'Search Inventory', color: '#60a5fa',   fn: () => _act_search(value) });
    }
    if (type === 'qr_url') {
      acts.push({ id: 'open_url',    icon: '🔗', label: 'Open Link',     color: '#60a5fa',      fn: () => window.open(value, '_blank') });
    }
    if (type === 'imei' || type === 'serial') {
      if (warranty?.valid) {
        acts.push({ id: 'warranty',  icon: '✅', label: 'Valid Warranty',  color: 'var(--green)', fn: () => _act_warranty(warranty) });
      } else if (warranty?.expired) {
        acts.push({ id: 'warranty',  icon: '⚠️', label: 'Warranty Expired', color: '#f59e0b',  fn: () => _act_warranty(warranty) });
      } else {
        acts.push({ id: 'register',  icon: '📋', label: 'Register Serial', color: 'var(--green)', fn: () => _act_registerSerial(value, type) });
      }
      if (window.PosRepair) {
        acts.push({ id: 'repair',    icon: '🔧', label: 'Log Repair Job', color: '#f59e0b',     fn: () => _act_repair(value) });
      }
    }
    if (type === 'text' || type === 'invoice') {
      acts.push({ id: 'ai_import',   icon: '🤖', label: 'AI Import Products', color: 'var(--green)', fn: () => _act_aiImport(value) });
      acts.push({ id: 'copy',        icon: '📋', label: 'Copy Text',       color: 'var(--txt2)',    fn: () => navigator.clipboard?.writeText(value) });
    }
    if (type === 'product_ai') {
      acts.push({ id: 'create_from', icon: '➕', label: 'Create Product',  color: 'var(--green)', fn: () => _act_createFromAI(value) });
    }
    if (type === 'invoice_ai') {
      acts.push({ id: 'import',      icon: '📥', label: 'Import All',      color: 'var(--green)', fn: () => _act_importInvoice(value) });
    }

    /* Always add: copy value */
    if (!['product_ai','invoice_ai'].includes(type)) {
      acts.push({ id: 'copy_raw', icon: '📋', label: 'Copy', color: 'var(--txt3)', fn: () => navigator.clipboard?.writeText(value) });
    }

    return acts;
  }

  /* ── Action handlers ────────────────────────────────────────── */
  function _act_addCart(product) {
    close();
    if (window.SPos) SPos.cart.addItem(product.id);
    if (window.PosMobile) PosMobile.showCartBadge();
  }

  function _act_stockIn(product) {
    close();
    if (window.PosMobile) PosMobile.openStockIn(product);
  }

  function _act_printLabel(product) {
    close();
    if (window.PosLabels) PosLabels.printProductLabels([product], 'standard');
    else if (window.PosPrinter) PosPrinter.printLabel({ barcode: product.barcode, name: product.name, price: product.price });
  }

  function _act_view(product) {
    close();
    if (window.PosMobile) PosMobile.openProductEdit(product);
    else if (window.SPos) { SPos.ui.switchTab('inventory'); }
  }

  function _act_create(barcode) {
    close();
    if (window.PosMobile) PosMobile.openCreateProduct({ barcode });
  }

  function _act_search(query) {
    close();
    if (window.SPos) { SPos.ui.switchTab('inventory'); SPos.inv.searchProducts(query); }
  }

  function _act_warranty(warranty) {
    close();
    if (window.PosMobile) PosMobile.showWarranty(warranty);
  }

  function _act_registerSerial(value, type) {
    close();
    if (window.PosMobile) PosMobile.openRegisterSerial(value, type);
  }

  function _act_repair(imei) {
    close();
    if (window.PosRepair) {
      SPos?.ui?.switchTab('repair');
      setTimeout(() => PosRepair._openNewJob(), 300);
    }
  }

  function _act_aiImport(text) {
    close();
    if (window.PosAI) {
      const blob = new Blob([text], { type: 'text/plain' });
      const file = new File([blob], 'scanned.txt', { type: 'text/plain' });
      if (window.SPos) { SPos.modal.open('ai-import-modal'); SPos.bos.handleFileSelect(file); }
    }
  }

  function _act_createFromAI(products) {
    close();
    if (window.PosAI) PosAI._showPreview(products);
    SPos?.modal?.open('ai-import-modal');
  }

  function _act_importInvoice(products) {
    close();
    if (window.PosAI && Array.isArray(products)) {
      PosAI._showPreview(products);
      SPos?.modal?.open('ai-import-modal');
    }
  }

  /* ── Main capture loop ─────────────────────────────────────── */
  async function _captureFrame() {
    if (!_video || !_canvas || !_ctx || _video.readyState < 2) return;
    _canvas.width  = _video.videoWidth;
    _canvas.height = _video.videoHeight;
    _ctx.drawImage(_video, 0, 0);
  }

  async function _loop() {
    if (!_stream || !_loopId) return;

    try {
      await _captureFrame();

      /* BarcodeDetector (fastest — runs every frame) */
      if (_detector && _canvas.width > 0) {
        const codes = await _detector.detect(_canvas);
        if (codes.length > 0) {
          const code = codes[0];
          const val  = code.rawValue;
          const now  = Date.now();
          /* Debounce: same code within 2s ignored */
          if (val === _lastCode && now - _lastCodeTs < 2000) {
            _scheduleLoop(); return;
          }
          _lastCode   = val;
          _lastCodeTs = now;

          const type = code.format === 'qr_code' ? 'qr_code' : 'barcode';
          _playBeep();
          const classified = type === 'qr_code' ? (_detectURL(val) ? { type:'qr_url', value: val } : { type:'barcode', value: val }) : { type:'barcode', value: val };
          const result = await _buildResult(classified.type, classified.value);
          _showResult(result);
          return;
        }
      }

      /* Mode-specific: only run slower OCR every 3s on manual tap or explicit modes */
      if (_mode === 'serial' || _mode === 'ocr') {
        /* Prompt user to tap capture button for OCR — don't run OCR in loop (too slow) */
      }
    } catch (e) {
      console.warn('[Scanner] Loop error:', e.message);
    }

    _scheduleLoop();
  }

  function _scheduleLoop() {
    _loopId = requestAnimationFrame(_loop);
  }

  /* ── Manual capture (tap to analyze) ──────────────────────── */
  async function capture() {
    await _captureFrame();
    if (!_canvas.width) return;
    const dataUrl = _canvas.toDataURL('image/jpeg', 0.85);

    _setStatus('Analyzing…', 'scanning');

    try {
      /* Try BarcodeDetector first */
      if (_detector) {
        const codes = await _detector.detect(_canvas);
        if (codes.length > 0) {
          const val  = codes[0].rawValue;
          const type = codes[0].format === 'qr_code'
            ? (_detectURL(val) ? 'qr_url' : 'barcode')
            : 'barcode';
          const result = await _buildResult(type, val);
          _playBeep();
          _showResult(result);
          return;
        }
      }

      /* Mode: invoice / product image → Cloud Function */
      if (_mode === 'invoice' || _mode === 'product') {
        _setStatus('Sending to AI…', 'scanning');
        try {
          const aiProducts = await _recognizeProduct(dataUrl);
          if (aiProducts?.length) {
            const type   = _mode === 'invoice' ? 'invoice_ai' : 'product_ai';
            const result = await _buildResult(type, aiProducts);
            _showResult(result);
            return;
          }
        } catch (e) {
          /* Fall through to OCR */
        }
      }

      /* OCR fallback */
      _setStatus('Reading text…', 'scanning');
      const text = await _runOCR(dataUrl);
      if (text && text.length > 2) {
        const classified = _classifyText(text);
        if (classified) {
          const result = await _buildResult(classified.type, classified.value, { rawText: text });
          _playBeep();
          _showResult(result);
          return;
        }
      }

      _setStatus('Nothing detected — try again', 'error');
      setTimeout(() => _setStatus(MODES[_mode]?.hint || 'Point camera and tap capture'), 2500);

    } catch (e) {
      _setStatus('Error: ' + e.message, 'error');
      setTimeout(() => _setStatus(MODES[_mode]?.hint || 'Ready'), 3000);
    }
  }

  /* ── UI helpers ─────────────────────────────────────────────── */
  function _setStatus(msg, cls) {
    const el = document.getElementById('scanner-status');
    if (el) { el.textContent = msg; el.className = 'scanner-status ' + (cls || ''); }
  }

  function _playBeep() {
    try {
      const ctx   = new AudioContext();
      const osc   = ctx.createOscillator();
      const gain  = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 1760;
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
      osc.start(); osc.stop(ctx.currentTime + 0.12);
    } catch (e) {}
  }

  /* ── Scanner UI ─────────────────────────────────────────────── */
  function _buildScannerUI() {
    /* Remove existing */
    document.getElementById('pos-scanner-overlay')?.remove();

    _overlay = document.createElement('div');
    _overlay.id        = 'pos-scanner-overlay';
    _overlay.className = 'scanner-overlay';
    _overlay.innerHTML = `
      <div class="scanner-topbar">
        <button class="scanner-close" onclick="PosScanner.close()">✕</button>
        <div class="scanner-mode-label" id="scanner-mode-label">${MODES[_mode]?.icon || '📷'} ${MODES[_mode]?.label || 'Scan'}</div>
        <button class="scanner-torch" id="scanner-torch" onclick="PosScanner.toggleTorch()" title="Flashlight">🔦</button>
      </div>

      <div class="scanner-viewfinder">
        <video id="scanner-cam-video" autoplay playsinline muted class="scanner-video"></video>
        <canvas id="scanner-cam-canvas" style="display:none"></canvas>
        <div class="scanner-crosshair">
          <div class="scan-corner tl"></div><div class="scan-corner tr"></div>
          <div class="scan-corner bl"></div><div class="scan-corner br"></div>
          <div class="scan-line"></div>
        </div>
        <div class="scanner-status" id="scanner-status">${MODES[_mode]?.hint || 'Point camera at target'}</div>
      </div>

      <div class="scanner-controls">
        <div class="scanner-modes">
          ${Object.entries(MODES).map(([k, v]) => `
            <button class="scanner-mode-btn ${k === _mode ? 'active' : ''}" onclick="PosScanner.setMode('${k}')">
              ${v.icon} <span>${v.label.split('/')[0].trim()}</span>
            </button>
          `).join('')}
        </div>
        <button class="scanner-capture-btn" onclick="PosScanner.capture()">
          <span class="scanner-shutter-icon">⬤</span>
        </button>
        <div style="font-size:11px;color:rgba(255,255,255,.4);text-align:center;margin-top:6px">
          Tap ⬤ to capture · Barcodes auto-detect
        </div>
      </div>

      <div class="scanner-result-sheet" id="scanner-result-sheet" style="display:none"></div>
    `;

    document.body.appendChild(_overlay);

    _video  = document.getElementById('scanner-cam-video');
    _canvas = document.getElementById('scanner-cam-canvas');
    _ctx    = _canvas.getContext('2d');
  }

  /* ── Result sheet UI ────────────────────────────────────────── */
  function _showResult(result) {
    /* Stop live loop while showing result */
    if (_loopId) { cancelAnimationFrame(_loopId); _loopId = null; }

    const sheet   = document.getElementById('scanner-result-sheet');
    if (!sheet) return;

    const icons = { barcode:'▦', qr_code:'▣', qr_url:'🔗', imei:'📱', serial:'🔢', text:'🔤', invoice:'🧾', invoice_ai:'🧾', product_ai:'🖼️' };
    const labels = { barcode:'Barcode', qr_code:'QR Code', qr_url:'QR Code', imei:'IMEI', serial:'Serial No.', text:'Text', invoice:'Invoice', invoice_ai:'Invoice AI', product_ai:'Product Image' };

    let productHTML = '';
    if (result.product) {
      const p = result.product;
      const stockClass = p.stock <= 0 ? 'out-of-stock' : p.stock <= (p.lowStockThreshold || 5) ? 'low-stock' : 'in-stock';
      productHTML = `
        <div class="scan-product-card">
          <div class="scan-product-name">${_esc(p.name)}</div>
          <div class="scan-product-meta">
            <span class="scan-price">KES ${(p.price || 0).toLocaleString()}</span>
            <span class="scan-stock ${stockClass}">${p.stock <= 0 ? 'Out of Stock' : p.stock + ' in stock'}</span>
          </div>
          ${p.category ? `<div class="scan-product-cat">${_esc(p.category)}</div>` : ''}
        </div>
      `;
    } else if (result.warranty) {
      const w = result.warranty;
      productHTML = `
        <div class="scan-product-card">
          <div class="scan-product-name">${_esc(result.serialRec?.productName || 'Product')}</div>
          <div class="scan-product-meta">
            <span class="scan-stock ${w.valid ? 'in-stock' : 'out-of-stock'}">${w.valid ? '✓ Warranty valid · ' + w.daysLeft + ' days left' : '✗ Warranty expired'}</span>
          </div>
          <div class="scan-product-cat">Customer: ${_esc(result.serialRec?.customerName || '—')}</div>
        </div>
      `;
    } else if (result.type === 'invoice_ai' && Array.isArray(result.value)) {
      productHTML = `<div class="scan-product-card"><div class="scan-product-name">${result.value.length} products found in invoice</div></div>`;
    } else if (result.type === 'product_ai' && Array.isArray(result.value)) {
      productHTML = `<div class="scan-product-card"><div class="scan-product-name">${result.value.length} products recognized</div></div>`;
    } else if (!result.product && result.type === 'barcode') {
      productHTML = `<div class="scan-product-card" style="border-color:rgba(245,158,11,.3)"><div class="scan-product-name" style="color:#f59e0b">Unknown barcode</div><div class="scan-product-meta"><span class="scan-product-cat">Not in your inventory</span></div></div>`;
    }

    sheet.innerHTML = `
      <div class="scan-result-handle"></div>
      <div class="scan-result-header">
        <span class="scan-type-badge">${icons[result.type] || '•'} ${labels[result.type] || result.type}</span>
        <span class="scan-value">${Array.isArray(result.value) ? result.value.length + ' items' : _esc(String(result.value).slice(0, 40))}</span>
      </div>
      ${productHTML}
      <div class="scan-actions">
        ${result.actions.map(a => `
          <button class="scan-action-btn" style="border-color:${a.color};color:${a.color}" onclick="PosScanner._exec('${a.id}')">
            <span class="scan-action-icon">${a.icon}</span>
            <span class="scan-action-label">${a.label}</span>
          </button>
        `).join('')}
        <button class="scan-action-btn scan-action-rescan" onclick="PosScanner.rescan()">
          <span class="scan-action-icon">📷</span>
          <span class="scan-action-label">Scan Again</span>
        </button>
      </div>
    `;

    sheet.style.display = 'block';
    sheet.classList.add('slide-up');
    _overlay._currentResult = result;

    /* Call external callback if set */
    if (_onResult) _onResult(result);
  }

  function _exec(actionId) {
    const result = _overlay?._currentResult;
    if (!result) return;
    const action = result.actions.find(a => a.id === actionId);
    if (action) action.fn();
  }

  /* ── Open / close ──────────────────────────────────────────── */
  async function open(mode = 'auto', onResult = null) {
    _mode     = MODES[mode] ? mode : 'auto';
    _onResult = onResult;

    _buildScannerUI();

    try {
      _stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode:  { ideal: 'environment' },
          width:       { ideal: 1920 },
          height:      { ideal: 1080 },
        },
        audio: false,
      });
    } catch (e) {
      if (e.name === 'NotAllowedError') {
        (window._skToast||alert)('Camera permission denied. Please allow camera access in your browser settings.');
      } else {
        (window._skToast||alert)('Camera error: ' + e.message);
      }
      _overlay?.remove();
      return;
    }

    _video.srcObject = _stream;
    await new Promise(res => { _video.onloadedmetadata = res; });
    _video.play();

    _detector = await _initBarcodeDetector();

    /* Start detection loop */
    _scheduleLoop();

    /* Prevent background scroll */
    document.body.style.overflow = 'hidden';
  }

  function close() {
    if (_loopId)  { cancelAnimationFrame(_loopId); _loopId = null; }
    if (_stream)  { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
    _overlay?.remove(); _overlay = null;
    _video = null; _canvas = null; _ctx = null;
    _onResult = null;
    document.body.style.overflow = '';
  }

  function rescan() {
    const sheet = document.getElementById('scanner-result-sheet');
    if (sheet) { sheet.style.display = 'none'; sheet.classList.remove('slide-up'); }
    _lastCode = ''; _lastCodeTs = 0;
    _setStatus(MODES[_mode]?.hint || 'Ready');
    _scheduleLoop();
  }

  function setMode(mode) {
    _mode = MODES[mode] ? mode : 'auto';
    const label = document.getElementById('scanner-mode-label');
    if (label) label.textContent = `${MODES[_mode]?.icon} ${MODES[_mode]?.label}`;
    _setStatus(MODES[_mode]?.hint || 'Ready');
    document.querySelectorAll('.scanner-mode-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.scanner-mode-btn[onclick*="${mode}"]`)?.classList.add('active');
    /* Close result sheet */
    const sheet = document.getElementById('scanner-result-sheet');
    if (sheet) sheet.style.display = 'none';
    rescan();
  }

  async function toggleTorch() {
    const track = _stream?.getVideoTracks()?.[0];
    if (!track) return;
    const caps = track.getCapabilities?.();
    if (!caps?.torch) { (window._skToast||alert)('Flashlight not available on this device.'); return; }
    const settings = track.getSettings();
    await track.applyConstraints({ advanced: [{ torch: !settings.torch }] });
    const btn = document.getElementById('scanner-torch');
    if (btn) btn.style.color = !settings.torch ? '#ffd700' : 'rgba(255,255,255,.7)';
  }

  /* ── Static: scan a file (image/PDF) ──────────────────────── */
  async function scanFile(file) {
    if (!file) return null;
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });

    /* Try BarcodeDetector on image */
    const det = await _initBarcodeDetector();
    if (det && file.type.startsWith('image/')) {
      const img = new Image();
      img.src = dataUrl;
      await new Promise(res => { img.onload = res; });
      const cnv = document.createElement('canvas');
      cnv.width = img.width; cnv.height = img.height;
      cnv.getContext('2d').drawImage(img, 0, 0);
      const codes = await det.detect(cnv).catch(() => []);
      if (codes.length > 0) {
        return { type: 'barcode', value: codes[0].rawValue };
      }
    }

    /* OCR */
    const text = await _runOCR(dataUrl);
    if (text) {
      const classified = _classifyText(text);
      if (classified) return classified;
      return { type: 'text', value: text };
    }
    return null;
  }

  function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  return { open, close, capture, rescan, setMode, toggleTorch, scanFile, _exec, _buildResult, MODES };
})();

window.PosScanner = PosScanner;

