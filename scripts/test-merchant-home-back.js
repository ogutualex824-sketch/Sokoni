/* Merchant shell — Home, the way out, and a deterministic Back.
 *
 *   node scripts/test-merchant-home-back.js
 *
 * THREE THINGS, all measured against a real click rather than against the handler's source.
 *
 * 1. #mbnav Home reaches Merchant Home from wherever the merchant is.
 *    This was suspected broken and is NOT — it is asserted here so the next person does not
 *    have to re-derive that, and so a future change cannot break it silently.
 *
 * 2. The shell has a way OUT. shared-header.js suppresses the customer header and bottom nav
 *    for everything /merchant hosts (?shell=merchant) — correct, it stops a second application
 *    mounting inside the first. But it left the shell with ZERO links to any external
 *    destination: measured, `document.querySelectorAll('a[href]')` contained nothing pointing
 *    off the shell. A merchant could reach the marketplace only by editing the URL. That is the
 *    dead-end Navigation Contract rule 2 forbids.
 *
 *    The exit must be a real full-page navigation. Mounting index.html as a route panel would
 *    boot the whole customer application inside /merchant — the double-shell defect e0dbdca
 *    fixed — so this asserts the shell is GONE afterwards, not that a panel changed.
 *
 * 3. Back is deterministic. go() replaces on the first navigation, so a merchant arriving
 *    directly on /merchant#shop had one history entry and Back left SOKONI; the same route
 *    reached from inside the shell had a pushed entry and Back returned Home. Identical
 *    screen, opposite behaviour, decided by how they arrived. Both arrivals are tested —
 *    testing only the internal one would have passed against the broken build.
 */
'use strict';
const { webkit } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
  '.png':'image/png', '.json':'application/json', '.svg':'image/svg+xml', '.jpg':'image/jpeg',
  '.webp':'image/webp', '.ico':'image/x-icon', '.woff2':'font/woff2' };

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).replace(/\s+/g, ' ').slice(0, 95) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n── ' + t + ' ──');

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  let f = path.join(ROOT, p);
  if (!path.extname(p)) f += '.html';
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
    res.end(d);
  });
});

const wd = setTimeout(() => { console.log('\n  WATCHDOG — suite exceeded 120s'); process.exit(1); }, 120000);

