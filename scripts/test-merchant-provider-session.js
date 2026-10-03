#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   test-merchant-provider-session.js — merchant-v2 PROVIDER SESSION + GROUP GATE
   ══════════════════════════════════════════════════════════════════════════════
   Owner decision 2026-10-03: ONE shell for merchants AND providers. This suite proves
   the SHELL half (sokoni-b2 builds the Marketing module separately):

     C  contract   sessions key (default ['merchant']), requires key, mountRefusal(),
                   validate() rejecting bad sessions/requires and ungated exposure
     M  mapping    sokoni-merchant-session.js: server answer -> capabilities, STRICT
                   `marketing === true`, approval-gated modules, honest notices
     S  session    the REAL resolveShop/resolveProviderSession source from merchant-v2.html
                   executed in a VM over a fake Firestore + fake callables
     N  navigation the REAL mountRefusal/buildSidebar/buildBottomNav/go/refuseRoute and
                   the session-projection listener, over a minimal fake DOM
     G  group gate a contract variant with a requires:'marketing' group
     X  negative controls — each sabotage must turn a NAMED row red:
          X-a  provider session mounts a merchant-only route  -> row N3 fails
          X-b  'marketing' derived from client providers fields -> row S6 fails
          X-c  group gate fails OPEN on error                   -> row G4 fails
          X-d  'marketing' granted for a truthy non-boolean      -> row M3 fails
          X-e  edit authority treats a MISSING editable as editable -> row E3 fails
          X-f  shell fails OPEN when the workspace answer is missing -> row E14 fails
     E  editable  P0-F (owner 2026-10-03): sokoni-edit-authority.js decide() matrix (every
                  ownerState × editable missing/false/true, interim claim/approval rule) and
                  S.editable in the REAL resolveProviderSession

   No browser, no emulator, no network. node scripts/test-merchant-provider-session.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ck = (l, ok, got) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [got ' + JSON.stringify(got) + ']'));
  ok ? pass++ : fail++;
};

const SHELL_SRC = read('merchant-v2.html');
const ROUTES_SRC = read('sokoni-merchant-routes.js');
const SESSION_SRC = read('sokoni-merchant-session.js');
const EDIT_SRC = read('sokoni-edit-authority.js');

function slice (src, from, to) {
  const a = src.indexOf(from); const b = src.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error('marker not found: ' + (a < 0 ? from : to));
  return src.slice(a, b);
}

/* ── loaders ─────────────────────────────────────────────────────────────── */
function loadContract (src) {
  const c = { console }; c.window = c; vm.createContext(c);
  vm.runInContext(src || ROUTES_SRC, c, { filename: 'routes.js' });
  return c.SokoniMerchantRoutes;
}
function loadEditAuthority (src) {
  const c = { console }; c.window = c; vm.createContext(c);
  vm.runInContext(src || EDIT_SRC, c, { filename: 'edit-authority.js' });
  return c.SokoniEditAuthority;
}
function loadSessionModule (src, opts) {
  const c = { console }; c.window = c; vm.createContext(c);
  if (!(opts && opts.noEditAuthority)) vm.runInContext((opts && opts.editSrc) || EDIT_SRC, c, { filename: 'edit-authority.js' });
  vm.runInContext(src || SESSION_SRC, c, { filename: 'session.js' });
  return c.SokoniMerchantSession;
}

/* A gated-group variant of the REAL contract: one provider-capable route behind
   requires:'marketing' — the shape sokoni-b2's mkt-* routes will take. */
const GATED_ROUTE = "    { id:'mkt-test', name:'Marketing services', icon:'📣', tier:'more', kind:'native',\n" +
  "      role:['seller','merchant'], ctx:[CTX.SELLER_UID], sessions:['merchant','provider'],\n" +
  "      mobile:true, desktop:true, activeKey:'mkt-test' },\n";
function gatedRoutesSrc (requiresLiteral) {
  return ROUTES_SRC
    .replace("  ];\n\n  /* THE canonical sidebar order.", GATED_ROUTE + "  ];\n\n  /* THE canonical sidebar order.")
    .replace("  var MORE_GROUPS = [\n", "  var MORE_GROUPS = [\n    { key:'mktsvc', label:'Marketing services', requires:" + requiresLiteral + ", ids:['mkt-test'] },\n");
}

/* ── minimal fake DOM ────────────────────────────────────────────────────── */
function el (tag) {
  const e = {
    tag, children: [], dataset: {}, style: {}, attrs: {}, className: '', textContent: '', parentNode: null,
    _html: '',
    appendChild (c) { if (c && c.isFrag) { c.children.forEach((x) => { x.parentNode = e; e.children.push(x); }); c.children = []; } else { c.parentNode = e; e.children.push(c); } return c; },
    insertBefore (c) { c.parentNode = e; e.children.unshift(c); return c; },
    remove () { if (e.parentNode) e.parentNode.children = e.parentNode.children.filter((x) => x !== e); e.parentNode = null; },
    setAttribute (k, v) { e.attrs[k] = v; },
  };
  Object.defineProperty(e, 'innerHTML', { get () { return e._html; }, set (v) { e._html = v; if (v === '') e.children = []; } });
  return e;
}
function fakeDoc () {
  const ids = {};
  const col = el('div');
  ['side-nav', 'side-foot', 'bnav', 'content'].forEach((k) => { ids[k] = el(k); ids[k].id = k; col.appendChild(ids[k]); });
  return {
    ids,
    getElementById: (k) => ids[k] || null,
    createElement: (t) => el(t),
    createDocumentFragment: () => Object.assign(el('#frag'), { isFrag: true }),
  };
}
const navIds = (doc) => doc.ids['side-nav'].children.filter((c) => c.tag === 'button').map((c) => c.dataset.route);
const navHeads = (doc) => doc.ids['side-nav'].children.filter((c) => c.tag === 'div').map((c) => c.textContent);
const footIds = (doc) => doc.ids['side-foot'].children.filter((c) => c.tag === 'button').map((c) => c.dataset.route);
const bnavIds = (doc) => doc.ids['bnav'].children.map((c) => c.dataset.route);

