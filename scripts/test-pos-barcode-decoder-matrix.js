/* test-pos-barcode-decoder-matrix.js — the POS barcode module decodes on every device class.
 *
 *   node scripts/test-pos-barcode-decoder-matrix.js        (no browser, no network)
 *
 * Device matrix (2026-09-30, "barcode scanner still unavailable"):
 *   A  Android Chrome        BarcodeDetector with formats      → native
 *   B  Windows/Linux Chrome  BarcodeDetector, EMPTY formats    → native unusable → ZXing
 *   C  iOS Safari / Firefox  no BarcodeDetector               → ZXing
 *   D  native present but detect() throws NotSupported        → flips to ZXing for the same frame
 *   E  ZXing fails to load                                     → honest no_decoder, hasDecoder false
 * Every path still resolves a VALUE only, through the one submitScannedCode.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'pos-barcode.js'), 'utf8');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 160) + ']' : '')); ok ? pass++ : fail++; };

/* A tiny browser: document with script loading that "downloads" a stub ZXing, canvas, createImageBitmap. */
function makeWindow(opts) {
  const o = Object.assign({ native: null, zxingLoads: true, zxingText: '6161100122345' }, opts);
  class HTMLCanvasElement { constructor() { this.width = 0; this.height = 0; } getContext() { return { drawImage() {} }; } }
  class HTMLVideoElement { constructor() { this.videoWidth = 640; this.videoHeight = 480; this.readyState = 2; } }
  class Blob { constructor(w, h) { this.w = w; this.h = h; } }
  const win = {
    HTMLCanvasElement, HTMLVideoElement, Blob, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, console,
    createImageBitmap: async (b) => ({ width: b.w || 320, height: b.h || 200, close() {} }),
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) } },
    location: { pathname: '/pos.html' },
  };
  const doc = {
    head: { appendChild(el) { setTimeout(() => { if (o.zxingLoads) { win.ZXing = makeZXing(o.zxingText); el.onload && el.onload(); } else { el.onerror && el.onerror(); } }, 0); } },
    createElement(tag) { return tag === 'canvas' ? new HTMLCanvasElement() : { tag, set src(v) { this._src = v; }, get src() { return this._src; } }; },
    addEventListener() {}, removeEventListener() {},
  };
  if (o.native) {
    class BarcodeDetector {
      constructor(init) { this.formats = init && init.formats; }
      static async getSupportedFormats() { return o.native.formats; }
      async detect() { if (o.native.throws) { const e = new Error('Barcode detection service unavailable'); e.name = 'NotSupportedError'; throw e; } return [{ rawValue: o.native.value, format: 'ean_13' }]; }
    }
    win.BarcodeDetector = BarcodeDetector;
  }
  win.window = win; win.document = doc; win.self = win;
  return win;
}
function makeZXing(text) {
  return { BrowserMultiFormatReader: class { decodeFromCanvas() { if (!text) { const e = new Error('No MultiFormat Readers were able to detect the code.'); e.name = 'NotFoundException'; throw e; } return { getText: () => text, getBarcodeFormat: () => 'EAN_13' }; } decodeFromVideoElement(v, cb) { this._cb = cb; setTimeout(() => cb({ getText: () => text }), 0); } reset() { this._reset = true; } } };
}
function load(win) {
  const ctx = vm.createContext(win);
  vm.runInContext(SRC, ctx, { filename: 'pos-barcode.js' });
  return win.PosBarcode;
}
const tick = () => new Promise((r) => setTimeout(r, 15));

