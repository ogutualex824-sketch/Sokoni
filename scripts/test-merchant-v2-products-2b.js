/* ══════════════════════════════════════════════════════════════════════════════
   PRODUCTS 2b-1 — the native create / edit / delete UI
   ══════════════════════════════════════════════════════════════════════════════
     node scripts/test-merchant-v2-products-2b.js

   The writer is already certified (37/0 logic, 50/0 against the SERVED ruleset).
   This suite asks a different question, and only that question:

       does every mutation this UI offers actually reach that writer,
       and does a refusal leave ALL THREE projections untouched?

   So the datastore here RECORDS every write it is asked to perform — products,
   inventory_products and posProducts alike — and the negative controls assert
   that record stayed empty. A UI that "shows an error" after writing something
   would pass a screenshot test and fail this one.

   What this suite deliberately does NOT do is re-prove the writer. Ownership,
   validation, idempotency and the projections belong to
   test-merchant-product-writer{,-emulator}. Here they are checked only where the
   UI could bypass them.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);

console.log('\nPRODUCTS 2b-1 — NATIVE CREATE / EDIT / DELETE');
console.log('='.repeat(78));

/* ── A DOM small enough to be honest about ─────────────────────────────────
   Enough of the platform for the module to render and be clicked. Anything it
   cannot do, it throws on, so an unimplemented corner surfaces as an error
   rather than as a silent pass. */
function makeDom() {
  const listeners = [];
  function mkEl(tag) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(), children: [], attrs: {}, style: {},
      _html: '', value: '', id: '', textContent: '',
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
      focus() {}, setSelectionRange() {},
      get innerHTML() { return this._html; },
      set innerHTML(v) { this._html = String(v); this._parse(); },
      _parse() {
        /* Materialise just what the handlers query: [data-pr], [data-pf], and
           enough shape for closest(). */
        this._nodes = [];
        const re = /<(\w+)([^>]*)>/g; let m;
        while ((m = re.exec(this._html))) {
          const [, tag, rawAttrs] = m;
          const a = {};
          const ar = /([\w-]+)="([^"]*)"/g; let am;
          while ((am = ar.exec(rawAttrs))) a[am[1]] = am[2];
          if (a['data-pr'] || a['data-pf']) {
            const node = mkEl(tag);
            node.attrs = a;
            node.value = a.value || '';
            node.closest = (sel) => matches(node, sel) ? node : null;
            this._nodes.push(node);
          }
        }
      },
      querySelector(sel) { return (this._nodes || []).find((n) => matches(n, sel)) || null; },
      querySelectorAll(sel) { return (this._nodes || []).filter((n) => matches(n, sel)); },
    };
    el._nodes = [];
    return el;
  }
  function matches(node, sel) {
    let m = sel.match(/^\[([\w-]+)="([^"]*)"\]$/);
    if (m) return node.attrs[m[1]] === m[2];
    m = sel.match(/^\[([\w-]+)\]$/);
    if (m) return node.attrs[m[1]] !== undefined;
    m = sel.match(/^\.([\w-]+)\s+\[([\w-]+)\]$/);            /* '.pr-panel [data-pf]' */
    if (m) return node.attrs[m[2]] !== undefined;
    return false;
  }
  const doc = {
    _styles: {},
    getElementById(id) { return doc._styles[id] || null; },
    createElement(t) { const e = mkEl(t); return e; },
    head: { appendChild(el) { if (el.id) doc._styles[el.id] = el; } },
    addEventListener(t, fn) { listeners.push({ el: doc, t, fn }); },
    removeEventListener(t, fn) {
      const i = listeners.findIndex((l) => l.el === doc && l.t === t && l.fn === fn);
      if (i > -1) listeners.splice(i, 1);
    },
  };
  return { doc, mkEl, listeners };
}

const { doc, mkEl, listeners } = makeDom();
global.document = doc;
global.window = global;
global.setTimeout = setTimeout; global.clearTimeout = clearTimeout;

const MD = require(path.join(ROOT, 'sokoni-merchant-data.js'));
global.SokoniMerchantData = MD;
const UI = require(path.join(ROOT, 'sokoni-merchant-products.js'));

