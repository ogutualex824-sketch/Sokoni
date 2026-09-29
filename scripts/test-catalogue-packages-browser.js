/* test-catalogue-packages-browser.js — universal catalogue U5 (2026-09-29): a restaurant builds a Pizza Meal Deal in
 * the REAL merchant-v2 Products editor from its OWN products, sees how many sets its stock makes, and saves a package
 * the checkout can sell — with no stock of its own.
 *
 * PROVES
 *   PB1 choosing "Package" shows the "What's in it" picker, offering only this shop's live, non-package products
 *   PB2 adding Pizza × 1 and Soda × 2 shows "Sets available now: 2" (stock 10 pizzas, 5 sodas) and the separate price
 *   PB3 saving writes components [{pizza,1},{soda,2}] and trackInventory:false — no stock on the package
 *   PB4 the writer refuses a package that contains another shop's product, another package, itself, or nothing; and an
 *       opening stock on a package
 *   PB5 no horizontal overflow at 390 px; no page errors
 */
'use strict';
const Path = require('path'), http = require('http'), fs = require('fs');
const ROOT = Path.resolve(__dirname, '..');
const say = console.log;
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 260) + ']' : '')); ok ? pass++ : fail++; };
const MODULES = ['sokoni-product-taxonomy.js', 'sokoni-catalogue-capabilities.js', 'sokoni-sellability.js', 'sokoni-package-stock.js', 'sokoni-product-specs.js',
  'sokoni-warranty-ui.js', 'sokoni-merchant-media.js', 'sokoni-merchant-data.js', 'sokoni-merchant-products.js', 'sokoni-listing-types.js', 'sokoni-listing-model.js', 'sokoni-listing-studio.js'];
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/sokoni-listing-studio.css">
<style>:root{--txt:#f4f4f4;--txt2:#a8a8a8;--txt3:#6d6d6d;--acc:#71ff00;--line:rgba(255,255,255,.09);--panel:#0d0d0d;--card:#141414}body{margin:0;background:#050505;color:#f4f4f4;font:14px system-ui}</style></head>
<body><div id="host" style="min-height:100vh"></div>
${MODULES.map((m) => `<script src="/${m}"></script>`).join('\n')}
<script>
  var SCOPE = { ok: true, shopId: 'shopA', sellerUid: 'shopA' };
  window.__st = { products: {
      pizza: { id: 'pizza', name: 'Pizza', price: 800, stock: 10, status: 'active', shopId: 'shopA', sellerUid: 'shopA', listingType: 'food' },
      soda: { id: 'soda', name: 'Soda', price: 100, stock: 5, status: 'active', shopId: 'shopA', sellerUid: 'shopA', listingType: 'drink' },
      oldmeal: { id: 'oldmeal', name: 'Old Meal', price: 500, status: 'archived', shopId: 'shopA', sellerUid: 'shopA' },
      combo: { id: 'combo', name: 'Existing Combo', price: 700, status: 'active', shopId: 'shopA', sellerUid: 'shopA', listingType: 'package', components: [{ productId: 'soda', qty: 1 }] },
      theirs: { id: 'theirs', name: 'Their Juice', price: 50, stock: 9, status: 'active', shopId: 'shopB', sellerUid: 'shopB' } },
    log: [] };
  var ST = window.__st;
  window.__db = {
    queryProducts: async function (spec) { return Object.values(ST.products).filter(function (p) { return (spec.where || []).every(function (w) { return w[1] === '==' && p[w[0]] === w[2]; }); }).map(function (p) { return Object.assign({}, p); }); },
    getProduct: async function (id) { return ST.products[id] ? Object.assign({}, ST.products[id]) : null; },
    writeProduct: async function (o) { ST.log.push({ op: o.mode, id: o.id }); ST.products[o.id] = Object.assign({}, ST.products[o.id] || {}, o.data); return { replayed: false }; },
    deleteProduct: async function () {}, writeMirror: async function () {}, putImage: async function () { return 'https://x/y.jpg'; },
  };
  window.__ui = SokoniMerchantProducts.mount(document.getElementById('host'), {
    scope: SCOPE, db: window.__db, storage: window.__db, shopName: 'Mama Pizza', businessCategory: function () { return 'restaurant'; },
    entitlement: async function () { return { uploadLimit: 50 }; }, canPublish: async function () { return { data: { allowed: true } }; },
    adjustStock: async function () { return { ok: true }; }, onToast: function (m) { window.__toast = m; },
  });
</script></body></html>`;
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      if (u === '/pk.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
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
  try {
    const P = await browser.newPage({ viewport: { width: 390, height: 900 } });
    P.on('pageerror', (e) => errors.push(e.message));
    await P.goto(BASE + '/pk.html');
    await act('open the editor and choose Package', async () => {
      await P.waitForSelector('[data-pr="add"]', { timeout: 15000 }); await P.click('[data-pr="add"]', T);
      await P.waitForSelector('[data-ls="type"][data-type="package"]', T); await P.click('[data-ls="type"][data-type="package"]', T);
      await P.waitForSelector('[data-pk-sec]', T);
    });
    const opts = await P.evaluate(() => [...document.querySelectorAll('[data-pk-choose] option')].map((o) => o.value).filter(Boolean)).catch(() => []);
    ck('PB1 "Package" shows the picker, offering only this shop\'s live, non-package products', opts.includes('pizza') && opts.includes('soda')
      && !opts.includes('theirs') && !opts.includes('oldmeal') && !opts.includes('combo'), opts);
    await act('add pizza, then soda twice', async () => {
      await P.selectOption('[data-pk-choose]', 'pizza', T); await P.click('[data-pr="pk-add"]', T); await P.waitForSelector('[data-pk-item="pizza"]', T);
      await P.selectOption('[data-pk-choose]', 'soda', T); await P.click('[data-pr="pk-add"]', T); await P.waitForSelector('[data-pk-item="soda"]', T);
      await P.click('[data-pr="pk-inc"][data-id="soda"]', T);
      await P.waitForFunction(() => (document.querySelector('[data-pk-qty="soda"]') || {}).textContent === '2', null, T);
    });
    const setsText = await P.evaluate(() => (document.querySelector('[data-pk-sets]') || {}).innerText || '').catch(() => '');
    ck('PB2 Pizza × 1 + Soda × 2 → "Sets available now: 2", with the separate price', /Sets available now: 2/i.test(setsText) /* .pr-note is text-transform:uppercase */ && /1,?000/.test(setsText), setsText);
    await act('save the package', async () => {
      await P.fill('[data-pf="name"]', 'Pizza Meal Deal', T); await P.fill('[data-pf="price"]', '850', T);
      const cat = await P.$('select[data-pf="category"]'); if (cat) await P.selectOption('select[data-pf="category"]', 'food', T);
      const perm = await P.$('[data-pf="foodLicence.permit"]'); if (perm) await P.fill('[data-pf="foodLicence.permit"]', 'NRB-FBP-2026-001', T);
      await P.click('[data-pr="submit"]', T);
      await P.waitForFunction(() => Object.values(window.__st.products).some((p) => p.name === 'Pizza Meal Deal'), null, T);
    });
    const made = await P.evaluate(() => Object.values(window.__st.products).find((p) => p.name === 'Pizza Meal Deal') || null);
    ck('PB3 saved with components [{pizza,1},{soda,2}], listingType package, trackInventory:false and no stock', made && made.listingType === 'package'
      && JSON.stringify(made.components) === JSON.stringify([{ productId: 'pizza', qty: 1 }, { productId: 'soda', qty: 2 }]) && made.trackInventory === false && made.stock === undefined, made);
    const refusals = await P.evaluate(async () => {
      const MD = window.SokoniMerchantData, db = window.__db, scope = { ok: true, shopId: 'shopA', sellerUid: 'shopA' }, r = {};
      const mk = async (tok, product) => { try { await MD.createProduct({ scope, db, draftToken: tok, businessCategory: 'restaurant', adjustStock: async () => ({}), product }); return 'saved'; } catch (e) { return e.code || e.message; } };
      r.foreign = await mk('f1', { name: 'X', price: 100, listingType: 'package', components: [{ productId: 'theirs', qty: 1 }] });
      r.nested = await mk('f2', { name: 'Y', price: 100, listingType: 'package', components: [{ productId: 'combo', qty: 1 }] });
      r.empty = await mk('f3', { name: 'Z', price: 100, listingType: 'package', components: [] });
      r.stock = await mk('f4', { name: 'W', price: 100, listingType: 'package', stock: 5, components: [{ productId: 'pizza', qty: 1 }] });
      try { await MD.updateProduct({ scope, db, id: 'combo', businessCategory: 'restaurant', patch: { components: [{ productId: 'combo', qty: 1 }] } }); r.self = 'saved'; } catch (e) { r.self = e.code || e.message; }
      return r;
    }).catch((e) => ({ error: String(e && e.message) }));
    ck('PB4 the writer refuses another shop\'s item, a package inside a package, itself, an empty package, and an opening stock',
      refusals.foreign === 'PACKAGE_COMPONENT_FOREIGN' && refusals.nested === 'PACKAGE_NESTED' && refusals.empty === 'PACKAGE_EMPTY' && refusals.stock === 'PACKAGE_NO_STOCK' && refusals.self === 'PACKAGE_SELF', refusals);
    const over = await P.evaluate(() => document.documentElement.scrollWidth - window.innerWidth <= 1).catch(() => false);
    ck('PB5 no horizontal overflow at 390 px; no page errors', over && errors.length === 0, { over, errors: errors.slice(0, 3) });
  } finally { await browser.close().catch(() => {}); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
