#!/usr/bin/env node
/* Admin OS render — RUNTIME proof for the Applications and Shops & Sellers panes.
 *
 *   node scripts/test-admin-os-render.js
 *
 * WHY, GIVEN test-admin-os-wiring.js EXISTS
 * That suite proves the pieces are connected. It cannot prove the code runs:
 * a renderer that throws on the first row, an unescaped id, or a failed read
 * painted as an empty list are all perfectly well-wired. This one loads the real
 * sokoni-aos.js into a minimal DOM, feeds the real renderers canned server
 * payloads, and asserts on the HTML that actually comes out.
 *
 * Specifically it holds three lines that are easy to cross by accident:
 *
 *   1. A FAILED READ MUST NOT LOOK EMPTY. `_call` sites elsewhere in this file
 *      end in `.catch(() => ({ products: [] }))`, which renders "No products"
 *      when the truth is "the read threw". On these panes a rejection must say
 *      so. (CLAUDE.md: never render an unknown as a neutral-looking zero.)
 *   2. A DISPUTED EMPLOYEE ROW MUST BE VISIBLE. firestore.rules lets any
 *      signed-in client create a shopEmployees document, so filtering the
 *      uncorroborated rows away would hide a forgery attempt from the console
 *      most likely to be believed.
 *   3. IDS REACHING INLINE HANDLERS MUST BE ESCAPED on both layers — JS string
 *      inside an HTML attribute. Firestore document ids are not a trusted
 *      alphabet.
 *
 * No browser, no emulator, no credentials.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail !== undefined && detail !== '' ? '   [' + String(detail).slice(0, 170) + ']' : ''));
  ok ? pass++ : fail++;
};

/* ── A DOM small enough to read, big enough for these renderers ──────────── */
function makeEl(id, cls) {
  const el = {
    id: id || '', innerHTML: '', textContent: '', hidden: false, dataset: {},
    className: cls || '', value: '',
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    appendChild() {}, addEventListener() {}, remove() {},
  };
  return el;
}

function makeDom() {
  const byId = new Map();
  const get = (id) => { if (!byId.has(id)) byId.set(id, makeEl(id)); return byId.get(id); };
  return {
    byId,
    document: {
      getElementById: (id) => (byId.has(id) ? byId.get(id) : null),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (t) => makeEl('', t),
      body: { appendChild() {}, classList: makeEl().classList },
      addEventListener() {},
    },
    ensure: get,
  };
}

