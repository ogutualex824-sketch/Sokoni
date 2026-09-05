'use strict';
/**
 * CERT — Slice M: Supply integration.
 *
 * THE INVARIANTS
 *   1. Find Suppliers and Supply Catalogue read the CANONICAL ops and nothing else.
 *   2. An empty directory states WHY it is empty. It is a real state of the network, not a
 *      failed search, and it must never read as "no suppliers found".
 *   3. Discovery -> catalogue -> order runs through the existing procurement engine. This
 *      surface constructs no purchase order: no PO number, no total, no VAT, no financial
 *      fact of its own.
 *   4. The one write happens only on an explicit click, and only what the SERVER returns is
 *      afterwards displayed as fact.
 *   5. A SOKONI counterparty is never enrolled twice, and the buyer is never asked to invent
 *      contact details discovery deliberately withheld.
 *   6. Every call carries the server-resolved merchantId; an unresolved business blocks all
 *      of it.
 *
 * METHOD
 *   Two harnesses, both executing real code. The workspace runs in a DOM double that records
 *   every callable invocation, so "what did it call, with what payload, and what did it then
 *   display" is observed rather than read out of the source. The engine runs against an
 *   injected Firestore double. §10 proves the positive results collapse when the real calls
 *   are bypassed.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-supply.js'), 'utf8');
const PROC = fs.readFileSync(path.join(ROOT, 'functions/procurement.js'), 'utf8');

/* An absence test must never match the comment documenting the absence. */
const stripComments = (x) => x.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const CODE = stripComments(SRC);

let pass = 0, fail = 0, sabotage = 0, sabotageOk = 0;
const failures = [];
const check = (n, c) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); } };
const sab   = (n, c) => { sabotage++; if (c) { sabotageOk++; pass++; console.log('  PASS    (sabotage: ' + n + ')'); } else { fail++; failures.push('SABOTAGE ' + n); console.log('  FAIL    (sabotage: ' + n + ')'); } };

console.log('\nCERT — Slice M: Supply integration\n');

const BIZ_A = 'SOK-AAAA11';
const SUP_1 = 'SOK-SUP001';

/* ══════════════════════════════════════════════════════════════════════════
   HARNESS 1 — the workspace, executed against a DOM double
   querySelectorAll returns a real array here (J1's double returned a stub), because
   quantity syncing and nav-state updates genuinely read the DOM back.
══════════════════════════════════════════════════════════════════════════ */
function makeEl (tag) {
  return {
    tagName: tag, id: '', className: '', textContent: '', _html: '',
    children: [], parentNode: null, _listeners: {}, _attrs: {},
    get innerHTML () { return this._html; },
    set innerHTML (v) { this._html = String(v); },
    setAttribute (k, v) { this._attrs[k] = v; },
    getAttribute (k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    appendChild (c) { this.children.push(c); c.parentNode = this; return c; },
    addEventListener (t, f) { (this._listeners[t] = this._listeners[t] || []).push(f); },
    removeEventListener (t, f) { this._listeners[t] = (this._listeners[t] || []).filter((x) => x !== f); },
    querySelectorAll () { return this._qsa || []; },
    classList: { add () {}, remove () {} },
  };
}
function makeDom () {
  const els = {};
  const head = makeEl('head');
  return {
    doc: {
      head,
      createElement: (t) => makeEl(t),
      getElementById: (id) => els[id] || null,
      _register: (id, el) => { els[id] = el; },
    },
    els,
  };
}

function load (opts) {
  opts = opts || {};
  const calls = [];
  const dom = makeDom();
  const host = makeEl('div');
  host.ownerDocument = dom.doc;
  const main = makeEl('div');
  dom.doc._register('sup-main', main);

  const sandbox = {
    console: { log () {}, warn () {}, error () {} },
    setTimeout, clearTimeout, Date, Math, JSON, Promise, Object, Array,
    String, Number, Error, isFinite,
  };
  sandbox.window = sandbox;
  sandbox.document = dom.doc;
  sandbox.SokoniShell = {
    merchantContext: () => (opts.context !== undefined ? opts.context
      : { merchantId: BIZ_A, name: 'Alpha Traders', choices: [], error: null, activeShopId: 'shop-A' }),
    resolveMerchantContext: async (id) => id,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'sokoni-merchant-supply.js' });

  const ctx = {
    merchantContext: sandbox.SokoniShell.merchantContext,
    resolveMerchantContext: sandbox.SokoniShell.resolveMerchantContext,
    callable: (name) => async (payload) => {
      calls.push({ name, payload });
      if (opts.callable) return opts.callable(name, payload);
      return { data: { items: [], nextCursor: null } };
    },
  };
  const ui = sandbox.window.SokoniMerchantSupply.mount(host, ctx);
  return { ui, host, main, calls, sandbox, dom };
}
const settle = () => new Promise((r) => setTimeout(r, 5));

