#!/usr/bin/env node
/* ================================================================
   SOKONI — AdminOS single-navigation invariant
   scripts/test-adminos-single-navigation.js

   THE HARD REQUIREMENT: one sidebar, no global admin header, no bottom admin
   nav, no iframe of admin.html, no admin.html runtime dependency — on desktop
   AND on mobile.

   WHAT WAS WRONG. sokoni-admin-shell.js renders a registry sidebar and a global
   header on every REGISTERED admin surface and had no page-level opt-out.
   admin-os.html is the registry HOME, so it got both — on top of its own
   #aosSidebar and .aos-header. Three global navigation trees, measured at
   220x900, 244x900 and 1196x65.

   HOW IT IS FIXED, AND WHY NOT WITH CSS. The shell now returns early when the
   page declares data-admin-shell="own", before injecting CSS or creating any
   element. A CSS override could not have worked honestly anyway: the shell
   already defeats page-level header/nav suppression with display:...!important,
   so hiding it would have meant a fourth layer of specificity rather than a
   fix. Nothing renders because nothing is asked to.

   THE TEST THAT MATTERS. Asserting "one sidebar" on the fixed page proves
   little on its own — it would also pass if the shell had been deleted, or if
   the selectors had gone stale. So this suite ALSO proves the shell still
   renders for other admin pages, and that the opt-out is what does the work.

   Run:  node scripts/test-adminos-single-navigation.js
   Exit: 0 all passed · 1 a test failed · 2 the harness could not run
   ================================================================ */
'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const HOST = 'sokoni-cert.test';
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const shared = require(path.join(__dirname, 'lib', 'adminos-probe-lib.js'));

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  PASS  ' + n); }
                          else { fail++; console.log('  FAIL  ' + n + (d ? '  -> ' + d : '')); } };

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile',  width: 390,  height: 844 },
];

/* Runs in the page. Counts what actually RENDERS, not what exists in markup:
   a hidden element is not a navigation tree, and an element with zero area is
   not one either. */