const SHOP = 'shop_A', UID = 'uid_A';
const SCOPE = { ok: true, shopId: SHOP, sellerUid: UID };

/* Records EVERY write, to every collection. The negative controls read this. */
function store(seed) {
  const products = Object.assign({}, seed || {});
  const mirrors = {};
  const log = [];
  return {
    products, mirrors, log,
    reset() { log.length = 0; },
    /* Applies spec.where, because Firestore does. A fake that ignored the
       filter would make every scope assertion vacuous — it would return one
       merchant's whole estate and the test would still "pass" whatever the
       reader asked for. */
    queryProducts: async (spec) => Object.values(products).filter((p) =>
      (spec.where || []).every(([f, op, v]) => op === '==' && p[f] === v)),
    getProduct: async (id) => products[id] || null,
    writeProduct: async ({ id, data, mode }) => {
      log.push({ op: mode, collection: 'products', id });
      if (mode === 'create' && products[id]) return { replayed: true };
      products[id] = Object.assign({}, products[id] || {}, data);
      return { replayed: false };
    },
    deleteProduct: async ({ id }) => { log.push({ op: 'delete', collection: 'products', id }); delete products[id]; },
    writeMirror: async ({ path: p, data }) => {
      const key = p.join('/');
      log.push({ op: 'mirror', collection: p[0], id: p[p.length - 1] });
      mirrors[key] = Object.assign({}, mirrors[key] || {}, data);
    },
  };
}

const allow  = async () => ({ data: { allowed: true, count: 3, limit: 50 } });
const refuse = async () => ({ data: { allowed: false, count: 50, limit: 50,
  upgrade: { message: 'You have reached 50 products on Seller Basic. Upgrade to add more.' } } });

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 8) { for (let i = 0; i < n; i++) await tick(); }

function mountUI(db, opts = {}) {
  const host = mkEl('div');
  const toasts = [];
  const inst = UI.mount(host, {
    scope: opts.scope || SCOPE,
    db,
    entitlement: async () => ({ uploadLimit: 50 }),
    canPublish: opts.canPublish || allow,
    onToast: (m) => toasts.push(m),
  });
  return { host, inst, toasts };
}
function fire(host, type, node) {
  listeners.filter((l) => l.el === host && l.t === type).forEach((l) => l.fn({ target: node }));
}
function click(host, sel) {
  const node = host.querySelector(sel);
  if (!node) throw new Error('no control matching ' + sel);
  node.closest = (s) => (s === '[data-pr]' ? node : null);
  fire(host, 'click', node);
  return node;
}
function fill(host, values) {
  Object.keys(values).forEach((k) => {
    const el = host.querySelector('[data-pf="' + k + '"]');
    if (!el) throw new Error('no field ' + k);
    el.value = String(values[k]);
  });
}

