'use strict';
/**
 * CERT — Slice J1: the Merchant V2 Supply workspace module.
 *
 * THE INVARIANTS
 *   1. Every displayed figure comes from an authoritative, merchant-scoped API.
 *   2. An API failure produces a neutral state — never fabricated or zeroed data.
 *   3. An unresolved or ambiguous business BLOCKS rendering; no other business's data
 *      appears, and there is no fallback to activeShopId or localStorage.
 *   4. Unavailable sections cannot render catalogue or supplier information.
 *   5. The UI invents no writes.
 *   6. The workspace stays usable on a phone.
 *
 * METHOD
 *   The real module is EXECUTED against a DOM double and a callable double that records
 *   every invocation, so "did it call anything that writes" and "did it display a figure the
 *   server never sent" are answered by observing behaviour. Static checks appear only where
 *   the property is genuinely textual.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-supply.js'), 'utf8');
/* Prose-vs-code: an earlier version matched these words in the module's own header comment,
   which DOCUMENTS that it never does these things. A detector that flags its documentation is
   a bad detector. */
const stripComments = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const CODE = stripComments(SRC);

let pass = 0, fail = 0, sabotage = 0, sabotageOk = 0;
const failures = [];
const check = (n, c) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); } };
const sab   = (n, c) => { sabotage++; if (c) { sabotageOk++; pass++; console.log('  PASS    (sabotage: ' + n + ')'); } else { fail++; failures.push('SABOTAGE ' + n); console.log('  FAIL    (sabotage: ' + n + ')'); } };

console.log('\nCERT — Slice J1: Supply workspace module\n');

const BIZ_A = 'SOK-AAAA11', BIZ_B = 'SOK-BBBB22';

