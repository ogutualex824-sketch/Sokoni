/* test-catalogue-u1-browser.js — universal catalogue U1 (2026-09-29): the release-lineage dependencies, ported into
 * this branch, working in a REAL browser inside the REAL merchant-v2 Products module.
 *
 * Ported (see docs/UNIVERSAL_CATALOGUE_CENSUS.md): sokoni-product-taxonomy.js (4f67b4b), attachProductImages +
 * the stock-authority routing + the writer rules (4f67b4b / 911ec98 / 511836c lineage), sokoni-warranty-ui.js (3f9f238).
 *
 * Loads the SAME modules, in the SAME order, as merchant-v2.html, and mounts SokoniMerchantProducts with an adapter of
 * the shape the shell supplies (queryProducts / getProduct / writeProduct / writeMirror / putImage).
 *
 * PROVES
 *   UB1 the category picker offers all 99 taxonomy categories
 *   UB2 the form is SHAPED by the category: food → Food licensing; a high-theft category → ownership; digital →
 *       download link; KEBS only where it applies
 *   UB3 a food listing without its county permit is refused and NOTHING is written
 *   UB4 create with a photo: Storage first, then the record (image + images), then the mirrors carry the photo
 *   UB5 opening stock goes to the inventory authority (merchantAdjustStock), never into the product document; the
 *       mirrors carry the ESTABLISHED count
 *   UB6 an oversized / non-image file is rejected before any upload
 *   UB7 a forged ownership approval is clamped to pending; a stock edit is refused; a cross-shop photo attach is
 *       refused before any byte is uploaded
 */
'use strict';
const Path = require('path');
const http = require('http');
const fs = require('fs');
const ROOT = Path.resolve(__dirname, '..');
const say = console.log;
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 240) + ']' : '')); ok ? pass++ : fail++; };

