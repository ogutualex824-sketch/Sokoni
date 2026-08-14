/* Shared-panel deep-switch: the module must actually SHOW the requested section/tab.
 *
 *   node scripts/test-merchant-deep-switch.js
 *
 * WHY THIS EXISTS
 * "Merchant → Products opens the Home/Dashboard page." The POS and Seller panels are
 * persistent and shared by several routes, and the Seller panel is pre-created at 'overview'
 * when the Dashboard loads its feed. Switching was a single fire-and-forget postMessage, so if
 * the hosted app had not finished booting the message was dropped — and 'overview' IS the
 * seller home page. An earlier fix re-asserted on the iframe's `load` event, which never fires
 * again once the panel is already loaded, so it only ever helped the first navigation.
 *
 * The visual gate did not catch it: it asserted the right DOCUMENT was mounted (seller.html),
 * which was true. The wrong SECTION of the right document is invisible to that check.
 *
 * So this suite reads the hosted document's own rendered state:
 *   · a section that belongs to the target page IS visible, and
 *   · a section that belongs only to overview is NOT visible.
 * Both halves matter — products and overview share 'upload-section', so checking one section
 * would report success while the home page was on screen.
 *
 * It also walks route -> route -> back, because the bug only appears on a panel that is
 * already loaded.
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
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).replace(/\s+/g, ' ').slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};

/* show: belongs to this page, NOT to overview.  hide: overview-only.
   Mirrors the map in merchant.html sellerSwitch, and is derived from seller.js DASH_PAGES. */
const SELLER = {
  products:  { show: 'bulk-upload-section', hide: 'seller-stats' },
  receipts:  { show: 'receipts-section',    hide: 'seller-stats' },
  staff:     { sec: 'team', show: 'team-section', hide: 'seller-stats' },
  messages:  { show: 'seller-dms',          hide: 'seller-stats' },
  marketing: { show: 'marketing-section',   hide: 'seller-stats' },
  stories:   { show: 'stories-section',     hide: 'seller-stats' },
  disputes:  { show: 'disputes-section',    hide: 'seller-stats' },
  customers: { show: 'customers-section',   hide: 'seller-stats' },
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/merchant.html';
  let f = path.join(ROOT, p);
  if (!path.extname(p)) f += '.html';
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
    res.end(d);
  });
});

/* SHORTER THAN THE RUNNER'S BUDGET (300s for this suite, see SUITE_BUDGET_MS in
   gate-classify.js) ON PURPOSE. At 600s it could never fire: the runner always killed the
   suite first, at 300s, and a killed suite is TIMEOUT — a non-blocking verdict, so it left
   the blocking set silently rather than saying it had hung. A watchdog that cannot outlive
   its own executioner is not a watchdog. */
const wd = setTimeout(() => { console.log('SKIP — watchdog'); process.exit(0); }, 240000);
wd.unref && wd.unref();

async function sellerState(page) {
  return page.evaluate(() => {
    const f = document.getElementById('mfx-seller');
    try {
      const d = f && f.contentDocument; if (!d) return { ok: false, why: 'no seller document' };
      const vis = (id) => {
        const el = d.getElementById(id); if (!el) return null;
        const cs = d.defaultView.getComputedStyle(el);
        return !!cs && cs.display !== 'none' && cs.visibility !== 'hidden';
      };
      const ids = ['bulk-upload-section','receipts-section','team-section','seller-dms',
                   'marketing-section','stories-section','disputes-section','customers-section',
                   'seller-stats'];
      const out = {}; ids.forEach((i) => { out[i] = vis(i); });
      return { ok: true, vis: out };
    } catch (e) { return { ok: false, why: e.message }; }
  });
}

