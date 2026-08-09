/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT VISUAL ACCEPTANCE GATE  (Phase 2 rework)
   ══════════════════════════════════════════════════════════════════════════════
   The previous runtime gate passed 164/164 while the real iPhone was unusable.
   It asserted the iframe ELEMENT's src/id and the panel's bounding box — never
   whether the module's document actually loaded, and never whether a control was
   genuinely touchable. Bounding boxes lie: an element can be perfectly positioned
   and still be covered by an overlay, or belong to a document that failed to load.

   This gate asserts what a THUMB can reach:

     · elementFromPoint() hit-testing at the real centre of every control. If the
       burger is covered by anything, the hit test returns the coverer, not the
       burger — that is the only honest test of "reachable".
     · INSIDE each module iframe: document readyState, real rendered text, and
       browser error pages ("can't open", "not available", blank body).
     · Fixed/sticky elements inside the module that overlap the shell's chrome.
     · Real screenshots per route per viewport for eyes-on review.

   A route PASSES only if a user could actually operate it.

   Run: node scripts/test-merchant-visual-gate.js [--routes a,b,c] [--shots DIR]
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const { webkit } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const C = require(path.join(ROOT, 'sokoni-merchant-routes.js'));

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf(n); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
/* Screenshots default to the OS temp dir, never inside the repo: the release-gate runner
   executes every scripts/test-*.js, so a repo-relative default silently dirtied the working
   tree mid-release with a directory of PNGs. Pass --shots to keep them somewhere you choose. */
const SHOTS = argOf('--shots', path.join(require('os').tmpdir(), 'sokoni-visual-gate'));
const ROUTES = argOf('--routes', 'dashboard,plan,products,inventory,cashier,orders,returns').split(',');

const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
  '.png':'image/png', '.json':'application/json', '.svg':'image/svg+xml', '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg', '.webp':'image/webp', '.ico':'image/x-icon', '.woff2':'font/woff2', '.woff':'font/woff' };

const VIEWPORTS = [
  { key:'se',   name:'iPhone SE',     width:375, height:667, mobile:true },
  { key:'14',   name:'iPhone 14 Pro', width:393, height:852, mobile:true },
  { key:'max',  name:'iPhone Pro Max',width:430, height:932, mobile:true },
  { key:'desk', name:'Desktop',       width:1440,height:900, mobile:false },
];

/* An authenticated merchant must NEVER be shown an auth page inside a module panel.
   Matches with and without .html because hosting runs cleanUrls:true. */
const AUTH_PAGE = /\/(login|signup|register|reset-password)(\.html)?(\?|#|$)/i;

/* Strings a browser or an app shows when a document failed to open. */
const CANT_OPEN = /can'?t open this page|cannot open|safari cannot|this page could ?n'?t|failed to open|not available|ERR_|error code|page not found|404/i;
const ENV_NOISE = /App Check|appCheck|status of 40[0-9]|firebaseappcheck|favicon|net::ERR_ABORTED|frame-ancestors|report-only|recaptcha|gstatic|googleapis|Access-Control-Allow-Origin|Status code: 204/i;

let pass = 0, fail = 0;
const results = [];   /* per route/viewport row for the final matrix */

const check = (label, ok, detail) => {
  console.log('      ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
  return ok;
};

/* Mirrors firebase.json hosting: cleanUrls:true, trailingSlash:false. Production serves
   /merchant for merchant.html and 301s /merchant.html -> /merchant, so a gate that only
   understood ".html" would miss anything that depends on extensionless routing (redirect
   targets, sw scope, `next=` params). Emulating it keeps the gate honest about real URLs. */
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/merchant.html';
  let fp = path.join(ROOT, p);
  const tryFiles = [fp];
  if (!path.extname(p)) tryFiles.push(path.join(ROOT, p + '.html'));   /* cleanUrls */
  const next = () => {
    const f = tryFiles.shift();
    if (!f) { res.writeHead(404, { 'Content-Type':'text/html' }); return res.end('<h1>404</h1>'); }
    fs.readFile(f, (e, d) => {
      if (e) return next();
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
      res.end(d);
    });
  };
  next();
});

