#!/usr/bin/env node
/* test-tech-directory.js — Tech Hub slice 1: real providers, canonical booking, in-app chat, no fabrication
 *
 *   node scripts/test-tech-directory.js
 *
 * EXECUTES sokoni-tech-directory.js in a sandbox with a stub DOM and stub SokoniProviders / SokoniBookService /
 * SokoniInbox, then checks phone-repair.html and electrical.html statically. Each behaviour check has a sabotage.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const MOD = fs.readFileSync(path.join(ROOT, 'sokoni-tech-directory.js'), 'utf8');

function sandbox(modSrc, listResult) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, innerHTML: '', textContent: '', __listeners: {}, addEventListener(t, f) { this.__listeners[t] = f; } });
  const calls = { list: [], book: [], chat: [] };
  const win = {
    firebaseDB: {},
    SokoniProviders: { list: async (o) => { calls.list.push(o); return listResult; } },
    SokoniBookService: { open: (o) => calls.book.push(o) },
    SokoniInbox: { openChat: (o) => calls.chat.push(o) },
  };
  const ctx = { window: win, document: { getElementById: el }, setTimeout, Promise, console, location: { href: '' } };
  ctx.globalThis = ctx; Object.assign(ctx, win); win.window = win;
  vm.createContext(ctx); vm.runInContext(modSrc, ctx);
  return { ctx, els, calls, api: win.SokoniTechDirectory };
}
const P = (o) => Object.assign({ uid: 'u1', name: 'Fix Ltd', categoryLabel: 'Phone Repair', category: 'phone-repair', categories: ['phone-repair'], location: 'Nairobi', city: 'Nairobi', description: 'Screens and batteries', skills: ['iPhone', 'Samsung'], rating: null, reviewCount: 0, jobsCompleted: 0, rate: null, rateType: '', photo: '', verified: false, acceptsBookings: true, chatEnabled: true, emoji: '📱', profileUrl: 'provider-profile.html?uid=u1' }, o);
const CFG = { grid: 'g', count: 'c', category: 'phone-repair', prefix: 'pg', noun: 'technician' };

async function behaviour(modSrc) {
  const r = {};
  /* list with two providers: one with real rating + jobs, one new; one hostile name */
  {
    const s = sandbox(modSrc, { providers: [P({ uid: 'a', name: 'Pro <b>A</b>', rating: 4.6, reviewCount: 12, jobsCompleted: 40, verified: true }), P({ uid: 'b', name: 'Newbie', location: 'Mombasa', skills: ['Tecno'] })], error: null });
    await s.api.mount(Object.assign({}, CFG, { search: () => '', type: () => '', location: () => '' }));
    const h = s.els.g.innerHTML;
    r.T1 = s.calls.list.length === 1 && s.calls.list[0].category === 'phone-repair' && /data-uid="a"/.test(h) && /data-uid="b"/.test(h) && /2 technicians/.test(s.els.c.textContent);
    r.T2 = /4\.6 · 12 reviews/.test(h) && /40 jobs/.test(h) && /New on SOKONI/.test(h) && !/[^0-9]0 jobs/.test(h) && (h.match(/✓ Verified/g) || []).length === 1;
    r.T3 = !/<b>A<\/b>/.test(h) && /Pro &lt;b&gt;A&lt;\/b&gt;/.test(h);
    /* actions */
    s.els.g.__listeners.click({ target: { closest: () => ({ getAttribute: (k) => (k === 'data-tech-act' ? 'book' : 'a') }) } });
    s.els.g.__listeners.click({ target: { closest: () => ({ getAttribute: (k) => (k === 'data-tech-act' ? 'chat' : 'b') }) } });
    r.T6 = s.calls.book.length === 1 && s.calls.book[0].providerId === 'a' && s.calls.chat.length === 1 && s.calls.chat[0].otherUid === 'b';
    /* filters */
    const s2 = sandbox(modSrc, { providers: [P({ uid: 'a', location: 'Nairobi', skills: ['iPhone'] }), P({ uid: 'b', location: 'Mombasa', skills: ['Tecno'] })], error: null });
    await s2.api.mount(Object.assign({}, CFG, { search: () => '', type: () => 'tecno', location: () => 'mombasa' }));
    r.T7 = /data-uid="b"/.test(s2.els.g.innerHTML) && !/data-uid="a"/.test(s2.els.g.innerHTML);
  }
  /* unreachable registry is NOT an empty list */
  {
    const s = sandbox(modSrc, { providers: [], error: new Error('unavailable') });
    await s.api.mount(Object.assign({}, CFG));
    r.T4 = /not an empty list/.test(s.els.g.innerHTML) && !/No approved/.test(s.els.g.innerHTML);
  }
  /* a real, server-confirmed empty registry invites applications */
  {
    const s = sandbox(modSrc, { providers: [], error: null });
    await s.api.mount(Object.assign({}, CFG));
    r.T5 = /No approved technicians are listed here yet/.test(s.els.g.innerHTML) && /href="offer\.html" data-tech-act="apply" data-cat="phone-repair"/.test(s.els.g.innerHTML);
  }
  return r;
}

