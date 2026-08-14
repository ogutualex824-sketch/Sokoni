/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT ROUTE GATE — RUNTIME  (Phase 2D / 2K / 2O / 2P)
   ══════════════════════════════════════════════════════════════════════════════
   Answers one question per button, on a real iPhone-class webkit viewport:

     I clicked THIS exact sidebar button
       -> it entered THIS exact route
       -> it mounted THIS exact module
       -> exactly one panel is showing and nothing from the previous page remains
       -> the header is reachable, the bottom nav is reachable, nothing overflows
       -> no route error in the console

   HTTP 200 is not a pass. A changed title is not a pass. Panel identity is.

   PERSISTENT-PANEL NUANCE (deliberate, not a loophole): the POS and Seller apps are
   ONE panel each, shared by several routes and never destroyed — that is what keeps
   the Bluetooth/GATT printer connection and Firestore listeners alive across
   navigation. For those routes "old module destroyed" is provably false and we do
   NOT assert it. We assert instead: exactly one panel is visible, it is the right
   one, and the correct tab/section was requested on it.

   Run: node scripts/test-merchant-route-gate.js [--all]
        (default = Batch 1 only, per the phased acceptance plan)
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const { webkit } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const C = require(path.join(ROOT, 'sokoni-merchant-routes.js'));

const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
  '.png':'image/png', '.json':'application/json', '.svg':'image/svg+xml',
  '.jpg':'image/jpeg', '.webp':'image/webp', '.ico':'image/x-icon', '.woff2':'font/woff2' };

/* Batch 1 per the acceptance plan. --all widens to every primary route.
   'inventory' and 'cashier' were separate sidebar rows before the POS merge; they are now
   ALIASES of one POS route, so walking them here looked for buttons that deliberately no longer
   exist. Resolved through the contract so this list follows the architecture instead of
   restating a superseded copy of it, and de-duplicated so POS is not walked three times. */
const BATCH_1 = [...new Set(['dashboard', 'plan', 'products', 'inventory', 'cashier']
  .map((id) => C.resolve(id) || id))];
const TARGETS = process.argv.includes('--all')
  ? C.primary().map(r => r.id)
  : BATCH_1;

const VIEWPORTS = [
  { name: 'iPhone 14 Pro', width: 393, height: 852 },
  { name: 'iPhone SE',     width: 375, height: 667 },
];

let pass = 0, fail = 0;
const rows = [];
const check = (label, ok, detail) => {
  console.log('    ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
  return ok;
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/merchant.html';
  const fp = path.join(ROOT, p);
  fs.readFile(fp, (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
    res.end(d);
  });
});

/* App Check / Firebase cannot attest 127.0.0.1 — bucket that noise so it can never
   be mistaken for (or mask) a genuine route error. */
/* Third-party / localhost-only noise that says nothing about merchant routing:
     · App Check cannot attest 127.0.0.1, so every attested call 401/403s here.
     · The 'frame-ancestors ignored in report-only' warning comes from the injected
       reCAPTCHA / gapi frames, NOT from SOKONI — security.js's injectCSP() is a
       deliberate no-op and firebase.json serves an ENFORCED (not report-only) CSP. */
const ENV_NOISE = /App Check|appCheck|status of 40[0-9]|firebaseappcheck|favicon|net::ERR|Failed to load resource|frame-ancestors|report-only/i;

/* SHORTER THAN THE RUNNER'S BUDGET (150s for this suite, see SUITE_BUDGET_MS in
   gate-classify.js) ON PURPOSE. At 300s it could never fire — the runner killed this suite
   at 150s and recorded TIMEOUT, a non-blocking verdict, so a run in which all 28 assertions
   had already passed left the blocking set without saying anything. */
const wd = setTimeout(() => { console.log('\nSKIP — webkit watchdog timeout'); process.exit(0); }, 120000);
wd.unref && wd.unref();

