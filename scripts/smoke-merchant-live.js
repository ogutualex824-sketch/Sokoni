/* PRODUCTION smoke test — merchant shell on https://mysokoni.co.ke
 *
 *   node scripts/smoke-merchant-live.js [--base https://mysokoni.co.ke] [--commit <sha>]
 *
 * Runs against LIVE production in webkit (the iPhone/Safari engine) at an iPhone viewport,
 * with a cache-buster, and asserts the post-deploy checklist. This is deliberately NOT the
 * 588-check acceptance gate — it is the short list that proves the deploy landed and the
 * shell is operable on a real device against real infrastructure.
 *
 * WHAT THIS CANNOT PROVE, and never claims to:
 *   · Anything requiring a real signed-in merchant. Production enforces App Check and real
 *     Firebase Auth; a headless browser has neither. Module surfaces that need a session
 *     will show their honest auth state, which is itself a valid observation but is not the
 *     same as "Products rendered this merchant's products".
 *   · Returns WITH DATA. The `returns` collection is still default-denied in production
 *     because the rules release is blocked (docs/FIRESTORE_RULES_RELEASE_BLOCKER.md).
 *     Returns is expected to reach an honest permission/error state, never the old generic
 *     "Failed to load returns", and never a silent empty screen pretending to be data.
 */
'use strict';
const { webkit } = require('playwright');
const https = require('https');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
const BASE = argOf('--base', 'https://mysokoni.co.ke').replace(/\/$/, '');
const WANT_COMMIT = argOf('--commit', '');
const cb = () => 'cb=' + Date.now() + Math.floor(Math.random() * 1e6);

let pass = 0, fail = 0, warn = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).replace(/\s+/g, ' ').slice(0, 110) + ']' : ''));
  ok ? pass++ : fail++;
};
const note = (l, d) => { console.log('  NOTE  ' + l + (d ? '   [' + String(d).replace(/\s+/g, ' ').slice(0, 110) + ']' : '')); warn++; };

const get = (url) => new Promise((res, rej) => {
  https.get(url, { headers: { 'Cache-Control': 'no-cache' } }, (r) => {
    let b = ''; r.on('data', (d) => b += d); r.on('end', () => res({ status: r.statusCode, body: b, headers: r.headers }));
  }).on('error', rej);
});

/* Production noise that says nothing about this deploy. App Check legitimately rejects a
   headless browser, and third-party auth/recaptcha frames emit their own warnings. */
