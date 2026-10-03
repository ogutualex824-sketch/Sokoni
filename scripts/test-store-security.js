#!/usr/bin/env node
/* SECURITY 2026-10-03 — store.html: drafts never render; stored / reflected script injection renders inert.
 *   node scripts/test-store-security.js          BASE=72dca56 node scripts/test-store-security.js (live — must FAIL)
 *
 * Executes the page's REAL inline script (the one that renders the shop) in a vm, with the REAL sokoni-sellability.js,
 * a minimal DOM that records every HTML string the page writes, localStorage seeded with malicious data (as category.js
 * fills it from OTHER sellers' products), and a fake Firestore whose shop/product documents carry the same payloads.
 * Only the two dynamic `import("https://www.gstatic.com/…")` calls are substituted. Every captured HTML string is then
 * PARSED (tags + attributes) — the check is "no executable markup", not a string search for a payload. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'ignore'] }) : fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 260) + ']')); ok ? pass++ : fail++; };
console.log('\nstore.html security   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');

const HTML = read('store.html');
const SELL = fs.readFileSync(path.join(ROOT, 'sokoni-sellability.js'), 'utf8');   /* the module itself is not under test */
const blocks = []; HTML.replace(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g, (_, a, b) => { if (!/module|ld\+json/.test(a)) blocks.push(b); });
const PAGE = blocks.find((b) => /stProductsGrid/.test(b) && /getDocs/.test(b));
if (!PAGE) { console.log('CRASH (no verdict): shop render script not found'); process.exit(2); }
const loadsSellability = /<script src="sokoni-sellability\.js"><\/script>/.test(HTML);

/* payloads */
const XSS = {
  tag: '<img src=x onerror=alert(1)>',
  attr: '" onerror="alert(2)" x="',
  svg: '<svg/onload=alert(3)>',
  js: 'javascript:alert(4)',
  enc: '&lt;script&gt;alert(5)&lt;/script&gt;',
};
const S1 = 'S1sellerUid0000000';
const lsProducts = [
  { id: 'L1', sellerUid: S1, name: 'Good item ' + XSS.tag, price: 100, image: XSS.js, wholesalePrice: 90, minWholesaleQty: '<b onmouseover=alert(6)>', status: 'active' },
  { id: 'L2"><svg onload=alert(7)>', sellerUid: S1, name: 'DRAFT-LS-SECRET', price: 50, status: 'draft' },
  { id: 'L3', sellerUid: S1, name: 'Archived-LS-SECRET', price: 50, status: 'archived', isVisible: false },
];
const store = { name: 'Shop ' + XSS.svg, logo: XSS.attr, phone: '0700"><script>alert(8)</script>', email: 'a@b.c"><img src=x onerror=alert(9)>', instagram: '@ig"><svg onload=alert(10)>', website: XSS.js, ownerName: 'Owner' };
const ratings = { Owner: [{ buyerName: XSS.tag, date: XSS.svg, orderId: XSS.attr, comment: XSS.tag + XSS.enc, stars: 5, avgScore: 5, delivery: '<i onclick=alert(11)>x</i>' }] };
const fsShop = { name: 'FS Shop', logo: XSS.attr, businessHours: { mon: '<img src=x onerror=alert(12)>' } };
const fsProducts = [
  { id: 'F1', data: { sellerUid: S1, name: 'Published FS ' + XSS.tag, price: 200, image: 'https://img.example/a.jpg"><script>alert(13)</script>', category: XSS.svg, status: 'active' } },
  { id: 'F2', data: { sellerUid: S1, name: 'DRAFT-FS-SECRET', price: 10, status: 'draft' } },
  { id: 'F3', data: { sellerUid: S1, name: 'REMOVED-FS-SECRET', price: 10, status: 'removed' } },
  { id: 'F4', data: { sellerUid: S1, name: 'Legacy no-status FS item', price: 30 } },
];

