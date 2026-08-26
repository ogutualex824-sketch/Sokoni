/* ══════════════════════════════════════════════════════════════════════════════
   FLASH SALE — the native surface, functionally
   ══════════════════════════════════════════════════════════════════════════════
     node scripts/test-merchant-flash.js

   The surface certification proves this route renders. This asks whether it is
   RIGHT, and in particular whether it repaired the defect it replaced:

     the legacy surface wrote localStorage.sokoniFlashSales and called NOTHING,
     so a merchant "launched" a sale that no buyer could ever see, while a
     complete flash-sale engine sat unused in functions/marketing-engine.js.

   The properties that matter here are all about NOT owning things: not the
   pricing, not the entitlement, not the stock, not the write.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);

console.log('\nFLASH SALE — NATIVE SURFACE');
console.log('='.repeat(78));

const listeners = [];
function mkEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(), children: [], attrs: {}, style: {},
    _html: '', value: '', id: '', _nodes: [],
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
                 contains(c) { return this._s.has(c); } },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, fn) { listeners.push({ el: this, t, fn }); },
    removeEventListener(t, fn) {
      const i = listeners.findIndex((l) => l.el === this && l.t === t && l.fn === fn);
      if (i > -1) listeners.splice(i, 1);
    },
    focus() {},
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v); this._nodes = [];
      const re = /<(\w+)([^>]*)>/g; let m;
      while ((m = re.exec(this._html))) {
        const a = {}; const ar = /([\w-]+)="([^"]*)"/g; let am;
        while ((am = ar.exec(m[2]))) a[am[1]] = am[2];
        if (a['data-fl'] || a['data-ff']) {
          const n = mkEl(m[1]); n.attrs = a; n.value = a.value || '';
          /* A <select> has no value ATTRIBUTE — its value is the selected
             option's. Reading the attribute made every select read as empty, so
             the form looked unfilled and the module correctly refused to submit.
             The rig was wrong, not the surface. */
          if (m[1].toLowerCase() === 'select') {
            const rest = this._html.slice(re.lastIndex);
            const close = rest.indexOf('</select>');
            const opts = close > -1 ? rest.slice(0, close) : rest;
            const sel = opts.match(/<option value="([^"]*)"[^>]*selected/);
            n.value = sel ? sel[1] : '';
          }
          n.closest = () => n;
          this._nodes.push(n);
        }
      }
    },
    querySelector(sel) {
      let m = sel.match(/\[data-fl="([^"]*)"\]/);
      if (m) return this._nodes.find((n) => n.attrs['data-fl'] === m[1]) || null;
      m = sel.match(/\[data-ff="([^"]*)"\]/);
      if (m) return this._nodes.find((n) => n.attrs['data-ff'] === m[1]) || null;
      return null;
    },
  };
  return el;
}
const doc = {
  _styles: {},
  getElementById(id) { return doc._styles[id] || null; },
  createElement(t) { return mkEl(t); },
  head: { appendChild(el) { if (el.id) doc._styles[el.id] = el; } },
  addEventListener(t, fn) { listeners.push({ el: doc, t, fn }); },
  removeEventListener(t, fn) {
    const i = listeners.findIndex((l) => l.el === doc && l.t === t && l.fn === fn);
    if (i > -1) listeners.splice(i, 1);
  },
};
global.document = doc;
global.window = global;

const MD = require(path.join(ROOT, 'sokoni-merchant-data.js'));
global.SokoniMerchantData = MD;
const UI = require(path.join(ROOT, 'sokoni-merchant-flash.js'));

const SCOPE = { ok: true, shopId: 'shop_A', sellerUid: 'uid_A' };
const PRODUCTS = [
  { id: 'p1', name: 'Sukuma Wiki', price: 100, sku: 'SW-1', shopId: 'shop_A' },
  { id: 'p2', name: 'Maize', price: 50, sku: 'MZ-1', shopId: 'shop_A' },
];
const SALES = [
  { id: 's1', merchantId: 'uid_A', productId: 'p1', productName: 'Sukuma Wiki',
    originalPrice: 100, salePrice: 70, discountPct: 30, stockLimit: 20, soldCount: 4,
    status: 'active', startAt: Date.now() - 3600e3, endAt: Date.now() + 3600e3 },
];

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 10) { for (let i = 0; i < n; i++) await tick(); }

