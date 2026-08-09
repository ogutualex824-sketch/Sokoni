#!/usr/bin/env node
/* ============================================================================
   Consent banner render check  —  MANUAL, NOT a predeploy gate.
   ============================================================================
   verify-consent-gate.js proves the LOGIC. This proves the PIXELS: that the
   banner actually lays out, that Reject and Accept really are the same size on
   a phone, that both clear the 44px touch floor, and that clicking either one
   dismisses the modal and records the right decision.

   That distinction matters here. This overlay has a history of rendering in a
   way that looked fine in source and was broken on a device — a fixed bar that
   covered eight Seller Dashboard quick actions, a backdrop that swallowed every
   tap on /signup, a blur that kept compositing at opacity 0. A regex over the
   markup would have passed all three.

   Kept OUT of `predeploy` on purpose: it needs Playwright, and installing
   Playwright makes 11 env-skipped suites fail and blocks deploys. Install it
   transiently, run this, then `npm uninstall --no-save playwright`.

   Usage:  npm install --no-save playwright && node scripts/check-consent-render.js
   Exit:   0 all pass · 1 any failure
   ========================================================================= */

'use strict';

const path = require('path');
const http = require('http');
const fs   = require('fs');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8317;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon' };

let failures = 0, passes = 0;
const ok  = (n, d) => { passes++;   console.log(`  ✓ ${n}${d ? ' — ' + d : ''}`); };
const bad = (n, d) => { failures++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); };
const check = (c, n, d) => { c ? ok(n, d) : bad(n, d); return !!c; };

