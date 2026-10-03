#!/usr/bin/env node
/**
 * COPIED-IMAGE PLACEHOLDERS — browser certification (QUEUED; not yet run).
 *
 *   node scripts/test-copied-image-placeholders-browser.js
 *
 * Companion to the static suite scripts/test-copied-image-placeholders.js.
 * While moderation holds a product its photo token is withdrawn, so an image
 * URL COPIED into an order / cart / POS display returns 404. This drives the
 * real pages with such a URL and asserts:
 *   - the <img> ends up on assets/default-product.png, loaded (naturalWidth > 0)
 *   - it is visible (not display:none) — no broken-image icon, no hidden gap
 *   - no extra text is rendered next to it
 *   - invoice.html: a crafted image value creates no attribute / runs nothing
 *
 * Pages exercised: invoice.html (order from localStorage sokoniOrders),
 * customer-display.html (POS cart via postMessage). checkout.html and cart.js
 * are covered statically; their bootstrap needs the cart service + auth.
 *
 * Isolation: a local static server; every non-localhost request is aborted
 * (no Firebase, no production). auth-guard.js is served empty so the invoice
 * renders without a session — this certifies the renderer, not the guard.
 *
 * Verdict: exit 0 only on all PASS. A browser that cannot launch is ENV,
 * exit 2 — BLOCKED is not PASS.
 */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html',
                '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const PLACEHOLDER = 'assets/default-product.png';
const HELD = '/held-media/product-photo.jpg'; // always 404 on the local server

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d !== undefined ? '   [' + String(d).slice(0, 120) + ']' : ''));
  ok ? pass++ : fail++;
};
const bounded = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => setTimeout(r, ms))]);

async function imgState(page, selector) {
  await page.waitForFunction((sel) => {
    const i = document.querySelector(sel);
    return !!(i && i.complete && /default-product\.png$/.test(i.src) && i.naturalWidth > 0);
  }, selector, { timeout: 10000 }).catch(() => {}); // on timeout, the asserts below report the real state
  await page.waitForTimeout(500);
  return page.evaluate((sel) => {
    const i = document.querySelector(sel);
    if (!i) return null;
    const cs = getComputedStyle(i);
    return { src: i.src, attr: i.getAttribute('src'), complete: i.complete, nw: i.naturalWidth,
             display: cs.display, visibility: cs.visibility, pwn: !!window.__pwn,
             attrs: i.getAttributeNames() };
  }, selector);
}

