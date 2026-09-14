#!/usr/bin/env node
/* ============================================================================
   hscroll regression sweep — shared responsive-surface change
   ============================================================================
   sokoni-responsive.css set `overscroll-behavior: contain` (BOTH axes) on a very
   broad selector, [class*="hscroll"], in a rule that sits OUTSIDE every media
   query. A rule living in a "responsive" stylesheet is not necessarily
   responsive-scoped: it applied at desktop and blocked VERTICAL scroll chaining
   wherever an hscroll carousel appeared, so the page stopped scrolling when the
   cursor was over it.

   The fix narrows it to overscroll-behavior-x. Because the selector is broad,
   this is a SHARED-SURFACE change and every page carrying an hscroll class has
   to be swept, not just the page where it was reported.

   Per page, per width:
     x-contained     horizontal overscroll still contained on carousels
     y-chains        vertical overscroll is auto, so the document keeps scrolling
     no-h-scrollbar  the page did not acquire a horizontal scrollbar
     footer-reached  the footer is reachable by scrolling to the bottom
     back-to-top     the page returns to 0

   Smooth scrolling is neutralised for MEASUREMENT ONLY — `scroll-behavior:
   smooth` animates scrollTo and a naive sample reads a mid-flight value, which
   looks exactly like a scroll trap. Content also lazy-loads, so scrollHeight is
   re-read after scrolling rather than trusted from a stale snapshot.

   Usage: node scripts/check-hscroll-chaining.js [--widths 1440,1280,1024]
   Exit:  1 if any page fails.
   ========================================================================= */
'use strict';
const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));

const argv   = process.argv.slice(2);
const arg    = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BASE   = arg('--base', 'http://127.0.0.1:3000');
const WIDTHS = arg('--widths', '1440,1280,1024').split(',').map(Number);

/* Every served page that carries an hscroll class. */
const pages = fs.readdirSync(ROOT)
  .filter(f => f.endsWith('.html') && fs.statSync(path.join(ROOT, f)).isFile())
  .filter(f => /class\s*=\s*["'][^"']*hscroll|hscroll-track|h-scroll-wrap/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')))
  .sort();

if (!pages.length) { console.log('no pages carry an hscroll class'); process.exit(0); }

(async () => {
  const browser = await chromium.launch();
  const rows = [];

  for (const pg of pages) {
    for (const w of WIDTHS) {
      const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
      const page = await ctx.newPage();
      let r = null;
      try {
        await page.goto(`${BASE}/${pg}`, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForTimeout(2600);
        await page.evaluate(() => { const b = document.getElementById('_sokoniPrivacyBanner'); if (b) b.remove(); });
        /* measurement only — never shipped */
        await page.addStyleTag({ content: 'html{scroll-behavior:auto !important}' });
        await page.waitForTimeout(150);

        r = await page.evaluate(async () => {
          const de = document.documentElement;
          const settle = () => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));

          const els = Array.from(document.querySelectorAll('[class*="hscroll"], .h-scroll-wrap, .hscroll-track'));
          let xContained = true, yChains = true;
          const offenders = [];
          els.forEach(el => {
            const cs = getComputedStyle(el);
            if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') {
              if (cs.overscrollBehaviorX !== 'contain') { xContained = false; offenders.push('x:' + (el.className || el.tagName).toString().slice(0, 24)); }
            }
            if (cs.overscrollBehaviorY === 'contain') { yChains = false; offenders.push('y:' + (el.className || el.tagName).toString().slice(0, 24)); }
          });

          const hOverflow = Math.max(de.scrollWidth, document.body.scrollWidth) - de.clientWidth;

          window.scrollTo(0, de.scrollHeight); await settle();
          await new Promise(res => setTimeout(res, 300));
          /* re-read AFTER scrolling: lazy content changes scrollHeight */
          window.scrollTo(0, de.scrollHeight); await settle();
          await new Promise(res => setTimeout(res, 300));
          const f = document.querySelector('footer');
          const fr = f ? f.getBoundingClientRect() : null;
          const footerReached = f ? (fr.top < innerHeight) : null;

          window.scrollTo(0, 0); await settle();
          await new Promise(res => setTimeout(res, 250));
          const backToTop = Math.round(scrollY) <= 2;

          return { xContained, yChains, hOverflow, footerReached, backToTop,
                   carousels: els.length, offenders: offenders.slice(0, 2) };
        });
      } catch (e) { r = { error: String(e.message).slice(0, 44) }; }
      await ctx.close();

      const checks = r.error ? { load: false } : {
        'x-contained':    r.xContained,
        'y-chains':       r.yChains,
        'no-h-scrollbar': r.hOverflow <= 1,
        'footer-reached': r.footerReached !== false,
        'back-to-top':    r.backToTop,
      };
      rows.push({ pg, w, checks, bad: Object.keys(checks).filter(k => !checks[k]), r });
    }
  }
  await browser.close();

  const NAMES = ['x-contained', 'y-chains', 'no-h-scrollbar', 'footer-reached', 'back-to-top'];
  let last = null, failures = 0;
  for (const row of rows) {
    if (row.pg !== last) { console.log('\n── ' + row.pg + '   (' + (row.r.carousels || 0) + ' carousel element(s))'); last = row.pg;
      console.log('   width  ' + NAMES.map(n => n.padEnd(16)).join('')); }
    if (row.bad.length) failures++;
    console.log('   ' + String(row.w).padEnd(6) + ' ' +
      NAMES.map(n => (row.bad.includes(n) ? 'FAIL' : 'ok').padEnd(16)).join('') +
      (row.r.offenders && row.r.offenders.length ? '  ' + row.r.offenders.join(' ') : ''));
  }

  console.log('\n' + (rows.length - failures) + '/' + rows.length + ' page-width combinations passed');
  if (failures) {
    console.log('\nA FAIL on y-chains means a carousel is still blocking vertical scroll chaining.');
    console.log('A FAIL on x-contained means horizontal containment was lost by the narrowing.');
    process.exit(1);
  }
  console.log('Horizontal containment preserved; vertical scrolling chains to the document.');
})();
