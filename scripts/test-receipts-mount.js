/* Receipts, MOUNTED. The whole module, against a DOM stub, rendering real rows.
 *
 *   node scripts/test-receipts-mount.js
 *
 * WHY THIS EXISTS. Three defects shipped in this surface in a row, all the same shape:
 *
 *   b6371ad  filter state undefined  -> the list rendered EMPTY for every merchant
 *   4043df7  S.copies undefined      -> the stepper showed "undefined", stepped to NaN
 *   fb92761  onInput returned early  -> every filter select was inert
 *
 * Every one passed a suite that read SOURCE TEXT. `copies: S.copies` was present, so "the
 * chosen copies reach the print job" passed — truthfully, about a value that was undefined.
 * Reading the source proves the code was written; it cannot prove the code runs.
 *
 * So this mounts the module and looks at what it actually produced.
 */
'use strict';
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, label, detail) => {
  if (c) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
};

/* ── A DOM the module can render into ─────────────────────────────────────── */
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
    insertBefore(c) { this.children.push(c); return c; },
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
      const re = /<(\w+)([^>]*)>/g; let m;
      while ((m = re.exec(this._html))) {
        const a = {};
        const ar = /([\w-]+)="([^"]*)"/g; let am;
        while ((am = ar.exec(m[2]))) a[am[1]] = am[2];
        if (a['data-rc']) {
          const node = mkEl(m[1]);
          node.attrs = a; node.value = a.value || '';
          node.closest = (sel) => (matches(node, sel) ? node : null);
          this._nodes.push(node);
        }
      }
    },
    querySelector(sel) { return this._nodes.find((n) => matches(n, sel)) || null; },
    querySelectorAll(sel) { return this._nodes.filter((n) => matches(n, sel)); },
  };
  return el;
}

const head = mkEl('head');
global.document = {
  head: head, body: mkEl('body'),
  createElement: mkEl,
  getElementById: () => null,
  addEventListener() {}, removeEventListener() {},
};
global.window = global;
global.localStorage = {
  _d: {}, getItem(k) { return this._d[k] || null; },
  setItem(k, v) { this._d[k] = String(v); },
};
/* node 24 defines navigator as a getter — define, do not assign. */
try { Object.defineProperty(global, 'navigator', { value: {}, configurable: true, writable: true }); } catch (e) {}
global.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };

/* The canonical contract and engine, as the shell loads them. */
require(path.join(__dirname, '..', 'sokoni-receipt.js'));
require(path.join(__dirname, '..', 'sokoni-analytics-engine.js'));
const Receipts = require(path.join(__dirname, '..', 'sokoni-merchant-receipts.js'));

ok(!!global.window.SokoniReceiptDoc, 'CONTROL: the receipt contract loaded');
ok(!!global.window.SokoniAnalyticsEngine, 'CONTROL: the analytics engine loaded');

/* ── Real rows ────────────────────────────────────────────────────────────── */
const NOW = Date.now(), DAY = 86400000;
const ROWS = [
  { id: 'o1', ref: 'RCPT-000042', ts: NOW, when: new Date(NOW), total: 4300, currency: 'KES',
    customer: 'Jane Doe', phone: '0722000111', status: 'completed', payment: 'paid',
    method: 'M-PESA', mpesaRef: 'TFG7H2K9QQ', channel: 'in_store',
    servedBy: { name: 'Alex', role: 'cashier' },
    items: [{ name: 'Sugar 2kg', qty: 1, price: 2800 }, { name: 'Maize Flour 1kg', qty: 2, price: 750 }] },
  { id: 'o2', ref: 'RCPT-000039', ts: NOW, when: new Date(NOW), total: 1200, currency: 'KES',
    customer: 'Walk-in', status: 'completed', payment: 'paid', method: 'Cash',
    channel: 'delivery', deliveryId: 'DEL-77', address: 'Westlands, Nairobi',
    rider: 'Brian O.', deliveryFee: 300, items: [{ name: 'Rice 5kg', qty: 1, price: 900 }] },
  { id: 'o3', ref: 'RCPT-000031', ts: NOW - DAY, when: new Date(NOW - DAY), total: 900,
    currency: 'KES', customer: 'Peter', status: 'completed', payment: 'paid', method: 'M-PESA',
    channel: 'in_store', items: [] },
];

const host = mkEl('div');
let printed = null;
const ui = Receipts.mount(host, {
  scope: { ok: true, shopId: 'shop-1', sellerUid: 'u1' },
  shopName: 'Bravilex Duka',
  shop: { name: 'Bravilex Duka' },
  orders: () => Promise.resolve({ rows: ROWS }),
  device: () => ({ connected: true, name: 'MP58E', state: 'connected' }),
  onPrint: (job) => { printed = job; return Promise.resolve({ ok: true }); },
  onToast: () => {},
});