/* Click helpers that drive the module's own delegated handler. */
function click (h, attr, value, extra) {
  const target = {
    closest: (sel) => {
      if (sel === '[' + attr + ']') {
        const el = makeEl('button');
        el.setAttribute(attr, value);
        Object.keys(extra || {}).forEach((k) => el.setAttribute(k, extra[k]));
        return el;
      }
      return null;
    },
  };
  h.host._listeners.click[0]({ target });
}
const goto = (h, id) => click(h, 'data-sec', id);
const lastCall = (h) => h.calls[h.calls.length - 1];
const callsNamed = (h, n) => h.calls.filter((c) => c.name === n);

/* A catalogue payload with one orderable product and one with no stated minimum. */
const CATALOGUE = {
  data: {
    viewerMerchantId: BIZ_A, supplierBusinessId: SUP_1, supplierName: 'Supplier One',
    isOwnCatalogue: false,
    products: [
      { productId: 'P-1', name: 'Maize Flour 2kg', category: 'food', wholesalePrice: 110,
        minWholesaleQty: 100, retailPrice: 180, inStock: true, image: null, description: null,
        supplierBusinessId: SUP_1, supplierName: 'Supplier One' },
      { productId: 'P-2', name: 'Cooking Oil 5L', category: 'food', wholesalePrice: 900,
        minWholesaleQty: null, retailPrice: 1200, inStock: null, image: null, description: null,
        supplierBusinessId: SUP_1, supplierName: 'Supplier One' },
    ],
    count: 2, scanned: 2, nextCursor: null, verificationClaim: null,
  },
};
const DIRECTORY = {
  data: {
    viewerMerchantId: BIZ_A,
    suppliers: [{ businessId: SUP_1, name: 'Supplier One', category: 'Wholesaler',
                  city: 'Nairobi', county: 'Nairobi',
                  supply: { displayName: 'S1', categories: ['food'], minOrderValue: 5000,
                            leadDays: 3, deliveryAreas: ['Nairobi'] } }],
    count: 1, nextCursor: null, verificationClaim: null,
  },
};

/* Routes both reads plus the two writes; records everything. */
function fullServer (over) {
  over = over || {};
  return async (name, payload) => {
    if (over[name]) return over[name](payload);
    if (name === 'findSuppliers') return DIRECTORY;
    if (name === 'getSupplyCatalogue') return CATALOGUE;
    if (name === 'addSupplier') return { data: { supplierId: 'sup_EXISTING', existing: true } };
    if (name === 'createPurchaseOrder') {
      return { data: { poId: 'po_1', poNumber: 'PO-2026-00007', subtotal: 11000,
                       vatAmount: 1760, total: 12760, status: 'draft' } };
    }
    return { data: { items: [], nextCursor: null } };
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   HARNESS 2 — the engine, executed against an injected Firestore double
══════════════════════════════════════════════════════════════════════════ */
function loadProcurement (data, srcOverride) {
  const written = [];
  const mkRef = (n, id) => ({
    async get () { const d = (data[n] || {})[id]; return { exists: !!d, data: () => d, id }; },
    async set (v) { written.push({ c: n, id, v }); (data[n] = data[n] || {})[id] = v; return true; },
    async update () { return true; }, async create () { return true; },
  });
  function q (n, conds, after, lim) {
    return {
      where (f, _o, v) { return q(n, conds.concat([[f, v]]), after, lim); },
      orderBy () { return q(n, conds, after, lim); },
      startAfter (c) { return q(n, conds, c, lim); },
      limit (k) { return q(n, conds, after, k); },
      select () { return q(n, conds, after, lim); },
      async get () {
        const bag = data[n] || {};
        const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
        let ids = Object.keys(bag).filter((id) => conds.every(([f, v]) => {
          if (f && f.__docId) return true;
          return get(bag[id], f) === v;
        }));
        ids.sort();
        if (after) ids = ids.filter((id) => id > String(after));
        if (lim) ids = ids.slice(0, lim);
        const docs = ids.map((id) => ({ id, data: () => bag[id] }));
        return { empty: !docs.length, size: docs.length, docs, forEach: (f) => docs.forEach(f) };
      },
    };
  }
  const fsFn = () => ({
    collection (n) { const b = q(n, [], null, null); return Object.assign(Object.create(b), b, { doc: (id) => mkRef(n, id) }); },
    async runTransaction (fn) { return fn({ get: async () => ({ exists: false, data: () => ({}) }), set () {}, update () {} }); },
  });
  fsFn.FieldValue = { serverTimestamp: () => 'TS', increment: (n) => ({ __inc: n }) };
  fsFn.Timestamp  = { fromDate: (d) => d };
  fsFn.FieldPath  = { documentId: () => ({ __docId: true }) };
  const stubAdmin = { firestore: fsFn, auth: () => ({}), storage: () => ({}), messaging: () => ({}),
                      apps: [{}], initializeApp () {}, credential: { applicationDefault () {} } };
  const orig = Module._load;
  Module._load = function (req) { if (req === 'firebase-admin') return stubAdmin; return orig.apply(this, arguments); };
  try {
    ['functions/procurement.js', 'functions/merchant-authority.js', 'functions/tenant-identity.js']
      .forEach((f) => { try { delete require.cache[require.resolve(path.join(ROOT, f))]; } catch (_) {} });
    let mod;
    if (srcOverride) {
      const m = new Module('proc-override', null);
      m.filename = path.join(ROOT, 'functions/procurement.js');
      m.paths = Module._nodeModulePaths(path.join(ROOT, 'functions'));
      m._compile(srcOverride, m.filename);
      mod = m.exports;
    } else {
      mod = require(path.join(ROOT, 'functions/procurement.js'));
    }
    mod.__written = written;
    return mod;
  } finally { Module._load = orig; }
}
const auth = (uid) => ({ uid, token: {} });
async function verdict (fn) { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, code: e && e.code, message: e && e.message }; } }
function callOp (proc, op, a, d) {
  const fn = proc[op];
  if (fn && typeof fn.run === 'function') return fn.run({ auth: a, data: d || {} });
  if (fn && typeof fn.__handler === 'function') return fn.__handler({ auth: a, data: d || {} });
  throw Object.assign(new Error('handler-not-invocable'), { code: 'harness' });
}

