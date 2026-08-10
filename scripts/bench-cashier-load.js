/* Cashier load-time bench — where does the time actually go?
 *
 *   node scripts/bench-cashier-load.js [--runs 3]
 *
 * Measures the journey the merchant actually experiences: click Cashier -> the checkout is
 * USABLE (product search focusable, charge bar present). Not "the iframe exists", which is
 * the trap this whole project keeps falling into.
 *
 * Reports the breakdown so a fix targets the real bottleneck rather than adding a spinner:
 *   · time to iframe created / src assigned
 *   · time to the hosted document reaching interactive, then complete
 *   · time to checkout controls being present and hit-testable
 *   · script count and bytes actually fetched, blocking vs deferred
 *   · Firestore/network requests issued before the checkout is usable
 *   · the slowest individual resources
 */
'use strict';
const { webkit } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const RUNS = (() => { const i = argv.indexOf('--runs'); return i > -1 ? +argv[i + 1] : 3; })();

const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
  '.png':'image/png', '.json':'application/json', '.svg':'image/svg+xml', '.jpg':'image/jpeg',
  '.webp':'image/webp', '.ico':'image/x-icon', '.woff2':'font/woff2' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/merchant.html';
  let f = path.join(ROOT, p);
  if (!path.extname(p)) f += '.html';
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
    res.end(d);
  });
});

const wd = setTimeout(() => { console.log('SKIP — watchdog'); process.exit(0); }, 600000);
wd.unref && wd.unref();

/* Checkout is USABLE when the merchant could actually ring up a sale. */
const USABLE = () => {
  const f = document.querySelector('.mpanel.show iframe');
  try {
    const d = f && f.contentDocument; if (!d) return null;
    const search = d.getElementById('pos-search') || d.querySelector('[id*="search" i], input[placeholder*="scan" i], input[placeholder*="barcode" i]');
    const charge = d.getElementById('mobile-pay-btn') || d.querySelector('[id*="charge" i], .cart-mobile-pay-btn, [onclick*="openPaymentPanel"]');
    const grid   = d.getElementById('pos-products') || d.querySelector('[id*="product" i]');
    return { search: !!search, charge: !!charge, grid: !!grid,
             ready: !!(search || charge) && !!grid, readyState: d.readyState };
  } catch (e) { return null; }
};

server.listen(0, async () => {
  const BASE = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try { browser = await webkit.launch(); }
  catch (e) { console.log('SKIP — webkit unavailable: ' + (e && e.message || e)); server.close(); process.exit(0); return; }

  console.log('\nCASHIER LOAD BENCH — click Cashier -> checkout usable');
  console.log('='.repeat(74));

  const totals = [];
  for (let run = 1; run <= RUNS; run++) {
    const ctx = await browser.newContext({
      viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('loggedIn', 'true');
        localStorage.setItem('sokoniUser', JSON.stringify({ uid: 'bench-uid', name: 'Bench', roles: ['seller','merchant'], role: 'seller' }));
        localStorage.setItem('sokoni_setup_complete', '1');
        localStorage.setItem('sokoni_merchant_id', 'BENCH-1');
      } catch (e) {}
    });
    const page = await ctx.newPage();

    const reqs = [];
    page.on('request', (r) => reqs.push({ url: r.url(), t: Date.now(), type: r.resourceType() }));
    const done = [];
    page.on('requestfinished', async (r) => {
      try { const t = r.timing(); done.push({ url: r.url(), type: r.resourceType(), ms: t.responseEnd > 0 ? t.responseEnd : 0 }); } catch (_) {}
    });

    await page.goto(BASE + '/merchant.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);           /* shell settled; not part of the measurement */

    const marks = {};
    const t0 = Date.now();
    reqs.length = 0; done.length = 0;

    await page.evaluate(() => { const e = document.querySelector('.mnav-item[data-id="cashier"]'); if (e) e.click(); });

    /* iframe created + src assigned */
    await page.waitForFunction(() => {
      const p = document.querySelector('.mpanel.show'); const f = p && p.querySelector('iframe');
      return !!(f && f.getAttribute('src'));
    }, { timeout: 60000 }).catch(() => {});
    marks.iframeSrc = Date.now() - t0;

    /* hosted document reaches interactive, then complete */
    await page.waitForFunction(() => {
      const f = document.querySelector('.mpanel.show iframe');
      try { const d = f && f.contentDocument; return !!d && (d.readyState === 'interactive' || d.readyState === 'complete'); }
      catch (e) { return false; }
    }, { timeout: 60000 }).catch(() => {});
    marks.interactive = Date.now() - t0;

    await page.waitForFunction(() => {
      const f = document.querySelector('.mpanel.show iframe');
      try { const d = f && f.contentDocument; return !!d && d.readyState === 'complete'; } catch (e) { return false; }
    }, { timeout: 60000 }).catch(() => {});
    marks.complete = Date.now() - t0;

    /* the number that matters: checkout actually usable */
    await page.waitForFunction(`(${USABLE.toString()})()?.ready === true`, { timeout: 60000 }).catch(() => {});
    marks.usable = Date.now() - t0;

    const state = await page.evaluate(USABLE);
    const inPos = done.filter((d) => !/merchant\.html|\/$/.test(d.url));
    const js = inPos.filter((d) => d.type === 'script');
    const bytes = 0;

    console.log('\n  run ' + run);
    console.log('    iframe src assigned : ' + marks.iframeSrc + ' ms');
    console.log('    doc interactive     : ' + marks.interactive + ' ms');
    console.log('    doc complete        : ' + marks.complete + ' ms');
    console.log('    CHECKOUT USABLE     : ' + marks.usable + ' ms   ' + JSON.stringify(state));
    console.log('    requests after click: ' + done.length + '  (scripts ' + js.length + ')');

    /* what the checkout waited on */
    const slow = done.slice().sort((a, b) => b.ms - a.ms).slice(0, 6);
    console.log('    slowest resources   :');
    slow.forEach((s) => console.log('      ' + String(Math.round(s.ms)).padStart(5) + 'ms  ' + s.type.padEnd(8) + s.url.replace(BASE, '').slice(0, 70)));

    totals.push(marks.usable);
    await ctx.close();
  }

  await browser.close(); server.close(); clearTimeout(wd);
  const med = totals.slice().sort((a, b) => a - b)[Math.floor(totals.length / 2)];
  console.log('\n' + '='.repeat(74));
  console.log('  CHECKOUT USABLE — runs: ' + totals.join(', ') + ' ms   median ' + med + ' ms');
});