setTimeout(() => {
  const html = () => host.innerHTML;

  /* ── 1. IT RENDERED AT ALL ──────────────────────────────────────────────── */
  console.log('\n1. The surface renders receipts');
  ok(html().length > 500, 'CONTROL: something was rendered (' + html().length + ' chars)');
  /* THE defect that shipped twice: a page that renders but lists nothing. */
  ok(html().indexOf('RCPT-000042') > -1, 'today\'s receipt is on screen');
  ok(html().indexOf('RCPT-000039') > -1, 'the delivery receipt is on screen');
  ok(html().indexOf('rc-card') > -1, 'receipts render as CARDS');
  ok(html().indexOf('No receipt matches') === -1,
     'the list is NOT empty — this is exactly what b6371ad shipped');

  /* ── 2. THE SUMMARY ────────────────────────────────────────────────────── */
  console.log('\n2. The summary is computed, not blank');
  ok(html().indexOf('rc-sum-v') > -1, 'the summary strip rendered');
  /* 4300 + 1200 today. Rendered by the engine, so a wrong figure here is a real defect. */
  ok(/5,500/.test(html()), 'today\'s total reads 5,500 (4,300 + 1,200)',
     'engine-derived; yesterday\'s 900 is correctly excluded');
  ok(html().indexOf('💳 M-PESA') > -1 && html().indexOf('💵 Cash') > -1,
     'the payment split rendered');
  ok(/>\s*2\s*<\/b>/.test(html()) || html().indexOf('2 receipts') > -1,
     'the receipt count reflects today only');

  /* ── 3. THE CARD ───────────────────────────────────────────────────────── */
  console.log('\n3. The card shows the sale');
  ok(html().indexOf('Jane Doe') > -1, 'the customer is shown');
  ok(html().indexOf('Sugar 2kg') > -1, 'item lines are shown');
  ok(html().indexOf('TFG7H2K9QQ') > -1, 'the M-PESA reference is shown');
  ok(html().indexOf('Alex') > -1, 'the cashier who served it is shown');
  ok(html().indexOf('✓ Paid') > -1, 'the paid badge rendered');
  /* Delivery on the delivery sale, and NOT on the counter sale. */
  ok(html().indexOf('Westlands, Nairobi') > -1, 'the delivery card shows its address');
  const counterCard = html().slice(html().indexOf('RCPT-000042'), html().indexOf('RCPT-000039'));
  ok(counterCard.indexOf('🚚') === -1, 'the ordinary sale has NO delivery block');

  /* ── 4. THE CONTROLS EXIST AND ARE ADDRESSABLE ─────────────────────────── */
  console.log('\n4. Every control the brief asks for is in the document');
  ['q', 'range', 'pay', 'kind', 'open', 'menu', 'pin'].forEach((k) => {
    ok(!!host.querySelector('[data-rc="' + k + '"]'), 'control "' + k + '" is present');
  });
  /* The card menu must be in the DOM even when closed — Products learned this the hard way. */
  ok(html().indexOf('data-rc="quickprint"') > -1,
     'the card menu is in the document while CLOSED (hidden, not absent)');

  /* ── 5. THE FILTERS ACTUALLY MOVE THE LIST ─────────────────────────────── */
  console.log('\n5. Changing a filter changes what is on screen');
  const fire = (attr, value) => {
    const el = host.querySelector('[data-rc="' + attr + '"]');
    if (!el) return false;
    el.value = value;
    listeners.filter((l) => l.el === host && (l.t === 'change' || l.t === 'input'))
      .forEach((l) => l.fn({ target: el }));
    return true;
  };
  ok(fire('pay', 'cash'), 'CONTROL: the payment control was found and fired');
  ok(html().indexOf('RCPT-000039') > -1 && html().indexOf('RCPT-000042') === -1,
     'filtering to Cash leaves only the cash receipt — the inert-control defect is gone');
  fire('pay', 'all');
  ok(html().indexOf('RCPT-000042') > -1, 'clearing the filter brings it back');
  fire('range', 'yesterday');
  ok(html().indexOf('RCPT-000031') > -1 && html().indexOf('RCPT-000042') === -1,
     'the date filter selects yesterday only');
  fire('range', 'today');

  /* ── 6. OPENING AND PRINTING ───────────────────────────────────────────── */
  console.log('\n6. Opening a receipt, and printing it');
  const click = (attr) => {
    const el = host.querySelector('[data-rc="' + attr + '"]');
    if (!el) return false;
    listeners.filter((l) => l.el === host && l.t === 'click').forEach((l) => l.fn({ target: el }));
    return true;
  };
  ok(click('open'), 'CONTROL: a receipt could be opened');
  ok(html().indexOf('rc-panel') > -1, 'the receipt sheet opened');
  /* The canonical document, not markup written here. */
  ok(html().indexOf('rc-doc') > -1, 'the sheet renders the canonical receipt document');
  ok(html().indexOf('Bravilex Duka') > -1, 'the shop name comes through the contract');
  ok(click('openprint'), 'CONTROL: the print options sheet could be opened');
  ok(html().indexOf('MP58E') > -1, 'the printer state is reported from the device layer');
  ok(html().indexOf('Connected') > -1, 'a connected printer says so');
  ok(click('doprint'), 'CONTROL: print could be pressed');

  setTimeout(() => {
    ok(!!printed, 'the print job actually reached the device layer');
    ok(printed && typeof printed.text === 'string' && printed.text.length > 40,
       'the job carries the composed receipt TEXT');
    /* The values that shipped undefined. */
    ok(printed && printed.copies === 1,
       'the job carries a real copy count (1), not undefined',
       'got ' + (printed && printed.copies));
    ok(printed && printed.includeQr === true,
       'the job carries the QR choice, not undefined',
       'got ' + (printed && printed.includeQr));

    try { ui.destroy(); } catch (e) {}
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }, 30);
}, 40);