server.listen(0, async () => {
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const browser = await webkit.launch();

  const session = () => ({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  const seed = (ctx) => ctx.addInitScript(() => {
    try {
      localStorage.setItem('loggedIn', 'true');
      localStorage.setItem('sokoniUser', JSON.stringify({
        uid: 'HOMEBACK_TEST', name: 'Home Back', roles: ['buyer', 'seller', 'merchant'], isSeller: true }));
    } catch (e) {}
  });

  /* The shell mounts asynchronously; wait for the route it claims to be on rather than
     sleeping, so this suite does not drift toward the runner's budget. */
  const routed = (page, id) => page.waitForFunction(
    (id) => location.hash === '#' + id &&
            !!document.querySelector('#mbnav .mbnav-item, .mnav-item'),
    id, { timeout: 15000 }).catch(() => null);

  const state = (page) => page.evaluate(() => ({
    hash: location.hash,
    path: location.pathname,
    title: ((document.getElementById('mtitle') || {}).textContent || '').trim(),
    activeBnav: (() => { const n = document.querySelector('#mbnav .mbnav-item.active'); return n ? n.dataset.id : null; })(),
    nativePanel: !!document.querySelector('.mpanel.show') && !document.querySelector('.mpanel.show iframe'),
  }));

  /* The shell invariants, counted the same way for every route. e0dbdca made /merchant suppress
     the customer header and bottom nav for everything it hosts; a route that reintroduced
     either would mount a second application inside the first, and nothing in the code would
     claim to be doing it. Counted AFTER the route has mounted, never before. */
  const chrome = (page) => page.evaluate(() => ({
    merchantHeader: document.querySelectorAll('.mtop').length,
    merchantNav:    document.querySelectorAll('#mbnav').length,
    customerNav:    document.querySelectorAll('#sk-bottom-nav, .sk-bottom-nav').length,
    customerHeader: document.querySelectorAll('#sk-top-nav').length,
    shells:         document.querySelectorAll('.mshell').length,
    hScroll:        document.documentElement.scrollWidth > window.innerWidth + 2,
    /* A route that mounted nothing is a dead button — the panel is the evidence, not the hash. */
    shownPanels:    document.querySelectorAll('.mpanel.show').length,
  }));

  const assertShell = (label, c) => {
    ck(label + ': exactly 1 merchant header',   c.merchantHeader === 1, String(c.merchantHeader));
    ck(label + ': exactly 1 merchant bottom nav', c.merchantNav === 1,  String(c.merchantNav));
    ck(label + ': 0 customer headers',          c.customerHeader === 0, String(c.customerHeader));
    ck(label + ': 0 customer bottom navs',      c.customerNav === 0,    String(c.customerNav));
    ck(label + ': no duplicate shell',          c.shells === 1,         String(c.shells));
    ck(label + ': no horizontal overflow',      c.hScroll === false,    String(c.hScroll));
    ck(label + ': mounted something (not a dead button)', c.shownPanels >= 1, String(c.shownPanels));
  };

  head('1 · #mbnav Home returns to Merchant Home from another route');
  {
    const ctx = await browser.newContext(session()); await seed(ctx);
    const page = await ctx.newPage();
    await page.goto(BASE + '/merchant.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await routed(page, 'dashboard');
    await page.evaluate(() => { const el = document.querySelector('.mnav-item[data-id="products"]'); if (el) el.click(); });
    await routed(page, 'products');
    const mid = await state(page);
    ck('navigated away from Home first', mid.hash === '#products', mid.hash);

    /* #mbnav Home is the MARKETPLACE, not the merchant dashboard. Clicked, not inspected:
       the href was already correct in earlier builds while the click did something else. */
    await page.evaluate(() => { const el = document.querySelector('#mbnav .mbnav-item[data-id="home"]'); if (el) el.click(); });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2500);
    const st = await page.evaluate(() => ({
      path: location.pathname,
      shellGone: !document.querySelector('.mshell'),
      tmpl: (document.querySelector('meta[name="sokoni-page"]') || {}).content || '',
    }));
    ck('#mbnav Home leaves /merchant', st.path !== '/merchant.html', st.path);
    ck('...landing on index.html (the marketplace home)', st.tmpl === 'marketplace-home', st.tmpl || '(no template meta)');
    ck('...as a real navigation — the merchant shell is gone, not iframed', st.shellGone);

    /* The bounce loop this ordering exists to prevent: if go() had recorded "#home" before
       navigating, Back would return to /merchant#home, the boot router would resolve the exit
       and leave again, and the merchant could never get back into the shell. */
    await page.goBack();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2500);
    const back = await page.evaluate(() => ({
      path: location.pathname, hash: location.hash,
      shell: !!document.querySelector('.mshell'),
    }));
    ck('Back from the marketplace re-enters the shell (no #home bounce loop)',
       back.path === '/merchant.html' && back.shell === true, back.path + back.hash + ' shell=' + back.shell);
    await ctx.close();
  }

  head('1b · Merchant Home (the dashboard) is still reachable and still works');
  {
    const ctx = await browser.newContext(session()); await seed(ctx);
    const page = await ctx.newPage();
    await page.goto(BASE + '/merchant.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await routed(page, 'dashboard');
    await page.evaluate(() => { const el = document.querySelector('.mnav-item[data-id="products"]'); if (el) el.click(); });
    await routed(page, 'products');
    /* Dashboard left the bottom bar but must remain a first-class destination — it is the
       Back target below, so losing it would break section 3 silently. */
    await page.evaluate(() => { const el = document.querySelector('.mnav-item[data-id="dashboard"]'); if (el) el.click(); });
    await routed(page, 'dashboard');
    const st = await state(page);
    ck('sidebar/drawer Dashboard still lands on Merchant Home',
       st.hash === '#dashboard' && st.nativePanel, st.hash + ' native=' + st.nativePanel);
    ck('...with the title agreeing', /dashboard/i.test(st.title), st.title);
    await ctx.close();
  }

  head('2 · the shell is not a dead-end — there is a way to the marketplace');
  {
    const ctx = await browser.newContext(session()); await seed(ctx);
    const page = await ctx.newPage();
    await page.goto(BASE + '/merchant.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await routed(page, 'dashboard');

    const exits = await page.evaluate(() => [...document.querySelectorAll('a[href]')]
      .map((a) => a.getAttribute('href'))
      .filter((h) => h && !/^#/.test(h) && !/^javascript:/i.test(h)));
    ck('at least one link leaves the merchant shell', exits.length > 0, JSON.stringify(exits).slice(0, 80));

    /* cleanUrls:true means /index.html 301-redirects, so the exit must target "/". */
    ck('the exit targets "/" and not index.html (cleanUrls 301s)',
       exits.some((h) => h === '/'), JSON.stringify(exits).slice(0, 80));

    /* On a phone the rail IS the drawer — translated off-screen until .mobile-open — so the
       exit is reached the way a merchant reaches it: More (☰) first. Clicking it blind would
       fail with "element is outside of the viewport", which is the harness telling the truth
       about a control the merchant also could not have tapped. */
    await page.evaluate(() => { const el = document.querySelector('#mbnav .mbnav-item[data-id="__more"]'); if (el) el.click(); });
    await page.waitForTimeout(600);
    ck('the More drawer exposes the exit', await page.isVisible('#mexit'));
    await page.click('#mexit');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2500);
    const after = await page.evaluate(() => ({
      path: location.pathname,
      /* A REAL navigation: the merchant shell must be gone, not hidden behind a panel. */
      shellGone: !document.querySelector('.mshell'),
      tmpl: (document.querySelector('meta[name="sokoni-page"]') || {}).content || '',
    }));
    ck('clicking it actually leaves /merchant', after.path !== '/merchant.html', after.path);
    ck('...and the merchant shell is gone, not iframed inside itself', after.shellGone, 'mshell present=' + !after.shellGone);
    ck('...landing on the marketplace home', after.tmpl === 'marketplace-home', after.tmpl || '(no template meta)');
    await ctx.close();
  }

  head('3 · Back is deterministic — same answer from both arrivals');
  {
    /* (a) reached from inside the shell: this already worked. */
    const ctx = await browser.newContext(session()); await seed(ctx);
    const page = await ctx.newPage();
    await page.goto(BASE + '/merchant.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await routed(page, 'dashboard');
    await page.evaluate(() => { const el = document.querySelector('.mnav-item[data-id="shop"]'); if (el) el.click(); });
    await routed(page, 'shop');
    ck('Home → Shop reached #shop', (await state(page)).hash === '#shop');
    await page.goBack();
    await routed(page, 'dashboard');
    const a = await state(page);
    ck('Back from an INTERNAL route → Merchant Home', a.hash === '#dashboard' && a.path === '/merchant.html', a.path + a.hash);
    await ctx.close();
  }
  {
    /* (b) arrived directly on the deep link — the case that used to leave SOKONI. */
    const ctx = await browser.newContext(session()); await seed(ctx);
    const page = await ctx.newPage();
    await page.goto(BASE + '/merchant.html#shop', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await routed(page, 'shop');
    ck('direct /merchant.html#shop mounted Shop', (await state(page)).hash === '#shop');
    await page.goBack();
    await routed(page, 'dashboard');
    const b = await state(page);
    ck('Back from a DIRECT deep link → Merchant Home (not out of SOKONI)',
       b.path === '/merchant.html' && b.hash === '#dashboard' && b.nativePanel,
       b.path + b.hash + ' native=' + b.nativePanel);

    /* Returning from a route must not leave a SECOND chrome behind. e0dbdca made the shell
       suppress the customer header/nav for embedded pages (?shell=merchant); a Back that
       re-mounted the shell while a module's own chrome survived would reintroduce the
       double-shell without any code claiming to. Counted after the navigation, not before. */
    const chrome = await page.evaluate(() => ({
      merchantHeader: document.querySelectorAll('.mtop').length,
      merchantNav:    document.querySelectorAll('#mbnav').length,
      customerNav:    document.querySelectorAll('#sk-bottom-nav, .sk-bottom-nav').length,
      customerHeader: document.querySelectorAll('#sk-top-nav').length,
      hScroll:        document.documentElement.scrollWidth > window.innerWidth + 2,
    }));
    ck('after Back: merchant header = 1', chrome.merchantHeader === 1, String(chrome.merchantHeader));
    ck('after Back: merchant nav = 1',    chrome.merchantNav === 1,    String(chrome.merchantNav));
    ck('after Back: customer nav = 0',    chrome.customerNav === 0,    String(chrome.customerNav));
    ck('after Back: customer header = 0', chrome.customerHeader === 0, String(chrome.customerHeader));
    ck('after Back: no horizontal overflow', chrome.hScroll === false, String(chrome.hScroll));
    await ctx.close();
  }
  {
    /* Booting on Home itself must NOT gain a phantom entry — Home is the root of the shell,
       and seeding a second one would make Back appear to do nothing. */
    const ctx = await browser.newContext(session()); await seed(ctx);
    const page = await ctx.newPage();
    await page.goto(BASE + '/merchant.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await routed(page, 'dashboard');
    const depth = await page.evaluate(() => history.length);
    await page.goto(BASE + '/merchant.html#dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await routed(page, 'dashboard');
    const depth2 = await page.evaluate(() => history.length);
    ck('booting on Home does not seed a duplicate Home entry', depth2 - depth <= 1, depth + ' → ' + depth2);
    await ctx.close();
  }

  /* ── 4. Acceptance matrix — every primary flow, same invariants ──────────────
     The earlier sections prove specific behaviours (Home, the exit, Back). This proves the
     SHELL PROPERTY holds on every route a merchant actually reaches, which is the thing that
     regresses quietly: one route mounting a second header is invisible until someone opens
     that route on a phone. Sharing one context is deliberate — routes are visited in sequence
     the way a merchant visits them, so a shell that degrades only after navigation is caught. */
  head('4 · acceptance matrix — one shell on every route');
  {
    const ctx = await browser.newContext(session()); await seed(ctx);
    const page = await ctx.newPage();
    await page.goto(BASE + '/merchant.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await routed(page, 'dashboard');
    assertShell('dashboard', await chrome(page));

    /* Reached the way a merchant reaches them: sidebar/drawer for modules, the four-up bar for
       the primary tabs. `minishop` is the KASS Shop entry and is a HIDDEN-tier route — it has
       no sidebar row by design, so it is opened through its header button, which is the only
       control a merchant has for it. */
    const ROUTES = [
      { id: 'orders',   label: 'Orders',     how: 'bnav' },
      { id: 'pos',      label: 'Sell (POS)', how: 'bnav' },
      { id: 'products', label: 'Products',   how: 'nav'  },
      /* KASS Shop needs a longer budget, and the reason is deliberate design rather than
         slowness: __openMiniShop() resolves ownership BEFORE navigating, and _resolve()
         waits up to 15s for auth (_awaitAuth(15000)) so that an unresolved read is reported
         as LOADING and never as "unclaimed" — which would invite a seller to re-claim a shop
         they already own. With no live auth here that full 15s elapses, then it routes.
         A 15s wait raced it and read #products, which looks exactly like a dead button. */
      { id: 'minishop', label: 'KASS Shop',  how: 'minishop', waitMs: 30000 },
    ];

    for (const r of ROUTES) {
      const clicked = await page.evaluate((r) => {
        if (r.how === 'minishop') {
          const b = document.getElementById('mshop-btn');
          if (!b) return 'no #mshop-btn';
          b.click(); return 'clicked #mshop-btn';
        }
        const sel = r.how === 'bnav'
          ? '#mbnav .mbnav-item[data-id="' + r.id + '"]'
          : '.mnav-item[data-id="' + r.id + '"]';
        const el = document.querySelector(sel);
        if (!el) return 'NO CONTROL ' + sel;
        el.click(); return 'clicked ' + sel;
      }, r);
      ck(r.label + ': the control exists and was clicked', !/^NO CONTROL|^no #/.test(clicked), clicked);
      await page.waitForFunction((id) => location.hash === '#' + id, r.id,
        { timeout: r.waitMs || 15000 }).catch(() => null);
      /* Panels mount asynchronously (iframes especially) — wait for one to be shown rather
         than sleeping, so a slow module is not mistaken for a dead button. */
      await page.waitForFunction(() => document.querySelectorAll('.mpanel.show').length >= 1,
        null, { timeout: 20000 }).catch(() => null);
      const st = await state(page);
      ck(r.label + ': landed on #' + r.id, st.hash === '#' + r.id, st.hash);
      assertShell(r.label, await chrome(page));
    }

    /* KASS Shop → Back → Merchant Home. The route before it was Products, so a Back that
       merely undid one step would land there; Merchant Home is the required destination. */
    head('5 · KASS Shop → Back → Merchant Home');
    await page.goBack();
    await page.waitForTimeout(1500);
    const afterBack = await state(page);
    ck('Back leaves KASS Shop', afterBack.hash !== '#minishop', afterBack.hash);
    ck('...and stays inside /merchant (no bounce out)', afterBack.path === '/merchant.html', afterBack.path);
    assertShell('after Back from KASS Shop', await chrome(page));

    /* Then Home, from wherever Back landed — the merchant must always be one control away
       from the marketplace. */
    const wentHome = await page.evaluate(() => {
      const el = document.querySelector('#mbnav .mbnav-item[data-id="home"]');
      if (!el) return false; el.click(); return true;
    });
    ck('Home is reachable from there', wentHome === true);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    const home = await page.evaluate(() => ({
      path: location.pathname,
      tmpl: (document.querySelector('meta[name="sokoni-page"]') || {}).content || '',
      shellGone: !document.querySelector('.mshell'),
    }));
    ck('...and lands on the marketplace home', home.tmpl === 'marketplace-home', home.tmpl || home.path);
    ck('...as a real navigation, shell gone', home.shellGone === true);

    /* The drawer is not a route — it is chrome. Opening it must not disturb the invariants. */
    head('6 · More drawer');
    await page.goBack();
    await page.waitForTimeout(1500);
    const opened = await page.evaluate(() => {
      const el = document.querySelector('#mbnav .mbnav-item[data-id="__more"]');
      if (!el) return 'no More control';
      el.click();
      return document.querySelector('.mshell').classList.contains('mobile-open') ? 'open' : 'did not open';
    });
    ck('More opens the drawer', opened === 'open', opened);
    assertShell('More drawer open', await chrome(page));
    await ctx.close();
  }

  await browser.close(); server.close(); clearTimeout(wd);
  console.log('\n' + '='.repeat(70));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
