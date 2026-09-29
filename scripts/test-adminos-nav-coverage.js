#!/usr/bin/env node
/* ================================================================
   SOKONI — AdminOS navigation coverage: built ⇒ reachable
   scripts/test-adminos-nav-coverage.js

   THREE LEVELS, each derived from the PRODUCER (the served admin-os.html and
   the live SokoniAOS router), never from a hand-kept list of what should exist:

   1. NAVIGATION — every sidebar destination (each parent and each child) opens
      its panel, gets .active and exactly one aria-current="page"; survives a
      real reload of its deep link; works on a phone (drawer closes); works from
      the collapsed rail.
   2. CHILD ROUTING — every sidebar child goes through SokoniAOS.navigate(parent,
      tab) and the EXISTING *Tab() selector: the in-panel tab bar's .active moves
      to that tab, the hash reads #parent/tab, and nothing else re-implements it.
      A served-markup sabotage (the selector call removed from the router) must
      turn this red.
   3. COVERAGE — every #panel-* in the document has a sidebar parent; every tab
      button in every tab bar is reachable by deep link #section/tab; every
      module root (integrations, reports, revenue, invoices) mounts when its
      section is chosen; the Integrations page renders its catalogue with the
      module's own closed status vocabulary and counts "Live" from the
      catalogue's declared status, not from the number of entries. Body-only
      navigation controls are enumerated and reported for Slice D.

   HERMETIC: fake host served from disk, every other origin aborted, the same
   Firebase compat stub as the single-navigation suite. Cannot reach production.

   Run:  node scripts/test-adminos-nav-coverage.js
   Exit: 0 all passed · 1 a test failed · 2 the harness could not run
   ================================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const HOST = 'sokoni-cert.test';
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const shared = require(path.join(__dirname, 'lib', 'adminos-probe-lib.js'));

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); }
                          else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + (typeof d === 'string' ? d : JSON.stringify(d)) : '')); } };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
               '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

/* The owner-locked hierarchy (2026-09-29). Asserted as a SUBSET of what the
   document carries; the document, not this list, is the inventory. */
const LOCKED_CHILDREN = [
  ['marketplace', 'products'], ['marketplace', 'orders'], ['marketplace', 'reviews'],
  ['financial', 'wallet'], ['financial', 'payouts'], ['financial', 'disputes'], ['financial', 'commissions'],
  ['estate', 'sellers'], ['comms', 'push'],
];
/* Existing pages that must stay reachable from the sidebar's Tools group. */
const LOCKED_TOOLS = ['platform-health.html', 'admin-subscriptions.html', 'finos.html'];
const NO_CHILDREN = ['applications', 'config'];   /* single destinations by ruling */

async function newCtx(browser, { width, height, overrides = {} }) {
  const ctx = await browser.newContext({ viewport: { width, height }, ignoreHTTPSErrors: true });
  await ctx.addInitScript(shared.compatInit);
  await ctx.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== HOST) return route.abort();
    if (overrides[url.pathname] !== undefined)
      return route.fulfill({ status: 200, contentType: MIME[path.extname(url.pathname)] || 'text/plain', body: overrides[url.pathname] });
    if (/\/firebase\.js$/.test(url.pathname))
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: shared.instrumentedModule(ROOT) });
    if (/firebasejs/.test(url.pathname))
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: shared.gstaticStub(url.pathname) });
    const file = path.join(ROOT, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    if (!file.startsWith(ROOT)) return route.fulfill({ status: 403, body: '' });
    let buf; try { buf = fs.readFileSync(file); } catch (_) { return route.fulfill({ status: 404, body: '404' }); }
    return route.fulfill({ status: 200, contentType: MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', body: buf });
  });
  return ctx;
}
async function boot(page, hash) {
  /* Through about:blank, so a URL that differs only by its hash is a REAL reload
     (a same-document fragment navigation would leave the previous route's page
     alive and test hashchange, not the deep link). */
  await page.goto('about:blank');
  await page.goto('https://' + HOST + '/admin-os.html' + (hash || ''), { waitUntil: 'domcontentloaded', timeout: 30000 });
  try {
    await page.waitForFunction(() => !!(window.SokoniAOS && document.querySelector('#aosNav .nav-item.active')), { timeout: 20000 });
  } catch (_) { return false; }
  await page.waitForTimeout(250);
  await page.evaluate(() => ['sk-splash', 'sk-offline-bar'].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); }));
  return true;
}
/* What is on screen, read from the document. */
const state = (p) => p.evaluate(() => {
  const shown = [...document.querySelectorAll('.aos-panel')].filter((x) => !x.hidden).map((x) => x.id.replace(/^panel-/, ''));
  const cur = [...document.querySelectorAll('#aosNav [aria-current="page"]')].map((n) => n.dataset.section + (n.dataset.tab ? '/' + n.dataset.tab : ''));
  const act = [...document.querySelectorAll('#aosNav .nav-item.active')].map((n) => n.dataset.section + (n.dataset.tab ? '/' + n.dataset.tab : ''));
  const panel = shown[0] ? document.getElementById('panel-' + shown[0]) : null;
  const tabActive = panel ? [...panel.querySelectorAll('.tab-bar .tab-btn.active')].map((b) => b.dataset.tab) : [];
  return { shown, cur, act, tabActive, hash: location.hash, open: document.getElementById('aosSidebar').classList.contains('open') };
});