/* ── A DOM double: enough for innerHTML, listeners, querySelectorAll, closest ── */
function makeEl(tag) {
  const el = {
    tagName: tag, id: '', className: '', textContent: '', _html: '',
    children: [], parentNode: null, _listeners: {},
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    setAttribute(k, v) { this['attr_' + k] = v; },
    getAttribute(k) { return this['attr_' + k]; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    addEventListener(t, f) { (this._listeners[t] = this._listeners[t] || []).push(f); },
    removeEventListener(t, f) { this._listeners[t] = (this._listeners[t] || []).filter((x) => x !== f); },
    querySelectorAll() { return { forEach() {} }; },
    classList: { add() {}, remove() {} },
  };
  return el;
}
function makeDom() {
  const els = {};
  const head = makeEl('head');
  const doc = {
    head,
    createElement: (t) => makeEl(t),
    getElementById: (id) => els[id] || null,
    _register: (id, el) => { els[id] = el; },
  };
  return { doc, els };
}

function load(opts) {
  opts = opts || {};
  const calls = [];
  const dom = makeDom();
  const host = makeEl('div');
  host.ownerDocument = dom.doc;

  /* `sup-main` is looked up by id after each render; serve the same element and let the
     module write into it, which is what we then inspect. */
  const main = makeEl('div');
  dom.doc._register('sup-main', main);

  const sandbox = {
    console, setTimeout, clearTimeout, Date, Math, JSON, Promise, Object, Array,
    String, Number, Error, isFinite,
  };
  sandbox.window = sandbox;
  sandbox.document = dom.doc;
  sandbox.SokoniShell = {
    merchantContext: () => opts.context || { merchantId: BIZ_A, name: 'Alpha Traders', choices: [], error: null, activeShopId: 'shop-A' },
    resolveMerchantContext: async (id) => { opts.picked = id; return id; },
  };
  if (opts.posSuppliers) sandbox.PosSuppliers = opts.posSuppliers;
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
  return { ui, host, main, calls, sandbox, opts };
}
const settle = () => new Promise((r) => setTimeout(r, 5));

(async () => {
  /* ══════════════════════════════════════════════════════════
     §1 POSITIVE — authorized business sees its own data
  ══════════════════════════════════════════════════════════ */
  console.log('§1 POSITIVE');
  {
    const h = load({ callable: async (name) => {
      if (name === 'getProcurementDashboard') {
        return { data: { openPOs: { count: 4, totalValue: 12000 }, pendingApproval: { count: 2 },
                         goodsToReceive: { count: 1 }, pendingInvoices: { count: 3, totalValue: 5000 },
                         overdueInvoices: { count: 0 } } };
      }
      return { data: { items: [], nextCursor: null } };
    } });
    await settle();
    check('the workspace renders its shell', /class="sup"/.test(h.host.innerHTML));
    check('the active business is named in the header', /Alpha Traders/.test(h.host.innerHTML));
    check('all 18 sections are offered', (h.host.innerHTML.match(/data-sec="/g) || []).length === 18);
    check('the overview read is merchant-scoped',
      h.calls.some((c) => c.name === 'getProcurementDashboard' && c.payload.merchantId === BIZ_A));
    check('server figures are displayed', /12,000/.test(h.main.innerHTML) && />4</.test(h.main.innerHTML));
    check('a genuine zero from the server still renders as 0', />0</.test(h.main.innerHTML));
  }
  {
    const h = load({ callable: async (name) => (name === 'listSuppliers'
      /* isSokoniBusiness is computed SERVER-side by listSuppliers; an earlier fixture omitted
         it and so tested a response shape the API never produces. */
      ? { data: { items: [{ supplierId: 's1', name: 'XYZ Traders', phone: '0700', paymentTerms: 30,
                            currentBalance: 4500, status: 'active', supplierBusinessId: BIZ_B,
                            isSokoniBusiness: true }],
                  nextCursor: 'cur-1' } }
      : { data: { items: [] } }) });
    await settle();
    h.host._listeners.click[0]({ target: { closest: (s) => (s === '[data-sec]' ? { getAttribute: () => 'suppliers' } : null) } });
    await settle();
    check('a supplier row renders from server data', /XYZ Traders/.test(h.main.innerHTML));
    check('a SOKONI counterparty is labelled as such', /SOKONI business/.test(h.main.innerHTML));
    check('a next-page control appears when a cursor is returned', /data-more="1"/.test(h.main.innerHTML));
    check('the list read is merchant-scoped',
      h.calls.some((c) => c.name === 'listSuppliers' && c.payload.merchantId === BIZ_A));
  }

  /* ══════════════════════════════════════════════════════════
     §2 NEGATIVE — no other business's data, ever
  ══════════════════════════════════════════════════════════ */
  console.log('\n§2 NEGATIVE — business identity');
  {
    const h = load({ context: { merchantId: null, name: null, error: 'owner-has-multiple-businesses',
      choices: [{ businessId: BIZ_A, name: 'Alpha' }, { businessId: BIZ_B, name: 'Beta' }],
      activeShopId: 'shop-A' } });
    await settle();
    check('AMBIGUOUS: rendering is blocked', /Choose a business/.test(h.host.innerHTML));
    check('AMBIGUOUS: both choices are offered', (h.host.innerHTML.match(/data-choose="/g) || []).length === 2);
    check('AMBIGUOUS: NO data read was attempted', h.calls.length === 0);
    check('AMBIGUOUS: no figures are shown', !/KES/.test(h.host.innerHTML));
  }
  {
    const h = load({ context: { merchantId: null, error: 'no-business-for-owner', choices: [], activeShopId: 'shop-A' } });
    await settle();
    check('NO BUSINESS: an explicit state, not an empty dashboard', /No business on this account/.test(h.host.innerHTML));
    check('NO BUSINESS: no read attempted', h.calls.length === 0);
  }
  {
    const h = load({ context: { merchantId: null, error: 'context-unresolved', choices: [], activeShopId: 'shop-A' } });
    await settle();
    check('UNRESOLVED: blocked with the reason shown', /Business not resolved/.test(h.host.innerHTML));
    check('UNRESOLVED: activeShopId is NOT used as a fallback', !/shop-A/.test(h.host.innerHTML));
    check('UNRESOLVED: no read attempted', h.calls.length === 0);
  }
  check('the module never reads localStorage (code, not prose)', !/localStorage/.test(CODE));
  sab('the comment-stripper does not hide real code',
    /localStorage/.test(stripComments('/* never localStorage */\nvar x = localStorage.getItem("a");')));
  sab('the comment-stripper does remove prose',
    !/localStorage/.test(stripComments('/* we never touch localStorage here */\nvar x = 1;')));
  sab('the detector catches a localStorage identity read',
    /localStorage/.test('var id = localStorage.getItem("merchantId");'));
  check('the module never substitutes activeShopId for merchantId',
    !/merchantId\s*[=:]\s*[^;\n]*activeShopId/.test(SRC));
  sab('the detector catches an activeShopId fallback',
    /merchantId\s*[=:]\s*[^;\n]*activeShopId/.test('state.merchantId = mc.merchantId || mc.activeShopId;'));

  /* ══════════════════════════════════════════════════════════
     §3 failure produces neutral state, never fabricated data
  ══════════════════════════════════════════════════════════ */
  console.log('\n§3 failure honesty');
  {
    const h = load({ callable: async () => { throw new Error('permission-denied'); } });
    await settle();
    check('a failed read shows an explicit failure', /Could not load this section/.test(h.main.innerHTML));
    check('and surfaces the reason', /permission-denied/.test(h.main.innerHTML));
    check('and renders NO numbers', !/KES/.test(h.main.innerHTML));
    check('and renders no fabricated names', !/(Traders|Distributor|Mills|Ltd)/.test(h.main.innerHTML));
  }
  {
    const h = load({ callable: async () => ({ data: { items: [], nextCursor: null } }) });
    await settle();
    h.host._listeners.click[0]({ target: { closest: (s) => (s === '[data-sec]' ? { getAttribute: () => 'pos' } : null) } });
    await settle();
    check('a genuinely empty result says so', /No purchase orders yet/.test(h.main.innerHTML));
    check('and states it is a real empty result, not a placeholder', /not a placeholder/.test(h.main.innerHTML));
  }
  {
    /* A missing figure must render the neutral dash, never 0. */
    const h = load({ callable: async (name) => (name === 'getProcurementDashboard'
      ? { data: { openPOs: {}, pendingApproval: {}, goodsToReceive: {}, pendingInvoices: {}, overdueInvoices: {} } }
      : { data: { items: [] } }) });
    await settle();
    check('an absent figure renders the neutral dash', /—/.test(h.main.innerHTML));
    check('an absent figure is NOT rendered as 0', !/>0</.test(h.main.innerHTML));
    sab('the detector would catch zero-for-unknown', />0</.test('<div class="v">0</div>'));
  }

  /* ══════════════════════════════════════════════════════════
     §4 unavailable sections cannot fabricate
  ══════════════════════════════════════════════════════════ */
  console.log('\n§4 unavailable sections');
  for (const [id, label] of [['find', 'Find Suppliers'], ['catalogue', 'Supply Catalogue']]) {
    const h = load({});
    await settle();
    /* Mounting renders Overview, which legitimately reads. Count only what the UNAVAILABLE
       section itself triggers. */
    const before = h.calls.length;
    h.host._listeners.click[0]({ target: { closest: (s) => (s === '[data-sec]' ? { getAttribute: () => id } : null) } });
    await settle();
    check(label + ': shows an explicit unavailable state', /Not available yet/.test(h.main.innerHTML));
    check(label + ': makes NO server call of its own', h.calls.length === before);
    check(label + ': renders no supplier or product rows', !/<table/.test(h.main.innerHTML));
    check(label + ': renders no prices', !/KES/.test(h.main.innerHTML));
  }
  check('the fabricated B2B catalogue is never referenced (code, not prose)',
    !/sokoni-b2b|wholesalePrice|moq/i.test(CODE));
  sab('the detector catches a reused fabricated catalogue',
    /sokoni-b2b|moq/i.test("var rows = window.__b2bCatalogue; // moq"));
  check('no invented business names ship in the module',
    !/Nairobi Distributor|TechHub|Rift Valley|Kariuki|SolarKe/i.test(SRC));

  /* ══════════════════════════════════════════════════════════
     §5 no invented writes
  ══════════════════════════════════════════════════════════ */
  console.log('\n§5 no writes');
  {
    const h = load({ callable: async () => ({ data: { items: [] } }) });
    await settle();
    for (const sec of ['overview', 'suppliers', 'pos', 'incoming', 'receiving', 'invoices',
                       'payments', 'mysupply', 'bizorders', 'stock', 'movements', 'forecast']) {
      h.host._listeners.click[0]({ target: { closest: (s) => (s === '[data-sec]' ? { getAttribute: () => sec } : null) } });
      await settle();
    }
    const WRITES = /^(create|approve|send|receive|update|delete|set|submit|pay)/i;
    check('EXECUTED: not one write-shaped callable was invoked',
      !h.calls.some((c) => WRITES.test(c.name)));
    check('EXECUTED: every call is a read',
      h.calls.every((c) => /^(list|get)/.test(c.name)));
    check('the module source calls no write endpoint',
      !/(approvePurchaseOrder|sendPurchaseOrder|receiveGoods|approveAndPayInvoice|createSupplierInvoice|setSupplyParticipation)/.test(SRC));
    sab('the detector catches an invented write',
      /approveAndPayInvoice/.test("callable('approveAndPayInvoice')({});"));
  }

  /* ══════════════════════════════════════════════════════════
     §6 payment wording + mobile + lifecycle
  ══════════════════════════════════════════════════════════ */
  console.log('\n§6 wording, responsive, lifecycle');
  check('payments are described as bookkeeping, not a transfer',
    /BOOKKEEPING record/.test(SRC) && /does not itself move money/.test(SRC));
  check('the settlement caveat is stated explicitly',
    /nothing here should be read as funds having moved/.test(SRC));
  sab('the detector would catch a claim that funds moved',
    !/does not itself move money/.test('Payments: money sent to your supplier.'));
  check('time-ordering limitation is disclosed where it applies',
    /Ordered by record id, not by time/.test(SRC));

  check('a phone breakpoint exists', /@media\(max-width:760px\)/.test(SRC));
  check('the nav becomes a horizontal scroller on phones',
    /\.sup-nav\{flex:0 0 auto;display:flex;gap:6px;overflow-x:auto/.test(SRC));
  check('no destination is hidden on phones — only its group label',
    /\.sup-grp\{display:none\}/.test(SRC) && !/\.sup-link\{display:none\}/.test(SRC));
  check('wide tables scroll inside their own container, not the page',
    /\.sup-tbl-wrap\{overflow-x:auto/.test(SRC));

  {
    const h = load({});
    await settle();
    check('destroy() clears the host', (h.ui.destroy(), h.host.innerHTML === ''));
    check('refresh() is exposed for the shell', typeof h.ui.refresh === 'function');
  }

  /* ══════════════════════════════════════════════════════════
     §7 scope discipline
  ══════════════════════════════════════════════════════════ */
  console.log('\n§7 scope');
  const ROUTES = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-routes.js'), 'utf8');
  /* J1 shipped before the route existed — that assertion was correct then. J2 has since
     registered it at tier:'more', so the invariant flips rather than being deleted. */
  check('the Supply route exists and is NOT primary (J2)',
    /id:'supply'/.test(ROUTES) && /id:'supply'[\s\S]{0,120}tier:'more'/.test(ROUTES));
  check('the module is self-contained — it exposes a mount contract',
    /global\.SokoniMerchantSupply = \{ mount: mount/.test(SRC));
  check('it does not require the shell to change to be testable',
    /typeof window !== 'undefined' \? window : this/.test(SRC));

  console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed  ·  ' + sabotageOk + '/' + sabotage + ' sabotage catches');
  if (fail) { console.log('\n  ' + fail + ' FAILURE(S):'); failures.forEach((f) => console.log('    - ' + f)); process.exit(1); }
  console.log('\n  PASS — every figure is authoritative, every gap is visible, nothing is invented.\n');
})().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });
