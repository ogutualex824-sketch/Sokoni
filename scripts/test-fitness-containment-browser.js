#!/usr/bin/env node
/**
 * Fitness Hub containment (F0, owner 2026-10-03) — browser certification. QUEUED: written with the slice, NOT yet run.
 *
 * At 390x844 (phone) and 1280x800 (desktop), on the real fitness-hub.html from this tree:
 *   FB1 no payment / booking control is shown in any panel (no Book Class, Day Pass, Confirm Booking, Book Session,
 *       Book Consultation, Membership, Join Club, Register-for-event, "Pay" button)
 *   FB2 no wa.me / WhatsApp link or button anywhere, and nothing tries to open one
 *   FB3 each listing panel (Gyms, Coaches, Classes, Nutrition) shows the honest empty state
 *       "Listings appear here once approved providers publish them"; Book shows "Online booking for fitness is coming"
 *   FB4 the "Register My Gym / Studio" CTA opens the ONE intake (HubRegister overlay #sokoniRegOverlay.open)
 *   FB5 Community / Workouts / Ask Hub panels link to community.html; Equipment links to category.html?cat=sports
 *   FB6 no horizontal page scroll at either width; no uncaught page error from the page's own scripts
 *
 * Real pages over a local static server; ALL external network (Firebase, gstatic, IntaSend) is aborted, so nothing
 * reaches production.   node scripts/test-fitness-containment-browser.js
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
const PANELS = ['gyms', 'coaches', 'workouts', 'equipment', 'classes', 'bookings', 'nutrition', 'community', 'progress', 'manage', 'askhub'];
const PAY_LABEL = /Book Class|Day Pass|Confirm Booking|Book Session|Book Consultation|Membership|Join Club|Join Challenge|📝 Register|Pay\b|M-Pesa|STK/i;

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const browser = await pw.chromium.launch();
  try {
    for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
      say('\n  viewport ' + vp.width + 'x' + vp.height);
      const ctx = await browser.newContext({ viewport: vp, serviceWorkers: 'block' });
      const external = [];
      await ctx.route('**/*', (r) => { const u = r.request().url(); if (u.startsWith(BASE)) return r.continue(); external.push(u); return r.abort(); });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.addInitScript(() => { window.__opened = []; const o = window.open; window.open = function (u) { window.__opened.push(String(u)); return null; }; void o; });
      await page.goto(BASE + '/fitness-hub.html', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(800);

      const sweep = [];
      for (const p of PANELS) {
        const r = await page.evaluate((name) => {
          window.showFhPanel(name, null);
          const panel = document.getElementById('fhpanel-' + name);
          const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
          const labels = [...panel.querySelectorAll('button,a')].filter(vis).map((b) => b.textContent.trim());
          return { name, labels, text: panel.innerText, html: panel.innerHTML, sx: document.documentElement.scrollWidth > window.innerWidth + 1 };
        }, p);
        sweep.push(r);
      }
      const payBtns = sweep.flatMap((r) => r.labels.filter((l) => PAY_LABEL.test(l)).map((l) => r.name + ':' + l));
      ck('FB1 no payment / booking control in any panel', payBtns.length === 0, payBtns);
      const wa = await page.evaluate(() => ({ links: [...document.querySelectorAll('a[href*="wa.me"],a[href*="whatsapp"]')].length, opened: window.__opened.filter((u) => /wa\.me|whatsapp/i.test(u)) }));
      const waText = sweep.filter((r) => /WhatsApp/i.test(r.text)).map((r) => r.name);
      ck('FB2 no wa.me / WhatsApp link, button or hand-off', wa.links === 0 && wa.opened.length === 0 && waText.length === 0, { wa, waText });
      const byName = Object.fromEntries(sweep.map((r) => [r.name, r]));
      const emptyMissing = ['gyms', 'coaches', 'classes', 'nutrition'].filter((n) => !/Listings appear here once approved providers publish them/.test(byName[n].text));
      ck('FB3 honest empty state on Gyms / Coaches / Classes / Nutrition; Book says online booking is coming',
        emptyMissing.length === 0 && /Online booking for fitness is coming/.test(byName.bookings.text), { emptyMissing });
      const linksOk = ['community', 'workouts', 'askhub'].every((n) => /href="community\.html"/.test(byName[n].html)) && /href="category\.html\?cat=sports"/.test(byName.equipment.html);
      ck('FB5 Community / Workouts / Ask Hub link to community.html; Equipment links to category.html?cat=sports', linksOk);
      const sx = sweep.filter((r) => r.sx).map((r) => r.name);
      ck('FB6 no horizontal page scroll; no uncaught error from the page', sx.length === 0 && errors.filter((e) => !/firebase|gstatic|Failed to fetch|import/i.test(e)).length === 0, { sx, errors });

      await page.evaluate(() => window.showFhPanel('gyms', null));
      await page.waitForFunction(() => window.HubRegister && typeof window.HubRegister.open === 'function', null, { timeout: 5000 }).catch(() => {});
      await page.click('#fhpanel-gyms button:has-text("Register My Gym / Studio")');
      await page.waitForTimeout(400);
      const reg = await page.evaluate(() => { const o = document.getElementById('sokoniRegOverlay'); return { exists: !!o, open: !!o && o.classList.contains('open') }; });
      ck('FB4 "Register My Gym / Studio" opens the ONE intake (HubRegister overlay)', reg.exists && reg.open, reg);
      await ctx.close();
    }
  } finally { await browser.close(); server.close(); }
  say('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (not a pass):', e && e.stack || e); process.exit(2); });
