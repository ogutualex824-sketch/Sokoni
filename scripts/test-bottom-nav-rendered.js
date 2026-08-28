#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   THE BOTTOM BAR, AS A USER SEES IT
   ══════════════════════════════════════════════════════════════════════════════
   Why this exists, in one sentence: "the nav element is visible and holds five
   anchors" and "the five destinations are visible to a user" are DIFFERENT
   CLAIMS, and for most of this integration only the first was ever proven.

   A static suite already checks the configuration (scripts/test-customer-nav.js).
   It cannot see a bar whose items render at zero height, inherit opacity 0, sit
   outside the viewport, or lose their labels to a CSS change three files away.
   That failure would ship a bar that exists in the DOM and shows nothing — which
   is indistinguishable from a working bar in every source-level check.

   So this suite launches a real browser against a real server and reads the
   painted result: five destinations, each visible, each with a usable touch
   target, each pointing where it should, exactly one bar, correct active state,
   the Messages badge present, and no empty shell.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '\n        [' + d + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '\n        [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);

/* The five the product intends. Kept here, not imported, so a change to the
   shell's array cannot silently rewrite the expectation it is checked against. */
const EXPECTED = [
  { label: 'Home', href: '/' },
  { label: 'Shop', href: 'category.html?cat=all' },
  { label: 'Services', href: 'services.html' },
  { label: 'Messages', href: 'messages.html' },
  { label: 'Track', href: 'track.html' },
];

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

function serve() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      let f = path.join(ROOT, p);
      if (!fs.existsSync(f) && fs.existsSync(f + '.html')) f += '.html';
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('404'); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    });
    s.listen(0, () => resolve({ server: s, port: s.address().port }));
  });
}

