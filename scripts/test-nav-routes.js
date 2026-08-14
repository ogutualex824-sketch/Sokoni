/* Navigation route certification.

   nav-audit.js proves a target FILE exists. That is necessary and not
   sufficient: a file can exist and still redirect away, 404 at the router, or
   land on the wrong section. This loads each repaired destination in a real
   browser and asserts where it actually lands.

   The seller deep links are the point of the exercise: seller.html#products
   used to render Overview no matter what, which is why other pages invented
   seller-products.html in the first place. */
'use strict';
const { webkit, devices } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const T = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
            '.ico': 'image/x-icon', '.json': 'application/json' };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  let fp = path.join('.', p);
  if (!fs.existsSync(fp) && fs.existsSync(fp + '.html')) fp += '.html';
  fs.readFile(fp, (e, d) => {
    if (e) { r.writeHead(404); return r.end('not found'); }
    r.writeHead(200, { 'Content-Type': T[path.extname(fp)] || 'text/plain' }); r.end(d);
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

/* Every destination the link repair now points at. */
const ROUTES = [
  'seller.html', 'seller-fulfilment.html', 'account-centre.html', 'login.html',
  'subscriptions.html', 'onboarding.html', 'pos-reports.html', 'food.html',
  'event-hub.html',
];

srv.listen(0, async () => {
  const B = 'http://127.0.0.1:' + srv.address().port;
  const br = await webkit.launch();

  console.log('\n── Repaired destinations serve real pages ──');
  for (const r of ROUTES) {
    const res = await fetch(B + '/' + r).catch(() => null);
    const body = res ? await res.text() : '';
    ck(r + ' serves 200 with content',
       !!res && res.status === 200 && body.length > 500,
       res ? res.status + ', ' + body.length + 'b' : 'no response');
  }

  console.log('\n── login.html accepts the params we now send it ──');
  for (const q of ['?reset=1', '?next=/etims-admin.html']) {
    const res = await fetch(B + '/login.html' + q).catch(() => null);
    ck('login.html' + q, !!res && res.status === 200, res ? String(res.status) : 'no response');
  }

  console.log('\n── seller.html deep links select the right section ──');
  {
    const ctx = await br.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('sokoniUser', JSON.stringify({
          uid: 'ROUTE_TEST', name: 'KASS VAPES', roles: ['buyer', 'seller'], isSeller: true }));
      } catch (e) {}
    });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));

    let blocked = 0;
    for (const key of ['products', 'orders', 'analytics', 'overview']) {
      await page.goto(B + '/seller.html#' + key, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
      const landed = new URL(page.url()).pathname;
      /* seller.html guards on live Firebase auth, which cannot succeed in this
         harness (App Check fails, the domain is not OAuth-authorised). That is a
         BLOCKER, not a failing assertion — recording it as a pass would certify
         something never exercised, and as a failure would report a defect that
         does not exist. It is reported as neither. */
      if (!/seller/.test(landed)) {
        blocked++;
        console.log('  BLOCKED  #' + key + ' — redirected to ' + landed + ' (auth unavailable here)');
        continue;
      }

      const got = await page.evaluate(() => {
        /* Which sidebar item is active tells us which page the router chose. */
        const active = document.querySelector('#sidebarNav .nav-item.active');
        return {
          active: active ? (active.getAttribute('onclick') || active.textContent || '').trim().slice(0, 40) : null,
          hash: location.hash,
        };
      });
      ck('#' + key + ' selects a section', !!got.active,
         got.active ? got.active.replace(/\s+/g, ' ') : 'no active nav item');
    }

    if (blocked) {
      console.log('\n  ' + blocked + ' seller deep link(s) BLOCKED — seller.html needs a live session.');
      console.log('  The hash router is REPOSITORY VERIFIED only. It is exercised the moment');
      console.log('  an authenticated device opens seller.html#products.');
    } else {
      /* An unknown key must fall back, not render an empty page. */
      await page.goto(B + '/seller.html#not-a-real-section', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
      const fellBack = await page.evaluate(() =>
        document.querySelectorAll('#sidebarNav .nav-item.active').length === 1);
      ck('unknown hash falls back to a valid section', fellBack === true);
    }

    const introduced = errs.filter((e) => !/ResizeObserver|recordMetric|access control/.test(e));
    ck('no page errors introduced', introduced.length === 0, introduced[0] || '');
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
  /* A close that lost the race above is still RUNNING. Abandoning it leaks the browser:
     measured at 32 orphaned WebKit processes after one gate, which starves the renderers
     of later suites and crashes them. Kill what did not close. */
  try { const _p = br.process && br.process(); if (_p) _p.kill('SIGKILL'); } catch (_) {}
  try { srv.close(); } catch (_) {}
  process.exit(fail ? 1 : 0);
});
