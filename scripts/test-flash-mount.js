/* Flash Sale, MOUNTED. The whole module, against a DOM stub, with real sales.
 *
 *   node scripts/test-flash-mount.js
 *
 * WHY THIS EXISTS. Receipts shipped three defects in a row that source-text assertions could
 * not see — undefined state, an inert control, a value that read "undefined" on screen. Every
 * one would have been caught by mounting the module and looking at what came out. So Flash
 * Sale gets that treatment BEFORE it ships, not after.
 *
 * The create button, product selection, the discount preview, the publish payload, the
 * filters, the countdown and the card actions all execute here.
 */
'use strict';
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, label, detail) => {
  if (c) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
};

const listeners = [];
function matches (node, sel) {
  let m = sel.match(/^\[([\w-]+)="([^"]*)"\]$/);
  if (m) return node.attrs[m[1]] === m[2];
  m = sel.match(/^\[([\w-]+)\]$/);
  if (m) return node.attrs[m[1]] !== undefined;
  return false;
}
function mkEl (tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(), children: [], attrs: {}, style: {},
    _html: '', value: '', checked: false, id: '', textContent: '', _nodes: [],
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
                 contains(c) { return this._s.has(c); }, toggle() {} },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i > -1) this.children.splice(i, 1); },
    addEventListener(t, fn) { listeners.push({ el: this, t, fn }); },
    removeEventListener(t, fn) {
      const i = listeners.findIndex((l) => l.el === this && l.t === t && l.fn === fn);
      if (i > -1) listeners.splice(i, 1);
    },
    focus() {}, setSelectionRange() {}, click() {},
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this._parse(); },
    _parse() {
      this._nodes = [];
      let lastSelect = null;
      const re = /<(\w+)([^>]*)>/g; let m;
      while ((m = re.exec(this._html))) {
        const tag = m[1].toLowerCase();
        const a = {};
        const ar = /([\w-]+)="([^"]*)"/g; let am;
        while ((am = ar.exec(m[2]))) a[am[1]] = am[2];

        /* A <select> carries no value attribute — the browser resolves .value from the
           option marked selected. Modelling that matters: without it captureForm() read an
           empty product id straight back out of the DOM and every publish was refused with
           "Choose a product first", which looks exactly like a module defect and is not. */
        if (tag === 'option' && lastSelect) {
          if (/\sselected/.test(m[2])) lastSelect.value = a.value || '';
          continue;
        }
        if (a['data-fl'] || a['data-ff'] || a['data-fl-cd']) {
          const node = mkEl(tag);
          node.attrs = a; node.value = a.value || '';
          node.closest = (sel) => (matches(node, sel) ? node : null);
          this._nodes.push(node);
          lastSelect = (tag === 'select') ? node : null;
        } else if (tag !== 'option') {
          lastSelect = null;
        }
      }
    },
    querySelector(sel) { return this._nodes.find((n) => matches(n, sel)) || null; },
    querySelectorAll(sel) { return this._nodes.filter((n) => matches(n, sel)); },
  };
  return el;
}

global.document = {
  head: mkEl('head'), body: mkEl('body'), createElement: mkEl,
  getElementById: () => null, addEventListener() {}, removeEventListener() {},
};
global.window = global;
global.localStorage = { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = String(v); } };

const Flash = require(path.join(__dirname, '..', 'sokoni-merchant-flash.js'));

const NOW = Date.now(), HOUR = 3600000;
const SALES = [
  { id: 's1', productId: 'p1', productName: 'Sugar 2kg', sku: 'SUG-2',
    originalPrice: 2500, salePrice: 1750, discountPct: 30,
    startAt: NOW - HOUR, endAt: NOW + 2 * HOUR, stockLimit: 20, soldCount: 8, status: 'active' },
  { id: 's2', productId: 'p2', productName: 'Maize Flour', sku: 'MZ-1',
    originalPrice: 200, salePrice: 150, discountPct: 25,
    startAt: NOW + 6 * HOUR, endAt: NOW + 12 * HOUR, stockLimit: 50, soldCount: 0, status: 'scheduled' },
  { id: 's3', productId: 'p3', productName: 'Rice 5kg', sku: 'RC-5',
    originalPrice: 900, salePrice: 700, discountPct: 22,
    startAt: NOW - 48 * HOUR, endAt: NOW - 24 * HOUR, stockLimit: 10, soldCount: 10, status: 'ended' },
];
const PRODUCTS = [
  { id: 'p1', name: 'Sugar 2kg', price: 2500, stock: 40, image: 'https://x/s.jpg' },
  { id: 'p2', name: 'Maize Flour', price: 200, stock: 12 },
  { id: 'p3', name: 'Rice 5kg', price: 900, stock: 0 },
];

/* listProducts reads through the canonical data module; stub its adapter, not the module. */
global.window.SokoniMerchantData = {
  listProducts: () => Promise.resolve(PRODUCTS),
};