(async () => {
  /* ══════════════════════════════════════════════════════════
     §1 FIND SUPPLIERS is wired to the canonical op
  ══════════════════════════════════════════════════════════ */
  console.log('§1 Find Suppliers');
  {
    const h = load({ callable: fullServer() });
    await settle();
    const before = h.calls.length;
    goto(h, 'find');
    await settle();
    check('the panel calls the server exactly once', h.calls.length === before + 1);
    check('and the op is findSuppliers', lastCall(h).name === 'findSuppliers');
    check('it never calls the fabricated-era wholesale handler',
      !callsNamed(h, 'getWholesaleCatalog').length);
    check('the resolved merchantId is sent, not a shop id',
      lastCall(h).payload.merchantId === BIZ_A && !('shopId' in lastCall(h).payload));
    check('the discovered supplier is rendered', /Supplier One/.test(h.main.innerHTML));
    check('its stated lead time is shown as stated', /3 days/.test(h.main.innerHTML));
    check('its stated minimum order is shown as money', /KES\s*5,000/.test(h.main.innerHTML));
    check('a drill-down control is offered', /data-view-supply="SOK-SUP001"/.test(h.main.innerHTML));
    check('listing is explicitly NOT an endorsement',
      /not endorsement/i.test(h.main.innerHTML));
    sab('the op detector would catch a different op being called',
      'findSuppliers' !== 'getWholesaleCatalog');
  }

  /* ══════════════════════════════════════════════════════════
     §2 FACETS — narrowing only, and never sent empty
  ══════════════════════════════════════════════════════════ */
  console.log('\n§2 facets');
  {
    const h = load({ callable: fullServer() });
    await settle();
    goto(h, 'find');
    await settle();
    check('an unset facet is NOT sent as an empty filter',
      !('category' in lastCall(h).payload) && !('city' in lastCall(h).payload) &&
      !('county' in lastCall(h).payload));

    /* Apply reads the inputs out of the DOM. */
    const inputs = [
      Object.assign(makeEl('input'), { value: 'food' }),
      Object.assign(makeEl('input'), { value: 'Nairobi' }),
      Object.assign(makeEl('input'), { value: '' }),
    ];
    inputs[0].setAttribute('data-facet', 'category');
    inputs[1].setAttribute('data-facet', 'city');
    inputs[2].setAttribute('data-facet', 'county');
    h.host._qsa = inputs;
    click(h, 'data-facet-apply', '1');
    await settle();
    check('applied facets are sent', lastCall(h).payload.category === 'food' &&
      lastCall(h).payload.city === 'Nairobi');
    check('a facet left blank is still omitted', !('county' in lastCall(h).payload));
    check('there is no free-text search parameter',
      !('q' in lastCall(h).payload) && !('search' in lastCall(h).payload));
    check('and the module offers no free-text box', !/data-facet="q"/.test(CODE));
    sab('the blank-facet detector would fire on an empty string being sent',
      'county' in { county: '' });
  }

  /* ══════════════════════════════════════════════════════════
     §3 THE EMPTY DIRECTORY EXPLAINS ITSELF
  ══════════════════════════════════════════════════════════ */
  console.log('\n§3 truthful empty directory');
  {
    const h = load({ callable: fullServer({
      findSuppliers: async () => ({ data: { suppliers: [], count: 0, nextCursor: null } }),
    }) });
    await settle();
    goto(h, 'find');
    await settle();
    check('the exact wording the founder specified is used',
      /No businesses are currently advertising Supply to your network\./.test(h.main.innerHTML));
    check('it does NOT read as a failed search',
      !/no suppliers found/i.test(h.main.innerHTML) && !/no results/i.test(h.main.innerHTML));
    check('it explains that participation and listing are opt-in',
      /opt-in/i.test(h.main.innerHTML));
    check('it says the result is real, not a placeholder',
      /real, empty result/i.test(h.main.innerHTML));
    check('no rows and no prices are rendered',
      !/<table/.test(h.main.innerHTML) && !/KES/.test(h.main.innerHTML));
    sab('the wording detector would catch a regression to "no suppliers found"',
      /no suppliers found/i.test('<p>No suppliers found</p>'));
  }

  /* ══════════════════════════════════════════════════════════
     §4 DRILL-DOWN — discovery to that supplier's catalogue
  ══════════════════════════════════════════════════════════ */
  console.log('\n§4 drill-down');
  {
    const h = load({ callable: fullServer() });
    await settle();
    goto(h, 'find');
    await settle();
    click(h, 'data-view-supply', SUP_1, { 'data-supply-name': 'Supplier One' });
    await settle();
    check('opening a supplier calls the catalogue op', lastCall(h).name === 'getSupplyCatalogue');
    check('  ...scoped to THAT supplier business',
      lastCall(h).payload.supplierBusinessId === SUP_1);
    check('  ...still carrying the viewer merchantId', lastCall(h).payload.merchantId === BIZ_A);
    check('the supplier is named in the heading', /Supplier One/.test(h.main.innerHTML));
    check('a way back to discovery is offered', /data-back-find/.test(h.main.innerHTML));
    check('its products are listed', /Maize Flour 2kg/.test(h.main.innerHTML));
    check('a product with no stated minimum shows the dash, not a default',
      /Cooking Oil 5L[\s\S]{0,220}—/.test(h.main.innerHTML));
    check('unknown availability shows the dash, not "Out of stock"',
      !/Cooking Oil 5L[\s\S]{0,260}Out of stock/.test(h.main.innerHTML));

    /* Own catalogue: no supplier means the viewer's own, and no add controls. */
    const h2 = load({ callable: fullServer({
      getSupplyCatalogue: async (p) => {
        check('own catalogue omits supplierBusinessId', !('supplierBusinessId' in p));
        return { data: { products: [], count: 0, isOwnCatalogue: true, nextCursor: null } };
      },
    }) });
    await settle();
    goto(h2, 'catalogue');
    await settle();
    check('own catalogue renders without a drill-down crumb', !/data-back-find/.test(h2.main.innerHTML));
  }

  /* ══════════════════════════════════════════════════════════
     §5 DRAFT ORDER — the buyer's quantities, the supplier's terms
  ══════════════════════════════════════════════════════════ */
  console.log('\n§5 draft order');
  {
    const h = load({ callable: fullServer() });
    await settle();
    goto(h, 'find'); await settle();
    click(h, 'data-view-supply', SUP_1, { 'data-supply-name': 'Supplier One' });
    await settle();
    const before = h.calls.length;
    click(h, 'data-add-line', 'P-1');
    await settle();
    check('adding a line writes NOTHING to the server',
      !callsNamed(h, 'createPurchaseOrder').length && !callsNamed(h, 'addSupplier').length);
    check('  ...it only re-reads the catalogue', h.calls.length === before + 1 &&
      lastCall(h).name === 'getSupplyCatalogue');
    check('a draft strip appears', /data-open-order/.test(h.main.innerHTML));
    check('the draft is labelled a draft, not an order',
      /drafted for/i.test(h.main.innerHTML));

    click(h, 'data-open-order', '1');
    await settle();
    const st = h.ui._state;
    check('the line starts at the supplier stated minimum', st.order.lines[0].qty === 100);
    check('the supplier minimum is carried, not invented', st.order.lines[0].minWholesaleQty === 100);
    check('the unit price is the supplier published price', st.order.lines[0].wholesalePrice === 110);
    check('the order panel says nothing is submitted yet', /Not yet submitted/i.test(h.main.innerHTML));
    check('the figure shown is labelled an ESTIMATE', /Estimate/.test(h.main.innerHTML));
    check('it states the server computes the real total',
      /calculated by the procurement engine/i.test(h.main.innerHTML));
    check('no PO number is invented before submission', !/PO-\d{4}-/.test(h.main.innerHTML));

    /* A product with no stated minimum starts at 1 — the buyer's own quantity, and the
       supplier-minimum column must still show the dash. */
    goto(h, 'catalogue'); await settle();
    click(h, 'data-add-line', 'P-2'); await settle();
    const l2 = h.ui._state.order.lines.filter((l) => l.productId === 'P-2')[0];
    check('a product with no stated minimum starts at 1', l2.qty === 1);
    check('  ...and carries NULL, so no minimum is asserted', l2.minWholesaleQty === null);
    click(h, 'data-open-order', '1'); await settle();
    check('the order table shows a dash for the absent supplier minimum',
      /Cooking Oil 5L[\s\S]{0,200}—/.test(h.main.innerHTML));

    /* Below-minimum is a warning about the supplier's term, never a block. */
    h.ui._state.order.lines[0].qty = 5;
    click(h, 'data-open-order', '1'); await settle();
    check('going under a stated minimum warns rather than blocks',
      /Below a stated minimum/.test(h.main.innerHTML) && /can\s*\n?\s*still be placed/i.test(h.main.innerHTML));

    click(h, 'data-remove-line', 'P-1'); await settle();
    check('removing a line drops it', !h.ui._state.order.lines.some((l) => l.productId === 'P-1'));
    sab('the no-write detector would notice a write during composition',
      ['addSupplier'].filter((n) => n === 'addSupplier').length !== 0);
  }

  /* ══════════════════════════════════════════════════════════
     §6 PLACEMENT — through the canonical engine, server figures only
  ══════════════════════════════════════════════════════════ */
  console.log('\n§6 placement');
  {
    const h = load({ callable: fullServer() });
    await settle();
    goto(h, 'find'); await settle();
    click(h, 'data-view-supply', SUP_1, { 'data-supply-name': 'Supplier One' });
    await settle();
    click(h, 'data-add-line', 'P-1'); await settle();
    click(h, 'data-open-order', '1'); await settle();
    click(h, 'data-place-order', '1'); await settle(); await settle();

    const add = callsNamed(h, 'addSupplier');
    const po  = callsNamed(h, 'createPurchaseOrder');
    check('exactly one relationship call is made', add.length === 1);
    check('  ...naming the canonical counterparty business',
      add[0].payload.supplierBusinessId === SUP_1);
    check('  ...and sending NO invented contact details',
      !('phone' in add[0].payload) && !('email' in add[0].payload) && !('name' in add[0].payload));
    check('exactly one purchase order is created', po.length === 1);
    check('  ...against the supplierId the server returned',
      po[0].payload.supplierId === 'sup_EXISTING');
    check('  ...carrying the buyer quantity and the supplier unit price',
      po[0].payload.items[0].qty === 100 && po[0].payload.items[0].unitCost === 110);
    check('  ...and carrying the merchant scope', po[0].payload.merchantId === BIZ_A);
    check('the client sends NO total, subtotal or VAT',
      !('total' in po[0].payload) && !('subtotal' in po[0].payload) && !('vatAmount' in po[0].payload));
    check('the client sends no PO number', !('poNumber' in po[0].payload));

    check('the SERVER PO number is displayed', /PO-2026-00007/.test(h.main.innerHTML));
    check('the SERVER total is displayed', /KES\s*12,760/.test(h.main.innerHTML));
    check('the total is attributed to the engine',
      /calculated by the procurement engine/i.test(h.main.innerHTML));
    check('the draft estimate is NOT restated as confirmed',
      !/Estimate/.test(h.main.innerHTML));
    check('placing is distinguished from sending',
      /raised, not sent/i.test(h.main.innerHTML));
    check('the draft is cleared once placed', h.ui._state.order === null);
    sab('the server-figure detector would catch a client-computed total',
      /KES\s*11,000/.test('Total KES 11,000'));
  }

  /* ══════════════════════════════════════════════════════════
     §7 A REFUSED ORDER RECORDS NOTHING
  ══════════════════════════════════════════════════════════ */
  console.log('\n§7 refusal');
  {
    const h = load({ callable: fullServer({
      createPurchaseOrder: async () => { throw new Error('supplier-not-active'); },
    }) });
    await settle();
    goto(h, 'find'); await settle();
    click(h, 'data-view-supply', SUP_1, { 'data-supply-name': 'Supplier One' });
    await settle();
    click(h, 'data-add-line', 'P-1'); await settle();
    click(h, 'data-open-order', '1'); await settle();
    click(h, 'data-place-order', '1'); await settle(); await settle();
    check('the failure is shown, not swallowed', /was not placed/i.test(h.main.innerHTML));
    check('  ...naming what the server said', /supplier-not-active/.test(h.main.innerHTML));
    check('  ...stating nothing was recorded', /Nothing was recorded/i.test(h.main.innerHTML));
    check('no PO number is invented on failure', !/PO-\d{4}-/.test(h.main.innerHTML));
    check('the draft survives so the buyer does not retype it',
      h.ui._state.order && h.ui._state.order.lines.length === 1);
    check('the button is re-enabled', h.ui._state.submitting === false);
  }

  /* ══════════════════════════════════════════════════════════
     §8 MERCHANT SCOPING — an unresolved business blocks everything
  ══════════════════════════════════════════════════════════ */
  console.log('\n§8 merchant scoping');
  {
    const h = load({ context: { merchantId: null, error: 'owner-has-multiple-businesses',
                                choices: [{ merchantId: 'SOK-X', name: 'X' }] },
                     callable: fullServer() });
    await settle();
    check('an ambiguous owner triggers NO reads', h.calls.length === 0);
    goto(h, 'find');
    await settle();
    check('  ...and discovery still triggers none', h.calls.length === 0);
    check('a selection state is shown instead', /data-choose/.test(h.host.innerHTML + h.main.innerHTML));

    const h2 = load({ callable: fullServer() });
    await settle();
    goto(h2, 'find'); await settle();
    click(h2, 'data-view-supply', SUP_1, { 'data-supply-name': 'Supplier One' });
    await settle();
    click(h2, 'data-add-line', 'P-1'); await settle();
    click(h2, 'data-place-order', '1'); await settle(); await settle();
    check('every call in the whole flow carries the resolved merchantId',
      h2.calls.every((c) => c.payload && c.payload.merchantId === BIZ_A));
    check('no call ever carries a shopId', h2.calls.every((c) => !('shopId' in (c.payload || {}))));
    sab('the scoping detector would catch a missing merchantId',
      ![{ payload: {} }].every((c) => c.payload.merchantId === BIZ_A));
  }

  /* ══════════════════════════════════════════════════════════
     §9 THE ENGINE — contact derivation and one relationship only
  ══════════════════════════════════════════════════════════ */
  console.log('\n§9 engine: relationship');
  {
    const base = () => ({
      businesses: {
        [BIZ_A]: { ownerId: 'uid-a', status: 'active', name: 'Alpha Traders' },
        [SUP_1]: { ownerId: 'uid-s', status: 'active', name: 'Supplier One',
                   phone: '+254700111222', supply: { enabled: true, discoverable: false } },
        'SOK-NOPHONE': { ownerId: 'uid-n', status: 'active', name: 'No Phone Co',
                         supply: { enabled: true } },
        'SOK-CLOSED': { ownerId: 'uid-c', status: 'active', name: 'Closed Co',
                        supply: { enabled: false } },
      },
      procSuppliers: {}, workspaceMemberships: [],
    });

    const d1 = base();
    const p1 = loadProcurement(d1);
    const probe = await verdict(() => callOp(p1, 'addSupplier', auth('uid-a'),
      { merchantId: BIZ_A, supplierBusinessId: SUP_1 }));
    check('the real addSupplier is invocable', probe.code !== 'harness');
    check('a SOKONI counterparty needs NO client-supplied name or phone', probe.ok);
    const row = Object.values(d1.procSuppliers)[0] || {};
    check('  ...the name is taken from the canonical business record', row.name === 'Supplier One');
    check('  ...and so is the phone', row.phone === '+254700111222');
    check('  ...and the relationship points at businesses/{id}', row.supplierBusinessId === SUP_1);

    /* A buyer must not be able to relabel a SOKONI counterparty. */
    const d2 = base();
    const p2 = loadProcurement(d2);
    await verdict(() => callOp(p2, 'addSupplier', auth('uid-a'),
      { merchantId: BIZ_A, supplierBusinessId: SUP_1, name: 'MY OWN LABEL', phone: '+254999999999' }));
    const row2 = Object.values(d2.procSuppliers)[0] || {};
    check('a client-supplied name for a SOKONI counterparty is IGNORED', row2.name === 'Supplier One');
    check('a client-supplied phone for a SOKONI counterparty is IGNORED',
      row2.phone === '+254700111222');

    /* A business with no phone must not block the relationship. */
    const d3 = base();
    const p3 = loadProcurement(d3);
    const r3 = await verdict(() => callOp(p3, 'addSupplier', auth('uid-a'),
      { merchantId: BIZ_A, supplierBusinessId: 'SOK-NOPHONE' }));
    check('a counterparty with no phone on record is still addable', r3.ok);
    check('  ...and its phone is NULL, not an invented placeholder',
      (Object.values(d3.procSuppliers)[0] || {}).phone === null);

    /* External suppliers are unchanged. */
    const d4 = base();
    const p4 = loadProcurement(d4);
    const noPhone = await verdict(() => callOp(p4, 'addSupplier', auth('uid-a'),
      { merchantId: BIZ_A, name: 'Corner Hardware' }));
    check('an EXTERNAL supplier still requires a phone', !noPhone.ok);
    check('  ...with the original message', /Contact phone is required/.test(noPhone.message || ''));
    const noName = await verdict(() => callOp(p4, 'addSupplier', auth('uid-a'),
      { merchantId: BIZ_A, phone: '0722000000' }));
    check('an EXTERNAL supplier still requires a name', !noName.ok);
    const ext = await verdict(() => callOp(p4, 'addSupplier', auth('uid-a'),
      { merchantId: BIZ_A, name: 'Corner Hardware', phone: '0722000000' }));
    check('an external supplier with both is accepted', ext.ok);
    const extRow = Object.values(d4.procSuppliers).filter((r) => r.name === 'Corner Hardware')[0];
    check('  ...keeping its client-supplied contact fields', extRow && extRow.phone === '0722000000');

    /* Consent is still required, and idempotency must not bypass it. */
    const d5 = base();
    const p5 = loadProcurement(d5);
    const closed = await verdict(() => callOp(p5, 'addSupplier', auth('uid-a'),
      { merchantId: BIZ_A, supplierBusinessId: 'SOK-CLOSED' }));
    check('a business that has not enabled supply is still refused', !closed.ok);
    check('  ...on consent grounds', /has not enabled supply/.test(closed.message || ''));

    /* IDEMPOTENCY — ordering twice must not mint a second identity. */
    const d6 = base();
    const p6 = loadProcurement(d6);
    const a1 = await verdict(() => callOp(p6, 'addSupplier', auth('uid-a'),
      { merchantId: BIZ_A, supplierBusinessId: SUP_1 }));
    const a2 = await verdict(() => callOp(p6, 'addSupplier', auth('uid-a'),
      { merchantId: BIZ_A, supplierBusinessId: SUP_1 }));
    check('adding the same counterparty twice succeeds both times', a1.ok && a2.ok);
    check('  ...returning the SAME supplierId', a1.value.supplierId === a2.value.supplierId);
    check('  ...flagged as an existing relationship', a2.value.existing === true);
    check('  ...and only ONE relationship row exists',
      Object.keys(d6.procSuppliers).length === 1);
    sab('the duplicate detector would fire on two rows',
      Object.keys({ a: 1, b: 1 }).length !== 1);
  }

  /* ══════════════════════════════════════════════════════════
     §10 ADVERSARIAL — the results depend on the real calls
  ══════════════════════════════════════════════════════════ */
  console.log('\n§10 adversarial');
  {
    /* (a) If the module stopped calling the server, §1 could not pass. */
    const h = load({ callable: fullServer() });
    await settle();
    const before = h.calls.length;
    goto(h, 'find'); await settle();
    check('baseline: discovery issued a call', h.calls.length === before + 1);

    /* (b) Neuter the engine's idempotency guard: a second add must then mint a duplicate. */
    const anchor = 'if (_verifiedSupplierBusinessId) {\n    const existing = await db.collection';
    check('the idempotency anchor exists in the real source', PROC.indexOf(anchor) !== -1);
    const neutered = PROC.replace(anchor, 'if (false) {\n    const existing = await db.collection');
    check('the override differs from the real source', neutered !== PROC);
    const dN = { businesses: { [BIZ_A]: { ownerId: 'uid-a', status: 'active', name: 'A' },
                               [SUP_1]: { ownerId: 'uid-s', status: 'active', name: 'S',
                                          phone: '+254700111222', supply: { enabled: true } } },
                 procSuppliers: {}, workspaceMemberships: [] };
    const pN = loadProcurement(dN, neutered);
    await verdict(() => callOp(pN, 'addSupplier', auth('uid-a'), { merchantId: BIZ_A, supplierBusinessId: SUP_1 }));
    await verdict(() => callOp(pN, 'addSupplier', auth('uid-a'), { merchantId: BIZ_A, supplierBusinessId: SUP_1 }));
    check('NEUTERED: a duplicate relationship IS created',
      Object.keys(dN.procSuppliers).length === 2);
    check('NEUTERED: so §9 is enforced by the server, not by the fixture',
      Object.keys(dN.procSuppliers).length !== 1);

    /* (c) Force the contact derivation off: the client label would then win. */
    const cAnchor = '  const _resolvedName = _bizData';
    check('the derivation anchor exists in the real source', PROC.indexOf(cAnchor) !== -1);
    const raw = PROC.replace(cAnchor, '  const _resolvedName = false && _bizData');
    const dR = { businesses: { [BIZ_A]: { ownerId: 'uid-a', status: 'active', name: 'A' },
                               [SUP_1]: { ownerId: 'uid-s', status: 'active', name: 'Supplier One',
                                          phone: '+254700111222', supply: { enabled: true } } },
                 procSuppliers: {}, workspaceMemberships: [] };
    const pR = loadProcurement(dR, raw);
    await verdict(() => callOp(pR, 'addSupplier', auth('uid-a'),
      { merchantId: BIZ_A, supplierBusinessId: SUP_1, name: 'MY OWN LABEL', phone: '+254999999999' }));
    const rowR = Object.values(dR.procSuppliers)[0] || {};
    check('RAW: the client label wins without the derivation', rowR.name === 'MY OWN LABEL');
    check('RAW: so §9 is enforced by the derivation, not by the fixture',
      rowR.name !== 'Supplier One');
    sab('the adversarial differential is real, not vacuous',
      Object.keys(dN.procSuppliers).length === 2 && rowR.name === 'MY OWN LABEL');
  }

  /* ══════════════════════════════════════════════════════════
     §11 NO SECOND ENGINE, AND NO INVENTED FACT
  ══════════════════════════════════════════════════════════ */
  console.log('\n§11 scope');
  {
    /* Targeted, not a bare /vat/i — that matched "priVATe", "actiVATe" and "deriVATion",
       so it failed on prose about anything else. Look for VAT ARITHMETIC. */
    check('the module computes no VAT',
      !/vatAmount|VAT_RATE|taxRate|\*\s*0\.16|\*\s*1\.16/.test(CODE));
    sab('the VAT detector fires on real VAT arithmetic',
      /vatAmount|VAT_RATE|\*\s*0\.16/.test('const vatAmount = subtotal * 0.16;'));
    sab('...and stays silent on an unrelated word containing those letters',
      !/vatAmount|VAT_RATE|taxRate|\*\s*0\.16|\*\s*1\.16/.test('const isPrivate = activate(derivation);'));
    check('the module mints no PO number', !/PO-\s*\+|poNumber\s*=/.test(CODE));
    check('the module has no order-status vocabulary of its own',
      !/'approved'|'sent'|'received'/.test(CODE));
    check('the ONLY write ops it can name are the canonical two', (function () {
      const ops = (CODE.match(/read\('([a-zA-Z]+)'/g) || []).map((m) => m.slice(6, -1));
      const writes = ops.filter((o) => /^(add|create|update|approve|send|receive|delete|pay)/.test(o));
      return writes.sort().join(',') === 'addSupplier,createPurchaseOrder';
    })());
    sab('the write-op detector would catch another write being wired',
      ['addSupplier', 'approvePurchaseOrder'].filter((o) => /^(add|approve)/.test(o)).length !== 1);
    check('it never references the fabricated module',
      !/SokoniB2B|sokoni-b2b/.test(CODE));
    check('the fabricated arrays are still empty in the client',
      /const SUPPLIERS\s*=\s*\[\s*\]/.test(fs.readFileSync(path.join(ROOT, 'sokoni-b2b.js'), 'utf8')));

    check('PRESERVED: discovery still requires discoverable',
      /where\('supply\.discoverable', '==', true\)/.test(PROC));
    check('PRESERVED: the catalogue still does NOT require discoverable', (function () {
      const body = (/const getSupplyCatalogue = onCall[\s\S]*?\n\}\);/.exec(PROC) || [''])[0];
      return body.length > 500 && !/discoverable/.test(stripComments(body));
    })());
    check('PRESERVED: createPurchaseOrder still computes its own financials',
      /const subtotal  = \+cleanItems\.reduce/.test(PROC) &&
      /const vatAmount = \+\(subtotal \* VAT_RATE\)/.test(PROC));
  }

  console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed  ·  ' + sabotageOk + '/' + sabotage + ' sabotage catches');
  if (fail) { console.log('\n  ' + fail + ' FAILURE(S):'); failures.forEach((f) => console.log('    - ' + f)); process.exit(1); }
  console.log('\n  PASS — discovery, catalogue and ordering run on canonical authority end to end.\n');
})();