/* the modules merchant-v2.html loads for Products, in its order */
const MODULES = ['sokoni-product-taxonomy.js', 'sokoni-product-specs.js', 'sokoni-warranty-ui.js', 'sokoni-merchant-media.js', 'sokoni-merchant-data.js', 'sokoni-merchant-products.js'];
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/sokoni-warranty-ui.css">
<style>:root{--txt:#f4f4f4;--txt2:#a8a8a8;--txt3:#6d6d6d;--acc:#71ff00;--line:rgba(255,255,255,.09);--panel:#0d0d0d;--card:#141414}body{margin:0;background:#050505;color:#f4f4f4;font:14px system-ui}</style></head>
<body><div id="host" style="min-height:100vh"></div>
${MODULES.map((m) => `<script src="/${m}"></script>`).join('\n')}
<script>
  var SCOPE = { ok: true, shopId: 'shopA', sellerUid: 'shopA' };
  window.__st = { products: { pOther: { id: 'pOther', name: 'Not mine', price: 100, shopId: 'shopB', sellerUid: 'shopB' } }, mirrors: {}, log: [], puts: [], adjusted: [] };
  var ST = window.__st;
  /* the adapter the shell supplies (merchant-v2 _mdb), in memory */
  window.__db = {
    queryProducts: async function (spec) { return Object.values(ST.products).filter(function (p) { return (spec.where || []).every(function (w) { return w[1] === '==' && p[w[0]] === w[2]; }); }); },
    getProduct: async function (id) { return ST.products[id] || null; },
    writeProduct: async function (o) { ST.log.push({ op: o.mode, id: o.id, keys: Object.keys(o.data || {}) }); if (o.mode === 'create' && ST.products[o.id]) return { replayed: true }; ST.products[o.id] = Object.assign({}, ST.products[o.id] || {}, o.data); return { replayed: false }; },
    deleteProduct: async function (o) { ST.log.push({ op: 'delete', id: o.id }); delete ST.products[o.id]; },
    writeMirror: async function (o) { var k = o.path.join('/'); ST.mirrors[k] = Object.assign({}, ST.mirrors[k] || {}, o.data); },
    putImage: async function (o) { ST.puts.push({ path: o.path || null, size: o.blob && o.blob.size }); return 'https://storage.example/' + encodeURIComponent(String(o.path || ('img' + ST.puts.length))); },
  };
  window.__ui = SokoniMerchantProducts.mount(document.getElementById('host'), {
    scope: SCOPE, db: window.__db, storage: window.__db, shopName: 'Duka A',
    entitlement: async function () { return { uploadLimit: 50 }; },
    canPublish: async function () { return { data: { allowed: true, count: 1, limit: 50 } }; },
    /* the CONTRACT of merchantAdjustStock (functions/merchant-inventory.js): it writes products/{id}.stock on the server
       (with inventoryVersion) — a fake that only recorded the call would make every later re-read see no stock */
    adjustStock: async function (p) { ST.adjusted.push(p); var d = ST.products[p.productId]; if (d) { d.stock = (Number(d.stock) || 0) + p.delta; d.inventoryVersion = (Number(d.inventoryVersion) || 0) + 1; } return { ok: true }; },
    onToast: function () {},
  });
</script></body></html>`;

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url.split('?')[0]);
      if (u === '/' || u === '/u1.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
      const f = Path.join(ROOT, u.replace(/^\/+/, ''));
      if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(''); }
      res.writeHead(200, { 'content-type': f.endsWith('.css') ? 'text/css' : 'application/javascript' });
      res.end(fs.readFileSync(f));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}
/* a real 1×1 PNG */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const srv = await serve();
  const BASE = 'http://127.0.0.1:' + srv.address().port;
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const T = { timeout: 8000 };
  const act = async (label, fn) => { try { await fn(); return true; } catch (e) { ck('flow: ' + label, false, String(e && e.message).slice(0, 180)); return false; } };
  try {
    const P = await browser.newPage({ viewport: { width: 390, height: 900 } });
    const errors = []; P.on('pageerror', (e) => errors.push(e.message));
    await P.goto(BASE + '/u1.html');
    await P.waitForFunction(() => window.__ui && document.querySelector('[data-pr="add"]'), null, { timeout: 15000 }).catch(() => {});
    await act('open the create form', async () => { await P.click('[data-pr="add"]', T); await P.waitForSelector('[data-pf="category"]', T); });
    const cats = await P.evaluate(() => { const s = document.querySelector('select[data-pf="category"]'); return s ? [...s.options].map((o) => o.value).filter(Boolean) : null; });
    const tx = await P.evaluate(() => [].concat.apply([], SokoniProductTaxonomy.GROUPS.map((g) => g.options.map((o) => o.value)))).catch(() => []);   /* absent taxonomy = FAIL, not a crash */
    ck('UB1 the category picker offers all 99 taxonomy categories', Array.isArray(cats) && cats.length === 99 && tx.length === 99 && tx.every((c) => cats.includes(c)), { picker: cats && cats.length, taxonomy: tx.length });

    const sectionFor = async (cat) => {
      /* no category picker (the taxonomy absent) is a FAIL of the checks below, not a crash */
      if (!(await P.$('select[data-pf="category"]'))) return { food: false, own: false, digital: false, kebs: false, noPicker: true };
      await P.selectOption('select[data-pf="category"]', cat, T);
      await P.dispatchEvent('select[data-pf="category"]', 'change');
      await P.waitForTimeout(150);
      return P.evaluate(() => ({ food: !!document.querySelector('[data-pf="foodLicence.permit"]'), own: !!document.querySelector('[data-pf^="ownership."]'),
        digital: !!document.querySelector('[data-pf="digitalUrl"]'), kebs: !!document.querySelector('[data-pf="kebsCert"]') }));
    };
    const sFood = await sectionFor('meat'), sOwn = await sectionFor('electronics'), sDig = await sectionFor('ebook'), sSvc = await sectionFor('cleaning');
    ck('UB2 the form is shaped by the category (food / ownership / digital / KEBS)',
      sFood.food && !sFood.digital && sOwn.own && sOwn.kebs && !sOwn.food && sDig.digital && !sDig.food && !sDig.own && !sSvc.food && !sSvc.own && !sSvc.digital && !sSvc.kebs,
      { sFood, sOwn, sDig, sSvc });

    /* UB3 — food without its permit */
    await sectionFor('meat');
    const before = await P.evaluate(() => window.__st.log.length);
    await act('submit food without permit', async () => {
      await P.fill('[data-pf="name"]', 'Goat meat 1kg', T); await P.fill('[data-pf="price"]', '900', T);
      await P.click('[data-pr="submit"]', T); await P.waitForTimeout(400);
    });
    const ub3 = await P.evaluate(() => ({ writes: window.__st.log.length, text: document.getElementById('host').innerText }));
    ck('UB3 a food listing without its county permit is refused; nothing is written', ub3.writes === before && /county food business permit/i.test(ub3.text), { writes: ub3.writes - before });

    /* UB4/UB5 — a real create with a photo and an opening stock, through the UI */
    await act('create with photo + opening stock', async () => {
      await sectionFor('electronics');
      await P.fill('[data-pf="name"]', 'Tecno Spark 20', T); await P.fill('[data-pf="price"]', '15000', T);
      await P.fill('[data-pf="stock"]', '5', T);
      await P.setInputFiles('input[data-pf="photos"]', { name: 'phone.png', mimeType: 'image/png', buffer: PNG });
      await P.waitForTimeout(300);
      await P.click('[data-pr="submit"]', T);
      await P.waitForFunction(() => Object.values(window.__st.products).some((p) => p.name === 'Tecno Spark 20' && Array.isArray(p.images) && p.images.length), null, { timeout: 10000 });
    });
    const made = await P.evaluate(() => { const p = Object.values(window.__st.products).find((x) => x.name === 'Tecno Spark 20'); if (!p) return null;
      const st = window.__st; const cw = st.log.find((l) => l.op === 'create' && l.id === p.id); return { p, createKeys: cw ? cw.keys : null, puts: st.puts.length, adjusted: st.adjusted, pos: st.mirrors['posProducts/' + p.id], inv: st.mirrors['tenants/shopA/inventory_products/' + p.id] }; });
    ck('UB4 the photo went to Storage first, then onto the record and into both mirrors',
      made && made.puts >= 1 && /^https:\/\//.test(made.p.image || '') && made.p.images.length === 1 && made.pos && made.pos.imageUrl === made.p.image && made.inv && made.inv.imageUrl === made.p.image,
      made && { image: made.p.image, puts: made.puts });
    ck('UB5 the writer never writes stock: opening stock is the first merchantAdjustStock movement, and the mirrors show what it established (5)',
      made && Array.isArray(made.createKeys) && !made.createKeys.includes('stock') && made.p.stock === 5 && made.p.inventoryVersion === 1 && made.adjusted.length === 1 && made.adjusted[0].delta === 5 && made.adjusted[0].adjustmentId === 'open_' + made.p.id
      && made.pos.stockLevel === 5 && made.inv.stockLevel === 5, made && { createKeys: made.createKeys, docStock: made.p.stock, adjusted: made.adjusted, posStock: made.pos && made.pos.stockLevel });

    /* UB6 — the media gate */
    const ub6 = await P.evaluate(async () => { try {
      const M = window.SokoniMerchantMedia;
      const big = new File([new Uint8Array(16 * 1024 * 1024)], 'huge.png', { type: 'image/png' });
      const txt = new File(['hello'], 'x.txt', { type: 'text/plain' });
      const r = M.validateAll([big, txt]);
      return { accepted: r.accepted.length, rejected: r.rejected.length }; } catch (e) { return { error: String(e && e.message) }; }
    }).catch((e) => ({ error: String(e && e.message) }));
    ck('UB6 an oversized and a non-image file are rejected before any upload', ub6.accepted === 0 && ub6.rejected === 2, ub6);

    /* UB7 — the writer's own authorities, exercised directly in the page */
    const ub7 = await P.evaluate(async () => { try {
      const MD = window.SokoniMerchantData, db = window.__db, scope = { ok: true, shopId: 'shopA', sellerUid: 'shopA' };
      const out = {};
      const r = await MD.createProduct({ scope, db, draftToken: 'forge1', canPublish: null, adjustStock: null,
        product: { name: 'Laptop', price: 50000, category: 'computers', ownership: { serial: 'SN1', source: 'shop', status: 'approved' }, verificationStatus: 'approved' } });
      const p = window.__st.products[r.id];
      out.ownStatus = p.ownership && p.ownership.status; out.verif = p.verificationStatus;
      try { await MD.updateProduct({ scope, db, id: r.id, patch: { stock: 99 } }); out.stockEdit = 'accepted'; } catch (e) { out.stockEdit = e.code || e.message; }
      const puts = window.__st.puts.length;
      try { await MD.attachProductImages({ scope, db, media: window.SokoniMerchantMedia, storage: db, id: 'pOther', files: [new File([new Uint8Array([137, 80, 78, 71])], 'a.png', { type: 'image/png' })] }); out.cross = 'accepted'; }
      catch (e) { out.cross = e.message; }
      out.crossUploads = window.__st.puts.length - puts;
      return out; } catch (e) { return { error: String(e && e.message) }; }
    }).catch((e) => ({ error: String(e && e.message) }));
    ck('UB7 forged ownership approval clamped to pending; stock edit refused; cross-shop photo refused before any upload',
      ub7.ownStatus === 'pending' && ub7.verif === 'pending' && ub7.stockEdit === 'stock-not-editable' && ub7.cross !== 'accepted' && ub7.crossUploads === 0, ub7);
    ck('no page errors', errors.length === 0, errors.slice(0, 3));
    /* this page lists its own modules — so assert merchant-v2 loads the ported ones, before Products */
    const mv2 = fs.readFileSync(Path.join(ROOT, 'merchant-v2.html'), 'utf8');
    const at = (n) => mv2.indexOf('<script src="' + n + '"></script>');
    ck('UB8 merchant-v2 loads the taxonomy and warranty modules before Products',
      at('sokoni-product-taxonomy.js') > -1 && at('sokoni-warranty-ui.js') > -1 && at('sokoni-product-taxonomy.js') < at('sokoni-merchant-products.js')
      && at('sokoni-warranty-ui.js') < at('sokoni-merchant-products.js') && /href="sokoni-warranty-ui\.css"/.test(mv2));
  } finally { await browser.close().catch(() => {}); srv.close(); }
  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