/* ── the shell harness: REAL shell source, stubbed surroundings ──────────── */
function shellHarness (opts) {
  const o = opts || {};
  const shell = o.shellSrc || SHELL_SRC;
  const CONTRACT = o.contract || loadContract();
  const SMS = o.noSessionModule ? undefined : loadSessionModule(o.sessionSrc, { noEditAuthority: o.noEditAuthority, editSrc: o.editSrc });
  const docs = o.docs || {};
  const log = { reads: [], calls: [], rendered: [], framed: [], refused: [], exits: [], toasts: [] };
  const doc = fakeDoc();

  const S = { state: 'in', shopError: null, uid: o.uid || 'u1', email: 'p@example.test', sellerUid: o.uid || 'u1',
    activeShopId: null, shop: null, roles: [], capabilities: [], servedBy: null,
    merchantId: null, merchantError: null,
    session: null, workspace: null, sessionNotice: null, providerName: null, providerError: null };

  const fsApi = {
    doc: (db, c, id) => ({ c, id }),
    getDoc: async (ref) => {
      log.reads.push(ref.c + '/' + ref.id);
      const k = ref.c + '/' + ref.id;
      if (o.throwOn && o.throwOn[k]) { const e = new Error('boom'); e.code = o.throwOn[k]; throw e; }
      const d = docs[k];
      return { id: ref.id, exists: () => d !== undefined, data: () => d };
    },
  };
  const callables = o.callables || {};
  const _callable = (name) => (payload) => {
    log.calls.push({ name, payload });
    const h = callables[name];
    if (!h) { const e = new Error('no callable ' + name); e.code = 'functions/not-found'; return Promise.reject(e); }
    return Promise.resolve().then(() => h(payload));
  };

  const ctx = {
    console: { log () {}, warn () {}, error () {} },
    window: { SokoniMerchantSession: SMS, __sokoniAppCheckReady: Promise.resolve() },
    document: doc, location: { hash: o.hash || '', pathname: '/merchant-v2' },
    history: { pushState (s, t, h) { ctx.location.hash = h; }, replaceState (s, t, h) { ctx.location.hash = h; } },
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout () {}, Promise,
    CONTRACT, S, log, _callable,
    sdk: async () => ({ fs: fsApi, db: {}, authI: o.claims === undefined ? null : { currentUser: { getIdTokenResult: async () => {
      if (o.claims === 'throw') throw new Error('token');
      return { claims: o.claims };
    } } } }),
    resolveMerchantContext: async () => null,
    byId: {}, panels: {}, current: null, content: doc.ids.content, titleEl: { textContent: '' },
    setActive () {}, openDrawer () {},
    nativePanel (id) { const k = 'native:' + id; if (!ctx.panels[k]) { const p = el('panel'); p.id = 'panel-' + id; ctx.panels[k] = p; } return ctx.panels[k]; },
    framePanel (key) { log.framed.push(key); return el('frame'); },
    showOnly (p) { ctx.shown = p; },
    renderNative (id) { log.rendered.push(id); },
    toast (m) { log.toasts.push(m); },
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    localStorage: { getItem () { return '1'; } },
    loadDevices () {}, paintStatus () {}, broadcastSession () {}, autoConnectPrinter () { log.printer = true; },
    renderOrders () {}, renderDashboard () { log.rendered.push('dashboard'); }, ORD: {},
    _listeners: { session: [] },
  };
  CONTRACT.ROUTES.forEach((r) => { ctx.byId[r.id] = r; });
  vm.createContext(ctx);

  const code = [
    'var booted = false; var _bootImplicit = ' + (o.bootImplicit ? 'true' : 'false') + ', _navCount = 0;',
    slice(shell, '  function can (capability) {', '  /* ONE display-name authority'),
    slice(shell, '  function merchantDisplayName () {', '  var _mods = null'),
    slice(shell, '  /* ── SESSION + GROUP GATE (owner 2026-10-03)', '  /* ── DRAWER + COLLAPSE'),
    slice(shell, '  function leaveShell (rid, sessionEnded) {', '  function go (id) {')
      .replace('location.assign(exitTarget(m));', 'log.exits.push(rid);'),
    slice(shell, '  function go (id) {', '  window.__mgo = go;'),
    slice(shell, '  async function resolveShop () {', '  /* ── PROVIDER SESSION'),
    slice(shell, '  async function resolveProviderSession (m) {', '  /* ── MERCHANT (business) CONTEXT'),
    slice(shell, '  /* ── SESSION PROJECTION', '  /* Public surface for modules'),
    'this.__api = { can: can, go: go, mountRefusal: mountRefusal, resolveShop: resolveShop, projectNav: projectNav,' +
    ' buildSidebar: buildSidebar, buildBottomNav: buildBottomNav, navSignature: navSignature, merchantDisplayName: merchantDisplayName,' +
    ' getCurrent: function () { return current; }, setCurrent: function (c) { current = c; }, setNav: function (n) { _navCount = n; },' +
    ' setNavSig: function (s) { _navSig = s; }, refused: function () { return _refused; }, emit: function () { _listeners.session.forEach(function (f) { f(); }); } };',
  ].join('\n');
  /* `current` must be a binding the extracted functions close over */
  vm.runInContext('var current = null;\n' + code.replace(/\bctx\.current\b/g, 'current'), ctx, { filename: 'merchant-v2.extract.js' });
  const api = ctx.__api;
  /* boot projection, as the real boot does */
  api.buildSidebar(); api.buildBottomNav(); api.setNavSig(api.navSignature());
  return { ctx, S, log, doc, api, CONTRACT };
}

/* ── fixtures ────────────────────────────────────────────────────────────── */
const AVAILABLE = (keys) => Object.fromEntries(keys.map((k) => [k, { state: 'AVAILABLE', reason: null }]));
const routedAnswer = (extra) => Object.assign({
  found: true, state: 'AVAILABLE', reason: null, label: 'Marketing agency', category: 'marketing_agency',
  route: 'provider-dashboard.html', approval: { state: 'VALID_APPROVAL' },
  modules: Object.assign(AVAILABLE(['overview', 'messages', 'marketing', 'reviews']),
    { pos: { state: 'NOT_IMPLEMENTED', reason: 'BUSINESS_IDENTITY_PENDING' }, staff: { state: 'NOT_APPLICABLE', reason: null } }),
  serviceCapabilities: [],
}, extra || {});
const holdingAnswer = (extra) => Object.assign({
  found: true, state: 'PENDING_APPROVAL', reason: 'NOT_APPROVED', message: 'Your application is with SOKONI for review.',
  approval: { state: 'PENDING_APPROVAL' }, modules: Object.assign(AVAILABLE(['overview', 'settings']), { messages: { state: 'PENDING_APPROVAL', reason: 'NOT_APPROVED' } }),
}, extra || {});

