#!/usr/bin/env node
/* test-xss-product-surfaces.js — seller- and buyer-written fields cannot execute script on the product surfaces:
 * homepage cards / nearby sellers / compare / stories (script.js), the product page (product.js), the category grid
 * (category.js), the seller page (seller-public.html), the store page (store.html) and the shared image resolver
 * (sokoni-image.js).
 *
 *   node scripts/test-xss-product-surfaces.js                 # working tree — must PASS
 *   COUNTERPROOF=1 node scripts/test-xss-product-surfaces.js  # the same files @ 4e9607b — failures ARE the defects
 *
 * The REAL render code is extracted from each file and fed HOSTILE author data (scripts/lib/xss-probe.js H(n) values:
 * attribute breakouts, <img onerror>, and '); JS-string breakouts, each tagged with a field number). The produced
 * HTML is parsed by a real browser with JavaScript DISABLED; any payload that lands in an executable context (an
 * on* handler, a <script>, a javascript: URL, an injected element) is a FAIL naming the field.
 * Controls prove the renderers still render real content (names, prices, links) — an empty string cannot pass.
 */
'use strict';
const X = require('./lib/xss-probe');
const CPM = !!process.env.COUNTERPROOF;
const read = X.reader('4e9607b', CPM);
const { ck, st } = X.makeCk();
const H = X.H;
const SEC = read('security.js');
const escapeHTML = X.runWith('(function(){ ' + X.extractFrom(SEC, 'function escapeHTML(str){') + ' return escapeHTML; })()', {});

const leaks = (hits) => hits.map((h) => h.ctx + (h.field ? ' ← field ' + h.field : ''));
async function probeCase(name, html, mustContain) {
  const [hits] = await X.probe([html]);
  const ok = hits.length === 0 && (!mustContain || mustContain.every((s) => html.includes(s)));
  ck(name, ok, hits.length ? leaks(hits) : { missing: (mustContain || []).filter((s) => !html.includes(s)), sample: html.slice(0, 160) });
}

/* one hostile product, every author field tagged */
const HP = () => ({ id: H(1), name: H(2), location: H(3), kebsCert: H(4), wholesalePrice: 900, minWholesaleQty: H(5), image: H(6),
  description: H(7), category: 'electronics', sellerName: H(8), price: 1234, stock: H(9), wishlistCount: H(10), video: H(11), videoUrl: H(12),
  sellerUid: H(13), images: [H(14)], county: H(15) });
/* the product page's delivery line reads deliveryTime INSTEAD of location when set — probe both branches */
const HP2 = () => Object.assign(HP(), { deliveryTime: H(16) });