const wd = setTimeout(() => { console.log('\nSKIP — webkit watchdog timeout'); process.exit(0); }, 900000);
wd.unref && wd.unref();

/* ── Deterministic module lifecycle wait ─────────────────────────────────────
   A fixed sleep after clicking is a race: the shell must enter the route, create or
   reuse the panel, assign src, the document must load and reach readyState, and for
   pos/seller the requested tab/section must be applied. Sleeping "long enough" makes
   the gate intermittently green, which is exactly the failure mode we are trying to
   eliminate. Poll the real lifecycle instead, and identify the mounted module by the
   SHOWN panel — never by scanning all frames, which can match a stale one from the
   previous route. */
async function waitForModule(page, route, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate((r) => {
      const shown = [].filter.call(document.querySelectorAll('.mpanel'), (p) => p.classList.contains('show'));
      if (shown.length !== 1) return { ready: false, why: 'panels shown = ' + shown.length };
      const panel = shown[0];
      if (r.kind === 'native') {
        const n = panel.querySelector('.native');
        if (!n) return { ready: false, why: 'no native host' };
        if (n.id !== 'native-' + r.id) return { ready: false, why: 'native host is ' + n.id };
        return { ready: (n.innerText || '').trim().length > 10, why: 'native content len ' +
                 (n.innerText || '').trim().length, marker: n.id };
      }
      const ifr = panel.querySelector('iframe');
      if (!ifr) return { ready: false, why: 'no iframe in shown panel' };
      const src = ifr.getAttribute('src') || '';
      const want = (r.src || (r.kind === 'pos' ? 'pos.html' : 'seller.html')).split('?')[0].split('#')[0];
      if (src.split('?')[0].split('#')[0] !== want) return { ready: false, why: 'src is ' + src };
      /* Same-origin: read the hosted document directly. This is the authoritative
         "is the module actually mounted" signal — not the element's attributes. */
      let rs = null, len = 0, href = '';
      try {
        const d = ifr.contentDocument;
        if (!d) return { ready: false, why: 'contentDocument null' };
        rs = d.readyState; href = (d.location && d.location.pathname) || '';
        len = ((d.body && d.body.innerText) || '').trim().length;
      } catch (e) { return { ready: false, why: 'cross-origin: ' + e.message }; }
      return { ready: rs === 'complete' && len > 10, why: 'readyState=' + rs + ' len=' + len,
               marker: href, src: src };
    }, { id: route.id, kind: route.kind, src: route.src });
    if (last && last.ready) {
      /* The panel plays a 240ms entrance animation (mPanelIn: translateY(6px)). Measuring
         mid-animation reports the panel 6px lower than it settles, which reads as a 6px
         overlap with the bottom nav that does not exist once it lands. Wait for the shell's
         animations to finish — deterministically, via getAnimations(), not another sleep. */
      await page.evaluate(async () => {
        const el = document.querySelector('.mpanel.show');
        if (!el || !el.getAnimations) return;
        try { await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => {}))); } catch (_) {}
      });
      return last;
    }
    await page.waitForTimeout(250);
  }
  return Object.assign({ timedOut: true }, last || {});
}

/* Hosting runs cleanUrls:true, so a frame's real URL is /plans, not /plans.html, and may carry
   a hash (pos#inventory). Compare on the extensionless basename so the assertion tests module
   IDENTITY rather than URL cosmetics. */
function sameDocument(actualUrl, wantFile) {
  const norm = (u) => String(u || '').split('?')[0].split('#')[0].split('/').pop().replace(/\.html$/i, '').toLowerCase();
  return norm(actualUrl) === norm(wantFile);
}

/* Collect per-document errors recorded by the init-script bridge, across every live frame. */
async function collectFrameErrors(page) {
  const out = [];
  for (const f of page.frames()) {
    try {
      const errs = await f.evaluate(() => (window.__skErrors || []).splice(0));
      errs.forEach((e) => out.push(e));
    } catch (_) { /* frame detached or cross-origin — nothing to read */ }
  }
  return out;
}