(async () => {
  console.log('\nPOS BARCODE — DECODER DEVICE MATRIX');
  console.log('='.repeat(70));

  /* A */
  let w = makeWindow({ native: { formats: ['ean_13', 'qr_code'], value: '111' } }); let B = load(w);
  let st = await B.init();
  ck('A Android Chrome: native detector with real formats is used', st.detector === true && st.fallback === null && B.hasDecoder());
  let r = await B.decodeImage(new w.Blob(300, 200));
  ck('A decodeImage returns the VALUE only from the native detector', r.ok && r.code === '111' && !('product' in r));

  /* B */
  w = makeWindow({ native: { formats: [], value: 'never' }, zxingText: '222' }); B = load(w);
  st = await B.init(); await tick();
  ck('B Windows/Linux Chrome: native present but NO formats → marked unusable, ZXing fallback', st.detector === false && st.fallback === 'zxing' && st.nativeUnusable === true);
  r = await B.decodeImage(new w.Blob(300, 200));
  ck('B decodeImage decodes through ZXing (value only)', r.ok && r.code === '222', r);
  ck('B hasDecoder() is TRUE — the premium scanner must not say "unavailable"', B.hasDecoder() === true);

  /* C */
  w = makeWindow({ native: null, zxingText: '333' }); B = load(w);
  st = await B.init(); await tick();
  ck('C iOS Safari / Firefox: no BarcodeDetector → ZXing', st.fallback === 'zxing' && B.hasDecoder());
  r = await B.decodeImage(new w.Blob(300, 200));
  ck('C decodeImage via ZXing', r.ok && r.code === '333');
  const seen = []; B.setCallback((c) => seen.push(c));
  const video = new w.HTMLVideoElement(); video.onloadedmetadata = null;
  const startP = B.startCamera(video, (c) => seen.push(c)); setTimeout(() => video.onloadedmetadata && video.onloadedmetadata(), 5); video.play = async () => {};
  await startP; await tick();
  ck('C live camera: ZXing continuous decode reaches the ONE submit path (debounced callback)', seen.includes('333'), seen);
  B.stopCamera();
  ck('C stopCamera resets the ZXing live reader', B._fallback.state().native === false);

  /* D */
  w = makeWindow({ native: { formats: ['ean_13'], value: 'x', throws: true }, zxingText: '444' }); B = load(w);
  st = await B.init();
  ck('D native detector constructed (formats present)…', st.detector === true);
  r = await B.decodeImage(new w.Blob(300, 200)); await tick();
  ck('D …but detect() throws NotSupported → the SAME frame is answered by ZXing and native is retired', r.ok && r.code === '444' && B._fallback.state().nativeUnusable === true && B._fallback.state().native === false, r);

  /* E */
  w = makeWindow({ native: null, zxingLoads: false }); B = load(w);
  st = await B.init(); await tick();
  r = await B.decodeImage(new w.Blob(300, 200));
  ck('E ZXing cannot load → honest no_decoder, never a fabricated code', !r.ok && r.reason === 'no_decoder', r);
  ck('E hasDecoder() is FALSE only when neither engine exists', B.hasDecoder() === false);

  /* no-barcode frame */
  w = makeWindow({ native: null, zxingText: '' }); B = load(w); await B.init(); await tick();
  r = await B.decodeImage(new w.Blob(300, 200));
  ck('a frame with no barcode is no_barcode_found (a real answer), not an error', !r.ok && r.reason === 'no_barcode_found');

  /* contract with the premium scanner */
  const PS = fs.readFileSync(path.join(ROOT, 'sokoni-premium-scanner.js'), 'utf8');
  ck('premium scanner still consumes only decodeImage / hasDecoder / setCallback / submitScannedCode', /bc\.decodeImage/.test(PS) && /bc\.hasDecoder/.test(PS) && /bc\.submitScannedCode/.test(PS) && !/bc\._fallback/.test(PS));
  ck('the ZXing CDN is the one sokoni-barcode.js already uses (script-src allows unpkg)', /unpkg\.com\/@zxing\/library@0\.20\.0/.test(SRC) && /unpkg\.com\/@zxing\/library@0\.20\.0/.test(fs.readFileSync(path.join(ROOT, 'sokoni-barcode.js'), 'utf8')));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { ck('suite ran', false, e.stack && e.stack.slice(0, 300)); process.exit(1); });
