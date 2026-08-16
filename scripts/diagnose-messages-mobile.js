#!/usr/bin/env node
/* DIAGNOSTIC (read-only) — why is Messages broken on a phone?
 *
 *   node scripts/diagnose-messages-mobile.js
 *
 * Measures the real rendered layout at four phone viewports before any CSS is
 * touched. Prints numbers; asserts nothing; changes nothing.
 */
'use strict';
const { webkit } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
const VIEWPORTS = [
  { name: 'iPhone SE (small)', width: 320, height: 568 },
  { name: 'iPhone SE', width: 375, height: 667 },
  { name: 'iPhone 14 Pro', width: 390, height: 844 },
  { name: 'iPhone 14 Pro Max', width: 430, height: 932 },
];

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/merchant.html';
  fs.readFile(path.join(ROOT, p), (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'text/plain' });
    res.end(d);
  });
});

const probe = () => {
  const de = document.documentElement, b = document.body;
  const overflow = Math.max(de.scrollWidth, b.scrollWidth) - de.clientWidth;
  const wide = [].filter.call(document.querySelectorAll('*'), (el) => {
    const r = el.getBoundingClientRect();
    return r.width > de.clientWidth + 1 && r.width < 100000;
  }).slice(0, 6).map((el) => ({
    tag: el.tagName.toLowerCase(),
    cls: String(el.className || '').slice(0, 40),
    w: Math.round(el.getBoundingClientRect().width),
  }));
  const tables = document.querySelectorAll('table').length;
  const composer = document.querySelector('#msgComposer, .msg-composer, [class*="composer"], textarea, input[type="text"]');
  const cRect = composer ? composer.getBoundingClientRect() : null;
  return {
    clientWidth: de.clientWidth,
    horizontalOverflowPx: overflow,
    widestOffenders: wide,
    tables,
    composer: cRect ? { bottom: Math.round(cRect.bottom), width: Math.round(cRect.width), visible: cRect.bottom <= window.innerHeight + 1 } : null,
    innerHeight: window.innerHeight,
  };
};

server.listen(0, async () => {
  const BASE = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try { browser = await webkit.launch(); }
  catch (e) { console.log('SKIP — webkit unavailable: ' + e.message); server.close(); process.exit(0); return; }

  console.log('\nMESSAGES MOBILE DIAGNOSTIC (read-only)\n' + '='.repeat(72));

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 3, isMobile: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    /* auth-guard.js sends an unauthenticated visitor to login.html, so without a
       seeded session the harness measures a login frame and reports nothing
       about Messages. This is local test scaffolding, not an auth bypass:
       merchant.html's guard reads exactly these two keys. */
    await ctx.addInitScript(() => {
      localStorage.setItem('loggedIn', 'true');
      localStorage.setItem('sokoniUser', JSON.stringify({
        uid: 'SELLER_A_uid_7f3', name: 'Shop B Traders', roles: ['buyer', 'seller'],
      }));
      localStorage.setItem('activeShopId', 'SHOP_B_shop_91c');
    });
    const page = await ctx.newPage();
    await page.goto(BASE + '/merchant.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    /* Open Messages the way a merchant does: open the drawer, tap the button.
       Driving the shell's private API would prove the API works, not that the
       button does. */
    const opened = await page.evaluate(() => {
      const shell = document.getElementById('mshell');
      if (shell) shell.classList.add('mobile-open');
      const item = document.querySelector('.mnav-item[data-id="messages"]');
      if (!item) return { clicked: false, available: [].map.call(document.querySelectorAll('.mnav-item'), n => n.dataset.id) };
      item.click();
      return { clicked: true };
    }).catch((e) => ({ clicked: false, error: e.message }));
    await page.waitForTimeout(3500);

    const shell = await page.evaluate(probe);
    const frames = page.frames().filter(f => f !== page.mainFrame());
    let inner = null, frameUrl = null;
    for (const f of frames) {
      if (/seller\.html/.test(f.url())) {
        frameUrl = f.url();
        try { inner = await f.evaluate(probe); } catch (e) { inner = { error: e.message }; }
      }
    }

    console.log(`\n── ${vp.name}  ${vp.width}×${vp.height}`);
    console.log('   NAV     ' + JSON.stringify(opened));
    console.log('   SHELL   overflow:' + shell.horizontalOverflowPx + 'px  clientW:' + shell.clientWidth +
      '  tables:' + shell.tables);
    if (shell.widestOffenders.length) console.log('           widest: ' + JSON.stringify(shell.widestOffenders));
    if (frameUrl) {
      console.log('   FRAME   ' + frameUrl.replace(BASE, ''));
      if (inner && !inner.error) {
        console.log('           overflow:' + inner.horizontalOverflowPx + 'px  clientW:' + inner.clientWidth +
          '  tables:' + inner.tables + '  innerH:' + inner.innerHeight);
        if (inner.widestOffenders.length) console.log('           widest: ' + JSON.stringify(inner.widestOffenders));
        console.log('           composer: ' + JSON.stringify(inner.composer));
      } else console.log('           unreadable: ' + (inner && inner.error));
    } else {
      console.log('   FRAME   (no seller.html frame mounted — frames: ' + frames.map(f => f.url().replace(BASE, '')).join(', ') + ')');
    }
    await ctx.close();
  }

  await browser.close();
  server.close();
  console.log('\nDiagnostic only — nothing was changed.\n');
  process.exit(0);
});