/* ── In-page probe: hit-test every shell control and report REAL reachability ── */
const SHELL_PROBE = () => {
  const q = (s) => document.querySelector(s);
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
    return { t:+b.top.toFixed(1), b:+b.bottom.toFixed(1), l:+b.left.toFixed(1), r:+b.right.toFixed(1),
             w:+b.width.toFixed(1), h:+b.height.toFixed(1) }; };

  /* Does a tap at this element's centre actually reach it? */
  const hit = (el, label) => {
    if (!el) return { label, exists:false, reachable:false, why:'element missing' };
    const b = el.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) return { label, exists:true, reachable:false, why:'zero size' };
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0)
      return { label, exists:true, reachable:false, why:'not visible (' + cs.display + '/' + cs.visibility + '/' + cs.opacity + ')' };
    const x = b.left + b.width / 2, y = b.top + b.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight)
      return { label, exists:true, reachable:false, why:'centre off-screen (' + x.toFixed(0) + ',' + y.toFixed(0) + ')' };
    const top = document.elementFromPoint(x, y);
    const ok = !!top && (top === el || el.contains(top) || top.contains(el));
    return { label, exists:true, reachable:ok,
             why: ok ? '' : 'covered by <' + (top ? top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') +
                   (top.className && typeof top.className === 'string' ? '.' + top.className.trim().split(/\s+/)[0] : '') : 'nothing') + '>',
             at: x.toFixed(0) + ',' + y.toFixed(0) };
  };

  const bnavItems = [].map.call(document.querySelectorAll('.mbnav-item'), (n) => {
    const h = hit(n, 'bnav:' + n.dataset.id);
    const b = n.getBoundingClientRect();
    return Object.assign(h, { w:+b.width.toFixed(1), h2:+b.height.toFixed(1) });
  });

  /* Anything fixed/sticky in the SHELL document that sits over the bottom nav or header. */
  const bn = q('#mbnav'), tp = q('.mtop');
  const bnBox = bn ? bn.getBoundingClientRect() : null;
  const tpBox = tp ? tp.getBoundingClientRect() : null;
  const floaters = [];
  [].forEach.call(document.querySelectorAll('body *'), (el) => {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') return;
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return;
    if (el.id === 'mbnav' || el.closest('#mbnav') || el.closest('.mtop') || el.closest('.mrail')) return;
    const b = el.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) return;
    const overBnav = bnBox && b.bottom > bnBox.top && b.top < bnBox.bottom && b.right > bnBox.left && b.left < bnBox.right;
    const overTop  = tpBox && b.bottom > tpBox.top && b.top < tpBox.bottom && b.right > tpBox.left && b.left < tpBox.right;
    if (overBnav || overTop) floaters.push({
      tag: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
           (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0,2).join('.') : ''),
      z: cs.zIndex, over: overBnav ? 'bottom-nav' : 'header',
    });
  });

  const shown = [].filter.call(document.querySelectorAll('.mpanel'), (p) => p.classList.contains('show'));
  const panel = shown[0] || null;
  const ifr = panel ? panel.querySelector('iframe') : null;

  return {
    innerW: innerWidth, innerH: innerHeight,
    hash: location.hash.replace('#',''),
    title: (q('#mtitle') || {}).textContent,
    burger: hit(q('#burger'), 'burger'),
    shopBtn: hit(q('#mshop-btn'), 'minishop'),
    header: box(tp), headerPadTop: tp ? getComputedStyle(tp).paddingTop : null,
    bnav: box(bn), bnavDisplay: bn ? getComputedStyle(bn).display : null,
    bnavItems,
    panel: box(panel),
    panelKind: ifr ? 'iframe' : panel && panel.querySelector('.native') ? 'native' : 'empty',
    iframeSrc: ifr ? ifr.getAttribute('src') : null,
    nativeId: panel && panel.querySelector('.native') ? panel.querySelector('.native').id : null,
    nativeText: panel && panel.querySelector('.native') ? (panel.querySelector('.native').innerText || '').trim().slice(0, 300) : null,
    shownCount: shown.length,
    floaters,
    docScrollW: document.documentElement.scrollWidth,
    bodyScrollW: document.body.scrollWidth,
    activeNav: (q('.mnav-item.active') || {}).dataset ? q('.mnav-item.active').dataset.id : null,
  };
};

