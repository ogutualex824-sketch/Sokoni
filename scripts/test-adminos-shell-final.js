#!/usr/bin/env node
/* ================================================================
   SOKONI — AdminOS shell: one primary navigation path, header preserved,
   responsive at five widths
   scripts/test-adminos-shell-final.js

   THE INVARIANT (Slice D). Every GLOBAL destination has exactly ONE canonical
   primary navigation path — its sidebar item — and the dashboard carries no
   second navigation system. CONTEXTUAL links (a related tool beside the work,
   inside Financial / SmartPOS / Delivery) remain as secondary paths.

   The header's existing controls are preserved and PROVEN usable, not merely
   present: menu button, breadcrumb, quick search (routes to Users), bell
   (routes through the canonical #comms/push), and the profile (user chip +
   Sign Out) reachable on every width. The bell's route is checked against a
   served-markup negative control.

   Five widths: 320 / 390 / 768 / 1024 / 1440. At each: no horizontal overflow,
   header usable, content never under the header or the sidebar, drawer or
   rail works, keyboard reaches the controls.

   HERMETIC: fake host from disk, other origins aborted, the same Firebase
   compat stub as the single-navigation suite. Cannot reach production.

   Run:  node scripts/test-adminos-shell-final.js
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

async function openPage(browser, { width, height, overrides = {} }) {
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
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('https://' + HOST + '/admin-os.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  let booted = true;
  try { await page.waitForFunction(() => !!(window.SokoniAOS && document.querySelector('#aosNav .nav-item.active')), { timeout: 20000 }); }
  catch (_) { booted = false; }
  if (booted) {
    await page.waitForTimeout(300);
    await page.evaluate(() => ['sk-splash', 'sk-offline-bar'].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); }));
  }
  return { page, ctx, booted, errors };
}
const state = (p) => p.evaluate(() => {
  const shown = [...document.querySelectorAll('.aos-panel')].filter((x) => !x.hidden).map((x) => x.id.replace(/^panel-/, ''));
  const cur = [...document.querySelectorAll('#aosNav [aria-current="page"]')].map((n) => n.dataset.section + (n.dataset.tab ? '/' + n.dataset.tab : ''));
  const panel = shown[0] ? document.getElementById('panel-' + shown[0]) : null;
  const tabActive = panel ? [...panel.querySelectorAll('.tab-bar .tab-btn.active')].map((b) => b.dataset.tab) : [];
  return { shown, cur, tabActive, hash: location.hash, open: document.getElementById('aosSidebar').classList.contains('open') };
});
async function tabTo(page, selector, max = 100) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate((sel) => document.activeElement && document.activeElement.matches(sel), selector)) return i + 1;
  }
  return -1;
}
const inView = (r, vw, vh) => r && r.w > 0 && r.h > 0 && r.left >= -1 && r.top >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1;

(async () => {
  const browser = await chromium.launch();

  /* ── ONE PRIMARY PATH ─────────────────────────────────────────────────── */
  console.log('ADMINOS SHELL — ONE PRIMARY PATH, HEADER PRESERVED, FIVE WIDTHS\n');
  console.log('  [one canonical primary navigation path per global destination]');
  let d = await openPage(browser, { width: 1440, height: 900 });
  if (!d.booted) { console.error('BLOCKED — AdminOS did not boot'); await browser.close(); process.exit(2); }
  let p = d.page;
  const nav = await p.evaluate(() => {
    const items = [...document.querySelectorAll('#aosNav .nav-item')];
    const routes = items.filter((n) => n.dataset.section).map((n) => n.dataset.section + (n.dataset.tab ? '/' + n.dataset.tab : ''));
    const tools  = items.filter((n) => n.tagName === 'A' && n.getAttribute('href')).map((n) => n.getAttribute('href'));
    const dup = (arr) => arr.filter((x, i) => arr.indexOf(x) !== i);
    return {
      routes, tools, dupRoutes: dup(routes), dupTools: dup(tools),
      quickLinks: document.querySelectorAll('.quick-links, .quick-link').length,
      /* any link INSIDE the content area that targets a sidebar Tools destination is a duplicate primary path */
      bodyLinksToTools: [...document.querySelectorAll('.aos-content a[href]')].map((a) => a.getAttribute('href')).filter((h) => tools.includes(h)),
      dashboardLinks: document.querySelectorAll('#panel-dashboard a[href]').length,
      contextual: {
        financial: [...document.querySelectorAll('#panel-financial .panel-toolbar a[href]')].map((a) => a.getAttribute('href')),
        smartpos:  [...document.querySelectorAll('#panel-smartpos .panel-toolbar a[href]')].map((a) => a.getAttribute('href')),
        delivery:  [...document.querySelectorAll('#panel-delivery a[href]')].map((a) => a.getAttribute('href')),
      },
      bodyNavigate: [...document.querySelectorAll('.aos-content [onclick*="SokoniAOS.navigate("]')].length,
    };
  });
  ok('P1  every sidebar route appears exactly once (no duplicate primary path)', nav.dupRoutes.length === 0 && nav.dupTools.length === 0, { dupRoutes: nav.dupRoutes, dupTools: nav.dupTools });
  ok('P2  the dashboard carries no quick-link grid and no links at all', nav.quickLinks === 0 && nav.dashboardLinks === 0, { quickLinks: nav.quickLinks, dashboardLinks: nav.dashboardLinks });
  ok('P3  the three formerly dashboard-only destinations now live in Tools',
     ['financial-os.html', 'seller-success.html', 'merchant-pipeline.html'].every((h) => nav.tools.includes(h)), nav.tools);
  /* FinOS / Financial OS inside Financial are CONTEXTUAL (a related tool beside the
     work) and are allowed as secondary paths; nothing else in the body may point at
     a Tools destination. */
  const allowedContextual = new Set(['finos.html', 'financial-os.html']);
  const strayBody = nav.bodyLinksToTools.filter((h) => !allowedContextual.has(h));
  ok('P4  no body link duplicates a Tools destination except the allowed contextual pair in Financial', strayBody.length === 0, strayBody);
  ok('P5  contextual tool links are preserved (Financial 2, SmartPOS 3, Delivery 3)',
     nav.contextual.financial.length === 2 && nav.contextual.smartpos.length === 3 && nav.contextual.delivery.length === 3, nav.contextual);
  ok('P6  no navigate() control remains inside the content area', nav.bodyNavigate === 0, nav.bodyNavigate);

  /* the bell: existing function, canonical route */
  await p.click('#aosBellBtn'); await p.waitForTimeout(250);
  let st = await state(p);
  ok('B1  the header bell opens Communications on the existing Push tab through #comms/push',
     st.shown[0] === 'comms' && st.tabActive[0] === 'push' && st.cur[0] === 'comms/push' && st.hash === '#comms/push', st);
  /* the search: existing function, routes to Users */
  await p.fill('.aos-header-search input', 'ab'); await p.waitForTimeout(250);
  st = await state(p);
  ok('B2  typing in the header search routes to Users (existing behaviour preserved)', st.shown[0] === 'users' && st.cur[0] === 'users', st);
  ok('B3  no page errors', d.errors.length === 0, d.errors);
  await d.ctx.close();

  /* ── FIVE WIDTHS ─────────────────────────────────────────────────────── */
  for (const [w, h] of [[320, 700], [390, 844], [768, 1024], [1024, 768], [1440, 900]]) {
    console.log(`\n  [${w}x${h}]`);
    const r = await openPage(browser, { width: w, height: h });
    if (!r.booted) { ok(`${w}: boot`, false, 'did not boot'); await r.ctx.close(); continue; }
    p = r.page;
    const mobile = w <= 768;
    const m = await p.evaluate(() => {
      const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        return { left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height), display: cs.display, visibility: cs.visibility }; };
      return { vw: innerWidth, vh: innerHeight, overflow: document.documentElement.scrollWidth - innerWidth,
        header: box('.aos-header'), search: box('.aos-header-search input'), bell: box('#aosBellBtn'), menu: box('#aosMenuBtn'),
        crumb: box('#aosBreadcrumb'), side: box('#aosSidebar'), main: box('.aos-main'), panel: box('#panel-dashboard'),
        chip: box('.aos-user-chip'), signout: box('.signout-btn') };
    });
    ok(`${w}: no horizontal overflow`, m.overflow === 0, m.overflow);
    ok(`${w}: header usable — visible, search and bell inside the viewport`,
       m.header && m.header.h > 0 && inView(m.search, m.vw, m.vh) && inView(m.bell, m.vw, m.vh) && m.search.w >= 60, { header: m.header, search: m.search, bell: m.bell });
    ok(`${w}: content sits below the header and beside (not under) the sidebar`,
       m.panel.top >= m.header.bottom - 1 && (mobile ? m.main.left === 0 && m.side.right <= 0 : m.main.left >= m.side.right - 1), { panel: m.panel, header: m.header, main: m.main, side: m.side });
    if (mobile) {
      ok(`${w}: menu button shown; sidebar off-canvas`, m.menu && m.menu.display !== 'none' && inView(m.menu, m.vw, m.vh) && m.side.right <= 0, { menu: m.menu, side: m.side });
      await p.click('#aosMenuBtn'); await p.waitForTimeout(350);
      const o = await p.evaluate(() => { const b = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
        return { side: b('#aosSidebar'), chip: b('.aos-user-chip'), signout: b('.signout-btn'), vw: innerWidth, vh: innerHeight, open: document.getElementById('aosSidebar').classList.contains('open') }; });
      ok(`${w}: drawer opens; profile (user chip + Sign Out) reachable inside the viewport`, o.open && o.side.left === 0 && inView(o.chip, o.vw, o.vh) && inView(o.signout, o.vw, o.vh), o);
      await p.keyboard.press('Escape'); await p.waitForTimeout(300);
      ok(`${w}: Escape closes the drawer`, !(await state(p)).open);
      await p.evaluate(() => document.body.focus());
      const tMenu = await tabTo(p, '#aosMenuBtn'), tSearch = await tabTo(p, '.aos-header-search input'), tBell = await tabTo(p, '#aosBellBtn');
      ok(`${w}: keyboard reaches menu → search → bell in order`, tMenu > 0 && tSearch > 0 && tBell > 0, { tMenu, tSearch, tBell });
    } else {
      ok(`${w}: menu button hidden; sidebar fixed 220px; profile (user chip + Sign Out) visible in the footer`,
         m.menu && m.menu.display === 'none' && m.side.w === 220 && inView(m.chip, m.vw, m.vh) && inView(m.signout, m.vw, m.vh), { menu: m.menu, side: m.side, chip: m.chip, signout: m.signout });
      const settle = (x) => p.waitForFunction((x) => Math.round(document.getElementById('aosSidebar').getBoundingClientRect().width) === x, x, { timeout: 4000 }).catch(() => {});
      await p.click('#aosSidebarToggle'); await settle(66);
      const c = await p.evaluate(() => ({ side: Math.round(document.getElementById('aosSidebar').getBoundingClientRect().width), main: Math.round(document.querySelector('.aos-main').getBoundingClientRect().left) }));
      await p.click('#aosSidebarToggle'); await settle(220);
      const e = await p.evaluate(() => Math.round(document.getElementById('aosSidebar').getBoundingClientRect().width));
      ok(`${w}: collapse rail 220→66→220 and content follows the rail`, c.side === 66 && c.main === 66 && e === 220, { c, e });
      await p.evaluate(() => document.body.focus());
      const tTog = await tabTo(p, '#aosSidebarToggle'), tNav = await tabTo(p, '#aosNav .nav-item'), tSearch = await tabTo(p, '.aos-header-search input'), tBell = await tabTo(p, '#aosBellBtn');
      ok(`${w}: keyboard reaches toggle → nav → search → bell`, tTog > 0 && tNav > 0 && tSearch > 0 && tBell > 0, { tTog, tNav, tSearch, tBell });
    }
    ok(`${w}: no page errors`, r.errors.length === 0, r.errors);
    await r.ctx.close();
  }

  /* ── NEGATIVE CONTROL: the bell's route is what the check measures ───── */
  console.log('\n  [negative control]');
  const html = fs.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8');
  /* Target the BELL's own attribute. A bare replace of the call text hit the first
     occurrence in the document — the sidebar's Notifications child — and left the
     bell intact, so the control reported the check as vacuous about a bell that
     works. An untargeted replace is not a sabotage. */
  const cut = html.replace(`id="aosBellBtn" type="button" onclick="SokoniAOS.navigate('comms','push')"`,
                           `id="aosBellBtn" type="button" onclick="SokoniAOS.navigate('comms')"`);
  if (cut === html) { console.error('PROBE INVALID — bell sabotage target not found'); await browser.close(); process.exit(2); }
  const n = await openPage(browser, { width: 1440, height: 900, overrides: { '/admin-os.html': cut } });
  if (n.booted) {
    await n.page.click('#aosBellBtn'); await n.page.waitForTimeout(250);
    const s2 = await state(n.page);
    ok('NEGATIVE: a bell that skips the child route no longer reads as #comms/push (B1 is live)', s2.cur[0] !== 'comms/push' && s2.hash !== '#comms/push', s2);
  } else ok('NEGATIVE booted', false);
  await n.ctx.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR — ' + e.message); process.exit(2); });
