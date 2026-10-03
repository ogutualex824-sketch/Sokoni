#!/usr/bin/env node
/**
 * test-products-console.js — the ONE products page (sokoni-products-console.js) for AdminOS + Super Admin.
 * Runs the SHIPPED module against a minimal fake DOM and a fake server. Proves the data-integrity and
 * authority rules, not pixels:
 *   P1  tab counts are "—" unless the SERVER returns counts; server counts are shown verbatim
 *   P2  unknown stock renders "—" (never 0); Out of stock only for a real 0; Low stock only with the product's own threshold
 *   P3  every product field is escaped (no HTML injection from a seller-written name / category / sku)
 *   P4  a status action calls adminUpdateProductStatus and toasts success ONLY on {success:true}; a refusal → error, no success
 *   P5  Feature keeps the CURRENT status and is not offered when the status is unknown
 *   P6  CSV export neutralises formula injection (=, +, -, @)
 *   P7  margin only with a cost price; discount only when compare-at > price
 *   P8  the footer reports LOADED rows, never a catalogue total; the drawer shows only real channels
 *   P9  cancelling the confirm never reaches the server
 *   P10 AdminOS + Super Admin both mount this module (one component, no second copy)
 *   SABOTAGE=1 → counts default to the loaded-page length → P1 must FAIL
 */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
let SRC = fs.readFileSync(path.join(ROOT, 'sokoni-products-console.js'), 'utf8');
if (process.env.SABOTAGE === '1') SRC = SRC.replace("return v === null ? '—' : v.toLocaleString('en-KE');", "return v === null ? String(st.rows.length) : v.toLocaleString('en-KE');");
let pass = 0, fail = 0;
const ck = (id, ok, m, d) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (ok || d === undefined ? '' : '   [' + String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 220) + ']')); ok ? pass++ : fail++; };

function makeEnv() {
  const handlers = {};
  const root = { innerHTML: '', classList: { add() {} }, addEventListener: (ev, fn) => { handlers[ev] = fn; }, contains: () => true, querySelector: () => null };
  const head = { appendChild() {} };
  const document = { head, body: { appendChild() {} }, getElementById: () => null, createElement: () => ({ set textContent(v) {}, click() {}, remove() {} }) };
  const window = { confirm: () => true };
  const blobs = [];
  const sandbox = { window, document, Blob: function (parts) { blobs.push(parts.join('')); }, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, setTimeout: (f) => f(), clearTimeout() {}, console, Date, Math, Number, String, JSON, Object, Array, Set, Promise, Intl, isFinite, encodeURIComponent };
  new Function(...Object.keys(sandbox), SRC)(...Object.values(sandbox));
  return { SPC: window.SokoniProductsConsole, root, handlers, blobs };
}
const click = (h, dataset) => h.click({ stopPropagation() {}, target: { closest: () => ({ dataset, checked: dataset.__checked }) } });
const tick = () => new Promise((r) => setImmediate(r));

const PRODUCTS = [
  { id: 'p1', name: 'Wireless Headphones', sku: 'NX-WH-1000', category: 'Audio', stock: 320, lowStockThreshold: 20, price: 199, compareAtPrice: 220, costPrice: 76, status: 'active', variants: [{ name: 'Black' }, { name: 'White' }], updatedAt: Date.now() - 7200e3, createdAt: Date.now() - 864e5 * 30, sellerName: 'Nexora Audio' },
  { id: 'p2', name: 'Power Bank', sku: 'NX-PB', category: 'Accessories', stock: 0, price: 49, status: 'active', updatedAt: Date.now() - 3600e3 },
  { id: 'p3', name: 'Action Camera', category: 'Cameras', stock: 12, lowStockThreshold: 15, price: 349, status: 'active' },
  { id: 'p4', name: 'No-stock-field Lamp', category: 'Home', price: 80, status: 'draft' },
  { id: 'p5', name: '<img src=x onerror=alert(1)>', sku: '"><script>x</script>', category: '<b>c</b>', stock: 7, price: 10, status: 'pending' },
  { id: 'p6', name: '=HYPERLINK("http://evil")', category: 'Formula', stock: 3, price: 5, status: 'active' },
  { id: 'p7', name: 'Statusless thing', price: 1, stock: 1 },
];

