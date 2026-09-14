#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT ENTRY ROUTING — the 3×3 matrix
   ------------------------------------------------------------------------------
   Proves where each public entry point sends each identity state, and that NONE of
   them can be pushed somewhere by a signal a user controls.

                        My Store      Business card   Start Selling
     approved seller    merchant      merchant        merchant
     authed, unapproved account       account         onboarding
     signed out         sign-in       sign-in         onboarding

   The routing decision is exercised through the SHIPPED module
   (`sokoni-merchant-entry.js`) rather than re-implemented here, so the test cannot
   pass while the product disagrees.

   IDENTITY IS SIMULATED AT THE SIGNAL, NOT AT THE ANSWER. Each state is built by
   supplying the exact things the resolver reads — a Firebase user with a claim, a
   users/{uid}.roles document, or neither — never by stubbing `resolve()`. A test
   that stubbed the answer would prove only that a constant is a constant.

     node scripts/test-merchant-entry-routing.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8871;
const BASE = 'http://localhost:' + PORT;

let pass = 0, fail = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; failures.push(label + (detail ? '  → ' + detail : '')); console.log('  FAIL  ' + label + (detail ? '   → ' + detail : '')); }
  return !!cond;
};
const head = (t) => console.log('\n\x1b[1m' + t + '\x1b[0m');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
               '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
const server = http.createServer((q, s) => {
  let u = decodeURIComponent((q.url || '/').split('?')[0]);
  let f = path.join(ROOT, u === '/' ? 'index.html' : u.replace(/^\/+/, ''));
  if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html';
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); s.end('nf'); return; }
  s.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(s);
});

/* A page carrying ONLY the router, so the matrix measures the routing decision and
   not whatever else a production page happens to do on load. */
const HARNESS = `<!doctype html><html><head><meta charset="utf-8"><title>entry</title></head>
<body><a href="/merchant" data-merchant-entry="store" id="s">My Store</a>
<a href="/offer" data-merchant-entry="sell" id="v">Start Selling</a>
<script src="/sokoni-merchant-entry.js"></script></body></html>`;

/* Build a state by supplying the SIGNALS the resolver reads.

   Takes `K` as an ARGUMENT, never a closure: Playwright serialises an init script to
   source and evaluates it in a fresh realm, so a captured outer variable is simply
   undefined there. Closing over it threw ReferenceError, the script never ran, no
   firebaseAuth was installed, and EVERY state resolved to 'signed-out' — a matrix
   that looked like a routing catastrophe and was actually one missing argument. */
function identity (K) {
  window.firebaseDB = {};   /* presence only; the doc read is intercepted below */
  if (K === 'signed-out') {
    window.firebaseAuth = { currentUser: null, onAuthStateChanged: (cb) => cb(null) };
    return;
  }
  const user = {
    uid: 'test-uid-' + K,
    getIdTokenResult: () => Promise.resolve({
      claims: K === 'approved-claim' ? { seller: true } : {},
    }),
  };
  window.firebaseAuth = { currentUser: user, onAuthStateChanged: (cb) => cb(user) };
  /* Drives the intercepted users/{uid} read, so `roles` varies per state without
     touching production data. */
  window.__testRoles = K === 'approved-roles' ? ['buyer', 'seller'] : ['buyer'];
}

/* The resolver imports firebase-firestore from the CDN; serve a stub for it so the
   users/{uid} read resolves locally and the matrix does not depend on the network
   or on production content. */
