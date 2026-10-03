#!/usr/bin/env node
/**
 * test-copied-image-placeholders.js  (static, no browser, no network)
 *
 * When moderation holds a product, its photo files go private and the
 * download token is withdrawn. Orders, invoices, checkout summaries and the
 * POS customer display COPY the product image URL at sale/cart time, so those
 * copied URLs 404 while the product is held. Every renderer of a copied URL
 * must show the neutral placeholder (assets/default-product.png), never a
 * broken-image icon, never a hidden gap, never explanatory text, and must
 * not loop if the placeholder itself fails (this.onerror=null).
 *
 * Sections:
 *   A. Each registered site carries the exact fallback.
 *   B. Census: every <img> in the registered files whose src is interpolated
 *      from a record (${...}) is a registered site (nothing unregistered).
 *   C. Negative control: strip one fallback in memory -> checker fails and
 *      names the site.
 *   D. invoice.html XSS row: an image value `x" onerror="window.__pwn=1`
 *      must not create an attribute (template evaluated in a vm sandbox).
 *
 * Exit 0 = all pass, 1 = any failure.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const FALLBACK = `onerror="this.onerror=null;this.src='assets/default-product.png'"`;

/* Registered sites: file + a unique marker that locates the <img> line. */
const SITES = [
  { file: 'cart.js',               marker: 'class="cart-card-img"',            what: 'cart page item (cart snapshot)' },
  { file: 'checkout.html',         marker: 'src="${safeImg}"',                 what: 'checkout order summary item' },
  { file: 'invoice.html',          marker: 'class="inv-item-img"',             what: 'invoice order item' },
  { file: 'customer-display.html', marker: 'src="${_esc(item.image)}"',        what: 'POS customer display cart item' },
];

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  PASS ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* Returns [] if the site is good, else a list of problems naming the site. */
function checkSite(src, site) {
  const lines = src.split(/\r?\n/);
  const hits = [];
  lines.forEach((l, i) => { if (l.includes(site.marker) && /<img\b/.test(l)) hits.push(i); });
  if (hits.length !== 1) return [`${site.file}: marker ${site.marker} matched ${hits.length} <img> lines (expected 1)`];
  const line = lines[hits[0]];
  const where = `${site.file}:${hits[0] + 1} (${site.what})`;
  const probs = [];
  if (!line.includes(FALLBACK)) probs.push(`${where} missing placeholder fallback`);
  if (/onerror="[^"]*display\s*=\s*'none'/.test(line)) probs.push(`${where} hides the image on error`);
  return probs;
}

console.log('A. registered sites carry the placeholder fallback');
const sources = {};
for (const s of SITES) {
  sources[s.file] = sources[s.file] || read(s.file);
  const probs = checkSite(sources[s.file], s);
  ok(probs.length === 0, `${s.file} [${s.what}]` + (probs.length ? ' :: ' + probs.join('; ') : ''));
}

console.log('B. census: every record-interpolated <img> in these files is registered');
for (const file of Object.keys(sources)) {
  const lines = sources[file].split(/\r?\n/);
  lines.forEach((l, i) => {
    if (!/<img\b[^>]*\bsrc="\$\{/.test(l)) return;
    const reg = SITES.find(s => s.file === file && l.includes(s.marker));
    ok(!!reg, `${file}:${i + 1} interpolated <img> is a registered site`);
    if (!reg) console.log('      line: ' + l.trim().slice(0, 160));
  });
}

console.log('C. negative control: stripping one fallback is detected and named');
{
  const victim = SITES.find(s => s.file === 'invoice.html');
  const mutated = sources[victim.file].replace(FALLBACK, `onerror="this.style.display='none'"`);
  ok(mutated !== sources[victim.file], 'mutation applied');
  const probs = checkSite(mutated, victim);
  ok(probs.length > 0 && probs.some(p => p.startsWith('invoice.html:') && p.includes('invoice order item')),
     'checker FAILS on stripped fallback and names the site :: ' + (probs[0] || '(no problem reported!)'));
  const victim2 = SITES.find(s => s.file === 'checkout.html');
  const mutated2 = sources[victim2.file].replace(FALLBACK, `onerror="this.src='assets/default-product.png'"`);
  const probs2 = checkSite(mutated2, victim2);
  ok(probs2.length > 0 && probs2[0].startsWith('checkout.html:'),
     'checker FAILS when onerror=null loop guard is removed :: ' + (probs2[0] || '(no problem reported!)'));
}

console.log('D. invoice.html XSS row');
{
  const src = sources['invoice.html'];
  const esc = src.match(/const _invEsc = [^\n]+/);
  const img = src.match(/const _invImg = [^\n]+/);
  const tpl = src.match(/items\.map\(\(p,i\)=>`([\s\S]*?)`\)\.join\(""\)/);
  ok(!!(esc && img && tpl), 'helpers and item template located');
  if (esc && img && tpl) {
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(esc[0] + ';' + img[0] + ';this._invEsc=_invEsc;this._invImg=_invImg;', ctx);
    const render = new vm.Script('(p,i)=>`' + tpl[1] + '`').runInContext(ctx);
    const evil = 'x" onerror="window.__pwn=1';
    const evilHttp = 'https://e.x/a.png" onerror="window.__pwn=1';
    for (const [label, val] of [['bare payload', evil], ['https payload', evilHttp]]) {
      const html = render({ image: val, name: '<b>n</b>', category: 'c', price: 1 }, 0);
      const imgTag = (html.match(/<img\b[^>]*>/) || [''])[0];
      /* Parse real attributes (name="value" pairs, quote-delimited) — escaped
         text inside a value (&quot; onerror=&quot;...) is inert and not an attribute. */
      const attrs = [...imgTag.replace(/^<img\b|\/?>$/g, '').matchAll(/\s*([^\s="]+)="([^"]*)"/g)].map(m => m[1]);
      const onerrors = attrs.filter(a => a.toLowerCase() === 'onerror').length;
      ok(onerrors === 1 && !/onerror="window/.test(imgTag),
         `${label}: no injected attribute (onerror attrs=${onerrors}) :: ${imgTag.slice(0, 140)}`);
      ok(!/<b>/.test(html), `${label}: item name is escaped`);
    }
    const js = render({ image: 'javascript:alert(1)', name: 'n', price: 1 }, 0);
    ok(/src="assets\/default-product\.png"/.test(js), 'javascript: scheme is replaced by the placeholder');
    const good = render({ image: 'https://firebasestorage.googleapis.com/v0/b/x/o/a.png?alt=media&token=t', name: 'n', price: 1 }, 0);
    ok(/src="https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/x\/o\/a\.png\?alt=media&amp;token=t"/.test(good),
       'legitimate https storage URL is preserved (entity-escaped)');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
