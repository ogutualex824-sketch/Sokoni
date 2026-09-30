#!/usr/bin/env node
/* test-register-business-entry.js — "Register my business": ONE entry, ONE intake, the right dashboard.
 *
 * Owner ask (2026-10-01): "Register my business" is always accessible and in SYNC with the "What are
 * you offering?" page; every category flows into ONE application pipeline; after approval the user
 * reaches the correct dashboard. Hosting-only: no server, collection or rules change.
 *
 * Proves, without a browser, emulator or production:
 *   C  hub-register.js — the ONE intake — is EXECUTED in a VM with a stub DOM; its category set is
 *      read from the form it actually renders (<option value=…>), not restated here.
 *   O  every offer.html card opens that intake with an id that EXISTS in that set (or no id, so the
 *      applicant picks); no card reaches the second intake (provider.html?cat=) or a hub page
 *      instead; the page's offerRegister() is EXECUTED against the real HubRegister and passes the
 *      id's own hub; the not-yet-loaded path loads the form and never navigates away.
 *   M  the account dropdown carries "🏪 Register a business" → /offer.html, unconditionally.
 *   L  the three wrong entry links (providers / businesses / account-centre) point at /offer.html.
 *   S  the success screen (the REAL _showSuccess, executed) links the applicant's tracking page,
 *      not provider.html?cat=, and claims nothing ("now on SOKONI", "approved", "live").
 *   R  WORKSPACE_HUBS.provider is the provider DASHBOARD, not the providers.html directory (executed).
 *   N  negative controls: an invented category id, a removed menu item, a restored provider.html?cat=
 *      success link and the old providers.html hub are each CAUGHT by the same detectors.
 *
 * Run: node scripts/test-register-business-entry.js
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (label, ok, got) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '   [got ' + JSON.stringify(got) + ']')); ok ? pass++ : fail++; };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ── a minimal DOM: enough for hub-register.js to inject its modal and render its form ── */
function mkDom() {
  const byId = {};
  const mkEl = (tag) => {
    const el = { tagName: String(tag).toUpperCase(), id: '', innerHTML: '', textContent: '', style: {}, children: [], _listeners: {},
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
      setAttribute(k, v) { this[k] = v; }, getAttribute(k) { return this[k]; },
      addEventListener(t, f) { (this._listeners[t] = this._listeners[t] || []).push(f); },
      appendChild(c) { this.children.push(c); if (c.id) byId[c.id] = c; if (c.id === 'sokoniRegOverlay') byId.sokoniRegInner = mkEl('div'); return c; } };
    return el;
  };
  const document = {
    head: null, body: null,
    getElementById: (id) => byId[id] || null,
    createElement: mkEl,
    addEventListener() {},
    querySelectorAll: () => [],
  };
  document.head = mkEl('head'); document.body = mkEl('body');
  return { document, byId };
}
function loadHubRegister(ctxExtra) {
  const dom = mkDom();
  const w = Object.assign({ document: dom.document, console, localStorage: { getItem: () => null, setItem() {} }, setTimeout }, ctxExtra || {});
  w.window = w; w.globalThis = w;
  const ctx = vm.createContext(w);
  vm.runInContext(read('hub-register.js'), ctx, { filename: 'hub-register.js' });
  return { ctx, dom };
}

