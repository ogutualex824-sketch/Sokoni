#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   POST-LOGIN ROUTING — auth.js must ask the approval authority, not a checkbox
   ------------------------------------------------------------------------------
   `completeRoleSelection()` used to route on `user.registeredAs.seller`, a value
   parsed out of localStorage and set by a signup CHECKBOX, straight to seller.html.
   That decided merchant access on a signal the client can write, and it bypassed the
   routing contract entirely: a seller never had to press "My Store", because logging
   in had already put them in the old shell.

   This proves the replacement through the SHIPPED auth.js — the page loads the real
   file and the real `sokoni-merchant-entry.js`, and the assertion is the URL the
   browser actually LANDS ON. Nothing here re-implements the decision, so the test
   cannot pass while the product disagrees.

     approved seller            -> the Merchant URL (still v1 until cutover)
     authenticated, unapproved  -> seller intake, never a merchant workspace
     signed out                 -> sign-in
     forged registeredAs.seller -> grants nothing

   IDENTITY IS SIMULATED AT THE SIGNAL. Each state supplies exactly what the resolver
   reads — a Firebase user with a claim, a users/{uid}.roles document, or neither.
   Stubbing `resolve()` would prove only that a constant is a constant.

     node scripts/test-auth-post-login-routing.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8874;
const BASE = 'http://localhost:' + PORT;
const HARNESS_PATH = '/__auth_harness';

let pass = 0, fail = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; failures.push(label + (detail ? '  -> ' + detail : '')); console.log('  FAIL  ' + label + (detail ? '   -> ' + detail : '')); }
  return !!cond;
};
const head = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');

/* The signup page's role step, reduced to the parts completeRoleSelection() reads.
   auth.js is a classic script that defines its own helpers, so it loads as-is. */
const HARNESS = [
  '<!doctype html><html><head><meta charset="utf-8"><title>auth-harness</title></head>',
  '<body>',
  '  <div id="authMsg"></div>',
  '  <div id="roleSelectionSection">',
  '    <input type="checkbox" id="roleSellerCb">',
  '    <input type="checkbox" id="roleDriverCb">',
  '    <button class="auth-btn">Continue</button>',
  '  </div>',
  '  <script src="/auth.js"><\/script>',
  '</body></html>',
].join('\n');

/* ── static server: the real repo, so auth.js and the router are the shipped files ─*/
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((q, s) => {
  const u = decodeURIComponent((q.url || '/').split('?')[0]);
  if (u === HARNESS_PATH) {
    s.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    s.end(HARNESS);
    return;
  }
  let f = path.join(ROOT, u === '/' ? 'index.html' : u.replace(/^\/+/, ''));
  if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html';
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); s.end('nf'); return; }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(s);
});

/* Supply the SIGNALS the resolver reads — never the answer.
   `K` is passed as an ARGUMENT: Playwright serialises an init script to source and
   evaluates it in a fresh realm, where a captured outer variable is undefined. */
function identity (K) {
  window.firebaseDB = {};   /* presence only; the doc read is intercepted */
  if (K === 'signed-out') {
    window.firebaseAuth = { currentUser: null, onAuthStateChanged: (cb) => cb(null) };
  } else {
    const user = {
      uid: 'test-uid-' + K,
      getIdTokenResult: () => Promise.resolve({ claims: K === 'approved-claim' ? { seller: true } : {} }),
    };
    window.firebaseAuth = { currentUser: user, onAuthStateChanged: (cb) => cb(user) };
  }
  window.__testRoles = K === 'approved-roles' ? ['buyer', 'seller'] : ['buyer'];
}

