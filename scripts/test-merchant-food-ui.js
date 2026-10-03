#!/usr/bin/env node
/* FOOD HUB GATE 2 — merchant-v2 Menu / Drinks / Kitchen module (sokoni-merchant-food.js) + its shell wiring.
 *   node scripts/test-merchant-food-ui.js          BASE=fbdcd33 node scripts/test-merchant-food-ui.js (must FAIL)
 * Executes the REAL module in a vm with a minimal DOM. The server is a scripted fake whose every call is recorded, so
 * "the module decides nothing / writes nothing itself" is proven by what it asked for. No browser. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'ignore'] }) : fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 220) + ']')); ok ? pass++ : fail++; };
console.log('\nmerchant-v2 Food UI   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
const SRC = read('sokoni-merchant-food.js');

/* minimal DOM */
function el(tag) {
  const e = { tagName: tag, children: [], attrs: {}, style: {}, innerHTML: '', textContent: '', listeners: {}, hidden: false,
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this); },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null }, hasAttribute(k) { return k in this.attrs; },
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }, removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter((x) => x !== f); },
    querySelector() { return null; }, querySelectorAll() { return []; }, contains() { return true; }, focus() {},
  };
  return e;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };

function harness(opts) {
  const calls = [], toasts = [];
  const doc = { head: el('head'), body: el('body'), getElementById: () => null, createElement: el, defaultView: { confirm: () => true } };
  const ctx = { console, Promise, String, Number, Object, Array, Math, Date, JSON, setTimeout, document: doc, window: null };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  try { vm.runInContext(SRC, ctx); } catch (e) { return { err: e.message }; }
  if (!ctx.SokoniMerchantFood) return { err: 'NO_MODULE' };
  const server = opts.server || {};
  const foodMenu = async (payload) => { calls.push(payload); const h = server[payload.op]; if (!h) throw Object.assign(new Error('no'), { details: { reason: 'UNSCRIPTED' } }); return { data: await h(payload) }; };
  const host = el('div');
  const ui = ctx.SokoniMerchantFood.mount(host, { view: opts.view, scope: { ok: true, shopId: 'shopA' }, onToast: (m) => toasts.push(m), go() {},
    workspace: opts.workspace || (async () => ({ state: 'AVAILABLE', route: 'merchant-v2.html', merchantModules: { menu: { state: 'AVAILABLE' }, drinks: { state: 'AVAILABLE' }, kitchen: { state: 'NOT_IMPLEMENTED', reason: 'FOOD_ORDERS_PENDING' } } })),
    foodMenu, adjustStock: async (p) => { calls.push(Object.assign({ op: '__adjustStock' }, p)); return { ok: true }; }, attachImages: async () => ({}) });
  const root = host.children[0];
  const fire = (type, attrs, value) => {
    const t = { getAttribute: (k) => (k in attrs ? attrs[k] : null), hasAttribute: (k) => k in attrs, value };
    t.closest = () => t;
    (root.listeners[type] || []).forEach((f) => f({ target: t, preventDefault() {} }));
  };
  return { ui, root, calls, toasts, fire, doc };
}
const ITEMS = [
  { id: 'prd_shopA_1', name: '<img src=x onerror=alert(1)>Pilau', price: 300, sectionId: 'mains', kind: 'food', status: 'published', availability: 'available', metered: false, variants: [] },
  { id: 'prd_shopA_2', name: 'Passion juice', price: 120, sectionId: 'soft', kind: 'drinks', status: 'draft', availability: 'available', metered: true, stock: 24, variants: [{ id: '500ml', name: '500ml', price: 180 }] },
  { id: 'prd_shopA_3', name: 'Old dish', price: 90, sectionId: 'mains', kind: 'food', status: 'archived', availability: 'available', metered: false, variants: [] },
];
const SECTIONS = [{ id: 'mains', name: 'Mains', kind: 'food' }, { id: 'soft', name: 'Soft drinks', kind: 'drinks' }];
const loadAs = (role) => ({ load: async () => ({ ok: true, role, sections: SECTIONS, items: ITEMS }), setStatus: async () => ({ ok: true }), setAvailability: async () => ({ ok: true }), archive: async () => ({ ok: true }) });