(async () => {
  console.log('\nSOURCE: ' + (CPM ? '4e9607b (before) — failures below ARE the defects' : 'working tree (fix)'));

  /* ── sokoni-image.js pick(): the shared resolver refuses attribute-breaking values ── */
  {
    const src = read('sokoni-image.js');
    const win = {};
    X.runWith('(function(){ ' + src + ' })()', { window: win, document: { addEventListener() {}, readyState: 'complete', querySelectorAll: () => [] } });
    const pick = win.pickProductImage || (win.SokoniImage && win.SokoniImage.pick);
    /* a real-looking URL with a breakout appended — the old resolver accepted anything starting with http or / */
    const U = 'https://cdn.x/a.jpg" onerror="__xss(6)', R = '/img/b.png"><img src=x onerror=__xss(14)>';
    const got = pick ? [pick({ image: U }), pick({ images: [R] }), pick({ imageStorageUrls: [U] }), pick(U)] : [];
    ck('I1  pick() returns no attribute-breaking value from a seller image field', !!pick && got.every((v) => !/["'<>`]/.test(v)), got);
    ck('I2  pick() still returns a real URL (control)', !!pick && pick({ image: 'https://cdn.x/a.jpg' }) === 'https://cdn.x/a.jpg' && pick({ imageStorageUrls: ['/img/b.png'] }) === '/img/b.png');
  }

  /* ── script.js ── */
  const S = read('script.js');
  const escLine = X.lineOf(S, 'const _escHtml = s =>');
  const extra = ['const _safeCssBg', 'const _safeHref'].map((h) => { try { return X.lineOf(S, h); } catch (e) { return ''; } }).join('\n');
  const SCOPE = () => ({ window: {}, locationLabels: {}, KEBS_REQUIRED_CATS: new Set(), location: { href: 'https://mysokoni.co.ke/' } });
  {
    const code = '(function(){ ' + escLine + '\n' + extra + '\n' + X.extractFrom(S, 'function kebsBadge(product){') + '\n' + X.extractFrom(S, 'function buildProductCard(product){') + '\nreturn buildProductCard(__p); })()';
    const html = X.runWith(code, Object.assign(SCOPE(), { __p: HP() }));
    await probeCase('S1  homepage product card: location, KEBS title, bulk qty, image, name', html, ['class="product-name"', 'pcard-ov-name']);
  }
  {
    const tpl = X.tplAt(S, 'return `<div class="seller-card"');
    const name = H(20);
    const code = '(function(){ ' + escLine + '\nconst s = __s; const profileUrl = `seller-public.html?seller=${encodeURIComponent(s.name)}`; const initials = s.name.slice(0,2); const locationName = s.location; const tags = [__t]; const starsHtml = ""; const ratingText = "New Seller"; const totalSales = 0;\nreturn ' + tpl + '; })()';
    const html = X.runWith(code, Object.assign(SCOPE(), { __s: { name, location: H(21), products: [{}] }, __t: H(22), CAT_LABELS: {} }));
    await probeCase('S2  nearby-seller card: name, location, category tag, profile link', html, ['New Seller']);
  }
  {
    const code = '(function(){ ' + escLine + '\nconst bar = {style:{}, addEventListener(){}, querySelector(){ return null; }, querySelectorAll(){ return []; }}; const compareList = [__p];\n' + X.extractFrom(S, 'function renderCompareBar(){').replace(/^function renderCompareBar\(\)\{/, '').replace(/\}$/, '').replace(/[\s\S]*?(bar\.innerHTML = `)/, '$1') + '\nreturn bar.innerHTML; })()';
    let html = '';
    try { html = X.runWith(code, Object.assign(SCOPE(), { __p: HP() })); } catch (e) { html = 'ERR ' + e.message; }
    await probeCase('S3  compare bar: image and name', html, ['Compare']);
  }
  {
    const rows = X.extractFrom(S, 'const rows = [');
    const tpl = X.tplAt(S, 'modal.innerHTML = `');
    const code = '(function(){ ' + escLine + '\nconst compareList = [__p];\n' + rows + '\nreturn ' + tpl + '; })()';
    const html = X.runWith(code, Object.assign(SCOPE(), { __p: HP(), priceChangeBadge: () => '' }));
    await probeCase('S4  compare modal: image, name, category, location, stock, description, KEBS', html, ['Product Comparison']);
  }
  {
    const cb = X.extractFrom(S, 'ring.innerHTML = addBubble + grouped.map(s => {');
    const story = { sellerName: H(30), media: H(31), emoji: H(32), bgGradient: H(33), type: 'photo', premium: false };
    const story2 = Object.assign({}, story, { type: H(34), media: '' });
    const code = '(function(){ ' + escLine + '\n' + extra + '\nconst ring = {}; const addBubble = ""; const combined = __g; const grouped = __g;\n' + cb + ').join("");\nreturn ring.innerHTML; })()';
    const html = X.runWith(code, Object.assign(SCOPE(), { __g: [story, story2] }));
    await probeCase('S5  stories ring: media, emoji, seller name, background, type', html, ['onclick="openStoryAt(']);
  }
  {
    const tpl = X.tplAt(S, 'ctaEl.innerHTML = `<a href="${safeLink}"');
    const safeLine = X.lineOf(S, 'const safeLink =');
    const out = [];
    for (const link of ['javascript:__xss(40)', 'java\tscript:__xss(41)', ' JAVASCRIPT:__xss(42)', '&#106;avascript:__xss(43)', 'store.html?id=abc']) {
      const code = '(function(){ ' + escLine + '\n' + extra + '\nconst _rawLink = String(__l).trim();\n' + safeLine + '\nconst label = "Go"; const accent = "#71ff00"; const accentDim = accent + "33"; const accentBorder = accent + "55"; const accentHover = accent + "cc";\nreturn ' + tpl + '; })()';
      out.push(X.runWith(code, Object.assign(SCOPE(), { __l: link })));
    }
    const hits = (await X.probe(out.slice(0, 4))).flat();
    ck('S6  story CTA link: javascript: in every obfuscation is neutralised', hits.length === 0, leaks(hits));
    ck('S7  story CTA link: a same-site link is kept (control)', /href="store\.html\?id=abc"/.test(out[4]), out[4].slice(0, 120));
  }

  /* ── product.js ── */
  const P = read('product.js');
  const pEsc = X.lineOf(P, 'function _esc(s){');
  {
    const tpl = X.tplAt(P, '/* PRODUCT PAGE */');
    const code = '(function(){ ' + pEsc + '\nconst product = __p;\nreturn ' + tpl + '; })()';
    const run = (p) => { try { return X.runWith(code, { __p: p, window: {}, _lt: () => ({ primary: { icon: '', label: '' }, secondary: null }) }); } catch (e) { return 'ERR ' + e.message; } };
    await probeCase('P1  product page: gallery media, seller link, KEBS, bulk qty, description, video, ships-from', run(HP()), ['KES 1,234']);
    await probeCase('P1b product page: the delivery-time branch', run(HP2()), ['Est. delivery']);
  }
  {
    const fn = X.extractFrom(P, 'function renderRelatedProducts(){');
    const dom = X.domStub();
    const list = [HP(), Object.assign(HP(), { category: 'other' })];
    const code = '(function(){ ' + pEsc + '\n' + fn + '\nrenderRelatedProducts(); return document.getElementById("relatedProductsGrid").innerHTML; })()';
    const html = X.runWith(code, { document: dom.document, product: { id: 'self', category: 'electronics' }, localStorage: { getItem: (k) => (k === 'sellerProducts' ? JSON.stringify(list) : null) }, window: {} });
    await probeCase('P2  "you may also like" cards: id, image, name', html, ['yml-card']);
  }

  /* ── category.js ── */
  {
    const C = read('category.js');
    const cEsc = X.lineOf(C, 'function _esc(s){');
    const fn = X.extractFrom(C, 'function renderProducts(list){');
    const dom = X.domStub();
    const code = '(function(){ ' + cEsc + '\n' + fn + '\nrenderProducts(__l); return document.getElementById("catProductsGrid").innerHTML; })()';
    const html = X.runWith(code, { __l: [HP()], document: dom.document, window: {}, applyVariantFilters: (l) => l, renderVariantFilters: () => {}, _activeOffers: new Map(),
      localStorage: { getItem: () => null }, meta: { title: 'Cat', icon: '' }, _variantBase: null,
      /* a callable stub would make `typeof ageGateWrap === "function"` true and replace the card with '' */
      ageGateWrap: undefined });
    await probeCase('C1  category card: card link, image, shop ring, cart / wishlist / buy buttons', html, ['product-card', 'Add']);
  }

  /* ── seller-public.html ── */
  {
    const SP = read('seller-public.html');
    const grid = X.tplAt(SP, 'qs("spProductsGrid").innerHTML = products.map(p => `');
    const sales = X.tplAt(SP, 'qs("spSalesTbody").innerHTML = salesRows.slice(0,30).map(r => `');
    const reviews = X.extractFrom(SP, '${ratings.slice(0,15).map(r=>{'.slice(2));
    const badge = X.lineOf(SP, 'badgesEl.innerHTML += `<span class="sp-badge-location">');
    const r = { buyerName: H(50), comment: H(51), date: H(52), orderId: H(53), delivery: H(54), responseTime: H(55), returns: H(56), satisfaction: H(57), avgScore: 4 };
    const code = '(function(){ const badgesEl = {innerHTML:""}; const locationName = __loc; const statusPill = {};\n' + badge + '\n'
      + 'const a = __products.map(p => ' + grid + ').join("");\n'
      + 'const b = __rows.map(r => ' + sales + ').join("");\n'
      + 'const ratings = [__r]; const c = ' + reviews + ').join("");\n'
      + 'return badgesEl.innerHTML + a + b + c; })()';
    const html = X.runWith(code, { escapeHTML, window: {}, __loc: H(58), __products: [HP()], __rows: [{ orderId: H(59), date: H(60), product: H(61), revenue: 10, status: H(62) }], __r: r });
    await probeCase('SP1 seller page: location, product cards, sales rows, buyer reviews', html, ['sp-product-card', 'sp-review-card']);
  }

  /* ── store.html ── */
  {
    const ST = read('store.html');
    const sEsc = X.lineOf(ST, 'const _esc = s =>');
    const grid = X.extractFrom(ST, 'gridEl.innerHTML = products.map(p=>{');
    const reviews = X.extractFrom(ST, '${ratings.slice(0,20).map(r=>{'.slice(2));
    const hours = ST.slice(ST.indexOf("    return '<div class=\"st-hour-row\">'"), ST.indexOf('+ "</div>";', ST.indexOf("    return '<div class=\"st-hour-row\">'")) + '+ "</div>";'.length);
    const cats = X.extractFrom(ST, 'cats.map(function(cat) {');
    const fsp = X.extractFrom(ST, 'grid.innerHTML = fsProds.map(function(p) {');
    const logo = X.lineOf(ST, 'if (lw) lw.innerHTML');
    const dimg = X.lineOf(ST, 'dlw.innerHTML = ');
    const r = { buyerName: H(70), comment: H(71), date: H(72), orderId: H(73), delivery: H(74), responseTime: H(75), returns: H(76), satisfaction: H(77), avgScore: 4 };
    const code = '(function(){ ' + sEsc + '\nconst gridEl = {}; const grid = {}; const lw = {}; const dlw = {};\n'
      + 'const products = __products; const fsProds = __products; const byCat = {}; byCat[__cat] = __products;\n'
      + grid + ').join("");\n'
      + fsp + ').join("");\n'
      + 'const ratings = [__r]; const rv = ' + reviews + ').join("");\n'
      + 'const hr = (function(){ const isToday = false, isClosed = false, pill = "", dayNames = ["Monday"], i = 0; const h = __h;\n' + hours + ' })();\n'
      + 'const cl = [__cat].map(function(cat) {' + cats.slice(cats.indexOf('{') + 1) + ').join("");\n'
      + 'const sd = { logo: __u }; ' + logo + '\nconst dimg = __u; ' + dimg + '\n'
      + 'return gridEl.innerHTML + grid.innerHTML + rv + hr + cl + lw.innerHTML + dlw.innerHTML; })()';
    let html = '';
    try { html = X.runWith(code, { window: {}, __products: [HP()], __r: r, __h: H(78), __cat: H(79), __u: H(80) }); } catch (e) { html = 'ERR ' + e.message; }
    await probeCase('ST1 store page: product grid (both paths), reviews, hours, collections, logo', html, ['st-product-card']);
  }

  await X.close();
  console.log(`\n${st.pass} passed, ${st.fail} failed`);
  if (CPM) console.log('(counter-proof: every S/P/C/SP/ST failure is a live sink; I2 and S7 are controls)');
  process.exit(st.fail ? 1 : 0);
})().catch(async (e) => { await X.close(); console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