/* getDoc drives the resolver; updateDoc is auth.js's own best-effort roles sync. */
const FS_STUB = [
  'export const doc = (db, col, id) => ({ col, id });',
  'export const getDoc = (ref) => Promise.resolve({',
  '  exists: () => true,',
  '  data: () => ({ roles: (window.__testRoles || ["buyer"]) }),',
  '});',
  'export const updateDoc = () => Promise.resolve();',
].join('\n');

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch();

  /**
   * Run completeRoleSelection() for one identity and report where the browser LANDED.
   * @param {{kind:string, tickSeller?:boolean, seed?:object, query?:string,
   *          forge?:boolean, breakRouter?:boolean}} o
   */
  async function land (o) {
    const ctx = await browser.newContext();
    await ctx.route('**/firebase-firestore.js', (r) =>
      r.fulfill({ status: 200, contentType: 'text/javascript', body: FS_STUB }));
    /* Mutation control: prove what happens when the router cannot load. */
    if (o.breakRouter) {
      await ctx.route('**/sokoni-merchant-entry.js', (r) => r.fulfill({ status: 404, body: 'gone' }));
    }
    /* Every destination is a stub, so the assertion is the URL and not whatever a
       real page happens to do on load. */
    await ctx.route('**/*', (r) => {
      const url = r.request().url();
      if (r.request().isNavigationRequest() && url.indexOf('__auth_harness') === -1) {
        return r.fulfill({ status: 200, contentType: 'text/html', body: '<title>LANDED</title>' });
      }
      return r.fallback();
    });

    await ctx.addInitScript(identity, o.kind);
    await ctx.addInitScript((seed) => {
      try { localStorage.setItem('sokoniUser', JSON.stringify(seed)); } catch (e) {}
    }, o.seed || { uid: 'u1', name: 'T', registeredAs: {} });
    if (o.forge) {
      await ctx.addInitScript(() => {
        try { localStorage.setItem('approved', 'true'); localStorage.setItem('isSeller', 'true'); } catch (e) {}
      });
    }

    const page = await ctx.newPage();
    await page.goto(BASE + HARNESS_PATH + (o.query || ''), { waitUntil: 'domcontentloaded' }).catch(() => null);
    await page.waitForFunction(() => typeof window.completeRoleSelection === 'function', null, { timeout: 10000 })
      .catch(() => null);

    const loaded = await page.evaluate(() => typeof window.completeRoleSelection === 'function').catch(() => false);
    if (!loaded) { await ctx.close(); return { err: 'completeRoleSelection not defined — auth.js did not load' }; }

    if (o.tickSeller) await page.evaluate(() => { document.getElementById('roleSellerCb').checked = true; });

    const nav = page.waitForURL((u) => String(u).indexOf('__auth_harness') === -1, { timeout: 20000 }).catch(() => null);
    const stored = await page.evaluate(async () => {
      await window.completeRoleSelection();
      try { return JSON.parse(localStorage.getItem('sokoniUser')); } catch (e) { return null; }
    }).catch(() => null);
    await nav;

    const landed = page.url();
    await ctx.close();
    let pathname = null;
    try { pathname = new URL(landed).pathname; } catch (e) {}
    return { landed, pathname, navigated: landed.indexOf('__auth_harness') === -1, stored };
  }

  /* The cutover gate the routing must honour, read from the module itself rather
     than restated here — a copy would keep passing after someone flips the real one. */
  const src = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-entry.js'), 'utf8');
  const MERCHANT = (src.match(/var MERCHANT_URL\s*=\s*'([^']+)'/) || [])[1];
  const ONBOARD = (src.match(/var ONBOARD_URL\s*=\s*'([^']+)'/) || [])[1];
  const SIGNIN = (src.match(/var SIGNIN_URL\s*=\s*'([^']+)'/) || [])[1];
  if (!MERCHANT || !ONBOARD || !SIGNIN) {
    console.error('Could not read the destination constants from sokoni-merchant-entry.js — refusing to assert against guesses.');
    await browser.close(); server.close(); process.exit(2);
  }

  head('APPROVED SELLER — the claim decides, and it lands in the Merchant workspace');
  const A = await land({ kind: 'approved-claim', tickSeller: true });
  ok('auth.js ran and the browser actually navigated', A.navigated === true, JSON.stringify(A));
  ok('lands on the Merchant URL', A.pathname === MERCHANT, A.pathname + ' (expected ' + MERCHANT + ')');
  ok('does NOT land on the old shell', !/seller\.html/.test(A.landed || ''), A.landed);

  head('APPROVED SELLER — approved before the claim path shipped (users/{uid}.roles)');
  const B = await land({ kind: 'approved-roles', tickSeller: true });
  ok('lands on the Merchant URL', B.pathname === MERCHANT, B.pathname);

  head('AUTHENTICATED, NOT APPROVED — asked to sell');
  const C = await land({ kind: 'authed-unapproved', tickSeller: true });
  ok('navigated', C.navigated === true, JSON.stringify(C));
  ok('lands on seller intake, not a merchant workspace', C.pathname === ONBOARD, C.pathname + ' (expected ' + ONBOARD + ')');
  ok('never reaches the Merchant URL', C.pathname !== MERCHANT, C.pathname);
  ok('never reaches the old shell', !/seller\.html/.test(C.landed || ''), C.landed);

  head('AUTHENTICATED, NOT APPROVED — did not ask to sell (unchanged behaviour)');
  const E = await land({ kind: 'authed-unapproved', tickSeller: false });
  ok('lands on the marketplace, as before', /\/index\.html$/.test(E.pathname || ''), E.pathname);

  head('NON-SELLER ROLE — untouched by this change');
  const F = await land({ kind: 'authed-unapproved', seed: { uid: 'u1', registeredAs: { driver: true } } });
  ok('driver still lands on driver.html', /\/driver\.html$/.test(F.pathname || ''), F.pathname);

  head('SIGNED OUT — the session did not survive signup');
  const G = await land({ kind: 'signed-out', tickSeller: true });
  ok('navigated', G.navigated === true, JSON.stringify(G));
  ok('lands on sign-in', G.pathname === SIGNIN, G.pathname + ' (expected ' + SIGNIN + ')');
  ok('never reaches the Merchant URL', G.pathname !== MERCHANT, G.pathname);

  head('FORGED — a signal the client can write must grant nothing');
  /* registeredAs.seller written straight into localStorage, plus the other flags the
     router documents as NOT authorities, plus the URL parameters. The identity
     underneath is an ordinary unapproved account. */
  const H = await land({
    kind: 'authed-unapproved',
    forge: true,
    query: '?role=seller&approved=true',
    seed: { uid: 'u1', isSeller: true, approved: true, roles: ['seller'], registeredAs: { seller: true } },
  });
  ok('navigated', H.navigated === true, JSON.stringify(H));
  ok('forged registeredAs.seller does NOT reach the Merchant URL', H.pathname !== MERCHANT, H.pathname);
  ok('forged registeredAs.seller does NOT reach the old shell', !/seller\.html/.test(H.landed || ''), H.landed);
  ok('it is routed to intake instead', H.pathname === ONBOARD, H.pathname + ' (expected ' + ONBOARD + ')');
  ok('registeredAs.seller still persists as profile data',
     !!(H.stored && H.stored.registeredAs && H.stored.registeredAs.seller),
     JSON.stringify(H.stored && H.stored.registeredAs));

  head('MUTATION CONTROL — the router missing must not fall back to the old shell');
  /* If a broken router silently produced the old destination, every assertion above
     would still pass while the bypass was back. This is the check that cannot be
     satisfied by doing nothing. */
  const I = await land({ kind: 'approved-claim', tickSeller: true, breakRouter: true });
  ok('navigated', I.navigated === true, JSON.stringify(I));
  ok('falls back to the marketplace', /\/index\.html$/.test(I.pathname || ''), I.pathname);
  ok('does NOT fall back to seller.html', !/seller\.html/.test(I.landed || ''), I.landed);
  ok('does NOT assume approved and open Merchant', I.pathname !== MERCHANT, I.pathname);

  head('CUTOVER GATE');
  console.log('  merchant destination = ' + MERCHANT);
  ok('still the DEPLOYED shell (v1) — cutover not yet flipped', MERCHANT === '/merchant',
     'now ' + MERCHANT + ' — if intentional, v2 must be deployed and its production URL verified');

  await browser.close();
  server.close();

  console.log('\n' + '='.repeat(70));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  if (failures.length) { console.log(''); failures.forEach((f) => console.log('  · ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); try { server.close(); } catch (_) {} process.exit(2); });
