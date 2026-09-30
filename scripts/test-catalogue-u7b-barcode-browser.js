/* test-catalogue-u7b-barcode-browser.js — universal catalogue U7b (2026-09-29): the merchant-v2 Products scan buttons
 * WORK, find the shop's OWN product, and can never adopt another shop's.
 *
 * REAL sokoni-barcode.js scanner (its manual-entry path — headless Chromium has no camera) driving the REAL merchant-v2
 * Products module and writer.
 *
 * PROVES
 *   UB1 "Scan an item" opens the real scanner; a code this shop stocks opens THAT product for editing (price, SKU and
 *       stock on screen) — no second product is created
 *   UB2 a legacy product whose code lives only in specs.barcode is found the same way
 *   UB3 a code only ANOTHER shop stocks is treated as new: the create form opens with the code prefilled and saving it
 *       makes a product in THIS shop with top-level barcode set; the other shop's product is untouched and never shown
 *   UB4 the field scan button fills the barcode box; closing the scanner changes nothing
 *   UB5 no horizontal overflow at 390 px; no page errors
 */
'use strict';
const Path = require('path'), http = require('http'), fs = require('fs');
const ROOT = Path.resolve(__dirname, '..');
const say = console.log;
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 280) + ']' : '')); ok ? pass++ : fail++; };
const MODULES = ['sokoni-barcode.js', 'sokoni-product-taxonomy.js', 'sokoni-catalogue-capabilities.js', 'sokoni-sellability.js', 'sokoni-package-stock.js', 'sokoni-product-specs.js',
  'sokoni-warranty-ui.js', 'sokoni-merchant-media.js', 'sokoni-merchant-data.js', 'sokoni-merchant-products.js', 'sokoni-listing-types.js', 'sokoni-listing-model.js', 'sokoni-listing-studio.js'];
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/sokoni-listing-studio.css">
<style>:root{--txt:#f4f4f4;--txt2:#a8a8a8;--txt3:#6d6d6d;--acc:#71ff00;--line:rgba(255,255,255,.09);--panel:#0d0d0d;--card:#141414}body{margin:0;background:#050505;color:#f4f4f4;font:14px system-ui}</style></head>
<body><div id="host" style="min-height:100vh"></div>
${MODULES.map((m) => `<script src="/${m}"></script>`).join('\n')}
<script>
  var SCOPE = { ok: true, shopId: 'shopA', sellerUid: 'shopA' };
  window.__st = { products: {
      a1: { id: 'a1', name: 'Soda 500ml', price: 80, stock: 24, sku: 'SODA-500', status: 'active', shopId: 'shopA', sellerUid: 'shopA', barcode: '6161101234567' },
      a2: { id: 'a2', name: 'Old Juice', price: 90, stock: 3, status: 'active', shopId: 'shopA', sellerUid: 'shopA', specs: { barcode: '5000112233445' } },
      b1: { id: 'b1', name: 'Their Soda', price: 70, stock: 9, status: 'active', shopId: 'shopB', sellerUid: 'shopB', barcode: '7777777777777' } },
    log: [] };
  var ST = window.__st;
  window.__db = {
    queryProducts: async function (spec) { return Object.values(ST.products).filter(function (p) { return (spec.where || []).every(function (w) { return w[1] === '==' && p[w[0]] === w[2]; }); }).map(function (p) { return Object.assign({}, p); }); },
    getProduct: async function (id) { return ST.products[id] ? Object.assign({}, ST.products[id]) : null; },
    writeProduct: async function (o) { ST.log.push({ op: o.mode, id: o.id }); ST.products[o.id] = Object.assign({}, ST.products[o.id] || {}, o.data); return { replayed: false }; },
    findByBarcode: async function (scope, code) { return Object.values(ST.products).filter(function (p) { return p.shopId === scope.shopId && (p.barcode === code || (p.specs && p.specs.barcode === code)); }).map(function (p) { return p.id; }); },
    deleteProduct: async function () {}, writeMirror: async function () {}, putImage: async function () { return 'https://x/y.jpg'; },
  };
  window.__ui = SokoniMerchantProducts.mount(document.getElementById('host'), {
    scope: SCOPE, db: window.__db, storage: window.__db, shopName: 'Duka A', businessCategory: function () { return 'retail_store'; },
    entitlement: async function () { return { uploadLimit: 50 }; }, canPublish: async function () { return { data: { allowed: true } }; },
    adjustStock: async function () { return { ok: true }; }, onToast: function (m) { window.__toast = m; },
  });
</script></body></html>`;
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      if (u === '/bc.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
      const f = Path.join(ROOT, u.replace(/^\/+/, ''));
      if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(''); }
      res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : 'application/javascript' }); res.end(fs.readFileSync(f));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  const srv = await serve();
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const T = { timeout: 8000 };
  const act = async (label, fn) => { try { await fn(); return true; } catch (e) { ck('flow: ' + label, false, String(e && e.message).slice(0, 180)); return false; } };
  const errors = [];
  /* type a code into the REAL scanner's manual-entry box */
  const scanCode = async (P, code) => {
    await P.waitForSelector('#_sbc_modal #_sbc_manual', T);
    await P.fill('#_sbc_manual', code, T); await P.click('#_sbc_manual_btn', T);
    await P.waitForFunction(() => !document.getElementById('_sbc_modal'), null, T);
  };
  const editorName = (P) => P.evaluate(() => { const e = document.querySelector('[data-pf="name"]'); return e ? e.value : null; }).catch(() => null);
  try {
    const P = await browser.newPage({ viewport: { width: 390, height: 900 } });
    P.on('pageerror', (e) => errors.push(e.message));
    await P.goto(BASE + '/bc.html');
    await P.waitForSelector('[data-pr="scanadd"]', { timeout: 15000 });

    /* UB1 */
    const before = await P.evaluate(() => Object.keys(window.__st.products).length);
    let ok1 = await act('scan an item this shop stocks', async () => { await P.click('[data-pr="scanadd"]', T); await scanCode(P, '6161101234567'); await P.waitForSelector('[data-pf="name"]', T); });
    const n1 = await editorName(P);
    const shown1 = await P.evaluate(() => { const v = (s) => (document.querySelector(s) || {}).value; return { price: v('[data-pf="price"]'), sku: v('[data-pf="sku"]') }; }).catch(() => ({}));
    const toast1 = await P.evaluate(() => window.__toast || '');
    const after = await P.evaluate(() => Object.keys(window.__st.products).length);
    ck('UB1 "Scan an item" opens the real scanner; an owned code opens THAT product (price, SKU on screen); nothing created',
      ok1 && n1 === 'Soda 500ml' && String(shown1.price) === '80' && shown1.sku === 'SODA-500' && /Already in your catalogue/.test(toast1) && after === before, { n1, shown1, toast1, before, after });

    /* UB2 */
    await P.goto(BASE + '/bc.html'); await P.waitForSelector('[data-pr="scanadd"]', { timeout: 15000 });
    await act('scan a legacy specs-only code', async () => { await P.click('[data-pr="scanadd"]', T); await scanCode(P, '5000112233445'); await P.waitForSelector('[data-pf="name"]', T); });
    ck('UB2 a legacy product whose code lives only in specs.barcode is found the same way', (await editorName(P)) === 'Old Juice', await editorName(P));

    /* UB3 */
    await P.goto(BASE + '/bc.html'); await P.waitForSelector('[data-pr="scanadd"]', { timeout: 15000 });
    await act('scan a code only another shop stocks, then save', async () => {
      await P.click('[data-pr="scanadd"]', T); await scanCode(P, '7777777777777'); await P.waitForSelector('[data-pf="name"]', T);
    });
    const prefilled = await P.evaluate(() => { const e = document.querySelector('[data-pf="spec.barcode"]'); return e ? e.value : null; }).catch(() => null);
    const nameEmpty = (await editorName(P)) === '';
    await act('save the new product', async () => {
      await P.fill('[data-pf="name"]', 'Duka Soda', T); await P.fill('[data-pf="price"]', '75', T);
      const cat = await P.$('select[data-pf="category"]'); if (cat) { const o = await P.$$eval('select[data-pf="category"] option', (os) => os.map((x) => x.value).filter(Boolean)); if (o[0]) await P.selectOption('select[data-pf="category"]', o[0], T); }
      await P.click('[data-pr="submit"]', T);
      await P.waitForFunction(() => Object.values(window.__st.products).some((p) => p.name === 'Duka Soda'), null, T);
    });
    const made = await P.evaluate(() => Object.values(window.__st.products).find((p) => p.name === 'Duka Soda') || null);
    const b1 = await P.evaluate(() => window.__st.products.b1);
    ck('UB3 another shop\'s code is NEW here: create opens prefilled and saves a THIS-shop product with top-level barcode; theirs untouched',
      prefilled === '7777777777777' && nameEmpty && made && made.shopId === 'shopA' && made.barcode === '7777777777777'
      && b1.shopId === 'shopB' && b1.name === 'Their Soda' && b1.price === 70, { prefilled, nameEmpty, made: made && { shopId: made.shopId, barcode: made.barcode } });

    /* UB4 */
    await P.goto(BASE + '/bc.html'); await P.waitForSelector('[data-pr="add"]', { timeout: 15000 });
    let filled = null, afterClose = null;
    await act('field scan fills the barcode box; close does nothing', async () => {
      await P.click('[data-pr="add"]', T); await P.waitForSelector('[data-pr="scanfield"]', T);
      await P.click('[data-pr="scanfield"]', T); await scanCode(P, '6009876543210');
      filled = await P.evaluate(() => (document.querySelector('[data-pf="spec.barcode"]') || {}).value || null);
      await P.click('[data-pr="scanfield"]', T); await P.waitForSelector('#_sbc_close', T); await P.click('#_sbc_close', T);
      await P.waitForFunction(() => !document.getElementById('_sbc_modal'), null, T);
      afterClose = await P.evaluate(() => (document.querySelector('[data-pf="spec.barcode"]') || {}).value || null);
    });
    ck('UB4 the field scan button fills the barcode box; closing the scanner changes nothing', filled === '6009876543210' && afterClose === '6009876543210', { filled, afterClose });

    const over = await P.evaluate(() => document.documentElement.scrollWidth - window.innerWidth <= 1).catch(() => false);
    const real = errors.filter((m) => !/getUserMedia|NotFoundError|Requested device not found|NotAllowedError|mediaDevices/i.test(m));
    ck('UB5 no horizontal overflow at 390 px; no page errors', over && real.length === 0, { over, errors: real.slice(0, 3) });
  } finally { await browser.close().catch(() => {}); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