const ENV_NOISE = /App Check|appCheck|firebaseappcheck|recaptcha|gstatic|googleapis|status of 40[13]|frame-ancestors|report-only|Failed to load resource|net::ERR/i;
const AUTH_PAGE = /\/(login|signup|register|reset-password)(\.html)?(\?|#|$)/i;

(async () => {
  console.log('\nSOKONI MERCHANT — PRODUCTION SMOKE TEST');
  console.log('Target: ' + BASE);
  console.log('='.repeat(76));

  /* ── 1. The deploy actually landed ───────────────────────────────────────── */
  console.log('\n1. Deploy identity (cache-busted)');
  const v = await get(BASE + '/version.json?' + cb());
  let ver = {};
  try { ver = JSON.parse(v.body); } catch (_) {}
  ck('version.json served', v.status === 200, 'HTTP ' + v.status);
  console.log('        commit=' + ver.commitShort + '  cache=' + ver.cacheVersion + '  built=' + ver.buildTime);
  if (WANT_COMMIT) {
    ck('live commit matches the deployed commit',
       String(ver.commit || '').startsWith(WANT_COMMIT) || String(ver.commitShort || '') === WANT_COMMIT.slice(0, 7),
       ver.commitShort + ' vs ' + WANT_COMMIT.slice(0, 7));
  }

  /* The new files must actually be on the CDN, not just in the build. */
  for (const f of ['sokoni-merchant-routes.js', 'sokoni-inshell.js']) {
    const r = await get(BASE + '/' + f + '?' + cb());
    ck('new asset is live: ' + f, r.status === 200 && r.body.length > 500, 'HTTP ' + r.status + ' ' + r.body.length + 'B');
  }
  const mr = await get(BASE + '/sokoni-merchant-routes.js?' + cb());
  ck('route contract contains the Plan route', /id:'plan'/.test(mr.body));
  ck('route contract has the canonical sidebar order', /PRIMARY_ORDER/.test(mr.body));

  /* ── 2. The shell on a real iPhone viewport ──────────────────────────────── */
  let browser;
  try { browser = await webkit.launch(); }
  catch (e) { console.log('\nSKIP — webkit unavailable: ' + (e && e.message || e)); process.exit(0); }

  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  /* Per-frame error bridge — page.on('pageerror') carries no frame, so it would blame the
     shell for a module's error. Same reason as the acceptance gate. */
  /* Seed the SHELL SESSION FLAG only.
     Without it the run is genuinely unauthenticated, and the shell then does exactly what it
     should: a module reports authRequired, the shell finds no session of its own, and it sends
     the whole tab to login. Correct behaviour — but it ends the smoke test at /login and proves
     nothing about routing. auth-guard treats localStorage.loggedIn as authoritative for the
     session (see its 2026-07-26 note on the profile<->login loop), so seeding it lets the shell
     and every route be exercised on production.

     This grants UI session state and NOTHING else: Firestore rules and App Check still govern
     every read, there is no Firebase user, and no module can show real merchant data. Data-level
     behaviour must be verified by signing in on a real device. */
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('loggedIn', 'true');
      localStorage.setItem('sokoniUser', JSON.stringify({
        uid: 'smoke-probe', name: 'Smoke Probe', roles: ['seller', 'merchant'], role: 'seller',
      }));
    } catch (e) {}
    window.__skErrors = [];
    const push = (k, m, s) => { try { window.__skErrors.push({ k, m: String(m || '').slice(0, 200), doc: location.pathname, src: s || '' }); } catch (_) {} };
    /* Capture phase also fires for FAILED RESOURCE LOADS (img/script/link), which carry no
       message and are not script errors. Recording them as page errors produced a bare
       "/seller: " with nothing after it — an alarm with no content. Separate them and keep
       the failing URL, so a genuinely broken asset is still visible instead of hidden. */
    window.addEventListener('error', (e) => {
      const el = e.target;
      if (el && el !== window && (el.src || el.href)) {
        push('resource', 'failed to load: ' + (el.src || el.href), el.src || el.href);
        return;
      }
      push('error', e.message, e.filename);
    }, true);
    window.addEventListener('unhandledrejection', (e) => push('rejection', e.reason && e.reason.message || e.reason, ''));
  });
  const page = await ctx.newPage();
  await page.goto(BASE + '/merchant?' + cb(), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  /* Exercise the safe-area path exactly as a notched iPhone would. */
  await page.evaluate(() => { const r = document.documentElement;
    r.style.setProperty('--safe-top', '59px'); r.style.setProperty('--safe-bot', '34px'); });
  await page.waitForTimeout(400);

  console.log('\n2. Shell chrome (iPhone 393x852, notch simulated)');
  const shell = await page.evaluate(() => {
    const hit = (el) => {
      if (!el) return { ok: false, why: 'missing' };
      const b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) return { ok: false, why: 'zero size' };
      const x = b.left + b.width / 2, y = b.top + b.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return { ok: false, why: 'off-screen' };
      const t = document.elementFromPoint(x, y);
      return { ok: !!t && (t === el || el.contains(t) || t.contains(el)),
               why: t ? t.tagName.toLowerCase() + (t.id ? '#' + t.id : '') : 'nothing' };
    };
    const bn = document.getElementById('mbnav');
    const items = [].map.call(document.querySelectorAll('.mbnav-item'), (n) => ({ id: n.dataset.id, h: hit(n) }));
    const panel = document.querySelector('.mpanel.show');
    const r = (e) => e ? e.getBoundingClientRect() : null;
    return {
      shellPresent: !!document.getElementById('mshell'),
      navCount: document.querySelectorAll('.mnav-item').length,
      sidebarIds: [].map.call(document.querySelectorAll('.mnav-item'), (n) => n.dataset.id),
      burger: hit(document.getElementById('burger')),
      headerPadTop: (() => { const t = document.querySelector('.mtop'); return t ? getComputedStyle(t).paddingTop : null; })(),
      bnavItems: items,
      bnavBottom: bn ? +r(bn).bottom.toFixed(1) : null,
      bnavTop: bn ? +r(bn).top.toFixed(1) : null,
      panelBottom: panel ? +r(panel).bottom.toFixed(1) : null,
      innerH: innerHeight, innerW: innerWidth,
      scrollW: document.documentElement.scrollWidth,
      title: (document.getElementById('mtitle') || {}).textContent,
    };
  });
  ck('merchant shell loaded', shell.shellPresent);
  ck('sidebar rendered from the contract (32 routes)', shell.navCount === 32, String(shell.navCount));
  ck('Plan is in the sidebar', shell.sidebarIds.indexOf('plan') > -1, 'position ' + (shell.sidebarIds.indexOf('plan') + 1));
  ck('sidebar order starts Dashboard, Plan, Products',
     shell.sidebarIds.slice(0, 3).join(',') === 'dashboard,plan,products', shell.sidebarIds.slice(0, 3).join(','));
  ck('header absorbs the notch inset', parseFloat(shell.headerPadTop) >= 59 - 0.5, 'padding-top ' + shell.headerPadTop);
  ck('HEADER burger is reachable (hit-test)', shell.burger.ok, shell.burger.why);
  ck('BOTTOM NAV fully on-screen', shell.bnavBottom !== null && shell.bnavBottom <= shell.innerH + 0.5,
     shell.bnavBottom + ' vs ' + shell.innerH);
  ck('every bottom-nav button reachable (hit-test)',
     shell.bnavItems.length === 4 && shell.bnavItems.every((b) => b.h.ok),
     shell.bnavItems.filter((b) => !b.h.ok).map((b) => b.id + ':' + b.h.why).join(',') || '4/4 reachable');
  ck('content clears the bottom nav', shell.panelBottom !== null && shell.panelBottom <= shell.bnavTop + 0.5,
     shell.panelBottom + ' vs ' + shell.bnavTop);
  ck('no horizontal page overflow', shell.scrollW <= shell.innerW + 0.5, shell.scrollW + ' vs ' + shell.innerW);

  /* ── 3. Routes ───────────────────────────────────────────────────────────── */
  console.log('\n3. Routes — module identity, no auth page in a panel, no double nav');
  const ROUTES = [
    { id: 'dashboard', name: 'Dashboard',    kind: 'native' },
    { id: 'plan',      name: 'Plan',         kind: 'page', doc: 'plans' },
    { id: 'products',  name: 'Products',     kind: 'seller', doc: 'seller' },
    { id: 'inventory', name: 'Inventory',    kind: 'pos', doc: 'pos' },
    { id: 'cashier',   name: 'POS / Cashier',kind: 'pos', doc: 'pos' },
    { id: 'orders',    name: 'Orders',       kind: 'native' },
    { id: 'returns',   name: 'Returns',      kind: 'page', doc: 'returns' },
  ];
  const norm = (u) => String(u || '').split('?')[0].split('#')[0].split('/').pop().replace(/\.html$/i, '').toLowerCase();

  for (const r of ROUTES) {
    await page.evaluate((id) => { const el = document.querySelector('.mnav-item[data-id="' + id + '"]'); if (el) el.click(); }, r.id);
    await page.waitForTimeout(r.kind === 'native' ? 2500 : 7000);

    const st = await page.evaluate(() => {
      const shown = [].filter.call(document.querySelectorAll('.mpanel'), (p) => p.classList.contains('show'));
      const panel = shown[0];
      const ifr = panel ? panel.querySelector('iframe') : null;
      return {
        hash: location.hash.replace('#', ''),
        title: (document.getElementById('mtitle') || {}).textContent,
        shown: shown.length,
        iframeSrc: ifr ? ifr.getAttribute('src') : null,
        nativeId: panel && panel.querySelector('.native') ? panel.querySelector('.native').id : null,
        topLevel: location.pathname,
      };
    });

    const frameUrl = st.iframeSrc
      ? (page.frames().map((f) => f.url()).find((u) => norm(u) === norm(st.iframeSrc)) || st.iframeSrc)
      : null;

    console.log('    ── ' + r.name + ' ──');
    ck('route entered #' + r.id, st.hash === r.id, '#' + st.hash);
    ck('title correct', st.title === r.name, st.title);
    ck('exactly one panel visible', st.shown === 1, String(st.shown));
    ck('still inside /merchant', /\/merchant(\.html)?$/.test(st.topLevel), st.topLevel);
    if (r.kind === 'native') {
      ck('native module mounted', st.nativeId === 'native-' + r.id, st.nativeId);
    } else {
      ck('correct module document', norm(st.iframeSrc) === r.doc, st.iframeSrc);
      ck('NO auth page inside the panel', !AUTH_PAGE.test(frameUrl || ''), norm(frameUrl));
      ck('no legacy dashboard target', !/dashboard\.html|seller-dashboard/i.test(st.iframeSrc || ''), st.iframeSrc);
    }
    /* SmartPOS must not paint its own bottom bar inside the shell. */
    if (r.doc === 'pos') {
      const dbl = await page.evaluate(() => {
        const f = document.querySelector('.mpanel.show iframe');
        try {
          const d = f && f.contentDocument; if (!d) return 'unreadable';
          const q = d.querySelector('.pos-quick-nav');
          if (!q) return 'absent';
          return getComputedStyle(q).display;
        } catch (e) { return 'cross-origin'; }
      });
      ck('no double bottom navigation (POS quick-nav suppressed)',
         dbl === 'none' || dbl === 'absent', 'pos-quick-nav display=' + dbl);
    }
    /* Returns must reach an HONEST state — never the old generic message. */
    if (r.id === 'returns') {
      const txt = await page.evaluate(() => {
        const f = document.querySelector('.mpanel.show iframe');
        try { const d = f && f.contentDocument; return d ? (d.body.innerText || '').slice(0, 400) : ''; }
        catch (e) { return ''; }
      });
      const generic = /failed to load returns/i.test(txt);
      ck('Returns does NOT show the old generic "Failed to load returns"', !generic,
         txt.replace(/\s+/g, ' ').slice(0, 100));
      if (/no returns yet/i.test(txt))        note('Returns reached EMPTY ("No returns yet")');
      else if (/access|permission|unable|index/i.test(txt)) note('Returns reached an honest ERROR state', txt.replace(/\s+/g, ' ').slice(0, 90));
      else if (/authenticating|sign in/i.test(txt)) note('Returns is gated on a real session (expected headless)', txt.replace(/\s+/g, ' ').slice(0, 90));
    }
  }

  /* ── 4. History ──────────────────────────────────────────────────────────── */
  console.log('\n4. Browser back / forward');
  await page.goBack({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2000);
  let h = await page.evaluate(() => ({ hash: location.hash.replace('#', ''), path: location.pathname,
    title: (document.getElementById('mtitle') || {}).textContent }));
  ck('BACK stays in the shell and changes route', /\/merchant(\.html)?$/.test(h.path) && h.hash === 'orders',
     h.path + '#' + h.hash + ' / ' + h.title);
  await page.goForward({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2000);
  h = await page.evaluate(() => ({ hash: location.hash.replace('#', '') }));
  ck('FORWARD returns to Returns', h.hash === 'returns', '#' + h.hash);

  /* ── 5. Errors, attributed per document ──────────────────────────────────── */
  console.log('\n5. Console / page errors (per-frame attribution, env noise filtered)');
  const errs = [];
  for (const f of page.frames()) {
    try { (await f.evaluate(() => (window.__skErrors || []).splice(0))).forEach((e) => errs.push(e)); } catch (_) {}
  }
  const resourceErrs = errs.filter((e) => e.k === 'resource');
  const real = errs.filter((e) => e.k !== 'resource' && !ENV_NOISE.test(e.m) && !ENV_NOISE.test(e.src || ''));
  if (resourceErrs.length) note(resourceErrs.length + ' resource load failure(s) — expected headless (App Check / auth-gated assets)', resourceErrs[0].m);
  ck('no real page errors', real.length === 0,
     real.slice(0, 2).map((e) => (e.doc || '?') + ': ' + e.m).join(' | ') || (errs.length + ' env-noise only'));

  await browser.close();
  console.log('\n' + '='.repeat(76));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + warn + ' note(s)');
  console.log('  SMOKE: ' + (fail ? 'FAIL' : 'PASS'));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke error:', e && e.message); process.exit(1); });