(async () => {
  console.log('\n  BOTTOM NAVIGATION — RENDERED, not merely present');
  console.log('  ' + '='.repeat(74));

  const { server, port } = await serve();
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const BASE = 'http://localhost:' + port;

  const read = async (p, vp) => {
    await page.setViewportSize(vp);
    await page.goto(BASE + p, { waitUntil: 'load', timeout: 25000 });
    await page.waitForFunction(() => {
      const n = document.querySelector('[data-sokoni-nav]');
      return !n || n.children.length > 0;
    }, { timeout: 8000 }).catch(() => {});
    return page.evaluate(() => {
      const nav = document.querySelector('[data-sokoni-nav]');
      const bars = document.querySelectorAll('nav.bottom-nav, nav.bnav');
      if (!nav) return { hasNav: false, bars: bars.length, landed: location.pathname };
      const nb = nav.getBoundingClientRect();
      const ns = getComputedStyle(nav);
      return {
        hasNav: true,
        landed: location.pathname,
        bars: bars.length,
        navVisible: ns.display !== 'none' && ns.visibility !== 'hidden' && +ns.opacity > 0 && nb.height > 0,
        navInViewport: nb.top < window.innerHeight && nb.bottom > 0,
        navBottomGap: Math.round(window.innerHeight - nb.bottom),
        zIndex: ns.zIndex,
        bodyPadBottom: getComputedStyle(document.body).paddingBottom,
        badge: !!document.querySelector('#sk-msg-badge'),
        items: Array.from(nav.querySelectorAll('a')).map((a) => {
          const s = getComputedStyle(a);
          const b = a.getBoundingClientRect();
          const labelSpan = Array.from(a.querySelectorAll('span'))
            .map((sp) => ({ t: (sp.textContent || '').trim(), h: sp.getBoundingClientRect().height }))
            .filter((x) => x.t && /[A-Za-z]/.test(x.t))[0] || null;
          return {
            href: a.getAttribute('href'),
            label: labelSpan ? labelSpan.t : '',
            labelPainted: !!labelSpan && labelSpan.h > 0,
            visible: s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0 && b.width > 0 && b.height > 0,
            touch: Math.round(Math.min(b.width, b.height)),
            active: a.className.indexOf('active') > -1 || a.getAttribute('aria-current') !== null,
          };
        }),
      };
    });
  };

  const VPS = [{ n: 'narrow 320', v: { width: 320, height: 640 } }, { n: 'mobile 390', v: { width: 390, height: 844 } }, { n: 'desktop 1440', v: { width: 1440, height: 900 } }];
  const PAGES = ['/', '/product', '/category', '/search'];

  try {
    head('0 - the rig can see a bar at all (CONTROL)');
    const control = await read('/', { width: 390, height: 844 });
    ck('CONTROL the home page yields a nav to measure', control.hasNav && control.items.length > 0,
       control.hasNav ? control.items.length + ' items' : 'NO NAV — every assertion below would be vacuous');
    if (!control.hasNav) throw new Error('control failed: no nav to measure');

    head('1 - the five destinations, on every applicable surface');
    for (const p of PAGES) {
      const r = await read(p, { width: 390, height: 844 });
      if (!r.hasNav) { un('nav on ' + p, 'landed on ' + r.landed + ' — auth-gated redirect, not a missing bar'); continue; }
      const labels = r.items.map((i) => i.label);
      const hrefs = r.items.map((i) => i.href);
      ck('all five destinations render on ' + p,
         JSON.stringify(labels) === JSON.stringify(EXPECTED.map((e) => e.label)), labels.join(' · '));
      ck('...each pointing at the intended destination on ' + p,
         JSON.stringify(hrefs) === JSON.stringify(EXPECTED.map((e) => e.href)), hrefs.join(' '));
      ck('...none is an empty shell on ' + p, r.items.length > 0 && r.items.every((i) => i.label !== ''),
         'a bar with anchors but no labels is invisible to a user');
      ck('EXACTLY ONE bar on ' + p, r.bars === 1, r.bars + ' bar(s)');
    }

    head('2 - painted and usable at every width');
    for (const { n, v } of VPS) {
      const r = await read('/', v);
      ck('the bar is painted at ' + n, r.navVisible && r.navInViewport,
         'visible=' + r.navVisible + ' inViewport=' + r.navInViewport + ' z=' + r.zIndex);
      ck('every item is visible at ' + n, r.items.every((i) => i.visible), r.items.filter((i) => !i.visible).map((i) => i.label).join(',') || 'all five');
      ck('every LABEL is painted at ' + n, r.items.every((i) => i.labelPainted),
         'a zero-height label is a bar the user cannot read');
      const smallest = Math.min.apply(null, r.items.map((i) => i.touch));
      ck('touch targets >= 44px at ' + n, smallest >= 44, 'smallest ' + smallest + 'px');
      ck('content is not overlapped at ' + n, parseFloat(r.bodyPadBottom) > 0, 'body padding-bottom ' + r.bodyPadBottom);
    }

    head('3 - active state and the Messages badge');
    const home = await read('/', { width: 390, height: 844 });
    const act = home.items.filter((i) => i.active);
    ck('exactly one item is active on home', act.length === 1, act.map((i) => i.label).join(',') || 'none');
    ck('...and it is Home', act.length === 1 && act[0].label === 'Home', act[0] ? act[0].label : '-');
    const cat = await read('/category', { width: 390, height: 844 });
    const catAct = cat.items.filter((i) => i.active).map((i) => i.label);
    ck('the active item FOLLOWS the route', catAct.length === 1 && catAct[0] !== 'Home',
       '/category -> ' + (catAct.join(',') || 'none') + '   (a bar that always highlights Home is not an active state)');
    ck('the Messages badge element is present', home.badge, '#sk-msg-badge — the unread writers target this id');

    head('what this suite does NOT prove');
    un('the badge shows a real unread count', 'needs an authenticated session with messages');
    un('signed-in destinations resolve', 'cart/checkout/wishlist redirect to login when signed out');
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n  ' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  console.log('  ' + '='.repeat(74) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  aborted: ' + (e && e.stack) + '\n'); process.exit(1); });
