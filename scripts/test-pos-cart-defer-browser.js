/* ══════════════════════════════════════════════════════════════════════════════
   POS CART DEFER — REAL BROWSER EVIDENCE
   ------------------------------------------------------------------------------
   Track 2.6 put sokoni-cart.js on every page carrying shared-header.js. On pos.html that
   made a FIFTH blocking script, over perf-guard's baseline of 4, and the deploy was
   correctly refused. The fix under test is `defer` on that one tag.

   Whether that is safe turns on one question: does shared-header.js read window.SokoniCart
   while it EXECUTES (in which case a deferred service is not there yet), or later, at
   DOMContentLoaded (in which case it is, because deferred scripts run before that event)?

   THREE NODE SIMULATIONS FAILED TO ANSWER IT — each disproved the model rather than the
   code: document.body was the wrong trigger, "has a DOMContentLoaded listener" was the
   wrong probe (the header registers one for the splash regardless), and a getter on
   window.SokoniCart recorded nothing because _inject never completes in a DOM shim. A shim
   faithful enough to run it IS a browser, so this runs one.

   The page is instrumented BEFORE any of its scripts execute:
     · window.SokoniCart is replaced with an accessor that records every read, tagged with
       document.readyState at that moment
     · script execution is timestamped via PerformanceObserver-free means: a load listener
       on each <script> would be too late, so the accessor tag is the evidence

   Assertions, not screenshots.

     node scripts/test-pos-cart-defer-browser.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');
const http = require('http');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8791;

let pass = 0, fail = 0;
/* Shorter than this suite's runner budget (150000ms) ON PURPOSE. Without one, a hang is
   SIGKILLed by the runner and recorded as TIMEOUT -- not a defect verdict -- so the suite leaves
   the blocking set silently. Measured cost of this suite is far below the value chosen, so this
   fires only when the runner was going to kill it anyway. */
const _wd = setTimeout(() => { console.log('\n  WATCHDOG — suite exceeded 135s'); process.exit(1); }, 135000);
/* unref: the watchdog must never be the reason the process stays alive. A suite that
   finishes normally exits immediately; one that is genuinely stuck still has a live event
   loop, so the timer still fires and self-reports instead of being SIGKILLed silently. */
if (_wd && _wd.unref) _wd.unref();
const failures = [];
const ok = (l, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + l); return true; }
  fail++; failures.push(l + (d ? '  → ' + d : ''));
  console.log('  FAIL  ' + l + (d ? '   → ' + d : ''));
  return false;
};
const head = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
               '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp' };

/* A plain static server over the REAL repo. No bundling, no rewriting — the page under
   test must be the file that ships. */
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url || '/').split('?')[0]);
      let file = path.join(ROOT, url === '/' ? 'index.html' : url.replace(/^\/+/, ''));
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    srv.listen(PORT, () => resolve(srv));
  });
}