function mountUI(opts = {}) {
  const host = mkEl('div');
  const toasts = [], dispatched = [];
  const db = {
    queryProducts: async (spec) => PRODUCTS.filter((p) =>
      (spec.where || []).every(([f, o, v]) => o === '==' && p[f] === v)),
  };
  const inst = UI.mount(host, {
    scope: opts.scope || SCOPE,
    db: opts.db === undefined ? db : opts.db,
    shopName: 'Cert Shop',
    sales: opts.sales || (() => Promise.resolve(SALES.slice())),
    callDispatch: opts.callDispatch || ((p) => { dispatched.push(p); return Promise.resolve({ saleId: 'new1' }); }),
    onToast: (m) => toasts.push(m),
  });
  return { host, inst, toasts, dispatched };
}
function fire(host, type, node) {
  listeners.filter((l) => l.el === host && l.t === type).forEach((l) => l.fn({ target: node }));
}
function click(host, sel) {
  const n = host.querySelector(sel);
  if (!n) throw new Error('no control ' + sel);
  fire(host, 'click', n);
  return n;
}
function fill(host, values) {
  Object.keys(values).forEach((k) => {
    const el = host.querySelector('[data-ff="' + k + '"]');
    if (!el) throw new Error('no field ' + k);
    el.value = String(values[k]);
    fire(host, 'change', el);
  });
}

const src = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-flash.js'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

