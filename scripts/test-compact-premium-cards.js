#!/usr/bin/env node
/* test-compact-premium-cards.js — the compact premium card contract (owner 2026-09-30), proven on
 * the REAL pages of this tree in Chromium, with no network and no production.
 *
 *   node scripts/test-compact-premium-cards.js                 static + browser (the certification)
 *   node scripts/test-compact-premium-cards.js --static-only   static section only → exit 3 (PARTIAL)
 *
 * The owner's card rules, as ported from feat/compact-premium-cards (bd91d04..5323149):
 *   - product cards: emoji icons only on the photo (❤ wishlist, 🛒 cart / 📩 book); the shop logo
 *     ring stays; no labelled Buy / Add / Share / Offer button; 3 cards per row on phones;
 *   - provider cards: 💬 in-app message + 📩 book icons; the whole card opens the profile;
 *   - shop cards: one 🏪 icon; the card opens the storefront;
 *   - NO WhatsApp hand-off (wa.me / whatsapp) in any card's markup;
 *   - names escaped; no URL spliced into an inline onclick string.
 *
 * Section 1 reads the sources. Section 2 renders index.html, business.html, providers.html and
 * services.html at 390px through scripts/lib/page-harness.js (real files, Firebase SDK shimmed
 * over the transactional fake Firestore, snapshots delivered ASYNCHRONOUSLY, every other origin
 * fulfilled empty) and measures the DOM: 3 per row, icons present, no wa.me/whatsapp in card
 * markup, no horizontal overflow, escaped names, taps that do what the card promises.
 *
 * Negative controls: the same predicates run against a LEGACY card fixture (labelled buttons,
 * a wa.me link, a 2-column grid) in both sections and must report violations — a detector that
 * cannot see the old design proves nothing about the new one.
 *
 * Fails closed: the browser section is skipped ONLY on an explicit --static-only flag, and that
 * run exits 3 and prints PARTIAL, never a pass.
 */
'use strict';
const fs = require('fs');
const Path = require('path');
const ROOT = Path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(Path.join(ROOT, f), 'utf8');
const say = (s) => console.log(s);
let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 160) + ']' : ''));
  ok ? pass++ : fail++;
};
const STATIC_ONLY = process.argv.includes('--static-only');

/* The card-markup violation predicate, ONE definition shared by the static section (source text)
   and the browser section (rendered innerHTML). It is deliberately literal: a wa.me or whatsapp
   token anywhere in a card, or a labelled action control. */
const WA_RE = /wa\.me|whatsapp/i;
/* Comments are not markup: the ported renderers carry "No WhatsApp hand-off" notes, and an HTML
   comment in a template never becomes a control. Strip them before matching, so the predicate
   sees only what a shopper can reach. */
const stripComments = (s) => String(s).replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
function violations(src) {
  const html = stripComments(src);
  const v = [];
  if (WA_RE.test(html)) v.push('whatsapp');
  if (/class="pcard-actions"|pcard-mobile-strip|seller-follow-row|class="pv-actions"|pg-wa-btn|cl-wa-btn/.test(html)) v.push('labelled-row');
  if (/>\s*(View (&amp;|&) Book|Visit Store|View Seller|Add to Cart|Buy Now|Book →|\+ Follow)\s*</.test(html)) v.push('labelled-button');
  return v;
}

/* Legacy fixture — what the cards looked like BEFORE the port (assembled from the retired markup). */
const LEGACY_CARD = '<div class="product-card"><div class="product-img-wrap"><img alt=""></div>'
  + '<div class="pcard-actions"><button>🛒 Add</button><button>⚡ Buy Now</button></div>'
  + '<div class="pcard-mobile-strip"><button class="pcard-m-buy">⚡ Buy</button></div></div>'
  + '<div class="pv-card"><div class="pv-actions"><a href="#" class="pv-btn-book">View &amp; Book</a>'
  + '<a href="https://wa.me/254700000000?text=hi" class="pv-btn-wa">💬 WA</a></div></div>'
  + '<div class="seller-card"><a class="seller-visit-btn">🏪 Visit Store</a><div class="seller-follow-row"><button>+ Follow</button></div></div>';

