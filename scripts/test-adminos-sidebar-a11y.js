#!/usr/bin/env node
/* ================================================================
   SOKONI — AdminOS sidebar: scroll region, drawer, keyboard, aria-current
   scripts/test-adminos-sidebar-a11y.js

   WHAT IT HOLDS. The sidebar has ONE independently scrollable navigation
   region (#aosNav) and the footer stays on screen while that region scrolls.
   On phones: open → drawer + scrim; Escape / the « control / the scrim /
   choosing a section → closed, focus returned to the menu button, and the
   chosen section is still the active AdminOS destination. Keyboard focus
   actually REACHES the controls and is visible when it does. aria-current
   follows SokoniAOS.navigate() — the real router, not a re-implementation.

   Attributes are not asserted cosmetically: every aria/focus claim is paired
   with a behaviour (a Tab that lands, an Enter that navigates, an Escape that
   closes) measured in a real Chromium.

   HERMETIC. The repo is served from disk under a fake host; every other origin
   is aborted; Firebase is the same compat stub the single-navigation suite uses.
   Nothing here can reach production.

   NEGATIVE CONTROLS. Two served-markup sabotages prove the checks can fail:
   the aria-current setter removed from sokoni-aos.js, and the Escape handler
   removed from admin-os.html. Each must turn its check red.

   Run:  node scripts/test-adminos-sidebar-a11y.js
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

/* ONE route per context, so precedence is never assumed. `overrides` maps a
   pathname to the bytes to serve instead of the file on disk. */
async function openPage(browser, { width, height, reducedMotion, hash = '', overrides = {} }) {
  const ctx = await browser.newContext({ viewport: { width, height }, ignoreHTTPSErrors: true,
                                         reducedMotion: reducedMotion || 'no-preference' });
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
  await page.goto('https://' + HOST + '/admin-os.html' + hash, { waitUntil: 'domcontentloaded', timeout: 30000 });
  /* Boot = the router ran: _bootUI() → navigate() marks a section active. */
  try {
    await page.waitForFunction(() => !!(window.SokoniAOS && document.querySelector('#aosSidebar .nav-item.active')), { timeout: 20000 });
  } catch (_) { return { page, ctx, booted: false, errors }; }
  await page.waitForTimeout(400);
  await page.evaluate(() => ['sk-splash', 'sk-offline-bar'].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); }));
  return { page, ctx, booted: true, errors };
}

const isOpen  = (p) => p.evaluate(() => document.getElementById('aosSidebar').classList.contains('open'));
const active  = (p) => p.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.className || document.activeElement.tagName));
const current = (p) => p.evaluate(() => [...document.querySelectorAll('#aosSidebar [aria-current="page"]')].map((n) => n.dataset.section));
const panelShown = (p, s) => p.evaluate((s) => { const e = document.getElementById('panel-' + s); return !!e && e.hidden === false; }, s);

/* Tab until focus lands on `selector` (or give up). Real key presses, so
   :focus-visible is genuine and the tab order is the one a user gets. */
async function tabTo(page, selector, max = 80) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate((sel) => document.activeElement && document.activeElement.matches(sel), selector)) return i + 1;
  }
  return -1;
}
const focusRing = (p) => p.evaluate(() => {
  const el = document.activeElement, cs = getComputedStyle(el);
  return { visible: el.matches(':focus-visible'), style: cs.outlineStyle, width: cs.outlineWidth };
});