(async () => {
  head('1 - it reads the SERVER\'s sales, not a device cache');
  let ui = mountUI();
  await settle();
  ck('the existing sale is listed', ui.host.innerHTML.indexOf('Sukuma Wiki') > -1);
  ck('no localStorage anywhere', !/localStorage|sessionStorage/.test(code),
     'the surface it replaces wrote localStorage.sokoniFlashSales');
  ck('NC the comment stripper left the code intact', code.indexOf('function launch') > -1);

  head('2 - the DISCOUNT is the server\'s, never computed here');
  ck('the stored discountPct is displayed', /30% off/.test(ui.host.innerHTML));
  /* `discountPct\s*=` also matched `s.discountPct === 'number'` — a COMPARISON,
     which is the surface reading the server's value, exactly what it should do.
     The check is for an ASSIGNMENT. */
  ck('no percentage arithmetic in the surface',
     !/\/\s*100|\*\s*0\.\d|1\s*-\s*\w*[Pp]ct|discountPct\s*=[^=]/.test(code),
     'a second pricing calculation is a second answer for one sale');
  ck('NC the check would catch a real computation',
     /discountPct\s*=[^=]/.test('var discountPct = (a-b)/a;'),
     'so the pass above is an absence, not a broken pattern');
  ck('the form asks for a PRICE, not a percentage',
     /data-ff="salePrice"/.test(code) && !/data-ff="discount(Pct)?"/.test(code),
     'so nothing here converts a percentage into money');

  head('3 - CREATE goes to the existing server authority');
  ui = mountUI();
  await settle();
  click(ui.host, '[data-fl="new"]');
  fill(ui.host, { productId: 'p1', salePrice: '70', stockLimit: '20',
                  startAt: '2026-08-21T09:00', endAt: '2026-08-22T09:00' });
  click(ui.host, '[data-fl="launch"]');
  await settle(14);
  ck('exactly one dispatch', ui.dispatched.length === 1, JSON.stringify(ui.dispatched.length));
  const d = ui.dispatched[0] || {};
  ck('it calls the existing op', d.op === 'createFlashSale', d.op);
  ck('merchantId comes from the SCOPE', d.merchantId === 'uid_A');
  ck('it sends both prices and lets the server derive the discount',
     d.originalPrice === 100 && d.salePrice === 70 && d.discountPct === undefined,
     JSON.stringify({ o: d.originalPrice, s: d.salePrice, pct: d.discountPct }));
  ck('the product\'s sku travels with it', d.sku === 'SW-1', d.sku);
  ck('the window is sent as ISO', /^\d{4}-\d\d-\d\dT/.test(String(d.startAt)) &&
     new Date(d.endAt) > new Date(d.startAt), d.startAt + ' -> ' + d.endAt);
  ck('a success toast only AFTER the call resolved',
     /flash sale launched/i.test(ui.toasts.join(' ')), ui.toasts.join(' '));

  head('4 - it owns NO other authority');
  ck('no client write of any kind',
     !/setDoc|addDoc|updateDoc|deleteDoc|writeBatch|runTransaction/.test(code),
     'mktFlashSales is `allow write: if false`');
  ck('no entitlement or subscription logic',
     !/entitlement|uploadLimit|canPublish|plan\b|subscription/i.test(code),
     'whether a plan allows flash sales is the subscription authority\'s question');
  ck('no stock or inventory write',
     !/adjustStock|inventoryVersion|merchantAdjustStock/.test(code),
     'stockLimit caps the SALE; Inventory remains the only stock writer');
  ck('products come from the ONE reader',
     /SokoniMerchantData/.test(code) && /listProducts/.test(code) &&
     !/collection\(|getDocs\(/.test(code));
  ck('no second Firebase bootstrap',
     !/initializeApp|firebasejs|getFirestore/.test(code));

  head('5 - server REFUSALS are shown in the server\'s words');
  ui = mountUI({ callDispatch: () => Promise.reject(new Error('salePrice must be less than originalPrice.')) });
  await settle();
  click(ui.host, '[data-fl="new"]');
  fill(ui.host, { productId: 'p1', salePrice: '150', stockLimit: '5',
                  startAt: '2026-08-21T09:00', endAt: '2026-08-22T09:00' });
  click(ui.host, '[data-fl="launch"]');
  await settle(14);
  ck('the server\'s message is shown verbatim',
     /salePrice must be less than originalPrice/.test(ui.host.innerHTML));
  ck('the form stays open so it can be corrected',
     !!ui.host.querySelector('[data-fl="launch"]'));
  ck('NO success was announced', !/launched/i.test(ui.toasts.join(' ')),
     ui.toasts.join(' ') || '(silent)');
  ck('the surface does not restate the price rule itself',
     !/must be less than|below the original/i.test(code),
     'a local copy of a server rule is a copy that drifts');

  head('6 - unknowns are never rendered as numbers');
  ui = mountUI({ sales: () => Promise.resolve([{ id: 's2', merchantId: 'uid_A',
    productName: 'Mystery', salePrice: null, originalPrice: null,
    status: 'active', startAt: Date.now() - 1000, endAt: Date.now() + 1000 }]) });
  await settle();
  ck('an unknown sale price shows a dash', /—/.test(ui.host.innerHTML));
  ck('an absent sold count is not rendered as 0', !/\b0 of\b|\b0 sold\b/.test(ui.host.innerHTML),
     'a count nobody reported is unknown, not zero');
  ck('and no "% off" is invented', !/% off/.test(ui.host.innerHTML));

  head('7 - a failed read is not an empty list');
  ui = mountUI({ sales: () => Promise.reject(new Error('offline')) });
  await settle();
  ck('the failure is stated', /couldn.t be loaded/i.test(ui.host.innerHTML));
  ck('...and explicitly not called empty', /not an empty list/i.test(ui.host.innerHTML));
  ck('a retry is offered', !!ui.host.querySelector('[data-fl="retry"]'));
  ck('NC a genuinely empty list reads differently', await (async () => {
    const u2 = mountUI({ sales: () => Promise.resolve([]) });
    await settle();
    return /No flash sales yet/i.test(u2.host.innerHTML) && !/couldn.t be loaded/i.test(u2.host.innerHTML);
  })());

  head('8 - a catalogue failure does not hide existing sales');
  ui = mountUI({ db: { queryProducts: () => Promise.reject(new Error('denied')) } });
  await settle();
  ck('the sales still render', ui.host.innerHTML.indexOf('Sukuma Wiki') > -1,
     'existing sales matter even when the product list is unavailable');

  head('9 - no shop, no invented state');
  ui = mountUI({ scope: { ok: false, reason: 'no_active_shop' } });
  await settle();
  ck('it says there is no shop', /No shop yet/i.test(ui.host.innerHTML));
  ck('and offers no launch control', !ui.host.querySelector('[data-fl="new"]'));

  head('10 - the route is native, and lifecycle is clean');
  const routes = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-routes.js'), 'utf8');
  const entry = routes.slice(routes.indexOf("id:'flash-sale'"), routes.indexOf("id:'flash-sale'") + 300);
  ck('the registry declares it native', /kind:'native'/.test(entry));
  /* `sec:'flash'` is RETAINED, and this assertion was inverted deliberately.
     It was written at 381bf04, before the compatibility resolver landed at 9f3ec8c. Back then
     `sec` meant only "seller.html renders this", so dropping it was the right signal. It now
     also carries the legacy INBOUND vocabulary: seller.html forwards ?sec=flash by that name
     and the contract maps it to this route. Removing it would break every existing bookmark,
     email link and server-generated URL on the day this shipped, and would fail
     test-seller-deeplink, which asserts all 16 legacy sections still resolve.

     The invariant the original was reaching for — that the legacy shell no longer serves this
     route — is asserted below on KIND, which is what actually decides. */
  ck('it keeps sec as the legacy inbound key', /sec:'flash'/.test(entry));
  ck('and the legacy shell no longer RENDERS it (kind decides, not sec)',
     !/kind:'seller'[^}]*sec:'flash'/.test(routes));
  const before = listeners.filter((l) => l.el === doc).length;
  const fresh = mountUI();
  await settle();
  const during = listeners.filter((l) => l.el === doc).length;
  fresh.inst.destroy();
  ck('NC mounting adds a document listener', during > before, before + ' -> ' + during);
  ck('destroying releases it', listeners.filter((l) => l.el === doc).length === before);
  ck('the host is emptied', fresh.host.innerHTML === '');
  ck('no host listeners remain', listeners.filter((l) => l.el === fresh.host).length === 0);

  head('what this does NOT prove');
  un('the buyer seeing the sale price', 'getFlashSalePrice and recordFlashSalePurchase are the ' +
     'buyer-side path and have their own certification; this proves the merchant ' +
     'surface creates through the real engine instead of a device-local list');
  un('the scheduled auto-end', 'concludeExpiredFlashSales is deployed and runs server-side');

  console.log('\n' + '='.repeat(78));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  console.log('='.repeat(78) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  aborted: ' + (e && e.stack) + '\n'); process.exit(1); });
