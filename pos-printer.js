/* SOKONI SmartPOS — Printer Support v1.0
   ESC/POS over Web Bluetooth, WebUSB, Network (proxy), and Browser fallback.
   Supports 58mm (32 cols) and 80mm (42 cols) thermal printers. */

const PosPrinter = (function () {
  'use strict';

  let _conn = null;
  let _type = null;   // 'bluetooth' | 'usb' | 'network' | 'browser'
  let _cols = 32;     // paper width in chars

  /* ── ESC/POS constants ───────────────────────────────────────── */
  const ESC = 0x1b, GS = 0x1d, LF = 0x0a;

  const C = {
    INIT:        [ESC, 0x40],
    L:           [ESC, 0x61, 0x00],   // align left
    CENTER:      [ESC, 0x61, 0x01],   // align center
    R:           [ESC, 0x61, 0x02],   // align right
    BOLD_ON:     [ESC, 0x45, 0x01],
    BOLD_OFF:    [ESC, 0x45, 0x00],
    UL_ON:       [ESC, 0x2d, 0x01],
    UL_OFF:      [ESC, 0x2d, 0x00],
    NORMAL:      [GS,  0x21, 0x00],
    DH:          [GS,  0x21, 0x01],   // double height
    DW:          [GS,  0x21, 0x10],   // double width
    DOUBLE:      [GS,  0x21, 0x11],   // double height+width
    CUT:         [GS,  0x56, 0x42, 0x05],
    DRAWER:      [ESC, 0x70, 0x00, 0x19, 0xfa],
    FEED:   n => [ESC, 0x64, n & 0xff],
  };

  /* ── Buffer builder ──────────────────────────────────────────── */
  function _buf() {
    const b = [];
    const o = {
      cmd:  (...cmds) => { cmds.flat().forEach(c => b.push(c)); return o; },
      str:  s => { for (let i = 0; i < s.length; i++) b.push(s.charCodeAt(i)); b.push(LF); return o; },
      raw:  s => { for (let i = 0; i < s.length; i++) b.push(s.charCodeAt(i)); return o; },
      bytes: () => new Uint8Array(b),
    };
    return o;
  }

  /* ── Text helpers ────────────────────────────────────────────── */
  function _pad(s, len) {
    s = String(s);
    if (s.length > len) return s.slice(0, len);
    return s + ' '.repeat(len - s.length);
  }
  function _cols2(left, right, w) {
    right = String(right);
    const max = w - right.length - 1;
    left = String(left).slice(0, max);
    return left + ' '.repeat(Math.max(1, w - left.length - right.length)) + right;
  }
  function _divider(w, ch = '-') { return ch.repeat(w); }
  function _center(s, w) {
    const pad = Math.max(0, Math.floor((w - s.length) / 2));
    return ' '.repeat(pad) + s;
  }

  /* ── Build ESC/POS receipt buffer ────────────────────────────── */
  function buildReceipt(d) {
    const w  = d.paperWidth || _cols;
    const hr = _divider(w);
    const b  = _buf().cmd(...C.INIT);

    // ── Business header
    b.cmd(...C.CENTER, ...C.BOLD_ON, ...C.DOUBLE);
    b.str((d.businessName || 'SOKONI POS').slice(0, Math.floor(w / 2)));
    b.cmd(...C.NORMAL, ...C.BOLD_OFF);
    if (d.businessAddress) b.str(_center(d.businessAddress, w));
    if (d.businessPhone)   b.str(_center('Tel: ' + d.businessPhone, w));
    if (d.businessPin)     b.str(_center('PIN: ' + d.businessPin, w));

    // ── Receipt info
    b.cmd(...C.L);
    b.str(hr);
    b.str('Receipt  : ' + (d.receiptNo || '---'));
    b.str('Date     : ' + (d.date || new Date().toLocaleString('en-KE')));
    b.str('Cashier  : ' + (d.cashierName || 'N/A'));
    if (d.customerName) b.str('Customer : ' + d.customerName);
    b.str(hr);

    // ── Items header
    b.cmd(...C.BOLD_ON);
    b.str(_cols2(_pad('DESCRIPTION', w - 12), 'AMOUNT', w));
    b.cmd(...C.BOLD_OFF);
    b.str(hr);

    // ── Line items
    for (const item of (d.items || [])) {
      b.str(String(item.name).slice(0, w));
      const detail = `  ${item.qty} x ${Number(item.price).toFixed(2)}`;
      const total  = `${(item.qty * item.price).toFixed(2)}`;
      b.str(_cols2(detail, total, w));
    }
    b.str(hr);

    // ── Totals
    if ((d.discountAmount || 0) > 0) {
      b.str(_cols2('Subtotal:', `${(d.subtotal || 0).toFixed(2)}`, w));
      b.str(_cols2('Discount:', `-${(d.discountAmount || 0).toFixed(2)}`, w));
    }
    if ((d.taxAmount || 0) > 0) {
      b.str(_cols2(`VAT (${d.taxRate || 16}%):`, `${(d.taxAmount || 0).toFixed(2)}`, w));
    }
    b.cmd(...C.BOLD_ON, ...C.DH);
    b.str(_cols2('TOTAL  KES:', `${(d.total || 0).toFixed(2)}`, w));
    b.cmd(...C.NORMAL, ...C.BOLD_OFF);
    b.str(hr);

    // ── Payment info
    const pm = (d.paymentMethod || 'CASH').toUpperCase();
    b.str(_cols2(`Paid (${pm}):`, `${(d.amountPaid || d.total || 0).toFixed(2)}`, w));
    if ((d.change || 0) > 0) b.str(_cols2('Change:', `${(d.change || 0).toFixed(2)}`, w));
    if (d.mpesaRef)           b.str('M-PESA Ref: ' + d.mpesaRef);
    if (d.mpesaPhone)         b.str('Phone: ' + d.mpesaPhone);
    b.str(hr);

    // ── Footer
    b.cmd(...C.CENTER);
    b.str(d.footerMessage || 'Thank you for shopping with us!');
    b.str('Powered by SOKONI SmartPOS');
    b.str('');

    // ── Feed + cut
    b.cmd(...C.FEED(4), ...C.CUT);

    return b.bytes();
  }

  /* ── Build price label HTML ──────────────────────────────────── */
  function buildLabelHTML(products, opts = {}) {
    const w = opts.width || 60, h = opts.height || 30;
    const items = Array.isArray(products) ? products : [products];
    const rows = [];
    for (let i = 0; i < items.length; i += (opts.perRow || 3)) {
      rows.push(items.slice(i, i + (opts.perRow || 3)));
    }
    return `<!DOCTYPE html><html><head><style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Arial,sans-serif;background:#fff}
      .row{display:flex;flex-wrap:wrap}
      .label{width:${w}mm;height:${h}mm;border:0.5pt solid #999;
             display:flex;flex-direction:column;align-items:center;
             justify-content:center;padding:2mm;page-break-inside:avoid;margin:0.5mm}
      .biz{font-size:6pt;color:#666;margin-bottom:1mm}
      .name{font-size:9pt;font-weight:bold;text-align:center;line-height:1.2;margin-bottom:1mm}
      .price{font-size:14pt;font-weight:900}
      .sku{font-size:7pt;font-family:monospace;margin-top:1mm;color:#444}
      @media print{body{margin:0}@page{margin:5mm}}
    </style></head><body>
    <div class="row">
      ${items.map(p => `
        <div class="label">
          <div class="biz">${opts.businessName || 'SOKONI'}</div>
          <div class="name">${p.name || ''}</div>
          <div class="price">KES ${Number(p.price || 0).toFixed(2)}</div>
          ${p.barcode ? `<div class="sku">${p.barcode}</div>` : ''}
        </div>
      `).join('')}
    </div>
    <script>window.print();window.onafterprint=()=>window.close()<\/script>
    </body></html>`;
  }

  /* ── Browser/HTML receipt ────────────────────────────────────── */
  function printBrowser(d) {
    /* Prefer SokoniReceipt (adds QR code, thermal format, VAT breakdown) */
    if (window.SokoniReceipt) {
      window.SokoniReceipt.print({
        type:      'sale',
        orderId:   d.receiptNo || '',
        storeName: d.businessName    || 'SOKONI SmartPOS',
        storeAddr: d.businessAddress || '',
        storeTel:  d.businessPhone   || '',
        cashier:   d.cashierName     || '',
        customer:  d.customerName    || '',
        items:     (d.items || []).map(i => ({ name: i.name, qty: i.qty || 1, unitPrice: i.price || 0, discount: 0 })),
        subtotal:  d.subtotal   || d.total || 0,
        discount:  d.discountAmount || 0,
        tax:       d.taxAmount  || 0,
        total:     d.total      || 0,
        method:    d.paymentMethod || 'Cash',
        mpesaRef:  d.mpesaRef   || '',
        note:      d.footerMessage || '',
        date:      d.timestamp ? new Date(d.timestamp) : null,
        showQR:    true,
        vatRate:   d.taxRate || 16,
      });
      return;
    }
    const w = window.open('', '_blank', 'width=420,height=700');
    if (!w) { (window._skToast||alert)('Allow popups to print receipts'); return; }
    const pm = (d.paymentMethod || 'cash').toUpperCase();
    w.document.write(`<!DOCTYPE html><html><head>
    <meta charset="utf-8">
    <style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:'Courier New',monospace;font-size:12px;width:302px;margin:0 auto;padding:10px;color:#000;background:#fff}
      .c{text-align:center}.r{text-align:right}.b{font-weight:700}
      .xl{font-size:16px;font-weight:900}.lg{font-size:14px;font-weight:700}
      .hr{border:none;border-top:1px dashed #000;margin:6px 0}
      .row{display:flex;justify-content:space-between;padding:1px 0}
      .row .l{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
      @media print{body{margin:0;width:100%}@page{margin:0}}
    </style></head><body>
    <div class="c xl">${d.businessName || 'SOKONI POS'}</div>
    ${d.businessAddress ? `<div class="c">${d.businessAddress}</div>` : ''}
    ${d.businessPhone   ? `<div class="c">Tel: ${d.businessPhone}</div>` : ''}
    ${d.businessPin     ? `<div class="c">PIN: ${d.businessPin}</div>` : ''}
    <hr class="hr">
    <div class="row"><span>Receipt: <b>${d.receiptNo}</b></span><span>${new Date(d.timestamp || Date.now()).toLocaleDateString('en-KE')}</span></div>
    <div>Cashier: ${d.cashierName || 'N/A'} &nbsp; ${new Date(d.timestamp || Date.now()).toLocaleTimeString('en-KE')}</div>
    ${d.customerName ? `<div>Customer: ${d.customerName}</div>` : ''}
    <hr class="hr">
    ${(d.items || []).map(item => `
      <div style="font-size:11px">${item.name}</div>
      <div class="row"><span class="l">&nbsp;&nbsp;${item.qty} × KES ${Number(item.price).toFixed(2)}</span><span>KES ${(item.qty * item.price).toFixed(2)}</span></div>
    `).join('')}
    <hr class="hr">
    ${(d.discountAmount || 0) > 0 ? `
      <div class="row"><span>Subtotal:</span><span>KES ${(d.subtotal||0).toFixed(2)}</span></div>
      <div class="row"><span>Discount:</span><span>-KES ${(d.discountAmount||0).toFixed(2)}</span></div>` : ''}
    ${(d.taxAmount || 0) > 0 ? `
      <div class="row"><span>VAT (${d.taxRate||16}%):</span><span>KES ${(d.taxAmount||0).toFixed(2)}</span></div>` : ''}
    <div class="row xl b" style="margin:4px 0"><span>TOTAL:</span><span>KES ${(d.total||0).toFixed(2)}</span></div>
    <hr class="hr">
    <div class="row"><span>Paid (${pm}):</span><span>KES ${(d.amountPaid||d.total||0).toFixed(2)}</span></div>
    ${(d.change||0)>0 ? `<div class="row"><span>Change:</span><span>KES ${(d.change||0).toFixed(2)}</span></div>` : ''}
    ${d.mpesaRef   ? `<div>M-PESA Ref: <b>${d.mpesaRef}</b></div>` : ''}
    ${d.mpesaPhone ? `<div>Phone: ${d.mpesaPhone}</div>` : ''}
    <hr class="hr">
    <div class="c">${d.footerMessage || 'Thank you for shopping with us!'}</div>
    <div class="c" style="font-size:9px;margin-top:4px;color:#666">SOKONI SmartPOS · mysokoni.co.ke</div>
    <script>window.onload=()=>{window.print();window.onafterprint=()=>window.close()}<\/script>
    </body></html>`);
    w.document.close();
  }

  /* ── Connect: Bluetooth ───────────────────────────────────────── */
  async function connectBluetooth() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth not supported in this browser');
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [
        '000018f0-0000-1000-8000-00805f9b34fb',
        'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
        '00001101-0000-1000-8000-00805f9b34fb',
        '49535343-fe7d-4ae5-8fa9-9fafd205e455',
      ],
    });
    const server = await device.gatt.connect();
    let char = null;

    const tryUUIDs = [
      ['000018f0-0000-1000-8000-00805f9b34fb', '00002af1-0000-1000-8000-00805f9b34fb'],
      ['e7810a71-73ae-499d-8c15-faa9aef0c3f2', 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f'],
      ['49535343-fe7d-4ae5-8fa9-9fafd205e455', '49535343-8841-43f4-a8d4-ecbe34729bb3'],
    ];

    for (const [svcUUID, chrUUID] of tryUUIDs) {
      try {
        const svc = await server.getPrimaryService(svcUUID);
        char = await svc.getCharacteristic(chrUUID);
        break;
      } catch (_) {
        try {
          const svc = await server.getPrimaryService(svcUUID);
          const chars = await svc.getCharacteristics();
          char = chars.find(c => c.properties.write || c.properties.writeWithoutResponse);
          if (char) break;
        } catch (_2) {}
      }
    }

    if (!char) throw new Error('Could not find writable characteristic. Try pairing the printer first.');
    _conn = { device, server, char };
    _type = 'bluetooth';

    /* Auto-reconnect on GATT server disconnect */
    device.addEventListener('gattserverdisconnected', async () => {
      console.warn('[PosPrinter] Bluetooth disconnected — scheduling reconnect');
      _conn = null;
      /* Notify PosDeviceManager if loaded — it manages the backoff loop */
      if (window.PosDeviceManager) {
        const matched = PosDeviceManager.getAll().find(d => d.connectionMethod === 'bluetooth' && d.meta?.btName === device.name);
        if (matched) { PosDeviceManager._scheduleReconnect(matched.id); return; }
      }
      /* Standalone fallback: attempt reconnect up to 5 times with backoff */
      let attempt = 0;
      const tryReconnect = async () => {
        if (attempt++ >= 5) return;
        await new Promise(r => setTimeout(r, Math.min(3000 * Math.pow(2, attempt - 1), 60000)));
        try {
          const s = await device.gatt.connect();
          let ch = null;
          const BT_PAIRS = [
            ['0000ffe0-0000-1000-8000-00805f9b34fb','0000ffe1-0000-1000-8000-00805f9b34fb'],
            ['000018f0-0000-1000-8000-00805f9b34fb','00002af1-0000-1000-8000-00805f9b34fb'],
            ['e7810a71-73ae-499d-8c15-faa9aef0c3f2','bef8d6c9-9c21-4c9e-b632-bd58c1009f9f'],
          ];
          for (const [su, cu] of BT_PAIRS) {
            try { const svc = await s.getPrimaryService(su); ch = await svc.getCharacteristic(cu); if (ch) break; } catch (_) {}
          }
          if (ch) { _conn = { device, server: s, char: ch }; _type = 'bluetooth'; console.info('[PosPrinter] Reconnected via Bluetooth'); }
          else tryReconnect();
        } catch (_) { tryReconnect(); }
      };
      tryReconnect();
    });

    return device.name || 'Bluetooth Printer';
  }

  /* ── Connect: USB ─────────────────────────────────────────────── */
  async function connectUSB() {
    if (!navigator.usb) throw new Error('WebUSB not supported in this browser');
    const device = await navigator.usb.requestDevice({ filters: [{ classCode: 0x07 }] });
    await device.open();
    if (!device.configuration) await device.selectConfiguration(1);
    let endpoint = null;
    for (const iface of device.configuration.interfaces) {
      try {
        await device.claimInterface(iface.interfaceNumber);
        endpoint = iface.alternate.endpoints.find(e => e.direction === 'out' && e.type === 'bulk');
        if (endpoint) break;
      } catch (_) {}
    }
    if (!endpoint) throw new Error('No bulk-OUT endpoint found on USB printer');
    _conn = { device, endpointNum: endpoint.endpointNumber };
    _type = 'usb';
    return device.productName || 'USB Printer';
  }

  /* ── Connect: Network ─────────────────────────────────────────── */
  async function connectNetwork(host, port = 9100) {
    // Verify reachability via a simple fetch (requires CORS-enabled proxy in prod)
    _conn = { host, port };
    _type = 'network';
    return `${host}:${port}`;
  }

  /* ── Connect: Browser fallback ─────────────────────────────────── */
  function connectBrowser() {
    _conn = {};
    _type = 'browser';
    return 'Browser (PDF/Print dialog)';
  }

  /* ── Send bytes ───────────────────────────────────────────────── */
  async function _send(bytes) {
    if (!_conn || !_type) throw new Error('No printer connected');
    const MTU = 512;

    if (_type === 'bluetooth') {
      for (let i = 0; i < bytes.length; i += MTU) {
        const chunk = bytes.slice(i, i + MTU);
        if (_conn.char.properties.writeWithoutResponse) {
          await _conn.char.writeValueWithoutResponse(chunk);
        } else {
          await _conn.char.writeValueWithResponse(chunk);
        }
        await new Promise(r => setTimeout(r, 20));
      }
    } else if (_type === 'usb') {
      for (let i = 0; i < bytes.length; i += MTU) {
        await _conn.device.transferOut(_conn.endpointNum, bytes.slice(i, i + MTU));
      }
    } else if (_type === 'network') {
      /* Forward ESC/POS bytes through the posPrint Cloud Function.
         The function validates auth, SSRF-guards the host, and opens
         a raw TCP socket to the printer on port 9100 (or custom port). */
      const CF_BASE = 'https://us-central1-sokoni-aeb26.cloudfunctions.net';
      const shopId  = (window.SOKONI_CONFIG && window.SOKONI_CONFIG.shopId) || '';

      /* Obtain Firebase ID token for auth */
      let idToken = '';
      try {
        const fb   = window.firebase || window.firebaseApp;
        const auth = fb && (typeof fb.auth === 'function' ? fb.auth() : fb.auth);
        if (auth && auth.currentUser) {
          idToken = await auth.currentUser.getIdToken();
        }
      } catch (_) {}

      const qs = new URLSearchParams({
        host:   _conn.host,
        port:   String(_conn.port || 9100),
        shopId,
      });

      const resp = await fetch(`${CF_BASE}/posPrint?${qs}`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/octet-stream',
          'Authorization': idToken ? `Bearer ${idToken}` : '',
        },
        body: bytes,
      });

      if (!resp.ok) {
        const errBody = await resp.json().catch(() => ({}));
        throw new Error('Network printer error: ' + (errBody.error || resp.status));
      }
    }
  }

  /* ── Public API ───────────────────────────────────────────────── */
  async function print(receiptData) {
    if (_type === 'browser' || !_conn) {
      printBrowser(receiptData);
      return;
    }
    await _send(buildReceipt(receiptData));
  }

  async function printLabel(products, opts) {
    const html = buildLabelHTML(products, opts);
    const w = window.open('', '_blank', 'width=700,height=500');
    if (!w) { (window._skToast||alert)('Allow popups to print labels'); return; }
    w.document.write(html);
    w.document.close();
  }

  async function testPrint(bizSettings) {
    await print({
      businessName:    bizSettings?.businessName || 'SOKONI SmartPOS',
      businessAddress: bizSettings?.businessAddress || 'Test Street, Nairobi',
      businessPhone:   bizSettings?.businessPhone || '+254700000000',
      receiptNo:       'TEST-001',
      cashierName:     'Test Cashier',
      timestamp:       Date.now(),
      items: [
        { name: 'Test Product A',     qty: 2, price: 50 },
        { name: 'Another Test Item',  qty: 1, price: 120 },
        { name: 'Long Product Name for Testing Width', qty: 3, price: 35 },
      ],
      subtotal:      340,
      discountAmount:0,
      taxAmount:     54.4,
      taxRate:       16,
      total:         394.4,
      paymentMethod: 'cash',
      amountPaid:    400,
      change:        5.6,
      footerMessage: '=== TEST RECEIPT ===',
    });
  }

  function openCashDrawer() {
    if (_type && _type !== 'browser') _send(new Uint8Array(C.DRAWER)).catch(() => {});
  }

  function setPaperWidth(mm) { _cols = mm === 80 ? 42 : 32; }
  function isConnected() { return !!_conn && !!_type; }
  function getType()     { return _type; }

  function disconnect() {
    if (_type === 'bluetooth' && _conn?.device?.gatt?.connected) {
      _conn.device.gatt.disconnect();
    }
    _conn = null;
    _type = null;
  }

  /* Raw byte sender — used by SokoniPrintEngine for custom ESC/POS documents */
  async function sendRaw(bytes) { return _send(bytes); }

  /* ESC/POS QR code command builder (GS ( k) */
  function buildQR(data, size = 6, ecLevel = 'M') {
    const ecMap = { L: 48, M: 49, Q: 50, H: 51 };
    const ec = ecMap[ecLevel] ?? 49;
    const encoded = [];
    for (let i = 0; i < data.length; i++) encoded.push(data.charCodeAt(i) & 0x7f);
    const dLen = encoded.length + 3;
    return new Uint8Array([
      GS, 0x28, 0x6b, 4, 0, 49, 65, 50, 0,
      GS, 0x28, 0x6b, 3, 0, 49, 67, Math.min(Math.max(size, 1), 16),
      GS, 0x28, 0x6b, 3, 0, 49, 69, ec,
      GS, 0x28, 0x6b, dLen & 0xff, (dLen >> 8) & 0xff, 49, 80, 48, ...encoded,
      GS, 0x28, 0x6b, 3, 0, 49, 81, 48,
    ]);
  }

  return {
    connectBluetooth, connectUSB, connectNetwork, connectBrowser,
    print, printLabel, testPrint, openCashDrawer, printBrowser,
    isConnected, getType, disconnect, setPaperWidth, buildReceipt,
    sendRaw, buildQR,
  };
})();

window.PosPrinter = PosPrinter;