(async function run() {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (e) {
    console.error('\n  playwright is required for this probe: npm i -D playwright\n');
    process.exit(2);
  }

  const server = await serve();
  let browser;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext();

    /* Seed a REAL cart before the page loads, so the badge has something to render. */
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('cart', JSON.stringify([
          { id: 'p1', name: 'Unga 2kg', price: 250, qty: 3 },
          { id: 'p2', name: 'Sukari', price: 180, qty: 2 },
        ]));
        localStorage.setItem('loggedIn', 'true');
      } catch (e) { }
    });

    /* Instrument BEFORE any page script runs. The accessor records every read of
       window.SokoniCart together with document.readyState at that instant — which is
       exactly the ordering question, measured rather than argued. */
    await ctx.addInitScript(() => {
      window.__cartReads = [];
      window.__cartDefinedAt = null;
      let val;
      Object.defineProperty(window, 'SokoniCart', {
        configurable: true,
        get() {
          window.__cartReads.push({ readyState: document.readyState, t: Date.now() });
          return val;
        },
        set(v) {
          val = v;
          if (window.__cartDefinedAt === null) {
            window.__cartDefinedAt = { readyState: document.readyState, t: Date.now() };
          }
        },
      });
      document.addEventListener('DOMContentLoaded', () => { window.__dclAt = Date.now(); });
    });

    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));

    await page.goto('http://localhost:' + PORT + '/pos.html', { waitUntil: 'load', timeout: 45000 });
    /* Give DOMContentLoaded handlers a beat to run. */
    await page.waitForTimeout(1200);

    const ev = await page.evaluate(() => ({
      reads: window.__cartReads || [],
      definedAt: window.__cartDefinedAt,
      dclAt: window.__dclAt || null,
      cartPresent: typeof window.SokoniCart === 'object' && window.SokoniCart !== null,
      units: (() => { try { return window.SokoniCart ? window.SokoniCart.units() : null; } catch (e) { return 'ERR'; } })(),
      /* The badge shared-header renders. Any of the known pip selectors. */
      badge: (() => {
        const el = document.querySelector('#skCartCount, .sk-cart-count, [data-cart-count], .cart-pip, #cartCount');
        return el ? (el.textContent || '').trim() : null;
      })(),
      headerPresent: !!document.querySelector('nav, header, .sk-nav, #skNav'),
    }));

    head('A · what the browser actually did');
    console.log('    SokoniCart defined at readyState : ' + (ev.definedAt ? ev.definedAt.readyState : '(never)'));
    console.log('    reads of SokoniCart              : ' + ev.reads.length);
    ev.reads.slice(0, 6).forEach((r, i) =>
      console.log('      read #' + (i + 1) + ' at readyState=' + r.readyState));
    console.log('    DOMContentLoaded observed        : ' + (ev.dclAt ? 'yes' : 'no'));
    console.log('    badge text                       : ' + JSON.stringify(ev.badge));
    console.log('    SokoniCart.units()               : ' + JSON.stringify(ev.units));
    console.log('');

    ok('the page loaded without a script error',
       pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
    ok('sokoni-cart.js executed and defined window.SokoniCart', !!ev.definedAt);
    ok('the service was defined by DOMContentLoaded at the latest',
       !!ev.definedAt && ev.definedAt.readyState !== 'complete',
       'defined at readyState=' + (ev.definedAt && ev.definedAt.readyState));

    head('B · the ordering question, measured');
    const readsWhileLoading = ev.reads.filter((r) => r.readyState === 'loading').length;
    ok('the header did NOT read the cart while the document was still parsing',
       readsWhileLoading === 0,
       readsWhileLoading + ' read(s) at readyState=loading — a deferred service would be absent');
    ok('the cart WAS read (the probe is observing something real)',
       ev.reads.length > 0, 'zero reads — the probe would prove nothing');
    ok('every read happened at or after DOMContentLoaded',
       ev.reads.every((r) => r.readyState !== 'loading'));

    head('C · the badge renders from a real cart');
    ok('SokoniCart is usable on the loaded page', ev.cartPresent);
    ok('units() reports the seeded cart (3 + 2 = 5)', ev.units === 5, String(ev.units));
    ok('the header rendered', ev.headerPresent);
    if (ev.badge !== null) {
      ok('the badge shows the unit count', ev.badge === '5', JSON.stringify(ev.badge));
    } else {
      console.log('  NOTE  no badge element found on pos.html — the POS header may not render a pip.');
      console.log('        The ordering assertions above stand on their own; the badge check is');
      console.log('        reported rather than silently skipped.');
    }

    head('D · no race across repeated loads');
    let raced = 0;
    for (let i = 0; i < 3; i++) {
      const p2 = await ctx.newPage();
      await p2.goto('http://localhost:' + PORT + '/pos.html', { waitUntil: 'load', timeout: 45000 });
      await p2.waitForTimeout(800);
      const r = await p2.evaluate(() => ({
        early: (window.__cartReads || []).filter((x) => x.readyState === 'loading').length,
        defined: !!window.__cartDefinedAt,
        units: (() => { try { return window.SokoniCart ? window.SokoniCart.units() : null; } catch (e) { return 'ERR'; } })(),
      }));
      if (r.early > 0 || !r.defined || r.units !== 5) raced++;
      await p2.close();
    }
    ok('three further loads show the same ordering (no race)', raced === 0,
       raced + ' of 3 loads differed');

    head('E · the control — the case the assertion protects');
    /* Prove the probe can DETECT an early read: load a page that executes the header while
       readyState is not "loading" is hard to synthesise, so instead assert the mechanism
       directly from the page: the header's gate is readyState-based. */
    const gate = fs.readFileSync(path.join(ROOT, 'shared-header.js'), 'utf8');
    ok('the header gates its injection on document.readyState',
       /if \(document\.readyState === 'loading'\)\s*\{\s*document\.addEventListener\('DOMContentLoaded', _inject\);/.test(gate));
    ok('...and injects immediately otherwise (so a non-blocking header WOULD need order)',
       /\}\s*else\s*\{\s*_inject\(\);/.test(gate));

    await browser.close();
  } catch (e) {
    console.error('\n  probe error: ' + (e && e.message));
    fail++; failures.push('probe error: ' + (e && e.message));
  } finally {
    server.close();
  }

  console.log('\n' + '─'.repeat(70));
  if (fail) { console.log('\x1b[31mFAILURES\x1b[0m'); failures.forEach((f) => console.log('  ✗ ' + f)); }
  console.log((fail ? '\x1b[31m' : '\x1b[32m') + 'pos cart defer (browser): ' + pass + '/' + (pass + fail) + '\x1b[0m');
    /* REPORT FIRST, THEN TEAR DOWN — teardown must never decide the verdict.
       Measured in the gate: suites printed every assertion PASS and were then SIGKILLed
       at their budget because close() never returned, so a finished result was recorded
       as TIMEOUT -- a non-blocking verdict -- and its coverage vanished silently. */
    await Promise.race([
      (async () => { try { await browser.close(); } catch (_) {} })(),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
  process.exit(fail ? 1 : 0);
})();