(async function main () {
  /* ════ C — CONTRACT ════ */
  console.log('\nC  contract: sessions + requires');
  const C = loadContract();
  ck('C1  validate() is clean on the real contract', C.validate().length === 0, C.validate());
  /* C2 (refined 2026-10-03, rate cards): the rule was always about what a provider reaches
     WITHOUT a server grant. Gated provider routes are allowed only behind a requires group. */
  const prov = C.ROUTES.filter((r) => C.sessionsOf(r.id).includes('provider') && C.groupRequires(r.id) == null).map((r) => r.id).sort();
  ck('C2  UNGATED provider-capable routes are EXACTLY home, messages, signout (conservative)', JSON.stringify(prov) === '["home","messages","signout"]', prov);
  const provGated = C.ROUTES.filter((r) => C.sessionsOf(r.id).includes('provider') && C.groupRequires(r.id) != null).map((r) => r.id + '=' + C.groupRequires(r.id)).sort();
  ck('C2b gated provider routes are exactly rates=module:services + the ten mkt-*=marketing (refused without the capability, mount with it)', JSON.stringify(provGated) === JSON.stringify(['rates=module:services'].concat(["mkt-overview","mkt-services","mkt-rates","mkt-leads","mkt-quotes","mkt-bookings","mkt-campaigns","mkt-projects","mkt-earnings","mkt-verification"].map((id) => id + '=marketing')).concat(['prov-payments=module:earnings', 'prov-receipts=module:earnings', 'prov-plan=module:subscription']).sort()) &&
     C.mountRefusal('rates', 'provider', () => false) === 'requires:module:services' && C.mountRefusal('rates', 'provider', (c) => c === 'module:services') === null &&
     C.mountRefusal('rates', 'provider', (c) => c === 'marketing') === 'requires:module:services', provGated);
  ck('C2c every mkt-* route is refused without the marketing capability and mounts with it (sokoni-b2)', ["mkt-overview","mkt-services","mkt-rates","mkt-leads","mkt-quotes","mkt-bookings","mkt-campaigns","mkt-projects","mkt-earnings","mkt-verification"].every((id) => C.mountRefusal(id, 'provider', () => false) === 'requires:marketing' && C.mountRefusal(id, 'provider', (c) => c === 'marketing') === null && C.mountRefusal(id, 'provider', (c) => c === 'module:services') === 'requires:marketing'), null);
  const undeclared = C.ROUTES.filter((r) => r.sessions == null);
  ck('C3  every route without a sessions key defaults to ["merchant"]', undeclared.length > 20 && undeclared.every((r) => JSON.stringify(C.sessionsOf(r.id)) === '["merchant"]'), undeclared.length);
  const shopTools = ['pos', 'inventory', 'sell', 'products', 'devices', 'staff', 'sales-control', 'pos-setup', 'pos-provision', 'orders', 'shop', 'supply', 'plan', 'settings', 'payments', 'dashboard'];
  const leaked = shopTools.filter((id) => C.mountRefusal(id, 'provider', () => true) !== 'session:provider');
  ck('C4  shop/POS/inventory/till/devices/staff… are refused for providers even with every capability', leaked.length === 0, leaked);
  /* C5 (refined): every route that declares the merchant session still mounts as before; a
     provider-ONLY route (rates) is refused for a merchant, and that set is pinned exactly. */
  const merchantBlocked = C.ROUTES.filter((r) => C.sessionsOf(r.id).includes('merchant') && C.mountRefusal(r.id, null, () => false) !== null).map((r) => r.id);
  ck('C5  with no provider session (null) every merchant route mounts exactly as before', merchantBlocked.length === 0, merchantBlocked);
  const provOnly = C.ROUTES.filter((r) => !C.sessionsOf(r.id).includes('merchant')).map((r) => r.id + '=' + C.mountRefusal(r.id, null, () => true));
  ck('C5b provider-only routes are exactly [rates + the ten mkt-*], refused for a merchant even with every capability', JSON.stringify(provOnly.slice().sort()) === JSON.stringify(['rates=session:merchant'].concat(["mkt-overview","mkt-services","mkt-rates","mkt-leads","mkt-quotes","mkt-bookings","mkt-campaigns","mkt-projects","mkt-earnings","mkt-verification"].map((id) => id + '=session:merchant')).concat(['prov-payments=session:merchant', 'prov-receipts=session:merchant', 'prov-plan=session:merchant']).sort()), provOnly);
  ck('C6  an unknown session is refused, never treated as merchant', C.mountRefusal('messages', 'admin') === 'session:admin', C.mountRefusal('messages', 'admin'));
  ck('C7  aliases resolve before the session check (#cashier → pos, refused for provider)', C.mountRefusal('cashier', 'provider') === 'session:provider', C.mountRefusal('cashier', 'provider'));

  const badSession = (lit) => loadContract(ROUTES_SRC.replace("sessions:['merchant','provider'],   /* leaving for the marketplace needs no shop */", 'sessions:' + lit + ','));
  for (const [lit, want] of [["['providers']", 'invalid session "providers"'], ['[]', 'sessions must be a non-empty array'], ["'provider'", 'sessions must be a non-empty array'], ["['provider','provider']", 'listed twice'], ["['admin']", 'invalid session "admin"']]) {
    const errs = badSession(lit).validate();
    ck('C8  validate() rejects sessions:' + lit, errs.some((e) => e.indexOf(want) > -1), errs);
  }
  for (const lit of ["''", "'   '", '5', 'true', '[]']) {
    const errs = loadContract(gatedRoutesSrc(lit)).validate();
    ck('C9  validate() rejects requires:' + lit, errs.some((e) => /requires must be a non-empty capability string/.test(e)), errs);
  }
  const G = loadContract(gatedRoutesSrc("'marketing'"));
  ck('C10 a well-formed gated group validates clean', G.validate().length === 0, G.validate());
  const exposedBn = loadContract(gatedRoutesSrc("'marketing'").replace("{ id:'orders',    icon:'🧾', label:'Orders' },", "{ id:'mkt-test', icon:'📣', label:'Mkt' },")).validate();
  ck('C11 validate() rejects a gated route also in the bottom nav (ungated elsewhere)', exposedBn.some((e) => /exposes a route of gated group/.test(e)), exposedBn);
  const exposedSet = loadContract(gatedRoutesSrc("'marketing'").replace("links:['shop','pos-setup','devices','staff','kra-tax','plan'],", "links:['shop','pos-setup','devices','staff','kra-tax','plan','mkt-test'],")).validate();
  ck('C12 validate() rejects a gated route linked from the Settings hub', exposedSet.some((e) => /settings hub links to "mkt-test"/.test(e)), exposedSet);
  const twoGroups = loadContract(gatedRoutesSrc("'marketing'").replace("ids:['marketing','offers','flash-sale','stories','customers']", "ids:['marketing','offers','flash-sale','stories','customers','mkt-test']")).validate();
  ck('C13 validate() rejects a gated route also listed in an ungated group', twoGroups.some((e) => /is in more-groups "mktsvc" AND "growth"/.test(e)), twoGroups);
  ck('C14 mountRefusal: gated route without the capability → requires:marketing', G.mountRefusal('mkt-test', 'provider', () => false) === 'requires:marketing', G.mountRefusal('mkt-test', 'provider', () => false));
  ck('C15 mountRefusal: gate fails CLOSED when can is missing or throws', G.mountRefusal('mkt-test', 'provider') === 'requires:marketing' && G.mountRefusal('mkt-test', 'provider', () => { throw new Error('x'); }) === 'requires:marketing' && G.mountRefusal('mkt-test', 'provider', () => 'yes') === 'requires:marketing', null);
  ck('C16 mountRefusal: gated route WITH the capability mounts (both sessions)', G.mountRefusal('mkt-test', 'provider', (c) => c === 'marketing') === null && G.mountRefusal('mkt-test', null, (c) => c === 'marketing') === null, null);

  /* ════ M — MAPPING ════ */
  console.log('\nM  mapping: server answer -> capabilities');
  const M = loadSessionModule();
  const mk = (a) => M.mapWorkspace(a);
  ck('M1  answer.marketing === true → "marketing"', mk(routedAnswer({ marketing: true })).capabilities.includes('marketing'), mk(routedAnswer({ marketing: true })).capabilities);
  ck('M2  answer.marketing === false → no "marketing"', !mk(routedAnswer({ marketing: false })).capabilities.includes('marketing'), null);
  const nonBool = [['missing', routedAnswer()], ["'true' (string)", routedAnswer({ marketing: 'true' })], ['1', routedAnswer({ marketing: 1 })], ['{}', routedAnswer({ marketing: {} })]];
  const leakedNB = nonBool.filter(([, a]) => mk(a).capabilities.includes('marketing')).map(([n]) => n);
  ck('M3  ONLY the strict boolean true grants "marketing" (missing / "true" / 1 / {} grant nothing)', leakedNB.length === 0, leakedNB);
  ck('M4  modules.marketing AVAILABLE (the provider\'s own promotion module) does NOT grant the "marketing" group capability', !mk(routedAnswer()).capabilities.includes('marketing') && mk(routedAnswer()).capabilities.includes('module:marketing'), mk(routedAnswer()).capabilities);
  ck('M5  "marketing" inside answer.capabilities is ignored — only the boolean grants it', !mk(routedAnswer({ capabilities: ['marketing', 'leads'] })).capabilities.includes('marketing') && mk(routedAnswer({ capabilities: ['marketing', 'leads'] })).capabilities.includes('leads'), mk(routedAnswer({ capabilities: ['marketing', 'leads'] })).capabilities);
  const r6 = mk(routedAnswer());
  ck('M6  routed + VALID_APPROVAL → module:<key> for AVAILABLE modules only', JSON.stringify(r6.capabilities.slice().sort()) === JSON.stringify(['module:marketing', 'module:messages', 'module:overview', 'module:reviews']), r6.capabilities);
  const r7 = mk(holdingAnswer());
  ck('M7  a holding answer (PENDING) grants NOTHING — its overview/settings AVAILABLE are not capabilities', r7.ok === false && r7.capabilities.length === 0, r7);
  ck('M8  …and carries the honest notice with the server\'s own message', r7.notice === "Your provider workspace isn't available yet — Your application is with SOKONI for review.", r7.notice);
  const r9 = mk(routedAnswer({ approval: { state: 'INVALID_LEGACY_APPROVAL' } }));
  ck('M9  routed but approval not VALID_APPROVAL → no module capabilities (fail closed)', r9.capabilities.length === 0 && r9.ok === false, r9.capabilities);
  const r10 = mk(routedAnswer({ approval: undefined }));
  ck('M10 routed with NO approval block → no module capabilities', r10.capabilities.length === 0, r10.capabilities);
  for (const [n, a] of [['null', null], ['array', []], ['string', 'ok'], ['no modules', { state: 'AVAILABLE', approval: { state: 'VALID_APPROVAL' } }]]) {
    const r = mk(a);
    ck('M11 malformed answer (' + n + ') → ok:false, [] and a notice', r.ok === false && r.capabilities.length === 0 && /isn't available yet/.test(r.notice || ''), r);
  }
  const r12 = mk(routedAnswer({ marketing: true, marketingCategories: ['social_media', 'seo', 7] }));
  ck('M12 marketingCategories exposed read-only (frozen, strings only)', Object.isFrozen(r12.workspace.marketingCategories) && JSON.stringify(r12.workspace.marketingCategories) === '["social_media","seo"]', r12.workspace);
  const r13 = mk(routedAnswer({ marketing: 'true', marketingCategories: ['seo'] }));
  ck('M13 marketingCategories are empty unless marketing === true', r13.workspace.marketingCategories.length === 0, r13.workspace.marketingCategories);
  const r14 = mk(holdingAnswer({ marketing: true }));
  ck('M14 marketing === true on a held workspace → ONLY "marketing", with a notice for the rest', JSON.stringify(r14.capabilities) === '["marketing"]' && /isn't available yet/.test(r14.notice), r14);
  ck('M15 a reason code with no message reads in plain words', M.notice('SUSPENDED') === "Your provider workspace isn't available yet — your business is suspended.", M.notice('SUSPENDED'));

  /* ════ S — SESSION RESOLUTION (real shell source) ════ */
  console.log('\nS  session resolution: shop wins, provider second, no-shop unchanged');
  const merchantIdentity = () => ({ data: { capabilities: ['sell', 'view_orders'], servedBy: { role: 'owner' }, shop: null } });
  const bwCalls = (h) => h.log.calls.filter((c) => c.name === 'providerDispatch');

  let h = shellHarness({ docs: { 'shops/u1': { name: 'Mama Shop' }, 'providers/u1': { name: 'Mama Services' } },
    callables: { merchantIdentity, providerDispatch: () => ({ data: routedAnswer({ marketing: true }) }) } });
  await h.api.resolveShop(); h.api.emit();
  ck('S1  owner WITH a providers doc → MERCHANT session (shop wins)', h.S.session === 'merchant' && h.S.activeShopId === 'u1', { session: h.S.session, shop: h.S.activeShopId });
  ck('S2  …capabilities are exactly merchantIdentity\'s; businessWorkspace never called; providers/{uid} never read', JSON.stringify(h.S.capabilities) === '["sell","view_orders"]' && bwCalls(h).length === 0 && !h.log.reads.includes('providers/u1'), { caps: h.S.capabilities, reads: h.log.reads });
  /* Provider-only routes (rates) are not part of the merchant projection. */
  const expectMerchantNav = C.primary().map((r) => r.id).concat(C.moreGroups().flatMap((g) => g.routes.map((r) => r.id)))
    .filter((id) => C.sessionsOf(id).includes('merchant'));
  ck('S3  merchant sidebar = the contract\'s full projection, unchanged (primary order + every group)', JSON.stringify(navIds(h.doc)) === JSON.stringify(expectMerchantNav), navIds(h.doc));
  ck('S3b merchant bottom nav + footer exit unchanged', JSON.stringify(bnavIds(h.doc)) === JSON.stringify(C.BOTTOM_NAV.map((b) => b.id)) && JSON.stringify(footIds(h.doc)) === '["home"]', { b: bnavIds(h.doc), f: footIds(h.doc) });

  h = shellHarness({ docs: { 'shopEmployees/u1': { shopOwnerId: 'shopX', role: 'admin' }, 'providers/u1': { name: 'P' } },
    callables: { merchantIdentity: () => ({ data: { capabilities: ['sell'] } }), providerDispatch: () => ({ data: routedAnswer({ marketing: true }) }) } });
  await h.api.resolveShop();
  ck('S4  EMPLOYEE with a providers doc → MERCHANT session for the employer shop; no businessWorkspace', h.S.session === 'merchant' && h.S.activeShopId === 'shopX' && bwCalls(h).length === 0, { s: h.S.session, shop: h.S.activeShopId, bw: bwCalls(h).length });

  h = shellHarness({ docs: { 'providers/u1': { name: 'Wanjiku Digital' } },
    callables: { providerDispatch: () => ({ data: routedAnswer({ marketing: true, marketingCategories: ['seo'] }) }) } });
  await h.api.resolveShop();
  ck('S5  provider-only → PROVIDER session; businessWorkspace called ONCE with {op:"businessWorkspace"}', h.S.session === 'provider' && bwCalls(h).length === 1 && JSON.stringify(bwCalls(h)[0].payload) === '{"op":"businessWorkspace"}', { s: h.S.session, calls: bwCalls(h) });
  ck('S5b …capabilities come from the server answer (marketing + module:*), display name from providers doc', h.S.capabilities.includes('marketing') && h.S.capabilities.includes('module:messages') && h.api.merchantDisplayName() === 'Wanjiku Digital' && h.S.workspace.marketingCategories[0] === 'seo', { caps: h.S.capabilities, name: h.api.merchantDisplayName() });

  async function rowS6 (shellSrc) {
    const hh = shellHarness({ shellSrc, docs: { 'providers/u1': { name: 'P', marketing: true, marketingActive: true, marketingCategories: ['seo'] } },
      callables: { providerDispatch: () => ({ data: routedAnswer() }) } });   /* server: NO marketing key */
    await hh.api.resolveShop();
    return !hh.S.capabilities.includes('marketing');
  }
  ck('S6  self-written providers.marketing* with the server silent → NO "marketing" capability', await rowS6(), null);

  h = shellHarness({ docs: { 'providers/u1': { name: 'P' } },
    callables: { providerDispatch: () => { const e = new Error('nope'); e.code = 'functions/permission-denied'; throw e; } } });
  await h.api.resolveShop();
  ck('S7  refused businessWorkspace → provider session, capabilities [], honest notice naming the reason', h.S.session === 'provider' && h.S.capabilities.length === 0 && h.S.sessionNotice === "Your provider workspace isn't available yet — the workspace service refused (permission-denied).", { caps: h.S.capabilities, n: h.S.sessionNotice });

  h = shellHarness({ docs: { 'providers/u1': {} }, callables: { providerDispatch: () => ({ data: { weird: true } }) } });
  await h.api.resolveShop();
  ck('S8  unknown/malformed answer → [] + notice; no display name invented (null → email)', h.S.capabilities.length === 0 && /isn't available yet/.test(h.S.sessionNotice) && h.api.merchantDisplayName() === null, { caps: h.S.capabilities, n: h.S.sessionNotice });

  h = shellHarness({ docs: {}, callables: { providerDispatch: () => ({ data: routedAnswer({ marketing: true }) }) } });
  await h.api.resolveShop();
  ck('S9  no shop, no provider → existing no-shop state (session null, shopError no-shop-document), no businessWorkspace', h.S.session === null && h.S.shopError === 'no-shop-document' && bwCalls(h).length === 0 && h.S.capabilities.length === 0, { s: h.S.session, e: h.S.shopError });

  h = shellHarness({ docs: { 'providers/u1': { name: 'P' } }, throwOn: { 'providers/u1': 'permission-denied' }, callables: { providerDispatch: () => ({ data: routedAnswer() }) } });
  await h.api.resolveShop();
  ck('S10 providers read fails → stays in the no-shop state (never a provider session on a guess)', h.S.session === null && h.S.providerError === 'providers-permission-denied' && bwCalls(h).length === 0, { s: h.S.session, e: h.S.providerError });

  h = shellHarness({ noSessionModule: true, docs: { 'providers/u1': { name: 'P' } }, callables: { providerDispatch: () => ({ data: routedAnswer({ marketing: true }) }) } });
  await h.api.resolveShop();
  ck('S11 session module missing → provider session with NO capabilities and a notice (fail closed)', h.S.session === 'provider' && h.S.capabilities.length === 0 && /isn't available yet/.test(h.S.sessionNotice) && bwCalls(h).length === 0, { caps: h.S.capabilities });

  /* ════ N — NAVIGATION in a provider session ════ */
  console.log('\nN  navigation: provider mounts only provider-capable routes');
  async function providerHarness (o) {
    const hh = shellHarness(Object.assign({ docs: { 'providers/u1': { name: 'P' } },
      callables: { providerDispatch: () => ({ data: routedAnswer({ marketing: true }) }) } }, o || {}));
    await hh.api.resolveShop();
    hh.api.emit();
    return hh;
  }
  h = await providerHarness();
  /* sokoni-b2 MK6: this harness's server answer grants marketing:true, so the capability-gated 'Marketing services' group
     joins Messages; with marketing:false the sidebar is Messages only. */
  const mktGroup = C.moreGroups().filter((g) => g.requires === 'marketing').flatMap((g) => g.routes.map((r) => r.id));
  const hNo = await providerHarness({ callables: { providerDispatch: () => ({ data: routedAnswer({ marketing: false }) }) } });
  ck('N1  provider sidebar = Messages + ONLY the groups whose capability the server granted (+ Marketplace exit in the footer)',
    JSON.stringify(navIds(h.doc)) === JSON.stringify(['messages'].concat(mktGroup)) && JSON.stringify(footIds(h.doc)) === '["home"]'
    && JSON.stringify(navIds(hNo.doc)) === '["messages"]',
    { nav: navIds(h.doc), navWithoutMarketing: navIds(hNo.doc), foot: footIds(h.doc), heads: navHeads(h.doc) });
  ck('N2  provider bottom nav drops Orders and Sell (home + More only)', JSON.stringify(bnavIds(h.doc)) === '["home","__more"]', bnavIds(h.doc));
  async function rowN3 (shellSrc) {
    const hh = await providerHarness({ shellSrc });
    const bad = ['pos', 'inventory', 'sell', 'devices', 'staff', 'cashier', 'sales-control', 'pos-setup'].filter((id) => {
      hh.log.rendered = []; hh.log.framed = [];
      hh.api.go(id);
      const p = hh.ctx.shown;
      return !(hh.log.rendered.length === 0 && hh.log.framed.length === 0 && p && /data-why="session:provider"/.test(p.innerHTML));
    });
    return bad;
  }
  const n3 = await rowN3();
  ck('N3  POS/inventory/till/devices/staff (and the #cashier alias) are REFUSED in a provider session — nothing mounts', n3.length === 0, n3);
  h.log.rendered = []; h.api.go('pos');
  ck('N4  the refusal names the destination and the reason, with no fallback', /POS is not available here/.test(h.ctx.shown.innerHTML) && /service provider/.test(h.ctx.shown.innerHTML) && h.api.getCurrent() === 'pos' && h.log.rendered.length === 0, h.ctx.shown.innerHTML);
  h.log.rendered = []; h.api.go('messages');
  ck('N5  Messages mounts in a provider session', h.log.rendered.includes('messages') && h.api.refused() === null, h.log.rendered);
  h.api.go('pos-provision');
  ck('N6  a merchant-only EXIT (device provisioning) is refused for a provider; Home is allowed', h.log.exits.length === 0 && (h.api.go('home'), h.log.exits.join() === 'home'), h.log.exits);

  /* landing: implicit boot (no hash) on Dashboard → first provider destination */
  h = shellHarness({ bootImplicit: true, docs: { 'providers/u1': { name: 'P' } }, callables: { providerDispatch: () => ({ data: routedAnswer() }) } });
  h.api.go('dashboard');
  await h.api.resolveShop(); h.api.emit();
  ck('N7  implicit boot (no hash) lands a provider on Messages, not on a refused Dashboard', h.api.getCurrent() === 'messages' && h.log.rendered.includes('messages'), { cur: h.api.getCurrent(), r: h.log.rendered });
  h = shellHarness({ bootImplicit: false, hash: '#pos', docs: { 'providers/u1': { name: 'P' } }, callables: { providerDispatch: () => ({ data: routedAnswer() }) } });
  h.api.go('pos');
  await h.api.resolveShop(); h.log.framed = []; h.api.emit();
  ck('N8  an EXPLICIT #pos deep link is refused once the provider session lands — never substituted', h.api.getCurrent() === 'pos' && /data-why="session:provider"/.test(h.ctx.shown.innerHTML) && h.log.framed.length === 0, { cur: h.api.getCurrent() });

  /* merchant session: go() untouched */
  h = shellHarness({ docs: { 'shops/u1': { name: 'S' } }, callables: { merchantIdentity } });
  await h.api.resolveShop(); h.api.emit();
  const mBad = ['pos', 'inventory', 'sell', 'messages', 'settings', 'dashboard'].filter((id) => { h.api.go(id); return h.api.refused() !== null; });
  ck('N9  merchant session: every route still mounts through go() (no refusal)', mBad.length === 0 && h.log.printer === true, mBad);

  /* ════ G — GROUP GATE ════ */
  console.log('\nG  group gate: requires:"marketing"');
  const Gc = () => loadContract(gatedRoutesSrc("'marketing'"));
  async function gatedProvider (answerOrThrow, shellSrc) {
    const hh = shellHarness({ contract: Gc(), shellSrc, docs: { 'providers/u1': { name: 'P' } },
      callables: { providerDispatch: () => { if (answerOrThrow instanceof Error) throw answerOrThrow; return { data: answerOrThrow }; } } });
    await hh.api.resolveShop(); hh.api.emit();
    return hh;
  }
  h = await gatedProvider(routedAnswer());
  ck('G1  without the capability the gated group is HIDDEN and navigation refused (requires:marketing)', !navHeads(h.doc).includes('Marketing services') && !navIds(h.doc).includes('mkt-test') && (h.api.go('mkt-test'), /data-why="requires:marketing"/.test(h.ctx.shown.innerHTML)), { heads: navHeads(h.doc) });
  h = await gatedProvider(routedAnswer({ marketing: true }));
  ck('G2  with answer.marketing === true the group is SHOWN and its route mounts', navHeads(h.doc).includes('Marketing services') && navIds(h.doc).includes('mkt-test') && (h.log.rendered = [], h.api.go('mkt-test'), h.log.rendered.includes('mkt-test')), { heads: navHeads(h.doc), r: h.log.rendered });
  h = await gatedProvider(routedAnswer({ marketing: 'true' }));
  ck('G3  answer.marketing === "true" (string) → group hidden', !navIds(h.doc).includes('mkt-test'), navIds(h.doc));
  async function rowG4 (shellSrc) {
    const e = new Error('down'); e.code = 'functions/unavailable';
    const hh = await gatedProvider(e, shellSrc);
    hh.S.capabilities = null;          /* an errored capability list must also stay closed */
    hh.api.setNavSig(null); hh.api.projectNav();
    return !navIds(hh.doc).includes('mkt-test') && !navHeads(hh.doc).includes('Marketing services');
  }
  ck('G4  businessWorkspace ERROR → gated group hidden (fails closed)', await rowG4(), null);
  /* the gate works in a MERCHANT session too */
  h = shellHarness({ contract: Gc(), docs: { 'shops/u1': { name: 'S' } }, callables: { merchantIdentity } });
  await h.api.resolveShop(); h.api.emit();
  ck('G5  merchant session without "marketing" → gated group hidden (gate is session-neutral)', !navIds(h.doc).includes('mkt-test'), navIds(h.doc));
  h = shellHarness({ contract: Gc(), docs: { 'shops/u1': { name: 'S' } }, callables: { merchantIdentity: () => ({ data: { capabilities: ['sell', 'marketing'] } }) } });
  await h.api.resolveShop(); h.api.emit();
  ck('G6  merchant session WITH "marketing" from merchantIdentity → gated group shown', navIds(h.doc).includes('mkt-test'), navIds(h.doc));
  /* a gated deep link made while resolving is refused, then mounts once the capability lands */
  h = shellHarness({ contract: Gc(), hash: '#mkt-test', docs: { 'providers/u1': { name: 'P' } }, callables: { providerDispatch: () => ({ data: routedAnswer({ marketing: true }) }) } });
  h.S.state = 'resolving'; h.api.go('mkt-test');
  const refusedFirst = h.api.refused() && h.api.refused().id === 'mkt-test';
  h.S.state = 'in'; await h.api.resolveShop(); h.log.rendered = []; h.api.emit();
  ck('G7  gated deep link refused while capabilities are [] → mounts once the server grants it', refusedFirst && h.log.rendered.includes('mkt-test') && h.api.refused() === null, { refusedFirst, r: h.log.rendered });

  /* ════ X — NEGATIVE CONTROLS ════ */
  console.log('\nX  negative controls (each sabotage must turn its named row red)');
  const sabA = SHELL_SRC.replace("var sess = S.session === 'provider' ? 'provider' : null;", 'var sess = null;');
  ck('X-a sabotage: provider session mounts merchant-only routes → N3 goes red', sabA !== SHELL_SRC && (await rowN3(sabA)).length > 0, null);
  const sabB = SHELL_SRC.replace('res = SMS.mapWorkspace(answer);', "res = SMS.mapWorkspace(answer); if ((snap.data() || {}).marketing) res.capabilities.push('marketing');");
  ck('X-b sabotage: "marketing" derived from client providers fields → S6 goes red', sabB !== SHELL_SRC && (await rowS6(sabB)) === false, null);
  /* can() answering "yes" when the capability list is absent/errored = a gate that fails open.
     (Removing only the sidebar's own group check is NOT enough to open it — mountable() asks the
     contract's mountRefusal too; that defence in depth is why the sabotage targets can().) */
  const sabC = SHELL_SRC.replace('return Array.isArray(S.capabilities) && S.capabilities.indexOf(capability) !== -1;',
    'return !Array.isArray(S.capabilities) || S.capabilities.indexOf(capability) !== -1;');
  ck('X-c sabotage: group gate fails open on error → G4 goes red', sabC !== SHELL_SRC && (await rowG4(sabC)) === false, null);
  const sabD = SESSION_SRC.replace('if (a.marketing === true) add(\'marketing\');', 'if (a.marketing) add(\'marketing\');');
  const Md = loadSessionModule(sabD);
  ck('X-d sabotage: truthy (not strict) marketing → M3 goes red', sabD !== SESSION_SRC && nonBool.some(([, a]) => Md.mapWorkspace(a).capabilities.includes('marketing')), null);

  /* ════ E — EDITABLE (P0-F) ════ */
  console.log('\nE  editable: only answer.editable === true is editable');
  const EA = loadEditAuthority();
  const dec = (a, c) => EA.decide(a, c);
  const valid = { approval: { state: 'VALID_APPROVAL' } };
  ck('E0  the VALID token this client checks is exactly sokoni-5b f85039a\'s STATES.VALID ("VALID_APPROVAL")', EA.VALID_APPROVAL === 'VALID_APPROVAL' && M.VALID_APPROVAL === 'VALID_APPROVAL', EA.VALID_APPROVAL);
  const tbl = [
    ['active',      true,      true,  null],
    ['active',      false,     false, 'your business status does not allow changes yet'],
    ['active',      undefined, false, 'your business status does not allow changes yet'],
    ['deactivated', false,     false, 'deactivated — reactivate your account'],
    ['deactivated', undefined, false, 'deactivated — reactivate your account'],
    ['suspended',   false,     false, 'suspended'],
    ['suspended',   undefined, false, 'suspended'],
    ['frozen',      false,     false, 'frozen by SOKONI'],
    ['frozen',      undefined, false, 'frozen by SOKONI'],
    ['unknown',     false,     false, 'status unknown'],
    ['unknown',     undefined, false, 'status unknown'],
  ];
  const tblBad = tbl.filter(([os, ed, want, why]) => { const a = Object.assign({ ownerState: os }, valid); if (ed !== undefined) a.editable = ed; const d = dec(a, {}); return d.editable !== want || d.readOnly === want || d.reason !== why; });
  ck('E1  ownerState × editable matrix (active/deactivated/suspended/frozen/unknown × false/missing; active × true)', tblBad.length === 0, tblBad);
  ck('E2  editable === true wins for every ownerState the server pairs with it (server already folded the state in)', dec(Object.assign({ ownerState: 'active', editable: true }, valid)).editable === true, null);
  function rowE3 (src) { const E = loadEditAuthority(src); return E.decide(Object.assign({}, valid), {}).editable === false && E.decide(Object.assign({}, valid), {}).reason === 'status unknown'; }
  ck('E3  editable MISSING on an old server with VALID approval and no deactivated claim → READ-ONLY, "status unknown"', rowE3(), dec(Object.assign({}, valid), {}));
  const nb = [['"true"', 'true'], ['1', 1], ['{}', {}], ['null', null]].filter(([, v]) => dec(Object.assign({ editable: v }, valid), {}).editable !== false).map(([n]) => n);
  ck('E4  a non-boolean editable ("true", 1, {}, null) is NOT editable', nb.length === 0, nb);
  const e5 = dec(Object.assign({}, valid), { deactivated: true });
  ck('E5  interim: claim deactivated === true (no ownerState) → read-only, deactivated, with the reactivate link', e5.readOnly && e5.reasonCode === 'deactivated' && e5.action && e5.action.href === '/profile.html', e5);
  const e6 = dec({ approval: { state: 'INVALID_LEGACY_APPROVAL' } }, {});
  ck('E6  interim: approval not VALID_APPROVAL → read-only naming the approval state', e6.readOnly && e6.reasonCode === 'approval' && /INVALID_LEGACY_APPROVAL/.test(e6.reason), e6);
  ck('E7  interim: approval block missing → read-only', dec({}, {}).readOnly === true, dec({}, {}));
  const e8 = dec({ editable: true, ownerState: 'active', approval: { state: 'PENDING_APPROVAL' } }, { deactivated: true });
  ck('E8  editable === true OVERRIDES the interim signals (claim deactivated, approval not valid)', e8.editable === true && e8.readOnly === false, e8);
  ck('E9  editable false OVERRIDES a clean interim picture (VALID approval, no claim)', dec(Object.assign({ editable: false, ownerState: 'suspended' }, valid), {}).readOnly === true, null);
  ck('E10 no answer (null / array / string) → read-only, "status unknown" (fails closed)', [null, [], 'x', undefined].every((a) => dec(a, {}).readOnly && dec(a, {}).reason === 'status unknown'), null);
  ck('E11 an ownerState this client does not know → read-only "status unknown"', dec(Object.assign({ ownerState: 'paused' }, valid), {}).reason === 'status unknown', dec(Object.assign({ ownerState: 'paused' }, valid), {}));
  ck('E12 the one message: "Your account can’t make changes right now (<reason>)"', EA.message(dec(Object.assign({ ownerState: 'frozen', editable: false }, valid))) === 'Your account can\u2019t make changes right now (frozen by SOKONI)', EA.message(dec({ ownerState: 'frozen' })));
  ck('E13 decide() never reads approval from the application (status/adminApproved/approvedBy/verified are ignored)', dec({ status: 'approved', adminApproved: true, approvedBy: 'admin', verified: true }, {}).readOnly === true, null);

  async function rowE14 (shellSrc) {
    const hh = shellHarness({ shellSrc, claims: {}, docs: { 'providers/u1': { name: 'P' } },
      callables: { providerDispatch: () => { const e = new Error('down'); e.code = 'functions/unavailable'; throw e; } } });
    await hh.api.resolveShop();
    return !!hh.S.editable && hh.S.editable.editable === false && hh.S.editable.readOnly === true;
  }
  ck('E14 shell: businessWorkspace fails → S.editable read-only (fails closed)', await rowE14(), null);
  h = shellHarness({ claims: {}, docs: { 'providers/u1': { name: 'P' } }, callables: { providerDispatch: () => ({ data: routedAnswer({ ownerState: 'active', editable: true }) }) } });
  await h.api.resolveShop();
  ck('E15 shell: answer editable true → S.editable.editable true; ONE businessWorkspace call feeds both capabilities and editable', h.S.editable.editable === true && bwCalls(h).length === 1 && h.S.capabilities.includes('module:messages'), h.S.editable);
  h = shellHarness({ claims: {}, docs: { 'providers/u1': { name: 'P' } }, callables: { providerDispatch: () => ({ data: routedAnswer({ ownerState: 'deactivated', editable: false }) }) } });
  await h.api.resolveShop();
  ck('E16 shell: ownerState deactivated → read-only with the reactivate action', h.S.editable.readOnly && h.S.editable.action && h.S.editable.action.href === '/profile.html', h.S.editable);
  h = shellHarness({ claims: { deactivated: true }, docs: { 'providers/u1': { name: 'P' } }, callables: { providerDispatch: () => ({ data: routedAnswer() }) } });
  await h.api.resolveShop();
  ck('E17 shell: OLD server (no editable) + ID-token claim deactivated → read-only, reason deactivated (claims read from the token)', h.S.editable.readOnly && h.S.editable.reasonCode === 'deactivated', h.S.editable);
  h = shellHarness({ claims: 'throw', docs: { 'providers/u1': { name: 'P' } }, callables: { providerDispatch: () => ({ data: routedAnswer() }) } });
  await h.api.resolveShop();
  ck('E18 shell: claims unreadable + old server → read-only (never "not deactivated" by default)', h.S.editable.readOnly === true, h.S.editable);
  h = shellHarness({ noEditAuthority: true, claims: {}, docs: { 'providers/u1': { name: 'P' } }, callables: { providerDispatch: () => ({ data: routedAnswer({ editable: true, ownerState: 'active' }) }) } });
  await h.api.resolveShop();
  ck('E19 shell: edit-authority module missing → read-only even when the server says editable', h.S.editable.readOnly === true, h.S.editable);
  h = shellHarness({ docs: { 'shops/u1': { name: 'S' } }, callables: { merchantIdentity } });
  await h.api.resolveShop();
  ck('E20 merchant session: S.editable stays null (not this authority\'s question; merchantIdentity governs)', h.S.editable === null || h.S.editable === undefined, h.S.editable);

  console.log('\nX  negative controls (P0-F)');
  const sabE = EDIT_SRC.replace('if (a.editable === true) {', 'if (a.editable !== false) {');
  ck('X-e sabotage: missing editable treated as editable → E3 goes red', sabE !== EDIT_SRC && rowE3(sabE) === false, null);
  const sabF = SHELL_SRC.replace('if (typeof SMS.editableOf === \'function\') S.editable = SMS.editableOf(answer, claims);',
    'S.editable = answer ? SMS.editableOf(answer, claims) : { editable: true, readOnly: false };');
  ck('X-f sabotage: shell fails OPEN on a missing answer → E14 goes red', sabF !== SHELL_SRC && (await rowE14(sabF)) === false, null);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS CRASH (not a pass):', e); process.exit(2); });