(async () => {
  console.log('\nProducts console' + (process.env.SABOTAGE === '1' ? '  (SABOTAGE)' : '') + '\n');
  let calls = [], toasts = [], server = { products: PRODUCTS };
  let E = makeEnv();
  const callFn = async (op, d) => { calls.push({ op, d }); if (op === 'adminGetProducts') return server; if (op === 'adminUpdateProductStatus') return E.__upd ? E.__upd(d) : { success: true }; throw new Error('unknown op'); };
  E.SPC.mount(E.root, { call: callFn, toast: (m, k) => toasts.push({ m, k }), confirm: async () => true });
  await tick(); await tick();
  let html = E.root.innerHTML;
  const counts = [...html.matchAll(/class="spc-count[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1]);
  ck('P1a', counts.length === 7 && counts.every((c) => c === '—'), 'no server counts → every tab count is "—" (no page length posing as a catalogue total)', counts);
  server = { products: PRODUCTS, counts: { all: 1248, active: 1086, low: 23 } };
  E = makeEnv(); E.SPC.mount(E.root, { call: callFn, toast: () => {} }); await tick(); await tick();
  const counts2 = [...E.root.innerHTML.matchAll(/class="spc-count[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1]);
  ck('P1b', counts2[0] === '1,248' && counts2[1] === '1,086' && counts2[5] === '23' && counts2[2] === '—', 'server counts are shown verbatim; missing keys stay "—"', counts2);

  server = { products: PRODUCTS };
  E = makeEnv(); toasts = []; calls = [];
  const handle = E.SPC.mount(E.root, { call: callFn, toast: (m, k) => toasts.push({ m, k }), confirm: async () => true });
  await tick(); await tick(); html = E.root.innerHTML;
  const rowOf = (id) => (html.split('data-open="' + id + '"')[1] || '').split('</tr>')[0];
  ck('P2a', /Out of stock/.test(rowOf('p2')) && /<span style="color:var\(--spc-bad\);font-weight:600">0</.test(rowOf('p2')), 'a real stock of 0 → Out of stock');
  ck('P2b', /Low stock/.test(rowOf('p3')) && !/Low stock/.test(rowOf('p6')), 'Low stock only when the product has its OWN threshold (p3 12≤15); no threshold → never "low" (p6)');
  ck('P2c', /spc-meta">—</.test(rowOf('p4')) && !/>0</.test(rowOf('p4')), 'no stock field → "—", never 0');
  ck('P3', !/<img src=x onerror/.test(html) && !/<script>x<\/script>/.test(html) && !/<b>c<\/b>/.test(html) && /&lt;img src=x onerror=alert\(1\)&gt;/.test(html), 'seller-written name / sku / category are escaped');
  ck('P8a', /Showing 7 of 7 loaded/.test(html) && !/1,248|of 1248/.test(html), 'the footer reports loaded rows, never a catalogue total');

  click(E.handlers, { open: 'p1' }); html = E.root.innerHTML;
  ck('P7a', /62%/.test(html) && /10% OFF/.test(html) && /Compare at KES 220/.test(html), 'margin from price vs cost (199/76 → 62%), discount from compare-at (220 → 10% OFF)');
  ck('P8b', /SOKONI Marketplace/.test(html) && !/Amazon|eBay|Retail POS/.test(html), 'drawer channels: only the real SOKONI listing — no invented Amazon / eBay rows');
  click(E.handlers, { open: 'p2' }); html = E.root.innerHTML;
  ck('P7b', /No cost price recorded/.test(html) && /Margin<\/small><div class="spc-big">—/.test(html) && !/% OFF/.test(html.split('spc-drawer')[1] || ''), 'no cost → margin "—"; no compare-at → no discount badge');

  /* P4 status action: success only on success:true */
  calls = []; toasts = []; E.__upd = async () => ({ success: true });
  click(E.handlers, { act: 'status', status: 'removed' }); await tick(); await tick(); await tick();
  const upd = calls.find((c) => c.op === 'adminUpdateProductStatus');
  ck('P4a', upd && upd.d.productId === 'p2' && upd.d.status === 'removed' && toasts.some((t) => t.k === 'success'), 'Remove calls adminUpdateProductStatus {productId, status}; success toast on success:true', { upd, toasts });
  click(E.handlers, { open: 'p2' });
  calls = []; toasts = []; E.__upd = async () => { throw new Error('PERMISSION_DENIED: caller is not an admin'); };
  click(E.handlers, { act: 'status', status: 'active' }); await tick(); await tick(); await tick();
  ck('P4b', !toasts.some((t) => t.k === 'success') && toasts.some((t) => t.k === 'error' && /PERMISSION_DENIED/.test(t.m)), 'a server refusal → error with the server reason, no success toast', toasts);
  click(E.handlers, { open: 'p2' });
  calls = []; toasts = []; E.__upd = async () => ({ ok: true });
  click(E.handlers, { act: 'status', status: 'active' }); await tick(); await tick(); await tick();
  ck('P4c', !toasts.some((t) => t.k === 'success'), 'a response without success:true is NOT success', toasts);

  /* P5 feature */
  click(E.handlers, { open: 'p3' }); calls = []; E.__upd = async () => ({ success: true });
  click(E.handlers, { act: 'feature' }); await tick(); await tick(); await tick();
  const f = calls.find((c) => c.op === 'adminUpdateProductStatus');
  ck('P5a', f && f.d.status === 'active' && f.d.featured === true, 'Feature sends the CURRENT status unchanged + featured:true', f && f.d);
  click(E.handlers, { open: 'p7' }); html = E.root.innerHTML;
  ck('P5b', !/data-act="feature"/.test(html.split('spc-drawer')[1] || ''), 'Feature is not offered when the status is unknown (never defaults to active)');

  /* P9 cancel */
  E = makeEnv(); calls = [];
  E.SPC.mount(E.root, { call: callFn, toast: () => {}, confirm: async () => false }); await tick(); await tick();
  click(E.handlers, { open: 'p1' }); click(E.handlers, { act: 'status', status: 'removed' }); await tick(); await tick();
  ck('P9', !calls.some((c) => c.op === 'adminUpdateProductStatus'), 'cancelling the confirm never reaches the server');

  /* P6 export */
  click(E.handlers, { act: 'export' });
  const csv = E.blobs[0] || '';
  ck('P6', /"'=HYPERLINK/.test(csv) && !/^"=HYPERLINK/m.test(csv) && /"id","name"|id,name/.test(csv), 'CSV export prefixes formula-like cells so a spreadsheet never executes them', csv.split('\n').find((l) => /HYPERLINK/.test(l)));

  /* P10 one component, two hosts */
  const aos = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8'), aosHtml = fs.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8'), sa = fs.readFileSync(path.join(ROOT, 'super-admin.html'), 'utf8');
  ck('P10', /SokoniProductsConsole\.mount\(body/.test(aos) && /sokoni-products-console\.js/.test(aosHtml) && /SokoniProductsConsole\.mount\(el/.test(sa) && /sokoni-products-console\.js/.test(sa) && /data-section="products"/.test(sa) && /id="panel-products"/.test(sa), 'AdminOS Products tab and the Super Admin Products section both mount THIS module');

  console.log('\n' + pass + ' passed, ' + fail + ' failed' + (process.env.SABOTAGE === '1' ? '   (SABOTAGE — failures EXPECTED)' : ''));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e.stack || e.message); process.exit(2); });
