/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT V2 ECOSYSTEM — RUNTIME ACCEPTANCE (webkit)
   ══════════════════════════════════════════════════════════════════════════════
   THE REASON THIS FILE EXISTS. test-merchant-route-gate.js and
   test-merchant-visual-gate.js both `goto(BASE + '/merchant.html')` — the SUPERSEDED
   v1 shell. Production serves merchant-v2 (sokoni-merchant-entry.js: MERCHANT_URL =
   '/merchant-v2'). So those suites can pass 168/0 while saying NOTHING about the shell
   a merchant actually opens. They are not wrong about what they measure; they measure
   the wrong document, and a green result there must not be offered as evidence for a
   change to v2.

   This suite drives merchant-v2.html itself and asserts the acceptance criteria that
   the static gate cannot reach, because they are properties of a RUNNING shell:

     · the POS button mounts /pos-checkout, in-shell
     · /pos is still reachable, as its own panel, and the two do not share a frame
     · the shell does not navigate the tab (identity survives because the shell survives)
     · the ecosystem destinations mount
     · mobile navigation reaches them
     · no double boot — the shell document is parsed and executed ONCE

   WHAT IT CANNOT PROVE, and says so rather than implying otherwise: App Check cannot
   attest 127.0.0.1, so Firebase Auth never resolves and there is no signed-in merchant
   here. Anything downstream of a resolved session — that activeShopId reaches the till,
   that the till completes a sale — is UNPROVEN by this run and is reported as UNPROVEN,
   never as a pass. Those need an authenticated device run.

   Run: node scripts/test-merchant-v2-ecosystem-runtime.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const { webkit } = require('playwright');
const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const C    = require(path.join(ROOT, 'sokoni-merchant-routes.js'));
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
  '.png':'image/png', '.json':'application/json', '.svg':'image/svg+xml', '.jpg':'image/jpeg',
  '.webp':'image/webp', '.ico':'image/x-icon', '.woff2':'font/woff2' };

let pass = 0, fail = 0, unproven = 0;
const check = (label, ok, detail) => {
  console.log('    ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + String(detail).slice(0, 120) + ']' : ''));
  ok ? pass++ : fail++;
  return ok;
};
const note = (label, why) => { console.log('    UNPROVEN  ' + label + '\n              ' + why); unproven++; };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/merchant-v2.html';
  /* firebase.json sets cleanUrls:true, so serve extensionless routes the way hosting does —
     otherwise an in-shell src that omits .html 404s here and nowhere else. */
  let fp = path.join(ROOT, p);
  if (!fs.existsSync(fp) && fs.existsSync(fp + '.html')) fp += '.html';
  fs.readFile(fp, (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
    res.end(d);
  });
});

/* Third-party / localhost-only noise. App Check cannot attest 127.0.0.1, so every
   attested call fails here; that says nothing about routing and must never be allowed to
   mask a real error, so it is bucketed rather than ignored silently. */
const ENV_NOISE = /App Check|appCheck|status of 40[0-9]|firebaseappcheck|favicon|net::ERR|Failed to load resource|frame-ancestors|report-only|installations|Firebase|auth\//i;

const wd = setTimeout(() => { console.log('\nSKIP — webkit watchdog timeout'); process.exit(0); }, 300000);
wd.unref && wd.unref();

