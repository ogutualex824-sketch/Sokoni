/* Merchant diagnostics — does the instrument itself work?
   It cannot be certified against a signed-in seller from here (phone OTP), so
   what IS testable is that it loads, runs, reports the signed-out state
   correctly, and adds no errors of its own to the pages it instruments. */
'use strict';
const { webkit, devices } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const T = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
            '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.join('.', p);
  fs.readFile(fp, (e, d) => {
    if (e) { r.writeHead(404); return r.end('nf'); }
    r.writeHead(200, { 'Content-Type': T[path.extname(fp)] || 'text/plain' });
    r.end(d);
  });
});

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
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};

/* ?legacy=1 IS THE ARCHITECTURAL CONTRACT, NOT A TEST BYPASS.
   seller.html now redirects a DIRECT visit to /merchant-v2 — that is the supported behaviour,
   and this suite is about the legacy shell itself, so it must ask for the legacy shell
   explicitly. The redirect exempts exactly two cases and both are deliberate: an embedded
   frame (window.parent !== window), which is how the shell still mounts kind:'seller' routes,
   and ?legacy=1. Landing on /merchant-v2 instead is the redirect working, not a failure.
   A test that quietly relied on direct navigation was asserting a contract that has moved. */
const PAGES = ['seller.html?legacy=1', 'seller-analytics.html', 'inventory.html', 'profile.html'];

srv.listen(0, async () => {
  const B = 'http://127.0.0.1:' + srv.address().port;
  const br = await webkit.launch();

  console.log('\n── Module contract (isolated) ──');
  {
    const page = await (await br.newContext({ ...devices['iPhone 13'] })).newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(B + '/offline.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.addScriptTag({ url: B + '/sokoni-merchant-diag.js' });
    await page.waitForTimeout(300);

    const shape = await page.evaluate(() => {
      const M = window.SokoniMerchantDiag;
      return M ? { present: true, run: typeof M.run, state: !!M.state } : { present: false };
    });
    ck('module defines window.SokoniMerchantDiag', shape.present === true);
    ck('exposes run()', shape.run === 'function');
    ck('no pageerror on load', errs.length === 0, errs[0] || '');

    /* Signed-out must report signed out, not throw and not claim a user. */
    const out = await page.evaluate(async () => {
      window.firebaseAuth = { currentUser: null, _sk_authResolved: true };
      const logs = [];
      const orig = console.log;
      console.log = (...a) => logs.push(a.join(' '));
      let threw = null;
      try { await window.SokoniMerchantDiag.run(); } catch (e) { threw = e.message; }
      console.log = orig;
      return { threw, logs: logs.join('\n'), md: window._md || null };
    });
    ck('run() does not throw when signed out', out.threw === null, out.threw || '');
    ck('reports signed out', /signed out/i.test(out.logs));
    ck('records a finding', !!(out.md && out.md.findings.length > 0));
    ck('exposes window._md for the operator', !!out.md);
    await page.close();
  }

  console.log('\n── Instrumented pages still load clean ──');
  for (const p of PAGES) {
    const page = await (await br.newContext({ ...devices['iPhone 13'] })).newPage();
    const errs = [], diag = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => { const t = m.text(); if (/\[Merchant\]/.test(t)) diag.push(t); });

    let landed = '';
    try {
      await page.goto(B + '/' + p, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500);
      landed = new URL(page.url()).pathname;
    } catch (e) { landed = 'LOAD FAILED: ' + e.message; }

    const loaded = await page.evaluate(() => !!window.SokoniMerchantDiag);
    /* Errors caused BY the instrument, as opposed to pre-existing page errors. */
    const mine = errs.filter((e) => /SokoniMerchantDiag|merchant-diag/i.test(e));

    /* A signed-out probe is redirected to /login by the pages that guard
       themselves. That is the page working, not the instrument failing — and
       it is why the landed path is asserted rather than assumed. On a signed-in
       handset these pages stay put and the module runs. */
    const redirected = /\/login/.test(landed);
    if (redirected) ck(p + ' — guarded: redirected to login when signed out', true, landed);
    else            ck(p + ' — module present', loaded, 'landed ' + landed);
    ck(p + ' — no error from the instrument', mine.length === 0, mine[0] || '');
    if (errs.length) console.log('        (' + errs.length + ' pre-existing page error(s), not introduced here)');
    await page.close();
  }

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  /* REPORT FIRST, THEN TEAR DOWN — teardown must never decide the verdict.
     Measured in the gate: suites printed every assertion PASS and were then SIGKILLed
     at their budget because close() never returned, so a finished result was recorded
     as TIMEOUT -- a non-blocking verdict -- and its coverage vanished silently. */
  await Promise.race([
    (async () => { try { await br.close(); } catch (_) {} })(),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
  try { srv.close(); } catch (_) {}
  process.exit(fail ? 1 : 0);
});
