#!/usr/bin/env node
/* Construction containment (owner 2026-10-03) — static + functional certification of construction.html.
   Contract: no fabricated catalogue / suppliers / prices; no fake order; no WhatsApp / phone hand-offs; no promise of
   supplier responses that nothing delivers; product cards are plain links to the canonical product page with NO buttons;
   unknown figures render "—"; contractor / equipment registration goes to the ONE intake. The functional rows execute
   the page's own main script in a vm with a minimal DOM and a stubbed /api/catalogue. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const R = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(R, 'construction.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (id, c, m, d) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (c || d === undefined ? '' : '   [' + String(d).slice(0, 160) + ']')); c ? pass++ : fail++; };

/* S — static */
ok('S1', !/wa\.me|whatsapp\.com|api\.whatsapp/i.test(html), 'no WhatsApp links anywhere on the page');
ok('S2', !/href="tel:|href=\\?"tel:|\$\{s\.phone\}/.test(html), 'no tel: phone hand-offs');
ok('S3', !/waConnect\(/.test(html), 'no SokoniPay.waConnect hand-off');
ok('S4', !/id:"BM\d\d"|id:'BM\d\d'|const SUPPLIERS = \[|PRICE_GUIDE_BASE|Math\.sin/.test(html), 'no hard-coded products, suppliers or seeded "AI" prices');
ok('S5', !/within 2 hours|within 1 hour|Up to 3 verified suppliers/.test(html), 'no promised supplier responses');
ok('S6', !/Place Order via M-PESA|send M-PESA payment details/.test(html), 'no fake "order via M-PESA" flow');
ok('S7', /fetch\('\/api\/catalogue\?limit=500'/.test(html), 'products come from the server catalogue');
ok('S8', /HubRegister\.open\(\{ hub: 'construction', category: 'contractor' \}\)/.test(html), 'contractor registration goes to the ONE intake');
ok('S9', /<script src="sokoni-product-visibility\.js"><\/script>/.test(html) && /<script src="sw-register\.js" defer><\/script>/.test(html), 'visibility predicate loaded; page self-updates');
ok('S10', /spendEl\.textContent='—'/.test(html), 'dashboard spend renders "—" (no browser-summed figure)');

/* F — functional: run the main inline script with a tiny DOM */
const blocks = []; const re = /<script>([\s\S]*?)<\/script>/g; let m;
while ((m = re.exec(html))) blocks.push(m[1]);
const main = blocks.find((b) => /function filterProducts\(\)/.test(b));
ok('F0', !!main, 'main inline script found');
const els = {};
const el = (id) => (els[id] = els[id] || { id, innerHTML: '', textContent: '', value: '', style: {}, classList: { add() {}, remove() {} }, scrollIntoView() {}, querySelectorAll: () => [], focus() {} });
const CATALOGUE = [
  { id: 'p1', name: 'Bamburi Cement 50kg', category: 'cement', price: 750, shopName: 'Real Hardware', reviewCount: 0, rating: 5 },
  { id: 'p2', name: '<img src=x onerror=alert(1)>', category: 'steel', price: 0, shopName: 'X' },
  { id: 'p3', name: 'Phone case', category: 'electronics', price: 500 },
  { id: 'p4', name: 'Archived steel', category: 'steel', price: 900, status: 'archived' },
  { id: 'bad id!', name: 'Bad id', category: 'cement', price: 1 },
];
let fetchOk = true;
const sandbox = {
  console, setTimeout: (fn) => fn && 0, URLSearchParams, encodeURIComponent, Number, String, Array, JSON, Math, Date, isFinite,
  location: { search: '', hostname: 'mysokoni.co.ke', href: '' },
  localStorage: { getItem: () => null, setItem() {} },
  document: { getElementById: el, querySelector: () => null, querySelectorAll: () => ({ forEach() {} }), addEventListener() {} },
  fetch: async () => (fetchOk ? { ok: true, json: async () => ({ ok: true, products: CATALOGUE }) } : { ok: false, json: async () => ({}) }),
};
sandbox.window = sandbox;
sandbox.SokoniProductVisibility = require(path.join(R, 'sokoni-product-visibility.js'));
(async () => {
  try { vm.runInNewContext(main, sandbox, { timeout: 3000 }); } catch (e) { /* tolerate DOM gaps after definitions */ }
  const F = (n) => typeof sandbox[n] === 'function';
  ok('F1', F('loadConstructionProducts') && F('filterProducts'), 'loader + renderer defined');
  await sandbox.loadConstructionProducts();
  const g = (els.cnGrid || {}).innerHTML || '';
  ok('F2', /href="product\.html\?id=p1"/.test(g), 'a construction product card links to product.html?id=', g.slice(0, 120));
  ok('F3', !/<button/i.test(g), 'product cards contain NO buttons');
  ok('F4', !/Phone case/.test(g) && !/Archived steel/.test(g) && !/Bad id/.test(g), 'non-construction, archived and malformed-id products are excluded');
  ok('F5', !/<img src=x onerror/.test(g) && /&lt;img src=x onerror=alert\(1\)&gt;/.test(g), 'product names are HTML-escaped (XSS)');
  ok('F6', /KES 750/.test(g) && /<div class="cn-price">—<\/div>/.test(g), 'real price shown; missing price renders "—"');
  ok('F7', !/⭐/.test(g), 'no rating shown when there are no real reviews');
  ok('F8', !/Verified/.test(g), 'no verified badge from product data on cards');
  fetchOk = false; await sandbox.loadConstructionProducts();
  const g2 = (els.cnGrid || {}).innerHTML || '';
  ok('F9', /This is not an empty catalogue/.test(g2), 'a failed load is never shown as an empty catalogue');
  /* R — RFQs go to the ONE RFQ authority as the signed-in individual (owner 2026-10-03) */
  const sent = []; let reply = { recipients: [{ supplierBusinessId: 's1' }, { supplierBusinessId: 's2' }] };
  sandbox.SokoniRfqTransport = async (p) => { sent.push(p); if (reply instanceof Error) throw reply; return reply; };
  const setv = (id, v) => { el(id).value = v; };
  setv('rfqType', 'materials'); setv('rfqLocation', 'Langata'); setv('rfqDesc', 'Cement — 500 bags'); setv('rfqDeadline', '2026-11-01'); setv('rfqBudget', ''); setv('rfqPref', '');
  sandbox.firebaseAuth = null; await sandbox.submitRFQ();
  ok('R1', /Sign in to request quotes/.test(els.rfqMsg.innerHTML) && sent.length === 0, 'signed out: asks to sign in and sends nothing');
  sandbox.firebaseAuth = { currentUser: { uid: 'u1' } }; await sandbox.submitRFQ(); await new Promise((r) => setImmediate(r));
  const p = sent[0] || {};
  ok('R2', p.op === 'create' && p.buyerType === 'individual' && p.open && p.open.category === 'building-materials' && p.deliveryLocation === 'Langata', 'sends create as an individual, open RFQ in the mapped category', p);
  ok('R3', !('buyerUid' in p) && !('uid' in p) && !('merchantId' in p) && !/0712|phone/i.test(JSON.stringify(Object.keys(p))), 'never sends a buyer identity — the server takes it from auth', Object.keys(p));
  ok('R4', Array.isArray(p.items) && p.items[0].name === 'Cement' && p.items[0].qty === 500 && p.items[0].unit === 'bags', 'parses "Cement — 500 bags" into an item with quantity', p.items);
  ok('R5', /Request sent to 2 suppliers/.test(els.rfqMsg.innerHTML), 'success only after the server returns, with the real recipient count');
  reply = new Error('functions/failed-precondition: Verify your phone number on SOKONI before requesting quotes.');
  els.rfqMsg.innerHTML = ''; els.rfqMsg.textContent = '';   /* the fake element keeps the two fields separately */
  await sandbox.submitRFQ(); await new Promise((r) => setImmediate(r));
  ok('R6', /Verify your phone number/.test(els.rfqMsg.textContent) && !/✅/.test(els.rfqMsg.innerHTML), 'the server refusal is shown verbatim, never a success');
  ok('R7', !/localStorage\.setItem\('sokoniRFQs'|sokoniBuildQuotes/.test(html), 'no browser-only RFQ store');
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
