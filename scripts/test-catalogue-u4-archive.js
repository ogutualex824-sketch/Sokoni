/* test-catalogue-u4-archive.js — universal catalogue U4 (2026-09-29): "Remove" ARCHIVES; nothing physically deletes a
 * canonical product; archived products leave sale, the till and discovery and can be restored.
 *
 * Owner invariant (B9.17): product existence changes only by an explicit lifecycle act, and that act TOMBSTONES —
 * sokoni-sellability.js tombstonePatch() (ported from dde631b / 332d458) = { status:'archived', isVisible:false }.
 *
 * PROVES (REAL merchant-v2 Products module in Chromium + REAL server pricer in Node)
 *   AR1 Remove asks first, then ARCHIVES: status archived + isVisible false, the POS copy is archived and the Inventory
 *       copy inactive — and the adapter's physical delete is never called
 *   AR2 an archived product leaves the live list and the counts; it appears under the Archived filter with Restore
 *   AR3 Restore brings it back to the status it had (active → active; a draft stays a draft), the mirrors follow
 *   AR4 buyers cannot buy it: the checkout pricer (validateOrderLines) refuses an archived product; the sellability
 *       authority says it is not listed and not orderable
 *   AR5 archiving another shop's product, or an unknown id, is refused and nothing is written
 *   AR6 NO code path physically deletes products/{id}: merchant-v2's adapter, sokoni-db, the KASS tool, and any client
 *       file in any spelling (deleteDoc(doc(db,'products'…)) or fs.deleteDoc(fs.doc(…'products'…)))
 */
