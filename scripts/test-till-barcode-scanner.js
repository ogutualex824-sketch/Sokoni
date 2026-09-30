#!/usr/bin/env node
'use strict';
/* ============================================================================
   Till barcode scanner — camera + USB/Bluetooth (keyboard-wedge) → the shop's own product
   ----------------------------------------------------------------------------
     A  wiring: till.html loads sokoni-barcode.js and passes openScanner (camera / manual entry);
        merchant-v2 does the same; the sell engine listens for wedge scans and removes the listener
     B  matching (real sokoni-merchant-data.js): a code finds the product by barcode, legacy
        specs.barcode or SKU; exact, unique match only (two products, one code → no guess)
     C  wedge logic (real sokoni-merchant-sell.js source): Enter in the search field submits;
        unfocused fast keys + Enter = one scan; text fields (cash, phone, notes) are never captured
     D  lookup scope (real sokoni-barcode.js): a lookup without the shop answers null; it queries
        the shop's catalogue only
   node scripts/test-till-barcode-scanner.js     (browser proof: run after the deploy window)
   ============================================================================ */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 300) : '')); } };
const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

console.log('Till barcode scanner\n');
console.log('A. wiring');
const till = src('till.html'), mv2 = src('merchant-v2.html'), sell = src('sokoni-merchant-sell.js');
ck('A1 till.html loads sokoni-barcode.js before the sell engine', till.indexOf('sokoni-barcode.js') > 0 && till.indexOf('sokoni-barcode.js') < till.indexOf('sokoni-merchant-sell.js'));
ck('A2 till.html passes openScanner → SokoniBarcode.scanOnce (and says so when the module is absent)', /openScanner: function \(\) \{[\s\S]{0,300}SokoniBarcode[\s\S]{0,300}scanOnce\(\{ title: 'Scan an item' \}\)/.test(till));
ck('A3 merchant-v2 Sell tab: openScanner uses SokoniBarcode.scanOnce (no longer "not available yet")', /B\.scanOnce\(\{ title: 'Scan an item' \}\)/.test(mv2) && !/Barcode scanning is not available in this workspace yet/.test(mv2));
ck('A4 the sell engine registers a keydown listener for wedge scans and removes it on unmount', /_doc\.addEventListener\('keydown', onKeydown, true\)/.test(sell) && /_doc\.removeEventListener\('keydown', onKeydown, true\)/.test(sell));

console.log('\nB. matching (real sokoni-merchant-data.js)');
const ctx = { window: {}, console };
ctx.window.window = ctx.window; ctx.globalThis = ctx.window; ctx.self = ctx.window;
vm.createContext(ctx);
vm.runInContext(src('sokoni-merchant-data.js'), ctx);
const MD = ctx.window.SokoniMerchantData || ctx.SokoniMerchantData;
ck('B0 SokoniMerchantData loads and exposes findByCode', !!MD && typeof MD.findByCode === 'function', MD && Object.keys(MD).slice(0, 12));
if (MD && MD.findByCode) {
  const products = [
    { id: 'p1', name: 'Soda 500ml', barcode: '6161101600011', sku: null },
    { id: 'p2', name: 'Bread', barcode: null, specs: { barcode: '6164001234567' } },
    { id: 'p3', name: 'Sugar 1kg', sku: 'SUG-1KG' },
    { id: 'p4', name: 'Dup A', barcode: '999000' }, { id: 'p5', name: 'Dup B', barcode: '999000' },
  ];
  ck('B1 a barcode finds its product', (MD.findByCode(products, '6161101600011') || {}).id === 'p1');
  ck('B2 a legacy specs.barcode is found too', (MD.findByCode(products, ' 6164001234567 ') || {}).id === 'p2');
  ck('B3 a typed SKU still works (case-insensitive)', (MD.findByCode(products, 'sug-1kg') || {}).id === 'p3');
  ck('B4 two products, one code → no guess (null)', MD.findByCode(products, '999000') === null);
  ck('B5 an unknown code → null (the till says "no product in this shop matches")', MD.findByCode(products, '123') === null);
  if (typeof MD.normalizeBarcode === 'function') {
    let e = null; try { MD.normalizeBarcode('abc<script>'); } catch (x) { e = x; }
    ck('B6 a code with characters a scanner cannot produce is refused when saving a product', e && e.code === 'BARCODE_INVALID');
  }
}

console.log('\nC. wedge logic (sell engine source)');
ck('C1 Enter in the search field submits the typed code (and is consumed)', /el\.id === 'msl-q'[\s\S]{0,120}ev\.key === 'Enter'[\s\S]{0,80}ev\.preventDefault\(\)[\s\S]{0,80}submitCode\(v, 'field'\)/.test(sell));
ck('C2 unfocused keys faster than a person types, ending in Enter/Tab, are ONE scan', /SCAN_GAP_MS = 45/.test(sell) && /ev\.key === 'Enter' \|\| ev\.key === 'Tab'[\s\S]{0,200}submitCode\(b, 'wedge'\)/.test(sell));
ck('C3 text fields (cash, phone, notes) are never captured', /if \(isTextField\(el\)\) return;/.test(sell));
ck('C4 a scanner double-fire within 400 ms adds once', /SCAN_DUP_MS = 400/.test(sell) && /code === _lastScan\.code && now - _lastScan\.at < SCAN_DUP_MS/.test(sell));
ck('C5 a match is added via addProduct (qty rises on a repeat scan); a miss tells the cashier', /if \(hit\) \{ S\.term = ''; addProduct\(hit\); return true; \}/.test(sell) && /No product in this shop matches/.test(sell));

console.log('\nD. lookup scope (sokoni-barcode.js)');
const bc = src('sokoni-barcode.js');
ck('D1 a lookup needs the shop — without one it answers null (never searches every merchant)', /const shopId = opts && opts\.shopId;\s*if \(!barcode \|\| !shopId\) return null;/.test(bc));
ck('D2 it queries only that shop\'s products', /where\('shopId', '==', shopId\), where\(field, '==', barcode\)/.test(bc));
ck('D3 scanOnce decodes only (resolves the string or null)', /scanOnce\(\{ title \} = \{\}\)/.test(bc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