/* offer.html: every card anchor (service + product) and the building-materials link */
function offerCards(html) {
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/g; let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    if (!/class="of-(svc|prod)-card/.test(attrs) && !/data-reg-category=/.test(attrs)) continue;
    const href = (attrs.match(/href="([^"]*)"/) || [])[1] || '';
    const cat = /data-reg-category="([^"]*)"/.test(attrs) ? attrs.match(/data-reg-category="([^"]*)"/)[1] : null;
    const label = ((m[2].match(/of-(?:svc|prod)-label">([^<]*)</) || [])[1] || m[2].replace(/<[^>]+>/g, '').trim()).replace(/&amp;/g, '&');
    out.push({ href, cat, label, onclick: (attrs.match(/onclick="([^"]*)"/) || [])[1] || '' });
  }
  return out;
}
/* THE detector for the offer page: returns the list of defects (empty = in sync). */
const DRIVER_EXCEPTION = 'onboarding-driver.html';   /* Ride Sharing: the driver KYC intake, which also files `applications` */
const NO_CATEGORY_OK = ['Healthcare'];                 /* doctors / clinics / pharmacy span 8 ids — the applicant picks */
function offerDefects(cards, catIds) {
  const bad = [];
  cards.forEach((c) => {
    if (/provider\.html\?cat=/.test(c.href)) bad.push(c.label + ': second intake ' + c.href);
    if (c.href === DRIVER_EXCEPTION) return;
    if (c.cat === null) { bad.push(c.label + ': no data-reg-category (href ' + c.href + ')'); return; }
    if (c.href !== '#register') bad.push(c.label + ': navigates to ' + c.href);
    if (!/return offerRegister\(this\.dataset\.regCategory\)/.test(c.onclick)) bad.push(c.label + ': not wired to offerRegister');
    if (c.cat === '' && NO_CATEGORY_OK.indexOf(c.label) < 0) bad.push(c.label + ': empty category not allow-listed');
    if (c.cat && catIds.indexOf(c.cat) < 0) bad.push(c.label + ': "' + c.cat + '" is NOT a hub-register CATS id');
  });
  return bad;
}
/* THE detector for the account menu */
function menuDefects(src) {
  const bad = [];
  const at = src.indexOf("'<div class=\"sk-acct-links\">'");
  const acct = at < 0 ? '' : src.slice(at, src.indexOf('sk-acct-link-danger', at));
  if (!acct) bad.push('account-links markup not found');
  const item = /'<a class="sk-acct-link" href="\/offer\.html"[^']*>🏪 Register a business<\/a>'/;
  if (!item.test(acct)) bad.push('no 🏪 Register a business → /offer.html');
  /* unconditional: the literal sits in the plain concatenation chain, never behind a ternary/role check */
  const i = acct.search(item), ws = acct.indexOf('\n', acct.indexOf('💼 My Workspaces')), wl = acct.indexOf('👛 Wallet');
  if (i > -1 && !(ws > -1 && wl > -1 && ws < i && i < wl && !/[?]|\bif\b|role/.test(acct.slice(ws, i).replace(/\/\*[\s\S]*?\*\//g, '').replace(/'[^']*'/g, '')))) bad.push('item is not in the unconditional link chain');
  return bad;
}
function showSuccessOf(src) {
  const a = src.indexOf('function _showSuccess('), b = src.indexOf('/* ── Submit', a);
  if (a < 0 || b < 0) throw new Error('_showSuccess slice markers moved');
  return src.slice(a, b);
}
function successDefects(fnSrc) {
  const dom = mkDom(); const inner = dom.document.createElement('div'); inner.id = 'sokoniRegInner';
  dom.document.body.appendChild(inner);
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const run = new Function('document', 'window', '_esc', 'setTimeout', fnSrc + '\nreturn _showSuccess;')(dom.document, {}, esc, () => {});
  const out = {};
  ['free', 'pro'].forEach((plan) => { run({ name: 'Nairobi Quick Cleaners', plan, category: 'cleaning' }, 'app123'); out[plan] = inner.innerHTML; });
  const bad = [];
  Object.keys(out).forEach((p) => {
    const h = out[p];
    if (/provider\.html\?cat=/.test(h)) bad.push(p + ': links provider.html?cat=');
    if (/now on SOKONI/i.test(h)) bad.push(p + ': claims "now on SOKONI"');
    if (/\bapproved\b/i.test(h)) bad.push(p + ': claims approved');
    if (/\blive\b/i.test(h)) bad.push(p + ': claims live');
    if (!/href="complete-application\.html"/.test(h)) bad.push(p + ': no link to the tracking page');
    if (!/Application submitted — SOKONI reviews it in AdminOS/.test(h)) bad.push(p + ': missing the truthful headline');
  });
  return { bad, out };
}
function loadHubs(ra) {
  const a = ra.indexOf('  var WORKSPACE_HUBS = {'), b = ra.indexOf('\n  }', ra.indexOf('function hubFor(role)'));
  if (a < 0 || b < 0) throw new Error('hubFor slice markers moved');
  return new Function('_canonical', 'isApproved', ra.slice(a, b + 4) + '\nreturn { hubFor: hubFor, HUBS: WORKSPACE_HUBS };')((r) => String(r || '').toLowerCase(), () => true);
}

(async () => {
  /* ── C ── */
  console.log('\n── C: the ONE intake, executed ──');
  const { ctx, dom } = loadHubRegister();
  const HR = ctx.HubRegister;
  ck('C1  hub-register.js executes and exposes HubRegister.open', !!HR && typeof HR.open === 'function', typeof HR);
  HR.open({});
  const formHtml = dom.byId.sokoniRegInner ? dom.byId.sokoniRegInner.innerHTML : '';
  const catIds = []; formHtml.replace(/<option value="([^"]+)"/g, (_, v) => { catIds.push(v); return _; });
  ck('C2  the rendered form lists the CATS set (≥100 ids) — the list is READ from the form, not restated', catIds.length >= 100, catIds.length);
  ck('C3  HubRegister.category(id) returns the id\'s hub (retail-shop → shopping)', HR.category && HR.category('retail-shop') && HR.category('retail-shop').hub === 'shopping', HR.category && HR.category('retail-shop'));
  ck('C4  HubRegister.category(unknown) → null (a lookup, never an invented row)', HR.category('invented-cat') === null);
  const cp = HR.category('cleaning'); cp.hub = 'tampered';
  ck('C5  the lookup returns a COPY (a caller cannot rewrite CATS)', HR.category('cleaning').hub === 'home-services', HR.category('cleaning'));

  /* ── O ── */
  console.log('\n── O: every offer card → the ONE intake with an existing id ──');
  const offer = read('offer.html');
  const cards = offerCards(offer);
  ck('O1  the offer page\'s cards were isolated (29 service + 3 product + 1 building-materials link)', cards.length === 33, cards.length);
  const defects = offerDefects(cards, catIds);
  ck('O2  every card: #register + offerRegister + an EXISTING CATS id (or the allow-listed pick / driver intake)', defects.length === 0, defects);
  ck('O3  no provider.html?cat= anywhere on the page (the second intake is unreachable from here)', !/provider\.html\?cat=/.test(offer));
  ck('O4  no card navigates to seller.html / tech-hub.html / b2b.html / banking.html / construction.html', !/href="(seller|tech-hub|b2b|banking|construction)\.html"/.test(offer));
  ck('O5  the page loads the intake (hub-register.js)', /<script id="offerHubRegisterJs" src="hub-register\.js" defer><\/script>/.test(offer));
  ck('O6  the sessionStorage offerCat hand-off to provider.html is gone', !/offerCat/.test(offer));
  ck('O7  the "Already have a dashboard?" links name the real dashboards', /href="merchant-v2\.html"[^>]*>Seller ↗/.test(offer) && /href="provider-dashboard\.html"[^>]*>Provider ↗/.test(offer));
  ck('O8  the hero no longer promises "straight to the right dashboard" (an application is reviewed first)', !/straight to the right dashboard/.test(offer) && /SOKONI reviews it/.test(offer));

  const inl = (offer.match(/<script>\s*function showScreen[\s\S]*?<\/script>/) || [''])[0].replace(/^<script>|<\/script>$/g, '');
  ck('O9  the page script with offerRegister parses', (() => { try { new vm.Script(inl); return /function offerRegister/.test(inl); } catch (e) { return false; } })());
  /* executed against the REAL HubRegister, with open() spied */
  const opened = [];
  const realOpen = HR.open;
  HR.open = function (cfg) { opened.push(JSON.parse(JSON.stringify(cfg))); return realOpen.call(this, cfg); };
  vm.runInContext(inl, ctx, { filename: 'offer.html#inline' });
  const wired = cards.filter((c) => c.cat !== null);
  const rets = wired.map((c) => ctx.offerRegister(c.cat));
  ck('O10 offerRegister returns false for every card (the #register anchor never navigates)', rets.every((r) => r === false), rets);
  ck('O11 HubRegister.open was called once per card', opened.length === wired.length, opened.length);
  const hubMiss = wired.filter((c, i) => c.cat && (opened[i].category !== c.cat || opened[i].hub !== HR.category(c.cat).hub));
  ck('O12 each call carries the card\'s id AND that id\'s own hub from CATS', hubMiss.length === 0, hubMiss.map((c) => c.label));
  const hc = wired.findIndex((c) => c.cat === '');
  ck('O13 the no-category card opens the form with NO pre-selection (applicant picks)', hc > -1 && Object.keys(opened[hc]).length === 0, opened[hc]);
  const sel = cards.find((c) => c.label === 'Hair & Beauty'); ctx.offerRegister(sel.cat);
  ck('O14 the real form renders the card\'s id pre-selected (Hair & Beauty → salon)', /<option value="salon" selected>/.test(dom.byId.sokoniRegInner.innerHTML));
  /* not-yet-loaded: no HubRegister → load the form script once, stay on the page */
  const d2 = mkDom(); const w2 = { document: d2.document, console }; w2.window = w2; const c2 = vm.createContext(w2);
  vm.runInContext(inl, c2);
  const r2 = c2.offerRegister('cleaning');
  const tag = d2.byId.offerHubRegisterJs;
  ck('O15 form not loaded yet → returns false (stays), appends hub-register.js once', r2 === false && !!tag && tag.src === 'hub-register.js' && d2.document.head.children.length === 1, { r2, n: d2.document.head.children.length });
  c2.offerRegister('plumbing');
  ck('O16 a second tap does not append a second copy', d2.document.head.children.length === 1, d2.document.head.children.length);

  /* ── M ── */
  console.log('\n── M: always-accessible entry in the account dropdown ──');
  const menu = read('sokoni-profile-menu.js');
  const md = menuDefects(menu);
  ck('M1  🏪 Register a business → /offer.html, in the unconditional link chain', md.length === 0, md);
  ck('M2  sokoni-profile-menu.js parses', (() => { try { new vm.Script(menu); return true; } catch (e) { return e.message; } })() === true);

  /* ── L ── */
  console.log('\n── L: the wrong entry links ──');
  ck('L1  providers.html "Become a Provider" → /offer.html (was seller.html)', /<a href="\/offer\.html" class="pv-nav-link primary">Become a Provider<\/a>/.test(read('providers.html')));
  const biz = read('businesses.html');
  ck('L2  businesses.html "Register Your Business" → /offer.html (was business-os.html)', /<a href="\/offer\.html" class="bd-cta-btn">\s*<i class="fas fa-plus"><\/i> Register Your Business/.test(biz) && !/business-os\.html/.test(biz));
  ck('L3  account-centre "Register a Business" → /offer.html (was businesses.html)', /onclick="location\.href='\/offer\.html'">\s*<i class="fas fa-plus"><\/i> Register a Business/.test(read('account-centre.html')));
  const toApply = ['offer.html', 'sokoni-profile-menu.js', 'providers.html', 'businesses.html', 'account-centre.html', 'hub-register.js'].filter((f) => /business-apply\.html/.test(read(f)));
  ck('L4  no entry surface in this slice links the orphaned business-apply.html', toApply.length === 0, toApply);

  /* ── S ── */
  console.log('\n── S: the success screen tells the truth (executed) ──');
  const hub = read('hub-register.js');
  const sd = successDefects(showSuccessOf(hub));
  ck('S1  free + paid: links complete-application.html, headline "Application submitted — SOKONI reviews it in AdminOS", no provider.html?cat=, no approved/live/now-on-SOKONI claim', sd.bad.length === 0, sd.bad);
  ck('S2  hub-register.js parses', (() => { try { new vm.Script(hub); return true; } catch (e) { return e.message; } })() === true);
  ck('S3  the tracking page exists and asks the workspace authority', /op: 'businessWorkspace'/.test(read('complete-application.html')));

  /* ── R ── */
  console.log('\n── R: after approval, provider reaches its dashboard ──');
  const ra = read('sokoni-role-authority.js');
  const H = loadHubs(ra);
  ck('R1  hubFor(provider) → provider-dashboard.html', H.hubFor('provider') === 'provider-dashboard.html', H.hubFor('provider'));
  ck('R2  no workspace role is routed to the providers.html directory', Object.keys(H.HUBS).every((k) => H.HUBS[k] !== 'providers.html'), H.HUBS);
  ck('R3  provider-dashboard.html is the page that asks businessWorkspace and applies the shell gate', /sokoni-business-workspace\.js/.test(read('provider-dashboard.html')) && /op: 'businessWorkspace'/.test(read('sokoni-business-workspace.js')));
  ck('R4  seller still → merchant-v2.html (untouched)', H.hubFor('seller') === 'merchant-v2.html');

  /* ── N ── */
  console.log('\n── N: negative controls — each detector CATCHES the defect ──');
  const n1 = offer.replace('data-reg-category="salon"', 'data-reg-category="hair-beauty"');
  ck('N1  an invented category id (hair-beauty) is caught', n1 !== offer && offerDefects(offerCards(n1), catIds).some((x) => /hair-beauty.*NOT a hub-register CATS id/.test(x)));
  const n1b = offer.replace('<a href="#register" class="of-svc-card" data-reg-category="plumbing" onclick="return offerRegister(this.dataset.regCategory)">', '<a href="provider.html?cat=plumbing" class="of-svc-card">');
  ck('N2  a card restored to provider.html?cat= is caught', n1b !== offer && offerDefects(offerCards(n1b), catIds).some((x) => /second intake/.test(x)));
  const n3 = menu.replace(/\s*'<a class="sk-acct-link" href="\/offer\.html"[^\n]*\n/, '\n');
  ck('N3  removing the menu item is caught', n3 !== menu && menuDefects(n3).length > 0);
  const n3b = menu.replace("'<a class=\"sk-acct-link\" href=\"/offer.html\"", "(isSeller ? '' : '<a class=\"sk-acct-link\" href=\"/offer.html\"").replace("🏪 Register a business</a>' +", "🏪 Register a business</a>') +");
  ck('N4  hiding the item behind a role condition is caught', n3b !== menu && menuDefects(n3b).some((x) => /unconditional/.test(x)));
  const sfn = showSuccessOf(hub);
  const n5 = sfn.replace("var trackLink = 'complete-application.html';", "var trackLink = 'provider.html?cat=' + encodeURIComponent(data.category || 'other');");
  ck('N5  a restored provider.html?cat= success link is caught', n5 !== sfn && successDefects(n5).bad.some((x) => /provider\.html\?cat=/.test(x)));
  const n6 = sfn.replace('Application submitted — SOKONI reviews it in AdminOS', 'Your business is approved and live');
  ck('N6  an approval/live claim is caught', n6 !== sfn && successDefects(n6).bad.some((x) => /approved|live/.test(x)));
  const n7 = ra.replace("provider: 'provider-dashboard.html',", "provider: 'providers.html',");
  ck('N7  the old providers.html hub is caught', n7 !== ra && loadHubs(n7).hubFor('provider') !== 'provider-dashboard.html');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('\nOffer card → hub-register CATS id:');
  cards.forEach((c) => console.log('  ' + (c.label + '                              ').slice(0, 30) + (c.cat === null ? '(' + c.href + ')' : c.cat === '' ? '(none — applicant picks)' : c.cat + '  [hub ' + HR.category(c.cat).hub + ']')));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
