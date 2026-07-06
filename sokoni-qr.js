/**
 * sokoni-qr.js — SOKONI Unified QR Code Engine v2.0
 * Self-contained QR generation — no Google Charts, no external dependencies.
 * Canvas API output. Supports byte-mode, EC Level L/M, Versions 1–10.
 *
 * API (unchanged from v1.0):
 *   SokoniQR.generate(type, id, options)      → canvas data URL (was Google Charts URL)
 *   SokoniQR.renderTo(el, type, id, options)  → renders <canvas> in el
 *   SokoniQR.generateCanvas(url, size)        → returns <canvas> element (new)
 *   SokoniQR.download(src, filename)
 *   SokoniQR.printSheet(codes)
 *   SokoniQR.scan(videoEl, onDetect)
 *   SokoniQR.buildUrl(type, id, base)
 */
window.SokoniQR = (function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════
     QR ENCODER — Galois Field, Reed-Solomon, Matrix, Masking
  ═══════════════════════════════════════════════════════════ */

  /* ── GF(256) arithmetic ─────────────────────────────────── */
  var _EXP = new Uint8Array(512);
  var _LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      _EXP[i] = x; _LOG[x] = i;
      x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
    }
    for (var j = 255; j < 512; j++) _EXP[j] = _EXP[j - 255];
  }());
  function _gm(a, b) { return (a && b) ? _EXP[(_LOG[a] + _LOG[b]) % 255] : 0; }

  /* ── Reed-Solomon generator polynomial and encoder ─────── */
  function _rsPoly(n) {
    var g = [1];
    for (var i = 0; i < n; i++) {
      var ng = new Array(g.length + 1).fill(0);
      for (var j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= _gm(g[j], _EXP[i]); }
      g = ng;
    }
    return g;
  }
  function _rsEnc(data, nec) {
    var g = _rsPoly(nec), m = data.concat(new Array(nec).fill(0));
    for (var i = 0; i < data.length; i++) {
      var c = m[i];
      if (c) for (var j = 0; j < g.length; j++) m[i + j] ^= _gm(g[j], c);
    }
    return m.slice(data.length);
  }

  /* ── Version tables (EC Level L, byte capacity in chars) ── */
  /* V_PARAM: [matrixSize, dataCodewords, ecCodewords, blocks1, blockData1, blocks2, blockData2] */
  /* blocks2/blockData2 = 0 for single-group versions */
  var _VP = [
    null,
    [21,  19,  7,  1, 19, 0,  0 ],   /* v1 */
    [25,  34,  10, 1, 34, 0,  0 ],   /* v2 */
    [29,  55,  15, 1, 55, 0,  0 ],   /* v3 */
    [33,  80,  20, 1, 80, 0,  0 ],   /* v4 */
    [37,  108, 26, 1, 108,0,  0 ],   /* v5 */
    [41,  136, 36, 2, 68, 0,  0 ],   /* v6: 2 blocks of 68 */
    [45,  156, 40, 2, 78, 0,  0 ],   /* v7 */
    [49,  194, 48, 2, 97, 0,  0 ],   /* v8 */
    [53,  232, 60, 2, 116,0,  0 ],   /* v9 */
    [57,  274, 72, 2, 68, 2, 69]     /* v10: 2 blocks of 68 + 2 blocks of 69 */
  ];
  /* Byte-mode capacity at EC Level L (chars) */
  var _CAP = [0, 17, 32, 53, 78, 106, 134, 154, 192, 230, 271];

  /* ── Alignment pattern centers per version ─────────────── */
  var _AP = [
    [], [], [6,18], [6,22], [6,26], [6,30], [6,34],
    [6,22,38], [6,24,42], [6,28,46], [6,26,46]
  ];

  /* ── Pre-computed format info for EC Level L, masks 0-7 ── */
  var _FMT_L = [0x77C4,0x72F3,0x7DAA,0x789D,0x662F,0x6318,0x6C41,0x6976];

  /* ── Choose minimum version ─────────────────────────────── */
  function _ver(textLen) {
    for (var v = 1; v <= 10; v++) if (_CAP[v] >= textLen) return v;
    throw new Error('SokoniQR: text too long (max 271 bytes for version 10)');
  }

  /* ── Encode data codewords (byte mode) ──────────────────── */
  function _encode(text, ver) {
    var p = _VP[ver];
    var totalData = p[1];

    var bits = [];
    function addBits(val, n) { for (var i = n-1; i >= 0; i--) bits.push((val >> i) & 1); }

    var b = [];
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code < 0x80) { b.push(code); }
      else if (code < 0x800) { b.push(0xC0|(code>>6)); b.push(0x80|(code&0x3F)); }
      else { b.push(0xE0|(code>>12)); b.push(0x80|((code>>6)&0x3F)); b.push(0x80|(code&0x3F)); }
    }

    addBits(0b0100, 4);          /* mode: byte */
    addBits(b.length, ver < 10 ? 8 : 16); /* char count */
    b.forEach(function(c) { addBits(c, 8); });
    addBits(0, 4);               /* terminator */
    while (bits.length % 8) bits.push(0);

    var cw = [];
    for (var i = 0; i < bits.length; i += 8) {
      var byte = 0;
      for (var j = 0; j < 8; j++) byte = (byte << 1) | (bits[i+j] || 0);
      cw.push(byte);
    }
    var pad = [0xec, 0x11], pi = 0;
    while (cw.length < totalData) { cw.push(pad[pi++ % 2]); }
    return cw;
  }

  /* ── Interleave blocks + add EC codewords ───────────────── */
  function _interleave(cw, ver) {
    var p = _VP[ver];
    var nec = p[2], b1 = p[3], d1 = p[4], b2 = p[5], d2 = p[6];
    var ecPerBlock = nec / (b1 + b2);

    /* Split into blocks */
    var blocks = [], pos = 0;
    for (var i = 0; i < b1; i++) { blocks.push(cw.slice(pos, pos + d1)); pos += d1; }
    for (var i = 0; i < b2; i++) { blocks.push(cw.slice(pos, pos + d2)); pos += d2; }

    /* Add EC to each block */
    var ecBlocks = blocks.map(function(bl) { return _rsEnc(bl, ecPerBlock); });

    /* Interleave data codewords */
    var out = [];
    var maxD = Math.max(d1, d2);
    for (var i = 0; i < maxD; i++)
      blocks.forEach(function(bl) { if (i < bl.length) out.push(bl[i]); });

    /* Interleave EC codewords */
    for (var i = 0; i < ecPerBlock; i++)
      ecBlocks.forEach(function(ec) { out.push(ec[i]); });

    return out;
  }

  /* ── Build QR matrix ────────────────────────────────────── */
  function _matrix(ver, codewords, maskId) {
    var sz = _VP[ver][0];
    /* Use Int8Array: -1=unset, 0=dark, 1=light (inverted for canvas later) */
    /* Convention: 1=dark module, 0=light module */
    var m = [];
    for (var i = 0; i < sz; i++) m.push(new Int8Array(sz).fill(-1));

    function set(r, c, v) { if (r >= 0 && r < sz && c >= 0 && c < sz) m[r][c] = v; }
    function isFixed(r, c) { return r >= 0 && r < sz && c >= 0 && c < sz && m[r][c] !== -1; }

    /* Finder pattern at (or, oc) */
    function finder(or, oc) {
      for (var dr = -1; dr <= 7; dr++) for (var dc = -1; dc <= 7; dc++) {
        var v = 0;
        if (dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6) {
          if (dr===0||dr===6||dc===0||dc===6) v=1;
          else if (dr>=2&&dr<=4&&dc>=2&&dc<=4) v=1;
        }
        set(or+dr, oc+dc, v);
      }
    }
    finder(0,0); finder(0, sz-7); finder(sz-7, 0);

    /* Timing patterns */
    for (var i = 8; i < sz-8; i++) { set(6,i,i%2===0?1:0); set(i,6,i%2===0?1:0); }

    /* Alignment patterns */
    var ap = _AP[ver];
    for (var ai = 0; ai < ap.length; ai++) for (var aj = 0; aj < ap.length; aj++) {
      var cr = ap[ai], cc = ap[aj];
      if (isFixed(cr, cc)) continue;
      for (var dr = -2; dr <= 2; dr++) for (var dc = -2; dc <= 2; dc++)
        set(cr+dr, cc+dc, dr===0&&dc===0 ? 1 : Math.abs(dr)===2||Math.abs(dc)===2 ? 1 : 0);
    }

    /* Dark module */
    set(4*ver+9, 8, 1);

    /* Reserve format info areas (set to 0 as placeholder) */
    for (var i = 0; i <= 8; i++) { if (m[8][i]===-1) m[8][i]=0; if (m[i][8]===-1) m[i][8]=0; }
    for (var i = sz-8; i < sz; i++) if (m[8][i]===-1) m[8][i]=0;
    for (var i = sz-7; i < sz; i++) if (m[i][8]===-1) m[i][8]=0;

    /* Place data bits */
    var allBits = [];
    codewords.forEach(function(c) { for (var b=7;b>=0;b--) allBits.push((c>>b)&1); });
    var bIdx = 0, goUp = true;
    for (var col = sz-1; col >= 0; col -= 2) {
      if (col === 6) col--;
      for (var step = 0; step < sz; step++) {
        var r = goUp ? sz-1-step : step;
        for (var dc = 0; dc <= 1; dc++) {
          var c = col-dc;
          if (c >= 0 && m[r][c] === -1)
            m[r][c] = bIdx < allBits.length ? allBits[bIdx++] : 0;
        }
      }
      goUp = !goUp;
    }

    /* Apply mask to data modules */
    function maskFn(r, c) {
      switch (maskId) {
        case 0: return (r+c)%2===0;
        case 1: return r%2===0;
        case 2: return c%3===0;
        case 3: return (r+c)%3===0;
        case 4: return (Math.floor(r/2)+Math.floor(c/3))%2===0;
        case 5: return (r*c)%2+(r*c)%3===0;
        case 6: return ((r*c)%2+(r*c)%3)%2===0;
        case 7: return ((r+c)%2+(r*c)%3)%2===0;
      }
    }

    /* Identify function-module positions by rebuilding a clean skeleton */
    var fn = [];
    for (var i = 0; i < sz; i++) fn.push(new Uint8Array(sz));
    function markFn(r, c) { if (r>=0&&r<sz&&c>=0&&c<sz) fn[r][c]=1; }
    for (var or=0; or<sz; or++) for (var oc=0; oc<sz; oc++) {
      /* finder zones (including separator) */
      if ((or<9&&oc<9)||(or<9&&oc>=sz-8)||(or>=sz-8&&oc<9)) markFn(or,oc);
      /* timing */
      if (or===6||oc===6) markFn(or,oc);
      /* dark module */
      if (or===4*ver+9&&oc===8) markFn(or,oc);
    }
    /* alignment zones */
    for (var ai = 0; ai < ap.length; ai++) for (var aj = 0; aj < ap.length; aj++) {
      var cr=ap[ai], cc=ap[aj];
      var inFinder=false;
      if ((cr<=8&&cc<=8)||(cr<=8&&cc>=sz-8)||(cr>=sz-8&&cc<=8)) inFinder=true;
      if (!inFinder) for (var dr=-2;dr<=2;dr++) for (var dc=-2;dc<=2;dc++) markFn(cr+dr,cc+dc);
    }

    for (var r = 0; r < sz; r++) for (var c = 0; c < sz; c++)
      if (!fn[r][c] && m[r][c] !== -1 && maskFn(r, c)) m[r][c] ^= 1;

    /* Write format info */
    var fi = _FMT_L[maskId];
    /* Top-left horizontal */
    var bit = 14;
    for (var c = 0; c <= 8; c++) { if (c!==6) m[8][c] = (fi>>bit--)&1; }
    /* Top-left vertical */
    bit = 6;
    for (var r = 8; r >= 0; r--) { if (r!==6) m[r][8] = (fi>>bit--)&1; }
    /* Top-right */
    bit = 14;
    for (var c = sz-8; c < sz; c++) m[8][c] = (fi>>bit--)&1;
    /* Bottom-left */
    bit = 7;
    for (var r = sz-7; r < sz; r++) m[r][8] = (fi>>bit--)&1;

    return m;
  }

  /* ── Penalty scoring for mask selection ─────────────────── */
  function _penalty(m, sz) {
    var score = 0;
    function r1(line) {
      var run = 1, prev = line[0];
      for (var i = 1; i < line.length; i++) {
        if (line[i]===prev) { run++; if (run===5) score+=3; else if (run>5) score++; }
        else { run=1; prev=line[i]; }
      }
    }
    for (var i = 0; i < sz; i++) {
      r1(Array.from(m[i]));
      var col = []; for (var j=0;j<sz;j++) col.push(m[j][i]);
      r1(col);
    }
    for (var r=0;r<sz-1;r++) for (var c=0;c<sz-1;c++)
      if (m[r][c]===m[r+1][c]&&m[r][c]===m[r][c+1]&&m[r][c]===m[r+1][c+1]) score+=3;
    return score;
  }

  /* ── Generate matrix with best mask ─────────────────────── */
  function _bestMask(ver, cw) {
    var best=0, bestScore=Infinity;
    for (var mk=0;mk<8;mk++) {
      var sc = _penalty(_matrix(ver, cw, mk), _VP[ver][0]);
      if (sc < bestScore) { bestScore=sc; best=mk; }
    }
    return best;
  }

  /* ── Render to canvas ────────────────────────────────────── */
  function _renderToCanvas(text, canvas, pxPerModule) {
    pxPerModule = pxPerModule || 4;
    var textLen = 0;
    for (var i=0;i<text.length;i++) {
      var c=text.charCodeAt(i);
      textLen += c<0x80 ? 1 : c<0x800 ? 2 : 3;
    }
    var ver  = _ver(textLen);
    var cw   = _encode(text, ver);
    var full = _interleave(cw, ver);
    var mask = _bestMask(ver, full);
    var mat  = _matrix(ver, full, mask);
    var sz   = _VP[ver][0];
    var quiet = 4;
    var total = (sz + quiet*2) * pxPerModule;
    canvas.width = total; canvas.height = total;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,total,total);
    ctx.fillStyle = '#000000';
    var off = quiet * pxPerModule;
    for (var r=0;r<sz;r++) for (var c=0;c<sz;c++)
      if (mat[r][c]===1) ctx.fillRect(off+c*pxPerModule, off+r*pxPerModule, pxPerModule, pxPerModule);
  }

  /* ── Public canvas builder ───────────────────────────────── */
  function generateCanvas(url, size) {
    size = size || 256;
    var canvas = document.createElement('canvas');
    /* Pick module size so the QR fills ~size px: quiet zone adds 8 modules */
    var ver = _ver(url.length);
    var modules = _VP[ver][0] + 8;
    var px = Math.max(2, Math.floor(size / modules));
    _renderToCanvas(url, canvas, px);
    return canvas;
  }

  /* ═══════════════════════════════════════════════════════════
     URL BUILDER + TYPE REGISTRY (unchanged from v1.0)
  ═══════════════════════════════════════════════════════════ */
  var QR_TYPES = {
    SHOP: 'shop', PRODUCT: 'product', ORDER: 'order', EVENT: 'event',
    VENUE: 'venue', JOB: 'job', LOYALTY: 'loyalty', PAYMENT: 'payment',
    BUSINESS_CARD: 'card', CUSTOM: 'custom',
  };

  var BASE_URL = 'https://mysokoni.co.ke';

  function _buildUrl(type, id, base) {
    base = base || BASE_URL;
    var routes = {
      shop:    '/shop/' + id,
      product: '/product?id=' + id,
      order:   '/track/' + id,
      event:   '/event?id=' + id,
      venue:   '/venue-booking?id=' + id,
      job:     '/jobs?job=' + id,
      loyalty: '/loyalty?ref=' + id,
      payment: '/checkout?ref=' + id,
      card:    '/card/' + id,
      custom:  id,
    };
    var path = routes[type];
    if (type === 'custom') return id;
    if (path === undefined) return base + '/' + id;
    return base + path;
  }

  function buildUrl(type, id, base) { return _buildUrl(type, id, base || BASE_URL); }

  /* ── generate: returns canvas data URL (replaces Google Charts URL) ── */
  function generate(type, id, options) {
    options = options || {};
    var size  = options.size || 300;
    var url   = _buildUrl(type, id, options.baseUrl || BASE_URL);
    return generateCanvas(url, size).toDataURL('image/png');
  }

  /* ── renderTo: renders <canvas> element in the given DOM el ─ */
  function renderTo(el, type, id, options) {
    options = options || {};
    var size  = options.size || 300;
    var url   = _buildUrl(type, id, options.baseUrl || BASE_URL);
    var label = options.label || type;
    var canvas = generateCanvas(url, size);
    canvas.style.cssText = 'border-radius:8px;display:block;max-width:100%;width:' + size + 'px;height:' + size + 'px';
    canvas.setAttribute('aria-label', 'QR Code for ' + label);
    canvas.setAttribute('role', 'img');
    el.innerHTML = '';
    el.appendChild(canvas);
    return canvas.toDataURL('image/png'); /* return data URL for backward compat */
  }

  /* ── download: works with data URLs and blobs ─────────────── */
  function download(src, filename) {
    filename = filename || 'sokoni-qr.png';
    /* src can be a data URL (from generate()) or a blob URL */
    var a = document.createElement('a');
    a.href = src;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  /* ── printSheet ─────────────────────────────────────────────── */
  function printSheet(codes) {
    if (!codes || !codes.length) { alert('No QR codes to print.'); return; }
    var items = codes.map(function (c) {
      var url    = _buildUrl(c.type, c.id, BASE_URL);
      var size   = c.size || 200;
      var canvas = generateCanvas(url, size);
      var src    = canvas.toDataURL('image/png');
      var lbl    = _esc(c.label || c.type);
      return '<div class="qr-item"><img src="' + src + '" width="' + size + '" height="' + size + '" alt="' + lbl + '"><div class="qr-label">' + lbl + '</div></div>';
    }).join('');
    var win = window.open('', '_blank');
    if (!win) { alert('Allow popups to print QR codes.'); return; }
    win.document.write('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>QR Codes — SOKONI</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:Arial,sans-serif;background:#fff;padding:20px}.no-print{margin-bottom:20px;display:flex;gap:12px}.no-print button{padding:8px 20px;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600}.btn-print{background:#71ff00;color:#000}.btn-close{background:#eee;color:#333}.qr-grid{display:flex;flex-wrap:wrap;gap:24px}.qr-item{text-align:center;border:1px solid #ddd;padding:16px;border-radius:8px;break-inside:avoid}.qr-label{font-size:12px;margin-top:8px;font-weight:600}@media print{.no-print{display:none}body{padding:10px}}@page{size:A4;margin:15mm}</style></head><body><div class="no-print"><button class="btn-print" onclick="window.print()">Print</button><button class="btn-close" onclick="window.close()">Close</button></div><div class="qr-grid">' + items + '</div></body></html>');
    win.document.close();
  }

  /* ── scan (BarcodeDetector) ─────────────────────────────────── */
  function scan(videoEl, onDetect) {
    if (!('BarcodeDetector' in window)) {
      return Promise.resolve({ supported: false, message: 'QR scanning not supported. Use Chrome on Android.' });
    }
    var intervalId = null, stream = null;
    return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(function (s) {
        stream = s;
        videoEl.srcObject = s;
        return videoEl.play();
      })
      .then(function () {
        var detector = new BarcodeDetector({ formats: ['qr_code'] });
        intervalId = setInterval(function () {
          detector.detect(videoEl).then(function (codes) {
            if (codes.length) { clearInterval(intervalId); stream.getTracks().forEach(function(t){t.stop();}); onDetect(codes[0].rawValue); }
          }).catch(function(){});
        }, 300);
        return { supported: true, stop: function () { clearInterval(intervalId); if (stream) stream.getTracks().forEach(function(t){t.stop();}); } };
      });
  }

  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  return { QR_TYPES, generate, generateCanvas, renderTo, download, printSheet, scan, buildUrl };
}());