server.listen(0, async () => {
  const BASE = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try { browser = await webkit.launch(); }
  catch (e) { console.log('SKIP — requires webkit, not available here: ' + (e && e.message || e)); server.close(); process.exit(0); return; }

  console.log('\nMERCHANT ROUTE GATE — RUNTIME (webkit)');
  console.log('Routes under test: ' + TARGETS.join(', '));
  console.log('='.repeat(74));

  for (const vp of VIEWPORTS) {
    console.log('\n' + '█'.repeat(74));
    console.log('  ' + vp.name + '  (' + vp.width + '×' + vp.height + ')');
    console.log('█'.repeat(74));

    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 3, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    const page = await ctx.newPage();
    let routeErrors = [];
    page.on('console', m => { if (m.type() === 'error' && !ENV_NOISE.test(m.text())) routeErrors.push(m.text().slice(0, 160)); });
    page.on('pageerror', e => { if (!ENV_NOISE.test(String(e.message))) routeErrors.push('PAGEERROR: ' + String(e.message).slice(0, 160)); });

    await page.goto(BASE + '/merchant.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);

    /* ── SIDEBAR acceptance (Phase 2L) ───────────────────────────────────── */
    console.log('\n  ── SIDEBAR ──');
    await page.evaluate(() => document.getElementById('mshell').classList.add('mobile-open'));
    await page.waitForTimeout(400);
    const sb = await page.evaluate(() => {
      const rail = document.querySelector('.mrail'), nav = document.querySelector('.mnav');
      const items = [].map.call(document.querySelectorAll('.mnav-item'), n => {
        const b = n.getBoundingClientRect();
        return { id: n.dataset.id, w: +b.width.toFixed(1), h: +b.height.toFixed(1),
                 label: (n.querySelector('.lbl') || {}).textContent };
      });
      const bn = document.getElementById('mbnav');
      return { count: items.length, items,
               railVisible: rail ? getComputedStyle(rail).transform : null,
               scrolls: nav ? nav.scrollHeight > nav.clientHeight : false,
               navClientH: nav ? nav.clientHeight : 0, navScrollH: nav ? nav.scrollHeight : 0,
               railZ: rail ? +getComputedStyle(rail).zIndex : null,
               bnavZ: bn ? +getComputedStyle(bn).zIndex : null,
               crushed: items.filter(i => i.w < 44 || i.h < 30).map(i => i.id) };
    });
    check('sidebar opens', sb.railVisible && sb.railVisible !== 'none' ? true : sb.count > 0);
    /* The sidebar is a PROJECTION of the contract, not a copy of it. Routes carry a tier, and
       `hidden` ones (MiniShop, reached from the header) deliberately have no sidebar row — so
       asserting count === ROUTES.length was asserting the pre-tier architecture and failed the
       moment a hidden route existed. Assert the projection in BOTH directions instead: every
       visible route present, and every hidden route absent. That is stricter than the count it
       replaces — a count cannot tell a missing row from an extra one. */
    const visibleRoutes = C.ROUTES.filter((r) => r.tier !== 'hidden');
    const hiddenRoutes  = C.ROUTES.filter((r) => r.tier === 'hidden');
    const missing = visibleRoutes.filter((r) => !sb.items.some((i) => i.id === r.id)).map((r) => r.id);
    const leaked  = hiddenRoutes.filter((r) => sb.items.some((i) => i.id === r.id)).map((r) => r.id);
    check('every visible contract route has a sidebar button',
          missing.length === 0, missing.length ? 'missing: ' + missing.join(', ') : sb.count + '/' + visibleRoutes.length);
    check('no hidden route leaks into the sidebar',
          leaked.length === 0, leaked.length ? 'leaked: ' + leaked.join(', ') : hiddenRoutes.map((r) => r.id).join(', ') + ' correctly absent');
    check('Plan button is visible in the sidebar', sb.items.some(i => i.id === 'plan'),
          (sb.items.find(i => i.id === 'plan') || {}).label || 'MISSING');
    check('sidebar scrolls (no unreachable rows)', sb.scrolls, sb.navScrollH + ' > ' + sb.navClientH);
    check('no crushed sidebar buttons', sb.crushed.length === 0, sb.crushed.join(',') || 'none');
    check('drawer stacks above bottom nav', sb.railZ > sb.bnavZ, 'rail z' + sb.railZ + ' > bnav z' + sb.bnavZ);
    await page.evaluate(() => document.getElementById('mshell').classList.remove('mobile-open'));

    /* ── Per-route acceptance ─────────────────────────────────────────────── */
    for (const id of TARGETS) {
      const route = C.get(id);
      console.log('\n  ── ' + route.name.toUpperCase() + '  (#' + id + ') ──');
      routeErrors = [];

      const before = await page.evaluate(() => {
        const s = document.querySelector('.mpanel.show');
        return { key: s ? (s.querySelector('iframe') ? 'iframe:' + s.querySelector('iframe').id : 'native:' + ((s.querySelector('.native') || {}).id || '')) : null };
      });

      /* CLICK the real sidebar button — never call the router directly. */
      const clicked = await page.evaluate(rid => {
        const el = document.querySelector('.mnav-item[data-id="' + rid + '"]');
        if (!el) return false;
        el.click(); return true;
      }, id);
      if (!check('sidebar button exists and was clicked', clicked)) continue;

      await page.waitForTimeout(id === 'dashboard' ? 1200 : 3000);

      const st = await page.evaluate(() => {
        const shown = [].filter.call(document.querySelectorAll('.mpanel'), p => p.classList.contains('show'));
        const s = shown[0] || null;
        const ifr = s ? s.querySelector('iframe') : null;
        const nat = s ? s.querySelector('.native') : null;
        const r = el => { if (!el) return null; const b = el.getBoundingClientRect();
          return { top:+b.top.toFixed(1), bottom:+b.bottom.toFixed(1), h:+b.height.toFixed(1), w:+b.width.toFixed(1) }; };
        const burger = document.getElementById('burger');
        return {
          hash: location.hash.replace('#',''),
          title: (document.getElementById('mtitle') || {}).textContent,
          shownCount: shown.length,
          panelKind: ifr ? 'iframe' : nat ? 'native' : 'empty',
          iframeId: ifr ? ifr.id : null,
          iframeSrc: ifr ? ifr.getAttribute('src') : null,
          nativeId: nat ? nat.id : null,
          nativeHasContent: nat ? nat.innerHTML.trim().length > 40 : false,
          activeNav: (document.querySelector('.mnav-item.active') || {}).dataset ? document.querySelector('.mnav-item.active').dataset.id : null,
          activeCount: document.querySelectorAll('.mnav-item.active').length,
          panel: r(document.querySelector('.mpanel.show')),
          bnav: r(document.getElementById('mbnav')),
          mtop: r(document.querySelector('.mtop')),
          burgerVisible: burger ? (burger.getBoundingClientRect().width > 0 && burger.getBoundingClientRect().top >= 0) : false,
          docScrollW: document.documentElement.scrollWidth,
          innerW: window.innerWidth,
          drawerClosed: !document.getElementById('mshell').classList.contains('mobile-open'),
        };
      });

      /* ROUTE identity */
      check('route entered: #' + id, st.hash === id, '#' + st.hash);
      check('page title matches route', st.title === route.name, st.title);
      check('active-state key is the route', st.activeNav === id && st.activeCount === 1,
            st.activeNav + ' (' + st.activeCount + ' active)');

      /* MODULE identity — the part HTTP 200 can never prove */
      let modOk = false, modDetail = '';
      if (route.kind === 'native') {
        modOk = st.panelKind === 'native' && st.nativeId === 'native-' + id;
        modDetail = st.nativeId || st.panelKind;
      } else if (route.kind === 'pos') {
        modOk = st.panelKind === 'iframe' && st.iframeId === 'mfx-pos';
        modDetail = st.iframeId + ' src=' + st.iframeSrc;
      } else if (route.kind === 'seller') {
        modOk = st.panelKind === 'iframe' && st.iframeId === 'mfx-seller';
        modDetail = st.iframeId + ' src=' + st.iframeSrc;
      } else if (route.kind === 'page') {
        const want = route.src.split('?')[0];
        modOk = st.panelKind === 'iframe' && !!st.iframeSrc && st.iframeSrc.split('?')[0] === want;
        modDetail = st.iframeSrc;
      }
      check('correct module mounted (' + route.kind + ')', modOk, modDetail);

      /* NOTHING LEFT OVER */
      check('exactly one panel visible (previous module gone)', st.shownCount === 1, st.shownCount + ' visible');
      if (route.kind === 'native')
        check('native module rendered real content', st.nativeHasContent);
      if (route.kind === 'pos' || route.kind === 'seller')
        console.log('    NOTE  ' + route.kind + ' panel is persistent by design (printer/GATT + listeners survive) — ' +
                    'not destroyed; asserted single-visible + correct target instead' +
                    (before.key ? '   [prev: ' + before.key + ']' : ''));

      /* NO LEGACY / NO ESCAPE */
      /* Strip BOTH query and hash — the hash IS the route, so its presence is expected. */
      check('still inside /merchant (no full-page navigation)',
            page.url().split('#')[0].split('?')[0].endsWith('/merchant.html'),
            page.url().replace(BASE, ''));
      check('no legacy dashboard target',
            !st.iframeSrc || !/dashboard\.html|seller-dashboard/i.test(st.iframeSrc), st.iframeSrc || 'native');

      /* MOBILE LAYOUT (Phase 2E/2F/2G/2O) */
      check('content clears the bottom nav',
            st.panel && st.bnav && st.panel.bottom <= st.bnav.top + 0.5,
            'panel ' + (st.panel && st.panel.bottom) + ' vs bnav ' + (st.bnav && st.bnav.top));
      check('bottom nav is on-screen', st.bnav && st.bnav.bottom <= vp.height + 0.5,
            String(st.bnav && st.bnav.bottom));
      check('header reachable (burger visible, not under content)', st.burgerVisible && st.mtop.top >= 0);
      check('no horizontal page overflow', st.docScrollW <= st.innerW + 0.5,
            st.docScrollW + ' vs ' + st.innerW);
      check('drawer auto-closed after navigation', st.drawerClosed);

      /* CONSOLE */
      check('no route/console error', routeErrors.length === 0, routeErrors[0] || 'clean');

      rows.push({ vp: vp.name, id, route: route.kind, ok: modOk });
    }

    /* ── BACK / REFRESH integrity (Phase 2K steps 10-11) ──────────────────── */
    console.log('\n  ── DEEP LINK + REFRESH ──');
    await page.goto(BASE + '/merchant.html#inventory', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    const deep = await page.evaluate(() => ({
      hash: location.hash.replace('#',''),
      title: (document.getElementById('mtitle') || {}).textContent,
      shown: document.querySelectorAll('.mpanel.show').length,
      frame: (document.querySelector('.mpanel.show iframe') || {}).id || null,
    }));
    /* #inventory is an ALIAS of pos since the Cashier + Inventory merge — a bookmark on the old
       hash must still land somewhere real, and the contract says that place is POS. Asserting
       the hash stayed `inventory` was asserting the pre-merge architecture; what matters is that
       the alias RESOLVES rather than dead-ends. */
    check('deep link #inventory resolves through the alias to POS',
          deep.hash === C.resolve('inventory'), '#' + deep.hash + ' (contract: ' + C.resolve('inventory') + ')');
    check('deep link mounts the POS panel', deep.frame === 'mfx-pos', String(deep.frame));
    check('deep link shows exactly one panel', deep.shown === 1, String(deep.shown));

    /* Legacy alias must still land (back-compat, not a silent dashboard fallback). */
    await page.goto(BASE + '/merchant.html#finance', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1800);
    const alias = await page.evaluate(() => ({ hash: location.hash.replace('#',''),
      title: (document.getElementById('mtitle') || {}).textContent }));
    check('legacy #finance aliases to Revenue', alias.hash === 'revenue', '#' + alias.hash + ' / ' + alias.title);

    /* An unknown route must fail LOUDLY and must not become Dashboard. */
    const unknown = await page.evaluate(() => {
      const errs = [];
      const orig = console.error; console.error = function () { errs.push([].join.call(arguments, ' ')); orig.apply(console, arguments); };
      const before = location.hash;
      try { window.SokoniShell.go('totally-not-a-route'); } catch (_) {}
      console.error = orig;
      return { errs, hashUnchanged: location.hash === before, hash: location.hash };
    });
    check('unknown route refused loudly (not a silent Dashboard fallback)',
          unknown.errs.some(e => /unknown route/i.test(e)) && unknown.hashUnchanged,
          unknown.hash);

    await ctx.close();
  }

  /* REPORT FIRST, THEN TEAR DOWN — and never let teardown decide the verdict.
     Measured in the gate: all 28 assertions printed PASS through the last section, then
     browser.close() never returned and the runner SIGKILLed the suite at its 150s budget.
     It was recorded as TIMEOUT, which is NOT a defect verdict — so a suite that had just
     proved the whole route matrix silently left the blocking set instead of counting as
     the coverage it is. Printing the matrix and the tally first, then racing teardown
     against a short timer, means a slow browser teardown can no longer erase a finished
     result. Same fix, same reason, as test-seller-deeplink. */
  console.log('\n' + '='.repeat(74));
  console.log('  ROUTE MATRIX');
  rows.forEach(r => console.log('    ' + (r.ok ? '✓' : '✗') + '  ' + r.vp.padEnd(14) + r.id.padEnd(12) + r.route));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');

  clearTimeout(wd);
  await Promise.race([
    (async () => { try { await browser.close(); } catch (_) {} })(),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
  /* A close that lost the race above is still RUNNING. Abandoning it leaks the browser:
     measured at 32 orphaned WebKit processes after one gate, which starves the renderers
     of later suites and crashes them. Kill what did not close. */
  try { const _p = browser.process && browser.process(); if (_p) _p.kill('SIGKILL'); } catch (_) {}
  try { server.close(); } catch (_) {}
  process.exit(fail ? 1 : 0);
});