/* ── 1 · SOURCE CONTRACT ─────────────────────────────────────────────────────── */
say('\n── 1 · source contract ──');
const CSS = read('compact-grid.css'), SC = read('script.js'), CAT = read('category.js'), STORE = read('store.html');
const IDX = read('index.html'), CATH = read('category.html'), CHIPS = read('sokoni-card-chips.js');
const MSCSS = read('minishop.css'), MS = read('sokoni-minishop.js'), BIZ = read('business.html');
const PROV = read('providers.html'), SVC = read('services.html'), CLEAN = read('cleaning.html');
const SPOT = read('sokoni-spotlight.js');
const PG = { 'plumbing.html': read('plumbing.html'), 'electrical.html': read('electrical.html'), 'phone-repair.html': read('phone-repair.html'), 'car-rental.html': read('car-rental.html') };

/* the body of one top-level function, by name (brace-balanced, string-agnostic — enough for these renderers) */
function fnBody(src, name) {
  const i = src.search(new RegExp('function\\s+' + name + '\\s*\\('));
  if (i < 0) return null;
  let depth = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') depth++; else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1); }
  return null;
}

ck('NEGATIVE CONTROL: the violation predicate flags the legacy card fixture',
   violations(LEGACY_CARD).length === 3, violations(LEGACY_CARD));

