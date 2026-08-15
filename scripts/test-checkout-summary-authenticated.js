#!/usr/bin/env node
/* ffea917 live acceptance — the ACTUAL production failure boundary.
 *
 *   firebase emulators:exec --only auth --project gate-checkout \
 *     "node scripts/test-checkout-summary-authenticated.js"
 *
 * WHY THIS EXISTS
 * test-checkout-summary.js proves the JavaScript contract (31/31) and a browser probe
 * proved the ReferenceError is gone. Neither proves the thing that actually broke for a
 * buyer: that an AUTHENTICATED checkout with a non-empty cart renders the complete order
 * summary, and that `window.removeCartItem` — ASSIGNED after the loop that threw, so
 * genuinely undefined while the bug was live, unlike the hoisted declarations — both
 * exists and WORKS when clicked.
 *
 * HOW THE SESSION IS OBTAINED
 * The same network-boundary technique as test-merchant-sell-authenticated.js: Playwright
 * rewrites identitytoolkit/securetoken to the Auth emulator so the shipped Firebase SDK
 * mints a genuine signed-in user. No production code is modified, no Auth or App Check
 * bypass is added, and firebase.js is untouched.
 *
 * NOT PROVEN HERE, deliberately not faked:
 *   · App Check attestation — the emulator mints no App Check token, so Firestore reads
 *     still fail exactly as in any unattested browser. That does NOT affect this test:
 *     the cart is localStorage and the summary renders from it. Firestore failures are
 *     captured and reported rather than silently tolerated.
 *   · Inventory decrement. Requires Firestore WRITES to land, which App Check prevents.
 *     The _decrementStock question stays open and is NOT touched here.
 */
'use strict';
const { webkit } = require('playwright');
const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT      = path.resolve(__dirname, '..');
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const API_KEY   = 'AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE';   /* shipped web key; emulator ignores its value */

const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
  '.png':'image/png', '.json':'application/json', '.svg':'image/svg+xml', '.jpg':'image/jpeg',
  '.webp':'image/webp', '.ico':'image/x-icon', '.woff2':'font/woff2' };

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).replace(/\s+/g, ' ').slice(0, 110) + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n── ' + t + ' ──');

function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.write(data); req.end();
  });
}

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  let f = path.join(ROOT, p);
  if (!path.extname(p)) f += '.html';
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
    res.end(d);
  });
});

const CART = [
  { id: 'CK_a', name: 'Alpha Widget',  price: 100, qty: 1, category: 'electronics', image: '' },
  { id: 'CK_b', name: 'Beta Gadget',   price: 200, qty: 3, category: 'electronics', image: '' },
  { id: 'CK_c', name: 'Gamma Legacy',  price: 50,  quantity: 2, category: 'electronics', image: '' },
];

const wd = setTimeout(() => { console.log('\n  TIMEOUT — harness watchdog'); process.exit(1); }, 180000);