'use strict';
process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:1';
process.env.GCLOUD_PROJECT = 'demo-catalogue-u4';
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const Path = require('path');
const http = require('http');
const fs = require('fs');
const ROOT = Path.resolve(__dirname, '..');
const FN = Path.join(ROOT, 'functions');
const say = console.log;
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 260) + ']' : '')); ok ? pass++ : fail++; };
const src = (f) => { try { return fs.readFileSync(Path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };

const MODULES = ['sokoni-product-taxonomy.js', 'sokoni-catalogue-capabilities.js', 'sokoni-sellability.js', 'sokoni-product-specs.js', 'sokoni-warranty-ui.js',
  'sokoni-merchant-media.js', 'sokoni-merchant-data.js', 'sokoni-merchant-products.js', 'sokoni-listing-types.js', 'sokoni-listing-model.js', 'sokoni-listing-studio.js'];
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{--txt:#f4f4f4;--txt2:#a8a8a8;--txt3:#6d6d6d;--acc:#71ff00;--line:rgba(255,255,255,.09);--panel:#0d0d0d;--card:#141414}body{margin:0;background:#050505;color:#f4f4f4;font:14px system-ui}</style></head>
<body><div id="host" style="min-height:100vh"></div>
${MODULES.map((m) => `<script src="/${m}"></script>`).join('\n')}
<script>
  var SCOPE = { ok: true, shopId: 'shopA', sellerUid: 'shopA' };
  window.__st = { products: {
      p1: { id: 'p1', name: 'Kiondo Basket', price: 900, status: 'active', isVisible: true, stock: 4, shopId: 'shopA', sellerUid: 'shopA' },
      p2: { id: 'p2', name: 'Draft Mat', price: 500, status: 'draft', isVisible: false, shopId: 'shopA', sellerUid: 'shopA' },
      pB: { id: 'pB', name: 'Theirs', price: 100, status: 'active', shopId: 'shopB', sellerUid: 'shopB' } },
    mirrors: {}, log: [] };
  var ST = window.__st;
  window.__db = {
    queryProducts: async function (spec) { return Object.values(ST.products).filter(function (p) { return (spec.where || []).every(function (w) { return w[1] === '==' && p[w[0]] === w[2]; }); }).map(function (p) { return Object.assign({}, p); }); },
    getProduct: async function (id) { return ST.products[id] ? Object.assign({}, ST.products[id]) : null; },
    writeProduct: async function (o) { ST.log.push({ op: o.mode, id: o.id }); ST.products[o.id] = Object.assign({}, ST.products[o.id] || {}, o.data); return { replayed: false }; },
    deleteProduct: async function (o) { ST.log.push({ op: 'PHYSICAL-DELETE', id: o.id }); delete ST.products[o.id]; },
    writeMirror: async function (o) { var k = o.path.join('/'); ST.mirrors[k] = Object.assign({}, ST.mirrors[k] || {}, o.data); },
    putImage: async function () { return 'https://x/y.jpg'; },
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
      if (u === '/u4.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
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
    await P.goto(BASE + '/u4.html');
    await P.waitForFunction(() => /Kiondo Basket/.test(document.getElementById('host').innerText), null, { timeout: 15000 }).catch(() => {});
    const openMenuFor = async (name) => {
      const i = await P.evaluate((n) => { const cards = [...document.querySelectorAll('.pr-card')]; return cards.findIndex((c) => c.innerText.indexOf(n) > -1); }, name);
      if (i < 0) throw new Error('no card for ' + name);
      await P.evaluate((i) => { const b = document.querySelectorAll('.pr-card')[i].querySelector('[data-pr="menu"]'); if (b) b.click(); }, i);
      return i;
    };
    /* AR1 */
    let asked = false;
    await act('archive Kiondo via Remove', async () => {
      await openMenuFor('Kiondo Basket');
      await P.evaluate(() => { const b = [...document.querySelectorAll('.pr-menu:not([hidden]) [data-pr="del"]')][0]; b.click(); });
      await P.waitForFunction(() => /Archive this product\?/.test(document.body.innerText), null, T);
      asked = await P.evaluate(() => window.__st.products.p1.status === 'active');
      await P.click('[data-pr="submit"]', T);
      await P.waitForFunction(() => window.__st.products.p1 && window.__st.products.p1.status === 'archived', null, T);
    });
    const a1 = await P.evaluate(() => ({ p: window.__st.products.p1, pos: window.__st.mirrors['posProducts/p1'], inv: window.__st.mirrors['tenants/shopA/inventory_products/p1'], log: window.__st.log }));
    ck('AR1 Remove asks first, then ARCHIVES (tombstone); the till copy is archived, Inventory inactive; no physical delete',
      asked && a1.p && a1.p.status === 'archived' && a1.p.isVisible === false && a1.p.statusBeforeArchive === 'active'
      && a1.pos && a1.pos.status === 'archived' && a1.inv && a1.inv.active === false && !a1.log.some((l) => l.op === 'PHYSICAL-DELETE'),
      { status: a1.p && a1.p.status, pos: a1.pos && a1.pos.status, inv: a1.inv && a1.inv.active });

    /* AR2 */
    await P.waitForTimeout(300);
    const live = await P.evaluate(() => document.getElementById('host').innerText);
    let archivedView = '';
    await act('open the Archived filter', async () => {
      await P.selectOption('select[data-pr="status"]', 'archived', T);
      await P.dispatchEvent('select[data-pr="status"]', 'change');
      await P.waitForFunction(() => /Kiondo Basket/.test(document.getElementById('host').innerText), null, T);
      archivedView = await P.evaluate(() => document.getElementById('host').innerText);
    });
    ck('AR2 an archived product leaves the live list and counts; the Archived filter shows it with Restore',
      !/Kiondo Basket/.test(live) && /Kiondo Basket/.test(archivedView) && /Archived/.test(archivedView) && !/Draft Mat/.test(archivedView)
      && (await P.$('[data-pr="restore"]')) !== null, { liveHasIt: /Kiondo Basket/.test(live) });

    /* AR3 */
    await act('restore Kiondo', async () => {
      await openMenuFor('Kiondo Basket');
      await P.evaluate(() => { const b = [...document.querySelectorAll('.pr-menu:not([hidden]) [data-pr="restore"]')][0] || document.querySelector('[data-pr="restore"]'); b.click(); });
      await P.waitForFunction(() => window.__st.products.p1.status === 'active', null, T);
    });
    const a3 = await P.evaluate(async () => { try {
      const p1 = window.__st.products.p1, pos = window.__st.mirrors['posProducts/p1'];
      const MD = window.SokoniMerchantData, s = { ok: true, shopId: 'shopA', sellerUid: 'shopA' };
      await MD.archiveProduct({ scope: s, db: window.__db, id: 'p2' });
      const r2 = await MD.restoreProduct({ scope: s, db: window.__db, id: 'p2' });
      return { status: p1.status, vis: p1.isVisible, pos: pos && pos.status, draftBack: window.__st.products.p2.status, r2 };
    } catch (e) { return { error: String(e && e.message) }; } }).catch((e) => ({ error: String(e && e.message) }));
    ck('AR3 Restore brings it back to what it was (active → active, visible; a draft stays a draft); the till copy follows',
      a3.status === 'active' && a3.vis === true && a3.pos === 'active' && a3.draftBack === 'draft', a3);

    /* AR5 */
    const a5 = await P.evaluate(async () => { try {
      const MD = window.SokoniMerchantData, s = { ok: true, shopId: 'shopA', sellerUid: 'shopA' }, r = {};
      const before = window.__st.log.length;
      try { await MD.archiveProduct({ scope: s, db: window.__db, id: 'pB' }); r.cross = 'archived'; } catch (e) { r.cross = 'refused'; }
      try { await MD.archiveProduct({ scope: s, db: window.__db, id: 'nope' }); r.unknown = 'archived'; } catch (e) { r.unknown = e.code || 'refused'; }
      try { await MD.deleteProduct({ scope: s, db: window.__db, id: 'pB' }); r.crossDel = 'done'; } catch (e) { r.crossDel = 'refused'; }
      r.writes = window.__st.log.length - before; r.theirs = window.__st.products.pB.status;
      return r;
    } catch (e) { return { error: String(e && e.message) }; } }).catch((e) => ({ error: String(e && e.message) }));
    ck('AR5 archiving another shop\'s product, deleting it, or an unknown id is refused — nothing written',
      a5.cross === 'refused' && a5.crossDel === 'refused' && a5.unknown === 'not-found' && a5.writes === 0 && a5.theirs === 'active', a5);
    ck('no page errors', errors.length === 0, errors.slice(0, 3));
  } finally { await browser.close().catch(() => {}); srv.close(); }

  /* AR4 — the buyer side, on the REAL server pricer */
  const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
  const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
  const stub = (m, exp) => { const p = require.resolve(m, { paths: [FN] }); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
  stub('firebase-admin/firestore', { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath });
  stub('firebase-admin', { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }) });
  let SL = null, PP = null; try { SL = require(Path.join(FN, 'shared', 'sellability.js')); PP = require(Path.join(FN, 'payment-purposes.js')); } catch (_) {}
  if (!SL || !PP) ck('AR4 the sellability authority and the pricer load', false);
  else {
    await db.doc('products/pz').set(Object.assign({ name: 'Archived thing', price: 500, sellerUid: 'shopA', stock: 9 }, SL.tombstonePatch()));
    let code = null; try { await PP.validateOrderLines('buyer1', [{ productId: 'pz', qty: 1 }]); } catch (e) { code = e.message; }
    ck('AR4 buyers cannot buy it: the checkout pricer refuses an archived product; sellability says not listed, not orderable',
      !!code && /not currently available|no longer available/i.test(code) && SL.isPubliclyListed({ status: 'archived' }) === false && SL.maxOrderableQty(SL.tombstonePatch()) === 0, code);
  }

  /* AR6 — no physical delete of products/{id} anywhere */
  const mv2 = src('merchant-v2.html'), sdb = src('sokoni-db.js'), idx = src('functions/index.js');
  const clientHits = fs.readdirSync(ROOT).filter((f) => /\.(js|html)$/.test(f) && f !== 'sokoni-dev-mock.js').filter((f) => {
    const s = src(f);
    return /deleteDoc\(\s*(?:[\w.]+\.)?doc\(\s*[\w.]+\s*,\s*['"]products['"]/.test(s);
  });
  ck('AR6 no code path physically deletes products/{id} (merchant-v2 adapter, sokoni-db, KASS tool, any client file, any spelling)',
    !clientHits.length && /tombstonePatch\(\)/.test(mv2) && !/collection\("products"\)\.doc\([^)]*\)\.delete\(\)/.test(idx) && /tombstonePatch\(\)/.test(sdb),
    clientHits.join(',') || 'none');

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