/* product cards */
ck('compact-grid.css: phones get 3 product cards per row (home / category / shop grids)',
   /@media \(max-width: 600px\)\s*\{[^}]*html body #productsContainer[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\) !important/.test(CSS)
   && /html body \.st-products-grid \{ grid-template-columns: repeat\(3/.test(CSS)
   && /html body \.cat-premium-grid \{ grid-template-columns: repeat\(3/.test(CSS));
ck('compact-grid.css: icons keep a ≥44px tap target and the shop-logo ring keeps its corner',
   /\.pcard-ico::before\s*\{[^}]*inset:\s*-7px/.test(CSS) && /\.product-card \.pcard-shop-ring \{[^}]*top: 7px !important/.test(CSS));
const bpc = fnBody(SC, 'buildProductCard') || '';
ck('script.js buildProductCard: ❤ and 🛒/📩 icons, shop ring kept, no labelled row, no WhatsApp',
   /pcard-ico--wish/.test(bpc) && /pcard-ico--cart/.test(bpc) && /\$\{shopRing\}/.test(bpc) && /'📩' : '🛒'/.test(bpc)
   && violations(bpc).length === 0, violations(bpc));
const catr = fnBody(CAT, 'renderProducts') || '';
ck('category.js renderProducts: icons, shop ring, no labelled row, no WhatsApp',
   /pcard-ico pcard-ico--wish/.test(catr) && /pcard-ico pcard-ico--cart/.test(catr) && /\$\{cShopRing\}/.test(catr) && violations(catr).length === 0, violations(catr));
const st = fnBody(STORE, 'stActionRows') || '';
ck('store.html stActionRows: icons outside the product link, no Buy control, no WhatsApp',
   /pcard-ico--wish/.test(st) && /pcard-ico--cart/.test(st) && !/data-st-buy/.test(st) && violations(st).length === 0
   && (STORE.match(/<\/a>' \+ stActionRows\(|<\/a>\s*\n\s*\$\{stActionRows\(/g) || []).length === 3);
ck('one chips source (sokoni-card-chips.js) loaded by index, category and store; KEBS text escaped there',
   /sokoni-card-chips\.js/.test(IDX) && /sokoni-card-chips\.js/.test(CATH) && /sokoni-card-chips\.js/.test(STORE)
   && /title="KEBS Certified: ' \+ esc\(product\.kebsCert\)/.test(CHIPS));
ck('sokoni-card-chips.js: unknown stock renders no chip; promotion chips come only from the server read',
   /if \(!product \|\| product\.stock === undefined \|\| product\.stock === null \|\| product\.stock === ''\) return '';/.test(CHIPS)
   && /sokoniCallable\('miniShopGetPromotions'\)/.test(CHIPS) && /return Promise\.resolve\(null\)/.test(CHIPS));
/* minishop */
const msc = fnBody(MS, '_productCard') || (MS.match(/return `<div class="ms-product-card"[\s\S]*?<\/div>`;/) || [''])[0];
ck('sokoni-minishop.js: ❤ and 🛒 icons on the photo, no "Add to cart" label; minishop.css 3 per row on phones',
   /ms-wishlist-btn/.test(msc) && /ms-add-btn/.test(msc) && !/Add to cart<\/button>/.test(msc) && violations(msc).length === 0
   && /@media \(max-width: 479px\)\s*\{\s*\.ms-product-grid \{ grid-template-columns: repeat\(3/.test(MSCSS));
/* business page */
const bizc = fnBody(BIZ, 'productCardHtml') || '';
ck('business.html productCardHtml: 🛒 icon outside the link, id-only data attribute, no JSON in onclick, no WhatsApp',
   /biz-photo-icons/.test(bizc) && /data-biz-cart="\$\{escHtml\(String\(p\.id\)\)\}"/.test(bizc) && !/JSON\.stringify/.test(bizc)
   && violations(bizc).length === 0 && /\.biz-products-grid \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\) !important/.test(BIZ));
ck('business.html: one delegated listener adds to cart from the product index',
   /closest\('\[data-biz-cart\]'\)/.test(BIZ) && /_bizCardIndex\.get\(id\)/.test(BIZ) && /window\.bizAddToCart\(id, p\.name, p\.price, p\.image\)/.test(BIZ));
/* provider cards */
const pg = fnBody(PROV, 'renderGrid') || '', sv = fnBody(SVC, 'renderProviders') || '', cl = fnBody(CLEAN, 'renderProviders') || '';
ck('providers.html renderGrid: 💬 + 📩 icons, data-profile-href, no wa.me, no phone read, no follow/labelled row',
   /pv-ico--msg[^>]*>💬</.test(pg) && /pv-ico--book[^>]*>📩</.test(pg) && /data-profile-href="' \+ esc\(p\.profileUrl\)/.test(pg)
   && !/p\.phone/.test(pg) && !/pvFollow-/.test(pg) && violations(pg).length === 0, violations(pg));
ck('services.html renderProviders: 💬 + 📩 icons, data-profile-href, no labelled footer, no wa.me',
   /pv-ico--msg[^>]*>💬</.test(sv) && /pv-ico--book[^>]*>📩</.test(sv) && /data-profile-href="\$\{esc\(p\.profileUrl\)\}"/.test(sv)
   && !/pv-foot/.test(sv) && violations(sv).length === 0, violations(sv));
ck('cleaning.html renderProviders: 💬 + 📩 icons, no wa.me, no follow/share row',
   /cl-ico--msg[^>]*>💬</.test(cl) && /cl-ico--book[^>]*>📩</.test(cl) && !/toggleFollow/.test(cl) && violations(cl).length === 0, violations(cl));
ck('providers / services / cleaning: the whole card opens the profile through ONE delegated listener reading an escaped data attribute',
   [PROV, SVC, CLEAN].every((s) => /closest\('\.(pv|cl-provider)-card\[data-profile-href\]'\)/.test(s) && /getAttribute\('data-profile-href'\)/.test(s)));
Object.keys(PG).forEach((f) => {
  const body = fnBody(PG[f], f === 'car-rental.html' ? 'renderCars' : 'renderProviders') || '';
  ck(f + ': card action is the 📩 icon (same openBookingFor handler), no WhatsApp, no follow/share row',
     /class="pg-ico"[^>]*>📩</.test(body)
     /* the same openBookingFor handler: inline, or (plumbing.html, 2026-10-03) one delegated listener reading the
        escaped data-pg-book attribute — no provider value is interpolated into inline JS */
     && (/openBookingFor\(/.test(body) || (/data-pg-book="/.test(body) && /openBookingFor\(book\.getAttribute\('data-pg-book'\)/.test(PG[f])))
     && !/toggleFollow/.test(body) && violations(body).length === 0, violations(body));
});
/* shop cards */
const nearby = fnBody(SC, 'displayNearbySection') || '', featured = fnBody(SC, 'displayFeaturedShops') || '';
ck('script.js nearby + featured shop cards: one 🏪 icon, escaped name, no URL in an inline onclick',
   /seller-visit-ico[^>]*>🏪</.test(nearby) && /<h3>\$\{_escHtml\(s\.name\)\}<\/h3>/.test(nearby) && !/onclick="window\.location\.href=/.test(nearby)
   && /data-store-url="\$\{_escHtml\(profileUrl\)\}"/.test(nearby)
   && /seller-visit-ico fs-visit-btn[^>]*>🏪</.test(featured) && /<h3>\$\{_escHtml\(f\.storeName\)\}<\/h3>/.test(featured)
   && violations(nearby).length === 0 && violations(featured).length === 0);
ck('script.js nearby grid: the store URL is followed only through the http(s) / root / seller-public allow-list',
   /\/\^\(https\?:\\\/\\\/\|\\\/\|seller-public\\\.html\)\/i\.test\(url\)/.test(nearby));
ck('sokoni-spotlight.js + the three static spotlight cards in index.html: one 🏪 icon each, no Follow / share row',
   /seller-visit-ico[^>]*>🏪</.test(SPOT) && !/seller-follow-row/.test(SPOT)
   && (IDX.match(/class="seller-visit-ico" aria-label="Visit [^"]+ storefront"/g) || []).length === 3 && !/seller-follow-row/.test(IDX));
ck('CONTROL the stylesheet still balances', (CSS.match(/\{/g) || []).length === (CSS.match(/\}/g) || []).length);

/* ── 2 · BROWSER ─────────────────────────────────────────────────────────────── */
function finish(partial) {
  say('\nRESULT');
  if (partial) {
    say('  PARTIAL — static section only: ' + pass + ' passed, ' + fail + ' failed; browser section NOT RUN (unproven)');
    process.exit(fail ? 1 : 3);
  }
  say('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
if (STATIC_ONLY) finish(true);

(async () => {
  say('\n── 2 · browser (Chromium, 390px, hermetic page harness) ──');
  const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
  const { makePageHarness } = require('./lib/page-harness.js');
  const F = makeFakeFirestore({ clock: () => Date.now() }); const db = F.db;
  const T0 = 1790000000000;
  const TRICKY = 'Zq\'s "Best" <b>Shop</b>';
  const P = (id, o) => Object.assign({ id, name: 'Product ' + id, price: 1000, category: 'electronics', sellerUid: 'seller1', sellerName: TRICKY,
    shopId: 'shop1', businessId: 'biz1', image: '', stock: 10, sold: 0, status: 'active', uploadedAt: T0 + Number(id.replace(/\D/g, '')) * 1000, location: 'nairobi' }, o);
  const seed = [P('p1', { name: TRICKY + ' tee' }), P('p2', { stock: 3 }), P('p3', { kebsCert: 'KEBS/"1"<x>' }), P('p4'), P('p5'), P('p6'), P('p7'), P('p8'), P('p9')];
  for (const p of seed) await db.doc('products/' + p.id).set(p);
  await db.doc('businesses/biz1').set({ name: 'Biz One', ownerUid: 'owner1', phone: '0712345678', category: 'retail', createdAt: T0 });
  const PR = (id, o) => Object.assign({ uid: id, name: 'Provider ' + id, status: 'active', category: 'cleaning', categories: ['cleaning'], phone: '0712345678',
    skills: ['Deep clean'], rate: 1500, rateType: 'per job', verified: true, available: true, updatedAt: T0, location: 'Nairobi' }, o);
  const provs = [PR('pr1', { name: 'Ann O\'Brien <b>x</b>' }), PR('pr2', { category: 'plumbing', categories: ['plumbing'] }), PR('pr3', { verified: false })];
  for (const p of provs) await db.doc('providers/' + p.uid).set(p);

  /* Negative control page: the legacy card fixture served as a page of its own. */
  const LEGACY_PAGE = '<!doctype html><html><head><meta charset="utf-8"><style>.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}.product-card{height:120px;background:#ddd}</style></head>'
    + '<body><div class="grid" id="legacyGrid">' + '<div class="product-card"><div class="pcard-actions"><button>🛒 Add</button><button>⚡ Buy Now</button></div></div>'.repeat(4)
    + '<div class="pv-card"><a href="https://wa.me/254700000000?text=hi" class="pv-btn-wa">💬 WA</a></div></div><div style="width:1200px;height:2px"></div></body></html>';

  const H = makePageHarness({ db, root: ROOT, pages: { '/legacy-cards.html': LEGACY_PAGE } });
  await H.start();
  const { chromium } = require(Path.join(ROOT, 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  const open = async (path, storage) => {
    const page = await H.page(browser, { viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(60000); page.setDefaultNavigationTimeout(60000);
    if (storage) await page.__ctx.addInitScript((st) => { Object.keys(st).forEach((k) => { try { localStorage.setItem(k, st[k]); } catch (_) {} }); }, storage);
    await page.goto(H.BASE + path, { waitUntil: 'domcontentloaded' });
    return page;
  };
  const rowsOf = (sel) => `(function(){ const els = Array.from(document.querySelectorAll(${JSON.stringify(sel)})).filter(e => e.getBoundingClientRect().width > 0);
      if (els.length < 4) return { n: els.length, perRow: null };
      const top0 = Math.round(els[0].getBoundingClientRect().top); let perRow = 0;
      for (const e of els) { if (Math.abs(Math.round(e.getBoundingClientRect().top) - top0) <= 2) perRow++; else break; }
      return { n: els.length, perRow }; })()`;
  const overflow = () => `(function(){ return { sw: document.documentElement.scrollWidth, iw: window.innerWidth }; })()`;
  const noOverflow = (o) => o.sw <= o.iw + 1;

  /* NEGATIVE CONTROL — the detector must see the legacy design */
  {
    const page = await open('/legacy-cards.html');
    const r = await page.evaluate(rowsOf('#legacyGrid .product-card'));
    const html = await page.evaluate(() => document.getElementById('legacyGrid').innerHTML);
    const o = await page.evaluate(overflow());
    ck('NEGATIVE CONTROL: legacy page — 2 per row is NOT 3, wa.me + labelled rows ARE flagged, overflow IS detected',
       r.perRow === 2 && violations(html).length === 3 && !noOverflow(o), { r, v: violations(html), o });
    await page.__ctx.close();
  }

  /* HOME */
  {
    const page = await open('/index.html', { sokoniBuyerCity: 'nairobi', sokoniNotifDismissed: 'permanent' });
    await page.waitForFunction(() => document.querySelectorAll('#productsContainer .product-card').length >= 4).catch(() => {});
    await page.waitForTimeout(1200);
    const r = await page.evaluate(rowsOf('#productsContainer .product-card'));
    ck('home: 3 product cards per row at 390px', r.perRow === 3, r);
    const cards = await page.evaluate(() => Array.from(document.querySelectorAll('#productsContainer .product-card')).slice(0, 9).map((c) => ({
      wish: (c.querySelector('.pcard-ico--wish') || {}).textContent, cart: (c.querySelector('.pcard-ico--cart') || {}).textContent,
      ring: !!c.querySelector('.pcard-shop-ring'), wishName: (c.querySelector('.pcard-ico--wish') || { getAttribute: () => '' }).getAttribute('aria-label'),
      labelled: Array.from(c.querySelectorAll('button,a')).filter((b) => b.getBoundingClientRect().width > 0 && /buy|add to|share|offer|book/i.test(b.textContent)).length,
      injected: !!c.querySelector('.product-name b, .pcard-ov-name b'), html: c.outerHTML })));
    ck('home: every card carries ❤ and 🛒 as icons and keeps the shop logo ring', cards.length >= 4 && cards.every((c) => c.wish && c.wish.trim() === '❤' && c.cart && c.cart.trim() === '🛒' && c.ring), cards.map((c) => [c.wish, c.cart, c.ring]));
    ck('home: no labelled Buy / Add / Share / Offer control is visible on any card', cards.every((c) => c.labelled === 0), cards.map((c) => c.labelled));
    ck('home: no wa.me / whatsapp anywhere in the product-card markup', cards.every((c) => !WA_RE.test(c.html)));
    ck('home: the tricky seller name renders as text (no injected <b>) and the icon has an accessible name', cards.every((c) => !c.injected) && /Save .+ to wishlist/.test(cards[0].wishName), cards[0].wishName);
    const chips = await page.evaluate(() => ({ low: !!document.querySelector('#productsContainer .product-card[data-pid="p2"] .pcard-stock--low'), kebs: (document.querySelector('#productsContainer .product-card[data-pid="p3"] .kebs-badge') || { getAttribute: () => '' }).getAttribute('title') }));
    ck('home: the ⚡ Only 3 left chip appears for p2 and the KEBS chip title is the escaped certificate text', chips.low && chips.kebs === 'KEBS Certified: KEBS/"1"<x>', chips);
    const shops = await page.evaluate(() => {
      const spot = Array.from(document.querySelectorAll('.seller-card .seller-visit-ico')).map((a) => a.textContent.trim());
      const near = Array.from(document.querySelectorAll('#nearbyGrid .seller-card'));
      return { spotIcons: spot, spotFollow: document.querySelectorAll('.seller-card .seller-follow-row').length,
        nearN: near.length, nearIcons: near.map((c) => (c.querySelector('.seller-visit-ico') || {}).textContent), nearOnclick: near.filter((c) => c.hasAttribute('onclick')).length,
        nearInjected: near.filter((c) => c.querySelector('h3 b')).length, nearHtml: near.map((c) => c.outerHTML).join('') };
    });
    ck('home: spotlight shop cards carry one 🏪 icon each and no Follow / share row', shops.spotIcons.length >= 3 && shops.spotIcons.every((t) => t === '🏪') && shops.spotFollow === 0, shops.spotIcons);
    ck('home: "Sellers Near You" cards — 🏪 icon, escaped name, no inline-onclick URL, no WhatsApp', shops.nearN >= 1 && shops.nearIcons.every((t) => t && t.trim() === '🏪') && shops.nearOnclick === 0 && shops.nearInjected === 0 && !WA_RE.test(shops.nearHtml), { n: shops.nearN, icons: shops.nearIcons, onclick: shops.nearOnclick });
    const o = await page.evaluate(overflow());
    ck('home: no horizontal overflow at 390px', noOverflow(o), o);
    /* a real tap on 🛒 reaches the cart and does not navigate */
    await page.locator('#productsContainer .product-card[data-pid="p4"] .pcard-ico--cart').first().scrollIntoViewIfNeeded().catch(() => {});
    await page.locator('#productsContainer .product-card[data-pid="p4"] .pcard-ico--cart').first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);
    const cart = await page.evaluate(() => { const c = window.SokoniCart; return { url: location.pathname, n: c && c.lines ? c.lines() : -1, ids: c && c.list ? c.list().map((i) => i.id) : null }; });
    ck('home: tapping 🛒 adds one line to SokoniCart and stays on the page', cart.n === 1 && /index\.html$|\/$/.test(cart.url), cart);
    await page.__ctx.close();
  }

  /* BUSINESS */
  {
    const page = await open('/business.html?id=biz1', { sokoniNotifDismissed: 'permanent' });
    await page.waitForFunction(() => document.querySelectorAll('#prodGrid .biz-product-card').length >= 4).catch(() => {});
    await page.waitForTimeout(800);
    const r = await page.evaluate(rowsOf('#prodGrid .biz-product-card'));
    ck('business: 3 product cards per row at 390px', r.perRow === 3, r);
    const cards = await page.evaluate(() => Array.from(document.querySelectorAll('#prodGrid .biz-product-card')).map((c) => ({
      ico: (c.querySelector('.biz-photo-icons .biz-ico') || {}).textContent, name: (c.querySelector('.biz-ico') || { getAttribute: () => '' }).getAttribute('aria-label'),
      inLink: !!c.querySelector('a .biz-ico'), injected: !!c.querySelector('.biz-product-name b'), html: c.outerHTML })));
    ck('business: every card has the 🛒 icon outside the product link, with an accessible name', cards.length >= 4 && cards.every((c) => c.ico && c.ico.trim() === '🛒' && !c.inLink && /^Add .+ to cart$/.test(c.name)), cards.slice(0, 2));
    ck('business: no wa.me / whatsapp in product-card markup; tricky name rendered as text', cards.every((c) => !WA_RE.test(c.html) && !c.injected));
    const before = await page.evaluate(() => location.href);
    await page.locator('#prodGrid .biz-product-card[data-cat] .biz-ico').first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => { const c = window.SokoniCart; return { url: location.href, n: c && c.lines ? c.lines() : -1, ids: c && c.list ? c.list().map((i) => i.id) : null }; });
    ck('business: a real tap on 🛒 adds one line to SokoniCart and does not navigate', after.n === 1 && after.url === before, after);
    const o = await page.evaluate(overflow());
    ck('business: no horizontal overflow at 390px', noOverflow(o), o);
    const svcWa = await page.evaluate(() => Array.from(document.querySelectorAll('.biz-service-card')).some((c) => /wa\.me/i.test(c.outerHTML)));
    say('  NOTE  business: service cards (serviceCardHtml) are NOT part of this port — pre-existing wa.me "Book Now" ' + (svcWa ? 'RENDERED' : 'not rendered (no services seeded)') + '; flagged in CHANGELOG, not asserted here');
    await page.__ctx.close();
  }

  /* PROVIDERS */
  {
    const page = await open('/providers.html', { sokoniNotifDismissed: 'permanent' });
    await page.waitForFunction(() => document.querySelectorAll('#pvGrid .pv-card').length >= 1).catch(() => {});
    await page.waitForTimeout(800);
    const cards = await page.evaluate(() => Array.from(document.querySelectorAll('#pvGrid .pv-card')).map((c) => ({
      msg: (c.querySelector('.pv-ico--msg') || {}).textContent, book: (c.querySelector('.pv-ico--book') || {}).textContent,
      href: c.getAttribute('data-profile-href'), injected: !!c.querySelector('.pv-name b, b'),
      labelled: Array.from(c.querySelectorAll('button,a')).filter((b) => b.getBoundingClientRect().width > 0 && /view|book|follow|wa\b/i.test(b.textContent)).length,
      html: c.outerHTML })));
    ck('providers: every card carries 💬 and 📩 icons and a data-profile-href', cards.length === 3 && cards.every((c) => c.msg && c.msg.trim() === '💬' && c.book && c.book.trim() === '📩' && /^provider-profile\.html\?uid=/.test(c.href)), cards.map((c) => [c.msg, c.book, c.href]));
    ck('providers: no wa.me / whatsapp in card markup although every provider has a phone number; no labelled controls', cards.every((c) => !WA_RE.test(c.html) && c.labelled === 0), cards.map((c) => c.labelled));
    ck('providers: the tricky name renders as text (no injected <b>)', cards.every((c) => !c.injected));
    const o = await page.evaluate(overflow());
    ck('providers: no horizontal overflow at 390px', noOverflow(o), o);
    await page.locator('#pvGrid .pv-card .pv-name').first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(800);
    const url = await page.evaluate(() => location.pathname + location.search);
    ck('providers: tapping the card body opens the provider profile', /provider-profile\.html\?uid=pr/.test(url), url);
    await page.__ctx.close();
  }

  /* SERVICES */
  {
    const page = await open('/services.html', { sokoniNotifDismissed: 'permanent' });
    await page.waitForFunction(() => document.querySelectorAll('#providersGrid .pv-card').length >= 1).catch(() => {});
    await page.waitForTimeout(800);
    const cards = await page.evaluate(() => Array.from(document.querySelectorAll('#providersGrid .pv-card')).map((c) => ({
      msg: (c.querySelector('.pv-ico--msg') || {}).textContent, book: (c.querySelector('.pv-ico--book') || {}).textContent,
      href: c.getAttribute('data-profile-href'), foot: !!c.querySelector('.pv-foot'), injected: !!c.querySelector('b'), html: c.outerHTML })));
    ck('services: every provider card carries 💬 and 📩 icons, a data-profile-href and no labelled footer', cards.length === 3 && cards.every((c) => c.msg && c.msg.trim() === '💬' && c.book && c.book.trim() === '📩' && /^provider-profile\.html\?uid=/.test(c.href) && !c.foot), cards.map((c) => [c.msg, c.book, c.foot]));
    ck('services: no wa.me / whatsapp in card markup; tricky name rendered as text', cards.every((c) => !WA_RE.test(c.html) && !c.injected));
    const o = await page.evaluate(overflow());
    ck('services: no horizontal overflow at 390px', noOverflow(o), o);
    await page.__ctx.close();
  }

  await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  H.stop();
  finish(false);
})().catch((e) => { say('  FAIL  browser section crashed   [' + String(e && e.message || e).slice(0, 300) + ']'); fail++; finish(false); });