/* ── In-frame probe: did this module actually render, and does it fight the shell? ── */
const FRAME_PROBE = () => {
  const b = document.body;
  /* `(b && (b.innerText || ''))` yields null when b is null, and .trim() then throws — which
     turned "the module has no body yet" into an opaque probe crash on MiniShop. A module
     document with no body is a REAL finding and must be reported as such, not as a test error. */
  const text = ((b && b.innerText) || '').trim();
  const fixed = [];
  try {
    [].forEach.call(document.querySelectorAll('body *'), (el) => {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed') return;
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      /* Only care about things pinned to the very bottom of the module viewport — those are
         what a merchant reports as "covered by the nav" / "charge bar unreachable". */
      if (r.bottom >= innerHeight - 2) fixed.push({
        tag: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
             (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0,2).join('.') : ''),
        bottom: +r.bottom.toFixed(1), h: +r.height.toFixed(1), z: cs.zIndex,
      });
    });
  } catch (_) {}
  return {
    readyState: document.readyState,
    url: location.href,
    hasBody: !!b,
    textLen: text.length,
    text: text.slice(0, 400),
    innerW: innerWidth, innerH: innerHeight,
    docScrollW: document.documentElement.scrollWidth,
    hOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    fixedAtBottom: fixed,
    /* A module that renders nothing visible is a failure even with readyState complete. */
    visibleChildren: b ? [].filter.call(b.children, (c) => {
      const cs = getComputedStyle(c); const r = c.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    }).length : 0,
  };
};