(async () => {
  let h = harness({ view: 'menu', server: loadAs('owner'), workspace: async () => ({ state: 'PENDING_APPROVAL', route: null, reason: 'NOT_APPROVED', message: 'Your application is with SOKONI for review.', merchantModules: { menu: null } }) });
  if (h.err) { ck('LOAD', false, 'the module loads', h.err); console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed'); process.exit(1); }
  await settle();
  ck('U-1', /with SOKONI for review/.test(h.root.innerHTML) && !h.calls.some((c) => c.op === 'load'), 'PENDING business → the server\'s message; the menu is never loaded', h.calls);
  h = harness({ view: 'menu', server: loadAs('owner'), workspace: async () => ({ state: 'AVAILABLE', route: 'merchant-v2.html', merchantModules: { menu: null, drinks: null, kitchen: null } }) });
  await settle();
  ck('U-2', /Menus are for food businesses/.test(h.root.innerHTML) && !h.calls.length, 'a NON-food business → no menu, no menu call');
  h = harness({ view: 'menu', server: loadAs('owner') });
  await settle();
  const html = h.root.innerHTML;
  ck('U-3', h.calls[0] && h.calls[0].op === 'load' && h.calls[0].shopId === 'shopA' && /Pilau/.test(html) && /Passion juice/.test(html) && !/Old dish/.test(html), 'approved food business → the server\'s menu (archived items hidden)', h.calls);
  ck('U-4', !/<img src=x onerror/.test(html) && /&lt;img src=x onerror=alert\(1\)&gt;Pilau/.test(html), 'server strings are ESCAPED before reaching innerHTML (stored-XSS guard)');
  ck('U-5', /KES 300/.test(html) && /Stock 24/.test(html) && /Not stock-tracked/.test(html) && /Published/.test(html) && /Draft/.test(html), 'price, stock (metered vs not) and publish state are shown from the server answer');
  let hd = harness({ view: 'drinks', server: loadAs('owner') });
  await settle();
  ck('U-6', /Passion juice/.test(hd.root.innerHTML) && !/Pilau/.test(hd.root.innerHTML) && hd.calls.filter((c) => c.op === 'load').length === 1, 'Drinks is a FILTER of the same menu load — drinks only, no second source');

  /* actions: server first, success only after the answer */
  h.fire('click', { 'data-fm': 'pub', 'data-id': 'prd_shopA_2' });
  await settle();
  const pubCall = h.calls.find((c) => c.op === 'setStatus');
  ck('U-7', pubCall && pubCall.itemId === 'prd_shopA_2' && pubCall.status === 'published' && h.calls[h.calls.length - 1].op === 'load' && h.toasts.includes('Published'), 'Publish → setStatus on the server, then reload; the toast follows the server\'s ok', h.calls);
  const failing = Object.assign(loadAs('owner'), { setStatus: async () => { throw Object.assign(new Error('x'), { details: { reason: 'ROLE_NOT_PERMITTED' } }); } });
  let hf = harness({ view: 'menu', server: { load: failing.load, setStatus: async () => { const e = new Error('x'); e.details = { reason: 'ROLE_NOT_PERMITTED' }; throw e; } } });
  await settle();
  const fm = hf.ui; void fm;
  hf.fire('click', { 'data-fm': 'pub', 'data-id': 'prd_shopA_1' });
  await settle();
  ck('U-8', !hf.toasts.includes('Unpublished') && hf.toasts.some((t) => /role cannot/.test(t)), 'a server refusal shows the reason — never a success message', hf.toasts);
  h.fire('change', { 'data-fm': 'avail', 'data-id': 'prd_shopA_1' }, 'temporarily_unavailable:4');
  await settle();
  const av = h.calls.find((c) => c.op === 'setAvailability');
  ck('U-9', av && av.availability === 'temporarily_unavailable' && av.hours === 4, 'availability → setAvailability on the server (with hours)', av);

  /* roles */
  let hc = harness({ view: 'menu', server: loadAs('cashier') });
  await settle();
  ck('U-10', !/data-fm="edit"/.test(hc.root.innerHTML) && !/data-fm="pub"/.test(hc.root.innerHTML) && !/data-fm="archive"/.test(hc.root.innerHTML) && /data-fm="avail"/.test(hc.root.innerHTML),
    'a cashier sees availability only — no edit / publish / archive controls');
  let hs = harness({ view: 'menu', server: loadAs('staff') });
  await settle();
  ck('U-11', !/data-fm="(edit|pub|archive|avail|add|sections)"/.test(hs.root.innerHTML) && /Pilau/.test(hs.root.innerHTML), 'plain staff can read the menu but gets no controls');

  /* kitchen */
  let hk = harness({ view: 'kitchen', server: loadAs('owner') });
  await settle();
  const kh = hk.root.innerHTML;
  ck('U-12', /Kitchen opens with Food ordering/.test(kh) && /NEW/.test(kh) && /PREPARING/.test(kh) && /READY/.test(kh) && !/\b\d+ orders?\b/i.test(kh) && (kh.match(/<span>—<\/span>/g) || []).length === 4 && hk.calls.length === 0,
    'KITCHEN (NOT_IMPLEMENTED) shows the board and the dependency — no orders, no counts (— not 0), no calls');
  let hk2 = harness({ view: 'kitchen', server: loadAs('owner'), workspace: async () => ({ state: 'AVAILABLE', route: 'merchant-v2.html', merchantModules: { menu: null, kitchen: null } }) });
  await settle();
  ck('U-13', /Kitchen is for food businesses/.test(hk2.root.innerHTML), 'a non-food business gets no kitchen board');

  /* failure */
  let he = harness({ view: 'menu', server: loadAs('owner'), workspace: async () => { throw Object.assign(new Error('offline'), { details: { reason: 'WORKSPACE_UNREADABLE' } }); } });
  await settle();
  ck('U-14', /Could not open your menu/.test(he.root.innerHTML) && /data-fm="retry"/.test(he.root.innerHTML) && !/Pilau/.test(he.root.innerHTML), 'unreadable → error + retry; nothing invented');

  /* source: decides nothing, writes nothing itself */
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  ck('U-15', !!SRC && !/setDoc|updateDoc|addDoc|deleteDoc|writeBatch|runTransaction|localStorage|sessionStorage|collection\(/.test(code), 'the module writes no Firestore document and keeps no menu in browser storage');

  /* shell wiring */
  const SH = read('merchant-v2.html'), RT = read('sokoni-merchant-routes.js');
  ck('W-1', /<script src="sokoni-merchant-food\.js"><\/script>/.test(SH) && /menu:\s+\{ global: 'SokoniMerchantFood'/.test(SH) && /drinks:\s+\{ global: 'SokoniMerchantFood'/.test(SH) && /kitchen:\s+\{ global: 'SokoniMerchantFood'/.test(SH),
    'merchant-v2 loads the module and mounts Menu / Drinks / Kitchen through it');
  ck('W-2', /_callable\('foodMenu'\)\(\{ op: 'modules', shopId: sid \}\)/.test(SH) && /b\.hidden = true/.test(SH) && /\.nav-item\[hidden\]/.test(SH),
    'the Food business links start HIDDEN and are revealed only by the server\'s shop-scoped module answer');
  ck('W-3', /\{ id:'menu', name:'Menu'/.test(RT) && /\{ id:'drinks', name:'Drinks'/.test(RT) && /\{ id:'kitchen', name:'Kitchen'/.test(RT) && /ids:\['menu','drinks','kitchen'\]/.test(RT),
    'the route contract declares menu / drinks / kitchen in a Food business group');
  ck('W-4', /attachProductImages\(\{ scope: _scope\(\), db: _mdb, media: window\.SokoniMerchantMedia/.test(SH) && /_callable\('merchantAdjustStock'\)/.test(SH),
    'photos and opening stock reuse the existing product media pipeline and stock authority (no second path)');

  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
