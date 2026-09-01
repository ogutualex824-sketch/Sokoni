#!/usr/bin/env node
/**
 * TILL BARCODE PATH — hardware wedge, not just the camera.
 *
 *   node scripts/test-pos-barcode-path.js
 *
 * A hardware scanner is a KEYBOARD WEDGE: it types the code and presses Enter. That is a
 * different input path from camera scanning, and conflating them is how "the scanner does not
 * work" becomes unanswerable — the camera surface can be perfect while the wedge is dead.
 *
 * WHAT THE AUDIT FOUND
 *   pos-scanner.js     27 KB, camera ONLY — zero keyboard handling
 *   sokoni-barcode.js  camera + a manual-entry field (Enter submits); NOT a wedge
 *   pos-barcode.js      7 KB, the ONLY hardware wedge: a document-level keydown intercept
 *
 * The wedge itself is correct — it skips real text fields, requires Enter, uses a 120 ms
 * inter-key window, and debounces duplicates. But it is INERT until a callback is registered,
 * and that registration sat inside `catch (_) {}`. If init threw, every scan did nothing: no
 * error, no log, no difference from an unplugged scanner.
 *
 * WHAT THIS CANNOT PROVE: that a physical scanner emits what this expects. Wedge behaviour
 * varies by device (prefix/suffix characters, inter-key timing, keyboard layout). Hardware
 * acceptance stays UNPROVEN.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const NL = String.fromCharCode(10);
const BC = fs.readFileSync(path.join(ROOT, 'pos-barcode.js'), 'utf8');
const SC = fs.readFileSync(path.join(ROOT, 'pos-scanner.js'), 'utf8');
const POSJS = fs.readFileSync(path.join(ROOT, 'pos.js'), 'utf8');

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};
const un = (l, why) => { console.log('  UNPROVEN  ' + l + '   [' + why + ']'); unproven++; };
const head = (t) => console.log(NL + t);

console.log(NL + 'TILL BARCODE PATH' + NL + '='.repeat(60));

/* ── 1 · the two input paths are distinct ─────────────────────────────────── */
head('1 · hardware and camera are different paths');
ck('a hardware wedge intercept exists',
   BC.indexOf("document.addEventListener('keydown', _onKey, true)") > -1,
   'a scanner types; without a keydown listener nothing receives it');
ck('CONTROL the camera module has NO keyboard path',
   SC.indexOf('keydown') === -1 && SC.indexOf('keypress') === -1,
   'pos-scanner.js is camera-only — it cannot serve a wedge, and must not be assumed to');
ck('the wedge is documented as such', BC.indexOf('Hardware scanner intercept') > -1);

/* ── 2 · the wedge behaves like a wedge ───────────────────────────────────── */
head('2 · the intercept discriminates correctly');
ck('it ignores typing in real text fields',
   BC.indexOf("['INPUT','TEXTAREA','SELECT'].includes(tgt.tagName)") > -1,
   'otherwise a cashier typing a customer name would ring up products');
ck('...except its own scanner input', BC.indexOf('tgt.dataset.posScanner') > -1);
ck('Enter terminates a scan', BC.indexOf("if (e.key === 'Enter')") > -1);
ck('a too-short buffer is not a scan', BC.indexOf('_hwBuffer.length > 2') > -1,
   'a stray Enter must not emit an empty code');
ck('an inter-key timeout resets the buffer', BC.indexOf('_hwBuffer = \'\'; }, 120)') > -1,
   'human typing is slower than a scanner; the window is what separates them');
ck('duplicate scans are debounced',
   BC.indexOf('now - _lastTime < 1500') > -1,
   'a scanner that double-fires must not add the item twice');

/* ── 3 · the registration that arms it ────────────────────────────────────── */
head('3 · the wedge is inert until a callback is registered');
ck('the listener no-ops without a callback', BC.indexOf('if (!_callback) return;') > -1);
ck('POS registers one at boot',
   POSJS.indexOf('PosBarcode.setCallback(handleBarcodeGlobal)') > -1);
ck('a FAILED init is now reported, not swallowed',
   POSJS.indexOf('barcode scanner init failed — hardware scanning is OFF') > -1,
   'it was `catch (_) {}`: a dead scanner and an unplugged one looked identical');
ck('...and the failure is recorded in state',
   POSJS.indexOf('state.scannerReady = false;') > -1);
ck('CONTROL boot still continues when the scanner fails',
   (function () {
     const at = POSJS.indexOf('SCANNER INIT MUST NOT FAIL SILENTLY');
     if (at === -1) return false;
     const body = POSJS.slice(at, at + 900);
     return body.indexOf('catch (err)') > -1 && body.indexOf('throw') === -1;
   })(),
   'a scanner fault must not stop a till from selling');

/* ── 4 · scan resolves to a line item ─────────────────────────────────────── */
head('4 · scan → product → cart');
/* SCOPE TO THE HANDLER. `cart.addByProduct(p)` appears TWICE in pos.js, so a whole-file
   search passed even after the call was removed from the barcode path — the other
   occurrence satisfied it. An assertion that can be satisfied by unrelated code does not
   assert what its label claims. */
const HANDLER = (function () {
  const at = POSJS.indexOf('async function handleBarcodeGlobal');
  return at === -1 ? '' : POSJS.slice(at, at + 1400);
})();
ck('the handler was located', HANDLER.length > 200, HANDLER.length + ' chars');
ck('the code is looked up as a barcode',
   HANDLER.indexOf('PosDB.products.getByBarcode(code)') > -1);
ck('a hit is added to the cart FROM THE SCAN HANDLER',
   HANDLER.indexOf('cart.addByProduct(p)') > -1,
   'scoped: the same call exists elsewhere in pos.js and would mask its removal here');
ck('a MISS prompts registration rather than failing silently',
   HANDLER.indexOf("getElementById('unknown-barcode-val')") > -1,
   'an unknown code is a real situation, not an error to swallow');
ck('CONTROL scans outside the sale screen are ignored',
   POSJS.indexOf("if (state.currentTab !== 'pos') return;") > -1,
   'scanning while on Settings must not silently add items');
ck('CONTROL a field-targeted scan fills the field instead',
   POSJS.indexOf('state.scannerForField') > -1);

/* ── 5 · what only a real scanner can settle ──────────────────────────────── */
head('5 · honestly unproven');
un('a physical scanner emits what this expects',
   'wedge prefix/suffix, inter-key timing and keyboard layout vary by device');
un('the 120 ms window suits the actual hardware',
   'chosen for "scanners finish in <100ms"; unverified against the deployed device');
un('camera scanning on the till',
   'needs a device with a camera and a real barcode in front of it');

console.log(NL + '  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
console.log('  NOTE: source path only. NOT physical scanner certification.');
process.exit(fail ? 1 : 0);
