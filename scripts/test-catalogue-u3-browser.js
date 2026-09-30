/* test-catalogue-u3-browser.js — universal catalogue U2/U3 (2026-09-29) in a REAL browser: the capability matrix
 * decides what the REAL merchant-v2 Listing Studio offers each kind of business, and the REAL writer refuses a type
 * the business may not list.
 *
 * Loads the SAME modules as merchant-v2.html (taxonomy, catalogue capabilities, specs, warranty, media, data,
 * products, listing types/model/studio) and mounts SokoniMerchantProducts with a businessCategory, like the shell.
 *
 * PROVES
 *   CB1 for EVERY one of the 31 categories (and unclassified), the type picker offers EXACTLY the matrix's types —
 *       every allowed type appears, no other type appears (bar the listing's own current type, flagged)
 *   CB2 every type's own fields render in the Studio, and another type's fields do not
 *   CB3 a lawyer's editor offers Service / Package only; a product-type listing is flagged "not something this kind
 *       of business can list"
 *   CB4 the writer REFUSES a lawyer's explicit product listing (TYPE_NOT_ALLOWED) and writes nothing; a lawyer's
 *       service listing saves with listingType 'service'
 *   CB5 an unclassified shop is told it can list goods until SOKONI classifies it, and cannot save a room
 *   CB6 a restaurant can list a dish; a hotel a room; car hire a vehicle — each saved through the same writer
 *   CB7 no horizontal overflow at 390 px; no page errors
 */
'use strict';
const Path = require('path');
const http = require('http');
const fs = require('fs');
const ROOT = Path.resolve(__dirname, '..');
const say = console.log;
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 280) + ']' : '')); ok ? pass++ : fail++; };
const MODULES = ['sokoni-product-taxonomy.js', 'sokoni-catalogue-capabilities.js', 'sokoni-product-specs.js', 'sokoni-warranty-ui.js',
  'sokoni-merchant-media.js', 'sokoni-merchant-data.js', 'sokoni-merchant-products.js', 'sokoni-listing-types.js', 'sokoni-listing-model.js', 'sokoni-listing-studio.js'];