function pages(read) {
  const out = {};
  for (const [f, cat] of [['phone-repair.html', 'phone-repair'], ['electrical.html', 'electrical']]) {
    const s = read(f);
    out[f] = {
      noArray: !/const PROVIDERS ?= ?\[/.test(s),
      noWhatsApp: !/wa\.me|waConnect\(/.test(s),
      noFakeInvoice: !/SokoniInvoice\.generate\(/.test(s),
      noFakeReviews: !/class="pg-reviews"/.test(s),
      register: s.includes(`data-tech-act="apply" data-cat="${cat}"`) && !/business-apply\.html|provider\.html\?cat=/.test(s),
      modules: ['firebase.js', 'sokoni-providers.js', 'sokoni-book-service.js', 'sokoni-inbox.js', 'sokoni-tech-directory.js'].every((m) => s.includes(`src="${m}"`)),
      mounted: new RegExp("category: '" + cat + "'").test(s) && /SokoniTechDirectory\.mount\(_TECH\)/.test(s),
    };
  }
  return out;
}


/* slice 4P: the web badge uses the server's predicate (functions/shared/provider-badge.js badgeValid) */
function badgeWeb() {
  const vm = require('vm');
  const src = fs.readFileSync(path.join(ROOT, 'sokoni-providers.js'), 'utf8');
  const w = {}; const c = { window: w, document: { addEventListener() {} }, console, setTimeout };
  c.globalThis = c; w.window = w; vm.createContext(c);
  try { vm.runInContext(src, c); } catch (_) { return null; }
  const norm = w.SokoniProviders && (w.SokoniProviders.normalize || (w.SokoniProviders._internal && w.SokoniProviders._internal.normalize));
  if (typeof norm !== 'function') return null;
  const v = (d) => norm('u1', Object.assign({ status: 'active', name: 'Fix Ltd' }, d)).verified;
  return {
    projected: v({ verified: true, verifiedName: 'Fix Ltd' }) === true,
    renamed: v({ verified: true, verifiedName: 'Old Name' }) === false,
    review: v({ verified: true, verifiedName: 'Fix Ltd', verificationReviewRequired: true }) === false,
    ownerFlag: v({ providerVerified: true, isVerified: true }) === false,
    legacy: v({ verified: true }) === true,
  };
}
/* slice 2: tech-hub.html tabs + providers.html booking */
function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) return src.slice(i, j + 1); } }
  return '';
}
function providersBooking(html) {
  const vm = require('vm');
  const calls = { open: [], saveDoc: 0, ls: 0, toast: [], href: '' };
  const ctx = {
    PROVIDERS: [{ uid: 'u9', name: 'Wire Pro', role: 'Electrician', location: 'Nakuru' }],
    _bookingProviderId: null,
    SokoniBookService: { open: (o) => calls.open.push(o) },
    SokoniDB: { saveDoc: () => { calls.saveDoc++; return Promise.resolve(); } },
    localStorage: { getItem: () => '[]', setItem: () => { calls.ls++; } },
    document: { getElementById: (id) => ({ value: id === 'pvBookPhone' ? '0712345678' : 'x', classList: { add() {}, remove() {} }, textContent: '' }) },
    location: { set href(v) { calls.href = v; } },
    _skToast: (m) => calls.toast.push(m), alert: (m) => calls.toast.push(m),
    encodeURIComponent,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(['openBookModal', 'closeBookModal', 'confirmBooking'].map((n) => fnSrc(html, n)).join('\n'), ctx);
  vm.runInContext("openBookModal('u9'); confirmBooking();", ctx);
  const engine = calls.open.length >= 1 && calls.open[0].providerId === 'u9';
  const noWrite = calls.saveDoc === 0 && calls.ls === 0;
  const noFake = !calls.toast.some((m) => /confirmed/i.test(m));
  delete ctx.SokoniBookService;
  vm.runInContext("openBookModal('u9');", ctx);
  return { engine, noWrite, noFake, fallback: calls.href === 'provider-profile.html?uid=u9' };
}
function pages2(read) {
  const th = read('tech-hub.html'), pv = read('providers.html');
  return {
    'tech-hub.html': {
      noDemo: !/(?:const|let|var)\s+DEMO_(?:TECHS|IT)\b|DEMO_(?:TECHS|IT)\s*[.\[]/.test(th.replace(/\/\*[\s\S]*?\*\//g, '')),
      noClientRepairWrite: !/['"]techRepairs['"]/.test(th),
      techsMounted: /SokoniTechDirectory\.mount\(cfg\)/.test(fnSrc(th, 'filterTechs')) && /grid: 'techsGrid'/.test(th),
      itMounted: /grid: 'itsGrid'/.test(fnSrc(th, 'filterITServices')),
      modules: ['firebase.js', 'sokoni-providers.js', 'sokoni-book-service.js', 'sokoni-inbox.js', 'sokoni-tech-directory.js'].every((m) => th.includes('src="' + m + '"')),
    },
    'providers.html': Object.assign({ modules: ['sokoni-intasend.js', 'sokoni-book-service.js'].every((m) => pv.includes('src="' + m + '"')) }, providersBooking(pv)),
  };
}


/* slice 2b: home-services.html + services.html fallbacks */
function spyCtx(extra) {
  const vm = require('vm');
  const calls = { open: [], writes: [], wa: 0, ls: 0, href: '', chat: [], mounts: [] };
  const el = () => ({ value: '', textContent: '', innerHTML: '', style: {}, classList: { add() {}, remove() {} } });
  const ctx = Object.assign({
    SokoniBookService: { open: (o) => calls.open.push(o) },
    SokoniInbox: { openChat: (o) => calls.chat.push(o) },
    SokoniTechDirectory: { mount: (o) => calls.mounts.push(o) },
    SokoniDB: { saveDoc: () => { calls.writes.push('saveDoc'); return Promise.resolve(); }, saveBooking: () => { calls.writes.push('saveBooking'); return Promise.resolve(); } },
    SokoniPay: { waConnect: () => { calls.wa++; }, bookNow: () => { calls.writes.push('bookNow'); } },
    SokoniInvoice: { generate: () => calls.writes.push('invoice') },
    _hsFireWrite: (c) => { calls.writes.push(c); return Promise.resolve(); },
    localStorage: { getItem: () => '[]', setItem: () => { calls.ls++; } },
    document: { getElementById: (id) => Object.assign(el(), { value: id === 'bkService' || id === 'regService' ? '🔧 Plumbing' : 'x' }), querySelector: () => null, querySelectorAll: () => [] },
    location: { set href(v) { calls.href = v; }, get href() { return calls.href; } },
    open: () => { calls.wa++; },
    setTimeout: () => 0, encodeURIComponent, String, Number,
  }, extra || {});
  ctx.window = ctx;
  vm.createContext(ctx);
  return { ctx, calls, run: (code) => vm.runInContext(code, ctx) };
}
function homeServices(html) {
  const went = {};
  const t = spyCtx({ _hsTypeFilter: 'all', HS_TYPES: [{ key: 'plumbing', label: 'Plumbing' }], goFindType: (k) => { went.k = k; } });
  t.run(['filterProviders', 'bookHomeService', 'contactProvider', 'registerProvider', 'submitReview'].map((n) => fnSrc(html, n)).join('\n'));
  t.run("bookHomeService(); contactProvider('p7','Pipes Ltd');");
  const r = {
    bookNoWrite: t.calls.writes.length === 0 && t.calls.ls === 0 && t.calls.wa === 0 && went.k === 'plumbing',
    contactInApp: t.calls.chat.length === 1 && t.calls.chat[0].otherUid === 'p7',
  };
  t.run('filterProviders();');
  r.findOnRegistry = t.calls.mounts.length === 1 && t.calls.mounts[0].grid === 'hsProvidersGrid' && t.calls.mounts[0].category === 'home-services';
  t.ctx.SokoniTechDirectory.apply = (c, h) => { r._applied = c + '|' + h; };
  t.run('registerProvider();');
  r.registerApplies = r._applied === 'plumbing|home-services' && t.calls.wa === 0;
  delete r._applied;
  t.run('submitReview();');
  r.noClientReview = t.calls.writes.length === 0;
  r.noWhatsApp = !/wa\.me\//.test(html.replace(/\/\*[\s\S]*?\*\//g, ''));
  r.modules = ['firebase.js', 'sokoni-providers.js', 'sokoni-book-service.js', 'sokoni-inbox.js', 'sokoni-tech-directory.js'].every((m) => html.includes('src="' + m + '"'));
  return r;
}
function servicesPage(html) {
  const t = spyCtx({ getProviders: () => [{ uid: 's1', name: 'Clean Co' }], _currentBookingProviderId: 's1', allProducts: [{ id: 'L1', name: 'Gutter clean' }] });
  t.run(['openBookingModal', 'submitBooking', 'bookServiceListing'].map((n) => fnSrc(html, n)).join('\n'));
  t.run("submitBooking();");
  const r = { submitEngine: t.calls.open.length === 1 && t.calls.open[0].providerId === 's1', submitNoWrite: t.calls.writes.length === 0 && t.calls.ls === 0 };
  delete t.ctx.SokoniBookService;
  t.run("openBookingModal('s1');");
  r.fallbackStorefront = t.calls.href === 'provider-profile.html?uid=s1' && t.calls.writes.indexOf('bookNow') < 0;
  t.run("bookServiceListing('L1');");
  r.listingNoWhatsApp = t.calls.wa === 0 && t.calls.href === 'product.html?id=L1';
  r.noWhatsApp = !/wa\.me\//.test(html.replace(/\/\*[\s\S]*?\*\//g, ''));
  return r;
}


/* slice 3: one intake */
function intake(modSrc) {
  const s = sandbox(modSrc, { providers: [] });
  const opened = [];
  s.ctx.window.location = { href: '' };
  s.ctx.window.HubRegister = { open: (o) => opened.push(o) };
  const r = {};
  s.api.apply('networking');
  s.api.apply('gardening');
  s.api.apply('made-up-category', 'tech');
  r.mapsToExistingIds = opened.length === 3 && opened[0].category === 'networking' && opened[0].hub === 'tech'
    && opened[1].category === 'landscaping' && opened[1].hub === 'home-services' && !('category' in opened[2]) && opened[2].hub === 'tech';
  delete s.ctx.window.HubRegister;
  s.api.apply('cctv');
  r.fallbackOffer = s.ctx.window.location.href === 'offer.html';
  return r;
}
function servicesRegister(html) {
  const t = spyCtx({ SokoniTechDirectory: { apply: (c) => { t.applied = c; } } });
  t.ctx.document.getElementById = (id) => ({ value: id === 'pvCategory' ? 'plumbing' : 'x' });
  t.run(fnSrc(html, 'registerProvider'));
  t.run('registerProvider();');
  return { oneIntake: t.applied === 'plumbing' && t.calls.writes.length === 0 && t.calls.ls === 0, noSelfListing: !/saveProvider\(|saveApplication\(/.test(html.replace(/\/\*[\s\S]*?\*\//g, '')) };
}


/* slice 4a: the intake never names an id hub-register does not list, and every Tech id is registrable */
function taxonomy(modSrc, hubSrc) {
  const vm = require('vm');
  const ctx = { window: {}, document: { addEventListener() {}, getElementById: () => null } }; ctx.window.window = ctx.window; ctx.window.document = ctx.document; vm.createContext(ctx);
  vm.runInContext(hubSrc.replace("'use strict';", "'use strict'; window.__CATS = null;").replace('var CATS = [', 'var CATS = window.__CATS = ['), ctx);
  const CATS = ctx.window.__CATS || [];
  const ids = new Set(CATS.map((c) => c.id));
  const s = sandbox(modSrc, { providers: [] });
  const map = s.api._internal.INTAKE_CAT || {};
  /* the Tech ids the capability engine maps (functions/shared/service-capabilities.js, feat/tech-taxonomy-on-13f74f3 81cde54) */
  const SERVER_TECH = ['phone-repair', 'laptop-repair', 'computer-repair', 'electronics-repair', 'it-support', 'networking', 'cctv', 'pos-support', 'web-developer', 'software', 'app-developer', 'data-entry', 'electrical'];
  return {
    intakeIdsExist: Object.values(map).every((v) => ids.has(v)),
    everyTechIdRegistrable: SERVER_TECH.every((id) => ids.has(id)),
    techHubOnTech: ['laptop-repair', 'computer-repair', 'electronics-repair', 'networking', 'pos-support'].every((id) => (CATS.find((c) => c.id === id) || {}).hub === 'tech'),
  };
}

(async () => {
  let pass = 0, fail = 0, caught = 0;
  const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
  console.log('\nTECH DIRECTORY — slices 1-4a\n');
  const LABELS = { T1: 'lists approved providers from the registry by category', T2: 'ratings / jobs only when real; "New on SOKONI" otherwise; verified only from the record', T3: 'provider text is escaped', T4: 'an unreachable registry is NOT shown as an empty list', T5: 'a real empty registry invites applications through the ONE intake (HubRegister / offer.html)', T6: 'Book → SokoniBookService.open(providerId); Message → in-app chat', T7: 'search / type / location filters' };
  const b = await behaviour(MOD);
  for (const k of Object.keys(LABELS)) ck(k + '  ' + LABELS[k], b[k] === true);
  const pg = pages((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));
  for (const f of Object.keys(pg)) for (const [k, v] of Object.entries(pg[f])) ck('P   ' + f + ': ' + k, v);

  const pg2 = pages2((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'));
  for (const f of Object.keys(pg2)) for (const [k, v] of Object.entries(pg2[f])) ck('P2  ' + f + ': ' + k, v);
  const rd = (x) => fs.readFileSync(path.join(ROOT, x), 'utf8');
  for (const [k, v] of Object.entries(homeServices(rd('home-services.html')))) ck('P3  home-services.html: ' + k, v);
  for (const [k, v] of Object.entries(servicesPage(rd('services.html')))) ck('P3  services.html: ' + k, v);
  for (const [k, v] of Object.entries(intake(MOD))) ck('T8  one intake: ' + k, v);
  for (const [k, v] of Object.entries(servicesRegister(rd('services.html')))) ck('P4  services.html: ' + k, v);
  for (const [k, v] of Object.entries(taxonomy(MOD, rd('hub-register.js')))) ck('T9  taxonomy: ' + k, v);
  { const bw = badgeWeb(); if (!bw) ck('P5  badge predicate loads', false); else for (const [k, v] of Object.entries(bw)) ck('P5  web badge: ' + k, v); }
  console.log('\n  [sabotage]');
  const SAB = {
    T2: MOD.replace("'<span class=\"' + x + '-prov-rnum\">New on SOKONI</span>'", "'<span class=\"' + x + '-prov-rnum\">4.9 · 0 jobs</span>'"),
    T3: MOD.replace("+ esc(p.name) + '</a>'", "+ p.name + '</a>'"),
    T4: MOD.replace("if (r.error && !all.length) {", "if (false) {"),
    T6: MOD.replace("G.SokoniBookService.open({ providerId: p.uid, providerName: p.name });", "location.href = 'https://wa.me/254700000000';"),
  };
  for (const [k, src] of Object.entries(SAB)) {
    if (src === MOD) { ck('sabotage ' + k + ' anchor missing', false); continue; }
    const rb = await behaviour(src);
    const red = rb[k] !== true;
    console.log('  ' + (red ? 'CAUGHT' : 'MISSED') + '  ' + k); red ? caught++ : fail++;
  }
  const pageSab = pages((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace('<script>\n/* 2026-10-03 (Tech Hub', '<script>\nconst PROVIDERS=[{id:"X"}];\n/* 2026-10-03 (Tech Hub').replace('<script>\r\n/* 2026-10-03 (Tech Hub', '<script>\r\nconst PROVIDERS=[{id:"X"}];\r\n/* 2026-10-03 (Tech Hub'));
  const redP = !pageSab['phone-repair.html'].noArray;
  console.log('  ' + (redP ? 'CAUGHT' : 'MISSED') + '  P noArray'); redP ? caught++ : fail++;
  const pvSrc = fs.readFileSync(path.join(ROOT, 'providers.html'), 'utf8');
  const pvBad = pvSrc.replace(/closeBookModal\(\);(\r?\n  if \(_bookingProviderId\))/, "SokoniDB.saveDoc('providerBookings', {status:'Confirmed'}); _skToast('Booking confirmed!'); closeBookModal();$1");
  const pvSab = pvBad === pvSrc ? { noWrite: true, noFake: true } : providersBooking(pvBad);
  const redPv = !pvSab.noWrite && !pvSab.noFake;
  console.log('  ' + (redPv ? 'CAUGHT' : 'MISSED') + '  P2 providers fake confirm'); redPv ? caught++ : fail++;
  const thSab = pages2((f) => { const t = fs.readFileSync(path.join(ROOT, f), 'utf8'); return f === 'tech-hub.html' ? t + '<script>const DEMO_TECHS=[];</script>' : t; });
  const redTh = !thSab['tech-hub.html'].noDemo;
  console.log('  ' + (redTh ? 'CAUGHT' : 'MISSED') + '  P2 tech-hub demo'); redTh ? caught++ : fail++;
  {
    const hs = fs.readFileSync(path.join(ROOT, 'home-services.html'), 'utf8');
    const bad = hs.replace("goFindType(hit?hit.key:'all');", "_hsFireWrite('homeServiceBookings',{}); goFindType(hit?hit.key:'all');");
    const red = bad !== hs && homeServices(bad).bookNoWrite !== true;
    console.log('  ' + (red ? 'CAUGHT' : 'MISSED') + '  P3 home-services booking write'); red ? caught++ : fail++;
    const sv = fs.readFileSync(path.join(ROOT, 'services.html'), 'utf8');
    const bad2 = sv.replace("window.location.href = 'product.html?id=' + encodeURIComponent(p.id);", "SokoniPay.waConnect('2547', 'hi', {});");
    const red2 = bad2 !== sv && servicesPage(bad2).listingNoWhatsApp !== true;
    console.log('  ' + (red2 ? 'CAUGHT' : 'MISSED') + '  P3 services WhatsApp hand-off'); red2 ? caught++ : fail++;
  }
  {
    const bad = MOD.replace("networking: 'networking',", "networking: 'network-engineer',");
    const red = bad !== MOD && intake(bad).mapsToExistingIds !== true;
    console.log('  ' + (red ? 'CAUGHT' : 'MISSED') + '  T8 intake mapping'); red ? caught++ : fail++;
  }
  {
    const hub = rd('hub-register.js');
    const badHub = hub.replace("{ id:'networking',", "{ id:'network-install',");
    const red = badHub !== hub && taxonomy(MOD, badHub).intakeIdsExist !== true;
    console.log('  ' + (red ? 'CAUGHT' : 'MISSED') + '  T9 intake id missing from hub-register'); red ? caught++ : fail++;
  }
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed, ' + caught + '/11 sabotages caught');
  console.log('  NOT proven here: a real browser render and a real booking (needs a browser run and an approved provider with services).\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