const host = mkEl('div');
let dispatched = null;
const ui = Flash.mount(host, {
  scope: { ok: true, shopId: 'shop-1', sellerUid: 'u1' },
  shopName: 'Bravilex Duka',
  db: { queryProducts: () => Promise.resolve(PRODUCTS) },
  sales: () => Promise.resolve(SALES),
  callDispatch: (p) => { dispatched = p; return Promise.resolve({ ok: true, saleId: 'new1', discountPct: 30 }); },
  onToast: () => {},
});

const html = () => host.innerHTML;
const fire = (el, type) => listeners
  .filter((l) => l.el === host && l.t === type)
  .forEach((l) => l.fn({ target: el }));
const clickAttr = (attr, val) => {
  const el = host.querySelectorAll('[data-fl="' + attr + '"]')
    .find((n) => (val === undefined || n.attrs['data-k'] === val));
  if (!el) return false;
  fire(el, 'click');
  return true;
};
const setField = (name, value) => {
  const el = host.querySelectorAll('[data-ff]').find((n) => n.attrs['data-ff'] === name);
  if (!el) return false;
  el.value = value;
  fire(el, 'change'); fire(el, 'input');
  return true;
};

setTimeout(() => {
  console.log('\n1. The studio renders');
  ok(html().length > 800, 'CONTROL: something rendered (' + html().length + ' chars)');
  ok(html().indexOf('Flash Sale') > -1, 'the hero rendered');
  ok(html().indexOf('LIVE NOW') > -1, 'a live sale shows LIVE NOW');
  ok(html().indexOf('Sugar 2kg') > -1, 'the live sale is listed');
  ok(html().indexOf('fl-card') > -1, 'sales render as CARDS');

  console.log('\n2. Hero figures are derived from real rows');
  /* units 8 + 0 + 10 = 18; revenue 8*1750 + 0 + 10*700 = 21,000 */
  ok(html().indexOf('>18<') > -1, 'units sold is 18 — summed from real soldCount');
  ok(/21,000/.test(html()), 'sales generated reads 21,000');

  console.log('\n3. The countdown is live, not a placeholder');
  ok(/\d+h \d+m \d+s|\d+ day/.test(html()), 'a real countdown is rendered');
  ok(html().indexOf('00h 00m 00s') === -1, 'no zeroed placeholder countdown');

  console.log('\n4. The card shows the SERVER discount and real progress');
  ok(/30% OFF/i.test(html()), 'the stored discountPct is shown');
  ok(html().indexOf('8 of 20 sold') > -1, 'the progress label is real');
  ok(/fl-bar/.test(html()), 'a progress bar rendered');

  console.log('\n5. Filters actually filter');
  ok(clickAttr('chip', 'live'), 'CONTROL: the Live chip was found');
  ok(html().indexOf('Sugar 2kg') > -1 && html().indexOf('Rice 5kg') === -1,
     'Live shows only the live sale');
  ok(clickAttr('chip', 'done'), 'CONTROL: the Ended chip was found');
  ok(html().indexOf('Rice 5kg') > -1 && html().indexOf('Sugar 2kg') === -1,
     'Ended shows only the ended sale');
  clickAttr('chip', 'all');

  console.log('\n6. Create: form, preview, payload');
  ok(clickAttr('new'), 'CONTROL: the create control was pressed');
  ok(html().indexOf('fl-panel') > -1, 'the create sheet opened');
  ok(html().indexOf('Choose a product') > -1, 'the product picker offers the catalogue');
  ok(html().indexOf('Sugar 2kg') > -1, 'products come from the ONE catalogue');

  ok(setField('productId', 'p1'), 'CONTROL: a product could be chosen');
  ok(setField('salePrice', '1750'), 'CONTROL: a sale price could be typed');
  /* The preview the brief asked for: 2,500 -> 1,750 · 30% OFF · Save 750. */
  ok(/30% OFF/.test(html()), 'the preview shows 30% OFF without the merchant calculating it');
  ok(/Save KES\s*750/.test(html()), 'the preview shows the amount saved');
  ok(html().indexOf('Preview') > -1, 'it is labelled a preview, not the confirmed discount');

  /* A sale price at or above the regular price is called out, not silently previewed. */
  setField('salePrice', '9999');
  ok(/must be lower/.test(html()), 'a sale price above the regular price is refused in the preview');
  setField('salePrice', '1750');

  ok(clickAttr('launch'), 'CONTROL: publish was pressed');

  setTimeout(() => {
    ok(!!dispatched, 'the create actually reached commerceDispatch');
    ok(dispatched && dispatched.op === 'createFlashSale', 'it dispatches createFlashSale');
    ok(dispatched && dispatched.originalPrice === 2500 && dispatched.salePrice === 1750,
       'it sends BOTH prices',
       JSON.stringify(dispatched && { o: dispatched.originalPrice, s: dispatched.salePrice }));
    /* The whole point: the client computed a preview and did NOT send it. */
    ok(dispatched && dispatched.discountPct === undefined,
       'it does NOT send a client-computed discountPct — the server derives it',
       'got ' + (dispatched && dispatched.discountPct));

    try { ui.destroy(); } catch (e) {}
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }, 60);
}, 60);