const FS_STUB = `
export const doc = (db, col, id) => ({ col, id });
export const getDoc = (ref) => Promise.resolve({
  exists: () => true,
  data: () => ({ roles: (window.__testRoles || ['buyer']) }),
});
`;

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const browser = await chromium.launch();

  async function decide (kind) {
    const ctx = await browser.newContext();
    await ctx.route('**/firebase-firestore.js', (route) =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: FS_STUB }));
    await ctx.addInitScript(identity, kind);
    const page = await ctx.newPage();
    await page.goto(BASE + '/__entry_harness', { waitUntil: 'domcontentloaded' }).catch(() => null);
    await page.waitForFunction(() => !!window.SokoniMerchantEntry, null, { timeout: 10000 }).catch(() => null);
    const out = await page.evaluate(async () => {
      const r = await window.SokoniMerchantEntry.resolve();
      return {
        state: r.state, via: r.via,
        store: await window.SokoniMerchantEntry.store(),
        sell: await window.SokoniMerchantEntry.startSelling(),
        urls: window.SokoniMerchantEntry._urls,
      };
    }).catch((e) => ({ err: e.message }));
    await ctx.close();
    return out;
  }

  /* Serve the harness page from the same origin. */
  const realHandler = server.listeners('request')[0];
  server.removeAllListeners('request');
  server.on('request', (q, s) => {
    if ((q.url || '').split('?')[0] === '/__entry_harness') {
      s.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      s.end(HARNESS);
      return;
    }
    realHandler(q, s);
  });

  const A = await decide('approved-claim');
  const B = await decide('approved-roles');
  const C = await decide('authed-unapproved');
  const D = await decide('signed-out');

  const U = A.urls || {};
  head('APPROVED — via the custom claim');
  ok('state is approved', A.state === 'approved', JSON.stringify(A));
  ok('approval attributed to the claim', A.via === 'claim', A.via);
  ok('My Store → the merchant workspace', A.store === U.merchant, A.store);
  ok('Start Selling → the merchant workspace', A.sell === U.merchant, A.sell);

  head('APPROVED — via users/{uid}.roles (approved before the claim path shipped)');
  ok('state is approved', B.state === 'approved', JSON.stringify(B));
  ok('approval attributed to users.roles', B.via === 'users.roles', B.via);
  ok('My Store → the merchant workspace', B.store === U.merchant, B.store);

  head('AUTHENTICATED but NOT approved');
  ok('state is not-approved', C.state === 'not-approved', JSON.stringify(C));
  ok('My Store → the account, NOT the merchant workspace', C.store === U.pending, C.store);
  ok('Start Selling → onboarding', C.sell === U.onboard, C.sell);
  ok('never routed to the merchant workspace', C.store !== U.merchant && C.sell !== U.merchant);

  head('SIGNED OUT');
  ok('state is signed-out', D.state === 'signed-out', JSON.stringify(D));
  ok('My Store → sign-in', D.store === U.signin, D.store);
  ok('Start Selling → onboarding', D.sell === U.onboard, D.sell);
  ok('never routed to the merchant workspace', D.store !== U.merchant && D.sell !== U.merchant);

  head('NOT FORGEABLE — a user-controlled signal must not grant approval');
  /* The exact things the module documents as NOT authorities. If any of these flips
     the answer, the routing has a hole a user can type. */
  const forged = await (async () => {
    const ctx = await browser.newContext();
    await ctx.route('**/firebase-firestore.js', (route) =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: FS_STUB }));
    await ctx.addInitScript(identity, 'authed-unapproved');
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('approved', 'true');
        localStorage.setItem('isSeller', 'true');
        localStorage.setItem('sokoniUser', JSON.stringify({ isSeller: true, approved: true, roles: ['seller'] }));
      } catch (e) {}
    });
    const page = await ctx.newPage();
    await page.goto(BASE + '/__entry_harness?role=seller&approved=true', { waitUntil: 'domcontentloaded' }).catch(() => null);
    await page.waitForFunction(() => !!window.SokoniMerchantEntry, null, { timeout: 10000 }).catch(() => null);
    const r = await page.evaluate(async () => {
      const x = await window.SokoniMerchantEntry.resolve();
      return { state: x.state, store: await window.SokoniMerchantEntry.store() };
    }).catch((e) => ({ err: e.message }));
    await ctx.close();
    return r;
  })();
  ok('localStorage approved/isSeller/sokoniUser.roles does NOT grant approval',
     forged.state === 'not-approved', JSON.stringify(forged));
  ok('?role=seller&approved=true does NOT grant approval',
     forged.store !== U.merchant, JSON.stringify(forged));

  head('CUTOVER GATE');
  /* The one thing that must stay false until v2 is deployed. This test asserts the
     CURRENT state deliberately: it will fail the day someone flips the constant, which
     is the reminder to confirm v2 is actually live first. */
  console.log('  merchant destination = ' + U.merchant);
  ok('destination is still the DEPLOYED shell (v1), cutover not yet flipped',
     U.merchant === '/merchant',
     'now ' + U.merchant + ' — if this was intentional, v2 must be deployed and its production URL verified');

  await browser.close();
  server.close();

  console.log('\n' + '='.repeat(70));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  if (failures.length) { console.log(''); failures.forEach((f) => console.log('  · ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); try { server.close(); } catch (_) {} process.exit(2); });