(async () => {
  const browser = await chromium.launch();

  /* ── DESKTOP ─────────────────────────────────────────────────────────── */
  console.log('ADMINOS SIDEBAR — SCROLL REGION, DRAWER, KEYBOARD, ARIA-CURRENT\n');
  console.log('  [desktop 1440x600 — short viewport so the list must scroll]');
  let d = await openPage(browser, { width: 1440, height: 600 });
  if (!d.booted) { console.error('BLOCKED — AdminOS did not boot'); await browser.close(); process.exit(2); }
  let p = d.page;

  const region = await p.evaluate(() => {
    const side = document.getElementById('aosSidebar'), nav = document.getElementById('aosNav');
    const foot = document.querySelector('.aos-sidebar-footer');
    const r = (el) => { const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) }; };
    const before = nav.scrollTop; nav.scrollTop = 99999; const after = nav.scrollTop; nav.scrollTop = before;
    return {
      navLabel: nav.getAttribute('aria-label'), navTag: nav.tagName, asideLabel: side.getAttribute('aria-label'),
      navOverflowY: getComputedStyle(nav).overflowY, navScrolls: nav.scrollHeight > nav.clientHeight + 4, navScrolledTo: after,
      sideSelfScrolls: side.scrollHeight > side.clientHeight + 1, sideOverflow: getComputedStyle(side).overflowY,
      foot: r(foot), vh: window.innerHeight, itemsInNav: nav.querySelectorAll('.nav-item').length,
      itemsInSidebar: side.querySelectorAll('.nav-item').length,
    };
  });
  ok('D1  the navigation is a <nav aria-label="AdminOS navigation"> inside a labelled <aside>',
     region.navTag === 'NAV' && region.navLabel === 'AdminOS navigation' && !!region.asideLabel, region);
  ok('D2  the <nav> is the ONE scrolling region (overflow-y:auto, taller than its box, actually scrolls)',
     region.navOverflowY === 'auto' && region.navScrolls && region.navScrolledTo > 0, region);
  ok('D3  the sidebar itself does not scroll (the footer cannot be scrolled away)',
     !region.sideSelfScrolls && region.sideOverflow === 'hidden', region);
  ok('D4  the footer (Sign Out) is inside the viewport while the list overflows',
     region.foot.top >= 0 && region.foot.bottom <= region.vh, region);
  ok(`D5  every nav item (${region.itemsInSidebar}) lives inside the scrolling <nav>`, region.itemsInNav === region.itemsInSidebar && region.itemsInNav >= 36, region);

  /* keyboard reaches the controls, and focus is visible when it does */
  await p.evaluate(() => document.body.focus());
  const tabsToToggle = await tabTo(p, '#aosSidebarToggle');
  const ringT = await focusRing(p);
  ok('D6  Tab reaches the collapse control, with a visible focus ring',
     tabsToToggle > 0 && ringT.visible && ringT.style !== 'none' && parseFloat(ringT.width) >= 1, { tabsToToggle, ringT });
  const tabsToUsers = await tabTo(p, '#aosSidebar .nav-item[data-section="users"]');
  const ringU = await focusRing(p);
  ok('D7  Tab reaches a section item, with a visible focus ring',
     tabsToUsers > 0 && ringU.visible && ringU.style !== 'none' && parseFloat(ringU.width) >= 1, { tabsToUsers, ringU });
  await p.keyboard.press('Enter'); await p.waitForTimeout(250);
  ok('D8  Enter on the focused item opens that section through the router',
     (await panelShown(p, 'users')) && !(await panelShown(p, 'dashboard')));
  ok('D9  aria-current="page" moved to it, and to it ONLY', JSON.stringify(await current(p)) === '["users"]', await current(p));

  /* programmatic navigate() — the same authority every sidebar child will use */
  await p.evaluate(() => { try { SokoniAOS.navigate('security'); } catch (_) {} });
  await p.waitForTimeout(250);
  const sec = await p.evaluate(() => {
    const nav = document.getElementById('aosNav'), it = nav.querySelector('.nav-item[data-section="security"]');
    const n = nav.getBoundingClientRect(), i = it.getBoundingClientRect();
    return { current: it.getAttribute('aria-current'), active: it.classList.contains('active'),
             inView: i.top >= n.top - 1 && i.bottom <= n.bottom + 1, navScrollTop: Math.round(nav.scrollTop) };
  });
  ok('D10 SokoniAOS.navigate("security") sets aria-current + .active together', sec.current === 'page' && sec.active, sec);
  ok('D11 exactly one aria-current after navigate()', JSON.stringify(await current(p)) === '["security"]', await current(p));
  ok('D12 the newly active item is scrolled into view inside the <nav>', sec.inView && sec.navScrollTop > 0, sec);

  /* collapsed rail */
  /* Wait for the width TRANSITION to settle rather than a fixed sleep: under load a
     0.2s transition can still be mid-flight at 350ms and report the old width. */
  const settle = (w) => p.waitForFunction((w) => Math.round(document.getElementById('aosSidebar').getBoundingClientRect().width) === w, w, { timeout: 4000 }).catch(() => {});
  await p.click('#aosSidebarToggle'); await settle(66);
  const rail = await p.evaluate(() => {
    const t = document.getElementById('aosSidebarToggle'), it = document.querySelector('.nav-item[data-section="users"]');
    const lbl = it.querySelector('.nav-label');
    return { w: Math.round(document.getElementById('aosSidebar').getBoundingClientRect().width), expanded: t.getAttribute('aria-expanded'),
             label: t.getAttribute('aria-label'), lblW: Math.round(lbl.getBoundingClientRect().width), lblOpacity: getComputedStyle(lbl).opacity,
             title: it.title, iconFont: getComputedStyle(it.querySelector('.nav-icon')).fontSize };
  });
  ok('D13 collapse → 66px rail, aria-expanded="false", "Expand menu"', rail.w === 66 && rail.expanded === 'false' && rail.label === 'Expand menu', rail);
  ok('D14 collapsed labels are hidden without font-size:0, and the item carries its name as a title',
     rail.lblW === 0 && rail.lblOpacity === '0' && rail.title === 'User Management' && rail.iconFont !== '0px', rail);
  await p.click('#aosSidebarToggle'); await settle(220);
  const back = await p.evaluate(() => ({ w: Math.round(document.getElementById('aosSidebar').getBoundingClientRect().width),
    expanded: document.getElementById('aosSidebarToggle').getAttribute('aria-expanded'), title: document.querySelector('.nav-item[data-section="users"]').hasAttribute('title') }));
  ok('D15 expand → 220px, aria-expanded="true", titles removed', back.w === 220 && back.expanded === 'true' && !back.title, back);
  ok('D16 no page errors on desktop', d.errors.length === 0, d.errors);
  await d.ctx.close();

  /* deep link lands on the section AND the item is in view */
  const dl = await openPage(browser, { width: 1440, height: 600, hash: '#security' });
  if (dl.booted) {
    const v = await dl.page.evaluate(() => {
      const nav = document.getElementById('aosNav'), it = nav.querySelector('[aria-current="page"]');
      if (!it) return { none: true };
      const n = nav.getBoundingClientRect(), i = it.getBoundingClientRect();
      return { section: it.dataset.section, inView: i.top >= n.top - 1 && i.bottom <= n.bottom + 1 };
    });
    ok('D17 deep link #security: aria-current on Security and the item visible in the scroll region', v.section === 'security' && v.inView, v);
  } else ok('D17 deep link #security booted', false, 'did not boot');
  await dl.ctx.close();

  /* reduced motion */
  const rm = await openPage(browser, { width: 1440, height: 900, reducedMotion: 'reduce' });
  /* ≤ 0.01s, not === 0s: the platform's shared stylesheets honour the preference
     with `transition-duration:0.001ms !important` on `*`, which is an honest
     "no motion". What must NOT survive is sokoni-polish.css's `button:not(…)×4
     … 0.13s !important`, which out-specifies that reset on every button. */
  const durations = rm.booted ? await rm.page.evaluate(() => ['#aosSidebar', '.aos-main', '#aosSidebarToggle', '.nav-label', '#aosNav .nav-item', '.signout-btn']
      .map((s) => getComputedStyle(document.querySelector(s)).transitionDuration)) : null;
  const still = (x) => x.split(',').every((t) => parseFloat(t) <= 0.01);
  ok('D18 prefers-reduced-motion: sidebar, main, toggle, labels, items and sign-out do not animate (≤0.01s)',
     !!durations && durations.every(still), durations);
  const rmOff = await openPage(browser, { width: 1440, height: 900 });
  const durOn = rmOff.booted ? await rmOff.page.evaluate(() => getComputedStyle(document.getElementById('aosSidebar')).transitionDuration) : null;
  ok('D19 (control) without the preference the sidebar DOES animate', !!durOn && durOn !== '0s', durOn);
  await rm.ctx.close(); await rmOff.ctx.close();

  /* ── MOBILE ──────────────────────────────────────────────────────────── */
  console.log('\n  [mobile 390x844]');
  const m = await openPage(browser, { width: 390, height: 844 });
  if (!m.booted) { console.error('BLOCKED — AdminOS did not boot on mobile'); await browser.close(); process.exit(2); }
  p = m.page;
  const closed0 = await p.evaluate(() => ({ left: Math.round(document.getElementById('aosSidebar').getBoundingClientRect().left),
    expanded: document.getElementById('aosMenuBtn').getAttribute('aria-expanded'), controls: document.getElementById('aosMenuBtn').getAttribute('aria-controls'),
    scrim: getComputedStyle(document.getElementById('aosScrim')).display }));
  ok('M1  drawer starts closed; menu button has aria-controls + aria-expanded="false"',
     closed0.left < 0 && closed0.expanded === 'false' && closed0.controls === 'aosSidebar' && closed0.scrim === 'none', closed0);

  await p.click('#aosMenuBtn'); await p.waitForTimeout(350);
  const open1 = await p.evaluate(() => ({ left: Math.round(document.getElementById('aosSidebar').getBoundingClientRect().left),
    w: Math.round(document.getElementById('aosSidebar').getBoundingClientRect().width),
    expanded: document.getElementById('aosMenuBtn').getAttribute('aria-expanded'), scrim: getComputedStyle(document.getElementById('aosScrim')).display,
    focusInside: !!document.activeElement && !!document.activeElement.closest('#aosSidebar'), toggleLabel: document.getElementById('aosSidebarToggle').getAttribute('aria-label') }));
  ok('M2  open → drawer at x=0 (220px) + scrim, aria-expanded="true", focus moved INTO the drawer',
     open1.left === 0 && open1.w === 220 && open1.expanded === 'true' && open1.scrim !== 'none' && open1.focusInside, open1);
  ok('M3  the « control reads "Close menu" on phones', open1.toggleLabel === 'Close menu', open1.toggleLabel);
  /* The brand must survive the phone drawer. sokoni-responsive.css's ≤768px
     `[class*="-sidebar"]{width:100%!important}` once matched the toggle too,
     growing it to 187px and squeezing "SOKONI AOS" to 0px. */
  const brand = await p.evaluate(() => ({ titleW: Math.round(document.querySelector('.logo-text').getBoundingClientRect().width),
    toggleW: Math.round(document.getElementById('aosSidebarToggle').getBoundingClientRect().width),
    logoShown: document.querySelector('.aos-logo img').getBoundingClientRect().width > 0 }));
  ok('M3b the open drawer shows the SOKONI logo and "SOKONI AOS"; the « control is a control, not a bar',
     brand.logoShown && brand.titleW > 40 && brand.toggleW <= 60, brand);

  await p.keyboard.press('Escape'); await p.waitForTimeout(350);
  ok('M4  Escape closes the drawer and returns focus to the menu button',
     !(await isOpen(p)) && (await active(p)) === 'aosMenuBtn', { open: await isOpen(p), focus: await active(p) });

  await p.click('#aosMenuBtn'); await p.waitForTimeout(350);
  await p.click('#aosSidebarToggle'); await p.waitForTimeout(350);
  ok('M5  the « close control closes the drawer', !(await isOpen(p)) && (await active(p)) === 'aosMenuBtn');

  await p.click('#aosMenuBtn'); await p.waitForTimeout(350);
  await p.mouse.click(380, 420); await p.waitForTimeout(350);
  ok('M6  tapping the scrim closes the drawer', !(await isOpen(p)));

  /* keyboard inside the drawer: Tab to a section, Enter → closes AND navigates */
  await p.click('#aosMenuBtn'); await p.waitForTimeout(350);
  const tabsM = await tabTo(p, '#aosSidebar .nav-item[data-section="payments"]');
  const ringM = await focusRing(p);
  ok('M7  Tab inside the open drawer reaches a section item with a visible ring', tabsM > 0 && ringM.visible && ringM.style !== 'none', { tabsM, ringM });
  await p.keyboard.press('Enter'); await p.waitForTimeout(350);
  ok('M8  Enter → drawer closed, focus back on the menu button',
     !(await isOpen(p)) && (await active(p)) === 'aosMenuBtn', { open: await isOpen(p), focus: await active(p) });
  ok('M9  …and Payments is the active AdminOS destination (panel shown, aria-current)',
     (await panelShown(p, 'payments')) && JSON.stringify(await current(p)) === '["payments"]', await current(p));

  const mRegion = await p.evaluate(() => { const nav = document.getElementById('aosNav'), f = document.querySelector('.aos-sidebar-footer').getBoundingClientRect();
    return { navScrolls: nav.scrollHeight > nav.clientHeight + 4, footBottom: Math.round(f.bottom), vh: window.innerHeight }; });
  ok('M10 on the phone too, the <nav> scrolls and the footer stays on screen', mRegion.navScrolls && mRegion.footBottom <= mRegion.vh, mRegion);
  ok('M11 no horizontal page overflow', (await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) === 0);
  ok('M12 no page errors on mobile', m.errors.length === 0, m.errors);
  await m.ctx.close();

  /* ── NEGATIVE CONTROLS ───────────────────────────────────────────────── */
  console.log('\n  [negative controls: served-markup sabotage]');
  const aos = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8');
  const aosNoAria = aos.replace('nav.setAttribute("aria-current", "page");', '');
  const html = fs.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8');
  const htmlNoEsc = html.replace("if (e.key === 'Escape' &&", "if (false &&");
  if (aosNoAria === aos || htmlNoEsc === html) {
    console.error('PROBE INVALID — a sabotage target was not found; the negative controls would prove nothing.');
    await browser.close(); process.exit(2);
  }
  const n1 = await openPage(browser, { width: 1440, height: 900, overrides: { '/sokoni-aos.js': aosNoAria } });
  if (n1.booted) {
    await n1.page.evaluate(() => { try { SokoniAOS.navigate('users'); } catch (_) {} });
    ok('NEGATIVE 1: without the setter in navigate(), aria-current is absent (the D9/D11 checks are live)',
       (await current(n1.page)).length === 0, await current(n1.page));
  } else ok('NEGATIVE 1 booted', false, 'did not boot');
  await n1.ctx.close();
  const n2 = await openPage(browser, { width: 390, height: 844, overrides: { '/admin-os.html': htmlNoEsc } });
  if (n2.booted) {
    await n2.page.click('#aosMenuBtn'); await n2.page.waitForTimeout(300);
    await n2.page.keyboard.press('Escape'); await n2.page.waitForTimeout(300);
    ok('NEGATIVE 2: without the Escape handler the drawer stays open (the M4 check is live)', await isOpen(n2.page));
  } else ok('NEGATIVE 2 booted', false, 'did not boot');
  await n2.ctx.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR — ' + e.message); process.exit(2); });
