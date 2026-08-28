#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   TRACK IS A PAGE YOU CAN LEAVE — EVEN WHEN TRACKING FAILS
   ══════════════════════════════════════════════════════════════════════════════
   Track is a destination in the unified bottom bar, and for one release it was
   the only tab whose page had no bar. Two separate defects produced that, and
   the second is the reason this suite drives a browser instead of reading source:

     1. track.html had NO nav element at all, so the porter correctly skipped it.
     2. After the element was added it rendered UNSTYLED — in normal flow at the
        TOP of the page, 226 px tall on desktop with its items stacked — because
        track.html loads only leaflet.min.css and never style.css, where
        `.bottom-nav{position:fixed;bottom:0}` lives.

   Defect 2 was invisible to every source-level check. The element existed, the
   markup was correct, and the page was still unusable. So:

       A page is not integrated because the nav element EXISTS. It is integrated
       when the bar is rendered, styled, visible, usable, correctly layered, and
       the page remains usable under failure states.

   Track has three failure states and all three are exercised, because a tracking
   page that cannot show a delivery must still be a page you can leave.
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

const EXPECTED = ['Home', 'Shop', 'Services', 'Messages', 'Track'];
const ROUTES = [
  ['/track', 'no code and no order — the bare tab destination'],
  ['/track?code=BADCODE1', 'a tracking code that cannot resolve'],
  ['/track?order=nonexistent-order-id', 'an order id that does not exist'],
];
const VPS = [
  ['narrow 320', { width: 320, height: 640 }],
  ['mobile 390', { width: 390, height: 844 }],
  ['desktop 1440', { width: 1440, height: 900 }],
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
  console.log('\n  TRACK — the bar renders, and survives every failure state');
  console.log('  ' + '='.repeat(72));

  const { server, port } = await serve();
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  const BASE = 'http://localhost:' + port;

  const read = async (route, vp) => {
    await page.setViewportSize(vp);
    await page.goto(BASE + route, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => {
      const n = document.querySelector('[data-sokoni-nav]');
      return !n || n.children.length > 0;
    }, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1200);
    return page.evaluate(() => {
      const nav = document.querySelector('[data-sokoni-nav]');
      const bars = document.querySelectorAll('nav.bottom-nav, nav.bnav');
      const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) }; };
      if (!nav) return { hasNav: false, bars: bars.length };
      const ns = getComputedStyle(nav);
      const load = document.getElementById('loadScreen');
      const panel = document.getElementById('panel');
      const nb = box(nav), lb = box(load), pb = box(panel);
      const ls = load ? getComputedStyle(load) : null;
      return {
        hasNav: true, bars: bars.length,
        position: ns.position,
        painted: ns.display !== 'none' && ns.visibility !== 'hidden' && +ns.opacity > 0 && nb.h > 0,
        navBox: nb,
        /* the bar must be AT THE BOTTOM, not merely present */
        atBottom: Math.abs(nb.bottom - window.innerHeight) <= 2,
        items: Array.from(nav.querySelectorAll('a')).map((a) => {
          const s = getComputedStyle(a); const b = a.getBoundingClientRect();
          const lab = Array.from(a.querySelectorAll('span')).map((sp) => ({ t: (sp.textContent || '').trim(), h: sp.getBoundingClientRect().height })).filter((x) => x.t && /[A-Za-z]/.test(x.t))[0];
          return { label: lab ? lab.t : '', href: a.getAttribute('href'),
                   visible: s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0 && b.height > 0,
                   labelPainted: !!lab && lab.h > 0,
                   touch: Math.round(Math.min(b.width, b.height)),
                   active: a.className.indexOf('active') > -1 || a.getAttribute('aria-current') !== null };
        }),
        panelOverlaps: !!(pb && pb.bottom > nb.top + 1),
        loadOverlaps: !!(lb && ls.display !== 'none' && lb.bottom > nb.top + 1),
        horizScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      };
    });
  };

  try {
    head('0 - CONTROL: the rig can see a bar, and can see it MISPLACED');
    const c = await read('/track', { width: 390, height: 844 });
    ck('CONTROL a nav is present to measure', c.hasNav && c.items.length > 0,
       c.hasNav ? c.items.length + ' items' : 'NO NAV — every assertion below would be vacuous');
    if (!c.hasNav) throw new Error('control failed');
    ck('CONTROL the rig measures POSITION, not just presence',
       typeof c.atBottom === 'boolean' && !!c.navBox,
       'the original defect was a bar that existed at the TOP of the page');

    for (const [vpName, vp] of VPS) {
      head(vpName);
      for (const [route, why] of ROUTES) {
        const r = await read(route, vp);
        const labels = r.items.map((i) => i.label);
        const smallest = r.items.length ? Math.min.apply(null, r.items.map((i) => i.touch)) : 0;
        ck('the five destinations render — ' + route,
           JSON.stringify(labels) === JSON.stringify(EXPECTED), why + ' :: ' + labels.join(' · '));
        ck('the bar is FIXED and AT THE BOTTOM — ' + route,
           r.position === 'fixed' && r.atBottom,
           'position=' + r.position + ' box=' + JSON.stringify(r.navBox) + ' (an unstyled bar renders at the TOP)');
        ck('every item visible with a painted label — ' + route,
           r.items.every((i) => i.visible && i.labelPainted));
        ck('touch targets >= 44px — ' + route, smallest >= 44, 'smallest ' + smallest + 'px');
        ck('exactly ONE bar — ' + route, r.bars === 1, r.bars + ' bar(s)');
        ck('no overlay or panel covers the bar — ' + route,
           !r.panelOverlaps && !r.loadOverlaps,
           'panel=' + r.panelOverlaps + ' loadScreen=' + r.loadOverlaps +
           ' (the bar is z-index 999 on phones but 400 on desktop, and #loadScreen is 500 — ' +
           'clearance must not depend on which wins)');
        ck('no horizontal overflow — ' + route, !r.horizScroll);
        ck('Track is the active tab — ' + route,
           r.items.filter((i) => i.active).map((i) => i.label).join(',') === 'Track',
           'a bar that never highlights the page you are on is not an active state');
      }
    }

    head('what this suite does NOT prove');
    un('a SUCCESSFUL tracking session renders correctly',
       'needs a real order with a live rider; no order or account was manufactured');
    un('the bar behaves during a live map interaction', 'needs a resolvable tracking code');
  } finally {
    await browser.close();
    server.close();
  }

  console.log('\n  ' + '='.repeat(72));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  console.log('  ' + '='.repeat(72) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  aborted: ' + (e && e.stack) + '\n'); process.exit(1); });