/* ── Load the real sokoni-aos.js ─────────────────────────────────────────── */
function loadAOS(calls) {
  const dom = makeDom();
  const toasts = [];
  const prompts = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    Date, Math, JSON, Object, Array, String, Number, Boolean, Promise, Map, Set, RegExp, Error, isNaN, parseInt, parseFloat, encodeURIComponent,
    /* Decisions must be confirmed by a human; auto-confirm so the code path runs. */
    confirm: () => true,
    prompt: (q) => { prompts.push(q); return 'because reasons'; },
    alert: () => {},
    firebase: {
      firestore: Object.assign(() => ({ collection: () => ({ where: () => ({ orderBy: () => ({ limit: () => ({ onSnapshot: () => () => {} }) }), onSnapshot: () => () => {}, limit: () => ({ onSnapshot: () => () => {} }) }), onSnapshot: () => () => {} }) }),
        { Timestamp: { fromDate: (d) => d } }),
      functions: () => ({
        /* Dispatch-aware on purpose. Most Admin OS ops are NOT deployed under
           their own names — they ride adminOsDispatch and are addressed by an op
           STRING in the payload. A stub keyed only on callable names would fail
           every dispatched op, which is how this harness was wrong on its first
           run and is exactly the mistake the wiring suite's PART D exists for. */
        httpsCallable: (name) => async (data) => {
          const op = name === 'adminOsDispatch' ? (data && data.op) : name;
          const h = calls[op];
          if (!h) throw new Error(`no stub for callable "${op}"`);
          return { data: await h(data) };
        },
      }),
      auth: () => ({ onAuthStateChanged() { /* never fires: keeps _bootUI out of this test */ } }),
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.document = dom.document;
  sandbox.location = { href: '', assign() {} };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8'), sandbox, { filename: 'sokoni-aos.js' });

  /* Pre-create every container the renderers address. getElementById returns
     null for anything absent, so an element created only AFTER the render would
     silently miss its write — and the assertion on it would read as a code
     defect rather than a harness one. */
  ['appsBody', 'appsSummary', 'appsStatus', 'appsRole', 'appsSearch', 'sidebarAppsBadge',
    'estateBody', 'estateSummary', 'estateSearch', 'modalBody', 'modalTitle', 'aosModal',
  ].forEach(dom.ensure);

  const AOS = sandbox.window.SokoniAOS;
  AOS.init();                                    /* wires _db/_fn/_auth only */

  /* Capture toasts by wrapping the container the toast helper looks for. */
  const origCreate = dom.document.createElement;
  dom.document.createElement = (t) => {
    const el = origCreate(t);
    Object.defineProperty(el, 'textContent', {
      get() { return this._t || ''; },
      set(v) { this._t = v; if (t === 'div') toasts.push(v); },
      configurable: true,
    });
    return el;
  };

  return { AOS, dom, toasts, prompts, sandbox };
}

/* ── Canned server payloads ──────────────────────────────────────────────── */
const APP_PENDING = {
  id: 'SELLER_A--merchant', applicationId: 'SELLER_A--merchant', uid: 'SELLER_A',
  name: 'Shop B Traders', role: 'seller', status: 'pending', category: 'electronics',
  phone: '0726043059', email: 'a@example.com', location: 'Nairobi',
  description: 'Phones and accessories', projectionStatus: 'n/a', receivedAt: 1757200000000,
};
const APP_UNPUBLISHED = Object.assign({}, APP_PENDING, {
  id: 'SELLER_C--merchant', uid: 'SELLER_C', name: 'Ghost Traders',
  status: 'approved', projectionStatus: 'failed', projectionError: 'shop write denied',
});
/* A document id carrying an attribute-breaking payload. Not hypothetical: ids
   reach inline onclick handlers, and Firestore ids are not a trusted alphabet. */
const APP_HOSTILE = Object.assign({}, APP_PENDING, {
  id: `EVIL'"><img src=x onerror=alert(1)>--merchant`,
  uid: 'SELLER_X', name: '<script>alert(2)</script>',
});

(async () => {

console.log('\nPART A — the harness can see (a render test on a dead page passes everything)\n');
{
  const { AOS, dom } = loadAOS({ applicationList: async () => ({ ok: true, items: [APP_PENDING], counts: { pending: 1 }, total: 1 }) });
  ck('A1  SokoniAOS loaded and exposes the new API',
    typeof AOS.loadApplications === 'function' && typeof AOS.decideApplication === 'function'
    && typeof AOS.estateTab === 'function' && typeof AOS.openShop === 'function');
  const body = dom.ensure('appsBody');
  dom.ensure('appsStatus').value = 'pending';
  await AOS.loadApplications();
  ck('A2  the renderer wrote something into #appsBody', body.innerHTML.length > 100, body.innerHTML.length + ' chars');
  ck('A3  ...and it is the applicant, not a placeholder', body.innerHTML.includes('Shop B Traders'));
}

console.log('\nPART B — a failed read never renders as "nothing here"\n');
{
  const { AOS, dom } = loadAOS({ applicationList: async () => { throw new Error('permission-denied'); } });
  const body = dom.ensure('appsBody');
  dom.ensure('appsStatus').value = 'pending';
  await AOS.loadApplications();
  ck('B1  the error is stated', /Could not load applications/i.test(body.innerHTML));
  ck('B2  ...with the reason', /permission-denied/.test(body.innerHTML));
  ck('B3  ...and it does NOT claim there are no applications',
    !/No applications are waiting/i.test(body.innerHTML));
}
{
  const { AOS, dom } = loadAOS({ adminGetShops: async () => { throw new Error('not-found: adminOsDispatch'); } });
  const body = dom.ensure('estateBody');
  await AOS.estateTab('shops');
  ck('B4  a failed shops read says the read failed', /Could not load shops/i.test(body.innerHTML));
  ck('B5  ...and does not present an empty registry', !/No shops match/i.test(body.innerHTML));
}
{
  /* The genuine empty case must still read as empty — the point is that the two
     are DIFFERENT, not that empty is forbidden. */
  const { AOS, dom } = loadAOS({ applicationList: async () => ({ ok: true, items: [], counts: {}, total: 0 }) });
  const body = dom.ensure('appsBody');
  dom.ensure('appsStatus').value = 'pending';
  await AOS.loadApplications();
  ck('B6  a genuinely empty list still reads as empty', /No applications are waiting/i.test(body.innerHTML));
}

console.log('\nPART C — "approved but not published" is visible, because nothing else shows it\n');
{
  const { AOS, dom } = loadAOS({
    applicationList: async (d) => ({ ok: true, items: [APP_UNPUBLISHED], counts: { approved: 1 }, unpublished: 1, total: 1, _asked: d }),
  });
  const body = dom.ensure('appsBody');
  dom.ensure('appsStatus').value = 'unpublished';
  await AOS.loadApplications();
  ck('C1  the unpublished application is shown', body.innerHTML.includes('Ghost Traders'));
  ck('C2  ...flagged as having no live shop', /no live shop/i.test(body.innerHTML));
  ck('C3  ...carrying the server error', /shop write denied/.test(body.innerHTML));
  ck('C4  ...and offers Reconcile', /reconcileApplication/.test(body.innerHTML));
  ck('C5  the summary states the unpublished count',
    /approved but not published/i.test(dom.ensure('appsSummary').textContent),
    dom.ensure('appsSummary').textContent);
}
{
  /* An approved+applied application must NOT be flagged — otherwise the warning
     is decoration and an operator learns to ignore it. */
  const healthy = Object.assign({}, APP_UNPUBLISHED, { projectionStatus: 'applied', projectionError: null });
  const { AOS, dom } = loadAOS({ applicationList: async () => ({ ok: true, items: [healthy], counts: {}, total: 1 }) });
  const body = dom.ensure('appsBody');
  dom.ensure('appsStatus').value = '';
  await AOS.loadApplications();
  ck('C6  a healthy approved application is NOT flagged', !/no live shop/i.test(body.innerHTML));
}

console.log('\nPART D — a hostile document id cannot break out of an inline handler\n');
{
  const { AOS, dom } = loadAOS({ applicationList: async () => ({ ok: true, items: [APP_HOSTILE], counts: { pending: 1 }, total: 1 }) });
  const body = dom.ensure('appsBody');
  dom.ensure('appsStatus').value = 'pending';
  await AOS.loadApplications();
  const html = body.innerHTML;
  ck('D1  no raw <img onerror> survives into the markup', !/<img\s+src=x/i.test(html));
  ck('D2  no raw <script> from the business name survives', !/<script>/i.test(html));
  ck('D3  the id is quote-escaped for the HTML attribute layer', !/onclick="[^"]*'[^"]*"[^>]*>/.test(html) || html.includes('&quot;'));
  ck('D4  the card still renders (escaping did not blank it)', html.includes('aos-card'));
}

console.log('\nPART E — approval reports what the SERVER wrote, never optimism\n');
{
  let asked = null;
  const { AOS, toasts } = loadAOS({
    applicationList: async () => ({ ok: true, items: [APP_PENDING], counts: { pending: 1 }, total: 1 }),
    applicationDecide: async (d) => { asked = d; return { ok: true, status: 'approved', projected: true,
      receipt: { writes: [{ collection: 'shops+sellers', shopId: 'SHOP_B', action: 'created' }] } }; },
  });
  await AOS.loadApplications();
  await AOS.decideApplication('SELLER_A--merchant', 'approve');
  ck('E1  the decision is sent server-side, by id', asked && asked.applicationId === 'SELLER_A--merchant' && asked.decision === 'approve');
  ck('E2  the toast names the shop the server says it created',
    toasts.some((t) => /SHOP_B/.test(t) && /created/.test(t)), toasts.join(' | '));
}
{
  /* Approved, but the receipt carries no shop. This is the state that must NOT
     be celebrated — it is exactly "approved merchant with nowhere to sell". */
  const { AOS, toasts } = loadAOS({
    applicationList: async () => ({ ok: true, items: [APP_PENDING], counts: { pending: 1 }, total: 1 }),
    applicationDecide: async () => ({ ok: true, status: 'approved', projected: true, receipt: { writes: [] } }),
  });
  await AOS.loadApplications();
  await AOS.decideApplication('SELLER_A--merchant', 'approve');
  ck('E3  an approval with no shop in the receipt is NOT reported as success',
    toasts.some((t) => /no shop was reported/i.test(t)), toasts.join(' | '));
}
{
  /* The Seller Agreement refusal — the commonest one, whose remedy is not obvious. */
  const { AOS, toasts } = loadAOS({
    applicationList: async () => ({ ok: true, items: [APP_PENDING], counts: { pending: 1 }, total: 1 }),
    applicationDecide: async () => { throw new Error('This application cannot be approved: the applicant has not accepted the SOKONI Seller Agreement'); },
  });
  await AOS.loadApplications();
  await AOS.decideApplication('SELLER_A--merchant', 'approve');
  ck('E4  the agreement refusal is translated into the action that fixes it',
    toasts.some((t) => /Request info/i.test(t)), toasts.join(' | '));
}
{
  /* Cancelling the reason prompt must abort — a null reason is a withdrawal,
     not a silent rejection with no reason. */
  let called = false;
  const { AOS, sandbox } = loadAOS({
    applicationList: async () => ({ ok: true, items: [APP_PENDING], counts: {}, total: 1 }),
    applicationDecide: async () => { called = true; return { ok: true, status: 'rejected' }; },
  });
  sandbox.prompt = () => null;
  await AOS.loadApplications();
  await AOS.decideApplication('SELLER_A--merchant', 'reject');
  ck('E5  cancelling the reason prompt decides nothing', called === false);
}

console.log('\nPART F — shops, sellers, and the people in them\n');
{
  const { AOS, dom } = loadAOS({
    adminGetShops: async () => ({ source: 'shops', count: 2, active: 1, ownerless: 1, fromApproval: 1, items: [
      { shopId: 'SHOP_B', name: 'Shop B Traders', ownerId: 'SELLER_A', ownerless: false, status: 'active', source: 'application_approval', createdAt: '2026-09-01T00:00:00Z' },
      { shopId: 'ORPHAN_1', name: 'Legacy Shop', ownerId: null, ownerless: true, status: 'active', source: null, createdAt: '2025-01-01T00:00:00Z' },
    ] }),
  });
  const body = dom.ensure('estateBody');
  await AOS.estateTab('shops');
  ck('F1  shops render', body.innerHTML.includes('Shop B Traders') && body.innerHTML.includes('Legacy Shop'));
  ck('F2  an ownerless shop is called out, not left blank', /no owner/i.test(body.innerHTML));
  ck('F3  ...and its row is flagged', /row-warn/.test(body.innerHTML));
  ck('F4  approval-origin shops are distinguishable', /approval/.test(body.innerHTML));
  ck('F5  the summary counts the finding', /ownerless/i.test(dom.ensure('estateSummary').textContent),
    dom.ensure('estateSummary').textContent);
}
{
  const { AOS, dom } = loadAOS({
    adminGetSellers: async () => ({ source: 'sellers', count: 2, active: 1, shopMissing: 1, items: [
      { uid: 'SELLER_A', name: 'Shop B Traders', status: 'active', active: true, shopId: 'SHOP_B', shopMissing: false, declaredShopMissing: false, updatedAt: '2026-09-01T00:00:00Z' },
      { uid: 'SELLER_Z', name: 'Nowhere Trader', status: 'active', active: true, shopId: null, shopMissing: true, declaredShopMissing: false, updatedAt: '2026-09-02T00:00:00Z' },
    ] }),
  });
  const body = dom.ensure('estateBody');
  await AOS.estateTab('sellers');
  ck('F6  sellers render', body.innerHTML.includes('Nowhere Trader'));
  ck('F7  "approved, nowhere to sell from" is stated', /no shop/i.test(body.innerHTML));
  ck('F8  the summary counts it', /with no shop/i.test(dom.ensure('estateSummary').textContent),
    dom.ensure('estateSummary').textContent);
}
{
  const { AOS, dom } = loadAOS({
    adminGetShopDetail: async () => ({ ok: true,
      shop: { shopId: 'SHOP_B', name: 'Shop B Traders', ownerId: 'SELLER_A', ownerless: false, status: 'active', source: 'application_approval', createdAt: '2026-09-01T00:00:00Z' },
      owner: { uid: 'SELLER_A', name: 'Ann', email: 'a@example.com', roles: ['buyer', 'seller'], activeShopId: 'SHOP_B', activeShopMatches: true, sellerRegistered: true },
      employees: [{ id: 'SHOP_B_EMP1', uid: 'EMP1', email: 'e@example.com', name: 'Eve', role: 'cashier', active: true }],
      disputed: [{ id: 'SHOP_B_FORGED', uid: 'ATTACKER', role: 'manager', reasons: ['shopOwnerId does not match the shop owner'] }],
      counts: { employees: 1, disputedEmployees: 1, productsBySellerUid: 50, productsBySellerId: 0, productsByShopId: null, ordersBySellerId: 7 },
    }),
  });
  dom.ensure('modalBody'); dom.ensure('modalTitle');
  await AOS.openShop('SHOP_B');
  const html = dom.ensure('modalBody').innerHTML;
  ck('F9  the shop detail renders the owner', /SELLER_A/.test(html) && /Ann/.test(html));
  ck('F10 corroborated staff are listed', /Eve/.test(html) && /cashier/.test(html));
  ck('F11 a DISPUTED row is shown, not filtered away', /ATTACKER/.test(html) && /fail corroboration/i.test(html));
  ck('F12 ...with the reason it was rejected', /shopOwnerId does not match/.test(html));
  ck('F13 the three product counts are reported separately',
    /Products \(sellerUid\)/.test(html) && /Products \(sellerId\)/.test(html) && /Products \(shopId\)/.test(html));
  /* The distinction CLAUDE.md is built around: an UNKNOWN count renders as —,
     a real zero renders as 0, and the two are never collapsed. Anchored to the
     specific rows so this cannot pass on a stray em-dash elsewhere in the page. */
  const flat = html.replace(/\s+/g, ' ');
  ck('F14 an uncountable field renders as — (null count, not 0)',
    /Products \(shopId\)<\/span><strong>—<\/strong>/.test(flat.replace(/> </g, '><')),
    (flat.match(/Products \(shopId\)[\s\S]{0,60}/) || [''])[0]);
  ck('F15 a real zero still renders as 0',
    /Products \(sellerId\)<\/span><strong>0<\/strong>/.test(flat.replace(/> </g, '><')),
    (flat.match(/Products \(sellerId\)[\s\S]{0,60}/) || [''])[0]);
}
{
  const { AOS, dom } = loadAOS({
    adminGetShopDetail: async () => ({ ok: true,
      shop: { shopId: 'ORPHAN_1', name: 'Legacy Shop', ownerId: null, ownerless: true, status: 'active' },
      owner: null, employees: [], disputed: [], counts: { employees: 0 },
    }),
  });
  dom.ensure('modalBody'); dom.ensure('modalTitle');
  await AOS.openShop('ORPHAN_1');
  const html = dom.ensure('modalBody').innerHTML;
  ck('F16 an ownerless shop says so plainly', /no owner recorded/i.test(html));
  ck('F17 ...and says what it means operationally', /cannot be suspended/i.test(html));
}

console.log('\nPART G — adversarial controls\n');
{
  /* If the DOM stub silently swallowed writes, every assertion above would be
     vacuous. Prove the harness reports a renderer that writes nothing. */
  const dom = makeDom();
  ck('G1  an untouched container is empty (the harness is not pre-filling)', dom.ensure('nobody').innerHTML === '');

  /* Prove an unstubbed callable is a loud failure, not a silent empty render. */
  let threw = false;
  try {
    const { AOS, dom: d2 } = loadAOS({});
    d2.ensure('appsBody'); d2.ensure('appsStatus').value = 'pending';
    await AOS.loadApplications();
    threw = /no stub for callable/.test(d2.ensure('appsBody').innerHTML);
  } catch (_) { threw = true; }
  ck('G2  a missing stub surfaces as an error, not as an empty list', threw);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nsuite crashed:', e.stack, '\n'); process.exit(1); });