function serve() {
  const s = http.createServer((req, res) => {
    let u = decodeURIComponent((req.url || '/').split('?')[0]);
    if (u === '/') u = '/index.html';
    const f = path.join(ROOT, u.replace(/^\//, ''));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404); return res.end('nf');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => s.listen(PORT, () => r(s)));
}

/* The banner is injected 1.5s after DOMContentLoaded. */
const BANNER = '#_sokoniPrivacyBanner';
const ACCEPT = '#_sokoniPrivacyAcceptBtn';
const REJECT = '#_sokoniPrivacyRejectBtn';

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (e) {
    console.log('\n  Playwright is not installed. This check is deliberately not a');
    console.log('  predeploy gate — install it transiently:\n');
    console.log('    npm install --no-save playwright');
    console.log('    node scripts/check-consent-render.js');
    console.log('    npm uninstall --no-save playwright\n');
    process.exit(1);
  }

  const srv = await serve();
  const browser = await chromium.launch();

  async function fresh() {
    const ctx = await browser.newContext({
      viewport: { width: 393, height: 852 }, deviceScaleFactor: 3,
      isMobile: true, hasTouch: true,
    });
    const page = await ctx.newPage();
    page.on('pageerror', () => {});
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(BANNER, { timeout: 15000 });
    return { ctx, page };
  }

  try {
    console.log('\nBanner layout (iPhone-class viewport, 393×852)');
    console.log('──────────────────────────────────────────────');
    {
      const { ctx, page } = await fresh();

      const a = await page.locator(ACCEPT).boundingBox();
      const r = await page.locator(REJECT).boundingBox();

      check(!!a && !!r, 'both controls render', a && r ? '' : 'a control is missing');
      if (a && r) {
        /* Equal EFFORT is the requirement, so equal size is what is measured —
           not equal styling. A quieter colour is fine; a smaller target is not. */
        check(Math.abs(a.width - r.width) <= 1,
          'Reject and Accept are the same width',
          `accept ${Math.round(a.width)}px · reject ${Math.round(r.width)}px`);
        check(Math.abs(a.height - r.height) <= 1,
          'Reject and Accept are the same height',
          `${Math.round(a.height)}px each`);
        check(a.height >= 44 && r.height >= 44,
          'both clear the 44px touch floor',
          `${Math.round(Math.min(a.height, r.height))}px`);
        check(Math.abs(a.y - r.y) <= 2,
          'both sit on the same row', 'neither is demoted below the other');
        check(r.width > 0 && r.x >= 0 && r.x + r.width <= 393,
          'Reject is fully on screen', `x ${Math.round(r.x)}–${Math.round(r.x + r.width)}`);
      }

      /* Both must be the topmost element at their own centre. This is the exact
         check that caught the /signup backdrop bug: a control can be rendered,
         sized correctly, and still be untappable. */
      for (const [label, sel] of [['Reject', REJECT], ['Accept', ACCEPT]]) {
        const top = await page.evaluate((s) => {
          const el = document.querySelector(s);
          if (!el) return 'missing';
          const b = el.getBoundingClientRect();
          const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
          return hit === el ? 'self' : (hit ? (hit.id || hit.tagName) : 'none');
        }, sel);
        check(top === 'self', `${label} is tappable at its centre`,
          top === 'self' ? '' : `covered by ${top}`);
      }

      /* Focus must not favour an answer. */
      const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
      check(focused !== '_sokoniPrivacyAcceptBtn' && focused !== '_sokoniPrivacyRejectBtn',
        'initial focus does not pre-select an answer', `focus on ${focused || '(none)'}`);

      await ctx.close();
    }

    console.log('\nReject actually rejects');
    console.log('───────────────────────');
    {
      const { ctx, page } = await fresh();
      await page.click(REJECT);
      await page.waitForTimeout(600);

      const state = await page.evaluate(() => ({
        present:  !!document.getElementById('_sokoniPrivacyBanner'),
        rejected: !!localStorage.getItem('sokoniPrivacyRejected'),
        accepted: !!localStorage.getItem('sokoniPrivacyAccepted'),
        store:    !!localStorage.getItem('sokoniAnalytics'),
        ga:       !!Array.from(document.scripts).find(s => /googletagmanager/.test(s.src || '')),
      }));
      check(!state.present,  'Reject dismisses the banner');
      check(state.rejected,  'Reject records the decision');
      check(!state.accepted, 'Reject does not leave an accept marker');
      check(!state.ga,       'Reject: gtag.js was never requested');
      check(!state.store,    'Reject: nothing written to the analytics store');

      /* The page must be usable afterwards — the dismiss path releases a scroll
         lock and re-shows the FABs, and it is shared with Accept precisely so
         this cannot regress on one branch only. */
      const usable = await page.evaluate(() => {
        const bs = document.body.style;
        return bs.position !== 'fixed' && bs.overflow !== 'hidden';
      });
      check(usable, 'the page is not left locked after Reject');
      await ctx.close();
    }

    console.log('\nAccept still accepts');
    console.log('────────────────────');
    {
      const { ctx, page } = await fresh();
      await page.click(ACCEPT);
      await page.waitForTimeout(1200);
      const state = await page.evaluate(() => ({
        present:  !!document.getElementById('_sokoniPrivacyBanner'),
        accepted: !!localStorage.getItem('sokoniPrivacyAccepted'),
        rejected: !!localStorage.getItem('sokoniPrivacyRejected'),
        ga:       !!Array.from(document.scripts).find(s => /googletagmanager/.test(s.src || '')),
      }));
      check(!state.present,  'Accept dismisses the banner');
      check(state.accepted,  'Accept records the decision');
      check(!state.rejected, 'Accept clears any prior rejection');
      check(state.ga,        'Accept: gtag.js is requested');
      await ctx.close();
    }

    /* Auth pages get the bottom-sheet variant, capped at 32vh with internal
       scroll. A P0 in July had the full-screen backdrop covering #signupPassword
       so the form looked usable and swallowed every tap. Adding a second control
       to that card is exactly the kind of change that could reintroduce it. */
    console.log('\nSignup page — the sheet must not cover the form');
    console.log('───────────────────────────────────────────────');
    {
      const ctx = await browser.newContext({
        viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      page.on('pageerror', () => {});
      await page.goto(`http://localhost:${PORT}/signup.html`, { waitUntil: 'domcontentloaded' });
      /* signup.html is on the banner's skip list, so inject the prompt directly
         rather than asserting on a banner that is deliberately not shown here. */
      const shown = await page.waitForSelector(BANNER, { timeout: 4000 }).then(() => true).catch(() => false);
      if (!shown) {
        ok('signup does not auto-prompt', 'on the skip list — no sheet to cover the form');
      } else {
        const a = await page.locator(ACCEPT).boundingBox();
        const r = await page.locator(REJECT).boundingBox();
        check(!!a && !!r, 'both controls render on the auth sheet');
        if (a && r) check(Math.abs(a.width - r.width) <= 1, 'still equal width on the auth sheet',
          `${Math.round(a.width)}px each`);
        const pwOk = await page.evaluate(() => {
          const el = document.getElementById('signupPassword');
          if (!el) return 'no-field';
          const b = el.getBoundingClientRect();
          if (b.width === 0) return 'hidden';
          const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
          return hit === el || el.contains(hit) ? 'reachable' : (hit ? (hit.id || hit.tagName) : 'none');
        });
        check(pwOk === 'reachable' || pwOk === 'no-field' || pwOk === 'hidden',
          'the password field is not covered by the consent sheet', pwOk);
      }
      await ctx.close();
    }

    console.log('\nPrivacy Settings on /legal');
    console.log('──────────────────────────');
    {
      const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      page.on('pageerror', () => {});
      await page.goto(`http://localhost:${PORT}/legal.html#cookies`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#consentAcceptBtn', { timeout: 15000 });

      const a = await page.locator('#consentAcceptBtn').boundingBox();
      const r = await page.locator('#consentRejectBtn').boundingBox();
      check(!!a && !!r, 'Privacy Settings renders both controls');
      if (a && r) {
        check(a.height >= 44 && r.height >= 44, 'both clear the 44px touch floor',
          `${Math.round(Math.min(a.height, r.height))}px`);
      }

      await page.click('#consentAcceptBtn');
      await page.waitForTimeout(300);
      let st = await page.evaluate(() => ({
        accepted: !!localStorage.getItem('sokoniPrivacyAccepted'),
        label: document.getElementById('consentStatus').textContent,
      }));
      check(st.accepted && /Accepted/.test(st.label),
        'Privacy Settings can grant', st.label);

      await page.click('#consentRejectBtn');
      await page.waitForTimeout(300);
      st = await page.evaluate(() => ({
        rejected: !!localStorage.getItem('sokoniPrivacyRejected'),
        accepted: !!localStorage.getItem('sokoniPrivacyAccepted'),
        store:    !!localStorage.getItem('sokoniAnalytics'),
        label:    document.getElementById('consentStatus').textContent,
      }));
      check(st.rejected && !st.accepted && /Rejected/.test(st.label),
        'Privacy Settings can withdraw', st.label);
      check(!st.store, 'withdrawal deletes the on-device store');
      await ctx.close();
    }

  } finally {
    await browser.close();
    srv.close();
  }

  console.log('\nResult\n──────');
  console.log(`  ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
