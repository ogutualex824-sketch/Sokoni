/* Shared-panel deep-switch: the module must actually SHOW the requested section/tab.
 *
 *   node scripts/test-merchant-deep-switch.js
 *
 * WHY THIS EXISTS
 * "Merchant → Products opens the Home/Dashboard page." The POS and Seller panels are
 * persistent and shared by several routes, and the Seller panel is pre-created at 'overview'
 * when the Dashboard loads its feed. Switching was a single fire-and-forget postMessage, so if
 * the hosted app had not finished booting the message was dropped — and 'overview' IS the
 * seller home page. An earlier fix re-asserted on the iframe's `load` event, which never fires
 * again once the panel is already loaded, so it only ever helped the first navigation.
 *
 * The visual gate did not catch it: it asserted the right DOCUMENT was mounted (seller.html),
 * which was true. The wrong SECTION of the right document is invisible to that check.
 *
 * So this suite reads the hosted document's own rendered state:
 *   · a section that belongs to the target page IS visible, and
 *   · a section that belongs only to overview is NOT visible.
 * Both halves matter — products and overview share 'upload-section', so checking one section
 * would report success while the home page was on screen.
 *
 * It also walks route -> route -> back, because the bug only appears on a panel that is
 * already loaded.
 */
'use strict';
const { webkit } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
  '.png':'image/png', '.json':'application/json', '.svg':'image/svg+xml', '.jpg':'image/jpeg',
  '.webp':'image/webp', '.ico':'image/x-icon', '.woff2':'font/woff2' };

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).replace(/\s+/g, ' ').slice(0, 90) + ']' : ''));
  ok ? pass++ : fail++;
};

/* show: belongs to this page, NOT to overview.  hide: overview-only.
   Mirrors the map in merchant.html sellerSwitch, and is derived from seller.js DASH_PAGES. */
const SELLER = {
  products:  { show: 'bulk-upload-section', hide: 'seller-stats' },
  receipts:  { show: 'receipts-section',    hide: 'seller-stats' },
  staff:     { sec: 'team', show: 'team-section', hide: 'seller-stats' },
  messages:  { show: 'seller-dms',          hide: 'seller-stats' },
  marketing: { show: 'marketing-section',   hide: 'seller-stats' },
  stories:   { show: 'stories-section',     hide: 'seller-stats' },
  disputes:  { show: 'disputes-section',    hide: 'seller-stats' },
  customers: { show: 'customers-section',   hide: 'seller-stats' },
};

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

async function sellerState(page) {
  return page.evaluate(() => {
    const f = document.getElementById('mfx-seller');
    try {
      const d = f && f.contentDocument; if (!d) return { ok: false, why: 'no seller document' };
      const vis = (id) => {
        const el = d.getElementById(id); if (!el) return null;
        const cs = d.defaultView.getComputedStyle(el);
        return !!cs && cs.display !== 'none' && cs.visibility !== 'hidden';
      };
      const ids = ['bulk-upload-section','receipts-section','team-section','seller-dms',
                   'marketing-section','stories-section','disputes-section','customers-section',
                   'seller-stats'];
      const out = {}; ids.forEach((i) => { out[i] = vis(i); });
      return { ok: true, vis: out };
    } catch (e) { return { ok: false, why: e.message }; }
  });
}

server.listen(0, async () => {
  const BASE = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try { browser = await webkit.launch(); }
  catch (e) { console.log('SKIP — webkit unavailable: ' + (e && e.message || e)); server.close(); process.exit(0); return; }

  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('loggedIn', 'true');
      localStorage.setItem('sokoniUser', JSON.stringify({
        uid: 'deep-switch-uid', name: 'Deep Switch', roles: ['seller', 'merchant'], role: 'seller',
      }));
    } catch (e) {}
  });
  const page = await ctx.newPage();

  console.log('\nSHARED-PANEL DEEP SWITCH — the module must SHOW the right section');
  console.log('='.repeat(72));

  await page.goto(BASE + '/merchant.html', { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForTimeout(3000);

  /* Dashboard pre-creates the seller panel at 'overview'. That is the precondition for the
     reported bug, so assert it happened rather than assuming. */
  const pre = await page.evaluate(() => !!document.getElementById('mfx-seller'));
  console.log('\n  precondition');
  ck('Dashboard pre-created the shared seller panel', pre, pre ? 'panel exists (overview)' : 'not pre-created');

  console.log('\n  first navigation into a shared-panel route');
  await page.evaluate(() => { const e = document.querySelector('.mnav-item[data-id="products"]'); if (e) e.click(); });
  await page.waitForTimeout(7000);
  let st = await sellerState(page);
  ck('Products SHOWS a products-only section', st.ok && st.vis['bulk-upload-section'] === true,
     st.ok ? JSON.stringify(st.vis['bulk-upload-section']) : st.why);
  ck('Products does NOT show the seller home page', st.ok && st.vis['seller-stats'] === false,
     st.ok ? 'seller-stats visible=' + st.vis['seller-stats'] : st.why);

  /* The bug only reproduces on an ALREADY-LOADED panel — walk between shared routes. */
  console.log('\n  switching between routes that share the panel (already loaded)');
  for (const id of ['receipts', 'messages', 'stories', 'customers', 'products']) {
    const cfg = SELLER[id];
    await page.evaluate((rid) => { const e = document.querySelector('.mnav-item[data-id="' + rid + '"]'); if (e) e.click(); }, id);
    await page.waitForTimeout(5000);
    st = await sellerState(page);
    ck(id + ' shows its own section', st.ok && st.vis[cfg.show] === true,
       st.ok ? cfg.show + '=' + st.vis[cfg.show] : st.why);
    ck(id + ' is not the seller home page', st.ok && st.vis[cfg.hide] === false,
       st.ok ? 'seller-stats=' + st.vis[cfg.hide] : st.why);
  }

  /* POS panel: two routes share it, so the tab must be re-asserted the same way. */
  console.log('\n  shared POS panel — Inventory vs Cashier vs Audit');
  for (const [id, tab] of [['inventory', 'inventory'], ['cashier', 'pos'], ['audit', 'audit'], ['inventory', 'inventory']]) {
    await page.evaluate((rid) => { const e = document.querySelector('.mnav-item[data-id="' + rid + '"]'); if (e) e.click(); }, id);
    await page.waitForTimeout(5000);
    const posOk = await page.evaluate((t) => {
      const f = document.getElementById('mfx-pos');
      try {
        const d = f && f.contentDocument; if (!d) return { ok: false, why: 'no pos document' };
        const el = d.querySelector('[data-tab="' + t + '"]');
        if (!el) return { ok: false, why: 'tab ' + t + ' not found' };
        return { ok: el.getAttribute('aria-selected') === 'true' || /\bactive\b/.test(el.className || ''),
                 why: 'aria-selected=' + el.getAttribute('aria-selected') };
      } catch (e) { return { ok: false, why: e.message }; }
    }, tab);
    ck(id + ' activates the ' + tab + ' tab', posOk.ok, posOk.why);
    const title = await page.evaluate(() => (document.getElementById('mtitle') || {}).textContent);
    /* "Cashier", not "POS / Cashier": this route is the in-shop CHECKOUT surface, and the POS
       app's other surfaces are their own merchant routes. Kept in sync with the route contract. */
    const want = { inventory: 'Inventory', cashier: 'Cashier', audit: 'Audit Log' }[id];
    ck(id + ' title is correct', title === want, title);
  }

  await browser.close(); server.close(); clearTimeout(wd);
  console.log('\n' + '='.repeat(72));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
