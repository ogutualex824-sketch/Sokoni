/* ══════════════════════════════════════════════════════════════════════════════
   EXIT CONTRACT — RUNTIME
   ══════════════════════════════════════════════════════════════════════════════
   The static gate and the mutation controls both reason about the SOURCE of
   merchant-v2.html. This one boots it in a real browser, because a shell whose
   navigation primitive was just rewritten owes proof that it still starts and
   that the primitive actually behaves — a refactor that reads correctly and
   throws on load is still a broken shell.

   Proves, on webkit:
     1. the shell boots with no page error and no route error
     2. the ONLY exit it performs resolves through the contract — navigating to
        route 'home' really does leave to '/', via leaveShell
     3. a session-terminating exit composes '/login?next=/merchant-v2' from the
        contract — no '.html', no hardcoded literal
     4. the shell never reaches an auth destination on boot (the escalation that
        threw a merchant out mid-session)

   The sign-out button itself needs a signed-in merchant, so this does NOT claim
   to have exercised it. It proves the primitive it now goes through.

   Run: node scripts/test-merchant-exit-runtime.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const { webkit } = require('playwright');
const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
                '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png' };

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

/* Noise that says nothing about the exit contract: this run is unauthenticated and
   offline, so Firebase/App Check/CORS failures are expected and not the subject. */
const NOISE = /Access-Control-Allow-Origin|Failed to load resource|appcheck|App Check|firebase|FirebaseError|net::|ERR_|Unable to load|installations|401|403|CORS/i;

(async () => {
  console.log('\nEXIT CONTRACT — RUNTIME');
  console.log('='.repeat(78));

  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    /* cleanUrls:true in production — mirror it so /merchant-v2 resolves like live. */
    let file = path.join(ROOT, p);
    if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;

  const browser = await webkit.launch();
  const page = await browser.newPage({ viewport: { width: 393, height: 852 } });

  const errors = [], pageErrors = [];
  page.on('console', m => { if (m.type() === 'error' && !NOISE.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', e => { if (!NOISE.test(String(e))) pageErrors.push(String(e)); });

  /* Every top-level navigation the shell attempts, captured instead of followed. */
  const navAttempts = [];
  await page.route('**/*', route => {
    const r = route.request();
    if (r.isNavigationRequest() && r.frame() === page.mainFrame() && !r.url().startsWith(BASE + '/merchant-v2')) {
      navAttempts.push(r.url().replace(BASE, ''));
      return route.abort();
    }
    return route.continue();
  });

  console.log('\n1. The shell boots');
  await page.goto(BASE + '/merchant-v2', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3500);

  check('no uncaught page error', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ') || 'clean');
  check('no route/console error', errors.length === 0, errors.slice(0, 3).join(' | ') || 'clean');
  check('the shell rendered its chrome', await page.locator('[data-route]').count() > 0,
        (await page.locator('[data-route]').count()) + ' route controls');
  check('boot performed NO navigation to an auth destination',
        !navAttempts.some(u => /login|signin|auth/i.test(u)),
        navAttempts.length ? navAttempts.join(',') : 'no navigation attempted');

  console.log('\n2. The contract composes the exit targets (no literals, no .html)');
  const composed = await page.evaluate(() => {
    const C = window.SokoniMerchantRoutes;
    if (!C) return null;
    return C.ROUTES.filter(r => r.kind === 'exit')
      .map(r => ({ id: r.id, href: r.href, next: r.next || null,
                   term: !!r.terminatesSession,
                   target: r.href + (r.next ? '?next=' + r.next : '') }));
  });
  check('the contract is loaded in the page', !!composed, composed ? composed.length + ' exit routes' : 'MISSING');
  const so = (composed || []).find(e => e.id === 'signout');
  check('signout composes /login?next=/merchant-v2', !!so && so.target === '/login?next=/merchant-v2',
        so ? so.target : 'MISSING');
  check('...and terminates the session', !!so && so.term === true);
  check('no exit target contains .html', (composed || []).every(e => !/\.html/.test(e.target)),
        (composed || []).map(e => e.target).join(' '));

  /* The composed target must actually resolve on a cleanUrls host, or the merchant
     signs back in and lands on a 404. Verified against the same server. */
  const nextOk = await page.evaluate(async (base) => {
    const r = await fetch(base + '/merchant-v2', { method: 'GET' });
    return r.status;
  }, BASE);
  check('the next= destination resolves under cleanUrls', nextOk === 200, 'HTTP ' + nextOk);

  console.log('\n3. The exit primitive really navigates, and only for exit routes');
  navAttempts.length = 0;
  await page.evaluate(() => window.__mgo('home'));
  await page.waitForTimeout(1200);
  check('navigating to the "home" exit route leaves the shell to /',
        navAttempts.includes('/'), navAttempts.join(',') || 'no navigation attempted');

  navAttempts.length = 0;
  errors.length = 0;
  await page.evaluate(() => window.__mgo('dashboard'));
  await page.waitForTimeout(800);
  check('a non-exit route performs NO navigation', navAttempts.length === 0,
        navAttempts.join(',') || 'none');

  await browser.close();
  await new Promise(r => server.close(r));

  console.log('\n' + '='.repeat(78));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('='.repeat(78) + '\n');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('\nHARNESS ERROR:', e && e.message); process.exit(1); });