(async () => {
  const browser = await chromium.launch();
  const ctx = await newCtx(browser, { width: 1440, height: 900 });
  const p = await ctx.newPage();
  if (!(await boot(p))) { console.error('BLOCKED — AdminOS did not boot'); await browser.close(); process.exit(2); }

  /* ── inventory, derived from the served document ─────────────────────── */
  const inv = await p.evaluate(() => ({
    panels:   [...document.querySelectorAll('.aos-panel[id^="panel-"]')].map((x) => x.id.slice(6)),
    parents:  [...document.querySelectorAll('#aosNav .nav-item[data-section]:not([data-tab])')].map((n) => n.dataset.section),
    children: [...document.querySelectorAll('#aosNav .nav-item[data-section][data-tab]')].map((n) => [n.dataset.section, n.dataset.tab]),
    tabs:     [...document.querySelectorAll('.aos-panel[id^="panel-"] .tab-bar .tab-btn[data-tab]')].map((b) => [b.closest('.aos-panel').id.slice(6), b.dataset.tab]),
    roots:    ['integrationsRoot', 'reportsRoot', 'revenueRoot', 'invoicesBody'].filter((id) => document.getElementById(id))
                .map((id) => [document.getElementById(id).closest('.aos-panel').id.slice(6), id]),
    bodyNav:  [...document.querySelectorAll('.aos-content [onclick*="SokoniAOS.navigate("], .aos-header [onclick*="SokoniAOS.navigate("]')]
                .map((e) => (e.getAttribute('onclick').match(/navigate\('([a-z]+)'/) || [])[1]).filter(Boolean),
    bodyLinks: [...document.querySelectorAll('.aos-content a[href$=".html"], .aos-content a[href*=".html#"]')].map((a) => a.getAttribute('href')),
    labels: Object.fromEntries([...document.querySelectorAll('#aosNav .nav-item[data-section]:not([data-tab])')].map((n) => [n.dataset.section, n.dataset.label])),
  }));
  console.log('ADMINOS NAVIGATION COVERAGE\n');
  console.log(`  inventory (from the document): ${inv.panels.length} panels · ${inv.parents.length} sidebar parents · ${inv.children.length} children · ${inv.tabs.length} tab buttons · ${inv.roots.length} module roots\n`);

  /* ── LEVEL 3a: built ⇒ reachable ─────────────────────────────────────── */
  console.log('  [level 3 — coverage]');
  const unreachable = inv.panels.filter((s) => !inv.parents.includes(s));
  ok('C1  every #panel-* has a sidebar parent (a built panel is never body-only)', unreachable.length === 0, unreachable);
  const orphanParents = inv.parents.filter((s) => !inv.panels.includes(s));
  ok('C2  every sidebar parent has a panel (no decorative entries)', orphanParents.length === 0, orphanParents);
  const missingLocked = LOCKED_CHILDREN.filter(([s, t]) => !inv.children.some(([a, b]) => a === s && b === t));
  ok('C3  every owner-locked child exists in the sidebar', missingLocked.length === 0, missingLocked);
  const fakeChildren = inv.children.filter(([s, t]) => !inv.tabs.some(([a, b]) => a === s && b === t));
  ok('C4  every child corresponds to a DISTINCT existing tab (no fake children)', fakeChildren.length === 0, fakeChildren);
  const forbidden = inv.children.filter(([s]) => NO_CHILDREN.includes(s));
  ok('C5  Applications & Verification and Config & Settings have no children', forbidden.length === 0, forbidden);
  ok('C6  the two single destinations carry the ruled labels',
     /Applications & Verification/.test(inv.labels.applications) && /Config & Settings/.test(inv.labels.config), [inv.labels.applications, inv.labels.config]);
  const bodyOnly = inv.bodyNav.filter((s) => !inv.parents.includes(s));
  ok('C7  every in-body navigate() target is also a sidebar destination', bodyOnly.length === 0, bodyOnly);
  console.log('      body-only controls reported for Slice D: navigate() buttons=' + inv.bodyNav.length + ' external links=' + inv.bodyLinks.length);

  /* ── LEVEL 1: navigation, desktop click ───────────────────────────────── */
  console.log('\n  [level 1 — navigation: desktop click]');
  let bad = [];
  for (const s of inv.parents) {
    await p.click(`#aosNav .nav-item[data-section="${s}"]:not([data-tab])`); await p.waitForTimeout(120);
    const st = await state(p);
    if (!(st.shown.length === 1 && st.shown[0] === s && st.cur.length === 1 && st.cur[0].split('/')[0] === s && st.act.includes(st.cur[0]) && st.hash.startsWith('#' + s)))
      bad.push([s, st]);
  }
  ok(`N1  all ${inv.parents.length} parents: panel shown, .active, exactly one aria-current, hash set`, bad.length === 0, bad.slice(0, 3));

  /* ── LEVEL 2: child routing through the router + existing selector ───── */
  console.log('\n  [level 2 — child routing]');
  bad = [];
  for (const [s, t] of inv.children) {
    await p.click(`#aosNav .nav-item[data-section="${s}"][data-tab="${t}"]`); await p.waitForTimeout(150);
    const st = await state(p);
    const parentLit = await p.evaluate((s) => document.querySelector(`#aosNav .nav-item[data-section="${s}"]:not([data-tab])`).classList.contains('parent-active'), s);
    if (!(st.shown[0] === s && st.tabActive.length === 1 && st.tabActive[0] === t && st.cur.length === 1 && st.cur[0] === s + '/' + t && st.hash === '#' + s + '/' + t && parentLit))
      bad.push([s, t, st]);
  }
  ok(`R1  all ${inv.children.length} children: parent panel, existing tab bar on that tab, aria-current on the child only, parent lit, #parent/tab`, bad.length === 0, bad.slice(0, 3));
  /* the in-panel tab bar (secondary nav) reports back to the sidebar and the URL */
  await p.click('#aosNav .nav-item[data-section="financial"]:not([data-tab])'); await p.waitForTimeout(120);
  await p.click('#panel-financial .tab-bar .tab-btn[data-tab="disputes"]'); await p.waitForTimeout(150);
  let st = await state(p);
  ok('R2  clicking an in-panel tab moves the sidebar child + hash (secondary nav stays consistent)',
     st.cur.length === 1 && st.cur[0] === 'financial/disputes' && st.hash === '#financial/disputes', st);
  await p.click('#panel-financial .tab-bar .tab-btn[data-tab="escrow"]'); await p.waitForTimeout(150);
  st = await state(p);
  ok('R3  a tab with no sidebar child: parent is current, hash still names the tab', st.cur[0] === 'financial' && st.hash === '#financial/escrow', st);
  await p.click('#aosNav .nav-item[data-section="financial"]:not([data-tab])'); await p.waitForTimeout(120);
  st = await state(p);
  ok('R4  re-opening a loaded parent keeps the tab on screen and says so (no silent reset)', st.tabActive[0] === 'escrow' && st.hash === '#financial/escrow', st);
  const tools = await p.evaluate(() => [...document.querySelectorAll('#aosNav a.nav-item[href]')].map((a) => a.getAttribute('href')));
  const missingTools = LOCKED_TOOLS.filter((h) => !tools.includes(h));
  ok('R5  existing pages stay reachable from Tools (Platform Health, Subscriptions, FinOS)', missingTools.length === 0, { missingTools, tools });

  /* ── LEVEL 3b: module roots mount; Integrations uses its own vocabulary ── */
  console.log('\n  [level 3 — module roots & integrations]');
  bad = [];
  for (const [s, id] of inv.roots) {
    await p.click(`#aosNav .nav-item[data-section="${s}"]:not([data-tab])`); await p.waitForTimeout(700);
    const n = await p.evaluate((id) => document.getElementById(id).children.length, id);
    if (n === 0 && id !== 'invoicesBody') bad.push([s, id]);   /* Invoices is shop-scoped: it renders its shop prompt in the toolbar */
  }
  ok('M1  every module root renders when its section is chosen', bad.length === 0, bad);
  await p.click('#aosNav .nav-item[data-section="integrations"]:not([data-tab])'); await p.waitForTimeout(900);
  const vocab = (() => {
    const src = fs.readFileSync(path.join(ROOT, 'sokoni-integrations.js'), 'utf8');
    const block = (src.match(/var STATUS_META = \{([\s\S]*?)\};/) || [])[1] || '';
    return [...block.matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]);
  })();
  const ic = await p.evaluate(() => {
    const cat = window.SokoniIntegrationCatalogue;
    const list = cat ? (cat.integrations || cat.list || cat.entries || Object.values(cat).find(Array.isArray) || []) : [];
    const declaredLive = list.filter((e) => e && e.status === 'live').length;
    const pills = [...document.querySelectorAll('#integrationsRoot [class*="status"], #integrationsRoot [class*="pill"], #integrationsRoot [class*="badge"]')]
      .map((e) => e.textContent.trim()).filter((t) => t && t.length <= 24);
    return { mounted: !!document.querySelector('#integrationsRoot *'), pills: [...new Set(pills)], liveShown: pills.filter((t) => t === 'Live').length,
             declaredLive, entries: list.length, hasCatalogue: !!cat };
  });
  ok('I1  Integrations mounts the shared control center (sokoni-integrations.js) into #integrationsRoot', ic.mounted, ic);
  ok('I2  the module’s status vocabulary is closed and non-empty (derived from STATUS_META)', vocab.length >= 5, vocab);
  const foreign = ic.pills.filter((t) => vocab.includes(t) === false && !/^(Unknown|—)$/.test(t) && /^[A-Z][a-z]+( [a-z]+)?$/.test(t));
  ok('I3  every rendered status label is from that vocabulary (nothing invented)', foreign.length === 0, { foreign, pills: ic.pills });
  ok('I4  "Live" is shown for exactly the catalogue entries DECLARED live — not for every entry', ic.hasCatalogue && ic.entries > 0 && ic.liveShown === ic.declaredLive && ic.declaredLive < ic.entries, ic);

  /* ── LEVEL 1: collapsed rail ──────────────────────────────────────────── */
  console.log('\n  [level 1 — collapsed rail]');
  /* Wait for the width TRANSITION to settle rather than a fixed sleep: under load a
     0.2s transition can still be mid-flight at 300ms and read 67px. */
  await p.click('#aosSidebarToggle');
  await p.waitForFunction(() => Math.round(document.getElementById('aosSidebar').getBoundingClientRect().width) === 66, null, { timeout: 4000 }).catch(() => {});
  bad = [];
  const railW = await p.evaluate(() => Math.round(document.getElementById('aosSidebar').getBoundingClientRect().width));
  for (const s of inv.parents) {
    await p.click(`#aosNav .nav-item[data-section="${s}"]:not([data-tab])`); await p.waitForTimeout(80);
    const stt = await state(p); if (stt.shown[0] !== s || stt.cur[0].split('/')[0] !== s) bad.push(s);
  }
  for (const [s, t] of inv.children) {
    await p.click(`#aosNav .nav-item[data-section="${s}"][data-tab="${t}"]`); await p.waitForTimeout(120);
    const stt = await state(p); if (!(stt.shown[0] === s && stt.tabActive[0] === t && stt.cur[0] === s + '/' + t)) bad.push(s + '/' + t);
  }
  ok(`K1  from the ${railW}px rail, all parents and children still route`, railW === 66 && bad.length === 0, bad);
  await p.click('#aosSidebarToggle'); await p.waitForTimeout(200);
  await ctx.close();

  /* ── LEVEL 1: deep link survives a real reload — every parent, child, and tab ─ */
  console.log('\n  [level 1 — deep links, real reloads]');
  const routes = [...inv.parents.map((s) => [s, null]), ...inv.tabs];
  let dctx = await newCtx(browser, { width: 1440, height: 900 });
  let dp = await dctx.newPage();
  bad = [];
  let reloads = 0;
  for (const [s, t] of routes) {
    /* Recycle the context every dozen real reloads. On a memory-starved host the
       renderer accumulates until the OS kills the browser mid-loop, which reads
       as a harness crash rather than a product result. */
    if (++reloads % 12 === 0) { await dctx.close(); dctx = await newCtx(browser, { width: 1440, height: 900 }); dp = await dctx.newPage(); }
    const h = '#' + s + (t ? '/' + t : '');
    if (!(await boot(dp, h))) { bad.push([h, 'no boot']); continue; }
    if (t) await dp.waitForTimeout(150);
    const stt = await state(dp);
    const good = stt.shown[0] === s && stt.cur.length === 1 && (t ? stt.tabActive[0] === t : true) && stt.hash === h;
    if (!good) bad.push([h, stt]);
  }
  ok(`D1  ${routes.length} deep links (${inv.parents.length} sections + ${inv.tabs.length} tabs) each survive a reload onto the right panel/tab`, bad.length === 0, bad.slice(0, 3));
  ok('D2  a hostile/unknown hash falls back to the dashboard', (await boot(dp, '#nope%27%22%3E')) && (await state(dp)).shown[0] === 'dashboard' && (await state(dp)).hash === '#dashboard');
  ok('D3  a known section with an unknown tab opens the section on its default tab', (await boot(dp, '#financial/nosuch')) && (await state(dp)).shown[0] === 'financial' && (await state(dp)).tabActive[0] === 'payments');
  await dctx.close();

  /* ── LEVEL 1: mobile ─────────────────────────────────────────────────── */
  console.log('\n  [level 1 — mobile 390x844]');
  const mctx = await newCtx(browser, { width: 390, height: 844 });
  const mp = await mctx.newPage();
  if (!(await boot(mp))) { ok('mobile boot', false); }
  else {
    bad = [];
    const targets = [...inv.parents.map((s) => `#aosNav .nav-item[data-section="${s}"]:not([data-tab])`),
                     ...inv.children.map(([s, t]) => `#aosNav .nav-item[data-section="${s}"][data-tab="${t}"]`)];
    for (const sel of targets) {
      await mp.click('#aosMenuBtn'); await mp.waitForTimeout(280);
      await mp.click(sel); await mp.waitForTimeout(280);
      const stt = await state(mp);
      const want = await mp.evaluate((sel) => { const n = document.querySelector(sel); return n.dataset.section + (n.dataset.tab ? '/' + n.dataset.tab : ''); }, sel);
      if (stt.open || stt.cur[0] !== want || stt.shown[0] !== want.split('/')[0]) bad.push([want, stt]);
    }
    ok(`P1  all ${targets.length} destinations from the phone drawer: drawer closes, destination current`, bad.length === 0, bad.slice(0, 3));
    ok('P2  no horizontal overflow after the tour', (await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) === 0);
  }
  await mctx.close();

  /* ── SUPER ADMIN: everything reachable from BOTH consoles, one implementation ─
     For every AdminOS destination, super-admin.html must carry either a NATIVE
     panel button (SA.nav) or a LINK to the canonical AdminOS route — and every
     such link must be a route the AdminOS router accepts (proved by D1 above). */
  console.log('\n  [super admin — reachability, shared implementation]');
  const sctx = await newCtx(browser, { width: 1440, height: 900 });
  const sp = await sctx.newPage();
  await sp.goto('https://' + HOST + '/super-admin.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  let saBooted = true;
  try { await sp.waitForFunction(() => !!document.querySelector('#saSidebar .nav-item'), { timeout: 20000 }); } catch (_) { saBooted = false; }
  if (!saBooted) ok('S0  super-admin.html renders its sidebar under the same stub', false, 'no #saSidebar .nav-item');
  else {
    await sp.waitForTimeout(800);
    const sa = await sp.evaluate(() => {
      const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
      return {
        native: [...document.querySelectorAll('#saSidebar button.nav-item[data-section]')].map((b) => b.dataset.section),
        links:  [...document.querySelectorAll('#saSidebar a.nav-item[href^="admin-os.html#"]')].map((a) => a.getAttribute('href').replace(/^admin-os\.html#/, '')),
        childLinks: document.querySelectorAll('#saSidebar a.nav-item.nav-child').length,
        shellSide: box(document.getElementById('sk-adm-side')), shellHeader: box(document.getElementById('sk-adm-header')),
        shellCss: !!document.getElementById('sk-adm-css'),
        saSide: box(document.getElementById('saSidebar')),
        integrationsRootInSA: !!document.querySelector('#panel-integrations #integrationsRoot'),
      };
    });
    /* AdminOS destinations = every parent + every child, from the AdminOS inventory above. */
    const aosRoutes = [...inv.parents, ...inv.children.map(([s, t]) => s + '/' + t)];
    /* A native SA panel covers the AdminOS section of the same id (users, applications,
       financial, config, comms, audit, revenue, reports, integrations). Dashboard ⇔ overview. */
    const covered = (r) => sa.links.includes(r) || sa.native.includes(r) || (r === 'dashboard' && sa.native.includes('overview'));
    const missing = aosRoutes.filter((r) => !covered(r));
    ok(`S1  every AdminOS destination (${aosRoutes.length}) is reachable from Super Admin — natively or by link`, missing.length === 0, missing);
    const validRoutes = new Set([...inv.parents, ...inv.tabs.map(([s, t]) => s + '/' + t)]);
    const badLinks = sa.links.filter((r) => !validRoutes.has(r));
    ok('S2  every Super Admin link targets a route the AdminOS router accepts (no dead links)', badLinks.length === 0, badLinks);
    /* A child is linked as a child only where its PARENT is a link; a child whose
       parent is a native Super Admin panel (comms → Notifications) is a plain link. */
    const expectChildLinks = inv.children.filter(([s]) => sa.links.includes(s)).length;
    ok(`S3  child links mirror the AdminOS hierarchy under linked parents (${expectChildLinks})`, sa.childLinks === expectChildLinks, { childLinks: sa.childLinks, expectChildLinks });
    ok('S4  Super Admin keeps its native panels (nothing re-implemented or removed)',
       ['overview', 'users', 'applications', 'financial', 'config', 'revenue', 'reports', 'integrations', 'comms', 'audit'].every((n) => sa.native.includes(n)), sa.native);
    ok('S5  Integrations in Super Admin is the SAME shared control center (#integrationsRoot in its panel)', sa.integrationsRootInSA);
    /* "Controllable from both": a REAL click on the Super Admin sidebar must land.
       A 3s timeout, caught, so an overlay (e.g. the shared admin shell painting
       #sk-adm-side over #saSidebar) reads as a red check, not a dead harness. */
    let clickable = true, clickErr = '';
    try { await sp.click('#saSidebar button.nav-item[data-section="integrations"]', { timeout: 3000 }); } catch (e) { clickable = false; clickErr = String(e.message).split('\n').find((l) => /intercepts|Timeout/.test(l)) || e.message; }
    ok('S6  the Super Admin sidebar is clickable — nothing paints over it', clickable,
       { clickErr, shellSide: sa.shellSide, shellHeader: sa.shellHeader, saSidebar: sa.saSide });
    if (!clickable) await sp.evaluate(() => { try { SA.nav('integrations'); } catch (_) {} });
    await sp.waitForTimeout(900);
    const saIc = await sp.evaluate(() => ({ mounted: !!document.querySelector('#panel-integrations #integrationsRoot *'), shown: !document.getElementById('panel-integrations').hidden }));
    ok('S7  choosing Integrations in Super Admin mounts sokoni-integrations.js there', saIc.shown && saIc.mounted, saIc);
    console.log('      shared shell on super-admin.html (measured): side=' + JSON.stringify(sa.shellSide) + ' header=' + JSON.stringify(sa.shellHeader) + ' saSidebar=' + JSON.stringify(sa.saSide));
  }
  await sctx.close();

  /* ── NEGATIVE CONTROL: the router must be what selects the tab ───────── */
  console.log('\n  [negative control]');
  const aos = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8');
  const cut = aos.replace('if (requested) select(requested); else _loadPanel(section);', '_loadPanel(section);');
  if (cut === aos) { console.error('PROBE INVALID — sabotage target not found'); await browser.close(); process.exit(2); }
  const nctx = await newCtx(browser, { width: 1440, height: 900, overrides: { '/sokoni-aos.js': cut } });
  const np = await nctx.newPage();
  if (await boot(np)) {
    await np.click('#aosNav .nav-item[data-section="financial"][data-tab="payouts"]'); await np.waitForTimeout(200);
    const stt = await state(np);
    ok('NEGATIVE: with the selector call removed, a child click leaves the tab bar on the default (R1 is live)', stt.tabActive[0] !== 'payouts', stt);
  } else ok('NEGATIVE booted', false);
  await nctx.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR — ' + e.message); process.exit(2); });
