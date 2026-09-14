#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   PROBE — is the merchant shell's auth guard actually armed?
   ------------------------------------------------------------------------------
   merchant.html loads auth-guard.js. The guard's FIRST statement is

       if (document.documentElement.dataset.requireAuth !== 'true') return;

   and merchant.html:2 is a bare <html lang="en">. Every other guarded surface
   (seller.html, verification.html, seller-delivery.html, checkout.html, …) carries
   data-require-auth="true" in the tag. Nothing sets it dynamically.

   That matters because the shell's own postMessage handler (merchant.html:2377)
   delegates every session decision to that guard, twice in its own comments:

       "The shell's own auth-guard is the authority"
       "The shell's own auth-guard is the single authority on that"

   A hosted module that cannot confirm a session deliberately does NOT navigate its
   own panel — it posts `authRequired` and the shell shows an in-panel notice, on the
   stated grounds that the guard has already handled the redirect. If the guard is
   inert, nobody handles it, and an unauthenticated visitor sits inside a merchant
   shell that never sends them to login.

   This probe MEASURES that end to end rather than arguing it from source: it loads
   /merchant with no session and reports whether the tab was sent to login.

   Run against the local tree (default) or any origin:
     node scripts/probe-merchant-auth-guard.js
     node scripts/probe-merchant-auth-guard.js --origin https://mysokoni.co.ke
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');
const http = require('http');
const fs = require('fs');
const { webkit } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8812;
const argOrigin = (() => {
  const i = process.argv.indexOf('--origin');
  return i > 0 ? process.argv[i + 1] : null;
})();

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
               '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp' };

function serve() {
  return new Promise((res) => {
    const s = http.createServer((req, rs) => {
      let u = decodeURIComponent((req.url || '/').split('?')[0]);
      let f = path.join(ROOT, u === '/' ? 'index.html' : u.replace(/^\/+/, ''));
      /* Hosting runs cleanUrls:true — /merchant must resolve to merchant.html or the
         probe would measure a 404 and call it a redirect failure. */
      if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html';
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { rs.writeHead(404); rs.end('nf'); return; }
      rs.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(rs);
    });
    s.listen(PORT, () => res(s));
  });
}

(async () => {
  const server = argOrigin ? null : await serve();
  const origin = argOrigin || ('http://127.0.0.1:' + PORT);
  const browser = await webkit.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  const warnings = [];
  page.on('console', (m) => { if (/AUTH REDIRECT|reports no user|auth-guard/i.test(m.text())) warnings.push(m.text()); });

  /* No storage state is seeded, so this is a genuinely signed-out visitor. */
  await page.goto(origin + '/merchant', { waitUntil: 'domcontentloaded' }).catch(() => {});
  /* The guard's own timers are 4s (firebase ready) and 10s (not ready). Wait past the
     longer one, or a slow redirect reads as no redirect at all. */
  await page.waitForTimeout(12000);

  const url = page.url();
  const armed = await page.evaluate(() => document.documentElement.dataset.requireAuth === 'true');
  const guardLoaded = await page.evaluate(() =>
    !!document.querySelector('script[src*="auth-guard"]'));
  const title = await page.title();
  const shellVisible = await page.evaluate(() => !!document.querySelector('.mtop, #mbnav'));

  const wentToLogin = /\/(login|signup)(\.html)?(\?|#|$)/.test(url);

  console.log('\n\x1b[1mMERCHANT AUTH GUARD PROBE\x1b[0m   (' + origin + ', no session)');
  console.log('  landed URL          ' + url);
  console.log('  document.title      ' + JSON.stringify(title));
  console.log('  auth-guard loaded   ' + guardLoaded);
  console.log('  guard ARMED         ' + armed + '   (data-require-auth on <html>)');
  console.log('  merchant shell DOM  ' + shellVisible);
  console.log('  sent to login       ' + wentToLogin);
  if (warnings.length) {
    console.log('  console');
    warnings.slice(0, 6).forEach((w) => console.log('      · ' + w.slice(0, 140)));
  }

  const inert = guardLoaded && !armed;
  console.log('');
  if (inert && !wentToLogin) {
    console.log('\x1b[31mFINDING CONFIRMED\x1b[0m  the shell loads auth-guard.js but never opts in, so the');
    console.log('guard returns immediately. An unauthenticated visitor stays inside /merchant and is');
    console.log('never sent to login — while the shell\'s message handler delegates that decision to');
    console.log('this guard as "the single authority". Nothing holds the session boundary.');
  } else if (wentToLogin) {
    console.log('\x1b[32mNOT REPRODUCED\x1b[0m  the tab was sent to login; the boundary holds by some path.');
  } else {
    console.log('\x1b[33mINCONCLUSIVE\x1b[0m  armed=' + armed + ' login=' + wentToLogin + ' — read the values above.');
  }

  await browser.close();
  if (server) server.close();
  process.exit(inert && !wentToLogin ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
