'use strict';
/* ============================================================================
   Admin layout certification — admin-os.html + super-admin.html on phone,
   tablet and desktop.
   ----------------------------------------------------------------------------
   Run:   node scripts/test-admin-layouts.js            (hermetic; no network)
          node scripts/test-admin-layouts.js --shots    (also writes PNGs)

   WHAT IS REAL: every HTML/CSS/JS file the two consoles load, served from THIS
   worktree over a local static server. The real sokoni-admin-guard.js,
   sokoni-admin-entry.js, sokoni-permissions.js and sokoni-role-authority.js run
   and admit the fixture identity through their own gates.

   WHAT IS STUBBED: /firebase.js only, by scripts/lib/adminos-probe-lib.js — a
   compat shim whose auth() answers with a fixture admin (claims {admin:true,
   superAdmin:true}), whose firestore() answers every read ASYNCHRONOUSLY with
   an EMPTY snapshot, and whose callables resolve {data:{}}. Every non-local
   origin is aborted. Nothing this file proves is authorization: rules and
   callables are the boundary and are untouched here. This certifies RENDERING.

   CHECKS per page x width (390 / 768 / 1280, height 800):
     land       the page did not redirect and its auth gate cleared
     overflow   max(html.scrollWidth, body.scrollWidth) <= innerWidth
     wide       no visible element extends past the viewport's right edge,
                except inside an overflow-x:auto/scroll wrapper; LEAF offenders
                are listed by selector (an ancestor is wide because a child is)
     tables     every visible table fits, OR sits in a horizontally scrollable
                wrapper, OR is in the <=768 card layout (display:block rows)
     one-nav    the sidebar's destinations live in one <nav> element
     nav        phone: a visible menu toggle >= 44px, or a visible nav;
                tablet/desktop: nav visible with items
     content    the main content box is visible and NOT overlapped by the sidebar
     drawer     phone: the toggle opens the drawer inside the viewport, nav
                items are >= 40px tall, the page still fits, closing it parks
                the drawer off-canvas again (waits for the transition to settle)
     panels     every nav section is visited and re-checked for overflow / wide
     negative   a 1400px flex:none div injected at 390px MUST fail both the
                overflow and the wide check (proves the detectors can fail)
     errors     no uncaught page errors

   MEASURED BASELINE — 2026-09-30, commit 85d74af, BEFORE any product change
   (two harness runs: the first exposed two harness defects, fixed before the
   second; the product numbers below are from the second run, 55 pass / 5 fail):
     admin-os.html
       390   dashboard fits; panels(21) FAIL — users: scrollWidth 405 (the
             toolbar's 200px search floor + two selects); marketplace 398;
             comms 435 (h2 / .tab-bar / .compose-form right=411, the header
             profile caret at 400); content 405; search 405. The whole
             .aos-main column grew with its widest panel (flex min-width:auto).
       768   PASS (11/11)     1280  PASS (7/7)
     super-admin.html
       390   overflow FAIL scrollWidth 417 (title + email + Sign Out + the
             mounted profile button held .sa-topbar at 417px); wide FAIL:
             button#sk-admin-profile right=393, h2 / p / #saKpiUsers /
             #saKpiOrders right=401; drawer-fits FAIL 417; panels(9) FAIL on
             all nine sections (same 417px column).
       768   PASS (11/11)     1280  PASS (7/7)
     Harness defects found by the negative control on the first run: the
     injected 1400px div was a flex item of body{display:flex} and shrank to
     374px (fixed: flex:none), and the drawer read mid-transition at a fixed
     350ms wait (fixed: settle on geometry). A control that cannot fail proves
     nothing; both are now live checks.
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const shared = require(path.join(__dirname, 'lib', 'adminos-probe-lib.js'));
const ROOT = shared.ROOT;
const { chromium } = shared.playwright();

const WIDTHS = [390, 768, 1280];
const HEIGHT = 800;
const SHOTS = process.argv.includes('--shots');
const SHOT_DIR = process.env.SK_SHOT_DIR || path.join(ROOT, 'docs', 'evidence', 'admin-layouts-2026-09-30');

const PAGES = [
  { file: 'admin-os.html', ctx: 'admin', sidebar: '#aosSidebar', main: '.aos-main', toggle: '#aosMenuBtn', nav: '#aosNav',
    landed: () => { const n = document.getElementById('aosUserName'); return !!n && !/loading/i.test(n.textContent || ''); },
    navFn: (s) => window.SokoniAOS && window.SokoniAOS.navigate(s),
    openFn: () => window._openSidebar(), closeFn: () => window._closeSidebar() },
  { file: 'super-admin.html', ctx: 'superAdmin', sidebar: '#saSidebar', main: '.sa-main', toggle: '#mobileMenuBtn', nav: '#saNav',
    landed: () => { const g = document.getElementById('authGate'); return !!g && getComputedStyle(g).display === 'none'; },
    navFn: (s) => window.SA && window.SA.nav(s),
    openFn: () => window._openSidebar(), closeFn: () => window._closeSidebar() },
];

/* ── In-page measurement ──────────────────────────────────────────────────── */
const MEASURE = (sel) => {
  const W = window.innerWidth;
  const vis = (el) => { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const label = (el) => { let s = el.tagName.toLowerCase(); if (el.id) s += '#' + el.id; else if (el.className && typeof el.className === 'string') s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.'); return s; };
  const inScroller = (el) => { for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if ((o === 'auto' || o === 'scroll') && a.clientWidth <= W + 1) return true; } return false; };
  const out = { W, scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), wide: [], tables: [], path: location.pathname };
  const wideEls = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right <= 0) continue;                                   /* off-canvas drawer */
    if (getComputedStyle(el).position === 'fixed' && r.left >= W) continue;
    if (r.right > W + 1 && !inScroller(el)) wideEls.add(el);
  }
  /* report LEAF offenders only: an ancestor is wide because a descendant is */
  for (const el of wideEls) { if (![...el.children].some((c) => wideEls.has(c))) out.wide.push(label(el) + ' right=' + Math.round(el.getBoundingClientRect().right)); }
  for (const t of document.querySelectorAll('table')) {
    if (!vis(t)) continue;
    const tr = t.querySelector('tbody tr');
    const card = tr && getComputedStyle(tr).display === 'block';
    const r = t.getBoundingClientRect();
    const fits = r.right <= W + 1 && r.left >= -1;
    if (!fits && !card && !inScroller(t)) out.tables.push(label(t) + ' width=' + Math.round(r.width));
  }
  const sb = document.querySelector(sel.sidebar), mn = document.querySelector(sel.main), tg = document.querySelector(sel.toggle);
  const rect = (el) => { if (!el || !vis(el)) return null; const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
  out.sidebar = rect(sb); out.main = rect(mn); out.toggle = rect(tg);
  out.sidebarOnScreen = !!(out.sidebar && out.sidebar.r > 0 && out.sidebar.l < W);
  out.navItems = [...document.querySelectorAll(sel.sidebar + ' .nav-item')].filter(vis).map((n) => n.getBoundingClientRect().height);
  out.navTag = (document.querySelector(sel.nav) || {}).tagName || null;
  return out;
};

