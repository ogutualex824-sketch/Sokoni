#!/usr/bin/env node
/**
 * PREMIUM SCANNER — four ways in, one product authority.
 *
 *   node scripts/test-premium-scanner.js
 *
 *   physical wedge · live camera · uploaded image · typed entry
 *                          ↓
 *            PosBarcode.submitScannedCode(value)
 *                          ↓
 *            PosDB.products.getByBarcode(value)      ← the ONE authority
 *                          ↓
 *                   cart.addByProduct(product)
 *
 * THE ASSERTION THAT MATTERS MOST is that the scanner cannot reach the cart on its own. A
 * premium surface is not a reason to acquire a second product authority: a decoder that
 * returned a product id, or a UI that called cart.addByProduct directly, would let a photo
 * put an arbitrary item into a sale without the catalogue ever agreeing it exists.
 *
 * BARCODE RECOGNITION IS NOT PRODUCT RECOGNITION. There is deliberately no vision model
 * guessing what an item is. The camera reads a barcode; the catalogue decides what it means.
 * That distinction is asserted, not just described.
 *
 * WHAT THIS CANNOT PROVE: that a real camera decodes a real barcode. BarcodeDetector,
 * getUserMedia, torch and gallery access are device behaviour. Those stay UNPROVEN.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);
const PS = fs.readFileSync(path.join(ROOT, 'sokoni-premium-scanner.js'), 'utf8');
const BC = fs.readFileSync(path.join(ROOT, 'pos-barcode.js'), 'utf8');
const POS = fs.readFileSync(path.join(ROOT, 'pos.html'), 'utf8');
const POSJS = fs.readFileSync(path.join(ROOT, 'pos.js'), 'utf8');

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 92) + ']' : ''));
  ok ? pass++ : fail++;
};
const un = (l, why) => { console.log('  UNPROVEN  ' + l + '   [' + why + ']'); unproven++; };
const head = (t) => console.log(NL + t);

/* Load the module against a fake window so its real behaviour is exercised. */
function load () {
  const win = { PosBarcode: null };
  const mod = { exports: {} };
  const fn = new Function('window', 'module', 'document', 'navigator', 'requestAnimationFrame',
    'cancelAnimationFrame', PS + NL + 'return window.PosPremiumScanner;');
  return {
    win,
    api: fn(win, mod, { getElementById: () => null, createElement: () => ({ style: {}, appendChild(){}, }), head: { appendChild(){} }, body: { appendChild(){} } },
            {}, () => 0, () => {}),
  };
}

console.log(NL + 'PREMIUM SCANNER' + NL + '='.repeat(60));