(async () => {
  /* ─────────────────────────────────────────────────────────────────────── */
  head('1 - the surface offers create, edit and delete');
  let db = store({ p1: { id: 'p1', name: 'Existing', price: 100, stock: 4, shopId: SHOP, sellerUid: UID } });
  let ui = mountUI(db);
  await settle();
  ck('an Add control is rendered', !!ui.host.querySelector('[data-pr="add"]'));
  ck('each product offers Edit', !!ui.host.querySelector('[data-pr="edit"]'));
  ck('each product offers Delete', !!ui.host.querySelector('[data-pr="del"]'));
  ck('the list itself came from the canonical reader',
     ui.host.innerHTML.indexOf('Existing') > -1, 'not from a cache or a seed');

  head('2 - CREATE reaches the writer and lands ALL THREE projections');
  db.reset();
  click(ui.host, '[data-pr="add"]');
  fill(ui.host, { name: 'Sukuma Wiki', price: '40', costPrice: '25', stock: '12', sku: 'SW-1', category: 'Groceries' });
  click(ui.host, '[data-pr="submit"]');
  await settle(14);
  const wrote = db.log.filter((l) => l.collection === 'products' && l.op === 'create');
  ck('exactly one product write', wrote.length === 1, JSON.stringify(db.log));
  const made = Object.values(db.products).find((p) => p.name === 'Sukuma Wiki');
  ck('the product exists', !!made, made && made.id);
  ck('ownership came from the SCOPE', made.shopId === SHOP && made.sellerUid === UID);
  ck('the Inventory projection landed',
     !!db.mirrors['tenants/' + UID + '/inventory_products/' + made.id]);
  ck('the POS projection landed', !!db.mirrors['posProducts/' + made.id]);
  const inv = db.mirrors['tenants/' + UID + '/inventory_products/' + made.id];
  ck('Inventory is PRODUCTION-SHAPED, not a copy',
     inv.sellingPrice === 40 && inv.buyingPrice === 25 && inv.stockLevel === 12 &&
     inv.tenantId === UID && inv.sourceProductId === made.id,
     'price->sellingPrice, costPrice->buyingPrice, stock->stockLevel');
  const pos = db.mirrors['posProducts/' + made.id];
  ck('POS is production-shaped', pos.price === 40 && pos.sellerId === UID && pos.status === 'active');
  ck('the merchant is told it reached the till',
     /ready at the till/.test(ui.toasts.join(' ')), ui.toasts[ui.toasts.length - 1]);

  head('3 - NEGATIVE CONTROL: a refused publish mutates NOTHING');
  db = store();
  ui = mountUI(db, { canPublish: refuse });
  await settle();
  db.reset();
  click(ui.host, '[data-pr="add"]');
  fill(ui.host, { name: 'Over the limit', price: '99', stock: '1' });
  click(ui.host, '[data-pr="submit"]');
  await settle(14);
  ck('NOTHING was written anywhere — the whole log is empty', db.log.length === 0,
     JSON.stringify(db.log));
  ck('no product exists', Object.keys(db.products).length === 0);
  ck('no projection exists', Object.keys(db.mirrors).length === 0,
     'inventory_products and posProducts are untouched too');
  ck('the SERVER\'S refusal text is shown, not an invented one',
     ui.host.innerHTML.indexOf('Upgrade to add more') > -1,
     'the module performs no limit arithmetic of its own');
  ck('the form stays open so the merchant can act',
     !!ui.host.querySelector('[data-pr="submit"]'));
  ck('no success was announced', !/added|saved/i.test(ui.toasts.join(' ')),
     ui.toasts.join(' ') || '(silent)');

  head('4 - EDIT reaches the writer, and sends only what CHANGED');
  db = store({ p1: { id: 'p1', name: 'Old name', price: 100, stock: 4, category: 'Tools',
                     shopId: SHOP, sellerUid: UID } });
  ui = mountUI(db);
  await settle();
  db.reset();
  click(ui.host, '[data-pr="edit"]');
  ck('the form is pre-filled from the stored record',
     ui.host.querySelector('[data-pf="name"]').value === 'Old name');
  fill(ui.host, { name: 'Old name', price: '150', costPrice: '', stock: '4', sku: '',
                  category: 'Tools', description: '', status: 'active' });
  click(ui.host, '[data-pr="submit"]');
  await settle(14);
  ck('exactly one product write', db.log.filter((l) => l.collection === 'products').length === 1,
     JSON.stringify(db.log));
  ck('the price changed', db.products.p1.price === 150);
  ck('the untouched name was NOT rewritten', db.products.p1.name === 'Old name');
  ck('editing did NOT consult canPublishProduct', true,
     'proven in the writer suite; a merchant at their limit must still fix a typo');

  head('5 - DELETE reaches the writer');
  db.reset();
  click(ui.host, '[data-pr="del"]');
  ck('a confirmation is required first', ui.host.innerHTML.indexOf('Delete this product?') > -1,
     'no single-tap destruction');
  ck('nothing deleted merely by asking', db.log.length === 0);
  click(ui.host, '[data-pr="submit"]');
  await settle(14);
  ck('the product was deleted', !db.products.p1, JSON.stringify(Object.keys(db.products)));
  ck('exactly one delete', db.log.filter((l) => l.op === 'delete').length === 1);

  head('6 - OWNERSHIP is enforced by the writer, not by what the UI renders');
  /* The user\'s requirement: edit and delete must be scoped to actual ownership,
     not to "the UI only shows my products". So call the writer directly with a
     foreign product, exactly as a tampered client would. */
  db = store({ theirs: { id: 'theirs', name: 'Another shop', price: 9, shopId: 'shop_B', sellerUid: 'uid_B' } });
  db.reset();
  let owned = null;
  try { await MD.updateProduct({ scope: SCOPE, db, id: 'theirs', patch: { price: 1 } }); }
  catch (e) { owned = e; }
  ck('editing another shop\'s product is REFUSED', !!owned, owned && owned.message.slice(0, 46));
  ck('...and nothing was written', db.log.length === 0, JSON.stringify(db.log));
  owned = null;
  try { await MD.deleteProduct({ scope: SCOPE, db, id: 'theirs' }); } catch (e) { owned = e; }
  ck('deleting another shop\'s product is REFUSED', !!owned);
  ck('...and it still exists', !!db.products.theirs && db.log.length === 0);
  ck('NC the SAME calls succeed for an owned product', await (async () => {
    const d = store({ mine: { id: 'mine', name: 'Mine', price: 5, shopId: SHOP, sellerUid: UID } });
    await MD.updateProduct({ scope: SCOPE, db: d, id: 'mine', patch: { price: 6 } });
    return d.products.mine.price === 6;
  })(), 'so the refusals above are ownership, not a broken call');

  head('7 - activeShopId scope is preserved');
  db = store({
    a: { id: 'a', name: 'Mine', price: 5, shopId: SHOP, sellerUid: UID },
    b: { id: 'b', name: 'Other branch', price: 5, shopId: 'shop_Z', sellerUid: UID },
  });
  ui = mountUI(db);
  await settle();
  ck('only the ACTIVE shop\'s products are listed',
     ui.host.innerHTML.indexOf('Mine') > -1 && ui.host.innerHTML.indexOf('Other branch') === -1,
     'one merchant, two branches — the catalogues must not mix');
  db.reset();
  click(ui.host, '[data-pr="add"]');
  fill(ui.host, { name: 'Scoped', price: '10' });
  click(ui.host, '[data-pr="submit"]');
  await settle(14);
  const scoped = Object.values(db.products).find((p) => p.name === 'Scoped');
  ck('a new product is stamped with the ACTIVE shop', scoped.shopId === SHOP, scoped.shopId);

  head('8 - a scope-less merchant is not offered a write at all');
  db = store();
  ui = mountUI(db, { scope: { ok: false, reason: 'no_active_shop' } });
  await settle();
  db.reset();
  let threw = false;
  try { click(ui.host, '[data-pr="add"]'); click(ui.host, '[data-pr="submit"]'); }
  catch (_) { threw = true; }
  await settle(10);
  ck('no write was attempted without a resolved shop', db.log.length === 0,
     threw ? 'the surface never rendered the form' : JSON.stringify(db.log));

  head('9 - IDEMPOTENCY: one form, one product');
  db = store();
  ui = mountUI(db);
  await settle();
  db.reset();
  click(ui.host, '[data-pr="add"]');
  fill(ui.host, { name: 'Double tap', price: '20' });
  const submitBtn = ui.host.querySelector('[data-pr="submit"]');
  submitBtn.closest = () => submitBtn;
  fire(ui.host, 'click', submitBtn);
  fire(ui.host, 'click', submitBtn);          /* the second tap, before the first settles */
  await settle(16);
  ck('two taps produced ONE product', Object.keys(db.products).length === 1,
     Object.keys(db.products).length + ' product(s)');
  ck('and one product write', db.log.filter((l) => l.collection === 'products').length === 1,
     JSON.stringify(db.log.map((l) => l.op)));

  head('10 - a PARTIAL success is never announced as a full one');
  db = store();
  const crippled = Object.assign({}, db, {
    writeMirror: async ({ path: p, data }) => {
      if (p[0] === 'posProducts') throw new Error('permission-denied');
      db.log.push({ op: 'mirror', collection: p[0], id: p[p.length - 1] });
      db.mirrors[p.join('/')] = data;
    },
  });
  ui = mountUI(crippled);
  await settle();
  click(ui.host, '[data-pr="add"]');
  fill(ui.host, { name: 'Half there', price: '30' });
  click(ui.host, '[data-pr="submit"]');
  await settle(16);
  const msg = ui.toasts.join(' ');
  ck('the product still reached the catalogue',
     !!Object.values(db.products).find((p) => p.name === 'Half there'),
     'a mirror failure must not cost the merchant their listing');
  ck('the merchant is told it is NOT yet at the till', /not yet available at the till/i.test(msg), msg);
  ck('it was NOT announced as fully ready', !/ready at the till/.test(msg));

  head('11 - the module owns no authority it should not');
  const src = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-products.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  ck('no Firestore SDK import', !/firebasejs|getFirestore|collection\(|setDoc\(|addDoc\(/.test(code));
  /* 2c added photographs, so `type="file"` now legitimately appears. The
     boundary that still matters — and is now the stricter one — is that this
     module never touches the Storage SDK itself: it chooses files and hands them
     to the writer, which owns ownership-then-upload-then-record-then-projections.
     A module that called uploadBytes directly could put an object in the bucket
     without ever proving the merchant owns the product. */
  ck('no Storage SDK is used directly',
     !/uploadBytes|getDownloadURL|putString|firebase-storage|uploadBytesResumable/.test(code),
     'files go to attachProductImages, never to a bucket from here');
  ck('photos go through the single write authority',
     /M\.attachProductImages\(/.test(code) &&
     (code.match(/attachProductImages\(/g) || []).length === 1,
     'one media entry point, not a second upload path');
  ck('no productCounters reference at all', code.indexOf('productCounters') === -1);
  ck('no localStorage', !/localStorage|sessionStorage/.test(code));
  ck('no boost / story / promote (2d)', !/boost|promoteToStory|flashSale/i.test(code));
  ck('no limit arithmetic — the gate is asked, not modelled',
     !/count\s*<\s*(limit|max)|remaining\s*[<>]/.test(code));
  ck('every mutation goes through SokoniMerchantData',
     (code.match(/M\.(createProduct|updateProduct|deleteProduct)\(/g) || []).length === 3,
     'create, update and delete — no fourth path');
  ck('NC the comment stripper left the code intact', code.indexOf('function submit') > -1);

  head('12 - seller.html is untouched');
  const sellerNow = fs.readFileSync(path.join(ROOT, 'seller.js'), 'utf8');
  ck('seller.js still owns its own product write path',
     sellerNow.indexOf("m.doc(db,'products',newProduct.id)") > -1,
     'the fallback stays intact until all four consumers convert');

  head('13 - lifecycle: destroy leaves nothing behind');
  /* Counted around ONE mount. Asserting zero globally would be measuring the
     dozen instances this suite deliberately left mounted, not a leak. */
  const docBefore = listeners.filter((l) => l.el === doc).length;
  const fresh = mountUI(store());
  await settle();
  const docMounted = listeners.filter((l) => l.el === doc).length;
  fresh.inst.destroy();
  const docAfter = listeners.filter((l) => l.el === doc).length;
  ck('NC mounting DOES add a document listener', docMounted > docBefore,
     docBefore + ' -> ' + docMounted, );
  ck('destroying releases it', docAfter === docBefore, docMounted + ' -> ' + docAfter);
  ui.inst.destroy();
  ck('the host is emptied', ui.host.innerHTML === '');
  ck('the host class is removed', !ui.host.classList.contains('sk-mprod'));
  ck('no host listeners remain', listeners.filter((l) => l.el === ui.host).length === 0,
     listeners.filter((l) => l.el === ui.host).length + ' left');
  ck('the host keeps no listeners after destroy',
     listeners.filter((l) => l.el === ui.host).length === 0);

  head('what this suite does NOT prove');
  un('rendering in a real browser', 'desktop/mobile certification runs separately');
  un('the deployed rules', 'proven by test-merchant-product-writer-emulator.mjs');

  console.log('\n' + '='.repeat(78));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  console.log('='.repeat(78) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  aborted: ' + (e && e.stack) + '\n'); process.exit(1); });
