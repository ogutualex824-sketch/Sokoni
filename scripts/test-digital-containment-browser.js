#!/usr/bin/env node
/**
 * Digital & eSOKO containment (DE-1, owner 2026-10-03) — browser certification. QUEUED: written with the slice,
 * NOT yet run (RAM floor; no Playwright in the build session).
 *
 * At 390x844 (phone) and 1280x800 (desktop), on the real pages from this tree:
 *   DB1 digital-esoko.html shows "Digital downloads are paused." and links Phones, laptops & electronics
 *       (category.html?cat=electronics) and category.html?cat=computers; no Buy / Pay / Download control
 *   DB2 digital-esoko-seller.html: no publish form, no earnings / commission figure; "Apply to sell on SOKONI"
 *       opens the ONE intake (HubRegister overlay #sokoniRegOverlay.open)
 *   DB3 digital.html shows "Freelance gigs are moving to SOKONI Jobs." with a link to jobs.html; no order / accept /
 *       withdraw / wallet control; does NOT redirect to tech-hub
 *   DB4 digital-store.html lands on category.html?cat=electronics
 *   DB5 home (index.html) has no link to digital-esoko(-seller).html; the device card points at ?cat=electronics
 *   DB6 no wa.me link, nothing opened, no horizontal page scroll, no uncaught error from the pages' own scripts
 *
 * Real pages over a local static server; ALL external network (Firebase, gstatic, IntaSend) is aborted, so nothing
 * reaches production.   node scripts/test-digital-containment-browser.js
 */
'use strict';
const path = require('path'), http = require('http'), fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
const pw = require(path.join(ROOT, 'node_modules', 'playwright'));
const say = console.log;
let pass = 0, fail = 0;
const ck = (l, ok, d) => { say('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined && d !== '' ? '   [' + String(typeof d === 'object' ? JSON.stringify(d) : d).slice(0, 400) + ']' : '')); ok ? pass++ : fail++; };
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]); const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
const MONEY_LABEL = /Buy Now|Pay\b|M-Pesa|STK|Download Now|Publish|Withdraw|Accept Proposal|Order Gig|Hire/i;
const OWN_ERR = (e) => !/firebase|gstatic|Failed to fetch|import|NetworkError|net::/i.test(e);

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const browser = await pw.chromium.launch();
  try {
    for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
      say('\n  viewport ' + vp.width + 'x' + vp.height);
      const ctx = await browser.newContext({ viewport: vp, serviceWorkers: 'block' });
      await ctx.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort()));
      await ctx.addInitScript(() => { window.__opened = []; window.open = function (u) { window.__opened.push(String(u)); return null; }; });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const visit = async (f) => {
        await page.goto(BASE + '/' + f, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(600);
        return page.evaluate(() => {
          const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
          return { url: location.pathname + location.search, text: document.body.innerText, labels: [...document.querySelectorAll('button,a')].filter(vis).map((b) => b.textContent.trim()),
            hrefs: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')), wa: document.querySelectorAll('a[href*="wa.me"]').length,
            sx: document.documentElement.scrollWidth > window.innerWidth + 1, opened: window.__opened || [] };
        });
      };
      const sx = [], wa = [];
      const e = await visit('digital-esoko.html'); sx.push(e.sx && 'esoko'); wa.push(e.wa);
      ck('DB1 eSOKO: downloads paused + device links, no money control',
        /Digital downloads are paused\./.test(e.text) && e.hrefs.includes('category.html?cat=electronics') && e.hrefs.includes('category.html?cat=computers') && !e.labels.some((l) => MONEY_LABEL.test(l)), e.labels);
      const s = await visit('digital-esoko-seller.html'); sx.push(s.sx && 'seller'); wa.push(s.wa);
      const sellerClean = !/Net Earnings|Commission|Publish/i.test(s.text);
      await page.waitForFunction(() => window.HubRegister && typeof window.HubRegister.open === 'function', null, { timeout: 5000 }).catch(() => {});
      await page.click('button:has-text("Apply to sell on SOKONI")');
      await page.waitForTimeout(400);
      const reg = await page.evaluate(() => { const o = document.getElementById('sokoniRegOverlay'); return { exists: !!o, open: !!o && o.classList.contains('open') }; });
      ck('DB2 seller page: no publish / figures; "Apply to sell" opens the ONE intake', sellerClean && reg.exists && reg.open, { sellerClean, reg });
      const d = await visit('digital.html'); sx.push(d.sx && 'gigs'); wa.push(d.wa);
      ck('DB3 digital.html: gigs moving to Jobs, jobs.html link, no money control, no tech-hub redirect',
        /Freelance gigs are moving to SOKONI Jobs\./.test(d.text) && d.hrefs.includes('jobs.html') && !/tech-hub/.test(d.url) && !d.labels.some((l) => MONEY_LABEL.test(l)), { url: d.url, labels: d.labels });
      const st = await visit('digital-store.html');
      ck('DB4 digital-store.html lands on the device marketplace', /category\.html\?cat=electronics/.test(st.url), st.url);
      const h = await visit('index.html'); sx.push(h.sx && 'home');
      ck('DB5 home: no store / seller-dashboard link; device card points at ?cat=electronics',
        !h.hrefs.some((x) => /digital-esoko/.test(x || '')) && h.hrefs.includes('category.html?cat=electronics'), h.hrefs.filter((x) => /digital|electronics|computers/.test(x || '')));
      const opened = [e, s, d, h].flatMap((x) => x.opened);
      ck('DB6 no wa.me, nothing opened, no horizontal scroll, no own-script error', wa.every((n) => n === 0) && opened.length === 0 && sx.filter(Boolean).length === 0 && errors.filter(OWN_ERR).length === 0,
        { wa, opened, sx: sx.filter(Boolean), errors: errors.filter(OWN_ERR) });
      await ctx.close();
    }
  } finally { await browser.close(); server.close(); }
  say('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (not a pass):', e && e.stack || e); process.exit(2); });