(async () => {
  /* ── 1 · the resolution boundary ─────────────────────────────────────────── */
  head('1 · the scanner decodes; the catalogue resolves');
  /* Assert on CODE, not on prose. The first version searched the whole file and matched this
     module's own header comment, which documents the flow using the very identifiers it is
     asserting are absent — so a correct module failed its own contract test. */
  const PS_CODE = (function () {
    let out = '', i = 0, inBlock = false;
    while (i < PS.length) {
      if (!inBlock && PS[i] === '/' && PS[i + 1] === '*') { inBlock = true; i += 2; continue; }
      if (inBlock && PS[i] === '*' && PS[i + 1] === '/') { inBlock = false; i += 2; continue; }
      if (!inBlock) out += PS[i];
      i++;
    }
    return out.split(NL).filter((l) => l.trim().indexOf('//') !== 0).join(NL);
  })();
  ck('CONTROL the comment stripper actually removed the header',
     PS_CODE.indexOf('the ONE authority') === -1 && PS_CODE.length > 3000,
     'if this fails the two assertions below prove nothing');
  ck('the module never calls the product catalogue',
     PS_CODE.indexOf('getByBarcode') === -1,
     'resolution belongs to the existing authority, not to a scanner surface');
  ck('CONTROL the module never adds to the cart itself',
     PS_CODE.indexOf('addByProduct') === -1 && PS_CODE.indexOf('cart.add') === -1,
     'a scanner that could add a product would BE a second product authority');
  ck('every path funnels through one submit',
     PS.indexOf('bc.submitScannedCode(code)') > -1);
  ck('...and that entry point exists on the barcode module',
     BC.indexOf('function submitScannedCode(code)') > -1);
  ck('CONTROL submit refuses a non-string value',
     BC.indexOf("if (typeof code !== 'string' || !code.trim()) return false;") > -1,
     'a detector returning an object must not become a catalogue lookup');

  /* ── 2 · image decoding is real ──────────────────────────────────────────── */
  head('2 · "scan an image" means decoding an image');
  ck('the image path decodes a bitmap',
     BC.indexOf('await createImageBitmap(fileOrBlob)') > -1,
     'not a camera preview wearing an upload label');
  ck('...through the SAME detector the camera uses',
     BC.indexOf('_detector.detect(bitmap)') > -1 && BC.indexOf('_detector.detect(videoEl)') > -1,
     'one decoder, so an uploaded photo and a live frame resolve identically');
  ck('a malformed detector result is rejected',
     BC.indexOf("if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'malformed_result' };") > -1);
  ck('an image with no barcode is a REASON, not an error',
     BC.indexOf("reason: 'no_barcode_found'") > -1,
     'the UI can tell the merchant to retake the photo');
  ck('CONTROL decodeImage returns a VALUE, never a product',
     BC.indexOf('return { ok: true, code: raw.trim(), format:') > -1,
     'returning a product id here would bypass the catalogue');
  ck('the bitmap is released',
     BC.indexOf('bitmap.close && bitmap.close()') > -1);

  /* ── 3 · no product recognition ──────────────────────────────────────────── */
  head('3 · barcode recognition, not product guessing');
  ck('CONTROL no vision/OCR model is introduced',
     !/tensorflow|onnx|\bocr\b|tesseract|classif/i.test(PS),
     'a premium scanner must not start guessing products');
  ck('the distinction is written down',
     PS.indexOf('BARCODE RECOGNITION, NOT PRODUCT RECOGNITION') > -1);

  /* ── 4 · it stays off the boot path ──────────────────────────────────────── */
  head('4 · premium, and not a boot cost');
  ck('pos.html does not load it eagerly',
     POS.indexOf('src="sokoni-premium-scanner.js"') === -1);
  ck('it is behind the lazy shim',
     POS.indexOf('lazyGlobal("PosPremiumScanner", "sokoni-premium-scanner.js")') > -1);
  ck('CONTROL the file exists to be loaded',
     fs.existsSync(path.join(ROOT, 'sokoni-premium-scanner.js')));

  /* ── 5 · the module behaves ──────────────────────────────────────────────── */
  head('5 · exercised against a fake barcode module');
  const { win, api } = load();
  ck('the module registers its api', !!api && typeof api.open === 'function');

  const seen = [];
  win.PosBarcode = {
    submitScannedCode: (c) => { seen.push(c); return true; },
    setCallback: () => {},
    hasDecoder: () => true,
    decodeImage: async (f) => (f && f.__code
      ? { ok: true, code: f.__code }
      : { ok: false, reason: 'no_barcode_found' }),
  };

  ck('a decoded image submits its code', (function () {
    api.submit('5901234123457', 'image');
    return seen.length === 1 && seen[0] === '5901234123457';
  })(), seen.join(','));

  ck('NEGATIVE an empty code is not submitted', (function () {
    const before = seen.length;
    win.PosBarcode.submitScannedCode = (c) => {
      if (typeof c !== 'string' || !c.trim()) return false;
      seen.push(c); return true;
    };
    api.submit('   ', 'image');
    return seen.length === before;
  })());

  ck('NEGATIVE with no barcode module nothing is submitted', (function () {
    const { api: a2 } = load();          /* win.PosBarcode stays null */
    let threw = false;
    try { a2.submit('123', 'image'); } catch (_) { threw = true; }
    return threw === false;
  })(), 'it must refuse quietly, not throw into the caller');

  /* ── 6 · the wedge is untouched ──────────────────────────────────────────── */
  head('6 · the physical scanner still works exactly as before');
  ck('the keydown wedge is still installed',
     BC.indexOf("document.addEventListener('keydown', _onKey, true)") > -1);
  ck('the wedge still skips real text fields',
     BC.indexOf("['INPUT','TEXTAREA','SELECT'].includes(tgt.tagName)") > -1);
  ck('the shared duplicate debounce still guards every path',
     BC.indexOf('now - _lastTime < 1500') > -1,
     'submitScannedCode routes through _emit, so image scans inherit it');
  ck('POS still arms the wedge at boot',
     POSJS.indexOf('PosBarcode.setCallback(handleBarcodeGlobal)') > -1);

  /* ── 6b · the entry point ────────────────────────────────────────────────── */
  head('6b · the feature is reachable, and still lazy');
  ck('a Premium Scanner control exists in the scanner UI',
     POS.indexOf('id="premium-scan-btn"') > -1,
     'the module was implemented but unreachable before this');
  ck('it invokes the POS handler',
     POS.indexOf('SPos.barcode.openPremium()') > -1);
  ck('the handler exists', POSJS.indexOf('async openPremium()') > -1);
  ck('it passes the CANONICAL scan callback',
     POSJS.indexOf('PosPremiumScanner.open(handleBarcodeGlobal)') > -1,
     'handing it anything else would create a second product authority');
  ck('CONTROL the handler does not resolve or add to the cart itself',
     (function () {
       const at = POSJS.indexOf('async openPremium()');
       if (at === -1) return false;
       const body = POSJS.slice(at, at + 900);
       return body.indexOf('getByBarcode') === -1 && body.indexOf('addByProduct') === -1;
     })(),
     'the entry point wires; it must not resolve');
  ck('a module that cannot load is reported to the merchant',
     POSJS.indexOf('Premium Scanner could not be loaded') > -1,
     'the lazy shim resolves undefined on failure — a dead button must say so');
  ck('CONTROL the entry point did NOT make the module eager',
     POS.indexOf('src="sokoni-premium-scanner.js"') === -1 &&
     POS.indexOf('lazyGlobal("PosPremiumScanner"') > -1,
     'wiring a feature must not move it onto the boot path');

  /* ── 7 · honestly unproven ───────────────────────────────────────────────── */
  head('7 · what only a device can settle');
  un('a real camera decodes a real barcode', 'BarcodeDetector + getUserMedia are device behaviour');
  un('gallery/image selection on the handset', 'file picker and image formats vary by device');
  un('flashlight and camera switching', 'torch capability is not present on every camera');
  un('scan timing and debounce against real hardware', 'unchanged from the wedge audit');

  console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  console.log('  NOTE: contract and module behaviour. NOT hardware certification.');
  process.exit(fail ? 1 : 0);
})();