const page = (cat) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/sokoni-listing-studio.css"><link rel="stylesheet" href="/sokoni-warranty-ui.css">
<style>:root{--txt:#f4f4f4;--txt2:#a8a8a8;--txt3:#6d6d6d;--acc:#71ff00;--line:rgba(255,255,255,.09);--panel:#0d0d0d;--card:#141414}body{margin:0;background:#050505;color:#f4f4f4;font:14px system-ui}</style></head>
<body><div id="host" style="min-height:100vh"></div>
${MODULES.map((m) => `<script src="/${m}"></script>`).join('\n')}
<script>
  var SCOPE = { ok: true, shopId: 'shopA', sellerUid: 'shopA' };
  window.__st = { products: {}, log: [] };
  var ST = window.__st;
  window.__db = {
    queryProducts: async function () { return []; }, getProduct: async function (id) { return ST.products[id] || null; },
    writeProduct: async function (o) { ST.log.push({ op: o.mode, id: o.id, data: o.data }); ST.products[o.id] = Object.assign({}, ST.products[o.id] || {}, o.data); return { replayed: false }; },
    deleteProduct: async function () {}, writeMirror: async function () {}, putImage: async function () { return 'https://x/y.jpg'; },
  };
  window.__cat = ${cat === null ? 'null' : JSON.stringify(cat)};
  window.__ui = SokoniMerchantProducts.mount(document.getElementById('host'), {
    scope: SCOPE, db: window.__db, storage: window.__db, shopName: 'Duka A',
    businessCategory: function () { return window.__cat; },
    entitlement: async function () { return { uploadLimit: 50 }; },
    canPublish: async function () { return { data: { allowed: true } }; },
    adjustStock: async function () { return { ok: true }; }, onToast: function () {},
  });
</script></body></html>`;

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      const m = u.match(/^\/cat\/([a-z_]+)\.html$/);
      if (m) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page(m[1] === 'none' ? null : m[1])); }
      const f = Path.join(ROOT, u.replace(/^\/+/, ''));
      if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(''); }
      res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : 'application/javascript' }); res.end(fs.readFileSync(f));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  let CC = null;
  try { CC = require(Path.join(ROOT, 'functions', 'shared', 'catalogue-capabilities.js')); } catch (_) {}
  if (!CC) { ck('the catalogue capability matrix exists (functions/shared/catalogue-capabilities.js)', false); say(`\n${pass} passed, ${fail} failed`); process.exit(1); }
  const cats = Object.keys(CC.CAPS);
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
    /* CB1 + CB2 — the studio's own renderer, for every category, in the browser runtime */
    await P.goto(BASE + '/cat/none.html');
    await P.waitForFunction(() => window.SokoniListingStudio && window.SokoniCatalogueCapabilities, null, { timeout: 15000 }).catch(() => {});
    const per = await P.evaluate((cats) => {
      const S = window.SokoniListingStudio, C = window.SokoniCatalogueCapabilities, out = {};
      [null].concat(cats).forEach((c) => {
        const want = C.capsFor(c).types.slice().sort();
        const box = document.createElement('div');
        box.innerHTML = S.typePickerHTML({ listingType: want[0] }, { businessCategory: c });
        const got = [...box.querySelectorAll('[data-ls="type"]')].map((b) => b.getAttribute('data-type')).sort();
        out[c || 'unclassified'] = { ok: JSON.stringify(got) === JSON.stringify(want), got, want };
      });
      return out;
    }, cats).catch((e) => ({ error: String(e && e.message) }));
    const wrong = per.error ? [per.error] : Object.keys(per).filter((k) => !per[k].ok).map((k) => k + ' got ' + per[k].got.join(',') + ' want ' + per[k].want.join(','));
    ck(`CB1 every one of the ${cats.length} categories + unclassified: the picker offers EXACTLY the matrix's types`, !per.error && Object.keys(per).length === cats.length + 1 && !wrong.length, wrong.slice(0, 4));
    const fieldsOk = await P.evaluate(() => {
      const S = window.SokoniListingStudio, M = window.SokoniListingModel, bad = [];
      window.SokoniCatalogueCapabilities.TYPE_IDS.forEach((t) => {
        const box = document.createElement('div'); box.innerHTML = S.extraFieldsHTML({ listingType: t }) || '';
        const keys = [...box.querySelectorAll('[data-pf]')].map((e) => e.getAttribute('data-pf'));
        const own = M.fieldsFor({ listingType: t }).map((f) => f.key).filter((k) => ['name', 'description', 'price', 'category', 'location'].indexOf(k) === -1);
        const missing = own.filter((k) => !keys.some((x) => x === k || x === 'lf.' + k));
        if (missing.length && own.length) bad.push(t + ' missing ' + missing.join(','));
      });
      const room = document.createElement('div'); room.innerHTML = S.extraFieldsHTML({ listingType: 'room' }) || '';
      if (room.querySelector('[data-pf$="make"]')) bad.push('room shows vehicle make');
      return bad;
    }).catch((e) => ['error ' + e.message]);
    ck('CB2 every type\'s own fields render in the Studio; another type\'s do not', !fieldsOk.length, fieldsOk.slice(0, 4));

    /* CB3/CB4 — a lawyer */
    const L = await browser.newPage({ viewport: { width: 390, height: 900 } }); L.on('pageerror', (e) => errors.push(e.message));
    await L.goto(BASE + '/cat/lawyer.html');
    await act('lawyer opens the editor', async () => { await L.waitForSelector('[data-pr="add"]', { timeout: 15000 }); await L.click('[data-pr="add"]', T); await L.waitForSelector('[data-ls="type"]', T); });
    const lawChips = await L.evaluate(() => [...document.querySelectorAll('[data-ls="type"]')].map((b) => b.getAttribute('data-type'))).catch(() => []);
    const flagged = await L.evaluate(() => !!document.querySelector('[data-ls="type-not-allowed"]')).catch(() => false);
    ck('CB3 a lawyer is offered Service and Package (the inferred Product only as a flagged current type)', lawChips.includes('service') && lawChips.includes('package')
      && !lawChips.includes('room') && !lawChips.includes('food') && !lawChips.includes('bundle') && flagged, { lawChips, flagged });
    const w = await L.evaluate(async () => {
      const MD = window.SokoniMerchantData, db = window.__db, scope = { ok: true, shopId: 'shopA', sellerUid: 'shopA' }, r = {};
      const before = window.__st.log.length;
      try { await MD.createProduct({ scope, db, draftToken: 'l1', businessCategory: 'lawyer', product: { name: 'Land title search', price: 5000, listingType: 'product' } }); r.product = 'saved'; }
      catch (e) { r.product = e.code || e.message; }
      r.writesAfterRefusal = window.__st.log.length - before;
      const ok = await MD.createProduct({ scope, db, draftToken: 'l2', businessCategory: 'lawyer', product: { name: 'Consultation (1 hour)', price: 5000, listingType: 'service' } });
      r.serviceType = (window.__st.products[ok.id] || {}).listingType;
      return r;
    }).catch((e) => ({ error: String(e && e.message) }));
    ck('CB4 the writer refuses a lawyer\'s product listing and writes nothing; a service saves as a service', w.product === 'TYPE_NOT_ALLOWED' && w.writesAfterRefusal === 0 && w.serviceType === 'service', w);

    /* CB5 — unclassified */
    const U = await browser.newPage({ viewport: { width: 390, height: 900 } }); U.on('pageerror', (e) => errors.push(e.message));
    await U.goto(BASE + '/cat/none.html');
    await act('unclassified opens the editor', async () => { await U.waitForSelector('[data-pr="add"]', { timeout: 15000 }); await U.click('[data-pr="add"]', T); await U.waitForSelector('[data-ls="type"]', T); });
    const u = await U.evaluate(async () => {
      const r = { note: !!document.querySelector('[data-ls="unclassified"]'), chips: [...document.querySelectorAll('[data-ls="type"]')].map((b) => b.getAttribute('data-type')) };
      try { await window.SokoniMerchantData.createProduct({ scope: { ok: true, shopId: 'shopA', sellerUid: 'shopA' }, db: window.__db, draftToken: 'u1', businessCategory: null, product: { name: 'Room 4', price: 3000, listingType: 'room' } }); r.room = 'saved'; }
      catch (e) { r.room = e.code || e.message; }
      return r;
    }).catch((e) => ({ error: String(e && e.message) }));
    ck('CB5 an unclassified shop is told it lists goods until classified, and cannot save a room', u.note && !u.chips.includes('room') && u.chips.includes('product') && u.room === 'TYPE_NOT_ALLOWED', u);

    /* CB6 — the same writer, different businesses */
    const saved = await P.evaluate(async () => {
      const MD = window.SokoniMerchantData, db = window.__db, scope = { ok: true, shopId: 'shopA', sellerUid: 'shopA' }, r = {};
      const mk = async (cat, tok, product) => { try { const x = await MD.createProduct({ scope, db, draftToken: tok, businessCategory: cat, product }); return (window.__st.products[x.id] || {}).listingType; } catch (e) { return 'ERR ' + (e.code || e.message); } };
      r.dish = await mk('restaurant', 'r1', { name: 'Pilau', price: 450, listingType: 'food' });
      r.room = await mk('hotel', 'h1', { name: 'Deluxe double', price: 7500, listingType: 'room' });
      r.vehicle = await mk('auto_services', 'a1', { name: 'Toyota Axio (self-drive)', price: 4500, listingType: 'rental' });
      r.project = await mk('trades', 't1', { name: 'Two-bedroom build', price: 2500000, listingType: 'project' });
      return r;
    }).catch((e) => ({ error: String(e && e.message) }));
    ck('CB6 a restaurant saves a dish, a hotel a room, car hire a rental, a contractor a project — one writer', saved.dish === 'food' && saved.room === 'room' && saved.vehicle === 'rental' && saved.project === 'project', saved);

    const over = await L.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1).catch(() => false);
    ck('CB7 no horizontal overflow at 390 px; no page errors', over && errors.length === 0, { over, errors: errors.slice(0, 3) });
  } finally { await browser.close().catch(() => {}); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