const settle = async (page, sel) => { let last = ''; for (let i = 0; i < 20; i++) { await page.waitForTimeout(120); const cur = await page.evaluate((s) => { const e = document.querySelector(s); return e ? JSON.stringify(e.getBoundingClientRect()) : ''; }, sel); if (cur === last) return; last = cur; } };
const overlap = (a, b) => !!(a && b && a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1);

(async () => {
  const srv = await shared.startServer(ROOT);
  const origin = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch();
  let pass = 0, fail = 0;
  const failures = [];
  const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  PASS ' + name); } else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); } };
  if (SHOTS) fs.mkdirSync(SHOT_DIR, { recursive: true });

  for (const P of PAGES) {
    for (const W of WIDTHS) {
      const phone = W <= 768;
      const tag = P.file + '@' + W;
      const SEL = { sidebar: P.sidebar, main: P.main, toggle: P.toggle, nav: P.nav };
      console.log('\n' + tag);
      const ctx = await browser.newContext({ viewport: { width: W, height: HEIGHT }, isMobile: W < 768, hasTouch: W < 768, deviceScaleFactor: 1 });
      await ctx.route('**/*', (route) => {
        const u = route.request().url();
        if (!u.startsWith(origin)) return route.abort();
        if (/\/firebase\.js(\?|$)/.test(u)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: shared.firebaseStub() });
        return route.continue();
      });
      await ctx.addInitScript(shared.compatInit, P.ctx);
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e.message || e)));
      await page.goto(origin + '/' + P.file, { waitUntil: 'load' });
      let landed = false;
      try { await page.waitForFunction(P.landed, null, { timeout: 12000 }); landed = true; } catch (_) {}
      const here = new URL(page.url()).pathname.split('/').pop();
      ok(tag + ' land', landed && here === P.file, 'url=' + here + ' landed=' + landed + (errors.length ? ' errors=' + errors.slice(0, 2).join(' | ') : ''));
      await page.waitForTimeout(400);

      const m = await page.evaluate(MEASURE, SEL);
      ok(tag + ' overflow', m.scrollWidth <= m.W, 'scrollWidth ' + m.scrollWidth + ' > ' + m.W);
      ok(tag + ' wide', m.wide.length === 0, m.wide.slice(0, 6).join(', '));
      ok(tag + ' tables', m.tables.length === 0, m.tables.join(', '));
      ok(tag + ' one-nav', m.navTag === 'NAV', 'nav element=' + m.navTag);
      if (phone) {
        ok(tag + ' nav', (m.toggle && m.toggle.w >= 44 && m.toggle.h >= 44) || m.sidebarOnScreen, 'toggle=' + JSON.stringify(m.toggle) + ' sidebarOnScreen=' + m.sidebarOnScreen);
        ok(tag + ' content', !!m.main && !(m.sidebarOnScreen && overlap(m.sidebar, m.main)), 'main=' + JSON.stringify(m.main) + ' sidebar=' + JSON.stringify(m.sidebar));
        await page.evaluate(P.openFn); await settle(page, P.sidebar);
        const o = await page.evaluate(MEASURE, SEL);
        const minNav = o.navItems.length ? Math.min(...o.navItems) : 0;
        ok(tag + ' drawer-opens', o.sidebarOnScreen && o.sidebar.l >= -1 && o.sidebar.r <= W + 1, 'sidebar=' + JSON.stringify(o.sidebar));
        ok(tag + ' drawer-tap>=40', o.navItems.length > 0 && minNav >= 40, 'min nav-item height ' + minNav + ' of ' + o.navItems.length);
        ok(tag + ' drawer-fits', o.scrollWidth <= o.W, 'scrollWidth ' + o.scrollWidth);
        if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, P.file.replace('.html', '') + '-' + W + '-drawer.png') });
        await page.evaluate(P.closeFn); await settle(page, P.sidebar);
        const c = await page.evaluate(MEASURE, SEL);
        ok(tag + ' drawer-closes', !c.sidebarOnScreen && !!c.main, 'sidebar=' + JSON.stringify(c.sidebar));
      } else {
        ok(tag + ' nav', m.sidebarOnScreen && m.navItems.length > 0, 'sidebar=' + JSON.stringify(m.sidebar));
        ok(tag + ' content', !!m.main && !overlap(m.sidebar, m.main), 'main=' + JSON.stringify(m.main) + ' sidebar=' + JSON.stringify(m.sidebar));
      }
      if (SHOTS) await page.screenshot({ path: path.join(SHOT_DIR, P.file.replace('.html', '') + '-' + W + '.png'), fullPage: false });

      /* every panel */
      const sections = await page.evaluate((sel) => [...document.querySelectorAll(sel + ' .nav-item[data-section]:not([data-tab])')].map((n) => n.dataset.section), P.sidebar);
      const bad = [];
      for (const s of sections) {
        try { await page.evaluate(P.navFn, s); } catch (e) { bad.push(s + ': nav threw ' + e.message.split('\n')[0]); continue; }
        await page.waitForTimeout(250);
        const r = await page.evaluate(MEASURE, SEL);
        if (r.scrollWidth > r.W) bad.push(s + ': scrollWidth ' + r.scrollWidth);
        if (r.wide.length) bad.push(s + ': ' + r.wide.slice(0, 4).join(', '));
        if (r.tables.length) bad.push(s + ': tables ' + r.tables.join(', '));
        if (SHOTS && phone) await page.screenshot({ path: path.join(SHOT_DIR, P.file.replace('.html', '') + '-' + W + '-' + s + '.png') });
      }
      ok(tag + ' panels(' + sections.length + ')', bad.length === 0, bad.join(' ; '));

      /* negative control at phone width: the detectors must be able to fail */
      if (W === 390) {
        await page.evaluate(() => { const d = document.createElement('div'); d.id = '__neg'; d.style.cssText = 'width:1400px;flex:none;height:10px;background:red'; document.body.appendChild(d); });
        const n = await page.evaluate(MEASURE, SEL);
        ok(tag + ' negative-control', n.scrollWidth > n.W && n.wide.some((x) => x.startsWith('div#__neg')), 'scrollWidth ' + n.scrollWidth + ' wide=' + n.wide.join(','));
        await page.evaluate(() => document.getElementById('__neg').remove());
      }
      ok(tag + ' no-page-errors', errors.length === 0, errors.slice(0, 3).join(' | '));
      await ctx.close();
    }
  }
  await browser.close();
  srv.close();
  console.log('\nadmin-layouts: ' + pass + ' pass / ' + fail + ' fail');
  if (failures.length) console.log(failures.map((f) => '  - ' + f).join('\n'));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