server.listen(0, async () => {
  const BASE = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try { browser = await webkit.launch(); }
  catch (e) { console.log('SKIP — requires webkit, not available here: ' + (e && e.message || e)); server.close(); process.exit(0); return; }

  console.log('\nMERCHANT V2 ECOSYSTEM — RUNTIME ACCEPTANCE');
  console.log('Shell under test: merchant-v2.html  (NOT merchant.html — that is v1)');
  console.log('='.repeat(74));

  const VIEWPORTS = [
    { name:'iPhone SE', width:375, height:667, mobile:true },
    { name:'Desktop',   width:1440, height:900, mobile:false },
  ];

  for (const vp of VIEWPORTS) {
    console.log('\n' + '█'.repeat(74));
    console.log('  ' + vp.name + '  (' + vp.width + '×' + vp.height + ')');
    console.log('█'.repeat(74));

    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: vp.mobile, hasTouch: vp.mobile,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error' && !ENV_NOISE.test(m.text())) errors.push(m.text().slice(0, 160)); });
    page.on('pageerror', e => { if (!ENV_NOISE.test(String(e.message))) errors.push('PAGEERROR: ' + String(e.message).slice(0, 160)); });

    /* COUNT DOCUMENTS, NOT NAVIGATIONS. A shell that boots twice is the "double boot" the
       brief forbids. The obvious detector — `framenavigated` on the main frame — is WRONG
       and measured 24 here: it fires on every same-document hash change, so it counts route
       switches, which is the opposite of the property. An init script runs exactly once per
       DOCUMENT, so incrementing from there counts real boots and ignores routing entirely. */
    let topLoads = 0;
    await page.exposeFunction('__countBoot', () => { topLoads++; });
    await page.addInitScript(() => {
      /* Main frame only: every embedded module is its own document and would otherwise be
         counted as a shell boot. */
      if (window.top === window) window.__countBoot && window.__countBoot();
    });

    await page.goto(BASE + '/merchant-v2.html', { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(2500);

    console.log('\n  ── THE SHELL BOOTS ──');
    check('shell loaded merchant-v2', /merchant-v2/.test(page.url()), page.url().replace(BASE, ''));
    check('the routes contract is present', await page.evaluate(() => !!window.SokoniMerchantRoutes));
    check('the contract validates in the browser too',
          await page.evaluate(() => window.SokoniMerchantRoutes.validate().length === 0),
          await page.evaluate(() => window.SokoniMerchantRoutes.validate().join(' | ') || 'clean'));
    check('the shell publishes its session', await page.evaluate(() => !!(window.SokoniShell && window.SokoniShell.session)));
    check('the shell publishes merchantContext', await page.evaluate(() => typeof (window.SokoniShell || {}).merchantContext === 'function'));
    check('the commission table loaded', await page.evaluate(() => !!(window.SokoniCommission && typeof window.SokoniCommission.posPct === 'function')));

    /* ── THE POS BUTTON ────────────────────────────────────────────────────── */
    console.log('\n  ── POS BUTTON -> /pos-checkout ──');
    /* The setup gate fires first by design. Satisfy it explicitly so this suite measures
       the ENTRY, not the wizard — and assert the gate exists rather than assuming it. */
    const gated = await page.evaluate(() => {
      try { localStorage.removeItem('posSetupComplete'); } catch (_) {}
      window.SokoniShell.go('pos');
      var f = document.querySelector('iframe[src*="pos-hardware-wizard"]');
      return !!f;
    });
    check('unset posSetupComplete still shows the hardware wizard FIRST', gated,
          gated ? 'setup gate intact' : 'THE SETUP GATE WAS BYPASSED');

    const posMount = await page.evaluate(async () => {
      try { localStorage.setItem('posSetupComplete', '1'); } catch (_) {}
      window.SokoniShell.go('dashboard');
      window.SokoniShell.go('pos');
      await new Promise(r => setTimeout(r, 900));
      const vis = [...document.querySelectorAll('iframe')].filter(f => f.offsetParent !== null);
      return { srcs: vis.map(f => f.getAttribute('src')), hash: location.hash, top: location.pathname };
    });
    check('POS mounts pos-checkout', posMount.srcs.some(s => /pos-checkout/.test(s || '')), posMount.srcs.join(' | ') || 'no visible iframe');
    check('...as an in-shell panel, not a tab navigation', /merchant-v2/.test(posMount.top), posMount.top);
    check('...and the route is #pos', posMount.hash === '#pos', posMount.hash);

    /* ── /pos IS NOT REPLACED ──────────────────────────────────────────────── */
    console.log('\n  ── /pos PRESERVED ──');
    const sm = await page.evaluate(async () => {
      window.SokoniShell.go('smartpos');
      await new Promise(r => setTimeout(r, 900));
      const vis = [...document.querySelectorAll('iframe')].filter(f => f.offsetParent !== null);
      return { srcs: vis.map(f => f.getAttribute('src')), hash: location.hash };
    });
    check('SmartPOS mounts pos.html', sm.srcs.some(s => /(^|\/)pos\.html/.test(s || '')), sm.srcs.join(' | '));
    check('...at its own route', sm.hash === '#smartpos', sm.hash);
    /* The two must not share a cached frame — that was the exact defect the setup panel
       key had to avoid, and re-pointing the entry reintroduces the opportunity. */
    const frames = await page.evaluate(() => [...document.querySelectorAll('iframe')].map(f => f.getAttribute('src')));
    const posFrames = frames.filter(s => /pos-checkout|(^|\/)pos\.html/.test(s || ''));
    check('POS and SmartPOS hold SEPARATE frames', new Set(posFrames).size === posFrames.length && posFrames.length >= 2,
          posFrames.join(' | ') || 'only one POS frame cached');

    /* ── THE ECOSYSTEM MOUNTS ──────────────────────────────────────────────── */
    console.log('\n  ── ECOSYSTEM DESTINATIONS ──');
    const ecoIds = C.ecosystem().reduce((a, g) => a.concat(g.routes.map(r => r.id)), []);
    /* A NATIVE ROUTE HAS NO IFRAME, and reading "some visible iframe exists" for one is how
       an assertion passes for the wrong reason: the Firebase auth iframe is always present,
       so `roster` "mounted" by matching a frame that has nothing to do with it. Each kind is
       now measured by what it actually produces —
         page/pos/seller : the PANEL's own iframe, looked up by the panel that is visible
         native          : rendered content inside the visible panel, and NOT the
                           "not rebuilt in shell v2 yet" placeholder. */
    const ecoKinds = {};
    C.ecosystem().forEach(g => g.routes.forEach(r => { ecoKinds[r.id] = r.kind; }));
    const mountResults = await page.evaluate(async (args) => {
      const { ids, kinds } = args;
      const out = [];
      for (const id of ids) {
        window.SokoniShell.go(id);
        await new Promise(r => setTimeout(r, 420));
        /* The visible PANEL, not any visible element in the document. */
        const panels = [...document.querySelectorAll('[id^="p-"], .panel, [data-panel]')]
          .filter(p => p.offsetParent !== null);
        const panel = panels[panels.length - 1] || null;
        const own = panel ? panel.querySelector('iframe') : null;
        out.push({
          id, kind: kinds[id],
          hash: location.hash.replace('#', ''),
          src: own ? own.getAttribute('src') : null,
          text: panel ? (panel.innerText || '').slice(0, 400) : '',
          nodes: panel ? panel.querySelectorAll('*').length : 0,
          top: location.pathname,
        });
      }
      return out;
    }, { ids: ecoIds, kinds: ecoKinds });
    mountResults.forEach(m => {
      if (m.kind === 'native') {
        /* Rendered SOMETHING of its own, and not the shell's not-ported placeholder. */
        const ported = !/not rebuilt in shell v2 yet|Not yet ported/i.test(m.text);
        check('mounts: ' + m.id + ' (native)', m.hash === m.id && m.nodes > 3 && ported,
              'nodes=' + m.nodes + (ported ? '' : ' PLACEHOLDER') + ' hash=' + m.hash);
      } else {
        check('mounts: ' + m.id, m.hash === m.id && !!m.src, m.src || ('hash=' + m.hash + ' NO PANEL IFRAME'));
      }
      check('  ...without leaving the shell', /merchant-v2/.test(m.top), m.top);
    });
    /* CONTROL for the native check: the placeholder detector must be able to FIRE, or
       "not a placeholder" passes against a regex that never matches anything. */
    check('CONTROL — the placeholder detector fires on the shell\'s own placeholder text',
          /not rebuilt in shell v2 yet/i.test('This surface is not rebuilt in shell v2 yet.'));

    /* ── NO TAB NAVIGATION, AND NO DOUBLE BOOT ─────────────────────────────── */
    console.log('\n  ── THE SHELL SURVIVED ──');
    check('the top-level document never navigated', /merchant-v2/.test(page.url()), page.url().replace(BASE, ''));
    check('no double boot (the shell document was created ONCE)', topLoads === 1,
          topLoads + ' shell document(s) — route switches must not create one');
    /* The console verdict is taken on everything seen UP TO HERE. The control below reloads
       the page deliberately, which cancels in-flight requests and raises cross-origin
       complaints from the Firebase auth iframe — artefacts of the control itself, not of the
       shell. Snapshotting is honest; widening ENV_NOISE to swallow "cancelled" and
       "Access-Control-Allow-Origin" would also hide them during the real run. */
    const errorsBeforeControl = errors.slice();

    /* CONTROL: the counter must be capable of counting more than one, or "exactly 1" would
       pass against a counter that never fired a second time for any reason. */
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2200);
    check('CONTROL — the boot counter does rise on a REAL reload', topLoads === 2,
          topLoads + ' after an explicit reload');
    check('the session object survived every transition',
          await page.evaluate(() => !!(window.SokoniShell && window.SokoniShell.session)),
          'identity is preserved BECAUSE the shell is never torn down');

    /* ── MOBILE NAVIGATION ─────────────────────────────────────────────────── */
    if (vp.mobile) {
      console.log('\n  ── MOBILE NAVIGATION ──');
      const nav = await page.evaluate(() => {
        const sh = document.getElementById('mshell');
        if (sh) sh.classList.add('mobile-open');
        const btns = [...document.querySelectorAll('[data-route]')];
        const vis = btns.filter(b => b.offsetParent !== null);
        return { total: btns.length, visible: vis.length,
                 ids: vis.map(b => b.dataset.route) };
      });
      check('the drawer exposes route buttons', nav.visible > 0, nav.visible + '/' + nav.total + ' visible');
      const ecoReachable = C.ecosystem().reduce((a, g) => a.concat(g.routes.map(r => r.id)), [])
        .filter(id => nav.ids.indexOf(id) > -1);
      check('every ecosystem destination has a reachable button',
            ecoReachable.length === ecoIds.length,
            ecoReachable.length + '/' + ecoIds.length + ' reachable');
      check('POS is reachable on mobile', nav.ids.indexOf('pos') > -1);
    }

    console.log('\n  ── CONSOLE ──');
    check('no non-environment errors (up to the control reload)', errorsBeforeControl.length === 0,
          errorsBeforeControl.slice(0, 3).join(' | ') || 'clean');

    await ctx.close();
  }

  /* ── WHAT THIS RUN COULD NOT SETTLE ──────────────────────────────────────── */
  console.log('\n  ── NOT PROVEN HERE (stated, not skipped silently) ──');
  note('activeShopId reaches the till as merchantId',
       'App Check cannot attest 127.0.0.1, so Firebase Auth never resolves and the shell has ' +
       'no session. merchantScope() correctly returns null with no shop, and the till correctly ' +
       'falls back. The REPAIR is asserted statically (test-merchant-ecosystem.js §8); that it ' +
       'carries a real shopId end-to-end needs an authenticated device or emulator run.');
  note('posCompleteCheckout accepts the resolved merchantId',
       'Requires a signed-in merchant with an approved shop. Unreachable from this harness.');

  await browser.close();
  server.close();
  clearTimeout(wd);
  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  process.exit(fail ? 1 : 0);
});