(async () => {
  let pw;
  try { pw = require('playwright'); }
  catch (_) { console.log('\n  ENV  playwright is not installed\n\n  0 passed, 0 failed, 1 env'); process.exit(2); }

  const server = http.createServer((rq, rs) => {
    let name = decodeURIComponent((rq.url.split('?')[0] || '/').replace(/^\//, '')) || 'index.html';
    if (name === 'auth-guard.js') { rs.writeHead(200, { 'Content-Type': TYPES['.js'] }); return rs.end('/* stubbed */'); }
    if (!path.extname(name)) name += '.html';
    const abs = path.join(ROOT, name);
    if (!abs.startsWith(ROOT)) { rs.writeHead(403); return rs.end(); }
    fs.readFile(abs, (e, d) => {
      if (e) { rs.writeHead(404); return rs.end('nf'); }
      rs.writeHead(200, { 'Content-Type': TYPES[path.extname(name)] || 'text/plain' });
      rs.end(d);
    });
  });
  await new Promise((r) => server.listen(0, r));
  const base = 'http://localhost:' + server.address().port;

  let br;
  try { br = await pw.chromium.launch(); }
  catch (e) {
    console.log('\n  ENV  browser could not launch: ' + String(e && e.message || e).slice(0, 80));
    server.close(); console.log('\n  0 passed, 0 failed, 1 env'); process.exit(2);
  }

  try {
    for (const vp of [{ name: 'mobile', width: 390, height: 844 }, { name: 'desktop', width: 1280, height: 900 }]) {
      const ctx = await br.newContext({ viewport: { width: vp.width, height: vp.height } });
      await ctx.route('**/*', (route) => {
        const u = route.request().url();
        return u.startsWith(base) ? route.continue() : route.abort();
      });

      /* ── invoice.html ─────────────────────────────────────── */
      console.log(`\n[${vp.name}] invoice.html`);
      const orders = [
        { id: 'ORD-HELD', date: '3 Oct 2026', total: 1200, status: 'delivered', method: 'mpesa',
          items: [{ name: 'Held Item', category: 'fashion', price: 1200, image: base + HELD }] },
        { id: 'ORD-XSS', date: '3 Oct 2026', total: 10, status: 'placed',
          items: [{ name: 'X', price: 10, image: 'https://e.invalid/a.png" onerror="window.__pwn=1' }] },
      ];
      const page = await ctx.newPage();
      await page.addInitScript((o) => { try { localStorage.setItem('sokoniOrders', JSON.stringify(o)); } catch (_) {} }, orders);
      await page.goto(base + '/invoice.html', { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => window.generateInvoice && window.generateInvoice('ORD-HELD'));
      const s1 = await imgState(page, '#invItemsBody img.inv-item-img');
      ck('held image swapped to placeholder', s1 && s1.src.endsWith(PLACEHOLDER), s1 && s1.src);
      ck('placeholder actually loaded (not a broken icon)', s1 && s1.complete && s1.nw > 0, s1 && s1.nw);
      ck('image stays visible', s1 && s1.display !== 'none' && s1.visibility !== 'hidden', s1 && s1.display);
      const cellText = await page.evaluate(() => {
        const td = document.querySelector('#invItemsBody img.inv-item-img').parentElement;
        return td.textContent.replace(/\s+/g, ' ').trim();
      });
      ck('no text added beside the image', cellText === 'Held Item', cellText);

      await page.evaluate(() => window.generateInvoice && window.generateInvoice('ORD-XSS'));
      const s2 = await imgState(page, '#invItemsBody img.inv-item-img');
      ck('crafted image value creates no attribute', s2 && s2.attrs.filter((a) => a === 'onerror').length === 1 &&
         s2.attrs.length === 4, s2 && s2.attrs.join(','));
      ck('crafted image value runs nothing', s2 && !s2.pwn);
      ck('crafted image falls back to placeholder', s2 && s2.src.endsWith(PLACEHOLDER), s2 && s2.src);
      await page.close();

      /* ── customer-display.html (POS) ─────────────────────── */
      console.log(`\n[${vp.name}] customer-display.html`);
      const cd = await ctx.newPage();
      await cd.goto(base + '/customer-display.html?session=cert', { waitUntil: 'domcontentloaded' });
      await cd.evaluate((img) => window.postMessage({ type: 'cart_update', sessionId: 'cert',
        cart: [{ name: 'Held Item', qty: 1, price: 500, total: 500, image: img }] }, '*'), base + HELD);
      const s3 = await imgState(cd, '#cart-items-list .cd-item-img img');
      ck('held image swapped to placeholder', s3 && s3.src.endsWith(PLACEHOLDER), s3 && s3.src);
      ck('placeholder actually loaded', s3 && s3.complete && s3.nw > 0, s3 && s3.nw);
      ck('image stays visible (was display:none before)', s3 && s3.display !== 'none', s3 && s3.display);
      const cdText = await cd.evaluate(() => document.querySelector('#cart-items-list .cd-item-img').textContent.trim());
      ck('no text in the image slot', cdText === '', cdText);
      await cd.close();
      await bounded(ctx.close(), 5000);
    }
  } catch (e) {
    ck('suite ran to completion', false, e && e.message);
  } finally {
    await bounded(br.close(), 5000);
    server.close();
  }
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