function measureChrome() {
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { w: Math.round(r.width), h: Math.round(r.height),
             rendered: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' };
  };
  const shellSide = document.getElementById('sk-adm-side');
  return {
    aosSidebar:   box(document.getElementById('aosSidebar')),
    aosHeader:    box(document.querySelector('header.aos-header')),
    shellSidebar: box(shellSide),
    shellHeader:  box(document.getElementById('sk-adm-header')),
    shellCrumbs:  box(document.getElementById('sk-adm-crumbs')),
    shellCssTag:  !!document.getElementById('sk-adm-css'),
    bottomNav:    box(document.querySelector('.bottom-nav, #bottomNav, nav.sk-bottom, .mob-7nav')),
    iframes:      [...document.querySelectorAll('iframe')].map((f) => f.getAttribute('src') || ''),
    /* Exact filename, not a substring. [href*="admin.html"] also matches
       super-admin.html, which is a different and legitimate page — the first
       version of this check reported it as an admin.html dependency. */
    adminHtmlLinks: [...document.querySelectorAll('a[href]')]
      .map((a) => a.getAttribute('href') || '')
      .filter((h) => /(^|\/)admin\.html(\?|#|$)/.test(h)),
    navSections:  document.querySelectorAll('#aosSidebar .nav-item[data-section]').length,
    navExternal:  document.querySelectorAll('#aosSidebar a.nav-item[href]').length,
    htmlWorkspace: document.documentElement.getAttribute('data-sokoni-workspace'),
  };
}

(async () => {
  const browser = await chromium.launch();
  const results = {};

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, ignoreHTTPSErrors: true });
    await ctx.addInitScript(shared.compatInit);
    await shared.serveFromDisk(ctx, ROOT, HOST);
    await ctx.route('**/firebasejs/**', (r) =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: shared.gstaticStub(r.request().url()) }));
    await ctx.route('**/firebase.js', (r) =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: shared.instrumentedModule(ROOT) }));
    const page = await ctx.newPage();
    await page.goto('https://' + HOST + '/admin-os.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    try {
      await page.waitForFunction(() => { const p = document.getElementById('panel-dashboard'); return p && p.hidden === false; },
        { timeout: 20000 });
    } catch (_) { console.error('BLOCKED — AdminOS did not boot at ' + vp.name); await browser.close(); process.exit(2); }
    await page.waitForTimeout(600);
    results[vp.name] = await page.evaluate(measureChrome);
    await ctx.close();
  }

  console.log('ADMINOS SINGLE-NAVIGATION INVARIANT\n');

  for (const vp of VIEWPORTS) {
    const c = results[vp.name];
    console.log('  [' + vp.name + ' ' + vp.width + 'x' + vp.height + ']');
    ok(vp.name + ': AdminOS sidebar renders', c.aosSidebar && c.aosSidebar.rendered,
       JSON.stringify(c.aosSidebar));
    ok(vp.name + ': NO shell sidebar renders', !(c.shellSidebar && c.shellSidebar.rendered),
       JSON.stringify(c.shellSidebar));
    ok(vp.name + ': NO global admin header renders', !(c.shellHeader && c.shellHeader.rendered),
       JSON.stringify(c.shellHeader));
    ok(vp.name + ': NO shell breadcrumb bar renders', !(c.shellCrumbs && c.shellCrumbs.rendered),
       JSON.stringify(c.shellCrumbs));
    ok(vp.name + ': the shell injected NOTHING (not merely hidden)', c.shellCssTag === false,
       'sk-adm-css present=' + c.shellCssTag);
    ok(vp.name + ': NO bottom admin navigation', !(c.bottomNav && c.bottomNav.rendered),
       JSON.stringify(c.bottomNav));
    ok(vp.name + ': NO iframe of admin.html',
       c.iframes.filter((s) => /admin\.html/i.test(s)).length === 0, JSON.stringify(c.iframes));
    ok(vp.name + ': NO link to admin.html in the AdminOS DOM',
       c.adminHtmlLinks.length === 0, JSON.stringify(c.adminHtmlLinks));
    ok(vp.name + ': the <html> admin workspace stamp survives the opt-out',
       c.htmlWorkspace === 'admin', 'stamp=' + JSON.stringify(c.htmlWorkspace));
    console.log('');
  }

  /* Canonical counts, reported rather than assumed. */
  const d = results.desktop;
  console.log('  CANONICAL SIDEBAR COUNT');
  console.log('    in-workspace sections : ' + d.navSections);
  console.log('    external child links  : ' + d.navExternal);
  console.log('    total nav items       : ' + (d.navSections + d.navExternal) + '\n');
  ok('exactly ONE sidebar element renders in total',
     [d.aosSidebar, d.shellSidebar].filter((x) => x && x.rendered).length === 1);
  ok('AdminOS keeps its own header (a workspace header is not a global nav tree)',
     d.aosHeader && d.aosHeader.rendered, JSON.stringify(d.aosHeader));

  /* ── NEGATIVE CONTROL 1 ──────────────────────────────────────────────────
     The shell must STILL render for a page that has not opted out. Without
     this, deleting the shell entirely would pass every assertion above. */
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  await ctx2.addInitScript(shared.compatInit);
  await shared.serveFromDisk(ctx2, ROOT, HOST);
  await ctx2.route('**/firebasejs/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: shared.gstaticStub(r.request().url()) }));
  await ctx2.route('**/firebase.js', (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: shared.instrumentedModule(ROOT) }));
  const p2 = await ctx2.newPage();
  await p2.goto('https://' + HOST + '/monitor.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p2.waitForTimeout(1500);
  const other = await p2.evaluate(measureChrome);
  console.log('\n  [negative control: monitor.html, which has NOT opted out]');
  ok('NEGATIVE: the shell still renders for other admin pages',
     (other.shellSidebar && other.shellSidebar.rendered) || (other.shellHeader && other.shellHeader.rendered),
     'sidebar=' + JSON.stringify(other.shellSidebar) + ' header=' + JSON.stringify(other.shellHeader));
  await ctx2.close();

  /* ── NEGATIVE CONTROL 2 ──────────────────────────────────────────────────
     Remove the opt-out attribute before the shell runs; the duplicates MUST
     come back. This proves the attribute is what does the work, rather than
     the shell having silently stopped functioning. */
  const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  await ctx3.addInitScript(shared.compatInit);
  /* Strip the attribute from the SERVED MARKUP, not at runtime. An init-script
     removal plus a MutationObserver was tried first and failed: the shell runs
     synchronously while <head> is parsed, and a MutationObserver callback is a
     microtask that had not fired yet, so the attribute was still present when
     the shell read it. That made the control report "the attribute does nothing"
     about a fix that works — a probe defect, not a product one. Editing the
     bytes the browser receives removes the timing question entirely. */
  const fs3 = require('fs');
  /* declared before use by the single route below */
  const original = fs3.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8');
  /* Target the <html> TAG, not the first textual occurrence. A plain
     .replace(' data-admin-shell="own"', '') removed the mention inside the
     explanatory HTML COMMENT that sits above the tag, left the real attribute
     in place, and the control then reported that the attribute does nothing --
     about a fix that works. An untargeted replace is not a sabotage. */
  const stripped = original.replace(/(<html\b[^>]*?)\s+data-admin-shell="own"/, '$1');
  if (stripped === original) {
    console.error('PROBE INVALID — the opt-out attribute was not found on the <html> tag, so the');
    console.error('                negative control would prove nothing.');
    await browser.close(); process.exit(2);
  }
  /* ONE route, so precedence is not something to be assumed. Relying on
     Playwright's ordering was tried and the control silently tested the
     unmodified page. */
  const MIME3 = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
                  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
  await ctx3.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== HOST) return route.abort();
    if (url.pathname === '/admin-os.html') {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: stripped });
    }
    if (/\/firebase\.js$/.test(url.pathname)) {
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: shared.instrumentedModule(ROOT) });
    }
    if (/firebasejs/.test(url.pathname)) {
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: shared.gstaticStub(url.pathname) });
    }
    const file = path.join(ROOT, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    if (!file.startsWith(ROOT)) return route.fulfill({ status: 403, body: '' });
    let buf;
    try { buf = fs3.readFileSync(file); } catch (_) { return route.fulfill({ status: 404, body: '404' }); }
    return route.fulfill({ status: 200, contentType: MIME3[path.extname(file).toLowerCase()] || 'application/octet-stream', body: buf });
  });
  await ctx3.route('**/firebasejs/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: shared.gstaticStub(r.request().url()) }));
  await ctx3.route('**/firebase.js', (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: shared.instrumentedModule(ROOT) }));
  const p3 = await ctx3.newPage();
  await p3.goto('https://' + HOST + '/admin-os.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p3.waitForTimeout(1500);
  const sabotaged = await p3.evaluate(measureChrome);
  console.log('\n  [negative control: opt-out stripped at runtime]');
  ok('NEGATIVE: removing the opt-out brings the duplicate chrome back',
     (sabotaged.shellSidebar && sabotaged.shellSidebar.rendered) ||
     (sabotaged.shellHeader && sabotaged.shellHeader.rendered),
     'the attribute is not what suppresses the shell — the test would be vacuous');
  await ctx3.close();

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR — ' + e.message); process.exit(2); });