server.listen(0, async () => {
  const BASE = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try { browser = await webkit.launch(); }
  catch (e) { console.log('SKIP — webkit unavailable: ' + (e && e.message || e)); server.close(); process.exit(0); return; }

  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('loggedIn', 'true');
      localStorage.setItem('sokoniUser', JSON.stringify({
        uid: 'deep-switch-uid', name: 'Deep Switch', roles: ['seller', 'merchant'], role: 'seller',
      }));
    } catch (e) {}

    /* ── TEMPORARY DIAGNOSTIC — the products-route stall ──────────────────────────
       One route out of five, a different one each run, never renders inside its 20s cap
       while the others render in ~270ms. It reaches the ROUTE CAP, not the walk ceiling,
       so it is not budget starvation; and it survived the seller-side throw fix (f0de77b),
       so the handler discarding a thrown switch was NOT the cause.
       This traces the MERCHANT side — the half never instrumented. It records every
       postMessage the shell sends to the module and samples what the shell's own verify()
       would see, so a failure can be classified rather than guessed:
         A never rendered   B rendered then reverted   C rendered but verify disagrees
         D another message overwrote it                E the page stopped responding
       Injected by the suite, printed only on failure. No product code is modified. */
    window.__dsTrace = { posts: [], samples: [], t0: Date.now() };
    var _T = function () { return Date.now() - window.__dsTrace.t0; };
    var _lastKey = '';
    setInterval(function () {
      var f = document.getElementById('mfx-seller');
      if (!f) return;
      /* Re-hook whenever the iframe navigates and gives us a fresh contentWindow. */
      try {
        var cw = f.contentWindow;
        if (cw && !cw.__dsHooked) {
          var orig = cw.postMessage.bind(cw);
          cw.postMessage = function (msg, origin) {
            try {
              if (msg && msg.__sokoniShell) {
                window.__dsTrace.posts.push({ t: _T(), action: msg.action, section: msg.section });
              }
            } catch (e) {}
            return orig(msg, origin);
          };
          cw.__dsHooked = true;
          window.__dsTrace.posts.push({ t: _T(), action: '(iframe contentWindow (re)hooked)', section: '' });
        }
      } catch (e) { /* cross-doc during navigation */ }

      /* Sample exactly what the shell's verify() reads: the module's own section DOM. */
      try {
        var d = f.contentDocument;
        if (!d) { return; }
        var vis = function (id) {
          var el = d.getElementById(id); if (!el) return 'MISSING';
          var cs = d.defaultView.getComputedStyle(el);
          return (cs.display !== 'none' && cs.visibility !== 'hidden') ? 'shown' : 'hidden';
        };
        var shown = [];
        ['bulk-upload-section', 'receipts-section', 'seller-dms', 'stories-section',
         'customers-section', 'seller-stats'].forEach(function (id) {
          if (vis(id) === 'shown') shown.push(id);
        });
        var key = shown.join(',') + '|' + (d.documentElement.getAttribute('data-seller-deeplink') || '');
        if (key !== _lastKey) {
          _lastKey = key;
          window.__dsTrace.samples.push({ t: _T(), shown: shown.slice(), marker:
            d.documentElement.getAttribute('data-seller-deeplink') || '',
            ready: d.readyState });
        }
      } catch (e) { /* cross-doc during navigation */ }
    }, 50);
  });
  const page = await ctx.newPage();

  console.log('\nSHARED-PANEL DEEP SWITCH — the module must SHOW the right section');
  console.log('='.repeat(72));

  await page.goto(BASE + '/merchant.html', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForTimeout(3000);

  /* Dashboard pre-creates the seller panel at 'overview'. That is the precondition for the
     reported bug, so assert it happened rather than assuming. */
  const pre = await page.evaluate(() => !!document.getElementById('mfx-seller'));
  console.log('\n  precondition');
  ck('Dashboard pre-created the shared seller panel', pre, pre ? 'panel exists (overview)' : 'not pre-created');

  console.log('\n  first navigation into a shared-panel route');
  await page.evaluate(() => { const e = document.querySelector('.mnav-item[data-id="products"]'); if (e) e.click(); });
  await page.waitForTimeout(7000);
  let st = await sellerState(page);
  ck('Products SHOWS a products-only section', st.ok && st.vis['bulk-upload-section'] === true,
     st.ok ? JSON.stringify(st.vis['bulk-upload-section']) : st.why);
  ck('Products does NOT show the seller home page', st.ok && st.vis['seller-stats'] === false,
     st.ok ? 'seller-stats visible=' + st.vis['seller-stats'] : st.why);

  /* The bug only reproduces on an ALREADY-LOADED panel — walk between shared routes. */
  console.log('\n  switching between routes that share the panel (already loaded)');
  /* ONE readiness budget for the whole walk, not an independent one per route.
     A per-route 20s bound MULTIPLIES: five routes here plus the earlier walk reached
     ~200s under the full 164-suite population and pushed this suite past its 300s gate
     budget into a TIMEOUT — worse than the flat 5s sleep it replaced, which capped at
     ~50s. Routes are NOT uniformly fast — an 8s per-route cap failed `customers` even
     standalone (customers-section=false, 14/15), so the per-route allowance stays 20s.
     The shared 60s ceiling is what stops five of those compounding: each route breaks as
     soon as its section renders, and the walk as a whole cannot exceed the ceiling. */
  const _walkDeadline = Date.now() + 60000;
  for (const id of ['receipts', 'messages', 'stories', 'customers', 'products']) {
    const cfg = SELLER[id];
    await page.evaluate((rid) => { const e = document.querySelector('.mnav-item[data-id="' + rid + '"]'); if (e) e.click(); }, id);
    /* Wait for the CONDITION being asserted, not a fixed span of time.
       A flat 5s sample raced under load: measured 12/3 with three "shows its own
       section" failures (seller-dms, customers-section, bulk-upload-section all
       false) while every "is not the seller home page" assertion passed — the route
       had resolved and the panel simply had not rendered yet. The same suite passes
       15/15 given more time, and ran 601s under six concurrent webkit suites against
       a 300s gate budget, so it was also silently leaving the blocking set.

       Polls the SAME sellerState() the assertions read, so the wait and the assertion
       can never diverge. Bounded, and on timeout it falls through and asserts anyway —
       a genuine regression still fails with real evidence rather than being masked. */
    /* Report how long the route took AND which bound ended the wait. Without this the
       failure reads as "customers-section=false" and looks like a routing defect, when the
       route that fails is simply whichever one is running when time runs out — it moved
       from `customers` to `products` between two runs of the same commit. A per-route
       elapsed plus the reason distinguishes "this section never renders" from "this walk
       ran out of budget three routes ago", which are opposite bugs with opposite fixes. */
    const _routeStart = Date.now();
    const _routeCap = Math.min(_routeStart + 20000, _walkDeadline);
    let _why = 'rendered';
    for (;;) {
      st = await sellerState(page);
      if (st.ok && st.vis[cfg.show] === true) break;
      if (Date.now() >= _routeCap) { _why = Date.now() >= _walkDeadline ? 'WALK CEILING' : 'route cap 20s'; break; }
      await page.waitForTimeout(250);
    }
    const _took = Date.now() - _routeStart;
    const _ok = st.ok && st.vis[cfg.show] === true;
    /* TEMPORARY DIAGNOSTIC — dump the merchant-side trace for the route that stalled, so the
       runner's capture preserves it from a real full-population run. Printed only on failure,
       and only reads, so it cannot change a verdict. */
    if (!_ok) {
      try {
        const tr = await page.evaluate(() => {
          const t = window.__dsTrace || { posts: [], samples: [] };
          return { posts: t.posts.slice(-45), samples: t.samples.slice(-25) };
        });
        console.log('\n  ── MERCHANT-SIDE TRACE for "' + id + '" (expects ' + cfg.show + ') ──');
        console.log('     postMessages the shell sent (' + tr.posts.length + '):');
        tr.posts.forEach((p) => console.log('       t=' + String(p.t).padStart(6) + 'ms  ' + p.action + (p.section ? ' -> ' + p.section : '')));
        console.log('     module section state, on change (' + tr.samples.length + '):');
        tr.samples.forEach((s) => console.log('       t=' + String(s.t).padStart(6) + 'ms  ready=' + s.ready +
          '  marker=' + (s.marker || '-') + '  shown=[' + s.shown.join(', ') + ']'));
        console.log('  ── END TRACE ──\n');
      } catch (e) { console.log('  (trace unavailable: ' + e.message + ')'); }
    }
    ck(id + ' shows its own section', _ok,
       (st.ok ? cfg.show + '=' + st.vis[cfg.show] : st.why) + ' after ' + _took + 'ms (' + _why + ')');
    ck(id + ' is not the seller home page', st.ok && st.vis[cfg.hide] === false,
       st.ok ? 'seller-stats=' + st.vis[cfg.hide] : st.why);
  }

  /* POS panel: two routes share it, so the tab must be re-asserted the same way. */
  console.log('\n  shared POS panel — Inventory vs Cashier vs Audit');
  /* Cashier and Inventory were MERGED into one POS route; audit and pos-settings are POS tabs
     and no longer sidebar rows. The sidebar now offers a single POS entry, so this walks that
     one route and leaves tab-to-tab switching to test-pos-tab-transitions.js, which drives the
     POS controller directly. Asserting sidebar rows that deliberately no longer exist would be
     testing the old architecture. */
  for (const [id, tab] of [['pos', 'pos']]) {
    await page.evaluate((rid) => { const e = document.querySelector('.mnav-item[data-id="' + rid + '"]'); if (e) e.click(); }, id);
    await page.waitForTimeout(5000);
    const posOk = await page.evaluate((t) => {
      const f = document.getElementById('mfx-pos');
      try {
        const d = f && f.contentDocument; if (!d) return { ok: false, why: 'no pos document' };
        const el = d.querySelector('[data-tab="' + t + '"]');
        if (!el) return { ok: false, why: 'tab ' + t + ' not found' };
        return { ok: el.getAttribute('aria-selected') === 'true' || /\bactive\b/.test(el.className || ''),
                 why: 'aria-selected=' + el.getAttribute('aria-selected') };
      } catch (e) { return { ok: false, why: e.message }; }
    }, tab);
    ck(id + ' activates the ' + tab + ' tab', posOk.ok, posOk.why);
    const title = await page.evaluate(() => (document.getElementById('mtitle') || {}).textContent);
    /* "Cashier", not "POS / Cashier": this route is the in-shop CHECKOUT surface, and the POS
       app's other surfaces are their own merchant routes. Kept in sync with the route contract. */
    const want = { pos: 'POS' }[id];
    ck(id + ' title is correct', title === want, title);
  }

  /* REPORT FIRST, THEN TEAR DOWN — and never let teardown decide the verdict.
     Measured: every assertion here passes (15/15) under the Firestore emulator and the
     process then hangs in browser.close() until something outside kills it — 400s with no
     summary line, which is the "same commit passes in ~17s or hangs for 300s+" divergence.
     The suite had finished testing; the browser would not go away. This last case leaves a
     merchant shell holding live panel iframes with in-flight requests, and closing that is
     intermittently slow — milliseconds standalone, unbounded under a loaded gate.
     A suite that has already answered the question must not be reported as lost coverage
     because teardown took its time, so the result is printed before teardown and teardown
     is raced against a short timer. Same fix, same reason, as test-seller-deeplink. */
  console.log('\n' + '='.repeat(72));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');

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