/* minimal DOM that records HTML */
const writes = [];
function el(id) {
  let _h = '';
  return { id, style: {}, dataset: {}, children: [], textContent: '', src: '', value: '', classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    get innerHTML() { return _h; }, set innerHTML(v) { _h = String(v); writes.push({ id, html: _h }); },
    setAttribute() {}, getAttribute: () => null, appendChild() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], insertAdjacentHTML(_, v) { _h += v; writes.push({ id, html: v }); }, closest: () => null };
}
const els = {};
const ls = { sellerProducts: JSON.stringify(lsProducts), sokoniMiniStore: JSON.stringify(store), sokoniSellerRatings: JSON.stringify(ratings) };
const ctx = {
  console: { log() {}, warn() {}, error() {} }, Promise, JSON, Object, Array, String, Number, Math, Date, RegExp, Error, URLSearchParams, encodeURIComponent, decodeURIComponent, isFinite, parseInt, parseFloat, setTimeout: (f) => { try { f(); } catch (_) {} return 0; }, clearTimeout() {},
  localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem() {}, removeItem() {} },
  location: { search: '?id=' + S1, pathname: '/store.html', href: 'https://mysokoni.co.ke/store.html?id=' + S1 },
  document: { title: '', getElementById: (id) => (els[id] = els[id] || el(id)), querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => el('x'), body: el('body'), readyState: 'complete' },
  navigator: { share: null, clipboard: null },
  name: '',   /* window.name exists in every browser; the live page reads it by accident (stActionRows(p.id, name)) */
  fetch: async () => ({ ok: false, json: async () => ({}) }),
  __imp: async (what) => what === 'app'
    ? { initializeApp: () => ({}), getApps: () => [{}] }
    : { getFirestore: () => ({}), doc: (_db, c, id) => ({ c, id }), getDoc: async (r) => (r.c === 'shops' && r.id === S1 ? { exists: () => true, data: () => fsShop } : { exists: () => false, data: () => ({}) }),
        collection: (_db, c) => ({ c }), where: (...a) => a, query: (c, ...w) => ({ c, w }), getDocs: async () => ({ empty: !fsProducts.length, forEach: (fn) => fsProducts.forEach((p) => fn({ id: p.id, data: () => p.data })) }) },
};
ctx.window = ctx; ctx.globalThis = ctx; ctx.self = ctx;
vm.createContext(ctx);
const src = PAGE.replace(/await import\("https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-app\.js"\)/g, 'await __imp("app")')
                .replace(/await import\("https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-firestore\.js"\)/g, 'await __imp("fs")');

(async () => {
  try {
    if (loadsSellability) vm.runInContext(SELL, ctx);
    /* every classic inline block, in page order (stActionRows lives in an earlier one) */
    for (const b of blocks) vm.runInContext(b === PAGE ? src : b, ctx);
  } catch (e) { console.log('CRASH (no verdict): ' + e.message); process.exit(2); }
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));

  /* PARSE every captured HTML write: tags and attributes */
  const ALLOWED_ON = new Set([`this.onerror=null;this.src='assets/default-product.png'`, `this.src='assets/default-product.png'`, `this.src=\\'assets/default-product.png\\'`]);
  const bad = [];
  for (const w of writes) {
    /* browser tokenizer semantics: a tag runs to the first '>' outside quotes, and '/' separates attributes exactly
       like whitespace (so <svg/onload=…> is an svg tag with an onload attribute) */
    const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
    let m;
    while ((m = tagRe.exec(w.html))) {
      const tag = m[1].toLowerCase();
      if (['script', 'svg', 'iframe', 'object', 'embed'].includes(tag)) bad.push(w.id + ': <' + tag + '>');
      const attrRe = /([^\s=>\/]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g; let a;
      m[2] = m[2].replace(/("[^"]*"|'[^']*')|\//g, (mm, q) => (q ? q : ' '));   /* '/' separates attributes only OUTSIDE quotes */
      while ((a = attrRe.exec(m[2]))) {
        const name = a[1].toLowerCase(), val = (a[2] || '').replace(/^["']|["']$/g, '');
        /* the page's OWN fixed policy-tab handler (a constant key, never data) is allowed; every other on* is an injection */
        if (/^on/.test(name) && !ALLOWED_ON.has(val) && !/^stSwitchPolicy\('[a-z_]+',this\)$/.test(val)) bad.push(w.id + ': ' + tag + '[' + name + '="' + val.slice(0, 40) + '"]');
        if ((name === 'href' || name === 'src') && /^\s*(javascript|data|vbscript):/i.test(val)) bad.push(w.id + ': ' + tag + '[' + name + '=' + val.slice(0, 30) + ']');
      }
    }
  }
  const all = writes.map((w) => w.html).join('\n');
  ck('X-1', writes.length > 5 && bad.length === 0, 'no captured HTML contains an executable tag, an injected on* handler or a javascript:/data: URL', bad.slice(0, 8));
  ck('X-2', /Good item &lt;img src=x onerror=alert\(1\)&gt;/.test(all) && /Published FS &lt;img/.test(all), 'stored payloads in product names render as TEXT (escaped), from both localStorage and Firestore');
  ck('X-3', !/href="javascript:/i.test(all) && !/src="javascript:/i.test(all), 'a javascript: website / image URL never reaches an href or src');
  ck('D-1', !/DRAFT-LS-SECRET|DRAFT-FS-SECRET/.test(all), 'DRAFT products never render (localStorage or Firestore)');
  ck('D-2', !/Archived-LS-SECRET|REMOVED-FS-SECRET/.test(all), 'archived / removed products never render');
  ck('D-3', /Legacy no-status FS item/.test(all) && /Published FS/.test(all), 'CONTROL: published and legacy (no status) products still render');
  ck('D-4', loadsSellability, 'the page loads the canonical listing predicate (sokoni-sellability.js)');
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