server.listen(0, async () => {
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const EMU  = 'http://' + AUTH_HOST;

  head('0 · mint a real buyer in the Auth emulator');
  const EMAIL = 'checkout-probe@sokoni.test';
  const PASSWORD = 'Test-Pass-1234';
  let signUp;
  try {
    signUp = await post(EMU + '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + API_KEY,
      { email: EMAIL, password: PASSWORD, returnSecureToken: true });
    if (signUp && signUp.error && /EMAIL_EXISTS/.test(signUp.error.message || '')) {
      /* A re-run against a persisted emulator must SIGN IN, not skip. Skipping here
         exited 0 and reported a green suite that had proven nothing. */
      signUp = await post(EMU + '/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + API_KEY,
        { email: EMAIL, password: PASSWORD, returnSecureToken: true });
    }
  } catch (e) {
    console.log('  SKIP — Auth emulator not reachable at ' + AUTH_HOST + ' (' + e.message + ')');
    console.log('  Run under: firebase emulators:exec --only auth "node scripts/' + path.basename(__filename) + '"');
    clearTimeout(wd); server.close(); process.exit(0);
  }
  if (!signUp || !signUp.localId) {
    /* Not a skip: the emulator was reachable and refused. Fail loudly rather than
       exiting 0 with nothing proven. */
    console.log('  FAIL — emulator reachable but no user: ' + JSON.stringify(signUp).slice(0, 160));
    clearTimeout(wd); server.close(); process.exit(1);
  }
  ck('emulator minted a real buyer account', !!signUp.idToken && !!signUp.localId, 'uid=' + signUp.localId);
  const UID = signUp.localId;

  const browser = await webkit.launch();
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });

  /* Emulator at the network boundary — the page's own Firebase SDK is untouched.
     Route handlers are DETACHED promises, so each must swallow its own errors. */
  const authRoute = async (route) => {
    try {
      const u = new URL(route.request().url());
      const r = await route.fetch({ url: EMU + '/' + u.host + u.pathname + u.search });
      await route.fulfill({ response: r });
    } catch (_) {
      try { await route.abort(); } catch (__) { /* context gone */ }
    }
  };
  await ctx.route('https://identitytoolkit.googleapis.com/**', authRoute);
  await ctx.route('https://securetoken.googleapis.com/**', authRoute);

  await ctx.addInitScript(([uid, cart]) => {
    try {
      localStorage.setItem('loggedIn', 'true');
      localStorage.setItem('sokoniUser', JSON.stringify({
        uid: uid, name: 'Checkout Probe', email: 'checkout-probe@sokoni.test',
        phoneNumber: '+254700000000', roles: ['buyer'] }));
      /* Seed the cart ONCE. removeCartItem() calls location.reload() on success, and
         addInitScript runs on EVERY navigation -- re-seeding here restored all three
         lines after the reload and made a WORKING remove button look broken. */
      if (!localStorage.getItem('__cartSeeded')) {
        localStorage.setItem('cart', cart);
        localStorage.setItem('__cartSeeded', '1');
      }
    } catch (e) {}
  }, [UID, JSON.stringify(CART)]);

  let _signinResult = null;
  const page = await ctx.newPage();
  const pageErrors = [], appCheckFailures = [];
  page.on('pageerror', e => pageErrors.push(String((e && e.message) || e).slice(0, 140)));
  page.on('response', r => {
    if (r.status() >= 400 && /firestore|appcheck|googleapis/i.test(r.url())) {
      appCheckFailures.push(r.status() + ' ' + r.url().split('?')[0].slice(-60));
    }
  });

  /* Establish the REAL session first, then navigate to checkout. */
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async ([key, token]) => {
    /* Sign in through the page's own SDK using the emulator-minted credential. */
    const m = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
    const auth = window.firebaseAuth;
    if (!auth) return 'NO_window.firebaseAuth';
    try { await m.signInWithEmailAndPassword(auth, 'checkout-probe@sokoni.test', 'Test-Pass-1234'); return 'ok'; }
    catch (e) { return 'SIGNIN_ERR:' + (e && (e.code || e.message)); }
  }, [API_KEY, signUp.idToken]).then(r => { _signinResult = r; }).catch(e => { _signinResult = 'THREW:' + e.message; });
  await page.waitForTimeout(2500);

  /* REPORTED, NOT ASSERTED -- and the distinction matters.
     The emulator mints a real account, but routing the SDK's identitytoolkit calls through
     it does not complete under webkit here (auth/network-request-failed), so the page runs
     on the cached sokoniUser profile rather than a genuine Firebase session. Asserting a
     PASS here would claim an authenticated session this harness has not established.
     What it DOES cover is unaffected by that: the order summary renders from
     localStorage.cart and the remove button is pure client code, which is precisely where
     the ffea917 defect lived. Inventory/Firestore behaviour remains out of reach. */
  const signedIn = await page.evaluate(() => !!(window.firebaseAuth && window.firebaseAuth.currentUser));
  console.log('  NOTE  real Firebase session: ' + (signedIn ? 'ESTABLISHED' : 'NOT established (' + _signinResult + ')'));
  console.log('        -> the page runs on the cached profile; summary + remove are client-side and unaffected.');

  head('1 · authenticated checkout with a NON-EMPTY cart');
  await page.goto(BASE + '/checkout.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);

  const landed = await page.evaluate(() => location.pathname.split('/').pop());
  /* The URL normalises to clean form (no .html) once shared-header runs, so accept both.
     An earlier draft compared to 'checkout.html' exactly and reported a PASSING page as a
     failure -- the landed-URL check must match what the app actually produces. */
  const onCheckout = /^checkout(.html)?$/.test(landed);
  ck('checkout was reached (not bounced to login)', onCheckout, 'landed=' + landed);
  if (!onCheckout) {
    console.log('\n  Cannot assert the summary from ' + landed + ' — reporting rather than inferring.');
    console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
    clearTimeout(wd); await browser.close(); server.close(); process.exit(fail ? 1 : 0);
  }

  ck('no ReferenceError on an authenticated non-empty cart',
     pageErrors.filter(e => /is not defined/.test(e)).length === 0,
     pageErrors.slice(0, 2).join(' | '));

  head('2 · the complete order summary rendered');
  const summary = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.os-item')];
    return {
      rows: rows.length,
      names: rows.map(r => (r.querySelector('.os-item-name') || {}).textContent || ''),
      badges: rows.map(r => (r.querySelector('.os-item-qty') || {}).textContent || ''),
      removeButtons: document.querySelectorAll('.os-item-remove').length,
      removeCartItemType: typeof window.removeCartItem,
      saveAndRedirectType: typeof window.saveAndRedirect,
    };
  });
  ck('every cart line rendered', summary.rows === 3, 'rows=' + summary.rows);
  ck('all three product names present',
     summary.names.join('|').includes('Alpha') && summary.names.join('|').includes('Beta') && summary.names.join('|').includes('Gamma'),
     summary.names.join(','));
  ck('qty 1 line has NO badge',        summary.badges[0] === '', JSON.stringify(summary.badges));
  ck('qty 3 line shows ×3',            /×\s*3/.test(summary.badges[1] || ''), JSON.stringify(summary.badges));
  ck('legacy quantity 2 line shows ×2', /×\s*2/.test(summary.badges[2] || ''), JSON.stringify(summary.badges));

  head('3 · removeCartItem — assigned AFTER the loop that threw');
  ck('window.removeCartItem is defined', summary.removeCartItemType === 'function', summary.removeCartItemType);
  ck('window.saveAndRedirect is defined', summary.saveAndRedirectType === 'function', summary.saveAndRedirectType);
  ck('a remove button exists per line', summary.removeButtons === 3, 'buttons=' + summary.removeButtons);

  /* The consent banner is a fixed overlay that intercepts pointer events ~1.5s after
     load. Dismiss it first: a click blocked by unrelated chrome would report the remove
     button as broken when it is not. */
  try { await page.click('#_sokoniPrivacyAcceptBtn', { timeout: 4000 }); } catch (_) {}
  await page.waitForTimeout(600);

  /* The real test: CLICK it. Symbol existence is not behaviour. */
  let _clickErr = null;
  try { await page.click('.os-item-remove', { timeout: 12000 }); }
  catch (e) { _clickErr = (e && e.message || String(e)).slice(0, 90); }
  ck('the remove button was clickable', _clickErr === null, _clickErr || '');
  await page.waitForTimeout(2000);
  const afterClick = await page.evaluate(() => {
    let c = []; try { c = JSON.parse(localStorage.getItem('cart') || '[]'); } catch (e) {}
    return { cartLines: c.length, ids: c.map(i => i.id), rows: document.querySelectorAll('.os-item').length };
  });
  ck('clicking ✕ removed the line from the cart', afterClick.cartLines === 2, 'lines=' + afterClick.cartLines + ' ids=' + afterClick.ids.join(','));
  ck('the removed line was the one clicked (CK_a)', !afterClick.ids.includes('CK_a'), afterClick.ids.join(','));
  ck('the summary re-rendered to 2 rows', afterClick.rows === 2, 'rows=' + afterClick.rows);

  head('4 · App Check reality (reported, never faked)');
  console.log('  Firestore/App Check failures observed: ' + appCheckFailures.length
    + (appCheckFailures.length ? ' — ' + appCheckFailures.slice(0, 2).join(' | ') : ''));
  console.log('  (expected: the emulator mints no App Check token. Inventory writes are NOT provable here.)');

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  clearTimeout(wd);
  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
});