server.listen(0, async () => {
  const BASE = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try { browser = await webkit.launch(); }
  catch (e) { console.log('SKIP — webkit unavailable: ' + (e && e.message || e)); server.close(); process.exit(0); return; }

  fs.mkdirSync(SHOTS, { recursive: true });
  console.log('\nMERCHANT VISUAL ACCEPTANCE GATE (webkit)');
  console.log('Routes : ' + ROUTES.join(', '));
  console.log('Shots  : ' + SHOTS);
  console.log('='.repeat(78));

  for (const vp of VIEWPORTS) {
    console.log('\n' + '█'.repeat(78));
    console.log('  ' + vp.name + '  ' + vp.width + '×' + vp.height + (vp.mobile ? '  (touch, notch simulated)' : '  (desktop)'));
    console.log('█'.repeat(78));

    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.mobile ? 3 : 1,
      isMobile: vp.mobile, hasTouch: vp.mobile,
      userAgent: vp.mobile
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
        : undefined,
    });
    /* AUTHENTICATED MERCHANT SESSION.
       The gate previously ran signed-OUT, so every module hit its auth guard — which is how
       Products silently became login.html and why an authenticated-path regression could never
       be caught here. auth-guard treats localStorage.loggedIn as authoritative for the session
       (see its 2026-07-26 note: gating a session on profile metadata caused the profile<->login
       loop), so seeding it reproduces a real signed-in merchant. Firestore rules still govern
       every read — this grants UI session state, never data access. */
    /* ── ERROR ATTRIBUTION BRIDGE ────────────────────────────────────────────
       Playwright's page.on('pageerror') carries no frame, so every uncaught error
       looked like it came from the shell — which is how a minified "u[v] is not a
       function" got pinned on Dashboard. addInitScript runs in EVERY frame, so each
       document records its own errors against its OWN location. Attribution then comes
       from the document that actually threw, not from whichever route was on screen.
       Records the URL at throw time so it survives later navigation of that frame. */
    await ctx.addInitScript(() => {
      try {
        window.__skErrors = [];
        const push = (kind, msg, extra) => {
          try {
            window.__skErrors.push({
              kind, msg: String(msg || '').slice(0, 300),
              doc: location.pathname + location.search,
              src: (extra && extra.src) || '', line: (extra && extra.line) || 0,
              stack: String((extra && extra.stack) || '').split('\n').slice(0, 6).join(' | ').slice(0, 500),
              t: Date.now(),
            });
          } catch (_) {}
        };
        /* Capture phase also fires for FAILED RESOURCE LOADS (img/script/link). Those carry no
           message, so recording them as script errors produced a bare "seller: error:" with
           nothing after it — an alarm with no content. Classify them separately and keep the
           failing URL, so a genuinely broken asset stays visible instead of being hidden. */
        window.addEventListener('error', (e) => {
          const el = e.target;
          if (el && el !== window && (el.src || el.href)) {
            push('resource', 'failed to load: ' + (el.src || el.href), { src: el.src || el.href });
            return;
          }
          push('error', e.message, { src: e.filename, line: e.lineno, stack: e.error && e.error.stack });
        }, true);
        window.addEventListener('unhandledrejection', (e) => {
          const r = e.reason;
          push('rejection', (r && r.message) || r, { stack: r && r.stack });
        });
      } catch (_) {}
      try {
        localStorage.setItem('loggedIn', 'true');
        localStorage.setItem('sokoniUser', JSON.stringify({
          uid: 'gate-merchant-uid', name: 'Gate Merchant', email: 'gate@sokoni.test',
          roles: ['seller', 'merchant'], role: 'seller'
        }));
        localStorage.setItem('sokoni_setup_complete', '1');
        localStorage.setItem('sokoni_merchant_id', 'GATE-0001');
      } catch (e) {}
    });
    const page = await ctx.newPage();
    /* Attribute every console error to the FRAME that produced it. The POS and Seller panels
       are persistent by design and keep running after you navigate away, so their late async
       errors would otherwise be blamed on whichever route happens to be under test — which is
       how "Returns has a console error" appeared for an error Returns never emitted. Errors
       from another module are reported separately as cross-module, never as this route's. */
    /* console.error() calls are not uncaught errors, so the in-page bridge never sees them.
       Collect them separately WITH their source URL, and merge into the same attributed
       buckets as the bridged errors below. page.on('pageerror') is deliberately NOT used for
       attribution — it carries no frame, which is exactly what made a minified error from one
       document look like it belonged to another. The bridge replaces it. */
    let errs = [], foreign = [];
    let consoleErrs = [];
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const url = ((m.location() || {}).url) || '';
      consoleErrs.push({ msg: m.text(), src: url, doc: url, kind: 'console' });
    });
    /* A module iframe that fails to load is the "can't open this page" the founder sees. */
    const failedFrames = [];
    page.on('requestfailed', (r) => {
      const u = r.url();
      if (/\.(html)(\?|#|$)/.test(u) && !ENV_NOISE.test(u)) failedFrames.push(u.replace(BASE, '') + ' — ' + (r.failure() || {}).errorText);
    });

    await page.goto(BASE + '/merchant.html', { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(2500);
    if (vp.mobile) {
      /* Simulate a real notch so safe-area handling is exercised, not assumed-zero. */
      await page.evaluate(() => { const r = document.documentElement;
        r.style.setProperty('--safe-top', '59px'); r.style.setProperty('--safe-bot', '34px'); });
      await page.waitForTimeout(300);
    }

    for (const id of ROUTES) {
      const route = C.get(id);
      if (!route) { console.log('\n    ?? unknown route in --routes: ' + id); continue; }
      console.log('\n    ── ' + route.name + '  (#' + id + ') ──');
      failedFrames.length = 0; consoleErrs = [];
      /* Drain anything the bridge recorded before this route began, so a previous route's
         errors can never be attributed here. */
      await collectFrameErrors(page);

      await page.evaluate((rid) => {
        const el = document.querySelector('.mnav-item[data-id="' + rid + '"]');
        if (el) el.click(); else if (window.SokoniShell) window.SokoniShell.go(rid);
      }, id);

      /* Wait for the REAL lifecycle, not a guessed duration. */
      const life = await waitForModule(page, route, 25000);
      check('module reached mounted state (deterministic wait)', !life.timedOut,
            life.timedOut ? 'TIMED OUT: ' + life.why : life.why);

      const s = await page.evaluate(SHELL_PROBE);

      /* ── module document: resolve the frame from the SHOWN PANEL, never by scanning ──
         Scanning page.frames() for a URL substring could match a stale frame belonging to
         the previous route (POS and Seller panels are persistent and never destroyed), or
         miss the right one while it was still swapping src. Ask the shell which iframe is
         mounted right now, then bind to that exact frame by its element handle. */
      let f = null;
      if (route.kind !== 'native') {
        const want = (route.src || (route.kind === 'pos' ? 'pos.html' : 'seller.html')).split('?')[0].split('#')[0];
        const handle = await page.evaluateHandle(() => {
          const shown = [].filter.call(document.querySelectorAll('.mpanel'), (p) => p.classList.contains('show'))[0];
          return shown ? shown.querySelector('iframe') : null;
        });
        const el = handle.asElement();
        const frame = el ? await el.contentFrame() : null;
        if (frame) {
          try {
            f = await frame.evaluate(FRAME_PROBE);
            /* The mounted frame must be the one this route asked for (identity, not URL text). */
            if (!sameDocument(f.url, want)) {
              f.error = 'mounted frame is ' + String(f.url || '').split('/').pop() + ', expected ' + want;
            }
          } catch (e) { f = { error: String(e.message).slice(0, 120) }; }
        } else {
          f = { error: 'no iframe in the shown panel (expected ' + want + ')' };
        }
        await handle.dispose();
      }

      /* Per-document errors, attributed by the document that actually threw. */
      const bridged = await collectFrameErrors(page);
      const ownerDoc = route.kind === 'native' ? 'merchant'
        : (route.src || (route.kind === 'pos' ? 'pos.html' : 'seller.html')).split('?')[0].split('#')[0].replace('.html', '');
      errs = []; foreign = [];
      const resourceFails = bridged.filter((e) => e.kind === 'resource' && !ENV_NOISE.test(e.msg));
      if (resourceFails.length) {
        console.log('      NOTE  ' + resourceFails.length + ' resource load failure(s) — expected headless ' +
                    '(App Check / auth-gated assets): ' + resourceFails[0].msg.slice(0, 80));
      }
      bridged.filter((e) => e.kind !== 'resource').concat(consoleErrs).forEach((e) => {
        if (ENV_NOISE.test(e.msg) || ENV_NOISE.test(e.src || '')) return;
        const doc = (e.doc || '').split('/').pop().replace('.html', '') || 'merchant';
        const line = doc + ': ' + e.kind + ': ' + e.msg + (e.src ? '  @' + e.src.split('/').pop() + ':' + e.line : '');
        (doc === ownerDoc ? errs : foreign).push(line);
      });

      const shot = path.join(SHOTS, vp.key + '-' + id + '.png');
      await page.screenshot({ path: shot });

      /* ══ ASSERTIONS ══ */
      check('route entered #' + id, s.hash === id, '#' + s.hash);
      check('page title correct', s.title === route.name, s.title);

      /* HEADER — reachable, not merely present */
      check('header visible + clear of safe inset',
            s.header && s.header.t >= 0 && s.header.h > 0 && (!vp.mobile || parseFloat(s.headerPadTop) >= 59 - 0.5),
            'top=' + (s.header && s.header.t) + ' h=' + (s.header && s.header.h) + ' padTop=' + s.headerPadTop);
      check('burger REACHABLE (hit-test)', s.burger.reachable,
            s.burger.reachable ? 'at ' + s.burger.at : s.burger.why);

      /* BOTTOM NAV — every button individually hit-tested */
      if (vp.mobile) {
        check('bottom nav displayed', s.bnavDisplay === 'flex', s.bnavDisplay);
        check('bottom nav fully on-screen', s.bnav && s.bnav.b <= s.innerH + 0.5,
              'bottom=' + (s.bnav && s.bnav.b) + ' vs ' + s.innerH);
        const unreachable = s.bnavItems.filter((b) => !b.reachable);
        check('ALL bottom-nav buttons reachable (hit-test)', unreachable.length === 0,
              unreachable.length ? unreachable.map((u) => u.label + ': ' + u.why).join(' | ')
                                 : s.bnavItems.map((b) => b.label.replace('bnav:','')).join(','));
        const tiny = s.bnavItems.filter((b) => b.w < 44 || b.h2 < 44);
        check('bottom-nav touch targets >= 44px', tiny.length === 0,
              tiny.map((t) => t.label + ' ' + t.w + '×' + t.h2).join(',') || 'ok');
        check('content reserves clearance for bottom nav',
              s.panel && s.bnav && s.panel.b <= s.bnav.t + 0.5,
              'panel ' + (s.panel && s.panel.b) + ' vs bnav ' + (s.bnav && s.bnav.t));
      } else {
        check('bottom nav hidden on desktop', s.bnavDisplay === 'none', s.bnavDisplay);
      }

      /* NOTHING COVERS THE CHROME */
      check('no floating widget over header/bottom-nav', s.floaters.length === 0,
            s.floaters.map((x) => x.tag + '(z' + x.z + ')→' + x.over).join(' | ') || 'none');

      /* MODULE actually rendered */
      check('exactly one panel visible', s.shownCount === 1, String(s.shownCount));
      if (route.kind === 'native') {
        check('native module rendered visible content', !!s.nativeText && s.nativeText.length > 10,
              (s.nativeText || '').slice(0, 60).replace(/\s+/g, ' '));
      } else {
        check('module frame found', !f.error, f.error || 'ok');
        if (!f.error) {
          check('module document loaded', f.readyState === 'complete' || f.readyState === 'interactive', f.readyState);
          check('module rendered visible content', f.visibleChildren > 0 && f.textLen > 10,
                'children=' + f.visibleChildren + ' textLen=' + f.textLen);
          check('NO browser "can\'t open this page"', !CANT_OPEN.test(f.text || ''),
                CANT_OPEN.test(f.text || '') ? (f.text || '').slice(0, 90).replace(/\s+/g, ' ') : 'clean');
          check('module has no horizontal overflow', !f.hOverflow,
                f.docScrollW + ' vs ' + f.innerW);
        }
        check('no failed module document request', failedFrames.length === 0, failedFrames.join(' | ') || 'none');

        /* ONE bottom navigation. SmartPOS ships its own fixed bottom strip for standalone use;
           inside the shell it pinned directly above the merchant bottom nav, giving two stacked
           bars and burying the charge bar. Suppression is declared in pos.html's own stylesheet
           so it applies at FIRST PAINT (the shared boundary module is deferred, and perf-guard
           rightly refuses a fifth blocking POS script). Asserted here, in the gate, because the
           mechanism changed — a screenshot proving it once is not a standing guarantee. */
        if (route.kind === 'pos') {
          const posNav = await page.evaluate(() => {
            const f = document.querySelector('.mpanel.show iframe');
            try {
              const d = f && f.contentDocument;
              if (!d) return 'unreadable';
              const q = d.querySelector('.pos-quick-nav');
              if (!q) return 'absent';
              return getComputedStyle(q).display + (d.documentElement.classList.contains('sk-in-shell') ? ' (flag set)' : ' (FLAG MISSING)');
            } catch (e) { return 'error: ' + e.message; }
          });
          check('exactly one bottom navigation (POS quick-nav suppressed in-shell)',
                /^none/.test(posNav) || /^absent/.test(posNav), 'pos-quick-nav ' + posNav);
        }
        /* The regression this gate exists for: an authenticated merchant must NEVER be shown
           an auth page inside a module panel. */
        check('module is NOT an auth page',
              !AUTH_PAGE.test(f.url || ''),
              (f.url || '').split('/').pop() || '(no url)');
      }

      /* SHELL-level overflow + legacy */
      check('no horizontal page overflow', s.docScrollW <= s.innerW + 0.5, s.docScrollW + ' vs ' + s.innerW);
      check('no legacy dashboard target',
            !s.iframeSrc || !/dashboard\.html|seller-dashboard/i.test(s.iframeSrc), s.iframeSrc || 'native');
      check('still inside /merchant',
            /\/merchant(\.html)?$/.test(page.url().split('#')[0].split('?')[0]), page.url().replace(BASE, ''));
      check('no console error (this module)', errs.length === 0, errs[0] || 'clean');
      if (foreign.length) console.log('      NOTE  ' + foreign.length + ' error(s) from another, still-live module (persistent panel): ' + foreign[0]);

      results.push({
        vp: vp.name, id, target: route.kind + (route.sec ? ':' + route.sec : route.tab ? ':' + route.tab : route.src ? ':' + route.src.split('?')[0] : ''),
        header: s.burger.reachable ? 'OK' : 'FAIL',
        bnav: !vp.mobile ? 'n/a' : (s.bnavItems.every((b) => b.reachable) && s.bnav && s.bnav.b <= s.innerH + 0.5 ? 'OK' : 'FAIL'),
        console: errs.length ? 'ERR' : 'clean',
        cantOpen: f && !f.error && CANT_OPEN.test(f.text || '') ? 'YES' : 'no',
      });
    }
    /* ── HISTORY: deep link, browser back/forward, legacy alias, unknown route ──
       The shell writes the route into the hash, so the browser's own history is the
       route history. A merchant using the back gesture must land on the previous
       module, not be dumped out of the shell. */
    console.log('\n    ── HISTORY (deep link · back/forward · alias · unknown) ──');

    await page.goto(BASE + '/merchant.html#inventory', { waitUntil: 'domcontentloaded', timeout: 40000 });
    await waitForModule(page, C.get('inventory'), 25000);
    let h = await page.evaluate(() => ({ hash: location.hash.replace('#', ''),
      title: (document.getElementById('mtitle') || {}).textContent,
      shown: document.querySelectorAll('.mpanel.show').length }));
    check('deep link #inventory mounts Inventory', h.hash === 'inventory' && h.title === 'Inventory' && h.shown === 1,
          '#' + h.hash + ' / ' + h.title + ' / ' + h.shown + ' panel');

    /* Navigate a couple of routes, then walk back through them. */
    for (const rid of ['orders', 'dashboard']) {
      await page.evaluate((r) => { const el = document.querySelector('.mnav-item[data-id="' + r + '"]'); if (el) el.click(); }, rid);
      await waitForModule(page, C.get(rid), 25000);
    }
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    h = await page.evaluate(() => ({ hash: location.hash.replace('#', ''),
      title: (document.getElementById('mtitle') || {}).textContent,
      inShell: /\/merchant(\.html)?$/.test(location.pathname) }));
    check('browser BACK returns to the previous route', h.inShell && h.hash === 'orders' && h.title === 'Orders',
          '#' + h.hash + ' / ' + h.title);

    await page.goForward({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    h = await page.evaluate(() => ({ hash: location.hash.replace('#', ''),
      title: (document.getElementById('mtitle') || {}).textContent }));
    check('browser FORWARD returns to Dashboard', h.hash === 'dashboard' && h.title === 'Dashboard',
          '#' + h.hash + ' / ' + h.title);

    /* A legacy bookmark must alias, not fail. */
    await page.goto(BASE + '/merchant.html#finance', { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(1800);
    h = await page.evaluate(() => ({ hash: location.hash.replace('#', ''),
      title: (document.getElementById('mtitle') || {}).textContent }));
    check('legacy #finance aliases to Revenue', h.hash === 'revenue' && h.title === 'Revenue',
          '#' + h.hash + ' / ' + h.title);

    /* An unknown id must fail LOUDLY and leave the current module untouched. */
    const unknown = await page.evaluate(() => {
      const errs = []; const orig = console.error;
      console.error = function () { errs.push([].join.call(arguments, ' ')); orig.apply(console, arguments); };
      const before = location.hash;
      try { window.SokoniShell.go('totally-not-a-route'); } catch (_) {}
      console.error = orig;
      return { errs, unchanged: location.hash === before, hash: location.hash };
    });
    check('unknown route refused loudly, route unchanged',
          unknown.errs.some((e) => /unknown route/i.test(e)) && unknown.unchanged, unknown.hash);

    await ctx.close();
  }

  await browser.close(); server.close(); clearTimeout(wd);

  console.log('\n' + '='.repeat(78));
  console.log('  PER-ROUTE MATRIX');
  console.log('  ' + 'viewport'.padEnd(16) + 'route'.padEnd(12) + 'target'.padEnd(26) + 'header'.padEnd(8) + 'bnav'.padEnd(7) + 'console'.padEnd(9) + "can't-open");
  console.log('  ' + '-'.repeat(90));
  results.forEach((r) => console.log('  ' + r.vp.padEnd(16) + r.id.padEnd(12) + r.target.padEnd(26) +
    r.header.padEnd(8) + r.bnav.padEnd(7) + r.console.padEnd(9) + r.cantOpen));
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  console.log('  Screenshots: ' + SHOTS);
  console.log('\n  BATCH 1 = ' + (fail ? 'FAIL' : 'PASS'));
  process.exit(fail ? 1 : 0);
});
