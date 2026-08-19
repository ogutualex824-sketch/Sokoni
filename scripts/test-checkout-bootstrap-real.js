/* ══════════════════════════════════════════════════════════════════════════════
   CHECKOUT BOOTSTRAP — the REAL scripts, no injected callable
   ══════════════════════════════════════════════════════════════════════════════
   This suite exists because test-checkout-journey passed 37/0 while the live
   page could not create a single payment intent. That suite injects
   window.sokoniCallable via addInitScript — it was PROVIDING the very dependency
   production was missing, so a page that shipped without its Firebase bootstrap
   looked perfectly healthy.

   Nothing is injected here. No stub, no fake callable, no route interception of
   the bootstrap. The page loads its own <script> tags and must produce a real
   window.sokoniCallable by itself. If it cannot, this fails — which is exactly
   what should have happened before the last deploy.

   It deliberately does NOT call any function: no network, no payment, no
   production write. The question is only whether the callable LAYER is reachable
   from the shipped markup.

   Run: node scripts/test-checkout-bootstrap-real.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);

console.log('\nCHECKOUT BOOTSTRAP — real scripts, nothing injected');
console.log('='.repeat(74));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.json': 'application/json', '.mjs': 'text/javascript' };

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (e) {
    un('the entire bootstrap check', 'playwright unavailable: ' + String(e.code || e.message).slice(0, 50));
    console.log('\n  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven\n');
    process.exit(0);
  }

  head('1 - the shipped markup declares its bootstrap');
  const src = fs.readFileSync(path.join(ROOT, 'subscription-checkout.html'), 'utf8');
  ck('security.js', src.indexOf('security.js') > -1);
  ck('sokoni-init.js as a MODULE',
     /<script[^>]*type="module"[^>]*src="sokoni-init\.js"|<script[^>]*src="sokoni-init\.js"[^>]*type="module"/.test(src));
  ck('auth-guard.js', src.indexOf('auth-guard.js') > -1);
  ck('the checkout WAITS for the bootstrap, bounded', /function whenReady\(/.test(src));
  ck('...rather than rejecting instantly',
     src.indexOf("Promise.reject(new Error('SOKONI is still starting up.'))") === -1);

  head('2 - a failure is traceable and safe to show');
  ck('every attempt carries a reference', /var CHK = 'CHK-'/.test(src));
  ck('the merchant sees the reference, not a raw error',
     src.indexOf('Reference: ') > -1 && src.indexOf("esc(S.error || '')") === -1);
  ck('the real error goes to the console with its stage',
     /console\.error\('\[checkout\] ' \+ CHK \+ ' failed at ' \+ stage/.test(src));
  ck('both failure paths report a stage',
     /report\('load', e\)/.test(src) && /report\('pay:'/.test(src));

  /* Serve the repo exactly as hosting would. */
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = path.join(ROOT, p.replace(/^\/+/, ''));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  /* The ONLY thing injected: a signed-in marker, because auth-guard redirects a
     signed-out visitor and a checkout is an authenticated surface. This supplies
     a SESSION, never a dependency — auth-guard.js:31-33 reads these. */
  await page.addInitScript(`
    try {
      localStorage.setItem('loggedIn', 'true');
      localStorage.setItem('sokoniUser', JSON.stringify({ uid: 'zzz_bootstrap_probe' }));
    } catch (e) {}
  `);

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
  const failedRequests = [];
  page.on('requestfailed', (r) => failedRequests.push(r.url().replace(BASE, '') + ' ' +
    ((r.failure() && r.failure().errorText) || '')));

  head('3 - the page reaches the REAL callable layer');
  await page.goto(BASE + '/subscription-checkout.html?planId=seller_basic&cycle=monthly',
                  { waitUntil: 'domcontentloaded' });

  let becameAvailable = false;
  try {
    await page.waitForFunction("typeof window.sokoniCallable === 'function'", null, { timeout: 20000 });
    becameAvailable = true;
  } catch (_) { becameAvailable = false; }

  ck('window.sokoniCallable exists, supplied by the SHIPPED scripts',
     becameAvailable, becameAvailable ? 'function' : 'never appeared within 20s');
  ck('...and it is callable, not a placeholder',
     becameAvailable && await page.evaluate("typeof window.sokoniCallable('createPaymentIntent') === 'function'")
       .catch(() => false));
  ck('the page did NOT redirect away', /subscription-checkout/.test(page.url()), page.url().replace(BASE, ''));

  head('4 - the scripts it needs actually loaded');
  for (const s of ['security.js', 'sokoni-init.js', 'auth-guard.js', 'sokoni-subscription-checkout.js']) {
    const missing = failedRequests.filter((f) => f.indexOf(s) > -1);
    ck(s + ' loaded', missing.length === 0, missing.join(', ') || 'ok');
  }
  ck('SokoniSubscriptionCheckout is present',
     await page.evaluate("typeof window.SokoniSubscriptionCheckout === 'object'").catch(() => false));

  head('5 - NEGATIVE CONTROL: this suite would catch the defect it exists for');
  /* Re-run against a page stripped of its bootstrap. If sokoniCallable still
     appeared, this suite would be proving nothing. */
  const stripped = src.replace(/<script[^>]*src="sokoni-init\.js"[^>]*><\/script>/, '')
                      .replace(/<script[^>]*src="security\.js"[^>]*><\/script>/, '');
  fs.writeFileSync(path.join(ROOT, '__bootstrap_probe.html'), stripped);
  const probe = await ctx.newPage();
  await probe.addInitScript("try{localStorage.setItem('loggedIn','true');localStorage.setItem('sokoniUser','{\"uid\":\"x\"}');}catch(e){}");
  await probe.goto(BASE + '/__bootstrap_probe.html?planId=seller_basic', { waitUntil: 'domcontentloaded' });
  let strippedHas = true;
  try { await probe.waitForFunction("typeof window.sokoniCallable === 'function'", null, { timeout: 6000 }); }
  catch (_) { strippedHas = false; }
  ck('NC without the bootstrap, sokoniCallable NEVER appears',
     strippedHas === false, strippedHas ? 'it appeared anyway — this suite proves nothing' : 'absent, as it must be');
  await probe.close();
  fs.unlinkSync(path.join(ROOT, '__bootstrap_probe.html'));

  if (consoleErrors.length) {
    head('console errors observed (reported, not judged)');
    consoleErrors.slice(0, 6).forEach((e) => console.log('    ' + e));
  }

  await page.close();
  await browser.close();
  await new Promise((r) => server.close(r));

  head('6 - what this does NOT prove');
  un('that a callable SUCCEEDS against production', 'nothing was called; no network, no payment');
  un('a real M-PESA STK prompt', 'needs a handset and a real payment');

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  console.log('='.repeat(74) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  Bootstrap check aborted: ' + (e && e.stack) + '\n'); process.exit(1); });
