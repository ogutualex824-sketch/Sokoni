/* Authenticated seller-onboarding harness.

   Earlier attempts to reach seller.html all landed on /login, and I tried to
   solve it by suppressing redirects — which meant every probe was measuring
   the login page while appearing to measure seller.html. That is how the
   category handlers nearly got reported as undefined when they were simply
   never loaded.

   The actual gate is client-side: auth-guard.js checks
   localStorage.loggedIn === 'true' and a parseable sokoniUser. Seeding those
   BEFORE any script runs satisfies the guard honestly rather than defeating
   it, so the page initialises the way it does for a signed-in merchant.

   WHAT THIS DOES AND DOES NOT PROVE
   It reproduces the CLIENT runtime: script order, initialisation, exceptions,
   whether window.swSelectCat is assigned, whether the inline onclick runs.
   It does NOT carry a real Firebase ID token, so any Firestore or callable
   that requires request.auth will fail. Those failures are expected here and
   are reported separately so they are never mistaken for the defect. */
'use strict';
const { webkit, chromium, devices } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const T = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
            '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  let f = path.join('.', p);
  if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html';
  fs.readFile(f, (e, d) => {
    if (e) { r.writeHead(404); return r.end('nf'); }
    r.writeHead(200, { 'Content-Type': T[path.extname(f)] || 'text/plain' });
    r.end(d);
  });
});

const SEED = () => {
  try {
    localStorage.setItem('loggedIn', 'true');
    localStorage.setItem('sokoniUser', JSON.stringify({
      uid: 'HARNESS_MERCHANT', name: 'Harness Merchant',
      email: 'harness@example.test', phone: '+254700000000', role: 'seller',
    }));
    localStorage.setItem('sokoniAgeVerified', 'true');
    sessionStorage.setItem('sokoniAgeVerified', 'true');
  } catch (e) {}
};

(async () => {
  await new Promise((res) => srv.listen(0, res));
  const B = 'http://127.0.0.1:' + srv.address().port;

  for (const [name, engine] of [['WebKit (mobile Safari)', webkit], ['Chromium', chromium]]) {
    console.log('\n══════ ' + name + ' ══════');
    const br = await engine.launch();
    const ctx = await br.newContext(name.startsWith('WebKit') ? { ...devices['iPhone 13'] } : {});
    await ctx.addInitScript(SEED);
    const page = await ctx.newPage();

    const errors = [], consoleErr = [], netFail = [];
    page.on('pageerror', (e) => errors.push({ n: e.name, m: e.message, s: (e.stack || '').split('\n')[1] || '' }));
    page.on('console', (m) => { if (m.type() === 'error') consoleErr.push(m.text().slice(0, 150)); });
    page.on('requestfailed', (r) => netFail.push(r.url().split('?')[0].slice(-70)));
    page.on('response', (r) => { if (r.status() >= 400) netFail.push('HTTP ' + r.status() + ' ' + r.url().split('?')[0].slice(-60)); });

    await page.goto(B + '/seller.html', { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForTimeout(9000);

    const state = await page.evaluate(() => {
      const out = {};
      out.landedOn = location.pathname;               /* did the guard bounce us? */
      out.title = document.title;
      out.swSelectCat = typeof window.swSelectCat;    /* the question */
      out.swData = (typeof swData !== 'undefined') ? 'in scope' : 'NOT in scope';
      out.catCards = document.querySelectorAll('[onclick*="swSelectCat"]').length;

      /* Does the inline handler actually run, and does state update? */
      const card = document.querySelector('[onclick*="swSelectCat"]');
      out.cardFound = !!card;
      if (card && typeof window.swSelectCat === 'function') {
        try {
          card.click();
          out.clickThrew = false;
          out.gotSelClass = card.classList.contains('sel');
          out.stateAfter = (typeof swData !== 'undefined' && swData) ? JSON.stringify(swData).slice(0, 90) : 'n/a';
        } catch (e) { out.clickThrew = e.message; }
      }

      /* Script execution order — which of the page's own scripts ran? */
      out.scriptTags = document.querySelectorAll('script').length;
      out.swController = navigator.serviceWorker && navigator.serviceWorker.controller
        ? navigator.serviceWorker.controller.scriptURL.slice(-40) : 'none';
      return out;
    }).catch((e) => ({ evalError: e.message }));

    /* cleanUrls:true rewrites /seller.html to /seller, so both are the seller
       page. Comparing against the .html form alone reported a false BOUNCE on
       a page that had plainly loaded — the kind of wrong-subject reading this
       harness exists to prevent. */
    const onSeller = /^\/seller(\.html)?$/.test(state.landedOn);
    console.log('  landed on     ' + state.landedOn + (onSeller ? '   ✓ guard satisfied' : '   ✗ BOUNCED to ' + state.landedOn));
    console.log('  title         ' + state.title);
    console.log('  swSelectCat   ' + state.swSelectCat);
    console.log('  swData        ' + state.swData);
    console.log('  category cards ' + state.catCards);
    if (state.cardFound) {
      console.log('  click threw   ' + (state.clickThrew === false ? 'no' : state.clickThrew));
      console.log('  .sel applied  ' + state.gotSelClass);
      console.log('  state after   ' + state.stateAfter);
    }
    console.log('  scripts       ' + state.scriptTags + '   SW: ' + state.swController);

    console.log('\n  FIRST 5 JS EXCEPTIONS');
    errors.length ? errors.slice(0, 5).forEach((e, i) =>
      console.log('    ' + (i + 1) + '. ' + e.n + ': ' + e.m.slice(0, 95) + (e.s ? '\n       ' + e.s.trim().slice(0, 90) : '')))
      : console.log('    none');

    console.log('\n  FIRST 5 CONSOLE ERRORS');
    consoleErr.length ? consoleErr.slice(0, 5).forEach((c, i) => console.log('    ' + (i + 1) + '. ' + c))
      : console.log('    none');

    console.log('\n  NETWORK FAILURES (expected: no real ID token)');
    netFail.length ? [...new Set(netFail)].slice(0, 5).forEach((n) => console.log('    ' + n))
      : console.log('    none');

    await br.close();
  }

  srv.close();
})();
